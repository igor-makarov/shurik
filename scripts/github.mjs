// Stable supervisor code. This module uses built-ins only and never executes worker source.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
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
export async function configureGit(cwd) {
  await git(cwd, 'config', 'user.name', 'shurik[bot]');
  await git(cwd, 'config', 'user.email', 'shurik@users.noreply.github.com');
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
  async mutate(change, message = 'shurik: update loop control') {
    for (let i = 0; i < 5; i++) {
      const { revision, value } = await this.read();
      const next = await change(structuredClone(value)); if (!next) return value;
      // A private checkout is reset to the fetched parent, never the user's source checkout.
      await git(this.cwd, 'checkout', '--detach', revision);
      await saveJson(join(this.cwd, 'control.json'), next); await commit(this.cwd, message);
      try { await git(this.cwd, 'push', 'origin', `HEAD:refs/heads/${this.branch}`); return next; }
      catch (e) { if (i === 4) throw e; }
    }
  }
}
