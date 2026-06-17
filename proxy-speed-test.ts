/**
 * プロキシ速度計測 (使い捨て / ローテ住宅 vs Static ISP の比較用)
 * ============================================================
 * ログインページ取得 → ログイン送信(/KLP/ 到達まで) → スケジュール
 * 閲覧を N 回、各フェーズの所要 ms を計測する。SB_PROXY_* を差し替えて
 * 同じスクリプトで両ティアを A/B 比較できる。
 *
 * env:
 *   SPEED_LABEL  ログのラベル (例: residential / isp)
 *   SPEED_READS  スケジュール閲覧の反復回数 (既定 3)
 */
import { chromium, type Page } from "playwright";
import { SB_CONTEXT_OPTIONS } from "./worker";
import { SB_PATHS } from "./salonboard-selectors";

const BASE_URL = process.env.SALONBOARD_BASE_URL ?? "https://salonboard.com/";
const LOGIN_ID = process.env.SALONBOARD_LOGIN_ID!;
const PASSWORD = process.env.SALONBOARD_PASSWORD!;
const READS = Number(process.env.SPEED_READS ?? 3);
const LABEL = process.env.SPEED_LABEL ?? "proxy";
const log = (...a: unknown[]) => console.log(`[speed:${LABEL}]`, ...a);
const now = () => Date.now();

async function main() {
  const rawProxy = process.env.SB_PROXY_SERVER;
  const proxy = rawProxy
    ? {
        server: /:\/\//.test(rawProxy) ? rawProxy : `http://${rawProxy}`,
        username: process.env.SB_PROXY_USERNAME || undefined,
        password: process.env.SB_PROXY_PASSWORD || undefined,
      }
    : undefined;
  const channel = process.env.SB_BROWSER_CHANNEL || undefined;
  const headless = process.env.SB_HEADLESS === "0" ? false : true;
  log(`proxy=${proxy?.server ?? "DIRECT"} channel=${channel || "chromium"} headless=${headless} reads=${READS}`);

  const browser = await chromium.launch({ headless, channel, proxy });
  const ctx = await browser.newContext({
    ...(channel ? { locale: "ja-JP", timezoneId: "Asia/Tokyo" } : SB_CONTEXT_OPTIONS),
  });

  // 帯域の概算 (Content-Length 合算。本体は取得しないので計測に影響なし)
  let bytes = 0;
  let resp = 0;
  ctx.on("response", (r) => {
    resp++;
    const cl = r.headers()["content-length"];
    if (cl) bytes += Number(cl) || 0;
  });
  // 画像/メディア/フォント遮断
  await ctx.route("**/*", (route) => {
    const t = route.request().resourceType();
    return t === "image" || t === "media" || t === "font" ? route.abort() : route.continue();
  });
  const page: Page = await ctx.newPage();

  try {
    // 1. ログインページ
    let t = now();
    await page.goto(new URL("/login/", BASE_URL).toString(), { waitUntil: "domcontentloaded", timeout: 60_000 });
    const loginPageMs = now() - t;
    log(`login page: ${loginPageMs}ms`);

    // 2. ログイン送信 → /KLP/ 到達まで
    await page.locator('input[name="userId"], input[name="loginId"], input[type="text"]').first().fill(LOGIN_ID);
    await page.locator('input[type="password"]').first().fill(PASSWORD);
    t = now();
    await Promise.all([
      page.waitForURL(/\/KLP\//, { timeout: 60_000 }).catch(() => {}),
      page.locator('button[type="submit"], input[type="submit"], a:has-text("ログイン")').first().click(),
    ]);
    const loginSubmitMs = now() - t;
    const loggedIn = /\/KLP\//.test(page.url());
    log(`login submit: ${loginSubmitMs}ms -> ${page.url()} loggedIn=${loggedIn}`);
    if (!loggedIn) {
      log(`RESULT(${LABEL}): LOGIN FAILED or too slow (url=${page.url()})`);
      return;
    }

    // 3. スケジュール閲覧 N 回
    const today = new Date(Date.now() + 9 * 3600_000);
    const yyyymmdd = today.toISOString().slice(0, 10).replace(/-/g, "");
    const schedUrl = new URL(SB_PATHS.schedule, BASE_URL);
    schedUrl.searchParams.set("date", yyyymmdd);
    const reads: number[] = [];
    for (let i = 0; i < READS; i++) {
      t = now();
      try {
        await page.goto(schedUrl.toString(), { waitUntil: "domcontentloaded", timeout: 60_000 });
        const dt = now() - t;
        reads.push(dt);
        const title = await page.title().catch(() => "");
        log(`schedule read ${i + 1}: ${dt}ms title=${title.slice(0, 30)}`);
      } catch (e) {
        reads.push(-1);
        log(`schedule read ${i + 1}: FAILED ${e instanceof Error ? e.message.split("\n")[0] : e}`);
      }
      await page.waitForTimeout(500);
    }

    const ok = reads.filter((x) => x > 0);
    const avg = ok.length ? Math.round(ok.reduce((a, b) => a + b, 0) / ok.length) : -1;
    log(`========== SUMMARY (${LABEL}) ==========`);
    log(`login page : ${loginPageMs}ms`);
    log(`login submit: ${loginSubmitMs}ms`);
    log(`schedule    : [${reads.join(", ")}]ms  avg=${avg}ms  success=${ok.length}/${READS}`);
    log(`approx bytes: ${(bytes / 1024 / 1024).toFixed(2)}MB across ${resp} responses`);
  } catch (e) {
    log("FATAL", e instanceof Error ? e.message.split("\n")[0] : e);
  } finally {
    await browser.close().catch(() => {});
  }
}

main();
