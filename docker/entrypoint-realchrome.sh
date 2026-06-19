#!/bin/sh
set -eu

# worker トップレベル env 検証を無害値で満たす (canary は使用しない)
export KIREIDOT_API_URL="${KIREIDOT_API_URL:-http://canary-disabled.invalid}"
export WORKER_MODE="${WORKER_MODE:-central-dev}"
export SALONBOARD_WORKER_TOKEN="${SALONBOARD_WORKER_TOKEN:-canary-unused}"
export CANARY_MODE=1

# SB_HEADLESS=0 のとき: Xvfb を明示的にバックグラウンド起動し DISPLAY を渡して
# 本物 Chrome を「真のヘッドフル」で動かす。
# (xvfb-run は非 root 下でハングするため使わない)
if [ "${SB_HEADLESS:-1}" = "0" ]; then
  rm -f /tmp/.X99-lock 2>/dev/null || true
  Xvfb :99 -screen 0 1280x1024x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
  XVFB_PID=$!
  export DISPLAY=:99
  # Xvfb が listen するまで最大 5 秒待つ
  i=0
  while [ $i -lt 50 ]; do
    if [ -e /tmp/.X99-lock ]; then break; fi
    i=$((i + 1)); sleep 0.1
  done
  echo "[entrypoint] Xvfb started pid=$XVFB_PID DISPLAY=$DISPLAY"
  exec node /app/canary.mjs "$@"
fi

exec node /app/canary.mjs "$@"
