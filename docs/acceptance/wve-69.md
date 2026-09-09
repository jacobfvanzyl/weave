# WVE-69: Canonical Alpha repository

Removed 1,466 tracked legacy source/configuration files: old server, desktop, web, mobile, Portal, TUI, shared client/protocol, deployment scripts/workflow, obsolete grammar/Mastra skills, and superseded workspace specifications. No extraction from those applications was needed by the surviving product boundary.

The root manifest and Bun lockfile now own `product/alpha` and `product/protocol`. `product/portal` remains independent Deno until WVE-70. The pinned Linear CLI is deliberately isolated under `.agents/tools/linear`, retaining its own frozen lockfile and Keychain-based account isolation.

Preexisting dirty root/old-Portal lockfiles and remaining ignored local artifacts/state were retained under the private `~/.local/share/weave/legacy-wve66-20260909/` backup. No remote deployment, credential content, database content, or durable Host record was deleted or modified. Unrelated research drafts remain uncommitted.

Validation: root frozen Bun install succeeds; complete root product checks pass. A clean export of the staged repository into `/tmp/weave-wve69-fresh/` also installs with `--frozen-lockfile` and passes the same boundary, protocol, 174 Alpha tests, Alpha production build, and 57 Host tests. Capacitor sync resolves plugin paths through the new root install. No supported command references a retired application.
