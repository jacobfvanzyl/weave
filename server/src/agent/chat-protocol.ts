import {
  type ChatThread,
  chatThreadSchema,
  type JsonValue,
  jsonValueSchema,
  type WeaveChatChunk,
  weaveChatChunkSchema,
  type WeaveChatMessage,
  weaveChatMessageSchema,
  type WeaveMessagePart,
  weaveMessagePartSchema,
} from '@weave/protocol';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const sanitizeJson = (value: unknown, seen: Set<object>): JsonValue | undefined => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof URL) return value.toString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(value.cause === undefined ? {} : { cause: sanitizeJson(value.cause, seen) ?? String(value.cause) }),
    };
  }
  if (typeof value !== 'object' || value === null || seen.has(value)) return undefined;

  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => sanitizeJson(item, seen) ?? null);
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      const normalized = sanitizeJson(item, seen);
      if (normalized !== undefined) result[key] = normalized;
    }
    return result;
  } finally {
    seen.delete(value);
  }
};

export const toJsonValue = (value: unknown, fallback: JsonValue = null): JsonValue => {
  const normalized = sanitizeJson(value, new Set());
  return normalized !== undefined && jsonValueSchema.safeParse(normalized).success ? normalized : fallback;
};

export const normalizeWeaveChatThread = (value: unknown): ChatThread => {
  const safeValue = toJsonValue(value, {});
  const record = isRecord(safeValue) ? safeValue : {};
  return chatThreadSchema.parse({
    id: record.id,
    ...(typeof record.title === 'string' ? { title: record.title } : {}),
    resourceId: record.resourceId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(isRecord(record.metadata) ? { metadata: record.metadata } : {}),
  });
};

const stringValue = (value: unknown) => typeof value === 'string' ? value : undefined;
const errorText = (value: unknown, fallback: string) =>
  stringValue(value) ?? (isRecord(value) ? stringValue(value.message) : undefined) ?? fallback;
const pick = (record: Record<string, unknown>, keys: readonly string[]) =>
  Object.fromEntries(
    keys.flatMap((key) => record[key] === undefined ? [] : [[key, record[key]]]),
  );

const chunkKeys: Record<string, readonly string[]> = {
  'text-start': ['type', 'id', 'providerMetadata'],
  'text-delta': ['type', 'id', 'delta', 'providerMetadata'],
  'text-end': ['type', 'id', 'providerMetadata'],
  'reasoning-start': ['type', 'id', 'providerMetadata'],
  'reasoning-delta': ['type', 'id', 'delta', 'providerMetadata'],
  'reasoning-end': ['type', 'id', 'providerMetadata'],
  start: ['type', 'messageId', 'messageMetadata'],
  finish: ['type', 'finishReason', 'messageMetadata'],
  'start-step': ['type'],
  'finish-step': ['type'],
  abort: ['type', 'reason'],
  error: ['type', 'errorText'],
  'message-metadata': ['type', 'messageMetadata'],
  'tool-input-start': [
    'type',
    'toolCallId',
    'toolName',
    'providerExecuted',
    'providerMetadata',
    'toolMetadata',
    'dynamic',
    'title',
  ],
  'tool-input-delta': ['type', 'toolCallId', 'inputTextDelta'],
  'tool-input-available': [
    'type',
    'toolCallId',
    'toolName',
    'input',
    'providerExecuted',
    'providerMetadata',
    'toolMetadata',
    'dynamic',
    'title',
  ],
  'tool-input-error': [
    'type',
    'toolCallId',
    'toolName',
    'input',
    'errorText',
    'providerExecuted',
    'providerMetadata',
    'toolMetadata',
    'dynamic',
    'title',
  ],
  'tool-approval-request': ['type', 'approvalId', 'toolCallId', 'signature'],
  'tool-output-available': [
    'type',
    'toolCallId',
    'toolName',
    'output',
    'preliminary',
    'providerExecuted',
    'providerMetadata',
    'toolMetadata',
    'dynamic',
    'title',
  ],
  'tool-output-error': [
    'type',
    'toolCallId',
    'toolName',
    'errorText',
    'providerExecuted',
    'providerMetadata',
    'toolMetadata',
    'dynamic',
    'title',
  ],
  'tool-output-denied': ['type', 'toolCallId'],
  'source-url': ['type', 'sourceId', 'url', 'title', 'providerMetadata'],
  'source-document': ['type', 'sourceId', 'mediaType', 'title', 'filename', 'providerMetadata'],
  file: ['type', 'url', 'mediaType', 'providerMetadata'],
};

const normalizeKnownChunkShape = (record: Record<string, unknown>) => {
  let type = stringValue(record.type);
  if (type === 'step-start') type = 'start-step';
  if (type === 'step-finish') type = 'finish-step';
  if (type === 'tool-call') type = 'tool-input-available';
  if (type === 'tool-result') type = 'tool-output-available';
  if (!type) return undefined;

  const source: Record<string, unknown> = { ...record, type };
  if ((type === 'text-delta' || type === 'reasoning-delta') && source.delta === undefined) {
    source.delta = source.textDelta ?? source.reasoningDelta;
  }
  if (type === 'tool-input-available') {
    source.input ??= source.args ?? null;
  }
  if (type === 'tool-input-error') {
    source.input ??= source.args ?? null;
    source.errorText = errorText(source.errorText ?? source.error ?? source.message, 'Tool input failed.');
  }
  if (type === 'tool-output-available') source.output ??= source.result ?? null;
  if (type === 'tool-output-error') {
    source.errorText = errorText(source.errorText ?? source.error ?? source.message, 'Tool execution failed.');
  }
  if (type === 'tool-approval-request') source.approvalId ??= source.toolCallId;
  if (type === 'error') {
    source.errorText = errorText(
      source.errorText ?? source.error ?? source.message ?? source.reason,
      'Upstream stream error.',
    );
  }

  if (type.startsWith('data-')) {
    return pick(source, ['type', 'id', 'data', 'transient']);
  }
  const keys = chunkKeys[type];
  return keys ? pick(source, keys) : undefined;
};

export const normalizeWeaveChatChunk = (value: unknown): WeaveChatChunk => {
  const safeValue = toJsonValue(value, { type: 'unknown' });
  const safeRecord = isRecord(safeValue) ? safeValue : { value: safeValue };
  const direct = weaveChatChunkSchema.safeParse(safeRecord);
  if (direct.success) return direct.data;

  const known = normalizeKnownChunkShape(safeRecord);
  const parsed = weaveChatChunkSchema.safeParse(known);
  if (parsed.success) return parsed.data;

  return weaveChatChunkSchema.parse({
    type: 'data-upstream-unsupported',
    data: {
      upstreamType: stringValue(safeRecord.type) ?? 'unknown',
      payload: safeRecord,
      issues: parsed.success ? [] : parsed.error.issues.map((issue) => issue.message),
    },
  });
};

const normalizeMessagePart = (value: unknown): WeaveMessagePart => {
  const safeValue = toJsonValue(value, { type: 'unknown' });
  const direct = weaveMessagePartSchema.safeParse(safeValue);
  if (direct.success) return direct.data;

  const record = isRecord(safeValue) ? safeValue : { value: safeValue };
  const type = stringValue(record.type);
  if (type === 'text' || type === 'reasoning') {
    const parsed = weaveMessagePartSchema.safeParse({ type, text: stringValue(record.text) ?? '' });
    if (parsed.success) return parsed.data;
  }
  if (type === 'tool-call' || type === 'tool-result' || type === 'tool-invocation') {
    const invocation = isRecord(record.toolInvocation) ? record.toolInvocation : record;
    const toolName = stringValue(invocation.toolName) ?? 'tool';
    const result = invocation.result ?? invocation.output ?? record.result ?? record.output;
    const candidate = {
      type: `tool-${toolName}`,
      toolCallId: stringValue(invocation.toolCallId) ?? crypto.randomUUID(),
      state: result === undefined ? 'input-available' : 'output-available',
      input: invocation.args ?? invocation.input ?? record.args ?? record.input ?? null,
      ...(result === undefined ? {} : { output: result }),
    };
    const parsed = weaveMessagePartSchema.safeParse(candidate);
    if (parsed.success) return parsed.data;
  }

  return weaveMessagePartSchema.parse({
    type: 'data-upstream-unsupported',
    data: { upstreamType: type ?? 'unknown', payload: record },
  });
};

export const normalizeWeaveChatMessage = (
  value: unknown,
  fallbackId: string = crypto.randomUUID(),
): WeaveChatMessage => {
  const safeValue = toJsonValue(value, {});
  const record = isRecord(safeValue) ? safeValue : {};
  const role = record.role === 'system' || record.role === 'user' || record.role === 'assistant'
    ? record.role
    : 'assistant';
  const status = isRecord(record.status) && (record.status.type === 'running' || record.status.type === 'complete')
    ? {
      type: record.status.type,
      ...(typeof record.status.reason === 'string' ? { reason: record.status.reason } : {}),
    }
    : undefined;
  return weaveChatMessageSchema.parse({
    id: typeof record.id === 'string' && record.id ? record.id : fallbackId,
    role,
    parts: Array.isArray(record.parts) ? record.parts.map(normalizeMessagePart) : [],
    ...(record.metadata === undefined ? {} : { metadata: record.metadata }),
    ...(status ? { status } : {}),
  });
};

export const normalizeWeaveChatMessages = (values: readonly unknown[]): WeaveChatMessage[] =>
  values.map((value, index) => normalizeWeaveChatMessage(value, `message-${index + 1}`));
