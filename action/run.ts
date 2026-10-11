import type { Options } from '../scripts/types.ts';
import { mkdtemp, appendFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { git } from '../scripts/github.ts';
import { validateId, redact, credentialValues } from '../scripts/policy.ts';
import { runtimeState, runtimeLogs, runtimeEmergency, controlBranch } from '../scripts/paths.ts';

export function actionOptions(env = process.env) {
  const options: Options = JSON.parse(env.SHURIK_INPUTS ?? '{}');
  for (const name of ['command', 'loop_id', 'provider', 'model', 'reasoning', 'seconds', 'deadline',
    'source_ref', 'generation', 'iteration', 'workflow', 'create_pr', 'prompt', 'checkpoint_seconds', 'checkpoint_paths'] as const) {
    const value = env[`SHURIK_${name.toUpperCase()}`];
    if (value) options[name] = value;
  }
  options.command ||= 'start';
  if (!['start', 'iterate', 'stop', 'resume', 'recover'].includes(options.command)) throw new Error('Invalid action command');
  if (options.command !== 'recover') validateId(options.loop_id);
  return options;
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
  const project = resolve(process.env.GITHUB_WORKSPACE ?? '.');
  const repository = process.env.SHURIK_ACTION_REPOSITORY;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '')) throw new Error('Invalid action repository');
  const ref = process.env.SHURIK_ACTION_REF;
  const engine = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), 'shurik-engine-'));
  const revision = await checkoutEngine(engine, `https://github.com/${repository}.git`, ref);
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `engine-revision=${revision}\n`);
    if (options.loop_id) await appendFile(process.env.GITHUB_OUTPUT,
      `state-path=${runtimeState(process.env.GITHUB_REPOSITORY, options.loop_id)}\nlogs-path=${runtimeLogs(process.env.GITHUB_REPOSITORY, options.loop_id)}\nemergency-path=${runtimeEmergency(process.env.GITHUB_REPOSITORY, options.loop_id)}\ncontrol-branch=${controlBranch(options.loop_id)}\n`);
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
