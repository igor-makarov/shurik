import { test } from 'node:test';
import fc from 'fast-check';
import { controlFixture } from './test-support.ts';
import type { Outcome } from '../scripts/types.ts';

function integerSetting(name: string, fallback: number, min: number) {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value < min || value > 2147483647) throw new Error('Invalid ' + name);
  return value;
}
const seed = integerSetting('SHURIK_PBT_SEED', 20261011, 0);
const runs = integerSetting('SHURIK_PBT_RUNS', 1000, 1);
let ordinal = 0;

// Each named property has a stable seed. Fast-check prints the seed, shrink path,
// and smallest counterexample on failure; node's name filter can replay one test.
export function property<Ts extends [unknown, ...unknown[]]>(name: string, generated: fc.IProperty<Ts> | fc.IAsyncProperty<Ts>, numRuns = runs) {
  const defaultSeed = (seed + ordinal++) % 2147483647;
  const parameters = { seed: process.env.SHURIK_PBT_SEED === undefined ? defaultSeed : seed, numRuns };
  test('PBT: ' + name, () => fc.assert(generated, parameters));
}

export const text = fc.array(fc.constantFrom(...'aB09 /\\_-"', '\n', '\t', 'é', '中', '🙂'),
  { maxLength: 80 }).map(chars => chars.join(''));
const alphanumeric = fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789');
export const identifier = fc.tuple(alphanumeric,
  fc.array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'), { maxLength: 48 }))
  .map(([first, rest]) => first + rest.join(''));
export const positive = fc.integer({ min: 1, max: 100000 });
export const sha = fc.array(fc.constantFrom(...'0123456789abcdef'), { minLength: 40, maxLength: 40 }).map(chars => chars.join(''));
export const reasoning = fc.constantFrom('off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max');
export const terminal = fc.constantFrom<Outcome>('yielded', 'agent_failure', 'timeout', 'runner_failure');
export const control = fc.record({
  id: identifier, generation: positive, next: positive, seconds: fc.integer({ min: 10, max: 1800 }),
  branch: fc.constant('codex/shurik/task'), source: sha, status: fc.constant('running'),
  provider: fc.option(fc.constantFrom('opencode-go', 'openai', 'anthropic', 'google', 'amazon-bedrock', 'openrouter', 'deepseek'), { nil: undefined }),
  model: identifier, reasoning, owner: fc.option(fc.record({ runId: identifier }), { nil: null }),
  deadline: fc.constant(null), lastRunId: identifier, lastDispatchAt: fc.constant('2026-10-11T12:00:00Z'),
  engine: fc.record({ repository: fc.constant('fixture/shurik'), ref: fc.constant('v1') }),
  checkpoint: fc.record({ workCommit: sha, generation: positive, sequence: identifier, runId: identifier, at: fc.constant('2026-10-11T12:00:00Z') }),
  failureTrail: fc.array(identifier, { maxLength: 5 }),
}).map(({ owner, ...value }) => controlFixture({ ...value,
  owner: owner ? { runId: owner.runId, generation: value.generation, iteration: value.next } : null }));
