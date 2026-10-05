import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlStore, commit, configureGit, git, saveJson } from '../scripts/github.mjs';
import { loadState, publishCheckpoint, initializeCheckpoint } from '../scripts/state.mjs';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'shurik-state-'));
  const remote = join(dir, 'remote'), seed = join(dir, 'seed');
  await mkdir(seed); await git(dir, 'init', '--bare', remote); await git(seed, 'init'); await configureGit(seed);
  await writeFile(join(seed, 'app.txt'), 'original'); const base = await commit(seed, 'baseline');
  await git(seed, 'remote', 'add', 'origin', remote);
  await git(seed, 'push', 'origin', 'HEAD:refs/heads/codex/shurik/state-test');
  await saveJson(join(seed, 'control.json'), { version: 1, id: 'state-test', stateStorage: 'control',
    branch: 'codex/shurik/state-test', status: 'running', generation: 1, next: 1,
    deadline: '2099-01-01T00:00:00Z', owner: { runId: '123', generation: 1, iteration: 1 } });
  await saveJson(join(seed, 'state/history-index.json'), []);
  await mkdir(join(seed, 'state/pi-jsonl'), { recursive: true });
  await writeFile(join(seed, 'state/pi-jsonl/main.jsonl'), 'OLD_JOURNAL\n');
  await commit(seed, 'initial control state');
  await git(seed, 'push', 'origin', 'HEAD:refs/heads/codex/shurik-control/state-test');
  async function reader(name) {
    const cwd = join(dir, name); await git(dir, 'clone', remote, cwd); await configureGit(cwd);
    return new ControlStore(cwd, 'state-test');
  }
  const workspace = join(dir, 'workspace'); await git(dir, 'clone', remote, workspace);
  await configureGit(workspace); await git(workspace, 'checkout', 'codex/shurik/state-test');
  const store = await reader('control'); const state = await loadState(store, workspace, 'state-test');
  const publish = options => publishCheckpoint({ workspace, state, store, generation: 1, owner: '123',
    sequence: '1-1', message: 'paired checkpoint', ...options });
  const workHead = () => git(dir, '--git-dir', remote, 'rev-parse', 'refs/heads/codex/shurik/state-test');
  return { dir, remote, base, workspace, store, state, reader, publish, workHead };
}

test('journals, session index, malformed evidence and runtime source refs live only on control; cold resume restores them', async () => {
  const f = await fixture();
  // Force-stage an older journal, then let its contents advance before publication.
  await git(f.workspace, 'add', '-f', '.shurik-local');
  await writeFile(join(f.workspace, 'app.txt'), 'changed code');
  await writeFile(join(f.state, 'pi-jsonl/main.jsonl'), 'NEW_JOURNAL\n');
  await saveJson(join(f.state, 'history-index.json'), [{ id: '1-1', minEntryId: 7, maxEntryId: 21 }]);
  await saveJson(join(f.state, 'runtime.json'), { version: 2, selected: f.base, fallback: f.base });
  await saveJson(join(f.state, 'diagnostics/1-1-malformed-journal/evidence.json'), { error: 'partial write' });
  const record = { id: '1-1', outcome: 'timeout', minEntryId: 7, maxEntryId: 21 };
  const workCommit = await f.publish({ record });
  assert.equal(workCommit, await f.workHead());
  const tree = await git(f.workspace, 'ls-tree', '-r', '--name-only', workCommit);
  assert.equal(tree, 'app.txt');
  const { revision, value } = await f.store.read();
  assert.equal(value.checkpoint.workCommit, workCommit);
  assert.equal(await git(f.store.cwd, 'show', `${revision}:state/pi-jsonl/main.jsonl`), 'NEW_JOURNAL');
  assert.equal(JSON.parse(await git(f.store.cwd, 'show', `${revision}:state/iterations/1-1.json`)).workCommit, workCommit);
  assert.ok(!(await git(f.store.cwd, 'ls-tree', '-r', '--name-only', revision)).includes('worker.cjs'));
  const freshWork = join(f.dir, 'fresh-work'); await git(f.dir, 'clone', f.remote, freshWork);
  await git(freshWork, 'checkout', 'codex/shurik/state-test');
  const freshState = await loadState(await f.reader('fresh-control'), freshWork, 'state-test');
  assert.equal(await readFile(join(freshState, 'pi-jsonl/main.jsonl'), 'utf8'), 'NEW_JOURNAL\n');
  assert.equal(JSON.parse(await readFile(join(freshState, 'history-index.json'), 'utf8'))[0].id, '1-1');
  assert.equal(JSON.parse(await readFile(join(freshState, 'runtime.json'), 'utf8')).selected, f.base);
  assert.ok(await readFile(join(freshState, 'diagnostics/1-1-malformed-journal/evidence.json')));
  await assert.rejects(readFile(join(freshWork, 'control.json')), 'supervisor deadline stays outside task checkout');
  assert.equal(await git(freshWork, 'status', '--porcelain'), '', 'hydrated local state is ignored even without a repository .gitignore');
});

test('initialization publishes both new branches with state only on control, including an empty task diff', async () => {
  const f = await fixture(); const control = { version: 1, stateStorage: 'control', id: 'fresh',
    branch: 'codex/shurik/fresh', generation: 1, next: 1, owner: null, status: 'running' };
  await git(f.workspace, 'checkout', '--detach', f.base);
  const cwd = join(f.dir, 'fresh-initialize'); await git(f.dir, 'clone', f.remote, cwd); await configureGit(cwd);
  await git(cwd, 'checkout', '--detach', f.base);
  const store = new ControlStore(cwd, 'fresh');
  const value = await initializeCheckpoint({ workspace: f.workspace, state: f.state, store, control, message: 'initialize fresh loop' });
  assert.equal(value.checkpoint.workCommit, f.base, 'loop initialization creates no artificial code changes');
  const loaded = await loadState(store, f.workspace, 'fresh');
  assert.equal(await readFile(join(loaded, 'pi-jsonl/main.jsonl'), 'utf8'), 'OLD_JOURNAL\n');
  assert.equal(await git(f.dir, '--git-dir', f.remote, 'rev-parse', 'refs/heads/codex/shurik/fresh'), f.base);
  assert.equal(await git(f.workspace, 'ls-tree', '-r', '--name-only', f.base), 'app.txt');
});

test('a control CAS race publishes neither ref until retry; manual stop remains authoritative', async () => {
  const f = await fixture(); const stop = await f.reader('stop'); let calls = 0;
  await writeFile(join(f.workspace, 'app.txt'), 'new code');
  const racing = { read: () => f.store.read(), mutate: (change, message, evidence, checkpoint) =>
    f.store.mutate(async c => {
      calls++;
      if (calls === 1) await stop.mutate(v => ({ ...v, status: 'stopped' }));
      else assert.equal(await f.workHead(), f.base, 'failed atomic push did not publish unpaired task code');
      return change(c);
    }, message, evidence, checkpoint) };
  const work = await f.publish({ store: racing });
  const control = (await stop.read()).value;
  assert.ok(calls >= 2); assert.equal(control.status, 'stopped');
  assert.equal(control.checkpoint.workCommit, work); assert.equal(await f.workHead(), work);
});

test('resume racing a checkpoint prevents old-generation journals and source from being published', async () => {
  const f = await fixture(); const resume = await f.reader('resume'); let calls = 0;
  await writeFile(join(f.workspace, 'app.txt'), 'stale code');
  await writeFile(join(f.state, 'pi-jsonl/main.jsonl'), 'STALE_JOURNAL');
  const racing = { read: () => f.store.read(), mutate: (change, message, evidence, checkpoint) =>
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
  await git(other, 'checkout', 'codex/shurik/state-test');
  await writeFile(join(other, 'app.txt'), 'maintainer edit'); await commit(other, 'maintainer edit');
  await git(other, 'push', 'origin', 'HEAD:refs/heads/codex/shurik/state-test');
  const head = await f.workHead(), before = (await f.store.read()).revision;
  await writeFile(join(f.workspace, 'app.txt'), 'worker edit');
  await writeFile(join(f.state, 'pi-jsonl/main.jsonl'), 'UNPAIRED_JOURNAL');
  await assert.rejects(f.publish());
  assert.equal(await f.workHead(), head); assert.equal((await f.store.read()).revision, before);
});
