#!/usr/bin/env python3
"""Cross-host sweep for Tumblr media files.

Why this exists
---------------
A post page references one CDN host and one size variant
(`http://29.media.tumblr.com/<hash>/tumblr_xyz_500.jpg`). The Wayback Machine
very often holds that same media file under a *different* CDN host number, and
under a different size/extension. Per-URL CDX queries only ever ask about the
one host the page mentioned, so they answer "no captures" for images that are in
fact archived.

A host-wide CDX query (`matchType=prefix` on `NN.media.tumblr.com`, collapsed by
urlkey) returns every archived file of that host in one request. Sweeping a
bounded list of the host numbers Tumblr actually uses therefore answers the
question for *all* known media keys at once - and for keys discovered later, as
long as the dump is still on the runner.

The sweep is deliberately separate from `recovery.cli discover-media`:

* it writes its dumps to `data/work/host-sweep/` (gitignored, per-run cache),
* it never touches `data/cdx/media.jsonl` or post records, so it can run next to
  the crawl daemon without corrupting its bookkeeping,
* it prints a machine-readable summary so the caller can record the outcome in
  the recovery report, including hosts that turned out to be empty.

Usage
-----
    python3 -m scripts.host-sweep --hosts 40,41,64            # explicit hosts
    python3 -m scripts.host-sweep --default-hosts --limit 8   # most used first
    python3 -m scripts.host-sweep --match-only                # offline re-match
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import sys
from typing import Iterable, Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from recovery import config
from recovery.cdx import cdx_query, within_cutoff
from recovery.http import Fetcher
from recovery.media import key_of
from recovery.store import PostStore

DUMP_DIR = os.path.join(config.DATA_DIR, "work", "host-sweep")
MATCH_FILE = os.path.join(config.DATA_DIR, "work", "host-sweep", "matches.jsonl")

# Host numbers Tumblr is known to serve media from. Kept explicit and bounded:
# a wildcard `*.media.tumblr.com` CDX query times out (HTTP 504), so coverage
# comes from a finite list instead.
DEFAULT_HOSTS = [f"{n}.media.tumblr.com" for n in
                 (24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 40, 41, 42, 43, 44, 45, 46, 47, 48,
                  49, 50, 64, 65, 66, 67, 68, 69, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80,
                  81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95, 96, 97, 98,
                  99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112,
                  113, 114, 115, 116, 117, 118, 119, 120, 121, 122, 123, 124, 125, 126,
                  127, 128, 129, 130, 131, 132, 133, 134, 135, 136, 137, 138, 139, 140)]


def known_keys(store: Optional[PostStore] = None) -> dict[str, list[str]]:
    """media key -> post ids that reference it."""
    st = store or PostStore()
    out: dict[str, list[str]] = {}
    for rec in st.all():
        pid = str(rec.get("post_id", ""))
        for img in rec.get("images", []):
            for k in {key_of(img.get("media_url", "")), key_of(img.get("media_key") or "")}:
                if k:
                    out.setdefault(k, [])
                    if pid not in out[k]:
                        out[k].append(pid)
    return out


def host_rank(store: Optional[PostStore] = None) -> list[str]:
    """Referenced media hosts first (most image references first)."""
    st = store or PostStore()
    counts: dict[str, int] = {}
    for rec in st.all():
        for img in rec.get("images", []):
            url = img.get("media_url", "")
            host = url.split("/", 3)[2] if url.count("/") > 2 else ""
            if host:
                counts[host] = counts.get(host, 0) + 1
    return [h for h, _ in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))]


def dump_path(host: str) -> str:
    return os.path.join(DUMP_DIR, f"{host}.jsonl")


def sweep_host(fetcher: Fetcher, host: str, *, page_size: int = 50000,
               max_pages: int = 20) -> dict:
    """Download every pre-cutoff 200-status row of one media host (resumable)."""
    path = dump_path(host)
    os.makedirs(DUMP_DIR, exist_ok=True)
    done_marker = path + ".complete"
    if os.path.exists(done_marker):
        rows = sum(1 for _ in open(path, encoding="utf-8")) if os.path.exists(path) else 0
        return {"host": host, "rows": rows, "pages": 0, "status": 0, "error": "cached",
                "skipped": True, "complete": True}
    rows_before = sum(1 for _ in open(path, encoding="utf-8")) if os.path.exists(path) else 0
    pages = 0
    status = 0
    error = "ok"
    short = False
    for page in range(1, max_pages + 1):
        caps, resp = cdx_query(fetcher, host, match="prefix", limit=page_size,
                               extra={"filter": "statuscode:200", "collapse": "urlkey",
                                      "page": str(page)})
        pages = page
        status = resp.status
        if not resp.ok:
            error = resp.error or f"http_{resp.status}"
            break
        with open(path, "a", encoding="utf-8") as fh:
            for cap in caps:
                if within_cutoff(cap.timestamp):
                    fh.write(json.dumps(cap.to_row(), ensure_ascii=False) + "\n")
            fh.flush()
            os.fsync(fh.fileno())
        if len(caps) < page_size:
            short = True
            break
    complete = bool(short and error == "ok")
    if complete:
        with open(done_marker, "w", encoding="utf-8") as fh:
            fh.write("complete\n")
    rows = sum(1 for _ in open(path, encoding="utf-8")) if os.path.exists(path) else 0
    return {"host": host, "rows": rows, "new_rows": rows - rows_before, "pages": pages,
            "status": status, "error": error, "complete": complete}


def match(keys: dict[str, list[str]], hosts: Optional[Iterable[str]] = None) -> list[dict]:
    """Offline: which known media keys exist in which swept host dump."""
    paths = ([dump_path(h) for h in hosts] if hosts
             else sorted(glob.glob(os.path.join(DUMP_DIR, "*.jsonl"))))
    hits: list[dict] = []
    seen: set[str] = set()
    for path in paths:
        if not os.path.exists(path):
            continue
        host = os.path.basename(path)[:-len(".jsonl")]
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                try:
                    row = json.loads(line)
                except Exception:
                    continue
                k = key_of(row.get("original", ""))
                if k in keys and k not in seen:
                    seen.add(k)
                    hits.append({"media_key": k, "host": host, "timestamp": row.get("timestamp"),
                                 "original": row.get("original"), "mimetype": row.get("mimetype"),
                                 "length": row.get("length"), "statuscode": row.get("statuscode"),
                                 "posts": keys[k][:5]})
    return hits


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--hosts", default="", help="comma separated hosts")
    ap.add_argument("--default-hosts", action="store_true",
                    help="sweep the full known Tumblr CDN host list")
    ap.add_argument("--referenced-first", action="store_true",
                    help="put hosts referenced by parsed posts first")
    ap.add_argument("--limit", type=int, default=0, help="stop after N hosts")
    ap.add_argument("--match-only", action="store_true", help="no network; re-match dumps")
    ap.add_argument("--time-budget", type=float, default=0.0,
                    help="stop starting new hosts after N seconds (0 = unlimited)")
    args = ap.parse_args(argv)

    import time

    keys = known_keys()
    hosts: list[str] = [h.strip() for h in args.hosts.split(",") if h.strip()]
    if args.referenced_first:
        referenced = [h for h in host_rank() if h not in hosts]
        hosts = hosts + referenced + ([h for h in DEFAULT_HOSTS if h not in referenced])
    elif args.default_hosts:
        hosts = hosts + [h for h in DEFAULT_HOSTS if h not in hosts]
    if args.limit:
        hosts = hosts[: args.limit]

    results = []
    if not args.match_only:
        fetcher = Fetcher()
        start = time.time()
        for host in hosts:
            if args.time_budget and time.time() - start > args.time_budget:
                results.append({"host": host, "skipped": "time_budget"})
                continue
            res = sweep_host(fetcher, host)
            results.append(res)
            print(json.dumps(res, ensure_ascii=False), file=sys.stderr, flush=True)

    hits = match(keys)
    if hits:
        os.makedirs(os.path.dirname(MATCH_FILE), exist_ok=True)
        with open(MATCH_FILE, "a", encoding="utf-8") as fh:
            for hit in hits:
                fh.write(json.dumps(hit, ensure_ascii=False, sort_keys=True) + "\n")
    out = {"known_keys": len(keys), "hosts": len(hosts), "results": results,
           "matched_keys": len(hits), "hits": hits[:50], "match_file": MATCH_FILE,
           "cutoff": config.CUTOFF}
    json.dump(out, sys.stdout, ensure_ascii=False, indent=1)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
