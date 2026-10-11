import type { Control, Iteration } from './types.ts';
import { PATHS, runtimeState } from './paths.ts';
import { cp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { commit, git, saveJson, type ControlStore } from './github.ts';
import { snapshotTaskState, restoreTaskState } from './task-state.ts';

export async function initializeCheckpoint({ workspace, state, store, control, message }: { workspace: string; state: string; store: ControlStore; control: Control; message: string }) {
  const workCommit = await commit(workspace, message);
  await snapshotTaskState(workspace, state, workCommit);
  const next = { ...control, checkpoint: { workCommit, generation: control.generation,
    sequence: 'initialize', runId: null, at: new Date().toISOString() } };
  await cp(state, join(store.cwd, PATHS.controlState), { recursive: true });
  await git(store.cwd, 'fetch', workspace, workCommit);
  await saveJson(join(store.cwd, PATHS.control), next);
  const controlCommit = await commit(store.cwd, message);
  await git(store.cwd, 'push', '--atomic', 'origin', `${controlCommit}:refs/heads/${store.branch}`,
    `${workCommit}:refs/heads/${control.branch}`);
  return next;
}

export async function loadState(store: ControlStore, workspace: string, id: string) {
  const { revision, value } = await store.read();
  if (value.stateStorage !== 'control') throw new Error('Loop requires its legacy pinned supervisor; state was not migrated');
  await git(store.cwd, 'checkout', '--detach', revision);
  const state = runtimeState(process.env.GITHUB_REPOSITORY, id);
  await rm(state, { recursive: true, force: true });
  await cp(join(store.cwd, PATHS.controlState), state, { recursive: true });
  await restoreTaskState(workspace, state, value.checkpoint?.workCommit);
  return state;
}

export async function publishCheckpoint({ workspace, state, store, generation, owner, sequence, message, record, journalSnapshot }: { workspace: string; state: string; store: ControlStore; generation: number; owner: string | null; sequence: string; message: string; record?: Iteration; journalSnapshot?: string }) {
  const owns = (c: Control) => c.generation === generation && (owner === null ? c.owner === null : c.owner?.runId === owner);
  const { value: initial } = await store.read();
  if (!owns(initial)) throw new Error('Stale checkpoint: control ownership or generation changed');
  // Runtime state lives outside the task checkout and cannot enter the task index.
  const workCommit = await commit(workspace, message);
  await snapshotTaskState(workspace, state, workCommit);
  if (record) {
    record.workCommit = workCommit;
    await saveJson(join(state, PATHS.iterations, `${record.id}.json`), record);
  }
  const checkpoint = { workCommit, generation, sequence, runId: owner, at: new Date().toISOString() };
  const control = await store.mutate(c => {
    if (!owns(c)) return null;
    return { ...c, checkpoint };
  }, message, {}, { state, workspace, workCommit, workBranch: initial.branch, journalSnapshot });
  if (control.checkpoint?.workCommit !== workCommit || control.checkpoint?.at !== checkpoint.at) {
    throw new Error('Stale checkpoint: control ownership or generation changed');
  }
  return workCommit;
}
