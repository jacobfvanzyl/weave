# WVE-85: The weave Host protocol

Status: Proposed, 2026-10-11

Issue: [WVE-85: Make the weave daemon the Host, with its own client protocol](https://linear.app/jacobfvanzyl/issue/WVE-85/make-the-weave-daemon-the-host-with-its-own-client-protocol)

Decision: [ADR 0008](../../../docs/adr/0008-weave-daemon-is-the-host.md). Glossary: [`tui/CONTEXT.md`](../../CONTEXT.md).

The words **must**, **must not**, **should** and **may** are normative.

## Purpose

The weave daemon is the Host. Today it presents itself to clients as an ACP agent, which
ties each connection to one agent and puts attaching, shared sessions, Host-run terminals
and Host management into `_weave/*` extensions and `_meta`. This spec replaces that client
side with a protocol of our own:

- one connection reaches every session on the Host, across agents and directories;
- clients attach to a session and catch up from the last journal position they saw;
- pending requests are Host objects that every attached client sees;
- the Host decides which agents exist and how they run;
- connections authenticate, and versions are negotiated.

ACP stays where the adapters need it, between the Host and its agents, and ACP's content
types are the payload of this protocol. Portal, `product/protocol` and ADR 0001 are
reference material only (ADR 0008); nothing here depends on them.

## Scope

In scope:

- the protocol (`host/*`, `agents/*`, `sessions/*`, `session/*`, `turn/*`, `pending/*`)
  over the Unix socket and over an in-process channel (`--no-daemon`);
- moving agent resolution (presets, agent config, registry, MCP servers, the agent
  environment) from the CLI into the Host;
- journal positions, so clients catch up rather than replay everything;
- the TUI, `weave run`, `weave sessions` and `weave daemon` as clients of it;
- removing the Host's ACP face and the `_weave/*` extension;
- installing the Host as a launchd user agent.

Out of scope, each for a later issue:

- a WebSocket listener, pairing and token issuance;
- Host methods for clients that aren't on the Host's computer: file search, file reads,
  shell commands;
- a Host-wide feed of session changes, for session lists that update live;
- the Capacitor app as a client.

## Topology

```text
TUI · weave run · weave sessions · weave daemon        (later) iPad app
                 │                                            │
   Host protocol over the Unix socket              Host protocol over
   (in-process with --no-daemon)                   a WebSocket
                 └──────────────────┬─────────────────────────┘
                                    ▼
                        Host (`weave daemon run`)
                                    │
                 ACP v1 over stdio, one agent process per open session
                                    ▼
        claude-agent-acp · codex-acp · gemini · configured and registry agents
```

`weave smoke`, `weave login` and `weave logout` keep talking to agents directly, using the
same agent resolution as the Host (see [Crates](#crates)).

## Principles

1. **ACP content is the payload.** Wherever this protocol carries something an agent
   produced or consumes, it carries ACP's JSON for it unchanged: `SessionNotification`,
   `ContentBlock`, `PromptResponse`, `RequestPermissionRequest` and its response,
   `CreateElicitationRequest` and its response, `SessionModeState`, `SessionConfigOption`,
   `SessionInfo`, `InitializeResponse`. The Host parses them with the pinned ACP schema
   crate, so the payload is ACP as that crate defines it.
2. **The Host decides what runs.** Clients name an agent by id and a directory. They never
   send a command, an environment, MCP server definitions or a path for the Host to write.
3. **Requests flow one way.** Clients send requests; the Host sends responses and
   notifications, never requests. A client needs no JSON-RPC server.
4. **One stream per session.** Everything about one session reaches a client in the order
   the Host produced it.

## Transport and framing

Messages are JSON-RPC 2.0, UTF-8. Batches aren't used.

| Transport | Framing | Authentication |
| --- | --- | --- |
| Unix socket | One message per line (newline-delimited JSON) | `local` |
| In-process channel (`--no-daemon`, tests) | One message per item | `local` |
| WebSocket (later) | One message per text frame | `token` |

The socket and its directory stay where they are (`DaemonPaths`): mode 0600, in a 0700
directory, with one Host per directory guarded by `daemon.lock`.

## Connections

### `host/hello`

The first request on every connection. Until it succeeds, the Host answers every other
request with `unauthenticated`.

```json
{"jsonrpc": "2.0", "id": 1, "method": "host/hello", "params": {
  "protocol": {"min": 2, "max": 2},
  "client": {"name": "weave-tui", "version": "0.1.0"},
  "auth": {"method": "local"},
  "capabilities": {"terminalSignIn": true}
}}
```

```json
{"jsonrpc": "2.0", "id": 1, "result": {
  "protocol": 2,
  "clientId": "c7",
  "host": {"version": "0.1.0", "pid": 4242, "startedAt": 1760180000000},
  "features": [],
  "acp": {"protocolVersion": 1, "unstable": ["session_compaction", "subagents"]}
}}
```

- `protocol` is the range of major versions the client speaks. The Host answers with the
  highest version both support, or fails with `incompatible_protocol`, whose `data` gives
  the Host's own range. See [Versioning](#versioning).
- `auth` is checked against the transport. `local` succeeds only on the Unix socket or
  in-process, and only when the socket's peer has the Host's own user id (`getpeereid`,
  checked when it connects), on top of the socket's file mode. `token` is reserved for the
  WebSocket and fails with `unauthenticated` until that exists. A client that hasn't said a
  successful hello gets `unauthenticated` for everything else.
- `capabilities.terminalSignIn` says the client can run an agent's sign-in command in a
  terminal on the Host's computer. Only `local` clients may claim it.
- `clientId` names this connection in other messages (who answered a pending request,
  who started a turn). It means nothing after the connection ends.
- `features` lists optional parts of the protocol this Host supports. Version 2 defines
  none.
- `acp` says which ACP payloads to expect: the ACP protocol version the Host speaks to
  agents and the unstable features it may pass through.

A connection ends when either side closes it. The Host detaches the client from every
session it was attached to; nothing else changes.

## Agents

### Resolution

The Host resolves an agent id exactly as the CLI does today. In order:

1. an agent defined in the config with a `command`;
2. a preset (`claude`, `codex`, `gemini`), with the config's settings for it applied;
3. an ACP registry agent, installed into the registry cache on first use, with the
   config's settings for it applied.

Config settings for an agent (`env`, `fs`, `terminal`, `compaction`, `subagents`, `mode`)
apply however it was found, as `Config::configure` does now. The Host advertises client
services to the agent from these settings alone. What the attached clients can do doesn't
affect it.

### Configuration

The config file becomes `~/.config/weave/config.toml` (`$XDG_CONFIG_HOME` honoured),
replacing `tui.toml`. While only `tui.toml` exists, the Host and clients read it instead and
say once that it should be renamed. The file is owned by section:

| Section | Read by |
| --- | --- |
| `default_agent`, `[agents.*]`, `[[mcp_servers]]` | the Host |
| `[tui]`, `[daemon]` | clients on the same computer |

The Host reads its sections whenever it resolves an agent, so edits apply to the next
session without a restart. `weave daemon run --config <file>` points the Host at another
file. A client's `--config` selects the file for its own sections; with `--no-daemon` the
in-process Host uses the same file. When a client runs on another computer, the Host
sections of that computer's file do nothing.

MCP servers come from the config only. When a session opens, the Host passes the ones the
agent's `mcpCapabilities` accept and reports the others in the session's `notices`.

### Environment

Agents start in the session's directory (as `instance.rs` does now, with `PWD` set) with an
environment built from three layers, later layers winning:

1. the Host process's own environment;
2. the user's login shell environment, captured when the Host starts by running
   `$SHELL` as an interactive login shell and reading its environment. Capture must time
   out (10 seconds) and fall back to layer 1 alone, logging why;
3. the agent's `env` from the config.

A Host started by launchd has almost no environment of its own, so layer 2 gives agents
the user's `PATH` and other settings. A Host the CLI starts also keeps whatever the
starting terminal exported. `weave daemon restart` captures again. The environment is never
written to disk or sent to a client.

### Methods

**`agents/list`** `{includeRegistry?: bool, refresh?: bool}` →
`{agents: AgentSummary[], defaultAgent?: string}`

Presets and configured agents, plus registry agents when asked; `refresh` fetches the
registry catalog again.

```ts
type AgentSummary = {
  id: string;
  name: string;            // the agent's title when known, else the id
  source: "preset" | "config" | "registry";
  version?: string;        // pinned preset or registry version
  installed: boolean;      // false for a registry agent not yet downloaded
  description?: string;
};
```

**`agents/get`** `{agentId}` → `{agent: AgentSummary, initialize: InitializeResponse}`

What the agent says about itself: capabilities, prompt capabilities and sign-in methods.
The Host answers from its cache of `initialize` responses, or starts the agent to ask.

**`agents/authenticate`** `{agentId, methodId}` → `{}`

Runs ACP `authenticate` with that method. A terminal method fails with `requires_terminal`.

**`agents/terminalSignIn`** `{agentId, methodId}` → `{command, args, env}`

For a client that claimed `terminalSignIn`: the command to run in its own terminal for a
terminal sign-in method, with only the agent's configured and the method's own variables
in `env`. The Host stops its idle agent processes for that agent, so the next ones start
signed in. Other clients get `requires_terminal`, and should tell the person to run
`weave login <agent>` on the Host's computer.

**`agents/logout`** `{agentId}` → `{}`

When any request needs an agent that requires sign-in, it fails with ACP's
`auth_required` error (code -32000), passed through from the agent, and the client
signs in and retries.

### Agent processes

Each open session has its own agent process, and subagent sessions share their parent's.
For everything else (`agents/get`, sign-in, listing and deleting sessions) the Host uses an
open session's process for that agent when there is one. Otherwise it starts a spare one,
which the next session for that agent and directory takes, and which stops after a minute
unused.

## Sessions

### Identity and states

A session's id is the agent's own ACP session id. Subagent sessions are reached through
their parent: the Host routes requests for them to the parent's process, and their events
go into the parent's journal.

| State | Meaning | Becomes |
| --- | --- | --- |
| open | The Host holds it and its agent runs. | closed when nothing needs it for the idle grace (30 minutes; a minute for a blank session), when it's closed, or when its agent exits; suspended when the Host stops |
| suspended | It was open when its Host stopped. Its journal is still open. | open when a client attaches or runs a turn in it |
| closed | The Host no longer holds it. | open again when a client attaches, if the agent can resume or load it |

A session is needed while a client is attached to it, a turn runs in it, or a pending
request waits in it. A blank session stops being blank at its first prompt; until then
it isn't listed, and it is closed rather than suspended, with its journal removed, when
the Host stops. A headless session is one whose permission policy answers without asking.

### `SessionState`

What attaching answers with, and what a client keeps up to date from notifications.

```ts
type SessionState = {
  sessionId: string;
  agent: { id: string; name: string; initialize: InitializeResponse };
  cwd: string;
  additionalDirectories: string[];
  title?: string;
  state: "open";
  activity: "idle" | "running" | "waiting";   // waiting: a pending request is unanswered
  clients: number;                             // attached now, this client included
  blank: boolean;
  policy: PermissionPolicy;                    // { approve: ToolKind[], otherwise: "ask" | "reject" }
  modes?: SessionModeState;
  configOptions: SessionConfigOption[];
  turns: { sessionId: string; startedAt: number; origin: TurnOrigin }[];
  pending: PendingRequest[];
  subagents: string[];                         // subagent session ids so far
  journal: { id: string; head: number };       // the position of the last event written
  notices: string[];                           // e.g. skipped MCP servers
  trace?: string;                              // where the Host writes this session's trace
};
```

### Methods

**`sessions/list`** `{agentId?, cwd?, cursor?}` → `{sessions: SessionListing[], nextCursor?}`

- Without `agentId`: the sessions the Host has a journal for, across agents (open,
  suspended and closed), most recently active first. No agent is started. Paging isn't
  needed.
- With `agentId`: that agent's sessions. The Host's own sessions of it in `cwd` lead the
  first page: open ones, then suspended ones within the idle grace of their last activity.
  The agent's own ACP `session/list` follows, paged by its cursor, without the sessions
  already listed.
- Blank sessions are never listed.

```ts
type SessionListing = {
  info: SessionInfo;            // ACP: sessionId, cwd, title, updatedAt, _meta
  agentId: string;
  state: "open" | "suspended" | "closed";
  activity?: "idle" | "running" | "waiting";   // open sessions only
  clients: number;
  headless: boolean;
  lastActivityAt?: number;
};
```

**`session/create`** `{agentId, cwd, additionalDirectories?, mode?, policy?, trace?}` →
`SessionState`

Starts a session and attaches the client to it. The session starts in `mode` if given,
otherwise in the agent's configured `mode`. `policy` defaults to asking. Extra directories
the agent can't accept are dropped and reported in `notices`. With `trace`, the Host writes
the agent's protocol trace under its own directory and says where in `trace`.

**`session/attach`** `{sessionId, after?: {journal, seq}, agentId?, cwd?, trace?}` →
`SessionState & {replay: {from: number, reset: boolean}}`

Attaches the client to a session, opening it first if needed:

- open: attach.
- suspended: resume it in its agent (ACP `session/resume`, or `session/load` with the
  agent's replay discarded when it can't resume), continuing its journal. Turns that were
  running when the Host stopped are journaled as ended, cancelled.
- closed: open it in its agent with ACP `session/load`, whose replay fills a new journal,
  or with `session/resume` and an empty new journal when the agent can't load.
- unknown to the Host (from an agent's listing): as closed. `agentId` and `cwd` are then
  required, or the request fails with `unknown_session`.

A session belongs to the agent it started with: naming another fails with `wrong_agent`.

After the response, the Host sends the session's events after `after`, in order, then
live events as they happen. `replay.from` is the first position it sends. When `after`
names another journal (the session was closed and opened again since) or is missing, the
Host sends everything and `replay.reset` is true; the client clears its transcript first.

**`session/detach`** `{sessionId, close?: "never" | "ifUnused"}` → `{}`

The client stops receiving the session. With `ifUnused`, the session closes now if nothing
else needs it, as the TUI does when it leaves a blank session.

**`session/close`** `{sessionId}` → `{}`

Closes the session for everyone: its turn ends, its pending requests are cancelled, its
agent's session is closed (ACP `session/close`, when supported) and its process stops.

**`session/delete`** `{sessionId, agentId?}` → `{}`

Closes the session if it's open, deletes it in the agent (ACP `session/delete`), and
removes its journal. `agentId` is required when the Host has no record of the session.

**`session/setMode`** `{sessionId, modeId}` → `{}`

**`session/setConfigOption`** `{sessionId, configId, value}` → `SetSessionConfigOptionResponse`

Passed to the agent. The change reaches every attached client, the sender included, as an
ACP `current_mode_update` or `config_option_update` in the journal.

## Journal and events

Every session has a journal: the numbered record of everything its attached clients are
sent. Its first entry (position 0) is a header that isn't sent. Events take positions 1,
2, 3 and so on. A journal has an id that changes only when the Host starts a new journal for
the session, as when a closed session is opened again. A client that remembers
`{journal, seq}` for the last event it handled can always catch up from there.

### `session/event`

```json
{"jsonrpc": "2.0", "method": "session/event", "params": {
  "sessionId": "s-1", "seq": 42, "at": 1760180001234,
  "event": {"kind": "update", "notification": {"sessionId": "s-1", "update": {
    "sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "Done."}}}}
}}
```

| `event.kind` | Fields | Written when |
| --- | --- | --- |
| `update` | `notification`: ACP `SessionNotification` | the agent sends `session/update` (for this session or a subagent session; `notification.sessionId` says which), or a client changes a mode or config option |
| `turnStarted` | `sessionId`, `prompt`: ACP `ContentBlock[]`, `origin` | a turn starts |
| `turnEnded` | `sessionId`, `response?`: ACP `PromptResponse`, `error?`: JSON-RPC error | a turn ends |
| `terminalOutput` | `terminalId`, `data` | a command the Host runs for the agent writes output |
| `terminalExit` | `terminalId`, `status`: ACP `TerminalExitStatus` | that command exits |
| `closed` | `reason` | the session closes |

`origin` is `{"client": {"name": "weave-tui", "id": "c7"}}` for a client's prompt, with the
connection's `clientId` so a client recognizes its own, or `{"run": {}}` for a headless run. Prompts are journaled in `turnStarted`, not as made-up `user_message_chunk`
updates. Terminal output an agent reports in `_meta` (`terminal_output_delta`) becomes
`terminalOutput` and `terminalExit` events and is stripped from the update, so each chunk
arrives once.

Clients must ignore event kinds they don't know, while still advancing their position.

### Other notifications

These aren't journaled. They go to the session's attached clients.

- `session/changed` `{sessionId, activity?, clients?, title?, blank?}`: fields of
  `SessionState` that changed.
- `pending/added` `{sessionId, pending: PendingRequest}`
- `pending/resolved` `{sessionId, pendingId, outcome: "answered" | "cancelled" | "withdrawn", by?: clientId}`
- `session/elicitationCompleted` `{sessionId, notification: CompleteElicitationNotification}`:
  an accepted URL elicitation's external step finished.

### Slow clients

A client that falls behind is buffered for: the ACP SDK's channels are unbounded. Once
remote clients exist, the Host should instead disconnect a client whose unsent messages
pass a limit, and let it reconnect and catch up from its position (see Later).

## Turns

**`turn/start`** `{sessionId, prompt: ContentBlock[]}` → `{seq}`

Sends the prompt to the agent and answers once the turn has started, with the position of
its `turnStarted` event. The session must be open, but the client needn't be attached.
`sessionId` may be a subagent session's. The turn's end reaches attached clients as
`turnEnded`, whoever started it. Fails with `session_not_open` or `turn_running`.

**`turn/cancel`** `{sessionId}` → `{}`

Cancels the session's running turn (ACP `session/cancel`) and cancels its pending
requests.

**`session/run`** `{agentId, cwd, sessionId?, additionalDirectories?, prompt, policy, attach?, trace?}` →
`{sessionId, state?: SessionState}`

Opens a session (`sessionId`, as attaching would, or a new one) and starts a turn in it
without the client having to stay. An open session keeps its own policy. With `attach`, the
client is attached before the prompt is sent, so it sees the whole turn, and `state` is
returned. Nobody can sign in at a terminal for a headless session, so the Host doesn't
offer agents terminal sign-in for one.

## Pending requests

```ts
type PendingRequest = {
  id: string;
  sessionId?: string;           // the session it's for, the root or a subagent session, when it's for one
  createdAt: number;
} & (
  | { kind: "permission"; request: RequestPermissionRequest }
  | { kind: "elicitation"; request: CreateElicitationRequest }
);
```

A session's permission policy answers the permission requests it can, and a policy that
rejects what it doesn't approve dismisses elicitations. Every other permission request or
elicitation becomes a pending request: in `SessionState.pending` for clients that attach
later, and announced with `pending/added` to clients attached now.

**`pending/answer`** `{sessionId, pendingId, permission?: RequestPermissionResponse, elicitation?: CreateElicitationResponse}` →
`{}`

The first answer goes to the agent and every attached client gets `pending/resolved` with
`answered`. Later answers fail with `already_resolved`. Declining or cancelling an
elicitation is an answer like any other.

A pending request also resolves when its turn is cancelled or ends (`cancelled`), or when
the agent withdraws it (`withdrawn`, from ACP `$/cancel_request`). A client detaching
doesn't resolve anything: the request waits for another client, or for one to attach.

## Host management

**`host/status`** `{}` →
`{protocol, version, pid, startedAt, service: "launchd" | "onDemand" | "inProcess", environment: "loginShell" | "process", sessions: SessionListing[]}`

`sessions` lists the open sessions.

**`host/shutdown`** `{}` → `{}`

Suspends every open session (closing blank ones) and exits.

### Running the Host

The Host is the `weave daemon run` process; the CLI keeps the `weave daemon` command.

- **On demand.** When no Host is listening, a client command starts one in the background
  as now. That Host exits after 10 minutes with no open session and no client.
- **As a service.** `weave daemon install` writes a launchd user agent that runs this
  `weave` binary's `daemon run` at login and restarts it if it exits, with no idle exit,
  logging to `daemon.log`. `weave daemon uninstall` removes it. While it's installed,
  `start`, `stop` and `restart` go through `launchctl`, and the CLI never starts a Host of
  its own. Installing again points the service at the current binary.
- **In-process.** `--no-daemon` runs a Host inside the client over an in-process channel,
  with journals in memory and traces under the system's temporary directory.

`WEAVE_DAEMON_DIR` keeps selecting another Host directory, for a development Host beside
the installed one.

## Errors

Errors are JSON-RPC errors. When the agent fails a request the Host passes on, the Host
returns the agent's error unchanged.

| Code | Name | When |
| --- | --- | --- |
| -32000 | `auth_required` (ACP's) | the agent needs sign-in; `data` as the agent sent it |
| -32601 | method not found | an unknown method, or one behind a feature the Host lacks |
| -32602 | invalid params | malformed params |
| -32060 | `unauthenticated` | no successful `host/hello`, or authentication failed |
| -32061 | `incompatible_protocol` | no common major version; `data: {min, max}` |
| -32062 | `unknown_agent` | the agent id doesn't resolve |
| -32063 | `unknown_session` | the Host doesn't know the session and wasn't told its agent and directory |
| -32064 | `session_not_open` | the request needs an open session |
| -32065 | `turn_running` | a turn already runs in the session |
| -32066 | `already_resolved` | the pending request was answered, cancelled or withdrawn |
| -32067 | `wrong_agent` | the session belongs to another agent |
| -32068 | `requires_terminal` | the sign-in method needs a terminal on the Host's computer |

## Versioning

- The protocol has an integer major version. It starts at 2; the `_weave/*` ACP extension
  was version 1.
- `host/hello` negotiates it: the client sends the range it speaks, and the Host chooses
  the highest version in both. From version 3 on, a Host supports its current major
  version and the one before it. Version 1 isn't supported; see [Cutover](#cutover).
- Within a major version, changes are additive only: new methods, notifications, event
  kinds, optional params, result fields and enum values. New methods and notifications are
  listed in `features`, so a client checks before using them.
- Receivers ignore fields they don't know. Clients ignore notifications and event kinds
  they don't know, and handle enum values they don't know (an unknown `activity`, say) with
  a fallback.
- Anything else is a new major version: removing or renaming something, changing a type or
  a meaning, or making something optional required.
- The ACP payload follows the pinned ACP schema, reported in `host/hello`. Moving to an
  ACP version whose payloads old clients can't read is a new major version too.
- Each message type has a golden JSON fixture, checked in tests, so a change to the wire
  shows up in review.

The TUI and the Host ship in one binary, so they normally agree. A TUI that meets an
incompatible Host after `weave daemon restart` `/reload`s itself into the current binary,
as it does now.

## Security

- The socket's file mode and directory, and the peer user id check, are the whole of `local`
  authentication. `local` is never accepted on a network transport.
- Clients can't make the Host run a command, set an agent's environment or write to a path
  of their choosing: the protocol has no field for any of them.
- `agents/terminalSignIn` is the only response that carries a command, and only `local`
  clients that claimed `terminalSignIn` get it.
- Journals and traces stay 0600. The agent environment is never written or sent.

Before a WebSocket listener exists, its issue must settle: binding to loopback unless
configured otherwise, checking `Origin`, TLS or a tunnel for other computers, issuing and
revoking tokens (pairing), and which directories remote clients may open sessions in.

## Clients

### The TUI

- `app.rs` talks to the Host through `weave-host-client` instead of `AgentConnection`.
  `ChatWidget` stays free of I/O and still renders ACP updates; it also takes the Host's
  turn, pending-request and terminal events.
- Permission and elicitation prompts answer with `pending/answer` and close on
  `pending/resolved`, whoever answered. The TUI no longer cancels pending requests when it
  leaves a session.
- The TUI remembers its journal position. When the Host goes away, it reconnects (never
  starting a Host), attaches again from that position and gets only what it missed. The
  Host now resumes or loads the session in its agent itself.
- Leaving a session, when the TUI quits from a blank one or switches to another, detaches
  with `ifUnused`, so a session nothing else needs closes at once, as before.
- The default mode, MCP servers and their notices, and extra directories the agent can't
  accept move to the Host. `weave --trace` asks the Host for a trace and shows its path.
- Shell mode (`!`), `@` file search, attachments and pasted images stay local. That is
  right only because the TUI runs on the Host's computer; a TUI elsewhere needs the Host
  methods listed as later work.
- Custom commands (`weave -- <command>`) can't be sent to a Host. Define the agent in the
  config, as `[agents.fake] command = "…/weave-fake-agent"`, and use `--agent fake`. With
  `--no-daemon`, `-- <command>` still works, as a config agent the in-process Host is given
  at startup.

### The CLI

- `weave run`, `weave sessions` (`cancel`, `close`) and `weave daemon status|stop` use
  `session/run`, `sessions/list`, `turn/cancel`, `session/close`, `host/status` and
  `host/shutdown`.
- `weave agents` reads the same configuration and registry through `weave-agents`, as
  `smoke`, `login` and `logout` do, so listing agents doesn't start a Host.
- `weave --resume <id>` and `--continue` choose through `sessions/list`. `--continue` keeps
  using the agent last used in the directory (`recent.rs`), a client preference.
- `weave smoke`, `login` and `logout` resolve agents with `weave-agents` and talk to them
  directly, as now.

## Crates

| Crate | Change |
| --- | --- |
| `crates/protocol` (new, `weave-host-protocol`) | The wire types, method and notification names, error codes and version constants, with golden fixtures. Depends on the ACP schema crate for payloads. No I/O. Replaces `acp-core/src/daemon_protocol.rs`. |
| `crates/agents` (new, `weave-agents`) | Agent resolution: presets, the Host's config sections, the registry catalog and installs, environment capture. Moves `cli/src/registry.rs` and the agent and MCP parts of `cli/src/config.rs`. |
| `crates/daemon` | Becomes the Host's server: `client.rs` is rewritten for the new protocol; the session task (`session.rs`) keeps its shape; journals get ids and positions; spare agent processes move from connections to the Host. |
| `crates/host-client` (new, `weave-host-client`) | The client side: connecting, `host/hello`, typed requests, per-session event streams with positions, reconnecting. Used by the TUI and the CLI. |
| `crates/acp-core` | Back to the agent side of ACP only: `daemon_protocol.rs`, the `_weave/*` handlers and `AgentEvent::{TurnRunning, SessionEnded}` go. |
| `crates/tui`, `crates/cli` | Move to `weave-host-client`, as above. |

The server and client may reuse the ACP SDK's JSON-RPC layer, which already carries
`_weave/*` methods, if it carries these methods cleanly; otherwise they use a small codec
of their own. Either way, the [SDK rules](../../AGENTS.md#sdk-rules) about handlers still
apply.

## Cutover

- The new Host answers a legacy ACP `initialize` with `_meta.weave.protocol: 2` and
  nothing else. A TUI built before this change sees the version mismatch and `/reload`s
  into the new binary.
- Journals written before this change stay readable. Their id is the header's creation
  time. Their prompts replay as `user_message_chunk` updates followed by a `turnStarted`
  with an empty prompt, and their turn ends carry only a stop reason.
- `tui/AGENTS.md` is rewritten for the new protocol once it lands, and the ADR 0008 note
  in it removed.

## Acceptance

Ported from `crates/daemon/tests/daemon.rs` and kept: everything the daemon tests check
now, through the new protocol.

New, in-process with fake agents:

- a client that attaches from a position gets exactly the events after it; from another
  journal's position it gets everything with `reset`;
- with two clients attached, both see a pending request, the first answer wins, and the
  second gets `already_resolved`; a client attaching later sees what's still pending;
- one connection creates, attaches to and prompts sessions of two different agents;
- a turn started by one client ends in `turnEnded` for both;
- `host/hello` picks the highest common version and fails without overlap; every other
  method fails before hello;
- `local` authentication: the peer check runs for every socket connection; testing a peer
  with another user id needs a second account, so it's checked by hand;
- agents run from the config, in the session's directory, with the layered environment;
  environment capture falls back when the shell times out;
- a suspended session resumes when attached, with its interrupted turn ended as cancelled;
- golden fixtures match for every message type.

TUI: `ChatWidget` tests cover answering pending requests through the Host, requests
another client answered, and replayed turns staying history; insta snapshots stay
unchanged but for the disconnection wording. Reconnecting mid-turn after the Host restarts,
catching up from the position, is checked live against a development Host
(`WEAVE_DAEMON_DIR`) with the fake agent.

Live, as now: `WEAVE_LIVE_AGENTS=claude,codex` against the real adapters, through the
Host.

Manual: `weave daemon install`, log out and in, and confirm the Host is running with the
login shell environment; `weave daemon restart` through launchd; a pre-change TUI reloads
into the new binary.

## Later

- WebSocket listener with tokens, pairing and the questions in [Security](#security).
- Host methods for clients on other computers: file search for `@` mentions, file reads
  for attachments, shell commands.
- A Host-wide feed of session changes (`sessions/watch`).
- JSON Schema and TypeScript types generated from `weave-host-protocol`, for the
  Capacitor app.
- `--continue` choosing the latest session in the directory across agents, since the Host
  now knows them.
- Disconnecting clients that fall behind, for remote clients on slow links.
