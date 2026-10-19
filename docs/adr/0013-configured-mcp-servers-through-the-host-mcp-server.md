---
status: accepted
date: 2026-10-19
---

# Offer configured MCP servers through the Host MCP server

The Host passes the MCP servers in its configuration to each agent, so it never sees their calls, their results or their views (ADR 0012), and cannot change which tools are available during a session. Instead the Host connects to each configured server itself, as an MCP client, and offers its tools through the one Host MCP server every session already has (ADR 0009), under names that say which server they belong to. Toward those upstream servers the Host can truthfully declare the MCP Apps extension, speak whichever revision each one needs, and turn their elicitations into pending requests. Toward the agent it stays `weave` on MCP 2026-07-28. Availability follows Host state, such as the person enabling a server or a server's own list changing, and is announced with `notifications/tools/list_changed`. It never follows the agent's own calls, which MCP 2026-07-28 forbids, and changes stay rare because they cost the model's prompt cache. Client tools stay always declared, as ADR 0009 decided. Agents that cannot speak 2026-07-28 keep receiving configured servers directly, without views or availability control. The Claude preset sets `MCP_SDK_GENERATION=v2`, because Claude Code speaks 2026-07-28 only on that MCP runtime.

## Considered options

- **Passing servers to agents, as today.** The Host sees nothing, so it has no views, no record of calls and no availability control.
- **An inspecting proxy on `weave mcp-bridge`.** It would rewrite the agent's traffic, could not serve servers on older revisions without becoming a stateful proxy, and could only guess which MCP call belonged to which ACP tool call.
- **Fixed search-and-call tools in front of a catalog.** The tool list never changes, but models use real tools better, permissions would see one tool, and Claude Code's tool search already defers large catalogs.
- **A tool that enables other tools.** MCP 2026-07-28 says the tool list must not vary as a side effect of other requests.

## Consequences

- An agent's own per-server permission rules collapse into `mcp__weave__*`, so per-tool gating is the Host's permission policy.
- Names must fit agents' limits: Claude Code leaves out tools whose full name passes 128 characters.
- The Host holds no OAuth tokens until that is decided separately. Servers that need them stay declared to agents directly.
- MCP servers an agent loads from its own configuration stay outside.
