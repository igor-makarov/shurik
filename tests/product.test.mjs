import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, cp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseArgs } from '../bin/shurik.mjs';
import { actionOptions, checkoutEngine } from '../action/run.mjs';
import { PATHS, runtimeState, sessionPaths } from '../scripts/paths.mjs';
import { projectConfig } from '../scripts/config.mjs';
import { git, configureGit, commit, saveJson, readJson, ControlStore } from '../scripts/github.mjs';
import { initializeCheckpoint, loadState, publishCheckpoint } from '../scripts/state.mjs';
import { launchWorker } from '../scripts/runtime.mjs';
const exec = promisify(execFile);
const cli = resolve('bin/shurik.mjs'), bundle = resolve('dist/worker.cjs');

test('CLI and action input validation keep explicit reasoning and allow flags to override dispatch inputs', () => {
  assert.equal(parseArgs(['resume', '--reasoning', 'high'], { command: 'stop', reasoning: 'low' }).reasoning, 'high');
  assert.equal(actionOptions({ SHURIK_INPUTS: '{"command":"iterate","loop_id":"demo","iteration":"2"}', SHURIK_MODEL: 'model' }).command, 'iterate');
  assert.equal(actionOptions({ SHURIK_INPUTS: '{"command":"recover"}' }).command, 'recover');
  assert.throws(() => parseArgs(['start', '--unknown', 'value']), /Unknown option/);
  assert.throws(() => actionOptions({ SHURIK_LOOP_ID: '../main' }), /Loop ID/);
  assert.throws(() => parseArgs(['unknown']), /Unknown command/);
});

test('consumer configuration belongs to the project and is optional', async () => {
  const project = await mkdtemp(join(tmpdir(), 'shurik-config-'));
  assert.equal((await projectConfig(project)).checkpointSeconds, 300);
  await saveJson(join(project, PATHS.config), { version: 1, model: 'custom', checkpointSeconds: 90, prompt: 'tasks/task.md' });
  assert.equal((await projectConfig(project)).model, 'custom');
  for (const prompt of ['../secret', '/absolute']) {
    await saveJson(join(project, PATHS.config), { prompt });
    await assert.rejects(projectConfig(project), /relative project file/);
  }
});

test('major action tags resolve again on every invocation and receive updates within the major version', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shurik-release-')), source = join(dir, 'source');
  await mkdir(source); await git(source, 'init'); await configureGit(source);
  await writeFile(join(source, 'version.txt'), 'first'); const first = await commit(source, 'v1 initial');
  await git(source, 'tag', 'v1');
  const oldCheckout = join(dir, 'old'); await mkdir(oldCheckout);
  assert.equal(await checkoutEngine(oldCheckout, source, 'v1'), first);
  await writeFile(join(source, 'version.txt'), 'second'); const second = await commit(source, 'v1 update');
  await git(source, 'tag', '-f', 'v1');
  const newCheckout = join(dir, 'new'); await mkdir(newCheckout);
  assert.equal(await checkoutEngine(newCheckout, source, 'v1'), second);
});

test('an unrelated consumer with no Shurik source runs the CLI, publishes native history, and restores it cold', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shurik-consumer-')), project = join(dir, 'project'), remote = join(dir, 'remote');
  await mkdir(project); await git(project, 'init'); await configureGit(project);
  await writeFile(join(project, 'PROMPT.md'), 'Work on this unrelated project');
  await commit(project, 'consumer baseline'); await git(dir, 'init', '--bare', remote);
  await git(project, 'remote', 'add', 'origin', remote);
  await git(project, 'push', 'origin', 'HEAD:refs/heads/main');
  const ctl = join(dir, 'control'); await git(dir, 'clone', remote, ctl); await configureGit(ctl);
  await git(ctl, 'checkout', '-b', 'codex/shurik-control/demo', 'origin/main');
  const store = new ControlStore(ctl, 'demo'), state = runtimeState(project, 'demo');
  await mkdir(join(state, PATHS.journal), { recursive: true });
  await saveJson(join(state, PATHS.history), []);
  await initializeCheckpoint({ workspace: project, state, store,
    control: { version: 1, id: 'demo', stateStorage: 'control', branch: 'codex/shurik/demo',
      generation: 1, next: 1, owner: null, status: 'running' }, message: 'initialize consumer' });
  const request = { version: 1, id: 'demo:1-1', model: 'space-bunny-free', reasoning: 'high',
    seconds: 10, sessions: [], prompt: 'Use coding tools on the consumer',
    script: [{ tool: 'write', args: { path: 'demo.txt', content: 'UNRELATED_CONSUMER_HISTORY' } }, { text: 'Saved' }] };
  const result = await launchWorker({ workspace: project, state, bundle, stable: resolve('.'), req: request });
  assert.equal(result.outcome, 'yielded', result.log);
  const session = { id: '1-1', outcome: result.outcome, minEntryId: result.result.minEntryId, maxEntryId: result.result.maxEntryId };
  await saveJson(join(state, PATHS.history), [session]);
  await publishCheckpoint({ workspace: project, state, store, generation: 1, owner: null,
    sequence: '1-1', message: 'save consumer history', record: session });
  assert.deepEqual((await git(project, 'ls-tree', '-r', '--name-only', 'HEAD')).split('\n'), ['PROMPT.md', 'demo.txt']);
  assert.equal(await readFile(join(project, 'demo.txt'), 'utf8'), 'UNRELATED_CONSUMER_HISTORY');
  const cold = join(dir, 'cold'); await git(dir, 'clone', remote, cold); await git(cold, 'checkout', 'codex/shurik/demo');
  const restored = await loadState(store, cold, 'demo');
  const retrieved = await launchWorker({ workspace: cold, state: restored, bundle, stable: resolve('.'), req: {
    ...request, id: 'demo:1-2', sessions: await readJson(join(restored, PATHS.history)),
    script: [{ tool: 'search_sessions', args: { query: 'UNRELATED_CONSUMER_HISTORY' } }, { text: 'Retrieved' }]
  } });
  assert.equal(retrieved.outcome, 'yielded', retrieved.log);
  assert.ok(JSON.stringify(retrieved.result.captured.at(-1)).includes('UNRELATED_CONSUMER_HISTORY'));
  const output = join(dir, 'inspect'); await mkdir(output);
  const inspectReq = join(dir, 'inspect.json'); await saveJson(inspectReq, { ...request, journal: join(restored, PATHS.journal), output });
  const before = await readFile(join(restored, PATHS.journal, 'main.jsonl'));
  await exec(process.execPath, [cli, 'inspect', '--request', inspectReq]);
  assert.equal((await readJson(join(output, 'result.json'))).outcome, 'readable');
  assert.deepEqual(await readFile(join(restored, PATHS.journal, 'main.jsonl')), before, 'inspect never mutates the canonical journal');
  const printed = JSON.parse((await exec(process.execPath, [cli, 'paths', '--loop-id', 'demo', '--workspace', cold])).stdout);
  assert.deepEqual(printed, sessionPaths(cold, 'demo'));
  assert.equal(printed.runtime.state, restored);
  assert.equal(await git(cold, 'status', '--porcelain'), '');
});

test('supervisor starts and completes an unrelated consumer loop using the current released engine', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shurik-supervisor-consumer-'));
  const project = join(dir, 'project'), engine = join(dir, 'engine'), remote = join(dir, 'remote');
  await mkdir(project); await mkdir(engine);
  await git(project, 'init', '-b', 'main'); await configureGit(project);
  await writeFile(join(project, 'PROMPT.md'), 'Implement a small consumer change');
  await saveJson(join(project, PATHS.config), { iterationSeconds: 20, checkpointSeconds: 1 });
  const source = await commit(project, 'consumer source');
  await git(dir, 'init', '--bare', remote); await git(project, 'remote', 'add', 'origin', remote);
  await git(project, 'push', 'origin', 'main'); await git(dir, '--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  for (const name of ['src', 'scripts', 'bin', 'package.json', 'package-lock.json']) {
    await cp(resolve(name), join(engine, name), { recursive: true });
  }
  // Test-only engine fixture scripts the real native worker; production has no provider bypass.
  const worker = join(engine, 'src/worker.ts');
  await writeFile(worker, (await readFile(worker, 'utf8')).replace('export async function runIteration(req: Request) {',
    `export async function runIteration(req: Request) {
      req.script = [{ tool: 'write', args: { path: 'consumer-result.txt', content: 'SUPERVISOR_CONSUMER_PROOF' } }, { text: 'Done' }];`));
  await git(engine, 'init'); await configureGit(engine);
  const engineSHA = await commit(engine, 'scripted engine release');
  const gitConfig = join(dir, 'gitconfig');
  await writeFile(gitConfig, `[url "${remote}"]\n\tinsteadOf = https://github.com/fixture/consumer.git\n`);
  const overrides = { GIT_CONFIG_GLOBAL: gitConfig, GITHUB_REPOSITORY: 'fixture/consumer',
    GITHUB_ACTOR: 'maintainer', GITHUB_REF: 'refs/heads/main', GITHUB_RUN_ID: '100',
    GITHUB_TOKEN: 'TEST_ONLY_TOKEN', GH_TOKEN: undefined, SHURIK_PROJECT_ROOT: project,
    SHURIK_ENGINE_ROOT: engine, SHURIK_ENGINE_REPOSITORY: 'fixture/shurik', SHURIK_ACTION_REF: 'v1' };
  const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  const originalFetch = globalThis.fetch, dispatches = [];
  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    globalThis.fetch = async (url, init = {}) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/permission')) return Response.json({ permission: 'write' });
      if (path.endsWith('/repos/fixture/consumer')) return Response.json({ default_branch: 'main' });
      if (path.endsWith('/pulls')) return Response.json(init.method === 'POST' ? { html_url: 'https://github.com/fixture/consumer/pull/1' } : []);
      if (path.endsWith('/dispatches')) { dispatches.push(JSON.parse(init.body)); return new Response(null, { status: 204 }); }
      throw new Error(`Unexpected API request: ${url}`);
    };
    const { main } = await import(`../scripts/supervisor.mjs?consumer=${Date.now()}`);
    await main({ command: 'start', loop_id: 'demo', reasoning: 'high', workflow: 'agent.yml' });
    const ctl = join(dir, 'inspect-control'); await git(dir, 'clone', remote, ctl);
    const store = new ControlStore(ctl, 'demo');
    const started = (await store.read()).value;
    assert.equal(started.source, source); assert.notEqual(started.source, engineSHA);
    assert.equal(started.seconds, 20); assert.deepEqual(started.engine, { repository: 'fixture/shurik', ref: 'v1' });
    assert.equal(dispatches[0].inputs.supervisor_ref, undefined, 'reusable continuation does not pin an engine');
    await main({ command: 'iterate', loop_id: 'demo', generation: '1', iteration: '1' });
    const { value, revision } = await store.read();
    assert.equal(value.next, 2); assert.equal(value.owner, null);
    assert.equal(value.pr, 'https://github.com/fixture/consumer/pull/1');
    const record = JSON.parse(await git(ctl, 'show', `${revision}:state/iterations/1-1.json`));
    assert.equal(record.outcome, 'yielded'); assert.equal(record.runtime, engineSHA);
    await git(ctl, 'fetch', 'origin', value.branch);
    assert.equal(await git(ctl, 'show', `${value.checkpoint.workCommit}:consumer-result.txt`), 'SUPERVISOR_CONSUMER_PROOF');
    assert.equal(dispatches.length, 2);
    assert.equal(dispatches[1].inputs.iteration, '2');
    assert.equal(dispatches[1].inputs.supervisor_ref, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
