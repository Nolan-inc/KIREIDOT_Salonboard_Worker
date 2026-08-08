# 監視・通知一覧

「何がどこに通知され、どこを見れば状態が分かるか」の一覧。障害時の初動は [operations.md §2](operations.md) を参照。

---

## 0. 重要な前提 — 通知はworkerではなくDBが出している

**worker.ts / scrapers.cjs にSlack通知のコードはありません。** 通知はすべて Postgres のトリガ関数が `net.http_post` で Edge Function を叩く形で実装されています。

```
salonboard_sync_jobs の status 変化
  → トリガ関数 (notify_*_slack)
    → vault.decrypted_secrets から fn_url / anon_key / trigger_secret を取得
      → Supabase Edge Function
        → Slack #kireidot-info
```

つまり **workerを再起動しても通知設定は変わりません**。通知が止まったらDB側(vaultのシークレット、トリガの有効性、Edge Functionのログ)を疑ってください。

---

## 1. Slack通知の分類

宛先はいずれも `#kireidot-info`(`C0BE8AU31UY`)。※会計異常のみ別チャンネル。

| # | トリガ関数 | 発火条件 | 用途 |
|---|---|---|---|
| 1 | `notify_worker_log_slack` | `salonboard_sync_jobs` の status変化。executor が `playwright_cloud` / `playwright` で、status が running / succeeded / failed / cancelled / retryable_failed / manual_required / **captcha_detected** | ジョブ単位の実行ログ(成功も流れる) |
| 2 | `notify_salonboard_job_failed_slack` | 書込系job_type(push_booking / cancel_booking / update_booking / push_shifts / push_shift_patterns / push_photo_gallery / push_blog / delete_blog / push_review_reply / push_equipment / push_staff / push_menu / push_coupon)が `failed` or `manual_required` | 書込失敗の専用通知(EF `salonboard-job-failed-notify`) |
| 3 | `notify_salonboard_write_failed_slack` | status が `failed` or `manual_required`(成功・実行中は対象外) | 書込失敗 |
| 4 | `notify_sweep_pushed_slack` | `push_booking` が succeeded になった瞬間、かつ `payload.reason='sweep_reenqueue'` | 自動スイープで拾った予約の反映報告 |
| 5 | `notify_sync_run_slack` | 同期ランの `finished_at` がセットされた瞬間。**エラーを含むランのみ**(全店成功なら無通知)。`source='desktop'` は除外 | 巡回同期のエラーサマリ |
| 6 | `salonboard_booking_sla_check` | 毎分のcron。予約書込ジョブの経過時間がSLA超過 | 3分SLA違反の警告 |
| 7 | `salonboard_invoke_ops_alert` | maintenance cron内。`salonboard_sync_alerts` に未解決・未通知の `device_offline` / `stuck_job` がある場合 | 運用アラート(EF `salonboard-ops-alert`) |
| 8 | `run_salonboard_diff_monitor` | 毎時のcron | KD↔SBの差分監視 |

参考(SalonBoard以外): `notify_booking_slack`(予約の作成/変更)、`notify_user_signup_slack`、`notify_voice_memo_slack`、`notify_accounting_anomalies_slack`(別チャンネル `C0B9N3RA4BE`)など。

### 二重送信ガード

多くの関数は「その状態になった**瞬間**のみ」を条件にしています(`new.status = 'succeeded' and coalesce(old.status,'') <> 'succeeded'` のような形)。通知が重複する場合はこのガードが壊れていないか確認してください。

---

## 2. 定期処理(cron)

SalonBoard関連は**7本**(DB全体では20本)。時刻はUTC表記なのでJSTは+9時間。

| cron名 | スケジュール(UTC) | JST | 内容 |
|---|---|---|---|
| `salonboard-booking-sla-check` | `* * * * *` | 毎分 | 予約書込のSLA超過を検知しSlack通知 |
| `salonboard-reap-stale-write-jobs` | `* * * * *` | 毎分 | `salonboard_reap_write_jobs(180)` — 180秒以上停滞した書込を回収 |
| `salonboard-reroute-stale-pc-writes` | `* * * * *` | 毎分 | PC側で滞留した書込をCloudへ再ルート |
| `salonboard-sync-maintenance` | `*/3 * * * *` | 3分毎 | 下記の複合メンテナンス |
| `salonboard-diff-monitor-hourly` | `0 * * * *` | 毎時 | KD↔SB差分監視 |
| `salonboard-daily-shift-push` | `0 15 * * *` | **00:00** | 当月+翌月のシフト再push(改名後の再push忘れを自己修復) |
| `salonboard-cloud-settings-fetch` | `0 18 * * *` | **03:00** | 設定系の一括fetch |

### `salonboard_sync_maintenance()` の中身(3分毎)

順に実行されます:

1. `salonboard_reap_read_jobs()` — 停滞した取得系を回収
2. `salonboard_reap_write_jobs()` — 停滞した書込を回収
3. `salonboard_reap_stale_queued_writes()` — 待機のまま固まった書込を回収(**`run_at <= now()` ガード付きなのでcooldown中は触らない**)
4. `salonboard_reap_shift_blocked_bookings()` — シフト未整合の実失敗を `manual_required` へ
5. `salonboard_auto_match_shift_patterns()` — SB勤務パターン ↔ KDプリセットの時刻完全一致マッチ
6. `salonboard_reroute_cooldown_writes_to_pc()` — **冷却中アカウントの予約系をPCへ移管**(3分SLA維持)
7. `salonboard_detect_stalls()` — 停滞検知 → `salonboard_sync_alerts` に記録
8. `salonboard_reenqueue_orphans()` — 未pushの孤児予約を再enqueue
9. `salonboard_invoke_ops_alert()` — 未通知アラートがあればSlackへ

> **これが動いているので、滞留を手で掃除する必要はありません。** 大量の `run_at` 一括解放は害しかありません([operations.md §2.1](operations.md))。

### `salonboard_detect_stalls()` のしきい値

| 対象 | 既定 | 重大度 |
|---|---|---|
| stuck job | 900秒(15分) | push/cancel/delete系は `critical`、他は `warning` |
| booking | 900秒 | |
| device offline | 720秒(12分) | |

アラートは `salonboard_sync_alerts` に `alert_type` + キーで upsert され、`resolved_at` / `notified_at` で管理されます。

### `salonboard_reenqueue_orphans()`

KD由来(`source='kireidot'`)で confirmed/pending、`external_booking_id` が無く、未来の予約、かつ更新から10分以上経過したものを再enqueue。**過去6時間にpushジョブが無いものだけ**を対象にしてリトライストームを防ぎます。`failed`(一過性失敗の滞留)は含みますが、`manual_required`(人手要)は含みません。

---

## 3. heartbeat(店舗PC)

予約同期くん(Electron)が **5分間隔**で `POST /api/salonboard/device/heartbeat` を送ります。

送信内容:

| 項目 | 意味 |
|---|---|
| `machine_id` / `machine_name` | 端末識別 |
| `enable_push` | この端末が書込を担当するか |
| `extension_bridge_up` | Chrome拡張ブリッジの生死 |
| `extension_last_poll_at` / `extension_pending` | 拡張の最終ポーリング・保留件数 |

レスポンスの `active` で**アクティブ/待機モード**が切り替わります(複数端末がある場合、アクティブは1台)。待機になるとジョブ処理と自動同期を止め、ログに「⏸️ 待機モードになりました」と出ます。

保存先テーブル `salonboard_worker_heartbeats` のカラム: `machine_id, machine_name, platform, app_version, worker_id, enable_push, extension_bridge_up, extension_last_poll_at, extension_pending, last_seen_at, is_active`。

**⚠️ このテーブルに `shop_id` がありません。** そのため `salonboard_pc_available()`(= `last_seen_at > now()-7分` かつ `is_active` かつ `enable_push`)は**店舗を問わない判定**になり、店舗別affinityが表現できません。これが「PC移管したのに実際はログインしていない店舗で失敗する」構造的な原因です。

---

## 4. 失敗時のcapture(スクリーンショット・HTML)

予約登録フローで失敗すると、EC2の箱上に保存されます。

```
~/.kireidot/salonboard-debug/push_booking/{YYYYMMDDThhmmss}_{job先頭8桁}_{label}/
  ├── meta.json       … URL / title / 表示テキスト抜粋 / 要素一覧 / 失敗ラベル
  ├── page.html       … HTMLスナップショット(秘匿情報マスク済み)
  └── screenshot.png  … フルページスクリーンショット
```

個人情報保護のため、input/textareaの**value は保存しません**(name・type・placeholderのみ)。パスワード文字列と認証情報はマスクされ、payloadの顧客名・電話・メールもmeta.jsonには入りません。ディレクトリは `0700`、ファイルは `0600`。

無効化: `SALONBOARD_DEBUG_CAPTURE=0`(既定は有効)。

**ディスク**: captureは放置すると溜まります(2026-08-08に常時系のディスク使用率が91%に到達)。現在は **systemd timer `sb-debug-cleanup.timer`** が全4箱で日次稼働し、7日超を削除します(設置: `scripts/setup-debug-cleanup-timer.sh`、詳細: [operations.md §5](operations.md#5-デバッグcaptureのお掃除systemd-timer))。

タイマーの生存確認:

```
systemctl list-timers --all | grep sb-debug
systemctl show sb-debug-cleanup.service -p Result -p ExecMainStatus
```

ディスク逼迫はChrome起動失敗という分かりにくい形で現れるため、原因不明の起動失敗時は `df -h` を確認してください。

**参照方法**: SSM経由で `ls -lt ~/.kireidot/salonboard-debug/push_booking/ | head` して、該当ジョブIDのディレクトリを見ます。

---

## 5. workerログで確認すべきもの

`docker logs --tail 200 sb-worker-cloud`(SSM経由)。デプロイ直後に確認すべき項目:

- **WORKER_ID** — 期待値(`cloud-bulk-1` など)になっているか。`local-dev` になっていたらenv消失
- **capabilities** — レーン申告(`playwright_cloud,lane_realtime` など)
- **並行度** — `max_concurrency` ファイルの値が反映されているか
- プロキシプールの件数
- ログイン成功/needs_login の分布

---

## 6. canary(Akamai検知率の計測)

`canary.ts` は**読み取り専用**の計測ループです。**Admin API・ジョブキューには一切触れません**(本番運用への影響ゼロ)。

- 動作: テスト用1店舗で「ログイン → スケジュール画面閲覧」だけを定期実行
- 間隔: `CANARY_INTERVAL_MS`(既定5分)
- 出力: CloudWatch Logs に人間用ログ + EMF(Embedded Metric Format)JSON
  - Namespace: `KireidotSalonboardWorker`
  - メトリクス: `LoginSuccess` / `FreshLogin` / `CaptchaDetected` / `Blocked` / `DurationMs`
- 環境変数: `SALONBOARD_LOGIN_ID` / `SALONBOARD_PASSWORD`(必須)、`SALONBOARD_BASE_URL`、`CANARY_SHOP_LABEL`

`FreshLogin` の頻度がセッション寿命の指標になります。

---

## 7. 状態確認の入口まとめ

| 見たいもの | どこを見るか |
|---|---|
| 今の失敗傾向 | Slack `#kireidot-info` |
| ジョブの状態別件数 | `select status, executor, count(*) from salonboard_sync_jobs group by 1,2;` |
| 停滞アラート | `select * from salonboard_sync_alerts where resolved_at is null;` |
| 店舗PCの生死 | `select * from salonboard_worker_heartbeats;`(7分以内なら生存) |
| ジョブの実行履歴・イベント | SuperAdmin 同期監視ダッシュボード |
| 個別ジョブの失敗理由 | ジョブ行の `last_error` + 箱上のcapture |
| workerの生死・設定 | `docker ps` / `docker logs`(SSM経由) |
| Akamai検知率の推移 | CloudWatch メトリクス `KireidotSalonboardWorker` |
