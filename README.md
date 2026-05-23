# KIREIDOT サロンデスク (KIREIDOT_Salonboard_Worker)

サロンの「予約・スタッフ・シフト・ブログ」を 1 つの画面から確認・操作するための
**Electron デスクトップアプリ** + **サロンボード連携ワーカー**。

## 概要

- **デスクトップアプリ (Electron + React + Vite + Tailwind)**
  - UI 骨組み + LP デザインシステム適用済み (Phase 1 完了)
  - 6 画面: ダッシュボード / 予約 / スタッフ / シフト / ブログ / 設定
- **サロンボードワーカー (Playwright)**
  - 既存の `worker.ts` (CLI) として残置。今後 Electron 内のサービスとして統合予定

## デスクトップアプリの起動

```bash
npm install
npm run dev     # Vite と Electron が並行起動 (HMR 有効)
```

ビルド:
```bash
npm run build   # vite build → dist/ に成果物
```

型チェック:
```bash
npm run type-check
```

## ディレクトリ構成

```
electron/           Electron main + preload (CJS)
renderer/           Vite + React UI
  ├ index.html
  └ src/
     ├ main.tsx          エントリ
     ├ App.tsx           ルーター (state ベース)
     ├ components/       AppShell / Sidebar / Topbar / Card
     ├ pages/            Dashboard, Bookings, Staff, Shifts, Blog, Settings
     ├ lib/              nav 定義 / cn / mockData
     └ styles/globals.css
worker.ts           Playwright サロンボードワーカー (既存、温存)
inspect.ts          DOM 調査用スクリプト (既存、温存)
```

---

# 旧ドキュメント: サロンボードワーカー (CLI)

KIREIDOT Admin が積んだ `salonboard_sync_jobs` を取り出して処理するワーカーの
ローカル開発用スケルトン。本番では Fly.io に載せる前提。

現段階の責務:

- `/api/salonboard/jobs` からジョブを 1 件 poll して取り出す
- `DRY_RUN=true` ならサロンボードに一切アクセスせず即 succeeded を返す
- そうでなければ Playwright (Chromium) でサロンボードへログインを試行し、
  結果を `/api/salonboard/callback` に返す

まだ実装していないこと:

- 予約一覧の scrape (`fetch_bookings`)
- 売上の scrape (`fetch_sales`)
- 予約の push / cancel (`push_booking`, `cancel_booking`)

これらはサロンボードの実 HTML 構造を見ながら `worker.ts` の TODO 箇所に
書き足していく。

## セットアップ

```bash
cp .env.example .env.local
# .env.local を編集:
#   SALONBOARD_WORKER_TOKEN を Admin 側 (.env.local) と完全一致させる
#   KIREIDOT_API_URL は通常 http://localhost:3000

npm install
npx playwright install chromium
```

## 実行

```bash
# 1. まずは dry-run: サロンボードに触らず、queued ジョブを succeeded に変えるだけ
npm run dry-run

# 2. 1ジョブだけ処理して終了
npm run once

# 3. 通常のループ実行 (30秒ごとに poll)
npm run dev
```

`DRY_RUN=true` でループを回すと、Admin 画面の「同期ジョブ」に並んでる
queued ジョブが順次 succeeded に遷移する。予約・売上データは空 or ダミーの
0 件売上が 1 件入るだけなので、UI 動線の疎通確認用。

## 停止

`Ctrl+C` で SIGINT。

## トラブルシューティング

| 症状 | 原因と対処 |
|---|---|
| `jobs fetch failed: 401` | `SALONBOARD_WORKER_TOKEN` が Admin と不一致 |
| `jobs fetch failed: 500 worker token not configured` | Admin 側 `.env.local` に token が無い / dev server 再起動忘れ |
| `navigation: ...timeout` | 実サーバー到達できず。まずは `DRY_RUN=1` で試す |
| ジョブが常に `captcha` で止まる | 実ログインで reCAPTCHA が出ている。店舗様に一度手動ログインしてもらう |

## 本番展開 (後日)

1. Fly.io アプリ作成 (`fly launch --name kireidot-salonboard-worker --region nrt`)
2. `fly secrets set` で env を投入
3. `Dockerfile` を追加して Playwright 入り Node イメージをデプロイ
4. 深夜帯 (1:00〜6:00 JST) の停止、ポーリングジッター追加などの本番ガード実装

## ログイン (メール/パスワード + Google)

予約同期くん (Electron) のログイン画面は 2 系統用意してあります:

- **Google でログイン** (推奨): スタッフが招待時メールと同じ Google アカウント
  で入る。サインインは外部ブラウザで Google → 認可後に
  Deep Link (`kireidot-salondesk://auth/callback`) でアプリに戻る。
- **メール / パスワード**: 従来通り Supabase の email/password 認証。

### 仕組み

- PKCE フロー (`supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo, skipBrowserRedirect: true } })`)
- `electron/main.cjs` が `kireidot-salondesk://` を `setAsDefaultProtocolClient`
  で登録し、`open-url` / `second-instance` イベントで Deep Link を受信
- `electron/preload.cjs` の `window.kireidotApp.onOAuthCallback` で
  renderer に IPC 配送 → `supabase.auth.exchangeCodeForSession(code)` で確立

### Supabase ダッシュボード側の設定 (一度だけ)

Authentication → URL Configuration → **Redirect URLs** に以下を追加:

```
kireidot-salondesk://auth/callback
```

※ Google Cloud Console 側の OAuth Client は KIREIDOT_Super_Admin /
   KIREIDOT_Admin と同一 (Supabase 経由なので、アプリ側に Client ID を
   持つ必要は無い)。Apple ID / App-specific password / 証明書 / 秘密鍵は
   一切扱わない。

### 開発時の Deep Link 動作確認

`npm run dev` 中はターミナルから:

```sh
open "kireidot-salondesk://auth/callback?code=test"
```

を叩くと、Electron 上の DevTools コンソールに
`[auth] exchangeCodeForSession failed: ...` (test コードは無効なので) が
出れば配送経路が動いている証拠。本番動作確認は Google ログインフルフロー
で行う。

### トラブルシュート

| 症状 | 原因と対処 |
|---|---|
| 「Electron 環境で起動してください」 | Vite dev server を `npm run dev:vite` のみで開いた。`npm run dev` (Electron 同梱) を使う |
| ブラウザは開くがアプリに戻らない | Supabase の Redirect URLs に `kireidot-salondesk://auth/callback` を追加し忘れ |
| 「Apple Notarize 版」で Deep Link が効かない | `package.json` の `build.mac.protocols` が反映されていない可能性。クリーンビルド (`rm -rf release && npm run dist:mac:arm64`) で再生成 |
| Google で入れたが画面が真っ白 / すぐログアウトに戻る | 該当 Google アカウントの user_id に対応する `staff` 行が無い (招待されていない)。Admin で招待してもらう |
# KIREIDOT_Salonboard_Worker


---

## macOS ビルド & 配布 (Notarize 付き)

「予約同期くん」.dmg を **macOS Gatekeeper でブロックされない** 形でビルドして
配布する手順。

### 前提

| 項目 | 値 |
|---|---|
| appId | `jp.kireidot.salondesk` |
| productName | `予約同期くん` |
| アーキ | macOS arm64 (Apple Silicon) |
| 署名 ID | `Developer ID Application: HIKARU UEDA (7FMVQPBJKA)` (キーチェーンに登録済み) |
| Hardened Runtime | 有効 (`build-resources/entitlements.mac.plist`) |
| Notarize ツール | `xcrun notarytool` (Apple 公証サービス、Xcode 13+ で標準) |

### 手動準備 (一度だけ)

1. **Apple Developer Program に登録** (Team `7FMVQPBJKA`)
2. **Developer ID Application 証明書を Xcode で取得 / インポート**
3. **App-specific password を発行**
   - https://appleid.apple.com → サインインとセキュリティ → 「App用パスワード」
   - 任意の名前 (例: `予約同期くん-notary`) を付けて生成 → メモする
4. **notarytool に認証情報を保存** (推奨: Keychain profile 方式)

   ```bash
   xcrun notarytool store-credentials "予約同期くん-notary" \
     --apple-id <YOUR_APPLE_ID> \
     --team-id 7FMVQPBJKA \
     --password <APP-SPECIFIC-PASSWORD>
   ```

5. **`.env.local` を作成** (このリポジトリ直下)

   ```bash
   cp .env.example .env.local
   # .env.local を開いて以下を有効化:
   #   APPLE_NOTARY_KEYCHAIN_PROFILE=予約同期くん-notary
   ```

   ⚠️ `.env.local` は **`.gitignore` で除外済み**。絶対に commit しないこと。

### ビルド

```bash
# 依存インストール (初回 / 更新時)
npm install

# arm64 dmg を生成 + Apple 公証まで全自動
npm run dist:mac:arm64
```

完了すると以下が生成される:

```
release/salonboard-sync-mac-arm64.dmg     ← 配布用 (公証ステープル済み)
release/mac-arm64/予約同期くん.app         ← .app 本体 (検証用)
```

### 公証なし (開発用)

```bash
npm run dist:mac:nosign   # 公証スキップで dmg を作成 (Gatekeeper 警告が出る)
```

### 検証

```bash
npm run verify:mac
```

このスクリプトは以下を実施する:

- `codesign --verify --deep` で署名検証
- `spctl --assess` で Gatekeeper の承認チェック (公証済みなら accepted)
- `xcrun stapler validate` で公証チケットの存在確認
- dmg の **SHA256 ハッシュ** を `release/*.dmg.sha256` に出力 (改ざん検知用)

### 配布

ビルドした dmg を `KIREIDOT_Super_Admin/public/downloads/salonboard-sync-mac.dmg`
に配置 → push & deploy。Super Admin の `/downloads` ページから誰でも
ダウンロードできるようになる。

### 環境変数フォールバック (CI 等)

Keychain が使えない CI 環境では、`.env.local` (またはシークレット環境変数) に
以下を設定する:

```
APPLE_ID=...
APPLE_APP_SPECIFIC_PASSWORD=...
APPLE_TEAM_ID=7FMVQPBJKA
```

⚠️ **絶対に Git にコミットしないこと**。`.env.local` および証明書類 (`*.p12`,
`*.cer`, `AuthKey_*.p8`, `*.mobileprovision`) は `.gitignore` で除外済み。

### トラブルシュート

| 症状 | 原因 / 対処 |
|---|---|
| `[notarize] ⚠️ 認証情報が見つからない` | `.env.local` の `APPLE_NOTARY_KEYCHAIN_PROFILE` が未設定。 `xcrun notarytool store-credentials` を先に実行 |
| `spctl --assess: rejected: Unnotarized Developer ID` | 公証されていない。`npm run dist:mac:arm64` を最後まで完走させる |
| `codesign --verify: code object is not signed` | Developer ID 証明書がキーチェーンに無い。Xcode で取得 |
| 公証で `Invalid` | 出力された `LogFileURL` を curl で取得して詳細確認: `xcrun notarytool log <submission-id> --keychain-profile 予約同期くん-notary` |

---

## 自動アップデート (electron-updater)

予約同期くんは起動後にバックグラウンドで新バージョンをチェック・
ダウンロードし、**次回起動時に自動で適用**します (Sparkle 系の挙動)。
ユーザーが「再ダウンロード」する必要はありません。

### 仕組み

- 配信元: `https://github.com/Nolan-inc/kireidot-salondesk-releases`
  (公開リポジトリ。**ソースコードは別の private リポジトリで管理**し、
  ビルド成果物の dmg だけここに置く)
- 取得頻度: 起動直後 + 以後 6 時間ごと
- ダウンロード: バックグラウンド (差分 blockmap で効率化)
- 適用: アプリ終了時に自動 (`autoInstallOnAppQuit`)。
  ユーザーは右下のトーストの「今すぐ再起動」ボタンで即時適用も可能。

### 一度だけ準備すること (人間が GitHub 上で操作)

1. **`Nolan-inc/kireidot-salondesk-releases` を作成** (Public)
   ```bash
   gh repo create Nolan-inc/kireidot-salondesk-releases --public \
     --description "予約同期くん 配信用 (バイナリ専用)" \
     --confirm
   ```
   このリポジトリにはバイナリしか置かない (README だけあれば十分)。

2. **publish 用の Personal Access Token** (リリース作成専用)
   - `repo` スコープを持つ Classic PAT を発行 (組織で SSO がある場合は SSO Authorize 必須)
   - **`GH_TOKEN`** 環境変数として publish 時のだけ渡す。
     `.env.local` には書かず、シェルで一時的に export する運用を推奨。

### 新バージョンのリリース手順

```bash
cd KIREIDOT_Salonboard_Worker

# 1. バージョンを上げる (semver)
npm version patch  # or minor / major

# 2. Apple 公証 + GitHub Releases へアップロードを一気にやる
GH_TOKEN=ghp_xxxx npm run publish:mac:arm64
```

`publish:mac:arm64` 実行で:

- dmg を生成 → afterSign で Apple Notary に提出 → staple
- `latest-mac.yml` (manifest) + `salonboard-sync-mac-arm64.dmg.blockmap` を生成
- 上記 3 ファイルを `kireidot-salondesk-releases` の **新規 Draft Release** に
  アップロード (タグは `v<version>`)

リリースを **Draft → Published** に切り替えれば、既存ユーザーのアプリは
次回起動時 (= 最大 6 時間以内に) 検知してダウンロードする。
即時テストしたい場合はアプリを再起動するだけで OK。

### 動作確認

```bash
# 開発時 (アップデートはスキップされる)
npm run dev

# 本番ビルドで実際にチェック動作を試す
npm run dist:mac:arm64
open release/mac-arm64/予約同期くん.app
# ユーザーディレクトリの logs/main.log に updater のログが出る:
tail -f "~/Library/Application Support/予約同期くん/logs/main.log"
```

`SKIP_AUTO_UPDATE=1` を環境変数に設定するとアップデート機構を無効化できる
(社内検証ビルドで意図せず本番リリースに置き換わるのを防ぐ用途)。

### 注意点

- **同じバージョンを上書きで再公開しないこと**。electron-updater は
  バージョン番号で比較するので、同じバージョン番号の dmg を差し替えても
  既存ユーザーには配信されない。バグ修正なら patch を 1 上げる。
- **Apple 公証は毎リリース必須**。署名されていない dmg は Gatekeeper で
  拒否され、アップデートも失敗する (`autoUpdater.on('error')`)。
- **PAT を Git に絶対コミットしない**。`GH_TOKEN` は shell の一時 env で
  渡す or `~/.zshrc` などに置く (リポジトリ外)。
