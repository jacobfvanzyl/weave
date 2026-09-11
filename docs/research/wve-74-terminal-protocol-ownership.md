# WVE-74: terminal protocol ownership and the cmux comparison

Researched 2026-09-11. This is a diagnosis and architecture comparison, not an implementation decision. Weave references describe the current working tree. Ghostty is pinned to `4a70ee4718ba0967bcfd72f43adb715bf65a860d`. The cmux checkout inspected was `7d78b6e4cb0236c3b4eb354d851498b685801e00`; selected ownership and mobile files were also checked at current upstream HEAD `d6584c07e04d029bb23c6ed9b5a5a4bb511a348b`. Its inspected Ghostty fork is `abd40f6e472d57f2d4bb182004bb5f3fac8df961`.

## Finding

Weave currently lets display emulators answer queries that tmux has already answered. Their replies enter the same channel as human keystrokes. Multiple writable devices can therefore answer one query, and those replies can also change which device owns terminal dimensions.

The screenshot fragment `62;22c` is consistent with the standard primary device-attributes response `ESC[?62;22c`: VT220 conformance and ANSI color. The pinned libghostty-vt emits that exact response by default. The screenshot does not establish the original bytes, responsible device, or timing; it is strong evidence of a reply leaking into shell input, rather than proof of a particular rendering failure. [xterm control sequences](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html), [pinned Ghostty device attributes](https://github.com/ghostty-org/ghostty/blob/4a70ee4718ba0967bcfd72f43adb715bf65a860d/src/terminal/device_attributes.zig).

cmux explicitly distinguishes the protocol owner from a mirror and suppresses automatic replies in mirrors. Its iOS source documents the same failure class: duplicate terminal responses had appeared as literal escape fragments. Human input has a separate route. [Current cmux I/O modes](https://github.com/manaflow-ai/cmux/blob/d6584c07e04d029bb23c6ed9b5a5a4bb511a348b/Packages/macOS/CmuxTerminal/Sources/CmuxTerminal/Surface/TerminalSurfaceIOMode.swift#L3-L29), [iOS reply suppression](https://github.com/manaflow-ai/cmux/blob/d6584c07e04d029bb23c6ed9b5a5a4bb511a348b/Packages/iOS/CmuxMobileTerminal/Sources/CmuxMobileTerminal/GhosttySurfaceView.swift#L5505-L5520).

## Current Weave chain

```text
Shell / TUI
    ↕ real PTY
tmux: persistent process owner, VT parser, screen state, query replies
    ↕ control mode: %output / capture-pane / send-keys -H
Portal: control parser, snapshot synthesis, sequencing, attachment and size policy
    ↕ terminal JSON-RPC over WebSocket
Alpha: output buffering and native bridge
    ↕ Electron Node-API or iPad Capacitor
libghostty-vt: VT state and key/mouse/paste encoding
    ↕ render cells and native events
Weave CoreText/CoreGraphics renderer + AppKit/UIKit input adapters
```

Each terminal has a tmux window; the pane splits shown by Weave are product layout, not tmux's displayed split layout. Processes persist on the Host. The clients do not own PTYs. [Backend](../../product/portal/src/tmux-terminal-backend.ts), [terminal service](../../product/portal/src/terminals.ts), [native integration](../../product/alpha/native/ghostty/README.md).

tmux and Ghostty both parsing VT is not itself incorrect. Ordinary multiplexing also involves multiple emulators. The problem here is that raw control-mode output is replayed into mirrors whose replies are injected directly into the application's input, bypassing the ownership boundary.

## Where our implementation differs

| Layer | Current Weave behavior | Assessment |
| --- | --- | --- |
| Shell and PTY | A real shell in a real tmux-owned PTY; normal process and signal behavior. | Standard foundation. We have not implemented a shell or PTY emulator. |
| Terminal identity | tmux configuration chooses `tmux-256color` or `screen-256color`, but terminal creation explicitly launches the shell with `TERM=xterm-256color`. | A concrete mismatch. The application is talking to tmux; its terminfo identity should reflect that. |
| tmux integration | Custom Bun control-mode parser, octal decoding, command correlation, metadata, pause/capture/resume boundaries, and `send-keys -H`. | Supported tmux mechanisms with custom integration. cmux remote terminals use comparable machinery. |
| Transport | Sequenced JSON-RPC output, snapshots, attachment recovery, and shared input. VT is converted through UTF-8 strings and back to bytes. Legacy title sequences are explicitly filtered. | Product-specific transport, not a transparent arbitrary-byte pipe. Streaming UTF-8 decoding handles split valid characters, but invalid UTF-8 cannot round-trip losslessly. |
| Screen restoration | Capture screen text and attributes, then synthesize VT to restore two screens, cursor, scroll region, and selected modes. | A partial state reconstruction, not serialization of the full terminal emulator. |
| Terminal parsing | Actual upstream libghostty-vt. | Standard implementation reused; Weave does not implement the main VT parser. |
| Automatic replies | Live parser replies use the same `writeInput` callback as human input, except for selected suppressed capabilities. | Incorrect ownership for a tmux display mirror; duplicates are possible even with only one device. |
| Input | Ghostty key/mouse/paste encoders, surrounded by our key mapping, modifier, IME, focus, and native event adapters. Kitty keyboard mode is forcibly disabled. | Encoding is substantially reused, but platform integration and capability policy remain ours. |
| Rendering | Our CoreText/CoreGraphics cell painter, selection, fonts, cursor drawing, clipping, and native views. | We use Ghostty's terminal core, not its full renderer. Visual fidelity and platform behavior are our responsibility. |
| Geometry | One Host grid; the last attachment sending input owns its size. Other views clip that grid to local bounds. | Deliberate distributed product policy. Automatic replies currently pass through this policy accidentally. |

Sources: [tmux backend](../../product/portal/src/tmux-terminal-backend.ts), [terminal service](../../product/portal/src/terminals.ts), [snapshot synthesis](../../product/portal/src/terminal-snapshot.ts), [native bridge component](../../product/alpha/src/components/native-terminal-view.tsx), [renderer and input encoding](../../product/alpha/native/ghostty/WeaveTerminalRenderer.mm). The [tmux manual](https://man.openbsd.org/tmux.1) specifies a `screen`/`tmux` family identity for applications inside tmux.

Snapshot reconstruction currently reads 24 tmux fields and restores a defined subset of terminal modes. It also captures the pending incomplete escape sequence. It does not restore arbitrary Ghostty state; for example, the implementation explicitly excludes Kitty keyboard flag stacks. Palette changes, tab stops, and other unrepresented state need an explicit preservation audit rather than an assumption that a text capture is complete. The current integration also suppresses Kitty discovery and DEC 2048 resize reports, and rewrites DEC 2048 mode queries to report unsupported. These are documented compatibility policies, not limitations of libghostty-vt itself. [Snapshot source](../../product/portal/src/terminal-snapshot.ts), [transport limitations](../../product/alpha/native/ghostty/README.md).

## How cmux compares

Ordinary local cmux uses a full Ghostty surface that owns the PTY, child process, protocol handling, and GPU rendering. tmux is optional in that path. Its opt-in local-tmux mode and remote terminals do use tmux. [Surface creation](https://github.com/manaflow-ai/cmux/blob/7d78b6e4cb0236c3b4eb354d851498b685801e00/Packages/macOS/CmuxTerminal/Sources/CmuxTerminal/Surface/TerminalSurface%2BRuntimeSurfaceCreation.swift), [local-tmux documentation](https://github.com/manaflow-ai/cmux/blob/d6584c07e04d029bb23c6ed9b5a5a4bb511a348b/docs/local-tmux.md).

The closer comparison is cmux's remote tmux path: SSH, tmux control mode, a custom Swift protocol parser, captured-screen bootstrap, and hex input injection. It deliberately uses a `manualMirror` Ghostty surface. This renders supplied bytes and encodes human input while suppressing emulator-generated responses. Thus control mode and captured-screen seeding are not peculiar to Weave; the response ownership is the significant difference. [Remote control implementation](https://github.com/manaflow-ai/cmux/blob/7d78b6e4cb0236c3b4eb354d851498b685801e00/Sources/RemoteTmuxControlConnection.swift), [capture and input commands](https://github.com/manaflow-ai/cmux/blob/7d78b6e4cb0236c3b4eb354d851498b685801e00/Sources/RemoteTmuxControlConnection%2BCommands.swift), [current mirror construction](https://github.com/manaflow-ai/cmux/blob/d6584c07e04d029bb23c6ed9b5a5a4bb511a348b/Sources/Workspace.swift#L9311-L9333).

cmux mobile mirrors the Mac's authoritative terminal. Its primary mobile path uses render-grid state snapshots, with byte tee/replay fallback, and its UIKit/Metal Ghostty surface drops automatic outbound bytes. These are terminal-state snapshots, not screenshots. cmux carries a substantial Ghostty fork that supplies these embedding capabilities. [Mobile state transport](https://github.com/manaflow-ai/cmux/blob/7d78b6e4cb0236c3b4eb354d851498b685801e00/Sources/Mobile/MobileTerminalByteTee.swift), [mobile reply handling](https://github.com/manaflow-ai/cmux/blob/d6584c07e04d029bb23c6ed9b5a5a4bb511a348b/Packages/iOS/CmuxMobileTerminal/Sources/CmuxMobileTerminal/GhosttySurfaceView.swift#L5505-L5520), [fork suppression implementation](https://github.com/manaflow-ai/ghostty/blob/abd40f6e472d57f2d4bb182004bb5f3fac8df961/src/termio/stream_handler.zig#L20-L103).

Using the full cmux-style surface is therefore a larger dependency decision, particularly on iPad. Our pinned upstream revision supports libghostty-vt on iOS but rejects the full renderer there. Replacing our cell painter alone would not correct protocol ownership. [Pinned upstream build configuration](https://github.com/ghostty-org/ghostty/blob/4a70ee4718ba0967bcfd72f43adb715bf65a860d/src/build/Config.zig#L132).

## Diagnostic evidence

Two bounded probes ran without touching the user's tmux socket, panes, or applications:

1. A standalone C executable linked the exact pinned macOS libghostty-vt and fed it `ESC[c`. Its write callback emitted `ESC[?62;22c`.
2. An isolated tmux 3.7c server ran a raw-mode test process issuing the same query. Its control client received the raw query. The test then injected zero, one, or two copies of the measured Ghostty response via `send-keys -H`, modelling the current mirror callback route.

| Simulated display replies | Bytes received by the test process |
| --- | --- |
| 0 | `ESC[?1;2;4c` |
| 1 | `ESC[?1;2;4c` followed by `ESC[?62;22c` |
| 2 | `ESC[?1;2;4c` followed by two copies of `ESC[?62;22c` |

tmux's own reply matches its SIXEL-enabled source branch. [tmux DA handling](https://github.com/tmux/tmux/blob/master/input.c). Temporary probe sources/results are `/tmp/wve74-da-probe.c`, `/tmp/wve74-da-tmux-probe.py`, and `/tmp/wve74-da-tmux-probe.json`.

This confirms the duplicate-response mechanism, not a full reproduction of the original screenshot. The likely visible failure is that an extra or delayed reply reaches the shell after the requesting program has stopped consuming replies. No cmux runtime acceptance was performed.

The Weave route is directly visible in source: `acceptReply` calls `writeInput`; native events classify it as `input`; Alpha sends `terminal.input`; Portal updates size ownership before injecting it into tmux. Snapshot replay suppresses replies, but ordinary live output does not. [Reply callback](../../product/alpha/native/ghostty/WeaveTerminalRenderer.mm), [Alpha event routing](../../product/alpha/src/components/native-terminal-view.tsx), [Host input handling](../../product/portal/src/terminals.ts).

## Recommended direction

1. Make tmux the explicit terminal protocol authority for this backend. Display mirrors should not answer its application queries. Retain ordinary shared human input; protocol ownership does not require restoring the old exclusive device lock.
2. Separate human input, terminal-generated replies, and geometry ownership in the integration contract. For tmux-backed mirrors, suppress generated replies at their source. Do not filter only the visible `62;22c` string. Audit any explicit passthrough features separately before promising them.
3. Stop overriding the shell's tmux-family `TERM`. Verify the advertised capabilities, tmux state, renderer, and keyboard encoder agree.
4. Define and test reconnect fidelity: query/reply behavior, alternate screens, cursor, modes, UTF-8 boundaries, and size handoff across one and two devices. Treat incomplete snapshot state as a documented contract to improve, not a complete terminal-state dump.
5. Evaluate full Ghostty surface/fork adoption separately from this repair. It could reduce custom rendering and input work, but brings platform and upstream maintenance costs. The immediate protocol issue is fixable with our existing VT core.

Only this research note was added. No application source, tracker, installed build, or user terminal state was changed for this investigation.
