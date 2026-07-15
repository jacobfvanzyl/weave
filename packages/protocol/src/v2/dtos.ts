import { z } from "zod";
import {
  jsonObjectSchema,
  jsonValueSchema,
  nonEmptyStringSchema,
} from "./primitives.ts";

const providerMetadataSchema = z.record(z.string(), jsonObjectSchema);

export const ownerSchema = z.object({
  id: nonEmptyStringSchema,
  name: z.string(),
}).strict();
export type Owner = z.infer<typeof ownerSchema>;

export const clientToolConnectionSchema = z.object({
  clientId: nonEmptyStringSchema,
  userId: nonEmptyStringSchema,
  name: z.string().optional(),
  version: z.string().optional(),
  capabilities: z.array(z.string()),
  surfaceId: z.string().optional(),
  projectId: z.string().optional(),
  workspaceId: z.string().optional(),
  threadId: z.string().optional(),
  active: z.boolean().optional(),
  status: z.enum(["online", "offline"]),
  connectedAt: z.string(),
  lastSeenAt: z.string(),
}).strict();
export type ClientToolConnection = z.infer<typeof clientToolConnectionSchema>;

export const weaveNotificationTargetSchema = z.object({
  threadId: z.string().optional(),
  projectId: z.string().optional(),
  workspaceId: z.string().optional(),
  url: z.string().optional(),
}).strict();
export const weaveNotificationEventSchema = z.object({
  id: nonEmptyStringSchema,
  kind: nonEmptyStringSchema,
  title: nonEmptyStringSchema,
  body: z.string().optional(),
  createdAt: z.string(),
  dedupeKey: z.string().optional(),
  priority: z.enum(["low", "normal", "high"]),
  target: weaveNotificationTargetSchema.optional(),
  source: z.enum(["client", "server"]),
}).strict();
export type WeaveNotificationEvent = z.infer<
  typeof weaveNotificationEventSchema
>;
export const storedNotificationEventSchema = z.object({
  sequence: z.number().int().nonnegative(),
  event: weaveNotificationEventSchema,
}).strict();
export type StoredNotificationEvent = z.infer<
  typeof storedNotificationEventSchema
>;

export const portalMountSchema = z.object({
  projectId: nonEmptyStringSchema,
  localPath: nonEmptyStringSchema,
}).strict();
export type PortalMount = z.infer<typeof portalMountSchema>;

export const portalRootSchema = z.object({
  id: nonEmptyStringSchema,
  name: z.string().optional(),
  path: nonEmptyStringSchema,
}).strict();
export type PortalRoot = z.infer<typeof portalRootSchema>;

export const portalTargetSchema = z.object({
  portalId: nonEmptyStringSchema.optional(),
  projectId: nonEmptyStringSchema.optional(),
  workspaceId: nonEmptyStringSchema.optional(),
  rootId: nonEmptyStringSchema.optional(),
  repoPath: z.string().optional(),
  workspacePath: z.string().optional(),
}).strict();
export type PortalTarget = z.infer<typeof portalTargetSchema>;

export const portalConnectionSchema = z.object({
  portalId: nonEmptyStringSchema,
  userId: nonEmptyStringSchema,
  name: z.string().optional(),
  version: z.string().optional(),
  primary: z.boolean().optional(),
  capabilities: z.array(z.string()).default([]),
  mounts: z.array(portalMountSchema).default([]),
  roots: z.array(portalRootSchema).default([]),
  status: z.enum(["online", "offline"]),
  connectedAt: z.string().optional(),
  lastSeenAt: z.string().optional(),
}).strict();
export type PortalConnection = z.infer<typeof portalConnectionSchema>;

export const workspaceSchema = z.object({
  id: nonEmptyStringSchema,
  projectId: nonEmptyStringSchema,
  portalId: nonEmptyStringSchema.optional(),
  mountId: nonEmptyStringSchema.optional(),
  workspaceKind: z.enum(["primary", "worktree"]),
  source: z.enum(["primary", "git", "notes", "adopted", "legacy"]).optional(),
  name: z.string(),
  path: z.string().optional(),
  branch: z.string().optional(),
  head: z.string().optional(),
  upstream: z.string().optional(),
  ahead: z.number().int().nonnegative().optional(),
  behind: z.number().int().nonnegative().optional(),
  detached: z.boolean().optional(),
  baseBranch: z.string().optional(),
  locked: z.boolean().optional(),
  sortOrder: z.number().optional(),
  status: z.enum([
    "ready",
    "offline",
    "creating",
    "dirty",
    "missing",
    "virtual",
    "error",
  ]),
  lastError: z.string().optional(),
  hidden: z.boolean().optional(),
  systemKind: z.literal("adHoc").optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict();
export type Workspace = z.infer<typeof workspaceSchema>;

export const notesStorageMetadataSchema = z.object({
  kind: z.string(),
  bucket: z.string().optional(),
  prefix: z.string().optional(),
  portalId: z.string().optional(),
  rootId: z.string().optional(),
  vaultPath: z.string().optional(),
  workspacePath: z.string().optional(),
  extensions: jsonObjectSchema.optional(),
}).strict();
export type NotesStorageMetadata = z.infer<typeof notesStorageMetadataSchema>;

export const projectSchema = z.object({
  id: nonEmptyStringSchema,
  userId: nonEmptyStringSchema,
  name: z.string(),
  projectKind: z.enum(["general", "git", "notes"]),
  description: z.string().optional(),
  portalId: z.string().optional(),
  portalRootId: z.string().optional(),
  repoPath: z.string().optional(),
  vaultPath: z.string().optional(),
  notesStorage: notesStorageMetadataSchema.optional(),
  gitRemote: z.string().optional(),
  defaultBranch: z.string().optional(),
  rootPathHint: z.string().optional(),
  sortOrder: z.number().optional(),
  agentInstructions: z.object({
    path: z.string(),
    content: z.string(),
    size: z.number().nonnegative().optional(),
    updatedAt: z.string().optional(),
    checkedAt: z.string().optional(),
  }).strict().optional(),
  hidden: z.boolean().optional(),
  systemKind: z.literal("adHoc").optional(),
  workspaces: z.array(workspaceSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict();
export type Project = z.infer<typeof projectSchema>;

export const chatThreadSchema = z.object({
  id: nonEmptyStringSchema,
  title: z.string().optional(),
  resourceId: nonEmptyStringSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  metadata: jsonObjectSchema.optional(),
}).strict();
export type ChatThread = z.infer<typeof chatThreadSchema>;

const messageTextPartSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
  state: z.enum(["streaming", "done"]).optional(),
  providerMetadata: providerMetadataSchema.optional(),
}).strict();
const messageReasoningPartSchema = z.object({
  type: z.literal("reasoning"),
  text: z.string(),
  state: z.enum(["streaming", "done"]).optional(),
  providerMetadata: providerMetadataSchema.optional(),
}).strict();
const messageFilePartSchema = z.object({
  type: z.literal("file"),
  url: z.string(),
  mediaType: z.string(),
  filename: z.string().optional(),
  providerMetadata: providerMetadataSchema.optional(),
}).strict();
const messageSourceUrlPartSchema = z.object({
  type: z.literal("source-url"),
  sourceId: z.string(),
  url: z.string(),
  title: z.string().optional(),
  providerMetadata: providerMetadataSchema.optional(),
}).strict();
const messageSourceDocumentPartSchema = z.object({
  type: z.literal("source-document"),
  sourceId: z.string(),
  mediaType: z.string(),
  title: z.string(),
  filename: z.string().optional(),
  providerMetadata: providerMetadataSchema.optional(),
}).strict();
const messageDataPartSchema = z.object({
  type: z.custom<`data-${string}`>((value) =>
    typeof value === "string" && value.startsWith("data-")
  ),
  id: z.string().optional(),
  data: jsonValueSchema,
}).strict();
const approvalRequestedSchema = z.object({
  id: z.string(),
  signature: z.string().optional(),
}).strict();
const approvalRespondedSchema = z.object({
  id: z.string(),
  approved: z.boolean(),
  reason: z.string().optional(),
  signature: z.string().optional(),
}).strict();
const approvalApprovedSchema = z.object({
  id: z.string(),
  approved: z.literal(true),
  reason: z.string().optional(),
  signature: z.string().optional(),
}).strict();
const approvalDeniedSchema = z.object({
  id: z.string(),
  approved: z.literal(false),
  reason: z.string().optional(),
  signature: z.string().optional(),
}).strict();
const toolPartBase = {
  toolCallId: z.string(),
  title: z.string().optional(),
  toolMetadata: jsonObjectSchema.optional(),
  providerExecuted: z.boolean().optional(),
};
const toolPartProviderFields = {
  callProviderMetadata: providerMetadataSchema.optional(),
  resultProviderMetadata: providerMetadataSchema.optional(),
};
const toolStateSchemas = <Shape extends z.ZodRawShape>(shape: Shape) =>
  z.discriminatedUnion("state", [
    z.object({
      ...shape,
      state: z.literal("input-streaming"),
      input: jsonValueSchema.optional(),
      ...toolPartProviderFields,
    }).strict(),
    z.object({
      ...shape,
      state: z.literal("input-available"),
      input: jsonValueSchema,
      ...toolPartProviderFields,
    }).strict(),
    z.object({
      ...shape,
      state: z.literal("approval-requested"),
      input: jsonValueSchema,
      approval: approvalRequestedSchema,
      ...toolPartProviderFields,
    }).strict(),
    z.object({
      ...shape,
      state: z.literal("approval-responded"),
      input: jsonValueSchema,
      approval: approvalRespondedSchema,
      ...toolPartProviderFields,
    }).strict(),
    z.object({
      ...shape,
      state: z.literal("output-available"),
      input: jsonValueSchema,
      output: jsonValueSchema,
      preliminary: z.boolean().optional(),
      approval: approvalApprovedSchema.optional(),
      ...toolPartProviderFields,
    }).strict(),
    z.object({
      ...shape,
      state: z.literal("output-error"),
      input: jsonValueSchema,
      rawInput: jsonValueSchema.optional(),
      errorText: z.string(),
      approval: approvalApprovedSchema.optional(),
      ...toolPartProviderFields,
    }).strict(),
    z.object({
      ...shape,
      state: z.literal("output-denied"),
      input: jsonValueSchema,
      approval: approvalDeniedSchema,
      ...toolPartProviderFields,
    }).strict(),
  ]);
const messageDynamicToolPartSchema = toolStateSchemas({
  type: z.literal("dynamic-tool"),
  toolName: z.string(),
  ...toolPartBase,
});
const messageStaticToolPartSchema = toolStateSchemas({
  type: z.custom<`tool-${string}`>((value) =>
    typeof value === "string" && value.startsWith("tool-")
  ),
  ...toolPartBase,
});
const messageToolPartSchema = z.union([
  messageDynamicToolPartSchema,
  messageStaticToolPartSchema,
]);
const messageStepPartSchema = z.object({
  type: z.literal("step-start"),
}).strict();

export const weaveMessagePartSchema = z.union([
  messageTextPartSchema,
  messageReasoningPartSchema,
  messageFilePartSchema,
  messageSourceUrlPartSchema,
  messageSourceDocumentPartSchema,
  messageDataPartSchema,
  messageToolPartSchema,
  messageStepPartSchema,
]);
export type WeaveMessagePart = z.infer<typeof weaveMessagePartSchema>;

export const weaveChatMessageSchema = z.object({
  id: nonEmptyStringSchema,
  role: z.enum(["system", "user", "assistant"]),
  parts: z.array(weaveMessagePartSchema),
  metadata: jsonValueSchema.optional(),
  status: z.object({
    type: z.enum(["running", "complete"]),
    reason: z.string().optional(),
  }).strict().optional(),
}).strict();
export type WeaveChatMessage = z.infer<typeof weaveChatMessageSchema>;

const chunkProviderFields = {
  providerMetadata: providerMetadataSchema.optional(),
};
const textStartChunkSchema = z.object({
  type: z.literal("text-start"),
  id: z.string(),
  ...chunkProviderFields,
}).strict();
const textDeltaChunkSchema = z.object({
  type: z.literal("text-delta"),
  id: z.string(),
  delta: z.string(),
  ...chunkProviderFields,
}).strict();
const textEndChunkSchema = z.object({
  type: z.literal("text-end"),
  id: z.string(),
  ...chunkProviderFields,
}).strict();
const reasoningStartChunkSchema = z.object({
  type: z.literal("reasoning-start"),
  id: z.string(),
  ...chunkProviderFields,
}).strict();
const reasoningDeltaChunkSchema = z.object({
  type: z.literal("reasoning-delta"),
  id: z.string(),
  delta: z.string(),
  ...chunkProviderFields,
}).strict();
const reasoningEndChunkSchema = z.object({
  type: z.literal("reasoning-end"),
  id: z.string(),
  ...chunkProviderFields,
}).strict();
const toolCommon = {
  toolCallId: z.string(),
  providerExecuted: z.boolean().optional(),
  providerMetadata: providerMetadataSchema.optional(),
  toolMetadata: jsonObjectSchema.optional(),
  dynamic: z.boolean().optional(),
  title: z.string().optional(),
};

export const weaveChatChunkSchema = z.union([
  textStartChunkSchema,
  textDeltaChunkSchema,
  textEndChunkSchema,
  reasoningStartChunkSchema,
  reasoningDeltaChunkSchema,
  reasoningEndChunkSchema,
  z.object({
    type: z.literal("start"),
    messageId: z.string().optional(),
    messageMetadata: jsonValueSchema.optional(),
  }).strict(),
  z.object({
    type: z.literal("finish"),
    finishReason: z.enum([
      "stop",
      "length",
      "content-filter",
      "tool-calls",
      "error",
      "other",
      "unknown",
    ]).optional(),
    messageMetadata: jsonValueSchema.optional(),
  }).strict(),
  z.object({ type: z.literal("start-step") }).strict(),
  z.object({ type: z.literal("finish-step") }).strict(),
  z.object({ type: z.literal("abort"), reason: z.string().optional() })
    .strict(),
  z.object({ type: z.literal("error"), errorText: z.string() }).strict(),
  z.object({
    type: z.literal("message-metadata"),
    messageMetadata: jsonValueSchema,
  }).strict(),
  z.object({
    type: z.literal("tool-input-start"),
    toolName: z.string(),
    ...toolCommon,
  }).strict(),
  z.object({
    type: z.literal("tool-input-delta"),
    toolCallId: z.string(),
    inputTextDelta: z.string(),
  }).strict(),
  z.object({
    type: z.literal("tool-input-available"),
    toolName: z.string(),
    input: jsonValueSchema,
    ...toolCommon,
  }).strict(),
  z.object({
    type: z.literal("tool-input-error"),
    toolName: z.string(),
    input: jsonValueSchema,
    errorText: z.string(),
    ...toolCommon,
  }).strict(),
  z.object({
    type: z.literal("tool-approval-request"),
    approvalId: z.string(),
    toolCallId: z.string(),
    signature: z.string().optional(),
  }).strict(),
  z.object({
    type: z.literal("tool-output-available"),
    toolName: z.string().optional(),
    output: jsonValueSchema,
    preliminary: z.boolean().optional(),
    ...toolCommon,
  }).strict(),
  z.object({
    type: z.literal("tool-output-error"),
    toolName: z.string().optional(),
    errorText: z.string(),
    ...toolCommon,
  }).strict(),
  z.object({ type: z.literal("tool-output-denied"), toolCallId: z.string() })
    .strict(),
  z.object({
    type: z.literal("source-url"),
    sourceId: z.string(),
    url: z.string(),
    title: z.string().optional(),
    ...chunkProviderFields,
  }).strict(),
  z.object({
    type: z.literal("source-document"),
    sourceId: z.string(),
    mediaType: z.string(),
    title: z.string(),
    filename: z.string().optional(),
    ...chunkProviderFields,
  }).strict(),
  z.object({
    type: z.literal("file"),
    url: z.string(),
    mediaType: z.string(),
    ...chunkProviderFields,
  }).strict(),
  z.object({
    type: z.custom<`data-${string}`>((value) =>
      typeof value === "string" && value.startsWith("data-")
    ),
    id: z.string().optional(),
    data: jsonValueSchema,
    transient: z.boolean().optional(),
  }).strict(),
]);
export type WeaveChatChunk = z.infer<typeof weaveChatChunkSchema>;

export const threadRunPhaseSchema = z.enum(["compacting", "generating"]);
export type ThreadRunPhase = z.infer<typeof threadRunPhaseSchema>;

export const threadRunStatusSchema = z.enum([
  "running",
  "awaiting_approval",
  "cancelling",
  "completed",
  "cancelled",
  "error",
  "idle",
]);
export const threadRunStateSchema = z.object({
  active: z.boolean(),
  status: threadRunStatusSchema,
  phase: threadRunPhaseSchema.optional(),
  runId: z.string().optional(),
  startedAt: z.string().optional(),
  updatedAt: z.string().optional(),
  durationMs: z.number().nonnegative().optional(),
  error: z.string().optional(),
}).strict();
export type ThreadRunState = z.infer<typeof threadRunStateSchema>;

export const serviceScopeRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ kind: z.literal("binding"), bindingId: nonEmptyStringSchema })
    .strict(),
  z.object({
    kind: z.literal("resource"),
    resourceType: nonEmptyStringSchema,
    resourceId: nonEmptyStringSchema,
  }).strict(),
  z.object({
    kind: z.literal("locator"),
    locatorType: nonEmptyStringSchema,
    value: jsonValueSchema,
  }).strict(),
]);
export const serviceScopeSchema = z.object({ ref: serviceScopeRefSchema })
  .strict();
export type ServiceScope = z.infer<typeof serviceScopeSchema>;
export const serviceGrantSchema = z.object({
  service: z.enum(["agent", "tool", "session", "resource", "event"]),
  operation: z.string().optional(),
  scope: serviceScopeSchema.optional(),
}).strict();

export const workflowTransitionMapSchema = z.object({
  success: nonEmptyStringSchema.optional(),
  failure: nonEmptyStringSchema.optional(),
}).strict();
export type WorkflowTransitionMap = z.infer<
  typeof workflowTransitionMapSchema
>;
const workflowAgentMemorySchema = z.object({
  scope: z.enum(["thread", "workflow", "none"]),
  threadId: z.string().optional(),
  workflowRunId: z.string().optional(),
}).strict();
const workflowAgentScopeSchema = z.object({
  projectId: z.string().optional(),
  workspaceId: z.string().optional(),
}).strict();
const workflowResourceStateSchema = z.discriminatedUnion("action", [
  z.object({
    type: z.literal("resource"),
    action: z.literal("getAttachment"),
    attachmentId: jsonValueSchema,
    on: workflowTransitionMapSchema,
  }).strict(),
  z.object({
    type: z.literal("resource"),
    action: z.literal("findAttachmentsByThread"),
    threadId: jsonValueSchema,
    on: workflowTransitionMapSchema,
  }).strict(),
  z.object({
    type: z.literal("resource"),
    action: z.literal("findAttachmentsByOriginalName"),
    originalName: jsonValueSchema,
    mimeType: jsonValueSchema.optional(),
    on: workflowTransitionMapSchema,
  }).strict(),
  z.object({
    type: z.literal("resource"),
    action: z.literal("deleteAttachment"),
    attachmentId: jsonValueSchema,
    on: workflowTransitionMapSchema,
  }).strict(),
]);
export const workflowStateSchema = z.union([
  z.object({
    type: z.literal("agent"),
    agentId: z.string().optional(),
    input: jsonValueSchema,
    model: z.string().optional(),
    maxSteps: z.number().int().positive().optional(),
    memory: workflowAgentMemorySchema.optional(),
    scope: workflowAgentScopeSchema.optional(),
    on: workflowTransitionMapSchema,
  }).strict(),
  z.object({
    type: z.literal("tool"),
    toolId: nonEmptyStringSchema,
    scope: serviceScopeSchema.optional(),
    input: jsonValueSchema.optional(),
    timeoutMs: z.number().int().positive().optional(),
    on: workflowTransitionMapSchema,
  }).strict(),
  z.object({
    type: z.literal("notify"),
    input: jsonValueSchema,
    on: workflowTransitionMapSchema,
  }).strict(),
  workflowResourceStateSchema,
  z.object({
    type: z.literal("condition"),
    cases: z.array(
      z.object({
        ref: nonEmptyStringSchema,
        equals: jsonValueSchema,
        to: nonEmptyStringSchema,
      }).strict(),
    ),
    default: nonEmptyStringSchema,
  }).strict(),
  z.object({
    type: z.literal("end"),
    result: jsonValueSchema.optional(),
  }).strict(),
]);
export type WorkflowState = z.infer<typeof workflowStateSchema>;
export type WorkflowAgentState = Extract<WorkflowState, { type: "agent" }>;
export type WorkflowToolState = Extract<WorkflowState, { type: "tool" }>;
export type WorkflowNotifyState = Extract<WorkflowState, { type: "notify" }>;
export type WorkflowResourceState = Extract<
  WorkflowState,
  { type: "resource" }
>;
export type WorkflowConditionState = Extract<
  WorkflowState,
  { type: "condition" }
>;
export type WorkflowConditionCase = WorkflowConditionState["cases"][number];
export type WorkflowEndState = Extract<WorkflowState, { type: "end" }>;

export const workflowDefinitionSchema = z.object({
  id: nonEmptyStringSchema,
  version: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
  initialStateId: nonEmptyStringSchema,
  states: z.record(z.string(), workflowStateSchema),
  grants: z.array(serviceGrantSchema),
}).strict();
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;

export const storedWorkflowDefinitionSchema = z.object({
  ownerId: nonEmptyStringSchema,
  workflowId: nonEmptyStringSchema,
  version: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  definition: workflowDefinitionSchema,
}).strict();
export type StoredWorkflowDefinition = z.infer<
  typeof storedWorkflowDefinitionSchema
>;

export const workflowRunSchema = z.object({
  ownerId: nonEmptyStringSchema,
  runId: nonEmptyStringSchema,
  workflowId: nonEmptyStringSchema,
  workflowVersion: nonEmptyStringSchema,
  status: z.enum(["running", "completed", "failed", "cancelled"]),
  backend: z.enum(["pending", "direct", "dbos"]),
  externalRunId: z.string().optional(),
  requestId: z.string().optional(),
  input: jsonValueSchema,
  output: jsonValueSchema.optional(),
  error: jsonValueSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
}).strict();
export type WorkflowRun = z.infer<typeof workflowRunSchema>;

export const workflowRunEventSchema = z.object({
  ownerId: nonEmptyStringSchema,
  runId: nonEmptyStringSchema,
  eventId: nonEmptyStringSchema,
  sequence: z.number().int().nonnegative(),
  type: nonEmptyStringSchema,
  data: jsonValueSchema,
  createdAt: z.string(),
}).strict();
export type WorkflowRunEvent = z.infer<typeof workflowRunEventSchema>;

export const workspaceGitStateSchema = z.object({
  projectId: z.string(),
  workspaceId: z.string(),
  path: z.string().optional(),
  status: workspaceSchema.shape.status,
  branch: z.string().optional(),
  head: z.string().optional(),
  upstream: z.string().optional(),
  ahead: z.number().int().nonnegative().optional(),
  behind: z.number().int().nonnegative().optional(),
  detached: z.boolean().optional(),
  checkedAt: z.string(),
  lastError: z.string().optional(),
}).strict();
export type WorkspaceGitState = z.infer<typeof workspaceGitStateSchema>;

export const branchOptionSchema = z.object({
  name: z.string(),
  ref: z.string(),
  kind: z.enum(["local", "remote"]),
  current: z.boolean().optional(),
}).strict();
export type BranchOption = z.infer<typeof branchOptionSchema>;

export const workspaceFileTargetSchema = portalTargetSchema.extend({
  projectId: nonEmptyStringSchema,
  workspaceId: nonEmptyStringSchema,
}).strict();
export type WorkspaceFileTarget = z.infer<typeof workspaceFileTargetSchema>;

export const workspaceFileEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  type: z.enum(["directory", "file", "other"]),
  hidden: z.boolean().optional(),
  size: z.number().nonnegative().optional(),
  mtimeMs: z.number().optional(),
}).strict();
export type WorkspaceFileEntry = z.infer<typeof workspaceFileEntrySchema>;
export const workspaceFileListResultSchema = z.object({
  path: z.string(),
  entries: z.array(workspaceFileEntrySchema),
}).strict();
export type WorkspaceFileListResult = z.infer<
  typeof workspaceFileListResultSchema
>;
const workspaceFileReadMetadata = {
  path: z.string(),
  version: z.string(),
  size: z.number().nonnegative().optional(),
  mtimeMs: z.number().optional(),
};
export const workspaceFileReadResultSchema = z.union([
  z.object({
    ...workspaceFileReadMetadata,
    content: z.string(),
    contentTransfer: z.undefined().optional(),
  }).strict(),
  z.object({
    ...workspaceFileReadMetadata,
    content: z.undefined().optional(),
    contentTransfer: z.lazy(() => binaryTransferDescriptorSchema),
  }).strict(),
]);
export type WorkspaceFileReadResult = z.infer<
  typeof workspaceFileReadResultSchema
>;
export const workspaceFileHashResultSchema = z.object({
  path: z.string(),
  contentHash: z.string(),
  version: z.string(),
  size: z.number().nonnegative().optional(),
  mtimeMs: z.number().optional(),
  lineCount: z.number().int().nonnegative().optional(),
}).strict();
export type WorkspaceFileHashResult = z.infer<
  typeof workspaceFileHashResultSchema
>;
export const workspaceFileDiffPreviewResultSchema = z.object({
  path: z.string(),
  currentHash: z.string(),
  proposedHash: z.string(),
  currentContent: z.string(),
  proposedContent: z.string(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  version: z.string(),
  size: z.number().nonnegative().optional(),
  mtimeMs: z.number().optional(),
}).strict();
export type WorkspaceFileDiffPreviewResult = z.infer<
  typeof workspaceFileDiffPreviewResultSchema
>;
export const workspaceFileWriteResultSchema = z.object({
  path: z.string(),
  version: z.string(),
  size: z.number().nonnegative().optional(),
  mtimeMs: z.number().optional(),
}).strict();
export type WorkspaceFileWriteResult = z.infer<
  typeof workspaceFileWriteResultSchema
>;
export const fileOperationResultSchema = z.object({
  ok: z.literal(true),
  path: z.string().optional(),
  version: z.string().optional(),
}).strict();
export type FileOperationResult = z.infer<typeof fileOperationResultSchema>;
export const workspaceFileWatchEventSchema = z.object({
  kind: z.enum([
    "any",
    "access",
    "create",
    "modify",
    "rename",
    "remove",
    "other",
  ]),
  paths: z.array(z.string()),
  affectedDirectories: z.array(z.string()),
  rescan: z.boolean().optional(),
}).strict();
export type WorkspaceFileWatchEvent = z.infer<
  typeof workspaceFileWatchEventSchema
>;

export const workspaceFileWatchHostEventSchema = z.union([
  z.object({
    type: z.literal("workspace-file.watch.ready"),
    requestId: z.string().optional(),
    paths: z.array(z.string()),
  }).strict(),
  z.object({
    type: z.literal("workspace-file.watch.change"),
    event: workspaceFileWatchEventSchema,
  }).strict(),
  z.object({
    type: z.literal("workspace-file.watch.error"),
    requestId: z.string().optional(),
    error: z.string(),
  }).strict(),
]);
export type WorkspaceFileWatchHostEvent = z.infer<
  typeof workspaceFileWatchHostEventSchema
>;

export const workspaceFileWatchClientMessageSchema = z.union([
  z.object({
    type: z.literal("watch.start"),
    requestId: z.string().optional(),
    target: workspaceFileTargetSchema,
    paths: z.array(z.string()),
  }).strict(),
  z.object({
    type: z.literal("watch.update"),
    requestId: z.string().optional(),
    paths: z.array(z.string()),
  }).strict(),
  z.object({ type: z.literal("watch.stop"), requestId: z.string().optional() })
    .strict(),
]);
export type WorkspaceFileWatchClientMessage = z.infer<
  typeof workspaceFileWatchClientMessageSchema
>;

export const editorModeSchema = z.enum(["code", "notes"]);
export type EditorMode = z.infer<typeof editorModeSchema>;
export const liveEditorContextRequestSchema = z.object({
  mode: editorModeSchema.optional(),
  projectId: z.string().optional(),
  workspaceId: z.string().optional(),
}).strict();
export type LiveEditorContextRequest = z.infer<
  typeof liveEditorContextRequestSchema
>;
export const liveEditorContextTabSchema = z.object({
  active: z.boolean(),
  dirty: z.boolean(),
  loaded: z.boolean(),
  path: z.string(),
  preview: z.boolean(),
}).strict();
export type LiveEditorContextTab = z.infer<typeof liveEditorContextTabSchema>;
export const liveEditorTextRangeSchema = z.object({
  from: z.number().int().nonnegative(),
  to: z.number().int().nonnegative(),
  fromLine: z.number().int().nonnegative(),
  toLine: z.number().int().nonnegative(),
  text: z.string(),
  textTruncated: z.boolean().optional(),
}).strict();
export type LiveEditorTextRange = z.infer<typeof liveEditorTextRangeSchema>;
export const liveEditorCodeMirrorSnapshotSchema = z.object({
  selection: liveEditorTextRangeSchema.optional(),
  visibleRange: liveEditorTextRangeSchema.optional(),
}).strict();
export type LiveEditorCodeMirrorSnapshot = z.infer<
  typeof liveEditorCodeMirrorSnapshotSchema
>;
export const liveEditorCoppermindSectionPlacementSchema = z.union([
  z.object({ state: z.literal("unplaced") }).strict(),
  z.object({
    state: z.literal("placed"),
    xywh: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  }).strict(),
]);
export type LiveEditorCoppermindSectionPlacement = z.infer<
  typeof liveEditorCoppermindSectionPlacementSchema
>;
export const liveEditorCoppermindSectionSchema = z.object({
  childCount: z.number().int().nonnegative(),
  empty: z.boolean(),
  id: z.string(),
  kind: z.enum(["blocks", "ink", "code"]),
  placement: liveEditorCoppermindSectionPlacementSchema,
  preview: z.string().optional(),
  previewTruncated: z.boolean().optional(),
  title: z.string(),
}).strict();
export type LiveEditorCoppermindSection = z.infer<
  typeof liveEditorCoppermindSectionSchema
>;
export const liveEditorCoppermindSnapshotSchema = z.object({
  activeSectionId: z.string().optional(),
  canvasSelection: z.object({
    editing: z.boolean(),
    selectedIds: z.array(z.string()),
  }).strict().optional(),
  mode: z.enum(["page", "edgeless"]),
  sections: z.array(liveEditorCoppermindSectionSchema),
  viewport: z.object({
    center: z.tuple([z.number(), z.number()]).optional(),
    zoom: z.number().optional(),
  }).strict().optional(),
}).strict();
export type LiveEditorCoppermindSnapshot = z.infer<
  typeof liveEditorCoppermindSnapshotSchema
>;
export const liveEditorActiveBufferSchema = z.object({
  codeMirror: liveEditorCodeMirrorSnapshotSchema.optional(),
  contentHash: z.string(),
  coppermind: liveEditorCoppermindSnapshotSchema.optional(),
  dirty: z.boolean(),
  documentKind: z.string().optional(),
  mediaType: z.string().optional(),
  path: z.string(),
  size: z.number().nonnegative().optional(),
  version: z.string().optional(),
}).strict();
export type LiveEditorActiveBuffer = z.infer<
  typeof liveEditorActiveBufferSchema
>;
export const liveEditorContextSnapshotSchema = z.object({
  activePath: z.string().optional(),
  activeTabId: z.string().optional(),
  activeBuffer: liveEditorActiveBufferSchema.optional(),
  mode: editorModeSchema,
  openTabs: z.array(liveEditorContextTabSchema),
  projectId: z.string(),
  projectName: z.string(),
  targetKey: z.string(),
  updatedAt: z.string(),
  workspaceId: z.string(),
  workspaceName: z.string(),
}).strict();
export type LiveEditorContextSnapshot = z.infer<
  typeof liveEditorContextSnapshotSchema
>;
export const liveEditorContextResultSchema = z.union([
  z.object({ ok: z.literal(true), context: liveEditorContextSnapshotSchema })
    .strict(),
  z.object({
    ok: z.literal(false),
    reason: z.enum(["no_context", "client_error"]),
    error: z.string(),
  }).strict(),
]);
export type LiveEditorContextResult = z.infer<
  typeof liveEditorContextResultSchema
>;

export const terminalSessionKindSchema = z.enum(["workspace", "general"]);
export type TerminalSessionKind = z.infer<typeof terminalSessionKindSchema>;
export const terminalTargetSchema = portalTargetSchema.extend({
  kind: terminalSessionKindSchema.optional(),
  terminalId: z.string().optional(),
  cwd: z.string().optional(),
  cols: z.number().int().optional(),
  rows: z.number().int().optional(),
}).strict();
const terminalMessageTargetShape = {
  kind: terminalSessionKindSchema,
  terminalId: z.string().optional(),
  projectId: z.string().optional(),
  workspaceId: z.string().optional(),
  portalId: z.string().optional(),
  rootId: z.string().optional(),
  repoPath: z.string().optional(),
  workspacePath: z.string().optional(),
  cwd: z.string().optional(),
  cols: z.number().int().optional(),
  rows: z.number().int().optional(),
};
export const terminalClientMessageSchema = z.union([
  z.object({ type: z.literal("snapshot"), requestId: z.string().optional() })
    .strict(),
  z.object({
    type: z.literal("list"),
    requestId: z.string().optional(),
    ...terminalMessageTargetShape,
  }).strict(),
  z.object({
    type: z.literal("create"),
    requestId: z.string().optional(),
    ...terminalMessageTargetShape,
  }).strict(),
  z.object({
    type: z.literal("start"),
    ...terminalMessageTargetShape,
    terminalId: z.string(),
  }).strict(),
  z.object({
    type: z.literal("input"),
    terminalId: z.string(),
    data: z.string(),
  }).strict(),
  z.object({
    type: z.literal("resize"),
    terminalId: z.string(),
    cols: z.number().int().positive(),
    rows: z.number().int().positive(),
  }).strict(),
  z.object({ type: z.literal("close"), terminalId: z.string() }).strict(),
  z.object({ type: z.literal("detach"), terminalId: z.string() }).strict(),
]);
export type TerminalClientMessage = z.infer<typeof terminalClientMessageSchema>;
export const terminalWindowRecordSchema = z.object({
  terminalId: z.string(),
  scopeId: z.string(),
  slot: z.number().int(),
  kind: terminalSessionKindSchema,
  cwd: z.string(),
  title: z.string(),
  processName: z.string().optional(),
  portalId: z.string().optional(),
  rootId: z.string().optional(),
  projectId: z.string().optional(),
  workspaceId: z.string().optional(),
}).strict();
export type TerminalWindowRecord = z.infer<typeof terminalWindowRecordSchema>;
export const terminalHostEventSchema = z.union([
  z.object({
    type: z.literal("started"),
    terminalId: z.string(),
    workspaceId: z.string().optional(),
    sessionId: z.string(),
    cwd: z.string(),
    pid: z.number().int().optional(),
    cols: z.number().int(),
    rows: z.number().int(),
  }).strict(),
  z.object({
    type: z.literal("windows"),
    requestId: z.string().optional(),
    windows: z.array(terminalWindowRecordSchema),
  }).strict(),
  z.object({
    type: z.literal("created"),
    requestId: z.string().optional(),
    terminalId: z.string(),
    workspaceId: z.string().optional(),
    window: terminalWindowRecordSchema,
  }).strict(),
  z.object({
    type: z.literal("output"),
    terminalId: z.string(),
    workspaceId: z.string().optional(),
    data: z.string(),
  }).strict(),
  z.object({
    type: z.literal("replay"),
    terminalId: z.string(),
    workspaceId: z.string().optional(),
    data: z.string(),
  }).strict(),
  z.object({
    type: z.literal("title"),
    terminalId: z.string(),
    workspaceId: z.string().optional(),
    title: z.string(),
  }).strict(),
  z.object({
    type: z.literal("exit"),
    terminalId: z.string(),
    workspaceId: z.string().optional(),
    exitCode: z.number().int().optional(),
    signal: z.union([z.number(), z.string()]).optional(),
  }).strict(),
  z.object({
    type: z.literal("error"),
    requestId: z.string().optional(),
    terminalId: z.string(),
    workspaceId: z.string().optional(),
    error: z.string(),
  }).strict(),
]);
export type TerminalHostEvent = z.infer<typeof terminalHostEventSchema>;

export const lspSessionResultSchema = z.object({
  ok: z.literal(true),
  sessionId: z.string(),
  status: z.enum(["ready", "missing", "disabled", "unsupported", "error"]),
  serverId: z.string().optional(),
  languageId: z.string().optional(),
  documentUri: z.string().optional(),
  rootUri: z.string().optional(),
  rootPath: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  capabilities: jsonValueSchema.optional(),
  error: z.string().optional(),
}).strict();
export type LspSessionResult = z.infer<typeof lspSessionResultSchema>;
export const lspHostEventSchema = z.union([
  lspSessionResultSchema.extend({ type: z.literal("ready") }),
  z.object({
    type: z.literal("jsonrpc"),
    sessionId: z.string(),
    message: z.string(),
  }).strict(),
  z.object({
    type: z.literal("error"),
    sessionId: z.string().optional(),
    error: z.string(),
  }).strict(),
]);
export type LspHostEvent = z.infer<typeof lspHostEventSchema>;
export const lspClientMessageSchema = z.union([
  z.object({
    type: z.literal("start"),
    sessionId: z.string(),
    target: workspaceFileTargetSchema,
    path: z.string(),
    languageId: z.string().optional(),
    serverId: z.string().optional(),
  }).strict(),
  z.object({
    type: z.literal("jsonrpc"),
    sessionId: z.string(),
    message: z.string(),
  }).strict(),
  z.object({ type: z.literal("detach"), sessionId: z.string() }).strict(),
]);
export type LspClientMessage = z.infer<typeof lspClientMessageSchema>;

export const jupyterStatusResultSchema = z.object({
  ok: z.literal(true),
  available: z.boolean(),
  status: z.enum(["ready", "missing", "error"]),
  command: z.string().optional(),
  rootPath: z.string().optional(),
  url: z.string().optional(),
  uvAvailable: z.boolean().optional(),
  uvCommand: z.string().optional(),
  workspaceKernelName: z.string().optional(),
  venvPath: z.string().optional(),
  pythonPath: z.string().optional(),
  error: z.string().optional(),
}).strict();
export type JupyterStatusResult = z.infer<typeof jupyterStatusResultSchema>;
export const jupyterKernelSpecSchema = z.object({
  name: z.string(),
  displayName: z.string(),
  language: z.string().optional(),
  argv: z.array(z.string()).optional(),
}).strict();
export type JupyterKernelSpec = z.infer<typeof jupyterKernelSpecSchema>;
export const jupyterKernelspecsResultSchema = z.object({
  ok: z.literal(true),
  available: z.boolean(),
  defaultKernelName: z.string().optional(),
  kernelspecs: z.array(jupyterKernelSpecSchema),
  error: z.string().optional(),
}).strict();
export type JupyterKernelspecsResult = z.infer<
  typeof jupyterKernelspecsResultSchema
>;
export const jupyterSessionResultSchema = z.object({
  ok: z.literal(true),
  available: z.boolean(),
  sessionId: z.string(),
  kernelId: z.string(),
  kernelName: z.string(),
  rootPath: z.string(),
  path: z.string(),
  venvPath: z.string().optional(),
  pythonPath: z.string().optional(),
  portalId: z.string().optional(),
}).strict();
export type JupyterSessionResult = z.infer<typeof jupyterSessionResultSchema>;
export const jupyterOutputSchema = z.union([
  z.object({
    output_type: z.literal("stream"),
    name: z.string(),
    text: z.string(),
  }).strict(),
  z.object({
    output_type: z.literal("display_data"),
    data: jsonObjectSchema,
    metadata: jsonObjectSchema.optional(),
    transient: jsonObjectSchema.optional(),
  }).strict(),
  z.object({
    output_type: z.literal("execute_result"),
    execution_count: z.number().int().nullable().optional(),
    data: jsonObjectSchema,
    metadata: jsonObjectSchema.optional(),
  }).strict(),
  z.object({
    output_type: z.literal("error"),
    ename: z.string(),
    evalue: z.string(),
    traceback: z.array(z.string()),
  }).strict(),
]);
export type JupyterOutput = z.infer<typeof jupyterOutputSchema>;
const jupyterEventIds = {
  sessionId: z.string(),
  requestId: z.string().optional(),
  cellId: z.string().optional(),
};
export const jupyterHostEventSchema = z.union([
  z.object({
    type: z.literal("ready"),
    sessionId: z.string(),
    kernelId: z.string(),
    kernelName: z.string(),
  }).strict(),
  z.object({
    ...jupyterEventIds,
    type: z.literal("status"),
    executionState: z.string(),
  }).strict(),
  z.object({
    ...jupyterEventIds,
    type: z.literal("execution_input"),
    executionCount: z.number().int(),
  }).strict(),
  z.object({
    ...jupyterEventIds,
    type: z.literal("output"),
    output: jupyterOutputSchema,
  }).strict(),
  z.object({
    ...jupyterEventIds,
    type: z.literal("clear_output"),
    wait: z.boolean(),
  }).strict(),
  z.object({
    ...jupyterEventIds,
    type: z.literal("complete"),
    status: z.enum(["ok", "error", "interrupted"]),
    executionCount: z.number().int().nullable().optional(),
  }).strict(),
  z.object({
    type: z.literal("error"),
    sessionId: z.string().optional(),
    requestId: z.string().optional(),
    cellId: z.string().optional(),
    error: z.string(),
  }).strict(),
]);
export type JupyterHostEvent = z.infer<typeof jupyterHostEventSchema>;
export const jupyterClientMessageSchema = z.union([
  z.object({
    type: z.literal("execute"),
    sessionId: z.string(),
    requestId: z.string().optional(),
    cellId: z.string().optional(),
    code: z.string(),
    silent: z.boolean().optional(),
    storeHistory: z.boolean().optional(),
    allowStdin: z.boolean().optional(),
  }).strict(),
  z.object({ type: z.literal("detach"), sessionId: z.string() }).strict(),
]);
export type JupyterClientMessage = z.infer<typeof jupyterClientMessageSchema>;

export const binaryTransferDescriptorSchema = z.object({
  transferId: nonEmptyStringSchema,
  direction: z.enum(["upload", "download"]),
  purpose: nonEmptyStringSchema,
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i),
  mimeType: nonEmptyStringSchema.optional(),
  chunkBytes: z.number().int().positive(),
  windowSize: z.number().int().positive(),
  metadata: jsonObjectSchema.optional(),
}).strict();
export type BinaryTransferDescriptor = z.infer<
  typeof binaryTransferDescriptorSchema
>;

export const branchCleanupSchema = z.object({
  requested: z.boolean(),
  status: z.enum([
    "not_requested",
    "not_applicable",
    "not_pushed",
    "not_merged",
    "deleted",
    "failed",
  ]),
  eligible: z.boolean().optional(),
  branch: z.string().optional(),
  targetRef: z.string().optional(),
  targetKind: z.enum(["upstream", "same_name_remote", "default_branch"])
    .optional(),
  error: z.string().optional(),
}).strict();
export type BranchCleanup = z.infer<typeof branchCleanupSchema>;
export const removedWorkspaceSnapshotSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  path: z.string().optional(),
  branch: z.string().optional(),
  removedAt: z.string(),
}).strict();
export type RemovedWorkspaceSnapshot = z.infer<
  typeof removedWorkspaceSnapshotSchema
>;
export const workspaceRemovalPreviewSchema = z.object({
  workspace: workspaceSchema,
  activeThreadCount: z.number().int().nonnegative(),
  archivedThreadCount: z.number().int().nonnegative(),
  branchCleanup: branchCleanupSchema,
}).strict();
export type WorkspaceRemovalPreview = z.infer<
  typeof workspaceRemovalPreviewSchema
>;
export const deleteWorkspaceResultSchema = workspaceRemovalPreviewSchema.extend(
  {
    project: projectSchema,
    mode: z.enum(["detach", "remove"]),
    force: z.boolean().optional(),
    removedWorkspace: removedWorkspaceSnapshotSchema.optional(),
  },
).strict();
export type DeleteWorkspaceResult = z.infer<typeof deleteWorkspaceResultSchema>;
export const discoveredWorktreeSchema = z.object({
  path: z.string().optional(),
  branch: z.string().optional(),
  commit: z.string().optional(),
  head: z.string().optional(),
  detached: z.boolean().optional(),
  adopted: z.boolean().optional(),
  workspaceId: z.string().optional(),
}).strict();
export type DiscoveredWorktree = z.infer<typeof discoveredWorktreeSchema>;
