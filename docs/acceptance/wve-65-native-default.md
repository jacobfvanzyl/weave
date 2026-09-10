# WVE-65 native terminal default — 2026-09-10

The user approved making libghostty the default, removing xterm.js, and moving the remaining work to [WVE-72](https://linear.app/jacobfvanzyl/issue/WVE-72) so WVE-65 can close. This supersedes the opt-in/default and completion-gate statements in the earlier checkpoint notes; it does not turn deferred checks into passed acceptance.

## Delivered

Electron and physical iPad builds now include the pinned libghostty-vt integration automatically. The existing shared CoreText renderer, AppKit/Node-API adapter and UIKit/Capacitor adapter consume the bounded terminal output stream. The Host still owns terminal processes, snapshots, input control and resize authority.

Removed both xterm packages and lockfile entries, the xterm renderer and its tests, the native-renderer feature flag, fallback selection, unused raw-transcript model fields, and obsolete xterm-specific acceptance code. Browser previews show that native terminals require Electron or the iPad app. The product boundary check rejects reintroducing the removed packages. Historical evidence remains intact. `TERM=xterm-256color` remains a terminal capability designation, with no dependency on xterm.js.

## Verification

- `bun run check` passed after the cleanup: 189 Alpha tests, 76 Host tests, 24 protocol tests and two boundary tests, plus tooling checks, typechecks and the Alpha production build. Log: `/tmp/wve65-cutover-final-check.log`.
- Packaged Electron acceptance passed pairing and relaunch with `VITE_ALPHA_ACCEPTANCE=1` and no renderer flag. It exercised ACP prompt/permission routing across conversation selection, native paste/copy, Neovim, split/maximize pane identity, detach/reattach, composition commit and resize. Evidence: `/tmp/weave-desktop-iG2be4`; native reattached frame inspected separately from the web-content capture.
- The signed physical-iPad build passed app-driven acceptance against a disposable TLS Host, including native paste, Neovim reattachment, pane lifetime, composition commit and keyboard-constrained geometry. Result: `/tmp/wve65-cutover-ipad-result.json`; native screenshot: `/tmp/wve65-cutover-ipad.png`, inspected. Fixture cleanup read back `removed: true` in `/tmp/wve65-cutover-ipad-cleanup.json`; its Host and dedicated tmux server were stopped.
- Both normal app packages are built without acceptance or renderer flags for inspection. The local Host does not need another upgrade for this renderer-only cutover; its prior signed `53e54181` build and existing real pairings remain in place.

The platform smoke runs preceded only removal of unused model fields and test mocks. The final full check and normal builds cover that cleanup; live terminal output continues through the same stream adapter.

## Deferred to WVE-72

WVE-72 owns attended iPad keyboard/pointer/touch/system-IME/accessibility checks; the final cross-device controller/observer, multi-Host/worktree, restart and sustained-output/slow-consumer matrix; the remaining tmux restoration contract and unsupported modes; and the permission card that still displays `pending` after its accepted result. Earlier XCTest runner failures occurred before tests executed. App-driven UIKit input is not physical keyboard or system IME acceptance.

The new issue is related follow-up work, not a child or blocker of WVE-65. Browser, Editor, filetree, Automation and remote deployment remain outside this cutover.
