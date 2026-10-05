"""HTTP access to the Internet Archive with retries, backoff and rate limiting.

Error classification is deliberate: the recovery ledger must be able to tell a
*confirmed archive gap* apart from a *timeout*, a *throttle* or a *transport*
failure, because only the former means "stop trying for now".
"""
from __future__ import annotations

import random
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Optional
from urllib.parse import quote

from . import config

try:  # requests is the fast path; urllib is the offline fallback.
    import requests  # type: ignore
except Exception:  # pragma: no cover - exercised only on bare runners
    requests = None  # type: ignore


# --- failure classes ---------------------------------------------------------
GAP = "archive_gap"            # archive says it has nothing (404 / "not archived")
TIMEOUT = "timeout"            # bounded long timeout hit
THROTTLED = "throttled"        # 429 / 503 / explicit rate-limit page
TRANSPORT = "transport"        # DNS/reset/other network failure
HTTP_ERROR = "http_error"      # other non-200 status
CUTOFF_VIOLATION = "cutoff_violation"  # capture newer than the cutoff
BAD_BODY = "bad_body"          # body is not the media type we asked for
# The capture exists but only *after* the cutoff. Distinct from GAP: the file
# is archived, we are simply not allowed to use that capture.
AFTER_CUTOFF_ONLY = "capture_after_cutoff"
OK = "ok"


class RecoveryError(Exception):
    """Raised for unrecoverable configuration problems (never for gaps)."""

    def __init__(self, message: str, kind: str = TRANSPORT, status: int | None = None):
        super().__init__(message)
        self.kind = kind
        self.status = status


@dataclass
class Response:
    url: str
    status: int | None
    body: bytes = b""
    headers: dict = field(default_factory=dict)
    error: Optional[str] = None      # one of OK, GAP, TIMEOUT, ...
    message: str = ""
    elapsed: float = 0.0
    attempts: int = 1

    @property
    def ok(self) -> bool:
        return self.error == OK

    def text(self, encoding: str = "utf-8") -> str:
        return self.body.decode(encoding, errors="replace")

    def json(self) -> Any:
        import json

        return json.loads(self.text())


class RateLimiter:
    """Simple global minimum spacing between outbound requests."""

    def __init__(self, interval: float = config.MIN_REQUEST_INTERVAL):
        self.interval = interval
        self._last = 0.0
        self._lock = threading.Lock()

    def wait(self) -> None:
        with self._lock:
            now = time.monotonic()
            delay = self.interval - (now - self._last)
            if delay > 0:
                time.sleep(delay)
            self._last = time.monotonic()


class Fetcher:
    """Bounded, retrying HTTP GET. Subclass for offline tests."""

    def __init__(
        self,
        timeout: float = config.DEFAULT_TIMEOUT,
        attempts: int = config.MAX_ATTEMPTS,
        limiter: Optional[RateLimiter] = None,
        sleep: Callable[[float], None] = time.sleep,
    ):
        self.timeout = timeout
        self.attempts = attempts
        self.limiter = limiter if limiter is not None else RateLimiter()
        self.sleep = sleep
        self.session = requests.Session() if requests is not None else None
        if self.session is not None:
            self.session.headers.update({"User-Agent": config.USER_AGENT})
        self.stats: dict[str, int] = {}

    # -- to be provided by tests ------------------------------------------
    def _raw(self, url: str, timeout: float) -> Response:  # pragma: no cover
        raise NotImplementedError

    def _get(self, url: str, timeout: float) -> Response:
        if self.session is not None:
            start = time.monotonic()
            try:
                r = self.session.get(url, timeout=timeout, allow_redirects=True)
                return Response(
                    url=str(r.url),
                    status=r.status_code,
                    body=r.content,
                    headers={k.lower(): v for k, v in r.headers.items()},
                    elapsed=time.monotonic() - start,
                )
            except Exception as exc:  # requests raises many concrete types
                name = type(exc).__name__.lower()
                kind = TIMEOUT if "timeout" in name else TRANSPORT
                return Response(url=url, status=None, error=kind, message=str(exc)[:300])
        return self._urllib_get(url, timeout)

    def _urllib_get(self, url: str, timeout: float) -> Response:  # pragma: no cover
        import urllib.error
        import urllib.request

        req = urllib.request.Request(url, headers={"User-Agent": config.USER_AGENT})
        start = time.monotonic()
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                body = resp.read()
                return Response(
                    url=resp.geturl(),
                    status=resp.status,
                    body=body,
                    headers={k.lower(): v for k, v in resp.headers.items()},
                    elapsed=time.monotonic() - start,
                )
        except urllib.error.HTTPError as exc:
            body = b""
            try:
                body = exc.read()
            except Exception:
                pass
            return Response(url=url, status=exc.code, body=body, elapsed=time.monotonic() - start)
        except Exception as exc:
            name = type(exc).__name__.lower()
            kind = TIMEOUT if "timeout" in name else TRANSPORT
            return Response(url=url, status=None, error=kind, message=str(exc)[:300])

    # -- retry / classify --------------------------------------------------
    @staticmethod
    def classify(resp: Response) -> Response:
        if resp.error is not None and resp.error != OK:
            return resp
        status = resp.status or 0
        if status == 200:
            resp.error = OK
        elif status in (404, 410):
            resp.error = GAP
            resp.message = resp.message or f"HTTP {status}"
        elif status in (429, 503):
            resp.error = THROTTLED
            resp.message = resp.message or f"HTTP {status}"
        else:
            resp.error = HTTP_ERROR
            resp.message = resp.message or f"HTTP {status}"
        return resp

    def get(
        self,
        url: str,
        *,
        timeout: Optional[float] = None,
        attempts: Optional[int] = None,
        idempotent: bool = True,
    ) -> Response:
        timeout = self.timeout if timeout is None else timeout
        attempts = self.attempts if attempts is None else attempts
        last: Optional[Response] = None
        for attempt in range(1, max(1, attempts) + 1):
            self.limiter.wait()
            resp = self.classify(self._get(url, timeout))
            resp.attempts = attempt
            last = resp
            if resp.ok:
                break
            if not idempotent:
                break
            # Retry only transient classes; a gap or a cutoff violation is final.
            if resp.error in (GAP, CUTOFF_VIOLATION, BAD_BODY, HTTP_ERROR):
                break
            if attempt >= max(1, attempts):
                break
            delay = min(45.0, (2 ** (attempt - 1)) * 3.0) * (0.6 + random.random() * 0.8)
            self.sleep(delay)
        if last is not None:
            self.stats[last.error or "unknown"] = self.stats.get(last.error or "unknown", 0) + 1
        return last  # type: ignore[return-value]

    # -- Wayback-specific --------------------------------------------------
    @staticmethod
    def replay_url(timestamp: str, original: str, mode: str = "id_") -> str:
        """Wayback replay URL. `mode` id_=raw bytes, if_=iframe, ""=toolbar page."""
        if timestamp > config.CUTOFF:
            raise RecoveryError(
                f"capture {timestamp} is newer than cutoff {config.CUTOFF}",
                kind=CUTOFF_VIOLATION,
            )
        return f"{config.REPLAY_BASE}/{timestamp}{mode}/{original}"

    def replay(self, timestamp: str, original: str, mode: str = "id_", **kw) -> Response:
        try:
            url = self.replay_url(timestamp, original, mode)
        except RecoveryError as exc:
            return Response(url=original, status=None, error=exc.kind, message=str(exc))
        resp = self.get(url, **kw)
        resp.url = url
        resp.message = resp.message or ""
        # `id_` replays of missing captures answer with a 200 HTML error page.
        if resp.ok and resp.headers.get("content-type", "").startswith("text/html") and mode == "id_":
            body = resp.text()[:4000]
            if "has not been archived" in body or "does not have a page" in body or "not found" in body.lower()[:400]:
                resp.error = GAP
                resp.message = "replay returned 'not archived' HTML"
        return resp

    def probe_replay(self, url: str, at_ts: Optional[str] = None, mode: str = "im_",
                     timeout: Optional[float] = None) -> Response:
        """Non-following GET of a replay URL: does this exact URL have a capture?

        One bounded request answers "is this URL archived, and when?" for a
        single media file, which is far cheaper than a CDX query (the archive
        serves this from its redirect index in ~1 s, the CDX endpoint is far
        slower). The 302 `Location` carries the *actual* capture timestamp, so
        the caller can enforce the cutoff before any bytes are transferred.

        Redirects are deliberately not followed here: following would hand us
        post-cutoff bytes before we had a chance to check the timestamp.
        """
        at_ts = at_ts or config.CUTOFF
        target = f"{config.REPLAY_BASE}/{at_ts}{mode}/{url}"
        self.limiter.wait()
        resp = self._get_noredirect(target, self.timeout if timeout is None else timeout)
        resp.url = target
        resp.error = self.classify_probe(resp)
        return resp

    def _get_noredirect(self, url: str, timeout: float) -> Response:
        if self.session is not None:
            start = time.monotonic()
            try:
                r = self.session.get(url, timeout=timeout, allow_redirects=False, stream=True)
                body = b""
                try:
                    body = r.raw.read(2048, decode_content=False)
                except Exception:
                    body = b""
                finally:
                    r.close()
                return Response(url=str(r.url), status=r.status_code, body=body,
                                headers={k.lower(): v for k, v in r.headers.items()},
                                elapsed=time.monotonic() - start)
            except Exception as exc:  # requests raises many concrete types
                name = type(exc).__name__.lower()
                kind = TIMEOUT if "timeout" in name else TRANSPORT
                return Response(url=url, status=None, error=kind, message=str(exc)[:300])
        return self._urllib_get_noredirect(url, timeout)

    def _urllib_get_noredirect(self, url: str, timeout: float) -> Response:  # pragma: no cover
        import urllib.error
        import urllib.request

        class _NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *_a, **_k):
                return None

        opener = urllib.request.build_opener(_NoRedirect)
        req = urllib.request.Request(url, headers={"User-Agent": config.USER_AGENT})
        start = time.monotonic()
        try:
            with opener.open(req, timeout=timeout) as resp:
                return Response(url=resp.geturl(), status=resp.status, body=resp.read(2048),
                                headers={k.lower(): v for k, v in resp.headers.items()},
                                elapsed=time.monotonic() - start)
        except urllib.error.HTTPError as exc:
            body = b""
            try:
                body = exc.read(2048)
            except Exception:
                pass
            return Response(url=url, status=exc.code, body=body,
                            headers={k.lower(): v for k, v in (exc.headers or {}).items()},
                            elapsed=time.monotonic() - start)
        except Exception as exc:
            name = type(exc).__name__.lower()
            kind = TIMEOUT if "timeout" in name else TRANSPORT
            return Response(url=url, status=None, error=kind, message=str(exc)[:300])

    @staticmethod
    def classify_probe(resp: Response) -> str:
        """3xx-with-Location means "captured"; the timestamp lives in Location."""
        if resp.error not in (None, "", OK):
            return resp.error
        status = resp.status or 0
        if 300 <= status < 400 and resp.headers.get("location"):
            return OK
        return Fetcher.classify(resp).error or HTTP_ERROR

    def cdx(self, params: dict, **kw) -> Response:
        from urllib.parse import urlencode

        query = dict(params)
        query.setdefault("output", "json")
        return self.get(f"{config.CDX_URL}?{urlencode(query, safe=':*/,')}", **kw)
