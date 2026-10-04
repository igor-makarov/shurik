"""Durable state in Git: inventories, post records, ledgers, publish log.

Merging is additive and monotonic: reruns merge new evidence into existing
records and never drop recovered images or replace richer metadata with poorer.
"""
from __future__ import annotations

import json
import os
from typing import Iterable, Optional

from . import config


def ensure_dirs() -> None:
    for path in (config.DATA_DIR, config.CAPTURE_DIR, config.POST_DIR, config.BLOB_DIR):
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
    """One JSON document per post id (committed to Git; small by design)."""

    def __init__(self, directory: str = config.POST_DIR):
        self.dir = directory
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
        # prefer larger / newer evidence but keep any recovered digest
        if was_recovered:
            for key in ("sha256", "bytes", "blob_path", "media_type", "capture"):
                if cur.get(key):
                    merged[key] = cur[key]
            merged["state"] = cur.get("state", "recovered")
        by_url[url] = merged
    return [by_url[u] for u in order]


def merge_post(old: dict, new: dict) -> dict:
    """Monotonic merge of two post records."""
    out = dict(old or {})
    for key in ("original_url", "capture_timestamp", "replay_url", "page_sha256", "posted_on",
                "post_datetime", "content_source", "date_text", "fetched_at", "state"):
        if new.get(key):
            out[key] = new[key]
    for key in ("canonical_urls", "captures"):
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
