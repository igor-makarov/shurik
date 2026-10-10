#!/usr/bin/env python3
"""Run the Availability-API sweep over unresolved image URLs, hit-likely first.

Every confirmed pre-cutoff `hit` this sweep produces is a URL that
`fetch-images --method availability` can actually replay into bytes, so the
sweep is the cheapest way to turn the untouched queue into real images
(iteration 4-63: 6 of 7 hits in data/cdx/avail.jsonl replayed into images).

Two differences from `python3 -m recovery.cli probe-availability`:

* ordering -- media hosts that already produced a `hit` are swept first, so a
  bounded foreground slice spends its requests where captures actually exist;
* a slice -- `--limit` and the timeout bound the run, and the index is flushed
  incrementally, so an interrupted slice keeps every verdict it decided.

The candidates themselves, the probing and the persistence all come from the
crawler (`recovery.cli._image_candidates`, `recovery.availability.sweep`).
"""
from __future__ import annotations

import argparse
import collections
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from recovery.availability import AvailabilityIndex, HIT, sweep
from recovery.cli import _image_candidates, capture_file
from recovery.http import Fetcher
from recovery.store import PostStore


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--concurrency", type=int, default=4)
    ap.add_argument("--min-interval", type=float, default=0.5)
    ap.add_argument("--with-variants", action="store_true")
    ap.add_argument("--retry-transient", action="store_true")
    args = ap.parse_args()

    os.environ.setdefault("SHURIK_MIN_INTERVAL", str(args.min_interval))

    store = PostStore()
    urls = _image_candidates(store, include_variants=args.with_variants)
    index = AvailabilityIndex(capture_file("avail.jsonl"))

    # Hosts that have already yielded a pre-cutoff capture come first; the rest
    # keep their original order so the sweep stays resumable and fair.
    good = {r["url"].split("/")[0] for r in index.rows.values() if r.get("verdict") == HIT}
    urls.sort(key=lambda u: 0 if u.split("/")[2] in good else 1)

    def progress(stats: dict) -> None:
        sys.stderr.write(f"[avail] {stats['done']}/{stats['total']} {stats}\n")
        sys.stderr.flush()

    out = sweep(Fetcher(), urls, limit=args.limit, concurrency=args.concurrency,
                index=index, retry_transient=args.retry_transient, progress=progress)
    print(json.dumps(out, indent=1, sort_keys=True))

    # Report the freshly confirmed hits straight away so the next step (replay
    # them into bytes) does not have to re-read the inventory to find them.
    new_hits = [r for r in index.rows.values() if r.get("verdict") == HIT]
    hosts = collections.Counter(r["url"].split("/")[0] for r in new_hits)
    sys.stderr.write(f"[avail] total hits now {len(new_hits)} by host {dict(hosts)}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())