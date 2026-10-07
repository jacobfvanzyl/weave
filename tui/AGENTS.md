# TUI project

This directory owns `weave`, a standalone terminal client for ACP agents
(Claude, Codex, Gemini or any ACP command), tracked by WVE-82. Read the live
issue before implementation and use the repository's pinned Linear CLI and
tracker conventions from `../docs/agents/issue-tracker.md`.

## Boundaries

- It speaks ACP v1 stable and implements it completely. The v2 draft and unstable
  RFDs stay out of scope unless the issue changes.
- It launches agents locally. It has no dependency on `product/`, the Host Daemon
  or its protocol, and it is not a root Bun workspace.
- One session per process. Like Codex, it runs fullscreen by default: on the alternate
  screen, `weave` owns the transcript (`transcript.rs`: retained cells that reflow,
  scrolling, selection and copy). Inline mode (`--no-alt-screen`, `[tui]
  alternate_screen = "never"`) keeps Codex's inline viewport, with finished history in
  native terminal scrollback. Both modes must keep working.

## Stack

Follow `openai/codex` `codex-rs/tui` for technology and structure: Rust 2024,
tokio, ratatui + crossterm, pulldown-cmark, syntect, insta/vt100 snapshot tests.
Codex is Apache-2.0; when adapting one of its modules, keep a header comment
naming the upstream path. The ACP layer is the official `agent-client-protocol`
crate, pinned exactly because 3.x is new.

| Crate | Owns |
| --- | --- |
| `crates/acp-core` | Agent launch, the ACP connection, client-side handlers, protocol trace. No UI. |
| `crates/tui` | The interactive client: fullscreen transcript or inline viewport, chat state, composer. |
| `crates/cli` | The `weave` binary and its subcommands. |
| `crates/fake-agent` | A scripted ACP agent (`weave-fake-agent`) for tests and live runs. |

Keep protocol behavior in `acp-core`. Client services (`fs/*`, `terminal/*`) live there
and are advertised per `ClientOptions`; never advertise one that isn't answered. Real
adapters may not call them (Claude's runs its own tools), so the fake agent is what
exercises them: integration tests connect it in-process over `Channel::duplex`, and its
prompt scripts (`/run`, `/write`, `/read`, `/kill-after`, `/plan`, `/slow`) drive the
real TUI. In `tui`, rendering follows Codex's look: `tool_call` maps ACP tool kinds onto
Codex's cells (exec, explored, patch, MCP), `history_cell`, `markdown` and `streaming` the
rest, each with a compact and a detailed (Ctrl+T) form; `palette` probes the terminal's
colors (OSC 10/11) and `style` derives surfaces from them; `highlight` wraps syntect and
two-face; `footer` and `status` are the bottom pane. `ChatWidget` stays free of I/O: it turns
agent events, keys and mouse input into transcript cells and `AppCommand`s, so it is
tested without a terminal, in both screen modes. Terminal mechanics (`custom_terminal`, `insert_history`) are tested on a vt100
backend. Untrusted agent text reaches the terminal only after control characters are
stripped.

`acp-core` also declares and handles the terminal output extension
(`_meta.terminal_output_delta`, Zed's convention that codex-acp and claude-agent-acp use for
commands they run themselves): `terminal_meta.rs` turns its chunks and exits into the same
terminal events as client terminals, including in replayed sessions.

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
session (or the picker, also on Ctrl+R in the TUI), `--continue` the latest one here, and
`--add-dir` adds workspace roots. `weave login` and `weave logout` manage sign-in; when
the agent answers `auth_required` at startup, `weave` offers its methods and retries.
Agents and MCP servers come from `~/.config/weave/tui.toml` (see `crates/cli/src/config.rs`).

The fake agent reads `WEAVE_FAKE_AGENT_STATE` (persist sessions and sign-in to this JSON
file), `WEAVE_FAKE_AGENT_REQUIRE_AUTH=1`, and `WEAVE_FAKE_AGENT_PAGE_SIZE`. Its scripts
also include `/ask` (form elicitation), `/connect` (URL elicitation) and `/mcp`.

Both run against a real agent and its existing login. `--log-file <file>` captures
diagnostics and agent stderr in the TUI. For live TUI checks inside cmux, split a pane
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
  smoke check against each one.
- Advertise only client capabilities that are fully implemented, and gate every optional
  agent method on its capability in `acp-core` (`AgentHandle`), before anything is sent.
- URL elicitations: show the full URL and its host, default to not opening, and open only
  on explicit consent. Never fetch the URL from the client.
- Preserve credentials: agents authenticate with their own CLI logins, and this
  project never reads or stores them.
