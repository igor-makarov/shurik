// Discover every magazine scan linked from the exact 1934-39 index page.
//
// The page is windows-1251 encoded. Its own content is a set of issue tables
// (one per year 1934..1939). The page *also* embeds a generic "Архив этой
// страницы" directory listing that happens to enumerate every year of the
// journal; those rows are plain bullet links, not issue rows, and are out of
// scope. We therefore select <LI> issue rows whose <B> label carries an
// in-scope year, and cross-check the filename year.

import { YEARS, INDEX_URL, entryId, resolveScanUrl } from './config.mjs';

const YEAR_SET = new Set(YEARS.map(String));

// windows-1251 decoder (Node ships full ICU).
const CP1251 = new TextDecoder('windows-1251');

export function decodeIndex(buf) {
  return CP1251.decode(buf);
}

const FILE_RE = /^Nauka_i_jizn',(\d{4}),([^.\[]+)\.\[([a-z0-9]+)\]\.zip$/;
const LABEL_RE = /«Наука и жизнь»,\s*(\d{4}),\s*№\s*([^<]*?)\.?\s*$/;

// Parse the decoded page into entries plus a coverage report.
export function parseIndex(html) {
  const entries = [];
  const seen = new Set();
  const liRe = /<LI>([\s\S]*?)<\/LI>/gi;
  let m;
  while ((m = liRe.exec(html)) !== null) {
    const li = m[1];
    const b = /<B>([\s\S]*?)<\/B>/i.exec(li);
    if (!b) continue;
    const labelText = b[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    const lm = LABEL_RE.exec(labelText);
    if (!lm) continue;
    const labelYear = lm[1];
    if (!YEAR_SET.has(labelYear)) continue; // excludes any other-year rows

    // All scan links inside this issue row.
    const aRe = /<A\s+[^>]*href="([^"]+\.zip)"[^>]*>([^<]*)<\/A>/gi;
    let am;
    const links = [];
    while ((am = aRe.exec(li)) !== null) {
      const href = am[1];
      const fm = FILE_RE.exec(href);
      if (!fm) continue; // not a journal issue archive
      const [, fileYear, issue, format] = fm;
      if (!YEAR_SET.has(fileYear)) continue;
      if (fileYear !== labelYear) continue; // label/filename mismatch guard
      const sizeText = am[2].replace(/\s+/g, ' ').trim();
      links.push({ href, fileYear, issue, format, sizeText });
    }
    if (links.length === 0) continue;

    for (const l of links) {
      const id = entryId({ year: Number(l.fileYear), issue: l.issue, format: l.format });
      if (seen.has(l.href)) continue;
      seen.add(l.href);
      entries.push({
        id,
        year: Number(l.fileYear),
        issue: l.issue,
        format: l.format,
        filename: l.href,
        href: l.href,
        url: resolveScanUrl(l.href),
        labelText,
        labelSize: l.sizeText,
      });
    }
  }

  // Deduplicate by href but keep every issue->file relationship.
  const byHref = new Map();
  for (const e of entries) {
    if (!byHref.has(e.href)) byHref.set(e.href, e);
  }
  const unique = [...byHref.values()];

  return { entries: unique, coverage: coverageReport(unique) };
}

function issueMonths(issue) {
  // "N01" -> [1]; "N08-09" -> [8,9]; "N01p" -> [1]
  const core = issue.replace(/^N/i, '').replace(/[a-z]+$/i, '');
  const parts = core.split('-').map((x) => parseInt(x, 10));
  if (parts.length === 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1])) {
    const out = [];
    for (let i = parts[0]; i <= parts[1]; i++) out.push(i);
    return out;
  }
  return parts.filter(Number.isFinite);
}

export function coverageReport(entries) {
  const byYear = new Map();
  for (const y of YEARS) byYear.set(y, { issues: new Set(), formats: {}, months: new Set(), files: 0 });
  for (const e of entries) {
    const y = byYear.get(e.year);
    if (!y) continue;
    y.issues.add(e.issue);
    y.formats[e.issue] = y.formats[e.issue] || new Set();
    y.formats[e.issue].add(e.format);
    for (const mo of issueMonths(e.issue)) y.months.add(mo);
    y.files += 1;
  }
  const report = {};
  for (const [year, v] of byYear) {
    const missing = [];
    for (let mo = 1; mo <= 12; mo++) if (!v.months.has(mo)) missing.push(mo);
    report[year] = {
      issues: [...v.issues].sort(),
      formats: Object.fromEntries(
        Object.entries(v.formats).map(([k, s]) => [k, [...s].sort()]),
      ),
      coveredMonths: [...v.months].sort((a, b) => a - b),
      missingMonths: missing,
      fileCount: v.files,
    };
  }
  return report;
}

export function manifestFromHtml(html, meta = {}) {
  const { entries, coverage } = parseIndex(html);
  return {
    version: 1,
    indexUrl: INDEX_URL,
    generatedAt: new Date().toISOString(),
    ...meta,
    totalFiles: entries.length,
    years: [...YEARS],
    entries,
    coverage,
  };
}
