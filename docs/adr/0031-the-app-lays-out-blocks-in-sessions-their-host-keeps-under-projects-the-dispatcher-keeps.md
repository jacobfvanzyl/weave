---
status: accepted
date: 2026-11-08
---

# The app lays out Blocks in Sessions their Host keeps, under Projects the Dispatcher keeps

At the desk the person works in Rex. They keep one Rex session per project, with its tabs split into panes: a TUI on a thread in one, and terminals beside it (ADR 0018, ADR 0025). They want to keep that layout but leave Rex for weave's own app (WVE-199, [research](../research/herdr-t3code-and-a-tauri-app.md)). They also want to register a piece of work, such as Odin, once, and work in it on this Mac and on homelab-1 alike.

The app today shows a thread chat-first, with a worktree's terminals in a panel beside it whose arrangement each device keeps (ADR 0022). It groups threads by repository under each Host (WVE-162). Neither the app nor the Host has a layout to share, or anything above a Host's repository.

So the app is organised as Project → Session → Blocks.

- **A Project is a named piece of the person's work, kept by the Dispatcher.**
  - It has at most one location on each of the person's Hosts: a repository, recorded by its primary worktree, or a directory outside one.
  - The Dispatcher keeps it because it is the only one of the person's programs that sees every Host (ADR 0030), and a Project is the person's, not one computer's, as WVE-187 decided.
  - A repository on another Host joins a Project when its remote matches and the person agrees. A directory joins by name.
  - Hosts learn nothing new.
- **A Session is one directory of a Project on one Host.** For a repository, that is one of its worktrees, and a directory has one Session.
  - It holds a layout: tabs, each a tree of rows, columns and stacks with Blocks at the leaves, and Blocks floating over them.
  - Its Host keeps the layout as a document it stores and versions but doesn't read, as Herdr's core keeps its layout. The newest write wins, and every client watching the Session gets each new revision.
  - A worktree's Session ends with the worktree.
- **A Block is what one pane shows.**
  - Its type has a reverse-DNS name: `weave.thread` and `weave.terminal` first, then a tool call's view (ADR 0012), a diff, a browser, and types of the person's own.
  - A Block points at a thread, a terminal or another thing on the Session's Host, and owns nothing. Closing it hides what it shows, which keeps running.
  - Any mixture of types can sit anywhere in a layout. A thread or terminal from another directory on the same Host may sit there too.
  - A client without a Block's type shows the Block's type and props as text. That is the text floor of ADR 0018.
- **Each device keeps its own view of the layout.** Focus, zoom, the tab in front and scroll positions stay on the device, as does how it presents the layout: a phone shows each tab as a stack, one Block at a time. None of this is written to the document.
- **Bots stay outside Projects and Sessions.**
  - A Bot's thread moves between Hosts (ADR 0028, ADR 0030), and a Session is on one Host.
  - Apps list Bots beside Projects. A Bot opens in a Thread Block of its own, which follows the Bot's thread to each successor.
  - A Bot's agent reaches any thread through the Host tools (ADR 0023, ADR 0029). Nothing ties a Bot to a Project.
- **"Session" takes this meaning, so the code and the wire stop using it for threads.**
  - ADR 0021 kept `session/*`, `sessions/*`, `sessionId` and the Host tools' names until the mismatch cost more than a major version of the Host protocol. A second meaning for the word costs more.
  - The Host protocol moves to version 3 and says thread throughout (WVE-200).
  - ACP's session keeps its name in ACP's methods and payloads.

## Considered options

- **Layout per device, as ADR 0022 has it for terminals.**
  - Every device would arrange a Session again, and the iPad wouldn't show what the Mac does.
  - Rex's server, Herdr's core and tmux all keep the layout beside the processes.
- **Layout in the Dispatcher.** It sees every Host, but a Session is on one Host. Its layout would disappear whenever the Dispatcher was away, even though the Host and its threads were up.
- **The Host reading the layout, with Block types in the Host protocol.**
  - The Host would model panes, and every new Block type would change the protocol.
  - Keeping an opaque document lets clients share what they place without the Host modelling devices or fidelities, which is why ADR 0018 rejected Places.
- **A Repository as the Project, one per Host.** Odin on this Mac and Odin on homelab-1 would be two things to register and two places to look.
- **A Project grouping several repositories.** Nothing asked for it, and it blurs which Session a thread belongs to.
- **Worktree, Space or Workspace as the name for Session.**
  - Worktree is git's word, and a Project may be a plain directory.
  - Space and Workspace are Herdr's and Portal's words.
  - Session is what tmux and Rex call a layout of panes, and it's the word the person reaches for.
- **Sessions spanning Hosts.** Every Block would need its Host named, and a layout would break whenever one Host was away.

## Consequences

- **Amends ADR 0022.** The Host keeps each Session's layout, so where a terminal shows is shared rather than each device's own choice. A terminal still belongs to its worktree and outlives its Blocks. Closing its Block hides it, and ending it is an action of its own.
- **Amends ADR 0021.** The code and the wire say thread (WVE-200). Every client, every paired device and the Dispatcher move to version 3 together.
- **ADR 0012 still holds:** placement stays the clients' choice. Clients write the layout, and the Host only keeps it. Handing a Block to a Surface (WVE-184) is the device's own and isn't written to the document.
- **Without the Dispatcher there are no Projects.** A client groups its Hosts' Sessions by repository, as the app does now.
- **Directories no Project names** keep their threads and terminals under their Host, as now, until the person names the directory as a Project.
- **Left to the issues:**
  - WVE-202 settles the document's shape, and whether its schema lives in the Host protocol or in the app.
    Settled there (2026-11-09): the shape is typed in `weave-host-protocol` (`sessions::layout`), with
    golden fixtures and in the schema the app's types come from, while the Host keeps the document as
    JSON it doesn't read. The Host makes a Session for any directory a thread or terminal starts in,
    inside a Project or not. `sessions/set` may name the revision it builds on, and a client may end a
    Session by hand.
  - WVE-189 settles the Project record and its commands.

## Settled in WVE-203 (2026-11-10)

- **Closing a Block closes what it shows.** This replaces "closing it hides what it shows, which keeps running", above and in ADR 0022's amendment.
  - A thread closes, as `thread/close` does, and stays among its Session's closed threads, from where it opens again in a Block. A thread exists apart from its Block.
  - A terminal ends. It is one to one with its Block: a terminal that ends anywhere takes its Block with it.
  - A client asks first when that would cut something off: a turn running, a thread waiting on the person, or a command running in the terminal.
  - Only a deliberate close does this. A Block that leaves a layout otherwise, as when another device's write drops it, leaves its thread or terminal running, to be shown again.
- **Nothing is placed for the person.** A thread or terminal started elsewhere, as by an agent, has no Block until someone gives it one: clients list what a Session has that isn't shown. Placing puts a Block in the focused pane, for every device.
- **A Session nobody arranged shows its open threads in one pane,** the most recently active in front. Clients don't save that until the person changes something.
- **Apps list Sessions, not threads.** A Session shows for every directory with a thread or terminal, whether or not its Host has made one of it yet; the Dispatcher's Projects group them, and those in no Project stay under their Host.
- **"Tab" is the word,** not Rex's "window": the document says tabs, and the Mac app has windows of its own.
- **A change to a layout names the revision it was made on** (`ifRevision`). When another device saved first, the client makes the change again on what that device saved, so neither loses the other's.
