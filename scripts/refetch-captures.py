#!/usr/bin/env python3
"""Replay never-parsed post captures and merge the images they reference.

The stored post record keeps only the *best* single capture's content, and
`fetch-posts` marks every known capture as "have" after the first fetch, so the
other captures of a post (its photoset iframe, its AMP page, its older permalink
snapshots) are never parsed.  A photoset iframe in particular lists *every*
photo of a photoset, on whatever CDN shard/URL form the archive captured, while
the permalink page may show only the first photo.  Those extra photos are real
new image identities the per-image path has never queried.

This command replays the un-parsed captures of posts that still have unresolved
images, re-runs the *current* parser over each, and merges any media key the
record does not already hold (new keys become unresolved images; new URL forms
of a known key are merged as `url_forms`).  It records the parsed timestamps in
`refetched_captures` so a later run does not repeat them.  Offline until the
replay request; the archive is asked one capture at a time.
"""
from __future__ import annotations

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from recovery.cdx import CaptureIndex  # noqa: E402
from recovery.cli import _kind, capture_file, post_captures  # noqa: E402
from recovery.http import Fetcher  # noqa: E402
from recovery.parsing import media_key, parse_post_page  # noqa: E402
from recovery.store import PostStore  # noqa: E402


def _parsed_timestamps(rec: dict) -> set[str]:
    done: set[str] = set(rec.get("refetched_captures") or [])
    used = rec.get("capture_timestamp")
    if used:
        done.add(used)
    for m in rec.get("methods") or []:
        if m.get("endpoint") == "replay id_" and m.get("status") == 200 and m.get("bytes"):
            ts = m.get("capture_timestamp")
            if ts:
                done.add(ts)
    return done


def merge_by_key(rec: dict, new_images: list[dict]) -> tuple[list[dict], int, int]:
    """Union images by media key: new keys added, new forms merged."""
    images = [dict(i) for i in (rec.get("images") or [])]
    by_key = {i.get("media_key"): i for i in images if i.get("media_key")}
    added = merged = 0
    for img in new_images:
        key = img.get("media_key")
        if not key:
            continue
        have = by_key.get(key)
        if have is None:
            entry = dict(img)
            entry.setdefault("state", "unresolved")
            entry["attempts"] = entry.get("attempts") or []
            images.append(entry)
            by_key[key] = entry
            added += 1
        else:
            forms = have.setdefault("url_forms", [have.get("media_url", "")])
            for form in [img.get("media_url", "")] + list(img.get("url_forms") or []):
                if form and form not in forms:
                    forms.append(form)
                    merged += 1
    return images, added, merged


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ids", default="", help="comma separated post ids; default = every eligible post")
    ap.add_argument("--kinds", default="photoset,amp,other")
    ap.add_argument("--limit", type=int, default=0, help="max captures this pass (0 = all)")
    ap.add_argument("--max-per-post", type=int, default=2)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    kinds = {k.strip() for k in args.kinds.split(",") if k.strip()}
    wanted = {i.strip() for i in args.ids.split(",") if i.strip()}
    store = PostStore()
    index = CaptureIndex(capture_file("posts.jsonl"))
    grouped = post_captures(index)

    plan: list[tuple[str, object]] = []
    for pid in store.ids():
        if wanted and pid not in wanted:
            continue
    # A post with every referenced image already recovered has nothing left to
    # learn from its other captures -- but a post with *zero* images (text
    # post or a permalink parse that found no media) must NOT be skipped: its
    # photoset_iframe/amp captures can still reference photos the permalink
    # never showed (post 15193982461 is the concrete case: an unparsed
    # photoset_iframe capture whose stem was never CDX-queried).
    rec = store.get(pid)
    images = rec.get("images") or []
    if images and all(im.get("sha256") for im in images):
        continue
        done = _parsed_timestamps(rec)
        caps = [c for c in grouped.get(pid, [])
                if _kind(c) in kinds and c.timestamp not in done]
        caps.sort(key=lambda c: c.timestamp)
        for cap in caps[: max(1, args.max_per_post)]:
            plan.append((pid, cap))
    if args.limit:
        plan = plan[: args.limit]

    out = {"posts_with_plan": len({p for p, _ in plan}), "planned": len(plan),
           "fetched": 0, "parsed": 0, "images_added": 0, "forms_merged": 0,
           "posts_changed": 0, "failed": 0, "dry_run": args.dry_run}
    if args.dry_run:
        out["plan"] = [{"post_id": p, "capture": c.timestamp, "kind": _kind(c),
                        "url": c.original} for p, c in plan[:40]]
        print(json.dumps(out, indent=1, sort_keys=True))
        return 0

    fetcher = Fetcher()
    changed: set[str] = set()
    for pid, cap in plan:
        resp = fetcher.replay(cap.timestamp, cap.original, mode="id_")
        out["fetched"] += 1
        attempt = {"url": cap.original, "endpoint": "replay id_", "kind": _kind(cap),
                   "capture_timestamp": cap.timestamp, "status": resp.status,
                   "error": resp.error, "message": resp.message,
                   "bytes": len(resp.body or b"")}
        prior = store.get(pid)
        methods = list(prior.get("methods") or []) + [attempt]
        if not resp.ok or not resp.body:
            out["failed"] += 1
            store.put(pid, {"methods": methods})
            continue
        ctype = resp.headers.get("content-type", "")
        if "html" not in ctype and ctype:
            out["failed"] += 1
            store.put(pid, {"methods": methods})
            continue
        rec = parse_post_page(resp.text(), cap.original, cap.timestamp, resp.url)
        images, added, merged = merge_by_key(prior, rec.get("images") or [])
        out["parsed"] += 1
        out["images_added"] += added
        out["forms_merged"] += merged
        refetched = list(dict.fromkeys(list(prior.get("refetched_captures") or []) + [cap.timestamp]))
        patch = {"methods": methods, "refetched_captures": refetched}
        if added or merged:
            patch["images"] = images
        store.put(pid, patch)
        if added or merged:
            changed.add(pid)
    out["posts_changed"] = len(changed)
    print(json.dumps(out, indent=1, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
