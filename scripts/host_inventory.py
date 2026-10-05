#!/usr/bin/env python3
"""Ad-hoc, serial full-host CDX inventory for Tumblr media hosts.

Not part of the committed pipeline yet: this is the experiment that decides
whether `discover-media` is worth running across every referenced host. Writes
every pre-cutoff row to data/work/media-dumps/<host>.jsonl (gitignored) so the
matching experiment can run offline.
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
DUMP = "data/work/media-dumps"
LIMIT = 20000


def fetch(host: str, page: int, timeout: int = 240) -> tuple[list[list[str]], str]:
    q = urllib.parse.urlencode({
        "url": host, "matchType": "domain", "output": "json", "to": CUTOFF,
        "filter": "statuscode:200", "collapse": "urlkey", "limit": str(LIMIT),
        "page": str(page),
    })
    req = urllib.request.Request(f"{CDX}?{q}", headers={"User-Agent": "hazfalafel-recovery/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read().decode("utf-8", "replace")
    if body.startswith("<"):
        return [], body[:200]
    return json.loads(body), "ok"


def main() -> int:
    hosts = sys.argv[1:]
    os.makedirs(DUMP, exist_ok=True)
    for host in hosts:
        path = os.path.join(DUMP, f"{host}.jsonl")
        have = set()
        if os.path.exists(path):
            with open(path, encoding="utf-8") as fh:
                for line in fh:
                    try:
                        have.add(json.loads(line)["urlkey"])
                    except Exception:
                        pass
        fh = open(path, "a", encoding="utf-8")
        page, total, newest = 1, 0, ""
        while page <= 40:
            for attempt in range(3):
                t0 = time.time()
                try:
                    rows, err = fetch(host, page)
                except Exception as exc:  # noqa: BLE001 - report and retry
                    rows, err = [], f"{type(exc).__name__}: {exc}"
                print(f"  page={page} attempt={attempt} rows={len(rows)} "
                      f"{time.time()-t0:.1f}s {err[:80]}", flush=True)
                if rows:
                    break
                time.sleep(10 * (attempt + 1))
            if not rows:
                break
            head, body = rows[0], rows[1:]
            for r in body:
                newest = r[1] if len(r) > 1 else newest
                if r[0] in have:
                    continue
                have.add(r[0])
                fh.write(json.dumps(r, ensure_ascii=False) + "\n")
            total += len(body)
            if len(body) < LIMIT:
                break
            page += 1
        fh.close()
        print(f"{host}: +{total} rows, newest={newest}, pages={page}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())