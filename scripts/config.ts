export interface ProjectConfig { version: number; provider: string; model: string; iterationSeconds: number; waitSeconds?: number; checkpointSeconds: number; prompt: string; checkpointPaths?: string[] }
import { PATHS } from './paths.ts';
import type { Options } from './types.ts';
import { validatePaths } from './task-state.ts';
import { validateProvider, validateWorkSeconds, validateWaitSeconds, normalizeOptions } from './policy.ts';
import { resolve, relative, isAbsolute } from 'node:path';

export const DEFAULTS = Object.freeze({ version: 1,
  iterationSeconds: 1800, waitSeconds: 0, checkpointSeconds: 300, prompt: PATHS.prompt });
export async function projectConfig(workspace: string, options: Options = {}) {
  options = normalizeOptions(options);
  if (!options.provider || !options.model?.trim()) throw new Error('Explicit model provider and name required');
  const provider = validateProvider(options.provider);
  const config: ProjectConfig = { ...DEFAULTS, provider, model: options.model.trim(), checkpointPaths: [] };
  if (options.prompt) config.prompt = options.prompt;
  if (options.work_seconds !== undefined && options.work_seconds !== '') config.iterationSeconds = Number(options.work_seconds);
  if (options.wait_seconds !== undefined && options.wait_seconds !== '') config.waitSeconds = Number(options.wait_seconds);
  if (options.checkpoint_seconds) config.checkpointSeconds = Number(options.checkpoint_seconds);
  config.checkpointPaths = validatePaths(options.checkpoint_paths ? JSON.parse(options.checkpoint_paths) : config.checkpointPaths ?? []);
  if (config.version !== 1) throw new Error('Unsupported Shurik project configuration');
  for (const [key, max] of [['iterationSeconds', 1800], ['checkpointSeconds', 1800]] as const) {
    if (!Number.isInteger(config[key]) || config[key] < 1 || config[key] > max) throw new Error(`Invalid ${key}`);
  }
  validateWorkSeconds(config.iterationSeconds); validateWaitSeconds(config.waitSeconds);
  if (typeof config.model !== 'string' || !config.model.trim()) throw new Error('Explicit model required for the selected provider');
  const prompt = relative(resolve(workspace), resolve(workspace, config.prompt));
  if (!prompt || prompt.startsWith('..') || isAbsolute(config.prompt)) throw new Error('Prompt must be a relative project file');
  return config;
}
