# Direct Host and ACP interoperability specification

Status: Proposed for WVE-38 on 2026-08-23

Canonical issue: [WVE-38: Direct host daemon with remote ACP and workspace access](https://linear.app/jacobfvanzyl/issue/WVE-38/direct-host-daemon-with-remote-acp-and-workspace-access)

Research basis:

- [ACP v1 extensibility](https://agentclientprotocol.com/protocol/v1/extensibility)
- [Open-source ACP agents and remote transports](../research/open-source-acp-agents-and-remote-transports.md)
- [Zed remote agent protocol](../research/zed-remote-agent-protocol.md)
- [Zed remote server and localhost](../research/zed-remote-server-and-localhost.md)
- [ACP tool provisioning](../research/acp-tools.md)

## Purpose

This specification replaces Weave's central-server runtime path with direct
client connections to a Host Daemon. The daemon owns Workspace access, Agent
Runtime supervision, Terminal sessions, and the durable state required to
resume work after a client disconnects.

The design has two independent interoperability goals:

1. An ordinary ACP client, including Zed, can use a Host-managed agent without
   learning a Weave protocol.
2. Weave web, desktop, mobile, and TUI clients can use the same Host directly
   for ACP Threads, files, and persistent terminals.

The words **must**, **must not**, **should**, and **may** are normative.

## Compatibility facts

These facts constrain the design and must remain visible in implementation and
product claims.

- Stable ACP v1 defines newline-delimited JSON-RPC over stdio. Streamable HTTP
  and WebSocket remain a draft RFD as of this specification.
- Zed's configurable External Agent interface launches a command and speaks
  stable ACP over that command's stdio. Zed does not currently expose a generic
  remote ACP URL setting.
- In a Zed remote project, Zed resolves and starts the External Agent command on
  the remote machine through SSH, then speaks ACP over the command's piped
  stdio. Zed's private remote-project protocol is not the ACP transport.
- ACP defines agent-to-client filesystem and terminal requests. It does not
  define a general remote editor filesystem or interactive user-terminal
  protocol.
- Zed's remote project, filesystem, and terminal implementation is private,
  version-coupled to the matching Zed client, workspace-private Rust code, and
  GPL-3.0-or-later. It is useful as a behavioral reference, not as Weave's
  public wire contract.

Weave must therefore describe the stdio connector as the stable ACP interface,
the `/acp` WebSocket endpoint as draft-compatible and experimental, and the
Weave Host Protocol as a separate product interface.

## Target topology

```text
Zed local UI
  │ Zed Remote Project over SSH
  ▼
Zed remote process launcher
  │ stdio ACP v1
  ▼
weave-host acp connect
  │ local authenticated daemon channel
  ▼
Host Daemon ───────── stdio ACP v1 ───────── ACP Agent
  │                                          ├─ codex-acp
  │                                          ├─ opencode acp
  │                                          └─ other allowlisted agents
  │
  ├─ Workspace files, watches, Git, LSP, Jupyter
  ├─ persistent tmux-backed Terminal sessions
  ├─ Agent Runtime supervision and session bindings
  └─ host-local durable catalog and event journal

Weave client
  ├──────── WSS /rpc (Weave Host Protocol) ──┘
  └──────── WSS /acp (draft Remote ACP) ─────┘
```

The central Weave server is not in the steady-state request path and is not an
authority for Hosts, Workspaces, Threads, Agent Runtimes, files, or terminals.
Discovery or relay services may be added later, but losing such a service must
not stop an already paired client from reaching a Host.

## Host authority and durable ownership

Each Host Daemon is authoritative for:

- its stable Host identity and paired principals;
- its allowlisted Workspace roots and Workspace identities;
- its installed Agent definitions and Agent Runtime processes;
- the mapping from a Weave Thread to agent kind, ACP session ID, Workspace, and
  current runtime generation;
- persistent Terminal session identity and attachment state;
- ordered ACP session events needed for Weave-client replay; and
- security audit records for pairing, connection, permission, process, file,
  and terminal actions.

Clients own credentials that prove a paired principal and local presentation
state. An agent remains authoritative for its provider-native transcript and
provider session. The Host stores only the mapping and normalized events needed
for continuity; it must not claim that an ACP `session/load` or
`session/resume` operation can recover an in-flight turn unless the selected
agent explicitly provides that guarantee.

The first release supports one Host at a time per client view. Cross-Host
search, replication, and shared mutation are out of scope.

## Interfaces

### Stable ACP stdio connector

`weave-host acp connect` is the compatibility interface for Zed and any other
standard ACP client. It must:

- read and write exactly one newline-delimited JSON-RPC message per line;
- never write logs or non-protocol output to stdout;
- write diagnostics only to stderr;
- forward ACP v1 messages without adding required Weave-specific fields;
- preserve request IDs, notification ordering, cancellation, and error objects;
- terminate when stdin closes and release its client attachment; and
- derive authentication from Host-local configuration rather than placing a
  bearer token in Zed settings or process arguments.

The connector selects an allowlisted Agent by stable ID. It must not accept an
arbitrary executable, argument list, or environment from a remote ACP client.
Unless an explicit Workspace ID is supplied for automation or diagnostics, the
connector sends its current working directory as an untrusted candidate. The
Host canonicalizes that path, selects the narrowest configured root containing
it, authorizes the principal, and launches the Agent in the candidate directory.
Missing paths, symlink escapes, and paths outside every configured root fail
closed without revealing configured Workspace IDs or paths.

The ordinary Zed configuration must not contain a host-specific Workspace ID,
socket path, config path, or executable path. Each host instead provides the
same installation contract: `weave-host` on `PATH`, canonical per-user config
at `~/.config/weave/portal/config.json`, a socket at
`${XDG_STATE_HOME:-~/.local/state}/weave-host/host.sock`, and stable logical
Agent IDs.

A Zed custom-agent entry has this shape when used inside a Zed remote project:

```json
{
  "agent_servers": {
    "weave-codex": {
      "type": "custom",
      "command": "weave-host",
      "args": ["acp", "connect", "--agent", "codex"]
    }
  }
}
```

Zed then remains the ACP client. Its own project-backed filesystem and terminal
handlers satisfy agent-to-client requests, including unsaved editor buffers and
remote project semantics. The Host gateway must delegate those requests to Zed
when the upstream client advertises the corresponding capabilities.

### Draft Remote ACP endpoint

The Host may expose `GET /acp` with WebSocket upgrade according to the current
ACP Streamable HTTP and WebSocket RFD. This endpoint is experimental until ACP
publishes a stable network transport.

For the WebSocket form:

- the successful upgrade returns `Acp-Connection-Id`;
- all messages are JSON-RPC WebSocket text frames;
- `initialize` is the first protocol message;
- binary frames are rejected or ignored as required by the active RFD;
- one connection may own multiple ACP sessions when the negotiated agent does;
- closing the connection releases its controller lease; and
- no unprefixed Weave-only method is added to the ACP namespace.

Authentication happens before ACP initialization. The connection ID is routing
state and must never be treated as a credential. The exact RFD revision and ACP
schema commit used by a build must be recorded in the Host capabilities result
and conformance tests.

If the RFD changes incompatibly, only this adapter changes. The Agent Runtime
module and stable stdio connector remain unchanged.

#### Weave Thread event extension

Weave-native clients may opt into a replay extension without changing the ACP
behavior required by ordinary clients. This uses ACP v1's standard extension
points: namespaced `_meta` values and methods beginning with `_`.

- The proxied `initialize` result advertises `agentCapabilities._meta["weave.dev"].threadEvents`
  with extension version `1`, the acknowledgement method, and the sync
  notification name. Clients must ignore the extension when it is absent.
- A native `session/load` includes
  `params._meta["weave.dev/threadEvents"].afterSequence`. A non-negative integer
  requests only later retained events. `null` requests an explicit full reload.
  Omitting the metadata retains ordinary ACP full-load behavior.
- Replayed and live journal events include their stable `sequence`, `eventId`,
  and `createdAt` under `update._meta["weave.dev/threadEvent"]` for opted-in
  clients only. The underlying provider event remains unchanged in the journal.
- `_weave.dev/thread_events/sync` establishes the authoritative last sequence
  after replay. `fullReload: true` means provider replay was required because
  the Host journal no longer contained the complete transcript.
- `_weave.dev/thread_events/ack` accepts `{ sessionId, sequence }` and advances
  that connection's acknowledgement monotonically.
- A numeric cursor below the journal's durable compaction watermark fails
  with JSON-RPC code `-32060` and `data.code = "RESUME_GAP"`. The client must
  discard its partial projection and retry with `afterSequence: null`; the Host
  never fills a gap with only the retained suffix.

Zed does not negotiate this extension. It continues to receive valid ACP
`session/update` notifications and full `session/load` replay without needing
to know about Host sequences or acknowledgements.

### Weave Host Protocol

The Host exposes `WSS /rpc` for Weave-specific capabilities that ACP does not
provide as a remote workspace interface. It is a versioned, typed JSON-RPC
protocol derived from the existing Weave protocol package.

Its first implemented capabilities are:

- `host.capabilities.get` and connection heartbeat;
- Workspace listing and resolution from an opaque Workspace ID;
- file list, read, hash, write, move, create, delete, index, and watch;
- Terminal list, create, snapshot, attach, input, resize, detach, and close;
- Agent definition and availability listing; and
- Thread-to-ACP-session binding and ordered event replay for Weave clients.

Callers identify a Workspace by Host-issued ID. A remote client must not submit
an absolute Host path as an authority-bearing target. Paths within a Workspace
are slash-separated relative paths.

ACP messages never travel inside a Weave Host Protocol envelope. A Weave client
that uses Remote ACP opens `/acp`; it uses `/rpc` only to implement its remote
Workspace UI and any ACP client callbacks that must execute on the Host.

## Agent Runtime module

The Agent Runtime module is the deep module at the child-process seam. Its
external interface is intentionally small:

```ts
type AgentRuntimeManager = {
  attach(input: {
    agentId: string;
    workspaceId?: string;
    workspacePath?: string;
    principalId: string;
    transport: 'stdio' | 'remote-acp';
  }): Promise<AgentAttachment>;
};

type AgentAttachment = {
  receive(message: JsonRpcMessage): Promise<void>;
  close(reason?: string): Promise<void>;
  readonly messages: ReadableStream<JsonRpcMessage>;
  readonly finished: Promise<{
    success: boolean;
    code: number;
    signal?: string;
    error?: string;
    stderrTail: string;
  }>;
};
```

An attachment supplies exactly one of `workspaceId` or `workspacePath`. The
path form is an untrusted local-connector candidate and is resolved to an
authorized Workspace by the Host before an Agent process starts.

The implementation hides command resolution, spawning, ACP initialization,
request-ID correlation, child stderr, runtime generations, session bindings,
event journaling, leases, and cleanup. Transport adapters and tests use the same
interface. Internal adapters may vary for real subprocesses and deterministic
fake agents; callers must not depend on those internal seams.

### Agent definitions

An Agent definition includes a stable ID, display name, executable, fixed
arguments, permitted environment variable names, installation probe, supported
platforms, and expected ACP protocol range. Initial definitions are:

- `codex`: `@agentclientprotocol/codex-acp`;
- `opencode`: `opencode acp`; and
- a deterministic fake used only by tests.

Definitions may locate an already installed executable or invoke an explicitly
configured package runner. Installation is an administrator action, never a
side effect of an unauthenticated connection.

### Supervision and continuity

- A child process belongs to one runtime generation and one Agent definition.
- Process exit records the exit status and bounded stderr tail, fails pending
  requests without closing attached client streams, and emits an ordered
  runtime-state notification to Weave-native clients.
- The daemon uses bounded exponential backoff only for a runtime marked
  restartable; it must not blindly replay a prompt after uncertain delivery.
- Every accepted prompt has an idempotency key at the Weave layer. ACP itself
  does not make prompts idempotent.
- The Host persists Thread, Agent ID, Workspace ID, ACP session ID, runtime
  generation, last event sequence, and current controller lease.
- Reconnection first attempts capability-gated `session/resume`, then
  `session/load` when supported. Otherwise it exposes an explicit cannot-resume
  state instead of inventing continuity.
- A logical hosted runtime outlives a failed provider process. Each replacement
  process receives a new durable generation; responses and notifications from
  an obsolete generation are ignored. Provider transcript replay produced by
  recovery `session/load` is suppressed because the Host journal remains the
  client-facing replay authority.
- An interrupted `session/prompt` fails with `PROMPT_UNCERTAIN`. Recovery never
  submits that prompt again; explicit prompt-operation idempotency remains a
  separate Weave-native concern.
- A detached runtime may continue only when no client request or permission is
  pending. Pending permissions default to cancellation or denial when the
  controller lease expires.

## Filesystem and terminal behavior

The existing Portal filesystem, watch, execution-policy, and tmux Terminal
implementations become internal Host Daemon modules. Their behavior is reused;
the current outbound-to-server wiring is replaced by inbound Host adapters.

### Filesystem

- An administrator configures allowed roots using canonical real paths.
- A Workspace is bound to exactly one allowed root or a descendant selected by
  policy.
- Every operation resolves the candidate path and rejects traversal or symlink
  escape before reading or mutating.
- Write operations retain the current hash/version precondition and atomic
  replacement behavior.
- Watch events are ordered per watch attachment and include a resync signal
  after overflow or reconnect.
- ACP filesystem requests are delegated to the connected ACP client when it
  advertises the capability. A Weave client implements that callback through
  the Host Protocol; Zed uses its own Project implementation.

### Terminals

- The Host retains tmux as the initial persistent Terminal adapter.
- A Terminal belongs to one Workspace and has a stable Host-issued identity.
- Attach returns a fresh snapshot followed by ordered live output, preserving
  the existing attach-time race guarantees.
- Detach does not close the shell. Close is explicit and authorization checked.
- Terminal input, resize, and close require a controller attachment; observers
  may receive snapshots and output but cannot mutate the session.
- ACP tool terminals and user Terminal Panes are separate Terminal kinds even
  when they share the same tmux implementation.
- Zed ACP terminal requests are delegated to Zed when Zed advertises terminal
  capability. Weave ACP terminal callbacks use the Host Terminal module.

## Authentication, transport security, and trust

The daemon binds to loopback by default. A non-loopback listener must refuse to
start unless secure transport is configured or an explicit private-network
mode is enabled.

The first supported remote deployment uses Tailscale reachability plus TLS.
Tailscale identity narrows network reachability but does not replace Host
authorization.

### Pairing

1. An administrator starts a time-limited pairing flow on the Host.
2. The client presents a one-time pairing secret over TLS.
3. The Host issues a revocable credential bound to a stable principal and
   records its fingerprint, creation time, and last use.
4. Subsequent `/rpc` and `/acp` connections authenticate before protocol
   initialization.

Long-lived secrets must not appear in URLs, command-line arguments, process
listings, logs, or committed configuration. Browser clients use a secure,
HTTP-only, same-site Host cookie. Native clients may use an authorization
header. The local stdio connector reads a mode-0600 Host-local credential or
uses a local operating-system IPC credential.

### Authorization

Authorization is checked for every Workspace, Agent, file mutation, Terminal
mutation, permission response, and controller-lease transition. Authentication
alone grants no Workspace access.

The daemon must:

- expose only configured roots;
- use canonical paths and reject symlink escapes;
- filter child environments to a definition allowlist;
- avoid inheriting server or daemon secrets into Agent Runtime processes;
- bound frames, queues, journals, process counts, Terminal counts, and retained
  stderr;
- validate browser origins; and
- record security-relevant decisions without recording credentials or raw
  secret values.

## Concurrency, ordering, and reconnect

- Every Host Protocol connection has a unique connection ID that is not a
  credential.
- Every Thread event has a monotonically increasing sequence scoped to that
  Thread and a stable event ID.
- Replayed events retain their original sequence and event ID.
- A client acknowledges its last applied sequence. Gaps force replay or a full
  session load before new live events are applied.
- Exactly one principal connection holds the controller lease for a Thread or
  mutable Terminal attachment. Other authorized connections are observers.
- Lease transfer is explicit and compare-and-set against the current lease
  generation.
- Disconnect starts a bounded lease grace period. After expiry, pending
  permissions are denied and mutation attempts from the old generation fail.
- File writes and prompt starts carry idempotency keys. Duplicate completed
  operations return the recorded result; uncertain prompt delivery is surfaced
  as uncertain and is never silently repeated.

## Capability negotiation

The Host returns capability identifiers with independent versions, including:

- `weave.host.workspace-files.v1`;
- `weave.host.terminals.v1`;
- `weave.host.agent-runtime.v1`;
- `weave.host.thread-events.v1`;
- `acp.stdio.v1`; and
- `acp.remote.websocket.draft.<rfd-revision>`.

Clients render only capabilities they negotiated. Missing optional capability
does not make the entire Host unusable. Agent-specific ACP capabilities remain
those returned by the selected agent and are not promoted to Host-wide
guarantees.

## Failure behavior

- Authentication failure closes before protocol initialization with no Host or
  Workspace metadata disclosure.
- An unknown Workspace ID is indistinguishable from an unauthorized Workspace
  to the remote principal.
- Agent spawn failure returns a stable unavailable result plus an audit ID; it
  does not leak the full environment.
- A lost ACP transport releases its attachment and controller lease according
  to the grace policy. It does not imply that an agent-native session was
  deleted.
- A lost Host Protocol connection leaves persistent Terminal sessions running
  and file state intact.
- Journal overflow forces `session/load` or explicit resynchronization.
- Host shutdown stops accepting connections, drains bounded writes, releases
  children according to policy, and leaves enough state for an explicit next
  startup recovery decision.

## Initial vertical proof

The first implementation is intentionally narrower than the target and must be
clearly marked experimental. It is complete when all of the following pass:

1. The Host Daemon accepts an authenticated loopback connection and rejects a
   missing or wrong credential before ACP initialization.
2. A stdio connector configured as a Zed custom agent reaches the daemon and
   completes ACP `initialize`, `session/new`, `session/prompt`, streamed
   `session/update`, and cancellation against the deterministic fake agent.
3. The same connector completes a real prompt through `codex-acp` and through
   `opencode acp`, recording the exact versions used.
4. A test Workspace can list, read, hash, write with a precondition, and watch a
   file through the inbound Host Protocol without escaping its configured root.
5. A tmux Terminal survives client detach, returns a fresh attach snapshot,
   streams new output without a snapshot/live gap, accepts input and resize,
   and closes explicitly.
6. A dropped client reconnects, resumes from its last acknowledged event, and
   does not duplicate a completed prompt or file write.
7. Zed uses its native remote-project file and terminal callbacks through the
   standard ACP connector; no Zed-private RPC implementation is present in
   Weave.
8. One global Zed custom Agent entry works unchanged for a local project and a
   Zed SSH Remote project. The Host selects the Workspace from the connector's
   current directory, while a directory outside every configured root fails
   closed without Workspace discovery.

Real-agent credentials are supplied by the operator's existing agent setup and
must not enter test fixtures or logs. Automated tests use the fake agent.

### Implementation checkpoint: 2026-08-23

The first landed slice provides:

- an allowlisted Agent Runtime process module with bounded ACP messages and
  stderr, a cleared child environment, controlled shutdown, and an injectable
  subprocess adapter;
- a mode-`0600` local Unix-socket gateway owned by the Host Daemon;
- an ACP-only stdio connector suitable for a Zed custom External Agent;
- an authenticated loopback `/acp` WebSocket implementing the current draft's
  text-frame, initialize-first, connection-ID, and disconnect cleanup behavior;
- a deterministic fake Agent that passes initialize, new-session, prompt,
  streamed update, terminal response, and rejection tests; and
- a compiled two-process smoke test plus a live initialize handshake with
  `@agentclientprotocol/codex-acp` 1.6.2.

This checkpoint is not the complete vertical proof. Subsequent WVE-40 work
added the durable normalized event journal, replay cursors, compaction and
resynchronization path, durable runtime generations, and transparent provider
replacement behind a still-open logical client attachment. Local tests and a
Bazzite run proved idle recovery, interrupted-stream uncertainty, obsolete
generation fencing, and a fresh prompt after recovery. OpenCode, inbound Host
files and terminals, durable native prompt idempotency, controller leases,
pairing, and TLS packaging remain open.

## Migration sequence

1. Extract Portal's filesystem, Terminal, execution-policy, lifecycle, and
   binary-transfer implementations from the outbound connection loop without
   changing behavior.
2. Add the Agent Runtime module and deterministic fake agent behind its one
   external interface.
3. Add the local authenticated daemon channel and stable stdio ACP connector.
4. Prove Zed compatibility over a Zed remote project.
5. Add authenticated inbound Weave Host Protocol adapters for Workspace files
   and terminals.
6. Add draft `/acp` WebSocket behind an experimental capability flag.
7. Add the host-local Thread/session catalog, journal, leases, and reconnect.
8. Migrate one Weave client shell to a capability-driven Host connection.
9. Migrate remaining clients, then remove central-server Portal routing and the
   server-owned Agent path only after equivalent data is exported or explicitly
   discarded.

Each step must keep the existing path operational until its replacement has
focused tests and a runnable acceptance path. Migration must not reinterpret
the current central server as a hidden relay.

## Non-goals

- Implementing or embedding Zed's private remote-project protocol.
- Claiming the draft ACP network transport is stable.
- Allowing clients to upload arbitrary Agent commands or environments.
- Cross-Host replication, multi-user collaboration, NAT traversal, or a public
  relay in the first release.
- Automatic replay of a prompt whose delivery or completion is uncertain.
- Migrating existing Weave clients before the vertical proof passes.

## Open decisions before non-loopback release

- Whether the packaged Host terminates TLS itself or requires Tailscale Serve or
  another explicitly supported reverse proxy.
- Credential format and storage for native clients, including revocation UX.
- Lease grace duration and whether read-only observation is enabled initially.
- Host-local persistence engine and retention limits for events and audit data.
- The exact ACP remote RFD commit to implement behind the experimental flag.

These decisions do not block the authenticated loopback proof. They do block a
claim that the Host is safe for direct non-loopback exposure.
