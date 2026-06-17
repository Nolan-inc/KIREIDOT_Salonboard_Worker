/**
 * プロキシ経由ログイン診断 (使い捨て)
 * ============================================================
 * canary の isLoggedIn ショートカットを使わず、住宅プロキシ経由で
 * 実際に /login → 認証 → スケジュール閲覧を強制実行し、各段階の
 * スクリーンショット + 本文 + HTTP ステータスを採取する。
 *
 * 目的: 「SALON BOARD : エラー」ページの正体を突き止め、住宅IPで
 *       ログイン認証まで本当に通るのかを目視で確定する。
 */
import { chromium } from "playwright";
import { tryLogin, isLoggedIn, SB_CONTEXT_OPTIONS } from "./worker";
import { SB_PATHS } from "./salonboard-selectors";

const BASE_URL = process.env.SALONBOARD_BASE_URL ?? "https://salonboard.com/";
const LOGIN_ID = process.env.SALONBOARD_LOGIN_ID!;
const PASSWORD = process.env.SALONBOARD_PASSWORD!;
const OUT = process.env.PROBE_OUT ?? "/tmp/sbprobe";

const log = (...a: unknown[]) => console.log("[probe]", ...a);

async function shot(page: import("playwright").Page, name: string) {
  try {
    await page.screenshot({ path: `${OUT}-${name}.png`, fullPage: true });
    log(`screenshot -> ${OUT}-${name}.png`);
  } catch (e) {
    log(`screenshot ${name} failed:`, e instanceof Error ? e.message : e);
  }
}

async function dump(page: import("playwright").Page, label: string) {
  const url = page.url();
  const title = await page.title().catch(() => "?");
  const body = (await page.locator("body").innerText().catch(() => "")).slice(0, 600).replace(/\s+/g, " ");
  log(`${label}: url=${url}`);
  log(`${label}: title=${title}`);
  log(`${label}: body[0:600]=${JSON.stringify(body)}`);
}

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
  log(`launch channel=${channel || "chromium"} headless=${headless} proxy=${proxy?.server ?? "none"}`);

  const browser = await chromium.launch({ headless, channel, proxy });
  const ctx = await browser.newContext({
    ...(channel ? { locale: "ja-JP", timezoneId: "Asia/Tokyo" } : SB_CONTEXT_OPTIONS),
  });
  // 帯域節約: 画像/メディア/フォント遮断
  await ctx.route("**/*", (route) => {
    const t = route.request().resourceType();
    return t === "image" || t === "media" || t === "font" ? route.abort() : route.continue();
  });
  const page = await ctx.newPage();
  page.on("response", (res) => {
    const s = res.status();
    if ([401, 403, 429, 503].includes(s) && res.url().includes("salonboard")) {
      log(`[http ${s}] ${res.url().slice(0, 150)}`);
    }
  });

  try {
    // 1. ログインページ
    const loginUrl = new URL("/login/", BASE_URL).toString();
    await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await dump(page, "1-loginpage");
    log("  userId inputs:", await page.locator('input[name="userId"], input[name="loginId"], input[type="text"]').count());
    log("  pw inputs:", await page.locator('input[type="password"]').count());
    log("  recaptcha iframes:", await page.locator('iframe[src*="recaptcha"]').count());
    await shot(page, "1-loginpage");

    // 2. ログイン強制実行
    const lr = await tryLogin(page, loginUrl, { loginId: LOGIN_ID, password: PASSWORD });
    log("tryLogin result:", JSON.stringify(lr));
    await dump(page, "2-afterlogin");
    await shot(page, "2-afterlogin");

    // 3. isLoggedIn 判定
    const st = await isLoggedIn(page, BASE_URL);
    log("isLoggedIn:", st);
    await dump(page, "3-isloggedin");
    await shot(page, "3-isloggedin");

    // 4. スケジュール閲覧
    const today = new Date(Date.now() + 9 * 3600_000);
    const yyyymmdd = today.toISOString().slice(0, 10).replace(/-/g, "");
    const schedUrl = new URL(SB_PATHS.schedule, BASE_URL);
    schedUrl.searchParams.set("date", yyyymmdd);
    await page.goto(schedUrl.toString(), { waitUntil: "domcontentloaded", timeout: 25_000 });
    await dump(page, "4-schedule");
    await shot(page, "4-schedule");
  } catch (e) {
    log("FATAL", e instanceof Error ? e.stack : e);
  } finally {
    await browser.close().catch(() => {});
  }
}

main();
