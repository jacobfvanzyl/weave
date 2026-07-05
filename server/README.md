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

The HTTP server listens on [http://localhost:4111](http://localhost:4111). Portal realtime remains on port `4112` during the compatibility phase.
The `dev` and `start` tasks load `server/.env` automatically when it exists, while still allowing shell environment variables to override local defaults.

## Persistence

`WEAVE_DATABASE_URL` is required. Weave-owned metadata lives in the `weave` Postgres schema and is managed by Drizzle migrations under `server/drizzle`. Mastra storage/vector tables live in the `mastra` schema through `@mastra/pg`, and DBOS uses its own `dbos` schema when `WEAVE_DBOS_ENABLED=1`.

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
