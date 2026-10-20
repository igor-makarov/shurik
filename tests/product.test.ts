import type { WorkerRequest, WorkerResult, WorkerCheckpoint, Sessions } from '../scripts/types.ts';
import { controlFixture, iterationFixture, runFixture } from './test-support.ts';
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
import { reconcileLoop } from '../scripts/failures.ts';
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

test('CLI and action accept model JSON and reject the removed flat workflow inputs', () => {
  const model = JSON.stringify({ provider: 'openai', name: 'gpt-6-sol', reasoning: 'high' });
  assert.equal(parseArgs(['start', '--model', model], { model: '{}' }).model, model);
  assert.equal(actionOptions({ SHURIK_INPUTS: '{"loop_id":"demo","model":{}}', SHURIK_MODEL: model }).model, model);
  assert.throws(() => parseArgs(['start', '--provider', 'openai']), /Unknown option/);
  assert.throws(() => actionOptions({ SHURIK_INPUTS: '{"loop_id":"demo","provider":"openai"}' }), /removed in v2/);
  assert.equal(parseArgs(['start', '--create-pr', 'false'], { create_pr: 'auto' }).create_pr, 'false');
  assert.equal(actionOptions({ SHURIK_INPUTS: '{"create_pr":"auto","loop_id":"demo"}', SHURIK_CREATE_PR: 'false' }).create_pr, 'false');
  assert.equal(actionOptions({ SHURIK_INPUTS: '{"command":"iterate","loop_id":"demo","iteration":"2"}' }).command, 'iterate');
  assert.equal(actionOptions({ SHURIK_INPUTS: '{"command":"recover"}' }).command, 'recover');
  assert.throws(() => parseArgs(['start', '--unknown', 'value']), /Unknown option/);
  assert.throws(() => actionOptions({ SHURIK_LOOP_ID: '../main' }), /Loop ID/);
  assert.throws(() => parseArgs(['unknown']), /Unknown command/);
});

test('v2 operational configuration uses built-in defaults and ignores legacy project files', async () => {
  const project = await mkdtemp(join(tmpdir(), 'shurik-config-'));
  const base = { provider: 'openai', model: 'custom' };
  assert.equal((await projectConfig(project, base)).checkpointSeconds, 300);
  const inputs = { ...base, work_seconds: '120', wait_seconds: '10800', checkpoint_seconds: '60', prompt: 'tasks/task.md', checkpoint_paths: '["data/cache"]' };
  const config = await projectConfig(project, inputs);
  assert.equal(config.model, 'custom'); assert.equal(config.iterationSeconds, 120);
  assert.equal(config.waitSeconds, 10800);
  assert.equal(config.checkpointSeconds, 60); assert.deepEqual(config.checkpointPaths, ['data/cache']);
  assert.deepEqual(await readdir(project), [], 'configuration does not create a file');
  await saveJson(join(project, PATHS.config), { version: 1, model: 'custom', checkpointSeconds: 90, prompt: 'tasks/task.md' });
  assert.equal((await projectConfig(project, base)).checkpointSeconds, 300);
  assert.equal((await projectConfig(project, inputs)).checkpointSeconds, 60);
  for (const checkpoint_seconds of ['0', '1', '1800']) {
    assert.equal((await projectConfig(project, { ...base, checkpoint_seconds })).checkpointSeconds, Number(checkpoint_seconds));
  }
  assert.equal((await projectConfig(project, { ...base, checkpoint_seconds: '' })).checkpointSeconds, 300);
  for (const checkpoint_seconds of ['-1', '1801', '1.5', 'NaN', 'Infinity', 'false', ' ']) {
    await assert.rejects(projectConfig(project, { ...base, checkpoint_seconds }), /checkpoint-seconds/);
  }
  for (const prompt of ['../secret', '/absolute']) {
    await assert.rejects(projectConfig(project, { ...base, prompt }), /relative project file/);
  }
});

test('new starts require a complete explicit model without a provider or model default', async () => {
  const project = await mkdtemp(join(tmpdir(), 'shurik-providers-'));
  await assert.rejects(projectConfig(project), /Explicit model/);
  await assert.rejects(projectConfig(project, { provider: 'openai' }), /Explicit model/);
  const config = await projectConfig(project, { provider: 'openai', model: 'gpt-6-sol' });
  assert.equal(config.provider, 'openai'); assert.equal(config.model, 'gpt-6-sol');
  await saveJson(join(project, PATHS.config), { version: 1, provider: 'anthropic', model: 'claude-haiku-4-5' });
  await assert.rejects(projectConfig(project), /Explicit model/);
  await assert.rejects(projectConfig(project, { provider: 'openai' }), /Explicit model/);
  await assert.rejects(projectConfig(project, { provider: '../provider', model: 'custom' }), /Provider/);
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
  await git(ctl, 'checkout', '-b', 'shurik-control/demo', 'origin/main');
  const store = new ControlStore(ctl, 'demo'), state = runtimeState(process.env.GITHUB_REPOSITORY, 'demo');
  await mkdir(join(state, PATHS.journal), { recursive: true });
  await saveJson(join(state, PATHS.history), []);
  await initializeCheckpoint({ workspace: project, state, store,
    control: controlFixture({ version: 1, id: 'demo', stateStorage: 'control', branch: 'demo',
      generation: 1, next: 1, owner: null, status: 'running' }), message: 'initialize consumer' });
  const request: WorkerRequest = { version: 1, id: 'demo:1-1', journalId: '1-1', model: 'space-bunny-free', reasoning: 'high',
    seconds: 10, sessions: [], prompt: 'Use coding tools on the consumer',
    script: [{ tool: 'write', args: { path: 'demo.txt', content: 'UNRELATED_CONSUMER_HISTORY' } }, { text: 'Saved' }] };
  const result = await launchWorker({ workspace: project, state, bundle, stable: resolve('.'), req: request });
  assert.equal(result.outcome, 'yielded', result.log);
  assert.ok(result.result);
  const session = iterationFixture({ id: '1-1', journalId: '1-1', outcome: result.outcome, minEntryId: result.result.minEntryId, maxEntryId: result.result.maxEntryId });
  await saveJson(join(state, PATHS.history), [session]);
  await publishCheckpoint({ workspace: project, state, store, generation: 1, owner: null,
    sequence: '1-1', message: 'save consumer history', record: session });
  assert.deepEqual((await git(project, 'ls-tree', '-r', '--name-only', 'HEAD')).split('\n'), ['PROMPT.md', 'demo.txt']);
  assert.equal(await readFile(join(project, 'demo.txt'), 'utf8'), 'UNRELATED_CONSUMER_HISTORY');
  const cold = join(dir, 'cold'); await git(dir, 'clone', remote, cold); await git(cold, 'checkout', 'demo');
  const restored = await loadState(store, cold, 'demo');
  const retrieved = await launchWorker({ workspace: cold, state: restored, bundle, stable: resolve('.'), req: {
    ...request, id: 'demo:1-2', journalId: '1-2', sessions: await readJson<Sessions>(join(restored, PATHS.history)),
    script: [{ tool: 'search_sessions', args: { query: 'UNRELATED_CONSUMER_HISTORY' } }, { text: 'Retrieved' }]
  } });
  assert.equal(retrieved.outcome, 'yielded', retrieved.log);
  assert.ok(retrieved.result?.captured);
  assert.ok(JSON.stringify(retrieved.result.captured.at(-1)).includes('UNRELATED_CONSUMER_HISTORY'));
  const output = join(dir, 'inspect'); await mkdir(output);
  const inspectReq = join(dir, 'inspect.json'); await saveJson(inspectReq, { ...request, journal: join(restored, PATHS.journal), output });
  const before = await readFile(join(restored, PATHS.journal, 'sessions/1-1/main.jsonl'));
  await exec(process.execPath, [cli, 'inspect', '--request', inspectReq]);
  assert.equal((await readJson<WorkerResult>(join(output, 'result.json'))).outcome, 'readable');
  assert.deepEqual(await readFile(join(restored, PATHS.journal, 'sessions/1-1/main.jsonl')), before, 'inspect never mutates the canonical journal');
  const printed = JSON.parse((await exec(process.execPath, [cli, 'paths', '--loop-id', 'demo', '--workspace', cold])).stdout);
  assert.deepEqual(printed, sessionPaths(cold, 'demo'));
  assert.equal(printed.runtime.state, restored);
  assert.equal(await git(cold, 'status', '--porcelain'), '');
});

test('zero disables all worker checkpoints while retaining the local completed journal', async () => {
  for (const checkpointSeconds of [0, 0.001]) {
    const dir = await mkdtemp(join(tmpdir(), 'shurik-checkpoint-toggle-'));
    const workspace = join(dir, 'repo'); await mkdir(workspace);
    const checkpoints: WorkerCheckpoint[] = [];
    const report = await launchWorker({ workspace, state: join(dir, 'state'), bundle, stable: resolve('.'),
      req: { version: 1, id: 'checkpoint-toggle', journalId: '1-1', model: 'space-bunny-free', reasoning: 'high',
        seconds: 10, checkpointSeconds, sessions: [], prompt: 'Save useful work',
        script: [{ delayMs: 20, tool: 'write', args: { path: 'saved.txt', content: 'CHECKPOINT_TOGGLE_NEEDLE' } },
          { delayMs: 20, tool: 'read', args: { path: 'saved.txt' } }, { text: 'Finished' }] },
      onCheckpoint: async checkpoint => { checkpoints.push(checkpoint); }
    });
    assert.equal(report.outcome, 'yielded', report.log);
    assert.deepEqual(checkpoints.map(c => c.phase), checkpointSeconds === 0 ? [] : ['started', 'tools', 'tools']);
    assert.equal(await readFile(join(workspace, 'saved.txt'), 'utf8'), 'CHECKPOINT_TOGGLE_NEEDLE');
    const journal = await readFile(join(dir, 'state/pi-jsonl/sessions/1-1/main.jsonl'), 'utf8');
    assert.match(journal, /CHECKPOINT_TOGGLE_NEEDLE/); assert.match(journal, /Finished/);
    assert.ok(report.result!.maxEntryId! > report.result!.minEntryId!, 'the local journal includes completed tool work');
    if (checkpointSeconds === 0) assert.match(JSON.stringify(report.result!.captured![0]), /Automatic task checkpoints are disabled/);
  }
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
      req.script = [{ tool: 'write', args: { path: 'consumer-result.txt', content: 'SUPERVISOR_CONSUMER_PROOF' } },
        { tool: 'write', args: { path: 'provider-selection.json', content: JSON.stringify({ provider: req.provider, model: req.model, checkpointSeconds: req.checkpointSeconds, prompt: (req.prompt ?? '').includes('Swarm:') ? req.prompt : undefined }) } },
        ...(req.checkpointSeconds === 0 ? [
          { tool: 'bash', args: { command: 'git add consumer-result.txt provider-selection.json && git commit -m "Agent verified work"' } },
          { tool: 'write', args: { path: 'uncommitted.txt', content: 'DO_NOT_CHECKPOINT_UNFINISHED_WORK' } }
        ] : []),
        req.id === 'inference:1-1' ? { error: 'INJECTED_INFERENCE_FAILURE' } : { text: 'Done' }];`));
  await git(engine, 'init'); await configureGit(engine);
  const engineSHA = await commit(engine, 'scripted engine release');
  const gitConfig = join(dir, 'gitconfig');
  await writeFile(gitConfig, `[url "${remote}"]\n\tinsteadOf = https://github.com/fixture/consumer.git\n`);
  const overrides = { GIT_CONFIG_GLOBAL: gitConfig, GITHUB_REPOSITORY: 'fixture/consumer',
    GITHUB_ACTOR: 'maintainer', GITHUB_REF: 'refs/heads/main', GITHUB_RUN_ID: '100',
    GITHUB_TOKEN: 'TEST_ONLY_TOKEN', GH_TOKEN: undefined, SHURIK_PROJECT_ROOT: project,
    SHURIK_ENGINE_ROOT: engine, SHURIK_ENGINE_REPOSITORY: 'fixture/shurik', SHURIK_ACTION_REF: 'v2', GITHUB_STEP_SUMMARY: join(dir, 'summary.md') };
  const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  const originalFetch = globalThis.fetch, dispatches: { ref: string; return_run_details: boolean; inputs: Record<string, string> }[] = []; let prAllowed = false, prAttempts = 0, failDispatch = false, failDispatchFor = '';
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
        if (body.inputs.loop_id === failDispatchFor) throw new Error('INJECTED_MEMBER_DISPATCH_FAILURE');
        dispatches.push(body); return Response.json({ workflow_run_id: 100 + dispatches.length - 1 });
      }
      throw new Error(`Unexpected API request: ${url}`);
    };
    const { main } = await import(`../scripts/supervisor.ts?consumer=${Date.now()}`);
    await main({ command: 'start', loop_id: 'demo', model: { provider: 'openai', name: 'gpt-6-sol', reasoning: 'high' }, workflow: 'agent.yml', source_ref: 'older-task-source',
      work_seconds: '20', checkpoint_seconds: '1', prompt: 'PROMPT.md', checkpoint_paths: '[]' });
    const ctl = join(dir, 'inspect-control'); await git(dir, 'clone', remote, ctl); await configureGit(ctl);
    const store = new ControlStore(ctl, 'demo');
    const started = (await store.read()).value;
    assert.equal(started.branch, 'demo'); assert.equal(store.branch, 'shurik-control/demo');
    await assert.rejects(main({ command: 'start', loop_id: 'demo', model: { provider: 'openai', name: 'gpt-6-sol', reasoning: 'high' } }), /already exists; use resume/);
    assert.equal(started.provider, 'openai'); assert.equal(started.model, 'gpt-6-sol');
    assert.equal(await git(ctl, 'show', `${(await store.read()).revision}:.github/workflows/shurik.yml`), 'name: Current workflow');
    await git(ctl, 'fetch', 'origin', started.branch);
    assert.equal(await git(ctl, 'show', `${started.checkpoint!.workCommit}:.github/workflows/shurik.yml`), 'name: Current workflow');
    assert.equal(started.source, source); assert.notEqual(started.source, engineSHA);
    assert.equal(started.seconds, 20); assert.deepEqual(started.engine, { repository: 'fixture/shurik', ref: 'v2' });
    assert.equal(started.checkpointSeconds, 1); assert.deepEqual(started.checkpointPaths, []);
    assert.deepEqual((await readdir(project)).sort(), ['.git', '.github', 'PROMPT.md']);
    assert.equal(started.pr, null, 'PR creation being disabled does not prevent starting the loop');
    assert.equal(started.createPr, false, 'auto learns that this repository disallows PR creation');
    assert.equal(dispatches[0].inputs.supervisor_ref, undefined, 'reusable continuation does not pin an engine');
    assert.equal(await main({ command: 'iterate', loop_id: 'demo', generation: '1', iteration: '1' }), 0);
    const { value, revision } = await store.read();
    assert.equal(value.next, 2); assert.equal(value.owner, null);
    assert.equal(value.pr, null, 'PR creation being disabled does not prevent completing an iteration');
    assert.equal(prAttempts, 1, 'later iterations do not retry a denied optional PR');
    const record = JSON.parse(await git(ctl, 'show', `${revision}:state/iterations/1-1.json`));
    assert.equal(record.journalId, '1-1');
    const firstJournal = await git(ctl, 'show', `${revision}:state/pi-jsonl/sessions/1-1/main.jsonl`);
    assert.equal(record.outcome, 'yielded'); assert.equal(record.runtime, engineSHA);
    assert.equal(record.provider, 'openai'); assert.equal(record.model, 'gpt-6-sol');
    const logs = runtimeLogs('fixture/consumer', 'demo');
    assert.equal((await readJson<WorkerResult>(join(logs, '1-1-worker.json'))).outcome, 'yielded');
    assert.equal(JSON.parse(await git(ctl, 'show', `${revision}:state/diagnostics/1-1-worker.json`)).outcome, 'yielded');
    assert.ok(!(await readdir(runtimeState('fixture/consumer', 'demo'))).includes('diagnostics'));
    await git(ctl, 'fetch', 'origin', value.branch);
    assert.equal(await git(ctl, 'show', `${value.checkpoint!.workCommit}:consumer-result.txt`), 'SUPERVISOR_CONSUMER_PROOF');
    assert.deepEqual(JSON.parse(await git(ctl, 'show', `${value.checkpoint!.workCommit}:provider-selection.json`)),
      { provider: 'openai', model: 'gpt-6-sol', checkpointSeconds: 1 });
    assert.equal(dispatches.length, 2);
    assert.equal(dispatches[1].inputs.iteration, '2');
    assert.equal(dispatches[1].inputs.supervisor_ref, undefined);
    prAllowed = true;
    await store.mutate(c => ({ ...c, createPr: true }), 'fixture: enable draft PRs');
    await main({ command: 'iterate', loop_id: 'demo', generation: '1', iteration: '2' });
    const continued = (await store.read()).value;
    const continuedRevision = (await store.read()).revision;
    assert.equal(await git(ctl, 'show', `${continuedRevision}:state/pi-jsonl/sessions/1-1/main.jsonl`), firstJournal);
    assert.ok(await git(ctl, 'show', `${continuedRevision}:state/pi-jsonl/sessions/1-2/main.jsonl`));
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
    await main({ command: 'resume', loop_id: 'demo', model: { provider: 'anthropic', name: 'claude-haiku-4-5', reasoning: 'medium' }, 'checkpoint-seconds': '0' });
    const resumed = (await store.read()).value;
    assert.equal(resumed.generation, 2); assert.equal(resumed.next, 3);
    assert.equal(resumed.provider, 'anthropic'); assert.equal(resumed.model, 'claude-haiku-4-5');
    assert.equal(resumed.checkpointSeconds, 0);
    assert.equal(dispatches[3].inputs.generation, '2'); assert.equal(dispatches[3].inputs.iteration, '3');
    assert.deepEqual(resumed.dispatchedRuns?.slice(-2), [
      { runId: '102', generation: 1, iteration: 3 }, { runId: '103', generation: 2, iteration: 3 }
    ]);
    await main({ command: 'iterate', loop_id: 'demo', generation: '1', iteration: '3' });
    assert.equal(dispatches.length, 4, 'old queued iteration is skipped without claiming or redispatching');
    await main({ command: 'iterate', loop_id: 'demo', generation: '2', iteration: '3' });
    const finished = await store.read();
    assert.equal(finished.value.next, 4);
    const resumedRecord = JSON.parse(await git(ctl, 'show', `${finished.revision}:state/iterations/2-3.json`));
    assert.equal(resumedRecord.iteration, 3); assert.equal(resumedRecord.outcome, 'yielded');
    assert.equal(resumedRecord.provider, 'anthropic'); assert.equal(resumedRecord.model, 'claude-haiku-4-5');
    await git(ctl, 'fetch', 'origin', finished.value.branch);
    assert.deepEqual(JSON.parse(await git(ctl, 'show', `${finished.value.checkpoint!.workCommit}:provider-selection.json`)),
      { provider: 'anthropic', model: 'claude-haiku-4-5', checkpointSeconds: 0 });
    assert.equal(await git(ctl, 'log', '-1', '--format=%s', finished.value.checkpoint!.workCommit), 'Agent verified work');
    await assert.rejects(git(ctl, 'show', `${finished.value.checkpoint!.workCommit}:uncommitted.txt`));
    await main({ command: 'start', loop_id: 'without-pr', model: { provider: 'openai', name: 'gpt-6-sol', reasoning: 'high' }, create_pr: false, source_ref: 'older-task-source' });
    assert.equal(prAttempts, 2, 'explicit false never attempts PR creation even when GitHub allows it');
    const maintainer = join(dir, 'maintainer'); await git(dir, 'clone', remote, maintainer); await configureGit(maintainer);
    await writeFile(join(maintainer, 'maintainer.txt'), 'LATEST_MAIN_CHANGE');
    const maintained = await commit(maintainer, 'advance main after the consumer checkout');
    await git(maintainer, 'push', 'origin', 'main');
    await assert.rejects(main({ command: 'start', loop_id: 'main', model: { provider: 'openai', name: 'gpt-6-sol', reasoning: 'high' }, source_ref: 'older-task-source' }), /source-ref must match/);
    await main({ command: 'start', loop_id: 'main', model: { provider: 'openai', name: 'gpt-6-sol', reasoning: 'high' }, create_pr: true, work_seconds: '20', checkpoint_seconds: '1' });
    const mainStore = new ControlStore(ctl, 'main'), mainStarted = (await mainStore.read()).value;
    assert.equal(mainStarted.branch, 'main'); assert.equal(mainStarted.source, maintained);
    assert.equal(mainStarted.createPr, false); assert.equal(mainStore.branch, 'shurik-control/main');
    assert.equal(await git(dir, '--git-dir', remote, 'rev-parse', 'main'), maintained, 'starting on main makes no artificial task commit');
    await main({ command: 'iterate', loop_id: 'main', generation: '1', iteration: '1' });
    const mainFinished = await mainStore.read(); await git(ctl, 'fetch', 'origin', 'main');
    assert.equal(mainFinished.value.next, 2); assert.equal(mainFinished.value.pr, null); assert.equal(mainFinished.value.createPr, false);
    assert.equal(await git(dir, '--git-dir', remote, 'rev-parse', 'main'), mainFinished.value.checkpoint!.workCommit);
    assert.equal(await git(ctl, 'show', `${mainFinished.value.checkpoint!.workCommit}:maintainer.txt`), 'LATEST_MAIN_CHANGE');
    assert.equal(await git(ctl, 'show', `${mainFinished.value.checkpoint!.workCommit}:consumer-result.txt`), 'SUPERVISOR_CONSUMER_PROOF');
    assert.equal(JSON.parse(await git(ctl, 'show', `${mainFinished.revision}:state/iterations/1-1.json`)).outcome, 'yielded');
    assert.equal(await git(ctl, 'ls-tree', '-r', '--name-only', mainFinished.value.checkpoint!.workCommit),
      '.github/workflows/shurik.yml\nPROMPT.md\nconsumer-result.txt\nmaintainer.txt\nprovider-selection.json');
    assert.equal(prAttempts, 2, 'main never attempts a PR even with create-pr true');
    await main({ command: 'stop', loop_id: 'main' });
    await main({ command: 'resume', loop_id: 'main', model: { reasoning: 'medium' }, create_pr: true });
    assert.equal((await mainStore.read()).value.createPr, false, 'main cannot enable PR creation on resume');
    await main({ command: 'stop', loop_id: 'main' });
    await main({ command: 'stop', loop_id: 'demo' });
    await main({ command: 'stop', loop_id: 'without-pr' });
    const beforeWaiting = dispatches.length;
    await main({ command: 'start', loop_id: 'waiting', model: { provider: 'openai', name: 'gpt-6-sol', reasoning: 'high' }, create_pr: false,
      work_seconds: '30', wait_seconds: '10800', checkpoint_seconds: '1' });
    const waitingStore = new ControlStore(ctl, 'waiting');
    await main({ command: 'iterate', loop_id: 'waiting', generation: '1', iteration: '1' });
    let waiting = await waitingStore.read();
    assert.equal(dispatches.length, beforeWaiting + 1, 'positive wait saves progress without redispatching');
    assert.equal(waiting.value.seconds, 30); assert.equal(waiting.value.waitSeconds, 10800);
    assert.equal(waiting.value.next, 2); assert.equal(waiting.value.owner, null); assert.equal(waiting.value.lastDispatchAt, null);
    assert.ok(Date.parse(waiting.value.nextRunAt!) >= Date.now() + 10790000);
    assert.equal(JSON.parse(await git(ctl, 'show', `${waiting.revision}:state/iterations/1-1.json`)).outcome, 'yielded');
    assert.match(await readFile(overrides.GITHUB_STEP_SUMMARY, 'utf8'), /Waiting until/);
    await main({ command: 'recover' });
    await main({ command: 'iterate', loop_id: 'waiting', generation: '1', iteration: '2' });
    assert.equal(dispatches.length, beforeWaiting + 1, 'scheduled and queued invocations respect the future due time');
    assert.equal((await waitingStore.read()).value.next, 2);
    await waitingStore.mutate(c => ({ ...c, nextRunAt: new Date(Date.now() - 1000).toISOString() }));
    await main({ command: 'recover' }); await main({ command: 'recover' });
    assert.equal(dispatches.length, beforeWaiting + 2, 'a due slot is dispatched once across repeated recovery');
    assert.equal((await waitingStore.read()).value.nextRunAt, null);
    await main({ command: 'iterate', loop_id: 'waiting', generation: '1', iteration: '2' });
    assert.equal((await waitingStore.read()).value.next, 3);
    await main({ command: 'resume', loop_id: 'waiting', model: { reasoning: 'high' }, work_seconds: '20', wait_seconds: '0' });
    waiting = await waitingStore.read();
    assert.equal(waiting.value.generation, 2); assert.equal(waiting.value.next, 3); assert.equal(waiting.value.nextRunAt, null);
    assert.equal(waiting.value.seconds, 20); assert.equal(waiting.value.waitSeconds, 0);
    assert.equal(dispatches.length, beforeWaiting + 3, 'manual resume runs now and can restore continuous mode');
    await main({ command: 'iterate', loop_id: 'waiting', generation: '1', iteration: '3' });
    assert.equal(dispatches.length, beforeWaiting + 3, 'pre-resume queued run is fenced out');
    await main({ command: 'iterate', loop_id: 'waiting', generation: '2', iteration: '3' });
    assert.equal(dispatches.length, beforeWaiting + 4, 'zero wait dispatches immediately');
    await main({ command: 'stop', loop_id: 'waiting' });
    await main({ command: 'start', loop_id: 'inference', model: { provider: 'openai', name: 'gpt-6-sol', reasoning: 'high' },
      work_seconds: '20', checkpoint_seconds: '0', create_pr: false });
    const failedStore = new ControlStore(ctl, 'inference'), beforeFailure = dispatches.length;
    const preload = join(dir, 'no-dispatch.mjs'), attempts = join(dir, 'unexpected-request.txt');
    await writeFile(preload, `import { appendFile } from 'node:fs/promises';\nglobalThis.fetch = async url => {
      await appendFile(${JSON.stringify(attempts)}, String(url)); throw new Error('Failed iteration must not dispatch');
    };\n`);
    await assert.rejects(exec(process.execPath, ['--import', preload, cli, 'iterate', '--loop-id', 'inference', '--generation', '1', '--iteration', '1'], {
      env: { ...process.env, GITHUB_RUN_ID: '900' }
    }), (error: NodeJS.ErrnoException & { code?: unknown; stdout?: string; stderr?: string }) => {
      assert.equal(error.code, 2); assert.match(error.stderr!, /agent_failure|INJECTED_INFERENCE_FAILURE/);
      assert.match(error.stdout!, /Awaiting recovery/); return true;
    });
    await assert.rejects(readFile(attempts), { code: 'ENOENT' });
    await assert.rejects(readFile(join(runtimeEmergency('fixture/consumer', 'inference'), '..',
      `900-${process.env.GITHUB_RUN_ATTEMPT ?? '1'}`, 'state/history-index.json')), { code: 'ENOENT' });
    const failed = await failedStore.read();
    assert.equal(failed.value.next, 2); assert.equal(failed.value.owner, null);
    assert.equal(failed.value.lastDispatchAt, null); assert.equal(dispatches.length, beforeFailure);
    const failedRecord = JSON.parse(await git(ctl, 'show', `${failed.revision}:state/iterations/1-1.json`));
    assert.equal(failedRecord.outcome, 'agent_failure'); assert.match(failedRecord.error, /INJECTED_INFERENCE_FAILURE/);
    assert.ok(await git(ctl, 'show', `${failed.revision}:state/pi-jsonl/sessions/1-1/main.jsonl`));
    const failedRuntime = JSON.parse(await git(ctl, 'show', `${failed.revision}:state/runtime.json`));
    assert.equal(failedRuntime.selected, engineSHA); assert.deepEqual(failedRuntime.quarantined, []);
    const wake = runFixture({ id: 900, run_attempt: 1, status: 'completed', conclusion: 'failure', display_title: 'Shurik inference / 1',
      html_url: 'https://github.com/fixture/consumer/actions/runs/900', head_sha: engineSHA,
      run_started_at: failedRecord.startedAt, updated_at: failedRecord.finishedAt });
    let recoveryDispatches = 0;
    const recoverFailed = () => reconcileLoop(failedStore, { wake, request: async <T>(path: string): Promise<T> => {
      if (path === 'actions/runs/900') return wake as T;
      if (path.includes('/jobs?')) return { total_count: 0, jobs: [] } as T;
      throw new Error('Unexpected recovery request: ' + path);
    }, dispatchNext: async c => { recoveryDispatches++; assert.equal(c.next, 2); } });
    await recoverFailed(); await recoverFailed();
    assert.equal(recoveryDispatches, 1); assert.equal((await failedStore.read()).value.next, 2);
    assert.equal(await main({ command: 'iterate', loop_id: 'inference', generation: '1', iteration: '2' }), 0);
    assert.equal(dispatches.length, beforeFailure + 1, 'successful successor schedules the next iteration itself');
    await main({ command: 'stop', loop_id: 'inference' });
    const swarmModel = { provider: 'openai', name: 'gpt-6-sol', reasoning: 'high' as const };
    const beforeSwarm = dispatches.length;
    await assert.rejects(main({ command: 'start', loop_id: 'no-checkpoint-old-source', model: swarmModel,
      source_ref: 'older-task-source', checkpoint_seconds: '0' }), /current default-branch workflows/);
    assert.equal(await git(ctl, 'ls-remote', '--heads', 'origin', 'refs/heads/no-checkpoint-old-source', 'refs/heads/shurik-control/no-checkpoint-old-source'), '');
    await assert.rejects(main({ command: 'start', loop_id: 'invalid-swarm', model: swarmModel,
      swarm: { agents: 2, models: [{}, { reasoning: 'invalid' as 'high' }] } }), /reasoning/);
    assert.equal(await git(ctl, 'ls-remote', '--heads', 'origin', 'refs/heads/invalid-swarm*', 'refs/heads/shurik-control/invalid-swarm*'), '');
    assert.equal(dispatches.length, beforeSwarm);
    await main({ command: 'start', loop_id: 'research', model: swarmModel, swarm: { agents: 2, models: [{}, { reasoning: 'medium' }] },
      create_pr: false, work_seconds: '20', 'checkpoint-seconds': '0' });
    const firstMember = new ControlStore(ctl, 'research-0'), secondMember = new ControlStore(ctl, 'research-1');
    assert.equal(dispatches.length, beforeSwarm + 2);
    for (const [index, member] of [firstMember, secondMember].entries()) {
      const saved = await member.read();
      assert.deepEqual(saved.value.swarm, { id: 'research', index, agents: 2 });
      assert.equal(saved.value.reasoning, index ? 'medium' : 'high');
      assert.equal(saved.value.checkpointSeconds, 0);
      assert.equal(saved.value.checkpoint!.workCommit, saved.value.source, 'disabled initialization creates no task commit');
      assert.deepEqual(JSON.parse(await git(ctl, 'show', `${saved.revision}:state/loop.json`)).swarm, saved.value.swarm);
    }
    await main({ command: 'iterate', loop_id: 'research-0', generation: '1', iteration: '1' });
    assert.equal((await firstMember.read()).value.next, 2);
    assert.equal((await secondMember.read()).value.next, 1, 'other members advance independently');
    assert.equal(dispatches.at(-1)!.inputs.loop_id, 'research-0');
    assert.equal(dispatches.at(-1)!.inputs.reasoning, undefined, 'continuations carry identity/fences, not model settings');
    const memberState = await firstMember.read();
    await git(ctl, 'fetch', 'origin', 'research-0');
    const workerEvidence = await git(ctl, 'show', `${memberState.value.checkpoint!.workCommit}:provider-selection.json`);
    assert.equal(JSON.parse(workerEvidence).checkpointSeconds, 0, 'continuation forwards saved zero without replacing it with the default');
    assert.equal(await git(ctl, 'log', '-1', '--format=%s', memberState.value.checkpoint!.workCommit), 'Agent verified work');
    await assert.rejects(git(ctl, 'show', `${memberState.value.checkpoint!.workCommit}:uncommitted.txt`));
    assert.match(workerEvidence, /Loop ID: research-0/); assert.match(workerEvidence, /member index: 0/);
    await main({ command: 'stop', loop_id: 'research-0' });
    await main({ command: 'resume', loop_id: 'research-0', model: { reasoning: 'low' } });
    assert.equal((await firstMember.read()).value.generation, 2);
    assert.equal((await firstMember.read()).value.checkpointSeconds, 0);
    assert.deepEqual((await firstMember.read()).value.swarm, { id: 'research', index: 0, agents: 2 });
    await assert.rejects(main({ command: 'start', loop_id: 'research', model: swarmModel, swarm: { agents: 2 } }), /already exist/);
    failDispatchFor = 'partial-0';
    await assert.rejects(main({ command: 'start', loop_id: 'partial', model: swarmModel, swarm: { agents: 2 }, create_pr: false }), /INJECTED_MEMBER_DISPATCH_FAILURE/);
    assert.equal((await new ControlStore(ctl, 'partial-1').read()).value.status, 'running', 'a failed member does not prevent later launches');
    assert.equal(dispatches.at(-1)!.inputs.loop_id, 'partial-1');
    assert.ok(await readFile(join(runtimeEmergency('fixture/consumer', 'partial-0'), 'state/history-index.json')));
    failDispatchFor = '';
    failDispatch = true;
    await assert.rejects(main({ command: 'start', loop_id: 'failed-dispatch', model: { provider: 'openai', name: 'gpt-6-sol', reasoning: 'high' }, create_pr: false }), /INJECTED_DISPATCH_FAILURE/);
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
