#!/usr/bin/env node
// Bounded batch driver for the all-years Nauka i Zhizn retrieval.
//
// Runs exactly ONE foreground `cli.mjs retrieve` batch, then records the
// durable delta (newly published files/bytes, verified partial bytes) as a
// compact batch record under data/nauka/state/batches/. The CLI republishes the
// canonical all-years master index in its own finally block, so the index is
// always refreshed to match the state this record describes.
//
// The child is a foreground process in the same process group: on SIGINT /
// SIGTERM the driver forwards the signal and the CLI's own shutdown protocol
// drains in-flight requests, writers and oras children. No `timeout` wrapper is
// used, so a cancelled tool call never orphans a writer.
//
// Usage:
//   node tools/nauka/batch.mjs --budget-ms 420000 --cleanup-ms 80000 \
//     [--iteration 4-21] [--note "..."] [--batch 33] [--log data/nauka/state/logs-x.txt]

import { spawn } from 'node:child_process';
import { promises as fs, createWriteStream } from 'node:fs';
import path from 'node:path';
import { PATHS } from './config.mjs';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const STATE_FILE = path.join(PATHS.stateDir, 'files.json');
const MANIFEST_FILE = path.join(PATHS.stateDir, 'manifest.json');
const PARTIAL_INDEX = path.join(PATHS.partialDir, 'partial-index.json');
const BATCH_DIR = path.join(PATHS.stateDir, 'batches');
const CLI = path.join(REPO_ROOT, 'tools', 'nauka', 'cli.mjs');

function log(...a) {
  console.log(new Date().toISOString(), ...a);
}

function getFlag(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

async function snapshot() {
  const state = await readJson(STATE_FILE, { files: {} });
  const manifest = await readJson(MANIFEST_FILE, { entries: [] });
  const partials = await readJson(PARTIAL_INDEX, { partials: {} });
  let published = 0;
  let publishedBytes = 0;
  let remaining = 0;
  for (const e of manifest.entries) {
    const f = state.files[e.id] || {};
    if (f.status === 'published') {
      published++;
      publishedBytes += f.expectedBytes || 0;
    } else {
      remaining++;
    }
  }
  let partialBytes = 0;
  for (const p of Object.values(partials.partials || {})) partialBytes += p.bytes || 0;
  return { published, publishedBytes, remaining, partialBytes, state, manifest };
}

async function nextBatchNumber() {
  let names = [];
  try {
    names = await fs.readdir(BATCH_DIR);
  } catch {
    /* no dir yet */
  }
  let max = 0;
  for (const n of names) {
    const m = /-batch(\d+)\.json$/.exec(n);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

async function main() {
  const args = process.argv.slice(2);
  const budgetMs = Number(getFlag(args, '--budget-ms') || 420000);
  const cleanupMs = Number(getFlag(args, '--cleanup-ms') || 80000);
  const iteration = getFlag(args, '--iteration') || '4-21';
  const note = getFlag(args, '--note') || '';
  const batch = Number(getFlag(args, '--batch') || (await nextBatchNumber()));
  const logFile = getFlag(args, '--log') || path.join(PATHS.stateDir, `logs-${iteration}-batch${batch}.txt`);

  const before = await snapshot();
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  log(`batch ${batch}: publishedBefore=${before.published} remainingBefore=${before.remaining} partialBytes=${before.partialBytes}`);

  await fs.mkdir(path.dirname(logFile), { recursive: true });
  const out = createWriteStream(logFile, { flags: 'a' });
  const child = spawn(process.execPath, [CLI, 'retrieve', '--budget-ms', String(budgetMs), '--cleanup-ms', String(cleanupMs)], {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const forward = (sig) => {
    try {
      child.kill(sig);
    } catch {
      /* already gone */
    }
  };
  const onInt = () => forward('SIGINT');
  const onTerm = () => forward('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  child.stdout.on('data', (d) => {
    process.stdout.write(d);
    out.write(d);
  });
  child.stderr.on('data', (d) => {
    process.stderr.write(d);
    out.write(d);
  });

  const code = await new Promise((resolve) => {
    child.on('close', (c) => resolve(c));
    child.on('error', (err) => {
      log(`child error: ${err.message}`);
      resolve(-1);
    });
  });
  process.off('SIGINT', onInt);
  process.off('SIGTERM', onTerm);
  out.end();

  const elapsedMs = Date.now() - t0;
  const after = await snapshot();
  const publishedThisBatch = [];
  for (const e of after.manifest.entries) {
    const b = before.state.files[e.id] || {};
    const a = after.state.files[e.id] || {};
    if (a.status === 'published' && b.status !== 'published') publishedThisBatch.push(e.id);
  }
  let newBytes = 0;
  for (const id of publishedThisBatch) newBytes += (after.state.files[id] || {}).expectedBytes || 0;

  let receipts = [];
  try {
    const r = await readJson(path.join(PATHS.stateDir, 'master-index-receipt.json'), null);
    if (r) {
      receipts.push({ tag: r.indexTag, digest: r.indexDigest, bytes: r.indexBytes, discoveryStatus: r.discoveryStatus });
      if (r.catalogDigest) receipts.push({ tag: r.catalogTag, digest: r.catalogDigest });
      if (r.checkpointDigest) receipts.push({ tag: r.checkpointTag, digest: r.checkpointDigest });
    }
  } catch {
    /* ignore */
  }

  const record = {
    kind: 'shurik-nauka-batch-record',
    batch,
    iteration,
    startedAt,
    elapsedMs,
    exitCode: code,
    budget: {
      budgetMs,
      cleanupMs,
      concurrency: Number(process.env.NAUKA_CONCURRENCY || 24),
      fileConcurrency: Number(process.env.NAUKA_FILE_CONCURRENCY || 4),
      passBudgetMs: Number(process.env.NAUKA_PASS_MS || 600000),
      minChunkBudgetMs: Number(process.env.NAUKA_MIN_CHUNK_MS || 90000),
    },
    note,
    publishedBefore: before.published,
    publishedAfter: after.published,
    remainingBefore: before.remaining,
    remainingAfter: after.remaining,
    publishedBytesAfter: after.publishedBytes,
    verifiedPartialBytesBefore: before.partialBytes,
    verifiedPartialBytesAfter: after.partialBytes,
    newOriginBytesDurable: newBytes,
    discardedTransferBytes: null,
    failures: code === 0 ? [] : [{ kind: 'batch-exit', error: `cli exit ${code}` }],
    publishedThisBatch,
    checkpointReceipts: receipts,
    nextAction: `Continue bounded smallest-first retrieve batches; remaining ${after.remaining} files.`,
  };
  await fs.mkdir(BATCH_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
  const recFile = path.join(BATCH_DIR, `${ts}-batch${batch}.json`);
  await fs.writeFile(recFile, JSON.stringify(record, null, 2) + '\n');
  log(`batch ${batch} done in ${elapsedMs}ms: published ${before.published}->${after.published} (+${publishedThisBatch.length} files, +${newBytes} B), remaining ${after.remaining}, exit ${code}`);
  log(`record: ${recFile}`);
  if (code !== 0) process.exitCode = 1;
}

main().then(
  () => process.exit(process.exitCode || 0),
  (err) => {
    console.error('FATAL', err && err.stack ? err.stack : err);
    process.exit(1);
  },
);
