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

The test suite starts the real Portal transport and a fake ACP subprocess, then creates, lists, attaches to, and prompts a Thread. It also exercises restart recovery, native replay cursors, bounded retention, acknowledgement gaps, and access-token rejection.

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

Portal writes the Thread catalog and normalized ACP event journal atomically with mode `0600`. Journal event IDs, timestamps, per-Thread sequences, and compaction watermarks survive daemon restarts. `threadEventRetentionLimit` bounds each Thread to 10,000 retained events by default; native clients behind the durable watermark receive `RESUME_GAP` instead of a partial replay.

On restart Portal currently spawns the configured Agent and restores the provider session through `session/load`. Runtime generations, provider-resume fallback, and uncertain in-flight prompt recovery remain follow-on work.
