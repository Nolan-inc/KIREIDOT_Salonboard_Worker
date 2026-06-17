/**
 * 冪等性マーカー再スキャン 実DOM検証スパイク (Phase 0.5 / 設計 §6.1)
 * ============================================================
 *
 * salonboard-rescan.ts が実際の SalonBoard DOM で動くかを確認する CLI。
 * test-push-booking.ts と同じ流儀:
 *   - 認証情報は Admin API からジョブを 1 件 claim して借り、終了時に再キューへ戻す
 *   - 既定 headful (ブラウザ表示)。読み取り専用で、登録/変更操作は一切しない
 *
 * 使い方:
 *   npx tsx test-rescan.ts --booking-id=<KIREIDOT予約ID>
 *
 *   主な引数:
 *     --booking-id=...   探すマーカーの booking_id (必須)。実在する同期済み予約の
 *                        ID を指定すると found=true になるはず (方式Aの検証)
 *     --customer=名前    方式B 事前フィルタの検証用 (任意)
 *     --max=30           詳細ページを開く上限
 *     --list-url=...     予約一覧 URL の上書き (日付絞り込みクエリの試行用)
 *     --headless         ブラウザ非表示
 *     --keep-open        終了後もブラウザを開いたまま (Ctrl+C で終了)
 *
 * 必要な env (.env.local): KIREIDOT_API_URL, SALONBOARD_WORKER_TOKEN
 *
 * 検証観点 (設計 §12):
 *   1. found=true / false が期待どおりか (登録済み ID と未登録 ID の両方で実行)
 *   2. 一覧 init が「どの期間」を表示するか (notes と画面で確認 → 日付絞りの要否判断)
 *   3. RESERVE_ID_RE の抽出値が常に YG 始まりか (shim 検証の厳格化前提)
 *   4. 詳細ページ巡回 1 件あたりの所要時間 (プリフライトの実用性)
 */

import { chromium, type Browser } from "playwright";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import { tryLogin, isLoggedIn, SB_CONTEXT_OPTIONS } from "./worker";
import { rescanForMarker } from "./salonboard-rescan";

// --- env (.env.local / .env) — test-push-booking.ts と同じ軽量ローダ ---
function loadEnvFile(file: string) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
}
loadEnvFile(resolve(process.cwd(), ".env.local"));
loadEnvFile(resolve(process.cwd(), ".env"));

const T = () => new Date().toISOString().slice(11, 19);
const log = (s: string) => console.log(`[rescan ${T()}] ${s}`);
const fatal = (s: string): never => {
  console.error(`[rescan] FATAL: ${s}`);
  process.exit(1);
};
const must = (k: string): string =>
  process.env[k] ?? fatal(`env ${k} が必要です (.env.local)`);

// --- 引数 ---
const args = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([a-z-]+)(?:=(.*))?$/);
  if (m) args.set(m[1], m[2] ?? "true");
}
const bookingId = args.get("booking-id") ?? fatal("--booking-id=... が必須です");
const customer = args.get("customer");
const maxDetailPages = Number(args.get("max") ?? "30");
const listUrl = args.get("list-url");
const headless = args.has("headless");
const keepOpen = args.has("keep-open");

async function main() {
  // --- 認証情報の取得 ---
  // 方式1 (env 直渡し): SALONBOARD_LOGIN_ID/PASSWORD があれば Admin API に
  //   一切触れず実行する (本番ジョブキューを汚さない。スパイク推奨)。
  // 方式2 (Admin claim): 無ければ test-push-booking.ts と同じくジョブを借りる。
  if (process.env.SALONBOARD_LOGIN_ID && process.env.SALONBOARD_PASSWORD) {
    const baseUrl = process.env.SALONBOARD_BASE_URL ?? "https://salonboard.com/";
    log(`env 認証情報モード (Admin 非接続, base_url=${baseUrl})`);
    await runRescan(baseUrl, {
      login_id: process.env.SALONBOARD_LOGIN_ID,
      password: process.env.SALONBOARD_PASSWORD,
    });
    return;
  }

  const API = must("KIREIDOT_API_URL");
  const TOKEN = must("SALONBOARD_WORKER_TOKEN");

  // --- 認証情報を Admin API から claim (test-push-booking.ts と同じ) ---
  log(`Admin API からジョブを claim して認証情報を借ります: ${API}`);
  const jobsRes = await fetch(`${API}/api/salonboard/jobs?limit=1`, {
    headers: { Authorization: `Bearer ${TOKEN}`, "X-Worker-Id": "test-rescan" },
  }).catch((e) => fatal(`Admin API に接続できません: ${e?.message ?? e}`));
  if (!jobsRes.ok)
    fatal(`jobs fetch 失敗 ${jobsRes.status}: ${await jobsRes.text().catch(() => "")}`);
  const { jobs } = (await jobsRes.json()) as {
    jobs: Array<{
      id: string;
      shop_id: string;
      credentials: { login_id: string; password: string; base_url: string | null };
    }>;
  };
  if (!jobs?.length)
    fatal("queued ジョブがありません。Admin で「今すぐ同期」等を 1 件投入してください。");
  const claimed = jobs[0];
  const baseUrl = claimed.credentials.base_url ?? "https://salonboard.com/";
  log(`認証情報 OK (shop=${claimed.shop_id.slice(0, 8)}, base_url=${baseUrl})`);

  let returned = false;
  const returnJob = async () => {
    if (returned) return;
    returned = true;
    await fetch(`${API}/api/salonboard/callback`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "X-Worker-Id": "test-rescan",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        job_id: claimed.id,
        status: "retry",
        error: "test-rescan session (no-op); re-queued",
      }),
    }).catch((e) => console.error(`[rescan] ジョブ返却失敗: ${e?.message ?? e}`));
    log("借りたジョブをキューへ戻しました");
  };
  process.on("SIGINT", async () => {
    await returnJob();
    process.exit(130);
  });

  try {
    await runRescan(baseUrl, claimed.credentials);
  } finally {
    await returnJob();
  }
}

// --- ブラウザ起動 + ログイン (worker.ts のフローを再利用) + 再スキャン本体 ---
async function runRescan(
  baseUrl: string,
  credentials: { login_id: string; password: string },
): Promise<void> {
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless });
    const ctx = await browser.newContext({ ...SB_CONTEXT_OPTIONS });
    const page = await ctx.newPage();

    log("ログイン状態を確認します...");
    const state = await isLoggedIn(page, baseUrl);
    if (state !== "logged_in") {
      if (state === "captcha") fatal("reCAPTCHA が表示されています (手動ログインで解除を)");
      log("ログインします...");
      const loginUrl = new URL("/login/", baseUrl).toString();
      const lr = await tryLogin(page, loginUrl, {
        loginId: credentials.login_id,
        password: credentials.password,
      });
      if (lr.status === "captcha")
        fatal("ログイン中に reCAPTCHA が出ました。自動突破はしません。");
      if (lr.status !== "ok")
        fatal(`ログイン失敗: ${"reason" in lr ? (lr.reason ?? "unknown") : lr.status}`);
    }
    log("ログイン OK。再スキャンを実行します");

    const started = Date.now();
    const result = await rescanForMarker(
      page,
      baseUrl,
      { bookingId, customerName: customer },
      { maxDetailPages, listUrl: listUrl ?? undefined, onProgress: (m) => log(m) },
    );
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);

    console.log("\n================ 結果 ================");
    console.log(JSON.stringify(result, null, 2));
    console.log(`所要: ${elapsed}s (詳細 ${result.scanned} 件)`);
    console.log("=======================================\n");

    // 検証観点 3: reserveId が YG 始まりか
    if (result.externalId && !/^YG\d+$/.test(result.externalId)) {
      console.warn(
        `⚠️ reserveId が YG\\d+ 形式ではありません: ${result.externalId} ` +
          `(shim 検証の正規表現を見直すこと)`,
      );
    }
    if (!result.exhaustive) {
      console.warn("⚠️ 全候補を確認しきれていません (--max を増やすか日付絞り込みを検討)");
    }

    if (keepOpen) {
      log("--keep-open: ブラウザを開いたままにします (Ctrl+C で終了)");
      await new Promise(() => {});
    }
  } finally {
    await browser?.close().catch(() => {});
  }
}

main().catch((e) => {
  console.error("[rescan] error:", e);
  process.exit(1);
});
