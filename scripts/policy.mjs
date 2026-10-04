import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
export const digest = value => createHash('sha256').update(value).digest('hex');
export function validateId(id) {
  if (!/^[a-z0-9][a-z0-9-]{0,48}$/.test(id ?? '')) throw new Error('Loop ID must be 1–49 lowercase letters, numbers, or hyphens');
  return id;
}
export function stopped(control, now = Date.now()) {
  return control.status !== 'running' || (control.deadline && now >= Date.parse(control.deadline));
}
export function claimable(control, generation, iteration, runId) {
  return !stopped(control) && control.generation === generation && control.next === iteration
    && (!control.owner || control.owner.runId === runId);
}
export function trustedRecovery(event, repo) {
  const r = event.workflow_run;
  return !!r && r.name === 'Shurik Ralph' && r.event === 'workflow_dispatch'
    && r.repository?.full_name === repo && r.head_repository?.full_name === repo
    && r.head_branch === event.repository?.default_branch;
}
export function classify(result, exitCode) {
  if (!result || exitCode !== 0 || result.version !== 1) return 'runner_failure';
  return ['yielded', 'agent_failure', 'timeout', 'runner_failure'].includes(result.outcome) ? result.outcome : 'runner_failure';
}
export function nextRuntime(runtime, outcome) {
  if (outcome === 'runner_failure' && runtime.fallback && runtime.selected !== runtime.fallback) {
    return { ...runtime, selected: runtime.fallback, probation: false,
      quarantined: [...new Set([...(runtime.quarantined ?? []), runtime.selected])] };
  }
  return { ...runtime, probation: outcome === 'runner_failure' ? runtime.probation : false };
}
export function redact(text, secrets) {
  let value = text;
  for (const key of secrets.filter(s => s && s.length >= 8)) {
    for (const form of new Set([key, encodeURIComponent(key), Buffer.from(key).toString('base64'), JSON.stringify(key).slice(1, -1)])) {
      value = value.split(form).join('*'.repeat(form.length));
    }
  }
  return value.replace(/\b(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-[A-Za-z0-9_-]{24,})\b/g, match => '*'.repeat(match.length));
}
export async function sanitizeTree(root, secrets) {
  let redactions = 0;
  async function visit(path) {
    for (const name of await readdir(path)) {
      if (['.git', 'node_modules', 'dist'].includes(name)) continue;
      const file = join(path, name); const stat = await lstat(file);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) { await visit(file); continue; }
      const bytes = await readFile(file);
      const text = bytes.toString('utf8'); const clean = redact(text, secrets);
      if (clean !== text) {
        if (!Buffer.from(text).equals(bytes)) throw new Error(`Credential found in binary file: ${file}`);
        await writeFile(file, clean); redactions++;
      }
    }
  }
  await visit(root); return redactions;
}
