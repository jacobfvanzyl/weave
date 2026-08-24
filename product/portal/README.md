# Portal

Portal is the host-side Weave product. It runs beside project files and Agent credentials, exposes an authenticated WebSocket interface to Alpha, and owns ACP Agent processes and Thread identity.

It has no source or package dependency on the earlier Weave server or Portal implementation.

## Configure

Copy `portal.config.example.json` to the ignored `portal.config.json` and set absolute state and Workspace paths. Agent commands are explicit so installation and version policy stay outside the runtime.

Set the access token in the environment variable named by `accessTokenEnv`:

```bash
export PORTAL_ACCESS_TOKEN='replace-with-a-long-random-token'
deno task dev
```

The token is carried in the WebSocket subprotocol, not in a URL. Browser origins are denied unless they appear in `allowedOrigins`; clients without an `Origin` header still require the token.

## Verify

```bash
deno task check
deno task test
deno task build
```

The test suite starts the real Portal transport and a fake ACP subprocess, then creates, lists, attaches to, and prompts a Thread. It separately verifies that an invalid token cannot open the metadata connection.

For a real Agent acceptance against an already running Portal:

```bash
PORTAL_URL=ws://127.0.0.1:4122 \
PORTAL_ACCESS_TOKEN="$PORTAL_ACCESS_TOKEN" \
PORTAL_WORKSPACE_ID=project \
PORTAL_AGENT_ID=codex \
PORTAL_ACCEPTANCE_MARKER=PORTAL_ACCEPTANCE_OK \
deno task acceptance
```

## Current persistence boundary

Portal writes the Thread catalog atomically with mode `0600`. On restart it spawns the configured Agent and restores the provider session through `session/load`. The normalized ACP event journal is currently in memory and is reconstructed from provider replay; durable replay cursors, runtime generations, and uncertain in-flight prompt recovery remain follow-on work.
