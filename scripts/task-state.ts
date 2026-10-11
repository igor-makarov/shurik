import { errorCode } from './types.ts';
import type { ProjectConfig } from './config.ts';
import { PATHS } from './paths.ts';
import { cp, lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { readJson, saveJson } from './github.ts';

function validatePaths(paths: unknown): string[] {
  if (!Array.isArray(paths) || paths.some(path => typeof path !== 'string'
    || !path || path.split('/').some(part => !part || part === '.' || part === '..'
      || part.startsWith('.') || ['node_modules', 'dist'].includes(part))
    || path.includes('\\'))) throw new Error('checkpointPaths must contain relative task paths');
  return [...new Set(paths)];
}

async function exists(path: string) {
  try { return await lstat(path); } catch (error) { if (errorCode(error) === 'ENOENT') return null; throw error; }
}

async function safeTree(root: string, path: string) {
  let current = root;
  for (const part of path.split('/')) {
    current = join(current, part);
    const stat = await exists(current);
    if (!stat) return false;
    if (stat.isSymbolicLink()) throw new Error(`Checkpoint path contains a symlink: ${path}`);
  }
  async function visit(file: string) {
    const stat = await lstat(file);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error(`Unsupported checkpoint file: ${file}`);
    if (stat.isDirectory()) for (const name of await readdir(file)) await visit(join(file, name));
  }
  await visit(current);
  return true;
}

// Explicitly selected ignored task state travels with the journal on the control branch.
export async function snapshotTaskState(workspace: string, state: string, workCommit: string) {
  const config = await readJson<Partial<ProjectConfig>>(join(workspace, PATHS.config), {});
  const paths = validatePaths(config.checkpointPaths ?? []);
  const root = join(state, PATHS.taskFiles);
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  for (const path of paths) {
    if (!await safeTree(workspace, path)) continue;
    await mkdir(join(root, path, '..'), { recursive: true });
    await cp(join(workspace, path), join(root, path), { recursive: true });
  }
  await saveJson(join(state, PATHS.taskManifest), { version: 1, workCommit, paths });
}

export async function restoreTaskState(workspace: string, state: string, workCommit: string | undefined) {
  const manifest = await readJson<{version: number; workCommit: string; paths: string[]} | null>(join(state, PATHS.taskManifest), null);
  if (!manifest) return;
  if (manifest.version !== 1 || manifest.workCommit !== workCommit) throw new Error('Task snapshot does not match saved work commit');
  const paths = validatePaths(manifest.paths);
  const root = join(state, PATHS.taskFiles);
  // Restoring only absent files keeps newer Git/maintainer state authoritative.
  for (const path of paths) {
    if (!await safeTree(root, path)) continue;
    await safeTree(workspace, path);
    await cp(join(root, path), join(workspace, path), { recursive: true, force: false, errorOnExist: false });
  }
}
