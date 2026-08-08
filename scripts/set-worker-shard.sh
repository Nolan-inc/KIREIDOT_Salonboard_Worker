#!/bin/bash
# ワーカー箱に担当シャードを設定する (ホット設定・コンテナ再作成なし)。
#
#   使い方:
#     bash scripts/set-worker-shard.sh <instance-id> <container> <shard番号|none>
#   例:
#     bash scripts/set-worker-shard.sh i-0f1cc0aff1ac8dd2e sb-worker-cloud 1
#     bash scripts/set-worker-shard.sh i-0f1cc0aff1ac8dd2e sb-worker-cloud none   # 解除(全店舗)
#
# 仕組み: worker は /home/pwuser/.kireidot/worker_capabilities を毎ポール読み直す。
# ここに "shard_N" を足すと Admin の jobs API が p_shard=N に変換して claim を絞る。
# 既存の playwright_cloud / lane_* は保持したまま shard_* だけ差し替える。
#
# ⚠️ 順序の鉄則: シャードを有効化する前に、必ず全 shard 分の箱を先に立てること。
#    担当worker不在の shard に店舗が割り当たると、その店舗のジョブが宙に浮く。
#    (未割当アカウントは全workerが拾えるが、割当済みは担当workerしか拾わない)
set -euo pipefail

REGION=ap-northeast-1
export AWS_PROFILE="${AWS_PROFILE:-kireidot-prod}"

IID="${1:?instance-id が必要です}"
CONTAINER="${2:?container名が必要です}"
SHARD="${3:?shard番号 または none が必要です}"

if [[ "$SHARD" != "none" && ! "$SHARD" =~ ^[0-9]+$ ]]; then
  echo "shard は数値か none を指定してください: $SHARD" >&2
  exit 1
fi

# 既存 capabilities から shard_* を除去し、必要なら新しい shard_N を足す
if [[ "$SHARD" == "none" ]]; then
  SED_EXPR='s/,shard_[0-9]+//g; s/shard_[0-9]+,//g; s/^shard_[0-9]+$//'
  APPEND=""
else
  SED_EXPR='s/,shard_[0-9]+//g; s/shard_[0-9]+,//g; s/^shard_[0-9]+$//'
  APPEND=",shard_${SHARD}"
fi

CMD=$(cat <<EOSH
set -e
F=/home/pwuser/.kireidot/worker_capabilities
CUR=\$(docker exec $CONTAINER sh -c "cat \$F 2>/dev/null || echo ''" | tr -d '\r\n')
if [ -z "\$CUR" ]; then
  CUR=\$(docker inspect $CONTAINER --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^WORKER_CAPABILITIES=//p' | tr -d '\r\n')
fi
NEXT=\$(printf '%s' "\$CUR" | sed -E '$SED_EXPR')
NEXT="\${NEXT}$APPEND"
NEXT=\$(printf '%s' "\$NEXT" | sed -E 's/,,+/,/g; s/^,//; s/,$//')
docker exec $CONTAINER sh -c "printf '%s' '\$NEXT' > \$F"
echo "before=\$CUR"
echo "after=\$(docker exec $CONTAINER cat \$F)"
EOSH
)

CMD_ID=$(aws ssm send-command --region "$REGION" --instance-ids "$IID" \
  --document-name AWS-RunShellScript \
  --parameters "{\"commands\":[$(python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))' <<<"$CMD")]}" \
  --query Command.CommandId --output text)
sleep 8
aws ssm get-command-invocation --region "$REGION" --command-id "$CMD_ID" --instance-id "$IID" \
  --query '{Status:Status,Output:StandardOutputContent,Error:StandardErrorContent}' --output text
