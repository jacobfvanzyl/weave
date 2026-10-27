# Weave

This repository holds the weave Host, its clients (the `weave` CLI and TUI, and the app for iPad and iPhone), and an independent trackpad project. Earlier iterations (Portal, Alpha, the product protocol and their experiments) were retired in ADR 0014 and are recoverable from Git at commit `e30f6e93`; ADR 0015 brought Alpha back as the app.

| Path | Ownership |
| --- | --- |
| `protocol/` | The Host protocol (`weave-host-protocol`): wire types, roles, error codes and versions, with golden snapshots, the JSON Schema the app's TypeScript comes from (`tests/schema.rs`, feature `schema`), and the permission policy. No I/O. Specs in `docs/specs/`. |
| `host/` | The weave Host (`weave-host`, run as `weave daemon`): client connections, open sessions and their agents, journals, permission policies, headless runs, the Host MCP server and its bridge, and the WebSocket and paired devices of remote clients. No UI. Read `host/AGENTS.md`. |
| `agents/` | Which agents there are and how to launch them (`weave-agents`): config, presets, the ACP registry, the login shell's environment, `weave update`. Read `agents/AGENTS.md`. |
| `acp-core/` | ACP (`weave-acp-core`): agent launch, the ACP connection, client-side handlers, protocol trace. No UI. Read `acp-core/AGENTS.md`. |
| `host-client/` | A Rust client of the Host (`weave-host-client`): hello, typed requests, the Host's messages in order, opening sessions; and a remote client's WebSocket and device credentials. |
| `cli/` | The `weave` binary and its subcommands (`weave-cli`), Host autostart and its launchd and systemd services included. Read `cli/AGENTS.md`. |
| `tui/` | The interactive terminal client (`weave-tui`): fullscreen transcript or inline viewport, chat state, composer. Read `tui/AGENTS.md`. |
| `fake-agent/` | A scripted ACP agent (`weave-fake-agent`) for tests and live runs. Read `fake-agent/AGENTS.md`. |
| `holder/` | The holder (`weave-holder`, ADR 0022): keeps one terminal's PTY, shell and screen alive for the Host, with libghostty-vt, which it builds with Zig at the commit `ghostty.toml` pins. Read `holder/AGENTS.md`. |
| `app/` | The weave app: a React and Capacitor client of the weave Host for iPad and iPhone; WVE-91. Read `app/AGENTS.md` before working in it. |
| `trackpad/` | Independent native iPhone/iPad trackpad and Mac companion; WVE-81. Read `trackpad/AGENTS.md` before working in it. |
| `scripts/` | `update-hosts`: rebuild weave in release and restart the installed Host, here and on the person's other computers over SSH. |
| `docs/adr/` | Decisions, from ADR 0008 on. |
| `docs/specs/` | The Host protocol (WVE-85) and remote clients (WVE-90). |
| `docs/research/` | Dated research: evidence, not implementation requirements. |
| `docs/agents/` | Tracker and domain guidance. |
| `.agents/tools/linear/` | Deliberately isolated, pinned tracker CLI. |

Preserve credentials, Host state, unrelated dirty work, and remote deployments. Do not commit secrets or edit installed dependencies directly. Repository cleanup is not remote deployment teardown. Before Docker work, check memory and verify the preferred explicit context; do not assume local Docker.

Issues use Personal Linear workspace `jacobfvanzyl`, team WVE, and the pinned CLI in `docs/agents/issue-tracker.md`; install it with Bun 1.3.14 (`bun install --cwd .agents/tools/linear --frozen-lockfile`). Follow `docs/agents/triage-labels.md` and use the canonical tracker state for task titles. Tracked implementation needs an issue association. Domain vocabulary lives in `CONTEXT.md`; read `docs/agents/domain.md` and relevant ADRs before changing it.

## The Rust workspace

The Rust crates form one Cargo workspace at the repository root (`Cargo.toml`), which builds
`weave`, a standalone terminal client for ACP agents (Claude, Codex, Gemini or any ACP command),
and the weave Host it connects to. Work is tracked in WVE issues: read the live issue before
implementation. Each crate's own guide is the `AGENTS.md` in its directory.

### Boundaries

- weave speaks ACP v1 stable and implements it completely. Two unstable RFDs are in scope
  too, each advertised by default and withheld per agent: session compaction (Preview;
  `unstable_session_compaction`, `compaction = false`) and subagent sessions (draft;
  `unstable_subagents`, `subagents = false`). A third, MCP-over-ACP (draft;
  `unstable_mcp_over_acp`), carries the Host MCP server to agents that advertise
  `mcpCapabilities.acp`. The v2 draft and other unstable RFDs stay out of scope unless the
  issue changes.
- weave launches agents locally.
- Agents run in the weave Host (WVE-83, WVE-85; `weave daemon`), a per-user process the CLI
  starts on first use or launchd or systemd keeps running, so sessions outlive the TUI: quitting,
  crashing or rebuilding it and reattaching (`--resume`, `--continue`) finds the session,
  mid-turn if a turn is running. ACP runs only between the Host and its agents, one process
  per open session. Clients speak the Host protocol (`docs/adr/0008-weave-daemon-is-the-host.md`,
  spec `docs/specs/wve-85-host-protocol.md`, types in `protocol/`), which carries ACP's
  content as its payload. `--no-daemon` (`[daemon] enabled = false`) runs the same Host
  in-process, so there is one code path. `smoke`, `login` and `logout` talk to agents
  directly. Triggers (schedules, webhooks) are planned separately; `Daemon::run` and the
  `PermissionPolicy` are what they will call. Domain terms are in `CONTEXT.md`.

### Stack

Follow `openai/codex` `codex-rs/tui` for technology and structure: Rust 2024,
tokio, ratatui + crossterm, pulldown-cmark, syntect, insta/vt100 snapshot tests.
Codex is Apache-2.0; when adapting one of its modules, keep a header comment
naming the upstream path. The ACP layer is the official `agent-client-protocol`
crate, pinned exactly because 3.x is new.

### SDK rules

The SDK runs one dispatch loop per connection, and `on_receive_*` handlers run
inside it. Never await a peer response (`block_task`) inside a handler, because
that deadlocks. Forward work to the event channel or `cx.spawn` it. Requests
whose completion must stay ordered with session updates use
`on_receiving_result`, as `AgentConnection::prompt` does.

### Commands

Run from the repository root. `rust-toolchain.toml` pins 1.95.0. With Homebrew's rustup,
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

`weave-holder`, which keeps the Host's terminals (ADR 0022), builds with the rest. Its first
build on a computer fetches the pinned Ghostty with git and builds libghostty-vt into
`~/.cache/weave/ghostty`, once per pin, which needs the network and takes a couple of minutes.
Unless `$ZIG` or `PATH` has the pinned Zig, it downloads that first. See `holder/AGENTS.md`. The
Host offers terminals only when `weave-holder` sits beside its own binary.

`scripts/update-hosts [--now] [--here | --hosts-only] [HOST...]` rebuilds the release here,
`weave-holder` included, and restarts the Host (`~/.local/bin/weave` points at
`target/release/weave`, beside the holder), then copies this working tree to the hosts in
`$WEAVE_HOSTS` over SSH, builds it there in `~/.cache/weave/build`, installs rustup first if
needed, and restarts that Host too. Named HOSTs are the only ones it updates, this computer too
with `--here`; `--hosts-only` leaves this one alone.

Keep only the latest debug build in `target/debug`, which otherwise grows with every rebuild
and can fill the disk: clear `target/debug/incremental` (old incremental sessions pile up
there, gigabytes at a time) when done building, and when it still holds artifacts of earlier
dependency or profile settings, `cargo clean --profile dev` and build again. Never remove
`target/release`: an installed `weave` (`~/.local/bin/weave`) may be a symlink to
`target/release/weave`, so rebuild it with `cargo build --release` instead, and plain
`cargo clean` removes it too.

The workspace also builds and passes its tests on Linux, x86_64 and aarch64 (WVE-116), where the
Host runs as a systemd user service. There's no CI, so check changes to platform code there, in
Docker on the context memory names (never assume local Docker), with the working tree piped in
and named volumes for the registry and `target/`; `--platform linux/arm64` runs the same on
aarch64 where the engine emulates it:

```bash
git ls-files -z -co --exclude-standard -- . ':!app' ':!trackpad' \
  | COPYFILE_DISABLE=1 tar --no-mac-metadata --no-xattrs --null -T - -czf - \
  | docker --context <context> run --rm -i -e CARGO_TARGET_DIR=/target \
      -e WEAVE_GHOSTTY_CACHE=/target/ghostty \
      -v weave-linux-cargo:/usr/local/cargo/registry -v weave-linux-target:/target \
      rust:1.95-trixie sh -c 'apt-get update -qq && apt-get install -y -qq cmake clang git \
        && mkdir /src && tar xzf - -C /src && cd /src \
        && cargo test && cargo clippy --all-targets'
```

Under that emulation two `host/tests/remote.rs` tests with 100–200 ms deadlines time out; for
aarch64 proper, a lima VM on Apple silicon runs natively (`limactl start --vm-type=vz
template:debian-13`, `LIMA_HOME` on the External disk and `.mounts=[]`, then the same commands
with `cargo test -j 3` in 6 GiB, and `limactl delete` after).

The service itself needs systemd as PID 1 and a login over SSH: an Ubuntu or Debian image with
`systemd`, `libpam-systemd`, `dbus-user-session` and `openssh-server`, run with
`--cgroupns=private --security-opt writable-cgroups=true --tmpfs /run --tmpfs /run/lock` (no
`--privileged`) and `/sbin/init`, then `ssh <user>@localhost weave daemon install` inside it.

### Conformance

- `acp-core/tests/conformance.rs` taps the wire between the client and the fake
  agent and must see every method in the schema crate's `AGENT_METHOD_NAMES`,
  `CLIENT_METHOD_NAMES` and `PROTOCOL_LEVEL_METHOD_NAMES`, all 11 `session/update` kinds
  and all 5 content block types; a second test checks gated methods never reach an agent
  that didn't advertise them. When the pinned schema adds a stable method, extend the fake
  agent until this passes again.
- `tui/src/render_snapshots.rs` holds an insta snapshot per update kind and per
  prompt. Review changes with `cargo insta review` (or `INSTA_UPDATE=always cargo test` and
  read the diff) and commit the `.snap` files.
- Live acceptance against real adapters is opt-in and uses their logins:
  `WEAVE_LIVE_AGENTS=claude,codex cargo test -p weave-acp-core --test live_agents -- --ignored --nocapture`.
- `--trace` writes the ACP SDK trace-viewer format; view it with
  `agent-client-protocol-trace-viewer trace.jsons` from the SDK repository.

### Conventions

- Clippy denies `unwrap`/`expect` outside tests. Use one `use` line per item.
- Never branch on which agent is connected. Anything read beyond what ACP defines (the
  shapes of `rawInput`, title wording, thought headings) lives in `tui/src/conventions.rs`,
  with the agents that use it and a fallback to the title; `_meta` extensions are advertised
  in `clientCapabilities._meta`, as the spec asks, and handled in `acp-core`.
- URL elicitations: show the full URL and its host, default to not opening, and open only
  on explicit consent. Never fetch the URL from the client.
- Preserve credentials: agents authenticate with their own CLI logins, and this
  project never reads or stores them.
