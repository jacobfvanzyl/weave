---
status: accepted
date: 2026-10-19
---

# Show MCP Apps views by doing the MCP side in the Host and rendering in clients

MCP Apps lets a tool name a `ui://` page that whoever holds the MCP connection renders, but in weave the agent holds it. No terminal agent renders views, and neither claude-agent-acp nor codex-acp passes them on to ACP clients ([research](../research/mcp-ui-and-agent-ui-protocols.md)). So the Host does the MCP side of hosting for the tools it answers or fronts (ADR 0009, ADR 0013), and each client renders. The Host reads `ui://` pages and caches them by content hash, keeps each call's complete result, journals a view event with its input, result and page, and carries out the view's own requests (tool calls, resource reads, messages, model context) under the session's permission policy. A client runs the ext-apps bridge without an MCP client inside a sandboxed frame and turns the view's requests into Host protocol requests. Clients never speak MCP, and the Host still never sends them requests. The agent gets only the tool's text, because Claude Code gives the model `structuredContent` in place of it. The Host always declares the UI extension, whoever is attached, so an agent's tools do not change with attachment. Placement and display mode belong to each client. A late, reconnecting or scrolling-back client rebuilds a view from the journal with the page it was made with, and each server gets a stable origin with storage that lasts, since views keep their own state in `localStorage`. Content a model wrote runs in a nested sandbox without the bridge.

## Considered options

- **Waiting for agents to render, or for adapters to forward views.** No terminal agent renders. The Agent SDK and the Codex app-server have host hooks that the adapters don't use. That leaves out the tools weave answers itself and does not settle several clients or replay.
- **Clients speaking MCP to servers.** It breaks ADR 0009, cannot reach stdio servers on the Host's computer from another device, and spreads server credentials across devices.
- **ACP Embedded Views or Goose's `_meta` profile.** Embedded Views is an unreviewed proposal. Goose's profile is private and assumes one client.
- **AG-UI.** A third event model beside ACP and the Host protocol, for a layer weave already has.

## Consequences

- Until adapters pass views on, views come only from tools the Host answers or fronts. MCP servers an agent loads itself show text.
- A view can be seen only in a client that can host a web view, so the first such client is on the critical path. The TUI shows the text and says that a view exists.
- A headless run's views appear when someone attaches, from the journal.
- Views are untrusted pages on the person's devices: CSP comes only from what the page declares, device permissions are granted per device, and links follow the URL elicitation rule.
