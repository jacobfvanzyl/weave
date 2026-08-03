# Weave Server

The Deno server owns authentication, backend modules, persistence, workflows, and the private Mastra Agent implementation. Its application API is JSON-RPC 2.0 over one WebSocket endpoint at `ws(s)://<server>:4111/rpc`. The only HTTP application endpoint is unauthenticated `GET /health`; static web assets are outside this invariant.

## Commands

```shell
bun install
bun run dev:server
deno task server:build
deno task server:start
deno task server:db:migrate
deno task server:db:import-libsql --dry-run
```

Run `bun install` only from the repository root. Bun owns the server's `node_modules`; Deno uses that tree in manual mode while `server/deno.lock` remains the runtime lock.

## RPC architecture

Clients must send `initialize` within five seconds with protocol version 1, role, credentials, identity, capabilities, and app metadata. Credentials are never accepted in URLs. Browser origins use the configured CORS allow-list. Desktop owns one server socket in Electron main and multiplexes renderers over IPC; Web, Mobile, and Portal each own one socket per running instance.

The shared contract lives in `packages/protocol`. It provides strict envelopes, role authorization, reverse requests, cancellation, heartbeat, priority/backpressure limits, durable subscription replay, and the chunked binary-transfer protocol. Terminal, workspace-file, LSP, and Jupyter operations are server-mediated reverse requests to the registered Portal peer. The legacy realtime listener, relay tokens, SSE, and authenticated REST routes no longer exist.

Mastra remains private under `src/agent/mastra`. Product modules expose callable behavior to the RPC gateway and must not import the Mastra implementation directly.

## Headless Dokploy development

The server stack can run on Bazzite while Desktop and Portal remain on the development Mac:

```shell
deno task server:deploy
```

The command typechecks the server, snapshots `HEAD` plus the current `server/` and `packages/protocol/` working trees through a temporary Git index, force-with-lease pushes `deploy/pi-dev`, triggers Dokploy, follows the deployment, and verifies `GET /health` plus an authenticated `/rpc` `initialize`. It does not stage files, switch branches, or create a commit on the working branch. Keep Dokploy Auto Deploy disabled.

Supporting commands are:

```shell
deno task server:deploy:prepare
deno task server:deploy:status
deno task server:deploy:rollback
deno task server:deploy:cutover
deno task server:deploy:test
```

Rollback changes application code only. Database migrations must remain backward-compatible with the preceding server version. Deployment credentials belong only in ignored, mode-`0600` `server/.env.deploy`; runtime secrets belong in Dokploy.

The tailnet application endpoint is `http://bazzite:4111`; Garage S3 remains on `http://bazzite:3900`. Postgres, Garage admin, and Ollama are not published. `WEAVE_REMOTE_OWNER_TOKEN` is required in `server/.env.deploy` so deployment verification authenticates and completes an RPC `initialize` request.

## Persistence

`WEAVE_DATABASE_URL` is required. Weave metadata lives in the `weave` Postgres schema and is managed by Drizzle migrations under `server/drizzle`. Mastra storage/vector tables live in `mastra`, DBOS uses `dbos`, and object payloads live in Garage.

No migration is required for the single-socket cutover: persisted chat run events and workflow run events remain the replay sources.

## Compaction V2 rollout

Thread compaction defaults to the existing Markdown checkpoint path. Set `WEAVE_COMPACTION_V2_MODE=shadow` to keep
that behavior while sampling structured V2 candidates, or `WEAVE_COMPACTION_V2_MODE=active` to persist and inject V2
checkpoints. `WEAVE_COMPACTION_V2_SHADOW_SAMPLE_PERCENT` controls the deterministic shadow sample and defaults to 10.
Shadow telemetry records only decisions and token metrics; it does not log checkpoint or message content.

Apply the Weave database migrations before enabling active mode. Rollback to `legacy` is code-only: the Markdown
compatibility rendering remains populated, and the nullable V2 columns are safe for the preceding server version.

## Layout

| Path | Purpose |
| --- | --- |
| `src/server.ts` | Hono entry point exposing only `/health` and `/rpc`. |
| `src/rpc/` | Gateway, method registry, binary transfers, and transport tests. |
| `src/modules/` | Product business behavior and Agent contributions. |
| `src/portal/` | Portal peer registry, token store, and Portal services. |
| `src/agent/` | Public Agent service and private Mastra implementation. |
| `src/workflows/` | Workflow definitions, durable runs, and sequenced observers. |
| `src/storage/` | Postgres, Drizzle migrations, object storage, and import tools. |

Load the `mastra` skill before changing Mastra code.
