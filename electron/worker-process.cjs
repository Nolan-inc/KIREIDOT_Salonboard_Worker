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
// エラー画面のAI解析 (Claude vision)。キー未設定なら未使用のまま (analyzeSalonboardError 参照)。
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const { execSync, spawn } = require('node:child_process');
// Electron utilityProcess は Node 20 で動作するが、組み込み WebSocket が無いため
// Supabase の createClient が RealtimeClient を生成する際に
// "Node.js 20 detected without native WebSocket support" 例外を投げる。
// Worker は postgres RPC しか使わないが、internal の RealtimeClient は必ず作られる
// ので、ws パッケージを transport として注入して例外を回避する。
const WebSocket = require('ws');
const {
  scrapeBookings,
  scrapeStaff,
  scrapeEquipment,
  scrapeMenus,
  scrapeCoupons,
  scrapeBlogs,
  scrapeReviews,
  scrapeShifts,
  scrapeCustomerDetails,
  pushBookingViaForm,
  pushScheduleViaForm,
  changeScheduleViaForm,
  deleteScheduleViaForm,
  pushShiftsViaForm,
  scrapeShiftPatterns,
  cancelBookingViaForm,
  changeBookingViaForm,
  postBlogViaForm,
  deleteBlogViaForm,
  postReviewReplyViaForm,
  postPhotoGalleryViaForm,
  scrapePhotoGallery,
  getLastErrorShot,
  resetLastErrorShot,
  ensureSalonSelected,
} = require('./scrapers.cjs');

// 一過性のインフラ由来失敗コード (SalonBoard/Akamai の一時的な書込ブロック)。
// scraper は manualRequired=false で返し「良い窓口を引くまで粘る」設計 (scrapers.cjs 参照)。
// 試行上限超過でも manual_required へ昇格させず retryable_failed を維持し、回復後の自動再投入に委ねる。
// 実枠競合(SLOT_NOT_AVAILABLE)・要素未検出(UNKNOWN_ERROR)等の実データ/セレクタ起因は従来どおり manual に倒す。
// worker.ts の INFRA_TRANSIENT_ERROR_CODES とミラー。
const INFRA_TRANSIENT_ERROR_CODES = new Set(['SB_SERVER_ERROR', 'SB_REGISTER_INCOMPLETE']);
function isInfraTransientError(code) {
  return !!code && INFRA_TRANSIENT_ERROR_CODES.has(code);
}
// 上限超過(exhausted)でも一過性インフラ失敗は manual に昇格させない。
function shouldPromoteToManual(manualRequired, exhausted, errorCode) {
  return !!manualRequired || (exhausted && !isInfraTransientError(errorCode));
}

// =====================================================================
// ブラウザ起動オプション。既定は Playwright 同梱 Chromium (Chrome for Testing)。
// SALONBOARD_USE_SYSTEM_CHROME=1 のときは OS インストール済みの実 Google Chrome
// (channel:'chrome') を使う。Chrome for Testing 固有の挙動 (アップロード等) を
// 切り分け/回避したいときの逃げ道。実Chromeが無ければ同梱版にフォールバックする。
// =====================================================================
const USE_SYSTEM_CHROME = /^(1|true|yes)$/i.test(process.env.SALONBOARD_USE_SYSTEM_CHROME ?? '');
function browserLaunchOptions(base = {}) {
  const opts = { ...base };
  if (USE_SYSTEM_CHROME) opts.channel = 'chrome';
  return opts;
}

// 投稿(push/書き込み)用ブラウザ起動。
// SalonBoard のスタイル画像アップロード(CN_CMN_imageUploaderModal の XHR)は
// **Chrome for Testing(同梱Chromium)だと「通信に失敗しました」になり、OSインストール済みの
// 実 Google Chrome だと成功する**ことが判明したため、push 経路は **実Chrome(channel:'chrome')を
// 優先**で起動し、無ければ同梱Chromium→最後にheadlessへフォールバックする。
// (取得スクレイピングは従来どおり同梱Chromiumのまま。)
async function launchPushBrowser(base = {}) {
  const args = base.args || ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-features=IsolateOrigins,site-per-process'];
  const headless = base.headless !== undefined ? base.headless : true;
  const slowMo = base.slowMo || 0;
  // 環境変数で明示的に同梱を強制したいとき用 (=実Chromeを使わない)。
  const forceBundled = /^(1|true|yes)$/i.test(process.env.SALONBOARD_FORCE_BUNDLED_CHROMIUM ?? '');
  if (!forceBundled) {
    try {
      const b = await chromium.launch({ channel: 'chrome', headless, slowMo, args });
      return { browser: b, usedChrome: true };
    } catch (e) {
      emit('log', { level: 'warn', msg: `実Chrome(channel:chrome)起動不可→同梱Chromiumで続行: ${e?.message?.split('\n')[0] ?? e}`, at: new Date().toISOString() });
    }
  }
  try {
    const b = await chromium.launch({ headless, slowMo, args });
    return { browser: b, usedChrome: false };
  } catch (_e) {
    const b = await chromium.launch({ headless: true, args });
    return { browser: b, usedChrome: false };
  }
}

// =====================================================================
// 店舗ごとの Chrome プロファイル (userDataDir)
//
// 予約の書込/キャンセル/変更を「店舗ごとに別プロファイル」で実行するための解決。
// Super Admin / 予約同期くん で設定した chrome_profile_no (普段使い Chrome の
// Profile 番号) を、OS の実プロファイルパスに変換する。店舗ごとにプロファイルを
// 分けることで、Akamai のセンサー cookie / 信頼状態が店舗単位で独立し、
// Bot 判定・500 ブロックの相互干渉を避ける。
//
//   profile_no = null/0 → 普段使い Chrome の "Default"
//   profile_no = N (>=1) → "Profile N"
//
// 未設定 (取得失敗含む) 時は shopId ごとの専用ディレクトリにフォールバックし、
// 少なくとも店舗間は分離する (~/.kireidot/salonboard-chrome-profile/{shopId})。
// =====================================================================

// =====================================================================
// CDP 接続方式 (2026-07-19): 普段使いの起動中 Chrome へ接続して操作する。
//
// ★背景: launchPersistentContext + seed 方式は「別の新しい Chrome」を起動する
//   ため、既存のログイン済みセッションを使えず SB ログインからやり直しになり、
//   Akamai に弾かれてログインリロードループになっていた。
//   → 指定プロファイルの Chrome を --remote-debugging-port 付きで起動 (既に同
//     プロファイルの Chrome が起動中なら process singleton でそこにアタッチ) し、
//     chromium.connectOverCDP でその「普段使い Chrome」へ接続する。既存タブ・
//     Cookie・ログイン状態をそのまま使う。新プロファイル/別ウィンドウは作らない。
//     処理後は開いたタブだけ閉じ、Chrome 本体は閉じない。
// =====================================================================

const CHROME_BIN_MAC = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CDP_HOST = '127.0.0.1';
const MANAGED_CDP_ROOT = path.join(os.homedir(), '.kireidot', 'salonboard-cdp');
// connectOverCDP の browser.close() は常駐Chrome本体を終了し得るため、
// 接続をポート単位で保持し、後続ジョブから再利用する。
const managedCdpBrowsers = new Map();

/** chrome_profile_no を Chrome の --profile-directory 名に変換 (0/null=Default, N=Profile N)。 */
function profileDirName(profileNo) {
  const n = Number(profileNo);
  if (!Number.isFinite(n) || n <= 0) return 'Default';
  return `Profile ${n}`;
}

/** DBでポート未設定でも全店舗が9222へ集中しないための安定した予備ポート。 */
function defaultDebugPortForShop(shopId) {
  const value = String(shopId || 'default');
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return 12000 + ((hash >>> 0) % 20000);
}

function chromeBinaryPath() {
  if (process.platform === 'darwin') return CHROME_BIN_MAC;
  if (process.platform === 'win32') {
    return path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe');
  }
  for (const candidate of ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium']) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** 指定ポートで CDP エンドポイントが応答するか (GET /json/version) を確認。 */
function probeCdp(port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const req = http.get({ host: CDP_HOST, port, path: '/json/version', timeout: timeoutMs }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(buf).webSocketDebuggerUrl ? { ok: true } : { ok: false }); }
        catch { resolve({ ok: false }); }
      });
    });
    req.on('error', () => resolve({ ok: false }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false }); });
  });
}

/** TCP でポートが空いているか (LISTEN 中か) を軽く確認。 */
function isPortOpen(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: CDP_HOST, port });
    const done = (v) => { try { sock.destroy(); } catch (_e) {} resolve(v); };
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => done(true));
    sock.on('error', () => done(false));
    sock.on('timeout', () => done(false));
  });
}

function normalizeChromeExitState(userDataDir, profile) {
  for (const preferencesPath of [
    path.join(userDataDir, profile, 'Preferences'),
    path.join(userDataDir, 'Default', 'Preferences'),
  ]) {
    try {
      if (!fs.existsSync(preferencesPath)) continue;
      const preferences = JSON.parse(fs.readFileSync(preferencesPath, 'utf8'));
      preferences.profile = { ...(preferences.profile || {}), exit_type: 'Normal', exited_cleanly: true };
      fs.writeFileSync(preferencesPath, JSON.stringify(preferences));
    } catch (_e) { /* Chrome自身の復旧に任せる */ }
  }
}

async function waitForCdp(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await probeCdp(port, 1200)).ok) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

/**
 * 店舗専用の永続user-data-dirでChromeを起動する。
 * 初回のみ指定ProfileからログインCookie等をseedし、以後は専用dirを再利用する。
 */
async function ensureManagedChrome({ shopId, profileNo, port }) {
  if ((await probeCdp(port)).ok) return { started: false };
  if (await isPortOpen(port)) {
    throw new Error(`CDPポート ${port} は別プロセスが使用中ですが、Chrome DevToolsとして応答しません`);
  }

  const chromeBin = chromeBinaryPath();
  if (!chromeBin || !fs.existsSync(chromeBin)) {
    throw new Error(`Google Chromeが見つからないため店舗用Chromeを起動できません (${chromeBin || 'path未解決'})`);
  }

  const userDataDir = path.join(MANAGED_CDP_ROOT, String(shopId || `port-${port}`));
  fs.mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
  const profile = profileDirName(profileNo);
  // Profile未設定の店舗へ普段使いDefaultのセッションを複製すると、全店舗が同じ
  // SalonBoardアカウントで始まりセッション混線する。明示設定時だけseedする。
  const hasExplicitProfile = profileNo != null && Number.isFinite(Number(profileNo)) && Number(profileNo) >= 0;
  const seedInfo = hasExplicitProfile
    ? seedUserChromeProfile(userDataDir, { srcProfile: profile })
    : { seeded: false, reason: 'profile_not_configured' };
  normalizeChromeExitState(userDataDir, profile);

  const child = spawn(chromeBin, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    `--profile-directory=${profile}`,
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-session-crashed-bubble',
    '--hide-crash-restore-bubble',
    '--new-window',
    'about:blank',
  ], { detached: true, stdio: 'ignore' });
  child.unref();
  emit('log', {
    level: 'info',
    msg: `[cdp] 店舗用Chromeを自動起動 shop=${String(shopId).slice(0, 8)} port=${port} profile="${profile}" seed=${seedInfo.reason || (seedInfo.seeded ? 'done' : 'skip')}`,
    at: new Date().toISOString(),
  });

  if (!(await waitForCdp(port))) {
    throw new Error(`店舗用Chromeを起動しましたが、CDPポート ${port} が30秒以内に応答しませんでした`);
  }
  return { started: true, userDataDir, profile };
}

/**
 * 普段使いの Chrome を「指定プロファイル + remote-debugging-port」で起動 or 再利用し、
 * CDP で接続する。返り値の context/browser は既存 Chrome を指す。
 *
 * 店舗別Chromeが未起動/クラッシュ済みならWorkerが専用user-data-dirで自動復旧する。
 * ログイン状態は店舗専用dirに永続化され、ジョブ間・Mac再起動後も再利用される。
 *
 * 引数:
 *   profileNo : chrome_profile_no (0/null=Default, N=Profile N) — ログ/エラー表示用
 *   debugPort : chrome_debug_port (null=既定 9222) — 接続先ポート
 *
 * 返り値: { browser, context, usedChrome:true, viaCdp:true, profile, port }
 */
async function connectToUserChrome({ shopId, profileNo, debugPort } = {}) {
  const port = Number(debugPort || process.env.SALONBOARD_CHROME_DEBUG_PORT || defaultDebugPortForShop(shopId));
  const profile = profileDirName(profileNo);
  const endpoint = `http://${CDP_HOST}:${port}`;

  const cached = managedCdpBrowsers.get(port);
  if (cached?.browser?.isConnected?.()) {
    return { ...cached, reused: true };
  }
  managedCdpBrowsers.delete(port);

  await ensureManagedChrome({ shopId, profileNo, port });

  const browser = await chromium.connectOverCDP(endpoint, { timeout: 15_000 });
  const contexts = browser.contexts();
  const context = contexts.length > 0 ? contexts[0] : await browser.newContext();
  const connected = { browser, context, usedChrome: true, viaCdp: true, profile, port };
  managedCdpBrowsers.set(port, connected);
  browser.on('disconnected', () => {
    if (managedCdpBrowsers.get(port)?.browser === browser) managedCdpBrowsers.delete(port);
  });
  emit('log', { level: 'info', msg: `[cdp] 接続成功 port=${port} profile="${profile}" contexts=${contexts.length}`, at: new Date().toISOString() });
  return connected;
}

/**
 * 店舗用 Chrome の中で、SalonBoard 操作に使う「worker 専用の作業タブ」を用意する。
 *
 * ★設計 (2026-07-20 改訂): 店舗用 Chrome (ensureManagedChrome が専用 user-data-dir で
 *   起動) のタブは全て worker の所有物なので、**1 本の作業タブを使い回す**。
 *   - 接続キャッシュ (managedCdpBrowsers のエントリ) に workerPage を保持し、
 *     ジョブ/セッション延命をまたいで再利用する。
 *   - 初回は起動時の about:blank タブがあればそれを採用 (余計なタブを作らない)。
 *   - 作業後もタブは閉じない (createdNewTab:false)。ジョブごとに開閉すると、
 *     残るのが起動時の about:blank だけになり「画面が真っ白で何もできない」
 *     ように見えるため。タブを閉じないことで直近の SalonBoard 画面が残り、
 *     状態確認もできる。
 *
 * 引数は connectToUserChrome の返り値 (接続キャッシュと同一オブジェクト)。
 * 後方互換のため context を直接渡された場合も動く (その場合キャッシュはしない)。
 */
async function acquireSalonboardPage(conn) {
  const context = conn && conn.context ? conn.context : conn;
  // 1) キャッシュ済みの作業タブが生きていれば再利用
  const cached = conn && conn.workerPage;
  if (cached && !(cached.isClosed && cached.isClosed())) {
    return { page: cached, createdNewTab: false };
  }
  // 2) 起動時の about:blank タブがあれば作業タブとして採用
  let page = null;
  try {
    page = (context.pages ? context.pages() : []).find((p) => {
      try { return p.url() === 'about:blank'; } catch (_e) { return false; }
    }) || null;
  } catch (_e) { /* noop */ }
  // 3) 無ければ新規タブ
  if (!page) page = await context.newPage();
  if (conn && conn.context) conn.workerPage = page;
  return { page, createdNewTab: false };
}

/**
 * shop_id の Chrome プロファイル番号 + CDP デバッグポートを取得する。
 * 未設定/失敗時は { profileNo: null, debugPort: null } (呼び出し側で既定にフォールバック)。
 */
async function fetchChromeProfile(shopId) {
  try {
    const { data, error } = await supabase.rpc('salonboard_get_chrome_profile', { p_shop_id: shopId });
    if (error) {
      emit('log', { level: 'warn', msg: `[profile] 取得失敗 (既定で続行): ${error.message}`, at: new Date().toISOString() });
      return { profileNo: null, debugPort: null };
    }
    // RPC は table を返すため配列。1 行目を読む。
    const row = Array.isArray(data) ? data[0] : data;
    return {
      profileNo: row?.chrome_profile_no == null ? null : Number(row.chrome_profile_no),
      debugPort: row?.chrome_debug_port == null ? null : Number(row.chrome_debug_port),
    };
  } catch (e) {
    emit('log', { level: 'warn', msg: `[profile] 取得例外 (既定で続行): ${e?.message ?? e}`, at: new Date().toISOString() });
    return { profileNo: null, debugPort: null };
  }
}

// =====================================================================
// Chrome拡張ブリッジ経由のスタイル投稿 (美容室 push_photo_gallery kind=style)。
// Playwright起動のChromeだとAkamaiに画像アップロード(/imgreg/doUpload)を
// 弾かれるため、拡張機能を入れた「普段使いChrome」で実行する (chrome拡張.md)。
// main process が 127.0.0.1:32178 に立てる extension-bridge にジョブを積み、
// 拡張(background.js)がポーリングして content.js が SalonBoard 公式JSの流れで
// ログイン→サロン選択→styleEdit→画像アップロード→フォーム入力→登録まで行う。
// ブリッジ未起動/拡張未導入(ジョブが拾われない)ときは従来の Playwright 方式へ
// フォールバックする。SALONBOARD_EXT_STYLE=0 で常に Playwright 方式に戻せる。
// =====================================================================
const EXT_BRIDGE = 'http://127.0.0.1:32178';
const EXT_STYLE_DISABLED = /^(0|false|no)$/i.test(process.env.SALONBOARD_EXT_STYLE ?? '');

function extBridgeRequest(method, pathName, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      `${EXT_BRIDGE}${pathName}`,
      {
        method,
        headers: data
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
          : {},
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, json: buf ? JSON.parse(buf) : {} }); }
          catch (_e) { resolve({ status: res.statusCode, json: {} }); }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('bridge timeout')));
    if (data) req.write(data);
    req.end();
  });
}

/**
 * 美容室スタイル投稿を Chrome拡張(普段使いChrome)で実行する。
 * 返り値:
 *   { handled:false }                                  → 拡張が使えない。Playwright方式へフォールバック。
 *   { handled:true, status:'ok', externalId }          → 登録完了。
 *   { handled:true, status:'confirm_only' }            → 入力のみ (実登録OFF)。
 *   { handled:true, status:'failed', errorCode, reason, manualRequired }
 */
async function runStyleJobViaExtension({ payload, creds, shopName, enablePost, tag }) {
  const p = payload || {};
  const imageUrl = (p.image_url && String(p.image_url)) ||
    (Array.isArray(p.images) && p.images.length ? String(p.images[0]) : '');
  if (!imageUrl) return { handled: false };

  // postHairStyleViaForm (Playwright方式) と同じ補完ルール/ガード。
  const style = p.style && typeof p.style === 'object' ? p.style : {};
  const title = (p.title && String(p.title).trim()) || '';
  const caption = (p.caption && String(p.caption).trim()) || '';
  const styleName = (String(style.style_name || '').trim() || title || caption || 'スタイル').slice(0, 30);
  const comment = (String(style.stylist_comment || '').trim() || caption || title || 'よろしくお願いいたします。').slice(0, 120);
  const stylistExt = p.author_external_id ? String(p.author_external_id).trim() : '';
  if (!stylistExt) {
    return {
      handled: true, status: 'failed', errorCode: 'STYLIST_REQUIRED', manualRequired: true,
      reason: 'スタイリストが選択されていません。フォトギャラリー投稿時にスタッフ(スタイリスト)を選択してください。',
    };
  }

  // 1) ジョブ作成。ブリッジに繋がらない = main 未起動など → フォールバック。
  let created;
  try {
    created = await extBridgeRequest('POST', '/jobs', {
      type: 'hair_style_front',
      target: 'FRONT_IMG_ID',
      imageUrl,
      salonboardUrl: 'https://salonboard.com/CNB/draft/styleEdit/',
      loginId: creds.login_id || null,
      password: creds.password || null,
      // 会社切替の判定軸: ログインIDが一意なので companyId = loginId。
      companyId: creds.login_id || null,
      salonId: creds.salon_id || null,
      expectedSalonName: shopName || null,
      style: {
        stylistExternalId: stylistExt,
        styleName,
        comment,
        category: String(style.category_cd || '').trim() === 'SG02' ? 'SG02' : 'SG01',
        length: String(style.length_cd || '').trim() || null,
        menus: Array.isArray(style.menu_cds) ? style.menu_cds : [],
        menuDetail: (String(style.menu_text || '').trim() || styleName).slice(0, 50),
      },
      enablePost: !!enablePost,
      openChrome: true,
    });
  } catch (e) {
    emit('log', { level: 'info', msg: `[${tag}] 拡張ブリッジに接続できません(${e?.message ?? e}) → Playwright方式で実行`, at: new Date().toISOString() });
    return { handled: false };
  }
  if (!created?.json?.ok || !created.json.jobId) {
    return {
      handled: true, status: 'failed', errorCode: 'EXT_JOB_FAILED', manualRequired: true,
      reason: created?.json?.error || '拡張ジョブの作成に失敗しました',
    };
  }
  const extJobId = created.json.jobId;
  emit('log', { level: 'info', msg: `[${tag}] 🧩 Chrome拡張でスタイル投稿を実行 (job=${extJobId})。普段使いChromeでSalonBoardを開きます…`, at: new Date().toISOString() });

  // 2) ポーリング: 拾われるまで90秒 (未導入/Chrome未起動の検知) / 全体8分。
  //    content.js は login→サロン選択→styleEdit と多段遷移し、その都度 pending に
  //    戻る(retry)ため、一度でも拾われたら pickup タイムアウトは適用しない。
  const PICKUP_TIMEOUT_MS = 90_000;
  const TOTAL_TIMEOUT_MS = 8 * 60_000;
  const startedAt = Date.now();
  let everPicked = false;
  while (Date.now() - startedAt < TOTAL_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, 3000));
    let st;
    try { st = await extBridgeRequest('GET', `/jobs/${extJobId}`); } catch (_e) { continue; }
    const j = st?.json || {};
    if (j.status === 'picked' || j.status === 'uploading' || (j.retryCount || 0) > 0) everPicked = true;

    if (j.status === 'done') {
      const r = j.result || {};
      const rs = r.resultStatus || 'uploaded';
      if (rs === 'registered') return { handled: true, status: 'ok', externalId: r.imageId || null };
      if (rs === 'filled_not_registered') return { handled: true, status: 'confirm_only' };
      // uploaded_not_registered(バリデーションエラー) / uploaded_no_register_btn 等。
      return {
        handled: true, status: 'failed', errorCode: 'VALIDATION_ERROR', manualRequired: true,
        reason: `スタイル登録が完了しませんでした (${rs}${r.reason ? `: ${r.reason}` : ''})`,
      };
    }
    if (j.status === 'failed') {
      const msg = String(j.error || 'アップロード失敗');
      const errorCode = /reCAPTCHA/i.test(msg) ? 'RECAPTCHA_REQUIRED'
        : /ログイン/.test(msg) ? 'LOGIN_FAILED'
        : 'EXT_UPLOAD_FAILED';
      return {
        handled: true, status: 'failed', errorCode,
        manualRequired: errorCode !== 'EXT_UPLOAD_FAILED',
        reason: `Chrome拡張: ${msg}`,
      };
    }
    if (j.status === 'cancelled') return { handled: false };

    // まだ一度も拾われていない → 拡張未導入/Chrome未起動とみなしてキャンセル→フォールバック。
    if (!everPicked && Date.now() - startedAt > PICKUP_TIMEOUT_MS) {
      try {
        const c = await extBridgeRequest('POST', `/jobs/${extJobId}/cancel`);
        if (c?.json?.cancelled) {
          emit('log', { level: 'warn', msg: `[${tag}] Chrome拡張がジョブを拾いませんでした(拡張未導入/Chrome未起動?) → Playwright方式にフォールバック`, at: new Date().toISOString() });
          return { handled: false };
        }
        // キャンセルできなかった = ちょうど拾われた → 続行。
        everPicked = true;
      } catch (_e) { /* 続行 */ }
    }
  }
  // タイムアウト: 古いジョブがChromeを動かし続けて次のジョブと二重ループしないよう、
  // ブリッジ側のジョブを必ず取り消す (picked でも取り消せる)。
  // ここで Playwright にフォールバックすると同じSBアカウントへ二重ログインして
  // 拡張のChromeセッションを蹴ってしまうため、フォールバックせず手動対応に倒す。
  try { await extBridgeRequest('POST', `/jobs/${extJobId}/cancel`); } catch (_e) { /* noop */ }
  return {
    handled: true, status: 'failed', errorCode: 'EXT_TIMEOUT', manualRequired: true,
    reason: 'Chrome拡張でのスタイル投稿が8分以内に完了しませんでした。Chromeに表示されているSalonBoardの状態(ログイン/エラー表示)を確認してから再投稿してください。',
  };
}

// =====================================================================
// ステルス永続コンテキストで実Chromeを起動する。
// Akamai Bot Manager は navigator.webdriver / --enable-automation /
// AutomationControlled などの「自動化指紋」を見てボット判定し、doUpload を
// ホールドする。これらを **付けない/隠す** ことで人間のChromeに近づける。
// - launchPersistentContext(専用 userDataDir) で、Akamaiのセンサーcookie等を
//   回をまたいで蓄積させ、信頼スコアを育てる。
// - ignoreDefaultArgs で Playwright が付ける --enable-automation を除去。
// - addInitScript で navigator.webdriver を undefined に偽装。
// 返り値: { context, browser, usedChrome, persistent:true }
// =====================================================================
// ユーザーの普段使い Chrome プロファイル(SalonBoardログイン済み・Akamai信頼cookieあり)を
// 予約同期くん専用の user-data-dir に **コピーしてシード** する。同一Mac・同一ユーザーなら
// Keychain の "Chrome Safe Storage" 鍵で cookie を復号できるため、手動と同じ信頼状態で起動できる。
// 既に専用dirがあれば(=育っているので)再シードしない。
function seedUserChromeProfile(userDataDir, opts = {}) {
  // 既にシード済みなら何もしない(.seeded マーカーで判定)。
  // ★店舗ごとに「どのプロファイルから seed したか」を .seeded に記録し、
  //   別プロファイル番号に変更されたら再 seed する (マーカー内容で判定)。
  const markerPath = path.join(userDataDir, '.seeded');
  const srcRoot = opts.srcRoot
    || process.env.SALONBOARD_CHROME_SOURCE_DIR
    || path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
  // opts.srcProfile があれば最優先 (店舗ごとの chrome_profile_no 由来)。
  const srcProfile = opts.srcProfile || process.env.SALONBOARD_CHROME_SOURCE_PROFILE || 'Default';

  const prevMarker = (() => { try { return fs.readFileSync(markerPath, 'utf8'); } catch (_e) { return null; } })();
  // マーカーに記録された srcProfile が現在の指定と一致していれば再 seed 不要。
  if (prevMarker && prevMarker.includes(`profile=${srcProfile}`)) {
    return { seeded: false, reason: 'already', srcProfile };
  }
  if (!fs.existsSync(path.join(srcRoot, srcProfile))) return { seeded: false, reason: 'source_not_found', srcRoot, srcProfile };

  try {
    fs.mkdirSync(path.join(userDataDir, srcProfile), { recursive: true, mode: 0o700 });
    // Cookie 復号に必要な Local State(暗号鍵) は必須。
    try { fs.copyFileSync(path.join(srcRoot, 'Local State'), path.join(userDataDir, 'Local State')); } catch (_e) {}
    // ログイン/Akamai cookie 等、必要最小限のファイルだけコピー(プロファイル全体は重い)。
    const files = ['Cookies', 'Cookies-journal', 'Network/Cookies', 'Network/Cookies-journal', 'Login Data', 'Web Data', 'Preferences', 'Local Storage'];
    for (const rel of files) {
      const s = path.join(srcRoot, srcProfile, rel);
      const d = path.join(userDataDir, srcProfile, rel);
      try {
        if (!fs.existsSync(s)) continue;
        const st = fs.statSync(s);
        fs.mkdirSync(path.dirname(d), { recursive: true });
        if (st.isDirectory()) fs.cpSync(s, d, { recursive: true });
        else fs.copyFileSync(s, d);
      } catch (_e) { /* 個別失敗は無視 */ }
    }
    try { fs.writeFileSync(markerPath, `${new Date().toISOString()} profile=${srcProfile}`); } catch (_e) {}
    return { seeded: true, srcRoot, srcProfile };
  } catch (e) {
    return { seeded: false, reason: `copy_error: ${e?.message ?? e}` };
  }
}

async function launchStealthPersistentContext(opts = {}) {
  const headless = opts.headless !== undefined ? opts.headless : false;
  const slowMo = opts.slowMo || 0;
  const userDataDir = path.join(os.homedir(), '.kireidot', 'salonboard-chrome-profile');
  try { fs.mkdirSync(userDataDir, { recursive: true, mode: 0o700 }); } catch (_e) { /* noop */ }
  // ★ユーザーの普段使い Chrome プロファイルをシード(初回のみ)。Akamai信頼cookieを引き継ぐ。
  let seedInfo = { seeded: false, reason: 'disabled' };
  const useUserProfile = !/^(0|false|no)$/i.test(process.env.SALONBOARD_USE_USER_PROFILE ?? '1'); // 既定ON
  if (useUserProfile) {
    seedInfo = seedUserChromeProfile(userDataDir);
    emit('log', { level: 'info', msg: `Chromeプロファイルseed: ${JSON.stringify(seedInfo)}`, at: new Date().toISOString() });
  }
  // 前回 worker が強制終了された場合、Chrome は Preferences に crash 状態を残し、
  // 次回起動時に「ページを復元しますか？」を表示する。このバブルがログイン画面に
  // 被さって人間には停止して見えるため、専用プロファイルだけ正常終了状態へ戻す。
  for (const preferencesPath of [
    path.join(userDataDir, 'Default', 'Preferences'),
    path.join(userDataDir, 'Preferences'),
  ]) {
    try {
      if (!fs.existsSync(preferencesPath)) continue;
      const preferences = JSON.parse(fs.readFileSync(preferencesPath, 'utf8'));
      preferences.profile = { ...(preferences.profile || {}), exit_type: 'Normal', exited_cleanly: true };
      fs.writeFileSync(preferencesPath, JSON.stringify(preferences));
    } catch (_e) { /* 壊れたPreferencesはChrome自身の復旧に任せる */ }
  }
  // 自動化検知につながる既定フラグを除去。
  // ★--no-sandbox は付けない: Chromeが「サポートされていないフラグ」警告を出し、
  //   Akamai に自動化ブラウザと検知される手がかりになる。実Chromeはsandboxありで起動できる。
  const ignoreDefaultArgs = ['--enable-automation', '--disable-blink-features=AutomationControlled', '--no-sandbox'];
  const args = [
    '--disable-features=IsolateOrigins,site-per-process',
    '--disable-session-crashed-bubble',
    '--hide-crash-restore-bubble',
    '--no-first-run',
    '--no-default-browser-check',
  ];
  const contextOpts = {
    headless,
    slowMo,
    channel: 'chrome',
    ignoreDefaultArgs,
    args,
    viewport: { width: 1366, height: 900 },
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    // ★userAgent は上書きしない(実Chrome147の本物UAを使う。Chrome127偽装はUA不一致でAkamaiに怪しまれる)。
  };
  const ctx = await chromium.launchPersistentContext(userDataDir, contextOpts);
  await ctx.addInitScript(() => {
    try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch (_e) {}
    try { window.chrome = window.chrome || { runtime: {} }; } catch (_e) {}
    try {
      const orig = navigator.permissions && navigator.permissions.query;
      if (orig) navigator.permissions.query = (p) => (p && p.name === 'notifications' ? Promise.resolve({ state: Notification.permission }) : orig(p));
    } catch (_e) {}
  }).catch(() => {});
  return { context: ctx, browser: ctx.browser(), usedChrome: true, persistent: true, userDataDir, seeded: seedInfo.seeded };
}

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
  // Slack エラー通知 { token: 'xoxb-...', channel: 'C...' }。設定画面から渡される。
  slack: null,
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

// ─────────────────────────────────────────────
// Chrome ポート(=1つの Chrome インスタンス)単位のロック。
//
// CDP 接続方式では「同じ chrome_debug_port を使う店舗」は同一 Chrome を共有する。
// 店舗ごとに別ポートを割り当てれば店舗間は完全並列になるが、ポート未設定(既定9222共有)
// や設定漏れで複数店舗が同じポートを指すと、同一 Chrome 上で並列にタブ操作/ログインが
// 走って SalonBoard セッションが混線する。これを防ぐため、ポート単位でも直列化する。
// (店舗ロックは shop_id 単位なので、別店舗×同一ポートは保護できない。)
// ─────────────────────────────────────────────
const inProgressChromePorts = new Map();
function tryAcquireChromePortLock(port, workerLabel) {
  const now = Date.now();
  const cur = inProgressChromePorts.get(port);
  if (cur && now - cur.startedAt < SHOP_LOCK_TTL_MS) {
    return { ok: false, since: cur.startedAt, workerLabel: cur.workerLabel };
  }
  inProgressChromePorts.set(port, { startedAt: now, workerLabel });
  return { ok: true };
}
function releaseChromePortLock(port) {
  inProgressChromePorts.delete(port);
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

// =====================================================================
// Slack エラー通知
//   予約同期くんで起きた「エラー/警告ログ」と「失敗系の callback」を Slack へ送る。
//   トークンとチャンネルは設定(device-config)経由で deviceAuth.slack に入る。
//   - 連続/重複通知の抑制(同一文面は60秒に1回)とレート制限で氾濫を防ぐ。
//   - 送信失敗で本処理を止めない(例外を投げない)。
// =====================================================================
const SLACK_DEDUP_MS = 60_000;
const _slackRecent = new Map(); // key(本文) -> 最終送信epoch
let _slackLastSentAt = 0;
// 通知先の既定チャンネル。設定でチャンネルを空にしてもここへ送る。
// https://nolan-co-jp.slack.com/archives/C0B9N3RA4BE
const SLACK_DEFAULT_CHANNEL = 'C0B9N3RA4BE';

function slackChannelOrDefault() {
  return (deviceAuth && deviceAuth.slack && deviceAuth.slack.channel) || SLACK_DEFAULT_CHANNEL;
}

// トークンさえあれば有効 (チャンネルは未指定なら既定チャンネルへ)。
function slackEnabled() {
  return !!(deviceAuth && deviceAuth.slack && deviceAuth.slack.token);
}

async function sendSlack(text) {
  if (!slackEnabled()) return;
  const now = Date.now();
  // 重複抑制 (同一本文は60秒に1回)。
  const key = String(text).slice(0, 300);
  const last = _slackRecent.get(key) || 0;
  if (now - last < SLACK_DEDUP_MS) return;
  _slackRecent.set(key, now);
  // 軽いレート制限 (最短1秒間隔)。
  if (now - _slackLastSentAt < 1000) {
    await new Promise((r) => setTimeout(r, 1000));
  }
  _slackLastSentAt = Date.now();
  // 古いdedupエントリを掃除。
  if (_slackRecent.size > 200) {
    for (const [k, t] of _slackRecent) { if (now - t > SLACK_DEDUP_MS * 5) _slackRecent.delete(k); }
  }
  try {
    const machine = (typeof machineId === 'function' ? machineId() : 'worker');
    const ver = (typeof appVersionFallback === 'function' ? appVersionFallback() : null);
    const prefix = `:warning: *予約同期くんエラー* (${machine}${ver ? ` v${ver}` : ''})`;
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${deviceAuth.slack.token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ channel: slackChannelOrDefault(), text: `${prefix}\n${text}` }),
    });
    const json = await res.json().catch(() => ({}));
    if (!json.ok) console.warn('[slack] notify failed', json.error);
  } catch (e) {
    console.warn('[slack] notify error', e?.message ?? e);
  }
}

// =====================================================================
// エラー画面のスクショ + 画面テキストAI判別 + 原因推測を Slack へ送る
//   - 通知先は専用チャンネル C0BJDTG7KPY (設定で上書き可: deviceAuth.slack.error_channel)
//     https://nolan-co-jp.slack.com/archives/C0BJDTG7KPY
//     (2026-07-20 ユーザ指示で C0BAPMRQR2L から変更。AIがまとめた原因・内容つき)
//   - スクショは Slack files.upload(v2: getUploadURLExternal→completeUploadExternal)
//   - AI推測は Claude 優先 → OpenAI フォールバック (キー未設定ならスキップ)
//   - 全ジョブの失敗 (postCallback の失敗ステータス) で発火。重複抑制なし(毎回送る)
// =====================================================================
const SLACK_ERROR_SCREENSHOT_CHANNEL =
  process.env.SALONBOARD_SLACK_ERROR_CHANNEL || 'C0BJDTG7KPY';

function slackErrorChannel() {
  return (
    (deviceAuth && deviceAuth.slack && deviceAuth.slack.error_channel) ||
    SLACK_ERROR_SCREENSHOT_CHANNEL
  );
}

// 「現在処理中の Playwright page」。postCallback は page を持たないため、
// runOneInner がジョブ処理中の page をここに保持し、失敗時のスクショ取得に使う。
let _errorCapturePage = null;
// 現在処理中ジョブの「予約特定情報」(Slack エラー通知に載せる)。runOneInner が設定。
let _currentJobInfo = null; // { shopName, when, customer }

const JOB_LABEL = {
  push_booking: '予約の登録/変更',
  cancel_booking: '予約のキャンセル',
  push_blog: 'ブログ投稿',
  delete_blog: 'ブログ削除',
  push_photo_gallery: 'フォトギャラリー投稿',
  push_review_reply: '口コミ返信',
  push_shifts: 'シフト反映',
  fetch_shift_patterns: '勤務パターン取得',
  fetch_staff: 'スタッフ取得',
  fetch_equipment: '設備取得',
  fetch_reviews: '口コミ取得',
};

// エラー画面のスクショ(Buffer)と本文テキストを取得する。
//
// ★最優先: 失敗が起きた「まさにその画面」を撮った _lastErrorShot
//   (scrapers.cjs の captureScrapeDebug が失敗地点で撮る) を使う。
//   postCallback が呼ばれる頃には画面が遷移/クローズしていて、page を再スクショ
//   しても肝心のポップアップ/画像認証が写らないことがあるため。
// フォールバック: フレッシュなショットが無ければ、今の page を撮る。
async function captureErrorPageArtifacts(page) {
  let buffer = null;
  let text = '';
  let url = '';

  // 1) 失敗地点で撮った最新ショットを優先採用 (このジョブ中に撮られたもの)。
  //    撮影中なら getLastErrorShot() が撮り終わるまで待つ。
  try {
    const last = typeof getLastErrorShot === 'function' ? await getLastErrorShot() : null;
    if (last && Buffer.isBuffer(last.buffer)) {
      buffer = last.buffer;
      url = last.url || '';
    }
  } catch (_e) { /* noop */ }

  // 2) ショットがまだ無ければ今の page を撮る (遷移後でも無いよりマシ)。
  if (!buffer && page) {
    try { if (!url) url = page.url(); } catch (_e) { /* noop */ }
    try {
      const shot = await Promise.race([
        page.screenshot({ fullPage: false }),
        new Promise((resolve) => setTimeout(() => resolve(null), 7000)),
      ]);
      if (shot && Buffer.isBuffer(shot)) buffer = shot;
    } catch (_e) { /* noop */ }
  }

  // 3) 画面テキストは可能なら今の page から (AI 解析の補助。失敗しても無視)。
  if (page) {
    try {
      text = (await Promise.race([
        page.evaluate(() => (document.body?.innerText ?? '').slice(0, 4000)),
        new Promise((resolve) => setTimeout(() => resolve(''), 4000)),
      ])) || '';
    } catch (_e) { /* noop */ }
    if (!url) { try { url = page.url(); } catch (_e) { /* noop */ } }
  }
  return { buffer, text, url };
}

// ---------------------------------------------------------------------------
// エラー画面のAI解析 (2026-07-20: Anthropic Claude を優先に変更)
//
// スクレイピング失敗時のスクショ + エラーテキストを Claude (vision) に渡し、
// 「(1)画面のエラーメッセージ要約 (2)原因の推測 (3)対処の提案」を JSON で受け取って
// Slack 通知に載せる。APIキーは以下の順で解決 (コードには絶対に埋め込まない):
//   1. 環境変数 ANTHROPIC_API_KEY
//   2. ~/.kireidot/anthropic_api_key ファイル (Mac Studio で一度置けば以後有効)
// どちらも無ければ従来の OpenAI (OPENAI_API_KEY) にフォールバック。
// それも無ければ AI 解析をスキップ (スクショ+エラーテキストのみ通知 = 従来互換)。
// ---------------------------------------------------------------------------

/** Anthropic API キーを env → ~/.kireidot/anthropic_api_key の順で解決する。 */
function anthropicApiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  try {
    const p = path.join(os.homedir(), '.kireidot', 'anthropic_api_key');
    const v = fs.readFileSync(p, 'utf8').trim();
    if (v) return v;
  } catch (_e) { /* ファイル無しは正常 (未設定) */ }
  return null;
}

/**
 * OpenAI API キーを env → ~/.kireidot/openai_api_key の順で解決する。
 * Dock 起動の Electron アプリには環境変数が渡らないため、Anthropic と同じく
 * Mac 上のキーファイルでも設定できるようにする (2026-07-20)。
 */
function openaiApiKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  try {
    const p = path.join(os.homedir(), '.kireidot', 'openai_api_key');
    const v = fs.readFileSync(p, 'utf8').trim();
    if (v) return v;
  } catch (_e) { /* ファイル無しは正常 (未設定) */ }
  return null;
}

// エラー解析結果の JSON スキーマ (structured outputs で形を保証する)。
const ERROR_ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    screen_message: { type: 'string', description: '画面に出ているエラーメッセージの要約 (日本語)' },
    probable_cause: { type: 'string', description: '考えられる原因の推測 (日本語)' },
    suggested_action: { type: 'string', description: '対処の提案 (日本語)' },
  },
  required: ['screen_message', 'probable_cause', 'suggested_action'],
  additionalProperties: false,
};

// Claude (Anthropic API) でエラー画面を解析。成功で {screen_message, probable_cause,
// suggested_action}、キー未設定/失敗で null (呼び出し側が OpenAI へフォールバック)。
async function analyzeSalonboardErrorWithClaude({ buffer, errorText, jobType, errorCode }) {
  const apiKey = anthropicApiKey();
  if (!apiKey) return null;
  try {
    const client = new Anthropic({ apiKey, timeout: 60_000, maxRetries: 1 });
    const label = JOB_LABEL[jobType] || jobType || '操作';
    const content = [];
    if (buffer && Buffer.isBuffer(buffer)) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: buffer.toString('base64') },
      });
    }
    content.push({
      type: 'text',
      text:
        `SalonBoard (美容サロン向け予約管理サイト) で「${label}」を Playwright で自動操作中にエラーになりました。\n` +
        `エラーコード: ${errorCode || '不明'}\n` +
        `Worker が検知したエラー: ${String(errorText || '').slice(0, 800)}\n\n` +
        `添付のエラー画面スクリーンショットを見て、画面に書かれているテキストを読み取り、` +
        `(1) 画面に出ているエラーメッセージの要約 (2) 考えられる原因の推測 (3) 対処の提案 ` +
        `を日本語で簡潔に答えてください。スクリーンショットが無い場合はエラーテキストのみから推測してください。`,
    });
    const response = await client.messages.create({
      model: process.env.ANTHROPIC_MODEL || 'claude-opus-4-8',
      max_tokens: 1024, // 短い3項目のJSONのみ返すため小さめで十分
      thinking: { type: 'adaptive' },
      output_config: { format: { type: 'json_schema', schema: ERROR_ANALYSIS_SCHEMA } },
      messages: [{ role: 'user', content }],
    });
    if (response.stop_reason === 'refusal') return null;
    const textBlock = (response.content || []).find((b) => b.type === 'text');
    if (!textBlock || !textBlock.text) return null;
    return JSON.parse(textBlock.text); // structured outputs でスキーマ準拠が保証される
  } catch (e) {
    console.warn('[ai] claude analyze error', e?.message ?? e);
    return null;
  }
}

// エラー解析の入口: Claude 優先 → OpenAI フォールバック → 両方無ければ null。
async function analyzeSalonboardError(args) {
  const viaClaude = await analyzeSalonboardErrorWithClaude(args);
  if (viaClaude) return viaClaude;
  return analyzeSalonboardErrorWithOpenAI(args);
}

// OpenAI Vision でエラー画面を解析し「なぜ起きたか」の推測を返す。
//   OPENAI_API_KEY 未設定なら null。画像(base64 data URL)+本文テキストを渡す。
async function analyzeSalonboardErrorWithOpenAI({ buffer, errorText, jobType, errorCode }) {
  const apiKey = openaiApiKey(); // env → ~/.kireidot/openai_api_key
  if (!apiKey) return null;
  try {
    const label = JOB_LABEL[jobType] || jobType || '操作';
    const content = [
      {
        type: 'text',
        text:
          `SalonBoard で「${label}」を自動操作中にエラーになりました。\n` +
          `エラーコード: ${errorCode || '不明'}\n` +
          `Workerが検知したエラー: ${String(errorText || '').slice(0, 800)}\n\n` +
          `添付のエラー画面スクリーンショットと、その画面に書かれているテキストを読み取り、` +
          `(1)画面に出ているエラーメッセージの要約 (2)考えられる原因の推測 (3)対処の提案 ` +
          `を日本語で簡潔に答えてください。`,
      },
    ];
    if (buffer && Buffer.isBuffer(buffer)) {
      content.push({
        type: 'image_url',
        image_url: { url: `data:image/png;base64,${buffer.toString('base64')}` },
      });
    }
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.OPENAI_VISION_MODEL || 'gpt-4.1-mini',
        max_tokens: 600,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              '次のJSON形式のみで日本語で答えてください: ' +
              '{"screen_message":"画面に出ているエラーメッセージの要約","probable_cause":"考えられる原因","suggested_action":"対処の提案"}',
          },
          { role: 'user', content },
        ],
      }),
    });
    if (!res.ok) {
      console.warn('[ai] openai error', res.status, (await res.text().catch(() => '')).slice(0, 200));
      return null;
    }
    const json = await res.json();
    const textOut = json?.choices?.[0]?.message?.content ?? '';
    try { return JSON.parse(textOut); } catch (_e) {
      const m = String(textOut).match(/\{[\s\S]*\}/);
      if (m) { try { return JSON.parse(m[0]); } catch (_e2) { /* noop */ } }
      return { raw: String(textOut).slice(0, 500) };
    }
  } catch (e) {
    console.warn('[ai] analyze error', e?.message ?? e);
    return null;
  }
}

// Slack へスクショをアップロード (files v2: getUploadURLExternal → PUT → completeUploadExternal)。
//   成功したらファイルが channel に表示される。initial_comment にエラー概要を載せる。
async function uploadScreenshotToSlack({ buffer, channel, filename, comment }) {
  const token = deviceAuth?.slack?.token;
  if (!token || !buffer || !Buffer.isBuffer(buffer)) return false;
  try {
    // 1) アップロードURL発行
    const u = new URLSearchParams({ filename: filename || 'error.png', length: String(buffer.length) });
    const r1 = await fetch('https://slack.com/api/files.getUploadURLExternal', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: u.toString(),
    });
    const j1 = await r1.json().catch(() => ({}));
    if (!j1.ok) { console.warn('[slack] getUploadURL failed', j1.error); return false; }
    // 2) バイナリをPUT
    const put = await fetch(j1.upload_url, { method: 'POST', body: buffer });
    if (!put.ok) { console.warn('[slack] upload PUT failed', put.status); return false; }
    // 3) 完了 (channel に投稿)
    const r3 = await fetch('https://slack.com/api/files.completeUploadExternal', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        files: [{ id: j1.file_id, title: filename || 'error.png' }],
        channel_id: channel,
        initial_comment: comment || undefined,
      }),
    });
    const j3 = await r3.json().catch(() => ({}));
    if (!j3.ok) { console.warn('[slack] completeUpload failed', j3.error); return false; }
    return true;
  } catch (e) {
    console.warn('[slack] upload error', e?.message ?? e);
    return false;
  }
}

// エラーコード → 人が読んで分かる原因カテゴリ。
const ERROR_CODE_CATEGORY = {
  RECAPTCHA_REQUIRED: '🧩 画像認証(reCAPTCHA)が表示され、自動操作が止まりました。手動でログイン/認証通過が必要です。',
  LOGIN_FAILED: '🔑 SalonBoard ログインに失敗しました。ID/パスワード、またはセッション切れの可能性。',
  SESSION_EXPIRED: '⌛ SalonBoard のセッションが切れていました。再ログインが必要です。',
  STORE_SELECT_REQUIRED: '🏬 グループ店舗のサロン選択に失敗しました。店舗設定のサロンID(H...)を確認してください。',
  STAFF_MAPPING_NOT_FOUND: '👤 SalonBoard スタッフの紐付けが見つかりません。スタッフ設定を確認してください。',
  BOOKING_ID_NOT_FOUND: '🆔 SalonBoard予約IDが未採番です。新規登録として再処理します。',
  PUSH_DISABLED: '🔒 実書き込み(実登録)がOFFのため確定していません。設定で有効化が必要です。',
  UNKNOWN_ERROR: '❓ 想定外のエラー(ポップアップ/画面崩れ/タイムアウト等)。添付スクショで画面を確認してください。',
};

// エラー時に「スクショ + 画面テキストAI判別 + 原因推測」を Slack 専用チャンネルへ送る。
//   毎回送る(重複抑制なし)。画像が撮れなければテキストのみ送る。
//   bookingInfo: { when?, customer?, shopName? } を渡すと予約の特定情報も載せる。
async function reportSalonboardErrorWithScreenshot({ jobType, status, errorCode, reason, bookingInfo }) {
  if (!slackEnabled()) return;
  try {
    const page = _errorCapturePage;
    const { buffer, text, url } = await captureErrorPageArtifacts(page);
    const ai = await analyzeSalonboardError({
      buffer,
      errorText: reason || text,
      jobType,
      errorCode,
    });
    const machine = (typeof machineId === 'function' ? machineId() : 'worker');
    const ver = (typeof appVersionFallback === 'function' ? appVersionFallback() : null);
    const label = JOB_LABEL[jobType] || jobType || 'ジョブ';
    const category = errorCode ? ERROR_CODE_CATEGORY[errorCode] : null;
    const bi = bookingInfo || {};
    const lines = [
      `:rotating_light: *SalonBoard エラー: ${label}*  (${machine}${ver ? ` v${ver}` : ''})`,
      `• 状態: ${status || 'failed'}${errorCode ? ` [${errorCode}]` : ''}`,
      category ? `• 種別: ${category}` : null,
      (bi.shopName || bi.when || bi.customer)
        ? `• 予約: ${[bi.shopName, bi.when, bi.customer].filter(Boolean).join(' / ')}`
        : null,
      reason ? `• Worker検知: ${String(reason).slice(0, 400)}` : null,
      url ? `• URL: ${url}` : null,
    ];
    if (ai) {
      if (ai.screen_message) lines.push(`• 画面メッセージ: ${ai.screen_message}`);
      if (ai.probable_cause) lines.push(`• 推測される原因(AI): ${ai.probable_cause}`);
      if (ai.suggested_action) lines.push(`• 対処の提案(AI): ${ai.suggested_action}`);
      if (ai.raw && !ai.screen_message) lines.push(`• AI: ${ai.raw}`);
    } else if (process.env.OPENAI_API_KEY) {
      lines.push(`• (AI解析は失敗またはスキップ)`);
    }
    const comment = lines.filter(Boolean).join('\n');
    const channel = slackErrorChannel();

    let uploaded = false;
    if (buffer) {
      uploaded = await uploadScreenshotToSlack({
        buffer,
        channel,
        filename: `sb-error-${jobType || 'job'}.png`,
        comment,
      });
    }
    // 画像が無い/アップロード失敗時はテキストだけでも必ず送る。
    if (!uploaded) {
      await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${deviceAuth.slack.token}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({ channel, text: comment }),
      }).catch(() => {});
    }
  } catch (e) {
    console.warn('[slack] error-report failed', e?.message ?? e);
  }
}

// emit されたイベントから「エラーとして Slack に送るべきもの」を判定して送る。
function maybeSlackFromEmit(type, payload) {
  if (!slackEnabled()) return;
  try {
    if (type === 'error') {
      const msg = payload?.msg ?? payload?.error ?? JSON.stringify(payload);
      void sendSlack(`エラー: ${msg}`);
      return;
    }
    if (type === 'log') {
      const lvl = payload?.level;
      if (lvl === 'error' || lvl === 'warn') {
        void sendSlack(`[${lvl}] ${payload?.msg ?? ''}`);
      }
      return;
    }
  } catch (_e) { /* noop */ }
}

function emit(type, payload) {
  try {
    process.parentPort?.postMessage({ type, payload });
  } catch (_e) {
    /* parent が居ない場合は無視 */
  }
  // エラー/警告は Slack にも飛ばす (本処理は止めない)。
  maybeSlackFromEmit(type, payload);
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
  slackToken,
  slackChannel,
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
    // Slack エラー通知。トークン+チャンネルが両方あるときだけ有効。
    // トークンがあれば有効化 (チャンネル未指定なら既定チャンネルへ送る)。
    slack: slackToken ? { token: slackToken, channel: slackChannel || null } : null,
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

  // どの Mac がどのバージョン/拡張状態で動いているかを Admin から把握できるよう、
  // 起動時+5分ごとにハートビートを送る (失敗は非致命)。
  startHeartbeat();

  // SalonBoard のアイドルタイムアウトでセッションが切れて毎回ログインし直すのを防ぐため、
  // 稼働時間帯 (6:00〜24:00) に 10 分ごとにセッションを延命する (v0.2.183)。
  startKeepAlive();

  // KIREIDOT にあって SalonBoard に無い予約を 10 分ごとに探査し、自動で push し直す。
  startUnpushedSweep();
}

// ---- Worker ハートビート (どのPCがどのバージョンで動いているかの可視化) ----
let heartbeatTimer = null;
const HEARTBEAT_INTERVAL_MS = 5 * 60_000;

// ---- アクティブ/待機 (フェイルオーバー切替, v0.2.153) ----
// 複数台で予約同期くんを起動しても、Admin (連携デバイス画面) でアクティブ指定
// された 1 台だけがジョブ処理/自動同期を行う。指定が無ければ全台アクティブ
// (従来挙動)。状態はハートビートのレスポンス {active} で5分ごとに更新され、
// push ジョブの claim は Admin 側 (X-Machine-Id 照合) でも弾かれる (即時切替)。
let workerActive = true;

/** このマシンの識別子 (ハートビート/X-Machine-Id 共通)。 */
function machineId() {
  try {
    return `${os.userInfo().username}@${os.hostname()}`;
  } catch (_e) {
    return os.hostname();
  }
}

/** アプリのバージョン。init で渡されなかった場合は package.json から読む
 * (ハートビートの app_version が null になりデバイス画面で確認できなかった対策)。 */
let _pkgVersion = null;
function appVersionFallback() {
  if (deviceAuth.appVersion) return deviceAuth.appVersion;
  if (_pkgVersion) return _pkgVersion;
  try { _pkgVersion = require('../package.json').version || null; } catch (_e) { _pkgVersion = null; }
  return _pkgVersion;
}

/** extension-bridge の /health を読む (main process が同一マシンで立てている)。 */
function fetchBridgeHealth() {
  return new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:32178/health', (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch (_e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(3000, () => { req.destroy(); resolve(null); });
  });
}

async function sendHeartbeat() {
  const headers = buildDeviceHeaders({ 'Content-Type': 'application/json' });
  if (!headers) return;
  try {
    const bridge = await fetchBridgeHealth();
    const body = {
      machine_id: machineId(),
      machine_name: os.hostname(),
      enable_push: !!deviceAuth.enablePush,
      extension_bridge_up: !!bridge?.ok,
      extension_last_poll_at: bridge?.extensionLastPollAt ?? null,
      extension_pending: bridge?.pending ?? null,
    };
    const res = await fetch(`${deviceAuth.apiBaseUrl}/api/salonboard/device/heartbeat`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    // Admin がアクティブ端末を返す (active=false なら待機モード)。
    // 旧Admin (active 無し) は undefined → アクティブ扱い (従来挙動)。
    let json = null;
    try { json = await res.json(); } catch (_e) { /* ignore */ }
    if (json && typeof json.active === 'boolean' && json.active !== workerActive) {
      workerActive = json.active;
      log(
        workerActive
          ? '🟢 この端末がアクティブになりました。ジョブ処理/自動同期を再開します。'
          : '⏸️ 待機モードになりました (別の端末がアクティブ)。ジョブ処理/自動同期を停止します。切替は Admin の連携デバイス画面から。',
        'info',
      );
    }
  } catch (_e) {
    // 非致命: ネットワーク断やAdmin未デプロイ時は黙ってスキップ。
  }
}

function startHeartbeat() {
  if (heartbeatTimer) return;
  void sendHeartbeat();
  heartbeatTimer = setInterval(() => { void sendHeartbeat(); }, HEARTBEAT_INTERVAL_MS);
  if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
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
          if (jt !== 'push_booking' && jt !== 'cancel_booking' && jt !== 'push_blog' && jt !== 'delete_blog' && jt !== 'push_photo_gallery' && jt !== 'push_review_reply' && jt !== 'push_shifts' && jt !== 'fetch_shift_patterns' && jt !== 'fetch_staff' && jt !== 'fetch_equipment' && jt !== 'fetch_reviews') return;
          log(`Realtime: ${jt} ジョブを検知 → push 処理を予約 (デバウンス)`, 'info');
          if (pushTriggerTimer) clearTimeout(pushTriggerTimer);
          pushTriggerTimer = setTimeout(() => {
            pushTriggerTimer = null;
            // 自動取得(sync)中でも push を即時開始する。runPushJobs は店舗ごとに
            //   tryAcquireShopLock で直列化されるため、取得中の店舗だけ待ち、
            //   それ以外の店舗の書き込みはすぐ進む。これで「取得中に予約すると
            //   sync 完了まで(最大十数分)待たされる」遅延を解消する。
            //   pushJobsRunning による二重起動防止は runPushJobs 内で行う。
            runPushJobs({ showBrowser: AUTO_PUSH_SHOW_BROWSER }).catch((e) =>
              log(`Realtime トリガーの push 処理でエラー: ${e?.message ?? e}`, 'warn'),
            );
          }, 600);
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
const PUSH_JOB_POLL_MS = 20_000;
function startPushJobPoller() {
  if (pushJobPollTimer) return; // 多重起動防止
  pushJobPollTimer = setInterval(async () => {
    try {
      // 二重起動だけ防ぐ。sync(running)中でも push を起動してよい
      //   (runPushJobs は店舗ごとに直列化されるため取得中の店舗のみ待つ)。
      if (!supabase || pushJobsRunning) return;
      const { count, error } = await supabase
        .from('salonboard_sync_jobs')
        .select('id', { count: 'exact', head: true })
        .in('job_type', ['push_booking', 'cancel_booking', 'push_blog', 'delete_blog', 'push_photo_gallery', 'push_review_reply', 'push_shifts', 'fetch_shift_patterns', 'fetch_staff', 'fetch_equipment', 'fetch_reviews'])
        .eq('status', 'queued');
      if (error) return;
      if ((count ?? 0) > 0) {
        log(`保険ポーリング: 未処理ジョブ ${count} 件を検知 → push 処理`, 'info');
        runPushJobs({ showBrowser: AUTO_PUSH_SHOW_BROWSER }).catch(() => {});
      }
    } catch (_e) { /* noop */ }
  }, PUSH_JOB_POLL_MS);
}

// ---- セッション キープアライブ (v0.2.183) ----
// SalonBoard は「一定時間操作されなかったため、ログインの有効期限が切れました」という
// アイドルタイムアウト (経験上およそ30分) を持つ。予約取得は数十分間隔 + 夜間停止のため、
// 間が空くとサーバ側セッションが失効し、次のジョブで毎回ログインし直すことになる。
// (再ログインは bot 検知/reCAPTCHA を誘発しやすく、所要も増える)
//
// 対策: 稼働時間帯 (6:00〜24:00) に 10 分ごとに各店舗の TOP を軽く開いて
//   (a) アイドルタイマーをリセットしてセッションを延命し、
//   (b) Cookie ローテーションに追従して storageState を保存し直す。
//   切れていれば 1 回だけ再ログインして storageState を保存する。
// これにより「次のジョブ時には既にログイン済み」を維持し、再ログイン頻度を下げる。
//
// 競合回避が肝:
//   - workerActive な端末のみ (待機端末が同時ログインして後勝ちで奪い合わない)
//   - running / pushJobsRunning 中はスキップ (取得/書込と同時にブラウザを立てない)
//   - 店舗ごとに tryAcquireShopLock で取得/書込と相互排他
//   - storageState が無い (一度もログインしていない) 店舗はスキップ (初回は取得時に任せる)
let keepAliveTimer = null;
let keepAliveRunning = false;
const KEEPALIVE_INTERVAL_MS = 10 * 60_000; // 10 分
const KEEPALIVE_ACTIVE_HOUR_START = 6; // 6:00
const KEEPALIVE_ACTIVE_HOUR_END = 24; // 24:00 (= 0:00 まで)

/** 現在が稼働時間帯 (6:00〜24:00) か。夜間はセッション維持も止める。 */
function isWithinKeepAliveHours() {
  const h = new Date().getHours();
  return h >= KEEPALIVE_ACTIVE_HOUR_START && h < KEEPALIVE_ACTIVE_HOUR_END;
}

/**
 * 1 店舗のセッションを延命する。logged_in ならアクセスのみ (延命) + storageState 再保存。
 * needs_login なら 1 回だけ再ログイン。captcha は触らずスキップ (6h ブロックは取得側に任せる)。
 */
async function keepAliveShop(target) {
  const shopId = target.shop_id;
  const genre = target.genre || 'esthetic';

  // 取得/書込と相互排他。ロックが取れない (処理中) ならスキップ。
  const label = `${deviceAuth?.workerId ?? 'electron-worker'}:keepalive`;
  const lock = tryAcquireShopLock(shopId, label);
  if (!lock.ok) return { shopId, skipped: 'locked' };

  let portLocked = false;
  let port = null;
  let createdNewTab = false;
  let page = null;
  try {
    let creds;
    try {
      creds = await revealCredentials(shopId);
    } catch (_e) {
      return { shopId, skipped: 'no_credentials' };
    }

    const profile = await fetchChromeProfile(shopId);
    port = Number(profile.debugPort || process.env.SALONBOARD_CHROME_DEBUG_PORT || defaultDebugPortForShop(shopId));
    const portLock = tryAcquireChromePortLock(port, label);
    if (!portLock.ok) return { shopId, skipped: 'port_locked' };
    portLocked = true;

    // 予約書込と同じ店舗専用Chromeを起動/再利用する。別ブラウザでログインすると
    // SalonBoardの1ログインID=1セッション制約で本番ジョブをログアウトさせるため禁止。
    const managed = await connectToUserChrome({
      shopId,
      profileNo: profile.profileNo,
      debugPort: profile.debugPort,
    });
    const acquired = await acquireSalonboardPage(managed);
    page = acquired.page;
    createdNewTab = acquired.createdNewTab;

    const state = await isLoggedIn(page, creds.baseUrl, genre);
    if (state === 'logged_in') {
      return { shopId, result: 'alive' };
    }
    if (state === 'captcha') {
      // captcha はここでは触らない (再ログイン連打しない)。取得側の処理に委ねる。
      return { shopId, result: 'captcha' };
    }
    // needs_login / unknown: 専用Chrome内で1回だけ再ログイン。
    const r = await tryLogin(page, { ...creds, slow: true });
    if (r.status === 'ok') {
      return { shopId, result: 'relogin' };
    }
    return { shopId, result: `relogin_failed:${r.status}` };
  } catch (e) {
    return { shopId, error: e?.message ?? String(e) };
  } finally {
    if (createdNewTab && page) await page.close().catch(() => {});
    if (portLocked && port) releaseChromePortLock(port);
    releaseShopLock(shopId);
  }
}

/** 全店舗のセッションを順番に延命する (店舗間は直列。1 アカウント=1 セッションの競合を避ける)。 */
async function keepSessionsAlive() {
  if (!supabase || keepAliveRunning) return;
  if (!workerActive) return; // 待機端末は触らない (後勝ち競合を避ける)
  if (running || pushJobsRunning) return; // 取得/書込中はブラウザを立てない
  if (!isWithinKeepAliveHours()) return; // 夜間は停止
  if (!buildDeviceHeaders()) return; // device 未設定

  keepAliveRunning = true;
  try {
    let targets = [];
    try {
      targets = await fetchTargets(null);
    } catch (_e) {
      return; // device 未設定/ネットワーク断などは黙ってスキップ
    }
    if (!targets.length) return;

    let alive = 0;
    let relogin = 0;
    for (const t of targets) {
      // ループ中に取得/書込が始まったら中断 (優先度を譲る)。
      if (running || pushJobsRunning || !workerActive) break;
      const res = await keepAliveShop(t).catch((e) => ({ error: e?.message ?? e }));
      if (res?.result === 'alive') alive++;
      else if (res?.result === 'relogin') relogin++;
    }
    if (alive || relogin) {
      log(`セッション維持: 継続 ${alive} 店舗 / 再ログイン ${relogin} 店舗`, 'info');
    }
  } finally {
    keepAliveRunning = false;
  }
}

function startKeepAlive() {
  if (keepAliveTimer) return; // 多重起動防止
  keepAliveTimer = setInterval(() => {
    void keepSessionsAlive();
  }, KEEPALIVE_INTERVAL_MS);
  if (typeof keepAliveTimer.unref === 'function') keepAliveTimer.unref();
  // 起動直後にも全店舗の専用Chromeを準備し、最初のフォールバックジョブが
  // Chrome起動/ログイン待ちを負担しないようにする。
  const initial = setTimeout(() => { void keepSessionsAlive(); }, 15_000);
  if (typeof initial.unref === 'function') initial.unref();
}

// ---- 未反映予約スイープ (v0.2.183) ----
// KIREIDOT にあって SalonBoard にまだ無い予約 (push が failed / manual_required /
// 未送信のまま残ったもの) を 10 分ごとに探査し、自動で push し直す。
//
// DBトリガー (bookings_autoenqueue_salonboard_push) は「予約作成時」に 1 度だけ
// ジョブを積むため、一度 push に失敗した予約は再ジョブ化されず、差分監視の Slack に
// 出続けるだけだった。ここで RPC salonboard_sweep_reenqueue_unpushed を叩いて
// 最大 10 件まで push_booking ジョブ (preflight_required=true) を再 enqueue する。
// preflight により Worker は登録前に SB 予約一覧を照合し、既にあれば二重登録しない。
// 「スタッフ/メニュー未紐付け」など再試行で直らないエラーは RPC 側で除外済み
// (Admin の予約画面に manual_required として残り、手動対応を促す)。
let sweepTimer = null;
let sweepRunning = false;
const SWEEP_INTERVAL_MS = 10 * 60_000; // 10 分
const SWEEP_LIMIT = 10; // 1 回あたり最大 10 件

async function sweepUnpushedBookings() {
  if (!supabase || sweepRunning) return;
  if (!workerActive) return; // 待機端末は触らない
  if (!isWithinKeepAliveHours()) return; // 夜間は停止 (取得と同じ 6:00〜24:00)
  if (!buildDeviceHeaders()) return; // device 未設定
  sweepRunning = true;
  try {
    const { data, error } = await supabase.rpc('salonboard_sweep_reenqueue_unpushed', {
      p_limit: SWEEP_LIMIT,
      p_machine: machineId(),
    });
    if (error) {
      log(`未反映予約スイープ: RPC エラー ${error.message}`, 'warn');
      return;
    }
    const enqueued = Number(data ?? 0);
    if (enqueued > 0) {
      log(`未反映予約スイープ: SalonBoard 未反映の予約 ${enqueued} 件を再 push キューに投入`, 'info');
      // 実行中でなければ即 push 処理を起動 (Realtime/保険ポーリングでも拾われる)。
      if (!running && !pushJobsRunning) {
        runPushJobs({ showBrowser: AUTO_PUSH_SHOW_BROWSER }).catch((e) =>
          log(`スイープ後の push 処理でエラー: ${e?.message ?? e}`, 'warn'),
        );
      }
    }
  } catch (e) {
    log(`未反映予約スイープでエラー: ${e?.message ?? e}`, 'warn');
  } finally {
    sweepRunning = false;
  }
}

function startUnpushedSweep() {
  if (sweepTimer) return; // 多重起動防止
  sweepTimer = setInterval(() => {
    void sweepUnpushedBookings();
  }, SWEEP_INTERVAL_MS);
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
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
    ...(appVersionFallback() ? { 'X-App-Version': appVersionFallback() } : {}),
    'X-Platform': deviceAuth.platform ?? process.platform,
    // アクティブ/待機切替の照合用 (Admin jobs API が待機端末の claim を弾く)。
    'X-Machine-Id': machineId(),
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
      // 運営(Super Admin)が会社ごとに無効化した連携チャンネル
      // (bookings/staff/shifts/menus/coupons/reviews/equipment)。
      // runSync がこのチャンネルをスキップする。
      disabled_channels: Array.isArray(s.disabled_channels) ? s.disabled_channels : [],
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
  const syncLaunchBase = {
    headless: !showBrowser,
    slowMo: showBrowser ? 250 : 0,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-features=IsolateOrigins,site-per-process',
    ],
  };
  let browser;
  try {
    browser = await chromium.launch(browserLaunchOptions(syncLaunchBase));
  } catch (e) {
    // 実Chrome(channel:'chrome')が無い等で失敗したら同梱Chromiumで起動。
    if (USE_SYSTEM_CHROME) emit('log', { level: 'warn', msg: `実Chrome起動失敗→同梱Chromiumで続行: ${e?.message ?? e}`, at: new Date().toISOString() });
    browser = await chromium.launch(syncLaunchBase);
  }
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
    // ログイン後 /(CNC|KLP)/groupTop/ に着地する場合は対象サロンを選択してから取得する。
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
        const { rows, debug } = await scrapeStaff(page, { genre, salonId: creds.salonId ?? null, shopName });
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
        const { rows, debug } = await scrapeMenus(page, { genre, salonId: creds.salonId ?? null, shopName });
        const sent = await sendMenus(shopId, rows);
        counts.menus = sent;
        // 美容室(hair)はスタイル一覧を画像付きで salonboard_style_imports にも保存する
        // (フォトギャラリー画面で「SalonBoard スタイル一覧」を表示するため)。最大100件。
        if (genre === 'hair') {
          try {
            const sentStyles = await sendStyles(shopId, rows);
            emit('shop:progress', { shopId, step: 'menus', msg: `スタイル画像 ${sentStyles} 件保存` });
          } catch (e) {
            emit('log', { level: 'warn', msg: `[${shopId.slice(0, 8)}] style import error: ${e instanceof Error ? e.message : e}`, at: new Date().toISOString() });
          }
        } else {
          // エステ等(非hair)はフォトギャラリーを画像付きで salonboard_photo_gallery_imports に保存。
          // (フォトギャラリー画面で「SalonBoard フォトギャラリー一覧」を表示するため)。最大100件。
          try {
            emit('shop:progress', { shopId, step: 'menus', msg: 'フォトギャラリーを取得中…' });
            const { rows: galleryRows } = await scrapePhotoGallery(page, { genre, salonId: creds.salonId ?? null, shopName });
            const sentGallery = await sendPhotoGalleries(shopId, galleryRows);
            emit('shop:progress', { shopId, step: 'menus', msg: `フォトギャラリー ${sentGallery} 件保存` });
          } catch (e) {
            emit('log', { level: 'warn', msg: `[${shopId.slice(0, 8)}] photo gallery import error: ${e instanceof Error ? e.message : e}`, at: new Date().toISOString() });
          }
        }
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

    if (channelSet.has('reviews')) {
      try {
        emit('shop:progress', { shopId, step: 'reviews', msg: '口コミを取得中…' });
        const { rows, debug } = await scrapeReviews(page, { genre });
        const sent = await sendReviews(shopId, rows);
        counts.reviews = sent;
        summary.push(`口コミ ${sent} 件 (検出${debug?.itemsFound ?? rows.length})`);
        emit('log', {
          level: debug?.itemsFound ? 'info' : 'warn',
          msg: `[${shopId.slice(0, 8)}] review scrape: 検出${debug?.itemsFound ?? 0}件 / ${debug?.pagesVisited ?? 0}ページ巡回(全${debug?.totalPages ?? '?'}) / url=${debug?.url ?? '?'}`,
          at: new Date().toISOString(),
        });
        emit('shop:progress', { shopId, step: 'reviews', msg: `口コミ ${sent} 件保存` });
      } catch (e) {
        emit('log', {
          level: 'warn',
          msg: `[${shopId.slice(0, 8)}] review scrape error: ${e instanceof Error ? e.message : e}`,
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
      // 勤務パターンの取得は毎時同期では行わない (Adminのシフトパターン設定の
      // 「SalonBoardから同期」ボタン = fetch_shift_patterns ジョブでのみ取得)。
    }

    // 美容室(hair)は設備の概念がない(スタイリストベース)ため設備取得をスキップ
    if (channelSet.has('equipment') && genre !== 'hair') {
      try {
        emit('shop:progress', { shopId, step: 'equipment', msg: '設備一覧を取得中…' });
        const { rows, debug } = await scrapeEquipment(page, { genre, salonId: creds.salonId ?? null, shopName });
        const sent = await sendEquipment(shopId, rows);
        counts.equipment = sent;
        summary.push(`設備 ${sent} 件 (検出${rows.length})`);
        emit('shop:progress', { shopId, step: 'equipment', msg: `設備 ${sent} 件保存` });
      } catch (e) {
        emit('log', {
          level: 'warn',
          msg: `[${shopId.slice(0, 8)}] equipment scrape error: ${e instanceof Error ? e.message : e}`,
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
 * /(CNC|KLP)/groupTop/ の「サロン選択」画面 (美容室=CNC, エステ=KLP)に着地する。各サロンは
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
  let onGroupTop = /\/(?:CNC|KLP)\/groupTop/i.test(page.url());
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
  const stillGroup = /\/(?:CNC|KLP)\/groupTop/i.test(page.url());
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
  // フォーム出現を主軸にする。従来は 60+45+45 秒待ち、nav 自体が成功して
  // selector だけ出ない場合は失敗判定も漏れていたため「無限ロード」に見えた。
  // 1回20秒・最大2回で明示的に打ち切り、ジョブ側のリトライへ返す。
  //
  // ★既ログイン検出 (2026-07-20 修正): セッションが既に有効な状態でログインURLを
  //   開くと SalonBoard は管理画面トップへリダイレクトし、パスワード欄は永遠に
  //   出ない。旧実装はこれを「フォームが見えない=失敗」と誤判定し、リトライ時に
  //   page.goto('about:blank') で画面を破壊していた (「ログイン直後に about:blank
  //   に飛んで真っ白」の原因。手動ログイン完了直後にパスワード欄が消えるケースも
  //   同じ経路で破壊された)。→ パスワード欄が見えないときはまず「ログイン済みか」
  //   を確認し、済みなら成功として返す。about:blank への退避遷移は廃止。
  const alreadyLoggedIn = async () => {
    try {
      if (/login/i.test(page.url())) return false;
      const pw = await page
        .locator('input[type="password"], input[name="password"]')
        .count()
        .catch(() => 0);
      if (pw > 0) return false;
      return await page.evaluate(() => {
        const body = (document.body && document.body.innerText) || '';
        // 管理画面グローバルナビの定番メニューが並んでいればログイン済みとみなす
        return /予約管理/.test(body) && /(お客様管理|売上管理|メッセージ管理|設定)/.test(body);
      });
    } catch (_e) {
      return false;
    }
  };

  const MAX_ATTEMPTS = 2;
  let formVisible = false;
  let lastNavError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let navError = null;
    const navPromise = page
      .goto(c.baseUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 })
      .catch((e) => {
        navError = e;
      });
    try {
      await page.waitForSelector('input[type="password"], input[name="password"]', {
        state: 'visible',
        timeout: 20_000,
      });
      // 入力欄が見えた → 成功
      await Promise.race([
        navPromise,
        new Promise((r) => setTimeout(r, 3_000)),
      ]);
      lastNavError = null;
      formVisible = true;
      break;
    } catch (_e) {
      await navPromise.catch(() => {});
      // ログイン済みでトップへリダイレクトされた (=フォームは出ない) なら成功。
      if (await alreadyLoggedIn()) {
        return { status: 'ok', alreadyLoggedIn: true };
      }
      lastNavError = navError;
      if (attempt < MAX_ATTEMPTS) {
        // 少し待ってからリトライ (バックオフ)。表示中ページは壊さない。
        await new Promise((r) => setTimeout(r, 1_500));
      }
    }
  }
  if (!formVisible) {
    if (await alreadyLoggedIn()) {
      return { status: 'ok', alreadyLoggedIn: true };
    }
    return {
      status: 'failed',
      reason: `login form not visible within 40s after ${MAX_ATTEMPTS} attempts (url=${page.url()}${
        lastNavError ? `, navigation=${lastNavError instanceof Error ? lastNavError.message : lastNavError}` : ''
      })`,
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
    // ★パスワードマネージャー自動入力対応 (2026-07-20):
    //   Chrome が保存済みログイン情報を自動入力していると、pressSequentially は
    //   既存値の後ろに「追記」するため ID/パスワードが二重になりログインに失敗
    //   していた。さらに旧検証は「長さが足りていればOK」で混在値を見逃していた。
    //   → 既に期待値が入っていれば触らない。違う値ならクリアしてから入力し、
    //     入力後は期待値との厳密一致で検証する。
    const current = await loc.inputValue().catch(() => '');
    if (current === v) return true; // 自動入力済み → そのまま使う (二重入力しない)
    if (slow) {
      await loc.click({ timeout: 8_000 }).catch(() => {});
      await wait(500);
      try {
        if (current) await loc.fill('', { timeout: 8_000 }); // 自動入力の既存値をクリア
        await loc.pressSequentially(v, { delay: 120, timeout: 8_000 });
        // 期待値との厳密一致で検証 (自動入力との混在・欠落を検出)
        const got = await loc.inputValue().catch(() => '');
        if (got === v) return true;
      } catch (_e) { /* fallthrough to fill */ }
    }
    // 通常 / フォールバック: fill は既存値を置き換えるので二重入力にならない
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
        await loc.click({ timeout: 5_000, noWaitAfter: true });
        clicked = true;
        break;
      } catch (_e) {
        // 次の候補を試す
      }
    }
    // SalonBoard側のオーバーレイやアニメーションでPlaywrightのactionability判定が
    // 通らない場合でも、公式画面上にあるログイン要素をDOMから直接クリックする。
    if (!clicked) {
      clicked = await page.evaluate(() => {
        const candidates = Array.from(document.querySelectorAll('a, button, input[type="submit"]'));
        const target = candidates.find((el) => {
          const text = String(el.textContent || el.getAttribute('value') || '').trim();
          return el.matches('a.common-CNCcommon__primaryBtn, a.loginBtnSize') || text === 'ログイン';
        });
        if (!target) return false;
        target.click();
        return true;
      }).catch(() => false);
    }
    // 直接クリックと同時にnavigationしてevaluateのcontextが破棄された場合は、
    // クリック自体は成功している。URL遷移/パスワード欄消失を成功として扱う。
    if (!clicked) {
      await wait(500);
      const leftLogin = !/\/login\/?/i.test(page.url()) || (await pwInput.count().catch(() => 0)) === 0;
      if (leftLogin) clicked = true;
    }
    if (!clicked) {
      // 最終フォールバック: password 欄で Enter (onkeypress="enterActionLogin")
      if (await pwInput.isVisible().catch(() => false)) {
        await pwInput.press('Enter', { timeout: 5_000, noWaitAfter: true });
        clicked = true;
      } else {
        return {
          status: 'failed',
          reason: `login submit control disappeared before submit (url=${page.url()})`,
        };
      }
    }
    // networkidle はSalonBoardの常時通信で返らないことがある。URL遷移または
    // password欄消失のどちらかを最大25秒だけ待ち、以降は明示的に失敗させる。
    await Promise.race([
      page.waitForURL((u) => !/\/login\/?/i.test(u.toString()) && !/doLogin/i.test(u.toString()), { timeout: 25_000 }),
      pwInput.waitFor({ state: 'detached', timeout: 25_000 }),
    ]).catch(() => {});
  } catch (e) {
    return { status: 'failed', reason: `submit: ${e instanceof Error ? e.message : e}` };
  }

  if ((await page.locator('iframe[src*="recaptcha"]').count()) > 0) {
    return { status: 'captcha' };
  }

  const stillOnLogin =
    (await pwInput.count()) > 0 || /login/i.test(page.url());
  if (stillOnLogin) {
    return { status: 'failed', reason: `login submit did not complete within 25s (url=${page.url()})` };
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

async function sendEquipment(shopId, rows) {
  if (!rows || rows.length === 0) return 0;
  const valid = rows.filter((r) => r.external_id && r.name);
  if (valid.length === 0) return 0;
  const { error } = await supabase.rpc('salonboard_bulk_upsert_equipment', {
    p_shop_id: shopId,
    p_rows: valid,
  });
  if (error) {
    emit('log', {
      level: 'error',
      msg: `bulk_upsert_equipment: ${error.message}`,
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

/**
 * 美容室スタイル(scrapeStyles の rows)を salonboard_style_imports に upsert する。
 * フォトギャラリー画面で「SalonBoard スタイル一覧」を画像付きで表示するための取込。
 * 既存の sendMenus(menus 取込) はそのまま残し、これは画像付きの別保存先。
 */
async function sendStyles(shopId, rows) {
  if (!rows || rows.length === 0) return 0;
  const valid = rows
    .filter((r) => r.external_id && r.name)
    .slice(0, 100)
    .map((r) => ({
      external_id: r.external_id,
      name: r.name,
      image_url: r.image_url ?? null,
      image_external_id: r.image_external_id ?? null,
      length: r.length ?? null,
      stylist_name: r.stylist_name ?? null,
      coupon_external_id: r.coupon_external_id ?? null,
    }));
  if (valid.length === 0) return 0;
  const { error } = await supabase.rpc('salonboard_bulk_upsert_styles', {
    p_shop_id: shopId,
    p_rows: valid,
  });
  if (error) {
    emit('log', {
      level: 'error',
      msg: `bulk_upsert_styles: ${error.message}`,
      at: new Date().toISOString(),
    });
    return 0;
  }
  return valid.length;
}

/**
 * エステ等のフォトギャラリー(scrapePhotoGallery の rows)を
 * salonboard_photo_gallery_imports に upsert する。最大100件。
 * 予約同期くん/Admin のフォトギャラリー画面で画像付き一覧表示する。
 */
async function sendPhotoGalleries(shopId, rows) {
  if (!rows || rows.length === 0) return 0;
  const valid = rows
    .filter((r) => r.external_id)
    .slice(0, 100)
    .map((r) => ({
      external_id: r.external_id,
      title: r.title ?? null,
      caption: r.caption ?? null,
      image_url: r.image_url ?? null,
      image_external_id: r.image_external_id ?? null,
      genre_code: r.genre_code ?? null,
      is_published: r.is_published !== false,
    }));
  if (valid.length === 0) return 0;
  const { error } = await supabase.rpc('salonboard_bulk_upsert_photo_galleries', {
    p_shop_id: shopId,
    p_rows: valid,
  });
  if (error) {
    emit('log', {
      level: 'error',
      msg: `bulk_upsert_photo_galleries: ${error.message}`,
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

async function sendReviews(shopId, rows) {
  if (!rows || rows.length === 0) return 0;
  const valid = rows.filter((r) => r.external_id);
  if (valid.length === 0) return 0;
  const { error } = await supabase.rpc('salonboard_bulk_upsert_reviews', {
    p_shop_id: shopId,
    p_rows: valid,
  });
  if (error) {
    emit('log', {
      level: 'error',
      msg: `bulk_upsert_reviews: ${error.message}`,
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

// SalonBoard の勤務パターン (S…/名前/時間帯) を DB へ upsert する。
// 紐付け (matched_preset_id) は DB 側で保持される。
async function sendShiftPatterns(shopId, rows) {
  if (!supabase) return { sent: 0, error: 'supabase 未初期化' };
  if (!rows || rows.length === 0) return { sent: 0, error: null };
  const valid = rows.filter((r) => r.external_id);
  if (valid.length === 0) return { sent: 0, error: 'external_id を持つ行がありません' };
  const { error } = await supabase.rpc('salonboard_bulk_upsert_shift_patterns', {
    p_shop_id: shopId,
    p_rows: valid,
  });
  if (error) {
    emit('log', {
      level: 'warn',
      msg: `bulk_upsert_shift_patterns: ${error.message}`,
      at: new Date().toISOString(),
    });
    return { sent: 0, error: error.message };
  }
  return { sent: valid.length, error: null };
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
  // 待機モード (別の端末がアクティブ): ジョブ処理しない。
  if (!workerActive) {
    log('予約書き込み: 待機モードのためスキップ (アクティブ端末が処理します)', 'info');
    return;
  }
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
  const runOneInner = async (job) => {
    const payload = job.payload || {};
    const creds = job.credentials || {};
    const baseUrl = creds.base_url || 'https://salonboard.com/';
    const tag = `push ${String(job.id).slice(0, 8)} booking=${String(payload.booking_id || '').slice(0, 8)}`;
    // Slack エラー通知に載せる予約特定情報 (人が「どの予約か」分かるように)。
    _currentJobInfo = {
      shopName: job.shop_name || null,
      when: payload.scheduled_at
        ? new Date(payload.scheduled_at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })
        : null,
      customer: payload.customer_name || payload.customer_code || null,
    };
    emit('log', { level: 'info', msg: `[${tag}] 開始 (enablePush=${enablePush})`, at: new Date().toISOString() });

    // ---- 美容室スタイル投稿(kind=style)は Chrome拡張(普段使いChrome)を優先 ----
    // 予約同期くんが起動するPlaywright ChromeだとAkamaiに画像アップロードを
    // 弾かれるため。拡張が使えないときだけ従来のPlaywright方式に落ちる。
    if (job.job_type === 'push_photo_gallery' && payload.kind === 'style' && !EXT_STYLE_DISABLED) {
      const ext = await runStyleJobViaExtension({
        payload, creds, shopName: job.shop_name ?? null, enablePost: enablePush, tag,
      });
      if (ext.handled) {
        const cap = job.max_attempts || 3;
        const exhausted = (job.attempts || 0) + 1 >= cap;
        if (ext.status === 'ok') {
          await postCallback({
            job_id: job.id, job_type: 'push_photo_gallery', status: 'succeeded',
            content_post_id: null,
            external_id: ext.externalId ?? null,
            summary: 'push_photo_gallery 投稿完了 (Chrome拡張)',
          });
          emit('log', { level: 'info', msg: `[${tag}] ✅ スタイル投稿完了 — Chrome拡張(普段使いChrome)${ext.externalId ? ` (id=${ext.externalId})` : ''}`, at: new Date().toISOString() });
        } else if (ext.status === 'confirm_only') {
          await postCallback({
            job_id: job.id, job_type: 'push_photo_gallery', status: 'manual_required',
            error_code: 'PUSH_DISABLED',
            error: '入力まで成功しましたが、実登録(実書込)が無効のため投稿していません。設定で有効化してください。',
            manual_required: true,
          });
          emit('log', { level: 'warn', msg: `[${tag}] 🟡 スタイル入力のみ (実登録OFF, Chrome拡張)`, at: new Date().toISOString() });
        } else {
          const toManual = shouldPromoteToManual(ext.manualRequired, exhausted, ext.errorCode);
          await postCallback({
            job_id: job.id, job_type: 'push_photo_gallery',
            status: ext.errorCode === 'RECAPTCHA_REQUIRED' ? 'captcha_detected' : toManual ? 'manual_required' : 'retryable_failed',
            error_code: ext.errorCode, error: ext.reason, manual_required: toManual,
          });
          emit('log', { level: 'warn', msg: `[${tag}] 🔴 スタイル投稿失敗 (Chrome拡張): [${ext.errorCode}] ${ext.reason}`, at: new Date().toISOString() });
        }
        return;
      }
      // handled=false → 従来の Playwright 方式へフォールバック (以下続行)。
    }

    // ★事前ガード: push_booking(新規/変更)は SalonBoard スタッフ external_id が
    //   無いと必ず失敗する。ブラウザを起動してログインしてから失敗すると
    //   「予約画面を立ち上げた瞬間に消える」体験になり、無駄にSBへログインもする。
    //   起動前に弾いて手動対応エラーを返す(ブラウザを開かない)。
    if (job.job_type === 'push_booking' && !payload.salonboard_staff_external_id) {
      emit('log', { level: 'warn', msg: `[${tag}] 🟡 担当スタッフがSalonBoardに紐付いていないため書き込みをスキップ (booking=${String(payload.booking_id || '').slice(0, 8)})`, at: new Date().toISOString() });
      await postCallback({
        job_id: job.id, job_type: 'push_booking',
        status: 'manual_required', booking_id: payload.booking_id,
        error_code: 'STAFF_MAPPING_NOT_FOUND', manual_required: true,
        error: '担当スタッフがSalonBoardのスタイリストに紐付いていないため、SalonBoardへ反映できません。スタッフ管理でSalonBoardスタッフと紐付けてください。',
      });
      return;
    }

    let browser = null;
    // CDP接続はジョブ間で再利用する。ジョブが新規作成したタブだけを閉じる。
    let cdpConnected = false;
    let createdNewTab = false;
    let cdpPage = null; // acquireSalonboardPage で得た page を finally 側で閉じるため保持
    // CDP 接続時は「タブを閉じて接続を切る」、非CDP時は従来どおり browser を閉じる共通処理。
    const cleanupBrowser = async () => {
      try {
        if (cdpConnected) {
          if (createdNewTab && cdpPage) { try { await cdpPage.close(); } catch (_e) {} }
          // browser.close() は常駐Chrome本体を終了し得るため呼ばない。
        } else if (browser) {
          await browser.close().catch(() => {});
        }
      } catch (_e) { /* noop */ }
    };
    try {
      const pushArgs = [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-features=IsolateOrigins,site-per-process',
      ];
      // ★CDP 接続方式 (2026-07-20): 店舗ごとに「別プロファイル + 別ポート」の
      //   起動中 Chrome へ接続して操作する。Super Admin / 予約同期くん で設定した
      //   chrome_profile_no / chrome_debug_port を使い、その店舗専用の Chrome へ
      //   connectOverCDP。既存のログイン済みタブ・Cookie・セッションをそのまま使う。
      //   店舗ごとに Chrome が独立するため、店舗間で完全並列に処理できる。処理後も
      //   Chrome 本体は閉じない (タブだけ閉じる)。
      const { profileNo, debugPort } = await fetchChromeProfile(job.shop_id);
      const launched = await connectToUserChrome({ shopId: job.shop_id, profileNo, debugPort });
      browser = launched.browser;
      const ctx = launched.context;
      cdpConnected = true; // finally で「接続を切るだけ (Chrome は閉じない)」判定に使う
      emit('log', { level: 'info', msg: `[${tag}] 既存Chrome(CDP)に接続: profile="${launched.profile}" port=${launched.port}`, at: new Date().toISOString() });
      const ssPath = storageStatePathFor(job.shop_id);
      // 店舗用 Chrome の Cookie/ログインは Chrome 自身が保持している。
      // storageState 注入は不要 (むしろ既存セッションを壊すのでしない)。
      // worker 専用の作業タブ (接続キャッシュに保持) をジョブ間で使い回す。
      const acquired = await acquireSalonboardPage(launched);
      const page = acquired.page;
      createdNewTab = acquired.createdNewTab;
      cdpPage = page;
      // 失敗時のエラー画面スクショ取得用に現在の page を保持 (postCallback が使う)。
      _errorCapturePage = page;
      // 前ジョブの失敗スクショが残っていると誤って送ってしまうのでクリア。
      // 以降 captureScrapeDebug が失敗地点で撮ったショットだけが採用される。
      try { resetLastErrorShot?.(); } catch (_e) { /* noop */ }

      // ※ ここでは page レベルの dialog ハンドラは張らない。
      //   各フォーム helper が操作の直前に on('dialog')→直後に off('dialog') で
      //   confirm を accept して送信確定する設計のため、ここで常駐ハンドラを足すと
      //   (1) 登録順で先に発火して helper より早く閉じてしまい確定フローを壊す
      //   (2) 何もしないハンドラだと Playwright の自動 dismiss が抑止され、
      //       helper 窓外のダイアログでフリーズする —— という副作用が出る。
      //   ポップアップ/認証で止まったケースは、失敗時の captureErrorShot による
      //   スクショ(=その画面)で Slack に残るので、観測はそちらに任せる。

      // ログイン (セッション切れなら再ログイン)。
      // ★genre を渡すのが重要: 美容室(hair)で /KLP/top/ を先に開くと毎回再ログインを
      //   誘発し「ログイン直後にセッションが切れる」症状になる。jobs API が返す
      //   job.genre (shops.genre 由来) で TOP URL を出し分ける。
      const jobGenre = job.genre === 'hair' ? 'hair' : 'esthetic';
      let auth = await isLoggedIn(page, baseUrl, jobGenre);
      if (auth === 'captcha') {
        await postCallback({
          job_id: job.id, status: 'captcha_detected', booking_id: payload.booking_id,
          error_code: 'RECAPTCHA_REQUIRED', error: 'captcha at landing', manual_required: true,
        });
        await cleanupBrowser();
        return;
      }
      if (auth !== 'logged_in') {
        // 書き込み(push_booking)時もゆっくりログイン (bot 検知回避)。
        const lr = await tryLogin(page, { baseUrl: new URL('/login/', baseUrl).toString(), loginId: creds.login_id, password: creds.password, slow: true });
        if (lr.status === 'captcha') {
          await postCallback({ job_id: job.id, status: 'captcha_detected', booking_id: payload.booking_id, error_code: 'RECAPTCHA_REQUIRED', error: 'captcha at login', manual_required: true });
          await cleanupBrowser();
          return;
        }
        if (lr.status === 'failed') {
          await postCallback({ job_id: job.id, status: 'login_required', booking_id: payload.booking_id, error_code: 'LOGIN_FAILED', error: lr.reason || 'login failed', manual_required: true });
          await cleanupBrowser();
          return;
        }
        // CDP 接続 (既存 Chrome) では Cookie/セッションは Chrome 自身が保持するため、
        // storageState を別ファイルに保存/注入しない (既存セッションを壊さない)。
      }

      // グループ店舗(1ログイン複数サロン): /(CNC|KLP)/groupTop/ に着地したら対象サロンを選択。
      // 単一店舗ログインなら no-op。失敗時は誤店舗への書き込みを避けて manual_required。
      try {
        // Cloud worker と同じ堅牢なグループ店舗選択を使う。
        // 旧 ensureStoreSelected は groupTop のAJAX読込を待たず、リンクを1回クリック
        // した直後に still_on_group_top を返していたため、正しいHコードが登録済みの
        // ADER開発/郡山でもフォト投稿だけ失敗していた。共通実装はリンク待機・再読込・
        // force再クリック・hair管理TOPの肯定確認まで行う。
        const sel = await ensureSalonSelected(page, {
          salonId: creds.salon_id ?? null,
          shopName: job.shop_name ?? null,
          genre: jobGenre,
          baseUrl,
        });
        if (!sel.ok) {
          await postCallback({
            job_id: job.id, job_type: job.job_type, status: 'manual_required',
            booking_id: payload.booking_id, content_post_id: payload.content_post_id ?? null,
            error_code: 'STORE_SELECT_REQUIRED',
            error: `グループ店舗のサロン選択に失敗 (${sel.reason ?? 'unknown'})。`,
            manual_required: true,
          });
          emit('log', { level: 'warn', msg: `[${tag}] 🟡 サロン選択失敗: ${sel.reason}`, at: new Date().toISOString() });
          await cleanupBrowser();
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
      const isReviewReply = job.job_type === 'push_review_reply';
      const isShifts = job.job_type === 'push_shifts';
      const isFetchShiftPatterns = job.job_type === 'fetch_shift_patterns';
      const isFetchStaff = job.job_type === 'fetch_staff';
      const isFetchEquipment = job.job_type === 'fetch_equipment';
      const isFetchReviews = job.job_type === 'fetch_reviews';
      const isCancel = job.job_type === 'cancel_booking';
      // create完了前に予約日時/担当が更新されると、旧DB trigger が action=update を
      // 追加することがある。external_booking_id が無い予約はSB上の変更対象を一意に
      // 指せないため、Cloud workerと同じく新規登録(preflight付き)として扱う。
      // pushBookingViaForm は既存予約を先に検索するため、SBへ既に登録済みでも二重登録しない。
      const isUpdate =
        job.job_type === 'push_booking' &&
        payload.action === 'update' &&
        String(payload.external_booking_id || '').trim().length > 0;

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
          const toManual = shouldPromoteToManual(result.manualRequired, exhausted, result.errorCode);
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
          const toManual = shouldPromoteToManual(result.manualRequired, exhausted, result.errorCode);
          await postCallback({
            job_id: job.id, job_type: 'push_blog',
            status: result.errorCode === 'RECAPTCHA_REQUIRED' ? 'captcha_detected' : toManual ? 'manual_required' : 'retryable_failed',
            content_post_id: payload.content_post_id ?? null,
            error_code: result.errorCode, error: result.reason, manual_required: toManual,
          });
          emit('log', { level: 'warn', msg: `[${tag}] ブログ: ${result.reason}`, at: new Date().toISOString() });
        }
      } else if (isReviewReply) {
        // ---- 口コミ返信投稿 ----
        const result = await postReviewReplyViaForm(page, payload, { baseUrl, enablePost: enablePush });
        if (result.status === 'ok') {
          await postCallback({
            job_id: job.id, job_type: 'push_review_reply', status: 'succeeded',
            review_import_id: payload.review_import_id ?? null,
            external_id: result.externalId ?? null,
            summary: 'push_review_reply 投稿完了',
          });
          emit('log', { level: 'info', msg: `[${tag}] ✅ 口コミ返信投稿完了${result.externalId ? ` (id=${result.externalId})` : ''}`, at: new Date().toISOString() });
        } else if (result.status === 'confirm_only') {
          await postCallback({
            job_id: job.id, job_type: 'push_review_reply', status: 'manual_required',
            review_import_id: payload.review_import_id ?? null,
            error_code: 'PUSH_DISABLED', error: '入力まで成功しましたが、実登録(実書込)が無効のため投稿していません。設定で有効化してください。', manual_required: true,
          });
          emit('log', { level: 'warn', msg: `[${tag}] 🟡 口コミ返信入力のみ (実登録OFF)`, at: new Date().toISOString() });
        } else {
          const toManual = shouldPromoteToManual(result.manualRequired, exhausted, result.errorCode);
          await postCallback({
            job_id: job.id, job_type: 'push_review_reply',
            status: result.errorCode === 'RECAPTCHA_REQUIRED' ? 'captcha_detected' : toManual ? 'manual_required' : 'retryable_failed',
            review_import_id: payload.review_import_id ?? null,
            error_code: result.errorCode, error: result.reason, manual_required: toManual,
          });
          emit('log', { level: 'warn', msg: `[${tag}] 口コミ返信: ${result.reason}`, at: new Date().toISOString() });
        }
      } else if (isPhotoGallery) {
        // ---- フォトギャラリー投稿 (エステ=photoGalleryEdit / 美容室=スタイル styleEdit) ----
        const result = await postPhotoGalleryViaForm(page, payload, { baseUrl, enablePost: enablePush, salonId: creds.salon_id ?? null, shopName: job.shop_name ?? null });
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
          const toManual = shouldPromoteToManual(result.manualRequired, exhausted, result.errorCode);
          await postCallback({
            job_id: job.id, job_type: 'push_photo_gallery',
            status: result.errorCode === 'RECAPTCHA_REQUIRED' ? 'captcha_detected' : toManual ? 'manual_required' : 'retryable_failed',
            error_code: result.errorCode, error: result.reason, manual_required: toManual,
          });
          emit('log', { level: 'warn', msg: `[${tag}] フォトギャラリー: ${result.reason}`, at: new Date().toISOString() });
        }
      } else if (isFetchShiftPatterns) {
        // ---- 勤務パターン取得 (シフトパターン設定の「SalonBoardから同期」ボタン) ----
        try {
          const res = await scrapeShiftPatterns(page, baseUrl); // 取得できなければ throw
          const pats = res.patterns || [];
          const { sent, error: upsertError } = await sendShiftPatterns(job.shop_id, pats);
          if (sent === 0) {
            // scrape は成功(throwされず)だが DB 保存が 0 件。
            // pats が空なら scrape の不整合、upsertError があれば DB エラー。
            const why = pats.length === 0
              ? '読み取り結果が0件でした'
              : upsertError
                ? `DB保存エラー: ${upsertError}`
                : '保存対象が0件でした';
            await postCallback({
              job_id: job.id, job_type: 'fetch_shift_patterns', status: 'manual_required',
              error_code: 'SHIFT_PATTERNS_SAVE_FAILED',
              error: `勤務パターンを保存できませんでした (読取${pats.length}件 / ${why})。`,
              manual_required: true,
            });
            emit('log', { level: 'warn', msg: `[${tag}] 🟡 勤務パターン保存0件 (読取${pats.length}件, ${why})`, at: new Date().toISOString() });
          } else {
            await postCallback({
              job_id: job.id, job_type: 'fetch_shift_patterns', status: 'succeeded',
              summary: `勤務パターン ${sent} 件取得`,
            });
            emit('log', { level: 'info', msg: `[${tag}] ✅ 勤務パターン ${sent} 件取得`, at: new Date().toISOString() });
          }
        } catch (e) {
          const isCaptcha = e?.code === 'RECAPTCHA_REQUIRED';
          // 「パターン未登録」は再試行しても直らないので manual_required。
          // 「画面未到達」は一時的なログイン切れ等の可能性があるので retryable。
          const noRetry = isCaptcha || e?.code === 'SHIFT_PATTERNS_NONE' || e?.code === 'SHIFT_PATTERNS_PARSE' || e?.code === 'SHIFT_PATTERNS_EMPTY' || exhausted;
          await postCallback({
            job_id: job.id, job_type: 'fetch_shift_patterns',
            status: isCaptcha ? 'captcha_detected' : noRetry ? 'manual_required' : 'retryable_failed',
            error_code: e?.code || 'UNKNOWN_ERROR', error: `${e?.message ?? e}`.slice(0, 500),
            manual_required: noRetry,
          });
          emit('log', { level: 'warn', msg: `[${tag}] 🔴 勤務パターン取得失敗: ${e?.message ?? e}`, at: new Date().toISOString() });
        }
      } else if (isFetchStaff) {
        // ---- スタッフ/スタイリスト一覧取得 (Admin の /admin/staff 「SalonBoardから取得」ボタン) ----
        // 通常の同期 (channels=['staff']) と同じ scrapeStaff → sendStaff を使うが、
        // Admin から手動でジョブとして起動できるようにした経路。
        const staffLabel = jobGenre === 'hair' ? 'スタイリスト' : 'スタッフ';
        try {
          const { rows, debug } = await scrapeStaff(page, {
            genre: jobGenre,
            salonId: creds.salon_id ?? null,
            shopName: job.shop_name ?? null,
          });
          const sent = await sendStaff(job.shop_id, rows);
          if (sent === 0) {
            // scrape は成功 (throw されず) だが保存 0 件。
            // 読取結果が空なら DOM 不整合 / ログイン切れの可能性。
            const found = debug?.itemsFound ?? (Array.isArray(rows) ? rows.length : 0);
            await postCallback({
              job_id: job.id, job_type: 'fetch_staff', status: 'manual_required',
              error_code: 'STAFF_SAVE_FAILED',
              error: `${staffLabel}を保存できませんでした (読取${found}件)。SalonBoardのログイン状態や掲載スタッフの有無を確認してください。`,
              manual_required: true,
            });
            emit('log', { level: 'warn', msg: `[${tag}] 🟡 ${staffLabel}保存0件 (読取${found}件)`, at: new Date().toISOString() });
          } else {
            await postCallback({
              job_id: job.id, job_type: 'fetch_staff', status: 'succeeded',
              summary: `${staffLabel} ${sent} 件取得`,
            });
            emit('log', { level: 'info', msg: `[${tag}] ✅ ${staffLabel} ${sent} 件取得`, at: new Date().toISOString() });
          }
        } catch (e) {
          const isCaptcha = e?.code === 'RECAPTCHA_REQUIRED';
          const noRetry = isCaptcha || exhausted;
          await postCallback({
            job_id: job.id, job_type: 'fetch_staff',
            status: isCaptcha ? 'captcha_detected' : noRetry ? 'manual_required' : 'retryable_failed',
            error_code: e?.code || 'UNKNOWN_ERROR', error: `${e?.message ?? e}`.slice(0, 500),
            manual_required: noRetry,
          });
          emit('log', { level: 'warn', msg: `[${tag}] 🔴 ${staffLabel}取得失敗: ${e?.message ?? e}`, at: new Date().toISOString() });
        }
      } else if (isFetchEquipment && jobGenre === 'hair') {
        // 美容室(hair)の SalonBoard には設備設定が存在しない (スタイリストベース)。
        // エステ用 /CNK/set/equipList/ へ飛ぶと失敗するためジョブは成功扱いでスキップ。
        await postCallback({
          job_id: job.id, job_type: 'fetch_equipment', status: 'succeeded',
          summary: '美容室は設備(ベッド/席)の概念がないためスキップしました',
        });
        emit('log', { level: 'info', msg: `[${tag}] ✅ 設備取得スキップ (美容室)`, at: new Date().toISOString() });
      } else if (isFetchEquipment) {
        // ---- 設備(ベッド/席)一覧取得 (Admin の店舗管理「SalonBoardから取得」ボタン) ----
        // /CNK/set/equipList/ の設備設定を scrapeEquipment で読み取り、
        // salonboard_equipment_imports に保存する (scrapeStaff と同じ方式)。
        try {
          const { rows, debug } = await scrapeEquipment(page, {
            genre: jobGenre,
            salonId: creds.salon_id ?? null,
            shopName: job.shop_name ?? null,
          });
          const sent = await sendEquipment(job.shop_id, rows);
          if (sent === 0) {
            const found = debug?.itemsFound ?? (Array.isArray(rows) ? rows.length : 0);
            await postCallback({
              job_id: job.id, job_type: 'fetch_equipment', status: 'manual_required',
              error_code: 'EQUIPMENT_SAVE_FAILED',
              error: `設備を保存できませんでした (読取${found}件)。SalonBoardのログイン状態や設備設定の有無を確認してください。`,
              manual_required: true,
            });
            emit('log', { level: 'warn', msg: `[${tag}] 🟡 設備保存0件 (読取${found}件)`, at: new Date().toISOString() });
          } else {
            await postCallback({
              job_id: job.id, job_type: 'fetch_equipment', status: 'succeeded',
              summary: `設備 ${sent} 件取得`,
            });
            emit('log', { level: 'info', msg: `[${tag}] ✅ 設備 ${sent} 件取得`, at: new Date().toISOString() });
          }
        } catch (e) {
          const isCaptcha = e?.code === 'RECAPTCHA_REQUIRED';
          const noRetry = isCaptcha || exhausted;
          await postCallback({
            job_id: job.id, job_type: 'fetch_equipment',
            status: isCaptcha ? 'captcha_detected' : noRetry ? 'manual_required' : 'retryable_failed',
            error_code: e?.code || 'UNKNOWN_ERROR', error: `${e?.message ?? e}`.slice(0, 500),
            manual_required: noRetry,
          });
          emit('log', { level: 'warn', msg: `[${tag}] 🔴 設備取得失敗: ${e?.message ?? e}`, at: new Date().toISOString() });
        }
      } else if (isFetchReviews) {
        // ---- 口コミ一覧取得 (Admin の口コミ画面「SalonBoardから取得」ボタン) ----
        // 一覧 + 詳細(全文/返信本文)を取得して salonboard_review_imports に保存する。
        const jobGenre = job.genre === 'hair' ? 'hair' : 'esthetic';
        try {
          const { rows, debug } = await scrapeReviews(page, {
            genre: jobGenre,
            withDetail: true, // 返信本文・口コミ全文も取得
            baseUrl,
          });
          const sent = await sendReviews(job.shop_id, rows);
          if (sent === 0) {
            const found = debug?.itemsFound ?? (Array.isArray(rows) ? rows.length : 0);
            await postCallback({
              job_id: job.id, job_type: 'fetch_reviews', status: 'manual_required',
              error_code: 'REVIEWS_SAVE_FAILED',
              error: `口コミを保存できませんでした (読取${found}件)。SalonBoardのログイン状態や掲載口コミの有無を確認してください。`,
              manual_required: true,
            });
            emit('log', { level: 'warn', msg: `[${tag}] 🟡 口コミ保存0件 (読取${found}件)`, at: new Date().toISOString() });
          } else {
            await postCallback({
              job_id: job.id, job_type: 'fetch_reviews', status: 'succeeded',
              summary: `口コミ ${sent} 件取得${debug?.detailFetched ? ` (詳細${debug.detailFetched}件)` : ''}`,
            });
            emit('log', { level: 'info', msg: `[${tag}] ✅ 口コミ ${sent} 件取得${debug?.detailFetched ? ` (詳細${debug.detailFetched}件)` : ''}`, at: new Date().toISOString() });
          }
        } catch (e) {
          const isCaptcha = e?.code === 'RECAPTCHA_REQUIRED';
          const noRetry = isCaptcha || exhausted;
          await postCallback({
            job_id: job.id, job_type: 'fetch_reviews',
            status: isCaptcha ? 'captcha_detected' : noRetry ? 'manual_required' : 'retryable_failed',
            error_code: e?.code || 'UNKNOWN_ERROR', error: `${e?.message ?? e}`.slice(0, 500),
            manual_required: noRetry,
          });
          emit('log', { level: 'warn', msg: `[${tag}] 🔴 口コミ取得失敗: ${e?.message ?? e}`, at: new Date().toISOString() });
        }
      } else if (isShifts) {
        // ---- シフト反映 (KIREIDOT shifts → SalonBoard シフト設定) ----
        const result = await pushShiftsViaForm(page, payload, { baseUrl, enablePush });
        // 読み取った勤務パターンを DB へ (紐付けUIのデータソース。失敗しても続行)
        if (Array.isArray(result.patterns) && result.patterns.length > 0) {
          await sendShiftPatterns(job.shop_id, result.patterns).catch(() => {});
        }
        const unmapped = Array.isArray(payload.unmapped_staff) && payload.unmapped_staff.length > 0
          ? ` / 未紐付けスタッフ: ${payload.unmapped_staff.join(', ')}`
          : '';
        const warnText = Array.isArray(result.warnings) && result.warnings.length > 0
          ? ` / 注意: ${result.warnings.slice(0, 5).join(' | ')}${result.warnings.length > 5 ? ` 他${result.warnings.length - 5}件` : ''}`
          : '';
        if (result.status === 'ok') {
          await postCallback({
            job_id: job.id, job_type: 'push_shifts', status: 'succeeded',
            summary: `${result.summary ?? 'push_shifts 完了'}${unmapped}${warnText}`.slice(0, 900),
          });
          emit('log', { level: 'info', msg: `[${tag}] ✅ シフト反映完了: ${result.summary ?? ''}${unmapped}${warnText}`, at: new Date().toISOString() });
        } else if (result.status === 'confirm_only') {
          await postCallback({
            job_id: job.id, job_type: 'push_shifts', status: 'manual_required',
            error_code: 'PUSH_DISABLED',
            error: `計画まで作成しましたが、実登録(実書込)が無効のため反映していません (${result.summary ?? ''})。設定で有効化してください。`,
            manual_required: true,
          });
          emit('log', { level: 'warn', msg: `[${tag}] 🟡 シフト反映は計画のみ (実登録OFF): ${result.summary ?? ''}`, at: new Date().toISOString() });
        } else {
          const toManual = shouldPromoteToManual(result.manualRequired, exhausted, result.errorCode);
          await postCallback({
            job_id: job.id, job_type: 'push_shifts',
            status: result.errorCode === 'RECAPTCHA_REQUIRED' ? 'captcha_detected' : toManual ? 'manual_required' : 'retryable_failed',
            error_code: result.errorCode, error: `${result.reason ?? ''}${warnText}`.slice(0, 900), manual_required: toManual,
          });
          emit('log', { level: 'warn', msg: `[${tag}] 🔴 シフト反映失敗: [${result.errorCode}] ${result.reason}`, at: new Date().toISOString() });
        }
      } else if (isCancel) {
        // ---- キャンセル ----
        // 休憩・業務(booking_type='block')は SalonBoard では「予約」ではなく「予定」
        // として登録されているため、予約キャンセルではなくスケジュール画面から
        // 予定そのものを削除する (deleteScheduleViaForm)。
        const isBlockSchedule = payload.booking_type === 'block';
        const result = isBlockSchedule
          ? await deleteScheduleViaForm(page, payload, { baseUrl, enableDelete: enablePush })
          : await cancelBookingViaForm(page, payload, { baseUrl, enableCancel: enablePush, salonId: creds.salon_id ?? null, shopName: job.shop_name ?? null });
        if (result.status === 'ok') {
          await postCallback({
            job_id: job.id, job_type: 'cancel_booking', status: 'succeeded',
            booking_id: payload.booking_id,
            summary: isBlockSchedule
              ? `cancel_booking 完了 (予定削除${result.alreadyAbsent ? ': 既に削除済み' : ''})`
              : 'cancel_booking 完了',
            // 一覧検索で reserveId を特定できた場合は callback に渡して bookings に焼き直す。
            external_id: result.recoveredReserveId || result.externalId || null,
          });
          emit('log', { level: 'info', msg: `[${tag}] ✅ SalonBoard ${isBlockSchedule ? '予定削除' : 'キャンセル'}完了${result.recoveredReserveId ? ` (reserveId回収=${result.recoveredReserveId})` : ''}${result.alreadyAbsent ? ' (既に削除済み)' : ''}`, at: new Date().toISOString() });
        } else if (result.status === 'confirm_only') {
          await postCallback({
            job_id: job.id, job_type: 'cancel_booking', status: 'manual_required',
            booking_id: payload.booking_id, error_code: 'PUSH_DISABLED',
            error: 'キャンセル操作まで到達しましたが、実登録(実書込)が無効のため確定していません。設定で有効化してください。',
            manual_required: true,
          });
          emit('log', { level: 'warn', msg: `[${tag}] 🟡 キャンセル未確定 (実登録OFF)`, at: new Date().toISOString() });
        } else {
          const toManual = shouldPromoteToManual(result.manualRequired, exhausted, result.errorCode);
          await postCallback({
            job_id: job.id, job_type: 'cancel_booking',
            status: result.errorCode === 'RECAPTCHA_REQUIRED' ? 'captcha_detected' : toManual ? 'manual_required' : 'retryable_failed',
            booking_id: payload.booking_id, error_code: result.errorCode, error: result.reason, manual_required: toManual,
          });
          emit('log', { level: 'warn', msg: `[${tag}] 🔴 キャンセル失敗: [${result.errorCode}] ${result.reason}`, at: new Date().toISOString() });
        }
      } else if (isUpdate) {
        // ---- 変更 (時間/所要/担当) ----
        // 休憩・業務は通常予約ではなく SalonBoard の「予定」。通常予約の変更画面へ
        // 送ると一時エラーになるため、予定専用の削除→再登録フローで KD に収束させる。
        const isBlockSchedule = payload.booking_type === 'block';
        const result = isBlockSchedule
          ? await changeScheduleViaForm(page, payload, {
              baseUrl,
              enableChange: enablePush,
            })
          : await changeBookingViaForm(page, payload, {
          baseUrl,
          enableChange: enablePush,
          genre: jobGenre,
          salonId: creds.salon_id ?? null,
          shopName: job.shop_name ?? null,
          relogin: async () => {
            const lr = await tryLogin(page, {
              baseUrl: new URL('/login/', baseUrl).toString(),
              loginId: creds.login_id,
              password: creds.password,
              slow: true,
            });
            if (lr.status !== 'ok') return false;
            const selected = await ensureStoreSelected(page, {
              salonId: creds.salon_id ?? null,
              shopName: job.shop_name ?? null,
            });
            return selected.ok;
          },
        });
        if (result.status === 'ok') {
          await postCallback({
            job_id: job.id, job_type: 'push_booking', status: 'succeeded',
            booking_id: payload.booking_id, external_booking_id: payload.external_booking_id ?? null,
            summary: isBlockSchedule ? 'push_booking(予定変更) 完了' : 'push_booking(変更) 完了',
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
          const toManual = shouldPromoteToManual(result.manualRequired, exhausted, result.errorCode);
          await postCallback({
            job_id: job.id, job_type: 'push_booking',
            status: result.errorCode === 'RECAPTCHA_REQUIRED' ? 'captcha_detected' : toManual ? 'manual_required' : 'retryable_failed',
            booking_id: payload.booking_id, error_code: result.errorCode, error: result.reason, manual_required: toManual,
          });
          emit('log', { level: 'warn', msg: `[${tag}] 🔴 変更失敗: [${result.errorCode}] ${result.reason}`, at: new Date().toISOString() });
        }
      } else {
        // ---- 新規登録 ----
        // 休憩・業務(booking_type='block')は SalonBoard の「予約」ではなく「予定」
        // (scheduleRegist)として登録する。設備(ベッド)を埋めず受付だけ停止する枠。
        const isBlockSchedule = payload.booking_type === 'block';
        const result = isBlockSchedule
          ? await pushScheduleViaForm(page, payload, { baseUrl, enablePush })
          : await pushBookingViaForm(page, payload, { baseUrl, enablePush });
        if (result.status === 'ok') {
          await postCallback({
            job_id: job.id, job_type: 'push_booking', status: 'succeeded',
            booking_id: payload.booking_id,
            external_booking_id: result.externalId ?? null,
            salonboard_detail_url: result.detailUrl ?? null,
            // preflight で既に SalonBoard にあった (新規登録ではない) ことを Admin に伝える。
            // スイープの「自動で入れた」Slack 通知は新規登録のみを対象にするため、ここを見て分岐する。
            already_exists: result.alreadyExists === true,
            result_payload: result.confirmed,
            summary: `push_booking ${result.alreadyExists ? '既存確認 (登録済み)' : '登録完了'} (external_id=${result.externalId ?? '?'})`,
          });
          emit('log', { level: 'info', msg: `[${tag}] ✅ ${result.alreadyExists ? '既存確認(登録済み)' : '登録完了'} external_id=${result.externalId ?? '?'}${result.confirmed?.equip_assigned ? ` / 設備:${result.confirmed.equip_assigned}` : ''}`, at: new Date().toISOString() });
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
          const toManual = shouldPromoteToManual(result.manualRequired, exhausted, result.errorCode);
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
      await cleanupBrowser();
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
      await cleanupBrowser();
    }
  };

  // pushジョブも取得(sync)と同じ店舗ロックで相互排他にする。
  // 同一SBアカウントに Playwright(取得/同期) と 普段使いChrome(拡張スタイル投稿) が
  // 同時ログインすると SalonBoard が先のセッションを切り、ログイン⇄ログアウトの
  // 無限ループになるため (12分毎の自動取得と拡張ジョブの衝突が実例)。
  // 取得側は既にロック中の店舗を skip するので、こちらは「待ってから実行」する。
  const runOne = async (job) => {
    const shopId = job.shop_id;
    const label = deviceAuth.workerId ?? 'electron-worker';
    let locked = false;
    if (shopId) {
      const startedWait = Date.now();
      let announced = false;
      for (;;) {
        const lock = tryAcquireShopLock(shopId, label);
        if (lock.ok) { locked = true; break; }
        if (Date.now() - startedWait > 10 * 60_000) {
          emit('log', { level: 'warn', msg: `[push ${String(job.id).slice(0, 8)}] 店舗ロック待ちが10分を超えたため、そのまま実行します`, at: new Date().toISOString() });
          break;
        }
        if (!announced) {
          announced = true;
          emit('log', { level: 'info', msg: `[push ${String(job.id).slice(0, 8)}] 同じ店舗の取得/同期が実行中のため、完了を待ってから書き込みます…`, at: new Date().toISOString() });
        }
        await new Promise((r) => setTimeout(r, 5000));
      }
    }

    // Chrome ポート単位のロック: 同じ chrome_debug_port を使う店舗同士は
    // 同一 Chrome を共有するため直列化する (別ポートなら並列のまま通る)。
    let portLocked = false;
    let lockedPort = null;
    try {
      const prof = await fetchChromeProfile(shopId);
      lockedPort = Number(prof.debugPort || process.env.SALONBOARD_CHROME_DEBUG_PORT || defaultDebugPortForShop(shopId));
    } catch (_e) { lockedPort = defaultDebugPortForShop(shopId); }
    if (lockedPort) {
      const startedWait = Date.now();
      let announced = false;
      for (;;) {
        const lock = tryAcquireChromePortLock(lockedPort, label);
        if (lock.ok) { portLocked = true; break; }
        if (Date.now() - startedWait > 10 * 60_000) {
          emit('log', { level: 'warn', msg: `[push ${String(job.id).slice(0, 8)}] Chromeポート(${lockedPort})ロック待ちが10分超のため、そのまま実行します`, at: new Date().toISOString() });
          break;
        }
        if (!announced) {
          announced = true;
          emit('log', { level: 'info', msg: `[push ${String(job.id).slice(0, 8)}] 同じChrome(port ${lockedPort})を使う別店舗の処理中のため、完了を待ちます…`, at: new Date().toISOString() });
        }
        await new Promise((r) => setTimeout(r, 5000));
      }
    }

    try {
      await runOneInner(job);
    } finally {
      if (portLocked && lockedPort) releaseChromePortLock(lockedPort);
      if (locked && shopId) releaseShopLock(shopId);
      // 次のジョブに古い page が残らないようクリア (close 済みの page を
      // 後続のエラー報告が触らないように)。
      _errorCapturePage = null;
      _currentJobInfo = null;
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

    // 扱わない種別は整理して除外。
    // push_booking / cancel_booking / push_blog / delete_blog / push_photo_gallery /
    // push_review_reply(口コミ返信投稿) / push_shifts / fetch_shift_patterns /
    // fetch_staff / fetch_equipment を処理する。
    // ★ push_review_reply / fetch_staff / fetch_equipment がこのリストから漏れていたため、
    //   claim したジョブが「処理しません」で cancelled になり、口コミ返信が投稿されなかった。
    const HANDLED_JOB_TYPES = new Set([
      'push_booking', 'cancel_booking', 'push_blog', 'delete_blog',
      'push_photo_gallery', 'push_review_reply', 'push_shifts',
      'fetch_shift_patterns', 'fetch_staff', 'fetch_equipment', 'fetch_reviews',
    ]);
    const handled = [];
    for (const j of claimedJobs) {
      if (!HANDLED_JOB_TYPES.has(j.job_type)) {
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
  // 失敗系の結果(登録/変更/キャンセル/投稿の失敗)は Slack にも通知する。
  // emit('log',{level:'error'}) を通らないケース(callbackだけで完結する失敗)も
  // 取りこぼさないための保険。成功(succeeded)は通知しない。
  try {
    const st = body?.status;
    if (st && st !== 'succeeded' && st !== 'manual_required_none' &&
        ['failed', 'retryable_failed', 'non_retryable_failed', 'manual_required',
         'captcha_detected', 'blocked', 'login_required'].includes(st)) {
      const jt = body?.job_type || 'job';
      const code = body?.error_code ? `[${body.error_code}] ` : '';
      const reason = body?.error || body?.summary || '';
      void sendSlack(`${jt} ${st}: ${code}${reason}`.slice(0, 500));
      // エラー画面のスクショ + 画面テキストAI判別 + 原因推測を専用チャンネルへ。
      // ⚠️ page がまだ生きているうちにスクショを撮る必要があるため await する
      //   (この後 browser.close される)。AI/Slack送信の失敗は内部で握りつぶす。
      await reportSalonboardErrorWithScreenshot({
        jobType: jt,
        status: st,
        errorCode: body?.error_code || null,
        reason,
        bookingInfo: _currentJobInfo,
      });
    }
  } catch (_e) { /* noop */ }
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
  // 待機モード (別の端末がアクティブ): 自動/手動とも同期しない。
  // 手動で動かしたい場合は Admin の連携デバイス画面でこの端末をアクティブにする。
  if (!workerActive) {
    emit('error', {
      msg: 'この端末は待機モードです (別の端末がアクティブ)。同期するには Admin の連携デバイス画面でこの端末をアクティブに切り替えてください。',
    });
    return;
  }
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
      // 運営(Super Admin)が会社ごとに無効化した連携チャンネルを除外する。
      // 全チャンネルが無効なら店舗ごとスキップ (ログイン等の無駄な巡回もしない)。
      const disabledCh = new Set(Array.isArray(t.disabled_channels) ? t.disabled_channels : []);
      const effChannels = (channels ?? []).filter((c) => !disabledCh.has(c));
      if ((channels ?? []).length > 0 && effChannels.length === 0) {
        emit('log', {
          level: 'info',
          msg: `[${String(t.shop_id).slice(0, 8)}] 運営設定によりこの同期の対象チャンネルが全て無効のためスキップ (${(channels ?? []).join(',')})`,
          at: new Date().toISOString(),
        });
        okCount++;
        continue;
      }
      if (effChannels.length < (channels ?? []).length) {
        emit('log', {
          level: 'info',
          msg: `[${String(t.shop_id).slice(0, 8)}] 運営設定により無効のチャンネルを除外: ${(channels ?? []).filter((c) => disabledCh.has(c)).join(',')}`,
          at: new Date().toISOString(),
        });
      }
      const r = await processShop(t, effChannels, runId, { showBrowser: showBrowserEffective });
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
 * スタイル画像アップロードのテスト。画面(予約同期くん「スタイル」ページ)から実行。
 * 指定店舗で styleEdit を開き、テスト画像を FRONT にアップロードする所まで行う
 * (enablePost=false なので最終登録はしない=安全)。実Chrome優先で画面表示。
 * payload: { shopId, imageUrl, stylistExternalId?, enablePost? }
 * 結果は style:test イベントで返す。
 */
async function runTestStyleImage(payload) {
  const step = (s, extra = {}) => emit('style:test', { step: s, ...extra });
  const p = payload || {};
  if (!p.shopId || !p.imageUrl) {
    step('done', { ok: false, error: '必須項目が不足 (店舗・画像URL)' });
    return;
  }
  step('start', { msg: `開始: shop=${String(p.shopId).slice(0, 8)} 画像=${String(p.imageUrl).slice(0, 60)}… 実登録=${p.enablePost ? 'ON' : 'OFF(画像のみ)'}` });

  let creds;
  try { creds = await revealCredentials(p.shopId); }
  catch (e) { step('done', { ok: false, error: `認証情報の取得に失敗: ${e?.message ?? e}` }); return; }
  const baseUrl = creds.baseUrl || 'https://salonboard.com/login/';

  let browser = null;
  let persistentCtx = null;
  try {
    step('launch', { msg: 'ブラウザ起動 (画面表示・実Chrome/ステルス)' });
    // ★Akamai対策: 自動化指紋を消した実Chrome(永続プロファイル)で起動。
    let launched;
    try {
      launched = await launchStealthPersistentContext({ headless: false, slowMo: 300 });
      persistentCtx = launched.context;
    } catch (e) {
      step('launch', { msg: `ステルス起動に失敗(${e?.message?.split('\n')[0] ?? e})→通常起動にフォールバック` });
      launched = await launchPushBrowser({ headless: false, slowMo: 400 });
    }
    browser = launched.browser;
    let ver = '';
    try { ver = browser.version(); } catch (_e) {}
    step('launch', { msg: `ブラウザ: ${launched.usedChrome ? '実Google Chrome ✅' : '⚠️ 同梱Chromium'} (v${ver})${launched.persistent ? ' / 自動化フラグ除去' : ''}${launched.seeded ? ' / あなたのChromeプロファイルをシード✅' : ''}` });

    const ssPath = storageStatePathFor(p.shopId);
    // 永続コンテキストはそのまま使う。非永続時のみ newContext で作る。
    let ctx;
    if (persistentCtx) {
      ctx = persistentCtx;
      // 既存セッションがあれば storageState を流し込む(初回ログイン省略のため)。
      try {
        const ss = readStorageStatePath(ssPath);
        if (ss && Array.isArray(ss.cookies) && ss.cookies.length) await ctx.addCookies(ss.cookies).catch(() => {});
      } catch (_e) { /* noop */ }
    } else {
      ctx = await browser.newContext({
        ...(readStorageStatePath(ssPath) ? { storageState: readStorageStatePath(ssPath) } : {}),
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
        locale: 'ja-JP', timezoneId: 'Asia/Tokyo', viewport: { width: 1366, height: 900 },
      });
    }
    const page = ctx.pages()[0] || await ctx.newPage();

    // ★doUpload(画像本体送信)の実ステータス/失敗理由を自動で捕捉してログに出す。
    //   手動で DevTools を開かなくても、Akamai に弾かれているのか/応答が何かが分かる。
    page.on('response', async (resp) => {
      try {
        const u = resp.url();
        if (/\/imgreg\/.*doUpload/i.test(u)) {
          step('net', { msg: `📡 doUpload → HTTP ${resp.status()} ${resp.statusText() || ''}` });
        }
      } catch (_e) {}
    });
    page.on('requestfailed', (req) => {
      try {
        const u = req.url();
        if (/\/imgreg\/.*doUpload/i.test(u)) {
          step('net', { msg: `📡 doUpload → 失敗 ${req.failure()?.errorText || 'unknown'}` });
        }
      } catch (_e) {}
    });

    // kind: 'style'(美容室) / 'photo_gallery'(エステ等)。
    const kind = p.kind === 'photo_gallery' ? 'photo_gallery' : 'style';
    const isEsthetic = kind === 'photo_gallery';
    const target = isEsthetic ? 'フォトギャラリー' : 'スタイル';

    const closeAll = async () => {
      try { if (persistentCtx) await persistentCtx.close(); else await browser.close(); } catch (_e) {}
    };

    step('login', { msg: 'ログイン確認中' });
    let auth = await isLoggedIn(page, baseUrl, isEsthetic ? 'esthetic' : 'hair');
    if (auth === 'captcha') { step('done', { ok: false, error: 'reCAPTCHA が表示されました' }); await closeAll(); return; }
    if (auth !== 'logged_in') {
      step('login', { msg: 'ID/パスワードを入力中…' });
      const lr = await tryLogin(page, { ...creds, slow: true });
      if (lr.status !== 'ok') { step('done', { ok: false, error: `ログイン失敗: ${lr.reason || lr.status}` }); await closeAll(); return; }
      await saveStorageState(ctx, ssPath);
    }
    step('login_ok', { msg: 'ログイン成功' });

    // グループ店舗のサロン選択。
    try {
      const sel = await ensureStoreSelected(page, { salonId: creds.salonId ?? null, shopName: p.shopName ?? null });
      if (sel.selected) step('store', { msg: `サロン選択: ${sel.salonId ?? ''}` });
      if (!sel.ok) { step('done', { ok: false, error: `サロン選択に失敗: ${sel.reason ?? 'unknown'} (サロンID登録が必要かも)` }); await closeAll(); return; }
    } catch (_e) { /* 単一店舗は no-op */ }

    // ★ブラウザ指紋の自動診断 (DevToolsを手動で開かなくても分かるように)。
    try {
      const fp = await page.evaluate(() => ({
        webdriver: navigator.webdriver,
        ua: navigator.userAgent,
        cookieNames: (document.cookie || '').split(';').map((c) => c.trim().split('=')[0]).filter(Boolean),
        hasChrome: !!window.chrome,
        plugins: (navigator.plugins && navigator.plugins.length) || 0,
        languages: (navigator.languages || []).join(','),
      })).catch(() => null);
      if (fp) {
        const akamai = fp.cookieNames.filter((n) => ['_abck', 'bm_sz', 'ak_bmsc', 'bm_mi', 'bm_sv'].includes(n));
        const uaVer = (fp.ua.match(/Chrome\/(\d+)/) || [])[1] || '?';
        step('diag', { msg: `🔎 webdriver=${fp.webdriver} / UA=Chrome${uaVer} / Akamai-cookie=[${akamai.join(',') || 'なし⚠️'}] / plugins=${fp.plugins}` });
      }
    } catch (_e) { /* noop */ }

    step('upload', { msg: `${isEsthetic ? 'photoGalleryEdit' : 'styleEdit'} を開いて画像をアップロードします…` });
    const result = await postPhotoGalleryViaForm(page, {
      kind,
      image_url: p.imageUrl,
      images: [p.imageUrl],
      title: p.title || 'テスト投稿',
      caption: p.caption || 'テスト',
      author_external_id: p.stylistExternalId || null,
    }, { baseUrl, enablePost: !!p.enablePost, salonId: creds.salonId ?? null, shopName: p.shopName ?? null });

    let failed = false;
    if (result.status === 'ok') {
      step('done', { ok: true, msg: `✅ 成功 (画像ID=${result.externalId || '?'})${p.enablePost ? ` ${target}登録まで完了` : ' 画像アップロードOK(登録は未実行)'}` });
    } else if (result.status === 'confirm_only') {
      step('done', { ok: true, msg: '✅ 画像アップロードOK (実登録OFFのため登録は未実行)' });
    } else {
      failed = true;
      step('done', { ok: false, errorCode: result.errorCode, error: `🔴 失敗: [${result.errorCode || '?'}] ${result.reason}` });
    }

    if (failed) {
      // ★失敗時はブラウザを閉じない。エラー画面/Network を確認できるよう、
      //   ブラウザのウィンドウが手動で閉じられるまで(最大10分)開いたままにする。
      step('hold', { msg: '🖐 失敗したのでブラウザは開いたままにします。画面/エラーを確認したら、ブラウザのウィンドウを手動で閉じてください(最大10分で自動クローズ)。' });
      await new Promise((resolve) => {
        let done = false;
        const finish = () => { if (done) return; done = true; resolve(); };
        try {
          const b = persistentCtx ? persistentCtx.browser() : browser;
          if (persistentCtx) persistentCtx.on('close', finish);
          if (b) b.on('disconnected', finish);
          // ページが全部閉じられたら終了。
          if (persistentCtx) persistentCtx.on('page', () => {});
        } catch (_e) {}
        setTimeout(finish, 10 * 60 * 1000); // 10分でフェイルセーフ
      });
      try { if (persistentCtx) await persistentCtx.close(); else await browser?.close(); } catch (_e) {}
    } else {
      await page.waitForTimeout(4000).catch(() => {});
      await closeAll();
    }
  } catch (e) {
    step('done', { ok: false, error: `例外: ${e?.message ?? e}` });
    // 例外時もしばらく開いたままにして確認できるように(最大10分)。
    step('hold', { msg: '🖐 例外で停止。ブラウザは開いたままです。確認後、ウィンドウを手動で閉じてください(最大10分で自動クローズ)。' });
    await new Promise((resolve) => {
      let done = false; const finish = () => { if (done) return; done = true; resolve(); };
      try {
        const b = persistentCtx ? persistentCtx.browser() : browser;
        if (persistentCtx) persistentCtx.on('close', finish);
        if (b) b.on('disconnected', finish);
      } catch (_e) {}
      setTimeout(finish, 10 * 60 * 1000);
    });
    try { if (persistentCtx) await persistentCtx.close(); else await browser?.close(); } catch (_e) {}
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
            // Slack エラー通知設定。token/channel いずれか渡されたら更新。
            ...((d.slackToken !== undefined || d.slackChannel !== undefined)
              ? {
                  slack: (() => {
                    const tok = d.slackToken !== undefined ? (d.slackToken || null) : (deviceAuth.slack?.token || null);
                    const ch = d.slackChannel !== undefined ? (d.slackChannel || null) : (deviceAuth.slack?.channel || null);
                    // トークンがあれば有効。チャンネル未指定なら既定チャンネルへ。
                    return tok ? { token: tok, channel: ch || null } : null;
                  })(),
                }
              : {}),
          };
          log(
            `device設定を更新しました (apiBaseUrl=${deviceAuth.apiBaseUrl ? 'set' : 'null'}, token=${deviceAuth.deviceToken ? 'set' : 'null'}, slack=${deviceAuth.slack ? 'set' : 'null'})`,
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
      case 'test-style-image':
        await enqueueSerial(async () => {
          try {
            await ensureReady();
          } catch (e) {
            emit('style:test', { step: 'done', ok: false, error: e instanceof Error ? e.message : String(e) });
            return;
          }
          await runTestStyleImage(m.payload ?? {});
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
