---
status: accepted
date: 2026-10-16
---

# Offer client tools through a Host-owned MCP server, over MCP 2026-07-28 only

Agents should be able to use tools that run on a Weave client (WVE-89): its clipboard now, a Client Browser on the iPad later. Clients speak the Host protocol, not ACP (ADR 0008), so MCP-over-ACP, still a draft RFD, can only ever join the Host and its agents. The Host is therefore the MCP provider. Every session's agent gets one Host-owned MCP server, `weave`, whose tools come from a catalog the Host defines, less any the Host's configuration turns off; clients say in `host/hello` which of them they run. The agent sees every declared tool whoever is attached, and a call that no client can run fails at once. A call is a pending request for one client, the one that sent the running turn's latest prompt or steer, which answers with the tool's result. Clients never speak MCP, and the Host still never sends them requests.

The Host declares the server natively (`"type": "acp"`) to agents that advertise MCP-over-ACP, and to the rest as a stdio command, `weave mcp-bridge`, that relays bytes between the agent and a Host socket. Both carry MCP 2026-07-28 and nothing older. That revision has no connection handshake, so the bridge is a relay rather than a second MCP implementation, and one MCP service in the Host answers calls whichever way they arrive. When an adapter adopts MCP-over-ACP, only the declaration that agent gets changes.

## Considered options

- **Clients declare tools or MCP servers.** ACP fixes a session's MCP servers when the session is set up, sessions outlive the clients attached at that moment, and the Host protocol never takes MCP server definitions from clients.
- **Declaring only the tools attached clients can run.** A call is for the client that sent the turn, not any attached one, so such a list would still offer tools that fail. ACP sets MCP servers only at session setup while clients come and go, and changing an agent's tools mid-session throws away its prompt cache.
- **A loopback HTTP endpoint for agents without MCP-over-ACP.** Every ACP agent must accept stdio servers, and the Host's Unix socket already checks its peer's user id; a TCP port would rest on a token alone.
- **Falling back to MCP revisions before 2026-07-28.** That adds a second, stateful lifecycle, with its initialize handshake and server-sent requests, to keep in step with the first. The RFD rules out a legacy fallback for its own adapter of native servers for the same reason.
- **Letting whichever client answers first run a call.** Device tools have side effects and device-specific answers: another device's clipboard is the wrong clipboard.

## Consequences

- An agent whose MCP client doesn't speak 2026-07-28 gets no client tools, and its session says so. In October 2026 neither claude-agent-acp nor codex-acp supports MCP-over-ACP, Codex speaks 2026-07-28 to stdio servers only behind its under-development `mcp_2026_07_28` feature, and Claude Code's support is unconfirmed.
- A call whose client disconnects fails as one that may have run, and no other client retries it.
- Adding a client tool changes the Host's catalog and the clients that run it together, as an addition to the Host protocol.
