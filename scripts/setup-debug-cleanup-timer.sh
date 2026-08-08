#!/bin/bash
# デバッグcapture (~/.kireidot/salonboard-debug) の日次お掃除を systemd timer で設置する。
#
#   使い方: bash scripts/setup-debug-cleanup-timer.sh [retention-days]
#     既定: 7日。全4箱(常時系/一括/投稿/予備)に設置する。
#
# なぜ cron ではなく systemd timer なのか (2026-08-09):
#   箱のOSは Amazon Linux 2023 で cronie / cronie-anacron が未インストール。
#   /etc/cron.daily/ は単なるディレクトリで、それを回す crond + anacron が存在しないため、
#   2026-08-08 に設置された /etc/cron.daily/sb-debug-cleanup は一度も実行されていなかった。
#   AL2023 ネイティブの systemd timer なら追加パッケージ無しで確実に動く。
#   ⚠️ 箱で定期実行を仕込むときは常に systemd timer を使い、systemctl list-timers で確認すること。
#
# 冪等: 再実行するとユニットを上書きして再有効化する。設置後に1回だけ即実行して動作確認する。
# 読み取り以外の変更は「ユニット設置」「旧cron.dailyスクリプト削除」「capture削除」のみ。
set -euo pipefail

REGION=ap-northeast-1
export AWS_PROFILE="${AWS_PROFILE:-kireidot-prod}"
RETENTION_DAYS="${1:-7}"

# instance-id:container の対応 (docs/operations.md §0 と一致させること)
BOXES=(
  "i-0f1cc0aff1ac8dd2e:sb-worker-cloud"
  "i-06a56736ddc6512f8:sb-worker-bulk"
  "i-0e77765c6ca7843eb:sb-worker-post"
  "i-09e54e0b55fb8ab34:sb-worker-fallback"
)

for BOX in "${BOXES[@]}"; do
  INSTANCE_ID="${BOX%%:*}"
  CONTAINER="${BOX##*:}"

  # ユニットファイルは base64 で運ぶ (SSM の JSON へ多重クォートを持ち込まないため)
  SERVICE_B64=$(printf '%s\n' \
    "[Unit]" \
    "Description=Prune SalonBoard debug captures older than ${RETENTION_DAYS} days (${CONTAINER})" \
    "After=docker.service" \
    "" \
    "[Service]" \
    "Type=oneshot" \
    "ExecStart=/usr/bin/docker exec ${CONTAINER} find /home/pwuser/.kireidot/salonboard-debug -mindepth 2 -maxdepth 2 -type d -mtime +${RETENTION_DAYS} -exec rm -rf {} +" \
    "SuccessExitStatus=0 1" \
    | base64 | tr -d '\n')

  TIMER_B64=$(printf '%s\n' \
    "[Unit]" \
    "Description=Daily prune of SalonBoard debug captures (${CONTAINER})" \
    "" \
    "[Timer]" \
    "OnCalendar=daily" \
    "Persistent=true" \
    "RandomizedDelaySec=900" \
    "" \
    "[Install]" \
    "WantedBy=timers.target" \
    | base64 | tr -d '\n')

  PARAMS=$(python3 - "$SERVICE_B64" "$TIMER_B64" "$CONTAINER" "$RETENTION_DAYS" <<'PY'
import json, sys
svc, tmr, container, days = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
cmds = [
    "set -e",
    "hostname",
    f"printf %s {svc} | base64 -d > /etc/systemd/system/sb-debug-cleanup.service",
    f"printf %s {tmr} | base64 -d > /etc/systemd/system/sb-debug-cleanup.timer",
    "systemctl daemon-reload",
    "systemctl enable --now sb-debug-cleanup.timer",
    # 動かない旧cron.dailyスクリプトを撤去 (残すと「掃除されている」と誤認する)
    "rm -f /etc/cron.daily/sb-debug-cleanup && echo removed_dead_cron_daily || true",
    "echo '--- before ---'",
    f"docker exec {container} sh -c 'du -sh /home/pwuser/.kireidot/salonboard-debug 2>/dev/null || echo none'",
    f"docker exec {container} sh -c 'find /home/pwuser/.kireidot/salonboard-debug -mindepth 2 -maxdepth 2 -type d -mtime +{days} 2>/dev/null | wc -l' | sed 's/^/expired_dirs=/'",
    "echo '--- run once ---'",
    "systemctl start sb-debug-cleanup.service",
    "systemctl show sb-debug-cleanup.service -p Result -p ExecMainStatus",
    "echo '--- after ---'",
    f"docker exec {container} sh -c 'du -sh /home/pwuser/.kireidot/salonboard-debug 2>/dev/null || echo none'",
    f"docker exec {container} sh -c 'find /home/pwuser/.kireidot/salonboard-debug -mindepth 2 -maxdepth 2 -type d -mtime +{days} 2>/dev/null | wc -l' | sed 's/^/expired_dirs=/'",
    "echo '--- timer registered ---'",
    "systemctl list-timers --all --no-pager | grep sb-debug || echo 'TIMER NOT LISTED'",
    "df -h / | tail -1",
]
print(json.dumps({"commands": cmds}))
PY
)

  echo "##################### ${INSTANCE_ID} (${CONTAINER})"
  CMD_ID=$(aws ssm send-command --region "$REGION" --instance-ids "$INSTANCE_ID" \
    --document-name AWS-RunShellScript --timeout-seconds 600 \
    --comment "setup-sb-debug-cleanup-timer" \
    --parameters "$PARAMS" --query Command.CommandId --output text)
  aws ssm wait command-executed --region "$REGION" --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" >/dev/null 2>&1 || true
  aws ssm get-command-invocation --region "$REGION" --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" \
    --query '{Status:Status,Out:StandardOutputContent,Err:StandardErrorContent}' --output text
done
