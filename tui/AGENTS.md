# TUI project

This directory owns `weave`, a standalone terminal client for ACP agents
(Claude, Codex, Gemini or any ACP command), tracked by WVE-82. Read the live
issue before implementation and use the repository's pinned Linear CLI and
tracker conventions from `../docs/agents/issue-tracker.md`.

## Boundaries

- It speaks ACP v1 stable and implements it completely. Two unstable RFDs are in scope
  too, each advertised by default and withheld per agent: session compaction (Preview;
  `unstable_session_compaction`, `compaction = false`) and subagent sessions (draft;
  `unstable_subagents`, `subagents = false`). The v2 draft and other unstable RFDs stay out
  of scope unless the issue changes.
- It launches agents locally. It has no dependency on `product/` (Portal or its
  protocol), and it is not a root Bun workspace.
- Agents run in the weave Host (WVE-83, WVE-85; `weave daemon`), a per-user process the CLI
  starts on first use or launchd keeps running, so sessions outlive the TUI: quitting,
  crashing or rebuilding it and reattaching (`--resume`, `--continue`) finds the session,
  mid-turn if a turn is running. ACP runs only between the Host and its agents, one process
  per open session. Clients speak the Host protocol (`../docs/adr/0008-weave-daemon-is-the-host.md`,
  spec `docs/specs/wve-85-host-protocol.md`, types in `crates/protocol`), which carries ACP's
  content as its payload. `--no-daemon` (`[daemon] enabled = false`) runs the same Host
  in-process, so there is one code path. `smoke`, `login` and `logout` talk to agents
  directly. Triggers (schedules, webhooks) are planned separately; `Daemon::run` and the
  `PermissionPolicy` are what they will call. Domain terms are in `CONTEXT.md`.
- The TUI shows one session at a time. Like Codex, it runs fullscreen by default: on the
  alternate screen, `weave` owns the transcript (`transcript.rs`: retained cells that
  reflow, scrolling, selection and copy, and Find, matched by `find.rs`). Inline mode
  (`--no-alt-screen`, `[tui] alternate_screen = "never"`) keeps Codex's inline viewport,
  with finished history in native terminal scrollback. Both modes must keep working.

## Stack

Follow `openai/codex` `codex-rs/tui` for technology and structure: Rust 2024,
tokio, ratatui + crossterm, pulldown-cmark, syntect, insta/vt100 snapshot tests.
Codex is Apache-2.0; when adapting one of its modules, keep a header comment
naming the upstream path. The ACP layer is the official `agent-client-protocol`
crate, pinned exactly because 3.x is new.

| Crate | Owns |
| --- | --- |
| `crates/acp-core` | Agent launch, the ACP connection, client-side handlers, protocol trace. No UI. |
| `crates/protocol` | The Host protocol's wire types, roles, error codes and versions, with golden snapshots, and the permission policy. No I/O. |
| `crates/agents` | Which agents there are and how to launch them: config, presets, the ACP registry, the login shell's environment. |
| `crates/daemon` | The weave Host: client connections, open sessions and their agents, journals, permission policies, headless runs, and the WebSocket and paired devices of remote clients. No UI. |
| `crates/host-client` | A client of the Host: hello, typed requests, the Host's messages in order, opening sessions; and a remote client's WebSocket and device credentials. |
| `crates/tui` | The interactive client: fullscreen transcript or inline viewport, chat state, composer. |
| `crates/cli` | The `weave` binary and its subcommands, Host autostart and launchd service included. |
| `crates/fake-agent` | A scripted ACP agent (`weave-fake-agent`) for tests and live runs. |

Keep protocol behavior in `acp-core`. Client services (`fs/*`, `terminal/*`) live there
and are advertised per `ClientOptions`; never advertise one that isn't answered. Real
adapters may not call them (Claude's runs its own tools), so the fake agent is what
exercises them: integration tests connect it in-process over `Channel::duplex`, and its
prompt scripts (`/run`, `/write`, `/read`, `/kill-after`, `/plan`, `/slow`, `/compact`,
`/delegate`) drive the
real TUI. In `tui`, rendering follows Codex's look: `tool_call` maps ACP tool kinds onto
Codex's cells (exec, explored, patch, MCP), `history_cell`, `markdown` and `streaming` the
rest, each with a compact and a detailed (Ctrl+T) form; `palette` probes the terminal's
colors (OSC 10/11) and `style` derives surfaces from them; `highlight` wraps syntect and
two-face; `footer` and `status` are the bottom pane; `composer` is the input, with `vim`
(after Codex's composer Vim mode) editing the same text in the opt-in Vim composer, and
`thumbnails` the draft's pasted images above it and, in the fullscreen transcript, each
message's under its text, drawn through `graphics` (the Kitty graphics protocol's Unicode
placeholders: each image is sent once, and its cells are text, so they diff, move and reflow
like any other; the startup probe asks only Ghostty and kitty, outside tmux and Zellij,
whether they draw them). An image's `Slot` (its id and thumbnail) is shared by the draft and
the transcript, so a sent image is neither decoded nor sent again; images from the journal
are decoded one at a time off the UI thread, and the transcript holds the newest 64;
during a turn Enter steers it when the Host and the agent can (`ChatWidget::can_steer`; not the
agent's slash commands) and queues otherwise, and Tab always queues, as in Codex;
`/new`, `/reload` and `/subagents` are the TUI's own slash commands, offered with the agent's
and handled locally (`/reload` ends the TUI and the CLI execs its own binary again with
`--resume`). The app follows the active session's journal position (`app.rs`): an attach's
answer arrives in order ahead of its replay, events up to the journal head it gave are
replayed history (no notifications, no turn state), and the TUI's own prompts are known by
their turn origin's `clientId`. When the Host goes away, the app reconnects through the
CLI's `Reconnector` (which never starts a Host) and attaches again after its position, so
only what it missed arrives, and `/reload`s itself if the new Host speaks another protocol
version; `subagents` shows ACP subagents as Codex shows its own, each child session in a chat of its
own that the parent routes updates to. `ChatWidget` stays free of I/O: it turns
Host events (`events.rs`), keys and mouse input into transcript cells and `AppCommand`s
(answers to pending requests included), so it is tested without a terminal, in both screen
modes. Terminal mechanics (`custom_terminal`, `insert_history`) are tested on a vt100
backend. Untrusted agent text reaches the terminal only after control characters are
stripped.

`acp-core` also declares and handles the terminal output extension
(`_meta.terminal_output_delta`, Zed's convention that codex-acp and claude-agent-acp use for
commands they run themselves): `terminal_meta.rs` turns its chunks and exits into the same
terminal events as client terminals, including in replayed sessions. It handles the
steering extension too (WVE-86; `steering.rs`): agents that advertise `_meta.steering.supported` take
`_session/steering`, a steer for the running turn. `AgentHandle::steer` asks with
`idleBehavior: "promptRequired"`, so an agent whose turn ended hands it back rather than
starting a turn of its own, and its answer arrives as `AgentEvent::Steered`, in order with the
turn's updates. The fake agent takes it too: a turn answers its steers before ending, and
`slow` stops its chunks for them.

In `daemon`, `client` is one client's connection (`host/hello` first, then requests across
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
agent took it, and otherwise answers `notRunning` for the client to prompt with it instead. Permission requests and elicitations are pending
requests (`pending/added`) every attached client sees, and later attachers in their state;
the first `pending/answer` counts, and `turn/cancel` cancels them. Host-run terminals reach
clients as `terminalOutput`/`terminalExit` events; the Host strips agents' `_meta` terminal
output after turning it into the same events, so each chunk arrives once. The Host resolves
agents by id (`crates/agents`) and starts them in the session's directory with its own
environment over the login shell's (`instance.rs`); an agent started for no session (to
answer `agents/get`, sign-in or listing) is a spare the next session for that agent and
directory takes, stopped after a minute unused. New sessions start in the agent's configured
`mode` (`modes.rs`). An ACP `initialize` from a client of the old protocol is answered with
the protocol version, so it reloads into the current weave. Host tests
(`crates/daemon/tests/daemon.rs`) run in-process with fake agents sharing one state file,
named in a test config.

Remote clients (WVE-90, ADR 0010, spec `docs/specs/wve-90-remote-clients.md`) reach the Host
over a WebSocket (`websocket.rs`) that listens on loopback only, with Tailscale Serve the way
in from the tailnet. Loopback counts for nothing: every WebSocket connection proves a paired
device at hello, signing its `host/challenge` with a P-256 key, or pairs with a code
`weave pair` offered (`devices.rs`, which keeps the Host's id and the devices' public keys in
`devices.json`, 0600, and offers in memory). A remote client can do what a local one can,
except `host/shutdown`, `devices/*` and agent sign-in and sign-out (`forbidden`). The Host
pings every 20 seconds and closes a WebSocket client with 8 MiB waiting to be sent, which
attaches again after its position. Remote tests (`crates/daemon/tests/remote.rs`) use a real
loopback WebSocket; `crates/host-client/examples/remote.rs` is the client for trying it by
hand.

Subagents follow the current draft of the Subagent Sessions RFD (`subagent_update`,
session-directed messages, `running`/`idle` states). claude-agent-acp and codex-acp still
send the earlier draft (`subagent_spawned`, `subagent_state_update`), which the pinned schema
rejects, so `subagent_compat.rs` reads it first, as the current draft, in an untyped handler
registered before the typed one. Delete it once the adapters move over.

## SDK rules

The SDK runs one dispatch loop per connection, and `on_receive_*` handlers run
inside it. Never await a peer response (`block_task`) inside a handler, because
that deadlocks. Forward work to the event channel or `cx.spawn` it. Requests
whose completion must stay ordered with session updates use
`on_receiving_result`, as `AgentConnection::prompt` does.

## Commands

Run from `tui/`. `rust-toolchain.toml` pins 1.95.0. With Homebrew's rustup,
put `/opt/homebrew/opt/rustup/bin` on `PATH`.

```bash
cargo build
cargo test
cargo clippy --all-targets   # Codex's lint set; must be clean
cargo fmt
./target/debug/weave --agent claude         # interactive; or codex, gemini, a config agent
./target/debug/weave smoke --agent claude   # one headless turn
./target/debug/weave --no-daemon -- ./target/debug/weave-fake-agent   # scripted agent
```

Clients name agents by id, so `-- <command>` works only with `--no-daemon` (the in-process
Host is given it as agent `command`); for the shared Host, define the agent under
`[agents.<id>]`, as `[agents.fake] command = "…/weave-fake-agent"`. Likewise `--no-fs` and
`--no-terminal` apply in-process; for the shared Host set `fs`/`terminal` under the agent.
`--resume [ID]` opens a session (or the picker, also on Ctrl+R in the TUI), `--continue` the
latest one here (of the agent last used here, `cli/src/recent.rs`, unless `--agent` or `--`
names one), and `--add-dir` adds workspace roots. Ctrl+D on an empty composer leaves the TUI
with a turn still running in the Host. `weave login` and `weave logout` manage sign-in
directly; when the agent answers `auth_required` at startup, `weave` offers its methods and
signs in through the Host (`agents/authenticate`, or `agents/terminalSignIn` and the command
run in this terminal), then retries.
Agents and MCP servers come from `~/.config/weave/config.toml` (read from `tui.toml` while only
that exists; see `crates/agents/src/config.rs`), whose `[tui]` and `[daemon]` are the CLI's
(`crates/cli/src/config.rs`), as is `[remote]`, which `weave daemon run` reads to serve
remote clients (a restart picks up a change).

```bash
./target/debug/weave run --approve read,edit "fix the tests" --agent <id>   # headless, in the Host
./target/debug/weave run --detach "…"     # leave it running; prints the session id
./target/debug/weave run --continue "…"   # or --resume <id>, as the TUI names sessions
./target/debug/weave sessions             # open in the Host; also cancel <id>, close <id>
./target/debug/weave daemon status        # also start, stop, restart, run (foreground), install, uninstall
./target/debug/weave pair                 # a QR code and code another device pairs with
./target/debug/weave devices              # paired devices; also revoke <id>
```

`--resume <id>` reopens a session with the agent and directory its journal records,
overriding `--agent` and `--cwd` (`start::choose`); the Host refuses to attach a session to
another agent (`wrong_agent`). `sessions/list` with an agent leads with the Host's sessions
of that agent in the directory, open ones and then ones a stopped Host left open within the
idle grace of their last activity (its index of journals, `Registry::known`), each listing
saying its state, activity, clients and whether it's headless, which the TUI's picker shows
as badges and `--continue` uses to pass over headless runs; without an agent it lists the
Host's sessions across agents. Session state carries the session's directory, which the TUI
adopts.

Commands share their argument groups (`cli/src/args.rs`): `AgentArgs` (which agent, its
config and trace) everywhere an agent is involved, `WorkspaceArgs` where a session is,
`SessionArgs` (`--resume`, `--continue`) where one is reopened, and `ApproveArgs`
(`--approve <kinds>|all`, the rest rejected, through `acp-core`'s `PermissionPolicy`) where a
turn runs headless. Prompts are positional, before the `--` agent command.

`weave daemon install` runs the Host as a launchd user agent (`cli/src/service.rs`) from
the binary it's run from, which can't be in `~/Documents`, `~/Desktop` or `~/Downloads`
(macOS keeps launchd's processes out of them; install a copy such as `~/.local/bin/weave`).
While it's installed, clients never start a Host and `start`/`stop`/`restart` use
`launchctl`; `uninstall` removes it. `weave daemon restart` picks up a rebuilt binary (the TUI needs no restart, as long as
`weave_host_protocol::PROTOCOL_VERSION` is one it speaks); sessions it had open resume when
reattached. The Host captures the login shell's environment when it starts, so restart it
after changing your shell's. Set `WEAVE_DAEMON_DIR` to run a dev Host (socket, lock, log,
journals and traces) beside the installed one; its log is `daemon.log` there, and with
`XDG_CONFIG_HOME` it reads a config of its own. Builds without debug info
(`CARGO_PROFILE_DEV_DEBUG=0`) keep `target/` small on a full disk.

Keep only the latest debug build in `target/debug`, which otherwise grows with every rebuild
and can fill the disk: clear `target/debug/incremental` (old incremental sessions pile up
there, gigabytes at a time) when done building, and when it still holds artifacts of earlier
dependency or profile settings, `cargo clean --profile dev` and build again. Never remove
`target/release`: an installed `weave` (`~/.local/bin/weave`) may be a symlink to
`target/release/weave`, so rebuild it with `cargo build --release` instead, and plain
`cargo clean` removes it too.

The fake agent reads `WEAVE_FAKE_AGENT_STATE` (persist sessions and sign-in to this JSON
file, which its processes share and merge as an agent's own storage would),
`WEAVE_FAKE_AGENT_REQUIRE_AUTH=1`, and `WEAVE_FAKE_AGENT_PAGE_SIZE`. Its scripts
also include `/ask` (form elicitation), `/connect` (URL elicitation) and `/mcp`.

Both run against a real agent and its existing login. `--log-file <file>` captures the
TUI's diagnostics; agent stderr goes to the Host's log (to `--log-file` with
`--no-daemon`). For live TUI checks inside cmux, split a pane
(`cmux new-split right`), drive it with `cmux send`/`cmux send-key`, and read it with
`cmux read-screen --scrollback`. `cmux send` splits escape sequences, so simulate mouse
input under a private tmux server instead (`tmux -L <name> send-keys -H <bytes>`), with
`SSH_CONNECTION` set so copying goes to OSC 52 rather than your clipboard.
`--trace <file>` writes every protocol line as JSONL for `smoke`, `login` and `--no-daemon`;
through the shared Host, `--trace` has the Host write it in its `traces/` and say where. With
`smoke`, `RUST_LOG=agent_stderr=debug` shows agent stderr. Traces contain prompts and
agent output, so keep them out of the repository.

## Conformance

- `crates/acp-core/tests/conformance.rs` taps the wire between the client and the fake
  agent and must see every method in the schema crate's `AGENT_METHOD_NAMES`,
  `CLIENT_METHOD_NAMES` and `PROTOCOL_LEVEL_METHOD_NAMES`, all 11 `session/update` kinds
  and all 5 content block types; a second test checks gated methods never reach an agent
  that didn't advertise them. When the pinned schema adds a stable method, extend the fake
  agent until this passes again.
- `crates/tui/src/render_snapshots.rs` holds an insta snapshot per update kind and per
  prompt. Review changes with `cargo insta review` (or `INSTA_UPDATE=always cargo test` and
  read the diff) and commit the `.snap` files.
- Live acceptance against real adapters is opt-in and uses their logins:
  `WEAVE_LIVE_AGENTS=claude,codex cargo test -p weave-acp-core --test live_agents -- --ignored --nocapture`.
- `--trace` writes the ACP SDK trace-viewer format; view it with
  `agent-client-protocol-trace-viewer trace.jsons` from the SDK repository.

## Conventions

- Clippy denies `unwrap`/`expect` outside tests. Use one `use` line per item.
- Agent presets pin adapter versions. Bump them deliberately and re-run the
  smoke check against each one. Registry agents (`agents/src/registry.rs`) launch exactly as
  the ACP registry describes them, with the version it lists; never add per-agent fixes
  there.
- Advertise only client capabilities that are fully implemented, and gate every optional
  agent method on its capability in `acp-core` (`AgentHandle`), before anything is sent.
- Never branch on which agent is connected. Anything read beyond what ACP defines (the
  shapes of `rawInput`, title wording, thought headings) lives in `tui/src/conventions.rs`,
  with the agents that use it and a fallback to the title; `_meta` extensions are advertised
  in `clientCapabilities._meta`, as the spec asks, and handled in `acp-core`.
- URL elicitations: show the full URL and its host, default to not opening, and open only
  on explicit consent. Never fetch the URL from the client.
- Preserve credentials: agents authenticate with their own CLI logins, and this
  project never reads or stores them.
