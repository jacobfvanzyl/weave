# Rex in place of SSH

Research snapshot, 2026-11-17. Everything here was read or run on 2026-11-17, and Rex changes daily, so each claim carries its date or its version. Sources, in order of weight: the installed software, which is `rex 0.1.0-preview.20` (commit `e33d2481`, built 2026-11-16T17:29:51Z, API revision 16) on this Mac, and `rex 0.0.1793741575-g1b6654` (built 2026-11-03, API revision 10) on the bridge Pi; Superlogical's documentation, read whole from [`llms-full.txt`](https://www.superlogical.com/rex/docs/llms-full.txt) (10,646 lines); Superlogical's [site](https://www.superlogical.com/), its one [devlog post](https://www.superlogical.com/updates/public-testing-beginning) and its apt repository's metadata; Mitchell Hashimoto's posts on Mastodon, read through the instance's public API (480 posts back to 2025-08); and GitHub's API for the `superlogical` organisation. Secondary write-ups were used only to find leads, and nothing in this note rests on one. The Rex Beta Discord and its changelog sit behind a Discord login and were not read. The demo videos were not watched. Section 10 gives the experiments and their output, and section 11 lists what was not verified. Section 9 judges the findings against this repository at `0dca9a41`.

The question is whether Superlogical's Rex can stand in for SSH yet: for a shell on another computer, for `ssh host cmd` in scripts, for copying files, for forwards, and for the tools that ride on SSH. Rex is a terminal multiplexer with a server; a *host* is a computer running a Rex server, a *session* holds *windows* (tabs) of *blocks*, and a terminal is one kind of block. The person's Mac lists two hosts, `bridge` (a Raspberry Pi 5, reached through Tailscale Serve and Rex's login server) and `bazzite` (the homelab server under its old name).

## 1. In brief

- **Not yet, and Superlogical's own documentation says so.** Rex "trusts a caller based only on how they connect today … A full authentication and authorization system is planned, including support for existing SSH keys. Until then, we recommend SSH" ([Remote Access](https://www.superlogical.com/rex/docs/linux/remote-access), read 2026-11-17). Its Linux, FreeBSD and Windows quickstarts all reach the server *over* SSH, and `rex server install ssh://…` installs Rex on another machine *through* SSH. Hashimoto wrote on 2026-09-08 that "Superlogical can actually be a full SSH replacement (I don't run SSH on my servers anymore)" ([post](https://hachyderm.io/@mitchellh/117237397684548220)); that holds for an interactive shell on a tailnet, and not for the rest of what SSH does.
- **An interactive shell works**, from Rex for Mac, with sessions that outlive the client. The CLI has no way to attach a local terminal to a remote one (`rex block stream` answers "not implemented"), so there is no `rex` equivalent of typing `ssh host` in some other terminal.
- **`ssh host cmd` is half there.** `rex -S host run --wait -- cmd` returns the command's exit status (measured: 0, 1, 42, 127). Its stdout is the new block's ID, not the command's output; the command always gets a PTY; the caller's stdin is not forwarded, so `echo x | rex run --wait -- cat` hangs. Output comes back afterwards through `rex capture`, as rendered text.
- **No file transfer in the CLI.** The server gained upload and download methods between revision 10 and 16, which the Mac app uses for drag and drop. Nothing can serve as `rsync -e` or `GIT_SSH_COMMAND`, because nothing carries a binary stdin and stdout to a remote command.
- **TCP forwards arrived**, local and remote (`rex forward new -L/-R`, "like ssh -L and ssh -R"), in preview.20. There is no dynamic (SOCKS) forward, no Unix-socket target, no agent forwarding and no X11.
- **Nothing layered on SSH can use Rex** except by forwarding a port to an sshd, which keeps SSH.
- **Auth is the network's.** A caller is whoever Tailscale, a Unix socket's peer credentials or sshd says it is. There are no keys, passwords or host keys of Rex's own; a stored host ID warns when an address leads to a different machine.
- **It moves fast.** Three API revisions seen in thirteen days (10 on 2026-11-03, 11 on 2026-11-08, 16 on 2026-11-16), twenty previews of 0.1.0, no stable release, about ten snapshot builds a day. A revision 16 client worked against a revision 10 server for everything tried except what the old server lacked.
- **For this repository:** neither `scripts/update-hosts` nor the Docker context can move to Rex today. Only the build-and-restart step of `update-hosts` could, and it would lose the streamed output.

## 2. Verdicts

| Capability | Verdict | Basis |
| --- | --- | --- |
| Interactive remote shell | Works today, from Rex for Mac only | Docs; the person's daily use; not re-tested here (section 3) |
| Persistence and reconnecting | Works today | Session made on `bridge` stayed with no client attached (section 10); docs on restarts (section 3) |
| Roaming, latency under loss | Unknown | Not measured; transport is WebSocket over TCP (section 3) |
| Terminfo | Works today | `TERM=xterm-rex` on `bridge`; `rex terminfo` (section 3) |
| `ssh host cmd`: exit status | Works today | Experiments 2–5 |
| `ssh host cmd`: stdout and stderr to the caller | Not yet | Experiment 1; only `rex capture` afterwards |
| `ssh host cmd`: stdin from the caller | Not yet | Experiment 7 hung; `rex send` types into the PTY instead |
| No-TTY execution, binary-safe streams | Not yet | Experiments 6 and 9 |
| File transfer (scp, sftp) | Partly: in the Mac app, not in the CLI | `upload_begin`, `download_begin` in revision 16 (section 5) |
| rsync, git, tar over Rex | Not yet | No stdio transport (section 5) |
| Local and remote TCP forwards | Works today in preview.20, per its help; not exercised | `rex forward --help`; `bridge` is too old to test (section 6) |
| Dynamic forward, Unix sockets, UDP | Not yet | Absent from help and from the tunnel blocks' schema |
| Agent forwarding, X11 | Not yet | No mention in help, API or docs |
| Jump hosts | Not yet in Rex; SSH's own apply to `ssh://` hosts | Section 6 |
| `docker context`, VS Code and Zed remote, Ansible, git remotes | Not yet | Each speaks the SSH protocol or needs `ssh host cmd` stdio (section 7) |
| Keys, host keys, authorization, audit | Not yet: "planned" | Docs (section 8) |
| Bootstrap of a headless server without SSH | Partly | By hand at a console or by image; Rex's own remote installer uses SSH (section 8) |
| macOS, Linux x86-64 and ARM64, FreeBSD, Windows servers | Works today, in beta | Docs; `bridge` is ARM64 |
| iOS, Linux and Windows clients | Not in public testing | [Installation](https://www.superlogical.com/rex/docs/installation) |
| Stable release, licence, source | None yet | Section 8.4 |

## 3. An interactive shell

- **The client is the Mac app.** "At the current stage of beta testing, the macOS application and the Linux and FreeBSD server are available to all testers. The Windows server is available to testers with the Windows role in Discord. We have Rex clients for iOS, Linux, and Windows at varying stages of readiness … they aren't part of testing yet" ([Installation](https://www.superlogical.com/rex/docs/installation)). The docs already carry reference pages for iOS actions and settings, and the privacy page describes TestFlight builds, so an iOS client exists outside public testing.
- **The CLI can't attach.** `rex help` in preview.20 lists `new`, `run`, `split`, `send`, `send-key`, `capture`, `wait`, `events` and `forward`, and nothing that connects the calling terminal to a remote one. `rex block stream BLOCK` is listed and answers `Error: command "rex block stream" is not implemented` (run 2026-11-17). The server API has `data.connect`, which hands out a one-time ticket for a WebSocket at `/api/data` speaking `rex.data.terminal.v1`; that protocol is not documented. So from Linux, from a terminal other than Rex, or from a script, there is no interactive shell.
- **No web client was found.** The home page says sessions "can be accessed through the web and native macOS/iOS applications", and Hashimoto called the web interface "very functional" on 2026-08-28 ([post](https://hachyderm.io/@mitchellh/117175283681274864)). The server on `bridge` answers `GET /` with 404, and no page of the docs mentions a web client.
- **Persistence.** Programs keep running on the host when the client goes; this is the product's premise and matched what was seen (section 10). A client whose connection drops stays listed as `lost` for up to 60 seconds so it can come back, and a block's owner gets it back on reconnecting ([API reference](https://www.superlogical.com/rex/docs/reference/api)). Persistence has edges: a personal server reached over SSH on Linux dies at logout unless lingering is on; upgrading the package "ends every session on a running shared server"; and a restarted server restores layouts but "the programs that were running in them don't come back today" ([Upgrading](https://www.superlogical.com/rex/docs/linux/upgrading), [Remote Access](https://www.superlogical.com/rex/docs/linux/remote-access)).
- **Latency and roaming.** The design is "a custom binary protocol where the server is maintaining N replica distributed terminal state machines" (Hashimoto, 2026-08-28, same post). It runs over a WebSocket on HTTPS, or over SSH for `ssh://` hosts, so a changed network means a new connection and a resync, not mosh's UDP roaming. Nothing first-party compares Rex with mosh. Hashimoto's comparisons with tmux are about memory and about not having to learn it ([2026-09-02](https://hachyderm.io/@mitchellh/117202903279918618), [2026-08-28](https://hachyderm.io/@mitchellh/117175343438307850)). None of this was measured here.
- **Terminfo.** Rex has its own entry, `xterm-rex`, installed by the Linux package and by `rex terminfo setup`, which also adds an ssh guard so that the name isn't sent to hosts without it; `REX_TERM=xterm-256color` turns it off. A terminal started on `bridge` reported `TERM=xterm-rex`.

## 4. One-off commands

`rex -S HOST run --wait -- COMMAND` is the nearest thing to `ssh HOST COMMAND`. Measured against `bridge` (section 10):

- **Exit status: yes.** `false` gave 1, `sh -c 'exit 42'` gave 42, a missing program gave 127. A child killed by SIGTERM gave 1, where ssh and a shell would give 143. The CLI's own failures use 1 to 4 and 130 ([The CLI](https://www.superlogical.com/rex/docs/automate/cli)), so 1 to 4 are ambiguous between Rex and the command.
- **Output: no.** `run --wait` prints the creation result (the block ID) and, on failure, `Error: exit status N`. The command's output goes to the block's terminal. `rex capture -b BLOCK --trim` reads it back once the block is kept with `--keep-open`, as rendered screen text with stdout and stderr merged. Scrollback holds about 64 MiB.
- **Stdin: no.** The caller's stdin is not connected. `printf … | rex run --wait -- cat` created the block and waited on a `cat` that never saw input. `rex send` reads stdin and *types it into the PTY*, which worked for a line of text followed by Ctrl-D, and is subject to echo and line discipline.
- **Always a TTY.** stdin, stdout and stderr were all `/dev/pts/5`, 24 by 80. There is no `-T`. Programs that change behaviour on a TTY (colour, pagers, progress bars, prompts) take their interactive path.
- **Not binary-safe.** 256 bytes written raw to the terminal came back as 509 bytes of escape sequences. 4096 random bytes survived as base64 through `capture` with a matching SHA-256, which is how the repository's bridge scripts move files through Rex ([`docs/hardware/bridge-pi.md`](../hardware/bridge-pi.md)).
- **Environment.** The command runs through the account's login shell environment, not its interactive files, unless `--interactive`; `--shell=none` skips the shell. The working directory is the home directory unless `-c` names one that exists.
- **`rex.exec` is local.** Lua's `rex.exec` and `rex.exec.start` have real stdin, stdout, stderr, exit codes and signals, but in a script run with `rex -S bridge do` they ran on the Mac (`Darwin arm64`). In a server's `init.lua` they run on that server; there is no documented way to call them remotely with streams.
- **Speed.** `rex -S bridge run --wait -- true` took 0.11 to 0.13 s over five runs, and `ssh bridge true` (Tailscale SSH, no connection sharing) 0.11 to 0.13 s over three, both on a direct tailnet path.

## 5. Files

- **The CLI has no copy command.** `rex cp`, `upload`, `download`, `get`, `put` and `sync` are all unknown commands in preview.20.
- **The server has transfer methods, new since revision 10.** `com.superlogical.terminal.download_begin` opens a regular file on the terminal's machine and returns a ticket for a `rex.data.bytes.v1` stream; `upload_begin` reserves a file, and "once every file of the batch has arrived, the terminal types their paths as if the user had pasted them" (`rex api describe`, revision 16). `list_dir` lists directories. They are shaped for the app: Hashimoto's 2026-11-16 demo is of "magical and automatic remote copy/paste, drag/drop, and port forwarding" ([post](https://hachyderm.io/@mitchellh/117628595852925836)). Where an upload lands, and the stream's framing, are not documented. The revision 10 server on `bridge` has neither method.
- **No transport for other tools.** `rsync -e`, `GIT_SSH_COMMAND`, `scp`, `sftp` and `tar | ssh` all need a program that takes a host and a command and connects binary stdin and stdout to it. Section 4 shows Rex has none. `rex __internal dial-stdio` exists but only joins stdio to the Rex server on its own machine; it is the far end of Rex's `ssh://` transport.
- **What works today** is what `bridge` already does: files over Tailscale SSH with rsync, or base64 in chunks through `rex send` and `capture`, which the repository's note puts at about one fifteenth of rsync's speed.

## 6. Forwards

- **Local and remote TCP.** `rex forward new (-L|-R) [bind_address:]port:host:hostport`, in the syntax of ssh; `rex forward open` for one local forward, which can target a terminal block and finds the port its program listens on; `rex forward share` for one remote forward; `ls` and `close`. Each forward is a tunnel block (`com.superlogical.tunnel.dial` or `.listen`) in a session. The command runs in the foreground, reconnects when the server connection drops, and resets the TCP connections that were open ([CLI reference](https://www.superlogical.com/rex/docs/reference/cli)). The Mac and iOS apps list forwards under Remote Hosts.
- **Not exercised here.** `bridge` runs revision 10, which has no tunnel blocks: `forward new -L 0:localhost:22` failed with `block flavor not found: "com.superlogical.tunnel.dial" (status=404 code=not_found)` and left nothing behind. The local server was left alone.
- **Missing.** No `-D`. The dial tunnel's options are `host` and `port` only, so no Unix-socket target such as `/var/run/docker.sock`. TCP only. Nothing forwards an SSH agent or X11, and neither the help, the API list nor the docs mention them.
- **Jump hosts.** A Rex host is one server; there is no relay through one host to another. `ssh://` hosts use the system `ssh` with "your own keys, agents, config", so a `ProxyJump` in `~/.ssh/config` should apply, and `rex terminfo host install` passes `-- -J jump.example.com` on to ssh. A Lua script can call several hosts in one run with `rex.server(LABEL)`.
- **A forward to port 22 is SSH again.** `-L 2222:localhost:22` would carry ssh, rsync, git and Docker to a host reachable only through Rex, but it needs sshd and its keys on the far side.

## 7. Tools layered on SSH

| Tool | Needs | Over Rex |
| --- | --- | --- |
| `docker context` with `ssh://` | `ssh host docker system dial-stdio`, binary stdio | No. A forward can't reach the Unix socket; it could reach a dockerd listening on TCP |
| VS Code Remote-SSH, Zed remote | An SSH connection that uploads and runs a server and tunnels to it | No |
| Ansible | SSH, or a connection plugin with exec and file copy | No plugin, and no exec with streams to build one on |
| git remotes | `git-upload-pack` over stdio | No |
| rsync, scp, sftp | stdio or the SFTP subsystem | No |

## 8. Trust, platforms and stability

### 8.1 Who gets in

- **Identity comes from the listener.** A Unix socket gives the peer's uid; a `tailnet-serve://` or `tailnet://` listener asks the machine's tailscaled who is calling; built-in Tailscale (`--tailscale`) makes the server its own tailnet device; `ssh://` leaves it to sshd; plain HTTP identifies nobody and is refused without `--allow-anonymous`, after which "every connection then has full access" ([Remote Access](https://www.superlogical.com/rex/docs/linux/remote-access)). `rex -S bridge whoami` reported the Tailscale login "over tailscale via tailnet-serve/login-server … acting as bridge".
- **Three server modes** on Linux and FreeBSD: a personal server as your account; a shared server as the `rex` account, where "anyone in the group can see and type into every session"; and the login server, a root service that maps callers to operating-system accounts through `/etc/rex/accounts.jsonc` and PAM. "The login server is the most similar to SSH … Unlike SSH, it has no passwords or keys. It identifies people only by how they connect" ([Server Modes](https://www.superlogical.com/rex/docs/linux/server-modes), [Login Server](https://www.superlogical.com/rex/docs/linux/login-server)). The accounts file ships empty and admits nobody. Windows has the personal server only.
- **Authorization is all or nothing per account.** "A connection to a server can do anything that server can, including starting programs as its account." The accounts file decides which accounts a principal may use (a Tailscale login, a tag, a local uid, `identified`, `anonymous`); there is nothing finer, such as forced commands or read-only access.
- **Host identity.** Over Tailscale Serve the server presents the tailnet's Let's Encrypt certificate (`bridge`: issued 2026-11-04). `rex home set` and `rex hosts check` keep the server's host ID and say "when the address now leads to a different machine than the one you added". That is a warning, not a pinned key.
- **Reach.** Servers listen only locally by default. Remote reach is a tailnet, another VPN with anonymous access, or SSH. Nothing is meant for the public internet. Superlogical runs no relay and needs no account ([Privacy](https://www.superlogical.com/rex/docs/reference/privacy)).
- **Audit.** `rex client ls` shows each connected client's principal, and the login server logs to the journal. No record of commands run was found.

### 8.2 Setting up a headless Linux server

- **Install:** one binary, `/usr/bin/rex`, from Superlogical's apt, dnf, zypper, pacman or apk repository, Nix, or a tarball; glibc 2.26 or musl; x86-64 and ARM64 ([Installing on Linux](https://www.superlogical.com/rex/docs/linux/installation)). `rex server install` enables a systemd user unit and lingering without sudo.
- **The documented quickstart needs SSH**: install, `rex server install`, check `ssh alice@build rex version`, then `rex -S ssh://alice@build ls`. `rex server install ssh://[USER@]HOST` does all of it from the client, by running the installer on the other machine through ssh.
- **Without SSH** it takes a console, an image or configuration management: install the package, then either `rex server start --tailscale --tailscale-auth-key-file FILE` (no Tailscale needed on the machine), or the login server behind `tailscale serve`, as `bridge` has. Both need root or a shell once. After that, upgrades come through the package manager.
- **Service management:** systemd units and socket activation on Linux, OpenRC on Alpine, rc.d on FreeBSD, a Windows Service on Windows. On macOS, `rex server install` does not apply ("Linux with systemd and Windows are supported so far"); the Mac app runs its own server.

### 8.3 Versions and compatibility

- **Installed here:** preview.20, in the app bundle (app version 0.1.0, build 2003) and in `RexServer/Versions/Current` and `Versions/2003`; all three binaries report the same commit. A leftover `.staging-…` directory holds `0.0.1794111130-g9bcf6a` (2026-11-08, revision 11), the build that was current until the app updated itself this morning. Rex for Mac checks for updates at launch and daily, and that can't be turned off.
- **Latest published:** the apt `preview` suite's newest package is `0.1.0~preview.20` (suite dated 2026-11-16 17:44 UTC), so this Mac is current. The `snapshot` suite's newest is `0.0.1794889599-g8c9ba1` (2026-11-17 04:26 UTC); it keeps twenty builds, the oldest from 2026-11-15 04:58 UTC. There is no `stable` suite: "Tagged releases (none right now)".
- **Mismatched versions.** "Rex for Mac and the server don't need to be the same version, and either one can be newer. A newer client can't use features an older server doesn't have … If the two are too far apart to work together at all, the server refuses the connection" ([Upgrading](https://www.superlogical.com/rex/docs/linux/upgrading)). `rex version` prints "api: revision 16 (supports 0 to 16)". Against the revision 10 server on `bridge`, the revision 16 client ran `new`, `run --wait`, `send`, `capture`, `wait`, `block call`, `api list` and `kill` without complaint. `forward` failed with a clear `not_found`. `rex -S ssh://bridge ls` failed with a bare `EOF`, because that build has no `__internal dial-stdio`; only `-v` showed why.
- **`bridge` is two weeks behind** because its package hasn't been upgraded since 2026-11-03: "The server never checks for updates itself" ([Privacy](https://www.superlogical.com/rex/docs/reference/privacy)). Its apt source is the `snapshot` suite, and snapshot versions sort below every preview, so moving it to a preview means changing the suite.

### 8.4 Licence, source, price, roadmap

- **Price:** "Rex is and will always be free. You do not need to create an account. You can fully self-host your Rex servers on any platform … the Rex clients and servers themselves are not going to be directly monetized" ([devlog](https://www.superlogical.com/updates/public-testing-beginning), 2026-10-05). The commercial plan is to be shared "prior to the stable public release".
- **Source and licence:** none published. The `superlogical` GitHub organisation (created 2026-03-28) has no public repositories. The site's sign-up mentions "any OSS releases along the way". libghostty, which Rex builds on, is MIT ([Hashimoto](https://mitchellh.com/writing/superlogical)). No licence text for Rex was found in the docs or the bundle.
- **Stated roadmap bearing on SSH:** authentication and authorization with SSH keys (docs, above); hosts syncing to the GUI ("`rex hosts` today is CLI-only … This will change"); and the company's third step, "make it safe and operable in production" ([site](https://www.superlogical.com/)). No dates.
- **Rex against SSH, in their words:** the 2026-09-08 post above; "Our goal with Superlogical and Rex is for everything to feel local" (2026-11-16); and the docs' recommendation of SSH as the way in until Rex has authentication of its own.

## 9. This repository

**`scripts/update-hosts`** makes two ssh calls per host ([`scripts/update-hosts`](../../scripts/update-hosts), `update_host`):

1. `git ls-files … | tar … -czf - | ssh "$host" "rm -rf … && mkdir -p … && tar xzf - -C …"` pipes a gzip stream into a remote command. Rex can't carry it: no stdin, and the PTY is not binary-safe. The substitutes are base64 in chunks (slow, and the working tree less the app is far larger than the few kilobytes that suits), the upload API (no CLI, undocumented stream), or `rex forward -L` to the host's sshd, which is SSH.
2. `ssh -t "$host" "bash …/update-hosts --here-only …"` builds, installs and restarts. `rex -S host run --wait --keep-open -- bash …` could do this today: the exit status comes back and the build survives a dropped connection, which ssh's does not. The caller would see no output until it captured the block, and Ctrl-C would not reach the build; the person could watch it in Rex instead.

The script also installs rustup over the same connection on a host without it, which is step 2 again. So Rex could carry step 2 only, and step 1 keeps SSH on every host, which leaves nothing to gain from splitting them.

**Docker checks on a remote context** (`AGENTS.md`, "The Rust workspace"): the `bazzite` context is `ssh://admin@bazzite`, which runs `docker system dial-stdio` over ssh, and the documented check pipes the working tree as a tarball into `docker run -i`. Both need binary stdio. A Rex forward can't target the Docker socket. Rex can't carry this.

**What Rex already carries here:** commands on `bridge`, where the person can watch them, with files over Tailscale SSH (`docs/hardware/bridge-pi.md`). That split matches the findings above.

**`bazzite` is unreachable by its stored label**: its endpoint is the homelab server's old name, which no longer resolves (`rex hosts check`: "not reachable from here … name does not resolve"). Nothing was run there, and the host entry was not changed.

## 10. Experiments

All on 2026-11-17, from this Mac (client preview.20, revision 16) to `bridge` (server `0.0.1793741575-g1b6654`, revision 10, account `bridge`), in a session made for the purpose, `weave-rex-ssh-probe`.

| # | Command (after `rex -S bridge …`) | Result |
| --- | --- | --- |
| 1 | `run -s S --wait --focus=false -- echo PROBE-HELLO` | exit 0; stdout was `block:01a1e7fa-7eef-…`, not `PROBE-HELLO`; 0.12 s |
| 2 | `run … --wait -- false` | exit 1; stderr `Error: exit status 1` |
| 3 | `run … --wait -- sh -c 'exit 42'` | exit 42 |
| 4 | `run … --wait -- /nonexistent/prog` | exit 127; `Error: exit status 127` |
| 5 | `run … --wait -- sh -c 'kill -TERM $$'` | exit 1 |
| 6 | `run … --wait --keep-open -- sh -c 'tty; test -t 0 …; echo TERM=$TERM; …; stty size; uname -srm'`, then `capture --trim` | `/dev/pts/5`, `stdin-is-tty`, `stdout-is-tty`, `stderr-is-tty`, `TERM=xterm-rex`, `user=bridge pwd=/home/bridge`, `REX_BLOCK=set SSH_CONNECTION=unset`, `to-stderr`, `24 80`, `Linux 6.18.50+rpt-rpi-2712 aarch64` |
| 7 | `printf 'PROBE-STDIN\n' \| rex -S bridge run … --wait --keep-open -- cat` | Hung until killed after two minutes; capture was empty; `block call process` showed `cat` running with `last_exit: null` |
| 7b | `printf 'PROBE-VIA-SEND\n' \| rex -S bridge send -b B`, then `send -b B $'\004'`, `wait B --for 5s`, `capture` | send exit 0, wait exit 0; capture showed `PROBE-VIA-SEND` twice (the echo and `cat`'s output) |
| 8 | `run … --wait --keep-open -- sh -c 'head -c 4096 /dev/urandom > $d/blob; sha256sum …; base64 -w 76 $d/blob; rm -rf $d'`, `capture --trim`, decoded locally | 4096 bytes back; SHA-256 `452c48d2…2aea1a` on both sides |
| 9 | `run … -- sh -c '<print bytes 0..255 raw>'`, then `capture --format=vt` | 509 bytes back from 256 sent |
| 10 | `do -e 'local r = rex.exec{"uname","-sm"}; return r.stdout'` | `"Darwin arm64\n"`: it ran on the Mac |
| 11 | `block stream BLOCK` | `Error: command "rex block stream" is not implemented` |
| 12 | `forward new -s S -L 0:localhost:22` | `block flavor not found: "com.superlogical.tunnel.dial" (status=404 code=not_found)`, exit 1; `forward ls -A` empty afterwards |
| 13 | `run … --wait -- true`, five times; `ls`, three times | 0.11, 0.11, 0.11, 0.13, 0.11 s; 0.08, 0.08, 0.07 s |
| 14 | `ssh -o BatchMode=yes bridge true`, three times; `ssh bridge 'echo out; echo err >&2; exit 7'` | 0.12, 0.11, 0.13 s; exit 7, stdout `out`, stderr `err` |
| 15 | `rex -S ssh://bridge ls` | `…failed to send handshake request: Get "http://rex/api/control": EOF`; with `-v`, "ssh host did not report its socket, using dial-stdio"; the remote `rex __internal --help` has no `dial-stdio` |

Read-only, same day: `rex version`, `rex help` and `--help` for every command cited; `rex api list` on both servers (revision 16 adds `download_begin`, `upload_begin`, `ports` and `tunnel.info` to revision 10's list, and removes nothing); `rex api describe` of the two transfer methods; `rex block types --json`; `rex hosts`, `rex hosts check`, `rex whoami`, `rex skill show`; `GET /` and `/api/control` on `bridge` (404 and 426).

Afterwards the session was killed (`rex -S bridge kill weave-rex-ssh-probe`), and `rex -S bridge ls`, `forward ls -A`, a search for the temporary directory and for stray `cat` processes all came back empty. Nothing was left on `bridge`. Nothing was created on the local server or on the homelab server, and no Rex host, home, login or config was changed.

## 11. Not verified

- **The interactive shell itself**: latency, behaviour on a lossy or changing network, reconnect time, and the iOS client. These need the Mac app and a person; nothing here measured them.
- **Forwards**, in practice. `bridge`'s server predates them, and the local server holds the person's sessions. Their behaviour is as preview.20's help describes it.
- **Uploads and downloads**: the methods' schemas were read, not called. Where an uploaded file lands and the `rex.data.bytes.v1` framing are unknown.
- **The changelog.** It lives in the Rex Beta Discord and its MCP server, both behind a Discord login. When each feature shipped is inferred from three builds (2026-11-03, 2026-11-08, 2026-11-16), and the 2026-11-08 build's API was not listed.
- **Hashimoto's videos** (2026-09-08 on remote sessions and SSH, 2026-11-16 on copy, drag and drop and forwards) were not watched; only the posts' text is cited. His posts on X were not searched.
- **Windows and FreeBSD servers, the shared server, built-in Tailscale, the `tailnet://` listener and plain HTTP**: from the docs only.
- **`ssh://` transport** against a current server: it failed against `bridge` for the version reason above, and no other host was available.
- **Whether a `ProxyJump` applies to `ssh://` hosts** is inferred from the docs' statement that Rex runs the system `ssh` with its config.
- **Whether dockerd on the homelab server listens on TCP**, which would let a forward carry a Docker context without SSH. The host was unreachable through Rex and was not otherwise examined.
- **Rex's licence terms**: none were found; that is not proof that none exist for testers.
- **The Rex through-put figure** ("about 15 times" slower than rsync) is the repository's own, from 2026-11-04, and was not re-measured.
