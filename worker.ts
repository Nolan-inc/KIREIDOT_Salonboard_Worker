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

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

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
const TOKEN = requireEnv("SALONBOARD_WORKER_TOKEN");
const WORKER_ID = process.env.WORKER_ID ?? "local-dev";
const POLL_MS = Number(process.env.POLL_INTERVAL_MS ?? 30_000);
const DRY_RUN =
  /^(1|true|yes)$/i.test(process.env.DRY_RUN ?? "") ||
  process.argv.includes("--dry-run");
const RUN_ONCE = process.argv.includes("--once");

function requireEnv(k: string): string {
  const v = process.env[k];
  if (!v) {
    console.error(`[fatal] env ${k} is required`);
    process.exit(1);
  }
  return v;
}

// ------------------------------------------------------------
// 型
// ------------------------------------------------------------
type JobType =
  | "fetch_bookings"
  | "fetch_sales"
  | "push_booking"
  | "cancel_booking";

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
  };
};

type CallbackBody = {
  job_id: string;
  status: "succeeded" | "failed" | "retry";
  error?: string;
  summary?: string;
  bookings?: unknown[];
  sales?: unknown;
  external_id?: string;
  block?: { until: string; reason: string };
};

// ------------------------------------------------------------
// HTTP
// ------------------------------------------------------------
async function fetchJobs(limit = 1): Promise<Job[]> {
  const res = await fetch(`${API}/api/salonboard/jobs?limit=${limit}`, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "X-Worker-Id": WORKER_ID,
    },
  });
  if (!res.ok) {
    const body = await safeText(res);
    throw new Error(`jobs fetch failed: ${res.status} ${body}`);
  }
  const json = (await res.json()) as { jobs?: Job[] };
  return json.jobs ?? [];
}

async function report(body: CallbackBody): Promise<void> {
  const res = await fetch(`${API}/api/salonboard/callback`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "X-Worker-Id": WORKER_ID,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error(
      `[warn] callback non-2xx: ${res.status} ${await safeText(res)}`
    );
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "<unreadable>";
  }
}

// ------------------------------------------------------------
// ジョブ処理
// ------------------------------------------------------------
async function handleJob(job: Job): Promise<void> {
  const tag = `${job.job_type} ${job.id.slice(0, 8)} (attempt ${job.attempts})`;
  console.log(`[job] start ${tag} shop=${job.shop_id.slice(0, 8)}`);

  if (DRY_RUN) {
    await report({
      job_id: job.id,
      status: "succeeded",
      summary: `[DRY_RUN] ${job.job_type} skipped`,
      // 各ジョブ種別ごとに最低限の空データを返し、Admin 側で反映フローが通るか確認できるようにする
      ...(job.job_type === "fetch_bookings" ? { bookings: [] } : {}),
      ...(job.job_type === "fetch_sales"
        ? { sales: { target_date: todayJst(), total_sales: 0, raw: { dry_run: true } } }
        : {}),
      ...(job.job_type === "push_booking" ? { external_id: `dryrun-${job.id.slice(0, 8)}` } : {}),
    });
    console.log(`[job] done  ${tag} (dry-run succeeded)`);
    return;
  }

  // Playwright でサロンボードへログインを試行する最小実装。
  // ログイン成否だけを報告し、スクレイパーは後続 PR で実装する。
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      locale: "ja-JP",
      timezoneId: "Asia/Tokyo",
    });
    const page = await ctx.newPage();

    const loginUrl = job.credentials.base_url ?? "https://salonboard.com/login/";
    const loginResult = await tryLogin(page, loginUrl, {
      loginId: job.credentials.login_id,
      password: job.credentials.password,
    });

    if (loginResult.status === "captcha") {
      await report({
        job_id: job.id,
        status: "failed",
        error: "captcha_detected",
        block: {
          until: new Date(Date.now() + 6 * 60 * 60_000).toISOString(),
          reason: "reCAPTCHA encountered during login",
        },
      });
      console.log(`[job] done  ${tag} (captcha)`);
      return;
    }

    if (loginResult.status === "failed") {
      await report({
        job_id: job.id,
        status: "retry",
        error: loginResult.reason ?? "login_failed",
      });
      console.log(`[job] done  ${tag} (login failed -> retry)`);
      return;
    }

    // TODO: ここから各ジョブタイプごとの処理を実装する
    //  - fetch_bookings: 予約一覧ページへ遷移して scrape -> bookings[]
    //  - fetch_sales:    売上ページへ遷移して scrape -> sales
    //  - push_booking:   payload.booking_id から予約を取り出して登録
    //  - cancel_booking: payload.booking_id の予約をサロンボード上で取消
    //
    // 現状は「ログインできたけどまだ実装が無い」として succeeded で報告する。
    // これで queued -> succeeded への遷移を確認できる。
    await report({
      job_id: job.id,
      status: "succeeded",
      summary: `${job.job_type} login ok; scraper not implemented yet`,
      ...(job.job_type === "fetch_bookings" ? { bookings: [] } : {}),
      ...(job.job_type === "fetch_sales"
        ? { sales: { target_date: todayJst(), total_sales: 0, raw: { skeleton: true } } }
        : {}),
    });
    console.log(`[job] done  ${tag} (login ok, scraper TODO)`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[job] error ${tag}: ${msg}`);
    await report({ job_id: job.id, status: "retry", error: msg });
  } finally {
    await browser?.close().catch(() => {});
  }
}

async function tryLogin(
  page: Page,
  url: string,
  c: { loginId: string; password: string }
): Promise<{ status: "ok" } | { status: "failed"; reason?: string } | { status: "captcha" }> {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  } catch (e) {
    return { status: "failed", reason: `navigation: ${e instanceof Error ? e.message : e}` };
  }

  if ((await page.locator('iframe[src*="recaptcha"]').count()) > 0) {
    return { status: "captcha" };
  }

  // セレクタはサロンボードの実画面に合わせて後で微調整する
  const idInput = page.locator('input[name="userId"], input[name="loginId"], input[type="text"]').first();
  const pwInput = page.locator('input[name="password"], input[type="password"]').first();

  try {
    await idInput.fill(c.loginId, { timeout: 10_000 });
    await pwInput.fill(c.password, { timeout: 10_000 });
  } catch (e) {
    return { status: "failed", reason: `cannot find login inputs: ${e instanceof Error ? e.message : e}` };
  }

  try {
    await Promise.all([
      page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {}),
      page.locator('button[type="submit"], input[type="submit"]').first().click({ timeout: 10_000 }),
    ]);
  } catch (e) {
    return { status: "failed", reason: `submit: ${e instanceof Error ? e.message : e}` };
  }

  if ((await page.locator('iframe[src*="recaptcha"]').count()) > 0) {
    return { status: "captcha" };
  }

  // ログイン画面にまだ残っていたら失敗とみなす
  const stillOnLogin =
    (await pwInput.count()) > 0 || /login/i.test(page.url());
  if (stillOnLogin) {
    return { status: "failed", reason: "still on login page" };
  }
  return { status: "ok" };
}

function todayJst(): string {
  // yyyy-mm-dd (JST)
  const d = new Date();
  const jst = new Date(d.getTime() + 9 * 3600_000);
  return jst.toISOString().slice(0, 10);
}

// ------------------------------------------------------------
// メインループ
// ------------------------------------------------------------
async function pollOnce(): Promise<number> {
  let jobs: Job[];
  try {
    jobs = await fetchJobs(1);
  } catch (e) {
    console.error(`[poll] fetch error: ${e instanceof Error ? e.message : e}`);
    return 0;
  }
  if (jobs.length === 0) return 0;
  for (const job of jobs) {
    await handleJob(job);
  }
  return jobs.length;
}

async function main() {
  console.log(
    `[boot] api=${API} worker=${WORKER_ID} dry_run=${DRY_RUN} once=${RUN_ONCE} poll=${POLL_MS}ms`
  );

  if (RUN_ONCE) {
    const n = await pollOnce();
    console.log(`[exit] processed ${n} job(s) and exiting`);
    return;
  }

  // 終了ハンドリング
  let stopping = false;
  const stop = () => {
    stopping = true;
    console.log("\n[boot] shutting down...");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  // メインループ: 1ジョブ処理 -> ポーリング間隔待機
  while (!stopping) {
    const processed = await pollOnce();
    if (stopping) break;
    // ジョブがあった直後は連続で処理するため短めの待機
    const wait = processed > 0 ? 1_000 : POLL_MS;
    await sleep(wait);
  }
  console.log("[boot] bye");
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  console.error("[fatal]", e);
  process.exit(1);
});
