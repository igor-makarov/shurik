"""GHCR (OCI registry v2) push for per-post artifacts.

Credentials come from the environment only (GITHUB_TOKEN / GHCR_USERNAME) and
are never written to disk, logs or artifacts.
"""
from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field
from typing import Optional

from . import config, oci

try:
    import requests  # type: ignore
except Exception:  # pragma: no cover
    requests = None  # type: ignore


class AuthError(Exception):
    pass


class PublishError(Exception):
    pass


@dataclass
class PushResult:
    tag: str
    action: str            # pushed | updated | skipped | failed
    manifest_digest: str = ""
    reason: str = ""
    layers: list = field(default_factory=list)
    config_digest: str = ""
    image_count: int = 0
    missing_count: int = 0


def _auth() -> tuple[str, str]:
    user = os.environ.get("GHCR_USERNAME", "")
    token = os.environ.get("GITHUB_TOKEN", "")
    if not token:
        raise AuthError("GITHUB_TOKEN is not set in the environment")
    if not user:
        raise AuthError("GHCR_USERNAME is not set in the environment")
    return user, token


class Registry:
    """Tiny OCI distribution client: token auth, blob push, manifest push."""

    def __init__(self, repo: str = config.GHCR_REPO, registry: str = config.REGISTRY,
                 session=None, sleep=time.sleep):
        if requests is None:  # pragma: no cover
            raise AuthError("requests is required for registry access")
        self.registry = registry
        self.repo = repo
        self.sleep = sleep
        self.session = session or requests.Session()
        self._token: Optional[str] = None
        self._token_scope: Optional[str] = None

    # -- plumbing ----------------------------------------------------------
    def _basic(self):
        import base64

        user, token = _auth()
        raw = base64.b64encode(f"{user}:{token}".encode()).decode()
        return {"Authorization": "Basic " + raw}

    def _bearer(self, scope: str, force: bool = False) -> str:
        if not force and self._token and self._token_scope == scope:
            return self._token
        url = f"https://{self.registry}/token?service={self.registry}&scope={scope}"
        resp = self.session.get(url, headers=self._basic(), timeout=30)
        if resp.status_code != 200:
            raise AuthError(f"registry token request failed with HTTP {resp.status_code}")
        self._token = resp.json().get("token") or resp.json().get("access_token")
        self._token_scope = scope
        if not self._token:
            raise AuthError("registry token response had no token")
        return self._token

    def _headers(self, extra: Optional[dict] = None, retry: bool = True) -> dict:
        scope = f"repository:{self.repo}:pull,push"
        token = self._bearer(scope, force=retry)
        h = {"Authorization": "Bearer " + token}
        if extra:
            h.update(extra)
        return h

    def _request(self, method: str, url: str, *, headers: Optional[dict] = None,
                 data: Optional[bytes] = None, retries: int = 3, timeout: int = 180):
        last_exc: Optional[Exception] = None
        for attempt in range(retries):
            try:
                resp = self.session.request(method, url, headers=self._headers(headers),
                                            data=data, timeout=timeout)
            except Exception as exc:
                last_exc = exc
                self.sleep(2 * (attempt + 1))
                continue
            if resp.status_code in (401, 403) and attempt + 1 < retries:
                self._bearer(f"repository:{self.repo}:pull,push", force=True)
                continue
            if resp.status_code in (429, 500, 502, 503, 504) and attempt + 1 < retries:
                self.sleep(3 * (attempt + 1))
                continue
            return resp
        raise PublishError(f"{method} {url.split('?')[0]} failed after {retries} attempts: {last_exc}")

    # -- registry ops ------------------------------------------------------
    def _v2(self, path: str) -> str:
        return f"https://{self.registry}/v2/{self.repo}/{path}"

    def has_blob(self, digest: str) -> bool:
        resp = self.session.head(self._v2(f"blobs/{digest}"), headers=self._headers(), timeout=60,
                                 allow_redirects=False)
        return resp.status_code == 200

    def push_blob(self, blob: oci.Blob) -> str:
        if self.has_blob(blob.digest):
            return "exists"
        start = self._request("POST", self._v2("blobs/uploads/"), data=b"")
        if start.status_code not in (202,):
            raise PublishError(f"blob upload start failed with HTTP {start.status_code}")
        location = start.headers.get("location") or start.headers.get("Location")
        if not location:
            raise PublishError("blob upload start returned no Location header")
        if location.startswith("/"):
            location = f"https://{self.registry}{location}"
        sep = "&" if "?" in location else "?"
        url = f"{location}{sep}digest={blob.digest}"
        resp = self._request("PUT", url, headers={"Content-Type": blob.media_type}, data=blob.data)
        if resp.status_code not in (201, 202):
            raise PublishError(f"blob PUT failed with HTTP {resp.status_code}")
        return "pushed"

    def get_manifest(self, reference: str, accept: str = oci.MANIFEST_MEDIA_TYPE) -> Optional[dict]:
        resp = self.session.get(self._v2(f"manifests/{reference}"),
                                headers=self._headers({"Accept": f"{accept}, application/vnd.docker.distribution.manifest.v2+json"}),
                                timeout=60)
        if resp.status_code == 404:
            return None
        if resp.status_code != 200:
            raise PublishError(f"manifest GET failed with HTTP {resp.status_code}")
        try:
            return resp.json()
        except Exception as exc:
            raise PublishError(f"manifest JSON parse failed: {exc}")

    def tag_exists(self, tag: str) -> bool:
        return self.get_manifest(tag) is not None

    def push_manifest(self, manifest_blob: oci.Blob, tag: str) -> None:
        resp = self._request("PUT", self._v2(f"manifests/{tag}"),
                             headers={"Content-Type": oci.MANIFEST_MEDIA_TYPE},
                             data=manifest_blob.data)
        if resp.status_code not in (201, 202):
            raise PublishError(f"manifest PUT failed with HTTP {resp.status_code}: {resp.text[:300]}")

    def list_tags(self, limit: int = 100) -> list[str]:
        tags: list[str] = []
        url = self._v2("tags/list") + f"?n={limit}"
        while url:
            resp = self._request("GET", url)
            if resp.status_code != 200:
                break
            body = resp.json()
            tags.extend(body.get("tags") or [])
            link = resp.headers.get("link") or resp.headers.get("Link") or ""
            url = ""
            if 'rel="next"' in link:
                url = link.split(";")[0].strip("<> ")
                if url.startswith("/"):
                    url = f"https://{self.registry}{url}"
        return tags


def _image_count(manifest: dict) -> int:
    ann = (manifest or {}).get("annotations") or {}
    try:
        return int(ann.get("shurik.post.images", "-1"))
    except Exception:
        return -1


def publish_post(post: dict, registry: Registry, *, force: bool = False) -> PushResult:
    """Idempotent per-post publish: never regress an already-published artifact."""
    config_blob, layers, tag, manifest, manifest_blob = oci.build_artifact(post)
    missing = len(post.get("missing_images") or [])
    result = PushResult(tag=tag, action="", layers=[], config_digest=config_blob.digest,
                        image_count=len([i for i in post.get("images", []) if i.get("sha256")]),
                        missing_count=missing)

    existing = None
    try:
        existing = registry.get_manifest(tag)
    except PublishError:
        existing = None
    if existing is not None and not force:
        prev_images = _image_count(existing)
        prev_ann = (existing.get("annotations") or {})
        prev_digest = "sha256:" + __import__("hashlib").sha256(
            json.dumps(existing.get("annotations", {}), sort_keys=True).encode()).hexdigest()
        if prev_images == result.image_count and prev_ann.get("shurik.post.cutoff") == config.CUTOFF:
            result.action = "skipped"
            result.manifest_digest = prev_digest
            result.reason = "already published with the same recovered image count"
            return result
        result.action = "updated"

    for blob in [config_blob] + list(layers):
        registry.push_blob(blob)
        result.layers.append(blob.digest)
    registry.push_manifest(manifest_blob, tag)
    result.manifest_digest = manifest_blob.digest
    if not result.action:
        result.action = "pushed"
    return result


def package_page_url(tag: str) -> str:
    return f"https://github.com/users/{os.environ.get('GHCR_USERNAME', '')}/packages/container/package/{config.GHCR_REPO}?tag_name={tag}"


def parse_digest_header(value: str) -> str:
    for part in (value or "").split(";"):
        part = part.strip()
        if part.startswith("docker-content-digest="):
            return part.split("=", 1)[1]
    return ""
