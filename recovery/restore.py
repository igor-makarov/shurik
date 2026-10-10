"""Restore post state from the GHCR package into the local working tree.

Why this exists
---------------
The numeric tag of a post is the *checkpoint* for that post: its `post.json`
layer carries the full metadata and every recovered image layer carries the
bytes. The local `data/posts/<id>.json` record is only a cache, and after a
fresh runner (or a `git archive` bootstrap of the old bulk corpus) it is
*behind* the registry. Working from the stale local record wastes archive
requests re-probing images the registry already holds, and -- worse -- makes
`publish_post` skip an update ("already published with >= recovered data")
because its local image count is smaller than the published one, so newly
recovered bytes would sit only in the local blob cache.

Restoring is therefore both a throughput fix and a correctness fix. It is
anonymous (no credentials), bounded by the requested ids, and monotonic: it
never drops a locally recovered image that the registry does not know about.
"""
from __future__ import annotations

import hashlib
import json
import os
from typing import Optional

from . import config
from .images import sniff_image, store_blob
from .store import PostStore, ensure_dirs
from .verify import AnonymousPuller, _layer_files


def _merge_images(local: list[dict], remote: list[dict]) -> tuple[list[dict], int]:
    """Union local and registry image lists; registry entries carry the sha256."""
    by_url: dict[str, dict] = {}
    order: list[str] = []
    for img in list(local or []) + list(remote or []):
        url = img.get("media_url") or ""
        if not url:
            continue
        if url not in by_url:
            by_url[url] = dict(img)
            order.append(url)
            continue
        merged = by_url[url]
        # Never downgrade: a locally recovered image keeps its bytes.
        for key, value in img.items():
            if value in (None, "", [], {}):
                continue
            if key == "sha256" and merged.get("sha256"):
                continue
            merged[key] = value
    added = sum(1 for url in order if by_url[url].get("sha256") and not
                any(i.get("media_url") == url and i.get("sha256") for i in (local or [])))
    return [by_url[url] for url in order], added


def restore_post(post_id: str, puller: Optional[AnonymousPuller] = None,
                 *, with_images: bool = True, store: Optional[PostStore] = None) -> dict:
    """Pull one numeric tag anonymously and merge it into the local record."""
    puller = puller or AnonymousPuller()
    store = store or PostStore()
    result = {"post_id": str(post_id), "restored": False, "images": 0, "new_images": 0,
              "error": "", "blob_bytes": 0}
    try:
        manifest, digest = puller.manifest(str(post_id))
    except Exception as exc:
        result["error"] = f"{type(exc).__name__}: {exc}"
        return result
    meta: dict = {}
    media_layers = []
    for layer in manifest.get("layers", []):
        media_type = layer.get("mediaType", "")
        try:
            payload = puller.blob(layer["digest"])
        except Exception as exc:
            result["error"] = f"blob {layer.get('digest','')[:19]}: {exc}"
            continue
        try:
            files = _layer_files(payload)
        except Exception:
            continue
        for name, body in files:
            if name.endswith("post.json"):
                try:
                    meta = json.loads(body.decode("utf-8"))
                except Exception:
                    meta = {}
            else:
                media_layers.append((name, body, media_type))
    if not meta:
        result["error"] = result["error"] or "no post.json layer"
        return result

    ensure_dirs()
    remote_images = []
    for entry in meta.get("images", []):
        img = dict(entry)
        sha = img.get("sha256") or ""
        if sha and with_images:
            want = img.get("file") or sha
            body = next((b for n, b, _t in media_layers if n == want), None)
            if body is None and len(media_layers) == 1:
                body = media_layers[0][1]
            if body is not None and hashlib.sha256(body).hexdigest() == sha:
                if sniff_image(body):
                    digest_hex, path = store_blob(body)
                    img["blob_path"] = path
                    result["blob_bytes"] += len(body)
                else:
                    result["error"] = f"{want}: layer bytes are not an image"
        if img.get("sha256"):
            remote_images.append(img)

    local = store.get(str(post_id)) or {}
    images, added = _merge_images(local.get("images") or [], remote_images)
    for img in images:
        if img.get("sha256") and not img.get("blob_path"):
            # Digest known but bytes absent locally: it will be re-fetched or
            # restored from the registry later, never silently "published".
            img.pop("blob_path", None)
    merged = dict(local)
    for key in ("content_html", "content_text", "tags", "captions", "canonical_urls",
                "original_url", "capture_timestamp", "posted_on", "post_datetime"):
        if not merged.get(key) and meta.get(key):
            merged[key] = meta[key]
    merged["post_id"] = str(post_id)
    merged["images"] = images
    merged.setdefault("captures", [])
    if meta.get("captures") and not merged["captures"]:
        merged["captures"] = meta["captures"]
    merged["image_count"] = sum(1 for i in images if i.get("sha256"))
    merged["missing_image_count"] = sum(1 for i in images if not i.get("sha256"))
    merged["state"] = merged.get("state") or "fetched"
    merged["restored_from_registry"] = {"manifest_digest": digest, "at": _now()}
    store.put(str(post_id), merged)
    result.update({"restored": True, "images": merged["image_count"], "new_images": added,
                   "manifest_digest": digest})
    return result


def _now() -> str:
    import time

    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def restore_posts(post_ids: list[str], *, with_images: bool = True,
                  repo: str = config.GHCR_REPO, registry: str = config.REGISTRY) -> dict:
    """Restore several tags with one anonymous token."""
    puller = AnonymousPuller(repo=repo, registry=registry)
    store = PostStore()
    results = [restore_post(pid, puller, with_images=with_images, store=store)
               for pid in post_ids]
    return {"posts": len(results),
            "restored": sum(1 for r in results if r["restored"]),
            "images": sum(r["images"] for r in results),
            "new_images": sum(r["new_images"] for r in results),
            "blob_bytes": sum(r["blob_bytes"] for r in results),
            "errors": [r for r in results if r["error"]],
            "results": results}