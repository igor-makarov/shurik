#!/usr/bin/env python3
"""Measure stem-prefix CDX hit rate on a sample of untried post images.

One prefix query on `NN.media.tumblr.com/<stem>` covers every size and
extension sibling of an image in a single archive request, so this measures
requests-per-new-candidate far more cheaply than per-variant probing.
"""
import json
import os
import random
import sys
import time

sys.path.insert(0, "/tmp")
from wget_arch import cdx  # noqa: E402

BLOG_SUFFIX = "r3it8zo1"


def stem(url):
    base = url.rsplit("/", 1)[-1]
    for ext in (".jpg", ".png", ".gif", ".jpeg", ".bmp", ".webp"):
        if base.lower().endswith(ext):
            base = base[: -len(ext)]
            break
    for size in ("_1280", "_1024", "_540", "_500", "_400", "_250", "_128", "_64"):
        if base.lower().endswith(size):
            base = base[: -len(size)]
            break
    return base


def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 20
    seed = int(sys.argv[2]) if len(sys.argv) > 2 else 7
    todo = []
    for fname in sorted(os.listdir("data/posts")):
        rec = json.load(open(os.path.join("data/posts", fname), encoding="utf-8"))
        pid = rec.get("post_id")
        for img in rec.get("images") or []:
            if img.get("sha256"):
                continue
            todo.append((pid, img.get("media_url") or ""))
    todo = [t for t in todo if t[1]]
    random.Random(seed).shuffle(todo)
    todo = todo[:n]
    hits, reqs, t0 = [], 0, time.time()
    for pid, url in todo:
        host = url.split("/")[2]
        s = stem(url)
        reqs += 1
        try:
            rows = cdx("%s/%s" % (host, s.lower()), matchType="prefix", output="json",
                       collapse="digest", limit="60")
        except Exception as exc:  # transport, not a verdict
            print("ERR", pid, url, exc)
            continue
        good = [r for r in rows if r.get("statuscode") == "200"
                and r.get("timestamp", "") <= "20191231235959"]
        if good:
            hits.append({"post_id": pid, "media_url": url, "stem": s,
                         "rows": [{"ts": r["timestamp"], "orig": r["original"],
                                   "len": r.get("length"), "mime": r.get("mimetype")}
                                  for r in good]})
            print("HIT", pid, url, len(good),
                  max(good, key=lambda r: int(r.get("length") or 0))["timestamp"])
    dt = time.time() - t0
    print(json.dumps({"sampled": len(todo), "requests": reqs, "hits": len(hits),
                      "elapsed_s": round(dt, 1),
                      "requests_per_hit": round(reqs / max(1, len(hits)), 2)}))


if __name__ == "__main__":
    main()
