import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import fc from 'fast-check';
import type { Control, Run } from '../scripts/types.ts';
import { ControlStore, git, configureGit, saveJson, commit } from '../scripts/github.ts';
import { reconcileLoop, completedIterationRun } from '../scripts/failures.ts';
import { resumeSettings, claimable } from '../scripts/policy.ts';
import { property, positive } from './pbt-support.ts';
import { apiFixture, controlFixture, runFixture } from './test-support.ts';

const base = Date.parse('2026-10-13T10:00:00Z');
let clock = base;
test.mock.method(Date, 'now', () => clock);
test.beforeEach(() => { clock = base; });

async function fixture(extra: Partial<Control> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'shurik-cadence-')), remote = join(dir, 'remote'), seed = join(dir, 'seed');
  await mkdir(seed); await git(dir, 'init', '--bare', remote); await git(seed, 'init'); await configureGit(seed);
  await git(seed, 'remote', 'add', 'origin', remote);
  await saveJson(join(seed, 'control.json'), controlFixture({ id: 'idle', waitSeconds: 10800, ...extra }));
  await commit(seed, 'loop'); await git(seed, 'push', 'origin', 'HEAD:refs/heads/shurik-control/idle');
  async function reader(name: string) {
    const cwd = join(dir, name); await git(dir, 'clone', remote, cwd); await configureGit(cwd);
    return new ControlStore(cwd, 'idle');
  }
  return { dir, reader, store: await reader('recovery') };
}
function requestFor(run: Run) {
  return apiFixture(async path => {
    if (path === `actions/runs/${run.id}`) return run;
    if (path.includes('/jobs?')) return { total_count: 0, jobs: [] };
    throw new Error('Unexpected request: ' + path);
  });
}

test('same-workflow recovery starts the wait at completed job time and does not extend it on repeated checks', async () => {
  const f = await fixture({ owner: { runId: '123', generation: 1, iteration: 1 } });
  try {
    const run = completedIterationRun(runFixture({ display_title: 'Shurik idle / iterate 1-1',
      status: 'in_progress', conclusion: null }), 'failure', [{ id: 1, name: 'iteration', status: 'completed',
      conclusion: 'failure', completed_at: new Date(base).toISOString() }]);
    let dispatches = 0;
    const check = () => reconcileLoop(f.store, { wake: run, request: requestFor(run), dispatchNext: async () => { dispatches++; } });
    await check();
    const saved = (await f.store.read()).value;
    assert.equal(saved.next, 2); assert.equal(saved.owner, null); assert.equal(saved.lastDispatchAt, null);
    assert.equal(saved.nextRunAt, new Date(base + 10800000).toISOString());
    assert.deepEqual(saved.failureTrail, ['123-1']);
    clock = base + 10800000 - 1; await check();
    assert.equal(dispatches, 0); assert.equal((await f.store.read()).value.nextRunAt, saved.nextRunAt);
    assert.equal(claimable(saved, 1, 2, 'early'), false);
    clock++; await check(); await check();
    assert.equal(dispatches, 1); assert.equal((await f.store.read()).value.nextRunAt, null);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test('deadlines and cancellation during waiting prevent the next iteration', async () => {
  for (const cancelled of [false, true]) {
    const f = await fixture({ next: 2, nextRunAt: new Date(base + 10800000).toISOString(), lastRunId: '123',
      deadline: cancelled ? null : new Date(base + 1000).toISOString() });
    try {
      clock = base + 2000;
      const run = runFixture({ conclusion: cancelled ? 'cancelled' : 'success', display_title: 'Shurik idle / iterate 1-1' });
      await reconcileLoop(f.store, { wake: run, request: requestFor(run), dispatchNext: async () => { assert.fail('Stopped loop dispatched'); } });
      const c = (await f.store.read()).value;
      assert.equal(c.status, cancelled ? 'stopped' : 'deadline'); assert.equal(c.nextRunAt, null);
      assert.equal(claimable(c, 1, 2, 'late', base + 10800000), false);
    } finally { await rm(f.dir, { recursive: true, force: true }); }
  }
});

test('failure before claim retries immediately after a wait without imposing another wait', async () => {
  const f = await fixture({ next: 2, lastDispatchAt: new Date(base).toISOString(), nextRunAt: null });
  try {
    const run = runFixture({ display_title: 'Shurik idle / iterate 1-2' }); let dispatches = 0;
    await reconcileLoop(f.store, { wake: run, request: requestFor(run), dispatchNext: async c => {
      dispatches++; assert.equal(c.next, 2); assert.equal(c.nextRunAt, null); assert.equal(c.waitSeconds, 10800);
    } });
    assert.equal(dispatches, 1);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

property('racing recovery checks reserve one due iteration and retain the persisted work/wait settings',
  fc.asyncProperty(fc.integer({ min: 1, max: 86400 }), positive, async (waitSeconds, generation) => {
    const f = await fixture({ waitSeconds, generation, seconds: 1800, nextRunAt: new Date(base).toISOString() });
    try {
      const peer = await f.reader('peer'); let arrived = 0, release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      for (const store of [f.store, peer]) {
        const mutate = store.mutate.bind(store); let first = true;
        store.mutate = (change, ...args) => mutate(async c => {
          const next = await change(c);
          if (first) { first = false; if (++arrived === 2) release(); await gate; }
          return next;
        }, ...args);
      }
      let dispatches = 0;
      await Promise.all([f.store, peer].map(store => reconcileLoop(store, { dispatchNext: async c => {
        dispatches++; assert.equal(c.seconds, 1800); assert.equal(c.waitSeconds, waitSeconds);
        assert.equal(c.generation, generation); assert.equal(c.nextRunAt, null);
      } })));
      assert.equal(dispatches, 1);
    } finally { await rm(f.dir, { recursive: true, force: true }); }
  }), 8);

property('stop or resume racing a due recovery check prevents dispatch from its older control state',
  fc.asyncProperty(fc.boolean(), positive, fc.integer({ min: 1, max: 86400 }), async (resume, generation, waitSeconds) => {
    const f = await fixture({ generation, waitSeconds, nextRunAt: new Date(base).toISOString() });
    try {
      const peer = await f.reader('control'), mutate = f.store.mutate.bind(f.store); let raced = false;
      f.store.mutate = (change, ...args) => mutate(async c => {
        if (!raced) {
          raced = true;
          await peer.mutate(v => resume ? resumeSettings(v, { reasoning: 'high' })
            : { ...v, status: 'stopped', nextRunAt: null });
        }
        return change(c);
      }, ...args);
      await reconcileLoop(f.store, { dispatchNext: async () => { assert.fail('Stale recovery dispatched'); } });
      const c = (await peer.read()).value;
      assert.equal(c.generation, generation + Number(resume)); assert.equal(c.waitSeconds, waitSeconds);
      assert.equal(c.status, resume ? 'running' : 'stopped'); assert.equal(c.nextRunAt, null);
    } finally { await rm(f.dir, { recursive: true, force: true }); }
  }), 8);
