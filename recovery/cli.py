"""Crawler orchestration: discovery -> post pages -> images -> publish -> report."""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Optional

from . import config
from .availability import AvailabilityIndex, sweep as availability_sweep
from .cdx import (Capture, CaptureIndex, cdx_query, normalize_url, within_cutoff,
                  year_windows)
from .images import stem_prefix
from .stemindex import SCOPE as STEM_SCOPE, StemIndex
from .http import (AFTER_CUTOFF_ONLY, BAD_BODY, GAP, OK, Fetcher, RateLimiter, Response)
from .gaps import best_capture, prove
from .images import (TRANSIENT_CLASSES, blob_path, inherit_image_captions,
                     resolve_image, sniff_image, store_blob)
from .listing import (listing_kind, merge_listing_evidence, parse_listing_page)
from .media import (HOST_RE, MEDIA_CAPTURE_FILE, SHARED_MEDIA_HOSTS, MediaIndex, host_of,
                    hosts_for, scan_host, stems_of)
from . import hostdump
from .parsing import extract_images, parse_post_page, post_id_from_url
from .publish import Registry, publish_post
from .queue import ImageQueue
from .restore import restore_post, restore_posts
from .store import JsonlStore, PostStore, ensure_dirs, ledger_entry

POST_CAPTURE_FILE = os.path.join(config.CDX_DIR, "posts.jsonl")
LISTING_CAPTURE_FILE = os.path.join(config.CDX_DIR, "listing.jsonl")
MEDIA_CAPTURE_FILE = os.path.join(config.CDX_DIR, "media.jsonl")
AVAILABILITY_FILE = os.path.join(config.CDX_DIR, "avail.jsonl")


def capture_file(name: str) -> str:
    """Inventory path resolved at call time.

    The module constants above are import-time snapshots of config.CDX_DIR.
    Using them directly meant a test (or any alternate data root) that moved
    config.CDX_DIR kept reading and writing the repository's committed
    inventories -- which is how an offline test could "recover" a post out of
    the real data/posts directory.
    """
    return os.path.join(config.CDX_DIR, name)
POST_ID_RE = re.compile(r"/post/(\d+)")
# CDX matchType=prefix wants a bare directory prefix, never `.../*`.
POST_CAPTURE_PREFIX = "hazfalafel.com/post/"
# Listing families beyond archive/tagged/post. The main index (`/page/N`) and the
# mobile index enumerate the most recent 20 posts at their capture time, so a
# 2019 snapshot carries 2019 posts that the monthly archive pages never showed
# (the archive index stops at what the theme paginated to). Measured 2026-10:
# `/page/2` capture 20190824090303 named 9 posts absent from the corpus and 8
# photos on 66.media.tumblr.com -- a shard with real captures. They were never
# fetched because `discover_listings` only indexed archive/tagged/post.
EXTRA_LISTING_PREFIXES = (
    "hazfalafel.com/page/",
    "hazfalafel.com/mobile",
    "hazfalafel.com/category/",
    "hazfalafel.com/rss",
)


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


# --------------------------------------------------------------------- discover
def discover_posts(fetcher: Fetcher, years: Optional[list[str]] = None, force: bool = False) -> dict:
    """Resumable CDX inventory of /post/* captures (year windows).

    NOTE: the CDX `prefix` match type must not be combined with a `*` suffix;
    `url=hazfalafel.com/post/*&matchType=prefix` returns `[]` while
    `url=hazfalafel.com/post/&matchType=prefix` returns every post capture.
    """
    index = CaptureIndex(capture_file("posts.jsonl"))
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
        info = {"captures": len(caps), "new": new, "response_error": resp.error,
                "status": resp.status, "message": resp.message[:200]}
        if resp.ok:
            index.mark_done(name, info)
        else:
            # A failed request is not a "no captures" answer. Leave the window
            # retryable instead of settling it (see CaptureIndex.mark_failed).
            index.mark_failed(name, info)
            stats.setdefault("failed", []).append(name)
    return {**stats, "total": len(index.all())}


def discover_listings(fetcher: Fetcher, force: bool = False) -> dict:
    """Archive/tag/monthly pages: discovery leads for posts without permalinks."""
    index = CaptureIndex(capture_file("listing.jsonl"))
    stats = {"new": 0, "queries": 0, "skipped": 0}
    for prefix in ("hazfalafel.com/archive/", "hazfalafel.com/tagged/",
                   POST_CAPTURE_PREFIX, *EXTRA_LISTING_PREFIXES):
        name = f"listing:{prefix}"
        if index.query_done(name) and not force:
            stats["skipped"] += 1
            continue
        caps, resp = cdx_query(fetcher, prefix, match="prefix", limit=20000)
        stats["queries"] += 1
        stats["new"] += index.add(caps)
        info = {"captures": len(caps), "response_error": resp.error, "status": resp.status}
        if resp.ok:
            index.mark_done(name, info)
        else:
            index.mark_failed(name, info)
            stats.setdefault("failed", []).append(name)
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
# Real replay attempts spent on a post whose capture exists in the index but
# answered 404 (see _worth_retrying). Bounded so the numeric queue head cannot
# be held forever by the same posts.
SNAPSHOT_MAX_RETRIES = int(os.environ.get("SHURIK_SNAPSHOT_RETRIES", "4"))
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
    """True when the last attempts failed for transient reasons only.

    `reason == "snapshot_exists"` is the important exception. It means the
    Wayback availability API still reports a pre-cutoff capture for the URL
    while every replay attempt answered 404. That is *not* a confirmed archive
    gap: the capture is in the index, the replay backend just did not serve it
    (verified on post 13397484447 -- capture 20120426030759, replay 404 at
    crawl time, 200/52070 bytes on a later attempt). Treating those as final
    permanently abandoned 19 posts that the archive can still deliver, so they
    stay retryable until `SNAPSHOT_MAX_RETRIES` real attempts have been spent.
    """
    errs = _attempt_errors(record)
    if record.get("reason") == "snapshot_exists":
        return int(record.get("snapshot_retries", 0) or 0) < SNAPSHOT_MAX_RETRIES
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


def _replayed(record: dict) -> dict[str, list[dict]]:
    """Map capture timestamp -> the real replay attempts recorded for it.

    The stored `captures` list is an *inventory* (every capture the CDX knows,
    up to 20), not a record of what this crawl actually fetched. Only `methods`
    holds genuine replay attempts, so it is the correct source for deciding
    whether a capture is still pending.
    """
    out: dict[str, list[dict]] = {}
    for a in record.get("methods") or []:
        if not isinstance(a, dict):
            continue
        ts = a.get("capture_timestamp")
        if ts:
            out.setdefault(ts, []).append(a)
    return out


def _capture_pending(cap: Capture, replayed: dict[str, list[dict]]) -> bool:
    """True when this capture still deserves a replay request.

    A definitive answer (200/404/after-cutoff) settles the capture. A transient
    answer (timeout/throttle/transport) stays pending, but only for a bounded
    number of attempts so a permanently broken capture cannot be retried
    forever.
    """
    atts = replayed.get(cap.timestamp)
    if not atts:
        return True
    if atts[-1].get("error") not in TRANSIENT_ERRORS:
        return False
    return len(atts) < MAX_FAILURES


def _merge_methods(old: Optional[list], new: Optional[list]) -> list[dict]:
    """Union replay attempts, keeping the latest attempt per (capture, endpoint).

    `methods` is replaced wholesale on every store.put, so a pass that only
    replays the still-pending captures would erase the earlier attempts and
    make the crawl re-replay captures it already fetched. Merging keeps the
    cumulative replay set stable across fresh runners.
    """
    order: list[tuple] = []
    by_key: dict[tuple, dict] = {}
    for a in list(old or []) + list(new or []):
        if not isinstance(a, dict):
            continue
        key = (a.get("capture_timestamp"), a.get("endpoint"))
        if key not in by_key:
            order.append(key)
        by_key[key] = a
    return [by_key[k] for k in order]


def fetch_posts(fetcher: Fetcher, limit: int = 10, post_ids: Optional[list[str]] = None,
                concurrency: int = config.DEFAULT_CONCURRENCY,
                kind_order: tuple[str, ...] = ("perm", "amp", "photoset", "other"),
                max_per_post: int = 2) -> dict:
    """Download and parse archived post pages. Resumable via data/posts/*.json."""
    ensure_dirs()
    index = CaptureIndex(capture_file("posts.jsonl"))
    grouped = post_captures(index)
    store = PostStore()
    wanted = set(post_ids or [])
    todo: list[str] = []
    for pid in sorted(grouped, key=lambda p: int(p)):
        if wanted and pid not in wanted:
            continue
        existing = store.get(pid)
        # A capture counts as *done* only when it was actually replayed. The
        # stored `captures` list is an inventory (up to 20 per post), not the
        # set this crawl fetched, so treating it as the "have" set marked
        # captures as done after replaying at most a handful -- permanently
        # skipping the alternate snapshots that expose extra photoset members
        # and unseen CDN URL forms. Derive the pending set from `methods`.
        replayed = _replayed(existing)
        pending = [c for c in grouped[pid] if _capture_pending(c, replayed)]
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
        prior = store.get(pid) or {}
        replayed = _replayed(prior)
        caps = [c for c in grouped[pid] if _kind(c) in kind_order]
        # Replay only the captures that still lack a definitive attempt, primary
        # page first. Replaying the alternate snapshots is what surfaces photoset
        # members and CDN URL forms the earliest capture never carried; the old
        # code replayed a fixed first-N slice (mostly already-fetched) and then
        # marked up to 20 captures done, so those snapshots were never read.
        pending = [c for c in caps if _capture_pending(c, replayed)]
        pending.sort(key=lambda c: (0 if _kind(c) == "perm" else 1, c.timestamp))
        for cap in pending[: max_per_post * len(kind_order)]:
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
        best = max(records, key=lambda r: (1 if r.get("content_text") else 0,
                                           len(r.get("content_text") or ""),
                                           len(r.get("images") or []))) if records else None
        extra_caps = [{"timestamp": c.timestamp, "original": c.original, "kind": _kind(c),
                       "error": None} for c in caps[:20]]
        merged_methods = _merge_methods(prior.get("methods"), attempts)
        if best:
            merged = dict(best)
            merged["post_id"] = pid
            merged["canonical_urls"] = sorted({c.original for c in caps})
            merged["captures"] = extra_caps
            merged["fetched_at"] = _now()
            merged["methods"] = merged_methods
            merged["state"] = "fetched"
            store.put(pid, merged)
            return {"post_id": pid, "ok": True, "images": len(merged.get("images", [])),
                    "capture": merged.get("capture_timestamp"), "attempts": attempts}
        if prior.get("content_text"):
            # The alternate snapshots carried no new page content, but their
            # attempts must be recorded so they are not replayed again. Keep the
            # already-parsed post (merge_post keeps the longer content).
            store.put(pid, {"post_id": pid, "methods": merged_methods,
                            "captures": extra_caps, "fetched_at": _now()})
            return {"post_id": pid, "ok": True, "note": "no new content from alternate captures",
                    "attempts": attempts}
        # no usable page: confirm a gap with the availability API before recording
        avail = _availability(fetcher, caps[0].original if caps else f"http://hazfalafel.com/post/{pid}")
        # Persist the failure in the post store too. A failure that lives only
        # in the ledger leaves the post with no stored captures, so the next
        # run sees every capture as pending and re-fetches it forever.
        err_by_ts = {a.get("capture_timestamp"): a.get("error") for a in attempts}
        failed = {
            "post_id": pid,
            "state": "failed",
            "reason": avail,
            "failure_count": int(prior.get("failure_count", 0)) + 1,
            "snapshot_retries": int(prior.get("snapshot_retries", 0)) + 1 if avail == "snapshot_exists" else 0,
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
            "methods": merged_methods,
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
    # Most-referenced hosts first: an iteration has a bounded budget and a host
    # scan is many slow requests, so the hosts that could unlock the most
    # images must not queue behind the ones that matter least.
    refs: dict[str, int] = {}
    for url in urls:
        refs[host_of(url)] = refs.get(host_of(url), 0) + 1
    targets = sorted(targets, key=lambda h: (-refs.get(h, 0), h))
    index = MediaIndex(capture_file("media.jsonl"))
    results = []
    for host in targets:
        state = index.hosts_done().get(f"host:{host}") or {}
        # A host proven to be an ocean (shared shard, full pages forever) costs
        # hundreds of requests to inventory and would never finish. Skip it and
        # spend the budget on per-image replay probes instead, which are
        # authoritative per URL.
        if state.get("oversized") and not force:
            results.append({"host": host, "skipped": "oversized host: inventory not conclusive",
                            "rows": state.get("rows"), "pages": state.get("pages")})
            continue
        results.append(scan_host(fetcher, index, host, keys=keys, force=force,
                                 max_pages=max_pages, page_size=page_size))
    return {"hosts": len(targets), "known_keys": len(keys), "indexed": len(index),
            "order": targets, "results": results}


def dump_media_hosts(fetcher: Fetcher, hosts: Optional[list[str]] = None,
                     max_pages: int = 60, limit: int = hostdump.PAGE_LIMIT,
                     priority: str = "pending") -> dict:
    """Complete each media host with the exact `resumeKey` cursor, then index.

    This is the cheap bulk discovery path: a host with ~5k pre-cutoff captures
    costs ~5 CDX pages and answers every one of its keys at once, while the
    per-stem path costs one request per image for the same answer. The old
    `page=` cursor truncated and stamped `complete`, so its "confirmed gaps" were
    partly fiction; see `recovery/hostdump.py`.
    """
    store = PostStore()
    urls = [img.get("media_url", "") for rec in store.all() for img in rec.get("images", [])]
    keys: set[str] = set()
    for url in urls:
        keys |= stems_of(url)
    refs: dict[str, int] = {}
    pending: dict[str, int] = {}
    for url in urls:
        host = host_of(url)
        refs[host] = refs.get(host, 0) + 1
    for rec in store.all():
        for img in rec.get("images") or []:
            url = img.get("media_url", "")
            if not url or img.get("sha256"):
                continue
            # Weight by *unresolved images*, not by stems the stem index has
            # not answered. Once every stem is answered (the usual state after a
            # `stem-scan` pass) a host dump's remaining value is finding a
            # hashed-directory or other-shard capture the per-stem prefix query
            # cannot see, for any unresolved image on the host. The old weight
            # was all zeros then, so `--priority pending` ordered hosts
            # alphabetically and never favoured the ones with work.
            host = host_of(url)
            pending[host] = pending.get(host, 0) + 1
    targets = hosts or [h for h in refs if HOST_RE.match(h or "") and h not in SHARED_MEDIA_HOSTS]
    weight = pending if priority == "pending" else refs
    targets = sorted(targets, key=lambda h: (-weight.get(h, 0), h))
    media_index = MediaIndex(capture_file("media.jsonl"))
    results = []
    for host in targets:
        res = hostdump.scan_host(fetcher, host, keys=keys, index=media_index.index,
                                 max_pages=max_pages, limit=limit)
        res["weight"] = weight.get(host, 0)
        results.append(res)
    return {"hosts": len(targets), "known_keys": len(keys), "indexed": len(media_index),
            "indexed_rows": len(media_index), "order": targets, "results": results,
            "dumps": hostdump.DUMP_DIR}


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
    index = MediaIndex(capture_file("media.jsonl"))
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
def prove_gaps(fetcher: Fetcher, limit: int = 25, alt_hosts: int = 2,
               force: bool = False, shard_sweep: bool = False,
               urls: Optional[list[str]] = None) -> dict:
    """Turn "this exact URL is not archived" into a file-level gap verdict.

    Resumable: every verdict is appended to data/gaps.jsonl as it is reached,
    and a verdict is only final when it is `confirmed_gap` or
    `capture_found`. `inconclusive` rows (429/5xx/timeout) are retried on the
    next run, so throttling can never become a permanent "missing".

    Any capture a proof finds is appended to data/cdx/media.jsonl, the index
    `fetch-images` reads, so a hit is fetchable without re-querying the CDX.

    `shard_sweep=True` asks every numbered Tumblr CDN host (not just the one the
    post page referenced), which upgrades a `referenced_host` verdict to the
    strongest available evidence. A shard sweep costs ~72 CDX queries, so it is
    opt-in and bounded by `limit`; a shard-sweep verdict supersedes the weaker
    one for the same file, but a weaker verdict never replaces a sweep.
    """
    store = PostStore()
    ledger = JsonlStore(config.GAPS_JSONL, key_fields=("media_url",))
    done = {r.get("media_url"): r for r in ledger.records()}
    media = JsonlStore(capture_file("media.jsonl"), key_fields=("timestamp", "original"))
    seen_caps = {media.key(r) for r in media.records()}
    counts = {"proved_gap": 0, "capture_found": 0, "inconclusive": 0, "not_media": 0}
    found_index = 0
    pending: list[str] = []
    for url in urls or []:
        if url not in pending:
            pending.append(url)
    for rec in store.all():
        for im in rec.get("images") or []:
            url = im.get("media_url") or im.get("url")
            if not url:
                continue
            prior = done.get(url)
            if prior and not force and prior.get("result") in ("confirmed_gap", "capture_found"):
                # A sweep supersedes the cheap verdict; never the other way round.
                if not (shard_sweep and prior.get("mode") != "shard_sweep"):
                    continue
            if url not in pending:
                pending.append(url)
    for url in pending[:limit]:
        row = prove(fetcher, url, alt_hosts=alt_hosts, shard_sweep=shard_sweep)
        row["proved_at"] = _now()
        ledger.append([row])
        counts[row["result"]] = counts.get(row["result"], 0) + 1
        if row["result"] == "capture_found":
            best = best_capture(row["captures"])
            if best:
                index_row = dict(best)
                index_row["source"] = "gap-proof"
                if media.key(index_row) not in seen_caps:
                    media.append([index_row])
                    seen_caps.add(media.key(index_row))
                    found_index += 1
    return {"considered": len(pending), **counts, "indexed_captures": found_index,
            "ledger": config.GAPS_JSONL}


def _image_candidates(store: PostStore, include_variants: bool = True,
                      only_missing: bool = True) -> list[tuple[str, str]]:
    """Every media URL still worth asking the archive about, with its era.

    A post image that is already recovered is skipped (its bytes are safe), and
    its size/extension siblings are only added when the image is still missing:
    the siblings are the only other place the same picture can hide.

    The second element is the *post's own* capture timestamp, used as the
    Availability API query timestamp.  The API answers unreliably for query
    timestamps at the very end of the collection window (2019-12-31 returns an
    empty snapshot set for URLs it demonstrably holds, e.g. post 15577014830's
    image and the 41.media capture of 20150123153647), while a query near the
    post's own capture returns the capture reliably.  Asking in the post's era
    is both more truthful and much cheaper than re-probing.
    """
    from .images import _variants

    out: list[tuple[str, str]] = []
    seen: set[str] = set()
    for rec in store.all():
        era = era_timestamp(rec)
        for img in rec.get("images") or []:
            if only_missing and img.get("sha256"):
                continue
            media_url = img.get("media_url")
            if not media_url:
                continue
            for candidate in ([media_url] + (_variants(media_url) if include_variants else [])):
                key = normalize_url(candidate)
                if key in seen:
                    continue
                seen.add(key)
                out.append((candidate, era))
    return out


def era_timestamp(rec: dict) -> str:
    """The best era hint for a post's own captures (14 digits)."""
    for cap in rec.get("captures") or []:
        ts = str(cap.get("timestamp") or "")
        if len(ts) >= 14 and ts[:4].isdigit():
            return ts
    ts = str(rec.get("capture_timestamp") or "")
    if len(ts) >= 14 and ts[:4].isdigit():
        return ts
    return config.CUTOFF


def probe_availability(fetcher: Fetcher, limit: int = 0, concurrency: int = 3,
                       variants: bool = True, retry_transient: bool = False,
                       retry_gap: bool = False,
                       index: Optional[AvailabilityIndex] = None) -> dict:
    """Sweep the Availability API over every unresolved image URL.

    This is the cheap inventory step: one small JSON request per URL on
    `archive.org`, committed incrementally, so a later iteration never repeats
    it and `fetch-images` only replays URLs with a confirmed pre-cutoff capture.
    """
    store = PostStore()
    urls = _image_candidates(store, include_variants=variants)
    index = index or AvailabilityIndex(capture_file("avail.jsonl"))
    timestamps = {normalize_url(u): ts for u, ts in urls}

    def progress(stats: dict) -> None:
        sys.stderr.write(f"[avail] {stats['done']}/{stats['total']} {stats}\n")
        sys.stderr.flush()

    return availability_sweep(fetcher, [u for u, _ in urls], limit=limit, concurrency=concurrency,
                              index=index, retry_transient=retry_transient,
                              retry_gap=retry_gap, timestamps=timestamps,
                              progress=progress)


# A URL that is known to have a pre-cutoff capture, used only as a liveness
# probe when a global cooldown is in force. Recovered from post 15577014830
# (see data/verification/15577014830.json): capture 20130930175155.
HEALTHCHECK_URL = "http://29.media.tumblr.com/tumblr_lxjrbav0Ye1r3it8zo1_500.jpg"


def archive_health(fetcher: Fetcher, url: str = HEALTHCHECK_URL,
                   timeout: Optional[float] = 30.0) -> dict:
    """One bounded request: is the archive answering again?

    A global cooldown recorded by an earlier iteration is a *time* promise, not
    a live measurement, and web.archive.org outages routinely end long before
    the back-off expires. Without this check a whole iteration can do nothing at
    all -- `fetch_images` returns before selecting anything -- even though the
    archive is healthy, and the 1186 never-attempted images stay untouched.

    The probe asks the replay endpoint about a URL we already know is archived
    and treats only a real answer as health: a timeout, throttle or transport
    failure keeps the cooldown in force.
    """
    resp = fetcher.probe_replay(url, timeout=timeout, trial=True)
    healthy = resp.error == OK and bool(resp.headers.get("location"))
    return {"url": url, "status": resp.status, "error": resp.error,
            "healthy": healthy, "message": resp.message[:200],
            "elapsed": round(resp.elapsed, 2),
            "at": _now()}


def stem_scan(fetcher: Fetcher, limit_stems: int = 0, concurrency: int = 3,
              dry_run: bool = False, max_throttled: int = 0,
              hosts: Optional[list[str]] = None) -> dict:
    """Answer "is this media stem archived, before the cutoff?" for every image.

    One CDX prefix query per size-stem -- the same question `--method stem`
    asks, asked *first* and on its own. Splitting it out matters because the two
    halves have very different costs and lifetimes: the CDX answer is slow
    (seconds to tens of seconds), durable and reusable, while the bytes behind a
    hit must be downloaded, verified and published immediately. Answers (hits
    *and* misses) go to `data/cdx/stems.jsonl`, which travels in the
    `crawl-state` checkpoint, so a fresh runner never re-asks a settled question
    and `fetch-images` can turn a hit into a published image without spending a
    single CDX request.

    Scope of every recorded answer -- and nothing wider: `matchType=prefix`,
    `filter=statuscode:200`, `collapse=urlkey`, `to=<cutoff>`, one exact prefix.
    A miss is negative evidence for that prefix alone; a transport failure, a
    timeout or a throttle records nothing, so the stem stays pending.

    NOTE: there is deliberately no multi-stem ("batched") CDX request. Measured
    on 2026-10, the CDX endpoint answers only the *first* `url=` parameter of a
    repeated-url request (see `cdx.cdx_query_multi`), which turns every other
    stem in such a request into a silent false negative.
    """
    store = PostStore()
    index = StemIndex()
    # Only *unresolved* images are worth a question. A stem whose image already
    # has bytes (`sha256`) is settled: we hold the picture, so a capture behind
    # it is a duplicate download, not recovery. Measured on 2026-10-06: of the
    # stem answers gathered so far, every hit that reached `fetch-images
    # --only-stem-hits` belonged to an already-recovered image and was discarded
    # as "already published with >= recovered data", so those requests bought
    # nothing. Such stems are counted and skipped instead of asked.
    fresh_stems: list[str] = []
    unresolved: set[str] = set()
    all_stems: list[str] = []
    seen: set[str] = set()
    for rec in store.all():
        for img in rec.get("images") or []:
            # Every URL form of the image is a candidate question, not just the
            # form the permalink used: `stem_prefix` keeps the CDN host (and the
            # hash directory), so the same photo referenced on a different
            # shard is a *different* CDX prefix. Listing evidence routinely
            # adds such forms, and before 18-295 they were silently never asked
            # (~100 measured unanswered stems), which suppressed real work.
            forms = [img.get("media_url") or ""]
            forms += [f for f in (img.get("url_forms") or []) if f]
            for url in forms:
                stem = stem_prefix(url)
                if not stem:
                    continue
                if stem not in seen:
                    seen.add(stem)
                    all_stems.append(stem)
                # A stem counts as work when *any* image behind it is unresolved:
                # the same picture can appear in several posts, and one recovered
                # copy must not hide an unresolved one.
                if not img.get("sha256"):
                    unresolved.add(stem)
    fresh_stems = [s for s in all_stems if s in unresolved]
    held_stems = len(all_stems) - len(fresh_stems)
    stems = fresh_stems
    todo = index.missing(stems)
    if hosts:
        # Order the pending questions by measured yield instead of by crawl
        # order: the CDX endpoint is the scarce resource (it rate limits), so
        # each request should go to a pool that has actually answered with a
        # capture before. Hosts that never answered keep their place at the end
        # -- they are still asked, just not first.
        rank = {h.strip().lower(): i for i, h in enumerate(hosts) if h.strip()}
        todo.sort(key=lambda s: (rank.get(s.split("/")[2].lower(), len(rank)), s))
    if limit_stems:
        todo = todo[:limit_stems]
    out = {"stems_total": len(stems), "stems_answered": len(index.rows),
           "stems_pending": len(index.missing(stems)), "scanning": len(todo),
           "scope": STEM_SCOPE, "requests_sent": 0, "answered_now": 0, "hits": 0,
           "stem_hits": [], "skipped": [], "concurrency": concurrency,
           "failures": {}, "deferred": 0, "unsent": 0,
           "host_priority": hosts or [],
           "stems_held_locally": held_stems,
           "stopped_early": False}
    if dry_run:
        return out

    extra = {"filter": STEM_SCOPE["filter"], "collapse": STEM_SCOPE["collapse"]}
    stop = threading.Event()

    def ask(stem: str) -> tuple[str, list, str, str, bool]:
        """(stem, captures, error, status, request_actually_sent).

        An open circuit breaker answers without touching the network: that is a
        deferral, not a remote answer, so it is never counted as a request, a
        failure or evidence about the archive. Only a request that really went
        out can carry a status or an error category.
        """
        if stop.is_set():
            return stem, [], "deferred", "None", False
        if fetcher.blocked:
            return stem, [], "deferred", "None", False
        caps, resp = cdx_query(fetcher, stem, match="prefix", limit=8, extra=extra)
        err = "" if resp.ok else (resp.error or f"http_{resp.status}")
        sent = resp.status is not None or bool(resp.message) or resp.error is not None
        if not sent and not caps:
            sent = True  # an answered query with an empty body still reached the archive
        return stem, [c for c in caps if c.statuscode == "200"], err, str(resp.status), sent

    throttled_seen = 0
    with ThreadPoolExecutor(max_workers=max(1, concurrency)) as pool:
        futures = {pool.submit(ask, stem): stem for stem in todo}
        for fut in as_completed(futures):
            stem, caps, err, status, sent = fut.result()
            if err == "deferred" or not sent:
                # Circuit breaker open (or the pass already gave up): nothing was
                # asked, the stem stays pending and the next pass retries it.
                out["deferred"] += 1
                out["unsent"] += 1
                continue
            if err:
                # Transient or throttled: the question stays open. Recorded with
                # its category so the next pass knows it was never answered.
                out["requests_sent"] += 1
                out["failures"][err] = out["failures"].get(err, 0) + 1
                out["skipped"].append({"stem": stem, "error": err, "status": status})
                if err == "throttled":
                    throttled_seen += 1
                    if max_throttled and throttled_seen >= max_throttled:
                        # A real 429 means the archive is rate limiting this
                        # client. Stop the burst instead of spending the rest of
                        # the pass on requests that will be refused too; the
                        # unanswered stems are simply still pending.
                        stop.set()
                        out["stopped_early"] = True
                continue
            index.record(stem, caps)
            out["requests_sent"] += 1
            out["answered_now"] += 1
            if caps:
                out["hits"] += 1
                out["stem_hits"].append({"stem": stem, "captures": len(caps),
                                         "first": caps[0].original,
                                         "timestamp": caps[0].timestamp})
    out["index"] = index.summary()
    out["stems_pending"] = len(index.missing(stems))
    return out


def posts_with_stem_hits() -> list[str]:
    """Post ids holding an image whose stem the index answered with a capture.

    These posts have bytes waiting in the archive: the existence question is
    already paid for, so they are worth a pass whatever the queue thinks -- the
    queue orders by attempts, not by "is there something to download".
    """
    index = StemIndex()
    hits = {stem for stem, caps in index.rows.items() if caps}
    if not hits:
        return []
    store = PostStore()
    out: list[str] = []

    def _stems_of(img: dict) -> set[str]:
        forms = [img.get("media_url") or ""]
        forms += [f for f in (img.get("url_forms") or []) if f]
        return {stem_prefix(f) for f in forms if f}

    for rec in store.all():
        # Only images we do *not* already hold. A hit stem whose image is
        # already recovered is a re-download of published bytes: it burns
        # replay requests and, in 6-85, was the reason a stem-hit pass reported
        # five "recoveries" while the published total moved by one image.
        # Every URL form of the image counts (a hit recorded for a form on
        # another shard is bytes behind that form), not just `media_url`.
        if any(not img.get("sha256") and (img.get("media_url") or img.get("url_forms"))
               and _stems_of(img) & hits
               for img in rec.get("images") or []):
            out.append(rec["post_id"])
    return sorted(out)


def fetch_images(fetcher: Fetcher, limit_posts: int = 5, concurrency: int = config.DEFAULT_CONCURRENCY,
                 post_ids: Optional[list[str]] = None, use_media_index: bool = True,
                 retry_missing: bool = False, method: str = "probe",
                 variant_budget: int = 4, order: str = "closest",
                 availability: Optional[AvailabilityIndex] = None,
                 queue: Optional[ImageQueue] = None, dry_run: bool = False,
                 publish_on_recovery: bool = True, health_check: bool = True,
                 stem_index=None) -> dict:
    store = PostStore()
    ledger = JsonlStore(config.MISSING_JSONL, key_fields=("kind", "key"))
    media_index = MediaIndex(capture_file("media.jsonl")) if use_media_index else None
    if method == "availability" and availability is None:
        availability = AvailabilityIndex(capture_file("avail.jsonl"))
    q = queue or ImageQueue()
    # Outcomes the archive has already decided: re-probing them spends requests
    # for nothing. `capture_after_cutoff` is decided too -- the only captures
    # are too late, and the cutoff never moves.
    final_errors = ("archive_gap", "bad_body", AFTER_CUTOFF_ONLY)

    records = [rec for rec in store.all()
               if not post_ids or rec.get("post_id") in post_ids]
    # Eligibility first, batch limit second. The previous code truncated first
    # and only then discovered, inside the worker, that most of the batch was
    # already settled -- so 32 of every 40 slots were wasted and the untouched
    # posts never got a turn.
    def _stale(image: dict) -> bool:
        # Re-open an image whose only verdict is weak (needs_probe) *or* whose
        # stem has a recorded capture: a hit is positive evidence of bytes, and
        # the work loop below turns it into a download even when the exact URL
        # was declared a gap.
        return needs_probe(image) or image_stem_hit(image, stem_index)

    batch, stats = q.select(records, limit=limit_posts, retry_missing=retry_missing,
                            stale_fn=_stale, final_errors=final_errors, order=order,
                            ignore_cooldown=bool(post_ids))
    cooldown = q.global_cooldown_active()
    if cooldown:
        # The recorded cooldown may outlive the outage that set it. Spend one
        # bounded request to find out before surrendering the whole iteration.
        # This probe runs for *every* pass with a cooldown in force, including
        # an explicitly targeted one (`--ids`, `--retry-missing`): the targeted
        # pass is a bypass of the "stop for now" answer, not a reason to skip
        # the one request that says whether the archive is back.
        health = archive_health(fetcher) if health_check else {"healthy": False}
        if health.get("healthy"):
            q.note_global_success()
            cooldown = None
            stats["cooldown_cleared_by_health_check"] = health
        else:
            stats["health_check"] = health
    if cooldown and not (retry_missing or post_ids):
        q.save()
        return {"processed": 0, "note": "global archive cooldown", "cooldown": cooldown,
                "queue": q.summary(), **stats}
    if not batch:
        q.save()
        return {"processed": 0, "note": "no posts with unresolved images", **stats,
                "queue": q.summary()}

    counts = {"recovered": 0, "missing": 0, "transient": 0, "deferred": 0}
    results = []

    def breaker_open() -> bool:
        # The HTTP layer's circuit breaker is the one signal that says "stop
        # asking, the archive is refusing traffic". Honouring it here is what
        # keeps a burst of throttles from consuming a whole batch: the posts
        # behind the trip stay *untouched* instead of each recording a
        # "circuit breaker open" attempt and a cooldown they never earned.
        return bool(getattr(fetcher, "blocked", False))

    def work(item) -> dict:
        pid, wanted = item
        if breaker_open():
            return {"post_id": pid, "recovered": 0, "missing": 0, "transient": 0,
                    "considered": 0, "deferred": True,
                    "reason": getattr(fetcher, "breaker_note", lambda: "")()}
        rec = store.get(pid)
        images = rec.get("images") or []
        wanted_urls = {e["media_url"]: e for e in wanted}
        recovered = 0
        missing = 0
        transient = 0
        merged: list[dict] = []
        considered: list[dict] = []
        prompt_publishes: list[dict] = []
        deferred = False
        for img in images:
            # Never drop an already recovered image on a rerun.
            if img.get("sha256") and img.get("blob_path"):
                merged.append(img)
                continue
            # A stem index hit is a capture the archive already told us about,
            # so it is worth downloading whatever method the pass is running.
            # Every URL form counts: a hit recorded for a form on another shard
            # (post 29905114965) is bytes behind that form, and the linked
            # shard's own stem can be a recorded miss. Detect it before the
            # `wanted` lookup: `--only-stem-hits` selects a post for a hit image
            # whose own terminal verdict (archive_gap/bad_body) excludes it from
            # `eligible_images`, and dropping it here wasted the selection.
            eff_method = method
            stem_hit = image_stem_hit(img, stem_index)
            if stem_hit:
                eff_method = "stem"
            entry = wanted_urls.get(img.get("media_url"))
            if entry is None:
                if not stem_hit:
                    merged.append(img)
                    missing += 1
                    continue
                # Synthesise a minimal work item for the hit image so the pass
                # actually downloads the capture the index recorded.
                entry = {"image": img, "media_url": img.get("media_url"), "tried": []}
            if breaker_open():
                # Leave this image exactly as it is: a pass cut short by an open
                # circuit is not evidence about the image, and the post record
                # must not claim the image was looked at.
                merged.append(img)
                deferred = True
                continue
            considered.append(entry)
            skip = set(entry.get("tried") or [])
            # An image with no untried URL form left has nothing to ask; it is
            # counted as missing but must not hold up the rest of the post.
            # A recorded stem-index hit is the exception: the archive already
            # told us bytes exist behind a stem, so the terminal verdict on the
            # exact URL must not suppress the download. Four posts (115102168873,
            # 115926815733, 31650451836, 34825069573) were selected by
            # `--only-stem-hits` yet skipped here because their error was a
            # terminal archive_gap/bad_body and no variant was untried.
            untried = q.untried_variants(img.get("media_url"), skip)
            if not stem_hit and not untried and img.get("error") in final_errors \
                    and not needs_probe(img) and not retry_missing:
                merged.append(img)
                missing += 1
                continue
            resolved = resolve_image(fetcher, img, media_index=media_index,
                                     key_known_at=rec.get("fetched_at", ""),
                                     method=eff_method, variant_budget=variant_budget,
                                     availability=availability,
                                     skip_variants=skip, stem_index=stem_index)
            _assign_file(resolved)
            if resolved["state"] == "recovered":
                recovered += 1
            else:
                missing += 1
                if (resolved.get("error") or "") in TRANSIENT_CLASSES:
                    transient += 1
                entry = ledger_entry(
                    "image", resolved["media_url"], resolved.get("error") or "unknown",
                    resolved.get("attempts", []),
                    {"post_id": pid, "media_key": resolved.get("media_key"),
                     "caption": resolved.get("caption", ""),
                     "state": resolved.get("state"),
                     "note": resolved.get("note", "")})
                if resolved.get("host_inventory"):
                    entry["host_inventory"] = resolved["host_inventory"]
                ledger.append([entry])          # durable immediately, per image
            merged.append(resolved)
            # Persist and publish the post as soon as one image lands: the bytes
            # exist only in the local blob cache during this process. Waiting for
            # the whole post (its `pool.map` result) means a slow sibling image,
            # or an earlier worker, can hold the recovered bytes locally until
            # preemption, losing them.
            if resolved["state"] == "recovered":
                updated = dict(rec)
                inherit_image_captions(merged)
                updated["images"] = merged
                updated["images_done"] = False
                updated["fetched_at"] = _now()
                store.put(pid, updated)
                if publish_on_recovery:
                    with _PUBLISH_LOCK:
                        prompt_publishes.append(_publish_recovered(pid, fetcher))
        updated = dict(rec)
        inherit_image_captions(merged)
        updated["images"] = merged
        updated["images_done"] = not deferred
        updated["fetched_at"] = _now()
        store.put(pid, updated)
        return {"post_id": pid, "recovered": recovered, "missing": missing,
                "transient": transient, "considered": len(considered),
                "deferred": deferred,
                "prompt_publish": prompt_publishes[-1] if prompt_publishes else None}

    if dry_run:
        q.save()
        return {"processed": 0, "dry_run": True, "batch": [pid for pid, _ in batch],
                **stats, "queue": q.summary()}

    with ThreadPoolExecutor(max_workers=max(1, concurrency)) as pool:
        for res in pool.map(work, batch):
            results.append(res)
            counts["recovered"] += res["recovered"]
            counts["missing"] += res["missing"]
            counts["transient"] += res["transient"]
            if res.get("deferred"):
                counts["deferred"] += 1
                if not res.get("considered"):
                    # No request was sent for this post: it keeps its place in
                    # line instead of spending an attempt and a cooldown on an
                    # archive that never answered.
                    continue
                res["deferred_after"] = res.get("considered", 0)
            row = q.note_attempt(res["post_id"],
                                 [e for e in dict(batch)[res["post_id"]]],
                                 {"outcome": "recovered" if res["recovered"] else
                                  ("transient" if res["transient"] else "settled"),
                                  "recovered": res["recovered"], "transient": res["transient"]})
            q.save()          # durable after every post, so a crash loses nothing
            # `data/blobs/` is an ephemeral cache: the recovered bytes exist only
            # inside this process. Publishing here, while they are present, is
            # what turns "recovered" into "publicly retrievable"; waiting for a
            # later `publish` run re-downloads from the archive and fails whenever
            # the archive is refusing connections. The per-image branch above
            # already pushed the bytes promptly; only re-publish when it did not
            # succeed, so the final merged post is durable without a redundant
            # registry round-trip per post.
            if publish_on_recovery and res["recovered"]:
                prompt = res.get("prompt_publish") or {}
                if prompt.get("action") in ("pushed", "updated", "skipped"):
                    res["publish"] = prompt
                else:
                    with _PUBLISH_LOCK:
                        res["publish"] = _publish_recovered(res["post_id"], fetcher)
    breaker_note = getattr(fetcher, "breaker_note", lambda: "")()
    if counts["transient"] and not counts["recovered"]:
        q.note_global_failure(f"{counts['transient']} transient image failures in this pass")
    elif counts["deferred"] and not counts["recovered"] and not counts["transient"]:
        # Nothing was learned at all because the circuit opened immediately:
        # say so, so the cooldown is on record instead of implied.
        q.note_global_failure(f"{counts['deferred']} posts deferred by an open circuit breaker")
    elif counts["recovered"]:
        q.note_global_success()
    q.save()
    out = {"processed": len(results), **counts, "results": results,
           "queue": q.summary(), **stats}
    if breaker_note:
        out["circuit_breaker"] = breaker_note
    return out


_EXT_BY_TYPE = {"image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif",
                "image/webp": ".webp", "image/bmp": ".bmp"}


# One coordinated registry/HTTP budget: publishing from several image workers
# must not race the shared blob store or the archive rate limiter.
_PUBLISH_LOCK = threading.Lock()


def _publish_recovered(post_id: str, fetcher: Optional[Fetcher] = None) -> dict:
    """Push one post's artifact right after its image bytes landed.

    Returns a small record of what happened; a registry failure is reported, never
    raised, so it can never discard the recovery itself. `fetcher` is the pass's
    shared transport when publishing from inside the work loop, so the registry
    blob fallback stays on the same coordinated request budget.
    """
    try:
        out = publish(limit=1, post_ids=[str(post_id)], fetcher=fetcher)
        rows = out.get("results") or []
        return rows[0] if rows else {"tag": post_id, "action": "nothing-to-do"}
    except Exception as exc:  # pragma: no cover - defensive
        return {"tag": post_id, "action": "failed",
                "reason": f"{type(exc).__name__}: {exc}"[:300]}


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


def image_stem_hit(image: dict, stem_index) -> bool:
    """Does any URL form of `image` have a recorded stem-index capture?

    A stem hit is *positive* evidence that bytes exist in the archive, so it
    re-opens an image whose exact URL already carries a terminal
    archive_gap/bad_body verdict. `posts_with_stem_hits()` selects such posts
    for `--only-stem-hits`, but the batch selector (`ImageQueue.select`) then
    filtered them back out as "no work left" whenever their own verdict was
    terminal, so the selection never reached the download. Four posts measured
    in 19-315 (44471188889, 104860741473, 70476601245, 69400236197) held a
    live stem hit yet were reported `no_work_left`.
    """
    if stem_index is None:
        return False
    forms = [image.get("media_url") or "", *(image.get("url_forms") or [])]
    for form in forms:
        if form and stem_index.lookup(stem_prefix(form)):
            return True
    return False


def _assign_file(rec: dict) -> None:
    if not rec.get("sha256"):
        return
    ext = _EXT_BY_TYPE.get(rec.get("media_type") or "", ".bin")
    key = rec.get("media_key") or rec["sha256"]
    # media_key keeps the original file extension, so appending unconditionally
    # produced names like `..._500.jpg.jpg` inside the published layers.
    if key.lower().endswith(ext):
        rec["file"] = key
    else:
        rec["file"] = f"{key}{ext}"


# --------------------------------------------------------------------- repair
def merge_reparsed_images(post_ids: Optional[list[str]] = None) -> dict:
    """Re-extract images from stored `content_html` and merge unseen ones (offline).

    The stored `content_html` is the post body. Re-running the *current*
    parser over it recovers images an older parser version dropped -- notably
    every image on a Tumblr AMP page, which uses `<amp-img>` instead of
    `<img>` -- without re-fetching the archived page or touching the archive.
    Existing image records are preserved by `merge_post`; only media keys that
    are not already present are added, unresolved.
    """
    store = PostStore()
    wanted = {str(i) for i in (post_ids or [])}
    out = {"posts": 0, "added": 0, "posts_changed": []}
    for pid in store.ids():
        if wanted and str(pid) not in wanted:
            continue
        rec = store.get(pid)
        html = rec.get("content_html") or ""
        out["posts"] += 1
        if not html:
            continue
        existing = {img.get("media_key") for img in rec.get("images") or []}
        new_images: list[dict] = []
        for img in extract_images(html):
            key = img.get("media_key")
            if not key or key in existing:
                continue
            existing.add(key)
            new_images.append({
                "media_url": img["media_url"],
                "media_key": key,
                "base_key": img.get("base_key", ""),
                "caption_alt": img.get("caption_alt", ""),
                "link_text": img.get("link_text", ""),
                "found_in": img.get("found_in", ""),
                "url_forms": img.get("url_forms", [img["media_url"]]),
                "variants": img.get("variants", []),
                "state": "unresolved",
                "attempts": [],
            })
        if new_images:
            store.put(pid, {"images": new_images, "images_done": False})
            out["added"] += len(new_images)
            out["posts_changed"].append(pid)
    return out


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
        inherit_image_captions(before.get("images") or [])
        after = store.put(pid, before)
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
        # Backfill the path: a record restored from the registry (or merged from
        # the store) can carry a sha256 without `blob_path`, and the artifact
        # builder reads `img["blob_path"]` directly.
        img["blob_path"] = path
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


def _restore_missing_blobs(post: dict) -> dict:
    """Fill absent local blobs from the already-published artifact.

    `data/blobs/` is an ephemeral cache. A post can carry an old image whose
    bytes are gone from this runner while the registry artifact still holds
    them; refetching every absent blob from Wayback meant a publication stalled
    behind a transport failure or a changed old-capture digest, and the freshly
    recovered sibling bytes sat only in local cache. Pull the published layers
    anonymously, verify each sha256, and store only matching bytes; a mismatch
    is ignored so the capture-refetch path still runs.
    """
    needed = []
    for img in post.get("images", []):
        sha = img.get("sha256")
        if not sha:
            continue
        if not os.path.exists(img.get("blob_path") or blob_path(sha)):
            needed.append(sha)
    out = {"needed": len(needed), "restored": 0, "restored_bytes": 0, "errors": []}
    if not needed:
        return out
    try:
        res = restore_post(str(post.get("post_id")), with_images=True)
    except Exception as exc:  # pragma: no cover - defensive
        out["errors"].append(f"{type(exc).__name__}: {exc}")
        return out
    out["restored"] = sum(1 for sha in needed if os.path.exists(blob_path(sha)))
    out["restored_bytes"] = res.get("blob_bytes", 0)
    if res.get("error"):
        out["errors"].append(res["error"])
    return out


def post_quality(post: dict) -> tuple[int, int, int]:
    """How much of a post an artifact would carry: (images, text, captions).

    Used so that a rerun can never replace a published artifact with one that
    carries fewer recovered images or less recovered text.
    """
    images = sum(1 for i in post.get("images", []) if i.get("sha256"))
    return images, len(post.get("content_text") or ""), len(post.get("captions") or [])


def publish(limit: int = 10, force: bool = False, registry: Optional[Registry] = None,
            only_missing: bool = False, fetcher: Optional[Fetcher] = None,
            post_ids: Optional[list[str]] = None) -> dict:
    # Explicit path: PostStore's default argument binds config at import time,
    # so tests (and future multi-workspace runs) could not redirect the store.
    store = PostStore(config.POST_DIR)
    reg = registry or Registry()
    fetch = fetcher or Fetcher()
    log = JsonlStore(config.PUBLISHED_JSONL, key_fields=("tag", "manifest_digest"))
    wanted = set(post_ids or [])
    results = []
    for rec in store.all():
        pid = rec.get("post_id")
        if not pid:
            continue
        # Targeted publication: `--ids` names exactly which tags to (re)push, so a
        # specific recovered post can be updated no matter where it sorts.
        if wanted and pid not in wanted:
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
        # Ephemeral blob cache: fill absent old blobs from the already-published
        # artifact (verified by sha256) before falling back to a Wayback refetch.
        restored = _restore_missing_blobs(post)
        # Remaining absent bytes: re-fetch the recorded capture before building.
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
# ---------------------------------------------------------------------- listings
# `/archive/YYYY/MM` and `/tagged/<tag>` captures are indexed but were never
# fetched. They are the only surviving evidence for permalinks that were never
# captured, and they carry a second CDN size variant of every post image.
LISTING_EVIDENCE_FILE = os.path.join(config.CDX_DIR, "listing-posts.jsonl")
# Resumability lives in the evidence file itself: a capture is done when a row
# with its `<timestamp>|<url>` key exists. A separate manifest would be one more
# thing to drift out of sync with the data.
LISTING_KIND_ORDER = ("archive", "tagged", "post_other", "other")
# A listing capture whose replay answered with one of these is settled: the
# archive authoritatively said it has no usable pre-cutoff body for it. Every
# other error (transport/timeout/throttle/5xx) is the *absence* of an answer,
# so the capture must stay in the todo list instead of being recorded done.
TERMINAL_LISTING_ERRORS = ("archive_gap", "bad_body", "capture_after_cutoff")


def _listing_done_keys(records: Iterable[dict]) -> set:
    """Capture keys already fetched, excluding transient (unanswered) failures.

    Resumability lives in the evidence file: a capture is done when a row with
    its `<timestamp>|<url>` key exists. That rule is wrong for a *failed*
    fetch: appending the summary row (which carries the same `capture_key`)
    marked a transport/throttle/timeout capture done forever, so a whole
    listing page the archive never served was silently dropped from every
    later pass. Only a successful fetch or a terminal archive verdict settles
    a capture here.
    """
    out: set = set()
    for rec in records or ():
        key = rec.get("capture_key")
        if not key:
            continue
        err = rec.get("error")
        if not err or err in TERMINAL_LISTING_ERRORS:
            out.add(key)
    return out


def fetch_listings(fetcher: Fetcher, limit: int = 20, kinds: tuple[str, ...] = ("archive", "tagged"),
                    concurrency: int = config.DEFAULT_CONCURRENCY,
                    one_per_url: bool = True) -> dict:
    """Download archived listing pages and fold their evidence into the posts.

    `one_per_url` (default) spends the first pass on one capture per distinct
    listing URL, preferring the latest pre-cutoff snapshot of each: there are
    ~1800 distinct untried listing URLs but ~6000 captures, and re-fetching the
    same `/tagged/<tag>` at another timestamp mostly repeats posts already seen.
    Set it False to sweep every capture of a URL (later snapshots of a tag page
    can carry posts an earlier one did not).
    """
    ensure_dirs()
    store = PostStore()
    evidence = JsonlStore(LISTING_EVIDENCE_FILE, key_fields=("capture_key",))
    done = _listing_done_keys(evidence.records())
    index = CaptureIndex(capture_file("listing.jsonl"))
    caps = list(index.all())
    # Archive months first: one page enumerates a whole month of posts, so they
    # buy far more post ids per request than a single-tag page.
    caps.sort(key=lambda c: (LISTING_KIND_ORDER.index(listing_kind(c.original))
                             if listing_kind(c.original) in LISTING_KIND_ORDER else 9,
                             c.timestamp, c.original))
    candidates = [c for c in caps
                  if listing_kind(c.original) in kinds
                  and f"{c.timestamp}|{normalize_url(c.original)}" not in done]
    # A URL that has *never* been fetched carries new surface; a second snapshot
    # of an already-mined URL mostly repeats posts already seen. Sort fresh URLs
    # first so a bounded pass spends its requests on discovery instead of
    # re-reading the oldest snapshots of known tag pages.
    done_urls = {key.split("|", 1)[1] for key in done if "|" in key}
    if one_per_url:
        by_url: dict[str, Capture] = {}
        for c in candidates:
            key = normalize_url(c.original)
            cur = by_url.get(key)
            if cur is None or c.timestamp > cur.timestamp:
                by_url[key] = c
        todo = sorted(by_url.values(),
                      key=lambda c: (LISTING_KIND_ORDER.index(listing_kind(c.original))
                                     if listing_kind(c.original) in LISTING_KIND_ORDER else 9,
                                     0 if normalize_url(c.original) not in done_urls else 1,
                                     c.timestamp, c.original))
    else:
        todo = candidates
    todo = todo[: max(0, limit)]
    ledger = JsonlStore(config.MISSING_JSONL, key_fields=("kind", "key"))
    stats = {"considered": len(caps), "done": len(done), "selected": len(todo),
             "fetched": 0, "new_posts": 0, "posts_touched": 0,
             "images_added": 0, "forms_merged": 0, "failed": 0}
    lock = __import__("threading").Lock()

    def work(cap: Capture) -> tuple[list[dict], list[dict], dict]:
        key = f"{cap.timestamp}|{normalize_url(cap.original)}"
        resp = fetcher.replay(cap.timestamp, cap.original, mode="id_")
        attempt = {"url": cap.original, "endpoint": "replay id_", "kind": "listing:" + listing_kind(cap.original),
                   "capture_timestamp": cap.timestamp, "status": resp.status,
                   "error": resp.error, "message": resp.message, "bytes": len(resp.body or b"")}
        if not resp.ok or not resp.body:
            return [], [], {"capture_key": key, "error": resp.error or "no_body", "attempts": [attempt]}
        if "html" not in resp.headers.get("content-type", "") and resp.body[:200].lstrip()[:1] not in (b"<",):
            return [], [], {"capture_key": key, "error": "not_html", "attempts": [attempt]}
        parsed = parse_listing_page(resp.text(), cap.original, cap.timestamp, resp.url)
        rows: list[dict] = []
        for post in parsed["posts"]:
            rows.append({"capture_key": key, "post_id": post["post_id"],
                         "listing_url": cap.original, "listing_kind": listing_kind(cap.original),
                         "timestamp": cap.timestamp, "replay_url": resp.url,
                         "page_sha256": parsed["page_sha256"], "urls": post.get("urls", []),
                         "images": post.get("images", [])})
        for pid in parsed["post_ids"]:
            if not any(r["post_id"] == pid for r in rows):
                rows.append({"capture_key": key, "post_id": pid, "listing_url": cap.original,
                             "listing_kind": listing_kind(cap.original), "timestamp": cap.timestamp,
                             "replay_url": resp.url, "page_sha256": parsed["page_sha256"],
                             "urls": [], "images": []})
        for img in parsed["unassigned_images"]:
            rows.append({"capture_key": key, "post_id": "", "listing_url": cap.original,
                         "listing_kind": listing_kind(cap.original), "timestamp": cap.timestamp,
                         "replay_url": resp.url, "page_sha256": parsed["page_sha256"],
                         "urls": [], "images": [img], "note": "no permalink anchor before this image"})
        return rows, [], {"capture_key": key, "error": None, "posts": len(parsed["post_ids"]),
                          "images": sum(len(p["images"]) for p in parsed["posts"]),
                          "attempts": [attempt]}

    if todo:
        with ThreadPoolExecutor(max_workers=max(1, concurrency)) as pool:
            for rows, _unused, summary in pool.map(work, todo):
                if rows:
                    evidence.append(rows)
                    stats["fetched"] += 1
                else:
                    stats["failed"] += 1
                evidence.append([{"capture_key": summary["capture_key"],
                                  "error": summary.get("error"),
                                  "posts": summary.get("posts", 0),
                                  "images": summary.get("images", 0),
                                  "attempts": summary.get("attempts", []),
                                  "at": _now()}])
                if summary.get("error"):
                    ledger.append([ledger_entry("listing", summary["capture_key"], summary["error"],
                                                summary.get("attempts", []),
                                                {"listing_url": summary["capture_key"].split("|", 1)[-1]})])

    # Fold the evidence into the post store (offline, resumable).
    by_post: dict[str, list[dict]] = {}
    for row in evidence.records():
        pid = row.get("post_id")
        if pid:
            by_post.setdefault(pid, []).append(row)
    for pid, evs in sorted(by_post.items(), key=lambda kv: int(kv[0])):
        if stats["posts_touched"] >= 4000:
            break
        existing = store.get(pid)
        before = len(existing.get("images") or [])
        merged = merge_listing_evidence(existing, evs)
        merged["post_id"] = pid
        merged.setdefault("original_url", f"http://hazfalafel.com/post/{pid}")
        saved = store.put(pid, merged)
        # A post with neither text nor a recovered image is *not* recovered,
        # even though `merge_post` calls anything with images "partial".
        if not saved.get("content_text") and not saved.get("image_count"):
            if saved.get("state") != "listing_only":
                saved["state"] = "listing_only"
                saved = store.put(pid, saved)
            if not existing:
                stats["new_posts"] += 1
                ledger.append([ledger_entry("post", pid, "listing_evidence_only",
                                            [{"endpoint": "listing", "listing_url": e.get("listing_url"),
                                              "capture_timestamp": e.get("timestamp")} for e in evs[:5]],
                                            {"post_url": f"http://hazfalafel.com/post/{pid}",
                                             "listing_captures": len(evs)})])
        stats["posts_touched"] += 1
        stats["images_added"] += max(0, merged.get("listing_images_added", 0))
        stats["forms_merged"] += merged.get("listing_forms_merged", 0)
        del before
    stats["evidence_rows"] = len(evidence.records())
    stats["evidence_posts"] = len(by_post)
    return stats


def status() -> dict:
    store = PostStore()
    posts = list(store.all())
    discovered = set()
    index = CaptureIndex(capture_file("posts.jsonl"))
    for cap in index.all():
        pid = post_id_from_url(cap.original)
        if pid:
            discovered.add(pid)
    recovered = [p for p in posts if p.get("image_count", 0) > 0]
    partial = [p for p in recovered if p.get("missing_image_count", 0) > 0]
    complete = [p for p in recovered if p.get("missing_image_count", 0) == 0]
    published = [p for p in posts if p.get("published")]
    missing_ledger = JsonlStore(config.MISSING_JSONL).records()
    media_index = CaptureIndex(capture_file("media.jsonl"))
    return {
        "discovered_posts": len(discovered),
        "captures_indexed": len(index.all()),
        "listing_captures": len(CaptureIndex(capture_file("listing.jsonl")).all()),
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
        "listing_evidence_rows": len(JsonlStore(LISTING_EVIDENCE_FILE).records()),
        "listing_only_posts": len([p for p in posts if p.get("state") == "listing_only"]),
        "gaps_proved": len([r for r in JsonlStore(config.GAPS_JSONL).records()
                            if r.get("result") == "confirmed_gap"]),
        "gaps_capture_found": len([r for r in JsonlStore(config.GAPS_JSONL).records()
                                   if r.get("result") == "capture_found"]),
        "gaps_inconclusive": len([r for r in JsonlStore(config.GAPS_JSONL).records()
                                  if r.get("result") == "inconclusive"]),
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
    p.add_argument("--limit", type=int, default=0,
                   help="max posts per pass (0 = every id given with --ids, else 10)")
    p.add_argument("--ids", default="")
    p.add_argument("--concurrency", type=int, default=config.DEFAULT_CONCURRENCY)
    p = sub.add_parser("fetch-listings", help="mine archived archive/tag pages for post evidence")
    p.add_argument("--limit", type=int, default=20)
    p.add_argument("--kinds", default="archive,tagged",
                   help="comma separated listing families: archive,tagged,post_other,other")
    p.add_argument("--all-captures", action="store_true",
                   help="sweep every capture of a listing URL instead of one per URL")
    p.add_argument("--concurrency", type=int, default=config.DEFAULT_CONCURRENCY)
    p = sub.add_parser("discover-media", help="inventory tumblr media hosts (one query per host)")
    p.add_argument("--hosts", default="", help="comma separated hosts; default = hosts seen in posts")
    p.add_argument("--force", action="store_true")
    p.add_argument("--max-pages", type=int, default=40)
    p.add_argument("--page-size", type=int, default=2000,
                   help="rows per paginated CDX page; 50000 504s on media hosts, 2000 is fast")
    p = sub.add_parser("dump-hosts", help="complete resume-key host inventories of media shards")
    p.add_argument("--hosts", default="", help="comma separated hosts; default = hosts of unresolved images")
    p.add_argument("--max-pages", type=int, default=60, help="CDX pages per host this pass")
    p.add_argument("--limit", type=int, default=hostdump.PAGE_LIMIT)
    p.add_argument("--priority", default="pending",
                   choices=("pending", "refs"), help="order hosts by unresolved images or refs")
    p = sub.add_parser("reindex-media", help="rebuild media index from host dumps (offline)")
    p = sub.add_parser("prove-gaps", help="file-level archive-gap proofs for known images")
    p.add_argument("--limit", type=int, default=25)
    p.add_argument("--alt-hosts", type=int, default=2,
                   help="alternate tumblr CDN hosts asked per image (0-9)")
    p.add_argument("--force", action="store_true", help="re-prove settled rows too")
    p.add_argument("--shard-sweep", action="store_true",
                   help="ask every numbered tumblr CDN host (slow, strongest evidence)")
    p.add_argument("--urls", default="",
                   help="comma separated media URLs to prove instead of posts' images")
    p = sub.add_parser("probe-availability",
                       help="sweep the archive.org availability API over unresolved image URLs")
    p.add_argument("--limit", type=int, default=0, help="0 = every unresolved URL")
    p.add_argument("--concurrency", type=int, default=3)
    p.add_argument("--no-variants", action="store_true",
                   help="probe only the exact URL the post linked, not size/extension siblings")
    p.add_argument("--retry-transient", action="store_true",
                   help="re-probe URLs whose previous answer was a timeout/throttle")
    p.add_argument("--retry-gap", action="store_true",
                   help="re-probe stored 'no snapshot' verdicts written before the "
                        "14-digit cutoff fix (those answers are demonstrably empty)")
    p = sub.add_parser("stem-scan", help="CDX existence scan for every known image stem")
    p.add_argument("--limit-stems", type=int, default=0, help="max stems this pass (0 = all)")
    p.add_argument("--concurrency", type=int, default=3,
                   help="parallel CDX requests (the archive is asked one question per request)")
    p.add_argument("--dry-run", action="store_true", help="report the plan without any request")
    p.add_argument("--max-throttled", type=int, default=0,
                   help="stop the pass after N real 429/503 answers (0 = no limit); "
                        "stems never asked stay pending for the next pass")
    p.add_argument("--hosts", default="",
                   help="comma separated media hosts in priority order; pending stems "
                        "are asked in that order (unlisted hosts last)")
    p = sub.add_parser("xshard-scan",
                       help="discover images archived on a CDN shard the post does not link")
    p.add_argument("--hosts", default="",
                   help="comma separated media hosts to scan (default: every known shard)")
    p.add_argument("--limit", type=int, default=2000, help="max CDX rows per host")
    p.add_argument("--rescan", action="store_true", help="re-scan hosts already recorded done")
    p.add_argument("--no-apply", action="store_true",
                   help="record the found URLs without folding them into posts")
    p.add_argument("--dry-run", action="store_true", help="report the plan without any request")
    p = sub.add_parser("rss-scan",
                       help="mine the archived blog RSS feed for post media URL forms")
    p.add_argument("--limit", type=int, default=0, help="max feed captures this pass (0 = all)")
    p.add_argument("--dry-run", action="store_true", help="report the plan without any request")
    p = sub.add_parser("fetch-images", help="resolve post images from the archive")
    p.add_argument("--limit", type=int, default=0,
                   help="max posts per pass (0 = 5, or every id given with --ids)")
    p.add_argument("--ids", default="")
    p.add_argument("--concurrency", type=int, default=config.DEFAULT_CONCURRENCY)
    p.add_argument("--no-media-index", action="store_true",
                   help="ignore data/cdx/media.jsonl and query the CDX per image")
    p.add_argument("--retry-missing", action="store_true",
                   help="retry confirmed gaps and rejected bodies too (default: transient only)")
    p.add_argument("--method", default="probe", choices=("probe", "cdx", "auto", "availability",
                                                         "stem"),
                   help="existence check per image: availability sweep (cheapest, committed), "
                        "replay probe, CDX query (slow), size-stem CDX prefix (one request for "
                        "the whole variant family) or auto")
    p.add_argument("--variant-budget", type=int, default=4,
                   help="size/extension siblings probed after the exact URL misses")
    p.add_argument("--order", default="closest", choices=("closest", "post_id"),
                   help="which posts to spend requests on first")
    p.add_argument("--max-attempts", type=int, default=0,
                   help="stop retrying a post after N passes (0 = queue default 12)")
    p.add_argument("--cooldown-minutes", type=int, default=0,
                   help="per-post cooldown after a transient pass (0 = queue default 45)")
    p.add_argument("--dry-run", action="store_true",
                   help="report which posts the next pass would touch, without any request")
    p.add_argument("--no-publish", action="store_true",
                   help="do not push a post's artifact while its recovered bytes are in memory")
    p.add_argument("--no-health-check", action="store_true",
                   help="obey a recorded global cooldown without probing archive liveness")
    p.add_argument("--stem-index", dest="stem_index", default="auto",
                   choices=("auto", "off"),
                   help="use data/cdx/stems.jsonl (recorded CDX stem answers) as the "
                        "existence answer; 'auto' loads it when present")
    p.add_argument("--only-stem-hits", action="store_true",
                   help="restrict the pass to posts holding an image whose stem the "
                        "stem index answered with a capture (i.e. bytes are waiting)")
    p = sub.add_parser("publish", help="push per-post artifacts to GHCR")
    p.add_argument("--limit", type=int, default=10)
    p.add_argument("--force", action="store_true")
    p.add_argument("--ids", default="",
                   help="comma separated post ids to (re)publish, ignoring sort order")
    p.add_argument("--include-published", action="store_true",
                   help="also consider posts whose published quality already matches")
    p = sub.add_parser("verify-artifact",
                       help="pull a published tag anonymously and check the real image bytes")
    p.add_argument("--ids", default="", help="comma separated post ids; default = every verified tag")
    p.add_argument("--limit", type=int, default=0, help="0 = all given ids")
    p.add_argument("--package", default="", help="override ghcr repo (owner/name)")
    p = sub.add_parser("restore",
                       help="pull published tags back into the local post records")
    p.add_argument("--ids", default="", help="comma separated post ids; default = known image-bearing tags")
    p.add_argument("--meta-only", action="store_true", help="do not pull image layer bytes")
    p = sub.add_parser("checkpoint",
                       help="push/pull the crawl-state checkpoint tag (bulk crawl state)")
    p.add_argument("--pull", action="store_true",
                   help="restore the checkpoint instead of pushing it")
    p = sub.add_parser("status", help="print recovery counters")
    sub.add_parser("repair", help="re-derive post bookkeeping fields (offline)")
    p = sub.add_parser("merge-images",
                       help="re-extract images from stored content_html and merge unseen ones (offline)")
    p.add_argument("--ids", default="", help="comma separated post ids; default = all posts")
    sub.add_parser("report", help="write RECOVERY_REPORT.md")
    args = parser.parse_args(argv)

    ensure_dirs()
    fetcher = Fetcher()
    out: dict = {}
    if args.cmd == "repair":
        out = repair_posts()
    elif args.cmd == "merge-images":
        ids = [i.strip() for i in args.ids.split(",") if i.strip()]
        out = merge_reparsed_images(ids or None)
    elif args.cmd == "discover":
        years = [y.strip() for y in args.years.split(",") if y.strip()] or None
        out["posts"] = discover_posts(fetcher, years=years, force=args.force)
        if args.listings:
            out["listings"] = discover_listings(fetcher, force=args.force)
    elif args.cmd == "fetch-posts":
        post_ids = [i for i in args.ids.split(",") if i] or None
        # An explicit id list is a deliberate batch: the default limit of 10
        # silently ignored most of the ids the caller asked for (observed
        # 2026-10: `fetch-posts --ids <30 ids>` fetched only the first 10 and
        # reported "nothing pending" for the rest, hiding 19 unparsed posts).
        # Mirror the fetch-images rule: all named ids, no hidden cap.
        limit = args.limit or (len(post_ids) if post_ids else 10)
        out = fetch_posts(fetcher, limit=limit, concurrency=args.concurrency,
                          post_ids=post_ids)
    elif args.cmd == "fetch-listings":
        out = fetch_listings(fetcher, limit=args.limit,
                             kinds=tuple(k.strip() for k in args.kinds.split(",") if k.strip()),
                             concurrency=args.concurrency,
                             one_per_url=not args.all_captures)
    elif args.cmd == "discover-media":
        out["media"] = discover_media(fetcher, hosts=[h.strip() for h in args.hosts.split(",") if h.strip()] or None,
                                      force=args.force, max_pages=args.max_pages,
                                      page_size=args.page_size)
    elif args.cmd == "dump-hosts":
        out["hosts"] = dump_media_hosts(fetcher, [h.strip() for h in args.hosts.split(",") if h.strip()] or None,
                                        max_pages=args.max_pages, limit=args.limit,
                                        priority=args.priority)
    elif args.cmd == "reindex-media":
        out["media"] = reindex_media()
    elif args.cmd == "prove-gaps":
        out = prove_gaps(fetcher, limit=args.limit, alt_hosts=args.alt_hosts,
                         force=args.force, shard_sweep=args.shard_sweep,
                         urls=[u for u in args.urls.split(",") if u] or None)
    elif args.cmd == "probe-availability":
        out = probe_availability(fetcher, limit=args.limit, concurrency=args.concurrency,
                                 variants=not args.no_variants,
                                 retry_transient=args.retry_transient,
                                 retry_gap=args.retry_gap)
    elif args.cmd == "stem-scan":
        out = stem_scan(fetcher, limit_stems=args.limit_stems, concurrency=args.concurrency,
                        dry_run=args.dry_run, max_throttled=args.max_throttled,
                        hosts=[h for h in args.hosts.split(",") if h.strip()])
    elif args.cmd == "xshard-scan":
        from .xshard import DEFAULT_HOSTS, xshard_scan

        hosts = [h.strip() for h in args.hosts.split(",") if h.strip()] or list(DEFAULT_HOSTS)
        if args.dry_run:
            out = {"hosts": hosts, "dry_run": True}
        else:
            out = xshard_scan(fetcher, hosts=hosts, limit=args.limit,
                              rescan=args.rescan, apply=not args.no_apply)
    elif args.cmd == "rss-scan":
        from .rss import rss_scan

        out = rss_scan(fetcher, limit=args.limit, dry_run=args.dry_run)
    elif args.cmd == "fetch-images":
        queue = ImageQueue(cooldown_minutes=args.cooldown_minutes or 45,
                           max_attempts=args.max_attempts or 12)
        post_ids = [i for i in args.ids.split(",") if i] or None
        if args.only_stem_hits:
            post_ids = posts_with_stem_hits() or post_ids
        # An explicit id list is a deliberate batch: capping it at the default
        # limit of 5 silently ignored most of the ids the caller asked for.
        limit_posts = args.limit or (len(post_ids) if post_ids else 5)
        stem_index = StemIndex() if args.stem_index == "auto" else None
        out = fetch_images(fetcher, limit_posts=limit_posts, concurrency=args.concurrency,
                           post_ids=post_ids,
                           use_media_index=not args.no_media_index, retry_missing=args.retry_missing,
                           method=args.method, variant_budget=args.variant_budget,
                           order=args.order, queue=queue, dry_run=args.dry_run,
                           publish_on_recovery=not args.no_publish,
                           health_check=not args.no_health_check,
                           stem_index=stem_index)
    elif args.cmd == "restore":
        ids = [i.strip() for i in args.ids.split(",") if i.strip()]
        if not ids:
            # Image-bearing tags are exactly the ones whose local record can be
            # behind the registry, and there are few of them.
            rows = JsonlStore(config.PUBLISHED_JSONL).records()
            ids = sorted({r.get("post_id") for r in rows
                          if r.get("post_id") and (r.get("image_count") or 0) > 0})
        out = restore_posts(ids, with_images=not args.meta_only)
    elif args.cmd == "checkpoint":
        from . import state_checkpoint

        out = (state_checkpoint.restore_state() if args.pull
               else state_checkpoint.push_state())
    elif args.cmd == "publish":
        ids = [i.strip() for i in args.ids.split(",") if i.strip()]
        if ids:
            args.limit = max(args.limit, len(ids))
        out = publish(limit=args.limit, force=args.force, fetcher=fetcher,
                      only_missing=args.include_published, post_ids=ids or None)
    elif args.cmd == "verify-artifact":
        from .verify import verify_tag

        ids = [i.strip() for i in args.ids.split(",") if i.strip()]
        if not ids:
            log = JsonlStore(config.PUBLISHED_JSONL, key_fields=("tag", "manifest_digest"))
            seen = []
            for row in log.records():
                tag = str(row.get("tag") or "")
                if tag and tag not in seen:
                    seen.append(tag)
            ids = seen[: args.limit or len(seen)]
        reports = []
        for pid in ids:
            kw = {}
            if args.package:
                repo, _, reg = args.package.partition("/")
                kw = {"repo": args.package}
            rep = verify_tag(pid, **kw)
            reports.append({"tag": rep.get("tag"), "passed": rep.get("passed"),
                            "manifest_digest": rep.get("manifest_digest", ""),
                            "images_verified": rep.get("images_verified", 0),
                            "checks": f"{rep.get('checks_passed', 0)}/{rep.get('checks_total', 0)}",
                            "failed_checks": rep.get("failed_checks", [])})
        out = {"verified": len(reports),
               "passed": sum(1 for r in reports if r["passed"]),
               "results": reports}
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
