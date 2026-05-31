/**
 * 予約管理君: 予約書き込み (push_booking) テストツール
 * ============================================================
 *
 * SalonBoard 連携の「予約書き込み」が動くかを、Admin で予約を作らずに
 * その場でテストするためのスタンドアロン CLI。
 *
 *   - 日付・担当スタッフ・時刻・メニュー等を **コマンドで手入力** して指定
 *   - 認証情報は **Admin API から取得** (inspect.ts と同じく jobs を 1 件 claim →
 *     終了時に再キュー。実ジョブは実行しない)
 *   - ブラウザを **見える状態 (headful)** で起動し、ログイン → 予約スケジュール →
 *     担当スタッフ列 → 新規予約登録フォームを開く、までを実行
 *   - 既定では **登録ボタンは押さない** (確認画面まで)。本当に書き込むのは
 *     SALONBOARD_ENABLE_PUSH=true を明示したときだけ
 *   - **各ステップ・各エラー・原因をすべてターミナルに表示** する
 *     (Playwright のコンソール/ページエラー/リクエスト失敗も拾う)
 *   - 失敗時は worker が保存した debug capture (meta.json / diagnostics) を
 *     読み取って原因の要約も表示する
 *
 * 使い方:
 *   npm run test:push -- --date=2026-06-05 --staff=W001123456 --time=10:00 --menu=カット
 *
 *   主な引数 (= で値を付ける):
 *     --date=YYYY-MM-DD        予約日 (JST, 必須)
 *     --staff=W001######       SalonBoard スタッフ external_id (必須)
 *     --time=HH:MM             開始時刻 (省略時 10:00)
 *     --menu="カット"          SalonBoard 上のメニュー/クーポン名 (省略時 "カット")
 *     --duration=60            所要分 (省略時 60)
 *     --staff-name="山田 花子" 確認画面照合に使う表示名 (任意)
 *     --customer="テスト 太郎" 顧客名 (任意)
 *     --phone=09000000000      電話 (任意)
 *     --notes="..."            備考 (任意。KIREIDOT予約ID は自動付与)
 *     --headless               ブラウザを表示しない (既定は表示)
 *     --keep-open              実行後ブラウザを開いたまま (Ctrl+C で終了)
 *
 * 必要な env (.env.local):
 *   KIREIDOT_API_URL, SALONBOARD_WORKER_TOKEN  (inspect.ts と同じ)
 *   ※ 実際に書き込みたいときだけ SALONBOARD_ENABLE_PUSH=true
 *
 * ⚠️ 安全:
 *   - SALONBOARD_ENABLE_PUSH=true を付けない限り SalonBoard に予約は作られない。
 *   - claim したジョブは実行せず、終了時に retry で再キューへ戻す。
 *   - パスワード/ログインIDはコンソールに出さない。
 */

import { chromium, type Browser } from "playwright";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";

import {
  tryLogin,
  isLoggedIn,
  pushBooking,
  ENABLE_PUSH,
  type Job,
  type PushBookingPayload,
  type PushBookingResult,
} from "./worker";

// ------------------------------------------------------------
// env (.env.local / .env)。worker.ts と同じ軽量ローダ。
// import 時点で worker.ts 側も .env を読むが、念のためここでも読む。
// ------------------------------------------------------------
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

// ------------------------------------------------------------
// 簡易ログ (見やすさ重視・色は使わない)
// ------------------------------------------------------------
const T = () => new Date().toISOString().slice(11, 19);
const log = (s: string) => console.log(`[test ${T()}] ${s}`);
const sub = (s: string) => console.log(`            └ ${s}`);
const hr = () =>
  console.log(
    "------------------------------------------------------------",
  );

// ------------------------------------------------------------
// 引数パース
// ------------------------------------------------------------
function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const a of argv) {
    const m = a.match(/^--([a-zA-Z0-9-]+)(?:=(.*))?$/);
    if (!m) continue;
    out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

function fatal(msg: string): never {
  console.error(`\n[test] ✗ ${msg}\n`);
  process.exit(1);
}

function must(k: string): string {
  const v = process.env[k];
  if (!v) fatal(`env ${k} が未設定です (.env.local を確認してください)`);
  return v;
}

// ------------------------------------------------------------
// debug capture (worker が保存したもの) を読み取り、原因を要約表示
// ------------------------------------------------------------
function summarizeLatestCapture(sinceMs: number): void {
  const baseDir = join(
    homedir(),
    ".kireidot",
    "salonboard-debug",
    "push_booking",
  );
  if (!existsSync(baseDir)) {
    sub("capture ディレクトリはまだありません");
    return;
  }
  let dirs: { path: string; mtime: number }[] = [];
  try {
    dirs = readdirSync(baseDir)
      .map((name) => {
        const p = join(baseDir, name);
        try {
          return { path: p, mtime: statSync(p).mtimeMs, name };
        } catch {
          return null;
        }
      })
      .filter(
        (d): d is { path: string; mtime: number; name: string } =>
          !!d && d.mtime >= sinceMs - 2000,
      )
      .sort((a, b) => a.mtime - b.mtime);
  } catch {
    /* noop */
  }
  if (dirs.length === 0) {
    sub("この実行で新しい capture は保存されませんでした");
    return;
  }
  console.log(`\n[test] 📂 この実行で保存された debug capture (${dirs.length}件):`);
  for (const d of dirs) {
    console.log(`        • ${d.path}`);
    const metaPath = join(d.path, "meta.json");
    if (!existsSync(metaPath)) continue;
    try {
      const meta = JSON.parse(readFileSync(metaPath, "utf8")) as {
        label?: string;
        url?: string;
        title?: string;
        diagnostics?: {
          open_form?: {
            opened?: boolean;
            steps?: string[];
            setAreaCount?: number;
            setAreaClicked?: boolean;
            timeModalAppeared?: boolean;
            timeLinkFound?: boolean;
            timeLinkClicked?: boolean;
            urlChanged?: boolean;
            urlAfter?: string;
            popupOpened?: boolean;
            popupUrl?: string | null;
            formIndicatorCount?: number;
            error?: string | null;
          };
          enable_push?: boolean;
        } | null;
      };
      console.log(`          - label: ${meta.label ?? "?"}`);
      if (meta.title) console.log(`          - title: ${meta.title}`);
      if (meta.url) console.log(`          - url:   ${meta.url}`);
      const of = meta.diagnostics?.open_form;
      if (of) {
        console.log(`          - 登録フォームを開く操作の診断:`);
        console.log(
          `              opened=${of.opened} setArea(count=${of.setAreaCount}, clicked=${of.setAreaClicked})` +
            ` timeModal=${of.timeModalAppeared} timeLink(found=${of.timeLinkFound}, clicked=${of.timeLinkClicked})`,
        );
        console.log(
          `              urlChanged=${of.urlChanged} popup=${of.popupOpened}${
            of.popupUrl ? ` (${of.popupUrl})` : ""
          } formIndicators=${of.formIndicatorCount}`,
        );
        if (of.error) console.log(`              error: ${of.error}`);
        if (of.steps?.length) {
          console.log(`              steps:`);
          for (const s of of.steps) console.log(`                · ${s}`);
        }
      }
    } catch (e) {
      console.log(
        `          (meta.json 読み取り失敗: ${
          e instanceof Error ? e.message : e
        })`,
      );
    }
  }
  console.log(
    `\n        ↑ page.html / screenshot.png / elements.json / text.txt も同じフォルダにあります (機微情報マスク済)。`,
  );
}

// ------------------------------------------------------------
// PushBookingResult を分かりやすく表示
// ------------------------------------------------------------
function reportResult(result: PushBookingResult): void {
  hr();
  if (result.status === "ok") {
    log("✅ 結果: 登録成功 (status=ok)");
    sub(`already_exists=${result.alreadyExists ?? false}`);
    sub(`external_booking_id=${result.externalId ?? "(なし)"}`);
    sub(`detail_url=${result.detailUrl ?? "(なし)"}`);
    if (result.confirmed) {
      sub(`確認内容: ${JSON.stringify(result.confirmed)}`);
    }
  } else if (result.status === "confirm_only") {
    log("🟡 結果: 確認画面まで到達・照合OK (status=confirm_only)");
    sub("SALONBOARD_ENABLE_PUSH=true ではないため、登録ボタンは押していません。");
    sub("→ 実運用では Admin 側で manual_required として扱われます。");
    if (result.confirmed) {
      sub(`確認内容: ${JSON.stringify(result.confirmed)}`);
    }
  } else {
    log("🔴 結果: 失敗 (status=failed)");
    sub(`error_code     : ${result.errorCode}`);
    sub(`manual_required: ${result.manualRequired}`);
    sub(`原因(reason)   : ${result.reason}`);
    console.log(
      "\n        ── このエラーが意味すること ──",
    );
    console.log("        " + explainError(result.errorCode));
  }
  hr();
}

function explainError(code: string): string {
  switch (code) {
    case "STAFF_MAPPING_NOT_FOUND":
      return "対象スタッフがそのDOM/日付で見つかりません。--staff の external_id (W001######) が正しいか、その日にシフトがあるかを確認してください。";
    case "MENU_MAPPING_NOT_FOUND":
      return "SalonBoard 上のメニュー/クーポン名が見つかりません。--menu を実際の表示名と完全一致させてください。";
    case "SLOT_NOT_AVAILABLE":
      return "対象時間帯が空いていません。別の --time / --date を試してください。";
    case "ALREADY_EXISTS":
      return "対象時間帯に既存予約の可能性があります (二重登録防止のため自動停止)。スケジュールを確認してください。";
    case "CONFIRMATION_MISMATCH":
      return "登録フォーム/確認画面のセレクタが未確定、または確認内容が予約内容と一致しません。下の capture(register_form_opened) の DOM で REGISTER_FORM を確定する必要があります。";
    case "RECAPTCHA_REQUIRED":
      return "reCAPTCHA が表示されました。自動突破はしません。手動でログイン後にやり直してください。";
    case "LOGIN_FAILED":
      return "ログインに失敗しました。Admin 側の認証情報を確認してください。";
    case "PUSH_DISABLED":
      return "push が無効化されています (DRY_RUN など)。";
    default:
      return "想定外のエラーです。上の reason と capture を確認してください。";
  }
}

// ------------------------------------------------------------
// メイン
// ------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));

  hr();
  log("予約書き込み (push_booking) テストツール");
  hr();

  // --- 入力チェック ---
  const date = typeof args.date === "string" ? args.date : "";
  const staff = typeof args.staff === "string" ? args.staff : "";
  const time = typeof args.time === "string" ? args.time : "10:00";
  const menu = typeof args.menu === "string" ? args.menu : "カット";
  const duration = typeof args.duration === "string" ? Number(args.duration) : 60;
  const staffName =
    typeof args["staff-name"] === "string" ? (args["staff-name"] as string) : null;
  const customer =
    typeof args.customer === "string" ? (args.customer as string) : null;
  const phone = typeof args.phone === "string" ? (args.phone as string) : null;
  const notes = typeof args.notes === "string" ? (args.notes as string) : null;
  const headless = args.headless === true;
  const keepOpen = args["keep-open"] === true;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    fatal("--date=YYYY-MM-DD が必要です (例: --date=2026-06-05)");
  }
  if (!/^W\d{3}\d+$/i.test(staff) && !staff) {
    fatal("--staff=W001###### (SalonBoard スタッフ external_id) が必要です");
  }
  if (!staff) {
    fatal("--staff が必要です");
  }
  if (!/^\d{1,2}:\d{2}$/.test(time)) {
    fatal("--time は HH:MM 形式 (例: --time=10:00)");
  }

  // JST の ISO 文字列を作る (+09:00)。
  const scheduledAt = `${date}T${time.padStart(5, "0")}:00+09:00`;

  log("入力内容:");
  sub(`日付         : ${date}`);
  sub(`時刻         : ${time}  (scheduled_at=${scheduledAt})`);
  sub(`スタッフ     : external_id=${staff}${staffName ? ` 表示名=${staffName}` : ""}`);
  sub(`メニュー     : ${menu}`);
  sub(`所要分       : ${duration}`);
  sub(`顧客         : ${customer ?? "(なし)"}`);
  sub(`ブラウザ表示 : ${headless ? "なし (headless)" : "あり (headful)"}`);
  log(
    `安全モード   : SALONBOARD_ENABLE_PUSH=${
      ENABLE_PUSH ? "ON ⚠️ 登録ボタンを押します" : "OFF (確認画面まで・登録しません)"
    }`,
  );
  if (ENABLE_PUSH) {
    log("⚠️ ENABLE_PUSH=true: 確認画面の照合に成功すると SalonBoard に実際に予約が作成されます。");
  }

  // --- 認証情報を Admin API から claim ---
  const API = must("KIREIDOT_API_URL");
  const TOKEN = must("SALONBOARD_WORKER_TOKEN");

  hr();
  log(`Admin API からジョブを 1 件 claim して認証情報を取得します: ${API}`);
  sub("(取得したジョブは実行せず、終了時に retry で再キューへ戻します)");

  let jobsRes: Response;
  try {
    jobsRes = await fetch(`${API}/api/salonboard/jobs?limit=1`, {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "X-Worker-Id": "test-push-booking",
      },
    });
  } catch (e) {
    fatal(
      `Admin API に接続できません (${API}): ${
        e instanceof Error ? e.message : e
      }\n  → KIREIDOT_API_URL が正しいか、Admin (Next.js) が起動しているか確認してください。`,
    );
  }
  if (!jobsRes.ok) {
    fatal(
      `jobs fetch 失敗 ${jobsRes.status}: ${await jobsRes.text().catch(() => "")}`,
    );
  }
  const { jobs } = (await jobsRes.json()) as {
    jobs: Array<{
      id: string;
      shop_id: string;
      organization_id: string;
      credentials: {
        login_id: string;
        password: string;
        base_url: string | null;
      };
    }>;
  };
  if (!jobs || jobs.length === 0) {
    fatal(
      "queued ジョブがありません。Admin 画面で「今すぐ同期」などジョブを 1 件投入してから再実行してください " +
        "(このツールは認証情報を借りるためだけにジョブを claim します)。",
    );
  }
  const claimed = jobs[0];
  const shopId = claimed.shop_id;
  const orgId = claimed.organization_id;
  const baseUrl = claimed.credentials.base_url ?? "https://salonboard.com/";
  log(`認証情報を取得しました (shop=${shopId.slice(0, 8)}, base_url=${baseUrl})`);
  sub(`login_id=${claimed.credentials.login_id} / password=*** (非表示)`);

  // claim したジョブを後で再キューへ戻す。
  let returned = false;
  const returnJob = async () => {
    if (returned) return;
    returned = true;
    try {
      await fetch(`${API}/api/salonboard/callback`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "X-Worker-Id": "test-push-booking",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          job_id: claimed.id,
          status: "retry",
          error: "test-push-booking session (no-op); re-queued",
        }),
      });
      log("借りたジョブをキューへ戻しました");
    } catch (e) {
      console.error(
        `[test] ジョブ返却に失敗: ${e instanceof Error ? e.message : e}`,
      );
    }
  };

  // --- テスト用の合成 Job / payload を組み立てる ---
  const bookingId = `test-${date.replace(/-/g, "")}-${time.replace(":", "")}`;
  const payload: PushBookingPayload = {
    booking_id: bookingId,
    action: "create",
    customer_name: customer,
    customer_phone: phone,
    salonboard_staff_external_id: staff,
    staff_name: staffName,
    salonboard_menu_name: menu,
    menu_name: menu,
    scheduled_at: scheduledAt,
    duration_min: duration,
    notes,
    kireidot_ref: `KIREIDOT予約ID: ${bookingId}`,
  };
  const job: Job = {
    id: `00000000-test-${Date.now().toString(16)}`.slice(0, 36),
    shop_id: shopId,
    organization_id: orgId,
    job_type: "push_booking",
    payload: payload as unknown as Record<string, unknown>,
    attempts: 0,
    max_attempts: 1,
    credentials: claimed.credentials,
  };

  // --- ブラウザ起動 (headful) ---
  hr();
  log(`Chromium を起動します (${headless ? "headless" : "headful"})`);
  const startMs = Date.now();
  let browser: Browser | null = null;
  let result: PushBookingResult | null = null;
  let threw: unknown = null;

  try {
    browser = await chromium.launch({ headless });
    const ctx = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      locale: "ja-JP",
      timezoneId: "Asia/Tokyo",
      viewport: { width: 1366, height: 900 },
    });
    const page = await ctx.newPage();

    // --- ブラウザ側のあらゆる情報を拾って表示 (原因究明用) ---
    page.on("console", (msg) => {
      const t = msg.type();
      if (t === "error" || t === "warning") {
        console.log(`            [browser:${t}] ${msg.text()}`);
      }
    });
    page.on("pageerror", (err) => {
      console.log(`            [browser:pageerror] ${err.message}`);
    });
    page.on("requestfailed", (req) => {
      const f = req.failure();
      console.log(
        `            [browser:requestfailed] ${req.method()} ${req.url()} :: ${
          f?.errorText ?? "?"
        }`,
      );
    });
    page.on("dialog", async (d) => {
      console.log(
        `            [browser:dialog] ${d.type()} "${d.message()}" → dismiss`,
      );
      await d.dismiss().catch(() => {});
    });

    // --- ログイン ---
    hr();
    log("STEP 1: ログイン状態を確認");
    let auth = await isLoggedIn(page, baseUrl);
    log(`  → isLoggedIn = ${auth}`);
    if (auth === "captcha") {
      fatal(
        "ログイン前に reCAPTCHA が出ました。自動突破はしません。時間をおいて再実行してください。",
      );
    }
    if (auth !== "logged_in") {
      log("STEP 1b: ログインを実行");
      const loginUrl = new URL("/login/", baseUrl).toString();
      const lr = await tryLogin(page, loginUrl, {
        loginId: claimed.credentials.login_id,
        password: claimed.credentials.password,
      });
      log(`  → tryLogin = ${lr.status}${"reason" in lr && lr.reason ? ` (${lr.reason})` : ""}`);
      if (lr.status === "captcha") {
        fatal("ログイン中に reCAPTCHA が出ました。自動突破はしません。");
      }
      if (lr.status === "failed") {
        fatal(`ログイン失敗: ${lr.reason ?? "unknown"}`);
      }
      auth = "logged_in";
    }
    log("✅ ログイン成功");

    // --- push_booking 本体を実行 (内部で各 STEP の capture/診断を保存) ---
    hr();
    log("STEP 2: push_booking フローを実行");
    sub("スケジュール → スタッフ列特定 → 重複チェック → 登録フォームを開く → 確認画面照合");
    sub("(失敗箇所の DOM は ~/.kireidot/salonboard-debug/push_booking/ に capture されます)");

    result = await pushBooking(page, job, payload);

    // --- 結果表示 ---
    reportResult(result);

    // --- この実行で保存された capture を要約 ---
    summarizeLatestCapture(startMs);

    if (keepOpen && !headless) {
      hr();
      log("--keep-open: ブラウザを開いたままにします。DevTools で DOM を確認できます。");
      log("終了するには、このターミナルで Ctrl+C を押してください。");
      await new Promise<void>((res) => {
        const onSig = async () => {
          await returnJob();
          await browser?.close().catch(() => {});
          res();
        };
        process.on("SIGINT", onSig);
        process.on("SIGTERM", onSig);
      });
      return;
    }
  } catch (e) {
    threw = e;
    console.error("\n[test] 🔴 実行中に例外が発生しました:");
    console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    // 例外時も capture が残っていれば見せる
    summarizeLatestCapture(startMs);
  } finally {
    if (browser && !(keepOpen && !headless)) {
      await browser.close().catch(() => {});
    }
    await returnJob();
  }

  // --- 最終サマリ ---
  hr();
  if (threw) {
    log("テスト終了: 例外あり (上のスタックトレースを確認してください)");
    process.exitCode = 1;
  } else if (result?.status === "ok") {
    log("テスト終了: 予約書き込み 成功 ✅");
  } else if (result?.status === "confirm_only") {
    log("テスト終了: 確認画面まで到達 🟡 (登録は未実行 / ENABLE_PUSH=OFF)");
  } else {
    log("テスト終了: 失敗 🔴 (上の error_code / reason / capture を確認してください)");
    process.exitCode = 1;
  }
  hr();
}

main().catch((e) => {
  console.error("\n[test] 🔴 fatal:", e instanceof Error ? (e.stack ?? e.message) : e);
  process.exit(1);
});
