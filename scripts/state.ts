import type { Control, Iteration } from './types.ts';
import { PATHS, runtimeState, runtimeLogs } from './paths.ts';
import { cp, rm, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { commit, git, saveJson, copySession, type ControlStore } from './github.ts';
import { snapshotTaskState, restoreTaskState } from './task-state.ts';

export async function initializeCheckpoint({ workspace, state, logs, store, control, message }: { workspace: string; state: string; logs?: string; store: ControlStore; control: Control; message: string }) {
  const workCommit = await commit(workspace, message);
  await snapshotTaskState(workspace, state, workCommit, control.checkpointPaths);
  const next = { ...control, checkpoint: { workCommit, generation: control.generation,
    sequence: 'initialize', runId: null, at: new Date().toISOString() } };
  await copySession(state, join(store.cwd, PATHS.controlState), logs);
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
  const logs = runtimeLogs(process.env.GITHUB_REPOSITORY, id);
  await rm(logs, { recursive: true, force: true });
  await mkdir(join(logs, '..'), { recursive: true });
  try { await rename(join(state, PATHS.diagnostics), logs); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  await mkdir(logs, { recursive: true });
  await restoreTaskState(workspace, state, value.checkpoint?.workCommit);
  return state;
}

export async function publishCheckpoint({ workspace, state, logs, store, generation, owner, sequence, message, record, journalSnapshot }: { workspace: string; state: string; logs?: string; store: ControlStore; generation: number; owner: string | null; sequence: string; message: string; record?: Iteration; journalSnapshot?: string }) {
  const owns = (c: Control) => c.generation === generation && (owner === null ? c.owner === null : c.owner?.runId === owner);
  const { value: initial } = await store.read();
  if (!owns(initial)) throw new Error('Stale checkpoint: control ownership or generation changed');
  // Runtime state lives outside the task checkout and cannot enter the task index.
  const workCommit = await commit(workspace, message);
  await snapshotTaskState(workspace, state, workCommit, initial.checkpointPaths);
  if (record) {
    record.workCommit = workCommit;
    await saveJson(join(state, PATHS.iterations, `${record.id}.json`), record);
  }
  const checkpoint = { workCommit, generation, sequence, runId: owner, at: new Date().toISOString() };
  const control = await store.mutate(c => {
    if (!owns(c)) return null;
    return { ...c, checkpoint };
  }, message, {}, { state, logs, workspace, workCommit, workBranch: initial.branch, journalSnapshot, journalId: record?.journalId });
  if (control.checkpoint?.workCommit !== workCommit || control.checkpoint?.at !== checkpoint.at) {
    throw new Error('Stale checkpoint: control ownership or generation changed');
  }
  return workCommit;
}
