#!/usr/bin/env python3
"""Rate-limited evidence probe: which pre-cutoff years hold captures of a URL?

`web.archive.org/cdx/search/cdx` answers media-host queries with 504 after 60s,
so it cannot be used to test thousands of candidate image URLs. The calendar
endpoint (`/__wb/calendarcaptures/2`) answers the same question for one
URL-year in ~0.3s, which is what makes a full sweep affordable.

It is deliberately *serial with a global minimum spacing*: 13 parallel workers
get the runner's egress refused with "Connection refused". Respect the archive.

  python3 scripts/probe_calendar.py --urls data/work/sample.txt --out data/work/cal.json
"""
import argparse
import json
import os
import random
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

UA = "hazfalafel-recovery/1.0 (+https://github.com/igor-makarov/shurik)"
YEARS = [str(y) for y in range(2007, 2020)]
CUTOFF_YEAR = 2019


class Spacer:
    """Global minimum spacing between outbound requests."""

    def __init__(self, interval):
        self.interval = interval
        self._last = 0.0
        self._lock = threading.Lock()

    def wait(self):
        with self._lock:
            now = time.monotonic()
            delay = self.interval - (now - self._last)
            if delay > 0:
                time.sleep(delay)
            self._last = time.monotonic()


def calendar(url, year, spacer, timeout=45, attempts=3):
    """Return (items, error). `items` is [] when the archive has no capture."""
    api = ("https://web.archive.org/__wb/calendarcaptures/2?url="
           f"{urllib.parse.quote(url, safe='')}&date={year}&groupby=day")
    last = None
    for attempt in range(1, attempts + 1):
        spacer.wait()
        req = urllib.request.Request(api, headers={"User-Agent": UA})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                payload = json.loads(resp.read().decode("utf-8", "replace"))
            return payload.get("items", []) or [], None
        except urllib.error.HTTPError as exc:
            last = f"HTTP {exc.code}"
            if exc.code in (404,):
                return [], None
        except Exception as exc:
            last = f"{type(exc).__name__}: {exc}"[:120]
        time.sleep(min(20, 2 ** attempt) * (0.6 + random.random() * 0.8))
    return None, last


def sweep(url, spacer, years=YEARS):
    years_hit, errors = {}, {}
    for year in years:
        items, err = calendar(url, year, spacer)
        if err:
            errors[year] = err
        elif items:
            years_hit[year] = items
    return {"url": url, "years_with_captures": years_hit, "errors": errors,
            "pre_cutoff": sorted(years_hit), "complete": not errors}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--urls", required=True, help="file with one URL per line")
    ap.add_argument("--out", required=True)
    ap.add_argument("--interval", type=float, default=0.35)
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    urls = [l.strip() for l in open(args.urls, encoding="utf-8") if l.strip()]
    if args.limit:
        urls = urls[:args.limit]
    done = {}
    if os.path.exists(args.out):
        for line in open(args.out, encoding="utf-8"):
            try:
                rec = json.loads(line)
                done[rec["url"]] = rec
            except Exception:
                pass
    todo = [u for u in urls if u not in done or not done[u].get("complete")]
    spacer = Spacer(args.interval)
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "a", encoding="utf-8") as fh:
        for i, url in enumerate(todo, 1):
            rec = sweep(url, spacer)
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
            fh.flush()
            print(f"[{i}/{len(todo)}] {url} pre_cutoff={rec['pre_cutoff']} "
                  f"errors={len(rec['errors'])}", flush=True)
    print(f"done; wrote {args.out}")


if __name__ == "__main__":
    main()