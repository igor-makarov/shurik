// Master all-years issue index for the Nauka i Zhizn archive.
//
// Pure builder: turns the durable manifest + per-file state into the canonical
// machine-readable master JSON (and a readable Markdown catalog). No network.

import {
  REGISTRY,
  SOURCE_REPO,
  INDEX_URL,
  ARCHIVE_DIR_URL,
  MASTER_INDEX_TAG,
  MASTER_CHECKPOINT_TAG,
  MASTER_CATALOG_TAG,
  INDEX_TAG,
  CHECKPOINT_TAG,
  SUBSET_YEARS,
  entryTag,
  supplementaryId,
} from './config.mjs';

function fileStatus(state, id) {
  const eff = state.files[id];
  return eff ? eff.status : 'pending';
}

// Build the master index document.
export function buildMasterIndex({ manifest, state, generatedAt, baseline = {} }) {
  const now = generatedAt || new Date().toISOString();
  const entries = manifest.entries || [];
  const issues = manifest.issues || [];

  const files = entries.map((e) => {
    const eff = state.files[e.id] || {};
    const published = eff.status === 'published';
    return {
      id: e.id,
      year: e.year,
      issue: e.issue,
      format: e.format,
      filename: e.filename,
      sourcePage: e.sourcePage || null,
      sourceUrl: e.sourceUrl || e.url,
      discoveredVia: e.discoveredVia || (e.synthesized ? 'flat-listing' : 'structured'),
      labelText: e.labelText || null,
      tag: entryTag(e),
      status: eff.status || 'pending',
      published,
      bytes: eff.expectedBytes != null ? eff.expectedBytes : null,
      receivedBytes: eff.receivedBytes != null ? eff.receivedBytes : null,
      sha256: eff.sha256 || null,
      digest: eff.ghcr ? eff.ghcr.digest : null,
      // Prefer the tag actually used at push time (recorded in state); it equals
      // the derived entry tag for every regular file but is authoritative.
      tag: eff.ghcr && eff.ghcr.tag ? eff.ghcr.tag : entryTag(e),
      ghcrRef: eff.ghcr && eff.ghcr.digest ? `${REGISTRY}:${eff.ghcr.tag || entryTag(e)}@${eff.ghcr.digest}` : null,
      publishedAt: eff.publishedAt || null,
      verified: eff.verified ? { ok: eff.verified.ok, at: eff.verified.at } : null,
    };
  });

  const publishedFiles = files.filter((f) => f.published);
  const publishedBytes = publishedFiles.reduce((a, f) => a + (f.bytes || 0), 0);
  const knownBytes = files.reduce((a, f) => a + (f.bytes || 0), 0);
  // Bytes received for files that are not yet published. These are NOT durable:
  // they live only in the per-iteration staging area and are re-verified (and
  // re-fetched if missing) on cold resume, so they must never be reported as
  // durable progress.
  const inFlightReceivedBytes = files.filter((f) => !f.published).reduce((a, f) => a + (f.receivedBytes || 0), 0);
  // Durable partial bytes: chunks verified and pushed as GHCR checkpoint
  // artifacts (eff.checkpoint) for files that are not yet published. Unlike
  // in-flight received bytes, these survive a cold resume.
  const durablePartialBytes = files
    .filter((f) => !f.published)
    .reduce((a, f) => {
      const eff = state.files[f.id];
      return a + ((eff && eff.checkpoint && eff.checkpoint.bytes) || 0);
    }, 0);

  // Per-year coverage with published counts.
  const coverage = {};
  for (const y of manifest.years || []) {
    const c = (manifest.coverage && manifest.coverage[y]) || {};
    const yearFiles = files.filter((f) => f.year === y);
    coverage[y] = {
      issues: c.issues || [],
      issueCount: (c.issues || []).length,
      formats: c.formats || {},
      missingMonths: c.monthly ? c.missingMonths || [] : [],
      monthly: !!c.monthly,
      files: yearFiles.length,
      publishedFiles: yearFiles.filter((f) => f.published).length,
      remainingFiles: yearFiles.filter((f) => !f.published).length,
      knownBytes: yearFiles.reduce((a, f) => a + (f.bytes || 0), 0),
      publishedBytes: yearFiles.filter((f) => f.published).reduce((a, f) => a + (f.bytes || 0), 0),
    };
  }

  const supplementary = ((manifest.directory && manifest.directory.supplementary) || []).map((filename) => {
    const id = supplementaryId(filename);
    const eff = state.files[id] || null;
    return {
      id,
      filename,
      sourcePage: 'archive-directory',
      sourceUrl: ARCHIVE_DIR_URL,
      status: eff ? eff.status : 'pending',
      published: !!(eff && eff.status === 'published'),
      bytes: eff && eff.expectedBytes != null ? eff.expectedBytes : null,
      sha256: eff && eff.sha256 ? eff.sha256 : null,
      digest: eff && eff.ghcr ? eff.ghcr.digest : null,
      // Supplementary archives may have been pushed under a legacy tag that is
      // NOT the supplementaryId (e.g. nij-1998-supplementary-pdf). Record the
      // tag actually used so the immutable reference is pullable.
      tag: eff && eff.ghcr && eff.ghcr.tag ? eff.ghcr.tag : id,
      ghcrRef: eff && eff.ghcr && eff.ghcr.digest ? `${REGISTRY}:${eff.ghcr.tag || id}@${eff.ghcr.digest}` : null,
      verified: eff && eff.verified ? { ok: eff.verified.ok, at: eff.verified.at } : null,
    };
  });

  const issueOut = issues.map((it) => {
    const itFiles = it.files.map((id) => {
      const f = files.find((x) => x.id === id);
      return f ? { id, format: f.format, status: f.status, bytes: f.bytes, sha256: f.sha256, digest: f.digest, tag: f.tag } : { id };
    });
    const publishedCount = itFiles.filter((f) => f.status === 'published').length;
    return {
      key: it.key,
      year: it.year,
      issue: it.issue,
      label: it.label,
      combined: !!it.combined,
      special: !!it.special,
      files: it.files,
      fileCount: it.files.length,
      publishedFiles: publishedCount,
      published: itFiles.length > 0 && publishedCount === itFiles.length,
    };
  });

  const totalIssues = issueOut.length;
  const publishedIssues = issueOut.filter((i) => i.published).length;

  return {
    version: 1,
    kind: 'shurik-nauka-master-index',
    scope: 'all-years',
    magazine: 'Наука и жизнь',
    registry: REGISTRY,
    source: SOURCE_REPO,
    canonicalTag: MASTER_INDEX_TAG,
    checkpointTag: MASTER_CHECKPOINT_TAG,
    catalogTag: MASTER_CATALOG_TAG,
    legacySubsetTag: INDEX_TAG,
    legacySubsetCheckpointTag: CHECKPOINT_TAG,
    archiveRoot: ARCHIVE_DIR_URL,
    discoveryEntryPoint: INDEX_URL,
    generatedAt: now,
    discovery: {
      ...(manifest.discovery || {}),
      eraPages: (manifest.eraPages || []).map((p) => ({
        name: p.name,
        url: p.url,
        label: p.label || null,
        years: p.years || null,
        ok: p.ok,
        bytes: p.bytes,
        sha256: p.sha256,
        structuredRows: p.rows || 0,
        structuredFiles: p.structuredFiles || 0,
        genericFiles: p.genericFiles || 0,
        error: p.error || null,
      })),
      outOfScopePages: manifest.outOfScopePages || [],
      directory: manifest.directory
        ? { url: manifest.directory.url, ok: manifest.directory.ok, bytes: manifest.directory.bytes, sha256: manifest.directory.sha256, files: (manifest.directory.files || []).length, supplementary: supplementary.length }
        : null,
      knownGaps: manifest.knownGaps || {},
    },
    totals: {
      years: (manifest.years || []).length,
      issues: totalIssues,
      publishedIssues,
      files: files.length,
      publishedFiles: publishedFiles.length,
      remainingFiles: files.length - publishedFiles.length,
      knownBytes,
      publishedBytes,
      inFlightReceivedBytes,
      durablePartialBytes,
      supplementaryFiles: supplementary.length,
      supplementaryPublished: supplementary.filter((s) => s.published).length,
    },
    baseline: {
      note: 'completed 1934-1939 subset preserved from the previous objective',
      subsetTag: INDEX_TAG,
      subsetCheckpointTag: CHECKPOINT_TAG,
      subsetYears: SUBSET_YEARS,
      ...baseline,
    },
    coverage,
    years: manifest.years || [],
    issues: issueOut,
    files,
    supplementary,
  };
}

// Build the resume/checkpoint document (compact: what is published / remaining).
export function buildMasterCheckpoint({ master, generatedAt }) {
  return {
    version: 1,
    kind: 'shurik-nauka-master-checkpoint',
    scope: 'all-years',
    generatedAt: generatedAt || master.generatedAt,
    canonicalTag: master.canonicalTag,
    registry: master.registry,
    totals: master.totals,
    discoveryStatus: master.discovery ? master.discovery.status : null,
    published: master.files
      .filter((f) => f.published)
      .map((f) => ({ id: f.id, tag: f.tag, digest: f.digest, sha256: f.sha256, bytes: f.bytes, year: f.year, issue: f.issue, format: f.format })),
    remaining: master.files
      .filter((f) => !f.published)
      .map((f) => ({ id: f.id, year: f.year, issue: f.issue, format: f.format, status: f.status, bytes: f.bytes, receivedBytes: f.receivedBytes })),
  };
}

// Readable Markdown catalog (per-year issue tables with truthful status).
export function buildCatalogMarkdown(master) {
  const L = [];
  L.push(`# Nauka i Zhizn — all-years master issue index`);
  L.push('');
  L.push(`Generated: ${master.generatedAt}`);
  L.push(`Scope: ${master.scope}; discovery status: **${master.discovery ? master.discovery.status : 'unknown'}**`);
  L.push(`Registry: \`${master.registry}\`  |  canonical tag: \`${master.canonicalTag}\``);
  L.push(`Discovery entry point: ${master.discoveryEntryPoint}`);
  L.push('');
  const t = master.totals;
  L.push(`Totals: ${t.years} years, ${t.issues} issues (${t.publishedIssues} fully published), ${t.files} files (${t.publishedFiles} published, ${t.remainingFiles} remaining).`);
  L.push(`Known bytes: ${t.knownBytes}; published bytes: ${t.publishedBytes}; durable partial bytes: ${t.durablePartialBytes} (GHCR-verified chunk checkpoints); in-flight received, not yet durable: ${t.inFlightReceivedBytes}.`);
  L.push('');
  L.push(`## Discovery`);
  const d = master.discovery || {};
  L.push(`- era pages visited: ${d.eraPagesVisited}/${d.eraPagesTotal} (pending ${d.eraPagesPending}, failed ${d.eraPagesFailed})`);
  L.push(`- out-of-scope pages visited: ${d.outOfScopePagesVisited}`);
  L.push(`- archive directory visited: ${d.directoryVisited} (${d.directoryFiles} files, ${d.supplementaryFiles} supplementary)`);
  L.push(`- structured files: ${d.structuredFiles}; flat-listing files: ${d.genericFiles}`);
  const gaps = d.knownGapYears || [];
  L.push(`- known archive gaps (years in an era range with no listed scan): ${gaps.length ? gaps.join(', ') : 'none'}`);
  L.push('');
  L.push(`## Years`);
  L.push('');
  L.push('| Year | Issues | Files | Published | Remaining | Missing months |');
  L.push('|------|--------|-------|-----------|-----------|----------------|');
  for (const y of master.years) {
    const c = master.coverage[y];
    L.push(`| ${y} | ${c.issueCount} | ${c.files} | ${c.publishedFiles} | ${c.remainingFiles} | ${c.monthly ? (c.missingMonths.join(',') || 'none') : 'n/a'} |`);
  }
  L.push('');
  L.push(`## Issues`);
  for (const y of master.years) {
    const ys = master.issues.filter((i) => i.year === y);
    L.push('');
    L.push(`### ${y}`);
    for (const it of ys) {
      const variants = it.files
        .map((id) => {
          const f = master.files.find((x) => x.id === id);
          if (!f) return id;
          const mark = f.published ? '✓' : f.status === 'in_progress' ? '…' : '·';
          return `${mark}${f.format}${f.bytes ? `(${f.bytes})` : ''}`;
        })
        .join(' ');
      const flags = [it.combined ? 'combined' : null, it.special ? 'special' : null].filter(Boolean).join(',');
      L.push(`- №${it.issue}${flags ? ` [${flags}]` : ''}: ${variants}`);
    }
  }
  if (master.supplementary && master.supplementary.length) {
    L.push('');
    L.push(`## Supplementary archives`);
    for (const s of master.supplementary) {
      L.push(`- ${s.published ? '✓' : '·'} ${s.filename}`);
    }
  }
  L.push('');
  L.push(`Legend: ✓ published to GHCR (round-trip verified), … in progress, · pending.`);
  L.push('');
  return L.join('\n');
}
