---
status: accepted; amended on 2026-11-14 (WVE-147): what a headless thread's policy would reject goes first to a person attached to it, and a rejection after nobody answered says it expired
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

## Amended 2026-11-14: a person attached answers first (WVE-147)

A headless thread's policy answered every request, even while a person had the thread open. Now it answers at once only what it approves, and what it would reject while nobody is attached. What it would reject, and an elicitation it would dismiss, goes to the clients attached when the request comes, as an ordinary pending request, and the person's answer stands. Nobody answering within the answer deadline, 30 minutes from when the request was offered, not from when anyone looked, the policy rejects it. A deadline never approves anything. The last client detaching first has the policy reject it then. Observers aren't clients, and the client `thread/run` attaches, as `weave run`'s is, doesn't count either: it's a script following its run, and it stops waiting when the turn waits on a person, so counting it would offer every run's rejections to nobody.

A rejection after nobody answered is a notice of its own, distinguishable from the policy's plain one: "The request for “Write a.rs” expired unanswered after 30 minutes, so this thread's policy rejected it: …", or "… when the last client left, …", followed by the kind and its `--approve`, as before. An elicitation that expired says the policy dismissed it. The request resolves as `cancelled`, as one whose turn ended does, so no client needs a new outcome to read it.

The research behind it is `docs/research/agents-that-work-while-the-person-is-away.md`, §7.3: products that offer an unattended run's requests to a person let them wait or expire to no, and none approves on a timeout.

- A headless thread with a person attached waits on them, as an interactive thread does: it's `waiting` in listings, a Bot whose policy rejects goes `needsYou`, and whatever waits for its turn, a schedule's occurrence or `weave threads prompt --wait`, waits up to the deadline too, or stops for the person as it does for an interactive thread.
- The deadline is the Host's `DaemonConfig.answer_deadline` (`DEFAULT_ANSWER_DEADLINE`), not yet in the config file.
