import { cp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from '@earendil-works/chord';
import type { Conversation } from '@earendil-works/pi-durable';

export const CHECKPOINT_JOURNAL = 'checkpoint-journal';

export function timeRemainingInstructions(iterationEndsAt: number, deadline?: string | null, now = Date.now(), checkpointSeconds = 300) {
  const endsAt = Math.min(iterationEndsAt, deadline ? Date.parse(deadline) : Infinity);
  const finalStretch = endsAt - now <= checkpointSeconds * 1000;
  const progress = 'Actively pursue verified progress and resolve blockers. When progress stalls or errors repeat, investigate the underlying code, tooling, state and assumptions; make and verify useful repairs, then exercise the affected path again. '
    + 'Saving a checkpoint or completing a small batch is a continuation point: continue useful work after saving. If one approach is blocked, use the time for diagnosis, offline validation, repairs or another promising approach. '
    + 'Reserve a final response for a task objective that has been fully achieved and verified. Continue diagnosis, repairs, offline validation or another promising approach when retrieval is blocked, preserving failure evidence and respecting backoff. Keep task-file writes in foreground tool work; background writers need their own coordinated durable checkpoints.';
  if (!finalStretch) return progress;
  const seconds = Math.max(0, Math.ceil((endsAt - now) / 1000));
  const overall = deadline
    ? `The overall loop deadline is ${deadline}; about ${Math.max(0, Math.ceil((Date.parse(deadline) - now) / 1000))} seconds remain in the loop.`
    : 'There is no overall loop deadline configured.';
  return `${progress}\n\nTime update at ${new Date(now).toISOString()}. Final checkpoint interval: about ${seconds} seconds remain in this iteration (ends ${new Date(endsAt).toISOString()}). ${overall} `
    + 'Prepare continuation before the supervisor preempts this session: save recoverable partial results, commit meaningful task progress, and leave a concise handoff with evidence and a resumption point. '
    + 'The supervisor normally starts the next fresh-context iteration while the loop is running and before its overall deadline; after the overall deadline, preserved work supports a later resume. '
    + 'Keep pursuing useful work after saving the handoff until preemption; this reminder is not a request to stop early.';
}

export async function snapshotJournal(root: Conversation, journal: string, output: string, context: Context) {
  const destination = join(output, CHECKPOINT_JOURNAL);
  await rm(destination, { recursive: true, force: true });
  // Hold Pi's mutation line: preceding fsync commits have settled and no journal
  // writer can run during the copy. The awaited hook also gates the next tool/model round.
  return root.commit(async tx => {
    const page = await tx.scanEntries({ conversationId: root.id }, 1);
    await cp(journal, destination, { recursive: true });
    return page.items[0]?.id;
  }, context);
}
