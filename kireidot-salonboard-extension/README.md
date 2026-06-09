# KireiDot SalonBoard Helper（Chrome拡張・MVP）

Playwright で自動Chromeを起動するのをやめ、**あなたが普段使っている Chrome** 上に拡張を入れて、
SalonBoard 公式のアップロードJS（`CN_CMN_imageUploaderModal`）をそのまま動かす方式。

Akamai から見ると「普段使いのChrome・普段のCookie・ログイン状態・通常プロファイル」になるため、
Playwright の自動化セッションが弾かれる問題（`navigator.webdriver=true` 等）を回避できる。

## このMVPの対象
- **美容室スタイル登録（/CNB styleEdit）の FRONT 画像アップロードのみ**。
- 投稿本文・タイトル等のフォーム入力は対象外（まず画像アップロードが通るかを検証する）。

## 構成
```
kireidot-salonboard-extension/
  manifest.json   … Manifest V3。salonboard.com に content script を注入。
  popup.html/js   … 画像URLを入れて実行するテストUI。
  background.js   … 画像URL → fetch → Data URL（CORS回避のため拡張側で取得）。
  content.js      … 本体。モーダルを開く→file input にFileセット→change発火→「登録する」クリック→結果待ち。
```

## インストール手順
1. **普段使っている Google Chrome** で `chrome://extensions/` を開く
2. 右上の「**デベロッパーモード**」を ON
3. 「**パッケージ化されていない拡張機能を読み込む**」をクリック
4. このフォルダ `kireidot-salonboard-extension/` を選択
5. 「KireiDot SalonBoard Helper」が表示されればOK（ツールバーにアイコンが出る。出なければパズルピース→ピン留め）

## テスト手順（最重要）
1. **普段使いの Chrome** で SalonBoard にログイン
2. 美容室の **スタイル登録画面（styleEdit）** を開く
   - スタイル掲載情報一覧 →「スタイル新規追加」で開く画面（FRONT/SIDE/BACK の画像枠がある画面）
3. まず**手動で**画像アップロードが成功することを確認（人間操作）
4. 同じ画面を開いたまま、**拡張アイコンをクリック**
5. **画像URL**（公開URL。例: Supabase の署名付きURL や自社の一時URL）を入力
6. 対象は「**美容室スタイル FRONT**」
7. 「**画像アップロード実行**」を押す
8. popup のログ、または Chrome の DevTools Console（`[KireiDot]` ログ）で結果を確認

### 成功すれば
- popup に `{"ok": true, "result": {"status":"uploaded", "value":"B..."}}` のように出る
- SalonBoard 側で FRONT 画像枠に画像IDが反映される
→ **原因は Playwright起動Chromeのセッション/指紋/Akamai判定**で確定。本番もこの拡張方式で進めてOK。

## 切り分けポイント（失敗時）
popup のログ＋Console の `[KireiDot] diag` を見る。

- `webdriver`: **false / undefined ならOK**（普段Chromeの証拠）。`true` なら自動化セッション。
- `hasUploadButton`: アップロードボタンを検出できたか。false なら styleEdit 画面でない or セレクタ違い。
- `fileInputCount`: モーダルの file input 数。
- 「モーダルが開かない」→ `document.querySelectorAll("a.jscUploadImg").length` 等をConsoleで確認しセレクタ追加。
- 「Fileは入ったが登録で失敗」→ `document.querySelector("input.jscImageUploaderModalInput").files` が 1 か確認。
  0 なら File 注入が認識されていない。change 発火が SalonBoard の jQuery に届いていない可能性。
- 「拡張でも通信失敗」→ Akamai が拡張経由でも弾いている可能性（その場合は別の手を検討）。

## 画像URLの用意
- 検証用: Supabase Storage の署名付きURL、自社の一時URL など、ブラウザから fetch できる公開URL。
- 本番: 有効期限5〜10分の署名付きURL、jobIdごとの一時URL、アップロード完了後に削除。

## 注意
- ローカルファイルパスを `input.value` に直接セットすることはできない → 画像は必ずURLで渡す。
- content script はページ本体JSと分離（isolated world）。`window.waitImgeFile` には直接触らず、
  **正しい file input に File を入れて change を発火** し、SalonBoard 公式JSに処理させる（この方式で実装済み）。

## 次フェーズ（MVP成功後）
- Phase 2: 対象を増やす（SIDE/BACK、エステ フォトギャラリー）
- Phase 3: KireiDot API からジョブ取得（半自動: 「未処理ジョブがあります。実行しますか?」）
- Phase 4: タイトル/コメント等のフォーム入力も拡張側へ
