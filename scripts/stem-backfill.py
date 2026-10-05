#!/usr/bin/env python3
"""Fold answered `cdx-stem` evidence from the missing-item ledger into the stem index.

`fetch-images --method stem` pays for one CDX prefix query per image stem, but
until now its answers only survived inside `data/missing.jsonl`: a fresh runner
loaded no `data/cdx/stems.jsonl` and asked the archive the identical question
again for every sibling URL of the same stem (a post whose `_500` and `_1280`
records share a stem costs two queries for one answer).

This reads the ledger's `cdx-stem` attempts -- same prefix, same filters, same
cutoff as `stemindex.SCOPE` -- and records the answered ones, so
`--only-stem-hits` and every later pass can answer from disk.

Only *answered* queries are folded in (`error == "ok"`): a miss is scoped
negative evidence for that exact prefix, and a hit is kept only when its capture
rows were recorded, never guessed. Anything else stays pending on purpose.

    python3 scripts/stem-backfill.py [--dry-run]
"""
from __future__ import annotations

import argparse
import collections
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from recovery import config                      # noqa: E402
from recovery.stemindex import SCOPE, StemIndex  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ledger", default=config.MISSING_JSONL)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    index = StemIndex()
    stats: collections.Counter = collections.Counter()
    for line in open(args.ledger, encoding="utf-8"):
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except Exception:
            stats["unparsable"] += 1
            continue
        for attempt in rec.get("methods") or []:
            if attempt.get("endpoint") != "cdx-stem":
                continue
            stem = attempt.get("stem")
            if not stem:
                continue
            if attempt.get("error") != "ok":
                stats["not_answered"] += 1
                continue
            if index.has(stem):
                stats["already_indexed"] += 1
                continue
            captures = attempt.get("capture_rows") or []
            if attempt.get("captures") and not captures:
                # A hit whose capture rows were never written down: recording it
                # as an empty answer would turn a known capture into a false
                # negative. Leave it pending so a live query re-asks it.
                stats["hit_without_rows"] += 1
                continue
            if not args.dry_run:
                index.record(stem, captures)
            stats["recorded"] += 1
    print(json.dumps(dict(stats, indexed=len(index.rows), dry_run=args.dry_run),
                     indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())