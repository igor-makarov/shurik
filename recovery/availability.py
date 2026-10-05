"""Cheap existence oracle: the Availability JSON API on archive.org.

Why this exists
---------------
Two archive endpoints answer "do you hold this URL, and when?":

* ``web.archive.org/web/<ts>im_/<url>`` -- the replay probe, which redirects to
  the capture timestamp.  Cheap per request, but it lives on ``web.archive.org``
  and that host answers a burst of concurrent probes with ``Connection refused``
  for minutes at a time.  Bounded to two or three workers, 2200 unresolved post
  images is a multi-hour sweep that repeatedly dies half way.
* ``archive.org/wayback/available`` -- the Availability API.  It is a different
  host, reads the same capture index, and answered 40 queries in 14 s at five
  workers while the replay probe was already refusing connections.

So the availability answer is used as the *inventory*: a resumable, Git-committed
sweep that says, per media URL, whether a pre-cutoff capture exists and at what
timestamp.  Only URLs with a confirmed capture are then replayed from
``web.archive.org``, which turns the expensive host into a short download list
instead of a 2200-request probe storm.

The verdicts are deliberately distinct, because "the archive never had it" and
"the archive had it but the request failed" must never be confused:

``hit``             a capture exists at or before the cutoff -> replay it
``after_cutoff``    the nearest capture is newer than the cutoff -> unusable
``gap``             the archive answered 200 with no snapshot at all
``transient``       timeout / throttle / transport failure -> try again later
"""
from __future__ import annotations

import json
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Callable, Iterable, Optional

from . import config
from .cdx import Capture, normalize_url, within_cutoff
from .http import (HTTP_ERROR, OK, THROTTLED, TIMEOUT, TRANSPORT, Fetcher, Response)

AVAIL_URL = os.environ.get("SHURIK_AVAIL_URL", "https://archive.org/wayback/available")

# Verdict vocabulary. Distinct from http.GAP ("archive_gap") so a stored sweep
# row can never be confused with the failure class of a replay request.
HIT = "hit"
AFTER_CUTOFF = "after_cutoff"
TRANSIENT = "transient"
NO_SNAPSHOT = "gap"

# Verdict for a URL whose nearest capture is newer than the cutoff. Distinct
# from GAP: the file *is* archived, we are simply not allowed to use it.
VERDICT_AFTER_CUTOFF = "capture_after_cutoff"


def _now() -> str:
    import datetime

    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


class AvailabilityIndex:
    """Durable per-URL availability verdicts (committed, resumable, monotonic).

    Rows are keyed by the normalised media URL.  A `hit` is never downgraded to
    a `gap` by a later sweep: a rerun that cannot reach the archive keeps the
    previous verdict instead of replacing good evidence with silence.
    """

    # The verdict vocabulary is also reachable from the class, because the
    # resolution code reads it off the index it was handed (`index.HIT`,
    # `index.AFTER_CUTOFF`, `index.NO_SNAPSHOT`). It used to exist only as a
    # module constant, so every such reference raised AttributeError and
    # aborted the whole `fetch-images` pass instead of resolving one image.
    HIT = HIT
    NO_SNAPSHOT = NO_SNAPSHOT
    AFTER_CUTOFF = AFTER_CUTOFF
    TRANSIENT = TRANSIENT
    VERDICT_AFTER_CUTOFF = VERDICT_AFTER_CUTOFF

    def __init__(self, path: Optional[str] = None):
        self.path = path or os.path.join(config.CDX_DIR, "avail.jsonl")
        self.manifest_path = self.path + ".manifest.json"
        self._lock = threading.Lock()
        self.rows: dict[str, dict] = {}
        self.manifest: dict = {"done": {}, "sweeps": []}
        self._load()

    # -- persistence -------------------------------------------------------
    def _load(self) -> None:
        if os.path.exists(self.path):
            with open(self.path, "r", encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        row = json.loads(line)
                    except ValueError:
                        continue
                    url = normalize_url(row.get("url", ""))
                    if url:
                        self.rows[url] = row
        if os.path.exists(self.manifest_path):
            try:
                with open(self.manifest_path, "r", encoding="utf-8") as fh:
                    self.manifest = json.load(fh)
            except ValueError:
                self.manifest = {"done": {}, "sweeps": []}
        self.manifest.setdefault("done", {})
        self.manifest.setdefault("sweeps", [])

    def flush(self) -> None:
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        tmp = self.path + ".tmp"
        with self._lock:
            rows = sorted(self.rows.values(), key=lambda r: r.get("url", ""))
            payload = "".join(
                json.dumps(r, ensure_ascii=False, sort_keys=True) + "\n" for r in rows
            )
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(payload)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, self.path)
        mtmp = self.manifest_path + ".tmp"
        with open(mtmp, "w", encoding="utf-8") as fh:
            json.dump(self.manifest, fh, ensure_ascii=False, indent=1, sort_keys=True)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(mtmp, self.manifest_path)

    # -- queries -----------------------------------------------------------
    def verdict(self, url: str) -> Optional[str]:
        row = self.rows.get(normalize_url(url))
        return row.get("verdict") if row else None

    def capture_for(self, url: str) -> Optional[Capture]:
        """A pre-cutoff capture for this URL or any size/extension sibling."""
        from .images import _variants

        for variant in _variants(url):
            row = self.rows.get(normalize_url(variant))
            if row and row.get("verdict") == HIT and within_cutoff(row.get("timestamp", "")):
                return Capture(
                    timestamp=row["timestamp"],
                    original=variant,
                    statuscode="200",
                    mimetype=row.get("mimetype", ""),
                    urlkey="",
                    digest=row.get("digest", ""),
                    length=str(row.get("length") or 0),
                    redirect="",
                    source_query="availability-api",
                )
        return None

    def hits(self) -> list[dict]:
        return [r for r in self.rows.values() if r.get("verdict") == HIT]

    def record(self, url: str, verdict: str, **extra) -> dict:
        """Store a verdict. Monotonic: a transient answer never erases evidence."""
        key = normalize_url(url)
        row = {
            "url": key,
            "original": url,
            "verdict": verdict,
            "checked_at": _now(),
        }
        row.update({k: v for k, v in extra.items() if v not in (None, "")})
        with self._lock:
            old = self.rows.get(key)
            if old is None:
                self.rows[key] = row
                return row
            # A decided verdict is never erased by a later, weaker answer: a
            # rerun that cannot reach the archive must not replace good
            # evidence with silence. The failure is recorded alongside it.
            if old.get("verdict") != TRANSIENT and verdict == TRANSIENT:
                old["last_error"] = row.get("error", TRANSIENT)
                old["last_checked_at"] = row["checked_at"]
                return old
            for field in ("mimetype", "digest", "length", "status", "timestamp",
                          "replay_url", "note", "error", "message", "http_status",
                          "query_ts"):
                if row.get(field) not in (None, ""):
                    old[field] = row[field]
            old["verdict"] = verdict
            old["checked_at"] = row["checked_at"]
            old.pop("last_error", None)
            old.pop("last_checked_at", None)
            return old

    def keys_checked(self) -> int:
        return len(self.rows)


def availability_query(url: str, timestamp: str = config.CUTOFF) -> str:
    from urllib.parse import quote

    return f"{AVAIL_URL}?url={quote(url, safe='')}&timestamp={timestamp}"


def probe_availability(fetcher: Fetcher, url: str,
                       timestamp: str = config.CUTOFF) -> tuple[str, dict]:
    """Ask the Availability API about one URL.

    Returns ``(verdict, row)`` where verdict is one of `hit`, `after_cutoff`,
    `gap` or `transient`.  The requested timestamp is the inclusive cutoff so
    the "closest" snapshot the API returns is the newest one at or before it
    whenever such a capture exists; a snapshot that still comes back newer than
    the cutoff is reported separately and never downloaded.

    The timestamp must be the full 14-digit form.  The API answers
    ``timestamp=20191231`` with an *empty* ``archived_snapshots`` object for
    URLs it does hold -- verified against post 15577014830's image, whose
    20130930175155 capture comes back for ``20191231235959`` and for ``2019``
    but never for the short ``20191231``.  Sweeping with the short form wrote
    hundreds of false `gap` verdicts into the committed index, so the queried
    timestamp is stored on every row and stale rows can be re-probed.
    """
    target = availability_query(url, timestamp)
    resp: Response = fetcher.get(target)
    row: dict = {"url": normalize_url(url), "original": url,
                 "http_status": resp.status, "query_ts": timestamp}
    if resp.error in (TIMEOUT, THROTTLED, TRANSPORT, HTTP_ERROR) or resp.status != 200:
        row["verdict"] = TRANSIENT
        row["error"] = resp.error or "http_error"
        row["message"] = (resp.message or "")[:200]
        return TRANSIENT, row
    try:
        payload = json.loads(resp.text())
    except ValueError:
        row["verdict"] = TRANSIENT
        row["error"] = "bad_json"
        row["message"] = resp.text()[:200]
        return TRANSIENT, row
    snapshots = (payload or {}).get("archived_snapshots") or {}
    closest = snapshots.get("closest") or {}
    ts = str(closest.get("timestamp") or "")
    if not ts:
        row["verdict"] = NO_SNAPSHOT
        row["note"] = "availability API answered 200 with no snapshot"
        return NO_SNAPSHOT, row
    if not within_cutoff(ts):
        row["verdict"] = AFTER_CUTOFF
        row["timestamp"] = ts
        row["note"] = "nearest capture is newer than the cutoff; not usable"
        return AFTER_CUTOFF, row
    row.update({
        "verdict": HIT,
        "timestamp": ts,
        "status": str(closest.get("status") or ""),
        "replay_url": closest.get("url", ""),
        "length": closest.get("length"),
    })
    return HIT, row


def sweep(fetcher: Fetcher, urls: Iterable[str], *, limit: int = 0,
          concurrency: int = 3, flush_every: int = 25,
          index: Optional[AvailabilityIndex] = None,
          retry_transient: bool = False, retry_gap: bool = False,
          progress: Optional[Callable[[dict], None]] = None) -> dict:
    """Probe every URL that has no final verdict yet, with bounded concurrency.

    Results are flushed to Git every `flush_every` rows and once at the end, so
    killing the sweep at any moment keeps everything already decided.
    """
    index = index or AvailabilityIndex()
    todo: list[str] = []
    seen: set[str] = set()
    for url in urls:
        key = normalize_url(url)
        if not key or key in seen:
            continue
        seen.add(key)
        prior = index.rows.get(key)
        if prior and not (retry_transient or retry_gap):
            verdict = prior.get("verdict")
            if verdict in (HIT, AFTER_CUTOFF, NO_SNAPSHOT):
                continue
        if prior and retry_gap:
            # Re-probe a stored "no snapshot" only when it was decided by the
            # 8-digit cutoff form (or by no recorded form at all): those
            # answers are demonstrably empty regardless of the index.
            if prior.get("verdict") != NO_SNAPSHOT:
                continue
            if prior.get("query_ts") == config.CUTOFF:
                continue
        todo.append(url)
    if limit:
        todo = todo[:limit]
    counts = {HIT: 0, NO_SNAPSHOT: 0, AFTER_CUTOFF: 0, TRANSIENT: 0}
    started = _now()
    lock = threading.Lock()

    def work(url: str) -> tuple[str, dict]:
        return probe_availability(fetcher, url)

    done = 0
    if todo:
        with ThreadPoolExecutor(max_workers=max(1, concurrency)) as pool:
            for verdict, row in pool.map(work, todo):
                index.record(url=row["original"], verdict=verdict, **{k: v for k, v in row.items()
                                                                     if k not in ("url", "original",
                                                                                   "verdict")})
                with lock:
                    counts[verdict] = counts.get(verdict, 0) + 1
                    done += 1
                    if done % flush_every == 0:
                        index.flush()
                        if progress:
                            progress(dict(counts, done=done, total=len(todo)))
    index.flush()
    index.manifest["sweeps"].append({
        "at": started,
        "finished_at": _now(),
        "requested": len(todo),
        "counts": counts,
        "concurrency": concurrency,
    })
    index.manifest["sweeps"] = index.manifest["sweeps"][-50:]
    index.flush()
    return {"queried": len(todo), "known": index.keys_checked(), **counts}