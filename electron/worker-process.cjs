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

/**
 * 旧 Supabase 直読み fallback を許可するか (v0.2.5)。
 *
 * v0.2.4 では device 未設定の店舗を救済するため常に fallback していたが、
 * v0.2.5 では device 設定を userData から読む正規ルートが確立したので、
 * 本番では fallback を禁止する。
 *
 *   - NODE_ENV !== 'production' かつ ALLOW_LEGACY_SUPABASE_FALLBACK=true のときだけ許可
 *   - 本番ビルドでは常に false (= device 未設定なら同期せずエラー)
 */
const ALLOW_LEGACY_SUPABASE_FALLBACK =
  process.env.NODE_ENV !== 'production' &&
  /^(1|true|yes)$/i.test(process.env.ALLOW_LEGACY_SUPABASE_FALLBACK ?? '');

/**
 * device 認証で /api/salonboard/device/credentials を叩くための設定。
 * 親プロセス (main.cjs) からまとめて渡される。
 *
 *   apiBaseUrl  : Admin の URL (例: https://admin.example.com)
 *   deviceId    : SALONBOARD_DEVICE_ID (uuid)
 *   deviceToken : SALONBOARD_DEVICE_TOKEN (発行直後だけ表示される平文)
 *   workerId    : 任意の識別子
 *   appVersion  : 表示用
 *   platform    : process.platform
 *
 * 旧 RPC `salonboard_reveal_credentials(shop_id)` を Supabase 直叩きで呼ぶのを
 * 廃止し、Admin API 経由 (device scope 検証) に寄せる。
 *
 * 未設定の場合は revealCredentials が device 認証エラーで失敗させる。
 */
let deviceAuth = {
  apiBaseUrl: null,
  deviceId: null,
  deviceToken: null,
  workerId: 'electron-worker',
  appVersion: null,
  platform: process.platform,
};

/**
 * shop_id 単位の in-progress lock。
 *   key   : shop_id
 *   value : { startedAt: epoch ms, workerLabel: string }
 *
 * 同じ shop_id の同期が裏で走っている間は、新規同期要求を skip する。
 * lock は 20 分で stale 扱い (Playwright が固まったケースに備える)。
 *
 * プロセス再起動でこの Map は空になるので、要件「app再起動後に古いlockで詰まらないようにする」も満たす。
 */
const inProgressShops = new Map();
const SHOP_LOCK_TTL_MS = 20 * 60_000;

function tryAcquireShopLock(shopId, workerLabel) {
  const now = Date.now();
  const cur = inProgressShops.get(shopId);
  if (cur && now - cur.startedAt < SHOP_LOCK_TTL_MS) {
    return { ok: false, since: cur.startedAt, workerLabel: cur.workerLabel };
  }
  inProgressShops.set(shopId, { startedAt: now, workerLabel });
  return { ok: true };
}
function releaseShopLock(shopId) {
  inProgressShops.delete(shopId);
}

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

async function initSupabase({
  url,
  anonKey,
  accessToken,
  refreshToken,
  apiBaseUrl,
  deviceId,
  deviceToken,
  workerId,
  appVersion,
}) {
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

  // device 認証で credentials を取りに行く先を覚えておく。
  // どれか欠けていると revealCredentials が必ず失敗する (= 同期不能になる) ので、
  // ここで明示ログだけ出して受理 (v0.3.0 で必須化する)。
  deviceAuth = {
    apiBaseUrl: (apiBaseUrl || '').replace(/\/+$/, '') || null,
    deviceId: deviceId || null,
    deviceToken: deviceToken || null,
    workerId: workerId || 'electron-worker',
    appVersion: appVersion || null,
    platform: process.platform,
  };
  if (!deviceAuth.apiBaseUrl || !deviceAuth.deviceId || !deviceAuth.deviceToken) {
    log(
      'device 認証情報が未設定です (apiBaseUrl/deviceId/deviceToken)。credential 取得に失敗します。',
      'warn',
    );
  }

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
 * device 認証ヘッダを生成する (Admin API 全部で使う)。
 * deviceAuth が未設定なら null を返し、呼び出し側に「device 未設定」を分からせる。
 */
function buildDeviceHeaders(extra) {
  if (!deviceAuth.apiBaseUrl || !deviceAuth.deviceId || !deviceAuth.deviceToken) {
    return null;
  }
  return {
    Authorization: `Bearer ${deviceAuth.deviceToken}`,
    'X-Device-Id': deviceAuth.deviceId,
    'X-Worker-Id': deviceAuth.workerId ?? 'electron-worker',
    ...(deviceAuth.appVersion ? { 'X-App-Version': deviceAuth.appVersion } : {}),
    'X-Platform': deviceAuth.platform ?? process.platform,
    ...(extra ?? {}),
  };
}

/**
 * Admin API: GET /api/salonboard/device/overview
 * device に紐付いた shop の同期状態を返す。Electron が salonboard_credentials_overview を
 * Supabase から直接読むのを止めるためのエンドポイント。
 *
 * 戻り値 (null は呼び出し失敗を示す):
 *   { device: {...}, shops: [{shop_id, shop_name, organization_id,
 *     credential_status, consent_status, sync_status, enabled, blocked_until,
 *     last_success_at, last_error_at, last_error_code, last_error_message,
 *     consecutive_failures, base_url, login_id_masked}] }
 */
async function fetchDeviceOverview() {
  const headers = buildDeviceHeaders();
  if (!headers) return { ok: false, code: 'device_auth_missing', shops: [], device: null };
  try {
    const res = await fetch(
      `${deviceAuth.apiBaseUrl}/api/salonboard/device/overview`,
      { method: 'GET', headers }
    );
    if (!res.ok) {
      let body = null;
      try {
        body = await res.json();
      } catch (_e) {
        /* ignore */
      }
      return {
        ok: false,
        code: (body && body.error) || `http_${res.status}`,
        status: res.status,
        shops: [],
        device: null,
      };
    }
    const json = await res.json();
    return {
      ok: true,
      device: json.device ?? null,
      shops: Array.isArray(json.shops) ? json.shops : [],
    };
  } catch (e) {
    return {
      ok: false,
      code: 'network_error',
      error: e?.message ?? String(e),
      shops: [],
      device: null,
    };
  }
}

/**
 * 同期対象の店舗一覧を取得 (enabled かつ未ブロック)。
 *  - shopIds が指定されている場合はその店舗だけ
 *
 * v0.2.3: Admin API (/api/salonboard/device/overview) 経由に変更。
 * v0.2.4: device 未設定の店舗PCを救済するため、device_auth_missing /
 *         network_error のときに限り旧 salonboard_credentials_overview 直読みに
 *         fallback する。auth 系拒否 (device_unauthorized など) では fallback しない
 *         (= 故意に無効化された device に旧経路で動かれては困るため)。
 */
let _fetchTargetsFallbackWarned = false;
async function fetchTargets(shopIds) {
  const overview = await fetchDeviceOverview();

  if (overview.ok) {
    const orgName = overview.device?.organization_id ?? null;
    const now = Date.now();
    const rows = (overview.shops ?? []).filter((s) => {
      if (s.credential_status === 'missing') return false;
      if (s.enabled === false) return false;
      if (s.blocked_until && new Date(s.blocked_until).getTime() > now) return false;
      return true;
    });
    const filtered = Array.isArray(shopIds) && shopIds.length > 0
      ? rows.filter((r) => shopIds.includes(r.shop_id))
      : rows;
    return filtered.map((s) => ({
      shop_id: s.shop_id,
      shop_name: s.shop_name,
      organization_id: s.organization_id,
      organization_name: orgName,
      has_credential: true,
      enabled: !!s.enabled,
      blocked_until: s.blocked_until ?? null,
    }));
  }

  // ----- fallback (v0.2.4 → v0.2.5 で本番無効化) -----
  // device 未設定 = 「設定が必要」エラーとして止める。
  // 旧 Supabase 直読み fallback は ALLOW_LEGACY_SUPABASE_FALLBACK (開発のみ) のとき限定。
  if (overview.code === 'device_auth_missing' && !ALLOW_LEGACY_SUPABASE_FALLBACK) {
    const e = new Error(
      'このPCのSalonBoard連携device設定が未完了です。管理画面でdeviceを発行し、設定画面で登録してください。'
    );
    e.code = 'device_unconfigured';
    throw e;
  }

  const safeFallbackCodes = new Set([
    'device_auth_missing',
    'network_error',
    'http_500',
    'http_502',
    'http_503',
    'http_504',
  ]);
  if (!ALLOW_LEGACY_SUPABASE_FALLBACK || !safeFallbackCodes.has(String(overview.code ?? ''))) {
    // 本番 (fallback 無効) では到達。401/403 など故意拒否でも到達。
    throw new Error(
      `fetchTargets via /overview API failed: ${overview.code}${
        overview.error ? ` (${overview.error})` : ''
      }`
    );
  }

  if (!_fetchTargetsFallbackWarned) {
    log(
      `[dev] device API 利用不可 (${overview.code})。旧 Supabase 直読みに fallback します`,
      'warn',
    );
    _fetchTargetsFallbackWarned = true;
  }

  // 旧経路: salonboard_credentials_overview を直接読む (Supabase auth セッションの権限で)
  let q = supabase
    .from('salonboard_credentials_overview')
    .select(
      'organization_id, organization_name, shop_id, shop_name, has_credential, enabled, blocked_until'
    );
  q = q.eq('has_credential', true);
  if (Array.isArray(shopIds) && shopIds.length > 0) {
    q = q.in('shop_id', shopIds);
  }
  const { data, error } = await q;
  if (error) throw new Error(`fetchTargets fallback failed: ${error.message}`);
  const now = Date.now();
  return (data ?? []).filter((r) => {
    if (!r.enabled) return false;
    if (r.blocked_until && new Date(r.blocked_until).getTime() > now) return false;
    return true;
  });
}

/**
 * 店舗の SalonBoard 認証情報を Admin API 経由で取得する。
 *
 * v0.2.2 で旧 RPC `salonboard_reveal_credentials(shop_id)` の Supabase 直叩きを
 * 廃止し、device scope を通る Admin API:
 *   POST /api/salonboard/device/credentials
 * に切り替えた。
 *
 * device 認証ヘッダ:
 *   Authorization: Bearer <SALONBOARD_DEVICE_TOKEN>
 *   X-Device-Id:   <uuid>
 *   X-Worker-Id:   <任意>
 *   X-App-Version: <表示用>
 *   X-Platform:    <process.platform>
 *
 * 失敗時は分かるエラーを投げる:
 *   - device_auth_missing : Electron 側に device 認証 env が無い
 *   - device_unauthorized : 401
 *   - credentials_not_set / credentials_disabled / blocked / consent_missing /
 *     shop_not_allowed / credentials_not_revealable : 403/404
 *   - http_error          : 5xx
 *   - network_error       : fetch 失敗 (タイムアウト等)
 *
 * これらは processShop 側で error_code として分類される。
 */
/**
 * 旧 RPC を使った credentials 取得 (v0.2.4 fallback 用)。
 * device 認証情報が無い店舗PCで同期を継続するためのみに使う。
 * Supabase auth セッションの権限 (super_owner / admin / owner / shop_manager) で
 * RLS を通る前提。
 */
async function revealCredentialsLegacy(shopId) {
  const { data, error } = await supabase.rpc('salonboard_reveal_credentials', {
    p_shop_id: shopId,
  });
  if (error) {
    const e = new Error(`legacy reveal failed: ${error.message}`);
    e.code = 'legacy_reveal_failed';
    throw e;
  }
  const row = Array.isArray(data) && data[0] ? data[0] : null;
  if (!row) {
    const e = new Error('credentials_not_revealable');
    e.code = 'credentials_not_revealable';
    throw e;
  }
  return row;
}

let _revealFallbackWarned = false;
async function revealCredentials(shopId) {
  const headers = buildDeviceHeaders({ 'Content-Type': 'application/json' });

  // device 未設定: v0.2.5 では本番で fallback しない (= 設定が必要なエラー)
  if (!headers) {
    if (!ALLOW_LEGACY_SUPABASE_FALLBACK) {
      const e = new Error(
        'このPCのSalonBoard連携device設定が未完了です。設定画面でdeviceを登録してください。'
      );
      e.code = 'device_unconfigured';
      throw e;
    }
    // --- 開発限定 fallback ---
    if (!_revealFallbackWarned) {
      log(
        '[dev] device 未設定のため credentials を旧 RPC fallback で取得します',
        'warn',
      );
      _revealFallbackWarned = true;
    }
    const row = await revealCredentialsLegacy(shopId);
    let baseUrl = String(row.base_url ?? '').trim();
    if (!baseUrl || baseUrl === 'https://salonboard.com' || baseUrl === 'https://salonboard.com/') {
      baseUrl = 'https://salonboard.com/login/';
    }
    if (/^https?:\/\/[^/]+\/?$/i.test(baseUrl)) {
      baseUrl = baseUrl.replace(/\/?$/, '/') + 'login/';
    }
    return { loginId: row.login_id, password: row.password, baseUrl };
  }

  const url = `${deviceAuth.apiBaseUrl}/api/salonboard/device/credentials`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ shop_id: shopId }),
    });
  } catch (e) {
    // API 自体に到達できない (オフライン等) → fallback
    if (!_revealFallbackWarned) {
      log(
        `device API 疎通不可、旧 RPC fallback で credentials 取得を試みます: ${e?.message ?? e}`,
        'warn',
      );
      _revealFallbackWarned = true;
    }
    try {
      const row = await revealCredentialsLegacy(shopId);
      let baseUrl = String(row.base_url ?? '').trim();
      if (!baseUrl || baseUrl === 'https://salonboard.com' || baseUrl === 'https://salonboard.com/') {
        baseUrl = 'https://salonboard.com/login/';
      }
      if (/^https?:\/\/[^/]+\/?$/i.test(baseUrl)) {
        baseUrl = baseUrl.replace(/\/?$/, '/') + 'login/';
      }
      return { loginId: row.login_id, password: row.password, baseUrl };
    } catch (e2) {
      const err = new Error(`network_error: ${e?.message ?? e}`);
      err.code = 'network_error';
      throw err;
    }
  }

  if (!res.ok) {
    let json;
    try {
      json = await res.json();
    } catch (_e) {
      json = null;
    }
    const code = (json && json.error) || `http_${res.status}`;
    const err = new Error(`reveal failed: ${code}`);
    err.code = code;
    err.status = res.status;
    if (json && json.blocked_until) err.blockedUntil = json.blocked_until;
    throw err;
  }

  const row = await res.json();
  if (!row || !row.login_id) {
    const err = new Error('credentials_not_revealable');
    err.code = 'credentials_not_revealable';
    throw err;
  }

  // base_url の正規化: 末尾スラッシュのみだったり login パスが抜けていると
  // 「https://salonboard.com/」 にアクセスしてしまって遅延・タイムアウトになる。
  let baseUrl = String(row.base_url ?? '').trim();
  if (!baseUrl || baseUrl === 'https://salonboard.com' || baseUrl === 'https://salonboard.com/') {
    baseUrl = 'https://salonboard.com/login/';
  }
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

  // 多重起動防止: 同じ shop_id がすでに同期中なら skip
  const lock = tryAcquireShopLock(shopId, deviceAuth.workerId ?? 'electron-worker');
  if (!lock.ok) {
    const sinceSec = Math.round((Date.now() - lock.since) / 1000);
    emit('shop:start', { shopId, shopName, orgName, channels });
    emit('shop:end', {
      shopId,
      ok: false,
      error: `同期中です (約${sinceSec}秒前から)。完了まで待ってください。`,
      errorCode: 'already_in_progress',
    });
    return { ok: false, errorCode: 'already_in_progress' };
  }

  emit('shop:start', { shopId, shopName, orgName, channels });
  const counts = { bookings: 0, staff: 0, blogs: 0, customers: 0 };

  let creds;
  try {
    creds = await revealCredentials(shopId);
  } catch (e) {
    // credentials 失敗も classifyError で分類して、ロック解除
    const classified = classifyError(e);
    const blockedUntil = blockedUntilForCode(classified.code);
    await markCredentialError(shopId, e.message ?? String(e), blockedUntil, classified.code);
    emit('shop:end', {
      shopId,
      ok: false,
      error: `credentials: ${e.message ?? e}`,
      errorCode: classified.code,
      userHint: classified.userHint,
      blockedUntil,
    });
    await recordShopRun(runId, shopId, false, null, `credentials: ${e.message ?? e}`, counts);
    releaseShopLock(shopId);
    return { ok: false, errorCode: classified.code };
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
    // session_expired のときは「1 回だけ」再ログインする (連打しない)
    let needsLogin = true;
    let sessionReused = false;
    let sessionExpiredFlag = false;
    if (initialStorage) {
      try {
        const sessionState = await isLoggedIn(page, creds.baseUrl);
        if (sessionState === 'logged_in') {
          needsLogin = false;
          sessionReused = true;
          emit('shop:progress', {
            shopId,
            step: 'login',
            msg: '既存セッションで継続 (ログインスキップ)',
          });
        } else if (sessionState === 'captcha') {
          // captcha 検知 → セッション破棄 + 6h ブロック (再ログイン連打しない)
          clearStorageState(ssPath);
          const blockedUntil = blockedUntilForCode('captcha_detected');
          await markCredentialError(
            shopId,
            'reCAPTCHA encountered at landing',
            blockedUntil,
            'captcha_detected',
          );
          emit('shop:end', {
            shopId,
            ok: false,
            error: 'reCAPTCHA を検知しました (6 時間ブロック)',
            errorCode: 'captcha_detected',
            blockedUntil,
          });
          await recordShopRun(runId, shopId, false, null, 'captcha_detected', counts);
          return { ok: false, errorCode: 'captcha_detected' };
        } else if (sessionState === 'needs_login') {
          // セッション切れ → 1 回だけ再ログイン (連打しない)
          sessionExpiredFlag = true;
          clearStorageState(ssPath);
        }
      } catch (_e) {
        // 判定処理自体が転んだら通常ログインにフォールバック
      }
    }

    // 2) 必要なときだけログイン (session_expired のときも合計 1 回)
    let loginAttempted = false;
    if (needsLogin) {
      loginAttempted = true;
      const r = await tryLogin(page, creds);
      if (r.status === 'captcha') {
        clearStorageState(ssPath);
        const blockedUntil = blockedUntilForCode('captcha_detected');
        await markCredentialError(
          shopId,
          'reCAPTCHA encountered during login',
          blockedUntil,
          'captcha_detected',
        );
        emit('shop:end', {
          shopId,
          ok: false,
          error: 'reCAPTCHA を検知しました (6 時間ブロック)',
          errorCode: 'captcha_detected',
          blockedUntil,
        });
        await recordShopRun(runId, shopId, false, null, 'captcha_detected', counts);
        return { ok: false, errorCode: 'captcha_detected' };
      }
      if (r.status === 'failed') {
        // session_expired → 再ログイン失敗 = login_required
        // 通常 login 失敗 → reason から推測 (classifyError と同じルール)
        const code = sessionExpiredFlag
          ? 'login_required'
          : classifyError(new Error(r.reason ?? 'login_failed')).code;
        clearStorageState(ssPath);
        const blockedUntil = blockedUntilForCode(code);
        await markCredentialError(shopId, r.reason ?? 'login_failed', blockedUntil, code);
        emit('shop:end', {
          shopId,
          ok: false,
          error: r.reason ?? 'ログイン失敗',
          errorCode: code,
          blockedUntil,
        });
        await recordShopRun(runId, shopId, false, null, r.reason ?? 'login_failed', counts);
        return { ok: false, errorCode: code };
      }
      emit('shop:progress', { shopId, step: 'login', msg: 'ログイン成功' });
      // 成功 → storageState を保存
      await saveStorageState(ctx, ssPath);
    }

    // 監査用フラグ (作業6 のログ拡張で使う)
    counts._meta = {
      storage_state_used: !!initialStorage,
      session_reused: sessionReused,
      login_attempted: loginAttempted,
    };

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
        const { rows, debug } = await scrapeStaff(page);
        const sent = await sendStaff(shopId, rows);
        counts.staff = sent;
        summary.push(`スタッフ ${sent} 件 (検出${rows.length})`);
        // v0.2.10+: 取得状況を診断ログで残す (件数が想定と合わないとき切り分け用)
        emit('log', {
          level: 'info',
          msg:
            `[${shopId.slice(0, 8)}] staff scrape: ` +
            `parsed=${debug?.parsed ?? 0} sent=${sent} ` +
            `totalLinks=${debug?.totalLinks ?? 0} ` +
            `totalRows=${debug?.totalRows ?? 0} ` +
            `methodC=${debug?.methodCContainers ?? 0} ` +
            `methodD=${debug?.methodDExtracted ?? 0}/${debug?.methodDImgTrs ?? 0}`,
          at: new Date().toISOString(),
        });
        // v0.2.12: サンプル (最初の 3 件の方式 D 出力) を診断ログに残す
        if (Array.isArray(debug?.methodDSamples)) {
          for (const s of debug.methodDSamples) {
            emit('log', {
              level: 'info',
              msg:
                `[${shopId.slice(0, 8)}] staff sample#${s.idx}: ` +
                `trCount=${s.groupTrCount} textTds=${s.textTdCount} ` +
                `bestLines=${s.bestLinesCount} name="${(s.name || '').slice(0, 40)}" ` +
                `ext=${s.extId ?? '-'} ` +
                `lines=[${(s.bestLinesPreview || []).map((l) => '"' + String(l).slice(0, 30) + '"').join(', ')}]`,
              at: new Date().toISOString(),
            });
          }
        }
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
    const classified = classifyError(e);
    const blockedUntil = blockedUntilForCode(classified.code);
    await markCredentialError(shopId, errMsg, blockedUntil, classified.code);
    emit('shop:end', {
      shopId,
      ok: false,
      error: errMsg,
      errorCode: classified.code,
      userHint: classified.userHint,
      blockedUntil,
    });
    await recordShopRun(runId, shopId, false, null, errMsg, counts);
    return { ok: false, errorCode: classified.code };
  } finally {
    await browser.close().catch(() => {});
    currentBrowser = null;
    releaseShopLock(shopId);
  }
}

/**
 * 例外を以下のいずれかに分類する:
 *   captcha_detected / blocked / rate_limited / login_required /
 *   session_expired / non_retryable_failed / retryable_failed
 *
 * 既知の Playwright / fetch エラーメッセージから判定。
 * 未知のものは retryable_failed として扱う (=ネット系想定で短期再試行可能)。
 */
function classifyError(e) {
  if (!e) return { code: 'retryable_failed', userHint: '不明なエラー' };
  if (typeof e === 'object' && e.code) {
    // revealCredentials が code を付けて投げてきたケース
    switch (e.code) {
      case 'blocked':
        return {
          code: 'blocked',
          userHint:
            '店舗のSalonBoard連携は一時的にブロックされています。' +
            (e.blockedUntil ? `${e.blockedUntil} まで停止中。` : '時間をおいて再試行してください。'),
        };
      case 'credentials_disabled':
        return {
          code: 'non_retryable_failed',
          userHint: '店舗のSalonBoard連携が無効化されています (admin/salonboard で確認)',
        };
      case 'consent_missing':
        return {
          code: 'non_retryable_failed',
          userHint: 'SalonBoard連携の利用同意が登録されていません',
        };
      case 'credentials_not_set':
        return {
          code: 'non_retryable_failed',
          userHint: 'SalonBoardのログイン情報が未設定です',
        };
      case 'shop_not_allowed':
      case 'device_unauthorized':
      case 'device_auth_missing':
      case 'http_401':
        return {
          code: 'login_required',
          userHint: 'このデバイスはこの店舗のSalonBoard連携を扱えません。管理者に確認してください',
        };
      case 'network_error':
        return { code: 'retryable_failed', userHint: 'ネットワーク不調。時間をおいて再試行' };
    }
  }
  const msg = (e?.message ?? String(e)).toLowerCase();
  // captcha
  if (/captcha|recaptcha|不審なアクセス|ロボット|画像認証/i.test(e?.message ?? '')) {
    return { code: 'captcha_detected', userHint: 'reCAPTCHA を検知しました。手動確認が必要です' };
  }
  // 429 / rate limit
  if (/\b429\b|too many requests|アクセスが集中|しばらく時間をおいて|rate.?limit/i.test(e?.message ?? '')) {
    return { code: 'rate_limited', userHint: 'アクセス制限です。しばらく時間を空けてください' };
  }
  // 403 / blocked
  if (/\b403\b|forbidden|アカウントロック|アクセス.*制限|一時的に利用できない|不正なアクセス/i.test(e?.message ?? '')) {
    return { code: 'blocked', userHint: 'SalonBoard側で一時ブロックされています' };
  }
  // login_required
  if (/login.*fail|invalid.*(password|userid|loginid|credential)|認証情報|ログインに失敗|ログイン.*失敗/i.test(e?.message ?? '')) {
    return { code: 'login_required', userHint: 'ログイン情報の確認が必要です' };
  }
  // session 切れ
  if (/session|セッション|再ログイン|タイムアウト/i.test(e?.message ?? '')) {
    return { code: 'session_expired', userHint: 'セッションが切れました。再ログインが必要です' };
  }
  // タイムアウトやネット系
  if (msg.includes('timeout') || msg.includes('econnreset') || msg.includes('econnrefused')) {
    return { code: 'retryable_failed', userHint: '一時的なネットワークエラー' };
  }
  return { code: 'retryable_failed', userHint: '不明なエラー (ログ参照)' };
}

function blockedUntilForCode(code) {
  const now = Date.now();
  switch (code) {
    case 'captcha_detected':
      return new Date(now + 6 * 3600_000).toISOString(); // 6h
    case 'blocked':
      return new Date(now + 6 * 3600_000).toISOString(); // 6h
    case 'rate_limited':
      return new Date(now + 3 * 3600_000).toISOString(); // 3h
    default:
      return null; // login_required / non_retryable_failed / retryable_failed は blocked にしない
  }
}

/** salonboard_run_record_shop RPC を呼び、店舗単位の結果を Supabase に保存 */
async function recordShopRun(runId, shopId, ok, summary, error, counts) {
  if (!runId) return;
  try {
    // ログ強化 (作業6): meta 情報を summary 末尾に JSON 付記。
    // DB スキーマ変更を伴わずに device_id / storage_state_used / session_reused /
    // login_attempted / error_code を追跡可能にする。
    const meta = {
      worker_id: deviceAuth.workerId ?? 'electron-worker',
      device_id: deviceAuth.deviceId ?? null,
      app_version: deviceAuth.appVersion ?? null,
      platform: deviceAuth.platform ?? process.platform,
      storage_state_used: counts?._meta?.storage_state_used ?? null,
      session_reused: counts?._meta?.session_reused ?? null,
      login_attempted: counts?._meta?.login_attempted ?? null,
    };
    const summaryWithMeta =
      (summary ?? '') + ` [meta:${JSON.stringify(meta)}]`;

    await supabase.rpc('salonboard_run_record_shop', {
      p_run_id: runId,
      p_shop_id: shopId,
      p_ok: ok,
      p_summary: summaryWithMeta.slice(0, 2000),
      p_error: error,
      p_bookings_count: counts?.bookings ?? 0,
      p_staff_count: counts?.staff ?? 0,
      p_blogs_count: counts?.blogs ?? 0,
      p_customers_count: counts?.customers ?? 0,
    });

    // 構造化ログを Electron UI 側でも見られるように emit
    emit('shop:record', {
      shopId,
      ok,
      summary,
      error,
      counts: {
        bookings: counts?.bookings ?? 0,
        staff: counts?.staff ?? 0,
        blogs: counts?.blogs ?? 0,
        customers: counts?.customers ?? 0,
      },
      meta,
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

/**
 * 同期エラーを Admin に通知する (v0.2.3 で Admin API 化)。
 *
 * 旧実装は Electron から直接 salonboard_credentials を UPDATE していたが、
 * v0.2.3 では POST /api/salonboard/device/report-error に寄せる。
 * これにより Electron 側に salonboard_credentials の UPDATE 権限が不要になる。
 *
 * device 認証が未設定 / API 疎通失敗のときは旧フォールバック (Supabase 直書き) を
 * 試みる。完全失敗時は致命的でないので silent 扱い。
 */
async function markCredentialError(shopId, reason, blockedUntil, errorCode) {
  const headers = buildDeviceHeaders({ 'Content-Type': 'application/json' });
  if (headers) {
    try {
      const res = await fetch(
        `${deviceAuth.apiBaseUrl}/api/salonboard/device/report-error`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            shop_id: shopId,
            error_code: errorCode ?? 'retryable_failed',
            reason: String(reason ?? '').slice(0, 500),
            blocked_until: blockedUntil ?? null,
          }),
        }
      );
      if (res.ok) return;
      // API 側 401/403/404 のとき fallback には進まない (権限上書きを試みても無駄)
      if (res.status === 401 || res.status === 403 || res.status === 404) {
        const t = await res.text().catch(() => '');
        log(`report-error API rejected (${res.status}): ${t.slice(0, 200)}`, 'warn');
        return;
      }
      // 5xx 等は下の Supabase fallback に進む
    } catch (e) {
      log(`report-error API network error: ${e?.message ?? e}`, 'warn');
      /* fallback へ */
    }
  }

  // フォールバック: 旧 Supabase 直書き (device 未設定 or 5xx のとき)。
  // v0.2.5: 本番では fallback しない (エラー記録は API 経由のみ)。
  // markCredentialError は致命的でないので、本番で書けなくても silent に諦める。
  if (!ALLOW_LEGACY_SUPABASE_FALLBACK) return;
  try {
    const { data: cur } = await supabase
      .from('salonboard_credentials')
      .select('consecutive_failures')
      .eq('shop_id', shopId)
      .maybeSingle();
    const next = (cur?.consecutive_failures ?? 0) + 1;
    const prefixed = errorCode ? `[${errorCode}] ${String(reason)}` : String(reason);
    const update = {
      last_error: prefixed.slice(0, 500),
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
