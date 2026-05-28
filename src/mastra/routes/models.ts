import { registerApiRoute } from '@mastra/core/server';

export type ModelOption = {
  id: string;
  label: string;
};

const titleCase = (value: string) =>
  value
    .replace(/[:/._-]+/g, ' ')
    .replace(/\b\w/g, character => character.toUpperCase())
    .replace(/\bGpt\b/g, 'GPT')
    .replace(/\bAi\b/g, 'AI');

const labelForModel = (id: string) => titleCase(id.replace(/^openrouter\//, ''));

const parseModelOptions = (): ModelOption[] => {
  const raw = process.env.WEAVE_MODEL_OPTIONS;
  if (!raw?.trim()) return [];

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed
        .map(item => typeof item === 'string'
          ? { id: item, label: labelForModel(item) }
          : item && typeof item === 'object' && typeof (item as Record<string, unknown>).id === 'string'
            ? {
                id: (item as Record<string, string>).id,
                label: typeof (item as Record<string, unknown>).label === 'string'
                  ? (item as Record<string, string>).label
                  : labelForModel((item as Record<string, string>).id),
              }
            : undefined)
        .filter((item): item is ModelOption => Boolean(item));
    }
  } catch {
    // Fall through to comma-separated parsing.
  }

  return raw.split(',').map(id => id.trim()).filter(Boolean).map(id => ({ id, label: labelForModel(id) }));
};

const getModelConfig = () => {
  const defaultModel = process.env.WEAVE_DEFAULT_MODEL ?? 'openai/gpt-5.5';
  const options = parseModelOptions();
  return {
    defaultModel,
    options: options.some(option => option.id === defaultModel)
      ? options
      : [{ id: defaultModel, label: labelForModel(defaultModel) }, ...options],
  };
};

export const modelRoutes = [
  registerApiRoute('/models', {
    method: 'GET',
    handler: c => c.json(getModelConfig()),
  }),
];
