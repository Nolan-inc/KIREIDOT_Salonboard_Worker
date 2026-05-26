// Preload: Renderer から呼ぶ Electron API を contextBridge で公開する場所。
// contextIsolation: true なので、ここで明示的に露出させたものしか使えない。

const { contextBridge, ipcRenderer } = require('electron');

// package.json から実際のバージョンを動的取得 (build 時に asar 内に同梱される)
let appVersion = '0.0.0';
try {
  appVersion = require('../package.json').version || '0.0.0';
} catch (_e) {
  /* fallback */
}

contextBridge.exposeInMainWorld('salondesk', {
  version: appVersion,
  platform: process.platform,
});

// Google OAuth (Deep Link) 用の最小 API
// - openExternal: Supabase が返した OAuth URL をシステムブラウザで開く
// - onOAuthCallback: kireidot-salondesk://auth/callback?code=... を受け取る
// - removeOAuthCallbackListener: クリーンアップ用
contextBridge.exposeInMainWorld('kireidotApp', {
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  onOAuthCallback: (handler) => {
    const listener = (_event, url) => {
      if (typeof url === 'string') handler(url);
    };
    ipcRenderer.on('oauth:callback', listener);
    return () => ipcRenderer.removeListener('oauth:callback', listener);
  },
  // 自動アップデート: main からのステータス通知を購読 / 即時適用要求を送信
  onUpdaterStatus: (handler) => {
    const listener = (_event, status) => handler(status);
    ipcRenderer.on('updater:status', listener);
    return () => ipcRenderer.removeListener('updater:status', listener);
  },
  quitAndInstallUpdate: () => ipcRenderer.invoke('updater:quit-and-install'),
  checkForUpdate: () => ipcRenderer.invoke('updater:check'),

  // ---- Worker (utilityProcess) 操作 ----
  // init: Supabase URL/anonKey/session を渡して worker を初期化
  // sync: 同期実行 (shopIds 指定で個別店舗、未指定で全店舗)
  // abort: 進行中の同期を中断
  // onWorkerEvent: worker からのイベント (boot/ready/log/run:*/shop:*/error) を購読
  workerInit: (payload) => ipcRenderer.invoke('worker:init', payload),
  workerSync: (payload) => ipcRenderer.invoke('worker:sync', payload),
  workerAbort: () => ipcRenderer.invoke('worker:abort'),
  onWorkerEvent: (handler) => {
    const listener = (_event, msg) => handler(msg);
    ipcRenderer.on('worker:event', listener);
    return () => ipcRenderer.removeListener('worker:event', listener);
  },
});
