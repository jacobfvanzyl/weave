import { handleChatStream } from '@mastra/ai-sdk';
import type { AgentMessageInput } from '@mastra/core/agent';
import { MASTRA_RESOURCE_ID_KEY } from '@mastra/core/request-context';
import { defineRoute } from '../../../server/routes';
import { attachmentIdFromReference, attachmentModelUrl, attachmentStorage, parseBase64DataUrl, type AttachmentStorage, type StoredAttachmentMetadata } from '../../attachments/storage';
import {
  buildChatSystemMessages,
  listResolvedProfileSkillSummaries,
  putChatRuntimeContext,
  putProfileContext,
  resolveMemoryPolicy,
  resolveProfileContext,
  subscribeThreadContextUsage,
  type ThreadContextUsageSnapshot,
} from '../../../agent/runtime';
import { normalizeOpenAIReasoningEffort, normalizeOpenAIServiceTier } from '../../../agent/model-capabilities';
import {
  estimateJsonByteLength,
  getDenoRuntimeMemorySnapshot,
  isServerPerfEnabled,
  logServerPerfEvent,
  memoryDelta,
} from '../../../server/perf';

const agentId = 'mage-hand';
const mastraAgentName = 'mageHandAgent';
const maxImageAttachmentBytes = 10 * 1024 * 1024;
const activeThreadRunCleanupDelayMs = 5 * 60 * 1000;
const sseKeepAliveIntervalMs = 15_000;

const markGitWorkspaceContext = (requestContext: any, value: boolean) => {
  requestContext?.set?.('gitWorkspace', value);
};

const markGitProjectContext = (requestContext: any, value: boolean) => {
  requestContext?.set?.('gitProject', value);
};

const routeSubscriptionModel = (model: unknown) => {
  if (typeof model !== 'string') return model;
  if (!model.startsWith('openai/')) return model;

  return `chatgpt/codex/${model.slice('openai/'.length)}`;
};

const hasOwn = (value: unknown, key: string) =>
  Boolean(value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key));

const buildProviderOptions = (
  providerOptions: unknown,
  options: { reasoningEffort?: string; serviceTier?: string; threadId?: unknown; resourceId?: string },
) => {
  const base = providerOptions && typeof providerOptions === 'object'
    ? providerOptions as Record<string, unknown>
    : {};
  const openai = base.openai && typeof base.openai === 'object'
    ? base.openai as Record<string, unknown>
    : {};
  const openaiPatch = {
    ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
    ...(options.serviceTier ? { serviceTier: options.serviceTier } : {}),
  };
  const hasOpenAIPatch = Object.keys(openaiPatch).length > 0;

  return {
    ...base,
    ...(hasOpenAIPatch
      ? {
          openai: {
            ...openai,
            ...openaiPatch,
          },
        }
      : {}),
    ...(typeof options.threadId === 'string'
      ? {
          mastraContextUsage: {
            threadId: options.threadId,
            ...(options.resourceId ? { resourceId: options.resourceId } : {}),
          },
        }
      : {}),
  };
};

const bufferedAssistantTextMaxChars = 24_000;
const bufferedAssistantTextFlushDelayMs = 80;
const bufferedAssistantTextImmediateMinChars = 32;
const bufferedAssistantTextSoftMaxChars = 900;
const bufferedAssistantTextTypes = new Set(['text-delta', 'reasoning-delta']);
const bufferedAssistantEndTypes: Record<string, string> = {
  'text-end': 'text',
  'reasoning-end': 'reasoning',
};

type BufferedAssistantTextChunk = {
  type: 'text-delta' | 'reasoning-delta';
  id: string;
  delta: string;
} & Record<string, unknown>;

type BufferedAssistantTextState = {
  chunk: BufferedAssistantTextChunk;
  text: string;
  emittedLength: number;
  timer: ReturnType<typeof setTimeout> | undefined;
};

const getStreamChunkType = (chunk: unknown) =>
  chunk && typeof chunk === 'object' && typeof (chunk as Record<string, unknown>).type === 'string'
    ? (chunk as Record<string, unknown>).type as string
    : undefined;

const retainUserMessageDataChunk = (chunk: unknown) =>
  chunk && typeof chunk === 'object' && !Array.isArray(chunk)
    ? { ...(chunk as Record<string, unknown>), transient: false }
    : chunk;

const getStreamChunkError = (chunk: unknown) => {
  if (getStreamChunkType(chunk) !== 'error') return undefined;
  const record = chunk && typeof chunk === 'object' ? chunk as Record<string, unknown> : {};
  const direct = record.error;
  if (direct instanceof Error) return direct;
  if (typeof direct === 'string' && direct.trim()) return new Error(direct);

  for (const key of ['errorText', 'message', 'reason']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return new Error(value);
  }

  return new Error('Thread run stream emitted an error.');
};

const getStreamChunkId = (chunk: unknown) =>
  chunk && typeof chunk === 'object' && typeof (chunk as Record<string, unknown>).id === 'string'
    ? (chunk as Record<string, unknown>).id as string
    : undefined;

const getBufferedTextKey = (kind: string, id: string) => `${kind}:${id}`;

const isBufferedAssistantTextChunk = (
  chunk: unknown,
): chunk is BufferedAssistantTextChunk => {
  const record = chunk && typeof chunk === 'object' ? chunk as Record<string, unknown> : undefined;
  return Boolean(
    record &&
    typeof record.type === 'string' &&
    bufferedAssistantTextTypes.has(record.type) &&
    typeof record.id === 'string' &&
    typeof record.delta === 'string',
  );
};

const hasUnclosedInlineCode = (text: string) => {
  let openRunLength: number | undefined;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (char !== '`') continue;

    let runLength = 1;
    while (text[index + runLength] === '`') runLength += 1;

    if (openRunLength === undefined) openRunLength = runLength;
    else if (openRunLength === runLength) openRunLength = undefined;

    index += runLength - 1;
  }

  return openRunLength !== undefined;
};

const hasIncompleteMarkdownLinkTail = (text: string) => {
  const tail = text.slice(-240);
  return (
    /!?\[[^\]\n]*$/.test(tail) ||
    /!?\[[^\]\n]*\]$/.test(tail) ||
    /!?\[[^\]\n]*\]\([^\)\n]*$/.test(tail) ||
    /<https?:\/\/[^>\s]*$/i.test(tail)
  );
};

const getMarkdownTailState = (text: string) => {
  let inFence = false;
  let fenceChar = '';
  let fenceLength = 0;
  let outsideFenceText = '';
  const lines = text.match(/[^\n]*(?:\n|$)/g) ?? [];

  for (const rawLine of lines) {
    if (!rawLine) continue;

    const line = rawLine.replace(/\r?\n$/, '');
    const fenceMatch = /^(?: {0,3})(`{3,}|~{3,})/.exec(line);

    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!inFence) {
        inFence = true;
        fenceChar = marker[0];
        fenceLength = marker.length;
      } else if (marker[0] === fenceChar && marker.length >= fenceLength) {
        inFence = false;
      }
      continue;
    }

    if (!inFence) outsideFenceText += rawLine;
  }

  return {
    inFence,
    inlineCodeOpen: hasUnclosedInlineCode(outsideFenceText),
    linkOpen: hasIncompleteMarkdownLinkTail(outsideFenceText),
  };
};

const isMarkdownFlushSafe = (text: string, index: number) => {
  const prefix = text.slice(0, index);
  const state = getMarkdownTailState(prefix);

  if (state.inFence) return prefix.endsWith('\n');
  return !state.inlineCodeOpen && !state.linkOpen;
};

const collectMarkdownFlushCandidates = (text: string, emittedLength: number, includeWordBoundary: boolean) => {
  const candidates = new Set<number>();

  for (let index = emittedLength + 1; index <= text.length; index += 1) {
    const previous = text[index - 1];
    const current = text[index] ?? '';

    if (previous === '\n') {
      candidates.add(index);
      continue;
    }

    if (/[.!?]/.test(previous) && (index === text.length || /[\s"')\]]/.test(current))) {
      let boundary = index;
      while (boundary < text.length && /\s/.test(text[boundary])) boundary += 1;
      candidates.add(boundary);
      continue;
    }

    if (includeWordBoundary && /\s/.test(previous)) candidates.add(index);
  }

  if (includeWordBoundary && text.length - emittedLength >= bufferedAssistantTextSoftMaxChars) {
    candidates.add(text.length);
  }

  return [...candidates].sort((left, right) => right - left);
};

const findMarkdownFlushIndex = (
  text: string,
  emittedLength: number,
  options: { force?: boolean; includeWordBoundary?: boolean; minChars?: number } = {},
) => {
  const pendingLength = text.length - emittedLength;
  if (pendingLength <= 0) return emittedLength;
  if (options.force || pendingLength >= bufferedAssistantTextMaxChars) return text.length;

  const minFlushIndex = emittedLength + (options.minChars ?? 1);
  const candidates = collectMarkdownFlushCandidates(text, emittedLength, options.includeWordBoundary ?? false);

  for (const candidate of candidates) {
    if (candidate < minFlushIndex) continue;
    if (isMarkdownFlushSafe(text, candidate)) return candidate;
  }

  return emittedLength;
};

const bufferAssistantTextStream = (stream: ReadableStream<unknown>) => new ReadableStream<unknown>({
  async start(controller) {
    const reader = stream.getReader();
    const bufferedText = new Map<string, BufferedAssistantTextState>();
    let isActive = true;

    const clearFlushTimer = (state: BufferedAssistantTextState) => {
      if (!state.timer) return;
      clearTimeout(state.timer);
      state.timer = undefined;
    };

    const flushKey = (
      key: string,
      options: { force?: boolean; includeWordBoundary?: boolean; minChars?: number; removeWhenEmpty?: boolean } = {},
    ) => {
      const state = bufferedText.get(key);
      if (!state) return false;

      const flushIndex = findMarkdownFlushIndex(state.text, state.emittedLength, options);
      if (flushIndex <= state.emittedLength) return false;

      const delta = state.text.slice(state.emittedLength, flushIndex);
      state.emittedLength = flushIndex;
      controller.enqueue({ ...state.chunk, delta });

      if (state.emittedLength >= state.text.length && options.removeWhenEmpty !== false) {
        clearFlushTimer(state);
        bufferedText.delete(key);
      }

      return true;
    };

    const scheduleFlush = (key: string) => {
      const state = bufferedText.get(key);
      if (!state || state.timer) return;

      state.timer = setTimeout(() => {
        state.timer = undefined;
        if (!isActive) return;

        flushKey(key, { includeWordBoundary: true });
      }, bufferedAssistantTextFlushDelayMs);
    };

    const flushAll = () => {
      for (const key of [...bufferedText.keys()]) flushKey(key, { force: true });
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        if (isBufferedAssistantTextChunk(value)) {
          const key = getBufferedTextKey(value.type === 'text-delta' ? 'text' : 'reasoning', value.id);
          const state = bufferedText.get(key) ?? { chunk: value, text: '', emittedLength: 0, timer: undefined };
          state.chunk = value;
          state.text += value.delta;
          bufferedText.set(key, state);

          flushKey(key, { minChars: bufferedAssistantTextImmediateMinChars, removeWhenEmpty: false });

          if (state.emittedLength < state.text.length) {
            scheduleFlush(key);
          }
          continue;
        }

        const type = getStreamChunkType(value);
        if (type === 'data-user-message' || type === 'start') flushAll();
        const endKind = type ? bufferedAssistantEndTypes[type] : undefined;
        const id = getStreamChunkId(value);
        if (endKind && id) flushKey(getBufferedTextKey(endKind, id), { force: true });
        if (type === 'finish') flushAll();

        controller.enqueue(type === 'data-user-message' ? retainUserMessageDataChunk(value) : value);
      }

      flushAll();
      controller.close();
    } catch (error) {
      controller.error(error);
    } finally {
      isActive = false;
      for (const state of bufferedText.values()) clearFlushTimer(state);
      reader.releaseLock();
    }
  },
  cancel(reason) {
    return stream.cancel(reason).catch(() => undefined);
  },
});

const toSseResponse = (stream: ReadableStream<unknown>) => {
  const reader = stream.getReader();
  let keepAliveTimer: ReturnType<typeof setInterval> | undefined;

  const clearKeepAliveTimer = () => {
    if (!keepAliveTimer) return;
    clearInterval(keepAliveTimer);
    keepAliveTimer = undefined;
  };

  const sseStream = new ReadableStream<string>({
    async start(controller) {
      keepAliveTimer = setInterval(() => {
        controller.enqueue(': keep-alive\n\n');
      }, sseKeepAliveIntervalMs);

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(`data: ${JSON.stringify(value)}\n\n`);
        }

        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        clearKeepAliveTimer();
        reader.releaseLock();
      }
    },
    cancel(reason) {
      clearKeepAliveTimer();
      return reader.cancel(reason).catch(() => undefined);
    },
  });

  return new Response(sseStream.pipeThrough(new TextEncoderStream()), {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-vercel-ai-ui-message-stream': 'v1',
      'x-accel-buffering': 'no',
    },
  });
};

type ActiveThreadRunStatus = 'running' | 'cancelling' | 'completed' | 'cancelled' | 'error';

type ActiveThreadRunEvent =
  | { type: 'chunk'; chunk: unknown }
  | { type: 'close' }
  | { type: 'error'; error: unknown };

type ActiveThreadRunListener = (event: ActiveThreadRunEvent) => void;

type ActiveThreadRun = {
  key: string;
  resourceId: string;
  threadId: string;
  runId: string;
  status: ActiveThreadRunStatus;
  startedAt: string;
  updatedAt: string;
  controller: AbortController;
  chunks: unknown[];
  submittedUserMessages: unknown[];
  listeners: Set<ActiveThreadRunListener>;
  contextUsageUnsubscribe?: () => void;
  cleanupTimer?: ReturnType<typeof setTimeout>;
  terminalChunkType?: string;
  error?: string;
  perf?: ChatRunPerf;
};

type RunUiMessage = {
  id: string;
  role: 'assistant' | 'user';
  parts: Array<Record<string, unknown>>;
  status?: { type: 'running' | 'complete'; reason?: string };
  metadata?: unknown;
};

type RunTimingStatus = 'running' | 'completed' | 'cancelled' | 'error';

type PendingToolInput = {
  text: string;
  toolName: string;
  dynamic?: boolean;
  title?: string;
  toolMetadata?: unknown;
};

const activeThreadRuns = new Map<string, ActiveThreadRun>();
const activeThreadRunStatuses = new Set<ActiveThreadRunStatus>(['running', 'cancelling']);

type ChatRunPerf = {
  startedAtMs: number;
  memoryBefore: ReturnType<typeof getDenoRuntimeMemorySnapshot>;
  firstChunkAtMs?: number;
  chunkCount: number;
  chunkBytes: number;
  textDeltaChars: number;
  reasoningDeltaChars: number;
  toolChunkCount: number;
  errorChunkCount: number;
  chunkTypes: Record<string, number>;
};

const createChatRunPerf = (): ChatRunPerf | undefined =>
  isServerPerfEnabled()
    ? {
        startedAtMs: Date.now(),
        memoryBefore: getDenoRuntimeMemorySnapshot(),
        chunkCount: 0,
        chunkBytes: 0,
        textDeltaChars: 0,
        reasoningDeltaChars: 0,
        toolChunkCount: 0,
        errorChunkCount: 0,
        chunkTypes: {},
      }
    : undefined;

const recordChatRunPerfChunk = (run: ActiveThreadRun, chunk: unknown, type: string | undefined) => {
  const perf = run.perf;
  if (!perf) return;
  const now = Date.now();
  perf.firstChunkAtMs ??= now;
  perf.chunkCount += 1;
  const bytes = estimateJsonByteLength(chunk);
  if (typeof bytes === 'number') perf.chunkBytes += bytes;
  const chunkType = type ?? 'unknown';
  perf.chunkTypes[chunkType] = (perf.chunkTypes[chunkType] ?? 0) + 1;
  if (chunk && typeof chunk === 'object') {
    const record = chunk as Record<string, unknown>;
    if (type === 'text-delta' && typeof record.delta === 'string') perf.textDeltaChars += record.delta.length;
    if (type === 'reasoning-delta' && typeof record.delta === 'string') perf.reasoningDeltaChars += record.delta.length;
  }
  if (chunkType.includes('tool')) perf.toolChunkCount += 1;
  if (chunkType === 'error') perf.errorChunkCount += 1;
};

export const getChatPerfSnapshot = () => {
  const runs = [...activeThreadRuns.values()];
  const statuses: Partial<Record<ActiveThreadRunStatus, number>> = {};
  let listenerCount = 0;
  let retainedChunkCount = 0;
  let perfTrackedChunkBytes = 0;
  let runningOldestAgeMs: number | undefined;

  for (const run of runs) {
    statuses[run.status] = (statuses[run.status] ?? 0) + 1;
    listenerCount += run.listeners.size;
    retainedChunkCount += run.chunks.length;
    perfTrackedChunkBytes += run.perf?.chunkBytes ?? 0;
    if (activeThreadRunStatuses.has(run.status)) {
      const startedAt = Date.parse(run.startedAt);
      if (Number.isFinite(startedAt)) {
        const ageMs = Date.now() - startedAt;
        runningOldestAgeMs = runningOldestAgeMs === undefined ? ageMs : Math.max(runningOldestAgeMs, ageMs);
      }
    }
  }

  return {
    activeThreadRunCount: runs.filter(run => activeThreadRunStatuses.has(run.status)).length,
    retainedThreadRunCount: runs.length,
    listenerCount,
    retainedChunkCount,
    perfTrackedChunkBytes,
    runningOldestAgeMs,
    statuses,
  };
};

const logChatRunPerfSummary = (
  run: ActiveThreadRun,
  status: Exclude<ActiveThreadRunStatus, 'running' | 'cancelling'>,
) => {
  const perf = run.perf;
  if (!perf) return;
  const memoryAfter = getDenoRuntimeMemorySnapshot();
  logServerPerfEvent('chat_run_summary', {
    runId: run.runId,
    threadId: run.threadId,
    resourceId: run.resourceId,
    status,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    durationMs: Date.now() - perf.startedAtMs,
    timeToFirstChunkMs: perf.firstChunkAtMs === undefined ? undefined : perf.firstChunkAtMs - perf.startedAtMs,
    chunkCount: perf.chunkCount,
    chunkBytes: perf.chunkBytes,
    chunkTypes: perf.chunkTypes,
    textDeltaChars: perf.textDeltaChars,
    reasoningDeltaChars: perf.reasoningDeltaChars,
    toolChunkCount: perf.toolChunkCount,
    errorChunkCount: perf.errorChunkCount,
    listenerCount: run.listeners.size,
    retainedChunkCount: run.chunks.length,
    submittedUserMessageCount: run.submittedUserMessages.length,
    terminalChunkType: run.terminalChunkType,
    error: run.error,
    memoryBefore: perf.memoryBefore,
    memoryAfter,
    memoryDelta: memoryDelta(perf.memoryBefore, memoryAfter),
    registry: getChatPerfSnapshot(),
  });
};

const getResourceId = (c: any) => {
  const resourceId = c.get('requestContext')?.get(MASTRA_RESOURCE_ID_KEY);
  if (typeof resourceId !== 'string' || !resourceId) throw new Error('Authenticated resource missing');
  return resourceId;
};

const threadRunKey = (resourceId: string, threadId: string) => `${resourceId}\0${threadId}`;

const isActiveThreadRun = (run: ActiveThreadRun | undefined) =>
  Boolean(run && activeThreadRunStatuses.has(run.status));

const getThreadRun = (resourceId: string | undefined, threadId: string | undefined) => {
  if (!resourceId || !threadId) return undefined;
  return activeThreadRuns.get(threadRunKey(resourceId, threadId));
};

const getActiveThreadRun = (resourceId: string | undefined, threadId: string | undefined) => {
  const run = getThreadRun(resourceId, threadId);
  return isActiveThreadRun(run) ? run : undefined;
};

export const hasActiveThreadRun = (resourceId: string | undefined, threadId: string | undefined) =>
  Boolean(getActiveThreadRun(resourceId, threadId));

const toThreadRunSnapshot = (run: ActiveThreadRun | undefined) => ({
  active: isActiveThreadRun(run),
  status: run?.status ?? 'idle',
  ...(run
    ? {
        runId: run.runId,
        startedAt: run.startedAt,
        updatedAt: run.updatedAt,
        durationMs: getRunDurationMs(run, isActiveThreadRun(run) ? Date.now() : Date.parse(run.updatedAt)),
        ...(run.error ? { error: run.error } : {}),
      }
    : {}),
});

const getRunDurationMs = (run: Pick<ActiveThreadRun, 'startedAt'>, endMs = Date.now()) => {
  const startedAtMs = Date.parse(run.startedAt);
  if (!Number.isFinite(startedAtMs)) return undefined;
  return Math.max(0, (Number.isFinite(endMs) ? endMs : Date.now()) - startedAtMs);
};

const buildRunTimingMetadata = (
  run: ActiveThreadRun,
  status: RunTimingStatus,
  now = new Date(),
) => {
  const nowIso = now.toISOString();
  const startedAtMs = Date.parse(run.startedAt);
  const nowMs = now.getTime();
  const durationMs = Number.isFinite(startedAtMs) ? Math.max(0, nowMs - startedAtMs) : undefined;

  return {
    weaveRunTiming: {
      runId: run.runId,
      status,
      startedAt: run.startedAt,
      ...(status !== 'running' ? { completedAt: nowIso } : {}),
      ...(status !== 'running' && durationMs !== undefined ? { durationMs } : {}),
    },
  };
};

const toContextUsageChunk = (snapshot: ThreadContextUsageSnapshot) => ({
  type: 'data-context-usage' as const,
  transient: true,
  data: {
    tokens: snapshot.usedTokens,
    inputTokens: snapshot.inputTokens,
    cachedInputTokens: snapshot.cachedInputTokens,
    outputTokens: snapshot.outputTokens,
    totalProcessedTokens: snapshot.totalProcessedTokens,
    updatedAt: snapshot.updatedAt,
    source: snapshot.source,
  },
});

const scheduleThreadRunCleanup = (run: ActiveThreadRun) => {
  if (run.cleanupTimer) clearTimeout(run.cleanupTimer);
  run.cleanupTimer = setTimeout(() => {
    if (activeThreadRuns.get(run.key) === run) activeThreadRuns.delete(run.key);
  }, activeThreadRunCleanupDelayMs);
};

const getSubmittedUserMessages = (messages: unknown) => {
  if (!Array.isArray(messages)) return [];

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as Record<string, unknown> | undefined;
    if (message && typeof message === 'object' && message.role === 'user') return [message];
  }

  return [];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const mergeRunMessageMetadata = (current: unknown, next: unknown) => {
  if (next === undefined || next === null) return current;
  if (isRecord(current) && isRecord(next)) return { ...current, ...next };
  return next;
};

const parsePartialJson = (value: string) => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
};

const findRunToolPart = (message: RunUiMessage, toolCallId: string) =>
  message.parts.find(part => part.toolCallId === toolCallId && (
    part.type === 'dynamic-tool' ||
    (typeof part.type === 'string' && part.type.startsWith('tool-'))
  ));

const upsertRunToolPart = (
  message: RunUiMessage,
  options: {
    toolCallId: string;
    toolName: string;
    state: string;
    input?: unknown;
    output?: unknown;
    rawInput?: unknown;
    errorText?: unknown;
    dynamic?: boolean;
    providerExecuted?: unknown;
    preliminary?: unknown;
    title?: unknown;
    toolMetadata?: unknown;
    providerMetadata?: unknown;
  },
) => {
  const part = findRunToolPart(message, options.toolCallId);
  const nextType = options.dynamic ? 'dynamic-tool' : `tool-${options.toolName}`;
  const target = part ?? {
    type: nextType,
    toolCallId: options.toolCallId,
    ...(options.dynamic ? { toolName: options.toolName } : {}),
  };

  target.state = options.state;
  if (options.input !== undefined) target.input = options.input;
  if (options.output !== undefined) target.output = options.output;
  if (options.rawInput !== undefined) target.rawInput = options.rawInput;
  if (options.errorText !== undefined) target.errorText = options.errorText;
  if (options.providerExecuted !== undefined) target.providerExecuted = options.providerExecuted;
  if (options.preliminary !== undefined) target.preliminary = options.preliminary;
  if (options.title !== undefined) target.title = options.title;
  if (options.toolMetadata !== undefined) target.toolMetadata = options.toolMetadata;
  if (options.providerMetadata !== undefined) {
    if (options.state === 'output-available' || options.state === 'output-error') {
      target.resultProviderMetadata = options.providerMetadata;
    } else {
      target.callProviderMetadata = options.providerMetadata;
    }
  }

  if (!part) message.parts.push(target);
  return target;
};

const runSignalContentsToUiParts = (contents: unknown): Array<Record<string, unknown>> => {
  if (typeof contents === 'string') return contents.length > 0 ? [{ type: 'text', text: contents }] : [];
  if (!Array.isArray(contents)) return [];

  return contents.flatMap((part): Array<Record<string, unknown>> => {
    if (!part || typeof part !== 'object') return [];
    const record = part as Record<string, unknown>;
    if (record.type === 'text' && typeof record.text === 'string') return [{ type: 'text', text: record.text }];

    if (record.type === 'file') {
      const mediaType = typeof record.mediaType === 'string'
        ? record.mediaType
        : typeof record.mimeType === 'string'
        ? record.mimeType
        : undefined;
      const url = typeof record.url === 'string'
        ? record.url
        : typeof record.data === 'string'
        ? record.data
        : record.data instanceof URL
        ? record.data.toString()
        : undefined;
      if (!url || !mediaType?.startsWith('image/')) return [];

      return [{
        type: 'file',
        url,
        mediaType,
        ...(typeof record.filename === 'string' ? { filename: record.filename } : {}),
        ...(record.providerMetadata !== undefined ? { providerMetadata: record.providerMetadata } : {}),
      }];
    }

    return [];
  });
};

const buildRunUserMessageFromSignalChunk = (chunk: Record<string, unknown>, fallbackId: string): RunUiMessage | undefined => {
  const data = chunk.data && typeof chunk.data === 'object' ? chunk.data as Record<string, unknown> : undefined;
  if (!data) return undefined;

  const parts = runSignalContentsToUiParts(data.contents);
  if (parts.length === 0) return undefined;
  const metadata = isRecord(data.metadata) ? data.metadata : undefined;
  const originalText = typeof metadata?.slashCommandOriginalText === 'string'
    ? metadata.slashCommandOriginalText
    : undefined;
  const attachmentParts = parts.filter(part => part.type === 'file');

  return {
    id: typeof data.id === 'string' && data.id.trim() ? data.id : fallbackId,
    role: 'user',
    parts: originalText ? [{ type: 'text', text: originalText }, ...attachmentParts] : parts,
    ...(data.metadata !== undefined ? { metadata: data.metadata } : {}),
  };
};

const filterRunMessageParts = (message: RunUiMessage) =>
  message.parts.filter(part => {
    if (part.type === 'reasoning') return typeof part.text === 'string' && part.text.trim().length > 0;
    if (part.type === 'text') return typeof part.text === 'string' && part.text.length > 0;
    return true;
  });

const buildRunUiMessagesFromChunks = (run: ActiveThreadRun): RunUiMessage[] => {
  const messages: RunUiMessage[] = [];
  let message: RunUiMessage | undefined;
  let activeTextParts: Record<string, Record<string, unknown>> = {};
  let activeReasoningParts: Record<string, Record<string, unknown>> = {};
  let partialToolInputs: Record<string, PendingToolInput> = {};

  const defaultAssistantStatus = (): RunUiMessage['status'] =>
    activeThreadRunStatuses.has(run.status)
      ? { type: 'running' }
      : { type: 'complete', ...(run.status === 'cancelled' ? { reason: 'stop' } : {}) };

  const getAssistantMessage = () => {
    if (!message) {
      message = {
        id: `${run.runId}-${messages.length}`,
        role: 'assistant',
        parts: [],
        status: defaultAssistantStatus(),
      };
    }
    return message;
  };

  const closeAssistantMessage = (status: RunUiMessage['status'] = { type: 'complete' }) => {
    if (!message) return;

    message.parts = filterRunMessageParts(message);
    if (message.parts.length > 0) {
      message.status = status;
      messages.push(message);
    }

    message = undefined;
    activeTextParts = {};
    activeReasoningParts = {};
    partialToolInputs = {};
  };

  for (const chunk of run.chunks) {
    if (!isRecord(chunk) || typeof chunk.type !== 'string') continue;

    switch (chunk.type) {
      case 'start': {
        if (message?.parts.length) closeAssistantMessage({ type: 'complete' });
        const assistantMessage = getAssistantMessage();
        if (typeof chunk.messageId === 'string' && chunk.messageId.trim()) assistantMessage.id = chunk.messageId;
        assistantMessage.metadata = mergeRunMessageMetadata(assistantMessage.metadata, chunk.messageMetadata);
        break;
      }
      case 'message-metadata': {
        const assistantMessage = getAssistantMessage();
        assistantMessage.metadata = mergeRunMessageMetadata(assistantMessage.metadata, chunk.messageMetadata);
        break;
      }
      case 'text-start': {
        if (typeof chunk.id !== 'string') break;
        const assistantMessage = getAssistantMessage();
        const part = {
          type: 'text',
          text: '',
          ...(chunk.providerMetadata !== undefined ? { providerMetadata: chunk.providerMetadata } : {}),
        };
        activeTextParts[chunk.id] = part;
        assistantMessage.parts.push(part);
        break;
      }
      case 'text-delta': {
        if (typeof chunk.id !== 'string' || typeof chunk.delta !== 'string') break;
        const assistantMessage = getAssistantMessage();
        const part = activeTextParts[chunk.id] ?? {
          type: 'text',
          text: '',
        };
        if (!activeTextParts[chunk.id]) {
          activeTextParts[chunk.id] = part;
          assistantMessage.parts.push(part);
        }
        part.text = `${typeof part.text === 'string' ? part.text : ''}${chunk.delta}`;
        if (chunk.providerMetadata !== undefined) part.providerMetadata = chunk.providerMetadata;
        break;
      }
      case 'text-end': {
        if (typeof chunk.id === 'string') delete activeTextParts[chunk.id];
        break;
      }
      case 'reasoning-start': {
        if (typeof chunk.id !== 'string') break;
        const assistantMessage = getAssistantMessage();
        const part = {
          type: 'reasoning',
          text: '',
          ...(chunk.providerMetadata !== undefined ? { providerMetadata: chunk.providerMetadata } : {}),
        };
        activeReasoningParts[chunk.id] = part;
        assistantMessage.parts.push(part);
        break;
      }
      case 'reasoning-delta': {
        if (typeof chunk.id !== 'string' || typeof chunk.delta !== 'string') break;
        const assistantMessage = getAssistantMessage();
        const part = activeReasoningParts[chunk.id] ?? {
          type: 'reasoning',
          text: '',
        };
        if (!activeReasoningParts[chunk.id]) {
          activeReasoningParts[chunk.id] = part;
          assistantMessage.parts.push(part);
        }
        part.text = `${typeof part.text === 'string' ? part.text : ''}${chunk.delta}`;
        if (chunk.providerMetadata !== undefined) part.providerMetadata = chunk.providerMetadata;
        break;
      }
      case 'reasoning-end': {
        if (typeof chunk.id === 'string') delete activeReasoningParts[chunk.id];
        break;
      }
      case 'start-step': {
        getAssistantMessage().parts.push({ type: 'step-start' });
        break;
      }
      case 'tool-input-start': {
        if (typeof chunk.toolCallId !== 'string' || typeof chunk.toolName !== 'string') break;
        const assistantMessage = getAssistantMessage();
        partialToolInputs[chunk.toolCallId] = {
          text: '',
          toolName: chunk.toolName,
          dynamic: chunk.dynamic === true,
          title: typeof chunk.title === 'string' ? chunk.title : undefined,
          toolMetadata: chunk.toolMetadata,
        };
        upsertRunToolPart(assistantMessage, {
          toolCallId: chunk.toolCallId,
          toolName: chunk.toolName,
          state: 'input-streaming',
          input: undefined,
          dynamic: chunk.dynamic === true,
          providerExecuted: chunk.providerExecuted,
          title: chunk.title,
          toolMetadata: chunk.toolMetadata,
          providerMetadata: chunk.providerMetadata,
        });
        break;
      }
      case 'tool-input-delta': {
        if (typeof chunk.toolCallId !== 'string' || typeof chunk.inputTextDelta !== 'string') break;
        const assistantMessage = getAssistantMessage();
        const pending = partialToolInputs[chunk.toolCallId];
        if (!pending) break;
        pending.text += chunk.inputTextDelta;
        upsertRunToolPart(assistantMessage, {
          toolCallId: chunk.toolCallId,
          toolName: pending.toolName,
          state: 'input-streaming',
          input: parsePartialJson(pending.text),
          dynamic: pending.dynamic,
          title: pending.title,
          toolMetadata: pending.toolMetadata,
        });
        break;
      }
      case 'tool-input-available': {
        if (typeof chunk.toolCallId !== 'string' || typeof chunk.toolName !== 'string') break;
        const assistantMessage = getAssistantMessage();
        delete partialToolInputs[chunk.toolCallId];
        upsertRunToolPart(assistantMessage, {
          toolCallId: chunk.toolCallId,
          toolName: chunk.toolName,
          state: 'input-available',
          input: chunk.input,
          dynamic: chunk.dynamic === true,
          providerExecuted: chunk.providerExecuted,
          title: chunk.title,
          toolMetadata: chunk.toolMetadata,
          providerMetadata: chunk.providerMetadata,
        });
        break;
      }
      case 'tool-input-error': {
        if (typeof chunk.toolCallId !== 'string' || typeof chunk.toolName !== 'string') break;
        const assistantMessage = getAssistantMessage();
        delete partialToolInputs[chunk.toolCallId];
        upsertRunToolPart(assistantMessage, {
          toolCallId: chunk.toolCallId,
          toolName: chunk.toolName,
          state: 'output-error',
          rawInput: chunk.input,
          errorText: chunk.errorText,
          dynamic: chunk.dynamic === true,
          providerExecuted: chunk.providerExecuted,
          title: chunk.title,
          toolMetadata: chunk.toolMetadata,
          providerMetadata: chunk.providerMetadata,
        });
        break;
      }
      case 'tool-output-available':
      case 'tool-output-error': {
        if (typeof chunk.toolCallId !== 'string') break;
        const assistantMessage = getAssistantMessage();
        const existingPart = findRunToolPart(assistantMessage, chunk.toolCallId);
        const existingToolName = typeof existingPart?.toolName === 'string'
          ? existingPart.toolName
          : typeof existingPart?.type === 'string' && existingPart.type.startsWith('tool-')
          ? existingPart.type.slice('tool-'.length)
          : 'tool';
        upsertRunToolPart(assistantMessage, {
          toolCallId: chunk.toolCallId,
          toolName: existingToolName,
          state: chunk.type === 'tool-output-available' ? 'output-available' : 'output-error',
          input: existingPart?.input,
          rawInput: existingPart?.rawInput,
          output: chunk.type === 'tool-output-available' ? chunk.output : undefined,
          errorText: chunk.type === 'tool-output-error' ? chunk.errorText : undefined,
          dynamic: existingPart?.type === 'dynamic-tool' || chunk.dynamic === true,
          providerExecuted: chunk.providerExecuted,
          preliminary: chunk.preliminary,
          title: existingPart?.title,
          toolMetadata: chunk.toolMetadata ?? existingPart?.toolMetadata,
          providerMetadata: chunk.providerMetadata,
        });
        break;
      }
      case 'file': {
        getAssistantMessage().parts.push({
          type: 'file',
          url: chunk.url,
          mediaType: chunk.mediaType,
          ...(chunk.providerMetadata !== undefined ? { providerMetadata: chunk.providerMetadata } : {}),
        });
        break;
      }
      case 'source-url':
      case 'source-document': {
        getAssistantMessage().parts.push({ ...chunk });
        break;
      }
      case 'data-user-message': {
        closeAssistantMessage({ type: 'complete' });
        const userMessage = buildRunUserMessageFromSignalChunk(chunk, `${run.runId}-user-${messages.length}`);
        if (userMessage) messages.push(userMessage);
        break;
      }
      case 'finish': {
        const assistantMessage = getAssistantMessage();
        assistantMessage.status = { type: 'complete' };
        assistantMessage.metadata = mergeRunMessageMetadata(assistantMessage.metadata, chunk.messageMetadata);
        break;
      }
      case 'abort': {
        if (message) message.status = { type: 'complete', reason: 'stop' };
        break;
      }
      default: {
        if (chunk.type.startsWith('data-') && chunk.transient !== true) getAssistantMessage().parts.push({ ...chunk });
        break;
      }
    }
  }

  closeAssistantMessage(message?.status ?? defaultAssistantStatus());

  return messages;
};

export const getThreadRunSubmittedUserMessages = (resourceId: string | undefined, threadId: string | undefined) =>
  getThreadRun(resourceId, threadId)?.submittedUserMessages ?? [];

export const getThreadRunUiMessages = (resourceId: string | undefined, threadId: string | undefined) => {
  const run = getThreadRun(resourceId, threadId);
  return run ? buildRunUiMessagesFromChunks(run) : [];
};

const createActiveThreadRun = (resourceId: string, threadId: string, submittedUserMessages: unknown[] = []) => {
  const key = threadRunKey(resourceId, threadId);
  const previous = activeThreadRuns.get(key);
  if (previous?.cleanupTimer) clearTimeout(previous.cleanupTimer);
  previous?.contextUsageUnsubscribe?.();

  const now = new Date().toISOString();
  const run: ActiveThreadRun = {
    key,
    resourceId,
    threadId,
    runId: crypto.randomUUID(),
    status: 'running',
    startedAt: now,
    updatedAt: now,
    controller: new AbortController(),
    chunks: [],
    submittedUserMessages,
    listeners: new Set(),
    perf: createChatRunPerf(),
  };
  run.contextUsageUnsubscribe = subscribeThreadContextUsage(threadId, resourceId, snapshot => {
    appendThreadRunChunk(run, toContextUsageChunk(snapshot));
  });
  activeThreadRuns.set(key, run);
  return run;
};

const appendThreadRunChunk = (run: ActiveThreadRun, chunk: unknown) => {
  if (activeThreadRuns.get(run.key) !== run || !activeThreadRunStatuses.has(run.status)) return;

  const type = getStreamChunkType(chunk);
  recordChatRunPerfChunk(run, chunk, type);
  if (type === 'finish' || type === 'abort') run.terminalChunkType = type;
  run.chunks.push(chunk);
  run.updatedAt = new Date().toISOString();

  for (const listener of run.listeners) listener({ type: 'chunk', chunk });
};

const settleThreadRun = (run: ActiveThreadRun, status: Exclude<ActiveThreadRunStatus, 'running' | 'cancelling'>, error?: unknown) => {
  if (activeThreadRuns.get(run.key) !== run || !activeThreadRunStatuses.has(run.status)) return;

  run.contextUsageUnsubscribe?.();
  run.contextUsageUnsubscribe = undefined;
  run.status = status;
  run.updatedAt = new Date().toISOString();
  if (error) run.error = error instanceof Error ? error.message : String(error);
  logChatRunPerfSummary(run, status);

  if (status === 'error') {
    const startedAtMs = Date.parse(run.startedAt);
    const durationMs = Number.isFinite(startedAtMs) ? Date.now() - startedAtMs : undefined;
    const lastChunk = run.chunks[run.chunks.length - 1];
    console.error('[chat] active thread run failed', {
      threadId: run.threadId,
      resourceId: run.resourceId,
      runId: run.runId,
      durationMs,
      chunkCount: run.chunks.length,
      lastChunkType: getStreamChunkType(lastChunk) ?? 'unknown',
      error: run.error,
    });
  }

  const event: ActiveThreadRunEvent = status === 'error'
    ? { type: 'error', error: error ?? new Error('Thread run failed') }
    : { type: 'close' };
  for (const listener of run.listeners) listener(event);
  run.listeners.clear();
  scheduleThreadRunCleanup(run);
};

const observeThreadRun = (run: ActiveThreadRun) => {
  let listener: ActiveThreadRunListener | undefined;

  return new ReadableStream<unknown>({
    start(controller) {
      for (const chunk of run.chunks) controller.enqueue(chunk);

      if (!activeThreadRunStatuses.has(run.status)) {
        controller.close();
        return;
      }

      listener = event => {
        if (event.type === 'chunk') {
          controller.enqueue(event.chunk);
        } else if (event.type === 'error') {
          if (listener) run.listeners.delete(listener);
          controller.error(event.error);
        } else {
          if (listener) run.listeners.delete(listener);
          controller.close();
        }
      };
      run.listeners.add(listener);
    },
    cancel() {
      if (listener) run.listeners.delete(listener);
    },
  });
};

const startThreadRunPump = (run: ActiveThreadRun, stream: ReadableStream<unknown>) => {
  void (async () => {
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        appendThreadRunChunk(run, value);
        const streamError = getStreamChunkError(value);
        if (streamError) {
          settleThreadRun(run, 'error', streamError);
          return;
        }
      }

      settleThreadRun(run, run.terminalChunkType === 'abort' ? 'cancelled' : 'completed');
    } catch (error) {
      settleThreadRun(run, run.controller.signal.aborted ? 'cancelled' : 'error', error);
    } finally {
      reader.releaseLock();
    }
  })();
};

const cancelThreadRun = (run: ActiveThreadRun) => {
  if (!activeThreadRunStatuses.has(run.status)) return false;

  run.status = 'cancelling';
  run.updatedAt = new Date().toISOString();
  appendThreadRunChunk(run, { type: 'abort', reason: 'cancelled' });
  run.controller.abort('cancelled');
  settleThreadRun(run, 'cancelled');
  return true;
};

const normalizeMessageImageAttachments = async (
  messages: unknown,
  options: { threadId?: string; storage?: Pick<AttachmentStorage, 'findByThread' | 'put'> },
) => {
  if (!Array.isArray(messages)) return messages;
  const storage = options.storage ?? attachmentStorage;
  const threadAttachments = options.threadId ? await storage.findByThread(options.threadId) : [];

  const newestMatchingAttachment = (part: Record<string, unknown>): StoredAttachmentMetadata | undefined => {
    const metadata = part.metadata && typeof part.metadata === 'object' ? part.metadata as Record<string, unknown> : {};
    const attachmentId = typeof metadata.attachmentId === 'string' ? metadata.attachmentId : undefined;
    const filename = typeof part.filename === 'string' ? part.filename : undefined;
    const mediaType = typeof part.mediaType === 'string'
      ? part.mediaType
      : typeof part.mimeType === 'string'
        ? part.mimeType
        : undefined;

    return threadAttachments
      .filter(attachment =>
        (attachmentId ? attachment.id === attachmentId : true) &&
        (filename ? attachment.originalName === filename : true) &&
        (mediaType ? attachment.mimeType === mediaType.toLowerCase() : true)
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  };

  return Promise.all(messages.map(async message => {
    if (!message || typeof message !== 'object') return message;
    const record = message as Record<string, unknown>;
    if (!Array.isArray(record.parts)) return message;
    const experimentalAttachments = Array.isArray(record.experimental_attachments)
      ? record.experimental_attachments.filter(attachment => {
          if (!attachment || typeof attachment !== 'object') return true;
          const attachmentRecord = attachment as Record<string, unknown>;
          const url = typeof attachmentRecord.url === 'string' ? attachmentRecord.url : '';
          return !url.startsWith('data:') && !attachmentIdFromReference(url);
        })
      : [];
    const nextExperimentalAttachments: Array<Record<string, unknown>> = [...experimentalAttachments];

    const parts = await Promise.all(record.parts.map(async part => {
      if (!part || typeof part !== 'object') return part;
      const partRecord = part as Record<string, unknown>;
      if (partRecord.type !== 'file') return part;

      const rawData = typeof partRecord.data === 'string' ? partRecord.data : undefined;
      const rawUrl = typeof partRecord.url === 'string' ? partRecord.url : undefined;
      const mediaType = typeof partRecord.mediaType === 'string'
        ? partRecord.mediaType
        : typeof partRecord.mimeType === 'string'
          ? partRecord.mimeType
          : undefined;
      const dataUrl = rawData?.startsWith('data:')
        ? rawData
        : rawUrl?.startsWith('data:')
          ? rawUrl
          : undefined;
      if (!dataUrl) {
        const referencedAttachmentId = rawUrl ? attachmentIdFromReference(rawUrl) : rawData ? attachmentIdFromReference(rawData) : undefined;
        const stored = mediaType?.startsWith('image/')
          ? referencedAttachmentId
            ? threadAttachments.find(attachment => attachment.id === referencedAttachmentId)
            : newestMatchingAttachment(partRecord)
          : undefined;
        if (!stored) return part;
        nextExperimentalAttachments.push({
          url: attachmentModelUrl(stored.id),
          contentType: stored.mimeType,
        });
        return null;
      }

      const parsed = parseBase64DataUrl(dataUrl);
      if (!parsed || !parsed.mimeType.startsWith('image/')) return part;
      if (parsed.bytes.byteLength > maxImageAttachmentBytes) {
        throw new Error(`Image attachment exceeds the ${maxImageAttachmentBytes} byte limit`);
      }

      const stored = await storage.put({
        bytes: parsed.bytes,
        mimeType: parsed.mimeType,
        originalName: typeof partRecord.filename === 'string' ? partRecord.filename : 'image',
        threadId: options.threadId,
      });

      nextExperimentalAttachments.push({
        url: attachmentModelUrl(stored.id),
        contentType: stored.mimeType,
      });
      return null;
    }));

    return {
      ...record,
      parts: parts.filter(part => part !== null),
      experimental_attachments: nextExperimentalAttachments.length ? nextExperimentalAttachments : undefined,
    };
  }));
};

const isDisplayOnlySubmittedPart = (part: unknown) => {
  if (!part || typeof part !== 'object') return false;
  const type = (part as Record<string, unknown>).type;
  return typeof type === 'string' && (type === 'reasoning' || type === 'redacted-reasoning' || type.startsWith('data-'));
};

const sanitizeSubmittedMessagesForMastra = (messages: unknown) => {
  if (!Array.isArray(messages)) return messages;

  return messages
    .map(message => {
      if (!message || typeof message !== 'object') return message;
      const record = message as Record<string, unknown>;
      if (!Array.isArray(record.parts)) return message;

      const parts = record.parts.filter(part => !isDisplayOnlySubmittedPart(part));
      if (parts.length === record.parts.length) return message;

      return { ...record, parts };
    })
    .filter(message => {
      if (!message || typeof message !== 'object') return true;
      const record = message as Record<string, unknown>;
      if (record.role === 'user') return true;
      if (!Array.isArray(record.parts)) return true;
      if (record.parts.length > 0) return true;
      return typeof record.content === 'string' && record.content.trim().length > 0;
    });
};

const latestUserMessageOnly = (messages: unknown) => {
  if (!Array.isArray(messages) || messages.length <= 1) return messages;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as Record<string, unknown> | undefined;
    if (message && typeof message === 'object' && message.role === 'user') return [message];
  }
  return [messages[messages.length - 1]];
};

const submittedMessagesForMemory = (messages: unknown, threadId: unknown) =>
  typeof threadId === 'string' && threadId.trim() ? latestUserMessageOnly(messages) : messages;

const getString = (value: unknown) => typeof value === 'string' && value.trim() ? value : undefined;

const toAgentFileData = (value: string) => {
  try {
    return new URL(value);
  } catch {
    return value;
  }
};

const toAgentMessageInput = (message: unknown): AgentMessageInput => {
  if (!isRecord(message) || message.role !== 'user') {
    throw new Error('Steering message must be a user message');
  }

  const contents: Array<Record<string, unknown>> = [];
  const addText = (text: unknown) => {
    if (typeof text === 'string' && text.length > 0) contents.push({ type: 'text', text });
  };
  const addFile = (file: Record<string, unknown>) => {
    const mediaType = getString(file.mediaType) ?? getString(file.mimeType) ?? getString(file.contentType);
    const data = getString(file.data) ?? getString(file.url);
    if (!data || !mediaType) return;
    contents.push({
      type: 'file',
      data: toAgentFileData(data),
      mediaType,
      ...(getString(file.filename) ? { filename: getString(file.filename) } : {}),
      ...(file.providerOptions !== undefined ? { providerOptions: file.providerOptions } : {}),
    });
  };

  if (Array.isArray(message.parts)) {
    for (const part of message.parts) {
      if (!isRecord(part)) continue;
      if (part.type === 'text') addText(part.text);
      else if (part.type === 'file') addFile(part);
    }
  } else {
    addText(message.content);
  }

  if (Array.isArray(message.experimental_attachments)) {
    for (const attachment of message.experimental_attachments) {
      if (isRecord(attachment)) addFile(attachment);
    }
  }

  if (contents.length === 0) {
    throw new Error('Steering message must include text or complete attachments');
  }

  return {
    contents,
    ...(isRecord(message.metadata) ? { metadata: message.metadata } : {}),
    ...(isRecord(message.providerOptions) ? { providerOptions: message.providerOptions } : {}),
  } as unknown as AgentMessageInput;
};

export const __chatRouteMemoryTest = {
  latestUserMessageOnly,
  getSubmittedUserMessages,
  normalizeMessageImageAttachments,
  sanitizeSubmittedMessagesForMastra,
  submittedMessagesForMemory,
  toAgentMessageInput,
};

export const __chatRunRegistryTest = {
  create: createActiveThreadRun,
  submittedUserMessages: getThreadRunSubmittedUserMessages,
  append: appendThreadRunChunk,
  observe: observeThreadRun,
  cancel: cancelThreadRun,
  complete: (run: ActiveThreadRun) => settleThreadRun(run, 'completed'),
  pump: startThreadRunPump,
  buffer: bufferAssistantTextStream,
  snapshot: toThreadRunSnapshot,
  runTimingMetadata: buildRunTimingMetadata,
  get: getThreadRun,
  uiMessages: getThreadRunUiMessages,
  clear: () => {
    for (const run of activeThreadRuns.values()) {
      if (run.cleanupTimer) clearTimeout(run.cleanupTimer);
      run.contextUsageUnsubscribe?.();
      run.listeners.clear();
      run.controller.abort('test cleanup');
    }
    activeThreadRuns.clear();
  },
};

export const chatRoutes = [
  defineRoute('/chat/runs/:threadId/stream', {
    method: 'GET',
    handler: async c => {
      const resourceId = getResourceId(c);
      const threadId = c.req.param('threadId');
      const run = getActiveThreadRun(resourceId, threadId);
      if (!run) return new Response(null, { status: 204 });

      return toSseResponse(observeThreadRun(run));
    },
  }),
  defineRoute('/chat/runs/:threadId', {
    method: 'GET',
    handler: async c => {
      const resourceId = getResourceId(c);
      const threadId = c.req.param('threadId');
      return c.json({ run: toThreadRunSnapshot(getThreadRun(resourceId, threadId)) });
    },
  }),
  defineRoute('/chat/runs/:threadId/cancel', {
    method: 'POST',
    handler: async c => {
      const resourceId = getResourceId(c);
      const threadId = c.req.param('threadId');
      const run = getActiveThreadRun(resourceId, threadId);
      if (!run) return c.json({ ok: true, run: toThreadRunSnapshot(getThreadRun(resourceId, threadId)) });

      cancelThreadRun(run);
      return c.json({ ok: true, run: toThreadRunSnapshot(run) });
    },
  }),
  defineRoute('/chat/runs/:threadId/steer', {
    method: 'POST',
    handler: async c => {
      const resourceId = getResourceId(c);
      const threadId = c.req.param('threadId');
      const run = getActiveThreadRun(resourceId, threadId);
      if (!run) {
        return c.json({ ok: false, reason: 'not_active', run: toThreadRunSnapshot(getThreadRun(resourceId, threadId)) }, 409);
      }

      const body = await c.req.json();
      const submittedMessages = Array.isArray(body?.messages)
        ? body.messages
        : body?.message
        ? [body.message]
        : [];
      const normalizedMessages = sanitizeSubmittedMessagesForMastra(await normalizeMessageImageAttachments(
        submittedMessagesForMemory(submittedMessages, threadId),
        { threadId },
      ));
      const submittedUserMessage = getSubmittedUserMessages(normalizedMessages)[0];
      if (!submittedUserMessage) return c.json({ error: 'Steering requires a user message' }, 400);

      const mastra = c.get('mastra');
      const agent = await mastra.getAgent(mastraAgentName);
      const result = agent.sendMessage(toAgentMessageInput(submittedUserMessage), {
        resourceId,
        threadId,
        ifActive: {
          behavior: 'deliver',
          attributes: {
            source: 'composer',
            delivery: 'while-active',
          },
        },
        ifIdle: { behavior: 'discard' },
      });

      return c.json({
        ok: true,
        accepted: result.accepted,
        runId: result.runId,
        messageId: result.signal.id,
      });
    },
  }),
  defineRoute('/chat/runs', {
    method: 'POST',
    handler: async c => {
      const params = await c.req.json();
      const mastra = c.get('mastra');
      const requestContext = c.get('requestContext');
      const resourceId = getResourceId(c);
      putChatRuntimeContext(requestContext, { now: new Date() });
      const threadId = params?.memory?.thread;
      params.messages = sanitizeSubmittedMessagesForMastra(await normalizeMessageImageAttachments(submittedMessagesForMemory(params.messages, threadId), {
        threadId: typeof threadId === 'string' ? threadId : undefined,
      }));
      const resolvedProfile = resourceId
        ? await resolveProfileContext({ mastra, resourceId, threadId })
        : undefined;
      if (resolvedProfile) putProfileContext(requestContext, resolvedProfile);
      const memoryPolicy = resolvedProfile
        ? resolveMemoryPolicy({
            profileMemory: resolvedProfile.profile.memory,
            threadMetadata: resolvedProfile.threadMetadata,
          })
        : undefined;
      const isProjectWorkspace = Boolean(resolvedProfile?.threadMetadata?.mode === 'project' && resolvedProfile.threadMetadata.workspaceId);
      const isGitProject = resolvedProfile?.projectKind === 'git';
      const isNotesProject = resolvedProfile?.projectKind === 'notes';
      markGitWorkspaceContext(requestContext, isProjectWorkspace);
      markGitProjectContext(requestContext, isGitProject);
      const system = buildChatSystemMessages({
        includeGitInstructions: isGitProject,
        includeNotesInstructions: isNotesProject,
        agentFiles: resolvedProfile?.agentFiles,
        skillSummaries: resolvedProfile ? listResolvedProfileSkillSummaries(resolvedProfile) : undefined,
        callerSystem: params.system as Parameters<typeof buildChatSystemMessages>[0]['callerSystem'],
      });

      const routedModel = routeSubscriptionModel(params?.model);
      const providerModel = routedModel ?? params?.model;
      const requestHasReasoningEffort = hasOwn(params, 'reasoningEffort');
      const requestHasServiceTier = hasOwn(params, 'serviceTier');
      const reasoningEffort = normalizeOpenAIReasoningEffort(
        requestHasReasoningEffort ? params?.reasoningEffort : resolvedProfile?.profile.reasoningEffort,
        providerModel,
        { fallbackToDefault: true },
      );
      const serviceTier = requestHasServiceTier
        ? normalizeOpenAIServiceTier(params?.serviceTier, providerModel)
        : normalizeOpenAIServiceTier(resolvedProfile?.profile.serviceTier, providerModel);
      console.info('[chat] stream request', {
        agentId,
        profileId: resolvedProfile?.profile.id,
        selectedModel: params?.model,
        routedModel,
        reasoningEffort: reasoningEffort ?? 'default',
        serviceTier: serviceTier ?? 'default',
        threadId,
        resourceId,
        memory: memoryPolicy?.status,
        chatgptSubscription: true,
      });

      if (typeof threadId === 'string' && getActiveThreadRun(resourceId, threadId)) {
        return c.json({ error: 'thread has an active stream' }, 409);
      }

      const run = typeof threadId === 'string'
        ? createActiveThreadRun(resourceId, threadId, getSubmittedUserMessages(params.messages))
        : undefined;

      try {
        const stream = await handleChatStream({
          mastra,
          agentId,
          version: 'v6',
          sendReasoning: true,
          defaultOptions: { maxSteps: 1000 },
          ...(run
            ? {
                messageMetadata: ({ part }: { part?: unknown }) => {
                  if (!isRecord(part)) return undefined;
                  if (part.type === 'start') return buildRunTimingMetadata(run, 'running');
                  if (part.type === 'finish') return buildRunTimingMetadata(run, 'completed');
                  return undefined;
                },
              }
            : {}),
          params: {
            ...params,
            ...(routedModel ? { model: routedModel } : {}),
            providerOptions: buildProviderOptions(params.providerOptions, { reasoningEffort, serviceTier, threadId, resourceId }),
            memory: params.memory && typeof params.memory === 'object'
              ? {
                  ...params.memory,
                  ...(resourceId ? { resource: resourceId } : {}),
                  ...(memoryPolicy ? { options: memoryPolicy.options } : {}),
                }
              : params.memory,
            system,
            requestContext,
            abortSignal: run?.controller.signal ?? c.req.raw.signal,
          },
        });

        const bufferedStream = bufferAssistantTextStream(stream as ReadableStream<unknown>);
        if (run) {
          startThreadRunPump(run, bufferedStream);
          return toSseResponse(observeThreadRun(run));
        }

        return toSseResponse(bufferedStream);
      } catch (error) {
        if (run) settleThreadRun(run, 'error', error);
        throw error;
      }
    },
  }),
];
