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
  // ループ検知カウンタのキー。旧background(jobId未送信)でも動くようフォールバック。
  if (!job.jobId) job.jobId = `${companyId || "na"}_${mode || "job"}`;
  console.log("[KireiDot] step", { url: location.href, companyId, hasCreds: !!(loginId && password), salonId });
  if (mode !== "hair-style-front") {
    throw new Error("このMVPは美容室スタイルFRONTのみ対応です (mode=" + mode + ")");
  }

  // ★二重投稿の最終防波堤: 登録完了画面に居る = この投稿は既に完了している。
  //   何らかの理由でジョブが再実行されても、ここで成功を返して終わり、
  //   再度 styleEdit を開いて再登録することを防ぐ。
  if (isRegisterDonePage()) {
    console.log("[KireiDot] 既に登録完了画面 → 二重投稿せず成功で終了");
    return { status: "registered", value: null };
  }

  const url = location.href;
  // ★ログイン状態の判定 (堅牢化 v0.0.16):
  //   旧実装は loggedInApp を「特定セレクタ(jscUploadImg/logout等)があるか」で
  //   判定していたため、ログイン後のトップ(例 /CLP/bt/top/)に それらが無く
  //   「未ログイン」と誤判定 → 自分で /login へ送還 → ログイン⇄トップ⇄ログインの
  //   無限ループになっていた。
  //   正しいモデル: 「ログインページ(URLが/login or パスワード欄あり)以外は
  //   ログイン済み」。SalonBoardは未ログインでアプリURLを開くと必ず/loginへ
  //   リダイレクトしフォームを出すので、この判定で取りこぼさない。
  const isLoginUrl = /\/login(\b|\/|\?|$)/i.test(url);
  let hasLoginForm = !!document.querySelector("input[type='password'], input[name='password']");
  // /login なのにフォーム未描画(描画が遅い)なら出現を待つ。
  if (!hasLoginForm && isLoginUrl) {
    try {
      await waitForSelector("input[type='password'], input[name='password']", 8000);
      hasLoginForm = true;
    } catch (_e) { /* それでも出ない = 想定外。下の判定で /login へ送る */ }
  }
  const onStyleEdit = !!document.querySelector("#FRONT_IMG_ID_IMG, img[id*='FRONT_IMG']");
  const onGroupTop = /\/(?:CNC|KLP|CLP)\/groupTop/i.test(url) || isGroupTopPage();

  // ★認証エラー画面の確実な検知 (v0.0.20):
  //   「認証エラーです。ログインしなおしてください。[ログインへ]」だけの画面は、
  //   URLが/loginでなく(styleEdit/doRegist等のまま)・パスワード欄も無いため
  //   従来 loggedInApp=true と誤判定し、ログインに行かず styleEdit を開き続けて
  //   無限ループしていた。この画面は「ログインへ リンク + 認証エラー文言 + アプリ
  //   コンテンツが無い」で確実に判別できる。検知したら /login へ送ってログインさせる。
  if (isAuthErrorPage()) {
    const authTries = await bumpJobCounter(job.jobId, "autherr");
    if (authTries > 3) {
      const e = new Error(
        "認証エラー画面からのログインを繰り返しています。ID/パスワードが正しいか、対象が美容室(ADER)の正しいアカウントか確認してください。",
      );
      e.code = "LOGIN_FAILED"; throw e;
    }
    console.log("[KireiDot] 認証エラー画面を検知 → ログイン画面へ", { tries: authTries });
    await clearLoggedCompany();
    const goLogin = findFirst(["a[href*='/login']", "a[href*='login']"]);
    const href = goLogin && goLogin.href ? goLogin.href : (location.origin + "/login/");
    throw NAV("認証エラー。ログイン画面へ移動します。", () => { location.href = href; });
  }

  // ログイン済み = ログインフォームが無く、/login URL でもなく、認証エラー画面でもない。
  const loggedInApp = !hasLoginForm && !isLoginUrl;

  // --- (A) ログインフォームが見えている → 対象会社のID/PWでログイン ---
  //     ★認証エラー判定より先に評価する。フォームが出ているなら、たとえ
  //       「ログインし直してください」の文言があっても、まず入力してログインする。
  //       (以前は (B) を先に評価していたため、/login に文言があると毎回 /login へ
  //        再遷移し、フォーム入力に到達できずログイン不能になっていた。)
  //     (URLが/loginでなくても、フォームが出ていればログイン画面とみなす)
  if (hasLoginForm) {
    if (!loginId || !password) {
      const e = new Error("SalonBoardにログインしていません。認証情報がジョブにありません(店舗のSalonBoard ID/PWを登録してください)。");
      e.code = "NOT_LOGGED_IN";
      throw e;
    }
    // ★ログイン試行の上限 (同一ジョブで4回以上 = 何かがセッションを切っている)。
    //   無限ループでSalonBoardにロックされる前に止め、原因をエラーで伝える。
    const loginTries = await bumpJobCounter(job.jobId, "login");
    if (loginTries > 3) {
      const e = new Error(
        "ログインを繰り返しています(4回目)。同じSalonBoardアカウントで予約同期くんの自動取得や他の端末が同時にログインしてセッションを切り合っている可能性があります。予約同期くんを最新版(v0.2.156以降)へ更新し、他の端末のアプリを終了してから再投稿してください。",
      );
      e.code = "LOGIN_LOOP";
      throw e;
    }
    console.log("[KireiDot] ログインフォーム検出 → 自動ログイン", { loginId: String(loginId).slice(0, 3) + "***", tries: loginTries });
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
    // ログイン成功 → 以降のループ検知カウンタをリセット (relogin/logout を仕切り直す)。
    await resetJobCounter(job.jobId, "relogin");
    await resetJobCounter(job.jobId, "logout");
    await resetJobCounter(job.jobId, "autherr");
    // ★ログイン後は styleEdit へ明示遷移する。ここで「reloadして再ポーリング」だけだと、
    //   ログイン直後にまだ /login が表示されている瞬間を次のポーリングが拾って
    //   再ログインし、結果的に何度もログインが走っていた。遷移先を固定して断ち切る。
    await sleep(800); // セッションCookie確定を少し待つ
    throw NAV("ログインしました。スタイル登録画面へ進みます。", () => { location.href = location.origin + "/CNB/draft/styleEdit/"; });
  }

  // --- (A') /login URL なのにフォームが出ない (描画失敗等) → /login を開き直す ---
  //     ※ ログイン済みのトップ等はここに来ない(loggedInApp=trueで下の(C)以降へ進む)。
  //       以前はログイン後トップをここで /login へ送り返してループしていた。
  if (isLoginUrl && !hasLoginForm) {
    console.log("[KireiDot] /login だがフォーム未検出 → /login を開き直す");
    throw NAV("ログイン画面を開き直します。", () => { location.href = location.origin + "/login/"; });
  }

  // --- (B) セッション切れの検知は「文言」では行わない (v0.0.18) ---
  //   以前は hasAuthError() のテキスト一致で /login へ送っていたが、ログイン直後の
  //   正常ページの文言にも誤反応し、ログイン成功→即/login→…の偽ループ(relogin)を
  //   起こしていた。SalonBoardは認証が切れた状態でアプリURLを開くと必ずログイン
  //   フォーム(または/loginリダイレクト)を出すので、その検知=(A)/(A')だけで
  //   「切れていれば自動ログイン、生きていればそのまま投稿」が成立する。
  //   → テキストベースのセッション切れ分岐は撤去。

  // --- (C) ログイン済み: 対象会社かどうか判定 ---
  const logged = await getLoggedCompany();
  if (companyId && logged.companyId && logged.companyId !== companyId) {
    // ★ログアウトの上限 (同一ジョブで3回以上 = 会社切替が成立していない)。
    const logoutTries = await bumpJobCounter(job.jobId, "logout");
    if (logoutTries > 2) {
      const e = new Error(
        "会社の切替(ログアウト→ログイン)を繰り返しています。SalonBoardのログインID設定が正しいか確認してください。",
      );
      e.code = "LOGIN_LOOP";
      throw e;
    }
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
        // 登録後: 完了画面 or styleList or エラー文言を待つ。
        const ok = await waitForRegisterResult(30000);
        if (ok === "error") {
          return { status: "uploaded_not_registered", reason: getValidationError(), value: uploadResult.value };
        }
        if (ok === "timeout") {
          // 完了画面もエラーも確認できなかった。完了画面に居れば成功、そうでなければ
          // 「結果不明」として manualRequired 相当に倒す(再投稿で二重登録しないため
          //  registered は返さない)。
          if (isRegisterDonePage()) return { status: "registered", value: uploadResult.value };
          return { status: "register_result_unknown", reason: "登録ボタンは押しましたが完了画面を確認できませんでした。SalonBoardの掲載一覧で重複が無いか確認してください。", value: uploadResult.value };
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

// 登録(doRegister)後の結果待ち。
//   - 完了画面「登録が完了しました。」を最優先で成功とみなす(これが正規の完了画面)。
//   - styleList へ戻った場合も成功。
//   - バリデーションエラー文言があれば error。
// ★タイムアウトしても "ok" を返さない("timeout"を返す)。以前は不明時に "ok" を
//   返していたが、完了を確認できないまま成功扱いするとworkerが再投稿を促し
//   何度も登録される事故につながるため。
async function waitForRegisterResult(timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    // 完了画面の確定文言 (スクショ: スタイル掲載情報編集 → 「登録が完了しました。」)。
    if (isRegisterDonePage()) return "ok";
    // styleList へ戻った = 登録成功。
    if (/\/styleList/i.test(location.href)) return "ok";
    // styleEdit 上にバリデーションエラーが出ている。
    if (getValidationError()) return "error";
    await sleep(500);
  }
  return "timeout";
}

// 登録完了画面かどうか (確定文言で判定)。
function isRegisterDonePage() {
  const t = (document.body?.innerText || "").replace(/\s+/g, "");
  return /登録が完了しました/.test(t) ||
    /反映する場合は.*反映申請/.test(t) ||
    /スタイル掲載情報一覧画面へ/.test(t);
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

// 認証エラー専用の中間ページかどうか。
//   例: 「認証エラーです。ログインしなおしてください。 [ログインへ]」だけの画面。
//   3条件すべてを満たすときだけ true にして、通常ページのお知らせ文言や
//   ログイン済みページでの誤反応を防ぐ:
//     1) 認証エラーの文言がある
//     2) 「ログインへ」リンクがある (このページの主アクション)
//     3) アプリ本体のコンテンツが無い (FRONT画像枠/スタイル一覧/サロン選択など)
function isAuthErrorPage() {
  const body = (document.body?.innerText || "").replace(/\s+/g, "");
  const hasAuthText = /認証エラー|ログインし(なおして|直して)|セッションが(切れ|無効)|タイムアウト/.test(body);
  if (!hasAuthText) return false;

  // 「ログインへ」リンク (href に login を含む or テキストが「ログインへ」)。
  let hasLoginLink = !!document.querySelector("a[href*='login' i]");
  if (!hasLoginLink) {
    hasLoginLink = Array.from(document.querySelectorAll("a")).some(
      (a) => /ログインへ|ログイン画面/.test((a.textContent || "").replace(/\s+/g, "")),
    );
  }
  if (!hasLoginLink) return false;

  // アプリ本体コンテンツが無いこと (あれば=ログイン済みの実ページなので誤反応にしない)。
  const hasAppContent = !!document.querySelector(
    "#FRONT_IMG_ID_IMG, img[id*='FRONT_IMG'], a.jscUploadImg, a.jscAddStyle, " +
    "#biyouStoreInfoArea, #kireiStoreInfoArea, a[href*='logout']"
  );
  return !hasAppContent;
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
// ジョブ単位の試行カウンタ (ページ遷移を跨いで持ち越すため storage に置く)。
// ログイン/ログアウトの無限ループを検知して止めるのに使う。
// 古いカウンタ(24h超)はついでに掃除する。
// ----------------------------------------------------------------------
function bumpJobCounter(jobId, kind) {
  const key = `kdJobCnt_${jobId}_${kind}`;
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(null, (all) => {
        const now = Date.now();
        const cur = all?.[key]?.n || 0;
        const next = cur + 1;
        const patch = { [key]: { n: next, at: now } };
        chrome.storage.local.set(patch, () => resolve(next));
        // 掃除 (非同期・失敗無視)
        try {
          const stale = Object.keys(all || {}).filter(
            (k) => k.startsWith("kdJobCnt_") && now - (all[k]?.at || 0) > 24 * 3600_000,
          );
          if (stale.length) chrome.storage.local.remove(stale, () => {});
        } catch (_e) { /* noop */ }
      });
    } catch (_e) { resolve(1); }
  });
}

function resetJobCounter(jobId, kind) {
  return new Promise((resolve) => {
    try { chrome.storage.local.remove(`kdJobCnt_${jobId}_${kind}`, resolve); }
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

  const styleEditUrl = location.origin + "/CNB/draft/styleEdit/";
  const styleListUrl = location.origin + "/CNB/draft/styleList/";

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
        throw NAV("スタイル新規追加へ進みます。");
      }
    }
    // 新規追加ボタンが見つからない → styleEdit を直接開く。
    console.log("[KireiDot] styleList に新規追加ボタンが無い → styleEdit を直接開く");
    throw NAV("スタイル登録画面へ移動します。", () => { location.href = styleEditUrl; });
  }

  // styleEdit のURLなら描画待ち。
  if (/\/styleEdit/i.test(location.href)) {
    try {
      await waitForSelector("#FRONT_IMG_ID_IMG, img[id*='FRONT_IMG']", 10000);
      return;
    } catch (_e) {
      // styleEdit を開いたのに画像枠が無い = サロン未選択で弾かれた等。
      // groupTop に飛ばされていれば runUpload の (D) が拾う。ここでは styleList
      // 経由を試す (単店舗ではここに来ない)。
      if (isGroupTopPage() || /\/(?:CNC|KLP|CLP)\/groupTop/i.test(location.href)) {
        throw NAV("サロン選択へ戻ります。");
      }
      // 認証エラー画面に飛ばされていれば runUpload 先頭の判定が拾うので、ここで
      // styleList へ無限に開き直さないようガードする。
      if (isAuthErrorPage()) {
        throw NAV("認証エラー。ログイン画面へ戻ります。", () => { location.href = location.origin + "/login/"; });
      }
      console.log("[KireiDot] styleEdit に画像枠が無い → styleList 経由を試す");
      throw NAV("スタイル一覧から開き直します。", () => { location.href = styleListUrl; });
    }
  }

  // それ以外のページ(トップ等) → styleEdit を直接開く (ユーザー要望: 画像アップロードは
  // styleEdit。単店舗アカウントは直接開ける。弾かれたら上の分岐で styleList 経由に回る)。
  console.log("[KireiDot] styleEdit を直接開く", styleEditUrl);
  throw NAV("スタイル登録画面へ移動します。", () => { location.href = styleEditUrl; });
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
