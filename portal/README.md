# Weave Portal

Portal is the Deno daemon that performs host-side tools, terminal sessions, workspace file operations, LSP, and Jupyter execution. It has no listening HTTP or WebSocket server. A running Portal owns exactly one outbound JSON-RPC WebSocket to the Weave server's `/rpc` endpoint.

## Commands

```bash
# The server must already be reachable on port 4111.
deno task portal:login -- --token OWNER_TOKEN --name "My Laptop"
cd portal && deno task dev
deno task portal:status
deno task portal:stop
deno task portal:build
deno task portal:start
```

Portal configuration contains one `serverUrl`. Older configuration is migrated by preferring `httpServerUrl`, ignoring `wsServerUrl`, and writing the simplified shape on the next save. Login opens a temporary owner RPC connection, calls `portal.token.issue`, saves the returned Portal credential, and closes the connection.

## Shared home and supervision

Portal and Desktop share `${WEAVE_PORTAL_HOME:-${XDG_CONFIG_HOME:-~/.config}/weave/portal}`.

- `config.json` stores the server, Portal identity, roots, and mounts.
- `runtime.json` is runtime-file version 2. It stores the pid, random instance id, Portal identity, server URL, connection state, timestamps, and config path.
- `runtime.json.lock` is held by the active daemon.
- `desktop-daemon.log` contains bounded output from a Desktop-launched Portal.

The runtime file is a heartbeat, not a control endpoint. Desktop waits until the Portal is visible through `portal.list` on Desktop's own RPC connection. Online shutdown uses the reverse `portal.shutdown` request. Offline termination is allowed only after the process command line is verified to contain the matching runtime path and random instance id.

## Protocol lifecycle

1. Portal connects to `ws(s)://<server>/rpc` without credentials in the URL.
2. Its first request is `initialize` with protocol version 1, role `portal`, identity, capabilities, and Portal token.
3. The server authenticates and registers the peer. A newer connection supersedes an older peer with the same Portal identity.
4. Server-initiated `portal.tool.call` and typed terminal, workspace-file, LSP, Jupyter, and shutdown requests run over the same socket.
5. Session events and binary chunks return over that socket. Application heartbeats use `connection.ping` and `connection.pong`.

## Terminal backend

Portal terminals require `tmux` on `PATH`. Portal creates a private `_weave` tmux session under `${WEAVE_PORTAL_HOME}/tmux`, uses tmux control mode for live output/input/resize, and captures a fresh attach-time snapshot for replay.

The pane `TERM` defaults to `tmux-256color` when local terminfo supports it and otherwise uses `screen-256color`. Set `WEAVE_PORTAL_TMUX_TERM` to override it.

Remote application discovery, launch, and display mirroring are not Portal capabilities.
