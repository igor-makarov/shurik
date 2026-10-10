#!/usr/bin/env python3
"""Can one CDX query see a photo under *any* Tumblr media shard?

Tumblr serves one photo from many `NN.media.tumblr.com` shards using the same
`<hash>/<name>` path, so the archive may hold the picture under a shard other
than the one the post HTML referenced. A per-host prefix query cannot see that,
and a host dump of `NN.media.tumblr.com` is not a usable inventory either (the
archive's own notes warn the shard lists are incomplete).

This probe asks the CDX index directly whether it accepts a host-wildcard
prefix, which would collapse "same photo, other shard" into one query per
photo. It also replays a known-good control so a run that cannot reach the
index is told apart from a candidate that genuinely has no capture.

Usage: wildcard-host-probe.py [candidate-url ...]
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from recovery.cdx import cdx_query  # noqa: E402
from recovery.http import Fetcher  # noqa: E402

EXTRA = {"filter": "statuscode:200", "collapse": "urlkey", "limit": "50"}

# Known-good control: pre-cutoff capture exists (post 136316699428).
CONTROL = "http://40.media.tumblr.com/acd66e1322aeb10e0ec13ae1659eae09/tumblr_o07sizvpqP1r3it8zo1"

SHARDS = ["24", "25", "26", "28", "29", "30", "31", "33", "36", "38",
          "40", "41", "64", "65", "66", "67", "68", "78"]


def strip(url):
    u = url.split("://", 1)[-1]
    host, _, path = u.partition("/")
    shard = host.split(".", 1)[0]
    base = path.rsplit("/", 1)[-1]
    low = base.lower()
    for e in (".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp"):
        if low.endswith(e):
            base = base[: -len(e)]
            break
    for s in ("_1280", "_1024", "_540", "_500", "_400", "_250", "_128", "_64", "_100", "_r1"):
        if base.lower().endswith(s):
            base = base[: -len(s)]
            break
    # Old-style media URLs carry no `<hash>/` directory; a leading slash would
    # silently turn every wildcard query into a miss.
    directory = path.rsplit("/", 1)[0] if "/" in path else ""
    return shard, f"{directory}/{base}" if directory else base


def show(label, caps, resp):
    print(f"[{label}] status={resp.status} error={resp.error} rows={resp.cdx_rows} "
          f"caps={len(caps)} msg={resp.message[:120]!r}")
    for c in caps[:4]:
        print("   ", c.timestamp, c.original, c.mimetype, c.length)


def main():
    urls = sys.argv[1:] or [CONTROL]
    f = Fetcher()
    for url in urls:
        shard, stem = strip(url)
        print(f"\n=== {url}\n    shard={shard} stem={stem}")
        caps, resp = cdx_query(f, CONTROL, extra=EXTRA)
        show("control", caps, resp)
        caps, resp = cdx_query(f, f"*.media.tumblr.com/{stem}", extra=EXTRA)
        show("wildcard-host", caps, resp)
        caps, resp = cdx_query(f, f"*.tumblr.com/{stem}", extra=EXTRA)
        show("wildcard-domain", caps, resp)
        for alt in SHARDS:
            if alt == shard:
                continue
            caps, resp = cdx_query(f, f"{alt}.media.tumblr.com/{stem}", extra=EXTRA)
            if caps or not resp.ok or resp.cdx_rows:
                show(f"shard-{alt}", caps, resp)


if __name__ == "__main__":
    main()