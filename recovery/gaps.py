"""File-level archive-gap proofs for Tumblr media URLs.

Why this exists
---------------
Earlier iterations asked the CDX for the *exact* image URL and, on a miss, for
up to four size/extension siblings. That costs ~5 slow queries per image and
only ever proves "this exact URL is not archived". A Tumblr CDN URL identifies
a *file* in two ways, and both are stable across the variations the archive
might have stored instead:

* ``<host>/<32-hex md5>/<name>_<size>.<ext>`` -- the 32-hex directory is the
  MD5 of the file contents, so every size/extension of that file lives under
  one prefix.
* ``<host>/<name>_<size>.<ext>`` (no directory) -- the Tumblr name stem is
  globally unique per photo, so every size/extension of that file lives under
  one filename prefix.

So one `matchType=prefix` CDX query answers "is *any* version of this file
archived on this host?" -- it returned in 0.1-1.3 s in live probes, versus tens
of seconds for the exact/variant sweep. The archive answers an empty result set
with HTTP 200 and zero rows, which is what makes an empty answer *evidence* of a
gap rather than a transient failure; every other outcome (429, 5xx, timeout,
connection error) is recorded as inconclusive so a later iteration retries it.

Tumblr serves the same file from many numbered CDN hosts, so the same file may
be archived under a *different* host than the post page referenced. The proof
therefore queries the referenced host (both schemes), the host-less
``media.tumblr.com`` form and a bounded set of alternate hosts. Only when every
issued query came back 200-with-zero-rows is the outcome a confirmed gap.

Nothing here invents data: it only records what the archive answered, and it
hands any capture it does find to the media index so ``fetch-images`` can use
it.
"""
from __future__ import annotations

import re
from typing import Optional
from urllib.parse import urlsplit

from . import config
from .cdx import Capture, cdx_query
from .http import Fetcher

# Alternate CDN hosts worth asking about when the referenced host has nothing.
# Ordered by how often they show up in this blog's post pages.
DEFAULT_ALT_HOSTS = (
    "24.media.tumblr.com",
    "25.media.tumblr.com",
    "40.media.tumblr.com",
    "41.media.tumblr.com",
    "65.media.tumblr.com",
    "66.media.tumblr.com",
    "67.media.tumblr.com",
    "68.media.tumblr.com",
    "78.media.tumblr.com",
)
HOSTLESS = "media.tumblr.com"
# Tumblr shards the same CDN over ~70 numbered hosts, and a capture can land on
# any of them, so a proof that only asks the referenced host cannot call a file
# missing. SHARD_HOSTS is the full sweep used by `prove-gaps --shard-sweep`.
SHARD_HOSTS = tuple(f"{n}.media.tumblr.com" for n in range(0, 99))

MD5_DIR = re.compile(r"^[0-9a-f]{32}$", re.IGNORECASE)
SIZE_SUFFIX = re.compile(r"_\d+$")


def file_key(url: str) -> tuple[str, str]:
    """Identify the underlying Tumblr file independent of size/extension.

    Returns ``("dir", md5)`` for hashed CDN paths, ``("stem", name)`` for
    unhashed ones, and ``("", "")`` when the URL is not a media file at all.
    """
    parts = [p for p in urlsplit(url).path.split("/") if p]
    if not parts:
        return ("", "")
    name = parts[-1]
    stem = name.rpartition(".")[0] or name
    if len(parts) >= 2 and MD5_DIR.match(parts[-2]):
        return ("dir", parts[-2].lower())
    if stem.lower().startswith("tumblr_"):
        return ("stem", SIZE_SUFFIX.sub("", stem))
    return ("", "")


def query_forms(url: str, alt_hosts: int = 2, shard_sweep: bool = False) -> list[dict]:
    """The bounded set of prefix queries that together prove a file's fate.

    Order matters: cheapest and most likely first, so a partial run still
    settles the common case.

    `shard_sweep=True` replaces the small alternate-host list with every
    numbered Tumblr CDN shard, and queries http only (the scheme the post pages
    actually referenced). That is ~72 queries instead of 8 -- it is the
    expensive, final word on whether a file exists anywhere in the Tumblr CDN
    capture set, not something to run per image.
    """
    parts = urlsplit(url)
    host = parts.netloc.lower()
    kind, key = file_key(url)
    if not key:
        return []
    if kind == "dir":
        form = f"{key}/*"
    else:
        # No extension: covers _500.jpg, _1280.png, _540.gif and friends.
        form = f"{key}*"
    schemes = ("http",) if shard_sweep else ("http", "https")
    if shard_sweep:
        hosts = [host or HOSTLESS, HOSTLESS] if host else [HOSTLESS]
        hosts += [h for h in SHARD_HOSTS if h != host]
        seen: set[str] = set()
        hosts = [h for h in hosts if not (h in seen or seen.add(h))]
    else:
        hosts = [host, f"www.{host}"] if host.startswith("www.") else [host]
        hosts.append(HOSTLESS)
        for extra in DEFAULT_ALT_HOSTS[:max(0, alt_hosts)]:
            if extra != host:
                hosts.append(extra)
    plans = []
    for scheme in schemes:
        for h in hosts:
            plans.append({
                "url": f"{scheme}://{h}/{form}",
                "host": h,
                "scheme": scheme,
                "note": ("referenced host" if h == host else
                         "alternate CDN host" if not shard_sweep else "shard sweep"),
            })
    return plans


def prove(fetcher: Fetcher, media_url: str, alt_hosts: int = 2,
          limit: int = 25, shard_sweep: bool = False) -> dict:
    """Search every plausible capture of one media file.

    Returns a ledger row: ``result`` is ``capture_found``,
    ``confirmed_gap`` (every query answered 200 with zero rows) or
    ``inconclusive`` (a query failed, so the archive never got to decide),
    plus the queries issued and their answers.
    """
    plans = query_forms(media_url, alt_hosts=alt_hosts, shard_sweep=shard_sweep)
    row: dict = {
        "media_url": media_url,
        "file_key": "/".join(file_key(media_url)),
        "queries": [],
        "result": "inconclusive",
        "captures": [],
        "mode": "shard_sweep" if shard_sweep else "referenced_host",
    }
    if not plans:
        row["result"] = "not_media"
        return row
    decided = True
    for plan in plans:
        caps, resp = cdx_query(fetcher, plan["url"], match="prefix", limit=limit,
                               extra={"filter": "statuscode:200"})
        empty_answer = resp.status == 200 and not caps
        row["queries"].append({
            "url": plan["url"],
            "host": plan["host"],
            "note": plan["note"],
            "status": resp.status,
            "error": resp.error,
            "message": resp.message,
            "rows": len(caps),
        })
        if caps:
            row["captures"].extend(c.to_row() for c in caps)
            row["result"] = "capture_found"
            decided = False
            break
        if not empty_answer:
            decided = False
    if row["result"] != "capture_found":
        row["result"] = "confirmed_gap" if decided else "inconclusive"
    return row


def best_capture(rows: list[dict]) -> Optional[dict]:
    """Newest pre-cutoff capture from a proof row that looks like an image."""
    best = None
    for r in rows:
        if not str(r.get("statuscode", "200")).startswith("2"):
            continue
        mt = (r.get("mimetype") or "").lower()
        if mt and not mt.startswith("image/"):
            continue
        ts = str(r.get("timestamp", ""))
        if len(ts) < 14 or ts > config.CUTOFF:
            continue
        if best is None or ts > str(best.get("timestamp", "")):
            best = r
    return best