/**
 * KIREIDOT Salonboard Worker (local skeleton)
 *
 * このワーカーは KIREIDOT Admin が積んだ salonboard_sync_jobs を
 * ポーリングして取り出し、
 *  - DRY_RUN=true のときはサロンボードに一切アクセスせず即 succeeded で返す
 *  - それ以外では Playwright でログインまで試行し、結果を callback する
 *
 * まだスクレイピング本体 (fetch_bookings / fetch_sales / push_booking /
 * cancel_booking の実装) は入っていない。現状はログイン成否だけを報告し、
 * ジョブを queued -> running -> succeeded/failed に遷移させるのが目的。
 *
 * 使い方:
 *   cp .env.example .env.local
 *   編集して SALONBOARD_WORKER_TOKEN を Admin 側と揃える
 *   npm install
 *   npx playwright install chromium
 *   npm run dev            # ループ実行
 *   npm run once           # 1ジョブだけ処理して終了
 *   npm run dry-run        # サロンボードに触らず callback だけ返す
 */

import { chromium, type Browser, type BrowserContext, type Dialog, type Page } from "playwright";
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, statSync, copyFileSync, cpSync, readdirSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve, join, dirname } from "node:path";
import { homedir } from "node:os";
import {
  SCHEDULE,
  REGISTER_FORM,
  RESERVE_LIST,
  RESERVE_ID_RE,
  scheduleUrl,
  reserveRegistUrl,
  staffOptionValue,
  staffPresenceSelector,
} from "./salonboard-selectors";

// 本番スクレイパー (scrapers.cjs) を共有。PC 版 worker-process.cjs と同じ実装を
// クラウド worker でも再利用する。electron 非依存 (node:fs/os/path のみ) なので
// esbuild でそのままバンドル可能。Dockerfile.worker が electron/scrapers.cjs を COPY する。
import scrapersDefault from "./electron/scrapers.cjs";

type ScraperResult = {
  status: "ok" | "confirm_only" | "failed";
  externalId?: string | null;
  recoveredReserveId?: string | null;
  errorCode?: string;
  reason?: string;
  manualRequired?: boolean;
  summary?: string;
  warnings?: string[];
  alreadyAbsent?: boolean;
};
type ScraperFn = (
  page: Page,
  payload: unknown,
  opts: Record<string, unknown>,
) => Promise<ScraperResult>;
type ScrapersModule = {
  cancelBookingViaForm: ScraperFn;
  pushScheduleViaForm: ScraperFn;
  changeScheduleViaForm: ScraperFn;
  deleteScheduleViaForm: ScraperFn;
  pushShiftsViaForm: ScraperFn;
  postPhotoGalleryViaForm: ScraperFn;
  deleteBlogViaForm: ScraperFn;
  postReviewReplyViaForm: ScraperFn;
  pushEquipmentViaForm: ScraperFn;
  pushStaffViaForm: ScraperFn;
  pushStaffProfileViaForm: ScraperFn;
  pushMenuViaForm: ScraperFn;
  pushCouponViaForm: ScraperFn;
  pushWorkPatternViaForm: ScraperFn;
  // fetch 系 (status ではなく rows/patterns を返す)
  scrapeBookings: (
    page: Page,
    opts: Record<string, unknown>,
  ) => Promise<{ rows: unknown[]; debug?: unknown }>;
  scrapeShiftPatterns: (
    page: Page,
    baseUrl: string,
    opts?: Record<string, unknown>,
  ) => Promise<{ patterns?: unknown[] }>;
};
const scrapers = scrapersDefault as unknown as ScrapersModule;

// package.json の "version" を実行時に読む。失敗しても起動を止めない。
function readPkgVersion(): string {
  try {
    const pkgPath = resolve(__dirname, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    try {
      const pkg = JSON.parse(
        readFileSync(resolve(process.cwd(), "package.json"), "utf8")
      ) as { version?: string };
      return pkg.version ?? "0.0.0";
    } catch {
      return "0.0.0";
    }
  }
}

// ------------------------------------------------------------
// env 読み込み (dotenv 未使用。軽量実装)
// ------------------------------------------------------------
function loadEnvFile(file: string) {
  if (!existsSync(file)) return;
  const body = readFileSync(file, "utf8");
  for (const line of body.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, k, rawV] = m;
    if (process.env[k] !== undefined) continue;
    const v = rawV.replace(/^['"]|['"]$/g, "");
    process.env[k] = v;
  }
}
loadEnvFile(resolve(process.cwd(), ".env.local"));
loadEnvFile(resolve(process.cwd(), ".env"));

const API = requireEnv("KIREIDOT_API_URL");

/**
 * 実行モード:
 *  - device      (本番): 店舗 PC ごとに発行された device_id / device_token で
 *                       SALONBOARD_DEVICE_ID + SALONBOARD_DEVICE_TOKEN を使う。
 *                       Authorization: Bearer <device_token>
 *                       X-Device-Id:   <uuid>
 *  - central-dev (開発): 互換のため global SALONBOARD_WORKER_TOKEN を使う。
 *                       Admin 側が NODE_ENV!=='production' のときのみ通る。
 *                       Authorization: Bearer <SALONBOARD_WORKER_TOKEN>
 *                       X-Device-Id は付けない。
 */
const WORKER_MODE = (process.env.WORKER_MODE ?? "device").toLowerCase() as
  | "device"
  | "central-dev";

if (WORKER_MODE !== "device" && WORKER_MODE !== "central-dev") {
  console.error(
    `[fatal] WORKER_MODE must be "device" or "central-dev" (got "${WORKER_MODE}")`
  );
  process.exit(1);
}

const DEVICE_ID = process.env.SALONBOARD_DEVICE_ID ?? "";
const DEVICE_TOKEN = process.env.SALONBOARD_DEVICE_TOKEN ?? "";
const GLOBAL_TOKEN = process.env.SALONBOARD_WORKER_TOKEN ?? "";

if (WORKER_MODE === "device") {
  if (!DEVICE_ID || !DEVICE_TOKEN) {
    console.error(
      "[fatal] WORKER_MODE=device requires SALONBOARD_DEVICE_ID and SALONBOARD_DEVICE_TOKEN"
    );
    process.exit(1);
  }
  if (!/^[0-9a-f-]{36}$/i.test(DEVICE_ID)) {
    console.error("[fatal] SALONBOARD_DEVICE_ID must be a uuid");
    process.exit(1);
  }
} else {
  // central-dev
  if (!GLOBAL_TOKEN) {
    console.error(
      "[fatal] WORKER_MODE=central-dev requires SALONBOARD_WORKER_TOKEN"
    );
    process.exit(1);
  }
  // 2026-05-31〜: 単一デバイス運用に切り替え、global token (central-dev) を
  // 本番でも使う方針にした。Admin 側ゲートも外してあるので警告は出さない。
  console.log(
    "[cfg] WORKER_MODE=central-dev (global token / 全サロン同期)"
  );
}

const WORKER_ID = (process.env.WORKER_ID ?? "local-dev").slice(0, 64);
// クラウドworkerが申告する capability(カンマ区切り)。Admin claim が「required ⊆ worker」で
// 絞り込む想定。未指定の旧クライアント(PC)は Admin 側で全capability保有とみなす(後方互換)。
const WORKER_CAPABILITIES = (process.env.WORKER_CAPABILITIES ?? "").trim();
const APP_VERSION = process.env.APP_VERSION ?? readPkgVersion();
const PLATFORM = process.platform;
const POLL_MS = Number(process.env.POLL_INTERVAL_MS ?? 30_000);

// ── 予約書込3分SLA: fetch preemption ─────────────────────────────
// 予約書込(push_booking/cancel_booking)が来た瞬間、同店で走行中の fetch を即 abort し、
// SBセッション(同一アカウント同時1)を解放して書込を最優先実行する。
// worker は Supabase の SECURITY DEFINER RPC salonboard_pending_write_shop_ids() を anon で叩き、
// 走行中 fetch の shop_id が含まれたら AbortController.abort() する(scrapeBookings が signal を見て打切り)。
const SUPABASE_URL =
  process.env.SB_SUPABASE_URL ?? "https://cxbqbjrxsuuabhxlrdpz.supabase.co";
const SUPABASE_ANON_KEY =
  process.env.SB_SUPABASE_ANON_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN4YnFianJ4c3V1YWJoeGxyZHB6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ0MzQxODksImV4cCI6MjA5MDAxMDE4OX0.2HtTA5VQ4dArBjLmM5hg_T5bhb42d_xHgK8azBfP6dE";
// jobId -> { shopId, controller, page }。走行中 fetch のみ登録。
// page も持ち、preempt 時に close して in-flight のページ操作を即座に打切る(signalだけだと
// ループ外の goto/waitForSelector を待ってしまい数十秒かかるため)。
const _fetchAbort = new Map<
  string,
  { shopId: string; controller: AbortController; page: { close: () => Promise<void> } }
>();
async function fetchPendingWriteShops(): Promise<string[]> {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/rpc/salonboard_pending_write_shop_ids`,
      {
        method: "POST",
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      },
    );
    if (!res.ok) return [];
    const arr = (await res.json()) as unknown;
    return Array.isArray(arr) ? (arr as string[]) : [];
  } catch {
    return [];
  }
}
async function preemptFetchesForWrites(): Promise<void> {
  if (_fetchAbort.size === 0) return;
  const shops = await fetchPendingWriteShops();
  if (!shops.length) return;
  const pending = new Set(shops);
  for (const [jobId, f] of _fetchAbort) {
    if (pending.has(f.shopId) && !f.controller.signal.aborted) {
      console.log(
        `[preempt] 予約書込pending shop=${f.shopId.slice(0, 8)} -> fetch ${jobId.slice(0, 8)} を中断`,
      );
      f.controller.abort();
      // in-flight のページ操作を即中断(goto/waitForSelector 等が Target closed で throw)。
      try {
        void f.page.close();
      } catch {
        /* noop */
      }
    }
  }
}
const DRY_RUN =
  /^(1|true|yes)$/i.test(process.env.DRY_RUN ?? "") ||
  process.argv.includes("--dry-run");
const RUN_ONCE = process.argv.includes("--once");

/**
 * push_booking の安全装置:
 *  - SALONBOARD_ENABLE_PUSH が **"1" または "true" (大文字小文字無視)** のときのみ、
 *    確認画面の照合後に実際の「登録」ボタンを押す。
 *  - 未設定・空文字・それ以外の値はすべて無効 (= dryRun 相当の安全モード) とし、
 *    確認画面まで進めて payload と照合した上で、登録は行わず manual_required で
 *    callback する。
 * 本番 SalonBoard にいきなり登録させないための明示フラグ。
 */
function parseEnablePush(raw: string | undefined): boolean {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}
const ENABLE_PUSH = parseEnablePush(process.env.SALONBOARD_ENABLE_PUSH);
/** push_booking の自動リトライ上限 (Admin の MAX_PUSH_ATTEMPTS と揃える)。 */
const MAX_PUSH_ATTEMPTS = 3;

/**
 * 一過性のインフラ由来失敗コード。SalonBoard/Akamai の一時的な書込ブロックで、
 * 時間経過(セッションが温まる・500 が解ける)でしか回復しない。scraper 側は
 * これらを manualRequired=false で返し「良い窓口を引くまで粘る」設計になっている
 * (electron/scrapers.cjs pushBookingViaForm の SB_SERVER_ERROR / SB_REGISTER_INCOMPLETE 参照)。
 *
 * にもかかわらず worker が試行上限超過(job.attempts >= max_attempts)で一律に
 * manual_required へ昇格させると、20〜45分の Akamai クールダウン窓の中で 3 回消費し切った
 * だけの一過性失敗が「手動登録が必要」に固定され、人手を要求してしまう(実際は回復後に
 * 自動で通る)。そこで、これらのコードは上限超過でも manual に昇格させず retryable_failed
 * を維持し、回復後の自動再投入に委ねる。
 *
 * ※ SLOT_NOT_AVAILABLE(実枠競合) / RESERVE_NOT_FOUND(対象特定不能) / *_MAPPING_NOT_FOUND /
 *   CONFIRMATION_MISMATCH / UNKNOWN_ERROR 等の「実データ/セレクタ起因」は従来どおり
 *   上限超過で manual_required に倒す(再試行しても無駄・人手が要るため)。
 */
const INFRA_TRANSIENT_ERROR_CODES = new Set<string>([
  "SB_SERVER_ERROR",
  "SB_REGISTER_INCOMPLETE",
]);
function isInfraTransientError(code?: string | null, reason?: string | null): boolean {
  if (code && INFRA_TRANSIENT_ERROR_CODES.has(code)) return true;
  return /login did not complete|ERR_HTTP_RESPONSE_CODE_FAILURE|再度操作しなおしてください|システムエラー|予定の登録完了を確認できません|exact_schedule_not_found|予定登録後の実在確認に失敗|削除操作後もスケジュール上に予定が残っています|フォームに到達できません|登録ボタンが見つかりません|並び順が保存されません|保存を確認できません|timeout|タイムアウト|navigation|net::/i.test(
    reason ?? "",
  );
}

// ログイン制限は同じCloud出口からPOSTを重ねるほど悪化する。検知後はendpoint単位の
// 解除時刻までログインPOSTを止め、callbackへdeferredを返してattemptを消費せず待つ。

/**
 * ★店舗単位 自動フェイルオーバー (ISP → Residential, 2026-07-09):
 *   既定は Static Residential (ISP, 定額) 固定IP。ある店舗が login-throttle
 *   (Akamai の doLogin ホールド)を AUTO_RES_THRESHOLD 回**連続**で起こしたら、
 *   その店舗**だけ** AUTO_RES_TTL_MS の間 住宅IP(従量課金, jp.decodo.com)へ
 *   自動退避する。TTL 満了で ISP へ自動復帰し、次ジョブで ISP を再試験→また
 *   throttle すれば再退避。これで**住宅GBは「今まさに失敗している店」に限定**され、
 *   回復した店は自動的に定額ISPへ戻る(郡山の手動pinを一般化・GB効率化)。
 *   手動 override("residential") は常に優先。同時退避数は AUTO_RES_MAX_SHOPS で上限
 *   (GB暴走防止)。プロセス内メモリ保持(restart で streak はリセットされるが、
 *   失敗が続けば即再退避するため実害小)。
 */
const AUTO_RES_THRESHOLD = 1; // Cloud書込は1回の throttle で即退避し、同一attempt内で再試行
const AUTO_RES_TTL_MS = 6 * 60 * 60_000; // 6時間 住宅に留める(満了で ISP 再試験)
const AUTO_RES_MAX_SHOPS = 3; // 同時に住宅へ載せる上限(GB暴走防止)
const shopThrottleStreak = new Map<string, number>();
const shopAutoResidentialUntil = new Map<string, number>();
/** この店舗が現在 自動フェイルオーバーで住宅退避中か。 */
function autoResidentialActive(shopId?: string): boolean {
  if (!shopId) return false;
  return (shopAutoResidentialUntil.get(shopId) ?? 0) > Date.now();
}
/** 手動pin(override="residential") or 自動退避 の合算判定(proxy選択で使用)。 */
function shopPrefersResidential(shopId?: string): boolean {
  return shopWantsResidential(shopId) || autoResidentialActive(shopId);
}
/** login-throttle 検知時: 連続 streak を増やし、閾値到達で住宅へ自動退避。 */
function noteLoginThrottle(shopId: string): void {
  const n = (shopThrottleStreak.get(shopId) ?? 0) + 1;
  shopThrottleStreak.set(shopId, n);
  if (n < AUTO_RES_THRESHOLD) return;
  if (!fallbackConfigured() || autoResidentialActive(shopId)) return;
  const activeAuto = [...shopAutoResidentialUntil.values()].filter(
    (t) => t > Date.now(),
  ).length;
  if (activeAuto >= AUTO_RES_MAX_SHOPS) {
    console.log(
      `[proxy] auto-failover 上限(${AUTO_RES_MAX_SHOPS}店)到達 → shop=${shopId.slice(0, 8)} は退避せず ISP 継続`,
    );
    return;
  }
  shopAutoResidentialUntil.set(shopId, Date.now() + AUTO_RES_TTL_MS);
  console.log(
    `[proxy] auto-failover: shop=${shopId.slice(0, 8)} を住宅IPへ自動退避 (${n}回連続throttle, TTL${Math.round(AUTO_RES_TTL_MS / 3600000)}h)`,
  );
}
/** login 成功時: throttle streak をリセット(住宅退避の TTL は自然満了に任せる)。 */
function noteLoginSuccess(shopId: string): void {
  if (shopThrottleStreak.has(shopId)) shopThrottleStreak.delete(shopId);
}

/**
 * ★ログイン後に SB が出す HTML モーダル(HOT PEPPER 満足度アンケート/お知らせ/キャンペーン等)を
 *   閉じる (2026-07-11 ユーザー指摘)。モーダルがページを覆うと、裏のボタン(#batchSet 等)や
 *   フォームへの遷移がブロックされ書込が失敗する。これは DOM オーバーレイなので
 *   page.on('dialog')(=ネイティブ alert/confirm)では閉じられない。
 *   Escape + 「×/閉じる/close」系の可視ボタン + 背景暗幕クリックで最大3回試行。
 *   例外は投げない(防御的・存在しなければ即 return)。
 */
async function dismissBlockingModals(page: Page): Promise<void> {
  try {
    // モーダル/オーバーレイが実在する時だけ動く(通常ページで × を誤クリックしないよう)。
    const modal = page
      .locator('[class*="odal"], [id*="odal"], [role="dialog"], .mod_popup, [class*="verlay"]')
      .filter({ visible: true })
      .first();
    if ((await modal.count().catch(() => 0)) === 0) return;
    for (let i = 0; i < 2; i++) {
      // 閉じるボタンは「モーダル内」に限定して探す(スコープ限定=誤クリック防止)。
      const closeBtn = modal
        .locator(
          '[class*="lose"], [aria-label="閉じる"], [aria-label="close" i], a:has-text("×"), button:has-text("×"), :text("✕")',
        )
        .filter({ visible: true })
        .first();
      if ((await closeBtn.count().catch(() => 0)) > 0) {
        await closeBtn.click({ timeout: 1500 }).catch(() => {});
        console.log("[modal] ログイン後モーダルを閉じました");
      } else {
        await page.keyboard.press("Escape").catch(() => {});
      }
      await page.waitForTimeout(400);
      if ((await modal.count().catch(() => 0)) === 0) break; // 閉じたら完了
    }
  } catch {
    /* 防御的: モーダル処理で throw しない */
  }
}

// 起動時に push モードを明示ログ (平文の値はそのまま出さない)。
console.log(
  `[cfg] SALONBOARD_ENABLE_PUSH=${ENABLE_PUSH ? "ON (登録ボタンを押します)" : "OFF (確認画面まで / 登録しません)"}`,
);

// OpenClaw 自己修復: ANTHROPIC_API_KEY が env に無ければコンテナ内ファイルから読む。
// 環境変数で渡すには container 再作成が必要で per-shop セッション(userDataDir)が消える
// (再ログイン嵐 → IP フラグ) ため、restart だけで済むファイル方式にする。
// SSM の /kireidot/worker/anthropic/api_key を EC2 側でこのファイルへ書き込む運用。
if (!process.env.ANTHROPIC_API_KEY) {
  try {
    const keyPath =
      process.env.ANTHROPIC_API_KEY_FILE ||
      "/home/pwuser/.kireidot/anthropic_api_key";
    if (existsSync(keyPath)) {
      const k = readFileSync(keyPath, "utf8").trim();
      if (k) process.env.ANTHROPIC_API_KEY = k;
    }
  } catch {
    /* noop: キー読込失敗時は OpenClaw OFF のまま継続 */
  }
}
console.log(
  `[cfg] OpenClaw 自己修復=${process.env.ANTHROPIC_API_KEY ? "ARMED (キー検出・セレクタ崩壊時に発動)" : "OFF (キー無し)"}`,
);

function requireEnv(k: string): string {
  const v = process.env[k];
  if (!v) {
    console.error(`[fatal] env ${k} is required`);
    process.exit(1);
  }
  return v;
}

/** jobs / callback 共通のリクエストヘッダ */
function buildAuthHeaders(): Record<string, string> {
  if (WORKER_MODE === "device") {
    return {
      Authorization: `Bearer ${DEVICE_TOKEN}`,
      "X-Device-Id": DEVICE_ID,
      "X-Worker-Id": WORKER_ID,
      "X-App-Version": APP_VERSION,
      "X-Platform": PLATFORM,
    };
  }
  return {
    Authorization: `Bearer ${GLOBAL_TOKEN}`,
    "X-Worker-Id": WORKER_ID,
    "X-App-Version": APP_VERSION,
    "X-Platform": PLATFORM,
  };
}

// ------------------------------------------------------------
// 型
// ------------------------------------------------------------
type JobType =
  | "fetch_bookings"
  | "fetch_sales"
  | "push_booking"
  | "cancel_booking"
  | "push_blog"
  | "push_shifts"
  | "push_photo_gallery"
  | "delete_blog"
  | "push_review_reply"
  // 設定系 write (KIREIDOT→SB)。SB編集フォームへ書き込む (設備/スタッフ/メニュー/クーポン)。
  | "push_equipment"
  | "push_staff"
  | "push_menu"
  | "push_coupon"
  | "push_shift_patterns"
  | "fetch_shifts"
  | "fetch_shift_patterns"
  // 設定系 fetch (クラウド完結/PC引退用に job 化)。worker は既存 scraper を呼び、
  // Admin callback が既存 RPC salonboard_bulk_upsert_* に取込む。
  | "fetch_staff"
  | "fetch_menu"
  | "fetch_menus"
  | "fetch_coupon"
  | "fetch_coupons"
  | "fetch_equipment"
  | "fetch_reviews"
  | "fetch_blog"
  | "fetch_photo_gallery"
  | "fetch_salon"
  // 追加 (2026-07-11): 残エンティティ (こだわり/特集/スタイル) + DOM調査
  | "fetch_kodawari"
  | "fetch_feature"
  | "fetch_style"
  | "discover_listing"
  // 掲載系 write (KIREIDOT→SB)
  | "push_salon"
  | "push_kodawari"
  | "push_feature"
  // 受付可能数 (残り受付数) の手動オーバーライドを SB スケジュールへ同期 (美容室のみ)
  | "push_acceptance";

type Job = {
  id: string;
  shop_id: string;
  organization_id: string;
  job_type: JobType;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
  credentials: {
    login_id: string;
    password: string;
    base_url: string | null;
    // クラウド worker 用: 店舗ごとの住宅/ISP プロキシ (Admin が復号して同梱)。
    // 省略時は env SB_PROXY_* / direct にフォールバック (resolveLaunchOptions 参照)。
    proxy?: {
      server: string;
      username?: string | null;
      password?: string | null;
    } | null;
  };
};

/**
 * Worker → Admin callback の payload。
 * bookings[] の各要素は KIREIDOT_Admin/src/app/api/salonboard/callback/route.ts
 * のドキュメントコメントと完全一致させること (RPC salonboard_bulk_upsert_bookings
 * が期待するキー)。
 */
type ScrapedBooking = {
  external_id: string;
  scheduled_at: string;            // ISO 8601 (JST → UTC 変換済み)
  duration_min?: number | null;
  customer_name?: string | null;
  customer_code?: string | null;    // SB 顧客コード "YG12345678" など
  customer_phone?: string | null;
  customer_email?: string | null;
  customer_birthday?: string | null; // YYYY-MM-DD
  menu_name?: string | null;
  amount?: number | null;
  status?: "confirmed" | "cancelled" | "completed" | "no_show" | "pending";
  staff_name?: string | null;       // 表示名 (例: "(指)Hina")
  staff_external_id?: string | null;
  reservation_route?: string | null;
  payment_method_label?: string | null;
  coupon_name?: string | null;
  notes?: string | null;
};

/**
 * 新 status 体系 (Admin callback と一致):
 *   succeeded            … 成功。
 *   retryable_failed     … 一時的失敗 (ネット/タイムアウト)。指数バックオフで再 queue 可。
 *   non_retryable_failed … 再試行しても無駄。payload 不整合・要素未検出など。
 *   login_required       … 認証情報の問題。自動 retry しない。
 *   captcha_detected     … reCAPTCHA / 不審アクセス検知。自動 retry しない。
 *   blocked              … 403 / 429 / アクセス制限。自動 retry しない。
 *   not_implemented      … 未実装 job_type。
 *   cancelled            … 実行条件未充足のためキャンセル。
 */
type CallbackStatus =
  | "succeeded"
  | "deferred"
  | "retryable_failed"
  | "non_retryable_failed"
  | "login_required"
  | "captcha_detected"
  | "blocked"
  | "not_implemented"
  | "cancelled";

type CallbackBody = {
  job_id: string;
  // push_booking では追加で "manual_required" も送れる (Admin 側で解釈する)。
  status: CallbackStatus | "manual_required";
  error?: string;
  summary?: string;
  bookings?: ScrapedBooking[];
  sales?: unknown;
  external_id?: string;
  block?: { until: string; reason: string };
  retry_at?: string;
  // 失敗時の「直前画面」スクショ(base64 PNG)。Admin が Storage へ保存し Slack 通知に添付する。
  error_capture_b64?: string;

  // --- push_booking 専用フィールド ---
  job_type?: JobType;
  booking_id?: string;
  external_booking_id?: string | null;
  salonboard_detail_url?: string | null;
  error_code?: SalonboardErrorCode;
  manual_required?: boolean;
  already_exists?: boolean;
  result_payload?: {
    confirmed_customer_name?: string | null;
    confirmed_staff_name?: string | null;
    confirmed_menu_name?: string | null;
    confirmed_scheduled_at?: string | null;
  };
};

/** push_booking のエラーコード (Admin の SalonboardErrorCode と揃える)。 */
type SalonboardErrorCode =
  | "LOGIN_FAILED"
  | "RECAPTCHA_REQUIRED"
  | "SLOT_NOT_AVAILABLE"
  | "STAFF_MAPPING_NOT_FOUND"
  | "BOOKING_ID_NOT_FOUND"
  | "MENU_MAPPING_NOT_FOUND"
  | "CONFIRMATION_MISMATCH"
  | "ALREADY_EXISTS"
  | "PUSH_DISABLED"
  | "UNKNOWN_ERROR";

/**
 * push_booking ジョブの payload。
 * KIREIDOT_Admin/src/lib/salonboard/push-booking-types.ts (PushBookingJobPayload)
 * のミラー。正本は Admin 側。
 */
type PushBookingPayload = {
  booking_id: string;
  action?: "create" | "update" | "cancel";
  customer_name?: string | null;
  customer_phone?: string | null;
  customer_email?: string | null;
  customer_code?: string | null;
  staff_id?: string | null;
  salonboard_staff_external_id?: string | null;
  staff_name?: string | null;
  menu_id?: string | null;
  menu_name?: string | null;
  salonboard_menu_name?: string | null;
  coupon_name?: string | null;
  scheduled_at: string;
  duration_min?: number | null;
  amount?: number | null;
  notes?: string | null;
  kireidot_ref?: string;
  booking_type?: "customer" | "block" | null;
  block_reason?: string | null;
  resource_id?: string | null;
  salonboard_equipment_external_id?: string | null;
  salonboard_equipment_name?: string | null;
};

/** pushBooking() の内部結果。 */
type PushBookingResult =
  | {
      // 実際に登録した / 既存予約を検出した → synced
      status: "ok";
      externalId?: string | null;
      detailUrl?: string | null;
      alreadyExists?: boolean;
      confirmed?: CallbackBody["result_payload"];
    }
  | {
      // 確認画面まで到達して照合 OK だが ENABLE_PUSH=false で登録せず止めた
      status: "confirm_only";
      confirmed?: CallbackBody["result_payload"];
    }
  | {
      status: "failed";
      reason: string;
      errorCode: SalonboardErrorCode;
      // true のとき manual_required (人手対応必須)、false なら failed (再試行可能性あり)。
      manualRequired: boolean;
    };

// ------------------------------------------------------------
// HTTP
// ------------------------------------------------------------
async function fetchJobs(limit = 1): Promise<Job[]> {
  // 申告capabilityを poll に載せる(Admin が「required ⊆ worker」で絞り込む想定)。
  const capParam = WORKER_CAPABILITIES
    ? `&capabilities=${encodeURIComponent(WORKER_CAPABILITIES)}`
    : "";
  const res = await fetch(`${API}/api/salonboard/jobs?limit=${limit}${capParam}`, {
    headers: buildAuthHeaders(),
  });
  if (!res.ok) {
    const body = await safeText(res);
    throw new Error(`jobs fetch failed: ${res.status} ${body}`);
  }
  const json = (await res.json()) as { jobs?: Job[]; mode?: string };
  return json.jobs ?? [];
}

// 反映(書込)フローの失敗を page 単位で記録する。finally で「この page(=このジョブ)が
// 失敗したか」を判定し、失敗時のみ録画動画を Admin へ上げるために使う。
const _pageWriteFailed = new WeakMap<object, boolean>();
// Guard timeout closes the browser while the original async handler is still
// unwinding. Suppress its later "page has been closed" callback so one Cloud
// attempt produces exactly one terminal callback / one history transition.
const _guardTimedOutJobs = new Map<string, number>();

// 失敗時に反映フローの録画(webm)を Admin 経由で Storage に上げる。worker は Supabase 直アクセスを
// 持たないため、既存の callback と同じ認証で /api/salonboard/job-video に base64 送信する。
// 動画が大きすぎる(>3.5MB)場合はスキップ(本体 body 制限回避)。
async function uploadJobVideo(jobId: string, videoPath: string): Promise<void> {
  try {
    const buf = readFileSync(videoPath);
    if (buf.length > 3_500_000) {
      console.warn(`[video] ${jobId.slice(0, 8)} 動画が大きすぎ(${Math.round(buf.length / 1024)}KB)スキップ`);
      return;
    }
    const res = await fetch(`${API}/api/salonboard/job-video`, {
      method: "POST",
      headers: { ...buildAuthHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ job_id: jobId, video_b64: buf.toString("base64") }),
    });
    if (!res.ok) {
      console.warn(`[video] ${jobId.slice(0, 8)} upload non-2xx: ${res.status}`);
    } else {
      console.log(`[video] ${jobId.slice(0, 8)} 反映動画をアップロード(${Math.round(buf.length / 1024)}KB)`);
    }
  } catch (e) {
    console.warn(`[video] ${jobId.slice(0, 8)} upload失敗: ${(e as Error)?.message ?? e}`);
  }
}

async function report(body: CallbackBody, capturePage?: unknown): Promise<void> {
  const reportJobId = String((body as { job_id?: string }).job_id ?? "");
  const reportError = String((body as { error?: string }).error ?? "");
  const guardTimedOutAt = _guardTimedOutJobs.get(reportJobId);
  const isGuardTimeoutReport = reportError.includes("[CLOUD_PC_FALLBACK] cloud処理が");
  if (guardTimedOutAt && !isGuardTimeoutReport) {
    console.warn(
      `[callback] suppress late callback after guard timeout job=${reportJobId.slice(0, 8)} error=${reportError.slice(0, 120)}`,
    );
    return;
  }
  // 失敗系コールバックには失敗地点のスクショ(メモリbuffer)を base64 で同梱する。
  // Admin が Storage に保存し、Slack 通知に画像として添付できるようにする(best-effort)。
  try {
    const st = String((body as { status?: string }).status ?? "");
    const isFail = st !== "" && !["succeeded", "ok", "confirm_only"].includes(st);
    // 反映動画の要否判定用: この page(=このジョブ)が失敗したことを記録。
    if (isFail && capturePage) {
      try { _pageWriteFailed.set(capturePage as object, true); } catch { /* noop */ }
    }
    if (isFail && !(body as { error_capture_b64?: string }).error_capture_b64) {
      // ★並行安全 (2026-07-11): まず「このジョブの page」で撮ったショットを優先。
      //   店舗レーン並行(max2)で共有グローバル(getLastErrorShot)を使うと、別ジョブの
      //   スクショを誤添付する(向井キャンセルに尾崎予約の画像が載った事故)。page を
      //   渡せた場合は per-page ショットのみ採用し、グローバルは page 無しの旧経路のみ。
      const s = scrapers as {
        getLastErrorShotForPage?: (p: unknown) => Promise<{ buffer?: Buffer; at?: number } | null>;
        getLastErrorShot?: () => Promise<{ buffer?: Buffer; at?: number } | null>;
      };
      const shot = capturePage
        ? await s.getLastErrorShotForPage?.(capturePage)
        : await s.getLastErrorShot?.();
      // 直近(<20s)の失敗ショットのみ採用 (古い別ジョブのショット誤添付を防ぐ)。
      if (
        shot &&
        shot.buffer &&
        Buffer.isBuffer(shot.buffer) &&
        Date.now() - Number(shot.at ?? 0) < 20_000
      ) {
        (body as { error_capture_b64?: string }).error_capture_b64 =
          shot.buffer.toString("base64");
      }
    }
  } catch (_e) {
    /* スクショ添付は best-effort: 失敗してもコールバックは送る */
  }
  // callback が一時的なネットワーク切断で失われると、SalonBoard側の処理が終わっていても
  // DBは running のまま残る。各試行を15秒で打ち切り、同一payloadを最大3回再送する。
  // callbackはjob_id単位の更新なので再送は冪等。
  let lastError = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${API}/api/salonboard/callback`, {
        method: "POST",
        headers: {
          ...buildAuthHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) {
        if (attempt > 1) {
          console.log(`[callback] retry succeeded job=${reportJobId.slice(0, 8)} attempt=${attempt}`);
        }
        return;
      }
      lastError = `${res.status} ${await safeText(res)}`;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
    console.warn(
      `[callback] attempt ${attempt}/3 failed job=${reportJobId.slice(0, 8)}: ${lastError.slice(0, 180)}`,
    );
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 500));
  }
  throw new Error(`callback failed after 3 attempts: ${lastError}`);
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "<unreadable>";
  }
}

/**
 * scrapers.cjs の push/cancel 系結果 (status: ok|confirm_only|failed) を
 * Admin callback ステータスへマップする共通処理 (worker-process.cjs と同じ分類)。
 *  - ok          → succeeded
 *  - confirm_only → manual_required (PUSH_DISABLED: ENABLE_PUSH=false で実書込していない)
 *  - failed      → captcha_detected / manual_required (上限到達 or manualRequired) / retryable_failed
 */
async function reportScraperResult(
  job: Job,
  jobType: string,
  result: ScraperResult,
  extra: Record<string, unknown> = {},
  capturePage?: unknown,
): Promise<void> {
  const tag = `${jobType} ${job.id.slice(0, 8)}`;
  if (result.status === "ok") {
    const warningText = Array.isArray(result.warnings) && result.warnings.length > 0
      ? ` / 注意: ${result.warnings.slice(0, 5).join(" | ")}${result.warnings.length > 5 ? ` 他${result.warnings.length - 5}件` : ""}`
      : "";
    await report({
      job_id: job.id,
      job_type: jobType,
      status: "succeeded",
      external_id: result.externalId ?? result.recoveredReserveId ?? null,
      summary: `${result.summary ?? `${jobType} 完了`}${warningText}`.slice(0, 900),
      ...extra,
    } as unknown as CallbackBody);
    console.log(`[job] done  ${tag} (ok)`);
    return;
  }
  if (result.status === "confirm_only") {
    await report({
      job_id: job.id,
      job_type: jobType,
      status: "manual_required",
      error_code: "PUSH_DISABLED",
      error:
        "入力/照合まで成功しましたが、自動登録 (実書込) が無効 (SALONBOARD_ENABLE_PUSH=未設定) のため反映していません。SalonBoard で確認のうえ手動対応してください。",
      manual_required: true,
      ...extra,
    } as unknown as CallbackBody);
    console.log(`[job] done  ${tag} (confirm_only -> manual_required)`);
    return;
  }
  // failed
  const cap = job.max_attempts || MAX_PUSH_ATTEMPTS;
  // job.attempts は claim RPC がインクリメント済みの値 (=今回が何回目の試行か)。
  // +1 すると1回分リトライを取りこぼす (max_attempts=3 が実質2回になる)。
  const exhausted = job.attempts >= cap;
  const isCaptcha = result.errorCode === "RECAPTCHA_REQUIRED";
  // 一過性インフラ失敗(500着地/doComplete未確定)は上限超過でも manual に昇格させず
  // retryable のまま維持する(Akamai 回復後の自動再投入に委ねる)。実枠競合や要素未検出は従来どおり。
  const infraTransient = isInfraTransientError(result.errorCode, result.reason);
  const toManual = !infraTransient && (!!result.manualRequired || exhausted);
  await report(
    {
      job_id: job.id,
      job_type: jobType,
      status: isCaptcha
        ? "captcha_detected"
        : toManual
          ? "manual_required"
          : "retryable_failed",
      error_code: result.errorCode,
      error: result.reason,
      manual_required: toManual,
      ...(isCaptcha
        ? {
            block: {
              until: new Date(Date.now() + 6 * 60 * 60_000).toISOString(),
              reason: `reCAPTCHA during ${jobType}`,
            },
          }
        : {}),
      ...extra,
    } as unknown as CallbackBody,
    // ★このジョブの page で撮った失敗ショットのみ添付 (並行レーンで別ジョブの
    //   スクショを掴む誤添付を防ぐ)。errorCaptureB64 を extra に持つ経路はそちら優先。
    capturePage,
  );
  console.log(`[job] done  ${tag} (${result.errorCode}: ${result.reason})`);
}

// ------------------------------------------------------------
// ジョブ処理
// ------------------------------------------------------------
async function handleJob(job: Job): Promise<void> {
  const tag = `${job.job_type} ${job.id.slice(0, 8)} (attempt ${job.attempts})`;
  console.log(`[job] start ${tag} shop=${job.shop_id.slice(0, 8)}`);

  if (DRY_RUN) {
    // DRY_RUN: SalonBoard に一切触らず、成功扱いでフローだけ確認する。
    // push_blog で external_id を入れると content_posts に書き込みが走ってしまうので
    // ID は入れない (Admin 側で last_error に warning が残るのは想定内)。
    // push_booking は DRY_RUN で「成功」にすると bookings が synced になり
    // 二重登録の温床になる。dry-run では manual_required で安全に止める。
    if (job.job_type === "push_booking") {
      // 注意: DRY_RUN=1 は SalonBoard に一切アクセスしないため、
      // register_form_opened の capture は取得できない。
      // フォームを開いて capture したい場合は DRY_RUN を外し、
      // SALONBOARD_ENABLE_PUSH=false (未設定) のまま実行すること。
      console.warn(
        "[warn] DRY_RUN=1 のため push_booking は SalonBoard に触れず capture も取得しません。" +
          " 登録フォームを capture するには DRY_RUN を外し SALONBOARD_ENABLE_PUSH=false のまま実行してください。",
      );
      await report({
        job_id: job.id,
        job_type: "push_booking",
        status: "manual_required",
        booking_id: (job.payload as PushBookingPayload)?.booking_id,
        error_code: "PUSH_DISABLED",
        error: "[DRY_RUN] push_booking skipped (no SalonBoard access; capture も無し)",
        manual_required: true,
      });
      console.log(`[job] done  ${tag} (dry-run -> manual_required, capture なし)`);
      return;
    }
    await report({
      job_id: job.id,
      status: "succeeded",
      summary: `[DRY_RUN] ${job.job_type} skipped`,
      ...(job.job_type === "fetch_bookings" ? { bookings: [] } : {}),
      ...(job.job_type === "fetch_sales"
        ? { sales: { target_date: todayJst(), total_sales: 0, raw: { dry_run: true } } }
        : {}),
    });
    console.log(`[job] done  ${tag} (dry-run succeeded)`);
    return;
  }

  const baseUrl = job.credentials.base_url ?? "https://salonboard.com/";
  // グループ店舗は同じSalonBoardログインIDを共有する。店舗別profileだと店舗数分の
  // login POSTが発生するため、認証セッションと出口IPはアカウント単位で共有する。
  const sessionKey = sessionKeyFor(job.credentials.login_id, baseUrl);
  const ssPath = storageStatePathFor(sessionKey);

  let browser: Browser | null = null;
  let ctx: BrowserContext | null = null;
  // 反映(書込)フローの録画。write ジョブのみ有効化し、失敗時だけ Admin へ上げる(下 finally)。
  let videoDir: string | null = null;
  let videoPage: unknown = null;
  try {
    // 書込ジョブのプロキシ方針 (2026-06-29 インシデント修正):
    // 旧: residential gateway(gate.decodo.com, rotating)を既定ON。しかし IP ローテで
    //   そのIPに Akamai セッション(_abck)が無く isLoggedIn=未ログイン → /login/ →
    //   ERR_HTTP_RESPONSE_CODE_FAILURE(4xx) で書込が全滅した(fetch は ISP pool で正常)。
    // 新: 書込も fetch と同じ ISP pool(isp.decodo.com, sticky)を使う(forceResidential 既定OFF)。
    //   頻繁な fetch が _abck 信頼を維持しているので有効セッションで /login/ を踏まない。
    //   residential を強制したい場合のみ SB_WRITE_VIA_RESIDENTIAL=1。
    const WRITE_JOBS = new Set([
      "push_booking", "cancel_booking", "push_shifts", "push_shift_patterns",
      "push_photo_gallery", "push_blog", "delete_blog", "push_review_reply",
      "push_equipment", "push_staff", "push_menu", "push_coupon",
      "push_salon", "push_kodawari", "push_feature", "push_acceptance",
    ]);
    const isWriteJob = WRITE_JOBS.has(job.job_type);
    const forceResidential = writeViaResidentialEnabled() && isWriteJob;
    if (forceResidential) console.log(`[proxy] ${job.job_type} → residential 経由 (書込)`);
    // ★書込は住宅IP(cold session + 遅延 + 画像遮断)で複雑フォーム(ギャラリー/シフト等)が
    //   壊れる(2026-07-11 実証: 郡山 gallery=フォーム到達不可 / 銀座 shift=#batchSet timeout。
    //   ISP に戻すと成功)。write-via-residential を明示 ON にした場合を除き、auto-FO 中でも
    //   住宅を使わず ISP(定額・warm session)に固定する。住宅はあくまで読み(fetch)専用。
    const avoidResidential = isWriteJob && !forceResidential;
    let { launch, realChrome } = resolveLaunchOptions(
      job.credentials.proxy,
      forceResidential,
      job.shop_id,
      avoidResidential,
      sessionKey,
    );
    if (launch.proxy) {
      console.log(
        `[job] ${tag} proxy=${launch.proxy.server} channel=${launch.channel ?? "chromium"} headless=${launch.headless}`
      );
    }
    // 動画録画は Chromium のエンコード負荷と一時ディスク消費が大きいため既定 OFF。
    // 一時調査で明示的に SB_RECORD_WRITE_VIDEO=1 を設定した場合だけ有効化する。
    // 通常の失敗診断には report() の軽量な静止画キャプチャを使用する。
    if (
      isWriteJob &&
      /^(1|true|yes)$/i.test(process.env.SB_RECORD_WRITE_VIDEO ?? "")
    ) {
      try {
        videoDir = join(homedir(), ".kireidot", "sbvideo", `${job.id}`);
        mkdirSync(videoDir, { recursive: true, mode: 0o700 });
      } catch {
        videoDir = null;
      }
    }
    // 自動化指紋を隠した永続コンテキストで起動 (PC と同じステルス)。session は
    // userDataDir に永続するため storageState は使わない (蓄積で Akamai 信頼を育てる)。
    ctx = await launchStealthContext({
      launch,
      realChrome,
      shopId: job.shop_id,
      profileKey: sessionKey,
      legacyShopId: job.shop_id,
      recordVideoDir: videoDir ?? undefined,
    });
    browser = ctx.browser();
    let page = ctx.pages()[0] ?? (await ctx.newPage());
    videoPage = page;

    // ★従量課金の住宅(residential)IP利用時のみ、画像/動画/フォントの読込を遮断して
    //   帯域(GB)を節約する。DOM/データ取得には不要な要素で、SBページの転送量の大半を占める。
    //   ISP(定額)は転送量課金が無いので遮断せず、実証済みフローをそのまま使う。
    //   ※CSS(stylesheet)は Playwright の :visible 判定に影響するので遮断しない(安全側)。
    const applyResidentialBandwidthPolicy = async () => {
      if (!ctx) return;
      const residential = residentialConfig();
      const usingResidential = !!(
        residential &&
        launch.proxy?.server &&
        launch.proxy.server.includes(residential.host)
      );
      if (!usingResidential) return;
      await ctx.route("**/*", (route) => {
        const t = route.request().resourceType();
        if (t === "image" || t === "media" || t === "font") return route.abort();
        return route.continue();
      });
      console.log(`[proxy] ${tag} residential: 画像/動画/フォント遮断(GB節約)`);
    };
    await applyResidentialBandwidthPolicy();

    // 1) ログイン済み判定 → 必要時のみ tryLogin
    //    ジャンル/グループ(ADER 等の美容室・1ログイン複数サロン)で管理TOPを出し分ける。
    //    これを渡さないと groupTop(サロン一覧)有効セッションを needs_login と誤判定する。
    const wAuthGenre =
      (job as { genre?: string }).genre === "hair" ? "hair" : "esthetic";
    const wAuthSalonId =
      (job.credentials as { salon_id?: string | null }).salon_id ?? null;
    let auth = await isLoggedIn(page, baseUrl, {
      genre: wAuthGenre,
      salonId: wAuthSalonId,
    });
    if (auth === "captcha") {
      await report(
        {
          job_id: job.id,
          status: "captcha_detected",
          error: "captcha at landing",
          block: {
            until: new Date(Date.now() + 6 * 60 * 60_000).toISOString(),
            reason: "reCAPTCHA encountered before login",
          },
        },
        page,
      );
      console.log(`[job] done  ${tag} (captcha at landing)`);
      return;
    }

    if (auth !== "logged_in") {
      // 自動ログイン抑制フラグが明示設定されている場合だけ待つ。通常運用では下で
      // ログインから全工程を短い間隔で再実行する。
      if (autoLoginDisabled()) {
        await report(
          {
            job_id: job.id,
            job_type: job.job_type,
            status: "retryable_failed",
            error: `セッション未確立(auth=${auth})。自動ログイン抑制中のため再試行待ち(永続セッションの回復/再シードを待つ)。`,
          },
          page,
        );
        console.log(`[job] done  ${tag} (session not ready, auto-login disabled -> retryable)`);
        return;
      }
      const loginUrl = new URL("/login/", baseUrl).toString();
      let loginEndpoint = launch.proxy?.server ?? "direct";
      const attemptLogin = () => {
        loginEndpoint = launch.proxy?.server ?? "direct";
        return withLoginPacing(
        loginEndpoint,
        job.shop_id,
        job.credentials.login_id,
        () => tryLogin(page, loginUrl, {
          loginId: job.credentials.login_id,
          password: job.credentials.password,
        }),
      );
      };
      const isCredentialFailure = (reason: string) =>
        /invalid credentials|incorrect password|ID.?または.?パスワード|認証情報.*不正|ログインID.*不正/i.test(reason);
      let loginResult = await attemptLogin();
      // ログイン画面へ戻った/doLogin が完了しない/ネットワーク瞬断では、同じChrome・
      // 同じ出口を再利用しない。Cookie削除だけでは Akamai の接続/IP状態が残り、同じ失敗を
      // 3回繰り返していたため、各試行で browser context を完全終了し、次のstatic ISP出口へ
      // 切替えてログイン工程を最初から最大3回行う。固定待機はしない。
      for (
        let lt = 1;
        lt < 3 && loginResult.status === "failed";
        lt++
      ) {
        if (isCredentialFailure(loginResult.reason ?? "")) break;
        console.log(
          `[job] ${tag} full browser login retry ${lt + 1}/3 (${(loginResult.reason ?? "").slice(0, 70)})`
        );
        await page.context().clearCookies().catch(() => {});
        await page.evaluate(() => {
          try { localStorage.clear(); } catch { /* noop */ }
          try { sessionStorage.clear(); } catch { /* noop */ }
        }).catch(() => {});

        // persistent context は profile lock と接続プールを保持するため、必ず閉じ切ってから再起動。
        const previousContext = ctx;
        const previousBrowser = browser;
        ctx = null;
        browser = null;
        await previousContext?.close().catch(() => {});
        await previousBrowser?.close().catch(() => {});

        rotateAccountProxy(sessionKey);
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        ({ launch, realChrome } = resolveLaunchOptions(
          job.credentials.proxy,
          forceResidential,
          job.shop_id,
          avoidResidential,
          sessionKey,
        ));
        console.log(
          `[job] ${tag} retry proxy=${launch.proxy?.server ?? "direct"} channel=${launch.channel ?? "chromium"} headless=${launch.headless}`,
        );
        ctx = await launchStealthContext({
          launch,
          realChrome,
          shopId: job.shop_id,
          profileKey: sessionKey,
          legacyShopId: job.shop_id,
          recordVideoDir: videoDir ?? undefined,
        });
        browser = ctx.browser();
        page = ctx.pages()[0] ?? (await ctx.newPage());
        videoPage = page;
        await applyResidentialBandwidthPolicy();
        loginResult = await attemptLogin();
      }

      if (loginResult.status === "captcha") {
        await report(
          {
            job_id: job.id,
            status: "captcha_detected",
            error: "captcha at login",
            block: {
              until: new Date(Date.now() + 6 * 60 * 60_000).toISOString(),
              reason: "reCAPTCHA encountered during login",
            },
          },
          page,
        );
        console.log(`[job] done  ${tag} (captcha)`);
        return;
      }

      if (loginResult.status === "failed") {
        // 「ID/PW 不一致」っぽい reason は login_required。
        // ネット系/タイムアウトは retryable_failed。
        const reason = loginResult.reason ?? "login failed";
        // 明示的な「ID/パスワード不一致」だけ login_required。それ以外のログイン画面
        // 戻り/doLogin未完了は一時失敗としてジョブ全体を再試行する。
        const isAuthLike = isCredentialFailure(reason);
        if (!isAuthLike) {
          // 各試行ですでに出口を切替済み。読み取りジョブでは既存のResidential自動退避も
          // 次ジョブから有効になる。固定待機はしない。
          noteLoginThrottle(job.shop_id);
        }
        await report(
          {
            job_id: job.id,
            status: isAuthLike ? "login_required" : "retryable_failed",
            error: isAuthLike ? reason : `[CLOUD_LOGIN_RETRY_EXHAUSTED] 3回の完全再ログインに失敗: ${reason}`,
          },
          page,
        );
        console.log(
          `[job] done  ${tag} (login failed -> ${
            isAuthLike ? "login_required" : "retryable_failed"
          })`
        );
        return;
      }

      // ログイン成功時のみ storageState を保存 + スロットルcooldownを解除。
      await saveStorageState(ctx, ssPath);
      noteLoginSuccess(job.shop_id); // 自動フェイルオーバーの throttle streak をリセット
      noteEndpointLoginSuccess(loginEndpoint, job.credentials.login_id);
      auth = "logged_in";
    }

    // ★実行前に、ログイン後に被さる SB モーダル(HOT PEPPER 満足度アンケート/お知らせ等)を閉じる。
    //   裏のボタン/フォームをブロックして書込が失敗するのを防ぐ (2026-07-11 ユーザー指摘)。
    await dismissBlockingModals(page).catch(() => {});

    // 2) ジョブ実行

    // ★DOM調査用の一時ジョブ (2026-07-11): こだわり/特集/掲載プロフィールの scraper を
    //   書くために、掲載管理各ページの実DOM構造(nav/見出し/フォーム/テーブル)をダンプする。
    //   既存ログイン済みセッションを再利用し GET のみ (再ログインしない=スロットル無し)。
    //   payload.urls に調べる相対/絶対URLを渡す。結果は console("[discover] RESULT_JSON ...") に出す。
    if (job.job_type === "discover_listing") {
      const dp = job.payload as { urls?: string[] };
      const urls = Array.isArray(dp.urls) ? dp.urls : [];
      const dump: unknown[] = [];
      for (const u of urls) {
        try {
          const full = /^https?:\/\//.test(u) ? u : new URL(u, baseUrl).toString();
          await page
            .goto(full, { waitUntil: "domcontentloaded", timeout: 30_000 })
            .catch(() => {});
          await page.waitForTimeout(1500);
          const info = await page
            .evaluate(() => {
              const clip = (s: string, n: number) =>
                (s || "").replace(/\s+/g, " ").trim().slice(0, n);
              const navLinks = Array.from(document.querySelectorAll("a[href]"))
                .map((a) => ({
                  t: clip((a as HTMLElement).textContent || "", 24),
                  href: (a as HTMLAnchorElement).getAttribute("href") || "",
                }))
                .filter(
                  (x) =>
                    x.href &&
                    /(draft|set|KLP|CLP|CNK|CNB|kodawari|feature|tokushu|salon)/i.test(
                      x.href,
                    ) &&
                    x.t.length <= 20,
                )
                .slice(0, 60);
              const headings = Array.from(
                document.querySelectorAll("h1,h2,h3,th,legend,label,dt"),
              )
                .map((e) => clip(e.textContent || "", 36))
                .filter(Boolean)
                .slice(0, 80);
              const forms = Array.from(document.querySelectorAll("form"))
                .map((f) => ({
                  action: f.getAttribute("action") || "",
                  id: f.getAttribute("id") || "",
                  fields: Array.from(
                    f.querySelectorAll("input,select,textarea"),
                  )
                    .map((el) => {
                      const e = el as HTMLInputElement;
                      return `${e.tagName}:${e.name || e.id || ""}:${e.type || ""}`;
                    })
                    .slice(0, 50),
                }))
                .slice(0, 10);
              const tables = Array.from(document.querySelectorAll("table"))
                .map((t) => ({
                  head: Array.from(t.querySelectorAll("th"))
                    .map((th) => clip(th.textContent || "", 18))
                    .slice(0, 14),
                  rowCount: t.querySelectorAll("tr").length,
                  // 各行の td/th テキストを少量サンプリング (scraper 調整用)。
                  rows: Array.from(t.querySelectorAll("tr"))
                    .slice(0, 6)
                    .map((tr) =>
                      Array.from(tr.querySelectorAll("td,th"))
                        .map((c) => clip((c as HTMLElement).textContent || "", 30))
                        .filter(Boolean)
                        .join(" | ")
                        .slice(0, 200),
                    )
                    .filter(Boolean),
                }))
                .slice(0, 12);
              // 編集/掲載トグルの機構解析用: onclick を持つ要素の生ハンドラ文字列と、
              // pageId/specialId 等の hidden/text input の name+value を捕捉する。
              const clickables = Array.from(
                document.querySelectorAll(
                  "a[onclick],button[onclick],input[onclick],[onclick]",
                ),
              )
                .map((el) => {
                  const e = el as HTMLElement;
                  const oc = e.getAttribute("onclick") || "";
                  return {
                    tag: e.tagName,
                    t: clip(e.textContent || (e as HTMLInputElement).value || "", 20),
                    onclick: clip(oc, 120),
                  };
                })
                .filter(
                  (x) =>
                    /kodawari|special|tokushu|present|edit|regist|sort|pageId|delete|掲載|編集|登録/i.test(
                      x.onclick,
                    ),
                )
                .slice(0, 60);
              const idInputs = Array.from(
                document.querySelectorAll("input,select"),
              )
                .map((el) => {
                  const e = el as HTMLInputElement;
                  return { name: e.name || e.id || "", value: clip(e.value || "", 40) };
                })
                .filter((x) =>
                  /pageId|specialId|kodawari|special|Present|Flg|Id$/i.test(x.name),
                )
                .slice(0, 60);
              return {
                title: document.title,
                url: location.href,
                navLinks,
                headings,
                forms,
                tables,
                clickables,
                idInputs,
              };
            })
            .catch((e) => ({ error: String(e) }));
          dump.push({ requested: full, ...info });
        } catch (e) {
          dump.push({ requested: u, error: String(e) });
        }
      }
      // ★interactiveプローブ: スケジュール上の予約ブロックをクリックして出るポップアップ
      //   (詳細/変更/キャンセル…)のDOMを取る。クリックで出る要素は通常dumpに写らないため。
      //   payload.probe = { url, clickText, salonId?, shopName? }。
      const probe = (job.payload as { probe?: { url?: string; clickText?: string; clickSelector?: string; salonId?: string; shopName?: string; findId?: string } })?.probe;
      if (probe?.url) {
        try {
          if (probe.salonId || probe.shopName) {
            await (scrapers as unknown as { ensureSalonSelected?: (p: Page, o: unknown) => Promise<unknown> })
              .ensureSalonSelected?.(page, { salonId: probe.salonId, shopName: probe.shopName })
              .catch(() => {});
          }
          const purl = /^https?:\/\//.test(probe.url) ? probe.url : new URL(probe.url, baseUrl).toString();
          await page.goto(purl, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
          await page.waitForTimeout(1800);
          let clicked = false;
          const chain = (job.payload as { probe?: { clickChain?: string[] } })?.probe?.clickChain;
          if (Array.isArray(chain) && chain.length) {
            for (const sel of chain) {
              const loc = page.locator(sel).first();
              if ((await loc.count().catch(() => 0)) > 0) {
                await loc.click({ timeout: 8_000 }).catch(() => {});
                clicked = true;
                await page.waitForTimeout(2000);
              }
            }
          } else if (probe.clickSelector) {
            const loc = page.locator(probe.clickSelector).first();
            if ((await loc.count().catch(() => 0)) > 0) {
              await loc.click({ timeout: 8_000 }).catch(() => {});
              clicked = true;
              await page.waitForTimeout(1600);
            }
          } else if (probe.clickText) {
            const loc = page.locator(`text=${probe.clickText}`).first();
            if ((await loc.count().catch(() => 0)) > 0) {
              await loc.click({ timeout: 8_000 }).catch(() => {});
              clicked = true;
              await page.waitForTimeout(1500);
            }
          }
          const popup = await page
            .evaluate((needle: string) => {
              const clip = (s: string, n: number) => (s || "").replace(/\s+/g, " ").trim().slice(0, n);
              // ポップアップ(.mod_popup_02:visible)の全文 + reserveId/booking_id の在処。
              const pops = Array.from(document.querySelectorAll(".mod_popup_02")).filter(
                (el) => (el as HTMLElement).offsetParent !== null,
              );
              const popupText = pops.map((el) => clip((el as HTMLElement).innerText || "", 1200)).join(" || ");
              const popupHtml = pops.map((el) => (el as HTMLElement).innerHTML || "").join("");
              const needleInPopupHtml = needle ? popupHtml.includes(needle) : false;
              const needleInPopupText = needle ? popupText.includes(needle) : false;
              // ページ本文(確認文言) + フォーム(action/submit) を捕捉。
              const pageText = clip((document.body && document.body.innerText) || "", 900);
              const forms = Array.from(document.querySelectorAll("form")).map((f) => ({
                id: f.getAttribute("id") || "",
                action: f.getAttribute("action") || "",
                submits: Array.from(f.querySelectorAll('input[type="submit"],button[type="submit"],a[onclick*="submit"],a.jsc'))
                  .map((s) => `${(s as HTMLElement).tagName}:${(s as HTMLElement).id || ""}:${clip((s as HTMLElement).textContent || (s as HTMLInputElement).value || "", 20)}`)
                  .slice(0, 12),
              })).slice(0, 8);
              const btns = Array.from(document.querySelectorAll("a,button,input,[onclick]"))
                .map((el) => {
                  const e = el as HTMLInputElement;
                  return {
                    tag: e.tagName,
                    id: e.id || "",
                    cls: clip(e.className || "", 50),
                    t: clip(e.textContent || e.value || "", 24),
                    onclick: clip(e.getAttribute("onclick") || "", 140),
                    href: clip(e.getAttribute("href") || "", 140),
                  };
                })
                .filter((x) => (x.t && x.t.length > 0) || /btn|submit|Button|jsi|fnc_/i.test(x.id + x.cls + x.tag))
                .slice(0, 90);
              return { url: location.href, title: document.title, btns, popupText, needleInPopupHtml, needleInPopupText, pageText, forms };
            }, probe.findId || "")
            .catch((e) => ({ error: String(e) }));
          // findId: 予約ブロックが reserveId をどう埋めているか(onclick/data/id/href)を探す。
          let idHits: unknown = null;
          const fid = probe.findId;
          if (fid) {
            idHits = await page
              .evaluate((needle: string) => {
                const clip = (s: string, n: number) => (s || "").replace(/\s+/g, " ").trim().slice(0, n);
                const out: Array<Record<string, string>> = [];
                for (const el of Array.from(document.querySelectorAll("*"))) {
                  const e = el as HTMLElement;
                  const oc = e.getAttribute("onclick") || "";
                  const attrs = Array.from(e.attributes || []).map((a) => `${a.name}=${a.value}`).join(" ");
                  if ((oc + " " + attrs).includes(needle)) {
                    out.push({
                      tag: e.tagName,
                      id: e.id || "",
                      cls: clip(e.className || "", 60),
                      t: clip(e.textContent || "", 30),
                      onclick: clip(oc, 160),
                      attrs: clip(attrs, 200),
                    });
                  }
                }
                return out.slice(0, 20);
              }, fid)
              .catch((e) => ({ error: String(e) }));
          }
          dump.push({ probe: true, clicked, ...popup, findId: fid ?? null, idHits });
        } catch (e) {
          dump.push({ probe: true, error: String(e) });
        }
      }
      console.log("[discover] RESULT_JSON " + JSON.stringify(dump));
      await report(
        {
          job_id: job.id,
          job_type: "discover_listing",
          status: "succeeded",
          summary: `discover: ${urls.length} pages dumped`,
        } as unknown as CallbackBody,
        page,
      );
      return;
    }

    if (job.job_type === "push_blog") {
      // worker.ts 独自 pushBlog は誤った blog index URL(/KLP/blog/, /CNF/blog/, /blog/)を叩き
      // 'blog index not reachable' で失敗していた(実機 2026-06-28)。正しい URL(/KLP/blog/blog/)を
      // 持つ scrapers.postBlogViaForm(proven 実装)に委譲する。
      const p = job.payload as Record<string, unknown>;
      const result = await (
        scrapers as unknown as {
          postBlogViaForm: (
            pg: Page,
            pl: Record<string, unknown>,
            o: { baseUrl: string; enablePost: boolean; salonId: string | null; shopName: string | null },
          ) => Promise<ScraperResult>;
        }
      ).postBlogViaForm(page, p, {
        baseUrl,
        enablePost: ENABLE_PUSH,
        salonId: (job.credentials as { salon_id?: string | null }).salon_id ?? null,
        shopName: (job as { shop_name?: string | null }).shop_name ?? null,
      });
      await reportScraperResult(
        job,
        "push_blog",
        result,
        {
          content_post_id: p.content_post_id ?? null,
          ...(result.status === "ok"
            ? { external_id: result.externalId ?? null }
            : {}),
        },
        page,
      );
      return;
    }

    if (job.job_type === "push_booking") {
      const payload = job.payload as PushBookingPayload;
      // KIREIDOT の休憩・業務枠は SalonBoard の「予約」ではなく「予定」。
      // 通常予約フォームへ送ると設備行が自動追加され、設備を使わない予定でも
      // 「× フリー設備」等を選択して誤って EQUIPMENT_FULL になる。
      // PC worker と同じ proven 予定登録フローへ Cloud でも分岐する。
      const isBlockSchedule = payload.booking_type === "block";
      // action=update かつ reserveId 有り → 予約変更フロー(changeBookingViaForm)を使う。
      // これが無いと update でも新規登録フォームを叩き "新規予約の登録" として扱われ、
      // 重複/容量超過で失敗する (実機検証 2026-06-28: YG81931151 の 16:00→15:00 が失敗)。
      // 変更では reserveId(YG...) は不変なので、ok 時は payload の値を保持して callback に渡す。
      const isBookingUpdate =
        (payload as { action?: string }).action === "update" &&
        String(payload.external_booking_id ?? "").trim().length > 0;
      let result: PushBookingResult;
      if (isBlockSchedule && isBookingUpdate) {
        result = await scrapers.changeScheduleViaForm(page, payload, {
          baseUrl,
          enableChange: ENABLE_PUSH,
        }) as PushBookingResult;
      } else if (isBlockSchedule) {
        result = await scrapers.pushScheduleViaForm(page, payload, {
          baseUrl,
          enablePush: ENABLE_PUSH,
        }) as PushBookingResult;
      } else if (isBookingUpdate) {
        // ジャンル/グループ対応 (登録と同じ): hair=/CLP/bt 配下 + サロン選択 + 失効時relogin。
        const chGenre =
          (job as { genre?: string }).genre === "hair" ? "hair" : "esthetic";
        const chSalonId =
          (job.credentials as { salon_id?: string | null }).salon_id ?? null;
        const chShopName = (job as { shop_name?: string | null }).shop_name ?? null;
        const cr = await (
          scrapers as unknown as {
            changeBookingViaForm: (
              pg: Page,
              pl: PushBookingPayload,
              opts: {
                baseUrl: string;
                enableChange: boolean;
                genre: string;
                salonId: string | null;
                shopName: string | null;
                relogin?: () => Promise<boolean>;
              },
            ) => Promise<PushBookingResult>;
          }
        ).changeBookingViaForm(page, payload, {
          baseUrl,
          enableChange: ENABLE_PUSH,
          genre: chGenre,
          salonId: chSalonId,
          shopName: chShopName,
          relogin: makeRelogin(page, baseUrl, job.credentials, job.shop_id, launch.proxy?.server ?? "direct"),
        });
        if (cr.status === "ok") {
          cr.externalId = payload.external_booking_id ?? null;
          const chRoot = chGenre === "hair" ? "/CLP/bt" : "/KLP";
          const detailKind = /^(BF|BE)/i.test(String(payload.external_booking_id ?? ""))
            ? "net/reserveDetail"
            : "ext/extReserveDetail";
          cr.detailUrl = `${new URL(baseUrl).origin}${chRoot}/reserve/${detailKind}/?reserveId=${payload.external_booking_id}`;
          cr.alreadyExists = false;
        }
        result = cr;
      } else {
        // Cloud -> PC fallback / 同一ジョブ内リトライでは、Admin 側の payload に
        // preflight_required が付かなかった場合でも必ず既存予約を照合する。
        // Cloud が登録完了レスポンスを受け取る前に切断されたケースで、PC が同じ予約を
        // 新規登録して二重予約にする事故を Worker 側でも防ぐ。
        const mustPreflight =
          payload.preflight_required === true ||
          job.executor === "playwright" ||
          job.attempts > 1 ||
          typeof (payload as { reason?: unknown }).reason === "string";
        const safePayload: PushBookingPayload = mustPreflight
          ? { ...payload, preflight_required: true }
          : payload;
        result = await pushBookingViaProvenForm(
          page,
          job,
          safePayload,
          launch.proxy?.server ?? "direct",
        );
      }

      if (result.status === "ok") {
        await report({
          job_id: job.id,
          job_type: "push_booking",
          status: "succeeded",
          booking_id: payload.booking_id,
          external_booking_id: result.externalId ?? null,
          salonboard_detail_url: result.detailUrl ?? null,
          already_exists: result.alreadyExists ?? false,
          result_payload: result.confirmed,
          summary: result.alreadyExists
            ? "push_booking: 既存予約を検出 (already_exists)"
            : isBlockSchedule
              ? "push_booking: 予定登録完了"
            : `push_booking 登録完了 (external_id=${result.externalId ?? "?"})`,
        });
        console.log(
          `[job] done  ${tag} (push_booking ok${
            result.alreadyExists ? " already_exists" : ""
          })`,
        );
      } else if (result.status === "confirm_only") {
        // 確認画面まで照合 OK。ENABLE_PUSH=false のため登録せず手動確認に回す。
        await report(
          {
            job_id: job.id,
            job_type: "push_booking",
            status: "manual_required",
            booking_id: payload.booking_id,
            error_code: "PUSH_DISABLED",
            error:
              "確認画面の照合まで成功しましたが、自動登録が無効 (SALONBOARD_ENABLE_PUSH=未設定) のため登録していません。SalonBoard で内容を確認のうえ手動登録してください。",
            manual_required: true,
            result_payload: result.confirmed,
          },
          page,
        );
        console.log(`[job] done  ${tag} (push_booking confirm_only -> manual_required)`);
      } else {
        // failed: manualRequired によって failed / manual_required を切り替える。
        // 自動リトライ上限を超えていれば強制的に manual_required。
        // 上限はジョブ側の max_attempts を正とし、未指定時のみ既定値を使う。
        const cap = job.max_attempts || MAX_PUSH_ATTEMPTS;
        const exhausted = job.attempts >= cap;
        // 一過性インフラ失敗(500着地/doComplete未確定)は上限超過でも manual に昇格させず
        // retryable のまま維持する(Akamai 回復後の自動再投入に委ねる)。実枠競合(SLOT_NOT_AVAILABLE)
        // や確認画面不一致等の「実データ/セレクタ起因」は従来どおり上限超過で manual に倒す。
        const infraTransient = isInfraTransientError(result.errorCode);
        const toManual = result.manualRequired || (exhausted && !infraTransient);
        const isCaptcha = result.errorCode === "RECAPTCHA_REQUIRED";
        await report(
          {
            job_id: job.id,
            job_type: "push_booking",
            status: isCaptcha
              ? "captcha_detected"
              : toManual
                ? "manual_required"
                : // 上限未満、または一過性インフラ失敗(SB_SERVER_ERROR/SB_REGISTER_INCOMPLETE)は
                  // retryable_failed のまま維持し、Akamai/500 回復後の自動再投入に委ねる。
                  "retryable_failed",
            booking_id: payload.booking_id,
            error_code: result.errorCode,
            error: result.reason,
            manual_required: toManual,
            error_capture_b64: (result as { errorCaptureB64?: string })
              .errorCaptureB64,
            ...(isCaptcha
              ? {
                  block: {
                    until: new Date(Date.now() + 6 * 60 * 60_000).toISOString(),
                    reason: "reCAPTCHA during push_booking",
                  },
                }
              : {}),
          },
          page,
        );
        console.log(
          `[job] done  ${tag} (push_booking ${result.errorCode}: ${result.reason})`,
        );
      }
      return;
    }

    // ---- Phase 2: scrapers.cjs 再利用ハンドラ群 ----------------------------
    // salon_id は Admin の jobs API が credentials に同梱する(reveal RPC が
    // salonboard_credentials.salonboard_salon_id を salon_id として返す)。
    // グループ店(1ログイン複数サロン)は ensureSalonSelected が groupTop の
    // <a id="H..."> を salon_id で一致検索してDOMクリック→遷移する。未設定時のみ店名一致に
    // フォールバック(SuperAdminでサロンID必須化済=通常は常に埋まる)。
    const salonId = (job.credentials as { salon_id?: string | null }).salon_id ?? null;
    const shopName = (job as { shop_name?: string | null }).shop_name ?? null;
    // reserveId reconcile の scrapeBookings 用 (hair/esthetic で一覧構造が違う)。
    const genre = (job as { genre?: string }).genre === "hair" ? "hair" : "esthetic";

    if (job.job_type === "cancel_booking") {
      const p = job.payload as Record<string, unknown>;
      // 休憩・業務 (booking_type='block') は SalonBoard 上「予定」なので
      // 予約キャンセルではなくスケジュール画面から予定を削除する。
      const result =
        p.booking_type === "block"
          ? await scrapers.deleteScheduleViaForm(page, p, {
              baseUrl,
              enableDelete: ENABLE_PUSH,
            })
          : await scrapers.cancelBookingViaForm(page, p, {
              baseUrl,
              enableCancel: ENABLE_PUSH,
              salonId,
              shopName,
              genre,
              // 失効時の同一ジョブ内自己回復。
              relogin: makeRelogin(page, baseUrl, job.credentials, job.shop_id, launch.proxy?.server ?? "direct"),
            });
      await reportScraperResult(
        job,
        "cancel_booking",
        result,
        {
          booking_id: p.booking_id ?? null,
        },
        page,
      );
      return;
    }

    if (job.job_type === "push_shifts") {
      // 注: PC 版は読み取った勤務パターンを Supabase に直接保存するが、クラウドは
      // Admin callback のみ。push_shifts は status 報告で足りるため、パターン保存は
      // fetch_shift_patterns 側に委ねる (ここではスキップ)。
      const result = await scrapers.pushShiftsViaForm(page, job.payload, {
        baseUrl,
        enablePush: ENABLE_PUSH,
        // ★genre/salonId を渡す。美容室(hair)はシフト設定が /CLP/bt/set 配下 + サロン選択必須で、
        //   従来は /KLP 固定だったため ADER/マグ等 hair 店が全て「毎月の受付設定」未到達で失敗していた。
        genre,
        salonId,
        shopName,
        relogin: makeRelogin(page, baseUrl, job.credentials, job.shop_id, launch.proxy?.server ?? "direct"),
      });
      await reportScraperResult(job, "push_shifts", result, {}, page);
      return;
    }

    if (job.job_type === "fetch_shifts") {
      // pushと同じhair/esthetic対応の月次シフト画面ナビゲーションをread-onlyで使う。
      const result = await scrapers.pushShiftsViaForm(page, job.payload, {
        baseUrl,
        enablePush: false,
        genre,
        salonId,
        shopName,
        relogin: makeRelogin(page, baseUrl, job.credentials, job.shop_id, launch.proxy?.server ?? "direct"),
      }) as { status?: string; shifts?: unknown[]; reason?: string; errorCode?: string };
      if (result.status === "ok" && Array.isArray(result.shifts)) {
        await report({
          job_id: job.id,
          job_type: "fetch_shifts",
          status: "succeeded",
          shifts: result.shifts,
          summary: `fetch_shifts: ${result.shifts.length}件取得`,
        } as unknown as CallbackBody);
        console.log(`[job] done  ${tag} (fetch_shifts ${result.shifts.length}件)`);
      } else {
        await report({
          job_id: job.id,
          job_type: "fetch_shifts",
          status: "retryable_failed",
          error_code: result.errorCode ?? "UNKNOWN_ERROR",
          error: result.reason ?? "fetch_shifts failed",
        } as unknown as CallbackBody, page);
        console.log(`[job] done  ${tag} (fetch_shifts failed: ${result.reason ?? "unknown"})`);
      }
      return;
    }

    if (job.job_type === "push_photo_gallery") {
      const result = await scrapers.postPhotoGalleryViaForm(page, job.payload, {
        baseUrl,
        enablePost: ENABLE_PUSH,
        salonId,
        shopName,
      });
      await reportScraperResult(job, "push_photo_gallery", result, {}, page);
      return;
    }

    if (job.job_type === "delete_blog") {
      const p = job.payload as Record<string, unknown>;
      const result = await scrapers.deleteBlogViaForm(page, p, {
        baseUrl,
        enableDelete: ENABLE_PUSH,
      });
      await reportScraperResult(
        job,
        "delete_blog",
        result,
        {
          content_post_id: p.content_post_id ?? null,
          // external_id は ok 時のみ。confirm_only/failed で送ると Admin が
          // 早期に削除済みと誤判定しうる (PC worker-process.cjs と同じ)。
          ...(result.status === "ok"
            ? { external_id: result.externalId ?? p.external_blog_id ?? null }
            : {}),
        },
        page,
      );
      return;
    }

    if (job.job_type === "push_review_reply") {
      const p = job.payload as Record<string, unknown>;
      const result = await scrapers.postReviewReplyViaForm(page, p, {
        baseUrl,
        enablePost: ENABLE_PUSH,
      });
      await reportScraperResult(
        job,
        "push_review_reply",
        result,
        {
          review_import_id: p.review_import_id ?? null,
        },
        page,
      );
      return;
    }

    // 受付可能数(残り受付数)の手動オーバーライドを SB スケジュールへ同期 (美容室のみ)。
    // payload={date:'YYYY-MM-DD', slots:[{slot_min,delta}], dry_run?}。冪等: 戻す→+/-→設定。
    if (job.job_type === "push_acceptance") {
      const p = job.payload as Record<string, unknown>;
      const aGenre =
        (job as { genre?: string }).genre === "hair" ? "hair" : "esthetic";
      const aSalonId =
        (job.credentials as { salon_id?: string | null }).salon_id ?? null;
      const aShopName = (job as { shop_name?: string | null }).shop_name ?? null;
      // Akamai warmup (fetch_bookings と同じ): cold profile が深いページで tarpit → SESSION_EXPIRED を防ぐ。
      try {
        const warmupPath = aSalonId ? "/CNC/groupTop/" : "/KLP/top/";
        await page.goto(new URL(warmupPath, baseUrl).toString(), { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
        await page.waitForTimeout(2200);
        await page.mouse.move(240, 220).catch(() => {});
        await page.mouse.move(620, 430, { steps: 12 }).catch(() => {});
        await page.mouse.wheel(0, 600).catch(() => {});
        await page.waitForTimeout(1400);
      } catch {
        /* warmup best-effort */
      }
      const result = await (scrapers as unknown as Record<string, ScraperFn>).pushAcceptanceViaSchedule(page, p, {
        baseUrl,
        enablePush: ENABLE_PUSH,
        genre: aGenre,
        salonId: aSalonId,
        shopName: aShopName,
        relogin: makeRelogin(page, baseUrl, job.credentials, job.shop_id, launch.proxy?.server ?? "direct"),
      });
      await reportScraperResult(job, "push_acceptance", result, {}, page);
      return;
    }

    // 設定系 write (KIREIDOT→SB): 設備/スタッフ/メニュー/クーポン/勤務パターンの編集フォームへ書き込む。
    if (
      job.job_type === "push_equipment" ||
      job.job_type === "push_staff" ||
      job.job_type === "push_menu" ||
      job.job_type === "push_coupon" ||
      job.job_type === "push_shift_patterns" ||
      job.job_type === "push_salon" ||
      job.job_type === "push_kodawari" ||
      job.job_type === "push_feature"
    ) {
      const p = job.payload as Record<string, unknown>;
      const wGenre =
        (job as { genre?: string }).genre === "hair" ? "hair" : "esthetic";
      // 掲載系(サロン/こだわり/特集)はグループ店でサロン選択が要るため salonId/shopName を渡す。
      const wSalonId =
        (job.credentials as { salon_id?: string | null }).salon_id ?? null;
      const wShopName = (job as { shop_name?: string | null }).shop_name ?? null;
      // push_staff: プロフィール欄(名前/フリガナ/キャッチ/自己紹介/職種/性別/指名)を含むなら
      // staffEdit(全プロフィール)へ、そうでなければ staffList(並び順/掲載) へルーティング。
      const hasStaffProfile =
        job.job_type === "push_staff" &&
        !!(p.name || p.furigana || p.kana || p.catch_copy || p.catch ||
          p.bio || p.self_intro || p.role || p.job_type || p.gender || p.nomination);
      const fnMap = {
        push_equipment: scrapers.pushEquipmentViaForm,
        push_staff: hasStaffProfile
          ? scrapers.pushStaffProfileViaForm
          : scrapers.pushStaffViaForm,
        push_menu: scrapers.pushMenuViaForm,
        push_coupon: scrapers.pushCouponViaForm,
        push_shift_patterns: scrapers.pushWorkPatternViaForm,
        push_salon: (scrapers as unknown as Record<string, ScraperFn>).pushSalonProfileViaForm,
        push_kodawari: (scrapers as unknown as Record<string, ScraperFn>).pushKodawariViaForm,
        push_feature: (scrapers as unknown as Record<string, ScraperFn>).pushFeatureViaForm,
      } as const;
      let result: any;
      try {
        result = await fnMap[job.job_type](page, p, {
          baseUrl,
          enablePush: ENABLE_PUSH,
          genre: wGenre,
          salonId: wSalonId,
          shopName: wShopName,
        });
      } catch (e) {
        // OpenClaw 自己修復フォールバック: 固定セレクタがHTML変化で壊れた時、Claudeに
        // 画面(screenshot+a11y)を見せてタスクを自律実行させる。ANTHROPIC_API_KEY 設定時のみ
        // 作動し、未設定なら従来通り throw する(完全休眠=安全)。
        const msg = String((e as any)?.message ?? e);
        if (
          process.env.ANTHROPIC_API_KEY &&
          /selector|locator|timeout|not found|element|visible|frame|click/i.test(msg)
        ) {
          const { selfHealTask } = require("./selfHeal.cjs");
          const taskMap: Record<string, string> = {
            push_equipment: `設備「${String(p.equipment_name ?? p.name ?? p.external_id ?? "")}」の受付可能数/並び順を編集フォームで更新し登録する`,
            push_staff: `スタッフ「${String(p.name ?? p.staff_name ?? p.external_id ?? "")}」の情報を編集フォームで更新し登録する`,
            push_menu: `メニュー「${String(p.menu_name ?? p.name ?? p.external_id ?? "")}」を編集フォームで更新し登録する`,
            push_coupon: `クーポン「${String(p.coupon_name ?? p.name ?? p.external_id ?? "")}」を編集フォームで更新し登録する`,
            push_shift_patterns: `勤務パターンを編集フォームで登録する`,
          };
          console.log(`[openclaw] ${job.job_type} 自己修復フォールバック起動 (${msg.slice(0, 80)})`);
          const heal = await selfHealTask(page, {
            task: taskMap[job.job_type] ?? String(job.job_type),
            apiKey: process.env.ANTHROPIC_API_KEY,
          });
          result = heal.success
            ? { status: "ok", summary: `OpenClaw自己修復で完了 (${heal.steps}手): ${heal.note ?? ""}`.slice(0, 160) }
            : { status: "error", error: `OpenClaw自己修復失敗: ${heal.reason ?? "?"}` };
        } else {
          throw e;
        }
      }
      await reportScraperResult(
        job,
        job.job_type,
        result,
        {
          external_id: p.external_id ?? null,
        },
        page,
      );
      return;
    }

    if (job.job_type === "fetch_bookings") {
      // genre / shop_name は Admin がジョブ top-level に同梱済み (jobs/route.ts)。
      // 'hair' は専用フロー、それ以外は 'esthetic' に正規化 (Admin 側と同じ)。
      const genre =
        (job as { genre?: string }).genre === "hair" ? "hair" : "esthetic";
      // Akamai 深層ページ対策ウォームアップ: クラウドのフレッシュプロファイルは
      // ログイン後の深い認証ページ (予約一覧等) で tarpit される。直接 deep URL へ
      // 飛ぶ前に管理 TOP を読み込み + 人間らしいマウス/スクロール/待機で Akamai
      // センサーにテレメトリを送り、_abck の信頼を立ててから scrape に入る。
      try {
        // グループ/hair アカウント(salonId有り)は /KLP/top/ が無効パスで SESSION_EXPIRED に
        // なり、後続のサロン入場(/CLP/bt/top/)まで壊す(実機 2026-06-28: ADER鯖江)。
        // warmup 先を group は /CNC/groupTop/ に出し分ける(Akamaiトラスト構築は同様に効く)。
        const warmupPath = salonId ? "/CNC/groupTop/" : "/KLP/top/";
        await page
          .goto(new URL(warmupPath, baseUrl).toString(), {
            waitUntil: "domcontentloaded",
            timeout: 30_000,
          })
          .catch(() => {});
        await page.waitForTimeout(2500);
        await page.mouse.move(240, 220).catch(() => {});
        await page.mouse.move(640, 440, { steps: 12 }).catch(() => {});
        await page.mouse.wheel(0, 700).catch(() => {});
        await page.waitForTimeout(1800);
        await page.mouse.wheel(0, -300).catch(() => {});
        await page.waitForTimeout(1200);
        // ログイン直後のセッション有効性を判定 (深いページで session 切れになる原因の切り分け)。
        const topState = await page
          .evaluate(() => {
            const txt =
              document.body && document.body.innerText
                ? document.body.innerText
                : "";
            if (/予約管理|掲載管理/.test(txt)) return "LOGGED_IN";
            if (/有効期限|再度ログイン|操作されなかった/.test(txt.replace(/\s+/g, "")))
              return "SESSION_EXPIRED";
            return "UNKNOWN(" + (document.title || "").slice(0, 30) + ")";
          })
          .catch(() => "?");
        console.log(`[scrape] warmup ${warmupPath} state=${topState} url=${page.url()}`);
      } catch {
        /* warmup is best-effort */
      }
      // ★preemption: このfetch用 AbortController を登録。予約書込が来たら preemptFetchesForWrites が abort。
      const _fetchAc = new AbortController();
      _fetchAbort.set(job.id, {
        shopId: (job as { shop_id: string }).shop_id,
        controller: _fetchAc,
        page: page as unknown as { close: () => Promise<void> },
      });
      let rows: unknown[];
      let debug: unknown;
      let acceptance: unknown[] | undefined;
      try {
        // loginId/password は debug capture の PII マスク用に渡す (PC と同じ)。
        ({ rows, debug, acceptance } = (await scrapers.scrapeBookings(page, {
          baseUrl,
          genre,
          salonId,
          shopName,
          loginId: job.credentials.login_id,
          password: job.credentials.password,
          // 失効時の同一ジョブ内自己回復 (hair warmup 等で expired を踏んだら1回だけ再ログイン)。
          relogin: makeRelogin(page, baseUrl, job.credentials, job.shop_id, launch.proxy?.server ?? "direct"),
          abortSignal: _fetchAc.signal,
        })) as { rows: unknown[]; debug?: unknown; acceptance?: unknown[] });
      } catch (e) {
        if (
          _fetchAc.signal.aborted ||
          /aborted|preempt|target closed|has been closed|closed/i.test(
            String((e as { message?: string })?.message ?? e),
          )
        ) {
          // 予約書込にレーンを譲るため fetch を中断。requeue して次回取得に回す。
          await report({
            job_id: job.id,
            job_type: "fetch_bookings",
            status: "retryable_failed",
            error: "preempted by booking write (requeue)",
          } as unknown as CallbackBody);
          console.log(`[job] done  ${tag} (fetch_bookings preempted -> requeue)`);
          return;
        }
        throw e;
      } finally {
        _fetchAbort.delete(job.id);
      }
      // hair フローはログアウトを throw せず debug.loggedOut で返すことがある。
      // succeeded(0件) にすると同期がサイレントに消えるので retryable に倒す。
      if ((debug as { loggedOut?: boolean } | undefined)?.loggedOut) {
        await report(
          {
            job_id: job.id,
            job_type: "fetch_bookings",
            status: "retryable_failed",
            error: `session lost during bookings scrape (landedOn=${
              (debug as { landedOn?: string })?.landedOn ?? "?"
            })`,
          } as unknown as CallbackBody,
          page,
        );
        console.log(`[job] done  ${tag} (fetch_bookings session lost -> retryable)`);
        return;
      }
      const bookings = rows ?? [];
      // Admin callback (job_type=fetch_bookings) が bookings[] を
      // salonboard_bulk_upsert_bookings RPC で upsert する。PC の定期ループと同 RPC。
      const acceptanceRows = Array.isArray(acceptance) ? acceptance : [];
      await report({
        job_id: job.id,
        job_type: "fetch_bookings",
        status: "succeeded",
        bookings,
        // SB「残り受付可能数」スナップショット (表示用)。Admin callback が対応時に取込む。
        acceptance: acceptanceRows,
        summary: `fetch_bookings: ${bookings.length}件取得 (genre=${genre})${acceptanceRows.length ? ` / 受付可能数${acceptanceRows.length}枠` : ""}`,
      } as unknown as CallbackBody);
      console.log(`[job] done  ${tag} (fetch_bookings ${bookings.length}件, 受付可能数${acceptanceRows.length}枠)`);
      return;
    }

    if (job.job_type === "fetch_shift_patterns") {
      // patterns を callback に載せ、Admin 側で既存 RPC salonboard_bulk_upsert_shift_patterns
      // に渡す (PC は supabase 直呼びだが、クラウドは Admin callback 経由)。
      // scrapeShiftPatterns は取得不可時に code 付きで throw する (空配列は返さない)。
      // SHIFT_PATTERNS_NONE/PARSE は再試行しても直らないので manual_required に倒す
      // (PC worker-process.cjs と同じ分類)。
      try {
        const res = await scrapers.scrapeShiftPatterns(page, baseUrl, {
          genre: (job as { genre?: string }).genre === "hair" ? "hair" : "esthetic",
          salonId: (job.credentials as { salon_id?: string | null }).salon_id ?? null,
          shopName: (job as { shop_name?: string | null }).shop_name ?? null,
          relogin: makeRelogin(
            page,
            baseUrl,
            job.credentials,
            job.shop_id,
            launch.proxy?.server ?? "direct",
          ),
        });
        const patterns = (res?.patterns ?? []) as unknown[];
        await report({
          job_id: job.id,
          job_type: "fetch_shift_patterns",
          status: "succeeded",
          shift_patterns: patterns,
          summary: `fetch_shift_patterns: ${patterns.length}件取得`,
        } as unknown as CallbackBody);
        console.log(`[job] done  ${tag} (fetch_shift_patterns ${patterns.length}件)`);
      } catch (e) {
        const err = e as { code?: string; message?: string };
        const code = err?.code ?? "UNKNOWN_ERROR";
        const cap = job.max_attempts || MAX_PUSH_ATTEMPTS;
        const exhausted = job.attempts >= cap;
        const isCaptcha = code === "RECAPTCHA_REQUIRED";
        const noRetry =
          isCaptcha ||
          code === "SHIFT_PATTERNS_NONE" ||
          code === "SHIFT_PATTERNS_PARSE" ||
          code === "SHIFT_PATTERNS_EMPTY" ||
          exhausted;
        await report(
          {
            job_id: job.id,
            job_type: "fetch_shift_patterns",
            status: isCaptcha
              ? "captcha_detected"
              : noRetry
                ? "manual_required"
                : "retryable_failed",
            error_code: code,
            error: String(err?.message ?? e).slice(0, 500),
            manual_required: noRetry,
          } as unknown as CallbackBody,
          page,
        );
        console.log(`[job] done  ${tag} (fetch_shift_patterns ${code})`);
      }
      return;
    }

    // fetch_staff / fetch_menu(s) / fetch_coupon(s) / fetch_equipment / fetch_reviews:
    // 設定系(スタッフ/メニュー/設備/クーポン/口コミ)を scrape し、Admin callback 経由で
    // 既存 RPC salonboard_bulk_upsert_* に取込ませる。従来 PC が in-process scrape で
    // staging(salonboard_*_imports)を埋めていた処理を job 化し、クラウド完結(PC引退)させる。
    {
      const FETCH_MAP: Record<string, { fn: string; key: string }> = {
        fetch_staff: { fn: "scrapeStaff", key: "staff" },
        fetch_menu: { fn: "scrapeMenus", key: "menus" },
        fetch_menus: { fn: "scrapeMenus", key: "menus" },
        fetch_coupon: { fn: "scrapeCoupons", key: "coupons" },
        fetch_coupons: { fn: "scrapeCoupons", key: "coupons" },
        fetch_equipment: { fn: "scrapeEquipment", key: "equipment" },
        fetch_reviews: { fn: "scrapeReviews", key: "reviews" },
        fetch_blog: { fn: "scrapeBlogs", key: "blogs" },
        fetch_photo_gallery: {
          fn: "scrapePhotoGallery",
          key: "photo_galleries",
        },
        fetch_salon: { fn: "scrapeSalonInfo", key: "salon" },
        fetch_kodawari: { fn: "scrapeKodawari", key: "kodawari" },
        fetch_feature: { fn: "scrapeFeature", key: "feature" },
      };
      const m = FETCH_MAP[job.job_type];
      if (m) {
        const genre =
          (job as { genre?: string }).genre === "hair" ? "hair" : "esthetic";
        // グループ店舗(1ログイン複数サロン)は、設定系ページを読む前に groupTop で
        // 対象サロンを選ぶ必要がある。salonId/shopName を渡さないと ensureSalonSelected
        // が選択できず、空/別サロンの一覧を読んで 0 件になる (ADER 郡山のスタイリスト
        // 取得が 0 件だった真因)。fetch_bookings と同じ値をここでも渡す。
        const salonId =
          (job.credentials as { salon_id?: string | null }).salon_id ?? null;
        const shopName = (job as { shop_name?: string | null }).shop_name ?? null;
        try {
          const sx = scrapers as unknown as Record<
            string,
            (
              pg: Page,
              o: Record<string, unknown>,
            ) => Promise<{ rows?: unknown[] }>
          >;
          const res = await sx[m.fn](page, {
            baseUrl,
            genre,
            salonId,
            shopName,
            loginId: job.credentials.login_id,
            password: job.credentials.password,
          });
          const rows = (res?.rows ?? []) as unknown[];
          await report({
            job_id: job.id,
            job_type: job.job_type,
            status: "succeeded",
            [m.key]: rows,
            summary: `${job.job_type}: ${rows.length}件取得`,
          } as unknown as CallbackBody);
          console.log(`[job] done  ${tag} (${job.job_type} ${rows.length}件)`);
        } catch (e) {
          const err = e as { code?: string; message?: string };
          const code = err?.code ?? "UNKNOWN_ERROR";
          const cap = job.max_attempts || MAX_PUSH_ATTEMPTS;
          const exhausted = job.attempts >= cap;
          const isCaptcha = code === "RECAPTCHA_REQUIRED";
          const noRetry = isCaptcha || exhausted;
          await report(
            {
              job_id: job.id,
              job_type: job.job_type,
              status: isCaptcha
                ? "captcha_detected"
                : noRetry
                  ? "manual_required"
                  : "retryable_failed",
              error_code: code,
              error: String(err?.message ?? e).slice(0, 500),
              manual_required: noRetry,
            } as unknown as CallbackBody,
            page,
          );
          console.log(`[job] done  ${tag} (${job.job_type} ${code})`);
        }
        return;
      }
    }

    // 未実装ジョブ: succeeded ではなく not_implemented
    // (残: fetch_sales = scrapers.cjs に scraper 未実装のためスキップ。PC にも無い)
    await report(
      {
        job_id: job.id,
        status: "not_implemented",
        error: `${job.job_type} scraper not implemented`,
        summary: `${job.job_type} not implemented (login ok)`,
      },
      page,
    );
    console.log(`[job] done  ${tag} (not_implemented)`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[job] error ${tag}: ${msg}`);
    // page はこの try スコープ内で宣言されるため catch では参照不可。失敗ショットは
    // 各ハンドラ内の report(..., page) で per-page 添付済み。ここは最終防衛のグローバル。
    await report({ job_id: job.id, status: "retryable_failed", error: msg });
  } finally {
    // 録画動画のパスは close 後に確定する。close 前に Video 参照を掴んでおく。
    const vid =
      videoDir && videoPage
        ? (videoPage as { video?: () => { path: () => Promise<string> } | null }).video?.()
        : null;
    // ctx.close() で録画 webm が確定する。close 後に読み出す。
    await ctx?.close().catch(() => {});
    await browser?.close().catch(() => {});
    if (videoDir) {
      try {
        const failed = videoPage
          ? _pageWriteFailed.get(videoPage as object) === true
          : false;
        // path() を優先 (Playwright 公式)。取れなければ dir 走査でフォールバック。
        let vpath: string | null = null;
        try { vpath = vid ? await vid.path() : null; } catch { vpath = null; }
        if (!vpath && existsSync(videoDir)) {
          const webm = readdirSync(videoDir).find((f) => f.endsWith(".webm"));
          vpath = webm ? join(videoDir, webm) : null;
        }
        console.log(
          `[video] ${job.id.slice(0, 8)} failed=${failed} webm=${vpath ? "yes" : "no"}`
        );
        if (failed && vpath) await uploadJobVideo(job.id, vpath);
      } catch (e) {
        console.warn(`[video] finally 失敗: ${(e as Error)?.message ?? e}`);
      }
      // 成功/失敗いずれもローカルは掃除 (ディスク肥大防止)。
      try { rmSync(videoDir, { recursive: true, force: true }); } catch { /* noop */ }
    }
  }
}

// ------------------------------------------------------------
// storageState (shop_id ごとのログインセッション)
//
// ローカル PC に shop_id ごとの認証状態を保存し、毎回ログインを避ける。
// 保存先: ~/.kireidot/salonboard-auth/{shop_id}.json
//
// 重要: storageState はサーバへ送らない。Admin 側 API もこのファイルを受け取らない。
// ------------------------------------------------------------
type ResolvedLaunch = {
  launch: Parameters<typeof chromium.launch>[0];
  realChrome: boolean;
};

/**
 * ブラウザ起動オプションを env + ジョブ単位プロキシ設定から組み立てる。
 *  - SB_BROWSER_CHANNEL=chrome … 実 Chrome (クラウドの Akamai 対策)。未設定なら bundled chromium。
 *  - SB_HEADLESS=0 … ヘッドフル (クラウドは entrypoint の xvfb 経由)。既定 headless。
 *  - プロキシは「ジョブの credentials.proxy」優先、無ければ env SB_PROXY_* にフォールバック。
 *    どちらも無ければ direct = 現状と完全に同じ挙動 (既存 PC / Electron 無影響)。
 */
// プロキシIPプールの round-robin 割当て用カウンタ。
let _proxyRrCounter = 0;
// doLogin が完了しない静的ISP出口へアカウントが固定され続けないよう、ログイン全滅時に
// 次のpoolへ進める。loginId+baseUrl の sessionKey 単位なのでグループ店舗でも共有される。
const accountProxyRotation = new Map<string, number>();
function rotateAccountProxy(sessionKey: string): void {
  const pool = proxyPoolList();
  if (pool.length <= 1) return;
  const next = ((accountProxyRotation.get(sessionKey) ?? 0) + 1) % pool.length;
  accountProxyRotation.set(sessionKey, next);
  console.log(`[proxy] account=${sessionKey.slice(0, 12)} static ISPを次の出口へ切替 (${next + 1}/${pool.length})`);
}
// IP プール ヘルスチェック結果 (フラグ/到達不可IPを使わないためのバックオフ)。
let _healthyProxies: string[] | null = null;
let _lastProxyCheck = 0;

// ── 店舗レーン並行処理 (Phase 1: scale-out) ──────────────────────────────
// claim関数(salonboard_claim_next_job)の per-shop mutex が「1店舗あたり同時1ジョブ」を
// 保証するので、ここでは「プロセス全体の同時実行数」だけを上限管理する。別店舗(=別ISP
// IP/別セッション)は安全に並行可能(店舗→IPは pickProxy で sticky)。
const _inFlight = new Map<string, Promise<unknown>>();
// SalonBoard は1ログインで複数店舗を持つ。DB の per-shop lane だけでは同じ
// ログインIDの店舗が並列実行され、サロン選択・フォーム状態・Cookie を奪い合う。
// Cloud worker 内ではログインアカウント単位で必ず直列化する。
const _accountJobTail = new Map<string, Promise<void>>();

async function withAccountJobGate<T>(job: Job, fn: () => Promise<T>): Promise<T> {
  const key = sessionKeyFor(
    job.credentials.login_id,
    job.credentials.base_url ?? "https://salonboard.com/",
  );
  const previous = _accountJobTail.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.catch(() => {}).then(() => mine);
  _accountJobTail.set(key, tail);
  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (_accountJobTail.get(key) === tail) _accountJobTail.delete(key);
  }
}
// ★②A(セッション保護): 現在開いている全 BrowserContext を追跡する。デプロイ(SIGTERM)時に
//   これらを明示 close して cookie/_abck を userDataDir に flush する。docker の SIGKILL で
//   Chrome を強制killするとセッションが未flush → 次起動で全店再ログイン → Akamaiスロットル、
//   という今日の障害連鎖を断つ。close は Playwright の 'close' イベントで自動的に集合から外す。
const _openContexts = new Set<BrowserContext>();

// ── ログイン POST の出口IP単位ペーシング ────────────────────────────────
// 通常ジョブは店舗別レーンで並列実行できるが、セッション切れが複数店舗で同時に起きると
// 同じ ISP endpoint から /CNC/login/doLogin/ が短時間に集中する。Akamai は予約画面の
// GET ではなく、このログイン POST を無応答のまま保持することがあるため、実際にログインが
// 必要なジョブだけを endpoint 単位で直列化する。ログイン済みジョブには一切待ちを加えない。
//
// 既定30秒は同一出口からの連打を避けつつ、150秒の Cloud SLA 内に収まる値。運用中は
// SB_LOGIN_MIN_INTERVAL_MS でホット調整できる。プロセス再起動で状態は安全にリセットされる。
const _loginGateTail = new Map<string, Promise<void>>();
const _lastLoginAttemptAt = new Map<string, number>();
// Akamai がログインPOSTをホールドした出口へ連打すると制限時間が延びるため、
// 検知後は短時間その出口からの自動ログインを止め、ジョブをPCへ即時移管する。
// ログイン済みセッションの利用には影響しない。
const _loginThrottleUntil = new Map<string, number>();
// 固定クールダウンは廃止。ログイン失敗は同一ジョブ内のfresh retryで回復させる。
const LOGIN_THROTTLE_COOLDOWN_MS = 0;
function loginGateKeys(endpoint: string, loginId: string): string[] {
  const account = loginId.trim().toLowerCase();
  return Array.from(new Set([
    `endpoint:${endpoint || "direct"}`,
    ...(account ? [`account:${account}`] : []),
  ])).sort();
}
function loginThrottleRemainingMs(endpoint: string, loginId: string): number {
  const now = Date.now();
  return Math.max(
    0,
    ...loginGateKeys(endpoint, loginId).map(
      (key) => (_loginThrottleUntil.get(key) ?? 0) - now,
    ),
  );
}
function noteEndpointLoginThrottle(endpoint: string, loginId: string): void {
  const until = Date.now() + LOGIN_THROTTLE_COOLDOWN_MS;
  for (const key of loginGateKeys(endpoint, loginId)) {
    _loginThrottleUntil.set(key, until);
  }
}
function noteEndpointLoginSuccess(endpoint: string, loginId: string): void {
  for (const key of loginGateKeys(endpoint, loginId)) {
    _loginThrottleUntil.delete(key);
  }
}
function loginMinIntervalMs(): number {
  const configured = Number(process.env.SB_LOGIN_MIN_INTERVAL_MS ?? 10_000);
  if (!Number.isFinite(configured)) return 10_000;
  return Math.max(0, Math.min(configured, 15_000));
}
async function withLoginPacing<T>(
  endpoint: string,
  shopId: string,
  loginId: string,
  fn: () => Promise<T>,
): Promise<T> {
  // Akamai の制限は出口IPだけでなく、同一ログインIDの並列ログインでも発生する。
  // 両キーを辞書順に獲得して、別IPに割り当てられた同一グループ店舗も直列化する。
  const keys = loginGateKeys(endpoint, loginId);
  const releases: Array<() => void> = [];
  const tails: Array<{ key: string; tail: Promise<void> }> = [];
  for (const key of keys) {
    const previous = _loginGateTail.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => {}).then(() => mine);
    _loginGateTail.set(key, tail);
    await previous.catch(() => {});
    releases.push(release);
    tails.push({ key, tail });
  }
  try {
    const waitMs = Math.max(
      0,
      ...keys.map(
        (key) =>
          loginMinIntervalMs() -
          (Date.now() - (_lastLoginAttemptAt.get(key) ?? 0)),
      ),
    );
    if (waitMs > 0) {
      console.log(
        `[login-gate] endpoint=${endpoint || "direct"} shop=${shopId.slice(0, 8)} wait=${waitMs}ms`,
      );
      await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
    }
    // 開始時刻を基準にすることで、doLogin が短時間で失敗しても直後の別店舗が連打しない。
    const startedAt = Date.now();
    for (const key of keys) _lastLoginAttemptAt.set(key, startedAt);
    return await fn();
  } finally {
    for (let i = releases.length - 1; i >= 0; i--) releases[i]();
    for (const { key, tail } of tails) {
      if (_loginGateTail.get(key) === tail) _loginGateTail.delete(key);
    }
  }
}
// 同時実行数。env追加はコンテナ再作成(=全店セッション消失)になるため、ファイルでも上書き可。
// 既定は控えめ。Decodo IP数(現状10)が真の上限。インスタンス増強後はファイルで引き上げる。
function maxConcurrency(): number {
  const fromEnv = Number(process.env.SB_MAX_CONCURRENCY || 0);
  if (fromEnv > 0) return Math.min(fromEnv, 12);
  try {
    const n = Number(
      readFileSync("/home/pwuser/.kireidot/max_concurrency", "utf8").trim()
    );
    if (Number.isFinite(n) && n > 0) return Math.min(n, 12);
  } catch {
    /* ファイル無し → 既定 */
  }
  return 1; // 既定は直列(安全)。インスタンス増強後に max_concurrency ファイルで引き上げる。
}

// 自動ログイン(tryLogin/doLogin)抑制フラグ。Akamai は cloud の自動ログインを弾く上、
// **doLogin 試行回数こそがフラグの主因**。flaky/劣化セッションで login を叩くと再フラグして
// 回復を遅らせる悪循環になるため、抑制時は isLoggedIn=false でも login せず retryable で待つ
// (永続セッション + reads の温めで回復を待つ / 本当に切れていれば人間の再シードを待つ)。
// env SB_DISABLE_AUTO_LOGIN=1 or ファイル /home/pwuser/.kireidot/disable_auto_login で有効化。
function autoLoginDisabled(): boolean {
  if (process.env.SB_DISABLE_AUTO_LOGIN === "1") return true;
  try {
    return existsSync("/home/pwuser/.kireidot/disable_auto_login");
  } catch {
    return false;
  }
}
const PROXY_CHECK_INTERVAL_MS =
  Number(process.env.PROXY_CHECK_INTERVAL_MS) || 10 * 60 * 1000;

// ISP 静的プール。env(SB_PROXY_POOL)は **コンテナ再作成しないと変えられない**(全店セッション
// 消失リスク)ため、ファイル /home/pwuser/.kireidot/proxy_pool でも上書き可能にする
// (max_concurrency / proxy-shop-override と同じホット設定パターン)。Decodo で IP を増やしたら
// (10→20 等)このファイルに列挙するだけで、再起動なしの次サイクルから健全チェック対象に入る。
// 形式: カンマ区切り or 改行区切りの "host:port" (# 始まりの行はコメント)。
function proxyPoolList(): string[] {
  try {
    const raw = readFileSync(
      "/home/pwuser/.kireidot/proxy_pool",
      "utf8"
    ).trim();
    if (raw) {
      const list = raw
        .split(/[,\n]/)
        .map((s) => s.trim())
        .filter((s) => s && !s.startsWith("#"));
      if (list.length > 0) return list;
    }
  } catch {
    /* ファイル無し → env にフォールバック */
  }
  return (process.env.SB_PROXY_POOL || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * プール内の各IPが salonboard に到達できるか軽量HTTPで検査し、健全なものだけを使う。
 * Akamai に評判劣化 (フラグ) されたIPを叩き続けるとフラグが延命する (連鎖フラグ) ため、
 * フラグIPはバックオフ。全IPフラグ時は処理を止めてIPを休ませる (回復を妨げない)。
 */
async function refreshHealthyProxies(): Promise<void> {
  const pool = proxyPoolList();
  if (pool.length === 0) {
    _healthyProxies = null;
    return;
  }
  const pw = await import("playwright");
  const results = await Promise.all(
    pool.map(async (server) => {
      try {
        const ctx = await pw.request.newContext({
          proxy: {
            server: /:\/\//.test(server) ? server : `http://${server}`,
            username: process.env.SB_PROXY_USERNAME ?? undefined,
            password: process.env.SB_PROXY_PASSWORD ?? undefined,
          },
          timeout: 12_000,
          ignoreHTTPSErrors: true,
        });
        const resp = await ctx
          .get("https://salonboard.com/KLP/top/", { timeout: 12_000 })
          .catch(() => null);
        await ctx.dispose().catch(() => {});
        // 403 等の Akamai ブロックページも「応答あり」になるため ok() まで見る。
        return resp && resp.ok() ? server : null;
      } catch {
        return null;
      }
    })
  );
  _healthyProxies = results.filter((x): x is string => !!x);
  _lastProxyCheck = Date.now();
  console.log(
    `[proxy] health-check: ${_healthyProxies.length}/${pool.length} healthy` +
      (_healthyProxies.length === 0 ? " — 全IPフラグ中、処理を待機しIP回復を待つ" : "")
  );
}

// ── Residential(住宅)接続情報 ─────────────────────────────────────────────
// env(SB_PROXY_FALLBACK_*)を既定とし、**コンテナ再作成せず**更新できるよう
// ファイル /home/pwuser/.kireidot/residential.json を優先で読む(存在時)。
//   形式: {"host":"jp.decodo.com","port_min":30001,"port_max":30010,"username":"...","password":"..."}
// sticky エンドポイント(jp.decodo.com:3000X)は port ごとに別のstickyセッション(=別IP)。
// shop→port を hash で固定し、店舗ごとに安定した住宅stickyセッションを割り当てる。
type ResidentialCfg = { host: string; portMin: number; portMax: number; username?: string; password?: string } | null;
let _residentialCfgCache: ResidentialCfg | undefined;
function residentialConfig(): ResidentialCfg {
  if (_residentialCfgCache !== undefined) return _residentialCfgCache;
  try {
    const raw = readFileSync("/home/pwuser/.kireidot/residential.json", "utf8");
    const j = JSON.parse(raw) as Record<string, unknown>;
    if (j && j.host) {
      const pMin = Number(j.port_min ?? j.port ?? 30001);
      _residentialCfgCache = {
        host: String(j.host),
        portMin: pMin,
        portMax: Number(j.port_max ?? j.port ?? pMin),
        username: j.username ? String(j.username) : undefined,
        password: j.password ? String(j.password) : undefined,
      };
      return _residentialCfgCache;
    }
  } catch { /* ファイル無し/壊れ → env にフォールバック */ }
  const srv = (process.env.SB_PROXY_FALLBACK_SERVER || "").trim();
  if (srv) {
    const [h, p] = srv.split(":");
    const port = Number(p || 0) || 30001;
    _residentialCfgCache = {
      host: h, portMin: port, portMax: port,
      username: process.env.SB_PROXY_FALLBACK_USERNAME || undefined,
      password: process.env.SB_PROXY_FALLBACK_PASSWORD || undefined,
    };
    return _residentialCfgCache;
  }
  _residentialCfgCache = null;
  return null;
}
function residentialProxyFor(shopId?: string): { server: string; username?: string; password?: string } | null {
  const c = residentialConfig();
  if (!c) return null;
  const span = Math.max(1, c.portMax - c.portMin + 1);
  const port = shopId ? c.portMin + (hashShop(shopId) % span) : c.portMin;
  return { server: `${c.host}:${port}`, username: c.username, password: c.password };
}
function fallbackConfigured(): boolean {
  return !!residentialConfig();
}
/** proxy-shop-override.json の値が "residential" の店舗は全処理を住宅IPへ通す。 */
function shopWantsResidential(shopId?: string): boolean {
  const v = proxyShopOverride(shopId);
  return v === "residential" || v === "res";
}

/**
 * 書込ジョブ(push/cancel/delete 系)だけを住宅(residential)IPへ通すか。
 *   env `SB_WRITE_VIA_RESIDENTIAL=1`、または コンテナ再作成せず切替えられるよう
 *   ファイル /home/pwuser/.kireidot/write_via_residential の存在で ON。
 *   狙い: 読み(15分毎・大量)は定額ISPのまま、**低頻度の書込だけ評判の高い住宅IP**へ
 *   通して doComplete 500 を減らす。書込は件数が少ないので従量GBは僅少。毎回チェック
 *   (キャッシュせず)なのでファイル作成/削除で即時トグル。
 */
function writeViaResidentialEnabled(): boolean {
  if (process.env.SB_WRITE_VIA_RESIDENTIAL === "1") return true;
  try {
    return existsSync("/home/pwuser/.kireidot/write_via_residential");
  } catch {
    return false;
  }
}

/**
 * 使用するプロキシを1つ選ぶ (server + 認証)。
 *  ① 静的プール(SB_PROXY_POOL)に健全IPがあれば round-robin で返す (IP認証=user/pass)。
 *  ② 健全な静的IPが無く SB_PROXY_FALLBACK_SERVER があれば **Residential フォールバック**
 *     (gate.decodo.com 等・user/pass認証) を返す → 全static フラグでもクラウド書込を止めない。
 *  ③ プール未設定なら従来の SB_PROXY_SERVER。
 * 静的(ISP)は IP認証、住宅は user/pass認証で別系統なので、選択と同時に認証も切替える。
 */
// 店舗IDの決定的ハッシュ(FNV-1a)。店舗→ISP IP の sticky 割当に使う。
function hashShop(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

// 店舗別プロキシの手動オーバーライド (運用ファイル)。ハッシュ sticky が割り当てた IP が
// SalonBoard 側でフラグ/遮断されたとき、特定店舗だけを別 IP へ退避させる。
// JSON 形式: {"<shop_id>": "isp.decodo.com:10003", ...}
// env と違いコンテナ再作成 (=全店セッション消失) なしで編集でき、毎回読むので即反映。
// 例: 2026-07-02 に 10006 の出口IPが SB 到達不能となり 新宿三丁目/WAO表参道 (共に
// hash→10006) が2日間全滅。ヘルスチェック(request probe)は通るため自動退避が効かなかった。
function proxyShopOverride(shopId?: string): string | null {
  if (!shopId) return null;
  try {
    const raw = readFileSync(
      "/home/pwuser/.kireidot/proxy-shop-override.json",
      "utf8"
    );
    const v = (JSON.parse(raw) as Record<string, unknown>)[shopId];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  } catch {
    return null; // ファイル無し/壊れ → オーバーライドなし
  }
}

function pickProxy(
  forceResidential?: boolean,
  shopId?: string,
  avoidResidential?: boolean,
  stickyKey?: string,
): { server: string; username?: string; password?: string } {
  // 書込ジョブ等で residential を強制 (静的ISPが登録フォーム等の深い操作で Akamai ソフト
  // チャレンジを受けハングするのを回避)。静的の健全/不健全に関わらず residential を返す。
  // 書込強制 or 「この店舗は住宅IP」指定 → 住宅(sticky)へ。creds はファイル/env(residentialConfig)。
  // avoidResidential(書込・既定) のときは住宅を一切使わず ISP に固定する。
  if (!avoidResidential && (forceResidential || shopPrefersResidential(shopId)) && fallbackConfigured()) {
    const r = residentialProxyFor(stickyKey ?? shopId);
    if (r) {
      // 認証情報は出さず host:port と理由のみ (どの店舗が住宅IPを使ったか監査可能に)
      const why = forceResidential
        ? "書込強制"
        : shopWantsResidential(shopId)
        ? "手動pin"
        : "自動FO";
      console.log(
        `[proxy] shop=${shopId ?? "-"} → residential ${r.server} (${why})`
      );
      return r;
    }
  }
  const shopOverride = proxyShopOverride(shopId);
  // "residential"/"res" は上で処理済み。それ以外(ISPサーバ文字列)のみ ISP override として使う。
  if (shopOverride && shopOverride !== "residential" && shopOverride !== "res") {
    return {
      server: shopOverride,
      username: process.env.SB_PROXY_USERNAME || undefined,
      password: process.env.SB_PROXY_PASSWORD || undefined,
    };
  }
  const pool = proxyPoolList();
  if (pool.length === 0) {
    return {
      server: process.env.SB_PROXY_SERVER || "",
      username: process.env.SB_PROXY_USERNAME || undefined,
      password: process.env.SB_PROXY_PASSWORD || undefined,
    };
  }
  const healthy =
    _healthyProxies && _healthyProxies.length > 0 ? _healthyProxies : null;
  if (healthy) {
    // 店舗→IP を固定(sticky)。Akamai の _abck は発行時IPに紐づくため、同一店舗の
    // login/read/write を常に同じISP IPで通す。IPローテだと別IP扱いで弾かれ500になる
    // (2026-06-30 銀座書込500の真因)。安定indexは全poolに対するハッシュ。当該IPが
    // 不健全なら健全集合内でハッシュ的に決定。shopId 無し(直接実行系)は従来round-robin。
    let pick: string;
    const accountStickyKey = stickyKey ?? shopId;
    if (accountStickyKey) {
      const rotation = accountProxyRotation.get(accountStickyKey) ?? 0;
      const stable = pool[(hashShop(accountStickyKey) + rotation) % pool.length];
      pick = healthy.includes(stable)
        ? stable
        : healthy[(hashShop(accountStickyKey) + rotation) % healthy.length];
    } else {
      pick = healthy[_proxyRrCounter % healthy.length];
      _proxyRrCounter += 1;
    }
    return {
      server: pick,
      username: process.env.SB_PROXY_USERNAME || undefined,
      password: process.env.SB_PROXY_PASSWORD || undefined,
    };
  }
  // 健全な静的IPが無い → Residential フォールバック (設定時)。
  // ただし書込(avoidResidential)は住宅で壊れるのでフォールバックせず ISP 待機に倒す。
  const rfb = avoidResidential ? null : residentialProxyFor(stickyKey ?? shopId);
  if (rfb) {
    if (_proxyRrCounter % 20 === 0)
      console.log("[proxy] 全static IPフラグ → Residential フォールバックを使用");
    _proxyRrCounter += 1;
    return rfb;
  }
  return { server: "" }; // フォールバック無し → 健全IP無し (呼び出し側で待機)
}

function resolveLaunchOptions(
  credProxy?: { server: string; username?: string | null; password?: string | null } | null,
  forceResidential?: boolean,
  shopId?: string,
  avoidResidential?: boolean,
  stickyKey?: string,
): ResolvedLaunch {
  const channel = process.env.SB_BROWSER_CHANNEL || undefined;
  const headless = process.env.SB_HEADLESS !== "0";
  // forceResidential / 店舗pin / login throttle後のauto-FO は residential を優先する。
  // ただし avoidResidential(書込・既定)では、店舗pin/auto-FOも含め住宅IPを使わない。
  // 書込を住宅IPへ通すのは SB_WRITE_VIA_RESIDENTIAL=1 (forceResidential) の場合だけ。
  // SalonBoard は住宅IPの /login/ を HTTP 応答段階で拒否することがあり、auto-FO が
  // 残った店舗の書込を住宅IPへ送ると全件 ERR_HTTP_RESPONSE_CODE_FAILURE になるため。
  // それ以外(読み)は「auto-FO/pin なら住宅、無ければ credProxy → pickProxy(静的→住宅fallback)」。
  const useResidential =
    (forceResidential || (!avoidResidential && shopPrefersResidential(shopId))) &&
    fallbackConfigured();
  const hasRotatedAccount = !!stickyKey && (accountProxyRotation.get(stickyKey) ?? 0) > 0;
  const picked = useResidential
    ? pickProxy(forceResidential, shopId, undefined, stickyKey)
    : credProxy?.server && !hasRotatedAccount
    ? {
        server: credProxy.server,
        username: credProxy.username ?? undefined,
        password: credProxy.password ?? undefined,
      }
    : pickProxy(undefined, shopId, avoidResidential, stickyKey);
  const proxy = picked.server
    ? {
        // Playwright の proxy.server はスキーム必須。host:port だけなら http:// を補う。
        server: /:\/\//.test(picked.server) ? picked.server : `http://${picked.server}`,
        username: picked.username ?? undefined,
        password: picked.password ?? undefined,
      }
    : undefined;
  return { launch: { headless, channel, proxy }, realChrome: !!channel };
}

/**
 * ユーザーの普段使い Chrome プロファイルの「cookie / Akamai 信頼状態」を worker 専用
 * userDataDir に seed する (PC worker-process.cjs と同じ)。同一 Mac・同一ユーザーなら
 * Keychain の鍵で cookie を復号でき、手動と同じ Akamai 信頼状態で起動できる。
 * SALONBOARD_USE_USER_PROFILE=1 のときのみ実行 (既定 OFF)。.seeded マーカーで初回のみ。
 * パスワード DB (Login Data) / 自動入力 (Web Data) はコピーしない (cookie/信頼状態のみ)。
 */
function seedUserChromeProfile(userDataDir: string): {
  seeded: boolean;
  reason?: string;
  copied?: number;
} {
  if (existsSync(join(userDataDir, ".seeded"))) return { seeded: false, reason: "already" };
  const srcRoot =
    process.env.SALONBOARD_CHROME_SOURCE_DIR ||
    join(homedir(), "Library", "Application Support", "Google", "Chrome");
  const srcProfile = process.env.SALONBOARD_CHROME_SOURCE_PROFILE || "Default";
  if (!existsSync(join(srcRoot, srcProfile)))
    return { seeded: false, reason: "source_not_found" };
  try {
    mkdirSync(join(userDataDir, srcProfile), { recursive: true, mode: 0o700 });
    try {
      copyFileSync(join(srcRoot, "Local State"), join(userDataDir, "Local State"));
    } catch {
      /* 鍵がコピーできなくても続行 */
    }
    // session cookie + Akamai 信頼状態のみ (パスワード/自動入力は除外)。
    const files = [
      "Cookies",
      "Cookies-journal",
      "Network/Cookies",
      "Network/Cookies-journal",
      "Preferences",
      "Local Storage",
    ];
    let copied = 0;
    for (const rel of files) {
      const s = join(srcRoot, srcProfile, rel);
      const d = join(userDataDir, srcProfile, rel);
      try {
        if (!existsSync(s)) continue;
        mkdirSync(dirname(d), { recursive: true });
        if (statSync(s).isDirectory()) cpSync(s, d, { recursive: true });
        else copyFileSync(s, d);
        copied++;
      } catch {
        /* 個別失敗は無視 */
      }
    }
    try {
      writeFileSync(join(userDataDir, ".seeded"), new Date().toISOString());
    } catch {
      /* noop */
    }
    return { seeded: true, copied };
  } catch (e) {
    return { seeded: false, reason: `copy_error: ${e instanceof Error ? e.message : e}` };
  }
}

/**
 * 自動化指紋を隠した永続コンテキストで Chrome を起動する (PC worker-process.cjs と同じステルス)。
 * Akamai Bot Manager は navigator.webdriver / --enable-automation /
 * AutomationControlled / --no-sandbox 警告 などの「自動化指紋」を見てボット判定し、
 * login POST (doLogin) を無応答ホールドする。これらを付けない/隠すことで人間の Chrome に
 * 近づける。launchPersistentContext で shop ごとに userDataDir を持ち、Akamai のセンサー
 * cookie を回またぎで蓄積して信頼を育てる。SALONBOARD_USE_USER_PROFILE=1 のときは初回に
 * ユーザー Chrome の cookie/信頼状態を seed する (ローカル運用向け / クラウドは既定 OFF)。
 */
async function launchStealthContext(opts: {
  launch: ResolvedLaunch["launch"];
  realChrome: boolean;
  shopId: string;
  profileKey?: string;
  legacyShopId?: string;
  // 反映(書込)フローの画面遷移を動画記録する dir。失敗診断用 (500/Akamai混雑は
  // 前後の遷移が無いと原因が分からないため)。指定時のみ recordVideo を有効化。
  recordVideoDir?: string;
}): Promise<BrowserContext> {
  const userDataDir = join(
    homedir(),
    ".kireidot",
    "salonboard-chrome-profile",
    opts.profileKey ?? opts.shopId,
  );
  // 段階移行: アカウントprofileがまだ無ければ、現在店舗の既存profileをコピーして
  // Cookie/_abckを引き継ぐ。最初のデプロイで全アカウントが再ログインになるのを防ぐ。
  const legacyDir = opts.legacyShopId
    ? join(homedir(), ".kireidot", "salonboard-chrome-profile", opts.legacyShopId)
    : null;
  try {
    if (!existsSync(userDataDir) && legacyDir && legacyDir !== userDataDir && existsSync(legacyDir)) {
      cpSync(legacyDir, userDataDir, { recursive: true, errorOnExist: false });
      console.log(
        `[session] 店舗profileからアカウントprofileへ移行 shop=${opts.legacyShopId?.slice(0, 8)} key=${(opts.profileKey ?? "").slice(0, 12)}`,
      );
    }
    mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
  } catch {
    /* 作れない環境では Playwright が一時 dir を使う */
  }
  if (/^(1|true|yes)$/i.test(process.env.SALONBOARD_USE_USER_PROFILE ?? "")) {
    console.log(
      `[cfg] Chrome profile seed: ${JSON.stringify(seedUserChromeProfile(userDataDir))}`
    );
  }
  const launchOptions = {
    headless: opts.launch.headless,
    channel: opts.launch.channel,
    proxy: opts.launch.proxy,
    // Playwright が付ける自動化フラグを除去 (Akamai 検知シグナル)。
    ignoreDefaultArgs: [
      "--enable-automation",
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
    ],
    args: ["--disable-features=IsolateOrigins,site-per-process"],
    viewport: { width: 1366, height: 900 },
    // ★反映フロー動画 (2026-07-11): 書込ジョブのみ有効。小さめ解像度で webm を記録し、
    //   失敗時だけ Admin 経由で Storage に上げる (成功時は破棄)。ファイル肥大を避けるため縮小。
    ...(opts.recordVideoDir
      ? { recordVideo: { dir: opts.recordVideoDir, size: { width: 900, height: 600 } } }
      : {}),
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    // 実 Chrome は本物 UA を使う。bundled chromium のみ従来の Mac UA 偽装。
    ...(opts.realChrome
      ? {}
      : {
          userAgent:
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        }),
  };
  let ctx: BrowserContext;
  try {
    ctx = await chromium.launchPersistentContext(userDataDir, launchOptions);
  } catch (e) {
    if (!/has been closed/.test(String(e))) throw e;
    // JOB_TIMEOUT で宙に浮いた前ジョブの孤児 Chrome が SingletonLock を握っていると、
    // 新しい Chrome はプロファイル使用中と判断して即終了し、この形の起動失敗になる
    // (2026-07-02 新宿三丁目/WAO表参道で連鎖)。per-shop mutex により同店舗で正当に
    // 並行する Chrome は存在しないため、該当プロファイルの Chrome を kill して1回再試行。
    console.warn(
      `[launch] 孤児 Chrome を kill して再試行 shop=${opts.shopId.slice(0, 8)}`
    );
    try {
      execSync(`pkill -f -- "--user-data-dir=${userDataDir}"`, {
        stdio: "ignore",
      });
    } catch {
      /* 対象プロセス無し (pkill exit 1) は無視 */
    }
    await new Promise((r) => setTimeout(r, 2_000));
    ctx = await chromium.launchPersistentContext(userDataDir, launchOptions);
  }
  await ctx
    .addInitScript(() => {
      try {
        Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      } catch {
        /* noop */
      }
      try {
        const w = window as unknown as { chrome?: unknown };
        w.chrome = w.chrome || { runtime: {} };
      } catch {
        /* noop */
      }
    })
    .catch(() => {});
  // ★②A: このコンテキストを追跡。close時(正常/シャットダウン)に集合から自動除外。
  _openContexts.add(ctx);
  ctx.on("close", () => _openContexts.delete(ctx));
  return ctx;
}

function storageStatePathFor(shopId: string): string {
  const dir = join(homedir(), ".kireidot", "salonboard-auth");
  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    } else {
      try {
        const st = statSync(dir);
        if ((st.mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
      } catch {
        // ignore
      }
    }
  } catch {
    // ディレクトリを作れない環境 (CI, sandbox) では storageState を使わない
  }
  return join(dir, `${shopId}.json`);
}

function sessionKeyFor(loginId: string, baseUrl: string): string {
  let origin = baseUrl;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    // baseUrlが不正でもloginIdだけで安定キーを作り、認証情報そのものはパスに出さない。
  }
  const digest = createHash("sha256")
    .update(`${origin}\n${String(loginId ?? "").trim().toLowerCase()}`)
    .digest("hex")
    .slice(0, 24);
  return `account-${digest}`;
}

function readStorageState(path: string): string | undefined {
  try {
    if (!existsSync(path)) return undefined;
    // Playwright は storageState にファイルパスを渡せる。
    return path;
  } catch {
    return undefined;
  }
}

async function saveStorageState(ctx: BrowserContext, path: string): Promise<void> {
  try {
    await ctx.storageState({ path });
    try {
      chmodSync(path, 0o600);
    } catch {
      /* permissions が変えられなくても致命的ではない */
    }
  } catch (e) {
    console.warn(
      `[warn] failed to save storageState: ${e instanceof Error ? e.message : e}`
    );
  }
}

/**
 * 管理画面 (TOP) にアクセスし、ログイン input が出ていなければ「ログイン済み」と判定。
 * captcha が出たら captcha 扱いで返す。
 *
 * SalonBoard の URL は店舗種別 (美容/治療院/リラク) で差があるので、
 * base_url が設定されていればそれを優先する。
 */
async function isLoggedIn(
  page: Page,
  baseUrl: string,
  opts?: { genre?: string; salonId?: string | null }
): Promise<"logged_in" | "needs_login" | "captcha" | "unknown"> {
  // 注意: "/KLP/" (末尾スラッシュのみ) は 404「指定されたURLは存在しません」
  // エラー画面を返す。ログインフォームが無く URL も /login を含まないため、旧実装は
  // これを logged_in と誤判定し、無効セッションのまま scrape して常に 0 件になっていた。
  // → 管理 TOP を開き、グローバルナビ「予約管理」等の有無で **肯定的に** 判定する。
  //
  // ★重要(2026-07-04 修正): 旧実装は /KLP/top/ (エステTOP) 固定だった。ADER 等の
  //   「美容室・グループアカウント」はログイン後 /CNC/groupTop/ (サロン一覧) に着地し、
  //   /KLP/top/ には管理ナビが無いため **有効セッションでも needs_login と誤判定** →
  //   毎回 doLogin を叩き、失敗を繰り返してセッションを劣化させていた(郡山の予約/fetch
  //   ログイン失敗の真因)。ジャンル/グループで管理TOPを出し分け、サロン一覧も logged_in
  //   として認める。
  const genre = opts?.genre === "hair" ? "hair" : "esthetic";
  const isGroup = !!(opts?.salonId && String(opts.salonId).trim());
  const candidates: string[] = [];
  if (isGroup) candidates.push(new URL("/CNC/groupTop/", baseUrl).toString());
  candidates.push(
    new URL(genre === "hair" ? "/CLP/bt/top/" : "/KLP/top/", baseUrl).toString(),
  );
  candidates.push(baseUrl);

  for (const url of candidates) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
    } catch {
      continue;
    }
    if ((await page.locator('iframe[src*="recaptcha"]').count()) > 0) {
      return "captcha";
    }
    const cur = page.url();
    // ログインフォームの input / /login リダイレクト → 未ログイン (最優先)。
    const loginInputCount = await page
      .locator(
        'input[name="userId"], input[name="loginId"], input[name="password"], input[type="password"]'
      )
      .count()
      .catch(() => 0);
    if (loginInputCount > 0 || /\/login\//i.test(cur)) {
      return "needs_login";
    }
    const info = await page
      .evaluate(() => {
        const txt =
          document.body && document.body.innerText ? document.body.innerText : "";
        return {
          hasMgmt: /予約管理|掲載管理/.test(txt),
          // グループのサロン一覧: タイトル「サロン一覧」or サロン選択リンク。
          hasSalonList:
            /サロン一覧/.test(document.title || "") ||
            !!document.querySelector(
              'a[id^="H"], a[href*="selectSalon"], a[href*="/CLP/bt/"], form[action*="selectSalon"]'
            ),
          expired:
            /有効期限|再度ログイン|ログインしなおし|操作されなかった/.test(
              txt.replace(/\s+/g, "")
            ),
        };
      })
      .catch(() => null);
    if (info?.expired) return "needs_login";
    if (info?.hasMgmt) return "logged_in";
    // グループ: /CNC/groupTop/ でサロン一覧が見えれば認証済み (サロン選択は後続フローで)。
    if (/\/(?:CNC|KLP)\/groupTop/i.test(cur) && info?.hasSalonList) return "logged_in";
    // 美容室: 店舗文脈 /CLP/bt/ に居れば認証済み。
    if (/\/CLP\/bt\//i.test(cur)) return "logged_in";
    // この候補では判定できず → 次の候補を試す(全滅で needs_login)。
  }
  return "needs_login";
}

/**
 * 失効セッションの自己回復用 relogin コールバックを作る (scrapers に opts.relogin で渡す)。
 * scrapers 側が「有効期限切れ」ページを踏んだときのみ呼ばれ、同一ジョブ内で
 * logout(/CNC/logout=サーバ側セッション破棄) → fresh login をやり直す。
 * 失効時限定なので doLogin 乱発にはならない (IPフラグ対策)。
 * 背景(2026-07-04 郡山): 同一SBアカウントの他セッション操作等で店舗文脈が突然失効し、
 * ジョブ冒頭の isLoggedIn は通るのに深部で expired を踏んで丸ごと失敗していた。
 */
function makeRelogin(
  page: Page,
  baseUrl: string,
  creds: { login_id: string; password: string },
  shopId: string,
  endpoint: string,
): () => Promise<boolean> {
  return async () => {
    if (autoLoginDisabled()) {
      console.log("[relogin] auto-login 抑制中のためスキップ");
      return false;
    }
    try {
      await page
        .goto(new URL("/CNC/logout", baseUrl).toString(), {
          waitUntil: "domcontentloaded",
          timeout: 20_000,
        })
        .catch(() => {});
      const remaining = loginThrottleRemainingMs(endpoint, creds.login_id);
      if (remaining > 0) {
        console.log(
          `[relogin] endpoint cooldown (${Math.ceil(remaining / 1000)}s remaining) -> skip`,
        );
        return false;
      }
      const r = await withLoginPacing(endpoint, shopId, creds.login_id, () =>
        tryLogin(page, new URL("/login/", baseUrl).toString(), {
          loginId: creds.login_id,
          password: creds.password,
        }),
      );
      if (r.status === "ok") noteEndpointLoginSuccess(endpoint, creds.login_id);
      else if (
        r.status === "failed" &&
        /did not complete/i.test(r.reason ?? "")
      ) {
        noteEndpointLoginThrottle(endpoint, creds.login_id);
        noteLoginThrottle(shopId);
      }
      console.log(
        `[relogin] status=${r.status}${
          r.status !== "ok" ? ` (${(r as { reason?: string }).reason ?? ""})` : ""
        }`,
      );
      return r.status === "ok";
    } catch (e) {
      console.log(`[relogin] error: ${e instanceof Error ? e.message : e}`);
      return false;
    }
  };
}

/**
 * プロキシ/ネットワークの一時的失敗を表すナビゲーションエラーか判定する。
 * 特に Decodo ISP プロキシは稀に tunnel をドロップし
 * `net::ERR_TUNNEL_CONNECTION_FAILED` を返す (curl では同時刻に疎通する=恒久障害ではない)。
 * これらは即時リトライで回復するため、恒久エラー (DNS 不正・証明書等) と区別する。
 */
function isTransientNavError(msg: string): boolean {
  return /ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED|ERR_HTTP_RESPONSE_CODE_FAILURE|ERR_EMPTY_RESPONSE|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_CONNECTION_FAILED|ERR_CONNECTION_TIMED_OUT|ERR_TIMED_OUT|ERR_NETWORK_CHANGED|ERR_SOCKET_NOT_CONNECTED|ERR_HTTP2_PING_FAILED|ERR_ABORTED|ERR_NETWORK_IO_SUSPENDED/i.test(
    msg,
  );
}

/**
 * `page.goto` を一時的ナビゲーションエラー (主に Decodo ISP の tunnel ドロップ
 * = net::ERR_TUNNEL_CONNECTION_FAILED) に対して指数バックオフで再試行する。
 * 一時的でないエラーは即座に投げ直し、無駄なリトライをしない。
 * クラウド worker はログイン・深層ページ遷移とも単一プロキシ経由のため、
 * tunnel の瞬断でジョブ全体を落とさないよう要所の goto をこれで包む。
 */
async function gotoResilient(
  page: Page,
  url: string,
  opts: Parameters<Page["goto"]>[1],
  label = "goto",
  attempts = 3,
): Promise<void> {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      await page.goto(url, opts);
      if (i > 1) console.log(`[nav] ${label} OK (attempt ${i}/${attempts})`);
      return;
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (i >= attempts || !isTransientNavError(msg)) throw e;
      const waitMs = 1200 * i;
      console.warn(
        `[nav] ${label} 一時的失敗 (attempt ${i}/${attempts}): ${msg.slice(0, 120)} → ${waitMs}ms 後に再試行`,
      );
      await page.waitForTimeout(waitMs).catch(() => {});
    }
  }
  throw lastErr;
}

async function tryLogin(
  page: Page,
  url: string,
  c: { loginId: string; password: string }
): Promise<{ status: "ok" } | { status: "failed"; reason?: string } | { status: "captcha" }> {
  try {
    // ログイン遷移は tunnel 瞬断で落ちやすいので再試行付きで開く。
    await gotoResilient(
      page,
      url,
      { waitUntil: "domcontentloaded", timeout: 30_000 },
      "login",
    );
  } catch (e) {
    return { status: "failed", reason: `navigation: ${e instanceof Error ? e.message : e}` };
  }

  if ((await page.locator('iframe[src*="recaptcha"]').count()) > 0) {
    return { status: "captcha" };
  }

  // セレクタはサロンボードの実画面に合わせて後で微調整する
  // ID 欄は input[name="userId"]。描画が遅いことがあるので明示的に待つ。
  const idInput = page
    .locator(
      'input[name="userId"], input[name="loginId"], input[name="loginCd"], input[id*="login" i], input[type="email"], input[type="text"]'
    )
    .first();
  const pwInput = page
    .locator('input[name="password"], input[type="password"]')
    .first();
  await idInput.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});

  // bot 検知を避けるため 1 文字ずつ入力 (失敗したら fill にフォールバック)。PC と同じ。
  const typeInto = async (
    loc: ReturnType<typeof page.locator>,
    value: string
  ): Promise<boolean> => {
    const current = await loc.inputValue().catch(() => "");
    // Chromeの自動入力値や前回値の末尾へ追記すると、見た目では判別できないまま
    // ID/PW不一致になる。PC workerと同様、期待値との厳密一致を保証する。
    if (current === value) return true;
    try {
      await loc.click({ timeout: 8_000 }).catch(() => {});
      if (current) await loc.fill("", { timeout: 8_000 });
      await loc.pressSequentially(value, { delay: 90, timeout: 8_000 });
      const got = await loc.inputValue().catch(() => "");
      if (got === value) return true;
    } catch {
      /* fall through to fill */
    }
    try {
      await loc.fill(value, { timeout: 8_000 });
      return (await loc.inputValue().catch(() => "")) === value;
    } catch {
      return false;
    }
  };

  const okId = await typeInto(idInput, c.loginId);
  const okPw = await typeInto(pwInput, c.password);
  if (!okId || !okPw) {
    return {
      status: "failed",
      reason: `cannot find login inputs (id=${okId}, pw=${okPw})`,
    };
  }

  // SalonBoard のログインボタンは <a class="common-CNCcommon__primaryBtn"
  // onclick="dologin(event)"> で実装されている (button[type="submit"] は存在しない)。
  // 候補を順に試し、どれも無ければ最後の手段として password 欄で Enter を送る
  // (onkeypress="enterActionLogin")。PC worker-process.cjs と同じセレクタ。
  try {
    const submitCandidates = [
      "a.common-CNCcommon__primaryBtn",
      "a.loginBtnSize",
      'a:has-text("ログイン"):not(:has-text("ログインできない"))',
      'button[type="submit"]',
      'input[type="submit"]',
    ];
    // 1) 最初に見つかったログインボタン候補をクリック。noWaitAfter でクリック自体の
    //    成否とナビゲーション待ちを分離する。actionabilityで弾かれた場合は公式DOMを
    //    直接clickし、PC workerと同じ送信経路に揃える。
    let clicked = false;
    for (const sel of submitCandidates) {
      const loc = page.locator(sel).first();
      if ((await loc.count().catch(() => 0)) === 0) continue;
      try {
        await loc.click({ timeout: 5_000, noWaitAfter: true });
        clicked = true;
        break;
      } catch {
        // 次候補へ
      }
    }
    if (!clicked) {
      clicked = await page.evaluate(() => {
        const candidates = Array.from(
          document.querySelectorAll('a, button, input[type="submit"]'),
        );
        const target = candidates.find((el) => {
          const text = String(
            el.textContent || el.getAttribute("value") || "",
          ).trim();
          return (
            el.matches("a.common-CNCcommon__primaryBtn, a.loginBtnSize") ||
            text === "ログイン"
          );
        });
        if (!target) return false;
        (target as HTMLElement).click();
        return true;
      }).catch(() => false);
    }
    if (!clicked && (await pwInput.isVisible().catch(() => false))) {
      await pwInput.press("Enter", { timeout: 5_000, noWaitAfter: true }).catch(() => {});
    }
  } catch (e) {
    return { status: "failed", reason: `submit: ${e instanceof Error ? e.message : e}` };
  }

  if ((await page.locator('iframe[src*="recaptcha"]').count()) > 0) {
    return { status: "captcha" };
  }

  // doLogin は POST 処理の中間 URL。成功時は /KLP/top/ へ、失敗時は /login/ へ
  // リダイレクトする。networkidle が早期に返って doLogin の空ページで誤判定するのを
  // 防ぐため、doLogin を離れる (= リダイレクト完了) まで明示的に待つ。
  await page
    .waitForURL((u) => !/doLogin/i.test(u.toString()), { timeout: 25_000 })
    .catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 3_500 }).catch(() => {});

  // 肯定的なログイン成否判定:
  //  - password 欄が再表示 → 認証拒否
  //  - 管理ナビ「予約管理」or /KLP/ 配下 (かつセッション切れ文言が無い) → logged_in
  //  - それ以外 (doLogin で停止 / 空ページ / エラー) → 未完了 (診断付きで failed)
  if ((await pwInput.count().catch(() => 0)) > 0) {
    return { status: "failed", reason: "still on login form (password field shown)" };
  }
  const pageInfo = await page
    .evaluate(() => {
      const txt =
        document.body && document.body.innerText ? document.body.innerText : "";
      return {
        url: location.href,
        title: (document.title || "").slice(0, 40),
        len: txt.length,
        hasMgmt: /予約管理|掲載管理/.test(txt),
        hasImageAuth: /画像認証|イラストを完成|パーツをドラッグ/.test(txt),
        expired: /有効期限|再度ログイン|ログインしなおし|操作されなかった/.test(
          txt.replace(/\s+/g, "")
        ),
      };
    })
    .catch(() => null);
  if (pageInfo && pageInfo.expired) {
    return {
      status: "failed",
      reason: `session-expired page after login (url=${pageInfo.url})`,
    };
  }
  if (pageInfo?.hasImageAuth) {
    // SalonBoard独自のドラッグ式画像認証はCloudで解けない。reCAPTCHAのように店舗を
    // 6時間ブロックせず通常失敗として返し、規定回数後に画面操作可能なPCへ移管する。
    return { status: "failed", reason: "[IMAGE_AUTH_REQUIRED] SalonBoard画像認証が表示されました" };
  }
  // グループアカウント(1ログイン複数サロン)はログイン後 /CNC/groupTop/ (サロン一覧) に
  // 着地する。管理ナビ(予約管理)は無いが認証自体は成功しており、対象サロンは後続フロー
  // (scrapers.cjs selectSalonIfOnGroupTop) で salon_id を使って選び直し /CLP/bt/ 文脈に入る。
  // よって groupTop もログイン成功として扱う (実機: ADER鯖江=グループ account で誤判定していた)。
  if (
    (pageInfo && pageInfo.hasMgmt) ||
    /\/KLP\//i.test(page.url()) ||
    /\/(?:CNC|KLP)\/groupTop/i.test(page.url())
  ) {
    return { status: "ok" };
  }

  // doLogin のレスポンス/リダイレクトだけが途中で止まっても、認証Cookie自体は発行済みで
  // 管理TOPを直接開けるケースがある。エステ単店は /KLP/top/、グループは
  // /CNC/groupTop/ を肯定確認する（従来はgroupTopしか見ず、心斎橋等を偽失敗にした）。
  if (/\/CNC\/login\/doLogin/i.test(page.url()) || !pageInfo?.hasMgmt) {
    try {
      for (const [label, path] of [
        ["esthetic top", "/KLP/top/"],
        ["groupTop", "/CNC/groupTop/"],
        ["hair top", "/CLP/bt/top/"],
      ] as const) {
        await gotoResilient(
          page,
          new URL(path, url).toString(),
          { waitUntil: "domcontentloaded", timeout: 20_000 },
          `post-login ${label} probe`,
          2,
        );
        const state = await page
          .evaluate(() => {
            const body = (document.body?.innerText || "").replace(/\s+/g, "");
            return {
              hasMgmt: /予約管理|掲載管理/.test(body),
              hasSalon: !!document.querySelector('a[id^="H"]'),
              hasPassword: !!document.querySelector('input[type="password"]'),
              imageAuth: /画像認証|イラストを完成|パーツをドラッグ/.test(body),
              errored: /システムエラー|サロンが選択されていません|再度ログイン/.test(body),
            };
          })
          .catch(() => ({ hasMgmt: false, hasSalon: false, hasPassword: true, imageAuth: false, errored: true }));
        if (state.imageAuth) {
          return { status: "failed", reason: "[IMAGE_AUTH_REQUIRED] SalonBoard画像認証が表示されました" };
        }
        if (!state.hasPassword && !state.errored && (state.hasMgmt || state.hasSalon)) {
          return { status: "ok" };
        }
      }
    } catch {
      // 下の詳細付き failed に落とす。
    }
  }
  return {
    status: "failed",
    reason: `login did not complete: ${JSON.stringify(pageInfo)}`,
  };
}

/**
 * push_blog: SalonBoard のブログ管理画面に新規記事を投稿する。
 *
 * SalonBoard 側の正確な URL/セレクタは店舗種別 (美容/治療院/リラク) や
 * 管理画面リニューアルで変動するため、よく使われる候補を上から順に試して、
 * 最初に見つかった要素で投稿する best-effort 実装。失敗時は理由を詳しく
 * 返して Admin 側で last_error として表示できるようにする。
 *
 * Worker が見つけられない場合は実際にサロンボードを開いて、店舗固有の
 * URL/セレクタを下記の候補配列に追記して調整する。
 */
/**
 * pushBlog の戻り型:
 *   ok      … 投稿成功 + external_id 取得済み
 *   warning … 投稿は成功した可能性が高いが external_id を取れなかった (重複防止のため仮 ID は付けない)
 *   failed  … 投稿失敗。statusCode は callback でそのまま使う status (retryable / non_retryable)
 */
type PushBlogResult =
  | { status: "ok"; externalId: string }
  | { status: "warning"; reason: string }
  | {
      status: "failed";
      reason: string;
      statusCode: "retryable_failed" | "non_retryable_failed";
    };

async function pushBlog(page: Page, job: Job): Promise<PushBlogResult> {
  const p = job.payload as {
    content_post_id?: string;
    title?: string;
    body_html?: string;
    cover_image_url?: string | null;
    tags?: string[];
    author_external_id?: string | null;
  };

  const title = (p.title ?? "").trim();
  const bodyHtml = (p.body_html ?? "").trim();
  if (!title || !bodyHtml) {
    return {
      status: "failed",
      reason: "payload missing title or body_html",
      statusCode: "non_retryable_failed",
    };
  }

  const baseUrl = job.credentials.base_url ?? "https://salonboard.com/";

  const blogIndexCandidates = [
    new URL("/KLP/blog/", baseUrl).toString(),
    new URL("/CNF/blog/", baseUrl).toString(),
    new URL("/blog/", baseUrl).toString(),
  ];

  let opened = false;
  for (const url of blogIndexCandidates) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
      const newPostLink = page
        .locator(
          'a:has-text("新規"), a:has-text("ブログを書く"), a:has-text("記事を書く"), button:has-text("新規投稿")'
        )
        .first();
      if ((await newPostLink.count()) > 0) {
        await newPostLink.click({ timeout: 10_000 }).catch(() => {});
        opened = true;
        break;
      }
      const titleField = page
        .locator(
          'input[name*="title" i], input[name*="subject" i], input[placeholder*="タイトル"]'
        )
        .first();
      if ((await titleField.count()) > 0) {
        opened = true;
        break;
      }
    } catch {
      /* 次の候補へ */
    }
  }
  if (!opened) {
    return {
      status: "failed",
      reason: `blog index not reachable. tried: ${blogIndexCandidates.join(", ")}`,
      statusCode: "retryable_failed",
    };
  }

  // タイトル
  const titleInput = page
    .locator(
      'input[name*="title" i], input[name*="subject" i], input[placeholder*="タイトル"]'
    )
    .first();
  try {
    await titleInput.fill(title, { timeout: 10_000 });
  } catch (e) {
    return {
      status: "failed",
      reason: `cannot fill title: ${e instanceof Error ? e.message : e}`,
      statusCode: "non_retryable_failed",
    };
  }

  // 本文
  const textarea = page
    .locator('textarea[name*="body" i], textarea[name*="content" i], textarea')
    .first();
  let bodyFilled = false;
  if ((await textarea.count()) > 0) {
    try {
      await textarea.fill(bodyHtml, { timeout: 10_000 });
      bodyFilled = true;
    } catch {
      /* fallthrough */
    }
  }
  if (!bodyFilled) {
    const iframe = page
      .frameLocator('iframe[id*="editor" i], iframe[src*="editor" i]')
      .first();
    try {
      const editable = iframe.locator('body, [contenteditable="true"]').first();
      await editable.click({ timeout: 5_000 });
      await editable.fill(bodyHtml);
      bodyFilled = true;
    } catch {
      /* ignore */
    }
  }
  if (!bodyFilled) {
    return {
      status: "failed",
      reason: "body editor not found",
      statusCode: "non_retryable_failed",
    };
  }

  // 著者選択 (任意)
  if (p.author_external_id) {
    const authorSelect = page
      .locator('select[name*="author" i], select[name*="staff" i]')
      .first();
    if ((await authorSelect.count()) > 0) {
      try {
        await authorSelect.selectOption({ value: p.author_external_id });
      } catch {
        /* 致命的ではない */
      }
    }
  }

  // 投稿ボタン
  const submit = page
    .locator(
      'button:has-text("投稿"), button:has-text("公開"), button:has-text("登録"), input[type="submit"][value*="投稿"], input[type="submit"][value*="公開"]'
    )
    .first();
  if ((await submit.count()) === 0) {
    return {
      status: "failed",
      reason: "submit button not found",
      statusCode: "non_retryable_failed",
    };
  }

  const beforeUrl = page.url();
  try {
    await Promise.all([
      page.waitForLoadState("networkidle", { timeout: 3_500 }).catch(() => {}),
      submit.click({ timeout: 15_000 }),
    ]);
  } catch (e) {
    return {
      status: "failed",
      reason: `submit click failed: ${e instanceof Error ? e.message : e}`,
      statusCode: "retryable_failed",
    };
  }

  await page.waitForTimeout(1500);
  const afterUrl = page.url();
  const idMatch =
    afterUrl.match(/[?&](?:blog_id|id|article_id)=([A-Za-z0-9_-]+)/) ||
    afterUrl.match(/\/blog\/(?:edit|detail|view)?\/?([A-Za-z0-9_-]+)/) ||
    afterUrl.match(/#\/blog\/([A-Za-z0-9_-]+)/);
  let externalId = idMatch ? idMatch[1] : "";

  if (!externalId && afterUrl !== beforeUrl) {
    const firstId = await page
      .locator('a[href*="blog"][href*="id="]')
      .first()
      .getAttribute("href")
      .catch(() => null);
    if (firstId) {
      const m = firstId.match(/[?&](?:blog_id|id|article_id)=([A-Za-z0-9_-]+)/);
      if (m) externalId = m[1];
    }
  }

  if (externalId) {
    return { status: "ok", externalId };
  }

  // 仮 ID 廃止: 投稿は成功した可能性があるが external_id を取れない場合は warning。
  // 重複投稿を防ぐため、Admin 側で salonboard_last_error に注意書きが残り、
  // salonboard_external_id は更新されない (= 次回 enqueue でも対象になる)。
  // Step8/9 で「再 enqueue 前に SalonBoard 側を見て同タイトル投稿の有無を確認」する余地を残す。
  return {
    status: "warning",
    reason: `submit completed but no external_id (url changed: ${beforeUrl !== afterUrl})`,
  };
}

function todayJst(): string {
  // yyyy-mm-dd (JST)
  const d = new Date();
  const jst = new Date(d.getTime() + 9 * 3600_000);
  return jst.toISOString().slice(0, 10);
}

// ------------------------------------------------------------
// push_booking: SalonBoard への新規予約登録
// ------------------------------------------------------------
//
// 安全方針 (booking.md §6,7 / 実装時の注意):
//   * 本番にいきなり登録ボタンを押さない。確認画面まで進め、payload と照合する。
//   * ENABLE_PUSH=false の間は照合後 confirm_only で止める (登録しない)。
//   * 二重登録防止: 登録前に予約一覧で同 KIREIDOT予約ID / 同条件の予約を探す。
//   * 空き枠が無ければ SLOT_NOT_AVAILABLE。
//   * スタッフ/メニューが解決できなければ STAFF_/MENU_MAPPING_NOT_FOUND。
//   * 確認画面が payload と一致しなければ CONFIRMATION_MISMATCH。
//   * reCAPTCHA は突破しない → RECAPTCHA_REQUIRED。
//   * 画面構造が不明・要素未検出のときは推測でクリックせず manual_required。
//
// ⚠️ セレクタは SalonBoard 予約登録画面の実 DOM が未確定のため暫定。
//    実画面の HTML / スクショ提供後に必ず調整すること (// TODO: SELECTOR)。
// ------------------------------------------------------------

/** JST の "YYYY-MM-DDTHH:mm" 形式に分解する。 */
function parseJstParts(iso: string): {
  date: string; // YYYY-MM-DD
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  hhmm: string; // HH:mm
} | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const jst = new Date(t + 9 * 3600_000);
  const year = jst.getUTCFullYear();
  const month = jst.getUTCMonth() + 1;
  const day = jst.getUTCDate();
  const hour = jst.getUTCHours();
  const minute = jst.getUTCMinutes();
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${year}-${pad(month)}-${pad(day)}`,
    year,
    month,
    day,
    hour,
    minute,
    hhmm: `${pad(hour)}:${pad(minute)}`,
  };
}

async function hasRecaptcha(page: Page): Promise<boolean> {
  try {
    return (await page.locator('iframe[src*="recaptcha"]').count()) > 0;
  } catch {
    return false;
  }
}

function fail(
  reason: string,
  errorCode: SalonboardErrorCode,
  manualRequired: boolean,
): PushBookingResult {
  return { status: "failed", reason, errorCode, manualRequired };
}

// ------------------------------------------------------------
// debug capture (実 DOM 調査用)
//
// 予約登録フローで失敗したときに、セレクタ調整のための情報を保存する。
// 保存先: ~/.kireidot/salonboard-debug/push_booking/{YYYYMMDDThhmmss}_{job8}_{label}/
//   - meta.json        … URL / title / 表示テキスト抜粋 / 要素一覧 / 失敗ラベル
//   - page.html        … HTML スナップショット (秘匿情報をマスク)
//   - screenshot.png   … フルページスクリーンショット
//
// ⚠️ 個人情報・パスワードは保存しない:
//   - input/textarea の value は保存しない (名前・type・placeholder のみ)
//   - HTML 内のパスワード文字列はマスク
//   - payload の顧客名/電話/メール等も meta.json には入れない
// ------------------------------------------------------------
const DEBUG_CAPTURE = !/^(0|false|no)$/i.test(
  process.env.SALONBOARD_DEBUG_CAPTURE ?? "1",
);

/** screenshot 由来のタイムスタンプ。new Date() を1回だけ使う。 */
function debugStamp(): string {
  const d = new Date();
  const jst = new Date(d.getTime() + 9 * 3600_000);
  return jst.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "T");
}

/** HTML / テキストから秘匿情報をマスクする。 */
function scrubSensitive(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 3) {
      // 正規表現メタ文字をエスケープして全置換
      const esc = s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      out = out.replace(new RegExp(esc, "g"), "***REDACTED***");
    }
  }
  // type=password の value 属性は中身を落とす
  out = out.replace(
    /(<input[^>]*type=["']?password["']?[^>]*value=["'])[^"']*(["'])/gi,
    "$1***REDACTED***$2",
  );
  return out;
}

async function captureRegisterDebug(
  page: Page,
  job: Job,
  label: string,
  extraMeta?: Record<string, unknown>,
): Promise<string | null> {
  if (!DEBUG_CAPTURE) return null;
  try {
    const baseDir = join(
      homedir(),
      ".kireidot",
      "salonboard-debug",
      "push_booking",
    );
    const safeLabel = label.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
    const dir = join(
      baseDir,
      `${debugStamp()}_${job.id.slice(0, 8)}_${safeLabel}`,
    );
    mkdirSync(dir, { recursive: true, mode: 0o700 });

    // マスク対象: ログイン情報。job.payload の個人情報は meta に入れないので別途不要。
    const secrets = [job.credentials.password, job.credentials.login_id];

    // 1) URL / title
    const url = page.url();
    let title = "";
    try {
      title = await page.title();
    } catch {
      /* noop */
    }

    // 2) 要素一覧 (input/select/button/a)。value は採らない。
    let elements: unknown = [];
    try {
      elements = await page.evaluate(() => {
        const pick = (el: Element) => {
          const e = el as HTMLElement;
          const attr = (n: string) => e.getAttribute(n) ?? undefined;
          return {
            tag: e.tagName.toLowerCase(),
            type: attr("type"),
            name: attr("name"),
            id: attr("id"),
            placeholder: attr("placeholder"),
            // value は採らない (個人情報・パスワード保護)
            text: (e.textContent ?? "").trim().slice(0, 60) || undefined,
            href:
              e.tagName.toLowerCase() === "a"
                ? attr("href")?.slice(0, 200)
                : undefined,
            // select の option ラベルはスタッフ/メニュー名で調査に有用
            options:
              e.tagName.toLowerCase() === "select"
                ? Array.from((e as HTMLSelectElement).options)
                    .slice(0, 50)
                    .map((o) => ({
                      value: o.value?.slice(0, 80),
                      label: (o.textContent ?? "").trim().slice(0, 80),
                    }))
                : undefined,
          };
        };
        return Array.from(
          document.querySelectorAll("input, select, button, a"),
        )
          .slice(0, 400)
          .map(pick);
      });
    } catch {
      /* noop */
    }

    // 3) 表示テキスト (全文 = text.txt 用、抜粋 = meta.json 用)
    let textFull = "";
    let textExcerpt = "";
    try {
      const bodyText = await page.evaluate(
        () => document.body?.innerText ?? "",
      );
      textFull = scrubSensitive(bodyText.replace(/\n{3,}/g, "\n\n"), secrets);
      textExcerpt = textFull.slice(0, 4000);
    } catch {
      /* noop */
    }

    const meta = {
      captured_at_jst: debugStamp(),
      job_id: job.id,
      shop_id: job.shop_id,
      label,
      url,
      title,
      // payload は ID 系のみ (個人情報は入れない)
      booking_id: (job.payload as PushBookingPayload)?.booking_id ?? null,
      // openRegisterForm() のステップ診断 (クリック対象/モーダル/遷移の判断材料)
      diagnostics: extraMeta ?? null,
      elements,
      // 全文は text.txt に。meta には抜粋のみ (どちらもマスク済)。
      text_excerpt: textExcerpt,
    };

    writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2), {
      mode: 0o600,
    });

    // 表示テキスト全文 (マスク済) を text.txt にも出す。
    writeFileSync(join(dir, "text.txt"), textFull, { mode: 0o600 });

    // 要素一覧は単体でも参照しやすいよう elements.json にも出す。
    writeFileSync(join(dir, "elements.json"), JSON.stringify(elements, null, 2), {
      mode: 0o600,
    });

    // 4) HTML snapshot (マスク)
    try {
      const html = await page.content();
      writeFileSync(join(dir, "page.html"), scrubSensitive(html, secrets), {
        mode: 0o600,
      });
    } catch {
      /* noop */
    }

    // 5) screenshot
    try {
      await page.screenshot({ path: join(dir, "screenshot.png"), fullPage: true });
      try {
        chmodSync(join(dir, "screenshot.png"), 0o600);
      } catch {
        /* noop */
      }
    } catch {
      /* noop */
    }

    console.log(`[debug] push_booking capture saved: ${dir}`);
    return dir;
  } catch (e) {
    console.warn(
      `[debug] capture failed: ${e instanceof Error ? e.message : e}`,
    );
    return null;
  }
}

// ------------------------------------------------------------
// SIGTERM/SIGINT クリティカルセクション保護 (設計 §6.2)
//
// Fargate Spot 中断・ECS デプロイ drain は SIGTERM → (stopTimeout 後) SIGKILL で
// 届く。登録ボタン押下後に SIGKILL されると登録成否が不明になり二重登録リスクが
// 生じるため、停止要求は「ジョブ間 (main の stopping)」に加えて push_booking の
// 「登録ボタン押下前」でも観測する:
//   - 押下前に停止要求あり → 安全に中断して retryable_failed (再キューに任せる)
//   - 押下後               → 中断せず callback まで完走する (stopTimeout=120s 内)
// ------------------------------------------------------------
let shutdownRequested = false;
function requestShutdown(): void {
  shutdownRequested = true;
}
function isShutdownRequested(): boolean {
  return shutdownRequested;
}

/**
 * SalonBoard アクセス時のブラウザコンテキスト共通設定。
 * Akamai が UA "HeadlessChrome" を即時 flag するため、worker 本体と同じ UA 偽装を
 * canary / test-rescan 等の再利用側でも必ず適用すること。
 */
const SB_CONTEXT_OPTIONS = {
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  locale: "ja-JP",
  timezoneId: "Asia/Tokyo",
} as const;

/**
 * push_booking を実証済み scrapers.cjs pushBookingViaForm に委譲する。
 * cloud worker は PC と同じ proven 実装を再利用する。worker.ts 独自の pushBooking() は
 * エステ登録フォームの必須項目 (カナ / 設備ベッド / 確認ダイアログ accept 等) を取りこぼし
 * 続け、ライブ schedule DOM への依存も強かったため委譲に切替。proven 版は schedule を
 * `#rlastupdate` 取得のためだけに開き (grid/staffヘッダ非依存)、フォーム入力・確認ダイアログ・
 * 完了 reconcile まで一通り正しい。返り値 shape は PushBookingResult 互換。
 */
async function pushBookingViaProvenForm(
  page: Page,
  job: Job,
  p: PushBookingPayload,
  loginEndpoint = "direct",
): Promise<PushBookingResult> {
  // 不完全ペイロードで登録フォームが埋められずハングするのを防ぐ早期検証。
  // scheduled_at / staff は必須(scrapers.pushBookingViaForm でも必須)。
  // **メニューは任意** — SalonBoard 予約フォームは netCouponId 未選択(-)でも登録可能で、
  // scrapers が menuTarget=null をスキップして「メニュー無し」で登録する(中谷雅 YG80969554 実証)。
  // ユーザー方針(2026-06-29: KIREIDOT と SB を差分ゼロに):メニュー未選択でも SB 登録する。
  // → メニュー検証はしない(以前 MENU_MAPPING_NOT_FOUND で誤ってブロックしていたのを撤去)。
  if (!p.scheduled_at) {
    return fail("payload に予約日時(scheduled_at)がありません — 新規登録不能", "UNKNOWN_ERROR", true);
  }
  if (!p.salonboard_staff_external_id) {
    return fail(
      "KIREIDOTスタッフに対応するSalonBoardスタッフ(external_id)が見つかりません — スタッフ連携を確認してください",
      "STAFF_MAPPING_NOT_FOUND",
      true,
    );
  }
  // メニューは任意。KIREIDOT がメニュー未設定で予約作成できる以上、SB もメニュー無しで登録する
  // (SB 予約フォームの netCouponId は未選択(-)でも登録可能。scrapers.pushBookingViaForm が
  //  menuTarget=null をスキップして登録する)。よってメニュー検証はしない(2026-06-29 方針)。
  const baseUrl = job.credentials.base_url ?? "https://salonboard.com/";
  const salonId =
    (job.credentials as { salon_id?: string | null }).salon_id ?? null;
  const shopName = (job as { shop_name?: string | null }).shop_name ?? null;
  // reserveId reconcile の scrapeBookings 用 (hair/esthetic で一覧構造が違う)。
  const genre = (job as { genre?: string }).genre === "hair" ? "hair" : "esthetic";
  const result = await (
    scrapers as unknown as {
      pushBookingViaForm: (
        pg: Page,
        payload: PushBookingPayload,
        opts: {
          baseUrl: string;
          enablePush: boolean;
          salonId: string | null;
          shopName: string | null;
          genre: string;
          relogin?: () => Promise<boolean>;
        },
      ) => Promise<PushBookingResult>;
    }
  ).pushBookingViaForm(page, p, {
    baseUrl,
    enablePush: ENABLE_PUSH,
    salonId,
    shopName,
    genre,
    // 失効時の同一ジョブ内自己回復 (スケジュール到達時に expired を踏んだら1回だけ再ログイン)。
    relogin: makeRelogin(page, baseUrl, job.credentials, job.shop_id, loginEndpoint),
  });
  return result;
}

/**
 * @deprecated 欠陥のある独自 reimplementation (必須項目の取りこぼし多数)。
 * 代わりに pushBookingViaProvenForm (scrapers.cjs pushBookingViaForm へ委譲) を使う。
 * 呼び出し元なし (将来削除)。
 */
async function pushBooking(
  page: Page,
  job: Job,
  p: PushBookingPayload,
): Promise<PushBookingResult> {
  const baseUrl = job.credentials.base_url ?? "https://salonboard.com/";

  // 停止要求済みならブラウザ操作を始める前に中断 (drain を速くする)。
  if (isShutdownRequested()) {
    return fail(
      "停止要求(SIGTERM)を受信したためジョブ開始前に中断しました (再試行可)",
      "UNKNOWN_ERROR",
      false,
    );
  }

  // --- payload バリデーション (致命的不足は manual_required) ---
  if (!p.booking_id || !p.scheduled_at) {
    return fail(
      "payload missing booking_id or scheduled_at",
      "UNKNOWN_ERROR",
      true,
    );
  }
  const when = parseJstParts(p.scheduled_at);
  if (!when) {
    return fail(`invalid scheduled_at: ${p.scheduled_at}`, "UNKNOWN_ERROR", true);
  }
  const yyyymmdd = `${when.year}${String(when.month).padStart(2, "0")}${String(
    when.day,
  ).padStart(2, "0")}`;

  // スタッフマッピング必須 (booking.md §9)。
  // 予約スケジュールは external_id (W001######) でスタッフ列を特定するため、
  // external_id が無ければ登録不能。
  if (!p.salonboard_staff_external_id) {
    return fail(
      "KIREIDOTスタッフに対応するSalonBoardスタッフ(external_id)が見つかりません",
      "STAFF_MAPPING_NOT_FOUND",
      true,
    );
  }
  // メニュー/クーポンのいずれかは必須 (booking.md §8)。
  const menuTarget = p.salonboard_menu_name || p.menu_name || p.coupon_name;
  if (!menuTarget) {
    return fail(
      "SalonBoardメニュー/クーポン名が解決できません",
      "MENU_MAPPING_NOT_FOUND",
      true,
    );
  }

  const kireidotRef = p.kireidot_ref ?? `KIREIDOT予約ID: ${p.booking_id}`;

  // ----------------------------------------------------------
  // 1) 予約スケジュールを開く (新規予約の起点)
  // ----------------------------------------------------------
  const schedUrl = scheduleUrl(baseUrl, yyyymmdd);
  try {
    await gotoResilient(
      page,
      schedUrl,
      { waitUntil: "domcontentloaded", timeout: 25_000 },
      "schedule",
    );
  } catch (e) {
    return fail(
      `予約スケジュールを開けません: ${e instanceof Error ? e.message : e}`,
      "UNKNOWN_ERROR",
      false, // 一時的な可能性 → retryable
    );
  }
  if (await hasRecaptcha(page)) {
    return fail("reCAPTCHA on schedule", "RECAPTCHA_REQUIRED", true);
  }

  // グリッドが描画されるまで待つ。
  // クラウド(EC2+プロキシ)ではログイン後の深い認証ページ(スケジュール)が
  // domcontentloaded 直後にはグリッド未描画のことがある。proven な scrapeBookings と
  // 同様に networkidle を待ち、さらにグリッド要素の出現を明示的に待ってから判定する
  // (即 count()===0 だと一時的な未描画を「グリッドなし」と誤判定する)。
  await page.waitForLoadState("networkidle", { timeout: 3_500 }).catch(() => {});
  const grid = page.locator(SCHEDULE.grid.selector).first();
  await grid.waitFor({ state: "attached", timeout: 12_000 }).catch(() => {});
  if ((await grid.count().catch(() => 0)) === 0) {
    await captureRegisterDebug(page, job, "schedule_grid_not_found", {
      url: page.url(),
    });
    return fail(
      "予約スケジュールのグリッドが見つかりません",
      "UNKNOWN_ERROR",
      true,
    );
  }

  // スケジュール画面の更新タイムスタンプ (#rlastupdate) を取得しておく。
  // これを登録フォーム URL に付与しないと moduleId=KPCL017V01 が
  // 「情報が一部失われています」エラーになるため、スケジュールを開いた今のうちに読む。
  await page
    .locator(SCHEDULE.rlastupdate.selector)
    .first()
    .waitFor({ state: "attached", timeout: 8_000 })
    .catch(() => {});
  const rlastupdate =
    (
      await page
        .locator(SCHEDULE.rlastupdate.selector)
        .first()
        .textContent()
        .catch(() => "")
    )?.trim() || "";

  // 対象スタッフがその日のスケジュールに存在するかを external_id + 日付で確認。
  // 新旧 DOM 両対応 (新: stockNameList の option / 旧: 列ヘッダ id)。
  // 無ければシフト外/退職などで登録不能。
  const staffHead = page
    .locator(staffPresenceSelector(p.salonboard_staff_external_id, yyyymmdd))
    .first();
  if ((await staffHead.count().catch(() => 0)) === 0) {
    await captureRegisterDebug(page, job, "staff_column_not_found");
    return fail(
      `スケジュールに対象スタッフ(${p.salonboard_staff_external_id})の列が見つかりません`,
      "STAFF_MAPPING_NOT_FOUND",
      true,
    );
  }

  // ----------------------------------------------------------
  // 2) 二重登録チェック: 対象スタッフ列の既存予約と時間帯が重ならないか
  //
  // ⚠️ 重要な制約: 実 DOM (booking.html) では予約ブロックがどのスタッフ列に
  //    属するかを静的に特定できない (setArea 23 個 vs スタッフ 18 人、共通 id 無し)。
  //    また予約一覧(reserveList)には備考列が無く KIREIDOT予約ID で照合できない。
  //    そのため「全予約ブロックとの時間帯重なり」で判定すると、別スタッフの予約まで
  //    重複扱いして誤って synced にしてしまう (= 危険な誤判定)。
  //
  //    よって現段階では「重なりブロックがあれば overlap 候補」を検出するに留め、
  //    自動で already_exists (synced) にはしない。候補があれば登録フローを止めて
  //    manual_required にし、人が確認する。確実な重複検出は、登録フォーム/予約詳細
  //    DOM 確定後に「KIREIDOT予約ID メモ照合」で行う (TODO)。
  let overlapCandidate = false;
  try {
    const blocks = page.locator(SCHEDULE.reservationBlock.selector);
    const n = await blocks.count().catch(() => 0);
    const targetStart = when.hour * 60 + when.minute;
    const targetEnd = targetStart + (p.duration_min ?? 60);
    for (let i = 0; i < n; i++) {
      const tzText = await blocks
        .nth(i)
        .locator(SCHEDULE.reservationTimeZone.selector)
        .first()
        .textContent()
        .catch(() => null);
      if (!tzText) continue;
      const m = tzText.match(/"(\d{1,2}:\d{2})"\s*,\s*"(\d{1,2}:\d{2})"/);
      if (!m) continue;
      const startMin = hhmmToMin(m[1]);
      const endMin = hhmmToMin(m[2]);
      if (targetStart < endMin && startMin < targetEnd) {
        overlapCandidate = true;
        break;
      }
    }
  } catch {
    /* 検出失敗は overlapCandidate=false のまま続行 */
  }
  if (overlapCandidate) {
    await captureRegisterDebug(page, job, "overlap_candidate");
    return fail(
      "対象時間帯に既存予約が存在する可能性があります(スタッフ別の確定判定が未対応)。二重登録防止のため自動登録せず手動確認に回します。",
      "ALREADY_EXISTS",
      true,
    );
  }

  // ----------------------------------------------------------
  // 3) 新規予約登録フォームを直接 URL で開く (booking_create.html)
  //    /KLP/reserve/ext/extReserveRegist/?staffId=&date=&rsvHour=&rsvMinute=
  //    スケジュールの空き枠クリックは不要。確認画面を挟まない 1 ページ構成。
  // ----------------------------------------------------------
  const startHH = String(when.hour).padStart(2, "0");
  const startMM = String(when.minute).padStart(2, "0");
  const registUrl = reserveRegistUrl(
    baseUrl,
    p.salonboard_staff_external_id,
    yyyymmdd,
    startHH,
    startMM,
    rlastupdate,
  );
  if (!rlastupdate) {
    console.warn(
      `[push] #rlastupdate を取得できませんでした。登録フォームが KPCL017V01 (情報が一部失われています) になる可能性があります。`,
    );
  }
  try {
    await gotoResilient(
      page,
      registUrl,
      { waitUntil: "domcontentloaded", timeout: 25_000 },
      "register-form",
    );
    await page.waitForLoadState("networkidle", { timeout: 3_500 }).catch(() => {});
  } catch (e) {
    return fail(
      `予約登録フォームを開けません: ${e instanceof Error ? e.message : e}`,
      "UNKNOWN_ERROR",
      false,
    );
  }
  if (await hasRecaptcha(page)) {
    return fail("reCAPTCHA on register form", "RECAPTCHA_REQUIRED", true);
  }

  // フォームが開けたか確認
  const formReady =
    (await page
      .locator(REGISTER_FORM.formReadyIndicators.selector)
      .first()
      .count()
      .catch(() => 0)) > 0;
  if (!formReady) {
    // どの画面に居るかを診断に含める (rlastupdate 不足による KPCL017V01 等の切り分け)。
    const diag = await page
      .evaluate(() => {
        const forms = Array.from(document.querySelectorAll("form"))
          .map((f) => f.id || f.getAttribute("name") || f.getAttribute("action") || "?")
          .slice(0, 5);
        const body = (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 200);
        return { url: location.href, title: document.title, forms, body };
      })
      .catch(() => ({ url: page.url(), title: "?", forms: [] as string[], body: "?" }));
    await captureRegisterDebug(page, job, "register_page_not_found", {
      url: diag.url,
      rlastupdate: rlastupdate || null,
      title: diag.title,
      forms: diag.forms,
    });
    return fail(
      `予約登録フォームに到達できませんでした (ログイン切れ/画面変更/情報欠落の可能性。rlastupdate=${
        rlastupdate || "なし"
      })。url=${diag.url} title="${diag.title}" forms=[${diag.forms.join(",")}] body="${diag.body}"`,
      "CONFIRMATION_MISMATCH",
      true,
    );
  }

  // ----------------------------------------------------------
  // 4) フォーム入力
  // ----------------------------------------------------------
  // formReady確認後なので、ジャンル差で存在しない任意項目を長時間待たない。
  // 旧実装は最大30秒/項目の直列待機となり、入力だけで90秒を消費していた。
  const formFieldTimeoutMs = 750;
  // スタッフ (URL で初期選択されるが念のため value=external_id で明示)
  const staffSel = page.locator(REGISTER_FORM.staffSelect.selector).first();
  if ((await staffSel.count().catch(() => 0)) > 0) {
    await staffSel
      .selectOption({ value: p.salonboard_staff_external_id }, { timeout: formFieldTimeoutMs })
      .catch(async () => {
        if (p.staff_name) await staffSel.selectOption({ label: p.staff_name }, { timeout: formFieldTimeoutMs }).catch(() => {});
      });
  }

  // hidden staffId / 担当割当セレクトを external_id へ強制同期する。
  // 表示用 salonStaffList を選んでも、実際に送信される hidden input#staffId と
  // 担当割当 select[name=staffIdList] が既定スタッフのままだと
  // 「どのスタッフを選んでも既定スタッフで登録される」取り違えが起きる。
  // JS で値を揃え、SalonBoard 側ハンドラ向けに input/change を発火させる
  // (実証済み scrapers.cjs pushBookingViaForm と同処理)。
  await page
    .evaluate(
      ({ ext, hiddenSel, listSels }) => {
        const setVal = (el: Element | null, v: string) => {
          if (!el) return;
          (el as HTMLInputElement | HTMLSelectElement).value = v;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        };
        document.querySelectorAll(hiddenSel).forEach((el) => setVal(el, ext));
        for (const sel of listSels) {
          const el = document.querySelector(sel) as HTMLSelectElement | null;
          if (el && Array.from(el.options).some((o) => o.value === ext)) {
            setVal(el, ext);
          }
        }
      },
      {
        ext: p.salonboard_staff_external_id,
        hiddenSel: REGISTER_FORM.staffHiddenId.selector,
        listSels: [
          REGISTER_FORM.staffSelect.selector,
          REGISTER_FORM.staffIdList.selector,
        ],
      },
    )
    .catch(() => {});

  // hidden staffId が実際に external_id へ揃ったか検証 (取り違え防止の最終確認)。
  // 揃っていなければ確定操作に進まず manual_required に倒す。
  const appliedStaffId = await page
    .locator(REGISTER_FORM.staffHiddenId.selector)
    .first()
    .inputValue({ timeout: formFieldTimeoutMs })
    .catch(() => null);
  if (appliedStaffId && appliedStaffId !== p.salonboard_staff_external_id) {
    await captureRegisterDebug(page, job, "staff_id_mismatch", {
      expected: p.salonboard_staff_external_id,
      applied: appliedStaffId,
    });
    return fail(
      `スタッフ ID をフォームに反映できませんでした (期待=${p.salonboard_staff_external_id} 実際=${appliedStaffId})。スタッフ取り違え防止のため自動登録を中止します。`,
      "STAFF_MAPPING_NOT_FOUND",
      true,
    );
  }

  // 開始 時/分 (URL でも入るが明示)
  await page
    .locator(REGISTER_FORM.startHour.selector)
    .first()
    .selectOption({ value: String(when.hour) }, { timeout: formFieldTimeoutMs })
    .catch(() => {});
  await page
    .locator(REGISTER_FORM.startMinute.selector)
    .first()
    .selectOption({ value: startMM }, { timeout: formFieldTimeoutMs })
    .catch(() => {});

  // 所要時間 → 終了時間。rsvTermHour の option value は「分換算」(60=1時間)。
  // duration_min を 60 で割った時間ぶんを value にし、端数を rsvTermMinute に。
  const durMin = p.duration_min ?? 60;
  const termHourVal = String(Math.floor(durMin / 60) * 60); // 例 90分→"60"
  const termMinVal = String(durMin % 60).padStart(2, "0"); // 例 90分→"30"
  await page
    .locator(REGISTER_FORM.termHour.selector)
    .first()
    .selectOption({ value: termHourVal }, { timeout: formFieldTimeoutMs })
    .catch(() => {});
  await page
    .locator(REGISTER_FORM.termMinute.selector)
    .first()
    .selectOption({ value: termMinVal }, { timeout: formFieldTimeoutMs })
    .catch(() => {});

  // メニュー = ネット予約クーポン。label 完全一致 → 部分一致の順で試す。
  let menuFilled = false;
  const menuSel = page.locator(REGISTER_FORM.menuSelect.selector).first();
  if ((await menuSel.count().catch(() => 0)) > 0) {
    await menuSel
      .selectOption({ label: menuTarget }, { timeout: formFieldTimeoutMs })
      .then(() => { menuFilled = true; })
      .catch(() => {});
    if (!menuFilled) {
      // 部分一致: option のラベルに menuTarget を含むものを value で選ぶ
      const val = await menuSel
        .evaluate((el, target) => {
          const sel = el as HTMLSelectElement;
          const opt = Array.from(sel.options).find((o) =>
            (o.textContent || "").includes(target as string),
          );
          return opt ? opt.value : null;
        }, menuTarget)
        .catch(() => null);
      if (val) {
        await menuSel.selectOption({ value: val }, { timeout: formFieldTimeoutMs }).then(() => { menuFilled = true; }).catch(() => {});
      }
    }
  }
  if (!menuFilled) {
    await captureRegisterDebug(page, job, "menu_not_found", { menuTarget });
    return fail(
      `SalonBoardメニュー/クーポンが見つかりません: ${menuTarget}。メニュー管理で SalonBoard メニューと紐付けてください。`,
      "MENU_MAPPING_NOT_FOUND",
      true,
    );
  }

  // 顧客名 (姓名分割) + カナ。
  // ⚠️ カナ (nmSeiKana/nmMeiKana) は SalonBoard で必須入力。未入力だと登録フォームが
  // errorInput=true になり「登録する」ボタンが無効化されて送信できず、予約が作られない
  // (2026-06-23 実機検証で判明: a#regist の onclick が errorInput=true;return false に)。
  // 実証済み scrapers.cjs pushBookingViaForm と同じく姓/名/セイ/メイを必ず埋める。
  {
    const cleanName = (s: string) => String(s || "").replace(/\s+/g, " ").trim();
    // カナ用: 全角カタカナ + 長音 + 中黒のみ残す (半角/漢字は除去)。取れなければ汎用カナ。
    const cleanKana = (s: string) =>
      String(s || "").replace(/[^゠-ヿー・\s]/g, "").replace(/\s+/g, " ").trim();
    const rawName = (p.customer_name && p.customer_name.trim()) || "ゲスト";
    const cleaned = cleanName(rawName) || "ゲスト";
    const parts = cleaned.split(/[\s　]+/).filter(Boolean);
    const sei = parts[0] || cleaned || "ゲスト";
    const mei = parts.slice(1).join("") || "様";
    const seiKana = cleanKana(sei) || "ヨヤク";
    const meiKana = cleanKana(mei) || "キャクサマ";
    await page.locator(REGISTER_FORM.customerSei.selector).first().fill(sei, { timeout: formFieldTimeoutMs }).catch(() => {});
    await page.locator(REGISTER_FORM.customerMei.selector).first().fill(mei, { timeout: formFieldTimeoutMs }).catch(() => {});
    await page.locator(REGISTER_FORM.customerSeiKana.selector).first().fill(seiKana, { timeout: formFieldTimeoutMs }).catch(() => {});
    await page.locator(REGISTER_FORM.customerMeiKana.selector).first().fill(meiKana, { timeout: formFieldTimeoutMs }).catch(() => {});
  }
  // 電話 (任意・ハイフン無し数字のみ)
  if (p.customer_phone) {
    const tel = String(p.customer_phone).replace(/[^\d]/g, "");
    if (tel) await page.locator(REGISTER_FORM.customerPhone.selector).first().fill(tel, { timeout: formFieldTimeoutMs }).catch(() => {});
  }
  // 備考 (KIREIDOT予約ID を必ず入れる → 二重登録チェックの照合キー)
  {
    const notesText =
      p.notes && p.notes.includes(kireidotRef)
        ? p.notes
        : `${p.notes ? p.notes + "\n" : ""}${kireidotRef}`;
    await page.locator(REGISTER_FORM.memo.selector).first().fill(notesText, { timeout: formFieldTimeoutMs }).catch(() => {});
  }

  // 設備(席/ベッド)割当。⚠️ エステ等ベッドのある店舗では登録フォームの #equipArea で
  // 設備の指定が必須のことがあり、未設定だと errorInput=true で「登録する」が無効化され
  // 登録されない (2026-06-24 実機検証で判明: confirm は出るが onclick=errorInput;return false)。
  // 実証済み scrapers.cjs pushBookingViaForm と同処理: payload 指定設備(EQ/名前)優先、
  // 無ければ空いているベッド/席を1台だけ選ぶ。設備欄がある店舗では設備必須とし、
  // 空き設備が無い・複数設備行を解消できない場合は登録しない。
  try {
    const pp = p as unknown as {
      salonboard_equipment_external_id?: string | null;
      salonboard_equipment_name?: string | null;
    };
    const wantedEquipId =
      (pp.salonboard_equipment_external_id || "").trim() || null;
    const wantedEquipName = (pp.salonboard_equipment_name || "").trim() || null;
    const equipSelector = 'select[name="equipIdList"], #equipArea select.equipIdList';
    const hasEquipArea =
      (await page.locator("#equipArea, #equipAdd").first().count().catch(() => 0)) >
      0;
    if (hasEquipArea) {
      // 設備行が無ければ「追加する」(#equipAdd) を押して 1 行作る。
      if ((await page.locator(equipSelector).count().catch(() => 0)) === 0) {
        const addBtn = page.locator('#equipAdd, a[id="equipAdd"]').first();
        if ((await addBtn.count().catch(() => 0)) > 0) {
          await addBtn.click().catch(() => {});
          await page
            .waitForSelector(equipSelector, { timeout: 1_500 })
            .catch(() => {});
        }
      }
      const equipSelects = page.locator(equipSelector);
      const n = await equipSelects.count().catch(() => 0);
      if (n === 0) {
        return {
          status: "failed",
          reason: "設備必須店舗ですが、予約フォームに設備選択行を作成できませんでした。",
          errorCode: "EQUIPMENT_FULL",
          manualRequired: true,
        };
      }

      // 既存フォームに複数の設備行があっても、予約には1台だけを割り当てる。
      // 2行目以降を空へ戻せない場合は、複数ベッド登録を避けるため送信しない。
      for (let i = 1; i < n; i++) {
        const extra = equipSelects.nth(i);
        const emptyValue = await extra.evaluate((el) => {
          const option = Array.from((el as HTMLSelectElement).options).find(
            (o) => !o.value,
          );
          return option ? option.value : null;
        }).catch(() => null);
        if (emptyValue === null) {
          return {
            status: "failed",
            reason: "複数の設備行があり、余分な設備割当を解除できないため登録を停止しました。",
            errorCode: "EQUIPMENT_FULL",
            manualRequired: true,
          };
        }
        await extra.selectOption({ value: emptyValue }, { timeout: formFieldTimeoutMs });
        await extra.evaluate((el) => {
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        });
      }

      for (let i = 0; i < 1; i++) {
        const sel = equipSelects.nth(i);
        const pick = await sel
          .evaluate(
            (el, args) => {
              const { wantId, wantName } = args as {
                wantId: string | null;
                wantName: string | null;
              };
              const opts = Array.from((el as HTMLSelectElement).options);
              const norm = (s: string) => (s || "").replace(/[○×\s]/g, "");
              const isAvailable = (o: HTMLOptionElement) =>
                !!o.value && !/×/.test(o.textContent || "");
              if (wantId) {
                const o = opts.find((o) => o.value === wantId && isAvailable(o));
                if (o) return o.value;
              }
              if (wantName) {
                const o = opts.find(
                  (o) =>
                    norm(o.textContent || "") === norm(wantName) &&
                    isAvailable(o),
                );
                if (o) return o.value;
              }
              const isBed = (o: HTMLOptionElement) =>
                /ベッド|ベット|席/.test(o.textContent || "");
              return (
                opts.find((o) => isBed(o) && /○/.test(o.textContent || "")) ||
                opts.find((o) => isBed(o) && isAvailable(o)) ||
                opts.find((o) => /○/.test(o.textContent || "") && !!o.value)
              )?.value || null;
            },
            { wantId: wantedEquipId, wantName: wantedEquipName },
          )
          .catch(() => null);
        if (pick) {
          await sel.selectOption({ value: pick }, { timeout: formFieldTimeoutMs }).catch(() => {});
        } else {
          return {
            status: "failed",
            reason: "予約時間帯に割り当て可能なベッド/席がありません。",
            errorCode: "EQUIPMENT_FULL",
            manualRequired: true,
          };
        }
        // SalonBoard 側の検証 (errorInput クリア) を起こすため input/change 発火。
        await sel
          .evaluate((el) => {
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          })
          .catch(() => {});
      }
    }
  } catch (e) {
    return {
      status: "failed",
      reason: `必須設備の割当処理に失敗しました: ${e instanceof Error ? e.message : String(e)}`,
      errorCode: "EQUIPMENT_FULL",
      manualRequired: true,
    };
  }

  // ⚠️ 空き枠/エラー検出はここ (入力直後・送信前) では行わない。
  // 以前はページ全体テキスト `/予約できません|空いて|満員|埋ま|重複/` を検索していたが、
  // 登録フォームに常設の注意書き「メニューとの重複登録にご注意ください。」の「重複」に
  // 誤マッチし、空き枠でも常に SLOT_NOT_AVAILABLE になっていた (2026-06-21 実機検証で判明)。
  // 実証済み scrapers.cjs pushBookingViaForm と同様、エラー判定は「登録ボタン押下後」に
  // 警告/エラー領域へスコープして行う (下記 §5)。
  const confirmed: CallbackBody["result_payload"] = {
    confirmed_customer_name: p.customer_name ?? null,
    confirmed_staff_name: p.staff_name ?? null,
    confirmed_menu_name: menuTarget,
    confirmed_scheduled_at: p.scheduled_at,
  };

  // ----------------------------------------------------------
  // 5) 登録 — ENABLE_PUSH=true のときだけ「登録する」を押す
  // ----------------------------------------------------------
  // 入力済みフォームを必ず capture (証跡)。ENABLE_PUSH=false なら押さず confirm_only。
  await captureRegisterDebug(page, job, ENABLE_PUSH ? "before_register" : "confirm_only", {
    enable_push: ENABLE_PUSH,
  });
  if (!ENABLE_PUSH) {
    // 診断モード (SALONBOARD_PUSH_DIAG=1): 「登録する」を押してダイアログ文言と直後ページを
    // 記録するが、ダイアログは必ず DISMISS (=確認ならキャンセル) して絶対に登録しない。
    // 「dialog=true なのに予約が作られない」原因 (確認 vs 検証アラート / ボタンの errorInput) の切り分け用。
    if (process.env.SALONBOARD_PUSH_DIAG === "1") {
      let diagMsg = "";
      let diagFired = false;
      const onDiag = async (d: Dialog) => {
        diagFired = true;
        diagMsg = d.message();
        console.log(
          `[push][diag] dialog(${d.type()}): "${diagMsg.slice(0, 180).replace(/\s+/g, " ")}" → dismiss(登録しない)`,
        );
        try {
          await d.dismiss();
        } catch {
          /* noop */
        }
      };
      page.on("dialog", onDiag);
      const btn = page.locator(REGISTER_FORM.registerButton.selector).first();
      const onclick = await btn.getAttribute("onclick").catch(() => null);
      const beforeUrl = page.url();
      await btn
        .click({ timeout: 10_000 })
        .catch((e) => console.log(`[push][diag] click err: ${e instanceof Error ? e.message : e}`));
      await page.waitForTimeout(2500);
      page.off("dialog", onDiag);
      console.log(
        `[push][diag] regist onclick="${onclick ?? ""}" dialogFired=${diagFired} dialog="${diagMsg.slice(0, 120)}" urlBefore=${beforeUrl} urlAfter=${page.url()}`,
      );
      await captureRegisterDebug(page, job, "push_diag", {
        registOnclick: onclick,
        dialogFired,
        diagMessage: diagMsg.slice(0, 200),
        urlBefore: beforeUrl,
        urlAfter: page.url(),
      });
    }
    return { status: "confirm_only", confirmed };
  }

  const registerBtn = page.locator(REGISTER_FORM.registerButton.selector).first();
  if ((await registerBtn.count().catch(() => 0)) === 0) {
    await captureRegisterDebug(page, job, "register_button_not_found");
    return fail("登録ボタン (登録する) が見つかりません", "UNKNOWN_ERROR", true);
  }

  // --- クリティカルセクション境界 (設計 §6.2) ---
  // ここが「登録ボタン押下前」の最終チェックポイント。停止要求を受けていたら
  // 押さずに中断する (押下後の SIGKILL = 登録成否不明を避ける)。
  // これより先 (click 以降) は停止要求があっても callback まで完走する。
  if (isShutdownRequested()) {
    await captureRegisterDebug(page, job, "aborted_before_register");
    return fail(
      "停止要求(SIGTERM)を受信したため登録ボタン押下前に中断しました (再試行可)",
      "UNKNOWN_ERROR",
      false,
    );
  }

  // 「登録する」を押すとネイティブ confirm()「予約を登録します。よろしいですか？」が出る。
  // ⚠️ Playwright は既定でダイアログを dismiss (=キャンセル→登録されない) ため、click 前に
  // accept(OK) するハンドラを仕込む (これが無いと送信がキャンセルされ予約が作られない。
  // 2026-06-23 実機検証で判明。実証済み scrapers.cjs pushBookingViaForm と同処理)。
  let dialogAccepted = false;
  let dialogMessage = "";
  const onDialog = async (d: Dialog) => {
    dialogAccepted = true;
    dialogMessage = d.message();
    console.log(
      `[push] dialog(${d.type()}): "${dialogMessage.slice(0, 150).replace(/\s+/g, " ")}" → accept`,
    );
    try {
      await d.accept();
    } catch {
      /* noop */
    }
  };
  page.on("dialog", onDialog);

  const beforeUrl = page.url();
  try {
    await registerBtn.click({ timeout: 15_000 }).catch(() => {});
    // 完了サイン (フォーム離脱 / 完了文言 / 詳細リンク / エラー領域) を最大15秒ポーリング。
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      await page.waitForTimeout(400);
      if (!/extReserveRegist/i.test(page.url())) break;
      const done = await page
        .locator(
          "a[href*='extReserveDetail'][href*='reserveId='], text=/完了しました|受け付けました|登録しました/",
        )
        .first()
        .count()
        .catch(() => 0);
      if (done > 0) break;
      const err = await page
        .locator(".mod_box_warning, #warningMessageArea, .error, .errorMessage")
        .first()
        .count()
        .catch(() => 0);
      if (err > 0) break;
    }
  } finally {
    page.off("dialog", onDialog);
  }

  // 診断: click 直後 (reconcile でナビゲートする前) のページ状態を記録。
  // ダイアログ文言 (確認 vs 検証アラート) と直後 URL を証跡に残す。
  await captureRegisterDebug(page, job, "post_submit_diag", {
    dialogAccepted,
    dialogMessage: dialogMessage.slice(0, 200),
    url: page.url(),
  });

  if (await hasRecaptcha(page)) {
    return fail(
      "登録後に reCAPTCHA が表示され、登録成否が判定できません",
      "RECAPTCHA_REQUIRED",
      true,
    );
  }

  // 登録結果のエラー/警告を「エラー領域」へスコープして判定する (ページ全体テキスト検索は
  // 静的注意書き「メニューとの重複登録にご注意ください」等に誤マッチするため不可)。
  // 実証済み scrapers.cjs pushBookingViaForm と同じエラー領域セレクタに揃える。
  const errText = (
    await page
      .locator(
        '.mod_box_warning, #warningMessageArea, .error, .errorMessage, [class*="error" i]',
      )
      .filter({ hasText: /\S/ })
      .first()
      .innerText()
      .catch(() => "")
  ).trim();
  if (errText && /予約できません|空いて|満員|埋ま|重複|登録できません/.test(errText)) {
    await captureRegisterDebug(page, job, "slot_not_available", {
      errText: errText.slice(0, 120),
    });
    return fail(
      `SalonBoard側で対象時間が空いていません (${errText.slice(0, 60)})`,
      "SLOT_NOT_AVAILABLE",
      false,
    );
  }
  if (errText && /エラー|失敗|できません/.test(errText)) {
    await captureRegisterDebug(page, job, "register_error", {
      errText: errText.slice(0, 120),
    });
    return fail(`登録時にエラー: ${errText.slice(0, 80)}`, "UNKNOWN_ERROR", true);
  }

  // 完了画面から reserveId / detail_url を抽出。
  const afterUrl = page.url();
  let externalId: string | null = null;
  let detailUrl: string | null = null;
  const detailLink = await page
    .locator(RESERVE_LIST.detailLink.selector)
    .first()
    .getAttribute("href")
    .catch(() => null);
  if (detailLink) {
    detailUrl = detailLink.startsWith("http")
      ? detailLink
      : new URL(detailLink, baseUrl).toString();
    const m = detailLink.match(RESERVE_ID_RE);
    if (m) externalId = m[1];
  }

  const doneText = await page
    .locator("text=/完了しました|受け付けました|登録しました|予約を登録しました/")
    .count()
    .catch(() => 0);
  // まだ登録フォーム上に居る = 送信されていない (確認ダイアログを押せなかった等)。
  const stillOnForm = /extReserveRegist/i.test(afterUrl);
  if (!dialogAccepted && stillOnForm) {
    await captureRegisterDebug(page, job, "register_dialog_not_confirmed");
    return fail(
      "登録確認ダイアログ (「予約を登録します。よろしいですか？」) を確定できませんでした。",
      "UNKNOWN_ERROR",
      true,
    );
  }

  // reserveList 再照合 (対象日 + 開始時刻 + スタッフ + 顧客名 で reserveId を特定)。
  // 完了サイン欠落時の成功判定 + reserveId バックフィルに使う (実証済み scrapers.cjs と同じ)。
  const reconcile = (): Promise<string | null> =>
    (
      scrapers as unknown as {
        findReserveIdForBooking: (
          p: Page,
          t: {
            yyyymmdd: string;
            hhmm: string;
            staffExt?: string | null;
            customerName?: string | null;
          },
          o: { baseUrl: string },
        ) => Promise<string | null>;
      }
    )
      .findReserveIdForBooking(
        page,
        {
          yyyymmdd,
          hhmm: `${startHH}:${startMM}`,
          staffExt: p.salonboard_staff_external_id,
          customerName: p.customer_name,
        },
        { baseUrl },
      )
      .catch(() => null);

  const looksDone =
    !!detailLink || doneText > 0 || (!stillOnForm && afterUrl !== beforeUrl);
  if (!looksDone) {
    // 完了サインは出なかったが確認ダイアログは受理済み (=送信された) なら登録済みの
    // 可能性が高い。reserveList を再照合し、見つかれば成功扱い (誤fail→再試行による
    // 二重登録を防ぐ)。
    if (dialogAccepted) {
      const recovered = await reconcile();
      if (recovered) {
        return {
          status: "ok",
          externalId: recovered,
          detailUrl: `${new URL(baseUrl).origin}/KLP/reserve/ext/extReserveDetail/?reserveId=${recovered}`,
          alreadyExists: false,
          confirmed,
        };
      }
    }
    await captureRegisterDebug(page, job, "completion_not_confirmed", {
      dialogAccepted,
      afterUrl,
    });
    return fail(
      `登録ボタンは押しましたが完了を確認できませんでした (dialog=${dialogAccepted})。SalonBoard で登録状況を確認してください。`,
      "UNKNOWN_ERROR",
      true,
    );
  }

  // 完了サインは出たが reserveId を拾えなかった場合は reserveList から補完。
  if (!externalId) {
    const found = await reconcile();
    if (found) {
      externalId = found;
      detailUrl =
        detailUrl ||
        `${new URL(baseUrl).origin}/KLP/reserve/ext/extReserveDetail/?reserveId=${found}`;
    }
  }

  // 登録完了サインが出ている場合は reserveId を回収できなくても成功扱いにする。
  // ここで再試行すると、既に登録済みの予約を重複作成する危険があるため。
  // external_booking_id は後続のメール取込/一括取込でバックフィルする。
  if (!externalId) {
    await captureRegisterDebug(page, job, "reserve_id_not_recovered", {
      dialogAccepted,
      afterUrl,
      looksDone,
    });
    return {
      status: "ok",
      externalId: null,
      detailUrl: null,
      alreadyExists: false,
      confirmed,
      idUnverified: true,
      warning: "登録完了を確認済み。SalonBoard予約IDは後続取込で補完します。",
    };
  }

  return { status: "ok", externalId, detailUrl, alreadyExists: false, confirmed };
}

/** "HH:MM" を分に変換。 */
function hhmmToMin(hhmm: string): number {
  const [h, m] = hhmm.split(":").map((x) => parseInt(x, 10));
  return (h || 0) * 60 + (m || 0);
}

/**
 * openRegisterForm() のステップ診断。
 * クリック対象・座標・モーダル・別ページ遷移のどれが正しいかを capture だけで
 * 判断できるよう、各ステップの観測結果を記録して返す。
 */
type OpenFormDiag = {
  /** フォーム指標 (formReadyIndicators) が出たか。 */
  opened: boolean;
  steps: string[];
  staffSelectFound: boolean;
  staffSelectApplied: boolean;
  setAreaCount: number;
  setAreaClicked: boolean;
  timeModalAppeared: boolean;
  timeLinkFound: boolean;
  timeLinkClicked: boolean;
  urlBefore: string;
  urlAfter: string;
  urlChanged: boolean;
  /** クリックで新規ページ/ポップアップ(別タブ)が開いたか。 */
  popupOpened: boolean;
  /** 開いたポップアップの URL (あれば)。 */
  popupUrl: string | null;
  formIndicatorCount: number;
  error: string | null;
  /** 開いたポップアップ Page (capture 用に呼び出し側へ渡す)。 */
  popupPage?: Page;
};

/**
 * 予約スケジュールから新規予約登録フォームを開く試み。
 *
 * 実 DOM (booking.html) より:
 *   - 各スタッフのドロップ領域: div.scheduleSetArea.jscScheduleSetArea
 *   - 開始時刻ピッカー(モーダル): a.scheduleTimePeriodLink[data-start-time="HHMM"]
 * 空き枠クリックでフォームが開く想定だが、開く先 (モーダル / 別ページ / 別タブ) が
 * 未確定。ここでは「フォームを開く操作」までを行い、各ステップの観測を診断として返す。
 * 危険な確定操作は一切しない。
 */
async function openRegisterForm(
  page: Page,
  p: PushBookingPayload,
  when: { hour: number; minute: number; hhmm: string },
  yyyymmdd: string,
): Promise<OpenFormDiag> {
  const startHHMM = `${String(when.hour).padStart(2, "0")}${String(
    when.minute,
  ).padStart(2, "0")}`;

  const diag: OpenFormDiag = {
    opened: false,
    steps: [],
    staffSelectFound: false,
    staffSelectApplied: false,
    setAreaCount: 0,
    setAreaClicked: false,
    timeModalAppeared: false,
    timeLinkFound: false,
    timeLinkClicked: false,
    urlBefore: page.url(),
    urlAfter: page.url(),
    urlChanged: false,
    popupOpened: false,
    popupUrl: null,
    formIndicatorCount: 0,
    error: null,
  };

  // クリックで別タブ/ポップアップが開くケースを検知する。
  let popup: Page | null = null;
  const onPopup = (pg: Page) => {
    if (!popup) popup = pg;
  };
  try {
    page.context().on("page", onPopup);

    // stockNameList があればスタッフを選択しておく (列の絞り込みに使える環境向け)。
    const staffSelect = page.locator(SCHEDULE.staffSelect.selector).first();
    diag.staffSelectFound = (await staffSelect.count().catch(() => 0)) > 0;
    if (diag.staffSelectFound) {
      await staffSelect
        .selectOption({
          value: staffOptionValue(p.salonboard_staff_external_id!, yyyymmdd),
        })
        .then(() => {
          diag.staffSelectApplied = true;
          diag.steps.push("staffSelect: applied");
        })
        .catch((e) => diag.steps.push(`staffSelect: failed ${e?.message ?? e}`));
    } else {
      diag.steps.push("staffSelect: not found");
    }

    // setArea をクリックして枠を開く。対象スタッフ列との対応付けが未確定なため先頭を試行。
    const setArea = page.locator(SCHEDULE.setArea.selector);
    diag.setAreaCount = await setArea.count().catch(() => 0);
    if (diag.setAreaCount > 0) {
      await setArea
        .first()
        .click({ timeout: 8_000, force: true })
        .then(() => {
          diag.setAreaClicked = true;
          diag.steps.push("setArea[0]: clicked (force)");
        })
        .catch((e) => diag.steps.push(`setArea[0]: click failed ${e?.message ?? e}`));
    } else {
      diag.steps.push("setArea: none found");
    }

    // 時刻モーダルが出たか。
    await page.waitForTimeout(600);
    diag.timeModalAppeared =
      (await page
        .locator(SCHEDULE.timePeriodModal.selector)
        .first()
        .isVisible()
        .catch(() => false)) || false;
    diag.steps.push(`timeModalVisible: ${diag.timeModalAppeared}`);

    // 対象 data-start-time のリンクがあれば選ぶ。
    const timeLink = page
      .locator(`a.scheduleTimePeriodLink[data-start-time="${startHHMM}"]`)
      .first();
    diag.timeLinkFound = (await timeLink.count().catch(() => 0)) > 0;
    if (diag.timeLinkFound) {
      await timeLink
        .click({ timeout: 8_000 })
        .then(() => {
          diag.timeLinkClicked = true;
          diag.steps.push(`timeLink[${startHHMM}]: clicked`);
        })
        .catch((e) => diag.steps.push(`timeLink: click failed ${e?.message ?? e}`));
    } else {
      diag.steps.push(`timeLink[${startHHMM}]: not found`);
    }

    // 反映待ち。
    await page.waitForTimeout(1200);

    // 別ページ/ポップアップが開いていれば記録 (capture 用に渡す)。
    if (popup) {
      diag.popupOpened = true;
      try {
        await (popup as Page).waitForLoadState("domcontentloaded", {
          timeout: 8_000,
        });
      } catch {
        /* noop */
      }
      diag.popupUrl = (popup as Page).url();
      diag.popupPage = popup as Page;
      diag.steps.push(`popup opened: ${diag.popupUrl}`);
    }

    diag.urlAfter = page.url();
    diag.urlChanged = diag.urlAfter !== diag.urlBefore;
    diag.steps.push(`urlChanged: ${diag.urlChanged} (${diag.urlAfter})`);

    // フォーム画面の指標が出たか (pending な指標だが、出れば opened)。
    const indicator = page.locator(REGISTER_FORM.formReadyIndicators.selector);
    diag.formIndicatorCount = await indicator.count().catch(() => 0);
    // ポップアップ側にフォームがある可能性もある。
    let popupHasForm = 0;
    if (diag.popupPage) {
      popupHasForm = await diag.popupPage
        .locator(REGISTER_FORM.formReadyIndicators.selector)
        .count()
        .catch(() => 0);
    }
    diag.opened =
      diag.formIndicatorCount > 0 || popupHasForm > 0 || diag.popupOpened;
    diag.steps.push(
      `formIndicators: page=${diag.formIndicatorCount} popup=${popupHasForm}`,
    );
  } catch (e) {
    diag.error = e instanceof Error ? e.message : String(e);
    diag.steps.push(`error: ${diag.error}`);
  } finally {
    try {
      page.context().off("page", onPopup);
    } catch {
      /* noop */
    }
  }
  return diag;
}

// ------------------------------------------------------------
// メインループ
// ------------------------------------------------------------
async function pollOnce(): Promise<number> {
  // IPプール設定時: ヘルスチェック(古ければ更新)。健全IPが無ければこのサイクルは処理せず
  // 待機し、フラグIPを叩き続けてフラグを延命させない (連鎖フラグ防止・IP回復を待つ)。
  if (proxyPoolList().length > 0) {
    if (
      _healthyProxies === null ||
      Date.now() - _lastProxyCheck > PROXY_CHECK_INTERVAL_MS
    ) {
      await refreshHealthyProxies();
    }
    // 健全な静的IPが無く、Residential フォールバックも未設定なら処理せず待機
    // (フラグIPを叩き続けない)。フォールバック設定時は pickProxy が住宅へ切替えるので続行。
    if (_healthyProxies && _healthyProxies.length === 0 && !fallbackConfigured()) {
      return 0;
    }
  }
  // 空きスロット分だけ claim する。claim関数が別店舗(=別レーン)のジョブを per-shop mutex で
  // 返すため、返ってきたジョブは互いに別店舗で安全に並行できる。
  const slots = maxConcurrency() - _inFlight.size;
  if (slots <= 0) return 0;
  let jobs: Job[];
  try {
    jobs = await fetchJobs(slots);
  } catch (e) {
    console.error(`[poll] fetch error: ${e instanceof Error ? e.message : e}`);
    return 0;
  }
  if (jobs.length === 0) return 0;
  for (const job of jobs) {
    // await しない: 別店舗レーンを並行処理。handleJobGuarded は必ず callback を返し、
    // 例外も内部で握って running を解除する(取りこぼし防止)。
    const p = withAccountJobGate(job, () => handleJobGuarded(job))
      .catch((e) =>
        console.error(`[job] guarded uncaught ${job.id.slice(0, 8)}: ${e}`)
      )
      .finally(() => {
        _inFlight.delete(job.id);
      });
    _inFlight.set(job.id, p);
  }
  return jobs.length;
}

// 取得系（予約取込・シフト取込など）は利用者操作のSLA対象ではないため、短い期限で
// 打ち切らない。完全な無制限だとブラウザ停止時に lane が永久占有されるので、10分を
// 「処理期限」ではなくハング検知の安全弁として共通適用する。
const READ_JOB_SAFETY_TIMEOUT_MS = Number(
  process.env.SB_READ_JOB_TIMEOUT_MS ??
    process.env.SB_FETCH_TIMEOUT_MS ??
    process.env.SB_JOB_TIMEOUT_MS ??
    10 * 60_000,
);
// cloud の予約書込は、3回の「Chrome完全再起動 + 出口切替 + 全工程再実行」を
// 6分以内で完結させる。5分30秒でハングを打ち切り、残り時間でcallback/PC移管を行う。
const CLOUD_BOOKING_FALLBACK_TIMEOUT_MS = Number(
  process.env.SB_CLOUD_BOOKING_FALLBACK_TIMEOUT_MS ?? 330_000,
);

function isCloudWorker(): boolean {
  return WORKER_CAPABILITIES.split(",").map((v) => v.trim()).includes("playwright_cloud");
}

function isBookingWrite(job: Job): boolean {
  return job.job_type === "push_booking" || job.job_type === "cancel_booking";
}

async function handleJobGuarded(job: Job): Promise<void> {
  const limitMs =
    isCloudWorker() && isBookingWrite(job)
      ? CLOUD_BOOKING_FALLBACK_TIMEOUT_MS
      : READ_JOB_SAFETY_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), limitMs);
  });
  try {
    const r = await Promise.race([handleJob(job).then(() => "done" as const), timeout]);
    if (r === "timeout") {
      _guardTimedOutJobs.set(job.id, Date.now());
      setTimeout(() => _guardTimedOutJobs.delete(job.id), 30 * 60_000);
      const secs = Math.round(limitMs / 1000);
      console.error(
        `[job] TIMEOUT ${job.job_type} ${job.id.slice(0, 8)} after ${secs}s — running を解除して再キューします`,
      );
      // ★タイムアウトで打ち切っても handleJob のブラウザは生きたまま残り、
      //   次ジョブが同一プロファイルへ突入して衝突(セッション相互破壊)していた。
      //   当該店舗プロファイルの Chrome を確実に kill して浮きブラウザを残さない。
      try {
        const udd = join(
          homedir(),
          ".kireidot",
          "salonboard-chrome-profile",
          sessionKeyFor(job.credentials.login_id, job.credentials.base_url ?? "https://salonboard.com/"),
        );
        execSync(`pkill -f -- "--user-data-dir=${udd}"`, { stdio: "ignore" });
        console.error(`[job] TIMEOUT ${job.id.slice(0, 8)} → 浮き Chrome を kill (shop=${job.shop_id.slice(0, 8)})`);
      } catch {
        /* 生きていなければ no-op */
      }
      await report({
        job_id: job.id,
        job_type: job.job_type,
        status: "retryable_failed",
        error: `[JOB_TIMEOUT] ${secs}秒以内に完了しなかったため停止しました。同じCloudで全工程を自動再試行します`,
      }).catch(() => {});
    }
  } catch (e) {
    // handleJob 内で例外が漏れた場合の最終防波堤。callback を必ず送る。
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[job] uncaught ${job.job_type} ${job.id.slice(0, 8)}: ${msg}`);
    await report({
      job_id: job.id,
      job_type: job.job_type,
      status: "retryable_failed",
      error: `[UNCAUGHT] ${msg.slice(0, 300)}`,
    }).catch(() => {});
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// 直接スクレイプモード (検証用): ジョブキューを経由せず、seed 済み (= ログイン済み)
// セッションで指定 shop の予約一覧を直接 scrape して件数を出す。desktop worker が
// fetch_bookings を先取り cancel する環境でも、キュー非依存で worker.ts の scrape +
// seed の効果を確認できる。SALONBOARD_DIRECT_SCRAPE_SHOP=<shop_id> で起動。
async function directScrape(shopId: string): Promise<void> {
  const baseUrl = "https://salonboard.com/";
  const { launch, realChrome } = resolveLaunchOptions(null);
  console.log(
    `[direct] shop=${shopId} channel=${launch.channel ?? "chromium"} headless=${launch.headless} (キュー非依存・seed流用)`
  );
  const ctx = await launchStealthContext({ launch, realChrome, shopId });
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    let auth = await isLoggedIn(page, baseUrl);
    console.log(`[direct] isLoggedIn=${auth}`);
    if (auth !== "logged_in") {
      // creds が env で渡されていれば新規ログイン (クラウド/seed 無し検証用)。
      const did = process.env.SALONBOARD_DIRECT_LOGIN_ID;
      const dpw = process.env.SALONBOARD_DIRECT_PASSWORD;
      if (did && dpw) {
        console.log(`[direct] 未ログイン → 渡された認証情報で新規ログイン試行`);
        const lr = await tryLogin(page, new URL("/login/", baseUrl).toString(), {
          loginId: did,
          password: dpw,
        });
        console.log(
          `[direct] tryLogin => ${lr.status}${"reason" in lr ? ` (${lr.reason})` : ""}`
        );
        auth = await isLoggedIn(page, baseUrl);
        console.log(`[direct] isLoggedIn(after login)=${auth}`);
      }
      if (auth !== "logged_in") {
        console.log(
          `[direct] 未ログイン (auth=${auth})。seed 流用なら Chrome がログイン済みか確認 / クラウドなら SALONBOARD_DIRECT_LOGIN_ID・SALONBOARD_DIRECT_PASSWORD を渡してください。`
        );
        return;
      }
    }
    // サロン情報ページ等の DOM 調査用モード: SALONBOARD_DIRECT_DUMP_URL に遷移し、
    // HTML 全体 + 「店舗/サロン/設定/情報」系リンク一覧を吐く。scraper 実装前の発見用。
    const dumpUrl = process.env.SALONBOARD_DIRECT_DUMP_URL;
    if (dumpUrl) {
      const target = dumpUrl.startsWith("http")
        ? dumpUrl
        : new URL(dumpUrl, baseUrl).toString();
      await page
        .goto(target, { waitUntil: "domcontentloaded", timeout: 30_000 })
        .catch(() => {});
      await page.waitForTimeout(1500);
      const info = await page
        .evaluate(() => {
          const links = Array.from(document.querySelectorAll("a"))
            .map((a) => ({
              href: a.getAttribute("href") || "",
              text: (a.textContent || "").replace(/\s+/g, " ").trim().slice(0, 30),
            }))
            .filter(
              (l) =>
                l.href &&
                (/店舗|サロン|設定|基本|情報|営業|アクセス/.test(l.text) ||
                  /setting|salon|shop|store|info|tenpo/i.test(l.href)),
            );
          return {
            url: location.href,
            title: document.title,
            links: links.slice(0, 50),
          };
        })
        .catch(() => null);
      console.log("[dump] page:", JSON.stringify(info).slice(0, 2500));
      const fsp2 = await import("node:fs/promises");
      const html = await page.content().catch(() => "");
      const out =
        process.env.SALONBOARD_DIRECT_DUMP_FILE ||
        "/home/pwuser/.kireidot/dump.html";
      await fsp2.writeFile(out, html).catch(() => {});
      console.log(`[dump] html(${html.length}) => ${out}`);
      return;
    }
    // 検証する scrape 種別。カンマ区切りで複数種別を1ログインで連続スクレイプ(横展開検証)。
    // staff/menus/coupons/blogs/reviews/photo_gallery を汎用 dispatch で扱う。
    const typesRaw = (process.env.SALONBOARD_DIRECT_SCRAPE_TYPE || "bookings").toLowerCase();
    const types = typesRaw.split(",").map((t) => t.trim()).filter(Boolean);
    const genre =
      process.env.SALONBOARD_DIRECT_SCRAPE_GENRE === "hair" ? "hair" : "esthetic";
    const s = scrapers as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const fnByType: Record<string, string> = {
      bookings: "scrapeBookings", staff: "scrapeStaff",
      menu: "scrapeMenus", menus: "scrapeMenus",
      coupon: "scrapeCoupons", coupons: "scrapeCoupons",
      blog: "scrapeBlogs", blogs: "scrapeBlogs",
      review: "scrapeReviews", reviews: "scrapeReviews",
      photo_gallery: "scrapePhotoGallery", photogallery: "scrapePhotoGallery",
    };
    const dumpDir = process.env.SALONBOARD_DIRECT_DUMP_DIR;
    const dumpFile = process.env.SALONBOARD_DIRECT_DUMP_FILE;
    const fsp = dumpDir || dumpFile ? await import("node:fs/promises") : null;
    if (dumpDir && fsp) await fsp.mkdir(dumpDir, { recursive: true }).catch(() => {});
    for (const type of types) {
      let list: Array<Record<string, unknown>> = [];
      let debug: unknown;
      try {
        if (type === "shift_patterns") {
          const sp = (await s.scrapeShiftPatterns(page, baseUrl)) as { patterns?: unknown[] };
          list = (sp?.patterns ?? []) as Array<Record<string, unknown>>;
        } else {
          const fn = fnByType[type] ?? "scrapeBookings";
          const res = (await s[fn](page, {
            baseUrl, genre, loginId: "", password: "", maxDetails: 10,
          })) as { rows?: unknown[]; debug?: unknown };
          list = (res?.rows ?? []) as Array<Record<string, unknown>>;
          debug = res?.debug;
        }
      } catch (e) {
        console.log(`[direct] ❌ ${type} 失敗:`, String(e).slice(0, 200));
        continue;
      }
      console.log(`[direct] ✅ ${type} => ${list.length} 件 (genre=${genre})`);
      console.log(`[direct] ${type} sample:`, JSON.stringify(list.slice(0, 2)).slice(0, 500));
      if (dumpDir && fsp) {
        await fsp.writeFile(`${dumpDir}/${type}.json`, JSON.stringify(list));
        console.log(`[direct] dumped ${type} => ${dumpDir}/${type}.json (${list.length})`);
      } else if (dumpFile && fsp) {
        await fsp.writeFile(dumpFile, JSON.stringify(list));
        console.log(`[direct] dumped ${type} => ${dumpFile} (${list.length})`);
      }
      if (debug) console.log(`[direct] ${type} debug:`, JSON.stringify(debug).slice(0, 300));
    }
  } finally {
    await ctx.close().catch(() => {});
  }
}

/**
 * キュー非依存の push_booking 検証 (confirm-only)。
 * env creds でログイン → SALONBOARD_DIRECT_PUSH_PAYLOAD (JSON) で pushBooking 実行。
 * SALONBOARD_ENABLE_PUSH=OFF (既定) なら登録ボタンを押さず確認内容を返す (実予約を作らない)。
 */
async function directPush(shopId: string): Promise<void> {
  const baseUrl = "https://salonboard.com/";
  const { launch, realChrome } = resolveLaunchOptions(null);
  console.log(
    `[push] shop=${shopId} channel=${launch.channel ?? "chromium"} headless=${launch.headless} ENABLE_PUSH=${ENABLE_PUSH ? "ON" : "OFF"} (キュー非依存・confirm-only)`
  );
  const ctx = await launchStealthContext({ launch, realChrome, shopId });
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    let auth = await isLoggedIn(page, baseUrl);
    console.log(`[push] isLoggedIn=${auth}`);
    if (auth !== "logged_in") {
      const did = process.env.SALONBOARD_DIRECT_LOGIN_ID;
      const dpw = process.env.SALONBOARD_DIRECT_PASSWORD;
      if (did && dpw) {
        console.log(`[push] 未ログイン → 認証情報でログイン試行`);
        const lr = await tryLogin(page, new URL("/login/", baseUrl).toString(), {
          loginId: did,
          password: dpw,
        });
        console.log(`[push] tryLogin => ${lr.status}`);
        auth = await isLoggedIn(page, baseUrl);
        console.log(`[push] isLoggedIn(after login)=${auth}`);
      }
      if (auth !== "logged_in") {
        console.log(`[push] 未ログイン (auth=${auth})。認証情報を確認。`);
        return;
      }
    }
    const raw = process.env.SALONBOARD_DIRECT_PUSH_PAYLOAD;
    if (!raw) {
      console.log(`[push] SALONBOARD_DIRECT_PUSH_PAYLOAD (JSON) が未指定。`);
      return;
    }
    let payload: PushBookingPayload;
    try {
      payload = JSON.parse(raw) as PushBookingPayload;
    } catch (e) {
      console.log(`[push] payload JSON parse 失敗:`, String(e).slice(0, 200));
      return;
    }
    console.log(
      `[push] payload: staff=${payload.salonboard_staff_external_id} menu=${
        payload.salonboard_menu_name ?? payload.menu_name ?? payload.coupon_name
      } at=${payload.scheduled_at} customer=${payload.customer_name}`
    );
    const fakeJob = {
      id: "direct-push-test",
      job_type: "push_booking",
      shop_id: shopId,
      organization_id: null,
      attempts: 0,
      max_attempts: 1,
      status: "running",
      credentials: { base_url: baseUrl },
      payload,
    } as unknown as Job;
    const result = await pushBookingViaProvenForm(page, fakeJob, payload);
    console.log(`[push] ✅ pushBooking => status=${result.status}`);
    console.log(`[push] result:`, JSON.stringify(result).slice(0, 1500));
    const dumpFile = process.env.SALONBOARD_DIRECT_DUMP_FILE;
    if (dumpFile) {
      const fs = await import("node:fs/promises");
      await fs.writeFile(dumpFile, JSON.stringify(result, null, 2));
      console.log(`[push] result dumped => ${dumpFile}`);
    }
  } finally {
    await ctx.close().catch(() => {});
  }
}

/**
 * キュー非依存の cancel_booking 検証 (one-shot)。
 * env creds でログイン → SALONBOARD_DIRECT_CANCEL_PAYLOAD (JSON) で cancelBookingViaForm 実行。
 * SALONBOARD_ENABLE_PUSH=OFF なら確認のみ (実キャンセルしない)。
 * payload は external_booking_id (reserveId) があればそれで特定、無ければ
 * scheduled_at + salonboard_staff_external_id + customer_name で予約一覧から特定して取消す。
 */
async function directCancel(shopId: string): Promise<void> {
  const baseUrl = "https://salonboard.com/";
  const { launch, realChrome } = resolveLaunchOptions(null);
  console.log(
    `[cancel] shop=${shopId} channel=${launch.channel ?? "chromium"} headless=${launch.headless} ENABLE_PUSH=${ENABLE_PUSH ? "ON" : "OFF"} (キュー非依存)`
  );
  const ctx = await launchStealthContext({ launch, realChrome, shopId });
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    let auth = await isLoggedIn(page, baseUrl);
    console.log(`[cancel] isLoggedIn=${auth}`);
    if (auth !== "logged_in") {
      const did = process.env.SALONBOARD_DIRECT_LOGIN_ID;
      const dpw = process.env.SALONBOARD_DIRECT_PASSWORD;
      if (did && dpw) {
        console.log(`[cancel] 未ログイン → 認証情報でログイン試行`);
        const lr = await tryLogin(page, new URL("/login/", baseUrl).toString(), {
          loginId: did,
          password: dpw,
        });
        console.log(`[cancel] tryLogin => ${lr.status}`);
        auth = await isLoggedIn(page, baseUrl);
        console.log(`[cancel] isLoggedIn(after login)=${auth}`);
      }
      if (auth !== "logged_in") {
        console.log(`[cancel] 未ログイン (auth=${auth})。認証情報を確認。`);
        return;
      }
    }
    const raw = process.env.SALONBOARD_DIRECT_CANCEL_PAYLOAD;
    if (!raw) {
      console.log(`[cancel] SALONBOARD_DIRECT_CANCEL_PAYLOAD (JSON) が未指定。`);
      return;
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw) as Record<string, unknown>;
    } catch (e) {
      console.log(`[cancel] payload JSON parse 失敗:`, String(e).slice(0, 200));
      return;
    }
    console.log(
      `[cancel] payload: reserveId=${payload.external_booking_id ?? "(検索)"} at=${payload.scheduled_at} staff=${payload.salonboard_staff_external_id} customer=${payload.customer_name}`
    );
    const result = await scrapers.cancelBookingViaForm(page, payload, {
      baseUrl,
      enableCancel: ENABLE_PUSH,
    });
    console.log(
      `[cancel] ✅ cancelBookingViaForm => status=${(result as { status?: string })?.status}`
    );
    console.log(`[cancel] result:`, JSON.stringify(result).slice(0, 1000));
    const dumpFile = process.env.SALONBOARD_DIRECT_DUMP_FILE;
    if (dumpFile) {
      const fs = await import("node:fs/promises");
      await fs.writeFile(dumpFile, JSON.stringify(result, null, 2));
      console.log(`[cancel] result dumped => ${dumpFile}`);
    }
  } finally {
    await ctx.close().catch(() => {});
  }
}

/**
 * キュー非依存の汎用 push ジョブ検証 (one-shot)。
 * SALONBOARD_DIRECT_JOB_TYPE (push_shifts/push_review_reply/push_staff/push_menu/push_coupon/push_equipment)
 * + SALONBOARD_DIRECT_JOB_PAYLOAD (JSON) で対応 scraper を実行。
 * SALONBOARD_ENABLE_PUSH=OFF (既定) なら確認のみ (実書き込みしない)。
 */
async function directJob(shopId: string): Promise<void> {
  const baseUrl = "https://salonboard.com/";
  const jobType = (process.env.SALONBOARD_DIRECT_JOB_TYPE || "").trim();
  const genre =
    process.env.SALONBOARD_DIRECT_SCRAPE_GENRE === "hair" ? "hair" : "esthetic";
  const { launch, realChrome } = resolveLaunchOptions(null);
  console.log(
    `[job1] shop=${shopId} type=${jobType} channel=${launch.channel ?? "chromium"} headless=${launch.headless} ENABLE_PUSH=${ENABLE_PUSH ? "ON" : "OFF"}`
  );
  const ctx = await launchStealthContext({ launch, realChrome, shopId });
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    let auth = await isLoggedIn(page, baseUrl);
    if (auth !== "logged_in") {
      const did = process.env.SALONBOARD_DIRECT_LOGIN_ID;
      const dpw = process.env.SALONBOARD_DIRECT_PASSWORD;
      if (did && dpw) {
        console.log(`[job1] 未ログイン → 認証情報でログイン試行`);
        const lr = await tryLogin(page, new URL("/login/", baseUrl).toString(), {
          loginId: did,
          password: dpw,
        });
        console.log(`[job1] tryLogin => ${lr.status}`);
        auth = await isLoggedIn(page, baseUrl);
      }
      if (auth !== "logged_in") {
        console.log(`[job1] 未ログイン (auth=${auth})。認証情報を確認。`);
        return;
      }
    }
    // UTF-8 安全のため base64 経由を優先 (printf %q / SSM / docker -e で日本語が壊れるのを回避)
    const b64 = process.env.SALONBOARD_DIRECT_JOB_PAYLOAD_B64;
    const raw = b64
      ? Buffer.from(b64, "base64").toString("utf8")
      : process.env.SALONBOARD_DIRECT_JOB_PAYLOAD;
    if (!raw) {
      console.log(`[job1] SALONBOARD_DIRECT_JOB_PAYLOAD(_B64) が未指定。`);
      return;
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw) as Record<string, unknown>;
    } catch (e) {
      console.log(`[job1] payload JSON parse 失敗:`, String(e).slice(0, 200));
      return;
    }
    console.log(
      `[job1] payload name=${JSON.stringify((payload as { name?: string; reply_body?: string }).name ?? (payload as { reply_body?: string }).reply_body ?? "").slice(0, 50)}`
    );
    const s = scrapers as unknown as Record<
      string,
      (p: unknown, payload: unknown, opts: unknown) => Promise<unknown>
    >;
    let result: unknown;
    if (jobType === "push_shifts") {
      result = await s.pushShiftsViaForm(page, payload, {
        baseUrl,
        enablePush: ENABLE_PUSH,
      });
    } else if (jobType === "push_review_reply") {
      result = await s.postReviewReplyViaForm(page, payload, {
        baseUrl,
        enablePost: ENABLE_PUSH,
      });
    } else if (jobType === "push_staff") {
      const pp = payload as Record<string, unknown>;
      const staffFn =
        pp.name || pp.furigana || pp.kana || pp.catch_copy || pp.catch ||
        pp.bio || pp.self_intro || pp.role || pp.job_type || pp.gender || pp.nomination
          ? s.pushStaffProfileViaForm
          : s.pushStaffViaForm;
      result = await staffFn(page, payload, {
        baseUrl,
        enablePush: ENABLE_PUSH,
        genre,
      });
    } else if (jobType === "push_shift_patterns") {
      result = await s.pushWorkPatternViaForm(page, payload, {
        baseUrl,
        enablePush: ENABLE_PUSH,
      });
    } else if (jobType === "push_menu") {
      result = await s.pushMenuViaForm(page, payload, {
        baseUrl,
        enablePush: ENABLE_PUSH,
        genre,
      });
    } else if (jobType === "push_coupon") {
      result = await s.pushCouponViaForm(page, payload, {
        baseUrl,
        enablePush: ENABLE_PUSH,
        genre,
      });
    } else if (jobType === "push_equipment") {
      result = await s.pushEquipmentViaForm(page, payload, {
        baseUrl,
        enablePush: ENABLE_PUSH,
      });
    } else {
      console.log(`[job1] 未対応 job_type=${jobType}`);
      return;
    }
    console.log(
      `[job1] ✅ ${jobType} => status=${(result as { status?: string })?.status}`
    );
    console.log(`[job1] result:`, JSON.stringify(result).slice(0, 1500));
    const dumpFile = process.env.SALONBOARD_DIRECT_DUMP_FILE;
    if (dumpFile) {
      const fs = await import("node:fs/promises");
      await fs.writeFile(dumpFile, JSON.stringify(result, null, 2));
      console.log(`[job1] result dumped => ${dumpFile}`);
    }
  } finally {
    await ctx.close().catch(() => {});
  }
}

async function main() {
  console.log(
    `[boot] api=${API} mode=${WORKER_MODE} worker=${WORKER_ID} device=${
      WORKER_MODE === "device" ? DEVICE_ID.slice(0, 8) : "-"
    } version=${APP_VERSION} platform=${PLATFORM} dry_run=${DRY_RUN} once=${RUN_ONCE} poll=${POLL_MS}ms`
  );

  // 直接スクレイプモード (キュー非依存・検証用)。
  const directShop = process.env.SALONBOARD_DIRECT_SCRAPE_SHOP;
  if (directShop) {
    await directScrape(directShop);
    return;
  }

  // 直接 push モード (キュー非依存・confirm-only 検証用)。
  const directPushShop = process.env.SALONBOARD_DIRECT_PUSH_SHOP;
  if (directPushShop) {
    await directPush(directPushShop);
    return;
  }

  // 直接 cancel モード (キュー非依存・検証/後始末用)。
  const directCancelShop = process.env.SALONBOARD_DIRECT_CANCEL_SHOP;
  if (directCancelShop) {
    await directCancel(directCancelShop);
    return;
  }

  // 直接 汎用 push ジョブモード (キュー非依存・confirm-only 検証用)。
  const directJobShop = process.env.SALONBOARD_DIRECT_JOB_SHOP;
  if (directJobShop) {
    await directJob(directJobShop);
    return;
  }

  if (RUN_ONCE) {
    const n = await pollOnce();
    console.log(`[exit] processed ${n} job(s) and exiting`);
    return;
  }

  // 終了ハンドリング
  let stopping = false;
  const stop = () => {
    stopping = true;
    requestShutdown(); // push_booking のクリティカルセクション保護にも伝える
    console.log("\n[boot] shutting down...");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  // メインループ: 空きスロット分を claim して並行処理 -> ポーリング間隔待機。
  // 処理中(別店舗レーン)がある間は短めに回してスロットを埋め続ける。
  console.log(`[boot] 店舗レーン並行: 同時実行数(max)=${maxConcurrency()}`);
  while (!stopping) {
    const processed = await pollOnce();
    if (stopping) break;
    // ★予約書込が来ていたら、その店で走行中の fetch を即 abort(preemption)。
    await preemptFetchesForWrites();
    // ジョブがあった/進行中なら短め(スロットを埋める)。完全アイドル時のみ最大5s。
    // fetch 走行中は preemption を早く効かせるため 1.5s 周期にする。
    const busy = processed > 0 || _inFlight.size > 0;
    const wait =
      _fetchAbort.size > 0 ? 1_500 : busy ? 1_000 : Math.min(POLL_MS, 5_000);
    await sleep(wait);
  }
  // ★②A(セッション保護シャットダウン):
  //  1) in-flight を最大 SHUTDOWN_DRAIN_MS 待つ(callback取りこぼし防止。書込のcritical section
  //     は requestShutdown により submit前に中断済み)。長尺fetchは待ち切らない。
  //  2) 残存も含め **全 BrowserContext を明示 close** して cookie/_abck を userDataDir に flush。
  //     → 次起動は isLoggedIn=true で **再ログイン不要 → Akamaiスロットル回避**(今日の障害の根治)。
  //  ⚠️ docker の stop 猶予(stop_grace_period / stop -t)を SHUTDOWN_DRAIN_MS より長く設定必須。
  //     既定10秒だと SIGKILL が先行し この処理が走らず、セッション未flush→再ログイン嵐を再発する。
  const SHUTDOWN_DRAIN_MS = Number(process.env.SB_SHUTDOWN_DRAIN_MS ?? 25_000);
  if (_inFlight.size > 0) {
    console.log(
      `[boot] draining ${_inFlight.size} in-flight job(s) (<=${Math.round(SHUTDOWN_DRAIN_MS / 1000)}s)...`,
    );
    await Promise.race([
      Promise.allSettled(Array.from(_inFlight.values())),
      sleep(SHUTDOWN_DRAIN_MS),
    ]);
  }
  if (_openContexts.size > 0) {
    console.log(`[boot] closing ${_openContexts.size} browser context(s) to flush sessions...`);
    await Promise.allSettled(
      Array.from(_openContexts).map((c) => c.close().catch(() => {})),
    );
  }
  console.log("[boot] bye (sessions flushed)");
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// このモジュールが直接実行された (= worker 本体として起動した) ときだけ
// ポーリングループ main() を走らせる。test-push-booking.ts のように
// import して pushBooking()/tryLogin() などを再利用する場合は main() を走らせない
// (ジョブを勝手に処理してしまうのを防ぐ)。tsx は CJS の require/module を提供する。
// package.json は "type": "module" なので tsx は ESM として実行する
// (require/require.main は使えない)。entrypoint 判定は import.meta.url と
// 実行ファイル (process.argv[1]) の一致で行う。
const IS_WORKER_ENTRYPOINT = (() => {
  try {
    // canary (CANARY_MODE=1) は worker を import して関数を再利用するだけ。
    // esbuild バンドルでは import.meta.url が出力ファイルと一致してしまうため、
    // entrypoint 判定より先に明示的に除外する (ポーリングループを起動しない)。
    if (process.env.CANARY_MODE === "1") return false;
    if (process.env.WORKER_DISABLE_MAIN === "1") return false;
    const entry = process.argv[1];
    if (!entry) return true; // 判定材料が無ければ従来どおり起動 (後方互換)
    const entryUrl = new URL(`file://${resolve(entry)}`).href;
    // 拡張子の差 (worker / worker.ts) を吸収して前方一致で比較
    const self = import.meta.url.replace(/\.[tj]s$/, "");
    const other = entryUrl.replace(/\.[tj]s$/, "");
    return self === other;
  } catch {
    return true;
  }
})();

if (IS_WORKER_ENTRYPOINT) {
  main().catch((e) => {
    console.error("[fatal]", e);
    process.exit(1);
  });
}

// ------------------------------------------------------------
// 他スクリプト (test-push-booking.ts 等) から再利用するための export。
// worker 本体の挙動には影響しない (import 時 main() は走らない)。
// ------------------------------------------------------------
export {
  tryLogin,
  isLoggedIn,
  pushBooking,
  openRegisterForm,
  storageStatePathFor,
  readStorageState,
  saveStorageState,
  parseJstParts,
  requestShutdown,
  isShutdownRequested,
  SB_CONTEXT_OPTIONS,
  ENABLE_PUSH,
  DRY_RUN,
};
export type { Job, PushBookingPayload, PushBookingResult, JobType };
