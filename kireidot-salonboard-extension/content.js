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

// 各ステップで「現在のページ状態」を見て1ステップだけ進め、ページ遷移が要るときは
// code=NAVIGATED を投げて bridge にジョブを pending へ戻させ、次のポーリングで続きを実行する
// (login/logout/サロン選択は全てページ遷移を伴うため、状態機械として実装)。
const NAV = (msg, action) => {
  if (typeof action === "function") { try { setTimeout(action, 150); } catch (_e) {} }
  const e = new Error(msg);
  e.code = "NAVIGATED";
  return e;
};

async function runUpload(job) {
  const { mode, imageUrl, loginId, password, companyId, salonId, expectedSalonName } = job;
  console.log("[KireiDot] step", { url: location.href, companyId, hasCreds: !!(loginId && password), salonId });
  if (mode !== "hair-style-front") {
    throw new Error("このMVPは美容室スタイルFRONTのみ対応です (mode=" + mode + ")");
  }

  const url = location.href;
  const hasLoginForm = !!document.querySelector("input[type='password'], input[name='password']");
  const onStyleEdit = !!document.querySelector("#FRONT_IMG_ID_IMG, img[id*='FRONT_IMG']");
  const onGroupTop = /\/(?:CNC|KLP)\/groupTop/i.test(url) || isGroupTopPage();
  const loggedInApp = onStyleEdit || onGroupTop || !!document.querySelector("a.jscUploadImg, a[href*='logout'], #biyouStoreInfoArea, #kireiStoreInfoArea");

  // --- (B) 認証エラー表示 → ログイン画面へ ---
  if (hasAuthError() && !hasLoginForm) {
    console.log("[KireiDot] 認証エラー → /login へ");
    await clearLoggedCompany();
    throw NAV("認証が切れています。ログイン画面へ移動します。", () => { location.href = location.origin + "/login/"; });
  }

  // --- (A) ログインフォームが見えている → 対象会社のID/PWでログイン ---
  //     (URLが/loginでなくても、フォームが出ていればログイン画面とみなす)
  if (hasLoginForm && !loggedInApp) {
    if (!loginId || !password) {
      const e = new Error("SalonBoardにログインしていません。認証情報がジョブにありません(店舗のSalonBoard ID/PWを登録してください)。");
      e.code = "NOT_LOGGED_IN";
      throw e;
    }
    console.log("[KireiDot] ログインフォーム検出 → 自動ログイン", { loginId: String(loginId).slice(0, 3) + "***" });
    const r = await fillAndSubmitLogin(loginId, password);
    if (r === "captcha") {
      const e = new Error("reCAPTCHA が表示されました。手動でログインしてからお試しください。");
      e.code = "LOGIN_FAILED"; throw e;
    }
    if (!r) {
      const e = new Error("自動ログインに失敗しました(ID/PW不一致の可能性)。");
      e.code = "LOGIN_FAILED"; throw e;
    }
    await setLoggedCompany(companyId, loginId);
    throw NAV("ログインしました。続けて処理します。");
  }

  // --- (A') ログインしていない & フォームも無い(=未ログインで別ページにいる/直接styleEditを開いて弾かれた) ---
  //     → /login/ へ移動してログインフォームを出す。
  if (!loggedInApp && !hasLoginForm && loginId && password) {
    console.log("[KireiDot] 未ログイン & フォーム無し → /login へ");
    throw NAV("ログイン画面へ移動します。", () => { location.href = location.origin + "/login/"; });
  }

  // --- (C) ログイン済み: 対象会社かどうか判定 ---
  const logged = await getLoggedCompany();
  if (companyId && logged.companyId && logged.companyId !== companyId) {
    console.log("[KireiDot] 別会社ログイン中 → ログアウト", { now: logged.companyId, target: companyId });
    await clearLoggedCompany();
    const out = await doLogout();
    throw NAV("別会社にログイン中のためログアウトします。", out);
  }

  // --- (D) グループ店舗選択(groupTop)に居る → 対象サロンを選択 ---
  if (onGroupTop) {
    console.log("[KireiDot] groupTop → サロン選択", { salonId, expectedSalonName });
    const sel = selectSalon(salonId, expectedSalonName);
    if (!sel) {
      throw new Error("グループ店舗の選択に失敗しました。サロンID/名称が一致しません (salonId=" + (salonId || "") + ")");
    }
    // サロン選択(javascript:void(0)のクリック)でサロン文脈が確立する。文脈確立を待ってから
    // styleList へ進む。ここで待たずに styleEdit を直接開くと groupTop に弾き戻されてループする。
    await sleep(1500);
    throw NAV("サロンを選択しました。スタイル一覧へ進みます。", () => { location.href = location.origin + "/CNB/draft/styleList/"; });
  }

  // --- (E) styleEdit でない → styleEdit へ ---
  await ensureOnStyleEdit();

  // --- (F) styleEdit で画像アップロード ---
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

  // --- (G) 必須項目を入力してスタイル登録 (style payload があれば) ---
  const sp = job.style || null;
  if (sp) {
    console.log("[KireiDot] スタイル必須項目を入力", sp);
    fillStyleForm(sp);
    await sleep(600);
    if (job.enablePost) {
      // doRegister(event) を呼ぶ「登録」リンクをクリック。
      const reg = findFirst([
        "a[onclick*='doRegister']",
        "img[alt='登録']",
        "a:has(img[alt='登録'])",
      ]);
      if (reg) {
        console.log("[KireiDot] 登録(doRegister)クリック");
        realClick(reg.closest("a") || reg);
        // 登録後: styleList へ戻る or エラー文言を待つ。
        const ok = await waitForRegisterResult(30000);
        if (ok === "error") {
          return { status: "uploaded_not_registered", reason: getValidationError(), value: uploadResult.value };
        }
        return { status: "registered", value: uploadResult.value };
      }
      return { status: "uploaded_no_register_btn", value: uploadResult.value };
    }
    // enablePost=false: 入力だけして登録はしない(確認用)。
    return { status: "filled_not_registered", value: uploadResult.value };
  }

  return uploadResult;
}

// styleEdit フォームの必須項目を入力する。
function fillStyleForm(sp) {
  const setVal = (el, v) => { if (!el) return; el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); };
  // スタイリスト (select#stylistCheckCd, value=T...)
  if (sp.stylistExternalId) {
    const sel = document.querySelector("#stylistCheckCd, select[name='frmStyleEditStylistCommentDto.stylistId']");
    if (sel) {
      const opt = Array.from(sel.options).find((o) => o.value === sp.stylistExternalId);
      if (opt) setVal(sel, sp.stylistExternalId);
    }
  }
  // コメント (120字)
  if (sp.comment) setVal(document.querySelector("#stylistCommentTxt, textarea[name='frmStyleEditStylistCommentDto.stylistComment']"), sp.comment.slice(0, 120));
  // スタイル名 (30字)
  if (sp.styleName) setVal(document.querySelector("#styleNameTxt, input[name='frmStyleEditStyleDto.styleName']"), sp.styleName.slice(0, 30));
  // カテゴリ (SG01=レディース / SG02=メンズ)
  const cat = sp.category || "SG01";
  const catRadio = document.querySelector(`input[name='frmStyleEditStyleDto.styleCategoryCd'][value='${cat}']`);
  if (catRadio) { catRadio.checked = true; catRadio.dispatchEvent(new Event("change", { bubbles: true })); catRadio.click(); }
  // 長さ (レディース=#ladiesHairLengthCd / メンズ=#mensHairLengthCd)
  const lenCd = sp.length || "HL03"; // 既定ミディアム
  if (cat === "SG02") setVal(document.querySelector("#mensHairLengthCd, select[name='frmStyleEditStyleDto.mensHairLengthCd']"), lenCd);
  else setVal(document.querySelector("#ladiesHairLengthCd, select[name='frmStyleEditStyleDto.ladiesHairLengthCd']"), lenCd);
  // メニュー内容(テキスト, 必須・50字) #menuDetailTxt。
  if (sp.menuDetail) setVal(document.querySelector("#menuDetailTxt, textarea[name='frmStyleEditStyleDto.menuContents']"), sp.menuDetail.slice(0, 50));

  // メニュー内容 (チェックボックス, MC01..)。複数可。必須なので最低1つ確実にチェックする。
  const menus = Array.isArray(sp.menus) && sp.menus.length ? sp.menus : [];
  let checkedAny = false;
  for (const mc of menus) {
    const cb = document.querySelector(`input[name='frmStyleEditStyleDto.menuContentsCdList'][value='${mc}']`);
    if (cb) { if (!cb.checked) { cb.checked = true; cb.dispatchEvent(new Event("change", { bubbles: true })); cb.click(); } checkedAny = true; }
  }
  // 指定メニューが1つも存在しなかった → 先頭のメニューを必須対策でチェック。
  if (!checkedAny) {
    const first = document.querySelector("input[name='frmStyleEditStyleDto.menuContentsCdList']");
    if (first && !first.checked) { first.checked = true; first.dispatchEvent(new Event("change", { bubbles: true })); first.click(); }
  }
}

// 登録(doRegister)後の結果待ち。styleList へ戻れば成功、バリデーションエラー文言なら error。
async function waitForRegisterResult(timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    await sleep(500);
    // styleList へ戻った = 登録成功。
    if (/\/styleList/i.test(location.href)) return "ok";
    // styleEdit 上にバリデーションエラーが出ている。
    if (getValidationError()) return "error";
    // FRONT画像枠が無くなった(別ページへ遷移) = 成功とみなす。
    if (!document.querySelector("#FRONT_IMG_ID")) return "ok";
  }
  return "ok";
}

function getValidationError() {
  // 必須未入力等のエラー表示を拾う。
  const errEl = document.querySelector(".common-CNBcommon__errorText, .errorTxt, .error_message, .div_err_message, .style_edit-editCommon__text--error");
  if (errEl && (errEl.textContent || "").trim()) return errEl.textContent.trim().slice(0, 200);
  const body = document.body?.innerText || "";
  const m = body.match(/(必須項目[^\n]*入力[^\n]*|入力してください[^\n]*|選択してください[^\n]*)/);
  return m ? m[1] : null;
}

// ----------------------------------------------------------------------
// ページ状態の判定
// ----------------------------------------------------------------------
function isLoginPage() {
  if (/\/login/i.test(location.href)) return true;
  const hasPw = !!document.querySelector("input[type='password'], input[name='password']");
  const hasApp = !!document.querySelector("#FRONT_IMG_ID_IMG, a.jscUploadImg, a[id^='H']");
  return hasPw && !hasApp;
}

function hasAuthError() {
  const text = document.body?.innerText || "";
  return /認証エラー|ログインしなおして|ログインし直して|セッション.*切れ|再度ログイン/i.test(text);
}

function isGroupTopPage() {
  return !!document.querySelector("#biyouStoreInfoArea, #kireiStoreInfoArea, table.mod_table19 a[id^='H']");
}

// ----------------------------------------------------------------------
// ログイン中の会社を Storage で追跡 (会社切替判定の主軸)
// ----------------------------------------------------------------------
function getLoggedCompany() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(["kdLoggedCompanyId", "kdLoggedLoginId"], (v) => {
        resolve({ companyId: v?.kdLoggedCompanyId || null, loginId: v?.kdLoggedLoginId || null });
      });
    } catch (_e) { resolve({ companyId: null, loginId: null }); }
  });
}
function setLoggedCompany(companyId, loginId) {
  return new Promise((resolve) => {
    try { chrome.storage.local.set({ kdLoggedCompanyId: companyId || null, kdLoggedLoginId: loginId || null }, resolve); }
    catch (_e) { resolve(); }
  });
}
function clearLoggedCompany() {
  return new Promise((resolve) => {
    try { chrome.storage.local.remove(["kdLoggedCompanyId", "kdLoggedLoginId"], resolve); }
    catch (_e) { resolve(); }
  });
}

// ----------------------------------------------------------------------
// ログアウト: ヘッダのログアウトリンクを押す。無ければ既知URLへ。
// 返り値: NAV に渡す遷移アクション関数。
// ----------------------------------------------------------------------
function doLogout() {
  const link = findFirst([
    "a[href*='logout']",
    "a[onclick*='logout']",
    "a[onclick*='Logout']",
  ]);
  if (link && link.href && /logout/i.test(link.href)) {
    const href = link.href;
    return () => { location.href = href; };
  }
  if (link) {
    return () => realClick(link);
  }
  return () => { location.href = location.origin + "/CNC/common/logout/"; };
}

// ----------------------------------------------------------------------
// groupTop で対象サロンを選択 (salonId 優先、無ければ名称一致、単一なら自動)
// ----------------------------------------------------------------------
function selectSalon(salonId, expectedSalonName) {
  const norm = (s) => (s || "").replace(/\s+/g, "").trim();
  const links = Array.from(document.querySelectorAll("a[id^='H']")).filter((a) => /^H\d+/i.test(a.id));
  if (links.length === 0) return false;
  let target = null;
  if (salonId) target = links.find((a) => a.id.toUpperCase() === String(salonId).toUpperCase()) || null;
  if (!target && expectedSalonName) {
    const want = norm(expectedSalonName);
    target = links.find((a) => norm(a.textContent).includes(want) || want.includes(norm(a.textContent))) || null;
  }
  if (!target && links.length === 1) target = links[0];
  if (!target) return false;
  realClick(target);
  return true;
}

// ----------------------------------------------------------------------
// ログインフォームに ID/PW を入れて「ログイン」を押す。
// SalonBoard のログインボタンは <a class="common-CNCcommon__primaryBtn" onclick="dologin(event)">。
// ----------------------------------------------------------------------
async function fillAndSubmitLogin(loginId, password) {
  // worker(tryLogin)と同じ流れ。reCAPTCHAが出ていたら手動誘導。
  if (document.querySelector("iframe[src*='recaptcha']")) return "captcha";

  // 入力欄の出現を待つ(描画が遅いことがある)。
  try { await waitForSelector("input[type='password'], input[name='password']", 12000); } catch (_e) { return false; }

  // ID欄: worker と同じ優先順。:visible は querySelector で無効なのでJSで可視判定。
  const idInput =
    document.querySelector("input[name='userId'], input[name='loginId'], input[name='loginCd'], input[id*='login' i], input[type='email']") ||
    Array.from(document.querySelectorAll("input[type='text']")).find((el) => el.offsetParent !== null);
  const pwInput = document.querySelector("input[name='password'], input[type='password']");
  if (!idInput || !pwInput) return false;

  // クリックしてフォーカス → 値セット(input/change発火)。
  try { idInput.click(); } catch (_e) {}
  setNativeValue(idInput, loginId);
  await sleep(300);
  try { pwInput.click(); } catch (_e) {}
  setNativeValue(pwInput, password);
  await sleep(500);

  // 値が入ったか確認(空ならログインしても弾かれる)。
  if (!idInput.value || !pwInput.value) {
    // フォールバック: もう一度直接代入。
    idInput.value = loginId; pwInput.value = password;
    idInput.dispatchEvent(new Event("change", { bubbles: true }));
    pwInput.dispatchEvent(new Event("change", { bubbles: true }));
  }
  console.log("[KireiDot] login fields filled", { idLen: idInput.value.length, pwLen: pwInput.value.length });

  // ログインボタン (worker と同じ候補)。
  const btn = findFirst([
    "a.common-CNCcommon__primaryBtn",
    "a.loginBtnSize",
    "a[onclick*='dologin']",
    "a[onclick*='Login']",
    "button[type='submit']",
    "input[type='submit']",
  ]);
  if (btn) {
    console.log("[KireiDot] ログインボタンclick", btn.className || btn.tagName);
    realClick(btn);
  } else {
    // 最後の手段: password 欄で Enter (onkeypress=enterActionLogin)。
    pwInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, which: 13, bubbles: true }));
    pwInput.dispatchEvent(new KeyboardEvent("keypress", { key: "Enter", keyCode: 13, which: 13, bubbles: true }));
    pwInput.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", keyCode: 13, which: 13, bubbles: true }));
  }

  // ログイン後の遷移を待つ(パスワード欄が消える=成功 / エラー文言=失敗)。
  const startedAt = Date.now();
  while (Date.now() - startedAt < 20000) {
    await sleep(500);
    if (document.querySelector("iframe[src*='recaptcha']")) return "captcha";
    const stillLogin = document.querySelector("input[type='password']");
    const errText = (document.body?.innerText || "").replace(/\s+/g, "");
    if (/IDまたはパスワード|正しく入力|ログインできません|認証に失敗|ご登録の/.test(errText)) return false;
    if (!stillLogin) return true; // フォームが消えた=ログイン成功(遷移した)
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

  // ★重要: styleEdit へは「styleList(一覧) → スタイル新規追加」の順で入るのが正規ルート。
  //   /CNB/draft/styleEdit/ を直接開くとサロン文脈が無く groupTop に弾き戻される
  //   (= サロン選択↔styleEdit のループになる)。なので styleList を経由する。

  // styleList に居る → 「スタイル新規追加」ボタンを押して styleEdit へ。
  if (/\/styleList/i.test(location.href) || document.querySelector("a.jscAddStyle, a[onclick*='addStyle']")) {
    const addBtn = findFirst([
      "a.jscAddStyle",
      "a[onclick*='addStyle']",
      "a[href*='styleEdit']",
      "input[value*='新規追加']",
      "img[alt*='新規追加']",
    ]);
    if (addBtn) {
      console.log("[KireiDot] styleList → 新規追加クリックで styleEdit へ");
      realClick(addBtn);
      try {
        await waitForSelector("#FRONT_IMG_ID_IMG, img[id*='FRONT_IMG']", 12000);
        return;
      } catch (_e) {
        // クリックで遷移しなかった → NAVIGATEDで再ポーリング(styleEdit描画待ち)。
        throw NAV("スタイル新規追加へ進みます。");
      }
    }
  }

  // styleList でも styleEdit でもない → styleList へ移動 (styleEdit直開きはしない)。
  if (!/\/styleList|\/styleEdit/i.test(location.href)) {
    const listUrl = location.origin + "/CNB/draft/styleList/";
    console.log("[KireiDot] styleList へ移動", listUrl);
    throw NAV("スタイル一覧へ移動します。", () => { location.href = listUrl; });
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
