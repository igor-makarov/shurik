#!/usr/bin/env python3
"""Bulk CDX dump of one or more media hosts (analysis helper, resumable).

Each host is dumped with `collapse=urlkey` and `showResumeKey` paging so a big
host (78.media.tumblr.com has >80k urls) can be paged through without ever
holding more than one page in memory. Rows are written straight to
data/work/media-dumps/<host>.jsonl (gitignored) and can be intersected with the
media keys our parsed posts actually reference.
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.parse
import urllib.request

CDX = "https://web.archive.org/cdx/search/cdx"
CUTOFF = "20191231235959"
OUT = "data/work/media-dumps"
UA = "shurik-hazfalafel-recovery/1.0 (+https://github.com/igor-makarov/shurik)"
PAGE = 3000


def fetch(params: dict, tries: int = 3) -> dict:
    url = CDX + "?" + urllib.parse.urlencode(params)
    delay = 2.0
    for attempt in range(1, tries + 1):
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        try:
            with urllib.request.urlopen(req, timeout=120) as fh:
                body = fh.read().decode("utf-8", "replace")
            return json.loads(body)
        except urllib.error.HTTPError as exc:  # 429/5xx are retryable
            print(f"  HTTP {exc.code} attempt {attempt}", flush=True)
            if exc.code in (429, 500, 502, 503, 504) and attempt < tries:
                time.sleep(delay)
                delay *= 2
                continue
            raise
        except Exception as exc:
            print(f"  {type(exc).__name__}: {exc} attempt {attempt}", flush=True)
            if attempt < tries:
                time.sleep(delay)
                delay *= 2
                continue
            raise
    return {}


def dump_host(host: str, budget_s: float = 240.0) -> int:
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, host + ".jsonl")
    start = time.time()
    n = 0
    resume = None
    with open(path, "w", encoding="utf-8") as fh:
        while True:
            params = {
                "url": host,
                "matchType": "host",
                "output": "json",
                "fl": "timestamp,original,statuscode,mimetype,length",
                "from": "19960101",
                "to": CUTOFF,
                "collapse": "urlkey",
                "limit": str(PAGE),
            }
            if resume:
                params["resumeKey"] = resume
            body = fetch(params)
            if not isinstance(body, list) or not body:
                break
            header, rows = body[0], body[1:]
            for row in rows:
                fh.write(json.dumps(row, ensure_ascii=False) + "\n")
            n += len(rows)
            print(f"{host}: +{len(rows)} total={n}", flush=True)
            # resume key is the last row when the page was full
            if len(rows) < PAGE or not rows:
                break
            resume = rows[-1][0] if rows[0] and rows[0][0] == "timestamp" else rows[-1][0]
            resume = rows[-1][0]
            if time.time() - start > budget_s:
                print(f"{host}: budget reached at {n} rows", flush=True)
                fh.flush()
                with open(path + ".partial", "w") as pf:
                    pf.write(resume)
                return n
            time.sleep(0.4)
    return n


if __name__ == "__main__":
    hosts = sys.argv[1:]
    for h in hosts:
        try:
            total = dump_host(h)
            print(f"DONE {h} {total}", flush=True)
        except Exception as exc:
            print(f"FAIL {h}: {exc}", flush=True)
        time.sleep(1.0)