import { handleChatStream } from '@mastra/ai-sdk';
import { MASTRA_RESOURCE_ID_KEY } from '@mastra/core/request-context';
import { registerApiRoute } from '@mastra/core/server';
import { buildChatSystemMessages } from '../agents/instructions';
import { attachmentIdFromReference, attachmentModelUrl, attachmentStorage, parseBase64DataUrl, type StoredAttachmentMetadata } from '../attachments';
import { subscribeThreadContextUsage, type ThreadContextUsageSnapshot } from '../context-usage';
import { resolveMemoryPolicy } from '../memory-policy';
import { putProfileContext, resolveProfileContext } from '../profiles/resolver';
import { putChatRuntimeContext } from '../runtime-context-processor';

const agentId = 'mage-hand';
const maxImageAttachmentBytes = 10 * 1024 * 1024;
const activeThreadRunCleanupDelayMs = 5 * 60 * 1000;

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

const normalizeReasoningEffort = (value: unknown) =>
  value === 'off' || value === 'minimal' || value === 'low' || value === 'medium' || value === 'high'
    ? value
    : undefined;

const buildProviderOptions = (
  providerOptions: unknown,
  options: { reasoningEffort?: string; threadId?: unknown; resourceId?: string },
) => {
  const base = providerOptions && typeof providerOptions === 'object'
    ? providerOptions as Record<string, unknown>
    : {};
  const openai = base.openai && typeof base.openai === 'object'
    ? base.openai as Record<string, unknown>
    : {};

  return {
    ...base,
    ...(options.reasoningEffort
      ? {
          openai: {
            ...openai,
            reasoningEffort: options.reasoningEffort,
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
        const endKind = type ? bufferedAssistantEndTypes[type] : undefined;
        const id = getStreamChunkId(value);
        if (endKind && id) flushKey(getBufferedTextKey(endKind, id), { force: true });
        if (type === 'finish') flushAll();

        controller.enqueue(value);
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
  const sseStream = stream.pipeThrough(new TransformStream<unknown, string>({
    transform(chunk, controller) {
      controller.enqueue(`data: ${JSON.stringify(chunk)}\n\n`);
    },
  }));

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
};

const activeThreadRuns = new Map<string, ActiveThreadRun>();
const activeThreadRunStatuses = new Set<ActiveThreadRunStatus>(['running', 'cancelling']);

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

const toThreadRunSnapshot = (run: ActiveThreadRun | undefined) => ({
  active: isActiveThreadRun(run),
  status: run?.status ?? 'idle',
  ...(run
    ? {
        runId: run.runId,
        startedAt: run.startedAt,
        updatedAt: run.updatedAt,
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

export const getThreadRunSubmittedUserMessages = (resourceId: string | undefined, threadId: string | undefined) =>
  getThreadRun(resourceId, threadId)?.submittedUserMessages ?? [];

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
  options: { threadId?: string },
) => {
  if (!Array.isArray(messages)) return messages;
  const threadAttachments = options.threadId ? await attachmentStorage.findByThread(options.threadId) : [];

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

      const stored = await attachmentStorage.put({
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

export const __chatRouteMemoryTest = {
  latestUserMessageOnly,
  getSubmittedUserMessages,
  sanitizeSubmittedMessagesForMastra,
};

export const __chatRunRegistryTest = {
  create: createActiveThreadRun,
  submittedUserMessages: getThreadRunSubmittedUserMessages,
  append: appendThreadRunChunk,
  observe: observeThreadRun,
  cancel: cancelThreadRun,
  complete: (run: ActiveThreadRun) => settleThreadRun(run, 'completed'),
  snapshot: toThreadRunSnapshot,
  get: getThreadRun,
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
  registerApiRoute('/chat/:threadId/stream', {
    method: 'GET',
    handler: async c => {
      const resourceId = getResourceId(c);
      const threadId = c.req.param('threadId');
      const run = getActiveThreadRun(resourceId, threadId);
      if (!run) return new Response(null, { status: 204 });

      return toSseResponse(observeThreadRun(run));
    },
  }),
  registerApiRoute('/chat/:threadId/run', {
    method: 'GET',
    handler: async c => {
      const resourceId = getResourceId(c);
      const threadId = c.req.param('threadId');
      return c.json({ run: toThreadRunSnapshot(getThreadRun(resourceId, threadId)) });
    },
  }),
  registerApiRoute('/chat/:threadId/cancel', {
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
  registerApiRoute('/chat', {
    method: 'POST',
    handler: async c => {
      const params = await c.req.json();
      const mastra = c.get('mastra');
      const requestContext = c.get('requestContext');
      const resourceId = getResourceId(c);
      putChatRuntimeContext(requestContext, { now: new Date() });
      const threadId = params?.memory?.thread;
      params.messages = sanitizeSubmittedMessagesForMastra(await normalizeMessageImageAttachments(params.messages, {
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
      if (memoryPolicy?.status.observationalMemory.enabled) {
        params.messages = latestUserMessageOnly(params.messages);
      }
      const isProjectWorkspace = Boolean(resolvedProfile?.threadMetadata?.mode === 'project' && resolvedProfile.threadMetadata.workspaceId);
      const isGitProject = resolvedProfile?.projectKind === 'git';
      const isNotesProject = resolvedProfile?.projectKind === 'notes';
      markGitWorkspaceContext(requestContext, isProjectWorkspace);
      markGitProjectContext(requestContext, isGitProject);
      const system = buildChatSystemMessages({
        includeGitInstructions: isGitProject,
        includeNotesInstructions: isNotesProject,
        agentFiles: resolvedProfile?.agentFiles,
        callerSystem: params.system as Parameters<typeof buildChatSystemMessages>[0]['callerSystem'],
      });

      const routedModel = routeSubscriptionModel(params?.model);
      const reasoningEffort = normalizeReasoningEffort(params?.reasoningEffort)
        ?? normalizeReasoningEffort(resolvedProfile?.profile.reasoningEffort);
      console.info('[chat] stream request', {
        agentId,
        profileId: resolvedProfile?.profile.id,
        selectedModel: params?.model,
        routedModel,
        reasoningEffort: reasoningEffort ?? 'default',
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
          params: {
            ...params,
            ...(routedModel ? { model: routedModel } : {}),
            providerOptions: buildProviderOptions(params.providerOptions, { reasoningEffort, threadId, resourceId }),
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
