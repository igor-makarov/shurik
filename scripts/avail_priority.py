"""Bounded Availability-API sweep over unresolved post image URLs.

Same code path as `python -m recovery.cli probe-availability`
(recovery.availability.availability_sweep), but the candidate list is ordered by
how much pre-cutoff evidence the post's era already has, and the run is bounded
so a fresh runner can repeat it incrementally.  Every verdict is flushed into
data/cdx/avail.jsonl, the same committed inventory `fetch-images
--method availability` reads.

Usage:
    python3 scripts/avail_priority.py --limit 300 --concurrency 4
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from recovery import config  # noqa: E402
from recovery.availability import AvailabilityIndex, sweep as availability_sweep  # noqa: E402
from recovery.cdx import normalize_url  # noqa: E402
from recovery.http import Fetcher  # noqa: E402
from recovery.images import _variants  # noqa: E402

# Posts whose era already produced pre-cutoff media captures.  Every hit in
# data/cdx/avail.jsonl belongs to a 2014-2015 tumblr post, so those decades are
# swept first instead of the (much larger) modern backlog.
ERA_PRIORITY = ("10", "12", "13", "14", "15", "16", "11")


def candidate_urls(include_variants: bool) -> list[str]:
    index = AvailabilityIndex(os.path.join(config.CDX_DIR, "avail.jsonl"))
    posts = []
    for path in sorted(glob.glob(os.path.join(config.POST_DIR, "*.json"))):
        with open(path, "r", encoding="utf-8") as fh:
            posts.append(json.load(fh))

    def era(rec: dict) -> int:
        pid = str(rec.get("post_id") or "")
        return ERA_PRIORITY.index(pid[:2]) if pid[:2] in ERA_PRIORITY else len(ERA_PRIORITY)

    posts.sort(key=lambda r: (era(r), str(r.get("post_id"))))
    urls: list[str] = []
    seen: set[str] = set()
    for rec in posts:
        for img in rec.get("images") or []:
            if img.get("sha256"):
                continue
            media_url = img.get("media_url")
            if not media_url:
                continue
            for cand in [media_url] + (_variants(media_url) if include_variants else []):
                key = normalize_url(cand)
                if key and key not in seen:
                    seen.add(key)
                    urls.append(cand)
    return urls


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=300)
    ap.add_argument("--concurrency", type=int, default=4)
    ap.add_argument("--no-variants", action="store_true")
    ap.add_argument("--retry-transient", action="store_true")
    args = ap.parse_args()

    index = AvailabilityIndex(os.path.join(config.CDX_DIR, "avail.jsonl"))
    urls = candidate_urls(include_variants=not args.no_variants)
    fetcher = Fetcher()

    def progress(stats: dict) -> None:
        sys.stderr.write(f"[avail-priority] {stats}\n")
        sys.stderr.flush()

    out = availability_sweep(fetcher, urls, limit=args.limit,
                             concurrency=args.concurrency, index=index,
                             retry_transient=args.retry_transient, progress=progress)
    print(json.dumps(out, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())