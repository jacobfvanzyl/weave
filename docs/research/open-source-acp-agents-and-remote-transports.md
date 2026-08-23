# Open-source ACP agents for remote coding clients

_Research snapshot: 2026-08-21. Sources are limited to the ACP specification and registry, upstream repositories/source, and official vendor documentation._

## Short answer

Yes: there are usable, off-the-shelf ACP **agents** for Codex, Claude, OpenCode, Gemini CLI, Cline, and other coding agents. The best starting points are:

- [`@agentclientprotocol/codex-acp`](https://github.com/agentclientprotocol/codex-acp) for Codex. It is an Apache-2.0 ACP adapter over Codex App Server and is the closest fit to an exact Codex integration.
- [`@agentclientprotocol/claude-agent-acp`](https://github.com/agentclientprotocol/claude-agent-acp) for Claude Code-like behavior. Its adapter is Apache-2.0, but it embeds Anthropic's proprietary Claude Agent SDK and is not a wrapper around the installed `claude` executable.
- [OpenCode](https://github.com/anomalyco/opencode) as the strongest fully open-source, native ACP comparison target. It is useful both as a supported agent and as an independent conformance check.

The important limitation is transport. ACP v1 standardizes a local stdio connection; it does **not** yet standardize a production-ready remote network transport. A remote web or mobile client therefore still needs a host-side service beside the workspace. That service can launch one of the agents above and expose a separate authenticated, durable API. There are off-the-shelf relays, but the current choices are either custom protocols or implementations of a draft ACP transport.

For Weave, the practical route is:

1. Make Portal, or a small host service next to it, the ACP client and process owner.
2. Launch vetted ACP agents on the machine that owns the workspace.
3. Relay normalized events to Weave clients through Weave's own authenticated and reconnectable protocol.
4. Keep the agent transport behind an interface so a finalized ACP network transport can replace the relay later.

This provides Codex and Claude support now without making a draft remote transport part of the public product contract.

## Terminology: the “server” is called an agent

ACP uses terms from the UI's perspective:

- The **client** is the editor, terminal UI, or host application. It starts a session, renders updates, answers permission requests, and exposes filesystem and terminal services.
- The **agent** is the server-like coding backend. It receives prompts and emits streamed session updates.
- In the standard deployment the client launches the agent as a subprocess and exchanges bidirectional JSON-RPC over stdin/stdout. One connection may own several sessions.

The official [architecture guide](https://agentclientprotocol.com/get-started/architecture) and [v1 overview](https://agentclientprotocol.com/protocol/v1/overview) define that relationship. Consequently, projects such as `acpx`, OpenACP, Zed, and Codeg can be ACP **clients** or orchestrators without being reusable ACP agent servers. A project appearing on ACP's clients page does not mean it is a backend that an independent client can connect to.

## Candidate matrix

| Candidate | What it actually integrates | License reality | Session lifecycle advertised by the current registry probe | Assessment |
| --- | --- | --- | --- | --- |
| [`codex-acp`](https://github.com/agentclientprotocol/codex-acp) 1.6.2 | Codex App Server, normally through a bundled compatible `@openai/codex` | Apache-2.0 | load, list, resume | Best exact Codex starting point |
| [`claude-agent-acp`](https://github.com/agentclientprotocol/claude-agent-acp) 0.70.0 | Claude Agent SDK, the SDK form of the agent loop and tools that power Claude Code | Apache-2.0 adapter; proprietary/commercial underlying SDK and aggregate distribution | load, list, fork, resume | Best maintained Claude adapter if its terms and API-key model fit |
| [OpenCode](https://github.com/anomalyco/opencode) | Native OpenCode agent | MIT | load, list, fork, resume | Best fully open-source secondary target |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/acp-mode.md) 0.56.0 | Native Gemini CLI `--acp` mode | Apache-2.0 | load | Official and active, but narrower lifecycle support |
| [Cline](https://github.com/cline/cline) 3.0.56 | Native Cline CLI `--acp` mode | Apache-2.0 | load | Useful later compatibility target; currently a smaller ACP surface |
| [`claude-code-acp`](https://github.com/harukitosa/claude-code-acp) | A separately installed `claude` CLI in stream-JSON print mode | MIT | Not in the official registry | Exact CLI proof of concept, not a dependable baseline |

The lifecycle column comes from the official [ACP protocol matrix](https://github.com/agentclientprotocol/registry/blob/main/.protocol-matrix/latest.md), generated on 2026-08-21. It is a capability probe, not certification of semantics, security, or production quality. The [registry](https://github.com/agentclientprotocol/registry) checks that submitted agents can complete the authentication handshake and refreshes versions automatically; curation is not a security audit.

## Codex: the strongest direct fit

The ACP organization's [`codex-acp` README](https://github.com/agentclientprotocol/codex-acp/blob/ba5bcc3d7759250dde9d4d2286a1bec11b363208/README.md#L1-L47) says that the adapter:

- serves ACP over stdio;
- starts Codex App Server and maps ACP calls and notifications to Codex threads and turns;
- supports ChatGPT sign-in, API keys, and gateway authentication;
- translates sandbox and approval modes, tool calls, file changes, shell output, plans, images, and context;
- passes both stdio and HTTP MCP server configurations to Codex.

Its current [capability declaration](https://github.com/agentclientprotocol/codex-acp/blob/ba5bcc3d7759250dde9d4d2286a1bec11b363208/src/CodexAcpServer.ts#L303-L343) includes session load, resume, list, close, delete, additional workspace directories, HTTP MCP, and auth logout. Its [package manifest](https://github.com/agentclientprotocol/codex-acp/blob/ba5bcc3d7759250dde9d4d2286a1bec11b363208/package.json#L1-L73) is Apache-2.0, version 1.6.2, and depends on ACP SDK 1.4.0 plus `@openai/codex ^0.148.0`. The registry manifest identifies OpenAI, JetBrains, and Zed contributors.

This is more than a wrapper around Codex's one-shot CLI JSON output. It maps ACP sessions to persistent Codex App Server threads, which is the right seam for conversation history and resume.

The adapter intentionally installs a known-compatible Codex package and supports a `CODEX_PATH` override. The local research environment had Codex CLI 0.149.0 while the adapter declared `^0.148.0`; that is not evidence of incompatibility, but it is a reason to test an override instead of silently substituting any installed Codex binary.

**Verdict:** adopt this first. It has the best combination of exact product fit, active upstream work, registry presence, broad lifecycle support, and permissive licensing.

## Claude: maintained adapter, but not a fully open stack

The ACP organization's [`claude-agent-acp` README](https://github.com/agentclientprotocol/claude-agent-acp/blob/ee9f300db4562e8b7958cec9fa63dab05a5c2eb0/README.md#L1-L39) is explicit: this is an ACP adapter for the **Claude Agent SDK**. It covers context, images, permissioned tool calls, edit review, todos, nested subagents, terminals, slash commands, and MCP.

Its [ACP implementation](https://github.com/agentclientprotocol/claude-agent-acp/blob/ee9f300db4562e8b7958cec9fa63dab05a5c2eb0/src/acp-agent.ts#L1508-L1659) advertises load, list, fork, resume, close, delete, additional directories, HTTP/SSE MCP, image/context input, provider methods, and terminal-based subscription authentication. The local environment had Claude Code 2.1.228, but this adapter does not invoke that binary.

Anthropic describes the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) as exposing the agent loop, tools, and context management that power Claude Code. That makes the behavior closely related, but the deployment and contract are different:

- it is an embedded SDK integration rather than a child `claude` CLI process;
- its credentials and commercial terms must be evaluated as an SDK product integration;
- parity with every Claude Code CLI feature should be tested rather than assumed.

There is also a licensing distinction that the package README alone can obscure. The adapter's [package manifest](https://github.com/agentclientprotocol/claude-agent-acp/blob/ee9f300db4562e8b7958cec9fa63dab05a5c2eb0/package.json#L1-L70) declares Apache-2.0, but it depends on `@anthropic-ai/claude-agent-sdk`. Anthropic's SDK documentation points to [Commercial Terms](https://code.claude.com/docs/en/agent-sdk/overview#legal-and-compliance), and the official ACP registry therefore labels the aggregate Claude agent distribution proprietary.

Authentication matters for a remote product. Anthropic's [legal and compliance documentation](https://code.claude.com/docs/en/legal-and-compliance) says third-party developers building products with the Agent SDK should use API-key or supported cloud-provider authentication. It does not permit offering Claude.ai login or routing Free, Pro, or Max subscription credentials through a third-party product without prior approval.

**Verdict:** use this if Claude Code-like agent behavior is the requirement and the product can require customer API keys or another approved authentication model. Describe it as an Agent SDK adapter, not as an open-source Claude Code server.

### The exact Claude Code CLI wrapper is only a proof of concept

Community project [`harukitosa/claude-code-acp`](https://github.com/harukitosa/claude-code-acp/blob/6c20f2802e390c80b0542247c6b9738e11efdc11/README.md#L1-L145) takes the literal route: it runs the installed `claude` executable with `--output-format stream-json`, then uses `--resume` for later prompts. It is MIT-licensed and demonstrates that an ACP-to-CLI adapter is feasible.

It is not yet a safe product dependency. The README claims session load/list support, but the pinned [agent implementation](https://github.com/harukitosa/claude-code-acp/blob/6c20f2802e390c80b0542247c6b9738e11efdc11/src/agent.ts#L74-L186) advertises `loadSession: false` and no resume capability. Its ACP session mapping and listing are process-local rather than a durable ACP session index. It is small, outside the official registry, and its advertised use of Claude subscription credentials must be reconciled with Anthropic's third-party authentication rules.

**Verdict:** useful source material for an internal experiment; do not make it the supported Claude backend without contributing lifecycle, persistence, tests, and a compliant authentication model.

## Comparable fully open-source agents

### OpenCode

OpenCode exposes a native `opencode acp` stdio command. Its current [ACP service](https://github.com/anomalyco/opencode/blob/1b937c860b6fd8a83e69f916b1236515aa17ea0d/packages/opencode/src/acp/service.ts#L94-L139) advertises load, close, fork, list, resume, terminal authentication, image/context input, and HTTP/SSE MCP. The [registry manifest](https://raw.githubusercontent.com/agentclientprotocol/registry/main/opencode/agent.json) identifies it as MIT-licensed and distributes native binaries across the major platforms.

It is its own multi-provider coding agent, not an adapter around Codex or Claude Code. That independence makes it particularly valuable in integration tests: if the host works against Codex and OpenCode, it is less likely to have accidentally coupled itself to one adapter's quirks.

### Gemini CLI

Google ships a native [`gemini --acp` mode](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/acp-mode.md). The official documentation covers initialize/authenticate, new/load session, prompt/cancel, modes, model selection, client filesystem proxying, and MCP. Its [dispatcher source](https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/cli/src/acp/acpRpcDispatcher.ts) advertises load, image/audio/context input, and HTTP/SSE MCP, but not list, fork, or resume. Gemini CLI is Apache-2.0.

This is an active, vendor-owned ACP implementation and a useful third target, particularly for checking media input and client filesystem behavior.

### Cline

Cline's CLI has a native ACP mode. Its current [capability declaration](https://github.com/cline/cline/blob/7d366ce7d4e46c9940532c4dc5d479d92a569a01/apps/cli/src/acp/acpAgent.ts#L127-L149) advertises authentication, session load, and image input, but not list, fork, resume, or MCP capabilities. The [registry manifest](https://raw.githubusercontent.com/agentclientprotocol/registry/main/cline/agent.json) distributes `cline --acp` under Apache-2.0.

It is a legitimate native ACP agent, but its current lifecycle surface makes it a later compatibility target rather than the reference implementation for a durable remote client.

## Remote transport is the missing standard piece

The stable [ACP v1 transport specification](https://agentclientprotocol.com/protocol/v1/transports) defines stdio as the current standard transport and labels Streamable HTTP as a draft proposal. The [Streamable HTTP and WebSocket RFD](https://agentclientprotocol.com/rfds/streamable-http-websocket-transport) remains in Draft status. It explicitly exists because ACP has no standardized remote transport yet.

This has several consequences:

- A browser cannot connect directly to a normal registry agent. Something on the workspace host must launch and supervise the stdio process.
- A dropped socket and a resumable agent session are different concerns. Session `load` can replay history and `resume` can restore an existing session on a new ACP connection, but neither guarantees recovery of transient deltas or a turn interrupted halfway through network failure.
- The draft WebSocket lifecycle closes connection-owned sessions on disconnect. Last-Event-ID style replay is future work in the RFD, not a stable guarantee.
- Draft transport connection identifiers are routing state, not authorization credentials. Network authentication is a separate layer.

The stable [session lifecycle](https://agentclientprotocol.com/protocol/v1/session-setup) supports capability-gated load and resume. A host can use those methods after reconnecting, but it still needs its own event cursor, replay buffer, idempotency rules, and ownership policy if remote clients expect seamless continuation.

### Existing relay: ACP Remote (`acpremote`)

ACP's clients/connectors page lists [`acpremote`](https://github.com/vcoderun/acpkit/tree/main/packages/transports/acpremote), an Apache-2.0 package in `vcoderun/acpkit`. It can:

- expose an existing ACP agent, or any stdio command, through a WebSocket;
- mirror that WebSocket back into local stdio for an ordinary ACP client;
- launch commands such as `npx @agentclientprotocol/codex-acp` on the remote host;
- require a bearer token;
- keep the remote host's cwd authoritative and optionally pass selected client capabilities through.

This is the fastest off-the-shelf way to prove a remote Codex ACP path. It is, however, a **custom WebSocket transport**, not the finalized ACP remote standard and not a durable multi-user service. Its own security guidance recommends loopback binding or a TLS/authenticating reverse proxy, command allowlisting, and minimal child-process environments. The exposed child is tied to the WebSocket lifecycle.

**Use:** a private proof of concept, SSH-tunnel workflow, or test harness. Do not expose it as the long-term public client contract.

### Existing draft bridge: `acp_rpc_bridge`

ACP's connectors page also lists Intellexie's Apache-2.0 [`acp_rpc_bridge`](https://github.com/Intellexie/acp_rpc_bridge). It launches a stdio ACP agent and exposes `/acp` through its interpretation of draft Streamable HTTP, with one subprocess per connection and server-sent event streams.

This is closer to the direction of the RFD, but it was only a two-commit project at this snapshot and the documented CLI exposes agent, arguments, environment, cwd, address, backend, and logging options without built-in authentication or TLS. It should only run on loopback, a private network, or behind a carefully configured authenticating reverse proxy. Because the protocol itself is still a draft, wire compatibility can also change.

**Use:** an interoperability experiment against the draft. It is not yet a production edge server.

### Complete product/reference: Codeg

[Codeg](https://github.com/xintaofei/codeg) is a different category. It is an active, Apache-2.0, self-hosted server with Docker deployment, token-authenticated web/mobile clients, and built-in aggregation for Codex, Claude, and other ACP agents. It is compelling evidence that the end-to-end remote product can be built off the current agent ecosystem.

Its network-facing contract is Codeg's own HTTP and WebSocket API rather than standardized remote ACP. The official [Codeg iOS client](https://github.com/xintaofei/codeg-ios) describes itself as a pure API client and connects through Codeg's HTTP/WebSocket endpoints. Codeg is therefore an off-the-shelf product to deploy, fork, or study, but not a clean ACP server dependency beneath an independently designed remote client.

## Authentication, permissions, tools, and host ownership

A remote implementation has two independent authentication layers:

1. **Agent/vendor authentication:** ChatGPT, OpenAI API key, Anthropic API key, cloud provider, or another credential exchanged through ACP's auth flow.
2. **Network authentication:** proving which remote user may reach which host, workspace, process, and session.

The adapters solve the first problem. Stdio ACP does not solve the second, and an ACP connection ID is not a bearer token. A production relay still needs TLS, authenticated principals, per-workspace authorization, command allowlists, environment/secret filtering, root-directory enforcement, quotas, auditing, and session ownership or lease rules.

Permissions are also bidirectional. The agent asks the ACP client to approve sensitive actions; the host must preserve that request/response path to the remote UI and define safe behavior if the UI disconnects. It must not silently treat a network timeout as approval.

ACP passes MCP server configurations when creating or loading sessions. This is a good stable seam for portable tool provisioning, but placement matters:

- stdio MCP commands execute on the **agent host**, so paths and executables must exist there;
- HTTP/SSE MCP endpoints must be reachable from the agent host;
- client-provided filesystem and terminal capabilities execute on the side that implements the ACP client;
- an adapter may also use its coding agent's native workspace tools, so ACP support does not imply all file and shell operations flow through client callbacks.

See the related [ACP tool provisioning note](./acp-tools.md) for that contract in more detail.

## Recommended Weave shape

Use ACP as a host-side adapter contract, not as the public network protocol yet:

```text
Web / mobile / desktop UI
          │
          │ Weave authenticated event protocol
          ▼
Portal / ACP Agent Host on workspace machine
  ├─ process supervision and vetted command registry
  ├─ durable session ↔ agent-session mapping
  ├─ event persistence, cursors, replay, and reconnect policy
  ├─ permission routing and disconnect-safe defaults
  └─ stdio ACP client
          │
          ├─ codex-acp → Codex App Server
          ├─ claude-agent-acp → Claude Agent SDK
          ├─ opencode acp
          └─ gemini --acp / cline --acp
```

This aligns process, cwd, filesystem access, stdio MCP tools, and secrets with the machine that owns the workspace. It also lets Weave promise a stable remote experience even when individual agent capabilities differ or the ACP remote RFD changes.

The public session model should not expose raw ACP session IDs as its only durable identity. Persist at least:

- Weave session ID;
- agent implementation and pinned version;
- underlying ACP/agent session ID;
- workspace host and root;
- last durable event cursor and turn state;
- owner/lease and credential reference;
- capability snapshot used for that session.

The related [Zed remote ACP note](./zed-remote-agent-protocol.md) explains why SSH or a subprocess tunnel alone does not provide transparent in-flight recovery.

## Suggested implementation order

1. **Codex proof:** launch pinned `codex-acp`; cover auth, new session, prompt streaming, approvals, file changes, shell output, cancel, list, load, and resume.
2. **Independent conformance target:** run the same client suite against OpenCode.
3. **Claude decision:** choose `claude-agent-acp` only after confirming customer credential flow and Anthropic terms; otherwise keep Claude support experimental while evaluating the CLI adapter gap.
4. **Host relay:** add durable events and remote auth in Portal/Agent Host; keep stdio ACP internal.
5. **Broader compatibility:** add Gemini CLI, then Cline, with capability-driven UI rather than a least-common-denominator API.
6. **Draft experiment:** place `acpremote` or `acp_rpc_bridge` behind the transport interface for interoperability testing, without exposing it as the stable product protocol.

## Minimum acceptance suite

An off-the-shelf agent is only usable for Weave after it passes tests for:

- initialize and every advertised auth method;
- new session, prompt streaming, permission requests, cancellation, and close;
- list/load/resume/fork only when advertised, including process restart;
- disconnect while idle and disconnect during a turn;
- duplicate/replayed client commands and event cursor replay;
- workspace root and additional-directory enforcement;
- stdio and HTTP MCP placement from the remote host;
- child process cleanup and orphan recovery;
- secret redaction and environment allowlisting;
- capability changes across an adapter upgrade.

The registry matrix is the seed for this suite, not a substitute for it.

## Bottom line

There is no need to invent ACP adapters for Codex or Claude from scratch. `codex-acp` is ready to be the first supported backend, and `claude-agent-acp` is a credible maintained Claude backend if its proprietary SDK and authentication terms are acceptable. OpenCode provides a strong fully open-source reference implementation.

What is still missing off the shelf is a mature, standardized, authenticated, reconnectable **remote ACP service** suitable as an independent product's public backend. The available relays are useful experiments, while Codeg is a complete product with its own API. Owning the small host-side orchestration and durable remote protocol layer is therefore the lowest-risk path today.
