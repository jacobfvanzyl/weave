# agents

Which agents there are and how to launch them (`weave-agents`): config, presets, the ACP
registry, the login shell's environment, and `weave update`. Read the root `AGENTS.md` first.

- Agent presets pin adapter versions. Bump them deliberately and re-run the
  smoke check against each one. A preset may set environment under the config's: Claude's
  sets `MCP_SDK_GENERATION=v2` and `MCP_PROTOCOL_NEGOTIATION=auto`, since Claude Code speaks
  MCP 2026-07-28, which the Host MCP server needs, only on that MCP runtime (ADR 0013). `weave update` (WVE-92; `agents/src/update.rs`, which the
  Host's `agents/update` shares, with `cli/src/update.rs` its command line) moves past the
  pins without a rebuild: it writes newer versions to `agents.lock` beside the config
  (`agents/src/lock.rs`), after each answers ACP `initialize`, and every launch takes the newer
  of the built-in and locked version. Adapters run the CLI they bundle unless the agent's
  `env` sets `CLAUDE_CODE_EXECUTABLE` or `CODEX_PATH`. Registry agents (`agents/src/registry.rs`) launch exactly as
  the ACP registry describes them, with the version it lists; never add per-agent fixes
  there.
