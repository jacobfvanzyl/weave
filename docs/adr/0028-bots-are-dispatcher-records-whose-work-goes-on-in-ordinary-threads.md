---
status: accepted; amended by ADR 0030: a Bot's thread is reached through the Dispatcher, and a Bot moves to another Host by starting a new thread; settled for a first version in WVE-118, below: one named Host per Bot, the person prompting its thread as any thread, schedules that name it, and the Dispatcher's compacting and relayed triggers deferred; settled for the app in WVE-178, below: a Bot opens as a Session of its own kind, the person makes Bots in the app or the CLI and Bots make them too, the Bot's Host makes its home, and a Bot manages its own schedules
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

## Settled in WVE-118 (2026-11-10)

Planned again with the person in light of ADR 0030, WVE-203 and what the Hosts do today, this narrows the decisions above to a first version.

- **What stays.** A Bot is a Dispatcher record whose work goes on in ordinary threads, and its Host learns nothing of Bots. It has one current thread at a time, its memory is files in a git home, and its threads carry its label, `bot:<id>`, beside the Dispatcher's `dispatcher`. Bots belong to no Project, and work in Projects by name through the Host tools (WVE-208).
- **The person prompts the Bot's thread as any thread,** over the Host protocol: through the Dispatcher from a device, or over the Host's socket on its own computer. This replaces "the person's messages, sent through the Dispatcher", above: since ADR 0030 every device reaches every thread through the Dispatcher, so a Bot's thread needs no way in of its own. The Host's queue orders their prompts and the Bot's schedules', as it does any thread's.
  - `bots/send` stays, as a delivery, for senders that aren't attached: the CLI and scripts, and a Bot with no thread yet, whose first prompt starts one.
- **One Host per Bot, named as a schedule names one.** This replaces "a rule later, when the Dispatcher chooses Hosts", above, and ADR 0030's Dispatcher choosing the Host each time it starts a Bot's thread.
  - The Dispatcher choosing a Host, and a Bot moving by cloning its home, wait for WVE-217 and a successor on another Host. `thread/setSuccessor` names only a thread on the same Host.
- **The home is a Host and a path.** Recording it as a Project's locations are, and matching its remote, wait for moving. `weave bots add` makes the directory, `git init`s it and writes its first `AGENTS.md` and `CLAUDE.md` when it runs on the Bot's Host's computer, the only one that can, and leaves what was there as it was. Elsewhere it takes a directory there and says what to run on that computer.
- **A Bot's schedule is an ordinary schedule that names the Bot** in place of a Host and thread, queued into its current thread, with `overlap: skip`. This replaces the separate rule for heartbeats: the Host's queue waits for the thread, and a schedule's catch-up folds missed times into one.
  - A schedule may be a one-off, at one time. A Bot asks for its own, its wake-ups, with the Dispatcher's first service tools (`wake_me`, `list_wakeups`, `cancel_wakeup`), which answer only a Bot's own threads.
- **The policy's default is to ask** (`otherwise: ask`), so what it doesn't approve waits for the person, and the Bot shows as needing them. A request left waiting longer than the Bot allows, 12 hours unless it says otherwise, pauses the Bot: its schedules' occurrences are skipped until the request is answered.
- **A new thread when the person asks, or daily at an hour if the Bot is set so,** once the old thread is idle: a turn there that saves to the memory files, leaves a dated note in the home's `threads/` and commits, then a new thread in the home, which the old one names as its successor. This replaces the new thread "when compaction stops freeing enough". The Dispatcher writes each step down with what it sends, so a restart repeats nothing.

Deferred:

- **The Dispatcher saving memory and prompting `/compact` below the agent's own threshold, and a new thread when compacting stops freeing enough.** The agent compacts itself, and the home's `AGENTS.md` tells it to write memory as it goes. `thread/run` takes no `env` to lower the threshold through, and none of the products surveyed rotates on that signal. The Host's context usage in listings (WVE-174) stays, for when this comes.
- **A trigger running in a fresh thread whose result the Dispatcher relays.** The Bot starts a delegated thread itself, and the Host's report comes back to it (ADR 0023).
- **The push when a Bot's requests go unanswered** (WVE-177). The pause stays, and the Bot's state says it needs the person.
- **"Unread" in a Bot's state** (WVE-178).
- **Clients other than `weave bots`.** The app's and the TUI's lists of Bots, and Rex's Bots session, come later; meanwhile a Bot's thread opens as any thread does.

## Settled in WVE-178 (2026-11-11)

Planned with the person for the app, with making Bots without the CLI folded in rather than tracked apart.

- **A Bot opens as a Session.** In the person's words, a Bot is "a slightly special type of Session": the one at its home on its Host, listed under Bots, above the Projects, and nowhere else, "skinned not to have multiple Tabs at all and a single Thread block that is always locked to the top left". Other Blocks, terminals and the like, sit beside the Bot's thread, to its right, below it or floating, never before it, and there's no second Thread Block. The app keeps that Block on the Bot's current thread, so it follows each new one. This replaces "a Bot opens on its current thread, in the same thread view as any other", above, and ADR 0031's Bot opening in a Thread Block of its own outside Sessions, which was written while a Bot's thread could move between Hosts: since WVE-118 a Bot is on one Host, as a Session is.
  - The Host still learns nothing of Bots. The Session is an ordinary one that the app lists as the Bot's, and lists under its Host again once the Bot is removed.
  - A Bot's page, from its name atop the Session, changes what `bots/update` changes, lists its schedules and wake-ups to pause, resume, run now or remove, and its earlier threads to read, and lists the threads it started elsewhere. Tapping one of those gives it a Block in its directory's Session, making that Session if there's none.
- **Bots are made "just like Grok Bot":** the person creates a Bot, in the app or the CLI, or an existing Bot creates other Bots when the person asks it to (`create_bot`). A Bot made by a Bot is recorded with its maker and does nothing until the person prompts it: none of the Dispatcher's tools lets a Bot prompt or schedule another. A Bot makes one only while there are fewer than 20; the person isn't held to that.
- **The Bot's Host makes its home.** `bots/add` has it make the home with `repos/init`, a repository of its own with its first files committed, which any client can use and which says nothing of Bots. The Bot is added only once its home is made, and keeps it as the Host gives it, whole; what it's for, its job in the person's words, starts its `AGENTS.md`. This replaces "`weave bots add` makes the directory … when it runs on the Bot's Host's computer, the only one that can … Elsewhere it … says what to run on that computer", above: the app, the CLI on any computer and a Bot all make one on any Host that's connected.
- **A Bot manages its own schedules,** so the app has no form to add one: "as long as Bots can access their own schedules then I can just prompt them to manage schedules." With the Dispatcher's tools a Bot adds a recurring schedule that names it, and lists, pauses, resumes and removes those that name it, the person's too, but not its wake-ups or another Bot's. One it adds comes every five minutes at most, and it adds none while 20 name it. This is the agents' own schedules that WVE-173 has for later, for Bots alone.
- **"Unread" is each device's own,** as a thread's is, not part of the Bot's state the Dispatcher keeps. This settles its deferral above.
- **Clients watch the Bots** (`bots/watch`), as they watch threads, so the app's list stays current.

Deferred:

- **Changing a Bot's policy in the app.** It shows the policy; `weave bots update --approve` changes it.
- **The TUI's list of Bots and Rex's Bots session.**
- **The push when a Bot needs the person** (WVE-177), as before.
