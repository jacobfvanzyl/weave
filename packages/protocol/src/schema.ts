import { z } from 'zod';

export const WEAVE_RPC_PROTOCOL_VERSION = 1 as const;
export const WEAVE_RPC_PATH = '/rpc' as const;
export const WEAVE_RPC_MAX_FRAME_BYTES = 1024 * 1024;
export const WEAVE_RPC_BINARY_CHUNK_BYTES = 256 * 1024;
export const WEAVE_RPC_BINARY_WINDOW_SIZE = 8;

export const rpcCloseCode = {
  invalidMessage: 4400,
  unauthenticated: 4401,
  incompatibleProtocol: 4406,
  handshakeTimeout: 4408,
  superseded: 4409,
  overload: 4429,
} as const;

export const jsonRpcIdSchema = z.union([z.string(), z.number()]);
export type JsonRpcId = z.infer<typeof jsonRpcIdSchema>;
export const jsonRpcResponseIdSchema = z.union([jsonRpcIdSchema, z.null()]);

export const jsonRpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: jsonRpcIdSchema,
  method: z.string().min(1),
  params: z.unknown().optional(),
}).strict();

export const jsonRpcNotificationSchema = z.object({
  jsonrpc: z.literal('2.0'),
  method: z.string().min(1),
  params: z.unknown().optional(),
}).strict();

export const jsonRpcErrorObjectSchema = z.object({
  code: z.number().int(),
  message: z.string(),
  data: z.unknown().optional(),
}).strict();

export const jsonRpcSuccessResponseSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: jsonRpcResponseIdSchema,
  result: z.unknown(),
}).strict();

export const jsonRpcErrorResponseSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: jsonRpcResponseIdSchema,
  error: jsonRpcErrorObjectSchema,
}).strict();

export const jsonRpcResponseSchema = z.union([jsonRpcSuccessResponseSchema, jsonRpcErrorResponseSchema]);
export const jsonRpcMessageSchema = z.union([
  jsonRpcRequestSchema,
  jsonRpcNotificationSchema,
  jsonRpcResponseSchema,
]);

export type JsonRpcRequest = z.infer<typeof jsonRpcRequestSchema>;
export type JsonRpcNotification = z.infer<typeof jsonRpcNotificationSchema>;
export type JsonRpcErrorObject = z.infer<typeof jsonRpcErrorObjectSchema>;
export type JsonRpcResponse = z.infer<typeof jsonRpcResponseSchema>;
export type JsonRpcMessage = z.infer<typeof jsonRpcMessageSchema>;

export const rpcClientMetadataSchema = z.object({
  clientAppId: z.string().min(1),
  clientInstanceId: z.string().min(1),
  name: z.string().min(1).optional(),
  version: z.string().min(1).optional(),
  surfaceId: z.string().min(1).optional(),
  active: z.boolean().optional(),
  projectId: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
  workspaceId: z.string().min(1).optional(),
}).strict();

export const rpcInitializeParamsSchema = z.discriminatedUnion('role', [
  z.object({
    protocolVersion: z.literal(WEAVE_RPC_PROTOCOL_VERSION),
    role: z.literal('client'),
    token: z.string().min(1),
    capabilities: z.array(z.string()).default([]),
    client: rpcClientMetadataSchema,
  }).strict(),
  z.object({
    protocolVersion: z.literal(WEAVE_RPC_PROTOCOL_VERSION),
    role: z.literal('portal'),
    token: z.string().min(1),
    capabilities: z.array(z.string()).default([]),
    portal: z.object({
      portalId: z.string().min(1),
      name: z.string().min(1),
      version: z.string().min(1).optional(),
      instanceId: z.string().min(1).optional(),
      mounts: z.array(z.unknown()).default([]),
      roots: z.array(z.unknown()).default([]),
    }).strict(),
  }).strict(),
]);

export type RpcInitializeParams = z.infer<typeof rpcInitializeParamsSchema>;

export const rpcInitializeResultSchema = z.object({
  protocolVersion: z.literal(WEAVE_RPC_PROTOCOL_VERSION),
  connectionId: z.string().min(1),
  role: z.enum(['client', 'portal']),
  heartbeatIntervalMs: z.number().int().positive(),
  maxFrameBytes: z.number().int().positive(),
  capabilities: z.array(z.string()),
  owner: z.object({ id: z.string(), name: z.string() }).strict().optional(),
  portal: z.object({ portalId: z.string(), name: z.string() }).strict().optional(),
}).strict();

export type RpcInitializeResult = z.infer<typeof rpcInitializeResultSchema>;

export const rpcErrorCode = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  unauthenticated: -32001,
  forbidden: -32002,
  notFound: -32004,
  conflict: -32009,
  rateLimited: -32029,
  portalUnavailable: -32050,
  resumeGap: -32060,
  applicationInternal: -32099,
} as const;

export type RpcApplicationErrorCode =
  | 'INVALID_PARAMS'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'PORTAL_UNAVAILABLE'
  | 'RESUME_GAP'
  | 'INTERNAL';

export const rpcApplicationErrorDataSchema = z.object({
  code: z.enum([
    'INVALID_PARAMS',
    'UNAUTHENTICATED',
    'FORBIDDEN',
    'NOT_FOUND',
    'CONFLICT',
    'RATE_LIMITED',
    'PORTAL_UNAVAILABLE',
    'RESUME_GAP',
    'INTERNAL',
  ]),
}).passthrough();

export const binaryTransferDescriptorSchema = z.object({
  transferId: z.string().min(1),
  direction: z.enum(['upload', 'download']),
  purpose: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i),
  mimeType: z.string().min(1).optional(),
  chunkBytes: z.literal(WEAVE_RPC_BINARY_CHUNK_BYTES).default(WEAVE_RPC_BINARY_CHUNK_BYTES),
  windowSize: z.literal(WEAVE_RPC_BINARY_WINDOW_SIZE).default(WEAVE_RPC_BINARY_WINDOW_SIZE),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const binaryChunkParamsSchema = z.object({
  transferId: z.string().min(1),
  index: z.number().int().nonnegative(),
  data: z.string(),
}).strict();

export const binaryAckParamsSchema = z.object({
  transferId: z.string().min(1),
  throughIndex: z.number().int().min(-1),
}).strict();

export const binaryCompleteParamsSchema = z.object({
  transferId: z.string().min(1),
  chunks: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i),
}).strict();

export const binaryAbortParamsSchema = z.object({
  transferId: z.string().min(1),
  reason: z.string().optional(),
}).strict();

export type BinaryTransferDescriptor = z.infer<typeof binaryTransferDescriptorSchema>;
export type BinaryChunkParams = z.infer<typeof binaryChunkParamsSchema>;
export type BinaryAckParams = z.infer<typeof binaryAckParamsSchema>;
export type BinaryCompleteParams = z.infer<typeof binaryCompleteParamsSchema>;
export type BinaryAbortParams = z.infer<typeof binaryAbortParamsSchema>;

export const rpcMethodNames = [
  'initialize',
  'connection.ping',
  'connection.pong',
  'connection.cancel',
  'binary.begin',
  'binary.chunk',
  'binary.ack',
  'binary.complete',
  'binary.abort',
  'owner.get',
  'agent.models.list',
  'agent.prompts.list',
  'agent.prompts.expand',
  'agent.tools.list',
  'agent.chatgpt.authStatus',
  'agent.chatgpt.login.start',
  'agent.chatgpt.login.complete',
  'chat.thread.list',
  'chat.thread.create',
  'chat.thread.get',
  'chat.thread.update',
  'chat.thread.delete',
  'chat.thread.reorder',
  'chat.thread.messages.list',
  'chat.thread.messages.raw',
  'chat.thread.contextUsage',
  'chat.thread.compact',
  'chat.run.start',
  'chat.run.get',
  'chat.run.subscribe',
  'chat.run.unsubscribe',
  'chat.run.approval.respond',
  'chat.run.cancel',
  'chat.run.steer',
  'chat.run.event',
  'notification.subscribe',
  'notification.unsubscribe',
  'notification.event',
  'code.project.list',
  'code.project.create',
  'code.project.get',
  'code.project.delete',
  'code.project.reorder',
  'code.project.branches.list',
  'code.project.threads.create',
  'code.project.threads.list',
  'code.workspace.gitState.list',
  'code.workspace.resolve',
  'code.workspace.discover',
  'code.workspace.create',
  'code.workspace.adopt',
  'code.workspace.update',
  'code.workspace.delete',
  'code.workspace.reorder',
  'code.workspace.git.fetch',
  'code.workspace.git.pull',
  'code.workspace.removalPreview',
  'workspaceFile.list',
  'workspaceFile.read',
  'workspaceFile.hash',
  'workspaceFile.diffPreview',
  'workspaceFile.write',
  'workspaceFile.mkdir',
  'workspaceFile.move',
  'workspaceFile.delete',
  'workspaceFile.index',
  'workspaceFile.upload',
  'workspaceFile.watch.start',
  'workspaceFile.watch.update',
  'workspaceFile.watch.stop',
  'workspaceFile.watch.event',
  'terminal.list',
  'terminal.snapshot',
  'terminal.create',
  'terminal.attach',
  'terminal.input',
  'terminal.resize',
  'terminal.close',
  'terminal.detach',
  'terminal.event',
  'lsp.session.create',
  'lsp.session.start',
  'lsp.session.send',
  'lsp.session.close',
  'lsp.event',
  'jupyter.status',
  'jupyter.kernelspecs',
  'jupyter.session.create',
  'jupyter.session.execute',
  'jupyter.session.close',
  'jupyter.event',
  'workflow.definition.list',
  'workflow.definition.create',
  'workflow.definition.get',
  'workflow.definition.update',
  'workflow.definition.delete',
  'workflow.run.start',
  'workflow.run.list',
  'workflow.run.get',
  'workflow.run.cancel',
  'workflow.run.subscribe',
  'workflow.run.unsubscribe',
  'workflow.run.event',
  'notification.test',
  'attachment.put',
  'attachment.read',
  'userArtifact.prompt.list',
  'userArtifact.prompt.get',
  'userArtifact.prompt.put',
  'userArtifact.prompt.delete',
  'userArtifact.skill.list',
  'userArtifact.skill.get',
  'userArtifact.skill.put',
  'userArtifact.skill.delete',
  'userArtifact.skill.files.list',
  'userArtifact.skill.file.get',
  'userArtifact.skill.file.put',
  'userArtifact.skill.file.delete',
  'portal.list',
  'portal.browse',
  'portal.primary.set',
  'portal.token.issue',
  'portal.status.changed',
  'portal.shutdown',
  'portal.tool.call',
  'portal.terminal.snapshot',
  'portal.terminal.list',
  'portal.terminal.create',
  'portal.terminal.attach',
  'portal.terminal.input',
  'portal.terminal.resize',
  'portal.terminal.close',
  'portal.terminal.detach',
  'portal.terminal.event',
  'portal.workspaceFile.list',
  'portal.workspaceFile.read',
  'portal.workspaceFile.hash',
  'portal.workspaceFile.diffPreview',
  'portal.workspaceFile.write',
  'portal.workspaceFile.mkdir',
  'portal.workspaceFile.move',
  'portal.workspaceFile.delete',
  'portal.workspaceFile.index',
  'portal.workspaceFile.upload',
  'portal.workspaceFile.watch.start',
  'portal.workspaceFile.watch.update',
  'portal.workspaceFile.watch.stop',
  'portal.workspaceFile.watch.event',
  'portal.lsp.start',
  'portal.lsp.send',
  'portal.lsp.close',
  'portal.lsp.event',
  'portal.jupyter.execute',
  'portal.jupyter.close',
  'portal.jupyter.event',
  'client.surface.update',
  'client.editorContext.get',
] as const;

export type RpcMethodName = typeof rpcMethodNames[number];
export const rpcMethodNameSchema = z.enum(rpcMethodNames);
