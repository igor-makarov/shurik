// Master-index truthfulness tests: every published original (regular file AND
// supplementary archive) must expose an immutable, pullable GHCR reference.
// Regression: supplementary entries previously omitted tag/ghcrRef, and some
// archives were pushed under a legacy tag that is NOT their supplementaryId.

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildMasterIndex } from '../master-index.mjs';
import { supplementaryId, REGISTRY } from '../config.mjs';

const suppFn = "Nauka_i_jizn'._Izbrannoe._V.03.(1998).[pdf].zip";
const suppId = supplementaryId(suppFn);

function fixture() {
  const manifest = {
    years: [1998],
    entries: [
      { id: 'nij-1998-n01-pdf', year: 1998, issue: 'N01', format: 'pdf', filename: 'a.zip', url: 'https://example/a.zip' },
    ],
    issues: [{ key: 'nij-1998-n01', year: 1998, issue: 'N01', label: 'l', files: ['nij-1998-n01-pdf'] }],
    coverage: { 1998: { issues: ['N01'], formats: {}, monthly: true, missingMonths: [] } },
    discovery: { status: 'complete' },
    eraPages: [],
    directory: { supplementary: [suppFn] },
  };
  const state = {
    files: {
      'nij-1998-n01-pdf': {
        status: 'published',
        expectedBytes: 10,
        sha256: 'a'.repeat(64),
        ghcr: { tag: 'nij-1998-n01-pdf', digest: 'sha256:' + '1'.repeat(64) },
      },
      [suppId]: {
        status: 'published',
        expectedBytes: 20,
        sha256: 'b'.repeat(64),
        // Legacy tag, deliberately different from the supplementaryId.
        ghcr: { tag: 'nij-1998-supplementary-pdf', digest: 'sha256:' + '2'.repeat(64) },
      },
    },
  };
  return { manifest, state };
}

test('published supplementary archives carry tag + immutable ghcrRef', () => {
  const { manifest, state } = fixture();
  const m = buildMasterIndex({ manifest, state, generatedAt: 'X' });
  const s = m.supplementary.find((x) => x.id === suppId);
  assert.equal(s.published, true);
  assert.equal(s.digest, 'sha256:' + '2'.repeat(64));
  assert.equal(s.sha256, 'b'.repeat(64));
  assert.equal(s.tag, 'nij-1998-supplementary-pdf');
  assert.equal(s.ghcrRef, `${REGISTRY}:nij-1998-supplementary-pdf@sha256:${'2'.repeat(64)}`);
});

test('regular published files carry an immutable ghcrRef using the recorded tag', () => {
  const { manifest, state } = fixture();
  const m = buildMasterIndex({ manifest, state, generatedAt: 'X' });
  const f = m.files.find((x) => x.id === 'nij-1998-n01-pdf');
  assert.equal(f.ghcrRef, `${REGISTRY}:nij-1998-n01-pdf@sha256:${'1'.repeat(64)}`);
});

test('unpublished entries never claim a GHCR reference', () => {
  const { manifest } = fixture();
  const state = { files: { [suppId]: { status: 'pending' } } };
  const m = buildMasterIndex({ manifest, state, generatedAt: 'X' });
  const s = m.supplementary.find((x) => x.id === suppId);
  assert.equal(s.published, false);
  assert.equal(s.ghcrRef, null);
});
