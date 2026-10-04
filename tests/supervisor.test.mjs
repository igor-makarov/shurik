import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ControlStore, git, configureGit, saveJson, commit, repositoryURL } from '../scripts/github.mjs';
import { claimable, stopped, nextRuntime, classify, trustedRecovery, cancelledForLoop, redact, sanitizeTree, validateId, loopSnapshot } from '../scripts/policy.mjs';
import { retainBundle, verifyBundle } from '../scripts/runtime.mjs';

test('repository root API URL has no trailing slash; nested endpoints retain their path', () => {
  assert.equal(repositoryURL('owner/repo'), 'https://api.github.com/repos/owner/repo');
  assert.equal(repositoryURL('owner/repo', 'actions/runs'), 'https://api.github.com/repos/owner/repo/actions/runs');
});
test('claim fence rejects duplicates, stale generations, stopped loops, and elapsed deadline', () => {
  const c = { status: 'running', generation: 2, next: 4, owner: null };
  assert.ok(claimable(c, 2, 4, 'one'));
  assert.ok(!claimable({ ...c, owner: { runId: 'one' } }, 2, 4, 'two'));
  assert.ok(!claimable(c, 1, 4, 'one')); assert.ok(!claimable(c, 2, 3, 'one'));
  assert.ok(!claimable({ ...c, status: 'stopped' }, 2, 4, 'one'));
  assert.ok(!claimable({ ...c, deadline: '2020-01-01T00:00:00Z' }, 2, 4, 'one'));
});
test('agent loop snapshot omits scheduling while the control record still enforces the deadline', () => {
  const control = { version: 1, id: 'task', branch: 'codex/shurik/task', status: 'running',
    generation: 1, next: 2, model: 'space-bunny-free', deadline: '2020-01-01T00:00:00Z', seconds: 600,
    owner: { runId: '123', claimedAt: '2019-12-31T23:59:00Z' }, createdAt: '2019-12-31T23:58:00Z',
    lastDispatchAt: '2019-12-31T23:59:00Z', futureSchedulingField: { remainingSeconds: 30 } };
  const snapshot = loopSnapshot(control);
  assert.equal(snapshot.id, control.id); assert.equal(snapshot.model, control.model); assert.equal(snapshot.next, 2);
  for (const key of ['deadline', 'seconds', 'owner', 'createdAt', 'lastDispatchAt', 'futureSchedulingField']) {
    assert.ok(!Object.hasOwn(snapshot, key), `${key} must stay out of task-facing state`);
  }
  assert.equal(control.seconds, 600); assert.ok(stopped(control));
});
test('architecture faults quarantine candidates while provider failures retain a working runner', () => {
  const r = { selected: 'candidate', fallback: 'baseline', probation: true };
  assert.equal(nextRuntime(r, 'runner_failure').selected, 'baseline');
  assert.deepEqual(nextRuntime(r, 'runner_failure').quarantined, ['candidate']);
  assert.equal(nextRuntime(r, 'agent_failure').selected, 'candidate');
  assert.equal(classify(null, 1), 'runner_failure'); assert.equal(classify({ version: 1, outcome: 'timeout' }, 0), 'timeout');
});
test('queued cancellation stops the expected fence, ignores stale generations and owned duplicates', () => {
  const c = { id: 'test', generation: 2, next: 3, owner: null, lastRunId: 'old' };
  const r = { id: 123, conclusion: 'cancelled', display_title: 'Ralph test / iterate 2-3' };
  assert.ok(cancelledForLoop(c, r));
  assert.ok(!cancelledForLoop(c, { ...r, display_title: 'Ralph test / iterate 1-3' }));
  assert.ok(!cancelledForLoop({ ...c, owner: { runId: 'active' } }, r));
  assert.ok(cancelledForLoop({ ...c, owner: { runId: 'active' } }, { ...r, id: 'old' }), 'UI cancellation during handoff stops successor');
});
test('recovery accepts only expected first-party default-branch dispatch; ignores fork/PR outputs', () => {
  const event = { repository: { default_branch: 'main' }, workflow_run: { name: 'Shurik Ralph', event: 'workflow_dispatch',
    head_branch: 'main', repository: { full_name: 'owner/repo' }, head_repository: { full_name: 'owner/repo' } } };
  assert.ok(trustedRecovery(event, 'owner/repo'));
  assert.ok(!trustedRecovery({ ...event, workflow_run: { ...event.workflow_run, head_repository: { full_name: 'attacker/repo' } } }, 'owner/repo'));
  assert.ok(!trustedRecovery({ ...event, workflow_run: { ...event.workflow_run, event: 'pull_request' } }, 'owner/repo'));
});
test('redacts exact credentials and common encoded forms before publication', async () => {
  const key = 'test-secret-12345678901234567890'; const variants = [key, Buffer.from(key).toString('base64'), encodeURIComponent(key)];
  for (const form of variants) assert.ok(!redact(form, [key]).includes(form));
  const dir = await mkdtemp(join(tmpdir(), 'shurik-redact-')); await writeFile(join(dir, 'journal.jsonl'), JSON.stringify({ text: key }) + '\n');
  assert.equal(await sanitizeTree(dir, [key]), 1);
  assert.ok(!String(await readFile(join(dir, 'journal.jsonl'))).includes(key));
  assert.equal(JSON.parse(await readFile(join(dir, 'journal.jsonl'), 'utf8')).text.length, key.length);
});
test('retained bundle digest is checked independently of candidate dependencies; tampering is rejected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shurik-runtime-')); const sha = await retainBundle('dist/worker.cjs', dir, 'source');
  const path = await verifyBundle(dir, sha); assert.ok(path.endsWith('worker.cjs'));
  await writeFile(path, 'broken'); await assert.rejects(verifyBundle(dir, sha), /digest mismatch/);
});
test('Git CAS race preserves a durable stop during worker finalization; no force push', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shurik-cas-')); const remote = join(dir, 'remote'); const seed = join(dir, 'seed');
  await mkdir(seed); await git(dir, 'init', '--bare', remote); await git(seed, 'init'); await configureGit(seed);
  await git(seed, 'remote', 'add', 'origin', remote);
  await saveJson(join(seed, 'control.json'), { version: 1, status: 'running', generation: 1, next: 1, owner: { runId: 'one' } });
  await commit(seed, 'start'); await git(seed, 'push', 'origin', 'HEAD:refs/heads/codex/shurik-control/race');
  const a = join(dir, 'a'); const b = join(dir, 'b'); await git(dir, 'clone', remote, a); await git(dir, 'clone', remote, b);
  await configureGit(a); await configureGit(b);
  const stop = new ControlStore(a, 'race'); const finish = new ControlStore(b, 'race');
  let finishReady; const ready = new Promise(r => { finishReady = r; }); let release; const gate = new Promise(r => { release = r; }); let calls = 0;
  const finalizing = finish.mutate(async c => {
    if (calls++ === 0) { finishReady(); await gate; }
    return { ...c, owner: null, next: 2, status: stopped(c) ? c.status : 'running' };
  });
  await ready; await stop.mutate(c => ({ ...c, status: 'stopped' })); release(); await finalizing;
  const c = (await stop.read()).value;
  assert.equal(c.status, 'stopped'); assert.equal(c.next, 2); assert.ok(calls >= 2, 'stale push retries from newest durable state');
});
test('invalid IDs cannot traverse state paths or inject refs', () => {
  for (const id of ['../main', 'a b', 'foo;bar', '', 'UPPER']) assert.throws(() => validateId(id));
  assert.equal(validateId('proof-123'), 'proof-123');
});
