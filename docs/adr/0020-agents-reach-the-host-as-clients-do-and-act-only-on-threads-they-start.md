---
status: accepted
date: 2026-10-23
---

# Agents reach the Host as clients do, through Host tools, and act only on the threads they start

A thread's agent should be able to hand work to another agent through the Host (WVE-106): Claude starting a Codex thread, prompting it, steering or cancelling its turn, and learning how the turn ended, with journals, attached clients and permission policies intact, and without weave owning an agent loop (ADR 0011). The Host offers this through Host tools on the Host MCP server (ADR 0009), and every Host tool is a projection of a Host protocol method: the same parameters, less what the calling thread supplies, answered by the same code as the client request. No tool does what no client request can, so a capability lands in the protocol first and becomes a tool after. The first are `list_sessions` (`sessions/list`), `start_session` (`session/run`), `prompt_session` (`queue/add`), `steer_session` (`turn/steer`), `cancel_session_turn` (`turn/cancel`) and `read_session` (`sessions/get`, new for this).

A thread an agent starts is a delegated thread: a thread of its own, with its own journal and its own agent process, which clients list and attach to like any other, and which records the thread that started it. Its turns' origin names that thread. An agent reads any thread on its Host but acts only on the threads it started, and theirs. A delegated thread approves no tool kind the calling thread's policy doesn't, and rejects what that policy would reject; the Host narrows a request for more rather than refusing it. Its permission requests and elicitations wait for people, as any thread's do: the calling agent is told that a delegated thread waits, and never answers for it.

No tool call waits for a turn. Starting or prompting answers once the turn has started or the prompt is queued. When a turn the calling thread started ends, the Host tells the calling thread, steering a message into its running turn or else adding it to its queue (WVE-107), which starts its next turn; a calling thread that isn't open is taken up again for it. A cap on how deep threads may start threads (one level by default) and on how many delegated threads of one thread may run at once (three by default) keeps delegation from running away.

## Considered options

- **Tools that wait for the delegated turn to end.** The calling turn would block for as long as the other agent works, agents' MCP clients time tool calls out, and nothing of the wait survives a Host restart. The queue delivers the end once, durably.
- **Acting on any thread on the Host.** A prompt-injected agent could then drive a headless thread whose policy approves more than its own. Reading other threads risks less, and helps an agent pick up work a person started.
- **Delegated threads as subagent threads**, ACP's subagent sessions. A subagent thread shares its parent's agent process and journal, so it can't run another agent, and clients can't attach to it on its own.
- **Letting the calling agent answer the delegated thread's requests.** One agent approving another's tools would step around the person's policy, which is the point of asking.
- **Polling `read_session` for the turn's end.** Each poll costs the calling agent a tool call and tokens, and an agent that stops polling never learns the result.
- **Turning on Codex's MCP 2026-07-28 support in the Codex preset.** It is behind Codex's under-development `mcp_2026_07_28` feature, and turning it on for every weave user would change how their own Codex reaches every MCP server. The preset leaves it to the person's Codex configuration.

## Consequences

- `TurnOrigin` gains `session`, and listings and thread state gain `startedBy`: additions, so protocol version 2 stays.
- A calling thread can start a turn with nobody attached, when a delegated turn's end reaches it. That turn runs under the calling thread's own policy, asking people for anything it doesn't approve.
- Only agents whose MCP client speaks 2026-07-28 get Host tools (ADR 0009). In October 2026 that is Claude Code, through the Claude preset, and Codex where its person turned `mcp_2026_07_28` on; otherwise Codex can be delegated to but can't delegate.
- Tools that reach threads on the person's other Hosts (WVE-109, ADR 0017) take a `host` argument within this model, rather than a tool set per Host.
