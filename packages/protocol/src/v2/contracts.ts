import { z } from "zod";
import {
  binaryTransferDescriptorSchema,
  branchCleanupSchema,
  branchOptionSchema,
  chatThreadSchema,
  clientToolConnectionSchema,
  deleteWorkspaceResultSchema,
  discoveredWorktreeSchema,
  fileOperationResultSchema,
  jupyterHostEventSchema,
  jupyterKernelspecsResultSchema,
  jupyterSessionResultSchema,
  jupyterStatusResultSchema,
  liveEditorContextRequestSchema,
  liveEditorContextResultSchema,
  lspHostEventSchema,
  lspSessionResultSchema,
  ownerSchema,
  portalConnectionSchema,
  portalMountSchema,
  portalRootSchema,
  portalTargetSchema,
  projectSchema,
  storedWorkflowDefinitionSchema,
  terminalHostEventSchema,
  terminalSessionKindSchema,
  terminalTargetSchema,
  threadRunStateSchema,
  weaveChatChunkSchema,
  weaveChatMessageSchema,
  weaveNotificationEventSchema,
  workflowDefinitionSchema,
  workflowRunEventSchema,
  workflowRunSchema,
  workspaceFileDiffPreviewResultSchema,
  workspaceFileHashResultSchema,
  workspaceFileListResultSchema,
  workspaceFileReadResultSchema,
  workspaceFileTargetSchema,
  workspaceFileWatchHostEventSchema,
  workspaceFileWriteResultSchema,
  workspaceGitStateSchema,
  workspaceRemovalPreviewSchema,
  workspaceSchema,
} from "./dtos.ts";
import {
  emptyObjectSchema,
  jsonObjectSchema,
  jsonValueSchema,
  nonEmptyStringSchema,
  okResultSchema,
  type RpcRole,
  WEAVE_RPC_BINARY_CHUNK_BYTES,
  WEAVE_RPC_BINARY_WINDOW_SIZE,
  WEAVE_RPC_MAX_FRAME_BYTES,
  WEAVE_RPC_PROTOCOL_VERSION,
} from "./primitives.ts";

type Schema = z.ZodType;

export type RpcRequestContract<
  Method extends string = string,
  Source extends RpcRole = RpcRole,
  Destination extends RpcRole = RpcRole,
  Params extends Schema = Schema,
  Result extends Schema = Schema,
> = {
  readonly kind: "request";
  readonly method: Method;
  readonly source: Source;
  readonly destination: Destination;
  readonly params: Params;
  readonly result: Result;
};

export type RpcNotificationContract<
  Method extends string = string,
  Source extends RpcRole = RpcRole,
  Destination extends RpcRole = RpcRole,
  Params extends Schema = Schema,
> = {
  readonly kind: "notification";
  readonly method: Method;
  readonly source: Source;
  readonly destination: Destination;
  readonly params: Params;
};

const request = <
  const Method extends string,
  const Source extends RpcRole,
  const Destination extends RpcRole,
  Params extends Schema,
  Result extends Schema,
>(
  method: Method,
  source: Source,
  destination: Destination,
  params: Params,
  result: Result,
) => ({
  kind: "request",
  method,
  source,
  destination,
  params,
  result,
} as const satisfies RpcRequestContract<
  Method,
  Source,
  Destination,
  Params,
  Result
>);

const notification = <
  const Method extends string,
  const Source extends RpcRole,
  const Destination extends RpcRole,
  Params extends Schema,
>(
  method: Method,
  source: Source,
  destination: Destination,
  params: Params,
) => ({
  kind: "notification",
  method,
  source,
  destination,
  params,
} as const satisfies RpcNotificationContract<
  Method,
  Source,
  Destination,
  Params
>);

const idSchema = nonEmptyStringSchema;
const optionalIdSchema = idSchema.optional();
const stringArraySchema = z.array(z.string());
const sequenceSchema = z.number().int().nonnegative();
const targetParams = <Shape extends z.ZodRawShape>(shape: Shape) =>
  z.object({ target: workspaceFileTargetSchema, ...shape }).strict();

export const rpcClientMetadataSchema = z.object({
  clientAppId: idSchema,
  clientInstanceId: idSchema,
  name: idSchema.optional(),
  version: idSchema.optional(),
  surfaceId: idSchema.optional(),
  active: z.boolean().optional(),
  projectId: idSchema.optional(),
  threadId: idSchema.optional(),
  workspaceId: idSchema.optional(),
}).strict();

export const clientSurfaceUpdateParamsSchema = z.object({
  name: z.string().optional(),
  version: z.string().optional(),
  capabilities: z.array(z.string()).optional(),
  surfaceId: z.string().optional(),
  projectId: z.string().optional(),
  workspaceId: z.string().optional(),
  threadId: z.string().optional(),
  active: z.boolean().optional(),
}).strict();

export const rpcClientInitializeParamsSchema = z.object({
  protocolVersion: z.literal(WEAVE_RPC_PROTOCOL_VERSION),
  role: z.literal("client"),
  token: idSchema,
  capabilities: stringArraySchema.default([]),
  client: rpcClientMetadataSchema,
}).strict();

export const rpcPortalInitializeParamsSchema = z.object({
  protocolVersion: z.literal(WEAVE_RPC_PROTOCOL_VERSION),
  role: z.literal("portal"),
  token: idSchema,
  capabilities: stringArraySchema.default([]),
  portal: z.object({
    portalId: idSchema,
    name: idSchema,
    version: idSchema.optional(),
    instanceId: idSchema.optional(),
    mounts: z.array(portalMountSchema).default([]),
    roots: z.array(portalRootSchema).default([]),
  }).strict(),
}).strict();

export const rpcInitializeParamsSchema = z.discriminatedUnion("role", [
  rpcClientInitializeParamsSchema,
  rpcPortalInitializeParamsSchema,
]);
export type RpcInitializeParams = z.infer<typeof rpcInitializeParamsSchema>;

const initializeResultFields = {
  protocolVersion: z.literal(WEAVE_RPC_PROTOCOL_VERSION),
  connectionId: idSchema,
  heartbeatIntervalMs: z.number().int().positive(),
  maxFrameBytes: z.literal(WEAVE_RPC_MAX_FRAME_BYTES),
  capabilities: stringArraySchema,
};
export const rpcClientInitializeResultSchema = z.object({
  ...initializeResultFields,
  role: z.literal("client"),
  owner: ownerSchema,
}).strict();
export const rpcPortalInitializeResultSchema = z.object({
  ...initializeResultFields,
  role: z.literal("portal"),
  portal: z.object({ portalId: idSchema, name: z.string() }).strict(),
}).strict();
export const rpcInitializeResultSchema = z.discriminatedUnion("role", [
  rpcClientInitializeResultSchema,
  rpcPortalInitializeResultSchema,
]);
export type RpcInitializeResult = z.infer<typeof rpcInitializeResultSchema>;

export const binaryChunkParamsSchema = z.object({
  transferId: idSchema,
  index: z.number().int().nonnegative(),
  data: z.string(),
}).strict();
const binaryChunkRequestParamsSchema = z.union([
  binaryChunkParamsSchema,
  z.object({ transferId: idSchema, index: z.number().int().nonnegative() })
    .strict(),
]);
const binaryChunkResultSchema = z.union([
  z.object({ transferId: idSchema, throughIndex: z.number().int().min(-1) })
    .strict(),
  z.object({
    transferId: idSchema,
    index: z.number().int().nonnegative(),
    data: z.string(),
  }).strict(),
]);
const binaryBeginResultSchema = z.object({
  transferId: idSchema,
  accepted: z.literal(true),
}).strict();
const binaryCompleteResultSchema = z.union([
  okResultSchema,
  z.object({
    transferId: idSchema,
    sizeBytes: z.number().int().nonnegative(),
    sha256: z.string(),
  }).strict(),
]);
export const binaryCompleteParamsSchema = z.object({
  transferId: idSchema,
  chunks: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i),
}).strict();
export const binaryAbortParamsSchema = z.object({
  transferId: idSchema,
  reason: z.string().optional(),
}).strict();
export const binaryAckParamsSchema = z.object({
  transferId: idSchema,
  throughIndex: z.number().int().min(-1),
}).strict();
export type BinaryChunkParams = z.infer<typeof binaryChunkParamsSchema>;
export type BinaryAckParams = z.infer<typeof binaryAckParamsSchema>;
export type BinaryCompleteParams = z.infer<typeof binaryCompleteParamsSchema>;
export type BinaryAbortParams = z.infer<typeof binaryAbortParamsSchema>;

const modelConfigSchema = z.object({
  defaultModel: idSchema,
  options: z.array(
    z.object({
      id: idSchema,
      label: z.string(),
      providerId: z.string().optional(),
      providerName: z.string().optional(),
      providerLogoUrl: z.string().optional(),
      contextWindow: z.number().int().positive().optional(),
      supportedReasoningEfforts: z.array(
        z.object({
          effort: idSchema,
          label: z.string(),
          description: z.string().optional(),
        }).strict(),
      ).optional(),
      defaultReasoningEffort: z.string().optional(),
      serviceTiers: z.array(
        z.object({
          id: idSchema,
          name: z.string(),
          description: z.string().optional(),
        }).strict(),
      ).optional(),
      defaultServiceTier: z.string().nullable().optional(),
    }).strict(),
  ),
}).strict();

const promptContextSchema = {
  threadId: idSchema.nullish(),
  projectId: idSchema.nullish(),
  workspaceId: idSchema.nullish(),
};
const promptSummarySchema = z.object({
  name: idSchema,
  command: z.string(),
  description: z.string(),
  argumentHint: z.string().optional(),
  tags: stringArraySchema,
  source: z.enum(["app", "user", "project"]),
  path: z.string().optional(),
}).strict();

const chatThreadResultSchema = z.object({ thread: chatThreadSchema }).strict();
const threadIdParamsSchema = z.object({ threadId: idSchema }).strict();
const contextUsageSchema = z.object({
  modelId: idSchema,
  tokens: z.number().nonnegative(),
  contextWindow: z.number().positive(),
  contextLimitPercent: z.number().nonnegative(),
  contextLimitTokens: z.number().nonnegative(),
  percent: z.number().nonnegative(),
  compactionEnabled: z.boolean(),
  source: z.enum(["provider", "estimate"]).optional(),
  updatedAt: z.string(),
  totalProcessedTokens: z.number().nonnegative().optional(),
  inputTokens: z.number().nonnegative().optional(),
  cachedInputTokens: z.number().nonnegative().optional(),
  outputTokens: z.number().nonnegative().optional(),
  compaction: z.object({
    generation: z.number().int().positive(),
    state: z.enum(["running", "completed", "failed", "cancelled"]),
    at: z.string(),
    projectedTokens: z.number().nonnegative().optional(),
  }).strict().optional(),
}).strict();
const persistedRunSchema = z.object({
  version: z.literal(1),
  runId: idSchema,
  resourceId: idSchema,
  threadId: idSchema,
  mastraRunId: idSchema,
  status: z.enum([
    "running",
    "awaiting_approval",
    "completed",
    "failed",
    "cancelled",
    "interrupted",
  ]),
  executionProfile: z.enum(["observe", "workspace", "host"]),
  model: z.string().optional(),
  metadata: jsonObjectSchema,
  safeCheckpoint: z.object({
    version: z.literal(1),
    boundary: z.enum(["model", "tool_result", "approval"]),
    sequence: sequenceSchema,
    toolCallId: z.string().optional(),
    resumable: z.boolean(),
    recordedAt: z.string(),
  }).strict().optional(),
  lastSequence: sequenceSchema,
  updatedAt: z.string(),
  startedAt: z.string(),
  completedAt: z.string().optional(),
  createdAt: z.string(),
  error: z.string().optional(),
}).strict();

const chatRunStartParamsSchema = z.object({
  id: idSchema.optional(),
  requestId: idSchema.optional(),
  messages: z.array(weaveChatMessageSchema),
  trigger: z.enum(["submit-message", "regenerate-message"]).optional(),
  messageId: idSchema.optional(),
  model: idSchema.optional(),
  reasoningEffort: z.string().optional(),
  serviceTier: z.string().nullable().optional(),
  executionProfile: z.enum(["observe", "workspace", "host"]).optional(),
  memory: z.object({ thread: idSchema, resource: idSchema.optional() })
    .strict(),
  runId: idSchema.optional(),
  toolCallId: idSchema.optional(),
  resumeData: jsonValueSchema.optional(),
}).strict();

const chatRunEventSchema = z.object({
  subscriptionId: idSchema,
  threadId: idSchema,
  runId: idSchema.optional(),
  sequence: sequenceSchema,
  event: weaveChatChunkSchema.optional(),
  done: z.literal(true).optional(),
  error: z.string().optional(),
}).strict().refine(
  (value) =>
    value.event !== undefined || value.done === true ||
    value.error !== undefined,
  {
    message: "A chat run event must carry an event, completion, or error.",
  },
);

const projectIdSchema = z.object({ projectId: idSchema }).strict();
const workspaceIdsSchema = z.object({
  projectId: idSchema,
  workspaceId: idSchema,
}).strict();
const productSchema = z.enum(["all", "chat", "code", "notes"]).optional();
const projectsResultSchema = z.object({ projects: z.array(projectSchema) })
  .strict();
const projectResultSchema = z.object({ project: projectSchema }).strict();
const projectWorkspaceResultSchema = z.object({
  project: projectSchema,
  workspace: workspaceSchema,
}).strict();

const browseEntrySchema = z.object({
  name: z.string(),
  type: z.enum(["directory", "file", "other"]),
  hidden: z.boolean().optional(),
}).strict();
const portalBrowseResultSchema = z.object({
  ok: z.boolean().optional(),
  rootId: idSchema,
  path: z.string(),
  realPath: z.string().optional(),
  entries: z.array(browseEntrySchema),
  isGitRepo: z.boolean().optional(),
  git: jsonObjectSchema.optional(),
  error: z.string().optional(),
}).strict();

const workspaceFileIndexResultSchema = z.object({
  path: z.string(),
  entries: workspaceFileListResultSchema.shape.entries,
  notes: z.array(
    z.object({
      path: z.string(),
      documentType: z.enum(["markdown", "coppermind"]).optional(),
      title: z.string(),
      headings: stringArraySchema,
      tags: stringArraySchema,
      links: stringArraySchema,
      embeds: stringArraySchema,
      properties: z.record(z.string(), z.string()),
      mtimeMs: z.number().optional(),
      size: z.number().optional(),
      preview: z.string().optional(),
    }).strict(),
  ),
  attachments: z.array(
    z.object({
      path: z.string(),
      name: z.string(),
      mediaType: z.enum([
        "image",
        "audio",
        "video",
        "pdf",
        "excalidraw",
        "other",
      ]),
      size: z.number().optional(),
      mtimeMs: z.number().optional(),
    }).strict(),
  ),
  backlinks: z.record(z.string(), stringArraySchema),
  checkedAt: z.string(),
}).strict();

const artifactSummarySchema = z.object({
  kind: z.string(),
  name: idSchema,
  objectKey: z.string(),
  objectPrefix: z.string(),
  contentHash: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  metadata: jsonObjectSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict();
const skillFileSchema = z.object({
  path: z.string(),
  objectKey: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  updatedAt: z.string(),
  content: z.string().optional(),
}).strict();
const chatGptAuthStatusSchema = z.object({
  connected: z.boolean(),
  accountId: z.string().optional(),
  expires: z.number().optional(),
}).strict();
const chatGptLoginStartSchema = z.object({
  url: z.string().url(),
  state: nonEmptyStringSchema,
  expiresAt: z.number().finite(),
}).strict();
const chatGptLoginCompleteSchema = z.object({
  connected: z.literal(true),
  accountId: z.string().optional(),
  expires: z.number().optional(),
}).strict();
const agentContributionItemSchema = z.object({
  id: nonEmptyStringSchema,
  description: z.string().optional(),
}).strict();
const agentContributionSchema = z.object({
  moduleId: nonEmptyStringSchema,
  tools: z.array(agentContributionItemSchema).optional(),
  prompts: z.array(agentContributionItemSchema).optional(),
  sources: z.array(agentContributionItemSchema).optional(),
  runtimeContextProviders: z.array(agentContributionItemSchema).optional(),
  memoryPolicyHints: z.array(agentContributionItemSchema).optional(),
}).strict();

const terminalRpcParamsSchema = terminalTargetSchema.extend({
  kind: terminalSessionKindSchema,
  sessionId: idSchema,
  requestId: idSchema.optional(),
}).strict();
const lspCreateParamsSchema = z.object({
  target: workspaceFileTargetSchema,
  path: z.string(),
  serverId: z.string().optional(),
  languageId: z.string().optional(),
}).strict();
const jupyterSessionParamsSchema = z.object({
  target: workspaceFileTargetSchema,
  path: z.string(),
  kernelName: z.string().optional(),
  language: z.string().optional(),
}).strict();

const clientServerRequests = [
  request(
    "initialize",
    "client",
    "server",
    rpcClientInitializeParamsSchema,
    rpcClientInitializeResultSchema,
  ),
  request(
    "binary.begin",
    "client",
    "server",
    binaryTransferDescriptorSchema,
    binaryBeginResultSchema,
  ),
  request(
    "binary.chunk",
    "client",
    "server",
    binaryChunkRequestParamsSchema,
    binaryChunkResultSchema,
  ),
  request(
    "binary.ack",
    "client",
    "server",
    binaryAckParamsSchema,
    okResultSchema,
  ),
  request(
    "binary.complete",
    "client",
    "server",
    binaryCompleteParamsSchema,
    binaryCompleteResultSchema,
  ),
  request(
    "binary.abort",
    "client",
    "server",
    binaryAbortParamsSchema,
    okResultSchema,
  ),
  request(
    "owner.get",
    "client",
    "server",
    z.undefined(),
    z.object({ owner: ownerSchema }).strict(),
  ),
  request(
    "agent.models.list",
    "client",
    "server",
    z.undefined(),
    modelConfigSchema,
  ),
  request(
    "agent.prompts.list",
    "client",
    "server",
    z.object(promptContextSchema).strict().optional(),
    z.object({ prompts: z.array(promptSummarySchema) }).strict(),
  ),
  request(
    "agent.prompts.expand",
    "client",
    "server",
    z.object({ name: idSchema, arguments: z.string(), ...promptContextSchema })
      .strict(),
    z.object({ name: idSchema, text: z.string() }).strict(),
  ),
  request(
    "agent.tools.list",
    "client",
    "server",
    z.undefined(),
    z.object({ contributions: z.array(agentContributionSchema) }).strict(),
  ),
  request(
    "agent.chatgpt.authStatus",
    "client",
    "server",
    z.undefined(),
    chatGptAuthStatusSchema,
  ),
  request(
    "agent.chatgpt.login.start",
    "client",
    "server",
    z.undefined(),
    chatGptLoginStartSchema,
  ),
  request(
    "agent.chatgpt.login.complete",
    "client",
    "server",
    z.object({ code: idSchema, state: idSchema }).strict(),
    chatGptLoginCompleteSchema,
  ),
  request(
    "chat.thread.list",
    "client",
    "server",
    z.undefined(),
    z.object({ threads: z.array(chatThreadSchema) }).strict(),
  ),
  request(
    "chat.thread.get",
    "client",
    "server",
    threadIdParamsSchema,
    chatThreadResultSchema,
  ),
  request(
    "chat.thread.create",
    "client",
    "server",
    z.object({
      threadId: optionalIdSchema,
      title: z.string().optional(),
      projectId: optionalIdSchema,
      workspaceId: optionalIdSchema,
    }).strict(),
    chatThreadResultSchema,
  ),
  request(
    "chat.thread.update",
    "client",
    "server",
    z.object({
      threadId: idSchema,
      title: z.string().optional(),
      archived: z.boolean().optional(),
    }).strict(),
    chatThreadResultSchema,
  ),
  request(
    "chat.thread.delete",
    "client",
    "server",
    threadIdParamsSchema,
    okResultSchema,
  ),
  request(
    "chat.thread.reorder",
    "client",
    "server",
    z.object({
      scope: z.object({
        plain: z.literal(true).optional(),
        projectId: optionalIdSchema,
        workspaceId: optionalIdSchema,
      }).strict(),
      threadIds: z.array(idSchema),
    }).strict(),
    okResultSchema,
  ),
  request(
    "chat.thread.messages.list",
    "client",
    "server",
    threadIdParamsSchema,
    z.object({ messages: z.array(weaveChatMessageSchema) }).strict(),
  ),
  request(
    "chat.thread.contextUsage",
    "client",
    "server",
    z.object({ threadId: idSchema, model: idSchema }).strict(),
    contextUsageSchema,
  ),
  request(
    "chat.thread.compact",
    "client",
    "server",
    z.object({
      threadId: idSchema,
      model: idSchema,
      instructions: z.string().optional(),
    }).strict(),
    z.object({ status: z.enum(["completed", "not_needed"]) }).strict(),
  ),
  request(
    "chat.run.start",
    "client",
    "server",
    chatRunStartParamsSchema,
    z.object({ run: threadRunStateSchema }).strict(),
  ),
  request(
    "chat.run.get",
    "client",
    "server",
    z.object({ threadId: idSchema, runId: optionalIdSchema }).strict(),
    z.object({
      run: threadRunStateSchema,
      persisted: persistedRunSchema.optional(),
    }).strict(),
  ),
  request(
    "chat.run.subscribe",
    "client",
    "server",
    z.object({
      threadId: idSchema,
      runId: optionalIdSchema,
      afterSequence: sequenceSchema,
    }).strict(),
    z.object({
      subscriptionId: idSchema.nullable(),
      active: z.boolean(),
      afterSequence: sequenceSchema,
    }).strict(),
  ),
  request(
    "chat.run.unsubscribe",
    "client",
    "server",
    z.object({ subscriptionId: idSchema }).strict(),
    okResultSchema,
  ),
  request(
    "chat.run.approval.respond",
    "client",
    "server",
    z.object({
      threadId: idSchema,
      runId: idSchema,
      toolCallId: idSchema,
      decision: z.enum(["approve", "deny"]),
      rememberForRun: z.boolean().optional(),
    }).strict(),
    z.object({ run: threadRunStateSchema }).strict(),
  ),
  request(
    "chat.run.cancel",
    "client",
    "server",
    threadIdParamsSchema,
    z.object({ ok: z.literal(true), run: threadRunStateSchema }).strict(),
  ),
  request(
    "chat.run.steer",
    "client",
    "server",
    z.object({
      threadId: idSchema,
      runId: optionalIdSchema,
      message: weaveChatMessageSchema.optional(),
      messages: z.array(weaveChatMessageSchema).optional(),
    }).strict(),
    z.object({
      ok: z.literal(true),
      accepted: z.literal(true),
      runId: idSchema,
      messageId: idSchema,
    }).strict(),
  ),
  request(
    "notification.subscribe",
    "client",
    "server",
    z.object({ afterSequence: sequenceSchema }).strict(),
    z.object({ subscriptionId: idSchema, afterSequence: sequenceSchema })
      .strict(),
  ),
  request(
    "notification.unsubscribe",
    "client",
    "server",
    z.object({ subscriptionId: idSchema }).strict(),
    okResultSchema,
  ),
  request(
    "notification.test",
    "client",
    "server",
    z.object({ title: idSchema, body: z.string().optional() }).strict(),
    z.object({
      ok: z.literal(true),
      sequence: sequenceSchema,
      event: weaveNotificationEventSchema,
    }).strict(),
  ),
  request(
    "code.project.list",
    "client",
    "server",
    z.object({ product: productSchema }).strict().optional(),
    projectsResultSchema,
  ),
  request(
    "code.project.create",
    "client",
    "server",
    z.object({
      name: idSchema,
      projectKind: z.enum(["general", "git", "notes"]).optional(),
      portalId: optionalIdSchema,
      rootId: optionalIdSchema,
      repoPath: z.string().optional(),
      vaultPath: z.string().optional(),
      notesStorage: jsonObjectSchema.optional(),
      product: productSchema,
    }).strict(),
    projectResultSchema,
  ),
  request(
    "code.project.get",
    "client",
    "server",
    z.object({ projectId: idSchema, product: productSchema }).strict(),
    projectResultSchema,
  ),
  request(
    "code.project.delete",
    "client",
    "server",
    z.object({ projectId: idSchema, product: productSchema }).strict(),
    okResultSchema,
  ),
  request(
    "code.project.reorder",
    "client",
    "server",
    z.object({ projectIds: z.array(idSchema), product: productSchema })
      .strict(),
    projectsResultSchema,
  ),
  request(
    "code.project.branches.list",
    "client",
    "server",
    projectIdSchema,
    z.object({ branches: z.array(branchOptionSchema) }).strict(),
  ),
  request(
    "code.project.threads.create",
    "client",
    "server",
    z.object({
      projectId: idSchema,
      threadId: idSchema,
      title: z.string().optional(),
      workspaceId: optionalIdSchema,
      product: productSchema,
    }).strict(),
    z.object({ thread: chatThreadSchema, workspace: workspaceSchema }).strict(),
  ),
  request(
    "code.project.threads.list",
    "client",
    "server",
    projectIdSchema,
    z.object({ threads: z.array(chatThreadSchema) }).strict(),
  ),
  request(
    "code.workspace.gitState.list",
    "client",
    "server",
    z.undefined(),
    z.object({ states: z.array(workspaceGitStateSchema) }).strict(),
  ),
  request(
    "code.workspace.resolve",
    "client",
    "server",
    workspaceIdsSchema,
    projectWorkspaceResultSchema,
  ),
  request(
    "code.workspace.discover",
    "client",
    "server",
    projectIdSchema,
    z.object({ worktrees: z.array(discoveredWorktreeSchema) }).strict(),
  ),
  request(
    "code.workspace.create",
    "client",
    "server",
    z.object({
      projectId: idSchema,
      name: idSchema,
      mode: z.enum(["newBranch", "existingBranch", "detached"]).optional(),
      branch: z.string().optional(),
      base: z.string().optional(),
      path: z.string().optional(),
    }).strict(),
    projectWorkspaceResultSchema,
  ),
  request(
    "code.workspace.adopt",
    "client",
    "server",
    z.object({
      projectId: idSchema,
      path: z.string(),
      name: z.string().optional(),
    }).strict(),
    projectWorkspaceResultSchema,
  ),
  request(
    "code.workspace.update",
    "client",
    "server",
    z.object({
      projectId: idSchema,
      workspaceId: idSchema,
      name: z.string().optional(),
      branch: z.string().optional(),
      createBranch: z.boolean().optional(),
      base: z.string().optional(),
    }).strict(),
    projectWorkspaceResultSchema,
  ),
  request(
    "code.workspace.delete",
    "client",
    "server",
    z.object({
      projectId: idSchema,
      workspaceId: idSchema,
      mode: z.enum(["detach", "remove"]),
      force: z.boolean().optional(),
      deleteLocalBranch: z.boolean().optional(),
    }).strict(),
    deleteWorkspaceResultSchema,
  ),
  request(
    "code.workspace.reorder",
    "client",
    "server",
    z.object({ projectId: idSchema, workspaceIds: z.array(idSchema) }).strict(),
    projectResultSchema,
  ),
  request(
    "code.workspace.git.fetch",
    "client",
    "server",
    workspaceIdsSchema,
    z.object({ state: workspaceGitStateSchema }).strict(),
  ),
  request(
    "code.workspace.git.pull",
    "client",
    "server",
    workspaceIdsSchema,
    z.object({ state: workspaceGitStateSchema }).strict(),
  ),
  request(
    "code.workspace.removalPreview",
    "client",
    "server",
    workspaceIdsSchema,
    workspaceRemovalPreviewSchema,
  ),
  request(
    "workspaceFile.list",
    "client",
    "server",
    targetParams({ path: z.string().default("") }),
    workspaceFileListResultSchema,
  ),
  request(
    "workspaceFile.read",
    "client",
    "server",
    targetParams({ path: z.string() }),
    workspaceFileReadResultSchema,
  ),
  request(
    "workspaceFile.hash",
    "client",
    "server",
    targetParams({ path: z.string() }),
    workspaceFileHashResultSchema,
  ),
  request(
    "workspaceFile.diffPreview",
    "client",
    "server",
    targetParams({ path: z.string(), diff: z.string() }),
    workspaceFileDiffPreviewResultSchema,
  ),
  request(
    "workspaceFile.write",
    "client",
    "server",
    targetParams({
      path: z.string(),
      content: z.string().optional(),
      transferId: optionalIdSchema,
      version: z.string().optional(),
    }),
    workspaceFileWriteResultSchema,
  ),
  request(
    "workspaceFile.mkdir",
    "client",
    "server",
    targetParams({ path: z.string() }),
    fileOperationResultSchema,
  ),
  request(
    "workspaceFile.move",
    "client",
    "server",
    targetParams({
      fromPath: z.string(),
      toPath: z.string(),
      overwrite: z.boolean().optional(),
    }),
    fileOperationResultSchema,
  ),
  request(
    "workspaceFile.delete",
    "client",
    "server",
    targetParams({ path: z.string(), recursive: z.boolean().optional() }),
    fileOperationResultSchema,
  ),
  request(
    "workspaceFile.index",
    "client",
    "server",
    targetParams({ path: z.string().default("") }),
    workspaceFileIndexResultSchema,
  ),
  request(
    "workspaceFile.upload",
    "client",
    "server",
    targetParams({
      path: z.string(),
      transferId: idSchema,
      contentType: z.string().optional(),
    }),
    fileOperationResultSchema,
  ),
  request(
    "workspaceFile.watch.start",
    "client",
    "server",
    targetParams({
      sessionId: idSchema,
      requestId: idSchema,
      paths: stringArraySchema,
    }),
    okResultSchema,
  ),
  request(
    "workspaceFile.watch.update",
    "client",
    "server",
    targetParams({
      sessionId: idSchema,
      requestId: idSchema,
      paths: stringArraySchema,
    }),
    okResultSchema,
  ),
  request(
    "workspaceFile.watch.stop",
    "client",
    "server",
    targetParams({ sessionId: idSchema, requestId: idSchema.optional() }),
    okResultSchema,
  ),
  request(
    "terminal.list",
    "client",
    "server",
    terminalRpcParamsSchema,
    okResultSchema,
  ),
  request(
    "terminal.snapshot",
    "client",
    "server",
    terminalRpcParamsSchema,
    okResultSchema,
  ),
  request(
    "terminal.create",
    "client",
    "server",
    terminalRpcParamsSchema,
    okResultSchema,
  ),
  request(
    "terminal.attach",
    "client",
    "server",
    terminalRpcParamsSchema,
    okResultSchema,
  ),
  request(
    "terminal.input",
    "client",
    "server",
    terminalRpcParamsSchema.extend({ data: z.string() }).strict(),
    okResultSchema,
  ),
  request(
    "terminal.resize",
    "client",
    "server",
    terminalRpcParamsSchema.extend({
      cols: z.number().int().positive(),
      rows: z.number().int().positive(),
    }).strict(),
    okResultSchema,
  ),
  request(
    "terminal.close",
    "client",
    "server",
    terminalRpcParamsSchema,
    okResultSchema,
  ),
  request(
    "terminal.detach",
    "client",
    "server",
    terminalRpcParamsSchema,
    okResultSchema,
  ),
  request(
    "lsp.session.create",
    "client",
    "server",
    lspCreateParamsSchema,
    lspSessionResultSchema,
  ),
  request(
    "lsp.session.start",
    "client",
    "server",
    lspCreateParamsSchema.extend({ sessionId: idSchema }).strict(),
    okResultSchema,
  ),
  request(
    "lsp.session.send",
    "client",
    "server",
    lspCreateParamsSchema.extend({ sessionId: idSchema, message: z.string() })
      .strict(),
    okResultSchema,
  ),
  request(
    "lsp.session.close",
    "client",
    "server",
    lspCreateParamsSchema.extend({ sessionId: idSchema }).strict(),
    okResultSchema,
  ),
  request(
    "jupyter.status",
    "client",
    "server",
    z.object({ target: portalTargetSchema }).strict(),
    jupyterStatusResultSchema,
  ),
  request(
    "jupyter.kernelspecs",
    "client",
    "server",
    z.object({ target: portalTargetSchema }).strict(),
    jupyterKernelspecsResultSchema,
  ),
  request(
    "jupyter.session.create",
    "client",
    "server",
    jupyterSessionParamsSchema,
    jupyterSessionResultSchema,
  ),
  request(
    "jupyter.session.execute",
    "client",
    "server",
    jupyterSessionParamsSchema.extend({
      sessionId: idSchema,
      code: z.string(),
      requestId: idSchema.optional(),
      cellId: idSchema.optional(),
      allowStdin: z.boolean().optional(),
      silent: z.boolean().optional(),
      storeHistory: z.boolean().optional(),
    }).strict(),
    okResultSchema,
  ),
  request(
    "jupyter.session.close",
    "client",
    "server",
    jupyterSessionParamsSchema.extend({ sessionId: idSchema }).strict(),
    okResultSchema,
  ),
  request(
    "workflow.definition.list",
    "client",
    "server",
    z.undefined(),
    z.object({ workflows: z.array(storedWorkflowDefinitionSchema) }).strict(),
  ),
  request(
    "workflow.definition.create",
    "client",
    "server",
    z.object({ definition: workflowDefinitionSchema }).strict(),
    z.object({ workflow: storedWorkflowDefinitionSchema }).strict(),
  ),
  request(
    "workflow.definition.get",
    "client",
    "server",
    z.object({ workflowId: idSchema }).strict(),
    z.object({ workflow: storedWorkflowDefinitionSchema }).strict(),
  ),
  request(
    "workflow.definition.update",
    "client",
    "server",
    z.object({ workflowId: idSchema, definition: workflowDefinitionSchema })
      .strict(),
    z.object({ workflow: storedWorkflowDefinitionSchema }).strict(),
  ),
  request(
    "workflow.definition.delete",
    "client",
    "server",
    z.object({ workflowId: idSchema }).strict(),
    okResultSchema,
  ),
  request(
    "workflow.run.start",
    "client",
    "server",
    z.object({
      workflowId: idSchema,
      input: jsonValueSchema.optional(),
      requestId: optionalIdSchema,
      runId: optionalIdSchema,
    }).strict(),
    z.object({ run: workflowRunSchema }).strict(),
  ),
  request(
    "workflow.run.list",
    "client",
    "server",
    z.object({
      workflowId: optionalIdSchema,
      limit: z.number().int().positive().optional(),
    }).strict().optional(),
    z.object({ runs: z.array(workflowRunSchema) }).strict(),
  ),
  request(
    "workflow.run.get",
    "client",
    "server",
    z.object({ runId: idSchema }).strict(),
    z.object({ run: workflowRunSchema }).strict(),
  ),
  request(
    "workflow.run.cancel",
    "client",
    "server",
    z.object({ runId: idSchema }).strict(),
    z.object({ run: workflowRunSchema }).strict(),
  ),
  request(
    "workflow.run.subscribe",
    "client",
    "server",
    z.object({ runId: idSchema, afterSequence: sequenceSchema }).strict(),
    z.object({
      subscriptionId: idSchema,
      runId: idSchema,
      afterSequence: sequenceSchema,
    }).strict(),
  ),
  request(
    "workflow.run.unsubscribe",
    "client",
    "server",
    z.object({ subscriptionId: idSchema }).strict(),
    okResultSchema,
  ),
  request(
    "attachment.put",
    "client",
    "server",
    z.object({
      transferId: idSchema,
      mimeType: z.string(),
      originalName: z.string(),
      threadId: optionalIdSchema,
    }).strict(),
    z.object({
      id: idSchema,
      urlPath: z.string(),
      mimeType: z.string(),
      sizeBytes: z.number().int().nonnegative(),
      originalName: z.string(),
    }).strict(),
  ),
  request(
    "attachment.read",
    "client",
    "server",
    z.object({ attachmentId: idSchema }).strict(),
    z.object({
      transfer: binaryTransferDescriptorSchema,
      attachment: z.object({
        id: idSchema,
        mimeType: z.string(),
        sizeBytes: z.number().int().nonnegative(),
        originalName: z.string(),
      }).strict(),
    }).strict(),
  ),
  request(
    "userArtifact.prompt.list",
    "client",
    "server",
    z.undefined(),
    z.object({ prompts: z.array(artifactSummarySchema) }).strict(),
  ),
  request(
    "userArtifact.prompt.get",
    "client",
    "server",
    z.object({ name: idSchema }).strict(),
    z.object({
      prompt: artifactSummarySchema.extend({ content: z.string() }).strict(),
    }).strict(),
  ),
  request(
    "userArtifact.prompt.put",
    "client",
    "server",
    z.object({ name: idSchema, content: z.string() }).strict(),
    z.object({ prompt: artifactSummarySchema }).strict(),
  ),
  request(
    "userArtifact.prompt.delete",
    "client",
    "server",
    z.object({ name: idSchema }).strict(),
    okResultSchema,
  ),
  request(
    "userArtifact.skill.list",
    "client",
    "server",
    z.undefined(),
    z.object({ skills: z.array(artifactSummarySchema) }).strict(),
  ),
  request(
    "userArtifact.skill.get",
    "client",
    "server",
    z.object({ name: idSchema }).strict(),
    z.object({
      skill: artifactSummarySchema.extend({
        files: z.array(skillFileSchema),
        entrypoint: z.string().optional(),
      }).strict(),
    }).strict(),
  ),
  request(
    "userArtifact.skill.put",
    "client",
    "server",
    z.object({ name: idSchema, content: z.string() }).strict(),
    z.object({ skill: artifactSummarySchema }).strict(),
  ),
  request(
    "userArtifact.skill.delete",
    "client",
    "server",
    z.object({ name: idSchema }).strict(),
    okResultSchema,
  ),
  request(
    "userArtifact.skill.files.list",
    "client",
    "server",
    z.object({ name: idSchema }).strict(),
    z.object({ files: z.array(skillFileSchema) }).strict(),
  ),
  request(
    "userArtifact.skill.file.get",
    "client",
    "server",
    z.object({ name: idSchema, path: z.string() }).strict(),
    z.object({ file: skillFileSchema }).strict(),
  ),
  request(
    "userArtifact.skill.file.put",
    "client",
    "server",
    z.object({ name: idSchema, path: z.string(), content: z.string() })
      .strict(),
    z.object({ skill: artifactSummarySchema }).strict(),
  ),
  request(
    "userArtifact.skill.file.delete",
    "client",
    "server",
    z.object({ name: idSchema, path: z.string() }).strict(),
    okResultSchema,
  ),
  request(
    "portal.list",
    "client",
    "server",
    z.undefined(),
    z.object({ portals: z.array(portalConnectionSchema) }).strict(),
  ),
  request(
    "portal.browse",
    "client",
    "server",
    z.object({ portalId: idSchema, rootId: idSchema, path: z.string() })
      .strict(),
    portalBrowseResultSchema,
  ),
  request(
    "portal.primary.set",
    "client",
    "server",
    z.object({ portalId: idSchema }).strict(),
    z.object({
      ok: z.literal(true),
      primaryPortalId: idSchema,
      portals: z.array(portalConnectionSchema),
    }).strict(),
  ),
  request(
    "portal.token.issue",
    "client",
    "server",
    z.object({ portalId: idSchema.optional(), name: z.string().optional() })
      .strict().optional(),
    z.object({ portalId: idSchema, token: idSchema }).strict(),
  ),
  request(
    "portal.shutdown",
    "client",
    "server",
    z.object({ portalId: idSchema }).strict(),
    okResultSchema,
  ),
  request(
    "client.surface.update",
    "client",
    "server",
    clientSurfaceUpdateParamsSchema,
    clientToolConnectionSchema.nullable(),
  ),
] as const;

const serverClientRequests = [
  request(
    "client.editorContext.get",
    "server",
    "client",
    liveEditorContextRequestSchema.optional(),
    liveEditorContextResultSchema,
  ),
] as const;

const serverClientNotifications = [
  notification(
    "connection.ping",
    "server",
    "client",
    z.object({ nonce: z.string().optional(), at: z.string().optional() })
      .strict(),
  ),
  notification("chat.run.event", "server", "client", chatRunEventSchema),
  notification(
    "notification.event",
    "server",
    "client",
    z.object({
      subscriptionId: idSchema,
      sequence: sequenceSchema,
      event: weaveNotificationEventSchema,
    }).strict(),
  ),
  notification(
    "workflow.run.event",
    "server",
    "client",
    z.object({
      subscriptionId: idSchema,
      runId: idSchema,
      sequence: sequenceSchema,
      event: workflowRunEventSchema,
    }).strict(),
  ),
  notification(
    "workspaceFile.watch.event",
    "server",
    "client",
    z.object({ sessionId: idSchema, event: workspaceFileWatchHostEventSchema })
      .strict(),
  ),
  notification(
    "terminal.event",
    "server",
    "client",
    z.object({ sessionId: idSchema, event: terminalHostEventSchema }).strict(),
  ),
  notification(
    "lsp.event",
    "server",
    "client",
    z.object({ sessionId: idSchema, event: lspHostEventSchema }).strict(),
  ),
  notification(
    "jupyter.event",
    "server",
    "client",
    z.object({ sessionId: idSchema, event: jupyterHostEventSchema }).strict(),
  ),
  notification(
    "portal.status.changed",
    "server",
    "client",
    portalConnectionSchema,
  ),
] as const;

const clientServerNotifications = [
  notification(
    "connection.pong",
    "client",
    "server",
    z.object({ nonce: z.string().optional(), at: z.string() }).strict(),
  ),
  notification(
    "connection.cancel",
    "client",
    "server",
    z.object({ id: z.union([z.string(), z.number()]) }).strict(),
  ),
] as const;

const validationKindSchema = z.enum([
  "test",
  "typecheck",
  "lint",
  "build",
  "other",
]);
const optionalPathArgsSchema = z.object({ path: z.string().optional() })
  .strict();
const requiredPathArgsSchema = z.object({ path: z.string() }).strict();
const lspSessionArgsSchema = z.object({
  path: z.string(),
  languageId: z.string().optional(),
  serverId: z.string().optional(),
}).strict();
const lspPositionSchema = z.object({
  line: z.number().int().nonnegative(),
  character: z.number().int().nonnegative(),
}).strict();
const portalToolFailureSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
  code: z.string().optional(),
}).strict();
const portalToolResultSchema = <Schema extends z.ZodType>(schema: Schema) =>
  z.union([schema, portalToolFailureSchema]);

const commandOutputEventSchema = z.object({
  offset: z.number().int().nonnegative(),
  stream: z.enum(["stdout", "stderr", "system"]),
  text: z.string(),
  at: z.string(),
}).strict();
const commandOmittedRangeSchema = z.object({
  startOffset: z.number().int().nonnegative(),
  endOffset: z.number().int().nonnegative(),
}).strict();
const commandSessionSnapshotSchema = z.object({
  id: idSchema,
  command: z.string(),
  cwd: z.string(),
  profile: z.enum(["observe", "workspace", "host"]),
  status: z.enum([
    "running",
    "completed",
    "failed",
    "timed_out",
    "cancelled",
  ]),
  startedAt: z.string(),
  updatedAt: z.string(),
  finishedAt: z.string().optional(),
  exitCode: z.number().int().optional(),
  timedOut: z.boolean(),
  sandboxed: z.boolean(),
  network: z.enum(["denied", "host"]),
  nextOffset: z.number().int().nonnegative(),
  baseOffset: z.number().int().nonnegative(),
  outputChars: z.number().int().nonnegative(),
  outputBytes: z.number().int().nonnegative(),
  outputLines: z.number().int().nonnegative(),
  artifactHandle: z.string(),
  omittedRanges: z.array(commandOmittedRangeSchema),
  hasMore: z.boolean(),
  pty: z.boolean(),
  validation: validationKindSchema.optional(),
  events: z.array(commandOutputEventSchema),
}).strict();
const commandSessionToolResultSchema = portalToolResultSchema(
  commandSessionSnapshotSchema.extend({ ok: z.literal(true) }).strict(),
);
const bashToolResultSchema = portalToolResultSchema(
  z.object({
    ok: z.boolean(),
    stdout: z.string(),
    stderr: z.string(),
    exitCode: z.number().int().optional(),
    timedOut: z.boolean(),
    sandboxed: z.boolean(),
    network: z.enum(["denied", "host"]),
    artifactHandle: z.string(),
    omittedRanges: z.array(commandOmittedRangeSchema),
    nextOffset: z.number().int().nonnegative(),
    outputChars: z.number().int().nonnegative(),
    outputBytes: z.number().int().nonnegative(),
    outputLines: z.number().int().nonnegative(),
    validation: validationKindSchema.optional(),
    error: z.string().optional(),
  }).strict(),
);

const gitStatusEntrySchema = z.object({
  path: z.string(),
  originalPath: z.string().optional(),
  xy: z.string(),
  staged: z.string(),
  unstaged: z.string(),
  kind: z.enum(["ordinary", "renamed", "unmerged", "untracked", "ignored"]),
}).strict();
const gitStatusFields = {
  branch: z.string().optional(),
  head: z.string().optional(),
  upstream: z.string().optional(),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  entries: z.array(gitStatusEntrySchema),
  clean: z.boolean(),
};
const gitStatusToolResultSchema = portalToolResultSchema(
  z.object({ ok: z.literal(true), ...gitStatusFields }).strict(),
);
const gitWorktreeInfoSchema = z.object({
  path: z.string().optional(),
  branch: z.string().optional(),
  commit: z.string().optional(),
  head: z.string().optional(),
  upstream: z.string().optional(),
  ahead: z.number().int().nonnegative().optional(),
  behind: z.number().int().nonnegative().optional(),
  detached: z.boolean().optional(),
  isCurrent: z.boolean().optional(),
}).strict();
const gitAgentInstructionsFileSchema = z.object({
  path: z.string(),
  content: z.string(),
  size: z.number().int().nonnegative(),
  updatedAt: z.string().optional(),
}).strict();
const gitInspectSchema = z.object({
  root: z.string(),
  currentBranch: z.string(),
  defaultBranch: z.string(),
  remote: z.string().optional(),
  agentsMd: gitAgentInstructionsFileSchema.optional(),
}).strict();
const weaveContextFileSchema = z.object({
  kind: z.enum(["config", "mcp", "prompt", "skill", "agents"]),
  path: z.string(),
  content: z.string(),
  size: z.number().int().nonnegative(),
  updatedAt: z.string().optional(),
}).strict();
const weaveContextResultSchema = portalToolResultSchema(
  z.object({
    ok: z.literal(true),
    scope: z.enum(["global", "project"]),
    basePath: z.string().optional(),
    agentInstructions: z.string().optional(),
    files: z.array(weaveContextFileSchema),
  }).strict(),
);
const lspQuerySuccessSchema = z.union([
  lspSessionResultSchema.extend({
    toolRegistry: jsonValueSchema,
    server: jsonValueSchema,
  }).strict(),
  z.object({
    ok: z.literal(true),
    path: z.string(),
    serverId: z.string().optional(),
    diagnostics: jsonValueSchema,
  }).strict(),
  z.object({ ok: z.literal(true), path: z.string(), hover: jsonValueSchema })
    .strict(),
  z.object({
    ok: z.literal(true),
    path: z.string(),
    locations: jsonValueSchema,
  }).strict(),
  z.object({ ok: z.literal(true), path: z.string(), symbols: jsonValueSchema })
    .strict(),
  z.object({ ok: z.literal(true), query: z.string(), symbols: jsonValueSchema })
    .strict(),
  z.object({ ok: z.literal(true), path: z.string(), actions: jsonValueSchema })
    .strict(),
  z.object({
    ok: z.literal(true),
    path: z.string(),
    previewOnly: z.literal(true),
    action: jsonValueSchema,
    editPreview: jsonValueSchema,
  }).strict(),
  z.object({
    ok: z.literal(true),
    path: z.string(),
    previewOnly: z.literal(true),
    workspaceEdit: jsonValueSchema,
    editPreview: jsonValueSchema,
  }).strict(),
  z.object({
    ok: z.literal(true),
    path: z.string(),
    previewOnly: z.literal(true),
    edits: jsonValueSchema,
    editPreview: jsonValueSchema,
  }).strict(),
]);

const portalToolSchemas = {
  read: {
    args: z.object({
      path: z.string(),
      offset: z.number().int().positive().optional(),
      limit: z.number().int().positive().optional(),
    }).strict(),
    result: portalToolResultSchema(
      z.object({ ok: z.literal(true), content: z.string() }).strict(),
    ),
  },
  write: {
    args: z.object({ path: z.string(), content: z.string() }).strict(),
    result: portalToolResultSchema(
      z.object({ ok: z.literal(true), bytes: z.number().int().nonnegative() })
        .strict(),
    ),
  },
  edit: {
    args: z.object({
      path: z.string(),
      edits: z.array(
        z.object({ oldText: z.string().min(1), newText: z.string() }).strict(),
      ).min(1),
    }).strict(),
    result: portalToolResultSchema(
      z.object({
        ok: z.literal(true),
        replacements: z.number().int().positive(),
        diff: z.string(),
      }).strict(),
    ),
  },
  bash: {
    args: z.object({
      command: z.string(),
      timeout: z.number().positive().optional(),
      validation: validationKindSchema.optional(),
    }).strict(),
    result: bashToolResultSchema,
  },
  exec_start: {
    args: z.object({
      command: z.string(),
      cwd: z.string().optional(),
      timeout: z.number().positive().optional(),
      yieldMs: z.number().nonnegative().optional(),
      pty: z.boolean().optional(),
      validation: validationKindSchema.optional(),
    }).strict(),
    result: commandSessionToolResultSchema,
  },
  exec_poll: {
    args: z.object({
      sessionId: z.string(),
      afterOffset: z.number().nonnegative().optional(),
      limit: z.number().int().positive().max(100_000).optional(),
    }).strict(),
    result: commandSessionToolResultSchema,
  },
  exec_write: {
    args: z.object({
      sessionId: z.string(),
      data: z.string().optional(),
      close: z.boolean().optional(),
    }).strict(),
    result: commandSessionToolResultSchema,
  },
  exec_stop: {
    args: z.object({ sessionId: z.string() }).strict(),
    result: commandSessionToolResultSchema,
  },
  "portal.context.discover": {
    args: z.object({ scope: z.enum(["global", "project"]).optional() })
      .strict(),
    result: weaveContextResultSchema,
  },
  "portal.git.status": {
    args: emptyObjectSchema,
    result: gitStatusToolResultSchema,
  },
  "portal.git.diff": {
    args: z.object({
      staged: z.boolean().optional(),
      path: z.string().optional(),
      ref: z.string().optional(),
    }).strict(),
    result: portalToolResultSchema(
      z.object({ ok: z.literal(true), diff: z.string() }).strict(),
    ),
  },
  "portal.git.log": {
    args: z.object({
      limit: z.number().int().positive().max(100).optional(),
      ref: z.string().optional(),
    }).strict(),
    result: portalToolResultSchema(
      z.object({
        ok: z.literal(true),
        commits: z.array(
          z.object({
            sha: z.string(),
            parents: z.array(z.string()),
            authorName: z.string(),
            authorEmail: z.string(),
            authoredAt: z.string(),
            refs: z.string(),
            subject: z.string(),
          }).strict(),
        ),
      }).strict(),
    ),
  },
  "portal.git.show": {
    args: z.object({ ref: z.string().optional() }).strict(),
    result: portalToolResultSchema(
      z.object({ ok: z.literal(true), ref: z.string(), output: z.string() })
        .strict(),
    ),
  },
  "portal.git.fetch": {
    args: emptyObjectSchema,
    result: gitStatusToolResultSchema,
  },
  "portal.git.pull": {
    args: emptyObjectSchema,
    result: gitStatusToolResultSchema,
  },
  "portal.fs.list": {
    args: optionalPathArgsSchema,
    result: portalToolResultSchema(workspaceFileListResultSchema),
  },
  "portal.fs.read": {
    args: requiredPathArgsSchema,
    result: portalToolResultSchema(workspaceFileReadResultSchema),
  },
  "portal.fs.hash": {
    args: requiredPathArgsSchema,
    result: portalToolResultSchema(workspaceFileHashResultSchema),
  },
  "portal.fs.diffPreview": {
    args: z.object({ path: z.string(), diff: z.string() }).strict(),
    result: portalToolResultSchema(workspaceFileDiffPreviewResultSchema),
  },
  "portal.fs.write": {
    args: z.object({
      path: z.string(),
      content: z.string(),
      version: z.string().optional(),
      createParents: z.boolean().optional(),
    }).strict(),
    result: portalToolResultSchema(workspaceFileWriteResultSchema),
  },
  "portal.fs.mkdir": {
    args: requiredPathArgsSchema,
    result: portalToolResultSchema(fileOperationResultSchema),
  },
  "portal.fs.move": {
    args: z.object({
      fromPath: z.string(),
      toPath: z.string(),
      overwrite: z.boolean().optional(),
      createParents: z.boolean().optional(),
    }).strict(),
    result: portalToolResultSchema(fileOperationResultSchema),
  },
  "portal.fs.delete": {
    args: z.object({ path: z.string(), recursive: z.boolean().optional() })
      .strict(),
    result: portalToolResultSchema(fileOperationResultSchema),
  },
  "portal.fs.index": {
    args: optionalPathArgsSchema,
    result: portalToolResultSchema(workspaceFileIndexResultSchema),
  },
  "portal.fs.upload": {
    args: z.object({
      path: z.string(),
      base64Content: z.string(),
      contentType: z.string().optional(),
    }).strict(),
    result: portalToolResultSchema(fileOperationResultSchema),
  },
  "portal.lsp.session": {
    args: lspSessionArgsSchema,
    result: portalToolResultSchema(lspSessionResultSchema),
  },
  "portal.lsp.query": {
    args: lspSessionArgsSchema.extend({
      feature: z.enum([
        "capabilities",
        "diagnostics",
        "hover",
        "definition",
        "references",
        "symbols",
        "workspaceSymbols",
        "codeActions",
        "codeActionPreview",
        "renamePreview",
        "formatPreview",
      ]),
      line: z.number().int().nonnegative().optional(),
      character: z.number().int().nonnegative().optional(),
      query: z.string().optional(),
      newName: z.string().optional(),
      range: z.object({ start: lspPositionSchema, end: lspPositionSchema })
        .strict().optional(),
      action: jsonValueSchema.optional(),
      actionIndex: z.number().int().nonnegative().optional(),
    }).strict(),
    result: portalToolResultSchema(lspQuerySuccessSchema),
  },
  "portal.jupyter.status": {
    args: emptyObjectSchema,
    result: portalToolResultSchema(jupyterStatusResultSchema),
  },
  "portal.jupyter.kernelspecs": {
    args: emptyObjectSchema,
    result: portalToolResultSchema(jupyterKernelspecsResultSchema),
  },
  "portal.jupyter.session": {
    args: z.object({
      path: z.string(),
      kernelName: z.string().optional(),
      language: z.string().optional(),
    }).strict(),
    result: portalToolResultSchema(jupyterSessionResultSchema),
  },
  "portal.fs.browse": {
    args: z.object({
      rootId: z.string().optional(),
      path: z.string().optional(),
    }).strict(),
    result: portalToolResultSchema(
      z.object({
        ok: z.literal(true),
        rootId: z.string(),
        path: z.string(),
        realPath: z.string(),
        entries: z.array(browseEntrySchema),
        isGitRepo: z.boolean(),
        git: gitInspectSchema.optional(),
      }).strict(),
    ),
  },
  "portal.fs.pathStat": {
    args: z.object({ rootId: z.string().optional(), path: z.string() })
      .strict(),
    result: portalToolResultSchema(
      z.object({
        ok: z.literal(true),
        path: z.string(),
        isDirectory: z.boolean(),
        isFile: z.boolean(),
        isSymlink: z.boolean(),
      }).strict(),
    ),
  },
  "portal.git.inspect": {
    args: z.object({
      rootId: z.string().optional(),
      path: z.string().optional(),
    }).strict(),
    result: portalToolResultSchema(
      z.object({
        ok: z.literal(true),
        rootId: z.string(),
        path: z.string(),
        git: gitInspectSchema,
      }).strict(),
    ),
  },
  "portal.agentInstructions.read": {
    args: z.object({
      rootId: z.string().optional(),
      path: z.string().optional(),
    }).strict(),
    result: portalToolResultSchema(
      z.object({
        ok: z.literal(true),
        agentInstructions: z.string().optional(),
        files: z.array(weaveContextFileSchema),
      }).strict(),
    ),
  },
  "portal.git.worktree.create": {
    args: z.object({
      mode: z.enum(["newBranch", "existingBranch", "detached"]).optional(),
      name: z.string().optional(),
      branch: z.string().optional(),
      base: z.string().optional(),
      path: z.string().optional(),
    }).strict(),
    result: portalToolResultSchema(
      z.object({ ok: z.literal(true), worktree: gitWorktreeInfoSchema })
        .strict(),
    ),
  },
  "portal.git.worktree.list": {
    args: emptyObjectSchema,
    result: portalToolResultSchema(
      z.object({
        ok: z.literal(true),
        worktrees: z.array(gitWorktreeInfoSchema),
      })
        .strict(),
    ),
  },
  "portal.git.branches.list": {
    args: emptyObjectSchema,
    result: portalToolResultSchema(
      z.object({ ok: z.literal(true), branches: z.array(branchOptionSchema) })
        .strict(),
    ),
  },
  "portal.git.worktree.switch": {
    args: z.object({
      branch: z.string(),
      base: z.string().optional(),
      create: z.boolean().optional(),
    }).strict(),
    result: portalToolResultSchema(
      z.object({ ok: z.literal(true), worktree: gitWorktreeInfoSchema })
        .strict(),
    ),
  },
  "portal.git.worktree.remove": {
    args: z.object({
      path: z.string().optional(),
      force: z.boolean().optional(),
      deleteLocalBranch: z.boolean().optional(),
      defaultBranch: z.string().optional(),
    }).strict(),
    result: portalToolResultSchema(
      z.object({ ok: z.literal(true), branchCleanup: branchCleanupSchema })
        .strict(),
    ),
  },
  "portal.git.worktree.branch-cleanup": {
    args: z.object({
      path: z.string().optional(),
      deleteLocalBranch: z.boolean().optional(),
      defaultBranch: z.string().optional(),
    }).strict(),
    result: portalToolResultSchema(
      z.object({ ok: z.literal(true), branchCleanup: branchCleanupSchema })
        .strict(),
    ),
  },
  "portal.git.worktree.validate": {
    args: z.object({ path: z.string(), rootId: z.string().optional() })
      .strict(),
    result: portalToolResultSchema(
      z.object({ ok: z.literal(true), worktree: gitWorktreeInfoSchema })
        .strict(),
    ),
  },
} as const;

export type PortalToolName = keyof typeof portalToolSchemas;
export type PortalToolArgs<Name extends PortalToolName> = z.input<
  (typeof portalToolSchemas)[Name]["args"]
>;
export type PortalToolResult<Name extends PortalToolName> = z.output<
  (typeof portalToolSchemas)[Name]["result"]
>;
export const portalToolNames = Object.freeze(
  Object.keys(portalToolSchemas) as PortalToolName[],
);
export const portalToolNameSchema = z.custom<PortalToolName>(
  (value) =>
    typeof value === "string" && Object.hasOwn(portalToolSchemas, value),
  "Unknown Portal tool name.",
);

export const parsePortalToolArgs = <Name extends PortalToolName>(
  name: Name,
  value: unknown,
): PortalToolArgs<Name> =>
  portalToolSchemas[name].args.parse(value) as PortalToolArgs<Name>;

const omitUndefinedObjectProperties = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(omitUndefinedObjectProperties);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, omitUndefinedObjectProperties(item)]),
  );
};

export const parsePortalToolResult = <Name extends PortalToolName>(
  name: Name,
  value: unknown,
): PortalToolResult<Name> => {
  const parsed = portalToolSchemas[name].result.parse(value);
  return jsonObjectSchema.parse(
    omitUndefinedObjectProperties(parsed),
  ) as PortalToolResult<Name>;
};

const portalToolCallParamsSchema = z.object({
  projectId: optionalIdSchema,
  workspaceId: optionalIdSchema,
  rootId: optionalIdSchema,
  repoPath: z.string().optional(),
  workspacePath: z.string().optional(),
  executionProfile: z.enum(["observe", "workspace", "host"]).optional(),
  tool: portalToolNameSchema,
  args: jsonObjectSchema,
  timeoutMs: z.number().int().positive().optional(),
  idempotencyKey: z.string().optional(),
}).strict();

const portalTargetParams = <Shape extends z.ZodRawShape>(shape: Shape) =>
  z.object({ target: workspaceFileTargetSchema, clientId: idSchema, ...shape })
    .strict();
const portalWorkspaceFileParams = <Shape extends z.ZodRawShape>(shape: Shape) =>
  z.object({
    target: workspaceFileTargetSchema,
    args: z.object(shape).strict(),
  }).strict();
const portalTerminalParamsSchema = terminalRpcParamsSchema.extend({
  clientId: idSchema,
}).strict();
const portalLspParamsSchema = lspCreateParamsSchema.extend({
  sessionId: idSchema,
  clientId: idSchema,
}).strict();
const portalJupyterParamsSchema = jupyterSessionParamsSchema.extend({
  sessionId: idSchema,
  clientId: idSchema,
}).strict();

const serverPortalRequests = [
  request(
    "portal.tool.call",
    "server",
    "portal",
    portalToolCallParamsSchema,
    jsonObjectSchema,
  ),
  request(
    "portal.shutdown",
    "server",
    "portal",
    emptyObjectSchema,
    okResultSchema,
  ),
  request(
    "portal.workspaceFile.list",
    "server",
    "portal",
    portalWorkspaceFileParams({ path: z.string() }),
    workspaceFileListResultSchema,
  ),
  request(
    "portal.workspaceFile.read",
    "server",
    "portal",
    portalWorkspaceFileParams({ path: z.string() }),
    workspaceFileReadResultSchema,
  ),
  request(
    "portal.workspaceFile.hash",
    "server",
    "portal",
    portalWorkspaceFileParams({ path: z.string() }),
    workspaceFileHashResultSchema,
  ),
  request(
    "portal.workspaceFile.diffPreview",
    "server",
    "portal",
    portalWorkspaceFileParams({ path: z.string(), diff: z.string() }),
    workspaceFileDiffPreviewResultSchema,
  ),
  request(
    "portal.workspaceFile.write",
    "server",
    "portal",
    portalWorkspaceFileParams({
      path: z.string(),
      content: z.string().optional(),
      transferId: optionalIdSchema,
      version: z.string().optional(),
    }),
    workspaceFileWriteResultSchema,
  ),
  request(
    "portal.workspaceFile.mkdir",
    "server",
    "portal",
    portalWorkspaceFileParams({ path: z.string() }),
    fileOperationResultSchema,
  ),
  request(
    "portal.workspaceFile.move",
    "server",
    "portal",
    portalWorkspaceFileParams({
      fromPath: z.string(),
      toPath: z.string(),
      overwrite: z.boolean().optional(),
    }),
    fileOperationResultSchema,
  ),
  request(
    "portal.workspaceFile.delete",
    "server",
    "portal",
    portalWorkspaceFileParams({
      path: z.string(),
      recursive: z.boolean().optional(),
    }),
    fileOperationResultSchema,
  ),
  request(
    "portal.workspaceFile.index",
    "server",
    "portal",
    portalWorkspaceFileParams({ path: z.string() }),
    workspaceFileIndexResultSchema,
  ),
  request(
    "portal.workspaceFile.upload",
    "server",
    "portal",
    portalWorkspaceFileParams({
      path: z.string(),
      transferId: idSchema,
      contentType: z.string().optional(),
    }),
    fileOperationResultSchema,
  ),
  request(
    "portal.workspaceFile.watch.start",
    "server",
    "portal",
    portalTargetParams({
      sessionId: idSchema,
      requestId: idSchema,
      paths: stringArraySchema,
    }),
    okResultSchema,
  ),
  request(
    "portal.workspaceFile.watch.update",
    "server",
    "portal",
    portalTargetParams({
      sessionId: idSchema,
      requestId: idSchema,
      paths: stringArraySchema,
    }),
    okResultSchema,
  ),
  request(
    "portal.workspaceFile.watch.stop",
    "server",
    "portal",
    portalTargetParams({ sessionId: idSchema, requestId: idSchema.optional() }),
    okResultSchema,
  ),
  request(
    "portal.terminal.snapshot",
    "server",
    "portal",
    portalTerminalParamsSchema,
    okResultSchema,
  ),
  request(
    "portal.terminal.list",
    "server",
    "portal",
    portalTerminalParamsSchema,
    okResultSchema,
  ),
  request(
    "portal.terminal.create",
    "server",
    "portal",
    portalTerminalParamsSchema,
    okResultSchema,
  ),
  request(
    "portal.terminal.attach",
    "server",
    "portal",
    portalTerminalParamsSchema,
    okResultSchema,
  ),
  request(
    "portal.terminal.input",
    "server",
    "portal",
    portalTerminalParamsSchema.extend({ data: z.string() }).strict(),
    okResultSchema,
  ),
  request(
    "portal.terminal.resize",
    "server",
    "portal",
    portalTerminalParamsSchema.extend({
      cols: z.number().int().positive(),
      rows: z.number().int().positive(),
    }).strict(),
    okResultSchema,
  ),
  request(
    "portal.terminal.close",
    "server",
    "portal",
    portalTerminalParamsSchema,
    okResultSchema,
  ),
  request(
    "portal.terminal.detach",
    "server",
    "portal",
    portalTerminalParamsSchema,
    okResultSchema,
  ),
  request(
    "portal.lsp.start",
    "server",
    "portal",
    portalLspParamsSchema,
    lspSessionResultSchema,
  ),
  request(
    "portal.lsp.send",
    "server",
    "portal",
    portalLspParamsSchema.extend({ message: z.string() }).strict(),
    okResultSchema,
  ),
  request(
    "portal.lsp.close",
    "server",
    "portal",
    portalLspParamsSchema,
    okResultSchema,
  ),
  request(
    "portal.jupyter.execute",
    "server",
    "portal",
    portalJupyterParamsSchema.extend({
      code: z.string(),
      requestId: idSchema.optional(),
      cellId: idSchema.optional(),
      allowStdin: z.boolean().optional(),
      silent: z.boolean().optional(),
      storeHistory: z.boolean().optional(),
    }).strict(),
    okResultSchema,
  ),
  request(
    "portal.jupyter.close",
    "server",
    "portal",
    portalJupyterParamsSchema,
    okResultSchema,
  ),
  request(
    "binary.begin",
    "server",
    "portal",
    binaryTransferDescriptorSchema,
    binaryBeginResultSchema,
  ),
  request(
    "binary.chunk",
    "server",
    "portal",
    binaryChunkRequestParamsSchema,
    binaryChunkResultSchema,
  ),
  request(
    "binary.ack",
    "server",
    "portal",
    binaryAckParamsSchema,
    okResultSchema,
  ),
  request(
    "binary.complete",
    "server",
    "portal",
    binaryCompleteParamsSchema,
    binaryCompleteResultSchema,
  ),
  request(
    "binary.abort",
    "server",
    "portal",
    binaryAbortParamsSchema,
    okResultSchema,
  ),
] as const;

const portalServerRequests = [
  request(
    "initialize",
    "portal",
    "server",
    rpcPortalInitializeParamsSchema,
    rpcPortalInitializeResultSchema,
  ),
  request(
    "binary.begin",
    "portal",
    "server",
    binaryTransferDescriptorSchema,
    binaryBeginResultSchema,
  ),
  request(
    "binary.chunk",
    "portal",
    "server",
    binaryChunkRequestParamsSchema,
    binaryChunkResultSchema,
  ),
  request(
    "binary.ack",
    "portal",
    "server",
    binaryAckParamsSchema,
    okResultSchema,
  ),
  request(
    "binary.complete",
    "portal",
    "server",
    binaryCompleteParamsSchema,
    binaryCompleteResultSchema,
  ),
  request(
    "binary.abort",
    "portal",
    "server",
    binaryAbortParamsSchema,
    okResultSchema,
  ),
] as const;

const serverPortalNotifications = [
  notification(
    "connection.ping",
    "server",
    "portal",
    z.object({ nonce: z.string().optional(), at: z.string().optional() })
      .strict(),
  ),
] as const;

const portalServerNotifications = [
  notification(
    "connection.pong",
    "portal",
    "server",
    z.object({ nonce: z.string().optional(), at: z.string() }).strict(),
  ),
  notification(
    "connection.cancel",
    "portal",
    "server",
    z.object({ id: z.union([z.string(), z.number()]) }).strict(),
  ),
  notification(
    "portal.status.changed",
    "portal",
    "server",
    z.object({ portal: portalConnectionSchema }).strict(),
  ),
  notification(
    "portal.workspaceFile.watch.event",
    "portal",
    "server",
    z.object({ clientId: idSchema, event: workspaceFileWatchHostEventSchema })
      .strict(),
  ),
  notification(
    "portal.terminal.event",
    "portal",
    "server",
    z.object({ clientId: idSchema, event: terminalHostEventSchema }).strict(),
  ),
  notification(
    "portal.lsp.event",
    "portal",
    "server",
    z.object({ clientId: idSchema, event: lspHostEventSchema }).strict(),
  ),
  notification(
    "portal.jupyter.event",
    "portal",
    "server",
    z.object({ clientId: idSchema, event: jupyterHostEventSchema }).strict(),
  ),
] as const;

export const rpcContracts = [
  ...clientServerRequests,
  ...serverClientRequests,
  ...serverClientNotifications,
  ...clientServerNotifications,
  ...serverPortalRequests,
  ...portalServerRequests,
  ...serverPortalNotifications,
  ...portalServerNotifications,
] as const;

export const rpcProtocolDomains = [
  "transport",
  "chat",
  "projects-workspaces",
  "files",
  "terminals",
  "lsp",
  "jupyter",
  "workflows",
  "artifacts",
  "notifications",
  "portal",
  "portal-tools",
] as const;
export type RpcProtocolDomain = (typeof rpcProtocolDomains)[number];

export const rpcDomainForMethod = (method: string): RpcProtocolDomain => {
  if (method === "portal.tool.call") return "portal-tools";
  if (method.startsWith("portal.")) return "portal";
  if (method.startsWith("terminal.")) return "terminals";
  if (
    method.startsWith("workspaceFile.") || method === "client.editorContext.get"
  ) return "files";
  if (method.startsWith("lsp.")) return "lsp";
  if (method.startsWith("jupyter.")) return "jupyter";
  if (method.startsWith("workflow.")) return "workflows";
  if (method.startsWith("attachment.") || method.startsWith("userArtifact.")) {
    return "artifacts";
  }
  if (method.startsWith("notification.")) return "notifications";
  if (method.startsWith("code.")) return "projects-workspaces";
  if (
    method.startsWith("chat.") || method.startsWith("agent.") ||
    method === "owner.get"
  ) return "chat";
  if (
    method === "initialize" || method.startsWith("binary.") ||
    method.startsWith("connection.") ||
    method === "client.surface.update"
  ) return "transport";
  throw new Error(`RPC method has no protocol domain: ${method}.`);
};

export const rpcContractsByDomain = Object.freeze(Object.fromEntries(
  rpcProtocolDomains.map((domain) => [
    domain,
    Object.freeze(
      rpcContracts.filter((contract) =>
        rpcDomainForMethod(contract.method) === domain
      ),
    ),
  ]),
)) as Readonly<
  Record<RpcProtocolDomain, readonly (typeof rpcContracts)[number][]>
>;

export type RpcContract = typeof rpcContracts[number];
export type RpcRequestDefinition = Extract<RpcContract, { kind: "request" }>;
export type RpcNotificationDefinition = Extract<
  RpcContract,
  { kind: "notification" }
>;

type RequestRoute<
  Source extends RpcRole,
  Destination extends RpcRole,
  Method extends string = string,
> = Source extends RpcRole ? Destination extends RpcRole ? Extract<
      RpcRequestDefinition,
      { source: Source; destination: Destination; method: Method }
    >
  : never
  : never;
type NotificationRoute<
  Source extends RpcRole,
  Destination extends RpcRole,
  Method extends string = string,
> = Source extends RpcRole ? Destination extends RpcRole ? Extract<
      RpcNotificationDefinition,
      { source: Source; destination: Destination; method: Method }
    >
  : never
  : never;

export type RpcRequestMethod<
  Source extends RpcRole,
  Destination extends RpcRole,
> = RequestRoute<Source, Destination>["method"];
export type RpcNotificationMethod<
  Source extends RpcRole,
  Destination extends RpcRole,
> = NotificationRoute<Source, Destination>["method"];
export type RpcRequestSource<
  Destination extends RpcRole,
  Method extends string,
> = RequestRoute<RpcRole, Destination, Method>["source"];
export type RpcNotificationSource<
  Destination extends RpcRole,
  Method extends string,
> = NotificationRoute<RpcRole, Destination, Method>["source"];
export type RpcRequestParams<
  Source extends RpcRole,
  Destination extends RpcRole,
  Method extends string,
> = z.input<RequestRoute<Source, Destination, Method>["params"]>;
export type RpcRequestParsedParams<
  Source extends RpcRole,
  Destination extends RpcRole,
  Method extends string,
> = z.output<RequestRoute<Source, Destination, Method>["params"]>;
export type RpcRequestResult<
  Source extends RpcRole,
  Destination extends RpcRole,
  Method extends string,
> = z.output<RequestRoute<Source, Destination, Method>["result"]>;
export type RpcNotificationParams<
  Source extends RpcRole,
  Destination extends RpcRole,
  Method extends string,
> = z.input<NotificationRoute<Source, Destination, Method>["params"]>;
export type RpcNotificationData<
  Source extends RpcRole,
  Destination extends RpcRole,
  Method extends string,
> = z.output<NotificationRoute<Source, Destination, Method>["params"]>;

export type RpcRequestArguments<
  Source extends RpcRole,
  Destination extends RpcRole,
  Method extends string,
> = undefined extends RpcRequestParams<Source, Destination, Method> ? [
    params?: RpcRequestParams<Source, Destination, Method>,
    options?: RpcRequestOptions,
  ]
  : [
    params: RpcRequestParams<Source, Destination, Method>,
    options?: RpcRequestOptions,
  ];

export type RpcRequestOptions = { timeoutMs?: number; signal?: AbortSignal };

const routeKey = (
  kind: RpcContract["kind"],
  source: RpcRole,
  destination: RpcRole,
  method: string,
) => `${kind}:${source}:${destination}:${method}`;
const contractIndex = new Map(rpcContracts.map((contract) => [
  routeKey(
    contract.kind,
    contract.source,
    contract.destination,
    contract.method,
  ),
  contract,
]));

export class RpcContractError extends Error {
  constructor(
    readonly boundary: "params" | "result" | "notification",
    readonly source: RpcRole,
    readonly destination: RpcRole,
    readonly method: string,
    readonly issues?: z.core.$ZodIssue[],
  ) {
    super(`Invalid RPC ${boundary} for ${source} -> ${destination} ${method}.`);
    this.name = "RpcContractError";
  }
}

export const getRpcContract = (
  kind: RpcContract["kind"],
  source: RpcRole,
  destination: RpcRole,
  method: string,
): RpcContract | undefined =>
  contractIndex.get(routeKey(kind, source, destination, method));

export const parseRpcRequestParams = <
  Source extends RpcRole,
  Destination extends RpcRole,
  Method extends string,
>(
  source: Source,
  destination: Destination,
  method: Method,
  value: unknown,
): RpcRequestParsedParams<Source, Destination, Method> => {
  const contract = getRpcContract("request", source, destination, method);
  if (!contract || contract.kind !== "request") {
    throw new Error(
      `Unknown RPC request route: ${source} -> ${destination} ${method}.`,
    );
  }
  const parsed = contract.params.safeParse(value);
  if (!parsed.success) {
    throw new RpcContractError(
      "params",
      source,
      destination,
      method,
      parsed.error.issues,
    );
  }
  return parsed.data as RpcRequestParsedParams<Source, Destination, Method>;
};

export const parseRpcRequestResult = <
  Source extends RpcRole,
  Destination extends RpcRole,
  Method extends string,
>(
  source: Source,
  destination: Destination,
  method: Method,
  value: unknown,
): RpcRequestResult<Source, Destination, Method> => {
  const contract = getRpcContract("request", source, destination, method);
  if (!contract || contract.kind !== "request") {
    throw new Error(
      `Unknown RPC request route: ${source} -> ${destination} ${method}.`,
    );
  }
  const parsed = contract.result.safeParse(value);
  if (!parsed.success) {
    throw new RpcContractError(
      "result",
      source,
      destination,
      method,
      parsed.error.issues,
    );
  }
  return parsed.data as RpcRequestResult<Source, Destination, Method>;
};

export const parseRpcNotificationParams = <
  Source extends RpcRole,
  Destination extends RpcRole,
  Method extends string,
>(
  source: Source,
  destination: Destination,
  method: Method,
  value: unknown,
): RpcNotificationData<Source, Destination, Method> => {
  const contract = getRpcContract("notification", source, destination, method);
  if (!contract || contract.kind !== "notification") {
    throw new Error(
      `Unknown RPC notification route: ${source} -> ${destination} ${method}.`,
    );
  }
  const parsed = contract.params.safeParse(value);
  if (!parsed.success) {
    throw new RpcContractError(
      "notification",
      source,
      destination,
      method,
      parsed.error.issues,
    );
  }
  return parsed.data as RpcNotificationData<Source, Destination, Method>;
};

export const rpcMethodNames = Object.freeze([
  ...new Set(rpcContracts.map(({ method }) => method)),
]);
export type RpcMethodName = RpcContract["method"];
export const rpcMethodNameSchema = z.custom<RpcMethodName>(
  (value) =>
    typeof value === "string" &&
    rpcMethodNames.includes(value as RpcMethodName),
  "Unknown RPC method.",
);

export const rpcCapabilities = (source: RpcRole, destination: RpcRole) =>
  Object.freeze(
    rpcContracts
      .filter((contract) =>
        contract.source === source && contract.destination === destination
      )
      .map((contract) => `${contract.kind}:${contract.method}`)
      .sort(),
  );

export const rpcRequestMethods = (source: RpcRole, destination: RpcRole) =>
  Object.freeze(
    rpcContracts
      .filter((contract) =>
        contract.kind === "request" && contract.source === source &&
        contract.destination === destination
      )
      .map((contract) => contract.method)
      .sort(),
  );

export const rpcNotificationMethods = (source: RpcRole, destination: RpcRole) =>
  Object.freeze(
    rpcContracts
      .filter((contract) =>
        contract.kind === "notification" && contract.source === source &&
        contract.destination === destination
      )
      .map((contract) => contract.method)
      .sort(),
  );

export const rpcAllowedSourceRoles = (
  method: string,
  destination: RpcRole,
  kind: RpcContract["kind"],
) =>
  Object.freeze([
    ...new Set(
      rpcContracts
        .filter((contract) =>
          contract.method === method && contract.destination === destination &&
          contract.kind === kind
        )
        .map((contract) => contract.source),
    ),
  ]);

export const binaryTransferDefaults = {
  chunkBytes: WEAVE_RPC_BINARY_CHUNK_BYTES,
  windowSize: WEAVE_RPC_BINARY_WINDOW_SIZE,
} as const;
