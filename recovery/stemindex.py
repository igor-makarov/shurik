"""Durable cache of batched CDX stem-prefix answers.

Why
---
Asking the archive about one image at a time costs one round trip per image
(~10-20 s each against `web.archive.org`), and with ~2200 known media URLs the
per-image path cannot finish the corpus in an iteration. The CDX API accepts a
*repeated* `url=` parameter, so one request can answer the existence question
for dozens of size-stem prefixes at once -- the same questions the per-image
`--method stem` path asks, only batched.

This index is that batched answer set, kept on disk so a fresh runner reuses it
(an empty answer is real evidence and must not be re-asked):

* a stem with captures  -> those `Capture` rows, used by `resolve_image`
  instead of a new CDX request;
* a stem with no captures -> a *scoped* negative: no pre-cutoff
  `statuscode:200` capture exists for that exact prefix with these filters.
  It never becomes a global "the archive has nothing" claim.

It lives in `data/cdx/` (gitignored bulk state, carried by the `crawl-state`
checkpoint), never in Git.
"""
from __future__ import annotations

import json
import os
import threading
import time
from typing import Iterable, Optional

from . import config
from .cdx import Capture, normalize_url

STEM_FILE = os.path.join(config.CDX_DIR, "stems.jsonl")
# Filters every stem answer is scoped to. Recorded in the file so a later run
# never mistakes an answer taken with different filters for the same question.
SCOPE = {"matchType": "prefix", "filter": "statuscode:200", "collapse": "urlkey",
         "to": config.CUTOFF}


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


class StemIndex:
    """Append-only record of one CDX answer per size-stem prefix."""

    def __init__(self, path: str = ""):
        self._lock = threading.Lock()
        # Late-bound like PostStore/MediaIndex: an import-time default would pin
        # the repository's inventory into every caller (including tests).
        self.path = path or STEM_FILE
        self.rows: dict[str, list[Capture]] = {}
        self.asked_at: dict[str, str] = {}
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        if os.path.exists(self.path):
            with open(self.path, encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        rec = json.loads(line)
                    except Exception:
                        continue
                    stem = rec.get("stem")
                    if not stem or rec.get("scope") != SCOPE:
                        continue
                    self.rows[stem] = [Capture(**{k: v for k, v in c.items() if v})
                                       for c in rec.get("captures") or []]
                    self.asked_at[stem] = rec.get("at", "")

    # ------------------------------------------------------------------ query
    def _alternates(self, stem: str) -> list[str]:
        """Both scheme forms of a stem prefix (legacy rows kept either one).

        `stem_prefix` is now canonicalised to `http`, but earlier passes
        recorded some answers under `https`. The CDX answers identically for
        both, so a lookup must accept either row instead of re-asking.
        """
        if stem.startswith("http://"):
            return [stem, "https://" + stem[len("http://"):]]
        if stem.startswith("https://"):
            return [stem, "http://" + stem[len("https://"):]]
        return [stem]

    def has(self, stem: str) -> bool:
        """Was this exact stem prefix already answered (hit *or* miss)?"""
        return any(s in self.rows for s in self._alternates(stem))

    def lookup(self, stem: str) -> Optional[list[Capture]]:
        """Captures for a stem prefix, `[]` for a recorded miss, None if unknown."""
        for s in self._alternates(stem):
            if s in self.rows:
                return self.rows.get(s)
        return None

    def missing(self, stems: Iterable[str]) -> list[str]:
        seen: set[str] = set()
        out: list[str] = []
        for stem in stems:
            if stem and stem not in self.rows and stem not in seen:
                seen.add(stem)
                out.append(stem)
        return out

    # ------------------------------------------------------------------ write
    def record(self, stem: str, captures: Iterable[Capture], at: str = "") -> None:
        caps = list(captures)
        # `fetch-images` runs the workers in a thread pool, so two images of the
        # same post can answer the same stem at once. Serialising the append
        # keeps the append-only file one answer per line instead of two
        # half-written ones.
        with self._lock:
            self.rows[stem] = caps
            self.asked_at[stem] = at or _now()
            rec = {"stem": stem, "at": self.asked_at[stem], "scope": SCOPE,
                   "key": normalize_url(stem),
                   "captures": [c.to_row() for c in caps]}
            with open(self.path, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
                fh.flush()
                os.fsync(fh.fileno())

    def record_many(self, answers: dict[str, list[Capture]], at: str = "") -> int:
        n = 0
        for stem, caps in answers.items():
            self.record(stem, caps, at=at)
            n += 1
        return n

    def summary(self) -> dict:
        hits = sum(1 for caps in self.rows.values() if caps)
        return {"stems_answered": len(self.rows), "stems_with_captures": hits,
                "file": self.path}
