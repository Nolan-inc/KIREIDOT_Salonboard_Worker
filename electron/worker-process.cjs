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
  scrapeMenus,
  scrapeCoupons,
  scrapeBlogs,
  scrapeShifts,
  scrapeCustomerDetails,
  pushBookingViaForm,
  cancelBookingViaForm,
  changeBookingViaForm,
  postBlogViaForm,
  deleteBlogViaForm,
  postPhotoGalleryViaForm,
} = require('./scrapers.cjs');

// プロセス全体のクラッシュ防止:
// スクレイピング中の未捕捉の例外/Promise reject (Playwright の
// "Execution context was destroyed" 等) が utilityProcess を即死させ、
// 表示中のブラウザごと強制終了する事故を防ぐ。ログに残して継続する。
process.on('unhandledRejection', (reason) => {
  try {
    const msg = reason && reason.message ? reason.message : String(reason);
    emit('log', { level: 'error', msg: `unhandledRejection: ${msg}`, at: new Date().toISOString() });
  } catch (_e) {
    /* emit 自体が失敗してもプロセスは落とさない */
  }
});
process.on('uncaughtException', (err) => {
  try {
    emit('log', { level: 'error', msg: `uncaughtException: ${err?.message ?? err}`, at: new Date().toISOString() });
  } catch (_e) {
    /* noop */
  }
});

let supabase = null;
let initReady = false;
let initPromise = null;
let running = false;
let runStartedAt = 0;
let abortRequested = false;
let currentBrowser = null;
// runPushJobs の二重起動防止 (Realtime トリガー + 自動同期が重なるケース)
let pushJobsRunning = false;
// 自動 push をブラウザ表示(headful)で実行するか。
// headless だと SalonBoard のログイン画面で bot 検知され、入力欄が描画されず
// ログインがハングするケースがあるため、手動「SB挿入」と同じく headful で動かす。
const AUTO_PUSH_SHOW_BROWSER = true;

// 取得(同期)もブラウザ表示(headful)で実行するか。
// push と同様、headless だと SalonBoard 側で bot 検知され予約一覧が空応答に
// なる(結果テーブルが描画されない=no_result_table)ケースがあるため、毎時の
// 自動取得・手動「同期」ボタンを含めて常に headful で動かす。
// (renderer 側で showBrowser を渡さない呼び出しもあるため、worker 側で一律強制する)
const AUTO_SYNC_SHOW_BROWSER = true;

/**
 * 全体同期 (runSync) の stale タイムアウト。
 * runSync は scraping + push_booking (SalonBoard フォーム書込) を含み、
 * Playwright が固まると finally に到達せず running が true のまま残る
 * (= 以後ずっと「同期は既に実行中です」になる) 。
 * 開始から下記時間を超えた running は「ハング」とみなし、新規同期要求で奪取する。
 */
const RUN_STALE_MS = 15 * 60_000;

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

/**
 * ブラウザ操作 (挿入 / キャンセル / 変更) の直列化キュー。
 *
 * UI から複数の予約を同時に「SalonBoard に挿入」すると、runTestPush 等が
 * 並列に chromium.launch → 同一 SalonBoard アカウントへ同時ログイン →
 * 同じスケジュール画面を同時操作してしまい、SalonBoard が
 * 「既に操作されています (2度押しエラー)」を返す。
 * (storageState ファイルも shop 単位で共有しているためセッションが競合する)
 *
 * そこで、これらの操作は何件並列で要求されても 1 件ずつ順番に実行する。
 * Promise チェーンで前のタスクの完了を待ってから次を走らせるだけのシンプルな
 * 直列キュー。タスクが throw / reject してもチェーンは切らさない。
 */
let serialTail = Promise.resolve();
function enqueueSerial(task) {
  const run = serialTail.then(() => task());
  // 次のタスクが前タスクの失敗で巻き込まれないよう、tail は常に解決にする。
  serialTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
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
  enablePush,
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
  // Realtime の認証にもアクセストークンを渡す (postgres_changes の RLS 評価に必要)。
  try { supabase.realtime.setAuth(accessToken); } catch (_e) { /* 古いSDKでは無くてもよい */ }

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
    // 実登録 (登録ボタンを押す) を許可するか。設定画面のトグル → main → ここへ。
    enablePush: !!enablePush,
  };
  if (!deviceAuth.apiBaseUrl || !deviceAuth.deviceToken) {
    log(
      '認証情報が未設定です (apiBaseUrl/token)。credential 取得に失敗します。設定画面で API URL と Worker Token を登録してください。',
      'warn',
    );
  }

  initReady = true;

  // KIREIDOT/Admin で予約が作成されると salonboard_sync_jobs に push_booking ジョブが
  // 投入される。それを Realtime で購読し、投入された瞬間に push を実行する
  // (= 予約作成→即SB反映)。Worker が落ちている間のジョブはキューに残り、起動時の
  // 自動同期/この購読の初回トリガーでまとめて処理される。
  subscribeToPushJobs();
}

// ---- push_booking ジョブの Realtime 購読 (即時 push トリガー) ----
let pushJobChannel = null;
let pushTriggerTimer = null;

/**
 * salonboard_sync_jobs の INSERT を購読し、push_booking / cancel_booking ジョブが
 * 積まれたら runPushJobs を (デバウンスして) 起動する。
 * 連続作成に備え 1.5 秒デバウンス。実行中(running)なら runPushJobs 側でスキップされる。
 */
function subscribeToPushJobs() {
  if (!supabase) return;
  try {
    if (pushJobChannel) {
      try { supabase.removeChannel(pushJobChannel); } catch (_e) { /* noop */ }
      pushJobChannel = null;
    }
    pushJobChannel = supabase
      .channel('salonboard-push-jobs')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'salonboard_sync_jobs' },
        (payload) => {
          const jt = payload?.new?.job_type;
          if (jt !== 'push_booking' && jt !== 'cancel_booking' && jt !== 'push_blog' && jt !== 'delete_blog' && jt !== 'push_photo_gallery') return;
          log(`Realtime: ${jt} ジョブを検知 → push 処理を予約 (デバウンス)`, 'info');
          if (pushTriggerTimer) clearTimeout(pushTriggerTimer);
          pushTriggerTimer = setTimeout(() => {
            pushTriggerTimer = null;
            // 全体同期中は runPushJobs を呼ばない (runSync 末尾で処理されるため二重実行回避)。
            if (running) return;
            runPushJobs({ showBrowser: AUTO_PUSH_SHOW_BROWSER }).catch((e) =>
              log(`Realtime トリガーの push 処理でエラー: ${e?.message ?? e}`, 'warn'),
            );
          }, 1500);
        },
      )
      .subscribe((status) => {
        log(`Realtime 購読ステータス: ${status}`, 'info');
        if (status === 'SUBSCRIBED') {
          log('Realtime: salonboard_sync_jobs を購読開始 (予約作成→即SB反映)', 'info');
          // 起動時/再購読時に、購読前に積まれていた未処理ジョブをまとめて処理する。
          if (!running) {
            runPushJobs({ showBrowser: AUTO_PUSH_SHOW_BROWSER }).catch(() => {});
          }
        }
      });
  } catch (e) {
    log(`Realtime 購読の開始に失敗: ${e?.message ?? e}`, 'warn');
  }

  // Realtime が (RLS/接続の都合で) 効かないケースに備えた保険ポーリング。
  // queued の push/cancel ジョブが残っていれば runPushJobs で消化する。
  // (Admin API claim 任せだとアプリ側で件数を見られないので、DB を直接 count する)
  startPushJobPoller();
}

let pushJobPollTimer = null;
const PUSH_JOB_POLL_MS = 45_000;
function startPushJobPoller() {
  if (pushJobPollTimer) return; // 多重起動防止
  pushJobPollTimer = setInterval(async () => {
    try {
      if (!supabase || running || pushJobsRunning) return;
      const { count, error } = await supabase
        .from('salonboard_sync_jobs')
        .select('id', { count: 'exact', head: true })
        .in('job_type', ['push_booking', 'cancel_booking', 'push_blog', 'delete_blog', 'push_photo_gallery'])
        .eq('status', 'queued');
      if (error) return;
      if ((count ?? 0) > 0) {
        log(`保険ポーリング: 未処理ジョブ ${count} 件を検知 → push 処理`, 'info');
        runPushJobs({ showBrowser: AUTO_PUSH_SHOW_BROWSER }).catch(() => {});
      }
    } catch (_e) { /* noop */ }
  }, PUSH_JOB_POLL_MS);
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
  // global token 運用: apiBaseUrl + token があればよい (deviceId は任意)。
  if (!deviceAuth.apiBaseUrl || !deviceAuth.deviceToken) {
    return null;
  }
  return {
    Authorization: `Bearer ${deviceAuth.deviceToken}`,
    // deviceId があるときだけ X-Device-Id を付ける。
    // 無ければ global token モード (Admin 側で全店舗スコープになる)。
    ...(deviceAuth.deviceId ? { 'X-Device-Id': deviceAuth.deviceId } : {}),
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
      // 店舗ジャンル (hair/nail/esthetic/eyelash/other)。未設定は esthetic 扱い。
      genre: s.genre ?? 'esthetic',
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
      'organization_id, organization_name, shop_id, shop_name, shop_genre, has_credential, enabled, blocked_until'
    );
  q = q.eq('has_credential', true);
  if (Array.isArray(shopIds) && shopIds.length > 0) {
    q = q.in('shop_id', shopIds);
  }
  const { data, error } = await q;
  if (error) throw new Error(`fetchTargets fallback failed: ${error.message}`);
  const now = Date.now();
  return (data ?? [])
    .filter((r) => {
      if (!r.enabled) return false;
      if (r.blocked_until && new Date(r.blocked_until).getTime() > now) return false;
      return true;
    })
    .map((r) => ({ ...r, genre: r.shop_genre ?? 'esthetic' }));
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
    // グループ店舗用 SalonBoard サロンID (H000...)。null は単一店舗ログイン。
    salonId: row.salon_id ?? null,
  };
}

/**
 * 1 店舗ぶんの同期処理 (Phase 2 ではログインまでで return)。
 * Phase 3 で予約一覧/予約管理/スタッフ/ブログのスクレイピングを足す。
 */
async function processShop(target, channels, runId, opts = {}) {
  const { shop_id: shopId, shop_name: shopName, organization_name: orgName } = target;
  const showBrowser = !!opts.showBrowser;
  // 店舗ジャンル (hair/nail/esthetic/eyelash/other)。未設定は esthetic 扱い。
  // スクレイパーはこれを見てジャンル別の取得方法に分岐する (現状 esthetic のみ実装、
  // 美容室=hair はスタッフ→スタイリスト/メニュー→スタイルに差し替え)。
  const genre = target.genre || 'esthetic';

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

  emit('shop:start', { shopId, shopName, orgName, channels, genre });
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
        const sessionState = await isLoggedIn(page, creds.baseUrl, genre);
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
      // 取得時も bot 検知/reCAPTCHA を避けるため、人間らしくゆっくり(1文字ずつ)ログインする。
      const r = await tryLogin(page, { ...creds, slow: true });
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

    // ---- グループ店舗(1ログイン複数サロン)のサロン選択 ----
    // ログイン後 /CNC/groupTop/ に着地する場合は対象サロンを選択してから取得する。
    // 単一店舗ログインなら no-op。失敗時は誤店舗取得を避けて安全に停止する。
    try {
      const sel = await ensureStoreSelected(page, {
        salonId: creds.salonId ?? null,
        shopName,
      });
      if (sel.selected) {
        emit('shop:progress', { shopId, step: 'login', msg: `サロン選択: ${sel.salonId ?? ''}` });
      }
      if (!sel.ok) {
        const hint =
          sel.reason && sel.reason.startsWith('salon_id_not_in_group')
            ? '設定したサロンIDがこのアカウントのグループに見つかりません。サロンIDを確認してください。'
            : sel.reason === 'group_top_name_unmatched' || sel.reason === 'group_top_no_target'
              ? 'グループ店舗のサロン選択で対象を特定できません。店舗のSalonBoard設定でサロンID(H...)を登録してください。'
              : 'グループ店舗のサロン選択に失敗しました。';
        await markCredentialError(shopId, `group_store_select: ${sel.reason ?? 'unknown'}`, null, 'store_select_required');
        emit('shop:end', { shopId, ok: false, error: hint, errorCode: 'store_select_required' });
        await recordShopRun(runId, shopId, false, null, `store_select: ${sel.reason ?? 'unknown'}`, counts);
        return { ok: false, errorCode: 'store_select_required' };
      }
    } catch (e) {
      emit('log', {
        level: 'warn',
        msg: `[${shopId.slice(0, 8)}] store-select error: ${e instanceof Error ? e.message : e}`,
        at: new Date().toISOString(),
      });
    }

    // ---- スクレイピング本体 (channels で選択された分だけ) ----
    const channelSet = new Set(channels);
    const summary = [];

    if (channelSet.has('bookings')) {
      try {
        emit('shop:progress', { shopId, step: 'bookings', msg: '予約一覧を取得中…' });
        let { rows, debug } = await scrapeBookings(page, { baseUrl: creds.baseUrl, genre });
        // グループ店舗で予約一覧到達時にログアウト/サロン選択戻り/セッション切れに
        // なった場合、1 回だけリカバリして再取得する。
        //   - group_top      : サロンを選び直すだけで復帰しうる
        //   - session_expired/login: 再ログイン → サロン再選択が必要
        if (debug && debug.loggedOut) {
          emit('log', { level: 'warn', msg: `[${shopId.slice(0, 8)}] 予約一覧で${debug.landedOn}を検知、リカバリして再取得します`, at: new Date().toISOString() });
          let recovered = false;
          if (debug.landedOn === 'session_expired' || debug.landedOn === 'login') {
            // 再ログイン (storageState は破棄してまっさらに)
            clearStorageState(ssPath);
            const lr = await tryLogin(page, { ...creds, slow: true }).catch(() => ({ status: 'failed' }));
            if (lr.status === 'ok') {
              await saveStorageState(ctx, ssPath).catch(() => {});
            }
            recovered = lr.status === 'ok';
          } else {
            recovered = true;
          }
          if (recovered) {
            const re = await ensureStoreSelected(page, { salonId: creds.salonId ?? null, shopName }).catch(() => ({ ok: false }));
            if (re.ok) {
              await page.waitForTimeout(1000);
              ({ rows, debug } = await scrapeBookings(page, { baseUrl: creds.baseUrl, genre }));
            }
          }
        }
        // 予約一覧に到達できずログアウト/サロン選択へ飛ばされた場合は、
        // 「0件成功」ではなく明確な失敗として店舗を止める (誤った成功表示を防ぐ)。
        if (debug && debug.loggedOut) {
          // 取得不能なのに「0件成功」と表示しないよう、明確な失敗として店舗を止める。
          // ブラウザクローズ/ロック解除は外側の finally が行うのでここでは触らない。
          const reason =
            debug.landedOn === 'group_top'
              ? 'サロン選択後に予約一覧へ進めずサロン選択画面へ戻されました (グループ店舗のセッション維持に失敗)。'
              : '予約一覧に進む前にログアウトされました。';
          await markCredentialError(shopId, `bookings_logged_out: ${debug.landedOn}`, null, 'session_lost');
          emit('shop:end', { shopId, ok: false, error: reason, errorCode: 'session_lost' });
          await recordShopRun(runId, shopId, false, null, `bookings_logged_out: ${debug.landedOn}`, counts);
          return { ok: false, errorCode: 'session_lost' };
        }
        const sent = await sendBookings(shopId, rows);
        counts.bookings = sent;
        const skipNote =
          debug.skipped > 0 && debug.sampleSkipped?.length
            ? ` skip例:[${debug.sampleSkipped.slice(0, 2).join('|').slice(0, 200)}]`
            : '';
        const rangeNote = debug.range ? ` 範囲:${debug.range}` : '';
        const durNote = debug.durationFixed ? ` 終了時刻補正${debug.durationFixed}件` : '';
        summary.push(
          `予約 ${sent}/${rows.length}件 (検出${debug.itemsFound}${rangeNote}${durNote}${skipNote})`,
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
        // 美容室(hair)はスタッフ→スタイリスト一覧 (/CNB/draft/stylistList) に分岐。
        const staffLabel = genre === 'hair' ? 'スタイリスト' : 'スタッフ';
        emit('shop:progress', { shopId, step: 'staff', msg: `${staffLabel}一覧を取得中…` });
        const { rows, debug } = await scrapeStaff(page, { genre });
        const sent = await sendStaff(shopId, rows);
        counts.staff = sent;
        summary.push(`${staffLabel} ${sent} 件 (検出${rows.length})`);
        // v0.2.13: 診断ログを新仕様 (hidden input 起点) に対応
        emit('log', {
          level: 'info',
          msg:
            `[${shopId.slice(0, 8)}] staff scrape: ` +
            `parsed=${debug?.parsed ?? 0} sent=${sent} ` +
            `staffIdInputs=${debug?.staffIdInputs ?? 0} ` +
            `withoutPhotoRow=${debug?.withoutPhotoRow ?? 0} ` +
            `nameCollision=${debug?.nameCollisionCount ?? 0}`,
          at: new Date().toISOString(),
        });
        emit('shop:progress', { shopId, step: 'staff', msg: `${staffLabel} ${sent} 件保存` });
      } catch (e) {
        emit('log', {
          level: 'warn',
          msg: `[${shopId.slice(0, 8)}] staff scrape error: ${e instanceof Error ? e.message : e}`,
          at: new Date().toISOString(),
        });
      }
    }

    if (channelSet.has('menus')) {
      try {
        // 美容室(hair)はメニュー→スタイル一覧 (/CNB/draft/styleList) に分岐。
        const menuLabel = genre === 'hair' ? 'スタイル' : 'メニュー';
        emit('shop:progress', { shopId, step: 'menus', msg: `${menuLabel}一覧を取得中…` });
        const { rows, debug } = await scrapeMenus(page, { genre });
        const sent = await sendMenus(shopId, rows);
        counts.menus = sent;
        summary.push(`${menuLabel} ${sent} 件 (検出${debug?.itemsFound ?? rows.length})`);
        emit('shop:progress', { shopId, step: 'menus', msg: `${menuLabel} ${sent} 件保存` });
      } catch (e) {
        emit('log', {
          level: 'warn',
          msg: `[${shopId.slice(0, 8)}] menu scrape error: ${e instanceof Error ? e.message : e}`,
          at: new Date().toISOString(),
        });
      }
    }

    if (channelSet.has('coupons')) {
      try {
        emit('shop:progress', { shopId, step: 'coupons', msg: 'クーポン一覧を取得中…' });
        const { rows, debug } = await scrapeCoupons(page);
        // 診断ログ: 0 件のとき原因切り分けに使う (到達URL・検出数・詳細取得数)
        emit('log', {
          level: debug?.itemsFound ? 'info' : 'warn',
          msg: `[${shopId.slice(0, 8)}] coupon scrape: 検出${debug?.itemsFound ?? 0}件 / 詳細取得 ${debug?.detailOk ?? 0}成功 ${debug?.detailFail ?? 0}失敗 / couponId hidden=${debug?.fieldsTotal ?? 0} / 写真=${debug?.couponImgCount ?? 0} / url=${debug?.url ?? '?'}`,
          at: new Date().toISOString(),
        });
        const sent = await sendCoupons(shopId, rows);
        counts.coupons = sent;
        summary.push(`クーポン ${sent} 件 (検出${debug?.itemsFound ?? rows.length})`);
        emit('shop:progress', { shopId, step: 'coupons', msg: `クーポン ${sent} 件保存` });
      } catch (e) {
        emit('log', {
          level: 'warn',
          msg: `[${shopId.slice(0, 8)}] coupon scrape error: ${e instanceof Error ? e.message : e}`,
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
async function isLoggedIn(page, baseUrl, genre) {
  // 管理画面 TOP を開いてセッション有効性を確認する。
  // ここで KPCL018V01 等のエラー / ログイン画面に飛ばされたら needs_login。
  //
  // ジャンルで TOP URL が異なる:
  //   - 美容室(hair): /CLP/bt/top/  (KLP系を先に開くと毎回再ログインを誘発する)
  //   - エステ等     : /KLP/top/    (従来どおり。銀座店などはこれで動いている)
  const candidates = (
    genre === 'hair'
      ? ['/CLP/bt/top/', '/CLP/', '/KLP/top/']
      : ['/KLP/top/', '/KLP/', '/CNF/']
  )
    .map((p) => safeUrl(p, baseUrl))
    .concat([baseUrl])
    .filter(Boolean);
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

    // セッション切れ / エラー画面の検出。
    // SalonBoard のセッション切れは title="SALON BOARD : エラー"、本文に
    // 「一定時間操作されなかったため、ログインの有効期限が切れました。
    //   再度ログインしなおしてください。」「ログインへ」というリンクが出る。
    // パスワード欄が無く URL も /login じゃないので、本文/タイトルで判定する。
    // (旧実装は「再ログイン|ログインしてください」しか見ておらず、この文言を取り逃していた)
    const expired = await page.evaluate(() => {
      const title = document.title || '';
      const body = (document.body?.innerText || '').replace(/\s+/g, '');
      const hasLoginLink = Array.from(document.querySelectorAll('a')).some((a) =>
        /ログインへ|ログイン画面/.test(a.textContent || ''),
      );
      const errorTitle = /エラー|ERROR/i.test(title);
      const expiredText =
        /有効期限が切れ|有効期限切れ|再度ログイン|ログインしなおし|再ログイン|セッション|タイムアウト|ログインしてください|操作されなかった|ログインTOP画面より再度やり直して|エラーが発生しました/.test(
          body,
        );
      // SalonBoard のセッション/認証エラーコード (KPCL018V01 等) を検出。
      // 「KPCL018V01」「KPCL017V01」などが本文に出たら未ログイン扱いにする。
      const errorCode = /KPCL\d{3}V\d{2}/.test(body);
      // 「予約一覧/管理画面に居る」と言えるための前向きな手がかり (どれも無ければ不確実)
      const looksLikeApp =
        !!document.getElementById('resultList') ||
        document.querySelectorAll('input, select, textarea').length > 0 ||
        /予約|スタッフ|シフト|メニュー|売上|店舗/.test(body);
      return { errorTitle, expiredText, errorCode, hasLoginLink, looksLikeApp };
    });
    // KPCL系エラーコード / セッション切れ文言 / (エラー画面+ログイン導線) なら再ログイン。
    if (expired.errorCode || expired.expiredText || (expired.errorTitle && expired.hasLoginLink)) {
      return 'needs_login';
    }
    // エラー画面でなくても、管理画面らしさが全く無ければ未ログイン扱い (安全側)
    if (!expired.looksLikeApp) return 'needs_login';
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

/**
 * グループ店舗(1ログインで複数サロン)対応。
 *
 * SalonBoard は 1 アカウントで複数サロンを持つ場合、ログイン後に
 * /CNC/groupTop/ の「サロン選択」画面に着地する。各サロンは
 *   <table id="biyouStoreInfoArea|kireiStoreInfoArea"> 内の
 *   <td>H000650996</td> <td class="storeName"><a id="H000650996">サロン名</a></td>
 * で並ぶ。対象サロンの <a id="H000..."> をクリックしてその店舗文脈に入る。
 *
 * - 単一店舗ログイン (groupTop に着地しない) は何もしない (ok:true, selected:false)。
 * - groupTop 検知時:
 *     salonId 指定あり → その id のリンクをクリック。
 *     salonId 未指定   → shopName と最も近いサロン名を選ぶ (フォールバック)。
 *     どちらも特定不能 → ok:false (呼び出し側で manual_required に倒す)。
 *
 * @param {{salonId?: string|null, shopName?: string|null}} opts
 * @returns {Promise<{ok: boolean, selected: boolean, reason?: string, salonId?: string}>}
 */
async function ensureStoreSelected(page, opts = {}) {
  const salonId = (opts.salonId || '').trim().toUpperCase();
  const shopName = (opts.shopName || '').trim();

  // 現在 groupTop (サロン選択) に居るか判定。URL か、店舗一覧テーブルの存在で見る。
  let onGroupTop = /\/CNC\/groupTop/i.test(page.url());
  if (!onGroupTop) {
    onGroupTop = await page
      .locator('#biyouStoreInfoArea, #kireiStoreInfoArea, table.mod_table19 a[id^="H"]')
      .first()
      .count()
      .then((n) => n > 0)
      .catch(() => false);
  }
  if (!onGroupTop) {
    // 単一店舗ログイン: サロン選択は不要。
    return { ok: true, selected: false };
  }

  // サロン一覧を抽出 (id=H... と表示名)。
  const stores = await page.evaluate(() => {
    const norm = (s) => (s || '').replace(/\s+/g, '').trim();
    const out = [];
    const links = Array.from(document.querySelectorAll('a[id^="H"]'));
    for (const a of links) {
      const id = (a.getAttribute('id') || '').trim();
      if (!/^H\d{6,}$/i.test(id)) continue;
      out.push({ id: id.toUpperCase(), name: norm(a.textContent) });
    }
    return out;
  });

  if (!stores.length) {
    return { ok: false, selected: false, reason: 'group_top_no_stores' };
  }

  // 対象サロンを決定。
  let target = null;
  if (salonId) {
    target = stores.find((s) => s.id === salonId) || null;
    if (!target) {
      return { ok: false, selected: false, reason: `salon_id_not_in_group(${salonId})` };
    }
  } else if (shopName) {
    // salon_id 未設定 → 店舗名の部分一致でフォールバック。
    const want = shopName.replace(/\s+/g, '');
    target =
      stores.find((s) => s.name && (s.name === want || s.name.includes(want) || want.includes(s.name))) ||
      null;
    if (!target) {
      return { ok: false, selected: false, reason: 'group_top_name_unmatched' };
    }
  } else {
    return { ok: false, selected: false, reason: 'group_top_no_target' };
  }

  // 対象サロンのリンクをクリックして店舗文脈に入る。
  // salon ID は "H" + 数字なので属性セレクタで安全に指定できる。
  try {
    await Promise.all([
      page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {}),
      page.locator(`a[id="${target.id}"]`).first().click({ timeout: 8_000 }),
    ]);
    await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => {});
  } catch (e2) {
    return { ok: false, selected: false, reason: `store_click_failed: ${e2?.message ?? e2}`, salonId: target.id };
  }

  // クリック後もまだ groupTop に居る場合は失敗扱い。
  const stillGroup = /\/CNC\/groupTop/i.test(page.url());
  if (stillGroup) {
    return { ok: false, selected: false, reason: 'still_on_group_top', salonId: target.id };
  }

  // サロン選択は POST → サーバー側でアクティブ店舗セッションを確定 → リダイレクト、
  // という流れのため、直後に別 URL へ goto するとセッション確定前で
  // ログアウト/サロン選択に戻されることがある。少し待ってセッションを安定させる。
  await page.waitForTimeout(1200);

  return { ok: true, selected: true, salonId: target.id, topUrl: page.url() };
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
    .locator('input[name="userId"], input[name="loginId"], input[name="loginCd"], input[id*="login" i], input[type="email"], input[type="text"]:visible')
    .first();
  const pwInput = page
    .locator('input[name="password"], input[type="password"]')
    .first();

  // ID 欄の出現を明示的に待つ (headless で描画が遅い/別物のケースに備える)。
  await idInput.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});

  // slow モード: 人間らしくゆっくり・1文字ずつ。ただし pressSequentially が失敗したら
  // fill() にフォールバックする (headless で 1文字入力がタイムアウトしてもログインを通す)。
  const slow = !!(c && c.slow);
  const wait = (ms) => page.waitForTimeout(ms).catch(() => {});
  const typeInto = async (loc, value) => {
    const v = String(value ?? '');
    if (slow) {
      await loc.click({ timeout: 8_000 }).catch(() => {});
      await wait(500);
      try {
        await loc.pressSequentially(v, { delay: 120, timeout: 8_000 });
        // 入力が反映されたか確認。空ならフォールバック。
        const got = await loc.inputValue().catch(() => '');
        if (got && got.length >= Math.min(v.length, 1)) return true;
      } catch (_e) { /* fallthrough to fill */ }
    }
    // 通常 / フォールバック: fill で確実に入れる
    try {
      await loc.fill(v, { timeout: 8_000 });
      return true;
    } catch (_e) {
      return false;
    }
  };
  const okId = await typeInto(idInput, c.loginId);
  if (slow) await wait(600);
  const okPw = await typeInto(pwInput, c.password);
  if (!okId || !okPw) {
    return {
      status: 'failed',
      reason: `cannot find login inputs (id=${okId}, pw=${okPw})`,
    };
  }

  // slow モードでは「入力し終わって少し待ってからログインを押す」挙動にする。
  if (slow) await wait(1000);

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
  // ログイン直後にセッション切れ/エラー画面に居ないか確認 (誤って成功扱いしない)。
  try {
    const errPage = await page.evaluate(() => {
      const title = document.title || '';
      const body = (document.body?.innerText || '').replace(/\s+/g, '');
      return (
        /エラー|ERROR/i.test(title) &&
        /有効期限|再度ログイン|ログインしなおし|操作されなかった/.test(body)
      );
    });
    if (errPage) {
      return { status: 'failed', reason: 'landed on session-expired/error page after login' };
    }
  } catch (_e) {
    /* 判定失敗は成功扱いを妨げない */
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

async function sendMenus(shopId, rows) {
  if (!rows || rows.length === 0) return 0;
  const valid = rows.filter((r) => r.external_id && r.name);
  if (valid.length === 0) return 0;
  const { error } = await supabase.rpc('salonboard_bulk_upsert_menus', {
    p_shop_id: shopId,
    p_rows: valid,
  });
  if (error) {
    emit('log', {
      level: 'error',
      msg: `bulk_upsert_menus: ${error.message}`,
      at: new Date().toISOString(),
    });
    return 0;
  }
  return valid.length;
}

async function sendCoupons(shopId, rows) {
  if (!rows || rows.length === 0) return 0;
  const valid = rows.filter((r) => r.external_id && r.name);
  if (valid.length === 0) return 0;
  const { error } = await supabase.rpc('salonboard_bulk_upsert_coupons', {
    p_shop_id: shopId,
    p_rows: valid,
  });
  if (error) {
    emit('log', {
      level: 'error',
      msg: `bulk_upsert_coupons: ${error.message}`,
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

/**
 * push_booking ジョブを Admin の /api/salonboard/jobs から claim して実行する。
 * 各ジョブは shop_id + credentials + payload を含む。ブラウザを起動しログイン後、
 * pushBookingViaForm で登録フォームを操作し、/api/salonboard/callback に結果を返す。
 *
 * 実登録 (登録ボタンを押す) は enablePush=true のときだけ。false の間は入力まで
 * 進めて confirm_only → callback で manual_required に倒す (誤登録防止)。
 *
 * @param showBrowser ブラウザ画面を表示するか
 */
async function runPushJobs({ showBrowser } = {}) {
  // 二重起動防止 (Realtime トリガーと自動同期が重なってもブラウザを二重に立てない)
  if (pushJobsRunning) {
    log('予約書き込み: 既に処理中のためスキップ', 'info');
    return;
  }
  const headers = buildDeviceHeaders();
  if (!headers) {
    log('予約書き込み: 認証情報が未設定のためスキップしました', 'warn');
    return;
  }
  pushJobsRunning = true;
  try {
  const enablePush = !!deviceAuth.enablePush;
  // 開始を必ずログに出す (ユーザーが「実行されたか」を確認できるように)。
  log(
    `予約書き込み(push_booking)チェック開始 — 実登録(SalonBoardへ書込)=${enablePush ? 'ON' : 'OFF (確認のみ)'}`,
    'info',
  );
  const MAX_BATCHES = 30; // バッチ取得の最大回数 (暴走防止)
  let processed = 0;
  let drainedOther = 0;

  // 1 ジョブを処理する (ブラウザ起動→ログイン→種別分岐→close)。
  // 店舗ごとに直列、店舗間は並列で呼ばれる。
  const runOne = async (job) => {
    const payload = job.payload || {};
    const creds = job.credentials || {};
    const baseUrl = creds.base_url || 'https://salonboard.com/';
    const tag = `push ${String(job.id).slice(0, 8)} booking=${String(payload.booking_id || '').slice(0, 8)}`;
    emit('log', { level: 'info', msg: `[${tag}] 開始 (enablePush=${enablePush})`, at: new Date().toISOString() });

    let browser = null;
    try {
      const pushArgs = [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-features=IsolateOrigins,site-per-process',
      ];
      try {
        browser = await chromium.launch({ headless: !showBrowser, slowMo: showBrowser ? 250 : 0, args: pushArgs });
      } catch (e) {
        // 完全版 Chromium が無い等で headed 起動に失敗したら headless で続行
        browser = await chromium.launch({ headless: true, args: pushArgs });
      }
      const ssPath = storageStatePathFor(job.shop_id);
      const ctx = await browser.newContext({
        ...(readStorageStatePath(ssPath) ? { storageState: readStorageStatePath(ssPath) } : {}),
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
        locale: 'ja-JP',
        timezoneId: 'Asia/Tokyo',
        viewport: { width: 1366, height: 900 },
      });
      const page = await ctx.newPage();

      // ログイン (セッション切れなら再ログイン)
      let auth = await isLoggedIn(page, baseUrl);
      if (auth === 'captcha') {
        await postCallback({
          job_id: job.id, status: 'captcha_detected', booking_id: payload.booking_id,
          error_code: 'RECAPTCHA_REQUIRED', error: 'captcha at landing', manual_required: true,
        });
        await browser.close().catch(() => {});
        return;
      }
      if (auth !== 'logged_in') {
        // 書き込み(push_booking)時もゆっくりログイン (bot 検知回避)。
        const lr = await tryLogin(page, { baseUrl: new URL('/login/', baseUrl).toString(), loginId: creds.login_id, password: creds.password, slow: true });
        if (lr.status === 'captcha') {
          await postCallback({ job_id: job.id, status: 'captcha_detected', booking_id: payload.booking_id, error_code: 'RECAPTCHA_REQUIRED', error: 'captcha at login', manual_required: true });
          await browser.close().catch(() => {});
          return;
        }
        if (lr.status === 'failed') {
          await postCallback({ job_id: job.id, status: 'login_required', booking_id: payload.booking_id, error_code: 'LOGIN_FAILED', error: lr.reason || 'login failed', manual_required: true });
          await browser.close().catch(() => {});
          return;
        }
        await saveStorageState(ctx, ssPath);
      }

      // グループ店舗(1ログイン複数サロン): /CNC/groupTop/ に着地したら対象サロンを選択。
      // 単一店舗ログインなら no-op。失敗時は誤店舗への書き込みを避けて manual_required。
      try {
        const sel = await ensureStoreSelected(page, {
          salonId: creds.salon_id ?? null,
          shopName: job.shop_name ?? null,
        });
        if (!sel.ok) {
          await postCallback({
            job_id: job.id, job_type: job.job_type, status: 'manual_required',
            booking_id: payload.booking_id, content_post_id: payload.content_post_id ?? null,
            error_code: 'STORE_SELECT_REQUIRED',
            error: `グループ店舗のサロン選択に失敗 (${sel.reason ?? 'unknown'})。店舗のSalonBoard設定でサロンID(H...)を登録してください。`,
            manual_required: true,
          });
          emit('log', { level: 'warn', msg: `[${tag}] 🟡 サロン選択失敗: ${sel.reason}`, at: new Date().toISOString() });
          await browser.close().catch(() => {});
          return;
        }
        if (sel.selected) {
          emit('log', { level: 'info', msg: `[${tag}] サロン選択: ${sel.salonId ?? ''}`, at: new Date().toISOString() });
        }
      } catch (e) {
        emit('log', { level: 'warn', msg: `[${tag}] store-select error: ${e?.message ?? e}`, at: new Date().toISOString() });
      }

      // ジョブ種別で分岐: push_blog=ブログ投稿 / delete_blog=ブログ削除 /
      // push_photo_gallery=フォトギャラリー投稿 /
      // cancel_booking=キャンセル / push_booking(action=update)=変更 / それ以外=新規登録
      const isBlog = job.job_type === 'push_blog';
      const isBlogDelete = job.job_type === 'delete_blog';
      const isPhotoGallery = job.job_type === 'push_photo_gallery';
      const isCancel = job.job_type === 'cancel_booking';
      const isUpdate = job.job_type === 'push_booking' && payload.action === 'update';

      const cap = job.max_attempts || 3;
      const exhausted = (job.attempts || 0) + 1 >= cap;

      if (isBlogDelete) {
        // ---- ブログ削除 ----
        const result = await deleteBlogViaForm(page, payload, { baseUrl, enableDelete: enablePush });
        if (result.status === 'ok') {
          await postCallback({
            job_id: job.id, job_type: 'delete_blog', status: 'succeeded',
            content_post_id: payload.content_post_id ?? null,
            external_id: result.externalId ?? payload.external_blog_id ?? null,
            summary: result.alreadyAbsent ? 'delete_blog 完了 (既にSB上に無し)' : 'delete_blog 完了',
          });
          emit('log', { level: 'info', msg: `[${tag}] ✅ SalonBoard ブログ削除完了${result.alreadyAbsent ? ' (既に無し)' : ''}`, at: new Date().toISOString() });
        } else if (result.status === 'confirm_only') {
          await postCallback({
            job_id: job.id, job_type: 'delete_blog', status: 'manual_required',
            content_post_id: payload.content_post_id ?? null, error_code: 'PUSH_DISABLED',
            error: '削除対象を検出しましたが、実登録(実書込)が無効のため削除していません。設定で有効化してください。',
            manual_required: true,
          });
          emit('log', { level: 'warn', msg: `[${tag}] 🟡 ブログ削除未実行 (実登録OFF)`, at: new Date().toISOString() });
        } else {
          const toManual = result.manualRequired || exhausted;
          await postCallback({
            job_id: job.id, job_type: 'delete_blog',
            status: result.errorCode === 'RECAPTCHA_REQUIRED' ? 'captcha_detected' : toManual ? 'manual_required' : 'retryable_failed',
            content_post_id: payload.content_post_id ?? null, error_code: result.errorCode, error: result.reason, manual_required: toManual,
          });
          emit('log', { level: 'warn', msg: `[${tag}] 🔴 ブログ削除失敗: [${result.errorCode}] ${result.reason}`, at: new Date().toISOString() });
        }
      } else if (isBlog) {
        // ---- ブログ投稿 ----
        const result = await postBlogViaForm(page, payload, { baseUrl, enablePost: enablePush });
        if (result.status === 'ok') {
          await postCallback({
            job_id: job.id, job_type: 'push_blog', status: 'succeeded',
            content_post_id: payload.content_post_id ?? null,
            external_id: result.externalId ?? null,
            summary: 'push_blog 投稿完了',
          });
          emit('log', { level: 'info', msg: `[${tag}] ✅ ブログ投稿完了${result.externalId ? ` (id=${result.externalId})` : ''}`, at: new Date().toISOString() });
        } else if (result.status === 'confirm_only') {
          await postCallback({
            job_id: job.id, job_type: 'push_blog', status: 'manual_required',
            content_post_id: payload.content_post_id ?? null,
            error_code: 'PUSH_DISABLED', error: '入力まで成功しましたが、実登録(実書込)が無効のため投稿していません。設定で有効化してください。', manual_required: true,
          });
          emit('log', { level: 'warn', msg: `[${tag}] 🟡 ブログ入力のみ (実登録OFF)`, at: new Date().toISOString() });
        } else {
          const toManual = result.manualRequired || exhausted;
          await postCallback({
            job_id: job.id, job_type: 'push_blog',
            status: result.errorCode === 'RECAPTCHA_REQUIRED' ? 'captcha_detected' : toManual ? 'manual_required' : 'retryable_failed',
            content_post_id: payload.content_post_id ?? null,
            error_code: result.errorCode, error: result.reason, manual_required: toManual,
          });
          emit('log', { level: 'warn', msg: `[${tag}] ブログ: ${result.reason}`, at: new Date().toISOString() });
        }
      } else if (isPhotoGallery) {
        // ---- フォトギャラリー投稿 (エステ=photoGalleryEdit / 美容室=スタイル[保留]) ----
        const result = await postPhotoGalleryViaForm(page, payload, { baseUrl, enablePost: enablePush });
        if (result.status === 'ok') {
          await postCallback({
            job_id: job.id, job_type: 'push_photo_gallery', status: 'succeeded',
            content_post_id: null,
            external_id: result.externalId ?? null,
            summary: 'push_photo_gallery 投稿完了',
          });
          emit('log', { level: 'info', msg: `[${tag}] ✅ フォトギャラリー投稿完了${result.externalId ? ` (id=${result.externalId})` : ''}`, at: new Date().toISOString() });
        } else if (result.status === 'confirm_only') {
          await postCallback({
            job_id: job.id, job_type: 'push_photo_gallery', status: 'manual_required',
            error_code: 'PUSH_DISABLED',
            error: '入力まで成功しましたが、実登録(実書込)が無効のため投稿していません。設定で有効化してください。',
            manual_required: true,
          });
          emit('log', { level: 'warn', msg: `[${tag}] 🟡 フォトギャラリー入力のみ (実登録OFF)`, at: new Date().toISOString() });
        } else {
          const toManual = result.manualRequired || exhausted;
          await postCallback({
            job_id: job.id, job_type: 'push_photo_gallery',
            status: result.errorCode === 'RECAPTCHA_REQUIRED' ? 'captcha_detected' : toManual ? 'manual_required' : 'retryable_failed',
            error_code: result.errorCode, error: result.reason, manual_required: toManual,
          });
          emit('log', { level: 'warn', msg: `[${tag}] フォトギャラリー: ${result.reason}`, at: new Date().toISOString() });
        }
      } else if (isCancel) {
        // ---- キャンセル ----
        const result = await cancelBookingViaForm(page, payload, { baseUrl, enableCancel: enablePush });
        if (result.status === 'ok') {
          await postCallback({
            job_id: job.id, job_type: 'cancel_booking', status: 'succeeded',
            booking_id: payload.booking_id, summary: 'cancel_booking 完了',
          });
          emit('log', { level: 'info', msg: `[${tag}] ✅ SalonBoard キャンセル完了`, at: new Date().toISOString() });
        } else if (result.status === 'confirm_only') {
          await postCallback({
            job_id: job.id, job_type: 'cancel_booking', status: 'manual_required',
            booking_id: payload.booking_id, error_code: 'PUSH_DISABLED',
            error: 'キャンセル操作まで到達しましたが、実登録(実書込)が無効のため確定していません。設定で有効化してください。',
            manual_required: true,
          });
          emit('log', { level: 'warn', msg: `[${tag}] 🟡 キャンセル未確定 (実登録OFF)`, at: new Date().toISOString() });
        } else {
          const toManual = result.manualRequired || exhausted;
          await postCallback({
            job_id: job.id, job_type: 'cancel_booking',
            status: result.errorCode === 'RECAPTCHA_REQUIRED' ? 'captcha_detected' : toManual ? 'manual_required' : 'retryable_failed',
            booking_id: payload.booking_id, error_code: result.errorCode, error: result.reason, manual_required: toManual,
          });
          emit('log', { level: 'warn', msg: `[${tag}] 🔴 キャンセル失敗: [${result.errorCode}] ${result.reason}`, at: new Date().toISOString() });
        }
      } else if (isUpdate) {
        // ---- 変更 (時間/所要/担当) ----
        const result = await changeBookingViaForm(page, payload, { baseUrl, enableChange: enablePush });
        if (result.status === 'ok') {
          await postCallback({
            job_id: job.id, job_type: 'push_booking', status: 'succeeded',
            booking_id: payload.booking_id, external_booking_id: payload.external_booking_id ?? null,
            summary: 'push_booking(変更) 完了',
          });
          emit('log', { level: 'info', msg: `[${tag}] ✅ SalonBoard 変更完了`, at: new Date().toISOString() });
          emit('push:done', { bookingId: payload.booking_id, ok: true });
        } else if (result.status === 'confirm_only') {
          await postCallback({
            job_id: job.id, job_type: 'push_booking', status: 'manual_required',
            booking_id: payload.booking_id, error_code: 'PUSH_DISABLED',
            error: '変更入力まで到達しましたが、実登録(実書込)が無効のため確定していません。', manual_required: true,
          });
          emit('log', { level: 'warn', msg: `[${tag}] 🟡 変更未確定 (実登録OFF)`, at: new Date().toISOString() });
        } else {
          const toManual = result.manualRequired || exhausted;
          await postCallback({
            job_id: job.id, job_type: 'push_booking',
            status: result.errorCode === 'RECAPTCHA_REQUIRED' ? 'captcha_detected' : toManual ? 'manual_required' : 'retryable_failed',
            booking_id: payload.booking_id, error_code: result.errorCode, error: result.reason, manual_required: toManual,
          });
          emit('log', { level: 'warn', msg: `[${tag}] 🔴 変更失敗: [${result.errorCode}] ${result.reason}`, at: new Date().toISOString() });
        }
      } else {
        // ---- 新規登録 ----
        const result = await pushBookingViaForm(page, payload, { baseUrl, enablePush });
        if (result.status === 'ok') {
          await postCallback({
            job_id: job.id, job_type: 'push_booking', status: 'succeeded',
            booking_id: payload.booking_id,
            external_booking_id: result.externalId ?? null,
            salonboard_detail_url: result.detailUrl ?? null,
            result_payload: result.confirmed,
            summary: `push_booking 登録完了 (external_id=${result.externalId ?? '?'})`,
          });
          emit('log', { level: 'info', msg: `[${tag}] ✅ 登録完了 external_id=${result.externalId ?? '?'}${result.confirmed?.equip_assigned ? ` / 設備:${result.confirmed.equip_assigned}` : ''}`, at: new Date().toISOString() });
          emit('push:done', { bookingId: payload.booking_id, ok: true, externalId: result.externalId ?? null, detailUrl: result.detailUrl ?? null });
        } else if (result.status === 'confirm_only') {
          await postCallback({
            job_id: job.id, job_type: 'push_booking', status: 'manual_required',
            booking_id: payload.booking_id, error_code: 'PUSH_DISABLED',
            error: '入力まで成功しましたが、実登録 (SALONBOARD_ENABLE_PUSH) が無効のため登録ボタンを押していません。設定で有効化してください。',
            manual_required: true, result_payload: result.confirmed,
          });
          emit('log', { level: 'warn', msg: `[${tag}] 🟡 入力のみ (実登録OFF)`, at: new Date().toISOString() });
          emit('push:done', { bookingId: payload.booking_id, ok: false, reason: 'push_disabled' });
        } else {
          const toManual = result.manualRequired || exhausted;
          const isCaptcha = result.errorCode === 'RECAPTCHA_REQUIRED';
          await postCallback({
            job_id: job.id, job_type: 'push_booking',
            status: isCaptcha ? 'captcha_detected' : toManual ? 'manual_required' : 'retryable_failed',
            booking_id: payload.booking_id, error_code: result.errorCode, error: result.reason,
            manual_required: toManual,
          });
          emit('log', { level: 'warn', msg: `[${tag}] 🔴 失敗: [${result.errorCode}] ${result.reason}`, at: new Date().toISOString() });
          emit('push:done', { bookingId: payload.booking_id, ok: false, reason: result.reason, errorCode: result.errorCode });
        }
      }
      await browser.close().catch(() => {});
      processed++;
    } catch (e) {
      log(`push: job ${String(job.id).slice(0, 8)} 例外: ${e?.message ?? e}`, 'error');
      try {
        await postCallback({
          job_id: job.id, job_type: 'push_booking', status: 'retryable_failed',
          booking_id: payload.booking_id, error_code: 'UNKNOWN_ERROR',
          error: `worker exception: ${e?.message ?? e}`, manual_required: false,
        });
      } catch (_e) { /* ignore */ }
      await browser?.close().catch(() => {});
    }
  };

  // バッチで claim → 店舗ごとにグループ化 → 店舗グループを並列実行
  // (同一店舗内は直列。全店舗が別ログインIDなので店舗間並列は安全)。
  // claim は最大5件/回。並列度は claim 件数と店舗数で自然に最大5に収まる。
  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    if (abortRequested) break;
    let claimedJobs = [];
    try {
      const res = await fetch(`${deviceAuth.apiBaseUrl}/api/salonboard/jobs?limit=5`, {
        method: 'GET',
        headers,
      });
      if (!res.ok) {
        log(`予約書き込み: ジョブ取得失敗 ${res.status}`, 'warn');
        break;
      }
      const json = await res.json();
      claimedJobs = Array.isArray(json.jobs) ? json.jobs : [];
    } catch (e) {
      log(`予約書き込み: ジョブ取得エラー: ${e?.message ?? e}`, 'warn');
      break;
    }
    if (claimedJobs.length === 0) break; // キューが空

    // 扱わない種別は整理して除外。push_booking / cancel_booking / push_blog / delete_blog / push_photo_gallery を処理する。
    const handled = [];
    for (const j of claimedJobs) {
      if (j.job_type !== 'push_booking' && j.job_type !== 'cancel_booking' && j.job_type !== 'push_blog' && j.job_type !== 'delete_blog' && j.job_type !== 'push_photo_gallery') {
        await postCallback({ job_id: j.id, status: 'cancelled', error: `worker (desktop) は ${j.job_type} を処理しません` });
        drainedOther++;
      } else {
        handled.push(j);
      }
    }
    if (handled.length === 0) continue;

    // 店舗ごとにグループ化
    const byShop = new Map();
    for (const j of handled) {
      const sid = j.shop_id || 'unknown';
      if (!byShop.has(sid)) byShop.set(sid, []);
      byShop.get(sid).push(j);
    }
    if (byShop.size > 1) {
      log(`予約書き込み: ${byShop.size} 店舗を並列処理 (各店舗内は直列)`, 'info');
    }

    // 各店舗グループ: グループ内は直列、グループ同士は並列
    await Promise.all(
      Array.from(byShop.values()).map(async (jobsForShop) => {
        for (const job of jobsForShop) {
          if (abortRequested) break;
          await runOne(job);
        }
      }),
    );
  }
  // 終了サマリを必ず出す (0件でも「実行されたが対象なし」が分かるように)。
  log(
    `予約書き込みチェック完了 — 書込ジョブ処理 ${processed} 件` +
      (drainedOther > 0 ? ` / 対象外ジョブ整理 ${drainedOther} 件 (cancel等)` : '') +
      (processed === 0 && drainedOther === 0 ? ' (キューに対象なし)' : ''),
    'info',
  );
  } finally {
    pushJobsRunning = false;
  }
}

/** /api/salonboard/callback に結果を POST する。 */
async function postCallback(body) {
  const headers = buildDeviceHeaders({ 'Content-Type': 'application/json' });
  if (!headers) return;
  try {
    const res = await fetch(`${deviceAuth.apiBaseUrl}/api/salonboard/callback`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      log(`callback non-2xx: ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`, 'warn');
    }
  } catch (e) {
    log(`callback error: ${e?.message ?? e}`, 'warn');
  }
}

async function runSync({ shopIds, channels, source, showBrowser, enablePush }) {
  if (running) {
    const elapsed = Date.now() - runStartedAt;
    if (elapsed < RUN_STALE_MS) {
      emit('error', {
        msg: `同期は既に実行中です (経過 ${Math.round(elapsed / 1000)} 秒)。完了までお待ちください。`,
      });
      return;
    }
    // stale: 前回の同期がハングしたまま running が残っている → 強制的に奪取して継続。
    emit('log', {
      level: 'warn',
      msg: `前回の同期が ${Math.round(elapsed / 60000)} 分以上応答していないため、ハングとみなして再実行します`,
      at: new Date().toISOString(),
    });
    abortRequested = true;
    await currentBrowser?.close().catch(() => {});
    currentBrowser = null;
  }
  // 同期ごとに渡される実登録トグルの最新値を反映 (init 後の変更も効く)。
  if (enablePush !== undefined && deviceAuth) {
    deviceAuth.enablePush = !!enablePush;
  }
  // 取得(同期)は常にブラウザ表示で実行する (AUTO_SYNC_SHOW_BROWSER)。
  // 呼び出し側 (毎時の自動取得など) が showBrowser を渡さなくても headful にする。
  const showBrowserEffective = AUTO_SYNC_SHOW_BROWSER || !!showBrowser;
  running = true;
  runStartedAt = Date.now();
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
      const r = await processShop(t, channels, runId, { showBrowser: showBrowserEffective });
      if (r.ok) okCount++; else ngCount++;
    }

    // スクレイピング後、KIREIDOT→SalonBoard の予約書き込み (push_booking) ジョブも処理。
    // 失敗してもスクレイピング結果には影響させない。
    if (!abortRequested) {
      try {
        await runPushJobs({ showBrowser: showBrowserEffective });
      } catch (e) {
        emit('log', { level: 'warn', msg: `push jobs error: ${e?.message ?? e}`, at: new Date().toISOString() });
      }
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
    runStartedAt = 0;
    abortRequested = false;
  }
}

// メッセージハンドリング
/**
 * 単発の予約書き込みテスト。ジョブキューを通さず、画面から渡された
 * shop/staff/menu/日時で直接 pushBookingViaForm を実行する。各ステップを
 * push:test イベントで返し、画面に表示する (制約テスト用)。
 *
 * payload: { shopId, staffExternalId, staffName, menuName, scheduledAt,
 *            durationMin, customerName, enablePush }
 */
async function runTestPush(payload) {
  const step = (s, extra = {}) => emit('push:test', { step: s, ...extra });
  const p = payload || {};
  // メニューは任意 (時間と内容だけで登録する)。必須は shop / staff / 日時。
  if (!p.shopId || !p.staffExternalId || !p.scheduledAt) {
    step('done', { ok: false, error: '必須項目が不足 (店舗・担当スタッフ・日時)' });
    return;
  }
  step('start', { msg: `開始: ${p.scheduledAt} staff=${p.staffExternalId} menu=${p.menuName || '(なし)'} 実登録=${p.enablePush ? 'ON' : 'OFF'}` });

  let creds;
  try {
    creds = await revealCredentials(p.shopId);
  } catch (e) {
    step('done', { ok: false, error: `認証情報の取得に失敗: ${e?.message ?? e}` });
    return;
  }
  // revealCredentials は { loginId, password, baseUrl } (camelCase) を返す。
  const baseUrl = creds.baseUrl || 'https://salonboard.com/login/';

  let browser = null;
  try {
    step('launch', { msg: 'ブラウザ起動 (画面表示)' });
    const launchArgs = ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-features=IsolateOrigins,site-per-process'];
    try {
      // テストは画面表示 (目視確認用)。各操作をゆっくり (slowMo 大きめ) にして
      // 動きが目で追えるようにする。完全版 Chromium が無ければ headless に自動フォールバック。
      browser = await chromium.launch({ headless: false, slowMo: 700, args: launchArgs });
    } catch (e) {
      step('launch', { msg: `画面表示の起動に失敗 (${e?.message?.split('\n')[0] ?? e})。headless で続行します` });
      browser = await chromium.launch({ headless: true, args: launchArgs });
    }
    const ssPath = storageStatePathFor(p.shopId);
    const ctx = await browser.newContext({
      ...(readStorageStatePath(ssPath) ? { storageState: readStorageStatePath(ssPath) } : {}),
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
      locale: 'ja-JP', timezoneId: 'Asia/Tokyo', viewport: { width: 1366, height: 900 },
    });
    const page = await ctx.newPage();

    step('login', { msg: 'ログイン確認中' });
    let auth = await isLoggedIn(page, baseUrl);
    if (auth === 'captcha') { step('done', { ok: false, error: 'reCAPTCHA が表示されました' }); await browser.close().catch(() => {}); return; }
    if (auth !== 'logged_in') {
      // creds は { loginId, password, baseUrl }。tryLogin はこの形をそのまま受け取る。
      // テストは slow:true で人間らしくゆっくり入力する。
      step('login', { msg: 'ID/パスワードをゆっくり入力中…' });
      const lr = await tryLogin(page, { ...creds, slow: true });
      if (lr.status !== 'ok') { step('done', { ok: false, error: `ログイン失敗: ${lr.reason || lr.status}` }); await browser.close().catch(() => {}); return; }
      await saveStorageState(ctx, ssPath);
    }
    step('login_ok', { msg: 'ログイン成功' });

    // 予約一覧からの挿入では本物の booking_id が来る。テストパネルからは未指定。
    const realBookingId = p.bookingId || null;
    step('form', { msg: '登録フォームを開いて入力中' });
    const result = await pushBookingViaForm(page, {
      booking_id: realBookingId || `test-${Date.now()}`,
      scheduled_at: p.scheduledAt,
      duration_min: p.durationMin || 60,
      salonboard_staff_external_id: p.staffExternalId,
      staff_name: p.staffName || null,
      salonboard_menu_name: p.menuName,
      customer_name: p.customerName || 'テスト 予約',
      notes: null,
      kireidot_ref: realBookingId ? `KIREIDOT予約ID: ${realBookingId}` : 'KIREIDOT予約ID: TEST',
    }, { baseUrl, enablePush: !!p.enablePush });

    if (result.status === 'ok') {
      // reserveId が取れたかどうかで synced 後の状態が変わる。
      // 取れない場合のみ「予約ID未取得」を last_push_error に残す (バッジがオレンジになる理由)。
      const gotId = !!result.externalId;
      // 本物の予約なら DB の同期状態を synced に更新 (バッジが「SB同期済み」になる)。
      if (realBookingId) {
        try {
          const patch = {
            salonboard_sync_status: 'synced',
            salonboard_detail_url: result.detailUrl ?? null,
            salonboard_pushed_at: new Date().toISOString(),
            salonboard_last_push_error: gotId ? null : 'SalonBoard 登録は成功したが予約ID(reserveId)を取得できませんでした',
            salonboard_staff_external_id: p.staffExternalId,
            salonboard_staff_name: p.staffName || null,
          };
          // 予約IDは取れたときだけ上書きする (取れないのに null で潰さない)
          if (gotId) patch.external_booking_id = result.externalId;
          await supabase.from('bookings').update(patch).eq('id', realBookingId);
        } catch (e) {
          log(`booking同期状態の更新に失敗: ${e?.message ?? e}`, 'warn');
        }
      }
      step('done', {
        ok: true,
        registered: true,
        bookingId: realBookingId,
        externalId: result.externalId ?? null,
        detailUrl: result.detailUrl ?? null,
        msg: (gotId
          ? `✅ 登録完了 external_id=${result.externalId}`
          : '✅ 登録完了 (ただし予約IDを取得できませんでした。次回の予約取得で補完されます)')
          + (result.confirmed?.equip_assigned ? ` / 設備: ${result.confirmed.equip_assigned}` : ''),
      });
    } else if (result.status === 'confirm_only') {
      const equipNote = result.confirmed?.equip_assigned ? ` / 設備: ${result.confirmed.equip_assigned}` : '';
      step('done', { ok: true, registered: false, msg: `🟡 入力まで成功 (実登録OFFのため登録ボタンは押していません)。ON にすると登録します。${equipNote}` });
    } else {
      step('done', { ok: false, errorCode: result.errorCode, error: `🔴 失敗: [${result.errorCode}] ${result.reason}` });
    }
    // 目視できるよう少し待ってから閉じる
    await page.waitForTimeout(3000).catch(() => {});
    await browser.close().catch(() => {});
  } catch (e) {
    step('done', { ok: false, error: `例外: ${e?.message ?? e}` });
    await browser?.close().catch(() => {});
  }
}

/**
 * 単発キャンセル。画面 (予約同期くん) からの直接実行。reserveId を使って
 * SalonBoard 上の予約をキャンセルし、成功したら DB を cancelled + cancelled_synced に。
 *
 * payload: { shopId, bookingId, externalBookingId(reserveId), scheduledAt,
 *            staffExternalId?, staffName?, enableCancel? }
 * 結果は cancel:test イベントで返す。
 */
async function runCancel(payload) {
  const step = (s, extra = {}) => emit('cancel:test', { step: s, ...extra });
  const p = payload || {};
  if (!p.shopId || !p.bookingId || !p.scheduledAt) {
    step('done', { ok: false, error: '必須項目が不足 (店舗・予約ID・日時)' });
    return;
  }
  if (!p.externalBookingId) {
    step('done', { ok: false, error: 'SalonBoard 予約ID (external_booking_id) が無いためキャンセル対象を特定できません。先に SalonBoard 連携 (synced) されている必要があります。' });
    return;
  }
  step('start', { msg: `キャンセル開始: reserveId=${p.externalBookingId}` });

  let creds;
  try {
    creds = await revealCredentials(p.shopId);
  } catch (e) {
    step('done', { ok: false, error: `認証情報の取得に失敗: ${e?.message ?? e}` });
    return;
  }
  const baseUrl = creds.baseUrl || 'https://salonboard.com/login/';

  let browser = null;
  try {
    step('launch', { msg: 'ブラウザ起動' });
    const launchArgs = ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-features=IsolateOrigins,site-per-process'];
    try {
      browser = await chromium.launch({ headless: false, slowMo: 500, args: launchArgs });
    } catch (_e) {
      browser = await chromium.launch({ headless: true, args: launchArgs });
    }
    const ssPath = storageStatePathFor(p.shopId);
    const ctx = await browser.newContext({
      ...(readStorageStatePath(ssPath) ? { storageState: readStorageStatePath(ssPath) } : {}),
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
      locale: 'ja-JP', timezoneId: 'Asia/Tokyo', viewport: { width: 1366, height: 900 },
    });
    const page = await ctx.newPage();

    step('login', { msg: 'ログイン確認中' });
    let auth = await isLoggedIn(page, baseUrl);
    if (auth === 'captcha') { step('done', { ok: false, error: 'reCAPTCHA が表示されました' }); await browser.close().catch(() => {}); return; }
    if (auth !== 'logged_in') {
      step('login', { msg: 'ID/パスワードをゆっくり入力中…' });
      const lr = await tryLogin(page, { ...creds, slow: true });
      if (lr.status !== 'ok') { step('done', { ok: false, error: `ログイン失敗: ${lr.reason || lr.status}` }); await browser.close().catch(() => {}); return; }
      await saveStorageState(ctx, ssPath);
    }
    step('login_ok', { msg: 'ログイン成功' });

    step('cancel', { msg: 'SalonBoard 上の予約をキャンセル中' });
    const result = await cancelBookingViaForm(page, {
      booking_id: p.bookingId,
      external_booking_id: p.externalBookingId,
      scheduled_at: p.scheduledAt,
      salonboard_staff_external_id: p.staffExternalId || null,
      staff_name: p.staffName || null,
    }, { baseUrl, enableCancel: p.enableCancel !== false });

    if (result.status === 'ok') {
      try {
        await supabase
          .from('bookings')
          .update({
            status: 'cancelled',
            salonboard_sync_status: 'cancelled_synced',
            salonboard_last_push_error: null,
            external_synced_at: new Date().toISOString(),
          })
          .eq('id', p.bookingId);
      } catch (e) {
        log(`booking キャンセル状態の更新に失敗: ${e?.message ?? e}`, 'warn');
      }
      step('done', { ok: true, msg: '✅ SalonBoard でキャンセルしました', bookingId: p.bookingId });
    } else if (result.status === 'confirm_only') {
      step('done', { ok: true, registered: false, msg: '🟡 キャンセルボタンまで到達 (実行OFF)。ON にするとキャンセルします。' });
    } else {
      step('done', { ok: false, errorCode: result.errorCode, error: `🔴 失敗: [${result.errorCode}] ${result.reason}` });
    }
    await page.waitForTimeout(2500).catch(() => {});
    await browser.close().catch(() => {});
  } catch (e) {
    step('done', { ok: false, error: `例外: ${e?.message ?? e}` });
    await browser?.close().catch(() => {});
  }
}

/**
 * 単発の予約変更。reserveId を使って SalonBoard 上の予約の時間/所要(・担当) を変更し、
 * 成功したら DB の external_synced_at を更新する (時間/担当は KIREIDOT が真とする)。
 *
 * payload: { shopId, bookingId, externalBookingId(reserveId), scheduledAt,
 *            durationMin?, staffExternalId?, staffName?, enableChange? }
 * 結果は change:test イベントで返す。
 */
async function runChange(payload) {
  const step = (s, extra = {}) => emit('change:test', { step: s, ...extra });
  const p = payload || {};
  if (!p.shopId || !p.bookingId || !p.scheduledAt) {
    step('done', { ok: false, error: '必須項目が不足 (店舗・予約ID・日時)' });
    return;
  }
  if (!p.externalBookingId) {
    step('done', { ok: false, error: 'SalonBoard 予約ID (external_booking_id) が無いため変更対象を特定できません。先に SalonBoard 連携 (synced) されている必要があります。' });
    return;
  }
  step('start', { msg: `変更開始: reserveId=${p.externalBookingId} → ${p.scheduledAt}` });

  let creds;
  try {
    creds = await revealCredentials(p.shopId);
  } catch (e) {
    step('done', { ok: false, error: `認証情報の取得に失敗: ${e?.message ?? e}` });
    return;
  }
  const baseUrl = creds.baseUrl || 'https://salonboard.com/login/';

  let browser = null;
  try {
    step('launch', { msg: 'ブラウザ起動' });
    const launchArgs = ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-features=IsolateOrigins,site-per-process'];
    try {
      browser = await chromium.launch({ headless: false, slowMo: 500, args: launchArgs });
    } catch (_e) {
      browser = await chromium.launch({ headless: true, args: launchArgs });
    }
    const ssPath = storageStatePathFor(p.shopId);
    const ctx = await browser.newContext({
      ...(readStorageStatePath(ssPath) ? { storageState: readStorageStatePath(ssPath) } : {}),
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
      locale: 'ja-JP', timezoneId: 'Asia/Tokyo', viewport: { width: 1366, height: 900 },
    });
    const page = await ctx.newPage();

    step('login', { msg: 'ログイン確認中' });
    let auth = await isLoggedIn(page, baseUrl);
    if (auth === 'captcha') { step('done', { ok: false, error: 'reCAPTCHA が表示されました' }); await browser.close().catch(() => {}); return; }
    if (auth !== 'logged_in') {
      step('login', { msg: 'ID/パスワードをゆっくり入力中…' });
      const lr = await tryLogin(page, { ...creds, slow: true });
      if (lr.status !== 'ok') { step('done', { ok: false, error: `ログイン失敗: ${lr.reason || lr.status}` }); await browser.close().catch(() => {}); return; }
      await saveStorageState(ctx, ssPath);
    }
    step('login_ok', { msg: 'ログイン成功' });

    step('change', { msg: 'SalonBoard 上の予約を変更中' });
    const result = await changeBookingViaForm(page, {
      booking_id: p.bookingId,
      external_booking_id: p.externalBookingId,
      scheduled_at: p.scheduledAt,
      duration_min: p.durationMin || 60,
      salonboard_staff_external_id: p.staffExternalId || null,
      staff_name: p.staffName || null,
    }, { baseUrl, enableChange: p.enableChange !== false });

    if (result.status === 'ok') {
      try {
        await supabase
          .from('bookings')
          .update({ external_synced_at: new Date().toISOString(), salonboard_last_push_error: null })
          .eq('id', p.bookingId);
      } catch (e) {
        log(`booking 変更同期の更新に失敗: ${e?.message ?? e}`, 'warn');
      }
      step('done', { ok: true, msg: '✅ SalonBoard で予約を変更しました', bookingId: p.bookingId });
    } else if (result.status === 'confirm_only') {
      step('done', { ok: true, registered: false, msg: '🟡 変更入力まで到達 (確定OFF)。' });
    } else {
      step('done', { ok: false, errorCode: result.errorCode, error: `🔴 失敗: [${result.errorCode}] ${result.reason}` });
    }
    await page.waitForTimeout(2500).catch(() => {});
    await browser.close().catch(() => {});
  } catch (e) {
    step('done', { ok: false, error: `例外: ${e?.message ?? e}` });
    await browser?.close().catch(() => {});
  }
}

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
      case 'device-config':
        // 設定画面で device 設定 (API URL / Worker Token 等) を保存・変更したとき、
        // worker を作り直さずに deviceAuth だけを更新する。
        // これをやらないと、ログイン後に Token を保存しても worker 内の deviceAuth が
        // 空のままで revealCredentials が「device設定が未完了」を返してしまう。
        {
          const d = m.payload ?? {};
          deviceAuth = {
            ...deviceAuth,
            apiBaseUrl:
              d.apiBaseUrl != null
                ? String(d.apiBaseUrl).replace(/\/+$/, '') || null
                : deviceAuth.apiBaseUrl,
            deviceId: d.deviceId !== undefined ? d.deviceId || null : deviceAuth.deviceId,
            deviceToken:
              d.deviceToken !== undefined ? d.deviceToken || null : deviceAuth.deviceToken,
            workerId: d.workerId || deviceAuth.workerId || 'electron-worker',
            ...(d.enablePush !== undefined ? { enablePush: !!d.enablePush } : {}),
          };
          log(
            `device設定を更新しました (apiBaseUrl=${deviceAuth.apiBaseUrl ? 'set' : 'null'}, token=${deviceAuth.deviceToken ? 'set' : 'null'})`,
          );
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
      case 'test-push':
        // 直列キュー経由で実行。複数同時に「SalonBoardに挿入」されても
        // 1件ずつ順番に処理し、SalonBoard のセッション競合 (2度押しエラー) を防ぐ。
        await enqueueSerial(async () => {
          try {
            await ensureReady();
          } catch (e) {
            emit('push:test', { ok: false, step: 'init', error: e instanceof Error ? e.message : String(e) });
            return;
          }
          await runTestPush(m.payload ?? {});
        });
        break;
      case 'cancel-booking':
        await enqueueSerial(async () => {
          try {
            await ensureReady();
          } catch (e) {
            emit('cancel:test', { ok: false, step: 'init', error: e instanceof Error ? e.message : String(e) });
            return;
          }
          await runCancel(m.payload ?? {});
        });
        break;
      case 'change-booking':
        await enqueueSerial(async () => {
          try {
            await ensureReady();
          } catch (e) {
            emit('change:test', { ok: false, step: 'init', error: e instanceof Error ? e.message : String(e) });
            return;
          }
          await runChange(m.payload ?? {});
        });
        break;
      case 'abort':
        abortRequested = true;
        await currentBrowser?.close().catch(() => {});
        currentBrowser = null;
        // ハングして finally に到達しないケースに備え、ロックも明示的に解放する。
        // (正常進行中なら runSync 側の finally でも false になる)
        running = false;
        runStartedAt = 0;
        emit('log', { level: 'warn', msg: '同期を中断しました (ロック解放)', at: new Date().toISOString() });
        emit('run:end', { total: 0, ok: 0, ng: 0, aborted: true, runId: null });
        break;
      default:
        log(`unknown message type: ${m.type}`, 'warn');
    }
  } catch (e) {
    emit('error', { msg: e instanceof Error ? e.message : String(e) });
  }
});

emit('boot', { pid: process.pid, at: new Date().toISOString() });
