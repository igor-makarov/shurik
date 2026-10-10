#!/usr/bin/env bash
# Lean recovery daemon for the current iteration budget.
#
# crawl-daemon.sh also runs `discover-media`, which issues one whole-domain CDX
# query per tumblr media host. Those queries answer in 5 s for some hosts and
# 504 after 60 s for others, and they are pure overhead now that the cheap
# replay-probe method in images.py answers the same question per URL in ~0.5 s.
# So this script keeps the same resumable order (pages -> publish -> images)
# and drops the host sweep.
set -u
cd "$(dirname "$0")/.."
LOG=data/work/logs
mkdir -p "$LOG"
export PYTHONUNBUFFERED=1

BATCH="${SHURIK_BATCH:-60}"
CONC="${SHURIK_CONC:-2}"

echo "=== focus daemon start $(date -u +%FT%TZ) batch=$BATCH conc=$CONC ==="

while true; do
  echo "--- fetch-posts $(date -u +%FT%TZ)"
  timeout 2400 python3 -m recovery.cli fetch-posts --limit "$BATCH" --concurrency "$CONC" \
      >>"$LOG/fetch-posts.log" 2>&1
  echo "fetch-posts rc=$? $(date -u +%FT%TZ)"

  echo "--- publish $(date -u +%FT%TZ)"
  timeout 1800 python3 -m recovery.cli publish --limit "$BATCH" >>"$LOG/publish.log" 2>&1
  echo "publish rc=$? $(date -u +%FT%TZ)"

  echo "--- fetch-images $(date -u +%FT%TZ)"
  timeout 2400 python3 -m recovery.cli fetch-images --limit "$BATCH" --concurrency "$CONC" \
      >>"$LOG/fetch-images.log" 2>&1
  echo "fetch-images rc=$? $(date -u +%FT%TZ)"

  echo "--- publish (post-image delta) $(date -u +%FT%TZ)"
  timeout 1200 python3 -m recovery.cli publish --limit "$BATCH" >>"$LOG/publish.log" 2>&1
  echo "publish rc=$? $(date -u +%FT%TZ)"

  echo "--- status $(date -u +%FT%TZ)"
  timeout 300 python3 -m recovery.cli status 2>&1 | tr -d '\n' | tail -c 700
  echo

  if [ "${SHURIK_ONCE:-0}" = "1" ]; then
    echo "=== focus daemon single pass done $(date -u +%FT%TZ) ==="
    break
  fi
  sleep 5
done