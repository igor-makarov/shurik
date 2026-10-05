#!/usr/bin/env bash
# Post-recovery loop: archived post pages -> OCI artifacts -> GHCR.
#
# Split out of crawl-daemon.sh because the media inventory is a separate,
# archive-bound step that must not run concurrently with page downloads.
# Everything is resumable: fetch-posts skips parsed posts, publish skips
# already published post ids.
set -u
cd "$(dirname "$0")/.."
LOG=data/work/logs
mkdir -p "$LOG"
export PYTHONUNBUFFERED=1

BATCH="${SHURIK_BATCH:-40}"
CONC="${SHURIK_CONC:-1}"
DEADLINE="${SHURIK_DEADLINE:-2700}"   # seconds this runner should stay on the archive

start=$(date +%s)
echo "=== posts daemon start $(date -u +%FT%TZ) batch=$BATCH conc=$CONC ==="
while true; do
  now=$(date +%s); [ $((now-start)) -ge "$DEADLINE" ] && { echo "=== deadline reached ==="; break; }
  timeout 900 python3 -m recovery.cli fetch-posts --limit "$BATCH" --concurrency "$CONC" \
      >>"$LOG/fetch-posts.log" 2>&1
  echo "fetch-posts rc=$? $(date -u +%FT%TZ)"
  timeout 600 python3 -m recovery.cli publish --limit 60 >>"$LOG/publish.log" 2>&1
  echo "publish rc=$? $(date -u +%FT%TZ)"
  sleep 3
done
python3 -m recovery.cli status | tr -d '\n' | tail -c 700
echo
