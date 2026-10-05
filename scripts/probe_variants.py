#!/usr/bin/env python3
"""Throwaway probe: measure the true image-recovery rate.

For each sampled media URL we ask the CDX one *path-prefix* query per file
(`host/hashdir/tumblr_key` with matchType=prefix). Because urlkeys are
lower-cased and sorted, a single prefix query returns EVERY size/extension
variant the archive holds for that file, in one round trip.
"""
import json
import random
import sys
import time
import urllib.parse
import urllib.request

CDX = "https://web.archive.org/cdx/search/cdx"
CUTOFF = "20191231235959"


def cdx(url, **params):
    q = {"url": url, "output": "json", "to": CUTOFF}
    q.update(params)
    req = CDX + "?" + urllib.parse.urlencode(q)
    with urllib.request.urlopen(req, timeout=90) as r:
        body = r.read().decode("utf-8", "replace")
    if not body.strip():
        return []
    return json.loads(body)


def file_prefix(u):
    """http://H/hash/tumblr_KEY_500.jpg -> http://H/hash/tumblr_KEY"""
    p = urllib.parse.urlparse(u)
    host = p.netloc
    parts = [x for x in p.path.split("/") if x]
    if len(parts) < 2:
        return None
    d, name = parts[-2], parts[-1]
    stem = name.rsplit(".", 1)[0]
    for size in ("_1280", "_1024", "_800", "_750", "_640", "_540", "_500", "_400",
                 "_320", "_250", "_100", "_16"):
        if stem.endswith(size):
            stem = stem[: -len(size)]
            break
    return f"{p.scheme}://{host}/{d}/{stem}"


def main():
    urls = [u for u in open("data/work/media-urls.txt").read().split() if u]
    random.seed(7)
    sample = random.sample(urls, int(sys.argv[1]) if len(sys.argv) > 1 else 8)
    if len(sys.argv) > 2:
        sample.append("http://40.media.tumblr.com/46281703ea29ab2c507f5bc4485c62ec/"
                      "tumblr_ndozw9K7Dz1r3it8zo1_500.jpg")
    hits = 0
    for u in sample:
        pre = file_prefix(u)
        t0 = time.time()
        try:
            rows = cdx(pre, matchType="prefix", limit="40",
                       **{"filter": "statuscode:200"})
            ok = [r for r in rows[1:] if r[3].startswith("image/")]
        except Exception as e:  # noqa: BLE001
            rows, ok = None, []
            print(f"  ERROR {type(e).__name__}: {str(e)[:80]}", flush=True)
        dt = time.time() - t0
        if ok:
            hits += 1
        print(f"[{'HIT' if ok else 'gap'}] {dt:5.1f}s rows={0 if not rows else len(rows)-1} "
              f"img={len(ok)}  {u.split('/')[-1]}", flush=True)
        for r in ok[:3]:
            print(f"        -> {r[1]} {r[3]} {r[6]}B  {r[2]}", flush=True)
        time.sleep(1.5)
    print(f"\nrecovery rate: {hits}/{len(sample)}")


if __name__ == "__main__":
    main()