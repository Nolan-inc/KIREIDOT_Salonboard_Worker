/**
 * プロキシ経由ログイン診断 v2 (使い捨て / リトライ付き)
 * ============================================================
 * 住宅プロキシの ERR_EMPTY_RESPONSE 不安定さを吸収しつつ、実際に
 * /login → 認証 → スケジュール閲覧まで完遂できるかを確かめる。
 * 二重ナビゲーション (tryLogin の再goto) を避け、1フローで判定する。
 */
import { chromium, type Page } from "playwright";
import { SB_CONTEXT_OPTIONS } from "./worker";
import { SB_PATHS } from "./salonboard-selectors";

const BASE_URL = process.env.SALONBOARD_BASE_URL ?? "https://salonboard.com/";
const LOGIN_ID = process.env.SALONBOARD_LOGIN_ID!;
const PASSWORD = process.env.SALONBOARD_PASSWORD!;
const OUT = process.env.PROBE_OUT ?? "/tmp/sbprobe2";
const log = (...a: unknown[]) => console.log("[probe2]", ...a);
const msg = (e: unknown) => (e instanceof Error ? e.message.split("\n")[0] : String(e));

async function gotoRetry(page: Page, url: string, tries = 5): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      return true;
    } catch (e) {
      log(`  goto try ${i + 1}/${tries} failed: ${msg(e)}`);
      await page.waitForTimeout(2500);
    }
  }
  return false;
}

async function dump(page: Page, label: string) {
  log(`${label}: url=${page.url()} title=${await page.title().catch(() => "?")}`);
  const body = (await page.locator("body").innerText().catch(() => "")).slice(0, 400).replace(/\s+/g, " ");
  log(`${label}: body=${JSON.stringify(body)}`);
  try {
    await page.screenshot({ path: `${OUT}-${label}.png`, fullPage: true });
  } catch {
    /* ignore */
  }
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
  await ctx.route("**/*", (route) => {
    const t = route.request().resourceType();
    return t === "image" || t === "media" || t === "font" ? route.abort() : route.continue();
  });
  const page = await ctx.newPage();
  let emptyResp = 0;
  page.on("requestfailed", (req) => {
    const f = req.failure()?.errorText ?? "";
    if (f.includes("EMPTY_RESPONSE") || f.includes("CONNECTION")) {
      emptyResp++;
      if (req.url().includes("salonboard")) log(`  [reqfail] ${f} ${req.url().slice(0, 90)}`);
    }
  });

  try {
    const loginUrl = new URL("/login/", BASE_URL).toString();

    // 1. ログインページ到達 (リトライ)
    if (!(await gotoRetry(page, loginUrl))) {
      log("RESULT: login page UNREACHABLE after retries (proxy too unstable)");
      return;
    }
    await dump(page, "1-login");

    if ((await page.locator('iframe[src*="recaptcha"]').count()) > 0) {
      log("RESULT: CAPTCHA on login page");
      return;
    }

    // 2. 認証情報入力
    const idInput = page.locator('input[name="userId"], input[name="loginId"], input[type="text"]').first();
    const pwInput = page.locator('input[name="password"], input[type="password"]').first();
    await idInput.fill(LOGIN_ID, { timeout: 10_000 });
    await pwInput.fill(PASSWORD, { timeout: 10_000 });
    log("filled credentials");

    // 3. ログイン送信 (navigation を待つ。ERR_EMPTY_RESPONSE なら最大3回まで再送信)
    let loggedIn = false;
    for (let attempt = 1; attempt <= 3 && !loggedIn; attempt++) {
      try {
        await Promise.all([
          page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {}),
          page.locator('button[type="submit"], input[type="submit"], a:has-text("ログイン")').first().click({ timeout: 10_000 }),
        ]);
      } catch (e) {
        log(`  submit attempt ${attempt} click/nav issue: ${msg(e)}`);
      }
      await page.waitForTimeout(2000);
      const url = page.url();
      const pwLeft = await page.locator('input[type="password"]').count();
      const hasError = await page.locator('text=/IDまたはパスワード|ログインできません|認証に失敗/').count();
      log(`  after submit attempt ${attempt}: url=${url} pwLeft=${pwLeft} errText=${hasError}`);
      if (!/login/i.test(url) && pwLeft === 0) {
        loggedIn = true;
      } else if (hasError > 0) {
        log("RESULT: LOGIN_FAILED (bad credentials)");
        await dump(page, "2-loginfail");
        return;
      } else {
        // まだログイン画面 → ERR_EMPTY_RESPONSE で送信が空振りした可能性。再試行のため再goto
        await gotoRetry(page, loginUrl, 3);
        await idInput.fill(LOGIN_ID, { timeout: 10_000 }).catch(() => {});
        await pwInput.fill(PASSWORD, { timeout: 10_000 }).catch(() => {});
      }
    }

    await dump(page, "2-afterlogin");
    if (!loggedIn) {
      log(`RESULT: login did not complete (emptyResp count=${emptyResp}). 認証情報は正しいがプロキシ不安定の可能性`);
      return;
    }
    log("LOGIN OK ✓");

    // 4. スケジュール閲覧 (リトライ)
    const today = new Date(Date.now() + 9 * 3600_000);
    const yyyymmdd = today.toISOString().slice(0, 10).replace(/-/g, "");
    const schedUrl = new URL(SB_PATHS.schedule, BASE_URL);
    schedUrl.searchParams.set("date", yyyymmdd);
    if (await gotoRetry(page, schedUrl.toString(), 5)) {
      await dump(page, "3-schedule");
      const title = await page.title().catch(() => "");
      log(`RESULT: SCHEDULE ${title.includes("エラー") ? "ERROR PAGE" : "OK"} title=${title}`);
    } else {
      log("RESULT: schedule unreachable after retries (proxy unstable)");
    }
  } catch (e) {
    log("FATAL", msg(e));
  } finally {
    log(`total empty/conn failures observed: ${emptyResp}`);
    await browser.close().catch(() => {});
  }
}

main();
