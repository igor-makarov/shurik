"""Mine the archived blog RSS feed for post media URL forms.

Why this exists
---------------
Every other discovery surface (post pages, listing/tag/archive pages, the
per-key CDX stem scan) had gone flat: for a given media key the CDX was asked
about the shard the *post page* linked and answered "no capture", while the same
file is archived under a *different* CDN shard that the post page never
mentioned. `xshard` covers the old-style (`/<host>/tumblr_*`) cross-shard case,
but a modern URL carries an opaque `<md5dir>` that cannot be derived from the
key, so the shard the post linked is the only one the stem scan can ask.

The blog's own RSS feed is a different, long-lived capture surface. Each item
carries the post permalink plus the then-current `<img src>`, so an RSS capture
from a later year reveals the shard Tumblr served the picture from *then* -- a
URL form no post-page capture of the same era necessarily shows. Measured
2026-10-09: 59 pre-cutoff captures of `hazfalafel.com/rss` yielded 104 media URL
forms that appear nowhere else in the corpus, 88 of them for media keys still
unresolved.

The feed is attributed per item (permalink + title + categories), so a form is
folded into the exact post it belongs to instead of guessing from the filename.

Storage
-------
The set of captures already mined lives in `data/cdx/rss-captures.jsonl`
(gitignored bulk state, carried by the `crawl-state` checkpoint), so a fresh
runner does not re-fetch a feed page whose forms are already merged.
"""
from __future__ import annotations

import html
import json
import os
import re
import time
import xml.etree.ElementTree as ET
from typing import Iterable, Optional

from . import config
from .cdx import Capture, cdx_query, normalize_url, within_cutoff
from .parsing import base_media_key, extract_images, media_key
from .store import PostStore

FEED_URL = "http://hazfalafel.com/rss"
STATE_FILE = os.path.join(config.CDX_DIR, "rss-captures.jsonl")
POST_ID_RE = re.compile(r"/post/(\d+)")
IMG_SRC_RE = re.compile(r"""<img[^>]+src=["']([^"']+)["']""", re.I)


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def feed_captures(fetcher, url: str = FEED_URL, limit: int = 500) -> list[Capture]:
    """Every pre-cutoff 200 capture of the feed URL."""
    caps, _resp = cdx_query(fetcher, url, match="exact", limit=limit,
                            extra={"filter": "statuscode:200"})
    return [c for c in caps if within_cutoff(c.timestamp)]


def load_state(path: str = STATE_FILE) -> dict:
    """timestamp -> record of a mined feed capture (resumable)."""
    out: dict = {}
    if not os.path.exists(path):
        return out
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except Exception:
                continue
            ts = rec.get("timestamp")
            if ts:
                out[ts] = rec
    return out


def _append_state(rec: dict, path: str = STATE_FILE) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
        fh.flush()
        os.fsync(fh.fileno())


def parse_feed(text: str) -> list[dict]:
    """One dict per RSS item: post id, permalink, media URLs, title, categories."""
    items: list[dict] = []
    try:
        root = ET.fromstring(text or "")
    except Exception:
        return items
    for item in root.iter("item"):
        link = (item.findtext("link") or "").strip()
        m = POST_ID_RE.search(link)
        if not m:
            continue
        desc = html.unescape(item.findtext("description") or "")
        urls = []
        for u in IMG_SRC_RE.findall(desc):
            u = html.unescape(u).strip()
            if u:
                urls.append(u)
        # `extract_images` also accepts bare <img> markup; feed descriptions are
        # already HTML, so parse the reconstructed body to reuse the exact
        # avatar/theme/tracking filters the post parser uses.
        parsed = extract_images(desc)
        for img in parsed:
            if img.get("media_url"):
                urls.append(img["media_url"])
            urls.extend(img.get("url_forms") or [])
        cats = [(c.text or "").strip() for c in item.findall("category") if (c.text or "").strip()]
        title = html.unescape((item.findtext("title") or "").strip())
        items.append({"post_id": m.group(1), "permalink": link, "urls": sorted(set(urls)),
                      "title": title, "categories": cats,
                      "pub_date": (item.findtext("pubDate") or "").strip()})
    return items


def merge_feed(items: Iterable[dict], *, store: Optional[PostStore] = None,
               capture_ts: str = "", capture_url: str = "") -> dict:
    """Fold feed media URLs into the matching posts' image `url_forms`.

    A form is matched to an image by exact media key first (same size) and then
    by base key (same photo, other size), exactly like the cross-shard merge, so
    a picture referenced on several shards is attributed to the post that links
    it rather than to every sibling of the photo.
    """
    store = store or PostStore()
    stats = {"items": 0, "forms": 0, "added_forms": 0, "new_images": 0,
             "posts": 0, "new_posts": 0, "unmatched": 0}
    # Group forms per post id so each post is read/written once.
    per_post: dict[str, set[str]] = {}
    for it in items:
        stats["items"] += 1
        pid = str(it.get("post_id") or "")
        if not pid:
            continue
        per_post.setdefault(pid, set()).update(u for u in it.get("urls") or [] if u)
    for pid, urls in per_post.items():
        rec = store.get(pid)
        if not rec:
            stats["new_posts"] += 1
            continue
        images = rec.get("images") or []
        by_key = {}
        by_base = {}
        for img in images:
            k = img.get("media_key")
            if k:
                by_key.setdefault(k, []).append(img)
            b = img.get("base_key") or base_media_key(img.get("media_url") or "")
            if b:
                by_base.setdefault(b, []).append(img)
        changed = False
        for u in sorted(urls):
            stats["forms"] += 1
            key = media_key(u)
            base = base_media_key(u)
            if not key or not base:
                stats["unmatched"] += 1
                continue
            targets = by_key.get(key) or by_base.get(base)
            if targets:
                for img in targets:
                    forms = img.setdefault("url_forms", [img.get("media_url") or ""])
                    if u in forms:
                        continue
                    forms.append(u)
                    img["rss_form"] = {"capture": capture_ts, "url": capture_url,
                                       "form": u}
                    if not img.get("sha256"):
                        img["error"] = None
                        img["state"] = "pending"
                    stats["added_forms"] += 1
                    changed = True
                continue
            # A genuine post image the post page never showed (e.g. a photoset
            # member): add it unresolved so the resolver can look for its bytes.
            images.append({
                "media_url": u,
                "media_key": key,
                "base_key": base,
                "found_in": "rss",
                "url_forms": [u],
                "variants": [],
                "state": "pending",
                "error": None,
                "attempts": [],
                "rss_form": {"capture": capture_ts, "url": capture_url, "form": u},
            })
            by_key.setdefault(key, []).append(images[-1])
            by_base.setdefault(base, []).append(images[-1])
            stats["new_images"] += 1
            changed = True
        if changed:
            rec["images"] = images
            rec["images_done"] = False
            store.put(pid, rec)
            stats["posts"] += 1
    return stats


def rss_scan(fetcher, *, limit: int = 0, dry_run: bool = False,
             feed_url: str = FEED_URL, state_file: str = STATE_FILE,
             apply: bool = True) -> dict:
    """Fetch every unmined feed capture, merge its media URL forms (resumable)."""
    state = load_state(state_file)
    caps = feed_captures(fetcher, feed_url)
    todo = [c for c in caps if c.timestamp not in state]
    if limit:
        todo = todo[:limit]
    out = {"feed": feed_url, "captures": len(caps), "mined": len(state),
           "pending": len(caps) - len(state), "fetched": 0, "requests_sent": 0,
           "failed": [], "forms": 0, "added_forms": 0, "new_images": 0,
           "posts": 0, "new_posts": 0, "unmatched": 0, "dry_run": dry_run}
    if dry_run:
        return out
    store = PostStore() if apply else None
    for cap in todo:
        resp = fetcher.replay(cap.timestamp, cap.original, mode="id_")
        out["requests_sent"] += 1
        if not resp.ok or not resp.body:
            out["failed"].append({"timestamp": cap.timestamp, "status": resp.status,
                                  "error": resp.error})
            continue
        items = parse_feed(resp.text())
        merged = merge_feed(items, store=store, capture_ts=cap.timestamp,
                            capture_url=cap.original) if apply else {"forms": 0}
        for k in ("forms", "added_forms", "new_images", "posts", "new_posts", "unmatched"):
            out[k] += merged.get(k, 0)
        out["fetched"] += 1
        _append_state({"timestamp": cap.timestamp, "original": cap.original,
                       "at": _now(), "items": len(items),
                       "urls": sum(len(i.get("urls") or []) for i in items),
                       "added_forms": merged.get("added_forms", 0),
                       "new_images": merged.get("new_images", 0)},
                      state_file)
    return out
