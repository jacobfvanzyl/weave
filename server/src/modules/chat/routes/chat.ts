import type { AgentMessageInput } from '@mastra/core/agent';
import { MASTRA_RESOURCE_ID_KEY } from '@mastra/core/request-context';
import type { AgentService } from '../../../agent/service';
import { AgentRunCoordinator, createAgentRunCoordinatorTestApi } from '../../../agent/run-coordinator';
import { defineRoute } from '../../../server/routes';
import type { ResourceService } from '../../../services/resource-service';
import { callerForOwner } from '../../../services/types';
import {
  attachmentIdFromReference,
  attachmentModelUrl,
  type AttachmentPayload,
  type AttachmentStorage,
  parseBase64DataUrl,
  type StoredAttachment,
  type StoredAttachmentMetadata,
} from '../../attachments/storage';

const maxImageAttachmentBytes = 10 * 1024 * 1024;
const sseKeepAliveIntervalMs = 15_000;

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

const getResourceId = (c: any) => {
  const resourceId = c.get('requestContext')?.get(MASTRA_RESOURCE_ID_KEY);
  if (typeof resourceId !== 'string' || !resourceId) throw new Error('Authenticated resource missing');
  return resourceId;
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

type AttachmentNormalizerStorage = Pick<AttachmentStorage, 'findByThread' | 'put'>;

const attachmentAccessForNormalization = (
  options: {
    resourceId?: string;
    threadId?: string;
    resources?: Pick<ResourceService, 'findAttachmentsByThread' | 'putAttachment'>;
    storage?: AttachmentNormalizerStorage;
  },
): AttachmentNormalizerStorage => {
  if (options.storage) return options.storage;

  const resources = options.resources;
  if (!resources) {
    return {
      findByThread: async () => [],
      put: async () => {
        throw new Error('Attachment storage is not configured for chat route normalization');
      },
    };
  }

  const caller = callerForOwner(
    options.resourceId ?? 'unknown',
    'ui',
    options.threadId ? { threadId: options.threadId } : undefined,
  );
  return {
    findByThread: (threadId: string): Promise<StoredAttachmentMetadata[]> =>
      resources.findAttachmentsByThread(caller, threadId),
    put: (input: AttachmentPayload): Promise<StoredAttachment> => resources.putAttachment(caller, input),
  };
};

const normalizeMessageImageAttachments = async (
  messages: unknown,
  options: {
    resourceId?: string;
    threadId?: string;
    resources?: Pick<ResourceService, 'findAttachmentsByThread' | 'putAttachment'>;
    storage?: AttachmentNormalizerStorage;
  },
) => {
  if (!Array.isArray(messages)) return messages;
  const storage = attachmentAccessForNormalization(options);
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
      .filter((attachment) =>
        (attachmentId ? attachment.id === attachmentId : true) &&
        (filename ? attachment.originalName === filename : true) &&
        (mediaType ? attachment.mimeType === mediaType.toLowerCase() : true)
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  };

  return Promise.all(messages.map(async (message) => {
    if (!message || typeof message !== 'object') return message;
    const record = message as Record<string, unknown>;
    if (!Array.isArray(record.parts)) return message;
    const experimentalAttachments = Array.isArray(record.experimental_attachments)
      ? record.experimental_attachments.filter((attachment) => {
        if (!attachment || typeof attachment !== 'object') return true;
        const attachmentRecord = attachment as Record<string, unknown>;
        const url = typeof attachmentRecord.url === 'string' ? attachmentRecord.url : '';
        return !url.startsWith('data:') && !attachmentIdFromReference(url);
      })
      : [];
    const nextExperimentalAttachments: Array<Record<string, unknown>> = [...experimentalAttachments];

    const parts = await Promise.all(record.parts.map(async (part) => {
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
      const dataUrl = rawData?.startsWith('data:') ? rawData : rawUrl?.startsWith('data:') ? rawUrl : undefined;
      if (!dataUrl) {
        const referencedAttachmentId = rawUrl
          ? attachmentIdFromReference(rawUrl)
          : rawData
          ? attachmentIdFromReference(rawData)
          : undefined;
        const stored = mediaType?.startsWith('image/')
          ? referencedAttachmentId
            ? threadAttachments.find((attachment) => attachment.id === referencedAttachmentId)
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
      parts: parts.filter((part) => part !== null),
      experimental_attachments: nextExperimentalAttachments.length ? nextExperimentalAttachments : undefined,
    };
  }));
};

const isDisplayOnlySubmittedPart = (part: unknown) => {
  if (!part || typeof part !== 'object') return false;
  const type = (part as Record<string, unknown>).type;
  return typeof type === 'string' &&
    (type === 'reasoning' || type === 'redacted-reasoning' || type.startsWith('data-'));
};

const sanitizeSubmittedMessagesForMastra = (messages: unknown) => {
  if (!Array.isArray(messages)) return messages;

  return messages
    .map((message) => {
      if (!message || typeof message !== 'object') return message;
      const record = message as Record<string, unknown>;
      if (!Array.isArray(record.parts)) return message;

      const parts = record.parts.filter((part) => !isDisplayOnlySubmittedPart(part));
      if (parts.length === record.parts.length) return message;

      return { ...record, parts };
    })
    .filter((message) => {
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

export const __chatRunRegistryTest = createAgentRunCoordinatorTestApi(new AgentRunCoordinator());

const unwiredAgentService = new Proxy({}, {
  get(_target, prop) {
    throw new Error(`Chat route "${String(prop)}" requires an injected AgentService`);
  },
}) as AgentService;

export const createChatRoutes = (
  service: AgentService,
  resources?: Pick<ResourceService, 'findAttachmentsByThread' | 'putAttachment'>,
) => [
  defineRoute('/chat/runs/:threadId/stream', {
    method: 'GET',
    handler: async (c) => {
      const resourceId = getResourceId(c);
      const threadId = c.req.param('threadId');
      const stream = service.observeChatRun(resourceId, threadId);
      if (!stream) return new Response(null, { status: 204 });

      return toSseResponse(stream);
    },
  }),
  defineRoute('/chat/runs/:threadId', {
    method: 'GET',
    handler: async (c) => {
      const resourceId = getResourceId(c);
      const threadId = c.req.param('threadId');
      return c.json({ run: service.getChatRun(resourceId, threadId) });
    },
  }),
  defineRoute('/chat/runs/:threadId/cancel', {
    method: 'POST',
    handler: async (c) => {
      const resourceId = getResourceId(c);
      const threadId = c.req.param('threadId');
      return c.json({ ok: true, run: service.cancelChatRun(resourceId, threadId) });
    },
  }),
  defineRoute('/chat/runs/:threadId/steer', {
    method: 'POST',
    handler: async (c) => {
      const resourceId = getResourceId(c);
      const threadId = c.req.param('threadId');
      if (!service.hasActiveThreadRun(resourceId, threadId)) {
        return c.json({ ok: false, reason: 'not_active', run: service.getChatRun(resourceId, threadId) }, 409);
      }

      const body = await c.req.json();
      const submittedMessages = Array.isArray(body?.messages) ? body.messages : body?.message ? [body.message] : [];
      const normalizedMessages = sanitizeSubmittedMessagesForMastra(
        await normalizeMessageImageAttachments(
          submittedMessagesForMemory(submittedMessages, threadId),
          { resourceId, threadId, resources },
        ),
      );
      const submittedUserMessage = getSubmittedUserMessages(normalizedMessages)[0];
      if (!submittedUserMessage) return c.json({ error: 'Steering requires a user message' }, 400);

      const result = await service.sendChatMessage({
        resourceId,
        threadId,
        message: toAgentMessageInput(submittedUserMessage),
      });

      return c.json({
        ok: true,
        accepted: result.accepted,
        runId: result.runId,
        messageId: result.messageId,
      });
    },
  }),
  defineRoute('/chat/runs', {
    method: 'POST',
    handler: async (c) => {
      const params = await c.req.json();
      const requestContext = c.get('requestContext');
      const resourceId = getResourceId(c);
      const threadId = params?.memory?.thread;
      params.messages = sanitizeSubmittedMessagesForMastra(
        await normalizeMessageImageAttachments(submittedMessagesForMemory(params.messages, threadId), {
          resourceId,
          threadId: typeof threadId === 'string' ? threadId : undefined,
          resources,
        }),
      );

      if (typeof threadId === 'string' && service.hasActiveThreadRun(resourceId, threadId)) {
        return c.json({ error: 'thread has an active stream' }, 409);
      }

      const run = await service.startChatRun({
        resourceId,
        threadId: typeof threadId === 'string' ? threadId : undefined,
        params,
        requestContext,
        submittedUserMessages: getSubmittedUserMessages(params.messages),
        abortSignal: c.req.raw.signal,
      });

      return toSseResponse(run.stream);
    },
  }),
];

export const chatRoutes = createChatRoutes(unwiredAgentService);
