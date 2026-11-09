# weave

The `weave` terminal client and the Host it connects to, which runs ACP agents and keeps their threads going for any number of clients.

## Language

### Host and clients

**Host**:
The long-lived per-user process on one computer that runs agents and owns their threads, outliving the clients connected to it.
_Avoid_: server, Portal, Host Daemon

**Client**:
A program connected to the Host on someone's behalf, such as the TUI, `weave run`, or a later iPad app.
_Avoid_: frontend, UI, consumer

**Remote client**:
A client on another computer than the Host's, which reaches it through the Dispatcher on behalf of a paired device.
_Avoid_: network client, mobile client

**Paired device**:
A device of the person's that the Dispatcher has paired with, and lets reach the person's Hosts until it's revoked there.
_Avoid_: credential, principal, token

**Agent**:
An ACP agent program the Host can launch, known by an id: a preset, one defined in the Host's configuration, or one from the ACP registry.
_Avoid_: adapter, provider, model

**Agent update**:
A newer version of a preset's or registry agent's program than the one a thread's process runs, which the Host looks for when the thread opens.
_Avoid_: upgrade, new release

**Client tool**:
A tool the Host offers a thread's agent that an attached client runs on its own device, such as putting text on that device's clipboard.
_Avoid_: client-side MCP server, frontend tool, local tool

**Host MCP server**:
The one MCP server, `weave`, that the Host offers every thread's agent, carrying client tools, the Host's own tools and the tools of upstream servers.
_Avoid_: weave MCP, bridge, proxy, gateway

**Upstream server**:
An MCP server in the Host's configuration that the Host connects to itself and offers through the Host MCP server.
_Avoid_: proxied server, backend server

**Service**:
A client that does work for the person rather than showing them anything, such as the Dispatcher. A Host lets it do less than a paired device.
_Avoid_: integration, daemon, bot

**Service tool**:
A tool the Host offers threads' agents that a service declares and runs, answering each call over its own connection.
_Avoid_: remote tool, plugin

### Threads

**Thread**:
A conversation with one agent in one directory on one Host, which it never leaves, identified by the id of the agent's ACP session.
_Avoid_: session (a Session is something else, and ACP's session is the agent's side of a thread), chat, conversation

**Open thread**:
A thread the Host holds with its agent running, which clients can attach to and prompt.
_Avoid_: live thread, active thread

**Suspended thread**:
A thread that was open when its Host stopped; the next Host opens it again from its journal when a client asks for it.
_Avoid_: dormant thread, orphaned thread

**Closed thread**:
A thread the Host no longer holds. It can be opened again from the agent's own history when the agent supports that.

**Blank thread**:
An open thread nobody has prompted yet, so there is nothing in it to come back to.
_Avoid_: empty thread, draft

**Headless thread**:
A thread whose permission requests a permission policy answers, so it can run with nobody attached.
_Avoid_: background thread, run


**Subagent thread**:
A thread an agent starts under another one. It shares its parent's journal and attached clients.
_Avoid_: subthread

**Delegated thread**:
A thread of its own, with its own journal and agent, that another thread's agent started through the Host, on this Host or, through the Dispatcher, on another of the person's Hosts. It records the thread that started it, and the other Host that thread is on.
_Avoid_: child thread, spawned thread, subagent

**Report**:
The Host's message to a thread about a turn that thread's agent began in another thread, on this Host or, through the Dispatcher, on another of the person's Hosts: how the turn ended, or that it waits on a person.
_Avoid_: notification, callback

**Label**:
A short tag a client puts on a thread, which listings carry and can be filtered by. It means nothing to the Host.
_Avoid_: tag, category, folder

**Successor**:
The thread or turn that carries another's work on: the turn continuing an interrupted turn, or a Bot's new thread. Clients following the one, and reports to it, follow it to its successor.
_Avoid_: continuation thread, next thread

**Attach**:
A client's relationship with an open thread: it receives the thread's events and pending requests, and keeps the thread open while it lasts.
_Avoid_: subscribe, join, connect

**Reopen**:
Moving an open thread to a new process of its agent, on the version the agent's new threads get, keeping the thread's id and journal.
_Avoid_: restart, reload (the TUI's own restart)

### Work while the person is away

**Dispatcher**:
The person's program, apart from their Hosts, that the Hosts connect to and the person's devices and agents reach them through; it keeps triggers and Bots and starts their work on the Hosts as a service. Hosts work on without it.
_Avoid_: scheduler, coordinator, orchestrator, automation engine

**Trigger**:
A schedule or webhook the Dispatcher keeps, each occurrence of which starts a turn on one of the person's Hosts with nobody there.
_Avoid_: automation, routine, job, cron

**Occurrence**:
One time a trigger fires, which the Dispatcher records whether it started a turn or was skipped, and why.
_Avoid_: run, execution, invocation, job

**Schedule**:
A trigger whose occurrences come at the times a cron expression gives, in a time zone, each starting a turn in a new thread or prompting one named thread.
_Avoid_: cron job, timer, routine

**Catch-up**:
An occurrence that starts late, once, for the latest time a schedule missed while the Dispatcher couldn't start it; the times it missed before that are recorded as skipped.
_Avoid_: backfill, retry

**Bot**:
A named assistant the Dispatcher keeps, with an agent, a permission policy, triggers and a home directory of its own memory, whose work goes on in one thread at a time, each on a Host the Dispatcher chooses.
_Avoid_: resident, persona, dot, always-on agent, profile

**Edge**:
The thin service on the internet that holds webhook deliveries for the Dispatcher and sends its pushes, which the Dispatcher dials out to.
_Avoid_: relay, gateway, proxy, cloud

### Projects, Sessions and Blocks

**Project**:
A named piece of the person's work, kept by the Dispatcher, with at most one location on each of their Hosts: a repository there, or a directory outside one.
_Avoid_: workspace, space, repo

**Session**:
One directory on one Host, for a repository one of its worktrees, holding a layout of Blocks that every device shares. Its Host keeps it; a Project's Sessions are those in its locations.
_Avoid_: workspace, space, window

**Block**:
What one pane of a Session's layout shows, of a type: a thread, a terminal, or another thing on the Session's Host.
_Avoid_: pane, panel, widget

### Repositories

**Repository**:
A git repository on the Host's computer that threads' directories can be in, known by its primary worktree. It can be a Project's location on its Host.
_Avoid_: workspace

**Worktree**:
One of a repository's working trees, which threads can run in. It belongs to the person rather than to any thread, and outlives the threads in it.
_Avoid_: checkout, sandbox, workspace

### Terminals

**Terminal**:
A shell on the Host's computer that belongs to a worktree, or to a directory outside a repository, and outlives the threads and clients that show it.
_Avoid_: pane, console, PTY

**Holder**:
The process that keeps one terminal alive, apart from the Host, and is the authority on what its screen holds.
_Avoid_: terminal service, terminal server, multiplexer

**Host-run terminal**:
A command an agent runs on the Host's computer through ACP's terminal methods. It belongs to the agent's tool call, not to a worktree.
_Avoid_: terminal (the person's), client terminal

### Turns

**Prompt**:
What a person sends an agent to start a turn.
_Avoid_: message, query

**Turn**:
One prompt, any steers that join it, and everything the agent does until it answers them.
_Avoid_: run, request, exchange

**Steer**:
What a person sends an agent while its turn runs, which joins that turn instead of starting another.
_Avoid_: interjection, injection, interrupt

**Interrupted turn**:
A turn the Host stopped or crashed under, cut off with its agent's process. A headless thread continues it once, in a turn of its own; an interactive one leaves it to the person.
_Avoid_: uncertain, cancelled, aborted

**Queued prompt**:
A prompt the Host holds in a thread's queue while a turn runs, to start a later turn once the turns before it end. Every client attached to the thread sees it, and it outlives the client that sent it.
_Avoid_: follow-up, pending message

**Request key**:
A name the sender of a request chooses so that sending it again starts nothing more: the Host answers a repeat as it answered the first.
_Avoid_: idempotency token, nonce

**Pending request**:
A permission request, elicitation or client tool call from an agent that waits on a client. A client tool call is for one client; any attached client may answer the others, and the first answer counts.
_Avoid_: question, dialog, prompt

**Permission policy**:
The rules a thread answers permission requests by without asking anyone.
_Avoid_: auto-approve, allowlist

### Records

**Journal**:
The numbered record of everything a thread's attached clients are sent, from which a client catches up after the last position it saw.
_Avoid_: history, log

**Transcript**:
A client's rendering of a thread's journal.
_Avoid_: history, scrollback

### Views

**View**:
The interactive page a tool names for one of its calls, which each client that can show it renders on its own device.
_Avoid_: widget, MCP App, embed, artifact

**Visual**:
A page or picture an agent made that the Host keeps with its own revisions, outliving the turn that made it.
_Avoid_: artifact, custom visual, render

**Surface**:
A display the person's device is connected to, on which the app shows part of what the device has, read only, while the device stays where the person types and answers.
_Avoid_: companion, second screen, external display, mirror, cast
