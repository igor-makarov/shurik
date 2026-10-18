import type { Control, Event, Inputs, Iteration, Job, Options, Run, Runtime, Sessions, WorkerReport } from './types.ts';
import { mkdtemp, mkdir, readFile, writeFile, appendFile, cp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { api, git, configureGit, saveJson, readJson, ControlStore, checkoutTaskBranch } from './github.ts';
import { validateId, stopped, ready, nextRunAt, normalizeOptions, validateWorkSeconds, validateWaitSeconds, claimable, trustedRecovery, nextRuntime, sanitizeTree, redact, digest, loopSnapshot, validateReasoning, validateCreatePr, resumeSettings, validateProvider, credentialValues } from './policy.ts';
import { buildRuntime, validateCandidate, launchWorker, repairJournal, inspectJournal } from './runtime.ts';
import { reconcileLoop, importFailures, recoverInterrupted, upsertSession, iterationPrompt, completedIterationRun } from './failures.ts';
import { loadState, publishCheckpoint, initializeCheckpoint } from './state.ts';
import { PATHS, runtimeState, runtimeLogs, runtimeEmergency, controlBranchPrefixes, controlBranches, loopIdFromControlBranch } from './paths.ts';
import { preserveEmergency } from './emergency.ts';
import { DEFAULTS, projectConfig } from './config.ts';
import { journalDirectory } from './journal-path.ts';
import { loopOptions, planStart, resumeOptions, validateInputs } from './launch.ts';

const stable = resolve(process.env.SHURIK_ENGINE_ROOT ?? process.env.GITHUB_WORKSPACE ?? '.');
const project = resolve(process.env.SHURIK_PROJECT_ROOT ?? process.env.GITHUB_WORKSPACE ?? '.');
const repo = process.env.GITHUB_REPOSITORY;
const remote = repo ? `https://github.com/${repo}.git` : process.env.SHURIK_REMOTE;
const runId = process.env.GITHUB_RUN_ID ?? `local-${Date.now()}`;
const secrets = credentialValues();
let emergencyWorkspace: string | undefined;
let emergencyState: string | undefined;
let emergencyLogs: string | undefined;
let emergencyDestination: string | undefined;
async function clone(name: string) {
  const dir = await mkdtemp(join(tmpdir(), `shurik-${name}-`));
  await git(stable, 'clone', '--no-checkout', remote!, dir); await configureGit(dir); return dir;
}
async function authorized() {
  const actor = process.env.GITHUB_ACTOR;
  if (!actor) throw new Error('Expected a GitHub maintainer dispatch');
  const p = await api<{ permission: string }>(`collaborators/${encodeURIComponent(actor)}/permission`);
  if (!['admin', 'maintain', 'write'].includes(p.permission)) throw new Error('Loop control requires repository write access');
}
async function dispatch(control: Control, store: ControlStore) {
  const latest = (await store.read()).value;
  if (latest.generation !== control.generation || latest.next !== control.next || latest.owner || !ready(latest)) return;
  control = latest;
  const run = await api<{ workflow_run_id: number }>(`actions/workflows/${encodeURIComponent(control.workflow ?? 'shurik.yml')}/dispatches`, 'POST', {
    ref: control.defaultBranch,
    return_run_details: true,
    inputs: { command: 'iterate', loop_id: control.id, generation: String(control.generation),
      iteration: String(control.next), ...(!control.engine ? { supervisor_ref: control.supervisor } : {}) }
  });
  if (!Number.isSafeInteger(run?.workflow_run_id) || run.workflow_run_id < 1) throw new Error('Workflow dispatch did not return a run ID');
  const receipt = { runId: String(run.workflow_run_id), generation: control.generation, iteration: control.next };
  await store.mutate(value => value.dispatchedRuns?.some(entry => entry.runId === receipt.runId) ? null
    : { ...value, dispatchedRuns: [...(value.dispatchedRuns ?? []), receipt] }, 'shurik: record dispatched iteration');
}
async function reportControl(control: Control) {
  const status = stopped(control) ? (control.status === 'running' ? 'deadline' : control.status)
    : control.nextRunAt ? `Waiting until ${control.nextRunAt}` : control.owner ? 'Running' : 'Dispatched';
  const summary = `### Shurik ${control.id}\n\n${status}\n\nIteration: ${control.next}. Work: ${control.seconds} seconds. Wait: ${control.waitSeconds ?? 0} seconds.\n\n`;
  console.log(`Loop ${control.id}: ${status}`);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
}
async function pruneAndGuard(workspace: string, state: string, initial: string, journalSnapshot?: string, logs?: string) {
  const attempted = await git(workspace, 'status', '--porcelain', '--', '.github/workflows');
  // Drop local workflow edits so GitHub's workflow restriction does not reject progress/state pushes.
  if (attempted) {
    await rm(join(workspace, '.github/workflows'), { recursive: true, force: true });
    await git(workspace, 'restore', '--source', initial, '--staged', '--worktree', '--', '.github/workflows');
  }
  const redactions = await sanitizeTree(workspace, secrets)
    + await sanitizeTree(state, secrets)
    + (logs ? await sanitizeTree(logs, secrets) : 0)
    + (journalSnapshot ? await sanitizeTree(journalSnapshot, secrets) : 0);
  return { attempted, redactions };
}
async function publish(workspace: string, controlStore: ControlStore, generation: number, state: string, message: string, initial: string, record?: Iteration, journalSnapshot?: string) {
  const logs = emergencyLogs!;
  const guard = await pruneAndGuard(workspace, state, initial, journalSnapshot, logs);
  if (guard.attempted || guard.redactions) await saveJson(join(logs, 'publication.json'), guard);
  return publishCheckpoint({ workspace, state, logs, store: controlStore, generation, owner: record ? runId : null,
    sequence: record?.id ?? 'initialize', message, record, journalSnapshot });
}
async function createPr(control: Control, workspace: string, controlRef: string): Promise<{ pr: string | null; createPr: boolean | 'auto' }> {
  if (control.branch === control.defaultBranch) return { pr: null, createPr: false };
  if (control.createPr === false) return { pr: control.pr ?? null, createPr: false };
  const existing = await api<{ html_url: string }[]>(`pulls?state=open&head=${encodeURIComponent(repo!.split('/')[0] + ':' + control.branch)}`);
  if (existing[0]) return { pr: existing[0].html_url, createPr: true };
  // An empty task branch has no PR yet. State on the control branch must not manufacture a code diff.
  if (!await git(workspace, 'diff', '--name-only', `origin/${control.defaultBranch}...HEAD`)) return { pr: null, createPr: control.createPr ?? 'auto' };
  try {
    const pr = await api<{ html_url: string }>('pulls', 'POST', { title: `Shurik loop: ${control.id}`, head: control.branch,
      base: control.defaultBranch, draft: true,
      body: `Autonomous Shurik task changes. Session journals and failure diagnostics are retained on the [control branch](https://github.com/${repo}/tree/${controlRef}), including partial and failed iterations. Review source, dependencies, and transcripts before merging. Workflow changes are blocked; merging is manual.` });
    return { pr: pr.html_url, createPr: true };
  } catch (error) {
    if (String(error).includes('GitHub POST pulls: 403') && String(error).includes('GitHub Actions is not permitted to create or approve pull requests')) {
      console.log(`Task changes saved on ${control.branch}. Automatic PR creation is disabled in repository Actions settings.`);
      return { pr: null, createPr: false };
    }
    throw error;
  }
}
function clearEmergency() { emergencyWorkspace = emergencyState = emergencyLogs = emergencyDestination = undefined; }
async function preserveFailure() {
  if (!emergencyWorkspace || !emergencyDestination) return;
  try {
    await preserveEmergency({ workspace: emergencyWorkspace, state: emergencyState, logs: emergencyLogs,
      destination: emergencyDestination, secrets });
    console.error(`Emergency snapshot: ${emergencyDestination}`);
  } catch (error) { console.error(redact(String(error), secrets)); }
}
export async function start(inputs: Inputs) {
  const plan = planStart(inputs);
  // Resolve every member and validate common settings before any remote writes.
  for (const loop of plan) await projectConfig(project, loopOptions(inputs, loop));
  validateCreatePr(inputs.create_pr);
  if (inputs.deadline && (!Number.isFinite(Date.parse(inputs.deadline)) || Date.parse(inputs.deadline) <= Date.now())) throw new Error('Deadline must be an absolute future timestamp');
  if (plan.length > 1) {
    await authorized();
    const preflight = await clone('swarm-preflight');
    try {
      const refs = await git(preflight, 'ls-remote', '--heads', 'origin', ...plan.flatMap(loop => controlBranches(loop.id).map(branch => `refs/heads/${branch}`)));
      if (refs) throw new Error('One or more swarm loops already exist; use resume with individual loop IDs');
    } finally { await rm(preflight, { recursive: true, force: true }); }
  }
  const failures: { id: string; error: string }[] = [];
  for (const loop of plan) {
    clearEmergency();
    try { await startLoop(loopOptions(inputs, loop)); }
    catch (error) {
      await preserveFailure();
      const detail = redact(String(error), secrets); failures.push({ id: loop.id, error: detail });
      console.error(`Loop ${loop.id} failed to start: ${detail}`);
      if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `\nLoop ${loop.id} failed to start. See the control job log and emergency artifact.\n`);
    } finally { clearEmergency(); }
  }
  if (failures.length) throw new Error(`Start failed for ${failures.length}/${plan.length} loops: ${JSON.stringify(failures)}. Other loops may already be running.`);
}
async function startLoop(options: Options) {
  options = normalizeOptions(options);
  const reasoning = validateReasoning(options.reasoning);
  const createPrMode = validateCreatePr(options.create_pr);
  await authorized(); const id = validateId(options.loop_id);
  const verification = options.verification === true || options.verification === 'true';
  const metadata = await api<{ default_branch: string }>(''); const defaultBranch = metadata.default_branch;
  if (process.env.GITHUB_REF !== `refs/heads/${defaultBranch}`) throw new Error('Start must use the default branch');
  if (options.work_seconds !== undefined && options.work_seconds !== '') validateWorkSeconds(options.work_seconds);
  if (options.wait_seconds !== undefined && options.wait_seconds !== '') validateWaitSeconds(options.wait_seconds);
  const deadline = options.deadline || null;
  if (verification && !deadline) throw new Error('Live verification requires a deadline');
  if (deadline && (!Number.isFinite(Date.parse(deadline)) || Date.parse(deadline) <= Date.now())) throw new Error('Deadline must be an absolute future timestamp');
  const requestedSource = options.source_ref ? (await api<{ sha: string }>(`commits/${encodeURIComponent(options.source_ref)}`)).sha : undefined;
  const workspace = await clone('workspace');
  const existingControl = await git(workspace, 'ls-remote', '--heads', 'origin', ...controlBranches(id).map(branch => `refs/heads/${branch}`));
  if (existingControl) throw new Error(`Loop ${id} already exists; use resume`);
  const { branch, source } = await checkoutTaskBranch(workspace, id, await git(project, 'rev-parse', 'HEAD'), requestedSource);
  // The Actions token cannot introduce historical/custom workflow definitions on
  // a new branch. Task source may vary; workflows must match the default branch.
  const workflowRef = `origin/${defaultBranch}`;
  if (await git(workspace, 'diff', '--name-only', source, workflowRef, '--', '.github/workflows')) {
    await rm(join(workspace, '.github/workflows'), { recursive: true, force: true });
    await git(workspace, 'rm', '-r', '--cached', '--ignore-unmatch', '--', '.github/workflows');
    if (await git(workspace, 'ls-tree', workflowRef, '--', '.github/workflows')) {
      await git(workspace, 'restore', '--source', workflowRef, '--staged', '--worktree', '--', '.github/workflows');
    }
  }
  const config = await projectConfig(workspace, options);
  const model = config.model;
  await readFile(join(workspace, config.prompt), 'utf8');
  if (verification && process.env.SHURIK_ENGINE_REPOSITORY) throw new Error('Live self-repair verification is only available to legacy self-hosted loops');
  const ctl = await clone('control'); const store = new ControlStore(ctl, id);
  const supervisor = await git(stable, 'rev-parse', 'HEAD');
  const engine = process.env.SHURIK_ENGINE_REPOSITORY ? { repository: process.env.SHURIK_ENGINE_REPOSITORY,
    ref: process.env.SHURIK_ACTION_REF || null } : null;
  const workflow = options.workflow || 'shurik.yml';
  if (!/^[a-zA-Z0-9_.-]+\.ya?ml$/.test(workflow)) throw new Error('Workflow must be a YAML filename');
  const control: Control = { version: 1, stateStorage: 'control', id, branch, defaultBranch, supervisor, status: 'running', generation: 1, next: 1,
    engine, workflow, layoutVersion: PATHS.version, prompt: config.prompt, swarm: options.swarm_member,
    checkpointSeconds: config.checkpointSeconds, checkpointPaths: config.checkpointPaths,
    owner: null, deadline, seconds: config.iterationSeconds, waitSeconds: config.waitSeconds, nextRunAt: null,
    provider: config.provider, model, reasoning, createPr: branch === defaultBranch ? false : createPrMode, source, sourceRef: options.source_ref || null, createdAt: new Date().toISOString(), lastDispatchAt: null };
  await git(ctl, 'checkout', '-b', store.branch, workflowRef);
  emergencyWorkspace = workspace;
  const state = runtimeState(repo, id); emergencyState = state; await mkdir(join(state, PATHS.journal), { recursive: true });
  emergencyDestination = runtimeEmergency(repo, id);
  const logs = runtimeLogs(repo, id); emergencyLogs = logs;
  await rm(logs, { recursive: true, force: true }); await mkdir(logs, { recursive: true });
  await saveJson(join(state, PATHS.runtime), { version: 2, selected: supervisor, fallback: supervisor,
    probation: false, quarantined: [], validatedSource: supervisor });
  await saveJson(join(state, PATHS.history), []);
  if (verification) {
    // Only this explicit disposable verification mode introduces a deterministic runner defect.
    control.verification = true;
    await writeFile(join(workspace, 'src/verification-defect.ts'), 'throw new Error("SHURIK_VERIFICATION_RUNNER_FAULT");\n');
    await writeFile(join(workspace, 'src/worker.ts'), `import './verification-defect.ts';\n${await readFile(join(workspace, 'src/worker.ts'), 'utf8')}`);
    await writeFile(join(workspace, 'PROMPT.md'), 'Verification task: inspect src/verification-defect.ts and the import in src/worker.ts. Use bash/read/edit/write tools to remove this intentional import-time runner fault. Write verification-proof.txt containing a short explanation. Use list_sessions and search_sessions to inspect prior iteration failures. If prior sessions exist, read one with read_session. Make no other code changes. Then yield.\n');
  }
  await saveJson(join(state, PATHS.loop), loopSnapshot(control));
  await pruneAndGuard(workspace, state, workflowRef, undefined, logs);
  await initializeCheckpoint({ workspace, state, logs, store, control, message: `shurik: initialize ${id}` });
  const decision = await createPr(control, workspace, store.branch); const { pr } = decision;
  await store.mutate(c => ({ ...c, ...decision, verification: control.verification, lastDispatchAt: new Date().toISOString() }));
  console.log(pr ? `Draft PR: ${pr}` : `Work branch: ${branch}`);
  await dispatch({ ...control, pr }, store);
  await reportControl((await store.read()).value);
}
export async function expireUnstartedIteration(store: Pick<ControlStore, 'mutate'>, generation: number, iteration: number, invocationRunId: string) {
  // Recheck the fence inside CAS: a skipped invocation must never stop a resumed generation or another owner.
  return store.mutate(c => {
    if (c.generation !== generation || c.next !== iteration || c.status !== 'running'
      || !c.deadline || !stopped(c) || (c.owner && c.owner.runId !== invocationRunId)) return null;
    return { ...c, status: 'deadline', owner: null, lastDispatchAt: null, nextRunAt: null };
  }, 'shurik: deadline expired before agent start');
}
export async function iterate(options: Options) {
  const id = validateId(options.loop_id); const generation = Number(options.generation); const iteration = Number(options.iteration);
  const ctl = await clone('control'); const store = new ControlStore(ctl, id);
  let control = (await store.read()).value;
  const engineSourceRevision = await git(stable, 'rev-parse', 'HEAD');
  if (!control.engine && control.supervisor !== engineSourceRevision) throw new Error('Supervisor revision mismatch');
  if (!claimable(control, generation, iteration, runId)) {
    await expireUnstartedIteration(store, generation, iteration, runId);
    console.log('Duplicate, stale, waiting, or stopped invocation skipped'); await reportControl((await store.read()).value); return;
  }
  control = await store.mutate(c => claimable(c, generation, iteration, runId) ? { ...c,
    nextRunAt: null, owner: { runId, generation, iteration, claimedAt: new Date().toISOString() } } : null, `shurik: claim ${id} ${generation}/${iteration}`);
  if (control.owner?.runId !== runId || !claimable(control, generation, iteration, runId)) {
    await expireUnstartedIteration(store, generation, iteration, runId); return;
  }
  const workspace = await clone('workspace'); await git(workspace, 'checkout', control.branch);
  emergencyWorkspace = workspace;
  const initial = await git(workspace, 'rev-parse', 'HEAD'); const state = await loadState(store, workspace, id); emergencyState = state;
  emergencyDestination = runtimeEmergency(repo, id);
  const logs = runtimeLogs(repo, id); emergencyLogs = logs;
  const sequence = `${generation}-${iteration}`; const recordPath = join(state, PATHS.iterations, `${sequence}.json`);
  let runtime = await readJson<Runtime>(join(state, PATHS.runtime)); let sessions = await readJson<Sessions>(join(state, PATHS.history));
  if (control.engine) runtime = { ...runtime, selected: engineSourceRevision, fallback: engineSourceRevision, probation: false };
  const failures = await importFailures(store, state, logs);
  await recoverInterrupted(state, sessions, failures);
  const record: Iteration = { version: 1, id: sequence, runId, generation, iteration, startedAt: new Date().toISOString(),
    outcome: 'running', journalId: sequence, source: initial, runtime: runtime.selected, provider: validateProvider(control.provider), model: control.model, reasoning: control.reasoning };
  await saveJson(recordPath, record); await saveJson(join(state, PATHS.history), sessions);
  await saveJson(join(state, PATHS.loop), loopSnapshot(control));
  await publish(workspace, store, generation, state, `shurik: begin iteration ${sequence}`, initial, record);
  const journal = journalDirectory(join(state, PATHS.journal), record.journalId); await mkdir(journal, { recursive: true });
  const before = await mkdtemp(join(tmpdir(), 'shurik-journal-'));
  await cp(journal, before, { recursive: true });
  let publishedBounds: Pick<Iteration, 'minEntryId' | 'maxEntryId' | 'checkpointAt'> | undefined;
  let fallback: string | undefined; const builds = new Map();
  let report: WorkerReport = { outcome: 'runner_failure', result: null, log: '' };
  try {
    // Build the working fallback before attempting changed runner source. All build output stays local.
    const engineSource = control.engine ? stable : workspace;
    fallback = await buildRuntime(engineSource, runtime.fallback, stable, builds);
    let bundle;
    // Verification run 1 deliberately boots a structurally broken candidate that passed a simulated probation handoff.
    // The fallback remains the real validated baseline. No fake model is used in the live repair iteration.
    if (control.verification && iteration === 1) {
      runtime = { ...runtime, selected: initial, probation: true }; record.runtime = initial;
    }
    bundle = await buildRuntime(engineSource, runtime.selected, stable, builds);
    const seconds = Math.max(1, Math.min(control.seconds, control.deadline ? Math.floor((Date.parse(control.deadline) - Date.now()) / 1000) : control.seconds));
    report = await launchWorker({ workspace, state, bundle, stable,
      req: { version: 1, id: `${id}:${sequence}`, journalId: record.journalId, provider: validateProvider(control.provider), model: control.model, reasoning: validateReasoning(control.reasoning), seconds, deadline: control.deadline,
        checkpointSeconds: control.checkpointSeconds ?? DEFAULTS.checkpointSeconds,
        sessions, prompt: iterationPrompt(await readFile(join(workspace, control.prompt ?? PATHS.prompt), 'utf8'), sequence, sessions, failures, state, logs, control) },
      onPoll: async () => { const c = (await store.read()).value; return stopped(c) || c.generation !== generation; },
      onCheckpoint: async (checkpoint, log, journalSnapshot) => {
        // Update rollback only after a readable, published checkpoint. A later corruption restores this boundary.
        if (!await inspectJournal(fallback!,  journalSnapshot, stable)) throw new Error('Checkpoint journal is not readable by fallback runner');
        if (checkpoint.id !== `${id}:${sequence}` || !Number.isSafeInteger(checkpoint.minEntryId)
          || !Number.isSafeInteger(checkpoint.maxEntryId) || checkpoint.maxEntryId < checkpoint.minEntryId) throw new Error('Invalid checkpoint session boundaries');
        record.minEntryId = checkpoint.minEntryId; record.maxEntryId = checkpoint.maxEntryId; record.checkpointAt = checkpoint.at;
        upsertSession(sessions, record);
        await saveJson(recordPath, record); await saveJson(join(state, PATHS.history), sessions);
        await saveJson(join(logs, `${sequence}-worker.json`), { checkpoint, log: redact(log, secrets) });
        await publish(workspace, store, generation, state, `shurik: checkpoint ${sequence}`, initial, record, journalSnapshot);
        publishedBounds = { minEntryId: record.minEntryId, maxEntryId: record.maxEntryId, checkpointAt: record.checkpointAt };
        await rm(before, { recursive: true, force: true }); await cp(journalSnapshot, before, { recursive: true });
      }
    });
  } catch (e) { report.log = String(e); }
  finally {
    record.outcome = report.outcome; record.finishedAt = new Date().toISOString();
    record.error = report.outcome === 'yielded' ? undefined : redact(JSON.stringify(report.result?.error ?? report.log).slice(0, 16000), secrets);
    record.usage = report.result?.usage;
    await saveJson(join(logs, `${sequence}-worker.json`), {
      outcome: report.outcome, code: report.code, error: report.result?.error, log: redact(report.log, secrets), checkpointAt: record.checkpointAt
    });
    await sanitizeTree(workspace, secrets);
    if (fallback && await repairJournal({ bundle: fallback, journal, backup: before, diagnostics: join(logs, `${sequence}-malformed-journal`), stable })) {
      record.outcome = 'runner_failure'; record.error += '\nJournal invalid; restored last readable checkpoint. Malformed files retained.';
      Object.assign(record, publishedBounds ?? { minEntryId: undefined, maxEntryId: undefined, checkpointAt: undefined });
    } else {
      record.minEntryId = report.result?.minEntryId ?? record.minEntryId;
      record.maxEntryId = report.result?.maxEntryId ?? record.maxEntryId;
    }
    runtime = nextRuntime(runtime, record.outcome);
    upsertSession(sessions, record);
    await saveJson(recordPath, record); await saveJson(join(state, PATHS.history), sessions);
    await saveJson(join(state, PATHS.runtime), runtime);
    await publish(workspace, store, generation, state, `shurik: save ${sequence} (${record.outcome})`, initial, record);
  }
  // Candidate failure never suppresses the next iteration. Quarantine the source until it changes.
  // Legacy self-hosted loops may adopt task-side runner changes. Reusable loops
  // execute the current action release; a consumer need not contain src/ or npm.
  if (!control.engine) {
    const sourceHash = await git(workspace, 'rev-parse', 'HEAD:src');
    const packageHash = digest((await readFile(join(workspace, 'package-lock.json'), 'utf8')) + (await readFile(join(workspace, 'package.json'), 'utf8')));
    const fingerprint = `${sourceHash}:${packageHash}`;
    if (runtime.validatedFingerprint !== fingerprint && runtime.rejectedFingerprint !== fingerprint) {
      const candidateBundle = join(before, 'candidate.cjs');
      const validation = await validateCandidate(workspace, stable, journal, candidateBundle);
      await saveJson(join(logs, `${sequence}-validation.json`), validation);
      if (validation.passed) {
        const selected = validation.source;
        runtime = { ...runtime, selected, fallback: runtime.selected, probation: selected !== runtime.selected,
          validatedFingerprint: fingerprint, rejectedFingerprint: null };
      } else runtime = { ...runtime, rejectedFingerprint: fingerprint };
      await saveJson(join(state, PATHS.runtime), runtime);
      await publish(workspace, store, generation, state, `shurik: candidate validation ${sequence}`, initial, record);
    }
  }
  if (!control.pr && control.createPr !== false) {
    const decision = await createPr(control, workspace, store.branch);
    await store.mutate(c => c.generation === generation ? { ...c, ...decision } : null);
  }
  // The stable control branch is authoritative: edits or cancellation during cleanup cannot resurrect the loop.
  control = await store.mutate(c => {
    if (c.generation !== generation || c.owner?.runId !== runId) return null;
    const stop = stopped(c), finishedAt = Date.now(), due = stop ? null : nextRunAt(c, finishedAt);
    return { ...c, status: stop ? (c.status === 'running' ? 'deadline' : c.status) : 'running',
      owner: null, next: iteration + 1, lastRunId: runId, nextRunAt: due,
      lastDispatchAt: stop || due ? null : new Date(finishedAt).toISOString() };
  }, `shurik: finalize ${sequence}`);
  await rm(before, { recursive: true, force: true });
  if (ready(control) && control.generation === generation && control.next === iteration + 1) await dispatch(control, store);
  console.log(`Iteration ${sequence}: ${record.outcome}; loop ${control.status}`);
  await reportControl((await store.read()).value);
}
export async function controlLoop(inputs: Inputs) {
  const { model: _model, swarm: _swarm, ...options } = inputs;
  await authorized(); const id = validateId(options.loop_id); const ctl = await clone('control'); const store = new ControlStore(ctl, id);
  if (options.command === 'stop') {
    const old = (await store.read()).value;
    const stoppedControl = await store.mutate(c => ({ ...c, status: 'stopped', nextRunAt: null, lastDispatchAt: null, stoppedAt: new Date().toISOString() }), 'shurik: durable manual stop');
    // Stop first. A cancellation race can create a queued successor, but it will refuse the stopped control state.
    if (old.owner && /^\d+$/.test(old.owner.runId)) await api(`actions/runs/${old.owner.runId}/cancel`, 'POST').catch(() => {});
    console.log(`Loop ${id} durably stopped (${stoppedControl.generation})`);
    await reportControl(stoppedControl);
  } else if (options.command === 'resume') {
    const prior = (await store.read()).value;
    resumeOptions(inputs, prior);
    if (!prior.engine && (await git(ctl, 'show', `${prior.supervisor}:scripts/github.ts`)).includes('shurik@users.noreply.github.com')) {
      throw new Error('Pinned supervisor uses retired commit attribution. Start a new loop from main or have the maintainer update the pinned bootstrap before resuming.');
    }
    if (prior.stateStorage !== 'control' || (!prior.engine && !(await git(ctl, 'show', `${prior.supervisor}:src/worker.ts`)).includes('thinkingLevel: req.reasoning'))) {
      throw new Error('Pinned loop predates explicit reasoning. Have the maintainer migrate its state and upgrade supervisor/runtime source references before resuming.');
    }
    const c = await store.mutate(value => resumeSettings(value, resumeOptions(inputs, value)), 'shurik: explicit resume with new generation and model/reasoning');
    await dispatch(c, store);
    await reportControl((await store.read()).value);
  }
}
export async function recover(options: Options) {
  let event: Event | undefined;
  if (process.env.GITHUB_EVENT_PATH) event = await readJson<Event>(process.env.GITHUB_EVENT_PATH);
  if (process.env.GITHUB_EVENT_NAME === 'workflow_run' && !trustedRecovery(event ?? {}, repo)) { console.log('Untrusted recovery event ignored'); return; }
  let wake = event?.workflow_run;
  // A separate job runs after the worker, while this workflow is still in progress.
  // Verify both GitHub's run identity and the actual completed job before reconciling it.
  const result = process.env.SHURIK_ITERATION_RESULT;
  if (process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' && result && result !== 'skipped') {
    const run = await api<Run>(`actions/runs/${runId}`);
    const metadata = await api<{ default_branch: string }>('');
    // REST run.name is the dynamic run title. Read the workflow's static name
    // by ID rather than treating that title as the workflow identity.
    const workflow = await api<{ name: string }>(`actions/workflows/${run.workflow_id}`);
    if (!trustedRecovery({ workflow_run: { ...run, name: workflow.name }, repository: metadata }, repo)) throw new Error('Untrusted iteration recovery');
    const { jobs } = await api<{ jobs: (Job & { status: string })[] }>(`actions/runs/${runId}/jobs?per_page=100`);
    wake = completedIterationRun(run, result, jobs);
  }
  const request: typeof api = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> =>
    wake?.id === Number(runId) && path === `actions/runs/${runId}` ? wake as T : api<T>(path, method, body);
  const ctl = await clone('recovery');
  const refs = await git(ctl, 'ls-remote', '--heads', 'origin', ...controlBranchPrefixes.map(prefix => `refs/heads/${prefix}*`));
  const failed = [];
  const ids = new Set(refs.split('\n').filter(Boolean).map(line => loopIdFromControlBranch(line.split('\t')[1].slice('refs/heads/'.length))));
  for (const id of ids) {
    const store = new ControlStore(ctl, id);
    try { await reconcileLoop(store, { wake, request, secrets, dispatchNext: c => dispatch(c, store) }); await reportControl((await store.read()).value); }
    catch (e) { failed.push(id); console.error(redact(`Recovery ${id}: ${String(e)}`, secrets)); }
  }
  if (failed.length) throw new Error(`Recovery needs retry for: ${failed.join(', ')}`);
}
export async function main(inputs: Inputs = JSON.parse(process.env.SHURIK_INPUTS ?? '{}')) {
  if (!remote || !repo) throw new Error('Expected GitHub Actions repository context');
  validateInputs(inputs);
  const { model: _model, swarm: _swarm, ...options } = normalizeOptions(inputs);
  clearEmergency();
  try {
    if (options.command === 'start') return await start(inputs);
    if (options.command === 'iterate') return await iterate(options);
    if (['stop', 'resume'].includes(options.command!)) return await controlLoop(inputs);
    if (options.command === 'recover') return await recover(options);
    throw new Error('Unknown supervisor command');
  } catch (error) {
    await preserveFailure();
    throw error;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => {
  console.error(redact(String(error), secrets)); process.exitCode = 1;
});
