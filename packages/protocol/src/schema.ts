import { z } from "zod";
import { jsonValueSchema } from "./v2/primitives.ts";

export * from "./v2/primitives.ts";
export * from "./v2/dtos.ts";
export * from "./v2/contracts.ts";
export * from "./v2/desktop.ts";

export const jsonRpcIdSchema = z.union([z.string(), z.number()]);
export type JsonRpcId = z.infer<typeof jsonRpcIdSchema>;
export const jsonRpcResponseIdSchema = z.union([jsonRpcIdSchema, z.null()]);

export const jsonRpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: jsonRpcIdSchema,
  method: z.string().min(1),
  params: z.unknown().optional(),
}).strict();

export const jsonRpcNotificationSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.string().min(1),
  params: z.unknown().optional(),
}).strict();

export const jsonRpcErrorObjectSchema = z.object({
  code: z.number().int(),
  message: z.string(),
  data: jsonValueSchema.optional(),
}).strict();

export const jsonRpcSuccessResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: jsonRpcResponseIdSchema,
  result: z.unknown(),
}).strict();

export const jsonRpcErrorResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: jsonRpcResponseIdSchema,
  error: jsonRpcErrorObjectSchema,
}).strict();

export const jsonRpcResponseSchema = z.union([
  jsonRpcSuccessResponseSchema,
  jsonRpcErrorResponseSchema,
]);
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
  | "INVALID_PARAMS"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "PORTAL_UNAVAILABLE"
  | "RESUME_GAP"
  | "INTERNAL";

export const rpcApplicationErrorDataSchema = z.object({
  code: z.enum([
    "INVALID_PARAMS",
    "UNAUTHENTICATED",
    "FORBIDDEN",
    "NOT_FOUND",
    "CONFLICT",
    "RATE_LIMITED",
    "PORTAL_UNAVAILABLE",
    "RESUME_GAP",
    "INTERNAL",
  ]),
}).catchall(jsonValueSchema);

export const threadCompactionEventDataSchema = z.object({
  phase: z.enum(["started", "completed", "rejected", "failed", "cancelled"]),
  compactionId: z.string().min(1),
  origin: z.enum(["pre_run", "mid_run", "manual"]),
  trigger: z.enum(["automatic", "manual"]),
  generation: z.number().int().positive(),
  mode: z.enum(["incremental", "rebuild"]),
  reason: z.string().optional(),
  tokensBefore: z.number().int().nonnegative().optional(),
  tokensAfter: z.number().int().nonnegative().optional(),
  reclaimedTokens: z.number().int().optional(),
  headroomTokens: z.number().int().optional(),
}).strict();
export type ThreadCompactionEventData = z.infer<
  typeof threadCompactionEventDataSchema
>;
