"""Durable, fair queue for image-recovery work.

The previous `fetch_images` picked the first N posts by sort order and then
discovered, inside the worker, that most of them had nothing left to ask the
archive: the batch was spent re-deciding settled images while 1186 posts were
never touched at all. The two rules this module exists to enforce:

1. eligibility is decided *before* the batch limit, from the record's own
   evidence, so a batch of N posts contains N posts with real work;
2. work rotates. Every post keeps an attempt count, the URL variants already
   tried, and a `next_at` cooldown, and the queue is ordered by fewest attempts
   first -- so an outage or a wall of terminal gaps can never starve the posts
   that have never been asked.

The state lives in `data/image-queue.json`: a compact, Git-committed cursor, so a
fresh process -- and a fresh runner that restored the registry checkpoint --
resumes exactly where the previous one stopped.
"""
from __future__ import annotations

import calendar
import json
import os
import time
from typing import Callable, Iterable, Optional

from . import config
from .http import AFTER_CUTOFF_ONLY, BAD_BODY, GAP, OK

QUEUE_VERSION = 3
DEFAULT_COOLDOWN_MINUTES = 45
DEFAULT_MAX_ATTEMPTS = 12

# Canonical outcome tokens. The HTTP layer names an empty capture `archive_gap`
# and a too-late-only capture `capture_after_cutoff`; the queue normalises both
# to short tokens so a verdict read from a post record and one read from the
# queue file compare equal. The legacy spellings stay in the terminal set so
# queue files written by an earlier version keep their meaning.
GAP_TOKEN = "gap"
BAD_BODY_TOKEN = "bad_body"
AFTER_CUTOFF_TOKEN = "capture_after_cutoff"
_OUTCOME_BY_ERROR = {GAP: GAP_TOKEN, BAD_BODY: BAD_BODY_TOKEN,
                     AFTER_CUTOFF_ONLY: AFTER_CUTOFF_TOKEN}
# Outcomes that will never change on their own.
TERMINAL_OUTCOMES = (GAP_TOKEN, BAD_BODY_TOKEN, AFTER_CUTOFF_TOKEN, "recovered",
                     "http_404", GAP, BAD_BODY, AFTER_CUTOFF_ONLY)


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _epoch(stamp: str) -> Optional[float]:
    if not stamp or not isinstance(stamp, str) or len(stamp) < 10:
        return None
    try:
        return calendar.timegm(time.strptime(stamp, "%Y-%m-%dT%H:%M:%SZ"))
    except ValueError:
        return None


def variant_outcomes(image: dict) -> dict[str, str]:
    """Which URL forms of this image the archive has already been asked about.

    Read from the image's own attempt log, so it survives a process restart and
    a fresh clone (the post records are in Git).
    """
    out: dict[str, str] = {}
    for att in image.get("attempts") or []:
        if att.get("endpoint") not in ("replay-probe", "cdx", "availability-api"):
            continue
        url = att.get("url") or att.get("media_url")
        if not url:
            continue
        err = att.get("error")
        if att.get("capture_timestamp"):
            # A probe/availability hit means a capture is *known*, not that its
            # bytes were fetched. Marking it "recovered" put the URL into the
            # terminal `tried` set, so a pass whose replay was cut short by an
            # open circuit breaker (post 29905114965, 2026-10) skipped the very
            # form holding the bytes on every later run. "capture_known" is
            # deliberately non-terminal: the form stays fetchable, while a true
            # recovery is recorded by note_attempt from `img["sha256"]`.
            outcome = "capture_known"
        elif err in (None, "", OK):
            outcome = GAP_TOKEN
        else:
            # Transient classes keep their own name so they stay retryable.
            outcome = _OUTCOME_BY_ERROR.get(err, str(err))
        out[url] = outcome
    return out


class ImageQueue:
    """Post-level recovery queue with per-variant memory and cooldowns."""

    def __init__(self, path: str = "", *, cooldown_minutes: int = DEFAULT_COOLDOWN_MINUTES,
                 max_attempts: int = DEFAULT_MAX_ATTEMPTS):
        self.path = path or config.IMAGE_QUEUE_JSON
        self.cooldown_minutes = cooldown_minutes
        self.max_attempts = max_attempts
        self.data = self._load()

    # -- persistence -------------------------------------------------------
    def _load(self) -> dict:
        if os.path.exists(self.path):
            try:
                with open(self.path, encoding="utf-8") as fh:
                    data = json.load(fh)
                # v2 -> v3 only renames the outcome tokens; a v2 file is still
                # readable, so an older checkout resumes instead of restarting.
                if isinstance(data, dict) and data.get("version") in (2, QUEUE_VERSION):
                    data.setdefault("posts", {})
                    data.setdefault("global", {})
                    return data
            except Exception:
                pass
        return {"version": QUEUE_VERSION, "posts": {}, "global": {}}

    def save(self) -> str:
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(self.data, fh, ensure_ascii=False, indent=1, sort_keys=True)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, self.path)
        return self.path

    # -- rows --------------------------------------------------------------
    def row(self, post_id: str) -> dict:
        return self.data["posts"].setdefault(str(post_id), {
            "attempts": 0, "last_at": "", "next_at": "", "recovered": 0,
            "last_outcome": "", "transient_streak": 0, "variants": {},
        })

    def attempts(self, post_id: str) -> int:
        return int(self.row(post_id).get("attempts") or 0)

    def cooling_down(self, post_id: str, now: Optional[float] = None) -> bool:
        row = self.row(post_id)
        nxt = _epoch(row.get("next_at", "") or "")
        return nxt is not None and nxt > (now if now is not None else time.time())

    def global_cooldown_active(self, now: Optional[float] = None) -> Optional[str]:
        g = self.data.get("global") or {}
        until = _epoch(g.get("throttled_until", "") or "")
        if until is None or until <= (now if now is not None else time.time()):
            return None
        return (f"archive cooldown until {g.get('throttled_until')} "
                f"after {g.get('transient_streak')} consecutive transport failures "
                f"({g.get('last_error', '')})")

    # -- eligibility -------------------------------------------------------
    def eligible_images(self, record: dict, *, retry_missing: bool = False,
                        stale_fn: Optional[Callable[[dict], bool]] = None,
                        final_errors: Iterable[str] = ()) -> tuple[list[dict], dict]:
        """Images of one post that still deserve an archive request."""
        pid = str(record.get("post_id"))
        row = self.row(pid)
        tried = row.setdefault("variants", {})
        # Without an explicit list, the canonical terminal verdicts are final:
        # a caller that does not know them still gets the "settled posts are
        # filtered before the batch limit" rule.
        final = tuple(final_errors) if final_errors else TERMINAL_OUTCOMES
        out: list[dict] = []
        if self.attempts(pid) >= self.max_attempts and not retry_missing:
            return out, row
        for img in record.get("images") or []:
            if img.get("sha256"):
                continue
            media_url = img.get("media_url")
            if not media_url:
                continue
            stale = bool(stale_fn(img)) if stale_fn else False
            if img.get("error") in final and not stale and not retry_missing:
                continue
            outcomes = dict(variant_outcomes(img))
            outcomes.update(tried.get(media_url) or {})
            out.append({"image": img, "media_url": media_url,
                        "tried": [u for u, o in outcomes.items() if o in TERMINAL_OUTCOMES]})
        return out, row

    def untried_variants(self, media_url: str, tried: Iterable[str]) -> list[str]:
        """Size/extension URL forms of `media_url` that no terminal verdict covers."""
        from .images import _variants

        done = {t for t in (tried or []) if t}
        plan = _variants(media_url)
        return [v for v in plan if v not in done]

    def select(self, records: Iterable[dict], *, limit: int, retry_missing: bool = False,
               stale_fn: Optional[Callable[[dict], bool]] = None,
               final_errors: Iterable[str] = (), order: str = "closest",
               ignore_cooldown: bool = False) -> tuple[list[dict], dict]:
        """Pick the next batch of posts that really have work left.

        Eligibility comes first, the limit is applied to what survives it, and
        the ordering rotates by attempt count so no post can be starved.

        `ignore_cooldown` is for an explicitly targeted pass (`--ids`): the
        caller has already named the posts and carries fresh evidence (a
        recorded capture, a repaired transport), so a per-post cooldown earned
        by an earlier transient outcome must not make the one requested post
        unreachable. The cooldown still governs unattended sweeps.
        """
        now = time.time()
        stats = {"records": 0, "posts_with_work": 0, "cooling_down": 0,
                 "no_work_left": 0, "attempt_capped": 0}
        chosen: list[tuple[tuple, str, list[dict], dict]] = []
        for rec in records:
            stats["records"] += 1
            pid = str(rec.get("post_id") or "")
            if not pid or not rec.get("images"):
                continue
            if not ignore_cooldown and self.cooling_down(pid, now):
                stats["cooling_down"] += 1
                continue
            images, row = self.eligible_images(rec, retry_missing=retry_missing,
                                               stale_fn=stale_fn, final_errors=final_errors)
            if not images:
                if self.attempts(pid) >= self.max_attempts:
                    stats["attempt_capped"] += 1
                else:
                    stats["no_work_left"] += 1
                continue
            stats["posts_with_work"] += 1
            missing = int(rec.get("missing_image_count") or 0) or len(images)
            priority = (self.attempts(pid),                 # never tried first
                        row.get("last_at") or "",           # then least recently tried
                        missing if order == "closest" else 0,
                        int(pid) if pid.isdigit() else 0,
                        pid)
            chosen.append((priority, pid, images, row))
        chosen.sort(key=lambda item: item[0])
        batch = [(pid, images) for _prio, pid, images, _row in chosen[:max(0, limit)]]
        stats["selected"] = len(batch)
        stats["remaining_with_work"] = max(0, len(chosen) - len(batch))
        return batch, stats

    # -- bookkeeping -------------------------------------------------------
    def note_attempt(self, post_id: str, images: list[dict], result: dict) -> dict:
        row = self.row(str(post_id))
        row["attempts"] = int(row.get("attempts") or 0) + 1
        row["last_at"] = now_iso()
        row["last_outcome"] = result.get("outcome", "")
        row["recovered"] = int(result.get("recovered") or 0)
        transient = int(result.get("transient") or 0)
        if transient:
            row["transient_streak"] = int(row.get("transient_streak") or 0) + 1
        else:
            row["transient_streak"] = 0
        tried = row.setdefault("variants", {})
        for entry in images or []:
            if not isinstance(entry, dict):
                continue
            img = entry.get("image")
            media_url = entry.get("media_url")
            if not isinstance(img, dict) or not media_url:
                continue
            already = set(entry.get("tried") or [])
            outcomes = variant_outcomes(img)
            if img.get("sha256"):
                outcomes[img["media_url"]] = "recovered"
            bucket = tried.setdefault(media_url, {})
            for url, outcome in outcomes.items():
                if url in already and outcome in TERMINAL_OUTCOMES:
                    # A terminal verdict from an earlier pass is not overwritten
                    # by a weaker one from this pass.
                    continue
                bucket[url] = outcome
            bucket["_updated_at"] = row["last_at"]
        # Cooldown only when the pass was actually disturbed by the archive.
        if transient:
            row["next_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ",
                                           time.gmtime(time.time() + self.cooldown_minutes * 60))
        else:
            row["next_at"] = ""
        return row

    def note_global_failure(self, error: str) -> dict:
        g = self.data.setdefault("global", {})
        g["transient_streak"] = int(g.get("transient_streak") or 0) + 1
        g["last_error"] = str(error)[:200]
        g["last_at"] = now_iso()
        streak = g["transient_streak"]
        # Back off harder the longer the archive keeps failing: 15, 30, 60 ...
        minutes = min(240, 15 * (2 ** min(streak - 1, 4)))
        g["throttled_until"] = time.strftime("%Y-%m-%dT%H:%M:%SZ",
                                             time.gmtime(time.time() + minutes * 60))
        return g

    def note_global_success(self) -> None:
        g = self.data.get("global") or {}
        if g.get("transient_streak"):
            g["transient_streak"] = 0
            g["throttled_until"] = ""
            g["recovered_at"] = now_iso()

    def summary(self) -> dict:
        posts = self.data.get("posts") or {}
        return {
            "posts_seen": len(posts),
            "attempts_total": sum(int(r.get("attempts") or 0) for r in posts.values()),
            "posts_with_recovery": sum(1 for r in posts.values() if r.get("recovered")),
            "posts_cooling_down": sum(1 for r in posts.values() if r.get("next_at")),
            "global": self.data.get("global") or {},
            "queue_file": self.path,
        }