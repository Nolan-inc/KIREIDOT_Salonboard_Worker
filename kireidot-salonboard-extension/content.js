// =====================================================================
// KireiDot SalonBoard Helper — content script
// 美容室スタイル登録 (/CNB styleEdit) の FRONT 画像アップロードを、
// SalonBoard 公式の CN_CMN_imageUploaderModal の JS フローで実行する。
// 拡張は独自に POST せず、正しい file input に File を入れて change を発火し、
// 「登録する」を押すだけ。doUpload は通常Chromeセッションから送信される。
// =====================================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "KD_UPLOAD_IMAGE") return;

  (async () => {
    let diag = null;
    try {
      // 環境の自動診断 (Playwright方式との違いを確認)。
      diag = {
        extVersion: (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || "?",
        url: location.href,
        userAgent: navigator.userAgent,
        webdriver: navigator.webdriver,
        hasUploadButton: !!document.querySelector(
          "a.jscUploadImg, img.mod_btn_upload, #FRONT_IMG_ID_IMG"
        ),
        hasModalNow: !!document.querySelector("#imgUploadForm"),
        fileInputCount: document.querySelectorAll(
          "input.jscImageUploaderModalInput[type='file'], input.jscImageUploaderModalInput"
        ).length,
      };
      console.log("[KireiDot] diag", diag);

      const result = await runUpload(message);
      sendResponse({ ok: true, diag, result });
    } catch (e) {
      console.error("[KireiDot] upload failed", e);
      // SalonBoard 側のエラーダイアログ文言を拾って返す(原因切り分け用)。
      let sbError = null;
      try {
        const t = document.body.innerText || "";
        const m = t.match(/(通信に失敗しました[^\n]*|アップロードに失敗[^\n]*|ファイルサイズが大きすぎます[^\n]*|形式が正しくありません[^\n]*)/);
        if (m) sbError = m[1];
      } catch (_e) {}
      sendResponse({ ok: false, error: e.message, code: e.code || null, stack: e.stack, sbError, diag });
    }
  })();

  return true; // 非同期 sendResponse
});

async function runUpload({ mode, imageUrl, loginId, password }) {
  console.log("[KireiDot] start upload", { mode, imageUrl, hasCreds: !!(loginId && password) });
  if (mode !== "hair-style-front") {
    throw new Error("このMVPは美容室スタイルFRONTのみ対応です (mode=" + mode + ")");
  }

  // 0) ログイン状態の確認。未ログインなら、認証情報があれば自動ログインする。
  const loginIssue = detectLoginIssue();
  if (loginIssue) {
    if (loginId && password) {
      const ok = await tryAutoLogin(loginId, password);
      if (!ok) {
        const err = new Error("自動ログインに失敗しました。普段使いChromeで手動ログインしてからお試しください。");
        err.code = "NOT_LOGGED_IN";
        throw err;
      }
      // ログイン後、目的のstyleEditへ移動して再実行(NAVIGATED)。
      const err = new Error("自動ログインしました。スタイル画面へ移動して自動で再実行します。");
      err.code = "NAVIGATED";
      setTimeout(() => { location.href = location.origin + "/CNB/draft/styleEdit/"; }, 200);
      throw err;
    }
    const err = new Error(loginIssue);
    err.code = "NOT_LOGGED_IN";
    throw err;
  }

  // 0.5) styleList(一覧)にいる場合は styleEdit(登録画面)へ自動遷移する。
  await ensureOnStyleEdit();

  // 1) 画像を取得して File を作る。
  const image = await fetchImageAsFile(imageUrl);
  console.log("[KireiDot] image ready", { name: image.file.name, type: image.file.type, size: image.file.size });

  // 2) FRONT 画像アップロードのモーダルを開く (#imgUploadForm が出るまで)。
  await openUploadModal();

  // 3) モーダル内の正しい file input に File をセット。
  const input = await waitForSelector(
    "input.jscImageUploaderModalInput[type='file'], #imageUploaderModalBody input[type='file'], .jscImageUploaderModalDropArea input[type='file']",
    15000
  );
  setFileToInput(input, image.file);

  // 4) プレビュー(サムネ src) or waitImgeFile を待つ。
  await waitForPreview(8000);
  await sleep(400);

  // 5) 「登録する」(input.jscImageUploaderModalSubmitButton) をクリック。
  const submit = await waitForSelector(
    "input.jscImageUploaderModalSubmitButton[type='button'], input.jscImageUploaderModalSubmitButton, .jscImageUploaderModalSubmitButton",
    15000
  );
  realClick(submit);
  console.log("[KireiDot] clicked 登録する");

  // 6) 結果を待つ (FRONT_IMG_ID 反映 or 失敗ダイアログ)。
  const uploadResult = await waitForUploadResult(45000);
  return uploadResult;
}

// ----------------------------------------------------------------------
// ログイン状態の検出: ログイン画面 or 認証エラーダイアログを検知
// ----------------------------------------------------------------------
function detectLoginIssue() {
  const url = location.href;
  // ログイン関連URLに飛ばされている
  if (/\/login|\/CNB\/top|\/auth|\/CNC\/groupTop/i.test(url) && !/styleEdit|styleList/i.test(url)) {
    if (/\/login/i.test(url)) return "SalonBoardにログインしていません。普段使いのChromeでSalonBoardにログインしてから、もう一度お試しください。";
  }
  const text = document.body?.innerText || "";
  if (/認証エラー|ログインしなおして|ログインし直して|セッション.*切れ|再度ログイン/i.test(text)) {
    return "SalonBoardの認証が切れています(認証エラー)。普段使いのChromeでSalonBoardにログインし直してから、もう一度お試しください。";
  }
  // ログインフォームがそのまま出ている
  if (document.querySelector("input[name='userId'], input#userId, input[name='password']") && !document.querySelector("#FRONT_IMG_ID_IMG, a.jscUploadImg")) {
    return "SalonBoardのログイン画面が表示されています。ログインしてから、もう一度お試しください。";
  }
  return null;
}

// ----------------------------------------------------------------------
// 自動ログイン: ログイン画面で ID/PW を入力して「ログイン」を押す。
// SalonBoard のログインボタンは <a class="common-CNCcommon__primaryBtn" onclick="dologin(event)">。
// ----------------------------------------------------------------------
async function tryAutoLogin(loginId, password) {
  console.log("[KireiDot] auto-login 開始");
  // ログインフォームが現在ページに出るのを少し待つ(認証エラー→ログイン画面リダイレクトの直後など)。
  try {
    await waitForSelector("input[type='password'], input[name='password']", 8000);
  } catch (_e) {
    return false; // フォームが無い = ここでは自動ログインできない
  }
  return await fillAndSubmitLogin(loginId, password);
}

async function fillAndSubmitLogin(loginId, password) {
  const idInput = findFirst([
    "input[name='userId']",
    "input[name='loginId']",
    "input[name='loginCd']",
    "input[id*='login' i]",
    "input[type='email']",
    "input[type='text']",
  ]);
  const pwInput = document.querySelector("input[name='password'], input[type='password']");
  if (!idInput || !pwInput) return false;

  setNativeValue(idInput, loginId);
  setNativeValue(pwInput, password);
  await sleep(300);

  // ログインボタン。
  const btn = findFirst([
    "a.common-CNCcommon__primaryBtn",
    "a[onclick*='dologin']",
    "button[type='submit']",
    "input[type='submit']",
    "a:has(img[alt*='ログイン'])",
  ]);
  if (btn) {
    realClick(btn);
  } else {
    // 最後の手段: password で Enter。
    pwInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  }

  // ログイン後の遷移を待つ(パスワード欄が消える or styleEdit系へ)。
  const startedAt = Date.now();
  while (Date.now() - startedAt < 20000) {
    await sleep(500);
    const stillLogin = document.querySelector("input[type='password']");
    const errText = document.body?.innerText || "";
    if (/ID.*パスワード.*正しく|ログインできません|認証に失敗/.test(errText)) return false;
    if (!stillLogin) return true; // ログイン成功(フォームが消えた)
  }
  return !document.querySelector("input[type='password']");
}

// React/jQuery どちらでも値変更を拾わせるための値セット。
function setNativeValue(el, value) {
  try {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
  } catch (_e) { el.value = value; }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

// ----------------------------------------------------------------------
// styleList(一覧)にいる場合は styleEdit(登録画面)へ遷移する
// ----------------------------------------------------------------------
async function ensureOnStyleEdit() {
  // 既に styleEdit (FRONT画像枠がある) ならOK。
  if (document.querySelector("#FRONT_IMG_ID_IMG, img[id*='FRONT_IMG']")) return;

  // styleList の「スタイル新規追加」ボタンを探して押す。
  const addBtn = findFirst([
    "a.jscAddStyle",
    "a[onclick*='addStyle']",
    "a[href*='styleEdit']",
    "input[value*='新規追加']",
    "img[alt*='新規追加']",
    "a:has(img[alt*='新規追加'])",
  ]);
  if (addBtn) {
    console.log("[KireiDot] styleList → 新規追加クリックで styleEdit へ");
    realClick(addBtn);
    // styleEdit のFRONT画像枠が出るまで待つ(遷移 or AJAX)。
    try {
      await waitForSelector("#FRONT_IMG_ID_IMG, img[id*='FRONT_IMG']", 12000);
      return;
    } catch (_e) {
      /* 遷移しなかった場合は下のエラーへ */
    }
  }

  // FRONT画像枠が無い = styleEdit ではない → URLで直接 styleEdit に飛ぶ(同一オリジン)。
  // styleList に限らず、styleEdit でない限り移動する。
  if (!/\/styleEdit/i.test(location.href)) {
    const editUrl = location.origin + "/CNB/draft/styleEdit/";
    console.log("[KireiDot] styleEditでない → location 遷移", editUrl);
    // 遷移するとcontent scriptは再注入されるため、code=NAVIGATED を投げて
    // background にジョブを pending へ戻させ、styleEdit 上で再実行させる。
    const err = new Error("スタイル登録画面(styleEdit)へ移動します。数秒後に自動で再実行されます。");
    err.code = "NAVIGATED";
    setTimeout(() => { location.href = editUrl; }, 100);
    throw err;
  }

  // styleEdit のURLなのに FRONT画像枠が無い → 描画待ち。
  try {
    await waitForSelector("#FRONT_IMG_ID_IMG, img[id*='FRONT_IMG']", 8000);
    return;
  } catch (_e) {
    throw new Error(
      "スタイル登録画面(styleEdit)に画像枠が見つかりません。手動で「スタイル新規追加」を開いてからお試しください。URL=" +
        location.href
    );
  }
}

// ----------------------------------------------------------------------
// 画像取得 (background に依頼して Data URL → Blob → File)
// ----------------------------------------------------------------------
async function fetchImageAsFile(imageUrl) {
  const res = await chrome.runtime.sendMessage({
    type: "KD_FETCH_IMAGE_AS_DATA_URL",
    imageUrl,
  });
  if (!res?.ok) {
    throw new Error(res?.error || "画像取得に失敗しました");
  }
  const blob = dataUrlToBlob(res.dataUrl);
  const ext = guessExt(res.mimeType);
  const file = new File([blob], `kireidot-upload.${ext}`, {
    type: res.mimeType || blob.type || "image/jpeg",
    lastModified: Date.now(),
  });
  return { file, blob };
}

function dataUrlToBlob(dataUrl) {
  const [header, base64] = dataUrl.split(",");
  const mimeMatch = header.match(/data:(.*?);base64/);
  const mimeType = mimeMatch?.[1] || "image/jpeg";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

function guessExt(mimeType) {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/gif") return "gif";
  return "jpg";
}

// ----------------------------------------------------------------------
// モーダルを開く: FRONT 画像枠をクリック → #imgUploadForm が AJAX で出るまで待つ
// ----------------------------------------------------------------------
async function openUploadModal() {
  const trigger = findFirst([
    "img#FRONT_IMG_ID_IMG",
    "#FRONT_IMG_ID_IMG",
    "img[id*='FRONT_IMG']",
    "a.jscUploadImg",
    "img.mod_btn_upload",
  ]);
  if (!trigger) {
    throw new Error(
      "画像アップロードボタンが見つかりません。styleEdit(スタイル登録)画面を開いていますか? URL=" +
        location.href
    );
  }
  realClick(trigger);
  await waitForSelector("#imgUploadForm", 15000);
  console.log("[KireiDot] modal opened (#imgUploadForm present)");
}

// ----------------------------------------------------------------------
// file input に File をセットして change/input を発火
// SalonBoard 側の change ハンドラ(prepareFileInfo → addWaitImgeFile)を起動する
// ----------------------------------------------------------------------
function setFileToInput(input, file) {
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  // change/input を強めに発火 (composed:true でシャドウ境界も越える)。
  input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  console.log("[KireiDot] file set", {
    name: file.name,
    type: file.type,
    size: file.size,
    inputFiles: input.files?.length,
  });
}

// プレビュー(サムネ src) が出る = SalonBoard が File を受理 (waitImgeFile セット済み)
async function waitForPreview(timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const t = document.querySelector(
      "#imageUploaderModalBody img.jscImageUploaderModalThumbnail, img.jscImageUploaderModalThumbnail"
    );
    if (t && (t.getAttribute("src") || "").trim()) return true;
    await sleep(250);
  }
  console.warn("[KireiDot] preview not detected (続行する)");
  return false;
}

// ----------------------------------------------------------------------
// 結果待ち: FRONT_IMG_ID 反映 or 失敗ダイアログ検出
// ----------------------------------------------------------------------
async function waitForUploadResult(timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const bodyText = document.body.innerText || "";
    if (bodyText.includes("通信に失敗しました") || bodyText.includes("アップロードに失敗")) {
      throw new Error("SalonBoard側でアップロード失敗ダイアログを検出しました");
    }

    const frontImg = document.querySelector("input[name='FRONT_IMG_ID'], #FRONT_IMG_ID");
    const span = document.getElementById("FRONT_IMG_ID_ID");
    const spanVal = span ? (span.textContent || "").trim() : "";
    if ((frontImg && frontImg.value) || /^B\d{4,}$/.test(spanVal)) {
      return {
        status: "uploaded",
        field: "FRONT_IMG_ID",
        value: (frontImg && frontImg.value) || spanVal,
      };
    }
    await sleep(500);
  }
  throw new Error("アップロード結果の反映を確認できませんでした (タイムアウト)");
}

// ----------------------------------------------------------------------
// ユーティリティ
// ----------------------------------------------------------------------
function findFirst(selectors) {
  for (const selector of selectors) {
    try {
      const el = document.querySelector(selector);
      if (el) return el;
    } catch (_e) {
      /* :has 未対応等の保険 */
    }
  }
  return null;
}

async function waitForSelector(selector, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const el = document.querySelector(selector);
    if (el) return el;
    await sleep(250);
  }
  throw new Error(`要素が見つかりません: ${selector}`);
}

function realClick(el) {
  const rect = el.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  for (const type of ["mousedown", "mouseup", "click"]) {
    el.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: x,
        clientY: y,
      })
    );
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
