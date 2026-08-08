#!/bin/bash
# 使われていない旧Chromeプロファイル(shop単位・.bak)を削除してディスクを回収する。
#
#   使い方:
#     bash scripts/prune-legacy-chrome-profiles.sh              # ドライラン(既定・何も消さない)
#     bash scripts/prune-legacy-chrome-profiles.sh --apply      # 実行
#     bash scripts/prune-legacy-chrome-profiles.sh --apply 16   # 最低アカウントプロファイル数を指定
#
# 背景 (2026-08-09):
#   セッションは 2026-07-22 に「shop単位プロファイル」→「アカウント単位プロファイル
#   (account-<sha256(origin+loginId)[0:24]>)」へ移行済み。移行元のshop単位ディレクトリ
#   (UUID名) と .bak-* が残骸として残り、メイン箱で 5.1GB / 18個を占めていた。
#
# 安全性の根拠:
#   worker.ts:3266 の移行ロジックは
#     if (!existsSync(userDataDir) && legacyDir && existsSync(legacyDir)) cpSync(...)
#   すなわち旧プロファイルは「アカウントプロファイルが存在しないときだけ」読まれる。
#   全アカウントが移行済み(= account- の数 ≥ 稼働アカウント数)なら二度と参照されない。
#
# ⚠️ account- で始まるディレクトリは絶対に削除しない。Akamaiの _abck 信頼を保持しており、
#    消すと全店コールドログイン → CAPTCHA/throttle の波になる。
#
# 安全ゲート:
#   1. 削除対象は「account- で始まらない」ディレクトリのみ(パターンで機械的に限定)
#   2. account- プロファイル数が MIN_ACCOUNTS 未満の箱では何もしない(移行未完の可能性)
#   3. 削除一覧は箱上の /opt/kireidot/pruned-legacy-profiles.log に追記(監査証跡)
#
# 実装メモ: 判定スクリプトは base64 で運び `docker exec -i sh -s` に流し込む。
#   SSMのJSON経由だと $VAR が箱側bashで先に展開されて壊れるため。
set -uo pipefail

REGION=ap-northeast-1
export AWS_PROFILE="${AWS_PROFILE:-kireidot-prod}"

APPLY=0
[ "${1:-}" = "--apply" ] && { APPLY=1; shift; }
MIN_ACCOUNTS="${1:-16}"

BOXES=(
  "i-0f1cc0aff1ac8dd2e:sb-worker-cloud:メイン(常時系)"
  "i-06a56736ddc6512f8:sb-worker-bulk:一括系"
  "i-0e77765c6ca7843eb:sb-worker-post:投稿系"
  "i-09e54e0b55fb8ab34:sb-worker-fallback:予備FB"
  "i-0f13227ff67fd56d8:sb-worker-fallback:予備FB2"
)

# コンテナ内で実行する判定/削除スクリプト
INNER=$(cat <<INNEREOF
R=/home/pwuser/.kireidot/salonboard-chrome-profile
MIN=${MIN_ACCOUNTS}
APPLY=${APPLY}
if [ ! -d "\$R" ]; then echo "no_profile_dir (このコンテナにプロファイル無し)"; exit 0; fi
ACC=\$(ls -1 "\$R" | grep -c '^account-' || true)
LEG=\$(ls -1 "\$R" | grep -v '^account-' | wc -l | tr -d ' ')
echo "account_profiles=\$ACC  legacy_profiles=\$LEG"
if [ "\$LEG" -eq 0 ]; then echo "nothing_to_prune"; exit 0; fi
if [ "\$ACC" -lt "\$MIN" ]; then
  echo "GATE_BLOCKED: account_profiles(\$ACC) < \$MIN — 移行未完の可能性があるため何もしない"
  exit 0
fi
echo "--- 削除対象 ---"
ls -1 "\$R" | grep -v '^account-' | while read d; do
  printf '%8s  %s\n' "\$(du -sh "\$R/\$d" 2>/dev/null | cut -f1)" "\$d"
done
echo "--- 対象合計 ---"
ls -1 "\$R" | grep -v '^account-' | sed "s|^|\$R/|" | tr '\n' '\0' | xargs -0 du -sch 2>/dev/null | tail -1
if [ "\$APPLY" -eq 1 ]; then
  echo "--- 削除実行 ---"
  ls -1 "\$R" | grep -v '^account-' > /tmp/_legacy_list
  while read d; do rm -rf "\$R/\$d"; done < /tmp/_legacy_list
  echo "deleted=\$(wc -l < /tmp/_legacy_list | tr -d ' ')"
  echo "--- 削除後 ---"
  echo "account_profiles_remaining=\$(ls -1 "\$R" | grep -c '^account-' || true)"
  echo "legacy_remaining=\$(ls -1 "\$R" | grep -v '^account-' | wc -l | tr -d ' ')"
  du -sh "\$R"
else
  echo "(ドライラン: 削除していません)"
fi
INNEREOF
)
INNER_B64=$(printf '%s' "$INNER" | base64 | tr -d '\n')

echo "モード: $([ "$APPLY" -eq 1 ] && echo '★APPLY (実削除)' || echo 'ドライラン (削除しない)')  / 最低account数=${MIN_ACCOUNTS}"

for BOX in "${BOXES[@]}"; do
  IFS=':' read -r INSTANCE_ID CONTAINER LABEL <<< "$BOX"

  PARAMS=$(python3 - "$INNER_B64" "$CONTAINER" "$APPLY" <<'PY'
import json, sys
b64, c, apply_ = sys.argv[1], sys.argv[2], sys.argv[3]
cmds = [
  "hostname",
  "echo '--- before ---'", "df -h / | tail -1",
  f"printf %s {b64} | base64 -d | docker exec -i {c} sh -s",
]
if apply_ == "1":
    cmds += [
      "echo '--- 監査証跡 ---'",
      "mkdir -p /opt/kireidot",
      f"docker exec {c} sh -c 'cat /tmp/_legacy_list 2>/dev/null' | sed 's/^/pruned /' >> /opt/kireidot/pruned-legacy-profiles.log || true",
      "tail -2 /opt/kireidot/pruned-legacy-profiles.log 2>/dev/null || true",
      "echo '--- after ---'", "df -h / | tail -1",
      f"docker ps --filter name={c} --format '{{{{.Names}}}} {{{{.Status}}}}'",
    ]
print(json.dumps({"commands": cmds}))
PY
)

  echo ""
  echo "############### ${LABEL}  ${INSTANCE_ID}"
  CMD_ID=$(aws ssm send-command --region "$REGION" --instance-ids "$INSTANCE_ID" \
    --document-name AWS-RunShellScript --timeout-seconds 600 \
    --comment "prune-legacy-chrome-profiles" \
    --parameters "$PARAMS" --query Command.CommandId --output text)
  aws ssm wait command-executed --region "$REGION" --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" >/dev/null 2>&1 || true
  aws ssm get-command-invocation --region "$REGION" --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" \
    --query '{Status:Status,Out:StandardOutputContent,Err:StandardErrorContent}' --output text
done
