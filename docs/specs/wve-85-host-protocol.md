# WVE-85: The weave Host protocol

Status: Proposed, 2026-10-11

Issue: [WVE-85: Make the weave daemon the Host, with its own client protocol](https://linear.app/jacobfvanzyl/issue/WVE-85/make-the-weave-daemon-the-host-with-its-own-client-protocol)

Decision: [ADR 0008](../adr/0008-weave-daemon-is-the-host.md). Glossary: [`CONTEXT.md`](../../CONTEXT.md).

The words **must**, **must not**, **should** and **may** are normative.

## Purpose

The weave daemon is the Host. Today it presents itself to clients as an ACP agent, which
ties each connection to one agent and puts attaching, shared threads, Host-run terminals
and Host management into `_weave/*` extensions and `_meta`. This spec replaces that client
side with a protocol of our own:

- one connection reaches every thread on the Host, across agents and directories;
- clients attach to a thread and catch up from the last journal position they saw;
- pending requests are Host objects that every attached client sees;
- the Host decides which agents exist and how they run;
- connections authenticate, and versions are negotiated.

ACP stays where the adapters need it, between the Host and its agents, and ACP's content
types are the payload of this protocol. Portal, `product/protocol` and ADR 0001 were
reference material only (ADR 0008); nothing here depends on them, and they were retired
in ADR 0014.

## Scope

In scope:

- the protocol (`host/*`, `agents/*`, `threads/*`, `thread/*`, `turn/*`, `pending/*`)
  over the Unix socket and over an in-process channel (`--no-daemon`);
- moving agent resolution (presets, agent config, registry, MCP servers, the agent
  environment) from the CLI into the Host;
- journal positions, so clients catch up rather than replay everything;
- the TUI, `weave run`, `weave threads` and `weave daemon` as clients of it;
- removing the Host's ACP face and the `_weave/*` extension;
- installing the Host as a launchd user agent.

Out of scope, each for a later issue:

- a WebSocket listener, pairing and token issuance;
- Host methods for clients that aren't on the Host's computer: file search, file reads,
  shell commands (listing a directory came with WVE-112; see [Files](#files));
- a Host-wide feed of thread changes, for thread lists that update live;
- the Capacitor app as a client.

## Topology

```text
TUI · weave run · weave threads · weave daemon         iPad app, through the Dispatcher
                 │                                            │
   Host protocol over the Unix socket              Host protocol over a WebSocket
   (in-process with --no-daemon)                   the Host opened to the Dispatcher
                 └──────────────────┬─────────────────────────┘
                                    ▼
                        Host (`weave daemon run`)
                                    │
                 ACP v1 over stdio, one agent process per open thread
                                    ▼
        claude-agent-acp · codex-acp · gemini · configured and registry agents
```

`weave agents smoke`, `login` and `logout` keep talking to agents directly, using the
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
4. **One stream per thread.** Everything about one thread reaches a client in the order
   the Host produced it.

## Transport and framing

Messages are JSON-RPC 2.0, UTF-8. Batches aren't used.

| Transport | Framing | Authentication |
| --- | --- | --- |
| Unix socket | One message per line (newline-delimited JSON) | `local` |
| In-process channel (`--no-daemon`, tests) | One message per item | `local` |
| WebSocket the Host opens to the Dispatcher it joined ([the Dispatcher's Hosts](wve-175-dispatcher.md#hosts)) | One message per text frame | `device`: the Dispatcher's key |
| WebSocket the Host opens to the Dispatcher it joined, for a device's connection ([carried](#connections-the-dispatcher-carries)) | One message per text frame | `dispatcher` |

The socket and its directory stay where they are (`DaemonPaths`): mode 0600, in a 0700
directory, with one Host per directory guarded by `daemon.lock`. A Host listens for nothing
else: the person's devices reach it through the Dispatcher, over connections the Host opens to
it, as their own spec has it, [`wve-90-remote-clients.md`](wve-90-remote-clients.md) (ADR 0010,
ADR 0030). Until WVE-197 a Host also listened on a loopback WebSocket of its own, behind a
Tailscale Serve entry, for devices that paired with it.

## Connections

### `host/hello`

The first request on every connection. Until it succeeds, the Host answers every other
request with `unauthenticated`.

```json
{"jsonrpc": "2.0", "id": 1, "method": "host/hello", "params": {
  "protocol": {"min": 3, "max": 3},
  "client": {"name": "weave-tui", "version": "0.1.0"},
  "auth": {"method": "local"},
  "capabilities": {"terminalSignIn": true}
}}
```

```json
{"jsonrpc": "2.0", "id": 1, "result": {
  "protocol": 3,
  "clientId": "c7",
  "host": {"version": "0.1.0", "pid": 4242, "startedAt": 1760180000000},
  "features": ["turn/steer"],
  "acp": {"protocolVersion": 1, "unstable": ["session_compaction", "subagents"]}
}}
```

- `protocol` is the range of major versions the client speaks. The Host answers with the
  highest version both support, or fails with `incompatible_protocol`, whose `data` gives
  the Host's own range. See [Versioning](#versioning).
- `auth` is checked against the transport. `local` succeeds only on the Unix socket or
  in-process, and only when the socket's peer has the Host's own user id (`getpeereid`,
  checked when it connects), on top of the socket's file mode. On the connection the Host
  opened to the Dispatcher it joined, `device` (after `host/challenge`) proves the Dispatcher's
  key, as WVE-90 specifies, and the answer then names it in `device`. `pair` is refused
  everywhere: a Host pairs with nothing (WVE-197). `dispatcher` succeeds only on a connection the Host
  opened to the Dispatcher it joined to carry a device's, and names the device the Dispatcher
  named ([Connections the Dispatcher carries](#connections-the-dispatcher-carries)); anywhere
  else it's refused, and it's all such a connection takes. `token` stays reserved and refused
  everywhere. A client that hasn't said a successful hello gets `unauthenticated` for
  everything else.
- `capabilities.terminalSignIn` says the client can run an agent's sign-in command in a
  terminal on the Host's computer. Only `local` clients may claim it.
- `capabilities.clientTools` lists the client tools the client runs on its device, such as
  `clipboard_write` (see [Client tools](#client-tools)).
- `clientId` names this connection in other messages (who answered a pending request,
  who started a turn). It means nothing after the connection ends.
- `host.id` is the Host's own id, the same across restarts, so clients tell Hosts apart.
- `features` lists optional parts of the protocol this Host supports. Version 3 defines
  `turn/steer` ([WVE-86](https://linear.app/jacobfvanzyl/issue/WVE-86/steer-a-running-turn-from-the-tui-through-the-weave-host)),
  which brings the `turnSteered` event with it, `devices` (WVE-90), the `devices/*`
  methods, which no Host advertises since WVE-197 retired them (the Dispatcher's API keeps the
  methods), and `agents/updates` (WVE-93): `agents/updateAvailable`, `ThreadState.update`,
  `agents/update`, `thread/reopen` and the `agentReopened` event (see
  [Updates](#updates)), `clientTools` (WVE-89): `capabilities.clientTools`, the
  `clientTool` pending request and its answer (see [Client tools](#client-tools)), and
  `threads/watch` (WVE-104): `threads/watch`, `threads/unwatch`, `threads/updated` and
  `threads/removed`, `files/list` (WVE-112; see [Files](#files)), and `thread/rename`
  (WVE-114): `thread/rename`, the `renamed` event and the `rename_thread` Host tool (see
  [Host tools](#host-tools)), `queue` (WVE-107): `queue/add`, `queue/remove`,
  `queue/resume`, `ThreadState.queue` and `queuePaused`, `turnStarted`'s `queuedId`, and the
  `queued`, `unqueued`, `queuePaused` and `queueResumed` events (see [Queue](#queue)), and
  `requestKeys` (WVE-107): the `key` that `thread/run`, `turn/start` and `queue/add` take
  (see [Request keys](#request-keys)), and `threads/get` (WVE-106): `threads/get`, with
  delegated threads' `startedBy` and the `thread` turn origin (see
  [Delegated threads](#delegated-threads)), and `thread/observe` (WVE-108):
  `thread/attach`'s `observe`, and `turnIds` (WVE-108): turn ids in `turnStarted`,
  `ThreadState.turns` and the answers of `turn/start`, `turn/steer` and `thread/run`,
  `threads/get`'s `turnId` and `LatestTurn`'s `turnId` and `state`, `threads/list`'s
  `activity`, the `unknown_turn` error and the `list_agents` Host tool (see
  [Turn ids](#turn-ids)), and `otherHosts` (WVE-185): `service/declareTools`' `hosts`,
  `service/hostCall`, `thread/report`, the `caller` a service gives `thread/run`, `queue/add`
  and `turn/steer`, `thread/run`'s `cwd` under the home, `remote` and `policy`,
  `startedByHost`, the `thread` turn origin's `host` and `hostName`, and the Host tools' `host`
  and `list_hosts` (see [Other Hosts](#other-hosts)), and `mcpServers` (WVE-160):
  `ThreadState.mcpServers` and `thread/changed`'s `mcpServers` (see
  [MCP servers' status](#mcp-servers-status)), and `successors` (WVE-168):
  `thread/setSuccessor`, the `continuedIn` event, `continuedIn` in listings and
  `ThreadState`, and `LatestTurn`'s `continuedIn` (see [Successors](#successors)), and
  `labels` (WVE-173): `thread/label`, the `labelled` event, `labels` in listings,
  `ThreadState`, `thread/create`, `thread/run`, `threads/list` and `threads/watch` (see
  [Labels](#labels)), and `context` (WVE-174): listings' `context` and `lastCompaction` (see
  [Context usage](#context-usage)), and `serviceTools` (WVE-171): `service/declareTools`,
  `service/toolCall`, `service/toolCallCancelled` and `service/answerTool` (see
  [Service tools](#service-tools)), and `carry` (WVE-195): `dispatcher/carry` and the
  `dispatcher` auth (see [Connections the Dispatcher carries](#connections-the-dispatcher-carries)),
  and `repos_init` (WVE-178): `repos/init` (see [A repository of its own](#a-repository-of-its-own)).
- `acp` says which ACP payloads to expect: the ACP protocol version the Host speaks to
  agents and the unstable features it may pass through.

A connection ends when either side closes it. The Host detaches the client from every
thread it was attached to; nothing else changes.

### Connections the Dispatcher carries

Feature `carry` (WVE-195, ADR 0030). The person's devices reach every Host through the Dispatcher
the Host joined, which passes the Host protocol through unchanged
([the Dispatcher spec](wve-175-dispatcher.md#devices-reaching-hosts)).

**`dispatcher/carry`** `{token, device: {id, name}, stream: "host" | "terminal"}` → `{}`

Only the Dispatcher the Host joined asks it, over the connection the Host opened to it; anyone
else gets `forbidden`. The Host opens another connection to the Dispatcher where it joined it
(its WebSocket, or `hosts.sock` on its computer, with `weave-dispatcher-host`), asks
`dispatcher/challenge` and checks the Dispatcher's id is the one it joined, as its own connection
does, and presents the token with `hosts/carry {token, nonce}`, the nonce fresh and its own. The
Dispatcher answers with its signature of `weave-dispatcher-carry/1 <dispatcher id> <host id>
<token> <nonce>`, which the Host checks against the Dispatcher's key, the one it learned when it
joined and keeps in `devices.json`, marked joined. Without that signature, or with a wrong one,
the Host closes the connection (4002), serving nothing on it, and answers `dispatcher/carry`
with the error; otherwise it answers `{}`. The token is good once, for a few seconds. Then it
serves that connection:

- **`host`:** the Host protocol, for `device`, a paired device of the Dispatcher's. Its
  `host/hello` says `auth: {method: "dispatcher"}`, and the answer's `device` is the device the
  Dispatcher named; any other auth is refused and the connection closed (4002), and a
  `host/challenge` there is refused too. From then on it's a remote client like any other
  ([What a remote client may do](wve-90-remote-clients.md#what-a-remote-client-may-do)): its
  turns' origin names the device, its pings, backlog and fallen-behind close (4001) are a
  WebSocket client's, and `terminals/attach` gives tickets in the device's name. The Host keeps
  no record of the device: it isn't in `devices.json`, as it's the Dispatcher's, which revokes
  it.
- **`terminal`:** a terminal's stream ([The terminal stream](#the-terminal-stream)), whose
  ticket has to be one `terminals/attach` gave `device`; another's closes it with 4010.

Leaving the Dispatcher, its removing the Host, joining another and the Host stopping close the
connections the Host carries for it.

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
| `default_agent`, `[agents.*]`, `[[mcp_servers]]`, `client_tools`, `host_tools`, `[delegation]` | the Host |
| `[tui]`, `[daemon]` | clients on the same computer |
| `[rex]` | `weave daemon run`, the CLI that runs the Host |
| `[remote]` | nothing since WVE-197, but where the Host's old Serve entry forwarded: `weave daemon run` and `status` say to remove it ([remote clients](wve-90-remote-clients.md#the-hosts-own-remote-access-retired)) |

The Host reads its sections whenever it resolves an agent, so edits apply to the next
thread without a restart. `weave daemon run --config <file>` points the Host at another
file. A client's `--config` selects the file for its own sections; with `--no-daemon` the
in-process Host uses the same file. When a client runs on another computer, the Host
sections of that computer's file do nothing.

MCP servers come from the config only. When a thread opens, the Host passes the ones the
agent's `mcpCapabilities` accept and reports the others in the thread's `notices`. Every
thread also gets the Host MCP server, `weave` (see [Client tools](#client-tools)). How each
server is reaches the thread's clients as its status (see
[MCP servers' status](#mcp-servers-status)).

### Environment

Agents start in the thread's directory (as `instance.rs` does now, with `PWD` set) with an
environment built from three layers, later layers winning:

1. the Host process's own environment;
2. the user's login shell environment, captured when the Host starts by running
   `$SHELL` as an interactive login shell and reading its environment. Capture must time
   out (10 seconds) and fall back to layer 1 alone, logging why;
3. the agent's `env` from the config.

A Host started by launchd or systemd has almost no environment of its own, so layer 2 gives
agents the user's `PATH` and other settings. A Host the CLI starts also keeps whatever the
starting terminal exported. `weave daemon restart` captures again. The environment is never
written to disk or sent to a client. Over all three, each agent process gets
`WEAVE_AGENT_PROCESS`, a name of its own, so a `weave` it runs can say which turn is its own
(see `host/drain`).

Commands an agent runs in Host-run terminals (`terminal/create`) start in the agent's
environment too, `WEAVE_AGENT_PROCESS` included, with `PWD` set to the terminal's directory
and the request's `env` over it, as ACP has it. They find the tools the agent's own commands
find, which a Host under launchd or systemd wouldn't give them on its own (WVE-141).

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
  version?: string;        // the preset's version launched (built-in or locked), or the registry's
  installed: boolean;      // false for a registry agent not yet downloaded
  description?: string;    // the registry's, or `[agents.<id>] description`
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
`weave agents login --agent <agent>` on the Host's computer.

**`agents/logout`** `{agentId}` → `{}`

**`agents/update`** `{agentId}` → `{version}`

Feature `agents/updates`. What `weave agents update <agent>` does (WVE-92), through the same code:
for a preset, npm's `latest` for its package, written to `agents.lock` beside the config;
for a registry agent, a refreshed ACP registry catalog. Only once the new version starts and
answers `initialize`, launched as the Host launches agents; one that doesn't fails the
request and changes nothing. `version` is what the agent's new threads launch now: the
newest, or the one already there. The Host's spare processes of the agent stop, and its open
threads of an older version are told (`agents/updateAvailable`); they keep their process
until `thread/reopen` moves them. Agents the configuration gives a command fail with
invalid params: updating them is the user's to do. Remote clients may update agents too.

When any request needs an agent that requires sign-in, it fails with ACP's
`auth_required` error (code -32000), passed through from the agent, and the client
signs in and retries.

### Updates

When a thread opens for a preset or registry agent (`thread/create`, or `thread/attach`
whether it was open or not), the Host looks for a newer version in the background: npm's
`latest` for the preset's package, the ACP registry's catalog for a registry agent. The
thread never waits for it. A lookup serves every thread for an hour, so threads opened
together make one request; one that failed serves the hour too, and shows nothing. When the
newest version is newer than the one a thread runs, its attached clients get

- `agents/updateAvailable` `{threadId, agentId, name, running, latest}`, once a version, and
- `ThreadState.update` `{agentId, name, running, latest}` carries it to clients that attach
  later.

`name` is what's updated, as people know it: the preset's package or the registry agent's
name. `ThreadState.agent.release` `{name, version}` is the version the thread's process
runs. Configured agents have neither and aren't looked up.

### Agent processes

Each open thread has its own agent process, and subagent threads share their parent's.
For everything else (`agents/get`, sign-in, listing and deleting threads) the Host uses an
open thread's process for that agent when there is one. Otherwise it starts a spare one,
which the next thread for that agent and directory takes, and which stops after a minute
unused.

## Threads

### Identity and states

A thread's id is the agent's own ACP session id. Subagent threads are reached through
their parent: the Host routes requests for them to the parent's process, and their events
go into the parent's journal.

| State | Meaning | Becomes |
| --- | --- | --- |
| open | The Host holds it and its agent runs. | closed when nothing needs it for the idle grace (30 minutes; a minute for a blank thread), when it's closed, or when its agent exits; suspended when the Host stops |
| suspended | It was open when its Host stopped. Its journal is still open. | open when a client attaches or runs a turn in it; closed, its journal ending closed, when nothing takes it up within the idle grace of the next Host starting |
| closed | The Host no longer holds it. | open again when a client attaches, if the agent can resume or load it |

A thread is needed while a client is attached to it, a turn runs in it, or a pending
request waits in it. A blank thread stops being blank at its first prompt; until then
it isn't listed, and it is closed rather than suspended, with its journal removed, when
the Host stops. A headless thread is one whose permission policy answers without asking.

### `ThreadState`

What attaching answers with, and what a client keeps up to date from notifications.

```ts
type ThreadState = {
  threadId: string;
  agent: {
    id: string; name: string; initialize: InitializeResponse;
    release?: { name: string; version: string };   // presets and registry agents
  };
  cwd: string;
  additionalDirectories: string[];
  git?: GitLocation;                           // where in a git repository cwd is; see Worktrees
  title?: string;
  state: "open";
  activity: "idle" | "running" | "waiting";   // waiting: a pending request is unanswered
  clients: number;                             // attached now, this client included
  blank: boolean;
  policy: PermissionPolicy;                    // { approve: ToolKind[], otherwise: "ask" | "reject" }
  modes?: SessionModeState;
  configOptions: SessionConfigOption[];
  turns: { threadId: string; startedAt: number; origin: TurnOrigin; turnId?: string }[];
  queue?: QueuedPrompt[];                      // prompts waiting for the next turns; see Queue
  queuePaused?: "cancelled" | "failed" | "interrupted";   // why the queue waits
  pending: PendingRequest[];
  subagents: string[];                         // subagent thread ids so far
  journal: { id: string; head: number };       // the position of the last event written
  notices: string[];                           // e.g. skipped MCP servers
  mcpServers?: McpServerStatus[];              // weave first, then the config's; see MCP servers' status
  trace?: string;                              // where the Host writes this thread's trace
  update?: { agentId: string; name: string; running: string; latest: string };  // see Updates
  startedBy?: string;                          // the thread whose agent started it; see Delegated threads
  startedByHost?: string;                      // the other Host that thread is on; see Other Hosts
  continuedIn?: string;                        // its successor; see Successors
  labels?: string[];                           // see Labels
};
```

### Methods

**`threads/list`** `{agentId?, cwd?, repo?, activity?, labels?, cursor?}` → `{threads: ThreadListing[], nextCursor?}`

- Without `agentId`: the threads the Host has a journal for, across agents (open,
  suspended and closed), most recently active first. No agent is started. Paging isn't
  needed. With `repo` (feature `worktrees`), any directory in a git repository, only the
  threads in that repository's worktrees, by the repository each thread's `git` names. A
  `repo` outside a repository fails with `not_a_repository`.
- With `agentId`: that agent's threads. The Host's own threads of it in `cwd` lead the
  first page: open ones, then suspended ones within the idle grace of their last activity.
  The agent's own ACP `session/list` follows, paged by its cursor, without the threads
  already listed or any outside `cwd`, which an agent may add (Claude's lists the
  repository's other worktrees).
- Blank threads are never listed.

```ts
type ThreadListing = {
  info: SessionInfo;            // ACP: sessionId, cwd, title, updatedAt, _meta
  agentId: string;
  state: "open" | "suspended" | "closed";
  activity?: "idle" | "running" | "waiting";   // open threads only
  clients: number;
  headless: boolean;
  lastActivityAt?: number;
  git?: GitLocation;            // as the Host last read it while the thread was open
  startedBy?: string;           // the thread whose agent started it; see Delegated threads
  startedByHost?: string;       // the other Host that thread is on; see Other Hosts
  continuedIn?: string;         // its successor; see Successors
  labels?: string[];            // see Labels
  context?: { used: number; size: number };        // see Context usage
  lastCompaction?: { at: number; used?: number };  // see Context usage
  openedBy?: TurnOrigin;        // open threads: the client whose create or attach opened it last,
                                // or the origin of a service's run that opened it
  openedAt?: number;            // and when
};
```

`openedBy` names the client whose `thread/create`, or whose `thread/attach` that took the
thread up, opened it last, a paired device's with its `device` (WVE-167). It's absent for a
thread a headless run or the Host itself opened. `weave daemon` opens a tab in Rex for the
threads a device opens, with `[rex] open_threads` (see [The CLI](#the-cli)).

`activity` (feature `turnIds`) lists only the open threads doing that, `idle`, `running` or
`waiting`, so a caller finds the threads waiting on a person without reading each. `labels`
(feature `labels`) lists only the threads that carry every one of them (see [Labels](#labels)).
`repo`, `activity` or `labels` with `agentId` fails with invalid params: an agent's own listing
goes by directory.

**`threads/get`** `{threadId, turnId?}` → `{thread: ThreadListing, latestTurn?: LatestTurn}`

Feature `threads/get`. One thread the Host has a journal for, open or not, as `threads/list`
lists it, with its latest turn, read from its journal without opening it or attaching. Remote
clients may use it. A thread the Host has no record of, or a blank one, fails with
`unknown_thread`. With `turnId` (feature `turnIds`), `latestTurn` is that turn instead, a
queued one included; one the thread's journal has no turn by fails with `unknown_turn`.

```ts
type LatestTurn = {
  turnId?: string;             // absent for turns journaled before the Host gave ids
  state: "queued" | "running" | "waiting" | "ended" | "stopped" | "cancelled" | "failed" | "interrupted";
  continues?: string;          // the interrupted turn it continues
  continuedIn?: string;        // the turn that continues it, for an interrupted turn continued
  prompt: ContentBlock[];
  origin: TurnOrigin;
  startedAt: number;           // for a queued turn, when it was queued
  running: boolean;
  response?: PromptResponse;   // how it ended, once it has
  error?: Error;               // why it failed
  message?: string;            // the agent's last message in it, as text
};
```

`message` is the text of the agent's last message in the turn: its message chunks since the
last tool call, thought or other message. `state` says where the turn is in one field, as A2A's
task states do: `queued` while its prompt waits in the queue, `running`, `waiting` while it runs
and a permission request or elicitation in it waits for a person (a client tool call doesn't
count), and once over, `ended` (`end_turn`), `stopped` (another stop reason), `cancelled`,
`failed` or `interrupted` (see [Interrupted turns](#interrupted-turns)), which match the CLI's
exit statuses; an interrupted turn exits as a failed one does.

**`threads/watch`** `{labels?}` → `{threads: ThreadListing[]}`

Feature `threads/watch`. Answers with the listing `threads/list` gives without an agent,
then sends the client a notification for every change to the Host's threads, whether it's
attached to them or not, until the connection ends or it sends `threads/unwatch` `{}` →
`{}`. Watching again starts over, with the listing as it is then. Remote clients may watch.

- `threads/updated` `{thread: ThreadListing}`: a thread appeared or changed, as it lists
  now. It's sent when a thread opens (a blank one at its first prompt), when its
  `activity`, `clients`, title, labels or successor change, when its context usage moves by a
  hundredth of its window or it compacts (see [Context usage](#context-usage)), and when it's
  suspended or closed; no more often than
  `thread/changed`, from the same changes, its branch included. A closed or suspended thread lists with no
  `activity` and no clients.
- `threads/removed` `{threadId}`: a thread went away: deleted, its journal pruned, or closed
  while blank.

Blank threads never appear. Nothing reaches a watching client between the answer and the
notifications after it, so it misses no change and hears none older than its listing. With
`labels` (feature `labels`), the listing and the notifications cover only the threads that
carry every one of them; a change that makes a thread stop carrying them reaches the watcher
as one last `threads/updated`, showing its labels, and nothing of it after (see
[Labels](#labels)).

**`thread/create`** `{agentId, cwd, additionalDirectories?, mode?, policy?, trace?, labels?}` →
`ThreadState`

Starts a thread and attaches the client to it. The thread starts in `mode` if given,
otherwise in the agent's configured `mode`. `policy` defaults to asking. Extra directories
the agent can't accept are dropped and reported in `notices`. With `trace`, the Host writes
the agent's protocol trace under its own directory and says where in `trace`.

**`thread/attach`** `{threadId, after?: {journal, seq}, agentId?, cwd?, trace?, observe?}` →
`ThreadState & {replay: {from: number, reset: boolean}}`

Attaches the client to a thread, opening it first if needed:

- open: attach.
- suspended: resume it in its agent (ACP `session/resume`, or `session/load` with the
  agent's replay discarded when it can't resume), continuing its journal. Turns that were
  running when the Host stopped are journaled as ended, cancelled.
- closed: open it in its agent with ACP `session/load`, whose replay fills a new journal,
  or with `session/resume` and an empty new journal when the agent can't load.
- unknown to the Host (from an agent's listing): as closed. `agentId` and `cwd` are then
  required, or the request fails with `unknown_thread`.

A thread belongs to the agent it started with: naming another fails with `wrong_agent`.

After the response, the Host sends the thread's events after `after`, in order, then
live events as they happen. `replay.from` is the first position it sends. When `after`
names another journal (the thread was closed and opened again since) or is missing, the
Host sends everything and `replay.reset` is true; the client clears its transcript first.

With `observe` (feature `thread/observe`, WVE-108), the client observes the thread, as a
script following it does: it is sent the response, the replay, live events and pending requests
as a client is, but isn't one. It attaches only to an open thread, failing with
`thread_not_open` rather than opening one; it isn't counted in `clients`; it doesn't keep the
thread needed, and its `thread/detach` closes nothing whatever `close` says; and it is never
sent a client tool to run.

**`thread/detach`** `{threadId, close?: "never" | "ifUnused"}` → `{}`

The client stops receiving the thread. With `ifUnused`, the thread closes as soon as nothing
needs it: now, or once its turn ends and its pending requests resolve, rather than after the
idle grace. Another client attached keeps it open as before, and one attaching first takes the
close back. The TUI asks for it when it leaves a thread for another, quits a blank one, or
quits with `/exit` or Ctrl+C (WVE-159).

**`thread/close`** `{threadId}` → `{}`

Closes the thread for everyone: its turn ends, its pending requests are cancelled, its
agent's session is closed (ACP `session/close`, when supported) and its process stops.

**`thread/reopen`** `{threadId}` → `{version?}`

Feature `agents/updates`. Moves an open thread to the version its agent's new threads
launch, as after `agents/update`. The Host starts that version; one that doesn't start fails
the request with the thread as it was. Then it closes its session in the old process (ACP
`session/close`, when supported), stops it, and takes the thread up in the new one with
ACP `session/resume`, or `session/load` with the agent's replay discarded, as after a Host
restart. The thread keeps its id and journal, where an `agentReopened` event marks the
change for every client; its mode and config options are whatever the new process restores.
Anything that lived only in the old process ends with it, such as its background commands
and running subagents. While a turn runs or a request waits, the reopen waits for them, and
the answer with it.

When the new version can't take the thread up, the old one does again, and `agentReopened`
says why in `failed`. When that fails too, the thread closes. An agent that can't resume or
load sessions fails the request with method not found, and its process stays; new threads
get the new version. So does a blank thread (one nobody has prompted), with invalid request:
an agent may keep nothing of a session before its first prompt (claude-agent-acp can't resume
one), so a new thread takes its place. `version` is what the thread runs now.

**`thread/delete`** `{threadId, agentId?}` → `{}`

Closes the thread if it's open, deletes it in the agent (ACP `session/delete`) when the agent
can, and removes its journal. The agent runs in the thread's directory to do so; when that's
gone, as a removed worktree, it isn't asked. An agent that isn't asked, or can't delete
sessions, keeps its own history of it. `agentId` is required when the Host has no record of
the thread.

**`thread/setMode`** `{threadId, modeId}` → `{}`

**`thread/setConfigOption`** `{threadId, configId, value}` → `SetSessionConfigOptionResponse`

Passed to the agent. The change reaches every attached client, the sender included, as an
ACP `current_mode_update` or `config_option_update` in the journal.

**`thread/rename`** `{threadId, title}` → `{}`

Feature `thread/rename`. Gives an open thread a title of the Host's. The title is trimmed and
must be 1 to 200 characters; the thread must be open (`thread_not_open`).

- **Journaled.** The rename is journaled as a `renamed` event, so every client sees it, live
  and replayed. `thread/changed`, `threads/updated` and listings carry the title, and listings
  prefer it to the agent's.
- **It holds.** From then on, titles in the agent's `session_info_update`s are left out of the
  journal and of the thread's title. Otherwise a title an agent generates after its first turn
  would undo a rename made during that turn. Only another rename replaces it.
- **It outlives the journal.** A suspended thread's journal carries the title on; a closed
  thread's new journal begins with it.
- **The agent's own title doesn't change.** ACP has no way to change it from outside, so the
  agent's own listing and tools still show its title.

The `rename_thread` Host tool does the same for the calling thread (see
[Host tools](#host-tools)).

**`thread/label`** `{threadId, add?, remove?}` → `{labels}`

Feature `labels`. Adds labels to an open thread and takes others off, answering with its
labels after, in the order they were added (see [Labels](#labels)). The thread must be open
(`thread_not_open`). A label that isn't one, or a change that would leave more than 16, fails
with invalid params. Adding a label it carries, or taking off one it doesn't, changes nothing;
a change is journaled as a `labelled` event. Services may ask it.

**`thread/setSuccessor`** `{threadId, successor}` → `{}`

Feature `successors`. Names the thread an open thread's work goes on in, its successor (see
[Successors](#successors)), as the Dispatcher does when it starts a Bot's new thread. The thread
must be open (`thread_not_open`); the successor must be one the Host has a record of
(`unknown_thread`), not the thread itself, and not one whose successors lead back to it
(invalid params). A thread's successor is named once: naming the same one again does nothing,
and another fails with invalid params. Services may ask it.

## Journal and events

Every thread has a journal: the numbered record of everything its attached clients are
sent. Its first entry (position 0) is a header that isn't sent. Events take positions 1,
2, 3 and so on. A journal has an id that changes only when the Host starts a new journal for
the thread, as when a closed thread is opened again. A client that remembers
`{journal, seq}` for the last event it handled can always catch up from there.

### `thread/event`

```json
{"jsonrpc": "2.0", "method": "thread/event", "params": {
  "threadId": "s-1", "seq": 42, "at": 1760180001234,
  "event": {"kind": "update", "notification": {"sessionId": "s-1", "update": {
    "sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "Done."}}}}
}}
```

| `event.kind` | Fields | Written when |
| --- | --- | --- |
| `update` | `notification`: ACP `SessionNotification` | the agent sends `session/update` (for this thread or a subagent thread; `notification.sessionId` says which), or a client changes a mode or config option |
| `turnStarted` | `threadId`, `prompt`: ACP `ContentBlock[]`, `origin`, `queuedId?`, `turnId?`, `continues?` | a turn starts; `queuedId` names the queued prompt it started from, `turnId` the turn, `continues` the interrupted turn it continues |
| `turnSteered` | `threadId`, `prompt`: ACP `ContentBlock[]`, `origin` | a steer joins the running turn (`turn/steer`) |
| `turnEnded` | `threadId`, `response?`: ACP `PromptResponse`, `error?`: JSON-RPC error | a turn ends |
| `terminalOutput` | `terminalId`, `data` | a command the Host runs for the agent writes output |
| `terminalExit` | `terminalId`, `status`: ACP `TerminalExitStatus` | that command exits |
| `agentReopened` | `agent`: `ThreadState.agent`, `previous?`: `{name, version}`, `modes?`, `configOptions`, `failed?` | the thread's agent was started again (`thread/reopen`); `failed` says why it runs `previous` again |
| `closed` | `reason`, `by?`: `origin` | the thread closes; `by` is the client whose `thread/close` or `thread/delete` closed it for everyone, absent when nobody did (its agent exited, it went idle, its worktree was removed) |
| `notice` | `text` | the Host tells the thread's clients something, such as that its agent can't use client tools |
| `renamed` | `title`, `by?`: `origin` | the thread was renamed through the Host (`thread/rename`); `by` is the renaming client's origin, absent when the thread's own agent renamed it (the `rename_thread` Host tool) |
| `labelled` | `labels`: string[], `by?`: `origin` | a client changed the thread's labels (`thread/label`); `labels` are all of them, after |
| `continuedIn` | `successor`: thread id, `by?`: `origin` | a client named the thread's successor (`thread/setSuccessor`); `by` is that client's origin |
| `queued` | `queuedId`, `prompt`: ACP `ContentBlock[]`, `origin` | a prompt joined the queue (`queue/add`) |
| `unqueued` | `queuedId`, `by?`: `origin` | a client took a prompt out of the queue (`queue/remove`) |
| `queuePaused` | `reason`: `"cancelled" \| "failed" \| "interrupted"` | the queue stopped starting turns (see [Queue](#queue)) |
| `queueResumed` | `by?`: `origin` | the queue started again; `by` is the client that resumed it |

`origin` is `{"client": {"name": "weave-tui", "id": "c7"}}` for a client's prompt, with the
connection's `clientId` so a client recognizes its own (a remote client's adds its paired
device's name as `device`), `{"run": {}}` for a headless run, or
`{"thread": {"threadId": "s-2"}}` for a prompt from another thread, whose agent began the
turn through a Host tool, or `{"thread": {"threadId": "s-2", "report": true}}` for the Host's
report on thread `s-2` to the thread whose agent began a turn there (see
[Delegated threads](#delegated-threads)). A thread on another Host adds that Host's id as
`host`: `{"thread": {"threadId": "s-2", "host": "h-7Rk2"}}` (see [Other Hosts](#other-hosts)).
A service's prompt may name what started it: `{"service": {"name": "Dispatcher", "label":
"schedule daily-review", "id": "o-01J9Z"}}` (see [Service origins](#service-origins)). Prompts are journaled in `turnStarted`, not as made-up `user_message_chunk`
updates. Terminal output an agent reports in `_meta` (`terminal_output_delta`) becomes
`terminalOutput` and `terminalExit` events and is stripped from the update, so each chunk
arrives once.

Clients must ignore event kinds they don't know, while still advancing their position.

### Other notifications

These aren't journaled. They go to the thread's attached clients.

- `thread/changed` `{threadId, activity?, clients?, title?, blank?, git?, mcpServers?}`:
  fields of `ThreadState` that changed. `git` changes when a turn ends in a worktree whose
  branch changed meanwhile, and `mcpServers`, all of them, when one does.
- `pending/added` `{threadId, pending: PendingRequest}`
- `pending/resolved` `{threadId, pendingId, outcome: "answered" | "cancelled" | "withdrawn", by?: clientId}`
- `thread/elicitationCompleted` `{threadId, notification: CompleteElicitationNotification}`:
  an accepted URL elicitation's external step finished.
- `agents/updateAvailable` `{threadId, agentId, name, running, latest}`: a newer version of
  the thread's agent is out (see [Updates](#updates)).

### Slow clients

A local client that falls behind is buffered for: the ACP SDK's channels are unbounded. A
client on a WebSocket, which a remote client's connection through the Dispatcher is, is closed
instead once its unsent messages pass 8 MiB, and reconnects and catches up from its position
(WVE-90).

## Turns

**`turn/start`** `{threadId, prompt: ContentBlock[], key?}` → `{seq, turnId?}`

Sends the prompt to the agent and answers once the turn has started, with the position of
its `turnStarted` event. The thread must be open, but the client needn't be attached.
`threadId` may be a subagent thread's. The turn's end reaches attached clients as
`turnEnded`, whoever started it. Fails with `thread_not_open` or `turn_running`. A Host
with the `queue` feature offers `queue/add` too, which starts a turn or queues the prompt
behind the running one (see [Queue](#queue)).

**`turn/steer`** `{threadId, prompt: ContentBlock[], caller?, origin?}` →
`{outcome: "steered", seq, turnId?} | {outcome: "notRunning"}`

Feature `turn/steer`. Sends a steer: a message for the thread's running turn, which joins
it instead of starting another. The agent must take steering: claude-agent-acp and codex-acp
advertise `_meta.steering.supported` in their `initialize` response, which clients read from
`ThreadState.agent`, and take `_session/steering`, an extension of theirs rather than an
ACP RFD. With an agent that doesn't, a steer for a running turn fails with method not
found.

- `steered`: the agent took it, joining the turn `turnId`. It's journaled as `turnSteered` at
  `seq`, after the updates
  the agent sent before taking it, so every client and every replay shows it where it joined
  the turn. The client that sent it shows it then too. The turn ends as usual, once the agent
  has answered it.
- `notRunning`: no turn the Host started was running by the time the agent was asked, so
  nothing was sent. The client starts a turn with it instead, or queues it behind one that
  started meanwhile.

The Host asks the agent with `_meta.steering.idleBehavior: "promptRequired"`, so that an
agent whose turn just ended hands the steer back rather than starting a turn the Host can't
see end. codex-acp ignores that: a steer that reaches it as its turn ends starts a turn of its
own, whose output reaches clients but whose end never does. The Host journals that steer as
`steered` and logs it. When the agent can't take a steer, the request fails with its error.
`caller` is a service's only (see [Other Hosts](#other-hosts)).

**`turn/cancel`** `{threadId}` → `{}`

Cancels the thread's running turn (ACP `session/cancel`) and cancels its pending
requests.

**`thread/run`** `{agentId, cwd, remote?, threadId?, additionalDirectories?, mode?, prompt, policy, attach?, trace?, key?, caller?, origin?, labels?}` →
`{threadId, turnId?, state?: ThreadState, policy?}`

Opens a thread (`threadId`, as attaching would, or a new one) and starts a turn in it
without the client having to stay. An open thread keeps its own policy. A new thread starts
in `mode` if given, otherwise in the agent's configured `mode`, as `thread/create` starts one
(WVE-166, ADR 0026): an agent's own mode may approve what `policy` would reject, as it would
in an interactive thread. A thread it takes up is in whatever mode its agent restores. With
`attach`, the client is attached before the prompt is sent, so it sees the whole turn, and `state` is
returned. Nobody can sign in at a terminal for a headless thread, so the Host doesn't
offer agents terminal sign-in for one. `turnId` names the turn it started; a repeat under its
key names it too. `policy` (feature `otherHosts`) is the policy the thread runs under: the one
asked for, or an open thread's own; a repeat under a key leaves it out. `caller` is a
service's only: the thread on another Host whose agent asks, which the turn's origin names and a
new thread records as `startedBy` and `startedByHost` (see [Other Hosts](#other-hosts)). `origin` is a service's only
(see [Service origins](#service-origins)), and a thread its run opens records the turn's
origin as `openedBy`.
`cwd` may be `~` or start with `~/` (feature `otherHosts`), under the Host's home, and with `remote`
it has to be a checkout of that repository, by its remote as `GitLocation.remote` gives it, or
the request fails saying what's there, as a call from another Host's agent asks for the
directory it works in.

### Turn ids

Feature `turnIds` (WVE-108). A turn goes by the id of the prompt that started it: its `queuedId`
when it came through the queue, so `queue/add` names the turn before it starts, or else one the
Host gives it, unique in the thread like queued ids. `turnStarted` carries it, as do
`ThreadState.turns`, `LatestTurn`, and the answers of `turn/start`, `turn/steer` (the turn it
joined) and `thread/run`. A caller waits for the turn it started by following the thread
until that turn's `turnEnded`, or reads it with `threads/get`'s `turnId`, rather than working
from journal positions. Turns journaled by a Host that gave no ids have none, apart from queued
ones, which go by their `queuedId`. This is A2A's `taskId`, which weave borrows without
speaking A2A (`docs/research/a2a-and-agents-controlling-threads.md`).

### Interrupted turns

WVE-144, ADR 0011. A turn the Host stops or crashes under, as `weave daemon restart --now` or a
drain that runs out of time stops it, is cut off with its agent's process. When the Host takes
the thread up again, it ends that turn with `turnEnded` whose `error` has the code
`interrupted` ("the weave Host stopped while this turn ran"), and the turn's `state` is
`interrupted`. A client that doesn't know the code shows it as a failed turn's error.

- **A headless thread continues it,** once: as the thread opens, before its queue starts
  anything, the Host starts a turn with a fixed prompt saying the turn was cut off and to carry
  on after checking what it had done, from the interrupted turn's `origin`, so the thread whose
  agent began it hears how it ends, as it would have. Its `turnStarted` names the interrupted
  turn in `continues`, as `LatestTurn` does, and the interrupted turn's `LatestTurn` names the
  continuation in `continuedIn`. The continuation's `turnStarted` is journaled with the
  interrupted turn's `turnEnded`, before the agent is prompted, so nobody reading the journal
  or attaching finds the one without the other; if the agent won't take the prompt, the
  continuation ends failed. A continuation that is itself interrupted isn't continued again, so
  a turn that brings the Host down can't do it over and over. The Host takes up such threads
  at startup, as it does headless threads whose queue waits.
- **An interactive thread doesn't.** It shows the outcome and leaves the turn to the person,
  and its queue pauses as `interrupted` if prompts wait (see [Queue](#queue)).
- A turn a stopped Host left was journaled as `cancelled` before; such journals stay as they are.

### Labels

WVE-173, ADR 0027. A label is a short string a client puts on a thread, to find it by: the
Dispatcher labels the threads it starts `dispatcher` and `schedule:<id>`, and a Bot's threads
`dispatcher` and `bot:<id>` (ADR 0028, WVE-118). Labels mean nothing to the Host.

- **What one is:** 1 to 64 letters, digits and `-_.:/`, compared as written. A thread carries
  at most 16, in the order they were given.
- **Given** at the start, with `thread/create`'s and `thread/run`'s `labels` (a run that
  continues a thread leaves its labels as they are), and after with `thread/label`, so a
  client never lists a thread before it carries its labels.
- **Journaled:** a `labelled` event holds them all after each change. A suspended thread's
  journal carries them on, and a closed thread's new journal begins with them.
- **Listed and filtered:** listings, `ThreadState` and `threads/updated` carry `labels`;
  `threads/list` and `threads/watch` take `labels` and cover only the threads that carry
  every one. A client that wants to leave labelled threads out, as ADR 0028 has apps do with
  Bots' threads, reads `labels` from the listing.
- **Kept:** pruning passes over a labelled thread's journal however long it's been quiet, so a
  Bot's earlier threads stay readable.

### Context usage

WVE-174, ADR 0028. A thread's listing says how much of its agent's context window it uses and
when it last compacted, so one `threads/watch` can tell a client such as the Dispatcher when a
Bot's thread needs compacting or a new thread. The Dispatcher doesn't act on it yet: a Bot's
agent compacts itself, and its new threads come when asked or daily (WVE-118). Only what ACP
defines is read, for the thread itself, not its subagents:

- `context` `{used, size}`: the tokens in context and the window, from its latest
  `usage_update`.
- `lastCompaction` `{at, used?}`: when its last compaction completed (`compaction_update` with
  `completed`; a failed or cancelled one doesn't count), and `used` from the first
  `usage_update` after it, what the compaction left. An agent that reports compaction only as
  text, as Codex's adapter does, leaves it absent.

Both are read again from the journal when the Host takes a thread up, and a closed thread's
new journal begins with them. A change in usage alone reaches watchers only once `used` has
moved by at least a hundredth of `size` since they last heard, or `size` changed; whatever
`threads/updated` is sent carries the latest values. Attached clients have every
`usage_update` in the journal.

### Successors

WVE-168, ADR 0028. A turn or a thread can name the one that carries its work on, its
successor, and whoever follows it or reports to it follows it there.

- **A turn's successor** is the continuation of an interrupted turn (see
  [Interrupted turns](#interrupted-turns)): `turnStarted.continues` names the interrupted turn,
  and the interrupted turn's `LatestTurn.continuedIn` the continuation. `weave run`,
  `weave threads follow --turn` and `weave threads prompt --wait` treat the two as one turn: they
  wait for a Host that goes away to come back, follow the thread again from the last event they
  saw, say on stderr that the turn was cut off and continued, and exit as the continuation ends.
  The Dispatcher settles an occurrence the same way.
- **A thread's successor** is one a client named with `thread/setSuccessor`, journaled as a
  `continuedIn` event and carried as `continuedIn` in listings, `threads/updated` and
  `ThreadState`; a suspended thread's journal carries it on, and a closed thread's new
  journal begins with it. A report to a thread goes to the last of its successors instead
  (see [Delegated threads](#delegated-threads)), and the Dispatcher prompts a thread a
  schedule names there. `weave threads follow` moves on to the successor, printing it from its
  start; the TUI offers `/follow` and the app an Open button.
- A push for an interrupted turn that was continued is worth sending only if the continuation
  fails (WVE-177).

### Queue

Feature `queue`. Each open thread has a queue: prompts waiting, in order, to start its next
turns. The Host holds it rather than a client, so every attached client sees the same queue,
it outlives the client that added to it, and whatever has no client, such as a trigger or
another thread's agent, can queue too.

```ts
type QueuedPrompt = {
  id: string;           // the queuedId, unique in the thread
  prompt: ContentBlock[];
  origin: TurnOrigin;   // who added it, which its turn's origin will be
  queuedAt: number;
};
```

- **Running.** Whenever no turn of the thread's own runs, its queue isn't paused and no
  `thread/reopen` waits, the Host starts the first queued prompt as the next turn, with that
  prompt's origin. Its `turnStarted` names it in `queuedId`, which is how clients know it left
  the queue. Only a thread has a queue; its subagent threads don't.
- **Pausing.** When the thread's turn is cancelled (`stopReason: "cancelled"`) or fails while
  prompts wait, the queue pauses rather than start the next one, journaled as `queuePaused`:
  whoever stopped the turn decides what follows. So does an interactive thread's queue when
  the Host takes the thread up again with prompts waiting, after the Host stopped or the
  thread closed (`interrupted`); a headless thread's carries on. A paused queue resumes,
  journaled as `queueResumed`, with `queue/resume`, or when a client prompts the thread with
  `queue/add`, `turn/start` or `thread/run`. A paused queue that empties isn't paused any
  more, and clients stop showing it as paused.
- **Journaled.** The queue is in the journal (`queued`, `unqueued`, `queuePaused`,
  `queueResumed` and `turnStarted`'s `queuedId`), so it survives a Host restart and replays
  to clients that attach later, and `ThreadState` carries it as `queue` and `queuePaused`. A
  closed thread's queue carries on into the journal it gets when it opens again, as a renamed
  title does. A paused queue doesn't keep its thread open: the thread closes after the idle
  grace like any other.
- **At startup** the Host takes up the suspended headless threads whose queue holds prompts
  and isn't paused, so their queue runs with nobody attached, and those it stopped under
  mid-turn, which continue that turn first (see [Interrupted turns](#interrupted-turns)).

**`queue/add`** `{threadId, prompt: ContentBlock[], key?, caller?, origin?}` → `{queuedId, seq, started}`, where
`queuedId` is also the id of the turn it starts (see [Turn ids](#turn-ids))

Adds a prompt to the end of the thread's queue, with the client's origin. Any client may add
to an open thread's queue, attached or not (`thread_not_open` otherwise). `threadId` must be
the thread's own, not a subagent thread's (invalid params). When no turn runs and nothing
waits, the prompt starts a turn at once: `started` is true and `seq` is the position of its
`turnStarted`. Otherwise `seq` is the position of its `queued` event. Adding to a paused queue
resumes it. So sending is one request whatever the thread is doing.

**`queue/remove`** `{threadId, queuedId}` → `{removed?: QueuedPrompt}`

Takes a prompt out of the queue, whoever added it, journaled as `unqueued`, and answers with it.
`removed` is absent when the prompt had already left the queue, started or removed, so a
client taking a prompt back to edit it never has it both running and in its composer. Queued
prompts aren't edited in place: remove one and add it again.

**`queue/resume`** `{threadId}` → `{}`

Resumes a paused queue, starting its first prompt if no turn runs. A queue that isn't paused
stays as it is.

Steering is unchanged: `turn/steer` joins a running turn, and a `notRunning` answer has the
client send its message with `queue/add` instead, which starts it, or queues it behind a turn
that started meanwhile.

### Request keys

Feature `requestKeys`. `thread/run`, `turn/start` and `queue/add` take an optional `key`, 1 to
200 characters the caller chooses, such as a UUID, so a caller that retries after a dropped
connection never starts the same work twice.

- The Host records a key on disk before acting on its request. A repeat, the same method with
  the same key, answers as the first did and starts nothing, across Host restarts too. One that
  arrives while the first is still being answered waits for it.
- A key belongs to one request: a repeat whose method or params differ fails with
  `key_reused`.
- Only work that happened uses a key up. A request that fails, with `turn_running` say, can be
  sent again with the same key.
- A repeated `thread/run` answers with the thread's id alone, without `state`; a client that
  asked to attach attaches with `thread/attach`.
- The Host journals each key with the turn or queued prompt it started. If the Host stopped
  between recording a key and answering, a repeat looks there to learn whether the work
  happened, and does it only if it didn't.
- Keys are kept as long as journals are: they're forgotten 14 days after they were recorded.

Triggers (WVE-145, WVE-146) are to admit each occurrence through the same record, under a key
of its own.

## Pending requests

```ts
type PendingRequest = {
  id: string;
  threadId?: string;           // the thread it's for, the root or a subagent thread, when it's for one
  createdAt: number;
} & (
  | { kind: "permission"; request: RequestPermissionRequest }
  | { kind: "elicitation"; request: CreateElicitationRequest }
  | { kind: "clientTool"; tool: string; arguments: object; target: string } // a clientId
);
```

A thread's permission policy answers the permission requests it can, and a policy that
rejects what it doesn't approve dismisses elicitations. When a policy rejects a permission
request, the thread journals a `notice` naming the tool, its kind and how `weave run` approves
that kind, since the agent's reply may not say why it couldn't go on (WVE-166). Every other
permission request or elicitation becomes a pending request: in `ThreadState.pending` for clients that attach
later, and announced with `pending/added` to clients attached now.

**`pending/answer`** `{threadId, pendingId, permission?: RequestPermissionResponse, elicitation?: CreateElicitationResponse, clientTool?: CallToolResult}` →
`{}`, with exactly one of the three

The first answer goes to the agent and every attached client gets `pending/resolved` with
`answered`. Later answers fail with `already_resolved`. Declining or cancelling an
elicitation is an answer like any other.

A pending request also resolves when its turn is cancelled or ends (`cancelled`), or when
the agent withdraws it (`withdrawn`, from ACP `$/cancel_request`). A client detaching
doesn't resolve anything: the request waits for another client, or for one to attach. A
client tool call is the exception on both counts: only its `target` answers it (anyone
else gets `not_target`), and it resolves `cancelled` when its target detaches.

## The Host MCP server

The Host offers agents tools through one MCP server it owns, `weave`
([ADR 0009](../adr/0009-client-tools-through-a-host-owned-mcp-server.md)), which every
thread's agent gets whoever is attached. The tools are of two kinds, both defined by the Host
(`protocol/`, `tools`):

- **Client tools** run on a client's device.
- **Host tools** are answered by the Host itself.

The config chooses which an agent is offered. `client_tools` and `host_tools` each mean all
when absent and none when `[]`, and an agent's own setting overrides the top-level one. The
server speaks MCP 2026-07-28 only. Agents that advertise
`mcpCapabilities.acp` get it over ACP (`"type": "acp"`, from the draft MCP-over-ACP RFD);
the rest get a stdio server, `weave mcp-bridge`, which relays MCP between the agent and the
Host's MCP socket beside its own, after a token naming the thread's declaration. Each
thread setup declares the server under a new `serverId` or token. An agent that opens it
with `initialize`, from an MCP revision before 2026-07-28, is refused, and the thread's
clients get a `notice` event saying it can't use weave's tools.

### MCP servers' status

Feature `mcpServers` (WVE-160). The Host keeps, with each open thread, how each MCP server
its agent was given is, so every attached client shows the same: in `ThreadState.mcpServers`
when it attaches, and in `thread/changed` whenever one changes. A thread reopened in a new
agent process (`thread/reopen`, or taken up after a restart) has its servers declared anew,
and their status starts over.

```ts
type McpServerStatus = {
  name: string;                         // as the agent knows it: "weave" for the Host's own
  source: "host" | "config";            // the Host MCP server, or [[mcp_servers]]
  transport?: "acp" | "stdio" | "http" | "sse";   // absent for a server left out
  state: "declared" | "connected" | "passed" | "skipped" | "unavailable";
  reason?: string;                      // why it's skipped or unavailable
};
```

- `weave` is `declared` once the thread's setup declares it, over ACP or as the bridge, and
  `connected` from the agent's first request to it in MCP 2026-07-28. It is `unavailable`
  when it couldn't be declared, or when the agent opened it with `initialize` and was refused,
  with `reason` saying which.
- A configured server is `passed` when the thread's agent was given it, and `skipped`, with
  the reason its notice gives, when it wasn't. Only the agent knows whether a passed server
  connected, so the Host never calls one connected.
- Servers from the agent's own configuration are the agent's alone, and aren't listed. Clients
  say so, and point to the agent's own `/mcp` when its `available_commands_update` offers one.

Clients ignore states, sources and transports they don't know.

## Client tools

Client tools run on a client's device for an agent, such as `clipboard_write {text}`, which
puts text on the clipboard.

A call goes to the client that sent the running turn's latest prompt or steer, if it's
attached and lists the tool in `capabilities.clientTools`: it becomes a `clientTool`
pending request every attached client sees, and its target answers with the tool's MCP
`CallToolResult`. Otherwise (no turn, a headless run's turn, a client not attached or not
running the tool) the agent gets a tool error saying why, at once, and nothing is pending.
When the target detaches, the agent gets an error saying the tool may have run, and no
other client runs it. The agent cancelling the call withdraws it.

## Service tools

Feature `serviceTools`, WVE-171, ADR 0027. A service declares tools of its own, which the Host
offers every thread's agent through `weave` beside the client and Host tools, and answers their
calls over its own connection. The only service is the Dispatcher the Host joined, over the
connection the Host keeps open to it, which is how agents reach the Dispatcher. Its tools are a
Bot's: its wake-ups (WVE-118), its schedules, and making another Bot (WVE-178), which every
thread is offered and only a Bot's own threads get answers from
([A Bot's tools](wve-175-dispatcher.md#a-bots-tools)).

**`service/declareTools`** `{tools: Tool[], hosts?}` → `{names: string[]}`

A `Tool` is `{name, title, description, inputSchema}`. The tools replace those the service
declared before, so a service declares them on every connection, and the connection that
declared them last serves them. Only a service may declare tools (`forbidden`).

- **Names.** Agents see `<service>__<tool>`: the name the Host knows the service by, the name
  the Dispatcher gave when the Host joined it, lowercased, with anything but letters and digits
  made `_`, then the tool's name, of letters, digits, `_` and `-`. The whole name, with Claude
  Code's `mcp__weave__` before it, fits in 128 characters. A service declares at most 64 tools.
  The answer gives the names agents see.
- **Kept.** The Host keeps them in `devices.json` with the Dispatcher it joined, across the
  Dispatcher's reconnects and the Host's own restarts, and forgets them when it leaves the
  Dispatcher or the Dispatcher removes it.
- **Reaching the Hosts.** `hosts: true` (feature `otherHosts`) says the service reaches the
  person's other Hosts: the Host sends it the Host tool calls that name another Host, as
  `service/hostCall`, kept with the tools (see [Other Hosts](#other-hosts)).
- **Offered from setup.** A thread set up after a declaration lists the tools; a thread already
  open keeps the tools it started with, since an agent's tools are fixed at setup and changing
  them costs its prompt cache. An agent's `host_tools` setting leaves them out as it does Host
  tools, by the names agents see. The thread's permission policy applies to calls as to any
  `weave` tool.

**`service/toolCall`** `{callId, tool, arguments, caller: {threadId, agentId, cwd, policy, labels?}}`,
to the service: a thread's agent called one of its tools, named as the service declared it.
`caller` is the calling thread, whose policy what the call starts should approve no more than.
**`service/toolCallCancelled`** `{callId}`: the agent stopped waiting.

**`service/answerTool`** `{callId, result}` → `{}`

The tool's MCP `CallToolResult`, `{content, isError?}`, which the agent gets. Only the service
the call went to may answer it, once (`forbidden` for another client, invalid params for a call
that isn't waiting on it). A call while no connection of the service serves its tools fails at
once as a tool error naming the service; one whose connection ends first fails as one that may
have run.

## Host tools

Host tools are answered by the Host, for the thread whose agent calls them. Each is a Host
protocol method seen from inside the thread, with the same parameters less what the calling
thread supplies, and is answered by the same code as the client request
([ADR 0020](../adr/0020-agents-reach-the-host-as-clients-do-and-act-only-on-threads-they-start.md)).
No Host tool does what no client request can, so a new capability lands in the protocol first.
They read and act on any thread on the Host, as a client can
([ADR 0023](../adr/0023-agents-act-on-any-thread-and-the-hosts-reports-tell-nobody-back.md)).
They need no client, so they work in headless threads too. A tool's answer is its method's
answer as JSON text, or a tool error saying why the method failed.

- `rename_thread {title}`: `thread/rename` for the calling thread. The `renamed` event it
  journals has no `by`. A title that `thread/rename` would refuse comes back as a tool error
  saying why.
- `list_agents {}`: `agents/list`, so an agent chooses whom to hand work to. A configured
  agent's optional `description` (`[agents.<id>] description`) says what it's for, the part of
  an A2A Agent Card worth having here.
- `list_threads {agentId?, cwd?, repo?, activity?, project?}`: `threads/list`. With `project`,
  only the threads in that Project (see [Projects](#projects)).
- `read_thread {threadId, turnId?}`: `threads/get`.
- `start_thread {agentId, prompt, project?, cwd?, threadId?, approve?, otherwise?, key?}`:
  `thread/run`, starting a delegated thread, or prompting the thread `threadId` names. `prompt`
  is text; `cwd` defaults to the calling thread's directory, and with `project` is relative to
  the Project's location (see [Projects](#projects)); `approve` and `otherwise` are the policy
  asked for, within the ceiling. It answers with the thread, the turn it started (`turnId`)
  and the policy it runs under.
- `prompt_thread {threadId, prompt, key?}`: `queue/add`.
- `steer_thread {threadId, prompt}`: `turn/steer`.
- `cancel_thread_turn {threadId}`: `turn/cancel`.
- `list_hosts {}`: the Dispatcher's `hosts/list` (see [Other Hosts](#other-hosts)): this Host's
  id and the person's other Hosts, each with whether the Dispatcher is connected to it now, or
  why not.
- `list_projects {}`: the Dispatcher's Projects (see [Projects](#projects)).

Every tool but `rename_thread`, `list_hosts` and `list_projects` takes `host`, another Host's id or name as
`list_hosts` gives it, to act on that Host instead (see [Other Hosts](#other-hosts)); this
Host's own id acts here. The tool list stays the same as Hosts come and go; a call naming one
that can't be reached fails at once with a tool error.

### Projects

The person's Projects (ADR 0031) are the Dispatcher's, and Hosts know nothing of them, so the
Host tools that name one ask it (WVE-208). Agents read Projects; making and changing them is
the person's, with `weave projects`.

- **`list_projects`** is `service/hostCall` `{method: "projects/list"}`, with no `host`, which the
  Dispatcher answers itself, as `hosts/list`: `{hostId, projects, hosts}`, this Host's id, the
  Projects as the Dispatcher's `projects/list` gives them, and every Host it's paired with as
  `{hostId, name}`, this one included, so their locations' Hosts have names.
- **`project`** on `start_thread` and `list_threads` names one, by id or name ignoring case.
  The calling Host asks for the Projects first, then works out the call as for a directory: it
  sends no `project` on. An unknown Project fails as a tool error pointing to `list_projects`.
- **Starting in one.** `start_thread` with `project` works in the Project's location on the Host
  it starts on, `host`'s or this one's, and fails with a tool error naming the Hosts that have
  one when that Host doesn't. A `cwd` with it is a directory inside the location, relative to
  it; an absolute one, one under the home as `~/…`, or one reaching out with `..` is refused. On
  another Host a git Project's `remote` goes with it, so that Host checks its clone is the same
  repository.
- **The path guess goes.** `start_thread` on another Host with neither `cwd` nor `project`, from
  a thread whose directory is in a Project (as `containing` places it, by real paths), works in
  that Project's location there, in the same subdirectory as the calling thread is in its own
  worktree, and fails as above when the Project has none there. Only a directory in no Project
  gets the counterpart under the home (see [Other Hosts](#other-hosts)).
- **Listing one.** `list_threads` with `project` lists one Host's threads, `host`'s or this
  one's, keeping those `containing` places in the Project there: none on a Host where it has no
  location. With `cwd` or `repo` too, it's refused.
- Worktrees other than a git Project's main one wait for Sessions (WVE-202): `project` means the
  main worktree, and an agent names another by its absolute `cwd`, without `project`.

### Delegated threads

A thread an agent starts with `start_thread` is a delegated thread (ADR 0020): a thread of
its own, with its own journal and agent process, which clients list and attach to as any other.
It isn't a subagent thread.

- **Who started it.** Its journal's header records the thread that started it, which listings,
  `threads/get` and `ThreadState` give as `startedBy`. Turns a thread's agent begins in
  another thread, delegated or not, have the origin `{"thread": {"threadId": <the calling
  thread>}}`.
- **Reach.** An agent reads and acts on any thread on its Host, delegated or not: it lists,
  reads, prompts, steers and cancels any of them (ADR 0023, which replaced ADR 0020's rule that
  it act only on the threads it started).
- **The policy ceiling.** A delegated thread approves only tool kinds the starting thread's
  policy approves too, and rejects what isn't approved if either policy rejects it. The Host
  narrows a request for more, and the tool's answer says what policy the thread got. A thread
  started without `approve` or `otherwise` gets the starting thread's policy. An open delegated
  thread keeps its policy when prompted again, as `thread/run` keeps an open thread's.
- **Pending requests stay with people.** A thread's permission requests and elicitations are
  pending requests like any other, which its attached clients answer, or its policy. When one
  appears during a turn another thread's agent began, the Host reports it to that thread,
  which can tell the person; the calling agent can't answer it.
- **Reports.** When a turn another thread's agent began ends, the Host reports it to that
  thread: how it ended and the start of the agent's last message, as a message with the origin
  `{"thread": {"threadId": <the thread reported on>, "report": true}}`. It steers the report
  into the calling thread's running turn, or else adds it to that thread's queue, which starts
  a turn if none runs. A calling thread that isn't open is taken up again for it, under its own
  policy, as `thread/run` takes a thread up. A report's turn reports nothing back, so two
  threads never trade reports. A calling thread that can't be taken up, such as one deleted,
  isn't told, and the reported thread's journal says so in a `notice`. Turns a client sends
  are reported to nobody, even when an agent's shell ran the client.
- **Limits.** A thread may start threads only `depth` levels below a thread a person started
  (1 by default: a delegated thread can't start one), and may have at most `running` of its
  delegated threads running a turn or waiting on a request at once (3 by default), from the
  configuration's `[delegation]`. Neither limits prompting threads it didn't start. A tool call
  past either fails as a tool error saying so. A call to another Host counts the delegated
  threads it runs there toward `running`, as the Dispatcher counts them, and a thread another
  Host's agent started counts as one level down there; a start on this Host counts this Host's
  only, since it keeps no record of the others.

## Service origins

A service (ADR 0027; [Services](wve-90-remote-clients.md#services) in the remote clients spec)
may say what started a turn it sends with `thread/run`, `queue/add` or `turn/steer`:
`origin: {label, id}`, where `label` is what started it in the service's own words ("schedule
daily-review", "your message from iPhone") and `id` its own id for that, such as a trigger's
occurrence. The turn's origin is `{"service": {"name", "label", "id"}}`, with `name` the name
the Host knows the service by, which it takes from the Dispatcher it joined, never from the
request,
as `turnStarted`, `turnSteered`, `queued`, `threads/get` and a new thread's `openedBy` carry
it. Only a service may send `origin`, and not with `caller` (invalid params). The Host gives it
no other meaning. Clients show it as "schedule daily-review, via Dispatcher"; the TUI says
"Started by" that above the prompt. A client tool call in such a turn fails, since no person's
device sent it.

## Other Hosts

Feature `otherHosts` (WVE-185, [ADR 0029](../adr/0029-agents-reach-the-persons-other-hosts-through-the-dispatcher.md)).
A Host's agents reach threads on the person's other Hosts through the Host tools' `host`, by way
of the Dispatcher ([the Dispatcher spec](wve-175-dispatcher.md#calls-from-hosts-agents)), which
each of them joined, and which is a service to each. Hosts don't pair with or connect to each
other, and none
coordinates the others: the Host a thread runs on stays its only authority. It replaced peer Hosts
(ADR 0017, ADR 0024, WVE-109), which paired with each other.

```text
Host A (mini)                     Dispatcher                         Host B (studio)
  thread a1 ─ start_thread          its connection to A                its connection to B
    {host: "studio", …}               │                                  │
    └─ service/hostCall ────────────► writes it down, sends it ───────► thread/run
       {call: thread/run, caller}     {caller: {a1, A}, cwd: "~/…"}     thread b1: B runs it,
    ◄─ service/answerTool ──────────  follows the turn (threads/watch)   journals it, holds its
    ◄─ thread/report {a1, about b1}   reports its end                    pending requests
```

- **Saying it reaches the Hosts.** A service declares that it reaches the person's Hosts with
  `service/declareTools` `{tools, hosts: true}` (see [Service tools](#service-tools)). The Host
  keeps that with the Dispatcher it joined, across the Dispatcher's reconnects and its own
  restarts, until it leaves the Dispatcher, and passes the calls naming another Host to it while
  its connection serves it (it declared on that connection).
- **A call naming another Host.** A Host tool given `host` other than this Host's own id goes to
  that service as a `service/hostCall` notification: `{callId, host, call: {method, params},
  caller, room?}`, where `call` is the Host protocol method the tool is and its request as this
  Host works it out, and `caller` is the calling thread, as for a service tool. The service
  answers with `service/answerTool`, the method's answer as JSON text or a tool error, and gets
  `service/toolCallCancelled` when the agent stops waiting. `list_hosts` is `{method:
  "hosts/list"}` and `list_projects` `{method: "projects/list"}`, with no `host`. With no service that reaches the Hosts, or with it away, the
  call fails at once as a tool error saying so; `list_hosts` names this Host's id then.
- **What the calling Host works out.** For `start_thread` without `cwd` or `project`, from a
  thread whose directory is in a Project, that Project's location there (see
  [Projects](#projects)); from one in no Project, the calling thread's
  directory as it lies under this Host's home, `~/…`, in the repository's main worktree when the
  thread is in another one (whose branch the other Host may not have), and the repository's
  remote as `remote`; a thread outside the home has no such counterpart, and its agent names
  `cwd` itself. The policy asked for, within the calling thread's, as for a delegated thread
  here. The agent's own `key`, which the service makes the named Host's key from. And for a
  `start_thread` that starts a delegated thread, `room`: how many more of the caller's
  delegated threads may run on other Hosts, its `[delegation] running` less those running here;
  with none left, the tool fails here.
- **Acting for a thread.** The service sends `thread/run`, `queue/add` and `turn/steer` to the
  named Host with `caller: {threadId, host, hostName?}`, the thread on the calling Host whose
  agent asks. Only a service may give `caller`, and not with `origin`; it names another Host than
  the one it's sent to (invalid params otherwise). The turn's origin is `{"thread":
  {"threadId": <caller>, "host": <its Host's id>, "hostName": <its name>}}`, and a new thread
  records the caller as `startedBy` and its Host as `startedByHost`.
- **Where it runs.** `thread/run`'s `cwd` may be `~/…`, under this Host's home, and with
  `remote` the Host runs the thread there only if that directory is a checkout of the same
  remote, and otherwise refuses, saying what it found.
- **Reports.** `thread/report` `{threadId, about: {threadId, host, hostName?}, text, key?}`,
  a service's only, tells `threadId` `text` about the thread `about` names on another Host, as
  the Host reports on its own threads (see [Delegated threads](#delegated-threads)): into its
  running turn, or else through its queue, in the last of its successors, taking it up again if
  it isn't open. The report's origin is `{"thread": {"threadId": <about>, "host", "hostName",
  "report": true}}`. Under a key, a repeat tells nothing twice. The service writes the report in
  the Host's words, which `weave_host_protocol::reports` gives both.
- **Authority.** The named Host runs the thread, journals it, applies its policy, and holds its
  pending requests, which its clients answer; the calling agent never does. It never reports
  across Hosts itself: the service follows the turn and reports on it.
- **One hop.** A thread whose running turn another Host's agent began, or that another Host's
  agent started, or that one of those started, reaches no other Host: its Host tools fail if
  given `host`, and the service refuses such a call too.
- **Clients.** A thread another Host's agent started shows its `startedBy` and `startedByHost`,
  and a turn's origin its `hostName`: the TUI says "A thread on mini", and the app, which reaches
  every Host the Dispatcher lists, names the thread that started it and that thread's Host when it
  lists both.
- **Peer Hosts retired.** A Host that paired with peers drops those pairings, with every other
  device that paired with it (WVE-197), and removes `peers.json` and `host-key.json` when it
  starts. It keeps one secret of its own since ADR 0030: its key for the Dispatcher it joins.

## Files

Clients that aren't on the Host's computer can't look at its files themselves, so the Host
answers for them, in one family of methods with shared rules:

- Paths are absolute on the Host's computer.
- Each method is a `features` entry of its own.
- Nothing writes.
- Names come before contents: a listing gives names and kinds, never sizes, times or contents.
- They reach whatever the Host's user can read. A client that can start an agent in any
  directory reaches that much already, so remote clients may use them too.

**`files/list`** `{path?, hidden?}` → `{path, parent?, home, entries: {name, kind}[], truncated?}`

Feature `files/list`. What a directory holds, so a client can pick where a thread runs. Without
`path`, it lists the Host user's home directory. The answer gives:

- the directory listed, without `.` or `..` but with symlinks as named, so a thread's directory
  reads as the person chose it;
- its parent, absent at the root;
- `home`, so clients can show paths under it as `~`.

`kind` is `directory`, `file` or `other`, following symlinks. Directories come first, then by
name. Names starting with a dot are left out unless `hidden`, and names that aren't UTF-8 always
are. At most 2,000 entries are given; `truncated` says there were more. A relative path, a
missing one or one that isn't a directory fails with invalid params, whose `data` says which.

Later methods join the family:

- `files/search` serves `@` mentions: the thread directory's files, matched as the TUI's
  picker does (`tui/src/file_popup.rs`, `.gitignore` honored).
- `files/read` serves attachments: a file as the content block the TUI's `@` mentions attach
  (`tui/src/attachments.rs`).

Shell commands, the other method remote clients need, would be a family of their own, since they
run things rather than read them.

## Worktrees

The Host is git-aware (ADR 0019): it knows where in a git repository each thread's directory
is, and lists, makes and removes a repository's worktrees for clients, as a phone can't. It runs
the `git` command with the agents' environment, so the person's git configuration and hooks
apply; it never prompts, and its reads take no optional locks.

```ts
type GitLocation = {
  repo: string;       // the repository, by its primary worktree
  worktree: string;   // the worktree the directory is in: the primary one or another
  branch?: string;    // absent when HEAD is detached
  remote?: string;    // "github.com/owner/name": origin, else the first; no credentials or .git
};
```

When a thread opens (created, run, or taken up again) the Host reads its location while it
starts the agent, and records it in the header of any journal it begins, so listings of threads
that aren't open give it. After each of the thread's own turns it reads it again,
and an attached client hears of a change in `thread/changed`, a watcher in
`threads/updated`. A thread outside a repository, and one from a journal from before, has
no `git`. Paths in repositories are given and compared with symlinks resolved.

Worktrees are the person's, beside threads rather than parts of them, so clients manage the
two together or apart: make a worktree, then `thread/create` in it; or remove a worktree with
its threads. New worktrees go where worktrunk puts them by default, beside the repository as
`<repo>.<branch>` with `/` and `\` in the branch made `-`, so worktrunk in a terminal manages
the same ones. The Host never removes a worktree on its own: pruning a journal leaves its
worktree alone. These methods are feature `worktrees`; remote clients may use them.

**`worktrees/list`** `{repo}` →
`{repo, remote?, defaultBranch?, worktrees: {path, branch?, head?, primary?, changes?, divergence?: {ahead, behind}, upstream?: {name, ahead, behind}, threads: threadId[]}[]}`

The repository `repo` is in (any directory in it), by its primary worktree, and its worktrees,
the primary one first, then by path; worktrees whose directory is gone are left out.
`defaultBranch` is the remote's default branch (`refs/remotes/<remote>/HEAD`), else `main` or
`master`. For each worktree: `changes` counts staged, unstaged and untracked files, not ignored
ones; `divergence` is how far its HEAD is from the default branch; `upstream` is the branch it
tracks; `threads` are the threads the Host has a record of in it (in its directory or below,
the deepest worktree winning), open or not, blank ones aside, most recently active first.

**`worktrees/create`** `{repo, branch, base?}` → `{path, branch, createdBranch?}`

A worktree for `branch`, beside the repository. A branch that doesn't exist is made from
`base` (a branch, tag or commit; by default the default branch, else the primary worktree's
HEAD) and `createdBranch` says so. One that exists locally, or only on a remote (which git then
tracks), is checked out, and refuses a `base`. Invalid params when `branch` isn't a branch
name (`git check-ref-format --branch`), another worktree has it checked out, or the directory
exists; `git_failed` with git's own words when it refuses.

**`worktrees/remove`** `{path, force?, deleteBranch?}` → `{closed: threadId[], branch?, branchDeleted?}`

Removes a worktree other than the primary one, which must be its top directory:

1. Refused with `worktree_busy` while a thread in it runs a turn or waits on a request; `data.threads` says which.
2. Refused with `uncommitted_changes` when it has changes, unless `force`, which loses them.
3. The threads open in it close (`closed`); their journals stay, so they list as closed and
   can still be deleted, as threads whose directory is gone (WVE-120).
4. `git worktree remove`; then its branch goes when git counts it merged (`git branch -d`),
   or regardless with `deleteBranch`.
5. Its Session ends (see [Sessions](#sessions)).

**`worktrees/release`** `{path}` → `{closed: threadId[]}`

What `worktrees/remove` does before git removes the worktree, for removals the Host doesn't
make: refused with `worktree_busy` while a thread in the worktree runs a turn or waits on a
request; otherwise its open threads close and its Session ends. `weave worktrees pre-remove`
asks it as a worktrunk `pre-remove` hook, so `wt remove`, `wt merge` and `wt step prune` stop
while a thread needs the worktree.

### A repository of its own

Feature `repos_init`, WVE-178. A client that isn't on the Host's computer makes a directory there
a git repository of its own, with its first files committed, as the Dispatcher makes a Bot's
home ([Its home](wve-175-dispatcher.md#its-home)). The Host knows nothing of what it's for. Any
client may ask it, remote ones and services among them.

**`repos/init`** `{path, files?: {path, text}[], message?}` →
`{path, created?, initialized?, files?: {state: "committed"} | {state: "kept", file} | {state: "uncommitted", why}}`

1. `path` is whole on the Host's computer, or `~/…` under its user's home. A directory that is,
   or would be once made, inside another repository's work tree is refused before anything is
   made, since a repository of its own is asked for; the top of a repository is taken as it is.
2. The directory is made, with its parents, if it isn't there (`created`), and `git init` makes it
   a repository unless it's the top of one already (`initialized`). The answer's `path` is the
   directory whole, with symlinks resolved.
3. `files`, UTF-8 text at paths relative to the directory and within it (no `..`, no `.git`,
   each once), need a `message`. If any of them is there already, as a file, a directory or a
   link, none is written and nothing is committed (`kept`, naming the first that was). Otherwise
   each is written, never over anything, and those files alone are committed with `message`
   (`commit --only`), as the user git's configuration or environment names, running the hooks
   the person's own commits run (`committed`). Without a `user.name` and `user.email` for git,
   or when the commit fails, they're left written but uncommitted, saying why (`uncommitted`).
   `files` is absent from the answer when none were named.

Nothing else in the directory is touched or committed, so what was staged or untracked there
stays so. Invalid params, the message saying why, for a `path` neither whole nor under `~`, a
file path outside the directory or named twice, files without a message, a directory inside
another repository, and one that can't be made or isn't a directory; `git_failed` when `git
init` fails.

## Sessions

Status: Built in the Host, 2026-11-09 (WVE-202), and changed with the app on 2026-11-10
(WVE-203): a client makes a Session, which holds what clients add to it, and Blocks no longer
stack. ADR 0031; part of [WVE-199](https://linear.app/jacobfvanzyl/issue/WVE-199).

A Session is one directory on the Host's computer, the threads and terminals a client put in
it, and the layout clients show them in: tabs of Blocks, docked side by side or floating, each
of which points at a thread, a terminal or something else on this Host. The Host keeps the
layout so that every device shows the same one, as Herdr's core keeps its spaces' layout. It
stores and versions the layout but never reads it.

**Identity.** A Session is known by its directory, which is a terminal's scope: the deepest
worktree a directory is in, or the directory itself outside a repository, with symlinks
resolved. Every worktree of a repository is a Session of its own, there is one Session per
directory, and a request may name any directory inside one. The Host knows nothing of Projects
(ADR 0031), so a directory outside every Project has a Session too, and clients group Sessions
under Projects with the Dispatcher's `projects/list`, by `git.repo`.

**Lifetime.**

- A client makes a Session: by setting a layout for a directory that has none (`sessions/set`),
  or by adding a thread or terminal to one (`sessions/add`), which makes it without a layout.
  The Host makes none on its own: a directory where threads only ran from a terminal, a
  schedule or another program has no Session. A Host that works so says `sessions_add` in
  `features`. One from before it made a Session for any directory a thread was prompted or a
  terminal started in; those that no client ever set a layout for are dropped when a Host with
  the feature loads them.
- A Session ends with its worktree, through `worktrees/remove` or `worktrees/release`, and when
  its directory is gone, as when git removed the worktree without the Host: such a Session
  ends as the Host starts, and as a client lists Sessions. A client may also end one with
  `sessions/end`.
- A Session that ends is gone for good, with what was in it. When a client ends one, its open
  threads close, as `thread/close` closes them, its terminals end, and its layout is forgotten;
  nothing brings it back. Its directory stays, a worktree too, and so does whatever else is in
  the directory that was never the Session's. A Host that does this says `sessions_end` in
  `features`: one from before it only forgot the layout, leaving the threads and terminals
  without a Session.

**What's in one.** A Session's threads and terminals are those a client added to it
(`sessions/add`), as it starts one in a Block or gives a Block to one started elsewhere, and
those its own threads started: a thread started with the Host's thread tools by a thread in
it, in the same directory, and a terminal opened from one (`openedFrom`). Nothing else in its
directory is its: a thread from the TUI or a schedule stays outside until a client adds it. A
thread that closes stays the Session's, to be opened again; one that's deleted, and a terminal
that ends, leave it.

Sessions are kept with the Host's other state, one file each in `layouts/` in the Host's
directory, written whole, so they survive the Host's restarts and updates. A Host inside a
client keeps them in memory. These methods are feature `sessions`; remote clients may use them.

```ts
type HostSession = {
  directory: string;     // a worktree, or a directory outside a repository
  revision: number;      // 0 before any client set a layout, then one more with each write
  layout?: SessionLayout; // absent before any client set one, and in sessions/list
  git?: GitLocation;     // absent outside a repository
  createdAt: number;
  updatedAt?: number;    // when its layout was last set
  threads: threadId[];   // its own threads the Host has a record of, open or not, most recently active first
  terminals: string[];   // its own terminals' ids, oldest first
};
```

`threads` and `terminals` are the Session's own, not all its directory holds, and let a client
place again a thread or terminal that no Block shows. A thread added before its first prompt is
among them, though no listing has it yet. `sessions/updated` is sent when one joins;
`threads/watch` and `terminals/watch` follow what each is doing, and one that's deleted or ends
leaves without a notification.

**`sessions/list`** `{}` → `{sessions: HostSession[]}`

Every Session, by directory, without its layout. The Host reads where in a repository each one
is again, and ends those whose directory is gone first.

**`sessions/get`** `{directory}` → `{session}`

The Session `directory` is in, with its layout; `no_session` when there's none.

**`sessions/set`** `{directory, layout, ifRevision?}` → `{session}`

A new layout for the Session `directory` is in, which is made first if there's none. The newest
write wins: the layout replaces whatever was there under the next revision, so revisions only
go up, and every client watching the Session is sent it. With `ifRevision` (0 for a Session
without a layout), the write happens only while that is still the Session's revision, and is
otherwise refused with `revision_conflict` and `data: {revision}`, so a client can merge rather
than overwrite. A layout over 1 MiB serialized (`maxLayout`) is refused as invalid params. The
directory must exist.

**`sessions/add`** `{directory, threads?, terminals?}` → `{session}`

The threads and terminals are the Session's that `directory` is in from now on, which is made
first if there's none, without a layout and at revision 0. Each must be in the Session's
directory: a thread by its worktree, or outside a repository its own directory, and a terminal
by its scope; otherwise invalid params, and nothing is added. One that's already the Session's
changes nothing. It leaves the revision as it was, and every client watching the Session is
sent it when something joined. Feature `sessions_add`.

**`sessions/watch`** `{directory?}` → `{directory?, sessions: HostSession[]}`

The Session `directory` is in, as the Host resolved the directory, or with no `directory` every
Session, with their layouts. Then, until the connection ends or the client sends
`sessions/unwatch`, `sessions/updated` `{session}` when one is made, its layout set or
something joins it, with the layout, and `sessions/ended` `{directory}` when one ends. Nothing reaches the watcher between
the answer and the first notification. A directory with no Session yet may be watched: the
answer has no Session, and `sessions/updated` follows when one is made. A device showing a
Session watches it; a sidebar watches every Session.

**`sessions/unwatch`** `{directory?}` → `{}`

Stops what `sessions/watch` sends for `directory`, as its answer gave it, or for every Session
without one.

**`sessions/end`** `{directory}` → `{}`

Ends the Session `directory` is in, for good, as above: its open threads close, its terminals
end, and its layout is forgotten. Only what's the Session's: a thread or terminal in its
directory that was never added to it carries on, and a directory inside it that's another's,
as a worktree nested in it, keeps its own. Refused with `session_busy`, with nothing closed,
while a thread of its runs a turn or waits on a request, or a terminal of its runs a command
(`data: {threads, terminals}`); `no_session` when there's none.

### The layout

The layout is the clients' document, not the Host's: the Host keeps it as JSON it doesn't read,
so new Block types never change the protocol. Its shape is in `weave-host-protocol`
(`sessions::layout`), with golden fixtures and in the JSON Schema the app's types come from, so
every client agrees on it. A client checks `version` (2 now, `layoutVersion`) before it trusts
the rest. A Block in a tab is docked in the tab's tree, alone in its place, or floats over it,
where it can be minimized: put away as its name, to bring back. Version 1 also had `stack`
nodes, Blocks one behind another in one place; a client reading one keeps a stack's first Block
where it was and leaves the rest out, which carry on without a Block.

```ts
type SessionLayout = { version: 2; tabs: SessionTab[] };
type SessionTab = {
  id: string;                    // unique in the layout
  title?: string;                // the person's name for it
  root?: SessionNode;            // its docked Blocks; absent for a tab with none
  floating?: {                   // last on top
    block: SessionBlock;
    frame: { x; y; width; height }; // fractions of the tab; where it comes back to when minimized
    minimized?: boolean;
  }[];
};
type SessionNode =
  | { kind: "row" | "column"; children: SessionNode[]; sizes?: number[] } // relative shares
  | ({ kind: "block" } & SessionBlock);
type SessionBlock = {
  id: string;                    // unique in the layout
  type: string;                  // reverse-DNS: weave.thread {threadId}, weave.terminal {terminalId}, …
  props?: Record<string, unknown>;
};
```

What stays on each device is never written to it: focus, zoom, the tab in front, scroll
positions, and how a device presents the layout, as a phone shows each
tab as a stack. A client without a Block's type shows the type and props as text (ADR 0018's
text floor). A Block points at what it shows, and the Host knows nothing of that: a client that
closes one closes its thread (`thread/close`), which can be shown again, or ends its terminal
(`terminals/close`), which is one to one with its Block (ADR 0031, as WVE-203 settled it). A
thread or terminal no Block shows runs on, and clients list it as not shown.

## Terminals

Status: Built in the Host (WVE-152), the holder (WVE-151) and the app (WVE-153), 2026-10-26,
after two spikes checked it: a holder in Rust (WVE-149), and the app's native renderer on the iPad
(WVE-150).
ADR 0022; [WVE-148](https://linear.app/jacobfvanzyl/issue/WVE-148). The Host offers it when
`weave-holder` is installed beside it.

A terminal is a shell on the Host's computer that clients show beside a thread. It belongs to a
worktree, or to a directory outside a repository, and every thread in it shows the terminal. It
lives in a holder, a process of its own that outlives the Host. Where it shows is each client's
choice, so nothing here describes panes or layout.

The concepts and names follow Rex's block model, in this protocol's casing. Its terminal methods
`format`, `write` and `resize`, its properties `pwd`, `title`, `process`, `size` and
`program_status`, and its terminal events all have counterparts here, so a Rex block can later
stand in for a holder.

A terminal's owner keeps it alive: a holder, or later a Rex block. The Host reaches owners
through one interface, of which the holder protocol is the first implementation, and nothing
above that interface depends on which owner a terminal has. What weave adds to Rex's model
(`scope` aside) is optional, and clients work without it: `openedFrom`, `command`, and the snapshot
restore.

These methods are feature `terminals`. Remote clients may use them, since a client that can
start an agent in a directory can already run anything there.

```ts
type Terminal = {
  id: string;            // permanent and opaque: a holder's, or later a Rex block's
  scope: string;         // the worktree it belongs to, or its directory outside a repository
  label?: string;        // the person's name for it
  openedFrom?: string;   // the thread it was opened from, which puts it in front by default
  title?: string;        // OSC 0 and 2
  pwd?: string;          // the directory the shell reports (OSC 7), as a path: the Host drops the URL's scheme and host
  process?: {foreground: {pid: number; name: string}};
  size: {cols: number; rows: number};
  command?: {running: boolean; exitCode?: number};  // OSC 133: one running, or how the last ended; weave's, absent where the owner doesn't report it
  programStatus: ProgramStatus[];                   // OSC 7501's records, as Rex keeps them
  startedAt: number;
};

type ProgramStatus = {
  id?: string;           // "build/test"; absent for the root record
  state: "idle" | "working" | "done" | "blocked" | "error";
  kind?: "permission" | "question" | "auth";
  progress?: number;     // 0 to 100
  app?: string;
  title?: string;        // decoded from base64
  msg?: string;          // decoded from base64
};
```

**`terminals/list`** `{directory}` → `{scope, terminals: Terminal[]}`

The terminals of the worktree `directory` is in (the deepest, as for `worktrees/list`), or of
`directory` itself outside a repository, oldest first.

**`terminals/watch`** `{directory}` → `{scope, terminals: Terminal[]}`, then notifications
until **`terminals/unwatch`** `{scope}`:

- `terminals/updated` `{terminal}`: one started or a property changed;
- `terminals/removed` `{id, scope, exitCode?}`: one ended.

**`terminals/new`** `{directory, label?, openedFrom?, command?: string[]}` → `{terminal}`

A holder starts the person's login shell in `directory`, or runs `command` under it, as Ghostty
starts a shell:

- in the agents' environment ([Environment](#environment));
- under `login -flp` on macOS, as Ghostty does, and `/bin/sh -c` on Linux;
- with `TERM=xterm-ghostty` and Ghostty's terminfo, and `COLORTERM=truecolor`;
- with `TERM_PROGRAM=weave`, not `ghostty`, which would promise features the app doesn't draw,
  such as Kitty graphics;
- with Ghostty's shell integration injected for zsh, bash, fish, elvish and nushell. Apple's
  `/bin/bash` is left alone, since it is too old for it.

The terminal belongs to `directory`'s worktree. Its size is that of the first client to attach,
80×24 until one does. Invalid params when `directory` isn't a directory.

**`terminals/close`** `{id}` → `{}`

Hangs up the shell's process group. The holder ends once the shell exits.

**`terminals/setLabel`** `{id, label}` → `{terminal}`

**`terminals/write`** `{id, text}` → `{}`

Text as if typed, for clients that don't attach.

**`terminals/format`** `{id, format: "text" | "vt", history?, trim?}` → `{content}`

The visible screen through libghostty-vt's formatter, with its history too when `history` is
set. With `vt`, styles, cursor, modes and the palette are included.

**`terminals/attach`**, **`terminals/close`** and the others answer `unknown_terminal` for an id
the Host has no terminal by, and `terminals/new` answers `terminal_unavailable` when no holder
could be started.

**`terminals/attach`** `{id}` → `{ticket, expiresAt}`

A ticket for the terminal's stream, good once, within 30 seconds. A device's ticket opens a
stream only on a connection the Dispatcher carries for that device, so revoking the device closes
it too (4000). A local client's ticket opens a stream on the Host's terminal socket,
`terminals.sock` beside its own socket, which it always serves when it has terminals: a WebSocket
over the Unix socket, from peers of the Host's user only (WVE-167).

### The terminal stream

Each attached terminal streams over a WebSocket of its own, beside the client's connection: on
the Host's terminal socket for a local client, or carried by the Dispatcher for a device
([Connections the Dispatcher carries](#connections-the-dispatcher-carries)). It uses subprotocol
`weave-terminal`.

Opening the stream:

1. The client's first text frame is
   `{"ticket", "size": {"cols", "rows"}, "codec", "history"?}`. `codec` names the Ghostty commit
   the client's libghostty-vt was built from, and its snapshot format. libghostty-vt reports the
   same version at every commit, so only the commit tells two builds apart. `history` asks for
   the history above the screen in a `vt` restore too, and its resyncs, for a client whose own
   terminal keeps scrollback, as `weave terminals attach` does; a holder from before it sends
   the screen alone.
2. The Host answers with `{"terminal": Terminal, "restore": "snapshot" | "vt", "restoreBytes"}`,
   `restoreBytes` saying how much restore follows before the output does, and `terminal` being
   the terminal as the restore has it, so a `vt` restore is drawn at its `size`. The Host sizes
   the terminal for the stream, if it's to, before the restore is made:
   * `snapshot` when the holder's codec is the client's;
   * otherwise `vt`, the formatter's VT of the visible screen, without history.

   `vt` is a path of its own, not an error. It's the restore whenever the owner's libghostty-vt
   isn't the client's, as a Rex block's would usually be. After a `vt` restore, a client carries
   on with output, input and resizes as after a snapshot, and lacks only the history from before
   it attached.
3. Then the stream starts.

Binary frames carry a kind byte and a payload, the same kinds as the holder's own frames, so the
Host passes them on unchanged:

| Kind | From | Payload |
| --- | --- | --- |
| `0x01` | Host | The restore. A snapshot is one byte stream in chunks, in which the client's decoder finds the ready prefix and the history pages itself |
| `0x03` | Host | Output, the program's bytes unchanged |
| `0x10` | Client | Input: keys, mouse and paste, encoded by the client's libghostty-vt from the terminal's current modes |

Text frames from the Host:

* `{"updated": Terminal}`;
* `{"bell": {}}`;
* `{"notification": {"title", "body"}}`;
* `{"progress": {"state", "progress"}}`;
* `{"clipboard": {"text"}}`, only to the device that last typed;
* `{"resync": {"restore", "restoreBytes", "size"}}`: the client fell behind, and a new restore
  follows in `0x01` frames and replaces its screen, a `vt` one drawn at `size`;
* `{"resized": {"cols", "rows"}}`: the terminal took a new size at this point in the output, so
  the client's screen takes it where the owner's did;
* `{"exited": {"exitCode"}}`, after which the Host closes the stream (4011).

A stream whose ticket is missing, used, late or another device's is closed with 4010. A device
that reaches the Host through the Dispatcher opens its stream there, carried as its Host
protocol connection is, with `stream: "terminal"`
([Connections the Dispatcher carries](#connections-the-dispatcher-carries)).

Text frames from the client: `{"resize": {"cols", "rows"}}`, and `{"resync": {}}`, which asks
for a fresh restore, in a `resync`, for a client that stopped drawing while another device's
size held. A holder from before it sends none.

Output, restores and input:

* Output follows the restore, in order. A client draws once its decoder reaches the ready prefix,
  and adds the history pages as the rest arrives.
* A stream whose unsent output passes 4 MiB is resynchronized: the Host drops what it hasn't sent
  and restores the stream again from a fresh snapshot.
* A client keeps the stream's bytes out of slow paths. The app's native plugin holds the
  WebSocket itself, since base64 through the web view's bridge held a spike to 5 to 10 MiB/s
  (WVE-150).

Size and replies:

* Size is the owner's policy, and a client's `resize` is a request. A holder's policy: the last
  device to type sets the terminal's size, and the others clip. While it's the last, its own
  resizes (a rotation, a keyboard rising) apply at once. Another device's size applies when it
  next sends input. A Rex block would follow Rex's own rule.
* The client's libghostty-vt answers nothing. Only the holder replies to the program's queries.

### Holders

Each terminal has a holder, `weave-holder`, a process that keeps its PTY, its shell and the
authoritative libghostty-vt.

Where holders are and how they run:

* A holder's record and socket are under the Host's directory (`DaemonPaths`), in `terminals/`,
  so a Host beside the installed one has terminals of its own.
* The Host starts holders outside its own process tree. On Linux each runs in a systemd unit of
  its own, through `systemd-run --user`. A `setsid` and a double fork aren't enough there:
  stopping the Host's unit kills them with its cgroup (WVE-149). On macOS a holder runs in a
  session of its own.
* `weave-holder` is installed beside `weave`, never on a removable volume. launchd can't open a
  binary on one without the person's consent.
* The Host finds holders again by their sockets after it restarts, and removes the records of
  holders that don't answer. A killed holder leaves its record and socket behind.
* A holder ends when its shell exits, after telling the Hosts attached to it.

The holder protocol:

* Each frame is a big-endian u32 length, then a kind byte and the payload:
  * `0x00`: JSON, either way;
  * `0x01`: snapshot bytes, from the holder;
  * `0x03`: output, from the holder;
  * `0x10`: input, to the holder.
* Requests are `{"id", "method", "args"}`, as Rex's server API takes them. Answers are
  `{"id", "result"}` or `{"id", "error": {"code", "message"}}`, with Rex's codes `bad_request`
  and `method_not_found`. Events are `{"type", "payload"}`.
* Its methods are Rex's terminal methods under Rex's names: `format` (`text`, `vt` or `html`,
  with `trim` and `unwrap`), `write`, `resize`, `process`, `pwd`, `title`, `size`,
  `program_status`, `set_label`, `attach` and `close`. The holder adds `hello` (its protocol
  version and codec), `describe`, `subscribe` and `resync`, which sends an attached client a
  fresh restore after a `resync` event, dropping what it hadn't sent.
* Its events are Rex's terminal events, with Rex's payloads: `child_exited`, `pwd_changed`,
  `title_changed`, `bell`, `process_changed`, `desktop_notification`, `progress_report`,
  `clipboard_written`, `program_status_changed` and `program_status_removed`. The holder adds
  `command_changed` (OSC 133), `size_changed`, `label_changed` and `resync`.
* `attach` takes `restore`: `snapshot`, the default, or `vt` for a client of another codec, which
  gets the formatter's VT of the visible screen, and its resyncs too; with `history`, the VT
  holds the history above the screen as well, which a fresh terminal of the same size scrolls
  into its own. It answers
  `{codec, restore, snapshot_bytes, terminal}`, then sends the restore and all later output, in
  order, with each `size_changed` where the terminal took the size.
* `format` takes `format` (`text`, `vt` or `html`), `trim`, `unwrap` and `history`; without
  `history`, the visible screen alone.
* Each attached client has an outbox of its own. One that falls 4 MiB behind gets `resync`, with
  the terminal's `size`, and a fresh snapshot.
* It is versioned in `hello`. A Host speaks the version of every holder still running, since a
  holder keeps the weave it started with until its shell exits.

When terminals are built, `worktrees/remove` and `worktrees/release` also refuse with
`worktree_busy` while a terminal in the worktree runs a command (`data.terminals`), and
otherwise close its terminals along with its threads.

## Host management

**`host/status`** `{}` →
`{protocol, version, pid, startedAt, service: "launchd" | "systemd" | "onDemand" | "inProcess", environment: "loginShell" | "process", threads: ThreadListing[], dispatcher?: JoinedDispatcher, serveEntry?: {port, command, why}}`

`threads` lists the open threads. `dispatcher` is the Dispatcher the Host joined and how its
connection stands. `serveEntry` is the Tailscale Serve entry the Host made for remote clients
before WVE-197, while it's there and the Host couldn't remove it: its port, the command that
removes it for the person to run, and why the Host couldn't. Asked by a local client, the Host
looks again first ([remote clients](wve-90-remote-clients.md#the-hosts-own-remote-access-retired)).
Until WVE-197 it gave `remote`, its WebSocket's loopback address, which no Host gives now.

**`host/shutdown`** `{}` → `{}`

Suspends every open thread (closing blank ones) and exits, without waiting for running
turns.

**`host/drain`** `{wait?: bool, except?: string}` → `{running: number}` (feature `drain`)

Gets the Host ready to stop (WVE-143). From then on it starts no new turns: `turn/start` and
`thread/run` answer `host_stopping`, `queue/add` queues, and queued prompts wait for the Host
that comes back; steers and answers to pending requests still go through. With `wait` it
answers once no turn runs, or one waits on someone, but the turn of the agent process named
`except` (its `WEAVE_AGENT_PROCESS`), or when its drain timeout (5 minutes) passes; without
it, at once. `running` is how many such turns still run, which the stop cuts off. The stop
that follows doesn't wait again. If the asking client goes before the Host stops, the drain
ends and queues start what waits in them. Local clients only.

### Running the Host

The Host is the `weave daemon run` process; the CLI keeps the `weave daemon` command.

- **On demand.** When no Host is listening, a client command starts one in the background
  as now. That Host exits after 10 minutes with no open thread and no client.
- **Stopping waits for running turns.** `weave daemon stop` and `restart` drain the Host
  first (`host/drain`), saying how many turns they wait for, for up to 5 minutes; `--now`, or
  Ctrl+C while waiting, stops them instead. A `weave` an agent runs leaves that agent's own
  turn out of the wait. A Host told to stop by a signal (SIGTERM, as from a service manager)
  drains the same way unless a client drained it already, and a second signal stops it at
  once.
- **As a service.** `weave daemon install` has the computer's service manager run this
  `weave` binary's `daemon run` and restart it if it exits, with no idle exit, logging to
  `daemon.log`. `weave daemon uninstall` removes it. While it's installed, `start`, `stop`
  and `restart` go through the manager, and the CLI never starts a Host of its own.
  Installing again points the service at the current binary. A Host directory of its own
  (`WEAVE_DAEMON_DIR`) gets a service of its own. Everything here works over SSH with no
  terminal, so a Host on another computer is set up and managed through its CLI (ADR 0017).
  - **macOS** gets a launchd user agent, `local.weave.host`, which runs at login. macOS
    keeps the processes launchd starts out of `~/Documents`, `~/Desktop` and `~/Downloads`
    until they're let in, so `install` refuses a binary in one of them, and macOS may ask to
    let weave in when an agent first works in a thread there. launchd allows the Host 20
    seconds to stop, so logging out doesn't wait for running turns; `stop` and `restart`
    drain before they boot it out.
  - **Linux** gets a systemd user service, `weave-host.service` in
    `~/.config/systemd/user`, enabled for `default.target`; `restart` is one
    `systemctl --user restart`, so it completes even when an agent inside the Host asks for
    it. The user manager runs only while the person is logged in unless lingering is on, so
    `install` turns it on (`loginctl enable-linger`, which polkit lets a user do for
    themselves by default) and says how when it can't; then the Host starts at boot and keeps
    running after the SSH session ends. The unit's `KillMode=mixed` signals the Host alone, which
    stops its agents itself, and its `TimeoutStopSec` (330 seconds) covers the drain and then
    suspending every thread (30 seconds). `weave daemon status` says when lingering is off,
    and when systemd gives the user manager less than the 30 seconds to stop at shutdown
    (`user@<uid>.service`'s `TimeoutStopUSec`, five seconds on Ubuntu 24.04), with the
    drop-in that raises it; a shutdown cuts a drain short, as it would the turn. The socket is in the user's
    runtime directory, `/run/user/<uid>/weave`, which the CLI finds also from a session that
    sets no `XDG_RUNTIME_DIR`, as Tailscale SSH doesn't.
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
| -32063 | `unknown_thread` | the Host doesn't know the thread and wasn't told its agent and directory |
| -32064 | `thread_not_open` | the request needs an open thread |
| -32065 | `turn_running` | a turn already runs in the thread |
| -32066 | `already_resolved` | the pending request was answered, cancelled or withdrawn |
| -32067 | `wrong_agent` | the thread belongs to another agent |
| -32068 | `requires_terminal` | the sign-in method needs a terminal on the Host's computer |
| -32069 | `forbidden` | a remote client asked to administer the Host, or a service asked what it may not |
| -32070 | `not_target` | the client tool call is for another client |
| -32071 | `remote_unavailable` | remote access couldn't be turned on |
| -32072 | `worktree_busy` | a thread in the worktree runs a turn or waits on a request; `data: {threads}` |
| -32073 | `not_a_repository` | the path isn't in a git repository |
| -32074 | `git_failed` | git refused or failed; the message is what it said |
| -32075 | `uncommitted_changes` | the worktree has changes that removing it would lose |
| -32076 | `key_reused` | the request key was used for another request (see [Request keys](#request-keys)) |
| -32077 | `host_stopping` | the Host is draining before it stops and starts no new turns (see `host/drain`) |
| -32080 | `unknown_turn` | the thread's journal has no turn by that id (see [Turn ids](#turn-ids)) |
| -32081 | `host_unavailable` | the Dispatcher couldn't reach a Host or the Host refused it; the message says why. Peer Hosts gave it as `peer_unavailable` |
| -32078 | `unknown_terminal` | no terminal has that id |
| -32079 | `terminal_unavailable` | the terminal's holder couldn't be started or reached; the message says why |
| -32082 | `interrupted` | in a turn's `turnEnded`, not a request's answer: the Host stopped while the turn ran (see [Interrupted turns](#interrupted-turns)) |
| -32083 | `no_session` | the directory has no Session (see [Sessions](#sessions)) |
| -32084 | `revision_conflict` | `sessions/set`'s `ifRevision` isn't the Session's revision; `data: {revision}` |
| -32085 | `session_busy` | a thread in the Session runs a turn or waits on a request, or a terminal in it runs a command; `data: {threads, terminals}` |

## Versioning

- The protocol has an integer major version. It started at 2; the `_weave/*` ACP extension
  was version 1. Version 3 says thread where version 2 said session, in its methods, fields,
  types, errors and Host tools (ADR 0031, WVE-200); ACP's own names keep session.
- `host/hello` negotiates it: the client sends the range it speaks, and the Host chooses
  the highest version in both. A Host supports its current major version and may support
  the one before it. Version 3 kept none of version 2's names, so a version-3 Host speaks
  version 3 alone and refuses a version-2 client with `incompatible_protocol`. Version 1
  isn't supported; see [Cutover](#cutover).
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
- The protocol is also kept as one JSON Schema (`protocol/tests/schema.rs`, behind the
  crate's `schema` feature): every request, answer and notification, the ACP types they
  carry, which method takes and gives which, and the protocol's constants. Clients in other
  languages generate their types from it; the app's TypeScript (WVE-100) is checked against it,
  and the Dispatcher's API is kept beside it, for the app, which pairs with the Dispatcher
  (WVE-196).

The TUI and the Host ship in one binary, so they normally agree. A TUI that meets an
incompatible Host after `weave daemon restart` `/reload`s itself into the current binary,
as it does now.

## Security

- The socket's file mode and directory, and the peer user id check, are the whole of `local`
  authentication. `local` is never accepted on a network transport.
- Clients can't make the Host run a command or set an agent's environment: the protocol has no
  field for either. The one path of their choosing it writes to is `repos/init`'s.
- `files/*` read only, and only what the Host's user can (see [Files](#files)).
- `worktrees/*` write only what git does: a worktree beside a repository, on a branch, and
  removing a repository's worktree other than its primary one (see [Worktrees](#worktrees)).
  Git runs the repository's own hooks, which no client sets.
- `repos/init` (WVE-178) makes a directory where the client says, as the Host's user, and writes
  the files it names there only where nothing is, within that directory and never in `.git`,
  in a directory that isn't inside another repository (see
  [A repository of its own](#a-repository-of-its-own)). It writes over nothing and commits only
  those files.
- `agents/terminalSignIn` is the only response that carries a command, and only `local`
  clients that claimed `terminalSignIn` get it.
- Journals and traces stay 0600. The agent environment is never written or sent.

Remote clients follow ADR 0010, ADR 0030 and
[`wve-90-remote-clients.md`](wve-90-remote-clients.md): a Host listens for nothing but its
socket, and the person's devices reach it through the Dispatcher, to which each proves its key;
a paired device may do what a local client can, except administer the Host (`host/shutdown`,
`host/drain`, `dispatcher/join` and `dispatcher/leave`) and sign agents in and out, which answer
`forbidden`. The Dispatcher is a service (ADR 0027), which may do less (see
[Services](wve-90-remote-clients.md#services)). The Host takes the
Dispatcher's word for a device only on a connection it opened to the Dispatcher it joined, and
only once the Dispatcher has proved its key there, signing a nonce of the Host's (ADR 0030); its
own connection it checks at the Dispatcher's hello. The Dispatcher, not the Host, reaches the
person's other Hosts (ADR 0029).

## Clients

### The TUI

- `app.rs` talks to the Host through `weave-host-client` instead of `AgentConnection`.
  `ChatWidget` stays free of I/O and still renders ACP updates; it also takes the Host's
  turn, pending-request and terminal events.
- Permission and elicitation prompts answer with `pending/answer` and close on
  `pending/resolved`, whoever answered. The TUI no longer cancels pending requests when it
  leaves a thread.
- The TUI lists `clipboard_write` in `capabilities.clientTools`, runs the calls targeted at
  it (pbcopy on a local Mac, OSC 52 otherwise) and answers them; `notice` events show in
  the transcript.
- Queued prompts are the Host's when it lists `queue` (WVE-107): a message the TUI doesn't
  steer during a turn goes to `queue/add`, the queue above the composer is the Host's, every
  client's prompts in it, and Esc takes the TUI's own back into the composer with
  `queue/remove`, leaving the rest paused in the Host. `/queue` resumes a paused queue.
- The TUI remembers its journal position. When the Host goes away, it reconnects (never
  starting a Host), attaches again from that position and gets only what it missed. The
  Host now resumes or loads the thread in its agent itself.
- Leaving a thread, when the TUI quits from a blank one or switches to another, detaches
  with `ifUnused`, so a thread nothing else needs closes at once, as before.
- The default mode, MCP servers and their notices, and extra directories the agent can't
  accept move to the Host. `weave --trace` asks the Host for a trace and shows its path.
- `/thread` opens the thread's status panel (WVE-160): its MCP servers as the Host reports
  them, with a hint to the agent's own `/mcp` when it offers one.
- The thread picker says each thread's branch, and across directories its repository and
  branch in place of its directory. A worktree in a terminal comes from worktrunk
  (`wt switch -c <branch> -x weave`).
- Shell mode (`!`), `@` file search, attachments and pasted images stay local. That is
  right only because the TUI runs on the Host's computer; a TUI elsewhere needs the Host
  methods listed as later work.
- A notice says when a newer version of the thread's agent is out; `/update dismiss` hides
  that version (kept in `$XDG_STATE_HOME/weave/updates.json`). `/update` runs
  `agents/update`, then `thread/reopen`, showing progress in the status line, and the
  `agentReopened` event shows in the transcript, replayed ones too (WVE-93).
- Custom commands (`weave -- <command>`) can't be sent to a Host. Define the agent in the
  config, as `[agents.fake] command = "…/weave-fake-agent"`, and use `--agent fake`. With
  `--no-daemon`, `-- <command>` still works, as a config agent the in-process Host is given
  at startup.

- `/thread`'s panel lists the thread's worktree's terminals too (`terminals/watch`), the
  thread's own first (`openedFrom`), and manages them (WVE-167): in Rex, Enter shows one in a
  pane running `weave terminals attach`, or focuses its pane, `h` hides it there, `n` starts one
  (`terminals/new`) and shows it, `r` renames one and `x` ends one once confirmed; Alt+1 to
  Alt+9 show one without the panel. The first pane goes to the right of the TUI and later ones
  below it, and the TUI keeps which pane shows which terminal, so a `/reload` finds them again.
  Outside Rex, Enter reads a terminal's screen as text (`terminals/format`) and `t` types a line
  into it (`terminals/write`).
- A `closed` event whose `by` is another client quits the TUI: another device closed the thread
  for everyone. In Rex it hides the terminal panes it placed first, and closes its own pane when
  nothing else is in its tab.

### The CLI

- `weave terminals attach <id>` shows a terminal in the terminal it runs in, as the TUI's Rex
  panes do: it opens the stream on `terminals.sock` with `history`, writes the VT restore and
  the output to stdout, with the program's queries, OSC 52, 9 and 777, and kitty graphics left
  out, and the Host's clipboard and notification frames written in their place, and sends its
  input and size. While another device's size holds it draws nothing and says so; typing takes
  the size back, and it asks for a `resync`. It attaches again after a Host restart, and exits
  when the terminal does (ADR 0022, amended).
- With `[rex] open_threads = true`, a Host opens the threads a paired device opens in the Rex
  on its computer (ADR 0025): `weave daemon` watches every thread (`threads/watch`) through a
  client beside it, which doesn't keep an idle Host running, and for a listing whose `openedBy` names a
  `device`, once per `openedAt`, makes a tab running `weave --resume <id>` in the Rex session
  named for its repository, labelled and renamed with the thread's title, never taking focus.
  It keeps which tab shows which thread in `rex-threads.json` beside the journals, so a tab
  still in Rex isn't doubled, and acts only when `rex whoami` names a local socket, never
  starting a Rex server.
- `weave run`, `weave threads` (`cancel`, `close`) and `weave daemon status|stop` use
  `thread/run`, `threads/list`, `turn/cancel`, `thread/close`, `host/status` and
  `host/shutdown`.
- `--host <id or name>` on `weave`, `weave threads` and `weave run` reaches another of the
  person's Hosts through the Dispatcher (WVE-195): the one running on this computer, or the one
  it's paired with. A new thread's directory is this one's counterpart under the home there,
  `~/…`, which the Host expands in `thread/create`, `thread/attach`, `threads/list` and
  `thread/run` and says so when there's no such directory; `--cwd` names one there instead.
  This computer's own Host, by either name, is reached over its socket. The TUI reconnects
  through the Dispatcher and catches up after its position as it does locally, and its status
  line names the Host.
- `weave agents` reads the same configuration and registry through `weave-agents`, as
  `smoke`, `login` and `logout` do, so listing agents doesn't start a Host.
- `weave --resume <id>` and `--continue` choose through `threads/list`. `--continue` keeps
  using the agent last used in the directory (`recent.rs`), a client preference.
- `weave agents smoke`, `login` and `logout` resolve agents with `weave-agents` and talk to them
  directly, as now.
- `weave threads` says a thread's branch. `weave worktrees pre-remove [path]` asks a running
  Host (never starting one) for `worktrees/release`, failing while a thread in the worktree is
  busy, for worktrunk's `pre-remove` hooks; `weave worktrees install-hook` adds it to
  worktrunk's user config when asked.
- `weave hosts add <computer>` has another of the person's Hosts join the Dispatcher over SSH
  (`weave hosts add <url> <code>` there), and `weave hosts add <url> <code>` on the Host's
  computer joins it with a code `weave hosts add --code` showed ([the Dispatcher's
  CLI](wve-175-dispatcher.md#the-cli)). `weave pair` and `weave devices` are the Dispatcher's,
  on its computer: they pair the person's devices with it, list and revoke them (WVE-197).
- With `--json`, what a command reports is the protocol's own types (WVE-108): `daemon status`
  prints `host/status`'s answer, `threads list` its threads, `threads read` `threads/get`'s,
  `threads prompt` `queue/add`'s and `steer` `turn/steer`'s, `devices` the Dispatcher's paired devices, `run
  --detach` `thread/run`'s, and `run` and `threads prompt --wait` their thread's
  `thread/event` notifications as JSON lines.
- With no terminal, as over SSH, nothing prompts: `weave agents login` needs `--method`, and a sign-in
  that runs in a terminal says to use `ssh -t`. `weave daemon install` and `status` say how to
  have a command over SSH find `weave` when the login shell, run as sshd runs one, doesn't.
- `weave threads watch` prints `threads/watch` as JSON lines, each `{method, params}`: a
  `threads/updated` for each thread at first, then each notification. `weave threads follow
  <id> [--after <seq>] [--until-turn-ends] [--json]` observes an open thread (`observe`),
  printing its events after `seq`, or from now, as `weave run` prints its own; with
  `--until-turn-ends` it exits when the next turn to start ends, or without `--after` the one
  running, with that turn's exit status. `--turn <id>` follows that turn from its start to its
  end, at once for one that has ended. `weave threads prompt --wait` prompts and follows the
  turn so; `threads read --turn <id>` reads it; `threads list --activity <activity>` lists the
  open threads doing that.
- Waiting for a turn (`follow --until-turn-ends` or `--turn`, `prompt --wait`, `run`) stops when
  it waits on a person, exiting 7 with the thread left open for someone to answer, unless
  `--keep-waiting`; and at `--timeout <duration>`, exiting 8, with the turn going on. Either way
  it says how to follow the turn again. `--key` on `threads prompt` and `run` is the request
  key, so a script retrying after a dropped connection starts nothing twice and follows the
  same turn; a `run` repeated once its thread has closed exits as its turn went. A Host that
  goes away while it waits is waited for, up to a minute, and a turn it cut off that the
  thread continues is followed into its continuation (see [Successors](#successors)).
  `weave threads set-successor <id> <successor>` names a thread's successor.
- `weave threads label <id> [--add <label>]… [--remove <label>]…` labels an open thread and
  prints its labels; `weave threads list --label <label>` lists the open threads that carry it,
  each given label; `weave run --label <label>` starts a labelled thread.
- The exit status says how a command went, for scripts (WVE-108): 0, it worked, or the turn ended
  (`end_turn`); 1, any other error; 2, bad arguments; 3, the Host couldn't be reached (not
  running, for a command that never starts one; didn't start; or went away); 4, the turn failed
  or its thread closed under it; 5, the turn was cancelled; 6, it stopped short otherwise; 7,
  the turn waits on a person; 8, waiting timed out. `weave daemon status` exits 3 when the Host
  isn't running. The turn's outcome is in the status deliberately, unlike the A2A CLI, which
  keeps outcomes out of its exit codes: scripts composing threads branch on it.

## Crates

The crates as WVE-85 changed them, under the `crates/` directory they were in then; they
are at the repository root now, and `crates/daemon` is `host/`.

| Crate | Change |
| --- | --- |
| `crates/protocol` (new, `weave-host-protocol`) | The wire types, method and notification names, error codes and version constants, with golden fixtures. Depends on the ACP schema crate for payloads. No I/O. Replaces `acp-core/src/daemon_protocol.rs`. |
| `crates/agents` (new, `weave-agents`) | Agent resolution: presets, the Host's config sections, the registry catalog and installs, environment capture. Moves `cli/src/registry.rs` and the agent and MCP parts of `cli/src/config.rs`. |
| `crates/daemon` | Becomes the Host's server: `client.rs` is rewritten for the new protocol; the thread task (`session.rs`) keeps its shape; journals get ids and positions; spare agent processes move from connections to the Host. |
| `crates/host-client` (new, `weave-host-client`) | The client side: connecting, `host/hello`, typed requests, per-thread event streams with positions, reconnecting. Used by the TUI and the CLI. |
| `crates/acp-core` | Back to the agent side of ACP only: `daemon_protocol.rs`, the `_weave/*` handlers and `AgentEvent::{TurnRunning, SessionEnded}` go. |
| `crates/tui`, `crates/cli` | Move to `weave-host-client`, as above. |

The server and client may reuse the ACP SDK's JSON-RPC layer, which already carries
`_weave/*` methods, if it carries these methods cleanly; otherwise they use a small codec
of their own. Either way, the [SDK rules](../../AGENTS.md#sdk-rules) about handlers still
apply.

## Cutover

- The new Host answers a legacy ACP `initialize` with `_meta.weave.protocol`, its major
  version, and nothing else. A TUI built before this change sees the version mismatch and `/reload`s
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
- one connection creates, attaches to and prompts threads of two different agents;
- a turn started by one client ends in `turnEnded` for both;
- `host/hello` picks the highest common version and fails without overlap; every other
  method fails before hello;
- `local` authentication: the peer check runs for every socket connection; testing a peer
  with another user id needs a second account, so it's checked by hand;
- agents run from the config, in the thread's directory, with the layered environment;
  environment capture falls back when the shell times out;
- a suspended thread resumes when attached, with its interrupted turn ended as `interrupted`;
  one nobody takes up within the idle grace closes, keeping its journal's age, and opens again
  in a new journal (WVE-120);
- `repos/init` (WVE-178, `host/tests/daemon.rs`, git away from the configuration of whoever runs
  the tests): a directory made a repository with its files committed alone, and with none named
  only made one; the top of a repository kept, what was staged or untracked there staying so; a
  directory inside another repository refused, one that isn't there not made; a file there
  already writing none; paths outside the directory, a relative directory and files without a
  message refused, making nothing; `~` as the Host's home; without a name and email for git,
  the files written but not committed;
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

- Host methods for clients on other computers: `files/search` for `@` mentions and
  `files/read` for attachments (see [Files](#files)), and shell commands.
- `--continue` choosing the latest thread in the directory across agents, since the Host
  now knows them.
- Disconnecting local clients that fall behind, as WebSocket clients are.
