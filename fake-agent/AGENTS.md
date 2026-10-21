# fake-agent

A scripted ACP agent (`weave-fake-agent`) for tests and live runs: a prompt's first word picks a
script (`src/lib.rs` lists them). Read the root `AGENTS.md` first.

The fake agent reads `WEAVE_FAKE_AGENT_STATE` (persist sessions and sign-in to this JSON
file, which its processes share and merge as an agent's own storage would),
`WEAVE_FAKE_AGENT_REQUIRE_AUTH=1`, `WEAVE_FAKE_AGENT_PAGE_SIZE`, and
`WEAVE_FAKE_AGENT_MCP_ACP=1` (advertise `mcpCapabilities.acp`). Its scripts also include
`/ask` (form elicitation), `/connect` (URL elicitation), `/mcp`, `/tool <name> <json>` (a
call on the session's `weave` MCP server, over ACP or by starting its stdio command) and
`/mcp-legacy` (opening `weave` with `initialize`, as a client before MCP 2026-07-28 would).
