# Weave

Weave is a working environment that organizes human and agent activity around selectable work contexts.

## Language

**Project**:
A durable parent that groups related Workspaces.
_Avoid_: Repository, vault, workspace

**Workspace**:
A Host-owned authorized execution context for files, conversations and terminals, independent of which conversation or terminal arrangement a client is viewing.
All Workspaces follow the same domain rules; there is no special personal or root Workspace.
_Avoid_: Project, repository, worktree

**Execution Context**:
A stable Host identity together with an exact working directory canonicalized by that Host. A Workspace represents the authorized context; a shell's later directory change does not move it. A missing or replaced directory retains its last resolved identity and becomes unavailable for new execution until that directory is restored or the registration is explicitly replaced.
_Avoid_: Repository identity, basename, active selection

**Host**:
A computer that owns one or more Workspaces and the runtime state needed to work in them. A client connects to a Host directly.
_Avoid_: Server, Portal, node

**Host Daemon**:
The long-lived Host process that authenticates clients and owns Workspace access, Agent Runtimes, and Terminal sessions.
_Avoid_: Central server, Portal, agent server

**Agent Runtime**:
A Host-managed execution of an ACP Agent, including its process, ACP connection, and provider-owned session state.
_Avoid_: Thread, Agent Session, run

**Agent Turn**:
A bounded unit of Agent work initiated within a Thread and ending in an explicit completed, failed, cancelled, or uncertain outcome.
_Avoid_: Prompt, Agent Runtime

**Workspace Tab**:
A Workspace-local view that owns one independently arranged set of Panes. Its mutable name describes the view but does not identify it.
_Avoid_: Project tab, global tab, layout preset

**Workspace Composition**:
The Workspace-owned durable arrangement of its ordered Workspace Tabs, their Panes, and their layout relationships, shared by every client that opens the Workspace.
_Avoid_: Client layout, local session layout, window state

**Composition Revision**:
The durable version that totally orders accepted changes to one Workspace Composition and lets clients detect that their view is stale.
_Avoid_: Client version, application version, timestamp

**Composition Schema Version**:
The format generation of a Workspace Composition, advanced by an identity-preserving server migration rather than by ordinary user changes.
_Avoid_: Composition Revision, client version, release version

**Client Presentation State**:
A client's independently recoverable view over Workspace Compositions: its open Workspace Tabs, active tab, Focused Pane and selected Thread. Closing a tab in this view detaches it without deleting its composition or stopping its processes.
_Avoid_: Workspace state, shared layout

**Thread**:
A durable Workspace-bound conversation whose activity state reflects its current agent execution.
A Thread cannot exist without a Workspace.
_Avoid_: Agent Session, run, invocation

**Pane**:
A region within a Workspace Tab that presents Workspace content. The active product uses Terminal Panes; conversations have an independent selection and do not require a Pane in that arrangement.
_Avoid_: Sidebar, window

**Project Pane**:
The optional right-side Pane that presents the active Thread's Workspace directory. When hidden, it is absent from the Workspace layout and is restored from the bottom rail.
_Avoid_: File tree, file sidebar, artifacts pane, Workspace files pane

**Pane Identity**:
The durable identity of one Pane, preserved while the Pane moves or swaps and ended when the Pane is closed or replaced.
_Avoid_: Pane position, content identity, layout identity

**Unavailable Pane State**:
The recoverable presentation of an existing Pane whose target cannot currently be resolved, preserving the Pane identity and its layout position.
_Avoid_: Broken Pane, placeholder Pane, missing Pane type

**Dirty Pane**:
A Pane whose presented content has live state that closing would interrupt or destroy: a running Thread, an unsaved Editor buffer, or a non-idle Terminal shell.
_Avoid_: Modified layout, active Pane, unsynchronized Pane

**Dirty Claim**:
A live declaration that a client holds Pane state which closing the shared Pane would destroy. It makes that Pane dirty for every client until resolved or recovered.
_Avoid_: Local dirty flag, active-client state

**Recovery Draft**:
A Workspace-scoped durable checkpoint of an unsaved Editor buffer that survives the client session and Pane identity which created it until saved or explicitly discarded.
_Avoid_: Autosaved file, backup file, local buffer

**Dirty Workspace Tab**:
A Workspace Tab containing at least one Dirty Pane, promoted so closing the whole Tab can disclose and confirm every destructive consequence together.
_Avoid_: Modified tab, unsaved layout

**Close Transaction**:
The coordinated resolution of every lifecycle consequence required to close a Pane or Workspace Tab before its shared structure is removed.
_Avoid_: Layout deletion, dismiss, hide

**Idle Terminal**:
A Terminal session at a confirmed shell prompt with no running or stopped jobs and no pending input. A Terminal whose state cannot be established is not idle.
_Avoid_: Inactive terminal, hidden terminal, disconnected terminal

**Layout Node**:
A durable position in a Workspace Tab's Pane arrangement whose geometry is independent of the Pane it currently contains.
_Avoid_: Pane, content slot

**Focused Pane**:
The one Pane in the active Workspace Tab that receives Pane commands and exposes direct manipulation controls.
_Avoid_: Selected pane, active panel

**Workspace Default Pane Type**:
The shared Pane type preselected by New Pane for one Workspace, overriding the application default without restricting an explicit type choice.
_Avoid_: Default layout, fixed pane type

**Preferred Editor Pane**:
The Editor Pane in a Workspace Tab that receives file previews and opens; a Tab creates one when none exists.
_Avoid_: Default editor, global editor

**Editor Working Set**:
The ordered set of pinned files durably owned by one Editor Pane and shared with its Workspace Composition. Previews and the client's active-file choice are not part of it.
_Avoid_: Open files, recent files, preview tabs

**Thread Pane**:
The conversation region presenting the independently selected Thread from any connected Host. Its selection and lifetime are independent of open terminal Workspace Tabs.
_Avoid_: Agent pane, chat window

**Browser Session**:
The single ephemeral web-browsing context presented by a Browser Pane. Its ordered Browser Tabs share cookies and site data until the user resets it or quits Alpha.
Human operation is the Phase 1 product contract; agent observation and control belong to a separately scoped Phase 2.
_Avoid_: Preview, hidden browser, agent browser

**Browser Tab**:
A human-visible page and navigation history within one Browser Session. Closing the last Browser Tab immediately creates a fresh blank Browser Tab.
_Avoid_: Workspace Tab, Pane, hidden browser
