"""Anonymous, byte-level verification of a published per-post artifact.

The task is only done when a *third party with no credentials* can pull the tag
and get the recovered JPEG back out of an image layer. Config labels and an
image-count annotation prove nothing, so this module:

  1. requests an anonymous pull token (no Authorization header is ever sent),
  2. GETs the manifest by tag and records its digest (header + recomputed),
  3. GETs every layer blob, decompresses the gzip tar and hashes the real file,
  4. compares the recovered bytes with `data/posts/<id>.json` (sha256, size,
     caption, content text/HTML, tags, capture provenance),
  5. writes a machine-readable report to `data/verification/<tag>.json`.

A failed check is recorded as `false` with the observed value, never dropped.
"""
from __future__ import annotations

import gzip
import hashlib
import io
import json
import os
import tarfile
import time
from typing import Optional

from . import config, oci

try:
    import requests  # type: ignore
except Exception:  # pragma: no cover
    requests = None  # type: ignore

VERIFY_DIR = os.path.join(config.DATA_DIR, "verification")
MANIFEST_ACCEPT = ", ".join([
    oci.MANIFEST_MEDIA_TYPE,
    "application/vnd.docker.distribution.manifest.v2+json",
    "application/vnd.oci.image.index.v1+json",
])


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _check(name: str, ok: bool, observed=None, expected=None, note: str = "") -> dict:
    row = {"check": name, "passed": bool(ok)}
    if observed is not None:
        row["observed"] = observed
    if expected is not None:
        row["expected"] = expected
    if note:
        row["note"] = note
    return row


class AnonymousPuller:
    """Registry v2 client that deliberately sends no credentials."""

    def __init__(self, repo: str = config.GHCR_REPO, registry: str = config.REGISTRY, session=None):
        if requests is None:  # pragma: no cover
            raise RuntimeError("requests is required for registry access")
        self.registry = registry
        self.repo = repo
        self.session = session or requests.Session()
        self._token: Optional[str] = None
        self.requests_made: list[str] = []

    def _url(self, path: str) -> str:
        return f"https://{self.registry}/v2/{self.repo}/{path}"

    def token(self, force: bool = False) -> str:
        # Anonymous: no Authorization header, no GITHUB_TOKEN in the process.
        if self._token and not force:
            return self._token
        url = (f"https://{self.registry}/token?service={self.registry}"
               f"&scope=repository:{self.repo}:pull")
        resp = self.session.get(url, timeout=60)
        self.requests_made.append(f"token -> HTTP {resp.status_code}")
        if resp.status_code != 200:
            raise RuntimeError(f"anonymous token request failed with HTTP {resp.status_code}")
        body = resp.json()
        token = body.get("token") or body.get("access_token")
        if not token:
            raise RuntimeError("anonymous token response had no token")
        self._token = token
        return token

    def _headers(self, extra: Optional[dict] = None) -> dict:
        h = {"Authorization": "Bearer " + self.token()}
        if extra:
            h.update(extra)
        return h

    def manifest(self, reference: str) -> tuple[dict, str]:
        resp = self.session.get(self._url(f"manifests/{reference}"),
                                headers=self._headers({"Accept": MANIFEST_ACCEPT}), timeout=90)
        self.requests_made.append(f"manifest {reference} -> HTTP {resp.status_code}")
        if resp.status_code != 200:
            raise RuntimeError(f"anonymous manifest GET {reference} -> HTTP {resp.status_code}")
        computed = "sha256:" + hashlib.sha256(resp.content).hexdigest()
        header = ""
        for part in (resp.headers.get("docker-content-digest") or "").split(";"):
            part = part.strip()
            if part.startswith("docker-content-digest="):
                header = part.split("=", 1)[1]
        return resp.json(), header or computed

    def blob(self, digest: str) -> bytes:
        resp = self.session.get(self._url(f"blobs/{digest}"),
                                headers=self._headers(), timeout=180)
        self.requests_made.append(f"blob {digest[:19]} -> HTTP {resp.status_code}")
        if resp.status_code != 200:
            raise RuntimeError(f"anonymous blob GET {digest} -> HTTP {resp.status_code}")
        return resp.content


def _layer_files(payload: bytes) -> list[tuple[str, bytes]]:
    raw = gzip.decompress(payload)
    out: list[tuple[str, bytes]] = []
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:") as tar:
        for member in tar.getmembers():
            if not member.isfile():
                continue
            fh = tar.extractfile(member)
            if fh is None:
                continue
            out.append((member.name, fh.read()))
    return out


def verify_tag(post_id: str, *, repo: str = config.GHCR_REPO, registry: str = config.REGISTRY,
               session=None, post_record: Optional[dict] = None,
               write: bool = True) -> dict:
    """Pull one tag anonymously and check the bytes against the post record."""
    report: dict = {
        "post_id": str(post_id),
        "package": f"{registry}/{repo}",
        "tag": str(post_id),
        "verified_at": _now(),
        "anonymous": True,
        "checks": [],
    }
    checks = report["checks"]
    try:
        puller = AnonymousPuller(repo=repo, registry=registry, session=session)
        manifest, digest = puller.manifest(str(post_id))
    except Exception as exc:
        checks.append(_check("anonymous_manifest_pull", False, note=f"{type(exc).__name__}: {exc}"))
        report["passed"] = False
        if write:
            _save(report)
        return report

    report["manifest_digest"] = digest
    checks.append(_check("anonymous_manifest_pull", True, digest))
    layers = manifest.get("layers") or []
    config_desc = manifest.get("config") or {}
    report["config_digest"] = config_desc.get("digest", "")
    report["layers"] = [{"digest": l.get("digest"), "size": l.get("size"),
                         "mediaType": l.get("mediaType")} for l in layers]

    try:
        config_bytes = puller.blob(config_desc["digest"])
    except Exception as exc:
        checks.append(_check("config_blob_pull", False, note=f"{type(exc).__name__}: {exc}"))
        report["passed"] = False
        if write:
            _save(report)
        return report
    config_doc = json.loads(config_bytes.decode("utf-8"))
    labels = (config_doc.get("config") or {}).get("Labels") or {}
    embedded = ((config_doc.get("shurik") or {}).get("post")) or {}
    report["labels"] = labels
    checks.append(_check("source_label", labels.get("org.opencontainers.image.source")
                         == config.REPO_SOURCE_LABEL,
                         labels.get("org.opencontainers.image.source"), config.REPO_SOURCE_LABEL))

    record = post_record if post_record is not None else _load_record(post_id)
    expected_images = [i for i in (record.get("images") or []) if i.get("sha256")]

    # --- image layers: the real proof -----------------------------------
    pulled: list[dict] = []
    post_json = None
    for layer in layers:
        payload = puller.blob(layer["digest"])
        layer_ok_digest = "sha256:" + hashlib.sha256(payload).hexdigest() == layer["digest"]
        try:
            files = _layer_files(payload)
        except Exception as exc:
            checks.append(_check(f"layer_decompress[{layer['digest'][:19]}]", False,
                                 note=f"{type(exc).__name__}: {exc}"))
            continue
        if not layer_ok_digest:
            checks.append(_check(f"layer_digest[{layer['digest'][:19]}]", False))
        for name, body in files:
            entry = {"layer": layer["digest"], "file": name, "bytes": len(body),
                     "sha256": hashlib.sha256(body).hexdigest()}
            if name == "post.json":
                post_json = json.loads(body.decode("utf-8"))
                entry["role"] = "post-metadata"
            else:
                entry["role"] = "media"
                magic = body[:12]
                entry["image_magic_ok"] = (body[:3] == b"\xff\xd8\xff" or magic[:4] == b"\x89PNG"
                                           or magic[:4] in (b"GIF8",) or magic[:2] == b"BM"
                                           or (body[:4] == b"RIFF" and body[8:12] == b"WEBP"))
            pulled.append(entry)
    report["pulled_files"] = pulled

    media = [p for p in pulled if p.get("role") == "media"]
    checks.append(_check("media_layer_count_matches_record", len(media) == len(expected_images),
                         len(media), len(expected_images),
                         "number of image files actually inside the layers vs the post record"))
    by_hash = {p["sha256"]: p for p in media}
    for img in expected_images:
        digest_ = img["sha256"]
        hit = by_hash.get(digest_)
        checks.append(_check(f"image_bytes[{img.get('media_key') or digest_[:12]}]", hit is not None,
                             hit.get("file") if hit else None, digest_,
                             "recovered image pulled anonymously out of an image layer"))
        if hit:
            checks.append(_check(f"image_size[{img.get('media_key') or digest_[:12]}]",
                                 hit["bytes"] == img.get("bytes"), hit["bytes"], img.get("bytes")))
            checks.append(_check(f"image_magic[{img.get('media_key') or digest_[:12]}]",
                                 bool(hit.get("image_magic_ok")), hit.get("image_magic_ok"), True,
                                 "the bytes really start with an image magic number"))

    # --- metadata equivalence -------------------------------------------
    meta = post_json or embedded
    checks.append(_check("post_metadata_layer_present", post_json is not None))
    for field, expected_val in (
        ("content_text", record.get("content_text")),
        ("content_html", record.get("content_html")),
        ("tags", record.get("tags")),
        ("captions", record.get("captions")),
        ("original_url", record.get("original_url")),
        ("cutoff", config.CUTOFF),
    ):
        if field == "cutoff":
            observed = (meta.get("recovery") or {}).get("cutoff")
        else:
            observed = meta.get(field)
        checks.append(_check(f"metadata[{field}]", observed == expected_val,
                             observed if not isinstance(observed, (list, str)) or len(str(observed)) < 200
                             else f"<{len(str(observed))} chars>",
                             expected_val if not isinstance(expected_val, (list, str))
                             or len(str(expected_val)) < 200 else f"<{len(str(expected_val))} chars>"))
    # caption of the recovered image itself
    for img in expected_images:
        cap = img.get("caption") or ""
        if not cap:
            continue
        art = [m for m in (meta.get("images") or []) if m.get("sha256") == img["sha256"]]
        checks.append(_check(f"image_caption[{img.get('media_key') or img['sha256'][:12]}]",
                             bool(art) and (art[0].get("caption") == cap),
                             (art[0].get("caption") if art else None), cap))
    # provenance
    prov = (meta.get("images") or [{}])[0].get("archive_capture") if meta.get("images") else None
    if expected_images and prov:
        exp_prov = expected_images[0].get("capture") or {}
        checks.append(_check("provenance[capture_timestamp]",
                             prov.get("timestamp") == exp_prov.get("timestamp"),
                             prov.get("timestamp"), exp_prov.get("timestamp")))
        checks.append(_check("provenance[replay_url]", prov.get("replay_url") == exp_prov.get("replay_url"),
                             prov.get("replay_url"), exp_prov.get("replay_url")))
        checks.append(_check("capture_within_cutoff",
                             bool(prov.get("timestamp")) and str(prov["timestamp"]) <= config.CUTOFF,
                             prov.get("timestamp"), f"<= {config.CUTOFF}"))

    failed = [c["check"] for c in checks if not c["passed"]]
    report["checks_passed"] = len(checks) - len(failed)
    report["checks_total"] = len(checks)
    report["failed_checks"] = failed
    report["images_verified"] = len([c for c in checks
                                     if c["passed"] and c["check"].startswith("image_bytes[")])
    report["passed"] = not failed
    if write:
        _save(report)
    return report


def _load_record(post_id: str) -> dict:
    path = os.path.join(config.POST_DIR, f"{post_id}.json")
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def _save(report: dict) -> str:
    os.makedirs(VERIFY_DIR, exist_ok=True)
    path = os.path.join(VERIFY_DIR, f"{report['tag']}.json")
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=1, sort_keys=True)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)
    return path