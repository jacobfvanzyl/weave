---
status: accepted; amended by ADR 0030: a Bot's thread is reached through the Dispatcher, and a Bot moves to another Host by starting a new thread
date: 2026-11-02
---

# Bots are Dispatcher records whose work goes on in ordinary threads

The person wants assistants they come back to by name over weeks, which triggers wake and which carry what they learned from one conversation to the next (WVE-118). The products that have them, Grok Bot, OpenAI's dots, OpenClaw and Hermes's Bot Mode, run the same agent loop as any conversation; what sets them apart is a named record above the conversations, one current conversation that the person's messages and the triggers' work go into, and a way to keep that conversation usable for weeks ([research](../research/always-on-agents-and-long-running-context.md)). Weave already has the conversation, the thread, and owns no loop (ADR 0011), so a **Bot** is the named record, kept by the Dispatcher (ADR 0027) and built from the Host's primitives.

- **What a Bot is.** A Dispatcher record: a name, an agent id, a permission policy, the Host its work runs on (a rule later, when the Dispatcher chooses Hosts), its triggers, its current thread, and a home directory that is a git repository on that Host. Its memory is files in the home, `CLAUDE.md` or `AGENTS.md` and notes beside them, which the agent reads as any thread in that directory does and edits as it goes; weave keeps no memory of its own. The Bot's threads carry its label. Its current thread needs no name of its own.
- **One thread at a time.** The person's messages, sent through the Dispatcher, and the triggers that prompt the Bot go into its current thread, in order, through the thread's queue under request keys. A trigger may instead run in a fresh thread of its own, whose result the Dispatcher passes back into the current thread when the trigger's prompt says it's worth it; a turn a client starts reports to nobody, so the Dispatcher relays it itself. Heartbeats that prompt the current thread wait until it is idle, and missed ones fold into one.
- **Context over weeks: compact in place.** The agent compacts its own context, as Claude Code and Codex do. The Dispatcher keeps its own threshold below the agent's (through the agent's `env`, such as Claude Code's `CLAUDE_CODE_AUTO_COMPACT_WINDOW`), so it gets there first: it prompts the thread to save what's worth keeping to the home and commit, waits for that turn to end, then prompts `/compact` when the thread lists that command. Claude Code reads its memory files again after compacting.
- **A new thread when compaction stops freeing enough.** If the thread starts out above a threshold right after compacting, the Dispatcher saves memory as before and starts a new thread in the home, the old thread naming it as its successor, and holds the Bot's triggers until it exists. A Bot may also start a new thread daily at an hour, and the person may start one when they like. Each new thread leaves a dated note in the home about the one before.
- **Clients.** Apps list Bots at the top of their sidebar, as a chat app lists conversations, from the Dispatcher, with each Bot's state: needs the person, working, unread or idle. A Bot opens on its current thread, in the same thread view as any other; nothing in a thread's view is Bot-specific. Bot threads don't appear in the Hosts' ordinary thread lists. The TUI lists Bots the same way, and in Rex a "Bots" session keeps a tab per Bot, each running the TUI on the Bot's current thread and following it into a new one, as the app's threads open in Rex (ADR 0025). Pushes for a Bot open the Bot.

The Host gains what any client could use, not a notion of Bots:

- context usage, the latest `usage_update` and the last completed compaction, in thread listings and `sessions/watch`, so one watch tells the Dispatcher when to compact or rotate;
- a successor on a thread, which clients offer to follow and reports to the old thread follow, designed with WVE-168's following of an interrupted turn into its continuation as one rule;
- labelled threads kept past the journals' 14-day pruning;
- later, reading a whole thread's journal, open or not, and searching journals, as a method and a Host tool.

## Considered options

- **A Bot as a Host record**, as WVE-118 first had it, with the Host keeping its name, home and run of threads. Clients would see it through the Hosts they already talk to, but it would be fixed to one Host, which rules out the Dispatcher choosing one, and would put a concept into the Host that threads, labels and a successor already make up.
- **The conversation through the Dispatcher**, the Dispatcher relaying the Bot's thread to clients. It would rebuild attaching and replay, add a hop, and leave a Bot silent while the Dispatcher is away though its Host is up.
- **A new thread on every boundary**, daily or per trigger, as Hermes's docs argue "memory only pays off at boundaries". With Claude Code reading memory again after compacting, compacting in place keeps the conversation and gets the boundary anyway. Daily rotation stays an option.
- **A name for the current thread**, OpenClaw's Home or Hermes's Bot Chat. It is the Bot's thread; a second term adds nothing.
- **Another word than Bot**: Resident, Steward, Aide, Persona. Bot is what Grok Bot and Hermes's Bot Mode call exactly this record.
- **A Bot-specific chat view** that folds tool calls or heartbeats. Not yet: a Bot's thread is a thread.

## Consequences

- ACP lets no client ask for compaction or warns before an agent's own; prompting `/compact` is the adapters' convention, found among the commands a thread lists rather than by knowing the agent. Codex's adapter reports compaction only as text, so a Codex Bot's rotation can't rely on it.
- Every message into a Bot's thread is a turn: no ACP client can add context without one.
- A Bot's home lives on its Host, so a Bot moves to another Host by cloning its home there, which is what lets the Dispatcher choose Hosts later.
