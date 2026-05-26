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
import { readFileSync, existsSync, mkdirSync, chmodSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";

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
  console.warn(
    "[warn] WORKER_MODE=central-dev is for development only; Admin must run with NODE_ENV!=='production'"
  );
}

const WORKER_ID = (process.env.WORKER_ID ?? "local-dev").slice(0, 64);
const APP_VERSION = process.env.APP_VERSION ?? readPkgVersion();
const PLATFORM = process.platform;
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
  | "push_blog";

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
  | "retryable_failed"
  | "non_retryable_failed"
  | "login_required"
  | "captcha_detected"
  | "blocked"
  | "not_implemented"
  | "cancelled";

type CallbackBody = {
  job_id: string;
  status: CallbackStatus;
  error?: string;
  summary?: string;
  bookings?: ScrapedBooking[];
  sales?: unknown;
  external_id?: string;
  block?: { until: string; reason: string };
};

// ------------------------------------------------------------
// HTTP
// ------------------------------------------------------------
async function fetchJobs(limit = 1): Promise<Job[]> {
  const res = await fetch(`${API}/api/salonboard/jobs?limit=${limit}`, {
    headers: buildAuthHeaders(),
  });
  if (!res.ok) {
    const body = await safeText(res);
    throw new Error(`jobs fetch failed: ${res.status} ${body}`);
  }
  const json = (await res.json()) as { jobs?: Job[]; mode?: string };
  return json.jobs ?? [];
}

async function report(body: CallbackBody): Promise<void> {
  const res = await fetch(`${API}/api/salonboard/callback`, {
    method: "POST",
    headers: {
      ...buildAuthHeaders(),
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
    // DRY_RUN: SalonBoard に一切触らず、成功扱いでフローだけ確認する。
    // push_blog で external_id を入れると content_posts に書き込みが走ってしまうので
    // ID は入れない (Admin 側で last_error に warning が残るのは想定内)。
    await report({
      job_id: job.id,
      status: "succeeded",
      summary: `[DRY_RUN] ${job.job_type} skipped`,
      ...(job.job_type === "fetch_bookings" ? { bookings: [] } : {}),
      ...(job.job_type === "fetch_sales"
        ? { sales: { target_date: todayJst(), total_sales: 0, raw: { dry_run: true } } }
        : {}),
      ...(job.job_type === "push_booking"
        ? { external_id: `dryrun-${job.id.slice(0, 8)}` }
        : {}),
    });
    console.log(`[job] done  ${tag} (dry-run succeeded)`);
    return;
  }

  const baseUrl = job.credentials.base_url ?? "https://salonboard.com/";
  const ssPath = storageStatePathFor(job.shop_id);

  let browser: Browser | null = null;
  let ctx: BrowserContext | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    ctx = await browser.newContext({
      storageState: readStorageState(ssPath),
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      locale: "ja-JP",
      timezoneId: "Asia/Tokyo",
    });
    const page = await ctx.newPage();

    // 1) ログイン済み判定 → 必要時のみ tryLogin
    let auth = await isLoggedIn(page, baseUrl);
    if (auth === "captcha") {
      await report({
        job_id: job.id,
        status: "captcha_detected",
        error: "captcha at landing",
        block: {
          until: new Date(Date.now() + 6 * 60 * 60_000).toISOString(),
          reason: "reCAPTCHA encountered before login",
        },
      });
      console.log(`[job] done  ${tag} (captcha at landing)`);
      return;
    }

    if (auth !== "logged_in") {
      const loginUrl = new URL("/login/", baseUrl).toString();
      const loginResult = await tryLogin(page, loginUrl, {
        loginId: job.credentials.login_id,
        password: job.credentials.password,
      });

      if (loginResult.status === "captcha") {
        await report({
          job_id: job.id,
          status: "captcha_detected",
          error: "captcha at login",
          block: {
            until: new Date(Date.now() + 6 * 60 * 60_000).toISOString(),
            reason: "reCAPTCHA encountered during login",
          },
        });
        console.log(`[job] done  ${tag} (captcha)`);
        return;
      }

      if (loginResult.status === "failed") {
        // 「ID/PW 不一致」っぽい reason は login_required。
        // ネット系/タイムアウトは retryable_failed。
        const reason = loginResult.reason ?? "login failed";
        const isAuthLike =
          /still on login|invalid|incorrect|password|userId|loginId|認証/i.test(
            reason
          );
        await report({
          job_id: job.id,
          status: isAuthLike ? "login_required" : "retryable_failed",
          error: reason,
        });
        console.log(
          `[job] done  ${tag} (login failed -> ${
            isAuthLike ? "login_required" : "retryable_failed"
          })`
        );
        return;
      }

      // ログイン成功時のみ storageState を保存
      await saveStorageState(ctx, ssPath);
      auth = "logged_in";
    }

    // 2) ジョブ実行
    if (job.job_type === "push_blog") {
      const result = await pushBlog(page, job);
      if (result.status === "ok") {
        await report({
          job_id: job.id,
          status: "succeeded",
          summary: `push_blog posted (external_id=${result.externalId})`,
          external_id: result.externalId,
        });
        console.log(`[job] done  ${tag} (blog posted ${result.externalId})`);
      } else if (result.status === "warning") {
        // 投稿はできたが external_id が拾えなかった。仮 ID は送らない。
        await report({
          job_id: job.id,
          status: "succeeded",
          summary: `push_blog likely posted; external_id missing (${result.reason})`,
        });
        console.log(`[job] done  ${tag} (blog posted but id missing)`);
      } else {
        await report({
          job_id: job.id,
          status: result.statusCode,
          error: result.reason,
        });
        console.log(
          `[job] done  ${tag} (push_blog ${result.statusCode}: ${result.reason})`
        );
      }
      return;
    }

    // 未実装ジョブ: succeeded ではなく not_implemented
    await report({
      job_id: job.id,
      status: "not_implemented",
      error: `${job.job_type} scraper not implemented`,
      summary: `${job.job_type} not implemented (login ok)`,
    });
    console.log(`[job] done  ${tag} (not_implemented)`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[job] error ${tag}: ${msg}`);
    await report({ job_id: job.id, status: "retryable_failed", error: msg });
  } finally {
    await ctx?.close().catch(() => {});
    await browser?.close().catch(() => {});
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
  baseUrl: string
): Promise<"logged_in" | "needs_login" | "captcha" | "unknown"> {
  const candidates = [
    new URL("/KLP/", baseUrl).toString(),
    new URL("/CNF/", baseUrl).toString(),
    baseUrl,
  ];
  for (const url of candidates) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
    } catch {
      continue;
    }
    if ((await page.locator('iframe[src*="recaptcha"]').count()) > 0) {
      return "captcha";
    }
    // ログインフォームの input が見えていれば未ログイン
    const loginInputCount = await page
      .locator(
        'input[name="userId"], input[name="loginId"], input[name="password"], input[type="password"]'
      )
      .count();
    if (loginInputCount > 0) {
      return "needs_login";
    }
    // URL が /login にリダイレクトされている場合も未ログイン
    if (/login/i.test(page.url())) {
      return "needs_login";
    }
    // 「セッション切れ」等の文言を簡易チェック
    const expiredText = await page
      .locator('text=/再ログイン|セッション|タイムアウト|ログインしてください/')
      .first()
      .count();
    if (expiredText > 0) {
      return "needs_login";
    }
    return "logged_in";
  }
  return "unknown";
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
      page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {}),
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
    `[boot] api=${API} mode=${WORKER_MODE} worker=${WORKER_ID} device=${
      WORKER_MODE === "device" ? DEVICE_ID.slice(0, 8) : "-"
    } version=${APP_VERSION} platform=${PLATFORM} dry_run=${DRY_RUN} once=${RUN_ONCE} poll=${POLL_MS}ms`
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
