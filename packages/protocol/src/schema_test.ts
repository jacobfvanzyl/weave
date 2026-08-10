import {
  parseDesktopRpcNotificationEnvelope,
  parseDesktopRpcNotifyEnvelope,
  parseDesktopRpcRequestEnvelope,
  parseDesktopRpcResponseEnvelope,
  parseDesktopRpcReverseRequestEnvelope,
  parseDesktopRpcReverseResponseEnvelope,
  parsePortalToolArgs,
  parsePortalToolResult,
  parseRpcRequestParams,
  parseRpcRequestResult,
  portalToolNameSchema,
  rpcContracts,
  rpcContractsByDomain,
  rpcInitializeParamsSchema,
  rpcProtocolDomains,
  threadCompactionEventDataSchema,
  threadRunPhaseSchema,
  WEAVE_RPC_PROTOCOL_VERSION,
  workspaceCompositionSchema,
} from "./schema.ts";

const expectRejected = (operation: () => unknown, message: string) => {
  try {
    operation();
  } catch {
    return;
  }
  throw new Error(message);
};

Deno.test("thread run and compaction lifecycle schemas accept the shared wire contract", () => {
  if (threadRunPhaseSchema.parse("compacting") !== "compacting") {
    throw new Error("expected compacting phase");
  }
  const event = threadCompactionEventDataSchema.parse({
    phase: "rejected",
    compactionId: "compaction-1",
    origin: "mid_run",
    trigger: "automatic",
    generation: 2,
    mode: "incremental",
    reason: "insufficient_gain",
    tokensBefore: 4_000,
    tokensAfter: 4_100,
    reclaimedTokens: -100,
    headroomTokens: 1_000,
  });
  if (event.reclaimedTokens !== -100) {
    throw new Error("expected signed token reclamation");
  }
});

Deno.test("thread compaction lifecycle schema rejects unknown phases", () => {
  let rejected = false;
  try {
    threadCompactionEventDataSchema.parse({
      phase: "unknown",
      compactionId: "compaction-1",
      origin: "pre_run",
      trigger: "automatic",
      generation: 1,
      mode: "rebuild",
    });
  } catch {
    rejected = true;
  }
  if (!rejected) {
    throw new Error("expected invalid lifecycle phase to be rejected");
  }
});

Deno.test("protocol v2 handshake rejects protocol v1 peers", () => {
  if (WEAVE_RPC_PROTOCOL_VERSION !== 2) throw new Error("expected protocol v2");
  let rejected = false;
  try {
    rpcInitializeParamsSchema.parse({
      protocolVersion: 1,
      role: "client",
      token: "token",
      capabilities: [],
      client: { clientAppId: "test", clientInstanceId: "test-1" },
    });
  } catch {
    rejected = true;
  }
  if (!rejected) {
    throw new Error("expected protocol v1 handshake to be rejected");
  }
});

Deno.test("protocol v2 exposes complete versioned domain views from the route registry", () => {
  const routed = rpcProtocolDomains.flatMap((domain) =>
    rpcContractsByDomain[domain]
  );
  if (routed.length !== rpcContracts.length) {
    throw new Error("expected every route in exactly one protocol domain");
  }
  for (const domain of rpcProtocolDomains) {
    if (rpcContractsByDomain[domain].length === 0) {
      throw new Error(`expected routes for ${domain}`);
    }
  }
});

Deno.test("Thread creation requires a concrete Workspace owner", () => {
  const direct = parseRpcRequestParams(
    "client",
    "server",
    "chat.thread.create",
    {
      threadId: "thread-1",
      title: "Workspace-bound Thread",
      projectId: "project-1",
      workspaceId: "workspace-1",
    },
  );
  if (
    direct.projectId !== "project-1" ||
    direct.workspaceId !== "workspace-1"
  ) {
    throw new Error("expected direct Thread ownership to survive validation");
  }

  expectRejected(
    () =>
      parseRpcRequestParams(
        "client",
        "server",
        "chat.thread.create",
        { threadId: "thread-1", projectId: "project-1" },
      ),
    "expected direct Thread creation without a Workspace to be rejected",
  );
  expectRejected(
    () =>
      parseRpcRequestParams(
        "client",
        "server",
        "code.project.threads.create",
        {
          projectId: "project-1",
          threadId: "thread-1",
          product: "code",
        },
      ),
    "expected project Thread creation without a Workspace to be rejected",
  );
});

Deno.test("Workspace Composition exposes stable versioned identities through the RPC contract", () => {
  const params = parseRpcRequestParams(
    "client",
    "server",
    "workspace.composition.get",
    { projectId: "project-1", workspaceId: "workspace-1" },
  );
  if (params.workspaceId !== "workspace-1") {
    throw new Error("expected Workspace identity to survive validation");
  }

  const composition = workspaceCompositionSchema.parse({
    workspaceId: "workspace-1",
    schemaVersion: 1,
    revision: 1,
    defaultPaneType: "editor",
    tabs: [{
      tabId: "tab-1",
      name: "New Tab",
      layout: { kind: "empty", layoutId: "layout-1" },
      panes: [],
    }],
  });
  const result = parseRpcRequestResult(
    "client",
    "server",
    "workspace.composition.get",
    { composition },
  );

  if (
    result.composition.tabs[0]?.tabId !== "tab-1" ||
    result.composition.tabs[0]?.layout.layoutId !== "layout-1"
  ) {
    throw new Error("expected stable Tab and Layout identities");
  }

  expectRejected(
    () => workspaceCompositionSchema.parse({ ...composition, revision: 0 }),
    "expected revisions to be positive",
  );
  expectRejected(
    () => workspaceCompositionSchema.parse({ ...composition, tabs: [] }),
    "expected at least one Workspace Tab",
  );
  expectRejected(
    () =>
      workspaceCompositionSchema.parse({
        ...composition,
        tabs: ["tab-1", "tab-2"].map((tabId, index) => ({
          tabId,
          name: `Thread ${index + 1}`,
          panes: [{
            paneId: `pane-${index + 1}`,
            type: "thread",
            threadId: "thread-1",
          }],
          layout: {
            kind: "pane",
            layoutId: `layout-${index + 1}`,
            paneId: `pane-${index + 1}`,
          },
        })),
      }),
    "expected one Thread Pane per Thread",
  );
  expectRejected(
    () =>
      workspaceCompositionSchema.parse({
        ...composition,
        tabs: [{
          tabId: "tab-1",
          name: "Invalid layout",
          panes: [{ paneId: "pane-1", type: "editor", workingSet: [] }],
          layout: {
            kind: "row",
            layoutId: "layout-root",
            ratios: [1],
            children: [
              { kind: "pane", layoutId: "layout-1", paneId: "pane-1" },
              { kind: "pane", layoutId: "layout-2", paneId: "pane-missing" },
            ],
          },
        }],
      }),
    "expected valid layout ratios and Pane references",
  );
  expectRejected(
    () =>
      workspaceCompositionSchema.parse({
        ...composition,
        tabs: [{
          tabId: "tab-1",
          name: "Editor",
          panes: [{
            paneId: "pane-1",
            type: "editor",
            workingSet: ["README.md", "README.md"],
          }],
          layout: {
            kind: "pane",
            layoutId: "layout-1",
            paneId: "pane-1",
          },
          preferredEditorPaneId: "pane-1",
        }],
      }),
    "expected Editor Working Sets to reject duplicate files",
  );
  expectRejected(
    () =>
      workspaceCompositionSchema.parse({
        ...composition,
        tabs: [{ ...composition.tabs[0]!, name: "   " }],
      }),
    "expected Workspace Tab names to be non-empty after trimming",
  );
});

Deno.test("Portal tool schemas correlate and validate args and results", () => {
  const edit = parsePortalToolArgs("edit", {
    path: "src/main.ts",
    edits: [{ oldText: "before", newText: "after" }],
  });
  if (edit.edits[0].newText !== "after") {
    throw new Error("expected correlated edit args");
  }
  const result = parsePortalToolResult("read", { ok: true, content: "hello" });
  if (result.ok !== true || result.content !== "hello") {
    throw new Error("expected correlated read result");
  }
  const worktrees = parsePortalToolResult("portal.git.worktree.list", {
    ok: true,
    worktrees: [{ path: "/repo", branch: "main", upstream: undefined }],
  });
  if (!worktrees.ok) throw new Error("expected successful worktree result");
  if (Object.hasOwn(worktrees.worktrees[0], "upstream")) {
    throw new Error("expected absent Portal DTO fields to be omitted");
  }
  const projectContext = parsePortalToolResult("portal.context.discover", {
    ok: true,
    scope: "project",
    basePath: "/repo",
    workspacePath: "/repo/worktree",
    files: [],
    diagnostics: {
      instructionFiles: 2,
      instructionBytes: 512,
      truncatedFiles: [],
      precedence: "git-root-to-workspace",
    },
  });
  if (
    projectContext.ok !== true ||
    projectContext.workspacePath !== "/repo/worktree" ||
    projectContext.diagnostics?.instructionFiles !== 2
  ) {
    throw new Error(
      "expected Portal project context metadata to survive validation",
    );
  }

  let rejected = false;
  try {
    parsePortalToolArgs("read", { command: "pwd" });
  } catch {
    rejected = true;
  }
  if (!rejected) {
    throw new Error("expected mismatched Portal tool args to be rejected");
  }
  expectRejected(
    () => parsePortalToolResult("read", { ok: true, bytes: 10 }),
    "expected mismatched Portal tool results to be rejected",
  );
  expectRejected(
    () => portalToolNameSchema.parse("unknown"),
    "expected unknown dynamic Portal tools to be rejected",
  );
});

Deno.test("workflow routes use strict canonical definition schemas", () => {
  const params = parseRpcRequestParams(
    "client",
    "server",
    "workflow.definition.create",
    {
      definition: {
        id: "workflow-1",
        version: "1",
        name: "Workflow",
        initialStateId: "done",
        states: { done: { type: "end", result: null } },
        grants: [],
      },
    },
  );
  if (params.definition.id !== "workflow-1") {
    throw new Error("expected canonical workflow definition");
  }
  expectRejected(
    () =>
      parseRpcRequestParams(
        "client",
        "server",
        "workflow.definition.create",
        {
          definition: {
            id: "workflow-1",
            version: "1",
            name: "Workflow",
            initialStateId: "done",
            states: { done: { type: "end", result: null, extra: true } },
            grants: [],
          },
        },
      ),
    "expected undeclared workflow state fields to be rejected",
  );
});

Deno.test("Desktop RPC envelopes validate method-correlated payloads at every IPC direction", () => {
  const request = parseDesktopRpcRequestEnvelope({
    kind: "request",
    requestId: "request-1",
    method: "chat.thread.get",
    params: { threadId: "thread-1" },
  }, "chat.thread.get");
  if (request.params.threadId !== "thread-1") {
    throw new Error("expected typed Desktop request");
  }
  expectRejected(() =>
    parseDesktopRpcRequestEnvelope({
      kind: "request",
      requestId: "request-2",
      method: "chat.thread.get",
      params: {},
    }), "expected invalid Desktop request params to be rejected");

  const response = parseDesktopRpcResponseEnvelope({
    kind: "success",
    requestId: "request-1",
    method: "owner.get",
    result: { owner: { id: "owner-1", name: "Owner" } },
  }, "owner.get");
  if (response.kind !== "success" || response.result.owner.id !== "owner-1") {
    throw new Error("expected typed Desktop response");
  }
  expectRejected(() =>
    parseDesktopRpcResponseEnvelope({
      kind: "success",
      requestId: "request-1",
      method: "owner.get",
      result: { owner: { id: "owner-1" } },
    }), "expected invalid Desktop result to be rejected");
  expectRejected(
    () =>
      parseDesktopRpcResponseEnvelope({
        kind: "success",
        requestId: "request-1",
        method: "owner.get",
        result: { owner: { id: "owner-1", name: "Owner" } },
      }, "agent.models.list"),
    "expected a Desktop response method mismatch to be rejected",
  );

  parseDesktopRpcNotificationEnvelope({
    kind: "notification",
    method: "connection.ping",
    params: { nonce: "nonce-1" },
  });
  expectRejected(() =>
    parseDesktopRpcNotificationEnvelope({
      kind: "notification",
      method: "connection.ping",
      params: { undeclared: true },
    }), "expected invalid Desktop inbound notification to be rejected");
  parseDesktopRpcNotifyEnvelope({
    kind: "notification",
    method: "connection.pong",
    params: { nonce: "nonce-1", at: "2026-07-14T00:00:00.000Z" },
  });

  const reverseRequest = parseDesktopRpcReverseRequestEnvelope({
    kind: "reverse-request",
    requestId: "reverse-1",
    method: "client.editorContext.get",
    params: {},
  });
  if (reverseRequest.method !== "client.editorContext.get") {
    throw new Error("expected typed reverse request");
  }
  parseDesktopRpcReverseResponseEnvelope({
    kind: "reverse-success",
    requestId: "reverse-1",
    method: "client.editorContext.get",
    result: {
      ok: false,
      reason: "no_context",
      error: "No context",
    },
  }, "client.editorContext.get");
});
