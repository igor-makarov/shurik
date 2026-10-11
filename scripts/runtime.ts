import { errorCode, type WorkerCheckpoint, type WorkerReport, type WorkerRequest, type WorkerResult } from './types.ts';
import { tmpdir } from 'node:os';
import { PATHS } from './paths.ts';
import { spawn } from 'node:child_process';
import { cp, mkdir, readFile, writeFile, rm, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { command, git, saveJson, readJson } from './github.ts';
import { classify } from './policy.ts';
export async function buildRuntime(repository: string, source: string, stable: string, cache = new Map<string, string>()): Promise<string> {
  if (!/^[a-f0-9]{40}$/.test(source)) throw new Error('Invalid runtime source commit');
  if (cache.has(source)) return cache.get(source)!;
  const dir = await temporary('shurik-runtime-', stable);
  const checkout = join(dir, 'source');
  await git(repository, 'clone', '--no-checkout', repository, checkout);
  await git(checkout, 'checkout', '--detach', source);
  await cp(join(stable, 'scripts/build.ts'), join(checkout, 'trusted-build.ts'));
  await command('npm', ['ci', '--ignore-scripts', '--prefer-offline'], checkout);
  await command(process.execPath, ['trusted-build.ts'], checkout);
  const bundle = join(checkout, 'dist/worker.cjs');
  cache.set(source, bundle); return bundle;
}
async function temporary(name: string, stable: string) {
  const root = process.env.RUNNER_TEMP ?? tmpdir();
  await mkdir(root, { recursive: true }); return mkdtemp(join(root, name));
}
export async function validateCandidate(workspace: string, stable: string, journal: string, destination: string) {
  const tmp = await temporary('shurik-candidate-', stable);
  const source = await git(workspace, 'rev-parse', 'HEAD');
  const candidate = join(tmp, 'source');
  await git(workspace, 'clone', '--no-checkout', workspace, candidate);
  await git(candidate, 'checkout', '--detach', source);
  // Fixed build + checks come from the trusted supervisor, irrespective of candidate package scripts/tests.
  await cp(join(stable, 'scripts/build.ts'), join(candidate, 'trusted-build.ts'));
  await cp(join(stable, 'tests/worker.test.ts'), join(candidate, 'trusted-worker.test.ts'));
  await cp(join(stable, 'tsconfig.json'), join(candidate, 'trusted-tsconfig.json'));
  await mkdir(join(candidate, 'real-journal')); await cp(journal, join(candidate, 'real-journal'), { recursive: true });
  const env = { ...process.env, SHURIK_BUNDLE: join(candidate, 'dist/worker.cjs'), SHURIK_REAL_JOURNAL: join(candidate, 'real-journal') };
  const end = Date.now() + 240000; let log = '';
  async function check(cmd: string, args: string[]) {
    log += await command(cmd, args, candidate, { env, timeout: Math.max(1, end - Date.now()) }) + '\n';
  }
  try {
    await check('npm', ['ci', '--ignore-scripts']);
    await check(process.execPath, ['node_modules/typescript/bin/tsc', '--project', 'trusted-tsconfig.json']);
    await check(process.execPath, ['trusted-build.ts']);
    await check(process.execPath, ['--test', 'trusted-worker.test.ts']);
    await cp(join(candidate, 'dist/worker.cjs'), destination);
    return { passed: true, source, log: log.slice(-16000) };
  } catch (error) { const failure = error as Error & { stdout?: string; stderr?: string }; return { passed: false, source, log: `${log}${failure.stdout ?? ''}\n${failure.stderr ?? ''}\n${failure.message}`.slice(-16000) }; }
  finally { await rm(tmp, { recursive: true, force: true }); }
}
export async function launchWorker({ workspace, state, bundle, req, onCheckpoint, onPoll, key, stable }: { workspace: string; state: string; bundle: string; req: WorkerRequest; onCheckpoint?: (checkpoint: WorkerCheckpoint, log: string, snapshot: string) => Promise<void>; onPoll?: () => Promise<boolean>; key?: string; stable: string }): Promise<WorkerReport> {
  const io = await temporary('shurik-io-', stable); await mkdir(join(io, 'output'));
  await saveJson(join(io, 'request.json'), { ...req, checkpointHandshake: true, cwd: resolve(workspace),
    journal: resolve(state, PATHS.journal), output: join(io, 'output') });
  // Prototype: run directly on the Actions runner, including its repository-scoped GitHub token.
  // A process group supports timeout/cancellation cleanup; checkpoints are cooperative Pi hooks.
  const child = spawn(process.execPath, [join(stable, 'bin/shurik.ts'), 'worker', '--bundle', resolve(bundle), '--request', join(io, 'request.json')], { cwd: workspace,
    env: { ...process.env, ...(key === undefined ? {} : { OPENCODE_API_KEY: key }) }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', d => { log = (log + d).slice(-16000); });
  let exited = false; const done = new Promise<number | null>((resolve, reject) => {
    child.once('error', error => { exited = true; reject(error); });
    child.once('exit', code => { exited = true; resolve(code); });
  });
  function signal(value: NodeJS.Signals) {
    if (!child.pid) return;
    try { process.kill(-child.pid, value); } catch (e) { if (errorCode(e) !== 'ESRCH') throw e; }
  }
  async function stop() {
    signal('SIGCONT'); signal('SIGTERM');
    let timer: NodeJS.Timeout | undefined;
    try { await Promise.race([done, new Promise<void>(resolve => { timer = setTimeout(resolve, 45000); })]); }
    finally { clearTimeout(timer); signal('SIGKILL'); }
    await done;
  }
  let interrupted = false;
  const interrupt = () => { interrupted = true; signal('SIGCONT'); signal('SIGTERM'); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  const hardEnd = Date.now() + (req.seconds + 75) * 1000; let nonce: string | undefined; let lastPoll = 0;
  try {
    while (!exited) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      if (interrupted) { await stop(); break; }
      if (Date.now() - lastPoll >= 10000) {
        lastPoll = Date.now();
        if (await onPoll?.()) { await stop(); break; }
      }
      const checkpoint = await readJson<WorkerCheckpoint | null>(join(io, 'output/checkpoint.json'), null);
      if (!exited && checkpoint && checkpoint.nonce !== nonce) {
        nonce = checkpoint.nonce;
        const journalSnapshot = join(io, 'output/checkpoint-journal');
        await onCheckpoint?.(checkpoint, log, journalSnapshot);
        // A failed publication must not be acknowledged as a successful save.
        await writeFile(join(io, 'output/checkpoint.ack'), nonce);
      }
      if (!exited && Date.now() >= hardEnd) { await stop(); break; }
    }
    const code = await done;
    const result = await readJson<WorkerResult | null>(join(io, 'output/result.json'), null);
    return { result, outcome: classify(result, code), code, log };
  } finally {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    signal('SIGCONT'); signal('SIGKILL'); await done.catch(() => {});
    await rm(io, { recursive: true, force: true });
  }
}
export async function inspectJournal(bundle: string, journal: string, stable: string) {
  const io = await temporary('shurik-inspect-', stable);
  await saveJson(join(io, 'request.json'), { version: 1, id: 'inspect', model: 'space-bunny-free', seconds: 1,
    cwd: io, journal: join(io, 'journal'), output: io, mode: 'inspect', sessions: [] });
  try {
    // Inspection is read-only at the Pi API; use a disposable copy because opening can reclaim sidecars.
    await cp(journal, join(io, 'journal'), { recursive: true });
    await command(process.execPath, [join(stable, 'bin/shurik.ts'), 'worker', '--bundle', resolve(bundle), '--request', join(io, 'request.json')], stable);
    return (await readJson<WorkerResult>(join(io, 'result.json'))).outcome === 'readable';
  } catch { return false; }
  finally { await rm(io, { recursive: true, force: true }); }
}
export async function repairJournal({ bundle, journal, backup, diagnostics, stable }: {bundle: string; journal: string; backup: string; diagnostics: string; stable: string}) {
  if (await inspectJournal(bundle, journal, stable)) return false;
  await cp(journal, diagnostics, { recursive: true });
  await rm(journal, { recursive: true, force: true });
  await cp(backup, journal, { recursive: true });
  if (!await inspectJournal(bundle, journal, stable)) throw new Error('Retained journal checkpoint is unreadable');
  return true;
}
