import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, cp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const bundle = resolve(process.env.SHURIK_BUNDLE ?? 'dist/worker.cjs');
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'shurik-worker-'));
  const cwd = join(dir, 'repo'); await mkdir(cwd);
  return { dir, cwd, journal: join(dir, 'journal'), output: join(dir, 'output') };
}
async function run(f, id, script, sessions = [], extra = {}) {
  const output = join(f.dir, id); const req = { version: 1, id, cwd: f.cwd, journal: f.journal,
    output, prompt: `Iteration ${id}. Use the available tools.`, model: 'space-bunny-free', seconds: 10, sessions, script, ...extra };
  const file = join(f.dir, `${id}.json`); await writeFile(file, JSON.stringify(req));
  await exec(process.execPath, [bundle, file], { timeout: 20000 });
  return JSON.parse(await readFile(join(output, 'result.json'), 'utf8'));
}
test('standalone bundle: coding tools, native JSONL reopen, fresh context, all history tools', async () => {
  const f = await fixture();
  const first = await run(f, 'first', [{ tool: 'write', args: { path: 'evidence.txt', content: 'PAST_SESSION_NEEDLE' } }, { text: 'First finished PAST_SESSION_NEEDLE' }]);
  assert.equal(first.outcome, 'yielded'); assert.equal(await readFile(join(f.cwd, 'evidence.txt'), 'utf8'), 'PAST_SESSION_NEEDLE');
  assert.ok(first.minEntryId && first.maxEntryId >= first.minEntryId);
  const session = { id: 'first', outcome: first.outcome, minEntryId: first.minEntryId, maxEntryId: first.maxEntryId };
  const second = await run(f, 'second', [
    { tool: 'list_sessions', args: {} }, { tool: 'search_sessions', args: { query: 'PAST_SESSION_NEEDLE', limit: 1 } },
    { tool: 'read_session', args: { id: 'first', limit: 10 } }, { text: 'Second finished' }
  ], [session]);
  assert.equal(second.outcome, 'yielded');
  assert.ok(!JSON.stringify(second.captured[0]).includes('PAST_SESSION_NEEDLE'), 'old transcript must not enter fresh context');
  assert.ok(JSON.stringify(second.captured.at(-1)).includes('PAST_SESSION_NEEDLE'), 'history remains retrievable');
  const inspect = await run(f, 'inspect', [], [session], { mode: 'inspect' });
  assert.equal(inspect.outcome, 'readable');
});
test('agent error retains partial coding work and next iteration can repair', async () => {
  const f = await fixture();
  const failed = await run(f, 'failed', [{ tool: 'write', args: { path: 'broken.txt', content: 'partial' } }, { error: 'Intentional provider failure' }]);
  assert.equal(failed.outcome, 'agent_failure');
  assert.equal(await readFile(join(f.cwd, 'broken.txt'), 'utf8'), 'partial');
  const repaired = await run(f, 'repair', [{ tool: 'edit', args: { path: 'broken.txt', oldText: 'partial', newText: 'repaired' } }, { text: 'Repaired' }], [{ id: 'failed', outcome: failed.outcome, minEntryId: failed.minEntryId, maxEntryId: failed.maxEntryId }]);
  assert.equal(repaired.outcome, 'yielded'); assert.equal(await readFile(join(f.cwd, 'broken.txt'), 'utf8'), 'repaired');
});
test('time budget aborts work and journal opens in a new process', async () => {
  const f = await fixture();
  const result = await run(f, 'timed', [{ tool: 'bash', args: { command: 'printf partial > partial.txt; sleep 10' } }], [], { seconds: 0.3 });
  assert.equal(result.outcome, 'timeout');
  assert.equal(await readFile(join(f.cwd, 'partial.txt'), 'utf8'), 'partial');
  assert.equal((await run(f, 'after-timeout', [{ text: 'Fresh' }])).outcome, 'yielded');
});
test('candidate can reopen a COPY of the real journal without replaying work', async () => {
  if (!process.env.SHURIK_REAL_JOURNAL) return;
  const f = await fixture(); await cp(process.env.SHURIK_REAL_JOURNAL, f.journal, { recursive: true });
  assert.equal((await run(f, 'real-state-canary', [{ tool: 'bash', args: { command: 'printf canary > canary.txt' } }, { text: 'canary done' }])).outcome, 'yielded');
  assert.equal(await readFile(join(f.cwd, 'canary.txt'), 'utf8'), 'canary');
});
test('abrupt worker death leaves pending work that the next process aborts before fresh input', async () => {
  const f = await fixture(); const output = join(f.dir, 'killed'); const file = join(f.dir, 'kill.json');
  await writeFile(file, JSON.stringify({ version: 1, id: 'killed', cwd: f.cwd, journal: f.journal, output,
    prompt: 'OLD_INPUT_MUST_NOT_REPLAY', model: 'space-bunny-free', seconds: 10, sessions: [], script: [{ delayMs: 10000, text: 'old' }] }));
  const child = spawn(process.execPath, [bundle, file], { stdio: 'ignore' });
  const closed = new Promise(resolve => child.once('close', resolve));
  for (let i = 0; i < 100; i++) {
    try { if ((await readFile(join(f.journal, 'main.jsonl'), 'utf8')).includes('OLD_INPUT_MUST_NOT_REPLAY')) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  child.kill('SIGKILL'); await closed;
  const fresh = await run(f, 'fresh', [{ text: 'new' }]);
  assert.equal(fresh.outcome, 'yielded');
  assert.equal(fresh.captured.length, 1, 'pending generation must not replay against new provider script');
  assert.ok(!JSON.stringify(fresh.captured[0]).includes('OLD_INPUT_MUST_NOT_REPLAY'));
});
