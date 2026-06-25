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
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, statSync, copyFileSync, cpSync } from "node:fs";
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
  alreadyAbsent?: boolean;
};
type ScraperFn = (
  page: Page,
  payload: unknown,
  opts: Record<string, unknown>,
) => Promise<ScraperResult>;
type ScrapersModule = {
  cancelBookingViaForm: ScraperFn;
  deleteScheduleViaForm: ScraperFn;
  pushShiftsViaForm: ScraperFn;
  postPhotoGalleryViaForm: ScraperFn;
  deleteBlogViaForm: ScraperFn;
  postReviewReplyViaForm: ScraperFn;
  // fetch 系 (status ではなく rows/patterns を返す)
  scrapeBookings: (
    page: Page,
    opts: Record<string, unknown>,
  ) => Promise<{ rows: unknown[]; debug?: unknown }>;
  scrapeShiftPatterns: (
    page: Page,
    baseUrl: string,
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

// 起動時に push モードを明示ログ (平文の値はそのまま出さない)。
console.log(
  `[cfg] SALONBOARD_ENABLE_PUSH=${ENABLE_PUSH ? "ON (登録ボタンを押します)" : "OFF (確認画面まで / 登録しません)"}`,
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
  | "fetch_photo_gallery";

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
): Promise<void> {
  const tag = `${jobType} ${job.id.slice(0, 8)}`;
  if (result.status === "ok") {
    await report({
      job_id: job.id,
      job_type: jobType,
      status: "succeeded",
      external_id: result.externalId ?? result.recoveredReserveId ?? null,
      summary: result.summary ?? `${jobType} 完了`,
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
  const exhausted = job.attempts + 1 >= cap;
  const isCaptcha = result.errorCode === "RECAPTCHA_REQUIRED";
  const toManual = !!result.manualRequired || exhausted;
  await report({
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
  } as unknown as CallbackBody);
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
  const ssPath = storageStatePathFor(job.shop_id);

  let browser: Browser | null = null;
  let ctx: BrowserContext | null = null;
  try {
    const { launch, realChrome } = resolveLaunchOptions(job.credentials.proxy);
    if (launch.proxy) {
      console.log(
        `[job] ${tag} proxy=${launch.proxy.server} channel=${launch.channel ?? "chromium"} headless=${launch.headless}`
      );
    }
    // 自動化指紋を隠した永続コンテキストで起動 (PC と同じステルス)。session は
    // userDataDir に永続するため storageState は使わない (蓄積で Akamai 信頼を育てる)。
    ctx = await launchStealthContext({ launch, realChrome, shopId: job.shop_id });
    browser = ctx.browser();
    const page = ctx.pages()[0] ?? (await ctx.newPage());

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
      let loginResult = await tryLogin(page, loginUrl, {
        loginId: job.credentials.login_id,
        password: job.credentials.password,
      });
      // 一過性のナビゲーション失敗 (chrome-error / ERR_ / doLogin 未完了 / submit) は
      // プロキシの瞬断であることが多い。最大3回までログインをやり直す。認証拒否
      // (still on login form) や captcha はリトライしない (reason で判定)。
      for (
        let lt = 1;
        lt < 3 &&
        loginResult.status === "failed" &&
        /did not complete|chrome-error|ERR_|navigation|submit|net::/i.test(
          loginResult.reason ?? ""
        );
        lt++
      ) {
        console.log(
          `[job] ${tag} login retry ${lt} (${(loginResult.reason ?? "").slice(0, 50)})`
        );
        await page.waitForTimeout(2500);
        loginResult = await tryLogin(page, loginUrl, {
          loginId: job.credentials.login_id,
          password: job.credentials.password,
        });
      }

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

    if (job.job_type === "push_booking") {
      const payload = job.payload as PushBookingPayload;
      const result = await pushBookingViaProvenForm(page, job, payload);

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
            : `push_booking 登録完了 (external_id=${result.externalId ?? "?"})`,
        });
        console.log(
          `[job] done  ${tag} (push_booking ok${
            result.alreadyExists ? " already_exists" : ""
          })`,
        );
      } else if (result.status === "confirm_only") {
        // 確認画面まで照合 OK。ENABLE_PUSH=false のため登録せず手動確認に回す。
        await report({
          job_id: job.id,
          job_type: "push_booking",
          status: "manual_required",
          booking_id: payload.booking_id,
          error_code: "PUSH_DISABLED",
          error:
            "確認画面の照合まで成功しましたが、自動登録が無効 (SALONBOARD_ENABLE_PUSH=未設定) のため登録していません。SalonBoard で内容を確認のうえ手動登録してください。",
          manual_required: true,
          result_payload: result.confirmed,
        });
        console.log(`[job] done  ${tag} (push_booking confirm_only -> manual_required)`);
      } else {
        // failed: manualRequired によって failed / manual_required を切り替える。
        // 自動リトライ上限を超えていれば強制的に manual_required。
        // 上限はジョブ側の max_attempts を正とし、未指定時のみ既定値を使う。
        const cap = job.max_attempts || MAX_PUSH_ATTEMPTS;
        const exhausted = job.attempts + 1 >= cap;
        const toManual = result.manualRequired || exhausted;
        const isCaptcha = result.errorCode === "RECAPTCHA_REQUIRED";
        await report({
          job_id: job.id,
          job_type: "push_booking",
          status: isCaptcha
            ? "captcha_detected"
            : toManual
              ? "manual_required"
              : // 一時的失敗扱いにできるのは SLOT_NOT_AVAILABLE / UNKNOWN のみ。
                "retryable_failed",
          booking_id: payload.booking_id,
          error_code: result.errorCode,
          error: result.reason,
          manual_required: toManual,
          ...(isCaptcha
            ? {
                block: {
                  until: new Date(Date.now() + 6 * 60 * 60_000).toISOString(),
                  reason: "reCAPTCHA during push_booking",
                },
              }
            : {}),
        });
        console.log(
          `[job] done  ${tag} (push_booking ${result.errorCode}: ${result.reason})`,
        );
      }
      return;
    }

    // ---- Phase 2: scrapers.cjs 再利用ハンドラ群 ----------------------------
    // salon_id / shop_name は worker.ts の job/credentials には現状無いため null
    // フォールバック (単一サロン店舗は問題なし。複数サロン店舗の正確な選択には
    // Admin 側で credentials.salon_id / shop_name を同梱する必要がある)。
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
            });
      await reportScraperResult(job, "cancel_booking", result, {
        booking_id: p.booking_id ?? null,
      });
      return;
    }

    if (job.job_type === "push_shifts") {
      // 注: PC 版は読み取った勤務パターンを Supabase に直接保存するが、クラウドは
      // Admin callback のみ。push_shifts は status 報告で足りるため、パターン保存は
      // fetch_shift_patterns 側に委ねる (ここではスキップ)。
      const result = await scrapers.pushShiftsViaForm(page, job.payload, {
        baseUrl,
        enablePush: ENABLE_PUSH,
      });
      await reportScraperResult(job, "push_shifts", result);
      return;
    }

    if (job.job_type === "push_photo_gallery") {
      const result = await scrapers.postPhotoGalleryViaForm(page, job.payload, {
        baseUrl,
        enablePost: ENABLE_PUSH,
        salonId,
        shopName,
      });
      await reportScraperResult(job, "push_photo_gallery", result);
      return;
    }

    if (job.job_type === "delete_blog") {
      const p = job.payload as Record<string, unknown>;
      const result = await scrapers.deleteBlogViaForm(page, p, {
        baseUrl,
        enableDelete: ENABLE_PUSH,
      });
      await reportScraperResult(job, "delete_blog", result, {
        content_post_id: p.content_post_id ?? null,
        // external_id は ok 時のみ。confirm_only/failed で送ると Admin が
        // 早期に削除済みと誤判定しうる (PC worker-process.cjs と同じ)。
        ...(result.status === "ok"
          ? { external_id: result.externalId ?? p.external_blog_id ?? null }
          : {}),
      });
      return;
    }

    if (job.job_type === "push_review_reply") {
      const p = job.payload as Record<string, unknown>;
      const result = await scrapers.postReviewReplyViaForm(page, p, {
        baseUrl,
        enablePost: ENABLE_PUSH,
      });
      await reportScraperResult(job, "push_review_reply", result, {
        review_import_id: p.review_import_id ?? null,
      });
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
        await page
          .goto(new URL("/KLP/top/", baseUrl).toString(), {
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
        console.log(`[scrape] warmup /KLP/top/ state=${topState} url=${page.url()}`);
      } catch {
        /* warmup is best-effort */
      }
      // loginId/password は debug capture の PII マスク用に渡す (PC と同じ)。
      const { rows, debug } = await scrapers.scrapeBookings(page, {
        baseUrl,
        genre,
        loginId: job.credentials.login_id,
        password: job.credentials.password,
      });
      // hair フローはログアウトを throw せず debug.loggedOut で返すことがある。
      // succeeded(0件) にすると同期がサイレントに消えるので retryable に倒す。
      if ((debug as { loggedOut?: boolean } | undefined)?.loggedOut) {
        await report({
          job_id: job.id,
          job_type: "fetch_bookings",
          status: "retryable_failed",
          error: `session lost during bookings scrape (landedOn=${
            (debug as { landedOn?: string })?.landedOn ?? "?"
          })`,
        } as unknown as CallbackBody);
        console.log(`[job] done  ${tag} (fetch_bookings session lost -> retryable)`);
        return;
      }
      const bookings = rows ?? [];
      // Admin callback (job_type=fetch_bookings) が bookings[] を
      // salonboard_bulk_upsert_bookings RPC で upsert する。PC の定期ループと同 RPC。
      await report({
        job_id: job.id,
        job_type: "fetch_bookings",
        status: "succeeded",
        bookings,
        summary: `fetch_bookings: ${bookings.length}件取得 (genre=${genre})`,
      } as unknown as CallbackBody);
      console.log(`[job] done  ${tag} (fetch_bookings ${bookings.length}件)`);
      return;
    }

    if (job.job_type === "fetch_shift_patterns") {
      // patterns を callback に載せ、Admin 側で既存 RPC salonboard_bulk_upsert_shift_patterns
      // に渡す (PC は supabase 直呼びだが、クラウドは Admin callback 経由)。
      // scrapeShiftPatterns は取得不可時に code 付きで throw する (空配列は返さない)。
      // SHIFT_PATTERNS_NONE/PARSE は再試行しても直らないので manual_required に倒す
      // (PC worker-process.cjs と同じ分類)。
      try {
        const res = await scrapers.scrapeShiftPatterns(page, baseUrl);
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
        const exhausted = job.attempts + 1 >= cap;
        const isCaptcha = code === "RECAPTCHA_REQUIRED";
        const noRetry =
          isCaptcha ||
          code === "SHIFT_PATTERNS_NONE" ||
          code === "SHIFT_PATTERNS_PARSE" ||
          code === "SHIFT_PATTERNS_EMPTY" ||
          exhausted;
        await report({
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
        } as unknown as CallbackBody);
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
      };
      const m = FETCH_MAP[job.job_type];
      if (m) {
        const genre =
          (job as { genre?: string }).genre === "hair" ? "hair" : "esthetic";
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
          const exhausted = job.attempts + 1 >= cap;
          const isCaptcha = code === "RECAPTCHA_REQUIRED";
          const noRetry = isCaptcha || exhausted;
          await report({
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
          } as unknown as CallbackBody);
          console.log(`[job] done  ${tag} (${job.job_type} ${code})`);
        }
        return;
      }
    }

    // 未実装ジョブ: succeeded ではなく not_implemented
    // (残: fetch_sales = scrapers.cjs に scraper 未実装のためスキップ。PC にも無い)
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
/**
 * SB_PROXY_POOL=host:port,host:port,... が設定されていれば round-robin で1つ返す。
 * 単一IP酷使による評判劣化 (ERR_TUNNEL_CONNECTION_FAILED) を避け、各IPの休息を増やす
 * (複数店舗スケール時の必須対策)。未設定なら従来の SB_PROXY_SERVER。
 */
function pickPooledProxyServer(): string {
  const pool = (process.env.SB_PROXY_POOL || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (pool.length === 0) return process.env.SB_PROXY_SERVER || "";
  const pick = pool[_proxyRrCounter % pool.length];
  _proxyRrCounter += 1;
  return pick;
}

function resolveLaunchOptions(
  credProxy?: { server: string; username?: string | null; password?: string | null } | null
): ResolvedLaunch {
  const channel = process.env.SB_BROWSER_CHANNEL || undefined;
  const headless = process.env.SB_HEADLESS !== "0";
  const rawServer = credProxy?.server || pickPooledProxyServer();
  const proxy = rawServer
    ? {
        // Playwright の proxy.server はスキーム必須。host:port だけなら http:// を補う。
        server: /:\/\//.test(rawServer) ? rawServer : `http://${rawServer}`,
        username: credProxy?.username ?? process.env.SB_PROXY_USERNAME ?? undefined,
        password: credProxy?.password ?? process.env.SB_PROXY_PASSWORD ?? undefined,
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
}): Promise<BrowserContext> {
  const userDataDir = join(
    homedir(),
    ".kireidot",
    "salonboard-chrome-profile",
    opts.shopId
  );
  try {
    mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
  } catch {
    /* 作れない環境では Playwright が一時 dir を使う */
  }
  if (/^(1|true|yes)$/i.test(process.env.SALONBOARD_USE_USER_PROFILE ?? "")) {
    console.log(
      `[cfg] Chrome profile seed: ${JSON.stringify(seedUserChromeProfile(userDataDir))}`
    );
  }
  const ctx = await chromium.launchPersistentContext(userDataDir, {
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
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    // 実 Chrome は本物 UA を使う。bundled chromium のみ従来の Mac UA 偽装。
    ...(opts.realChrome
      ? {}
      : {
          userAgent:
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        }),
  });
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
  // 注意: "/KLP/" (末尾スラッシュのみ) は 404「指定されたURLは存在しません」
  // エラー画面を返す。ログインフォームが無く URL も /login を含まないため、旧実装は
  // これを logged_in と誤判定し、無効セッションのまま scrape して常に 0 件になっていた。
  // → 管理 TOP (/KLP/top/) を開き、グローバルナビ「予約管理」の有無で **肯定的に**
  //   ログイン判定する。判定できない画面 (404 / セッション切れ / 不明) は安全側に倒して
  //   再ログインする (誤って scrape に進ませない)。
  const candidates = [
    new URL("/KLP/top/", baseUrl).toString(),
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
    // 肯定的判定: 管理画面のグローバルナビ(予約管理)が見えていれば logged_in。
    const mgmtNav = await page
      .locator('text=予約管理')
      .count()
      .catch(() => 0);
    if (mgmtNav > 0) {
      return "logged_in";
    }
    // ログインフォームの input / /login リダイレクト → 未ログイン。
    const loginInputCount = await page
      .locator(
        'input[name="userId"], input[name="loginId"], input[name="password"], input[type="password"]'
      )
      .count();
    if (loginInputCount > 0 || /login/i.test(page.url())) {
      return "needs_login";
    }
    // それ以外 (エラー画面 / 404 / セッション切れ / 不明) は安全側に倒して再ログイン。
    return "needs_login";
  }
  return "needs_login";
}

/**
 * プロキシ/ネットワークの一時的失敗を表すナビゲーションエラーか判定する。
 * 特に Decodo ISP プロキシは稀に tunnel をドロップし
 * `net::ERR_TUNNEL_CONNECTION_FAILED` を返す (curl では同時刻に疎通する=恒久障害ではない)。
 * これらは即時リトライで回復するため、恒久エラー (DNS 不正・証明書等) と区別する。
 */
function isTransientNavError(msg: string): boolean {
  return /ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED|ERR_EMPTY_RESPONSE|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_CONNECTION_FAILED|ERR_CONNECTION_TIMED_OUT|ERR_TIMED_OUT|ERR_NETWORK_CHANGED|ERR_SOCKET_NOT_CONNECTED|ERR_HTTP2_PING_FAILED|ERR_ABORTED|ERR_NETWORK_IO_SUSPENDED/i.test(
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
    try {
      await loc.click({ timeout: 8_000 }).catch(() => {});
      await loc.pressSequentially(value, { delay: 90, timeout: 8_000 });
      const got = await loc.inputValue().catch(() => "");
      if (got && got.length >= Math.min(value.length, 1)) return true;
    } catch {
      /* fall through to fill */
    }
    try {
      await loc.fill(value, { timeout: 8_000 });
      return true;
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
    // 1) 最初に見つかったログインボタン候補をクリック。click はログイン遷移と
    //    競合して reject することがある (locator.click が "navigation to finish"
    //    待ちで throw) ので throw は握り潰す。成否は後段の URL/フォーム残存で判定。
    for (const sel of submitCandidates) {
      const loc = page.locator(sel).first();
      if ((await loc.count().catch(() => 0)) === 0) continue;
      await loc.click({ timeout: 5_000 }).catch(() => {});
      break;
    }
    await page.waitForLoadState("networkidle", { timeout: 12_000 }).catch(() => {});
    // 2) クリックで遷移しなかった (まだログインフォームに居る) 場合は、password 欄で
    //    Enter (onkeypress="enterActionLogin") を送る。両方試すことで、ボタンの
    //    onclick が効かない / Enter が効かない どちらの環境でもログインを通す。
    if (
      (await pwInput.count().catch(() => 0)) > 0 &&
      /login/i.test(page.url())
    ) {
      await pwInput.press("Enter").catch(() => {});
      await page.waitForLoadState("networkidle", { timeout: 12_000 }).catch(() => {});
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
    .waitForURL((u) => !/doLogin/i.test(u.toString()), { timeout: 15_000 })
    .catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});

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
  if ((pageInfo && pageInfo.hasMgmt) || /\/KLP\//i.test(page.url())) {
    return { status: "ok" };
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
): Promise<PushBookingResult> {
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
        },
      ) => Promise<PushBookingResult>;
    }
  ).pushBookingViaForm(page, p, {
    baseUrl,
    enablePush: ENABLE_PUSH,
    salonId,
    shopName,
    genre,
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
  await page.waitForLoadState("networkidle", { timeout: 12_000 }).catch(() => {});
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
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
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
  // スタッフ (URL で初期選択されるが念のため value=external_id で明示)
  const staffSel = page.locator(REGISTER_FORM.staffSelect.selector).first();
  if ((await staffSel.count().catch(() => 0)) > 0) {
    await staffSel
      .selectOption({ value: p.salonboard_staff_external_id })
      .catch(async () => {
        if (p.staff_name) await staffSel.selectOption({ label: p.staff_name }).catch(() => {});
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
    .inputValue()
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
    .selectOption({ value: String(when.hour) })
    .catch(() => {});
  await page
    .locator(REGISTER_FORM.startMinute.selector)
    .first()
    .selectOption({ value: startMM })
    .catch(() => {});

  // 所要時間 → 終了時間。rsvTermHour の option value は「分換算」(60=1時間)。
  // duration_min を 60 で割った時間ぶんを value にし、端数を rsvTermMinute に。
  const durMin = p.duration_min ?? 60;
  const termHourVal = String(Math.floor(durMin / 60) * 60); // 例 90分→"60"
  const termMinVal = String(durMin % 60).padStart(2, "0"); // 例 90分→"30"
  await page
    .locator(REGISTER_FORM.termHour.selector)
    .first()
    .selectOption({ value: termHourVal })
    .catch(() => {});
  await page
    .locator(REGISTER_FORM.termMinute.selector)
    .first()
    .selectOption({ value: termMinVal })
    .catch(() => {});

  // メニュー = ネット予約クーポン。label 完全一致 → 部分一致の順で試す。
  let menuFilled = false;
  const menuSel = page.locator(REGISTER_FORM.menuSelect.selector).first();
  if ((await menuSel.count().catch(() => 0)) > 0) {
    await menuSel
      .selectOption({ label: menuTarget })
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
        await menuSel.selectOption({ value: val }).then(() => { menuFilled = true; }).catch(() => {});
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
    await page.locator(REGISTER_FORM.customerSei.selector).first().fill(sei, { timeout: 6_000 }).catch(() => {});
    await page.locator(REGISTER_FORM.customerMei.selector).first().fill(mei, { timeout: 6_000 }).catch(() => {});
    await page.locator(REGISTER_FORM.customerSeiKana.selector).first().fill(seiKana, { timeout: 6_000 }).catch(() => {});
    await page.locator(REGISTER_FORM.customerMeiKana.selector).first().fill(meiKana, { timeout: 6_000 }).catch(() => {});
  }
  // 電話 (任意・ハイフン無し数字のみ)
  if (p.customer_phone) {
    const tel = String(p.customer_phone).replace(/[^\d]/g, "");
    if (tel) await page.locator(REGISTER_FORM.customerPhone.selector).first().fill(tel, { timeout: 6_000 }).catch(() => {});
  }
  // 備考 (KIREIDOT予約ID を必ず入れる → 二重登録チェックの照合キー)
  {
    const notesText =
      p.notes && p.notes.includes(kireidotRef)
        ? p.notes
        : `${p.notes ? p.notes + "\n" : ""}${kireidotRef}`;
    await page.locator(REGISTER_FORM.memo.selector).first().fill(notesText, { timeout: 6_000 }).catch(() => {});
  }

  // 設備(席/ベッド)割当。⚠️ エステ等ベッドのある店舗では登録フォームの #equipArea で
  // 設備の指定が必須のことがあり、未設定だと errorInput=true で「登録する」が無効化され
  // 登録されない (2026-06-24 実機検証で判明: confirm は出るが onclick=errorInput;return false)。
  // 実証済み scrapers.cjs pushBookingViaForm と同処理: payload 指定設備(EQ/名前)優先、
  // 無ければ空行に「ベッド」を入れる。設備が無い店舗では #equipArea が無く no-op。
  try {
    const pp = p as unknown as {
      salonboard_equipment_external_id?: string | null;
      salonboard_equipment_name?: string | null;
    };
    const wantedEquipId =
      (pp.salonboard_equipment_external_id || "").trim() || null;
    const wantedEquipName = (pp.salonboard_equipment_name || "").trim() || null;
    const equipSelector =
      'select[name="equipIdList"], #equipArea select.equipIdList, #equipArea select';
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
            .waitForSelector(equipSelector, { timeout: 5_000 })
            .catch(() => {});
        }
      }
      const equipSelects = page.locator(equipSelector);
      const n = await equipSelects.count().catch(() => 0);
      for (let i = 0; i < n; i++) {
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
              if (wantId) {
                const o = opts.find((o) => o.value === wantId);
                if (o) return o.value;
              }
              if (wantName) {
                const o = opts.find(
                  (o) => norm(o.textContent || "") === norm(wantName),
                );
                if (o) return o.value;
              }
              return null;
            },
            { wantId: wantedEquipId, wantName: wantedEquipName },
          )
          .catch(() => null);
        if (pick) {
          await sel.selectOption({ value: pick }).catch(() => {});
        } else {
          // payload 指定が無い/解決不可: 空行のみ「ベッド」を入れる。
          const needsSet = await sel
            .evaluate((el) => {
              const s = el as HTMLSelectElement;
              const cur = s.options[s.selectedIndex];
              return (
                !s.value ||
                (cur?.textContent || "").replace(/[○×\s]/g, "") === ""
              );
            })
            .catch(() => false);
          if (needsSet) {
            const bedVal = await sel
              .evaluate((el) => {
                const opt = Array.from((el as HTMLSelectElement).options).find(
                  (o) => (o.textContent || "").includes("ベッド"),
                );
                return opt ? opt.value : null;
              })
              .catch(() => null);
            if (bedVal) await sel.selectOption({ value: bedVal }).catch(() => {});
          }
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
  } catch {
    /* 設備割当の失敗は登録続行 (設備必須でない店舗もあるため) */
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
          detailUrl: `${baseUrl.replace(/\/$/, "")}/KLP/reserve/ext/extReserveDetail/?reserveId=${recovered}`,
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
        `${baseUrl.replace(/\/$/, "")}/KLP/reserve/ext/extReserveDetail/?reserveId=${found}`;
    }
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
