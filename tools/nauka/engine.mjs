// Retrieval engine: durable state, chunked resumable downloads, assembly,
// GHCR publication and round-trip verification.

import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { CONFIG, PATHS, REGISTRY, entryTag, checkpointTag } from './config.mjs';
import { httpGetToFile, createRateLimiter, sleep, jitter, TransientError, abortError } from './http.mjs';

const STATE_FILE = path.join(PATHS.stateDir, 'files.json');
const PARTIAL_INDEX = path.join(PATHS.partialDir, 'partial-index.json');
const EVIDENCE_DIR = path.join(PATHS.stateDir, 'evidence');

export function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const stream = createReadStream(p);
    stream.on('data', (d) => h.update(d));
    stream.on('end', () => resolve(h.digest('hex')));
    stream.on('error', reject);
  });
}

export function sha256Buf(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export async function atomicWriteFile(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

let saveChain = Promise.resolve();
export async function saveState(state) {
  state.updatedAt = new Date().toISOString();
  const snapshot = JSON.stringify(state, null, 2) + '\n';
  saveChain = saveChain.then(() => atomicWriteFile(STATE_FILE, snapshot)).catch(() => {});
  return saveChain;
}
export async function flushState() {
  await saveChain.catch(() => {});
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
      singleRequest: false,
      chunkSize: CONFIG.chunkSize,
      chunks: {},
      receivedBytes: 0,
      status: 'pending',
      gen: 0,
      attempts: 0,
      retries: 0,
      lastError: null,
      lastErrorAt: null,
      ghcr: null,
      checkpoint: null,
      verified: null,
      updatedAt: new Date().toISOString(),
    };
    state.files[entry.id] = e;
  } else if (e.status !== 'published' && Object.keys(e.chunks || {}).length === 0) {
    // Untouched entry: let a config/chunk-size change take effect. Entries with
    // bytes already on disk keep their size so recorded chunk hashes stay valid.
    e.chunkSize = CONFIG.chunkSize;
    if (e.expectedBytes == null) e.singleRequest = false;
  }
  return e;
}

function chunkName(i) {
  return `chunk-${String(i).padStart(6, '0')}`;
}
export function workspaceDir(id) {
  return path.join(PATHS.stagingDir, id);
}
export function chunksDir(id) {
  return path.join(workspaceDir(id), 'chunks');
}
function chunkPath(id, i) {
  return path.join(chunksDir(id), chunkName(i));
}
export function chunkCount(eff) {
  if (!eff.expectedBytes) return 0;
  if (eff.chunks[0] && eff.chunks[0].bytes >= eff.expectedBytes) return 1;
  return Math.ceil(eff.expectedBytes / eff.chunkSize);
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

let lastRequestStart = 0;
async function politeGate() {
  const now = Date.now();
  const at = Math.max(now, lastRequestStart + CONFIG.requestGapMs);
  lastRequestStart = at;
  if (at > now) await sleep(at - now);
}

// Remaining wall-clock budget for the current bounded foreground invocation.
function remainingMs(ctx) {
  if (!ctx || !ctx.deadline) return Infinity;
  return ctx.deadline - Date.now();
}
function attemptBudget(ctx, base) {
  const rem = remainingMs(ctx);
  if (!Number.isFinite(rem)) return base;
  return Math.max(1500, Math.min(base, rem));
}
function isStopped(ctx) {
  if (!ctx) return false;
  if (ctx.signal && ctx.signal.aborted) return true;
  return remainingMs(ctx) <= 0;
}

async function downloadChunkOnce(ctx, entry, eff, chunk, effGen) {
  const start = chunk * eff.chunkSize;
  const end =
    eff.expectedBytes != null ? Math.min(start + eff.chunkSize - 1, eff.expectedBytes - 1) : start + eff.chunkSize - 1;
  const dest = chunkPath(eff.id, chunk);
  const tmp = `${dest}.tmp`;
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const ifRange = eff.etag || eff.lastModified || null;
  if (isStopped(ctx)) throw abortError();

  await politeGate();
  let meta;
  try {
    meta = await httpGetToFile(eff.url, {
      destTmp: tmp,
      start,
      end,
      ifRange,
      limiter: ctx.limiter,
      signal: ctx.signal,
      idleTimeoutMs: attemptBudget(ctx, CONFIG.idleTimeoutMs),
      attemptTimeoutMs: attemptBudget(ctx, CONFIG.attemptTimeoutMs),
    });
  } catch (err) {
    // An If-Range mismatch makes the server send the full entity (200). That is
    // a validator change, not a plain ignored Range; reset and refetch.
    if (err.rangeIgnored && ifRange) {
      await fs.rm(tmp, { force: true });
      const e = new Error('validator changed (If-Range mismatch: server sent full body)');
      e.validatorChanged = true;
      throw e;
    }
    await fs.rm(tmp, { force: true });
    throw err;
  }

  if (effGen !== undefined && eff.gen !== effGen) {
    await fs.rm(tmp, { force: true });
    const err = new Error('file reset during download');
    err.aborted = true;
    throw err;
  }
  if (eff.etag && meta.etag && meta.etag !== eff.etag) {
    await fs.rm(tmp, { force: true });
    const err = new Error('validator (ETag) changed');
    err.validatorChanged = true;
    throw err;
  }

  let total = eff.expectedBytes;
  if (meta.contentRange && meta.contentRange.total != null) total = meta.contentRange.total;
  if (meta.status === 200 && meta.contentLength != null) total = meta.contentLength;
  if (total == null) {
    await fs.rm(tmp, { force: true });
    throw new TransientError('no total size available (server without validators)');
  }

  const expectedThis = meta.status === 200 ? total : Math.min(eff.chunkSize, total - start);
  if (meta.bytesWritten !== expectedThis) {
    await fs.rm(tmp, { force: true });
    throw new TransientError(`short body ${meta.bytesWritten}/${expectedThis}`);
  }
  const hash = await sha256File(tmp);
  await fs.rename(tmp, dest);
  return {
    bytes: meta.bytesWritten,
    sha256: hash,
    total,
    etag: meta.etag || eff.etag,
    lastModified: meta.lastModified || eff.lastModified,
    wholeBody: meta.status === 200,
  };
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
      if (err.validatorChanged || err.aborted || err.rangeIgnored || err.permanent || err.rangeNotSatisfiable) throw err;
      eff.retries++;
      if (attempt >= CONFIG.maxAttemptsPerChunk) throw err;
      if (isStopped(ctx)) throw abortError('batch budget exhausted during retry');
      let wait = err.retryAfterMs != null ? err.retryAfterMs : backoff;
      wait = Math.max(wait, CONFIG.requestGapMs);
      ctx.log(`retry ${eff.id} chunk ${chunkIndex} #${attempt}: ${err.message} (wait ${Math.round(wait)}ms)`);
      await sleep(jitter(wait));
      backoff = Math.min(CONFIG.maxBackoffMs, backoff * 2);
    }
  }
}

function applyChunkResult(eff, i, info, effGen) {
  if (effGen !== undefined && eff.gen !== effGen) return false;
  eff.chunks[i] = { bytes: info.bytes, sha256: info.sha256 };
  eff.expectedBytes = info.total ?? eff.expectedBytes;
  eff.etag = info.etag || eff.etag;
  eff.lastModified = info.lastModified || eff.lastModified;
  eff.receivedBytes = Object.values(eff.chunks).reduce((a, c) => a + c.bytes, 0);
  eff.cleanupPasses = 0;
  return true;
}

function resetForRetry(eff, reason) {
  eff.chunks = {};
  eff.receivedBytes = 0;
  eff.gen = (eff.gen || 0) + 1;
  if (reason === 'validatorChanged' || reason === 'rangeIgnored') {
    eff.etag = null;
    eff.lastModified = null;
  }
  eff.status = 'pending';
  eff.lastError = reason;
}

// Cheap 1-byte ranged GET to learn the entity size (and validators) without
// paying the ~50 s cost of downloading a full first chunk. Falls back to
// Content-Length for a 200 response (server that ignores Range).
async function probeTotal(ctx, entry, eff, effGen) {
  const ifRange = eff.etag || eff.lastModified || null;
  if (isStopped(ctx)) throw abortError();
  await politeGate();
  const meta = await httpGetToFile(eff.url, {
    metaOnly: true,
    start: 0,
    end: 0,
    ifRange,
    signal: ctx.signal,
    idleTimeoutMs: attemptBudget(ctx, CONFIG.idleTimeoutMs),
    attemptTimeoutMs: attemptBudget(ctx, CONFIG.attemptTimeoutMs),
  });
  if (effGen !== undefined && eff.gen !== effGen) {
    const err = new Error('file reset during probe');
    err.aborted = true;
    throw err;
  }
  if (eff.etag && meta.etag && meta.etag !== eff.etag) {
    const err = new Error('validator (ETag) changed');
    err.validatorChanged = true;
    throw err;
  }
  let total = null;
  if (meta.contentRange && meta.contentRange.total != null) total = meta.contentRange.total;
  else if (meta.status === 200 && meta.contentLength != null) total = meta.contentLength;
  if (total == null) throw new TransientError('no total size available (no Content-Range/Content-Length)');
  return { total, etag: meta.etag, lastModified: meta.lastModified, status: meta.status };
}

// Single whole-body fetch (used when the server ignores Range).
async function downloadWhole(ctx, entry, eff, effGen) {
  const dest = chunkPath(eff.id, 0);
  const tmp = `${dest}.tmp`;
  await fs.mkdir(path.dirname(dest), { recursive: true });
  if (isStopped(ctx)) throw abortError();
  await politeGate();
  const meta = await httpGetToFile(eff.url, {
    destTmp: tmp,
    start: 0,
    end: null,
    limiter: ctx.limiter,
    signal: ctx.signal,
    idleTimeoutMs: attemptBudget(ctx, CONFIG.idleTimeoutMs),
    attemptTimeoutMs: attemptBudget(ctx, CONFIG.attemptTimeoutMs * 10),
  });
  if (effGen !== undefined && eff.gen !== effGen) {
    await fs.rm(tmp, { force: true });
    const err = new Error('file reset during download');
    err.aborted = true;
    throw err;
  }
  const bytes = meta.bytesWritten;
  const total = meta.contentLength != null ? meta.contentLength : bytes;
  if (bytes !== total) {
    await fs.rm(tmp, { force: true });
    throw new TransientError(`short whole body ${bytes}/${total}`);
  }
  const hash = await sha256File(tmp);
  await fs.rename(tmp, dest);
  return { bytes, sha256: hash, total, etag: meta.etag || eff.etag, lastModified: meta.lastModified || eff.lastModified };
}

function preserveOnAbort(eff, err) {
  // Ordinary cancellation must NOT discard verified chunks. Only a validator
  // change may reset progress. Keep whatever bytes are on disk and durable.
  const hasChunks = Object.keys(eff.chunks || {}).length > 0;
  eff.status = hasChunks ? 'in_progress' : 'pending';
  eff.receivedBytes = Object.values(eff.chunks || {}).reduce((a, c) => a + c.bytes, 0);
  if (err && !eff.lastError) eff.lastError = err.message;
}

function classifyError(eff, err) {
  if (err.validatorChanged) {
    resetForRetry(eff, 'validatorChanged');
  } else if (err.rangeIgnored) {
    resetForRetry(eff, 'rangeIgnored');
  } else if (err.aborted) {
    preserveOnAbort(eff, err);
  } else if (err.permanent) {
    eff.status = 'unavailable';
  }
}

export async function downloadFile(ctx, entry) {
  const { state, pool } = ctx;
  const eff = ensureFileEntry(state, entry);
  if (eff.status === 'published') return { done: true };
  if (isStopped(ctx)) return { done: false, budget: true };
  eff.status = 'in_progress';
  const gen = eff.gen;

  // Learn the entity size with a tiny ranged probe instead of a full first chunk.
  if (eff.expectedBytes == null) {
    try {
      const p = await withRetries(ctx, eff, 0, () => probeTotal(ctx, entry, eff, gen));
      eff.expectedBytes = p.total;
      if (p.etag) eff.etag = p.etag;
      if (p.lastModified) eff.lastModified = p.lastModified;
      if (p.status === 200) eff.singleRequest = true;
      await saveState(state);
    } catch (err) {
      classifyError(eff, err);
      await saveState(state);
      throw err;
    }
  }

  if (eff.singleRequest) {
    try {
      const info = await withRetries(ctx, eff, 0, () => downloadWhole(ctx, entry, eff, gen));
      applyChunkResult(eff, 0, info, gen);
      await saveState(state);
    } catch (err) {
      classifyError(eff, err);
      await saveState(state);
      throw err;
    }
    return { done: await allChunksValid(eff) };
  }

  const n = chunkCount(eff);
  const missing = [];
  for (let i = 0; i < n; i++) {
    if (eff.chunks[i] && (await fileValid(eff.id, i, eff.chunks[i]))) continue;
    missing.push(i);
  }

  const failures = [];
  // Cap how many chunks a single file may hold in the SHARED pool. Without
  // this, a fresh file with many missing chunks floods all slots before a
  // nearly-complete file finishes verifying its existing chunks and enqueues
  // its few missing ones, so the nearly-complete file is starved every batch
  // and never publishes. The cap keeps the pool fairly shared across the
  // concurrently-running files while still allowing one file to use the whole
  // pool when it is the only file (fileConcurrency=1).
  const perFile = Number.isFinite(ctx.chunkConcurrencyPerFile) ? Math.max(1, ctx.chunkConcurrencyPerFile) : Infinity;
  const local = perFile === Infinity ? null : createPool(perFile);
  const submit = (fn) => (local ? local.run(() => pool.run(fn)) : pool.run(fn));
  await Promise.all(
    missing.map((i) =>
      submit(async () => {
        if (isStopped(ctx) || remainingMs(ctx) < CONFIG.minChunkBudgetMs) return;
        // Count only chunks that actually get admitted, so the outer pass loop
        // can tell a productive pass from a no-op pass and stop spinning once
        // no further chunk can become durable within the batch.
        ctx.chunksStarted = (ctx.chunksStarted || 0) + 1;
        const myGen = eff.gen;
        try {
          const info = await withRetries(ctx, eff, i, () => downloadChunkOnce(ctx, entry, eff, i, myGen));
          if (applyChunkResult(eff, i, info, myGen)) await saveState(state);
        } catch (err) {
          failures.push({ i, err });
        }
      }),
    ),
  );

  if (failures.length > 0) {
    const hard = failures.find((f) => f.err.validatorChanged || f.err.rangeIgnored);
    if (hard) {
      resetForRetry(eff, hard.err.validatorChanged ? 'validatorChanged' : 'rangeIgnored');
    } else if (failures.some((f) => f.err.aborted)) {
      preserveOnAbort(eff, failures.find((f) => f.err.aborted).err);
    } else if (failures.every((f) => f.err.permanent)) {
      eff.status = 'unavailable';
    }
    await saveState(state);
    return { done: false, failures: failures.map((f) => f.err.message) };
  }

  const haveAll = chunkCount(eff) > 0 && (await allChunksValid(eff));
  if (haveAll) {
    eff.receivedBytes = Object.values(eff.chunks).reduce((a, c) => a + c.bytes, 0);
    return { done: true };
  }
  return { done: false };
}

async function allChunksValid(eff) {
  const n = chunkCount(eff);
  for (let i = 0; i < n; i++) {
    if (!eff.chunks[i]) return false;
    if (!(await fileValid(eff.id, i, eff.chunks[i]))) return false;
  }
  return true;
}

async function fileValid(id, i, info) {
  try {
    const st = await fs.stat(chunkPath(id, i));
    if (st.size !== info.bytes) return false;
    return (await sha256File(chunkPath(id, i))) === info.sha256;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Assembly + publication
// ---------------------------------------------------------------------------

export async function assembleHex(eff) {
  const h = createHash('sha256');
  let bytes = 0;
  const n = chunkCount(eff);
  for (let i = 0; i < n; i++) {
    const info = eff.chunks[i];
    if (!info) throw new Error(`missing chunk ${i} for ${eff.id}`);
    const buf = await fs.readFile(chunkPath(eff.id, i));
    if (buf.length !== info.bytes) throw new Error(`chunk ${i} length mismatch for ${eff.id}`);
    h.update(buf);
    bytes += buf.length;
  }
  return { sha256: h.digest('hex'), bytes };
}

export async function assembleToFile(eff, dest) {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const out = await fs.open(dest, 'w');
  try {
    const n = chunkCount(eff);
    for (let i = 0; i < n; i++) {
      const info = eff.chunks[i];
      if (!info) throw new Error(`missing chunk ${i} for ${eff.id}`);
      const buf = await fs.readFile(chunkPath(eff.id, i));
      if (buf.length !== info.bytes) throw new Error(`chunk ${i} length mismatch for ${eff.id}`);
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
  const work = path.join(workspaceDir(eff.id), 'out', `${eff.id}.bin`);

  const { sha256, bytes } = await assembleHex(eff);
  await assembleToFile(eff, work);

  log(`publishing ${eff.id} (${bytes} bytes) as ${tag}`);
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
  await saveState(state);

  // Round-trip verification: pull the tag back and compare bytes.
  const verifyDir = path.join(PATHS.stagingDir, 'verify', eff.id);
  await fs.rm(verifyDir, { recursive: true, force: true });
  await ghcr.pull(tag, verifyDir);
  const pulled = path.join(verifyDir, path.basename(work));
  const pulledHash = await sha256File(pulled);
  const ok = pulledHash === sha256;
  eff.verified = { at: new Date().toISOString(), pulledSha256: pulledHash, ok, digest: push.digest };
  await fs.rm(verifyDir, { recursive: true, force: true });
  if (!ok) {
    eff.status = 'in_progress';
    eff.lastError = 'round-trip verification mismatch';
    eff.lastErrorAt = new Date().toISOString();
    await saveState(state);
    throw new Error(`round-trip verification failed for ${eff.id}`);
  }
  eff.status = 'published';
  eff.publishedAt = new Date().toISOString();
  eff.lastError = null;
  await saveState(state);

  await fs.rm(workspaceDir(eff.id), { recursive: true, force: true });
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

export async function checkpointPartials(ctx) {
  const { state, ghcr, log } = ctx;
  const inProgress = Object.values(state.files).filter(
    (e) => e.status === 'in_progress' && Object.keys(e.chunks).length > 0,
  );

  // Selected small prefixes on the control branch.
  await fs.mkdir(PATHS.partialDir, { recursive: true });
  const partialIndex = { version: 1, updatedAt: new Date().toISOString(), partials: {} };
  let budget = CONFIG.gitPartialMaxTotalBytes;
  for (const eff of inProgress) {
    if (budget <= 0) break;
    const prefix = await buildContiguousPrefix(eff.id, eff.chunks, eff.chunkSize);
    if (!prefix || prefix.bytes === 0) continue;
    const cap = Math.min(prefix.bytes, CONFIG.gitPartialMaxBytesPerFile, budget);
    const buf = prefix.buffer.subarray(0, cap);
    await atomicWriteFile(path.join(PATHS.partialDir, `${eff.id}.prefix`), buf);
    partialIndex.partials[eff.id] = {
      bytes: buf.length,
      sha256: sha256Buf(buf),
      chunkSize: eff.chunkSize,
      at: new Date().toISOString(),
    };
    budget -= buf.length;
  }
  await atomicWriteJson(PARTIAL_INDEX, partialIndex);

  // Full chunk workspaces to GHCR checkpoint artifacts.
  for (const eff of inProgress) {
    if (ctx.cleanupDeadline && Date.now() >= ctx.cleanupDeadline) {
      log('cleanup budget exhausted; skipping remaining GHCR checkpoints');
      break;
    }
    const dir = chunksDir(eff.id);
    // Sweep abandoned writers FIRST, then enumerate only committed chunk files.
    // A `.tmp` renamed away by an in-flight writer must never be stat()ed or
    // uploaded (ENOENT during checkpointing is the defect this guards).
    let all = [];
    try {
      all = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const f of all) {
      if (f.endsWith('.tmp')) await fs.rm(path.join(dir, f), { force: true });
    }
    const names = all.filter((f) => f.startsWith('chunk-') && !f.endsWith('.tmp'));
    if (names.length === 0) continue;
    const sizes = await Promise.all(
      names.map(async (f) => {
        try {
          return (await fs.stat(path.join(dir, f))).size;
        } catch {
          return 0; // vanished between readdir and stat: skip, never throw
        }
      }),
    );
    const bytes = sizes.reduce((a, b) => a + b, 0);
    if (eff.checkpoint && eff.checkpoint.bytes === bytes) continue;
    try {
      const res = await ghcr.pushDir(checkpointTag(eff.id), dir);
      eff.checkpoint = { digest: res.digest, bytes, chunks: names.length, at: new Date().toISOString() };
      log(`checkpointed ${eff.id} (${bytes} bytes, ${names.length} chunks) -> ${res.digest}`);
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
    if (!buf || buf.length !== chunks[i].bytes) break;
    if (sha256Buf(buf) !== chunks[i].sha256) break;
    parts.push(buf);
    bytes += buf.length;
    if (bytes >= CONFIG.gitPartialMaxBytesPerFile) break;
  }
  if (parts.length === 0) return null;
  return { buffer: Buffer.concat(parts), bytes, chunkCount: parts.length };
}

export async function restoreFromGitPartials(state, log = () => {}) {
  const idx = await loadJson(PARTIAL_INDEX, null);
  if (!idx) return 0;
  let restored = 0;
  for (const [id, info] of Object.entries(idx.partials || {})) {
    const eff = state.files[id];
    if (!eff || eff.status === 'published') continue;
    let buf;
    try {
      buf = await fs.readFile(path.join(PATHS.partialDir, `${id}.prefix`));
    } catch {
      continue;
    }
    if (buf.length !== info.bytes || sha256Buf(buf) !== info.sha256) {
      log(`ignoring torn git partial for ${id}`);
      continue;
    }
    const nChunks = Math.ceil(buf.length / info.chunkSize);
    for (let i = 0; i < nChunks; i++) {
      const start = i * info.chunkSize;
      const chunkBuf = buf.subarray(start, Math.min(start + info.chunkSize, buf.length));
      const ci = eff.chunks[i];
      if (!ci || chunkBuf.length !== ci.bytes || sha256Buf(chunkBuf) !== ci.sha256) continue;
      const dest = chunkPath(id, i);
      try {
        const st = await fs.stat(dest);
        if (st.size === chunkBuf.length && (await sha256File(dest)) === ci.sha256) continue;
      } catch {
        /* missing */
      }
      await atomicWriteFile(dest, chunkBuf);
      restored++;
      log(`restored chunk ${i} of ${id} from git partial`);
    }
  }
  return restored;
}

export async function restoreFromCheckpoints(ctx) {
  const { state, ghcr, log } = ctx;
  let restored = 0;
  for (const eff of Object.values(state.files)) {
    if (eff.status === 'published') continue;
    if (!eff.checkpoint || !eff.checkpoint.digest) continue;
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
      // Pull the immutable digest that state recorded, not a movable tag.
      const ref = eff.checkpoint.digest
        ? `${REGISTRY}@${eff.checkpoint.digest}`
        : `${REGISTRY}:${checkpointTag(eff.id)}`;
      await ghcr.pullRef(ref, chunksDir(eff.id));
    } catch (err) {
      log(`checkpoint pull failed for ${eff.id}: ${err.message}`);
      continue;
    }
    for (const i of Object.keys(eff.chunks)) {
      if (!(await fileValid(eff.id, Number(i), eff.chunks[i]))) {
        await fs.rm(chunkPath(eff.id, Number(i)), { force: true });
        delete eff.chunks[i];
        restored--;
      } else {
        restored++;
      }
    }
    eff.receivedBytes = Object.values(eff.chunks).reduce((a, c) => a + c.bytes, 0);
    await saveState(state);
  }
  return restored;
}

// ---------------------------------------------------------------------------
// Concurrency pool + ordering + pass runner
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

export function estimateBytes(labelSize) {
  const m = /(\d+(?:\.\d+)?)\s*M/i.exec(labelSize || '');
  return m ? Math.round(Number(m[1]) * 1024 * 1024) : null;
}

export function orderEntries(entries, state) {
  // Smallest-first. With short bounded foreground batches the priority is
  // DURABILITY: finish and publish a whole file (a GHCR artifact) as soon as
  // possible, so each batch leaves the maximum amount of verified, immutable
  // progress. A huge file that only completes after many batches (and can lose
  // its staging bytes on an iteration boundary) is attempted last, once the
  // small/medium files are already durably published.
  return [...entries].sort((a, b) => {
    const ea = state.files[a.id];
    const eb = state.files[b.id];
    const pa = ea && ea.status === 'published';
    const pb = eb && eb.status === 'published';
    if (pa !== pb) return pa ? 1 : -1;
    const sa = (ea && ea.expectedBytes) || estimateBytes(a.labelSize) || Number.MAX_SAFE_INTEGER;
    const sb = (eb && eb.expectedBytes) || estimateBytes(b.labelSize) || Number.MAX_SAFE_INTEGER;
    return sa - sb;
  });
}

export function createContext({ state, manifest, ghcr, log = console.log, signal = null, deadline = null }) {
  return {
    state,
    manifest,
    ghcr,
    log,
    signal,
    deadline,
    limiter: createRateLimiter(CONFIG.bandwidthLimitBps),
    pool: createPool(CONFIG.maxConcurrency),
  };
}

// Remove any abandoned chunk temp files so no writer's leftovers survive a
// tool boundary (the supervisor scans the checkout for credentials).
export async function cleanupTempFiles(state) {
  let removed = 0;
  for (const eff of Object.values(state.files)) {
    if (eff.status === 'published') continue;
    const dir = chunksDir(eff.id);
    let names;
    try {
      names = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      if (n.endsWith('.tmp')) {
        await fs.rm(path.join(dir, n), { force: true });
        removed++;
      }
    }
  }
  return removed;
}

export async function runPass(ctx) {
  const { state, manifest, log } = ctx;
  ctx.chunksStarted = 0;
  const deadline = Math.min(ctx.deadline ?? Infinity, Date.now() + CONFIG.passBudgetMs);
  ctx.deadline = deadline;
  const ordered = orderEntries(manifest.entries, state);
  const results = [];

  const queue = [];
  for (const entry of ordered) {
    const eff = ensureFileEntry(state, entry);
    if (eff.status === 'published' || eff.status === 'unavailable') continue;
    queue.push(entry);
  }

  // Work on a few files at once, feeding the shared chunk pool so it stays
  // saturated even for files smaller than the connection count. File bytes and
  // chunk metadata are per-entry, so this is safe; completed files publish
  // independently as soon as their own chunks are verified.
  const fileConcurrency = Math.max(1, Number(process.env.NAUKA_FILE_CONCURRENCY || 4));
  // Share the shared chunk pool fairly across the concurrent files so one
  // large fresh file cannot starve a nearly-complete one (see downloadFile).
  ctx.chunkConcurrencyPerFile = Math.max(1, Math.floor(CONFIG.maxConcurrency / fileConcurrency));
  let next = 0;
  const worker = async () => {
    for (;;) {
      if (isStopped(ctx)) return;
      const i = next++;
      if (i >= queue.length) return;
      const entry = queue[i];
      const eff = ensureFileEntry(state, entry);
      if (eff.status === 'published' || eff.status === 'unavailable') continue;
      log(`-- file ${eff.id} (${eff.labelSize}) --`);
      try {
        const r = await downloadFile(ctx, entry);
        if (r.done) {
          // Only publish when enough budget remains to assemble, push and
          // round-trip verify. Otherwise the complete chunks stay durable and
          // the next bounded batch publishes them; nothing restarts from zero.
          if (ctx.deadline && Date.now() > ctx.deadline - CONFIG.publishReserveMs) {
            results.push({ id: eff.id, status: 'ready', received: eff.receivedBytes });
            continue;
          }
          const pub = await publishFile(ctx, entry);
          results.push({ id: eff.id, status: 'published', ...pub });
        } else {
          results.push({ id: eff.id, status: 'in_progress', received: eff.receivedBytes });
        }
      } catch (err) {
        log(`file ${eff.id} error: ${err.message}`);
        classifyError(eff, err);
        results.push({ id: eff.id, status: eff.status, error: err.message });
        await saveState(state);
        if (isStopped(ctx)) return;
      }
    }
  };
  await Promise.all(Array.from({ length: fileConcurrency }, () => worker()));

  await checkpointPartials(ctx);
  await saveState(state);
  return results;
}

export { checkpointTag, entryTag };
