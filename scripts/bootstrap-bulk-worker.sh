#!/bin/bash
# 一括系(lane_bulk)ワーカーEC2の初期ブートストラップ。
#
#   使い方: bash scripts/bootstrap-bulk-worker.sh [instance-id] [deploy-sha]
#     既定: i-06a56736ddc6512f8 (kireidot-sb-bulk-worker) / 現行デプロイSHA
#
# ローカル(管理者クレデンシャル)から実行する。このスクリプトにも出力にもシークレットは
# 現れない: worker.env はEC2上でインスタンスロールの Parameter Store 読取権限
# (/kireidot/worker/SALONBOARD_WORKER_TOKEN, SB_PROXY_USERNAME, SB_PROXY_PASSWORD)
# により組み立てられる。residential/anthropic のパラメータはロールに読取権限があれば
# 自動で組み込み、無ければスキップする(後から追加可)。
#
# 冪等: 再実行すると worker.env を作り直し、コンテナを再作成する。
set -euo pipefail

REGION=ap-northeast-1
INSTANCE_ID="${1:-i-06a56736ddc6512f8}"
DEPLOY_SHA="${2:-710e7780fdc68e1af48c96bb56bb24c442e518e8}"
BUCKET=kireidot-sb-worker-debug-972293797066

URL=$(aws s3 presign "s3://$BUCKET/deploy/$DEPLOY_SHA/worker.cjs" --region "$REGION" --expires-in 900)

PARAMS=$(python3 - "$URL" <<'PY'
import json, sys
url = sys.argv[1]
cmds = [
    "set -e",
    # user_data (docker install + image pull) の完了を待つ
    "for i in $(seq 1 60); do systemctl is-active docker >/dev/null 2>&1 && break; sleep 5; done",
    "systemctl is-active docker",
    "ECR=972293797066.dkr.ecr.ap-northeast-1.amazonaws.com",
    "aws ecr get-login-password --region ap-northeast-1 | docker login --username AWS --password-stdin $ECR >/dev/null",
    "docker pull -q $ECR/kireidot-sb/salonboard-worker:latest",
    "mkdir -p /opt/kireidot",
    # 現行デプロイSHAの worker.cjs バンドル
    "curl -fsSL --retry 3 " + json.dumps(url) + " -o /opt/kireidot/worker.cjs",
    "test -s /opt/kireidot/worker.cjs && echo bundle_sha256=$(sha256sum /opt/kireidot/worker.cjs | cut -c1-16)",
    # worker.env をオンボックスで構築 (シークレットは Parameter Store からロール権限で取得)
    "P() { aws ssm get-parameter --region ap-northeast-1 --with-decryption --name \"$1\" --query Parameter.Value --output text; }",
    "umask 077",
    "{ echo KIREIDOT_API_URL=https://admin.kireidot.jp;"
    " echo WORKER_MODE=central-dev;"
    " echo NODE_ENV=production;"
    " echo SB_BROWSER_CHANNEL=chrome;"
    " echo SB_HEADLESS=0;"
    " echo SALONBOARD_ENABLE_PUSH=1;"
    # ⚠️ メイン箱のプール(20 IP)と同一構成にすること。FNV-1a hashの店舗→IP sticky割当は
    #    プールサイズ/順序に依存するため、両ワーカーで揃わないと同一店舗が別出口IPになる。
    " echo SB_PROXY_POOL=isp.decodo.com:10001,isp.decodo.com:10002,isp.decodo.com:10003,isp.decodo.com:10004,isp.decodo.com:10005,isp.decodo.com:10006,isp.decodo.com:10007,isp.decodo.com:10008,isp.decodo.com:10009,isp.decodo.com:10010,isp.decodo.com:10011,isp.decodo.com:10012,isp.decodo.com:10013,isp.decodo.com:10014,isp.decodo.com:10015,isp.decodo.com:10016,isp.decodo.com:10017,isp.decodo.com:10018,isp.decodo.com:10019,isp.decodo.com:10020;"
    " echo SB_PROXY_USERNAME=$(P /kireidot/worker/SB_PROXY_USERNAME);"
    " echo SB_PROXY_PASSWORD=$(P /kireidot/worker/SB_PROXY_PASSWORD);"
    " echo SALONBOARD_WORKER_TOKEN=$(P /kireidot/worker/SALONBOARD_WORKER_TOKEN);"
    " echo WORKER_ID=cloud-bulk-1;"
    " echo WORKER_CAPABILITIES=playwright_cloud,lane_bulk;"
    " echo SB_MAX_CONCURRENCY=2; } > /opt/kireidot/worker.env",
    # residential fallback (ロールに権限があれば。無ければISP poolのみで稼働)
    "if RES_EP=$(P /kireidot/worker/residential/endpoint 2>/dev/null); then"
    " { echo SB_PROXY_FALLBACK_SERVER=$RES_EP;"
    " echo SB_PROXY_FALLBACK_USERNAME=$(P /kireidot/worker/residential/username);"
    " echo SB_PROXY_FALLBACK_PASSWORD=$(P /kireidot/worker/residential/password); } >> /opt/kireidot/worker.env;"
    " echo residential=configured; else echo residential=skipped; fi",
    "echo env_lines=$(grep -c = /opt/kireidot/worker.env)",
    # コンテナ起動 (FB箱と同形: SYS_ADMIN + shm2g + restart unless-stopped + env-file + bind)
    "docker rm -f sb-worker-bulk 2>/dev/null || true",
    "docker run -d --name sb-worker-bulk --restart unless-stopped --cap-add SYS_ADMIN"
    " --shm-size 2g --env-file /opt/kireidot/worker.env"
    " -v /opt/kireidot/worker.cjs:/app/worker.cjs:ro"
    " $ECR/kireidot-sb/salonboard-worker:latest",
    "sleep 8",
    # anthropic api key (画像認証ソルバ)。ロールに権限があればホットファイルへ
    "if AK=$(P /kireidot/worker/anthropic/api_key 2>/dev/null); then"
    " docker exec sb-worker-bulk sh -c \"mkdir -p /home/pwuser/.kireidot && umask 077 && printf %s '$AK' > /home/pwuser/.kireidot/anthropic_api_key\";"
    " echo anthropic=seeded; else echo anthropic=skipped; fi",
    "docker ps --format '{{.Names}} {{.Status}}'",
    # プロキシ疎通 (EIP が Decodo whitelist に載っているかの実地確認。IP認証)
    "echo proxy_test=$(curl -m 15 -s -x http://isp.decodo.com:10001 https://ipinfo.io/ip || echo FAIL)",
    "echo ---boot-log---",
    "docker logs --tail 15 sb-worker-bulk 2>&1 || true",
]
print(json.dumps({"commands": cmds}))
PY
)

CMD_ID=$(aws ssm send-command --region "$REGION" --instance-ids "$INSTANCE_ID" \
  --document-name AWS-RunShellScript --timeout-seconds 900 \
  --parameters "$PARAMS" --query Command.CommandId --output text)
echo "SSM command: $CMD_ID (完了まで数分)"
aws ssm wait command-executed --region "$REGION" --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" || true
aws ssm get-command-invocation --region "$REGION" --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" \
  --query '{Status:Status,Out:StandardOutputContent,Err:StandardErrorContent}' --output json
