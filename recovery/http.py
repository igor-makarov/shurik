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
THROTTLED = "throttled"        # genuine 429 / 503 / explicit rate-limit page only
TRANSPORT = "transport"        # no HTTP answer: refusal, DNS/reset/TLS/other network failure
# A refused TCP connection (status None, errno 111 / "connection refused") is
# TRANSPORT, not throttling: only a 429/503/Retry-After from a reachable front
# end proves a rate limit. Refusals stay retryable transient evidence with
# their own back-off and must never be recorded as throttle or gap evidence.
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
    # Number of *raw* data rows a CDX response carried, before cutoff/malformed
    # filtering. Paging needs this: a page whose rows were all filtered out still
    # proves the archive had more results, so `len(filtered_rows) < limit` is not
    # a valid "last page" signal.
    cdx_rows: int = 0

    @property
    def ok(self) -> bool:
        return self.error == OK

    def text(self, encoding: str = "utf-8") -> str:
        return self.body.decode(encoding, errors="replace")

    def json(self) -> Any:
        import json

        return json.loads(self.text())


# web.archive.org answers plain HTTP 200 for the very same captures that its
# HTTPS listener refuses at the TCP level. A runner whose only route to the
# archive is port 80 therefore recovers nothing -- every URL looks "throttled"
# and the queue cools down. One downgrade attempt per request turns that
# transport fact into real bytes instead of a back-off, without adding load:
# the HTTPS request was refused by the kernel, so it never reached a Wayback
# front end.
PLAIN_HTTP_HOSTS = ("https://web.archive.org/", "https://archive.org/")
SECURE_HTTP_HOSTS = ("http://web.archive.org/", "http://archive.org/")


def plain_http_variant(url: str) -> Optional[str]:
    """Same resource over plain HTTP, or None when no downgrade applies."""
    for host in PLAIN_HTTP_HOSTS:
        if url.startswith(host):
            return "http://" + url[len("https://"):]
    return None


def secure_http_variant(url: str) -> Optional[str]:
    """Same resource over HTTPS, or None when no upgrade applies.

    The downgrade above was added for a runner where only port 80 worked. The
    mirror image happens too and is just as fatal if ignored: on 2026-10-05
    plain-HTTP replays of a known-good capture hung until the request timed out
    (curl exit 28 / 000) while HTTPS answered the very same capture in 0.3 s.
    Whichever listener is reachable changes per runner and per minute, so both
    directions are tried once, and only when the first request got no HTTP
    answer at all (a real 429/503 is throttling and is never replayed).
    """
    for host in SECURE_HTTP_HOSTS:
        if url.startswith(host):
            return "https://" + url[len("http://"):]
    return None


def scheme_variant(url: str) -> Optional[str]:
    """The same archive resource on the other scheme, or None."""
    return plain_http_variant(url) or secure_http_variant(url)


def connection_refused(exc: BaseException) -> bool:
    """True when the failure was a refused TCP connection (any link of a chain).

    requests wraps a socket error twice (`ConnectionError` -> `MaxRetryError` ->
    `NewConnectionError` -> `ConnectionRefusedError`), so the whole chain is
    inspected. Only a *refusal* counts: DNS failures, resets and TLS errors are
    plain transport faults and stay retryable.
    """
    seen = 0
    cur: Optional[BaseException] = exc
    while cur is not None and seen < 6:
        seen += 1
        if isinstance(cur, ConnectionRefusedError):
            return True
        text = str(cur).lower()
        if "errno 111" in text or "connection refused" in text:
            return True
        cur = cur.__cause__ or cur.__context__
    return False


def short_message(message: str, limit: int = 200) -> str:
    """Ledger-safe truncation that preserves the diagnostic tail.

    Raw transport messages are `pool-prefix + long replay URL + cause`: the
    refusal/errno evidence (`Connection refused`, `errno 111`) lives in the
    tail, past position 250 for long media URLs. A plain `[:200]` head cut
    keeps the URL and loses the cause, so a later reader sees `status null`
    with no refusal text and misdiagnoses a refusal as an ambiguous stall.
    Keep head+tail when long so the cause always survives.
    """
    if not message or len(message) <= limit:
        return message or ""
    head = limit * 2 // 3
    tail = limit - head - 5
    return f"{message[:head]}...{message[-tail:]}" if tail > 0 else message[:limit]


def classify_exception(exc: BaseException) -> tuple[str, str]:
    """Map a requests/urllib exception to (error class, message)."""
    name = type(exc).__name__.lower()
    if connection_refused(exc):
        # No HTTP answer arrived, so this cannot prove a rate limit (see
        # failure-class note above). TRANSPORT keeps it retryable and distinct
        # from a genuine 429/503 throttle. The raw text is pool-prefix +
        # long replay URL + cause, with the refusal evidence (errno 111 /
        # "Connection refused") in the tail past position 250 for long
        # media URLs: a plain [:200] head cut keeps the URL and loses the
        # cause, so preserve head+tail (same rule as short_message) rather
        # than truncating the head only.
        raw = str(exc)
        kept = short_message(raw, 200) if len(raw) > 200 else raw
        return TRANSPORT, f"connection refused (transport, no HTTP answer): {kept}"
    if "timeout" in name:
        return TIMEOUT, short_message(str(exc), 300) if len(str(exc)) > 300 else str(exc)[:300]
    raw = str(exc)
    return TRANSPORT, short_message(raw, 300) if len(raw) > 300 else raw[:300]


def is_refusal(resp: "Response") -> bool:
    """True when a TRANSPORT response was a refused TCP connection.

    Used to give refusals their own in-process policy: like a throttle they
    are not retried in-process (the durable queue owns the back-off), while
    other transports (DNS, reset, TLS) keep bounded retries. The check is on
    the recorded message so mocked transports in tests behave the same way.
    The legacy `archive refused the connection` prefix (pre-12-245 rows wrote
    refusals as THROTTLED with that text and status None) is recognised too,
    so stale ledger rows are diagnosed as refusals rather than ambiguous
    throttles when re-examined.
    """
    text = (resp.message or "").lower()
    return (
        resp.status is None
        and (resp.error in (TRANSPORT, THROTTLED))
        and ("refused" in text
            or "errno 111" in text
            or "archive refused" in text)
    )


# A run that keeps hammering a refusing archive makes the refusal last longer,
# so the fetcher opens a circuit: after this many consecutive no-answer results
# (genuine throttles and transport/timeout refusals alike) it stops sending
# requests for a while and says so, instead of burning the runner's reputation
# and writing another hundred identical rows. The per-request ledger still
# records TRANSPORT vs THROTTLED honestly; the breaker only stops the load.
BREAKER_THRESHOLD = 3
BREAKER_BASE_SECONDS = 120.0
BREAKER_MAX_SECONDS = 1800.0


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
        # circuit breaker state: consecutive no-answer results (THROTTLED from
        # a real 429/503, TRANSPORT/TIMEOUT with no HTTP answer). Any answered
        # HTTP status (200/404/...) proves the archive is reachable and resets
        # the streak. `_block_cause` keeps the honest label for the deferral.
        self._lock = threading.Lock()
        self._throttled_streak = 0
        self._transport_streak = 0
        self._no_answer_streak = 0
        self._block_cause = ""
        self._blocked_until = 0.0
        self._breaker_trips = 0

    # -- circuit breaker ---------------------------------------------------
    @property
    def blocked(self) -> bool:
        return time.monotonic() < self._blocked_until

    def breaker_note(self) -> str:
        if not self.blocked:
            return ""
        return (f"circuit breaker open for {max(0, self._blocked_until - time.monotonic()):.0f}s "
                f"after {self._no_answer_streak} consecutive no-answer results "
                f"({self._block_cause or 'throttled/transport'}; trip {self._breaker_trips}); "
                f"no request was sent")

    def _blocked_response(self, url: str, trial: bool = False) -> Optional[Response]:
        """Refuse a request while the circuit is open -- unless it is a trial.

        Normal traffic is never sent while the breaker is open. A *liveness
        probe* is the single exception: the durable queue's cooldown is a
        deadline, and the archive routinely recovers long before it expires.
        Without one trial request the CLI health check could never tell "still
        unreachable" from "back in business", and every later iteration would be
        spent waiting out a block that had already ended. `trial=True` sends
        exactly one request; a good answer closes the circuit in `_note_outcome`.

        The deferral keeps the cause's label (THROTTLED for a real 429/503
        block, TRANSPORT/TIMEOUT for a no-answer block) and always notes that
        no request was sent, so attempt logs never mistake it for a remote answer.
        """
        if not self.blocked or trial:
            return None
        cause = self._block_cause or THROTTLED
        return Response(url=url, status=None, error=cause, message=self.breaker_note())

    def _note_outcome(self, resp: Response) -> None:
        with self._lock:
            if resp.error == THROTTLED or is_refusal(resp):
                # Only a genuine throttle (429/503) or a refused connection
                # (TRANSPORT with status None and a refusal message) trips the
                # breaker. Timeouts and other transports (DNS/reset/TLS) are
                # inconclusive singletons: they stay retryable via the bounded
                # get() retries and the durable queue cooldown, but must not
                # block the CDX fallback that `method=auto` needs after a
                # timed-out probe.
                self._throttled_streak += 1 if resp.error == THROTTLED else 0
                self._transport_streak += 1 if resp.error != THROTTLED else 0
                self._no_answer_streak += 1
                self._block_cause = resp.error
                if self._no_answer_streak >= BREAKER_THRESHOLD:
                    self._breaker_trips += 1
                    span = min(BREAKER_MAX_SECONDS,
                               BREAKER_BASE_SECONDS * (2 ** (self._breaker_trips - 1)))
                    self._blocked_until = time.monotonic() + span
            elif resp.ok or resp.status is not None:
                # Any answered HTTP status proves reachability: reset both
                # streaks and close the circuit.
                self._throttled_streak = 0
                self._transport_streak = 0
                self._no_answer_streak = 0
                self._block_cause = ""
                self._blocked_until = 0.0
                self._breaker_trips = 0

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
                kind, message = classify_exception(exc)
                return Response(url=url, status=None, error=kind, message=message)
        return self._urllib_get(url, timeout)

    def _retry_plain(self, url: str, raw: Response, timeout: float,
                     *, noredirect: bool = False) -> Response:
        """One retry on the other scheme when the first request never got an answer.

        Only a request that got *no HTTP answer* from a non-throttle cause is
        retried: a 429/503 from a reachable front end is real throttling and
        must back off rather than be replayed on another port (the `status is
        not None` guard already returns genuine throttles, and THROTTLED with
        status None -- a circuit deferral, never a live answer -- is excluded
        here too). The switch happens before the response is classified, so a
        refusal that the other listener then answers never trips the circuit
        breaker -- the evidence is the answer, not the refusal. Both
        directions are covered (see `scheme_variant`).
        """
        if raw.status is not None or raw.error not in (None, OK, TRANSPORT, TIMEOUT):
            return raw
        alt = scheme_variant(url)
        if alt is None:
            return raw
        self.stats["scheme_fallback"] = self.stats.get("scheme_fallback", 0) + 1
        fallback = self._get_noredirect(alt, timeout) if noredirect else self._get(alt, timeout)
        fallback.attempts = raw.attempts + fallback.attempts
        if fallback.ok and raw.message:
            fallback.message = f"{fallback.message} (plain HTTP after: {raw.message[:120]})"
        return fallback

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
            kind, message = classify_exception(exc)
            return Response(url=url, status=None, error=kind, message=message)

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
        trial: bool = False,
    ) -> Response:
        timeout = self.timeout if timeout is None else timeout
        attempts = self.attempts if attempts is None else attempts
        blocked = self._blocked_response(url, trial=trial)
        if blocked is not None:
            self.stats[blocked.error or THROTTLED] = self.stats.get(blocked.error or THROTTLED, 0) + 1
            return blocked
        last: Optional[Response] = None
        for attempt in range(1, max(1, attempts) + 1):
            self.limiter.wait()
            resp = self.classify(self._retry_plain(url, self._get(url, timeout), timeout))
            resp.attempts = attempt
            last = resp
            self._note_outcome(resp)
            if resp.ok:
                break
            if not idempotent:
                break
            # Retry only transient classes; a gap or a cutoff violation is final.
            if resp.error in (GAP, CUTOFF_VIOLATION, BAD_BODY, HTTP_ERROR):
                break
            # A genuine throttle (429/503) or a refused connection is not
            # retried in-process: the durable queue owns the back-off, and a
            # retry during a block only extends it. One request per call (plus
            # the single scheme fallback already attempted), then the cooldown.
            # Other transports (DNS, reset, TLS) keep bounded retries here.
            if resp.error == THROTTLED or is_refusal(resp):
                break
            if self.blocked:
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
                     timeout: Optional[float] = None, trial: bool = False) -> Response:
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
        blocked = self._blocked_response(target, trial=trial)
        if blocked is not None:
            self.stats[blocked.error or THROTTLED] = self.stats.get(blocked.error or THROTTLED, 0) + 1
            return blocked
        self.limiter.wait()
        wait = self.timeout if timeout is None else timeout
        resp = self._retry_plain(target, self._get_noredirect(target, wait), wait,
                                 noredirect=True)
        resp.url = target
        resp.error = self.classify_probe(resp)
        self._note_outcome(resp)
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
                kind, message = classify_exception(exc)
                return Response(url=url, status=None, error=kind, message=message)
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
            kind, message = classify_exception(exc)
            return Response(url=url, status=None, error=kind, message=message)

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
