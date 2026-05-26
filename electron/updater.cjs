// 予約同期くん — 自動アップデート機構 (electron-updater)
//
// 配信元: github.com/Nolan-inc/KIREIDOT_Salonboard_Worker (public)
// ダウンロード: 起動直後にバックグラウンドで取得
// 適用       : 次回起動時に自動適用 (autoInstallOnAppQuit)
//             ユーザーが「今すぐ再起動」を選んだ場合のみ即時適用
//
// 公証済み dmg + latest-mac.yml + blockmap を Release アセットとして
// 添付しておくと、electron-updater が差分 (blockmap) を使って効率的に
// ダウンロードし、署名検証も自動で行う。

const path = require('node:path');
const { app, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');

// 環境変数 SKIP_AUTO_UPDATE=1 でアップデート機構を無効化できる
// (社内検証ビルドや、リリース直後の検証時用)。
const SKIP = process.env.SKIP_AUTO_UPDATE === '1';

// dev 判定 (main.cjs と同じ)。dev では updater を起動しない。
const isDev =
  !!process.env.VITE_DEV_SERVER_URL || process.env.NODE_ENV === 'development';

let mainWindowRef = null;
let started = false;

function send(channel, payload) {
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    mainWindowRef.webContents.send(channel, payload);
  }
}

/**
 * Electron main から呼び出すエントリーポイント。
 * - dev / SKIP=1 の場合は何もしない。
 * - 起動直後と 6 時間ごとに更新チェック。
 * - ダウンロードはバックグラウンドで autoUpdater が自動実施。
 * - 完了したら renderer に IPC で通知して、UI が
 *   「今すぐ再起動 / 次回起動時に適用」を出せるようにする。
 */
function initAutoUpdater(mainWindow) {
  if (started) return;
  started = true;
  mainWindowRef = mainWindow;

  if (isDev || SKIP) {
    log.info('[updater] skipped (dev or SKIP_AUTO_UPDATE=1)');
    return;
  }

  // electron-log を autoUpdater のロガーとして注入
  log.transports.file.level = 'info';
  log.transports.file.resolvePathFn = (variables) =>
    path.join(app.getPath('userData'), 'logs', variables.fileName ?? 'main.log');
  autoUpdater.logger = log;

  // 自動でダウンロード、終了時に自動インストール (= 次回起動で適用)
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;

  autoUpdater.on('checking-for-update', () => {
    log.info('[updater] checking for update...');
    send('updater:status', { type: 'checking' });
  });
  autoUpdater.on('update-available', (info) => {
    log.info('[updater] update available:', info.version);
    send('updater:status', { type: 'available', version: info.version });
  });
  autoUpdater.on('update-not-available', () => {
    send('updater:status', { type: 'not-available' });
  });
  autoUpdater.on('download-progress', (p) => {
    send('updater:status', {
      type: 'downloading',
      percent: Math.round(p.percent),
      transferred: p.transferred,
      total: p.total,
    });
  });
  autoUpdater.on('update-downloaded', (info) => {
    log.info('[updater] update downloaded:', info.version);
    send('updater:status', { type: 'downloaded', version: info.version });
    // ユーザーが renderer のトーストを見逃すケースが多いため、
    // ネイティブのダイアログでも通知する。「今すぐ再起動」を選んだら即時適用。
    try {
      const result = dialog.showMessageBoxSync({
        type: 'info',
        title: 'アップデートの準備ができました',
        message: `予約同期くん v${info.version} の準備ができました`,
        detail:
          '新しいバージョンをインストールするにはアプリの再起動が必要です。\n今すぐ再起動するか、次回起動時に自動適用するかを選んでください。',
        buttons: ['今すぐ再起動して更新', '次回起動時に適用'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (result === 0) {
        autoUpdater.quitAndInstall(true, true);
      }
    } catch (e) {
      log.warn('[updater] dialog show failed:', e);
    }
  });
  autoUpdater.on('error', (err) => {
    log.error('[updater] error:', err);
    send('updater:status', { type: 'error', message: String(err?.message ?? err) });
  });

  // 起動直後 + 以後 6 時間ごとにチェック
  void autoUpdater.checkForUpdatesAndNotify().catch((err) => {
    log.error('[updater] initial check failed:', err);
  });
  setInterval(
    () => {
      void autoUpdater.checkForUpdates().catch((err) => {
        log.error('[updater] periodic check failed:', err);
      });
    },
    6 * 60 * 60 * 1000,
  );
}

/**
 * renderer 側で「今すぐ再起動して適用」を押されたとき呼ぶ。
 * 直後にアプリが終了して再起動される。
 */
function quitAndInstall() {
  if (isDev || SKIP) return;
  // isSilent=true, forceRunAfter=true: ユーザー操作なしで再起動
  autoUpdater.quitAndInstall(true, true);
}

/**
 * renderer 側の「アップデートを今すぐ確認」ボタンから呼ばれる。
 * 結果は通常の `updater:status` IPC イベントで renderer に通知される。
 */
async function manualCheck() {
  if (isDev || SKIP) {
    log.info('[updater] manualCheck skipped (dev or SKIP_AUTO_UPDATE=1)');
    return { ok: false, reason: 'updater_disabled_in_dev' };
  }
  try {
    await autoUpdater.checkForUpdates();
    return { ok: true };
  } catch (err) {
    log.error('[updater] manualCheck failed:', err);
    return { ok: false, reason: String(err?.message ?? err) };
  }
}

module.exports = { initAutoUpdater, quitAndInstall, manualCheck };
