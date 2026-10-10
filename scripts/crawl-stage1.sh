#!/usr/bin/env bash
# Stage-1 background worker: media inventory -> image recovery -> first publishes.
# Resumable: every step checks committed state before touching the network.
set -u
cd "$(dirname "$0")/.."
LOG=data/work/logs
mkdir -p "$LOG"
export PYTHONUNBUFFERED=1

echo "=== stage1 start $(date -u +%FT%TZ) ==="
echo "--- discover-media $(date -u +%FT%TZ)"
timeout 900 python3 -m recovery.cli discover-media >>"$LOG/discover-media.log" 2>&1
echo "discover-media rc=$? $(date -u +%FT%TZ)"

echo "--- fetch-images $(date -u +%FT%TZ)"
timeout 1800 python3 -m recovery.cli fetch-images --limit 20 >>"$LOG/fetch-images.log" 2>&1
echo "fetch-images rc=$? $(date -u +%FT%TZ)"

echo "--- publish $(date -u +%FT%TZ)"
timeout 1800 python3 -m recovery.cli publish --limit 20 >>"$LOG/publish.log" 2>&1
echo "publish rc=$? $(date -u +%FT%TZ)"

echo "=== stage1 done $(date -u +%FT%TZ) ==="
