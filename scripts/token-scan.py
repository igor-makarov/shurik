#!/usr/bin/env python3
"""Cross-directory tumblr-token scan for post images.

Why this exists
---------------
Every post image recovered so far was declared a confirmed archive gap after
exact-URL and size/extension variant CDX queries returned zero rows. That only
proves the *exact* URL is absent. A Tumblr media file is addressed as

    http://NN.media.tumblr.com/<per-image-hash-dir>/tumblr_<token>_<size>.<ext>

where `<per-image-hash-dir>` is opaque, and the same token (e.g.
`tumblr_ndozw9K7Dz1r3it8zo1`) can be archived under a *different* shard or
directory than the one an archived post page happens to link to. Testing that
hypothesis per image costs one slow CDX query per image, which is what made
image recovery stall.

This script instead downloads each referenced shard's pre-cutoff capture rows
once (`matchType=prefix`, which the CDX server answers quickly) and matches
every row locally by media token. Only rows whose token a recovered post
references are kept, so the committed evidence stays tiny while the ephemeral
download stays in data/work (gitignored).

Usage:
    python3 scripts/token-scan.py [--hosts h1,h2] [--concurrency 2] [--limit 200000]

Output:
    data/work/token-scan/<host>.hits.jsonl   matched rows (ephemeral)
    data/work/token-scan/summary.json         per-host row/keep counts
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from recovery import config  # noqa: E402

OUT_DIR = os.path.join(config.DATA_DIR, "work", "token-scan")
CDX = "https://web.archive.org/cdx/search/cdx"
UA = config.USER_AGENT


def token_of(url: str) -> str:
    """Identity of a tumblr media file independent of shard, dir, size, ext."""
    base = urllib.parse.unquote(url.split("?")[0].split("#")[0].rsplit("/", 1)[-1]).lower()
    base = re.sub(r"_\d+(sq)?\.[a-z0-9]+$", "", base)
    base = re.sub(r"\.(png|jpg|jpeg|gif|webp)$", "", base)
    return base


def wanted_tokens() -> set[str]:
    """Every media token referenced by a parsed post (data/posts/*.json)."""
    toks: set[str] = set()
    for path in glob.glob(os.path.join(config.POST_DIR, "*.json")):
        try:
            post = json.load(open(path, encoding="utf-8"))
        except Exception:
            continue
        for bucket in ("images", "missing_images"):
            for img in post.get(bucket) or []:
                url = (img or {}).get("media_url") or ""
                if url:
                    toks.add(token_of(url))
    return toks


def hosts_for(tokens: set[str]) -> dict[str, set[str]]:
    """host -> tokens referenced on that host (from data, no network)."""
    out: dict[str, set[str]] = {}
    for path in glob.glob(os.path.join(config.POST_DIR, "*.json")):
        try:
            post = json.load(open(path, encoding="utf-8"))
        except Exception:
            continue
        for bucket in ("images", "missing_images"):
            for img in post.get(bucket) or []:
                url = (img or {}).get("media_url") or ""
                m = re.match(r"^https?://([^/]+)/", url)
                if not m:
                    continue
                host = m.group(1).lower()
                if not re.match(r"^\d+\.media\.tumblr\.com$", host):
                    continue
                out.setdefault(host, set()).add(token_of(url))
    return out


def query_host(host: str, limit: int, timeout: int = 300) -> tuple[int, int, str]:
    """One CDX prefix query for a shard; returns (rows, kept, error)."""
    url = (
        f"{CDX}?url={host}&matchType=prefix&limit={limit}"
        f"&fl=original,timestamp,statuscode,mimetype,length"
        f"&from=19960101&to={config.CUTOFF}"
    )
    hits_path = os.path.join(OUT_DIR, f"{host}.hits.jsonl")
    rows = 0
    tmp = os.path.join(OUT_DIR, f"{host}.rows.tmp")
    proc = subprocess.run(
        ["curl", "-sS", "--max-time", str(timeout), "-A", UA, url, "-o", tmp],
        capture_output=True, text=True,
    )
    if proc.returncode != 0 or not os.path.exists(tmp):
        return 0, 0, f"curl rc={proc.returncode} {proc.stderr.strip()[:120]}"
    kept = 0
    with open(tmp, encoding="utf-8", errors="replace") as fh, \
            open(hits_path, "w", encoding="utf-8") as out:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            rows += 1
            parts = line.split(" ")
            original = parts[0] if parts else ""
            if token_of(original) not in tokens:
                continue
            kept += 1
            out.write(line + "\n")
    os.remove(tmp)
    return rows, kept, ""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--hosts", default="")
    ap.add_argument("--concurrency", type=int, default=2)
    ap.add_argument("--limit", type=int, default=200000)
    ap.add_argument("--sleep", type=float, default=1.5)
    args = ap.parse_args()

    os.makedirs(OUT_DIR, exist_ok=True)
    all_tokens = wanted_tokens()
    per_host = hosts_for(all_tokens)
    hosts = sorted(h for h in per_host if not args.hosts or h in args.hosts.split(","))
    print(f"referenced tokens: {len(all_tokens)} on {len(per_host)} shards", flush=True)
    summary = {}
    for host in hosts:
        toks = per_host[host]
        t0 = time.time()
        rows, kept, err = query_host(host, args.limit)
        summary[host] = {"rows": rows, "kept": kept, "tokens_wanted": len(toks),
                         "seconds": round(time.time() - t0, 1), "error": err}
        print(f"{host}: rows={rows} kept={kept}/{len(toks)} tokens "
              f"({summary[host]['seconds']}s) {err}", flush=True)
        with open(os.path.join(OUT_DIR, "summary.json"), "w", encoding="utf-8") as fh:
            json.dump(summary, fh, indent=2, sort_keys=True)
        if args.sleep:
            time.sleep(args.sleep)
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())