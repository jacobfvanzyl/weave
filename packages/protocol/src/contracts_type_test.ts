import {
  type DesktopRpcRequestEnvelope,
  type PortalToolArgs,
  type PortalToolResult,
  RpcConnection,
  type RpcConnectionHandler,
  type RpcRequestResult,
} from "./index.ts";

const compileOnly = () => {
  const client = null as unknown as RpcConnection<"client">;
  const portal = null as unknown as RpcConnection<"portal">;

  void client.request("owner.get");
  void client.request("chat.thread.get", { threadId: "thread-1" });
  void client.request("chat.thread.create", {
    threadId: "thread-1",
    projectId: "project-1",
    workspaceId: "workspace-1",
  });
  void client.request("workflow.definition.create", {
    definition: {
      id: "workflow-1",
      version: "1",
      name: "Workflow",
      initialStateId: "done",
      states: { done: { type: "end", result: null } },
      grants: [],
    },
  });
  void client.notify("connection.pong", { at: new Date().toISOString() });
  void portal.request("binary.ack", {
    transferId: "transfer-1",
    throughIndex: 0,
  });

  // @ts-expect-error clients cannot call server-to-Portal routes
  void client.request("portal.tool.call", {
    tool: "read",
    args: { path: "README.md" },
  });
  // @ts-expect-error required params cannot be omitted
  void client.request("chat.thread.get");
  // @ts-expect-error undeclared params are rejected
  void client.request("chat.thread.get", { threadId: "thread-1", extra: true });
  // @ts-expect-error Thread creation requires a Workspace owner
  void client.request("chat.thread.create", {
    threadId: "thread-1",
    projectId: "project-1",
  });
  // @ts-expect-error notification direction is enforced
  void client.notify("chat.run.event", { subscriptionId: "subscription-1" });
  // @ts-expect-error Portal cannot call client request routes
  void portal.request("owner.get");
  void client.request("workflow.definition.create", {
    // @ts-expect-error workflow definitions require a complete canonical DTO
    definition: { id: "workflow-1", name: "Incomplete" },
  });

  type ReverseHandler = RpcConnectionHandler<
    "client",
    "client.editorContext.get"
  >;
  const validReverseHandler: ReverseHandler = async () => ({
    ok: false,
    reason: "no_context",
    error: "No context",
  });
  void validReverseHandler;
  // @ts-expect-error handler output must match the correlated route result
  const invalidReverseHandler: ReverseHandler = async () => "invalid";
  void invalidReverseHandler;

  const readArgs: PortalToolArgs<"read"> = { path: "README.md" };
  const readResult: PortalToolResult<"read"> = { ok: true, content: "# Weave" };
  void readArgs;
  void readResult;
  // @ts-expect-error Portal tool args are correlated with the selected tool
  const invalidReadArgs: PortalToolArgs<"read"> = { command: "pwd" };
  void invalidReadArgs;
  // @ts-expect-error Portal tool results are correlated with the selected tool
  const invalidReadResult: PortalToolResult<"read"> = { ok: true, bytes: 10 };
  void invalidReadResult;

  void client.register("client.editorContext.get", async () => ({
    ok: false,
    reason: "no_context",
    error: "No context",
  }));
  // @ts-expect-error RpcConnection.register enforces the correlated handler result
  void client.register("client.editorContext.get", async () => "invalid");
  // @ts-expect-error Portal handlers must return a JSON object, not another handler
  void portal.register("portal.tool.call", () => () => ({ ok: true }));

  const ownerEnvelope: DesktopRpcRequestEnvelope<"owner.get"> = {
    kind: "request",
    requestId: "request-1",
    method: "owner.get",
    params: undefined,
  };
  void ownerEnvelope;
  const invalidOwnerEnvelope: DesktopRpcRequestEnvelope<"owner.get"> = {
    kind: "request",
    requestId: "request-2",
    method: "owner.get",
    // @ts-expect-error Desktop envelope params stay correlated with the method
    params: {},
  };
  void invalidOwnerEnvelope;

  const ownerResult: RpcRequestResult<"client", "server", "owner.get"> = {
    owner: { id: "owner-1", name: "Owner" },
  };
  void ownerResult;
};

Deno.test("protocol v2 direction and correlation types compile", () => {
  if (compileOnly.name !== "compileOnly") throw new Error("unreachable");
});
