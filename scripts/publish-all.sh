#!/bin/sh
# Idempotent, resumable GHCR publisher. GHCR-only: never touches web.archive.org,
# so it may run concurrently with archive-bound crawl stages.
cd "$(dirname "$0")/.." || exit 1
LOG=data/work/publish-all.log
: > "$LOG"
for i in $(seq 1 40); do
  python3 -m recovery.cli publish --limit 10 >>"$LOG" 2>&1
  n=$(python3 - <<'PY'
import json,glob,os
pub=set()
for l in open('data/published.jsonl'):
    l=l.strip()
    if l:
        try: pub.add(json.loads(l)['tag'])
        except Exception: pass
posts={os.path.basename(f)[:-5] for f in glob.glob('data/posts/*.json')}
print(len(pub & posts), len(posts))
PY
)
  echo "round $i published/parsed: $n" >>"$LOG"
  case "$n" in
    */*) : ;;
  esac
  P=$(echo "$n" | cut -d' ' -f1); T=$(echo "$n" | cut -d' ' -f2)
  [ "$P" -ge "$T" ] && { echo "DONE all $T published" >>"$LOG"; break; }
done
echo "publisher exit" >>"$LOG"
