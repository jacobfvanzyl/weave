---
status: accepted
date: 2026-10-11
---

# Make the weave daemon the Host, with a client protocol of its own

The weave daemon (`tui/crates/daemon`) becomes the Host process Weave's clients connect to. The TUI is its first client; whether the Capacitor app is reworked into another is decided later. The daemon speaks ACP to agents because the adapters require it. It also presents itself to clients as an ACP agent, which ties each connection to one agent and pushes attaching, shared threads, daemon-run terminals and daemon management into `_weave/*` extensions and `_meta`. Since we own every client, clients move to a protocol designed for a long-lived, shared Host. Serving ordinary ACP clients such as Zed is not a goal.

Portal, `product/protocol` and the Weave Host Protocol of ADR 0001 are reference material only. The new protocol doesn't inherit their messages, vocabulary or Workspace model, and what becomes of Portal is undecided.
