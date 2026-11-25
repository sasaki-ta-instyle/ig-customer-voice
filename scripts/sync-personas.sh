#!/usr/bin/env bash
# customer-panel 同梱の共有ペルソナ（チーム配布物）をチーム版サーバに配る。
# 共有ペルソナを更新したら実行する。自分用（_outputs）は送らない（クライアント名が入りうるため）。
set -euo pipefail
SRC="${CV_PERSONA_DIR:-$HOME/.claude/skills/customer-panel/personas}"
DEST=/var/www/mb/ig-customer-voice/shared/personas
[ -f "$SRC/_schema.md" ] || { echo "共有ペルソナが見つかりません: $SRC" >&2; exit 1; }
ssh conoha-deploy "mkdir -p $DEST/shared $DEST/own"
rsync -av --delete --include='*.md' --exclude='*' "$SRC/" "conoha-deploy:$DEST/shared/"
