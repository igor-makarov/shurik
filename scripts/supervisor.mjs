import { mkdtemp, mkdir, readFile, writeFile, cp, rm, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { api, git, command, configureGit, saveJson, readJson, commit, ControlStore } from './github.mjs';
import { validateId, stopped, claimable, trustedRecovery, nextRuntime, sanitizeTree, redact, digest } from './policy.mjs';
import { retainBundle, verifyBundle, validateCandidate, launchWorker, inspectJournal, IMAGE } from './runtime.mjs';

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
  const attempted = await git(workspace, 'status', '--porcelain', '--', '.github');
  // The container denies writes; this is a second publication guard for every .github path.
  if (attempted) {
    await rm(join(workspace, '.github'), { recursive: true, force: true });
    await git(workspace, 'restore', '--source', initial, '--staged', '--worktree', '--', '.github');
  }
  const redactions = await sanitizeTree(workspace, secrets);
  return { attempted, redactions };
}
async function publish(workspace, controlStore, generation, state, message, initial) {
  const control = (await controlStore.read()).value;
  if (control.generation !== generation) throw new Error('Stale generation: preserving local evidence without publishing over resumed work');
  const guard = await pruneAndGuard(workspace, state, initial);
  if (guard.attempted || guard.redactions) await saveJson(join(state, 'diagnostics/publication.json'), guard);
  const sha = await commit(workspace, message);
  // Fast-forward push is the branch compare-and-swap. Conflicts are never force-pushed.
  await git(workspace, 'push', 'origin', `HEAD:refs/heads/${control.branch}`); return sha;
}
async function createPr(control) {
  const existing = await api(`pulls?state=open&head=${encodeURIComponent(repo.split('/')[0] + ':' + control.branch)}`);
  if (existing[0]) return existing[0].html_url;
  const pr = await api('pulls', 'POST', { title: `Shurik loop: ${control.id}`, head: control.branch,
    base: control.defaultBranch, draft: true,
    body: 'Autonomous Ralph loop work and public session history. Partial and failed iterations are retained. Review source, dependencies, and transcripts before merging. Workflow changes are blocked; merging is manual.' });
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
  const control = { version: 1, id, branch, defaultBranch, supervisor, status: 'running', generation: 1, next: 1,
    owner: null, deadline, seconds, model, createdAt: new Date().toISOString(), lastDispatchAt: null };
  await git(ctl, 'checkout', '-b', store.branch, supervisor);
  await saveJson(join(ctl, 'control.json'), control); await commit(ctl, `shurik: start ${id}`);
  await git(ctl, 'push', 'origin', `HEAD:refs/heads/${store.branch}`);
  const workspace = await clone('workspace'); await git(workspace, 'checkout', '-b', branch, supervisor);
  const state = join(workspace, '.shurik/state', id); await mkdir(join(state, 'pi-jsonl'), { recursive: true });
  const bundle = await retainBundle(join(stable, 'dist/worker.cjs'), state, supervisor);
  await saveJson(join(state, 'runtime.json'), { version: 1, selected: bundle, fallback: bundle, probation: false, quarantined: [], validatedSource: supervisor });
  await saveJson(join(state, 'history-index.json'), []);
  if (verification) {
    // Only this explicit disposable verification mode introduces a deterministic runner defect.
    control.verification = true;
    await writeFile(join(workspace, 'src/verification-defect.ts'), 'throw new Error("SHURIK_VERIFICATION_RUNNER_FAULT");\n');
    await writeFile(join(workspace, 'src/worker.ts'), `import './verification-defect.ts';\n${await readFile(join(workspace, 'src/worker.ts'), 'utf8')}`);
    await writeFile(join(workspace, 'PROMPT.md'), 'Verification task: inspect src/verification-defect.ts and the import in src/worker.ts. Use bash/read/edit/write tools to remove this intentional import-time runner fault. Write verification-proof.txt containing a short explanation. Use list_sessions and search_sessions to inspect prior iteration failures. If prior sessions exist, read one with read_session. Make no other code changes. Then yield.\n');
  }
  await saveJson(join(state, 'loop.json'), control);
  await publish(workspace, store, 1, state, `shurik: initialize ${id}`, supervisor);
  const pr = await createPr(control);
  await store.mutate(c => ({ ...c, pr, verification: control.verification, lastDispatchAt: new Date().toISOString() }));
  console.log(`Draft PR: ${pr}`); await dispatch({ ...control, pr });
}
export async function iterate(options) {
  const id = validateId(options.loop_id); const generation = Number(options.generation); const iteration = Number(options.iteration);
  const ctl = await clone('control'); const store = new ControlStore(ctl, id);
  let control = (await store.read()).value;
  if (control.supervisor !== await git(stable, 'rev-parse', 'HEAD')) throw new Error('Supervisor revision mismatch');
  if (!claimable(control, generation, iteration, runId)) { console.log('Duplicate, stale, or stopped invocation skipped'); return; }
  control = await store.mutate(c => claimable(c, generation, iteration, runId) ? { ...c,
    owner: { runId, generation, iteration, claimedAt: new Date().toISOString() } } : null, `shurik: claim ${id} ${generation}/${iteration}`);
  if (control.owner?.runId !== runId || !claimable(control, generation, iteration, runId)) return;
  const workspace = await clone('workspace'); await git(workspace, 'checkout', control.branch);
  emergencyWorkspace = workspace;
  const initial = await git(workspace, 'rev-parse', 'HEAD'); const state = join(workspace, '.shurik/state', id);
  const sequence = `${generation}-${iteration}`; const recordPath = join(state, 'iterations', `${sequence}.json`);
  let runtime = await readJson(join(state, 'runtime.json')); let sessions = await readJson(join(state, 'history-index.json'));
  for (const name of await readdir(join(state, 'iterations')).catch(() => [])) {
    const old = await readJson(join(state, 'iterations', name));
    if (old.outcome === 'running') {
      old.outcome = 'interrupted'; old.error = 'Actions run ended before final publication; recovered from latest committed checkpoint.';
      await saveJson(join(state, 'iterations', name), old);
      if (!sessions.some(s => s.id === old.id)) sessions.push({ id: old.id, outcome: old.outcome, error: old.error });
    }
  }
  const record = { version: 1, id: sequence, runId, generation, iteration, startedAt: new Date().toISOString(),
    outcome: 'running', source: initial, runtime: runtime.selected };
  await saveJson(recordPath, record); await saveJson(join(state, 'loop.json'), control);
  await publish(workspace, store, generation, state, `shurik: begin iteration ${sequence}`, initial);
  const journal = join(state, 'pi-jsonl'); await mkdir(journal, { recursive: true });
  const before = await mkdtemp(join(tmpdir(), 'shurik-journal-'));
  await cp(journal, before, { recursive: true });
  let report = { outcome: 'runner_failure', result: null, log: '' };
  try {
    let bundle = await verifyBundle(state, runtime.selected);
    // Verification run 1 deliberately boots a structurally broken candidate that passed a simulated probation handoff.
    // The fallback remains the real validated baseline. No fake model is used in the live repair iteration.
    if (control.verification && iteration === 1) {
      const broken = join(state, 'runtimes/broken.cjs'); await writeFile(broken, 'throw new Error("SHURIK_VERIFICATION_RUNNER_FAULT");');
      const sha = await retainBundle(broken, state, initial); await rm(broken);
      runtime = { ...runtime, selected: sha, probation: true }; record.runtime = sha; bundle = await verifyBundle(state, sha);
    }
    const seconds = Math.max(1, Math.min(control.seconds, control.deadline ? Math.floor((Date.parse(control.deadline) - Date.now()) / 1000) : control.seconds));
    const previous = sessions.slice(-3).map(s => ({ id: s.id, outcome: s.outcome, error: s.error }));
    report = await launchWorker({ workspace, state, bundle, stable, key: process.env.OPENCODE_API_KEY,
      req: { version: 1, id: `${id}:${sequence}`, model: control.model, seconds,
        checkpointSeconds: (await readJson(join(stable, '.shurik/config.json'))).checkpointSeconds,
        sessions, prompt: `${await readFile(join(workspace, 'PROMPT.md'), 'utf8')}\n\nIteration: ${sequence}\nRecent session outcomes: ${JSON.stringify(previous)}\nUse history tools for earlier transcripts.` },
      onPoll: async () => { const c = (await store.read()).value; return stopped(c) || c.generation !== generation; },
      onCheckpoint: async () => { await publish(workspace, store, generation, state, `shurik: checkpoint ${sequence}`, initial); }
    });
  } catch (e) { report.log = String(e); }
  finally {
    record.outcome = report.outcome; record.finishedAt = new Date().toISOString();
    record.error = redact(JSON.stringify(report.result?.error ?? report.log).slice(0, 16000), secrets);
    record.usage = report.result?.usage;
    await sanitizeTree(workspace, secrets);
    const fallback = await verifyBundle(state, runtime.fallback);
    if (!await inspectJournal(fallback, journal, stable)) {
      await cp(journal, join(state, 'diagnostics', `${sequence}-malformed-journal`), { recursive: true });
      await rm(journal, { recursive: true, force: true }); await cp(before, journal, { recursive: true });
      record.outcome = 'runner_failure'; record.error += '\nJournal invalid; restored last readable checkpoint. Malformed files retained.';
    }
    runtime = nextRuntime(runtime, record.outcome);
    sessions.push({ id: sequence, outcome: record.outcome, minEntryId: report.result?.minEntryId,
      maxEntryId: report.result?.maxEntryId, error: record.error });
    await saveJson(recordPath, record); await saveJson(join(state, 'history-index.json'), sessions);
    await saveJson(join(state, 'runtime.json'), runtime);
    await publish(workspace, store, generation, state, `shurik: save ${sequence} (${record.outcome})`, initial);
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
      const selected = await retainBundle(candidateBundle, state, await git(workspace, 'rev-parse', 'HEAD'));
      runtime = { ...runtime, selected, fallback: runtime.selected, probation: selected !== runtime.selected,
        validatedFingerprint: fingerprint, rejectedFingerprint: null };
    } else runtime = { ...runtime, rejectedFingerprint: fingerprint };
    await saveJson(join(state, 'runtime.json'), runtime);
    await publish(workspace, store, generation, state, `shurik: candidate validation ${sequence}`, initial);
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
  for (const line of refs.split('\n').filter(Boolean)) {
    const id = line.split('refs/heads/codex/shurik-control/')[1]; validateId(id); const store = new ControlStore(ctl, id);
    let c = (await store.read()).value;
    if (c.status !== 'running') continue;
    const wake = event?.workflow_run;
    if (wake?.conclusion === 'cancelled' && [c.lastRunId, c.owner?.runId].includes(String(wake.id))) {
      const owner = c.owner;
      c = await store.mutate(value => ({ ...value, status: 'stopped', stoppedAt: new Date().toISOString() }), 'shurik: UI cancellation is a durable stop');
      if (owner && owner.runId !== String(wake.id)) await api(`actions/runs/${owner.runId}/cancel`, 'POST').catch(() => {});
      continue;
    }
    if (c.owner) {
      const run = await api(`actions/runs/${c.owner.runId}`);
      if (run.status !== 'completed') continue;
      c = await store.mutate(value => {
        if (value.owner?.runId !== run.id.toString()) return null;
        if (run.conclusion === 'cancelled') return { ...value, status: 'stopped', owner: null, stoppedAt: new Date().toISOString() };
        return { ...value, owner: null, next: value.next + 1,
          recovery: { runId: String(run.id), conclusion: run.conclusion, at: new Date().toISOString() }, lastDispatchAt: null };
      }, 'shurik: reconcile interrupted run');
    } else if (c.lastRunId) {
      const run = await api(`actions/runs/${c.lastRunId}`);
      if (run.conclusion === 'cancelled') c = await store.mutate(value => ({ ...value, status: 'stopped' }), 'shurik: honor UI cancellation during handoff');
    }
    if (stopped(c)) {
      if (c.status === 'running') await store.mutate(v => ({ ...v, status: 'deadline' }), 'shurik: deadline expired');
      continue;
    }
    // Dispatch gaps are retried after two minutes; duplicate requests are fenced by generation/iteration claims.
    if (c.lastDispatchAt && Date.now() - Date.parse(c.lastDispatchAt) < 120000) continue;
    c = await store.mutate(v => !stopped(v) && !v.owner ? { ...v, lastDispatchAt: new Date().toISOString() } : null);
    if (!c.owner && !stopped(c)) await dispatch(c);
  }
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
