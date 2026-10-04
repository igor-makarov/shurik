"""Minimal OCI image-manifest builder: one artifact per Tumblr post.

Everything the recovery knows about a post lives in the artifact: the media
files are gzip tar layers, and the full post record (HTML, plain text, tags,
captions, original URLs, capture provenance) is in the image config under
`shurik.post`, mirrored into standard OCI annotations.
"""
from __future__ import annotations

import gzip
import hashlib
import io
import json
import tarfile
import time
from typing import Optional

from . import config

CONFIG_MEDIA_TYPE = "application/vnd.oci.image.config.v1+json"
MANIFEST_MEDIA_TYPE = "application/vnd.oci.image.manifest.v1+json"
LAYER_MEDIA_TYPE = "application/vnd.oci.image.layer.v1.tar+gzip"
INDEX_MEDIA_TYPE = "application/vnd.oci.image.index.v1+json"
EMPTY_LAYER_MEDIA_TYPE = "application/vnd.oci.empty.v1+json"

ARCH = "linux"
OS = "linux"


class Blob:
    def __init__(self, data: bytes, media_type: str):
        self.data = data
        self.media_type = media_type
        self.digest = "sha256:" + hashlib.sha256(data).hexdigest()
        self.size = len(data)


def tar_gz(name: str, data: bytes, mtime: int = 0) -> bytes:
    """Deterministic gzip tar with a single file entry."""
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.PAX_FORMAT) as tar:
        info = tarfile.TarInfo(name)
        info.size = len(data)
        info.mtime = mtime
        info.mode = 0o644
        info.uid = info.gid = 0
        info.uname = info.gname = ""
        tar.addfile(info, io.BytesIO(data))
    out = io.BytesIO()
    with gzip.GzipFile(fileobj=out, mode="wb", compresslevel=9, mtime=0) as gz:
        gz.write(raw.getvalue())
    return out.getvalue()


def _ann(pairs: dict) -> dict:
    return {k: v for k, v in pairs.items() if v}


def build_artifact(post: dict) -> tuple[Blob, list[Blob], str, dict, Blob]:
    """Build (config, layers, tag, manifest_dict, manifest_blob) for one post."""
    post_id = str(post["post_id"])
    tag = post_id  # numeric Tumblr post id is the artifact tag

    images = [img for img in post.get("images", []) if img.get("sha256")]
    missing_images = [img for img in post.get("images", []) if not img.get("sha256")]

    metadata = {
        "post_id": post_id,
        "blog": config.TUMBLR_BLOG,
        "original_url": post.get("original_url", ""),
        "canonical_urls": post.get("canonical_urls", []),
        "capture": post.get("capture", {}),
        "captures": post.get("captures", []),
        "posted_on": post.get("posted_on", ""),
        "post_datetime": post.get("post_datetime", ""),
        "tags": post.get("tags", []),
        "captions": post.get("captions", []),
        "content_html": post.get("content_html", ""),
        "content_text": post.get("content_text", ""),
        "images": [
            {
                "media_url": img.get("media_url", ""),
                "media_key": img.get("media_key"),
                "caption": img.get("caption", ""),
                "file": img.get("file"),
                "media_type": img.get("media_type"),
                "sha256": img.get("sha256"),
                "bytes": img.get("bytes"),
                "archive_capture": img.get("capture", {}),
            }
            for img in images
        ],
        "missing_images": [
            {"media_url": img.get("media_url", ""), "reason": img.get("error"),
             "attempts": img.get("attempts", [])}
            for img in missing_images
        ],
        "recovery": {
            "cutoff": config.CUTOFF,
            "state": post.get("state", "recovered"),
            "partial": bool(missing_images),
            "fetched_at": post.get("fetched_at", ""),
            "tool": "shurik-hazfalafel-recovery",
        },
    }

    layers: list[Blob] = []
    history: list[dict] = []
    created = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    for img in images:
        with open(img["blob_path"], "rb") as fh:
            body = fh.read()
        name = img.get("file") or img["sha256"]
        payload = tar_gz(name, body)
        layers.append(Blob(payload, LAYER_MEDIA_TYPE))
        history.append({
            "created": created,
            "created_by": f"hazfalafel-recovery add {name}",
            "comment": (img.get("caption", "") or "")[:512],
        })

    meta_blob = json.dumps(metadata, ensure_ascii=False, sort_keys=True, indent=1).encode("utf-8")
    meta_layer = tar_gz("post.json", meta_blob)
    layers.append(Blob(meta_layer, LAYER_MEDIA_TYPE))
    history.append({"created": created, "created_by": "hazfalafel-recovery add post.json"})

    if not layers:
        empty = tar_gz(".keep", b"")
        layers.append(Blob(empty, LAYER_MEDIA_TYPE))
        history.append({"created": created, "created_by": "hazfalafel-recovery add placeholder"})

    diff_ids = ["sha256:" + hashlib.sha256(gzip.decompress(l.data)).hexdigest() for l in layers]

    caption_summary = ""
    if post.get("captions"):
        caption_summary = " | ".join(c.splitlines()[0] for c in post["captions"][:3])[:500]
    text_summary = (post.get("content_text") or caption_summary or "").strip().splitlines()
    description = (text_summary[0] if text_summary else "")[:900]

    config_doc = {
        "created": created,
        "architecture": ARCH,
        "os": OS,
        "config": {
            "Labels": _ann({
                "org.opencontainers.image.title": f"hazfalafel post {post_id}",
                "org.opencontainers.image.description": description,
                "org.opencontainers.image.created": created,
                "org.opencontainers.image.source": config.REPO_SOURCE_LABEL,
                "org.opencontainers.image.url": post.get("original_url", ""),
                "org.opencontainers.image.revision": post.get("capture", {}).get("timestamp", ""),
                "org.opencontainers.image.licenses": "UNKNOWN",
                "org.opencontainers.image.vendor": "Hazfalafel (archived)",
                "shurik.post.id": post_id,
                "shurik.post.tags": ",".join(post.get("tags", []))[:1024],
                "shurik.post.images": str(len(images)),
                "shurik.post.missing_images": str(len(missing_images)),
                "shurik.post.cutoff": config.CUTOFF,
            })
        },
        "rootfs": {"type": "layers", "diff_ids": diff_ids},
        "history": history,
        "shurik": {
            "version": 1,
            "package": config.PACKAGE_URL,
            "post": metadata,
        },
    }
    config_blob = Blob(json.dumps(config_doc, ensure_ascii=False, sort_keys=True, indent=1).encode("utf-8"),
                       CONFIG_MEDIA_TYPE)

    annotations = _ann({
        "org.opencontainers.image.title": f"hazfalafel post {post_id}",
        "org.opencontainers.image.description": description,
        "org.opencontainers.image.created": created,
        "org.opencontainers.image.source": config.REPO_SOURCE_LABEL,
        "org.opencontainers.image.url": post.get("original_url", ""),
        "org.opencontainers.image.revision": post.get("capture", {}).get("timestamp", ""),
        "shurik.post.id": post_id,
        "shurik.post.tags": json.dumps(post.get("tags", []), ensure_ascii=False),
        "shurik.post.captions": json.dumps(post.get("captions", []), ensure_ascii=False),
        "shurik.post.original_url": post.get("original_url", ""),
        "shurik.post.captures": json.dumps(post.get("captures", []), ensure_ascii=False),
        "shurik.post.image_sha256": json.dumps([img["sha256"] for img in images]),
        "shurik.post.partial": "true" if missing_images else "false",
        "shurik.post.cutoff": config.CUTOFF,
    })

    manifest = {
        "schemaVersion": 2,
        "mediaType": MANIFEST_MEDIA_TYPE,
        "config": config_blob.digest_as_dict(),
        "layers": [
            {
                "mediaType": l.media_type,
                "digest": l.digest,
                "size": l.size,
                "annotations": _ann({"org.opencontainers.image.title": "media"})
                if l.media_type != LAYER_MEDIA_TYPE or True else {},
            }
            for l in layers
        ],
        "annotations": annotations,
    }
    manifest["layers"][-1]["annotations"] = _ann({"shurik.layer": "post-metadata"})
    manifest_blob = Blob(json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=1).encode("utf-8"),
                         MANIFEST_MEDIA_TYPE)
    return config_blob, layers, tag, manifest, manifest_blob


def _as_dict(self):  # attached below to keep Blob tidy
    return {"mediaType": self.media_type, "digest": self.digest, "size": self.size}


Blob.digest_as_dict = _as_dict  # type: ignore[attr-defined]


def index_entry(manifest_blob: Blob, tag: str, annotations: Optional[dict] = None) -> dict:
    return {
        "mediaType": manifest_blob.media_type,
        "digest": manifest_blob.digest,
        "size": manifest_blob.size,
        "annotations": _ann(dict(annotations or {}, **{"org.opencontainers.image.ref.name": tag})),
    }
