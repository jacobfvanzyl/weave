# AGENTS.md

This repo contains the Weave Mastra server plus web, desktop, mobile, Portal, TUI, and shared client packages.

## Structure

| Path | Description |
| --- | --- |
| `server/` | Mastra server. Agents, routes, tools, prompts, server Docker files, and server env files live here. |
| `packages/client/` | Shared React client and state used by the app shells. |
| `desktop/` | Electron shell and desktop tests. |
| `web/` | Web shell. |
| `mobile/` | Capacitor shell. |
| `portal/` | Deno daemon for local terminal/editor/workspace execution. |
| `tui/` | Deno terminal UI. |

## Mastra Work

Load the `mastra` skill before touching anything in `server/` that uses Mastra. Mastra APIs change frequently, so verify against the installed docs before changing agents, routes, tools, workflows, or scorers.

Register new Mastra agents, tools, workflows, and scorers in `server/src/mastra/index.ts`.

## Commands

```bash
npm run server:install
npm run dev # delegates to server
npm run build # builds the Mastra server
npm run desktop:typecheck
npm run desktop:test
npm run portal:check
npm run portal:test
```

## Boundaries

- Do not commit `.env` files or secrets.
- Do not modify `node_modules` or Mastra database files directly.
- Prefer root scripts for cross-package commands and package-local scripts when working inside one package.
