# host

The weave Host (`weave-host`), which `weave daemon` runs: client connections, open sessions and
their agents, journals, permission policies, headless runs, the Host MCP server and its bridge,
and the WebSocket and paired devices of remote clients. No UI. Read the root `AGENTS.md` first;
the Host protocol is `../docs/specs/wve-85-host-protocol.md`.

In the Host, `client` is one client's connection (`host/hello` first, then requests across
any agents and sessions) and `session` the task that owns an open session: its agent, its
journal (`journal`, JSONL under `~/.local/state/weave/daemon/sessions`, 0600; each line's
position is its event's `seq`, the header's creation time the journal's id), the clients
attached to it, its turns, and its pending requests. Everything a session's clients are
sent is journaled, so attaching after a position replays only what follows, and a restarted
Host resumes sessions it left open (suspended). A session `session/create` opened is blank
until it's prompted (`SessionHandle::is_blank`): it isn't listed, closes `blank_grace` (a
minute) rather than `idle_grace` after nothing needs it, and closes rather than suspends when
the Host stops, its journal removed; the TUI detaches from a blank session with `ifUnused`
when it quits or switches away, and opens a new one when it reconnects to a Host that
dropped it. Journals untouched for 14 days are pruned at startup and hourly, never an open
session's. A prompt is journaled with its turn (`turnStarted`, with the client's origin);
turns end in `turnEnded` for every client. `turn/steer` (a `features` entry) passes a steer to
the agent only while a turn the Host started runs, journals it as `turnSteered` where the
agent took it, and otherwise answers `notRunning` for the client to prompt with it instead. Each session's queue (`queue.rs`,
a `features` entry, WVE-107) is the session task's: `queue/add` starts a turn when none of the
session's own runs and nothing waits, and otherwise journals a `queued` entry; `advance` starts
the first queued prompt whenever the session's turn isn't running and the queue isn't paused,
with that prompt's origin and its id in `turnStarted`. A cancelled or failed turn pauses a queue
that holds prompts (`queuePaused`), and prompting, adding or `queue/resume` resumes it. The queue
is rebuilt from the journal (`Queue::from_records`); a closed session's new journal header
carries it on, as it does a title; taking up an interactive session with prompts waiting pauses
it as `interrupted`, and a Host starting takes up suspended headless sessions whose queue waits
(`Daemon::resume_queues`). Request keys (`admissions.rs`, feature `requestKeys`) are admitted
before `session/run`, `turn/start` and `queue/add` act: a line in `admissions.jsonl` beside the
journals, synced, then the answer, or a refusal that frees the key. The key is journaled with the
`turnStarted` or `queued` entry it caused, so a repeat of a key a stopped Host never answered
finds out from the journal whether the work happened (`client::keyed`). Keys go with the journals'
retention. Permission requests and elicitations are pending
requests (`pending/added`) every attached client sees, and later attachers in their state;
the first `pending/answer` counts, and `turn/cancel` cancels them. `sessions/watch` (a
`features` entry) keeps a client's list of the Host's sessions live without attaching:
`Shared::watch` answers with `Shared::listings` and registers the connection under the
watchers' lock, so nothing comes between, and `tell_watchers` sends `sessions/updated` from
each session task's `update_summary` (the change that sends `session/changed`, unless the
session is blank) and from `finish` (suspended or closed), and `sessions/removed` when a
session is deleted, its journal pruned, or closed while blank. Take the watchers' lock before
the registry, never while holding it. `files/list` (`files.rs`) lists a directory on the Host's computer for clients
that aren't on it: names and kinds, off the dispatch loop, with paths worked out from their text
so symlinks stay as named. It's the first of the `files/*` family, which `files/search` and
`files/read` are to join. The Host is git-aware (ADR 0019, `git.rs`, through the `git` command
with the agents' environment, `GIT_OPTIONAL_LOCKS=0` and no prompts): a session's `GitLocation`
(repository by primary worktree, worktree, branch, remote without credentials) is read alongside
starting its agent, kept in its summary and `Registry::known` and the header of any journal it
begins, and read again after each of its own turns (`Command::Located`, which sends
`session/changed`). `worktrees/*` list, make (beside the repository as worktrunk lays them out,
`git::worktree_path`) and remove worktrees; `Shared::release` refuses while a session in one runs
a turn or waits on a request, and otherwise closes them, for `worktrees/remove` and for
`worktrees/release`, which worktrunk's `pre-remove` hook asks through `weave worktrees
pre-remove`. The Host never removes a worktree on its own. Tests run git with
`GIT_CONFIG_GLOBAL=/dev/null`, so the person's git configuration stays out. Host-run terminals reach
clients as `terminalOutput`/`terminalExit` events; the Host strips agents' `_meta` terminal
output after turning it into the same events, so each chunk arrives once. The Host resolves
agents by id (`../agents`) and starts them in the session's directory with its own
environment over the login shell's (`instance.rs`); an agent started for no session (to
answer `agents/get`, sign-in or listing) is a spare the next session for that agent and
directory takes, stopped after a minute unused. New sessions start in the agent's configured
`mode` (`modes.rs`). When a session of a preset or registry agent opens, `updates.rs` looks for
a newer version in the background, one lookup an hour per package (or for the registry's
catalog) with the version source swappable (`DaemonConfig.upstream`), and tells the agent's
sessions of an older one, which tell their clients (`agents/updateAvailable`,
`SessionState.update`). `agents/update` is `weave update <agent>` checked with the Host's own
launcher; `session/reopen` has the session's task swap its agent process for one of the
current version once no turn runs or request waits, taking the session up through ACP resume
or load, journaling `agentReopened`, and going back to the old version when the new one
can't (`tests/updates.rs`); a blank session it refuses, since the agent may have
kept nothing of it to take up. An ACP `initialize` from a client of the old protocol is answered with
the protocol version, so it reloads into the current weave. Host tests
(`tests/daemon.rs`) run in-process with fake agents sharing one state file,
named in a test config.

Client tools (WVE-89, ADR 0009) run on a client's device for an agent: `clipboard_write`,
whose catalog is `weave_host_protocol::tools`. `mcp.rs` is the Host MCP server, `weave`, which
`client::setup` declares for every session setup under a new `serverId` or token (a
`Binding` the session keeps, bound to its id once the agent gives it, so calls that come
first wait for it), with the tools the config's `client_tools` choose. It speaks MCP
2026-07-28 only and answers `server/discover`, `tools/list`, `tools/call`, an empty
`resources/list`, and `subscriptions/listen`, which it acknowledges and holds open (Claude
Code opens one regardless); `initialize` is refused with `-32022`, and the session journals a
`notice` that the agent can't use client tools. Agents that advertise `mcpCapabilities.acp`
reach it over ACP: `acp-core`'s `mcp/message` handler hands calls to the `McpProvider` the
Host installs on each agent it starts (`AgentHandle::provide_mcp`). The rest get the stdio
server `weave mcp-bridge` (`DaemonConfig.mcp_bridge`, the Host's own binary), which `relay`s
bytes to `mcp.sock` beside the Host's socket (same mode and peer check), after its token. A
`tools/call` becomes `Command::ClientTool` in the session: a `clientTool` pending request for
the client that sent the running turn's latest prompt or steer, if it's attached and lists the
tool, which only that client may answer (`not_target`); otherwise a tool error at once. The
target detaching fails it as one that may have run; the agent cancelling it withdraws it.
Agents get only text in `content`, since Claude Code gives the model `structuredContent` in
its place. Host tools (`host_catalog`, chosen by the config's `host_tools`; ADR 0020) are
answered by the Host itself, in `host_tools.rs`, for the bound session: each is a Host protocol
method seen from inside the session, through the same code as the client request (the free
functions in `client.rs`: `list_sessions`, `get_session`, `run_as`, `add_queued`, `steer_turn`,
`cancel_turn`), answering with its JSON or a tool error. `start_session` starts a delegated
session (`session/run` with the `session` turn origin, its journal header's `started_by` naming
the caller, its policy `PermissionPolicy::within` the caller's); `prompt_session`,
`steer_session` and `cancel_session_turn` act only on sessions the caller started and theirs
(`reaches`), `[delegation]` caps depth and running ones, and `read_session` and `list_sessions`
read any. A delegated session's task tells its caller (`host_tools::tell`) when a turn the caller
began ends (`ended_text`, with `journal::latest_turn`'s last message) or waits on a person
(`waiting_text`): a steer into the caller's running turn, or else `queue/add`, taking the caller
up again first if it isn't open. `rename_session` sends `Command::Rename` as `session/rename` does.
A rename journals `Entry::Renamed`, and
the session task keeps the title in `renamed`, leaving the agent's later titles out of the
journal and summary. `journal::kept_title` reads it back for a suspended session, and a closed
session's new journal header carries it on. The TUI lists `clipboard_write` (`daemon::capabilities`) and runs calls targeted at
it with `Tui::try_copy`. Host tests (`tests/daemon.rs`) give the fake agents an
in-process bridge (`StdioMcp`) that runs the same `relay` to the Host's real socket, and a
Host whose agents take MCP over ACP (`daemon_over_acp`).

Remote clients (WVE-90, ADRs 0010 and 0016, spec `../docs/specs/wve-90-remote-clients.md`) reach
the Host over a WebSocket (`websocket.rs`) that listens on loopback only, with Tailscale Serve
the way in from the tailnet. Pairing turns that on (`remote.rs`): a `devices/offer` has the
Host listen and make its own Serve entry (`tailscale.rs`, through the `tailscale` command), and
both stay on while any device is paired, across restarts, until the last is revoked. Loopback
counts for nothing: every WebSocket connection proves a paired device at hello, signing its
`host/challenge` with a P-256 key, or pairs with a code `weave pair` offered (`devices.rs`,
which keeps the Host's id and the devices' public keys in `devices.json`, 0600, and offers in
memory). A remote client can do what a local one can,
except `host/shutdown`, `devices/*`, agent sign-in and sign-out, and `agents/update`
(`forbidden`). The Host
pings every 20 seconds and closes a WebSocket client with 8 MiB waiting to be sent beyond the
replays it asked for (a `Backlog`, which an attach tells its replay's size), which attaches again
after its position. Remote tests (`tests/remote.rs`) use a real
loopback WebSocket; `../host-client/examples/remote.rs` is the client for trying it by
hand.
