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
  workerTestPush: (payload) => ipcRenderer.invoke('worker:test-push', payload),
  workerCancelBooking: (payload) => ipcRenderer.invoke('worker:cancel-booking', payload),
  workerChangeBooking: (payload) => ipcRenderer.invoke('worker:change-booking', payload),
  workerAbort: () => ipcRenderer.invoke('worker:abort'),
  onWorkerEvent: (handler) => {
    const listener = (_event, msg) => handler(msg);
    ipcRenderer.on('worker:event', listener);
    return () => ipcRenderer.removeListener('worker:event', listener);
  },

  // auth-storage (v0.2.9): Supabase セッションを userData に永続化する。
  // 本番ビルドの file:// では localStorage が消えるため、userData/auth-storage.json に
  // 同期的なフロントで読み書きできるよう Promise を返す API として expose する。
  authStorage: {
    getItem: (key) => ipcRenderer.invoke('auth-storage:get', key),
    setItem: (key, value) => ipcRenderer.invoke('auth-storage:set', key, value),
    removeItem: (key) => ipcRenderer.invoke('auth-storage:remove', key),
  },

  // device 設定 (v0.2.5): 店舗 PC ごとの device_id / device_token を
  // userData に保存。get はマスク済み (token last4 のみ) を返す。
  deviceConfig: {
    // 保存済み設定 (マスク済み) を取得
    get: () => ipcRenderer.invoke('device:get'),
    // 設定を保存 (内部で接続テストを実行し、成功時のみ lastVerifiedAt を更新)
    save: (payload) => ipcRenderer.invoke('device:save', payload),
    // 設定を削除
    clear: () => ipcRenderer.invoke('device:clear'),
    // 接続テスト (payload 省略時は保存済み設定でテスト)
    test: (payload) => ipcRenderer.invoke('device:test', payload),
    // 予約を作成し SalonBoard へ push (保存済み設定の apiUrl/token を使用)
    createBooking: (payload) => ipcRenderer.invoke('device:create-booking', payload),
    createContent: (payload) => ipcRenderer.invoke('device:create-content', payload),
    deleteContent: (payload) => ipcRenderer.invoke('device:delete-content', payload),
    // 実登録トグルのみ更新
    setEnablePush: (enablePush) =>
      ipcRenderer.invoke('device:set-enable-push', { enablePush }),
  },
});
