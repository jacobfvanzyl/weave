# ACP tool provisioning

_Research snapshot: 2026-08-20. Primary Agent Client Protocol documentation and schema only._

## Answer

**Yes, ACP can pass tool access to an agent, but the standard mechanism is session-scoped MCP server configuration—not arbitrary tool definitions attached to a prompt.**

In stable ACP v1, the client supplies `mcpServers` when it creates, loads, or resumes a session. Each entry tells the agent how to connect to an MCP server; that server then exposes its tools and context through MCP. Stdio is the baseline transport, while HTTP and the deprecated SSE transport are capability-gated. ACP's architecture guide explicitly recommends this route when an editor wants to export its own tools: expose an MCP server and pass its connection configuration to the agent. ([Session setup](https://agentclientprotocol.com/protocol/v1/session-setup#mcp-servers), [architecture](https://agentclientprotocol.com/get-started/architecture#mcp), [v1 schema: `NewSessionRequest` and `McpServer`](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/v1/schema.json#L4643-L4741))

## What the three similarly named surfaces mean

| Surface | What ACP supports | What it does not mean |
| --- | --- | --- |
| Client capabilities | During `initialize`, the client advertises ACP-defined services the agent may call: filesystem reads/writes, terminal operations, elicitation, and session-related support. | This is not a registry of arbitrary JSON-schema tools. ([Initialization](https://agentclientprotocol.com/protocol/v1/initialization#client-capabilities), [v1 schema: `ClientCapabilities`](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/v1/schema.json#L4407-L4493)) |
| MCP session configuration | `session/new.mcpServers` gives the agent MCP server connection descriptors. Stable v1 also accepts the full intended list on `session/load` and `session/resume`. | These are session lifecycle inputs, not per-message tool definitions. ([Session setup](https://agentclientprotocol.com/protocol/v1/session-setup#creating-a-session)) |
| Tool-call updates | The agent emits `tool_call` and `tool_call_update` session updates so the client can render progress, inputs, outputs, and request permission. | These messages report or govern execution; they do not register tools with the agent. ([Tool calls](https://agentclientprotocol.com/protocol/v1/tool-calls)) |

## No standard per-request `tools` field

Stable v1 `PromptRequest` contains `sessionId`, `prompt: ContentBlock[]`, and `_meta`. It has no OpenAI-style `tools: [...]`, function-schema list, or generic callback-tool registry. The draft v2 `PromptRequest` has the same relevant shape. Its `mcpServers` field remains on session setup, not on `session/prompt`. ([v1 `PromptRequest` schema](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/v1/schema.json#L5091-L5137), [v2 `NewSessionRequest`](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/v2/schema.json#L5854-L5894), [v2 `PromptRequest`](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/v2/schema.json#L6395-L6441))

For an interoperable client-hosted callback tool today, the client therefore needs to expose it through an MCP server reachable over a supported transport. ACP permits proprietary `_`-prefixed JSON-RPC methods and custom capabilities, but those are bilateral extensions requiring agent-specific support rather than standard tool registration. ([Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility))

There is a draft **MCP-over-ACP** RFD that would route MCP messages and callbacks through the existing ACP channel, avoiding a side process or HTTP endpoint. It is explicitly listed as Draft and is not part of stable v1. ([MCP-over-ACP RFD](https://agentclientprotocol.com/rfds/mcp-over-acp))

## Weave checkout

The current Weave checkout has no ACP SDK dependency or ACP client/agent implementation. Its existing ACP mentions are confined to comparative research, so there is no local tool-passing behavior to reconcile with the protocol yet.
