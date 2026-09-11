# Terminal Service

The packaged Host comprises `weave-portal`, `weave-terminal-service` and
`terminal-vt.node` in one directory. The first remains the only remotely
reachable authority. The second uses Bun 1.3.14 PTYs, a Unix socket private to
the current user, and the exact Ghostty revision in Alpha's native pin. The
Node-API binding uses public VT APIs and OS process-directory APIs. It loads no
fonts and renders nothing.

The local contract covers discovery, idempotent creation, ordered input and
resize, binary snapshot capture, metadata, confirmed exit and deliberate stop.
Closing a connection releases IPC without closing terminals. Once no live
terminals and no connections remain, the idle owner exits automatically. The service keeps
its generation, live registry and shell PIDs when the Host Daemon restarts.
An unavailable registry fails rather than returning an empty successful list.

Only the service registers a libghostty PTY-write callback. Client replicas have
no automatic-effect callbacks; keyboard/mouse/paste encoding still uses their
current terminal modes. Native clipboard access, notifications, graphics and
external file/image loading are not granted by terminal output. Kitty image
storage is disabled because the supported renderer and public snapshot codec
do not restore those image registries. TERM is `xterm-256color`, with true color
and the shared theme defaults.

A snapshot is captured synchronously against a PTY output watermark. Public
Ghostty decoder source offsets divide its READY prefix and subsequent history
pages; Weave does not implement the state codec or inspect its records. Alpha
applies READY first, then requests one history page at a time and acknowledges
native consumption before requesting the next. Live bytes and human input can
continue between pages. A new screen supersedes the previous history token.
The codec identity includes the exact upstream pin and Weave configuration;
protocol 6 rejects old clients rather than translating terminal state.

The service limits live terminals to 128, each with 16 MiB/10,000 lines of
scrollback and 1 MiB of retained parser continuation. Frames, input queues and
viewer backlogs have explicit caps; slow viewers disconnect/resynchronize.
History tokens expire after two minutes. A consumer must never replay input
whose acceptance became uncertain during a disconnect.

## Build and installation

Run `bun run build:host` at the repository root. `bun run build:host:linux`
produces the three Linux x64 artifacts in `product/portal/dist/linux-x64`.
Native builds require Zig 0.16.0 and a C++ toolchain. The build fetches the
exact Ghostty source and checksum-verified Node-API headers when absent.
`WEAVE_NODE_HEADERS` can point at prepared headers. Alpha and Host reuse the
same pinned native cache on macOS.

Install the three files together. Linux's existing per-user Host service uses
`KillMode=process`, so restarting that daemon leaves the detached PTY owner
alive. The release installer copies the companion executable and native module
alongside each Host release. macOS likewise starts/discovers the private owner
on demand. Normal Host-only updates preserve running terminals when the local
service contract and codec match. A mismatch fails with an actionable error;
there is no multi-version dispatch or automatic PTY handoff.

Before replacing an old installation, run:

```
weave-portal terminal preflight --config /absolute/path/to/config.json
```

Close listed Weave terminals deliberately, or use `terminal cutover` with
`--confirm-stop` after approving that interruption. This one-time command only
stops terminals carrying Weave ownership in the retired private session. It
preserves unrelated tmux sessions and all conversation, credential and
Execution Context state. Starting the new Host reconciles exited Pane
references and empty Workspaces. The running product does not require tmux.

For planned Terminal Service maintenance, close live work and run
`terminal stop --config ...`. Stopping with live terminals requires
`--confirm-stop`. Update all matching components before starting again.
Compatible Host updates do not need this maintenance stop. On macOS, stage each
replacement executable/addon as a new file and atomically rename it into place;
do not overwrite an executed inode, which can retain stale kernel code-signature
pages. Keep the signed Host, helper and addon from the same build together.

If the owner crashes or the Host reboots, its PTYs are lost. Startup retains the
old registry and requires explicit `terminal accept-owner-loss --confirm-loss`
maintenance. It backs up that registry and only proceeds when the recorded
owner PID is no longer alive; it does not claim to resurrect jobs or migrate
processes from tmux. Normal Close Transactions still archive agent Threads.

## Acceptance

The main boundary is `scripts/packaged-acceptance.ts`, using the actual packaged
Host, authenticated client sockets, real shells and ACP processes. The separate
`terminal-service-acceptance.ts` checks the local public service boundary and
query replies. Alpha's packaged desktop/iPad flows and native renderer probe
cover presentation, input, snapshot decoding and rendering. Synthetic native
input and XCTest are not physical-keyboard/IME acceptance.
