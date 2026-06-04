# Weave Server

This is the Mastra server for Weave. It owns agents, tools, API routes, prompt templates, server persistence, and Portal websocket routing.

## Commands

```shell
npm run dev
npm run build
npm run start
```

From the repo root, these are available as:

```shell
npm run server:dev
npm run server:build
npm run server:start
```

Open [http://localhost:4111](http://localhost:4111) during development to access Mastra Studio and the local REST API.

## Layout

| Path | Purpose |
| --- | --- |
| `src/mastra/index.ts` | Mastra entry point and route registration. |
| `src/mastra/agents/` | Agent definitions, instructions, and tools. |
| `src/mastra/routes/` | HTTP API routes registered with Mastra. |
| `src/mastra/tools/` | Reusable Mastra tools. |
| `src/mastra/portal/` | Portal registry, relay, and websocket sidecar. |
| `src/mastra/prompts/` | Prompt templates loaded by the server. |

Server env files and deployment files also live here: `.env.example`, `.env`, `Dockerfile`, `compose.dokploy.yml`, and `.dockerignore`.

Load the `mastra` skill before changing Mastra code.
