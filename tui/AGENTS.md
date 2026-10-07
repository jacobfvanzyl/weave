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
- One session per process, using Codex's inline-viewport model: finished history
  goes to native terminal scrollback.

## Stack

Follow `openai/codex` `codex-rs/tui` for technology and structure: Rust 2024,
tokio, ratatui + crossterm, pulldown-cmark, syntect, insta/vt100 snapshot tests.
Codex is Apache-2.0; when adapting one of its modules, keep a header comment
naming the upstream path. The ACP layer is the official `agent-client-protocol`
crate, pinned exactly because 3.x is new.

| Crate | Owns |
| --- | --- |
| `crates/acp-core` | Agent launch, the ACP connection, client-side handlers, protocol trace. No UI. |
| `crates/cli` | The `weave` binary and its subcommands. |

The TUI crate arrives with milestone 2. Keep protocol behavior in `acp-core`.

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
./target/debug/weave smoke --agent claude   # or codex, gemini, or `-- <command>`
```

`smoke` runs one live turn against a real agent and its existing login.
`--trace <file>` writes every protocol line as JSONL, and
`RUST_LOG=agent_stderr=debug` shows agent stderr. Traces contain prompts and
agent output, so keep them out of the repository.

## Conventions

- Clippy denies `unwrap`/`expect` outside tests. Use one `use` line per item.
- Agent presets pin adapter versions. Bump them deliberately and re-run the
  smoke check against each one.
- Advertise only client capabilities that are fully implemented.
- Preserve credentials: agents authenticate with their own CLI logins, and this
  project never reads or stores them.
