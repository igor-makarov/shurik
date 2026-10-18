import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { planStart, loopOptions, resumeOptions, validateInputs } from '../scripts/launch.ts';
import { actionOptions, actionPaths } from '../action/run.ts';
import { parseArgs } from '../bin/shurik.ts';
import { loopSnapshot, resumeSettings } from '../scripts/policy.ts';
import { iterationPrompt } from '../scripts/failures.ts';
import { controlFixture } from './test-support.ts';
import type { Inputs, ModelSpec } from '../scripts/types.ts';

const model: ModelSpec = { provider: 'openai', name: 'gpt-6-sol', reasoning: 'high' };

test('one model starts one exact loop; agents replicates it into stable, independent members', () => {
  assert.deepEqual(planStart({ loop_id: 'research', model }), [{ id: 'research', model }]);
  const inputs = { loop_id: 'research', model, swarm: { agents: 4 }, work_seconds: '120' };
  const before = structuredClone(inputs), plan = planStart(inputs);
  assert.deepEqual(plan.map(loop => loop.id), ['research-0', 'research-1', 'research-2', 'research-3']);
  plan.forEach((loop, index) => {
    assert.deepEqual(loop.swarm, { id: 'research', index, agents: 4 });
    assert.deepEqual(loop.model, model);
    assert.equal(loopOptions(inputs, loop).work_seconds, '120');
  });
  plan[0].model.reasoning = 'low'; assert.equal(plan[1].model.reasoning, 'high');
  assert.deepEqual(inputs, before);
});

test('models can stand alone, inherit a shared specification, and validate explicit cardinality', () => {
  const plan = planStart({ loop_id: 'work', model, swarm: { agents: 3,
    models: [{}, { reasoning: 'medium' }, { provider: 'anthropic', name: 'claude-haiku-4-5', reasoning: 'low' }] } });
  assert.deepEqual(plan.map(loop => loop.model), [model, { ...model, reasoning: 'medium' },
    { provider: 'anthropic', name: 'claude-haiku-4-5', reasoning: 'low' }]);
  assert.equal(planStart({ loop_id: 'work', swarm: { models: [model, model] } }).length, 2);
});

test('invalid swarm/model inputs fail before any launch work', () => {
  const cases: [unknown, string][] = [
    [{ loop_id: 'work' }, 'complete model'],
    [{ loop_id: 'work', model: 'gpt-6-sol' }, 'JSON object'],
    [{ loop_id: 'work', model: {} }, 'complete model'],
    [{ loop_id: 'work', model, swarm: {} }, 'positive safe integer'],
    [{ loop_id: 'work', model, swarm: { agents: 0 } }, 'positive safe integer'],
    [{ loop_id: 'work', model, swarm: { agents: -1 } }, 'positive safe integer'],
    [{ loop_id: 'work', model, swarm: { agents: 1.5 } }, 'positive safe integer'],
    [{ loop_id: 'work', model, swarm: { agents: '4' } }, 'positive safe integer'],
    [{ loop_id: 'work', model, swarm: { agents: null, models: [model] } }, 'positive safe integer'],
    [{ loop_id: 'work', model, swarm: { agents: 2, models: [{}] } }, 'equal'],
    [{ loop_id: 'work', model, swarm: { models: [] } }, 'nonempty array'],
    [{ loop_id: 'work', model, swarm: { models: [null] } }, 'object'],
    [{ loop_id: 'work', model, swarm: { models: [{ provider: 'anthropic' }] } }, 'explicit model.name'],
    [{ loop_id: 'work', model: { ...model, reasoning: 'automatic' } }, 'reasoning'],
    [{ loop_id: 'work', model: { ...model, provider: '../openai' } }, 'Provider'],
    [{ loop_id: 'work', model: { ...model, name: '' } }, 'nonempty'],
    [{ loop_id: 'work', model: { ...model, reasoining: 'high' } }, 'Unknown model field'],
    [{ loop_id: 'work', model, swarm: { models: [model], agents: 1, extra: true } }, 'Unknown swarm field'],
    [{ loop_id: 'x'.repeat(49), model, swarm: { agents: 2 } }, 'Loop ID'],
  ];
  for (const [input, error] of cases) assert.throws(() => planStart(input as Inputs), new RegExp(error));
  assert.throws(() => validateInputs({ command: 'resume', loop_id: 'work', swarm: { agents: 2 } }), /only supported by start/);
});

test('workflow JSON, action fields, and CLI JSON produce the same launch plan without YAML defaults', () => {
  const raw: Inputs = { command: 'start', loop_id: 'work', model: JSON.stringify(model), swarm: '{"agents":2}', 'checkpoint-seconds': '0' };
  const action = actionOptions({ SHURIK_INPUTS: JSON.stringify(raw) });
  const cli = parseArgs(['start', '--loop-id', 'work', '--model', JSON.stringify(model), '--swarm', '{"agents":2}', '--checkpoint-seconds', '0']);
  assert.deepEqual(planStart(action), planStart(cli));
  assert.equal(action.checkpoint_seconds, '0'); assert.equal(cli.checkpoint_seconds, '0');
  assert.equal(actionOptions({ SHURIK_INPUTS: JSON.stringify(raw), SHURIK_CHECKPOINT_SECONDS: '120' }).checkpoint_seconds, '120');
  assert.equal(actionOptions({ SHURIK_LOOP_ID: 'work', SHURIK_CHECKPOINT_SECONDS: '0' }).checkpoint_seconds, '0');
  const overridden = actionOptions({ SHURIK_INPUTS: JSON.stringify(raw), SHURIK_MODEL: JSON.stringify({ ...model, reasoning: 'low' }) });
  assert.equal(planStart(overridden)[0].model.reasoning, 'low');
  const commandOverride = actionOptions({ SHURIK_INPUTS: JSON.stringify({ ...raw, command: 'stop' }), SHURIK_COMMAND: 'start' });
  assert.deepEqual(planStart(commandOverride), planStart(action), 'named command overrides apply before command-specific validation');
  assert.throws(() => actionOptions({ SHURIK_INPUTS: '[]' }), /Inputs must be an object/);
  const paths = actionPaths(action, 'fixture/project');
  assert.equal(paths['loop-ids'], '["work-0","work-1"]');
  assert.equal(paths['emergency-path']?.split('\n').length, 2);
  assert.ok(paths['state-path']?.split('\n')[0].endsWith('/work-0'));
});

test('resume retains saved selections, resolves explicit overrides, and preserves swarm identity and fencing', () => {
  const previous = controlFixture({ status: 'stopped', provider: model.provider, model: model.name,
    reasoning: model.reasoning, swarm: { id: 'work', index: 1, agents: 4 } });
  const unchanged = resumeSettings(previous, resumeOptions({ command: 'resume', loop_id: previous.id }, previous));
  assert.equal(unchanged.model, previous.model); assert.equal(unchanged.reasoning, previous.reasoning);
  const changed = resumeSettings(previous, resumeOptions({ model: { reasoning: 'medium' } }, previous));
  assert.equal(changed.reasoning, 'medium'); assert.equal(changed.generation, previous.generation + 1);
  assert.deepEqual(changed.swarm, previous.swarm);
  assert.throws(() => resumeOptions({ model: { provider: 'anthropic' } }, previous), /explicit model.name/);
  assert.deepEqual(loopSnapshot(changed).swarm, previous.swarm);
  const prompt = iterationPrompt('Work', '2-1', [], [], '/state', '/logs', changed);
  assert.match(prompt, /Loop ID: fixture/); assert.match(prompt, /Swarm: work; member index: 1 \(zero-based\); agents: 4/);
});

test('generated swarm configurations preserve exact cardinality, overrides, IDs, and caller input', () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 32 }), fc.array(fc.constantFrom('low', 'medium', 'high'), { minLength: 1, maxLength: 32 }),
    (agents, levels) => {
      const replicated = planStart({ loop_id: 'generated', model, swarm: { agents } });
      assert.equal(new Set(replicated.map(loop => loop.id)).size, agents);
      const input: Inputs = { loop_id: 'generated', model, swarm: { agents: levels.length,
        models: levels.map(reasoning => ({ reasoning: reasoning as ModelSpec['reasoning'] })) } };
      const before = structuredClone(input), plan = planStart(input);
      assert.deepEqual(plan.map(loop => loop.model.reasoning), levels);
      assert.deepEqual(input, before);
      assert.throws(() => planStart({ ...input, swarm: { agents: levels.length + 1, models: levels.map(() => ({})) } }), /equal/);
    }), { numRuns: 1000 });
});
