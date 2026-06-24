# AGENTS.md

This repo contains the Weave Deno server plus web, desktop, mobile, Portal, TUI, and shared client packages.

## Structure

| Path | Description |
| --- | --- |
| `server/` | Deno server. Backend modules, Agent/Mastra implementation, routes, tools, prompts, Docker files, and server env files live here. |
| `packages/client/` | Shared React client and state used by the app shells. |
| `desktop/` | Electron shell and desktop tests. |
| `web/` | Web shell. |
| `mobile/` | Capacitor shell. |
| `portal/` | Deno daemon for local terminal/editor/workspace execution. |
| `tui/` | Deno terminal UI. |

## Mastra Work

Load the `mastra` skill before touching anything in `server/` that uses Mastra. Mastra APIs change frequently, so verify against the installed docs before changing agents, routes, tools, workflows, or scorers.

Public HTTP behavior should be registered by modules under `server/src/modules`. Mastra remains the private Agent implementation under `server/src/agent/mastra`; modules must not import it directly.

## Commands

```bash
npm run server:install
npm run dev # starts the Deno server
npm run build # Deno-checks the server entrypoint
npm run desktop:typecheck
npm run desktop:test
npm run portal:check
npm run portal:test
```

## Boundaries

- Do not commit `.env` files or secrets.
- Do not modify `node_modules` or Mastra database files directly.
- Prefer root scripts for cross-package commands and package-local scripts when working inside one package.
