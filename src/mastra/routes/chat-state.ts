import { registerApiRoute } from '@mastra/core/server';
import type { MastraDBMessage } from '@mastra/core/agent';

const agentId = 'weatherAgent';

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

  const record = part as Record<string, unknown>;
  const hasToolData =
    part.type === 'tool-call' ||
    (typeof part.type === 'string' && part.type.startsWith('tool-')) ||
    typeof record.toolCallId === 'string' ||
    typeof record.toolName === 'string';

  if (!hasToolData) return null;

  return {
    type: 'tool-call',
    toolCallId:
      typeof getToolInvocation(record)?.toolCallId === 'string'
        ? getToolInvocation(record)!.toolCallId as string
        : typeof record.toolCallId === 'string'
          ? record.toolCallId
          : `${getToolName(record)}-${Math.random().toString(36).slice(2)}`,
    toolName: getToolName(record),
    args: getToolArgs(record),
    result: getToolResult(record),
    isError: Boolean(record.isError),
    argsText: JSON.stringify(getToolArgs(record), null, 2),
  };
};

const toUiMessage = (message: MastraDBMessage) => ({
  id: message.id,
  role: message.role,
  parts: message.content.parts.map(toUiPart).filter(part => part !== null),
  metadata: message.content.metadata,
});

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
        const resourceId = c.req.query('resourceId');
        if (!resourceId) return c.json({ error: 'resourceId is required' }, 400);

        const memory = await getMemory(c);
        const result = await memory.listThreads({
          filter: { resourceId },
          perPage: false,
          orderBy: { field: 'updatedAt', direction: 'DESC' },
        });

        return c.json({ threads: result.threads });
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
        const resourceId = body?.resourceId;
        const threadId = body?.threadId;
        const title = body?.title ?? 'New chat';

        if (!resourceId) return c.json({ error: 'resourceId is required' }, 400);

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
  registerApiRoute('/chat-state/threads/:threadId/messages', {
    method: 'GET',
    handler: async c => {
      try {
        const resourceId = c.req.query('resourceId');
        const threadId = c.req.param('threadId');
        if (!resourceId) return c.json({ error: 'resourceId is required' }, 400);

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
        const resourceId = c.req.query('resourceId');
        const threadId = c.req.param('threadId');
        const body = await c.req.json();
        const title = typeof body?.title === 'string' ? body.title.trim() : '';
        if (!resourceId) return c.json({ error: 'resourceId is required' }, 400);
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
        const resourceId = c.req.query('resourceId');
        const threadId = c.req.param('threadId');
        if (!resourceId) return c.json({ error: 'resourceId is required' }, 400);

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
