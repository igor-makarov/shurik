#!/usr/bin/env python3
"""Cross-host stem probe.

Tumblr serves one image from several `NN.media.tumblr.com` shards using the same
`<hash>/<name>` path. A stem that is empty on the shard we know may still have
a capture filed under a *different* shard, which a same-host prefix query can
never see. This asks the same path prefix on a small set of alternative shards
for unresolved stems and reports hits separately from genuine empties.

Scope stays the recorded one per query: `matchType=prefix`,
`filter=statuscode:200`, `collapse=urlkey`, `to=<cutoff>`.
"""
import json
import os
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from recovery import config  # noqa: E402
from recovery.cdx import cdx_query  # noqa: E402
from recovery.http import Fetcher  # noqa: E402

CUTOFF = config.CUTOFF
EXTRA = {"filter": "statuscode:200", "collapse": "urlkey"}

CONTROL_HOST = "40.media.tumblr.com"
CONTROL_STEM = "acd66e1322aeb10e0ec13ae1659eae09/tumblr_o07sizvpqP1r3it8zo1"

# Shards seen in this crawl's media inventory, excluding the control shard.
ALT_HOSTS = ["24", "25", "26", "28", "29", "30", "31", "33", "36", "38",
             "40", "41", "64", "65", "66", "67", "68", "78"]


def stem_path(u):
    """host-stripped path prefix: `<hash>/<name>` with size/ext removed."""
    p = u.split("/", 3)[3] if u.count("/") >= 3 else u.rsplit("/", 1)[-1]
    base = p.rsplit("/", 1)[-1]
    for e in (".jpg", ".png", ".gif", ".jpeg", ".bmp", ".webp"):
        if base.lower().endswith(e):
            base = base[: -len(e)]
            break
    for s in ("_1280", "_1024", "_540", "_500", "_400", "_250", "_128", "_64", "_100"):
        if base.lower().endswith(s):
            base = base[: -len(s)]
            break
    return p.rsplit("/", 1)[0] + "/" + base


def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 6
    alts = int(sys.argv[2]) if len(sys.argv) > 2 else 4
    # Unresolved stems on hosts that gave zero hits so far (the dead pools),
    # where a same-host retry is pointless and only a new shard can help.
    answered = {json.loads(l)["stem"] for l in open("data/cdx/stems.jsonl") if l.strip()}
    dead = {"68", "66", "67", "78", "64", "65"}
    cand = []
    for f in sorted(os.listdir("data/posts")):
        rec = json.load(open(os.path.join("data/posts", f), encoding="utf-8"))
        pid = rec.get("post_id")
        for img in rec.get("images") or []:
            u = img.get("media_url") or ""
            if not u or img.get("sha256"):
                continue
            host = u.split("/")[2].split(".")[0]
            if host not in dead:
                continue
            st = u.rsplit("://", 1)[-1]
            st = st.split("/", 1)[0].split(".")[0]
            if st in answered:
                continue
            cand.append((pid, u))
    cand = cand[:n]
    fetch = Fetcher()
    cats = defaultdict(int)
    hits = []

    def ask(stem):
        try:
            rows, resp = cdx_query(fetch, stem, match="prefix", limit=8, extra=EXTRA)
        except Exception as exc:
            cats["transport_error"] += 1
            return None, str(exc)[:100]
        if not resp.ok:
            cats["no_response"] += 1
            return None, (resp.error or "") + str(resp.message)[:60]
        cats["answered"] += 1
        return [r for r in rows if r.statuscode == "200" and r.timestamp <= CUTOFF], ""

    # Control: the known-good stem on its own shard must answer with a capture.
    ctrl_rows, ctrl_err = ask(f"{CONTROL_HOST}/{CONTROL_STEM}")
    print("CONTROL", "hit" if ctrl_rows else "empty",
          ctrl_rows[0].timestamp if ctrl_rows else ctrl_err, flush=True)

    for pid, url in cand:
        path = stem_path(url)
        for shard in ALT_HOSTS:
            if f"{shard}.media.tumblr.com" == CONTROL_HOST and path == CONTROL_STEM:
                continue
            rows, err = ask(f"{shard}.media.tumblr.com/{path}")
            if rows:
                best = max(rows, key=lambda r: int(r.length or 0))
                hits.append({"post_id": pid, "orig_url": url,
                             "found_on": f"{shard}.media.tumblr.com",
                             "path": path, "ts": best.timestamp,
                             "original": best.original, "length": best.length,
                             "mimetype": best.mimetype})
                print("HIT", pid, shard, best.timestamp, best.length, best.original, flush=True)
            elif err:
                print("   err", shard, err, flush=True)
    print(json.dumps({"candidates": len(cand), "shards_each": alts,
                      "cats": dict(cats), "hits": len(hits)}))
    os.makedirs("data/work", exist_ok=True)
    with open("data/work/cross-host-probe.json", "w") as fh:
        json.dump({"hits": hits, "control": bool(ctrl_rows)}, fh, indent=1)


if __name__ == "__main__":
    main()