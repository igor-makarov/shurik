import { controlFixture, iterationFixture } from './test-support.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlStore, commit, configureGit, git, saveJson } from '../scripts/github.ts';
import { loadState, publishCheckpoint, initializeCheckpoint } from '../scripts/state.ts';
import { runtimeLogs } from '../scripts/paths.ts';

process.env.SHURIK_HOME = await mkdtemp(join(tmpdir(), 'shurik-home-state-'));
process.env.GITHUB_REPOSITORY = 'fixture/state';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'shurik-state-'));
  const remote = join(dir, 'remote'), seed = join(dir, 'seed');
  await mkdir(seed); await git(dir, 'init', '--bare', remote); await git(seed, 'init'); await configureGit(seed);
  await writeFile(join(seed, 'app.txt'), 'original'); const base = await commit(seed, 'baseline');
  await git(seed, 'remote', 'add', 'origin', remote);
  await git(seed, 'push', 'origin', 'HEAD:refs/heads/state-test');
  await saveJson(join(seed, 'control.json'), { version: 1, id: 'state-test', stateStorage: 'control',
    branch: 'state-test', status: 'running', generation: 1, next: 1,
    deadline: '2099-01-01T00:00:00Z', owner: { runId: '123', generation: 1, iteration: 1 } });
  await saveJson(join(seed, 'state/history-index.json'), []);
  await mkdir(join(seed, 'state/pi-jsonl'), { recursive: true });
  await writeFile(join(seed, 'state/pi-jsonl/main.jsonl'), 'OLD_JOURNAL\n');
  await commit(seed, 'initial control state');
  await git(seed, 'push', 'origin', 'HEAD:refs/heads/shurik-control/state-test');
  async function reader(name: string) {
    const cwd = join(dir, name); await git(dir, 'clone', remote, cwd); await configureGit(cwd);
    return new ControlStore(cwd, 'state-test');
  }
  const workspace = join(dir, 'workspace'); await git(dir, 'clone', remote, workspace);
  await configureGit(workspace); await git(workspace, 'checkout', 'state-test');
  const store = await reader('control'); const state = await loadState(store, workspace, 'state-test');
  const logs = runtimeLogs('fixture/state', 'state-test');
  const publish = (options: Partial<Parameters<typeof publishCheckpoint>[0]> = {}) => publishCheckpoint({ workspace, state, logs, store, generation: 1, owner: '123',
    sequence: '1-1', message: 'paired checkpoint', ...options });
  const workHead = () => git(dir, '--git-dir', remote, 'rev-parse', 'refs/heads/state-test');
  return { dir, remote, base, workspace, store, state, logs, reader, publish, workHead };
}

test('journals, session index, malformed evidence and runtime source refs live only on control; cold resume restores them', async () => {
  const f = await fixture();
  assert.ok(!f.state.startsWith(f.workspace + '/'), 'session root is outside task checkout');
  await writeFile(join(f.workspace, 'app.txt'), 'changed code');
  await writeFile(join(f.state, 'pi-jsonl/main.jsonl'), 'NEW_JOURNAL\n');
  await saveJson(join(f.state, 'history-index.json'), [{ id: '1-1', minEntryId: 7, maxEntryId: 21 }]);
  await saveJson(join(f.state, 'runtime.json'), { version: 2, selected: f.base, fallback: f.base });
  await saveJson(join(f.logs, '1-1-malformed-journal/evidence.json'), { error: 'partial write' });
  const record = iterationFixture({ id: '1-1', outcome: 'timeout', minEntryId: 7, maxEntryId: 21 });
  const workCommit = await f.publish({ record });
  assert.equal(workCommit, await f.workHead());
  const tree = await git(f.workspace, 'ls-tree', '-r', '--name-only', workCommit);
  assert.equal(tree, 'app.txt');
  const { revision, value } = await f.store.read();
  assert.equal(value.checkpoint!.workCommit, workCommit);
  assert.equal(await git(f.store.cwd, 'show', `${revision}:state/pi-jsonl/main.jsonl`), 'NEW_JOURNAL');
  assert.equal(JSON.parse(await git(f.store.cwd, 'show', `${revision}:state/iterations/1-1.json`)).workCommit, workCommit);
  assert.ok(!(await git(f.store.cwd, 'ls-tree', '-r', '--name-only', revision)).includes('worker.cjs'));
  const freshWork = join(f.dir, 'fresh-work'); await git(f.dir, 'clone', f.remote, freshWork);
  await git(freshWork, 'checkout', 'state-test');
  const freshState = await loadState(await f.reader('fresh-control'), freshWork, 'state-test');
  assert.equal(await readFile(join(freshState, 'pi-jsonl/main.jsonl'), 'utf8'), 'NEW_JOURNAL\n');
  assert.equal(JSON.parse(await readFile(join(freshState, 'history-index.json'), 'utf8'))[0].id, '1-1');
  assert.equal(JSON.parse(await readFile(join(freshState, 'runtime.json'), 'utf8')).selected, f.base);
  assert.ok(await readFile(join(f.logs, '1-1-malformed-journal/evidence.json')));
  await assert.rejects(readFile(join(freshState, 'diagnostics/1-1-malformed-journal/evidence.json')));
  await assert.rejects(readFile(join(freshWork, 'control.json')), 'supervisor deadline stays outside task checkout');
  assert.equal(await git(freshWork, 'status', '--porcelain'), '', 'hydrated local state is ignored even without a repository .gitignore');
});

test('session snapshots preserve legacy and finished journals and publish only prepared active state', async () => {
  const f = await fixture();
  const previous = 'pi-jsonl/sessions/1-1/main.jsonl', active = 'pi-jsonl/sessions/1-2/main.jsonl';
  await mkdir(join(f.state, 'pi-jsonl/sessions/1-1'), { recursive: true });
  await mkdir(join(f.state, 'pi-jsonl/sessions/1-2'), { recursive: true });
  await writeFile(join(f.state, previous), 'FINISHED_SESSION\n');
  await writeFile(join(f.state, active), 'UNPUBLISHED_ACTIVE_STATE\n');
  const snapshot = join(f.dir, 'prepared-session'); await mkdir(snapshot);
  await writeFile(join(snapshot, 'main.jsonl'), 'PREPARED_ACTIVE_STATE\n');
  const record = iterationFixture({ id: '1-2', journalId: '1-2', minEntryId: 7, maxEntryId: 20 });
  await saveJson(join(f.state, 'history-index.json'), [
    { id: 'legacy', minEntryId: 7, maxEntryId: 17 },
    { id: '1-1', journalId: '1-1', minEntryId: 7, maxEntryId: 20 }, record
  ]);
  await f.publish({ record, sequence: record.id, journalSnapshot: snapshot });
  const { revision } = await f.store.read();
  assert.equal(await git(f.store.cwd, 'show', `${revision}:state/pi-jsonl/main.jsonl`), 'OLD_JOURNAL');
  assert.equal(await git(f.store.cwd, 'show', `${revision}:state/${previous}`), 'FINISHED_SESSION');
  assert.equal(await git(f.store.cwd, 'show', `${revision}:state/${active}`), 'PREPARED_ACTIVE_STATE');
  assert.equal(await readFile(join(f.state, active), 'utf8'), 'UNPUBLISHED_ACTIVE_STATE\n');
  const restored = await loadState(await f.reader('session-resume'), f.workspace, 'state-test');
  assert.equal(await readFile(join(restored, previous), 'utf8'), 'FINISHED_SESSION\n');
  assert.equal(await readFile(join(restored, active), 'utf8'), 'PREPARED_ACTIVE_STATE\n');
  assert.equal(JSON.parse(await readFile(join(restored, 'iterations/1-2.json'), 'utf8')).journalId, '1-2');
});

test('initialization publishes both new branches with state only on control, including an empty task diff', async () => {
  const f = await fixture(); const control = controlFixture({ version: 1, stateStorage: 'control', id: 'fresh',
    branch: 'fresh', generation: 1, next: 1, owner: null, status: 'running' });
  await git(f.workspace, 'checkout', '--detach', f.base);
  const cwd = join(f.dir, 'fresh-initialize'); await git(f.dir, 'clone', f.remote, cwd); await configureGit(cwd);
  await git(cwd, 'checkout', '--detach', f.base);
  const store = new ControlStore(cwd, 'fresh');
  const value = await initializeCheckpoint({ workspace: f.workspace, state: f.state, store, control, message: 'initialize fresh loop' });
  assert.equal(value.checkpoint!.workCommit, f.base, 'loop initialization creates no artificial code changes');
  const loaded = await loadState(store, f.workspace, 'fresh');
  assert.equal(await readFile(join(loaded, 'pi-jsonl/main.jsonl'), 'utf8'), 'OLD_JOURNAL\n');
  assert.equal(await git(f.dir, '--git-dir', f.remote, 'rev-parse', 'refs/heads/fresh'), f.base);
  assert.equal(await git(f.workspace, 'ls-tree', '-r', '--name-only', f.base), 'app.txt');
});

test('disabled initialization creates the work ref without committing staged, unstaged or untracked edits', async () => {
  const f = await fixture();
  const control = controlFixture({ id: 'manual', branch: 'manual', checkpointSeconds: 0 });
  await git(f.workspace, 'checkout', '--detach', f.base);
  await writeFile(join(f.workspace, 'app.txt'), 'staged work'); await git(f.workspace, 'add', 'app.txt');
  await writeFile(join(f.workspace, 'app.txt'), 'unfinished work');
  await writeFile(join(f.workspace, 'unfinished.txt'), 'untracked work');
  const status = await git(f.workspace, 'status', '--porcelain');
  const cwd = join(f.dir, 'manual-control'); await git(f.dir, 'clone', f.remote, cwd); await configureGit(cwd);
  await git(cwd, 'checkout', '--detach', f.base);
  const store = new ControlStore(cwd, control.id);
  const saved = await initializeCheckpoint({ workspace: f.workspace, state: f.state, store, control, message: 'initialize manual loop' });
  assert.equal(saved.checkpoint!.workCommit, f.base);
  assert.equal(await git(f.dir, '--git-dir', f.remote, 'rev-parse', 'refs/heads/manual'), f.base);
  assert.equal(await git(f.workspace, 'status', '--porcelain'), status);
  assert.equal(await git(f.workspace, 'show', ':app.txt'), 'staged work');
  const { revision } = await store.read();
  assert.equal(await git(cwd, 'show', `${revision}:state/pi-jsonl/main.jsonl`), 'OLD_JOURNAL');
});

test('disabled checkpoints persist sessions and publish agent commits without staging unfinished task work', async () => {
  const f = await fixture(); await f.store.mutate(c => ({ ...c, checkpointSeconds: 0 }));
  await writeFile(join(f.workspace, 'app.txt'), 'agent approved'); await git(f.workspace, 'add', 'app.txt');
  await writeFile(join(f.workspace, 'app.txt'), 'unfinished edit');
  await writeFile(join(f.workspace, 'unfinished.txt'), 'untracked work');
  await writeFile(join(f.state, 'pi-jsonl/main.jsonl'), 'COMPLETED_SESSION\n');
  const record = iterationFixture({ outcome: 'yielded' });
  const status = await git(f.workspace, 'status', '--porcelain');
  assert.equal(await f.publish({ record }), f.base);
  assert.equal(await f.workHead(), f.base);
  assert.equal(await git(f.workspace, 'status', '--porcelain'), status);
  assert.equal(await git(f.workspace, 'show', ':app.txt'), 'agent approved');
  await git(f.workspace, 'commit', '-m', 'agent approved work');
  const agentCommit = await git(f.workspace, 'rev-parse', 'HEAD');
  const unfinished = await git(f.workspace, 'status', '--porcelain');
  assert.equal(await f.publish({ record }), agentCommit);
  assert.equal(await f.workHead(), agentCommit);
  assert.equal(await git(f.workspace, 'status', '--porcelain'), unfinished);
  assert.equal(await git(f.workspace, 'show', `${agentCommit}:app.txt`), 'agent approved');
  await assert.rejects(git(f.workspace, 'show', `${agentCommit}:unfinished.txt`));
  const { revision } = await f.store.read();
  assert.equal(await git(f.store.cwd, 'show', `${revision}:state/pi-jsonl/main.jsonl`), 'COMPLETED_SESSION');
  assert.equal(JSON.parse(await git(f.store.cwd, 'show', `${revision}:state/iterations/1-1.json`)).workCommit, agentCommit);
  const cold = join(f.dir, 'manual-cold'); await git(f.dir, 'clone', f.remote, cold); await git(cold, 'checkout', 'state-test');
  const restored = await loadState(await f.reader('manual-cold-control'), cold, 'state-test');
  assert.equal(await readFile(join(restored, 'pi-jsonl/main.jsonl'), 'utf8'), 'COMPLETED_SESSION\n');
  assert.equal(await readFile(join(cold, 'app.txt'), 'utf8'), 'agent approved');
  await assert.rejects(readFile(join(cold, 'unfinished.txt')));
});

test('ignored task discoveries survive a cold restart without rolling back newer tracked records', async () => {
  const f = await fixture();
  await f.store.mutate(c => ({ ...c, checkpointPaths: ['data/cdx', 'data/missing.jsonl'] }), 'fixture: saved action configuration');
  await writeFile(join(f.workspace, '.gitignore'), 'data/cdx/\n');
  await saveJson(join(f.workspace, 'data/cdx/stem.json'), { captures: ['new-discovery'] });
  await writeFile(join(f.workspace, 'data/missing.jsonl'), 'newer-ledger\n');
  const workCommit = await f.publish();
  const { revision } = await f.store.read();
  assert.match(await git(f.store.cwd, 'show', `${revision}:state/task-files/data/cdx/stem.json`), /new-discovery/);
  assert.ok(!(await git(f.workspace, 'ls-tree', '-r', '--name-only', workCommit)).includes('data/cdx/'));
  const cold = join(f.dir, 'cold-task'); await git(f.dir, 'clone', f.remote, cold);
  await git(cold, 'checkout', 'state-test');
  await writeFile(join(cold, 'data/missing.jsonl'), 'maintainer-progress\n');
  await loadState(await f.reader('cold-control'), cold, 'state-test');
  assert.match(await readFile(join(cold, 'data/cdx/stem.json'), 'utf8'), /new-discovery/);
  assert.equal(await readFile(join(cold, 'data/missing.jsonl'), 'utf8'), 'maintainer-progress\n');
  await rm(join(f.workspace, 'data/cdx/stem.json'));
  await f.publish();
  const next = (await f.store.read()).revision;
  await assert.rejects(git(f.store.cwd, 'show', `${next}:state/task-files/data/cdx/stem.json`));
});

test('task snapshots reject paths outside the workspace and symlink traversal', async () => {
  const f = await fixture();
  await f.store.mutate(c => ({ ...c, checkpointPaths: ['../outside'] }));
  await assert.rejects(f.publish(), /relative task paths/);
  await f.store.mutate(c => ({ ...c, checkpointPaths: ['data/cdx'] }));
  await mkdir(join(f.workspace, 'data'), { recursive: true });
  await symlink(f.dir, join(f.workspace, 'data/cdx'));
  await assert.rejects(f.publish(), /symlink/);
});

test('a control CAS race publishes neither ref until retry; manual stop remains authoritative', async () => {
  const f = await fixture(); const stop = await f.reader('stop'); let calls = 0;
  await writeFile(join(f.workspace, 'app.txt'), 'new code');
  const racing: ControlStore = { ...f.store, read: () => f.store.read(), mutate: (change, message, evidence, checkpoint) =>
    f.store.mutate(async c => {
      calls++;
      if (calls === 1) await stop.mutate(v => ({ ...v, status: 'stopped' }));
      else assert.equal(await f.workHead(), f.base, 'failed atomic push did not publish unpaired task code');
      return change(c);
    }, message, evidence, checkpoint) };
  const work = await f.publish({ store: racing });
  const control = (await stop.read()).value;
  assert.ok(calls >= 2); assert.equal(control.status, 'stopped');
  assert.equal(control.checkpoint!.workCommit, work); assert.equal(await f.workHead(), work);
});

test('resume racing a checkpoint prevents old-generation journals and source from being published', async () => {
  const f = await fixture(); const resume = await f.reader('resume'); let calls = 0;
  await writeFile(join(f.workspace, 'app.txt'), 'stale code');
  await writeFile(join(f.state, 'pi-jsonl/main.jsonl'), 'STALE_JOURNAL');
  const racing: ControlStore = { ...f.store, read: () => f.store.read(), mutate: (change, message, evidence, checkpoint) =>
    f.store.mutate(async c => {
      if (calls++ === 0) await resume.mutate(v => ({ ...v, generation: 2, owner: null }));
      return change(c);
    }, message, evidence, checkpoint) };
  await assert.rejects(f.publish({ store: racing }), /Stale checkpoint/);
  assert.equal(await f.workHead(), f.base);
  const { revision, value } = await resume.read(); assert.equal(value.generation, 2);
  assert.equal(await git(resume.cwd, 'show', `${revision}:state/pi-jsonl/main.jsonl`), 'OLD_JOURNAL');
});

test('a concurrent task-branch edit rejects the entire checkpoint rather than publishing mismatched history', async () => {
  const f = await fixture(); const other = join(f.dir, 'maintainer');
  await git(f.dir, 'clone', f.remote, other); await configureGit(other);
  await git(other, 'checkout', 'state-test');
  await writeFile(join(other, 'app.txt'), 'maintainer edit'); await commit(other, 'maintainer edit');
  await git(other, 'push', 'origin', 'HEAD:refs/heads/state-test');
  const head = await f.workHead(), before = (await f.store.read()).revision;
  await writeFile(join(f.workspace, 'app.txt'), 'worker edit');
  await writeFile(join(f.state, 'pi-jsonl/main.jsonl'), 'UNPAIRED_JOURNAL');
  await assert.rejects(f.publish());
  assert.equal(await f.workHead(), head); assert.equal((await f.store.read()).revision, before);
});
