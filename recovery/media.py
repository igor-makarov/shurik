"""Host-level media inventory for Tumblr CDN images.

Querying the CDX once per image is slow and mostly returns nothing: a Tumblr
post page references one size variant (`..._500.jpg`) while the archive often
holds a *different* variant of the same media file. Instead we inventory whole
`*.media.tumblr.com` hosts once (a few thousand rows, one request each with
`collapse=urlkey`) and match every known media key locally. Only images whose
key we actually reference are persisted, which keeps the committed inventory
small while still recording the capture that produced each recovered image.
"""
from __future__ import annotations

import json
import os
import re
from typing import Iterable, Optional

from . import config
from .cdx import Capture, CaptureIndex, cdx_query, normalize_url, within_cutoff
from .parsing import base_media_key, media_key, parse_image_variants

MEDIA_CAPTURE_FILE = os.path.join(config.CDX_DIR, "media.jsonl")
# Ephemeral per-run cache of whole-host CDX rows (gitignored, never required).
MEDIA_DUMP_DIR = os.path.join(config.DATA_DIR, "work", "media-dumps")
HOST_RE = re.compile(r"^([a-z0-9-]+(?:\.[a-z0-9-]+)*\.media\.tumblr\.com)$", re.I)


def _now() -> str:
    import datetime

    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def host_of(url: str) -> str:
    m = re.match(r"^https?://([^/]+)", url or "", re.I)
    return m.group(1).lower() if m else ""


def key_of(url: str) -> str:
    """Lowercase identity of a media file, ignoring size suffix and extension."""
    base = base_media_key(url) or media_key(url) or os.path.basename(normalize_url(url))
    base = base.lower()
    stem, _, ext = base.rpartition(".")
    return stem + "." + ext if ext else stem


def stems_of(url: str) -> set[str]:
    """Every key a media file could be indexed under (all size variants)."""
    keys = {key_of(v) for v in parse_image_variants(url)}
    keys.add(key_of(url))
    return {k for k in keys if k}


class MediaIndex:
    """Local, durable index of archived media captures keyed by media file."""

    def __init__(self, path: str = MEDIA_CAPTURE_FILE):
        self.index = CaptureIndex(path)
        self._by_url: dict[str, list[Capture]] = {}
        self._by_key: dict[str, list[Capture]] = {}
        for cap in self.index.all():
            self._remember(cap)

    def _remember(self, cap: Capture) -> None:
        self._by_url.setdefault(normalize_url(cap.original), []).append(cap)
        self._by_key.setdefault(key_of(cap.original), []).append(cap)

    def add(self, captures: Iterable[Capture]) -> int:
        caps = list(captures)
        new = self.index.add(caps)
        for cap in caps:
            self._remember(cap)
        return new

    def lookup(self, url: str) -> list[Capture]:
        """Captures for a media URL: exact match first, then any variant."""
        exact = self._by_url.get(normalize_url(url), [])
        if exact:
            return sorted(exact, key=lambda c: c.timestamp)
        out: list[Capture] = []
        for key in stems_of(url):
            out.extend(self._by_key.get(key, []))
        # Same media file on another CDN host is still evidence of the image.
        if not out:
            for key in stems_of(url):
                for cap_url, caps in self._by_key.items():
                    if key in cap_url:
                        out.extend(caps)
        seen: set[str] = set()
        uniq = []
        for cap in sorted(out, key=lambda c: c.timestamp):
            if cap.key in seen:
                continue
            seen.add(cap.key)
            uniq.append(cap)
        return uniq

    def __len__(self) -> int:
        return len(self.index.all())

    def hosts_done(self) -> dict:
        return self.index.manifest.get("done", {})

    def host_complete(self, host: str) -> Optional[dict]:
        """Manifest entry when a host was scanned to its last page, else None.

        A complete scan is positive evidence: every pre-cutoff `statuscode:200`
        row of that host has been seen, so "this key is absent" is a *confirmed*
        archive gap rather than an unexamined unknown.
        """
        state = (self.hosts_done().get(f"host:{host.lower()}") or {})
        return state if state.get("complete") else None

    def mark_host(self, host: str, info: dict) -> None:
        self.index.mark_done(f"host:{host}", info)


SHARED_MEDIA_HOSTS = {"media.tumblr.com"}  # every tumblr blog shares it: too big to inventory


def hosts_for(urls: Iterable[str]) -> list[str]:
    hosts = {host_of(u) for u in urls if u}
    return sorted(h for h in hosts if HOST_RE.match(h or "") and h not in SHARED_MEDIA_HOSTS)


def scan_host(
    fetcher,
    index: MediaIndex,
    host: str,
    *,
    keys: Optional[set[str]] = None,
    page_size: int = 5000,
    max_pages: int = 40,
    force: bool = False,
    dump_dir: str = MEDIA_DUMP_DIR,
) -> dict:
    """Inventory one media host, keeping rows that match a known media key.

    Two stores are involved on purpose:

    * an **ephemeral dump** (`data/work/media-dumps/<host>.jsonl`, gitignored)
      holding every pre-cutoff row of the host, so the same pages are never
      re-downloaded and so new media keys can be answered offline;
    * the **committed index** (`data/cdx/media.jsonl`) holding only the rows
      whose media key a recovered post actually references.

    Pages are a cursor, not a restart: an interrupted scan resumes at the first
    unscanned page, and `complete` in the manifest says whether the host was
    paged to its end.
    """
    name = f"host:{host}"
    state = index.hosts_done().get(name) or {}
    dump_path = os.path.join(dump_dir, f"{host}.jsonl")
    os.makedirs(dump_dir, exist_ok=True)

    if state.get("complete") and not force:
        # No new network work: re-filter whatever dump survived on this runner.
        if os.path.exists(dump_path):
            kept, rows, reindexed = _reindex_dump(dump_path, index, keys)
            info = {"host": host, "rows": rows, "kept": len(kept), "new": reindexed,
                    "pages": state.get("pages", 0), "complete": True,
                    "source": "dump", "response": {"error": "ok", "status": 200}}
            index.mark_host(name, info)
            return info
        return {"host": host, "skipped": True, "complete": True, "note": "no dump on this runner"}

    start_page = 1 if force else int(state.get("pages", 0)) + 1
    if force and os.path.exists(dump_path):
        os.remove(dump_path)
    kept: list[Capture] = []
    seen_rows = int(state.get("rows", 0)) if start_page > 1 else 0
    pages = start_page - 1
    short_page = False
    last: dict = {}
    for page in range(start_page, start_page + max_pages):
        # matchType=domain (not prefix on the bare host): a prefix query on the
        # host string also matches every subdomain and returns them in a
        # different urlkey order, which made page cursors skip rows.
        caps, resp = cdx_query(fetcher, host, match="domain", limit=page_size,
                               extra={"filter": "statuscode:200", "collapse": "urlkey",
                                      "page": str(page)})
        pages = page
        last = {"status": resp.status, "error": resp.error, "message": resp.message[:200]}
        if not resp.ok:
            break
        seen_rows += len(caps)
        with open(dump_path, "a", encoding="utf-8") as fh:
            for cap in caps:
                fh.write(json.dumps(cap.to_row(), ensure_ascii=False) + "\n")
        for cap in caps:
            if keys is None or key_of(cap.original) in keys:
                kept.append(cap)
        if len(caps) < page_size:
            short_page = True
            break
    kept = [c for c in kept if c.statuscode in ("200", "") and within_cutoff(c.timestamp)]
    new = index.add(kept)
    # `error == "ok"` is success, not failure: do not read it as "incomplete".
    err = last.get("error")
    complete = bool(short_page and err in (None, "ok"))
    info = {"host": host, "rows": seen_rows, "kept": len(kept), "new": new, "pages": pages,
            "complete": complete, "response": last,
            "scanned_at": _now(), "keys_at_scan": len(keys) if keys is not None else 0}
    index.mark_host(name, info)
    return info


def _reindex_dump(dump_path: str, index: MediaIndex, keys: Optional[set[str]]) -> tuple[list[Capture], int, int]:
    """Answer a fresh key set from an already downloaded host dump (no network)."""
    kept: list[Capture] = []
    rows = 0
    with open(dump_path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except Exception:
                continue
            rows += 1
            cap = Capture(
                timestamp=rec.get("timestamp", ""),
                original=rec.get("original", ""),
                statuscode=rec.get("statuscode", ""),
                mimetype=rec.get("mimetype", ""),
                digest=rec.get("digest", ""),
                length=rec.get("length", ""),
                urlkey=rec.get("urlkey", ""),
                redirect=rec.get("redirect", ""),
                source_query=rec.get("source_query", ""),
            )
            if not within_cutoff(cap.timestamp):
                continue
            if keys is None or key_of(cap.original) in keys:
                kept.append(cap)
    return kept, rows, index.add(kept)