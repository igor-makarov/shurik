import { appendFile, cp, mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { commit, git, saveJson } from './github.mjs';

async function ignoreLocalState(workspace) {
  await mkdir(join(workspace, '.git', 'info'), { recursive: true });
  const exclude = join(workspace, '.git', 'info', 'exclude');
  const rules = await readFile(exclude, 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e; });
  if (!rules.split('\n').includes('/.shurik-local/')) await appendFile(exclude, '\n/.shurik-local/\n');
}

async function commitWork(workspace, message) {
  await ignoreLocalState(workspace);
  await git(workspace, 'rm', '-r', '-f', '--cached', '--ignore-unmatch', '--', '.shurik-local');
  return commit(workspace, message);
}

export async function initializeCheckpoint({ workspace, state, store, control, message }) {
  const workCommit = await commitWork(workspace, message);
  const next = { ...control, checkpoint: { workCommit, generation: control.generation,
    sequence: 'initialize', runId: null, at: new Date().toISOString() } };
  await cp(state, join(store.cwd, 'state'), { recursive: true });
  await git(store.cwd, 'fetch', workspace, workCommit);
  await saveJson(join(store.cwd, 'control.json'), next);
  const controlCommit = await commit(store.cwd, message);
  await git(store.cwd, 'push', '--atomic', 'origin', `${controlCommit}:refs/heads/${store.branch}`,
    `${workCommit}:refs/heads/${control.branch}`);
  return next;
}

export async function loadState(store, workspace, id) {
  const { revision, value } = await store.read();
  if (value.stateStorage !== 'control') throw new Error('Loop requires its legacy pinned supervisor; state was not migrated');
  await git(store.cwd, 'checkout', '--detach', revision);
  const state = join(workspace, '.shurik-local', 'state', id);
  await ignoreLocalState(workspace);
  await rm(state, { recursive: true, force: true });
  await cp(join(store.cwd, 'state'), state, { recursive: true });
  return state;
}

export async function publishCheckpoint({ workspace, state, store, generation, owner, sequence, message, record }) {
  const owns = c => c.generation === generation && (owner === null ? c.owner === null : c.owner?.runId === owner);
  const { value: initial } = await store.read();
  if (!owns(initial)) throw new Error('Stale checkpoint: control ownership or generation changed');
  // This local cache remains available to tools, but never becomes part of the task PR.
  const workCommit = await commitWork(workspace, message);
  if (record) {
    record.workCommit = workCommit;
    await saveJson(join(state, 'iterations', `${record.id}.json`), record);
  }
  const checkpoint = { workCommit, generation, sequence, runId: owner, at: new Date().toISOString() };
  const control = await store.mutate(c => {
    if (!owns(c)) return null;
    return { ...c, checkpoint };
  }, message, {}, { state, workspace, workCommit, workBranch: initial.branch });
  if (control.checkpoint?.workCommit !== workCommit || control.checkpoint?.at !== checkpoint.at) {
    throw new Error('Stale checkpoint: control ownership or generation changed');
  }
  return workCommit;
}
