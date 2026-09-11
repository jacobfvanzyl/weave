# WVE-75 terminal replacement evidence

Status: implementation in progress; local macOS Host and desktop switched to protocol 6.
The matching iPad build is installed and launched with its retained Host credential.
Date: 2026-09-11. Machine: Apple M4, macOS 26.6.2, Bun 1.3.14,
Electron 44.3.0. Ghostty pin: `4a70ee4718ba0967bcfd72f43adb715bf65a860d`.

## Implemented boundary

The Host uses one independent Bun PTY owner with authoritative public
libghostty-vt state. The protected local connection replaces the tmux parser,
control client and text-capture reconstruction. Public protocol 6 carries opaque
terminal bytes; READY and paged history use upstream snapshot APIs. Native and
JS components report/check the exact codec identity. Only the authority answers
terminal queries. Shared human input sets dimensions; passive views clip.

The service keeps its PID, generation and PTYs across Host Daemon restarts.
A lost owner is an explicit maintenance event. Local logs and the retained
registry make failed startup and lost sessions inspectable. Close Transactions
still archive conversations. The one-time tmux preflight is maintenance tooling,
not an alternative execution backend.

Electron output uses a scoped MessagePort with consumption acknowledgement;
iPad retains opaque base64 through Capacitor. Adjacent output writes coalesce
without crossing snapshot/history barriers. Input requests can be in flight
without waiting for earlier network acknowledgements. Fragmented local frames
allocate their payload buffer once rather than repeatedly concatenate it.
Native drawing defers extraction to visual work, reuses dirty rows, caches
CoreText lines and avoids replacing unchanged visible text.

## Automated results

- Root `bun run check` passed, including boundary checks, protocol, Alpha,
  Host, production client build and desktop/tool TypeScript checks.
- Packaged macOS Host acceptance passed real shell PID survival across graceful
  and abrupt Daemon restarts, authenticated reconnect, shared input, resizing,
  ACP recovery, persisted workspace membership and archival Close Transactions.
- Packaged query fixtures passed one response each for split device-attributes,
  status, cursor and mode queries with multiple attachments. Replies and passive
  views did not claim dimensions.
- PTY-owner termination failed public operations explicitly, preserved durable
  Pane membership, and required the documented loss-maintenance command before
  a new empty registry could be created.
- Desktop acceptance passed initial pairing and app relaunch with the retained
  credential, native paste, Neovim, split/maximize, workspace switch, snapshot
  reattachment, selection copy and synthetic native composition.
- Focused native probes passed fragmented UTF-8/parser continuation, alternate
  screen, query suppression, Kitty keyboard, paste/mouse/selection, dirty-cell
  drawing, clipping, READY/history interleaving and corrupt snapshot rejection.
- Real foreground jobs own `/dev/tty`; Ctrl-C interrupts a foreground job and
  returns to the same shell. Inline Bun PTY creation is required: Bun 1.3.14
  skips `setsid`/`TIOCSCTTY` for a separately created `Bun.Terminal`.
- A paced 8.2 MB real-PTY output flood detached a paused IPC consumer while
  the healthy consumer reached completion, retained the same shell PID and
  continued input. Large history exposed READY before incremental pages.
- One-time cutover acceptance refused unconfirmed interruption, then stopped
  only tagged Weave fixture terminals while retaining an unrelated tmux PID and
  nonterminal state.
- macOS Host and Electron packages, iPad Debug app and Linux x64 artifacts built.
  A Linux build is not evidence of Linux execution.

## Reproduction

```
bun run check
bun run build:host
bun build --compile --outfile /tmp/weave-fixture-agent product/portal/src/test-fixtures/fake-agent.ts
bun run test:host:packaged product/portal/dist/weave-portal /tmp/weave-fixture-agent
bun run test:terminal-service
bun run test:terminal-cutover
VITE_ALPHA_ACCEPTANCE=1 bun run build:desktop
bun run test:desktop product/portal/dist/weave-portal /tmp/weave-fixture-agent
bun run probe:native-renderer
bun run benchmark:native-renderer
VITE_ALPHA_ACCEPTANCE=1 bun run build:ipad
bun run build:host:linux
```

The acceptance artifacts are isolated profiles and disposable Host state. The
cutover test uses a dedicated tmux socket. Never substitute installed user state
for these fixtures. Use ordinary builds without `VITE_ALPHA_ACCEPTANCE` for the
installed app; inspection and input injection are excluded there.

## Renderer measurements

These are isolated CoreText/emulator measurements, compiled with `-O2`, using
one 1000×600 bitmap, bundled fonts and the same workloads before and after.
They do not include WebSocket, Electron or Capacitor latency. Each value is the
median of three separate processes. Raw records are in
[wve-75-renderer-measurements.jsonl](wve-75-renderer-measurements.jsonl).

| Workload | Iterations | Before CPU ms | After CPU ms | Before peak RSS MiB | After peak RSS MiB |
| --- | ---: | ---: | ---: | ---: | ---: |
| Hidden output | 10,000 | 1073.798 | 4.909 | 27.17 | 27.09 |
| Cursor updates and draw | 1,000 | 581.252 | 517.781 | 18.28 | 18.36 |
| Repeated row output and draw | 1,000 | 791.190 | 617.781 | 26.78 | 27.00 |
| Scrolling output, draw and visible text | 1,000 | 6546.740 | 3268.375 | 32.09 | 32.44 |

The hidden workload demonstrates removed eager extraction; the text workload
shows reduced extraction/drawing/text work. RSS is approximately unchanged.
These numbers do not establish a user-visible latency or battery improvement.
The baseline was the working renderer captured before this change, SHA-256
`6d31a0de9114570de3300d2c62342ac1ad9903a4bac9347133e4dc988ee75cd5`. `WEAVE_RENDERER_BASELINE` accepts that saved implementation for
an A/B run with the same benchmark. Broader allocation, bridge-volume,
input-to-display latency and multi-pane/device profiling remain open.

## Installed local cutover

The user approved stopping the remaining legacy Terminal. Neovim exited normally
without an unsaved-buffer warning before the tagged terminal was stopped. Host
state, configuration and previous installed binaries were backed up under
`~/.local/share/weave/backups/wve75-cutover-20260911-183423`; the desktop installer
also retained the previous app. No system-wide tmux removal was performed.

The signed Host, Terminal Service and native addon were replaced together. Use
new temporary files followed by atomic rename for macOS executable updates:
overwriting a previously executed inode can leave stale kernel code-signature
pages and cause `OS_REASON_CODESIGNING` despite a successful on-disk verification.
The installed Host reports protocol 6 and retains Host ID
`328c53e4-0c97-447b-a6bc-334c09857b02`. Configuration and pairing token key are
byte-for-byte unchanged. Security state changed only the desktop credential's
`lastUsedAt`; durable Threads are byte-for-byte unchanged.

The ordinary desktop build authenticated with its retained credential and
rendered the existing Hello conversation. A terminal created through the
workspace menu accepted input and rendered `WVE75_INSTALLED_OK:14346`. After
restarting the installed launchd Host, the same shell PID 14346 and service
generation survived at 94 columns by 41 rows. After installing the retry fix,
a second installed Host restart recovered automatically without pressing Retry.
The restored native screen retained the marker, and selecting its sidebar tile
then typing produced `RECONNECTED:14346` in that same shell.

Installed checking exposed two gaps beyond the prior fixtures: missing
controlling-terminal setup and an immediate-only client reconnect. The former
is fixed by inline PTY creation; transient reconnect failures now retry with
backoff from 1 to 30 seconds, cancel on unmount/supersession, and exclude known
authentication/identity/protocol failures. The Host startup allowance is ten
seconds for freshly installed signed binaries.

The user's `op completion zsh` also hung when launched outside Weave. Interrupting
it in the corrected PTY restored the prompt; no shell configuration was changed.
Packaged lifecycle fixtures now use an isolated HOME and `/bin/bash`, so personal
login plugins cannot determine their result. The installed user-shell check is
recorded separately.

The iPad update retained bundle ID `com.veezee.alpha`. After the user unlocked
the device, `devicectl` confirmed launch at 18:56 SAST and process PID 5276. The
Host recorded successful use of the existing `Weave on iPad` credential at
16:56:05 UTC. Terminal Service still reports the original shell PID 14346. This
proves app launch and retained-credential authentication; native visual/input
and suspension/reconnect acceptance have not yet been observed on the iPad.

## Completion gates still open

- Bazzite reports offline in Tailscale; SSH attempts timed out. Linux packaged
  execution, systemd lifecycle/update and process semantics remain unverified.
- The iPad ordinary Debug build launches and authenticates. Native terminal
  visual/input, suspension/reconnect and attended physical input acceptance
  remain open. The earlier separate acceptance bundle could not be provisioned.
- Synthetic AppKit input, native probes and XCTest must not be reported as
  physical keyboard, system IME, VoiceOver or iPad hardware acceptance.
- Extended sustained-output/slow-device stress and complete performance
  profiling remain required before marking the full specification complete.

WVE-75 stays In Progress. WVE-72 is not used to claim these new gates passed.
