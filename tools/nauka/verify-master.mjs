#!/usr/bin/env node
// Verify the published all-years master index by IMMUTABLE DIGEST.
//
// Pulls ghcr.io/igor-makarov/shurik-nauka:nij-master-index back through its
// recorded immutable digest, re-hashes the pulled bytes, re-resolves the tag,
// and inspects representative entries (old 1934-39 published files, newly
// published years, still-pending years). Small JSON only: this never pulls a
// scan blob, so the operator can verify the index without large transfers.
//
// Usage:
//   node tools/nauka/verify-master.mjs [--digest sha256:...] [--no-catalog]
//
// Exit code 0 = all checks passed, 1 = a problem was found.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PATHS, MASTER_INDEX_TAG, MASTER_CATALOG_TAG, MASTER_CHECKPOINT_TAG, REGISTRY } from './config.mjs';
import { Ghcr } from './ghcr.mjs';
import { atomicWriteJson } from './engine.mjs';

function log(...a) {
  console.log(new Date().toISOString(), ...a);
}

function sha256Buf(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function getFlag(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

async function readReceipt() {
  return JSON.parse(await fs.readFile(path.join(PATHS.stateDir, 'master-index-receipt.json'), 'utf8'));
}

// Pull a tag/digest reference into a scratch dir and return {bytes, sha256}.
async function pullAndHash(ghcr, ref, dir) {
  await fs.rm(dir, { recursive: true, force: true });
  await ghcr.pullRef(ref, dir);
  const names = await fs.readdir(dir);
  // oras writes the single layer under its title annotation filename; pick the
  // largest regular file to be robust to any extra metadata blobs.
  let best = null;
  for (const n of names) {
    const st = await fs.stat(path.join(dir, n));
    if (!st.isFile()) continue;
    if (!best || st.size > best.size) best = { n, size: st.size };
  }
  if (!best) throw new Error(`no file pulled for ${ref}`);
  const buf = await fs.readFile(path.join(dir, best.n));
  return { name: best.n, bytes: buf.length, sha256: sha256Buf(buf), buf };
}

async function main() {
  const args = process.argv.slice(2);
  const noCatalog = args.includes('--no-catalog');
  const receipt = await readReceipt();
  const digest = getFlag(args, '--digest') || receipt.indexDigest;
  if (!digest) throw new Error('no index digest available (no receipt and no --digest)');

  const ghcr = await Ghcr.create({ log });
  await ghcr.login();

  const problems = [];

  // 1. Resolve the tag and confirm it still points at the recorded digest.
  let tagDigest = null;
  try {
    tagDigest = await ghcr.resolve(MASTER_INDEX_TAG);
  } catch (err) {
    problems.push(`tag resolve failed: ${err.message}`);
  }
  if (tagDigest && tagDigest !== digest) {
    problems.push(`tag ${MASTER_INDEX_TAG} moved: ${tagDigest} != receipt ${digest}`);
  }

  // 2. Pull the immutable digest back and re-hash its bytes.
  const dir = path.join(PATHS.stagingDir, 'verify-master');
  const pulled = await pullAndHash(ghcr, `${REGISTRY}@${digest}`, dir);
  const master = JSON.parse(pulled.buf.toString('utf8'));

  // 3. Structural sanity: totals must match the per-file array.
  const t = master.totals || {};
  const files = master.files || [];
  if (files.length !== t.files) problems.push(`files length ${files.length} != totals.files ${t.files}`);
  const pubFiles = files.filter((f) => f.published);
  if (pubFiles.length !== t.publishedFiles) problems.push(`published ${pubFiles.length} != totals.publishedFiles ${t.publishedFiles}`);
  if (master.scope !== 'all-years') problems.push(`scope is ${master.scope}, expected all-years`);
  if (!master.discovery || !master.discovery.status) problems.push('missing discovery.status');
  if (!(master.years || []).length) problems.push('no years listed');
  if (!(master.issues || []).length) problems.push('no issues listed');
  // Every published file must carry an immutable GHCR ref and sha256.
  for (const f of pubFiles) {
    if (!f.digest || !String(f.digest).startsWith('sha256:')) problems.push(`${f.id}: published without digest`);
    if (!f.sha256) problems.push(`${f.id}: published without sha256`);
    if (!f.ghcrRef) problems.push(`${f.id}: published without ghcrRef`);
  }
  // Every issue's file ids must exist in the file array.
  const idSet = new Set(files.map((f) => f.id));
  for (const it of master.issues || []) {
    for (const id of it.files || []) if (!idSet.has(id)) problems.push(`issue ${it.key || it.issue}: unknown file id ${id}`);
  }

  // Supplementary archives are published originals too: each must expose an
  // immutable digest + sha256 + pullable ghcrRef (some use legacy tags).
  const supplementaryResolved = [];
  for (const s of master.supplementary || []) {
    if (!s.published) continue;
    if (!s.digest || !String(s.digest).startsWith('sha256:')) problems.push(`supplementary ${s.id}: published without digest`);
    if (!s.sha256) problems.push(`supplementary ${s.id}: published without sha256`);
    if (!s.ghcrRef) problems.push(`supplementary ${s.id}: published without ghcrRef`);
    if (s.tag && s.digest) {
      try {
        const got = await ghcr.resolve(s.tag);
        supplementaryResolved.push({ id: s.id, tag: s.tag, digest: got });
        if (got !== s.digest) problems.push(`supplementary ${s.id}: tag ${s.tag} resolves to ${got} != index digest ${s.digest}`);
      } catch (err) {
        problems.push(`supplementary ${s.id}: tag ${s.tag} did not resolve (${err.message})`);
      }
    }
  }

  // 4. Representative entries across the eras (old subset + new years + pending).
  const pick = (id) => files.find((f) => f.id === id) || null;
  const reps = {};
  const representativeIds = [
    'nij-1934-n01-djv',
    'nij-1939-n01-djv',
    'nij-1893-n01-djv',
    'nij-1953-n06-djv',
    'nij-1972-n10-djv',
    'nij-1992-n03-djv',
    'nij-1948-n01-pdf',
    'nij-2020-n01-pdf',
  ];
  for (const id of representativeIds) {
    const f = pick(id);
    reps[id] = f ? { status: f.status, year: f.year, published: f.published, digest: f.digest } : { missing: true };
    if (!f) problems.push(`representative entry ${id} missing from master index`);
  }

  // 5. Cross-check the published set against durable local state.
  let mismatches = 0;
  try {
    const state = JSON.parse(await fs.readFile(path.join(PATHS.stateDir, 'files.json'), 'utf8'));
    for (const f of files) {
      const eff = state.files[f.id];
      const localPub = !!(eff && eff.status === 'published');
      if (localPub !== !!f.published) {
        mismatches++;
        if (mismatches <= 10) problems.push(`${f.id}: master published=${f.published} but state=${eff ? eff.status : 'missing'}`);
      }
    }
  } catch (err) {
    problems.push(`could not cross-check local state: ${err.message}`);
  }

  const record = {
    kind: 'shurik-nauka-master-index-verification',
    at: new Date().toISOString(),
    tag: MASTER_INDEX_TAG,
    immutableDigest: digest,
    pulledVia: `oras pull ${REGISTRY}@${digest}`,
    pulledBytes: pulled.bytes,
    pulledFileSha256: pulled.sha256,
    pulledFileName: pulled.name,
    tagResolveMatchesDigest: tagDigest === digest,
    discoveryStatus: master.discovery ? master.discovery.status : null,
    totals: t,
    representative: reps,
    supplementaryResolved,
    checks: {
      filesLength: files.length,
      publishedFiles: pubFiles.length,
      publishedFlagMismatchesVsState: mismatches,
      years: (master.years || []).length,
      issues: (master.issues || []).length,
      combinedIssues: (master.issues || []).filter((i) => i.combined).length,
      specialIssues: (master.issues || []).filter((i) => i.special).length,
    },
    problems,
    ok: problems.length === 0,
  };

  // Optionally verify the catalog + checkpoint siblings by digest.
  if (!noCatalog) {
    for (const [name, tag, key] of [
      ['catalog', MASTER_CATALOG_TAG, 'catalogDigest'],
      ['checkpoint', MASTER_CHECKPOINT_TAG, 'checkpointDigest'],
    ]) {
      const d = receipt[key];
      if (!d) continue;
      try {
        const p = await pullAndHash(ghcr, `${REGISTRY}@${d}`, path.join(PATHS.stagingDir, `verify-master-${name}`));
        record[`${name}Verified`] = { digest: d, bytes: p.bytes, sha256: p.sha256 };
        if (name === 'checkpoint') {
          const ck = JSON.parse(p.buf.toString('utf8'));
          record.checkpointPublished = (ck.published || []).length;
          record.checkpointRemaining = (ck.remaining || []).length;
        }
      } catch (err) {
        problems.push(`${name} verify failed: ${err.message}`);
        record.ok = false;
      }
    }
  }

  await atomicWriteJson(path.join(PATHS.stateDir, 'master-index-verification.json'), record);
  await fs.rm(dir, { recursive: true, force: true });
  log(`master index ${MASTER_INDEX_TAG}@${digest}: ${record.ok ? 'OK' : 'PROBLEMS'} (bytes ${pulled.bytes}, files ${t.files}, published ${t.publishedFiles}, status ${record.discoveryStatus})`);
  for (const p of problems) log(`  PROBLEM ${p}`);
  return record.ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error('FATAL', err && err.stack ? err.stack : err);
    process.exit(1);
  },
);
