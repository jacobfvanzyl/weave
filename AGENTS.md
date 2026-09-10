# Weave

The supported application is the newer Alpha, Host Daemon, and shared product protocol. Install from the repository root with Bun 1.3.14. The older central server and app shells have been retired.

| Path | Ownership |
| --- | --- |
| `product/alpha/` | React Alpha client, native libghostty terminal, platform shells |
| `product/portal/` | Host authority, ACP processes, credentials, Threads, filesystem, terminals |
| `product/protocol/` | Validated shared Host contracts |
| `product/deferred/` | Inactive filetree, Editor, and Browser reference snapshots; never a build input |
| `.agents/tools/linear/` | Deliberately isolated, pinned tracker CLI |

Run `bun install --frozen-lockfile`, `bun run dev:alpha`, and `bun run check` at the root. Focused checks/builds are root scripts or package-local Bun scripts. The Host uses Bun and the macOS desktop uses Electron. Capacitor is for iPad. Native libghostty is the only terminal renderer; Electron and iPad builds prepare it automatically. Follow-up acceptance and restoration work is tracked in WVE-72.

Preserve credentials, Host state, unrelated dirty work, and remote deployments. Do not commit secrets or edit installed dependencies directly. Repository cleanup is not remote deployment teardown. Before Docker work, check memory and verify the preferred explicit context; do not assume local Docker.

Issues use Personal Linear workspace `jacobfvanzyl`, team WVE, and the pinned CLI in `docs/agents/issue-tracker.md`. Follow `docs/agents/triage-labels.md` and use the canonical tracker state for task titles. Tracked implementation needs an issue association. Domain vocabulary lives in `CONTEXT.md`; read `docs/agents/domain.md` and relevant ADRs before changing it.
