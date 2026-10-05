import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ControlStore, git, configureGit, saveJson, commit, jobLog } from '../scripts/github.mjs';
import { reconcileLoop, importFailures, recoverInterrupted, iterationPrompt } from '../scripts/failures.mjs';

async function fixture(extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'shurik-trail-')); const remote = join(dir, 'remote'); const seed = join(dir, 'seed');
  await mkdir(seed); await git(dir, 'init', '--bare', remote); await git(seed, 'init'); await configureGit(seed);
  await git(seed, 'remote', 'add', 'origin', remote);
  const control = { version: 1, id: 'trail', status: 'running', generation: 1, next: 1,
    owner: { runId: '123', generation: 1, iteration: 1 }, ...extra };
  await saveJson(join(seed, 'control.json'), control); await commit(seed, 'start');
  await git(seed, 'push', 'origin', 'HEAD:refs/heads/codex/shurik-control/trail');
  async function reader(name) {
    const cwd = join(dir, name); await git(dir, 'clone', remote, cwd); await configureGit(cwd); return new ControlStore(cwd, 'trail');
  }
  return { dir, reader, store: await reader('recovery') };
}
const run = { id: 123, run_attempt: 1, status: 'completed', conclusion: 'failure',
  display_title: 'Ralph trail / iterate 1-1', html_url: 'https://github.com/owner/repo/actions/runs/123', head_sha: 'abc' };
function requestFor(value = run, jobsError) {
  return async path => {
    if (path.includes('/jobs?')) {
      if (jobsError) throw new Error(jobsError);
      return { total_count: 1, jobs: [{ id: 456, name: 'iteration', conclusion: value.conclusion,
        steps: [{ number: 3, name: 'Execute iteration', conclusion: value.conclusion }] }] };
    }
    if (path === `actions/runs/${value.id}`) return value;
    if (path === 'actions/runs/123') return run;
    throw new Error(`Unexpected request ${path}`);
  };
}
test('failure evidence survives a lost work checkout and dispatch crash; a fresh process imports actionable feedback', async () => {
  const f = await fixture(); const key = 'test-secret-12345678901234567890'; let dispatches = 0;
  await assert.rejects(reconcileLoop(f.store, { wake: run, secrets: [key], request: requestFor(),
    logs: async () => ({ text: `EACCES runner mount FAILURE_NEEDLE ${key}`, truncated: false }),
    dispatchNext: async c => {
      dispatches++;
      const evidence = JSON.parse(await git(f.store.cwd, 'show', 'HEAD:failures/123-1.json'));
      assert.equal(c.owner, null); assert.equal(c.next, 2);
      assert.ok(JSON.stringify(evidence).includes('FAILURE_NEEDLE')); assert.ok(!JSON.stringify(evidence).includes(key));
      throw new Error('Dispatch lost');
    }
  }), /Dispatch lost/);
  assert.equal(dispatches, 1);
  const fresh = await f.reader('fresh'); const state = join(f.dir, 'fresh-work-state');
  const reports = await importFailures(fresh, state);
  // This file is the only source metadata that survived in the last work-branch checkpoint.
  await saveJson(join(state, 'iterations/1-1.json'), { id: '1-1', runId: '123', generation: 1,
    outcome: 'running', minEntryId: 10, maxEntryId: 30, checkpointAt: '2026-10-04T00:00:00Z' });
  const sessions = [{ id: '1-1', outcome: 'running', minEntryId: 10, maxEntryId: 30 }];
  await recoverInterrupted(state, sessions, reports);
  assert.equal(sessions.length, 1); assert.equal(sessions[0].outcome, 'interrupted');
  assert.equal(sessions[0].minEntryId, 10); assert.equal(sessions[0].maxEntryId, 30);
  assert.equal(sessions[0].transcript, 'checkpoint'); assert.match(sessions[0].error, /failure/);
  const prompt = iterationPrompt('Repair runner', '1-2', sessions, reports, 'trail');
  assert.match(prompt, /FAILURE_NEEDLE/); assert.match(prompt, /Execute iteration/);
  assert.match(prompt, /\.shurik-local\/state\/trail\/diagnostics\/recovery\/123-1.json/);
  assert.equal(JSON.parse(await readFile(join(state, 'iterations/1-1.json'), 'utf8')).recovery, 'diagnostics/recovery/123-1.json');
  const before = (await fresh.read()).revision;
  await reconcileLoop(fresh, { wake: run, request: requestFor(), logs: async () => { throw new Error('must not recapture'); },
    dispatchNext: async () => { throw new Error('must not redispatch during grace period'); } });
  assert.equal((await fresh.read()).revision, before, 'same completion event keeps immutable evidence and is idempotent');
});
test('job API/log failures leave explicit durable evidence and do not suppress recovery', async () => {
  for (const unavailable of ['jobs', 'logs']) {
    const f = await fixture(); let dispatched = false;
    await reconcileLoop(f.store, { wake: run, request: requestFor(run, unavailable === 'jobs' ? 'Jobs unavailable' : undefined),
      logs: async () => { throw new Error('Logs expired'); }, dispatchNext: async () => { dispatched = true; } });
    assert.ok(dispatched);
    const report = (await importFailures(f.store, join(f.dir, 'state')))[0];
    if (unavailable === 'jobs') assert.match(report.jobsUnavailable, /Jobs unavailable/);
    else assert.match(report.jobs[0].logUnavailable, /Logs expired/);
  }
});
test('racing manual stop preserves evidence without scheduling a successor', async () => {
  const f = await fixture(); const stop = await f.reader('stop'); let dispatched = false;
  await reconcileLoop(f.store, { wake: run, request: requestFor(), logs: async () => {
    await stop.mutate(c => ({ ...c, status: 'stopped' })); return { text: 'Failure after stop', truncated: false };
  }, dispatchNext: async () => { dispatched = true; } });
  const c = (await stop.read()).value;
  assert.equal(c.status, 'stopped'); assert.equal(c.owner, null); assert.equal(c.next, 1);
  assert.deepEqual(c.failureTrail, ['123-1']); assert.equal(dispatched, false);
});
test('stopped cancelled run retains its trail; old-generation cancellation cannot undo resume', async () => {
  const cancelled = { ...run, conclusion: 'cancelled' };
  const f = await fixture({ status: 'stopped' });
  await reconcileLoop(f.store, { wake: cancelled, request: requestFor(cancelled), logs: async () => ({ text: 'cancelled' }),
    dispatchNext: async () => { throw new Error('Stopped loop must stay stopped'); } });
  assert.equal((await f.store.read()).value.status, 'stopped');
  assert.deepEqual((await f.store.read()).value.failureTrail, ['123-1']);
  await f.store.mutate(c => ({ ...c, status: 'running', generation: 2, owner: null, lastRunId: null, lastDispatchAt: new Date().toISOString() }));
  await reconcileLoop(f.store, { wake: cancelled, request: requestFor(cancelled),
    dispatchNext: async () => { throw new Error('Resume already dispatched'); } });
  assert.equal((await f.store.read()).value.status, 'running');
  assert.equal((await f.store.read()).value.generation, 2);
});
test('later failures and rerun attempts append distinct reports rather than overwrite an earlier trail', async () => {
  const f = await fixture();
  for (const current of [run, { ...run, id: 124, display_title: 'Ralph trail / iterate 1-2' }, { ...run, id: 124, run_attempt: 2, display_title: 'Ralph trail / iterate 1-2' }]) {
    await reconcileLoop(f.store, { wake: current, request: requestFor(current), logs: async () => ({ text: `run ${current.id}` }), dispatchNext: async () => {} });
  }
  assert.deepEqual((await f.store.read()).value.failureTrail, ['123-1', '124-1', '124-2']);
  assert.equal((await importFailures(f.store, join(f.dir, 'state'))).length, 3);
});
test('a resume racing evidence collection keeps its new generation while retaining the old cancellation', async () => {
  const f = await fixture(); const resume = await f.reader('resume'); const cancelled = { ...run, conclusion: 'cancelled' };
  await reconcileLoop(f.store, { wake: cancelled, request: requestFor(cancelled), logs: async () => {
    await resume.mutate(c => ({ ...c, status: 'running', generation: 2, owner: null,
      lastRunId: null, lastDispatchAt: new Date().toISOString() }));
    return { text: 'Old generation cancelled' };
  }, dispatchNext: async () => { throw new Error('New generation already dispatched'); } });
  const c = (await f.store.read()).value;
  assert.equal(c.generation, 2); assert.equal(c.status, 'running'); assert.deepEqual(c.failureTrail, ['123-1']);
});
test('a successful Actions run with stranded ownership also provides logs explaining the interrupted handoff', async () => {
  const f = await fixture(); const success = { ...run, conclusion: 'success' };
  await reconcileLoop(f.store, { wake: success, request: requestFor(success),
    logs: async () => ({ text: 'STRANDED_HANDOFF_DIAGNOSTIC' }), dispatchNext: async () => {} });
  const reports = await importFailures(f.store, join(f.dir, 'state'));
  assert.equal(reports[0].interruptedOwner, true);
  assert.match(iterationPrompt('Repair', '1-2', [], reports, 'trail'), /STRANDED_HANDOFF_DIAGNOSTIC/);
});
test('log redirect omits authorization and retains a bounded excerpt', async () => {
  const original = process.env.GH_TOKEN; process.env.GH_TOKEN = 'test-github-secret-12345678';
  const calls = [];
  try {
    const value = await jobLog(456, async (url, options) => {
      calls.push({ url: String(url), options });
      return calls.length === 1 ? new Response(null, { status: 302, headers: { location: 'https://storage.example/logs' } })
        : new Response('x'.repeat(20000) + 'RETAINED_TAIL');
    });
    assert.equal(calls[0].options.headers.authorization, 'Bearer test-github-secret-12345678');
    assert.equal(calls[1].options.headers, undefined);
    assert.equal(value.text.length, 16384); assert.ok(value.text.endsWith('RETAINED_TAIL')); assert.equal(value.truncated, true);
    const limited = await jobLog(456, async () => new Response(new ReadableStream({ start(controller) {
      for (let n = 0; n < 3; n++) controller.enqueue(new Uint8Array(1024 * 1024).fill(65 + n));
      controller.close();
    } })));
    assert.equal(limited.downloadLimited, true); assert.equal(limited.text.length, 16384);
    assert.ok(limited.text.endsWith('B'), 'a capped download is explicitly labelled rather than claimed to include the full tail');
  } finally { if (original === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = original; }
});
