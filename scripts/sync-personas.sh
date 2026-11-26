#!/usr/bin/env bash
# チーム版サーバにペルソナを配る。どちらかを更新したら実行する。
#   shared/ … customer-panel 同梱の共有ペルソナ（チーム配布物）
#   brand/  … 自分用（_outputs）のうち、先頭の設定に group: がある「ブランド顧客」（例: メビウス製薬の顧客）だけ。
#             正本はこの Mac の自分用。チーム版では読むだけ（直すのはローカルで → このスクリプトで配り直す）
# group の無い自分用ペルソナは送らない（他のクライアント名が入りうるため）。
set -euo pipefail
SRC="${CV_PERSONA_DIR:-$HOME/.claude/skills/customer-panel/personas}"
OWN="${CV_OWN_PERSONA_DIR:-$HOME/Workspace/_outputs/customer-panel/personas}"
DEST=/var/www/mb/ig-customer-voice/shared/personas
[ -f "$SRC/_schema.md" ] || { echo "共有ペルソナが見つかりません: $SRC" >&2; exit 1; }

# 先頭の --- 内に group: がある md だけを集める
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
for f in "$OWN"/*.md; do
  [ -e "$f" ] || continue
  if awk 'NR==1 && $0!="---" {exit 1} NR>1 && $0=="---" {exit 1} /^group:[[:space:]]*[^[:space:]]/ {found=1; exit 0} END {exit !found}' "$f"; then
    cp "$f" "$STAGE/"
  fi
done
echo "ブランド顧客: $(ls "$STAGE" | wc -l | tr -d ' ') 人 ($(ls "$STAGE" | tr '\n' ' '))"

ssh conoha-deploy "mkdir -p $DEST/shared $DEST/own $DEST/brand"
rsync -av --delete --include='*.md' --exclude='*' "$SRC/" "conoha-deploy:$DEST/shared/"
rsync -av --delete --include='*.md' --exclude='*' "$STAGE/" "conoha-deploy:$DEST/brand/"
