#!/usr/bin/env node
import type { Options } from '../scripts/types.ts';
import type { Request } from '../src/worker.ts';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { mkdtemp, cp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { sessionPaths } from '../scripts/paths.ts';
import { redact, validateId, credentialValues } from '../scripts/policy.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const help = `Usage: shurik <command> [options]

Commands:
  start       Initialize a loop in the consumer repository and dispatch it
  iterate     Execute one fenced Pi Durable iteration and save its checkpoint
  stop        Record a durable stop and cancel the active run
  resume      Start a new generation with explicit reasoning
  recover     Reconcile interrupted runs and missing successors
  worker      Run Pi Durable from a versioned JSON request
  inspect     Inspect a copy of a native Pi Durable journal (no model call)
  paths       Print the canonical runtime and control-branch session paths

Options:
  --loop-id ID --provider ID --model ID --reasoning LEVEL --seconds N --deadline TIMESTAMP
  --source-ref REF --generation N --iteration N --workflow FILE
  --create-pr auto|true|false  Draft PR creation (default: auto)
  --prompt FILE --checkpoint-seconds N --checkpoint-paths JSON_ARRAY
  --repository OWNER/NAME  Session namespace (default: GITHUB_REPOSITORY)
  --workspace DIR   Consumer checkout (default: GITHUB_WORKSPACE or cwd)
  --request FILE    Worker/inspection JSON request
  --bundle FILE     Built worker bundle (default: dist/worker.cjs)

Lifecycle commands require GitHub Actions repository, actor, ref and token context.
The action supplies SHURIK_INPUTS; explicit flags override those inputs.
Pi AI resolves model authentication from its provider environment variables.
`;

export function parseArgs(args: string[], inputs: Options = {}): Options {
  const [command, ...flags] = args;
  if (!command || ['--help', '-h', 'help'].includes(command)) return { help: true };
  const allowed = new Set(['loop-id', 'provider', 'model', 'reasoning', 'seconds', 'deadline', 'source-ref',
    'generation', 'iteration', 'workflow', 'workspace', 'repository', 'request', 'bundle', 'create-pr',
    'prompt', 'checkpoint-seconds', 'checkpoint-paths']);
  const options: Options = { ...inputs, command };
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === '--help') return { help: true };
    const name = flags[i].slice(2);
    if (!flags[i].startsWith('--') || !allowed.has(name) || !flags[i + 1] || flags[i + 1].startsWith('--')) {
      throw new Error(`Unknown option or missing value: ${flags[i]}`);
    }
    options[name.replaceAll('-', '_') as keyof Omit<Options, 'help' | 'verification'>] = flags[++i];
  }
  if (!['start', 'iterate', 'stop', 'resume', 'recover', 'worker', 'inspect', 'paths'].includes(command)) {
    throw new Error(`Unknown command: ${command}`);
  }
  return options;
}

async function worker(options: Options) {
  if (!options.request) throw new Error('--request FILE is required');
  let req: Request = JSON.parse(await readFile(resolve(options.request), 'utf8')), disposable: string | undefined;
  const { saveJson } = await import('../scripts/github.ts');
  try {
    if (options.command === 'inspect') {
      disposable = await mkdtemp(resolve(tmpdir(), 'shurik-inspect-cli-'));
      const journal = resolve(disposable, 'journal');
      await cp(resolve(req.journal), journal, { recursive: true });
      req = { ...req, mode: 'inspect', journal };
    }
    // Execute in this process: the supervisor signals the worker process group.
    // A forwarding wrapper would deliver SIGTERM twice and interrupt journal flush.
    try {
      const { runIteration } = createRequire(import.meta.url)(resolve(options.bundle ?? resolve(root, 'dist/worker.cjs'))) as { runIteration: (request: Request) => Promise<void> };
      await runIteration(req);
    } catch (error) {
      await saveJson(resolve(req.output, 'result.json'), { version: 1, outcome: 'runner_failure', error: String(error) });
      throw error;
    }
  } finally { if (disposable) await rm(disposable, { recursive: true, force: true }); }
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args, JSON.parse(process.env.SHURIK_INPUTS ?? '{}'));
  if (options.help) { console.log(help); return; }
  const workspace = resolve(options.workspace ?? process.env.GITHUB_WORKSPACE ?? '.');
  if (options.command === 'paths') { console.log(JSON.stringify(sessionPaths(workspace, validateId(options.loop_id), options.repository ?? process.env.GITHUB_REPOSITORY), null, 2)); return; }
  if (['worker', 'inspect'].includes(options.command!)) return worker(options);
  process.env.SHURIK_ENGINE_ROOT ??= root;
  process.env.SHURIK_PROJECT_ROOT = workspace;
  const { main: supervise } = await import('../scripts/supervisor.ts');
  await supervise(options);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(redact(String(error), credentialValues()));
    process.exitCode = 1;
  });
}
