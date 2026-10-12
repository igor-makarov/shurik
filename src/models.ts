import type { Api, Model, ModelThinkingLevel, MutableModels, OpenAICompletionsCompat } from '@earendil-works/pi-ai';

/** Like Pi agent's custom-ID fallback: reuse a provider transport, keep the requested ID. */
export function registerUnlistedModel(models: MutableModels, providerId: string, modelId: string, reasoning: ModelThinkingLevel): boolean {
  if (models.getModel(providerId, modelId)) return false;
  const provider = models.getProvider(providerId);
  if (!provider) return false;
  const baseline = provider.getModels();
  // OpenCode exposes several wire APIs; use its generic OpenAI-compatible endpoint for custom IDs.
  const template = (providerId === 'opencode-go' ? baseline.find(model => model.id === 'kimi-k3') : undefined)
    ?? (['opencode', 'opencode-go'].includes(providerId)
      ? baseline.find(model => model.api === 'openai-completions') : undefined) ?? baseline[0];
  if (!template) return false;
  const model: Model<Api> = {
    id: modelId, name: modelId, provider: providerId, api: template.api, baseUrl: template.baseUrl,
    input: ['text'], contextWindow: template.contextWindow, maxTokens: template.maxTokens,
    reasoning: reasoning !== 'off', thinkingLevelMap: { [reasoning]: reasoning },
    // No prices/capabilities are known for this ID. Zero rates mean unavailable estimates, not free usage.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...(template.api === 'openai-completions' ? { compat: {
      maxTokensField: (template.compat as OpenAICompletionsCompat | undefined)?.maxTokensField,
    } } : {}),
  };
  models.setProvider({ ...provider, getModels: () => [...baseline, model],
    getAllModels: () => [...(provider.getAllModels?.() ?? baseline), model] });
  return true;
}
