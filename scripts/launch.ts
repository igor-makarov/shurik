import type { Control, Inputs, ModelSpec, Options, SwarmMember } from './types.ts';
import { normalizeOptions, validateId, validateProvider, validateReasoning } from './policy.ts';

export interface PlannedLoop { id: string; model: ModelSpec; swarm?: SwarmMember }

function supplied(value: unknown) { return value !== undefined && value !== ''; }
function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); }
    catch { throw new Error(`${label} must be a JSON object`); }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[], label: string) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unknown ${label} field: ${key}`);
}
function modelPatch(value: unknown, label: string): Partial<ModelSpec> {
  const patch = object(value, label); keys(patch, ['provider', 'name', 'reasoning'], label);
  for (const [key, field] of Object.entries(patch)) {
    if (typeof field !== 'string' || !field.trim()) throw new Error(`${label}.${key} must be a nonempty string`);
  }
  return patch as Partial<ModelSpec>;
}
export function resolveModel(base: Partial<ModelSpec>, patch: Partial<ModelSpec> = {}): ModelSpec {
  if (patch.provider && base.provider && patch.provider !== base.provider && !patch.name) {
    throw new Error('Changing model.provider requires an explicit model.name');
  }
  const model = { ...base, ...patch };
  if (!model.provider || !model.name || !model.reasoning) throw new Error('A complete model requires provider, name, and reasoning');
  return { provider: validateProvider(model.provider), name: model.name.trim(), reasoning: validateReasoning(model.reasoning) };
}
export function validateInputs(inputs: Inputs) {
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) throw new Error('Inputs must be an object');
  for (const key of ['provider', 'reasoning', 'swarm_member']) {
    if (key in inputs) throw new Error(`The ${key} input was removed in v2; use model JSON with provider, name, and reasoning`);
  }
  if (supplied(inputs.swarm) && (inputs.command ?? 'start') !== 'start') throw new Error('swarm is only supported by start; stop/resume target individual loop IDs');
  if (supplied(inputs.model) && !['start', 'resume'].includes(inputs.command ?? 'start')) throw new Error('model is only supported by start and resume');
}
export function planStart(raw: Inputs): PlannedLoop[] {
  const inputs = normalizeOptions(raw); validateInputs({ ...inputs, command: 'start' });
  const id = validateId(inputs.loop_id);
  const base = supplied(inputs.model) ? modelPatch(inputs.model, 'model') : {};
  if (!supplied(inputs.swarm)) return [{ id, model: resolveModel(base) }];
  const swarm = object(inputs.swarm, 'swarm'); keys(swarm, ['agents', 'models'], 'swarm');
  if (swarm.models !== undefined && (!Array.isArray(swarm.models) || !swarm.models.length)) throw new Error('swarm.models must be a nonempty array');
  const models = swarm.models as unknown[] | undefined;
  const count = swarm.agents === undefined ? models?.length : swarm.agents;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1) throw new Error('swarm.agents must be a positive safe integer');
  if (models && count !== models.length) throw new Error('swarm.agents must equal swarm.models.length');
  validateId(`${id}-${count - 1}`);
  return Array.from({ length: count }, (_, index) => ({ id: validateId(`${id}-${index}`),
    model: resolveModel(base, models ? modelPatch(models[index], `swarm.models[${index}]`) : {}),
    swarm: { id, index, agents: count } }));
}
export function loopOptions(inputs: Inputs, loop: PlannedLoop): Options {
  const { model: _model, swarm: _swarm, ...settings } = normalizeOptions(inputs);
  return { ...settings, loop_id: loop.id, provider: loop.model.provider, model: loop.model.name,
    reasoning: loop.model.reasoning, swarm_member: loop.swarm };
}
export function resumeOptions(inputs: Inputs, previous: Control): Options {
  validateInputs({ ...inputs, command: 'resume' });
  const base = { provider: validateProvider(previous.provider), name: previous.model, reasoning: validateReasoning(previous.reasoning) };
  const model = resolveModel(base, supplied(inputs.model) ? modelPatch(inputs.model, 'model') : {});
  return loopOptions(inputs, { id: previous.id, model });
}
