export interface ProjectConfig { version: number; provider: string; model: string; iterationSeconds: number; checkpointSeconds: number; prompt: string; checkpointPaths?: string[] }
import { readJson } from './github.ts';
import { PATHS } from './paths.ts';
import { resolve, relative, isAbsolute } from 'node:path';

export const DEFAULTS = Object.freeze({ version: 1, provider: 'opencode-go',
  model: 'space-bunny-free', iterationSeconds: 1800, checkpointSeconds: 300, prompt: PATHS.prompt });
export async function projectConfig(workspace: string) {
  const config = { ...DEFAULTS, ...await readJson<Partial<ProjectConfig>>(resolve(workspace, PATHS.config), {}) };
  if (config.version !== 1 || config.provider !== 'opencode-go') throw new Error('Unsupported Shurik project configuration');
  for (const [key, max] of [['iterationSeconds', 1800], ['checkpointSeconds', 1800]] as const) {
    if (!Number.isInteger(config[key]) || config[key] < 1 || config[key] > max) throw new Error(`Invalid ${key}`);
  }
  if (config.iterationSeconds < 10) throw new Error('iterationSeconds must be at least 10');
  if (typeof config.model !== 'string' || !config.model.trim()) throw new Error('Model must be a nonempty string');
  const prompt = relative(resolve(workspace), resolve(workspace, config.prompt));
  if (!prompt || prompt.startsWith('..') || isAbsolute(config.prompt)) throw new Error('Prompt must be a relative project file');
  return config;
}
