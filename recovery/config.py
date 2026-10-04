"""Shared configuration and constants for the Hazfalafel recovery."""
from __future__ import annotations

import os

# Inclusive Wayback cutoff. Nothing captured after this timestamp may be used.
CUTOFF = "20191231235959"
CUTOFF_COMPACT = "20191231"

ARCHIVE_BASE = "https://web.archive.org"
CDX_URL = f"{ARCHIVE_BASE}/cdx/search/cdx"
REPLAY_BASE = f"{ARCHIVE_BASE}/web"

SITE_HOSTS = ("hazfalafel.com", "www.hazfalafel.com")
TUMBLR_BLOG = "icanhazfalafel"

# Destination OCI package. Tag == numeric Tumblr post id.
GHCR_REPO = os.environ.get("SHURIK_GHCR_REPO", "igor-makarov/shurik-hazfalafel-com")
REGISTRY = "ghcr.io"
PACKAGE_URL = f"{REGISTRY}/{GHCR_REPO}"
REPO_SOURCE_LABEL = "https://github.com/igor-makarov/shurik"

USER_AGENT = os.environ.get(
    "SHURIK_UA",
    "shurik-hazfalafel-recovery/1.0 (+https://github.com/igor-makarov/shurik)",
)

# Network behaviour: archive is slow, be gentle.
DEFAULT_TIMEOUT = float(os.environ.get("SHURIK_HTTP_TIMEOUT", "90"))
DEFAULT_CONCURRENCY = int(os.environ.get("SHURIK_CONCURRENCY", "2"))
MIN_REQUEST_INTERVAL = float(os.environ.get("SHURIK_MIN_INTERVAL", "0.7"))
MAX_ATTEMPTS = int(os.environ.get("SHURIK_ATTEMPTS", "3"))

# Repository layout (all relative to repo root).
DATA_DIR = "data"
CAPTURE_DIR = os.path.join(DATA_DIR, "captures")
POST_DIR = os.path.join(DATA_DIR, "posts")
BLOB_DIR = os.path.join(DATA_DIR, "blobs")
IMAGES_JSONL = os.path.join(DATA_DIR, "images.jsonl")
MISSING_JSONL = os.path.join(DATA_DIR, "missing.jsonl")
POSTS_JSONL = os.path.join(DATA_DIR, "posts.jsonl")
PUBLISHED_JSONL = os.path.join(DATA_DIR, "published.jsonl")
CDX_QUERIES_JSON = os.path.join(DATA_DIR, "cdx-queries.json")

# Tumblr media hosts hold post images; avatars/theme art share the hosts too.
MEDIA_HOST_RE = r"(?:^|\.)media\.tumblr\.com$"
