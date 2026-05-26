// =====================================================================
// 予約同期くん: Electron utilityProcess として動くマルチショップ・スクレイパー
//
// 設計:
//   - main.cjs から utilityProcess.fork で起動される
//   - parent (main.cjs) から start/stop/sync メッセージを受け取る
//   - Supabase Auth セッション (access_token / refresh_token) を渡してもらい、
//     super_owner / admin として salonboard_reveal_credentials を呼ぶ
//   - Playwright Chromium で店舗ごとにログイン → 各チャネルをスクレイピング
//   - 結果は salonboard_bulk_upsert_bookings / staff / shifts / blogs RPC で保存
//   - 進捗イベントは postMessage で parent に送る
//
// スクレイピング本体 (4 URL の DOM パース) は Phase 3 で実装する。
// 本ファイルでは「マルチ店舗のループ・ログイン・進捗通知」の枠組みを用意。
// =====================================================================

const { createClient } = require('@supabase/supabase-js');
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
// Electron utilityProcess は Node 20 で動作するが、組み込み WebSocket が無いため
// Supabase の createClient が RealtimeClient を生成する際に
// "Node.js 20 detected without native WebSocket support" 例外を投げる。
// Worker は postgres RPC しか使わないが、internal の RealtimeClient は必ず作られる
// ので、ws パッケージを transport として注入して例外を回避する。
const WebSocket = require('ws');
const {
  scrapeBookings,
  scrapeStaff,
  scrapeBlogs,
  scrapeShifts,
  scrapeCustomerDetails,
} = require('./scrapers.cjs');

let supabase = null;
let initReady = false;
let initPromise = null;
let running = false;
let abortRequested = false;
let currentBrowser = null;

function emit(type, payload) {
  try {
    process.parentPort?.postMessage({ type, payload });
  } catch (_e) {
    /* parent が居ない場合は無視 */
  }
}

function log(msg, level = 'info') {
  emit('log', { level, msg, at: new Date().toISOString() });
  // 開発時の確認用に stdout にも出しておく
  console.log(`[worker:${level}] ${msg}`);
}

async function initSupabase({ url, anonKey, accessToken, refreshToken }) {
  if (!url || !anonKey) {
    throw new Error('Supabase URL / anon key が空です。.env.local の VITE_SUPABASE_URL を確認してください');
  }
  if (!accessToken || !refreshToken) {
    throw new Error('Supabase セッショントークンが空です。再ログインしてください');
  }
  supabase = createClient(url, anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
    // ws パッケージを RealtimeClient の transport として注入。
    // これで Node 20 環境でも Supabase の初期化が通る。
    realtime: { transport: WebSocket },
  });
  // 親プロセス (renderer/main) で取得したセッションをそのまま注入する。
  // これで RLS が super_owner / admin として評価される。
  await supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
  initReady = true;
}

/** Supabase client が確実に使える状態になるまで待つ */
async function ensureReady() {
  if (initReady && supabase) return;
  if (initPromise) {
    // init 中なら待つ
    await initPromise;
    return;
  }
  throw new Error('Supabase client がまだ初期化されていません。アプリを再起動してください。');
}

/**
 * 同期対象の店舗一覧を取得 (enabled かつ未ブロック)。
 *  - shopIds が指定されている場合はその店舗だけ
 */
async function fetchTargets(shopIds) {
  let q = supabase
    .from('salonboard_credentials_overview')
    .select('organization_id, organization_name, shop_id, shop_name, has_credential, enabled, blocked_until');
  q = q.eq('has_credential', true);
  if (Array.isArray(shopIds) && shopIds.length > 0) {
    q = q.in('shop_id', shopIds);
  }
  const { data, error } = await q;
  if (error) throw new Error(`fetchTargets: ${error.message}`);
  const now = Date.now();
  return (data ?? []).filter((r) => {
    if (!r.enabled) return false;
    if (r.blocked_until && new Date(r.blocked_until).getTime() > now) return false;
    return true;
  });
}

async function revealCredentials(shopId) {
  const { data, error } = await supabase.rpc('salonboard_reveal_credentials', {
    p_shop_id: shopId,
  });
  if (error) throw new Error(`reveal: ${error.message}`);
  const row = (data ?? [])[0];
  if (!row) throw new Error('credentials not found');
  // base_url の正規化: 末尾スラッシュのみだったり login パスが抜けていると
  // 「https://salonboard.com/」 にアクセスしてしまって遅延・タイムアウトになる。
  // 既定値 = ログイン画面 URL に揃える。
  let baseUrl = (row.base_url ?? '').trim();
  if (!baseUrl || baseUrl === 'https://salonboard.com' || baseUrl === 'https://salonboard.com/') {
    baseUrl = 'https://salonboard.com/login/';
  }
  // 「/」だけで終わる場合に /login/ を補う
  if (/^https?:\/\/[^/]+\/?$/i.test(baseUrl)) {
    baseUrl = baseUrl.replace(/\/?$/, '/') + 'login/';
  }
  return {
    loginId: row.login_id,
    password: row.password,
    baseUrl,
  };
}

/**
 * 1 店舗ぶんの同期処理 (Phase 2 ではログインまでで return)。
 * Phase 3 で予約一覧/予約管理/スタッフ/ブログのスクレイピングを足す。
 */
async function processShop(target, channels, runId, opts = {}) {
  const { shop_id: shopId, shop_name: shopName, organization_name: orgName } = target;
  const showBrowser = !!opts.showBrowser;
  emit('shop:start', { shopId, shopName, orgName, channels });
  const counts = { bookings: 0, staff: 0, blogs: 0, customers: 0 };

  let creds;
  try {
    creds = await revealCredentials(shopId);
  } catch (e) {
    emit('shop:end', { shopId, ok: false, error: `credentials: ${e.message}` });
    await recordShopRun(runId, shopId, false, null, `credentials: ${e.message}`, counts);
    return { ok: false };
  }

  // showBrowser=true のときは headful (ブラウザ画面を表示)、slowMo で動きを見やすく。
  // Akamai / リクルート系の bot 検知を回避するため、自動化検知シグナルを抑える
  // フラグを追加: --disable-blink-features=AutomationControlled
  const browser = await chromium.launch({
    headless: !showBrowser,
    slowMo: showBrowser ? 250 : 0,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-features=IsolateOrigins,site-per-process',
    ],
  });
  currentBrowser = browser;
  // shop_id ごとの storageState (ログインセッション) を流用
  const ssPath = storageStatePathFor(shopId);
  const initialStorage = readStorageStatePath(ssPath);
  try {
    const ctx = await browser.newContext({
      ...(initialStorage ? { storageState: initialStorage } : {}),
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
      locale: 'ja-JP',
      timezoneId: 'Asia/Tokyo',
      viewport: { width: 1366, height: 900 },
      extraHTTPHeaders: {
        'Accept-Language': 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept':
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Ch-Ua': '"Google Chrome";v="127", "Chromium";v="127", "Not?A_Brand";v="24"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"macOS"',
      },
    });

    // navigator.webdriver = false に偽装 (stealth の最小実装)
    await ctx.addInitScript(() => {
      // @ts-ignore
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      // @ts-ignore
      Object.defineProperty(navigator, 'languages', { get: () => ['ja-JP', 'ja', 'en-US', 'en'] });
      // @ts-ignore
      Object.defineProperty(navigator, 'plugins', {
        get: () => [
          { name: 'PDF Viewer', filename: 'internal-pdf-viewer' },
          { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer' },
        ],
      });
      // window.chrome をでっちあげる (headless Chromium には無いことが多い)
      // @ts-ignore
      window.chrome = window.chrome ?? { runtime: {} };
    });

    const page = await ctx.newPage();
    // showBrowser=true のとき、Playwright Chromium はバックグラウンドで開くことがあるので、
    // 明示的に前面に持ってくる (macOS で Electron アプリの下に隠れるのを防ぐ)。
    if (showBrowser) {
      try {
        await page.bringToFront();
      } catch (_e) {
        /* 古い Playwright 版だとメソッドが無い場合あり。無視。 */
      }
    }

    emit('shop:progress', { shopId, step: 'login', msg: `${creds.baseUrl} に接続中` });

    // 1) 既存セッションが有効なら tryLogin を完全にスキップ (bot 検知/reCAPTCHA 回避)
    let needsLogin = true;
    if (initialStorage) {
      try {
        const sessionState = await isLoggedIn(page, creds.baseUrl);
        if (sessionState === 'logged_in') {
          needsLogin = false;
          emit('shop:progress', {
            shopId,
            step: 'login',
            msg: '既存セッションで継続 (ログインスキップ)',
          });
        } else if (sessionState === 'captcha') {
          // captcha 検知 → セッションも怪しいので破棄し、ブロック扱い
          clearStorageState(ssPath);
          const blockedUntil = new Date(Date.now() + 6 * 3600_000).toISOString();
          await markCredentialError(shopId, 'captcha_detected', blockedUntil);
          emit('shop:end', {
            shopId,
            ok: false,
            error: 'reCAPTCHA を検知しました (6 時間ブロック)',
          });
          await recordShopRun(runId, shopId, false, null, 'captcha_detected', counts);
          return { ok: false };
        } else if (sessionState === 'needs_login') {
          // セッション切れ → 通常ログインに進む
          clearStorageState(ssPath);
        }
      } catch (_e) {
        // 判定処理自体が転んだら通常ログインにフォールバック
      }
    }

    // 2) 必要なときだけログイン
    if (needsLogin) {
      const r = await tryLogin(page, creds);
      if (r.status === 'captcha') {
        clearStorageState(ssPath);
        const blockedUntil = new Date(Date.now() + 6 * 3600_000).toISOString();
        await markCredentialError(shopId, 'captcha_detected', blockedUntil);
        emit('shop:end', { shopId, ok: false, error: 'reCAPTCHA を検知しました (6 時間ブロック)' });
        await recordShopRun(runId, shopId, false, null, 'captcha_detected', counts);
        return { ok: false };
      }
      if (r.status === 'failed') {
        clearStorageState(ssPath);
        await markCredentialError(shopId, r.reason ?? 'login_failed', null);
        emit('shop:end', { shopId, ok: false, error: r.reason ?? 'ログイン失敗' });
        await recordShopRun(runId, shopId, false, null, r.reason ?? 'login_failed', counts);
        return { ok: false };
      }
      emit('shop:progress', { shopId, step: 'login', msg: 'ログイン成功' });
      // 成功 → storageState を保存
      await saveStorageState(ctx, ssPath);
    }

    // ---- スクレイピング本体 (channels で選択された分だけ) ----
    const channelSet = new Set(channels);
    const summary = [];

    if (channelSet.has('bookings')) {
      try {
        emit('shop:progress', { shopId, step: 'bookings', msg: '予約一覧を取得中…' });
        const { rows, debug } = await scrapeBookings(page);
        const sent = await sendBookings(shopId, rows);
        counts.bookings = sent;
        const skipNote =
          debug.skipped > 0 && debug.sampleSkipped?.length
            ? ` skip例:[${debug.sampleSkipped.slice(0, 2).join('|').slice(0, 200)}]`
            : '';
        const rangeNote = debug.range ? ` 範囲:${debug.range}` : '';
        summary.push(
          `予約 ${sent}/${rows.length}件 (検出${debug.itemsFound}${rangeNote}${skipNote})`,
        );
        if (debug.diag?.length) {
          emit('log', {
            level: 'info',
            msg: `[${shopId.slice(0, 8)}] booking diag: ${debug.diag.join(' | ')}`,
            at: new Date().toISOString(),
          });
        }
        emit('shop:progress', { shopId, step: 'bookings', msg: `予約 ${sent} 件保存` });
      } catch (e) {
        emit('log', {
          level: 'warn',
          msg: `[${shopId.slice(0, 8)}] bookings scrape error: ${e instanceof Error ? e.message : e}`,
          at: new Date().toISOString(),
        });
      }
    }

    if (channelSet.has('staff')) {
      try {
        emit('shop:progress', { shopId, step: 'staff', msg: 'スタッフ一覧を取得中…' });
        const { rows } = await scrapeStaff(page);
        const sent = await sendStaff(shopId, rows);
        counts.staff = sent;
        summary.push(`スタッフ ${sent} 件`);
        emit('shop:progress', { shopId, step: 'staff', msg: `スタッフ ${sent} 件保存` });
      } catch (e) {
        emit('log', {
          level: 'warn',
          msg: `[${shopId.slice(0, 8)}] staff scrape error: ${e instanceof Error ? e.message : e}`,
          at: new Date().toISOString(),
        });
      }
    }

    if (channelSet.has('blog')) {
      try {
        emit('shop:progress', { shopId, step: 'blog', msg: 'ブログを取得中…' });
        const { rows, debug } = await scrapeBlogs(page);
        const sent = await sendBlogs(shopId, rows);
        counts.blogs = sent;
        const detailNote = debug
          ? ` 本文取得 ${debug.detailHit ?? 0}/${debug.detailAttempted ?? 0}`
          : '';
        summary.push(`ブログ ${sent} 件${detailNote}`);
        emit('shop:progress', {
          shopId,
          step: 'blog',
          msg: `ブログ ${sent} 件保存${detailNote}`,
        });
      } catch (e) {
        emit('log', {
          level: 'warn',
          msg: `[${shopId.slice(0, 8)}] blog scrape error: ${e instanceof Error ? e.message : e}`,
          at: new Date().toISOString(),
        });
      }
    }

    if (channelSet.has('customers')) {
      try {
        emit('shop:progress', { shopId, step: 'customers', msg: '顧客詳細を取得中…' });
        const { rows } = await scrapeCustomerDetails(page, { maxCustomers: 50 });
        const sent = await sendCustomerDetails(shopId, rows);
        counts.customers = sent;
        summary.push(`顧客 ${sent} 件マージ`);
        emit('shop:progress', { shopId, step: 'customers', msg: `顧客 ${sent} 件保存` });
      } catch (e) {
        emit('log', {
          level: 'warn',
          msg: `[${shopId.slice(0, 8)}] customer detail scrape error: ${e instanceof Error ? e.message : e}`,
          at: new Date().toISOString(),
        });
      }
    }

    if (channelSet.has('shifts')) {
      try {
        emit('shop:progress', { shopId, step: 'shifts', msg: 'シフトを取得中…' });
        const { rows, debug } = await scrapeShifts(page);
        const sent = await sendShifts(shopId, rows);
        counts.shifts = sent;
        summary.push(`シフト ${sent} 件 (検出${debug.itemsFound})`);
        emit('shop:progress', { shopId, step: 'shifts', msg: `シフト ${sent} 件保存` });
      } catch (e) {
        emit('log', {
          level: 'warn',
          msg: `[${shopId.slice(0, 8)}] shifts scrape error: ${e instanceof Error ? e.message : e}`,
          at: new Date().toISOString(),
        });
      }
    }

    await markCredentialSuccess(shopId);
    const summaryStr = summary.length > 0 ? summary.join(' / ') : 'login ok';
    emit('shop:end', { shopId, ok: true, summary: summaryStr });
    await recordShopRun(runId, shopId, true, summaryStr, null, counts);
    return { ok: true };
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    await markCredentialError(shopId, errMsg, null);
    emit('shop:end', { shopId, ok: false, error: errMsg });
    await recordShopRun(runId, shopId, false, null, errMsg, counts);
    return { ok: false };
  } finally {
    await browser.close().catch(() => {});
    currentBrowser = null;
  }
}

/** salonboard_run_record_shop RPC を呼び、店舗単位の結果を Supabase に保存 */
async function recordShopRun(runId, shopId, ok, summary, error, counts) {
  if (!runId) return;
  try {
    await supabase.rpc('salonboard_run_record_shop', {
      p_run_id: runId,
      p_shop_id: shopId,
      p_ok: ok,
      p_summary: summary,
      p_error: error,
      p_bookings_count: counts?.bookings ?? 0,
      p_staff_count: counts?.staff ?? 0,
      p_blogs_count: counts?.blogs ?? 0,
      p_customers_count: counts?.customers ?? 0,
    });
  } catch (_e) {
    /* 履歴記録失敗は致命的でないので無視 */
  }
}

// ---------------------------------------------------------------------------
// storageState (shop_id ごとのログインセッション)
//
// SalonBoard へ毎回ログインすると bot 検知/reCAPTCHA リスクが上がるので、
// shop_id 単位で Playwright の storageState (cookies + localStorage) をローカル PC に
// 保存しておく。
//
// 保存先: ~/.kireidot/salonboard-auth/{shop_id}.json
//
// 重要:
//   - サーバには絶対送らない
//   - ファイル単体で SalonBoard にログインできるため 0600 で保存
//   - reCAPTCHA / login 失敗のときは破棄して次回ログインからやり直す
// ---------------------------------------------------------------------------
function storageStatePathFor(shopId) {
  const dir = path.join(os.homedir(), '.kireidot', 'salonboard-auth');
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    } else {
      try {
        const st = fs.statSync(dir);
        if ((st.mode & 0o777) !== 0o700) fs.chmodSync(dir, 0o700);
      } catch (_e) {
        /* ignore */
      }
    }
  } catch (_e) {
    /* CI / sandbox 等で作成不可なら storageState なしで動かす */
  }
  return path.join(dir, `${shopId}.json`);
}

/** ファイルがあればパスを返し、なければ undefined。Playwright は文字列 path を受け取れる */
function readStorageStatePath(p) {
  try {
    return fs.existsSync(p) ? p : undefined;
  } catch (_e) {
    return undefined;
  }
}

async function saveStorageState(ctx, p) {
  try {
    await ctx.storageState({ path: p });
    try {
      fs.chmodSync(p, 0o600);
    } catch (_e) {
      /* permission 変更不可でも致命的ではない */
    }
  } catch (e) {
    log(`storageState 保存に失敗: ${e?.message ?? e}`, 'warn');
  }
}

function clearStorageState(p) {
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch (_e) {
    /* ignore */
  }
}

/**
 * 管理画面 (TOP) を開き、ログイン input が無ければ「ログイン済み」と判定する。
 * captcha を踏んだら captcha を返す。
 *
 * SalonBoard は店舗種別で URL が変わるので、base URL の直接アクセスと
 * 代表的な管理画面パスの両方を試す。
 */
async function isLoggedIn(page, baseUrl) {
  const candidates = [
    safeUrl('/KLP/', baseUrl),
    safeUrl('/CNF/', baseUrl),
    baseUrl,
  ].filter(Boolean);
  for (const url of candidates) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    } catch (_e) {
      continue;
    }
    if ((await page.locator('iframe[src*="recaptcha"]').count()) > 0) {
      return 'captcha';
    }
    const loginInputCount = await page
      .locator(
        'input[name="userId"], input[name="loginId"], input[name="password"], input[type="password"]'
      )
      .count();
    if (loginInputCount > 0) return 'needs_login';
    if (/login/i.test(page.url())) return 'needs_login';
    const expiredCount = await page
      .locator('text=/再ログイン|セッション|タイムアウト|ログインしてください/')
      .first()
      .count();
    if (expiredCount > 0) return 'needs_login';
    return 'logged_in';
  }
  return 'unknown';
}

function safeUrl(rel, base) {
  try {
    return new URL(rel, base).toString();
  } catch (_e) {
    return null;
  }
}

async function tryLogin(page, c) {
  // SalonBoard はトラッキングスクリプトが多く 'load' まで永遠に来ないため、
  // 「入力欄の出現」を主軸 + 失敗時に最大3回リトライする戦略。
  const MAX_ATTEMPTS = 3;
  let lastNavError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let navError = null;
    const navPromise = page
      .goto(c.baseUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      .catch((e) => {
        navError = e;
      });
    try {
      // 入力欄の出現を待つ。1回目は 60秒、リトライ時は 45秒。
      await page.waitForSelector('input[type="password"], input[name="password"]', {
        timeout: attempt === 1 ? 60_000 : 45_000,
      });
      // 入力欄が見えた → 成功
      await Promise.race([
        navPromise,
        new Promise((r) => setTimeout(r, 3_000)),
      ]);
      lastNavError = null;
      break;
    } catch (_e) {
      lastNavError = navError;
      await navPromise.catch(() => {});
      if (attempt < MAX_ATTEMPTS) {
        // 少し待ってからリトライ (バックオフ)
        await new Promise((r) => setTimeout(r, attempt * 3_000));
      }
    }
  }
  if (lastNavError) {
    return {
      status: 'failed',
      reason: `login form not visible after ${MAX_ATTEMPTS} attempts: ${
        lastNavError instanceof Error ? lastNavError.message : lastNavError
      }`,
    };
  }

  if ((await page.locator('iframe[src*="recaptcha"]').count()) > 0) {
    return { status: 'captcha' };
  }

  const idInput = page
    .locator('input[name="userId"], input[name="loginId"], input[type="text"]')
    .first();
  const pwInput = page
    .locator('input[name="password"], input[type="password"]')
    .first();

  try {
    await idInput.fill(c.loginId, { timeout: 10_000 });
    await pwInput.fill(c.password, { timeout: 10_000 });
  } catch (e) {
    return {
      status: 'failed',
      reason: `cannot find login inputs: ${e instanceof Error ? e.message : e}`,
    };
  }

  // SalonBoard のログインボタンは <a class="common-CNCcommon__primaryBtn" onclick="dologin(event)">
  // で実装されている (button[type="submit"] は存在しない)。複数のセレクタを順に試し、
  // どれもダメなら最後の手段として password 欄で Enter を送信する。
  try {
    const submitCandidates = [
      'a.common-CNCcommon__primaryBtn',
      'a.loginBtnSize',
      'a:has-text("ログイン"):not(:has-text("ログインできない"))',
      'button[type="submit"]',
      'input[type="submit"]',
    ];
    let clicked = false;
    for (const sel of submitCandidates) {
      const loc = page.locator(sel).first();
      if ((await loc.count()) === 0) continue;
      try {
        await Promise.all([
          page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {}),
          loc.click({ timeout: 5_000 }),
        ]);
        clicked = true;
        break;
      } catch (_e) {
        // 次の候補を試す
      }
    }
    if (!clicked) {
      // 最終フォールバック: password 欄で Enter (onkeypress="enterActionLogin")
      await Promise.all([
        page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {}),
        pwInput.press('Enter', { timeout: 5_000 }),
      ]);
    }
    // クリック後にナビゲーションを少し待つ (XHR ベースの遷移にも対応)
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  } catch (e) {
    return { status: 'failed', reason: `submit: ${e instanceof Error ? e.message : e}` };
  }

  if ((await page.locator('iframe[src*="recaptcha"]').count()) > 0) {
    return { status: 'captcha' };
  }

  const stillOnLogin =
    (await pwInput.count()) > 0 || /login/i.test(page.url());
  if (stillOnLogin) {
    return { status: 'failed', reason: 'still on login page' };
  }
  return { status: 'ok' };
}

/**
 * 予約スクレイプ結果を salonboard_bulk_upsert_bookings RPC に流す。
 * 戻り値は実際に送信した行数 (バリデーション NG 行は除外)。
 */
async function sendBookings(shopId, rows) {
  if (!rows || rows.length === 0) return 0;
  // external_id / scheduled_at が無い行はサーバー側 RPC で弾かれるのでここでも除外
  const valid = rows.filter((r) => r.external_id && r.scheduled_at);
  if (valid.length === 0) return 0;
  const { error } = await supabase.rpc('salonboard_bulk_upsert_bookings', {
    p_shop_id: shopId,
    p_rows: valid,
  });
  if (error) {
    emit('log', {
      level: 'error',
      msg: `bulk_upsert_bookings: ${error.message}`,
      at: new Date().toISOString(),
    });
    return 0;
  }
  return valid.length;
}

async function sendStaff(shopId, rows) {
  if (!rows || rows.length === 0) return 0;
  const valid = rows.filter((r) => r.external_id && r.name);
  if (valid.length === 0) return 0;
  const { error } = await supabase.rpc('salonboard_bulk_upsert_staff', {
    p_shop_id: shopId,
    p_rows: valid,
  });
  if (error) {
    emit('log', {
      level: 'error',
      msg: `bulk_upsert_staff: ${error.message}`,
      at: new Date().toISOString(),
    });
    return 0;
  }
  return valid.length;
}

/**
 * 顧客詳細スクレイプ結果を customers_resolve_or_upsert RPC で 1 件ずつマージ。
 * 既存の customers レコード (external_source='salonboard' + external_customer_id=customer_code)
 * があれば update、無ければ insert される (DB 側 RPC のロジック)。
 */
async function sendCustomerDetails(shopId, rows) {
  if (!rows || rows.length === 0) return 0;
  let ok = 0;
  for (const r of rows) {
    if (!r.customer_code || !r.full_name) continue;
    try {
      const { error } = await supabase.rpc('customers_resolve_or_upsert', {
        p_shop_id: shopId,
        p_full_name: r.full_name,
        p_phone_raw: r.phone ?? null,
        p_email: r.email ?? null,
        p_birthday: r.birthday ?? null,
        p_customer_code: r.customer_code,
        p_external_source: 'salonboard',
        p_external_customer_id: r.customer_code,
        p_source: 'imported_salonboard',
        p_notes: null,
      });
      if (!error) ok++;
    } catch (_e) {
      /* 1 件の失敗はスキップしてループ継続 */
    }
  }
  return ok;
}

async function sendBlogs(shopId, rows) {
  if (!rows || rows.length === 0) return 0;
  const valid = rows.filter((r) => r.external_id && r.title);
  if (valid.length === 0) return 0;
  const { error } = await supabase.rpc('salonboard_bulk_upsert_blogs', {
    p_shop_id: shopId,
    p_rows: valid,
  });
  if (error) {
    emit('log', {
      level: 'error',
      msg: `bulk_upsert_blogs: ${error.message}`,
      at: new Date().toISOString(),
    });
    return 0;
  }
  return valid.length;
}

async function sendShifts(shopId, rows) {
  if (!rows || rows.length === 0) return 0;
  // 最低限 staff_external_id + shift_date が無いと UNIQUE 制約に当たって全件失敗するので捨てる
  const valid = rows.filter((r) => r.staff_external_id && r.shift_date);
  if (valid.length === 0) return 0;
  const { error } = await supabase.rpc('salonboard_bulk_upsert_shifts', {
    p_shop_id: shopId,
    p_rows: valid,
  });
  if (error) {
    emit('log', {
      level: 'error',
      msg: `bulk_upsert_shifts: ${error.message}`,
      at: new Date().toISOString(),
    });
    return 0;
  }
  return valid.length;
}

async function markCredentialSuccess(shopId) {
  try {
    await supabase
      .from('salonboard_credentials')
      .update({
        last_login_at: new Date().toISOString(),
        last_success_at: new Date().toISOString(),
        last_error: null,
        last_error_at: null,
        consecutive_failures: 0,
        blocked_until: null,
      })
      .eq('shop_id', shopId);
  } catch (_e) {
    // RLS 上で更新できない場合は無視 (super_owner なら通る想定)
  }
}

async function markCredentialError(shopId, reason, blockedUntil) {
  try {
    // consecutive_failures はインクリメントしたいので、いったん最新値を取得して +1
    const { data: cur } = await supabase
      .from('salonboard_credentials')
      .select('consecutive_failures')
      .eq('shop_id', shopId)
      .maybeSingle();
    const next = (cur?.consecutive_failures ?? 0) + 1;
    const update = {
      last_error: String(reason).slice(0, 500),
      last_error_at: new Date().toISOString(),
      consecutive_failures: next,
    };
    if (blockedUntil) update.blocked_until = blockedUntil;
    await supabase.from('salonboard_credentials').update(update).eq('shop_id', shopId);
  } catch (_e) {
    /* ignore */
  }
}

async function runSync({ shopIds, channels, source, showBrowser }) {
  if (running) {
    emit('error', { msg: '同期は既に実行中です' });
    return;
  }
  running = true;
  abortRequested = false;
  let runId = null;
  try {
    const targets = await fetchTargets(shopIds);
    // run を Supabase に記録開始
    try {
      const { data, error } = await supabase.rpc('salonboard_run_start', {
        p_channels: channels ?? [],
        p_source: source ?? 'desktop',
      });
      if (!error) runId = data;
    } catch (_e) {
      /* 記録できなくても同期は続行 */
    }
    emit('run:start', { total: targets.length, channels, runId });

    let okCount = 0;
    let ngCount = 0;
    for (const t of targets) {
      if (abortRequested) {
        emit('log', { level: 'warn', msg: 'ユーザー操作により中断' });
        break;
      }
      const r = await processShop(t, channels, runId, { showBrowser: !!showBrowser });
      if (r.ok) okCount++; else ngCount++;
    }

    // run の終了を記録
    if (runId) {
      try {
        await supabase.rpc('salonboard_run_finish', {
          p_run_id: runId,
          p_total: targets.length,
          p_ok: okCount,
          p_ng: ngCount,
          p_aborted: abortRequested,
        });
      } catch (_e) {
        /* ignore */
      }
    }

    emit('run:end', {
      total: targets.length,
      ok: okCount,
      ng: ngCount,
      aborted: abortRequested,
      runId,
    });
  } catch (e) {
    emit('error', { msg: e instanceof Error ? e.message : String(e) });
  } finally {
    running = false;
    abortRequested = false;
  }
}

// メッセージハンドリング
process.parentPort?.on('message', async (event) => {
  const m = event?.data ?? event;
  if (!m || typeof m !== 'object') return;
  try {
    switch (m.type) {
      case 'init':
        // 並行 init を防ぐため Promise を保持
        initPromise = (async () => {
          await initSupabase(m.payload);
        })();
        try {
          await initPromise;
          emit('ready', { ok: true });
        } catch (e) {
          emit('ready', { ok: false });
          emit('error', { msg: `init failed: ${e instanceof Error ? e.message : e}` });
        }
        break;
      case 'sync':
        // init 完了を確実に待ってから sync。supabase が null のまま走ると
        // 「Cannot read properties of null (reading 'from')」になる。
        try {
          await ensureReady();
        } catch (e) {
          emit('error', { msg: e instanceof Error ? e.message : String(e) });
          break;
        }
        await runSync(m.payload ?? {});
        break;
      case 'abort':
        abortRequested = true;
        await currentBrowser?.close().catch(() => {});
        break;
      default:
        log(`unknown message type: ${m.type}`, 'warn');
    }
  } catch (e) {
    emit('error', { msg: e instanceof Error ? e.message : String(e) });
  }
});

emit('boot', { pid: process.pid, at: new Date().toISOString() });
