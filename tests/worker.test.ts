import type { Request as WorkerRequest } from '../src/worker.ts';
import type { SessionSummary } from '../src/history.ts';
import type { WorkerCheckpoint, WorkerResult } from '../scripts/types.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, cp, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
const exec = promisify(execFile);
interface Result extends WorkerResult { captured: unknown[]; minEntryId: number; maxEntryId: number }
interface ProviderBody { reasoning_effort?: string; messages: { role: string; content: string }[] }
const loadWorker = () => createRequire(import.meta.url)(bundle) as { runIteration: (req: WorkerRequest) => Promise<void> };
const bundle = resolve(process.env.SHURIK_BUNDLE ?? 'dist/worker.cjs');
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'shurik-worker-'));
  const cwd = join(dir, 'repo'); await mkdir(cwd);
  return { dir, cwd, journal: join(dir, 'journal'), output: join(dir, 'output') };
}
async function run(f: Awaited<ReturnType<typeof fixture>>, id: string, script: WorkerRequest['script'], sessions: SessionSummary[] = [], extra: Partial<WorkerRequest> = {}): Promise<Result> {
  const output = join(f.dir, id); const req: WorkerRequest = { version: 1, id, cwd: f.cwd, journal: f.journal,
    output, prompt: `Iteration ${id}. Use the available tools.`, model: 'space-bunny-free', reasoning: 'high', seconds: 10, sessions, script, ...extra };
  const file = join(f.dir, `${id}.json`); await writeFile(file, JSON.stringify(req));
  const status = await exec(process.execPath, [bundle, file], { timeout: Math.max(20000, (req.seconds + 10) * 1000) })
    .then(() => 0, error => { if (typeof error.code !== 'number') throw error; return error.code as number; });
  const result = JSON.parse(await readFile(join(output, 'result.json'), 'utf8'));
  assert.equal(status, result.outcome === 'agent_failure' ? 2 : result.outcome === 'runner_failure' ? 1 : 0);
  return result;
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
test('session journals stay independent and immutable while history resolves overlapping entry IDs', async () => {
  const f = await fixture();
  const first = await run(f, 'first-isolated', [
    { tool: 'write', args: { path: 'first.txt', content: 'FIRST_ISOLATED_NEEDLE' } }, { text: 'First finished' }
  ], [], { journalId: '1-1' });
  const firstDir = join(f.journal, 'sessions/1-1');
  const files = await readdir(firstDir);
  const before = await Promise.all(files.map(name => readFile(join(firstDir, name))));
  const session: SessionSummary = { id: '1-1', journalId: '1-1', outcome: first.outcome,
    minEntryId: first.minEntryId, maxEntryId: first.maxEntryId };
  const second = await run(f, 'second-isolated', [
    { tool: 'read_session', args: { id: '1-1', limit: 50 } }, { text: 'SECOND_ISOLATED_NEEDLE' }
  ], [session], { journalId: '1-2' });
  assert.equal(second.outcome, 'yielded');
  assert.equal(first.minEntryId, second.minEntryId, 'entry IDs are local to each journal');
  assert.ok(!JSON.stringify(second.captured[0]).includes('FIRST_ISOLATED_NEEDLE'));
  assert.ok(JSON.stringify(second.captured.at(-1)).includes('FIRST_ISOLATED_NEEDLE'));
  const third = await run(f, 'third-isolated', [
    { tool: 'search_sessions', args: { query: 'SECOND_ISOLATED_NEEDLE' } },
    { tool: 'read_session', args: { id: '1-1', limit: 50 } }, { text: 'Done' }
  ], [session, { id: '1-2', journalId: '1-2', outcome: second.outcome,
    minEntryId: second.minEntryId, maxEntryId: second.maxEntryId }], { journalId: '1-3' });
  assert.equal(third.outcome, 'yielded');
  const search = JSON.stringify(third.captured[1]);
  assert.ok(search.includes('SECOND_ISOLATED_NEEDLE')); assert.ok(search.includes('1-2'));
  assert.deepEqual(await readdir(firstDir), files);
  assert.deepEqual(await Promise.all(files.map(name => readFile(join(firstDir, name)))), before);
  assert.deepEqual((await readdir(join(f.journal, 'sessions'))).sort(), ['1-1', '1-2', '1-3']);
  await assert.rejects(readFile(join(f.journal, 'main.jsonl')), { code: 'ENOENT' });
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
  // Allow shell startup on a loaded runner; the iteration must still abort well before sleep finishes.
  const result = await run(f, 'timed', [{ tool: 'bash', args: { command: 'printf partial > partial.txt; sleep 10' } }], [], { seconds: 2 });
  assert.equal(result.outcome, 'timeout');
  assert.equal(await readFile(join(f.cwd, 'partial.txt'), 'utf8'), 'partial');
  assert.equal((await run(f, 'after-timeout', [{ text: 'Fresh' }])).outcome, 'yielded');
});
test('candidate can reopen a COPY of a retained native journal without replaying work', async () => {
  const f = await fixture();
  const source = process.env.SHURIK_REAL_JOURNAL ?? resolve('tests/fixtures/pi-durable-1.0.2');
  await cp(source, f.journal, { recursive: true });
  assert.equal((await run(f, 'real-state-canary', [{ tool: 'bash', args: { command: 'printf canary > canary.txt' } }, { text: 'canary done' }])).outcome, 'yielded');
  assert.equal(await readFile(join(f.cwd, 'canary.txt'), 'utf8'), 'canary');
});
test('Pi Durable 1.0.2 journal with an interrupted v1 tool opens, aborts old work, and retains readable history', async () => {
  const f = await fixture();
  await cp(resolve('tests/fixtures/pi-durable-1.0.2'), f.journal, { recursive: true });
  const session: SessionSummary = { id: 'legacy-tool-v1', outcome: 'interrupted', minEntryId: 7, maxEntryId: 17 };
  assert.equal((await run(f, 'inspect-legacy', [], [session], { mode: 'inspect' })).outcome, 'readable');
  const fresh = await run(f, 'upgrade-legacy', [
    { tool: 'search_sessions', args: { query: 'LEGACY_COMPLETED_TOOL_NEEDLE' } },
    { tool: 'read_session', args: { id: session.id } }, { text: 'Upgraded' },
  ], [session]);
  assert.equal(fresh.outcome, 'yielded'); assert.equal(fresh.captured.length, 3, 'pending old generation must not replay');
  assert.ok(!JSON.stringify(fresh.captured[0]).includes('LEGACY_COMPLETED_TOOL_NEEDLE'), 'fresh context excludes old transcript');
  assert.ok(JSON.stringify(fresh.captured.at(-1)).includes('LEGACY_COMPLETED_TOOL_NEEDLE'));
  assert.ok(JSON.stringify(fresh.captured.at(-1)).includes('Successfully wrote to legacy.txt'));
  await assert.rejects(readFile(join(f.cwd, 'replayed.txt')));
  const before = await readFile(join(f.journal, 'main.jsonl'));
  const isolated = await run(f, 'isolated-from-legacy', [
    { tool: 'search_sessions', args: { query: 'LEGACY_COMPLETED_TOOL_NEEDLE' } },
    { tool: 'read_session', args: { id: session.id } }, { text: 'New isolated session' }
  ], [session], { journalId: '1-2' });
  assert.equal(isolated.outcome, 'yielded');
  assert.ok(JSON.stringify(isolated.captured.at(-1)).includes('LEGACY_COMPLETED_TOOL_NEEDLE'));
  assert.deepEqual(await readFile(join(f.journal, 'main.jsonl')), before, 'legacy journal stops growing');
});
test('session boundaries survive more than 200 entries and oldest entries remain searchable', async () => {
  const f = await fixture();
  const script = [{ tool: 'write', args: { path: 'many.txt', content: 'OLDEST_RETAINED_ENTRY' } },
    ...Array.from({ length: 102 }, () => ({ tool: 'read', args: { path: 'many.txt' } })), { text: 'many rounds done' }];
  const first = await run(f, 'many', script, [], { seconds: 45, journalId: 'many' });
  assert.equal(first.outcome, 'yielded');
  assert.ok(first.maxEntryId - first.minEntryId > 200);
  const second = await run(f, 'search-many', [{ tool: 'search_sessions', args: { query: 'OLDEST_RETAINED_ENTRY', limit: 1 } }, { text: 'retrieved' }],
    [{ id: 'many', journalId: 'many', outcome: first.outcome, minEntryId: first.minEntryId, maxEntryId: first.maxEntryId }], { journalId: 'search-many' });
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
    journalId: '1-1',
    prompt: 'Write checkpoint evidence', model: 'space-bunny-free', reasoning: 'high', seconds: 20, sessions: [],
    checkpointHandshake: true, checkpointSeconds: 0.001,
    script: [{ tool: 'write', args: { path: 'survived.txt', content: 'INTERRUPTED_SESSION_NEEDLE' } }, { delayMs: 10000, text: 'never finishes' }] }));
  const child = spawn(process.execPath, [bundle, file], { stdio: 'ignore' });
  const closed = new Promise(resolve => child.once('close', resolve));
  const snapshot = join(f.dir, 'published-journal'); let boundary: WorkerCheckpoint | undefined; let initial = false;
  try {
    for (let n = 0; n < 500; n++) {
      let checkpoint: WorkerCheckpoint | undefined;
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
  const fresh = await fixture(); await cp(snapshot, join(fresh.journal, 'sessions/1-1'), { recursive: true });
  const session: SessionSummary = { id: '1-1', journalId: '1-1', outcome: 'interrupted', minEntryId: boundary.minEntryId, maxEntryId: boundary.maxEntryId,
    checkpointAt: boundary.at, transcript: 'checkpoint', recovery: 'diagnostics/recovery/123-1.json' };
  const after = await run(fresh, 'after-interruption', [
    { tool: 'list_sessions', args: {} }, { tool: 'search_sessions', args: { query: 'INTERRUPTED_SESSION_NEEDLE' } },
    { tool: 'read_session', args: { id: '1-1', limit: 50 } }, { text: 'Recovered' }
  ], [session], { journalId: '1-2' });
  assert.equal(after.outcome, 'yielded');
  assert.ok(!JSON.stringify(after.captured[0]).includes('INTERRUPTED_SESSION_NEEDLE'));
  const history = JSON.stringify(after.captured.at(-1));
  assert.ok(history.includes('INTERRUPTED_SESSION_NEEDLE')); assert.ok(history.includes('checkpoint'));
  assert.ok(history.includes('123-1.json'));
});
test('worker rejects missing, invalid and unsupported reasoning instead of choosing a default', async () => {
  const f = await fixture();
  const { runIteration } = loadWorker();
  const req: Omit<WorkerRequest, 'reasoning'> = { version: 1, id: 'reasoning-required', cwd: f.cwd, journal: f.journal,
    output: join(f.dir, 'reasoning-required'), prompt: 'Yield', model: 'space-bunny-free', seconds: 1, sessions: [] };
  for (const reasoning of [undefined, '', 'automatic']) {
    await assert.rejects(runIteration({ ...req, reasoning } as unknown as WorkerRequest), /Explicit reasoning level required/);
  }
  await assert.rejects(runIteration({ ...req, model: 'deepseek-v4.1-flash', reasoning: 'minimal' }), /does not support reasoning minimal/);
});

test('native OpenCode requests send explicit reasoning, apply changes and retain session header across reset', async () => {
  const f = await fixture(); const fetchOriginal = globalThis.fetch; const keyOriginal = process.env.OPENCODE_API_KEY;
  const requests: { url: string; headers: Headers; body: ProviderBody }[] = [];
  process.env.OPENCODE_API_KEY = 'FAKE_KEY_FOR_REQUEST_CONTRACT_TEST';
  globalThis.fetch = async (url, options = {}) => {
    assert.equal(typeof options.body, 'string');
    requests.push({ url: String(url), headers: new Headers(options.headers), body: JSON.parse(options.body as string) });
    const chunks = [
      { id: 'test', object: 'chat.completion.chunk', created: 1, model: 'space-bunny-free', choices: [{ index: 0, delta: { role: 'assistant', content: 'Done.' }, finish_reason: null }] },
      { id: 'test', object: 'chat.completion.chunk', created: 1, model: 'space-bunny-free', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }
    ];
    return new Response(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    const { runIteration } = loadWorker();
    for (const [id, reasoning] of [['headers-first', 'high'], ['headers-second', 'medium']] as const) {
      const output = join(f.dir, id);
      await runIteration({ version: 1, id, cwd: f.cwd, journal: f.journal, output, prompt: 'Use coding tools as needed; then yield.', model: 'space-bunny-free', reasoning, seconds: 10, sessions: [] });
      assert.equal(JSON.parse(await readFile(join(output, 'result.json'), 'utf8')).outcome, 'yielded');
    }
    assert.equal(requests.length, 2);
    assert.match(requests[0].url, /^https:\/\/opencode\.ai\/zen\/go\/v1\/chat\/completions$/);
    assert.equal(requests[0].headers.get('user-agent'), 'shurik/2.0.3');
    assert.equal(requests[0].body.reasoning_effort, 'high');
    assert.equal(requests[1].body.reasoning_effort, 'medium');
    const session = requests[0].headers.get('x-opencode-session');
    assert.ok(session); assert.equal(requests[1].headers.get('x-opencode-session'), session);
  } finally {
    globalThis.fetch = fetchOriginal;
    if (keyOriginal === undefined) delete process.env.OPENCODE_API_KEY; else process.env.OPENCODE_API_KEY = keyOriginal;
  }
});

test('native OpenAI and Anthropic adapters resolve environment credentials and switch providers across journal reopen', async () => {
  const f = await fixture(), requests: { url: string; headers: Headers; body: { model: string } }[] = [];
  const fetchOriginal = globalThis.fetch;
  const credentials = { OPENAI_API_KEY: 'SYNTHETIC_OPENAI_CONTRACT_KEY', ANTHROPIC_API_KEY: 'SYNTHETIC_ANTHROPIC_CONTRACT_KEY' };
  const previous = Object.fromEntries(Object.keys(credentials).map(name => [name, process.env[name]]));
  Object.assign(process.env, credentials);
  globalThis.fetch = async (url, options = {}) => {
    const request = { url: String(url), headers: new Headers(options.headers), body: JSON.parse(options.body as string) };
    requests.push(request);
    const events = request.url.includes('api.openai.com') ? [
      { type: 'response.created', response: { id: 'response-test' } },
      { type: 'response.completed', response: { id: 'response-test', status: 'completed', model: 'gpt-6-sol',
        output: [{ type: 'message', id: 'message-test', status: 'completed', role: 'assistant',
          content: [{ type: 'output_text', text: 'OpenAI done.', annotations: [] }] }],
        usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } } },
    ] : [
      { type: 'message_start', message: { id: 'message-test', type: 'message', role: 'assistant', model: 'claude-haiku-4-5',
        content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Anthropic done.' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } },
      { type: 'message_stop' },
    ];
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
      { headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    const { runIteration } = loadWorker();
    for (const [provider, model] of [['openai', 'gpt-6-sol'], ['anthropic', 'claude-haiku-4-5']]) {
      const output = join(f.dir, provider);
      await runIteration({ version: 1, id: provider, cwd: f.cwd, journal: f.journal, output,
        prompt: 'Yield a final response.', provider, model, reasoning: 'high', seconds: 10, sessions: [] });
      const result = JSON.parse(await readFile(join(output, 'result.json'), 'utf8'));
      assert.equal(result.outcome, 'yielded', JSON.stringify(result.error));
      assert.equal(result.provider, provider); assert.equal(result.model, model);
    }
    assert.equal(requests.length, 2);
    assert.equal(requests[0].url, 'https://api.openai.com/v1/responses');
    assert.equal(requests[0].headers.get('authorization'), 'Bearer ' + credentials.OPENAI_API_KEY);
    assert.equal(requests[0].body.model, 'gpt-6-sol');
    assert.match(requests[1].url, /^https:\/\/api\.anthropic\.com\/v1\/messages(?:\?|$)/);
    assert.equal(requests[1].headers.get('x-api-key'), credentials.ANTHROPIC_API_KEY);
    assert.equal(requests[1].body.model, 'claude-haiku-4-5');
    for (const request of requests) assert.equal(request.headers.get('x-opencode-session'), null);
    await runIteration({ version: 1, id: 'inspect', cwd: f.cwd, journal: f.journal, output: join(f.dir, 'inspect'),
      prompt: '', provider: 'retired-provider', model: 'retired-model', reasoning: 'off', seconds: 1, sessions: [], mode: 'inspect' });
    assert.equal(requests.length, 2, 'inspection does not require a registered provider or make a request');
    const journal = (await Promise.all((await readdir(f.journal)).filter(name => name.endsWith('.jsonl'))
      .map(name => readFile(join(f.journal, name), 'utf8')))).join('\n');
    for (const credential of Object.values(credentials)) assert.ok(!journal.includes(credential));
  } finally {
    globalThis.fetch = fetchOriginal;
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});

test('worker rejects providers without an adapter', async () => {
  const f = await fixture(), { runIteration } = loadWorker();
  const req: WorkerRequest = { version: 1, id: 'invalid-provider', cwd: f.cwd, journal: f.journal,
    output: join(f.dir, 'invalid'), prompt: 'Yield', provider: 'unknown-provider', model: 'space-bunny-free',
    reasoning: 'high', seconds: 1, sessions: [] };
  await assert.rejects(runIteration(req), /Unknown Pi AI provider/);
});

test('newly bundled Step 5 keeps explicit reasoning restrictions without a provider request', async () => {
  const f = await fixture(), { runIteration } = loadWorker(), originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error('Unexpected provider request'); };
  try {
    for (const reasoning of ['xhigh', 'max'] as const) await assert.rejects(runIteration({ version: 1,
      id: 'step-' + reasoning, cwd: f.cwd, journal: f.journal, output: join(f.dir, reasoning),
      provider: 'opencode-go', model: 'step-5-preview-free', reasoning, prompt: 'Yield.', seconds: 1, sessions: [] }),
    /does not support reasoning .*choose low, medium, high/);
    assert.equal(requests, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test('native read sends images through listed and unlisted models, retains them across journal reopen, and diagnoses text-only models', async () => {
  const f = await fixture(), { runIteration } = loadWorker();
  const image = await readFile(resolve('tests/fixtures/images/sample.png'));
  await writeFile(join(f.cwd, 'screenshot.png'), image);
  const originalFetch = globalThis.fetch, originalKey = process.env.OPENCODE_API_KEY;
  const requests: { model: string; reasoning_effort: string; messages: unknown[] }[] = [];
  process.env.OPENCODE_API_KEY = 'SYNTHETIC_IMAGE_CONTRACT_KEY';
  globalThis.fetch = async (url, options = {}) => {
    assert.equal(String(url), 'https://opencode.ai/zen/go/v1/chat/completions');
    assert.equal(new Headers(options.headers).get('authorization'), 'Bearer SYNTHETIC_IMAGE_CONTRACT_KEY');
    const body = JSON.parse(options.body as string); requests.push(body);
    const reading = requests.length % 2 === 1;
    const delta = reading ? { role: 'assistant', tool_calls: [{ index: 0, id: 'image-read-' + requests.length,
      type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'screenshot.png' }) } }] }
      : { role: 'assistant', content: 'Image round completed.' };
    const chunks = [
      { id: 'images', object: 'chat.completion.chunk', created: 1, model: body.model,
        choices: [{ index: 0, delta, finish_reason: null }] },
      { id: 'images', object: 'chat.completion.chunk', created: 1, model: body.model,
        choices: [{ index: 0, delta: {}, finish_reason: reading ? 'tool_calls' : 'stop' }] },
    ];
    return new Response(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    for (const [model, provisional] of [['step-5-preview-free', false], ['unlisted-image-proof', true],
      ['minimax-m2.7', false]] as const) {
      const output = join(f.dir, model);
      await runIteration({ version: 1, id: model, cwd: f.cwd, journal: f.journal, output,
        provider: 'opencode-go', model, reasoning: 'high', prompt: 'Read screenshot.png then yield.', seconds: 10, sessions: [] });
      const result = JSON.parse(await readFile(join(output, 'result.json'), 'utf8'));
      assert.equal(result.outcome, 'yielded', JSON.stringify(result.error));
      assert.equal(result.provisionalModel, provisional);
    }
    assert.equal(requests.length, 6);
    for (const request of requests) assert.equal(request.reasoning_effort, 'high');
    const attachment = 'data:image/png;base64,' + image.toString('base64');
    assert.ok(JSON.stringify(requests[1].messages).includes(attachment));
    assert.ok(JSON.stringify(requests[3].messages).includes(attachment), 'unlisted IDs also receive the image');
    assert.ok(!JSON.stringify(requests[5].messages).includes(attachment));
    assert.match(JSON.stringify(requests[5].messages), /placeholder|image/i);
    const journal = (await Promise.all((await readdir(f.journal)).filter(name => name.endsWith('.jsonl'))
      .map(name => readFile(join(f.journal, name), 'utf8')))).join('\n');
    assert.ok(journal.includes(image.toString('base64')), 'native journal retains image content');
    assert.match(journal, /does not support images; it sees a placeholder instead/);
    assert.ok(!journal.includes('SYNTHETIC_IMAGE_CONTRACT_KEY'));
    await runIteration({ version: 1, id: 'inspect-images', cwd: f.cwd, journal: f.journal, output: join(f.dir, 'inspect-images'),
      provider: 'opencode-go', model: 'step-5-preview-free', reasoning: 'high', prompt: '', seconds: 1, sessions: [], mode: 'inspect' });
    assert.equal(requests.length, 6, 'image-journal inspection is network-free');
    const cold = await run(f, 'cold-images', [{ tool: 'read', args: { path: 'screenshot.png' } }, { text: 'Reopened' }]);
    assert.equal(cold.outcome, 'yielded');
    assert.ok(JSON.stringify(cold.captured.at(-1)).includes(image.toString('base64')));
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENCODE_API_KEY; else process.env.OPENCODE_API_KEY = originalKey;
  }
});

test('unlisted model IDs reach the native provider with explicit reasoning; missing IDs return provider errors', async () => {
  const f = await fixture(), { runIteration } = loadWorker();
  const originalFetch = globalThis.fetch, originalKey = process.env.OPENCODE_API_KEY;
  const requests: { url: string; headers: Headers; body: { model: string; reasoning_effort: string; max_tokens: number } }[] = [];
  process.env.OPENCODE_API_KEY = 'SYNTHETIC_UNLISTED_MODEL_KEY';
  globalThis.fetch = async (url, options = {}) => {
    const request = { url: String(url), headers: new Headers(options.headers), body: JSON.parse(options.body as string) };
    requests.push(request);
    if (request.body.model === 'missing-native-model') return Response.json({ error: {
      message: 'MODEL_NOT_FOUND_NATIVE_PROOF', type: 'invalid_request_error', code: 'model_not_found',
    } }, { status: 404 });
    if (['xhigh', 'max'].includes(request.body.reasoning_effort)) return Response.json({ error: {
      message: 'REASONING_LEVEL_NOT_SUPPORTED_NATIVE_PROOF', type: 'invalid_request_error',
    } }, { status: 400 });
    const chunks = [
      { id: 'unlisted', object: 'chat.completion.chunk', created: 1, model: request.body.model,
        choices: [{ index: 0, delta: { role: 'assistant', content: 'Exact model worked.' }, finish_reason: null }] },
      { id: 'unlisted', object: 'chat.completion.chunk', created: 1, model: request.body.model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } },
    ];
    return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    for (const [id, model, reasoning, expected] of [
      ['unlisted', 'unlisted-native-proof', 'high', 'yielded'],
      ['missing', 'missing-native-model', 'high', 'agent_failure'],
      ['unsupported', 'unlisted-native-proof', 'xhigh', 'agent_failure'],
      ['unsupported-max', 'unlisted-native-proof', 'max', 'agent_failure'],
    ] as const) {
      const output = join(f.dir, id);
      await runIteration({ version: 1, id, cwd: f.cwd, journal: f.journal, output,
        provider: 'opencode-go', model, reasoning, prompt: 'Yield.', seconds: 10, sessions: [] });
      const result = JSON.parse(await readFile(join(output, 'result.json'), 'utf8'));
      assert.equal(result.outcome, expected, JSON.stringify(result.error));
      assert.equal(result.model, model); assert.equal(result.reasoning, reasoning); assert.equal(result.provisionalModel, true);
    }
    assert.equal(requests.length, 4, 'one exact-model attempt per iteration; no catalog requests or alternate models');
    assert.deepEqual(requests.map(r => [r.body.model, r.body.reasoning_effort]), [
      ['unlisted-native-proof', 'high'], ['missing-native-model', 'high'], ['unlisted-native-proof', 'xhigh'],
      ['unlisted-native-proof', 'max'],
    ]);
    for (const request of requests) {
      assert.equal(request.url, 'https://opencode.ai/zen/go/v1/chat/completions');
      assert.equal(request.headers.get('authorization'), 'Bearer SYNTHETIC_UNLISTED_MODEL_KEY');
      assert.ok(request.headers.get('x-opencode-session')); assert.ok(request.body.max_tokens > 0);
    }
    const journal = (await Promise.all((await readdir(f.journal)).filter(name => name.endsWith('.jsonl'))
      .map(name => readFile(join(f.journal, name), 'utf8')))).join('\n');
    assert.match(journal, /MODEL_NOT_FOUND_NATIVE_PROOF/); assert.match(journal, /REASONING_LEVEL_NOT_SUPPORTED_NATIVE_PROOF/);
    assert.ok(!journal.includes('SYNTHETIC_UNLISTED_MODEL_KEY'));
    await runIteration({ version: 1, id: 'inspect-unlisted', cwd: f.cwd, journal: f.journal, output: join(f.dir, 'inspect-unlisted'),
      provider: 'opencode-go', model: 'missing-native-model', reasoning: 'off', prompt: '', seconds: 1, sessions: [], mode: 'inspect' });
    assert.equal(requests.length, 4, 'inspection stays network-free');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENCODE_API_KEY; else process.env.OPENCODE_API_KEY = originalKey;
  }
});

test('checkpoint feedback reaches native system messages and gates the next request until publication', async () => {
  const f = await fixture(); const output = join(f.dir, 'time-feedback');
  const fetchOriginal = globalThis.fetch; const keyOriginal = process.env.OPENCODE_API_KEY;
  const requests: ProviderBody[] = []; const checkpoints: WorkerCheckpoint[] = []; const monitorErrors: unknown[] = [];
  process.env.OPENCODE_API_KEY = 'FAKE_KEY_FOR_CHECKPOINT_TEST';
  globalThis.fetch = async (_url, options = {}) => {
    assert.equal(typeof options.body, 'string');
    requests.push(JSON.parse(options.body as string));
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
    let nonce: string | undefined;
    while (!finished) {
      let boundary: WorkerCheckpoint | undefined;
      try { boundary = JSON.parse(await readFile(join(output, 'checkpoint.json'), 'utf8')); } catch {}
      if (boundary && boundary.nonce !== nonce) {
        nonce = boundary.nonce; checkpoints.push(boundary);
        try {
          const snapshot = join(output, 'checkpoint-journal');
          const files = await readdir(snapshot, { recursive: true });
          const journal = (await Promise.all(files.filter(name => name.endsWith('.jsonl')).map(name => readFile(join(snapshot, name), 'utf8')))).join('\n');
          assert.ok(journal.includes('Actively pursue verified progress'), 'progress guidance is durable in the prepared journal and its native sidecars');
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
    const { runIteration } = loadWorker();
    await runIteration({ version: 1, id: 'time-feedback', cwd: f.cwd, journal: f.journal, output,
      prompt: 'Save progress then yield.', model: 'space-bunny-free', reasoning: 'high', seconds: 9,
      deadline: new Date(Date.now() + 60000).toISOString(), checkpointHandshake: true, checkpointSeconds: 3, sessions: [] });
    assert.deepEqual(monitorErrors, []);
    assert.equal(JSON.parse(await readFile(join(output, 'result.json'), 'utf8')).outcome, 'yielded');
    assert.deepEqual(checkpoints.map(c => c.phase), ['started', 'tools', 'tools']);
    assert.equal(requests.length, 3);
    const systems = requests.map(r => r.messages.filter(m => m.role === 'system').map(m => m.content).join('\n'));
    for (const s of systems.slice(0, 2)) {
      assert.doesNotMatch(s, /Time update|\d{4}-\d{2}-\d{2}T|seconds remain|overall loop deadline|handoff|preempt|next fresh-context iteration/);
    }
    const finalSystem = systems.at(-1); assert.ok(finalSystem);
    const match = finalSystem.match(/about (\d+) seconds remain in this iteration/); assert.ok(match);
    const remaining = Number(match[1]);
    assert.ok(remaining > 0 && remaining <= 3, 'only the final configured checkpoint interval introduces preemption guidance');
    assert.match(finalSystem, /overall loop deadline/);
    assert.match(finalSystem, /next fresh-context iteration/);
    assert.match(finalSystem, /save recoverable partial results/);
    assert.match(finalSystem, /Keep pursuing useful work after saving the handoff until preemption/);
    assert.equal((finalSystem.match(/Time update at/g) ?? []).length, 1, 'only the final checkpoint introduces a clock announcement');
    for (const s of systems) {
      assert.match(s, /continue useful work after saving/);
      assert.match(s, /make and verify useful repairs/);
      assert.match(s, /Reserve a final response for a task objective that has been fully achieved and verified/);
      assert.doesNotMatch(s, /Yield early|external blocker|prevents all useful progress/);
    }
  } finally {
    finished = true; await monitor;
    globalThis.fetch = fetchOriginal;
    if (keyOriginal === undefined) delete process.env.OPENCODE_API_KEY; else process.env.OPENCODE_API_KEY = keyOriginal;
  }
});
