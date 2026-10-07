// Targeted fixtures for all-years catalog parsing, dedup/merge and the master
// index. No network: everything is synthetic HTML + in-memory state.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeIndex,
  parseStructuredRows,
  parseGenericListing,
  parseEraPage,
  parseIndex,
  issueKey,
  normIssue,
  displayIssue,
  issueMonths,
  coverageReport,
} from '../parse-index.mjs';
import { extractEraPageNames, buildManifest, extractDirectoryFiles, discoverySummary } from '../discover.mjs';
import { buildMasterIndex, buildMasterCheckpoint, buildCatalogMarkdown } from '../master-index.mjs';

const enc = (s) => Buffer.from(s, 'utf8'); // ASCII-only fixtures

// One synthetic era page: two years, a combined issue, a special issue, a
// repeated link and an unrelated non-journal zip.
const ERA_HTML = `
<HTML><BODY>
<DIV><B>Список описываемых изданий:</B>
* <A href="_NiJ_1934-39_.html">1934-39</A> * <A href="_NiJ_1940-49_.html">1940-49</A>
* <A href="_NiJ_stat'i_.html">stat'i</A></DIV>
<TABLE><TR><TD><UL>
<LI><A href="./">x</A><B>«Наука и жизнь», 1934, №01 (пробный выпуск).</B> [<A href="Nauka_i_jizn',1934,N01p.[djv].zip">Djv-19.7M</A>] [<A href="Nauka_i_jizn',1934,N01p.[pdf].zip">Pdf-19.7M</A>] Журнал.</LI>
<LI><A href="./">x</A><B>«Наука и жизнь», 1934, №02.</B> [<A href="Nauka_i_jizn',1934,N02.[djv].zip">Djv- 5.1M</A>] Журнал.</LI>
<LI><A href="./">x</A><B>«Наука и жизнь», 1935, №08-09.</B> [<A href="Nauka_i_jizn',1935,N08-09.[pdf].zip">Pdf-27.1M</A>] Журнал.</LI>
<LI><A href="./">x</A><B>«Наука и жизнь», 1935, №08-09.</B> [<A href="Nauka_i_jizn',1935,N08-09.[pdf].zip">Pdf-27.1M</A>] repeated link.</LI>
<LI><A href="./">x</A><B>«Наука и жизнь», 1934, №01.</B> [<A href="Nauka_i_jizn',1934,N01.[djv].zip">Djv- 5.1M</A>] Журнал.</LI>
</UL></TD></TR></TABLE>
<DIV><B>Архив этой страницы:</B><BR>
* <A href="Nauka_i_jizn',1934,N01p.[djv].zip">Nauka_i_jizn',1934,N01p.[djv].zip</A><BR>
* <A href="Nauka_i_jizn',2014,N01.[pdf].zip">Nauka_i_jizn',2014,N01.[pdf].zip</A><BR>
* <A href="%cd%e0%f3%ea%e0 %e8 %e6%e8%e7%ed%fc (%d3%ea%f0%e0%e8%ed%e0), 2008, %b902.pdf">other journal</A><BR>
</DIV>
</BODY></HTML>`;

test('parseStructuredRows reads issue rows with the year from the filename', () => {
  const rows = parseStructuredRows(ERA_HTML);
  assert.equal(rows.length, 5, 'five issue rows; repeated href is folded later by href');
  const first = rows[0];
  assert.equal(first.labelText, '«Наука и жизнь», 1934, №01 (пробный выпуск).');
  assert.deepEqual(first.links.map((l) => l.issue), ['N01p', 'N01p']);
  assert.deepEqual(first.links.map((l) => l.format), ['djv', 'pdf']);
});

test('generic listing is parsed separately from structured rows', () => {
  const generic = parseGenericListing(ERA_HTML);
  // The flat listing regex is a superset: it captures every journal zip href
  // on the page (structured rows included) plus the listing-only 2014 file.
  assert.equal(generic.length, 6);
  assert.ok(generic.includes("Nauka_i_jizn',2014,N01.[pdf].zip"));
  // The unrelated "(Украина)" journal zip is not a journal issue archive.
  assert.ok(!generic.some((g) => g.includes('%')));
});

test('parseEraPage dedups repeated links and normalises issue identity', () => {
  const { entries } = parseEraPage(ERA_HTML, { page: '_NiJ_1934-39_.html', url: 'u' });
  const ids = entries.map((e) => e.id).sort();
  assert.deepEqual(ids, [
    'nij-1934-n01-djv',
    'nij-1934-n01p-djv',
    'nij-1934-n01p-pdf',
    'nij-1934-n02-djv',
    'nij-1935-n0809-pdf',
  ]);
  const combined = entries.find((e) => e.id === 'nij-1935-n0809-pdf');
  assert.equal(combined.issue, 'N08-09');
  assert.equal(displayIssue(combined.issue), '08-09');
});

test('issue helpers handle combined and special issue numbers', () => {
  assert.equal(normIssue('N08-09'), 'n0809');
  assert.equal(normIssue('N01p'), 'n01p');
  assert.deepEqual(issueMonths('N08-09'), [8, 9]);
  assert.deepEqual(issueMonths('N01p'), [1]);
  assert.equal(issueKey(1935, 'N08-09'), '1935:n0809');
});

test('coverageReport only reports missing months for monthly volumes', () => {
  const { entries } = parseIndex(ERA_HTML);
  const cov = coverageReport(entries);
  assert.equal(cov[1934].monthly, true);
  assert.ok(cov[1934].missingMonths.includes(3));
  // 1935 has a combined 08-09 issue: months 8 and 9 are covered.
  assert.ok(cov[1935].coveredMonths.includes(8));
  assert.ok(cov[1935].coveredMonths.includes(9));
});

test('extractEraPageNames finds era pages and ignores the articles page', () => {
  const names = extractEraPageNames(decodeIndex(enc(ERA_HTML)));
  assert.deepEqual(names, ['_NiJ_1934-39_.html', '_NiJ_1940-49_.html']);
});

test('buildManifest merges pages, dedups repeated source links, fills flat-listing gaps', () => {
  const pageA = parseEraPage(ERA_HTML, { page: '_NiJ_1934-39_.html', url: 'ua' });
  const pageB = parseEraPage(ERA_HTML, { page: '_NiJ_1940-49_.html', url: 'ub' });
  const eraPages = [
    { name: '_NiJ_1934-39_.html', url: 'ua', years: [1934, 1939], ok: true, rows: pageA.rows, entries: pageA.entries, genericFilesList: pageA.genericFiles, genericFiles: pageA.genericFiles.length, structuredFiles: pageA.entries.length },
    { name: '_NiJ_1940-49_.html', url: 'ub', years: [1940, 1949], ok: true, rows: pageB.rows, entries: pageB.entries, genericFilesList: pageB.genericFiles, genericFiles: pageB.genericFiles.length, structuredFiles: pageB.entries.length },
  ];
  const manifest = buildManifest({
    nav: { url: 'nav', sha256: 'abc', bytes: 1 },
    eraPages,
    directory: { ok: true, files: [], supplementary: [] },
    generatedAt: '2026-01-01T00:00:00Z',
  });
  // 5 structured ids + 1 flat-listing-only (2014) = 6 files.
  assert.equal(manifest.totalFiles, 6);
  const ids = manifest.entries.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate file ids');
  const synth = manifest.entries.find((e) => e.id === 'nij-2014-n01-pdf');
  assert.ok(synth && synth.synthesized);
  // Repeated structured link across two pages must not duplicate.
  assert.equal(manifest.entries.filter((e) => e.id === 'nij-1935-n0809-pdf').length, 1);
  // Compatibility aliases for the retrieval engine.
  assert.equal(manifest.indexUrl, 'nav');
  assert.equal(manifest.indexSha256, 'abc');
});

test('buildManifest preserves already-published entries and merges new years', () => {
  const pageA = parseEraPage(ERA_HTML, { page: '_NiJ_1934-39_.html', url: 'ua' });
  const manifest = buildManifest({
    nav: { url: 'nav', sha256: 'abc', bytes: 1 },
    eraPages: [
      { name: '_NiJ_1934-39_.html', url: 'ua', years: [1934, 1939], ok: true, rows: pageA.rows, entries: pageA.entries, genericFilesList: pageA.genericFiles, genericFiles: pageA.genericFiles.length, structuredFiles: pageA.entries.length },
    ],
    directory: { ok: true, files: [], supplementary: [] },
  });
  // Old published ids survive with the same id/tag identity.
  const published = {
    'nij-1934-n01p-djv': { status: 'published', sha256: 'deadbeef', ghcr: { digest: 'sha256:x', tag: 'nij-1934-n01p-djv' }, expectedBytes: 20695251 },
  };
  const state = { version: 1, files: published };
  const master = buildMasterIndex({ manifest, state, generatedAt: '2026-01-01T00:00:00Z' });
  const f = master.files.find((x) => x.id === 'nij-1934-n01p-djv');
  assert.equal(f.published, true);
  assert.equal(f.sha256, 'deadbeef');
  assert.equal(f.digest, 'sha256:x');
  assert.match(f.ghcrRef, /@sha256:x$/);
  // A newly discovered year is present and truthfully pending.
  const nf = master.files.find((x) => x.id === 'nij-2014-n01-pdf');
  assert.equal(nf.status, 'pending');
  assert.equal(nf.published, false);
});

test('master index totals and checkpoint are truthful and consistent', () => {
  const pageA = parseEraPage(ERA_HTML, { page: '_NiJ_1934-39_.html', url: 'ua' });
  const manifest = buildManifest({
    nav: { url: 'nav', sha256: 'abc', bytes: 1 },
    eraPages: [
      { name: '_NiJ_1934-39_.html', url: 'ua', years: [1934, 1939], ok: true, rows: pageA.rows, entries: pageA.entries, genericFilesList: pageA.genericFiles, genericFiles: pageA.genericFiles.length, structuredFiles: pageA.entries.length },
    ],
    directory: { ok: true, files: [], supplementary: [] },
  });
  manifest.discovery = discoverySummary(manifest);
  const state = {
    version: 1,
    files: {
      'nij-1934-n01p-djv': { status: 'published', sha256: 'aa', ghcr: { digest: 'sha256:1' }, expectedBytes: 100 },
      'nij-1934-n01-djv': { status: 'in_progress', receivedBytes: 40, expectedBytes: 100 },
    },
  };
  const master = buildMasterIndex({ manifest, state });
  assert.equal(master.totals.files, master.files.length);
  assert.equal(master.totals.publishedFiles, master.files.filter((f) => f.published).length);
  assert.equal(master.totals.remainingFiles, master.totals.files - master.totals.publishedFiles);
  assert.equal(master.totals.publishedBytes, 100);
  assert.equal(master.totals.receivedPartialBytes, 40);
  // Every issue's file ids exist in the file list.
  const fileIds = new Set(master.files.map((f) => f.id));
  for (const it of master.issues) for (const id of it.files) assert.ok(fileIds.has(id), `issue file ${id} present`);
  const ckpt = buildMasterCheckpoint({ master });
  assert.equal(ckpt.published.length, master.totals.publishedFiles);
  assert.equal(ckpt.remaining.length, master.totals.remainingFiles);
  const md = buildCatalogMarkdown(master);
  assert.match(md, /all-years master issue index/);
  assert.match(md, /Legend/);
});

test('discoverySummary marks a page gap as incomplete, otherwise provisional', () => {
  const complete = discoverySummary({
    eraPages: [{ name: 'a', ok: true }, { name: 'b', ok: true }],
    years: [1934],
    totalFiles: 1,
    totalIssues: 1,
    genericTotal: 1,
    knownGaps: {},
    directory: { ok: true, files: [], supplementary: [] },
  });
  assert.equal(complete.status, 'provisional');
  const incomplete = discoverySummary({
    eraPages: [{ name: 'a', ok: true }, { name: 'b', ok: false, error: 'HTTP 500' }],
    years: [],
    totalFiles: 0,
    totalIssues: 0,
    genericTotal: 0,
    knownGaps: {},
  });
  assert.equal(incomplete.status, 'incomplete');
  assert.equal(incomplete.eraPagesFailed, 1);
});

test('extractDirectoryFiles separates supplementary archives from issue scans', () => {
  const html = '<A HREF="Nauka_i_jizn%27,1934,N01.%5bdjv%5d.zip">x</A> <A HREF="Nauka_i_jizn%27._Izbrannoe._V.03.(1998).%5bpdf%5d.zip">y</A>';
  const { files, supplementary } = extractDirectoryFiles(html);
  assert.equal(files.length, 2);
  assert.deepEqual(supplementary, ["Nauka_i_jizn'._Izbrannoe._V.03.(1998).[pdf].zip"]);
});
