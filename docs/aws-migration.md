# AWS ECS Fargate 移行 — Phase 0 ランブック

全体設計(マルチテナント・3段フォールバック・OpenClaw統合・二重登録防止)は設計書を参照。
本書は **Phase 0(カナリア)= 「現行 worker.ts を AWS 上で動かせる状態にする」** の手順書。

## 構成物

| パス | 内容 |
|---|---|
| `docker/Dockerfile` | worker.ts を esbuild で単一 ESM にバンドル → `mcr.microsoft.com/playwright:v1.59.1-noble` 上で実行 |
| `docker/package.json` | コンテナ用ランタイム依存(playwright **1.59.1 固定**。イメージタグと厳密一致必須) |
| `docker/entrypoint.sh` | WORKER_ID をタスクメタデータから自動生成し `exec node`(PID1=node で SIGTERM 直接受信) |
| `infra/terraform/` | VPC / NAT GW+予備EIP / ECS(Fargate Spot+OD base1) / ECR / S3×2 / SSM / IAM(GitHub OIDC) |
| `.github/workflows/deploy-worker.yml` | build → Chromium起動スモークテスト → ECR push → タスク定義更新 → rolling deploy |

## 手順

### 1. インフラ構築

```bash
cd infra/terraform
terraform init
terraform apply -var kireidot_api_url=https://<admin-host>
```

前提: GitHub OIDC プロバイダ(`token.actions.githubusercontent.com`)がアカウントに既存であること。
無い場合は先に作成する:

```bash
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com
```

### 2. Worker トークン設定

Admin 側の `SALONBOARD_WORKER_TOKEN`(central-dev モード)と同じ値を SSM に投入:

```bash
aws ssm put-parameter --name /kireidot/worker/SALONBOARD_WORKER_TOKEN \
  --type SecureString --value '<token>' --overwrite
```

### 3. 初回イメージの手動 push(CI 整備前)

```bash
AWS_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
ECR=$AWS_ACCOUNT.dkr.ecr.ap-northeast-1.amazonaws.com
aws ecr get-login-password | docker login --username AWS --password-stdin $ECR
docker build -f docker/Dockerfile -t $ECR/kireidot-sb/salonboard-worker:latest .
docker push $ECR/kireidot-sb/salonboard-worker:latest
```

(CI を使う場合: リポジトリ Secrets に `AWS_DEPLOY_ROLE_ARN` = terraform output `github_deploy_role_arn` を設定し main へ push)

### 4. カナリアタスクの手動起動

ECS Service は `desired_count=0` で作成される。カナリアは run-task で 1 個だけ起動:

```bash
aws ecs run-task \
  --cluster kireidot-sb-cluster \
  --task-definition kireidot-sb-worker \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$(terraform output -json private_subnet_ids | jq -r 'join(",")')],securityGroups=[$(terraform output -raw worker_security_group_id)],assignPublicIp=DISABLED}"
```

### 5. カナリア検証(2週間)— Akamai Go/No-Go ゲート

**対象はテスト用 1 店舗の読み取り専用ジョブのみ**(`SALONBOARD_ENABLE_PUSH=false` をタスク定義で強制済み)。

計測して PC 実績と比較する:
- ログイン成功率(`[job]` ログ / callback status)
- reCAPTCHA 検知率(`captcha_detected`)・`blocked`(403/429)発生率
- storageState の寿命(再ログイン頻度。合格ライン: 1回/日以下)
- egress GB/ジョブ(NAT GW コスト再見積もり用)

ログ: CloudWatch Logs `/ecs/kireidot-sb-worker`

**No-Go の場合**: クラウドは fetch 専任 or 停止し、push は PC + OpenClaw 構成を継続(設計書 §13-1)。

## Phase 0 の既知の制約(設計どおり・意図的)

- storageState はタスクローカル(`~/.kireidot/`)。タスク再起動ごとに再ログインになる。
  S3 永続化(`STATE_S3_BUCKET` は env 済み・実装は Phase 1 の worker.ts 変更 #1)。
- ジョブ claim はまだ現行 Admin API のまま(lease / capability / shop 排他の DB 化は Phase 1)。
- **PC 2台の現行運用は一切変更しない**(カナリアは読み取り専用で並走)。

## Phase 0.5: 二重登録防止スパイク(Phase 0 と並行)

実装済みの成果物:

- `salonboard-rescan.ts` — 冪等性マーカー再スキャン共通モジュール(方式A: 詳細ページ巡回でページ全文からマーカー照合 + 方式B: 顧客名で候補を優先順付け)。読み取り専用。
- `test-rescan.ts`(`npm run test:rescan -- --booking-id=<ID>`)— 実 DOM 検証スパイク CLI。
  検証観点: ①登録済み/未登録 ID で found が期待どおりか ②一覧 init の表示期間(日付絞り込みの要否)③reserveId が `YG\d+` 形式か ④詳細巡回 1 件の所要時間
- worker.ts SIGTERM クリティカルセクション — 停止要求受信時、(a) ジョブ開始前/登録ボタン押下前なら retryable_failed で中断、(b) 押下後は callback まで完走。
  早期中断分岐はバンドルに対する自動テストで検証済み。**押下前/押下後への SIGTERM 注入の実機テスト**は、実店舗での `test:push` 実行中に `kill -TERM` を打って確認する(スパイクの一部)。

スパイク実行手順(実店舗の SalonBoard アカウントが必要):

```bash
# 1. Admin で fetch 系ジョブを 1 件投入(認証情報を借りるため)
# 2. 同期済み予約の booking_id で「見つかる」ことを確認
npm run test:rescan -- --booking-id=<同期済みbooking_id> --customer=<顧客名>
# 3. 存在しない ID で「見つからない + exhaustive=true」を確認
npm run test:rescan -- --booking-id=nonexistent-$(date +%s)
```

**この再スキャンの実 DOM 検証が完了するまで、push の層またぎ自動再試行・ALREADY_EXISTS→synced 直行は解禁しない**(設計 §6.1)。

## 次フェーズ(設計書 §11)

- Phase 1: ECS Service 化 / claim の lease・capability 対応(Admin 側変更)/ storageState S3 / CI 本稼働(push トリガー有効化 + `AWS_DEPLOY_ROLE_ARN` secret 設定)
