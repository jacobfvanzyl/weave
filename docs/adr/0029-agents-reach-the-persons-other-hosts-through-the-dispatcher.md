---
status: accepted
date: 2026-11-04
---

# Agents reach the person's other Hosts through the Dispatcher, and Hosts stop pairing with each other

ADR 0017 let a Host's agents reach the person's other Hosts by pairing each Host with the others as peer Hosts, and WVE-109 built that: a Host connects to a peer as a remote client, records a start before sending it, sends it again under a request key until the peer answers, follows the turn there across restarts and reports how it ended. The Dispatcher (ADR 0027, WVE-175) then came to do each of those things for its own work: it is paired with every Host as a service, keeps an outbox of keyed requests it sends again on every connection, and follows threads with `sessions/watch`. The service gate already allows every method the peer gate does. Two ways to send work between computers and follow it is one too many, and with five computers peering means twenty pairings where the Dispatcher needs five.

So a Host's agents now reach the person's other Hosts through the Dispatcher, and Hosts no longer pair with each other.

- **The tools stay.** The thread tools keep their optional `host` (ADR 0020, ADR 0023), and `list_hosts` stays, so agents and their instructions don't change and each tool is still a projection of a Host protocol method. When a call names another Host, the Host passes it to the Dispatcher over the Dispatcher's own connection, as a call to a tool a service serves (WVE-171): the method's request as it would send it to a peer today, with the calling thread, the policy it asks for within that thread's, and the directory worked out under the home, `~/…`, with the repository's remote. `list_hosts` lists the Hosts the Dispatcher is paired with and how it reaches each.
- **A service says it reaches the person's Hosts.** The Dispatcher declares that with its tools; the Host keeps it as it keeps them, and passes calls naming another Host to the last service that declared it. With none, or with it away, such a call fails at once as a tool error saying so, as a call to an unreachable peer does now.
- **The Dispatcher keeps the call.** It writes the request to its outbox, under a key made from the calling Host, thread and the agent's own key, before it sends it, and sends it to the named Host only while connected to it: a call for a Host it can't reach fails at once, with nothing left to send. A call whose answer the calling Host lost still lands, and the Dispatcher tells the calling thread it started, so the calling Host keeps no record of its own.
- **It follows and reports.** The Dispatcher follows a turn it began for another Host's thread, through the `sessions/watch` it keeps anyway, and adds a report to the calling thread's queue when the turn ends or waits on a person there, as the calling Host does for its own threads (ADR 0023). A service may now give the two origins peers give today: a thread on another Host, and a report on one.
- **One hop stays, and moves.** The Host works out whether a calling turn works for another Host's thread from its origin, as it does now from the peer that began it, and passes no such call on; the Dispatcher refuses one too. Delegation limits and the policy ceiling apply as they do across peers now.

Clients keep connecting to each Host for its threads, and answer pending requests there, as ADR 0028 decided for Bots: the conversation never goes through the Dispatcher. Delegation on one Host never touches it.

## Considered options

- **Keep peer Hosts beside the Dispatcher.** Two durable ways to send and follow work between the same computers, and pairings that grow with the square of the Hosts.
- **The Dispatcher declares its own cross-Host tools**, leaving the Host's tools to this Host only. The Host knows less, but agents get two ways to start a thread and the tools stop mirroring the protocol's methods.
- **Everything through the Dispatcher**, clients included, so each device pairs once. ADR 0028 rejected relaying conversations: it rebuilds attaching and replay, adds a hop, and leaves a thread unreachable while the Dispatcher is away though its Host is up.
- **Queueing a call for a Host that's down** in the Dispatcher's outbox. An agent that calls another Host wants to know now whether it started; a start that lands hours later surprises it.

## Consequences

- Reaching another Host needs the Dispatcher running, which ADR 0017 avoided by rejecting a coordinating Host. It runs beside the always-on Host by default, the named Host has to be up anyway, and Hosts still don't depend on it for anything else.
- Peer Hosts go: `peers.rs`, `peers.json`, `peers/*`, the peer gate (`FOR_PEERS`) and `weave hosts`, replaced by `weave dispatcher add-host`, which already pairs over SSH. The Host's own key goes with them, so a Host keeps no secrets again (ADR 0010). Existing peer pairings are revoked as devices, and `CONTEXT.md` loses **Peer Host**.
- The Dispatcher's key can now drive every Host on behalf of their agents, as it already could for triggers; a Host's key copied off a Linux computer no longer reaches its peers, because there are none.
- This amends ADR 0017 (Hosts pair as peers), ADR 0024 (what a peer may do and pairing both ways, both retired) and ADR 0027 (a service may give a thread origin naming another Host, and may say it reaches the person's Hosts).
