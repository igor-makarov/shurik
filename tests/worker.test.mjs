import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, cp, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
const exec = promisify(execFile);
const bundle = resolve(process.env.SHURIK_BUNDLE ?? 'dist/worker.cjs');
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'shurik-worker-'));
  const cwd = join(dir, 'repo'); await mkdir(cwd);
  return { dir, cwd, journal: join(dir, 'journal'), output: join(dir, 'output') };
}
async function run(f, id, script, sessions = [], extra = {}) {
  const output = join(f.dir, id); const req = { version: 1, id, cwd: f.cwd, journal: f.journal,
    output, prompt: `Iteration ${id}. Use the available tools.`, model: 'space-bunny-free', reasoning: 'high', seconds: 10, sessions, script, ...extra };
  const file = join(f.dir, `${id}.json`); await writeFile(file, JSON.stringify(req));
  await exec(process.execPath, [bundle, file], { timeout: Math.max(20000, (req.seconds + 10) * 1000) });
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
test('candidate can reopen a COPY of the real journal without replaying work', { skip: !process.env.SHURIK_REAL_JOURNAL }, async () => {
  const f = await fixture(); await cp(process.env.SHURIK_REAL_JOURNAL, f.journal, { recursive: true });
  assert.equal((await run(f, 'real-state-canary', [{ tool: 'bash', args: { command: 'printf canary > canary.txt' } }, { text: 'canary done' }])).outcome, 'yielded');
  assert.equal(await readFile(join(f.cwd, 'canary.txt'), 'utf8'), 'canary');
});
test('session boundaries survive more than 200 entries and oldest entries remain searchable', async () => {
  const f = await fixture();
  const script = [{ tool: 'write', args: { path: 'many.txt', content: 'OLDEST_RETAINED_ENTRY' } },
    ...Array.from({ length: 102 }, () => ({ tool: 'read', args: { path: 'many.txt' } })), { text: 'many rounds done' }];
  const first = await run(f, 'many', script, [], { seconds: 45 });
  assert.equal(first.outcome, 'yielded');
  assert.ok(first.maxEntryId - first.minEntryId > 200);
  const second = await run(f, 'search-many', [{ tool: 'search_sessions', args: { query: 'OLDEST_RETAINED_ENTRY', limit: 1 } }, { text: 'retrieved' }],
    [{ id: 'many', outcome: first.outcome, minEntryId: first.minEntryId, maxEntryId: first.maxEntryId }]);
  assert.equal(second.outcome, 'yielded');
  assert.ok(JSON.stringify(second.captured.at(-1)).includes('OLDEST_RETAINED_ENTRY'));
});
test('abrupt worker death leaves pending work that the next process aborts before fresh input', async () => {
  const f = await fixture(); const output = join(f.dir, 'killed'); const file = join(f.dir, 'kill.json');
  await writeFile(file, JSON.stringify({ version: 1, id: 'killed', cwd: f.cwd, journal: f.journal, output,
    prompt: 'OLD_INPUT_MUST_NOT_REPLAY', model: 'space-bunny-free', reasoning: 'high', seconds: 10, sessions: [], script: [{ delayMs: 10000, text: 'old' }] }));
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
test('published checkpoint boundaries make a killed session searchable from a fresh process', async () => {
  const f = await fixture(); const output = join(f.dir, 'checkpoint-output'); const file = join(f.dir, 'checkpoint-request.json');
  await writeFile(file, JSON.stringify({ version: 1, id: 'loop:1-1', cwd: f.cwd, journal: f.journal, output,
    prompt: 'Write checkpoint evidence', model: 'space-bunny-free', reasoning: 'high', seconds: 20, sessions: [],
    checkpointHandshake: true, checkpointSeconds: 0.001,
    script: [{ tool: 'write', args: { path: 'survived.txt', content: 'INTERRUPTED_SESSION_NEEDLE' } }, { delayMs: 10000, text: 'never finishes' }] }));
  const child = spawn(process.execPath, [bundle, file], { stdio: 'ignore' });
  const closed = new Promise(resolve => child.once('close', resolve));
  const snapshot = join(f.dir, 'published-journal'); let boundary; let initial = false;
  try {
    for (let n = 0; n < 500; n++) {
      let checkpoint;
      try { checkpoint = JSON.parse(await readFile(join(output, 'checkpoint.json'), 'utf8')); } catch {}
      if (checkpoint?.phase === 'started' && !initial) {
        initial = true; assert.ok(checkpoint.minEntryId <= checkpoint.maxEntryId);
        await writeFile(join(output, 'checkpoint.ack'), checkpoint.nonce);
      }
      if (checkpoint?.phase === 'tools') {
        boundary = checkpoint; await cp(join(output, 'checkpoint-journal'), snapshot, { recursive: true }); break;
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(initial, 'a session boundary is available before any model request');
    assert.ok(boundary, 'a durable tool-round checkpoint was produced');
  } finally { child.kill('SIGKILL'); await closed; }
  await assert.rejects(readFile(join(output, 'result.json')), 'no final result survived');
  const fresh = await fixture(); await cp(snapshot, fresh.journal, { recursive: true });
  const session = { id: '1-1', outcome: 'interrupted', minEntryId: boundary.minEntryId, maxEntryId: boundary.maxEntryId,
    checkpointAt: boundary.at, transcript: 'checkpoint', recovery: 'diagnostics/recovery/123-1.json' };
  const after = await run(fresh, 'after-interruption', [
    { tool: 'list_sessions', args: {} }, { tool: 'search_sessions', args: { query: 'INTERRUPTED_SESSION_NEEDLE' } },
    { tool: 'read_session', args: { id: '1-1', limit: 50 } }, { text: 'Recovered' }
  ], [session]);
  assert.equal(after.outcome, 'yielded');
  assert.ok(!JSON.stringify(after.captured[0]).includes('INTERRUPTED_SESSION_NEEDLE'));
  const history = JSON.stringify(after.captured.at(-1));
  assert.ok(history.includes('INTERRUPTED_SESSION_NEEDLE')); assert.ok(history.includes('checkpoint'));
  assert.ok(history.includes('123-1.json'));
});
test('worker rejects missing, invalid and unsupported reasoning instead of choosing a default', async () => {
  const f = await fixture();
  const { runIteration } = createRequire(import.meta.url)(bundle);
  const req = { version: 1, id: 'reasoning-required', cwd: f.cwd, journal: f.journal,
    output: join(f.dir, 'reasoning-required'), prompt: 'Yield', model: 'space-bunny-free', seconds: 1, sessions: [] };
  for (const reasoning of [undefined, '', 'automatic']) {
    await assert.rejects(runIteration({ ...req, reasoning }), /Explicit reasoning level required/);
  }
  await assert.rejects(runIteration({ ...req, reasoning: 'minimal' }), /does not support reasoning minimal/);
});

test('native OpenCode requests send explicit reasoning, apply changes and retain session header across reset', async () => {
  const f = await fixture(); const fetchOriginal = globalThis.fetch; const keyOriginal = process.env.OPENCODE_API_KEY;
  const requests = [];
  process.env.OPENCODE_API_KEY = 'FAKE_KEY_FOR_REQUEST_CONTRACT_TEST';
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), headers: new Headers(options.headers), body: JSON.parse(options.body) });
    const chunks = [
      { id: 'test', object: 'chat.completion.chunk', created: 1, model: 'space-bunny-free', choices: [{ index: 0, delta: { role: 'assistant', content: 'Done.' }, finish_reason: null }] },
      { id: 'test', object: 'chat.completion.chunk', created: 1, model: 'space-bunny-free', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }
    ];
    return new Response(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    const { runIteration } = createRequire(import.meta.url)(bundle);
    for (const [id, reasoning] of [['headers-first', 'high'], ['headers-second', 'medium']]) {
      const output = join(f.dir, id);
      await runIteration({ version: 1, id, cwd: f.cwd, journal: f.journal, output, prompt: 'Use coding tools as needed; then yield.', model: 'space-bunny-free', reasoning, seconds: 10, sessions: [] });
      assert.equal(JSON.parse(await readFile(join(output, 'result.json'), 'utf8')).outcome, 'yielded');
    }
    assert.equal(requests.length, 2);
    assert.match(requests[0].url, /^https:\/\/opencode\.ai\/zen\/go\/v1\/chat\/completions$/);
    assert.equal(requests[0].headers.get('user-agent'), 'shurik/0.1.0');
    assert.equal(requests[0].body.reasoning_effort, 'high');
    assert.equal(requests[1].body.reasoning_effort, 'medium');
    const session = requests[0].headers.get('x-opencode-session');
    assert.ok(session); assert.equal(requests[1].headers.get('x-opencode-session'), session);
  } finally {
    globalThis.fetch = fetchOriginal;
    if (keyOriginal === undefined) delete process.env.OPENCODE_API_KEY; else process.env.OPENCODE_API_KEY = keyOriginal;
  }
});

test('checkpoint feedback reaches native system messages and gates the next request until publication', async () => {
  const f = await fixture(); const output = join(f.dir, 'time-feedback');
  const fetchOriginal = globalThis.fetch; const keyOriginal = process.env.OPENCODE_API_KEY;
  const requests = []; const checkpoints = []; const monitorErrors = [];
  process.env.OPENCODE_API_KEY = 'FAKE_KEY_FOR_CHECKPOINT_TEST';
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    const tools = requests.length <= 2;
    const delta = tools ? { role: 'assistant', tool_calls: [{ index: 0, id: `time-tool-${requests.length}`, type: 'function',
      function: { name: 'bash', arguments: JSON.stringify({ command: 'sleep 3.1; printf saved > time-feedback.txt' }) } }] }
      : { role: 'assistant', content: 'Saved work for the next iteration.' };
    const chunks = [
      { id: 'time', object: 'chat.completion.chunk', created: 1, model: 'space-bunny-free', choices: [{ index: 0, delta, finish_reason: null }] },
      { id: 'time', object: 'chat.completion.chunk', created: 1, model: 'space-bunny-free', choices: [{ index: 0, delta: {}, finish_reason: tools ? 'tool_calls' : 'stop' }] }
    ];
    return new Response(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  };
  let finished = false;
  const monitor = (async () => {
    let nonce;
    while (!finished) {
      let boundary;
      try { boundary = JSON.parse(await readFile(join(output, 'checkpoint.json'), 'utf8')); } catch {}
      if (boundary && boundary.nonce !== nonce) {
        nonce = boundary.nonce; checkpoints.push(boundary);
        try {
          const snapshot = join(output, 'checkpoint-journal');
          const files = await readdir(snapshot, { recursive: true });
          const journal = (await Promise.all(files.filter(name => name.endsWith('.jsonl')).map(name => readFile(join(snapshot, name), 'utf8')))).join('\n');
          assert.ok(journal.includes('Time update at'), 'time feedback is durable in the prepared journal and its native sidecars');
          if (boundary.phase === 'tools') {
            const beforePublication = requests.length;
            await new Promise(resolve => setTimeout(resolve, 150));
            assert.equal(requests.length, beforePublication, 'next model request waits for checkpoint acknowledgement');
          }
        } catch (error) { monitorErrors.push(error); }
        await writeFile(join(output, 'checkpoint.ack'), nonce);
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  })();
  try {
    const { runIteration } = createRequire(import.meta.url)(bundle);
    await runIteration({ version: 1, id: 'time-feedback', cwd: f.cwd, journal: f.journal, output,
      prompt: 'Save progress then yield.', model: 'space-bunny-free', reasoning: 'high', seconds: 9,
      deadline: new Date(Date.now() + 60000).toISOString(), checkpointHandshake: true, checkpointSeconds: 3, sessions: [] });
    assert.deepEqual(monitorErrors, []);
    assert.equal(JSON.parse(await readFile(join(output, 'result.json'), 'utf8')).outcome, 'yielded');
    assert.deepEqual(checkpoints.map(c => c.phase), ['started', 'tools', 'tools']);
    assert.equal(requests.length, 3);
    const systems = requests.map(r => r.messages.filter(m => m.role === 'system').map(m => m.content).join('\n'));
    for (const s of systems.slice(0, 2)) {
      assert.doesNotMatch(s, /seconds remain|overall loop deadline|handoff|preempt|next fresh-context iteration/);
    }
    const finalSystem = systems.at(-1);
    const remaining = Number(finalSystem.match(/about (\d+) seconds remain in this iteration/)[1]);
    assert.ok(remaining > 0 && remaining <= 3, 'only the final configured checkpoint interval introduces preemption guidance');
    assert.match(finalSystem, /overall loop deadline/);
    assert.match(finalSystem, /next fresh-context iteration/);
    assert.match(finalSystem, /save recoverable partial results/);
    assert.match(finalSystem, /Keep pursuing useful work after saving the handoff until preemption/);
    for (const s of systems) {
      assert.match(s, /continue useful work after saving/);
      assert.match(s, /make and verify useful repairs/);
      assert.match(s, /Yield early only when the task objective is achieved or an external blocker/);
      assert.equal((s.match(/Time update at/g) ?? []).length, 1, 'only the latest time update enters each system prompt');
    }
  } finally {
    finished = true; await monitor;
    globalThis.fetch = fetchOriginal;
    if (keyOriginal === undefined) delete process.env.OPENCODE_API_KEY; else process.env.OPENCODE_API_KEY = keyOriginal;
  }
});
