#!/usr/bin/env node
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { mkdtemp, cp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { sessionPaths } from '../scripts/paths.mjs';
import { redact } from '../scripts/policy.mjs';

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
  --loop-id ID --model ID --reasoning LEVEL --seconds N --deadline TIMESTAMP
  --source-ref REF --generation N --iteration N --workflow FILE
  --workspace DIR   Consumer checkout (default: GITHUB_WORKSPACE or cwd)
  --request FILE    Worker/inspection JSON request
  --bundle FILE     Built worker bundle (default: dist/worker.cjs)

Lifecycle commands require GitHub Actions repository, actor, ref and token context.
The action supplies SHURIK_INPUTS; explicit flags override those inputs.
`;

export function parseArgs(args, inputs = {}) {
  const [command, ...flags] = args;
  if (!command || ['--help', '-h', 'help'].includes(command)) return { help: true };
  const allowed = new Set(['loop-id', 'model', 'reasoning', 'seconds', 'deadline', 'source-ref',
    'generation', 'iteration', 'workflow', 'workspace', 'request', 'bundle']);
  const options = { ...inputs, command };
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === '--help') return { help: true };
    const name = flags[i].slice(2);
    if (!flags[i].startsWith('--') || !allowed.has(name) || !flags[i + 1] || flags[i + 1].startsWith('--')) {
      throw new Error(`Unknown option or missing value: ${flags[i]}`);
    }
    options[name.replaceAll('-', '_')] = flags[++i];
  }
  if (!['start', 'iterate', 'stop', 'resume', 'recover', 'worker', 'inspect', 'paths'].includes(command)) {
    throw new Error(`Unknown command: ${command}`);
  }
  return options;
}

async function worker(options) {
  if (!options.request) throw new Error('--request FILE is required');
  let request = resolve(options.request), disposable;
  try {
    if (options.command === 'inspect') {
      const req = JSON.parse(await readFile(request, 'utf8'));
      disposable = await mkdtemp(resolve(tmpdir(), 'shurik-inspect-cli-'));
      const journal = resolve(disposable, 'journal');
      await cp(resolve(req.journal), journal, { recursive: true });
      const { saveJson } = await import('../scripts/github.mjs');
      request = resolve(disposable, 'request.json');
      await saveJson(request, { ...req, mode: 'inspect', journal });
    }
    const child = spawn(process.execPath, [resolve(options.bundle ?? resolve(root, 'dist/worker.cjs')), request], { stdio: 'inherit' });
    const forward = signal => { if (child.exitCode === null) child.kill(signal); };
    const term = () => forward('SIGTERM'), interrupt = () => forward('SIGINT');
    process.on('SIGTERM', term); process.on('SIGINT', interrupt);
    try {
      process.exitCode = await new Promise((accept, reject) => {
        child.once('error', reject); child.once('exit', (code, signal) => accept(code ?? (signal ? 1 : 0)));
      });
    } finally { process.off('SIGTERM', term); process.off('SIGINT', interrupt); }
  } finally { if (disposable) await rm(disposable, { recursive: true, force: true }); }
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args, JSON.parse(process.env.SHURIK_INPUTS ?? '{}'));
  if (options.help) { console.log(help); return; }
  const workspace = resolve(options.workspace ?? process.env.GITHUB_WORKSPACE ?? '.');
  if (options.command === 'paths') { console.log(JSON.stringify(sessionPaths(workspace, options.loop_id), null, 2)); return; }
  if (['worker', 'inspect'].includes(options.command)) return worker(options);
  process.env.SHURIK_ENGINE_ROOT ??= root;
  process.env.SHURIK_PROJECT_ROOT = workspace;
  const { main: supervise } = await import('../scripts/supervisor.mjs');
  await supervise(options);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(redact(String(error), [process.env.OPENCODE_API_KEY, process.env.GITHUB_TOKEN, process.env.GH_TOKEN]));
    process.exitCode = 1;
  });
}
