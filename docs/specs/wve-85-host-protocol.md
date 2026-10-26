# WVE-85: The weave Host protocol

Status: Proposed, 2026-10-11

Issue: [WVE-85: Make the weave daemon the Host, with its own client protocol](https://linear.app/jacobfvanzyl/issue/WVE-85/make-the-weave-daemon-the-host-with-its-own-client-protocol)

Decision: [ADR 0008](../adr/0008-weave-daemon-is-the-host.md). Glossary: [`CONTEXT.md`](../../CONTEXT.md).

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
types are the payload of this protocol. Portal, `product/protocol` and ADR 0001 were
reference material only (ADR 0008); nothing here depends on them, and they were retired
in ADR 0014.

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
  shell commands (listing a directory came with WVE-112; see [Files](#files));
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
| WebSocket, on loopback behind Tailscale Serve | One message per text frame | `device`, or `pair` once |

The socket and its directory stay where they are (`DaemonPaths`): mode 0600, in a 0700
directory, with one Host per directory guarded by `daemon.lock`. The WebSocket is for remote
clients on the person's other devices and has a spec of its own,
[`wve-90-remote-clients.md`](wve-90-remote-clients.md) (ADR 0010).

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
  "features": ["turn/steer"],
  "acp": {"protocolVersion": 1, "unstable": ["session_compaction", "subagents"]}
}}
```

- `protocol` is the range of major versions the client speaks. The Host answers with the
  highest version both support, or fails with `incompatible_protocol`, whose `data` gives
  the Host's own range. See [Versioning](#versioning).
- `auth` is checked against the transport. `local` succeeds only on the Unix socket or
  in-process, and only when the socket's peer has the Host's own user id (`getpeereid`,
  checked when it connects), on top of the socket's file mode. On the WebSocket, `device`
  (after `host/challenge`) and `pair` prove a paired device, as WVE-90 specifies; the
  answer then names it in `device`. `token` stays reserved and refused everywhere. A client
  that hasn't said a successful hello gets `unauthenticated` for everything else.
- `capabilities.terminalSignIn` says the client can run an agent's sign-in command in a
  terminal on the Host's computer. Only `local` clients may claim it.
- `capabilities.clientTools` lists the client tools the client runs on its device, such as
  `clipboard_write` (see [Client tools](#client-tools)).
- `clientId` names this connection in other messages (who answered a pending request,
  who started a turn). It means nothing after the connection ends.
- `host.id` is the Host's own id, the same across restarts, so clients tell Hosts apart.
- `features` lists optional parts of the protocol this Host supports. Version 2 defines
  `turn/steer` ([WVE-86](https://linear.app/jacobfvanzyl/issue/WVE-86/steer-a-running-turn-from-the-tui-through-the-weave-host)),
  which brings the `turnSteered` event with it, `devices` (WVE-90), the `devices/*`
  methods, and `agents/updates` (WVE-93): `agents/updateAvailable`, `SessionState.update`,
  `agents/update`, `session/reopen` and the `agentReopened` event (see
  [Updates](#updates)), `clientTools` (WVE-89): `capabilities.clientTools`, the
  `clientTool` pending request and its answer (see [Client tools](#client-tools)), and
  `sessions/watch` (WVE-104): `sessions/watch`, `sessions/unwatch`, `sessions/updated` and
  `sessions/removed`, `files/list` (WVE-112; see [Files](#files)), and `session/rename`
  (WVE-114): `session/rename`, the `renamed` event and the `rename_session` Host tool (see
  [Host tools](#host-tools)), `queue` (WVE-107): `queue/add`, `queue/remove`,
  `queue/resume`, `SessionState.queue` and `queuePaused`, `turnStarted`'s `queuedId`, and the
  `queued`, `unqueued`, `queuePaused` and `queueResumed` events (see [Queue](#queue)), and
  `requestKeys` (WVE-107): the `key` that `session/run`, `turn/start` and `queue/add` take
  (see [Request keys](#request-keys)), and `sessions/get` (WVE-106): `sessions/get`, with
  delegated sessions' `startedBy` and the `session` turn origin (see
  [Delegated sessions](#delegated-sessions)).
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
| `default_agent`, `[agents.*]`, `[[mcp_servers]]`, `client_tools`, `host_tools`, `[delegation]` | the Host |
| `[tui]`, `[daemon]` | clients on the same computer |

The Host reads its sections whenever it resolves an agent, so edits apply to the next
session without a restart. `weave daemon run --config <file>` points the Host at another
file. A client's `--config` selects the file for its own sections; with `--no-daemon` the
in-process Host uses the same file. When a client runs on another computer, the Host
sections of that computer's file do nothing.

MCP servers come from the config only. When a session opens, the Host passes the ones the
agent's `mcpCapabilities` accept and reports the others in the session's `notices`. Every
session also gets the Host MCP server, `weave` (see [Client tools](#client-tools)).

### Environment

Agents start in the session's directory (as `instance.rs` does now, with `PWD` set) with an
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

**`agents/update`** `{agentId}` → `{version}`

Feature `agents/updates`. What `weave update <agent>` does (WVE-92), through the same code:
for a preset, npm's `latest` for its package, written to `agents.lock` beside the config;
for a registry agent, a refreshed ACP registry catalog. Only once the new version starts and
answers `initialize`, launched as the Host launches agents; one that doesn't fails the
request and changes nothing. `version` is what the agent's new sessions launch now: the
newest, or the one already there. The Host's spare processes of the agent stop, and its open
sessions of an older version are told (`agents/updateAvailable`); they keep their process
until `session/reopen` moves them. Agents the configuration gives a command fail with
invalid params: updating them is the user's to do. Local clients only; remote clients get
`forbidden`.

When any request needs an agent that requires sign-in, it fails with ACP's
`auth_required` error (code -32000), passed through from the agent, and the client
signs in and retries.

### Updates

When a session opens for a preset or registry agent (`session/create`, or `session/attach`
whether it was open or not), the Host looks for a newer version in the background: npm's
`latest` for the preset's package, the ACP registry's catalog for a registry agent. The
session never waits for it. A lookup serves every session for an hour, so sessions opened
together make one request; one that failed serves the hour too, and shows nothing. When the
newest version is newer than the one a session runs, its attached clients get

- `agents/updateAvailable` `{sessionId, agentId, name, running, latest}`, once a version, and
- `SessionState.update` `{agentId, name, running, latest}` carries it to clients that attach
  later.

`name` is what's updated, as people know it: the preset's package or the registry agent's
name. `SessionState.agent.release` `{name, version}` is the version the session's process
runs. Configured agents have neither and aren't looked up.

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
| suspended | It was open when its Host stopped. Its journal is still open. | open when a client attaches or runs a turn in it; closed, its journal ending closed, when nothing takes it up within the idle grace of the next Host starting |
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
  turns: { sessionId: string; startedAt: number; origin: TurnOrigin }[];
  queue?: QueuedPrompt[];                      // prompts waiting for the next turns; see Queue
  queuePaused?: "cancelled" | "failed" | "interrupted";   // why the queue waits
  pending: PendingRequest[];
  subagents: string[];                         // subagent session ids so far
  journal: { id: string; head: number };       // the position of the last event written
  notices: string[];                           // e.g. skipped MCP servers
  trace?: string;                              // where the Host writes this session's trace
  update?: { agentId: string; name: string; running: string; latest: string };  // see Updates
  startedBy?: string;                          // the session whose agent started it; see Delegated sessions
};
```

### Methods

**`sessions/list`** `{agentId?, cwd?, repo?, cursor?}` → `{sessions: SessionListing[], nextCursor?}`

- Without `agentId`: the sessions the Host has a journal for, across agents (open,
  suspended and closed), most recently active first. No agent is started. Paging isn't
  needed. With `repo` (feature `worktrees`), any directory in a git repository, only the
  sessions in that repository's worktrees, by the repository each session's `git` names. A
  `repo` outside a repository fails with `not_a_repository`.
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
  git?: GitLocation;            // as the Host last read it while the session was open
  startedBy?: string;           // the session whose agent started it; see Delegated sessions
};
```

`repo` with `agentId` fails with invalid params: an agent's own listing goes by directory.

**`sessions/get`** `{sessionId}` → `{session: SessionListing, latestTurn?: LatestTurn}`

Feature `sessions/get`. One session the Host has a journal for, open or not, as `sessions/list`
lists it, with its latest turn, read from its journal without opening it or attaching. Remote
clients may use it. A session the Host has no record of, or a blank one, fails with
`unknown_session`.

```ts
type LatestTurn = {
  prompt: ContentBlock[];
  origin: TurnOrigin;
  startedAt: number;
  running: boolean;
  response?: PromptResponse;   // how it ended, once it has
  error?: Error;               // why it failed
  message?: string;            // the agent's last message in it, as text
};
```

`message` is the text of the agent's last message in the turn: its message chunks since the
last tool call, thought or other message.

**`sessions/watch`** `{}` → `{sessions: SessionListing[]}`

Feature `sessions/watch`. Answers with the listing `sessions/list` gives without an agent,
then sends the client a notification for every change to the Host's sessions, whether it's
attached to them or not, until the connection ends or it sends `sessions/unwatch` `{}` →
`{}`. Watching again starts over, with the listing as it is then. Remote clients may watch.

- `sessions/updated` `{session: SessionListing}`: a session appeared or changed, as it lists
  now. It's sent when a session opens (a blank one at its first prompt), when its
  `activity`, `clients` or title change, and when it's suspended or closed; no more often than
  `session/changed`, from the same changes, its branch included. A closed or suspended session lists with no
  `activity` and no clients.
- `sessions/removed` `{sessionId}`: a session went away: deleted, its journal pruned, or closed
  while blank.

Blank sessions never appear. Nothing reaches a watching client between the answer and the
notifications after it, so it misses no change and hears none older than its listing.

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

**`session/reopen`** `{sessionId}` → `{version?}`

Feature `agents/updates`. Moves an open session to the version its agent's new sessions
launch, as after `agents/update`. The Host starts that version; one that doesn't start fails
the request with the session as it was. Then it closes the session in the old process (ACP
`session/close`, when supported), stops it, and takes the session up in the new one with
ACP `session/resume`, or `session/load` with the agent's replay discarded, as after a Host
restart. The session keeps its id and journal, where an `agentReopened` event marks the
change for every client; its mode and config options are whatever the new process restores.
Anything that lived only in the old process ends with it, such as its background commands
and running subagents. While a turn runs or a request waits, the reopen waits for them, and
the answer with it.

When the new version can't take the session up, the old one does again, and `agentReopened`
says why in `failed`. When that fails too, the session closes. An agent that can't resume or
load sessions fails the request with method not found, and its process stays; new sessions
get the new version. So does a blank session (one nobody has prompted), with invalid request:
an agent may keep nothing of a session before its first prompt (claude-agent-acp can't resume
one), so a new session takes its place. `version` is what the session runs now.

**`session/delete`** `{sessionId, agentId?}` → `{}`

Closes the session if it's open, deletes it in the agent (ACP `session/delete`) when the agent
can, and removes its journal. The agent runs in the session's directory to do so; when that's
gone, as a removed worktree, it isn't asked. An agent that isn't asked, or can't delete
sessions, keeps its own history of it. `agentId` is required when the Host has no record of
the session.

**`session/setMode`** `{sessionId, modeId}` → `{}`

**`session/setConfigOption`** `{sessionId, configId, value}` → `SetSessionConfigOptionResponse`

Passed to the agent. The change reaches every attached client, the sender included, as an
ACP `current_mode_update` or `config_option_update` in the journal.

**`session/rename`** `{sessionId, title}` → `{}`

Feature `session/rename`. Gives an open session a title of the Host's. The title is trimmed and
must be 1 to 200 characters; the session must be open (`session_not_open`).

- **Journaled.** The rename is journaled as a `renamed` event, so every client sees it, live
  and replayed. `session/changed`, `sessions/updated` and listings carry the title, and listings
  prefer it to the agent's.
- **It holds.** From then on, titles in the agent's `session_info_update`s are left out of the
  journal and of the session's title. Otherwise a title an agent generates after its first turn
  would undo a rename made during that turn. Only another rename replaces it.
- **It outlives the journal.** A suspended session's journal carries the title on; a closed
  session's new journal begins with it.
- **The agent's own title doesn't change.** ACP has no way to change it from outside, so the
  agent's own listing and tools still show its title.

The `rename_session` Host tool does the same for the calling session (see
[Host tools](#host-tools)).

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
| `turnStarted` | `sessionId`, `prompt`: ACP `ContentBlock[]`, `origin`, `queuedId?` | a turn starts; `queuedId` names the queued prompt it started from |
| `turnSteered` | `sessionId`, `prompt`: ACP `ContentBlock[]`, `origin` | a steer joins the running turn (`turn/steer`) |
| `turnEnded` | `sessionId`, `response?`: ACP `PromptResponse`, `error?`: JSON-RPC error | a turn ends |
| `terminalOutput` | `terminalId`, `data` | a command the Host runs for the agent writes output |
| `terminalExit` | `terminalId`, `status`: ACP `TerminalExitStatus` | that command exits |
| `agentReopened` | `agent`: `SessionState.agent`, `previous?`: `{name, version}`, `modes?`, `configOptions`, `failed?` | the session's agent was started again (`session/reopen`); `failed` says why it runs `previous` again |
| `closed` | `reason` | the session closes |
| `notice` | `text` | the Host tells the session's clients something, such as that its agent can't use client tools |
| `renamed` | `title`, `by?`: `origin` | the session was renamed through the Host (`session/rename`); `by` is the renaming client's origin, absent when the session's own agent renamed it (the `rename_session` Host tool) |
| `queued` | `queuedId`, `prompt`: ACP `ContentBlock[]`, `origin` | a prompt joined the queue (`queue/add`) |
| `unqueued` | `queuedId`, `by?`: `origin` | a client took a prompt out of the queue (`queue/remove`) |
| `queuePaused` | `reason`: `"cancelled" \| "failed" \| "interrupted"` | the queue stopped starting turns (see [Queue](#queue)) |
| `queueResumed` | `by?`: `origin` | the queue started again; `by` is the client that resumed it |

`origin` is `{"client": {"name": "weave-tui", "id": "c7"}}` for a client's prompt, with the
connection's `clientId` so a client recognizes its own (a remote client's adds its paired
device's name as `device`), `{"run": {}}` for a headless run, or
`{"session": {"sessionId": "s-2"}}` for a prompt from another session: a delegated session's
turn its starting session's agent began, or the Host's message about a delegated session to the
session that started it (see [Delegated sessions](#delegated-sessions)). Prompts are journaled in `turnStarted`, not as made-up `user_message_chunk`
updates. Terminal output an agent reports in `_meta` (`terminal_output_delta`) becomes
`terminalOutput` and `terminalExit` events and is stripped from the update, so each chunk
arrives once.

Clients must ignore event kinds they don't know, while still advancing their position.

### Other notifications

These aren't journaled. They go to the session's attached clients.

- `session/changed` `{sessionId, activity?, clients?, title?, blank?, git?}`: fields of
  `SessionState` that changed. `git` changes when a turn ends in a worktree whose branch
  changed meanwhile.
- `pending/added` `{sessionId, pending: PendingRequest}`
- `pending/resolved` `{sessionId, pendingId, outcome: "answered" | "cancelled" | "withdrawn", by?: clientId}`
- `session/elicitationCompleted` `{sessionId, notification: CompleteElicitationNotification}`:
  an accepted URL elicitation's external step finished.
- `agents/updateAvailable` `{sessionId, agentId, name, running, latest}`: a newer version of
  the session's agent is out (see [Updates](#updates)).

### Slow clients

A local client that falls behind is buffered for: the ACP SDK's channels are unbounded. A
WebSocket client whose unsent messages pass 8 MiB is closed instead, and reconnects and
catches up from its position (WVE-90).

## Turns

**`turn/start`** `{sessionId, prompt: ContentBlock[], key?}` → `{seq}`

Sends the prompt to the agent and answers once the turn has started, with the position of
its `turnStarted` event. The session must be open, but the client needn't be attached.
`sessionId` may be a subagent session's. The turn's end reaches attached clients as
`turnEnded`, whoever started it. Fails with `session_not_open` or `turn_running`. A Host
with the `queue` feature offers `queue/add` too, which starts a turn or queues the prompt
behind the running one (see [Queue](#queue)).

**`turn/steer`** `{sessionId, prompt: ContentBlock[]}` →
`{outcome: "steered", seq} | {outcome: "notRunning"}`

Feature `turn/steer`. Sends a steer: a message for the session's running turn, which joins
it instead of starting another. The agent must take steering: claude-agent-acp and codex-acp
advertise `_meta.steering.supported` in their `initialize` response, which clients read from
`SessionState.agent`, and take `_session/steering`, an extension of theirs rather than an
ACP RFD. With an agent that doesn't, a steer for a running turn fails with method not
found.

- `steered`: the agent took it. It's journaled as `turnSteered` at `seq`, after the updates
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

**`turn/cancel`** `{sessionId}` → `{}`

Cancels the session's running turn (ACP `session/cancel`) and cancels its pending
requests.

**`session/run`** `{agentId, cwd, sessionId?, additionalDirectories?, prompt, policy, attach?, trace?, key?}` →
`{sessionId, state?: SessionState}`

Opens a session (`sessionId`, as attaching would, or a new one) and starts a turn in it
without the client having to stay. An open session keeps its own policy. With `attach`, the
client is attached before the prompt is sent, so it sees the whole turn, and `state` is
returned. Nobody can sign in at a terminal for a headless session, so the Host doesn't
offer agents terminal sign-in for one.

### Queue

Feature `queue`. Each open session has a queue: prompts waiting, in order, to start its next
turns. The Host holds it rather than a client, so every attached client sees the same queue,
it outlives the client that added to it, and whatever has no client, such as a trigger or
another session's agent, can queue too.

```ts
type QueuedPrompt = {
  id: string;           // the queuedId, unique in the session
  prompt: ContentBlock[];
  origin: TurnOrigin;   // who added it, which its turn's origin will be
  queuedAt: number;
};
```

- **Running.** Whenever no turn of the session's own runs, its queue isn't paused and no
  `session/reopen` waits, the Host starts the first queued prompt as the next turn, with that
  prompt's origin. Its `turnStarted` names it in `queuedId`, which is how clients know it left
  the queue. Only a session has a queue; its subagent sessions don't.
- **Pausing.** When the session's turn is cancelled (`stopReason: "cancelled"`) or fails while
  prompts wait, the queue pauses rather than start the next one, journaled as `queuePaused`:
  whoever stopped the turn decides what follows. So does an interactive session's queue when
  the Host takes the session up again with prompts waiting, after the Host stopped or the
  session closed (`interrupted`); a headless session's carries on. A paused queue resumes,
  journaled as `queueResumed`, with `queue/resume`, or when a client prompts the session with
  `queue/add`, `turn/start` or `session/run`. A paused queue that empties isn't paused any
  more, and clients stop showing it as paused.
- **Journaled.** The queue is in the journal (`queued`, `unqueued`, `queuePaused`,
  `queueResumed` and `turnStarted`'s `queuedId`), so it survives a Host restart and replays
  to clients that attach later, and `SessionState` carries it as `queue` and `queuePaused`. A
  closed session's queue carries on into the journal it gets when it opens again, as a renamed
  title does. A paused queue doesn't keep its session open: the session closes after the idle
  grace like any other.
- **At startup** the Host takes up the suspended headless sessions whose queue holds prompts
  and isn't paused, so their queue runs with nobody attached.

**`queue/add`** `{sessionId, prompt: ContentBlock[], key?}` → `{queuedId, seq, started}`

Adds a prompt to the end of the session's queue, with the client's origin. Any client may add
to an open session's queue, attached or not (`session_not_open` otherwise). `sessionId` must be
the session's own, not a subagent session's (invalid params). When no turn runs and nothing
waits, the prompt starts a turn at once: `started` is true and `seq` is the position of its
`turnStarted`. Otherwise `seq` is the position of its `queued` event. Adding to a paused queue
resumes it. So sending is one request whatever the session is doing.

**`queue/remove`** `{sessionId, queuedId}` → `{removed?: QueuedPrompt}`

Takes a prompt out of the queue, whoever added it, journaled as `unqueued`, and answers with it.
`removed` is absent when the prompt had already left the queue, started or removed, so a
client taking a prompt back to edit it never has it both running and in its composer. Queued
prompts aren't edited in place: remove one and add it again.

**`queue/resume`** `{sessionId}` → `{}`

Resumes a paused queue, starting its first prompt if no turn runs. A queue that isn't paused
stays as it is.

Steering is unchanged: `turn/steer` joins a running turn, and a `notRunning` answer has the
client send its message with `queue/add` instead, which starts it, or queues it behind a turn
that started meanwhile.

### Request keys

Feature `requestKeys`. `session/run`, `turn/start` and `queue/add` take an optional `key`, 1 to
200 characters the caller chooses, such as a UUID, so a caller that retries after a dropped
connection never starts the same work twice.

- The Host records a key on disk before acting on its request. A repeat, the same method with
  the same key, answers as the first did and starts nothing, across Host restarts too. One that
  arrives while the first is still being answered waits for it.
- A key belongs to one request: a repeat whose method or params differ fails with
  `key_reused`.
- Only work that happened uses a key up. A request that fails, with `turn_running` say, can be
  sent again with the same key.
- A repeated `session/run` answers with the session's id alone, without `state`; a client that
  asked to attach attaches with `session/attach`.
- The Host journals each key with the turn or queued prompt it started. If the Host stopped
  between recording a key and answering, a repeat looks there to learn whether the work
  happened, and does it only if it didn't.
- Keys are kept as long as journals are: they're forgotten 14 days after they were recorded.

Triggers (WVE-98) are to admit each occurrence through the same record, under a key of its
own.

## Pending requests

```ts
type PendingRequest = {
  id: string;
  sessionId?: string;           // the session it's for, the root or a subagent session, when it's for one
  createdAt: number;
} & (
  | { kind: "permission"; request: RequestPermissionRequest }
  | { kind: "elicitation"; request: CreateElicitationRequest }
  | { kind: "clientTool"; tool: string; arguments: object; target: string } // a clientId
);
```

A session's permission policy answers the permission requests it can, and a policy that
rejects what it doesn't approve dismisses elicitations. Every other permission request or
elicitation becomes a pending request: in `SessionState.pending` for clients that attach
later, and announced with `pending/added` to clients attached now.

**`pending/answer`** `{sessionId, pendingId, permission?: RequestPermissionResponse, elicitation?: CreateElicitationResponse, clientTool?: CallToolResult}` →
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
session's agent gets whoever is attached. The tools are of two kinds, both defined by the Host
(`protocol/`, `tools`):

- **Client tools** run on a client's device.
- **Host tools** are answered by the Host itself.

The config chooses which an agent is offered. `client_tools` and `host_tools` each mean all
when absent and none when `[]`, and an agent's own setting overrides the top-level one. The
server speaks MCP 2026-07-28 only. Agents that advertise
`mcpCapabilities.acp` get it over ACP (`"type": "acp"`, from the draft MCP-over-ACP RFD);
the rest get a stdio server, `weave mcp-bridge`, which relays MCP between the agent and the
Host's MCP socket beside its own, after a token naming the session's declaration. Each
session setup declares the server under a new `serverId` or token. An agent that opens it
with `initialize`, from an MCP revision before 2026-07-28, is refused, and the session's
clients get a `notice` event saying it can't use weave's tools.

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

## Host tools

Host tools are answered by the Host, for the session whose agent calls them. Each is a Host
protocol method seen from inside the session, with the same parameters less what the calling
session supplies, and is answered by the same code as the client request
([ADR 0020](../adr/0020-agents-reach-the-host-as-clients-do-and-act-only-on-threads-they-start.md)).
No Host tool does what no client request can, so a new capability lands in the protocol first.
They need no client, so they work in headless sessions too. A tool's answer is its method's
answer as JSON text, or a tool error saying why the method failed.

- `rename_session {title}`: `session/rename` for the calling session. The `renamed` event it
  journals has no `by`. A title that `session/rename` would refuse comes back as a tool error
  saying why.
- `list_sessions {agentId?, cwd?, repo?}`: `sessions/list`.
- `read_session {sessionId}`: `sessions/get`.
- `start_session {agentId, prompt, cwd?, sessionId?, approve?, otherwise?, key?}`: `session/run`,
  starting a delegated session, or prompting one this session started when `sessionId` names
  it. `prompt` is text; `cwd` defaults to the calling session's directory; `approve` and
  `otherwise` are the policy asked for, within the ceiling.
- `prompt_session {sessionId, prompt, key?}`: `queue/add` for a session this session started.
- `steer_session {sessionId, prompt}`: `turn/steer` for a session this session started.
- `cancel_session_turn {sessionId}`: `turn/cancel` for a session this session started.

### Delegated sessions

A session an agent starts with `start_session` is a delegated session (ADR 0020): a session of
its own, with its own journal and agent process, which clients list and attach to as any other.
It isn't a subagent session.

- **Who started it.** Its journal's header records the session that started it, which listings,
  `sessions/get` and `SessionState` give as `startedBy`. Turns that session's agent starts in it
  have the origin `{"session": {"sessionId": <the starting session>}}`.
- **Reach.** An agent reads any session on its Host (`list_sessions`, `read_session`), but
  starts, prompts, steers and cancels only the sessions it started, and theirs. Others fail as a
  tool error saying so.
- **The policy ceiling.** A delegated session approves only tool kinds the starting session's
  policy approves too, and rejects what isn't approved if either policy rejects it. The Host
  narrows a request for more, and the tool's answer says what policy the session got. A session
  started without `approve` or `otherwise` gets the starting session's policy. An open delegated
  session keeps its policy when prompted again, as `session/run` keeps an open session's.
- **Pending requests stay with people.** A delegated session's permission requests and
  elicitations are pending requests like any other, which its attached clients answer, or its
  policy. When one appears during a turn the starting session's agent began, the Host tells the
  starting session, which can tell the person; the calling agent can't answer it.
- **Following.** When a turn the starting session's agent began ends, the Host tells the starting
  session: how it ended and the start of the agent's last message, as a message with the origin
  `{"session": {"sessionId": <the delegated session>}}`. It steers the message into the starting
  session's running turn, or else adds it to that session's queue, which starts a turn if none
  runs. A starting session that isn't open is taken up again for it, under its own policy, as
  `session/run` takes a session up. Only turns whose origin names a session that started this
  one, or started the one that did, are followed: the turn such a message starts in the starting
  session tells the delegated session nothing back. A starting session that can't be taken up, such as one
  deleted, isn't told, and the delegated session's journal says so in a `notice`.
- **Limits.** A session may start sessions only `depth` levels below a session a person started
  (1 by default: a delegated session can't start one), and may have at most `running`
  delegated sessions running a turn or waiting on a request at once (3 by default), from the
  configuration's `[delegation]`. A tool call past either fails as a tool error saying so.

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

Feature `files/list`. What a directory holds, so a client can pick where a session runs. Without
`path`, it lists the Host user's home directory. The answer gives:

- the directory listed, without `.` or `..` but with symlinks as named, so a session's directory
  reads as the person chose it;
- its parent, absent at the root;
- `home`, so clients can show paths under it as `~`.

`kind` is `directory`, `file` or `other`, following symlinks. Directories come first, then by
name. Names starting with a dot are left out unless `hidden`, and names that aren't UTF-8 always
are. At most 2,000 entries are given; `truncated` says there were more. A relative path, a
missing one or one that isn't a directory fails with invalid params, whose `data` says which.

Later methods join the family:

- `files/search` serves `@` mentions: the session directory's files, matched as the TUI's
  picker does (`tui/src/file_popup.rs`, `.gitignore` honored).
- `files/read` serves attachments: a file as the content block the TUI's `@` mentions attach
  (`tui/src/attachments.rs`).

Shell commands, the other method remote clients need, would be a family of their own, since they
run things rather than read them.

## Worktrees

The Host is git-aware (ADR 0019): it knows where in a git repository each session's directory
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

When a session opens (created, run, or taken up again) the Host reads its location while it
starts the agent, and records it in the header of any journal it begins, so listings of sessions
that aren't open give it. After each of the session's own turns it reads it again,
and an attached client hears of a change in `session/changed`, a watcher in
`sessions/updated`. A session outside a repository, and one from a journal from before, has
no `git`. Paths in repositories are given and compared with symlinks resolved.

Worktrees are the person's, beside sessions rather than parts of them, so clients manage the
two together or apart: make a worktree, then `session/create` in it; or remove a worktree with
its sessions. New worktrees go where worktrunk puts them by default, beside the repository as
`<repo>.<branch>` with `/` and `\` in the branch made `-`, so worktrunk in a terminal manages
the same ones. The Host never removes a worktree on its own: pruning a journal leaves its
worktree alone. These methods are feature `worktrees`; remote clients may use them.

**`worktrees/list`** `{repo}` →
`{repo, remote?, defaultBranch?, worktrees: {path, branch?, head?, primary?, changes?, divergence?: {ahead, behind}, upstream?: {name, ahead, behind}, sessions: sessionId[]}[]}`

The repository `repo` is in (any directory in it), by its primary worktree, and its worktrees,
the primary one first, then by path; worktrees whose directory is gone are left out.
`defaultBranch` is the remote's default branch (`refs/remotes/<remote>/HEAD`), else `main` or
`master`. For each worktree: `changes` counts staged, unstaged and untracked files, not ignored
ones; `divergence` is how far its HEAD is from the default branch; `upstream` is the branch it
tracks; `sessions` are the sessions the Host has a record of in it (in its directory or below,
the deepest worktree winning), open or not, blank ones aside, most recently active first.

**`worktrees/create`** `{repo, branch, base?}` → `{path, branch, createdBranch?}`

A worktree for `branch`, beside the repository. A branch that doesn't exist is made from
`base` (a branch, tag or commit; by default the default branch, else the primary worktree's
HEAD) and `createdBranch` says so. One that exists locally, or only on a remote (which git then
tracks), is checked out, and refuses a `base`. Invalid params when `branch` isn't a branch
name (`git check-ref-format --branch`), another worktree has it checked out, or the directory
exists; `git_failed` with git's own words when it refuses.

**`worktrees/remove`** `{path, force?, deleteBranch?}` → `{closed: sessionId[], branch?, branchDeleted?}`

Removes a worktree other than the primary one, which must be its top directory:

1. Refused with `worktree_busy` while a session in it runs a turn or waits on a request; `data.sessions` says which.
2. Refused with `uncommitted_changes` when it has changes, unless `force`, which loses them.
3. The sessions open in it close (`closed`); their journals stay, so they list as closed and
   can still be deleted, as sessions whose directory is gone (WVE-120).
4. `git worktree remove`; then its branch goes when git counts it merged (`git branch -d`),
   or regardless with `deleteBranch`.

**`worktrees/release`** `{path}` → `{closed: sessionId[]}`

What `worktrees/remove` does before git removes the worktree, for removals the Host doesn't
make: refused with `worktree_busy` while a session in the worktree runs a turn or waits on a
request; otherwise its open sessions close. `weave worktrees pre-remove` asks it as a worktrunk
`pre-remove` hook, so `wt remove`, `wt merge` and `wt step prune` stop while a session needs the
worktree.

## Terminals

Status: Proposed, 2026-10-25 ([WVE-148](https://linear.app/jacobfvanzyl/issue/WVE-148), ADR
0022). Not built yet. On 2026-10-26 two spikes checked it: a holder in Rust (WVE-149), and the
app's native renderer on the iPad (WVE-150).

A terminal is a shell on the Host's computer that clients show beside a thread. It belongs to a
worktree, or to a directory outside a repository. It lives in a holder, a process of its own
that outlives the Host. Where it shows is each client's choice, so nothing here describes panes
or layout.

The concepts and names follow Rex's block model, in this protocol's casing. Its terminal methods
`format`, `write` and `resize`, its properties `pwd`, `title`, `process`, `size` and
`program_status`, and its terminal events all have counterparts here, so a Rex block can later
stand in for a holder.

These methods are feature `terminals`. Remote clients may use them, since a client that can
start an agent in a directory can already run anything there.

```ts
type Terminal = {
  id: string;            // permanent and opaque: a holder's, or later a Rex block's
  scope: string;         // the worktree it belongs to, or its directory outside a repository
  label?: string;        // the person's name for it
  openedFrom?: string;   // the session it was opened from, which shows it by default
  title?: string;        // OSC 0 and 2
  pwd?: string;          // the directory the shell reports (OSC 7), as a path: the Host drops the URL's scheme and host
  process?: {foreground: {pid: number; name: string}};
  size: {cols: number; rows: number};
  command?: {running: boolean; exitCode?: number};  // OSC 133: one running, or how the last ended
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

**`terminals/attach`** `{id}` → `{ticket, url}`

A ticket for the terminal's stream: one use, within 30 seconds, by the device that asked.

### The terminal stream

Each attached terminal streams over a WebSocket of its own, beside the client's connection, on
the Host's remote listener. It uses subprotocol `weave-terminal` and the same `Origin` rules
([WVE-90](wve-90-remote-clients.md#transport)).

Opening the stream:

1. The client's first text frame is
   `{"ticket", "size": {"cols", "rows"}, "codec"}`. `codec` names the Ghostty commit the
   client's libghostty-vt was built from, and its snapshot format. libghostty-vt reports the same
   version at every commit, so only the commit tells two builds apart.
2. The Host answers with `{"terminal": Terminal, "restore": "snapshot" | "vt"}`:
   * `snapshot` when the holder's codec is the client's;
   * otherwise `vt`, the formatter's VT of the visible screen, without history.
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
* `{"exited": {"exitCode"}}`, after which the Host closes the stream.

Text frames from the client: `{"resize": {"cols", "rows"}}`.

Output, restores and input:

* Output follows the restore, in order. A client draws once its decoder reaches the ready prefix,
  and adds the history pages as the rest arrives.
* A stream whose unsent output passes 4 MiB is resynchronized: the Host drops what it hasn't sent
  and restores the stream again from a fresh snapshot.
* A client keeps the stream's bytes out of slow paths. The app's native plugin holds the
  WebSocket itself, since base64 through the web view's bridge held a spike to 5 to 10 MiB/s
  (WVE-150).

Size and replies:

* The last device to type sets the terminal's size, and the others clip. While it's the last, its
  own resizes (a rotation, a keyboard rising) apply at once. Another device's size applies when
  it next sends input.
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
  version and codec), `describe` and `subscribe`.
* Its events are Rex's terminal events, with Rex's payloads: `child_exited`, `pwd_changed`,
  `title_changed`, `bell`, `process_changed`, `desktop_notification`, `progress_report`,
  `clipboard_written`, `program_status_changed` and `program_status_removed`. The holder adds
  `command_changed` (OSC 133), `size_changed`, `label_changed` and `resync`.
* `attach` answers `{codec, snapshot_bytes, terminal}`, then sends the snapshot and all later
  output, in order.
* Each attached client has an outbox of its own. One that falls 4 MiB behind gets `resync` and a
  fresh snapshot.
* It is versioned in `hello`. A Host speaks the version of every holder still running, since a
  holder keeps the weave it started with until its shell exits.

When terminals are built, `worktrees/remove` and `worktrees/release` also refuse with
`worktree_busy` while a terminal in the worktree runs a command (`data.terminals`), and
otherwise close its terminals along with its sessions.

## Host management

**`host/status`** `{}` →
`{protocol, version, pid, startedAt, service: "launchd" | "systemd" | "onDemand" | "inProcess", environment: "loginShell" | "process", sessions: SessionListing[], remote?: string}`

`sessions` lists the open sessions. `remote` is the WebSocket's loopback address while the
Host serves one.

**`host/shutdown`** `{}` → `{}`

Suspends every open session (closing blank ones) and exits, without waiting for running
turns.

**`host/drain`** `{wait?: bool, except?: string}` → `{running: number}` (feature `drain`)

Gets the Host ready to stop (WVE-143). From then on it starts no new turns: `turn/start` and
`session/run` answer `host_stopping`, `queue/add` queues, and queued prompts wait for the Host
that comes back; steers and answers to pending requests still go through. With `wait` it
answers once no turn runs, or one waits on someone, but the turn of the agent process named
`except` (its `WEAVE_AGENT_PROCESS`), or when its drain timeout (5 minutes) passes; without
it, at once. `running` is how many such turns still run, which the stop cuts off. The stop
that follows doesn't wait again. If the asking client goes before the Host stops, the drain
ends and queues start what waits in them. Local clients only.

### Running the Host

The Host is the `weave daemon run` process; the CLI keeps the `weave daemon` command.

- **On demand.** When no Host is listening, a client command starts one in the background
  as now. That Host exits after 10 minutes with no open session and no client.
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
    let weave in when an agent first works in a session there. launchd allows the Host 20
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
    suspending every session (30 seconds). `weave daemon status` says when lingering is off,
    and when systemd gives the user manager less than the 30 seconds to stop at shutdown
    (`user@<uid>.service`'s `TimeoutStopUSec`, five seconds on Ubuntu 24.04), with the
    drop-in that raises it; a shutdown cuts a drain short, as it would the turn.
    Tailscale runs as root there, and changes Serve only for root and its operator, so
    pairing asks for `sudo tailscale set --operator=$USER` once. The socket is in the user's
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
| -32063 | `unknown_session` | the Host doesn't know the session and wasn't told its agent and directory |
| -32064 | `session_not_open` | the request needs an open session |
| -32065 | `turn_running` | a turn already runs in the session |
| -32066 | `already_resolved` | the pending request was answered, cancelled or withdrawn |
| -32067 | `wrong_agent` | the session belongs to another agent |
| -32068 | `requires_terminal` | the sign-in method needs a terminal on the Host's computer |
| -32069 | `forbidden` | a remote client asked to administer the Host |
| -32070 | `not_target` | the client tool call is for another client |
| -32071 | `remote_unavailable` | remote access couldn't be turned on |
| -32072 | `worktree_busy` | a session in the worktree runs a turn or waits on a request; `data: {sessions}` |
| -32073 | `not_a_repository` | the path isn't in a git repository |
| -32074 | `git_failed` | git refused or failed; the message is what it said |
| -32075 | `uncommitted_changes` | the worktree has changes that removing it would lose |
| -32076 | `key_reused` | the request key was used for another request (see [Request keys](#request-keys)) |
| -32077 | `host_stopping` | the Host is draining before it stops and starts no new turns (see `host/drain`) |

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
- The protocol is also kept as one JSON Schema (`protocol/tests/schema.rs`, behind the
  crate's `schema` feature): every request, answer and notification, the ACP types they
  carry, which method takes and gives which, and the protocol's constants. Clients in other
  languages generate their types from it; the app's TypeScript (WVE-100) is checked against it.

The TUI and the Host ship in one binary, so they normally agree. A TUI that meets an
incompatible Host after `weave daemon restart` `/reload`s itself into the current binary,
as it does now.

## Security

- The socket's file mode and directory, and the peer user id check, are the whole of `local`
  authentication. `local` is never accepted on a network transport.
- Clients can't make the Host run a command, set an agent's environment or write to a path
  of their choosing: the protocol has no field for any of them.
- `files/*` read only, and only what the Host's user can (see [Files](#files)).
- `worktrees/*` write only what git does: a worktree beside a repository, on a branch, and
  removing a repository's worktree other than its primary one (see [Worktrees](#worktrees)).
  Git runs the repository's own hooks, which no client sets.
- `agents/terminalSignIn` is the only response that carries a command, and only `local`
  clients that claimed `terminalSignIn` get it.
- Journals and traces stay 0600. The agent environment is never written or sent.

Remote clients follow ADR 0010 and [`wve-90-remote-clients.md`](wve-90-remote-clients.md):
the WebSocket binds loopback only and Tailscale Serve is the way in; every connection proves
a paired device by signing a challenge; a paired device may do what a local client can,
except `host/shutdown`, `devices/*`, agent sign-in and sign-out, and `agents/update`, which
answer `forbidden`.

## Clients

### The TUI

- `app.rs` talks to the Host through `weave-host-client` instead of `AgentConnection`.
  `ChatWidget` stays free of I/O and still renders ACP updates; it also takes the Host's
  turn, pending-request and terminal events.
- Permission and elicitation prompts answer with `pending/answer` and close on
  `pending/resolved`, whoever answered. The TUI no longer cancels pending requests when it
  leaves a session.
- The TUI lists `clipboard_write` in `capabilities.clientTools`, runs the calls targeted at
  it (pbcopy on a local Mac, OSC 52 otherwise) and answers them; `notice` events show in
  the transcript.
- Queued prompts are the Host's when it lists `queue` (WVE-107): a message the TUI doesn't
  steer during a turn goes to `queue/add`, the queue above the composer is the Host's, every
  client's prompts in it, and Esc takes the TUI's own back into the composer with
  `queue/remove`, leaving the rest paused in the Host. `/queue` resumes a paused queue.
- The TUI remembers its journal position. When the Host goes away, it reconnects (never
  starting a Host), attaches again from that position and gets only what it missed. The
  Host now resumes or loads the session in its agent itself.
- Leaving a session, when the TUI quits from a blank one or switches to another, detaches
  with `ifUnused`, so a session nothing else needs closes at once, as before.
- The default mode, MCP servers and their notices, and extra directories the agent can't
  accept move to the Host. `weave --trace` asks the Host for a trace and shows its path.
- The session picker says each session's branch, and across directories its repository and
  branch in place of its directory. A worktree in a terminal comes from worktrunk
  (`wt switch -c <branch> -x weave`).
- Shell mode (`!`), `@` file search, attachments and pasted images stay local. That is
  right only because the TUI runs on the Host's computer; a TUI elsewhere needs the Host
  methods listed as later work.
- A notice says when a newer version of the session's agent is out; `/update dismiss` hides
  that version (kept in `$XDG_STATE_HOME/weave/updates.json`). `/update` runs
  `agents/update`, then `session/reopen`, showing progress in the status line, and the
  `agentReopened` event shows in the transcript, replayed ones too (WVE-93).
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
- `weave sessions` says a session's branch. `weave worktrees pre-remove [path]` asks a running
  Host (never starting one) for `worktrees/release`, failing while a session in the worktree is
  busy, for worktrunk's `pre-remove` hooks; `weave worktrees install-hook` adds it to
  worktrunk's user config when asked.

## Crates

The crates as WVE-85 changed them, under the `crates/` directory they were in then; they
are at the repository root now, and `crates/daemon` is `host/`.

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
  one nobody takes up within the idle grace closes, keeping its journal's age, and opens again
  in a new journal (WVE-120);
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
- `--continue` choosing the latest session in the directory across agents, since the Host
  now knows them.
- Disconnecting local clients that fall behind, as WebSocket clients are.
