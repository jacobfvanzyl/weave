export type ModelOption = { id: string; label: string; contextWindow?: number };

type ModelsDevModel = { id: string; name?: string; limit?: { context?: number } };
type ModelsDevProvider = { models?: Record<string, ModelsDevModel> };
type ModelsDevResponse = Record<string, ModelsDevProvider>;

export const defaultModel = 'openai/gpt-5.5';

const providerNames: Record<string, string> = {
  anthropic: 'Anthropic',
  deepseek: 'DeepSeek',
  google: 'Google',
  meta: 'Meta',
  'meta-llama': 'Meta',
  openai: 'OpenAI',
  chatgpt: 'ChatGPT',
  codex: 'Codex',
  qwen: 'Qwen',
};

const availableModels = [
  'openai/gpt-5.4-mini',
  'openai/gpt-5.4',
  'openai/gpt-5.5',
  'openrouter/openai/gpt-5.4-mini',
  'openrouter/openai/gpt-5-mini',
  'openrouter/openai/gpt-5',
  'openrouter/anthropic/claude-sonnet-4',
  'openrouter/anthropic/claude-opus-4.1',
  'openrouter/google/gemini-2.5-pro',
  'openrouter/google/gemini-2.5-flash',
  'openrouter/meta-llama/llama-3.3-70b-instruct',
  'openrouter/qwen/qwen3-coder',
  'openrouter/deepseek/deepseek-chat-v3.1',
] as const;

const titleCase = (value: string) =>
  value
    .replace(/[:/._-]+/g, ' ')
    .replace(/\b\w/g, character => character.toUpperCase())
    .replace(/\bGpt\b/g, 'GPT')
    .replace(/\bAi\b/g, 'AI')
    .replace(/\bV(\d)/g, 'V$1');

const cleanModelName = (value: string) =>
  titleCase(value)
    .replace(/\bGPT (\d)(?:\s+)(\d)\b/g, 'GPT-$1.$2')
    .replace(/\bGPT (\d)(?:\s+)(\d)\s+Mini\b/g, 'GPT-$1.$2 Mini')
    .replace(/\bGPT (\d)(?:\s+)(\d)\s+Codex\b/g, 'GPT-$1.$2 Codex');

export const getFallbackModelDisplayName = (modelId: string) => {
  const withoutGateway = modelId.startsWith('openrouter/') ? modelId.slice('openrouter/'.length) : modelId;
  const [provider, ...modelParts] = withoutGateway.split('/');
  const providerName = providerNames[provider] ?? titleCase(provider);
  const modelName = cleanModelName(modelParts.join('/') || provider);
  return `${providerName} ${modelName}`;
};

const fallbackContextWindows: Record<string, number> = {
  'openai/gpt-5.4-mini': 1_050_000,
  'openai/gpt-5.4': 1_050_000,
  'openai/gpt-5.5': 1_050_000,
  'openrouter/openai/gpt-5.4-mini': 1_050_000,
  'openrouter/openai/gpt-5-mini': 400_000,
  'openrouter/openai/gpt-5': 400_000,
  'openrouter/anthropic/claude-sonnet-4': 200_000,
  'openrouter/anthropic/claude-opus-4.1': 200_000,
  'openrouter/google/gemini-2.5-pro': 1_048_576,
  'openrouter/google/gemini-2.5-flash': 1_048_576,
};

export const fallbackModelOptions: ModelOption[] = availableModels.map(id => ({
  id,
  label: getFallbackModelDisplayName(id),
  contextWindow: fallbackContextWindows[id],
}));

export const fetchModelOptions = async () => {
  const response = await fetch('https://models.dev/api.json');
  if (!response.ok) throw new Error(`models.dev failed: ${response.status}`);

  const data = await response.json() as ModelsDevResponse;
  const openRouterModels = data.openrouter?.models ?? {};
  const openAiModels = data.openai?.models ?? {};
  const openAiOptions = Object.values(openAiModels).map(model => ({
    id: `openai/${model.id}`,
    label: model.name ? cleanModelName(model.name) : getFallbackModelDisplayName(`openai/${model.id}`),
    contextWindow: model.limit?.context,
  }));
  const openRouterOptions = Object.values(openRouterModels)
    .map(model => ({
      id: `openrouter/${model.id}`,
      label: model.name ? `OpenRouter ${cleanModelName(model.name)}` : getFallbackModelDisplayName(`openrouter/${model.id}`),
      contextWindow: model.limit?.context,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const resolvedOptions = [...openAiOptions, ...openRouterOptions].sort((a, b) => a.label.localeCompare(b.label));
  const resolvedIds = new Set(resolvedOptions.map(option => option.id));
  const fallbackOnlyOptions = fallbackModelOptions.filter(option => !resolvedIds.has(option.id));
  return [...fallbackOnlyOptions, ...resolvedOptions];
};

export const getResolvedModelDisplayName = (modelId: string, options: ModelOption[] = fallbackModelOptions) =>
  options.find(option => option.id === modelId)?.label ?? getFallbackModelDisplayName(modelId);

export const getResolvedModelContextWindow = (modelId: string, options: ModelOption[] = fallbackModelOptions) =>
  options.find(option => option.id === modelId)?.contextWindow ?? fallbackContextWindows[modelId];
