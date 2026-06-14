#!/bin/sh
set -eu

# 本番 worker は headful 実 Chrome 必須 (headless は Akamai に弾かれる実測あり)。
# 既定で channel=chrome + headful(Xvfb) を有効化。タスク env で上書き可能。
export SB_BROWSER_CHANNEL="${SB_BROWSER_CHANNEL:-chrome}"
export SB_HEADLESS="${SB_HEADLESS:-0}"

# SB_HEADLESS=0 のとき: Xvfb を明示的にバックグラウンド起動し DISPLAY を渡す。
# (xvfb-run は非 root 下でハングするため使わない)
if [ "${SB_HEADLESS}" = "0" ]; then
  rm -f /tmp/.X99-lock 2>/dev/null || true
  Xvfb :99 -screen 0 1280x1024x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
  export DISPLAY=:99
  # Xvfb が listen するまで最大 5 秒待つ
  i=0
  while [ $i -lt 50 ]; do
    if [ -e /tmp/.X99-lock ]; then break; fi
    i=$((i + 1)); sleep 0.1
  done
  echo "[entrypoint] Xvfb started DISPLAY=$DISPLAY"
fi

# worker 本体 (poll ループ) を PID1 として起動。
# KIREIDOT_API_URL / SALONBOARD_WORKER_TOKEN / SB_PROXY_* 等は
# タスク定義 (SSM 経由) で注入する。CANARY_MODE / WORKER_DISABLE_MAIN は設定しない。
exec node /app/worker.cjs "$@"
