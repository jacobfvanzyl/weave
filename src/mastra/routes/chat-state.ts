import { MASTRA_RESOURCE_ID_KEY } from '@mastra/core/request-context';
import { registerApiRoute } from '@mastra/core/server';
import type { MastraDBMessage } from '@mastra/core/agent';

const agentId = 'mageHandAgent';

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

const toUiMessage = (message: MastraDBMessage) => ({
  id: message.id,
  role: message.role,
  parts: message.content.parts.map(toUiPart).filter(part => part !== null),
  status: message.role === 'assistant' ? { type: 'complete' } : undefined,
  metadata: message.content.metadata,
});

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
          result.threads.map(async thread => {
            if (thread.title && thread.title !== 'New chat') return thread;

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

        return c.json({ threads });
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
        const title = body?.title ?? 'New chat';

        const memory = await getMemory(c);
        const thread = await memory.createThread({
          resourceId,
          threadId,
          title,
          saveThread: true,
        });

        return c.json({ thread });
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
        if (!title) return c.json({ error: 'title is required' }, 400);

        const memory = await getMemory(c);
        const thread = await memory.getThreadById({ threadId });
        if (!thread || thread.resourceId !== resourceId) return c.json({ error: 'thread not found' }, 404);

        const updatedThread = await memory.updateThread({
          id: threadId,
          title,
          metadata: thread.metadata,
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
