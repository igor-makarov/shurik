// Native process fault-injection proof: run `node tests/runner-proof.mjs`. No Docker or real credentials.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, readFile, writeFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { launchWorker, validateCandidate, buildRuntime, inspectJournal, repairJournal } from '../scripts/runtime.mjs';
import { nextRuntime } from '../scripts/policy.mjs';
import { recoverInterrupted, upsertSession, iterationPrompt } from '../scripts/failures.mjs';
import { saveJson, readJson, git, commit, configureGit, ControlStore } from '../scripts/github.mjs';
import { publishCheckpoint, loadState } from '../scripts/state.mjs';
const stable = resolve('.'); await mkdir(join(stable, '.shurik-local'), { recursive: true });
const dir = await mkdtemp(join(stable, '.shurik-local/shurik-runner-proof-'));
const workspace = join(dir, 'repo');
await mkdir(workspace);
for (const name of await readdir(stable)) {
  if (!['.git', '.shurik-local', 'node_modules', 'dist'].includes(name)) await cp(join(stable, name), join(workspace, name), { recursive: true });
}
await git(workspace, 'init'); await configureGit(workspace);
const good = await commit(workspace, 'working baseline');
const remote = join(dir, 'remote'); await git(dir, 'init', '--bare', remote);
await git(workspace, 'remote', 'add', 'origin', remote);
await saveJson(join(workspace, 'control.json'), { id: 'proof', stateStorage: 'control', branch: 'codex/shurik/proof',
  status: 'running', generation: 1, next: 7, owner: { runId: '789', generation: 1, iteration: 7 } });
await commit(workspace, 'initial control'); await git(workspace, 'push', 'origin', 'HEAD:refs/heads/codex/shurik-control/proof');
await git(workspace, 'checkout', '--detach', good);
const controlCheckout = join(dir, 'control'); await git(dir, 'clone', remote, controlCheckout); await configureGit(controlCheckout);
const store = new ControlStore(controlCheckout, 'proof');
const state = join(workspace, '.shurik-local/state/proof'); await mkdir(join(state, 'pi-jsonl'), { recursive: true });
const builds = new Map(); const bundle = await buildRuntime(workspace, good, stable, builds);
assert.equal(await buildRuntime(workspace, good, stable, builds), bundle, 'a source revision is built once per job');
const baseReq = { version: 1, model: 'space-bunny-free', reasoning: 'high', seconds: 10, prompt: 'Test coding tools', sessions: [] };
const previousToken = process.env.GITHUB_TOKEN; process.env.GITHUB_TOKEN = 'TEST_ONLY_REPOSITORY_TOKEN';
const failed = await launchWorker({ workspace, state, bundle, stable, key: 'TEST_ONLY_NO_REAL_SECRET', req: {
  ...baseReq, id: 'failure', script: [
    { tool: 'bash', args: { command: 'test "$GITHUB_TOKEN" = TEST_ONLY_REPOSITORY_TOKEN && test "$OPENCODE_API_KEY" = TEST_ONLY_NO_REAL_SECRET && printf partial > partial.txt && printf local > .github/attempt.yml' } },
    { error: 'Intentional model failure' }
  ]
} });
if (previousToken === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = previousToken;
assert.equal(failed.outcome, 'agent_failure', failed.log);
assert.equal(await readFile(join(workspace, 'partial.txt'), 'utf8'), 'partial');
assert.equal(await readFile(join(workspace, '.github/attempt.yml'), 'utf8'), 'local');
assert.ok(await inspectJournal(bundle, join(state, 'pi-jsonl'), stable));
console.log('PASS: native worker receives job credentials, local files writable, partial edits and durable failure');

const timed = await launchWorker({ workspace, state, bundle, stable, req: {
  ...baseReq, id: 'native-timeout', seconds: 0.3,
  script: [{ tool: 'bash', args: { command: 'printf partial > timeout-partial.txt; sleep 30' } }]
} });
assert.equal(timed.outcome, 'timeout', timed.log);
assert.equal(await readFile(join(workspace, 'timeout-partial.txt'), 'utf8'), 'partial');
const cancelled = await launchWorker({ workspace, state, bundle, stable, req: {
  ...baseReq, id: 'native-cancel', seconds: 30,
  script: [{ tool: 'bash', args: { command: 'printf running > cancelled-partial.txt; sleep 30' } }]
}, onPoll: async () => (await readFile(join(workspace, 'cancelled-partial.txt'), 'utf8').catch(() => '')) === 'running' });
assert.equal(cancelled.outcome, 'timeout', cancelled.log);
assert.equal(await readFile(join(workspace, 'cancelled-partial.txt'), 'utf8'), 'running');
assert.ok(await inspectJournal(bundle, join(state, 'pi-jsonl'), stable));
console.log('PASS: native timeout and control cancellation abort shell work and preserve partial files/history');

await writeFile(join(workspace, 'src/broken.ts'), 'throw new Error("INTENTIONAL_ARCHITECTURE_BREAK");\n');
const original = await readFile(join(workspace, 'src/worker.ts'), 'utf8');
await writeFile(join(workspace, 'src/worker.ts'), `import './broken.ts';\n${original}`);
await commit(workspace, 'broken runner import');
const rejected = await validateCandidate(workspace, stable, join(state, 'pi-jsonl'), join(dir, 'candidate.cjs'));
assert.equal(rejected.passed, false); assert.ok(rejected.log.includes('INTENTIONAL_ARCHITECTURE_BREAK'), rejected.log);
console.log('PASS: broken import rejected by immutable candidate checks');

// This candidate really passes the immutable canary, then fails for a live request it did not encounter there.
const faultLine = "  if (req.id === 'probation') throw new Error('PROBATION_RUNNER_FAULT');\n";
await writeFile(join(workspace, 'src/worker.ts'), original.replace('export async function runIteration(req: Request) {\n', 'export async function runIteration(req: Request) {\n' + faultLine));
const bad = await commit(workspace, 'probation source');
const probationPath = join(dir, 'probation.cjs');
const probationCheck = await validateCandidate(workspace, stable, join(state, 'pi-jsonl'), probationPath);
assert.equal(probationCheck.passed, true, probationCheck.log);
assert.equal(probationCheck.source, bad, 'promotion selects exactly the source commit that passed checks');
const badRun = await launchWorker({ workspace, state, bundle: await buildRuntime(workspace, bad, stable, builds), stable,
  req: { ...baseReq, id: 'probation', script: [{ text: 'should never run' }] } });
assert.equal(badRun.outcome, 'runner_failure');
const runtime = nextRuntime({ selected: bad, fallback: good, probation: true }, badRun.outcome);
assert.equal(runtime.selected, good); assert.ok(runtime.quarantined.includes(bad));
const coldFallback = await buildRuntime(workspace, runtime.selected, stable);
assert.notEqual(coldFallback, bundle, 'fallback can be rebuilt on a fresh runner while current source is broken');
const repair = await launchWorker({ workspace, state, bundle: coldFallback, stable, req: {
  ...baseReq, id: 'repair', sessions: [{ id: 'failure', outcome: 'agent_failure', minEntryId: failed.result.minEntryId, maxEntryId: failed.result.maxEntryId }],
  script: [{ tool: 'search_sessions', args: { query: 'Intentional model failure' } },
    { tool: 'edit', args: { path: 'src/worker.ts', oldText: faultLine, newText: '' } },
    { tool: 'write', args: { path: 'partial.txt', content: 'repaired' } }, { text: 'Repaired using retained runtime' }]
} });
assert.equal(repair.outcome, 'yielded', repair.log); assert.equal(await readFile(join(workspace, 'src/worker.ts'), 'utf8'), original);
assert.equal(await readFile(join(workspace, 'partial.txt'), 'utf8'), 'repaired');
await commit(workspace, 'repaired runner source');
const accepted = await validateCandidate(workspace, stable, join(state, 'pi-jsonl'), join(dir, 'candidate.cjs'));
assert.equal(accepted.passed, true, accepted.log);
console.log('PASS: passing candidate then live fault, probation rollback, actual coding-tool repair and re-adoption');
const checkpoint = join(dir, 'checkpoint');
let checkpoints = 0;
const checkpointRun = await launchWorker({ workspace, state, bundle, stable, req: {
  ...baseReq, id: 'checkpoint', checkpointSeconds: 0.001,
  script: [{ tool: 'write', args: { path: 'checkpoint.txt', content: 'consistent' } }, { text: 'checkpoint saved' }]
}, onCheckpoint: async (_boundary, _log, journalSnapshot) => {
  checkpoints++; await cp(journalSnapshot, checkpoint, { recursive: true });
  assert.ok(await inspectJournal(bundle, checkpoint, stable));
} });
assert.equal(checkpointRun.outcome, 'yielded'); assert.equal(checkpoints, 2);
await writeFile(join(state, 'pi-jsonl/main.jsonl'), 'NOT_VALID_JSON\n');
assert.ok(await repairJournal({ bundle, journal: join(state, 'pi-jsonl'), backup: checkpoint, diagnostics: join(dir, 'malformed'), stable }));
assert.equal(await readFile(join(dir, 'malformed/main.jsonl'), 'utf8'), 'NOT_VALID_JSON\n');
const afterCorruption = await launchWorker({ workspace, state, bundle, stable, req: { ...baseReq, id: 'after-corruption', script: [{ text: 'fresh after restored checkpoint' }] } });
assert.equal(afterCorruption.outcome, 'yielded');
console.log('PASS: cooperative Pi snapshot is readable, malformed journal retained, restored fresh iteration');

// Lose the supervising operation immediately after publishing a checkpoint, before final result/index cleanup.
const interrupted = { id: '1-7', runId: '789', generation: 1, outcome: 'running' }; const index = [];
const published = join(dir, 'published-work');
await assert.rejects(launchWorker({ workspace, state, bundle, stable, req: {
  ...baseReq, id: 'proof:1-7', checkpointSeconds: 0.001,
  script: [{ tool: 'write', args: { path: 'surviving-trail.txt', content: 'SURVIVABLE_FAILURE_NEEDLE' } }, { delayMs: 10000, text: 'unpublished' }]
}, onCheckpoint: async (boundary, _log, journalSnapshot) => {
  interrupted.minEntryId = boundary.minEntryId; interrupted.maxEntryId = boundary.maxEntryId; interrupted.checkpointAt = boundary.at;
  upsertSession(index, interrupted);
  await saveJson(join(state, 'iterations/1-7.json'), interrupted); await saveJson(join(state, 'history-index.json'), index);
  await publishCheckpoint({ workspace, state, store, generation: 1, owner: '789', sequence: '1-7',
    message: 'publish source and journal checkpoint', record: interrupted, journalSnapshot });
  if (boundary.phase === 'tools') {
    throw new Error('INTENTIONAL_SUPERVISOR_LOSS_AFTER_PUBLICATION');
  }
} }), /INTENTIONAL_SUPERVISOR_LOSS_AFTER_PUBLICATION/);
await git(dir, 'clone', remote, published); await git(published, 'checkout', 'codex/shurik/proof');
assert.ok(!(await git(published, 'ls-tree', '-r', '--name-only', 'HEAD')).includes('.shurik-local/'), 'task commits contain no framework state');
const coldControl = join(dir, 'cold-control'); await git(dir, 'clone', remote, coldControl); await configureGit(coldControl);
const coldStore = new ControlStore(coldControl, 'proof');
const restoredState = await loadState(coldStore, published, 'proof');
assert.equal((await coldStore.read()).value.checkpoint.workCommit, await git(published, 'rev-parse', 'HEAD'));
const restoredIndex = await readJson(join(restoredState, 'history-index.json'));
const reports = [{ key: '789-1', runId: '789', generation: 1, conclusion: 'failure', jobs: [
  { name: 'iteration', conclusion: 'failure', steps: [{ name: 'Execute iteration', conclusion: 'failure' }], log: { text: 'SUPERVISOR_FAILURE_DIAGNOSIS' } }
] }];
await recoverInterrupted(restoredState, restoredIndex, reports);
const recovered = await launchWorker({ workspace: published, state: restoredState, bundle, stable, req: {
  ...baseReq, id: 'proof:1-8', sessions: restoredIndex, prompt: iterationPrompt('Inspect the failure trail', '1-8', restoredIndex, reports, 'proof'),
  script: [{ tool: 'list_sessions', args: {} }, { tool: 'search_sessions', args: { query: 'SURVIVABLE_FAILURE_NEEDLE' } },
    { tool: 'read_session', args: { id: '1-7', limit: 50 } }, { text: 'Recovered failure evidence' }]
} });
assert.equal(recovered.outcome, 'yielded', recovered.log);
assert.equal(await readFile(join(published, 'surviving-trail.txt'), 'utf8'), 'SURVIVABLE_FAILURE_NEEDLE');
assert.ok(JSON.stringify(recovered.result.captured[0]).includes('SUPERVISOR_FAILURE_DIAGNOSIS'));
assert.ok(JSON.stringify(recovered.result.captured.at(-1)).includes('SURVIVABLE_FAILURE_NEEDLE'));
assert.equal(restoredIndex[0].outcome, 'interrupted'); assert.equal(restoredIndex[0].transcript, 'checkpoint');
console.log('PASS: separate-branch atomic checkpoint survives supervisor loss; fresh runner retrieves history from control without a task PR diff');
await writeFile(join(dir, 'proof.json'), JSON.stringify({ failed: failed.outcome, rejected: !rejected.passed, probationCheckPassed: probationCheck.passed, probation: badRun.outcome,
  repair: repair.outcome, accepted: accepted.passed }, null, 2));
console.log(`Evidence: ${join(dir, 'proof.json')}`);
