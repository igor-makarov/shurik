#!/usr/bin/env python3
"""Health + yield probe: fresh stem CDX queries on unresolved image stems.

Distinguishes the three things a stem pass can produce and keeps them apart:
  * a capture before the cutoff (recoverable bytes, worth fetching);
  * a successful empty answer (negative evidence for that exact prefix only);
  * no HTTP response at all (transport, not a verdict).

One known-good stem is queried first as a control so a run that reaches CDX
replay can be told apart from a run whose transport never answered.
"""
import json
import os
import random
import sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from recovery import config  # noqa: E402
from recovery.cdx import cdx_query  # noqa: E402
from recovery.http import Fetcher  # noqa: E402

CUTOFF = config.CUTOFF
EXTS = (".jpg", ".png", ".gif", ".jpeg", ".bmp", ".webp")
SIZES = ("_1280", "_1024", "_540", "_500", "_400", "_250", "_128", "_64", "_100")

# A stem confirmed to have a pre-cutoff capture; if this one comes back empty
# or unanswered, the transport is the suspect, not the candidate.
CONTROL_STEM = "http://40.media.tumblr.com/acd66e1322aeb10e0ec13ae1659eae09/tumblr_o07sizvpqP1r3it8zo1"

# Same scope the crawler records in data/cdx/stems.jsonl, so these answers are
# comparable with the cached ones.
EXTRA = {"filter": "statuscode:200", "collapse": "urlkey"}


def stem_of(url):
    base = url.rsplit("/", 1)[-1]
    low = base.lower()
    for ext in EXTS:
        if low.endswith(ext):
            base = base[: -len(ext)]
            break
    for size in SIZES:
        if base.lower().endswith(size):
            base = base[: -len(size)]
            break
    return url.rsplit("/", 1)[0] + "/" + base


def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 12
    seed = int(sys.argv[2]) if len(sys.argv) > 2 else 11
    todo = []
    for fname in sorted(os.listdir("data/posts")):
        rec = json.load(open(os.path.join("data/posts", fname), encoding="utf-8"))
        pid = rec.get("post_id")
        for img in rec.get("images") or []:
            if img.get("sha256"):
                continue
            u = img.get("media_url") or ""
            if u:
                todo.append((pid, u))
    random.Random(seed).shuffle(todo)
    todo = todo[:n]

    cats = Counter()
    hosts = Counter()
    hits = []

    fetch = Fetcher()

    def ask(stem):
        """Fresh prefix query; never raises, always reports what was observed.

        Uses exactly the recorded stem scope, so a hit here means the cached
        `stems.jsonl` answer for the same stem is stale or wrong.
        """
        try:
            rows, resp = cdx_query(fetch, stem, match="prefix", limit=8, extra=EXTRA)
        except Exception as exc:  # transport failure: no verdict about the archive
            cats["transport_error"] += 1
            return ("error", str(exc)[:120], [])
        if not resp.ok:
            cats["no_response:" + (resp.error or str(resp.status))] += 1
            return ("error", (resp.error or "") + " " + str(resp.message)[:80], [])
        good = [r for r in rows
                if r.statuscode == "200" and r.timestamp <= CUTOFF]
        if not rows:
            cats["empty_answer"] += 1
            return ("empty", "", [])
        if not good:
            cats["rows_but_none_eligible"] += 1
            return ("ineligible", "", rows)
        cats["hit"] += 1
        return ("hit", "", good)

    state, detail, rows = ask(CONTROL_STEM)
    print("CONTROL", state, detail or (len(rows) and rows[0].timestamp), flush=True)

    for pid, url in todo:
        stem = stem_of(url)
        host = url.split("/")[2]
        state, detail, rows = ask(stem)
        hosts[(host, state)] += 1
        if state == "hit":
            best = max(rows, key=lambda r: int(r.length or 0))
            hits.append({"post_id": pid, "media_url": url, "stem": stem,
                         "ts": best.timestamp, "original": best.original,
                         "length": best.length, "mimetype": best.mimetype})
            print("HIT", pid, host, best.timestamp, best.length, best.original, flush=True)
        else:
            print("   ", state, host, pid, detail, flush=True)

    print(json.dumps({"sampled": len(todo), "control": state, "categories": dict(cats),
                      "hits": len(hits), "by_host": {f"{h}:{s}": c for (h, s), c in hosts.items()}}))
    os.makedirs("data/work", exist_ok=True)
    with open("data/work/host-health-probe.json", "w") as fh:
        json.dump({"hits": hits, "categories": dict(cats), "control": state}, fh, indent=1)


if __name__ == "__main__":
    main()