# Zed remote agent protocol and lightweight-client feasibility

_Research snapshot: 2026-08-20. Zed source pinned to commit [`282f47a`](https://github.com/zed-industries/zed/tree/282f47a544b72030c8a162955415c8def655d76a). Primary source only._

## Executive answer

A lightweight application can manage and stream **external ACP agents** in substantially the same way Zed does, but the right seam is the public Agent Client Protocol (ACP), not Zed's private remote-development protobuf protocol.

Zed uses two distinct transports for a remote external agent:

1. Its private `zed-remote-server` RPC channel tells the desktop which external agents are available and returns a command with which to start one.
2. The desktop then starts a **second SSH child process**, executes the selected agent on the remote host, and exchanges newline-delimited ACP JSON-RPC directly over that child's standard input and output.

The private remote protocol therefore does **not** stream prompts, message chunks, tool calls, permissions, or session events. Those are ACP messages. Its agent-specific protobuf schema contains only discovery/status notifications and `GetAgentServerCommand`/`AgentServerCommand`; the surrounding Zed envelope supplies request correlation, acknowledgements, and stream termination for the general remote-project RPC system. ([agent protobuf](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/proto/proto/ai.proto#L6-L71), [envelope definition](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/proto/proto/zed.proto#L21-L34), [agent payloads in the envelope](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/proto/proto/zed.proto#L399-L404))

That distinction makes a clean product boundary possible:

- For external agents, build an ACP client plus an SSH/process launcher and the client-side services ACP agents call.
- Do not implement the private Zed remote protocol merely to obtain agent streaming; it contains no such stream.
- Zed's built-in native agent is different. It is an in-process GPUI entity, not a remotely exposed ACP server, so there is no equivalent protocol seam for reproducing that implementation. ([native agent connection construction](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/agent/src/native_agent_server.rs#L11-L54))

## End-to-end architecture

| Stage | Runs locally | Runs remotely | Protocol |
| --- | --- | --- | --- |
| Remote project connection | Zed desktop SSH client and RPC client | `zed-remote-server` | SSH carrying length-prefixed protobuf envelopes |
| Agent discovery/install | Remote-project mirror and UI state | agent registry/store, installer, settings | private Zed protobuf status and request/response messages |
| Agent launch | constructs and owns a new `ssh -T` child | executes the ACP agent in the project directory | SSH process stdio |
| Agent session | ACP connection, thread reducer, permissions, files/terminals, UI | agent runtime and its session state | newline-delimited ACP JSON-RPC |
| Transcript rendering | `AcpThread` events and Agent Panel views | agent emits ordered session updates | ACP `session/update` notifications |

On the headless side, Zed initializes an `AgentRegistryStore` and a local `AgentServerStore`, shares those entities with the remote client, and registers their RPC handlers. ([headless project initialization and sharing](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/remote_server/src/headless_project.rs#L234-L246), [headless agent-store handler registration](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/remote_server/src/headless_project.rs#L278-L340)) The desktop project creates the corresponding remote `AgentServerStore` and subscribes it to remote messages. ([desktop project setup](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/project/src/project.rs#L1573-L1579), [remote store subscription](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/project/src/project.rs#L1646-L1682))

The remote store rebuilds the available-agent list when settings or registry data changes and publishes `ExternalAgentsUpdated` plus installation/loading/version status messages. ([registration and update flow](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/project/src/agent_server_store.rs#L294-L488), [desktop-side status handlers](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/project/src/agent_server_store.rs#L710-L818)) When the desktop selects an agent, it sends `GetAgentServerCommand`. The remote handler resolves or installs the agent and returns its executable path, arguments, environment, working root, and login-shell flag. ([remote command handler](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/project/src/agent_server_store.rs#L613-L708), [desktop request adapter](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/project/src/agent_server_store.rs#L821-L884))

Zed then converts that returned command into an SSH invocation and connects ACP to its piped stdio. The ACP connector explicitly detects a remote project, asks `RemoteClient` to build a non-interactive command, and spawns it with stdin/stdout/stderr piped. ([remote ACP spawn](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/agent_servers/src/acp.rs#L807-L867)) The SSH builder produces a remote `cd ... && exec env ... <agent>` command and invokes SSH with `-T`, so this is a separate, non-TTY process rather than a message tunneled through the remote-server protobuf connection. ([SSH command construction](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/remote/src/transport/ssh.rs#L1848-L1963))

## The private remote-development RPC

The wire framing is small: encode a Prost `Envelope`, prefix it with a four-byte little-endian length, and read the same format in reverse. ([framing implementation](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/remote/src/protocol.rs#L6-L52)) The apparent simplicity is misleading because interoperability also requires the envelope lifecycle:

- monotonically assigned message IDs and `responding_to` correlation;
- per-request response futures and response streams;
- acknowledgement tracking and a replay buffer;
- typed entity/message handler registration;
- `EndStream` and error handling; and
- reconnection resynchronization via `RemoteStarted` and buffered-message flushing.

Those mechanisms are implemented by `ChannelClient`, not expressed solely in `ai.proto`. ([channel state](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/remote/src/remote_client.rs#L1675-L1715), [startup and acknowledgement processing](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/remote/src/remote_client.rs#L1722-L1771), [response and stream dispatch](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/remote/src/remote_client.rs#L1773-L1868), [reconnect resynchronization](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/remote/src/remote_client.rs#L1871-L1923), [outgoing correlation and replay buffering](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/remote/src/remote_client.rs#L1944-L2042))

The shared RPC crate has a private protocol constant, `68` at this commit, but its checked uses are the Zed collaboration WebSocket header and server handshake—not explicit version negotiation on the SSH remote channel. ([protocol constant](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/rpc/src/rpc.rs#L19-L20), [client WebSocket header](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/client/src/client.rs#L1383-L1403), [collaboration-server check](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/collab/src/rpc.rs#L1224-L1242)) SSH provisioning instead expects a channel/version-matched remote binary and installs the matching artifact when necessary. ([binary identity](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/remote/src/transport/ssh.rs#L821-L853), [version check and installation](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/remote/src/transport/ssh.rs#L855-L961), [server version behavior](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/remote_server/src/server.rs#L62-L140)) This lockstep binary lifecycle—not a documented third-party compatibility contract—is the relevant evidence that the SSH protocol is internal.

The Rust types are generated at build time from the checked-in protobuf schema and included from Cargo's output directory. ([protobuf generation](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/proto/build.rs#L1-L9), [generated module inclusion](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/proto/src/proto.rs#L1-L19), [message/request trait generation](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/proto/src/macros.rs#L1-L57)) A client could generate another language binding from these files, but that would reproduce only the data types, not `ChannelClient` semantics or the remote project/entity lifecycle.

## ACP session and event protocol

At this commit Zed pins the `agent-client-protocol` Rust package exactly to version `2.0.0` and enables its unstable feature set. That package version is not the negotiated wire version: Zed initializes with ACP wire `ProtocolVersion::V1` and rejects responses below v1. ([workspace dependency](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/Cargo.toml#L513-L519), [locked package version](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/Cargo.lock#L323-L329), [wire-version initialization](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/agent_servers/src/acp.rs#L991-L1025)) The transport adapter reads the agent's stdout line by line and writes each serialized ACP message followed by a newline. ([ACP stdio framing](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/agent_servers/src/acp.rs#L888-L949))

During initialization Zed declares which client services it supports, including filesystem read/write, terminal operations, authentication terminal support, session configuration, and form/URL elicitation. It installs handlers for requests from the agent—permissions, filesystem access, terminal lifecycle/output, and elicitation—and for session notifications. ([inbound handler registration](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/agent_servers/src/acp.rs#L665-L765), [client capabilities](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/agent_servers/src/acp.rs#L767-L795), [initialization and negotiated agent capabilities](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/agent_servers/src/acp.rs#L991-L1113))

The `AgentConnection` abstraction gives Zed's UI a protocol-neutral API for:

- creating, loading, resuming, closing, listing, and deleting sessions;
- prompting and cancellation;
- authentication and logout;
- setting modes and configuration options; and
- receiving session information and updates.

([connection operations](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/acp_thread/src/connection.rs#L91-L259), [session and update types](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/acp_thread/src/connection.rs#L331-L412)) New/load/resume requests contain the working directory, additional directories, and MCP server configuration. ([session request builders](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/agent_servers/src/acp.rs#L1445-L1470)) The ACP connection keeps an in-memory session map and creates an `AcpThread` for each active session. ([new-session flow](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/agent_servers/src/acp.rs#L1601-L1708), [load/resume handling](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/agent_servers/src/acp.rs#L1711-L1810))

### Streaming model

ACP's streaming unit is `session/update`. Zed routes each notification to the matching `AcpThread`, while applying mode, configuration, and session-information changes to connection state. ([notification routing](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/agent_servers/src/acp.rs#L4816-L4917)) The thread reducer handles:

- user, agent-message, and agent-thought chunks;
- tool calls and tool-call updates;
- plans;
- session information and available commands;
- current mode and configuration changes; and
- token/usage updates.

([session-update reducer](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/acp_thread/src/acp_thread.rs#L2549-L2654)) A prompt request stays pending until the agent returns its terminal `PromptResponse`; intermediate content arrives through the notification stream. Cancellation is an ACP `CancelNotification`. ([prompt and cancel transport](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/agent_servers/src/acp.rs#L1952-L2018))

`AcpThread` turns protocol updates into UI events. Its state includes the ACP session ID, transcript entries, plan, running turn, connection, and usage/cost state. ([thread state and events](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/acp_thread/src/acp_thread.rs#L2089-L2180)) Zed additionally batches streaming text on a roughly 16 ms UI timer; that smoothing is presentation logic, not part of ACP. ([text-buffer scheduling](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/acp_thread/src/acp_thread.rs#L2119-L2143))

The conversation view subscribes to `AcpThread` and permission events, then updates entry views, generation state, modes/configuration, authentication prompts, titles, and subagent presentation. ([view subscriptions](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/agent_ui/src/conversation_view.rs#L267-L332), [event-to-UI handling](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/agent_ui/src/conversation_view.rs#L1566-L1865)) The Agent Panel selects and observes the active thread; it is not subscribed to the remote protobuf transport directly. ([active-thread wiring](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/agent_ui/src/agent_panel.rs#L4070-L4089))

### Permissions, tools, files, and terminals

When an agent asks permission, the ACP connection creates a UI task and waits for the user's response before returning `RequestPermissionResponse`. ([permission request bridge](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/agent_servers/src/acp.rs#L4582-L4631)) `AcpThread` stores the pending one-shot request, emits an authorization event, and resolves it with the selected option/outcome. ([pending authorization](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/acp_thread/src/acp_thread.rs#L3383-L3417), [permission resolution](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/acp_thread/src/acp_thread.rs#L3433-L3477)) Tool calls are session updates that Zed stores and incrementally patches for rendering; executing a tool remains the agent runtime's responsibility unless it invokes one of the client services. ([tool-call update handling](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/acp_thread/src/acp_thread.rs#L3189-L3257))

ACP file requests are fulfilled through Zed's `Project` buffer/open/save APIs, not by granting the agent a raw local filesystem handle. ([ACP read/write handlers](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/agent_servers/src/acp.rs#L4752-L4814), [project-backed file operations](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/acp_thread/src/acp_thread.rs#L4212-L4384)) Terminal requests similarly create project terminal tasks and provide the agent output/status operations. ([ACP terminal handlers](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/agent_servers/src/acp.rs#L4972-L5137), [project terminal bridge](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/acp_thread/src/terminal.rs#L612-L664)) For a remote project, these Project services themselves route through Zed's remote-project machinery. A standalone client must replace them with its own correctly scoped remote file and terminal services.

### Authentication and configuration

The external agent owns its provider authentication and runtime configuration. Zed passes command environment, displays the authentication methods returned during ACP initialization, and invokes ACP authenticate/logout operations. ([authentication operations](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/agent_servers/src/acp.rs#L1883-L1950)) Zed's external-agent documentation explicitly distinguishes Zed's settings from agent-specific configuration and notes that a remotely running agent uses credentials/configuration from the remote environment. ([external-agent configuration and remote credentials](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/docs/src/ai/external-agents.md#L123-L157))

Session modes and configuration options are negotiated ACP capabilities and requests, while MCP server definitions are passed as part of session creation/load/resume. A lightweight client does not have to mirror all of Zed's settings system; it can advertise only the ACP client capabilities it genuinely implements.

## Persistence, reconnect, and cancellation

For external agents, the ACP agent is authoritative for durable session history. Zed can list/import agent sessions, and during load the agent replays the transcript as `session/update` notifications. Zed deliberately inserts the new `AcpThread` in its session map **before** sending the load request so those replay notifications have a target. ([load and replay ordering](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/agent_servers/src/acp.rs#L1166-L1301), [documented session import behavior](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/docs/src/ai/external-agents.md#L186-L200))

Zed's local SQLite store persists sidebar/index metadata rather than the authoritative ACP transcript: thread/session ID, agent ID, title, paths, remote-connection identity, and archive state. ([metadata shape](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/agent_ui/src/thread_metadata_store.rs#L306-L326), [event-driven metadata persistence](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/agent_ui/src/thread_metadata_store.rs#L1265-L1355), [SQLite schema and storage](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/agent_ui/src/thread_metadata_store.rs#L1368-L1569)) A standalone app should likewise persist remote identity plus ACP session ID and rebuild the transcript through `load_session`/`resume_session`, subject to the agent's advertised capabilities.

The private remote-project channel has heartbeat/reconnect and replay behavior. ([heartbeat policy](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/remote/src/remote_client.rs#L160-L166), [remote reconnect flow](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/remote/src/remote_client.rs#L586-L769)) That does not make ACP prompts replay-safe. The ACP connection owns a child process; dropping it kills the child, and process exit emits a load error to active sessions. ([ACP connection ownership](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/agent_servers/src/acp.rs#L396-L416), [child cleanup and exit propagation](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/agent_servers/src/acp.rs#L1510-L1533)) The connection store supports explicitly requesting or restarting an agent connection, but the examined path does not transparently reconnect an interrupted ACP turn. ([connection request/restart lifecycle](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/agent_ui/src/agent_connection_store.rs#L127-L207), [connection creation/removal](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/agent_ui/src/agent_connection_store.rs#L268-L312))

Cancellation is best-effort protocol signaling: Zed cancels outstanding elicitation/permission UI state and sends the ACP cancellation notification for the session. ([thread cancellation](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/acp_thread/src/acp_thread.rs#L3901-L3922)) A lightweight client should separately handle SSH/process loss, terminal cleanup, uncertain prompt completion, and optional session resume.

## Can a lightweight independent client reuse this?

### Recommended: reuse ACP semantics, not Zed remote RPC

For an already installed ACP agent whose command is known, the minimum remote path is conceptually:

```text
ssh -T host 'cd <workspace> && exec env <vars> <agent> <args>'
```

The client then performs ACP initialization over the child's newline-delimited stdin/stdout, creates or loads a session, reduces `session/update` notifications, sends prompts/cancellation, and services the capabilities it advertised. This reproduces the meaningful external-agent interaction boundary without running `zed-remote-server` at all.

A practical lightweight design has five modules:

1. **Remote launcher** — SSH configuration, working directory, executable/environment resolution, child supervision, and stderr diagnostics.
2. **ACP connection** — JSON-RPC framing, request correlation, initialization/capability negotiation, and agent-to-client request dispatch.
3. **Session controller** — new/list/load/resume/delete/close, prompt lifecycle, cancellation, reconnect policy, and storage of `{host, agent, session_id}`.
4. **Update reducer and UI stream** — ordered content chunks, thoughts, plans, tool-call patches, modes/config, usage, permissions, elicitation, and final stop/error state.
5. **Scoped client services** — remote workspace reads/writes, terminal lifecycle, MCP configuration, authentication UX, and explicit permission policy.

An initial implementation can omit optional services and advertise narrower capabilities. The hard requirement is consistency: it must not advertise filesystem, terminal, or elicitation capabilities until it can correctly handle the corresponding inbound requests.

### Weave-specific seam

For Weave, the natural deep module is a host-side **ACP Agent Host** inside Portal, not an ACP implementation in every UI shell and not a Zed-protocol adapter. Portal already owns host-local workspace files, terminals, process policy, and a persistent RPC connection to the Weave server. ([Portal workspace-file host](../../portal/src/workspace-files.ts), [Portal terminal host](../../portal/src/terminal.ts), [Portal RPC registration](../../portal/src/main.ts), [server-side Portal registry](../../server/src/portal/registry.ts))

The module's public interface should expose application operations—discover agents, open/load a session, prompt, cancel, answer permission requests, and subscribe after an event cursor—while keeping ACP JSON-RPC, subprocess supervision, registry/install details, and host capabilities behind the seam. Two launcher implementations make the seam real: direct local process launch for a Portal beside the workspace, and `ssh -T` launch for a client that has no Portal on the target. The front end should consume a normalized, ordered session-event stream rather than raw ACP messages.

This placement has three useful locality properties:

- agent credentials and native configuration remain on the execution host;
- ACP filesystem and terminal requests can use Portal's scoped host services without bouncing through Zed's remote Project model; and
- an app or browser disconnect need not terminate the ACP child, provided Portal owns its lifecycle and the server can replay persisted session events after a cursor.

That last property would be a Weave feature, not something ACP or Zed gives automatically. The host must record prompt attempt state explicitly so a lost connection is reported as interrupted or uncertain rather than silently replayed. This recommendation is an architectural fit assessment, not an implementation specification.

### Why direct reuse of the private protocol is poor leverage

Implementing Zed's private remote RPC buys only agent discovery/install and command resolution. It still leaves the entire ACP client, UI reducer, permissions, filesystem/terminal bridge, authentication, persistence, and lifecycle work. It also pulls in:

- lockstep protocol/binary versioning;
- the large generated `Envelope` union and Zed-specific entity routing;
- acknowledgement/replay/reconnect behavior;
- remote project, settings, worktree, registry, and process-management concepts; and
- provisioning of the matching `zed-remote-server` executable.

The relevant Rust crates are workspace-private (`publish = false`) and licensed GPL-3.0-or-later. ([workspace publication policy](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/Cargo.toml#L267-L268), [`proto` crate metadata](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/proto/Cargo.toml#L1-L7), [`remote` crate metadata](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/remote/Cargo.toml#L1-L7), [`agent_servers` crate metadata](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/crates/agent_servers/Cargo.toml#L1-L7), [repository licensing overview](https://github.com/zed-industries/zed/blob/282f47a544b72030c8a162955415c8def655d76a/README.md#L30-L39)) Copying or linking this implementation has licensing consequences that should be reviewed for the intended distribution model; this research does not provide legal advice. Independently implementing public ACP avoids depending on these private Rust crates, though the chosen ACP library and agent binaries still require their own license review.

## Feasibility boundary

The proposed lightweight app is feasible if “the same way as Zed” means:

- discover/configure a set of external ACP agents;
- start them on a remote host;
- create, list, load, resume, and close supported sessions;
- stream content, thoughts, plans, tool calls, and usage;
- mediate permissions, authentication, elicitation, files, terminals, and MCP; and
- retain enough metadata to return to an agent-owned session.

It is **not** protocol-equivalent to Zed proper in three areas:

1. Zed's native built-in agent is not exposed through the remote or ACP protocols.
2. Zed's full remote Project service supplies sophisticated buffers, worktrees, terminals, settings, and filesystem semantics that a lightweight client must replace or deliberately narrow.
3. Zed's ACP library package is pinned to 2.0.0 with unstable features while its negotiated wire version is v1, so package pinning, capability negotiation, compatibility tests, and explicit upgrade work are necessary even at the public seam.

The best first proof is therefore deliberately narrow: launch one known ACP agent over `ssh -T`, implement initialize/new-session/prompt/session-update/cancel plus permissions, and persist the remote ACP session ID. Add remote filesystem and terminal client services only after defining their security and path-scoping model. Registry-based installation can be layered on separately; there is little reason to emulate `GetAgentServerCommand` or the rest of `zed-remote-server` unless compatibility with Zed's private remote workspace itself becomes an explicit product requirement.
