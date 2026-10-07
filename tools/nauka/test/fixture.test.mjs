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

const { httpGetToFile, RangeIgnoredError, TransientError } = await import('../http.mjs');
const engine = await import('../engine.mjs');
const { CONFIG, PATHS } = await import('../config.mjs');

const sha = (b) => createHash('sha256').update(b).digest('hex');

function makeServer(content, opts = {}) {
  const state = { etag: opts.etag || '"v1"', dropAfter: opts.dropAfter ?? null, ignoreRange: !!opts.ignoreRange };
  const server = http.createServer((req, res) => {
    const range = req.headers.range;
    const ifRange = req.headers['if-range'];
    // If-Range mismatch -> send the whole entity (RFC 7233 semantics).
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
    const body = content.subarray(start, end + 1);
    const headers = { ETag: state.etag, 'Last-Modified': 'Wed, 01 Jan 2020 00:00:00 GMT' };
    if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${content.length}`;
    headers['Content-Length'] = String(state.ignoreRange ? content.length : body.length);
    res.writeHead(status, headers);
    if (state.dropAfter != null) {
      res.write(body.subarray(0, state.dropAfter));
      setTimeout(() => res.socket.destroy(), 5);
      return;
    }
    res.end(body);
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

async function tmpPath(name) {
  const dir = path.join(PATHS.stagingDir, 'test', `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(dir, { recursive: true });
  return path.join(dir, name);
}

test('honors Range and returns correct 206 bytes', async () => {
  const content = randomBytes(5000);
  const srv = await makeServer(content);
  const dest = await tmpPath('a.bin');
  const meta = await httpGetToFile(srv.url, { destTmp: dest, start: 1000, end: 1999 });
  assert.equal(meta.status, 206);
  assert.equal(meta.contentRange.start, 1000);
  assert.equal(meta.contentRange.total, 5000);
  assert.deepEqual(await fs.readFile(dest), content.subarray(1000, 2000));
  await srv.close();
});

test('detects an ignored Range and never appends a full response', async () => {
  const content = randomBytes(5000);
  const srv = await makeServer(content, { ignoreRange: true });
  const dest = await tmpPath('partial.bin');
  await fs.writeFile(dest, Buffer.from('EXISTING-PARTIAL'));
  await assert.rejects(() => httpGetToFile(srv.url, { destTmp: dest, start: 1000, end: 1999 }), RangeIgnoredError);
  // The pre-existing partial must be untouched.
  assert.equal((await fs.readFile(dest)).toString(), 'EXISTING-PARTIAL');
  await srv.close();
});

test('retries after a mid-body connection drop', async () => {
  const content = randomBytes(4000);
  const srv = await makeServer(content, { dropAfter: 500 });
  const dest = await tmpPath('drop.bin');
  await assert.rejects(() => httpGetToFile(srv.url, { destTmp: dest, start: 0, end: 3999 }), TransientError);
  // Heal the server and retry the same range.
  srv.state.dropAfter = null;
  const meta = await httpGetToFile(srv.url, { destTmp: dest, start: 0, end: 3999 });
  assert.equal(meta.bytesWritten, 4000);
  assert.deepEqual(await fs.readFile(dest), content);
  await srv.close();
});

test('detects a changed validator and resets progress', async () => {
  const content = randomBytes(4096);
  const srv = await makeServer(content, { etag: '"v1"' });
  const state = { version: 1, files: {} };
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
  const eff = engine.ensureFileEntry(state, entry);
  const ctx = {
    state,
    manifest: { entries: [entry], indexUrl: 'http://example/index' },
    log: () => {},
    limiter: { take: async () => {} },
    pool: engine.createPool(2),
    ghcr: null,
  };
  // First chunk succeeds at etag v1.
  const r1 = await engine.downloadFile(ctx, entry);
  assert.equal(r1.done, false);
  assert.ok(Object.keys(eff.chunks).length >= 1);

  // Now the origin object changes.
  srv.state.etag = '"v2"';
  await assert.rejects(() => engine.downloadFile(ctx, entry), /validator/);
  assert.equal(Object.keys(eff.chunks).length, 0, 'chunks must be reset after validator change');
  await srv.close();
});

test('cold restart reconstructs progress from git partial and GHCR checkpoint', async () => {
  const content = randomBytes(8192);
  const srv = await makeServer(content);
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

  // Seed state with two completed chunks (2 * 1024 bytes).
  const state = { version: 1, files: {} };
  const eff = engine.ensureFileEntry(state, entry);
  eff.expectedBytes = content.length;
  eff.chunkSize = CONFIG.chunkSize;
  await fs.mkdir(engine.chunksDir(entry.id), { recursive: true });
  for (let i = 0; i < 2; i++) {
    const buf = content.subarray(i * CONFIG.chunkSize, (i + 1) * CONFIG.chunkSize);
    await fs.writeFile(path.join(engine.chunksDir(entry.id), `chunk-${String(i).padStart(6, '0')}`), buf);
    eff.chunks[i] = { bytes: buf.length, sha256: sha(buf) };
  }
  eff.receivedBytes = 2048;
  eff.status = 'in_progress';

  const fakeGhcr = makeFakeGhcr();
  const ctx = {
    state,
    manifest: { entries: [entry], indexUrl: 'http://example/index' },
    log: () => {},
    limiter: { take: async () => {} },
    pool: engine.createPool(2),
    ghcr: fakeGhcr,
  };

  await engine.checkpointPartials(ctx);
  assert.ok(fakeGhcr.store.has(`checkpoint-${entry.id}`), 'checkpoint pushed to GHCR');

  // Simulate a fresh runner: wipe all local stage bytes, keep state.
  await fs.rm(engine.workspaceDir(entry.id), { recursive: true, force: true });

  // Recover from the control-branch partial first.
  const n = await engine.restoreFromGitPartials(state, () => {});
  assert.ok(n >= 2, `expected >=2 restored chunks, got ${n}`);

  // Then top up from the GHCR checkpoint (no-op here, but exercises the path).
  await engine.restoreFromCheckpoints(ctx);

  // Finish the remaining chunks and verify the assembled bytes.
  const r = await engine.downloadFile(ctx, entry);
  assert.equal(r.done, true);
  const assembled = await engine.assembleHex(eff);
  assert.equal(assembled.bytes, content.length);
  assert.equal(assembled.sha256, sha(content));
  await srv.close();
});

test('publishes and round-trip verifies via the registry', async () => {
  const content = randomBytes(2048);
  const srv = await makeServer(content);
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
  const fakeGhcr = makeFakeGhcr();
  const ctx = {
    state,
    manifest: { entries: [entry], indexUrl: 'http://example/index' },
    log: () => {},
    limiter: { take: async () => {} },
    pool: engine.createPool(2),
    ghcr: fakeGhcr,
  };
  const r = await engine.downloadFile(ctx, entry);
  assert.equal(r.done, true);
  const pub = await engine.publishFile(ctx, entry);
  assert.equal(pub.bytes, content.length);
  assert.equal(pub.sha256, sha(content));
  const eff = state.files[entry.id];
  assert.equal(eff.status, 'published');
  assert.equal(eff.verified.ok, true);
  await srv.close();
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
