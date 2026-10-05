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
#
# MIN_REQUEST_INTERVAL was 0.7s with two workers, i.e. ~3 archive requests per
# second. web.archive.org answers that with a *refused TCP connection* within
# minutes, and the refusal lasts far longer than the burst that caused it, so
# the crawler spent whole passes writing identical "transport" rows. Half a
# request per second per worker, serialised by the queue, keeps us under the
# archive's rate limit; the fetcher's circuit breaker stops the rest.
DEFAULT_TIMEOUT = float(os.environ.get("SHURIK_HTTP_TIMEOUT", "90"))
DEFAULT_CONCURRENCY = int(os.environ.get("SHURIK_CONCURRENCY", "2"))
MIN_REQUEST_INTERVAL = float(os.environ.get("SHURIK_MIN_INTERVAL", "2.0"))
MAX_ATTEMPTS = int(os.environ.get("SHURIK_ATTEMPTS", "3"))

# Repository layout (all relative to repo root).
#
# CDX inventories live in data/cdx/ and ARE committed: they are small (a few
# rows per capture) and they are the only durable record of which archive
# captures exist. Ephemeral runner caches (data/captures, data/blobs) are
# ignored by Git and must never be the sole copy of evidence.
DATA_DIR = "data"
CDX_DIR = os.path.join(DATA_DIR, "cdx")
CAPTURE_DIR = os.path.join(DATA_DIR, "captures")
POST_DIR = os.path.join(DATA_DIR, "posts")
BLOB_DIR = os.path.join(DATA_DIR, "blobs")
IMAGES_JSONL = os.path.join(DATA_DIR, "images.jsonl")
MISSING_JSONL = os.path.join(DATA_DIR, "missing.jsonl")
# Durable recovery queue (attempt counts, tried URL variants, cooldowns).
IMAGE_QUEUE_JSON = os.path.join(DATA_DIR, "image-queue.json")
# Anonymous byte-level verification reports for published artifacts.
VERIFY_DIR = os.path.join(DATA_DIR, "verification")
# File-level gap verdicts (one row per media URL; resumable ledger).
GAPS_JSONL = os.path.join(DATA_DIR, "gaps.jsonl")
POSTS_JSONL = os.path.join(DATA_DIR, "posts.jsonl")
PUBLISHED_JSONL = os.path.join(DATA_DIR, "published.jsonl")
CDX_QUERIES_JSON = os.path.join(DATA_DIR, "cdx-queries.json")

# Tumblr media hosts hold post images; avatars/theme art share the hosts too.
MEDIA_HOST_RE = r"(?:^|\.)media\.tumblr\.com$"
