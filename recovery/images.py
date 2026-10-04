"""Resolve post images to archived bytes, with variant search and validation."""
from __future__ import annotations

import hashlib
import json
import os
import re
from typing import Optional

from . import config
from .cdx import Capture, cdx_query, normalize_url, within_cutoff
from .http import (BAD_BODY, GAP, OK, THROTTLED, TIMEOUT, TRANSPORT, Fetcher, Response)
from .parsing import base_media_key, media_key

IMAGE_MAGIC = (
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"GIF87a", "image/gif"),
    (b"GIF89a", "image/gif"),
    (b"BM", "image/bmp"),
)


def sniff_image(body: bytes) -> Optional[str]:
    """Return a media type when the body really is an image, else None."""
    if not body or len(body) < 12:
        return None
    for magic, mime in IMAGE_MAGIC:
        if body.startswith(magic):
            return mime
    if body[:4] == b"RIFF" and body[8:12] == b"WEBP":
        return "image/webp"
    head = body[:600].lstrip().lower()
    if head.startswith(b"<?xml") or head.startswith(b"<!doctype html") or b"<html" in head:
        return None
    return None


def store_blob(body: bytes) -> tuple[str, str]:
    """Persist bytes under data/blobs/<sha256> (gitignored; digest is in Git)."""
    digest = hashlib.sha256(body).hexdigest()
    path = os.path.join(config.BLOB_DIR, digest[:2], digest)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if not os.path.exists(path):
        tmp = path + ".tmp"
        with open(tmp, "wb") as fh:
            fh.write(body)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    return digest, path


def image_capture_candidates(fetcher: Fetcher, image_url: str, limit: int = 6) -> tuple[list[Capture], list[dict]]:
    """Query the CDX for one media URL and its size/extension variants."""
    attempts: list[dict] = []
    seen: set[str] = set()
    captures: list[Capture] = []

    for variant in _variants(image_url):
        norm = normalize_url(variant)
        if norm in seen:
            continue
        seen.add(norm)
        caps, resp = cdx_query(fetcher, norm, match="exact", limit=limit,
                               extra={"filter": "statuscode:200"})
        attempts.append({
            "url": variant,
            "endpoint": "cdx",
            "status": resp.status,
            "error": resp.error,
            "message": resp.message,
            "captures": len(caps),
        })
        captures.extend(caps)
    captures.sort(key=lambda c: c.timestamp)
    return captures, attempts


def _variants(image_url: str) -> list[str]:
    from .parsing import parse_image_variants

    return parse_image_variants(image_url)


def pick_capture(captures: list[Capture], prefer_base: str) -> Optional[Capture]:
    """Newest pre-cutoff capture whose media type looks like an image."""
    images = [c for c in captures if _usable(c)]
    if not images:
        # CDX media types are frequently wrong for Tumblr CDN URLs: an image can
        # be indexed as text/plain. Never let that hide the capture -- fall back
        # to any successful pre-cutoff capture so the body can be validated.
        images = [c for c in captures if c.statuscode == "200" and within_cutoff(c.timestamp)]
    if not images:
        return None
    same = [c for c in images if prefer_base and prefer_base in normalize_url(c.original)]
    pool = same or images
    return pool[-1]


def _usable(capture: Capture) -> bool:
    """A capture worth replaying first: pre-cutoff, 200, plausibly an image."""
    return (
        within_cutoff(capture.timestamp)
        and capture.statuscode == "200"
        and (not capture.mimetype or capture.mimetype.startswith(
            ("image/", "application/octet-stream")))
    )


def fetch_capture(fetcher: Fetcher, capture: Capture) -> Response:
    return fetcher.replay(capture.timestamp, capture.original, mode="id_")


def resolve_image(
    fetcher: Fetcher,
    image: dict,
    *,
    max_captures: int = 3,
) -> dict:
    """Try to recover one post image. Returns a durable attempt record.

    The returned record always carries the original URL, every CDX query and
    every replay attempt, plus either the blob digest or a classified failure.
    """
    url = image["media_url"]
    prefer_base = base_media_key(url) or ""
    record = {
        "media_url": url,
        "media_key": media_key(url),
        "base_key": prefer_base,
        "caption": image.get("caption_alt", ""),
        "found_in": image.get("found_in", ""),
        "state": "pending",
        "error": None,
        "sha256": None,
        "bytes": None,
        "media_type": None,
        "blob_path": None,
        "capture": None,
        "attempts": [],
    }
    captures, attempts = image_capture_candidates(fetcher, url)
    record["attempts"].insert(0, {
        "endpoint": "variant-plan",
        "media_url": url,
        "variants": _variants(url),
        "note": "every size/extension variant queried before declaring a gap",
    })
    record["attempts"].extend(attempts)
    record["capture_count"] = len(captures)

    # Group by original URL so we try each archived variant once, largest first.
    by_url: dict[str, list[Capture]] = {}
    for cap in captures:
        by_url.setdefault(normalize_url(cap.original), []).append(cap)

    candidates: list[Capture] = []
    for norm, caps in by_url.items():
        caps.sort(key=lambda c: c.timestamp)
        chosen = pick_capture(caps, prefer_base)
        if chosen:
            candidates.append(chosen)
    candidates.sort(key=lambda c: c.timestamp, reverse=True)

    tried = 0
    saw_non_image_body = False
    for cap in candidates[:max_captures]:
        tried += 1
        resp = fetch_capture(fetcher, cap)
        attempt = {
            "url": cap.original,
            "endpoint": "replay id_",
            "capture_timestamp": cap.timestamp,
            "status": resp.status,
            "error": resp.error,
            "message": resp.message,
            "bytes": len(resp.body or b""),
        }
        mime = sniff_image(resp.body or b"")
        if mime and resp.ok:
            digest, path = store_blob(resp.body)
            attempt["sha256"] = digest
            attempt["media_type"] = mime
            record["attempts"].append(attempt)
            record.update(
                state="recovered",
                error=None,
                sha256=digest,
                bytes=len(resp.body),
                media_type=mime,
                blob_path=path,
                capture={
                    "timestamp": cap.timestamp,
                    "original": cap.original,
                    "replay_url": resp.url,
                    "archive_digest": cap.digest,
                },
            )
            return record
        attempt["media_type"] = mime or "not-an-image"
        if resp.body and not mime and resp.error not in (TIMEOUT, THROTTLED, TRANSPORT):
            # The archive answered with a body, and that body is not an image:
            # its "this page has not been archived" HTML, a toolbar page, or an
            # error page. Confirmed unusable bytes -- not a transient failure.
            saw_non_image_body = True
            attempt["error"] = BAD_BODY
            attempt["message"] = (
                "archived body is not an image: "
                f"{len(resp.body)} bytes of "
                f"{resp.headers.get('content-type', 'unknown')}"
            )
        record["attempts"].append(attempt)

    # Only *failed* attempts classify the outcome. A successful CDX query that
    # simply returned nothing is a confirmed gap; a successful replay whose body
    # is not an image is a bad body. Neither is a timeout or a throttle.
    failures = [a.get("error") for a in record["attempts"]
                if a.get("error") and a.get("error") != OK]
    if saw_non_image_body:
        # The archive answered, but with HTML (its "not archived" page) instead of
        # image bytes. That is a confirmed unusable body, not a transient failure.
        record.update(state="missing", error=BAD_BODY,
                      note="captures existed but replays returned non-image bodies")
    elif not captures:
        record.update(
            state="missing",
            error=failures[-1] if failures else GAP,
            note="CDX returned zero captures for this media URL and its known variants",
        )
    else:
        last = failures[-1] if failures else BAD_BODY
        record.update(state="missing", error=last,
                      note="captures existed but no replay produced a valid image body")
    return record


def blob_path(digest: str) -> str:
    return os.path.join(config.BLOB_DIR, digest[:2], digest)
