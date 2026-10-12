import { controlFixture, iterationFixture } from './test-support.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { property, text, positive, sha } from './pbt-support.ts';
import { snapshotTaskState, restoreTaskState } from '../scripts/task-state.ts';
import { ControlStore, commit, configureGit, git, saveJson, readJson } from '../scripts/github.ts';
import { initializeCheckpoint, publishCheckpoint, loadState } from '../scripts/state.ts';
import { PATHS, runtimeState, runtimeLogs, workBranch, controlBranch } from '../scripts/paths.ts';
import { preserveEmergency } from '../scripts/emergency.ts';
import { redact } from '../scripts/policy.ts';

const home = await mkdtemp(join(tmpdir(), 'shurik-pbt-persistence-home-'));
process.env.SHURIK_HOME = home;
process.env.GITHUB_REPOSITORY = 'fixture/pbt';
test.after(() => rm(home, { recursive: true, force: true }));
const bytes = fc.uint8Array({ maxLength: 128 });
// Path components vary in depth but cannot collide with each other's parents.
const component = fc.array(fc.constantFrom(...'abcXYZ019_-'), { minLength: 1, maxLength: 12 })
  .map(chars => 'task-' + chars.join(''));
const directories = fc.array(component, { minLength: 1, maxLength: 4 });
const files = fc.array(fc.record({ bytes, newer: bytes, exists: fc.boolean(), directories }),
  { minLength: 1, maxLength: 6 });

async function withDirectory<T>(fn: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'shurik-pbt-case-'));
  try { return await fn(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
async function put(path: string, data: string | Uint8Array) {
  await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, data);
}

property('task snapshots round-trip bytes, preserve newer files and restore idempotently',
  fc.asyncProperty(files, sha, (generated, workCommit) => withDirectory(async directory => {
    const source = join(directory, 'source'), state = join(directory, 'state'), cold = join(directory, 'cold');
    await mkdir(cold);
    const paths = generated.map((file, index) => ['data', 'entry-' + index, ...file.directories, 'file.bin'].join('/'));
    await saveJson(join(source, PATHS.config), { checkpointPaths: [...paths, ...paths] });
    for (let i = 0; i < generated.length; i++) await put(join(source, paths[i]), generated[i].bytes);
    await snapshotTaskState(source, state, workCommit);
    assert.deepEqual((await readJson<{ version: number; workCommit: string; paths: string[] }>(join(state, PATHS.taskManifest))).paths, paths);
    for (let i = 0; i < generated.length; i++) {
      if (generated[i].exists) await put(join(cold, paths[i]), generated[i].newer);
    }
    for (let repeat = 0; repeat < 2; repeat++) {
      await restoreTaskState(cold, state, workCommit);
      for (let i = 0; i < generated.length; i++) {
        assert.deepEqual(await readFile(join(cold, paths[i])),
          Buffer.from(generated[i].exists ? generated[i].newer : generated[i].bytes));
      }
    }
  })), 75);

property('mismatched task manifests fail before modifying the task checkout',
  fc.asyncProperty(bytes, sha, fc.boolean(), (content, workCommit, wrongVersion) => withDirectory(async directory => {
    const source = join(directory, 'source'), state = join(directory, 'state'), cold = join(directory, 'cold');
    await put(join(source, 'data/file.bin'), content); await mkdir(cold);
    await put(join(cold, 'sentinel.bin'), content);
    await saveJson(join(source, PATHS.config), { checkpointPaths: ['data/file.bin'] });
    await snapshotTaskState(source, state, workCommit);
    const manifest = await readJson<{ version: number; workCommit: string; paths: string[] }>(join(state, PATHS.taskManifest));
    await saveJson(join(state, PATHS.taskManifest), wrongVersion
      ? { ...manifest, version: 2 } : { ...manifest, workCommit: 'different-' + workCommit });
    await assert.rejects(restoreTaskState(cold, state, workCommit), /does not match/);
    assert.deepEqual(await readFile(join(cold, 'sentinel.bin')), Buffer.from(content));
    await assert.rejects(readFile(join(cold, 'data/file.bin')), { code: 'ENOENT' });
  })), 75);

property('checkpoint paths reject traversal, hidden state and generated dependency directories',
  fc.asyncProperty(directories, fc.constantFrom('..', '.', '.git', '.shurik', 'node_modules', 'dist', '', 'x\\y'),
    (prefix, forbidden) => withDirectory(async directory => {
      const source = join(directory, 'source'), state = join(directory, 'state');
      await saveJson(join(source, PATHS.config), { checkpointPaths: [[...prefix, forbidden, 'file.bin'].join('/')] });
      await assert.rejects(snapshotTaskState(source, state, 'commit'), /relative task paths/);
      await assert.rejects(readFile(join(state, PATHS.taskManifest)), { code: 'ENOENT' });
    })), 75);

property('snapshot and restore reject symlinks at any generated path depth',
  fc.asyncProperty(directories, bytes, fc.boolean(), (parts, content, duringRestore) => withDirectory(async directory => {
    const source = join(directory, 'source'), state = join(directory, 'state'), cold = join(directory, 'cold');
    const outside = join(directory, 'outside'), path = [...parts, 'file.bin'].join('/');
    await put(join(outside, 'sentinel.bin'), content);
    await put(join(source, path), content);
    await saveJson(join(source, PATHS.config), { checkpointPaths: [parts[0]] });
    if (duringRestore) {
      await snapshotTaskState(source, state, 'commit');
      await mkdir(cold); await mkdir(join(cold, ...parts.slice(0, -1)), { recursive: true });
      await symlink(outside, join(cold, ...parts));
      await assert.rejects(restoreTaskState(cold, state, 'commit'), /symlink|Unsupported checkpoint file/);
    } else {
      await rm(join(source, ...parts), { recursive: true });
      await symlink(outside, join(source, ...parts));
      await assert.rejects(snapshotTaskState(source, state, 'commit'), /symlink|Unsupported checkpoint file/);
    }
    assert.deepEqual(await readFile(join(outside, 'sentinel.bin')), Buffer.from(content));
    await assert.rejects(readFile(join(outside, 'file.bin')), { code: 'ENOENT' });
  })), 50);

let caseNumber = 0;
async function fixture(directory: string, generation: number, onMain = false) {
  const id = onMain ? 'main' : 'case-' + ++caseNumber, remote = join(directory, 'remote'), workspace = join(directory, 'workspace');
  await mkdir(workspace); await git(directory, 'init', '--bare', remote);
  await git(directory, '--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  await git(workspace, 'init', '-b', 'main'); await configureGit(workspace);
  await saveJson(join(workspace, 'app.json'), { original: true }); const base = await commit(workspace, 'baseline');
  await git(workspace, 'remote', 'add', 'origin', remote); await git(workspace, 'push', 'origin', 'main');
  async function reader(name: string) {
    const cwd = join(directory, name); await git(directory, 'clone', remote, cwd); await configureGit(cwd);
    return new ControlStore(cwd, id);
  }
  const store = await reader('control'); await git(store.cwd, 'checkout', '-b', controlBranch(id), 'origin/main');
  const state = runtimeState('fixture/pbt', id);
  const logs = runtimeLogs('fixture/pbt', id);
  await rm(state, { recursive: true, force: true }); await rm(logs, { recursive: true, force: true });
  await mkdir(logs, { recursive: true });
  await saveJson(join(state, PATHS.history), []);
  await put(join(state, PATHS.journal, 'main.jsonl'), JSON.stringify({ original: true }) + '\n');
  const control = controlFixture({ version: 1, stateStorage: 'control', id, branch: workBranch(id), status: 'running',
    generation, next: 1, owner: { runId: 'worker', generation, iteration: 1 } });
  await initializeCheckpoint({ workspace, state, logs, store, control, message: 'initialize property fixture' });
  const workHead = () => git(directory, '--git-dir', remote, 'rev-parse', 'refs/heads/' + control.branch);
  const publish = (options: Partial<Parameters<typeof publishCheckpoint>[0]> = {}) => publishCheckpoint({ workspace, state, logs, store, generation, owner: 'worker',
    sequence: generation + '-1', message: 'generated checkpoint', ...options });
  const edit = async (value: unknown) => {
    await saveJson(join(workspace, 'app.json'), { value });
    await put(join(state, PATHS.journal, 'main.jsonl'), JSON.stringify({ value }) + '\n');
    await saveJson(join(logs, 'worker.json'), { value });
  };
  return { workspace, state, logs, store, remote, control, base, reader, workHead, publish, edit };
}

property('main checkpoints keep code and sessions paired without putting state on main and restore cold',
  fc.asyncProperty(fc.array(text, { minLength: 1, maxLength: 3 }), positive,
    (values, generation) => withDirectory(async directory => {
      const f = await fixture(directory, generation, true);
      assert.equal(await f.workHead(), f.base, 'initialization leaves the existing main tip unchanged');
      assert.equal(f.store.branch, 'shurik-control/main');
      for (const marker of values) {
        await f.edit(marker); const work = await f.publish();
        const { revision, value } = await f.store.read();
        assert.equal(await f.workHead(), work); assert.equal(value.branch, 'main');
        assert.equal(value.checkpoint!.workCommit, work);
        assert.equal(await git(f.workspace, 'ls-tree', '-r', '--name-only', work), 'app.json');
        assert.deepEqual(JSON.parse(await git(f.store.cwd, 'show', revision + ':state/pi-jsonl/main.jsonl')), { value: marker });
      }
      const cold = join(directory, 'cold-main'); await git(directory, 'clone', f.remote, cold);
      const restored = await loadState(await f.reader('cold-main-control'), cold, 'main');
      assert.deepEqual(await readJson(join(cold, 'app.json')), await readJson(join(restored, PATHS.journal, 'main.jsonl')));
      assert.equal(await git(cold, 'status', '--porcelain'), '');
    })), 8);

property('main checkpoint conflicts preserve maintainer commits and leave control state unchanged',
  fc.asyncProperty(positive, text, text, (generation, agent, maintainer) => withDirectory(async directory => {
    const f = await fixture(directory, generation, true), other = join(directory, 'maintainer');
    await git(directory, 'clone', f.remote, other); await configureGit(other);
    await saveJson(join(other, 'app.json'), { author: 'maintainer', value: maintainer });
    const maintained = await commit(other, 'maintainer edit'); await git(other, 'push', 'origin', 'main');
    const before = await f.store.read(); await f.edit({ author: 'worker', value: agent });
    await assert.rejects(f.publish());
    assert.equal(await f.workHead(), maintained); assert.equal((await f.store.read()).revision, before.revision);
    assert.deepEqual(JSON.parse(await git(other, 'show', maintained + ':app.json')), { author: 'maintainer', value: maintainer });
  })), 8);

property('generated checkpoint sequences pair code and session state and restore cold',
  fc.asyncProperty(fc.array(text, { minLength: 1, maxLength: 4 }), positive,
    (values, generation) => withDirectory(async directory => {
      const f = await fixture(directory, generation), sessions: { id: string; marker: { index: number; text: string } }[] = [];
      for (let index = 0; index < values.length; index++) {
        const marker = { index, text: values[index] };
        await f.edit(marker); sessions.push({ id: generation + '-' + index, marker });
        await saveJson(join(f.state, PATHS.history), sessions);
        const record = iterationFixture({ id: generation + '-' + index, generation, iteration: index, outcome: 'yielded' });
        const workCommit = await f.publish({ sequence: record.id, record });
        const { revision, value } = await f.store.read();
        assert.equal(await f.workHead(), workCommit); assert.equal(value.checkpoint!.workCommit, workCommit);
        assert.equal(value.checkpoint!.sequence, record.id); assert.equal(value.checkpoint!.generation, generation);
        assert.deepEqual(JSON.parse(await git(f.workspace, 'show', workCommit + ':app.json')), { value: marker });
        assert.deepEqual(JSON.parse(await git(f.store.cwd, 'show', revision + ':state/pi-jsonl/main.jsonl')), { value: marker });
        assert.deepEqual(JSON.parse(await git(f.store.cwd, 'show', revision + ':state/history-index.json')), sessions);
        assert.deepEqual(JSON.parse(await git(f.store.cwd, 'show', revision + ':state/diagnostics/worker.json')), { value: marker });
        assert.equal(JSON.parse(await git(f.store.cwd, 'show', revision + ':state/iterations/' + record.id + '.json')).workCommit, workCommit);
        assert.equal(await git(f.workspace, 'ls-tree', '-r', '--name-only', workCommit), 'app.json');
      }
      const cold = join(directory, 'cold-work'); await git(directory, 'clone', f.remote, cold);
      await git(cold, 'checkout', f.control.branch);
      const restored = await loadState(await f.reader('cold-control'), cold, f.control.id);
      assert.deepEqual(await readJson(join(restored, PATHS.history)), sessions);
      assert.deepEqual(await readJson(join(f.logs, 'worker.json')), { value: { index: values.length - 1, text: values.at(-1) } });
      assert.ok(!(await readdir(restored)).includes(PATHS.diagnostics));
      assert.deepEqual(await readJson(join(cold, 'app.json')), await readJson(join(restored, PATHS.journal, 'main.jsonl')));
      assert.equal(await git(cold, 'status', '--porcelain'), '');
    })), 8);

property('stale generation or ownership publishes neither checkpoint ref',
  fc.asyncProperty(positive, text, fc.constantFrom('generation', 'other-owner', 'no-owner'),
    (generation, value, mode) => withDirectory(async directory => {
      const f = await fixture(directory, generation), before = await f.store.read();
      await f.edit(value);
      const options = mode === 'generation' ? { generation: generation + 1 }
        : { owner: mode === 'other-owner' ? 'different-worker' : null };
      await assert.rejects(f.publish(options), /Stale checkpoint/);
      assert.equal(await f.workHead(), f.base); assert.equal((await f.store.read()).revision, before.revision);
    })), 8);

property('a generated CAS stop race preserves the stop and keeps checkpoint refs paired',
  fc.asyncProperty(positive, text, (generation, marker) => withDirectory(async directory => {
    const f = await fixture(directory, generation), stop = await f.reader('stop'); let attempts = 0;
    await f.edit(marker);
    const racing: ControlStore = { ...f.store, read: () => f.store.read(), mutate: (change, message, evidence, checkpoint) =>
      f.store.mutate(async current => {
        if (attempts++ === 0) await stop.mutate(c => ({ ...c, status: 'stopped' }));
        else assert.equal(await f.workHead(), f.base, 'rejected atomic push must not advance the task ref');
        return change(current);
      }, message, evidence, checkpoint) };
    const workCommit = await f.publish({ store: racing });
    const { value } = await stop.read();
    assert.ok(attempts >= 2); assert.equal(value.status, 'stopped');
    assert.equal(value.checkpoint!.workCommit, workCommit); assert.equal(await f.workHead(), workCommit);
  })), 8);

property('a generated CAS resume race prevents old code and journals from reaching either ref',
  fc.asyncProperty(positive, positive, text, (generation, delta, marker) => withDirectory(async directory => {
    const f = await fixture(directory, generation), resume = await f.reader('resume'); let raced = false;
    await f.edit(marker);
    const racing: ControlStore = { ...f.store, read: () => f.store.read(), mutate: (change, message, evidence, checkpoint) =>
      f.store.mutate(async current => {
        if (!raced) {
          raced = true;
          await resume.mutate(c => ({ ...c, generation: c.generation + delta, owner: null }));
        }
        return change(current);
      }, message, evidence, checkpoint) };
    await assert.rejects(f.publish({ store: racing }), /Stale checkpoint/);
    const { revision, value } = await resume.read();
    assert.equal(value.generation, generation + delta); assert.equal(value.owner, null);
    assert.equal(await f.workHead(), f.base); assert.equal(value.checkpoint!.workCommit, f.base);
    assert.deepEqual(JSON.parse(await git(resume.cwd, 'show', revision + ':state/pi-jsonl/main.jsonl')), { original: true });
  })), 8);

property('concurrent task edits reject the whole generated checkpoint and retain maintainer code',
  fc.asyncProperty(positive, text, text, (generation, agent, maintainer) => withDirectory(async directory => {
    const f = await fixture(directory, generation), other = join(directory, 'maintainer');
    await git(directory, 'clone', f.remote, other); await configureGit(other); await git(other, 'checkout', f.control.branch);
    await saveJson(join(other, 'app.json'), { author: 'maintainer', value: maintainer });
    const maintained = await commit(other, 'maintainer edit'); await git(other, 'push', 'origin', 'HEAD:refs/heads/' + f.control.branch);
    const before = await f.store.read(); await f.edit({ author: 'worker', value: agent });
    await assert.rejects(f.publish());
    assert.equal(await f.workHead(), maintained); assert.equal((await f.store.read()).revision, before.revision);
    assert.deepEqual(JSON.parse(await git(other, 'show', maintained + ':app.json')), { author: 'maintainer', value: maintainer });
  })), 8);

property('emergency snapshots retain redacted task, state and logs outside the checkout',
  fc.asyncProperty(text, text, (payload, credential) => withDirectory(async directory => {
    const workspace = join(directory, 'project'), state = join(directory, 'home/state/fixture/project/loop');
    const logs = join(directory, 'home/logs/fixture/project/loop');
    const destination = join(directory, 'home/emergency/fixture/project/loop/local-1');
    const secret = 'TEST_CREDENTIAL_' + credential;
    await put(join(workspace, 'task.txt'), payload + '\n' + secret);
    await put(join(workspace, '.git/private'), secret);
    await put(join(workspace, 'node_modules/private'), secret);
    await put(join(workspace, 'dist/private'), secret);
    await saveJson(join(state, 'history-index.json'), { payload, secret });
    await saveJson(join(logs, 'worker.json'), { payload, secret });
    await put(join(destination, 'stale.txt'), 'old evidence');
    await preserveEmergency({ workspace, state, logs, destination, secrets: [secret] });
    assert.equal(await readFile(join(destination, 'workspace/task.txt'), 'utf8'), redact(payload + '\n' + secret, [secret]));
    for (const path of ['state/history-index.json', 'logs/worker.json']) {
      const evidence = await readJson<{ payload: string; secret: string }>(join(destination, path));
      assert.equal(evidence.payload, payload); assert.ok(!JSON.stringify(evidence).includes(secret));
    }
    assert.deepEqual((await readdir(destination)).sort(), ['logs', 'state', 'workspace']);
    assert.deepEqual(await readdir(join(destination, 'workspace')), ['task.txt']);
    assert.deepEqual((await readdir(workspace)).sort(), ['.git', 'dist', 'node_modules', 'task.txt']);
  })), 75);
