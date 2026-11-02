---
status: accepted
date: 2026-11-02
---

# The Dispatcher starts work on the person's Hosts as a client of them

ADR 0011 made triggers Host features: each Host would evaluate its own schedules, take its own webhooks, and keep its own always-on agents (WVE-145, WVE-146, WVE-118). Two things that wants are hard for a Host to do for itself. A schedule should fire on time while the laptop its Host runs on sleeps, and the person wants one place to see and manage the work that runs while they're away, across all their Hosts, which later may also choose the Host a piece of work runs on. The Host's primitives for running work are close to settled: threads, journals, queues, `session/run` under request keys, headless permission policies, `sessions/watch`, Host tools and interrupted turns that continue. What goes on top should compose them, not grow the Host.

So a separate program, the **Dispatcher** (`weave dispatcher`), keeps triggers and starts work on the person's Hosts. It is a client of each Host over the Host protocol, never a peer and never a Host itself, and it runs no agents.

- **A client with the `service` role.** The Dispatcher pairs with each Host as a device does, through the tailnet (ADR 0017), and proves its own key at hello. ADR 0017 left "whether a service gets less than a paired device" for the first service, and this is it: a `service` client may do only what the Dispatcher needs, gated as peers are (ADR 0024). It runs headless turns with `session/run` under a request key made from the trigger and the occurrence's scheduled time, so a retry after a dropped connection or a restart starts nothing twice. It follows threads with `sessions/watch`, `sessions/get` and observing attaches, and renames and labels the threads it starts. It never browses files, runs terminals, answers a thread's permission requests or questions, or manages worktrees.
- **Hosts never connect to it.** Every connection between them goes from the Dispatcher to a Host, so a Host keeps working, unchanged, with no Dispatcher at all, and knows nothing about triggers.
- **Agents reach it through the Host's own MCP server, as tools a service serves.** Client tools (ADR 0009) already let a client run tools for agents: the Host offers them through `weave` and turns a call into a pending request that client answers. A `service` client may now declare tools of its own, with their definitions, which the Host keeps so agents' tool lists don't change when the service reconnects, and calls to them go to the service that declared them rather than to the client that sent the turn's prompt. The Host knows which thread made a call, because it starts there, so the Dispatcher caps a trigger an agent creates at that thread's policy, as a delegated thread is capped (ADR 0020, ADR 0023). A call while the Dispatcher is away fails as a tool error saying so.
- **Turns name their trigger.** A `service` client may give a turn an origin that names its own trigger, so a thread reads "started by schedule *daily-review*", not just the Dispatcher's device name.
- **Threads carry labels.** A client may label a thread with short strings, which listings carry and `sessions/list` and `sessions/watch` filter by. The Dispatcher labels the threads it starts; clients may group by labels. Labels mean nothing to the Host.
- **It serves the person's devices too.** The apps and the TUI pair with the Dispatcher as they pair with a Host, over the same framing and keys, to list and watch Bots and their state, manage Bots and triggers, read occurrences, and send a Bot a message, which the Dispatcher delivers in order with its triggers. A thread's conversation stays on its Host: clients attach to it there and answer its pending requests there, so the Dispatcher never relays journals and a Bot's thread can still be opened on its Host while the Dispatcher is away.
- **Its state is SQLite**: triggers, their occurrences (skipped ones and why included), the queues of work waiting for a Host, deliveries, the Hosts it is paired with and its own key. Hosts keep their files (WVE-169 asks whether they should move too).
- **It runs anywhere in the tailnet**, as its own launchd or systemd service, beside an always-on Host by default or on a machine of its own. On a single laptop it runs beside that laptop's Host.
- **The edge stays thin and holds queues.** Public webhook senders and Apple's push service can't reach the tailnet (ADR 0017), so an edge on the internet holds two queues for one Dispatcher: deliveries in, which it stores and answers at once, and pushes out, which it sends. The Dispatcher dials out to the edge over a WebSocket with its own key, drains deliveries, acknowledging each once it is in SQLite, and queues pushes. The edge holds no thread content and no webhook secrets: the Dispatcher checks signatures itself. This amends WVE-117's design, whose edge connected to every Host.

Each Host stays the authority for its threads (ADR 0011): it runs the agent, keeps the journal, applies the permission policy and holds pending requests. ADR 0011's "triggers are Host features that call `Daemon::run`" is replaced by this; its rule of one durable record per accepted occurrence moves to the Dispatcher, and the Host's request keys make delivering it safe. Interrupted turns and their continuation stay in the Host.

## Considered options

- **Triggers in each Host**, as ADR 0011 had them. A schedule on a sleeping laptop fires late or not at all, and each Host keeps its own list, with no one place for the person and no way to choose a Host later.
- **The Dispatcher as a peer Host.** Peers are Hosts: they run agents, serve the Host protocol, appear in `list_hosts` and take threads from other Hosts' agents. The Dispatcher does none of that, and as a peer every Host would have to know it.
- **Hosts calling the Dispatcher**, as MCP clients of a server it offers (ADR 0013, WVE-113), so agents could reach it. That makes each Host a client of the Dispatcher, a second direction to secure and keep up. Tools a service serves over its own connection give agents the same reach, through the same MCP server, under the same policy.
- **A coordinating Host**, which ADR 0017 rejected as "one more thing that must stay up". The Dispatcher isn't one: Hosts don't depend on it, it holds none of their state, and it does nothing a paired device couldn't.
- **The Dispatcher on the edge**, in the internet service. Trigger prompts are thread content, which ADR 0017 and WVE-117 keep off the internet.
- **A stateless edge.** A delivery that arrives while the Dispatcher is unreachable would fail, and GitHub never retries on its own. Queues at the edge cost little and keep the Dispatcher's outages invisible to senders.

## Consequences

- The Host gains four things, each an extension of one it has: the `service` role, tools a service declares and serves, a trigger origin, and thread labels. Nothing in the Host knows what a trigger is.
- WVE-145 (schedules) and WVE-146 (webhooks) become Dispatcher work; their recommendations from the research carry over. WVE-117 becomes the thin edge. Always-on agents (WVE-118) become Dispatcher records built from threads, labels and a git home, decided in their own ADR.
- A person with one laptop runs one more process. Triggers on that laptop still wait for it to wake, as a Host's own would have.
- The Dispatcher is the place to choose a Host for a piece of work later. Nothing here fixes a trigger to a Host forever: a trigger names its target, and that can become a rule.
- Pushes come from the Dispatcher, which sees every Host's pending requests through `sessions/watch`. Whether the person is present, for deciding when to push, needs a signal from clients that doesn't exist yet (WVE-147).
