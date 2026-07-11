# Weave Server

This is the owned Deno server for Weave. It owns HTTP routes, owner auth, backend modules, server persistence, the singular Weave Agent interface, and Portal realtime routing. Mastra is used privately under `src/agent/mastra` as the current Agent implementation.

## Commands

```shell
deno task dev
deno task build
deno task start
deno task check
deno task db:migrate
deno task db:import-libsql --dry-run
```

From the repo root, these are available as:

```shell
deno task server:dev
deno task server:build
deno task server:start
deno task server:db:migrate
deno task server:db:import-libsql --dry-run
```

## Headless Dokploy development

Desktop and Portal can remain on the development Mac while the server stack runs on the Raspberry Pi. The supported
development deployment is a private Git snapshot plus a Dokploy API deployment:

```shell
deno task server:deploy
```

The command typechecks the server, builds a commit from `HEAD` plus the current `server/` working tree, and pushes it to
`deploy/pi-dev` with `--force-with-lease`. It does not stage files, move the current branch, or create a commit on that
branch. Dokploy Auto Deploy must be disabled because the command explicitly queues and follows the Compose deployment.
After Dokploy reports success, both remote health endpoints are checked and the commit is recorded in
`deploy/pi-last-good`.

Other commands are:

```shell
deno task server:deploy:prepare   # push the first deploy/pi-dev snapshot before Dokploy is configured
deno task server:deploy:status    # show refs, latest Dokploy deployment, and health
deno task server:deploy:rollback  # redeploy application code from deploy/pi-last-good
deno task server:deploy:cutover   # guarded one-time Postgres/Garage migration
deno task server:deploy:test      # deployment-tool unit tests
```

Rollback changes application code only. Database migrations are forward-only, so migrations deployed through this loop
must remain compatible with the preceding server version.

### One-time Dokploy setup

1. Enable Tailscale SSH on `homelab` and allow this Mac to connect as the selected Linux user in the tailnet SSH policy.
2. Run `deno task server:deploy:prepare`.
3. Create a Dokploy Docker Compose service with:
   - repository `jacobfvanzyl/weave`
   - branch `deploy/pi-dev`
   - Compose path `server/compose.dokploy.yml`
   - stable app name `weave`
   - Auto Deploy disabled
4. Set `WEAVE_BIND_ADDRESS=100.127.235.59` in Dokploy. Configure a URL-safe, non-default
   `WEAVE_POSTGRES_PASSWORD`, the owner token/identity, Garage secrets, model configuration, and provider keys in the
   Dokploy environment editor. Generate `WEAVE_CREDENTIAL_ENCRYPTION_KEY` with `openssl rand -base64 32`; it encrypts
   per-owner ChatGPT OAuth credentials stored in Garage and must remain stable across deployments. The Compose file
   forwards this key only into the server container.
5. Generate a Dokploy API token, copy `server/.env.deploy.example` to the ignored `server/.env.deploy`, fill in its
   values, and restrict it with `chmod 600 server/.env.deploy`.

The tailnet endpoints are `http://homelab:4111`, `http://homelab:4112`, and Garage S3 on
`http://homelab:3900`. Postgres, the Garage admin API, and Ollama are not published by the Dokploy stack.

### Initial data cutover

First deploy the empty Pi stack and confirm `deno task server:deploy:status` can reach it. Stop the local Weave server,
then run:

```shell
deno task server:deploy:cutover
```

The command requires the exact confirmation text before it changes remote state. It discovers Dokploy containers by
Compose labels, stops the remote server, streams custom-format dumps of the `weave`, `mastra`, and `dbos` schemas over
Tailscale SSH, copies and verifies Garage objects through S3, reruns the migration container, and verifies both health
endpoints. It then pauses while you point Desktop at the Pi and verify terminal and file operations. Local Compose
infrastructure is stopped only after the second typed confirmation. Declining that confirmation leaves the local
services running, and local Docker volumes are never deleted.

Finally set the Desktop server URL to `http://homelab:4111` with the same owner token configured in Dokploy. Portal
realtime is derived as `ws://homelab:4112`.

ChatGPT subscription login is initiated from Desktop. Desktop receives OpenAI's loopback callback on
`127.0.0.1:1455` and forwards the short-lived authorization code to the configured server. Access and refresh tokens
never enter the renderer: the server exchanges and encrypts them into
`users/{ownerId}/credentials/chatgpt-codex.v1.json` in Garage. Web and Mobile can use an authenticated server but cannot
initiate login.

The HTTP server listens on [http://localhost:4111](http://localhost:4111). Portal realtime remains on port `4112` during the compatibility phase.
The `dev` and `start` tasks load `server/.env` automatically when it exists, while still allowing shell environment variables to override local defaults.

## Persistence

`WEAVE_DATABASE_URL` is required. Weave-owned metadata lives in the `weave` Postgres schema and is managed by Drizzle migrations under `server/drizzle`. Mastra storage/vector tables live in the `mastra` schema through `@mastra/pg`, and DBOS uses its own `dbos` schema when `WEAVE_DBOS_ENABLED=1`.

The Dokploy compose file uses `supabase/postgres:17.6.1.142` so local/Dokploy Postgres has common extensions such as `vector`, `pg_cron`, `postgis`, `pg_net`, and `pgmq` available. That image owns the app database as `supabase_admin`, so `WEAVE_DATABASE_URL` uses that role by default; change the password through deployment secrets and update the URL accordingly.

For local infrastructure, use the root compose tasks. They combine `compose.dokploy.yml` with `compose.local.yml` so Postgres, Garage, and Ollama keep private compose networking while also binding local development ports:

```shell
deno task infra:up
deno task infra:ollama:pull
deno task infra:ps
```

When cutting over from a manually-created Postgres container, set `WEAVE_POSTGRES_VOLUME` to that container's existing Docker volume before `infra:up`. This mounts the existing database files instead of creating a fresh compose volume. The local Ollama compose service uses the existing `weave-ollama` volume by default.

Run migrations explicitly before starting the server:

```shell
deno task server:db:migrate
```

For one-time migration from existing libSQL files:

```shell
deno task server:db:import-libsql --dry-run
deno task server:db:import-libsql
```

## Layout

| Path | Purpose |
| --- | --- |
| `src/server.ts` | Deno/Hono entry point. |
| `src/modules/` | Module-owned route registration for Code, Notes, Chat, Agent, Portal, and cross-product surfaces. |
| `src/owner/` | Single-owner auth and request context. |
| `src/agent/` | Public Agent service/contribution boundary and private Mastra implementation. |
| `src/agent/mastra/agents/` | Current Mastra agent definitions, instructions, and tools. |
| `src/agent/mastra/tools/` | Reusable Mastra tools. |
| `src/agent/mastra/prompt-templates/` | Prompt templates loaded by the server. |
| `src/storage/` | Postgres connection, Drizzle schema, migrations runner, and one-time libSQL importer. |

Server env files and deployment files also live here: `.env.example`, `.env`, `Dockerfile`, `compose.dokploy.yml`, and `.dockerignore`.

Load the `mastra` skill before changing Mastra code.
