import { MASTRA_RESOURCE_ID_KEY } from '@mastra/core/request-context';
import { registerApiRoute } from '@mastra/core/server';
import type { MastraDBMessage } from '@mastra/core/agent';
import { getAuthUserFromHeader } from '../auth';

const agentId = 'mageHandAgent';
const hiddenThreadPrefixes = ['__plane__', '__portal__'];

const isHiddenThread = (thread: { id: string; metadata?: unknown }) => {
  const metadata = thread.metadata as Record<string, unknown> | undefined;
  return hiddenThreadPrefixes.some(prefix => thread.id.startsWith(prefix)) || metadata?.kind === 'plane' || metadata?.kind === 'portal-token';
};

const timestampString = (value: unknown) => typeof value === 'string' ? value : value instanceof Date ? value.toISOString() : '';

const getTopSortOrder = async (memory: any, resourceId: string, scope: { planeId?: string; demiplaneId?: string }) => {
  const result = await memory.listThreads({ filter: { resourceId }, perPage: false });
  const orders = result.threads
    .filter((thread: any) => !isHiddenThread(thread))
    .filter((thread: any) => {
      const metadata = (thread.metadata ?? {}) as Record<string, unknown>;
      if (metadata.archived === true) return false;
      if (scope.planeId) return metadata.planeId === scope.planeId && metadata.demiplaneId === scope.demiplaneId;
      return metadata.mode !== 'plane' && typeof metadata.planeId !== 'string';
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

const getToolArgs = (part: Record<string, unknown>) => {
  const invocation = getToolInvocation(part);
  return invocation?.args ?? part.args ?? part.input ?? {};
};

const getToolResult = (part: Record<string, unknown>) => {
  const invocation = getToolInvocation(part);
  return invocation?.result ?? part.result ?? part.output;
};

const toUiPart = (part: MastraDBMessage['content']['parts'][number]) => {
  if (part.type === 'text' && typeof (part as { text?: unknown }).text === 'string') {
    return { type: 'text', text: (part as { text: string }).text };
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
    part.type === 'tool-call' ||
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

const toUiMessage = (message: MastraDBMessage) => {
  const metadata = message.content.metadata as Record<string, unknown> | undefined;
  const originalText = message.role === 'user' && typeof metadata?.slashCommandOriginalText === 'string'
    ? metadata.slashCommandOriginalText
    : undefined;

  return {
    id: message.id,
    role: message.role,
    parts: originalText ? [{ type: 'text', text: originalText }] : message.content.parts.map(toUiPart).filter(part => part !== null),
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

const getThreadTitleFromMessages = (messages: MastraDBMessage[]) => {
  for (const message of messages) {
    const title = getRenameTitle(message);
    if (title) return title;
  }

  return '';
};

const getMemory = async (c: any) => {
  const mastra = c.get('mastra');
  if (!mastra) throw new Error('Mastra instance missing from route context');

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
          result.threads.filter(thread => !isHiddenThread(thread)).map(async thread => {
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
        const planeId = typeof body?.planeId === 'string' ? body.planeId : undefined;
        const demiplaneId = typeof body?.demiplaneId === 'string' ? body.demiplaneId : undefined;

        const memory = await getMemory(c);
        const sortOrder = await getTopSortOrder(memory, resourceId, { planeId, demiplaneId });
        const metadata = planeId ? { mode: 'plane', planeId, demiplaneId, sortOrder } : { mode: 'plain', sortOrder };
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
        const scopePlaneId = typeof scope?.planeId === 'string' ? scope.planeId : undefined;
        const scopeDemiplaneId = typeof scope?.demiplaneId === 'string' ? scope.demiplaneId : undefined;
        const plain = scope?.plain === true;

        const memory = await getMemory(c);
        const result = await memory.listThreads({ filter: { resourceId }, perPage: false });
        const visibleThreads = result.threads.filter(thread => !isHiddenThread(thread));
        const scopedThreads = visibleThreads.filter(thread => {
          const metadata = (thread.metadata ?? {}) as Record<string, unknown>;
          if (metadata.archived === true) return false;
          if (plain) return metadata.mode !== 'plane' && typeof metadata.planeId !== 'string';
          if (scopeDemiplaneId) return metadata.planeId === scopePlaneId && metadata.demiplaneId === scopeDemiplaneId;
          if (scopePlaneId) return metadata.planeId === scopePlaneId && typeof metadata.demiplaneId !== 'string';
          return false;
        });
        const scopedIds = new Set(scopedThreads.map(thread => thread.id));
        if (threadIds.length !== scopedIds.size || threadIds.some(id => !scopedIds.has(id))) {
          return c.json({ error: 'threadIds must include all threads in scope' }, 400);
        }

        await Promise.all(threadIds.map(async (id, index) => {
          const thread = scopedThreads.find(item => item.id === id)!;
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

        return c.json({ messages: result.messages.map(toUiMessage) });
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
        if (!title && !hasArchived) return c.json({ error: 'title or archived is required' }, 400);

        const memory = await getMemory(c);
        const thread = await memory.getThreadById({ threadId });
        if (!thread || thread.resourceId !== resourceId) return c.json({ error: 'thread not found' }, 404);

        const metadata = { ...((thread.metadata ?? {}) as Record<string, unknown>) };
        if (hasArchived) metadata.archived = body.archived;
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
