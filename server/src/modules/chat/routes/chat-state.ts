import { MASTRA_RESOURCE_ID_KEY } from '@mastra/core/request-context';
import { defineRoute } from '../../../server/routes';
import type { MastraDBMessage } from '@mastra/core/agent';
import { attachmentIdFromReference, attachmentUrlPath } from '../../attachments/storage';
import { getAuthUserFromHeader } from '../../../agent/mastra/auth';
import { isCompactToolHistoryTextPart } from '../../../agent/mastra/compact-tool-history-processor';
import type { AgentService } from '../../../agent/service';
import {
  contextUsageRecallOptions,
  estimateContextTokens,
  estimateMemoryContextTokens,
} from '../../../agent/context-token-estimate';

const getToolInvocation = (part: Record<string, unknown>) =>
  typeof part.toolInvocation === 'object' && part.toolInvocation !== null
    ? (part.toolInvocation as Record<string, unknown>)
    : undefined;

const getToolName = (part: Record<string, unknown>) => {
  const invocation = getToolInvocation(part);
  if (typeof invocation?.toolName === 'string') return invocation.toolName;
  if (typeof part.toolName === 'string') return part.toolName;
  if (
    typeof part.type === 'string' && part.type.startsWith('tool-') &&
    !['tool-call', 'tool-invocation', 'tool-result'].includes(part.type)
  ) {
    return part.type.slice('tool-'.length);
  }
  return 'tool';
};

const parseJsonString = (value: unknown) => {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
};

const getToolArgs = (part: Record<string, unknown>) => {
  const invocation = getToolInvocation(part);
  return parseJsonString(invocation?.args ?? invocation?.input ?? part.args ?? part.input ?? {});
};

const getToolResult = (part: Record<string, unknown>) => {
  const invocation = getToolInvocation(part);
  return parseJsonString(invocation?.result ?? invocation?.output ?? part.result ?? part.output);
};

const absoluteAttachmentUrl = (url: string, origin: string) => {
  const attachmentId = attachmentIdFromReference(url);
  if (attachmentId) return `${origin}${attachmentUrlPath(attachmentId)}`;
  if (/^https?:\/\//i.test(url) || url.startsWith('data:') || url.startsWith('blob:')) return url;
  if (!url.startsWith('/')) return url;
  return `${origin}${url}`;
};

const toUiPart = (
  part: MastraDBMessage['content']['parts'][number],
  origin: string,
  messageId: string,
  partIndex: number,
) => {
  if (isCompactToolHistoryTextPart(part)) return null;

  if (part.type === 'text' && typeof (part as { text?: unknown }).text === 'string') {
    return { type: 'text', text: (part as { text: string }).text };
  }

  if (part.type === 'file') {
    const record = part as Record<string, unknown>;
    const metadata = record.metadata && typeof record.metadata === 'object'
      ? record.metadata as Record<string, unknown>
      : {};
    const metadataUrl = typeof metadata.attachmentUrlPath === 'string' ? metadata.attachmentUrlPath : undefined;
    const recordUrl = typeof record.url === 'string' ? record.url : undefined;
    const dataUrl = typeof record.data === 'string' && record.data.startsWith('data:') ? record.data : undefined;
    const url = metadataUrl ?? recordUrl ?? dataUrl;
    const mediaType = typeof record.mediaType === 'string'
      ? record.mediaType
      : typeof record.mimeType === 'string'
      ? record.mimeType
      : undefined;

    if (url && mediaType?.startsWith('image/')) {
      return {
        type: 'file',
        url: absoluteAttachmentUrl(url, origin),
        mediaType,
        ...(typeof record.filename === 'string' ? { filename: record.filename } : {}),
      };
    }

    return null;
  }

  if (part.type === 'reasoning') {
    const record = part as Record<string, unknown>;
    const details = Array.isArray(record.details) ? record.details : [];
    const text = details
      .map((detail) => typeof detail === 'object' && detail !== null ? (detail as { text?: unknown }).text : undefined)
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .join('\n\n')
      .trim();
    const fallback = typeof record.reasoning === 'string' ? record.reasoning.trim() : '';
    const reasoning = text || fallback;

    return reasoning ? { type: 'reasoning', text: reasoning } : null;
  }

  const record = part as Record<string, unknown>;
  const hasToolData = record.type === 'tool-call' ||
    (typeof part.type === 'string' && part.type.startsWith('tool-')) ||
    typeof record.toolCallId === 'string' ||
    typeof record.toolName === 'string';

  if (!hasToolData) return null;

  const toolName = getToolName(record);
  const result = getToolResult(record);
  const isError = Boolean(record.isError);

  return {
    type: `tool-${toolName}`,
    toolCallId: typeof getToolInvocation(record)?.toolCallId === 'string'
      ? getToolInvocation(record)!.toolCallId as string
      : typeof record.toolCallId === 'string'
      ? record.toolCallId
      : `${messageId}-${partIndex}-${toolName}`,
    state: result === undefined ? 'input-available' : isError ? 'output-error' : 'output-available',
    input: getToolArgs(record),
    output: result,
    errorText: isError ? (typeof result === 'string' ? result : JSON.stringify(result)) : undefined,
  };
};

const toUiAttachmentPart = (attachment: unknown, origin: string) => {
  if (!attachment || typeof attachment !== 'object') return null;
  const record = attachment as Record<string, unknown>;
  const url = typeof record.url === 'string' ? record.url : undefined;
  const mediaType = typeof record.contentType === 'string' ? record.contentType : undefined;
  if (!url || !mediaType?.startsWith('image/')) return null;

  const attachmentId = attachmentIdFromReference(url);
  return {
    type: 'file',
    url: absoluteAttachmentUrl(url, origin),
    mediaType,
    ...(attachmentId ? { metadata: { attachmentId, attachmentUrlPath: attachmentUrlPath(attachmentId) } } : {}),
  };
};

type UiChatMessage = {
  id: string;
  role: string;
  parts: Array<Record<string, unknown>>;
  status?: { type: string };
  metadata?: unknown;
};

const getPendingMessageText = (message: UiChatMessage) =>
  message.parts
    .map((part) => part.type === 'text' && typeof part.text === 'string' ? part.text : '')
    .join('')
    .trim();

const getPendingAttachmentSignature = (message: UiChatMessage) =>
  message.parts
    .filter((part) => part.type === 'file')
    .map((part) =>
      `${typeof part.url === 'string' ? part.url : ''}:${typeof part.mediaType === 'string' ? part.mediaType : ''}`
    )
    .sort()
    .join('|');

const getPendingMessageSignature = (message: UiChatMessage) =>
  `${message.role}:${getPendingMessageText(message)}:${getPendingAttachmentSignature(message)}`;

const mergePendingSubmittedMessages = (messages: UiChatMessage[], pendingMessages: UiChatMessage[]) => {
  if (pendingMessages.length === 0) return messages;

  const existingIds = new Set(messages.map((message) => message.id));
  const existingSignatures = new Set(messages.map(getPendingMessageSignature));
  const merged = [...messages];

  for (const pendingMessage of pendingMessages) {
    const signature = getPendingMessageSignature(pendingMessage);
    if (existingIds.has(pendingMessage.id) || existingSignatures.has(signature)) continue;

    merged.push(pendingMessage);
    existingIds.add(pendingMessage.id);
    existingSignatures.add(signature);
  }

  return merged;
};

const toPendingSubmittedMessage = (message: unknown, origin: string, index: number): UiChatMessage | null => {
  if (!message || typeof message !== 'object') return null;

  const record = message as Record<string, unknown>;
  if (record.role !== 'user') return null;

  const messageId = typeof record.id === 'string' && record.id.trim() ? record.id : `pending-user-${index}`;
  const metadata = record.metadata as Record<string, unknown> | undefined;
  const originalText = typeof metadata?.slashCommandOriginalText === 'string'
    ? metadata.slashCommandOriginalText
    : undefined;
  const attachments = Array.isArray(record.experimental_attachments)
    ? record.experimental_attachments.map((attachment) => toUiAttachmentPart(attachment, origin)).filter((part) =>
      part !== null
    )
    : [];
  const parts = Array.isArray(record.parts)
    ? record.parts.map((part, partIndex) =>
      toUiPart(part as MastraDBMessage['content']['parts'][number], origin, messageId, partIndex)
    ).filter((part) => part !== null)
    : typeof record.content === 'string'
    ? [{ type: 'text', text: record.content }]
    : [];

  return {
    id: messageId,
    role: 'user',
    parts: originalText ? [{ type: 'text', text: originalText }, ...attachments] : [...parts, ...attachments],
    ...(record.metadata !== undefined ? { metadata: record.metadata } : {}),
  };
};

const toUiMessage = (message: MastraDBMessage, origin: string) => {
  const metadata = message.content.metadata as Record<string, unknown> | undefined;
  const originalText = message.role === 'user' && typeof metadata?.slashCommandOriginalText === 'string'
    ? metadata.slashCommandOriginalText
    : undefined;
  const attachments = Array.isArray(message.content.experimental_attachments)
    ? message.content.experimental_attachments.map((attachment) => toUiAttachmentPart(attachment, origin)).filter(
      (part) => part !== null,
    )
    : [];

  return {
    id: message.id,
    role: message.role,
    parts: originalText ? [{ type: 'text', text: originalText }, ...attachments] : [
      ...message.content.parts.map((part, index) => toUiPart(part, origin, message.id, index)).filter((part) =>
        part !== null
      ),
      ...attachments,
    ],
    status: message.role === 'assistant' ? { type: 'complete' } : undefined,
    metadata: message.content.metadata,
  } satisfies UiChatMessage;
};

const getResourceId = (c: any) => {
  const resourceId = c.get('requestContext')?.get(MASTRA_RESOURCE_ID_KEY);
  if (typeof resourceId !== 'string' || !resourceId) throw new Error('Authenticated resource missing');
  return resourceId;
};

const errorResponse = (c: any, error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const status = typeof (error as { status?: unknown })?.status === 'number'
    ? (error as { status: number }).status
    : 500;
  console.error('[chat-state]', error);
  return c.json({ error: message }, status);
};

const unwiredAgentService = new Proxy({}, {
  get(_target, prop) {
    throw new Error(`Chat state route "${String(prop)}" requires an injected AgentService`);
  },
}) as AgentService;

export const createChatStateRoutes = (service: AgentService) => [
  defineRoute('/owner/me', {
    method: 'GET',
    handler: async (c) => {
      try {
        const user = getAuthUserFromHeader(c.req.header('Authorization'));
        if (!user) return c.json({ error: 'Unauthorized' }, 401);

        return c.json({ user: { id: user.id, name: user.name } });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  defineRoute('/chat/threads', {
    method: 'GET',
    handler: async (c) => {
      try {
        const resourceId = getResourceId(c);

        return c.json({ threads: await service.listChatThreads({ resourceId }) });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  defineRoute('/chat/threads', {
    method: 'POST',
    handler: async (c) => {
      try {
        const body = await c.req.json();
        const resourceId = getResourceId(c);
        const threadId = body?.threadId;
        const title = body?.title ?? '...';
        const projectId = typeof body?.projectId === 'string' ? body.projectId : undefined;
        const workspaceId = typeof body?.workspaceId === 'string' ? body.workspaceId : undefined;

        const thread = await service.createChatThread({
          resourceId,
          threadId,
          title,
          projectId,
          workspaceId,
        });

        return c.json({ thread });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  defineRoute('/chat/threads/reorder', {
    method: 'PATCH',
    handler: async (c) => {
      try {
        const resourceId = getResourceId(c);
        const body = await c.req.json();
        const threadIds = Array.isArray(body?.threadIds)
          ? body.threadIds.filter((id: unknown) => typeof id === 'string')
          : [];
        const scope = body?.scope as Record<string, unknown> | undefined;
        const scopeProjectId = typeof scope?.projectId === 'string' ? scope.projectId : undefined;
        const scopeWorkspaceId = typeof scope?.workspaceId === 'string' ? scope.workspaceId : undefined;
        const plain = scope?.plain === true;

        await service.reorderChatThreads({
          resourceId,
          threadIds,
          scope: {
            ...(scopeProjectId ? { projectId: scopeProjectId } : {}),
            ...(scopeWorkspaceId ? { workspaceId: scopeWorkspaceId } : {}),
            ...(plain ? { plain } : {}),
          },
        });

        return c.json({ ok: true });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  defineRoute('/chat/threads/:threadId/raw-messages', {
    method: 'GET',
    handler: async (c) => {
      try {
        const resourceId = getResourceId(c);
        const threadId = c.req.param('threadId');

        return c.json({ messages: await service.getChatThreadRawMessages({ resourceId, threadId }) });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  defineRoute('/chat/threads/:threadId/context-usage', {
    method: 'GET',
    handler: async (c) => {
      try {
        const resourceId = getResourceId(c);
        const threadId = c.req.param('threadId');
        const queryContextWindow = Number(c.req.query('contextWindow'));

        return c.json(
          await service.getChatThreadContextUsage({
            threadId,
            resourceId,
            queryContextWindow,
          }),
        );
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  defineRoute('/chat/threads/:threadId/messages', {
    method: 'GET',
    handler: async (c) => {
      try {
        const resourceId = getResourceId(c);
        const threadId = c.req.param('threadId');

        const origin = new URL(c.req.url).origin;
        const persistedMessages = (await service.getChatThreadMessages({ resourceId, threadId }))
          .map((message: MastraDBMessage) => toUiMessage(message, origin));
        const pendingMessages = service.getChatSubmittedUserMessages(resourceId, threadId)
          .map((message, index) => toPendingSubmittedMessage(message, origin, index))
          .filter((message): message is UiChatMessage => message !== null);
        const pendingRunMessages = service.getChatUiMessages(resourceId, threadId) as UiChatMessage[];
        const shouldAppendRunMessages = pendingRunMessages.length > 0 &&
          (pendingMessages.length > 0 || persistedMessages[persistedMessages.length - 1]?.role !== 'assistant');

        return c.json({
          messages: mergePendingSubmittedMessages(
            persistedMessages,
            shouldAppendRunMessages ? [...pendingMessages, ...pendingRunMessages] : pendingMessages,
          ),
        });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  defineRoute('/chat/threads/:threadId', {
    method: 'PATCH',
    handler: async (c) => {
      try {
        const resourceId = getResourceId(c);
        const threadId = c.req.param('threadId');
        const body = await c.req.json();
        const title = typeof body?.title === 'string' ? body.title.trim() : '';
        const hasArchived = typeof body?.archived === 'boolean';
        if (!title && !hasArchived) return c.json({ error: 'title or archived is required' }, 400);

        const thread = await service.updateChatThread({
          resourceId,
          threadId,
          ...(title ? { title } : {}),
          ...(hasArchived ? { archived: body.archived } : {}),
        });

        return c.json({ thread });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  defineRoute('/chat/threads/:threadId', {
    method: 'DELETE',
    handler: async (c) => {
      try {
        const resourceId = getResourceId(c);
        const threadId = c.req.param('threadId');

        await service.deleteChatThread({ resourceId, threadId });
        return c.json({ ok: true });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
];

export const chatStateRoutes = createChatStateRoutes(unwiredAgentService);

export const __chatStateContextUsageTest = {
  contextUsageRecallOptions,
  estimateContextTokens,
  estimateMemoryContextTokens,
  toUiMessage,
  toPendingSubmittedMessage,
  mergePendingSubmittedMessages,
};
