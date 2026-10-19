---
status: accepted
date: 2026-10-19
---

# Keep the Host as the runtime authority, and own an agent loop only as an ACP agent

Mastra and Pi Durable were both considered as the foundation of a persistent agent runtime that serves interactive coding and headless, triggered work alike, and as replacements for all or part of the Host ([research](../research/mastra-vs-pi-durable-agent-runtime.md)). The weave Host stays the authority for sessions, journals, attached clients, pending requests, permission policies, remote devices and triggers. Agent loops stay inside ACP agents, with Claude Code and Codex doing interactive coding on the person's own login. Triggers (schedules and webhooks) are Host features that call `Daemon::run`. A turn interrupted by a Host restart is handled in the Host: it drains running turns, a headless policy may continue a cut-off turn, and a supervisor that keeps agent processes alive across restarts can come later. If weave ever owns an agent loop, it is an ACP agent the Host launches like any preset. Pi Durable is the candidate for that loop, once it has released durable sleeps, a durable wait for an outside answer, and a storage format that holds still. Claude in such a loop is billed by API key: Anthropic's terms do not let a third-party application send requests on Free, Pro or Max credentials, while signing in to the unmodified Claude Code binary is allowed.

## Considered options

- **Mastra as the Host.** Its interactive server stream does not replay missed events, durable agents are beta with crash recovery off by default and tools that run again on recovery, and `@mastra/core` alone is about 331,000 lines with telemetry on by default and breaking changes in minor releases. It suits a hosted multi-tenant service, which weave is not.
- **Pi Durable as the Host.** Its semantics are the more careful ones (intent before effect, tools that do not run twice by default), but it is experimental, has no server, authentication or replay, and lets one process own its storage.
- **A TypeScript Host built on either.** Weave would rebuild the journal and attach contract it already has, in a second language, for features the Host can add itself.

## Consequences

- No framework can checkpoint inside a Claude Code or Codex turn. Their durability is whatever the Host provides around their processes.
- Triggers are not a revival of the retired Automation engine (ADR 0003). There is no workflow engine; WVE-64's rule of one durable record per accepted occurrence is reused.
- A loop weave owns costs API usage, so it fits headless, triggered and custom-tool work, not replacing interactive coding.
