/**
 * Akamai カナリア (Phase 0 / 設計 §11 Go/No-Go ゲート)
 * ============================================================
 *
 * AWS (Fargate) の egress IP + headless Chromium で SalonBoard に
 * 「ログイン → スケジュール画面閲覧」だけを定期実行し、Akamai/bot 検知の
 * 発生率を計測する読み取り専用ループ。
 *
 * ⚠️ Admin API・ジョブキューには一切触れない (本番運用への影響ゼロ)。
 *    認証情報はテスト用 1 店舗のものを env (SSM SecureString 経由) で受け取る。
 *
 * 必要な env:
 *   SALONBOARD_LOGIN_ID / SALONBOARD_PASSWORD   テスト店舗の認証情報 (必須)
 *   SALONBOARD_BASE_URL                          省略時 https://salonboard.com/
 *   CANARY_INTERVAL_MS                           省略時 300000 (5分)
 *   CANARY_SHOP_LABEL                            メトリクスのラベル (省略時 "canary")
 *
 * 出力 (CloudWatch Logs):
 *   - [canary] 行: 人間用ログ
 *   - EMF (Embedded Metric Format) JSON: CloudWatch メトリクスに自動変換される
 *     Namespace=KireidotSalonboardWorker
 *     Metrics: LoginSuccess / FreshLogin / CaptchaDetected / Blocked / DurationMs
 *
 * 計測観点 (docs/aws-migration.md):
 *   ログイン成功率 / captcha・blocked 率 / storageState 寿命 (FreshLogin 頻度)
 */

import { chromium, type Browser } from "playwright";

import {
  tryLogin,
  isLoggedIn,
  storageStatePathFor,
  readStorageState,
  saveStorageState,
  SB_CONTEXT_OPTIONS,
} from "./worker";
import { SB_PATHS } from "./salonboard-selectors";

const must = (k: string): string => {
  const v = process.env[k];
  if (!v) {
    console.error(`[canary] FATAL: env ${k} が必要です`);
    process.exit(1);
  }
  return v;
};

const LOGIN_ID = must("SALONBOARD_LOGIN_ID");
const PASSWORD = must("SALONBOARD_PASSWORD");
const BASE_URL = process.env.SALONBOARD_BASE_URL ?? "https://salonboard.com/";
const INTERVAL_MS = Number(process.env.CANARY_INTERVAL_MS ?? 300_000);
const LABEL = process.env.CANARY_SHOP_LABEL ?? "canary";
const WORKER_ID = process.env.WORKER_ID ?? "canary-local";

const T = () => new Date().toISOString();
const log = (s: string) => console.log(`[canary ${T()}] ${s}`);

type RunResult = {
  loginSuccess: boolean;
  freshLogin: boolean;
  captcha: boolean;
  blocked: boolean;
  scheduleOk: boolean;
  durationMs: number;
  detail: string;
};

/** EMF 形式で stdout に出す → awslogs 経由で CloudWatch メトリクスに自動変換。 */
function emitMetrics(r: RunResult): void {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: "KireidotSalonboardWorker",
            Dimensions: [["Shop"]],
            Metrics: [
              { Name: "LoginSuccess" },
              { Name: "FreshLogin" },
              { Name: "CaptchaDetected" },
              { Name: "Blocked" },
              { Name: "ScheduleOk" },
              { Name: "DurationMs", Unit: "Milliseconds" },
            ],
          },
        ],
      },
      Shop: LABEL,
      Worker: WORKER_ID,
      LoginSuccess: r.loginSuccess ? 1 : 0,
      FreshLogin: r.freshLogin ? 1 : 0,
      CaptchaDetected: r.captcha ? 1 : 0,
      Blocked: r.blocked ? 1 : 0,
      ScheduleOk: r.scheduleOk ? 1 : 0,
      DurationMs: r.durationMs,
      Detail: r.detail,
    }),
  );
}

async function runOnce(): Promise<RunResult> {
  const started = Date.now();
  const r: RunResult = {
    loginSuccess: false,
    freshLogin: false,
    captcha: false,
    blocked: false,
    scheduleOk: false,
    durationMs: 0,
    detail: "",
  };

  let browser: Browser | null = null;
  try {
    // SB_BROWSER_CHANNEL=chrome で本物の Google Chrome を使う (Chromium ではなく)。
    // SB_HEADLESS=0 でヘッドフル (entrypoint が xvfb-run で仮想ディスプレイを用意)。
    const channel = process.env.SB_BROWSER_CHANNEL || undefined;
    const headless = process.env.SB_HEADLESS !== "0";
    // SB_PROXY_SERVER=http://host:port を指定すると、住宅系プロキシ経由でアクセスする
    // (Akamai に見える egress IP をプロキシの出口 IP にする = IP 起因かの切り分け)。
    // Playwright の proxy.server はスキーム必須。host:port だけなら http:// を補う
    // (Decodo の jp.decodo.com:30001 のような指定をそのまま受け付けるため)。
    const rawProxy = process.env.SB_PROXY_SERVER;
    const proxy = rawProxy
      ? {
          server: /:\/\//.test(rawProxy) ? rawProxy : `http://${rawProxy}`,
          username: process.env.SB_PROXY_USERNAME || undefined,
          password: process.env.SB_PROXY_PASSWORD || undefined,
        }
      : undefined;
    if (proxy) r.detail += `proxy=${proxy.server}; `;
    browser = await chromium.launch({ headless, channel, proxy });
    const ssPath = storageStatePathFor(`canary-${LABEL}`);
    // 本物の Chrome を使うときは UA を偽装しない (Linux実Chromeに Mac UA を被せると
    // Sec-CH-UA-Platform と矛盾し、かえって検知シグナルになる)。
    const ctx = await browser.newContext({
      ...(channel ? { locale: "ja-JP", timezoneId: "Asia/Tokyo" } : SB_CONTEXT_OPTIONS),
      storageState: readStorageState(ssPath),
    });

    // 帯域節約 (従量プロキシの 1GB を守る): 画像・メディア・フォントを遮断する。
    // Akamai の bot 判定 JS / CSS / XHR は通すので合否判定には影響しない。
    if (process.env.CANARY_BLOCK_ASSETS !== "0") {
      await ctx.route("**/*", (route) => {
        const type = route.request().resourceType();
        if (type === "image" || type === "media" || type === "font") {
          return route.abort();
        }
        return route.continue();
      });
    }

    const page = await ctx.newPage();

    // HTTP レベルの block (403/429) を観測する
    page.on("response", (res) => {
      if ([403, 429].includes(res.status()) && res.url().includes("salonboard")) {
        r.blocked = true;
        r.detail += `http_${res.status()} ${res.url().slice(0, 120)}; `;
      }
    });

    // 高速プローブ (CANARY_PROBE_MS, 既定12秒): ログインページに 1 回だけ短時間で
    // アクセスし、応答が来ない (Akamai tarpit) なら即 blocked を返す。
    // 本番フロー (isLoggedIn→tryLogin) は失敗時に 30s×複数で ~90s かかるため、
    // 「弾かれた」の判定をここで早期に確定させて実験サイクルを短縮する。
    const probeMs = Number(process.env.CANARY_PROBE_MS ?? 12_000);
    try {
      const t0 = Date.now();
      await page.goto(new URL("/login/", BASE_URL).toString(), {
        waitUntil: "domcontentloaded",
        timeout: probeMs,
      });
      r.detail += `probe_ok ${Date.now() - t0}ms; `;
    } catch {
      r.blocked = true;
      r.detail += `probe_timeout ${probeMs}ms (Akamai tarpit suspected); `;
      return r;
    }

    let state = await isLoggedIn(page, BASE_URL);
    if (state === "captcha") {
      r.captcha = true;
      r.detail += "captcha_on_landing; ";
      return r;
    }
    if (state !== "logged_in") {
      r.freshLogin = true;
      const loginUrl = new URL("/login/", BASE_URL).toString();
      const lr = await tryLogin(page, loginUrl, {
        loginId: LOGIN_ID,
        password: PASSWORD,
      });
      if (lr.status === "captcha") {
        r.captcha = true;
        r.detail += "captcha_on_login; ";
        return r;
      }
      if (lr.status !== "ok") {
        r.detail += `login_failed: ${"reason" in lr ? lr.reason : "?"}; `;
        return r;
      }
      await saveStorageState(ctx, ssPath);
    }
    r.loginSuccess = true;

    // 読み取り 1 ページ: 当日の予約スケジュール (fetch 相当の負荷を再現)
    const today = new Date(Date.now() + 9 * 3600_000); // JST
    const yyyymmdd = today.toISOString().slice(0, 10).replace(/-/g, "");
    const schedUrl = new URL(SB_PATHS.schedule, BASE_URL);
    schedUrl.searchParams.set("date", yyyymmdd);
    await page.goto(schedUrl.toString(), {
      waitUntil: "domcontentloaded",
      timeout: 25_000,
    });
    const title = await page.title().catch(() => "");
    r.scheduleOk = !r.blocked && !(await page.url()).includes("/login");
    r.detail += `schedule_title=${title.slice(0, 40)}; `;
  } catch (e) {
    r.detail += `error: ${e instanceof Error ? e.message.slice(0, 200) : e}; `;
  } finally {
    r.durationMs = Date.now() - started;
    await browser?.close().catch(() => {});
  }
  return r;
}

let stopping = false;
process.on("SIGTERM", () => {
  stopping = true;
  log("SIGTERM: 現在の試行完了後に終了します");
});
process.on("SIGINT", () => {
  stopping = true;
});

async function main() {
  log(
    `start label=${LABEL} base=${BASE_URL} interval=${INTERVAL_MS}ms worker=${WORKER_ID} ` +
      `channel=${process.env.SB_BROWSER_CHANNEL || "chromium"} headless=${process.env.SB_HEADLESS !== "0"}`,
  );
  while (!stopping) {
    const r = await runOnce();
    log(
      `login=${r.loginSuccess} fresh=${r.freshLogin} captcha=${r.captcha} ` +
        `blocked=${r.blocked} schedule=${r.scheduleOk} ${r.durationMs}ms ${r.detail}`,
    );
    emitMetrics(r);
    if (stopping || process.env.CANARY_ONCE === "1") break;
    await new Promise((res) => setTimeout(res, INTERVAL_MS));
  }
  log("bye");
}

main().catch((e) => {
  console.error("[canary] fatal:", e);
  process.exit(1);
});
