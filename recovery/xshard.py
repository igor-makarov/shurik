"""Cross-shard image discovery.

A Tumblr image is served from a numbered CDN shard (`NN.media.tumblr.com`) and
the number changes over the years. A post page captured in 2015 may link
`40.media.tumblr.com/<md5>/tumblr_x_500.jpg`, while the archive actually
crawled the very same file under a *different* shard (say
`31.media.tumblr.com/tumblr_x_500.jpg`) in another crawl. The per-image stem
query only asks the shard the post links, so those copies are invisible to it:
the linked shard answers "no capture" while the bytes sit under a sibling shard.

The CDX endpoint can enumerate every old-style (`/<host>/tumblr_*`, no md5
directory) URL of one shard, and a server-side `filter=original:.*<blog>.*`
narrows the answer to this blog's files. That is the one query shape that finds
a capture whose host the posts never mention.

The scan is per-host and resumable: each host's answer is written once, and the
found URLs are folded into the matching post's image `url_forms`, where the
resolver's alternate-form probe turns them into bytes.
"""
from __future__ import annotations

import json
import os
from typing import Iterable, Optional

from . import config
from .cdx import Capture, cdx_query, normalize_url, within_cutoff
from .http import GAP, OK, TRANSPORT, Fetcher
from .parsing import base_media_key, host_of, media_key
from .store import PostStore

# Tumblr's blog index inside an image filename (`tumblr_<key>1r3it8zo<n>`).
BLOG_INDEX = "r3it8zo"

# Shards observed in this blog's media URLs. Old-style URLs (no md5 directory)
# are served from these hosts, so `/<host>/tumblr_` enumerates them.
DEFAULT_HOSTS = (
    "24.media.tumblr.com", "25.media.tumblr.com", "26.media.tumblr.com",
    "27.media.tumblr.com", "28.media.tumblr.com", "29.media.tumblr.com",
    "30.media.tumblr.com", "31.media.tumblr.com", "33.media.tumblr.com",
    "36.media.tumblr.com", "37.media.tumblr.com", "38.media.tumblr.com",
    "40.media.tumblr.com", "41.media.tumblr.com", "64.media.tumblr.com",
    "65.media.tumblr.com", "66.media.tumblr.com", "67.media.tumblr.com",
    "68.media.tumblr.com", "78.media.tumblr.com", "media.tumblr.com",
)

HOST_STATE = os.path.join(config.CDX_DIR, "xshard-hosts.json")
FOUND_LEDGER = os.path.join(config.CDX_DIR, "xshard.jsonl")


def _load_host_state() -> dict:
    if os.path.exists(HOST_STATE):
        try:
            with open(HOST_STATE, encoding="utf-8") as fh:
                data = json.load(fh)
            if isinstance(data, dict):
                return data
        except Exception:
            pass
    return {}


def _save_host_state(state: dict) -> None:
    os.makedirs(os.path.dirname(HOST_STATE) or ".", exist_ok=True)
    tmp = HOST_STATE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(state, fh, ensure_ascii=False, indent=1, sort_keys=True)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, HOST_STATE)


def scan_host(fetcher: Fetcher, host: str, *, blog_index: str = BLOG_INDEX,
              limit: int = 2000) -> tuple[list[Capture], dict]:
    """Every old-style URL of `host` whose filename carries `blog_index`.

    One CDX prefix query per shard. The server-side `filter=original:.*<blog>.*`
    keeps the answer small; a 504 (the shard's index is too large to scan) is
    reported as a failure so the host stays pending instead of being recorded as
    an empty answer.
    """
    prefix = f"http://{host}/tumblr_"
    caps, resp = cdx_query(fetcher, prefix, match="prefix", limit=limit,
                           extra={"filter": f"original:.*{blog_index}.*"})
    diag = {"host": host, "status": resp.status,
            "error": None if resp.ok else resp.error,
            "message": resp.message, "rows": len(caps)}
    if not resp.ok:
        return [], diag
    good = [c for c in caps
            if within_cutoff(c.timestamp) and (c.statuscode in ("", "200"))]
    return good, diag


def apply_captures(store: Optional[PostStore], captures: Iterable[Capture], *,
                   blog_index: str = BLOG_INDEX) -> dict:
    """Fold found cross-shard URLs into the matching posts' image `url_forms`.

    A capture is matched to a post image by *base key* -- `tumblr_<key>...` with
    the size suffix removed -- because the archived shard usually serves a
    different size than the post linked. Matching posts are marked so the next
    resolver pass probes the new form.
    """
    store = store or PostStore()
    # base key -> the media_urls of every unresolved image that carries it, and
    # exact media key -> the same, so a found file can prefer the image that
    # links the *same size* instead of every sibling of the photo.
    by_base: dict[str, list[tuple[str, str]]] = {}
    by_key: dict[str, list[tuple[str, str]]] = {}
    for rec in store.all():
        pid = str(rec.get("post_id") or "")
        for img in rec.get("images") or []:
            if img.get("sha256"):
                continue
            url = img.get("media_url") or ""
            if not url:
                continue
            base = img.get("base_key") or base_media_key(url)
            if base:
                by_base.setdefault(base, []).append((pid, url))
            key = img.get("media_key")
            if key:
                by_key.setdefault(key, []).append((pid, url))
    stats = {"captures": 0, "matched": 0, "added_forms": 0, "posts": 0,
             "already": 0, "unmatched": 0}
    # pid -> list of (media_url, cross-shard url, capture timestamp)
    wanted: dict[str, list[tuple[str, str, str]]] = {}
    for cap in captures:
        stats["captures"] += 1
        base = base_media_key(cap.original)
        if not base:
            stats["unmatched"] += 1
            continue
        # Prefer the image that links the identical filename (same size); only
        # fall back to any size sibling when the post does not link this size.
        matches = by_key.get(media_key(cap.original) or "") or by_base.get(base)
        if not matches:
            stats["unmatched"] += 1
            continue
        stats["matched"] += 1
        for pid, media_url in matches:
            wanted.setdefault(pid, []).append((media_url, cap.original, cap.timestamp))
    for pid, adds in wanted.items():
        rec = store.get(pid)
        if not rec:
            continue
        changed = False
        for img in rec.get("images") or []:
            for media_url, form, ts in adds:
                if img.get("media_url") != media_url:
                    continue
                forms = img.setdefault("url_forms", [media_url])
                if form in forms:
                    stats["already"] += 1
                    continue
                forms.append(form)
                # A discovered capture makes the image worth probing again:
                # clear the terminal gap so the queue selects it without
                # `--retry-missing`.
                img["error"] = None
                img["state"] = "pending"
                img["xshard_capture"] = {"timestamp": ts, "url": form,
                                         "source": "xshard-host-scan"}
                stats["added_forms"] += 1
                changed = True
        if changed:
            store.put(pid, rec)
            stats["posts"] += 1
    return stats


def append_found(captures: Iterable[Capture], diag: dict) -> int:
    os.makedirs(os.path.dirname(FOUND_LEDGER) or ".", exist_ok=True)
    n = 0
    with open(FOUND_LEDGER, "a", encoding="utf-8") as fh:
        for cap in captures:
            fh.write(json.dumps({"url": cap.original, "timestamp": cap.timestamp,
                                 "host": host_of(cap.original), **diag},
                                ensure_ascii=False) + "\n")
            n += 1
        fh.flush()
        os.fsync(fh.fileno())
    return n


def xshard_scan(fetcher: Fetcher, *, hosts: Optional[list[str]] = None,
                limit: int = 2000, rescan: bool = False,
                apply: bool = True) -> dict:
    hosts = hosts or list(DEFAULT_HOSTS)
    state = _load_host_state()
    store = PostStore() if apply else None
    out = {"hosts": [], "requests_sent": 0, "found": 0, "applied": 0,
           "scanned": 0, "skipped_done": 0, "failed": 0}
    for host in hosts:
        prev = state.get(host) or {}
        if prev.get("done") and not rescan:
            out["skipped_done"] += 1
            continue
        caps, diag = scan_host(fetcher, host, limit=limit)
        out["requests_sent"] += 1
        out["scanned"] += 1
        if diag.get("error"):
            out["failed"] += 1
            state[host] = {"done": False, "error": diag.get("error"),
                           "status": diag.get("status"), "at": _now()}
            out["hosts"].append(diag)
            _save_host_state(state)
            continue
        append_found(caps, {"host": host})
        out["found"] += len(caps)
        applied = apply_captures(store, caps) if apply else {"added_forms": 0}
        out["applied"] += applied.get("added_forms", 0)
        state[host] = {"done": True, "rows": len(caps), "at": _now(),
                       "applied": applied.get("added_forms", 0)}
        out["hosts"].append({**diag, "applied": applied})
        _save_host_state(state)
    out["pending_hosts"] = [h for h in hosts if not (state.get(h) or {}).get("done")]
    return out


def _now() -> str:
    import time
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
