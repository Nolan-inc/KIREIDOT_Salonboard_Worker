#!/bin/bash
# ============================================================
# 店舗 Mac mini キッティングスクリプト
#   「予約同期くん」(SalonBoard worker) を 1 コマンドでセットアップする:
#     1) .dmg インストール
#     2) デバイス設定 (salonboard-device.json) 書き込み
#     3) 常時稼働化 (スリープ無効)
#     4) アプリ起動
#
# 各店舗に専用 Mac mini を置く運用を想定。1 店舗 = 1 デバイストークン推奨
# (Admin の /admin/salonboard/devices で発行し、その店舗に紐付ける)。
#
# 使い方:
#   ./setup-store-worker.sh \
#       --token   <DEVICE_TOKEN>            # 必須 (Admin発行)
#       --api     https://admin.kireidot.jp # 任意 (既定)
#       --device  <DEVICE_ID(uuid)>         # 任意 (device認証時)
#       --worker  銀座本店-mac-01           # 任意 (同期履歴の識別子)
#       --dmg     <.dmgパス or GitHub URL>  # 任意 (省略時はインストール skip)
#
# ⚠️ 事前に Admin 側で「店舗登録 + SalonBoard認証情報登録 + デバイス発行/店舗紐付け」
#    を済ませておくこと (このスクリプトは PC 側のセットアップのみ)。
# ============================================================
set -euo pipefail

API_URL="https://admin.kireidot.jp"
DEVICE_TOKEN=""
DEVICE_ID=""
WORKER_ID="$(scutil --get LocalHostName 2>/dev/null || hostname)"
DMG=""
# Electron userData 名。electron-builder の productName。実機で要確認
#   (~/Library/Application Support/ 配下のフォルダ名)
APP_NAME="予約同期くん"

while [ $# -gt 0 ]; do
  case "$1" in
    --token)  DEVICE_TOKEN="$2"; shift 2;;
    --api)    API_URL="$2"; shift 2;;
    --device) DEVICE_ID="$2"; shift 2;;
    --worker) WORKER_ID="$2"; shift 2;;
    --dmg)    DMG="$2"; shift 2;;
    --app-name) APP_NAME="$2"; shift 2;;
    *) echo "不明な引数: $1"; exit 1;;
  esac
done

if [ -z "$DEVICE_TOKEN" ]; then
  echo "エラー: --token <DEVICE_TOKEN> は必須です (Admin で発行)"; exit 1
fi

echo "▶ 1) アプリのインストール"
if [ -n "$DMG" ]; then
  SRC="$DMG"
  case "$DMG" in
    http*) SRC="/tmp/salonboard-sync.dmg"; echo "  ダウンロード: $DMG"; curl -fsSL "$DMG" -o "$SRC";;
  esac
  MNT="$(hdiutil attach "$SRC" -nobrowse -quiet | grep -oE '/Volumes/[^ ]+' | head -1)"
  APP_IN_DMG="$(find "$MNT" -maxdepth 1 -name '*.app' | head -1)"
  if [ -n "$APP_IN_DMG" ]; then
    rm -rf "/Applications/$(basename "$APP_IN_DMG")"
    cp -R "$APP_IN_DMG" /Applications/
    echo "  ✓ /Applications/$(basename "$APP_IN_DMG") にインストール"
    APP_NAME="$(basename "$APP_IN_DMG" .app)"
  fi
  hdiutil detach "$MNT" -quiet || true
else
  echo "  (DMG未指定 → アプリは手動インストール済みの前提で続行)"
fi

echo "▶ 2) デバイス設定 (salonboard-device.json)"
APP_SUPPORT="$HOME/Library/Application Support/$APP_NAME"
mkdir -p "$APP_SUPPORT"
CONF="$APP_SUPPORT/salonboard-device.json"
cat > "$CONF" <<JSON
{
  "apiUrl": "$API_URL",
  "deviceId": "$DEVICE_ID",
  "deviceToken": "$DEVICE_TOKEN",
  "workerId": "$WORKER_ID"
}
JSON
chmod 600 "$CONF"
echo "  ✓ 設定を書き込み: $CONF (token は表示しません)"

echo "▶ 3) 常時稼働化 (スリープ無効: workerが止まらないように)"
if sudo -n true 2>/dev/null; then
  sudo pmset -a sleep 0 disksleep 0 displaysleep 10 womp 1 2>/dev/null && echo "  ✓ システムスリープ無効化" || echo "  ⚠ pmset失敗。手動で設定>省エネ→スリープしないに"
else
  echo "  ⚠ 管理者権限が必要: 後で 'sudo pmset -a sleep 0 disksleep 0' を実行、または 設定>省エネ でスリープOFF"
fi

echo "▶ 4) アプリ起動"
open -a "$APP_NAME" 2>/dev/null || open "/Applications/$APP_NAME.app" 2>/dev/null || \
  echo "  ⚠ 起動失敗。手動でアプリを起動してください"

echo ""
echo "✅ セットアップ完了 (worker=$WORKER_ID)"
echo "   アプリ上部のバナーが「表示なし(正常)」になればOK。"
echo "   「担当店舗が未割当」等が出たら Admin 側の店舗紐付け/認証情報登録を確認。"
