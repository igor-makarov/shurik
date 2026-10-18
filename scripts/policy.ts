import type { ModelThinkingLevel } from '@earendil-works/pi-ai';
import type { Control, Event, Inputs, Options, Outcome, Runtime, Secrets, WorkerResult, Run } from './types.ts';
import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { runFence } from './iterations.ts';
export const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const reasoningLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export function validateReasoning(value: string | undefined): ModelThinkingLevel {
  if (!reasoningLevels.some(level => level === value)) throw new Error('Explicit reasoning level required: ' + reasoningLevels.join(', '));
  return value as ModelThinkingLevel;
}
export function validateCreatePr(value: Options['create_pr']): boolean | 'auto' {
  if (value === undefined || value === '' || value === 'auto') return 'auto';
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new Error('create-pr must be auto, true or false');
}
export function validateProvider(value: string | undefined): string {
  if (value === undefined || value === '') return 'opencode-go';
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(value.trim())) throw new Error('Provider must be a Pi AI provider ID');
  return value.trim();
}
export function credentialValues(env: NodeJS.ProcessEnv = process.env): Secrets {
  return Object.entries(env).filter(([name]) => /(?:^|_)(?:API_KEY|TOKEN|SECRET|PASSWORD|ACCESS_KEY_ID|SECRET_ACCESS_KEY)$/.test(name))
    .map(([, value]) => value);
}
export function normalizeOptions<T extends Options | Inputs>(inputs: T): T {
  const options = { ...inputs, work_seconds: inputs['work-seconds'] ?? inputs.work_seconds ?? inputs.seconds,
    wait_seconds: inputs['wait-seconds'] ?? inputs.wait_seconds,
    checkpoint_seconds: inputs['checkpoint-seconds'] ?? inputs.checkpoint_seconds };
  delete options['work-seconds']; delete options['wait-seconds']; delete options.seconds; delete options['checkpoint-seconds'];
  return options;
}
export function validateCheckpointSeconds(value: unknown): number {
  const seconds = Number(value);
  if (!['number', 'string'].includes(typeof value) || (typeof value === 'string' && !value.trim())
    || !Number.isInteger(seconds) || seconds < 0 || seconds > 1800) {
    throw new Error('checkpoint-seconds must be 0 (agent-managed commits) or 1–1800');
  }
  return seconds;
}
export function validateWorkSeconds(value: unknown): number {
  const seconds = Number(value);
  if (!['number', 'string'].includes(typeof value) || !Number.isInteger(seconds) || seconds < 10 || seconds > 1800) throw new Error('work-seconds must be 10–1800');
  return seconds;
}
export function validateWaitSeconds(value: unknown): number {
  const seconds = Number(value);
  if (!['number', 'string'].includes(typeof value) || (typeof value === 'string' && !value.trim())
    || !Number.isSafeInteger(seconds) || seconds < 0 || !Number.isFinite(new Date(Date.now() + seconds * 1000).getTime())) {
    throw new Error('wait-seconds must be a nonnegative integer within the timestamp range');
  }
  return seconds;
}
export function nextRunAt(control: Control, finishedAt = Date.now()): string | null {
  const wait = validateWaitSeconds(control.waitSeconds ?? 0);
  return wait ? new Date(finishedAt + wait * 1000).toISOString() : null;
}
export function ready(control: Control, now = Date.now()): boolean {
  return !stopped(control, now) && (!control.nextRunAt || now >= Date.parse(control.nextRunAt));
}
export function resumeSettings(value: Control, options: Options): Control {
  if (value.status === 'running' && (!value.nextRunAt || value.owner)) throw new Error('Loop already running');
  options = normalizeOptions(options);
  const reasoning = validateReasoning(options.reasoning);
  const deadline = options.deadline || null;
  if (deadline && (!Number.isFinite(Date.parse(deadline)) || Date.parse(deadline) <= Date.now())) throw new Error('Resume deadline must be in the future');
  // Claimed iterations count even when interrupted. An unclaimed queued run
  // has not consumed a number and its generation still prevents it from claiming.
  const next = Math.max(value.next, (value.owner?.iteration ?? 0) + 1);
  const generation = value.generation + 1;
  const priorProvider = validateProvider(value.provider);
  const provider = options.provider?.trim() ? validateProvider(options.provider) : priorProvider;
  if (provider !== priorProvider && !options.model?.trim()) throw new Error('Explicit model required when changing provider');
  return { ...value, generation, next, status: 'running', owner: null, deadline,
    seconds: options.work_seconds !== undefined && options.work_seconds !== '' ? validateWorkSeconds(options.work_seconds) : value.seconds,
    waitSeconds: options.wait_seconds !== undefined && options.wait_seconds !== '' ? validateWaitSeconds(options.wait_seconds) : (value.waitSeconds ?? 0), nextRunAt: null,
    checkpointSeconds: options.checkpoint_seconds !== undefined && options.checkpoint_seconds !== ''
      ? validateCheckpointSeconds(options.checkpoint_seconds) : value.checkpointSeconds,
    provider, model: options.model?.trim() || value.model, reasoning,
    createPr: value.branch === value.defaultBranch ? false
      : options.create_pr === undefined ? (value.createPr ?? 'auto') : validateCreatePr(options.create_pr),
    lastRunId: null, lastDispatchAt: new Date().toISOString() };
}
export function loopSnapshot(control: Control): Record<string, unknown> {
  // Task-facing metadata only. Scheduling belongs to the supervisor's control record.
  const fields = ['version', 'id', 'branch', 'defaultBranch', 'supervisor', 'status', 'generation',
    'next', 'model', 'reasoning', 'source', 'sourceRef', 'pr', 'verification', 'swarm'] as const;
  return { ...Object.fromEntries(fields.filter(key => Object.hasOwn(control, key)).map(key => [key, control[key]])),
    provider: validateProvider(control.provider) };
}
export function validateId(id: string | undefined): string {
  if (!/^[a-z0-9][a-z0-9-]{0,48}$/.test(id ?? '')) throw new Error('Loop ID must be 1–49 lowercase letters, numbers, or hyphens');
  if (id === 'shurik-control') throw new Error('Loop ID shurik-control is reserved for control branches');
  return id!;
}
export function stopped(control: Control, now = Date.now()): boolean {
  return control.status !== 'running' || !!(control.deadline && now >= Date.parse(control.deadline));
}
export function claimable(control: Control, generation: number, iteration: number, runId: string, now = Date.now()) {
  return ready(control, now) && control.generation === generation && control.next === iteration
    && (!control.owner || control.owner.runId === runId);
}
export function trustedRecovery(event: Event, repo: string | undefined) {
  const r = event.workflow_run;
  return !!r && ['Shurik', 'Shurik Ralph'].includes(r.name) && r.event === 'workflow_dispatch'
    && r.repository?.full_name === repo && r.head_repository?.full_name === repo
    && r.head_branch === event.repository?.default_branch;
}
export function cancelledForLoop(control: Control, run?: Run) {
  if (run?.conclusion !== 'cancelled') return false;
  if ([control.lastRunId, control.owner?.runId].filter(Boolean).includes(String(run.id))) return true;
  // A queued successor has not claimed ownership yet. Its saved GitHub run ID
  // identifies the generation even when a resume reuses the unstarted number.
  const fence = runFence(control, run);
  return !control.owner && !!fence && fence.generation === control.generation && fence.iteration === control.next;
}
export function classify(result: WorkerResult | null, exitCode: number | null): Outcome {
  if (!result || exitCode !== 0 || result.version !== 1) return 'runner_failure';
  return ['yielded', 'agent_failure', 'timeout', 'runner_failure'].includes(result.outcome) ? result.outcome as Outcome : 'runner_failure';
}
export function nextRuntime(runtime: Runtime, outcome: Outcome): Runtime {
  if (outcome === 'runner_failure' && runtime.fallback && runtime.selected !== runtime.fallback) {
    return { ...runtime, selected: runtime.fallback, probation: false,
      quarantined: [...new Set([...(runtime.quarantined ?? []), runtime.selected])] };
  }
  return { ...runtime, probation: outcome === 'runner_failure' ? runtime.probation : false };
}
export function redact(text: string, secrets: Secrets) {
  let value = text;
  const forms = [...new Set(secrets.filter((s): s is string => !!s && s.length >= 8)
    .flatMap(key => [key, encodeURIComponent(key), Buffer.from(key).toString('base64'), JSON.stringify(key).slice(1, -1)]))]
    .sort((a, b) => b.length - a.length);
  // An unescaped key can prefix its JSON encoding (notably a trailing backslash).
  // Mask the complete longer form first so its remaining escape cannot break JSON.
  for (const form of forms) {
    value = value.split(form).join('*'.repeat(form.length));
  }
  return value.replace(/\b(?:ghp_[A-Za-z0-9]{30,}\b|github_pat_[A-Za-z0-9_]{40,}\b|sk-[A-Za-z0-9_-]{24,}(?![A-Za-z0-9_-]))/g, match => '*'.repeat(match.length));
}
export async function sanitizeTree(root: string, secrets: Secrets) {
  let redactions = 0;
  async function visit(path: string) {
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
