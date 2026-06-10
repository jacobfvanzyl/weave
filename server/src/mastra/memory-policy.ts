type MemoryRecord = Record<string, unknown>;

export type WeaveSemanticRecallScope = 'thread' | 'resource' | 'workspace';

export type MemoryCapabilities = {
  semanticRecall: boolean;
  observationalMemory: boolean;
  observationalMemoryModel?: string;
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

const isRecord = (value: unknown): value is MemoryRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const optionalString = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;

const positiveInteger = (value: unknown) => {
  const number = typeof value === 'string' ? Number(value) : value;
  return typeof number === 'number' && Number.isInteger(number) && number > 0 ? number : undefined;
};

export const getContextTokenLimit = (env: NodeJS.ProcessEnv = process.env) =>
  positiveInteger(env.WEAVE_CONTEXT_TOKEN_LIMIT) ?? defaultContextTokenLimit;

export const getMemoryCapabilities = (env: NodeJS.ProcessEnv = process.env): MemoryCapabilities => {
  const observationalMemoryRequested = env.WEAVE_OBSERVATIONAL_MEMORY === '1';
  const observationalMemoryModel = optionalString(env.WEAVE_OBSERVATIONAL_MEMORY_MODEL);

  return {
    semanticRecall: Boolean(optionalString(env.WEAVE_MEMORY_EMBEDDING_MODEL)),
    observationalMemory: observationalMemoryRequested && Boolean(observationalMemoryModel),
    ...(observationalMemoryModel ? { observationalMemoryModel } : {}),
  };
};

const getSemanticScope = (semanticRecall: unknown): WeaveSemanticRecallScope | undefined => {
  if (!isRecord(semanticRecall)) return undefined;
  return semanticRecall.scope === 'thread' || semanticRecall.scope === 'resource' || semanticRecall.scope === 'workspace'
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
  profileMemory,
  threadMetadata,
  capabilities = getMemoryCapabilities(),
  tokenLimit = getContextTokenLimit(),
}: {
  profileMemory?: MemoryRecord;
  threadMetadata?: MemoryRecord;
  capabilities?: MemoryCapabilities;
  tokenLimit?: number;
}): ResolvedMemoryPolicy => {
  const base = isRecord(profileMemory) ? { ...profileMemory } : {};
  const semanticValue = Object.hasOwn(base, 'semanticRecall') ? base.semanticRecall : true;
  delete base.semanticRecall;
  delete base.observationalMemory;

  const semanticRequested = semanticValue !== false;
  const aliasScope = getSemanticScope(semanticValue) ?? 'workspace';
  let semanticStatus: ResolvedMemoryPolicy['status']['semanticRecall'] = {
    enabled: false,
    configured: capabilities.semanticRecall,
    requested: semanticRequested,
    aliasScope,
    reason: semanticRequested ? 'semantic recall env is not configured' : 'semantic recall disabled by profile',
  };

  if (semanticRequested && capabilities.semanticRecall) {
    const workspaceScopedFilter = aliasScope === 'workspace' ? workspaceFilter(threadMetadata) : undefined;
    const scope = aliasScope === 'resource' || workspaceScopedFilter ? 'resource' : 'thread';
    const semanticConfig: MemoryRecord = { scope };
    const topK = getSemanticTopK(semanticValue);
    const messageRange = getSemanticMessageRange(semanticValue);
    const configuredFilter = isRecord(semanticValue) ? semanticValue.filter : undefined;
    const filter = scope === 'resource'
      ? combineFilters(configuredFilter, workspaceScopedFilter)
      : configuredFilter;

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

  if (capabilities.observationalMemory && capabilities.observationalMemoryModel) {
    base.observationalMemory = {
      model: capabilities.observationalMemoryModel,
      scope: 'thread',
      activateAfterIdle: '5m',
      activateOnProviderChange: true,
      temporalMarkers: true,
    };
  }

  return {
    options: base,
    status: {
      semanticRecall: semanticStatus,
      observationalMemory: capabilities.observationalMemory
        ? { enabled: true, configured: true }
        : {
            enabled: false,
            configured: false,
            reason: 'observational memory env is not configured',
          },
      tokenLimit,
    },
  };
};
