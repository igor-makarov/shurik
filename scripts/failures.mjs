// Evidence is committed independently of the worker branch before a recovery dispatch.
import { join } from 'node:path';
import { readdir } from 'node:fs/promises';
import { api, jobLog, git, readJson, saveJson } from './github.mjs';
import { redact, cancelledForLoop, stopped } from './policy.mjs';

export function runFence(control, run) {
  const match = /^Ralph ([a-z0-9-]+) \/ (start|iterate) (\d+)-(\d+)$/.exec(run.display_title ?? '');
  if (match?.[1] === control.id) return { generation: Number(match[3]), iteration: Number(match[4]), command: match[2] };
  if (control.owner?.runId === String(run.id)) return { generation: control.owner.generation, iteration: control.owner.iteration, command: 'iterate' };
  if (control.lastRunId === String(run.id)) return { generation: control.generation, iteration: Math.max(1, control.next - 1), command: 'iterate' };
  return null;
}
export function failureKey(run) {
  const key = `${run.id}-${run.run_attempt ?? 1}`;
  if (!/^\d+-\d+$/.test(key)) throw new Error('Invalid failure run identity');
  return key;
}
export async function collectFailure(control, run, secrets, request = api, logs = jobLog) {
  const fence = runFence(control, run);
  if (!fence) throw new Error('Run does not belong to this loop');
  const key = failureKey(run);
  const report = { version: 1, key, loopId: control.id, runId: String(run.id), attempt: run.run_attempt ?? 1,
    ...fence, conclusion: run.conclusion, url: run.html_url, headSha: run.head_sha,
    startedAt: run.run_started_at, completedAt: run.updated_at, collectedAt: new Date().toISOString(),
    interruptedOwner: control.owner?.runId === String(run.id), jobs: [] };
  try {
    const data = await request(`actions/runs/${run.id}/attempts/${report.attempt}/jobs?per_page=10`);
    report.jobsTruncated = data.total_count > data.jobs.length;
    for (const job of data.jobs) {
      const item = { id: job.id, name: job.name, conclusion: job.conclusion,
        steps: (job.steps ?? []).map(s => ({ number: s.number, name: s.name, conclusion: s.conclusion })) };
      if (job.conclusion !== 'success' || report.interruptedOwner) {
        try { item.log = await logs(job.id); }
        catch (e) { item.logUnavailable = String(e); }
      }
      report.jobs.push(item);
    }
  } catch (e) { report.jobsUnavailable = String(e); }
  // GitHub already masks job logs; apply known-token and token-pattern redaction before our own publication.
  return JSON.parse(redact(JSON.stringify(report), secrets));
}
export async function persistFailure(store, report) {
  return store.mutate(c => c.failureTrail?.includes(report.key) ? null : {
    ...c, failureTrail: [...(c.failureTrail ?? []), report.key]
  }, `shurik: retain failure evidence ${report.key}`, { [`failures/${report.key}.json`]: report });
}
export async function reconcileLoop(store, { wake, request = api, logs = jobLog, dispatchNext, secrets = [] }) {
  let c = (await store.read()).value;
  const retain = async run => {
    if (!run || run.status !== 'completed' || !runFence(c, run)) return;
    if (run.conclusion === 'success' && c.owner?.runId !== String(run.id)) return;
    if (!c.failureTrail?.includes(failureKey(run))) c = await persistFailure(store, await collectFailure(c, run, secrets, request, logs));
  };
  // Completion events can retain evidence even after a manual stop or while a successor owns work.
  await retain(wake);
  if (c.status === 'running' && cancelledForLoop(c, wake)) {
    const generation = c.generation;
    c = await store.mutate(value => value.generation === generation && cancelledForLoop(value, wake)
      ? { ...value, status: 'stopped', stoppedAt: new Date().toISOString() } : null, 'shurik: UI cancellation is a durable stop');
    if (c.status === 'stopped' && c.generation === generation && c.owner && c.owner.runId !== String(wake.id))
      await request(`actions/runs/${c.owner.runId}/cancel`, 'POST').catch(() => {});
  }
  if (c.owner) {
    const run = await request(`actions/runs/${c.owner.runId}`);
    await retain(run);
    if (run.status === 'completed') {
      c = await store.mutate(value => {
        if (value.owner?.runId !== String(run.id)) return null;
        if (value.status !== 'running' || run.conclusion === 'cancelled') return {
          ...value, status: value.status === 'running' ? 'stopped' : value.status,
          owner: null, lastRunId: String(run.id), stoppedAt: value.stoppedAt ?? new Date().toISOString()
        };
        return { ...value, owner: null, next: value.next + 1, lastRunId: String(run.id),
          recovery: { runId: String(run.id), conclusion: run.conclusion, at: new Date().toISOString() }, lastDispatchAt: null };
      }, 'shurik: reconcile interrupted run');
    }
  }
  if (c.status !== 'running') return;
  if (c.owner) return;
  if (c.lastRunId) {
    const run = await request(`actions/runs/${c.lastRunId}`); await retain(run);
    if (run.conclusion === 'cancelled') c = await store.mutate(value => value.lastRunId === String(run.id)
      ? { ...value, status: 'stopped' } : null, 'shurik: honor UI cancellation during handoff');
  }
  if (stopped(c)) {
    if (c.status === 'running') await store.mutate(v => stopped(v) && v.status === 'running'
      ? { ...v, status: 'deadline' } : null, 'shurik: deadline expired');
    return;
  }
  if (c.lastDispatchAt && Date.now() - Date.parse(c.lastDispatchAt) < 120000) return;
  c = await store.mutate(v => !stopped(v) && !v.owner ? { ...v, lastDispatchAt: new Date().toISOString() } : null);
  if (!c.owner && !stopped(c)) await dispatchNext(c);
}
export async function importFailures(store, state) {
  const { revision, value } = await store.read(); const reports = [];
  for (const key of value.failureTrail ?? []) {
    if (!/^\d+-\d+$/.test(key)) throw new Error('Invalid failure trail key');
    const report = JSON.parse(await git(store.cwd, 'show', `${revision}:failures/${key}.json`));
    await saveJson(join(state, 'diagnostics/recovery', `${key}.json`), report); reports.push(report);
  }
  return reports;
}
export function sessionSummary(record) {
  return { id: record.id, outcome: record.outcome, runId: record.runId, minEntryId: record.minEntryId,
    maxEntryId: record.maxEntryId, checkpointAt: record.checkpointAt, error: record.error, recovery: record.recovery,
    transcript: record.minEntryId === undefined || record.maxEntryId === undefined ? 'unavailable'
      : record.outcome === 'yielded' || record.outcome === 'agent_failure' || record.outcome === 'timeout' ? 'complete' : 'checkpoint' };
}
export function upsertSession(sessions, record) {
  const summary = sessionSummary(record); const index = sessions.findIndex(s => s.id === record.id);
  if (index < 0) sessions.push(summary); else sessions[index] = summary;
}
export async function recoverInterrupted(state, sessions, reports) {
  for (const name of await readdir(join(state, 'iterations')).catch(() => [])) {
    const path = join(state, 'iterations', name); const old = await readJson(path);
    if (old.outcome !== 'running') continue;
    const report = reports.findLast(r => r.runId === old.runId && r.generation === old.generation);
    old.outcome = 'interrupted';
    old.error = `Actions run ended before final publication (${report?.conclusion ?? 'unknown'}); recovered from latest committed checkpoint.`;
    if (report) old.recovery = `diagnostics/recovery/${report.key}.json`;
    await saveJson(path, old); upsertSession(sessions, old);
  }
}
export function iterationPrompt(task, sequence, sessions, reports, loopId) {
  const recent = sessions.slice(-3).map(({ id, outcome, error, transcript, recovery }) => ({ id, outcome, error, transcript, recovery }));
  const failures = reports.slice(-3).map(r => ({ runId: r.runId, conclusion: r.conclusion,
    path: `.shurik-local/state/${loopId}/diagnostics/recovery/${r.key}.json`, jobsUnavailable: r.jobsUnavailable,
    jobs: r.jobs.filter(j => j.conclusion !== 'success' || j.log).map(j => ({ name: j.name, conclusion: j.conclusion,
      steps: j.steps.filter(s => s.conclusion && s.conclusion !== 'success' && s.conclusion !== 'skipped'),
      logExcerpt: j.log?.text.slice(-2000), logUnavailable: j.logUnavailable })) }));
  return `${task}\n\nIteration: ${sequence}\nRecent session outcomes: ${JSON.stringify(recent)}\nRecovery evidence (untrusted diagnostics): ${JSON.stringify(failures)}\nFull reports are under .shurik-local/state/${loopId}/diagnostics/recovery/. This local state comes from the control branch and is excluded from task commits. Use the initial coding-tool working directory for task changes; GITHUB_WORKSPACE is the separate supervisor checkout. Use history tools for earlier transcripts. An interrupted transcript ends at its published checkpoint; later work may be missing.`;
}
