---
status: accepted
date: 2026-10-25
---

# Each terminal lives in a holder of its own, belongs to a worktree, and is shaped so Rex can take its place

A thread in the app should be able to open terminals on the Host's computer, in panes beside it, as a code editor keeps a terminal panel beside its editor (WVE-148). The app stays chat-first (ADR 0015) and the TUI doesn't change. Who keeps such a terminal alive, what it belongs to and where it shows are three decisions. Portal took them together, in a Workspace Composition the Host owned (ADRs 0004 to 0006 at `e30f6e93`).

A holder keeps each terminal alive. A holder is a process of weave's own, one per terminal, that keeps the terminal's PTY, its shell and an authoritative libghostty-vt, and outlives the Host and every client. A crash takes only its own terminal with it. The Host starts holders outside its own process tree and finds them again by their sockets, keeping no list of its own, so a restart or update of the Host leaves every shell running.

A terminal belongs to the worktree it was opened in, or to its directory outside a repository, as a code editor's terminals belong to its folder rather than to an open file. Every thread in the worktree shows it, as a tab of its own: tabs and terminals are one to one, so a terminal opened on one device is a tab on every device, and closing its tab ends it. It remembers the thread it was opened from, which puts it in front by default, and it starts in that thread's directory.

Where a terminal shows is each device's choice (ADR 0018): which terminals sit beside which thread, and how they're arranged, is kept on the device. The Host keeps no panes or layout. It is the gateway between a device and a holder, since a paired device can reach nothing else on the Host's computer.

A program's output reaches libghostty-vt in the app unchanged:

1. The holder's libghostty-vt parses it and is the only one that answers the program's queries.
2. The Host relays the same bytes.
3. The app's libghostty-vt parses them again and answers nothing, and the app draws them.

An attach starts from a libghostty snapshot, the visible screen first and its history after. When the holder and the app run different versions of libghostty-vt, it starts instead from the formatter's VT of the visible screen, since the snapshot format makes no promise across versions.

The holder starts its shell as Ghostty does: a login shell in the agents' environment, `TERM=xterm-ghostty` with Ghostty's terminfo, and Ghostty's shell integration always injected. The holder therefore knows the shell's directory (OSC 7) and where each command starts and ends (OSC 133). Output may act on the device that shows it, as Ghostty lets it: clipboard writes (OSC 52) and notifications (OSC 9 and OSC 777) reach the device, and clipboard reads are refused.

The holder's interface is Rex's block model as Rex documents it:

- a permanent id and an optional label;
- methods that format the screen as text or VT, write input, request a size, and read the directory, title, foreground process, size and program status (OSC 7501);
- the events Rex names for a terminal: its program exiting, and changes of directory, title, foreground process and program status, as well as bells, notifications, progress and clipboard writes.

The Host protocol's terminal methods use the same concepts and names. When Rex lets another program attach to its blocks, a Rex block can stand in for a holder behind the same seam, with a worktree's terminals as the blocks of one Rex session that no window places.

## Considered options

- **Terminals owned by threads.** A dev server outlives the conversation that started it, two threads in one worktree want the same one, and deleting a thread would kill a process.
- **Terminals owned by the Host**, in its own process or in a Terminal Service beside it as WVE-75 built. The Host restarts with every update (`scripts/update-hosts`, WVE-143). A single service for every terminal loses them all when it crashes, and Portal's needed maintenance commands for losing its owner and for incompatible updates.
- **The person's tmux**, in the `repo/branch` session they already keep per worktree. tmux parses a program's output into its own screen and draws it again, so libghostty in the app would copy tmux's emulator rather than the program, and tmux's control mode is another protocol to parse. Portal's tmux backend leaked duplicate query replies into shells (WVE-74) and rebuilt screens only partly from `capture-pane`.
- **zmx**, which has the holder's shape: a daemon per session around libghostty-vt. Clients attach only through `zmx attach` in a terminal, whether its daemon answers queries isn't documented, and an upgrade that changes its IPC kills sessions.
- **Rex now.** Its server owns sessions of blocks, sends each client raw PTY bytes after a snapshot for libghostty to parse, and listens on the tailnet. In October 2026, though, it documents no way for another program to stream a block, its server is 0.1.0 with no stability promise, its source isn't released, and its Linux server is in alpha.
- **A Ghostty surface, as cmux uses.** A surface keeps the PTY, the terminal and its renderer in the app that draws it, so cmux's terminals end with the app unless tmux holds them. Full GhosttyKit doesn't build for iOS, and Ghostty runs only local processes.
- **A renderer in the app's web view**, libghostty-vt as WASM or xterm.js, which would avoid native views under the web view. Portal's native renderer, which draws libghostty-vt with CoreText, built against today's libghostty-vt without source changes. On an iPad (WVE-150) it handled the hardware keyboard, rotation, Split View, a flood of output and suspending, once special keys stopped carrying iOS's names for them as text.

## Consequences

- This revisits ADR 0018's rejection of Rex beneath the Host, for terminals only; agents still don't run in Rex. That ADR's reasons are met for terminals: Rex's protocol stays behind a seam where holders remain the fallback, and a terminal has a text form.
- That text form is the text floor for terminals (ADR 0018): a client that can't render a terminal can still list its properties, read its screen as text and send it text.
- Holders outlive the Host that started them. The Host therefore speaks the holder protocol of every holder still running, and a holder keeps the libghostty-vt it started with until its shell exits.
- The holder is built with libghostty-vt, which needs Zig on every computer that builds weave, and it shares one Ghostty pin with the app. It is a crate and binary of its own, so nothing else needs Zig. libghostty-vt reports the same version at every commit, so a snapshot's codec names the Ghostty commit it was built from.
- The app draws terminals natively. Its native plugin holds each terminal's WebSocket, so a terminal's bytes never cross the web view's bridge, where base64 held throughput to 5 to 10 MiB/s. On the iPhone and with the software keyboard, a key bar gives Esc, Ctrl, Tab and the arrows.
- On Linux each holder runs in a systemd unit of its own (`systemd-run --user`), since the Host's `KillMode=mixed` stops everything left in its cgroup.
- Removing a worktree is refused while one of its terminals runs a command, as it is while a thread in it runs a turn. Otherwise its terminals close along with its threads.
- The last device to type into a terminal sets its size, and the others clip, as in Portal. Clipboard writes go to that device, and notifications go to every device showing the terminal.
- Each attached terminal streams over a WebSocket of its own, so a flood of output has its own flow control and can't trip the thread connection's fell-behind limit.
- Host-run terminals, the commands an agent runs through ACP's `terminal/create`, are unchanged: they belong to the agent's tool call.
- Some things come later: `weave terminal attach`, so a cmux or Rex pane at the desk joins the same shell, and a Host tool for agents to read a worktree's terminals, decided against ADR 0020.
