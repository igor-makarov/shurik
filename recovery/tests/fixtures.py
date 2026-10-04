"""Shared offline fixtures: a fake archive with canned responses."""
from __future__ import annotations

import json
from typing import Optional

from recovery.http import BAD_BODY, GAP, HTTP_ERROR, OK, THROTTLED, TIMEOUT, Fetcher, Response

POST_HTML = """<!DOCTYPE html><html><head>
<meta property="og:image" content="http://40.media.tumblr.com/46281703ea29ab2c507f5bc4485c62ec/tumblr_ndozw9K7Dz1r3it8zo1_500.jpg" />
</head><body>
<div class="post">
<meta property="og:image" content="http://40.media.tumblr.com/46281703ea29ab2c507f5bc4485c62ec/tumblr_ndozw9K7Dz1r3it8zo1_500.jpg" />
<div class="media"><a href="http://hazfalafel.com/post/100403945458">
<img src="http://40.media.tumblr.com/46281703ea29ab2c507f5bc4485c62ec/tumblr_ndozw9K7Dz1r3it8zo1_500.jpg"
 alt="&#1502;&#1500;&#1499;&#1496; &#1510;&#1494;&#1508;&#1499; &#1510;&#1489;&#1491;&#1501;&#1493;&#1500;?" />
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
</body></html>"""

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
