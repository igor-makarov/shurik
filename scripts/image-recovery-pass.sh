#!/usr/bin/env bash
# One image-recovery pass, in the order that turns inventory into published
# bytes: media host inventory -> image bytes -> per-post OCI push.
#
# Separate from crawl-daemon.sh because image recovery is the critical path
# right now (see RECOVERY_STATUS.md): the hosts that carry most of this blog's
# images were never inventoried, so every image is still "unknown" rather than
# "confirmed gap". An iteration has a bounded budget, and this pass spends it on
# the archive only, serially -- overlapping archive traffic with probes is what
# produced HTTP 429 and "Connection refused" in earlier iterations.
#
# Every stage is resumable from committed state, so killing this script is safe.
set -u
cd "$(dirname "$0")/.."
LOG=data/work/logs
mkdir -p "$LOG"
export PYTHONUNBUFFERED=1

BATCH="${SHURIK_BATCH:-60}"
CONC="${SHURIK_CONCURRENCY:-2}"
HOSTS="${SHURIK_MEDIA_HOSTS:-}"
HOST_ARGS=""
[ -n "$HOSTS" ] && HOST_ARGS="--hosts $HOSTS"

echo "=== image pass start $(date -u +%FT%TZ) batch=$BATCH conc=$CONC hosts=${HOSTS:-auto} ==="

echo "--- discover-media $(date -u +%FT%TZ)"
timeout 1800 python3 -m recovery.cli discover-media $HOST_ARGS --page-size 2000 \
    --max-pages "${SHURIK_MAX_PAGES:-40}" >>"$LOG/discover-media.log" 2>&1
echo "discover-media rc=$? $(date -u +%FT%TZ)"

echo "--- fetch-images $(date -u +%FT%TZ)"
timeout 2400 python3 -m recovery.cli fetch-images --limit "$BATCH" --concurrency "$CONC" \
    --retry-missing >>"$LOG/fetch-images.log" 2>&1
echo "fetch-images rc=$? $(date -u +%FT%TZ)"

echo "--- publish $(date -u +%FT%TZ)"
timeout 1800 python3 -m recovery.cli publish --limit "$BATCH" >>"$LOG/publish.log" 2>&1
echo "publish rc=$? $(date -u +%FT%TZ)"

echo "--- status $(date -u +%FT%TZ)"
timeout 300 python3 -m recovery.cli status 2>&1 | tr -d '\n' | tail -c 700
echo
echo "=== image pass done $(date -u +%FT%TZ) ==="