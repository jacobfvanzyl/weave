# Weave

`weave` is a terminal client for ACP agents (Claude, Codex, Gemini or any ACP command) and the per-user Host that runs them. Sessions outlive the terminal, run headless, and reach paired devices. See [tui/README.md](tui/README.md) to build and use it.

The independent [mobile trackpad and Pencil tablet project](trackpad/README.md) lives in `trackpad/` (WVE-81), with its own native build.

Decisions are in [`docs/adr/`](docs/adr/) and dated research in [`docs/research/`](docs/research/). The repository-pinned Linear CLI is a separate install, `bun install --cwd .agents/tools/linear --frozen-lockfile`; see [the tracker guide](docs/agents/issue-tracker.md).

Earlier iterations (the Portal Host Daemon, the Alpha app and their experiments) were retired in [ADR 0014](docs/adr/0014-retire-portal-alpha-and-the-product-protocol.md) and are recoverable from Git at commit `e30f6e93`.
