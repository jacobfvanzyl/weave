# cli

The `weave` binary and its subcommands (`weave-cli`), Host autostart and the launchd and systemd
services included. Read the root `AGENTS.md` first; its Commands section builds and runs it.

Each top-level command is a module of `src/commands/`, named for what the person manages
(`threads`, `agents`, `daemon`, …), with its arguments, its `command` and `LOG`, the level it logs
to stderr at by default; `main.rs` holds the TUI's command line and one line per command. What
several commands use stays in `src/`: reaching the Host (`host.rs`) and the Dispatcher
(`dispatcher.rs`), the argument groups (`args.rs`), waiting for a turn (`turn.rs`), exit statuses
(`exit.rs`), services (`service.rs`), starting a server in the background (`background.rs`) and
SSH (`ssh.rs`). A command uses another's module only for what's that command's own, as `hosts`
reads what `pair --json` prints. `src/snapshots/` holds every command's `--help` (`main.rs`'s
`every_command_says_what_it_does`), so a change to the command line shows in review: run
`INSTA_UPDATE=always cargo test -p weave-cli --bin weave` and read the diff.

A command that manages a kind of thing (`threads`, `agents`, `schedules`, `hosts`, `devices`)
lists them when given no subcommand, as `list` does; `daemon` and `dispatcher` say how they are,
as `status` does. Commands keep the names they had before WVE-188 as hidden ones, since some are
in what other programs say and run: `weave login` and `logout` (`agents login` and `logout`),
which Hosts' sign-in errors and the app's messages gave; and `weave terminal` (`terminals`),
which panes the TUI opened in Rex run. `weave sessions` no longer runs `threads`: "session" names
ADR 0031's Sessions (WVE-200). `main.rs`'s
`commands_answer_to_their_earlier_names` keeps them parsing; a rename adds one there.

Clients name agents by id, so `-- <command>` works only with `--no-daemon` (the in-process
Host is given it as agent `command`); for the shared Host, define the agent under
`[agents.<id>]`, as `[agents.fake] command = "…/weave-fake-agent"`. Likewise `--no-fs` and
`--no-terminal` apply in-process; for the shared Host set `fs`/`terminal` under the agent.
`--resume [ID]` opens a thread (or the picker, also on Ctrl+R in the TUI), `--continue` the
latest one here (of the agent last used here, `cli/src/recent.rs`, unless `--agent` or `--`
names one), and `--add-dir` adds workspace roots. Ctrl+D on an empty composer leaves the TUI
with a turn still running in the Host. `weave agents login` and `logout` manage sign-in
directly; when the agent answers `auth_required` at startup, `weave` offers its methods and
signs in through the Host (`agents/authenticate`, or `agents/terminalSignIn` and the command
run in this terminal), then retries.
Agents and MCP servers come from `~/.config/weave/config.toml` (read from `tui.toml` while only
that exists; see `../agents/src/config.rs`), whose `[tui]` and `[daemon]` are the CLI's
(`src/config.rs`), as are `[remote]`, optional overrides for remote access (port, URL,
other origins) that `weave daemon run` reads (a restart picks up a change), and `[rex]`.

`weave terminals attach <id>` (`src/commands/terminals.rs`, WVE-167) shows one of the Host's
terminals in the terminal it runs in, as the TUI's Rex panes do: the stream on the Host's `terminals.sock`,
its VT restore with history and the output to stdout through `terminals/filter.rs`, which leaves
out queries the holder answers, OSC 52, 9 and 777, and kitty graphics, byte for byte otherwise
and across chunks, and stdin back as input, read on a thread of its own so the process can exit.
While another device's size holds it draws nothing and says so, and typing takes the size back
with a `resync`. With `[rex] open_threads = true`, `weave daemon run` runs
`src/rex_threads.rs` beside the Host (ADR 0025): an in-process client that watches every thread,
connected through `Daemon::connect_beside` so it doesn't keep an idle Host running,
and gives the ones a paired device opens a tab in this computer's Rex, running `weave --resume
<id>` in the Rex session named for the thread's repository, kept in `rex-threads.json` beside the
journals.

```bash
./target/debug/weave run --approve read,edit "fix the tests" --agent <id>   # headless, in the Host
./target/debug/weave run --detach "…"     # leave it running; prints the thread id
./target/debug/weave run --continue "…"   # or --resume <id>, as the TUI names threads
./target/debug/weave threads              # open in the Host; also read, prompt, steer, cancel, close <id>
./target/debug/weave threads prompt <id> "address the review"   # or pipe it in; steer joins a running turn
./target/debug/weave threads prompt <id> --wait --timeout 10m "…"   # and wait for the reply
./target/debug/weave threads follow <id> --turn <turn>   # wait for that turn, as prompt or run --detach named it
./target/debug/weave threads watch        # every thread as it changes, as JSON lines
./target/debug/weave daemon               # its status; also start, stop, restart, run (foreground), install, uninstall
./target/debug/weave pair                 # a QR code and code another device pairs with
./target/debug/weave devices              # paired devices; also revoke <id>
./target/debug/weave agents update --dry-run   # newer agent adapters; without --dry-run, check and use them
./target/debug/weave worktrees install-hook    # have worktrunk ask the Host before removing a worktree
./target/debug/weave dispatcher           # its status; also start, stop, restart, run, install, uninstall
./target/debug/weave dispatcher connect homelab   # pair this computer with the Dispatcher there, over SSH, and offer to have its Host join
./target/debug/weave hosts add studio     # have studio's Host join the Dispatcher, over SSH
./target/debug/weave schedules            # the Dispatcher's schedules; also add, pause, run, occurrences
```

`weave threads` (`src/commands/threads.rs`) acts on any thread without attaching,
as Rex's CLI does on its blocks, so scripts and agents' shells compose threads (ADR 0023):
`read` gives how a thread lists and its latest turn on stderr and the agent's last message on
stdout (`--json` for `threads/get`; `--turn` for a turn other than the latest), `prompt` is
`queue/add`, and `steer` is `turn/steer`, failing when no turn runs. Their turns' origin is the
CLI's, a client's, so no thread hears how they end, even when an agent ran it; an agent's Host
tools do that. `list --activity` lists the threads idle, running or waiting. `watch` prints
`threads/watch` as JSON lines, and `follow` observes an open thread (`thread/attach` with
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
same turn; a `run` repeated after its thread closed exits as its turn went. A shared Host that
goes away is waited for, up to a minute (`turn::Link`), and the thread followed again from the
last event seen; an interrupted turn the thread continues is followed into its continuation, as
one turn (WVE-168). `follow` without a turn moves on to a thread's successor, from its start, and
`threads set-successor` names one. `threads label` adds and takes off labels, `threads list --label` and
`run --label` find and give them (WVE-173).

What a command reports, it prints with `--json` as the Host protocol's own types, so scripts
follow the protocol's versioning rather than a shape kept for the CLI: `daemon status`
(`host/status`'s `HostStatus`; nothing on stdout when the Host isn't running, and the service's
notes on stderr), `threads list` (`ThreadListing`s), `threads read` (`threads/get`), `threads
prompt` (`queue/add`, whose `queuedId` is the turn's id) and `steer` (`turn/steer`), `devices`
(`Device`s), `run --detach` (`thread/run`), and `run` and `prompt --wait`, whose thread's
journal events (`thread/event`) stream as JSON lines. CLI tests check each parses as the type it claims
(`tests/json.rs`).

The exit status tells a script how a command went (`cli/src/exit.rs`, WVE-108): 0, it worked, or
the turn ended (`end_turn`); 1, any other error; 2, arguments clap refused; 3, the weave Host
couldn't be reached: not running, for a command that never starts one (`threads read`, `daemon
status`), didn't start, or went away; 4, the turn failed, was interrupted by the Host stopping, or its thread closed under it; 5, the
turn was cancelled; 6, it stopped short otherwise (a token limit, a refusal, too many model
requests); 7, the turn waits on a person; 8, waiting timed out. `threads list` with no Host lists
none and exits 0. How the turn went is in the status on purpose, though the A2A CLI keeps a
task's outcome out of its exit codes (and uses 4 for sign-in, 5 for timeouts): scripts and agents
composing threads branch on it, and 3 alone says the Host wasn't reached. Keep it so. An error that exits other than 1
is made with `exit::fail` or `exit::unreachable`, which keep its message and causes. CLI tests
(`tests/`) run `weave` against a Host inside the test (`tests/support`), with the fake agent
in-process, whose `stop <reason>` and `fail` scripts end turns each way.

`weave worktrees pre-remove` is worktrunk's `pre-remove` hook (`src/commands/worktrees.rs`): run in the
worktree being removed, it asks a running Host for `worktrees/release` and exits non-zero while a
thread there runs a turn or waits on the person, which stops `wt remove`, `wt merge` and `wt step
prune`; with no Host running it passes. `install-hook` adds it to worktrunk's user config
(`$XDG_CONFIG_HOME/worktrunk/config.toml`, else `~/.config/worktrunk/`) only when run, leaving the
rest of the file as written.

`--resume <id>` reopens a thread with the agent and directory its journal records,
overriding `--agent` and `--cwd` (`start::choose`); the Host refuses to attach a thread to
another agent (`wrong_agent`). `threads/list` with an agent leads with the Host's threads
of that agent in the directory, open ones and then ones a stopped Host left open within the
idle grace of their last activity (its index of journals, `Registry::known`), each listing
saying its state, activity, clients and whether it's headless, which the TUI's picker shows
as badges and `--continue` uses to pass over headless runs; without an agent it lists the
Host's threads across agents. Thread state carries the thread's directory, which the TUI
adopts.

Commands share their argument groups (`cli/src/args.rs`): `AgentArgs` (which agent, its
config and trace) everywhere an agent is involved, `WorkspaceArgs` where a thread is,
`ThreadArgs` (`--resume`, `--continue`) where one is reopened, and `ApproveArgs`
(`--approve <kinds>|all`, the rest rejected, through `acp-core`'s `PermissionPolicy`) where a
turn runs headless. `weave run --mode` starts its new thread in a mode other than the agent's
configured one, which otherwise applies and may approve for itself what `--approve` doesn't
(ADR 0026); the Host's notices, such as a tool the policy rejected and the `--approve` for it,
go to stderr as they come. Prompts are positional, before the `--` agent command.

`weave daemon install` runs the Host as a service from the binary it's run from
(`cli/src/service.rs`, which picks the manager): a launchd user agent on macOS
(`service/launchd.rs`), whose binary can't be in `~/Documents`, `~/Desktop` or `~/Downloads`
(macOS keeps launchd's processes out of them; install a copy such as `~/.local/bin/weave`), and
a systemd user service on Linux (`service/systemd.rs`, `weave-host.service`), which turns
lingering on so the Host runs from boot and after the person logs out of SSH. While it's
installed, clients never start a Host and `start`/`stop`/`restart` use `launchctl` or `systemctl
--user` (a restart is one systemd job, so an agent inside the Host can ask for it); `uninstall`
removes it. `weave daemon stop` and `restart` drain the Host first (`host::drain`,
`host/drain`): they say how many turns they wait for and wait up to 5 minutes, unless `--now`
or Ctrl+C; run by an agent, they leave its own turn out (`WEAVE_AGENT_PROCESS`), and they keep
the drain's connection open until the Host has stopped. `weave daemon run` drains on its first
SIGTERM or SIGINT and stops at once on a second; the systemd unit gives it 330 seconds.
`weave daemon status` adds what may stop a systemd service running when expected
(`service::notes`: lingering off, a user manager given less time to stop than the unit). A Linux
Host is set up over SSH, with no terminal needed but for an agent's own sign-in (`ssh -t host
weave agents login --agent claude`, which prints a code to paste); `weave pair` there needs
`sudo tailscale set --operator=$USER` once, and says so. A command run over SSH without a
terminal doesn't read `~/.profile` on Debian or Ubuntu, so `ssh host weave …` finds weave only on
the system's `PATH`: link it into `/usr/local/bin`, or name it by path. On macOS, zsh reads only
`~/.zshenv` for it, so put `~/.local/bin` on `PATH` there. `daemon install`, and `daemon status`
with a service installed, say so when the login shell, run as sshd runs a command, doesn't find
weave (`service::ssh_note`). With no terminal nothing prompts: `weave agents login` then needs
`--method`, and names the methods, and a sign-in that runs in a terminal says to use `ssh -t`. `weave daemon restart` picks up a rebuilt binary (the TUI needs no restart, as long as
`weave_host_protocol::PROTOCOL_VERSION` is one it speaks); threads it had open resume when
reattached. The Host captures the login shell's environment when it starts, so restart it
after changing your shell's. It runs that shell, an interactive one, in a session of its own
without a terminal, and a Host started in the background has a session of its own too: an
interactive shell's job control otherwise takes over the terminal that started the Host
(WVE-154). Set `WEAVE_DAEMON_DIR` to run a dev Host (socket, lock, log,
journals and traces) beside the installed one; its log is `daemon.log` there, and with
`XDG_CONFIG_HOME` it reads a config of its own. Builds without debug info
(`CARGO_PROFILE_DEV_DEBUG=0`) keep `target/` small on a full disk.

`weave dispatcher` manages the Dispatcher as `daemon` manages the Host
(`src/commands/dispatcher.rs`). Once `install` has launchd or systemd run it, `start`, `stop` and
`restart` go through the manager. Otherwise `start` runs `weave dispatcher run` in the background
(`background.rs`, logging to `dispatcher.log`) and waits for it to answer, and `stop` sends SIGTERM
to whatever listens on its socket (`weave_host::socket::terminate_listener`). It keeps its work as it
goes, so stopping drains nothing. `weave hosts` and `weave schedules` ask it over its socket
(`src/dispatcher.rs`), or, when none runs here, the one this computer is paired with, over its
WebSocket (WVE-176): `weave dispatcher connect <computer>` runs `weave dispatcher pair --json`
there over SSH (`src/ssh.rs`, which `WEAVE_SSH` stands in for in tests), or takes the URL and
code, pairs with a new device key (`DeviceKey::kept`, in the Secure Enclave on a Mac that has
one) and keeps the pairing in `$XDG_STATE_HOME/weave/client` (`src/paired.rs`, 0600;
`disconnect` removes it). Then it offers to have this computer's Host join the Dispatcher
(`hosts::join_from`: a `hosts/offer` code handed to the Host's `dispatcher/join`, which `weave
hosts add` with no computer runs too, over the Dispatcher's `hosts.sock` when it runs here),
asking at a terminal unless `--host` or `--no-host` answers. `weave hosts add studio` gets a code
and runs `weave hosts add <url> <code> --json` there over SSH; `weave hosts add --code` prints a
URL and code for that on a computer SSH doesn't reach (ADR 0030, WVE-194). `$WEAVE_DISPATCHER_DIR` set means only that Dispatcher, so a dev one
never reaches the person's own. On a paired computer `run`, `start`, `restart` and `install`
refuse, and `pair` and `devices`, which only the Dispatcher's computer may ask, say where it
runs. `tests/dispatcher.rs` pairs `weave` with a Dispatcher in the test, over a fake Serve, and
has a Host in the test join it each of those ways.

Both run against a real agent and its existing login. `--log-file <file>` captures the
TUI's diagnostics; agent stderr goes to the Host's log (to `--log-file` with
`--no-daemon`). `--trace <file>` writes every protocol line as JSONL for `smoke`, `login` and `--no-daemon`;
through the shared Host, `--trace` has the Host write it in its `traces/` and say where. With
`smoke`, `RUST_LOG=agent_stderr=debug` shows agent stderr. Traces contain prompts and
agent output, so keep them out of the repository.
