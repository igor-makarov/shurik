import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { validateId } from './policy.ts';

// Canonical layout v1. Runtime state is a hydrated copy of control-branch state.
export const PATHS = Object.freeze({
  version: 1, stateRoot: 'state',
  control: 'control.json', controlState: 'state', failures: 'failures',
  journal: 'pi-jsonl', loop: 'loop.json', runtime: 'runtime.json',
  history: 'history-index.json', iterations: 'iterations', diagnostics: 'diagnostics',
  taskFiles: 'task-files', taskManifest: 'task-files.json', config: '.shurik/config.json',
  prompt: 'PROMPT.md', emergency: '.shurik-emergency',
});
export const workBranch = (id: string) => `codex/shurik/${validateId(id)}`;
export const controlBranch = (id: string) => `codex/shurik-control/${validateId(id)}`;
export function runtimeState(repository: string | undefined, id: string) {
  if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository) || repository.split('/').some(part => part === '.' || part === '..')) throw new Error('Repository must be owner/name (use --repository or GITHUB_REPOSITORY)');
  return resolve(process.env.SHURIK_HOME ?? join(homedir(), '.shurik'), PATHS.stateRoot, repository, validateId(id));
}
export function sessionPaths(workspace: string, id: string, repository = process.env.GITHUB_REPOSITORY) {
  const state = runtimeState(repository, id);
  return { version: PATHS.version, repository, workspace: resolve(workspace), workBranch: workBranch(id),
    controlBranch: controlBranch(id), runtime: { state, journal: join(state, PATHS.journal),
      loop: join(state, PATHS.loop), engine: join(state, PATHS.runtime),
      history: join(state, PATHS.history), iterations: join(state, PATHS.iterations),
      diagnostics: join(state, PATHS.diagnostics), taskFiles: join(state, PATHS.taskFiles),
      taskManifest: join(state, PATHS.taskManifest) },
    control: { metadata: PATHS.control, state: PATHS.controlState,
      loop: `${PATHS.controlState}/${PATHS.loop}`, engine: `${PATHS.controlState}/${PATHS.runtime}`,
      journal: `${PATHS.controlState}/${PATHS.journal}`, history: `${PATHS.controlState}/${PATHS.history}`,
      iterations: `${PATHS.controlState}/${PATHS.iterations}`, diagnostics: `${PATHS.controlState}/${PATHS.diagnostics}`,
      taskFiles: `${PATHS.controlState}/${PATHS.taskFiles}`,
      taskManifest: `${PATHS.controlState}/${PATHS.taskManifest}`, failures: PATHS.failures } };
}
