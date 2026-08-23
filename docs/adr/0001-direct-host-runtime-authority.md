---
status: accepted
date: 2026-08-23
---

# Make each Host Daemon the runtime authority

Weave clients connect directly to the Host that owns a Workspace; the Host Daemon, rather than a central Weave server, owns Workspace access, Agent Runtime supervision, Terminal sessions, and the durable mapping between Weave Threads and provider-owned ACP sessions. ACP remains the external-agent seam: the daemon exposes a stable stdio connector for clients such as Zed and may expose the draft ACP WebSocket transport as an explicitly experimental interface. We will not copy or make clients implement Zed's private remote-project protocol; Zed remote projects keep using Zed's own filesystem and terminal machinery, while Weave clients use a small Weave Host Protocol backed by the existing Portal implementations. This avoids a version-locked GPL implementation dependency and keeps the draft network transport replaceable without changing host ownership.
