#!/bin/bash
# 稼働中の cloud worker コンテナのレーン申告 (worker_capabilities ホット設定) を
# 切り替えてコンテナを再起動する。ローカル(管理者クレデンシャル)から実行する。
#
#   使い方: bash scripts/set-worker-lane.sh [instance-id] [container] [capabilities]
#   例:
#     メインを常時系専用に:
#       bash scripts/set-worker-lane.sh i-0f1cc0aff1ac8dd2e sb-worker-cloud playwright_cloud,lane_realtime
#     元に戻す(全レーン):
#       bash scripts/set-worker-lane.sh i-0f1cc0aff1ac8dd2e sb-worker-cloud playwright_cloud
#
# 仕組み: /home/pwuser/.kireidot/worker_capabilities はホット設定ファイルで、
# 存在すると env WORKER_CAPABILITIES より優先される (worker.ts 参照)。読み込みは
# プロセス起動時のみのため docker restart が必要。restart -t 40 で SIGTERM 猶予を
# 与え、開いている BrowserContext の cookie/_abck を flush してから停止する
# (docker/entrypoint のセッション保護と同じ想定)。
set -euo pipefail

REGION=ap-northeast-1
INSTANCE_ID="${1:-i-0f1cc0aff1ac8dd2e}"
CONTAINER="${2:-sb-worker-cloud}"
CAPS="${3:-playwright_cloud,lane_realtime}"

PARAMS=$(python3 - "$CONTAINER" "$CAPS" <<'PY'
import json, sys
container, caps = sys.argv[1], sys.argv[2]
cmds = [
    "set -e",
    f"docker exec {container} sh -c 'echo {caps} > /home/pwuser/.kireidot/worker_capabilities && echo wrote: '$(docker exec {container} cat /home/pwuser/.kireidot/worker_capabilities 2>/dev/null || true)",
    f"docker restart -t 40 {container}",
    "sleep 8",
    "docker ps --format '{{.Names}} {{.Status}}'",
    f"docker logs --tail 8 {container} 2>&1",
]
print(json.dumps({"commands": cmds}))
PY
)

CMD_ID=$(aws ssm send-command --region "$REGION" --instance-ids "$INSTANCE_ID" \
  --document-name AWS-RunShellScript --timeout-seconds 300 \
  --parameters "$PARAMS" --query Command.CommandId --output text)
echo "SSM command: $CMD_ID"
aws ssm wait command-executed --region "$REGION" --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" || true
aws ssm get-command-invocation --region "$REGION" --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" \
  --query '{Status:Status,Out:StandardOutputContent,Err:StandardErrorContent}' --output json
