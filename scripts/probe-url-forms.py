#!/usr/bin/env python3
"""Bounded experiment: do alternative Tumblr CDN URL forms of one image hit?

The post pages reference `http://<NN>.media.tumblr.com/<md5-dir?>/tumblr_<slug>_<size>.<ext>`.
The archive indexes the *exact* URL, and it was crawled with several different
forms over the years:

* the `https://` spelling of the same path,
* the shared host `media.tumblr.com` with no numeric shard prefix,
* the "old" spelling with no `<md5>/` directory at all,
* the same path on a different numeric shard (Tumblr's CDN shards are a pool;
  the file keeps its `<md5>/tumblr_*` path when it moves).

`fetch-images` only ever asks about the linked URL and its size/extension
siblings, so a hit under any of these other forms is invisible to it. This
script measures whether they are worth adding to the variant plan, and writes
machine-readable evidence (one row per (image, form)) to a JSON file.

Everything is serial and rate limited; nothing here is needed by the crawler.

    python3 scripts/probe-url-forms.py --limit 6 --out data/runs/url-forms.json
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from recovery import config  # noqa: E402
from recovery.http import Fetcher, RateLimiter  # noqa: E402
from recovery.images import probe_media_capture  # noqa: E402

URL_RE = re.compile(r"^(https?)://(\d*)\.?(media\.tumblr\.com)(/.*)$", re.I)


def forms(url: str) -> list[tuple[str, str]]:
    """(label, candidate url) pairs for one linked image URL."""
    m = URL_RE.match(url or "")
    if not m:
        return []
    scheme, shard, host, path = m.group(1), m.group(2), m.group(3), m.group(4)
    parts = path.strip("/").split("/")
    bare = parts[-1]                       # tumblr_<slug>_<size>.<ext>
    has_dir = len(parts) > 1
    out = [
        ("https", f"https://{shard + '.' if shard else ''}{host}{path}"),
        ("shared-host", f"http://{host}{path}"),
        ("shared-host-https", f"https://{host}{path}"),
    ]
    if has_dir:
        out.append(("no-md5-dir", f"http://{shard + '.' if shard else ''}{host}/{bare}"))
    return out


def sample_images(limit: int, errors: tuple[str, ...]) -> list[dict]:
    rows: list[dict] = []
    for path in sorted(glob.glob(os.path.join(config.POST_DIR, "*.json"))):
        try:
            with open(path, encoding="utf-8") as fh:
                rec = json.load(fh)
        except Exception:
            continue
        for img in rec.get("images") or []:
            if img.get("sha256") or not img.get("media_url"):
                continue
            if errors and (img.get("error") or "none") not in errors:
                continue
            rows.append({"post_id": rec.get("post_id"), "media_url": img["media_url"],
                         "error": img.get("error")})
    rows.sort(key=lambda r: (str(r["post_id"]), r["media_url"]))
    return rows[:limit]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--limit", type=int, default=6, help="images to test")
    ap.add_argument("--errors", default="archive_gap,none",
                    help="comma separated image error classes to sample")
    ap.add_argument("--out", default="data/runs/url-forms.json")
    ap.add_argument("--interval", type=float, default=config.MIN_REQUEST_INTERVAL)
    args = ap.parse_args(argv)

    errors = tuple(e.strip() for e in args.errors.split(",") if e.strip())
    picked = sample_images(args.limit, errors)
    fetcher = Fetcher(limiter=RateLimiter(interval=args.interval))
    out = {
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "cutoff": config.CUTOFF,
        "interval_s": args.interval,
        "scope": f"{len(picked)} image URLs sampled from {config.POST_DIR} with error in {errors}",
        "results": [],
    }
    for row in picked:
        entry = {"post_id": row["post_id"], "media_url": row["media_url"],
                 "recorded_error": row["error"], "forms": []}
        for label, cand in forms(row["media_url"]):
            cap, attempts, _after = probe_media_capture(fetcher, cand, backsteps=1)
            last = attempts[-1] if attempts else {}
            entry["forms"].append({
                "form": label, "url": cand,
                "status": last.get("status"), "error": last.get("error"),
                "capture_timestamp": cap.timestamp if cap else None,
                "location": last.get("location", ""),
            })
            print(f"{row['post_id']} {label:18s} {cand} -> "
                  f"{last.get('status')} {last.get('error')} "
                  f"{cap.timestamp if cap else ''}", flush=True)
            if cap:
                break                      # stop spending requests on this image
        out["results"].append(entry)
    out["finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    hits = sum(1 for r in out["results"]
               if any(f["capture_timestamp"] for f in r["forms"]))
    out["images_with_a_hit"] = hits
    out["images_tested"] = len(out["results"])
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=1)
    print(json.dumps({"tested": out["images_tested"], "with_hit": hits, "out": args.out}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
