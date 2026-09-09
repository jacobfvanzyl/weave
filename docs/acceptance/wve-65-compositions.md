# WVE-65 composition and independent-selection checkpoint

Verified on 2026-09-09. WVE-65 remains In Progress.

The Host persists schema-v1 Workspace Compositions separately from terminal processes and Thread history. Authenticated get/replace RPCs enforce Workspace grants, validate bounded layouts and terminal ownership, and compare revisions before atomically replacing the saved arrangement. Unsupported stored schemas fail without overwriting the file. Two concurrent edits cannot silently overwrite each other.

Alpha now has a terminal-first live shell. Context groups use Host identity and exact canonical path; repository identity does not merge Hosts or worktrees. One open Workspace Tab appears as its context root; multiple open tabs become children below their agents. Agents without an open terminal workspace appear below a divider. Thread selection and terminal activation remain independent. Closing a workspace only changes the client's open set and detaches the displayed terminals. Explicit Terminate is separate.

Workspace open order, recent activation, focused/maximized pane identities and group expansion are stored in client preferences. The selected durable Thread uses a separate preference key. Restart restores an existing arrangement without creating a replacement terminal. A missing terminal reference remains visible and requires explicit replacement. Late attachments are detached after their pane unmounts, and queued input is fenced to the attachment that received it.

## Evidence

- `bun run check`: passed. 179 Alpha tests, 69 Host tests, 22 protocol tests and two boundary tests, plus Alpha, Host, desktop and tooling checks/builds.
- Authenticated Host integration: grant isolation, unknown/cross-Workspace terminal rejection, simultaneous revision conflict, restart recovery, and terminal survival after arrangement removal.
- Rendered `AlphaShell` test through public actions: two Hosts with the same directory remain separate; agent selection leaves the terminal attachment intact; terminal input retains its owning Host; grouping transitions between zero/one/multiple open tabs; closing views retains Host compositions/processes; preferences restore agent selection and an existing terminal after remount.
- Packaged Electron with a compiled local Bun Host and fixture ACP provider: pairing and application relaunch both passed ACP prompt/permission handling, native paste/copy, Neovim input, window resizing and visible terminal bounds. Evidence: `/tmp/weave-desktop-WWX3zR/{pair,reconnect}.json` and corresponding PNGs. Screenshots were inspected.
- Initial packaged attempt exposed an acceptance-harness race against the preceding workspace and an inline-sidebar width mistake. Both were corrected before the successful run.

## Remaining issue scope

This checkpoint still renders terminals with xterm.js. The prior libghostty native library probe is not an application renderer, and neither this checkpoint nor its native keyboard tests establish libghostty completion.

Remaining work includes the actual libghostty view/transport seam on macOS and iPad, global agent attention summaries and freshness, persistent unavailable/rebound path identity, layout-management refinements, and final acceptance across supported installed clients and connected Hosts. The mock-only shell retains its prior arrangement pending migration. The successful packaged scenario used isolated local state and did not replace the user's installed Alpha or running Hosts. Physical iPad acceptance has not yet been repeated for this checkpoint.
