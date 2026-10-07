// Retrieval engine: durable state, chunked resumable downloads, assembly,
// GHCR publication and round-trip verification.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { CONFIG, PATHS, REGISTRY, entryTag, checkpointTag, ARTIFACT_TYPE } from './config.mjs';
import {
  httpGetToFile,
  createRateLimiter,
  sleep,
  jitter,
  TransientError,
  RangeIgnoredError,
  RangeMismatchError,
  RangeNotSatisfiableError,
} from './http.mjs';

const STATE_FILE = path.join(PATHS.stateDir, 'files.json');
const PARTIAL_INDEX = path.join(PATHS.partialDir, 'partial-index.json');
const EVIDENCE_DIR = path.join(PATHS.stateDir, 'evidence');

export function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const stream = require('node:fs').createReadStream(p);
    stream.on('data', (d) => h.update(d));
    stream.on('end', () => resolve(h.digest('hex')));
    stream.on('error', reject);
  });
}

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

export function sha256Buf(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export async function atomicWriteFile(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, file);
}

export async function atomicWriteJson(file, obj) {
  await atomicWriteFile(file, JSON.stringify(obj, null, 2) + '\n');
}

export async function loadJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export async function loadState() {
  const s = await loadJson(STATE_FILE, null);
  if (!s) return { version: 1, files: {}, updatedAt: null };
  return s;
}

export async function saveState(state) {
  state.updatedAt = new Date().toISOString();
  await atomicWriteJson(STATE_FILE, state);
}

export function ensureFileEntry(state, entry) {
  let e = state.files[entry.id];
  if (!e) {
    e = {
      id: entry.id,
      year: entry.year,
      issue: entry.issue,
      format: entry.format,
      filename: entry.filename,
      url: entry.url,
      labelText: entry.labelText,
      labelSize: entry.labelSize,
      expectedBytes: null,
      etag: null,
      lastModified: null,
      chunkSize: CONFIG.chunkSize,
      chunks: {},
      receivedBytes: 0,
      status: 'pending',
      attempts: 0,
      retries: 0,
      lastError: null,
      lastErrorAt: null,
      ghcr: null,
      checkpoint: null,
      validator: null,
      updatedAt: new Date().toISOString(),
    };
    state.files[entry.id] = e;
  }
  return e;
}

function chunkName(i) {
  return `chunk-${String(i).padStart(6, '0')}`;
}
export function workspaceDir(id) {
  return path.join(PATHS.stagingDir, id);
}
function chunkPath(id, i) {
  return path.join(workspaceDir(id), chunkName(i));
}

// ---------------------------------------------------------------------------
// Manifest / evidence
// ---------------------------------------------------------------------------

export async function loadManifest() {
  return loadJson(path.join(PATHS.stateDir, 'manifest.json'), null);
}

export async function saveManifest(manifest) {
  await atomicWriteJson(path.join(PATHS.stateDir, 'manifest.json'), manifest);
}

export async function saveIndexEvidence(rawBuf, meta) {
  await fs.mkdir(EVIDENCE_DIR, { recursive: true });
  await atomicWriteFile(path.join(EVIDENCE_DIR, 'index.cp1251.html'), rawBuf);
  await atomicWriteJson(path.join(EVIDENCE_DIR, 'index.meta.json'), meta);
}

// ---------------------------------------------------------------------------
// Chunk download with retries
// ---------------------------------------------------------------------------

// Global request-start gate to keep >= requestGapMs between origin requests.
let lastRequestStart = 0;
async function politeGate() {
  const now = Date.now();
  const wait = lastRequestStart + CONFIG.requestGapMs - now;
  lastRequestStart = Math.max(now, lastRequestStart + CONFIG.requestGapMs);
  if (wait > 0) await sleep(wait);
}

export async function downloadChunk(ctx, entry, eff, chunk, { attempt } = {}) {
  const { limiter, log } = ctx;
  const start = chunk * eff.chunkSize;
  const end = Math.min(start + eff.chunkSize - 1, (eff.expectedBytes ?? Infinity) - 1);
  const dest = chunkPath(eff.id, chunk);
  const tmp = `${dest}.tmp`;
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const ifRange = eff.etag || eff.lastModified || null;

  await politeGate();
  const meta = await httpGetToFile(eff.url, {
    destTmp: tmp,
    start: eff.expectedBytes && start === 0 && eff.chunks[0] ? 0 : start,
    end: Number.isFinite(end) ? end : null,
    ifRange,
    limiter,
    idleTimeoutMs: CONFIG.idleTimeoutMs,
    attemptTimeoutMs: CONFIG.attemptTimeoutMs,
  });

  // Validator changed beneath us -> restart the whole file.
  if (eff.etag && meta.etag && meta.etag !== eff.etag) {
    await fs.rm(tmp, { force: true });
    const err = new Error('validator (ETag) changed');
    err.validatorChanged = true;
    throw err;
  }

  let total = eff.expectedBytes;
  let bytes = meta.bytesWritten;
  if (meta.contentRange && meta.contentRange.total != null) total = meta.contentRange.total;
  if (meta.status === 200) {
    // Whole body returned (range ignored or first request). total falls back to
    // Content-Length.
    if (meta.contentLength != null && (total == null || meta.contentLength === total || start === 0)) {
      total = meta.contentLength;
    }
  }
  if (total == null) {
    await fs.rm(tmp, { force: true });
    throw new TransientError('no total size available (server without Content-Length)');
  }
  eff.expectedBytes = total;

  const expectedThis = meta.status === 200 ? total : Math.min(eff.chunkSize, total - start);
  if (bytes !== expectedThis) {
    await fs.rm(tmp, { force: true });
    throw new TransientError(`short body ${bytes}/${expectedThis}`);
  }
  const hash = await sha256File(tmp);
  await fs.rename(tmp, dest);
  return { bytes, sha256: hash, total, etag: meta.etag || eff.etag, lastModified: meta.lastModified || eff.lastModified, status: meta.status };
}

// Download one file's chunks with a global concurrency pool and retries.
export async function downloadFile(ctx, entry) {
  const { state, log, pool } = ctx;
  const eff = ensureFileEntry(state, entry);
  if (eff.status === 'published') return { done: true };
  eff.status = 'in_progress';

  // First chunk establishes the total size (or the whole body when the server
  // ignores Range).
  if (eff.expectedBytes == null || !eff.chunks[0]) {
    await withRetries(ctx, eff, 0, (attempt) => downloadChunk(ctx, entry, eff, 0, { attempt }));
    await saveState(state);
  }

  const total = eff.expectedBytes;
  const nChunks = Math.max(1, Math.ceil(total / eff.chunkSize));

  const tasks = [];
  for (let i = 0; i < nChunks; i++) {
    if (eff.chunks[i] && (await fileValid(eff.id, i, eff.chunks[i]))) continue;
    tasks.push(i);
  }
  await Promise.all(
    tasks.map((i) =>
      pool.run(async () => {
        try {
          const info = await withRetries(ctx, eff, i, (attempt) => downloadChunk(ctx, entry, eff, i, { attempt }));
          eff.chunks[i] = { bytes: info.bytes, sha256: info.sha256 };
          eff.expectedBytes = info.total ?? eff.expectedBytes;
          eff.etag = info.etag || eff.etag;
          eff.lastModified = info.lastModified || eff.lastModified;
          eff.receivedBytes = Object.values(eff.chunks).reduce((a, c) => a + c.bytes, 0);
          await saveState(state);
        } catch (err) {
          handleFileError(eff, err);
          await saveState(state);
          throw err;
        }
      }),
    ),
  ).catch((err) => {
    if (err && (err.validatorChanged || err.rangeIgnored)) {
      // handled by caller; swallow to let pass continue with other files
    } else if (err && err.permanent) {
      /* recorded */
    } else {
      throw err;
    }
  });

  const have = Object.keys(eff.chunks).length;
  if (have >= nChunks) {
    eff.receivedBytes = Object.values(eff.chunks).reduce((a, c) => a + c.bytes, 0);
    return { done: true };
  }
  return { done: false };
}

async function fileValid(id, i, info) {
  const p = chunkPath(id, i);
  try {
    const st = await fs.stat(p);
    if (st.size !== info.bytes) return false;
    const h = await sha256File(p);
    return h === info.sha256;
  } catch {
    return false;
  }
}

async function withRetries(ctx, eff, chunkIndex, fn) {
  let attempt = 0;
  let backoff = CONFIG.baseBackoffMs;
  for (;;) {
    attempt++;
    eff.attempts++;
    try {
      return await fn(attempt);
    } catch (err) {
      eff.lastError = err.message;
      eff.lastErrorAt = new Date().toISOString();
      if (err.validatorChanged || err.rangeIgnored || err.permanent || err.rangeNotSatisfiable) {
        throw err;
      }
      eff.retries++;
      if (attempt >= CONFIG.maxAttemptsPerChunk) {
        throw err;
      }
      let wait = err.retryAfterMs != null ? err.retryAfterMs : backoff;
      wait = Math.max(wait, CONFIG.requestGapMs);
      ctx.log(`retry chunk ${chunkIndex} of ${eff.id} attempt ${attempt}: ${err.message} (wait ${Math.round(wait)}ms)`);
      await sleep(jitter(wait));
      backoff = Math.min(CONFIG.maxBackoffMs, backoff * 2);
      // Reduce speed after repeated failures.
      if (eff.retries % 3 === 0 && CONFIG.bandwidthLimitBps > 64 * 1024) {
        ctx.reportThrottle?.(eff.retries);
      }
    }
  }
}

function handleFileError(eff, err) {
  if (err.validatorChanged) {
    eff.chunks = {};
    eff.receivedBytes = 0;
    eff.etag = null;
    eff.lastModified = null;
    eff.status = 'pending';
  } else if (err.rangeIgnored) {
    eff.chunks = {};
    eff.receivedBytes = 0;
    eff.status = 'pending';
  } else if (err.permanent) {
    eff.status = 'unavailable';
  } else {
    eff.status = 'pending';
  }
}

// ---------------------------------------------------------------------------
// Assembly + publication
// ---------------------------------------------------------------------------

export async function assembleHex(eff) {
  const h = createHash('sha256');
  let bytes = 0;
  const n = Math.ceil(eff.expectedBytes / eff.chunkSize);
  for (let i = 0; i < n; i++) {
    const info = eff.chunks[i];
    if (!info) throw new Error(`missing chunk ${i} for ${eff.id}`);
    const buf = await fs.readFile(chunkPath(eff.id, i));
    if (buf.length !== info.bytes) throw new Error(`chunk ${i} length mismatch`);
    h.update(buf);
    bytes += buf.length;
  }
  return { sha256: h.digest('hex'), bytes };
}

export async function assembleToFile(eff, dest) {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const out = await fs.open(dest, 'w');
  try {
    const n = Math.ceil(eff.expectedBytes / eff.chunkSize);
    for (let i = 0; i < n; i++) {
      const info = eff.chunks[i];
      const buf = await fs.readFile(chunkPath(eff.id, i));
      if (buf.length !== info.bytes) throw new Error(`chunk ${i} length mismatch`);
      await out.write(buf);
    }
  } finally {
    await out.close();
  }
}

export async function publishFile(ctx, entry) {
  const { state, ghcr, log } = ctx;
  const eff = ensureFileEntry(state, entry);
  const tag = entryTag(entry);
  const dir = workspaceDir(eff.id);
  const work = path.join(dir, `upload-${eff.id}.bin`);

  const { sha256, bytes } = await assembleHex(eff);
  await assembleToFile(eff, work);

  log(`publishing ${eff.id} (${bytes} bytes, ${sha256.slice(0, 12)}) as ${tag}`);
  const push = await ghcr.pushFile(tag, work, {
    title: eff.filename,
    annotations: {
      'org.opencontainers.image.title': eff.filename,
      'shurik.nauka.year': String(eff.year),
      'shurik.nauka.issue': eff.issue,
      'shurik.nauka.format': eff.format,
      'shurik.nauka.sha256': sha256,
      'shurik.nauka.source-url': eff.url,
      'shurik.nauka.index-url': ctx.manifest.indexUrl,
    },
  });

  eff.sha256 = sha256;
  eff.expectedBytes = bytes;
  eff.ghcr = { tag, digest: push.digest, title: eff.filename, pushedAt: new Date().toISOString() };
  eff.status = 'published';
  eff.publishedAt = new Date().toISOString();
  await saveState(state);

  // Round-trip verification: pull it back and compare bytes.
  const verifyDir = path.join(PATHS.stagingDir, 'verify', eff.id);
  await fs.rm(verifyDir, { recursive: true, force: true });
  await ghcr.pull(tag, verifyDir);
  const pulled = path.join(verifyDir, path.basename(work));
  const pulledHash = await sha256File(pulled);
  const ok = pulledHash === sha256;
  eff.verified = { at: new Date().toISOString(), pulledSha256: pulledHash, ok, digest: push.digest };
  eff.lastError = ok ? null : 'round-trip verification mismatch';
  await fs.rm(verifyDir, { recursive: true, force: true });
  if (!ok) {
    eff.status = 'in_progress';
    throw new Error(`round-trip verification failed for ${eff.id}`);
  }
  // Cleanup local bytes and checkpoint.
  await fs.rm(dir, { recursive: true, force: true });
  await clearGitPartial(eff.id);
  await saveState(state);
  log(`verified ${eff.id}: ${sha256}`);
  return { sha256, bytes, digest: push.digest, tag };
}

async function clearGitPartial(id) {
  await fs.rm(path.join(PATHS.partialDir, `${id}.prefix`), { force: true });
}

// ---------------------------------------------------------------------------
// Durable checkpoints
// ---------------------------------------------------------------------------

// Push in-progress chunk workspaces to GHCR and record selected small prefixes
// on the control-branch partial path.
export async function checkpointPartials(ctx) {
  const { state, ghcr, log } = ctx;
  const inProgress = Object.values(state.files).filter(
    (e) => e.status === 'in_progress' && Object.keys(e.chunks).length > 0,
  );

  // 1) Selected small prefixes for the control branch.
  await fs.mkdir(PATHS.partialDir, { recursive: true });
  const partialIndex = { version: 1, updatedAt: new Date().toISOString(), partials: {} };
  let budget = CONFIG.gitPartialMaxTotalBytes;
  for (const eff of inProgress) {
    if (budget <= 0) break;
    const prefix = await buildContiguousPrefix(eff.id, eff.chunks, eff.chunkSize);
    if (!prefix || prefix.bytes === 0) continue;
    const cap = Math.min(prefix.bytes, CONFIG.gitPartialMaxBytesPerFile, budget);
    const buf = prefix.buffer.subarray(0, cap);
    const file = path.join(PATHS.partialDir, `${eff.id}.prefix`);
    await atomicWriteFile(file, buf);
    partialIndex.partials[eff.id] = {
      bytes: buf.length,
      sha256: sha256Buf(buf),
      chunkSize: eff.chunkSize,
      at: new Date().toISOString(),
    };
    budget -= buf.length;
  }
  await atomicWriteJson(PARTIAL_INDEX, partialIndex);

  // 2) Full chunk workspaces to GHCR checkpoint artifacts.
  for (const eff of inProgress) {
    const dir = workspaceDir(eff.id);
    let entries = [];
    try {
      entries = (await fs.readdir(dir)).filter((f) => f.startsWith('chunk-'));
    } catch {
      continue;
    }
    if (entries.length === 0) continue;
    // remove temp files so they never get pushed
    for (const f of await fs.readdir(dir)) if (f.endsWith('.tmp')) await fs.rm(path.join(dir, f), { force: true });
    const bytes = (
      await Promise.all(entries.map(async (f) => (await fs.stat(path.join(dir, f))).size))
    ).reduce((a, b) => a + b, 0);
    if (eff.checkpoint && eff.checkpoint.bytes === bytes) continue; // unchanged
    try {
      const res = await ghcr.pushDir(checkpointTag(eff.id), dir);
      eff.checkpoint = { digest: res.digest, bytes, at: new Date().toISOString() };
      log(`checkpointed ${eff.id} (${bytes} bytes) -> ${res.digest}`);
    } catch (err) {
      log(`checkpoint push failed for ${eff.id}: ${err.message}`);
    }
    await saveState(state);
  }
  return partialIndex;
}

async function buildContiguousPrefix(id, chunks, chunkSize) {
  const parts = [];
  let bytes = 0;
  for (let i = 0; ; i++) {
    if (!chunks[i]) break;
    const buf = await fs.readFile(chunkPath(id, i)).catch(() => null);
    if (!buf) break;
    if (buf.length !== chunks[i].bytes) break;
    if (sha256Buf(buf) !== chunks[i].sha256) break;
    parts.push(buf);
    bytes += buf.length;
  }
  if (parts.length === 0) return null;
  return { buffer: Buffer.concat(parts), bytes, chunkCount: parts.length };
}

export async function restoreFromGitPartials(state, log = () => {}) {
  const idx = await loadJson(PARTIAL_INDEX, null);
  if (!idx) return;
  for (const [id, info] of Object.entries(idx.partials || {})) {
    const eff = state.files[id];
    if (!eff || eff.status === 'published') continue;
    const file = path.join(PATHS.partialDir, `${id}.prefix`);
    let buf;
    try {
      buf = await fs.readFile(file);
    } catch {
      continue;
    }
    if (buf.length !== info.bytes || sha256Buf(buf) !== info.sha256) {
      log(`ignoring torn git partial for ${id}`);
      continue;
    }
    const nChunks = Math.floor(buf.length / info.chunkSize) + (buf.length % info.chunkSize ? 1 : 0);
    for (let i = 0; i < nChunks; i++) {
      const start = i * info.chunkSize;
      const chunkBuf = buf.subarray(start, Math.min(start + info.chunkSize, buf.length));
      const info2 = eff.chunks[i];
      if (!info2) continue;
      if (chunkBuf.length !== info2.bytes) continue;
      if (sha256Buf(chunkBuf) !== info2.sha256) continue;
      const dest = chunkPath(id, i);
      try {
        const st = await fs.stat(dest);
        if (st.size === chunkBuf.length) continue;
      } catch {
        /* missing */
      }
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await atomicWriteFile(dest, chunkBuf);
      log(`restored chunk ${i} of ${id} from git partial`);
    }
  }
}

export async function restoreFromCheckpoints(ctx) {
  const { state, ghcr, log } = ctx;
  for (const eff of Object.values(state.files)) {
    if (eff.status === 'published') continue;
    if (!eff.checkpoint || !eff.checkpoint.digest) continue;
    const dir = workspaceDir(eff.id);
    let missing = false;
    for (const i of Object.keys(eff.chunks)) {
      if (!(await fileValid(eff.id, Number(i), eff.chunks[i]))) {
        missing = true;
        break;
      }
    }
    if (!missing) continue;
    log(`restoring ${eff.id} from GHCR checkpoint ${eff.checkpoint.digest}`);
    try {
      await ghcr.pull(checkpointTag(eff.id), dir);
    } catch (err) {
      log(`checkpoint pull failed for ${eff.id}: ${err.message}`);
      continue;
    }
    // verify restored chunks against state
    for (const i of Object.keys(eff.chunks)) {
      const ok = await fileValid(eff.id, Number(i), eff.chunks[i]);
      if (!ok) {
        await fs.rm(chunkPath(eff.id, Number(i)), { force: true });
        delete eff.chunks[i];
      }
    }
    eff.receivedBytes = Object.values(eff.chunks).reduce((a, c) => a + c.bytes, 0);
    await saveState(state);
  }
}

// ---------------------------------------------------------------------------
// Concurrency pool + pass runner
// ---------------------------------------------------------------------------

export function createPool(size) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= size || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active--;
        next();
      });
  };
  return {
    run(fn) {
      return new Promise((resolve, reject) => {
        queue.push({ fn, resolve, reject });
        next();
      });
    },
    get active() {
      return active;
    },
  };
}

export function orderEntries(entries, state) {
  const arr = [...entries];
  arr.sort((a, b) => {
    const ea = state.files[a.id];
    const eb = state.files[b.id];
    if (ea && ea.status === 'published' && !(eb && eb.status === 'published')) return 1;
    if (eb && eb.status === 'published' && !(ea && ea.status === 'published')) return -1;
    const sa = (ea && ea.expectedBytes) || estimateBytes(a.labelSize) || 1e12;
    const sb = (eb && eb.expectedBytes) || estimateBytes(b.labelSize) || 1e12;
    return sa - sb;
  });
  return arr;
}

export function estimateBytes(labelSize) {
  const m = /(\d+(?:\.\d+)?)\s*M/i.exec(labelSize || '');
  return m ? Math.round(Number(m[1]) * 1024 * 1024) : null;
}

export async function runPass(ctx) {
  const { state, manifest, log } = ctx;
  const deadline = Date.now() + CONFIG.passBudgetMs;
  const ordered = orderEntries(manifest.entries, state);
  const results = [];
  for (const entry of ordered) {
    if (Date.now() >= deadline) break;
    const eff = ensureFileEntry(state, entry);
    if (eff.status === 'published') continue;
    if (eff.status === 'unavailable') continue;
    ctx.log(`-- file ${eff.id} (${eff.labelSize}) --`);
    try {
      const r = await downloadFile(ctx, entry);
      if (r.done) {
        const pub = await publishFile(ctx, entry);
        results.push({ id: eff.id, status: 'published', ...pub });
      } else {
        results.push({ id: eff.id, status: 'in_progress', received: eff.receivedBytes });
      }
    } catch (err) {
      ctx.log(`file ${eff.id} error: ${err.message}`);
      results.push({ id: eff.id, status: eff.status, error: err.message });
      if (err.validatorChanged || err.rangeIgnored) {
        // reset and let a later pass retry cleanly
        await saveState(state);
      }
    }
  }
  await checkpointPartials(ctx);
  await saveState(state);
  return results;
}
