#!/usr/bin/env bash
# Archive-light daemon: publish (registry only) interleaved with small
# fetch-posts batches. Used while image probing is in flight, because the
# earlier crawl-daemon.sh plus ad-hoc probes produced HTTP 429 / refused
# connections on the media hosts.
set -u
cd "$(dirname "$0")/.."
export PYTHONUNBUFFERED=1
LOG=data/work/logs
mkdir -p "$LOG"
BATCH="${SHURIK_BATCH:-25}"
echo "=== crawl-safe start $(date -u +%FT%TZ) batch=$BATCH"
while true; do
  timeout 1800 python3 -m recovery.cli publish --limit "$BATCH" >>"$LOG/publish-safe.log" 2>&1
  echo "publish rc=$? $(date -u +%FT%TZ)"
  timeout 1800 python3 -m recovery.cli fetch-posts --limit "$BATCH" --concurrency 2 >>"$LOG/fetch-posts-safe.log" 2>&1
  echo "fetch-posts rc=$? $(date -u +%FT%TZ)"
  timeout 600 python3 -m recovery.cli status > data/work/status-latest.txt 2>&1
  cat data/work/status-latest.txt | tr -d '\n' | tail -c 500; echo
  if [ "${SHURIK_ONCE:-0}" = "1" ]; then echo "=== single pass done"; break; fi
  sleep 3
done
