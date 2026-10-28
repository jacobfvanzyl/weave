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
A client on another computer than the Host's, which reaches it through the tailnet on behalf of a paired device or a peer Host.
_Avoid_: network client, mobile client

**Paired device**:
A device of the person's that the Host has paired with and accepts remote clients from until it's revoked.
_Avoid_: credential, principal, token

**Peer Host**:
One of the person's Hosts paired with another, so that the agents of one can reach the threads of the other.
_Avoid_: remote Host, linked Host, federated Host

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

### Threads

**Thread**:
A conversation with one agent in one directory, identified by the id of the agent's ACP session.
_Avoid_: session (ACP's word for the agent's side of it), chat, conversation

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

**Trigger**:
A schedule or webhook that starts a headless thread's turn in the Host with no client involved.
_Avoid_: automation, job, cron

**Subagent thread**:
A thread an agent starts under another one. It shares its parent's journal and attached clients.
_Avoid_: subthread

**Delegated thread**:
A thread of its own, with its own journal and agent, that another thread's agent started through the Host. It records the thread that started it.
_Avoid_: child thread, spawned thread, subagent

**Report**:
The Host's message to a thread about a turn that thread's agent began in another thread: how the turn ended, or that it waits on a person.
_Avoid_: notification, callback

**Attach**:
A client's relationship with an open thread: it receives the thread's events and pending requests, and keeps the thread open while it lasts.
_Avoid_: subscribe, join, connect

**Reopen**:
Moving an open thread to a new process of its agent, on the version the agent's new threads get, keeping the thread's id and journal.
_Avoid_: restart, reload (the TUI's own restart)

### Repositories

**Repository**:
A git repository on the Host's computer that threads' directories can be in, known by its primary worktree.
_Avoid_: project, workspace

**Worktree**:
One of a repository's working trees, which threads can run in. It belongs to the person rather than to any thread, and outlives the threads in it.
_Avoid_: checkout, sandbox, workspace

### Terminals

**Terminal**:
A shell on the Host's computer that belongs to a worktree, or to a directory outside a repository, and outlives the threads and clients that show it.
_Avoid_: pane, block, console, PTY

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
