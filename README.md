# Weave

Weave Alpha connects directly to Hosts to run structured ACP conversations and persistent terminals. The application uses the newer stack under `product/`. Filetree, dedicated Editor, embedded Browser, and Automation are outside the active product.

## Develop

Use Bun 1.3.14 from the repository root:

```sh
bun install --frozen-lockfile
bun run dev:alpha
bun run check
```

See [product notes](product/README.md), [Host configuration](product/portal/README.md), and the [domain glossary](CONTEXT.md). The Host uses Bun; Electron is the macOS runtime and Capacitor targets iPad only. Housekeeping retains xterm.js; libghostty starts in WVE-65.

The repository-pinned Linear CLI is intentionally a separate tooling install: `bun install --cwd .agents/tools/linear --frozen-lockfile`. Its credential isolation and usage are documented in [the tracker guide](docs/agents/issue-tracker.md).

Old application source is recoverable in Git. Local ignored artifacts and state retained during WVE-69 were moved intact to the private `~/.local/share/weave/legacy-wve66-20260909/` backup. No remote services or durable Host state were deleted.
