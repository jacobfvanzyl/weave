# Weave

Weave is split into an owned Deno server plus clients and local runtime pieces.

## Layout

| Path | Purpose |
| --- | --- |
| `server/` | Deno server, backend modules, Agent implementation, Docker files, and server env templates. |
| `packages/client/` | Shared React client package used by web, desktop, and mobile shells. |
| `desktop/` | Electron desktop app. |
| `web/` | Browser web app. |
| `mobile/` | Capacitor mobile app. |
| `portal/` | Deno Portal daemon for local terminal/editor/workspace access. |
| `tui/` | Deno terminal UI. |
| `docs/` | Architecture notes and implementation plans. |

## Development

PNPM 11.13.0 is the sole package manager for every Node dependency in the workspace. Install once from the repository root:

```bash
corepack enable
pnpm install
```

The root development interface is intentionally limited to four commands:

```bash
pnpm dev:server
pnpm dev:desktop
pnpm dev:web
pnpm dev:mobile -- [mobile options]
```

Deno remains the runtime for the server, Portal, and TUI. Their checks and operational tasks stay on their owning Deno surfaces; Portal development is package-local:

```bash
deno task server:build
cd portal && deno task dev
deno task portal:check
deno task portal:test
deno task tui:check
```

The root `pnpm-lock.yaml` is the only Node dependency lock. Deno lockfiles remain runtime locks. The server `.env`, `.env.example`, Deno runtime, Agent/Mastra implementation, and deploy files live under `server/`.
