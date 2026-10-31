# cli

The `weave` binary and its subcommands (`weave-cli`), Host autostart and the launchd and systemd
services included. Read the root `AGENTS.md` first; its Commands section builds and runs it.

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
that exists; see `../agents/src/config.rs`), whose `[tui]` and `[daemon]` are the CLI's
(`src/config.rs`), as is `[remote]`, optional overrides for remote access (port, URL,
other origins) that `weave daemon run` reads (a restart picks up a change).

```bash
./target/debug/weave run --approve read,edit "fix the tests" --agent <id>   # headless, in the Host
./target/debug/weave run --detach "…"     # leave it running; prints the session id
./target/debug/weave run --continue "…"   # or --resume <id>, as the TUI names sessions
./target/debug/weave threads              # open in the Host; also read, prompt, steer, cancel, close <id>
./target/debug/weave threads prompt <id> "address the review"   # or pipe it in; steer joins a running turn
./target/debug/weave threads prompt <id> --wait --timeout 10m "…"   # and wait for the reply
./target/debug/weave threads follow <id> --turn <turn>   # wait for that turn, as prompt or run --detach named it
./target/debug/weave threads watch        # every thread as it changes, as JSON lines
./target/debug/weave daemon status        # also start, stop, restart, run (foreground), install, uninstall
./target/debug/weave pair                 # a QR code and code another device pairs with
./target/debug/weave devices              # paired devices; also revoke <id>
./target/debug/weave hosts add studio     # pair with another of your Hosts over SSH, both ways (--one-way)
./target/debug/weave hosts                # peer Hosts, and whether each can be reached; also remove
./target/debug/weave update --dry-run     # newer agent adapters; without --dry-run, check and use them
./target/debug/weave worktrees install-hook   # have worktrunk ask the Host before removing a worktree
```

`weave threads` (`cli/src/sessions.rs`; alias `sessions`) acts on any thread without attaching,
as Rex's CLI does on its blocks, so scripts and agents' shells compose threads (ADR 0023):
`read` gives how a thread lists and its latest turn on stderr and the agent's last message on
stdout (`--json` for `sessions/get`; `--turn` for a turn other than the latest), `prompt` is
`queue/add`, and `steer` is `turn/steer`, failing when no turn runs. Their turns' origin is the
CLI's, a client's, so no thread hears how they end, even when an agent ran it; an agent's Host
tools do that. `list --activity` lists the threads idle, running or waiting. `watch` prints
`sessions/watch` as JSON lines, and `follow` observes an open thread (`session/attach` with
`observe`): it isn't one of its clients, so it keeps no thread open and closes none, and prints
what happens after `--after`, or from now, as `run` prints; `--until-turn-ends` exits with that
turn's status. A turn goes by its prompt's id (the protocol's turn ids): `prompt` names it, as
`run --detach` does, and `follow --turn <id>` prints that turn from its start to its end, at once
for one that has ended; `prompt --wait` is `prompt` and then that.

Waiting for a turn (`cli/src/turn.rs`: `follow --until-turn-ends` or `--turn`, `prompt --wait`,
`run`) borrows from A2A (`docs/research/a2a-and-agents-controlling-threads.md`): it stops when
the turn waits on a person, a permission request or a question, since a script or an agent's
shell can't answer it, unless `--keep-waiting`; and at `--timeout`. Either way the turn goes on,
the thread stays open, and stderr says how to follow it again. `--key` on `prompt` and `run` is
the request key, so a retry after a dropped connection starts nothing twice and waits for the
same turn; a `run` repeated after its thread closed exits as its turn went.

What a command reports, it prints with `--json` as the Host protocol's own types, so scripts
follow the protocol's versioning rather than a shape kept for the CLI: `daemon status`
(`host/status`'s `HostStatus`; nothing on stdout when the Host isn't running, and the service's
notes on stderr), `threads list` (`SessionListing`s), `threads read` (`sessions/get`), `threads
prompt` (`queue/add`, whose `queuedId` is the turn's id) and `steer` (`turn/steer`), `devices`
(`Device`s), `run --detach` (`session/run`), and `run` and `prompt --wait`, whose thread's
journal events (`session/event`) stream as JSON lines. CLI tests check each parses as the type it claims
(`tests/json.rs`).

The exit status tells a script how a command went (`cli/src/exit.rs`, WVE-108): 0, it worked, or
the turn ended (`end_turn`); 1, any other error; 2, arguments clap refused; 3, the weave Host
couldn't be reached: not running, for a command that never starts one (`threads read`, `daemon
status`), didn't start, or went away; 4, the turn failed, or its thread closed under it; 5, the
turn was cancelled; 6, it stopped short otherwise (a token limit, a refusal, too many model
requests); 7, the turn waits on a person; 8, waiting timed out. `threads list` with no Host lists
none and exits 0. How the turn went is in the status on purpose, though the A2A CLI keeps a
task's outcome out of its exit codes (and uses 4 for sign-in, 5 for timeouts): scripts and agents
composing threads branch on it, and 3 alone says the Host wasn't reached. Keep it so. An error that exits other than 1
is made with `exit::fail` or `exit::unreachable`, which keep its message and causes. CLI tests
(`tests/`) run `weave` against a Host inside the test (`tests/support`), with the fake agent
in-process, whose `stop <reason>` and `fail` scripts end turns each way.

`weave worktrees pre-remove` is worktrunk's `pre-remove` hook (`cli/src/worktrees.rs`): run in the
worktree being removed, it asks a running Host for `worktrees/release` and exits non-zero while a
session there runs a turn or waits on the person, which stops `wt remove`, `wt merge` and `wt step
prune`; with no Host running it passes. `install-hook` adds it to worktrunk's user config
(`$XDG_CONFIG_HOME/worktrunk/config.toml`, else `~/.config/worktrunk/`) only when run, leaving the
rest of the file as written.

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

`weave daemon install` runs the Host as a service from the binary it's run from
(`cli/src/service.rs`, which picks the manager): a launchd user agent on macOS
(`service/launchd.rs`), whose binary can't be in `~/Documents`, `~/Desktop` or `~/Downloads`
(macOS keeps launchd's processes out of them; install a copy such as `~/.local/bin/weave`), and
a systemd user service on Linux (`service/systemd.rs`, `weave-host.service`), which turns
lingering on so the Host runs from boot and after the person logs out of SSH. While it's
installed, clients never start a Host and `start`/`stop`/`restart` use `launchctl` or `systemctl
--user` (a restart is one systemd job, so an agent inside the Host can ask for it); `uninstall`
removes it. `weave daemon stop` and `restart` drain the Host first (`daemon::drain`,
`host/drain`): they say how many turns they wait for and wait up to 5 minutes, unless `--now`
or Ctrl+C; run by an agent, they leave its own turn out (`WEAVE_AGENT_PROCESS`), and they keep
the drain's connection open until the Host has stopped. `weave daemon run` drains on its first
SIGTERM or SIGINT and stops at once on a second; the systemd unit gives it 330 seconds.
`weave daemon status` adds what may stop a systemd service running when expected
(`service::notes`: lingering off, a user manager given less time to stop than the unit). A Linux
Host is set up over SSH, with no terminal needed but for an agent's own sign-in (`ssh -t host
weave login --agent claude`, which prints a code to paste); `weave pair` there needs
`sudo tailscale set --operator=$USER` once, and says so. A command run over SSH without a
terminal doesn't read `~/.profile` on Debian or Ubuntu, so `ssh host weave …` finds weave only on
the system's `PATH`: link it into `/usr/local/bin`, or name it by path. On macOS, zsh reads only
`~/.zshenv` for it, so put `~/.local/bin` on `PATH` there. `daemon install`, and `daemon status`
with a service installed, say so when the login shell, run as sshd runs a command, doesn't find
weave (`service::ssh_note`). With no terminal nothing prompts: `weave login` then needs
`--method`, and names the methods, and a sign-in that runs in a terminal says to use `ssh -t`. `weave daemon restart` picks up a rebuilt binary (the TUI needs no restart, as long as
`weave_host_protocol::PROTOCOL_VERSION` is one it speaks); sessions it had open resume when
reattached. The Host captures the login shell's environment when it starts, so restart it
after changing your shell's. It runs that shell, an interactive one, in a session of its own
without a terminal, and a Host started in the background has a session of its own too: an
interactive shell's job control otherwise takes over the terminal that started the Host
(WVE-154). Set `WEAVE_DAEMON_DIR` to run a dev Host (socket, lock, log,
journals and traces) beside the installed one; its log is `daemon.log` there, and with
`XDG_CONFIG_HOME` it reads a config of its own. Builds without debug info
(`CARGO_PROFILE_DEV_DEBUG=0`) keep `target/` small on a full disk.

Both run against a real agent and its existing login. `--log-file <file>` captures the
TUI's diagnostics; agent stderr goes to the Host's log (to `--log-file` with
`--no-daemon`). `--trace <file>` writes every protocol line as JSONL for `smoke`, `login` and `--no-daemon`;
through the shared Host, `--trace` has the Host write it in its `traces/` and say where. With
`smoke`, `RUST_LOG=agent_stderr=debug` shows agent stderr. Traces contain prompts and
agent output, so keep them out of the repository.
