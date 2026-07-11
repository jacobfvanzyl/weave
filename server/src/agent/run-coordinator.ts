import {
  estimateJsonByteLength,
  getDenoRuntimeMemorySnapshot,
  isServerPerfEnabled,
  logServerPerfEvent,
  memoryDelta,
} from '../server/perf';
import {
  isCompactToolHistoryTextPart,
  isLegacyCompactToolHistoryText,
  isPotentialCompactToolHistoryText,
} from './mastra/compact-tool-history-processor';
import { subscribeThreadContextUsage, type ThreadContextUsageSnapshot } from './mastra/context-usage';

const activeThreadRunCleanupDelayMs = 5 * 60 * 1000;

const bufferedAssistantTextMaxChars = 24_000;
const bufferedAssistantTextFlushDelayMs = 80;
const bufferedAssistantTextImmediateMinChars = 32;
const bufferedAssistantTextSoftMaxChars = 900;
const bufferedAssistantTextTypes = new Set(['text-delta', 'reasoning-delta']);
const bufferedAssistantEndTypes: Record<string, string> = {
  'text-end': 'text',
  'reasoning-end': 'reasoning',
};

export type AgentThreadRunStatus = 'running' | 'cancelling' | 'completed' | 'cancelled' | 'error';

type AgentThreadRunEvent =
  | { type: 'chunk'; chunk: unknown }
  | { type: 'close' }
  | { type: 'error'; error: unknown };

type AgentThreadRunListener = (event: AgentThreadRunEvent) => void;

export type AgentThreadRun = {
  key: string;
  resourceId: string;
  threadId: string;
  runId: string;
  status: AgentThreadRunStatus;
  startedAt: string;
  updatedAt: string;
  controller: AbortController;
  chunks: unknown[];
  submittedUserMessages: unknown[];
  listeners: Set<AgentThreadRunListener>;
  contextUsageUnsubscribe?: () => void;
  cleanupTimer?: ReturnType<typeof setTimeout>;
  terminalChunkType?: string;
  error?: string;
  perf?: ChatRunPerf;
};

export type AgentThreadRunSnapshot = {
  active: boolean;
  status: AgentThreadRunStatus | 'idle';
  runId?: string;
  startedAt?: string;
  updatedAt?: string;
  durationMs?: number;
  error?: string;
};

export type RunUiMessage = {
  id: string;
  role: 'assistant' | 'user';
  parts: Array<Record<string, unknown>>;
  status?: { type: 'running' | 'complete'; reason?: string };
  metadata?: unknown;
};

export type RunTimingStatus = 'running' | 'completed' | 'cancelled' | 'error';

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

type CompactToolHistoryTextState = {
  chunks: unknown[];
  text: string;
  forceCompact: boolean;
};

type PendingToolInput = {
  text: string;
  toolName: string;
  dynamic?: boolean;
  title?: string;
  toolMetadata?: unknown;
};

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

type AgentRunCoordinatorOptions = {
  cleanupDelayMs?: number;
  subscribeContextUsage?: typeof subscribeThreadContextUsage;
  createPerf?: () => ChatRunPerf | undefined;
};

const activeThreadRunStatuses = new Set<AgentThreadRunStatus>(['running', 'cancelling']);

export const getStreamChunkType = (chunk: unknown) =>
  chunk && typeof chunk === 'object' && typeof (chunk as Record<string, unknown>).type === 'string'
    ? (chunk as Record<string, unknown>).type as string
    : undefined;

const retainUserMessageDataChunk = (chunk: unknown) =>
  chunk && typeof chunk === 'object' && !Array.isArray(chunk)
    ? { ...(chunk as Record<string, unknown>), transient: false }
    : chunk;

export const getStreamChunkError = (chunk: unknown) => {
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

const isCompactToolHistoryMetadataChunk = (chunk: unknown) => {
  if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk)) return false;
  const record = chunk as Record<string, unknown>;
  return isCompactToolHistoryTextPart({
    type: 'text',
    text: '',
    providerMetadata: record.providerMetadata,
    providerOptions: record.providerOptions,
  });
};

export const filterCompactToolHistoryTextStream = (stream: ReadableStream<unknown>) =>
  new ReadableStream<unknown>({
    async start(controller) {
      const reader = stream.getReader();
      const pendingText = new Map<string, CompactToolHistoryTextState>();

      const resolvePendingText = (id: string) => {
        const state = pendingText.get(id);
        if (!state) return;

        pendingText.delete(id);
        if (state.forceCompact || isLegacyCompactToolHistoryText(state.text)) return;

        for (const chunk of state.chunks) controller.enqueue(chunk);
      };

      const resolveAllPendingText = () => {
        for (const id of [...pendingText.keys()]) resolvePendingText(id);
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const type = getStreamChunkType(value);
          const id = getStreamChunkId(value);

          if (type === 'text-start' && id && isCompactToolHistoryMetadataChunk(value)) {
            pendingText.set(id, { chunks: [], text: '', forceCompact: true });
            controller.enqueue(value);
            continue;
          }

          if (type === 'text-delta' && id && value && typeof value === 'object' && !Array.isArray(value)) {
            const delta = typeof (value as Record<string, unknown>).delta === 'string'
              ? (value as Record<string, string>).delta
              : undefined;
            if (delta === undefined) {
              controller.enqueue(value);
              continue;
            }

            const previousState = pendingText.get(id);
            const forceCompact = previousState?.forceCompact === true || isCompactToolHistoryMetadataChunk(value);
            const text = `${previousState?.text ?? ''}${delta}`;
            const state: CompactToolHistoryTextState = {
              chunks: [...(previousState?.chunks ?? []), value],
              text,
              forceCompact,
            };

            if (forceCompact || isPotentialCompactToolHistoryText(text)) {
              pendingText.set(id, state);
              continue;
            }

            pendingText.delete(id);
            for (const chunk of state.chunks) controller.enqueue(chunk);
            continue;
          }

          if (type === 'text-end' && id) {
            resolvePendingText(id);
            controller.enqueue(value);
            continue;
          }

          if (
            type === 'data-user-message' ||
            type === 'data-ask-user' ||
            type === 'start' ||
            type === 'finish' ||
            type === 'abort'
          ) {
            resolveAllPendingText();
          }

          controller.enqueue(value);
        }

        resolveAllPendingText();
        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        reader.releaseLock();
      }
    },
    cancel(reason) {
      return stream.cancel(reason).catch(() => undefined);
    },
  });

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

export const bufferAssistantTextStream = (stream: ReadableStream<unknown>) =>
  new ReadableStream<unknown>({
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
          if (type === 'data-user-message' || type === 'data-ask-user' || type === 'start' || type === 'abort') {
            flushAll();
          }
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

const threadRunKey = (resourceId: string, threadId: string) => `${resourceId}\0${threadId}`;

const isActiveThreadRun = (run: AgentThreadRun | undefined) => Boolean(run && activeThreadRunStatuses.has(run.status));

const getRunDurationMs = (run: Pick<AgentThreadRun, 'startedAt'>, endMs = Date.now()) => {
  const startedAtMs = Date.parse(run.startedAt);
  if (!Number.isFinite(startedAtMs)) return undefined;
  return Math.max(0, (Number.isFinite(endMs) ? endMs : Date.now()) - startedAtMs);
};

export const buildRunTimingMetadata = (
  run: AgentThreadRun,
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

export const toThreadRunSnapshot = (run: AgentThreadRun | undefined): AgentThreadRunSnapshot => ({
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

const toContextUsageChunk = (snapshot: ThreadContextUsageSnapshot) => ({
  type: 'data-context-usage' as const,
  transient: true,
  data: {
    tokens: snapshot.usedTokens,
    inputTokens: snapshot.inputTokens,
    cachedInputTokens: snapshot.cachedInputTokens,
    outputTokens: snapshot.outputTokens,
    totalProcessedTokens: snapshot.totalProcessedTokens,
    modelId: snapshot.modelId,
    contextWindow: snapshot.advertisedContextTokens,
    contextLimitPercent: snapshot.contextLimitPercent,
    contextLimitTokens: snapshot.maxTokens,
    updatedAt: snapshot.updatedAt,
    source: snapshot.source,
  },
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const askUserToolName = 'ask_user';

type NormalizedAskUserAnswer = {
  id: string;
  finalAnswer: string;
  selectedOptionId?: string;
  customAnswer?: string;
};

const nonEmptyString = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const normalizeAskUserQuestions = (value: unknown): Array<Record<string, unknown>> | undefined => {
  if (!Array.isArray(value)) return undefined;

  const questions = value.flatMap((question): Array<Record<string, unknown>> => {
    if (!isRecord(question)) return [];
    const id = nonEmptyString(question.id);
    const text = nonEmptyString(question.question);
    const rawOptions = Array.isArray(question.options) ? question.options : [];
    const options = rawOptions.flatMap((option): Array<Record<string, unknown>> => {
      if (!isRecord(option)) return [];
      const optionId = nonEmptyString(option.id);
      const label = nonEmptyString(option.label);
      if (!optionId || !label) return [];
      return [{
        id: optionId,
        label,
        ...(nonEmptyString(option.description) ? { description: nonEmptyString(option.description) } : {}),
      }];
    });

    if (!id || !text || options.length < 2) return [];
    return [{
      id,
      question: text,
      options,
      ...(nonEmptyString(question.header) ? { header: nonEmptyString(question.header) } : {}),
    }];
  });

  return questions.length > 0 ? questions : undefined;
};

const normalizeAskUserAnswers = (value: unknown): NormalizedAskUserAnswer[] | undefined => {
  if (!Array.isArray(value)) return undefined;

  const answers = value.map((answer) => {
    if (!isRecord(answer)) return undefined;
    const id = nonEmptyString(answer.id);
    const finalAnswer = nonEmptyString(answer.finalAnswer);
    if (!id || !finalAnswer) return undefined;

    return {
      id,
      finalAnswer,
      ...(nonEmptyString(answer.selectedOptionId) ? { selectedOptionId: nonEmptyString(answer.selectedOptionId) } : {}),
      ...(nonEmptyString(answer.customAnswer) ? { customAnswer: nonEmptyString(answer.customAnswer) } : {}),
    };
  }).filter((answer): answer is NormalizedAskUserAnswer => Boolean(answer));

  return answers.length > 0 ? answers : undefined;
};

const normalizeAskUserResume = (value: unknown) => {
  if (!isRecord(value)) return undefined;
  if (value.action === 'cancel') {
    return {
      action: 'cancel',
      ...(nonEmptyString(value.reason) ? { reason: nonEmptyString(value.reason) } : {}),
    };
  }

  if (value.action === 'submit') {
    const answers = normalizeAskUserAnswers(value.answers);
    return answers ? { action: 'submit', answers } : undefined;
  }

  if (value.cancelled === true) return { action: 'cancel' };
  const answers = normalizeAskUserAnswers(value.answers);
  return answers ? { action: 'submit', answers } : undefined;
};

const normalizeAskUserSuspensionPart = (chunk: Record<string, unknown>) => {
  const data = isRecord(chunk.data) ? chunk.data : chunk;
  if (data.toolName !== askUserToolName) return undefined;

  const suspendPayload = isRecord(data.suspendPayload)
    ? data.suspendPayload
    : isRecord(chunk.suspendPayload)
    ? chunk.suspendPayload
    : undefined;
  const questions = normalizeAskUserQuestions(suspendPayload?.questions);
  const mastraRunId = nonEmptyString(data.runId) ?? nonEmptyString(data.mastraRunId);
  const toolCallId = nonEmptyString(data.toolCallId);
  if (!mastraRunId || !toolCallId || !questions) return undefined;

  return {
    type: 'data-ask-user',
    id: toolCallId,
    data: {
      mastraRunId,
      toolCallId,
      toolName: askUserToolName,
      questions,
      status: 'pending',
      ...(nonEmptyString(suspendPayload?.requestedAt) ? { requestedAt: nonEmptyString(suspendPayload?.requestedAt) } : {}),
    },
  };
};

export const normalizeAskUserSuspensionChunk = (chunk: unknown) => {
  if (!isRecord(chunk) || chunk.type !== 'data-tool-call-suspended') return undefined;
  return normalizeAskUserSuspensionPart(chunk);
};

const getAskUserToolInput = (chunk: Record<string, unknown>) => {
  if (chunk.toolName !== askUserToolName) return undefined;
  const input = isRecord(chunk.input)
    ? chunk.input
    : isRecord(chunk.args)
    ? chunk.args
    : undefined;
  const questions = normalizeAskUserQuestions(input?.questions);
  const toolCallId = nonEmptyString(chunk.toolCallId);
  if (!toolCallId || !questions) return undefined;

  return {
    toolCallId,
    questions,
  };
};

export const normalizeAskUserToolInputChunk = (chunk: unknown, mastraRunId?: string) => {
  if (!isRecord(chunk)) return undefined;
  if (chunk.type !== 'tool-input-available' && chunk.type !== 'tool-call') return undefined;

  const input = getAskUserToolInput(chunk);
  const runId = nonEmptyString(chunk.runId) ?? nonEmptyString(chunk.mastraRunId) ?? nonEmptyString(mastraRunId);
  if (!input || !runId) return undefined;

  return {
    type: 'data-ask-user',
    id: input.toolCallId,
    data: {
      mastraRunId: runId,
      toolCallId: input.toolCallId,
      toolName: askUserToolName,
      questions: input.questions,
      status: 'pending',
    },
  };
};

export const isAskUserSuspensionChunk = (chunk: unknown) => {
  if (!isRecord(chunk)) return false;
  if (chunk.type === 'data-ask-user') {
    const data = isRecord(chunk.data) ? chunk.data : {};
    return data.toolName === askUserToolName &&
      Boolean(
        nonEmptyString(data.mastraRunId) &&
          nonEmptyString(data.toolCallId) &&
          normalizeAskUserQuestions(data.questions),
      );
  }

  return Boolean(normalizeAskUserSuspensionChunk(chunk));
};

export const normalizeAskUserSuspensionStream = (
  stream: ReadableStream<unknown>,
  options: { mastraRunId?: string } = {},
) =>
  new ReadableStream<unknown>({
    async start(controller) {
      const reader = stream.getReader();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          controller.enqueue(
            normalizeAskUserSuspensionChunk(value) ??
              normalizeAskUserToolInputChunk(value, options.mastraRunId) ??
              value,
          );
        }

        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        reader.releaseLock();
      }
    },
    cancel(reason) {
      return stream.cancel(reason).catch(() => undefined);
    },
  });

const markAskUserPartSubmitted = (
  completedMessages: RunUiMessage[],
  currentMessage: RunUiMessage | undefined,
  toolCallId: string,
  resumeData?: Record<string, unknown>,
) => {
  for (const candidate of [...completedMessages, ...(currentMessage ? [currentMessage] : [])]) {
    for (const part of candidate.parts) {
      if (part.type !== 'data-ask-user' || !isRecord(part.data)) continue;
      if (part.data.toolCallId !== toolCallId) continue;
      part.data.status = 'submitted';
      if (resumeData) part.data.resume = resumeData;
    }
  }
};

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
  message.parts.find((part) =>
    part.toolCallId === toolCallId && (
      part.type === 'dynamic-tool' ||
      (typeof part.type === 'string' && part.type.startsWith('tool-'))
    )
  );

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
  const target: Record<string, unknown> = part ?? {
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

const buildRunUserMessageFromSignalChunk = (
  chunk: Record<string, unknown>,
  fallbackId: string,
): RunUiMessage | undefined => {
  const data = chunk.data && typeof chunk.data === 'object' ? chunk.data as Record<string, unknown> : undefined;
  if (!data) return undefined;

  const parts = runSignalContentsToUiParts(data.contents);
  if (parts.length === 0) return undefined;
  const metadata = isRecord(data.metadata) ? data.metadata : undefined;
  const originalText = typeof metadata?.slashCommandOriginalText === 'string'
    ? metadata.slashCommandOriginalText
    : undefined;
  const attachmentParts = parts.filter((part) => part.type === 'file');

  return {
    id: typeof data.id === 'string' && data.id.trim() ? data.id : fallbackId,
    role: 'user',
    parts: originalText ? [{ type: 'text', text: originalText }, ...attachmentParts] : parts,
    ...(data.metadata !== undefined ? { metadata: data.metadata } : {}),
  };
};

const filterRunMessageParts = (message: RunUiMessage) =>
  message.parts.filter((part) => {
    if (part.type === 'reasoning') return typeof part.text === 'string' && part.text.trim().length > 0;
    if (part.type === 'text') {
      return typeof part.text === 'string' && part.text.length > 0 &&
        !isCompactToolHistoryTextPart(part);
    }
    return true;
  });

export const buildRunUiMessagesFromChunks = (run: AgentThreadRun): RunUiMessage[] => {
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
        const toolName = typeof chunk.toolName === 'string' ? chunk.toolName : existingToolName;
        upsertRunToolPart(assistantMessage, {
          toolCallId: chunk.toolCallId,
          toolName,
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
        if (toolName === askUserToolName) {
          markAskUserPartSubmitted(messages, message, chunk.toolCallId, normalizeAskUserResume(chunk.output));
        }
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
        const askUserPart = chunk.type === 'data-tool-call-suspended'
          ? normalizeAskUserSuspensionPart(chunk)
          : undefined;
        if (askUserPart) {
          getAssistantMessage().parts.push(askUserPart);
        } else if (chunk.type.startsWith('data-') && chunk.transient !== true) {
          getAssistantMessage().parts.push({ ...chunk });
        }
        break;
      }
    }
  }

  closeAssistantMessage(message?.status ?? defaultAssistantStatus());

  return messages;
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

const recordChatRunPerfChunk = (run: AgentThreadRun, chunk: unknown, type: string | undefined) => {
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

export class AgentRunCoordinator {
  private readonly runs = new Map<string, AgentThreadRun>();
  private readonly cleanupDelayMs: number;
  private readonly subscribeContextUsage: typeof subscribeThreadContextUsage;
  private readonly createPerf: () => ChatRunPerf | undefined;

  constructor(options: AgentRunCoordinatorOptions = {}) {
    this.cleanupDelayMs = options.cleanupDelayMs ?? activeThreadRunCleanupDelayMs;
    this.subscribeContextUsage = options.subscribeContextUsage ?? subscribeThreadContextUsage;
    this.createPerf = options.createPerf ?? createChatRunPerf;
  }

  hasActiveThreadRun(resourceId: string | undefined, threadId: string | undefined) {
    return Boolean(this.getActiveThreadRun(resourceId, threadId));
  }

  getThreadRun(resourceId: string | undefined, threadId: string | undefined) {
    if (!resourceId || !threadId) return undefined;
    return this.runs.get(threadRunKey(resourceId, threadId));
  }

  getActiveThreadRun(resourceId: string | undefined, threadId: string | undefined) {
    const run = this.getThreadRun(resourceId, threadId);
    return isActiveThreadRun(run) ? run : undefined;
  }

  getRunById(runId: string | undefined) {
    if (!runId) return undefined;
    return [...this.runs.values()].find((run) => run.runId === runId);
  }

  getThreadRunSnapshot(resourceId: string | undefined, threadId: string | undefined) {
    return toThreadRunSnapshot(this.getThreadRun(resourceId, threadId));
  }

  createThreadRun(resourceId: string, threadId: string, submittedUserMessages: unknown[] = []) {
    const key = threadRunKey(resourceId, threadId);
    const previous = this.runs.get(key);
    if (previous?.cleanupTimer) clearTimeout(previous.cleanupTimer);
    previous?.contextUsageUnsubscribe?.();

    const now = new Date().toISOString();
    const run: AgentThreadRun = {
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
      perf: this.createPerf(),
    };
    run.contextUsageUnsubscribe = this.subscribeContextUsage(threadId, resourceId, (snapshot) => {
      this.appendChunk(run, toContextUsageChunk(snapshot));
    });
    this.runs.set(key, run);
    return run;
  }

  appendChunk(run: AgentThreadRun, chunk: unknown) {
    if (this.runs.get(run.key) !== run || !activeThreadRunStatuses.has(run.status)) return;

    const type = getStreamChunkType(chunk);
    recordChatRunPerfChunk(run, chunk, type);
    if (type === 'finish' || type === 'abort') run.terminalChunkType = type;
    run.chunks.push(chunk);
    run.updatedAt = new Date().toISOString();

    for (const listener of run.listeners) listener({ type: 'chunk', chunk });
  }

  completeRun(run: AgentThreadRun) {
    this.settleRun(run, 'completed');
  }

  settleRun(
    run: AgentThreadRun,
    status: Exclude<AgentThreadRunStatus, 'running' | 'cancelling'>,
    error?: unknown,
  ) {
    if (this.runs.get(run.key) !== run || !activeThreadRunStatuses.has(run.status)) return;

    run.contextUsageUnsubscribe?.();
    run.contextUsageUnsubscribe = undefined;
    run.status = status;
    run.updatedAt = new Date().toISOString();
    if (error) run.error = error instanceof Error ? error.message : String(error);
    this.logChatRunPerfSummary(run, status);

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

    const event: AgentThreadRunEvent = status === 'error'
      ? { type: 'error', error: error ?? new Error('Thread run failed') }
      : { type: 'close' };
    for (const listener of run.listeners) listener(event);
    run.listeners.clear();
    this.scheduleThreadRunCleanup(run);
  }

  observeRun(run: AgentThreadRun) {
    let listener: AgentThreadRunListener | undefined;

    return new ReadableStream<unknown>({
      start(controller) {
        for (const chunk of run.chunks) controller.enqueue(chunk);

        if (!activeThreadRunStatuses.has(run.status)) {
          controller.close();
          return;
        }

        listener = (event) => {
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
  }

  observeActiveThreadRun(resourceId: string | undefined, threadId: string | undefined) {
    const run = this.getActiveThreadRun(resourceId, threadId);
    return run ? this.observeRun(run) : undefined;
  }

  startRunPump(run: AgentThreadRun, stream: ReadableStream<unknown>) {
    void (async () => {
      const reader = stream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          this.appendChunk(run, value);
          const streamError = getStreamChunkError(value);
          if (streamError) {
            this.settleRun(run, 'error', streamError);
            return;
          }
          if (isAskUserSuspensionChunk(value)) {
            this.appendChunk(run, {
              type: 'finish',
              finishReason: 'tool-calls',
              messageMetadata: buildRunTimingMetadata(run, 'completed'),
            });
            this.settleRun(run, 'completed');
          }
        }

        this.settleRun(run, run.terminalChunkType === 'abort' ? 'cancelled' : 'completed');
      } catch (error) {
        this.settleRun(run, run.controller.signal.aborted ? 'cancelled' : 'error', error);
      } finally {
        reader.releaseLock();
      }
    })();
  }

  cancelRun(run: AgentThreadRun) {
    if (!activeThreadRunStatuses.has(run.status)) return false;

    run.status = 'cancelling';
    run.updatedAt = new Date().toISOString();
    this.appendChunk(run, { type: 'abort', reason: 'cancelled' });
    run.controller.abort('cancelled');
    this.settleRun(run, 'cancelled');
    return true;
  }

  cancelThreadRun(resourceId: string | undefined, threadId: string | undefined) {
    const run = this.getActiveThreadRun(resourceId, threadId);
    if (!run) return this.getThreadRunSnapshot(resourceId, threadId);
    this.cancelRun(run);
    return toThreadRunSnapshot(run);
  }

  getSubmittedUserMessages(resourceId: string | undefined, threadId: string | undefined) {
    return this.getThreadRun(resourceId, threadId)?.submittedUserMessages ?? [];
  }

  getUiMessages(resourceId: string | undefined, threadId: string | undefined) {
    const run = this.getThreadRun(resourceId, threadId);
    return run ? buildRunUiMessagesFromChunks(run) : [];
  }

  getPerfSnapshot() {
    const runs = [...this.runs.values()];
    const statuses: Partial<Record<AgentThreadRunStatus, number>> = {};
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
      activeThreadRunCount: runs.filter((run) => activeThreadRunStatuses.has(run.status)).length,
      retainedThreadRunCount: runs.length,
      listenerCount,
      retainedChunkCount,
      perfTrackedChunkBytes,
      runningOldestAgeMs,
      statuses,
    };
  }

  clearForTests() {
    for (const run of this.runs.values()) {
      if (run.cleanupTimer) clearTimeout(run.cleanupTimer);
      run.contextUsageUnsubscribe?.();
      run.listeners.clear();
      run.controller.abort('test cleanup');
    }
    this.runs.clear();
  }

  private scheduleThreadRunCleanup(run: AgentThreadRun) {
    if (run.cleanupTimer) clearTimeout(run.cleanupTimer);
    run.cleanupTimer = setTimeout(() => {
      if (this.runs.get(run.key) === run) this.runs.delete(run.key);
    }, this.cleanupDelayMs);
  }

  private logChatRunPerfSummary(
    run: AgentThreadRun,
    status: Exclude<AgentThreadRunStatus, 'running' | 'cancelling'>,
  ) {
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
      registry: this.getPerfSnapshot(),
    });
  }
}

export const createAgentRunCoordinatorTestApi = (coordinator: AgentRunCoordinator) => ({
  create: coordinator.createThreadRun.bind(coordinator),
  submittedUserMessages: coordinator.getSubmittedUserMessages.bind(coordinator),
  append: coordinator.appendChunk.bind(coordinator),
  observe: coordinator.observeRun.bind(coordinator),
  cancel: coordinator.cancelRun.bind(coordinator),
  complete: coordinator.completeRun.bind(coordinator),
  pump: coordinator.startRunPump.bind(coordinator),
  buffer: bufferAssistantTextStream,
  snapshot: toThreadRunSnapshot,
  runTimingMetadata: buildRunTimingMetadata,
  get: coordinator.getThreadRun.bind(coordinator),
  uiMessages: coordinator.getUiMessages.bind(coordinator),
  clear: coordinator.clearForTests.bind(coordinator),
});
