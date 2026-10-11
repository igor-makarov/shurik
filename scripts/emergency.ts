import { cp, mkdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { PATHS } from './paths.ts';
import { sanitizeTree } from './policy.ts';

export async function preserveEmergency({ workspace, state, logs, destination, secrets }: {
  workspace: string; state?: string; logs?: string; destination: string; secrets: (string | undefined)[];
}) {
  // Redact before copying so even an interrupted copy cannot leave raw credentials.
  await sanitizeTree(workspace, secrets);
  if (state) await sanitizeTree(state, secrets);
  if (logs) await sanitizeTree(logs, secrets);
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await cp(workspace, join(destination, 'workspace'), {
    recursive: true, filter: path => !['.git', 'node_modules', 'dist'].includes(basename(path))
  });
  if (state) await cp(state, join(destination, PATHS.stateRoot), { recursive: true });
  if (logs) await cp(logs, join(destination, PATHS.logs), { recursive: true });
  await sanitizeTree(destination, secrets);
}
