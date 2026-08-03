# Lightweight tmux backend alternatives for Weave

_Research snapshot: 2026-08-01. Primary sources only, plus repository inspection and disposable local probes._

## Answer

There is no clearly safer lightweight replacement for Weave's tmux backend today.

Keep tmux as the production backend. Put a backend boundary around it, then make **zmx the first replacement spike after a release containing the current resize-crash fix is available**. zmx is the closest semantic match: it deliberately provides persistent named terminal sessions without panes or a user-facing window manager, supports multiple clients, reconstructs terminal state on reconnect, and exposes input, output, resize, history, metadata, and kill operations. It is also young, lacks an explicitly public SDK, and its current 0.7.0 release has a reported resize path that can abort the daemon and destroy the affected session. ([zmx README](https://github.com/neurosnap/zmx/blob/main/README.md), [zmx IPC source](https://github.com/neurosnap/zmx/blob/main/src/ipc.zig), [resize crash #215](https://github.com/neurosnap/zmx/issues/215))

Treat **RMUX as the cross-platform/typed-engine contingency**, not the lightweight choice. It has a daemon-backed Rust SDK, tmux-compatible commands and control mode, screen capture, output streams, and native Windows support. But it is a much larger full multiplexer, is only at 0.9.1, and a disposable probe showed that Weave's exact `attach-session -f pause-after=1` control-mode form is not accepted. Its TypeScript SDK also says it targets the older 0.6.x line and invokes the executable rather than using the current typed IPC directly. ([RMUX README](https://github.com/Helvesec/rmux/blob/main/README.md), [Rust SDK](https://github.com/Helvesec/rmux/blob/main/crates/rmux-sdk/README.md), [TypeScript SDK](https://github.com/Helvesec/rmux-typescript/blob/main/README.md))

Do not replace tmux with Zellij, WezTerm, Mosh, Eternal Terminal, dtach, abduco, or Coder's `reconnectingpty` for this use case. Each either brings another complete terminal workspace, solves connection transport rather than local PTY ownership, omits the replay/control surface Weave relies on, or is source material rather than a standalone backend.

## What Weave actually needs

Weave does not use tmux as a human interface. `portal/src/terminal.ts` creates a private `_weave` session on a deterministic socket, disables tmux UI and key handling, and treats tmux as a headless terminal service.

The current `PortalTmuxController` contract requires:

| Primitive | Current tmux implementation | Why Weave needs it |
| --- | --- | --- |
| Discover sessions | `list-windows` plus `@weave_*` metadata | Restore deterministic workspace/general terminal identities after Portal restarts. |
| Create/reuse a PTY | `new-session`, `new-window` | Keep one independently addressable shell per Weave terminal. |
| Live output | one `tmux -C` control client | Stream all active panes to Portal without an attached terminal UI. |
| Raw input | control-mode `send-keys -H` | Preserve arbitrary UTF-8 and terminal control bytes. |
| Resize | control-mode `resize-window` | Keep the backend PTY synchronized with xterm.js. |
| Replay/capture | `capture-pane -p -e -J`, with alternate-screen and cursor handling | Reconstruct visible state after UI or Portal reconnect. |
| Flow control | `pause-after=1`, `%pause`, `%continue` | Prevent a slow Portal/UI consumer from losing output or growing without bound. |
| Close and lifecycle | `kill-window`, window-close notifications | Distinguish detach from intentional terminal destruction. |
| Process metadata | `pane_current_command` | Show useful terminal state without making the renderer inspect processes. |

The existing tests in `portal/src/terminal_test.ts` and `portal/src/tmux_control_terminal_test.ts` cover deterministic restoration, list/create/close, live input/output, resize before replay, alternate-screen capture, cursor restoration, idle persistence, flow control, control-client recovery, and a real `btop` interaction. An alternative must pass those behaviours; matching a few tmux command names is not enough.

## Shortlist

| Candidate | Model | Replay / live stream / resize | Integration surface | Fit for Weave |
| --- | --- | --- | --- | --- |
| **tmux** | One mature server owns many sessions/windows/panes | Yes / control mode / yes | Stable CLI, formats, user metadata, control mode | **Keep in production.** It already satisfies and is tested against the entire contract. |
| **zmx 0.7** | One small daemon per persistent terminal; no panes/splits | VT-state restore and history / tagged socket output / tagged socket resize | CLI plus compact Unix-socket wire protocol; no public SDK | **Best lightweight spike.** Exact product philosophy and protocol shape, but too young for immediate adoption. |
| **RMUX 0.9.1** | One full cross-platform multiplexer daemon | Snapshots and capture / Rust SDK streams or control mode / yes | Typed Rust SDK; tmux-like CLI/control; older CLI-based TS SDK | **Best broader contingency.** Strong API and Windows story, but heavier and not an exact control-mode drop-in. |
| **shpool 0.11** | One daemon owns many persistence-only shell sessions | In-memory terminal restore / attach byte stream / yes | CLI; public Rust library; daemon protocol explicitly non-public | **Conceptually close, operationally awkward.** Portal would need a native helper or reliance on private protocol. |
| **dtach / abduco** | Minimal daemon/process per detachable session | No useful screen reconstruction / byte pipe / terminal attach resize | Small C CLI/socket conventions | **Too primitive.** Weave would need to rebuild terminal-state replay and orchestration. |
| **Coder `reconnectingpty`** | In-process reconnectable PTY abstraction | Buffered or GNU Screen-backed replay / Go connection / yes | Internal Go package within Coder | **Pattern source only.** Not a standalone daemon and its own comments describe the buffer fallback as buggy. |
| **Zellij** | Complete Rust terminal workspace and session server | Full terminal engine / internal client-server stack / yes | CLI actions, plugins, web client/server | **Too much engine.** No small supported headless raw-pane SDK for Portal. |
| **WezTerm mux server** | Full terminal emulator plus standalone mux server | Full terminal model / mux client / yes | Experimental mux CLI, Lua API, project-specific internal protocol | **Too much distribution and UI coupling.** Better for WezTerm clients than an xterm.js backend. |
| **Mosh / Eternal Terminal** | Roaming or reconnecting remote shell transport | Connection recovery, not a local multi-session capture service | Network client/server | **Wrong layer.** They complement a multiplexer; they do not replace Weave's terminal registry and replay API. |

## Candidate details

### 1. zmx: closest to the desired product boundary

zmx explicitly rejects the panes/tabs/splits part of tmux. Its README promises persistent shell sessions, multiple clients, restored terminal state and output, raw command injection, scrollback history, and macOS/Linux support. The current release is 0.7.0, published 2026-07-23, and the repository remains active. ([README](https://github.com/neurosnap/zmx/blob/main/README.md), [releases](https://github.com/neurosnap/zmx/releases))

The internal design matches Weave unusually well:

- each named session is a separately daemonized PTY owner, so a Portal disconnect or restart does not kill the shell;
- the daemon embeds `ghostty-vt` to track terminal state and generate reconnect output;
- the Unix-socket protocol has explicit `Input`, `Output`, `Resize`, `History`, `Info`, `Kill`, and label messages;
- the wire tag values and metadata layout have source-level compatibility tests and warnings against breaking running daemons;
- session labels can carry Weave scope and terminal metadata; and
- many clients may watch the same session, while a leader policy decides which client controls size. ([daemon source](https://github.com/neurosnap/zmx/blob/main/src/loop.zig), [IPC source](https://github.com/neurosnap/zmx/blob/main/src/ipc.zig), [0.7 changelog](https://github.com/neurosnap/zmx/blob/main/CHANGELOG.md))

That would map to Weave as one zmx session per deterministic Weave terminal, with `ZMX_DIR` pointing below `WEAVE_PORTAL_HOME`. Weave, not zmx, would remain the logical multiplexer and UI.

The risks are material:

1. The latest release is pre-1.0 and the socket protocol, while deliberately wire-stable in source, is not documented as a public external SDK.
2. `zmx list` has no JSON output; a machine-readable mode is an open request. Direct socket integration or careful CLI parsing would be needed. ([issue #220](https://github.com/neurosnap/zmx/issues/220))
3. The latest 0.7.0 release has a reported `ghostty-vt` reflow abort on a column-halving resize that destroys the session. The upstream fix has merged and the maintainer said it will be updated, but the released artifact used by the local probe predates it. ([issue #215](https://github.com/neurosnap/zmx/issues/215), [upstream fix](https://github.com/ghostty-org/ghostty/pull/13524))
4. The daemon keeps a separate VT model and client output queues per session. Its memory and slow-consumer behaviour need measuring at Weave's expected terminal count; source inspection is not a substitute for that benchmark.
5. zmx persists across client/Portal loss, not machine reboot. That matches tmux, but it should not be described as reboot persistence. ([issue #76](https://github.com/neurosnap/zmx/issues/76))
6. It supports macOS and Linux, not Windows. That is no regression from tmux for the current backend, but it does not solve future native Windows Portal support.

#### Disposable zmx probe

On macOS arm64, the official 0.7.0 release was downloaded to a temporary directory with an isolated `ZMX_DIR`. The following worked before the temporary directory was moved to Trash:

- `zmx run -d` created a persistent named shell;
- `zmx list --short` rediscovered it;
- `zmx history` reconstructed earlier command output;
- piped `zmx send` drove the detached shell, and its result appeared in later history; and
- `zmx kill` removed it.

This validates the basic lifecycle, not resize safety, alternate-screen correctness, backpressure, or long-running reliability.

### 2. RMUX: stronger API, broader engine, very young

RMUX 0.9.1 is a full async Rust multiplexer with native Linux, macOS, and Windows backends. Its direct Rust SDK can create/reuse sessions, address panes through typed handles, send text, resize, capture snapshots, wait for text, and consume output and state streams over local typed IPC. That is the strongest supported automation API in the shortlist. ([RMUX README](https://github.com/Helvesec/rmux/blob/main/README.md), [SDK overview](https://github.com/Helvesec/rmux/blob/main/docs/scripting-sdk.md), [SDK source](https://github.com/Helvesec/rmux/tree/main/crates/rmux-sdk))

It also implements a substantial tmux-compatible command and control-mode surface. This makes a low-churn experiment possible: run Weave's existing controller and tests against an isolated RMUX endpoint before considering a native SDK bridge.

It is not a drop-in today. A disposable macOS arm64 0.9.1 probe successfully created a private session/window, stored `@weave_*` metadata, listed tmux-format fields, and ran capture/display commands. The exact Weave control attach then returned:

```text
server error: unknown client flag: pause-after=1
```

Removing that flag would also remove the explicit flow-control contract Weave relies on, so this is not a cosmetic command-line mismatch. The native Rust SDK is the more credible RMUX integration, but Portal is Deno/TypeScript and would need a maintained native sidecar or upstream current TypeScript IPC SDK. The existing TypeScript SDK states that it targets RMUX 0.6.x and drives the `rmux` executable. ([TypeScript SDK README](https://github.com/Helvesec/rmux-typescript/blob/main/README.md))

RMUX is also only a few months old and packs a complete multiplexer, terminal model, web sharing, tmux compatibility layer, and several SDKs. Choose it if native Windows and a typed engine become requirements, not to minimize backend scope.

### 3. shpool: good philosophy, wrong supported seam

shpool calls itself a lighter-weight alternative to tmux and Screen. It has one daemon owning multiple named shells, reconnect-time terminal reconstruction, list/detach/kill commands, Linux and macOS support, and active 0.11.0 releases. It intentionally preserves native terminal rendering rather than providing panes or splits. ([README](https://github.com/shell-pool/shpool/blob/master/README.md), [0.11.0 release](https://github.com/shell-pool/shpool/releases/tag/v0.11.0))

It is less suitable for Portal than zmx:

- one client may be attached to a session at a time, although Portal could fan out one backend client to multiple UI subscribers;
- its own version policy lists the daemon attachment protocol as non-public;
- the supported programmable surface is a Rust library, so Deno would still need a native helper;
- the project says Linux is primary and documents skipped/flaky macOS tests; and
- terminal restoration remains an active pre-1.0 improvement area. ([HACKING/version policy](https://github.com/shell-pool/shpool/blob/master/HACKING.md), [restore source](https://github.com/shell-pool/shpool/blob/master/libshpool/src/session_restore.rs), [simultaneous clients #40](https://github.com/shell-pool/shpool/issues/40), [restore work #46](https://github.com/shell-pool/shpool/issues/46))

shpool remains a useful design reference for one-daemon/many-PTY ownership, but zmx offers a closer current protocol shape for Weave.

### 4. Minimal classics: dtach and abduco

dtach and abduco are closer to the literal minimum: detach a process from a terminal and reattach later. They are tiny, understandable, and do not impose panes or an emulator UI. Their upstream projects are old, and neither provides the terminal-state reconstruction, structured metadata, one-stream-many-session control, or explicit flow control Weave currently gets from tmux. ([dtach source](https://github.com/crigler/dtach), [abduco source](https://github.com/martanne/abduco), [shpool's comparison](https://github.com/shell-pool/shpool/blob/master/README.md#dtach-abduco-and-diss))

Using either would turn Portal into the missing multiplexer: it would need one attachment process per terminal, a terminal state engine or replay log, resize plumbing, metadata persistence, output buffering, and lifecycle recovery. That is more custom terminal backend, not less.

### 5. Coder reconnecting PTY: borrow lifecycle ideas, not the package

Coder's `agent/reconnectingpty` is production evidence for mapping a stable ID to a reconnectable terminal, attaching simultaneous connections, replaying state, sending JSON input/resize messages, and expiring idle sessions. It is an internal Go package coupled to Coder's agent, command, metrics, and workspace protocols rather than a standalone daemon. Its source says the fallback buffered backend is buggy; on Linux it prefers GNU Screen when installed, and Screen is avoided on Darwin because of flakiness. ([implementation](https://github.com/coder/coder/blob/main/agent/reconnectingpty/reconnectingpty.go), [server lifecycle](https://github.com/coder/coder/blob/main/agent/reconnectingpty/server.go), [Screen backend](https://github.com/coder/coder/blob/main/agent/reconnectingpty/screen.go))

The reusable lesson is the API shape and reconnect lifecycle. Copying the package would import a Go sidecar, AGPL-licensed source, and a backend-selection problem without yielding a maintained standalone multiplexer.

### 6. Zellij and WezTerm: complete terminal products

Zellij is an active, mature terminal workspace with sessions, panes, plugins, headless session creation, and a built-in authenticated web server/client. It can keep sessions alive and its CLI can target panes and dump their screens, but adopting it means adopting another full terminal/session engine and its client-server model. Its supported automation surfaces are CLI actions and plugins, not a small live raw-pane service designed for an external xterm.js renderer. ([programmatic control](https://zellij.dev/documentation/programmatic-control.html), [CLI actions](https://zellij.dev/documentation/cli-actions.html), [web client](https://zellij.dev/documentation/web-client.html))

WezTerm similarly has a standalone mux server, persistent workspaces, a CLI for list/send/get-text/kill operations, and a Lua mux API that can operate without a GUI. Its documentation still calls multiplexing young and the CLI's mux server experimental. Installing a cross-platform GPU terminal emulator to use only the internal mux is a poor scope match, and there is no supported Deno/TypeScript live raw-pane SDK. ([multiplexing](https://wezterm.org/multiplexing.html), [mux API](https://wezterm.org/config/lua/wezterm.mux/index.html), [CLI](https://wezterm.org/cli/cli/index.html))

Both are good terminal products. Neither is a lightweight persistence backend for Weave.

### 7. Mosh and Eternal Terminal: transport, not multiplexing backend

Mosh maintains an interactive remote connection across roaming, address changes, and temporary network loss using its own client/server protocol. Eternal Terminal similarly reconnects remote shells and explicitly recommends using tmux inside ET when multiple windows or scrollback are needed. They do not expose a local named-PTY registry, replay capture API, metadata, or programmatic multiplexer control for Portal. ([Mosh manual](https://mosh.org/), [Mosh source](https://github.com/mobile-shell/mosh), [Eternal Terminal README](https://github.com/MisterTea/EternalTerminal/blob/master/README.md))

## Recommendation for Weave

### Production decision

Keep `TmuxTerminalController` as the default. tmux remains actively maintained, is already an accepted dependency on the current macOS/Linux targets, and has the exact control and recovery semantics backed by Weave's tests. A replacement should be justified by a measured failure, missing platform, distribution problem, or a materially simpler supported API—not by tmux exposing features Weave has already disabled. ([tmux source and releases](https://github.com/tmux/tmux), [tmux manual](https://man.openbsd.org/tmux))

### Narrow architecture step

Rename the existing tmux-specific boundary to a backend-neutral interface before any replacement, without changing behaviour. The current `PortalTmuxController` is already close; the main leaks are tmux window/pane identifiers, `continueOutput`, and capture semantics.

A useful backend contract would retain only:

```text
list terminals
ensure terminal
subscribe to output and exit
write input
resize
capture/reconstruct current state
close
```

Keep deterministic Weave terminal identity and UI fan-out in Portal. Do not ask the backend to own projects, workspaces, tabs, or layouts.

### zmx spike gate

Run a spike only against a zmx release that includes the `ghostty-vt` resize fix. Keep tmux available and do not migrate existing user sessions.

The spike should prove:

1. deterministic Weave IDs can be represented safely despite Unix socket name limits, preferably with short hashed zmx names plus labels;
2. direct tagged-socket or supported CLI integration survives Portal termination and restart;
3. repeated wide-to-narrow resizes, Unicode split across messages, OSC 8 hyperlinks, alternate screens, shell prompts, `btop`, and editors do not lose or duplicate output;
4. a deliberately slow Portal subscriber has bounded memory and a documented resynchronization path;
5. 1, 10, 50, and 100 idle/active sessions have acceptable RSS and CPU compared with one tmux server;
6. list/find/kill and foreground-process display can be implemented without scraping unstable human output;
7. macOS and Linux packaged binaries are reproducible and installable with Portal; and
8. all current fake-controller and live tmux behavioural tests have backend-neutral equivalents.

Promote zmx only if those gates pass and the integration uses an upstream-supported API or a small, version-negotiated protocol adapter with fixtures pinned to a known release.

### When to reconsider RMUX

Reconsider RMUX when native Windows Portal becomes a real requirement or when its current TypeScript SDK speaks the typed daemon protocol directly. Before adoption, run the complete `TmuxTerminalController` live suite against its compatibility layer and require a replacement for `pause-after` flow control. If a Rust helper becomes acceptable, compare the native RMUX SDK with a much smaller purpose-built PTY helper before selecting the full engine.

## Bottom line

For Weave in August 2026:

- **ship tmux;**
- **prototype zmx next, after the fixed release;**
- **keep RMUX on the horizon for Windows or a typed native engine;** and
- **do not move to Zellij/WezTerm or rebuild replay on dtach/abduco merely to avoid the tmux name.**

The lightweight opportunity is real, but the current alternatives do not yet beat the reliability and already-paid integration cost of tmux.
