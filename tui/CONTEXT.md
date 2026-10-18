# weave

The `weave` terminal client and the Host it connects to, which runs ACP agents and keeps their sessions going for any number of clients.

## Language

### Host and clients

**Host**:
The long-lived per-user process on one computer that runs agents and owns their sessions, outliving the clients connected to it.
_Avoid_: server, Portal, Host Daemon

**Client**:
A program connected to the Host on someone's behalf, such as the TUI, `weave run`, or a later iPad app.
_Avoid_: frontend, UI, consumer

**Remote client**:
A client on another computer than the Host's, which reaches it through the tailnet on behalf of a paired device.
_Avoid_: network client, mobile client

**Paired device**:
A device of the person's that the Host has paired with and accepts remote clients from until it's revoked.
_Avoid_: credential, principal, token

**Agent**:
An ACP agent program the Host can launch, known by an id: a preset, one defined in the Host's configuration, or one from the ACP registry.
_Avoid_: adapter, provider, model

**Agent update**:
A newer version of a preset's or registry agent's program than the one a session's process runs, which the Host looks for when the session opens.
_Avoid_: upgrade, new release

**Client tool**:
A tool the Host offers a session's agent that an attached client runs on its own device, such as putting text on that device's clipboard.
_Avoid_: client-side MCP server, frontend tool, local tool

### Sessions

**Session**:
A conversation with one agent in one directory, identified by the agent's own session id.
_Avoid_: thread, chat, conversation

**Open session**:
A session the Host holds with its agent running, which clients can attach to and prompt.
_Avoid_: live session, active session

**Suspended session**:
A session that was open when its Host stopped; the next Host opens it again from its journal when a client asks for it.
_Avoid_: dormant session, orphaned session

**Closed session**:
A session the Host no longer holds. It can be opened again from the agent's own history when the agent supports that.

**Blank session**:
An open session nobody has prompted yet, so there is nothing in it to come back to.
_Avoid_: empty session, draft

**Headless session**:
A session whose permission requests a permission policy answers, so it can run with nobody attached.
_Avoid_: background session, run

**Subagent session**:
A session an agent starts under another one. It shares its parent's journal and attached clients.
_Avoid_: child thread

**Attach**:
A client's relationship with an open session: it receives the session's events and pending requests, and keeps the session open while it lasts.
_Avoid_: subscribe, join, connect

**Reopen**:
Moving an open session to a new process of its agent, on the version the agent's new sessions get, keeping the session's id and journal.
_Avoid_: restart, reload (the TUI's own restart)

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
A prompt a client holds while a turn runs, to start the next turn once that one ends.
_Avoid_: follow-up, pending message

**Pending request**:
A permission request, elicitation or client tool call from an agent that waits on a client. A client tool call is for one client; any attached client may answer the others, and the first answer counts.
_Avoid_: question, dialog, prompt

**Permission policy**:
The rules a session answers permission requests by without asking anyone.
_Avoid_: auto-approve, allowlist

### Records

**Journal**:
The numbered record of everything a session's attached clients are sent, from which a client catches up after the last position it saw.
_Avoid_: history, log

**Transcript**:
A client's rendering of a session's journal.
_Avoid_: history, scrollback
