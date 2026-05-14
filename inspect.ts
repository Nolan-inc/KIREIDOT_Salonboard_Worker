/**
 * 画面構造調査用ツール。
 *
 * ワーカー本体とは別に、headful (ブラウザ画面を見える状態) で
 * サロンボードにログインするだけのスクリプト。
 *
 * 使い方:
 *   npx tsx inspect.ts
 *
 * 必要な環境変数 (.env.local から読む):
 *   SALONBOARD_WORKER_TOKEN  Admin と同じトークン
 *   KIREIDOT_API_URL         例: http://localhost:3000
 *
 * このスクリプトは Admin から credentials を1件取り出してログインし、
 * ブラウザを開いたまま待機する。ユーザーがブラウザで画面を巡回して
 * DevTools で HTML 構造を確認するためのもの。
 * Ctrl+C で終了するまでブラウザは閉じない。
 *
 * 注意: Admin から credentials を取得するため salonboard_sync_jobs に
 * 調査用のダミージョブを一時的に積み、完了後にキャンセル扱いにする。
 */

import { chromium } from "playwright";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

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

const API = must("KIREIDOT_API_URL");
const TOKEN = must("SALONBOARD_WORKER_TOKEN");

function must(k: string): string {
  const v = process.env[k];
  if (!v) {
    console.error(`[fatal] env ${k} is required`);
    process.exit(1);
  }
  return v;
}

async function main() {
  console.log(`[inspect] api=${API}`);

  // 1) ダミージョブを積むのではなく、ワーカーとして 1 ジョブ引っこ抜く
  //    直後にキャンセルしてロックを解放する
  const jobsRes = await fetch(`${API}/api/salonboard/jobs?limit=1`, {
    headers: { Authorization: `Bearer ${TOKEN}`, "X-Worker-Id": "inspect" },
  });
  if (!jobsRes.ok) {
    throw new Error(`jobs fetch failed ${jobsRes.status}: ${await jobsRes.text()}`);
  }
  const { jobs } = (await jobsRes.json()) as { jobs: Array<{
    id: string;
    credentials: { login_id: string; password: string; base_url: string | null };
  }> };

  if (jobs.length === 0) {
    console.error(
      "[inspect] queued ジョブがありません。まず Admin 画面の「今すぐ同期」で fetch_bookings を投入してください。"
    );
    process.exit(1);
  }

  const job = jobs[0];
  console.log(`[inspect] claimed job ${job.id.slice(0, 8)} for inspection`);
  console.log(`[inspect] login_id=${job.credentials.login_id}`);

  // 取得したジョブは後でキャンセル扱いで返す (実行はしない)
  const cleanup = async () => {
    try {
      await fetch(`${API}/api/salonboard/callback`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "X-Worker-Id": "inspect",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          job_id: job.id,
          status: "retry",
          error: "inspect session (no-op); re-queued",
        }),
      });
      console.log("[inspect] job returned to queue");
    } catch (e) {
      console.error("[inspect] cleanup failed:", e);
    }
  };

  const browser = await chromium.launch({
    headless: false,
    slowMo: 200,
  });
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 820 },
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  });
  const page = await ctx.newPage();

  const loginUrl = job.credentials.base_url ?? "https://salonboard.com/login/";
  console.log(`[inspect] opening ${loginUrl}`);
  await page.goto(loginUrl, { waitUntil: "domcontentloaded" });

  console.log("[inspect] --------------------------------------------------");
  console.log("[inspect]  ここから手動操作OK:");
  console.log("[inspect]   1. ブラウザで ID/PW を入力してログイン");
  console.log("[inspect]   2. 予約一覧ページ・売上ページを巡回");
  console.log("[inspect]   3. DevTools (Cmd+Opt+I) で Elements を見る");
  console.log("[inspect]   4. 関心のある要素を右クリック -> Copy -> Copy outerHTML");
  console.log("[inspect]   5. Claude のチャットに貼り付け");
  console.log("[inspect]  ");
  console.log("[inspect]  終了するときは、この Terminal で Ctrl+C");
  console.log("[inspect] --------------------------------------------------");

  // ログインIDだけ埋めてあげる (パスワードは手で入力してもらう or 自動)
  try {
    const idInput = page.locator('input[name="userId"], input[name="loginId"], input[type="text"]').first();
    if (await idInput.count()) {
      await idInput.fill(job.credentials.login_id);
      const pwInput = page.locator('input[name="password"], input[type="password"]').first();
      if (await pwInput.count()) {
        await pwInput.fill(job.credentials.password);
      }
      console.log("[inspect] login id/pw prefilled; click submit in the browser");
    }
  } catch {
    // 埋められなくても支障はない (ユーザーが手で入力すればよい)
  }

  // Ctrl+C 待ち
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    console.log("\n[inspect] shutting down...");
    await cleanup();
    await browser.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // ブラウザが閉じられた場合も終了
  browser.on("disconnected", shutdown);

  // idle loop
  await new Promise(() => {});
}

main().catch(async (e) => {
  console.error("[inspect] fatal:", e);
  process.exit(1);
});
