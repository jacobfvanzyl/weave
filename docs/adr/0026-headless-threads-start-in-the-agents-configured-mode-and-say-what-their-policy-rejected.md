---
status: accepted
date: 2026-11-01
---

# Headless threads start in the agent's configured mode, and say what their policy rejected

`[agents.<id>] mode` names the mode new threads start in. When it came in (WVE-82) the TUI set it once a session was open, and headless sessions were made inside the daemon, so `weave run` never got it. The Host has applied the mode in `session/create` since, but `session/run` still didn't, as a leftover rather than a decision. In WVE-109's live check a person whose Claude starts in `bypassPermissions` ran `weave run` asking it to delegate to another Host. The run's Claude was in its default mode, asked weave for permission to call `mcp__weave__list_hosts`, and the run's policy, which approves nothing without `--approve`, rejected it. Claude said only that it couldn't, and with `--detach` nobody saw even that (WVE-166).

So a session `session/run` starts is in the agent's configured mode, as one `session/create` starts is, unless the request names another (`mode`, and `weave run --mode`). An agent's own mode may then approve, without asking weave, what the thread's policy would reject. That is already true of an interactive thread in that mode, and ADR 0023 counts it: a thread's policy is only part of what it may do. The person chose the mode for that agent, and a run that wants the policy alone to decide asks for the agent's default mode.

Weave's own tools stay under the thread's policy. And when a policy rejects a permission request, the session journals a notice naming the tool, its kind and the `--approve` that would allow it, which `weave run` prints and the TUI shows, so a run whose agent was stopped says why.

## Considered options

- **Exempting the Host's own tools from the policy.** They are Host protocol methods bounded by the Host's own rules: a delegated thread's policy within its caller's, `[delegation]`'s limits, one hop to peers. But a permission request doesn't say which MCP server a tool is on; telling would mean reading each agent's own names for tools (Claude Code's `mcp__weave__…`), which weave keeps out of the Host. And `prompt_session` and `steer_session` act on any thread (ADR 0023), which a person may not want a headless agent to do unasked.
- **Keeping headless threads in the agent's default mode**, with only the notice. The policy would decide everything a run's agent asks, but a person who set the mode for an agent gets another agent in scripts and triggers than at the terminal, and every delegating script needs `--approve other`, which also approves every other tool of that kind.
- **A policy kind for weave's tools**, such as `--approve weave`: narrower than `other`, but it needs the same per-agent recognition as exempting them.

## Consequences

- Scripts, delegated threads and later triggers (WVE-125) get the agent's configured mode. One that relied on the policy alone with such a mode set now passes `--mode`, or the request's `mode`, naming the agent's default.
- A session taken up by `session/run` keeps whatever mode its agent restores, as before.
- Every rejection is a notice in the journal, so a run whose agent keeps trying the same tool shows it each time.
