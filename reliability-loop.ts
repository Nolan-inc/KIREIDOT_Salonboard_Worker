/**
 * 持続性バーストチェック (使い捨て)
 * ============================================================
 * 1度ログイン → セッション保持したまま N サイクル、一定間隔でスケジュールを
 * 閲覧し続け、同じISP-IPに連続アクセスしても「弾かれない/遅くならない/CAPTCHAが
 * 出ない/セッションが切れない」かを確認する。帯域は MAX_MB で安全上限。
 *
 * env:
 *   LOOP_CYCLES     反復回数 (既定 10)
 *   LOOP_INTERVAL_MS サイクル間隔 (既定 180000 = 3分)
 *   LOOP_MAX_MB     概算帯域の安全上限。超えたら打ち切り (既定 40)
 *   LOOP_LABEL      ログラベル
 */
import { chromium, type Page } from "playwright";
import { SB_CONTEXT_OPTIONS } from "./worker";
import { SB_PATHS } from "./salonboard-selectors";

const BASE_URL = process.env.SALONBOARD_BASE_URL ?? "https://salonboard.com/";
const LOGIN_ID = process.env.SALONBOARD_LOGIN_ID!;
const PASSWORD = process.env.SALONBOARD_PASSWORD!;
const CYCLES = Number(process.env.LOOP_CYCLES ?? 10);
const INTERVAL_MS = Number(process.env.LOOP_INTERVAL_MS ?? 180_000);
const MAX_MB = Number(process.env.LOOP_MAX_MB ?? 40);
const LABEL = process.env.LOOP_LABEL ?? "isp";
const T = () => new Date().toISOString().slice(11, 19);
const log = (...a: unknown[]) => console.log(`[loop:${LABEL} ${T()}]`, ...a);

let bytes = 0;

async function login(page: Page): Promise<boolean> {
  const loginUrl = new URL("/login/", BASE_URL).toString();
  await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  if ((await page.locator('iframe[src*="recaptcha"]').count()) > 0) {
    log("CAPTCHA on login");
    return false;
  }
  await page.locator('input[name="userId"], input[name="loginId"], input[type="text"]').first().fill(LOGIN_ID);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await Promise.all([
    page.waitForURL(/\/KLP\//, { timeout: 60_000 }).catch(() => {}),
    page
      .locator('button[type="submit"], input[type="submit"], a:has-text("ログイン")')
      .first()
      .click({ timeout: 15_000 })
      .catch(() => {}),
  ]);
  return /\/KLP\//.test(page.url());
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
  log(`start proxy=${proxy?.server ?? "DIRECT"} cycles=${CYCLES} interval=${INTERVAL_MS}ms maxMB=${MAX_MB}`);

  const browser = await chromium.launch({ headless, channel, proxy });
  const ctx = await browser.newContext({
    ...(channel ? { locale: "ja-JP", timezoneId: "Asia/Tokyo" } : SB_CONTEXT_OPTIONS),
  });
  let blocked = 0;
  let captcha = 0;
  ctx.on("response", (r) => {
    const cl = r.headers()["content-length"];
    if (cl) bytes += Number(cl) || 0;
    if ([403, 429].includes(r.status()) && r.url().includes("salonboard")) {
      blocked++;
      log(`[http ${r.status()}] ${r.url().slice(0, 90)}`);
    }
  });
  await ctx.route("**/*", (route) => {
    const t = route.request().resourceType();
    return t === "image" || t === "media" || t === "font" ? route.abort() : route.continue();
  });
  const page = await ctx.newPage();

  const results: { i: number; ms: number; ok: boolean; relogin: boolean; note: string }[] = [];

  // 初回ログイン
  log("initial login...");
  if (!(await login(page))) {
    log("RESULT: initial login FAILED");
    await browser.close();
    return;
  }
  log(`initial login OK -> ${page.url()}`);

  const today = new Date(Date.now() + 9 * 3600_000);
  const yyyymmdd = today.toISOString().slice(0, 10).replace(/-/g, "");
  const schedUrl = new URL(SB_PATHS.schedule, BASE_URL);
  schedUrl.searchParams.set("date", yyyymmdd);

  for (let i = 1; i <= CYCLES; i++) {
    if (bytes / 1e6 > MAX_MB) {
      log(`bandwidth cap ${MAX_MB}MB reached (${(bytes / 1e6).toFixed(1)}MB) — stopping early`);
      break;
    }
    const t0 = Date.now();
    let ok = false;
    let relogin = false;
    let note = "";
    try {
      await page.goto(schedUrl.toString(), { waitUntil: "domcontentloaded", timeout: 60_000 });
      let title = await page.title().catch(() => "");
      let url = page.url();
      if ((await page.locator('iframe[src*="recaptcha"]').count()) > 0) {
        captcha++;
        note = "CAPTCHA";
      } else if (/login|\/CNC\//i.test(url) || title.includes("ログイン")) {
        // セッション切れ → 再ログインして再取得
        relogin = true;
        const re = await login(page);
        note = re ? "re-login ok" : "re-login FAILED";
        if (re) {
          await page.goto(schedUrl.toString(), { waitUntil: "domcontentloaded", timeout: 60_000 });
          title = await page.title().catch(() => "");
          url = page.url();
        }
      }
      ok = title.includes("スケジュール") && !title.includes("エラー") && !/\/login/i.test(url);
      if (!note) note = title.slice(0, 24);
    } catch (e) {
      note = `ERR ${e instanceof Error ? e.message.split("\n")[0] : e}`;
    }
    const ms = Date.now() - t0;
    results.push({ i, ms, ok, relogin, note });
    log(`cycle ${i}/${CYCLES}: ${ok ? "OK" : "NG"} ${ms}ms relogin=${relogin} "${note}" [${(bytes / 1e6).toFixed(1)}MB]`);
    if (i < CYCLES) await page.waitForTimeout(INTERVAL_MS);
  }

  const okN = results.filter((r) => r.ok).length;
  const lat = results.filter((r) => r.ok).map((r) => r.ms);
  const avg = lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : -1;
  log("========== SUMMARY ==========");
  log(`cycles run : ${results.length}/${CYCLES}`);
  log(`success    : ${okN}/${results.length}`);
  log(`re-logins  : ${results.filter((r) => r.relogin).length}`);
  log(`captcha    : ${captcha}  http_block(403/429): ${blocked}`);
  log(`latency ok : avg ${avg}ms  [${lat.join(", ")}]`);
  log(`approx data: ${(bytes / 1e6).toFixed(2)}MB`);
  log(`verdict    : ${okN === results.length && captcha === 0 && blocked === 0 ? "STABLE ✓ (連続アクセスで弾かれず)" : "見直し要"}`);
  await browser.close().catch(() => {});
}

main();
