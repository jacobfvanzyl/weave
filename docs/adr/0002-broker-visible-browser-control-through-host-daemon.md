---
status: accepted
date: 2026-08-29
---

# Broker visible Browser control through the Host Daemon

Alpha owns the one Browser Session that the human sees, and the Host Daemon brokers explicit, revocable control of that session to the active Agent Runtime. The product protocol is a capability-negotiated bidirectional RPC over Alpha's existing authenticated connection; a Thread-scoped stdio MCP adapter exposes only `browser_see` and `browser_act` to the agent. This layered design was chosen over MCP inside Alpha, an ACP extension, provider-native tools, a WebKit debugging listener, or a generic operation tool because it preserves Host authority and interoperability without exposing transport details, raw JavaScript, browser credentials, or a second hidden browser.

Control is pinned to `(hostId, threadId, clientId, tabId)` under a short-lived lease. Alpha must show control and let the human revoke it immediately; trusted human input invalidates agent work. Portal rejects wrong-session, stale-generation, cancelled, timed-out, unsupported, and oversized operations before accepting a native result.
