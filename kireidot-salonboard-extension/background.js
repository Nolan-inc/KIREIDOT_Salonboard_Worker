// =====================================================================
// background.js (service worker)
//  (1) 画像URL → fetch → Data URL を content script に返す (CORS回避)。
//  (2) 予約同期くんのローカルブリッジ(127.0.0.1:32178)をポーリングし、
//      pending ジョブを取得 → SalonBoardタブに送って自動アップロード →
//      結果を /jobs/:jobId/complete に返す。
// =====================================================================

const BRIDGE = "http://127.0.0.1:32178";
const POLL_ALARM = "kd_poll";

// ---- (1) 画像取得 ----
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "KD_FETCH_IMAGE_AS_DATA_URL") return;
  (async () => {
    try {
      const res = await fetch(message.imageUrl, { credentials: "omit" });
      if (!res.ok) throw new Error(`画像取得失敗 HTTP ${res.status}`);
      const blob = await res.blob();
      const dataUrl = await blobToDataUrl(blob);
      sendResponse({ ok: true, dataUrl, mimeType: blob.type || "image/jpeg" });
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true;
});

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// ---- ログアウト: salonboard.com の Cookie を全削除 ----
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "KD_LOGOUT") return;
  (async () => {
    try {
      let removed = 0;
      const domains = ["salonboard.com", ".salonboard.com", "beauty.hotpepper.jp"];
      for (const domain of domains) {
        const cookies = await chrome.cookies.getAll({ domain });
        for (const c of cookies) {
          const scheme = c.secure ? "https" : "http";
          const cookieUrl = `${scheme}://${c.domain.replace(/^\./, "")}${c.path}`;
          try {
            await chrome.cookies.remove({ url: cookieUrl, name: c.name });
            removed++;
          } catch (_e) { /* skip */ }
        }
      }
      sendResponse({ ok: true, removed });
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true;
});

// ---- (2) ジョブポーリング ----
// service worker は不定期に止まるので、alarm で定期起床してポーリングする。
chrome.runtime.onInstalled.addListener(() => setupAlarm());
chrome.runtime.onStartup.addListener(() => setupAlarm());
function setupAlarm() {
  chrome.alarms.create(POLL_ALARM, { periodInMinutes: 0.1 }); // ~6秒間隔(最小)
}
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) pollOnce();
});

let polling = false;

async function pollOnce() {
  if (polling) return;
  polling = true;
  try {
    // SalonBoardタブが開いていないときは何もしない(無駄な通信を避ける)。
    const sbTab = await findSalonBoardTab();
    if (!sbTab) return;

    let res;
    try {
      res = await fetch(`${BRIDGE}/jobs/next`, { cache: "no-store" });
    } catch (_e) {
      return; // ブリッジ未起動(予約同期くんが起動していない)
    }
    if (res.status === 204) return; // ジョブなし
    if (!res.ok) return;
    const job = await res.json();
    if (!job?.jobId) return;

    console.log("[KireiDot/bg] picked job", job);
    await runJob(job);
  } finally {
    polling = false;
  }
}

async function findSalonBoardTab() {
  const tabs = await chrome.tabs.query({ url: ["https://*.salonboard.com/*", "https://salonboard.com/*"] });
  // styleEdit/styleList を優先、無ければ最初のSalonBoardタブ。
  return (
    tabs.find((t) => /styleEdit|styleList|CNB/i.test(t.url || "")) || tabs[0] || null
  );
}

async function runJob(job) {
  const sbTab = await findSalonBoardTab();
  if (!sbTab?.id) {
    await complete(job.jobId, { status: "failed", error: "SalonBoardタブが見つかりません" });
    return;
  }
  // タブをアクティブに(content scriptが確実に動くように)。
  try { await chrome.tabs.update(sbTab.id, { active: true }); } catch (_e) {}

  try {
    const res = await chrome.tabs.sendMessage(sbTab.id, {
      type: "KD_UPLOAD_IMAGE",
      mode: job.mode || "hair-style-front",
      imageUrl: job.imageUrl, // ローカルブリッジの画像URL
      // 未ログイン時の自動ログイン用 (ローカルブリッジ由来)。
      loginId: job.loginId || null,
      password: job.password || null,
    });
    if (res?.ok) {
      await complete(job.jobId, {
        status: "success",
        imageId: res.result?.value || null,
        diag: res.diag || null,
      });
    } else if (res?.code === "NAVIGATED") {
      // styleList→styleEdit へ遷移中。ジョブを pending に戻して、遷移完了後に再実行。
      await complete(job.jobId, { status: "retry", error: res?.error || "navigating to styleEdit" });
      await sleep(3500); // 遷移＋content script 再注入を待つ
    } else {
      await complete(job.jobId, {
        status: "failed",
        error: res?.error || "アップロード失敗",
        diag: res?.diag || null,
        sbError: res?.sbError || null,
      });
    }
  } catch (e) {
    // content script 未注入など(ページ読み込み前)。少し待って次のポーリングで拾う。
    await complete(job.jobId, { status: "failed", error: "content scriptへの送信失敗: " + e.message });
  }
}

async function complete(jobId, payload) {
  try {
    await fetch(`${BRIDGE}/jobs/${jobId}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.warn("[KireiDot/bg] complete failed", e);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 起動直後にもポーリングを仕掛ける。
setupAlarm();
pollOnce();
