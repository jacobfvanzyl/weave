import { handleChatStream } from '@mastra/ai-sdk';
import type { AgentMessageInput, MastraDBMessage } from '@mastra/core/agent';
import type { Mastra } from '@mastra/core/mastra';
import { listAgentContributions } from './contributions';
import { getThreadContextUsageSnapshot } from './mastra/context-usage';
import { normalizeOpenAIReasoningEffort, normalizeOpenAIServiceTier } from './model-capabilities';
import { getModelConfig, type ModelConfig } from './model-options';
import { buildChatSystemMessages } from './mastra/agents/instructions';
import { mastra as defaultMastra } from './mastra/index';
import { expandPromptTemplate, listPromptSummaries } from './mastra/prompt-templates/registry';
import {
  type AgentContextInput,
  putAgentContext,
  resolveAgentContext,
  type ResolvedAgentContext,
} from './mastra/context/resolver';
import { listResolvedContextSkillSummaries } from './mastra/context/skill-source';
import { resolveMemoryPolicy } from './mastra/memory-policy';
import { putChatRuntimeContext } from './mastra/runtime-context-processor';
import {
  AgentRunCoordinator,
  type AgentThreadRun,
  type AgentThreadRunSnapshot,
  bufferAssistantTextStream,
  buildRunTimingMetadata,
  toThreadRunSnapshot,
} from './run-coordinator';
import { type EventService, eventService as defaultEventService } from '../services/event-service';
import { type JsonValue, type ServiceCaller, ServiceError } from '../services/types';

export type AgentRunStatus = 'queued' | 'running' | 'completed' | 'cancelled' | 'failed';

export type AgentRunRequest = {
  caller: ServiceCaller;
  agentId?: string;
  input: JsonValue;
  model?: string;
  maxSteps?: number;
  memory?: {
    scope: 'thread' | 'workflow' | 'none';
    threadId?: string;
    workflowRunId?: string;
  };
  scope?: {
    projectId?: string;
    workspaceId?: string;
  };
};

export type AgentRunSnapshot = {
  runId: string;
  agentId: string;
  status: AgentRunStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  result?: JsonValue;
  error?: string;
};

export type AgentRunEvent =
  | { type: 'start'; run: AgentRunSnapshot }
  | { type: 'finish'; run: AgentRunSnapshot; result: JsonValue }
  | { type: 'error'; run: AgentRunSnapshot; error: string }
  | { type: 'abort'; run: AgentRunSnapshot; reason: string };

type GenericAgentRun = {
  runId: string;
  agentId: string;
  ownerId: string;
  status: AgentRunStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  result?: JsonValue;
  error?: string;
  controller: AbortController;
  events: AgentRunEvent[];
  listeners: Set<(event: AgentRunEvent | { type: 'close' }) => void>;
  cleanupTimer?: ReturnType<typeof setTimeout>;
};

export type PromptContextInput = Omit<AgentContextInput, 'mastra' | 'resourceId'> & {
  resourceId?: string;
  requestContext?: unknown;
};

export type StartChatRunRequest = {
  resourceId: string;
  threadId?: string;
  params: Record<string, unknown>;
  requestContext: unknown;
  submittedUserMessages?: unknown[];
  abortSignal?: AbortSignal;
};

export type StartChatRunResult = {
  run?: AgentThreadRun;
  stream: ReadableStream<unknown>;
  snapshot: AgentThreadRunSnapshot;
};

export type SendChatMessageRequest = {
  resourceId: string;
  threadId: string;
  message: AgentMessageInput;
};

export type SendChatMessageResult = {
  accepted: boolean;
  runId?: string;
  messageId: string;
};

export type ChatThreadRecord = {
  id: string;
  title?: string;
  resourceId?: string;
  updatedAt?: string;
  metadata?: unknown;
};

export type ChatThreadScope = {
  projectId?: string;
  workspaceId?: string;
  plain?: boolean;
};

export type CreateChatThreadRequest = {
  resourceId: string;
  threadId?: string;
  title?: string;
  projectId?: string;
  workspaceId?: string;
};

export type ReorderChatThreadsRequest = {
  resourceId: string;
  threadIds: string[];
  scope?: ChatThreadScope;
};

export type ChatThreadMessagesRequest = {
  resourceId: string;
  threadId: string;
};

export type ChatThreadContextUsageRequest = ChatThreadMessagesRequest & {
  queryContextWindow?: number;
};

export type ChatThreadContextUsage = {
  tokens: number;
  contextWindow?: number;
  percent?: number;
  source: string;
  updatedAt?: string;
  totalProcessedTokens?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  memoryPolicy: {
    options: unknown;
    status: unknown;
  };
};

export type UpdateChatThreadRequest = ChatThreadMessagesRequest & {
  title?: string;
  archived?: boolean;
};

type ChatStreamHandler = typeof handleChatStream;
type AgentContextResolver = (input: AgentContextInput) => Promise<ResolvedAgentContext>;
const genericRunCleanupDelayMs = 5 * 60 * 1000;

export interface AgentService {
  listCapabilities(): Promise<Record<string, unknown>>;
  listModels(): Promise<ModelConfig>;
  listPromptTemplates(context: PromptContextInput): Promise<unknown>;
  expandPrompt(name: string, args: string, context: PromptContextInput): Promise<string | undefined>;
  resolveContext(context: PromptContextInput): Promise<ResolvedAgentContext>;
  putResolvedContext(requestContext: unknown, resolved: ResolvedAgentContext): void;
  startRun(input: AgentRunRequest): Promise<AgentRunSnapshot>;
  streamRun(runId: string): ReadableStream<unknown>;
  getRun(runId: string): Promise<AgentRunSnapshot | undefined>;
  cancelRun(runId: string): Promise<AgentRunSnapshot | undefined>;
  sendSignal(runId: string, signal: JsonValue): Promise<{ accepted: boolean }>;
  runPrompt(input: AgentRunRequest): Promise<JsonValue>;
  startChatRun(input: StartChatRunRequest): Promise<StartChatRunResult>;
  observeChatRun(resourceId: string | undefined, threadId: string | undefined): ReadableStream<unknown> | undefined;
  getChatRun(resourceId: string | undefined, threadId: string | undefined): AgentThreadRunSnapshot;
  cancelChatRun(resourceId: string | undefined, threadId: string | undefined): AgentThreadRunSnapshot;
  sendChatMessage(input: SendChatMessageRequest): Promise<SendChatMessageResult>;
  hasActiveThreadRun(resourceId: string | undefined, threadId: string | undefined): boolean;
  getChatSubmittedUserMessages(resourceId: string | undefined, threadId: string | undefined): unknown[];
  getChatUiMessages(resourceId: string | undefined, threadId: string | undefined): unknown[];
  getChatPerfSnapshot(): Record<string, unknown>;
  listChatThreads(input: { resourceId: string }): Promise<ChatThreadRecord[]>;
  createChatThread(input: CreateChatThreadRequest): Promise<ChatThreadRecord>;
  reorderChatThreads(input: ReorderChatThreadsRequest): Promise<void>;
  getChatThreadRawMessages(input: ChatThreadMessagesRequest): Promise<MastraDBMessage[]>;
  getChatThreadMessages(input: ChatThreadMessagesRequest): Promise<MastraDBMessage[]>;
  getChatThreadContextUsage(input: ChatThreadContextUsageRequest): Promise<ChatThreadContextUsage>;
  updateChatThread(input: UpdateChatThreadRequest): Promise<ChatThreadRecord>;
  deleteChatThread(input: ChatThreadMessagesRequest): Promise<void>;
}

export class MastraAgentService implements AgentService {
  private readonly genericRuns = new Map<string, GenericAgentRun>();

  constructor(
    private readonly mastra: Mastra = defaultMastra,
    private readonly runCoordinator: AgentRunCoordinator = new AgentRunCoordinator(),
    private readonly chatStreamHandler: ChatStreamHandler = handleChatStream,
    private readonly contextResolver: AgentContextResolver = resolveAgentContext,
    private readonly events: EventService = defaultEventService,
  ) {}

  async listCapabilities() {
    return {
      agents: [{ id: 'mage-hand' }],
      models: await this.listModels(),
      prompts: await listPromptSummaries({ mastra: this.mastra }),
      contributions: listAgentContributions(),
      runLifecycle: {
        startRun: true,
        streamRun: true,
        cancelRun: true,
        sendSignal: false,
        runPrompt: true,
        chatRuns: true,
      },
    };
  }

  listModels() {
    return getModelConfig();
  }

  async listPromptTemplates(context: PromptContextInput) {
    return listPromptSummaries(this.promptContext(context));
  }

  async expandPrompt(name: string, args: string, context: PromptContextInput) {
    return expandPromptTemplate(name, args, this.promptContext(context));
  }

  async resolveContext(context: PromptContextInput) {
    return this.contextResolver(this.promptContext(context));
  }

  putResolvedContext(requestContext: unknown, resolved: ResolvedAgentContext) {
    putAgentContext(requestContext, resolved);
  }

  async startRun(input: AgentRunRequest): Promise<AgentRunSnapshot> {
    const agentIds = resolveAgentIds(input.agentId);
    const agent = await this.getAgentOrThrow(agentIds.mastraAgentId, agentIds.agentId);
    const run = this.createGenericRun(input, agentIds.agentId);
    this.emitGenericRunEvent(run, { type: 'start', run: genericRunSnapshot(run) });
    this.executeGenericRun(run, input, agent);
    return genericRunSnapshot(run);
  }

  streamRun(runId: string): ReadableStream<unknown> {
    const genericRun = this.genericRuns.get(runId);
    if (genericRun) return this.observeGenericRun(genericRun);

    const run = this.runCoordinator.getRunById(runId);
    if (!run) throw new ServiceError('operation_failed', 'Agent run was not found.', 404);
    return this.runCoordinator.observeRun(run);
  }

  async getRun(runId: string) {
    const genericRun = this.genericRuns.get(runId);
    if (genericRun) return genericRunSnapshot(genericRun);

    const run = this.runCoordinator.getRunById(runId);
    return run ? toGenericRunSnapshot(run) : undefined;
  }

  async cancelRun(runId: string) {
    const genericRun = this.genericRuns.get(runId);
    if (genericRun) {
      this.cancelGenericRun(genericRun);
      return genericRunSnapshot(genericRun);
    }

    const run = this.runCoordinator.getRunById(runId);
    if (!run) return undefined;
    this.runCoordinator.cancelRun(run);
    return toGenericRunSnapshot(run);
  }

  async sendSignal(_runId: string, _signal: JsonValue): Promise<{ accepted: boolean }> {
    throw new ServiceError('not_implemented', 'AgentService.sendSignal is not implemented yet.', 501);
  }

  async startChatRun(input: StartChatRunRequest): Promise<StartChatRunResult> {
    if (input.threadId && this.runCoordinator.hasActiveThreadRun(input.resourceId, input.threadId)) {
      throw new ServiceError('operation_failed', 'thread has an active stream', 409);
    }

    const prepared = await this.prepareChatRun(input);
    const run = input.threadId
      ? this.runCoordinator.createThreadRun(input.resourceId, input.threadId, input.submittedUserMessages ?? [])
      : undefined;

    try {
      const stream = await this.chatStreamHandler({
        mastra: this.mastra,
        agentId: 'mage-hand',
        version: 'v6',
        sendReasoning: true,
        defaultOptions: { maxSteps: 1000 },
        ...(run
          ? {
            messageMetadata: ({ part }: { part?: unknown }) => {
              if (!isRecord(part)) return undefined;
              if (part.type === 'start') return buildRunTimingMetadata(run, 'running');
              if (part.type === 'finish') return buildRunTimingMetadata(run, 'completed');
              return undefined;
            },
          }
          : {}),
        params: {
          ...input.params,
          ...(prepared.routedModel ? { model: prepared.routedModel } : {}),
          providerOptions: prepared.providerOptions as never,
          memory: prepared.memory as never,
          system: prepared.system as never,
          requestContext: input.requestContext as never,
          abortSignal: run?.controller.signal ?? input.abortSignal,
        } as never,
      });

      const bufferedStream = bufferAssistantTextStream(stream as ReadableStream<unknown>);
      if (!run) {
        return { stream: bufferedStream, snapshot: { active: false, status: 'idle' } };
      }

      this.runCoordinator.startRunPump(run, bufferedStream);
      return {
        run,
        stream: this.runCoordinator.observeRun(run),
        snapshot: toThreadRunSnapshot(run),
      };
    } catch (error) {
      if (run) this.runCoordinator.settleRun(run, 'error', error);
      throw error;
    }
  }

  observeChatRun(resourceId: string | undefined, threadId: string | undefined) {
    return this.runCoordinator.observeActiveThreadRun(resourceId, threadId);
  }

  getChatRun(resourceId: string | undefined, threadId: string | undefined) {
    return this.runCoordinator.getThreadRunSnapshot(resourceId, threadId);
  }

  cancelChatRun(resourceId: string | undefined, threadId: string | undefined) {
    return this.runCoordinator.cancelThreadRun(resourceId, threadId);
  }

  async sendChatMessage(input: SendChatMessageRequest): Promise<SendChatMessageResult> {
    const agent = await this.mastra.getAgent('mageHandAgent');
    if (!agent) throw new ServiceError('operation_failed', 'Agent was not found: mageHandAgent', 404);

    const result = await agent.sendMessage(input.message, {
      resourceId: input.resourceId,
      threadId: input.threadId,
      ifActive: {
        behavior: 'deliver',
        attributes: {
          source: 'composer',
          delivery: 'while-active',
        },
      },
      ifIdle: { behavior: 'discard' },
    });

    return {
      accepted: Boolean(result.accepted),
      runId: typeof result.runId === 'string' ? result.runId : undefined,
      messageId: String(result.signal.id),
    };
  }

  hasActiveThreadRun(resourceId: string | undefined, threadId: string | undefined) {
    return this.runCoordinator.hasActiveThreadRun(resourceId, threadId);
  }

  getChatSubmittedUserMessages(resourceId: string | undefined, threadId: string | undefined) {
    return this.runCoordinator.getSubmittedUserMessages(resourceId, threadId);
  }

  getChatUiMessages(resourceId: string | undefined, threadId: string | undefined) {
    return this.runCoordinator.getUiMessages(resourceId, threadId);
  }

  getChatPerfSnapshot() {
    return this.runCoordinator.getPerfSnapshot();
  }

  async listChatThreads(input: { resourceId: string }): Promise<ChatThreadRecord[]> {
    const memory = await this.getMemory();
    const result = await memory.listThreads({
      filter: { resourceId: input.resourceId },
      perPage: false,
      orderBy: { field: 'updatedAt', direction: 'DESC' },
    });

    const threads = await Promise.all(
      result.threads.filter((thread: ChatThreadRecord) => !isHiddenChatThread(thread)).map(
        async (thread: ChatThreadRecord) => {
          if (thread.title && !['New chat', '...'].includes(thread.title)) return thread;

          const messages = await this.recallThreadMessages(memory, {
            threadId: thread.id,
            resourceId: input.resourceId,
          });
          const title = getThreadTitleFromMessages(messages);

          return title ? { ...thread, title } : thread;
        },
      ),
    );

    return threads.sort((a, b) => {
      const aOrder = typeof (a.metadata as Record<string, unknown> | undefined)?.sortOrder === 'number'
        ? (a.metadata as Record<string, number>).sortOrder
        : Number.MAX_SAFE_INTEGER;
      const bOrder = typeof (b.metadata as Record<string, unknown> | undefined)?.sortOrder === 'number'
        ? (b.metadata as Record<string, number>).sortOrder
        : Number.MAX_SAFE_INTEGER;
      return aOrder - bOrder || timestampString(b.updatedAt).localeCompare(timestampString(a.updatedAt));
    });
  }

  async createChatThread(input: CreateChatThreadRequest): Promise<ChatThreadRecord> {
    const memory = await this.getMemory();
    const sortOrder = await getTopChatThreadSortOrder(memory, input.resourceId, {
      projectId: input.projectId,
      workspaceId: input.workspaceId,
    });
    const metadata = input.projectId
      ? { mode: 'project', projectId: input.projectId, workspaceId: input.workspaceId, sortOrder }
      : { mode: 'plain', sortOrder };

    return await memory.createThread({
      resourceId: input.resourceId,
      threadId: input.threadId,
      title: input.title ?? '...',
      metadata,
      saveThread: true,
    });
  }

  async reorderChatThreads(input: ReorderChatThreadsRequest): Promise<void> {
    const memory = await this.getMemory();
    const result = await memory.listThreads({ filter: { resourceId: input.resourceId }, perPage: false });
    const visibleThreads = result.threads.filter((thread: ChatThreadRecord) => !isHiddenChatThread(thread));
    const scopedThreads = visibleThreads.filter((thread: ChatThreadRecord) => threadMatchesScope(thread, input.scope));
    const scopedIds = new Set(scopedThreads.map((thread: ChatThreadRecord) => thread.id));
    if (input.threadIds.length !== scopedIds.size || input.threadIds.some((id) => !scopedIds.has(id))) {
      throw new ServiceError('operation_failed', 'threadIds must include all threads in scope', 400);
    }

    await Promise.all(input.threadIds.map(async (id, index) => {
      const thread = scopedThreads.find((item: ChatThreadRecord) => item.id === id)!;
      const metadata = { ...((thread.metadata ?? {}) as Record<string, unknown>), sortOrder: index };
      await memory.updateThread({ id, title: thread.title, metadata });
    }));
  }

  async getChatThreadRawMessages(input: ChatThreadMessagesRequest): Promise<MastraDBMessage[]> {
    return await this.getChatThreadMessages(input);
  }

  async getChatThreadMessages(input: ChatThreadMessagesRequest): Promise<MastraDBMessage[]> {
    const memory = await this.getMemory();
    try {
      return await this.recallThreadMessages(memory, input);
    } catch (error) {
      if (isNoThreadFoundError(error)) return [];
      throw error;
    }
  }

  async getChatThreadContextUsage(input: ChatThreadContextUsageRequest): Promise<ChatThreadContextUsage> {
    const memory = await this.getMemory();
    const resolvedContext = await this.contextResolver({
      mastra: this.mastra,
      resourceId: input.resourceId,
      threadId: input.threadId,
    });
    const memoryPolicy = resolveMemoryPolicy({
      agentMemory: resolvedContext.config.memory,
      threadMetadata: resolvedContext.threadMetadata,
    });
    const snapshot = getThreadContextUsageSnapshot(input.threadId, input.resourceId);
    const contextWindow = Number.isFinite(input.queryContextWindow) && input.queryContextWindow! > 0
      ? input.queryContextWindow
      : typeof snapshot?.maxTokens === 'number'
      ? snapshot.maxTokens
      : typeof memory.MAX_CONTEXT_TOKENS === 'number'
      ? memory.MAX_CONTEXT_TOKENS
      : undefined;
    const tokens = snapshot?.usedTokens ?? await estimateMemoryContextTokens(memory, {
      threadId: input.threadId,
      resourceId: input.resourceId,
      memoryConfig: memoryPolicy.options,
    });

    return {
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
    };
  }

  async updateChatThread(input: UpdateChatThreadRequest): Promise<ChatThreadRecord> {
    const memory = await this.getMemory();
    const thread = await memory.getThreadById({ threadId: input.threadId });
    if (!thread || thread.resourceId !== input.resourceId) {
      throw new ServiceError('operation_failed', 'thread not found', 404);
    }

    const metadata = { ...((thread.metadata ?? {}) as Record<string, unknown>) };
    if (input.archived !== undefined) metadata.archived = input.archived;
    return await memory.updateThread({
      id: input.threadId,
      title: input.title || thread.title,
      metadata,
    });
  }

  async deleteChatThread(input: ChatThreadMessagesRequest): Promise<void> {
    const memory = await this.getMemory();
    const thread = await memory.getThreadById({ threadId: input.threadId });
    if (!thread || thread.resourceId !== input.resourceId) {
      throw new ServiceError('operation_failed', 'thread not found', 404);
    }

    await memory.deleteThread(input.threadId);
  }

  private async getMemory(): Promise<any> {
    const agent = await this.mastra.getAgent('mageHandAgent');
    const memory = await agent?.getMemory();
    if (!memory) throw new ServiceError('operation_failed', 'mageHandAgent has no memory configured', 500);
    return memory;
  }

  private async recallThreadMessages(memory: any, input: ChatThreadMessagesRequest): Promise<MastraDBMessage[]> {
    const result = await memory.recall({
      threadId: input.threadId,
      resourceId: input.resourceId,
      perPage: false,
      orderBy: { field: 'createdAt', direction: 'ASC' },
    });
    return result.messages;
  }

  private async prepareChatRun(input: StartChatRunRequest) {
    const params = input.params;
    putChatRuntimeContext(input.requestContext, { now: new Date() });
    const resolvedContext = input.resourceId
      ? await this.contextResolver({ mastra: this.mastra, resourceId: input.resourceId, threadId: input.threadId })
      : undefined;
    if (resolvedContext) putAgentContext(input.requestContext, resolvedContext);
    const memoryPolicy = resolvedContext
      ? resolveMemoryPolicy({
        agentMemory: resolvedContext.config.memory,
        threadMetadata: resolvedContext.threadMetadata,
      })
      : undefined;
    const isProjectWorkspace = Boolean(
      resolvedContext?.threadMetadata?.mode === 'project' && resolvedContext.threadMetadata.workspaceId,
    );
    const isGitProject = resolvedContext?.projectKind === 'git';
    const isNotesProject = resolvedContext?.projectKind === 'notes';
    markGitWorkspaceContext(input.requestContext, isProjectWorkspace);
    markGitProjectContext(input.requestContext, isGitProject);

    const system = buildChatSystemMessages({
      includeGitInstructions: isGitProject,
      includeNotesInstructions: isNotesProject,
      agentFiles: resolvedContext?.agentFiles,
      skillSummaries: resolvedContext ? listResolvedContextSkillSummaries(resolvedContext) : undefined,
      callerSystem: params.system as Parameters<typeof buildChatSystemMessages>[0]['callerSystem'],
    });

    const routedModel = routeSubscriptionModel(params.model);
    const providerModel = routedModel ?? params.model;
    const requestHasReasoningEffort = hasOwn(params, 'reasoningEffort');
    const requestHasServiceTier = hasOwn(params, 'serviceTier');
    const reasoningEffort = normalizeOpenAIReasoningEffort(
      requestHasReasoningEffort ? params.reasoningEffort : resolvedContext?.config.reasoningEffort,
      providerModel,
      { fallbackToDefault: true },
    );
    const serviceTier = requestHasServiceTier
      ? normalizeOpenAIServiceTier(params.serviceTier, providerModel)
      : normalizeOpenAIServiceTier(resolvedContext?.config.serviceTier, providerModel);

    console.info('[chat] stream request', {
      agentId: 'mage-hand',
      selectedModel: params.model,
      routedModel,
      reasoningEffort: reasoningEffort ?? 'default',
      serviceTier: serviceTier ?? 'default',
      threadId: input.threadId,
      resourceId: input.resourceId,
      memory: memoryPolicy?.status,
      chatgptSubscription: true,
    });

    return {
      routedModel,
      providerOptions: buildProviderOptions(params.providerOptions, {
        reasoningEffort,
        serviceTier,
        threadId: input.threadId,
        resourceId: input.resourceId,
      }),
      memory: isRecord(params.memory)
        ? {
          ...params.memory,
          ...(input.resourceId ? { resource: input.resourceId } : {}),
          ...(memoryPolicy ? { options: memoryPolicy.options } : {}),
        }
        : params.memory,
      system,
    };
  }

  async runPrompt(input: AgentRunRequest): Promise<JsonValue> {
    const agentIds = resolveAgentIds(input.agentId);
    const agent = await this.getAgentOrThrow(agentIds.mastraAgentId, agentIds.agentId);
    return this.generatePrompt(input, agent);
  }

  private async getAgentOrThrow(agentId: string, displayId = agentId): Promise<any> {
    const agent = await this.mastra.getAgent(agentId);
    if (!agent) throw new ServiceError('operation_failed', `Agent was not found: ${displayId}`, 404);
    return agent;
  }

  private createGenericRun(input: AgentRunRequest, agentId: string): GenericAgentRun {
    const now = new Date().toISOString();
    const run: GenericAgentRun = {
      runId: crypto.randomUUID(),
      agentId,
      ownerId: input.caller.ownerId,
      status: 'running',
      createdAt: now,
      updatedAt: now,
      controller: new AbortController(),
      events: [],
      listeners: new Set(),
    };
    this.genericRuns.set(run.runId, run);
    return run;
  }

  private executeGenericRun(run: GenericAgentRun, input: AgentRunRequest, agent: any) {
    void (async () => {
      try {
        const result = await this.generatePrompt(input, agent, run.controller.signal, run.runId);
        if (run.status === 'cancelled') return;
        this.settleGenericRun(run, 'completed', { result });
      } catch (error) {
        if (run.status === 'cancelled' || run.controller.signal.aborted) {
          this.settleGenericRun(run, 'cancelled');
          return;
        }
        this.settleGenericRun(run, 'failed', { error });
      }
    })();
  }

  private async generatePrompt(
    input: AgentRunRequest,
    agent: any,
    abortSignal?: AbortSignal,
    runId?: string,
  ): Promise<JsonValue> {
    const messages = agentMessagesFromInput(input.input);
    const memory = agentMemoryFromRunRequest(input);
    const output = await agent.generate(messages as never, {
      ...(input.model ? { model: input.model } : {}),
      ...(input.maxSteps ? { maxSteps: input.maxSteps } : { maxSteps: 1000 }),
      ...(memory ? { memory } : {}),
      ...(abortSignal ? { abortSignal } : {}),
      ...(runId ? { runId } : {}),
    } as never);

    return toJsonValue({
      runId: stringValue((output as any).runId),
      text: typeof (output as any).text === 'string' ? (output as any).text : '',
      finishReason: stringValue((output as any).finishReason),
      usage: jsonSafe((output as any).usage),
      totalUsage: jsonSafe((output as any).totalUsage),
      object: jsonSafe((output as any).object),
      traceId: stringValue((output as any).traceId),
      spanId: stringValue((output as any).spanId),
    });
  }

  private cancelGenericRun(run: GenericAgentRun) {
    if (run.status !== 'running' && run.status !== 'queued') return;
    run.controller.abort('cancelled');
    this.settleGenericRun(run, 'cancelled');
  }

  private settleGenericRun(
    run: GenericAgentRun,
    status: Exclude<AgentRunStatus, 'queued' | 'running'>,
    options: { result?: JsonValue; error?: unknown } = {},
  ) {
    if (run.status !== 'running' && run.status !== 'queued') return;

    run.status = status;
    run.updatedAt = new Date().toISOString();
    run.completedAt = run.updatedAt;
    if (options.result !== undefined) run.result = options.result;
    if (options.error !== undefined) {
      run.error = options.error instanceof Error ? options.error.message : String(options.error);
    }

    if (status === 'completed') {
      const result = run.result ?? null;
      this.emitGenericRunEvent(run, { type: 'finish', run: genericRunSnapshot(run), result });
    } else if (status === 'cancelled') {
      this.emitGenericRunEvent(run, { type: 'abort', run: genericRunSnapshot(run), reason: 'cancelled' });
    } else {
      this.emitGenericRunEvent(run, {
        type: 'error',
        run: genericRunSnapshot(run),
        error: run.error ?? 'Agent run failed.',
      });
    }

    for (const listener of run.listeners) listener({ type: 'close' });
    run.listeners.clear();
    this.scheduleGenericRunCleanup(run);
  }

  private emitGenericRunEvent(run: GenericAgentRun, event: AgentRunEvent) {
    run.events.push(event);
    run.updatedAt = new Date().toISOString();
    for (const listener of run.listeners) listener(event);
    void this.events.publishRunEvent(
      { kind: 'agent', ownerId: run.ownerId, correlation: { agentRunId: run.runId } },
      {
        runKind: 'agent',
        runId: run.runId,
        type: event.type,
        data: toJsonValue({
          run: event.run as unknown as JsonValue,
          ...(event.type === 'finish' ? { result: event.result } : {}),
          ...(event.type === 'error' ? { error: event.error } : {}),
          ...(event.type === 'abort' ? { reason: event.reason } : {}),
        }),
      },
    ).catch(() => undefined);
  }

  private observeGenericRun(run: GenericAgentRun) {
    let listener: ((event: AgentRunEvent | { type: 'close' }) => void) | undefined;
    return new ReadableStream<AgentRunEvent>({
      start(controller) {
        for (const event of run.events) controller.enqueue(event);

        if (run.status !== 'running' && run.status !== 'queued') {
          controller.close();
          return;
        }

        listener = (event) => {
          if (event.type === 'close') {
            if (listener) run.listeners.delete(listener);
            controller.close();
            return;
          }
          controller.enqueue(event);
        };
        run.listeners.add(listener);
      },
      cancel() {
        if (listener) run.listeners.delete(listener);
      },
    });
  }

  private scheduleGenericRunCleanup(run: GenericAgentRun) {
    if (run.cleanupTimer) clearTimeout(run.cleanupTimer);
    run.cleanupTimer = setTimeout(() => {
      if (this.genericRuns.get(run.runId) === run) this.genericRuns.delete(run.runId);
    }, genericRunCleanupDelayMs);
  }

  private promptContext(context: PromptContextInput): any {
    return {
      mastra: this.mastra,
      resourceId: context.resourceId,
      threadId: context.threadId,
      projectId: context.projectId,
      workspaceId: context.workspaceId,
    };
  }
}

export const agentRunCoordinator = new AgentRunCoordinator();
export const agentService = new MastraAgentService(defaultMastra, agentRunCoordinator);

const stringValue = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

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

const hasOwn = (value: unknown, key: string) =>
  Boolean(value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key));

const timestampString = (value: unknown) =>
  typeof value === 'string' ? value : value instanceof Date ? value.toISOString() : '';

const hiddenThreadPrefixes = ['__project__', '__plane__', '__portal__', '__portal_settings__'];

const isHiddenChatThread = (thread: { id: string; metadata?: unknown }) => {
  const metadata = thread.metadata as Record<string, unknown> | undefined;
  return hiddenThreadPrefixes.some((prefix) => thread.id.startsWith(prefix)) ||
    metadata?.kind === 'project' ||
    metadata?.kind === 'plane' ||
    metadata?.kind === 'portal-token' ||
    metadata?.kind === 'portal-settings';
};

const threadMatchesScope = (thread: ChatThreadRecord, scope: ChatThreadScope | undefined) => {
  const metadata = (thread.metadata ?? {}) as Record<string, unknown>;
  if (metadata.archived === true) return false;
  if (scope?.plain === true) {
    return metadata.adHoc === true || (metadata.mode !== 'project' && typeof metadata.projectId !== 'string');
  }
  if (scope?.workspaceId) {
    return metadata.projectId === scope.projectId && metadata.workspaceId === scope.workspaceId;
  }
  if (scope?.projectId) return metadata.projectId === scope.projectId && typeof metadata.workspaceId !== 'string';
  return false;
};

const getTopChatThreadSortOrder = async (
  memory: any,
  resourceId: string,
  scope: { projectId?: string; workspaceId?: string },
) => {
  const result = await memory.listThreads({ filter: { resourceId }, perPage: false });
  const orders = result.threads
    .filter((thread: ChatThreadRecord) => !isHiddenChatThread(thread))
    .filter((thread: ChatThreadRecord) => {
      const metadata = (thread.metadata ?? {}) as Record<string, unknown>;
      if (metadata.archived === true) return false;
      if (scope.projectId) return metadata.projectId === scope.projectId && metadata.workspaceId === scope.workspaceId;
      return metadata.adHoc === true || (metadata.mode !== 'project' && typeof metadata.projectId !== 'string');
    })
    .map((thread: ChatThreadRecord) => (thread.metadata as Record<string, unknown> | undefined)?.sortOrder)
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

const messageTextForTokenEstimate = (message: MastraDBMessage) =>
  message.content.parts
    .map((part) => {
      const record = part as Record<string, unknown>;
      if (typeof record.text === 'string') return record.text;
      if (typeof record.result === 'string') return record.result;
      if (record.result !== undefined) return JSON.stringify(record.result);
      if (record.output !== undefined) {
        return typeof record.output === 'string' ? record.output : JSON.stringify(record.output);
      }
      return JSON.stringify(record);
    })
    .filter(Boolean)
    .join('\n');

const estimateTextTokens = (memory: any, text: string) =>
  typeof memory.estimateTokens === 'function' ? memory.estimateTokens(text) : Math.ceil(text.length / 4);

export const estimateContextTokens = (memory: any, messages: MastraDBMessage[], systemMessage?: string) =>
  messages.reduce((total, message) => {
    const text = messageTextForTokenEstimate(message);
    return total + estimateTextTokens(memory, text);
  }, systemMessage ? estimateTextTokens(memory, systemMessage) : 0);

export const contextUsageRecallOptions = (
  threadId: string,
  resourceId: string,
  threadConfig: unknown,
) => ({
  threadId,
  resourceId,
  ...(isRecord(threadConfig) ? { threadConfig } : {}),
});

export const estimateMemoryContextTokens = async (
  memory: any,
  args: {
    threadId: string;
    resourceId: string;
    memoryConfig: unknown;
  },
) => {
  if (typeof memory.getContext === 'function') {
    const context = await memory.getContext({
      threadId: args.threadId,
      resourceId: args.resourceId,
      ...(isRecord(args.memoryConfig) ? { memoryConfig: args.memoryConfig } : {}),
    });
    return estimateContextTokens(
      memory,
      Array.isArray(context?.messages) ? context.messages : [],
      context?.systemMessage,
    );
  }

  const recalled = await memory.recall({
    ...contextUsageRecallOptions(args.threadId, args.resourceId, args.memoryConfig),
  });
  return estimateContextTokens(memory, recalled.messages);
};

const isNoThreadFoundError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('No thread found');
};

const buildProviderOptions = (
  providerOptions: unknown,
  options: { reasoningEffort?: string; serviceTier?: string; threadId?: unknown; resourceId?: string },
) => {
  const base = providerOptions && typeof providerOptions === 'object' ? providerOptions as Record<string, unknown> : {};
  const openai = base.openai && typeof base.openai === 'object' ? base.openai as Record<string, unknown> : {};
  const openaiPatch = {
    ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
    ...(options.serviceTier ? { serviceTier: options.serviceTier } : {}),
  };
  const hasOpenAIPatch = Object.keys(openaiPatch).length > 0;

  return {
    ...base,
    ...(hasOpenAIPatch
      ? {
        openai: {
          ...openai,
          ...openaiPatch,
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

const toGenericRunSnapshot = (run: AgentThreadRun): AgentRunSnapshot => ({
  runId: run.runId,
  agentId: 'mage-hand',
  status: run.status === 'error' ? 'failed' : run.status === 'cancelling' ? 'running' : run.status,
  createdAt: run.startedAt,
  updatedAt: run.updatedAt,
  ...(run.error ? { error: run.error } : {}),
});

const resolveAgentIds = (agentId: string | undefined) => {
  if (!agentId || agentId === 'mage-hand' || agentId === 'mageHandAgent') {
    return { agentId: 'mage-hand', mastraAgentId: 'mageHandAgent' };
  }
  return { agentId, mastraAgentId: agentId };
};

const genericRunSnapshot = (run: GenericAgentRun): AgentRunSnapshot => ({
  runId: run.runId,
  agentId: run.agentId,
  status: run.status,
  createdAt: run.createdAt,
  updatedAt: run.updatedAt,
  ...(run.completedAt ? { completedAt: run.completedAt } : {}),
  ...(run.result !== undefined ? { result: run.result } : {}),
  ...(run.error ? { error: run.error } : {}),
});

const agentMessagesFromInput = (input: JsonValue) => {
  if (typeof input === 'string') return input;
  if (isRecord(input)) {
    if (typeof input.prompt === 'string') return input.prompt;
    if (Array.isArray(input.messages)) return input.messages;
  }
  return JSON.stringify(input);
};

const agentMemoryFromRunRequest = (input: AgentRunRequest) => {
  if (!input.memory || input.memory.scope === 'none') return undefined;
  if (input.memory.scope === 'thread') {
    const thread = stringValue(input.memory.threadId);
    if (!thread) throw new ServiceError('operation_failed', 'thread memory scope requires threadId.', 400);
    return { thread, resource: input.caller.ownerId };
  }

  const workflowRunId = stringValue(input.memory.workflowRunId) ?? stringValue(input.caller.correlation?.workflowRunId);
  if (!workflowRunId) throw new ServiceError('operation_failed', 'workflow memory scope requires workflowRunId.', 400);
  return { thread: `__workflow__${workflowRunId}`, resource: input.caller.ownerId };
};

const jsonSafe = (value: unknown): JsonValue | undefined => {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return undefined;
  }
};

const toJsonValue = (value: Record<string, unknown>): JsonValue => {
  const entries = Object.entries(value).filter((entry): entry is [string, JsonValue] => entry[1] !== undefined);
  return Object.fromEntries(entries);
};
