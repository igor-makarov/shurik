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
  assert.match(msg, /preserved work supports a later resume/);
  assert.match(msg, /Keep pursuing useful work after saving the handoff until preemption/);
  assert.match(timeRemainingInstructions(now - 1000, null, now), /about 0 seconds remain/);
  assert.match(timeRemainingInstructions(now + 1000, null, now), /no overall loop deadline configured/);
});

test('ordinary checkpoints omit clock, countdown and handoff until the final configured interval', () => {
  const now = Date.parse('2026-10-06T08:00:00Z');
  const end = now + 1800000;
  for (const at of [now, end - 300001]) {
    const msg = timeRemainingInstructions(end, '2026-10-06T13:00:00Z', at);
    assert.doesNotMatch(msg, /Time update|\d{4}-\d{2}-\d{2}T|seconds remain|ends |deadline|handoff|preempt|next fresh-context/);
    assert.match(msg, /continue useful work after saving/);
    assert.match(msg, /make and verify useful repairs/);
    assert.match(msg, /Reserve a final response for a task objective that has been fully achieved and verified/);
    assert.doesNotMatch(msg, /Yield early|external blocker|prevents all useful progress/);
  }
  const final = timeRemainingInstructions(end, null, end - 300000);
  assert.match(final, /Time update at 2026-10-06T08:25:00.000Z/);
  assert.match(final, /Final checkpoint interval: about 300 seconds/);
  assert.doesNotMatch(timeRemainingInstructions(end, null, end - 120001, 120), /Final checkpoint interval/);
  assert.match(timeRemainingInstructions(end, null, end - 120000, 120), /Final checkpoint interval: about 120 seconds/);
  // An overall deadline can preempt the iteration before its normal session limit.
  assert.match(timeRemainingInstructions(end, new Date(now + 60000).toISOString(), now), /about 60 seconds remain in this iteration/);
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
