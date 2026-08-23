# Weave Portal

Portal is the Deno daemon that performs host-side tools, terminal sessions, workspace file operations, LSP, and Jupyter
execution. The existing Portal mode owns one outbound JSON-RPC WebSocket to the Weave server's `/rpc` endpoint.

WVE-38 adds an experimental direct Host mode alongside that existing path. Host mode does not require a Weave server: it
owns allowlisted ACP agent processes, accepts a stable ACP stdio connector over a mode-`0600` local Unix socket, and
exposes initial Host discovery and Thread attachment methods over authenticated `/rpc`. The draft Remote ACP endpoint is
experimental; do not expose the local socket over a network proxy.

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

`deno task build` produces a binary for the current machine. Use `deno task build:linux` for the x86-64 Linux artifact
installed on Bazzite; do not copy the default macOS artifact to a Linux Host.

## Experimental direct Host ACP proof

Configure at least one root and, if the agent executables are not already on `PATH`, explicit agent commands in the
existing Portal config:

```json
{
  "portal": {
    "roots": [
      { "id": "default", "name": "Code", "path": "/absolute/path/to/code" }
    ]
  },
  "host": {
    "socketPath": "/Users/me/.local/state/weave-host/host.sock",
    "threadEventRetentionLimit": 10000,
    "network": {
      "hostname": "127.0.0.1",
      "port": 4121,
      "tokenEnv": "WEAVE_HOST_TOKEN",
      "agentId": "codex",
      "workspaceId": "default",
      "allowedOrigins": []
    },
    "agents": {
      "codex": {
        "name": "Codex",
        "command": "/absolute/path/to/codex-acp",
        "args": [],
        "env": ["OPENAI_API_KEY"]
      },
      "opencode": {
        "name": "OpenCode",
        "command": "/absolute/path/to/opencode",
        "args": ["acp"]
      }
    }
  }
}
```

`env` adds variable names to the Host's small process-environment allowlist. Values do not belong in `config.json`.
Basic process and user configuration variables such as `HOME`, `PATH`, locale, temporary-directory, XDG, and TLS
certificate locations are retained automatically; provider credentials are not. Omit `host.agents` to use the default
`codex-acp` and `opencode acp` commands from `PATH`.

Run the daemon and connector in separate terminals:

```bash
cd portal && deno task host:dev
cd /absolute/path/to/code && weave-host acp connect --agent codex
```

By default, the connector sends its current working directory to the Host as an untrusted Workspace candidate. The Host
canonicalizes it, selects the narrowest configured root that contains it, and launches the Agent in that directory. A
missing path, symlink escape, or path outside every configured root fails with the same unavailable error. Use
`--workspace <id>` only when an explicit configured root is required for automation or diagnostics.

The connector's stdout is ACP-only; diagnostics go to stderr. After `cd portal && deno task install`, both `portal` and
`weave-host` name the same binary. When `weave-host` is on `PATH` and every host uses the default config and socket
locations, one global Zed custom External Agent entry works for local and Zed Remote projects:

```json
{
  "agent_servers": {
    "weave-codex": {
      "type": "custom",
      "command": "weave-host",
      "args": ["acp", "connect", "--agent", "codex"]
    }
  }
}
```

The Host Daemon, not the connector, launches the allowlisted agent. A bound ACP session is owned by the daemon and may
be shared by simultaneous stdio and Remote ACP clients. The broker assigns stable IDs and monotonically increasing
sequences to user-message and Agent-update events, persists them in a crash-tail-recoverable append-only mode-`0600`
`${WEAVE_HOST_HOME:-${XDG_STATE_HOME:-~/.local/state}/weave-host}/thread-events.jsonl`, replays the recorded events to
late attachments, reconstructs one shared provider runtime when clients load a journaled session after a daemon restart,
fans new events out to observers, and arbitrates one active prompt at a time. The Host journal is authoritative during
cold reconstruction, so duplicate provider replay is suppressed; sessions that predate the journal are bootstrapped from
their first provider load. A submitted prompt is not delivered to the Agent unless its user event was persisted first.
Each Thread retains its latest 10,000 events with a durable compaction watermark. Weave-native ACP clients can negotiate
the `weave.dev` Thread-event extension for stable event metadata, replay cursors, monotonic acknowledgements, and an
explicit `RESUME_GAP`/provider-full-reload path; ordinary ACP clients continue to receive unextended events. Disconnecting
one client does not end a bound runtime. Automatic runtime recovery without a reconnecting client, durable runtime
generations, and uncertain in-flight prompt delivery remain tracked by WVE-40.

`host.threadEventRetentionLimit` overrides the positive integer per-Thread limit. Keep the default for normal use; a
small value is useful only for explicit overflow/resynchronization acceptance.

When `host.network` is present, Host mode also exposes the experimental draft ACP WebSocket at `/acp`. It requires an
authentication token before WebSocket upgrade and returns `Acp-Connection-Id` on success. Native clients should use an
`Authorization: Bearer` header. Browser clients in the current proof may pass a
`weave-acp-token.<base64url-token>` WebSocket subprotocol; this is a bootstrap mechanism, not the final pairing flow.
The token value comes only from `tokenEnv` and must not be placed in the config or URL.

The listener defaults to loopback and refuses a non-loopback hostname unless `privateNetwork` is explicitly true.
`privateNetwork` does not add encryption: use it only on a controlled private network, and put the loopback listener
behind Tailscale Serve or another supported TLS terminator for ordinary remote access. Browser origins are denied unless
listed exactly in `allowedOrigins`.

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
