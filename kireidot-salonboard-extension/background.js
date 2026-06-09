// 画像URLからBlobを取得して Data URL として content script に返す。
// content script から直接 fetch すると CORS で詰まることがあるため、
// 拡張のバックグラウンド(host_permissions あり)で取得する。
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "KD_FETCH_IMAGE_AS_DATA_URL") {
    return; // 他メッセージは無視
  }

  (async () => {
    try {
      // credentials: 'omit' で、画像配信側に余計なCookieを送らない。
      const res = await fetch(message.imageUrl, { credentials: "omit" });
      if (!res.ok) {
        throw new Error(`画像取得失敗 HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const dataUrl = await blobToDataUrl(blob);
      sendResponse({ ok: true, dataUrl, mimeType: blob.type || "image/jpeg" });
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();

  return true; // 非同期 sendResponse
});

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
