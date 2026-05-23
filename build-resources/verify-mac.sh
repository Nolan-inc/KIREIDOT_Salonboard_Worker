#!/usr/bin/env bash
# release/ に出力された予約同期くんの .app と .dmg の検証を行うスクリプト。
#   - codesign / spctl / stapler でホワイトリスト判定
#   - SHA256 ハッシュも出力 (配布物の改ざん検知用)
#
# 実行: npm run verify:mac

set -euo pipefail

APP_PATH="release/mac-arm64/予約同期くん.app"
DMG_PATH="release/salonboard-sync-mac-arm64.dmg"

cd "$(dirname "$0")/.."

ok()  { printf "\033[32m✅ %s\033[0m\n" "$*"; }
ng()  { printf "\033[31m❌ %s\033[0m\n" "$*"; }
hdr() { printf "\n\033[1;36m─── %s ───\033[0m\n" "$*"; }

# .app の検証
hdr "codesign --verify"
if [ -d "$APP_PATH" ]; then
  if codesign --verify --deep --strict --verbose=2 "$APP_PATH" 2>&1 | tail -3; then
    ok "署名 OK"
  else
    ng "署名 NG"
  fi
else
  ng ".app が見つかりません: $APP_PATH"
fi

hdr "spctl --assess (Gatekeeper)"
if [ -d "$APP_PATH" ]; then
  if spctl --assess --type execute --verbose "$APP_PATH" 2>&1 | tail -3; then
    ok "Gatekeeper 承認 OK (公証済み)"
  else
    ng "Gatekeeper 承認 NG → 公証未完了の可能性あり"
  fi
fi

hdr "stapler validate (公証チケットのステープル確認)"
if [ -d "$APP_PATH" ]; then
  if xcrun stapler validate "$APP_PATH" 2>&1; then
    ok ".app に公証チケットがステープル済み"
  else
    ng ".app に公証チケットが無い (notarize 未実行 or 失敗)"
  fi
fi

# .dmg の検証
if [ -f "$DMG_PATH" ]; then
  hdr "stapler validate (.dmg)"
  xcrun stapler validate "$DMG_PATH" 2>&1 || ng ".dmg に公証チケットが無い"
fi

# SHA256
hdr "SHA256"
if [ -f "$DMG_PATH" ]; then
  shasum -a 256 "$DMG_PATH" | tee "${DMG_PATH}.sha256"
  ok "SHA256 を $DMG_PATH.sha256 に出力しました"
else
  ng "dmg が見つかりません: $DMG_PATH"
fi

hdr "完了"
