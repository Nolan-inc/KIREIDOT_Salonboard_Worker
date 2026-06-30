# 連携失敗時の「直前スクショ」を Slack 転送 — 設計 (実現可能性: ✅ 可能)

最終更新: 2026-06-30 / 状態: 設計のみ(未実装)

## 要件
SB連携失敗の Slack通知(#kireidot-sb-error)に、**失敗した瞬間の直前の画面キャプチャ**を添付したい。

## 実現可能性: ✅ 可能
worker は既に失敗時/要所で `captureScrapeDebug(page, channel, label, ...)` により
**`screenshot.png` + `page.html` + `meta.json`** を EC2の
`/home/pwuser/.kireidot/salonboard-debug/<channel>/<ts>_<label>/` に保存している。
→ **スクショは既に取得済み**。残る課題は「worker のファイルシステム → Slack通知」のパイプラインのみ。

## 現状の通知経路(ここが論点)
worker は job 結果を DB(`salonboard_sync_jobs`)に記録 → trigger `notify_worker_log_slack`
→ edge fn `salonboard-worker-log` が Slack #kireidot-sb-error に投稿。
**Slack投稿は Supabase(edge fn)側**で、EC2のファイルには触れない。
→ スクショを edge fn が読める場所(Supabase Storage 等)へ運ぶ必要がある。

## 設計(推奨パス)

### 1. どのスクショか
「直前」= **submit直前の入力フォーム**(何を送ったかが分かる=最も診断価値が高い)。
- `500.html` は汎用エラーで視覚的価値が低い。doCompleteエラー画面は文言が見える。
- → **push経路で submit直前にキャプチャ**(成功時はバッファ破棄、失敗時のみ確定)。

### 2. worker → ストレージ
失敗時、submit直前キャプチャを **Supabase Storage(private bucket 例 `sb-error-captures/<job_id>.png`)へアップロード**。
- worker が Supabase直アクセスを持たない場合(現状 env に `SUPABASE_*` 無し)は
  **Admin API(既存の job報告チャネル)経由でアップロード** → Admin が Storage に put。

### 3. job に path 記録
`salonboard_sync_jobs.error_capture_path text`(新カラム, migration)。

### 4. edge fn が Slack に添付
`salonboard-worker-log` が失敗通知を組む際、`error_capture_path` があれば:
- **署名URL(短命)を生成 → Slackの image block を追加**(同一メッセージにインライン表示)。
  Slackは初回取得時に画像をキャッシュするので署名URL失効後も表示は残る。
- bot token がある場合は `files.uploadV2` でスレッド添付も可(public URL不要)。

## 実装ステップ
1. **worker(`electron/scrapers.cjs`)**: push経路の submit直前に screenshot をメモリ取得。
   失敗パスで Storage/Admin API へ upload + path を job報告に含める。
2. **DB**: `salonboard_sync_jobs` に `error_capture_path` 追加(migration)。
3. **Admin API**(worker→Supabase間接の場合): 受けた画像を Storage へ put + job更新。
4. **edge fn `salonboard-worker-log`**: `error_capture_path` → 署名URL → Slack blocks に image 追加。
5. **Slack**: image block方式なら追加scope不要(署名URLをSlackが取得)。
   files.upload方式なら bot に `files:write` + チャンネル参加。
6. **Storage**: private bucket + ライフサイクル(N日で自動削除)。

## 留意点
- **PII**: スクショに顧客名/電話が写る。#kireidot-sb-error は社内チャンネル(既にテキスト通知に顧客名あり)。
  **retention(自動削除)必須**、社外共有しない。
- **量/コスト**: 失敗時のみ=低頻度。ストレージ微量。
- **オーバーヘッド**: submit直前の毎回キャプチャ ~100-300ms。成功時はバッファ破棄でディスクI/O回避。
- **要確認**: worker の Supabase到達手段(env に `SUPABASE_*` 無し)→ 直アップロード or Admin API経由を決定。

## まとめ
実現可能。worker は既にスクショ取得済みなので、追加は
**「失敗時に画像を Supabase へ運ぶ + edge fn で Slack に添付」の配線のみ**。
最も診断価値が高いのは submit直前のフォーム。実装は中規模(worker + DB + edge fn の3点配線)。
