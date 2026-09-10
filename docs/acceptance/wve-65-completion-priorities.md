# WVE-65 completion priorities

## 1. Real local Mac Host upgrade — 2026-09-10

The launchd Host `dev.weave.product-portal` now runs signed revision
`e507eaf52be98000f0eb4b65f867a4f6ec8b4cb5`, replacing `3ab1299e`.
The existing Apple Development identity and `xyz.veezee.weave.portal` signing
identifier were retained. Its TLS health endpoint returned the new revision,
Bun 1.3.14, protocol 2 and state format 1.

A private rollback copy of the executable, configuration and state lives under
`~/Library/Application Support/Weave/Portal/backups/wve-65-e507eaf5`.
Before reconnecting clients, exact comparisons confirmed unchanged Host identity,
all 17 credentials, configuration, workspace records and Thread records.
The existing tmux socket had no running server, so terminal-process survival was
not exercised by this particular upgrade.

The already-paired Electron inspection app reconnected using its Retry action.
Its sidebar now shows canonical Host directories and Thread attention, and the
existing selected conversation/history loaded. No new pairing or agent prompt
was required. The iPad's pairing remains in the preserved credential inventory;
this step does not claim an attended iPad reconnection check.

The supported Linux `service upgrade` command does not apply on macOS. This
upgrade used a signed atomic executable replacement and restarted the existing
launchd job. No remote Host was deployed.

## 2. Native pane lifetime and focus

Terminal panes are keyed siblings; split-tree geometry no longer owns their
component lifetime. Splitting and maximizing/restoring preserve the mounted
renderer and Host attachment. The divider supports pointer and keyboard resizing.
Activating another Workspace Tab deliberately releases the old view/attachment,
so hidden workspaces do not retain control of terminals reused elsewhere. Returning
restores the stored pane focus. Closing a view still does not terminate its process.

Native surfaces hide behind web dialogs/menus and restore terminal focus when
appropriate. Observers can receive native focus while Host input/resize remains
blocked. Hiding a surface no longer collapses its parser to a zero-sized grid.

Validation: root check passed (193 Alpha, 73 Host, 24 protocol and 2 boundary
tests plus builds/typechecks); final focused pane/native/xterm tests passed after
retaining the explicit inactive-workspace detach policy. Rendered shell coverage
asserts the same terminal DOM instance and one attachment through split and
maximize, independent agent selection, and non-destructive view closure. Native
macOS adapter compilation, shared renderer probe and signed iPad build passed.
Platform interaction acceptance will be rerun after snapshot and input work; a
successful build alone is not hardware-keyboard or touch acceptance.
