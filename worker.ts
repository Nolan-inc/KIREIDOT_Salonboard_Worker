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
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import {
  SCHEDULE,
  REGISTER_FORM,
  RESERVE_LIST,
  RESERVE_ID_RE,
  scheduleUrl,
  reserveRegistUrl,
  staffHeadId,
  staffOptionValue,
} from "./salonboard-selectors";

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

    if (job.job_type === "push_booking") {
      const payload = job.payload as PushBookingPayload;
      const result = await pushBooking(page, job, payload);

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
    await page.goto(schedUrl, { waitUntil: "domcontentloaded", timeout: 25_000 });
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
  const grid = page.locator(SCHEDULE.grid.selector).first();
  if ((await grid.count().catch(() => 0)) === 0) {
    await captureRegisterDebug(page, job, "schedule_grid_not_found");
    return fail(
      "予約スケジュールのグリッドが見つかりません",
      "UNKNOWN_ERROR",
      true,
    );
  }

  // 対象スタッフの列(行)ヘッダを external_id + 日付で特定。
  const staffHead = page
    .locator(staffHeadId(p.salonboard_staff_external_id, yyyymmdd))
    .first();
  if ((await staffHead.count().catch(() => 0)) === 0) {
    // その日にそのスタッフの列が無い = シフト外/退職など。
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
  );
  try {
    await page.goto(registUrl, { waitUntil: "domcontentloaded", timeout: 25_000 });
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
    await captureRegisterDebug(page, job, "register_page_not_found", {
      url: page.url(),
    });
    return fail(
      "予約登録フォームに到達できませんでした (ログイン切れ/画面変更の可能性)。",
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

  // 顧客名 (姓名分割)。p.customer_name を空白で姓/名に分ける。
  if (p.customer_name) {
    const parts = p.customer_name.trim().split(/[\s　]+/);
    const sei = parts[0] ?? p.customer_name;
    const mei = parts.slice(1).join(" ") || "";
    await page.locator(REGISTER_FORM.customerSei.selector).first().fill(sei, { timeout: 6_000 }).catch(() => {});
    if (mei) await page.locator(REGISTER_FORM.customerMei.selector).first().fill(mei, { timeout: 6_000 }).catch(() => {});
  }
  // 電話 (任意)
  if (p.customer_phone) {
    await page.locator(REGISTER_FORM.customerPhone.selector).first().fill(p.customer_phone, { timeout: 6_000 }).catch(() => {});
  }
  // 備考 (KIREIDOT予約ID を必ず入れる → 二重登録チェックの照合キー)
  {
    const notesText =
      p.notes && p.notes.includes(kireidotRef)
        ? p.notes
        : `${p.notes ? p.notes + "\n" : ""}${kireidotRef}`;
    await page.locator(REGISTER_FORM.memo.selector).first().fill(notesText, { timeout: 6_000 }).catch(() => {});
  }

  // 空き枠/エラーメッセージの検出 (入力直後にフォームが警告を出すことがある)
  const slotError = await page
    .locator("text=/予約できません|空いて|満員|埋ま|重複/")
    .count()
    .catch(() => 0);
  if (slotError > 0) {
    await captureRegisterDebug(page, job, "slot_not_available");
    return fail("SalonBoard側で対象時間が空いていません", "SLOT_NOT_AVAILABLE", false);
  }

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

  const beforeUrl = page.url();
  await Promise.all([
    page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {}),
    registerBtn.click({ timeout: 15_000 }),
  ]).catch(() => {});
  await page.waitForTimeout(1500);

  if (await hasRecaptcha(page)) {
    return fail(
      "登録後に reCAPTCHA が表示され、登録成否が判定できません",
      "RECAPTCHA_REQUIRED",
      true,
    );
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
    .locator("text=/完了|受け付け|登録しました|予約を登録/")
    .count()
    .catch(() => 0);
  const looksDone = doneText > 0 || afterUrl !== beforeUrl;
  if (!looksDone) {
    await captureRegisterDebug(page, job, "completion_not_confirmed");
    return fail(
      "登録ボタンを押しましたが完了画面を確認できませんでした。SalonBoard で登録状況を確認してください。",
      "UNKNOWN_ERROR",
      true,
    );
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
  ENABLE_PUSH,
  DRY_RUN,
};
export type { Job, PushBookingPayload, PushBookingResult, JobType };
