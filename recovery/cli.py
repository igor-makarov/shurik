"""Crawler orchestration: discovery -> post pages -> images -> publish -> report."""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Optional

from . import config
from .cdx import Capture, CaptureIndex, cdx_query, normalize_url, within_cutoff, year_windows
from .http import (AFTER_CUTOFF_ONLY, BAD_BODY, GAP, OK, Fetcher, RateLimiter, Response)
from .images import blob_path, resolve_image, sniff_image, store_blob
from .media import MEDIA_CAPTURE_FILE, MediaIndex, hosts_for, scan_host, stems_of
from .parsing import parse_post_page, post_id_from_url
from .publish import Registry, publish_post
from .store import JsonlStore, PostStore, ensure_dirs, ledger_entry

POST_CAPTURE_FILE = os.path.join(config.CDX_DIR, "posts.jsonl")
LISTING_CAPTURE_FILE = os.path.join(config.CDX_DIR, "listing.jsonl")
MEDIA_CAPTURE_FILE = os.path.join(config.CDX_DIR, "media.jsonl")
POST_ID_RE = re.compile(r"/post/(\d+)")
# CDX matchType=prefix wants a bare directory prefix, never `.../*`.
POST_CAPTURE_PREFIX = "hazfalafel.com/post/"


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


# --------------------------------------------------------------------- discover
def discover_posts(fetcher: Fetcher, years: Optional[list[str]] = None, force: bool = False) -> dict:
    """Resumable CDX inventory of /post/* captures (year windows).

    NOTE: the CDX `prefix` match type must not be combined with a `*` suffix;
    `url=hazfalafel.com/post/*&matchType=prefix` returns `[]` while
    `url=hazfalafel.com/post/&matchType=prefix` returns every post capture.
    """
    index = CaptureIndex(POST_CAPTURE_FILE)
    stats = {"new": 0, "queries": 0, "skipped": 0}
    for start in (years or year_windows()):
        name = f"posts:{start}"
        if index.query_done(name) and not force:
            stats["skipped"] += 1
            continue
        params_year = start[:4]
        caps, resp = _cdx_window(fetcher, POST_CAPTURE_PREFIX, params_year)
        stats["queries"] += 1
        new = index.add(caps)
        stats["new"] += new
        index.mark_done(name, {"captures": len(caps), "new": new, "response_error": resp.error,
                               "status": resp.status, "message": resp.message[:200]})
    return {**stats, "total": len(index.all())}


def discover_listings(fetcher: Fetcher, force: bool = False) -> dict:
    """Archive/tag/monthly pages: discovery leads for posts without permalinks."""
    index = CaptureIndex(LISTING_CAPTURE_FILE)
    stats = {"new": 0, "queries": 0, "skipped": 0}
    for prefix in ("hazfalafel.com/archive/", "hazfalafel.com/tagged/", POST_CAPTURE_PREFIX):
        name = f"listing:{prefix}"
        if index.query_done(name) and not force:
            stats["skipped"] += 1
            continue
        caps, resp = cdx_query(fetcher, prefix, match="prefix", limit=20000)
        stats["queries"] += 1
        stats["new"] += index.add(caps)
        index.mark_done(name, {"captures": len(caps), "response_error": resp.error, "status": resp.status})
    return {**stats, "total": len(index.all())}


def _cdx_window(fetcher: Fetcher, url: str, year: str) -> tuple[list[Capture], Response]:
    caps, resp = cdx_query(fetcher, url, match="prefix", limit=50000,
                           extra={"from": year + "0101", "to": year + "1231"})
    return caps, resp


# ------------------------------------------------------------------ post pages
def post_captures(index: CaptureIndex) -> dict[str, list[Capture]]:
    """Group post captures by post id, permalink first, then amp, photoset, other."""
    kinds = {"perm": 0, "amp": 1, "photoset": 2, "other": 3}
    grouped: dict[str, list[Capture]] = {}
    for cap in index.all():
        url = normalize_url(cap.original)
        m = POST_ID_RE.search("/" + url.split("/", 1)[1] if "/" in url else url)
        if not m:
            continue
        if cap.statuscode not in ("200", ""):
            continue
        if not within_cutoff(cap.timestamp):
            continue
        grouped.setdefault(m.group(1), []).append(cap)
    for pid, caps in grouped.items():
        caps.sort(key=lambda c: (kinds.get(_kind(c), 4), c.timestamp))
    return grouped


MAX_FAILURES = int(os.environ.get("SHURIK_MAX_FAILURES", "3"))
# Failure classes that mean "the archive never said no": worth retrying later.
TRANSIENT_ERRORS = ("timeout", "throttled", "transport", "http_error")


def _attempt_errors(record: dict) -> list[str]:
    errs: list[str] = []
    for a in record.get("methods", []) or []:
        err = a.get("error")
        if err:
            errs.append(err)
    return errs


def _failures(record: dict) -> int:
    return int(record.get("failure_count", 0) or 0)


def _worth_retrying(record: dict) -> bool:
    """True when the last attempts failed for transient reasons only."""
    errs = _attempt_errors(record)
    if not errs:
        return True
    return any(e in TRANSIENT_ERRORS for e in errs)


def _kind(cap: Capture) -> str:
    u = normalize_url(cap.original)
    if "photoset_iframe" in u:
        return "photoset"
    if "/amp" in u:
        return "amp"
    if "?" in u:
        return "other"
    return "perm"


def fetch_posts(fetcher: Fetcher, limit: int = 10, post_ids: Optional[list[str]] = None,
                concurrency: int = config.DEFAULT_CONCURRENCY, kind_order: tuple[str, ...] = ("perm", "amp", "photoset"),
                max_per_post: int = 2) -> dict:
    """Download and parse archived post pages. Resumable via data/posts/*.json."""
    ensure_dirs()
    index = CaptureIndex(POST_CAPTURE_FILE)
    grouped = post_captures(index)
    store = PostStore()
    wanted = set(post_ids or [])
    todo: list[str] = []
    for pid in sorted(grouped, key=lambda p: int(p)):
        if wanted and pid not in wanted:
            continue
        existing = store.get(pid)
        # Captures are stored flat ({timestamp, original, kind, error}), so read
        # `timestamp` directly. Reading a nested `capture.timestamp` always
        # yielded {None} and made every post look unparsed: the crawl then
        # re-fetched the same posts forever instead of advancing.
        have = {c.get("timestamp") for c in existing.get("captures", []) if c.get("timestamp")}
        pending = [c for c in grouped[pid] if c.timestamp not in have]
        if existing.get("content_text") and not pending:
            continue
        # A post whose every known capture has already been replayed is done,
        # unless the last attempts failed transiently (timeout/throttle/
        # transport) or the failure budget is not yet spent. Without this the
        # queue head -- the lowest post ids, most of them permanent gaps --
        # is retried forever and the crawl never reaches the other 500 posts.
        if not pending and existing.get("state") == "failed":
            if not _worth_retrying(existing) or _failures(existing) >= MAX_FAILURES:
                continue
        todo.append(pid)
        if len(todo) >= limit:
            break

    ledger = JsonlStore(config.MISSING_JSONL, key_fields=("kind", "key"))
    missing_posts: list[dict] = []
    results: list[dict] = []

    def work(pid: str) -> dict:
        attempts: list[dict] = []
        records: list[dict] = []
        caps = [c for c in grouped[pid] if _kind(c) in kind_order]
        for cap in caps[: max_per_post * len(kind_order)]:
            resp = fetcher.replay(cap.timestamp, cap.original, mode="id_")
            attempt = {"url": cap.original, "endpoint": "replay id_", "kind": _kind(cap),
                       "capture_timestamp": cap.timestamp, "status": resp.status,
                       "error": resp.error, "message": resp.message, "bytes": len(resp.body or b"")}
            attempts.append(attempt)
            if not resp.ok or not resp.body:
                continue
            ctype = resp.headers.get("content-type", "")
            if "html" not in ctype and ctype:
                continue
            rec = parse_post_page(resp.text(), cap.original, cap.timestamp, resp.url)
            rec["captures"] = [{"timestamp": cap.timestamp, "original": cap.original,
                                "replay_url": resp.url, "kind": _kind(cap), "error": resp.error}]
            records.append(rec)
            if rec.get("content_text") and len(records) >= 1 and _kind(cap) == "perm":
                break
        best = max(records, key=lambda r: (1 if r.get("content_text") else 0,
                                           len(r.get("content_text") or ""),
                                           len(r.get("images") or []))) if records else None
        extra_caps = [{"timestamp": c.timestamp, "original": c.original, "kind": _kind(c),
                       "error": None} for c in caps[:20]]
        if best:
            merged = dict(best)
            merged["post_id"] = pid
            merged["canonical_urls"] = sorted({c.original for c in caps})
            merged["captures"] = extra_caps
            merged["fetched_at"] = _now()
            merged["methods"] = attempts
            merged["state"] = "fetched"
            store.put(pid, merged)
            return {"post_id": pid, "ok": True, "images": len(merged.get("images", [])),
                    "capture": merged.get("capture_timestamp"), "attempts": attempts}
        # no usable page: confirm a gap with the availability API before recording
        avail = _availability(fetcher, caps[0].original if caps else f"http://hazfalafel.com/post/{pid}")
        # Persist the failure in the post store too. A failure that lives only
        # in the ledger leaves the post with no stored captures, so the next
        # run sees every capture as pending and re-fetches it forever.
        err_by_ts = {a.get("capture_timestamp"): a.get("error") for a in attempts}
        prior = store.get(pid) or {}
        failed = {
            "post_id": pid,
            "state": "failed",
            "reason": avail,
            "failure_count": int(prior.get("failure_count", 0)) + 1,
            "original_url": f"http://hazfalafel.com/post/{pid}",
            "canonical_urls": sorted({c.original for c in caps}),
            "captures": [{"timestamp": c.timestamp, "original": c.original, "kind": _kind(c),
                          "error": err_by_ts.get(c.timestamp)} for c in caps[:20]],
            "content_html": "",
            "content_text": "",
            "captions": [],
            "tags": [],
            "images": [],
            "image_count": 0,
            "missing_image_count": 0,
            "methods": attempts,
            "fetched_at": _now(),
            "partial": False,
        }
        store.put(pid, failed)
        missing_posts.append(ledger_entry("post", pid, avail, attempts,
                                          {"post_url": f"http://hazfalafel.com/post/{pid}"}))
        return {"post_id": pid, "ok": False, "reason": avail}

    if not todo:
        return {"processed": 0, "note": "nothing pending; all inventoried posts fetched"}
    with ThreadPoolExecutor(max_workers=max(1, concurrency)) as pool:
        for res in pool.map(work, todo):
            results.append(res)
    if missing_posts:
        ledger.append(missing_posts)
    return {"processed": len(results), "ok": sum(1 for r in results if r.get("ok")),
            "missing": len(missing_posts), "results": results}


def _availability(fetcher: Fetcher, url: str) -> str:
    """Wayback availability API - separates a confirmed gap from a failure."""
    from urllib.parse import quote

    api = f"https://archive.org/wayback/available?url={quote(url, safe='')}&timestamp={config.CUTOFF}"
    resp = fetcher.get(api, attempts=1)
    if not resp.ok:
        return resp.error or "http_error"
    try:
        body = resp.json()
    except Exception:
        return "http_error"
    snap = (body.get("archived_snapshots") or {}).get("closest")
    if not snap:
        return GAP
    ts = snap.get("timestamp", "")
    return "capture_after_cutoff" if ts > config.CUTOFF else "snapshot_exists"


# ------------------------------------------------------------------- media CDX
def discover_media(fetcher: Fetcher, hosts: Optional[list[str]] = None, force: bool = False,
                   max_pages: int = 40, page_size: int = 50000) -> dict:
    """Inventory the Tumblr media hosts referenced by known posts.

    One paginated CDX query per host replaces one query per image; only rows
    whose media key a post actually references are kept in Git, while the full
    host dump stays in the ephemeral `data/work/media-dumps/` cache.
    """
    store = PostStore()
    urls = [img.get("media_url", "") for rec in store.all() for img in rec.get("images", [])]
    keys: set[str] = set()
    for url in urls:
        keys |= stems_of(url)
    targets = hosts or hosts_for(urls)
    index = MediaIndex(MEDIA_CAPTURE_FILE)
    results = []
    for host in targets:
        results.append(scan_host(fetcher, index, host, keys=keys, force=force,
                                 max_pages=max_pages, page_size=page_size))
    return {"hosts": len(targets), "known_keys": len(keys), "indexed": len(index),
            "results": results}


def reindex_media(hosts: Optional[list[str]] = None) -> dict:
    """Rebuild the committed media index from surviving host dumps (no network).

    Newly parsed posts bring new media keys; when a host dump from earlier in
    the run is still on disk the new keys can be answered without new CDX
    requests.
    """
    store = PostStore()
    urls = [img.get("media_url", "") for rec in store.all() for img in rec.get("images", [])]
    keys: set[str] = set()
    for url in urls:
        keys |= stems_of(url)
    targets = hosts or hosts_for(urls)
    index = MediaIndex(MEDIA_CAPTURE_FILE)
    results = []
    for host in targets:
        state = index.hosts_done().get(f"host:{host}") or {}
        if not state.get("complete"):
            results.append({"host": host, "skipped": "not fully scanned"})
            continue
        results.append(scan_host(None, index, host, keys=keys, force=False))
    return {"hosts": len(targets), "known_keys": len(keys), "indexed": len(index),
            "results": results}


# ---------------------------------------------------------------------- images
def fetch_images(fetcher: Fetcher, limit_posts: int = 5, concurrency: int = config.DEFAULT_CONCURRENCY,
                 post_ids: Optional[list[str]] = None, use_media_index: bool = True,
                 retry_missing: bool = False, method: str = "probe",
                 variant_budget: int = 4, order: str = "closest") -> dict:
    store = PostStore()
    ledger = JsonlStore(config.MISSING_JSONL, key_fields=("kind", "key"))
    media_index = MediaIndex(MEDIA_CAPTURE_FILE) if use_media_index else None
    pending = []
    for rec in store.all():
        if post_ids and rec.get("post_id") not in post_ids:
            continue
        if rec.get("missing_image_count", 0) == 0 and rec.get("image_count", 0) > 0 and rec.get("images_done"):
            continue
        if not rec.get("images"):
            continue
        pending.append(rec)
    if order == "closest":
        # Finish the posts that are one image away from being complete before
        # spending a variant sweep on posts that need a dozen. A post is only
        # "recovered" when all of its images are, so this maximises the number
        # of fully recovered posts per request spent.
        pending.sort(key=lambda r: (int(r.get("missing_image_count") or 0),
                                    int(r.get("post_id") or 0)))
    pending = [r["post_id"] for r in pending[:limit_posts]]

    missing_entries: list[dict] = []
    counts = {"recovered": 0, "missing": 0}
    # Outcomes the archive has already decided: re-probing them spends
    # requests for nothing. `capture_after_cutoff` is decided too -- the only
    # captures are too late, and the cutoff never moves.
    final_errors = ("archive_gap", "bad_body", AFTER_CUTOFF_ONLY)

    def work(pid: str) -> dict:
        rec = store.get(pid)
        images = rec.get("images") or []
        recovered = 0
        missing = 0
        merged: list[dict] = []
        for img in images:
            # Never drop an already recovered image on a rerun.
            if img.get("sha256") and img.get("blob_path"):
                merged.append(img)
                continue
            # A confirmed archive gap or a rejected body is only retried when
            # asked; transient classes (timeout/throttle/transport) always are.
            # A gap that predates the replay-probe method is re-opened too:
            # it was decided by one CDX query on the exact URL, which is weaker
            # evidence than a probe sweep over the size/extension variants.
            stale = needs_probe(img)
            if not retry_missing and img.get("error") in final_errors and not stale:
                merged.append(img)
                missing += 1
                continue
            resolved = resolve_image(fetcher, img, media_index=media_index,
                                     key_known_at=rec.get("fetched_at", ""),
                                     method=method, variant_budget=variant_budget)
            _assign_file(resolved)
            if resolved["state"] == "recovered":
                recovered += 1
                merged.append(resolved)
            else:
                missing += 1
                merged.append(resolved)
                entry = ledger_entry(
                    "image", resolved["media_url"], resolved.get("error") or "unknown",
                    resolved.get("attempts", []),
                    {"post_id": pid, "media_key": resolved.get("media_key"),
                     "caption": resolved.get("caption", "")})
                if resolved.get("host_inventory"):
                    entry["host_inventory"] = resolved["host_inventory"]
                missing_entries.append(entry)
        updated = dict(rec)
        updated["images"] = merged
        updated["images_done"] = True
        updated["fetched_at"] = _now()
        store.put(pid, updated)
        return {"post_id": pid, "recovered": recovered, "missing": missing}

    if not pending:
        return {"processed": 0, "note": "no posts with unresolved images"}
    results = []
    with ThreadPoolExecutor(max_workers=max(1, concurrency)) as pool:
        for res in pool.map(work, pending):
            results.append(res)
            counts["recovered"] += res["recovered"]
            counts["missing"] += res["missing"]
    if missing_entries:
        ledger.append(missing_entries)
    return {"processed": len(results), **counts, "results": results}


_EXT_BY_TYPE = {"image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif",
                "image/webp": ".webp", "image/bmp": ".bmp"}


def needs_probe(image: dict) -> bool:
    """Was this image ever decided by a replay probe (or a host inventory)?

    Images resolved before the probe method existed carry an `archive_gap` that
    was decided by a single CDX query on the exact URL only. That is weaker
    evidence than a probe sweep, so those records are re-opened automatically
    instead of waiting for `--retry-missing`.
    """
    for att in image.get("attempts") or []:
        if att.get("endpoint") in ("replay-probe", "media-index"):
            return False
    return True


def _assign_file(rec: dict) -> None:
    if not rec.get("sha256"):
        return
    ext = _EXT_BY_TYPE.get(rec.get("media_type") or "", ".bin")
    key = rec.get("media_key") or rec["sha256"]
    rec["file"] = f"{key}{ext}"


# --------------------------------------------------------------------- repair
def repair_posts() -> dict:
    """Re-derive bookkeeping fields in every stored post record (no network).

    Post files written by older runs may lack `post_id`/`published`; the
    derived counters (image_count, missing_image_count, state) are recomputed
    so that later runs can resume without network access.
    """
    store = PostStore()
    fixed = []
    for pid in store.ids():
        before = store.get(pid)
        after = store.put(pid, {})
        if before != after:
            fixed.append(pid)
    return {"posts": len(store.ids()), "repaired": fixed}


# --------------------------------------------------------------------- publish
def ensure_blob(fetcher: Fetcher, img: dict) -> tuple[bool, str]:
    """Make sure the recorded blob bytes exist locally, re-fetching if needed.

    `data/blobs/` is an ephemeral cache: a fresh runner has digests and replay
    URLs in Git but not the bytes. Re-download from the recorded pre-cutoff
    capture, validate the body is really an image, and never accept a
    different digest silently.
    """
    path = img.get("blob_path") or blob_path(img.get("sha256") or "")
    if img.get("sha256") and os.path.exists(path):
        return True, "cached"
    cap = img.get("capture") or {}
    if not cap.get("timestamp") or not cap.get("original"):
        return False, "no_recorded_capture"
    resp = fetcher.replay(cap["timestamp"], cap["original"], mode="id_")
    if not resp.ok or not resp.body:
        return False, resp.error or "http_error"
    mime = sniff_image(resp.body)
    if not mime:
        return False, BAD_BODY
    digest, path = store_blob(resp.body)
    if img.get("sha256") and digest != img["sha256"]:
        return False, "digest_mismatch"
    img["blob_path"] = path
    img["sha256"] = digest
    img["media_type"] = mime
    return True, "refetched"


def post_quality(post: dict) -> tuple[int, int, int]:
    """How much of a post an artifact would carry: (images, text, captions).

    Used so that a rerun can never replace a published artifact with one that
    carries fewer recovered images or less recovered text.
    """
    images = sum(1 for i in post.get("images", []) if i.get("sha256"))
    return images, len(post.get("content_text") or ""), len(post.get("captions") or [])


def publish(limit: int = 10, force: bool = False, registry: Optional[Registry] = None,
            only_missing: bool = False, fetcher: Optional[Fetcher] = None) -> dict:
    # Explicit path: PostStore's default argument binds config at import time,
    # so tests (and future multi-workspace runs) could not redirect the store.
    store = PostStore(config.POST_DIR)
    reg = registry or Registry()
    fetch = fetcher or Fetcher()
    log = JsonlStore(config.PUBLISHED_JSONL, key_fields=("tag", "manifest_digest"))
    results = []
    for rec in store.all():
        pid = rec.get("post_id")
        if not pid:
            continue
        # A post with captured text (or a recovered image) is publishable while
        # some of its images are still missing: the artifact says so explicitly
        # (`recovery.partial`, `missing_images`) and a later run republishes it
        # as soon as an image is recovered. Publishing nothing until the image
        # ledger drained would throw the recovered text away for no reason.
        if not rec.get("images") and not rec.get("content_text"):
            continue
        if not only_missing and rec.get("published") and not force:
            prev = tuple(rec["published"].get("quality") or ())
            if prev >= post_quality(rec):
                continue
        post = dict(rec)
        post["missing_images"] = rec.get("missing_images", [])
        # Ephemeral blob cache: re-fetch recorded captures before building.
        for img in post.get("images", []):
            if not img.get("sha256"):
                continue
            ok, why = ensure_blob(fetch, img)
            if not ok:
                results.append({"tag": pid, "action": "deferred", "reason": f"blob {img.get('media_url')}: {why}"})
                break
        else:
            try:
                pushed = publish_post(post, reg, force=force)
                # PushResult is a dataclass; every caller below works on a dict.
                res = dict(vars(pushed))
                results.append(res)
            except Exception as exc:
                results.append({"tag": pid, "action": "failed", "reason": f"{type(exc).__name__}: {exc}"[:300]})
                continue
            if res.get("action") in ("pushed", "updated", "skipped"):
                entry = {"tag": res.get("tag"), "action": res.get("action"),
                         "manifest_digest": res.get("manifest_digest", ""),
                         "config_digest": res.get("config_digest", ""),
                         "image_count": res.get("image_count", 0),
                         "missing_count": res.get("missing_count", 0),
                         "quality": list(post_quality(post)),
                         "post_id": pid, "at": _now()}
                log.append([entry])
                rec2 = dict(store.get(pid))
                rec2["published"] = {"at": entry["at"], "action": entry["action"],
                                     "manifest_digest": entry["manifest_digest"],
                                     "image_count": entry["image_count"],
                                     "missing_count": entry["missing_count"],
                                     "quality": list(post_quality(post))}
                store.put(pid, rec2)
        if len(results) >= limit:
            break
    return {"processed": len(results), "results": results}


# ---------------------------------------------------------------------- status
def status() -> dict:
    store = PostStore()
    posts = list(store.all())
    discovered = set()
    index = CaptureIndex(POST_CAPTURE_FILE)
    for cap in index.all():
        pid = post_id_from_url(cap.original)
        if pid:
            discovered.add(pid)
    recovered = [p for p in posts if p.get("image_count", 0) > 0]
    partial = [p for p in recovered if p.get("missing_image_count", 0) > 0]
    complete = [p for p in recovered if p.get("missing_image_count", 0) == 0]
    published = [p for p in posts if p.get("published")]
    missing_ledger = JsonlStore(config.MISSING_JSONL).records()
    media_index = CaptureIndex(MEDIA_CAPTURE_FILE)
    return {
        "discovered_posts": len(discovered),
        "captures_indexed": len(index.all()),
        "listing_captures": len(CaptureIndex(LISTING_CAPTURE_FILE).all()),
        "media_captures": len(media_index.all()),
        "posts_parsed": len(posts),
        "recovered_posts": len(recovered),
        "complete_posts": len(complete),
        "partial_posts": len(partial),
        "published_posts": len(published),
        "images_recovered": sum(p.get("image_count", 0) for p in posts),
        "images_missing": sum(p.get("missing_image_count", 0) for p in posts),
        "missing_ledger_entries": len(missing_ledger),
        "posts_without_permalink": len(discovered - {p.get("post_id") for p in posts}),
        "generated_at": _now(),
    }


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="shurik-recovery", description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("discover", help="CDX inventory of post/listing captures")
    p.add_argument("--listings", action="store_true", help="also inventory archive/tag pages")
    p.add_argument("--years", default="", help="comma separated year starts, e.g. 2017,2018")
    p.add_argument("--force", action="store_true")
    p = sub.add_parser("fetch-posts", help="download and parse archived post pages")
    p.add_argument("--limit", type=int, default=10)
    p.add_argument("--ids", default="")
    p.add_argument("--concurrency", type=int, default=config.DEFAULT_CONCURRENCY)
    p = sub.add_parser("discover-media", help="inventory tumblr media hosts (one query per host)")
    p.add_argument("--hosts", default="", help="comma separated hosts; default = hosts seen in posts")
    p.add_argument("--force", action="store_true")
    p.add_argument("--max-pages", type=int, default=40)
    p = sub.add_parser("reindex-media", help="rebuild media index from host dumps (offline)")
    p = sub.add_parser("fetch-images", help="resolve post images from the archive")
    p.add_argument("--limit", type=int, default=5)
    p.add_argument("--ids", default="")
    p.add_argument("--concurrency", type=int, default=config.DEFAULT_CONCURRENCY)
    p.add_argument("--no-media-index", action="store_true",
                   help="ignore data/cdx/media.jsonl and query the CDX per image")
    p.add_argument("--retry-missing", action="store_true",
                   help="retry confirmed gaps and rejected bodies too (default: transient only)")
    p.add_argument("--method", default="probe", choices=("probe", "cdx", "auto"),
                   help="existence check per image: replay probe (fast), CDX query (slow) or auto")
    p.add_argument("--variant-budget", type=int, default=4,
                   help="size/extension siblings probed after the exact URL misses")
    p.add_argument("--order", default="closest", choices=("closest", "post_id"),
                   help="which posts to spend requests on first")
    p = sub.add_parser("publish", help="push per-post artifacts to GHCR")
    p.add_argument("--limit", type=int, default=10)
    p.add_argument("--force", action="store_true")
    sub.add_parser("status", help="print recovery counters")
    sub.add_parser("repair", help="re-derive post bookkeeping fields (offline)")
    sub.add_parser("report", help="write RECOVERY_REPORT.md")
    args = parser.parse_args(argv)

    ensure_dirs()
    fetcher = Fetcher()
    out: dict = {}
    if args.cmd == "repair":
        out = repair_posts()
    elif args.cmd == "discover":
        years = [y.strip() for y in args.years.split(",") if y.strip()] or None
        out["posts"] = discover_posts(fetcher, years=years, force=args.force)
        if args.listings:
            out["listings"] = discover_listings(fetcher, force=args.force)
    elif args.cmd == "fetch-posts":
        out = fetch_posts(fetcher, limit=args.limit, concurrency=args.concurrency,
                          post_ids=[i for i in args.ids.split(",") if i] or None)
    elif args.cmd == "discover-media":
        out["media"] = discover_media(fetcher, hosts=[h.strip() for h in args.hosts.split(",") if h.strip()] or None,
                                      force=args.force, max_pages=args.max_pages)
    elif args.cmd == "reindex-media":
        out["media"] = reindex_media()
    elif args.cmd == "fetch-images":
        out = fetch_images(fetcher, limit_posts=args.limit, concurrency=args.concurrency,
                           post_ids=[i for i in args.ids.split(",") if i] or None,
                           use_media_index=not args.no_media_index, retry_missing=args.retry_missing,
                           method=args.method, variant_budget=args.variant_budget,
                           order=args.order)
    elif args.cmd == "publish":
        out = publish(limit=args.limit, force=args.force, fetcher=fetcher)
    elif args.cmd == "status":
        out = status()
    elif args.cmd == "report":
        from .report import write_report

        out = write_report()
    json.dump(out, sys.stdout, ensure_ascii=False, indent=1, default=str)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
