---
status: accepted
date: 2026-10-19
---

# Retire Portal, Alpha and the product protocol

ADR 0008 made the weave daemon the Host and left open what would become of Portal. ADR 0011 keeps that Host as the runtime authority. The earlier iterations are therefore removed from the repository:

- Portal, the Bun Host Daemon;
- Alpha, the React client in Electron and Capacitor;
- the shared `product/protocol` and the deferred snapshots;
- the browser and terminal experiments;
- the research, specs and acceptance notes written for them;
- ADRs 0001 to 0007, which governed them.

Their last state is commit `e30f6e93`. The repository now holds the weave Host and TUI (`tui/`) and the independent trackpad project (`trackpad/`).

## Consequences

- Removing the code does not remove what is installed. An installed Portal and its state are retired separately, as a deliberate step on that machine.
- A weave Host client for iPad, iPhone or the desktop is built new or brought back from history under WVE-91. Nothing in the tree depends on the old apps.
- Earlier work stays recoverable from that commit. One example is the Client Browser's `WKWebView` machinery that WVE-96 means to reuse (`git show e30f6e93:product/…`).
