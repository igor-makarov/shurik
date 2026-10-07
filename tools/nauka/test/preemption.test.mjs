// Process-level cancellation/preemption + cold-resume fixture.
//
// This reproduces the iteration 1-2 failure class directly: a foreground
// `retrieve` tool call is terminated (SIGTERM) while a chunk writer holds an
// open `.tmp` file. The CLI must drain in-flight requests and writers, sweep
// temp files, persist consistent chunk/validator metadata and exit cleanly,
// WITHOUT resetting verified progress. A second, fresh process must then
// cold-resume from that durable state and publish, re-requesting nothing it
// already verified.
//
// The registry is the in-process fake (NAUKA_GHCR_FAKE=1), so the test is
// hermetic: no GHCR, no oras download, no real task state.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli.mjs');
const CHUNK = 65536;
const sha = (b) => createHash('sha256').update(b).digest('hex');

// A tiny Range-capable origin. `trickle` writes a few bytes and never ends the
// body, guaranteeing a live `.tmp` writer when we preempt.
function serveRange(content, { etag = '"v1"', trickle = false } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const range = req.headers.range || '';
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    const start = m ? Number(m[1]) : 0;
    const end = m && m[2] ? Math.min(Number(m[2]), content.length - 1) : content.length - 1;
    requests.push(range || 'full');
    const body = content.subarray(start, end + 1);
    res.writeHead(206, {
      ETag: etag,
      'Last-Modified': 'Wed, 01 Jan 2020 00:00:00 GMT',
      'Content-Range': `bytes ${start}-${end}/${content.length}`,
      'Content-Length': String(body.length),
    });
    if (trickle) {
      res.write(body.subarray(0, Math.min(64, body.length)));
      // never end: keep the writer open
    } else {
      res.end(body);
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}/fx.bin`,
        requests,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function spawnRetrieve(dataDir, args = []) {
  const child = spawn(process.execPath, [CLI, 'retrieve', ...args], {
    env: {
      ...process.env,
      NAUKA_DATA_DIR: dataDir,
      NAUKA_STATUS_FILE: path.join(dataDir, 'NAUKA_STATUS.test.md'),
      NAUKA_GHCR_FAKE: '1',
      NAUKA_CHUNK: String(CHUNK),
      NAUKA_CONCURRENCY: '2',
      NAUKA_GAP_MS: '0',
      NAUKA_BPS: '0',
      NAUKA_FILE_CONCURRENCY: '1',
      NAUKA_IDLE_MS: '60000',
      NAUKA_ATTEMPT_MS: '60000',
      NAUKA_MIN_CHUNK_MS: '200',
      NAUKA_PUBLISH_RESERVE_MS: '200',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  return { child, getOutput: () => out };
}

async function seedState(dataDir, entry, content) {
  const stateDir = path.join(dataDir, 'state');
  await fs.mkdir(stateDir, { recursive: true });
  const c0 = content.subarray(0, CHUNK);
  const manifest = {
    version: 1,
    indexUrl: 'http://fixture/index',
    indexSha256: 'fixture',
    indexBytes: 0,
    fetchedAt: new Date().toISOString(),
    years: [entry.year],
    totalFiles: 1,
    entries: [entry],
    coverage: {},
  };
  const files = {
    version: 1,
    files: {
      [entry.id]: {
        id: entry.id,
        year: entry.year,
        issue: entry.issue,
        format: entry.format,
        filename: entry.filename,
        url: entry.url,
        labelText: entry.labelText,
        labelSize: entry.labelSize,
        expectedBytes: content.length,
        etag: '"v1"',
        lastModified: 'Wed, 01 Jan 2020 00:00:00 GMT',
        singleRequest: false,
        chunkSize: CHUNK,
        chunks: { 0: { bytes: c0.length, sha256: sha(c0) } },
        receivedBytes: c0.length,
        status: 'in_progress',
        gen: 0,
        attempts: 0,
        retries: 0,
        lastError: null,
        lastErrorAt: null,
        ghcr: null,
        checkpoint: null,
        verified: null,
        updatedAt: new Date().toISOString(),
      },
    },
    updatedAt: new Date().toISOString(),
  };
  await fs.writeFile(path.join(stateDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  await fs.writeFile(path.join(stateDir, 'files.json'), JSON.stringify(files, null, 2) + '\n');
  const chunksDir = path.join(dataDir, 'staging', entry.id, 'chunks');
  await fs.mkdir(chunksDir, { recursive: true });
  await fs.writeFile(path.join(chunksDir, 'chunk-000000'), c0);
  return { stateDir, chunksDir };
}

async function readState(dataDir) {
  return JSON.parse(await fs.readFile(path.join(dataDir, 'state', 'files.json'), 'utf8'));
}

test('preemption drains writers, preserves verified chunks, then cold-resumes', async () => {
  const content = randomBytes(CHUNK * 5 + 1234);
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nauka-preempt-'));
  const trickle = await serveRange(content, { trickle: true });
  const entry = {
    id: 'fx-preempt',
    year: 1935,
    issue: 'N01',
    format: 'pdf',
    filename: 'fx.bin',
    url: trickle.url,
    labelText: 'fx',
    labelSize: '1M',
  };
  const { chunksDir } = await seedState(dataDir, entry, content);

  const { child, getOutput } = spawnRetrieve(dataDir, ['--budget-ms', '3000', '--cleanup-ms', '2000']);
  let exitInfo = null;
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => ((exitInfo = { code, signal }), resolve())));

  // Wait until a live writer's `.tmp` exists, then preempt exactly there.
  const waitUntil = Date.now() + 8000;
  let sawTmp = false;
  while (Date.now() < waitUntil && !exitInfo) {
    const names = await fs.readdir(chunksDir).catch(() => []);
    if (names.some((n) => n.endsWith('.tmp'))) {
      sawTmp = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(sawTmp, `expected an in-flight .tmp writer; output:\n${getOutput()}`);
  const t0 = Date.now();
  child.kill('SIGTERM');
  await Promise.race([
    exited,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`CLI did not exit after SIGTERM:\n${getOutput()}`)), 15000)),
  ]);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 12000, `CLI exited promptly after SIGTERM (${elapsed}ms)`);
  assert.ok([0, 130].includes(exitInfo.code), `clean exit, got ${JSON.stringify(exitInfo)}\n${getOutput()}`);

  // No writer or temp file may survive the tool boundary.
  const after = await fs.readdir(chunksDir).catch(() => []);
  assert.ok(!after.some((n) => n.endsWith('.tmp')), `no .tmp left behind: ${after.join(',')}`);

  // State must be valid, atomic JSON with the verified chunk preserved.
  const state = await readState(dataDir);
  const eff = state.files[entry.id];
  assert.ok(eff, 'entry still present');
  assert.ok(['in_progress', 'pending'].includes(eff.status), `status ${eff.status}`);
  assert.ok(eff.chunks[0], 'verified chunk 0 preserved (not reset as a validator change)');
  assert.equal(eff.chunks[0].sha256, sha(content.subarray(0, CHUNK)));
  assert.equal(eff.etag, '"v1"', 'validator preserved');
  assert.equal(sha(await fs.readFile(path.join(chunksDir, 'chunk-000000'))), eff.chunks[0].sha256);
  await trickle.close();

  // Cold resume: a FRESH process against a healthy origin, from the same
  // durable state, must finish and publish without re-fetching chunk 0.
  const healthy = await serveRange(content, {});
  const st = await readState(dataDir);
  st.files[entry.id].url = healthy.url;
  await fs.writeFile(path.join(dataDir, 'state', 'files.json'), JSON.stringify(st, null, 2) + '\n');
  const manifest = JSON.parse(await fs.readFile(path.join(dataDir, 'state', 'manifest.json'), 'utf8'));
  manifest.entries[0].url = healthy.url;
  await fs.writeFile(path.join(dataDir, 'state', 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  const r2 = spawnRetrieve(dataDir, ['--budget-ms', '20000', '--cleanup-ms', '5000']);
  const code2 = await new Promise((resolve) => r2.child.on('exit', resolve));
  assert.equal(code2, 0, `resume exit code; output:\n${r2.getOutput()}`);
  const st2 = await readState(dataDir);
  assert.equal(st2.files[entry.id].status, 'published', `expected published; output:\n${r2.getOutput()}`);
  assert.equal(st2.files[entry.id].sha256, sha(content));
  assert.ok(
    !healthy.requests.includes(`bytes=0-${CHUNK - 1}`),
    `verified chunk 0 must not be re-requested: ${healthy.requests.join(' ')}`,
  );
  await healthy.close();
});
