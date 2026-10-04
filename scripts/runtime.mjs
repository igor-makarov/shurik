import { spawn } from 'node:child_process';
import { cp, mkdir, readFile, writeFile, rm, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { command, saveJson, readJson } from './github.mjs';
import { digest, classify } from './policy.mjs';
export const IMAGE = 'node:24.14.0-bookworm@sha256:5a593d74b632d1c6f816457477b6819760e13624455d587eef0fa418c8d0777b';
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
const base = ['run', '--rm', '--init', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=256', '--memory=3g', '--cpus=2',
  '--user', `${process.getuid?.() ?? 1001}:${process.getgid?.() ?? 1001}`, '-e', 'HOME=/tmp'];
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
  try {
    const output = await command('docker', [...base, '--network=bridge', '-e', 'SHURIK_BUNDLE=/candidate/dist/worker.cjs',
      '-e', 'SHURIK_REAL_JOURNAL=/candidate/real-journal', '-v', `${candidate}:/candidate`, '-w', '/candidate', IMAGE,
      'sh', '-c', 'npm ci --ignore-scripts && node node_modules/typescript/bin/tsc --project trusted-tsconfig.json && node trusted-build.mjs && node --test trusted-worker.test.mjs'], stable, { timeout: 240000 });
    await cp(join(candidate, 'dist/worker.cjs'), destination);
    return { passed: true, log: output.slice(-16000) };
  } catch (error) { return { passed: false, log: `${error.stdout ?? ''}\n${error.stderr ?? ''}\n${error.message}`.slice(-16000) }; }
  finally { await rm(tmp, { recursive: true, force: true }); }
}
export async function launchWorker({ workspace, state, bundle, req, onCheckpoint, onPoll, key, stable }) {
  const io = await temporary('shurik-io-', stable); await mkdir(join(io, 'output'));
  await saveJson(join(io, 'request.json'), { ...req, cwd: '/workspace', journal: '/journal', output: '/io/output' });
  const name = `shurik-${process.pid}-${Date.now()}`;
  const args = [...base, '--name', name, '--read-only',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=512m,mode=1777', '-e', 'HOME=/tmp', '-e', 'OPENCODE_API_KEY',
    '-v', `${workspace}:/workspace`, '-v', `${join(workspace, '.github')}:/workspace/.github:ro`,
    '-v', `${join(workspace, '.git')}:/workspace/.git:ro`, '-v', `${join(workspace, '.shurik')}:/workspace/.shurik:ro`,
    '-v', `${join(state, 'pi-jsonl')}:/journal`, '-v', `${io}:/io`, '-v', `${bundle}:/worker.cjs:ro`,
    '-w', '/workspace', IMAGE, 'node', '/worker.cjs', '/io/request.json'];
  // No host GitHub credentials, Docker socket, or Git credential config in this process environment/container.
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, DOCKER_HOST: process.env.DOCKER_HOST,
    DOCKER_CONTEXT: process.env.DOCKER_CONTEXT, OPENCODE_API_KEY: key };
  const child = spawn('docker', args, { cwd: stable, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', d => { log = (log + d).slice(-16000); });
  let exited = false; const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => { exited = true; resolve(code); }); });
  const hardEnd = Date.now() + (req.seconds + 75) * 1000; let nonce; let lastPoll = 0;
  try {
    while (!exited) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      if (Date.now() - lastPoll >= 10000) {
        lastPoll = Date.now();
        if (await onPoll?.()) { await command('docker', ['stop', '-t', '45', name], stable).catch(() => {}); break; }
      }
      const checkpoint = await readJson(join(io, 'output/checkpoint.json'), null);
      if (checkpoint && checkpoint.nonce !== nonce) {
        nonce = checkpoint.nonce;
        await command('docker', ['pause', name], stable);
        try { await onCheckpoint?.(); }
        finally { await writeFile(join(io, 'output/checkpoint.ack'), nonce); await command('docker', ['unpause', name], stable).catch(() => {}); }
      }
      if (Date.now() >= hardEnd) { await command('docker', ['stop', '-t', '10', name], stable).catch(() => {}); break; }
    }
    const code = await done;
    const result = await readJson(join(io, 'output/result.json'), null);
    return { result, outcome: classify(result, code), code, log };
  } finally { await command('docker', ['rm', '-f', name], stable).catch(() => {}); await rm(io, { recursive: true, force: true }); }
}
export async function inspectJournal(bundle, journal, stable) {
  const io = await temporary('shurik-inspect-', stable);
  await saveJson(join(io, 'request.json'), { version: 1, id: 'inspect', model: 'space-bunny-free', seconds: 1,
    cwd: '/tmp', journal: '/journal', output: '/io', mode: 'inspect', sessions: [] });
  try {
    // Inspection is read-only at the Pi API; mount a disposable copy because opening can reclaim sidecars.
    await cp(journal, join(io, 'journal'), { recursive: true });
    await command('docker', [...base, '--network=none', '-v', `${io}:/io`, '-v', `${join(io, 'journal')}:/journal`,
      '-v', `${resolve(bundle)}:/worker.cjs:ro`, IMAGE, 'node', '/worker.cjs', '/io/request.json'], stable);
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
