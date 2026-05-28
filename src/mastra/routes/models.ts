import { registerApiRoute } from '@mastra/core/server';

export type ModelOption = {
  id: string;
  label: string;
};

type ModelsDevModel = {
  id?: string;
  name?: string;
};

type ModelsDevProvider = {
  id?: string;
  name?: string;
  models?: Record<string, ModelsDevModel>;
};

type ModelsDevCatalog = Record<string, ModelsDevProvider>;

const modelsDevUrl = 'https://models.dev/api.json';
const modelsDevCacheTtlMs = 1000 * 60 * 60 * 6;
let modelsDevCache: { catalog: ModelsDevCatalog; expiresAt: number } | null = null;

const titleCase = (value: string) =>
  value
    .replace(/[:/._-]+/g, ' ')
    .replace(/\b\w/g, character => character.toUpperCase())
    .replace(/\bOpenai\b/g, 'OpenAI')
    .replace(/\bGpt\b/g, 'GPT')
    .replace(/\bAi\b/g, 'AI');

const getModelsDevCatalog = async () => {
  if (modelsDevCache && modelsDevCache.expiresAt > Date.now()) return modelsDevCache.catalog;

  const response = await fetch(modelsDevUrl);
  if (!response.ok) throw new Error(`models.dev failed: ${response.status}`);

  const catalog = await response.json() as ModelsDevCatalog;
  modelsDevCache = {
    catalog,
    expiresAt: Date.now() + modelsDevCacheTtlMs,
  };
  return catalog;
};

const splitModelId = (id: string) => {
  const [providerId, ...modelParts] = id.split('/');
  if (!providerId || modelParts.length === 0) return null;
  return { providerId, modelId: modelParts.join('/') };
};

const fallbackName = (value: string) => titleCase(value).replace(/\s+(\d)\s+(\d)\b/g, ' $1.$2');

const labelForModel = (id: string, catalog?: ModelsDevCatalog) => {
  const parts = splitModelId(id);
  if (!parts) return fallbackName(id);

  const provider = catalog?.[parts.providerId];
  const model = provider?.models?.[parts.modelId];
  const providerName = provider?.name ?? fallbackName(parts.providerId);
  const modelName = model?.name ?? fallbackName(parts.modelId);

  return `${providerName}/${modelName}`;
};

const parseModelOptions = (catalog?: ModelsDevCatalog): ModelOption[] => {
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
                  : labelForModel((item as Record<string, string>).id, catalog),
              }
            : undefined)
        .filter((item): item is ModelOption => Boolean(item));
    }
  } catch {
    // Fall through to comma-separated parsing.
  }

  return raw.split(',').map(id => id.trim()).filter(Boolean).map(id => ({ id, label: labelForModel(id, catalog) }));
};

const getModelConfig = async () => {
  const defaultModel = process.env.WEAVE_DEFAULT_MODEL ?? 'openai/gpt-5.5';
  let catalog: ModelsDevCatalog | undefined;
  try {
    catalog = await getModelsDevCatalog();
  } catch {
    catalog = undefined;
  }

  const options = parseModelOptions(catalog);
  return {
    defaultModel,
    options: options.some(option => option.id === defaultModel)
      ? options
      : [{ id: defaultModel, label: labelForModel(defaultModel, catalog) }, ...options],
  };
};

export const modelRoutes = [
  registerApiRoute('/models', {
    method: 'GET',
    handler: async c => c.json(await getModelConfig()),
  }),
];
