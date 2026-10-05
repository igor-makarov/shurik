import { mkdtemp, mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { api, git, configureGit, saveJson, readJson, ControlStore } from './github.mjs';
import { validateId, stopped, claimable, trustedRecovery, nextRuntime, sanitizeTree, redact, digest, loopSnapshot } from './policy.mjs';
import { buildRuntime, validateCandidate, launchWorker, repairJournal, inspectJournal } from './runtime.mjs';
import { reconcileLoop, importFailures, recoverInterrupted, upsertSession, iterationPrompt } from './failures.mjs';
import { loadState, publishCheckpoint, initializeCheckpoint } from './state.mjs';

const stable = resolve(process.env.GITHUB_WORKSPACE ?? '.');
const repo = process.env.GITHUB_REPOSITORY;
const remote = repo ? `https://github.com/${repo}.git` : process.env.SHURIK_REMOTE;
const runId = process.env.GITHUB_RUN_ID ?? `local-${Date.now()}`;
const secrets = [process.env.OPENCODE_API_KEY, process.env.GITHUB_TOKEN, process.env.GH_TOKEN];
let emergencyWorkspace;
async function clone(name) {
  const dir = await mkdtemp(join(tmpdir(), `shurik-${name}-`));
  await git(stable, 'clone', '--no-checkout', remote, dir); await configureGit(dir); return dir;
}
async function authorized() {
  const actor = process.env.GITHUB_ACTOR;
  if (!actor) throw new Error('Expected a GitHub maintainer dispatch');
  const p = await api(`collaborators/${encodeURIComponent(actor)}/permission`);
  if (!['admin', 'maintain', 'write'].includes(p.permission)) throw new Error('Loop control requires repository write access');
}
async function dispatch(control) {
  if (stopped(control)) return;
  await api('actions/workflows/ralph.yml/dispatches', 'POST', {
    ref: control.defaultBranch,
    inputs: { command: 'iterate', loop_id: control.id, generation: String(control.generation),
      iteration: String(control.next), supervisor_ref: control.supervisor }
  });
}
async function pruneAndGuard(workspace, state, initial) {
  const attempted = await git(workspace, 'status', '--porcelain', '--', '.github/workflows');
  // Drop local workflow edits so GitHub's workflow restriction does not reject progress/state pushes.
  if (attempted) {
    await rm(join(workspace, '.github/workflows'), { recursive: true, force: true });
    await git(workspace, 'restore', '--source', initial, '--staged', '--worktree', '--', '.github/workflows');
  }
  const redactions = await sanitizeTree(workspace, secrets);
  return { attempted, redactions };
}
async function publish(workspace, controlStore, generation, state, message, initial, record) {
  const guard = await pruneAndGuard(workspace, state, initial);
  if (guard.attempted || guard.redactions) await saveJson(join(state, 'diagnostics/publication.json'), guard);
  return publishCheckpoint({ workspace, state, store: controlStore, generation, owner: record ? runId : null,
    sequence: record?.id ?? 'initialize', message, record });
}
async function createPr(control, workspace) {
  const existing = await api(`pulls?state=open&head=${encodeURIComponent(repo.split('/')[0] + ':' + control.branch)}`);
  if (existing[0]) return existing[0].html_url;
  // An empty task branch has no PR yet. State on the control branch must not manufacture a code diff.
  if (!await git(workspace, 'diff', '--name-only', `origin/${control.defaultBranch}...HEAD`)) return null;
  const pr = await api('pulls', 'POST', { title: `Shurik loop: ${control.id}`, head: control.branch,
    base: control.defaultBranch, draft: true,
    body: `Autonomous Ralph task changes. Session journals and failure diagnostics are retained on the [control branch](https://github.com/${repo}/tree/codex/shurik-control/${control.id}), including partial and failed iterations. Review source, dependencies, and transcripts before merging. Workflow changes are blocked; merging is manual.` });
  return pr.html_url;
}
export async function start(options) {
  await authorized(); const id = validateId(options.loop_id);
  const verification = options.verification === true || options.verification === 'true';
  const metadata = await api(''); const defaultBranch = metadata.default_branch;
  if (process.env.GITHUB_REF !== `refs/heads/${defaultBranch}`) throw new Error('Start must use the default branch');
  const seconds = Number(options.seconds || 1800);
  if (!Number.isInteger(seconds) || seconds < 10 || seconds > 1800) throw new Error('Agent budget must be 10–1800 seconds');
  const deadline = options.deadline || null;
  if (verification && !deadline) throw new Error('Live verification requires a deadline');
  if (deadline && (!Number.isFinite(Date.parse(deadline)) || Date.parse(deadline) <= Date.now())) throw new Error('Deadline must be an absolute future timestamp');
  const model = options.model || (await readJson(join(stable, '.shurik/config.json'))).model;
  const ctl = await clone('control'); const store = new ControlStore(ctl, id);
  const branch = `codex/shurik/${id}`;
  const supervisor = await git(stable, 'rev-parse', 'HEAD');
  const source = options.source_ref ? (await api(`commits/${encodeURIComponent(options.source_ref)}`)).sha : supervisor;
  const control = { version: 1, stateStorage: 'control', id, branch, defaultBranch, supervisor, status: 'running', generation: 1, next: 1,
    owner: null, deadline, seconds, model, source, sourceRef: options.source_ref || null, createdAt: new Date().toISOString(), lastDispatchAt: null };
  await git(ctl, 'checkout', '-b', store.branch, supervisor);
  const workspace = await clone('workspace'); await git(workspace, 'checkout', '-b', branch, source);
  emergencyWorkspace = workspace;
  const state = join(workspace, '.shurik-local/state', id); await mkdir(join(state, 'pi-jsonl'), { recursive: true });
  await saveJson(join(state, 'runtime.json'), { version: 2, selected: supervisor, fallback: supervisor,
    probation: false, quarantined: [], validatedSource: supervisor });
  await saveJson(join(state, 'history-index.json'), []);
  if (verification) {
    // Only this explicit disposable verification mode introduces a deterministic runner defect.
    control.verification = true;
    await writeFile(join(workspace, 'src/verification-defect.ts'), 'throw new Error("SHURIK_VERIFICATION_RUNNER_FAULT");\n');
    await writeFile(join(workspace, 'src/worker.ts'), `import './verification-defect.ts';\n${await readFile(join(workspace, 'src/worker.ts'), 'utf8')}`);
    await writeFile(join(workspace, 'PROMPT.md'), 'Verification task: inspect src/verification-defect.ts and the import in src/worker.ts. Use bash/read/edit/write tools to remove this intentional import-time runner fault. Write verification-proof.txt containing a short explanation. Use list_sessions and search_sessions to inspect prior iteration failures. If prior sessions exist, read one with read_session. Make no other code changes. Then yield.\n');
  }
  await saveJson(join(state, 'loop.json'), loopSnapshot(control));
  await pruneAndGuard(workspace, state, supervisor);
  await initializeCheckpoint({ workspace, state, store, control, message: `shurik: initialize ${id}` });
  const pr = await createPr(control, workspace);
  await store.mutate(c => ({ ...c, pr, verification: control.verification, lastDispatchAt: new Date().toISOString() }));
  console.log(pr ? `Draft PR: ${pr}` : `Work branch: ${branch}; draft PR awaits task changes`);
  await dispatch({ ...control, pr });
}
export async function expireUnstartedIteration(store, generation, iteration, invocationRunId) {
  // Recheck the fence inside CAS: a skipped invocation must never stop a resumed generation or another owner.
  return store.mutate(c => {
    if (c.generation !== generation || c.next !== iteration || c.status !== 'running'
      || !c.deadline || !stopped(c) || (c.owner && c.owner.runId !== invocationRunId)) return null;
    return { ...c, status: 'deadline', owner: null, lastDispatchAt: null };
  }, 'shurik: deadline expired before agent start');
}
export async function iterate(options) {
  const id = validateId(options.loop_id); const generation = Number(options.generation); const iteration = Number(options.iteration);
  const ctl = await clone('control'); const store = new ControlStore(ctl, id);
  let control = (await store.read()).value;
  if (control.supervisor !== await git(stable, 'rev-parse', 'HEAD')) throw new Error('Supervisor revision mismatch');
  if (!claimable(control, generation, iteration, runId)) {
    await expireUnstartedIteration(store, generation, iteration, runId);
    console.log('Duplicate, stale, or stopped invocation skipped'); return;
  }
  control = await store.mutate(c => claimable(c, generation, iteration, runId) ? { ...c,
    owner: { runId, generation, iteration, claimedAt: new Date().toISOString() } } : null, `shurik: claim ${id} ${generation}/${iteration}`);
  if (control.owner?.runId !== runId || !claimable(control, generation, iteration, runId)) {
    await expireUnstartedIteration(store, generation, iteration, runId); return;
  }
  const workspace = await clone('workspace'); await git(workspace, 'checkout', control.branch);
  emergencyWorkspace = workspace;
  const initial = await git(workspace, 'rev-parse', 'HEAD'); const state = await loadState(store, workspace, id);
  const sequence = `${generation}-${iteration}`; const recordPath = join(state, 'iterations', `${sequence}.json`);
  let runtime = await readJson(join(state, 'runtime.json')); let sessions = await readJson(join(state, 'history-index.json'));
  const failures = await importFailures(store, state);
  await recoverInterrupted(state, sessions, failures);
  const record = { version: 1, id: sequence, runId, generation, iteration, startedAt: new Date().toISOString(),
    outcome: 'running', source: initial, runtime: runtime.selected };
  await saveJson(recordPath, record); await saveJson(join(state, 'history-index.json'), sessions);
  await saveJson(join(state, 'loop.json'), loopSnapshot(control));
  await publish(workspace, store, generation, state, `shurik: begin iteration ${sequence}`, initial, record);
  const journal = join(state, 'pi-jsonl'); await mkdir(journal, { recursive: true });
  const before = await mkdtemp(join(tmpdir(), 'shurik-journal-'));
  await cp(journal, before, { recursive: true });
  let publishedBounds;
  let fallback; const builds = new Map();
  let report = { outcome: 'runner_failure', result: null, log: '' };
  try {
    // Build the working fallback before attempting changed runner source. All build output stays local.
    fallback = await buildRuntime(workspace, runtime.fallback, stable, builds);
    let bundle;
    // Verification run 1 deliberately boots a structurally broken candidate that passed a simulated probation handoff.
    // The fallback remains the real validated baseline. No fake model is used in the live repair iteration.
    if (control.verification && iteration === 1) {
      runtime = { ...runtime, selected: initial, probation: true }; record.runtime = initial;
    }
    bundle = await buildRuntime(workspace, runtime.selected, stable, builds);
    const seconds = Math.max(1, Math.min(control.seconds, control.deadline ? Math.floor((Date.parse(control.deadline) - Date.now()) / 1000) : control.seconds));
    report = await launchWorker({ workspace, state, bundle, stable, key: process.env.OPENCODE_API_KEY,
      req: { version: 1, id: `${id}:${sequence}`, model: control.model, seconds,
        checkpointSeconds: (await readJson(join(stable, '.shurik/config.json'))).checkpointSeconds,
        sessions, prompt: iterationPrompt(await readFile(join(workspace, 'PROMPT.md'), 'utf8'), sequence, sessions, failures, id) },
      onPoll: async () => { const c = (await store.read()).value; return stopped(c) || c.generation !== generation; },
      onCheckpoint: async (checkpoint, log) => {
        // Update rollback only after a readable, published checkpoint. A later corruption restores this boundary.
        if (!await inspectJournal(fallback, journal, stable)) throw new Error('Checkpoint journal is not readable by fallback runner');
        if (checkpoint.id !== `${id}:${sequence}` || !Number.isSafeInteger(checkpoint.minEntryId)
          || !Number.isSafeInteger(checkpoint.maxEntryId) || checkpoint.maxEntryId < checkpoint.minEntryId) throw new Error('Invalid checkpoint session boundaries');
        record.minEntryId = checkpoint.minEntryId; record.maxEntryId = checkpoint.maxEntryId; record.checkpointAt = checkpoint.at;
        upsertSession(sessions, record);
        await saveJson(recordPath, record); await saveJson(join(state, 'history-index.json'), sessions);
        await saveJson(join(state, 'diagnostics', `${sequence}-worker.json`), { checkpoint, log: redact(log, secrets) });
        await publish(workspace, store, generation, state, `shurik: checkpoint ${sequence}`, initial, record);
        publishedBounds = { minEntryId: record.minEntryId, maxEntryId: record.maxEntryId, checkpointAt: record.checkpointAt };
        await rm(before, { recursive: true, force: true }); await cp(journal, before, { recursive: true });
      }
    });
  } catch (e) { report.log = String(e); }
  finally {
    record.outcome = report.outcome; record.finishedAt = new Date().toISOString();
    record.error = report.outcome === 'yielded' ? undefined : redact(JSON.stringify(report.result?.error ?? report.log).slice(0, 16000), secrets);
    record.usage = report.result?.usage;
    await saveJson(join(state, 'diagnostics', `${sequence}-worker.json`), {
      outcome: report.outcome, code: report.code, error: report.result?.error, log: redact(report.log, secrets), checkpointAt: record.checkpointAt
    });
    await sanitizeTree(workspace, secrets);
    if (fallback && await repairJournal({ bundle: fallback, journal, backup: before, diagnostics: join(state, 'diagnostics', `${sequence}-malformed-journal`), stable })) {
      record.outcome = 'runner_failure'; record.error += '\nJournal invalid; restored last readable checkpoint. Malformed files retained.';
      Object.assign(record, publishedBounds ?? { minEntryId: undefined, maxEntryId: undefined, checkpointAt: undefined });
    } else {
      record.minEntryId = report.result?.minEntryId ?? record.minEntryId;
      record.maxEntryId = report.result?.maxEntryId ?? record.maxEntryId;
    }
    runtime = nextRuntime(runtime, record.outcome);
    upsertSession(sessions, record);
    await saveJson(recordPath, record); await saveJson(join(state, 'history-index.json'), sessions);
    await saveJson(join(state, 'runtime.json'), runtime);
    await publish(workspace, store, generation, state, `shurik: save ${sequence} (${record.outcome})`, initial, record);
  }
  // Candidate failure never suppresses the next iteration. Quarantine the source until it changes.
  const sourceHash = await git(workspace, 'rev-parse', 'HEAD:src');
  const packageHash = digest((await readFile(join(workspace, 'package-lock.json'))) + (await readFile(join(workspace, 'package.json'))));
  const fingerprint = `${sourceHash}:${packageHash}`;
  if (runtime.validatedFingerprint !== fingerprint && runtime.rejectedFingerprint !== fingerprint) {
    const candidateBundle = join(before, 'candidate.cjs');
    const validation = await validateCandidate(workspace, stable, journal, candidateBundle);
    await saveJson(join(state, 'diagnostics', `${sequence}-validation.json`), validation);
    if (validation.passed) {
      const selected = validation.source;
      runtime = { ...runtime, selected, fallback: runtime.selected, probation: selected !== runtime.selected,
        validatedFingerprint: fingerprint, rejectedFingerprint: null };
    } else runtime = { ...runtime, rejectedFingerprint: fingerprint };
    await saveJson(join(state, 'runtime.json'), runtime);
    await publish(workspace, store, generation, state, `shurik: candidate validation ${sequence}`, initial, record);
  }
  if (!control.pr) {
    const pr = await createPr(control, workspace);
    if (pr) await store.mutate(c => c.generation === generation ? { ...c, pr } : null);
  }
  // The stable control branch is authoritative: edits or cancellation during cleanup cannot resurrect the loop.
  control = await store.mutate(c => {
    if (c.generation !== generation || c.owner?.runId !== runId) return null;
    const stop = stopped(c); return { ...c, status: stop ? (c.status === 'running' ? 'deadline' : c.status) : 'running',
      owner: null, next: iteration + 1, lastRunId: runId, lastDispatchAt: stop ? null : new Date().toISOString() };
  }, `shurik: finalize ${sequence}`);
  await rm(before, { recursive: true, force: true });
  if (!stopped(control) && control.generation === generation && control.next === iteration + 1) await dispatch(control);
  console.log(`Iteration ${sequence}: ${record.outcome}; loop ${control.status}`);
}
export async function controlLoop(options) {
  await authorized(); const id = validateId(options.loop_id); const ctl = await clone('control'); const store = new ControlStore(ctl, id);
  if (options.command === 'stop') {
    const old = (await store.read()).value;
    const stoppedControl = await store.mutate(c => ({ ...c, status: 'stopped', stoppedAt: new Date().toISOString() }), 'shurik: durable manual stop');
    // Stop first. A cancellation race can create a queued successor, but it will refuse the stopped control state.
    if (old.owner && /^\d+$/.test(old.owner.runId)) await api(`actions/runs/${old.owner.runId}/cancel`, 'POST').catch(() => {});
    console.log(`Loop ${id} durably stopped (${stoppedControl.generation})`);
  } else if (options.command === 'resume') {
    const prior = (await store.read()).value;
    if ((await git(ctl, 'show', `${prior.supervisor}:scripts/github.mjs`)).includes('shurik@users.noreply.github.com')) {
      throw new Error('Pinned supervisor uses retired commit attribution. Start a new loop from main or have the maintainer update the pinned bootstrap before resuming.');
    }
    const c = await store.mutate(value => {
      if (value.status === 'running') throw new Error('Loop already running');
      const deadline = options.deadline || null;
      if (deadline && (!Number.isFinite(Date.parse(deadline)) || Date.parse(deadline) <= Date.now())) throw new Error('Resume deadline must be in the future');
      return { ...value, generation: value.generation + 1, status: 'running', owner: null, deadline,
        lastRunId: null, lastDispatchAt: new Date().toISOString() };
    }, 'shurik: explicit resume with new generation');
    await dispatch(c);
  }
}
export async function recover(options) {
  let event;
  if (process.env.GITHUB_EVENT_PATH) event = await readJson(process.env.GITHUB_EVENT_PATH);
  if (process.env.GITHUB_EVENT_NAME === 'workflow_run' && !trustedRecovery(event, repo)) { console.log('Untrusted recovery event ignored'); return; }
  const ctl = await clone('recovery');
  const refs = await git(ctl, 'ls-remote', '--heads', 'origin', 'refs/heads/codex/shurik-control/*');
  const failed = [];
  for (const line of refs.split('\n').filter(Boolean)) {
    const id = line.split('refs/heads/codex/shurik-control/')[1]; validateId(id); const store = new ControlStore(ctl, id);
    try { await reconcileLoop(store, { wake: event?.workflow_run, secrets, dispatchNext: dispatch }); }
    catch (e) { failed.push(id); console.error(redact(`Recovery ${id}: ${String(e)}`, secrets)); }
  }
  if (failed.length) throw new Error(`Recovery needs retry for: ${failed.join(', ')}`);
}
export async function main() {
  if (!remote || !repo) throw new Error('Expected GitHub Actions repository context');
  const options = JSON.parse(process.env.SHURIK_INPUTS ?? '{}');
  if (options.command === 'start') return start(options);
  if (options.command === 'iterate') return iterate(options);
  if (['stop', 'resume'].includes(options.command)) return controlLoop(options);
  if (options.command === 'recover') return recover(options);
  throw new Error('Unknown supervisor command');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => {
  console.error(redact(String(error), secrets)); process.exitCode = 1;
  if (emergencyWorkspace) {
    // Last resort when a CAS/push fails. Recovery does not consume artifacts as trusted input.
    void sanitizeTree(emergencyWorkspace, secrets).then(() => cp(emergencyWorkspace, join(stable, '.shurik-emergency'), {
      recursive: true, filter: path => !['.git', 'node_modules', 'dist'].includes(path.split('/').at(-1))
    })).catch(e => console.error(redact(String(e), secrets)));
  }
});
