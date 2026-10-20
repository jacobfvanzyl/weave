# Weave

This repository holds the weave Host, its terminal client, its app for iPad and iPhone, and an independent trackpad project. Earlier iterations (Portal, Alpha, the product protocol and their experiments) were retired in ADR 0014 and are recoverable from Git at commit `e30f6e93`; ADR 0015 brought Alpha back as the app.

| Path | Ownership |
| --- | --- |
| `tui/` | The weave Host (`weave daemon`) and the `weave` TUI: a Rust Cargo workspace for ACP agents, sessions, journals and the Host protocol. Read `tui/AGENTS.md` before working in it. |
| `app/` | The weave app: a React and Capacitor client of the weave Host for iPad and iPhone; WVE-91. Read `app/AGENTS.md` before working in it. |
| `trackpad/` | Independent native iPhone/iPad trackpad and Mac companion; WVE-81. Read `trackpad/AGENTS.md` before working in it. |
| `docs/adr/` | Decisions, from ADR 0008 on. |
| `docs/research/` | Dated research: evidence, not implementation requirements. |
| `docs/agents/` | Tracker and domain guidance. |
| `.agents/tools/linear/` | Deliberately isolated, pinned tracker CLI. |

Preserve credentials, Host state, unrelated dirty work, and remote deployments. Do not commit secrets or edit installed dependencies directly. Repository cleanup is not remote deployment teardown. Before Docker work, check memory and verify the preferred explicit context; do not assume local Docker.

Issues use Personal Linear workspace `jacobfvanzyl`, team WVE, and the pinned CLI in `docs/agents/issue-tracker.md`; install it with Bun 1.3.14 (`bun install --cwd .agents/tools/linear --frozen-lockfile`). Follow `docs/agents/triage-labels.md` and use the canonical tracker state for task titles. Tracked implementation needs an issue association. Domain vocabulary lives in `tui/CONTEXT.md`; read `docs/agents/domain.md` and relevant ADRs before changing it.
