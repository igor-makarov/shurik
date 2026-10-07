// Configuration for the Nauka i Zhizn (1934-39) scan retrieval task.
//
// Everything here is small, tracked task code. Bulk bytes live outside the
// work branch (git-ignored data/nauka/**) and in GHCR.

import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// The origin percent-encodes the two single quotes and the trailing triple
// quote in the directory name; we keep that exact quoting.
export const INDEX_URL =
  "https://publ.lib.ru/ARCHIVES/N/%27%27Nauka_i_jizn%27%27%27_(jurnal)/_NiJ_1934-39_.html";

export const BASE_URL =
  "https://publ.lib.ru/ARCHIVES/N/%27%27Nauka_i_jizn%27%27%27_(jurnal)/";

// Only this page's own issue sections are in scope (1934-1939). The page also
// carries a generic "archive of this page" directory listing that enumerates
// every year of the journal; that is deliberately excluded.
export const YEARS = [1934, 1935, 1936, 1937, 1938, 1939];

export const REGISTRY = 'ghcr.io/igor-makarov/shurik-nauka';
export const SOURCE_REPO = 'https://github.com/igor-makarov/shurik';
export const ARTIFACT_TYPE = 'application/vnd.shurik.nauka.scan.v1';
export const CHECKPOINT_ARTIFACT_TYPE = 'application/vnd.shurik.nauka.checkpoint.v1';
export const INDEX_TAG = 'nij-1934-39-index';
export const CHECKPOINT_TAG = 'nij-1934-39-checkpoint';

export const CONFIG = {
  // Aggregate origin bandwidth cap. Measured single-connection throughput is
  // ~20 KiB/s, so ~26 parallel connections are needed to reach this cap; the
  // token bucket enforces the aggregate ceiling across the pool.
  bandwidthLimitBps: Number(process.env.NAUKA_BPS || 512 * 1024),
  // Number of simultaneous origin connections (one per chunk).
  maxConcurrency: Number(process.env.NAUKA_CONCURRENCY || 24),
  // Per-chunk size. Bounded so a failed chunk re-download is cheap (~512 KiB at
  // the measured ~20 KiB/s per connection is ~26 s of work).
  chunkSize: Number(process.env.NAUKA_CHUNK || 512 * 1024),
  // Politeness gap between new origin requests (ms).
  requestGapMs: Number(process.env.NAUKA_GAP_MS || 2000),
  // Idle read timeout and total per-attempt timeout.
  idleTimeoutMs: Number(process.env.NAUKA_IDLE_MS || 30000),
  attemptTimeoutMs: Number(process.env.NAUKA_ATTEMPT_MS || 180000),
  // Retry policy for transient failures.
  maxAttemptsPerChunk: Number(process.env.NAUKA_MAX_ATTEMPTS || 6),
  baseBackoffMs: 2000,
  maxBackoffMs: 120000,
  // Bounded wall-clock budget for a single foreground transfer pass.
  passBudgetMs: Number(process.env.NAUKA_PASS_MS || 95 * 1000),
  // Selected partial bytes kept on the control branch. Beyond this we rely on
  // GHCR checkpoint artifacts and keep Git small.
  gitPartialMaxBytesPerFile: 8 * 1024 * 1024,
  gitPartialMaxTotalBytes: 16 * 1024 * 1024,
};

export const PATHS = (() => {
  // The data root is overridable so tests never touch real task state.
  const root = process.env.NAUKA_DATA_DIR
    ? path.resolve(process.env.NAUKA_DATA_DIR)
    : path.join(REPO_ROOT, 'data/nauka');
  return {
    dataRoot: root,
    stateDir: path.join(root, 'state'),
    partialDir: path.join(root, 'partials'),
    stagingDir: path.join(root, 'staging'),
  };
})();

// ---------------------------------------------------------------------------
// URL quoting
// ---------------------------------------------------------------------------

// RFC 3986 unreserved + sub-delims that are safe unescaped in a path segment.
const SAFE = new Set(
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~!$&'()*+,;=:@".split(''),
);

// Percent-encode a single path segment (filename). This handles the quote
// characters, brackets and commas in the archive filenames exactly once.
export function encodeSegment(segment) {
  let out = '';
  for (const ch of segment) {
    if (SAFE.has(ch)) {
      out += ch;
    } else {
      const bytes = Buffer.from(ch, 'utf8');
      for (const b of bytes) out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
    }
  }
  return out;
}

// Resolve an href from the index page against the page directory.
export function resolveScanUrl(href) {
  // hrefs on this page are plain relative filenames.
  const clean = href.replace(/^\.\//, '');
  return BASE_URL + encodeSegment(clean);
}

// ---------------------------------------------------------------------------
// Stable ids and tags
// ---------------------------------------------------------------------------

export function entryId({ year, issue, format }) {
  const norm = String(issue).toLowerCase().replace(/[^a-z0-9]+/g, '');
  return `nij-${year}-${norm}-${format}`;
}

export function entryTag(entry) {
  return entryId(entry).toLowerCase();
}

export function checkpointTag(id) {
  return `checkpoint-${id}`;
}
