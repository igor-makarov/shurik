#!/usr/bin/env python3
"""Recover post images whose bytes the archive holds on a *different* CDN shard.

Why this exists
---------------
The Wayback Machine crawls a post page at time T and the page's ``<img>`` points
at the Tumblr CDN shard that was live at T. Our post record keeps the
``media_url`` parsed from *one* capture, so its stem-prefix CDX query only ever
covers that single host. A 2018 crawl of the same post points at
``66/78.media.tumblr.com`` where the archive may hold the bytes, while the
2013-era host our record names answers empty.

Measured 2026-10-07: 3 of 12 modern-shard variants of missing images answered a
capture -- including post 180550090138's missing 64-shard photo, found on 66.

What it does
------------
For the missing images of posts whose captured era makes a modern shard
plausible it builds the shard-variant URL (same path, different host), asks the
CDX for that stem (recording the answer in the durable ``StemIndex``), and for a
hit runs the normal ``resolve_image`` path: replay the capture, validate the
image signature, store the blob. Recovered bytes are appended to the post record
as a new image with ``via="shard-variant"`` provenance; identical bytes already
held by the post are dropped so the ledger does not gain same-byte aliases.

Publishing stays in ``recovery.cli publish`` / ``fetch-images``.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from recovery import config  # noqa: E402
from recovery.cdx import cdx_query  # noqa: E402
from recovery.http import Fetcher  # noqa: E402
from recovery.images import resolve_image, stem_prefix  # noqa: E402
from recovery.stemindex import SCOPE as STEM_SCOPE, StemIndex  # noqa: E402
from recovery.store import JsonlStore, PostStore, ledger_entry  # noqa: E402

# Modern shards the archive crawled the blog's pages against in 2016-2019.
MODERN_SHARDS = ("66.media.tumblr.com", "78.media.tumblr.com",
                 "67.media.tumblr.com", "68.media.tumblr.com",
                 "65.media.tumblr.com", "64.media.tumblr.com")
HOST_RE = re.compile(r"^https?://([^/]+)(/.*)$")


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def shard_variants(url: str, shards=MODERN_SHARDS) -> list[str]:
    """Same media path on other modern shards (scheme canonicalised to http)."""
    m = HOST_RE.match(url or "")
    if not m:
        return []
    host, path = m.group(1).lower(), m.group(2)
    if not host.endswith(".media.tumblr.com"):
        return []
    return [f"http://{h}{path}" for h in shards if h != host]


def capture_years(post: dict) -> set[str]:
    years = set()
    for cap in post.get("captures") or []:
        ts = str(cap.get("timestamp") or "")
        if len(ts) >= 4 and ts[:4].isdigit():
            years.add(ts[:4])
    ts = str(post.get("capture_timestamp") or "")
    if len(ts) >= 4 and ts[:4].isdigit():
        years.add(ts[:4])
    return years


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--years", default="2018,2019",
                    help="only posts with a capture in one of these years (comma separated)")
    ap.add_argument("--shards", default=",".join(MODERN_SHARDS))
    ap.add_argument("--limit-posts", type=int, default=0, help="0 = all eligible")
    ap.add_argument("--max-hits", type=int, default=0, help="stop after N recovered images")
    ap.add_argument("--concurrency", type=int, default=config.DEFAULT_CONCURRENCY)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--ids", default="", help="comma separated post ids")
    args = ap.parse_args()

    years = {y.strip() for y in args.years.split(",") if y.strip()}
    shards = tuple(s.strip() for s in args.shards.split(",") if s.strip())
    wanted_ids = {p.strip() for p in args.ids.split(",") if p.strip()}

    store = PostStore()
    index = StemIndex()
    fetcher = Fetcher(limiter=None)
    ledger = JsonlStore(config.MISSING_JSONL, key_fields=("kind", "key"))

    posts = []
    for rec in store.all():
        pid = rec.get("post_id")
        if not pid or (wanted_ids and pid not in wanted_ids):
            continue
        if not years or (capture_years(rec) & years):
            posts.append(rec)
    posts.sort(key=lambda r: int(r["post_id"]))
    if args.limit_posts:
        posts = posts[: args.limit_posts]

    stats = {"posts": len(posts), "candidates": 0, "stems_asked": 0, "stem_hits": 0,
             "recovered": 0, "duplicate_bytes": 0, "errors": 0, "requests": 0}
    recovered_posts: set[str] = set()

    for rec in posts:
        pid = rec["post_id"]
        images = list(rec.get("images") or [])
        held = {img.get("media_url") for img in images if img.get("media_url")}
        held_hashes = {img.get("sha256") for img in images if img.get("sha256")}
        added: list[dict] = []
        for img in list(images):
            url = img.get("media_url") or ""
            if not url or img.get("sha256"):
                continue
            for variant in shard_variants(url, shards):
                if variant in held:
                    continue
                held.add(variant)
                stem = stem_prefix(variant)
                if not stem:
                    continue
                stats["candidates"] += 1
                if not index.has(stem):
                    stats["stems_asked"] += 1
                    stats["requests"] += 1
                    if args.dry_run:
                        continue
                    if fetcher.blocked:
                        print(json.dumps({"note": "circuit breaker open; stopping",
                                          "sent": stats["requests"], **stats}))
                        _finish(store, rec, images, added, pid, stats)
                        return 0
                    caps, resp = cdx_query(
                        fetcher, stem, match="prefix", limit=8,
                        extra={"filter": STEM_SCOPE["filter"],
                               "collapse": STEM_SCOPE["collapse"]})
                    if not resp.ok:
                        stats["errors"] += 1
                        continue
                    caps = [c for c in caps if c.statuscode == "200"]
                    index.record(stem, caps)
                caps = index.lookup(stem) or []
                if not caps:
                    continue
                stats["stem_hits"] += 1
                if args.dry_run:
                    print(json.dumps({"post_id": pid, "variant": variant,
                                      "captures": [c.timestamp + " " + c.original for c in caps]}))
                    continue
                resolved = resolve_image(fetcher, {"media_url": variant,
                                                   "found_in": "shard-variant",
                                                   "caption_alt": img.get("caption") or ""},
                                         method="stem", stem_index=index)
                if resolved.get("state") != "recovered":
                    stats["errors"] += 1
                    ledger.append([ledger_entry(
                        "image", variant, resolved.get("error") or "unknown",
                        resolved.get("attempts", []),
                        {"post_id": pid, "state": resolved.get("state"),
                         "note": resolved.get("note", ""), "via": "shard-variant",
                         "shard_variant_of": url})])
                    continue
                if resolved.get("sha256") in held_hashes:
                    stats["duplicate_bytes"] += 1
                    continue
                held_hashes.add(resolved.get("sha256"))
                resolved["via"] = "shard-variant"
                resolved["shard_variant_of"] = url
                resolved["discovered_at"] = _now()
                added.append(resolved)
                stats["recovered"] += 1
                recovered_posts.add(pid)
                if args.max_hits and stats["recovered"] >= args.max_hits:
                    _finish(store, rec, images, added, pid, stats)
                    print(json.dumps(stats, indent=1, sort_keys=True))
                    return 0
        _finish(store, rec, images, added, pid, stats)

    print(json.dumps(stats, indent=1, sort_keys=True))
    print("recovered posts:", sorted(recovered_posts, key=int))
    return 0


def _finish(store: PostStore, rec: dict, images: list, added: list, pid: str,
            stats: dict) -> None:
    if not added:
        return
    updated = dict(rec)
    updated["images"] = images + added
    updated["images_done"] = False
    updated["fetched_at"] = _now()
    store.put(pid, updated)
    stats.setdefault("written_posts", [])
    stats["written_posts"].append(pid)


if __name__ == "__main__":
    raise SystemExit(main())
