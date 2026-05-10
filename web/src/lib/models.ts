export type ModelOption = {
  id: string;
  label: string;
};

type ModelsDevModel = {
  id: string;
  name?: string;
};

type ModelsDevProvider = {
  models?: Record<string, ModelsDevModel>;
};

type ModelsDevResponse = Record<string, ModelsDevProvider>;

const providerNames: Record<string, string> = {
  anthropic: 'Anthropic',
  deepseek: 'DeepSeek',
  google: 'Google',
  meta: 'Meta',
  'meta-llama': 'Meta',
  openai: 'OpenAI',
  qwen: 'Qwen',
};

const titleCase = (value: string) =>
  value
    .replace(/[:/._-]+/g, ' ')
    .replace(/\b\w/g, character => character.toUpperCase())
    .replace(/\bGpt\b/g, 'GPT')
    .replace(/\bAi\b/g, 'AI')
    .replace(/\bV(\d)/g, 'V$1');

export const getFallbackModelDisplayName = (modelId: string) => {
  const withoutGateway = modelId.startsWith('openrouter/') ? modelId.slice('openrouter/'.length) : modelId;
  const [provider, ...modelParts] = withoutGateway.split('/');
  const providerName = providerNames[provider] ?? titleCase(provider);
  const modelName = titleCase(modelParts.join('/') || provider);

  return `${providerName} ${modelName}`;
};

export const getModelDisplayName = getFallbackModelDisplayName;

export const availableModels = [
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

export const fallbackModelOptions: ModelOption[] = availableModels.map(id => ({
  id,
  label: getFallbackModelDisplayName(id),
}));

export const modelOptions = fallbackModelOptions;

export const defaultModel = availableModels[0];

export const fetchModelsDevModelOptions = async () => {
  const response = await fetch('https://models.dev/api.json');
  if (!response.ok) throw new Error(`models.dev failed: ${response.status}`);

  const data = await response.json() as ModelsDevResponse;
  const openRouterModels = data.openrouter?.models ?? {};
  const resolvedOptions = Object.values(openRouterModels)
    .map(model => ({
      id: `openrouter/${model.id}`,
      label: model.name ? `OpenRouter ${model.name}` : getFallbackModelDisplayName(`openrouter/${model.id}`),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const resolvedIds = new Set(resolvedOptions.map(option => option.id));
  const fallbackOnlyOptions = fallbackModelOptions.filter(option => !resolvedIds.has(option.id));

  return [...fallbackOnlyOptions, ...resolvedOptions];
};

export const resolveModelInput = (input: string, options: ModelOption[] = fallbackModelOptions) => {
  const normalized = input.trim().toLowerCase();

  return options.find(
    option => option.id.toLowerCase() === normalized || option.label.toLowerCase() === normalized,
  )?.id;
};

export const getResolvedModelDisplayName = (modelId: string, options: ModelOption[] = fallbackModelOptions) =>
  options.find(option => option.id === modelId)?.label ?? getFallbackModelDisplayName(modelId);
