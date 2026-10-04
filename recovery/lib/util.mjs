// Small shared helpers: hashing, JSONL persistence, logging, deadlines.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// Inclusive archive cutoff: only captures with timestamp <= this may be used.
export const CUTOFF = '20191231235959';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

export function ensureDir(file) {
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function writeJson(file, value) {
  ensureDir(file);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, file);
}

export function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Append one JSON object per line; crash-safe enough for resumable progress. */
export function appendJsonl(file, record) {
  ensureDir(file);
  appendFileSync(file, `${JSON.stringify(record)}\n`);
}

export function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export const log = (...parts) => {
  process.stderr.write(`${new Date().toISOString()} ${parts.join(' ')}\n`);
};

/** True when a 14-digit Wayback timestamp is inside the allowed window. */
export function isPreCutoff(timestamp) {
  return typeof timestamp === 'string' && /^\d{14}$/.test(timestamp) && timestamp <= CUTOFF;
}

export function assertPreCutoff(timestamp, what = 'capture') {
  if (!isPreCutoff(timestamp)) {
    throw new Error(`refusing ${what}: timestamp ${timestamp} is missing, malformed or after cutoff ${CUTOFF}`);
  }
  return timestamp;
}

/** Parse a Wayback-style redirect target, returning its embedded timestamp. */
export function timestampFromRedirect(location) {
  if (!location) return null;
  const m = /(?:web|https?:\/\/web\.archive\.org)\/(\d{14})/i.exec(String(location));
  return m ? m[1] : null;
}

export function isoFromTimestamp(timestamp) {
  if (!isPreCutoff(timestamp)) return null;
  const iso = `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}T${timestamp.slice(8, 10)}:${timestamp.slice(10, 12)}:${timestamp.slice(12, 14)}Z`;
  return iso;
}
