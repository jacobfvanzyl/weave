import { handleChatStream } from '@mastra/ai-sdk';
import { MASTRA_RESOURCE_ID_KEY } from '@mastra/core/request-context';
import { registerApiRoute } from '@mastra/core/server';
import { buildChatSystemMessages } from '../agents/instructions';
import { attachmentIdFromReference, attachmentModelUrl, attachmentStorage, parseBase64DataUrl, type StoredAttachmentMetadata } from '../attachments';
import { putProfileContext, resolveProfileContext } from '../profiles/resolver';

const agentId = 'mage-hand';
const activeThreadStreams = new Set<string>();
const maxImageAttachmentBytes = 10 * 1024 * 1024;

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

const releaseOnStreamClose = (stream: ReadableStream<unknown>, release: () => void) => new ReadableStream<unknown>({
  async start(controller) {
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        controller.enqueue(value);
      }
      controller.close();
    } catch (error) {
      controller.error(error);
    } finally {
      release();
      reader.releaseLock();
    }
  },
  cancel() {
    release();
    return stream.cancel().catch(() => undefined);
  },
});

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

export const chatRoutes = [
  registerApiRoute('/chat', {
    method: 'POST',
    handler: async c => {
      const params = await c.req.json();
      const mastra = c.get('mastra');
      const requestContext = c.get('requestContext');
      const contextResourceId = requestContext?.get(MASTRA_RESOURCE_ID_KEY);
      const resourceId = typeof contextResourceId === 'string' ? contextResourceId : undefined;
      const threadId = params?.memory?.thread;
      params.messages = await normalizeMessageImageAttachments(params.messages, {
        threadId: typeof threadId === 'string' ? threadId : undefined,
      });
      const resolvedProfile = resourceId
        ? await resolveProfileContext({ mastra, resourceId, threadId })
        : undefined;
      if (resolvedProfile) putProfileContext(requestContext, resolvedProfile);
      const isProjectWorkspace = Boolean(resolvedProfile?.threadMetadata?.mode === 'project' && resolvedProfile.threadMetadata.workspaceId);
      const isGitProject = resolvedProfile?.projectKind === 'git';
      markGitWorkspaceContext(requestContext, isProjectWorkspace);
      markGitProjectContext(requestContext, isGitProject);
      const system = buildChatSystemMessages({
        includeGitInstructions: isGitProject,
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
        chatgptSubscription: true,
      });

      if (typeof threadId === 'string' && activeThreadStreams.has(threadId)) {
        return c.json({ error: 'thread has an active stream' }, 409);
      }

      const releaseThreadLock = () => {
        if (typeof threadId === 'string') activeThreadStreams.delete(threadId);
      };

      if (typeof threadId === 'string') {
        activeThreadStreams.add(threadId);
        c.req.raw.signal.addEventListener('abort', releaseThreadLock, { once: true });
      }
      try {
        const stream = await handleChatStream({
          mastra,
          agentId,
          version: 'v6',
          defaultOptions: { maxSteps: 1000 },
          params: {
            ...params,
            ...(routedModel ? { model: routedModel } : {}),
            providerOptions: buildProviderOptions(params.providerOptions, { reasoningEffort, threadId, resourceId }),
            memory: params.memory && typeof params.memory === 'object'
              ? {
                  ...params.memory,
                  ...(resourceId ? { resource: resourceId } : {}),
                  ...(resolvedProfile?.profile.memory ? { options: resolvedProfile.profile.memory } : {}),
                }
              : params.memory,
            system,
            requestContext,
            abortSignal: c.req.raw.signal,
          },
        });

        const lockedStream = typeof threadId === 'string'
          ? releaseOnStreamClose(stream as ReadableStream<unknown>, releaseThreadLock)
          : stream as ReadableStream<unknown>;

        return toSseResponse(bufferAssistantTextStream(lockedStream));
      } catch (error) {
        releaseThreadLock();
        throw error;
      }
    },
  }),
];
