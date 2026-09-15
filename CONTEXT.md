# Weave

Weave is a working environment that organizes human and agent activity around selectable work contexts.

## Language

**Workspace**:
A named arrangement of Terminal Panes, Browser Panes and Agent Panes on exactly one Host, existing only while it contains at least one of them. Its identity is independent of directories, which are described by its terminals' current locations.
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
A client's independently recoverable selection and arrangement over all Workspaces on its connected Hosts: one active Workspace and one Focused Pane, ordering and collapsed sections. Workspace existence is shared across devices.
_Avoid_: Workspace state, shared layout

**Thread**:
A durable Host-owned conversation with its own Execution Context and, while active, membership in exactly one Workspace. Moving it changes organization while preserving its conversation, execution, and permissions; archiving preserves its history after its Workspace closes.
_Avoid_: Agent Session, run, invocation

**Thread Assignment**:
An active Thread's required membership in one Workspace on the same Host. An archived Thread retains its former Workspace identity as history and gains valid membership when restored.
_Avoid_: Execution Context, process ownership, active selection

**Pane**:
A region in one Workspace presenting a Terminal, a browser page or a Thread. All Pane types participate in the same composition and focus model.
_Avoid_: Sidebar, window

**Pane Identity**:
The durable identity of one Pane, preserved while the Pane moves or swaps. A Terminal Pane ends when its terminal exits; the Host removes it and collapses its split.
_Avoid_: Pane position, content identity, layout identity

**Unavailable Pane State**:
The recoverable presentation of an existing Pane while its Host is disconnected, its live Terminal is reconnecting, or its browser page awaits explicit restoration after runtime loss. A confirmed Terminal exit removes its Pane, while browser runtime loss preserves the Browser Pane's identity, placement, Profile and last committed URL without promising recovery of live page state.
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
The coordinated stopping of live work, with confirmation of active-work consequences, before a Pane or Workspace is removed from every device. Closing a Browser Pane ends its page; closing a Workspace preserves its conversations as archived Threads.
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

**Agent Pane**:
A Pane presenting one Thread, or a local Agent Draft before the first message is sent, in a Workspace that may contain several Agent Panes. Closing it archives its Thread after active work is handled, and moving it preserves the Thread’s conversation and Execution Context.
_Avoid_: Thread switcher, global agent dock, cross-Workspace selection

**Agent Draft**:
A local, unsent conversation shown in an Agent Pane before it becomes a Host-owned Thread. An empty draft disappears when another Pane is activated; a draft containing text remains until sent or explicitly discarded.
_Avoid_: Archived Thread, provider session, Recovery Draft

**Browser Profile**:
A named, persistent browser identity on one Host, containing cookies, site storage and browser settings shared by every Browser Pane using it across that Host's Workspaces. Its lifetime is independent of Panes and Workspaces, and it survives client disconnection and browser process restarts.
_Avoid_: Browser Session, Workspace-owned profile, client profile

**Browser Pane**:
A single Host-owned browser page and its navigation history, belonging to one Workspace and using one Browser Profile on the same Host; moving it between that Host's Workspaces preserves its Profile and live page. Its lifetime is independent of client viewing or focus, including during authorized agent work, and explicit closure ends the page and removes the Pane for every client through a Close Transaction.
_Avoid_: Browser Tab, Browser Session, tab container, client-owned page

**Browser Profile Grant**:
An explicit, revocable authorization belonging to one Thread for its Agent to use a Browser Profile's shared browser identity and inspect, control and debug its pages across Workspaces on that Host. Workspace membership does not confer or restrict this browser authorization, which does not grant access to other Profiles or change filesystem execution permissions; fully trusted human clients can use all Profiles on their paired Host without individual Profile Grants. A grant remains with its Thread when the Agent Pane moves, and is not inherited by other Threads using the same Agent.
_Avoid_: Workspace browser permission, Pane-only debugger access, Host-wide browser access
