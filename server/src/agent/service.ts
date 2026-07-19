import { handleChatStream, toAISdkStream } from '@mastra/ai-sdk';
import type { AgentMessageInput, MastraDBMessage } from '@mastra/core/agent';
import type { StorageThreadType } from '@mastra/core/memory';
import type { Mastra } from '@mastra/core/mastra';
import type { ChatThread, ThreadCompactionEventData } from '@weave/protocol';
import { listAgentContributions } from './contributions';
import { type ModelContextBudget, putModelContextBudget, resolveModelContextBudget } from './context-budget';
import { getThreadContextUsageSnapshot } from './mastra/context-usage';
import { credentialOwnerHeaders } from './credential-owner';
import { normalizeOpenAIReasoningEffort, normalizeOpenAIServiceTier } from './model-capabilities';
import { getModelConfig, type ModelConfig, resolveModelOption } from './model-options';
import { buildChatSystemMessages } from './mastra/agents/instructions';
import { expandPromptTemplate, listPromptSummaries } from './mastra/prompt-templates/registry';
import {
  type AgentContextInput,
  putAgentContext,
  resolveAgentContext,
  type ResolvedAgentContext,
} from './mastra/context/resolver';
import { listResolvedContextSkillSummaries } from './mastra/context/skill-source';
import { resolveMemoryPolicy } from './mastra/memory-policy';
import { clampAgentMaxSteps, getAgentMaxSteps } from './mastra/run-guard-processor';
import { putChatRuntimeContext } from './mastra/runtime-context-processor';
import { appendRunVerification, runVerificationSchema } from './mastra/run-verifier-agent';
import { compactText, hashText } from './mastra/tools/model-output';
import { normalizeExecutionProfile, putExecutionProfile, rememberToolApproval } from './execution-policy';
import { type AgentRunRecordV1, type AgentRunRepository, agentRunRepository } from './run-repository';
import {
  AgentRunCoordinator,
  type AgentThreadRun,
  type AgentThreadRunSnapshot,
  bufferAssistantTextStream,
  buildRunTimingMetadata,
  filterCompactToolHistoryTextStream,
  filterResumedToolOutputPreambleStream,
  normalizeAskUserSuspensionStream,
  toThreadRunSnapshot,
} from './run-coordinator';
import { contextUsageRecallOptions, estimateMemoryContextTokens } from './context-token-estimate';
import { type EventService, eventService as defaultEventService } from '../services/event-service';
import { callerForOwner, type JsonValue, type ServiceCaller, ServiceError } from '../services/types';
import { toolService } from '../services/tool-runtime';
import { getWeaveDb } from '../storage/postgres';
import {
  batchCompactionTranscripts,
  buildCompactionPrompt,
  collectCompactionAttachments,
  compactionSourceFingerprint,
  estimateMessageTokens,
  normalizeCheckpoint,
  projectCompaction,
  putThreadCompactionContext,
  putThreadCompactionStepRuntime,
  redactCompactionText,
  selectCompactionCut,
  structuredCheckpointV2OutputSchema,
  validateCompactionSummary,
  validateStructuredCheckpoint,
} from './thread-compaction';
import {
  type ThreadCompactionRecord,
  type ThreadCompactionRepository,
  threadCompactionRepository,
  type ThreadCompactionTrigger,
} from './thread-compaction-repository';
import { chatGPTCodexAuthService } from './mastra/providers/chatgpt-codex-auth';
import { normalizeWeaveChatThread } from './chat-protocol';

export const hashChatSystemPrompt = (system: unknown) => hashText(JSON.stringify(system ?? null));

const getMastraMessageText = (message: MastraDBMessage) =>
  message.content.parts.flatMap((part) => {
    if (!part || typeof part !== 'object' || Array.isArray(part)) return [];
    const record = part as Record<string, unknown>;
    return record.type === 'text' && typeof record.text === 'string' && record.text.trim() ? [record.text.trim()] : [];
  }).join('\n');

const buildAskUserResumeContext = (resumeData: unknown, threadMessages: MastraDBMessage[] = []) => {
  if (!resumeData || typeof resumeData !== 'object' || Array.isArray(resumeData)) return [];
  const record = resumeData as Record<string, unknown>;
  if (record.action !== 'submit' && record.action !== 'cancel') return [];
  const priorUserRequests = threadMessages
    .filter((message) => message.role === 'user')
    .map(getMastraMessageText)
    .filter(Boolean)
    .slice(-8)
    .map((text) => text.slice(0, 4_000));
  const context = priorUserRequests.length > 0
    ? [{
      role: 'user',
      content: [
        'Relevant prior user requests from this thread:',
        ...priorUserRequests.map((text, index) => `${index + 1}. ${text}`),
      ].join('\n'),
    }]
    : [];

  if (record.action === 'cancel') {
    return [...context, {
      role: 'user',
      content: 'The user cancelled the structured clarification. Continue with best judgment without repeating it.',
    }];
  }

  if (record.action !== 'submit' || !Array.isArray(record.answers)) return context;
  const answers = record.answers.flatMap((answer) => {
    if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return [];
    const entry = answer as Record<string, unknown>;
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    const finalAnswer = typeof entry.finalAnswer === 'string' ? entry.finalAnswer.trim() : '';
    return id && finalAnswer ? [`- ${id}: ${finalAnswer}`] : [];
  });
  if (answers.length === 0) return context;

  return [...context, {
    role: 'user',
    content: [
      'The user answered the suspended structured clarification. Treat these answers as authoritative and continue the task without repeating the same questions:',
      ...answers,
    ].join('\n'),
  }];
};

export {
  contextUsageRecallOptions,
  estimateContextTokens,
  estimateMemoryContextTokens,
} from './context-token-estimate';

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
  requestId?: string;
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
  activeThreadRunId?: string;
  message: AgentMessageInput;
};

export type SendChatMessageResult = {
  accepted: boolean;
  runId?: string;
  messageId?: string;
  reason?: 'stale_run';
};

export type ToolApprovalDecision = 'approve' | 'deny';

export type RespondToToolApprovalRequest = {
  resourceId: string;
  threadId: string;
  runId: string;
  toolCallId: string;
  decision: ToolApprovalDecision;
  rememberForRun?: boolean;
  requestContext?: unknown;
};

export type ChatThreadRecord = ChatThread;

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
  modelId?: string;
};

export type ChatThreadContextUsage = {
  modelId: string;
  tokens: number;
  contextWindow: number;
  contextLimitPercent: number;
  contextLimitTokens: number;
  percent: number;
  compactionEnabled: boolean;
  source: 'provider' | 'estimate';
  updatedAt: string;
  totalProcessedTokens?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  compaction?: {
    generation: number;
    state: ThreadCompactionRecord['status'];
    at: string;
    projectedTokens?: number;
  };
  memoryPolicy: {
    options: unknown;
    status: unknown;
  };
};

export type CompactChatThreadRequest = ChatThreadMessagesRequest & {
  model: string;
  instructions?: string;
  trigger?: ThreadCompactionTrigger;
  abortSignal?: AbortSignal;
  fixedTokens?: number;
  pendingTokens?: number;
  activeRunId?: string;
  origin?: 'pre_run' | 'mid_run' | 'manual';
  onEvent?: (event: { type: 'data-thread-compaction'; data: ThreadCompactionEventData }) => void;
};

export type CompactChatThreadResult = {
  status: 'completed' | 'not_needed' | 'rejected';
  checkpoint?: ThreadCompactionRecord;
  attempt?: ThreadCompactionRecord;
  reason?: string;
  budget: ModelContextBudget;
};

export type UpdateChatThreadRequest = ChatThreadMessagesRequest & {
  title?: string;
  archived?: boolean;
};

type ChatStreamHandler = typeof handleChatStream;
type AgentContextResolver = (input: AgentContextInput) => Promise<ResolvedAgentContext>;
type MastraProvider = Mastra | (() => Mastra | Promise<Mastra>);
const genericRunCleanupDelayMs = 5 * 60 * 1000;

let defaultMastraPromise: Promise<Mastra> | undefined;

const loadDefaultMastra = () => {
  defaultMastraPromise ??= import('./mastra/index').then((module) => module.mastra);
  return defaultMastraPromise;
};

export interface AgentService {
  listCapabilities(): Promise<Record<string, unknown>>;
  listModels(): Promise<ModelConfig>;
  listPromptTemplates(context: PromptContextInput): Promise<unknown>;
  expandPrompt(name: string, args: string, context: PromptContextInput): Promise<string | undefined>;
  getChatGPTAuthStatus(ownerId: string): Promise<unknown>;
  startChatGPTBrowserLogin(ownerId: string): unknown;
  completeChatGPTBrowserLogin(input: { ownerId: string; code: string; state: string }): Promise<unknown>;
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
  replayChatRun(
    resourceId: string,
    threadId: string,
    afterSequence?: number,
  ): Promise<ReadableStream<unknown> | undefined>;
  replaySequencedChatRun(
    resourceId: string,
    threadId: string,
    afterSequence?: number,
    runId?: string,
  ): Promise<ReadableStream<{ sequence: number; chunk: unknown }> | undefined>;
  getPersistedChatRun(resourceId: string, threadId: string, runId?: string): Promise<AgentRunRecordV1 | undefined>;
  respondToToolApproval(input: RespondToToolApprovalRequest): Promise<StartChatRunResult>;
  getChatRun(resourceId: string | undefined, threadId: string | undefined): AgentThreadRunSnapshot;
  getChatRunById(resourceId: string, threadId: string, runId: string): Promise<AgentThreadRunSnapshot>;
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
  getChatSuspendedAskUserRunIds(input: ChatThreadMessagesRequest): Promise<Record<string, string>>;
  getChatThreadContextUsage(input: ChatThreadContextUsageRequest): Promise<ChatThreadContextUsage>;
  compactChatThread(input: CompactChatThreadRequest): Promise<CompactChatThreadResult>;
  listChatThreadCompactions(input: ChatThreadMessagesRequest): Promise<ThreadCompactionRecord[]>;
  updateChatThread(input: UpdateChatThreadRequest): Promise<ChatThreadRecord>;
  deleteChatThread(input: ChatThreadMessagesRequest): Promise<void>;
}

export class MastraAgentService implements AgentService {
  private readonly genericRuns = new Map<string, GenericAgentRun>();

  constructor(
    private readonly mastraProvider: MastraProvider = loadDefaultMastra,
    private readonly runCoordinator: AgentRunCoordinator = new AgentRunCoordinator(),
    private readonly chatStreamHandler: ChatStreamHandler = handleChatStream,
    private readonly contextResolver: AgentContextResolver = resolveAgentContext,
    private readonly events: EventService = defaultEventService,
    private readonly compactions: ThreadCompactionRepository = threadCompactionRepository,
    private readonly persistedRuns: AgentRunRepository = agentRunRepository,
  ) {}

  async listCapabilities() {
    const mastra = await this.getMastra();
    return {
      agents: [{ id: 'mage-hand' }],
      models: await this.listModels(),
      prompts: await listPromptSummaries({ mastra }),
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
    return listPromptSummaries(await this.promptContext(context));
  }

  getChatGPTAuthStatus(ownerId: string) {
    return chatGPTCodexAuthService.getAuthStatus(ownerId);
  }

  startChatGPTBrowserLogin(ownerId: string) {
    return chatGPTCodexAuthService.startBrowserLogin(ownerId);
  }

  completeChatGPTBrowserLogin(input: { ownerId: string; code: string; state: string }) {
    return chatGPTCodexAuthService.completeBrowserLogin(input);
  }

  async expandPrompt(name: string, args: string, context: PromptContextInput) {
    return expandPromptTemplate(name, args, await this.promptContext(context));
  }

  async resolveContext(context: PromptContextInput) {
    return this.contextResolver(await this.promptContext(context));
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
    const startRequestFingerprint = hashText(JSON.stringify(stableJsonValue({
      threadId: input.threadId,
      params: input.params,
      submittedUserMessages: input.submittedUserMessages ?? [],
    })));
    if (input.requestId) {
      const duplicate = this.runCoordinator.getRunById(input.requestId);
      if (duplicate) {
        if (
          duplicate.resourceId !== input.resourceId || duplicate.threadId !== input.threadId ||
          duplicate.metadata.startRequestFingerprint !== startRequestFingerprint
        ) {
          throw new ServiceError('operation_failed', 'chat run request id was reused with different input', 409, {
            reason: 'request_id_conflict',
          });
        }
        return {
          run: duplicate,
          stream: this.runCoordinator.observeRun(duplicate),
          snapshot: toThreadRunSnapshot(duplicate),
        };
      }
      const persistedDuplicate = await this.persistedRuns.get(input.requestId);
      if (persistedDuplicate) {
        if (
          persistedDuplicate.resourceId !== input.resourceId || persistedDuplicate.threadId !== input.threadId ||
          persistedDuplicate.metadata.startRequestFingerprint !== startRequestFingerprint
        ) {
          throw new ServiceError('operation_failed', 'chat run request id was reused with different input', 409, {
            reason: 'request_id_conflict',
          });
        }
        const events = await this.persistedRuns.events(persistedDuplicate.runId);
        return {
          stream: new ReadableStream<unknown>({
            start(controller) {
              for (const event of events) controller.enqueue(event.data);
              controller.close();
            },
          }),
          snapshot: persistedThreadRunSnapshot(persistedDuplicate),
        };
      }
    }

    let existingRun = input.threadId
      ? this.runCoordinator.getActiveThreadRun(input.resourceId, input.threadId)
      : undefined;
    if (!existingRun && input.threadId && containsToolApprovalResponse(input.params.messages)) {
      const persisted = await this.persistedRuns.latest(input.resourceId, input.threadId);
      if (!persisted || persisted.status !== 'awaiting_approval') {
        throw new ServiceError('operation_failed', 'Tool approval belongs to a stale or unavailable run.', 409);
      }
      existingRun = this.runCoordinator.restoreAwaitingApprovalRun(
        persisted,
        await this.persistedRuns.events(persisted.runId),
        {
          requestContext: input.requestContext,
          submittedUserMessages: input.submittedUserMessages,
        },
      );
    }
    if (existingRun && existingRun.status !== 'awaiting_approval') {
      throw new ServiceError('operation_failed', 'thread has an active stream', 409);
    }

    const backgroundStart = Boolean(input.threadId && !existingRun);
    const prepared = await this.prepareChatRun(input, {
      automaticCompaction: backgroundStart ? 'defer' : 'perform',
      ...(existingRun ? { activeRun: existingRun } : {}),
    });
    const mastra = await this.getMastra();
    const { executionProfile: _executionProfile, verify: _verify, ...chatParams } = input.params;
    const askUserResumeContext = chatParams.resumeData && input.threadId
      ? buildAskUserResumeContext(
        chatParams.resumeData,
        await this.getChatThreadMessages({ resourceId: input.resourceId, threadId: input.threadId }),
      )
      : buildAskUserResumeContext(chatParams.resumeData);
    if (askUserResumeContext.length > 0) {
      (input.requestContext as { set?: (key: string, value: unknown) => void } | undefined)?.set?.(
        'weave.askUserResume',
        true,
      );
    }
    const existingContext = Array.isArray(chatParams.context) ? chatParams.context : [];
    const continuesAskUserResponse = askUserResumeContext.length > 0;
    const streamChatParams = { ...chatParams };
    if (continuesAskUserResponse) {
      delete streamChatParams.resumeData;
      delete streamChatParams.toolCallId;
      delete streamChatParams.runId;
    }
    // Mastra resumes directly at the saved workflow step and skips preparation
    // of new context/messages. Continue accepted Ask responses as a fresh turn
    // on the same memory thread so legacy parallel-tool snapshots cannot drop
    // the user's authoritative answers.
    const mastraRunId = continuesAskUserResponse
      ? crypto.randomUUID()
      : existingRun?.mastraRunId ?? stringValue(input.params.runId) ?? crypto.randomUUID();
    const callerTracingOptions = isRecord(chatParams.tracingOptions) ? chatParams.tracingOptions : {};
    const callerTraceMetadata = isRecord(callerTracingOptions.metadata) ? callerTracingOptions.metadata : {};
    const runMetadata = {
      schemaVersion: 1,
      agent: 'mage-hand',
      harness: 'weave-mastra-v1',
      model: prepared.routedModel,
      executionProfile: prepared.executionProfile,
      maxSteps: getAgentMaxSteps(),
      promptHash: hashChatSystemPrompt(prepared.system),
      toolContractVersion: 1,
      executionLimits: {
        contextTokens: prepared.contextBudget.contextLimitTokens,
        network: prepared.executionProfile === 'host' ? 'host' : 'denied',
      },
      skills: prepared.skillSummaries,
      startRequestFingerprint,
    };

    // Preparing a run performs asynchronous work. Recheck ownership immediately
    // before the synchronous create so concurrent retries cannot replace one another.
    if (backgroundStart) {
      const concurrentRun = input.requestId
        ? this.runCoordinator.getRunById(input.requestId)
        : this.runCoordinator.getActiveThreadRun(input.resourceId, input.threadId);
      if (concurrentRun) {
        if (
          concurrentRun.resourceId !== input.resourceId || concurrentRun.threadId !== input.threadId ||
          concurrentRun.metadata.startRequestFingerprint !== startRequestFingerprint
        ) {
          throw new ServiceError('operation_failed', 'chat run request id was reused with different input', 409, {
            reason: 'request_id_conflict',
          });
        }
        return {
          run: concurrentRun,
          stream: this.runCoordinator.observeRun(concurrentRun),
          snapshot: toThreadRunSnapshot(concurrentRun),
        };
      }
      const occupiedRun = this.runCoordinator.getActiveThreadRun(input.resourceId, input.threadId);
      if (occupiedRun) {
        throw new ServiceError('operation_failed', 'thread has an active stream', 409);
      }
    }

    const run = existingRun ??
      (input.threadId
        ? this.runCoordinator.createThreadRun(input.resourceId, input.threadId, input.submittedUserMessages ?? [], {
          ...(input.requestId ? { runId: input.requestId } : {}),
          mastraRunId,
          executionProfile: prepared.executionProfile,
          model: stringValue(input.params.model),
          requestContext: input.requestContext,
          metadata: runMetadata,
          phase: prepared.automaticCompactionNeeded ? 'compacting' : 'generating',
        })
        : undefined);

    const executePreparedRun = async (executionPrepared: typeof prepared): Promise<StartChatRunResult> => {
      try {
        const maxSteps = getAgentMaxSteps();
        console.info('[chat] stream request', {
          agentId: 'mage-hand',
          selectedModel: executionPrepared.selectedModel,
          routedModel: executionPrepared.routedModel,
          reasoningEffort: executionPrepared.reasoningEffort ?? 'default',
          serviceTier: executionPrepared.serviceTier ?? 'default',
          threadId: input.threadId,
          resourceId: input.resourceId,
          memory: executionPrepared.memoryPolicyStatus,
          chatgptSubscription: true,
          executionProfile: executionPrepared.executionProfile,
        });
        const stream = await this.chatStreamHandler({
          mastra,
          agentId: 'mage-hand',
          version: 'v6',
          sendReasoning: true,
          defaultOptions: { maxSteps },
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
            ...streamChatParams,
            ...(askUserResumeContext.length > 0 ? { context: [...existingContext, ...askUserResumeContext] } : {}),
            maxSteps,
            runId: mastraRunId,
            ...(executionPrepared.routedModel
              ? { model: ownerScopedSubscriptionModel(executionPrepared.routedModel, input.resourceId) }
              : {}),
            providerOptions: executionPrepared.providerOptions as never,
            memory: executionPrepared.memory as never,
            system: executionPrepared.system as never,
            requestContext: input.requestContext as never,
            savePerStep: true,
            abortSignal: run?.controller.signal ?? input.abortSignal,
            tracingOptions: {
              ...callerTracingOptions,
              metadata: {
                ...callerTraceMetadata,
                ...runMetadata,
                ...(run ? { agentRunId: run.runId } : {}),
                ...(input.threadId ? { threadId: input.threadId } : {}),
              },
              tags: [
                ...new Set([
                  ...Array.isArray(callerTracingOptions.tags)
                    ? callerTracingOptions.tags.filter((tag): tag is string => typeof tag === 'string')
                    : [],
                  'weave-coding-agent',
                  `execution:${executionPrepared.executionProfile}`,
                ]),
              ],
            },
          } as never,
        });

        const modelStream = stream as ReadableStream<unknown>;
        const clientSafeStream = continuesAskUserResponse
          ? filterResumedToolOutputPreambleStream(modelStream)
          : modelStream;
        const verifiedStream = executionPrepared.verificationEnabled && run
          ? appendRunVerification(clientSafeStream, {
            requirements: input.submittedUserMessages ?? [],
            verify: async (evidence) => {
              try {
                const repositoryEvidence = await collectRepositoryVerifierEvidence(
                  input.resourceId,
                  executionPrepared.resolvedContext,
                );
                const verifier = await mastra.getAgent('runVerifierAgent');
                if (!verifier) throw new Error('Run verifier agent is unavailable.');
                const result = await verifier.generate(JSON.stringify({ ...evidence, repositoryEvidence }), {
                  maxSteps: 1,
                  requestContext: input.requestContext as never,
                  model: ownerScopedSubscriptionModel('chatgpt/codex/gpt-5.6-luna', input.resourceId),
                  structuredOutput: { schema: runVerificationSchema },
                } as never);
                return runVerificationSchema.parse(result.object);
              } catch (error) {
                return {
                  verdict: 'needs_evidence' as const,
                  summary: 'The independent verifier could not complete.',
                  missingEvidence: [error instanceof Error ? error.message : String(error)],
                  unresolvedRisks: [],
                  requestAnotherPhase: false,
                };
              }
            },
          })
          : clientSafeStream;
        const bufferedStream = bufferAssistantTextStream(
          filterCompactToolHistoryTextStream(
            normalizeAskUserSuspensionStream(verifiedStream, { mastraRunId }),
          ),
        );
        if (!run) {
          return { stream: bufferedStream, snapshot: { active: false, status: 'idle' } };
        }

        if (existingRun) {
          if (!this.runCoordinator.resumeRunPump(run, bufferedStream)) {
            throw new ServiceError('operation_failed', 'Agent run could not be resumed.', 409);
          }
        } else {
          this.runCoordinator.startRunPump(run, bufferedStream);
        }
        return {
          run,
          stream: this.runCoordinator.observeRun(run),
          snapshot: toThreadRunSnapshot(run),
        };
      } catch (error) {
        if (run) this.runCoordinator.settleRun(run, 'error', error);
        throw error;
      }
    };

    if (run && !existingRun) {
      await this.runCoordinator.flushPersistence(run);
      this.runCoordinator.startRunExecution(run, async () => {
        const executionPrepared = prepared.automaticCompactionNeeded
          ? await this.prepareChatRun({ ...input, abortSignal: run.controller.signal }, {
            automaticCompaction: 'perform',
            activeRun: run,
          })
          : prepared;
        this.runCoordinator.setPhase(run, 'generating');
        await this.runCoordinator.flushPersistence(run);
        await executePreparedRun(executionPrepared);
      });
      return {
        run,
        stream: this.runCoordinator.observeRun(run),
        snapshot: toThreadRunSnapshot(run),
      };
    }

    return await executePreparedRun(prepared);
  }

  observeChatRun(resourceId: string | undefined, threadId: string | undefined) {
    return this.runCoordinator.observeActiveThreadRun(resourceId, threadId);
  }

  async replayChatRun(resourceId: string, threadId: string, afterSequence = 0) {
    const inMemory = this.runCoordinator.getThreadRun(resourceId, threadId);
    if (inMemory) return this.runCoordinator.observeRun(inMemory, afterSequence);

    const persisted = await this.persistedRuns.latest(resourceId, threadId);
    if (!persisted) return undefined;
    if (persisted.status === 'running') await this.persistedRuns.interrupt(persisted.runId);
    const events = await this.persistedRuns.events(persisted.runId, afterSequence);
    return new ReadableStream<unknown>({
      start(controller) {
        for (const event of events) controller.enqueue(event.data);
        controller.close();
      },
    });
  }

  async replaySequencedChatRun(resourceId: string, threadId: string, afterSequence = 0, runId?: string) {
    const inMemory = runId
      ? this.runCoordinator.getRunById(runId)
      : this.runCoordinator.getThreadRun(resourceId, threadId);
    if (inMemory && (inMemory.resourceId !== resourceId || inMemory.threadId !== threadId)) return undefined;
    if (inMemory) return this.runCoordinator.observeSequencedRun(inMemory, afterSequence);

    const persisted = runId
      ? await this.persistedRuns.get(runId)
      : await this.persistedRuns.latest(resourceId, threadId);
    if (!persisted) return undefined;
    if (persisted.resourceId !== resourceId || persisted.threadId !== threadId) return undefined;
    if (persisted.status === 'running') await this.persistedRuns.interrupt(persisted.runId);
    const events = await this.persistedRuns.events(persisted.runId, afterSequence);
    return new ReadableStream<{ sequence: number; chunk: unknown }>({
      start(controller) {
        for (const event of events) controller.enqueue({ sequence: event.sequence, chunk: event.data });
        controller.close();
      },
    });
  }

  async getPersistedChatRun(resourceId: string, threadId: string, runId?: string) {
    const record = runId ? await this.persistedRuns.get(runId) : await this.persistedRuns.latest(resourceId, threadId);
    return record?.resourceId === resourceId && record.threadId === threadId ? record : undefined;
  }

  async respondToToolApproval(input: RespondToToolApprovalRequest): Promise<StartChatRunResult> {
    let run = this.runCoordinator.getThreadRun(input.resourceId, input.threadId);
    if (!run) {
      const persisted = await this.persistedRuns.latest(input.resourceId, input.threadId);
      if (persisted?.runId === input.runId && persisted.status === 'awaiting_approval') {
        run = this.runCoordinator.restoreAwaitingApprovalRun(
          persisted,
          await this.persistedRuns.events(persisted.runId),
          { requestContext: input.requestContext },
        );
      }
    }
    if (!run || run.runId !== input.runId) {
      throw new ServiceError('operation_failed', 'Agent run was not found or is stale.', 409);
    }
    if (run.status !== 'awaiting_approval') {
      throw new ServiceError('operation_failed', 'Agent run is not awaiting tool approval.', 409);
    }
    if (input.rememberForRun && input.decision === 'approve') {
      const approvalChunk = [...run.chunks].reverse().find((chunk) => {
        const data = 'data' in chunk && isRecord(chunk.data) ? chunk.data : undefined;
        const directToolCallId = 'toolCallId' in chunk ? chunk.toolCallId : undefined;
        return directToolCallId === input.toolCallId || data?.toolCallId === input.toolCallId;
      });
      if (approvalChunk) {
        const data = 'data' in approvalChunk && isRecord(approvalChunk.data) ? approvalChunk.data : undefined;
        const directToolName = 'toolName' in approvalChunk ? approvalChunk.toolName : undefined;
        const toolName = stringValue(directToolName) ?? stringValue(data?.toolName);
        if (toolName) rememberToolApproval(run.requestContext, toolName);
      }
    }

    const mastra = await this.getMastra();
    const agent = await mastra.getAgent('mageHandAgent');
    if (!agent) throw new ServiceError('operation_failed', 'Agent was not found: mageHandAgent', 404);
    const options = {
      runId: run.mastraRunId,
      toolCallId: input.toolCallId,
      requestContext: run.requestContext as never,
      maxSteps: getAgentMaxSteps(),
    };
    const output = input.decision === 'approve'
      ? await agent.approveToolCall(options)
      : await agent.declineToolCall(options);
    const resumed = bufferAssistantTextStream(
      filterCompactToolHistoryTextStream(
        normalizeAskUserSuspensionStream(
          toAISdkStream(output, {
            from: 'agent',
            version: 'v6',
            sendReasoning: true,
            messageMetadata: ({ part }: { part?: unknown }) => {
              if (!isRecord(part)) return undefined;
              if (part.type === 'start') return buildRunTimingMetadata(run, 'running');
              if (part.type === 'finish') return buildRunTimingMetadata(run, 'completed');
              return undefined;
            },
          }) as ReadableStream<unknown>,
          { mastraRunId: run.mastraRunId },
        ),
      ),
    );
    if (!this.runCoordinator.resumeRunPump(run, resumed)) {
      throw new ServiceError('operation_failed', 'Agent run could not be resumed.', 409);
    }
    return { run, stream: this.runCoordinator.observeRun(run), snapshot: toThreadRunSnapshot(run) };
  }

  getChatRun(resourceId: string | undefined, threadId: string | undefined) {
    return this.runCoordinator.getThreadRunSnapshot(resourceId, threadId);
  }

  async getChatRunById(resourceId: string, threadId: string, runId: string) {
    const inMemory = this.runCoordinator.getRunById(runId);
    if (inMemory?.resourceId === resourceId && inMemory.threadId === threadId) return toThreadRunSnapshot(inMemory);
    const persisted = await this.getPersistedChatRun(resourceId, threadId, runId);
    return persisted ? persistedThreadRunSnapshot(persisted) : { active: false, status: 'idle' as const };
  }

  cancelChatRun(resourceId: string | undefined, threadId: string | undefined) {
    return this.runCoordinator.cancelThreadRun(resourceId, threadId);
  }

  async sendChatMessage(input: SendChatMessageRequest): Promise<SendChatMessageResult> {
    if (input.activeThreadRunId) {
      const activeRun = this.runCoordinator.getActiveThreadRun(input.resourceId, input.threadId);
      if (activeRun?.runId !== input.activeThreadRunId) {
        return { accepted: false, runId: activeRun?.runId, reason: 'stale_run' };
      }
    }

    const mastra = await this.getMastra();
    const agent = await mastra.getAgent('mageHandAgent');
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
      result.threads.filter((thread: StorageThreadType) => !isHiddenChatThread(thread)).map(
        async (storedThread: StorageThreadType) => {
          const thread = normalizeWeaveChatThread(storedThread);
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

    return normalizeWeaveChatThread(
      await memory.createThread({
        resourceId: input.resourceId,
        threadId: input.threadId,
        title: input.title ?? '...',
        metadata,
        saveThread: true,
      }),
    );
  }

  async reorderChatThreads(input: ReorderChatThreadsRequest): Promise<void> {
    const memory = await this.getMemory();
    const result = await memory.listThreads({ filter: { resourceId: input.resourceId }, perPage: false });
    const visibleThreads = result.threads
      .filter((thread: StorageThreadType) => !isHiddenChatThread(thread))
      .map((thread: StorageThreadType) => normalizeWeaveChatThread(thread));
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

  async getChatSuspendedAskUserRunIds(input: ChatThreadMessagesRequest): Promise<Record<string, string>> {
    const db = await getWeaveDb();
    const result = await db.execute({
      sql: `
        select run_id, snapshot
        from mastra.mastra_workflow_snapshot
        where workflow_name = 'executionWorkflow'
          and "resourceId" = ?
          and snapshot::text ilike ?
          and snapshot::text ilike '%ask_user%'
        order by coalesce("updatedAtZ", "updatedAt" at time zone 'UTC') desc
        limit 100
      `,
      args: [input.resourceId, `%${input.threadId}%`],
    });

    return extractSuspendedAskUserRunIdsFromWorkflowSnapshots(result.rows);
  }

  async getChatThreadContextUsage(input: ChatThreadContextUsageRequest): Promise<ChatThreadContextUsage> {
    const memory = await this.getMemory();
    const mastra = await this.getMastra();
    const snapshot = getThreadContextUsageSnapshot(input.threadId, input.resourceId);
    const selectedModel = input.modelId ?? snapshot?.modelId ?? (await getModelConfig()).defaultModel;
    const budget = await this.resolveContextBudget(selectedModel);
    const checkpoint = threadCompactionEnabled()
      ? await this.compactions.latest(input.resourceId, input.threadId, false)
      : undefined;
    const completedCheckpoint = !threadCompactionEnabled()
      ? undefined
      : checkpoint?.status === 'completed'
      ? checkpoint
      : await this.compactions.latest(input.resourceId, input.threadId);
    const resolvedContext = await this.contextResolver({
      mastra,
      resourceId: input.resourceId,
      threadId: input.threadId,
    });
    const totalMessages = completedCheckpoint ? await this.getStoredMessageTotal(memory, input) : undefined;
    const memoryPolicy = resolveMemoryPolicy({
      agentMemory: resolvedContext.config.memory,
      threadMetadata: resolvedContext.threadMetadata,
      tokenLimit: budget.contextLimitTokens,
      lastMessages: completedCheckpoint?.compactedMessageCount !== undefined && totalMessages !== undefined
        ? Math.max(1, totalMessages - completedCheckpoint.compactedMessageCount)
        : undefined,
    });
    const checkpointIsNewer = completedCheckpoint?.completedAt &&
      (!snapshot?.updatedAt || Date.parse(completedCheckpoint.completedAt) > Date.parse(snapshot.updatedAt));
    const tokens = checkpointIsNewer && completedCheckpoint.projectedTokens !== undefined
      ? completedCheckpoint.projectedTokens
      : snapshot?.usedTokens ?? (await estimateMemoryContextTokens(memory, {
            threadId: input.threadId,
            resourceId: input.resourceId,
            memoryConfig: memoryPolicy.options,
          })) + (completedCheckpoint?.summary ? Math.ceil(completedCheckpoint.summary.length / 4) : 0);

    return {
      modelId: budget.modelId,
      tokens,
      contextWindow: budget.advertisedContextTokens,
      contextLimitPercent: budget.contextLimitPercent,
      contextLimitTokens: budget.contextLimitTokens,
      percent: Math.min(100, (tokens / budget.contextLimitTokens) * 100),
      compactionEnabled: threadCompactionEnabled(),
      source: checkpointIsNewer ? 'estimate' : snapshot ? snapshot.source : 'estimate',
      updatedAt: (checkpointIsNewer ? completedCheckpoint?.completedAt : snapshot?.updatedAt) ??
        new Date().toISOString(),
      totalProcessedTokens: snapshot?.totalProcessedTokens,
      inputTokens: snapshot?.inputTokens,
      cachedInputTokens: snapshot?.cachedInputTokens,
      outputTokens: snapshot?.outputTokens,
      ...(checkpoint
        ? {
          compaction: {
            generation: checkpoint.generation,
            state: checkpoint.status,
            at: checkpoint.completedAt ?? checkpoint.updatedAt,
            ...(checkpoint.projectedTokens !== undefined ? { projectedTokens: checkpoint.projectedTokens } : {}),
          },
        }
        : {}),
      memoryPolicy: {
        options: memoryPolicy.options,
        status: memoryPolicy.status,
      },
    };
  }

  async listChatThreadCompactions(input: ChatThreadMessagesRequest) {
    if (!threadCompactionEnabled()) return [];
    return await this.compactions.completed(input.resourceId, input.threadId);
  }

  async compactChatThread(input: CompactChatThreadRequest): Promise<CompactChatThreadResult> {
    if (!threadCompactionEnabled()) {
      throw new ServiceError(
        'operation_failed',
        'Thread compaction is disabled. Remove WEAVE_THREAD_COMPACTION=false to enable it.',
        404,
      );
    }
    const activeRun = this.runCoordinator.getActiveThreadRun(input.resourceId, input.threadId);
    if (activeRun && activeRun.runId !== input.activeRunId) {
      throw new ServiceError('operation_failed', 'thread has an active stream', 409, { reason: 'active_run' });
    }

    const memory = await this.getMemory();
    const thread = await memory.getThreadById({ threadId: input.threadId });
    if (!thread || thread.resourceId !== input.resourceId) {
      throw new ServiceError('operation_failed', 'thread not found', 404);
    }

    const conversationBudget = await this.resolveContextBudget(input.model);
    const previous = await this.compactions.latest(input.resourceId, input.threadId);
    const previousCheckpoint = previous ? normalizeCheckpoint(previous.checkpoint, previous.summary) : undefined;
    const v2Mode = threadCompactionV2Mode();
    const v2CompactionMode = !previous?.checkpoint || previousCheckpoint?.producer !== 'v2' ||
        (previousCheckpoint?.lineageDepth ?? 0) >= 4
      ? 'rebuild' as const
      : 'incremental' as const;
    const legacyCompactionMode = previous ? 'incremental' as const : 'rebuild' as const;
    const compactionMode = v2Mode === 'active' ? v2CompactionMode : legacyCompactionMode;
    const messages = await this.recallThreadMessages(memory, input);
    const cut = selectCompactionCut(
      messages,
      conversationBudget.recentTailTokens,
      compactionMode === 'rebuild' ? 0 : previous?.compactedMessageCount ?? 0,
    );
    if (!cut) return { status: 'not_needed', budget: conversationBudget };

    const compactionModel = process.env.WEAVE_COMPACTION_MODEL?.trim() || 'openai/gpt-5.6-luna';
    const compactionBudget = await this.resolveContextBudget(compactionModel);
    const promptOverheadTokens = 2_000;
    const previousSummaryTokens = compactionMode === 'incremental' && previous?.summary
      ? Math.ceil(previous.summary.length / 4)
      : 0;
    const inputCapacity = compactionBudget.contextLimitTokens - compactionBudget.summaryOutputTokens -
      promptOverheadTokens - Math.max(previousSummaryTokens, compactionBudget.summaryOutputTokens);
    if (inputCapacity <= 0) {
      throw new ServiceError('operation_failed', 'Compaction model has no remaining input capacity.', 500);
    }

    const sourceTokens = cut.source.reduce((total, message) => total + estimateMessageTokens(message), 0);
    if ((input.trigger ?? 'manual') === 'automatic') {
      const latestAttempt = await this.compactions.latest(input.resourceId, input.threadId, false);
      const throttledStatus = latestAttempt?.status === 'failed' || latestAttempt?.status === 'rejected';
      const retryAt = throttledStatus ? Date.parse(latestAttempt.updatedAt) + 15 * 60 * 1000 : 0;
      const enoughNewContext = !throttledStatus ||
        sourceTokens >= (latestAttempt.sourceTokens ?? 0) + conversationBudget.retryDeltaTokens;
      if (!enoughNewContext && Date.now() < retryAt) {
        throw new ServiceError(
          'operation_failed',
          'Automatic compaction is cooling down after a failed attempt.',
          409,
          {
            reason: 'compaction_retry_throttled',
            retryAt: new Date(retryAt).toISOString(),
            retryDeltaTokens: conversationBudget.retryDeltaTokens,
          },
        );
      }
    }

    let job: ThreadCompactionRecord | undefined;
    try {
      job = await this.compactions.begin({
        resourceId: input.resourceId,
        threadId: input.threadId,
        trigger: input.trigger ?? 'manual',
        instructions: input.instructions,
        conversationBudget,
        compactionBudget,
        compactionModel,
        reasoningEffort: 'medium',
        sourceTokens,
        compactionMode,
      });
      input.onEvent?.({
        type: 'data-thread-compaction',
        data: {
          phase: 'started',
          compactionId: job.id,
          origin: input.origin ?? (input.trigger === 'manual' ? 'manual' : 'pre_run'),
          trigger: job.trigger,
          generation: job.generation,
          mode: compactionMode,
        },
      });
    } catch (error) {
      if ((error as { status?: number }).status === 409) {
        throw new ServiceError('operation_failed', 'thread compaction is already running', 409, {
          reason: 'compaction_in_progress',
        });
      }
      throw error;
    }

    try {
      const mastra = await this.getMastra();
      const agent = await mastra.getAgent('threadCompactionAgent');
      if (!agent) throw new Error('threadCompactionAgent is not registered');
      if (v2Mode !== 'active') {
        let summary = compactionMode === 'incremental' ? previous?.summary : undefined;
        for (const transcript of batchCompactionTranscripts(cut.source, inputCapacity)) {
          const output = await agent.stream(
            buildCompactionPrompt({
              previousSummary: summary,
              transcript,
              instructions: input.instructions,
              mode: summary ? 'incremental' : compactionMode,
              outputFormat: 'legacy_markdown',
            }),
            {
              model: ownerScopedSubscriptionModel(routeSubscriptionModel(compactionModel), input.resourceId),
              maxOutputTokens: compactionBudget.summaryOutputTokens,
              providerOptions: buildProviderOptions(undefined, { reasoningEffort: 'medium' }),
              toolChoice: 'none',
              ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
            } as never,
          );
          summary = validateCompactionSummary(
            String(await (output as { text: Promise<unknown> }).text),
            compactionBudget.summaryOutputTokens,
          ).summary;
        }
        const validatedLegacy = validateCompactionSummary(summary ?? '', compactionBudget.summaryOutputTokens);
        const checkpoint = normalizeCheckpoint(undefined, validatedLegacy.summary);
        checkpoint.lineageDepth = compactionMode === 'rebuild' ? 0 : (previousCheckpoint?.lineageDepth ?? 0) + 1;
        const projection = projectCompaction({
          budget: conversationBudget,
          fixedTokens: input.fixedTokens,
          previousCheckpointTokens: previousSummaryTokens,
          sourceTokens,
          retainedTokens: cut.retainedTokens,
          pendingTokens: input.pendingTokens,
          candidateTokens: validatedLegacy.tokens,
        });
        if (v2Mode === 'shadow' && shouldSampleCompactionShadow(job.id)) {
          try {
            const shadowCut = selectCompactionCut(
              messages,
              conversationBudget.recentTailTokens,
              v2CompactionMode === 'rebuild' ? 0 : previous?.compactedMessageCount ?? 0,
            );
            if (!shadowCut) throw new Error('V2 shadow candidate did not require compaction.');
            const shadowPreviousSummaryTokens = v2CompactionMode === 'incremental' && previous?.summary
              ? Math.ceil(previous.summary.length / 4)
              : 0;
            const shadowInputCapacity = compactionBudget.contextLimitTokens - compactionBudget.summaryOutputTokens -
              promptOverheadTokens - Math.max(shadowPreviousSummaryTokens, compactionBudget.summaryOutputTokens);
            const shadowSourceTokens = shadowCut.source.reduce(
              (total, message) => total + estimateMessageTokens(message),
              0,
            );
            const attachmentCatalog = collectCompactionAttachments(
              messages.slice(0, shadowCut.firstRetainedIndex),
            );
            const lineageDepth = v2CompactionMode === 'rebuild' ? 0 : (previousCheckpoint?.lineageDepth ?? 0) + 1;
            let shadowCheckpoint = v2CompactionMode === 'incremental' ? previousCheckpoint : undefined;
            let shadowTokens = 0;
            for (const transcript of batchCompactionTranscripts(shadowCut.source, shadowInputCapacity)) {
              const output = await agent.generate(
                buildCompactionPrompt({
                  previousCheckpoint: shadowCheckpoint,
                  transcript,
                  instructions: input.instructions,
                  mode: shadowCheckpoint ? 'incremental' : v2CompactionMode,
                }),
                {
                  maxSteps: 1,
                  model: ownerScopedSubscriptionModel(routeSubscriptionModel(compactionModel), input.resourceId),
                  maxOutputTokens: compactionBudget.summaryOutputTokens,
                  providerOptions: buildProviderOptions(undefined, { reasoningEffort: 'medium' }),
                  toolChoice: 'none',
                  structuredOutput: { schema: structuredCheckpointV2OutputSchema },
                  ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
                } as never,
              );
              const shadow = validateStructuredCheckpoint((output as { object?: unknown }).object, {
                maxTokens: compactionBudget.summaryOutputTokens,
                attachmentCatalog,
                lineageDepth,
              });
              shadowCheckpoint = shadow.checkpoint;
              shadowTokens = shadow.tokens;
            }
            const shadowProjection = projectCompaction({
              budget: conversationBudget,
              fixedTokens: input.fixedTokens,
              previousCheckpointTokens: shadowPreviousSummaryTokens,
              sourceTokens: shadowSourceTokens,
              retainedTokens: shadowCut.retainedTokens,
              pendingTokens: input.pendingTokens,
              candidateTokens: shadowTokens,
            });
            console.info('[thread-compaction] v2 shadow candidate', {
              resourceId: input.resourceId,
              threadId: input.threadId,
              generation: job.generation,
              mode: v2CompactionMode,
              wouldAccept: shadowProjection.accepted,
              reason: shadowProjection.reason,
              tokensBefore: shadowProjection.tokensBefore,
              tokensAfter: shadowProjection.tokensAfter,
              reclaimedTokens: shadowProjection.reclaimedTokens,
            });
          } catch (error) {
            if (input.abortSignal?.aborted) throw error;
            console.warn('[thread-compaction] v2 shadow candidate failed', {
              resourceId: input.resourceId,
              threadId: input.threadId,
              generation: job.generation,
              error: redactCompactionText(error instanceof Error ? error.message : String(error)),
            });
          }
        }
        await this.compactions.complete(job.id, {
          summary: validatedLegacy.summary,
          checkpoint,
          compactedThroughMessageId: cut.compactedThrough.id,
          compactedThroughCreatedAt: timestampString(cut.compactedThrough.createdAt),
          compactedMessageCount: cut.compactedMessageCount,
          firstRetainedMessageId: cut.firstRetained?.id,
          sourceTokens,
          summaryTokens: validatedLegacy.tokens,
          projectedTokens: projection.tokensAfter,
          projectionBeforeTokens: projection.tokensBefore,
          projectionAfterTokens: projection.tokensAfter,
          reclaimedTokens: projection.reclaimedTokens,
          sourceFingerprint: compactionSourceFingerprint(cut.source),
        });
        if (v2Mode === 'shadow') {
          console.info('[thread-compaction] legacy decision during v2 shadow rollout', {
            resourceId: input.resourceId,
            threadId: input.threadId,
            generation: job.generation,
            accepted: true,
            reason: projection.reason,
            tokensBefore: projection.tokensBefore,
            tokensAfter: projection.tokensAfter,
            reclaimedTokens: projection.reclaimedTokens,
          });
        }
        input.onEvent?.({
          type: 'data-thread-compaction',
          data: {
            phase: 'completed',
            compactionId: job.id,
            origin: input.origin ?? (input.trigger === 'manual' ? 'manual' : 'pre_run'),
            trigger: job.trigger,
            generation: job.generation,
            mode: compactionMode,
            tokensBefore: projection.tokensBefore,
            tokensAfter: projection.tokensAfter,
            reclaimedTokens: projection.reclaimedTokens,
            headroomTokens: projection.headroomTokens,
          },
        });
        const completedCheckpoint = await this.compactions.latest(input.resourceId, input.threadId);
        return { status: 'completed', checkpoint: completedCheckpoint, budget: conversationBudget };
      }

      const attachmentCatalog = collectCompactionAttachments(messages.slice(0, cut.firstRetainedIndex));
      const lineageDepth = compactionMode === 'rebuild' ? 0 : (previousCheckpoint?.lineageDepth ?? 0) + 1;
      let checkpoint = compactionMode === 'incremental' ? previousCheckpoint : undefined;
      let validated: ReturnType<typeof validateStructuredCheckpoint> | undefined;

      const generateTranscript = async (transcript: string, splitDepth = 0): Promise<void> => {
        const validationErrors: string[] = [];
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            const output = await agent.generate(
              buildCompactionPrompt({
                previousCheckpoint: checkpoint,
                transcript,
                instructions: input.instructions,
                mode: checkpoint ? 'incremental' : compactionMode,
                validationErrors,
              }),
              {
                maxSteps: 1,
                model: ownerScopedSubscriptionModel(routeSubscriptionModel(compactionModel), input.resourceId),
                maxOutputTokens: compactionBudget.summaryOutputTokens,
                providerOptions: buildProviderOptions(undefined, {
                  reasoningEffort: 'medium',
                }),
                toolChoice: 'none',
                structuredOutput: { schema: structuredCheckpointV2OutputSchema },
                ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
              } as never,
            );
            validated = validateStructuredCheckpoint((output as { object?: unknown }).object, {
              maxTokens: compactionBudget.summaryOutputTokens,
              attachmentCatalog,
              lineageDepth,
            });
            checkpoint = validated.checkpoint;
            return;
          } catch (error) {
            if (input.abortSignal?.aborted) throw error;
            validationErrors.push(redactCompactionText(error instanceof Error ? error.message : String(error)));
          }
        }

        if (splitDepth < 3 && transcript.length > 1_024) {
          const middle = Math.floor(transcript.length / 2);
          await generateTranscript(transcript.slice(0, middle), splitDepth + 1);
          await generateTranscript(transcript.slice(middle), splitDepth + 1);
          return;
        }
        throw new Error(validationErrors.at(-1) ?? 'Compaction checkpoint generation failed.');
      };

      for (const transcript of batchCompactionTranscripts(cut.source, inputCapacity)) {
        await generateTranscript(transcript);
      }
      if (!validated || !checkpoint) throw new Error('Compaction produced no structured checkpoint.');

      const projection = projectCompaction({
        budget: conversationBudget,
        fixedTokens: input.fixedTokens,
        previousCheckpointTokens: previousSummaryTokens,
        sourceTokens,
        retainedTokens: cut.retainedTokens,
        pendingTokens: input.pendingTokens,
        candidateTokens: validated.tokens,
      });
      if (!projection.accepted) {
        await this.compactions.reject(job.id, {
          reason: projection.reason ?? 'insufficient_gain',
          projectionBeforeTokens: projection.tokensBefore,
          projectionAfterTokens: projection.tokensAfter,
          reclaimedTokens: projection.reclaimedTokens,
        });
        const attempt = await this.compactions.latest(input.resourceId, input.threadId, false);
        console.info('[thread-compaction] rejected', {
          resourceId: input.resourceId,
          threadId: input.threadId,
          generation: job.generation,
          trigger: job.trigger,
          mode: compactionMode,
          reason: projection.reason,
          tokensBefore: projection.tokensBefore,
          tokensAfter: projection.tokensAfter,
          reclaimedTokens: projection.reclaimedTokens,
        });
        input.onEvent?.({
          type: 'data-thread-compaction',
          data: {
            phase: 'rejected',
            compactionId: job.id,
            origin: input.origin ?? (input.trigger === 'manual' ? 'manual' : 'pre_run'),
            trigger: job.trigger,
            generation: job.generation,
            mode: compactionMode,
            reason: projection.reason,
            tokensBefore: projection.tokensBefore,
            tokensAfter: projection.tokensAfter,
            reclaimedTokens: projection.reclaimedTokens,
            headroomTokens: projection.headroomTokens,
          },
        });
        return {
          status: 'rejected',
          reason: projection.reason,
          attempt,
          budget: conversationBudget,
        };
      }

      await this.compactions.complete(job.id, {
        summary: validated.summary,
        checkpoint,
        compactedThroughMessageId: cut.compactedThrough.id,
        compactedThroughCreatedAt: timestampString(cut.compactedThrough.createdAt),
        compactedMessageCount: cut.compactedMessageCount,
        firstRetainedMessageId: cut.firstRetained?.id,
        sourceTokens,
        summaryTokens: validated.tokens,
        projectedTokens: projection.tokensAfter,
        projectionBeforeTokens: projection.tokensBefore,
        projectionAfterTokens: projection.tokensAfter,
        reclaimedTokens: projection.reclaimedTokens,
        sourceFingerprint: compactionSourceFingerprint(cut.source),
      });
      console.info('[thread-compaction] completed', {
        resourceId: input.resourceId,
        threadId: input.threadId,
        generation: job.generation,
        trigger: job.trigger,
        durationMs: Date.now() - Date.parse(job.startedAt),
        sourceTokens,
        mode: compactionMode,
        projectedTokens: projection.tokensAfter,
        reclaimedTokens: projection.reclaimedTokens,
        compressionRatio: sourceTokens > 0 ? validated.tokens / sourceTokens : 0,
      });
      input.onEvent?.({
        type: 'data-thread-compaction',
        data: {
          phase: 'completed',
          compactionId: job.id,
          origin: input.origin ?? (input.trigger === 'manual' ? 'manual' : 'pre_run'),
          trigger: job.trigger,
          generation: job.generation,
          mode: compactionMode,
          tokensBefore: projection.tokensBefore,
          tokensAfter: projection.tokensAfter,
          reclaimedTokens: projection.reclaimedTokens,
          headroomTokens: projection.headroomTokens,
        },
      });
      const completedCheckpoint = await this.compactions.latest(input.resourceId, input.threadId);
      return { status: 'completed', checkpoint: completedCheckpoint, budget: conversationBudget };
    } catch (error) {
      await this.compactions.fail(job.id, error, input.abortSignal?.aborted);
      input.onEvent?.({
        type: 'data-thread-compaction',
        data: {
          phase: input.abortSignal?.aborted ? 'cancelled' : 'failed',
          compactionId: job.id,
          origin: input.origin ?? (input.trigger === 'manual' ? 'manual' : 'pre_run'),
          trigger: job.trigger,
          generation: job.generation,
          mode: compactionMode,
          reason: input.abortSignal?.aborted ? 'cancelled' : 'generation_failed',
        },
      });
      console.error('[thread-compaction] failed', {
        resourceId: input.resourceId,
        threadId: input.threadId,
        generation: job.generation,
        trigger: job.trigger,
        durationMs: Date.now() - Date.parse(job.startedAt),
      });
      if (error instanceof ServiceError) throw error;
      throw new ServiceError(
        'operation_failed',
        redactCompactionText(error instanceof Error ? error.message : String(error)),
        500,
        { reason: 'compaction_failed' },
      );
    }
  }

  async updateChatThread(input: UpdateChatThreadRequest): Promise<ChatThreadRecord> {
    const memory = await this.getMemory();
    const thread = await memory.getThreadById({ threadId: input.threadId });
    if (!thread || thread.resourceId !== input.resourceId) {
      throw new ServiceError('operation_failed', 'thread not found', 404);
    }

    const metadata = { ...((thread.metadata ?? {}) as Record<string, unknown>) };
    if (input.archived !== undefined) metadata.archived = input.archived;
    return normalizeWeaveChatThread(
      await memory.updateThread({
        id: input.threadId,
        title: input.title || thread.title,
        metadata,
      }),
    );
  }

  async deleteChatThread(input: ChatThreadMessagesRequest): Promise<void> {
    const memory = await this.getMemory();
    const thread = await memory.getThreadById({ threadId: input.threadId });
    if (!thread || thread.resourceId !== input.resourceId) {
      throw new ServiceError('operation_failed', 'thread not found', 404);
    }

    if (threadCompactionEnabled()) await this.compactions.deleteThread(input.resourceId, input.threadId);
    await memory.deleteThread(input.threadId);
  }

  private async getMemory(): Promise<any> {
    const mastra = await this.getMastra();
    const agent = await mastra.getAgent('mageHandAgent');
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

  private async prepareChatRun(
    input: StartChatRunRequest,
    options: {
      automaticCompaction?: 'perform' | 'defer';
      activeRun?: AgentThreadRun;
    } = {},
  ) {
    const params = input.params;
    putThreadCompactionContext(input.requestContext, undefined);
    putThreadCompactionStepRuntime(input.requestContext, undefined);
    const mastra = await this.getMastra();
    const executionProfile = normalizeExecutionProfile(params.executionProfile);
    putExecutionProfile(input.requestContext, executionProfile);
    putChatRuntimeContext(input.requestContext, { now: new Date() });
    const resolvedContext = input.resourceId
      ? await this.contextResolver({ mastra, resourceId: input.resourceId, threadId: input.threadId })
      : undefined;
    if (resolvedContext) putAgentContext(input.requestContext, resolvedContext);
    const selectedModel = stringValue(params.model) ?? resolvedContext?.config.model ??
      (await getModelConfig()).defaultModel;
    const contextBudget = await this.resolveContextBudget(selectedModel);
    putModelContextBudget(input.requestContext, contextBudget);

    const isProjectWorkspace = Boolean(
      resolvedContext?.threadMetadata?.mode === 'project' && resolvedContext.threadMetadata.workspaceId,
    );
    const isGitProject = resolvedContext?.projectKind === 'git';
    const isNotesProject = resolvedContext?.projectKind === 'notes';
    markGitWorkspaceContext(input.requestContext, isProjectWorkspace);
    markGitProjectContext(input.requestContext, isGitProject);
    const skillSummaries = resolvedContext ? listResolvedContextSkillSummaries(resolvedContext) : [];
    const system = buildChatSystemMessages({
      includeGitInstructions: isGitProject,
      includeNotesInstructions: isNotesProject,
      agentFiles: resolvedContext?.agentFiles,
      skillSummaries,
      callerSystem: params.system as Parameters<typeof buildChatSystemMessages>[0]['callerSystem'],
    });
    const minimumFixedInputTokens = estimateInputValueTokens(system);

    const memory = input.threadId && threadCompactionEnabled() ? await this.getMemory() : undefined;
    let checkpoint = input.threadId && threadCompactionEnabled()
      ? await this.compactions.latest(input.resourceId, input.threadId)
      : undefined;
    let totalMessages = checkpoint && memory && input.threadId
      ? await this.getStoredMessageTotal(memory, { resourceId: input.resourceId, threadId: input.threadId })
      : undefined;
    const memoryPolicyFor = () =>
      resolvedContext
        ? resolveMemoryPolicy({
          agentMemory: resolvedContext.config.memory,
          threadMetadata: resolvedContext.threadMetadata,
          tokenLimit: contextBudget.contextLimitTokens,
          lastMessages: checkpoint?.compactedMessageCount !== undefined && totalMessages !== undefined
            ? Math.max(1, totalMessages - checkpoint.compactedMessageCount)
            : undefined,
        })
        : undefined;
    let memoryPolicy = memoryPolicyFor();

    let automaticCompaction: ThreadCompactionRecord | undefined;
    let automaticCompactionNeeded = false;
    if (input.threadId && memory && memoryPolicy && threadCompactionEnabled()) {
      const compactionMemoryOptions = memoryPolicy.options;
      const snapshot = getThreadContextUsageSnapshot(input.threadId, input.resourceId);
      const checkpointIsNewer = checkpoint?.completedAt &&
        (!snapshot?.updatedAt || Date.parse(checkpoint.completedAt) > Date.parse(snapshot.updatedAt));
      const checkpointTokens = checkpoint?.summary ? Math.ceil(checkpoint.summary.length / 4) : 0;
      let estimatedMemoryTokens: number | undefined;
      const getEstimatedMemoryTokens = async () =>
        estimatedMemoryTokens ??= await estimateMemoryContextTokens(memory, {
          threadId: input.threadId!,
          resourceId: input.resourceId,
          memoryConfig: compactionMemoryOptions,
        });
      const usedTokens = checkpointIsNewer && checkpoint?.projectedTokens !== undefined
        ? checkpoint.projectedTokens
        : snapshot?.usedTokens ?? (await getEstimatedMemoryTokens()) + checkpointTokens;
      const pendingTokens = estimatePendingMessageTokens(input.submittedUserMessages);
      if (usedTokens + pendingTokens >= contextBudget.contextLimitTokens) {
        automaticCompactionNeeded = true;
        if ((options.automaticCompaction ?? 'perform') === 'perform') {
          const hardCeilingTokens = Math.floor(contextBudget.advertisedContextTokens * 0.95);
          const dynamicMemoryTokens = await getEstimatedMemoryTokens();
          const fixedTokens = Math.max(
            minimumFixedInputTokens,
            usedTokens - dynamicMemoryTokens - checkpointTokens,
          );
          try {
            const result = await this.compactChatThread({
              resourceId: input.resourceId,
              threadId: input.threadId,
              model: selectedModel,
              trigger: 'automatic',
              origin: 'pre_run',
              activeRunId: options.activeRun?.runId,
              fixedTokens,
              pendingTokens,
              abortSignal: options.activeRun?.controller.signal ?? input.abortSignal,
              ...(options.activeRun
                ? {
                  onEvent: (event) => this.runCoordinator.appendChunk(options.activeRun!, event),
                }
                : {}),
            });
            automaticCompaction = result.checkpoint;
            checkpoint = await this.compactions.latest(input.resourceId, input.threadId);
            if (result.status === 'completed') {
              totalMessages = checkpoint
                ? await this.getStoredMessageTotal(memory, { resourceId: input.resourceId, threadId: input.threadId })
                : undefined;
              memoryPolicy = memoryPolicyFor();
            }

            const projectedTokens = result.checkpoint?.projectionAfterTokens ?? result.attempt?.projectionAfterTokens ??
              usedTokens + pendingTokens;
            if (projectedTokens >= hardCeilingTokens) {
              throw new ServiceError(
                'operation_failed',
                'Compaction could not reduce the thread below the provider safety ceiling.',
                409,
                { reason: 'context_limit_exceeded', projectedTokens, hardCeilingTokens },
              );
            }
          } catch (error) {
            if (options.activeRun?.controller.signal.aborted || input.abortSignal?.aborted) throw error;
            if (
              error instanceof ServiceError && isRecord(error.details) &&
              error.details.reason === 'context_limit_exceeded'
            ) throw error;
            if (usedTokens + pendingTokens >= hardCeilingTokens) {
              throw new ServiceError(
                'operation_failed',
                'The thread exceeds the provider safety ceiling and compaction failed.',
                409,
                { reason: 'context_limit_exceeded', projectedTokens: usedTokens + pendingTokens, hardCeilingTokens },
              );
            }
            console.warn('[thread-compaction] proceeding below hard ceiling after automatic compaction failure', {
              resourceId: input.resourceId,
              threadId: input.threadId,
              projectedTokens: usedTokens + pendingTokens,
              hardCeilingTokens,
              error: redactCompactionText(error instanceof Error ? error.message : String(error)),
            });
          }
        }
      }
    }
    putThreadCompactionContext(
      input.requestContext,
      checkpoint ? { checkpoint, budget: contextBudget } : undefined,
    );
    if (options.activeRun && input.threadId && memory && memoryPolicy && threadCompactionEnabled()) {
      const run = options.activeRun;
      putThreadCompactionStepRuntime(input.requestContext, {
        compactIfNeeded: async ({ messages, abortSignal }) => {
          if (run.controller.signal.aborted || abortSignal?.aborted) return undefined;
          const latestCheckpoint = await this.compactions.latest(input.resourceId, input.threadId!);
          const checkpointTokens = latestCheckpoint?.summary ? Math.ceil(latestCheckpoint.summary.length / 4) : 0;
          const dynamicTokens = messages.reduce((total, message) => total + estimateMessageTokens(message), 0) +
            checkpointTokens;
          const latestSnapshot = getThreadContextUsageSnapshot(input.threadId!, input.resourceId);
          const fixedTokens = Math.max(
            minimumFixedInputTokens,
            (latestSnapshot?.usedTokens ?? dynamicTokens) - dynamicTokens,
          );
          const projectedTokens = fixedTokens + dynamicTokens;
          if (projectedTokens < contextBudget.contextLimitTokens) return undefined;

          const hardCeilingTokens = Math.floor(contextBudget.advertisedContextTokens * 0.95);
          this.runCoordinator.setPhase(run, 'compacting');
          try {
            const result = await this.compactChatThread({
              resourceId: input.resourceId,
              threadId: input.threadId!,
              model: selectedModel,
              trigger: 'automatic',
              origin: 'mid_run',
              activeRunId: run.runId,
              fixedTokens,
              abortSignal: run.controller.signal,
              onEvent: (event) => this.runCoordinator.appendChunk(run, event),
            });
            const afterTokens = result.checkpoint?.projectionAfterTokens ?? result.attempt?.projectionAfterTokens ??
              projectedTokens;
            if (afterTokens >= hardCeilingTokens) {
              throw new ServiceError(
                'operation_failed',
                'Mid-run compaction could not reduce context below the provider safety ceiling.',
                409,
                { reason: 'context_limit_exceeded', projectedTokens: afterTokens, hardCeilingTokens },
              );
            }
            if (result.checkpoint) {
              putThreadCompactionContext(input.requestContext, {
                checkpoint: result.checkpoint,
                budget: contextBudget,
              });
            }
            return result.checkpoint;
          } catch (error) {
            if (run.controller.signal.aborted || projectedTokens >= hardCeilingTokens) throw error;
            console.warn('[thread-compaction] mid-run attempt failed below hard ceiling', {
              resourceId: input.resourceId,
              threadId: input.threadId,
              projectedTokens,
              hardCeilingTokens,
              error: redactCompactionText(error instanceof Error ? error.message : String(error)),
            });
            return undefined;
          } finally {
            if (!run.controller.signal.aborted) this.runCoordinator.setPhase(run, 'generating');
          }
        },
      });
    }
    const routedModel = routeSubscriptionModel(selectedModel);
    const providerModel = routedModel ?? selectedModel;
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

    return {
      selectedModel,
      routedModel,
      reasoningEffort,
      serviceTier,
      memoryPolicyStatus: memoryPolicy?.status,
      providerOptions: buildProviderOptions(params.providerOptions, {
        reasoningEffort,
        serviceTier,
        threadId: input.threadId,
        resourceId: input.resourceId,
        contextBudget,
      }),
      memory: isRecord(params.memory)
        ? {
          ...params.memory,
          ...(input.resourceId ? { resource: input.resourceId } : {}),
          ...(memoryPolicy ? { options: memoryPolicy.options } : {}),
        }
        : params.memory,
      system,
      automaticCompaction,
      automaticCompactionNeeded,
      executionProfile,
      verificationEnabled: params.verify !== false && isGitProject,
      skillSummaries,
      resolvedContext,
      contextBudget,
    };
  }

  async runPrompt(input: AgentRunRequest): Promise<JsonValue> {
    const agentIds = resolveAgentIds(input.agentId);
    const agent = await this.getAgentOrThrow(agentIds.mastraAgentId, agentIds.agentId);
    return this.generatePrompt(input, agent);
  }

  private async getAgentOrThrow(agentId: string, displayId = agentId): Promise<any> {
    const mastra = await this.getMastra();
    const agent = await mastra.getAgent(agentId);
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
      maxSteps: clampAgentMaxSteps(input.maxSteps),
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

  private async resolveContextBudget(modelId: string) {
    try {
      const model = await resolveModelOption(modelId);
      return resolveModelContextBudget(model.id, model.contextWindow!);
    } catch (error) {
      throw new ServiceError(
        'operation_failed',
        error instanceof Error ? error.message : String(error),
        400,
        { reason: 'model_context_unavailable', modelId },
      );
    }
  }

  private async getStoredMessageTotal(memory: any, input: ChatThreadMessagesRequest) {
    const result = await memory.recall({
      threadId: input.threadId,
      resourceId: input.resourceId,
      page: 0,
      perPage: 1,
      orderBy: { field: 'createdAt', direction: 'ASC' },
    });
    return typeof result.total === 'number' ? result.total : result.messages?.length ?? 0;
  }

  private async getMastra() {
    return typeof this.mastraProvider === 'function' ? await this.mastraProvider() : this.mastraProvider;
  }

  private async promptContext(context: PromptContextInput): Promise<any> {
    return {
      mastra: await this.getMastra(),
      resourceId: context.resourceId,
      threadId: context.threadId,
      projectId: context.projectId,
      workspaceId: context.workspaceId,
    };
  }
}

export const agentRunCoordinator = new AgentRunCoordinator({ repository: agentRunRepository });
export const agentService = new MastraAgentService(loadDefaultMastra, agentRunCoordinator);

const stringValue = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

const stableJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableJsonValue(value[key])]),
  );
};

const containsToolApprovalResponse = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(containsToolApprovalResponse);
  if (!isRecord(value)) return false;
  if (value.state === 'approval-responded' || value.type === 'tool-approval-response') return true;
  return Object.values(value).some(containsToolApprovalResponse);
};

const collectRepositoryVerifierEvidence = async (resourceId: string, context: ResolvedAgentContext | undefined) => {
  const projectId = stringValue(context?.threadMetadata?.projectId);
  const workspaceId = stringValue(context?.threadMetadata?.workspaceId);
  const workspacePath = stringValue(context?.workspace?.path) ?? context?.projectSnapshot?.workspacePath;
  if (!context?.portalId || !projectId || !workspaceId || !workspacePath) return { available: false };
  const target = {
    portalId: context.portalId,
    projectId,
    workspaceId,
    rootId: stringValue(context.project?.portalRootId),
    repoPath: stringValue(context.project?.repoPath),
    workspacePath,
    executionProfile: 'observe' as const,
  };
  const request = (tool: string, args: unknown) =>
    toolService.requestPortal({
      caller: callerForOwner(resourceId, 'agent'),
      target,
      tool,
      args,
      timeoutMs: 15_000,
    }).catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  const [status, unstaged, staged] = await Promise.all([
    request('portal.git.status', {}),
    request('portal.git.diff', {}),
    request('portal.git.diff', { staged: true }),
  ]);
  return {
    available: true,
    evidence: compactText(JSON.stringify({ status, unstaged, staged }), 60_000).text,
  };
};

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

const ownerScopedSubscriptionModel = (model: unknown, ownerId: string) => [{
  model,
  headers: credentialOwnerHeaders(ownerId),
}];

export const threadCompactionEnabled = () => {
  const value = process.env.WEAVE_THREAD_COMPACTION?.trim().toLowerCase();
  return value === undefined || value === '' || (value !== '0' && value !== 'false');
};

export const threadCompactionV2Mode = (): 'legacy' | 'shadow' | 'active' => {
  const value = process.env.WEAVE_COMPACTION_V2_MODE?.trim().toLowerCase();
  return value === 'shadow' || value === 'active' ? value : 'legacy';
};

const shouldSampleCompactionShadow = (id: string) => {
  const configured = Number(process.env.WEAVE_COMPACTION_V2_SHADOW_SAMPLE_PERCENT ?? 10);
  const percent = Number.isFinite(configured) ? Math.min(100, Math.max(0, configured)) : 10;
  const bucket = Number.parseInt(hashText(id).slice(0, 8), 16) % 100;
  return bucket < percent;
};

const estimatePendingMessageTokens = (messages: unknown[] | undefined) => {
  if (!messages?.length) return 0;
  try {
    return Math.ceil(JSON.stringify(messages).length / 4) + messages.length * 4;
  } catch {
    return 0;
  }
};

const estimateInputValueTokens = (value: unknown) => {
  if (value === undefined || value === null) return 0;
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  return Math.ceil(serialized.length / 4);
};

const persistedThreadRunSnapshot = (record: AgentRunRecordV1): AgentThreadRunSnapshot => {
  const status = record.status === 'failed' || record.status === 'interrupted' ? 'error' as const : record.status;
  const phase = record.metadata.phase === 'compacting' || record.metadata.phase === 'generating'
    ? record.metadata.phase
    : undefined;
  const active = status === 'running';
  const startedAt = Date.parse(record.startedAt);
  const endedAt = active ? Date.now() : Date.parse(record.completedAt ?? record.updatedAt);
  return {
    active,
    status,
    runId: record.runId,
    ...(phase ? { phase } : {}),
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    ...(Number.isFinite(startedAt) && Number.isFinite(endedAt) ? { durationMs: Math.max(0, endedAt - startedAt) } : {}),
    ...(record.error ? { error: record.error } : {}),
  };
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
    .filter((thread: StorageThreadType) => !isHiddenChatThread(thread))
    .filter((thread: StorageThreadType) => {
      const metadata = (thread.metadata ?? {}) as Record<string, unknown>;
      if (metadata.archived === true) return false;
      if (scope.projectId) return metadata.projectId === scope.projectId && metadata.workspaceId === scope.workspaceId;
      return metadata.adHoc === true || (metadata.mode !== 'project' && typeof metadata.projectId !== 'string');
    })
    .map((thread: StorageThreadType) => thread.metadata?.sortOrder)
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

const isNoThreadFoundError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('No thread found');
};

const workflowSnapshotToolCallPayload = (snapshot: unknown) => {
  const parsed = parseJsonString(snapshot);
  if (!isRecord(parsed)) return [];

  const context = isRecord(parsed.context) ? parsed.context : undefined;
  const toolCallStep = isRecord(context?.toolCallStep) ? context.toolCallStep : undefined;
  return Array.isArray(toolCallStep?.payload) ? toolCallStep.payload : [];
};

export const extractSuspendedAskUserRunIdsFromWorkflowSnapshots = (rows: Array<Record<string, unknown>>) => {
  const runIdsByToolCallId: Record<string, string> = {};

  for (const row of rows) {
    const runId = stringValue(row.run_id) ?? stringValue(row.runId);
    if (!runId) continue;

    for (const item of workflowSnapshotToolCallPayload(row.snapshot)) {
      if (!isRecord(item) || item.toolName !== 'ask_user') continue;
      const toolCallId = stringValue(item.toolCallId);
      if (!toolCallId || runIdsByToolCallId[toolCallId]) continue;
      runIdsByToolCallId[toolCallId] = runId;
    }
  }

  return runIdsByToolCallId;
};

const buildProviderOptions = (
  providerOptions: unknown,
  options: {
    reasoningEffort?: string;
    serviceTier?: string;
    threadId?: unknown;
    resourceId?: string;
    contextBudget?: ModelContextBudget;
  },
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
          ...(options.contextBudget
            ? {
              modelId: options.contextBudget.modelId,
              advertisedContextTokens: options.contextBudget.advertisedContextTokens,
              contextLimitPercent: options.contextBudget.contextLimitPercent,
              maxTokens: options.contextBudget.contextLimitTokens,
            }
            : {}),
        },
      }
      : {}),
  };
};

const toGenericRunSnapshot = (run: AgentThreadRun): AgentRunSnapshot => ({
  runId: run.runId,
  agentId: 'mage-hand',
  status: run.status === 'error'
    ? 'failed'
    : run.status === 'cancelling' || run.status === 'awaiting_approval'
    ? 'running'
    : run.status,
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
