"""Complete, resumable host inventories of Tumblr media shards.

Why this replaces `media.scan_host`'s `page=` cursor
----------------------------------------------------
`matchType=domain` with `page=N` was measured on 2026-10-06 to answer a *short*
page: `url=40.media.tumblr.com&limit=5000&page=1` returned 4228 rows while
`showNumPages` at `limit=1` said the host holds 4794 unique urlkeys. The missing
566 rows are not at the end of the ordering -- they include
`.../acd66e1322aeb10e0ec13ae1659eae09/tumblr_o07sizvpqP1r3it8zo1_500.jpg`, which a
plain `matchType=prefix` query on the same host proves exists (20160125230748).
So `raw_rows < page_size` is not "last page": a truncated page is shorter than
requested and `scan_host` stamped `complete` on it, which turns "we did not see
this key" into a *confirmed archive gap* for images that are actually archived.
That is the single most expensive defect in this crawler: it manufactures gaps
and then stops asking.

The CDX server does support `showResumeKey=true`: the last row of the response
is the opaque resume key to pass back as `resumeKey=`. That cursor is exact (it
is the last row, not a page offset), so paging until the key stops changing
walks the *whole* host in urlkey order.

Storage
-------
Every row is appended to `data/work/hostdumps/<host>.jsonl` (gitignored bulk
state) and the cursor lives in `data/cdx/hostdump-cursors/<host>.cursor.json`,
so a fresh runner or a killed process resumes instead of restarting. Only rows
whose media key a recovered post actually references are written to the
committed `data/cdx/media.jsonl` index; the rest stay in the dump for offline
matching. Both the dump directory and the cursor directory are listed in
`recovery/state_checkpoint.py`'s `STATE_DIRS`, so both travel in the
`crawl-state` registry checkpoint and the inventory survives a fresh runner. A
`complete` verdict is only reused when the rows it was based on are actually
present (`_dump_survives`), so a lost dump degrades to "re-walk", never to a
false confirmed gap.
"""
from __future__ import annotations

import base64
import json
import os
import time
import urllib.parse
import zlib
from typing import Iterable, Optional

from . import config
from .cdx import Capture, CaptureIndex, parse_cdx_json, within_cutoff
from .media import HOST_RE, key_of

CDX_ENDPOINT = "https://web.archive.org/cdx/search/cdx"
# Raw rows are bulky and stay in the ignored working tree. The *cursor* is tiny
# and is what makes a walk resumable, so it lives under `data/cdx/`, which the
# `crawl-state` registry checkpoint carries. Before this split the cursor sat
# beside the dump in `data/work/`, outside every checkpoint path, so a fresh
# runner restarted each host walk from page 1 (and a `page=`-era "complete"
# verdict was never replaced by a real resume-key walk).
DUMP_DIR = os.path.join(config.DATA_DIR, "work", "hostdumps")
CURSOR_DIR = os.path.join(config.CDX_DIR, "hostdump-cursors")
# The dump rows travel in the `crawl-state` registry checkpoint (see
# recovery/state_checkpoint.py STATE_DIRS) so a fresh runner can re-index new
# keys without re-walking the host. The cursor alone is not enough: a
# `complete` verdict is only trustworthy when the rows it was based on are
# actually present (see `_dump_survives`).
PAGE_LIMIT = 1000
# Filters every dumped row is scoped to. Recorded with the cursor so a later run
# never resumes a dump that was taken with different filters as if it were the
# same inventory.
SCOPE = {"matchType": "domain", "filter": "statuscode:200", "collapse": "urlkey",
         "to": config.CUTOFF, "limit": PAGE_LIMIT}

HEADERS = ["urlkey", "timestamp", "original", "mimetype", "statuscode", "digest",
           "length", "redirect"]


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def dump_paths(host: str) -> tuple[str, str]:
    host = host.strip().lower()
    return (os.path.join(DUMP_DIR, f"{host}.jsonl"),
            os.path.join(CURSOR_DIR, f"{host}.cursor.json"))


def decode_resume_key(value: str) -> str:
    """Best-effort view of the opaque resume key, for logging only.

    The cursor is passed back to the server verbatim, so a key we cannot decode
    is still perfectly usable -- it just stays opaque. Wayback sends an unpadded
    base64 deflate blob; both the padded and unpadded forms are accepted.
    """
    if not value:
        return value
    padded = value + "=" * (-len(value) % 4)
    try:
        raw = base64.b64decode(padded)
    except Exception:
        return value
    for wbits in (zlib.MAX_WBITS, -zlib.MAX_WBITS):
        try:
            return zlib.decompress(raw, wbits).decode("utf-8", "replace")
        except Exception:
            continue
    return value


def _dump_line_count(path: str) -> int:
    """Non-empty lines in a dump file, or -1 when the file is absent."""
    if not os.path.exists(path):
        return -1
    n = 0
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            if line.strip():
                n += 1
    return n


def _dump_survives(path: str, written: int) -> bool:
    """Can a `complete` resume-key verdict be re-verified on this runner?

    The cursor records how many rows the walk wrote (`written`). If the dump
    file is missing or shorter than that, the rows the verdict rests on are
    gone -- treating it as complete would let `host_complete` declare every key
    of the host a *confirmed* gap from an inventory that no longer exists. A
    zero-row inventory legitimately has no dump and is still complete.
    """
    written = int(written or 0)
    if written <= 0:
        return True
    return _dump_line_count(path) >= written


def _cursor_written(cur: dict) -> int:
    """Rows a cursor claims to have written.

    Older cursors recorded only `rows`; fall back to it so a missing `written`
    field is never mistaken for "no rows to check" (which would silently accept
    an unverifiable partial cursor).
    """
    return int(cur.get("written", cur.get("rows", 0)) or 0)


def _dump_tail_key(path: str) -> str:
    """urlkey of the last non-empty row, or '' when absent/unreadable.

    The resume key is minted *after* the last row of the page, so the dump's
    final urlkey is an identity check on the rows a partial cursor rests on --
    not just a count.
    """
    if not os.path.exists(path):
        return ""
    last = ""
    try:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    last = json.loads(line).get("urlkey", "") or ""
                except Exception:
                    last = ""
    except OSError:
        return ""
    return last


def _partial_resume_is_verifiable(path: str, cur: dict) -> bool:
    """Can a *partial* walk resume from its stored key on this runner?

    The key is an opaque cursor into the host ordering; resuming without the
    rows already written would skip their prefix and later let the walk declare
    `complete` from an inventory with a hole. Require the dump to still hold at
    least the rows the cursor counted, and -- when the cursor recorded one --
    the same final urlkey, the row the key was minted after.
    """
    written = _cursor_written(cur)
    if written <= 0:
        return True
    if _dump_line_count(path) < written:
        return False
    want = cur.get("last_urlkey") or ""
    if want and _dump_tail_key(path) != want:
        return False
    return True


def read_cursor(host: str) -> dict:
    _, cur = dump_paths(host)
    if not os.path.exists(cur):
        return {}
    try:
        with open(cur, encoding="utf-8") as fh:
            rec = json.load(fh)
    except Exception:
        return {}
    if rec.get("scope") != SCOPE:
        # Different filters (or an older `page=` based scan): not resumable.
        return {}
    return rec


def write_cursor(host: str, rec: dict) -> None:
    _, cur = dump_paths(host)
    os.makedirs(CURSOR_DIR, exist_ok=True)
    rec = dict(rec)
    rec["host"] = host.strip().lower()
    rec["scope"] = SCOPE
    rec["updated_at"] = _now()
    tmp = cur + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(rec, fh, ensure_ascii=False)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, cur)


def build_query(host: str, resume_key: str = "", limit: int = PAGE_LIMIT) -> str:
    params = {"url": host, "matchType": "domain", "output": "json",
              "limit": str(limit), "collapse": "urlkey", "to": config.CUTOFF,
              "filter": "statuscode:200", "showResumeKey": "true", "fields": ",".join(HEADERS)}
    if resume_key:
        params["resumeKey"] = resume_key
    return CDX_ENDPOINT + "?" + urllib.parse.urlencode(params)


def parse_page(payload: str, source_query: str = "") -> tuple[list[Capture], str]:
    """(captures, next resume key) from one CDX page.

    The resume key rides in the final row, which is *not* a capture: it has one
    field. Everything else is a capture row; after-cutoff rows are dropped by
    `parse_cdx_json` but the key itself is still consumed.
    """
    try:
        rows = json.loads(payload or "[]")
    except Exception:
        return [], ""
    if not rows:
        return [], ""
    next_key = ""
    last = rows[-1]
    # Never the header: a header row is also a list, and mistaking it for the key
    # would drop every capture of the page.
    if len(rows) > 1 and isinstance(last, list) and len(last) == 1 and isinstance(last[0], str):
        # Verbatim, never decoded: the CDX server only accepts the opaque
        # base64-deflate token it handed out. Feeding it the human-readable
        # `urlkey timestamp` view (what `decode_resume_key` returns for many
        # keys) makes the next page answer HTTP 400 and strands the walk --
        # observed on 68.media.tumblr.com, 2026-10-08, page 11.
        next_key = last[0]
        rows = rows[:-1]
    return parse_cdx_json(rows, source_query), next_key


def scan_host(fetcher, host: str, *, keys: Optional[set[str]] = None,
              index: Optional[CaptureIndex] = None, max_pages: int = 60,
              limit: int = PAGE_LIMIT) -> dict:
    """Walk every pre-cutoff 200 row of one media host, resuming where we stopped.

    `keys` decides what is copied into the committed index; every row is always
    appended to the dump, so widening `keys` later needs no network.
    """
    host = (host or "").strip().lower()
    if not HOST_RE.match(host):
        return {"host": host, "skipped": "not a tumblr media host"}
    dump_path, _ = dump_paths(host)
    os.makedirs(DUMP_DIR, exist_ok=True)
    cur = read_cursor(host)
    restart_reason = ""
    if cur.get("complete"):
        if _dump_survives(dump_path, _cursor_written(cur)):
            _publish(index, host, cur)
            return {"host": host, "complete": True, "rows": cur.get("rows", 0),
                    "pages": cur.get("pages", 0), "skipped": "already complete",
                    "scanned_at": cur.get("scanned_at", "")}
        # The rows are not on this runner, so the "complete" claim cannot be
        # checked. Re-walk instead of publishing an unverifiable verdict.
        cur = {}
        restart_reason = "complete verdict without its rows"
    elif cur and not _partial_resume_is_verifiable(dump_path, cur):
        # A partial cursor whose earlier rows are gone (the usual fresh-runner
        # state: the cursor rides in `data/cdx`, which the supervisor carries,
        # while the raw rows live in `data/work`). Resuming from its opaque key
        # would skip the missing prefix and later let `host_complete` declare a
        # hole-free inventory from a walk that never saw those rows. Re-walk
        # from page 1 instead of silently advancing an unverifiable cursor.
        cur = {}
        restart_reason = "partial cursor without its rows"
    if restart_reason and os.path.exists(dump_path):
        # The new walk's rows must be a clean prefix of that walk; drop leftover
        # rows from the abandoned walk so a later resume cannot mix the two.
        try:
            os.remove(dump_path)
        except OSError:
            pass
    resume_key = cur.get("resume_key", "")
    rows = int(cur.get("rows", 0))
    pages = int(cur.get("pages", 0))
    written = int(cur.get("written", 0))
    last_urlkey = cur.get("last_urlkey", "")
    kept = 0
    stop_reason = ""
    for _ in range(max_pages):
        query = build_query(host, resume_key, limit)
        resp = fetcher.get(query)
        if not resp.ok:
            # Transient: the cursor is untouched, so the next pass continues here.
            return {"host": host, "rows": rows, "pages": pages, "kept": kept,
                    "complete": False, "stopped": resp.error or f"http_{resp.status}",
                    "status": resp.status, "scanned_at": _now()}
        caps, next_key = parse_page(resp.text(), source_query=query)
        # A page that returns rows but no *new* key is the end of the inventory.
        if not caps and not next_key:
            stop_reason = "empty page"
            cur_complete = True
            break
        with open(dump_path, "a", encoding="utf-8") as fh:
            for cap in caps:
                if cap.statuscode in ("200", "") and within_cutoff(cap.timestamp):
                    fh.write(json.dumps(cap.to_row(), ensure_ascii=False) + "\n")
                    written += 1
                    last_urlkey = cap.urlkey or last_urlkey
        rows += len(caps)
        pages += 1
        if keys is not None and index is not None:
            batch = [c for c in caps if c.statuscode in ("200", "")
                     and within_cutoff(c.timestamp) and key_of(c.original) in keys]
            if batch:
                kept += index.add(batch)
        if next_key and next_key == resume_key:
            stop_reason = "resume key unchanged"
            cur_complete = True
            break
        resume_key = next_key
        write_cursor(host, {"resume_key": resume_key, "rows": rows, "pages": pages,
                            "written": written, "last_urlkey": last_urlkey,
                            "complete": False})
    else:
        cur_complete = False
        stop_reason = "page budget"
    write_cursor(host, {"resume_key": resume_key, "rows": rows, "pages": pages,
                        "written": written, "last_urlkey": last_urlkey,
                        "complete": cur_complete, "restart_reason": restart_reason,
                        "stop_reason": stop_reason, "scanned_at": _now()})
    # Publish the walk's verdict where the image resolver reads it, and label it
    # with the cursor that produced it so a legacy `page=` entry can never be
    # mistaken for proof that a host was fully seen.
    _publish(index, host, {"rows": rows, "pages": pages, "written": written,
                           "kept": kept, "complete": cur_complete,
                           "stop_reason": stop_reason})
    return {"host": host, "rows": rows, "pages": pages, "kept": kept,
            "complete": cur_complete, "stop_reason": stop_reason,
            "scanned_at": _now()}


def _publish(index: Optional[CaptureIndex], host: str, state: dict) -> None:
    """Record a resume-key walk's verdict in the shared media manifest."""
    if index is None:
        return
    info = dict(state)
    info.update({"host": host.strip().lower(), "resume_key_walk": True,
                 "cursor": "resumeKey", "scope": SCOPE,
                 "scanned_at": state.get("scanned_at") or _now()})
    index.mark_done(f"host:{info['host']}", info)


def dump_hosts() -> list[str]:
    try:
        return sorted(f[:-6] for f in os.listdir(DUMP_DIR) if f.endswith(".jsonl"))
    except FileNotFoundError:
        return []


def read_dump(host: str) -> Iterable[Capture]:
    path, _ = dump_paths(host)
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except Exception:
                continue
            yield Capture(**{k: v for k, v in rec.items() if v})