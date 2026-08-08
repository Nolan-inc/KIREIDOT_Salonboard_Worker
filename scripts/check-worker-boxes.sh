#!/bin/bash
# 全ワーカー箱の健全性を読み取り専用で点検する運用診断スクリプト。
#
#   使い方: bash scripts/check-worker-boxes.sh
#
# 点検項目:
#   1. ワーカーの生存 (コンテナ状態 / WORKER_ID / capabilities / 並行度)
#   2. ディスク使用率と内訳 (capture / Chromeプロファイル / docker)
#   3. systemd timer の登録と直近結果 (sb-debug-cleanup)
#   4. ⚠️死んだcron設定の検出 — AL2023はcronie未インストールで /etc/cron.* が
#      一切実行されない。置いてあるだけの設定は「動いているつもり」の温床になる
#      (2026-08-09に capture掃除で発覚)。定期実行は必ず systemd timer で行うこと。
#
# 状態は一切変更しない。
set -uo pipefail

REGION=ap-northeast-1
export AWS_PROFILE="${AWS_PROFILE:-kireidot-prod}"

BOXES=(
  "i-0f1cc0aff1ac8dd2e:sb-worker-cloud:メイン(常時系)"
  "i-06a56736ddc6512f8:sb-worker-bulk:一括系"
  "i-0e77765c6ca7843eb:sb-worker-post:投稿系"
  "i-09e54e0b55fb8ab34:sb-worker-fallback:予備FB"
  "i-0f13227ff67fd56d8:sb-worker-fallback:予備FB2(8/9冗長化)"
)

for BOX in "${BOXES[@]}"; do
  IFS=':' read -r INSTANCE_ID CONTAINER LABEL <<< "$BOX"

  PARAMS=$(python3 - "$CONTAINER" <<'PY'
import json, sys
c = sys.argv[1]
cmds = [
  "echo '=== 1. worker ==='",
  f"docker ps --filter name={c} --format '{{{{.Names}}}} {{{{.Status}}}}' || echo 'CONTAINER NOT FOUND'",
  f"docker exec {c} sh -c 'cat /home/pwuser/.kireidot/worker_capabilities 2>/dev/null || echo \"(no hot capabilities file)\"' | sed 's/^/capabilities=/'",
  f"docker exec {c} sh -c 'cat /home/pwuser/.kireidot/max_concurrency 2>/dev/null || echo \"(default)\"' | sed 's/^/max_concurrency=/'",
  # ⚠️ WORKER_ID は env が空でもホットファイルで解決される (worker.ts:192)。
  #    env だけを見ると local-dev と誤診するため、実効値はホットファイルで確認する。
  #    最終的な権威は DB: select locked_by from salonboard_sync_jobs where locked_at > now()-'1h'
  f"docker exec {c} sh -c 'cat /home/pwuser/.kireidot/worker_id 2>/dev/null || echo \"(env fallback)\"' | sed 's/^/worker_id(hot file)=/'",
  f"docker inspect {c} --format 'RestartCount={{{{.RestartCount}}}} Started={{{{.State.StartedAt}}}}' 2>/dev/null || true",
  "echo '=== 2. disk / memory ==='",
  "df -h / | tail -1",
  "free -h | sed -n '2p'",
  f"docker exec {c} sh -c 'du -sh /home/pwuser/.kireidot/salonboard-debug 2>/dev/null || echo 0' | sed 's/^/capture=/'",
  f"docker exec {c} sh -c 'du -sh /home/pwuser/.kireidot/salonboard-chrome-profile 2>/dev/null || echo 0' | sed 's/^/chrome_profiles=/'",
  f"docker exec {c} sh -c 'du -sh /home/pwuser/.kireidot/salonboard-chrome-profile/* 2>/dev/null | sort -rh | head -3' || true",
  "docker system df 2>/dev/null | sed -n '2,3p'",
  "echo '=== 3. cleanup timer ==='",
  "systemctl list-timers --all --no-pager 2>/dev/null | grep sb-debug || echo '⚠️ TIMER NOT REGISTERED'",
  "systemctl show sb-debug-cleanup.service -p Result -p ExecMainStatus 2>/dev/null | tr '\\n' ' '; echo",
  "echo '=== 4. 死んだcron検出 ==='",
  "rpm -q cronie >/dev/null 2>&1 && echo 'cronie: installed' || echo 'cronie: NOT installed (=/etc/cron.* は実行されない)'",
  "for d in /etc/cron.d /etc/cron.hourly /etc/cron.daily /etc/cron.weekly /etc/cron.monthly; do n=$(ls -A $d 2>/dev/null | wc -l); [ \"$n\" -gt 0 ] && echo \"⚠️ DEAD CRON in $d:\" && ls -1 $d; done; echo '(上記が空なら死んだcronは無し)'",
  "crontab -l 2>/dev/null | grep -vE '^\\s*#' | grep -v '^$' | sed 's/^/⚠️ root crontab: /' || true",
  f"docker exec {c} sh -c 'crontab -l 2>/dev/null | grep -vE \"^\\s*#\" | grep -v \"^$\"' | sed 's/^/⚠️ container crontab: /' || true",
]
print(json.dumps({"commands": cmds}))
PY
)

  echo ""
  echo "############################################################"
  echo "# ${LABEL}  ${INSTANCE_ID} / ${CONTAINER}"
  echo "############################################################"
  CMD_ID=$(aws ssm send-command --region "$REGION" --instance-ids "$INSTANCE_ID" \
    --document-name AWS-RunShellScript --timeout-seconds 300 \
    --comment "check-worker-boxes" \
    --parameters "$PARAMS" --query Command.CommandId --output text)
  aws ssm wait command-executed --region "$REGION" --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" >/dev/null 2>&1 || true
  aws ssm get-command-invocation --region "$REGION" --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" \
    --query 'StandardOutputContent' --output text
done
