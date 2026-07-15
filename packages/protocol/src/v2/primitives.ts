import { z } from "zod";

export const WEAVE_RPC_PROTOCOL_VERSION = 2 as const;
export const WEAVE_RPC_PATH = "/rpc" as const;
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

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ])
);

export const jsonObjectSchema = z.record(z.string(), jsonValueSchema);
export type JsonObject = z.infer<typeof jsonObjectSchema>;

export const nonEmptyStringSchema = z.string().min(1);
export const optionalNonEmptyStringSchema = nonEmptyStringSchema.optional();
export const emptyObjectSchema = z.object({}).strict();
export const okResultSchema = z.object({ ok: z.literal(true) }).strict();
export const nullableOkResultSchema = z.union([okResultSchema, z.null()]);

export const rpcRoleSchema = z.enum(["client", "server", "portal"]);
export type RpcRole = z.infer<typeof rpcRoleSchema>;
