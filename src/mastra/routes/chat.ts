import { handleChatStream } from '@mastra/ai-sdk';
import { MASTRA_RESOURCE_ID_KEY } from '@mastra/core/request-context';
import { registerApiRoute } from '@mastra/core/server';
import { buildChatSystemMessages, type ProjectAgentInstructions } from '../agents/instructions';
import { requestPortalTool } from '../portal/registry';

const agentId = 'mageHandAgent';
const planeThreadId = (planeId: string) => `__plane__${planeId}`;
const agentInstructionsRefreshMs = 60_000;
const activeThreadStreams = new Set<string>();

const getMemory = async (mastra: any) => {
  const agent = await mastra?.getAgent(agentId);
  const memory = await agent?.getMemory();
  if (!memory) throw new Error(`${agentId} has no memory configured`);
  return memory;
};

const shouldRefreshAgentInstructions = (agentInstructions: ProjectAgentInstructions | undefined) => {
  if (!agentInstructions?.checkedAt) return true;
  const checkedAt = Date.parse(agentInstructions.checkedAt);
  return Number.isNaN(checkedAt) || Date.now() - checkedAt > agentInstructionsRefreshMs;
};

const refreshAgentInstructions = async (memory: any, planeThread: any, planeMetadata: Record<string, any>) => {
  const agentInstructions = planeMetadata.agentInstructions as ProjectAgentInstructions | undefined;
  if (planeMetadata.projectKind !== 'git' || !shouldRefreshAgentInstructions(agentInstructions)) return planeMetadata;
  if (typeof planeMetadata.portalId !== 'string' || typeof planeMetadata.portalRootId !== 'string' || typeof planeMetadata.repoPath !== 'string') {
    return planeMetadata;
  }

  const checkedAt = new Date().toISOString();

  try {
    const result = await requestPortalTool({
      portalId: planeMetadata.portalId,
      tool: 'portal.agentInstructions.read',
      args: { rootId: planeMetadata.portalRootId, path: planeMetadata.repoPath },
      timeoutMs: 5_000,
    }) as { ok?: boolean; error?: string; agentInstructions?: ProjectAgentInstructions };

    if (result.ok === false) throw new Error(result.error ?? 'agent instructions refresh failed');

    const refreshedInstructions = result.agentInstructions && typeof result.agentInstructions.content === 'string'
      ? {
          path: typeof result.agentInstructions.path === 'string' ? result.agentInstructions.path : 'AGENTS.md',
          content: result.agentInstructions.content.slice(0, 32_000),
          size: typeof result.agentInstructions.size === 'number' ? result.agentInstructions.size : undefined,
          updatedAt: typeof result.agentInstructions.updatedAt === 'string' ? result.agentInstructions.updatedAt : undefined,
          checkedAt,
        }
      : undefined;

    const nextMetadata = { ...planeMetadata, agentInstructions: refreshedInstructions, updatedAt: checkedAt };
    await memory.updateThread({ id: planeThread.id, title: planeThread.title, metadata: nextMetadata });
    return nextMetadata;
  } catch (error) {
    console.warn('[chat] agent instructions refresh failed', error);
    if (!agentInstructions) return planeMetadata;

    const nextMetadata = { ...planeMetadata, agentInstructions: { ...agentInstructions, checkedAt } };
    await memory.updateThread({ id: planeThread.id, title: planeThread.title, metadata: nextMetadata }).catch(() => undefined);
    return nextMetadata;
  }
};

const markGitDemiplaneContext = (requestContext: any, value: boolean) => {
  requestContext?.set?.('gitDemiplane', value);
};

const markGitProjectContext = (requestContext: any, value: boolean) => {
  requestContext?.set?.('gitProject', value);
};

const getProjectInstructions = async (mastra: any, resourceId: string | undefined, threadId: unknown, requestContext?: any) => {
  markGitDemiplaneContext(requestContext, false);
  markGitProjectContext(requestContext, false);
  if (typeof threadId !== 'string' || !resourceId) return undefined;

  const memory = await getMemory(mastra);
  const thread = await memory.getThreadById({ threadId }).catch(() => undefined);
  if (!thread || thread.resourceId !== resourceId) return undefined;

  const metadata = thread.metadata as Record<string, unknown> | undefined;
  if (metadata?.mode !== 'plane' || typeof metadata.planeId !== 'string' || typeof metadata.demiplaneId !== 'string') {
    return undefined;
  }

  markGitDemiplaneContext(requestContext, true);

  const planeThread = await memory.getThreadById({ threadId: planeThreadId(metadata.planeId) }).catch(() => undefined);
  if (!planeThread || planeThread.resourceId !== resourceId) return undefined;

  const planeMetadata = await refreshAgentInstructions(memory, planeThread, planeThread.metadata as Record<string, any> | undefined ?? {}) as Record<string, any> | undefined;
  markGitProjectContext(requestContext, planeMetadata?.projectKind === 'git');
  return planeMetadata?.agentInstructions as ProjectAgentInstructions | undefined;
};

const routeSubscriptionModel = (model: unknown) => {
  if (typeof model !== 'string') return model;
  if (!model.startsWith('openai/')) return model;

  return `chatgpt/codex/${model.slice('openai/'.length)}`;
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
      const projectInstructions = await getProjectInstructions(mastra, resourceId, threadId, requestContext);
      const isGitDemiplane = requestContext?.get?.('gitDemiplane') === true;
      const isGitProject = requestContext?.get?.('gitProject') === true;
      const system = buildChatSystemMessages({
        includeGitInstructions: isGitProject,
        projectInstructions,
        callerSystem: params.system as Parameters<typeof buildChatSystemMessages>[0]['callerSystem'],
      });

      const agentId = isGitDemiplane ? 'mage-hand-coding' : 'mage-hand';
      const routedModel = routeSubscriptionModel(params?.model);
      console.info('[chat] stream request', {
        agentId,
        selectedModel: params?.model,
        routedModel,
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
          params: {
            ...params,
            model: routedModel,
            system,
            requestContext,
            abortSignal: c.req.raw.signal,
          },
        });

        const lockedStream = typeof threadId === 'string'
          ? releaseOnStreamClose(stream as ReadableStream<unknown>, releaseThreadLock)
          : stream as ReadableStream<unknown>;

        return toSseResponse(lockedStream);
      } catch (error) {
        releaseThreadLock();
        throw error;
      }
    },
  }),
];
