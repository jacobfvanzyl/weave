# Workspace-centered shell interaction specification

Status: Accepted on 2026-08-03

Canonical decision: [Choose the canonical shell interaction model](https://linear.app/jacobfvanzyl/issue/PER-8/choose-the-canonical-shell-interaction-model)

Parent map: [Find the workspace-centered Weave shell](https://linear.app/jacobfvanzyl/issue/PER-5/find-the-workspace-centered-weave-shell)

## Purpose

This specification defines the target interaction contract for Weave's
workspace-centered shared-client shell. It consolidates the accepted domain,
prototype, state, command, close/recovery, responsive, and accessibility
decisions into one implementation handoff.

The words **must**, **must not**, **should**, and **may** are normative.

This is a product and interaction specification. It does not select a storage
engine, protocol encoding, component hierarchy, migration rollout, or delivery
sequence.

## Decision precedence

This specification is canonical where earlier prototype language conflicts
with a later accepted decision.

In particular, the close rules from
[Define durable Workspace Tab and Pane state](https://linear.app/jacobfvanzyl/issue/PER-7/define-durable-workspace-tab-and-pane-state)
and
[Prototype dirty Pane and Workspace Tab close recovery](https://linear.app/jacobfvanzyl/issue/PER-16/prototype-dirty-pane-and-workspace-tab-close-recovery)
supersede the earlier close wording in
[Define Pane manipulation vocabulary and commands](https://linear.app/jacobfvanzyl/issue/PER-15/define-pane-manipulation-vocabulary-and-commands):

- Closing a Pane or Workspace Tab is lifecycle-coupled, not surface-only.
- Closing the final Workspace Tab closes it and its Panes, then atomically
  creates a fresh empty **New Tab** with new identities.

`CONTEXT.md` is authoritative for domain terminology. This specification uses
its canonical terms without redefining them.

## Scope and invariants

### Workspace model

- A Project is the durable parent of one or more Workspaces.
- A Workspace is the primary selectable working context.
- Every Workspace follows the same domain rules. There is no special Personal,
  root, or generated fallback Workspace.
- Every Thread belongs to exactly one Workspace. The target model has no root
  or unscoped Thread creation path.
- Legacy Threads without a Workspace are destroyed by the eventual transition;
  they are not silently assigned, exposed through a migration chooser, or
  preserved in a generated Workspace.
- Workspace switching changes the entire active context together: Workspace
  identity and header, branch or other Workspace metadata, Workspace Tabs,
  Panes, Workspace files, and selected Thread.

### Composition model

- The visible hierarchy is `Workspace -> Workspace Tabs -> Panes`.
- A Workspace Tab belongs to one Workspace and owns one independently arranged
  set of Panes.
- Thread, Editor, and Terminal are peer Pane types. No additional first-class
  Pane type is required by this specification.
- A Thread may have at most one open Thread Pane across all Tabs in its owning
  Workspace.
- Workspace Tabs and Panes persist until explicitly closed. Responsive changes,
  application restart, Workspace switching, and temporary target unavailability
  must not silently destroy them.

## Shell landmarks and navigation

The shell has three stable semantic landmarks:

1. **Global Threads** on the far left.
2. The active Workspace's Tab strip and Pane work area in the center.
3. **Workspace files** on the right.

Responsive presentation may contract a landmark into a rail or overlay, but
must not change its identity, ownership, or behavior.

### Global Threads

- The expanded far-left region begins with the Workspace switcher. Each
  Workspace retains its theme-colored identity.
- **Threads** is one flat list containing the union of Threads that have an open
  Thread Pane, are running, await attention or input, or have unread completion
  or failure activity.
- The list must not add Workspace group headings.
- Threads from one Workspace remain contiguous. The current Workspace's block
  comes first. Remaining Workspace blocks sort by the newest qualifying Thread
  activity in each Workspace.
- Every Thread row retains a theme-colored Workspace marker and Workspace
  subtitle so the flat list remains scannable.
- **History** contains the active Workspace's remaining Threads, uses the same
  heading hierarchy as Threads, and starts collapsed.
- Collapsing Global Threads produces an icon/status rail that preserves
  Workspace color and Thread activity signals.

### Workspace and Thread selection

- Selecting a Workspace performs a complete Workspace transition.
- Selecting a Thread in the active Workspace activates its existing Thread Pane
  or creates one in the active Tab if none exists.
- Selecting a Thread in another Workspace first performs a complete Workspace
  transition, then activates or creates that Thread's unique Pane in its owning
  Workspace.
- Activating an already-open Thread changes only the initiating client's active
  Tab and focus; it must not create a duplicate Pane or rearrange another
  client's presentation.

## Workspace Tabs, Panes, and files

### Workspace Tabs

- Workspace Tabs form a horizontally reachable strip above the Workspace work
  area.
- Selecting a Tab restores that Tab's Pane arrangement.
- Every Workspace Composition contains at least one Workspace Tab.
- A Workspace with no prior composition starts with one empty **New Tab**.
- Tab names are trimmed, non-empty mutable labels of at most 80 characters.
  Duplicate names are allowed. A command disambiguates them by stable identity;
  the interface may add position and Pane summary for humans.
- Tab names do not change automatically from Pane content and never provide
  identity.

### Pane canvas

- The active Workspace Tab presents a normalized recursive split tree of row
  containers, column containers, and Pane leaves.
- Adjacent containers with the same axis flatten. Singleton containers collapse
  after removal.
- Panes are direct peers regardless of type. Pane type does not participate in
  layout calculations.
- Pane Identity is independent of Layout Node identity. Moving or swapping a
  Pane preserves its Pane Identity; closing or replacing it ends that identity.

### Workspace files and Editor Panes

- Workspace files is a persistent, independently resizable region on the right.
- It may collapse to a narrow file rail and becomes an overlay only under the
  responsive rules below.
- Selecting a file routes a preview to the active Tab's Preferred Editor Pane.
  If the Tab has no Editor Pane, Weave creates one and makes it preferred.
- Each Editor Pane durably owns its ordered Editor Working Set of pinned files.
- File previews and the client's active-file choice are Client Presentation
  State. Pinning or editing a preview promotes it into the shared Editor Working
  Set.
- Closing an Editor Pane closes its working set but never deletes files.

## Canonical command surface

All entry points must invoke the same named command semantics. Command palette,
global keybindings, context or overflow menus, pointer controls, and accessible
buttons must not implement parallel behaviors.

### Focus and local controls

- An active Tab with Panes has exactly one Focused Pane. An empty Tab has none.
- Only the Focused Pane exposes direct manipulation controls. Focusing another
  Pane moves that toolbar; inactive Panes retain quiet chrome.
- The toolbar exposes split, directional move, maximize or restore, and close.
  Overflow commands include replace, keyboard resize, and cross-Tab movement.
- Accessible controls use the full canonical command name and expose disabled
  or no-op outer-edge states.

### Pane creation and replacement

- **New Pane** lives on the active Workspace Tab.
- It offers Thread Pane, Editor Pane, and Terminal Pane and preselects the
  Workspace Default Pane Type.
- New Workspaces default the Workspace Default Pane Type to Editor. A one-off
  Pane choice does not change the default.
- **Replace Pane with...** retains the Layout Node, closes the existing Pane
  through the same Close Transaction guard, ends its identity, and creates a
  new Pane identity.
- Replacing with a Thread that already has an open Thread Pane activates the
  existing Pane instead of creating a duplicate.

### Split, focus, move, and resize

- **Split Right** and **Split Below** split the Focused Pane's Layout Node and
  focus the new Pane. Labels such as “horizontal” and “vertical” are not
  canonical because they describe the divider ambiguously.
- **Focus Pane Left / Right / Above / Below** changes focus to the adjacent
  geometric neighbor without changing layout.
- **Move Pane Left / Right / Above / Below** swaps the Focused Pane identity
  with the adjacent geometric neighbor, preserves both Layout Nodes and their
  geometry, and retains focus on the moved Pane.
- Directional neighbor selection requires a shared facing edge and overlap on
  the perpendicular axis. Ties resolve by largest shared-edge overlap, nearest
  perpendicular center, then stable layout order.
- Directional focus and movement do not wrap. A move at an outer edge is
  disabled or is a no-op.
- **Resize Pane Left / Right / Up / Down** moves the nearest relevant split-tree
  boundary while respecting minimum sizes. Pointer divider drag and keyboard
  resize are inputs to the same semantic operation.
- Divider dragging stays local until release; only the final ratio becomes
  durable.

### Maximize and cross-Tab movement

- **Maximize Pane** temporarily presents only the Focused Pane in its Tab.
- **Restore Pane Arrangement** restores the unchanged durable split tree.
- **Move Pane to Workspace Tab...** removes the Pane from the source tree,
  normalizes the source, inserts the same Pane identity by splitting an explicit
  destination Layout Node, switches the initiating client to the destination
  Tab, and focuses the moved Pane.
- If the source loses its Preferred Editor Pane, the oldest surviving Editor
  Pane becomes preferred; without one, the preference clears. A moved Editor
  Pane becomes preferred in a destination with no valid preference and does not
  replace an existing valid preference.
- Other clients retain their active Tab. If their focus target disappeared,
  they apply the normal focus fallback.

### Workspace Tab commands

- **New Workspace Tab**, **Rename Workspace Tab**, **Move Workspace Tab Left**,
  **Move Workspace Tab Right**, and **Close Workspace Tab** are available from
  the Tab strip and command palette.
- Closing the final Workspace Tab must not leave the Workspace without a Tab;
  after the Close Transaction succeeds, the server creates a fresh empty
  **New Tab** with new Tab and layout identities and no Preferred Editor Pane.

### Prototype keybindings

The validated prototype uses `Command-K` for the command palette,
`Command-Backslash` / `Command-Shift-Backslash` for Split Right / Split Below,
`Option-Arrow` for directional focus, `Option-Shift-Arrow` for directional
movement, and `Command-Shift-M` for maximize or restore on macOS.

These are defaults, not domain semantics. Platform-reserved conflicts may be
remapped without changing command names or results.

## Durable state and concurrency

### Shared Workspace Composition

A Workspace owns one server-authoritative Workspace Composition containing:

- ordered Workspace Tabs and their mutable names;
- normalized split trees and durable ratios;
- stable Tab, Pane, and Layout Node identities;
- Pane types and resource bindings;
- each Editor Pane's Editor Working Set;
- each Tab's Preferred Editor Pane; and
- the Workspace Default Pane Type.

Each composition records an independently meaningful Composition Schema Version
and a monotonically increasing Composition Revision.

### Client Presentation State

The following remain per client and per Workspace:

- active Workspace Tab and Focused Pane;
- maximized Pane;
- active pinned file and file previews;
- cursor, selection, scroll, and terminal viewport;
- search state; and
- in-progress divider drag.

Presentation changes must not mutate shared composition unless they culminate
in an explicit shared command.

### Mutations

- Clients submit idempotent semantic commands with an operation ID, last
  observed Composition Revision, named stable identities, and explicit
  preconditions.
- The server validates invariants, serializes accepted commands atomically,
  increments the revision, and broadcasts the result.
- A stale command may apply only if its identities and preconditions remain
  valid. Otherwise the client refreshes before offering retry.
- Whole-document last-write-wins composition saves are forbidden.
- Optimistic rendering is allowed, but accepted server state wins.
- A Pane move is one accepted revision; clients must not observe an intermediate
  state with duplicated or missing Pane ownership.

### Schema evolution and transition

- Composition schema migrations are server-owned, deterministic, idempotent,
  atomic, forward-only, and identity-preserving.
- A client outside the supported writable schema range becomes explicitly
  read-only instead of stripping or overwriting newer state.
- A failed migration retains the prior valid snapshot. A downgrade does not
  reverse-migrate automatically.
- Existing Projects, Workspaces, Workspace-bound Threads, files, and terminal
  sessions remain discoverable through their existing entry points.
- Existing client-local layouts are not imported. Each existing Workspace begins
  the target model with one empty New Tab.

### Restoration and fallback

- A client restores its remembered active Tab, Focused Pane, active pinned file,
  and maximized Pane when those identities remain valid.
- Without prior presentation state, the client selects the first ordered Tab.
- If the active Tab disappeared, select the surviving Tab now at its former
  position, otherwise the preceding Tab.
- Focus falls back to the Preferred Editor Pane, then the first Pane in stable
  visual order. An empty Tab has no Focused Pane.
- An invalid active pinned file falls back to the first pinned file. Preview
  files do not return after restart.
- Fallbacks affect Client Presentation State only and must not recreate or
  mutate shared composition.

## Unique Thread Pane ownership

- The server enforces a Workspace-wide `threadId -> paneId` invariant.
- New Thread Pane and Replace Pane with Thread create nothing if that Thread
  already has a Pane; they activate the existing Pane for the initiating client.
- Concurrent creation attempts converge on the first accepted Pane identity.
- Moving a Thread Pane preserves identity and ownership.
- Permanent Thread deletion is a separate command from closing its Pane.

## Close Transaction and recovery

Closing is lifecycle-coupled. **Close Pane**, **Close Workspace Tab**, Pane
replacement, and **Remove Workspace** coordinate the lifecycle consequences of
the affected resources before shared structure is removed.

### Dirty state

- A running Thread, an Editor with an unsaved buffer, and a Terminal that is not
  provably idle make their Pane dirty.
- A Terminal is idle only at a confirmed shell prompt with no running or stopped
  jobs and no pending input. Unknown, disconnected, or unreachable state is
  dirty.
- Dirtiness is Workspace-wide. Threads use server-authoritative execution state,
  Terminals use Portal state when available, and clients publish live Dirty
  Claims for unsaved Editor buffers.
- Before publishing an Editor Dirty Claim, a client checkpoints a
  Workspace-scoped Recovery Draft with recoverable contents, file identity, and
  base version.
- A Recovery Draft survives client and Pane lifetimes until saved or explicitly
  discarded. A disconnected Dirty Claim expiring does not make its Recovery
  Draft clean.
- A Dirty Workspace Tab contains at least one dirty Pane or remote Dirty Claim.

### Impact ledger

- Close Pane, Close Workspace Tab, and Remove Workspace open one modal impact
  review when resolution or confirmation is required.
- The header names the target and scope before any lifecycle action begins.
- The review keeps the complete consequence set visible together: individually
  resolvable Editor buffers first, required Thread and Terminal actions second,
  unavailable-target recovery third, and a persistent outcome summary.
- The primary action is **Resolve & Close** or **Resolve & Remove**.
- **Cancel**, including Escape, changes nothing and restores focus to the
  invoking close control.
- Closing a clean Pane or Tab performs its lifecycle action without an extra
  dirty warning.

### Per-resource choices

- Each unsaved Editor buffer is named with file path, owner, and recovery state.
- Ordinary Pane or Tab closure offers **Save**, **Keep Recovery Draft**, or
  **Discard** for each buffer.
- Workspace removal additionally offers **Export outside Workspace**.
- A running Thread requires **Stop & archive**. A non-running Thread is archived
  when its Thread Pane closes.
- A non-idle or unknown Terminal requires **Terminate & close**.
- An unreachable Portal accepts an acknowledged queued termination; it is not
  treated as clean.
- Remote Dirty Claims and disconnected Recovery Drafts remain visible while
  their clients are offline.

### Commit point and partial failure

- Required side effects run before shared structure is removed.
- Immediately before removal, the server revalidates the Composition Revision
  and dirty state.
- Shared Pane, Tab, or Workspace structure is removed only after all required
  actions succeed or an accepted queued action satisfies the contract.
- Side effects may be irreversible. On partial failure, the affected structure
  remains, completed actions are disclosed separately, focus moves to the first
  failure, and retry addresses only unresolved actions idempotently.
- A save failure leaves the Pane open and focuses the first failed file.
- Closing the final Tab creates the fresh empty New Tab only after the old Tab's
  Close Transaction succeeds.

### Workspace removal

- Remove Workspace runs one Workspace-level Close Transaction across every Tab
  and Pane.
- Dirty buffers and Recovery Drafts must be saved, exported outside the
  Workspace, or discarded before removal.
- Threads stop and archive. Terminal sessions terminate or gain acknowledged
  queued termination.
- Workspace Composition and Client Presentation State are deleted only after
  required actions succeed.
- If removal partially fails, the Workspace and composition remain and retry is
  idempotent.

## Unavailable targets and structural recovery

- A Pane whose target is unavailable preserves its Pane Identity and Layout
  Node and renders a typed Unavailable Pane State.
- The unavailable state offers **Retry target**, **Locate / rebind** where
  meaningful, **Replace Pane with...**, and **Close Pane**.
- Targets must not be recreated from names, paths, or indexes.
- Intentional target deletion must close or rebind every reference through a
  Close Transaction. Unavailable states handle crashes, external changes, and
  corrupt or legacy data.
- A disconnected Recovery Draft may be saved when its file and matching base
  version are reachable, retained through Keep Recovery Draft, or destroyed
  through Discard. Version conflicts enter recovery or merge handling and never
  overwrite silently.
- If a composition document is unreadable, retain the last valid revision. If
  no valid revision exists, quarantine the invalid document, show a recovery
  notice, and present a fresh empty New Tab.

Workspace Composition follows stable Workspace identity. Renames, reordering,
branch changes, and root relocation preserve it. Workspace-relative file
bindings revalidate and may become unavailable. Temporary Workspace or Portal
unavailability must not clean up composition. Recreating the same path under a
new Workspace identity starts with a fresh composition.

## Responsive and focus contract

### Breakpoints

- At 1280px and wider, Global Threads and Workspace files remain expanded around
  the active Tab's complete Pane arrangement.
- From 980px through 1279px, Global Threads contracts first to its icon/status
  rail. The Workspace files region remains expanded and every Pane remains
  visible.
- From 700px through 979px, both side regions remain distinct left and right
  rails. The active Tab still presents its complete Pane arrangement.
- Below 700px, both side regions become explicitly named overlays and only one
  may be open. The active Tab shows one Focused Pane with a peer-Pane chooser.
  The durable composition and hidden Pane identities remain unchanged.
- Below 700px, the Close Transaction impact ledger becomes a full-screen dialog
  whose outcome summary follows the resource list; its state contract is
  unchanged.
- The Workspace header and horizontally reachable Workspace Tab strip remain
  present at every width.

### Keyboard and focus

- Overlay triggers identify **Global Threads** and **Workspace files**
  separately and expose `aria-expanded` and `aria-controls` state.
- An overlay is a labelled modal dialog. Opening moves focus inside; Tab and
  Shift-Tab remain contained; Escape or backdrop dismissal closes it and
  restores focus to the invoking trigger.
- A skip link reaches Workspace Tabs.
- Ordinary Tab navigation reaches every visible control.
- F6 cycles visible shell landmarks in order without conflating Global Threads,
  the Workspace work area, and Workspace files.
- Focused Pane chrome and every keyboard focus target have a visible focus
  indicator.
- Narrow presentation preserves the canonical Thread Pane, Editor Pane, and
  Terminal Pane names.

### Accessible names and announcements

- Workspace Tabs expose the active Tab with `aria-current`.
- Pane regions have type-and-content accessible names.
- Compact rail controls retain full Thread and file names rather than relying on
  icon-only semantics.
- A polite live region announces responsive-mode changes, Tab and Pane focus,
  cross-Workspace Thread transitions, file previews routed to the Preferred
  Editor Pane, impact-review opening and cancellation, partial failure,
  successful final-Tab replacement, and successful Workspace removal.

## Acceptance scenarios

An implementation is conformant only when the following observable scenarios
pass through the real running system.

### Navigation and identity

1. Given qualifying Threads in several Workspaces, Global Threads shows one flat
   list with current-Workspace Threads first, contiguous Workspace blocks, and
   the other blocks ordered by newest qualifying activity.
2. Given a Thread in another Workspace, selecting it transitions the complete
   Workspace context before focusing or creating that Thread's Pane.
3. Given an already-open Thread Pane in a non-active Tab, activating the Thread
   switches to and focuses that exact Pane identity without duplication.
4. Given two clients on one Workspace, one client's Tab or Pane focus change does
   not change the other client's Client Presentation State.

### Tabs, Panes, and files

5. Creating a Workspace with no composition yields one empty New Tab.
6. Selecting between Tabs restores each durable split arrangement and Editor
   Working Sets while retaining client-local focus and preview behavior.
7. Opening a file uses the active Tab's Preferred Editor Pane; with none, it
   creates an Editor Pane and makes it preferred.
8. Pinning or editing a preview adds it to the shared Editor Working Set;
   restarting removes unpinned previews but preserves pinned files.

### Commands and concurrency

9. Pointer, keyboard, command-palette, overflow-menu, and accessible-button
   entry points for one named command produce the same shared result and
   announcement.
10. Split Right and Split Below create geometrically distinct neighbors and
    focus the new Pane.
11. Directional focus changes only focus; directional movement swaps Pane
    identities while preserving Layout Node geometry and follows the moved Pane.
12. A directional move at an outer edge is disabled or no-ops without wrapping.
13. A cross-Tab move normalizes the source, inserts the same Pane identity into
    an explicit destination, switches only the initiating client, and commits as
    one Composition Revision.
14. Two concurrent attempts to open the same Thread converge on one Thread Pane.
15. A stale structural command with invalid preconditions is rejected and the
    client refreshes before offering retry; it never overwrites the whole
    composition.

### Closing and recovery

16. Closing a clean Thread Pane archives the Thread; closing a clean Terminal
    Pane terminates its session; closing an Editor Pane never deletes files.
17. Closing a dirty Tab opens one impact ledger containing every dirty Editor
    buffer, running Thread, non-idle or unknown Terminal, remote Dirty Claim, and
    unavailable target in that Tab.
18. Cancel or Escape from the impact ledger performs no side effects, makes no
    structural revision, and restores focus to the invoking control.
19. A save or termination failure keeps the Pane or Tab structure, discloses
    completed side effects, focuses the first failure, and retries only
    unresolved actions.
20. Closing the final Tab completes its lifecycle actions, removes the old Tab
    and Pane identities, and atomically creates one fresh empty New Tab.
21. Removing a Workspace does not delete its composition or presentation state
    until all resources are resolved; on partial failure the Workspace remains.
22. An offline client's Dirty Claim and Recovery Draft remain represented and
    cannot be silently treated as clean.

### Unavailable and responsive states

23. Losing a Pane target preserves Pane and Layout Node identities and offers
    Retry, Locate / rebind where meaningful, Replace Pane with, and Close Pane.
24. Crossing each responsive breakpoint changes presentation only; Workspace,
    Tab, Pane, Editor Working Set, and target identities remain stable.
25. Below 700px, only one named side overlay opens at a time, focus is contained,
    Escape restores its trigger, and a peer-Pane chooser reaches every Pane.
26. Keyboard-only navigation reaches the Tab strip, every visible Pane command,
    Global Threads, Workspace files, and the complete Close Transaction flow
    with visible focus and appropriate announcements.

## Out of scope

- Implementing the production shell, persistence, protocol, or migration.
- Selecting database tables, API paths, event formats, React component seams, or
  rollout tickets.
- Redesigning the agent runtime, Thread execution engine, Portal, or server APIs
  beyond the contracts this specification requires.
- Permanent Thread deletion semantics beyond keeping deletion separate from
  Pane closure and archival.
- Native mobile-shell implementation. The responsive rules specify the minimum
  shared-client behavior only.
- Importing legacy client-local layouts or preserving legacy Threads without a
  Workspace.

## Validated evidence

- [Workspace shell patterns research](https://github.com/jacobfvanzyl/weave/blob/a7a46431b3b9906c0d2b448664cf17220832600b/docs/research/workspace-shell-reference-patterns.md)
- [Storybook integration seam research](https://github.com/jacobfvanzyl/weave/blob/a27dde4355fc8b8c152954db763af9a0fc0f92a1/docs/research/storybook-integration-seam.md)
- [A — Workbench](https://github.com/jacobfvanzyl/weave/blob/a0f919bb59bb029aa77dd955eea06aeb77004922/packages/client/src/components/app-shell/workspace-shell-prototype.stories.tsx)
- [A — Focus queue](https://github.com/jacobfvanzyl/weave/blob/36033395500e0b4563b6a077eddef22e3ca641b9/packages/client/src/components/app-shell/global-threads-workspace-switching-prototype.stories.tsx)
- [A — Local controls](https://github.com/jacobfvanzyl/weave/blob/a65bc9e1f460a63f7ef6db04668075f40d465834/packages/client/src/components/app-shell/workspace-pane-commands-prototype.stories.tsx)
- [A — Progressive landmarks](https://github.com/jacobfvanzyl/weave/blob/602bec6c026c523c5cad7cf9e1e2616e22c71798/packages/client/src/components/app-shell/responsive-focus-prototype.stories.tsx)
- [A — Impact ledger](https://github.com/jacobfvanzyl/weave/blob/881e2f43f14b0141e7e10c3cfbc6d312791f7a8d/packages/client/src/components/app-shell/dirty-close-recovery-prototype.stories.tsx)

The prototype branches are evidence, not production implementation. Their
accepted behaviors are consolidated here; comparison variants remain rejected.
