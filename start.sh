#!/usr/bin/env bash
# 顧客ボイスを起動する: VOICEVOX 確認 → サーバ起動 → Chrome で開く
set -euo pipefail
cd "$(dirname "$0")"
PORT="${CV_PORT:-4780}"
VV="${CV_VOICEVOX_URL:-http://127.0.0.1:50021}"

if ! curl -sf -m 2 "$VV/version" >/dev/null; then
  echo "VOICEVOX を起動します…"
  open -g -a VOICEVOX
  for _ in $(seq 1 60); do
    curl -sf -m 2 "$VV/version" >/dev/null && break
    sleep 1
  done
fi
if curl -sf -m 2 "$VV/version" >/dev/null; then
  echo "VOICEVOX $(curl -s "$VV/version") OK"
else
  echo "警告: VOICEVOX に繋がりません。読み上げ以外は使えます。" >&2
fi

if curl -sf -m 2 "http://127.0.0.1:$PORT/api/personas" >/dev/null; then
  echo "サーバはすでに起動しています"
else
  node server.mjs &
  SERVER_PID=$!
  trap 'kill $SERVER_PID 2>/dev/null' EXIT INT TERM
  for _ in $(seq 1 20); do
    curl -sf -m 1 "http://127.0.0.1:$PORT/api/personas" >/dev/null && break
    sleep 0.3
  done
fi

open -a "Google Chrome" "http://localhost:$PORT/"
[[ -n "${SERVER_PID:-}" ]] && wait "$SERVER_PID"
