#!/bin/sh
set -eu

# WORKER_ID 未指定時は ECS タスクメタデータ (V4) から自動生成する。
# ログと job.locked_by にタスク単位の識別子が載るようにするため。
if [ -z "${WORKER_ID:-}" ] && [ -n "${ECS_CONTAINER_METADATA_URI_V4:-}" ]; then
  WORKER_ID="fargate-$(node -e '
    fetch(process.env.ECS_CONTAINER_METADATA_URI_V4 + "/task")
      .then((r) => r.json())
      .then((t) => process.stdout.write(String(t.TaskARN || "").split("/").pop() || "unknown"))
      .catch(() => process.stdout.write("unknown"));
  ')"
  export WORKER_ID
fi

# CANARY_MODE=1: Admin/ジョブキューに触れない読み取り専用 Akamai カナリア (canary.ts)。
# canary は worker モジュールを import するため、worker のトップレベル env 検証を
# 無害なプレースホルダで満たす (canary はどちらも使用しない)。
if [ "${CANARY_MODE:-}" = "1" ]; then
  export KIREIDOT_API_URL="${KIREIDOT_API_URL:-http://canary-disabled.invalid}"
  export WORKER_MODE="${WORKER_MODE:-central-dev}"
  export SALONBOARD_WORKER_TOKEN="${SALONBOARD_WORKER_TOKEN:-canary-unused}"
  exec node /app/canary.mjs "$@"
fi

# exec で PID 1 を node にし、ECS の SIGTERM を worker.ts が直接受ける
exec node /app/worker.mjs "$@"
