"""Shared offline fixtures: a fake archive with canned responses."""
from __future__ import annotations

import json
from typing import Optional

from recovery.http import BAD_BODY, GAP, HTTP_ERROR, OK, THROTTLED, TIMEOUT, Fetcher, Response

# Provenance for the Hebrew below: real capture
# https://web.archive.org/web/20150119072952id_/http://hazfalafel.com:80/post/100403945458
# Its <img> alt is stored in *logical* order, exactly as shown here. The archive
# never stores bidi-visual text, so the recovery must not "reorder" anything.
CAPTION_HEBREW = "האם ציפי ואיילת יבטלו את טיולי השבת?"


def entities(text: str) -> str:
    """Numeric character references, so fixtures exercise entity decoding."""
    return "".join(f"&#{ord(c)};" if ord(c) > 127 else c for c in text)


POST_HTML = """<!DOCTYPE html><html><head>
<meta property="og:image" content="http://40.media.tumblr.com/46281703ea29ab2c507f5bc4485c62ec/tumblr_ndozw9K7Dz1r3it8zo1_500.jpg" />
</head><body>
<div class="post">
<meta property="og:image" content="http://40.media.tumblr.com/46281703ea29ab2c507f5bc4485c62ec/tumblr_ndozw9K7Dz1r3it8zo1_500.jpg" />
<div class="media"><a href="http://hazfalafel.com/post/100403945458">
<img src="http://40.media.tumblr.com/46281703ea29ab2c507f5bc4485c62ec/tumblr_ndozw9K7Dz1r3it8zo1_500.jpg"
 alt="__CAPTION__" />
</a></div>
<div class="copy" style="direction:rtl;"><p>שלום עולם<br>שורה שנייה</p>
<p><a href="http://hazfalafel.com/tagged/%D7%A9%D7%9C%D7%95%D7%9D">שלום</a></p></div>
<a title="Posted on Tuesday the 19th of January 2015 at 7:29 AM" href="http://hazfalafel.com/post/100403945458">
<div class="footer for_permalink"><div class="date">Posted 11 years ago</div></div></a>
<div class="footer"><div class="tags">#<a href="http://hazfalafel.com/tagged/%D7%A9%D7%9C%D7%95%D7%9D">שלום</a>
<a href="http://hazfalafel.com/tagged/Philosoraptor">Philosoraptor</a></div></div>
</div>
<img src="http://assets.tumblr.com/images/default_avatar/octahedron_open_16.png" class="avatar" alt="" />
<img src="http://33.media.tumblr.com/avatar_dfb97ff13316_16.png" class="avatar " alt="" />
<img style="position:absolute" src="https://px.srvcs.tumblr.com/impixu?T=1&amp;J=abc" />
<img src="http://www.narendramodi.in/images/fb_share_button.jpg">
</body></html>""".replace("__CAPTION__", entities(CAPTION_HEBREW))

PHOTOSET_HTML = """<html><body><div class="photoset">
<img src="http://40.media.tumblr.com/ebf1e6a81c86cae8055a79a7c8d027d8/tumblr_ng1vkjYFIB1r3it8zo6_500.jpg" alt="" />
<img src="http://41.media.tumblr.com/6df4d47dc1427d05525406a180fbe525/tumblr_ng1vkjYFIB1r3it8zo1_500.jpg" alt="תמונה שנייה" />
</div></body></html>"""

NOT_ARCHIVED_HTML = """<html><head><title>Wayback Machine</title></head><body>
<div class="notfound">This page has not been archived.</div></body></html>"""

JPEG_BYTES = b"\xff\xd8\xff\xe0\x00\x10JFIF" + b"\x00" * 200
PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"\x00" * 100


def cdx_json(rows: list) -> bytes:
    return json.dumps(rows).encode("utf-8")


class FakeArchive(Fetcher):
    """Replays canned responses keyed by URL substring; records every request."""

    def __init__(self, routes: dict[str, Response], **kw):
        super().__init__(**kw)
        self.routes = routes
        self.requests: list[str] = []

    def _get(self, url: str, timeout: float) -> Response:
        self.requests.append(url)
        for needle, resp in self.routes.items():
            if needle in url:
                r = Response(url=url, status=resp.status, body=resp.body,
                             headers=dict(resp.headers), error=resp.error, message=resp.message)
                return r
        return Response(url=url, status=404, error=GAP, message="unrouted")


def html(body: str, status: int = 200) -> Response:
    return Response(url="", status=status, body=body.encode("utf-8"),
                    headers={"content-type": "text/html; charset=utf-8"}, error=OK)


def binary(data: bytes, ctype: str = "image/jpeg", status: int = 200) -> Response:
    return Response(url="", status=status, body=data, headers={"content-type": ctype}, error=OK)


class FakeRegistry:
    """In-memory OCI registry: records pushes, replays manifests, no network."""

    def __init__(self, blobs: dict[str, bytes] | None = None, manifests: dict | None = None):
        self.blobs: dict[str, bytes] = dict(blobs or {})
        self.manifests: dict = dict(manifests or {})
        self.pushes: list[tuple[str, str]] = []
        self.gets: list[str] = []

    # -- Registry API used by recovery.publish.publish_post ----------------
    def get_manifest(self, reference: str, accept: str | None = None):
        self.gets.append(reference)
        return self.manifests.get(reference)

    def has_blob(self, digest: str) -> bool:
        return digest in self.blobs

    def push_blob(self, blob) -> str:
        self.blobs[blob.digest] = blob.data
        return "pushed"

    def push_manifest(self, manifest_blob, tag: str) -> None:
        import json as _json

        doc = _json.loads(manifest_blob.data.decode("utf-8"))
        self.manifests[tag] = doc
        self.pushes.append((tag, manifest_blob.digest))


class FakeRegistrySession:
    """Canned GHCR HTTP session: token, upload start, blob PUT, manifest PUT.

    Reproduces the real registry's quirks that broke publishing:
    a 404 `BLOB_UPLOAD_INVALID: invalid content-type` for any upload whose
    Content-Type is not `application/octet-stream`, and a 401 that a fresh
    token has to fix.
    """

    def __init__(self, *, blob_status: int = 201, manifest_status: int = 201,
                 unauthorized_once: bool = False):
        self.calls: list[tuple[str, str, dict]] = []
        self.blob_status = blob_status
        self.manifest_status = manifest_status
        self.unauthorized_once = unauthorized_once
        self.blob_bodies: dict[str, bytes] = {}
        self.manifests: dict[str, bytes] = {}

    def get(self, url, headers=None, timeout=None):
        self.calls.append(("GET", url, dict(headers or {})))
        return _json_response({"token": "t0k3n"}, 200)

    def head(self, url, headers=None, timeout=None, allow_redirects=True):
        self.calls.append(("HEAD", url, dict(headers or {})))
        return _json_response({}, 404)

    def request(self, method, url, headers=None, data=None, timeout=None):
        headers = dict(headers or {})
        self.calls.append((method, url, headers))
        if method == "POST" and url.endswith("blobs/uploads/"):
            return _headers_response(
                {"location": "/v2/igor-makarov/shurik-hazfalafel-com/blobs/upload/9.abc"}, 202)
        if method == "PUT" and "/blobs/upload/" in url:
            if (headers.get("Content-Type") or "") != "application/octet-stream":
                return _json_response({"errors": [{"code": "BLOB_UPLOAD_INVALID",
                                                   "message": "invalid content-type"}]}, 404)
            if self.unauthorized_once:
                self.unauthorized_once = False
                return _json_response({"errors": [{"code": "UNAUTHORIZED"}]}, 401)
            self.blob_bodies[url.split("digest=")[-1]] = data or b""
            return _json_response({}, self.blob_status)
        if method == "PUT" and "/manifests/" in url:
            self.manifests[url.rsplit("/", 1)[-1]] = data or b""
            return _json_response({}, self.manifest_status)
        if method == "GET":
            return _json_response({"tags": ["1", "2"]}, 200)
        return _json_response({}, 404)


def _json_response(body: dict, status: int):
    import json as _json

    class R:
        status_code = status
        headers: dict = {}
        text = _json.dumps(body)

        def json(self):
            return body

    return R()


def _headers_response(headers: dict, status: int):
    import json as _json

    class R:
        status_code = status
        text = ""

        def json(self):
            return {}

    R.headers = {k.lower(): v for k, v in headers.items()}
    return R()
