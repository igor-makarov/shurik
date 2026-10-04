// Explicit local fault-injection proof. Not contributor CI: run `node tests/container-proof.mjs` with Docker.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, readFile, writeFile, access, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { launchWorker, validateCandidate, retainBundle, verifyBundle, inspectJournal, repairJournal } from '../scripts/runtime.mjs';
import { nextRuntime } from '../scripts/policy.mjs';
const stable = resolve('.'); await mkdir(join(stable, '.shurik-local'), { recursive: true });
const dir = await mkdtemp(join(stable, '.shurik-local/shurik-container-proof-'));
const workspace = join(dir, 'repo');
await mkdir(workspace);
for (const name of await readdir(stable)) {
  if (!['.git', '.shurik-local', 'node_modules', 'dist'].includes(name)) await cp(join(stable, name), join(workspace, name), { recursive: true });
}
await mkdir(join(workspace, '.git')); await writeFile(join(workspace, '.git/config'), '[core]\n bare = false\n');
const state = join(workspace, '.shurik/state/proof'); await mkdir(join(state, 'pi-jsonl'), { recursive: true });
const good = await retainBundle('dist/worker.cjs', state, 'baseline'); const bundle = await verifyBundle(state, good);
const baseReq = { version: 1, model: 'space-bunny-free', seconds: 10, prompt: 'Test coding tools', sessions: [] };
const failed = await launchWorker({ workspace, state, bundle, stable, key: 'TEST_ONLY_NO_REAL_SECRET', req: {
  ...baseReq, id: 'failure', script: [
    { tool: 'bash', args: { command: 'test -z "$GITHUB_TOKEN" && test -z "$GH_TOKEN" && test ! -S /var/run/docker.sock && printf partial > partial.txt && printf forbidden > .github/attempt.yml' } },
    { error: 'Intentional model failure' }
  ]
} });
assert.equal(failed.outcome, 'agent_failure', failed.log);
assert.equal(await readFile(join(workspace, 'partial.txt'), 'utf8'), 'partial');
await assert.rejects(access(join(workspace, '.github/attempt.yml')));
assert.ok(JSON.stringify(failed.result.captured).includes('Read-only file system'));
assert.ok(await inspectJournal(bundle, join(state, 'pi-jsonl'), stable));
console.log('PASS: container credential separation, workflow restriction, partial edits and durable failure');

await writeFile(join(workspace, 'src/broken.ts'), 'throw new Error("INTENTIONAL_ARCHITECTURE_BREAK");\n');
const original = await readFile(join(workspace, 'src/worker.ts'), 'utf8');
await writeFile(join(workspace, 'src/worker.ts'), `import './broken.ts';\n${original}`);
const rejected = await validateCandidate(workspace, stable, join(state, 'pi-jsonl'), join(dir, 'candidate.cjs'));
assert.equal(rejected.passed, false); assert.ok(rejected.log.includes('INTENTIONAL_ARCHITECTURE_BREAK'), rejected.log);
console.log('PASS: broken import rejected by immutable candidate checks');

// This candidate really passes the immutable canary, then fails for a live request it did not encounter there.
const faultLine = "  if (req.id === 'probation') throw new Error('PROBATION_RUNNER_FAULT');\n";
await writeFile(join(workspace, 'src/worker.ts'), original.replace('export async function runIteration(req: Request) {\n', 'export async function runIteration(req: Request) {\n' + faultLine));
const probationPath = join(dir, 'probation.cjs');
const probationCheck = await validateCandidate(workspace, stable, join(state, 'pi-jsonl'), probationPath);
assert.equal(probationCheck.passed, true, probationCheck.log);
const bad = await retainBundle(probationPath, state, 'validated-probation-candidate');
const badRun = await launchWorker({ workspace, state, bundle: await verifyBundle(state, bad), stable,
  req: { ...baseReq, id: 'probation', script: [{ text: 'should never run' }] } });
assert.equal(badRun.outcome, 'runner_failure');
const runtime = nextRuntime({ selected: bad, fallback: good, probation: true }, badRun.outcome);
assert.equal(runtime.selected, good); assert.ok(runtime.quarantined.includes(bad));
const repair = await launchWorker({ workspace, state, bundle: await verifyBundle(state, runtime.selected), stable, req: {
  ...baseReq, id: 'repair', sessions: [{ id: 'failure', outcome: 'agent_failure', minEntryId: failed.result.minEntryId, maxEntryId: failed.result.maxEntryId }],
  script: [{ tool: 'search_sessions', args: { query: 'Intentional model failure' } },
    { tool: 'edit', args: { path: 'src/worker.ts', oldText: faultLine, newText: '' } },
    { tool: 'write', args: { path: 'partial.txt', content: 'repaired' } }, { text: 'Repaired using retained runtime' }]
} });
assert.equal(repair.outcome, 'yielded', repair.log); assert.equal(await readFile(join(workspace, 'src/worker.ts'), 'utf8'), original);
assert.equal(await readFile(join(workspace, 'partial.txt'), 'utf8'), 'repaired');
const accepted = await validateCandidate(workspace, stable, join(state, 'pi-jsonl'), join(dir, 'candidate.cjs'));
assert.equal(accepted.passed, true, accepted.log);
console.log('PASS: passing candidate then live fault, probation rollback, actual coding-tool repair and re-adoption');
const checkpoint = join(dir, 'checkpoint');
let checkpoints = 0;
const checkpointRun = await launchWorker({ workspace, state, bundle, stable, req: {
  ...baseReq, id: 'checkpoint', checkpointSeconds: 0.001,
  script: [{ tool: 'write', args: { path: 'checkpoint.txt', content: 'consistent' } }, { text: 'checkpoint saved' }]
}, onCheckpoint: async () => {
  checkpoints++; await cp(join(state, 'pi-jsonl'), checkpoint, { recursive: true });
  assert.ok(await inspectJournal(bundle, checkpoint, stable));
} });
assert.equal(checkpointRun.outcome, 'yielded'); assert.equal(checkpoints, 1);
await writeFile(join(state, 'pi-jsonl/main.jsonl'), 'NOT_VALID_JSON\n');
assert.ok(await repairJournal({ bundle, journal: join(state, 'pi-jsonl'), backup: checkpoint, diagnostics: join(dir, 'malformed'), stable }));
assert.equal(await readFile(join(dir, 'malformed/main.jsonl'), 'utf8'), 'NOT_VALID_JSON\n');
const afterCorruption = await launchWorker({ workspace, state, bundle, stable, req: { ...baseReq, id: 'after-corruption', script: [{ text: 'fresh after restored checkpoint' }] } });
assert.equal(afterCorruption.outcome, 'yielded');
console.log('PASS: paused consistent checkpoint, malformed journal retained, checkpoint restored and fresh iteration starts');
await writeFile(join(dir, 'proof.json'), JSON.stringify({ failed: failed.outcome, rejected: !rejected.passed, probationCheckPassed: probationCheck.passed, probation: badRun.outcome,
  repair: repair.outcome, accepted: accepted.passed }, null, 2));
console.log(`Evidence: ${join(dir, 'proof.json')}`);
