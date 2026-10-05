#!/usr/bin/env python3
"""Throwaway probe: measure the true image-recovery rate.

Lessons encoded here after the first (buggy) probe:
  * a `url=None` CDX query returns the head of the WHOLE index, which looks like
    a wall of hits. Every query now refuses to run without a real url.
  * results are validated against the requested urlkey prefix, so a server-side
    fallback can never be mistaken for a recovery.
  * one `matchType=prefix` query per (host, tumblr file key) returns EVERY
    size/extension variant for that file on that host.
  * the same tumblr key is served by several media hosts, so keys are tried on
    every host that ever referenced them.
"""
import collections
import json
import random
import re
import sys
import time
import urllib.parse
import urllib.request

CDX = "https://web.archive.org/cdx/search/cdx"
CUTOFF = "20191231235959"
SIZES = ("_1280", "_1024", "_800", "_750", "_640", "_540", "_500", "_400",
         "_320", "_250", "_100", "_r1", "_r2")


def cdx(url, **params):
    assert url, "refusing a CDX query with no url (returns the whole index)"
    q = {"url": url, "output": "json", "to": CUTOFF}
    q.update(params)
    req = CDX + "?" + urllib.parse.urlencode(q)
    with urllib.request.urlopen(req, timeout=90) as r:
        body = r.read().decode("utf-8", "replace")
    return json.loads(body) if body.strip() else []


def urlkey_of(url):
    p = urllib.parse.urlparse(url)
    parts = [x for x in p.path.split("/") if x]
    host = p.netloc.lower().split(":")[0].split(".")[-3:]  # x.y.z
    segs = [urllib.parse.quote(x, safe="") for x in parts]
    return "com,tumblr,media," + ".".join(host) + ")/" + "".join(
        urllib.parse.quote(x.lower(), safe="") for x in segs)


def file_key(url):
    """tumblr_m4ulu8rpDN1r3it8zo1_r1_500.jpg -> tumblr_m4ulu8rpDN1r3it8zo1"""
    name = urllib.parse.urlparse(url).path.rsplit("/", 1)[-1]
    stem = name.rsplit(".", 1)[0]
    for s in SIZES:
        if stem.endswith(s):
            return stem[: -len(s)]
    return stem


def prefix_for(url):
    """The path prefix that covers all variants of this file, on this host."""
    p = urllib.parse.urlparse(url)
    parts = [x for x in p.path.split("/") if x]
    if not parts:
        return None
    if len(parts) >= 2 and re.fullmatch(r"[0-9a-f]{16,}", parts[-2]):
        d = parts[-2]
    else:
        d = None
    return f"{p.scheme}://{p.netloc}/" + (f"{d}/" if d else "") + file_key(url)


def variants_for_key(key):
    """Same tumblr key served by sibling hosts."""
    return key


def main():
    urls = [u for u in open("data/work/media-urls.txt").read().split() if u]
    random.seed(int(sys.argv[2]) if len(sys.argv) > 2 else 7)
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 12
    sample = random.sample(urls, min(n, len(urls)))
    sample.append("http://40.media.tumblr.com/46281703ea29ab2c507f5bc4485c62ec/"
                  "tumblr_ndozw9K7Dz1r3it8zo1_500.jpg")

    # sibling hosts per tumblr key
    siblings = collections.defaultdict(set)
    for u in urls:
        siblings[file_key(u)].add(u)

    hits = 0
    for u in sample:
        key = file_key(u)
        found = []
        tried = []
        for cand_url in [u] + list(siblings[key]):
            pre = prefix_for(cand_url)
            if not pre:
                continue
            try:
                rows = cdx(pre, matchType="prefix", limit="60",
                           **{"filter": "statuscode:200"})
            except Exception as e:  # noqa: BLE001
                tried.append((pre, f"ERR {type(e).__name__}"))
                continue
            # guard: urlkey must really share the prefix we asked for
            want = urlkey_of(pre)
            for r in rows[1:]:
                if r[0].startswith(want) and r[3].startswith("image/"):
                    found.append(r)
            tried.append((pre, len(rows) - 1))
            if found:
                break
            time.sleep(1.0)
        if found:
            hits += 1
        best = found[0] if found else None
        print(f"[{'HIT' if found else 'gap'}] {key:34s} queries={len(tried)} "
              f"-> {best[1] if best else ''} {best[3] if best else ''} "
              f"{best[6] if best else ''}", flush=True)
        for r in found[:2]:
            print(f"        {r[1]} {r[3]} {r[6]}B {r[2]}", flush=True)
        time.sleep(1.0)
    print(f"\nrecovery rate: {hits}/{len(sample)}")


if __name__ == "__main__":
    main()