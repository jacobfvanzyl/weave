import {
  CHATGPT_CODEX_DEFAULT_MODEL_IDS,
  getOpenAIModelCapabilities,
  type OpenAIReasoningEffortOption,
  type OpenAIServiceTierOption,
} from './model-capabilities';

export type ModelOption = {
  id: string;
  label: string;
  providerId?: string;
  providerName?: string;
  providerLogoUrl?: string;
  contextWindow?: number;
  supportedReasoningEfforts?: OpenAIReasoningEffortOption[];
  defaultReasoningEffort?: string;
  serviceTiers?: OpenAIServiceTierOption[];
  defaultServiceTier?: string | null;
};

export type ModelConfig = {
  defaultModel: string;
  options: ModelOption[];
};

type ModelsDevModel = {
  id?: string;
  name?: string;
  limit?: {
    context?: number;
  };
};

type ConfiguredModelOption = {
  id: string;
  label?: string;
  contextWindow?: number;
};

type ModelsDevProvider = {
  id?: string;
  name?: string;
  models?: Record<string, ModelsDevModel>;
};

type ModelsDevCatalog = Record<string, ModelsDevProvider>;

const modelsDevUrl = 'https://models.dev/api.json';
const modelsDevLogoUrl = 'https://models.dev/logos';
const modelsDevCacheTtlMs = 1000 * 60 * 60 * 6;
let modelsDevCache: { catalog: ModelsDevCatalog; expiresAt: number } | null = null;

const titleCase = (value: string) =>
  value
    .replace(/[:/._-]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase())
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

const getCatalogModel = (id: string, catalog?: ModelsDevCatalog) => {
  const parts = splitModelId(id);
  if (!parts) return undefined;

  return catalog?.[parts.providerId]?.models?.[parts.modelId];
};

const labelForModel = (id: string, catalog?: ModelsDevCatalog) => {
  const parts = splitModelId(id);
  if (!parts) return fallbackName(id);

  const provider = catalog?.[parts.providerId];
  const model = getCatalogModel(id, catalog);
  const providerName = provider?.name ?? fallbackName(parts.providerId);
  const modelName = model?.name ?? fallbackName(parts.modelId);

  return `${providerName}/${modelName}`;
};

const contextWindowForModel = (id: string, catalog?: ModelsDevCatalog) => {
  const context = getCatalogModel(id, catalog)?.limit?.context;
  return typeof context === 'number' && Number.isFinite(context) && context > 0 ? context : undefined;
};

const configuredContextWindowFor = (item: ConfiguredModelOption) => {
  if (!Object.prototype.hasOwnProperty.call(item, 'contextWindow')) return undefined;
  if (typeof item.contextWindow !== 'number' || !Number.isFinite(item.contextWindow) || item.contextWindow <= 0) {
    throw new Error(`WEAVE_MODEL_OPTIONS contextWindow for ${item.id} must be a positive number.`);
  }
  return item.contextWindow;
};

const modelOption = (
  id: string,
  catalog?: ModelsDevCatalog,
  label?: string,
  configuredContextWindow?: number,
): ModelOption => {
  const parts = splitModelId(id);
  const provider = parts ? catalog?.[parts.providerId] : undefined;
  const capabilities = getOpenAIModelCapabilities(id);
  const explicitContextWindow = typeof configuredContextWindow === 'number' &&
      Number.isFinite(configuredContextWindow) && configuredContextWindow > 0
    ? configuredContextWindow
    : undefined;
  const contextWindow = explicitContextWindow ?? capabilities.contextWindow ?? contextWindowForModel(id, catalog);
  return {
    id,
    label: label ?? labelForModel(id, catalog),
    ...(parts ? { providerId: parts.providerId } : {}),
    ...(provider?.name
      ? { providerName: provider.name }
      : parts
      ? { providerName: fallbackName(parts.providerId) }
      : {}),
    ...(parts ? { providerLogoUrl: `${modelsDevLogoUrl}/${encodeURIComponent(parts.providerId)}.svg` } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(capabilities.supportedReasoningEfforts.length > 0
      ? {
        supportedReasoningEfforts: capabilities.supportedReasoningEfforts,
        defaultReasoningEffort: capabilities.defaultReasoningEffort,
      }
      : {}),
    ...(capabilities.serviceTiers.length > 0
      ? {
        serviceTiers: capabilities.serviceTiers,
        defaultServiceTier: capabilities.defaultServiceTier ?? null,
      }
      : {}),
  };
};

const parseModelOptions = (catalog?: ModelsDevCatalog): ModelOption[] => {
  const raw = process.env.WEAVE_MODEL_OPTIONS;
  if (!raw?.trim()) return CHATGPT_CODEX_DEFAULT_MODEL_IDS.map((id) => modelOption(id, catalog));

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed
        .map((item) =>
          typeof item === 'string'
            ? modelOption(item, catalog)
            : item && typeof item === 'object' && typeof (item as Record<string, unknown>).id === 'string'
            ? modelOption(
              (item as ConfiguredModelOption).id,
              catalog,
              typeof (item as ConfiguredModelOption).label === 'string'
                ? (item as ConfiguredModelOption).label
                : undefined,
              configuredContextWindowFor(item as ConfiguredModelOption),
            )
            : undefined
        )
        .filter((item): item is ModelOption => Boolean(item));
    }
  } catch {
    // Fall through to comma-separated parsing.
  }

  return raw.split(',').map((id) => id.trim()).filter(Boolean).map((id) => modelOption(id, catalog));
};

export const getModelConfig = async (): Promise<ModelConfig> => {
  const defaultModel = process.env.WEAVE_DEFAULT_MODEL ?? 'openai/gpt-5.6-sol';
  let catalog: ModelsDevCatalog | undefined;
  try {
    catalog = await getModelsDevCatalog();
  } catch {
    catalog = undefined;
  }

  const options = parseModelOptions(catalog);
  return {
    defaultModel,
    options: options.some((option) => option.id === defaultModel)
      ? options
      : [modelOption(defaultModel, catalog), ...options],
  };
};

export const resolveModelOption = async (modelId: string): Promise<ModelOption> => {
  const config = await getModelConfig();
  const option = config.options.find(candidate => candidate.id === modelId);
  if (!option) throw new Error(`Selected model is not configured: ${modelId}`);
  if (!option.contextWindow) throw new Error(`Model ${modelId} does not advertise a valid context window.`);
  return option;
};

export const __modelOptionsTest = {
  clearCache: () => {
    modelsDevCache = null;
  },
};
