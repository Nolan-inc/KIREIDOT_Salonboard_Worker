# Fallback Cloud Worker 対応方針 (KIREIDOT_Salonboard_Fallback_Worker 担当者向け)

作成: 2026-08-02

## 背景と全体像

本体Cloud worker (EC2 `sb-worker-cloud`, executor=`playwright_cloud`) で失敗した書込ジョブを、
別EC2上のフォールバックworker (リポジトリ `KIREIDOT_Salonboard_Fallback_Worker`) がリトライする。

- ジョブの目印は `salonboard_sync_jobs.executor` の新値 **`fallback_cloud`**
  (+ `payload.fallback_cloud` 1回限りマーカー)
- フォールバック連鎖: **Cloud → Fallback Cloud → 互換PC(予約同期くん) → failed**
  - 予約系3種 (push_booking/cancel_booking/push_shifts) はPC不在でも諦めず Cloud再試行継続
  - PC非対応種別は FB Cloud が最後の砦 (`[FB_CLOUD_EXHAUSTED]` で打ち切り)
- 対象: フォト/スタイル投稿・fetch系を除く **全書込16種**
- 移管・回収はすべて **DB(トリガ/cron)とAdmin API側で完結**。FB workerは
  「`fallback_cloud` のジョブだけがclaimで降ってくる普通のcloud worker」として振る舞えばよい

### 既に完了しているもの (2026-08-02)

| レイヤ | 内容 | 状態 |
|---|---|---|
| DB | migration `20260802130000_fallback_cloud_executor_lane.sql` (CHECK制約 / `salonboard_executor_heartbeats` / `salonboard_fallback_available()` / 連鎖トリガ / FB滞留10分タイムアウト) | **本番適用済み** |
| Admin | KireidotAdimn PR #75 (claim振り分け3分岐 + heartbeat upsert + callbackの連鎖ハンドオフ) | PR作成済み・要マージ |
| SuperAdmin | PR #16 (FB Cloudバッジ + Cloud成功率のFB移管計上) | PR作成済み・要マージ |

FB workerが未稼働の間は死活ゲート `salonboard_fallback_available()` が false のため
**全て不活性**。FB workerがポーリングを開始した瞬間に連鎖が自動的に有効化される。

## FB リポジトリ側でやること

### 1. upstream merge (必須・最優先)

FBリポジトリは本体の `3495f69` 時点のコピーで **13コミット以上遅れ**ている。
特に `af3f9ff` (worker_id hot-configファイルfallback) が無いと、env欠落時に
`WORKER_ID=local-dev` で動いてしまい本体と識別不能になる。

```bash
cd KIREIDOT_Salonboard_Fallback_Worker
git remote add upstream git@github.com:Nolan-inc/KIREIDOT_Salonboard_Worker.git
git fetch upstream
git merge upstream/main   # ほぼfast-forward。このdocも入ってくる
git push origin main
```

**運用ルール: FBへのデプロイ前に必ず upstream merge すること**(scraper修正の二重管理を防ぐ)。

### 2. deploy workflow の復元・パラメータ化

削除済みの `.github/workflows/deploy-worker.yml` を本体から復元し
(`git show 3495f69:.github/workflows/deploy-worker.yml`)、FB側インフラの値に差し替える:

- `EC2_INSTANCE_ID` → FB側EC2のインスタンスID (GitHub vars化推奨: `vars.FB_EC2_INSTANCE_ID`)
- S3バケット → FB側のdeployバケット
- OIDC role ARN → FB側AWSアカウント/ロール
- コンテナ名 → FB箱の実コンテナ名に合わせる (`sb-worker-fallback` 推奨)
- esbuild → S3 → SSM → bind-mount差替 → docker restart の形は本体と同一

### 3. FB EC2箱の設定 (アプリコード変更は不要)

claimの振り分けはAdmin側で完結するため、**worker本体のコード変更はゼロ**。環境だけ設定する:

```
# docker env
WORKER_MODE=central-dev
KIREIDOT_API_URL=<本体と同じAdmin URL>
SALONBOARD_WORKER_TOKEN=<本体と同じglobal token>
WORKER_CAPABILITIES=playwright_cloud,fallback_cloud   # ★ここが肝
WORKER_ID=fallback-cloud-1
```

- `WORKER_CAPABILITIES` に **両方**入れる: `fallback_cloud` でclaimレーンが決まり
  (Adminが先に判定)、`playwright_cloud` で isCloudWorker() 系の挙動
  (書込タイムアウトguard・プロキシ運用) がそのまま効く
- hot-config (`/home/pwuser/.kireidot/` bind-mount):
  - `max_concurrency` → `2` (あふれ処理専用レーンなので控えめに)
  - `keepalive_enabled` → **作らない/有効化しない** (keepaliveはopt-in。FBが常時ログインすると
    本体とSBセッションを取り合う)
- プロキシ: FB箱用の `SB_PROXY_POOL` / `SB_PROXY_USERNAME` / `SB_PROXY_PASSWORD` を設定。
  **FB箱のEIPをDecodoのホワイトリストに登録すること** (未登録だとプロキシ認証で全滅)

### 4. 起動順序 (重要)

**Admin PR #75 がマージ・デプロイされる前に、FB workerを上記capabilitiesで起動しないこと。**
旧Adminのマッピングは `playwright_cloud` を先に見るため、FBが「第2の本体Cloud worker」として
本体と同じジョブを取り合ってしまう (SBは同一アカウント同時1セッションのためセッション相互失効の危険)。

正しい順序: ①DB migration (適用済み) → ②Admin PR #75 マージ・デプロイ → ③FB worker起動

### 5. 動作確認

FB起動後、以下で連鎖が生きているか確認できる:

```sql
-- FB死活 (起動後30秒以内にtrueになるはず)
select public.salonboard_fallback_available();
-- heartbeat行 (claim pollごとに更新)
select * from public.salonboard_executor_heartbeats;
-- FBレーンのジョブ
select id, job_type, status, executor, locked_by, error
  from salonboard_sync_jobs where executor = 'fallback_cloud'
 order by updated_at desc limit 20;
```

E2Eドリル: 開発店舗で確実に失敗する書込 (例: push_blog) を `max_attempts=1` でenqueue →
`failed` → `[CLOUD_FB_FALLBACK]` 付きで `queued(fallback_cloud)` → FBがclaim
(`locked_by='fallback-cloud-1'`) の遷移を追う。SuperAdminのジョブ一覧に「FB Cloud」バッジが出る。

### 6. 安全装置 / 縮退

- **FBコンテナを止めるだけで安全に縮退**: 3分でheartbeat失効 → ゲートfalse →
  連鎖は従来 (Cloud→PC) に自動で戻る。FBレーンに滞留した行は10分で
  `[FALLBACK_CLOUD_TIMEOUT]` → トリガがPC段/失敗確定へ降ろす (腐らない)
- キルスイッチ: `salonboard_blocked_worker_ids()` (本番DB) に `fallback-cloud-1` を
  追加するとclaim自体を遮断できる
- SBセッション取り合い: claimの店舗レーンmutexはexecutor横断のため、FBが処理中の
  店舗を本体が同時にclaimすることはない。ただし**FBでの実行はその店舗のSBセッションを
  奪う** (SBは同一アカウント同時1セッション)。本体は次回ジョブで自動再ログインするので
  設計上許容している

## 仕組みの詳細 (参考)

- ハンドオフ規約: `executor='fallback_cloud'` + `payload.fallback_cloud` (1回限りガード) +
  `payload.preflight_required=true` (本体で部分成功している可能性があるため、FBは必ず
  実在確認から入る — worker既存機構がこのフラグを処理する)
- FB移管の入口は2系統 (どちらも本番適用/PR済み):
  - Admin callback `tryFallbackCloud` (retryable_failed枯渇 / login_required / captcha / blocked)
  - DBトリガ `salonboard_force_cloud_failure_fallback` (callback漏れ・reaper再投入も捕捉)
- FB自身が失敗した場合: PC対応3種は互換PCへ、PC不在ならCloudレーンへ戻して再試行継続
  (マーカー保持のためFBへの再移管はない)。PC非対応種別は `[FB_CLOUD_EXHAUSTED]` で failed
