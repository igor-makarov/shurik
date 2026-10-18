import type { Inputs } from '../scripts/types.ts';
import { mkdtemp, appendFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { git } from '../scripts/github.ts';
import { validateId, redact, credentialValues, normalizeOptions } from '../scripts/policy.ts';
import { runtimeState, runtimeLogs, runtimeEmergency, controlBranch } from '../scripts/paths.ts';
import { planStart, validateInputs } from '../scripts/launch.ts';

export function actionOptions(env = process.env) {
  const supplied: Inputs = JSON.parse(env.SHURIK_INPUTS ?? '{}');
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) throw new Error('Inputs must be an object');
  const options = normalizeOptions(supplied);
  if (env.SHURIK_SECONDS) options.work_seconds = env.SHURIK_SECONDS;
  for (const name of ['command', 'loop_id', 'model', 'swarm', 'work_seconds', 'wait_seconds', 'deadline',
    'source_ref', 'generation', 'iteration', 'workflow', 'create_pr', 'prompt', 'checkpoint_seconds', 'checkpoint_paths'] as const) {
    const value = env[`SHURIK_${name.toUpperCase()}`];
    if (value) options[name] = value;
  }
  options.command ||= 'start';
  validateInputs(options);
  if (!['start', 'iterate', 'stop', 'resume', 'recover'].includes(options.command)) throw new Error('Invalid action command');
  if (options.command !== 'recover') validateId(options.loop_id);
  return options;
}

export function actionPaths(options: Inputs, repository = process.env.GITHUB_REPOSITORY) {
  const ids = options.command === 'start' ? planStart(options).map(loop => loop.id)
    : options.command === 'recover' ? [] : [validateId(options.loop_id)];
  if (!ids.length) return {};
  return { 'loop-ids': JSON.stringify(ids), 'state-path': ids.map(id => runtimeState(repository, id)).join('\n'),
    'logs-path': ids.map(id => runtimeLogs(repository, id)).join('\n'),
    'emergency-path': ids.map(id => runtimeEmergency(repository, id)).join('\n'),
    'control-branch': ids.map(id => controlBranch(id)).join('\n') };
}

export async function checkoutEngine(directory: string, remote: string, ref: string | undefined) {
  if (!ref || ref.startsWith('-') || /[\s\x00-\x1f]/.test(ref)) throw new Error('Invalid engine reference');
  await git(directory, 'init');
  await git(directory, 'remote', 'add', 'origin', remote);
  await git(directory, 'fetch', '--depth=1', 'origin', ref);
  await git(directory, 'checkout', '--detach', 'FETCH_HEAD');
  return git(directory, 'rev-parse', 'HEAD');
}

async function run() {
  const options = actionOptions();
  const paths = actionPaths(options);
  const project = resolve(process.env.GITHUB_WORKSPACE ?? '.');
  const repository = process.env.SHURIK_ACTION_REPOSITORY;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '')) throw new Error('Invalid action repository');
  const ref = process.env.SHURIK_ACTION_REF;
  const engine = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), 'shurik-engine-'));
  const revision = await checkoutEngine(engine, `https://github.com/${repository}.git`, ref);
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `engine-revision=${revision}\n`);
    for (const [name, value] of Object.entries(paths)) {
      const delimiter = `shurik_${randomUUID()}`;
      await appendFile(process.env.GITHUB_OUTPUT, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
    }
  }
  const child = spawn(process.execPath, [join(engine, 'bin/shurik.ts'), options.command!], {
    cwd: project, stdio: 'inherit', env: { ...process.env, SHURIK_INPUTS: JSON.stringify(options),
      SHURIK_ENGINE_ROOT: engine, SHURIK_ENGINE_REPOSITORY: repository, SHURIK_PROJECT_ROOT: project }
  });
  const term = () => child.kill('SIGTERM'), interrupt = () => child.kill('SIGINT');
  process.on('SIGTERM', term); process.on('SIGINT', interrupt);
  try {
    process.exitCode = await new Promise<number>((accept, reject) => {
      child.once('error', reject); child.once('exit', (code, signal) => accept(code ?? (signal ? 1 : 0)));
    });
  } finally { process.off('SIGTERM', term); process.off('SIGINT', interrupt); }
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(process.env.SHURIK_ACTION_PATH ?? '.', 'action/run.ts')) {
  run().catch(error => {
    console.error(redact(String(error), credentialValues()));
    process.exitCode = 1;
  });
}
