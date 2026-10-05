"""CDX inventory helpers: resumable, cutoff-bounded capture discovery."""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, asdict
from typing import Iterable, Optional

from . import config
from .http import GAP, OK, Fetcher, Response

DEFAULT_FIELDS = "urlkey,timestamp,original,mimetype,statuscode,digest,length,redirect"


@dataclass
class Capture:
    timestamp: str
    original: str
    statuscode: str = ""
    mimetype: str = ""
    digest: str = ""
    length: str = ""
    urlkey: str = ""
    redirect: str = ""
    source_query: str = ""

    @property
    def key(self) -> str:
        return f"{self.timestamp}|{normalize_url(self.original)}"

    def to_row(self) -> dict:
        d = asdict(self)
        return {k: v for k, v in d.items() if v}


def normalize_url(url: str) -> str:
    """Canonical comparison form: no scheme, no default port, lowercase host."""
    u = url.strip()
    for scheme in ("https://", "http://"):
        if u.lower().startswith(scheme):
            u = u[len(scheme):]
            break
    if u.startswith("//"):
        u = u[2:]
    host, _, path = u.partition("/")
    host = host.lower()
    if ":" in host:
        host = host.rsplit(":", 1)[0]
    path = path or "/"
    return f"{host}/{path}" if path != "/" else host


def within_cutoff(timestamp: str, cutoff: str = config.CUTOFF) -> bool:
    return isinstance(timestamp, str) and len(timestamp) >= 14 and timestamp <= cutoff


def parse_cdx_json(rows: list, source_query: str = "") -> list[Capture]:
    """CDX json output: first row is a header when fields are requested."""
    out: list[Capture] = []
    if not rows:
        return out
    header: Optional[list] = None
    first = rows[0]
    if first and isinstance(first[0], str) and first[0] in ("urlkey", "timestamp"):
        header = list(first)
        rows = rows[1:]
    for row in rows:
        if not isinstance(row, (list, tuple)) or not row:
            continue
        if header is None:
            header = DEFAULT_FIELDS.split(",")
            header = header[: len(row)]
        rec = dict(zip(header, [str(v) for v in row]))
        ts = rec.get("timestamp", "")
        if not within_cutoff(ts):
            continue
        out.append(
            Capture(
                timestamp=ts,
                original=rec.get("original", ""),
                statuscode=rec.get("statuscode", ""),
                mimetype=rec.get("mimetype", ""),
                digest=rec.get("digest", ""),
                length=rec.get("length", ""),
                urlkey=rec.get("urlkey", ""),
                redirect=rec.get("redirect", ""),
                source_query=source_query,
            )
        )
    return out


def cdx_data_rows(rows: list) -> int:
    """How many data rows a CDX json body carried, header excluded.

    `parse_cdx_json` drops rows that are after the cutoff or malformed, so the
    length of its output is *not* how full the page was. Paging decisions must
    use this count instead, or a page of rows that were all filtered out looks
    like the last page and turns an unfinished scan into a "complete" one.
    """
    if not rows:
        return 0
    first = rows[0]
    header = bool(first and isinstance(first[0], str) and first[0] in ("urlkey", "timestamp"))
    return max(0, len(rows) - (1 if header else 0))


def cdx_query(fetcher: Fetcher, url: str, *, match: str = "prefix", limit: int = 10000,
              extra: Optional[dict] = None) -> tuple[list[Capture], Response]:
    """One CDX query. Returns captures and the raw response for diagnostics."""
    params = {
        "url": url,
        "matchType": match,
        "from": "19960101",
        "to": config.CUTOFF,
        "fl": DEFAULT_FIELDS,
        "limit": str(limit),
    }
    if extra:
        params.update(extra)
    resp = fetcher.cdx(params)
    if not resp.ok:
        return [], resp
    try:
        rows = resp.json()
    except Exception as exc:  # pragma: no cover - defensive
        resp.error = "http_error"
        resp.message = f"bad cdx json: {exc}"
        return [], resp
    resp.cdx_rows = cdx_data_rows(rows)
    return parse_cdx_json(rows, source_query=url), resp


def year_windows(start_year: int = 2007, end_year: int = 2019) -> list[str]:
    """Per-year `from` values so big inventories can resume after interruption."""
    return [f"{y}0101" for y in range(start_year, end_year + 1)]


class CaptureIndex:
    """Append-only JSONL capture inventory with a resumable manifest."""

    def __init__(self, path: str, manifest_path: str | None = None):
        self.path = path
        self.manifest_path = manifest_path or path + ".manifest.json"
        self._keys: set[str] = set()
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        if os.path.exists(path):
            with open(path, encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        rec = json.loads(line)
                    except Exception:
                        continue
                    self._keys.add(f"{rec.get('timestamp')}|{normalize_url(rec.get('original',''))}")
        self.manifest = self._load_manifest()

    def _load_manifest(self) -> dict:
        if os.path.exists(self.manifest_path):
            try:
                with open(self.manifest_path, encoding="utf-8") as fh:
                    return json.load(fh)
            except Exception:
                return {}
        return {"done": {}, "stats": {}}

    def save_manifest(self) -> None:
        tmp = self.manifest_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(self.manifest, fh, ensure_ascii=False, indent=2, sort_keys=True)
        os.replace(tmp, self.manifest_path)

    def query_done(self, name: str) -> bool:
        return bool(self.manifest.get("done", {}).get(name))

    def mark_done(self, name: str, info: dict | None = None) -> None:
        self.manifest.setdefault("done", {})[name] = info or {"at": _now()}
        self.save_manifest()

    def add(self, captures: Iterable[Capture]) -> int:
        new = 0
        with open(self.path, "a", encoding="utf-8") as fh:
            for cap in captures:
                if cap.key in self._keys:
                    continue
                self._keys.add(cap.key)
                fh.write(json.dumps(cap.to_row(), ensure_ascii=False) + "\n")
                new += 1
            fh.flush()
            os.fsync(fh.fileno())
        self.manifest.setdefault("stats", {})[os.path.basename(self.path)] = len(self._keys)
        self.save_manifest()
        return new

    def all(self) -> list[Capture]:
        out: list[Capture] = []
        if not os.path.exists(self.path):
            return out
        with open(self.path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except Exception:
                    continue
                out.append(
                    Capture(
                        timestamp=rec.get("timestamp", ""),
                        original=rec.get("original", ""),
                        statuscode=rec.get("statuscode", ""),
                        mimetype=rec.get("mimetype", ""),
                        digest=rec.get("digest", ""),
                        length=rec.get("length", ""),
                        urlkey=rec.get("urlkey", ""),
                        redirect=rec.get("redirect", ""),
                        source_query=rec.get("source_query", ""),
                    )
                )
        return out


def _now() -> str:
    import datetime

    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
