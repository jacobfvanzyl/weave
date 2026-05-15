import { handleChatStream } from '@mastra/ai-sdk';
import { MASTRA_RESOURCE_ID_KEY } from '@mastra/core/request-context';
import { registerApiRoute } from '@mastra/core/server';
import { requestPortalTool } from '../portal/registry';

const agentId = 'mageHandAgent';
const planeThreadId = (planeId: string) => `__plane__${planeId}`;
const agentInstructionsRefreshMs = 60_000;

type AgentInstructions = {
  path: string;
  content: string;
  size?: number;
  updatedAt?: string;
  checkedAt?: string;
};

const gitPlaneCodingInstructions = [
  '# Git Plane Coding Agent',
  '',
  'Apply these instructions only while working in this Git Plane Demiplane.',
  'These instructions supplement the base Mage Hand behavior and repository instructions. If they conflict with higher-priority system/developer instructions, follow the higher-priority instructions.',
  '',
  'You are operating in a git-backed repository workspace. Behave like a dedicated coding agent, not a general chat assistant.',
  '',
  'Coding workflow:',
  '- Treat the repository as the primary source of truth.',
  '- Inspect relevant files before proposing or making code changes.',
  '- Use project-local tools for filesystem and command work when needed.',
  '- Prefer small, precise, reviewable edits over broad rewrites.',
  '- Preserve existing style, architecture, naming, and conventions.',
  '- Do not modify unrelated files or refactor unrelated code.',
  '- Validate user input and handle errors explicitly.',
  '- Never hardcode secrets, credentials, tokens, or environment-specific private values.',
  '',
  'Search and file operations:',
  '- Use bash for discovery/search commands such as ls, fd, and rg before reading unknown files.',
  '- Use read for file inspection.',
  '- Use edit for targeted changes.',
  '- Use write only for new files or full-file replacement.',
  '',
  'Verification:',
  '- After changes, run the most relevant available check when practical: tests, typecheck, lint, or build.',
  '- If verification cannot run or fails for unrelated/environmental reasons, say so clearly.',
  '',
  'Communication:',
  '- Be concise and implementation-focused.',
  '- State changed files clearly.',
  '- Summarize verification performed and remaining risks.',
].join('\n');

const formatProjectContextFile = (path: string, content: string) => [
  '# Project Context',
  '',
  'Project-specific instructions and guidelines:',
  '',
  `## ${path}`,
  '',
  content,
].join('\n');

const getMemory = async (mastra: any) => {
  const agent = await mastra?.getAgent(agentId);
  const memory = await agent?.getMemory();
  if (!memory) throw new Error(`${agentId} has no memory configured`);
  return memory;
};

const shouldRefreshAgentInstructions = (agentInstructions: AgentInstructions | undefined) => {
  if (!agentInstructions?.checkedAt) return true;
  const checkedAt = Date.parse(agentInstructions.checkedAt);
  return Number.isNaN(checkedAt) || Date.now() - checkedAt > agentInstructionsRefreshMs;
};

const refreshAgentInstructions = async (memory: any, planeThread: any, planeMetadata: Record<string, any>) => {
  const agentInstructions = planeMetadata.agentInstructions as AgentInstructions | undefined;
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
    }) as { ok?: boolean; error?: string; agentInstructions?: AgentInstructions };

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

const getProjectInstructions = async (mastra: any, resourceId: string | undefined, threadId: unknown, requestContext?: any) => {
  markGitDemiplaneContext(requestContext, false);
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

  const planeMetadata = await refreshAgentInstructions(memory, planeThread, planeThread.metadata as Record<string, any> | undefined ?? {});
  const instructionBlocks: string[] = [];

  if (planeMetadata?.projectKind === 'git') {
    instructionBlocks.push(gitPlaneCodingInstructions);
  }

  const agentsMd = planeMetadata?.agentInstructions;
  if (agentsMd && typeof agentsMd.content === 'string' && agentsMd.content.trim()) {
    const path = typeof agentsMd.path === 'string' ? agentsMd.path : 'AGENTS.md';
    instructionBlocks.push(formatProjectContextFile(path, agentsMd.content.slice(0, 32_000)));
  }

  return instructionBlocks.length > 0 ? instructionBlocks.join('\n\n') : undefined;
};

const routeSubscriptionModel = (model: unknown) => {
  if (typeof model !== 'string') return model;
  if (!model.startsWith('openai/')) return model;

  return `chatgpt/codex/${model.slice('openai/'.length)}`;
};

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
      const resourceId = requestContext?.get(MASTRA_RESOURCE_ID_KEY);
      const threadId = params?.memory?.thread;
      const projectInstructions = await getProjectInstructions(mastra, resourceId, threadId, requestContext);
      const isGitDemiplane = requestContext?.get?.('gitDemiplane') === true;
      const system = projectInstructions
        ? [params.system, projectInstructions].filter(Boolean).join('\n\n')
        : params.system;

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

      return toSseResponse(stream as ReadableStream<unknown>);
    },
  }),
];
