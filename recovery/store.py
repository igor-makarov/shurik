"""Bulk recovery state: inventories, post records, ledgers, publish log.

Where it lives
--------------
`data/posts/` and `data/cdx/` are bulk crawl state and are **gitignored**. They
travel between fresh runners through the registry: the `crawl-state` tag of
`ghcr.io/igor-makarov/shurik-hazfalafel-com` carries them as one gzip tar
layer (see `recovery/state_checkpoint.py`), and the committed
`data/checkpoint.json` pointer records that tag's manifest digest and schema
version. Published *recovered* posts additionally live in their numeric tags.

Git keeps only the compact records: `data/image-queue.json`,
`data/missing.jsonl`, `data/gaps.jsonl`, `data/published.jsonl`,
`data/verification/*.json`, `data/checkpoint.json`.

Merging is additive and monotonic: reruns merge new evidence into existing
records and never drop recovered images or replace richer metadata with poorer.
"""
from __future__ import annotations

import json
import os
from typing import Iterable, Optional

from . import config

MAX_ATTEMPTS_PER_IMAGE = 8


def merge_attempts(old: Optional[list], new: Optional[list]) -> list[dict]:
    """Union two attempt logs, newest last, bounded but never silently truncated.

    Without this, `merge_images` kept whichever attempt list it saw first. Every
    replay probe written after that first CDX query was dropped on the floor, so
    `needs_probe()` never saw a probe, every image looked undecided, and the
    same images were re-probed forever while the ledger stayed empty.
    """
    out: list[dict] = []
    seen: set[str] = set()
    for att in list(old or []) + list(new or []):
        if not isinstance(att, dict):
            continue
        key = "|".join(str(att.get(k)) for k in
                       ("endpoint", "url", "requested_timestamp", "capture_timestamp", "status", "note"))
        if key in seen:
            continue
        seen.add(key)
        out.append(att)
    if len(out) > MAX_ATTEMPTS_PER_IMAGE:
        folded = len(out) - MAX_ATTEMPTS_PER_IMAGE
        summary = {"endpoint": "attempt-log",
                   "note": f"{folded} earlier attempt(s) folded into this summary; "
                           "the full per-key history is in data/missing.jsonl",
                   "n_earlier_attempts": folded,
                   "earlier_endpoints": sorted({str(a.get("endpoint")) for a in out[:folded]})}
        out = [summary] + out[-MAX_ATTEMPTS_PER_IMAGE:]
    return out


def ensure_dirs() -> None:
    for path in (config.DATA_DIR, config.CDX_DIR, config.CAPTURE_DIR, config.POST_DIR, config.BLOB_DIR):
        os.makedirs(path, exist_ok=True)


class JsonlStore:
    def __init__(self, path: str, key_fields: tuple[str, ...] = ("id",)):
        self.path = path
        self.key_fields = key_fields
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)

    def records(self) -> list[dict]:
        if not os.path.exists(self.path):
            return []
        out = []
        with open(self.path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    out.append(json.loads(line))
                except Exception:
                    continue
        return out

    def key(self, rec: dict) -> str:
        return "|".join(str(rec.get(k, "")) for k in self.key_fields)

    def append(self, records: Iterable[dict]) -> int:
        n = 0
        with open(self.path, "a", encoding="utf-8") as fh:
            for rec in records:
                fh.write(json.dumps(rec, ensure_ascii=False, sort_keys=True) + "\n")
                n += 1
            fh.flush()
            os.fsync(fh.fileno())
        return n

    def upsert(self, record: dict) -> None:
        existing = {self.key(r): r for r in self.records()}
        k = self.key(record)
        merged = merge_missing_fields(existing.get(k, {}), record)
        existing[k] = merged
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            for rec in existing.values():
                fh.write(json.dumps(rec, ensure_ascii=False, sort_keys=True) + "\n")
        os.replace(tmp, self.path)


def merge_missing_fields(old: dict, new: dict) -> dict:
    """Fill gaps in `old` from `new`; richer values already present win."""
    out = dict(old or {})
    for key, val in (new or {}).items():
        if key not in out or out.get(key) in (None, "", [], {}, 0):
            out[key] = val
        elif isinstance(out[key], str) and isinstance(val, str) and len(val) > len(out[key]):
            out[key] = val
    out["updated_at"] = new.get("updated_at") or out.get("updated_at") or ""
    return out


class PostStore:
    """One JSON document per post id (bulk crawl state: registry checkpoint)."""

    def __init__(self, directory: str = ""):
        # Resolved per call, not at import time: a default argument would bind
        # whatever config.POST_DIR was when the module loaded, so any later
        # override (tests, alternate data roots) silently pointed at the
        # repository's real data/posts.
        self.dir = directory or config.POST_DIR
        os.makedirs(self.dir, exist_ok=True)

    def path(self, post_id: str) -> str:
        return os.path.join(self.dir, f"{post_id}.json")

    def get(self, post_id: str) -> dict:
        p = self.path(post_id)
        if not os.path.exists(p):
            return {}
        try:
            with open(p, encoding="utf-8") as fh:
                return json.load(fh)
        except Exception:
            return {}

    def put(self, post_id: str, record: dict) -> dict:
        # The file name is the durable identity of a post: always (re)assert it.
        record = dict(record or {})
        record["post_id"] = post_id
        merged = merge_post(self.get(post_id), record)
        tmp = self.path(post_id) + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(merged, fh, ensure_ascii=False, sort_keys=True, indent=1)
        os.replace(tmp, self.path(post_id))
        return merged

    def ids(self) -> list[str]:
        return sorted(f[:-5] for f in os.listdir(self.dir) if f.endswith(".json"))

    def all(self) -> Iterable[dict]:
        for pid in self.ids():
            rec = self.get(pid)
            if rec:
                yield rec


def merge_images(old_images: list[dict], new_images: list[dict]) -> list[dict]:
    """Union by media URL; a recovered image is never downgraded to missing."""
    by_url: dict[str, dict] = {}
    order: list[str] = []
    for img in list(old_images) + list(new_images):
        url = img.get("media_url", "")
        if not url:
            continue
        if url not in by_url:
            by_url[url] = dict(img)
            order.append(url)
            continue
        cur = by_url[url]
        was_recovered = bool(cur.get("sha256"))
        merged = dict(cur)
        for key, val in img.items():
            if merged.get(key) in (None, "", [], {}) and val not in (None, "", [], {}):
                merged[key] = val
        if was_recovered:
            # prefer larger / newer evidence but keep any recovered digest
            for key in ("sha256", "bytes", "blob_path", "media_type", "capture", "file"):
                if cur.get(key):
                    merged[key] = cur[key]
            merged["state"] = cur.get("state", "recovered")
        else:
            # The newest evaluation of a still-missing image describes why it
            # is still missing; keeping the oldest verdict froze the record at
            # whatever the first (weakest) method decided.
            for key in ("state", "error", "note", "capture_count", "host_inventory"):
                if img.get(key) not in (None, "", [], {}):
                    merged[key] = img[key]
        merged["attempts"] = merge_attempts(cur.get("attempts"), img.get("attempts"))
        # Alternate CDN URL forms and the size/extension variant list only ever
        # grow: a form learned later (e.g. a capture on a different shard) must
        # survive a re-put, or the resolver can never probe it.
        for key in ("url_forms", "variants"):
            merged_list = list(cur.get(key) or [])
            for item in img.get(key) or []:
                if item and item not in merged_list:
                    merged_list.append(item)
            if merged_list:
                merged[key] = merged_list
        if img.get("xshard_capture") and not merged.get("xshard_capture"):
            merged["xshard_capture"] = img["xshard_capture"]
            # A newly discovered cross-shard form re-opens the image: the
            # terminal gap was decided without knowing that form, so it must
            # not suppress the probe the queue would otherwise skip.
            if not merged.get("sha256"):
                merged["error"] = None
                merged["state"] = "pending"
        by_url[url] = merged
    # A recovered image carries no failure. This runs for every image, not only
    # ones that passed through the merge branch above: a single-pass record
    # (e.g. `repair`) keeps the first dict verbatim. Observed on post
    # 29905114965: state=recovered, sha256 set, error=archive_gap.
    for url in order:
        if by_url[url].get("sha256"):
            by_url[url]["error"] = None
    return [by_url[u] for u in order]


def merge_post(old: dict, new: dict) -> dict:
    """Monotonic merge of two post records.

    Later evidence may only add or lengthen: a recovered image is never
    dropped, a longer content_html/content_text wins, and bookkeeping fields
    (`post_id`, `methods`, `images_done`, `published`) must survive the merge or
    later runs cannot resume.
    """
    out = dict(old or {})
    for key in ("post_id", "original_url", "capture_timestamp", "replay_url", "page_sha256",
                "posted_on", "post_datetime", "content_source", "date_text", "fetched_at",
                "state", "methods", "images_done", "published", "partial"):
        if new.get(key) not in (None, "", [], {}):
            out[key] = new[key]
    for key in ("canonical_urls", "captures", "refetched_captures"):
        merged = list(out.get(key) or [])
        for item in new.get(key) or []:
            if item not in merged:
                merged.append(item)
        out[key] = merged
    for key in ("content_html", "content_text"):
        old_val, new_val = out.get(key) or "", new.get(key) or ""
        if len(new_val) > len(old_val):
            out[key] = new_val
        elif not old_val:
            out[key] = new_val
    for key in ("tags", "captions"):
        merged = list(out.get(key) or [])
        for item in new.get(key) or []:
            if item and item not in merged:
                merged.append(item)
        out[key] = merged
    # Failure counters must advance on every failed pass. They are scalars that
    # already exist in the old record, so the "adopt when absent" rule below
    # silently froze them at 1 -- a `snapshot_exists` post (replay 404, the
    # availability API still lists a pre-cutoff capture) was then retried
    # forever, spending archive requests on a verdict that cannot change.
    for key in ("failure_count", "snapshot_retries"):
        out[key] = max(int(out.get(key) or 0), int((new or {}).get(key) or 0))
    # Any other scalar evidence is adopted when the post does not have it yet.
    for key, val in (new or {}).items():
        if key in out or key in ("images", "missing_images"):
            continue
        if val not in (None, "", [], {}):
            out[key] = val
    out["images"] = merge_images(out.get("images") or [], new.get("images") or [])
    missing = [img for img in out["images"] if not img.get("sha256")]
    out["missing_images"] = [
        {"media_url": img.get("media_url"), "reason": img.get("error"), "attempts": img.get("attempts", [])}
        for img in missing
    ]
    out["image_count"] = len([i for i in out["images"] if i.get("sha256")])
    out["missing_image_count"] = len(missing)
    out["partial"] = bool(missing)
    out["state"] = "recovered" if out["images"] and not missing else (
        "partial" if out["images"] else (new.get("state") or out.get("state") or "pending")
    )
    return out


def ledger_entry(kind: str, key: str, reason: str, attempts: list[dict], extra: Optional[dict] = None) -> dict:
    return {
        "kind": kind,          # post | image
        "key": key,            # post id or media url
        "reason": reason,      # archive_gap | timeout | throttled | ...
        "methods": attempts,   # exact urls, captures, endpoints, outcomes
        **(extra or {}),
    }
