# Weave

Weave Alpha connects directly to Hosts to run structured ACP conversations and persistent terminals. The application uses the newer stack under `product/`. Filetree, dedicated Editor, embedded Browser, and Automation are outside the active product.

## Develop

Use Bun 1.3.14, Zig 0.16.0 and a C++ toolchain (Xcode command-line tools on macOS)
from the repository root:

```sh
bun install --frozen-lockfile
bun run dev:desktop
bun run check
bun run build:host
bun run build:desktop
```

Bun runs the package scripts, TypeScript checks, Vite, Vitest, Host and build tools.
Host tests build their native Terminal Service fixture automatically, including
the pinned Ghostty library on the first run. Electron supplies its own desktop
runtime; Xcode supplies the iPad toolchain.
`bun run dev:alpha` remains the renderer development server; `bun run dev:ipad`
syncs and opens the iPad project, and `bun run build:ipad` builds it.

See [Host operations](product/portal/OPERATIONS.md), [product notes](product/README.md), [Host configuration](product/portal/README.md), and the [domain glossary](CONTEXT.md). The Host uses Bun; Electron is the macOS runtime and Capacitor targets iPad only. Both apps use native libghostty terminals by default. Browser previews support the shared UI without a terminal renderer.

The repository-pinned Linear CLI is intentionally a separate tooling install: `bun install --cwd .agents/tools/linear --frozen-lockfile`. Its credential isolation and usage are documented in [the tracker guide](docs/agents/issue-tracker.md).

Old application source is recoverable in Git. Local ignored artifacts and state retained during WVE-69 were moved intact to the private `~/.local/share/weave/legacy-wve66-20260909/` backup. No remote services or durable Host state were deleted.
