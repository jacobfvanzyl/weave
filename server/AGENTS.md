# AGENTS.md

You are a TypeScript developer working on the Weave Deno server. You build module-owned routes, server services, and Agent/Mastra internals. You follow strict TypeScript practices and always consult up-to-date Mastra documentation before changing Mastra code.


## CRITICAL: Load `mastra` skill

**BEFORE doing ANYTHING with Mastra, load the `mastra` skill FIRST.** Never rely on cached knowledge as Mastra's APIs change frequently between versions. Use the skill to read up-to-date documentation from `node_modules`.

## Project Overview

This directory is the Weave **Deno** server written in TypeScript. It owns HTTP routes, owner auth, backend modules, Agent services, server persistence, and Portal websocket routing. Mastra is private implementation under `src/agent/mastra`, not the public server runtime.

## Commands

```bash
pnpm install # Run once from the repository root
pnpm dev:server # Start the Deno server at localhost:4111
deno task build # Deno-check the server entrypoint
deno task start # Start the Deno server
deno task check # Deno-check the server entrypoint
```

## Project Structure

| Folder                 | Description                                                                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `src/server.ts`        | Deno/Hono entry point.                                                                                                                   |
| `src/modules`          | Product module route registration and public backend boundaries for Code, Notes, Chat, and shared Attachments.                           |
| `src/owner`            | Single-owner auth and request context.                                                                                                   |
| `src/agent`            | Agent core service, contribution boundary, Agent HTTP routes, and private Mastra implementation.                                         |
| `src/agent/mastra`     | Private Mastra implementation for the singular Weave Agent.                                                                              |
| `src/portal`           | Portal token store, RPC peer registry, target resolution, and Portal services.                                                           |
| `src/server`           | Shared server types, route helpers, and compatibility alias registration.                                                                |

### Top-level files

Top-level files define how your Mastra project is configured, built, and connected to its environment.

| File                  | Description                                                                                                       |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `src/agent/mastra/index.ts` | Private entry point where the Weave Agent configures and initializes Mastra.                                      |
| `deno.json`           | Deno tasks and compiler options. Node modules are supplied by the root PNPM workspace in manual mode.             |
| `.env.example`        | Template for server environment variables - copy and rename to `.env` to add secrets.                             |
| `package.json`        | Sole declaration point for the server's npm dependencies and package-local scripts.                              |
| `tsconfig.json`       | Configures TypeScript options such as path aliases, compiler settings, and build output.                          |

## Boundaries

### Always do

- Load the `mastra` skill before any Mastra-related work
- Register product routes from modules under `src/modules`
- Register Agent and Portal core routes from `src/agent` and `src/portal`
- Keep Mastra imports inside `src/agent/mastra`; product modules must use Agent and Portal core boundaries
- Use schemas for tool inputs and outputs
- Run `deno task check` to verify changes compile

### Never do

- Never commit `.env` files or secrets
- Never modify `node_modules` or Mastra's database files directly
- Never hardcode API keys (always use environment variables)
- Never install server dependencies separately; run `pnpm install` at the repository root
## Resources

- [Mastra Documentation](https://mastra.ai/llms.txt)
- [Mastra .well-known skills discovery](https://mastra.ai/.well-known/skills/index.json)
