"""Resolve post images to archived bytes, with variant search and validation."""
from __future__ import annotations

import hashlib
import json
import os
import re
from typing import Optional

from . import config
from .cdx import Capture, cdx_query, normalize_url, within_cutoff
from .http import (AFTER_CUTOFF_ONLY, BAD_BODY, GAP, HTTP_ERROR, OK, THROTTLED, TIMEOUT,
                   TRANSPORT, Fetcher, Response)
from .parsing import base_media_key, media_key

# The Wayback replay redirect embeds the real capture timestamp:
#   https://web.archive.org/web/20150106090204im_/http://40.media.tumblr.com/...
REPLAY_TS_RE = re.compile(r"/web/(\d{14})")
# Post records are committed to Git, so an attempt log stays bounded: the
# newest entries are kept and older ones are summarised, never dropped
# silently (`n_earlier_attempts` says how much history was folded in).
MAX_ATTEMPTS_PER_IMAGE = 8


def cap_attempts(attempts: list[dict], keep: int = MAX_ATTEMPTS_PER_IMAGE) -> list[dict]:
    """Bound an attempt log without losing the fact that it was longer."""
    if len(attempts) <= keep:
        return list(attempts)
    folded = len(attempts) - keep
    summary = {"endpoint": "attempt-log", "note": f"{folded} earlier attempt(s) folded into this "
               "summary; see data/missing.jsonl for the per-key history",
               "n_earlier_attempts": folded,
               "earlier_endpoints": sorted({str(a.get("endpoint")) for a in attempts[:folded]})}
    return [summary] + list(attempts[-keep:])

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


def image_capture_candidates(fetcher: Fetcher, image_url: str, limit: int = 6,
                            variant_budget: int = 4) -> tuple[list[Capture], list[dict]]:
    """Query the CDX for one media URL, then for its size/extension siblings.

    Wayback usually archives *some* size of a Tumblr file, not necessarily the
    one the post linked, so a zero-capture answer for the exact URL is not a
    gap. The exact URL is always queried first; siblings are queried only when
    it has nothing and only up to `variant_budget` of them, because the archive
    is slow and a full 9-variant sweep per image does not scale.

    The returned attempt list records every query (including the ones that were
    budgeted away) so the ledger can show what was actually tried.
    """
    attempts: list[dict] = []
    seen: set[str] = set()
    captures: list[Capture] = []

    def query(variant: str, note: str) -> None:
        norm = normalize_url(variant)
        if norm in seen:
            return
        seen.add(norm)
        caps, resp = cdx_query(fetcher, norm, match="exact", limit=limit,
                               extra={"filter": "statuscode:200"})
        attempts.append({
            "url": variant,
            "endpoint": "cdx",
            "note": note,
            "status": resp.status,
            "error": resp.error,
            "message": resp.message,
            "captures": len(caps),
        })
        captures.extend(caps)

    query(image_url, "exact URL from the post")
    if captures:
        attempts.append({
            "endpoint": "variant-plan",
            "note": f"exact URL has {len(captures)} capture(s); size/extension siblings not queried",
            "variants": _variants(image_url)[1:],
        })
        captures.sort(key=lambda c: c.timestamp)
        return captures, attempts
    siblings = [v for v in _variants(image_url) if normalize_url(v) != normalize_url(image_url)]
    if siblings:
        for variant in siblings[:variant_budget]:
            query(variant, "size/extension sibling of the linked image")
        if len(siblings) > variant_budget:
            attempts.append({
                "endpoint": "variant-budget",
                "note": f"{len(siblings)} siblings exist; only the first {variant_budget} "
                        f"were queried this pass",
                "variants": siblings[variant_budget:],
            })
    captures.sort(key=lambda c: c.timestamp)
    return captures, attempts


def _variants(image_url: str) -> list[str]:
    from .parsing import parse_image_variants

    return parse_image_variants(image_url)


# ------------------------------------------------------- replay-probe discovery
def probe_media_capture(fetcher: Fetcher, url: str, at_ts: Optional[str] = None,
                        backsteps: int = 2) -> tuple[Optional[Capture], list[dict], bool]:
    """Does the archive hold this exact media URL? One request per attempt.

    The replay endpoint answers `302` + `Location: .../web/<capture-ts>im_/...`
    when a capture exists and `404` when it does not, using the same capture
    index the CDX endpoint reads. That makes it a cheap, authoritative
    existence probe.

    `at_ts` is the *requested* capture time; the archive answers with the
    closest capture, which can be *after* it. A capture newer than the cutoff
    is never used: the probe steps back a day at a time and, if that finds
    nothing older, reports `after_cutoff_only` so the ledger distinguishes a
    real archive gap from "archived, but only too late".
    """
    attempts: list[dict] = []
    requested = at_ts or config.CUTOFF
    saw_after_cutoff = False
    for step in range(max(1, backsteps + 1)):
        resp = fetcher.probe_replay(url, at_ts=requested)
        location = resp.headers.get("location", "") or ""
        m = REPLAY_TS_RE.search(location)
        captured = m.group(1) if m else ""
        attempt = {
            "url": url,
            "endpoint": "replay-probe",
            "requested_timestamp": requested,
            "capture_timestamp": captured or None,
            "status": resp.status,
            "error": resp.error,
            "message": resp.message[:200],
            "location": location[:200],
        }
        attempts.append(attempt)
        if resp.error in (TIMEOUT, THROTTLED, TRANSPORT, HTTP_ERROR):
            return None, attempts, saw_after_cutoff
        if captured:
            if captured <= config.CUTOFF:
                return (Capture(timestamp=captured, original=url, statuscode="200",
                                mimetype="", urlkey="", digest="", length="",
                                redirect="", source_query=f"replay-probe:{requested}"),
                        attempts, saw_after_cutoff)
            saw_after_cutoff = True
            # Step back a day from the too-late capture and ask again.
            try:
                requested = str(int(captured) - 86400)
            except ValueError:
                return None, attempts, saw_after_cutoff
            continue
        if resp.status == 200:
            # Rare: the replay served the capture directly instead of redirecting.
            return (Capture(timestamp=requested, original=url, statuscode="200",
                            mimetype=resp.headers.get("content-type", ""), urlkey="", digest="",
                            length=str(len(resp.body or b"")), redirect="",
                            source_query=f"replay-probe:{requested}"),
                    attempts, saw_after_cutoff)
        # 404/410 (or anything else without a Location): nothing is archived.
        return None, attempts, saw_after_cutoff
    return None, attempts, saw_after_cutoff


def image_capture_candidates_probe(fetcher: Fetcher, image_url: str, variant_budget: int = 4,
                                   backsteps: int = 2) -> tuple[list[Capture], list[dict], bool]:
    """Exact URL first, then a bounded sweep of its size/extension siblings.

    Every request is one replay probe (seconds), not one CDX query (tens of
    seconds), so the sibling sweep is affordable here in a way it never was
    with the CDX endpoint.
    """
    attempts: list[dict] = []
    captures: list[Capture] = []
    after_cutoff_only = False
    variants = _variants(image_url)
    siblings = [v for v in variants if normalize_url(v) != normalize_url(image_url)]
    plan = [image_url] + siblings[: max(0, variant_budget)]
    if len(siblings) > variant_budget:
        attempts.append({"endpoint": "variant-budget",
                         "note": f"{len(siblings)} siblings exist; this pass probed the first "
                                 f"{variant_budget}; the rest stay queued for a later run",
                         "variants": siblings[variant_budget:]})
    for variant in plan:
        cap, att, after = probe_media_capture(fetcher, variant, backsteps=backsteps)
        attempts.extend(att)
        after_cutoff_only = after_cutoff_only or after
        if cap:
            captures.append(cap)
            # A hit on the exact URL settles the image: probing the remaining
            # siblings would only spend requests. Compare the probed variant
            # itself -- normalize_url() strips the scheme, so comparing it to
            # the capture's original URL never matched and the sweep never
            # stopped early.
            if variant == image_url:
                attempts.append({"endpoint": "probe-stop",
                                 "note": "exact URL is archived; remaining siblings not probed"})
                break
    captures.sort(key=lambda c: c.timestamp)
    return captures, attempts, after_cutoff_only


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
    media_index=None,
    key_known_at: str = "",
    method: str = "probe",
    variant_budget: int = 4,
    backsteps: int = 2,
) -> dict:
    """Try to recover one post image. Returns a durable attempt record.

    The returned record always carries the original URL, every CDX query and
    every replay attempt, plus either the blob digest or a classified failure.

    When a host-level media inventory (`MediaIndex`) is available it answers the
    "does any variant of this file exist?" question from Git instead of issuing
    one CDX query per size variant; the per-image CDX query stays as the
    fallback for hosts that were never inventoried.

    A *complete* host inventory that was taken after this key was already known
    is positive evidence of absence: every pre-cutoff `statuscode:200` row of
    that host has been enumerated, so the gap is confirmed and no per-variant
    CDX query is spent re-confirming it.

    `method` selects how existence is decided:

    * ``"probe"`` (default): one bounded replay request per URL/variant. Fast,
      authoritative, and it reports the capture timestamp it was redirected to.
    * ``"cdx"``: the older, much slower CDX query path, kept for hosts where
      replay probing has been observed to answer unreliably.
    * ``"auto"``: probe, and fall back to the CDX only when the probe itself
      failed transiently (never when the archive authoritatively said "no").
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
    captures: list[Capture] = []
    record["attempts"].append({
        "endpoint": "variant-plan",
        "media_url": url,
        "variants": _variants(url),
        "note": "every size/extension variant considered before declaring a gap",
    })
    if media_index is not None:
        local = media_index.lookup(url)
        if local:
            captures = local
            record["attempts"].append({
                "endpoint": "media-index",
                "media_url": url,
                "captures": len(local),
                "note": "answered from the host media inventory; per-variant CDX queries skipped",
            })
        else:
            from .media import host_of

            state = media_index.host_complete(host_of(url))
            if state and _conclusive(state, key_known_at):
                record["host_inventory"] = {"host": host_of(url), "rows": state.get("rows"),
                                            "pages": state.get("pages"),
                                            "scanned_at": state.get("scanned_at"),
                                            "keys_at_scan": state.get("keys_at_scan")}
                record["attempts"].append({
                    "endpoint": "media-index",
                    "media_url": url,
                    "host": host_of(url),
                    "rows": state.get("rows"),
                    "captures": 0,
                    "note": "host fully inventoried after this key was known; no pre-cutoff "
                            "capture of the host references this media key",
                })
                record.update(state="missing", error=GAP, capture_count=0,
                              note="host media inventory is complete and lists no capture for "
                                   "this key (or any size variant) on this CDN host")
                return record
    after_cutoff_only = False
    probe_conclusive = False
    if not captures and method in ("probe", "auto"):
        extra, attempts, after_cutoff_only = image_capture_candidates_probe(
            fetcher, url, variant_budget=variant_budget, backsteps=backsteps)
        captures.extend(extra)
        record["attempts"].extend(attempts)
        # A probe that was answered (200/404, not a timeout/throttle) is
        # authoritative about existence; only a transient failure leaves doubt.
        probe_conclusive = any(a.get("endpoint") == "replay-probe" and a.get("error") in (OK, GAP)
                               for a in attempts)
    if not captures and (method == "cdx" or (method == "auto" and not probe_conclusive)):
        extra, attempts = image_capture_candidates(fetcher, url)
        captures.extend(extra)
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

    # Only *failed* attempts classify the outcome. A successful probe/CDX query
    # that simply returned nothing is a confirmed gap; a successful replay
    # whose body is not an image is a bad body. Neither is a timeout or a
    # throttle.
    failures = [a.get("error") for a in record["attempts"]
                if a.get("error") and a.get("error") != OK]
    record["attempts"] = cap_attempts(record["attempts"])
    if saw_non_image_body:
        # The archive answered, but with HTML (its "not archived" page) instead of
        # image bytes. That is a confirmed unusable body, not a transient failure.
        record.update(state="missing", error=BAD_BODY,
                      note="captures existed but replays returned non-image bodies")
    elif not captures and after_cutoff_only:
        record.update(state="missing", error=AFTER_CUTOFF_ONLY,
                      note="the only capture(s) the archive has for this URL (or its variants) "
                           f"are newer than the cutoff {config.CUTOFF}; using them is forbidden")
    elif not captures:
        record.update(
            state="missing",
            error=failures[-1] if failures else GAP,
            note=("replay probes answered for this URL and its known size/extension variants "
                  "and none of them has a capture at or before the cutoff"
                  if method != "cdx" else
                  "CDX returned zero captures for this media URL and its known variants"),
        )
    else:
        last = failures[-1] if failures else BAD_BODY
        record.update(state="missing", error=last,
                      note="captures existed but no replay produced a valid image body")
    return record


def _conclusive(state: dict, key_known_at: str) -> bool:
    """Is a complete host scan evidence about *this* key?

    True when the scan finished after the key was discovered (so the scan
    certainly knew about the key), or when no discovery time is available and
    the scan is complete. A scan that predates the key is *not* conclusive --
    the key was not part of the filter set then.
    """
    scanned = _epoch(state.get("scanned_at", ""))
    known = _epoch(key_known_at)
    if scanned is None:
        return False
    return known is None or scanned >= known


def _epoch(stamp: str) -> Optional[float]:
    import datetime

    if not stamp or not isinstance(stamp, str) or len(stamp) < 10:
        return None
    try:
        return datetime.datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def blob_path(digest: str) -> str:
    return os.path.join(config.BLOB_DIR, digest[:2], digest)
