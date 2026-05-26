// KIREIDOT サロンデスク — Electron main process
// 開発時は Vite の dev server (http://localhost:5173) をロード、
// 本番ビルド時は dist/index.html を読み込む。
//
// Google OAuth 用 Deep Link (kireidot-salondesk://...) を受信し、
// renderer の AuthContext に IPC で配送する。

const { app, BrowserWindow, shell, ipcMain, utilityProcess } = require('electron');
const path = require('node:path');
const { initAutoUpdater, quitAndInstall, manualCheck } = require('./updater.cjs');

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
// Worker 操作系 IPC (renderer → main → utilityProcess)
// ---------------------------------------------------------------------
ipcMain.handle('worker:init', async (_event, payload) => {
  const ok = postToWorker({ type: 'init', payload });
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
