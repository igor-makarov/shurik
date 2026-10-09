"""Crawl-state checkpoint: bulk recovery state in the registry, not in Git.

Why this exists
---------------
`data/posts/`, `data/cdx/`, the per-image queue and the missing/gap ledgers are
bulk crawl state. They are gitignored on purpose (see .gitignore) because a
fresh runner cannot get them from the tree, and Git history is only a one-off
bootstrap. The numeric per-post tags hold the *published* posts; they cannot
hold the 1000+ post records that have no recovered image yet, nor the retry
state that keeps the next runner from re-asking the archive the same questions.

So the bulk state goes to the same public package under one documented extra
tag, `crawl-state`, as a gzip tar layer. It is internal crawl state: not a
recovered post, not progress toward image recovery, and not user-facing
content. A tiny pointer (`data/checkpoint.json`, committed) records the schema
version and the manifest digest, so a runner can tell what it restored and
whether the layer is the one the pointer promises.

Layout inside the layer is the same relative paths the crawler uses, so
restoring fills absent files in the repository root. Existing files restored
from the paired control checkpoint or Git are authoritative and are never
replaced by the potentially older mutable registry tag.
"""
from __future__ import annotations

import gzip
import hashlib
import io
import json
import os
import tarfile
import time
from typing import Iterable, Optional

from . import config, oci
from .publish import Registry

STATE_TAG = "crawl-state"
SCHEMA_VERSION = 1
POINTER_PATH = os.path.join(config.DATA_DIR, "checkpoint.json")

# Bulk crawl state worth carrying between runners. Image bytes are NOT here:
# they live in the per-post numeric tags (and in data/blobs/ locally).
STATE_FILES = (
    "data/image-queue.json",
    "data/missing.jsonl",
    "data/gaps.jsonl",
)
# `data/work/hostdumps` holds the resume-key host inventories. They are large
# but bulk crawl state, not Git content, and a `complete` host verdict is only
# usable when its rows can be restored (see recovery/hostdump.py). Carrying
# them here is what makes the hostdump's durability claim true across runners.
STATE_DIRS = ("data/posts", "data/cdx", "data/work/hostdumps")


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _collect(root: str = ".") -> list[tuple[str, bytes]]:
    out: list[tuple[str, bytes]] = []
    for rel in STATE_FILES:
        path = os.path.join(root, rel)
        if os.path.isfile(path):
            with open(path, "rb") as fh:
                out.append((rel, fh.read()))
    for d in STATE_DIRS:
        base = os.path.join(root, d)
        if not os.path.isdir(base):
            continue
        for dirpath, _dirs, files in os.walk(base):
            for name in sorted(files):
                if name.endswith(".tmp"):
                    continue
                full = os.path.join(dirpath, name)
                rel = os.path.relpath(full, root).replace(os.sep, "/")
                try:
                    with open(full, "rb") as fh:
                        out.append((rel, fh.read()))
                except OSError:
                    continue
    out.sort()
    return out


def tar_gz_tree(entries: Iterable[tuple[str, bytes]], mtime: int = 0) -> bytes:
    """One gzip tar containing many files (a single layer, one compression)."""
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.PAX_FORMAT) as tar:
        for name, data in entries:
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mtime = mtime
            info.mode = 0o644
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            tar.addfile(info, io.BytesIO(data))
    out = io.BytesIO()
    with gzip.GzipFile(fileobj=out, mode="wb", compresslevel=6, mtime=0) as gz:
        gz.write(raw.getvalue())
    return out.getvalue()


def _extract(blob: bytes, root: str = ".", preserved: Optional[list[str]] = None) -> list[str]:
    written: list[str] = []
    with tarfile.open(fileobj=io.BytesIO(gzip.decompress(blob)), mode="r:") as tar:
        for member in tar.getmembers():
            if not member.isfile():
                continue
            name = member.name
            if name.startswith("/") or ".." in name.split("/"):
                continue                      # never write outside the checkout
            if name not in STATE_FILES and not any(name.startswith(d + "/") for d in STATE_DIRS):
                continue                      # only declared crawl state
            dest = os.path.join(root, name)
            if os.path.commonpath((os.path.realpath(root), os.path.realpath(dest))) != os.path.realpath(root):
                continue                      # reject symlink traversal too
            if os.path.lexists(dest):
                if preserved is not None:
                    preserved.append(name)
                continue                      # Git/control state may be newer than crawl-state
            os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
            data = tar.extractfile(member).read()
            tmp = dest + ".tmp"
            with open(tmp, "wb") as fh:
                fh.write(data)
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp, dest)
            written.append(name)
    return sorted(written)


def build_state_artifact(root: str = ".") -> tuple[oci.Blob, list[oci.Blob], dict, oci.Blob, str]:
    """Build (config, layers, manifest, manifest_blob, content_digest)."""
    entries = _collect(root)
    payload = tar_gz_tree(entries)
    summary = {
        "schema_version": SCHEMA_VERSION,
        "tag": STATE_TAG,
        "cutoff": config.CUTOFF,
        "built_at": _now(),
        "file_count": len(entries),
        "files": [name for name, _ in entries[:50]],
        "note": "internal crawl state: post records, CDX inventories, retry queues; "
                "no recovered image bytes (those are in the numeric post tags)",
    }
    index_blob = json.dumps(summary, ensure_ascii=False, sort_keys=True, indent=1).encode("utf-8")
    layer = oci.Blob(payload, oci.LAYER_MEDIA_TYPE)
    diff_id = "sha256:" + hashlib.sha256(gzip.decompress(payload)).hexdigest()
    created = _now()
    config_doc = {
        "created": created,
        "architecture": oci.ARCH,
        "os": oci.OS,
        "config": {"Labels": {
            "org.opencontainers.image.title": "hazfalafel crawl state",
            "org.opencontainers.image.created": created,
            "org.opencontainers.image.source": config.REPO_SOURCE_LABEL,
            "org.opencontainers.image.description": "internal crawl state (posts, cdx, queues)",
            "shurik.checkpoint.schema": str(SCHEMA_VERSION),
            "shurik.checkpoint.files": str(len(entries)),
        }},
        "rootfs": {"type": "layers", "diff_ids": [diff_id]},
        "history": [{"created": created, "created_by": "shurik-hazfalafel-recovery crawl-state"}],
        "shurik": {"version": 1, "checkpoint": summary, "index": index_blob.decode("utf-8")},
    }
    config_blob = oci.Blob(json.dumps(config_doc, ensure_ascii=False, sort_keys=True,
                                      indent=1).encode("utf-8"), oci.CONFIG_MEDIA_TYPE)
    manifest = {
        "schemaVersion": 2,
        "mediaType": oci.MANIFEST_MEDIA_TYPE,
        "config": config_blob.digest_as_dict(),
        "layers": [layer.digest_as_dict()],
        "annotations": {
            "org.opencontainers.image.title": "hazfalafel crawl state",
            "org.opencontainers.image.source": config.REPO_SOURCE_LABEL,
            "org.opencontainers.image.created": created,
            "shurik.checkpoint.schema": str(SCHEMA_VERSION),
            "shurik.checkpoint.files": str(len(entries)),
            "shurik.checkpoint.cutoff": config.CUTOFF,
        },
    }
    manifest_blob = oci.Blob(json.dumps(manifest, ensure_ascii=False, sort_keys=True,
                                        indent=1).encode("utf-8"), oci.MANIFEST_MEDIA_TYPE)
    return config_blob, [layer], manifest, manifest_blob, manifest_blob.digest


def push_state(root: str = ".", registry: Optional[Registry] = None) -> dict:
    """Upload the checkpoint and write the committed pointer."""
    registry = registry or Registry()
    config_blob, layers, _manifest, manifest_blob, digest = build_state_artifact(root)
    uploaded = [registry.push_blob(b) for b in [config_blob] + layers]
    registry.push_manifest(manifest_blob, STATE_TAG)
    pointer = {
        "schema_version": SCHEMA_VERSION,
        "tag": STATE_TAG,
        "package": config.PACKAGE_URL,
        "manifest_digest": digest,
        "pushed_at": _now(),
        "blobs": {"config": config_blob.digest, "layer": layers[0].digest},
        "layer_bytes": layers[0].size,
        "contains": ["data/posts", "data/cdx", "data/image-queue.json",
                     "data/missing.jsonl", "data/gaps.jsonl"],
    }
    os.makedirs(os.path.dirname(POINTER_PATH) or ".", exist_ok=True)
    with open(POINTER_PATH, "w", encoding="utf-8") as fh:
        json.dump(pointer, fh, ensure_ascii=False, sort_keys=True, indent=1)
        fh.write("\n")
    return {"tag": STATE_TAG, "manifest_digest": digest, "blobs": uploaded,
            "layer_bytes": layers[0].size, "pointer": POINTER_PATH}


def restore_state(root: str = ".", puller=None) -> dict:
    """Pull `crawl-state` anonymously to fill missing state without rollback."""
    from .verify import AnonymousPuller

    puller = puller or AnonymousPuller()
    out = {"tag": STATE_TAG, "restored": False, "files": 0, "manifest_digest": "",
           "schema_version": None, "preserved_files": 0, "error": ""}
    try:
        manifest, digest = puller.manifest(STATE_TAG)
    except Exception as exc:
        out["error"] = f"{type(exc).__name__}: {exc}"
        return out
    if not manifest:
        out["error"] = "no crawl-state tag in the package"
        return out
    out["manifest_digest"] = digest
    ann = manifest.get("annotations") or {}
    out["schema_version"] = int(ann.get("shurik.checkpoint.schema") or 0)
    layers = manifest.get("layers") or []
    if not layers:
        out["error"] = "crawl-state manifest has no layer"
        return out
    try:
        payload = puller.blob(layers[0]["digest"])
        preserved = []
        names = _extract(payload, root, preserved)
    except Exception as exc:
        out["error"] = f"{type(exc).__name__}: {exc}"
        return out
    out.update({"restored": True, "files": len(names), "preserved_files": len(preserved)})
    return out


def read_pointer() -> dict:
    if not os.path.exists(POINTER_PATH):
        return {}
    try:
        with open(POINTER_PATH, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return {}
