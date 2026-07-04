type MemoryRecord = Record<string, unknown>;

export type WeaveSemanticRecallScope = 'thread' | 'resource' | 'workspace';

export type MemoryCapabilities = {
  semanticRecall: boolean;
  semanticRecallEmbeddingModel?: string;
  semanticRecallEmbeddingConfig?: SemanticRecallEmbeddingConfig;
  semanticRecallUnavailableReason?: string;
  observationalMemory: boolean;
  observationalMemoryModel?: string;
};

export type SemanticRecallEmbeddingConfig =
  | {
    kind: 'model-router';
    model: string;
    providerId: string;
    modelId: string;
  }
  | {
    kind: 'openai-compatible';
    model: string;
    providerId: string;
    modelId: string;
    url: string;
    apiKey?: string;
  };

export type WeaveObservationalMemoryConfig = {
  model: string;
  scope: 'thread';
  activateAfterIdle: '5m';
  activateOnProviderChange: true;
  temporalMarkers: true;
  observation?: {
    providerOptions: {
      openai: {
        reasoningEffort: 'medium';
      };
    };
  };
  reflection?: {
    providerOptions: {
      openai: {
        reasoningEffort: 'medium';
      };
    };
  };
};

export type ResolvedMemoryPolicy = {
  options: MemoryRecord;
  status: {
    semanticRecall: {
      enabled: boolean;
      configured: boolean;
      requested: boolean;
      scope?: 'thread' | 'resource';
      aliasScope?: WeaveSemanticRecallScope;
      reason?: string;
    };
    observationalMemory: {
      enabled: boolean;
      configured: boolean;
      reason?: string;
    };
    tokenLimit: number;
  };
};

const defaultContextTokenLimit = 120_000;
const defaultSemanticRecallEmbeddingModel = 'ollama/nomic-embed-text';
const defaultOllamaEmbeddingBaseUrl = 'http://127.0.0.1:11434/v1';
const defaultObservationalMemoryModel = 'chatgpt/codex/gpt-5.4-mini';
const openAIMediumReasoningModels = new Set([
  defaultObservationalMemoryModel,
  'openai/gpt-5.4-mini',
  'chatgpt/codex/gpt-5.5',
  'openai/gpt-5.5',
]);
const disabledEnvValues = new Set(['0', 'false']);
const embeddingProviderApiKeyEnvVars: Record<string, string[]> = {
  openai: ['OPENAI_API_KEY'],
  google: ['GOOGLE_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
};

const isRecord = (value: unknown): value is MemoryRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const optionalString = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;

const positiveInteger = (value: unknown) => {
  const number = typeof value === 'string' ? Number(value) : value;
  return typeof number === 'number' && Number.isInteger(number) && number > 0 ? number : undefined;
};

export const getContextTokenLimit = (env: NodeJS.ProcessEnv = process.env) =>
  positiveInteger(env.WEAVE_CONTEXT_TOKEN_LIMIT) ?? defaultContextTokenLimit;

export const getSemanticRecallEmbeddingModel = (env: NodeJS.ProcessEnv = process.env) => {
  const semanticRecallSetting = optionalString(env.WEAVE_SEMANTIC_RECALL)?.toLowerCase();
  if (disabledEnvValues.has(semanticRecallSetting ?? '')) return undefined;
  return optionalString(env.WEAVE_MEMORY_EMBEDDING_MODEL) ?? defaultSemanticRecallEmbeddingModel;
};

const parseModelRouterId = (model: string) => {
  const parts = model.split('/');
  return parts.length === 2 && parts[0] && parts[1] ? { providerId: parts[0], modelId: parts[1] } : undefined;
};

const normalizeOpenAICompatibleBaseUrl = (url: string) => {
  const trimmed = url.replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
};

const getOllamaEmbeddingBaseUrl = (env: NodeJS.ProcessEnv) => {
  const configured = optionalString(env.WEAVE_MEMORY_EMBEDDING_BASE_URL) ?? optionalString(env.WEAVE_OLLAMA_BASE_URL);
  if (configured) return normalizeOpenAICompatibleBaseUrl(configured);
  const port = optionalString(env.WEAVE_OLLAMA_PORT);
  return port ? normalizeOpenAICompatibleBaseUrl(`http://127.0.0.1:${port}`) : defaultOllamaEmbeddingBaseUrl;
};

const getOpenAICompatibleEmbeddingBaseUrl = (providerId: string, env: NodeJS.ProcessEnv) => {
  const configured = optionalString(env.WEAVE_MEMORY_EMBEDDING_BASE_URL);
  if (configured) return normalizeOpenAICompatibleBaseUrl(configured);
  return providerId === 'ollama' ? getOllamaEmbeddingBaseUrl(env) : undefined;
};

export const getSemanticRecallEmbeddingConfig = (
  env: NodeJS.ProcessEnv = process.env,
): SemanticRecallEmbeddingConfig | undefined => {
  const embeddingModel = getSemanticRecallEmbeddingModel(env);
  if (!embeddingModel) return undefined;
  const parsed = parseModelRouterId(embeddingModel);
  if (!parsed) return undefined;

  const openAICompatibleBaseUrl = getOpenAICompatibleEmbeddingBaseUrl(parsed.providerId, env);
  if (openAICompatibleBaseUrl) {
    return {
      kind: 'openai-compatible',
      model: embeddingModel,
      providerId: parsed.providerId,
      modelId: parsed.modelId,
      url: openAICompatibleBaseUrl,
      apiKey: optionalString(env.WEAVE_MEMORY_EMBEDDING_API_KEY) ?? (parsed.providerId === 'ollama' ? 'ollama' : ''),
    };
  }

  return {
    kind: 'model-router',
    model: embeddingModel,
    providerId: parsed.providerId,
    modelId: parsed.modelId,
  };
};

const getSemanticRecallUnavailableReason = (
  embeddingModel: string | undefined,
  embeddingConfig: SemanticRecallEmbeddingConfig | undefined,
  env: NodeJS.ProcessEnv,
) => {
  if (!embeddingModel) return 'semantic recall disabled by env';
  const parsed = parseModelRouterId(embeddingModel);
  if (!parsed || !embeddingConfig) return 'semantic recall embedding model must use provider/model format';
  if (embeddingConfig.kind === 'openai-compatible') return undefined;
  const apiKeyEnvVars = embeddingProviderApiKeyEnvVars[parsed.providerId];
  if (apiKeyEnvVars && !apiKeyEnvVars.some((varName) => optionalString(env[varName]))) {
    return `semantic recall provider key missing: set ${apiKeyEnvVars.join(' or ')}`;
  }
  if (!apiKeyEnvVars) {
    return `semantic recall provider unsupported: set WEAVE_MEMORY_EMBEDDING_BASE_URL or use a supported provider/model`;
  }
  return undefined;
};

export const getMemoryCapabilities = (env: NodeJS.ProcessEnv = process.env): MemoryCapabilities => {
  const observationalMemorySetting = optionalString(env.WEAVE_OBSERVATIONAL_MEMORY)?.toLowerCase();
  const observationalMemoryEnabled = !disabledEnvValues.has(observationalMemorySetting ?? '');
  const observationalMemoryModel = optionalString(env.WEAVE_OBSERVATIONAL_MEMORY_MODEL) ??
    defaultObservationalMemoryModel;
  const semanticRecallEmbeddingModel = getSemanticRecallEmbeddingModel(env);
  const semanticRecallEmbeddingConfig = getSemanticRecallEmbeddingConfig(env);
  const semanticRecallUnavailableReason = getSemanticRecallUnavailableReason(
    semanticRecallEmbeddingModel,
    semanticRecallEmbeddingConfig,
    env,
  );

  return {
    semanticRecall: Boolean(semanticRecallEmbeddingModel && !semanticRecallUnavailableReason),
    ...(semanticRecallEmbeddingModel ? { semanticRecallEmbeddingModel } : {}),
    ...(semanticRecallEmbeddingConfig ? { semanticRecallEmbeddingConfig } : {}),
    ...(semanticRecallUnavailableReason ? { semanticRecallUnavailableReason } : {}),
    observationalMemory: observationalMemoryEnabled,
    ...(observationalMemoryEnabled ? { observationalMemoryModel } : {}),
  };
};

export const resolveObservationalMemoryConfig = (
  capabilities: MemoryCapabilities = getMemoryCapabilities(),
): WeaveObservationalMemoryConfig | undefined => {
  if (!capabilities.observationalMemory || !capabilities.observationalMemoryModel) return undefined;
  const usesOpenAIMediumReasoning = openAIMediumReasoningModels.has(
    capabilities.observationalMemoryModel.toLowerCase(),
  );
  const openAIMediumReasoningProviderOptions = usesOpenAIMediumReasoning
    ? {
      providerOptions: {
        openai: {
          reasoningEffort: 'medium' as const,
        },
      },
    }
    : undefined;

  return {
    model: capabilities.observationalMemoryModel,
    scope: 'thread',
    activateAfterIdle: '5m',
    activateOnProviderChange: true,
    temporalMarkers: true,
    ...(openAIMediumReasoningProviderOptions
      ? {
        observation: openAIMediumReasoningProviderOptions,
        reflection: openAIMediumReasoningProviderOptions,
      }
      : {}),
  };
};

const getSemanticScope = (semanticRecall: unknown): WeaveSemanticRecallScope | undefined => {
  if (!isRecord(semanticRecall)) return undefined;
  return semanticRecall.scope === 'thread' || semanticRecall.scope === 'resource' ||
      semanticRecall.scope === 'workspace'
    ? semanticRecall.scope
    : undefined;
};

const getSemanticTopK = (semanticRecall: unknown) =>
  isRecord(semanticRecall) ? positiveInteger(semanticRecall.topK) : undefined;

const getSemanticMessageRange = (semanticRecall: unknown) => {
  if (!isRecord(semanticRecall)) return undefined;
  const { messageRange } = semanticRecall;
  if (positiveInteger(messageRange)) return messageRange;
  if (!isRecord(messageRange)) return undefined;
  const before = positiveInteger(messageRange.before);
  const after = positiveInteger(messageRange.after);
  if (before === undefined && after === undefined) return undefined;
  return {
    before: before ?? 1,
    after: after ?? 1,
  };
};

const combineFilters = (left: unknown, right: unknown) => {
  if (!left) return right;
  if (!right) return left;
  return { $and: [left, right] };
};

const workspaceFilter = (metadata: MemoryRecord | undefined) => {
  const projectId = optionalString(metadata?.projectId);
  const workspaceId = optionalString(metadata?.workspaceId);
  if (!projectId || !workspaceId) return undefined;
  return {
    $and: [
      { projectId: { $eq: projectId } },
      { workspaceId: { $eq: workspaceId } },
    ],
  };
};

export const resolveMemoryPolicy = ({
  agentMemory,
  threadMetadata,
  capabilities = getMemoryCapabilities(),
  tokenLimit = getContextTokenLimit(),
}: {
  agentMemory?: MemoryRecord;
  threadMetadata?: MemoryRecord;
  capabilities?: MemoryCapabilities;
  tokenLimit?: number;
}): ResolvedMemoryPolicy => {
  const base = isRecord(agentMemory) ? { ...agentMemory } : {};
  const semanticValue = Object.hasOwn(base, 'semanticRecall') ? base.semanticRecall : true;
  delete base.lastMessages;
  delete base.semanticRecall;
  delete base.observationalMemory;

  const semanticRequested = semanticValue !== false;
  const aliasScope = getSemanticScope(semanticValue) ?? 'workspace';
  let semanticStatus: ResolvedMemoryPolicy['status']['semanticRecall'] = {
    enabled: false,
    configured: capabilities.semanticRecall,
    requested: semanticRequested,
    aliasScope,
    reason: semanticRequested
      ? capabilities.semanticRecallUnavailableReason ?? 'semantic recall embedding model is not configured'
      : 'semantic recall disabled by agent config',
  };

  if (semanticRequested && capabilities.semanticRecall) {
    const workspaceScopedFilter = aliasScope === 'workspace' ? workspaceFilter(threadMetadata) : undefined;
    const scope = aliasScope === 'resource' || workspaceScopedFilter ? 'resource' : 'thread';
    const semanticConfig: MemoryRecord = { scope };
    const topK = getSemanticTopK(semanticValue);
    const messageRange = getSemanticMessageRange(semanticValue);
    const configuredFilter = isRecord(semanticValue) ? semanticValue.filter : undefined;
    const filter = scope === 'resource' ? combineFilters(configuredFilter, workspaceScopedFilter) : configuredFilter;

    if (topK !== undefined) semanticConfig.topK = topK;
    if (messageRange !== undefined) semanticConfig.messageRange = messageRange;
    if (filter !== undefined) semanticConfig.filter = filter;
    base.semanticRecall = semanticConfig;
    semanticStatus = {
      enabled: true,
      configured: true,
      requested: true,
      scope,
      aliasScope,
      ...(aliasScope === 'workspace' && !workspaceScopedFilter
        ? { reason: 'workspace metadata unavailable; using thread scope' }
        : {}),
    };
  }

  const observationalMemoryConfig = resolveObservationalMemoryConfig(capabilities);
  if (observationalMemoryConfig) {
    base.observationalMemory = observationalMemoryConfig;
  }

  return {
    options: base,
    status: {
      semanticRecall: semanticStatus,
      observationalMemory: capabilities.observationalMemory
        ? observationalMemoryConfig ? { enabled: true, configured: true } : {
          enabled: false,
          configured: false,
          reason: 'observational memory model is not configured',
        }
        : {
          enabled: false,
          configured: false,
          reason: 'observational memory disabled by env',
        },
      tokenLimit,
    },
  };
};
