// Stable supervisor code. This module uses built-ins only and never executes worker source.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, cp, rm } from 'node:fs/promises';
import { join } from 'node:path';
const exec = promisify(execFile);
export async function command(cmd, args, cwd, options = {}) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  if (cmd === 'git' && (process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN)) {
    env.GIT_CONFIG_COUNT = '1'; env.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader';
    env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN}`).toString('base64')}`;
  }
  return (await exec(cmd, args, { cwd, maxBuffer: 8 * 1024 * 1024, timeout: 120000,
    env, ...options })).stdout.trim();
}
export const git = (cwd, ...args) => command('git', args, cwd);
export const repositoryURL = (repo, path = '') => `https://api.github.com/repos/${repo}${path ? '/' + path : ''}`;
export async function api(path, method = 'GET', body) {
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!token) throw new Error('Supervisor GitHub token missing');
  const response = await fetch(repositoryURL(process.env.GITHUB_REPOSITORY, path), {
    method, headers: { authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28',
      accept: 'application/vnd.github+json', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) throw new Error(`GitHub ${method} ${path}: ${response.status} ${await response.text()}`);
  return response.status === 204 ? undefined : response.json();
}
export async function jobLog(jobId, fetcher = fetch) {
  if (!/^\d+$/.test(String(jobId))) throw new Error('Invalid job ID');
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!token) throw new Error('Supervisor GitHub token missing');
  let response = await fetcher(repositoryURL(process.env.GITHUB_REPOSITORY, `actions/jobs/${jobId}/logs`), {
    headers: { authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' },
    redirect: 'manual', signal: AbortSignal.timeout(30000)
  });
  if (response.status === 302) {
    const location = new URL(response.headers.get('location'));
    if (location.protocol !== 'https:') throw new Error('Invalid job log redirect');
    // GitHub returns a short-lived storage URL. Never forward the API credential there.
    response = await fetcher(location, { signal: AbortSignal.timeout(30000) });
  }
  if (!response.ok) throw new Error(`GitHub job logs: ${response.status}`);
  let tail = Buffer.alloc(0); let bytes = 0;
  // Keep a bounded tail; cap download cost independently of the retained excerpt.
  for await (const chunk of response.body) {
    bytes += chunk.length; tail = Buffer.concat([tail, chunk]).subarray(-16384);
    if (bytes >= 2 * 1024 * 1024) return { text: tail.toString('utf8'), truncated: true, downloadLimited: true };
  }
  return { text: tail.toString('utf8'), truncated: bytes > 16384, downloadLimited: false };
}
export async function configureGit(cwd) {
  await git(cwd, 'config', 'user.name', 'github-actions[bot]');
  await git(cwd, 'config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com');
}
export async function saveJson(path, value) { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, JSON.stringify(value, null, 2) + '\n'); }
export async function readJson(path, fallback) { try { return JSON.parse(await readFile(path, 'utf8')); } catch (e) { if (e.code === 'ENOENT' && fallback !== undefined) return fallback; throw e; } }
export async function commit(cwd, message) {
  await git(cwd, 'add', '-A');
  if (await git(cwd, 'status', '--porcelain')) await git(cwd, 'commit', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}
export class ControlStore {
  constructor(cwd, id) { this.cwd = cwd; this.branch = `codex/shurik-control/${id}`; }
  async read() {
    await git(this.cwd, 'fetch', 'origin', `refs/heads/${this.branch}`);
    const revision = await git(this.cwd, 'rev-parse', 'FETCH_HEAD');
    return { revision, value: JSON.parse(await git(this.cwd, 'show', `${revision}:control.json`)) };
  }
  async mutate(change, message = 'shurik: update loop control', evidence = {}, checkpoint) {
    for (let i = 0; i < 5; i++) {
      const { revision, value } = await this.read();
      const next = await change(structuredClone(value)); if (!next) return value;
      // A private checkout is reset to the fetched parent, never the user's source checkout.
      await git(this.cwd, 'checkout', '--detach', revision);
      for (const [path, report] of Object.entries(evidence)) {
        if (!/^failures\/\d+-\d+\.json$/.test(path)) throw new Error('Invalid evidence path');
        await saveJson(join(this.cwd, path), report);
      }
      if (checkpoint) {
        await rm(join(this.cwd, 'state'), { recursive: true, force: true });
        await cp(checkpoint.state, join(this.cwd, 'state'), { recursive: true });
        // Import the task commit locally. Both remote refs are then published in one Git transaction.
        await git(this.cwd, 'fetch', checkpoint.workspace, checkpoint.workCommit);
      }
      await saveJson(join(this.cwd, 'control.json'), next); const revisionToPush = await commit(this.cwd, message);
      const refs = [`${revisionToPush}:refs/heads/${this.branch}`];
      if (checkpoint) refs.push(`${checkpoint.workCommit}:refs/heads/${checkpoint.workBranch}`);
      try { await git(this.cwd, 'push', ...(checkpoint ? ['--atomic'] : []), 'origin', ...refs); return next; }
      catch (e) { if (i === 4) throw e; }
    }
  }
}
