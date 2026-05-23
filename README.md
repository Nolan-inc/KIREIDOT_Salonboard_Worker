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
