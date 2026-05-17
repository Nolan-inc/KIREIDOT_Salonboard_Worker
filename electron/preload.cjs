// Preload: 将来 Renderer から呼ぶ Electron API を contextBridge で公開する場所
// 現状は UI 骨組みなので最小限。
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('salondesk', {
  version: '0.1.0',
  platform: process.platform,
});
