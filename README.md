# KIREIDOT Salonboard Worker (local skeleton)

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
