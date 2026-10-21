# acp-core

ACP for the Host (`weave-acp-core`): agent launch, the ACP connection, client-side handlers and
the protocol trace. No UI. Read the root `AGENTS.md` first, its SDK rules above all.

Keep protocol behavior in `acp-core`. Client services (`fs/*`, `terminal/*`) live there
and are advertised per `ClientOptions`; never advertise one that isn't answered. Real
adapters may not call them (Claude's runs its own tools), so the fake agent is what
exercises them: integration tests connect it in-process over `Channel::duplex`, and its
prompt scripts (`/run`, `/write`, `/read`, `/kill-after`, `/plan`, `/slow`, `/compact`,
`/delegate`, `/tool`) drive the
real TUI.

`acp-core` also declares and handles the terminal output extension
(`_meta.terminal_output_delta`, Zed's convention that codex-acp and claude-agent-acp use for
commands they run themselves): `terminal_meta.rs` turns its chunks and exits into the same
terminal events as client terminals, including in replayed sessions. It handles the
steering extension too (WVE-86; `steering.rs`): agents that advertise `_meta.steering.supported` take
`_session/steering`, a steer for the running turn. `AgentHandle::steer` asks with
`idleBehavior: "promptRequired"`, so an agent whose turn ended hands it back rather than
starting a turn of its own, and its answer arrives as `AgentEvent::Steered`, in order with the
turn's updates. The fake agent takes it too: a turn answers its steers before ending, and
`slow` stops its chunks for them.

Subagents follow the current draft of the Subagent Sessions RFD (`subagent_update`,
session-directed messages, `running`/`idle` states). claude-agent-acp and codex-acp still
send the earlier draft (`subagent_spawned`, `subagent_state_update`), which the pinned schema
rejects, so `subagent_compat.rs` reads it first, as the current draft, in an untyped handler
registered before the typed one. Delete it once the adapters move over.

- Advertise only client capabilities that are fully implemented, and gate every optional
  agent method on its capability in `acp-core` (`AgentHandle`), before anything is sent.
