export type ModelOption = {
  id: string;
  label: string;
};

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

export const getModelDisplayName = (modelId: string) => {
  const withoutGateway = modelId.startsWith('openrouter/') ? modelId.slice('openrouter/'.length) : modelId;
  const [provider, ...modelParts] = withoutGateway.split('/');
  const providerName = providerNames[provider] ?? titleCase(provider);
  const modelName = titleCase(modelParts.join('/') || provider);

  return `${providerName} ${modelName}`;
};

export const availableModels = [
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

export const modelOptions: ModelOption[] = availableModels.map(id => ({
  id,
  label: getModelDisplayName(id),
}));

export const defaultModel = availableModels[0];

export const resolveModelInput = (input: string) => {
  const normalized = input.trim().toLowerCase();

  return modelOptions.find(
    option => option.id.toLowerCase() === normalized || option.label.toLowerCase() === normalized,
  )?.id;
};
