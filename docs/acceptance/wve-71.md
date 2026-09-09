# WVE-71: Electron desktop and iPad-only Capacitor

The Alpha renderer now runs in Electron 44.3.0 on macOS, packaged by Bun and
Electron Packager. AppKit is retired. Capacitor targets iPad only; native
credential signing remains intact. xterm.js remains the terminal renderer.

The desktop uses a secure `weave://app` origin, a sandboxed renderer, context
isolation, no Node integration, no embedded WebViews, and a platform-only
preload. External HTTP(S) links open through macOS. Application and edit menus,
single-instance focus, window restoration, zoom, and standard copy/paste are
provided by Electron. Option-drag selects terminal text even when Neovim has
mouse reporting enabled.

WebKit's non-exportable keys stay in their original store. Connections explains
re-pairing in Electron. Keep the existing Host config/state, add `weave://app`
to allowed origins, create a fresh token, pair and verify existing Threads,
then revoke the previous desktop credential when no longer needed. The new
Electron profile persists across app replacement. No Host data or old client
profile is deleted by the migration.

## Verification on 2026-09-09

- `bun run check`: boundary/protocol checks, 175 Alpha tests, renderer build,
  Host typecheck and 60 tests, Electron and Bun build-tool typechecks passed.
- Packaged macOS app: `/tmp/weave-desktop-5iwQ2R` records pair and reconnect
  passes against the compiled Bun Host, including ACP permission approval,
  native clipboard paste/copy, window resize, Neovim input, renderer isolation,
  and absent deferred surfaces. Screenshots and per-phase JSON are retained.
- Real Codex ACP provider 1.10.0: `/tmp/weave-desktop-26nQcD` records an actual
  prompt/reply followed by native terminal, clipboard and Neovim acceptance.
  Permissions are exercised separately with the deterministic ACP fixture.
- Physical iPad acceptance uses the `Acceptance` Xcode scheme and native
  XCTest touch/typing, including ACP permission approval, terminal input,
  Neovim and rotation with the software keyboard open. The test waits for the
  composer to be visible above the keyboard before typing. The final native
  run passed in 27 seconds: `/tmp/wve71-ipad-native-15.xcresult`; portrait and
  keyboard screenshots were exported and inspected.

Acceptance builds explicitly require `VITE_ALPHA_ACCEPTANCE=1`. Production
builds exclude the renderer driver; native iPad hooks also require Debug.
Desktop tests use an isolated profile and preserve/restore the system clipboard.
The iPad WebView sits in a native container constrained to UIKit's keyboard
layout guide, with Capacitor notification resizing disabled. Terminal dimensions
are published on attachment changes, including an unchanged pane size. A focused
regression test covers this late-attachment case.

Native device tests preserve existing app data and use a separately paired
acceptance Host. Signing/notarization for external distribution is a separate
release operation; this evidence covers local packaged desktop and provisioned
physical-iPad execution.
