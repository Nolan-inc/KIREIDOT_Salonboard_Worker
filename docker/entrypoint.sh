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

# exec で PID 1 を node にし、ECS の SIGTERM を worker.ts が直接受ける
exec node /app/worker.mjs "$@"
