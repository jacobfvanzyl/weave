---
status: accepted
date: 2026-11-14
---

# The TUI is no longer developed, and the app is the interactive client

ADR 0018 made the TUI one of weave's clients and had it compose with the multiplexer it runs in: one thread per instance, with Rex arranging TUIs into the person's layout. Since then the app has taken that place. It lists the person's Sessions under their Projects and lays each out as tabs of Blocks (ADR 0031), runs on the Mac, the iPad and the iPhone in one shell (ADR 0032, ADR 0033), and draws terminals itself. The person agreed on 2026-11-12 to work in the app and stop developing the TUI (WVE-222, under WVE-199).

The TUI (`weave-tui`) is frozen, not removed.

- **New features go to the app only.** Nothing new is designed for the TUI, and an issue that asks for something in both is built in the app.
- **The TUI keeps working.** It builds with the workspace, its tests and snapshots pass, and clippy stays clean. It takes the fixes that keep it working against the Host protocol as the protocol changes, and fixes for what breaks.
- **Bare `weave` still runs it,** with `--resume`, `--continue` and `--host` as before. No code is removed, and the fake agent, the conformance tests and the render snapshots stay as they are.
- **The text floor stands.** What ADR 0018 says of clients choosing how to enrich a thread above a text floor is unchanged, and so is what it says of the Host modelling no devices.

## Considered options

- **Remove the TUI now.** It is about 35,800 lines with its snapshots, and the CLI still uses parts of it (`Reconnector` in `cli/src/host.rs`, and `cli/src/rex_threads.rs` under ADR 0025). Removing it also leaves no interactive client over plain SSH. That waits until the app has replaced Rex in the person's day, and is its own issue.
- **Keep developing both.** Every feature of a thread's view would be built twice, in Rust and in React, for a client the person no longer works in.

## Consequences

- **Amends ADR 0018.** The TUI still composes with its multiplexer as that ADR describes, but nothing more is built on that: no new multiplexer integration, panes or views.
- **Open TUI issues are re-aimed or closed.** One that the app also needs, such as mentioning files from a thread's own Host (WVE-209), becomes the app's. One that only the TUI needed is cancelled.
- **Parity is no longer a goal.** The app may show what the TUI doesn't, and the TUI's guide (`tui/AGENTS.md`) describes what is there, not what is planned.
- **`weave run` and the CLI's commands are unaffected.** They are not the TUI, and stay developed.
- **Removal is still to decide:** when, what bare `weave` does afterwards, and whether anything interactive is kept for SSH. Retiring the Rex integration is WVE-207.
