#!/usr/bin/env python3
"""Recover non-Tumblr content images embedded in archived post bodies.

Some posts embed their picture on a third-party host (imgur, giphy,
memegenerator, cubeupload, the blog's own `gif.hazfalafel.com`) instead of the
Tumblr CDN.  `parsing.extract_images` deliberately keeps only Tumblr media, so
those post images were never queued for recovery at all.  This pass finds them
in the stored `content_html`, resolves each one against the Internet Archive
through the same `resolve_image` path the Tumblr images use, persists the bytes
and publishes the affected post artifacts.

Only pre-cutoff captures are used; the replay is fetched with the `id_` mode so
the archive returns the stored bytes rather than its injected live page.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from recovery import config  # noqa: E402
from recovery.cli import _assign_file, _publish_recovered, publish  # noqa: E402
from recovery.http import Fetcher  # noqa: E402
from recovery.images import resolve_image  # noqa: E402
from recovery.parsing import host_of  # noqa: E402
from recovery.store import PostStore  # noqa: E402
from recovery.verify import verify_tag  # noqa: E402

# Third-party hosts that carry *post content*.  `assets.tumblr.com`,
# `www.narendramodi.in` (share button), `g.hazfalafel.com` (embed logo) and the
# analytics hosts are theme/widget art and stay excluded.
CONTENT_HOSTS = (
    "i.imgur.com", "imgur.com", "i.giphy.com", "media.giphy.com",
    "media0.giphy.com", "media1.giphy.com", "media2.giphy.com", "media3.giphy.com",
    "media4.giphy.com", "memegenerator.net", "i.cubeupload.com",
    "gif.hazfalafel.com",
)
EXCLUDE_HINTS = (
    "avatar", "logo", "button", "badge", "icon", "spacer", "pixel", "tracking",
    "share", "widget", "gravatar", "banner", "ads",
)
IMG_TAG = re.compile(r"<img\b[^>]*>", re.I)
SRC_ATTR = re.compile(r"""(?:^|\s)(?:src|data-src)\s*=\s*["']([^"']+)""", re.I)
SRCSET_ATTR = re.compile(r"""(?:^|\s)(?:srcset|data-srcset)\s*=\s*["']([^"']+)""", re.I)


def _candidates(html: str) -> list[dict]:
    out: list[dict] = []
    seen: set[str] = set()
    for tag in IMG_TAG.findall(html or ""):
        urls: list[str] = []
        m = SRC_ATTR.search(tag)
        if m:
            urls.append(m.group(1))
        sm = SRCSET_ATTR.search(tag)
        if sm:
            for part in sm.group(1).split(","):
                u = part.strip().split(" ")[0]
                if u:
                    urls.append(u)
        alt_m = re.search(r"""\balt\s*=\s*["']([^"']*)""", tag, re.I)
        alt = alt_m.group(1).strip() if alt_m else ""
        for url in urls:
            url = url.replace("&amp;", "&").strip()
            if not url.lower().startswith(("http://", "https://")):
                continue
            host = host_of(url)
            if host not in CONTENT_HOSTS:
                continue
            low = url.lower()
            if any(h in low for h in EXCLUDE_HINTS):
                continue
            if url in seen:
                continue
            seen.add(url)
            out.append({"media_url": url, "caption_alt": alt, "found_in": "content-img"})
    return out


def _basename(url: str) -> str:
    name = url.split("?")[0].rsplit("/", 1)[-1]
    return name or url


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ids", default="", help="comma separated post ids to limit to")
    ap.add_argument("--limit", type=int, default=0, help="max posts to consider")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--no-publish", action="store_true")
    ap.add_argument("--no-verify", action="store_true")
    args = ap.parse_args(argv)

    store = PostStore()
    wanted = {i.strip() for i in args.ids.split(",") if i.strip()}
    records = [r for r in store.all() if not wanted or str(r.get("post_id")) in wanted]
    records.sort(key=lambda r: int(r["post_id"]))
    if args.limit:
        records = records[: args.limit]

    fetcher = Fetcher()
    result: dict = {"posts_scanned": 0, "candidates": 0, "recovered": 0,
                    "already": 0, "missing": 0, "deferred": 0, "published": [],
                    "verified": [], "details": []}
    for rec in records:
        cands = _candidates(rec.get("content_html") or "")
        if not cands:
            continue
        result["posts_scanned"] += 1
        pid = str(rec["post_id"])
        existing = {img.get("media_url") for img in rec.get("images") or []}
        images = list(rec.get("images") or [])
        changed = False
        for cand in cands:
            result["candidates"] += 1
            if cand["media_url"] in existing:
                result["already"] += 1
                continue
            if args.dry_run:
                result["details"].append({"post_id": pid, "url": cand["media_url"],
                                          "dry_run": True})
                continue
            if getattr(fetcher, "blocked", False):
                result["deferred"] += 1
                break
            img = dict(cand)
            img["media_key"] = _basename(img["media_url"])
            img["base_key"] = img["media_key"]
            img["variants"] = [img["media_url"]]
            resolved = resolve_image(fetcher, img, method="cdx")
            if resolved.get("state") != "recovered":
                result["missing"] += 1
                result["details"].append({"post_id": pid, "url": cand["media_url"],
                                          "state": resolved.get("state"),
                                          "error": resolved.get("error"),
                                          "note": resolved.get("note", "")[:200]})
                continue
            # Keep the real filename in the published layer instead of a bare
            # digest: `resolve_image` cannot derive a media_key for non-Tumblr
            # names (MEDIA_PATH_RE only matches `tumblr_*`).
            resolved["media_key"] = _basename(cand["media_url"])
            resolved["base_key"] = resolved["media_key"]
            _assign_file(resolved)
            images.append(resolved)
            existing.add(cand["media_url"])
            changed = True
            result["recovered"] += 1
            result["details"].append({"post_id": pid, "url": cand["media_url"],
                                      "sha256": resolved.get("sha256"),
                                      "bytes": resolved.get("bytes"),
                                      "capture": (resolved.get("capture") or {}).get("timestamp"),
                                      "file": resolved.get("file")})
        if changed:
            updated = dict(rec)
            updated["images"] = images
            store.put(pid, updated)
            if not args.no_publish:
                pub = _publish_recovered(pid)
                result["published"].append({"post_id": pid, "action": pub.get("action"),
                                            "images": pub.get("image_count"),
                                            "manifest": pub.get("manifest_digest", "")})
                if pub.get("action") in ("pushed", "updated") and not args.no_verify:
                    rep = verify_tag(pid)
                    result["verified"].append({"post_id": pid, "passed": rep.get("passed"),
                                               "images_verified": rep.get("images_verified"),
                                               "checks": f"{rep.get('checks_passed')}/{rep.get('checks_total')}"})
    json.dump(result, sys.stdout, ensure_ascii=False, indent=1, default=str)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
