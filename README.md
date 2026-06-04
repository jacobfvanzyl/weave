# Weave

Weave is split into a Mastra server plus clients and local runtime pieces.

## Layout

| Path | Purpose |
| --- | --- |
| `server/` | Mastra server, agents, API routes, tools, prompts, Docker files, and server env templates. |
| `packages/client/` | Shared React client package used by web, desktop, and mobile shells. |
| `desktop/` | Electron desktop app. |
| `web/` | Browser web app. |
| `mobile/` | Capacitor mobile app. |
| `portal/` | Deno Portal daemon for local terminal/editor/workspace access. |
| `tui/` | Deno terminal UI. |
| `docs/` | Architecture notes and implementation plans. |

## Common Commands

Install Node dependencies per package. For the server:

```bash
npm run server:install
```

Run commands from the repo root or directly inside the target package.

```bash
npm run dev
npm run build
npm run desktop:typecheck
npm run desktop:test
npm run portal:check
npm run portal:test
```

The server `.env`, `.env.example`, Mastra source, and deploy files now live under `server/`.
