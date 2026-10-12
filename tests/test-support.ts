import type { Control, Iteration, Run, Runtime, WorkerResult } from '../scripts/types.ts';
import type { api } from '../scripts/github.ts';

const sha = 'a'.repeat(40);
export function controlFixture(overrides: Partial<Control> = {}): Control {
  return { version: 1, id: 'fixture', branch: 'fixture', defaultBranch: 'main', supervisor: sha,
    stateStorage: 'control', status: 'running', generation: 1, next: 1, owner: null,
    seconds: 10, model: 'space-bunny-free', reasoning: 'high', source: sha,
    createdAt: '2026-10-11T00:00:00Z', lastDispatchAt: null, ...overrides };
}
export function iterationFixture(overrides: Partial<Iteration> = {}): Iteration {
  return { version: 1, id: '1-1', runId: '123', generation: 1, iteration: 1,
    startedAt: '2026-10-11T00:00:00Z', outcome: 'running', source: sha,
    runtime: sha, model: 'space-bunny-free', reasoning: 'high', ...overrides };
}
export function runFixture(overrides: Partial<Run> = {}): Run {
  return { id: 123, workflow_id: 1, name: 'Shurik', event: 'workflow_dispatch', status: 'completed',
    conclusion: 'failure', html_url: 'https://github.com/fixture/consumer/actions/runs/123', head_sha: sha, head_branch: 'main', run_started_at: '2026-10-11T00:00:00Z',
    updated_at: '2026-10-11T00:01:00Z', ...overrides };
}
export function runtimeFixture(overrides: Partial<Runtime> = {}): Runtime {
  return { version: 2, selected: sha, fallback: sha, probation: false, quarantined: [], ...overrides };
}
export function apiFixture(handler: (path: string) => Promise<unknown>): typeof api {
  return async <T = unknown>(path: string) => await handler(path) as T;
}
export interface TestWorkerResult extends WorkerResult { captured: unknown[]; minEntryId: number; maxEntryId: number }
