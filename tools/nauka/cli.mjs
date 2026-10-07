#!/usr/bin/env node
// Nauka i Zhizn (1934-39) scan retrieval CLI.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  CONFIG,
  PATHS,
  REGISTRY,
  INDEX_URL,
  INDEX_TAG,
  CHECKPOINT_TAG,
  ARTIFACT_TYPE,
  SOURCE_REPO,
  entryTag,
  checkpointTag,
} from './config.mjs';
import { decodeIndex, manifestFromHtml, parseIndex } from './parse-index.mjs';
import { httpGetToFile, TransientError, sleep, jitter } from './http.mjs';
import { Ghcr } from './ghcr.mjs';
import {
  loadState,
  saveState,
  ensureFileEntry,
  loadManifest,
  saveManifest,
  saveIndexEvidence,
  createContext,
  runPass,
  restoreFromGitPartials,
  restoreFromCheckpoints,
  publishFile,
  sha256File,
  sha256Buf,
  atomicWriteJson,
  chunkCount,
  workspaceDir,
  chunksDir,
} from './engine.mjs';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const STATUS_FILE = path.join(REPO_ROOT, 'NAUKA_STATUS.md');
const TOOLS_MANIFEST = path.join(REPO_ROOT, 'tools/nauka/manifest.json');

function log(...a) {
  console.log(new Date().toISOString(), ...a);
}

// ---------------------------------------------------------------------------
// discover
// ---------------------------------------------------------------------------

async function fetchIndexBytes({ offline } = {}) {
  if (offline) {
    return { bytes: await fs.readFile(offline), source: 'offline', fetchedAt: new Date().toISOString() };
  }
  const tmp = path.join(PATHS.stagingDir, 'index.download.html');
  await fs.mkdir(PATHS.stagingDir, { recursive: true });
  let attempts = 0;
  let backoff = 2000;
  for (;;) {
    attempts++;
    try {
      const meta = await httpGetToFile(INDEX_URL, {
        destTmp: tmp,
        idleTimeoutMs: CONFIG.idleTimeoutMs,
        attemptTimeoutMs: 180000,
      });
      const bytes = await fs.readFile(tmp);
      return { bytes, source: INDEX_URL, fetchedAt: new Date().toISOString(), attempts, meta: { status: meta.status } };
    } catch (err) {
      if (attempts >= CONFIG.maxAttemptsPerChunk) throw err;
      log(`index fetch attempt ${attempts} failed: ${err.message}`);
      await sleep(jitter(backoff));
      backoff = Math.min(CONFIG.maxBackoffMs, backoff * 2);
    }
  }
}

async function cmdDiscover(args) {
  const offline = args.includes('--offline') ? args[args.indexOf('--offline') + 1] : null;
  const fetched = await fetchIndexBytes({ offline });
  const sha256 = sha256Buf(fetched.bytes);
  const html = decodeIndex(fetched.bytes);
  const manifest = manifestFromHtml(html, {
    indexSha256: sha256,
    indexBytes: fetched.bytes.length,
    fetchedAt: fetched.fetchedAt,
    fetchSource: fetched.source,
  });
  await saveManifest(manifest);
  // Keep a compact, auditable copy on the work branch too.
  await fs.mkdir(path.dirname(TOOLS_MANIFEST), { recursive: true });
  await atomicWriteJson(TOOLS_MANIFEST, compactManifest(manifest));
  if (!offline) {
    await saveIndexEvidence(fetched.bytes, {
      url: INDEX_URL,
      fetchedAt: fetched.fetchedAt,
      bytes: fetched.bytes.length,
      sha256,
      encoding: 'windows-1251',
      attempts: fetched.attempts,
    });
  }
  log(`discovered ${manifest.totalFiles} files across years ${manifest.years.join(',')}; index sha256=${sha256}`);
  for (const y of manifest.years) {
    const c = manifest.coverage[y];
    log(`  ${y}: ${c.fileCount} files, issues ${c.issues.join(',')}, missing months ${c.missingMonths.join(',') || 'none'}`);
  }
  return manifest;
}

function compactManifest(manifest) {
  return {
    version: 1,
    indexUrl: manifest.indexUrl,
    indexSha256: manifest.indexSha256,
    indexBytes: manifest.indexBytes,
    fetchedAt: manifest.fetchedAt,
    years: manifest.years,
    totalFiles: manifest.totalFiles,
    entries: manifest.entries.map((e) => ({
      id: e.id,
      year: e.year,
      issue: e.issue,
      format: e.format,
      filename: e.filename,
      url: e.url,
      labelText: e.labelText,
      labelSize: e.labelSize,
    })),
    coverage: manifest.coverage,
  };
}

// ---------------------------------------------------------------------------
// GHCR context
// ---------------------------------------------------------------------------

async function makeGhcr() {
  const ghcr = await Ghcr.create({ log });
  await ghcr.login();
  return ghcr;
}

// Reconcile local state with existing GHCR artifacts so verified uploads are
// never restarted from zero.
async function reconcile(ctx) {
  const { state, manifest, ghcr, log } = ctx;
  for (const entry of manifest.entries) {
    const eff = ensureFileEntry(state, entry);
    if (eff.status === 'published') continue;
    const tag = entryTag(entry);
    try {
      const manifestJson = await ghcr.manifest(tag);
      const ann = manifestJson.annotations || {};
      const layer = (manifestJson.layers || []).find((l) => l.annotations?.['org.opencontainers.image.title']);
      const claimed = ann['shurik.nauka.sha256'];
      if (!claimed) continue;
      const digest = await ghcr.resolve(tag);
      const verifyDir = path.join(PATHS.stagingDir, 'reconcile', eff.id);
      await fs.rm(verifyDir, { recursive: true, force: true });
      await ghcr.pull(tag, verifyDir);
      const files = await fs.readdir(verifyDir);
      const pulled = files.find((f) => f.endsWith('.bin') || f === eff.id) || files[0];
      const hash = await sha256File(path.join(verifyDir, pulled));
      await fs.rm(verifyDir, { recursive: true, force: true });
      if (hash === claimed) {
        eff.status = 'published';
        eff.sha256 = claimed;
        eff.ghcr = { tag, digest, title: eff.filename, pushedAt: ann['org.opencontainers.image.created'] || null };
        eff.verified = { at: new Date().toISOString(), pulledSha256: hash, ok: true, recovered: true };
        log(`reconciled already-published ${eff.id} (${digest})`);
      }
    } catch {
      /* tag absent -> not published yet */
    }
  }
  await saveState(state);
}

// ---------------------------------------------------------------------------
// retrieve
// ---------------------------------------------------------------------------

async function cmdRetrieve(args) {
  let manifest = await loadManifest();
  if (!manifest) {
    log('no manifest; running discover first');
    manifest = await cmdDiscover([]);
  }
  const state = await loadState();
  const ghcr = await makeGhcr();
  const ctx = createContext({ state, manifest, ghcr, log });

  await restoreFromGitPartials(state, log);
  await restoreFromCheckpoints(ctx);
  await reconcile(ctx);

  const passes = Number(getFlag(args, '--passes') || 1);
  for (let p = 0; p < passes; p++) {
    log(`=== pass ${p + 1}/${passes} ===`);
    const results = await runPass(ctx);
    log(`pass ${p + 1} results: ${JSON.stringify(results)}`);
    const remaining = remainingCount(state, manifest);
    log(`remaining files: ${remaining}`);
    if (remaining === 0) break;
  }
  await writeStatus(state, manifest, ctx);
}

function getFlag(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

function remainingCount(state, manifest) {
  let n = 0;
  for (const e of manifest.entries) {
    const eff = state.files[e.id];
    if (!eff || eff.status !== 'published') n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// verify / index / status
// ---------------------------------------------------------------------------

async function cmdVerify() {
  const manifest = await loadManifest();
  const state = await loadState();
  const ghcr = await makeGhcr();
  let ok = 0;
  const problems = [];
  for (const entry of manifest.entries) {
    const eff = state.files[entry.id];
    if (!eff || eff.status !== 'published') {
      problems.push(`${entry.id}: not published`);
      continue;
    }
    const tag = entryTag(entry);
    try {
      const digest = await ghcr.resolve(tag);
      const dir = path.join(PATHS.stagingDir, 'verify', entry.id);
      await fs.rm(dir, { recursive: true, force: true });
      await ghcr.pull(tag, dir);
      const files = await fs.readdir(dir);
      const pulled = files.find((f) => f.endsWith('.bin')) || files[0];
      const hash = await sha256File(path.join(dir, pulled));
      await fs.rm(dir, { recursive: true, force: true });
      if (hash !== eff.sha256) problems.push(`${entry.id}: hash mismatch ${hash} != ${eff.sha256}`);
      else if (digest !== eff.ghcr.digest) problems.push(`${entry.id}: digest moved ${digest} != ${eff.ghcr.digest}`);
      else ok++;
    } catch (err) {
      problems.push(`${entry.id}: ${err.message}`);
    }
  }
  log(`verify: ${ok}/${manifest.entries.length} ok; problems: ${problems.length}`);
  for (const p of problems) log(`  PROBLEM ${p}`);
  await writeStatus(state, manifest, { manifest });
  return problems.length === 0;
}

async function cmdIndex() {
  const manifest = await loadManifest();
  const state = await loadState();
  const ghcr = await makeGhcr();
  const files = manifest.entries.map((e) => {
    const eff = state.files[e.id] || {};
    return {
      id: e.id,
      year: e.year,
      issue: e.issue,
      format: e.format,
      filename: e.filename,
      sourceUrl: e.url,
      tag: entryTag(e),
      digest: eff.ghcr ? eff.ghcr.digest : null,
      sha256: eff.sha256 || null,
      bytes: eff.expectedBytes || null,
      status: eff.status || 'pending',
    };
  });
  const published = files.filter((f) => f.status === 'published');
  const indexDoc = {
    version: 1,
    kind: 'shurik-nauka-collection',
    indexUrl: manifest.indexUrl,
    indexSha256: manifest.indexSha256,
    registry: REGISTRY,
    source: SOURCE_REPO,
    generatedAt: new Date().toISOString(),
    totalFiles: files.length,
    publishedFiles: published.length,
    remainingFiles: files.length - published.length,
    coverage: manifest.coverage,
    files,
  };
  const tmpDir = path.join(PATHS.stagingDir, 'index-publish');
  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.mkdir(tmpDir, { recursive: true });
  const indexFile = path.join(tmpDir, 'nij-1934-39-index.json');
  await fs.writeFile(indexFile, JSON.stringify(indexDoc, null, 2) + '\n');
  const res = await ghcr.pushFile(INDEX_TAG, indexFile, {
    title: 'nij-1934-39-index.json',
    annotations: {
      'org.opencontainers.image.title': 'nij-1934-39-index.json',
      'shurik.nauka.kind': 'collection-index',
      'shurik.nauka.total-files': String(files.length),
      'shurik.nauka.published-files': String(published.length),
      'shurik.nauka.index-url': manifest.indexUrl,
    },
  });
  // Resume/checkpoint marker tag.
  const checkpointFile = path.join(tmpDir, 'nij-1934-39-checkpoint.json');
  await fs.writeFile(
    checkpointFile,
    JSON.stringify(
      {
        version: 1,
        kind: 'shurik-nauka-resume-checkpoint',
        generatedAt: new Date().toISOString(),
        published: published.map((f) => ({ id: f.id, tag: f.tag, digest: f.digest, sha256: f.sha256, bytes: f.bytes })),
        remaining: files.filter((f) => f.status !== 'published').map((f) => ({ id: f.id, status: f.status })),
        indexTag: INDEX_TAG,
      },
      null,
      2,
    ) + '\n',
  );
  const res2 = await ghcr.pushFile(CHECKPOINT_TAG, checkpointFile, {
    title: 'nij-1934-39-checkpoint.json',
    annotations: {
      'org.opencontainers.image.title': 'nij-1934-39-checkpoint.json',
      'shurik.nauka.kind': 'resume-checkpoint',
    },
  });
  log(`published index ${INDEX_TAG} -> ${res.digest}`);
  log(`published checkpoint ${CHECKPOINT_TAG} -> ${res2.digest}`);
  await writeStatus(state, manifest, { manifest });
}

async function cmdStatus() {
  const manifest = await loadManifest();
  const state = await loadState();
  await writeStatus(state, manifest, { manifest });
}

// ---------------------------------------------------------------------------
// status report
// ---------------------------------------------------------------------------

async function writeStatus(state, manifest, ctx) {
  if (!manifest) return;
  const entries = manifest.entries;
  const byYear = new Map();
  const counts = { published: 0, in_progress: 0, pending: 0, unavailable: 0 };
  const verified = [];
  const retryable = [];
  const permanent = [];
  let bytesPublished = 0;
  let bytesTotal = 0;
  for (const e of entries) {
    const eff = state.files[e.id] || { status: 'pending' };
    counts[eff.status] = (counts[eff.status] || 0) + 1;
    if (!byYear.has(e.year)) byYear.set(e.year, { total: 0, published: 0 });
    const y = byYear.get(e.year);
    y.total++;
    if (eff.status === 'published') {
      y.published++;
      bytesPublished += eff.expectedBytes || 0;
      verified.push(`- \`${entryTag(e)}\` @ \`${eff.ghcr?.digest}\` — ${eff.filename} (${eff.expectedBytes || '?'} B, sha256 ${String(eff.sha256).slice(0, 16)}…)`);
    } else if (eff.status === 'unavailable') {
      permanent.push(`- ${e.id}: ${eff.lastError || 'unavailable'}`);
    } else {
      retryable.push(`- ${e.id}: ${eff.status} ${eff.receivedBytes || 0}/${eff.expectedBytes || '?'} B (${eff.lastError || 'no error'})`);
    }
    bytesTotal += eff.expectedBytes || 0;
  }
  const lines = [];
  lines.push('# NAUKA_STATUS — Nauka i Zhizn 1934-39 scan retrieval');
  lines.push('');
  lines.push(`Updated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('## Index evidence');
  lines.push(`- Index URL: ${manifest.indexUrl}`);
  lines.push(`- Index sha256 (windows-1251 bytes): \`${manifest.indexSha256}\``);
  lines.push(`- Index bytes: ${manifest.indexBytes}`);
  lines.push(`- Discovered scan files: ${entries.length} (years ${manifest.years.join(', ')})`);
  lines.push(`- Manifest (tracked copy): \`tools/nauka/manifest.json\`; raw index preserved at \`data/nauka/state/evidence/index.cp1251.html\``);
  lines.push('');
  lines.push('## Totals');
  lines.push(`- discovered: ${entries.length}`);
  lines.push(`- published (GHCR, round-trip verified): ${counts.published}`);
  lines.push(`- in progress: ${counts.in_progress}`);
  lines.push(`- pending: ${counts.pending}`);
  lines.push(`- unavailable/permanent: ${counts.unavailable}`);
  lines.push(`- remaining: ${entries.length - counts.published}`);
  lines.push(`- bytes published: ${bytesPublished} / ${bytesTotal || 'unknown'}`);
  lines.push('');
  lines.push('## Per year');
  for (const [year, y] of [...byYear.entries()].sort()) {
    const c = manifest.coverage[year];
    lines.push(`- ${year}: ${y.published}/${y.total} published; missing months: ${c.missingMonths.join(',') || 'none'}`);
  }
  lines.push('');
  lines.push('## Registry');
  lines.push(`- Registry: ${REGISTRY}`);
  lines.push(`- Source annotation: ${SOURCE_REPO}`);
  lines.push(`- Artifact type: ${ARTIFACT_TYPE}`);
  lines.push(`- Collection/index tag: ${INDEX_TAG}`);
  lines.push(`- Resume/checkpoint tag: ${CHECKPOINT_TAG}`);
  lines.push(`- Per-file tags: \`nij-<year>-<issue>-<format>\``);
  lines.push('');
  lines.push('## Verified GHCR references');
  lines.push(verified.length ? verified.join('\n') : '- (none yet)');
  lines.push('');
  lines.push('## Retryable / in-progress');
  lines.push(retryable.length ? retryable.join('\n') : '- (none)');
  lines.push('');
  lines.push('## Unavailable (permanent)');
  lines.push(permanent.length ? permanent.join('\n') : '- (none)');
  lines.push('');
  lines.push('## Throttle and retry settings');
  lines.push(`- aggregate bandwidth cap: ${CONFIG.bandwidthLimitBps} B/s`);
  lines.push(`- concurrency: ${CONFIG.maxConcurrency} connections`);
  lines.push(`- chunk size: ${CONFIG.chunkSize} B`);
  lines.push(`- request-start gap: ${CONFIG.requestGapMs} ms`);
  lines.push(`- retries/chunk: ${CONFIG.maxAttemptsPerChunk}; backoff ${CONFIG.baseBackoffMs}-${CONFIG.maxBackoffMs} ms with jitter`);
  lines.push('');
  lines.push('## Commands (list / pull / resume)');
  lines.push('```bash');
  lines.push(`oras repo tags ${REGISTRY} | sort`);
  lines.push(`oras manifest fetch ${REGISTRY}:${INDEX_TAG} | jq .`);
  lines.push(`oras pull ${REGISTRY}:nij-1939-n01-djv -o ./out`);
  lines.push('node tools/nauka/cli.mjs discover');
  lines.push('node tools/nauka/cli.mjs retrieve --passes 4');
  lines.push('node tools/nauka/cli.mjs verify');
  lines.push('node tools/nauka/cli.mjs index');
  lines.push('```');
  lines.push('');
  await fs.writeFile(STATUS_FILE, lines.join('\n') + '\n');
}

// ---------------------------------------------------------------------------

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'discover':
      await cmdDiscover(args);
      break;
    case 'retrieve':
      await cmdRetrieve(args);
      break;
    case 'verify':
      await cmdVerify();
      break;
    case 'index':
      await cmdIndex();
      break;
    case 'status':
      await cmdStatus();
      break;
    default:
      console.error('usage: cli.mjs <discover|retrieve|verify|index|status> [args]');
      process.exit(2);
  }
}

main().catch((err) => {
  console.error('FATAL', err && err.stack ? err.stack : err);
  process.exit(1);
});
