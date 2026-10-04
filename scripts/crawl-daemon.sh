#!/usr/bin/env bash
# Long-running recovery daemon: pages -> images -> publish, in that order.
#
# Every step is resumable from committed state (data/cdx, data/posts, blobs,
# published.jsonl), so killing and restarting this script never loses work and
# never re-downloads a post that is already parsed. Steps run sequentially on
# purpose: fetch-posts, fetch-images and publish all rewrite data/posts/*.json
# and concurrent writers would lose each other's bookkeeping.
set -u
cd "$(dirname "$0")/.."
LOG=data/work/logs
mkdir -p "$LOG"
export PYTHONUNBUFFERED=1

BATCH="${SHURIK_BATCH:-40}"
CONC="${SHURIK_CONC:-2}"

echo "=== daemon start $(date -u +%FT%TZ) batch=$BATCH conc=$CONC ==="

# Gaps recorded before the variant sweep existed (see RECOVERY_STATUS.md) were
# decided from a single CDX query. Re-open them once so the ledger's newest
# entry for a key always reflects the strongest evidence we have.
if [ "${SHURIK_RETRY_GAPS:-0}" = "1" ]; then
  echo "--- fetch-images --retry-missing $(date -u +%FT%TZ)"
  timeout 3000 python3 -m recovery.cli fetch-images --limit 200 --concurrency "$CONC" \
      --retry-missing >>"$LOG/fetch-images-retry.log" 2>&1
  echo "fetch-images-retry rc=$? $(date -u +%FT%TZ)"
fi
while true; do
  echo "--- fetch-posts $(date -u +%FT%TZ)"
  timeout 3000 python3 -m recovery.cli fetch-posts --limit "$BATCH" --concurrency "$CONC" \
      >>"$LOG/fetch-posts.log" 2>&1
  rc=$?
  echo "fetch-posts rc=$rc $(date -u +%FT%TZ)"
  tail -c 400 "$LOG/fetch-posts.log" | tr -d '\n' | tail -c 400
  echo

  echo "--- discover-media $(date -u +%FT%TZ)"
  timeout 1200 python3 -m recovery.cli discover-media >>"$LOG/discover-media.log" 2>&1
  echo "discover-media rc=$? $(date -u +%FT%TZ)"

  echo "--- fetch-images $(date -u +%FT%TZ)"
  timeout 3000 python3 -m recovery.cli fetch-images --limit "$BATCH" --concurrency "$CONC" \
      >>"$LOG/fetch-images.log" 2>&1
  echo "fetch-images rc=$? $(date -u +%FT%TZ)"

  echo "--- publish $(date -u +%FT%TZ)"
  timeout 1800 python3 -m recovery.cli publish --limit "$BATCH" >>"$LOG/publish.log" 2>&1
  echo "publish rc=$? $(date -u +%FT%TZ)"

  echo "--- status $(date -u +%FT%TZ)"
  timeout 300 python3 -m recovery.cli status 2>&1 | tr -d '\n' | tail -c 600
  echo

  if [ "${SHURIK_ONCE:-0}" = "1" ]; then
    echo "=== daemon single pass done $(date -u +%FT%TZ) ==="
    break
  fi
  sleep 5
done
