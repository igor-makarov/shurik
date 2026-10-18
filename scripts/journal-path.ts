import { join } from 'node:path';

// Missing IDs retain the original shared-journal layout for existing sessions.
export function journalDirectory(root: string, journalId?: string) {
  if (journalId === undefined) return root;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(journalId)) throw new Error('Invalid session journal ID');
  return join(root, 'sessions', journalId);
}
