"""Human-readable progress report generated from committed state."""
from __future__ import annotations

import json
import os
from collections import Counter
from typing import Optional

from . import config
from .store import JsonlStore, PostStore

REPORT_PATH = "RECOVERY_REPORT.md"


def _fmt_methods(entries: list[dict], limit: int = 6) -> str:
    lines = []
    for entry in entries[:limit]:
        key = entry.get("key", "")
        lines.append(f"- `{entry.get('kind')}` **{key}** — {entry.get('reason')}")
        for att in (entry.get("methods") or [])[:4]:
            url = att.get("url", "")
            cap = att.get("capture_timestamp") or ""
            lines.append(f"  - `{att.get('endpoint')}` {url} {('capture ' + cap) if cap else ''}"
                         f" → {att.get('error') or att.get('status')} "
                         f"({att.get('bytes', 'n/a')} bytes)")
    return "\n".join(lines)


def build_report(status: Optional[dict] = None) -> str:
    from .cli import status as cli_status

    st = status or cli_status()
    store = PostStore()
    posts = list(store.all())
    ledger = JsonlStore(config.MISSING_JSONL).records()
    published = JsonlStore(config.PUBLISHED_JSONL).records()

    reasons = Counter(e.get("reason") for e in ledger)
    sample_published = [p for p in posts if p.get("published")][:8]

    out = []
    out.append("# Hazfalafel recovery report\n")
    out.append(f"Generated {st['generated_at']} from committed state in `data/`.\n")
    out.append(f"Package: `{config.PACKAGE_URL}` — one artifact per post, tag = numeric Tumblr post id.\n")
    out.append(f"Cutoff: every capture used is at or before `{config.CUTOFF}`.\n")

    out.append("\n## Counters\n")
    out.append("| metric | count |")
    out.append("| --- | --- |")
    for key in ("discovered_posts", "captures_indexed", "listing_captures", "posts_parsed",
                "recovered_posts", "complete_posts", "partial_posts", "published_posts",
                "images_recovered", "images_missing", "missing_ledger_entries",
                "posts_without_permalink"):
        out.append(f"| {key} | {st[key]} |")

    out.append("\n## Reproducible commands\n")
    out.append("```sh\n"
               "python3 -m pip install -r recovery/requirements.txt\n"
               "python3 -m recovery.cli discover --listings      # resumable CDX inventory\n"
               "python3 -m recovery.cli fetch-posts  --limit 50  # permalink/AMP/photoset pages\n"
               "python3 -m recovery.cli fetch-images --limit 20  # images + captions\n"
               "python3 -m recovery.cli publish     --limit 20  # idempotent GHCR push\n"
               "python3 -m recovery.cli status                 # counters\n"
               "python3 -m recovery.cli report                 # regenerate this file\n"
               "```")

    out.append("\n## Methods tried\n")
    out.append("1. **CDX inventory** of `hazfalafel.com/post/*` with `to=20191231235959`, per year window, "
               "so an interrupted run resumes at the next window (`data/captures/posts.jsonl`).\n"
               "2. **Listing/tag/monthly pages** (`/archive/YYYY/MM`, `/tagged/*`, root) for post ids that "
               "have no captured permalink.\n"
               "3. **Permalink → AMP → photoset_iframe** page fallback, replayed with `id_` for raw bytes.\n"
               "4. **Per-image CDX query** for the media URL, then its known size/extension variants "
               "(`_1280`, `_1024`, `_540`, `_500`, `.png`, `.gif`), replayed and validated by magic bytes.\n"
               "5. **Wayback availability API** to distinguish a confirmed archive gap from a timeout or "
               "throttle before recording a missing item.\n"
               "6. **Idempotent publish**: an existing tag is only rewritten when more images were recovered.\n")

    if sample_published:
        out.append("\n## Recently published posts\n")
        out.append("| post id | images | missing | capture | tags |")
        out.append("| --- | --- | --- | --- | --- |")
        for p in sample_published:
            out.append(f"| {p.get('post_id')} | {p.get('image_count', 0)} | {p.get('missing_image_count', 0)} "
                       f"| {p.get('capture_timestamp', '')} | {', '.join((p.get('tags') or [])[:5])} |")

    if ledger:
        out.append("\n## Missing items (ledger)\n")
        out.append("Reasons: " + ", ".join(f"`{k}`={v}" for k, v in reasons.most_common()) + "\n")
        out.append(_fmt_methods(ledger))
        out.append(f"\nFull ledger with every method, URL, capture and error: `{config.MISSING_JSONL}`.")
    else:
        out.append("\n## Missing items\n\nNone recorded yet.\n")

    if published:
        out.append("\n## Publish log tail\n")
        out.append("```json")
        out.append(json.dumps(published[-8:], ensure_ascii=False, indent=1))
        out.append("```")

    out.append("\n## Known constraints\n")
    out.append("- GHCR packages are created private by default; a maintainer must flip the package to "
               "public in the package settings (Settings → General access → Public) once the first tag "
               "is published. Recovery and publishing continue regardless.\n"
               "- Archived `data/blobs/` is gitignored (large image cache); `data/images.jsonl` and "
               "`data/posts/*.json` keep every capture reference needed to refetch or rebuild artifacts.\n"
               "- Workflow edits are rejected for the Actions token, so any runner changes are proposed "
               "in `docs/MAINTAINER_ACTIONS.md`.\n")
    return "\n".join(out) + "\n"


def write_report(path: str = REPORT_PATH) -> dict:
    text = build_report()
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(text)
    os.replace(tmp, path)
    return {"report": path, "bytes": len(text.encode("utf-8"))}
