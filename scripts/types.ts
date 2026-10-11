import type { Request } from '../src/worker.ts';
import type { SessionSummary } from '../src/history.ts';

export type Options = Partial<Record<'command' | 'loop_id' | 'model' | 'reasoning' | 'seconds' | 'deadline' | 'source_ref' | 'generation' | 'iteration' | 'workflow' | 'workspace' | 'repository' | 'request' | 'bundle' | 'prompt' | 'checkpoint_seconds' | 'checkpoint_paths', string>> & { create_pr?: boolean | string; verification?: boolean | string; help?: boolean };
export type Secrets = (string | undefined)[];
export type Outcome = 'running' | 'yielded' | 'agent_failure' | 'timeout' | 'runner_failure' | 'interrupted';
export interface Checkpoint { workCommit: string; generation: number; sequence: string; runId: string | null; at: string }
export interface Control {
  version: number; id: string; branch: string; defaultBranch: string; supervisor: string;
  stateStorage: string; layoutVersion?: number; prompt?: string; workflow?: string;
  checkpointSeconds?: number; checkpointPaths?: string[];
  engine?: { repository: string; ref: string | null } | null;
  status: string; generation: number; next: number;
  owner: { runId: string; generation: number; iteration: number; claimedAt?: string } | null;
  deadline?: string | null; seconds: number; model: string; reasoning: string;
  source: string; sourceRef?: string | null; createdAt: string; lastDispatchAt: string | null;
  stoppedAt?: string; lastRunId?: string | null; pr?: string | null; createPr?: boolean | 'auto'; verification?: boolean;
  checkpoint?: Checkpoint; failureTrail?: string[];
  recovery?: { runId: string; conclusion: string | null; at: string };
}
export interface Runtime {
  version: number; selected: string; fallback: string; probation: boolean; quarantined: string[];
  validatedSource?: string; validatedFingerprint?: string; rejectedFingerprint?: string | null;
}
export interface Iteration {
  version: number; id: string; runId: string; generation: number; iteration: number;
  startedAt: string; outcome: Outcome; source: string; runtime: string; model: string; reasoning: string;
  minEntryId?: number; maxEntryId?: number; checkpointAt?: string; finishedAt?: string;
  error?: string; recovery?: string; usage?: unknown; workCommit?: string;
}
export interface Run {
  id: number; workflow_id: number; run_attempt?: number; name: string; event: string; status: string; conclusion: string | null;
  display_title?: string; html_url: string; head_sha: string; head_branch: string;
  run_started_at: string; updated_at: string;
  repository?: { full_name: string }; head_repository?: { full_name: string };
}
export interface Event { workflow_run?: Run; repository?: { default_branch: string } }
export interface JobStep { number: number; name: string; conclusion: string | null }
export interface Job { id: number; name: string; conclusion: string | null; steps?: JobStep[] }
export interface Log { text: string; truncated: boolean; downloadLimited: boolean }
export interface FailureJob extends Job { steps: JobStep[]; log?: Log; logUnavailable?: string }
export interface Failure {
  version: number; key: string; loopId: string; runId: string; attempt: number;
  generation: number; iteration: number; command: string; conclusion: string | null;
  url: string; headSha: string; startedAt: string; completedAt: string; collectedAt: string;
  interruptedOwner: boolean; jobs: FailureJob[]; jobsTruncated?: boolean; jobsUnavailable?: string;
}
export interface WorkerResult { version: number; outcome: Outcome | 'readable'; error?: unknown; usage?: unknown; minEntryId?: number; maxEntryId?: number }
export interface WorkerReport { outcome: Outcome; result: WorkerResult | null; log: string; code?: number | null }
export type WorkerRequest = Omit<Request, 'cwd' | 'journal' | 'output'>;
export interface WorkerCheckpoint { nonce: string; id: string; minEntryId: number; maxEntryId: number; at: string }
export type Sessions = SessionSummary[];
export interface Publication { state: string; logs?: string; workspace: string; workCommit: string; workBranch: string; journalSnapshot?: string }
export function errorCode(error: unknown): string | undefined { return error instanceof Error && 'code' in error ? String(error.code) : undefined; }
