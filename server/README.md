# Weave Server

This is the owned Deno server for Weave. It owns HTTP routes, owner auth, backend modules, server persistence, the singular Weave Agent interface, and Portal realtime routing. Mastra is used privately under `src/agent/mastra` as the current Agent implementation.

## Commands

```shell
deno task dev
deno task build
deno task start
deno task check
```

From the repo root, these are available as:

```shell
deno task server:dev
deno task server:build
deno task server:start
```

The HTTP server listens on [http://localhost:4111](http://localhost:4111). Portal realtime remains on port `4112` during the compatibility phase.
The `dev` and `start` tasks load `server/.env` automatically when it exists, while still allowing shell environment variables to override local defaults.

## Layout

| Path | Purpose |
| --- | --- |
| `src/server.ts` | Deno/Hono entry point. |
| `src/modules/` | Module-owned route registration for Code, Notes, Chat, Agent, Portal, and cross-product surfaces. |
| `src/owner/` | Single-owner auth and request context. |
| `src/agent/` | Public Agent service/contribution boundary and private Mastra implementation. |
| `src/mastra/agents/` | Current Mastra agent definitions, instructions, and tools. |
| `src/mastra/routes/` | Legacy route handlers mounted by modules as canonical routes plus compatibility aliases. |
| `src/mastra/tools/` | Reusable Mastra tools. |
| `src/mastra/portal/` | Portal registry and relay primitives consumed by the Portal module. |
| `src/mastra/prompts/` | Prompt templates loaded by the server. |

Server env files and deployment files also live here: `.env.example`, `.env`, `Dockerfile`, `compose.dokploy.yml`, and `.dockerignore`.

Load the `mastra` skill before changing Mastra code.
