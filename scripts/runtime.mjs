import { spawn } from 'node:child_process';
import { cp, mkdir, readFile, writeFile, rm, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { command, saveJson, readJson } from './github.mjs';
import { digest, classify } from './policy.mjs';
export async function retainBundle(bundle, state, source) {
  const bytes = await readFile(bundle); const sha = digest(bytes);
  const dir = join(state, 'runtimes', sha); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'worker.cjs'), bytes);
  await saveJson(join(dir, 'manifest.json'), { version: 1, sha256: sha, source }); return sha;
}
export async function verifyBundle(state, sha) {
  if (!/^[a-f0-9]{64}$/.test(sha)) throw new Error('Invalid runtime digest');
  const path = join(state, 'runtimes', sha, 'worker.cjs');
  if (digest(await readFile(path)) !== sha) throw new Error('Runtime bundle digest mismatch'); return path;
}
async function temporary(name, stable) {
  const root = process.env.RUNNER_TEMP ?? join(stable, '.shurik-local');
  await mkdir(root, { recursive: true }); return mkdtemp(join(root, name));
}
export async function validateCandidate(workspace, stable, journal, destination) {
  const tmp = await temporary('shurik-candidate-', stable);
  const candidate = join(tmp, 'source'); await mkdir(candidate);
  await cp(workspace, candidate, { recursive: true, filter: path => !['.git', '.github', '.shurik', '.shurik-local', 'node_modules', 'dist'].includes(path.split('/').at(-1)) });
  // Fixed build + checks come from the trusted supervisor, irrespective of candidate package scripts/tests.
  await cp(join(stable, 'scripts/build.mjs'), join(candidate, 'trusted-build.mjs'));
  await cp(join(stable, 'tests/worker.test.mjs'), join(candidate, 'trusted-worker.test.mjs'));
  await cp(join(stable, 'tsconfig.json'), join(candidate, 'trusted-tsconfig.json'));
  await mkdir(join(candidate, 'real-journal')); await cp(journal, join(candidate, 'real-journal'), { recursive: true });
  const env = { ...process.env, SHURIK_BUNDLE: join(candidate, 'dist/worker.cjs'), SHURIK_REAL_JOURNAL: join(candidate, 'real-journal') };
  const end = Date.now() + 240000; let log = '';
  async function check(cmd, args) {
    log += await command(cmd, args, candidate, { env, timeout: Math.max(1, end - Date.now()) }) + '\n';
  }
  try {
    await check('npm', ['ci', '--ignore-scripts']);
    await check(process.execPath, ['node_modules/typescript/bin/tsc', '--project', 'trusted-tsconfig.json']);
    await check(process.execPath, ['trusted-build.mjs']);
    await check(process.execPath, ['--test', 'trusted-worker.test.mjs']);
    await cp(join(candidate, 'dist/worker.cjs'), destination);
    return { passed: true, log: log.slice(-16000) };
  } catch (error) { return { passed: false, log: `${log}${error.stdout ?? ''}\n${error.stderr ?? ''}\n${error.message}`.slice(-16000) }; }
  finally { await rm(tmp, { recursive: true, force: true }); }
}
export async function launchWorker({ workspace, state, bundle, req, onCheckpoint, onPoll, key, stable }) {
  const io = await temporary('shurik-io-', stable); await mkdir(join(io, 'output'));
  await saveJson(join(io, 'request.json'), { ...req, checkpointHandshake: true, cwd: resolve(workspace),
    journal: resolve(state, 'pi-jsonl'), output: join(io, 'output') });
  // Prototype: run directly on the Actions runner, including its repository-scoped GitHub token.
  // A process group supports checkpoint pauses and worker cleanup; Pi aborts active shell tools.
  const child = spawn(process.execPath, [resolve(bundle), join(io, 'request.json')], { cwd: workspace,
    env: { ...process.env, ...(key === undefined ? {} : { OPENCODE_API_KEY: key }) }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', d => { log = (log + d).slice(-16000); });
  let exited = false; const done = new Promise((resolve, reject) => {
    child.once('error', error => { exited = true; reject(error); });
    child.once('exit', code => { exited = true; resolve(code); });
  });
  function signal(value) {
    if (!child.pid) return;
    try { process.kill(-child.pid, value); } catch (e) { if (e.code !== 'ESRCH') throw e; }
  }
  async function stop() {
    signal('SIGCONT'); signal('SIGTERM');
    let timer;
    try { await Promise.race([done, new Promise(resolve => { timer = setTimeout(resolve, 45000); })]); }
    finally { clearTimeout(timer); signal('SIGKILL'); }
    await done;
  }
  let interrupted = false;
  const interrupt = () => { interrupted = true; signal('SIGCONT'); signal('SIGTERM'); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  const hardEnd = Date.now() + (req.seconds + 75) * 1000; let nonce; let lastPoll = 0;
  try {
    while (!exited) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      if (interrupted) { await stop(); break; }
      if (Date.now() - lastPoll >= 10000) {
        lastPoll = Date.now();
        if (await onPoll?.()) { await stop(); break; }
      }
      const checkpoint = await readJson(join(io, 'output/checkpoint.json'), null);
      if (!exited && checkpoint && checkpoint.nonce !== nonce) {
        nonce = checkpoint.nonce;
        signal('SIGSTOP');
        try { await onCheckpoint?.(checkpoint, log); }
        finally { await writeFile(join(io, 'output/checkpoint.ack'), nonce); signal('SIGCONT'); }
      }
      if (!exited && Date.now() >= hardEnd) { await stop(); break; }
    }
    const code = await done;
    const result = await readJson(join(io, 'output/result.json'), null);
    return { result, outcome: classify(result, code), code, log };
  } finally {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    signal('SIGCONT'); signal('SIGKILL'); await done.catch(() => {});
    await rm(io, { recursive: true, force: true });
  }
}
export async function inspectJournal(bundle, journal, stable) {
  const io = await temporary('shurik-inspect-', stable);
  await saveJson(join(io, 'request.json'), { version: 1, id: 'inspect', model: 'space-bunny-free', seconds: 1,
    cwd: io, journal: join(io, 'journal'), output: io, mode: 'inspect', sessions: [] });
  try {
    // Inspection is read-only at the Pi API; use a disposable copy because opening can reclaim sidecars.
    await cp(journal, join(io, 'journal'), { recursive: true });
    await command(process.execPath, [resolve(bundle), join(io, 'request.json')], stable);
    return (await readJson(join(io, 'result.json'))).outcome === 'readable';
  } catch { return false; }
  finally { await rm(io, { recursive: true, force: true }); }
}
export async function repairJournal({ bundle, journal, backup, diagnostics, stable }) {
  if (await inspectJournal(bundle, journal, stable)) return false;
  await cp(journal, diagnostics, { recursive: true });
  await rm(journal, { recursive: true, force: true });
  await cp(backup, journal, { recursive: true });
  if (!await inspectJournal(bundle, journal, stable)) throw new Error('Retained journal checkpoint is unreadable');
  return true;
}
