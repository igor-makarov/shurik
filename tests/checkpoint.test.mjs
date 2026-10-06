import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timeRemainingInstructions } from '../src/checkpoint.ts';
import { snapshotJournal } from '../src/checkpoint.ts';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { createRegistry, Harness } from '@earendil-works/pi-durable';
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';

test('time feedback distinguishes iteration and loop deadlines and keeps a continuation goal', () => {
  const now = Date.parse('2026-10-06T08:00:00Z');
  const msg = timeRemainingInstructions(now + 120000, '2026-10-06T13:00:00Z', now);
  assert.match(msg, /about 120 seconds remain in this iteration/);
  assert.match(msg, /about 18000 seconds remain in the loop/);
  assert.match(msg, /next fresh-context iteration/);
  assert.match(msg, /later resume can continue/);
  assert.match(timeRemainingInstructions(now - 1000, null, now), /about 0 seconds remain/);
  assert.match(timeRemainingInstructions(now + 1000, null, now), /no overall loop deadline configured/);
});

test('prepared journal excludes a concurrent Pi mutation and remains independent of the live journal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shurik-journal-copy-'));
  const journal = join(dir, 'journal'); const output = join(dir, 'output'); await mkdir(output);
  const context = BACKGROUND_CONTEXT;
  const storage = await openNodeJsonlStorage(journal, context, { fsync: true });
  const harness = await Harness.open(storage, { models: createModels(), registry: createRegistry() }, context);
  try {
    const root = await harness.root(context);
    await root.configure({ instructions: 'BEFORE_PREPARED_SNAPSHOT' }, context);
    let copying;
    const started = new Promise(resolve => { copying = resolve; });
    const guardedRoot = { id: root.id, commit: (change, ctx) => root.commit(async tx => { copying(); return change(tx); }, ctx) };
    const snapshot = snapshotJournal(guardedRoot, journal, output, context);
    await started;
    const competing = root.configure({ instructions: 'AFTER_PREPARED_SNAPSHOT' }, context);
    await snapshot; await competing;
    const copyStorage = await openNodeJsonlStorage(join(output, 'checkpoint-journal'), context, { fsync: true });
    const copyHarness = await Harness.open(copyStorage, { models: createModels(), registry: createRegistry() }, context);
    try {
      const copyRoot = await copyHarness.root(context);
      assert.equal((await copyRoot.agent(context)).instructions, 'BEFORE_PREPARED_SNAPSHOT');
    } finally { await copyHarness.close(context); }
    assert.equal((await root.agent(context)).instructions, 'AFTER_PREPARED_SNAPSHOT');
  } finally { await harness.close(context); }
});
