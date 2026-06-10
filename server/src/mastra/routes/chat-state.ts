import { MASTRA_RESOURCE_ID_KEY } from '@mastra/core/request-context';
import { registerApiRoute } from '@mastra/core/server';
import type { MastraDBMessage } from '@mastra/core/agent';
import { getAuthUserFromHeader } from '../auth';
import { attachmentIdFromReference, attachmentUrlPath } from '../attachments';
import { isCompactToolHistoryTextPart } from '../compact-tool-history-processor';
import { getThreadContextUsageSnapshot } from '../context-usage';
import { resolveMemoryPolicy } from '../memory-policy';
import { resolveProfileContext } from '../profiles/resolver';
import { isHiddenThread } from './thread-visibility';

const agentId = 'mageHandAgent';

type MastraThread = {
  id: string;
  title?: string;
  updatedAt?: string;
  metadata?: unknown;
};

const timestampString = (value: unknown) => typeof value === 'string' ? value : value instanceof Date ? value.toISOString() : '';

const getTopSortOrder = async (memory: any, resourceId: string, scope: { projectId?: string; workspaceId?: string }) => {
  const result = await memory.listThreads({ filter: { resourceId }, perPage: false });
  const orders = result.threads
    .filter((thread: any) => !isHiddenThread(thread))
    .filter((thread: any) => {
      const metadata = (thread.metadata ?? {}) as Record<string, unknown>;
      if (metadata.archived === true) return false;
      if (scope.projectId) return metadata.projectId === scope.projectId && metadata.workspaceId === scope.workspaceId;
      return metadata.adHoc === true || (metadata.mode !== 'project' && typeof metadata.projectId !== 'string');
    })
    .map((thread: any) => (thread.metadata as Record<string, unknown> | undefined)?.sortOrder)
    .filter((value: unknown): value is number => typeof value === 'number');
  return orders.length ? Math.min(...orders) - 1 : 0;
};

const getToolInvocation = (part: Record<string, unknown>) =>
  typeof part.toolInvocation === 'object' && part.toolInvocation !== null
    ? (part.toolInvocation as Record<string, unknown>)
    : undefined;

const getToolName = (part: Record<string, unknown>) => {
  const invocation = getToolInvocation(part);
  if (typeof invocation?.toolName === 'string') return invocation.toolName;
  if (typeof part.toolName === 'string') return part.toolName;
  if (typeof part.type === 'string' && part.type.startsWith('tool-') && !['tool-call', 'tool-invocation', 'tool-result'].includes(part.type)) {
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

const toUiPart = (part: MastraDBMessage['content']['parts'][number], origin: string) => {
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
      .map(detail => typeof detail === 'object' && detail !== null ? (detail as { text?: unknown }).text : undefined)
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .join('\n\n')
      .trim();
    const fallback = typeof record.reasoning === 'string' ? record.reasoning.trim() : '';
    const reasoning = text || fallback;

    return reasoning ? { type: 'reasoning', text: reasoning } : null;
  }

  const record = part as Record<string, unknown>;
  const hasToolData =
    record.type === 'tool-call' ||
    (typeof part.type === 'string' && part.type.startsWith('tool-')) ||
    typeof record.toolCallId === 'string' ||
    typeof record.toolName === 'string';

  if (!hasToolData) return null;

  const toolName = getToolName(record);
  const result = getToolResult(record);
  const isError = Boolean(record.isError);

  return {
    type: `tool-${toolName}`,
    toolCallId:
      typeof getToolInvocation(record)?.toolCallId === 'string'
        ? getToolInvocation(record)!.toolCallId as string
        : typeof record.toolCallId === 'string'
          ? record.toolCallId
          : `${toolName}-${Math.random().toString(36).slice(2)}`,
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

const toUiMessage = (message: MastraDBMessage, origin: string) => {
  const metadata = message.content.metadata as Record<string, unknown> | undefined;
  const originalText = message.role === 'user' && typeof metadata?.slashCommandOriginalText === 'string'
    ? metadata.slashCommandOriginalText
    : undefined;
  const attachments = Array.isArray(message.content.experimental_attachments)
    ? message.content.experimental_attachments.map(attachment => toUiAttachmentPart(attachment, origin)).filter(part => part !== null)
    : [];

  return {
    id: message.id,
    role: message.role,
    parts: originalText
      ? [{ type: 'text', text: originalText }, ...attachments]
      : [...message.content.parts.map(part => toUiPart(part, origin)).filter(part => part !== null), ...attachments],
    status: message.role === 'assistant' ? { type: 'complete' } : undefined,
    metadata: message.content.metadata,
  };
};

const getRenameTitle = (message: MastraDBMessage) => {
  for (const part of message.content.parts) {
    const record = part as Record<string, unknown>;
    if (getToolName(record) !== 'renameThreadTool' && getToolName(record) !== 'rename-thread') continue;

    const result = getToolResult(record);
    if (typeof result === 'object' && result !== null && typeof (result as { title?: unknown }).title === 'string') {
      return (result as { title: string }).title.trim();
    }

    const args = getToolArgs(record);
    if (typeof args === 'object' && args !== null && typeof (args as { title?: unknown }).title === 'string') {
      return (args as { title: string }).title.trim();
    }
  }

  return '';
};

const messageTextForTokenEstimate = (message: MastraDBMessage) => message.content.parts
  .map(part => {
    const record = part as Record<string, unknown>;
    if (typeof record.text === 'string') return record.text;
    if (typeof record.result === 'string') return record.result;
    if (record.result !== undefined) return JSON.stringify(record.result);
    if (record.output !== undefined) return typeof record.output === 'string' ? record.output : JSON.stringify(record.output);
    return JSON.stringify(record);
  })
  .filter(Boolean)
  .join('\n');

const estimateContextTokens = (memory: any, messages: MastraDBMessage[]) => messages.reduce((total, message) => {
  const text = messageTextForTokenEstimate(message);
  return total + (typeof memory.estimateTokens === 'function' ? memory.estimateTokens(text) : Math.ceil(text.length / 4));
}, 0);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const contextUsageRecallOptions = (
  threadId: string,
  resourceId: string,
  threadConfig: unknown,
) => ({
  threadId,
  resourceId,
  ...(isRecord(threadConfig) ? { threadConfig } : {}),
});

const getThreadTitleFromMessages = (messages: MastraDBMessage[]) => {
  for (const message of messages) {
    const title = getRenameTitle(message);
    if (title) return title;
  }

  return '';
};

const getMastra = (c: any) => {
  const mastra = c.get('mastra');
  if (!mastra) throw new Error('Mastra instance missing from route context');
  return mastra;
};

const getMemory = async (c: any) => {
  const mastra = getMastra(c);
  const agent = await mastra.getAgent(agentId);
  const memory = await agent.getMemory();

  if (!memory) {
    throw new Error(`${agentId} has no memory configured`);
  }

  return memory;
};

const getResourceId = (c: any) => {
  const resourceId = c.get('requestContext')?.get(MASTRA_RESOURCE_ID_KEY);
  if (typeof resourceId !== 'string' || !resourceId) throw new Error('Authenticated resource missing');
  return resourceId;
};

const errorResponse = (c: any, error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('[chat-state]', error);
  return c.json({ error: message }, 500);
};

export const chatStateRoutes = [
  registerApiRoute('/chat-state/me', {
    method: 'GET',
    handler: async c => {
      try {
        const user = getAuthUserFromHeader(c.req.header('Authorization'));
        if (!user) return c.json({ error: 'Unauthorized' }, 401);

        return c.json({ user: { id: user.id, name: user.name } });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  registerApiRoute('/chat-state/threads', {
    method: 'GET',
    handler: async c => {
      try {
        const resourceId = getResourceId(c);

        const memory = await getMemory(c);
        const result = await memory.listThreads({
          filter: { resourceId },
          perPage: false,
          orderBy: { field: 'updatedAt', direction: 'DESC' },
        });

        const threads = await Promise.all(
          result.threads.filter((thread: MastraThread) => !isHiddenThread(thread)).map(async (thread: MastraThread) => {
            if (thread.title && !['New chat', '...'].includes(thread.title)) return thread;

            const messages = await memory.recall({
              threadId: thread.id,
              resourceId,
              perPage: false,
              orderBy: { field: 'createdAt', direction: 'ASC' },
            });
            const title = getThreadTitleFromMessages(messages.messages);

            return title ? { ...thread, title } : thread;
          }),
        );

        const sortedThreads = threads.sort((a, b) => {
          const aOrder = typeof (a.metadata as Record<string, unknown> | undefined)?.sortOrder === 'number' ? (a.metadata as Record<string, number>).sortOrder : Number.MAX_SAFE_INTEGER;
          const bOrder = typeof (b.metadata as Record<string, unknown> | undefined)?.sortOrder === 'number' ? (b.metadata as Record<string, number>).sortOrder : Number.MAX_SAFE_INTEGER;
          return aOrder - bOrder || timestampString(b.updatedAt).localeCompare(timestampString(a.updatedAt));
        });

        return c.json({ threads: sortedThreads });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  registerApiRoute('/chat-state/threads', {
    method: 'POST',
    handler: async c => {
      try {
        const body = await c.req.json();
        const resourceId = getResourceId(c);
        const threadId = body?.threadId;
        const title = body?.title ?? '...';
        const projectId = typeof body?.projectId === 'string' ? body.projectId : undefined;
        const workspaceId = typeof body?.workspaceId === 'string' ? body.workspaceId : undefined;
        const profileId = typeof body?.profileId === 'string' && body.profileId.trim() ? body.profileId.trim() : undefined;

        const memory = await getMemory(c);
        const sortOrder = await getTopSortOrder(memory, resourceId, { projectId, workspaceId });
        const metadata = projectId
          ? { mode: 'project', projectId, workspaceId, sortOrder, ...(profileId ? { profileId } : {}) }
          : { mode: 'plain', sortOrder, ...(profileId ? { profileId } : {}) };
        const thread = await memory.createThread({
          resourceId,
          threadId,
          title,
          metadata,
          saveThread: true,
        });

        return c.json({ thread });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  registerApiRoute('/chat-state/threads/reorder', {
    method: 'PATCH',
    handler: async c => {
      try {
        const resourceId = getResourceId(c);
        const body = await c.req.json();
        const threadIds = Array.isArray(body?.threadIds) ? body.threadIds.filter((id: unknown) => typeof id === 'string') : [];
        const scope = body?.scope as Record<string, unknown> | undefined;
        const scopeProjectId = typeof scope?.projectId === 'string' ? scope.projectId : undefined;
        const scopeWorkspaceId = typeof scope?.workspaceId === 'string' ? scope.workspaceId : undefined;
        const plain = scope?.plain === true;

        const memory = await getMemory(c);
        const result = await memory.listThreads({ filter: { resourceId }, perPage: false });
        const visibleThreads = result.threads.filter((thread: MastraThread) => !isHiddenThread(thread));
        const scopedThreads = visibleThreads.filter((thread: MastraThread) => {
          const metadata = (thread.metadata ?? {}) as Record<string, unknown>;
          if (metadata.archived === true) return false;
          if (plain) return metadata.adHoc === true || (metadata.mode !== 'project' && typeof metadata.projectId !== 'string');
          if (scopeWorkspaceId) return metadata.projectId === scopeProjectId && metadata.workspaceId === scopeWorkspaceId;
          if (scopeProjectId) return metadata.projectId === scopeProjectId && typeof metadata.workspaceId !== 'string';
          return false;
        });
        const scopedIds = new Set(scopedThreads.map((thread: MastraThread) => thread.id));
        if (threadIds.length !== scopedIds.size || threadIds.some((id: string) => !scopedIds.has(id))) {
          return c.json({ error: 'threadIds must include all threads in scope' }, 400);
        }

        await Promise.all(threadIds.map(async (id: string, index: number) => {
          const thread = scopedThreads.find((item: MastraThread) => item.id === id)!;
          const metadata = { ...((thread.metadata ?? {}) as Record<string, unknown>), sortOrder: index };
          await memory.updateThread({ id, title: thread.title, metadata });
        }));

        return c.json({ ok: true });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  registerApiRoute('/chat-state/threads/:threadId/raw-messages', {
    method: 'GET',
    handler: async c => {
      try {
        const resourceId = getResourceId(c);
        const threadId = c.req.param('threadId');

        const memory = await getMemory(c);
        const result = await memory.recall({
          threadId,
          resourceId,
          perPage: false,
          orderBy: { field: 'createdAt', direction: 'ASC' },
        });

        return c.json({ messages: result.messages });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('No thread found')) return c.json({ messages: [] });
        return errorResponse(c, error);
      }
    },
  }),
  registerApiRoute('/chat-state/threads/:threadId/context-usage', {
    method: 'GET',
    handler: async c => {
      try {
        const resourceId = getResourceId(c);
        const threadId = c.req.param('threadId');
        const mastra = getMastra(c);
        const memory = await getMemory(c);
        const resolvedProfile = await resolveProfileContext({ mastra, resourceId, threadId });
        const memoryPolicy = resolveMemoryPolicy({
          profileMemory: resolvedProfile.profile.memory,
          threadMetadata: resolvedProfile.threadMetadata,
        });
        const recalled = await memory.recall({
          ...contextUsageRecallOptions(threadId, resourceId, memoryPolicy.options),
        });
        const queryContextWindow = Number(c.req.query('contextWindow'));
        const snapshot = getThreadContextUsageSnapshot(threadId, resourceId);
        const contextWindow = Number.isFinite(queryContextWindow) && queryContextWindow > 0
          ? queryContextWindow
          : typeof snapshot?.maxTokens === 'number'
            ? snapshot.maxTokens
            : typeof memory.MAX_CONTEXT_TOKENS === 'number'
            ? memory.MAX_CONTEXT_TOKENS
            : undefined;
        const tokens = snapshot?.usedTokens ?? estimateContextTokens(memory, recalled.messages);
        return c.json({
          tokens,
          contextWindow,
          percent: contextWindow ? Math.min(100, (tokens / contextWindow) * 100) : undefined,
          source: snapshot ? snapshot.source : 'estimate',
          updatedAt: snapshot?.updatedAt,
          totalProcessedTokens: snapshot?.totalProcessedTokens,
          inputTokens: snapshot?.inputTokens,
          cachedInputTokens: snapshot?.cachedInputTokens,
          outputTokens: snapshot?.outputTokens,
          memoryPolicy: {
            options: memoryPolicy.options,
            status: memoryPolicy.status,
          },
        });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  registerApiRoute('/chat-state/threads/:threadId/messages', {
    method: 'GET',
    handler: async c => {
      try {
        const resourceId = getResourceId(c);
        const threadId = c.req.param('threadId');

        const memory = await getMemory(c);
        const result = await memory.recall({
          threadId,
          resourceId,
          perPage: false,
          orderBy: { field: 'createdAt', direction: 'ASC' },
        });

        const origin = new URL(c.req.url).origin;
        return c.json({ messages: result.messages.map((message: MastraDBMessage) => toUiMessage(message, origin)) });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('No thread found')) return c.json({ messages: [] });
        return errorResponse(c, error);
      }
    },
  }),
  registerApiRoute('/chat-state/threads/:threadId', {
    method: 'PATCH',
    handler: async c => {
      try {
        const resourceId = getResourceId(c);
        const threadId = c.req.param('threadId');
        const body = await c.req.json();
        const title = typeof body?.title === 'string' ? body.title.trim() : '';
        const hasArchived = typeof body?.archived === 'boolean';
        const hasProfileId = body?.profileId === null || typeof body?.profileId === 'string';
        if (!title && !hasArchived && !hasProfileId) return c.json({ error: 'title, archived, or profileId is required' }, 400);

        const memory = await getMemory(c);
        const thread = await memory.getThreadById({ threadId });
        if (!thread || thread.resourceId !== resourceId) return c.json({ error: 'thread not found' }, 404);

        const metadata = { ...((thread.metadata ?? {}) as Record<string, unknown>) };
        if (hasArchived) metadata.archived = body.archived;
        if (hasProfileId) {
          const profileId = typeof body.profileId === 'string' ? body.profileId.trim() : '';
          if (profileId) metadata.profileId = profileId;
          else delete metadata.profileId;
        }
        const updatedThread = await memory.updateThread({
          id: threadId,
          title: title || thread.title,
          metadata,
        });

        return c.json({ thread: updatedThread });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  registerApiRoute('/chat-state/threads/:threadId', {
    method: 'DELETE',
    handler: async c => {
      try {
        const resourceId = getResourceId(c);
        const threadId = c.req.param('threadId');

        const memory = await getMemory(c);
        const thread = await memory.getThreadById({ threadId });
        if (!thread || thread.resourceId !== resourceId) return c.json({ error: 'thread not found' }, 404);

        await memory.deleteThread(threadId);
        return c.json({ ok: true });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
];

export const __chatStateContextUsageTest = {
  contextUsageRecallOptions,
  estimateContextTokens,
  toUiMessage,
};
