// Local HTTP fixture tests for the resumable downloader.
//
// The fixture server can: honor Range (206 + Content-Range), ignore Range
// (200 full body), drop the connection mid-body, and change its validator.
// A cold-restart test reconstructs progress from the durable partial store.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

// Tune the engine for fast, deterministic tests before importing it.
process.env.NAUKA_CHUNK = '1024';
process.env.NAUKA_CONCURRENCY = '2';
process.env.NAUKA_GAP_MS = '0';
process.env.NAUKA_BPS = '0';
process.env.NAUKA_IDLE_MS = '5000';
process.env.NAUKA_ATTEMPT_MS = '30000';
process.env.NAUKA_PASS_MS = '30000';
process.env.NAUKA_MAX_ATTEMPTS = '4';
// Isolate all state/staging under a throwaway dir so tests never clobber the
// real task checkpoint at data/nauka/state.
import os from 'node:os';
import { mkdtempSync } from 'node:fs';
process.env.NAUKA_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'nauka-fixture-'));

const { httpGetToFile, RangeIgnoredError, TransientError } = await import('../http.mjs');
const engine = await import('../engine.mjs');
const { CONFIG, PATHS } = await import('../config.mjs');

const sha = (b) => createHash('sha256').update(b).digest('hex');
const chunkFile = (id, i) => path.join(engine.chunksDir(id), `chunk-${String(i).padStart(6, '0')}`);

function makeServer(content, opts = {}) {
  const state = { etag: opts.etag || '"v1"', dropAfter: opts.dropAfter ?? null, ignoreRange: !!opts.ignoreRange, requests: [] };
  const delayMs = opts.delayMs || 0;
  const server = http.createServer((req, res) => {
    const range = req.headers.range;
    const ifRange = req.headers['if-range'];
    const ifRangeOk = !ifRange || ifRange === state.etag;
    let start = 0;
    let end = content.length - 1;
    let status = 200;
    if (range && !state.ignoreRange && ifRangeOk) {
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      if (m) {
        start = Number(m[1]);
        end = m[2] ? Number(m[2]) : content.length - 1;
        if (start >= content.length) {
          res.writeHead(416, { 'Content-Range': `bytes */${content.length}` });
          res.end();
          return;
        }
        end = Math.min(end, content.length - 1);
        status = 206;
      }
    }
    state.requests.push(range || 'full');
    const body = content.subarray(start, end + 1);
    const headers = { ETag: state.etag, 'Last-Modified': 'Wed, 01 Jan 2020 00:00:00 GMT' };
    if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${content.length}`;
    headers['Content-Length'] = String(status === 206 ? body.length : content.length);
    const send = () => {
      res.writeHead(status, headers);
      if (state.dropAfter != null) {
        res.write(body.subarray(0, state.dropAfter));
        setTimeout(() => res.socket.destroy(), 5);
        return;
      }
      res.end(body);
    };
    if (delayMs > 0) setTimeout(send, delayMs);
    else send();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}/file.bin`,
        state,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

// A server that announces a correct Content-Range/Length but only ever writes
// part of the body, so a writer is guaranteed to have an open .tmp file when
// the batch is cancelled.
function makeTrickleServer(content) {
  const server = http.createServer((req, res) => {
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    const start = m ? Number(m[1]) : 0;
    const end = m && m[2] ? Math.min(Number(m[2]), content.length - 1) : content.length - 1;
    res.writeHead(206, {
      ETag: '"v1"',
      'Content-Range': `bytes ${start}-${end}/${content.length}`,
      'Content-Length': String(end - start + 1),
    });
    res.write(content.subarray(start, start + 50));
    // deliberately never end the response
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}/file.bin`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

// Run fn with a fixture server that is always closed afterwards.
async function withServer(content, opts, fn) {
  const srv = await makeServer(content, opts);
  try {
    return await fn(srv);
  } finally {
    await srv.close();
  }
}

async function tmpPath(name) {
  const dir = path.join(PATHS.stagingDir, 'test', `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(dir, { recursive: true });
  return path.join(dir, name);
}

function makeCtx(state, entry, fakeGhcr) {
  return {
    state,
    manifest: { entries: [entry], indexUrl: 'http://example/index' },
    log: () => {},
    limiter: { take: async () => {} },
    pool: engine.createPool(2),
    ghcr: fakeGhcr,
  };
}

test('honors Range and returns correct 206 bytes', async () => {
  const content = randomBytes(5000);
  await withServer(content, {}, async (srv) => {
    const dest = await tmpPath('a.bin');
    const meta = await httpGetToFile(srv.url, { destTmp: dest, start: 1000, end: 1999 });
    assert.equal(meta.status, 206);
    assert.equal(meta.contentRange.start, 1000);
    assert.equal(meta.contentRange.total, 5000);
    assert.deepEqual(await fs.readFile(dest), content.subarray(1000, 2000));
  });
});

test('detects an ignored Range and never appends a full response', async () => {
  const content = randomBytes(5000);
  await withServer(content, { ignoreRange: true }, async (srv) => {
    const dest = await tmpPath('partial.bin');
    await fs.writeFile(dest, Buffer.from('EXISTING-PARTIAL'));
    await assert.rejects(
      () => httpGetToFile(srv.url, { destTmp: dest, start: 1000, end: 1999 }),
      RangeIgnoredError,
    );
    assert.equal((await fs.readFile(dest)).toString(), 'EXISTING-PARTIAL');
  });
});

test('retries after a mid-body connection drop', async () => {
  const content = randomBytes(4000);
  await withServer(content, { dropAfter: 500 }, async (srv) => {
    const dest = await tmpPath('drop.bin');
    await assert.rejects(
      () => httpGetToFile(srv.url, { destTmp: dest, start: 0, end: 3999 }),
      TransientError,
    );
    srv.state.dropAfter = null;
    const meta = await httpGetToFile(srv.url, { destTmp: dest, start: 0, end: 3999 });
    assert.equal(meta.bytesWritten, 4000);
    assert.deepEqual(await fs.readFile(dest), content);
  });
});

test('detects a changed validator and resets progress', async () => {
  const content = randomBytes(4096);
  await withServer(content, { etag: '"v1"' }, async (srv) => {
    const entry = {
      id: 'fx-valid',
      year: 1934,
      issue: 'N01',
      format: 'djv',
      filename: 'fx.bin',
      url: srv.url,
      labelText: 'fx',
      labelSize: '1M',
    };
    const state = { version: 1, files: {} };
    const eff = engine.ensureFileEntry(state, entry);
    eff.expectedBytes = content.length;
    eff.etag = '"v1"';
    eff.status = 'in_progress';
    // Seed chunk 0 as already downloaded under etag v1.
    await fs.mkdir(engine.chunksDir(entry.id), { recursive: true });
    const c0 = content.subarray(0, CONFIG.chunkSize);
    await fs.writeFile(chunkFile(entry.id, 0), c0);
    eff.chunks[0] = { bytes: c0.length, sha256: sha(c0) };

    // Origin validator changes; the next ranged chunk must be rejected.
    srv.state.etag = '"v2"';
    const r = await engine.downloadFile(makeCtx(state, entry, null), entry);
    assert.equal(r.done, false);
    assert.equal(Object.keys(eff.chunks).length, 0, 'chunks must be reset after validator change');
    assert.match(String(eff.lastError), /validator/);
  });
});

test('cold restart reconstructs progress from git partial and GHCR checkpoint', async () => {
  const content = randomBytes(8192);
  await withServer(content, {}, async (srv) => {
    const entry = {
      id: 'fx-cold',
      year: 1939,
      issue: 'N01',
      format: 'djv',
      filename: 'fx-cold.bin',
      url: srv.url,
      labelText: 'fx',
      labelSize: '1M',
    };

    const state = { version: 1, files: {} };
    const eff = engine.ensureFileEntry(state, entry);
    eff.expectedBytes = content.length;
    eff.chunkSize = CONFIG.chunkSize;
    eff.status = 'in_progress';
    await fs.mkdir(engine.chunksDir(entry.id), { recursive: true });
    for (let i = 0; i < 2; i++) {
      const buf = content.subarray(i * CONFIG.chunkSize, (i + 1) * CONFIG.chunkSize);
      await fs.writeFile(chunkFile(entry.id, i), buf);
      eff.chunks[i] = { bytes: buf.length, sha256: sha(buf) };
    }
    eff.receivedBytes = 2048;

    const fakeGhcr = makeFakeGhcr();
    const ctx = makeCtx(state, entry, fakeGhcr);

    await engine.checkpointPartials(ctx);
    assert.ok(fakeGhcr.store.has(`checkpoint-${entry.id}`), 'checkpoint pushed to GHCR');

    // Fresh runner: wipe local stage bytes, keep state.
    await fs.rm(engine.workspaceDir(entry.id), { recursive: true, force: true });

    const n = await engine.restoreFromGitPartials(state, () => {});
    assert.ok(n >= 2, `expected >=2 restored chunks, got ${n}`);

    await engine.restoreFromCheckpoints(ctx);

    const r = await engine.downloadFile(ctx, entry);
    assert.equal(r.done, true);
    const assembled = await engine.assembleHex(eff);
    assert.equal(assembled.bytes, content.length);
    assert.equal(assembled.sha256, sha(content));
  });
});

test('publishes and round-trip verifies via the registry', async () => {
  const content = randomBytes(2048);
  await withServer(content, {}, async (srv) => {
    const entry = {
      id: 'fx-pub',
      year: 1934,
      issue: 'N02',
      format: 'pdf',
      filename: 'fx-pub.bin',
      url: srv.url,
      labelText: 'fx',
      labelSize: '1M',
    };
    const state = { version: 1, files: {} };
    const ctx = makeCtx(state, entry, makeFakeGhcr());
    const r = await engine.downloadFile(ctx, entry);
    assert.equal(r.done, true);
    const pub = await engine.publishFile(ctx, entry);
    assert.equal(pub.bytes, content.length);
    assert.equal(pub.sha256, sha(content));
    const eff = state.files[entry.id];
    assert.equal(eff.status, 'published');
    assert.equal(eff.verified.ok, true);
  });
});

test('probe sizes with a 1-byte request; falls back to a whole-body fetch when Range is ignored', async () => {
  const content = randomBytes(6000);
  await withServer(content, { ignoreRange: true }, async (srv) => {
    const entry = {
      id: 'fx-norange',
      year: 1934,
      issue: 'N01',
      format: 'djv',
      filename: 'fx.bin',
      url: srv.url,
      labelText: 'fx',
      labelSize: '1M',
    };
    const state = { version: 1, files: {} };
    const ctx = makeCtx(state, entry, makeFakeGhcr());
    const r = await engine.downloadFile(ctx, entry);
    assert.equal(r.done, true);
    const eff = state.files[entry.id];
    assert.equal(eff.singleRequest, true);
    assert.equal(eff.expectedBytes, content.length);
    const assembled = await engine.assembleHex(eff);
    assert.equal(assembled.sha256, sha(content));
  });
});

test('probe learns the total size from a 1-byte ranged response', async () => {
  const content = randomBytes(9000);
  await withServer(content, {}, async (srv) => {
    const entry = {
      id: 'fx-probe',
      year: 1939,
      issue: 'N02',
      format: 'pdf',
      filename: 'fx.bin',
      url: srv.url,
      labelText: 'fx',
      labelSize: '1M',
    };
    const state = { version: 1, files: {} };
    const ctx = makeCtx(state, entry, makeFakeGhcr());
    const r = await engine.downloadFile(ctx, entry);
    assert.equal(r.done, true);
    const eff = state.files[entry.id];
    assert.equal(eff.singleRequest, false);
    assert.equal(eff.expectedBytes, content.length);
    const assembled = await engine.assembleHex(eff);
    assert.equal(assembled.bytes, content.length);
    assert.equal(assembled.sha256, sha(content));
  });
});

test('ordinary cancellation preserves verified chunks and never restarts them', async () => {
  const content = randomBytes(8192);
  await withServer(content, { delayMs: 80 }, async (srv) => {
    const entry = {
      id: 'fx-abort',
      year: 1934,
      issue: 'N03',
      format: 'pdf',
      filename: 'fx-abort.bin',
      url: srv.url,
      labelText: 'fx',
      labelSize: '1M',
    };
    const state = { version: 1, files: {} };
    const eff = engine.ensureFileEntry(state, entry);
    eff.expectedBytes = content.length;
    eff.chunkSize = CONFIG.chunkSize;
    eff.status = 'in_progress';

    const controller = new AbortController();
    const ctx = { ...makeCtx(state, entry, makeFakeGhcr()), signal: controller.signal };
    ctx.pool = engine.createPool(2);
    const pending = engine.downloadFile(ctx, entry);
    setTimeout(() => controller.abort(), 200);
    const r = await pending;
    assert.equal(r.done, false);

    const doneIdx = Object.keys(eff.chunks).map(Number).sort((a, b) => a - b);
    assert.ok(doneIdx.length > 0, 'some chunks were verified before cancellation');
    assert.ok(doneIdx.length < 8, 'the whole file was not downloaded');
    assert.equal(eff.status, 'in_progress', 'abort must not reset progress');
    for (const i of doneIdx) {
      const buf = content.subarray(i * CONFIG.chunkSize, (i + 1) * CONFIG.chunkSize);
      assert.equal(eff.chunks[i].sha256, sha(buf), `chunk ${i} hash intact`);
    }

    const before = srv.state.requests.length;
    const ctx2 = makeCtx(state, entry, makeFakeGhcr());
    const r2 = await engine.downloadFile(ctx2, entry);
    assert.equal(r2.done, true);
    const assembled = await engine.assembleHex(eff);
    assert.equal(assembled.sha256, sha(content));

    const after = srv.state.requests.slice(before);
    for (const i of doneIdx) {
      const start = i * CONFIG.chunkSize;
      const full = `bytes=${start}-${start + CONFIG.chunkSize - 1}`;
      assert.ok(!after.includes(full), `verified chunk ${i} was not re-requested`);
    }
  });
});

test('a cancelled bounded batch returns promptly and leaves no writer or temp file', async () => {
  const content = randomBytes(4096);
  const srv = await makeTrickleServer(content);
  try {
    const entry = {
      id: 'fx-cancel',
      year: 1935,
      issue: 'N04',
      format: 'pdf',
      filename: 'fx-cancel.bin',
      url: srv.url,
      labelText: 'fx',
      labelSize: '1M',
    };
    const state = { version: 1, files: {} };
    const eff = engine.ensureFileEntry(state, entry);
    eff.expectedBytes = content.length;
    eff.chunkSize = CONFIG.chunkSize;
    eff.status = 'in_progress';
    // Seed one already-verified chunk so cancellation has real progress to keep.
    await fs.mkdir(engine.chunksDir(entry.id), { recursive: true });
    const c0 = content.subarray(0, CONFIG.chunkSize);
    await fs.writeFile(chunkFile(entry.id, 0), c0);
    eff.chunks[0] = { bytes: c0.length, sha256: sha(c0) };

    const controller = new AbortController();
    const ctx = { ...makeCtx(state, entry, makeFakeGhcr()), signal: controller.signal };
    ctx.pool = engine.createPool(2);
    const t0 = Date.now();
    setTimeout(() => controller.abort(), 150);
    const r = await engine.downloadFile(ctx, entry);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 4000, `cancellation drained promptly (${elapsed}ms)`);
    assert.equal(r.done, false);
    assert.equal(eff.status, 'in_progress', 'verified chunk progress preserved');
    assert.ok(eff.chunks[0], 'the verified chunk entry survived cancellation');
    assert.equal(eff.chunks[0].sha256, sha(c0));

    const removed = await engine.cleanupTempFiles(state);
    assert.ok(removed >= 1, `expected a temp file to clean, removed ${removed}`);
    const names = await fs.readdir(engine.chunksDir(entry.id)).catch(() => []);
    assert.ok(!names.some((n) => n.endsWith('.tmp')), 'no .tmp writer left behind');
  } finally {
    await srv.close();
  }
});

function makeFakeGhcr() {
  const store = new Map();
  return {
    store,
    async pushFile(tag, filePath) {
      const buf = await fs.readFile(filePath);
      const digest = 'sha256:' + sha(buf);
      store.set(tag, { files: { [path.basename(filePath)]: buf }, digest });
      return { tag, digest };
    },
    async pushDir(tag, dir) {
      const files = {};
      for (const f of await fs.readdir(dir)) {
        if (f.endsWith('.tmp')) continue;
        files[f] = await fs.readFile(path.join(dir, f));
      }
      const digest = 'sha256:' + sha(Buffer.from(Object.keys(files).sort().join(',')));
      store.set(tag, { files, digest });
      return { tag, digest };
    },
    async pull(tag, outDir) {
      const e = store.get(tag);
      if (!e) throw new Error('not found ' + tag);
      await fs.mkdir(outDir, { recursive: true });
      for (const [f, buf] of Object.entries(e.files)) await fs.writeFile(path.join(outDir, f), buf);
      return outDir;
    },
  };
}
