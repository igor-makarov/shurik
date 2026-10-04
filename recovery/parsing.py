"""Turn an archived Tumblr page into a post record (HTML, text, tags, images).

The parser keeps the *original* inner HTML for post content (found by a balanced
tag scan on the raw response) so Unicode/Hebrew survives byte-for-byte, and
derives a plain-text rendition plus structured image/caption evidence.
"""
from __future__ import annotations

import hashlib
import html as htmllib
import re
from html.parser import HTMLParser
from typing import Iterable, Optional
from urllib.parse import unquote, urlparse

from . import config

VOID_TAGS = {
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
    "param", "source", "track", "wbr",
}

# Class names that hold the post body, in priority order (old then new themes).
CONTENT_SELECTORS = (
    ("div", "copy"),
    ("div", "post-content"),
    ("div", "post_content"),
    ("div", "post-body"),
    ("article", "post-content"),
    ("div", "entry-content"),
)
CAPTION_SELECTORS = (
    ("figcaption", None),
    ("div", "caption"),
    ("p", "caption"),
    ("span", "caption"),
)

EXCLUDE_IMG_HINTS = (
    "avatar", "default_avatar", "impixu", "px.srvcs.tumblr.com", "assets.tumblr.com",
    "fb_share", "addthis", "stat20", "pixel", "tracking", "spacer", "blank.gif",
    "tumblr_avatar", "/images/logo", "gravatar", "b-static", "s24h.ak.tumblr.com",
)

TAGGED_RE = re.compile(r'href="([^"]*?/tagged/[^"?#]+)[^"]*"', re.I)
POST_ID_RE = re.compile(r"/post/(\d+)")
POSTED_TITLE_RE = re.compile(r'title="(Posted on [^"]+)"', re.I)
TIME_RE = re.compile(r'<time[^>]*datetime="([^"]+)"', re.I)
MEDIA_PATH_RE = re.compile(r"/(tumblr_[^/?#]+)\.(jpg|jpeg|png|gif|webp)$", re.I)


# ---------------------------------------------------------------- raw slicing
def _find_open_tag(html: str, tag: str, class_name: Optional[str]) -> Optional[int]:
    """Index of the opening tag for <tag ...> carrying class_name, else None."""
    pattern = re.compile(r"<" + tag + r"\b([^>]*)>", re.I)
    for m in pattern.finditer(html):
        attrs = m.group(1)
        if class_name is None:
            return m.start()
        if re.search(r'class="[^"]*\b' + re.escape(class_name) + r'\b[^"]*"', attrs, re.I):
            return m.start()
    return None


def inner_html(html: str, tag: str, class_name: Optional[str] = None) -> tuple[str, str]:
    """Return (inner_html, outer_start) for the first matching element."""
    start = _find_open_tag(html, tag, class_name)
    if start is None:
        return "", -1
    m = re.match(r"<" + tag + r"\b([^>]*)>", html[start:], re.I)
    if not m:
        return "", -1
    if m.group(0).rstrip().endswith("/>"):
        return "", start
    open_end = start + m.end()
    if class_name is None:
        # For class-less selectors match any tag of that name.
        opener_re = re.compile(r"<" + tag + r"\b([^>]*)>", re.I)
    depth = 1
    pos = open_end
    scan = re.compile(r"<(/?)" + tag + r"\b([^>]*)>", re.I)
    while True:
        m2 = scan.search(html, pos)
        if not m2:
            return html[open_end:], start
        closing = m2.group(1) == "/"
        attrs = m2.group(2)
        self_closing = attrs.rstrip().endswith("/")
        if closing:
            depth -= 1
            if depth == 0:
                return html[open_end:m2.start()], start
            pos = m2.end()
        else:
            if not self_closing and tag.lower() not in VOID_TAGS:
                depth += 1
            pos = m2.end()
        if class_name is not None and not closing:
            # A sibling with a different class does not affect nesting, but an
            # opening tag of the same class at depth 1 is what we track; keep
            # scanning (depth counting above handles it).
            continue


class _TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._skip = 0
        self._skip_tags = {"script", "style"}

    def handle_starttag(self, tag, attrs):
        if tag in self._skip_tags:
            self._skip += 1
        if tag in ("br", "p", "div", "li", "tr"):
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in self._skip_tags and self._skip:
            self._skip -= 1
        if tag in ("p", "div", "li", "tr"):
            self.parts.append("\n")

    def handle_data(self, data):
        if self._skip:
            return
        self.parts.append(data)

    def text(self) -> str:
        raw = "".join(self.parts)
        raw = raw.replace("\r\n", "\n").replace("\r", "\n")
        lines = [re.sub(r"[ \t\u00a0]+", " ", ln).strip() for ln in raw.split("\n")]
        return "\n".join([ln for ln in lines if ln])


def html_to_text(fragment: str) -> str:
    p = _TextExtractor()
    try:
        p.feed(fragment or "")
        p.close()
    except Exception:  # pragma: no cover - malformed archived HTML
        return htmllib.unescape(re.sub(r"<[^>]+>", " ", fragment or ""))
    return p.text()


# -------------------------------------------------------------- URL filtering
def host_of(url: str) -> str:
    try:
        return (urlparse(url if "//" in url else "http://" + url).hostname or "").lower()
    except Exception:
        return ""


def is_tumblr_media(url: str) -> bool:
    return bool(re.search(config.MEDIA_HOST_RE, host_of(url)))


def media_key(url: str) -> Optional[str]:
    """tumblr_<name> plus size/extension: the identity of one Tumblr media file."""
    path = urlparse(url).path
    m = MEDIA_PATH_RE.search(path)
    if not m:
        return None
    return m.group(1) + "." + m.group(2).lower()


def base_media_key(url: str) -> Optional[str]:
    """Identity ignoring the size suffix (_500, _1280, ...)."""
    key = media_key(url)
    if not key:
        return None
    stem, _, ext = key.rpartition(".")
    stem = re.sub(r"_\d{2,4}$", "", stem)
    return stem + "." + ext


def is_excluded_image(url: str, attrs: str = "") -> Optional[str]:
    low = (url or "").lower()
    if not low:
        return "empty-src"
    if "avatar" in low or "default_avatar" in low:
        return "avatar"
    for hint in EXCLUDE_IMG_HINTS:
        if hint in low:
            return "excluded:" + hint
    if re.search(r'\bwidth="1"', attrs) and re.search(r'\bheight="1"', attrs):
        return "tracking-pixel"
    return None


def parse_image_variants(url: str) -> list[str]:
    """Candidate archived variants for one Tumblr media file (larger first)."""
    out = [url]
    m = re.match(r"(?P<stem>tumblr_[^/?#]+?)_(?P<size>\d{2,4})\.(?P<ext>jpg|jpeg|png|gif|webp)$",
                 urlparse(url).path, re.I)
    if not m:
        return out
    stem, ext = m.group("stem"), m.group("ext")
    base = url[: urlparse(url).path.rfind("/") + 1]
    for size in ("1280", "1024", "540", "500", "400", "250", "100"):
        cand = f"{base}{stem}_{size}.{ext}"
        if cand not in out:
            out.append(cand)
    for alt_ext in ("png", "gif", "jpg"):
        if alt_ext == ext.lower():
            continue
        cand = f"{base}{stem}.{alt_ext}"
        if cand not in out:
            out.append(cand)
    return out


# ------------------------------------------------------------------ extraction
class _ImageCollector(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.images: list[dict] = []
        self.links: list[dict] = []
        self._pending: dict | None = None

    def handle_starttag(self, tag, attrs):
        a = {k.lower(): (v or "") for k, v in attrs}
        if tag == "img":
            src = a.get("src") or a.get("data-src") or ""
            entry = {
                "url": src,
                "alt": a.get("alt", ""),
                "title": a.get("title", ""),
                "class": a.get("class", ""),
                "attrs": " ".join(f'{k}="{v}"' for k, v in a.items()),
                "via": "img",
            }
            reason = is_excluded_image(src, entry["attrs"])
            entry["excluded_reason"] = reason
            self.images.append(entry)
            self._pending = entry
        elif tag == "a":
            href = a.get("href", "")
            if href:
                self._pending = {"url": href, "alt": "", "title": a.get("title", ""),
                                 "class": a.get("class", ""), "attrs": "", "via": "a-href",
                                 "excluded_reason": is_excluded_image(href, "")}
                self.links.append(self._pending)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag):
        if tag in ("a", "img"):
            self._pending = None

    def handle_data(self, data):
        if self._pending and data.strip() and self._pending["via"] == "a-href":
            self._pending.setdefault("link_text", data.strip())


def _decode_tag(raw: str) -> str:
    value = unquote(raw)
    return value


def extract_tags(html: str) -> list[str]:
    tags: list[str] = []
    for href in TAGGED_RE.findall(html or ""):
        tag = _decode_tag(href.rsplit("/tagged/", 1)[1].strip("/"))
        tag = htmllib.unescape(tag).strip()
        if tag and tag not in tags:
            tags.append(tag)
    return tags


def extract_images(html: str) -> list[dict]:
    col = _ImageCollector()
    try:
        col.feed(html or "")
        col.close()
    except Exception:  # pragma: no cover
        pass
    og = re.findall(r'<meta[^>]+property="og:image"[^>]+content="([^"]+)"', html or "", re.I)
    ordered: list[dict] = []
    seen: set[str] = set()

    def add(entry: dict, source: str) -> None:
        url = entry.get("url", "")
        if entry.get("excluded_reason"):
            return
        if not is_tumblr_media(url):
            return
        key = media_key(url)
        if not key:
            return
        if key in seen:
            return
        seen.add(key)
        record = {
            "media_url": url,
            "media_key": key,
            "base_key": base_media_key(url),
            "caption_alt": entry.get("alt") or entry.get("title") or "",
            "link_text": entry.get("link_text", ""),
            "found_in": source,
            "variants": parse_image_variants(url),
        }
        ordered.append(record)

    for entry in col.images:
        add(entry, entry.get("via", "img"))
    for entry in col.links:
        if entry.get("url") and is_tumblr_media(entry["url"]):
            add(entry, "photo-link")
    for url in og:
        add({"url": url, "alt": "", "title": "", "excluded_reason": None, "via": "og:image"}, "og:image")
    return ordered


def extract_captions(html: str, images: list[dict]) -> list[str]:
    """Captions that are real evidence: image alt/title, figcaption, caption div."""
    caps: list[str] = []
    for img in images:
        alt = (img.get("caption_alt") or "").strip()
        if alt:
            caps.append(alt)
    for tag, cls in CAPTION_SELECTORS:
        if cls is None:
            continue
        raw, _ = inner_html(html, tag, cls)
        if raw:
            text = html_to_text(raw)
            if text:
                caps.append(text)
    out: list[str] = []
    for c in caps:
        if c and c not in out:
            out.append(c)
    return out


def parse_post_page(html: str, original_url: str, timestamp: str, replay_url: str = "") -> dict:
    """Parse one archived post page into a post record."""
    content_html = ""
    content_source = ""
    outer_start = -1
    for tag, cls in CONTENT_SELECTORS:
        raw, start = inner_html(html, tag, cls)
        if raw and raw.strip():
            content_html, content_source, outer_start = raw, f"{tag}.{cls}", start
            break
    if not content_html:
        post_div, _ = inner_html(html, "div", "post")
        if post_div:
            content_html, content_source = post_div, "div.post"

    images = extract_images(html)
    captions = extract_captions(html, images)
    tags = extract_tags(html)
    posted = POSTED_TITLE_RE.search(html or "")
    posted_on = htmllib.unescape(posted.group(1)) if posted else ""
    dt = TIME_RE.search(html or "")
    date_text = ""
    raw_date, _ = inner_html(html, "div", "date")
    if raw_date:
        date_text = html_to_text(raw_date)
    ids = POST_ID_RE.findall(original_url or "")

    return {
        "post_id": ids[0] if ids else "",
        "original_url": original_url,
        "capture_timestamp": timestamp,
        "replay_url": replay_url or "",
        "page_sha256": hashlib.sha256((html or "").encode("utf-8", "replace")).hexdigest(),
        "page_bytes": len((html or "").encode("utf-8", "replace")),
        "content_html": content_html,
        "content_source": content_source,
        "content_text": html_to_text(content_html) if content_html else "",
        "tags": tags,
        "images": images,
        "captions": captions,
        "posted_on": posted_on,
        "post_datetime": dt.group(1) if dt else "",
        "date_text": date_text,
    }


def post_id_from_url(url: str) -> str:
    m = POST_ID_RE.search(url or "")
    return m.group(1) if m else ""


def merge_records(records: Iterable[dict]) -> dict:
    """Merge several captures of the same post; never downgrade better data."""
    best: Optional[dict] = None
    for rec in records:
        if best is None:
            best = dict(rec)
            continue
        score = record_score(rec)
        if score > record_score(best):
            merged = dict(best)
            merged.update(rec)
            merged["merged_from"] = sorted({best.get("capture_timestamp", ""), rec.get("capture_timestamp", "")})
            best = merged
    return best or {}


def record_score(rec: dict) -> tuple:
    return (
        1 if rec.get("content_text") else 0,
        len(rec.get("content_text") or ""),
        1 if rec.get("images") else 0,
        len(rec.get("images") or []),
        len(rec.get("tags") or []),
        1 if rec.get("captions") else 0,
    )
