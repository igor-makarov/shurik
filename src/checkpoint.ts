import { cp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from '@earendil-works/chord';
import type { Conversation } from '@earendil-works/pi-durable';

export const CHECKPOINT_JOURNAL = 'checkpoint-journal';

export function timeRemainingInstructions(iterationEndsAt: number, deadline?: string | null, now = Date.now()) {
  const seconds = Math.max(0, Math.ceil((iterationEndsAt - now) / 1000));
  const overall = deadline
    ? `The overall loop deadline is ${deadline}; about ${Math.max(0, Math.ceil((Date.parse(deadline) - now) / 1000))} seconds remain in the loop.`
    : 'There is no overall loop deadline configured.';
  return `Time update at ${new Date(now).toISOString()}: about ${seconds} seconds remain in this iteration (ends ${new Date(iterationEndsAt).toISOString()}). ${overall} `
    + 'An iteration is one session of a continuing Ralph loop. The supervisor normally starts the next fresh-context iteration while the loop is running and before its overall deadline. '
    + 'Choose useful work that fits the remaining time, save recoverable partial results, commit meaningful task progress, and leave a concise handoff with the evidence and resumption point so the next iteration or a later resume can continue. '
    + 'You can yield when a durable handoff is ready; you do not need to finish the entire task in this session. Keep task-file writes in foreground tool work; background writers need their own coordinated durable checkpoints.';
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
