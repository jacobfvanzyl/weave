# Weave

Weave is a working environment that organizes human and agent activity around selectable work contexts.

## Language

**Workspace**:
A named arrangement of Terminal Panes and active Threads on exactly one Host, existing only while it contains at least one of them. Its identity is independent of directories, which are described by its terminals' current locations.
_Avoid_: Project, repository, directory parent, Workspace Tab

**Execution Context**:
A stable Host identity and an exact authorized working directory. Directory identity and availability remain independent of Workspace membership and a terminal's later directory changes.
_Avoid_: Workspace, repository identity, basename, active selection

**Current Directory**:
The last directory reported by a Terminal on its Host. It describes terminal activity without granting access or changing the Terminal's initial Execution Context.
_Avoid_: Workspace root, execution permission, terminal title

**Host**:
A computer that owns one or more Workspaces and the runtime state needed to work in them. A client connects to a Host directly.
_Avoid_: Server, Portal, node

**Host Daemon**:
The long-lived Host process that authenticates clients and owns Workspace access, Agent Runtimes, and Terminal sessions.
_Avoid_: Central server, Portal, agent server

**Terminal Service**:
The Host-owned execution component that keeps Terminal processes and their authoritative state alive independently of client connections and Host Daemon restarts. Its loss ends the supported process-persistence boundary.
_Avoid_: Host Daemon, Terminal Pane, multiplexer backend

**Agent Runtime**:
A Host-managed execution of an ACP Agent, including its process, ACP connection, and provider-owned session state.
_Avoid_: Thread, Agent Session, run

**Agent Turn**:
A bounded unit of Agent work initiated within a Thread and ending in an explicit completed, failed, cancelled, or uncertain outcome.
_Avoid_: Prompt, Agent Runtime

**Workspace Composition**:
The Host-owned durable collection of Workspaces and their ordered Panes and layout relationships, shared by every connected client.
_Avoid_: Client layout, local session layout, window state

**Composition Revision**:
The durable version that totally orders accepted changes to one Host’s Workspace Composition and lets clients detect that their view is stale.
_Avoid_: Client version, application version, timestamp

**Composition Schema Version**:
The format generation of a Host’s Workspace Composition, advanced by an identity-preserving server migration rather than by ordinary user changes.
_Avoid_: Composition Revision, client version, release version

**Client Presentation State**:
A client's independently recoverable selection and arrangement over all Workspaces on its connected Hosts: active Workspace, Focused Pane, selected Thread, ordering and collapsed sections. Workspace existence is shared across devices.
_Avoid_: Workspace state, shared layout

**Thread**:
A durable Host-owned conversation with its own Execution Context and, while active, membership in exactly one Workspace. Moving it changes organization while preserving its conversation, execution, and permissions; archiving preserves its history after its Workspace closes.
_Avoid_: Agent Session, run, invocation

**Thread Assignment**:
An active Thread's required membership in one Workspace on the same Host. An archived Thread retains its former Workspace identity as history and gains valid membership when restored.
_Avoid_: Execution Context, process ownership, active selection

**Pane**:
A region within a Workspace that presents Workspace content. The active product uses Terminal Panes; conversations have an independent selection and do not require a Pane in that arrangement.
_Avoid_: Sidebar, window

**Pane Identity**:
The durable identity of one Pane, preserved while the Pane moves or swaps. A Terminal Pane ends when its terminal exits; the Host removes it and collapses its split.
_Avoid_: Pane position, content identity, layout identity

**Unavailable Pane State**:
The recoverable presentation of an existing Pane while its Host is disconnected or its live terminal is reconnecting. A confirmed terminal exit removes the Pane; it never becomes an empty or replacement target.
_Avoid_: Broken Pane, placeholder Pane, missing Pane type

**Dirty Pane**:
A Pane whose presented content has live state that closing would interrupt or destroy: a running Thread, an unsaved Editor buffer, or a non-idle Terminal shell.
_Avoid_: Modified layout, active Pane, unsynchronized Pane

**Dirty Claim**:
A live declaration that a client holds Pane state which closing the shared Pane would destroy. It makes that Pane dirty for every client until resolved or recovered.
_Avoid_: Local dirty flag, active-client state

**Recovery Draft**:
A Execution Context-scoped durable checkpoint of an unsaved Editor buffer that survives the client session and Pane identity which created it until saved or explicitly discarded.
_Avoid_: Autosaved file, backup file, local buffer

**Dirty Workspace**:
A Workspace containing a Dirty Pane or an active or uncertain Agent Turn, so closing it requires confirmation of the combined consequences.
_Avoid_: Modified tab, unsaved layout

**Close Transaction**:
The coordinated stopping of live work before a Pane or Workspace is removed from every device. Closing a Workspace preserves its conversations as archived Threads.
_Avoid_: Layout deletion, dismiss, hide

**Idle Terminal**:
A Terminal session at a confirmed shell prompt with no running or stopped jobs and no pending input. A Terminal whose state cannot be established is not idle.
_Avoid_: Inactive terminal, hidden terminal, disconnected terminal

**Layout Node**:
A durable position in a Workspace's Pane arrangement whose geometry is independent of the Pane it currently contains.
_Avoid_: Pane, content slot

**Focused Pane**:
The one Pane in the active Workspace that receives Pane commands and exposes direct manipulation controls.
_Avoid_: Selected pane, active panel

**Workspace Default Pane Type**:
The shared Pane type preselected by New Pane for one Workspace, overriding the application default without restricting an explicit type choice.
_Avoid_: Default layout, fixed pane type

**Preferred Editor Pane**:
The Editor Pane in a Workspace that receives file previews and opens; a Workspace creates one when none exists.
_Avoid_: Default editor, global editor

**Editor Working Set**:
The ordered set of pinned files durably owned by one Editor Pane and shared with its Workspace Composition. Previews and the client's active-file choice are not part of it.
_Avoid_: Open files, recent files, preview tabs

**Thread Pane**:
The conversation region presenting the independently selected Thread from any connected Host. Its selection and lifetime are independent of open terminal Workspaces.
_Avoid_: Agent pane, chat window

**Browser Session**:
The single ephemeral web-browsing context presented by a Browser Pane. Its ordered Browser Tabs share cookies and site data until the user resets it or quits Alpha.
Human operation is the Phase 1 product contract; agent observation and control belong to a separately scoped Phase 2.
_Avoid_: Preview, hidden browser, agent browser

**Browser Tab**:
A human-visible page and navigation history within one Browser Session. Closing the last Browser Tab immediately creates a fresh blank Browser Tab.
_Avoid_: Workspace, Pane, hidden browser
