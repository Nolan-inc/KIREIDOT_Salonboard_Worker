/**
 * 冪等性マーカー再スキャン (設計 §6.1 — 二重登録防止の中核モジュール)
 * ============================================================
 *
 * 背景 (worker.ts:1353-1362 の制約):
 *   - 「KIREIDOT予約ID: {booking_id}」マーカーは登録時に備考 (textarea#rsvEtc) へ
 *     書き込めるが、予約一覧 (reserveList) には備考列が無く、一覧からは読めない。
 *   - スケジュール画面の重なり判定はスタッフ列に静的に帰属できず、確証が持てない。
 *
 * 本モジュールの方式 (A+B ハイブリッド):
 *   方式B (事前フィルタ): 予約一覧の行から顧客名で候補を絞り込み、優先順を付ける。
 *   方式A (確定判定):     候補の予約詳細ページ (extReserveDetail?reserveId=YG…) を
 *                          1 件ずつ開き、ページ全文にマーカー文字列が含まれるかで判定。
 *                          詳細ページの備考セレクタに依存しない (DOM 変更に強い)。
 *
 * 利用者:
 *   - test-rescan.ts      … 実 DOM 検証スパイク CLI (Phase 0.5)
 *   - worker.ts preflight … 層またぎ再試行前の必須プリフライト (Phase 1 で組込)
 *
 * ⚠️ このモジュールは読み取り専用。クリック/入力/登録は一切行わない。
 */

import type { Page } from "playwright";
import { RESERVE_LIST, RESERVE_ID_RE, SB_PATHS } from "./salonboard-selectors";

/** worker.ts の kireidotRef 既定値と同一形式のマーカー文字列。 */
export function markerFor(bookingId: string): string {
  return `KIREIDOT予約ID: ${bookingId}`;
}

export interface RescanTarget {
  /** KIREIDOT 側 booking_id (マーカー照合キー)。 */
  bookingId: string;
  /** 方式B 事前フィルタ用 (任意)。一覧の顧客名と空白無視で部分一致。 */
  customerName?: string;
}

export interface RescanCandidate {
  reserveId: string;
  href: string;
  customerName: string | null;
  /** customerName が target と一致した候補 (優先して詳細を開く)。 */
  prioritized: boolean;
}

export interface RescanResult {
  /** マーカーが見つかったか。true なら既登録 = already_exists 扱いにできる。 */
  found: boolean;
  /** 見つかった場合の SalonBoard reserveId (YG…)。 */
  externalId: string | null;
  /** 一覧から収集した候補数。 */
  candidates: number;
  /** 実際に詳細ページを開いて確認した数。 */
  scanned: number;
  /**
   * 全候補を確認しきったか。false (= maxDetailPages 打ち切り) の場合、
   * 「見つからなかった」は確定ではないため、呼び出し側は manual_required に倒すこと。
   */
  exhaustive: boolean;
  /** スパイク/デバッグ用の観察ログ。 */
  notes: string[];
}

export interface RescanOptions {
  /** 詳細ページを開く上限 (N+1 遷移の抑制)。既定 30。 */
  maxDetailPages?: number;
  /** 詳細ページ 1 件あたりのタイムアウト ms。既定 15000。 */
  detailTimeoutMs?: number;
  /**
   * 予約一覧の URL 上書き (スパイクで日付絞り込みクエリを試すため)。
   * 省略時は SB_PATHS.reserveListInit。
   */
  listUrl?: string;
  /** 進捗ログ関数 (CLI 用)。 */
  onProgress?: (msg: string) => void;
}

const normalizeName = (s: string | null | undefined) =>
  (s ?? "").replace(/[\s　]/g, "");

/** 現在表示中の予約一覧ページから詳細リンク候補を収集する (reserveId で重複排除)。 */
export async function collectReserveDetailLinks(
  page: Page,
  target?: RescanTarget,
): Promise<RescanCandidate[]> {
  const out = new Map<string, RescanCandidate>();
  const rows = page.locator(RESERVE_LIST.row.selector);
  const n = await rows.count().catch(() => 0);
  const wantName = normalizeName(target?.customerName);

  for (let i = 0; i < n; i++) {
    const row = rows.nth(i);
    const href = await row
      .locator(RESERVE_LIST.detailLink.selector)
      .first()
      .getAttribute("href")
      .catch(() => null);
    if (!href) continue;
    const m = href.match(RESERVE_ID_RE);
    if (!m) continue;
    const reserveId = m[1];
    if (out.has(reserveId)) continue;

    const customerName = await row
      .locator(RESERVE_LIST.customerName.selector)
      .first()
      .textContent()
      .catch(() => null);

    const prioritized =
      !!wantName && normalizeName(customerName).includes(wantName);
    out.set(reserveId, { reserveId, href, customerName, prioritized });
  }
  return [...out.values()];
}

/** 詳細ページを開き、ページ全文にマーカーが含まれるかを判定する。 */
export async function detailPageHasMarker(
  page: Page,
  baseUrl: string,
  href: string,
  marker: string,
  timeoutMs = 15_000,
): Promise<boolean> {
  const url = new URL(href, baseUrl).toString();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  // 備考欄のセレクタに依存せず、表示テキスト全文で照合する (DOM 変更に強い)。
  // 備考が textarea で表示される場合に備えて input/textarea の value も拾う。
  const bodyText = await page
    .locator("body")
    .innerText({ timeout: timeoutMs })
    .catch(() => "");
  if (bodyText.includes(marker)) return true;
  const fieldValues = await page
    .evaluate(() =>
      Array.from(
        document.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>(
          "textarea, input[type='text']",
        ),
        (el) => el.value ?? "",
      ).join("\n"),
    )
    .catch(() => "");
  return fieldValues.includes(marker);
}

/**
 * マーカー再スキャン本体。
 * ログイン済みの page を受け取り、予約一覧 → (顧客名で優先順付け) → 詳細ページ巡回で
 * 「KIREIDOT予約ID: {bookingId}」の有無を確定させる。
 */
export async function rescanForMarker(
  page: Page,
  baseUrl: string,
  target: RescanTarget,
  opts: RescanOptions = {},
): Promise<RescanResult> {
  const maxDetailPages = opts.maxDetailPages ?? 30;
  const detailTimeoutMs = opts.detailTimeoutMs ?? 15_000;
  const progress = opts.onProgress ?? (() => {});
  const marker = markerFor(target.bookingId);
  const notes: string[] = [];

  const listUrl =
    opts.listUrl ?? new URL(SB_PATHS.reserveListInit, baseUrl).toString();
  progress(`予約一覧を開きます: ${listUrl}`);
  await page.goto(listUrl, { waitUntil: "domcontentloaded", timeout: 25_000 });

  const table = page.locator(RESERVE_LIST.resultTable.selector).first();
  if ((await table.count().catch(() => 0)) === 0) {
    notes.push(
      `一覧テーブル(${RESERVE_LIST.resultTable.selector})が見つかりません。` +
        `url=${page.url()} title=${await page.title().catch(() => "?")}`,
    );
    return {
      found: false,
      externalId: null,
      candidates: 0,
      scanned: 0,
      exhaustive: false,
      notes,
    };
  }

  const candidates = await collectReserveDetailLinks(page, target);
  notes.push(
    `候補 ${candidates.length} 件 (うち顧客名一致 ${candidates.filter((c) => c.prioritized).length} 件)`,
  );

  // 顧客名一致を先に確認し、ヒットしなければ残りも確認する (打ち切りまで)。
  const ordered = [
    ...candidates.filter((c) => c.prioritized),
    ...candidates.filter((c) => !c.prioritized),
  ];

  let scanned = 0;
  for (const c of ordered) {
    if (scanned >= maxDetailPages) break;
    scanned++;
    progress(
      `詳細確認 ${scanned}/${Math.min(ordered.length, maxDetailPages)}: ` +
        `${c.reserveId} (${c.customerName ?? "?"})`,
    );
    try {
      if (
        await detailPageHasMarker(page, baseUrl, c.href, marker, detailTimeoutMs)
      ) {
        notes.push(`マーカー一致: reserveId=${c.reserveId}`);
        return {
          found: true,
          externalId: c.reserveId,
          candidates: candidates.length,
          scanned,
          exhaustive: true,
          notes,
        };
      }
    } catch (e) {
      notes.push(
        `詳細ページ確認失敗 reserveId=${c.reserveId}: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  const exhaustive = scanned >= ordered.length;
  if (!exhaustive) {
    notes.push(
      `maxDetailPages=${maxDetailPages} で打ち切り (未確認 ${ordered.length - scanned} 件)。` +
        `「未登録」は確定ではないため manual_required に倒すこと。`,
    );
  }
  return {
    found: false,
    externalId: null,
    candidates: candidates.length,
    scanned,
    exhaustive,
    notes,
  };
}
