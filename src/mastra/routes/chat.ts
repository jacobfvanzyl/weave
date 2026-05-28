import { handleChatStream } from '@mastra/ai-sdk';
import { MASTRA_RESOURCE_ID_KEY } from '@mastra/core/request-context';
import { registerApiRoute } from '@mastra/core/server';
import { buildChatSystemMessages, type ProjectAgentInstructions } from '../agents/instructions';
import { requestPortalTool } from '../portal/registry';
import { attachmentIdFromReference, attachmentModelUrl, attachmentStorage, parseBase64DataUrl, type StoredAttachmentMetadata } from '../attachments';

const agentId = 'mageHandAgent';
const planeThreadId = (planeId: string) => `__plane__${planeId}`;
const agentInstructionsRefreshMs = 60_000;
const activeThreadStreams = new Set<string>();
const maxImageAttachmentBytes = 10 * 1024 * 1024;

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
      const reasoningEffort = normalizeReasoningEffort(params?.reasoningEffort);
      console.info('[chat] stream request', {
        agentId,
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
            model: routedModel,
            providerOptions: buildProviderOptions(params.providerOptions, { reasoningEffort, threadId, resourceId }),
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
