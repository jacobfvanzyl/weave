# WVE-65 directory identity checkpoint

The Host now persists a context pin alongside the existing version-1 workspace
catalog. A pin records the resolved directory path and filesystem device/inode
identity. Configured and dynamically registered Workspaces keep their opaque
IDs. Existing catalogs gain pins on their first successful directory resolution.
A legacy registration that has never resolved stays inspectable without claiming
a canonical path.

A missing path, redirected symlink, configuration path change, or replacement
directory at the same spelling does not rebind the Workspace. Summaries retain
the last canonical path and report `unavailable` or `path-changed`. Restoring the
original directory makes it available again. Device/inode checking is deliberately
conservative: replacing a mount or restoring files into a newly created directory
requires explicit registration replacement, even if the path spelling matches.

New terminals, new/draft Threads, provider restoration (including automatic
recovery after a crash), provider transcript loading, local ACP context lookup,
and workspace file access check the pinned identity. Existing terminal processes
can still be attached, controlled and explicitly terminated. Compositions and
Thread metadata remain inspectable. No directory, credential, Thread or terminal
is deleted by availability reconciliation.

Alpha displays directory unavailability separately from Host connectivity and
disables new agent/shell creation for those contexts. Opening a saved arrangement
and attaching an existing terminal remain possible.

Validation:

- `bun run check` passed: 181 Alpha, 73 Host, 24 protocol and 2 boundary tests,
  plus Alpha/Host/Electron typechecks and the Alpha production build.
- Authenticated integration covers Host restart with a missing root, reuse of
  credentials and IDs, preserved composition and terminal control, rejected
  execution/file access after replacement, provider crash recovery refusing the
  missing root, and recovery after restoring the original directory.
- Catalog coverage includes symlink redirection, same-path directory replacement,
  changed configuration, and unresolved legacy registrations.
- Rendered shell coverage retains an attached terminal and selected conversation
  while showing a changed directory, disabling a new agent and a new shell.
- Packaged Electron pairing and relaunch passed with the current compiled Host:
  `/tmp/weave-desktop-eXzgVp`. This includes pending-permission conversation
  switching, native paste/copy, Neovim input and resize. The pair screenshot was
  inspected. It still uses xterm.js; it is not libghostty surface acceptance.

The previous iPad composition acceptance predates this checkpoint. Full native
libghostty integration and final macOS/iPad acceptance remain outstanding.
