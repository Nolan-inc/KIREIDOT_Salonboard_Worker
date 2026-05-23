// Preload: Renderer から呼ぶ Electron API を contextBridge で公開する場所。
// contextIsolation: true なので、ここで明示的に露出させたものしか使えない。

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('salondesk', {
  version: '0.1.0',
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
});
