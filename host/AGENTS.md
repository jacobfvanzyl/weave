# host

The weave Host (`weave-host`), which `weave daemon` runs: client connections, open threads and
their agents, journals, permission policies, headless runs, the Host MCP server and its bridge,
and the connections it opens to the Dispatcher it joined, which carries the person's devices'
connections to it. No UI. Read the root `AGENTS.md` first;
the Host protocol is `../docs/specs/wve-85-host-protocol.md`.

In the Host, `client` is one client's connection (`host/hello` first, then requests across
any agents and threads) and `thread` the task that owns an open thread: its agent, its
journal (`journal`, JSONL under `~/.local/state/weave/daemon/threads`, 0600; each line's
position is its event's `seq`, the header's creation time the journal's id; Hosts of protocol
version 2 kept them in `daemon/sessions`, which `journal::move_from_version_2` moves once, and
whose records `journal::version_2` still reads, WVE-200), the clients
attached to it, its turns, and its pending requests. Everything a thread's clients are
sent is journaled, so attaching after a position replays only what follows, and a restarted
Host resumes threads it left open (suspended). A thread `thread/create` opened is blank
until it's prompted (`ThreadHandle::is_blank`): it isn't listed, closes `blank_grace` (a
minute) rather than `idle_grace` after nothing needs it, and closes rather than suspends when
the Host stops, its journal removed; the TUI detaches from a blank thread with `ifUnused`
when it quits or switches away, and opens a new one when it reconnects to a Host that
dropped it. Journals untouched for 14 days are pruned at startup and hourly, never an open
or a labelled thread's (`lib::labelled`; the journals are indexed before the startup prune, so
their labels are known). Labels (WVE-173) are a `labelled` entry with all of them after each
change, and the header's `labels` for those a thread started with or a closed one carried;
`Summary` and `Recorded` keep them, `thread/label` is `Command::Label`, and `client::check_labels`
checks those `thread/create` and `thread/run` give. Context usage and the last completed compaction
(WVE-174) are `journal::Usage`, noted from the thread's own `usage_update`s and
`compaction_update`s as `Actor::record` journals them, read again from a journal (`journal::usage`,
and `record_of` for the index), and carried into a closed thread's new journal header; watchers
hear of usage once it moves by a hundredth of the window (`thread::stepped`). A prompt is journaled with its turn (`turnStarted`, with the client's origin);
turns end in `turnEnded` for every client. `turn/steer` (a `features` entry) passes a steer to
the agent only while a turn the Host started runs, journals it as `turnSteered` where the
agent took it, and otherwise answers `notRunning` for the client to prompt with it instead. Each thread's queue (`queue.rs`,
a `features` entry, WVE-107) is the thread task's: `queue/add` starts a turn when none of the
thread's own runs and nothing waits, and otherwise journals a `queued` entry; `advance` starts
the first queued prompt whenever the thread's turn isn't running and the queue isn't paused,
with that prompt's origin and its id in `turnStarted`. A cancelled or failed turn pauses a queue
that holds prompts (`queuePaused`), and prompting, adding or `queue/resume` resumes it. The queue
is rebuilt from the journal (`Queue::from_records`); a closed thread's new journal header
carries it on, as it does a title; taking up an interactive thread with prompts waiting pauses
it as `interrupted`, and a Host starting takes up suspended headless threads whose queue waits
(`Daemon::resume_queues`). A turn a stopped Host left open ends `interrupted` when the thread is
taken up (`client::reopen`, `errors::interrupted`, WVE-144); a headless thread continues its
own once, from its origin, before its queue starts anything (`thread::Continuation`, started
before the task runs), and its `turnStarted` names the turn in `continues`, which also keeps a
continuation from being continued again. That `turnStarted` is journaled in `client::reopen`
with the interrupted turn's end, before the agent is prompted, so a reader never finds one
without the other; `journal::turn` gives the interrupted turn's `continuedIn` from it (WVE-168).
Those threads are taken up at startup too. A thread's successor (`thread/setSuccessor`,
`Command::SetSuccessor`) is a `continuedIn` entry, kept in `Summary` and `Recorded` and carried
into a closed thread's new journal header; `host_tools::tell` sends a report to the last of the
caller's successors (`Registry::latest_successor`). Request keys (`admissions.rs`, feature `requestKeys`) are admitted
before `thread/run`, `turn/start` and `queue/add` act: a line in `admissions.jsonl` beside the
journals, synced, then the answer, or a refusal that frees the key. The key is journaled with the
`turnStarted` or `queued` entry it caused, so a repeat of a key a stopped Host never answered
finds out from the journal whether the work happened (`client::keyed`). Keys go with the journals'
retention. Permission requests and elicitations are pending
requests (`pending/added`) every attached client sees, and later attachers in their state;
the first `pending/answer` counts, and `turn/cancel` cancels them. `threads/watch` (a
`features` entry) keeps a client's list of the Host's threads live without attaching:
`Shared::watch` answers with `Shared::listings` and registers the connection under the
watchers' lock, so nothing comes between, and `tell_updated` sends `threads/updated` from
each thread task's `update_summary` (the change that sends `thread/changed`, unless the
thread is blank) and from `finish` (suspended or closed), and `threads/removed` when a
thread is deleted, its journal pruned, or closed while blank (`tell_removed`). A watcher for
labels (`Watcher`) hears of the threads that carry them, and of one that stops carrying them
once more, through the threads it last heard of while they did (`matched`). Take the watchers' lock before
the registry, never while holding it. `files/list` (`files.rs`) lists a directory on the Host's computer for clients
that aren't on it: names and kinds, off the dispatch loop, with paths worked out from their text
so symlinks stay as named. It's the first of the `files/*` family, which `files/search` and
`files/read` are to join. The Host is git-aware (ADR 0019, `git.rs`, through the `git` command
with the agents' environment, `GIT_OPTIONAL_LOCKS=0` and no prompts): a thread's `GitLocation`
(repository by primary worktree, worktree, branch, remote without credentials) is read alongside
starting its agent, kept in its summary and `Registry::known` and the header of any journal it
begins, and read again after each of its own turns (`Command::Located`, which sends
`thread/changed`). `worktrees/*` list, make (beside the repository as worktrunk lays them out,
`git::worktree_path`) and remove worktrees; `Shared::release` refuses while a thread in one runs
a turn or waits on a request, and otherwise closes them, for `worktrees/remove` and for
`worktrees/release`, which worktrunk's `pre-remove` hook asks through `weave worktrees
pre-remove`. The Host never removes a worktree on its own. Tests run git with
`GIT_CONFIG_GLOBAL=/dev/null`, so the person's git configuration stays out. Host-run terminals reach
clients as `terminalOutput`/`terminalExit` events; the Host strips agents' `_meta` terminal
output after turning it into the same events, so each chunk arrives once. The Host resolves
agents by id (`../agents`) and starts them in the thread's directory with its own
environment over the login shell's (`instance.rs`), which their Host-run terminals start in too
(`Launch::agent_environment`, handed to `acp-core`); an agent started for no thread (to
answer `agents/get`, sign-in or listing) is a spare the next thread for that agent and
directory takes, stopped after a minute unused. New threads start in the agent's configured
`mode` (`modes.rs`), those `thread/run` starts too (ADR 0026); when a thread's policy rejects a
permission request, it journals a `notice` saying which tool, its kind and `--approve` for it
(`thread::rejected_text`). When a thread of a preset or registry agent opens, `updates.rs` looks for
a newer version in the background, one lookup an hour per package (or for the registry's
catalog) with the version source swappable (`DaemonConfig.upstream`), and tells the agent's
threads of an older one, which tell their clients (`agents/updateAvailable`,
`ThreadState.update`). `agents/update` is `weave agents update <agent>` checked with the Host's own
launcher; `thread/reopen` has the thread's task swap its agent process for one of the
current version once no turn runs or request waits, taking the thread up through ACP resume
or load, journaling `agentReopened`, and going back to the old version when the new one
can't (`tests/updates.rs`); a blank thread it refuses, since the agent may have
kept nothing of it to take up. An ACP `initialize` from a client of the old protocol is answered with
the protocol version, so it reloads into the current weave. Before it stops, the Host drains
(WVE-143, `Shared::begin_drain`): `Actor::prompt` refuses new turns with `host_stopping`,
`enqueue` queues and `advance` holds the queue, while `wait_for_turns` waits, up to
`drain_timeout` (5 minutes), for every thread whose `Summary::activity` isn't idle, but the
one whose agent process is `except`. Each agent process gets a name, `WEAVE_AGENT_PROCESS`
(`Launch::process`, kept in `Summary::agent_process`), which a `weave` it runs passes as
`except`. `host/drain` begins a drain for a client, which `lapse_drain` ends if that client
goes before the Host stops (then `Command::Advance` restarts queues); `Daemon::drain` is the
signal's, which skips a drain a client already waited out. Host tests
(`tests/daemon.rs`) run in-process with fake agents sharing one state file,
named in a test config.

Service tools (WVE-171, ADR 0027) are `service_tools.rs`: the Dispatcher's declared tools are
kept with it in `devices.json` (`Devices::declare_tools`, `service_tools`), offered in every
thread set up after (`client::service_tools`, `Mcp::declare`), and a call to one is a
`service/toolCall` to the connection that declared them last (`ServiceTools::serve`), which
answers with `service/answerTool`; the connection ending fails its calls. Client tools (WVE-89, ADR 0009) run on a client's device for an agent: `clipboard_write`,
whose catalog is `weave_host_protocol::tools`. `mcp.rs` is the Host MCP server, `weave`, which
`client::setup` declares for every thread setup under a new `serverId` or token (a
`Binding` the thread keeps, bound to its id once the agent gives it, so calls that come
first wait for it), with the tools the config's `client_tools` choose. The binding and the
configured servers make up the thread's `Servers`, whose statuses (WVE-160) are
`ThreadState.mcpServers` and `thread/changed`'s: `weave` declared, connected from the
agent's first 2026-07-28 request (`Command::SummaryChanged`), or unavailable, and each
configured server passed or skipped. It speaks MCP
2026-07-28 only and answers `server/discover`, `tools/list`, `tools/call`, an empty
`resources/list`, and `subscriptions/listen`, which it acknowledges and holds open (Claude
Code opens one regardless); `initialize` is refused with `-32022`, and the thread journals a
`notice` that the agent can't use client tools. Agents that advertise `mcpCapabilities.acp`
reach it over ACP: `acp-core`'s `mcp/message` handler hands calls to the `McpProvider` the
Host installs on each agent it starts (`AgentHandle::provide_mcp`). The rest get the stdio
server `weave mcp-bridge` (`DaemonConfig.mcp_bridge`, the Host's own binary), which `relay`s
bytes to `mcp.sock` beside the Host's socket (same mode and peer check), after its token. A
`tools/call` becomes `Command::ClientTool` in the thread: a `clientTool` pending request for
the client that sent the running turn's latest prompt or steer, if it's attached and lists the
tool, which only that client may answer (`not_target`); otherwise a tool error at once. The
target detaching fails it as one that may have run; the agent cancelling it withdraws it.
Agents get only text in `content`, since Claude Code gives the model `structuredContent` in
its place. Host tools (`host_catalog`, chosen by the config's `host_tools`; ADR 0020) are
answered by the Host itself, in `host_tools.rs`, for the bound thread: each is a Host protocol
method seen from inside the thread, through the same code as the client request (the free
functions in `client.rs`: `list_threads`, `get_thread`, `run_as`, `add_queued`, `steer_turn`,
`cancel_turn`), answering with its JSON or a tool error. `start_thread` starts a delegated
thread (`thread/run` with the `thread` turn origin, its journal header's `started_by` naming
the caller, its policy `PermissionPolicy::within` the caller's); every tool reads and acts on any
thread (ADR 0023), and `[delegation]` caps depth and the caller's own running delegated
threads (`one_more`, `room`). A thread's task reports to the thread whose agent began its
running turn (`Actor::caller`, the turn's `thread` origin) when that turn ends (`ended_text`,
with `journal::latest_turn`'s last message) or waits on a person (`waiting_text`), through
`host_tools::tell`: a steer into the caller's running turn, or else `queue/add`, taking the
caller up again first if it isn't open. A report's origin has `report: true`, and a report's
turn reports to nobody, which is all that keeps two threads from trading reports. `rename_thread` sends `Command::Rename` as `thread/rename` does.
A rename journals `Entry::Renamed`, and
the thread task keeps the title in `renamed`, leaving the agent's later titles out of the
journal and summary. `journal::kept_title` reads it back for a suspended thread, and a closed
thread's new journal header carries it on. A thread shows its rename or else its agent's last
title (`journal::shown_title`; `Recorded::title` for one the Host isn't running), and is ordered
by its last activity, the last journal record that is some (`Entry::is_activity`): taking it up,
and the commands, modes and usage its agent tells as it's taken up, aren't. The TUI lists `clipboard_write` (`daemon::capabilities`) and runs calls targeted at
it with `Tui::try_copy`. Host tests (`tests/daemon.rs`) give the fake agents an
in-process bridge (`StdioMcp`) that runs the same `relay` to the Host's real socket, and a
Host whose agents take MCP over ACP (`daemon_over_acp`).

Terminals (ADR 0022, WVE-152, `terminals/`) are kept alive by an `Owner` outside the Host
(`owner.rs`): holders (`holder.rs`, `weave-holder` beside the Host's own binary, in
`DaemonPaths::terminals`), later perhaps Rex blocks. The seam is the holder protocol's messages
over bounded channels (`Wire`), so nothing above it knows which owner a terminal has, and a slow
reader holds its owner back rather than the Host buffering.

- **Starting holders:** `systemd-run --user` on Linux when the user's systemd answers, since the
  Host's `KillMode=mixed` unit would take a child with it; `weave-holder spawn` otherwise. The
  agents' environment goes in a 0600 env file the holder removes once read.
- **Finding them again:** `Owner::find` keeps the records whose socket answers and prunes the
  rest, the first time terminals are asked for (`Terminals::ready`).
- **The service:** `Terminals` holds one control connection per terminal, subscribed to its
  events, and asks it `describe` again on Rex's change events, so `terminals/list` and its
  scope's watchers (`terminals/watch`, the same no-gap watch as threads') stay current. A
  terminal's scope is the deepest worktree its directory is in, else the directory, symlinks
  resolved. `Shared::release` refuses a worktree while one of its terminals runs a command
  (OSC 133), and otherwise closes them with its threads.
- **The stream:** `terminals::stream` serves a terminal's stream (`weave-terminal`) to local
  clients on `terminals.sock` beside the Host's socket (`serve_local`,
  `Daemon::serve_terminal_streams`, WVE-167), and on connections the Dispatcher carries for a
  device (`serve`, with the device), generic over its transport. It
  checks the ticket, connects to the owner afresh, attaches with a snapshot for the owner's codec
  or VT for another, with the history when the client asks, and relays frames, reading the owner
  only as fast as the client takes them, so the holder's 4 MiB resync handles a slow device; a
  client's `{"resync": {}}` asks the owner for one (`resync`). The size follows the stream that
  last typed (`Terminals::typed`, `resized`), and clipboard writes go to it alone.
- **Tests:** `tests/terminals.rs` drives it all through a real client, against a fake owner that
  leaves out `command` and `opened_from`, and against real holders it builds with cargo.

Remote clients (WVE-90, spec `../docs/specs/wve-90-remote-clients.md`) reach the Host only through
the Dispatcher it joined (ADR 0030): the Host listens for nothing but its Unix socket, and opens
every connection to the Dispatcher itself (below). Until WVE-197 it listened on a loopback
WebSocket behind a Tailscale Serve entry of its own, for devices and services that paired with
it; that went. The server's end of those connections is `weave-remote` (`../remote/`), which the
Dispatcher shares: the WebSocket, its pings, deadline and limits (`websocket::serve_rpc`, for a
connection the Host opened as well as one accepted) and the preamble (`preamble.rs`). A remote
client can do what a local one can, except `host/shutdown`, `host/drain`, `dispatcher/join` and
`dispatcher/leave`, agent sign-in and sign-out (`forbidden`, `Connection::local_hello`), and a
service less: the first request handler (`Connection::refusal`) answers `forbidden` for any
method outside `FOR_SERVICES` (ADR 0027), attaching without `observe` or running with `attach`.
The only service is the Dispatcher the Host joined; `Connection::origin_for` lets only it name
what started a turn (`TurnOrigin::Service`, its name the one the Host keeps for it) or a thread on
another Host that asks (`caller`). The Host pings every 20 seconds and closes a connection with
8 MiB waiting to be sent beyond the replays it asked for (a `Backlog`, which an attach tells its
replay's size, `dispatcher.rs`), which attaches again after its position. The Host's socket and
in-process clients say `local`, and nothing else is taken there: a Host pairs with nothing, so
`pair` is refused everywhere and there are no `devices/*` methods or `devices` feature.

The Host's id and the Dispatcher it joined are `devices.json` (`devices.rs`, 0600). A Host whose
file still holds devices that paired with it before WVE-197 drops them when it loads it, and
notes `serveEntryLeft`; only then does `serve_entry.rs` touch Tailscale Serve, at startup
(`Daemon::remove_serve_entry`, which `weave daemon run` spawns) through `DaemonConfig::former_serve`
(`FormerServe`: the loopback address its entry forwarded to, and `weave_remote::access::Serve`,
the `tailscale` command or a test's), removing only the entry that forwards there, under the
computer's tailnet name, and forgetting the note once it's gone. One it can't remove, as where
only root may change Serve, it logs, and gives in `host/status` as `serveEntry` with the command
for the person (`sudo tailscale serve --https=<port> off`), looking again when a local client
asks for the status (`ServeEntry::recheck`). A Host in a new directory, as every test's and dev
Host's, never runs `tailscale`; tests give a fake `Serve` (`tests/joined.rs`).

The Dispatcher the Host joined (ADR 0030, WVE-194, spec `../docs/specs/wve-175-dispatcher.md`'s
Hosts) is `dispatcher.rs`: `dispatcher/join`, local only, takes a code `hosts/offer` gave there and
the Dispatcher's URL or, on its computer, its `hosts.sock` (`weave_host_client::remote::Opened`).
The Host proves a key of its own (`key.json`, `DeviceKey::kept`) in the first two requests
(`weave_remote::preamble`), keeps the Dispatcher's key in `devices.json` as the service it
joined (`Devices::join`, `leave`; taken at hello only on `Peer::Joined`, the connection the Host
opened, after `host/challenge` there) and where it is in `dispatcher.json`, then serves the
connection with `client::serve_joined` through `weave_remote::websocket::serve_rpc`. `keep` dials again with backoff (`DispatcherSettings`), and forgets the Dispatcher
when it closes with `CLOSE_REVOKED` or refuses the Host's key; `dispatcher/leave` closes with
`CLOSE_REVOKED` itself. A joined Host doesn't exit when idle, `host/status` names the Dispatcher,
and `Daemon::shutdown` closes the connection (`dispatcher::stop`); `resume_dispatcher` connects
again at startup. The tests are the Dispatcher's (`dispatcher/tests/joins.rs`), and what the Host
lets the Dispatcher do over the connection, against a fake one, `tests/joined.rs`.

The Dispatcher carries the person's devices' connections to the Host (ADR 0030, WVE-195; the
Host protocol's Connections the Dispatcher carries; feature `carry`). `dispatcher/carry`, which
`Connection::carry` takes only on `Peer::Joined` (it's in `FOR_SERVICES`), has
`dispatcher::carry` open another connection where the Host joined the Dispatcher, check its id at
`dispatcher/challenge`, present the token with `hosts/carry` and a nonce of its own, and check the
Dispatcher's signature of it (`carry_message`) against the key it kept when it joined
(`Devices::joined_signed`), closing the connection with `CLOSE_UNAUTHENTICATED` and serving
nothing when it's missing or wrong; then answer and serve it in a
task of its own (`serve_carried`, boxed as `websocket::serve` is, for the same cycle): the Host
protocol as `Peer::Carried { link, device }` (`client::serve_carried`), whose hello takes only
`Auth::Dispatcher` and gives the device the Dispatcher named, or a terminal's stream
(`terminals::stream::serve` with the device, whose ticket it must be). A carried device is the
Dispatcher's: it isn't in `devices.json`, so revoking it is the Dispatcher's to do, by closing
its end. `Auth::Dispatcher` anywhere else is refused. The
connections carried for a Dispatcher close with `State::carried`, a token `leave`, `forget`,
joining another and `stop` cancel. `thread/create`, `thread/attach`, `threads/list` and
`thread/run` expand a leading `~` under the Host's home (`under_home`), as a client on another
computer names its directory there, and a new thread's directory must exist here
(`directory_here`). The tests are the Dispatcher's (`dispatcher/tests/carry.rs`).

Other Hosts (WVE-185, ADR 0029; the Host protocol's Other Hosts section) are reached through the
Dispatcher: Hosts don't pair with each other. A service that declared `hosts`
(`Devices::declare_tools`, `hosts_service`) gets the Host tool calls given another Host's `host`:
`host_tools::elsewhere` works the method's request out here (`request`, `start_elsewhere`: the
caller's directory under the home, `Shared::home`, as `~/…` from the repository's main worktree
with its `remote`, `counterpart`; the policy within the caller's; the agent's own key; and
`room`, `[delegation] running` less this Host's busy delegated threads, `busy_here`) and
`ServiceTools::call_host` sends it as `service/hostCall`, answered by `service/answerTool` as a
service tool call is. This Host keeps no record of it: the Dispatcher follows the turn and
reports with `thread/report` (`client::report_thread`, keyed), which `host_tools::tell` tells
as it tells this Host's own reports. On the serving side `Connection::origin_for` turns a
service's `caller` into the `thread` origin naming the other Host and its name, `client::place`
expands `~` and checks the checkout's remote, and `Actor::caller` ignores origins on another
Host. `Summary::turn_from_host` and `startedByHost` up the starting chain keep turns another
Host's agent began from reaching further (`host_tools::from_other_host`). Reports that take up a
closed caller do so one at a time (`Shared::taking_up_for_reports`), or two at once would take it
up twice. Peer Hosts (ADR 0017, WVE-109) are retired: `Devices::load` drops their pairings with the
other devices that paired before WVE-197, and `Daemon::new` removes `DaemonConfig::retired`
(`peers.json`, `host-key.json`). The tests are the Dispatcher's (`dispatcher/tests/hosts.rs`).
