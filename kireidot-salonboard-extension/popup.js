const logEl = document.getElementById("log");
const runBtn = document.getElementById("run");
const imageUrlEl = document.getElementById("imageUrl");

function log(message) {
  const ts = new Date().toLocaleTimeString("ja-JP");
  logEl.textContent += `[${ts}] ${message}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

// 直近の画像URLを保存/復元(検証を繰り返しやすく)。
chrome.storage.local.get(["lastImageUrl"], (v) => {
  if (v?.lastImageUrl) imageUrlEl.value = v.lastImageUrl;
});

runBtn.addEventListener("click", async () => {
  const imageUrl = imageUrlEl.value.trim();
  const mode = document.getElementById("mode").value;

  if (!imageUrl) {
    log("画像URLを入力してください");
    return;
  }
  chrome.storage.local.set({ lastImageUrl: imageUrl });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    log("現在のタブが見つかりません");
    return;
  }
  if (!/salonboard\.com/.test(tab.url || "")) {
    log("⚠️ SalonBoard のタブで実行してください（現在: " + (tab.url || "不明") + "）");
    return;
  }

  runBtn.disabled = true;
  log("SalonBoardページへ送信中… (" + mode + ")");

  try {
    const res = await chrome.tabs.sendMessage(tab.id, {
      type: "KD_UPLOAD_IMAGE",
      mode,
      imageUrl,
    });
    log(JSON.stringify(res, null, 2));
    if (res?.ok) log("✅ 完了");
    else log("🔴 失敗");
  } catch (e) {
    // content script が未注入(ページ読込前/対象外)のときに出る。
    log("送信失敗: " + e.message + "（ページを再読み込みしてからお試しください）");
  } finally {
    runBtn.disabled = false;
  }
});
