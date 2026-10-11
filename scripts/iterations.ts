import type { Control, Run } from './types.ts';

export function runFence(control: Control, run: Pick<Run, 'display_title'> & Partial<Pick<Run, 'id'>>) {
  const title = run.display_title ?? '';
  // Already-dispatched runs from earlier releases keep their original titles.
  const legacy = /^(?:Shurik|Ralph) ([a-z0-9-]+) \/ (start|iterate) (\d+)-(\d+)$/.exec(title);
  if (legacy?.[1] === control.id) return { generation: Number(legacy[3]), iteration: Number(legacy[4]), command: legacy[2] };
  const match = /^Shurik ([a-z0-9-]+) \/ (?:iterate )?(\d+)$/.exec(title);
  if (match?.[1] === control.id) {
    const iteration = Number(match[2]);
    const dispatched = control.dispatchedRuns?.find(entry => entry.runId === String(run.id));
    if (dispatched?.iteration === iteration) return { generation: dispatched.generation, iteration, command: 'iterate' };
  }
  if (control.owner?.runId === String(run.id)) return { generation: control.owner.generation, iteration: control.owner.iteration, command: 'iterate' };
  if (control.lastRunId === String(run.id)) return { generation: control.generation, iteration: Math.max(1, control.next - 1), command: 'iterate' };
  return null;
}
