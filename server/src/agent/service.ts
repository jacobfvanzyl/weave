import { handleChatStream, toAISdkStream } from '@mastra/ai-sdk';
import type { AgentMessageInput, MastraDBMessage } from '@mastra/core/agent';
import type { Mastra } from '@mastra/core/mastra';
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
  normalizeAskUserSuspensionStream,
  toThreadRunSnapshot,
} from './run-coordinator';
import { contextUsageRecallOptions, estimateMemoryContextTokens } from './context-token-estimate';
import { type EventService, eventService as defaultEventService } from '../services/event-service';
import { callerForOwner, type JsonValue, type ServiceCaller, ServiceError } from '../services/types';
import { toolService } from '../services/tool-runtime';
import { getWeaveDb } from '../storage/postgres';
import {
  batchCompactionMessages,
  buildCompactionPrompt,
  compactionSourceFingerprint,
  estimateMessageTokens,
  putThreadCompactionContext,
  selectCompactionCut,
  serializeCompactionMessages,
  validateCompactionSummary,
} from './thread-compaction';
import {
  type ThreadCompactionRecord,
  type ThreadCompactionRepository,
  threadCompactionRepository,
  type ThreadCompactionTrigger,
} from './thread-compaction-repository';
import { chatGPTCodexAuthService } from './mastra/providers/chatgpt-codex-auth';

export const hashChatSystemPrompt = (system: unknown) =>
  hashText(JSON.stringify(system ?? null));

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
  source: string;
  updatedAt?: string;
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
};

export type CompactChatThreadResult = {
  status: 'completed' | 'not_needed';
  checkpoint?: ThreadCompactionRecord;
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
  ): Promise<ReadableStream<{ sequence: number; chunk: unknown }> | undefined>;
  getPersistedChatRun(resourceId: string, threadId: string): Promise<AgentRunRecordV1 | undefined>;
  respondToToolApproval(input: RespondToToolApprovalRequest): Promise<StartChatRunResult>;
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
    let existingRun = input.threadId ? this.runCoordinator.getThreadRun(input.resourceId, input.threadId) : undefined;
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

    const prepared = await this.prepareChatRun(input);
    const mastra = await this.getMastra();
    const { executionProfile: _executionProfile, verify: _verify, ...chatParams } = input.params;
    const mastraRunId = existingRun?.mastraRunId ?? stringValue(input.params.runId) ?? crypto.randomUUID();
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
    };
    const run = existingRun ??
      (input.threadId
        ? this.runCoordinator.createThreadRun(input.resourceId, input.threadId, input.submittedUserMessages ?? [], {
          mastraRunId,
          executionProfile: prepared.executionProfile,
          model: stringValue(input.params.model),
          requestContext: input.requestContext,
          metadata: runMetadata,
        })
        : undefined);

    try {
      if (run && !existingRun) await this.runCoordinator.flushPersistence(run);
      const maxSteps = getAgentMaxSteps();
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
          ...chatParams,
          maxSteps,
          runId: mastraRunId,
          ...(prepared.routedModel
            ? { model: ownerScopedSubscriptionModel(prepared.routedModel, input.resourceId) }
            : {}),
          providerOptions: prepared.providerOptions as never,
          memory: prepared.memory as never,
          system: prepared.system as never,
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
                `execution:${prepared.executionProfile}`,
              ]),
            ],
          },
        } as never,
      });

      const modelStream = prepared.automaticCompaction
        ? prependStreamValues(
          stream as ReadableStream<unknown>,
          threadCompactionStreamEvents(prepared.automaticCompaction),
        )
        : stream as ReadableStream<unknown>;
      const verifiedStream = prepared.verificationEnabled && run
        ? appendRunVerification(modelStream, {
          requirements: input.submittedUserMessages ?? [],
          verify: async (evidence) => {
            try {
              const repositoryEvidence = await collectRepositoryVerifierEvidence(
                input.resourceId,
                prepared.resolvedContext,
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
        : modelStream;
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

  async replaySequencedChatRun(resourceId: string, threadId: string, afterSequence = 0) {
    const inMemory = this.runCoordinator.getThreadRun(resourceId, threadId);
    if (inMemory) return this.runCoordinator.observeSequencedRun(inMemory, afterSequence);

    const persisted = await this.persistedRuns.latest(resourceId, threadId);
    if (!persisted) return undefined;
    if (persisted.status === 'running') await this.persistedRuns.interrupt(persisted.runId);
    const events = await this.persistedRuns.events(persisted.runId, afterSequence);
    return new ReadableStream<{ sequence: number; chunk: unknown }>({
      start(controller) {
        for (const event of events) controller.enqueue({ sequence: event.sequence, chunk: event.data });
        controller.close();
      },
    });
  }

  getPersistedChatRun(resourceId: string, threadId: string) {
    return this.persistedRuns.latest(resourceId, threadId);
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
        if (!isRecord(chunk)) return false;
        const data = isRecord(chunk.data) ? chunk.data : undefined;
        return chunk.toolCallId === input.toolCallId || data?.toolCallId === input.toolCallId;
      });
      if (isRecord(approvalChunk)) {
        const data = isRecord(approvalChunk.data) ? approvalChunk.data : undefined;
        const toolName = stringValue(approvalChunk.toolName) ?? stringValue(data?.toolName);
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
      updatedAt: checkpointIsNewer ? completedCheckpoint?.completedAt : snapshot?.updatedAt,
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
    if (this.hasActiveThreadRun(input.resourceId, input.threadId)) {
      throw new ServiceError('operation_failed', 'thread has an active stream', 409, { reason: 'active_run' });
    }

    const memory = await this.getMemory();
    const thread = await memory.getThreadById({ threadId: input.threadId });
    if (!thread || thread.resourceId !== input.resourceId) {
      throw new ServiceError('operation_failed', 'thread not found', 404);
    }

    const conversationBudget = await this.resolveContextBudget(input.model);
    const previous = await this.compactions.latest(input.resourceId, input.threadId);
    const messages = await this.recallThreadMessages(memory, input);
    const cut = selectCompactionCut(
      messages,
      conversationBudget.recentTailTokens,
      previous?.compactedMessageCount ?? 0,
    );
    if (!cut) return { status: 'not_needed', budget: conversationBudget };

    const compactionModel = process.env.WEAVE_COMPACTION_MODEL?.trim() || 'openai/gpt-5.6-luna';
    const compactionBudget = await this.resolveContextBudget(compactionModel);
    const promptOverheadTokens = 2_000;
    const previousSummaryTokens = previous?.summary ? Math.ceil(previous.summary.length / 4) : 0;
    const inputCapacity = compactionBudget.contextLimitTokens - compactionBudget.summaryOutputTokens -
      promptOverheadTokens - Math.max(previousSummaryTokens, compactionBudget.summaryOutputTokens);
    if (inputCapacity <= 0) {
      throw new ServiceError('operation_failed', 'Compaction model has no remaining input capacity.', 500);
    }

    const sourceTokens = cut.source.reduce((total, message) => total + estimateMessageTokens(message), 0);
    if ((input.trigger ?? 'manual') === 'automatic') {
      const latestAttempt = await this.compactions.latest(input.resourceId, input.threadId, false);
      const retryAt = latestAttempt?.status === 'failed' ? Date.parse(latestAttempt.updatedAt) + 15 * 60 * 1000 : 0;
      const enoughNewContext = latestAttempt?.status !== 'failed' ||
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
      const batches = batchCompactionMessages(cut.source, inputCapacity);
      let summary = previous?.summary;
      for (const batch of batches) {
        const output = await agent.stream(
          buildCompactionPrompt({
            previousSummary: summary,
            transcript: serializeCompactionMessages(batch),
            instructions: input.instructions,
          }),
          {
            model: ownerScopedSubscriptionModel(routeSubscriptionModel(compactionModel), input.resourceId),
            maxOutputTokens: compactionBudget.summaryOutputTokens,
            providerOptions: buildProviderOptions(undefined, {
              reasoningEffort: 'medium',
            }),
            toolChoice: 'none',
            ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
          } as never,
        );
        summary = validateCompactionSummary(
          String(await (output as { text: Promise<unknown> }).text),
          compactionBudget.summaryOutputTokens,
        ).summary;
      }

      const validated = validateCompactionSummary(summary ?? '', compactionBudget.summaryOutputTokens);
      await this.compactions.complete(job.id, {
        summary: validated.summary,
        compactedThroughMessageId: cut.compactedThrough.id,
        compactedThroughCreatedAt: timestampString(cut.compactedThrough.createdAt),
        compactedMessageCount: cut.compactedMessageCount,
        firstRetainedMessageId: cut.firstRetained?.id,
        sourceTokens,
        summaryTokens: validated.tokens,
        projectedTokens: validated.tokens + cut.retainedTokens,
        sourceFingerprint: compactionSourceFingerprint(cut.source),
      });
      console.info('[thread-compaction] completed', {
        resourceId: input.resourceId,
        threadId: input.threadId,
        generation: job.generation,
        trigger: job.trigger,
        durationMs: Date.now() - Date.parse(job.startedAt),
        sourceTokens,
        projectedTokens: validated.tokens + cut.retainedTokens,
        compressionRatio: sourceTokens > 0 ? validated.tokens / sourceTokens : 0,
      });
      const checkpoint = await this.compactions.latest(input.resourceId, input.threadId);
      return { status: 'completed', checkpoint, budget: conversationBudget };
    } catch (error) {
      await this.compactions.fail(job.id, error, input.abortSignal?.aborted);
      console.error('[thread-compaction] failed', {
        resourceId: input.resourceId,
        threadId: input.threadId,
        generation: job.generation,
        trigger: job.trigger,
        durationMs: Date.now() - Date.parse(job.startedAt),
      });
      if (error instanceof ServiceError) throw error;
      throw new ServiceError('operation_failed', error instanceof Error ? error.message : String(error), 500, {
        reason: 'compaction_failed',
      });
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

  private async prepareChatRun(input: StartChatRunRequest) {
    const params = input.params;
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
    if (input.threadId && memory && memoryPolicy && threadCompactionEnabled()) {
      const snapshot = getThreadContextUsageSnapshot(input.threadId, input.resourceId);
      const checkpointIsNewer = checkpoint?.completedAt &&
        (!snapshot?.updatedAt || Date.parse(checkpoint.completedAt) > Date.parse(snapshot.updatedAt));
      const usedTokens = checkpointIsNewer && checkpoint?.projectedTokens !== undefined
        ? checkpoint.projectedTokens
        : snapshot?.usedTokens ?? (await estimateMemoryContextTokens(memory, {
              threadId: input.threadId,
              resourceId: input.resourceId,
              memoryConfig: memoryPolicy.options,
            })) + (checkpoint?.summary ? Math.ceil(checkpoint.summary.length / 4) : 0);
      const pendingTokens = estimatePendingMessageTokens(input.submittedUserMessages);
      if (usedTokens + pendingTokens >= contextBudget.contextLimitTokens) {
        const result = await this.compactChatThread({
          resourceId: input.resourceId,
          threadId: input.threadId,
          model: selectedModel,
          trigger: 'automatic',
          abortSignal: input.abortSignal,
        });
        automaticCompaction = result.checkpoint;
        if (!result.checkpoint) {
          throw new ServiceError(
            'operation_failed',
            'The thread exceeds the selected model context limit and does not yet have a safe compaction boundary.',
            409,
            { reason: 'context_limit_exceeded' },
          );
        }
        checkpoint = await this.compactions.latest(input.resourceId, input.threadId);
        totalMessages = checkpoint
          ? await this.getStoredMessageTotal(memory, { resourceId: input.resourceId, threadId: input.threadId })
          : undefined;
        memoryPolicy = memoryPolicyFor();
        if (
          (checkpoint?.projectedTokens ?? contextBudget.contextLimitTokens) + pendingTokens >=
            contextBudget.contextLimitTokens
        ) {
          throw new ServiceError(
            'operation_failed',
            'Compaction could not reduce the thread below the selected model context limit.',
            409,
            { reason: 'context_limit_exceeded' },
          );
        }
      }
    }
    if (checkpoint) putThreadCompactionContext(input.requestContext, { checkpoint, budget: contextBudget });
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
      executionProfile,
    });

    return {
      routedModel,
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

const estimatePendingMessageTokens = (messages: unknown[] | undefined) => {
  if (!messages?.length) return 0;
  try {
    return Math.ceil(JSON.stringify(messages).length / 4) + messages.length * 4;
  } catch {
    return 0;
  }
};

const threadCompactionStreamEvents = (checkpoint: ThreadCompactionRecord) => {
  const budget = {
    modelId: checkpoint.conversationModel,
    advertisedContextTokens: checkpoint.advertisedContextTokens,
    contextLimitPercent: checkpoint.contextLimitPercent,
    contextLimitTokens: checkpoint.contextLimitTokens,
    recentTailTokens: checkpoint.recentTailTokens,
    summaryOutputTokens: checkpoint.summaryOutputTokens,
  };
  return [
    {
      type: 'data-thread-compaction',
      data: { phase: 'started', generation: checkpoint.generation, trigger: checkpoint.trigger, ...budget },
    },
    {
      type: 'data-thread-compaction',
      data: {
        phase: 'completed',
        generation: checkpoint.generation,
        trigger: checkpoint.trigger,
        projectedTokens: checkpoint.projectedTokens,
        ...budget,
      },
    },
  ];
};

const prependStreamValues = <T>(stream: ReadableStream<T>, values: T[]) => {
  const reader = stream.getReader();
  return new ReadableStream<T>({
    start(controller) {
      for (const value of values) controller.enqueue(value);
    },
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
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
