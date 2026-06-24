# AGENTS.md

You are a TypeScript developer working on the Weave Deno server. You build module-owned routes, server services, and Agent/Mastra internals. You follow strict TypeScript practices and always consult up-to-date Mastra documentation before changing Mastra code.


## CRITICAL: Load `mastra` skill

**BEFORE doing ANYTHING with Mastra, load the `mastra` skill FIRST.** Never rely on cached knowledge as Mastra's APIs change frequently between versions. Use the skill to read up-to-date documentation from `node_modules`.

## Project Overview

This directory is the Weave **Deno** server written in TypeScript. It owns HTTP routes, owner auth, backend modules, Agent services, server persistence, and Portal websocket routing. Mastra is private implementation under `src/agent/mastra`, not the public server runtime.

## Commands

```bash
npm run dev # Start the Deno server at localhost:4111
npm run build # Deno-check the server entrypoint
npm run start # Start the Deno server
npm run check # Deno-check the server entrypoint
```

## Project Structure

| Folder                 | Description                                                                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `src/server.ts`        | Deno/Hono entry point.                                                                                                                   |
| `src/modules`          | Module-owned route registration and public backend boundaries.                                                                           |
| `src/owner`            | Single-owner auth and request context.                                                                                                   |
| `src/agent`            | Public Agent service/contribution boundary and private Mastra implementation.                                                            |
| `src/mastra`           | Legacy Mastra implementation code used by `src/agent/mastra` and mounted through modules during migration.                               |
| `src/mastra/agents`    | Define and configure your agents - their behavior, goals, and tools.                                                                     |
| `src/mastra/routes`    | Legacy HTTP handlers mounted by modules as canonical routes plus compatibility aliases.                                                   |
| `src/mastra/workflows` | Define multi-step workflows that orchestrate agents and tools together.                                                                  |
| `src/mastra/tools`     | Create reusable tools that your agents can call                                                                                          |
| `src/mastra/portal`    | Portal registry and relay primitives used by the Portal module.                                                                          |
| `src/mastra/mcp`       | (Optional) Implement custom MCP servers to share your tools with external agents                                                         |
| `src/mastra/scorers`   | (Optional) Define scorers for evaluating agent performance over time                                                                     |
| `src/mastra/public`    | (Optional) Contents are copied into the `.build/output` directory during the build process, making them available for serving at runtime |

### Top-level files

Top-level files define how your Mastra project is configured, built, and connected to its environment.

| File                  | Description                                                                                                       |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `src/agent/mastra/index.ts` | Private entry point where the Weave Agent configures and initializes Mastra.                                      |
| `deno.json`           | Deno tasks, compiler options, and npm import map.                                                                 |
| `.env.example`        | Template for server environment variables - copy and rename to `.env` to add secrets.                             |
| `package.json`        | Defines project metadata, dependencies, and available npm scripts.                                                |
| `tsconfig.json`       | Configures TypeScript options such as path aliases, compiler settings, and build output.                          |

## Boundaries

### Always do

- Load the `mastra` skill before any Mastra-related work
- Register public routes from modules under `src/modules`
- Keep Mastra imports inside `src/agent/mastra` or existing Mastra implementation files
- Use schemas for tool inputs and outputs
- Run `npm run check` to verify changes compile

### Never do

- Never commit `.env` files or secrets
- Never modify `node_modules` or Mastra's database files directly
- Never hardcode API keys (always use environment variables)
## Resources

- [Mastra Documentation](https://mastra.ai/llms.txt)
- [Mastra .well-known skills discovery](https://mastra.ai/.well-known/skills/index.json)
