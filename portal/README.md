# Weave Portal

Deno daemon for host-side Portal tools, terminal sessions, and Desktop/Web bridging.

Portal owns terminal sessions through a dedicated tmux server. TypeScript keeps
session routing, tmux control-mode streaming, snapshot replay, batching, and the
local/WebSocket protocol.

## Commands

```bash
# server must already be running at localhost:4111/4112 unless overridden
deno task portal:login -- --token test-token --name "My Laptop"

deno task portal:dev
deno task portal:status
deno task portal:stop

deno task portal:build
deno task portal:start
```

Package-local Deno tasks are also available:

```bash
deno task --config portal/deno.json login --token test-token
deno task --config portal/deno.json dev
deno task --config portal/deno.json build
deno task --config portal/deno.json start
deno task --config portal/deno.json status
deno task --config portal/deno.json stop
```

## Shared Home

Portal uses one home for CLI and Desktop:

```text
WEAVE_PORTAL_HOME, when set
${XDG_CONFIG_HOME:-~/.config}/weave/portal
```

That means macOS also defaults to `~/.config/weave/portal`.

Default files:

- `config.json`: login/server/root configuration.
- `runtime.json`: local adoptable daemon runtime with pid, server URLs, and the local control endpoint.

`runtime.json` is written with mode `0600`. `portal status` masks local control
tokens and Portal tokens.

## Local Control

`portal daemon` starts local control on `127.0.0.1:0` by default and writes the
actual port/token to `runtime.json`. Desktop reads that runtime file, checks
`/health` with the local token, and adopts the daemon when the server URLs match
the current Desktop settings. If no compatible daemon is healthy, Desktop starts
Portal itself with the same shared home.

Use `--no-control` for remote/headless Portal runs that Desktop should not adopt.

## Terminal Backend

Portal terminals require `tmux` on `PATH`. Portal creates a private `_weave`
tmux session under `${WEAVE_PORTAL_HOME}/tmux`, attaches through tmux control
mode for live output/input/resize, and uses `capture-pane` only as an attach-time
snapshot after resizing the pane.

The tmux pane `TERM` defaults to `tmux-256color` when local terminfo supports it
and falls back to `screen-256color`. Set `WEAVE_PORTAL_TMUX_TERM` to override
that selection while debugging local terminfo problems.

## Window Streaming

On macOS, Portal can stream individual windows over direct WebRTC. The default
backend is `native-webrtc`. Portal launches
`portal/native/window-stream-native/build/weave-window-stream-native` directly:
ScreenCaptureKit frames go into VideoToolbox H.264/HEVC, and libdatachannel owns
the WebRTC media/data-channel transport.

```bash
deno task portal:window-stream-native:smoke
deno task portal:window-stream-native:benchmark
```

Build native dependencies with:

```bash
deno task --config portal/deno.json native
```

Use `WEAVE_WINDOW_STREAM_HOST` to point at another native executable.

## Lifecycle

1. `login` calls `POST /portals/token` using normal app auth.
2. `daemon` connects to `ws://.../portals/connect?portalId=...&token=...`.
3. Server sends `portal.accepted`.
4. Portal sends `portal.hello` with mounts and capabilities.
5. Server sends `portal.hello.ack`.
6. Portal sends `portal.pong` heartbeat every 15s.
7. Server `GET /portals` shows online Portal while socket stays open.

## Implemented tools

- `read`, `write`, `edit`, and `bash` under mounted Project paths.
- `portal.fs.*`, `portal.git.*`, `portal.agentInstructions.read`, and Worktrunk helpers.
- `terminal` over Portal local control and the WebSocket relay.
