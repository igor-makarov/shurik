// Discovery parsing for the Nauka i Zhizn magazine archive.
//
// Every era page (e.g. _NiJ_1934-39_.html, _NiJ_1940-49_.html, ...) is
// windows-1251 encoded and contains two relevant structures:
//
//   1. Structured issue rows: `<LI>...<B>«Наука и жизнь», YYYY, №ISSUE.</B>
//      [<A href="Nauka_i_jizn',YYYY,ISSUE.[fmt].zip">Djv-…</A>] …</LI>`.
//      These give the issue identity (year + issue number) and its file
//      variants. The issue number is taken from the *filename* (robust against
//      labels like "№01 (пробный выпуск)").
//
//   2. A flat "Архив этой страницы" directory listing embedded on every page:
//      `<BR>* <A href="Nauka_i_jizn',YYYY,ISSUE.[fmt].zip">filename</A>`.
//      Identical on every era page; it enumerates every scan the archive
//      currently hosts and is the cross-check / gap-filler for the structured
//      rows.
//
// There is no hard-coded year restriction: years come from the filenames.

import { entryId, resolveScanUrl } from './config.mjs';

const CP1251 = new TextDecoder('windows-1251');

export function decodeIndex(buf) {
  return CP1251.decode(buf);
}

export const FILE_RE = /^Nauka_i_jizn',(\d{4}),([^.\[]+)\.\[([a-z0-9]+)\]\.zip$/;
export const LABEL_RE = /«Наука и жизнь»,\s*(\d{4}),\s*№\s*([^<]*?)\.?\s*$/;

// Normalised issue key fragment: "N08-09" -> "n0809", "N01p" -> "n01p".
export function normIssue(issue) {
  return String(issue).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function issueKey(year, issue) {
  return `${year}:${normIssue(issue)}`;
}

// Display issue number: "N01" -> "01", "N08-09" -> "08-09", "N01p" -> "01p".
export function displayIssue(issue) {
  return String(issue).replace(/^N/i, '');
}

// The numeric month(s) an issue number covers, when they are unambiguous.
// "N01" -> [1]; "N08-09" -> [8,9]; "N01p" -> [1]; "N12-13" -> [12,13].
export function issueMonths(issue) {
  const core = String(issue).replace(/^N/i, '').replace(/[a-z]+$/i, '');
  const parts = core.split('-').map((x) => parseInt(x, 10));
  if (parts.length === 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1])) {
    const out = [];
    for (let i = parts[0]; i <= parts[1]; i++) out.push(i);
    return out;
  }
  return parts.filter(Number.isFinite);
}

// Structured issue rows of one era page.
export function parseStructuredRows(html) {
  const rows = [];
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
    const aRe = /<A\s+[^>]*href="([^"]+\.zip)"[^>]*>([^<]*)<\/A>/gi;
    let am;
    const links = [];
    while ((am = aRe.exec(li)) !== null) {
      const href = am[1];
      const fm = FILE_RE.exec(href);
      if (!fm) continue; // not a journal issue archive
      const [, fileYear, issue, format] = fm;
      if (fileYear !== labelYear) continue; // label/filename mismatch guard
      links.push({ href, fileYear, issue, format, sizeText: am[2].replace(/\s+/g, ' ').trim() });
    }
    if (links.length === 0) continue;
    rows.push({ labelText, labelYear, links });
  }
  return rows;
}

// The flat "Архив этой страницы" listing (all scan files the archive hosts).
export function parseGenericListing(html) {
  const out = [];
  const seen = new Set();
  const re = /href="(Nauka_i_jizn',\d{4},[^"]+\.zip)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push(m[1]);
  }
  return out;
}

// Parse one era page: structured file entries + the generic listing.
export function parseEraPage(html, { page = null, url = null } = {}) {
  const rows = parseStructuredRows(html);
  const byHref = new Map();
  for (const row of rows) {
    for (const l of row.links) {
      if (byHref.has(l.href)) continue;
      byHref.set(l.href, {
        id: entryId({ year: Number(l.fileYear), issue: l.issue, format: l.format }),
        year: Number(l.fileYear),
        issue: l.issue,
        format: l.format,
        filename: l.href,
        href: l.href,
        url: resolveScanUrl(l.href),
        labelText: row.labelText,
        labelSize: l.sizeText,
        sourcePage: page,
        sourceUrl: url,
      });
    }
  }
  return {
    page,
    url,
    rows: rows.length,
    entries: [...byHref.values()],
    genericFiles: parseGenericListing(html),
  };
}

// Backwards-compatible single-page parse (used by tests/verification). No year
// restriction: every structured row of the page is returned.
export function parseIndex(html) {
  const byHref = new Map();
  for (const row of parseStructuredRows(html)) {
    for (const l of row.links) {
      if (byHref.has(l.href)) continue;
      byHref.set(l.href, {
        id: entryId({ year: Number(l.fileYear), issue: l.issue, format: l.format }),
        year: Number(l.fileYear),
        issue: l.issue,
        format: l.format,
        filename: l.href,
        href: l.href,
        url: resolveScanUrl(l.href),
        labelText: row.labelText,
        labelSize: l.sizeText,
      });
    }
  }
  const entries = [...byHref.values()];
  return { entries, coverage: coverageReport(entries) };
}

// Per-year coverage. `missingMonths` is only reported for years whose issue
// numbers all fall in 1..12, so a 26-issue volume never invents gaps.
export function coverageReport(entries) {
  const byYear = new Map();
  for (const e of entries) {
    if (!byYear.has(e.year)) {
      byYear.set(e.year, { issues: new Set(), formats: {}, months: new Set(), files: 0, maxMonth: 0 });
    }
    const y = byYear.get(e.year);
    y.issues.add(e.issue);
    y.formats[e.issue] = y.formats[e.issue] || new Set();
    y.formats[e.issue].add(e.format);
    const months = issueMonths(e.issue);
    for (const mo of months) {
      y.months.add(mo);
      if (mo > y.maxMonth) y.maxMonth = mo;
    }
    y.files += 1;
  }
  const report = {};
  for (const [year, v] of byYear) {
    const issues = [...v.issues].sort(issueSort);
    const monthly = v.maxMonth <= 12;
    const missing = [];
    if (monthly) for (let mo = 1; mo <= 12; mo++) if (!v.months.has(mo)) missing.push(mo);
    report[year] = {
      issues,
      formats: Object.fromEntries(
        Object.entries(v.formats).map(([k, s]) => [k, [...s].sort()]),
      ),
      coveredMonths: [...v.months].sort((a, b) => a - b),
      missingMonths: missing,
      monthly,
      fileCount: v.files,
    };
  }
  return report;
}

// Natural sort for issue numbers: "01" < "02" < "08-09" < "10" < "11-12".
export function issueSort(a, b) {
  const na = parseInt(String(a).replace(/^N/i, ''), 10);
  const nb = parseInt(String(b).replace(/^N/i, ''), 10);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return String(a).localeCompare(String(b));
}

// Keep the historical single-page helper name working.
export function manifestFromHtml(html, meta = {}) {
  const { entries, coverage } = parseIndex(html);
  const years = [...new Set(entries.map((e) => e.year))].sort();
  return {
    version: 1,
    indexUrl: meta.indexUrl,
    generatedAt: new Date().toISOString(),
    ...meta,
    totalFiles: entries.length,
    years,
    entries,
    coverage,
  };
}
