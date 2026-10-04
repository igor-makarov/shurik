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
from .http import GAP, OK, Fetcher, RateLimiter, Response
from .images import resolve_image
from .parsing import parse_post_page, post_id_from_url
from .publish import Registry, publish_post
from .store import JsonlStore, PostStore, ensure_dirs, ledger_entry

POST_CAPTURE_FILE = os.path.join(config.CAPTURE_DIR, "posts.jsonl")
LISTING_CAPTURE_FILE = os.path.join(config.CAPTURE_DIR, "listing.jsonl")
MEDIA_CAPTURE_FILE = os.path.join(config.CAPTURE_DIR, "media.jsonl")
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
        have = {(c.get("capture") or {}).get("timestamp") for c in existing.get("captures", [])}
        pending = [c for c in grouped[pid] if c.timestamp not in have]
        if existing.get("content_text") and not pending:
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


# ---------------------------------------------------------------------- images
def fetch_images(fetcher: Fetcher, limit_posts: int = 5, concurrency: int = config.DEFAULT_CONCURRENCY,
                 post_ids: Optional[list[str]] = None) -> dict:
    store = PostStore()
    ledger = JsonlStore(config.MISSING_JSONL, key_fields=("kind", "key"))
    pending = []
    for rec in store.all():
        if post_ids and rec.get("post_id") not in post_ids:
            continue
        if rec.get("missing_image_count", 0) == 0 and rec.get("image_count", 0) > 0 and rec.get("images_done"):
            continue
        if not rec.get("images"):
            continue
        pending.append(rec["post_id"])
        if len(pending) >= limit_posts:
            break

    missing_entries: list[dict] = []
    counts = {"recovered": 0, "missing": 0}

    def work(pid: str) -> dict:
        rec = store.get(pid)
        images = rec.get("images") or []
        new_images: list[dict] = []
        for img in images:
            if img.get("sha256"):
                continue
            resolved = resolve_image(fetcher, img)
            new_images.append(resolved)
            if resolved["state"] == "recovered":
                counts["recovered"] += 1
                _assign_file(resolved)
            else:
                counts["missing"] += 1
                missing_entries.append(ledger_entry(
                    "image", resolved["media_url"], resolved.get("error") or "unknown",
                    resolved.get("attempts", []),
                    {"post_id": pid, "media_key": resolved.get("media_key"),
                     "caption": resolved.get("caption", "")}))
        updated = dict(rec)
        updated["images"] = new_images if new_images else images
        updated["images_done"] = True
        updated["fetched_at"] = _now()
        store.put(pid, updated)
        return {"post_id": pid, "recovered": counts["recovered"], "missing": counts["missing"]}

    if not pending:
        return {"processed": 0, "note": "no posts with unresolved images"}
    with ThreadPoolExecutor(max_workers=max(1, concurrency)) as pool:
        results = list(pool.map(work, pending))
    if missing_entries:
        ledger.append(missing_entries)
    return {"processed": len(results), "recovered": counts["recovered"], "missing": counts["missing"],
            "results": results}


_EXT_BY_TYPE = {"image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif",
                "image/webp": ".webp", "image/bmp": ".bmp"}


def _assign_file(rec: dict) -> None:
    if not rec.get("sha256"):
        return
    ext = _EXT_BY_TYPE.get(rec.get("media_type") or "", ".bin")
    key = rec.get("media_key") or rec["sha256"]
    rec["file"] = f"{key}{ext}"


# --------------------------------------------------------------------- publish
def publish(limit: int = 10, force: bool = False, registry: Optional[Registry] = None,
            only_missing: bool = False) -> dict:
    store = PostStore()
    reg = registry or Registry()
    log = JsonlStore(config.PUBLISHED_JSONL, key_fields=("tag", "manifest_digest"))
    results = []
    for rec in store.all():
        pid = rec.get("post_id")
        if not pid or not rec.get("images"):
            continue
        if not any(i.get("sha256") for i in rec["images"]):
            continue
        if rec.get("published") and not force:
            continue
        post = dict(rec)
        post["missing_images"] = rec.get("missing_images", [])
        try:
            res = publish_post(post, reg, force=force)
        except Exception as exc:
            res = {"tag": pid, "action": "failed", "reason": f"{type(exc).__name__}: {exc}"[:300]}
        results.append(res)
        if res.get("action") in ("pushed", "updated", "skipped"):
            entry = {"tag": res.get("tag"), "action": res.get("action"),
                     "manifest_digest": res.get("manifest_digest", ""),
                     "config_digest": res.get("config_digest", ""),
                     "image_count": res.get("image_count", 0),
                     "missing_count": res.get("missing_count", 0),
                     "post_id": pid, "at": _now()}
            log.append([entry])
            rec2 = dict(store.get(pid))
            rec2["published"] = {"at": entry["at"], "action": entry["action"],
                                 "manifest_digest": entry["manifest_digest"],
                                 "image_count": entry["image_count"],
                                 "missing_count": entry["missing_count"]}
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
    p = sub.add_parser("fetch-images", help="resolve post images from the archive")
    p.add_argument("--limit", type=int, default=5)
    p.add_argument("--ids", default="")
    p.add_argument("--concurrency", type=int, default=config.DEFAULT_CONCURRENCY)
    p = sub.add_parser("publish", help="push per-post artifacts to GHCR")
    p.add_argument("--limit", type=int, default=10)
    p.add_argument("--force", action="store_true")
    sub.add_parser("status", help="print recovery counters")
    sub.add_parser("report", help="write RECOVERY_REPORT.md")
    args = parser.parse_args(argv)

    ensure_dirs()
    fetcher = Fetcher()
    out: dict = {}
    if args.cmd == "discover":
        years = [y.strip() for y in args.years.split(",") if y.strip()] or None
        out["posts"] = discover_posts(fetcher, years=years, force=args.force)
        if args.listings:
            out["listings"] = discover_listings(fetcher, force=args.force)
    elif args.cmd == "fetch-posts":
        out = fetch_posts(fetcher, limit=args.limit, concurrency=args.concurrency,
                          post_ids=[i for i in args.ids.split(",") if i] or None)
    elif args.cmd == "fetch-images":
        out = fetch_images(fetcher, limit_posts=args.limit, concurrency=args.concurrency,
                           post_ids=[i for i in args.ids.split(",") if i] or None)
    elif args.cmd == "publish":
        out = publish(limit=args.limit, force=args.force)
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
