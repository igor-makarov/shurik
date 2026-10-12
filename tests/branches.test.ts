import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkoutTaskBranch, ControlStore, commit, configureGit, git, saveJson } from '../scripts/github.ts';
import { controlFixture } from './test-support.ts';
import { workBranch, controlBranch, loopIdFromControlBranch } from '../scripts/paths.ts';

async function fixture(fn: (f: { directory: string; seed: string; remote: string; base: string; checkout: string }) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'shurik-branches-'));
  try {
    const seed = join(directory, 'seed'), remote = join(directory, 'remote'), checkout = join(directory, 'checkout');
    await mkdir(seed); await git(directory, 'init', '--bare', remote);
    await git(directory, '--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    await git(seed, 'init', '-b', 'main'); await configureGit(seed);
    await writeFile(join(seed, 'app.txt'), 'baseline'); const base = await commit(seed, 'baseline');
    await git(seed, 'remote', 'add', 'origin', remote); await git(seed, 'push', 'origin', 'main');
    await git(directory, 'clone', remote, checkout); await configureGit(checkout);
    await fn({ directory, seed, remote, base, checkout });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('loop IDs name task branches directly and main is allowed; the control namespace is reserved', () => {
  assert.equal(workBranch('main'), 'main'); assert.equal(workBranch('greeting-demo'), 'greeting-demo');
  assert.equal(controlBranch('main'), 'shurik-control/main');
  assert.throws(() => workBranch('shurik-control'), /reserved/);
  assert.throws(() => loopIdFromControlBranch('unrelated/main'), /Not a Shurik control branch/);
});

test('existing main starts from its current remote tip even with an older consumer checkout', () => fixture(async f => {
  await writeFile(join(f.seed, 'app.txt'), 'maintainer change');
  const maintained = await commit(f.seed, 'maintainer change'); await git(f.seed, 'push', 'origin', 'main');
  const selected = await checkoutTaskBranch(f.checkout, 'main', f.base);
  assert.deepEqual(selected, { branch: 'main', source: maintained });
  assert.equal(await git(f.checkout, 'show', 'HEAD:app.txt'), 'maintainer change');
  assert.equal(await git(f.checkout, 'status', '--porcelain'), '');
  assert.equal(await git(f.directory, '--git-dir', f.remote, 'rev-parse', 'main'), maintained);
}));

test('new task branches accept a source; existing branches reject a different source without changing refs', () => fixture(async f => {
  await writeFile(join(f.seed, 'app.txt'), 'latest');
  const latest = await commit(f.seed, 'latest'); await git(f.seed, 'push', 'origin', 'main');
  await assert.rejects(checkoutTaskBranch(f.checkout, 'main', f.base, f.base), /source-ref must match/);
  assert.equal(await git(f.directory, '--git-dir', f.remote, 'rev-parse', 'main'), latest);
  assert.deepEqual(await checkoutTaskBranch(f.checkout, 'feature', latest, f.base), { branch: 'feature', source: f.base });
  assert.deepEqual(await checkoutTaskBranch(f.checkout, 'main', f.base, latest), { branch: 'main', source: latest });
}));

test('older control branches remain readable and mutable; canonical controls take precedence for new readers', () => fixture(async f => {
  const legacy = 'codex/shurik-control/old';
  await git(f.seed, 'checkout', '-b', legacy, f.base);
  await saveJson(join(f.seed, 'control.json'), controlFixture({ id: 'old', branch: 'codex/shurik/old' }));
  await commit(f.seed, 'legacy loop'); await git(f.seed, 'push', 'origin', legacy);
  const store = new ControlStore(f.checkout, 'old');
  assert.equal((await store.read()).value.branch, 'codex/shurik/old'); assert.equal(store.branch, legacy);
  await store.mutate(c => ({ ...c, status: 'stopped' }));
  assert.equal((await store.read()).value.status, 'stopped');
  assert.equal(await git(f.checkout, 'ls-remote', '--heads', 'origin', 'refs/heads/shurik-control/old'), '');
  await git(f.seed, 'checkout', '-b', 'shurik-control/old', f.base);
  await saveJson(join(f.seed, 'control.json'), controlFixture({ id: 'old', branch: 'old' }));
  await commit(f.seed, 'canonical loop'); await git(f.seed, 'push', 'origin', 'shurik-control/old');
  const fresh = new ControlStore(f.checkout, 'old');
  assert.equal((await fresh.read()).value.branch, 'old'); assert.equal(fresh.branch, 'shurik-control/old');
}));
