// All-years discovery for the Nauka i Zhizn magazine archive.
//
// Fetches the magazine's era index pages (throttled, resumable, cached on the
// control branch), parses their structured issue rows plus the flat directory
// listing, and merges everything into one durable manifest that preserves the
// already-published 1934-1939 records.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  INDEX_URL,
  ARCHIVE_DIR_URL,
  ERA_PAGE_NAMES,
  OUT_OF_SCOPE_PAGES,
  PATHS,
  eraPageUrl,
  eraYearRange,
  eraPageLabel,
  entryId,
  resolveScanUrl,
} from './config.mjs';
import {
  decodeIndex,
  parseEraPage,
  parseGenericListing,
  parseStructuredRows,
  FILE_RE,
  normIssue,
  issueKey,
  displayIssue,
  coverageReport,
  issueSort,
} from './parse-index.mjs';
import { httpGetToFile, sleep, jitter } from './http.mjs';
import { sha256Buf, atomicWriteJson } from './engine.mjs';

export const ERA_EVIDENCE_DIR = path.join(PATHS.stateDir, 'evidence', 'eras');
const FETCH_META = path.join(ERA_EVIDENCE_DIR, 'fetch-meta.json');

export function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

// Extract the era page names linked from a nav/era page's own table. No year
// restriction: any `_NiJ_<range>_.html` link counts.
export function extractEraPageNames(html) {
  const out = [];
  const seen = new Set();
  const re = /href="(_NiJ_(\d{4})-(\d{2,4})_\.html)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push(m[1]);
  }
  return out;
}

async function readCached(dest) {
  try {
    const buf = await fs.readFile(dest);
    return buf;
  } catch {
    return null;
  }
}

// Fetch one page into the evidence dir. Cached bytes are reused unless refresh
// is requested; every network attempt is throttled and retried with jitter.
export async function fetchPage(url, dest, { log = () => {}, refresh = false, attempts = 4 } = {}) {
  if (!refresh) {
    const cached = await readCached(dest);
    if (cached) return { ok: true, bytes: cached.length, sha256: sha256Buf(cached), cached: true };
  }
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp`;
  let backoff = 2000;
  let error = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const meta = await httpGetToFile(url, { destTmp: tmp, idleTimeoutMs: 30000, attemptTimeoutMs: 90000 });
      const buf = await fs.readFile(tmp);
      if (meta.status !== 200) throw new Error(`HTTP ${meta.status}`);
      await fs.writeFile(dest, buf);
      await fs.rm(tmp, { force: true });
      return { ok: true, bytes: buf.length, sha256: sha256Buf(buf), attempts: attempt };
    } catch (err) {
      error = err.message;
      log(`fetch ${url} attempt ${attempt} failed: ${err.message}`);
      await fs.rm(tmp, { force: true });
      if (attempt < attempts) {
        await sleep(jitter(backoff));
        backoff = Math.min(120000, backoff * 2);
      }
    }
  }
  return { ok: false, bytes: 0, sha256: null, error };
}

// Build one file entry from a bare href (generic-listing only file).
function entryFromHref(href, { page = null, url = null } = {}) {
  const fm = FILE_RE.exec(href);
  if (!fm) return null;
  const [, year, issue, format] = fm;
  return {
    id: entryId({ year: Number(year), issue, format }),
    year: Number(year),
    issue,
    format,
    filename: href,
    href,
    url: resolveScanUrl(href),
    labelText: `«Наука и жизнь», ${year}, №${displayIssue(issue)}.`,
    labelSize: null,
    sourcePage: page,
    sourceUrl: url,
    synthesized: true,
  };
}

// Merge parsed era pages + the flat listing into a single all-years manifest.
export function buildManifest({ nav, eraPages, directory, generatedAt }) {
  const fileMap = new Map(); // href -> entry
  const addFile = (entry) => {
    if (!entry) return;
    const prev = fileMap.get(entry.href);
    if (!prev) {
      fileMap.set(entry.href, { ...entry, sourcePages: entry.sourcePage ? [entry.sourcePage] : [] });
      return;
    }
    if (entry.sourcePage && !prev.sourcePages.includes(entry.sourcePage)) prev.sourcePages.push(entry.sourcePage);
    // A structured row is richer than a synthesized generic entry.
    if (prev.synthesized && !entry.synthesized) {
      const pages = prev.sourcePages;
      Object.assign(prev, entry, { sourcePages: pages });
    }
  };

  for (const page of eraPages) {
    for (const e of page.entries || []) addFile({ ...e, sourcePage: page.name, sourceUrl: page.url });
  }
  // Flat listing union across all pages (identical on every page; this also
  // catches files the structured rows omit, e.g. 2014/2015 pdf).
  const genericByHref = new Map();
  for (const page of eraPages) {
    for (const href of page.genericFilesList || []) {
      if (!genericByHref.has(href)) genericByHref.set(href, []);
      genericByHref.get(href).push(page.name);
    }
  }
  for (const [href, pages] of genericByHref) {
    const entry = entryFromHref(href, { page: pages[0], url: eraPageUrl(pages[0]) });
    if (!entry) continue;
    if (fileMap.has(href)) {
      const prev = fileMap.get(href);
      for (const p of pages) if (!prev.sourcePages.includes(p)) prev.sourcePages.push(p);
    } else {
      entry.sourcePages = pages;
      fileMap.set(href, entry);
    }
  }

  const entries = [...fileMap.values()].sort((a, b) => {
    if (a.year !== b.year) return a.year - b.year;
    const io = issueSort(a.issue, b.issue);
    if (io !== 0) return io;
    return a.format.localeCompare(b.format);
  });

  // Issue identities: (year, issue) -> file variants.
  const issueMap = new Map();
  for (const e of entries) {
    const key = issueKey(e.year, e.issue);
    let it = issueMap.get(key);
    if (!it) {
      it = { key, year: e.year, issue: displayIssue(e.issue), issueRaw: e.issue, label: e.labelText, files: [], synthesized: e.synthesized };
      issueMap.set(key, it);
    }
    if (!it.synthesized && e.synthesized) {
      it.label = e.labelText;
      it.synthesized = false;
    }
    it.files.push(e.id);
    it.combined = /-/.test(displayIssue(e.issue));
    it.special = /[a-z]/i.test(displayIssue(e.issue).replace(/^N/i, ''));
  }
  const issues = [...issueMap.values()].sort((a, b) => {
    if (a.year !== b.year) return a.year - b.year;
    return issueSort(a.issueRaw, b.issueRaw);
  });

  // Coverage + known gaps.
  const coverage = coverageReport(entries);
  const yearsPresent = [...new Set(entries.map((e) => e.year))].sort((a, b) => a - b);
  const knownGaps = {};
  for (const page of eraPages) {
    const range = eraYearRange(page.name);
    if (!range) continue;
    const missing = [];
    for (let y = range[0]; y <= range[1]; y++) if (!coverage[y]) missing.push(y);
    knownGaps[page.name] = { range, missingYears: missing };
  }

  const byYearCounts = {};
  for (const y of yearsPresent) {
    const c = coverage[y];
    byYearCounts[y] = { files: c.fileCount, issues: c.issues.length, published: 0 };
  }

  return {
    version: 2,
    kind: 'shurik-nauka-all-years-manifest',
    scope: 'all-years',
    generatedAt: generatedAt || new Date().toISOString(),
    nav: nav || null,
    directory: directory || null,
    eraPages,
    years: yearsPresent,
    totalFiles: entries.length,
    totalIssues: issues.length,
    entries,
    issues,
    coverage,
    knownGaps,
    byYearCounts,
    // The generic listing is the archive's own flat inventory; record whether
    // every file it names is represented.
    genericTotal: genericByHref.size,
    genericUnrepresented: [...genericByHref.keys()].filter((h) => !fileMap.has(h)),
  };
}

// Extract the supplementary "Избранное" archives from the directory listing.
export function extractDirectoryFiles(html) {
  const all = new Set();
  const supp = new Set();
  const re = /HREF="([^"]+\.zip)"/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    let name;
    try {
      name = decodeURIComponent(m[1]);
    } catch {
      name = m[1];
    }
    if (!/^Nauka_i_jizn/.test(name)) continue;
    all.add(name);
    if (!FILE_RE.test(name)) supp.add(name);
  }
  return { files: [...all], supplementary: [...supp] };
}

// Full discovery run. Returns { manifest, fetchReport }.
export async function discoverAll({ log = () => {}, refresh = false, navBytes = null } = {}) {
  const navUrl = INDEX_URL;
  const navDest = path.join(PATHS.stateDir, 'evidence', 'index.cp1251.html');
  let nav = null;
  let navBuf = navBytes;
  if (!navBuf) {
    const cached = await readCached(navDest);
    if (cached && !refresh) navBuf = cached;
  }
  if (!navBuf) {
    const r = await fetchPage(navUrl, navDest, { log, refresh });
    if (!r.ok) throw new Error(`nav page fetch failed: ${r.error}`);
    navBuf = await fs.readFile(navDest);
  }
  nav = { url: navUrl, sha256: sha256Buf(navBuf), bytes: navBuf.length };
  const navHtml = decodeIndex(navBuf);

  let names = extractEraPageNames(navHtml);
  if (names.length === 0) names = [...ERA_PAGE_NAMES];
  // Always include the conservative list so a nav-page change cannot silently
  // drop a known era.
  for (const n of ERA_PAGE_NAMES) if (!names.includes(n)) names.push(n);

  const eraPages = [];
  for (const name of names) {
    const url = eraPageUrl(name);
    const dest = path.join(ERA_EVIDENCE_DIR, name);
    const r = await fetchPage(url, dest, { log, refresh });
    const page = {
      name,
      url,
      label: eraPageLabel(name),
      years: eraYearRange(name),
      sha256: r.sha256,
      bytes: r.bytes,
      ok: r.ok,
      cached: !!r.cached,
      error: r.error || null,
      fetchedAt: new Date().toISOString(),
      rows: 0,
      structuredFiles: 0,
      genericFiles: 0,
      entries: [],
      genericFilesList: [],
    };
    if (r.ok) {
      const buf = await fs.readFile(dest);
      const html = decodeIndex(buf);
      const parsed = parseEraPage(html, { page: name, url });
      page.rows = parsed.rows;
      page.entries = parsed.entries;
      page.structuredFiles = parsed.entries.length;
      page.genericFilesList = parsed.genericFiles;
      page.genericFiles = parsed.genericFiles.length;
    }
    eraPages.push(page);
  }

  // Directory listing (cross-check + supplementary archives).
  let directory = null;
  try {
    const dirDest = path.join(PATHS.stateDir, 'evidence', 'archive-dir.html');
    const r = await fetchPage(ARCHIVE_DIR_URL, dirDest, { log, refresh });
    if (r.ok) {
      const buf = await fs.readFile(dirDest);
      const extracted = extractDirectoryFiles(decodeIndex(buf));
      directory = {
        url: ARCHIVE_DIR_URL,
        sha256: r.sha256,
        bytes: r.bytes,
        ok: true,
        files: extracted.files,
        supplementary: extracted.supplementary,
      };
    } else {
      directory = { url: ARCHIVE_DIR_URL, ok: false, error: r.error };
    }
  } catch (err) {
    directory = { url: ARCHIVE_DIR_URL, ok: false, error: err.message };
  }

  // Record out-of-scope pages as visited so the master never claims a gap.
  const outOfScope = [];
  for (const name of OUT_OF_SCOPE_PAGES) {
    const dest = path.join(ERA_EVIDENCE_DIR, name);
    const r = await fetchPage(eraPageUrl(name), dest, { log, refresh });
    outOfScope.push({ name, url: eraPageUrl(name), ok: r.ok, bytes: r.bytes, sha256: r.sha256, error: r.error || null });
  }

  const manifest = buildManifest({ nav, eraPages, directory, generatedAt: new Date().toISOString() });
  manifest.outOfScopePages = outOfScope;
  manifest.discovery = discoverySummary(manifest);
  await atomicWriteJson(FETCH_META, {
    generatedAt: manifest.generatedAt,
    nav,
    eraPages: eraPages.map((p) => ({
      name: p.name,
      url: p.url,
      ok: p.ok,
      cached: p.cached,
      bytes: p.bytes,
      sha256: p.sha256,
      rows: p.rows,
      structuredFiles: p.structuredFiles,
      genericFiles: p.genericFiles,
      error: p.error,
    })),
    directory: directory ? { url: directory.url, ok: directory.ok, bytes: directory.bytes, sha256: directory.sha256, files: directory.files.length, supplementary: directory.supplementary.length } : null,
    outOfScope,
  });
  return { manifest, nav };
}

export function discoverySummary(manifest) {
  const eraPages = manifest.eraPages || [];
  const visited = eraPages.filter((p) => p.ok).length;
  const pending = eraPages.filter((p) => !p.ok).length;
  const failed = eraPages.filter((p) => p.ok === false && p.error).length;
  const structured = eraPages.reduce((a, p) => a + (p.structuredFiles || 0), 0);
  const generic = manifest.genericTotal || 0;
  const supp = (manifest.directory && manifest.directory.supplementary) || [];
  return {
    scope: 'all-years',
    status: pending > 0 ? 'incomplete' : 'provisional',
    eraPagesTotal: eraPages.length,
    eraPagesVisited: visited,
    eraPagesPending: pending,
    eraPagesFailed: failed,
    outOfScopePagesVisited: (manifest.outOfScopePages || []).filter((p) => p.ok).length,
    directoryVisited: !!(manifest.directory && manifest.directory.ok),
    directoryFiles: manifest.directory ? manifest.directory.files.length : 0,
    structuredFiles: structured,
    genericFiles: generic,
    supplementaryFiles: supp.length,
    totalFiles: manifest.totalFiles,
    totalIssues: manifest.totalIssues,
    years: manifest.years,
    knownGapYears: Object.values(manifest.knownGaps || {}).flatMap((g) => g.missingYears),
    note: 'provisional: era pages visited and parsed; status flips to complete only after every linked era page is visited and represented',
  };
}

export { FETCH_META };
