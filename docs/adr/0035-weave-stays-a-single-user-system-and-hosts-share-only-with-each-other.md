---
status: accepted
date: 2026-10-22
---

# weave stays a single-user system, and Hosts share only with each other

A brainstorm on 2026-10-22 looked at where weave could grow: chat channels in the style of Hermes or OpenClaw, multiplayer sessions with guests, several people on one Host, and hosted multi-tenancy. The person decided weave stays a personal agent system for one person until they have used it long enough for real use to shape the model, and until ACP, the vendors' agents and their terms settle.

One Host serves one person. If sharing comes, it happens between Hosts, never through tenancy inside one.

What that brainstorm took forward is all single-user: Host-made session directories (WVE-115), always-on agents (WVE-118), an internet edge the Host dials out to for webhooks and push (WVE-117), a Linux Host (WVE-116) and a Host in a cloud container (WVE-119).

## Considered options

- **Design for several people now.** Every protocol type, permission policy and journal would carry a principal and per-person attribution before anyone has used weave with a second person, while ACP and the agents' terms are still moving under it.
- **Channels and multiplayer sessions.** These need routing, identity and moderation that one person's agents don't, and they would shape the Host around a use nobody has yet.

## Consequences

- **New work assumes one person.** Don't design for several principals, per-person attribution or channel routing, and don't propose them unprompted.
- **Sharing between Hosts stays open.** If a design would close that off later, say so briefly instead of designing for it now.
- **Nothing is filed for the deferred work.** Channels, guests, multi-user Hosts and hosted tenancy have no issues until this decision is revisited.
