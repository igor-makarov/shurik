#!/usr/bin/env python3
"""Complete pre-cutoff CDX inventory of one or more Tumblr media hosts.

`matchType=domain` with a large `limit` is *not* a reliable enumeration: the
server caps a single response and the `page=` cursor returns short pages whose
size depends on the underlying index blocks (measured: 20000 rows unpaged vs
2642 paged for 78.media.tumblr.com). Hex-prefix paging is deterministic and
cheap, because every Tumblr media path is `/<32 hex chars>/tumblr_<key>_<n>.jpg`:

    url=<host>/<c>&matchType=prefix&collapse=urlkey

16 requests per host enumerate the whole host. Rows land in
data/work/media-dumps/<host>.jsonl (gitignored); `recovery.media.scan_host`
consumes the same file format.
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
DUMP = os.path.join("data", "work", "media-dumps")
HEX = "0123456789abcdef"
PREFIXES = [c for c in HEX] + [""]  # "" catches paths that are not hex-dirs


def query(host: str, prefix: str, timeout: int = 120) -> tuple[list[list[str]], str]:
    params = {
        "url": f"{host}/{prefix}" if prefix else host,
        "matchType": "prefix" if prefix else "domain",
        "output": "json", "to": CUTOFF, "filter": "statuscode:200",
        "collapse": "urlkey", "limit": "20000",
    }
    req = urllib.request.Request(CDX + "?" + urllib.parse.urlencode(params),
                                 headers={"User-Agent": "hazfalafel-recovery/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read().decode("utf-8", "replace")
    if body.lstrip().startswith("<"):
        return [], "html-error"
    data = json.loads(body)
    return (data[1:] if data else []), "ok"


def scan(host: str, out) -> tuple[int, int]:
    path = os.path.join(DUMP, f"{host}.jsonl")
    os.makedirs(DUMP, exist_ok=True)
    have = set()
    if os.path.exists(path):
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                try:
                    have.add(json.loads(line)[0])
                except Exception:  # noqa: BLE001
                    pass
    added = rows = 0
    for prefix in PREFIXES:
        for attempt in range(3):
            try:
                body, err = query(host, prefix)
            except Exception as exc:  # noqa: BLE001
                body, err = [], f"{type(exc).__name__}"
            if body or err == "ok":
                break
            time.sleep(5 * (attempt + 1))
        rows += len(body)
        for row in body:
            if row[0] in have:
                continue
            have.add(row[0])
            out.write(json.dumps(row, ensure_ascii=False) + "\n")
        if err != "ok":
            print(f"  !! {host}/{prefix}: {err}", flush=True)
        out.flush()
    return added, rows


def main() -> int:
    hosts = sys.argv[1:]
    for host in hosts:
        t0 = time.time()
        with open(os.path.join(DUMP, f"{host}.jsonl"), "a", encoding="utf-8") as out:
            added, rows = scan(host, out)
        total = sum(1 for _ in open(os.path.join(DUMP, f"{host}.jsonl"), encoding="utf-8"))
        print(f"{host}: rows={rows} added={added} total={total} {time.time()-t0:.1f}s", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())