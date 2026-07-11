export type OpenAIReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type OpenAIServiceTier = 'auto' | 'default' | 'flex' | 'priority';

export const CHATGPT_CODEX_GPT_5_6_MODELS = [
  { slug: 'gpt-5.6-sol', contextWindow: 372_000 },
  { slug: 'gpt-5.6-terra', contextWindow: 372_000 },
  { slug: 'gpt-5.6-luna', contextWindow: 372_000 },
] as const;

export const CHATGPT_CODEX_DEFAULT_MODEL_IDS = [
  ...CHATGPT_CODEX_GPT_5_6_MODELS.map(({ slug }) => `openai/${slug}`),
  'openai/gpt-5.5',
];

export type OpenAIReasoningEffortOption = {
  effort: OpenAIReasoningEffort;
  label: string;
  description?: string;
};

export type OpenAIServiceTierOption = {
  id: OpenAIServiceTier;
  name: string;
  description?: string;
};

export type OpenAIModelCapabilities = {
  supportedReasoningEfforts: OpenAIReasoningEffortOption[];
  defaultReasoningEffort?: OpenAIReasoningEffort;
  serviceTiers: OpenAIServiceTierOption[];
  defaultServiceTier?: OpenAIServiceTier | null;
  contextWindow?: number;
};

const emptyCapabilities: OpenAIModelCapabilities = {
  supportedReasoningEfforts: [],
  serviceTiers: [],
};

const reasoningLabels: Record<OpenAIReasoningEffort, string> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
};

const codexReasoningEfforts: OpenAIReasoningEffortOption[] = [
  { effort: 'low', label: reasoningLabels.low, description: 'Fast responses with lighter reasoning' },
  {
    effort: 'medium',
    label: reasoningLabels.medium,
    description: 'Balances speed and reasoning depth for everyday tasks',
  },
  { effort: 'high', label: reasoningLabels.high, description: 'Greater reasoning depth for complex problems' },
  { effort: 'xhigh', label: reasoningLabels.xhigh, description: 'Extra high reasoning depth for complex problems' },
];

const gpt56ReasoningEfforts: OpenAIReasoningEffortOption[] = [
  ...codexReasoningEfforts,
  { effort: 'max', label: reasoningLabels.max, description: 'Maximum reasoning depth for the hardest problems' },
];

const priorityServiceTier: OpenAIServiceTierOption = {
  id: 'priority',
  name: 'Fast',
  description: '1.5x speed, increased usage',
};

const codexReasoningModelSlugs = new Set([
  'codex-auto-review',
  'gpt-5-codex',
  'gpt-5.1-codex',
  'gpt-5.1-codex-max',
  'gpt-5.1-codex-mini',
  'gpt-5.2',
  'gpt-5.2-codex',
  'gpt-5.3-codex',
  'gpt-5.3-codex-spark',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.5',
  ...CHATGPT_CODEX_GPT_5_6_MODELS.map(({ slug }) => slug),
]);

const priorityServiceTierModelSlugs = new Set([
  'gpt-5.4',
  'gpt-5.5',
  ...CHATGPT_CODEX_GPT_5_6_MODELS.map(({ slug }) => slug),
]);

const reasoningEffortOrder: OpenAIReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

const isReasoningEffort = (value: unknown): value is OpenAIReasoningEffort =>
  value === 'none' || value === 'minimal' || value === 'low' || value === 'medium' || value === 'high' ||
  value === 'xhigh' || value === 'max';

const modelSlug = (model: unknown) => {
  if (typeof model !== 'string') return undefined;
  const value = model.trim();
  if (!value) return undefined;
  if (value.startsWith('chatgpt/codex/')) return value.slice('chatgpt/codex/'.length);
  if (value.startsWith('openai/')) return value.slice('openai/'.length);
  return value.includes('/') ? undefined : value;
};

const fastestSupportedReasoningEffort = (capabilities: OpenAIModelCapabilities) => {
  const supported = new Set(capabilities.supportedReasoningEfforts.map((option) => option.effort));
  return reasoningEffortOrder.find((effort) => supported.has(effort));
};

export const getOpenAIModelCapabilities = (model: unknown): OpenAIModelCapabilities => {
  const slug = modelSlug(model);
  if (!slug || !codexReasoningModelSlugs.has(slug)) return emptyCapabilities;
  const gpt56Model = CHATGPT_CODEX_GPT_5_6_MODELS.find((candidate) => candidate.slug === slug);

  return {
    supportedReasoningEfforts: gpt56Model ? gpt56ReasoningEfforts : codexReasoningEfforts,
    defaultReasoningEffort: 'medium',
    serviceTiers: priorityServiceTierModelSlugs.has(slug) ? [priorityServiceTier] : [],
    defaultServiceTier: null,
    ...(gpt56Model ? { contextWindow: gpt56Model.contextWindow } : {}),
  };
};

export const normalizeOpenAIReasoningEffort = (
  value: unknown,
  model: unknown,
  options: { fallbackToDefault?: boolean } = {},
): OpenAIReasoningEffort | undefined => {
  const capabilities = getOpenAIModelCapabilities(model);
  if (capabilities.supportedReasoningEfforts.length === 0) return undefined;

  const supported = new Set(capabilities.supportedReasoningEfforts.map((option) => option.effort));
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';

  if (!raw) return options.fallbackToDefault ? capabilities.defaultReasoningEffort : undefined;
  if (isReasoningEffort(raw) && supported.has(raw)) return raw;
  if (raw === 'off' || raw === 'none' || raw === 'minimal') return fastestSupportedReasoningEffort(capabilities);

  return options.fallbackToDefault ? capabilities.defaultReasoningEffort : undefined;
};

export const normalizeOpenAIServiceTier = (value: unknown, model: unknown): OpenAIServiceTier | undefined => {
  const capabilities = getOpenAIModelCapabilities(model);
  if (capabilities.serviceTiers.length === 0) return undefined;

  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  const normalized = raw === 'fast' ? 'priority' : raw;
  return capabilities.serviceTiers.some((tier) => tier.id === normalized) ? normalized as OpenAIServiceTier : undefined;
};
