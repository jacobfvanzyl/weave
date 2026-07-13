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
deno task server:install
deno task dev # starts the Deno server
deno task server:dev
deno task portal:dev
deno task desktop:dev
deno task web:dev
deno task build # Deno-checks the server entrypoint
deno task desktop:typecheck
deno task desktop:test
deno task portal:check
deno task portal:test
```

## Raspberry Pi Server Deployment

The development server stack runs in Dokploy on the Tailscale host `homelab`; Desktop and Portal normally continue to
run on the Mac. Deploy server changes headlessly from the repository root:

```bash
deno task server:deploy
```

This typechecks the server, snapshots `HEAD` plus the current `server/` and `packages/protocol/` working trees through a temporary Git index,
force-with-lease pushes `deploy/pi-dev`, triggers the Dokploy Compose API, follows the deployment, and verifies the
Tailscale health endpoints. It must not stage files, switch the current branch, or create a commit on the working branch.
Keep Dokploy Auto Deploy disabled so one edit produces one intentional deployment.

Supporting commands are `server:deploy:prepare`, `server:deploy:status`, `server:deploy:rollback`, and the guarded
one-time `server:deploy:cutover`. Rollback changes application code only; database migrations must remain
backward-compatible with the preceding server version. Runtime secrets belong in Dokploy. Deploy-control credentials
belong only in ignored, mode-`0600` `server/.env.deploy`; never print or commit that file. See `server/README.md` for the
one-time setup, Tailscale endpoints, cutover procedure, and recovery details.

## Boundaries

- Do not commit `.env` files or secrets.
- Do not modify `node_modules` or Mastra database files directly.
- Prefer root scripts for cross-package commands and package-local scripts when working inside one package.
