// KIREIDOT サロンデスク — Electron main process
// 開発時は Vite の dev server (http://localhost:5173) をロード、
// 本番ビルド時は dist/index.html を読み込む。
//
// Google OAuth 用 Deep Link (kireidot-salondesk://...) を受信し、
// renderer の AuthContext に IPC で配送する。

const { app, BrowserWindow, shell, ipcMain, utilityProcess } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { initAutoUpdater, quitAndInstall, manualCheck } = require('./updater.cjs');
const deviceConfig = require('./device-config.cjs');
const authStorage = require('./auth-storage.cjs');

// ---------------------------------------------------------------------
// Playwright Chromium のパス設定 (v0.2.7)
//
// 配布された .app は extraResources で同梱された
// Resources/playwright-browsers/ を使う。dev 時 (= !app.isPackaged) は
// 開発機のシステムキャッシュ ~/Library/Caches/ms-playwright をそのまま使うので
// PLAYWRIGHT_BROWSERS_PATH は設定しない。
//
// この env は process.env 経由で utilityProcess (worker-process.cjs) にも
// 継承される。
// ---------------------------------------------------------------------
if (app.isPackaged) {
  try {
    const bundledBrowsersPath = path.join(
      process.resourcesPath,
      'playwright-browsers',
    );
    if (fs.existsSync(bundledBrowsersPath)) {
      process.env.PLAYWRIGHT_BROWSERS_PATH = bundledBrowsersPath;
      // 起動ログだけ残す (token 等は出していないので OK)
      console.log(
        `[main] PLAYWRIGHT_BROWSERS_PATH=${bundledBrowsersPath}`,
      );
    } else {
      console.warn(
        `[main] bundled playwright-browsers not found at ${bundledBrowsersPath}; ` +
          'falling back to system cache (may fail on user PC)',
      );
    }
  } catch (e) {
    console.warn('[main] failed to set PLAYWRIGHT_BROWSERS_PATH:', e?.message ?? e);
  }
}

// ---------------------------------------------------------------------
// Worker (utilityProcess) — マルチ店舗スクレイピングのバックグラウンド実行
// ---------------------------------------------------------------------
let workerChild = null;

function ensureWorker() {
  if (workerChild) return workerChild;
  const scriptPath = path.join(__dirname, 'worker-process.cjs');
  workerChild = utilityProcess.fork(scriptPath, [], {
    serviceName: 'salonboard-worker',
    stdio: 'pipe',
  });
  workerChild.stdout?.on('data', (d) => process.stdout.write(`[worker] ${d}`));
  workerChild.stderr?.on('data', (d) => process.stderr.write(`[worker:err] ${d}`));
  workerChild.on('message', (msg) => {
    // renderer に転送
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('worker:event', msg);
    }
  });
  workerChild.on('exit', (code) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('worker:event', {
        type: 'exited',
        payload: { code },
      });
    }
    workerChild = null;
  });
  return workerChild;
}

function postToWorker(msg) {
  const w = ensureWorker();
  try {
    w.postMessage(msg);
    return true;
  } catch (e) {
    console.error('[main] postToWorker failed', e);
    return false;
  }
}

const isDev = !!process.env.VITE_DEV_SERVER_URL || process.env.NODE_ENV === 'development';

// OAuth コールバック用の Custom URL Scheme。
// Supabase Dashboard の Auth → URL Configuration → Redirect URLs に
// 同じ値を 1 行追加すること: kireidot-salondesk://auth/callback
const PROTOCOL_SCHEME = 'kireidot-salondesk';

let mainWindow = null;
/** renderer 起動前に Deep Link を受け取った場合のバッファ。 */
let pendingOAuthCallbackUrl = null;

function deliverOAuthCallback(url) {
  if (!url || !url.startsWith(`${PROTOCOL_SCHEME}://`)) return;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('oauth:callback', url);
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  } else {
    // window 未作成時は buffer しておき、createWindow 完了後に送る
    pendingOAuthCallbackUrl = url;
  }
}

// 単一インスタンス化: 既に起動中なら deep link を first instance に転送
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    // Windows / Linux: 2 つ目のプロセスに渡された argv の末尾に URL がある
    const deepLink = argv.find((arg) => arg.startsWith(`${PROTOCOL_SCHEME}://`));
    if (deepLink) deliverOAuthCallback(deepLink);
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// macOS: deep link は open-url イベントで配送される (アプリ起動中/起動時いずれも)
app.on('open-url', (event, url) => {
  event.preventDefault();
  deliverOAuthCallback(url);
});

// Custom scheme の登録 (dev / 本番どちらでも)。
// dev では Electron バイナリへのフルパス + 引数指定で登録する必要がある。
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOL_SCHEME, process.execPath, [
      path.resolve(process.argv[1]),
    ]);
  }
} else {
  app.setAsDefaultProtocolClient(PROTOCOL_SCHEME);
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1080,
    minHeight: 680,
    title: 'KIREIDOT サロンデスク',
    backgroundColor: '#FFFAF9',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // 外部 http(s) リンクはシステムブラウザで開く
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  if (isDev) {
    const devUrl = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';
    await mainWindow.loadURL(devUrl);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    await mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  // renderer 起動前に受け取っていた deep link があればここで配送
  mainWindow.webContents.once('did-finish-load', () => {
    if (pendingOAuthCallbackUrl) {
      mainWindow.webContents.send('oauth:callback', pendingOAuthCallbackUrl);
      pendingOAuthCallbackUrl = null;
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// renderer 側から「このURLをシステムブラウザで開いて」と頼まれたとき。
// Google OAuth ログインに使う。https(s) のみ許可。
ipcMain.handle('app:open-external', async (_event, url) => {
  if (typeof url !== 'string') return { ok: false, error: 'url must be string' };
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'only http(s) allowed' };
  await shell.openExternal(url);
  return { ok: true };
});

// renderer の「今すぐ再起動して更新を適用」ボタンから呼ばれる。
ipcMain.handle('updater:quit-and-install', async () => {
  quitAndInstall();
  return { ok: true };
});

// renderer の「アップデートを今すぐ確認」ボタンから呼ばれる。
ipcMain.handle('updater:check', async () => {
  return await manualCheck();
});

// ---------------------------------------------------------------------
// auth-storage IPC (v0.2.9)
//
// 本番ビルドの file:// オリジンでは localStorage が起動ごとに失われ、
// Supabase セッションが消えて毎回ログアウトされていた。
// userData 配下に JSON で保存することで永続化する。
//
// renderer 側 supabase client の storage オプションに preload 経由で繋ぐ。
// ---------------------------------------------------------------------
ipcMain.handle('auth-storage:get', async (_event, key) => {
  if (typeof key !== 'string' || !key) return null;
  return authStorage.getItem(app, key);
});
ipcMain.handle('auth-storage:set', async (_event, key, value) => {
  if (typeof key !== 'string' || !key) return { ok: false };
  authStorage.setItem(app, key, value);
  return { ok: true };
});
ipcMain.handle('auth-storage:remove', async (_event, key) => {
  if (typeof key !== 'string' || !key) return { ok: false };
  authStorage.removeItem(app, key);
  return { ok: true };
});

// ---------------------------------------------------------------------
// device 設定 IPC (renderer → main, userData 永続化)
// ---------------------------------------------------------------------
// token は renderer に返さない (getMaskedDeviceConfig で last4 のみ)。
// device:save / device:test は token を受け取るが、ログには絶対出さない。
ipcMain.handle('device:get', async () => {
  return deviceConfig.getMaskedDeviceConfig(app);
});

ipcMain.handle('device:save', async (_event, payload) => {
  // payload: { deviceId, deviceToken, apiUrl, deviceName, workerId }
  // 接続テストを通してから保存する (テスト失敗時は未検証として扱う)
  const cfg = {
    deviceId: String(payload?.deviceId ?? '').trim(),
    deviceToken: String(payload?.deviceToken ?? '').trim(),
    apiUrl: String(payload?.apiUrl ?? '').trim(),
    deviceName: String(payload?.deviceName ?? '').trim() || null,
    workerId: String(payload?.workerId ?? '').trim() || null,
  };
  // global token 運用: API URL + Token は必須。Device ID は任意 (空なら全店舗モード)。
  if (!cfg.deviceToken || !cfg.apiUrl) {
    return { ok: false, code: 'invalid_input', message: 'API URL と Worker Token は必須です' };
  }
  const test = await deviceConfig.testDeviceConfig(app, cfg);
  // 接続成功時は lastVerifiedAt を更新して保存。失敗時も保存はするが lastVerifiedAt は null。
  deviceConfig.writeDeviceConfig(app, {
    ...cfg,
    lastVerifiedAt: test.ok ? new Date().toISOString() : null,
  });
  return {
    ok: test.ok,
    code: test.code,
    message: test.message,
    shops: test.shops ?? [],
    device: test.device ?? null,
    config: deviceConfig.getMaskedDeviceConfig(app),
  };
});

ipcMain.handle('device:clear', async () => {
  deviceConfig.clearDeviceConfig(app);
  return { ok: true };
});

ipcMain.handle('device:test', async (_event, payload) => {
  // payload があればそれでテスト、無ければ保存済み設定でテスト
  const cfg = payload
    ? {
        deviceId: String(payload?.deviceId ?? '').trim(),
        deviceToken: String(payload?.deviceToken ?? '').trim(),
        apiUrl: String(payload?.apiUrl ?? '').trim(),
        workerId: String(payload?.workerId ?? '').trim() || null,
      }
    : undefined;
  const test = await deviceConfig.testDeviceConfig(app, cfg);
  // 保存済み設定でのテストが成功したら lastVerifiedAt を更新
  if (!payload && test.ok) {
    deviceConfig.writeDeviceConfig(app, { lastVerifiedAt: new Date().toISOString() });
  }
  return {
    ok: test.ok,
    code: test.code,
    message: test.message,
    shops: test.shops ?? [],
    device: test.device ?? null,
  };
});

// ---------------------------------------------------------------------
// Worker 操作系 IPC (renderer → main → utilityProcess)
// ---------------------------------------------------------------------
ipcMain.handle('worker:init', async (_event, payload) => {
  // renderer から来た payload (Supabase URL/anonKey/session) に、
  // main が userData から読んだ device 設定をマージする。
  // これにより device_id/token は renderer を経由せず worker に届く。
  const dev = deviceConfig.readDeviceConfig(app);
  const merged = {
    ...payload,
    ...(dev
      ? {
          apiBaseUrl: dev.apiUrl ?? payload?.apiBaseUrl ?? null,
          deviceId: dev.deviceId ?? null,
          deviceToken: dev.deviceToken ?? null,
          workerId: dev.workerId ?? payload?.workerId ?? 'electron-worker',
        }
      : {}),
  };
  const ok = postToWorker({ type: 'init', payload: merged });
  return { ok };
});
ipcMain.handle('worker:sync', async (_event, payload) => {
  const ok = postToWorker({ type: 'sync', payload });
  return { ok };
});
ipcMain.handle('worker:abort', async () => {
  const ok = postToWorker({ type: 'abort' });
  return { ok };
});

app.whenReady().then(async () => {
  await createWindow();

  // macOS: ダブルクリック起動の引数経由で deep link が来るケース
  // (open-url で吸えないケースのフォールバック)
  const deepLinkArg = process.argv.find((arg) => arg.startsWith(`${PROTOCOL_SCHEME}://`));
  if (deepLinkArg) deliverOAuthCallback(deepLinkArg);

  // 自動アップデート (dev / SKIP_AUTO_UPDATE=1 では何もしない)
  initAutoUpdater(mainWindow);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
