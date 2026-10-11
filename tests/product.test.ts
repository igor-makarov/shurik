import type { WorkerRequest, WorkerResult, Sessions } from '../scripts/types.ts';
import { controlFixture, iterationFixture } from './test-support.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, cp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseArgs } from '../bin/shurik.ts';
import { actionOptions, checkoutEngine } from '../action/run.ts';
import { PATHS, runtimeState, runtimeLogs, runtimeEmergency, sessionPaths } from '../scripts/paths.ts';
import { projectConfig } from '../scripts/config.ts';
import { git, configureGit, commit, saveJson, readJson, ControlStore } from '../scripts/github.ts';
import { initializeCheckpoint, loadState, publishCheckpoint } from '../scripts/state.ts';
import { launchWorker } from '../scripts/runtime.ts';
const exec = promisify(execFile);
const cli = resolve('bin/shurik.ts'), bundle = resolve('dist/worker.cjs');

process.env.SHURIK_HOME = await mkdtemp(join(tmpdir(), 'shurik-home-product-'));
process.env.GITHUB_REPOSITORY = 'fixture/product';

test('runtime sessions are outside the checkout and scoped by repository and loop identity', () => {
  const first = sessionPaths('/tmp/project', 'demo', 'alice/project');
  assert.equal(first.runtime.state, join(process.env.SHURIK_HOME!, 'state/alice/project/demo'));
  assert.notEqual(first.runtime.state, runtimeState('bob/project', 'demo'));
  assert.equal(first.control.journal, 'state/pi-jsonl');
  assert.throws(() => runtimeState('../project', 'demo'), /Repository/);
  assert.throws(() => runtimeState('alice/..', 'demo'), /Repository/);
});

test('CLI and action input validation keep explicit reasoning and allow flags to override dispatch inputs', () => {
  assert.equal(parseArgs(['resume', '--reasoning', 'high'], { command: 'stop', reasoning: 'low' }).reasoning, 'high');
  assert.equal(parseArgs(['start', '--create-pr', 'false'], { create_pr: 'auto' }).create_pr, 'false');
  assert.equal(actionOptions({ SHURIK_INPUTS: '{"create_pr":"auto","loop_id":"demo"}', SHURIK_CREATE_PR: 'false' }).create_pr, 'false');
  assert.equal(actionOptions({ SHURIK_INPUTS: '{"command":"iterate","loop_id":"demo","iteration":"2"}', SHURIK_MODEL: 'model' }).command, 'iterate');
  assert.equal(actionOptions({ SHURIK_INPUTS: '{"command":"recover"}' }).command, 'recover');
  assert.throws(() => parseArgs(['start', '--unknown', 'value']), /Unknown option/);
  assert.throws(() => actionOptions({ SHURIK_LOOP_ID: '../main' }), /Loop ID/);
  assert.throws(() => parseArgs(['unknown']), /Unknown command/);
});

test('action configuration works without a project config file and overrides legacy settings', async () => {
  const project = await mkdtemp(join(tmpdir(), 'shurik-config-'));
  assert.equal((await projectConfig(project)).checkpointSeconds, 300);
  const inputs = { model: 'custom', seconds: '120', checkpoint_seconds: '60', prompt: 'tasks/task.md', checkpoint_paths: '["data/cache"]' };
  const config = await projectConfig(project, inputs);
  assert.equal(config.model, 'custom'); assert.equal(config.iterationSeconds, 120);
  assert.equal(config.checkpointSeconds, 60); assert.deepEqual(config.checkpointPaths, ['data/cache']);
  assert.deepEqual(await readdir(project), [], 'configuration does not create a file');
  await saveJson(join(project, PATHS.config), { version: 1, model: 'custom', checkpointSeconds: 90, prompt: 'tasks/task.md' });
  assert.equal((await projectConfig(project)).model, 'custom');
  assert.equal((await projectConfig(project, inputs)).checkpointSeconds, 60);
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
  const store = new ControlStore(ctl, 'demo'), state = runtimeState(process.env.GITHUB_REPOSITORY, 'demo');
  await mkdir(join(state, PATHS.journal), { recursive: true });
  await saveJson(join(state, PATHS.history), []);
  await initializeCheckpoint({ workspace: project, state, store,
    control: controlFixture({ version: 1, id: 'demo', stateStorage: 'control', branch: 'codex/shurik/demo',
      generation: 1, next: 1, owner: null, status: 'running' }), message: 'initialize consumer' });
  const request: WorkerRequest = { version: 1, id: 'demo:1-1', model: 'space-bunny-free', reasoning: 'high',
    seconds: 10, sessions: [], prompt: 'Use coding tools on the consumer',
    script: [{ tool: 'write', args: { path: 'demo.txt', content: 'UNRELATED_CONSUMER_HISTORY' } }, { text: 'Saved' }] };
  const result = await launchWorker({ workspace: project, state, bundle, stable: resolve('.'), req: request });
  assert.equal(result.outcome, 'yielded', result.log);
  assert.ok(result.result);
  const session = iterationFixture({ id: '1-1', outcome: result.outcome, minEntryId: result.result.minEntryId, maxEntryId: result.result.maxEntryId });
  await saveJson(join(state, PATHS.history), [session]);
  await publishCheckpoint({ workspace: project, state, store, generation: 1, owner: null,
    sequence: '1-1', message: 'save consumer history', record: session });
  assert.deepEqual((await git(project, 'ls-tree', '-r', '--name-only', 'HEAD')).split('\n'), ['PROMPT.md', 'demo.txt']);
  assert.equal(await readFile(join(project, 'demo.txt'), 'utf8'), 'UNRELATED_CONSUMER_HISTORY');
  const cold = join(dir, 'cold'); await git(dir, 'clone', remote, cold); await git(cold, 'checkout', 'codex/shurik/demo');
  const restored = await loadState(store, cold, 'demo');
  const retrieved = await launchWorker({ workspace: cold, state: restored, bundle, stable: resolve('.'), req: {
    ...request, id: 'demo:1-2', sessions: await readJson<Sessions>(join(restored, PATHS.history)),
    script: [{ tool: 'search_sessions', args: { query: 'UNRELATED_CONSUMER_HISTORY' } }, { text: 'Retrieved' }]
  } });
  assert.equal(retrieved.outcome, 'yielded', retrieved.log);
  assert.ok(retrieved.result?.captured);
  assert.ok(JSON.stringify(retrieved.result.captured.at(-1)).includes('UNRELATED_CONSUMER_HISTORY'));
  const output = join(dir, 'inspect'); await mkdir(output);
  const inspectReq = join(dir, 'inspect.json'); await saveJson(inspectReq, { ...request, journal: join(restored, PATHS.journal), output });
  const before = await readFile(join(restored, PATHS.journal, 'main.jsonl'));
  await exec(process.execPath, [cli, 'inspect', '--request', inspectReq]);
  assert.equal((await readJson<WorkerResult>(join(output, 'result.json'))).outcome, 'readable');
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
  await mkdir(join(project, '.github/workflows'), { recursive: true });
  await writeFile(join(project, '.github/workflows/shurik.yml'), 'name: Old workflow\n');
  const source = await commit(project, 'consumer source');
  await writeFile(join(project, '.github/workflows/shurik.yml'), 'name: Current workflow\n');
  await commit(project, 'consumer workflow update');
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
  const originalFetch = globalThis.fetch, dispatches: { ref: string; return_run_details: boolean; inputs: Record<string, string> }[] = []; let prAllowed = false, prAttempts = 0, failDispatch = false;
  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    globalThis.fetch = async (url, init = {}) => {
      const path = new URL(url instanceof Request ? url.url : url).pathname;
      if (path.endsWith('/permission')) return Response.json({ permission: 'write' });
      if (path.endsWith('/repos/fixture/consumer')) return Response.json({ default_branch: 'main' });
      if (path.endsWith('/commits/older-task-source')) return Response.json({ sha: source });
      if (path.endsWith('/actions/runs/100')) return Response.json({ id: 100, workflow_id: 55,
        name: 'Shurik demo / 1', display_title: 'Shurik demo / 1',
        event: 'workflow_dispatch', status: 'in_progress', conclusion: null, head_branch: 'main',
        repository: { full_name: 'fixture/consumer' }, head_repository: { full_name: 'fixture/consumer' } });
      if (path.endsWith('/actions/workflows/55')) return Response.json({ name: 'Shurik' });
      if (path.endsWith('/actions/runs/100/jobs')) return Response.json({ jobs: [
        { id: 456, name: 'iteration', status: 'completed', conclusion: 'success' } ] });
      if (path.endsWith('/pulls')) {
        if (init.method !== 'POST') return Response.json([]);
        prAttempts++;
        return prAllowed ? Response.json({ html_url: 'https://github.com/fixture/consumer/pull/1' })
          : Response.json({ message: 'GitHub Actions is not permitted to create or approve pull requests.' }, { status: 403 });
      }
      if (path.endsWith('/dispatches')) {
        if (failDispatch) throw new Error('INJECTED_DISPATCH_FAILURE');
        assert.equal(typeof init.body, 'string');
        const body = JSON.parse(init.body as string); assert.equal(body.return_run_details, true);
        dispatches.push(body); return Response.json({ workflow_run_id: 100 + dispatches.length - 1 });
      }
      throw new Error(`Unexpected API request: ${url}`);
    };
    const { main } = await import(`../scripts/supervisor.ts?consumer=${Date.now()}`);
    await main({ command: 'start', loop_id: 'demo', reasoning: 'high', workflow: 'agent.yml', source_ref: 'older-task-source',
      seconds: '20', checkpoint_seconds: '1', prompt: 'PROMPT.md', checkpoint_paths: '[]' });
    const ctl = join(dir, 'inspect-control'); await git(dir, 'clone', remote, ctl); await configureGit(ctl);
    const store = new ControlStore(ctl, 'demo');
    const started = (await store.read()).value;
    assert.equal(await git(ctl, 'show', `${(await store.read()).revision}:.github/workflows/shurik.yml`), 'name: Current workflow');
    await git(ctl, 'fetch', 'origin', started.branch);
    assert.equal(await git(ctl, 'show', `${started.checkpoint!.workCommit}:.github/workflows/shurik.yml`), 'name: Current workflow');
    assert.equal(started.source, source); assert.notEqual(started.source, engineSHA);
    assert.equal(started.seconds, 20); assert.deepEqual(started.engine, { repository: 'fixture/shurik', ref: 'v1' });
    assert.equal(started.checkpointSeconds, 1); assert.deepEqual(started.checkpointPaths, []);
    assert.deepEqual((await readdir(project)).sort(), ['.git', '.github', 'PROMPT.md']);
    assert.equal(started.pr, null, 'PR creation being disabled does not prevent starting the loop');
    assert.equal(started.createPr, false, 'auto learns that this repository disallows PR creation');
    assert.equal(dispatches[0].inputs.supervisor_ref, undefined, 'reusable continuation does not pin an engine');
    await main({ command: 'iterate', loop_id: 'demo', generation: '1', iteration: '1' });
    const { value, revision } = await store.read();
    assert.equal(value.next, 2); assert.equal(value.owner, null);
    assert.equal(value.pr, null, 'PR creation being disabled does not prevent completing an iteration');
    assert.equal(prAttempts, 1, 'later iterations do not retry a denied optional PR');
    const record = JSON.parse(await git(ctl, 'show', `${revision}:state/iterations/1-1.json`));
    assert.equal(record.outcome, 'yielded'); assert.equal(record.runtime, engineSHA);
    const logs = runtimeLogs('fixture/consumer', 'demo');
    assert.equal((await readJson<WorkerResult>(join(logs, '1-1-worker.json'))).outcome, 'yielded');
    assert.equal(JSON.parse(await git(ctl, 'show', `${revision}:state/diagnostics/1-1-worker.json`)).outcome, 'yielded');
    assert.ok(!(await readdir(runtimeState('fixture/consumer', 'demo'))).includes('diagnostics'));
    await git(ctl, 'fetch', 'origin', value.branch);
    assert.equal(await git(ctl, 'show', `${value.checkpoint!.workCommit}:consumer-result.txt`), 'SUPERVISOR_CONSUMER_PROOF');
    assert.equal(dispatches.length, 2);
    assert.equal(dispatches[1].inputs.iteration, '2');
    assert.equal(dispatches[1].inputs.supervisor_ref, undefined);
    prAllowed = true;
    await store.mutate(c => ({ ...c, createPr: true }), 'fixture: enable draft PRs');
    await main({ command: 'iterate', loop_id: 'demo', generation: '1', iteration: '2' });
    const continued = (await store.read()).value;
    assert.equal(continued.next, 3); assert.equal(continued.owner, null);
    assert.equal(continued.pr, 'https://github.com/fixture/consumer/pull/1');
    assert.equal(continued.createPr, true);
    assert.equal(dispatches.length, 3);
    const oldEvent = process.env.GITHUB_EVENT_NAME, oldResult = process.env.SHURIK_ITERATION_RESULT;
    try {
      process.env.GITHUB_EVENT_NAME = 'workflow_dispatch'; process.env.SHURIK_ITERATION_RESULT = 'success';
      await main({ command: 'recover' });
      assert.equal(dispatches.length, 3, 'recovery verifies the workflow name by ID and does not duplicate the successor');
    } finally {
      if (oldEvent === undefined) delete process.env.GITHUB_EVENT_NAME; else process.env.GITHUB_EVENT_NAME = oldEvent;
      if (oldResult === undefined) delete process.env.SHURIK_ITERATION_RESULT; else process.env.SHURIK_ITERATION_RESULT = oldResult;
    }
    await main({ command: 'stop', loop_id: 'demo' });
    await main({ command: 'resume', loop_id: 'demo', reasoning: 'medium' });
    const resumed = (await store.read()).value;
    assert.equal(resumed.generation, 2); assert.equal(resumed.next, 3);
    assert.equal(dispatches[3].inputs.generation, '2'); assert.equal(dispatches[3].inputs.iteration, '3');
    assert.deepEqual(resumed.dispatchedRuns?.slice(-2), [
      { runId: '102', generation: 1, iteration: 3 }, { runId: '103', generation: 2, iteration: 3 }
    ]);
    await main({ command: 'iterate', loop_id: 'demo', generation: '1', iteration: '3' });
    assert.equal(dispatches.length, 4, 'old queued iteration is skipped without claiming or redispatching');
    await main({ command: 'iterate', loop_id: 'demo', generation: '2', iteration: '3' });
    assert.equal((await store.read()).value.next, 4);
    const resumedRecord = JSON.parse(await git(ctl, 'show', `${(await store.read()).revision}:state/iterations/2-3.json`));
    assert.equal(resumedRecord.iteration, 3); assert.equal(resumedRecord.outcome, 'yielded');
    await main({ command: 'start', loop_id: 'without-pr', reasoning: 'high', create_pr: false, source_ref: 'older-task-source' });
    assert.equal(prAttempts, 2, 'explicit false never attempts PR creation even when GitHub allows it');
    failDispatch = true;
    await assert.rejects(main({ command: 'start', loop_id: 'failed-dispatch', reasoning: 'high', create_pr: false }), /INJECTED_DISPATCH_FAILURE/);
    const emergency = runtimeEmergency('fixture/consumer', 'failed-dispatch');
    assert.equal(await readFile(join(emergency, 'workspace/PROMPT.md'), 'utf8'), 'Implement a small consumer change');
    assert.ok(await readFile(join(emergency, 'state/history-index.json')));
    assert.deepEqual(await readdir(join(emergency, 'logs')), []);
    assert.equal(await git(project, 'status', '--porcelain'), '', 'failure evidence creates no task files or ignore rules');
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
