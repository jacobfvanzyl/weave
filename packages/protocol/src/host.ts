import { z } from "zod";

export const WEAVE_HOST_RPC_PROTOCOL_VERSION = 1 as const;
export const WEAVE_HOST_RPC_PATH = "/rpc" as const;
export const WEAVE_HOST_ACP_PATH = "/acp" as const;

export const hostWorkspaceSummarySchema = z.object({
  workspaceId: z.string().min(1),
  name: z.string().min(1),
}).strict();
export type HostWorkspaceSummary = z.infer<typeof hostWorkspaceSummarySchema>;

export const hostAgentSummarySchema = z.object({
  agentId: z.string().min(1),
  name: z.string().min(1),
}).strict();
export type HostAgentSummary = z.infer<typeof hostAgentSummarySchema>;

export const hostThreadSummarySchema = z.object({
  threadId: z.string().min(1),
  agentId: z.string().min(1),
  workspaceId: z.string().min(1),
  acpSessionId: z.string().min(1),
  title: z.string().min(1).optional(),
  status: z.enum(["active", "closed"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  lastEventSequence: z.number().int().nonnegative(),
}).strict();
export type HostThreadSummary = z.infer<typeof hostThreadSummarySchema>;

const emptyParamsSchema = z.object({}).strict().optional();
const threadParamsSchema = z.object({ threadId: z.string().min(1) }).strict();

export const hostRpcContracts = {
  "host.capabilities.get": {
    params: emptyParamsSchema,
    result: z.object({
      protocolVersion: z.literal(WEAVE_HOST_RPC_PROTOCOL_VERSION),
      capabilities: z.array(z.string().min(1)),
    }).strict(),
  },
  "workspace.list": {
    params: emptyParamsSchema,
    result: z.object({ workspaces: z.array(hostWorkspaceSummarySchema) })
      .strict(),
  },
  "agent.list": {
    params: emptyParamsSchema,
    result: z.object({ agents: z.array(hostAgentSummarySchema) }).strict(),
  },
  "thread.list": {
    params: emptyParamsSchema,
    result: z.object({ threads: z.array(hostThreadSummarySchema) }).strict(),
  },
  "thread.get": {
    params: threadParamsSchema,
    result: z.object({ thread: hostThreadSummarySchema.nullable() }).strict(),
  },
  "thread.attach": {
    params: threadParamsSchema,
    result: z.object({
      thread: hostThreadSummarySchema,
      connection: z.object({
        path: z.literal(WEAVE_HOST_ACP_PATH),
        threadId: z.string().min(1),
        cwd: z.string().min(1),
      }).strict(),
    }).strict(),
  },
} as const;

export type HostRpcMethod = keyof typeof hostRpcContracts;
export const hostRpcMethods = Object.freeze(
  Object.keys(hostRpcContracts) as HostRpcMethod[],
);

export type HostRpcParams<Method extends HostRpcMethod> = z.input<
  (typeof hostRpcContracts)[Method]["params"]
>;
export type HostRpcResult<Method extends HostRpcMethod> = z.output<
  (typeof hostRpcContracts)[Method]["result"]
>;

export const parseHostRpcParams = <Method extends HostRpcMethod>(
  method: Method,
  value: unknown,
) => hostRpcContracts[method].params.parse(value) as HostRpcParams<Method>;

export const parseHostRpcResult = <Method extends HostRpcMethod>(
  method: Method,
  value: unknown,
) => hostRpcContracts[method].result.parse(value) as HostRpcResult<Method>;
