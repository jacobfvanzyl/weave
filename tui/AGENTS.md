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
- It launches agents locally. It has no dependency on `product/`, the Host Daemon
  or its protocol, and it is not a root Bun workspace.
- Agents run in the weave daemon (WVE-83), a per-user process the CLI starts on first use,
  so sessions outlive the TUI: quitting, crashing or rebuilding it and reattaching
  (`--resume`, `--continue`) finds the session, mid-turn if a turn is running. The daemon is
  an ACP agent to its clients and an ACP client to the agents, one process per live
  session; the TUI is unchanged ACP over its socket, plus the `_weave/*` extension
  (`acp-core/src/daemon_protocol.rs`). `--no-daemon` (`[daemon] enabled = false`) runs the
  same daemon in-process, so there is one code path. `smoke`, `login` and `logout` talk to
  agents directly. Triggers (schedules, webhooks) are planned separately; `Daemon::run` and
  the `PermissionPolicy` are what they will call.
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
| `crates/acp-core` | Agent launch, the ACP connection, client-side handlers, protocol trace, the daemon's `_weave/*` extension. No UI. |
| `crates/daemon` | The weave daemon: client connections, live sessions and their agents, journals, permission policies, headless runs. No UI. |
| `crates/tui` | The interactive client: fullscreen transcript or inline viewport, chat state, composer. |
| `crates/cli` | The `weave` binary and its subcommands, daemon autostart included. |
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
(after Codex's composer Vim mode) editing the same text in the opt-in Vim composer;
`subagents` shows ACP subagents as Codex shows its own, each child session in a chat of its
own that the parent routes updates to. `ChatWidget` stays free of I/O: it turns
agent events, keys and mouse input into transcript cells and `AppCommand`s, so it is
tested without a terminal, in both screen modes. Terminal mechanics (`custom_terminal`, `insert_history`) are tested on a vt100
backend. Untrusted agent text reaches the terminal only after control characters are
stripped.

`acp-core` also declares and handles the terminal output extension
(`_meta.terminal_output_delta`, Zed's convention that codex-acp and claude-agent-acp use for
commands they run themselves): `terminal_meta.rs` turns its chunks and exits into the same
terminal events as client terminals, including in replayed sessions.

In `daemon`, `client` is one client's connection (the daemon as its agent) and `session`
the task that owns a live session: its agent, its journal (`journal`, JSONL under
`~/.local/state/weave/daemon/sessions`, 0600), the clients attached to it, its turns, and
the requests waiting on a person. Everything a session's clients are sent is journaled, so
`session/load` of a live session replays the journal and then streams live, and a restarted
daemon resumes sessions it left open. Prompts are forwarded; the other attached clients get
the prompt as `user_message_chunk` and the turn as `_weave/turn`. Permission requests and
elicitations go to every attached client until one answers; a `cancelled` permission
answer only means that client won't answer (the TUI cancels what's pending when it leaves a
session), and `session/cancel` from any client answers them all. Daemon-run terminals reach
clients as `_weave/terminal_output`/`_weave/terminal_exit`; the daemon strips agents'
`_meta` terminal output after turning it into the same events, so each chunk arrives once.
Agents start in the session's directory with the requesting client's environment
(`instance.rs`), and a client's spare agent answers `initialize`, sign-in and listing until
a session takes it. Daemon tests (`crates/daemon/tests/daemon.rs`) run in-process with fake
agents sharing one state file.

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
./target/debug/weave --agent claude         # interactive; or codex, gemini, `-- <command>`
./target/debug/weave smoke --agent claude   # one headless turn
./target/debug/weave -- ./target/debug/weave-fake-agent   # scripted agent
```

`--no-fs` and `--no-terminal` withhold those client services. `--resume [ID]` opens a
session (or the picker, also on Ctrl+R in the TUI), `--continue` the latest one here (of the
agent last used here, `cli/src/recent.rs`, unless `--agent` or `--` names one), and
`--add-dir` adds workspace roots. Ctrl+D on an empty composer leaves the TUI with a turn
still running in the daemon. `weave login` and `weave logout` manage sign-in; when
the agent answers `auth_required` at startup, `weave` offers its methods and retries.
Agents and MCP servers come from `~/.config/weave/tui.toml` (see `crates/cli/src/config.rs`).

```bash
./target/debug/weave run --approve read,edit "fix the tests" -- <agent>   # headless, in the daemon
./target/debug/weave run --detach "…"     # leave it running; prints the session id
./target/debug/weave run --continue "…"   # or --resume <id>, as the TUI names sessions
./target/debug/weave sessions             # open in the daemon; also cancel <id>, close <id>
./target/debug/weave daemon status        # also start, stop, restart, run (foreground)
```

`--resume <id>` reopens a session with the agent and directory its journal records,
overriding `--agent` and `--cwd` (`start::choose`); the daemon refuses to attach a client of
another agent. `session/list` through the daemon leads with its sessions of that agent in
the directory, open ones and then ones a stopped daemon left open (its index of journals,
`Registry::known`), and marks them in `_meta.weave` (activity, clients, headless), which the
TUI's picker shows as badges and `--continue` uses to pass over headless runs. Load and
resume answers carry the session's directory, which the TUI adopts.

Commands share their argument groups (`cli/src/args.rs`): `AgentArgs` (which agent, its
config and trace) everywhere an agent is involved, `WorkspaceArgs` where a session is,
`SessionArgs` (`--resume`, `--continue`) where one is reopened, and `ApproveArgs`
(`--approve <kinds>|all`, the rest rejected, through `acp-core`'s `PermissionPolicy`) where a
turn runs headless. Prompts are positional, before the `--` agent command.

`weave daemon restart` picks up a rebuilt binary (the TUI needs no restart, as long as
`daemon_protocol::PROTOCOL_VERSION` matches); sessions it had open resume when reattached.
Set `WEAVE_DAEMON_DIR` to run a dev daemon (socket, lock, log and journals) beside the
installed one; its log is `daemon.log` there.

The fake agent reads `WEAVE_FAKE_AGENT_STATE` (persist sessions and sign-in to this JSON
file, which its processes share and merge as an agent's own storage would),
`WEAVE_FAKE_AGENT_REQUIRE_AUTH=1`, and `WEAVE_FAKE_AGENT_PAGE_SIZE`. Its scripts
also include `/ask` (form elicitation), `/connect` (URL elicitation) and `/mcp`.

Both run against a real agent and its existing login. `--log-file <file>` captures the
TUI's diagnostics; agent stderr goes to the daemon's log (to `--log-file` with
`--no-daemon`). For live TUI checks inside cmux, split a pane
(`cmux new-split right`), drive it with `cmux send`/`cmux send-key`, and read it with
`cmux read-screen --scrollback`. `cmux send` splits escape sequences, so simulate mouse
input under a private tmux server instead (`tmux -L <name> send-keys -H <bytes>`), with
`SSH_CONNECTION` set so copying goes to OSC 52 rather than your clipboard.
`--trace <file>` writes every protocol line as JSONL, and with `smoke`,
`RUST_LOG=agent_stderr=debug` shows agent stderr. Traces contain prompts and
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
  smoke check against each one. Registry agents (`cli/src/registry.rs`) launch exactly as
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
