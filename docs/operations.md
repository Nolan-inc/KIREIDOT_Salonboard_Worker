# 運用ガイド(デプロイフロー+インシデント対応Runbook)

対象読者: 本システムの運用・障害対応を行う人。設計背景は [system-architecture.md](system-architecture.md)、書込信頼性の仕組みは [write-reliability-design.md](write-reliability-design.md) を参照。

関連: [shop-onboarding.md](shop-onboarding.md)(新店舗追加)/ [salonboard-quirks.md](salonboard-quirks.md)(SB固有仕様)/ [monitoring.md](monitoring.md)(監視・通知)

---

## 0. 対象システム早見表

| 系 | 実体 | 補足 |
|---|---|---|
| メインworker | EC2 `i-0f1cc0aff1ac8dd2e`(c6i.xlarge)/ docker `sb-worker-cloud` | 常時系レーン(lane_realtime)。予約書込SLA担当。並行6 |
| 一括worker | EC2 `i-06a56736ddc6512f8`(m6i.large)/ docker `sb-worker-bulk` | 一括系レーン(lane_bulk)。設定系fetch/一括取込。WORKER_ID=`cloud-bulk-1` |
| 投稿worker | EC2 `i-0e77765c6ca7843eb`(t3.medium)/ docker `sb-worker-post` | 投稿系レーン(lane_post、2026-08-08新設)。ブログ/スタイル/フォト/クーポン/メニューの反映専任 |
| 予備(FB)worker | EC2 `i-09e54e0b55fb8ab34`(t3.medium)/ docker `sb-worker-fallback`。コードは別repo `KIREIDOT_Salonboard_Fallback_Worker` | executor=`fallback_cloud`。Cloud失敗書込を1回だけ再試行 |

※インスタンスサイズは2026-08-08に右サイジング済み(常時系 c6i.2xlarge→c6i.xlarge、FB m6i.large→t3.medium)。実測で制約はCPU/メモリではなく外部要因(SBアカウント直列・IP・ペーシング)と確定しているため。詳細は [scaling-plan.md](scaling-plan.md)。
| 店舗PC | Mac Studioの予約同期くん(Electron) | worker_id=`electron-worker`。CAPTCHA避難レーン(要ログイン設定=affinity) |
| バンドル置き場 | `s3://kireidot-sb-worker-debug-972293797066/deploy/<commit SHA>/worker.cjs` | イミュータブル。ロールバックの起点 |
| ワーカー本体(箱上) | `/opt/kireidot/worker.cjs`(コンテナに read-only bind-mount) | 差替→`docker restart`で反映 |
| ホット設定 | コンテナ内 `/home/pwuser/.kireidot/`(`worker_capabilities`・`max_concurrency`・`anthropic_api_key`) | 読込はプロセス起動時のみ→変更後は restart 必要 |
| デバッグcapture | 箱上 `~/.kireidot/salonboard-debug/` | 失敗時スクショ/HTML。**7日ローテのお掃除cronを全4箱に設置済み**(2026-08-08。放置してディスク91%まで到達した実績あり) |
| 通知 | Slack `#kireidot-info` | 成功/失敗の4分類通知+予約明細 |

---

## 1. デプロイフロー

### 1.1 通常デプロイ(クラウドworker 3箱)

**mainへのpushだけで完結する。** `.github/workflows/deploy-worker.yml` が以下を自動実行する:

1. type-check → esbuildで `worker.ts` を `worker.cjs` にバンドル(playwright external)
2. S3へ **コミットSHA付きイミュータブルパス** でアップロード
3. SSM経由でメイン箱: presign URLからDL → `docker stop -t 40`(SIGTERM猶予40秒でセッションflush)→ `/opt/kireidot/worker.cjs` 差替 → `docker start`
4. 成功後、同一バンドルを**一括箱 → 投稿箱**の順に配布(どれか失敗=ワークフロー赤で箱間のバージョン乖離に気付ける)

3箱とも**同一バンドル**で、役割の違いはレーン申告(`worker_capabilities`)だけで決まる。

注意:

- **paths filter**あり。`worker.ts`/`electron/scrapers.cjs`/`electron/worker-process.cjs`/`salonboard-selectors.ts`/`salonboard-rescan.ts`/`canary.ts`/`package*.json`/workflow自身のみ。docs/READMEだけの変更ではデプロイされない
- **デプロイ=コンテナ再起動。** 短時間に連発するとコールド再ログインの波→Akamai throttle/CAPTCHAの引き金になる(2026-07-17実障害)。**修正はまとめて1回でpushする**
- concurrency groupで直列化されるため連続pushしても並行デプロイはされない(が、再起動回数は増える)

### 1.2 ロールバック

- **通常**: `git revert` → main push(=通常デプロイと同じ経路で旧コードに戻す)。これが第一選択
- **緊急**(GH Actionsを待てない/壊れている場合): S3のバンドルはSHA別に残っているので、旧SHAのバンドルを presign してワークフローのSSMステップと同じコマンド列(DL→stop→mv→start)を手動実行する。一括箱は `scripts/bootstrap-bulk-worker.sh <instance-id> <旧SHA>` が deploy-sha 指定に対応している

### 1.3 緊急ホットパッチ(SSM直接差替)

GH Actionsを経由せず本番の `/opt/kireidot/worker.cjs` を直接差し替える手順。**本番差替は必ず事前承認を取ること。**

1. ローカルで esbuild バンドル(ワークフローと同じオプション)
2. gzip+base64にしてSSM `send-command` でチャンク転送(SSMのペイロード上限のため分割必須)
3. **転送後に必ずmd5照合**(チャンク欠落・改行化けの検出。ガード無し差替は禁止)
4. `docker restart -t 40 sb-worker-cloud`

既知の罠:

- SSMコマンド文字列に**丸括弧を含めると壊れる**(エスケープ事故)。`jq`/`python`でJSON組み立てする
- **ホットパッチ後は同じ修正を必ずcommit+pushする。** 次の通常デプロイでバンドルが再生成されるため、gitに無い修正は消える
- 差替はメイン箱だけでなく**一括箱・投稿箱にも必要か毎回確認**(scraper修正は通常3箱すべて)

### 1.4 予備(FB)ワーカー

- FBは**別リポジトリ**(`KIREIDOT_Salonboard_Fallback_Worker`、本repoがupstream)。デプロイ形態は本体と同一(esbuild→S3→SSM→bind-mount差替→restart)
- **鉄則: FBへのデプロイ前に必ず upstream merge。** scraper修正の二重管理・取りこぼしを防ぐ

```bash
git fetch upstream && git merge upstream/main && git push  # ほぼfast-forward
```

- 本体に書込系の修正を入れたら**FBのmerge忘れが定番事故**。デプロイ後チェックリスト(§4)参照

### 1.5 予約同期くん(Electron)

- タグ `v*` push → GH Actionsがビルド+**Developer ID Application署名+公証**
- 署名要件を満たさないと自動更新が「コード要件を満たしていません」で全端末失敗する(v0.2.219実障害)。**公開前に `verify:mac` を実行**
- 店舗PC側も同一worker共通ソースのため、worker挙動の修正はデスクトップ版のリリースも要るか毎回判断する

### 1.6 DBマイグレーション/Edge Functions

- migrationは `supabase/migrations/` に追加し Supabase MCP/CLI で適用
- **罠: `apply_migration` の CREATE TABLE は postgres にしか権限が付かない。** service_role経由が黙ってpermission deniedになるため、新テーブルには明示 `GRANT` + `NOTIFY pgrst, 'reload schema'` が必須(2026-08-02 heartbeats実障害)
- **Edge Functionのデプロイは必ず `git pull` 後のrepo mainから。** デプロイ前に `get_edge_function` で現行版に他人の変更が無いか確認(2026-07-25 v19上書き事故: 別セッションの変更を7時間退行させた)

### 1.7 レーン/並行度のホット変更

- レーン申告: `bash scripts/set-worker-lane.sh <instance-id> <container> <capabilities>`(例: `playwright_cloud,lane_realtime`)。コンテナ内 `worker_capabilities` ファイルを書いてrestartする
- 並行度: コンテナ内 `/home/pwuser/.kireidot/max_concurrency`(メイン箱は6)。変更後restart必要
- 一括箱の新規構築/再構築: `bash scripts/bootstrap-bulk-worker.sh`(冪等。シークレットはEC2ロールのParameter Store読取で組み立てられ、手元に現れない)
- **⚠️ プロキシプール(20 IP)は両箱で完全一致させること。** 店舗→IPのsticky割当はプールサイズ/順序依存のFNV-1a hashのため、揃わないと同一店舗が別出口IPになりセッションが壊れる

---

## 2. インシデント対応Runbook

### 2.0 トリアージ(何はともあれ最初に見るもの)

1. **Slack `#kireidot-info`**: 失敗通知の分類と件数の傾向(単発か、特定店舗か、全店か)
2. **SuperAdmin同期ダッシュボード**: ジョブの状態別件数・実行履歴・イベント履歴
3. **ジョブテーブル**: `select status, executor, count(*) from salonboard_sync_jobs group by 1,2;` で滞留の偏りを見る
4. **workerログ**: `docker logs --tail 200 sb-worker-cloud`(SSM経由)。詳細は箱上 `~/.kireidot/salonboard-debug/` のスクショ/HTML
5. **heartbeat**: PCレーンはheartbeatsで生死確認(予約同期くんが止まっているとPC移管が全部滞留する)

### 2.1 CAPTCHA / throttle(最頻出・最重要)

**症状**: ログイン失敗の連続通知、書込失敗の急増、成功率低下。

**仕組み(自動対応が既に入っている)**: CAPTCHA検知→fail-fast(3時間貼り付きの防止)→アカウント30分冷却→予約系書込は即PC移管+冷却中も毎分cronがPC移管を継続。

**やること**:

1. **止めて待つ。** SBのフラグは3〜4時間で自然減衰する(2026-08-07/08で再実証済み)。人間の介入で早められない
2. PC移管が効いているか確認: 予約同期くんのheartbeatと、対象店舗が**予約同期くんにログイン設定済みか(affinity)**。未設定店舗はPC移管先が無く書込レーンが消える — 恒久解はアカウント追加
3. 減衰後の回復確認は**1件だけ**手動再実行して成功を見る。一斉解放しない

**やってはいけないこと(全て過去に悪化させた実績あり)**:

- ❌ `run_at` の一括解放・大量re-queue(コールド再ログイン同時多発→throttle増幅)
- ❌ 冷却の手動解除
- ❌ 「直ったか確認」のためのフレッシュログイン乱発(2026-06-27: 10IP全フラグで数時間停止)
- ❌ プロキシ変更・再起動・デプロイを焦って重ねる(2026-07-17: 複数IPをthrottleさせ悪化)

### 2.2 「実行中0+待機N」はワーカー停止ではない

claim→即defer(cooldown中など)の反復は外からは無活動に見える。**待機件数だけで停止と判断しない。**

- 正常系の待機(queued)は0。非0の4分類: ①cooldownバックログ(待てば流れる) ②再試行不能ジョブ(容量超過・予定重複・SB予約ID無し等=データ起因) ③ゾンビ(24hガードで刈られる) ④**`sync_features` でOFFにした機能の残存ジョブ**(claim時フィルタのみでcancelされないため永久に待機表示。滞留ではない)
- 停止を疑う条件: **15分以上・複数アカウント跨ぎで完全無活動**(claimイベントすら無い)の場合のみ。そのときはじめて `docker logs` → 必要なら restart
- 滞留の自動回収は `salonboard_reap_stale_queued_writes` がmaintenance cron(*/3)で稼働済み。手で掃除しない([monitoring.md §2](monitoring.md) にmaintenanceの全内容)

### 2.3 書込ジョブが永久待機/流れない

- **`cloud_push_enabled=false` の店舗は書込が退役PC行きになり無限滞留する**(実障害あり)。SuperAdminの店舗設定を確認。毎分のself-heal rerouteが再ルートするが、フラグ自体がOFFなら流れない
- sync_features のゲートOFF対象ジョブはcancelされず**永久「待機」表示**になる(claim時フィルタのみ)。見かけの滞留として誤認しない
- `push_shifts` が `push_booking` にレーンを譲って待つのは正常。一括解放しない

### 2.4 KPCL017(SB楽観ロック競合)

- 真因は**同一店舗への高密度書込・並行実行**。店舗固有バグではない
- 対応: ホールドされた書込の一括再投入は厳禁。**10〜12分間隔で1件ずつ**。営業時間中に連続する場合は夜間の自然回復を待つ

### 2.5 偽成功・偽失敗のパターン

- 一覧取得が「0件成功」を返す夜間ジョブは偽成功の可能性(コールドセッション一発目問題)。件数の妥当性で判断
- fetch詳細で「N件目以降だけ欠損+実行時間がちょうど10分」→ READ安全弁(10分)によるChrome killの打ち切り。ジョブ分割か再実行で解消
- 書込の「exact_schedule_not_found」系は同名予定の境界ドリフト/部分被覆の可能性(worker側で冪等化済み。残るものは実ギャップ=手動対応)

### 2.6 プロキシ/セッション異常

- 書込はstatic ISP(店舗sticky)、residentialは**読み専用**。この使い分けを崩さない
- 特定IPだけ死んだ場合: probe合格≠実Chrome到達可。`proxy-shop-override.json` で店舗別に退避し、孤児Chromeをkill
- セッション破壊の典型原因はIPローテ(店舗→IP stickyが前提)。プールを触ったら両箱の一致を確認(§1.7)

### 2.7 障害後の再投入原則

1. **原因修正が先。** データ起因(文字数超過・15分刻み外の時刻等)は再実行しても失敗する
2. 一過性失敗(failed)はorphan sweepが自動再投入する。手動再投入が要るのは仕様外エラーのみ
3. 手動再投入は**新規行INSERT**になるため、古いcreated_atのまま復活させると24hゾンビガードに刈られる点に注意
4. 再投入後は結果を1件確認してから残りを流す

---

## 3. 環境変数・シークレットの所在

| もの | 場所 | 備考 |
|---|---|---|
| SALONBOARD_WORKER_TOKEN / SB_PROXY_USERNAME / SB_PROXY_PASSWORD | SSM Parameter Store `/kireidot/worker/*` | EC2インスタンスロールが読取。Admin側 `SALONBOARD_WORKER_TOKEN` と完全一致必須 |
| residentialプロキシ / Anthropic APIキー(画像認証ソルバ) | 同上(`…/residential/*`・`…/anthropic/api_key`) | ロールに権限が無ければスキップされ縮退稼働 |
| worker.env | 箱上 `/opt/kireidot/worker.env` | bootstrapスクリプトがParameter Storeから組み立て。手で編集したら次のbootstrapで消える |
| WORKER_ID | worker.env | **消えると `local-dev` になり運用識別が壊れる**(実障害)。デプロイ後にログで確認 |
| WORKER_CAPABILITIES / max_concurrency | コンテナ内 `/home/pwuser/.kireidot/`(ホットファイル、envより優先) | 変更はrestartで反映 |
| GH Actions | `AWS_DEPLOY_ROLE_ARN`(OIDC) | リポジトリsecrets |

---

## 4. デプロイ後チェックリスト

- [ ] GH Actions緑(メイン+一括の両ステップ)。`deployed_commit` がpushしたSHAと一致
- [ ] `docker logs` 冒頭で WORKER_ID / capabilities / 並行度が期待通り
- [ ] 書込系を触った場合: **FBリポジトリのupstream merge+デプロイ**を実施したか
- [ ] scraper修正の場合: 予約同期くん(デスクトップ)のリリースも必要か判断したか
- [ ] ホットパッチした場合: 同内容をcommit+pushしたか
- [ ] デプロイ後30分の `#kireidot-info` で失敗傾向が出ていないか(デプロイ起因のコールドログイン波)
