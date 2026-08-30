---
status: accepted
date: 2026-08-29
---

# Broker visible Browser control through the Host Daemon

Alpha owns the one Browser Session that the human sees, and the Host Daemon brokers explicit, revocable control of that session to the active Agent Runtime. The product protocol is a capability-negotiated bidirectional RPC over Alpha's existing authenticated connection; a Thread-scoped stdio MCP adapter exposes only `browser_see` and `browser_act` to the agent. This layered design was chosen over MCP inside Alpha, an ACP extension, provider-native tools, a WebKit debugging listener, or a generic operation tool because it preserves Host authority and interoperability without exposing transport details, raw JavaScript, browser credentials, or a second hidden browser.

Control is pinned to `(hostId, threadId, clientId, tabId)` under a short-lived lease. Alpha must show control and let the human revoke it immediately; trusted human input invalidates agent work. Portal rejects wrong-session, stale-generation, cancelled, timed-out, unsupported, and oversized operations before accepting a native result.

The production-shaped capability separates `observe` from `control`: an observe grant can return a bounded view but cannot navigate or act. Control remains off by default and changing Thread, tab, visibility, app lifecycle, or Portal connection revokes it. Provider work is serialized behind a bounded queue; overload fails as typed `BUSY` rather than growing without limit.

Thread MCP credentials rotate whenever Portal creates a new descriptor and expire after 15 minutes. The adapter inherits only the three Browser variables and, when run from source, receives only the exact Unix-socket permissions. The socket and all evidence files are mode `0600`. Screenshots above the inline threshold are replaced with a five-minute `weave-browser-artifact://` resource link backed by a private Portal file. Portal appends a separate redacted audit record containing controller identity, operation class, exact address, outcome, error code, and duration; it never records page text, element names, screenshots, URLs, typed values, or secrets.
