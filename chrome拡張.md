PlaywrightでChromeを起動するのをやめて、ユーザーが普段使っているChrome上でSalonBoardを開き、そのページ内にChrome拡張を差し込んで、SalonBoard公式JSの流れで画像アップロードさせる方式です。

これならAkamai側から見ると、

普段使いのChrome
普段使いのCookie
普段使いのSalonBoardログイン状態
人間が使っている通常プロファイル

になるので、今の「自動化Chromeセッションが弾かれる」問題を避けられる可能性が高いです。

Chrome拡張は、ページDOMを読んだり変更したりできるcontent scriptを使えます。ただしcontent scriptはページ本体のJS空間とは分離されているため、SalonBoard側の window.waitImgeFile などに直接触る場合は注意が必要です。基本は正しいfile inputにFileを入れてchangeイベントを発火し、SalonBoard側のjQueryイベントに処理させるのが安全です。Chrome公式ドキュメントでも、content scriptはWebページのDOMを読んだり変更できる一方、ページとは isolated world で分離されると説明されています。

まず作るべき構成

最初は大きく作らず、画像アップロードだけのMVPにしてください。

MVPの流れ
ユーザーが普段のChromeでSalonBoardにログインする
スタイル登録画面、またはフォトギャラリー編集画面を開く
Chrome拡張のボタンを押す
拡張機能が画像URLを取得する
SalonBoardの画像アップロードモーダルを開く
モーダル内の input.jscImageUploaderModalInput に画像Fileをセット
change イベントを発火
SalonBoard側のJSが window.waitImgeFile に保持
「登録する」ボタンをクリック
doUpload が通常Chromeセッションから送信される
成功したら FRONT_IMG_ID などに反映される

これで成功すれば、かなり大きな前進です。

重要な注意点
ローカルファイルのパスを直接セットするのはできない

Chrome拡張から、

input.value = "/Users/xxx/image.jpg"

のようにローカル画像パスを直接セットすることはできません。

なので画像は以下のどちらかで渡します。

おすすめ：画像URL方式

KireiDot側で画像を一時的にURL化します。

例：

Supabase Storageの署名付きURL
自社APIの一時URL
http://127.0.0.1:xxxx/image/job-id のローカル配信URL

拡張機能がそのURLから画像を fetch して、Blobから File を作り、SalonBoardのfile inputに入れます。

もう一つ：Native Messaging方式

画像がローカルPC上にしかない場合は、Chrome拡張とローカルアプリをつなぐ Native Messaging を使います。Chrome公式でも、拡張機能はNative Messagingでネイティブアプリと標準入出力経由で通信できると説明されています。

ただし最初は重いので、まず画像URL方式で検証がいいです。

手順1：Chrome拡張のフォルダを作る

まずローカルにこういう構成で作ります。

kireidot-salonboard-extension/
  manifest.json
  content.js
  background.js
  popup.html
  popup.js
手順2：manifest.jsonを作る

Chrome拡張はManifest V3で作ります。拡張機能APIやhost permissionsは manifest.json に宣言する必要があります。Chrome公式にも、拡張機能の権限はmanifestの permissions、host_permissions、content_scripts.matches などで宣言すると説明されています。

{
  "manifest_version": 3,
  "name": "KireiDot SalonBoard Helper",
  "version": "0.0.1",
  "description": "KireiDotからSalonBoardの画像アップロードを補助する拡張機能",
  "permissions": [
    "activeTab",
    "scripting",
    "storage"
  ],
  "host_permissions": [
    "https://*.salonboard.com/*",
    "https://salonboard.com/*",
    "https://*.hotpepper.jp/*",
    "https://*.beauty.hotpepper.jp/*",
    "https://YOUR-KIREIDOT-DOMAIN.com/*",
    "http://127.0.0.1:*/*",
    "http://localhost:*/*"
  ],
  "background": {
    "service_worker": "background.js"
  },
  "action": {
    "default_title": "KireiDot Upload",
    "default_popup": "popup.html"
  },
  "content_scripts": [
    {
      "matches": [
        "https://*.salonboard.com/*",
        "https://salonboard.com/*",
        "https://*.hotpepper.jp/*",
        "https://*.beauty.hotpepper.jp/*"
      ],
      "js": ["content.js"],
      "run_at": "document_idle"
    }
  ]
}

matches の指定はURLパターンです。Chrome公式では、match patternは <scheme>://<host>/<path> 形式で、content script注入やhost permissionに使われると説明されています。

実際のSalonBoardドメインが違う場合は、ログイン後のURLを見て host_permissions と matches に追加してください。

手順3：popup.htmlを作る

最初は手動テスト用に、画像URLを入力してボタンを押す形にします。

<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      body {
        width: 320px;
        font-family: sans-serif;
        padding: 12px;
      }
      input, button, select {
        width: 100%;
        margin-top: 8px;
        padding: 8px;
        box-sizing: border-box;
      }
      pre {
        white-space: pre-wrap;
        font-size: 12px;
        background: #f5f5f5;
        padding: 8px;
      }
    </style>
  </head>
  <body>
    <h3>KireiDot Upload Test</h3>

    <label>画像URL</label>
    <input id="imageUrl" placeholder="https://.../image.jpg" />

    <label>対象</label>
    <select id="mode">
      <option value="hair-style-front">美容室スタイル FRONT</option>
      <option value="esthetic-photo-gallery">エステ フォトギャラリー</option>
    </select>

    <button id="run">画像アップロード実行</button>

    <pre id="log"></pre>

    <script src="popup.js"></script>
  </body>
</html>
手順4：popup.jsを作る

現在開いているSalonBoardタブに、画像アップロード指示を送ります。

const logEl = document.getElementById("log");

function log(message) {
  logEl.textContent += message + "\n";
}

document.getElementById("run").addEventListener("click", async () => {
  const imageUrl = document.getElementById("imageUrl").value.trim();
  const mode = document.getElementById("mode").value;

  if (!imageUrl) {
    log("画像URLを入力してください");
    return;
  }

  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  if (!tab?.id) {
    log("現在のタブが見つかりません");
    return;
  }

  log("SalonBoardページへ送信中...");

  try {
    const res = await chrome.tabs.sendMessage(tab.id, {
      type: "KD_UPLOAD_IMAGE",
      mode,
      imageUrl
    });

    log(JSON.stringify(res, null, 2));
  } catch (e) {
    log("送信失敗: " + e.message);
  }
});
手順5：background.jsを作る

画像URLからBlobを取得して、Data URLとしてcontent scriptに返します。

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "KD_FETCH_IMAGE_AS_DATA_URL") {
    return;
  }

  (async () => {
    try {
      const res = await fetch(message.imageUrl, {
        credentials: "omit"
      });

      if (!res.ok) {
        throw new Error(`画像取得失敗 HTTP ${res.status}`);
      }

      const blob = await res.blob();
      const dataUrl = await blobToDataUrl(blob);

      sendResponse({
        ok: true,
        dataUrl,
        mimeType: blob.type || "image/jpeg"
      });
    } catch (e) {
      sendResponse({
        ok: false,
        error: e.message
      });
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
手順6：content.jsを作る

ここが本体です。

SalonBoardページ上で、

アップロードボタンを探す
モーダルを開く
file inputにFileをセット
changeイベントを発火
登録ボタンを押す
結果を見る

を行います。

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "KD_UPLOAD_IMAGE") {
    return;
  }

  (async () => {
    try {
      const result = await runUpload(message);
      sendResponse({
        ok: true,
        result
      });
    } catch (e) {
      console.error("[KireiDot] upload failed", e);
      sendResponse({
        ok: false,
        error: e.message,
        stack: e.stack
      });
    }
  })();

  return true;
});

async function runUpload({ mode, imageUrl }) {
  console.log("[KireiDot] start upload", { mode, imageUrl });

  const image = await fetchImageAsFile(imageUrl);

  await openUploadModal(mode);

  const input = await waitForSelector(
    "input.jscImageUploaderModalInput[type='file']",
    15000
  );

  setFileToInput(input, image.file);

  await sleep(500);

  const submit = await waitForSelector(
    "input.jscImageUploaderModalSubmitButton[type='button'], input.jscImageUploaderModalSubmitButton",
    15000
  );

  realClick(submit);

  const uploadResult = await waitForUploadResult(mode, 45000);

  return uploadResult;
}

async function fetchImageAsFile(imageUrl) {
  const res = await chrome.runtime.sendMessage({
    type: "KD_FETCH_IMAGE_AS_DATA_URL",
    imageUrl
  });

  if (!res?.ok) {
    throw new Error(res?.error || "画像取得に失敗しました");
  }

  const blob = dataUrlToBlob(res.dataUrl);
  const ext = guessExt(res.mimeType);
  const file = new File([blob], `kireidot-upload.${ext}`, {
    type: res.mimeType || blob.type || "image/jpeg",
    lastModified: Date.now()
  });

  return { file, blob };
}

function dataUrlToBlob(dataUrl) {
  const [header, base64] = dataUrl.split(",");
  const mimeMatch = header.match(/data:(.*?);base64/);
  const mimeType = mimeMatch?.[1] || "image/jpeg";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return new Blob([bytes], { type: mimeType });
}

function guessExt(mimeType) {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/gif") return "gif";
  return "jpg";
}

async function openUploadModal(mode) {
  const selectors = [];

  if (mode === "hair-style-front") {
    selectors.push(
      "img#FRONT_IMG_ID_IMG",
      "#FRONT_IMG_ID_IMG",
      "img[id*='FRONT_IMG']",
      "a.jscUploadImg",
      "img.mod_btn_upload"
    );
  }

  if (mode === "esthetic-photo-gallery") {
    selectors.push(
      "a.jscUploadImg",
      "img.mod_btn_upload",
      "img[src*='upload']",
      "a:has(img.mod_btn_upload)"
    );
  }

  selectors.push(
    "a.jscUploadImg",
    "img.mod_btn_upload",
    "[onclick*='img_upload']"
  );

  const trigger = findFirst(selectors);

  if (!trigger) {
    throw new Error("画像アップロードボタンが見つかりません");
  }

  realClick(trigger);

  await waitForSelector("#imgUploadForm", 15000);
}

function setFileToInput(input, file) {
  const dt = new DataTransfer();
  dt.items.add(file);

  input.files = dt.files;

  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));

  console.log("[KireiDot] file set", {
    name: file.name,
    type: file.type,
    size: file.size,
    inputFiles: input.files?.length
  });
}

async function waitForUploadResult(mode, timeoutMs) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const errorDialogText = document.body.innerText || "";

    if (
      errorDialogText.includes("通信に失敗しました") ||
      errorDialogText.includes("アップロードに失敗")
    ) {
      throw new Error("SalonBoard側でアップロード失敗ダイアログを検出しました");
    }

    const frontImgId = document.querySelector("input[name='FRONT_IMG_ID'], #FRONT_IMG_ID");
    if (frontImgId && frontImgId.value) {
      return {
        status: "uploaded",
        field: "FRONT_IMG_ID",
        value: frontImgId.value
      };
    }

    const imageIdCandidates = Array.from(
      document.querySelectorAll("input[name*='IMG'], input[id*='IMG'], input[name*='image'], input[id*='image']")
    )
      .map((el) => ({
        name: el.name,
        id: el.id,
        value: el.value
      }))
      .filter((x) => x.value);

    if (imageIdCandidates.length > 0) {
      return {
        status: "uploaded_possible",
        candidates: imageIdCandidates.slice(0, 10)
      };
    }

    await sleep(500);
  }

  throw new Error("アップロード結果の反映を確認できませんでした");
}

function findFirst(selectors) {
  for (const selector of selectors) {
    try {
      const el = document.querySelector(selector);
      if (el) return el;
    } catch (e) {
      // :has未対応などの保険
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
        clientY: y
      })
    );
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
手順7：Chromeに読み込む
Chromeで chrome://extensions/ を開く
右上の「デベロッパーモード」をON
「パッケージ化されていない拡張機能を読み込む」
kireidot-salonboard-extension/ フォルダを選択
拡張機能が表示されればOK
手順8：最初の検証方法
検証1：普段のChromeでSalonBoardにログイン

ここが大事です。
Playwrightで起動したChromeではなく、普段使っているChromeでやってください。

普段のChromeを開く
SalonBoardにログイン
スタイル登録画面を開く
人間操作で画像アップロードが成功することを確認
検証2：同じ画面で拡張機能を実行
スタイル登録画面を開いたままにする
拡張機能アイコンをクリック
画像URLを入れる
対象を「美容室スタイル FRONT」にする
「画像アップロード実行」を押す

成功すれば、SalonBoard側の画像IDが親フォームに反映されるはずです。

画像URLの用意方法

最初は一時的に、自社サーバーかSupabase Storageに画像を置いてください。

おすすめは、

https://your-domain.com/tmp/salonboard-upload-test.jpg

のようなURLです。

本番では、

有効期限5分〜10分の署名付きURL
jobIdごとの一時画像URL
アップロード完了後に削除

にします。

成功/失敗の切り分けポイント
成功した場合

この方式で成功したら、原因はほぼこれです。

Playwright起動Chromeのセッション/指紋/Akamai判定が原因。
通常Chromeプロファイル内で動かせば通る。

この場合、本番方針はChrome拡張方式で進めてOKです。

モーダルが開かない場合

原因は、アップロードボタンのセレクタ違いです。

確認すること：

document.querySelectorAll("a.jscUploadImg").length
document.querySelectorAll("img.mod_btn_upload").length
document.querySelector("#FRONT_IMG_ID_IMG")

美容室とエステでボタンが違うので、対象ごとにセレクタを増やします。

ファイルは入ったが登録で失敗する場合

確認すること：

document.querySelector("input.jscImageUploaderModalInput").files

これが 1 になっていれば、拡張側からFileは入っています。

次にSalonBoard側のJSが change を拾えているか確認します。
SalonBoard側は change で window.waitImgeFile に入れるので、もし登録時に空扱いなら、ページ本体JS側にイベントが届いていません。

その場合は、イベントを強めに発火します。

input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
input.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
window.waitImgeFile が見えない場合

content scriptから直接、

window.waitImgeFile

を見ても、ページ本体の window とは別空間なので見えない可能性があります。これは正常です。

Chrome公式でも、content scriptとページは分離された実行環境だと説明されています。

どうしてもページ本体の window.waitImgeFile を確認したい場合は、ページ側にscriptタグを注入します。

function runInPageWorld(fn) {
  const script = document.createElement("script");
  script.textContent = `(${fn})();`;
  document.documentElement.appendChild(script);
  script.remove();
}

runInPageWorld(() => {
  console.log("page waitImgeFile", window.waitImgeFile);
});

ただし、本番ではなるべくページ変数を直接触らず、DOMイベントでSalonBoard公式JSに処理させる方が安全です。

本番構成はこうするのがいいです

MVPで成功したら、次はこうします。

構成
KireiDot管理画面
  ↓
KireiDot API
  ↓
投稿ジョブ作成
  ↓
Chrome拡張が定期取得
  ↓
ユーザーの通常Chrome上のSalonBoardページで実行
  ↓
結果をKireiDot APIへ返す
ジョブ形式

KireiDot API側にこういうジョブを作ります。

{
  "jobId": "job_123",
  "shopId": "shop_abc",
  "type": "style_image_upload",
  "salonType": "hair",
  "target": "FRONT_IMG_ID",
  "imageUrl": "https://your-domain.com/signed/image.jpg",
  "expiresAt": "2026-06-09T12:00:00+09:00"
}
拡張機能側の動き
拡張機能にKireiDot API tokenを保存
SalonBoardを開いているときだけジョブ確認
ジョブがあれば実行
成功/失敗をAPIへ返す
API連携の最小設計
拡張機能設定

最初はpopupにAPI tokenを入れられるようにします。

await chrome.storage.local.set({
  kireidotApiBase: "https://your-domain.com",
  kireidotToken: "xxx"
});
ジョブ取得API
GET /api/salonboard-extension/jobs/next?shopId=xxx
Authorization: Bearer xxx

レスポンス：

{
  "jobId": "job_123",
  "type": "style_image_upload",
  "mode": "hair-style-front",
  "imageUrl": "https://..."
}
完了API
POST /api/salonboard-extension/jobs/job_123/complete
Authorization: Bearer xxx

成功：

{
  "status": "success",
  "imageId": "123456"
}

失敗：

{
  "status": "failed",
  "error": "通信に失敗しました"
}
実装の順番

おすすめの順番はこれです。

Phase 1：手動ボタン式MVP

まずは今回出したコードで、

SalonBoard画面を人間が開く
拡張機能ボタンを押す
画像URLを入れる
アップロードだけ実行

ここまで。

ここで成功するかが最重要です。

Phase 2：画像アップロード対象を増やす

次に、

美容室スタイル FRONT
美容室スタイル その他画像
エステ フォトギャラリー 1枠目
エステ フォトギャラリー 任意枠

に対応します。

この段階ではまだ投稿本文やフォーム入力は既存workerのままでOKです。

Phase 3：KireiDot APIからジョブ取得

popupにURLを手入力するのをやめて、KireiDot APIからジョブを取ります。

ただし、いきなり完全自動にしない方がいいです。
最初は、

「未処理ジョブがあります。現在のSalonBoard画面で実行しますか？」

くらいの半自動が安全です。

Phase 4：フォーム入力も拡張機能側に寄せる

画像アップロードが安定したら、

タイトル
コメント
カテゴリ
スタイル情報
公開設定

なども拡張機能側で入力できます。

ただし、最初から全部移す必要はありません。
今回のボトルネックは画像アップロードなので、まず画像だけ切り出すのが正解です。

まず試すべき最小テスト

最初にやるべき検証はこれです。

普段のChromeでSalonBoardにログイン
スタイル登録画面を開く
人間操作で画像アップロード成功を確認
同じページを開いたまま、拡張機能から同じ画像をアップロード
成功/失敗を見る

このテストで成功したら、かなり勝ちです。

逆にここで失敗する場合は、

file inputへのFile注入がSalonBoardに認識されていない
changeイベントがSalonBoardのjQueryに届いていない
モーダルの開き方が違う
画像URLの取得方式に問題がある
拡張機能経由でもAkamaiに弾かれている

のどれかです。

優先してログに出すべきもの

content.jsに以下を必ず出してください。

console.log("[KireiDot]", {
  url: location.href,
  userAgent: navigator.userAgent,
  webdriver: navigator.webdriver,
  hasUploadButton: !!document.querySelector("a.jscUploadImg, img.mod_btn_upload, #FRONT_IMG_ID_IMG"),
  hasModal: !!document.querySelector("#imgUploadForm"),
  fileInputCount: document.querySelectorAll("input.jscImageUploaderModalInput[type='file']").length
});

Chrome拡張方式なら、通常は

navigator.webdriver

は false または undefined のはずです。
ここがPlaywright方式との大きな違いになります。

結論

この方針で一番大事なのは、

拡張機能が独自APIでSalonBoardにPOSTするのではなく、ユーザーの通常Chrome内でSalonBoard公式のアップロードJSを動かすことです。

最初に作るべきは、

popupから画像URLを入れる
content scriptでアップロードモーダルを開く
input.jscImageUploaderModalInput にFileをセット
change 発火
input.jscImageUploaderModalSubmitButton をクリック

だけの小さいMVPです。

これで通れば、Style Postに近い実現方法としてかなり有望です。