"""Mine archived `/archive/YYYY/MM` and `/tagged/<tag>` pages for post evidence.

Why this exists
---------------
* Many Tumblr post permalinks were never captured, but the *listing* pages
  that mention them were. A listing page is therefore the only surviving
  evidence that a post existed, and it is often the only place its image URL
  (possibly at another CDN size variant) survives.
* Listing pages carry per-post thumbnails. When the permalink page's
  `<img src>` is a `confirmed archive gap`, the listing's size variant is a
  genuine second chance, not a guess: it is a real URL the crawl would have
  fetched.

Everything recorded here is copied from the archived HTML, with the capture
timestamp and the listing URL kept as provenance. Nothing is inferred: a post
seen only here is stored with `state="listing_only"` and stays unpublished
until its own page is recovered.
"""
from __future__ import annotations

import re
from html.parser import HTMLParser
from typing import Optional
from urllib.parse import urljoin

from .parsing import (POST_ID_RE, base_media_key, is_excluded_image, is_tumblr_media,
                      media_key, parse_image_variants)

LISTING_POST_ANCHOR_RE = re.compile(r"/post/(\d+)")


def _abs(base: str, url: str) -> str:
    url = (url or "").strip()
    if not url:
        return ""
    if url.startswith("//"):
        return "http:" + url
    if url.startswith(("http://", "https://")):
        return url
    if not base:
        return url
    return urljoin(base, url)


class _ListingCollector(HTMLParser):
    """Assign images to the post whose permalink was seen most recently.

    Tumblr's archive/tagged markup walks post after post:

        <article class="post"><a href="/post/123">..</a><img src="...500.jpg">...

    so "most recent `/post/<id>` anchor wins" is the page's own structure, not
    a guess. `unassigned` keeps images seen before any permalink so the caller
    can record them as unattributed evidence instead of dropping them.
    """

    def __init__(self, base_url: str):
        super().__init__(convert_charrefs=True)
        self.base_url = base_url
        self.current: Optional[str] = None
        self.posts: dict[str, dict] = {}
        self.order: list[str] = []
        self.unassigned: list[dict] = []
        self._seen_anchors: set[str] = set()

    # -- helpers
    def _post(self, pid: str) -> dict:
        rec = self.posts.get(pid)
        if rec is None:
            rec = {"post_id": pid, "images": [], "urls": []}
            self.posts[pid] = rec
            self.order.append(pid)
        return rec

    def _note_image(self, attrs: dict, via: str) -> None:
        src = attrs.get("src") or attrs.get("data-src") or ""
        src = _abs(self.base_url, src)
        attr_blob = " ".join(f'{k}="{v}"' for k, v in attrs.items())
        if is_excluded_image(src, attr_blob):
            return
        if not is_tumblr_media(src):
            return
        key = media_key(src)
        if not key:
            return
        entry = {
            "media_url": src,
            "media_key": key,
            "base_key": base_media_key(src),
            "caption_alt": attrs.get("alt", "") or attrs.get("title", ""),
            "found_in": f"listing:{via}",
            "url_forms": [src],
            "variants": parse_image_variants(src),
        }
        target = self.posts.get(self.current) if self.current else None
        if target is None:
            self.unassigned.append(entry)
            return
        known = {i.get("media_key") for i in target["images"]}
        if key in known:
            for have in target["images"]:
                if have.get("media_key") == key:
                    for v in parse_image_variants(src):
                        if v not in have.setdefault("variants", []):
                            have["variants"].append(v)
                    if src not in have.setdefault("url_forms", []):
                        have["url_forms"].append(src)
            return
        target["images"].append(entry)

    # -- HTMLParser hooks
    def handle_starttag(self, tag, attrs):
        a = {k.lower(): (v or "") for k, v in attrs}
        if tag == "a":
            m = LISTING_POST_ANCHOR_RE.search(a.get("href", ""))
            if m:
                pid = m.group(1)
                self.current = pid
                rec = self._post(pid)
                if a.get("href") not in rec["urls"]:
                    rec["urls"].append(a["href"])
            return
        if tag in ("img", "source"):
            self._note_image(a, "img")
            for extra in (a.get("srcset", ""), a.get("data-srcset", "")):
                for part in extra.split(","):
                    url = _abs(self.base_url, part.strip().split(" ")[0])
                    if url:
                        self._note_image({"src": url}, "srcset")

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)


def parse_listing_page(html: str, original_url: str, timestamp: str,
                       replay_url: str = "") -> dict:
    """Parse one archived listing page into per-post evidence.

    Returns `{"timestamp", "original_url", "replay_url", "posts": [...],
    "post_ids": [...], "unassigned_images": [...], "page_sha256"}`.
    """
    import hashlib

    col = _ListingCollector(original_url)
    try:
        col.feed(html or "")
        col.close()
    except Exception:  # pragma: no cover - malformed archived HTML
        pass
    posts = [col.posts[pid] for pid in col.order if col.posts[pid]["images"] or col.posts[pid]["urls"]]
    return {
        "original_url": original_url,
        "timestamp": timestamp,
        "replay_url": replay_url or "",
        "page_sha256": hashlib.sha256((html or "").encode("utf-8", "replace")).hexdigest(),
        "page_bytes": len((html or "").encode("utf-8", "replace")),
        "posts": posts,
        # Post ids seen only as an anchor (no thumbnail) still prove existence.
        "post_ids": [pid for pid in col.order],
        "unassigned_images": col.unassigned,
    }


def listing_kind(original_url: str) -> str:
    """Which listing family a captured URL belongs to."""
    u = (original_url or "").lower()
    if "/archive/" in u:
        return "archive"
    if "/tagged/" in u:
        return "tagged"
    if "/post/" in u:
        return "post_other"
    return "other"


def merge_listing_evidence(record: dict, evidences: list[dict]) -> dict:
    """Fold listing-page evidence into a post record without losing anything.

    * an image whose media key the record already knows is only *added as
      another URL form* -- it is the same photo, so the image count (and the
      "is this post complete" verdict) must not change;
    * an image with a new key becomes a real unresolved image entry, because a
      second photo of the post genuinely was referenced by the archive;
    * a post that only listing pages prove to exist is created with
      `state="listing_only"` and never marked recovered.
    """
    out = dict(record or {})
    images = [dict(i) for i in (out.get("images") or [])]
    by_key = {i.get("media_key"): i for i in images if i.get("media_key")}
    added = 0
    merged_forms = 0
    for ev in evidences:
        for img in ev.get("images") or []:
            key = img.get("media_key")
            have = by_key.get(key)
            if have is None:
                entry = dict(img)
                entry.setdefault("state", "unresolved")
                images.append(entry)
                by_key[key] = entry
                added += 1
                continue
            changed = False
            for form in [img.get("media_url", "")] + list(img.get("url_forms") or []):
                if form and form not in have.setdefault("url_forms", [have.get("media_url", "")]):
                    have["url_forms"].append(form)
                    changed = True
            for variant in img.get("variants") or []:
                if variant not in have.setdefault("variants", []):
                    have["variants"].append(variant)
                    changed = True
            if changed:
                have.setdefault("alt_sources", []).append(ev.get("listing_url", "listing"))
                merged_forms += 1
        for url in ev.get("urls") or []:
            urls = out.setdefault("listing_urls", [])
            if url not in urls:
                urls.append(url)
    out["images"] = images
    out["listing_evidence"] = int(out.get("listing_evidence", 0)) + len(evidences)
    out["listing_images_added"] = int(out.get("listing_images_added", 0)) + added
    out["listing_forms_merged"] = int(out.get("listing_forms_merged", 0)) + merged_forms
    sources = out.setdefault("listing_sources", [])
    for ev in evidences:
        entry = {"listing_url": ev.get("listing_url", ""),
                 "capture_timestamp": ev.get("timestamp", "")}
        if entry["listing_url"] and entry not in sources:
            sources.append(entry)
    if not out.get("state") or out.get("state") in ("", "pending"):
        out["state"] = "listing_only"
    missing = [i for i in images if not i.get("sha256")]
    out["missing_images"] = [
        {"media_url": i.get("media_url"), "reason": i.get("error"), "attempts": i.get("attempts", [])}
        for i in missing
    ]
    out["image_count"] = len([i for i in images if i.get("sha256")])
    out["missing_image_count"] = len(missing)
    out["partial"] = bool(missing)
    return out