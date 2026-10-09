// Tag/id identity tests: regular entries keep their year+issue+format tag, and
// multi-volume supplementary archives get distinct, unique tags (the two 2001
// Izbrannoe volumes previously collided).

import test from 'node:test';
import assert from 'node:assert/strict';

import { entryId, entryTag, supplementaryId } from '../config.mjs';

test('regular entries: id equals the derived tag', () => {
  const e = { id: 'nij-1893-n1213-djv', year: 1893, issue: 'N12-13', format: 'djv' };
  assert.equal(entryId(e), e.id);
  assert.equal(entryTag(e), e.id);
});

test('entryTag falls back to entryId when no id is present', () => {
  assert.equal(entryTag({ year: 1998, issue: 'supplementary', format: 'pdf' }), 'nij-1998-supplementary-pdf');
});

test('supplementary ids are unique per volume even in the same year', () => {
  const v13 = "Nauka_i_jizn'._Izbrannoe._V.13.(2001).[pdf].zip";
  const v14 = "Nauka_i_jizn'._Izbrannoe._V.14.(2001).[pdf].zip";
  const id13 = supplementaryId(v13);
  const id14 = supplementaryId(v14);
  assert.notEqual(id13, id14);
  assert.equal(id13, 'nij-supp-nauka-i-jizn-izbrannoe-v-13-2001-pdf-zip');
  assert.equal(id14, 'nij-supp-nauka-i-jizn-izbrannoe-v-14-2001-pdf-zip');
});

test('supplementary tags prefer the unique id over the colliding year+format tag', () => {
  const base = { year: 2001, issue: 'supplementary', format: 'pdf' };
  const a = { ...base, id: supplementaryId("Nauka_i_jizn'._Izbrannoe._V.13.(2001).[pdf].zip") };
  const b = { ...base, id: supplementaryId("Nauka_i_jizn'._Izbrannoe._V.14.(2001).[pdf].zip") };
  assert.notEqual(entryTag(a), entryTag(b));
  assert.equal(entryTag(a), a.id);
  assert.equal(entryTag(b), b.id);
});
