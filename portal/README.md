# Weave Portal

Deno daemon for host-side Portal tools, terminal PTYs, and Desktop/Web bridging.

Portal owns PTY sessions on macOS/Linux through a small Rust FFI library built
with `portable-pty`. TypeScript keeps session routing, replay, batching, and the
local/WebSocket protocol.

## Commands

```bash
# server must already be running at localhost:4111/4112 unless overridden
npm run portal:login -- --token test-token --name "My Laptop"

npm run portal:dev
npm run portal:status
npm run portal:stop

npm run portal:build
npm run portal:start
```

Direct Deno tasks are also available:

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

## Native PTY

Development builds compile the native PTY library first:

```bash
deno task --config portal/deno.json native
```

`WEAVE_PORTAL_PTY_LIB_PATH` can point Portal at a locally built library while
iterating on Rust.

## Window Streaming

On macOS, Portal can launch an Electron Chromium sidecar for window streaming.
The sidecar is started lazily when the app lists windows or starts a stream. In
development it defaults to `desktop/node_modules/.bin/electron` and
`portal/window-host-electron/main.cjs`.

```bash
npm run portal:window-host:smoke
```

Use `WEAVE_WINDOW_HOST_ELECTRON` and `WEAVE_WINDOW_HOST_APP` to point Portal at
another Electron executable or sidecar entrypoint. V1 streams video and opens
the control data channel, but control messages are logged as no-ops until a
native input layer is added.

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
