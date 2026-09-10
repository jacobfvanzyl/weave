# WVE-65 native terminal candidate

Alpha can now connect its bounded terminal output stream to a native view on
macOS and iPad. `VITE_NATIVE_TERMINAL=1` selects this candidate; ordinary builds
continue to use xterm.js. This is an integration checkpoint, not completion of
the renderer replacement or WVE-65.

The shared Objective-C++ component uses the pinned public libghostty-vt API for
terminal state, fragmented UTF-8, graphemes, styles, alternate screens, scrollback,
resize, terminal replies and bracketed paste. CoreText draws its cells. It does
not embed Ghostty's application renderer. The same component compiles into a
UIKit text-input surface and an AppKit view hosted by Electron through Node-API.
The Host continues to own PTYs, process recovery and execution context.

Electron exposes six fixed operations and a scoped event subscription through
its sandboxed preload. Main checks the sending window and main frame, validates
bounds and bytes, and resolves opaque view IDs. It never gives the web client a
native window pointer. Reload, renderer loss and window close release views.
iPad similarly releases views when its web document reloads. Closing a native
view does not close the Host terminal. Snapshot replay suppresses terminal
replies, and read-only views reject input. Electron input overflow disables the
view and reports an error rather than continuing with an incomplete key stream.

Validation on 10 September 2026:

- The native CoreText probe passes fragmented UTF-8, combining and joined emoji
  text, wide-cell extraction, alternate-screen restoration, terminal replies,
  snapshot/read-only reply suppression and bracketed-paste encoding. Its rendered
  PNG was inspected. Run `bun run probe:native-renderer` to reproduce it.
- Packaged Electron pairing and relaunch passed against a disposable Host at
  `/tmp/weave-desktop-mOJGCz`. The actual native view handled paste, Neovim typing,
  resizing and copying a selected marker. Agent permissions survived switching
  conversations. The native view's own PNG was inspected separately from the
  web-content capture. Copy selection in this harness is set programmatically;
  it does not establish mouse-drag selection acceptance.
- Native view unit tests cover acknowledged output ordering, read-only and
  foreign/stale event fences, cleanup, creation completing after unmount, and
  visible failure reporting.
- The signed native iPad candidate passed an app-driven smoke against a real TLS
  Host, including ACP permission handoff, native terminal output, input and
  bracketed paste into Neovim. The verified result and application-view image are
  `/tmp/wve65-native-ipad-verified.json` and
  `/tmp/wve65-native-ipad-verified.png`. Image inspection caught and corrected
  UIKit drawing duplicate glyphs over CoreText. Fixture-only connection/key
  cleanup was read back as `removed: true` in
  `/tmp/wve65-native-ipad-verified-cleanup.json`.
- The iPad smoke invokes UIKit input methods in-process. It does not establish
  hardware keyboard, touch selection, IME or rotation acceptance. The captured
  application view excludes the system keyboard's separate window. Two XCTest
  attempts failed before any test began: Xcode timed out enabling automation
  mode even after the device reported unlocked. Results:
  `/tmp/wve65-stream-ipad-sep10.xcresult` and
  `/tmp/wve65-stream-ipad-sep10-retry.xcresult`.
- `bun run check` passed with 190 Alpha tests, 73 Host tests, 24 protocol tests,
  two boundary tests, and the existing builds/typechecks. Subsequent platform
  fixes were rebuilt and rerun at their native acceptance boundary. The final
  native-view tests and desktop/tools typechecks also passed.

A subsequent keyboard checkpoint routes special keys through Ghostty's encoder,
refreshing its options from the current terminal modes for every event. The probe
covers application cursor mode, Ctrl-C, Shift-Tab, application keypad mode,
Kitty press/release encoding and returning to legacy behavior after the mode is
popped. AppKit maps physical keys, modifiers, repeats and releases; UIKit routes
its special-key commands and text-entry controls through the same encoder.
Packaged Electron pairing/relaunch passed at `/tmp/weave-desktop-RGKQ1b` and the
physical-iPad app-driven regression passed at `/tmp/wve65-keyboard-ipad.json`,
with fixture cleanup confirmed by `/tmp/wve65-keyboard-ipad-cleanup.json`.

The workspace arrangement checkpoint adds naming, local ordering and an explicit
running-terminal picker. Its rendered shell scenario checks that those actions
preserve the selected Thread and context group, and that a stale terminal choice
cannot start or terminate a process. Native views receive their initial geometry
before replaying a saved screen. Packaged Electron pairing and relaunch both pass
at `/tmp/weave-desktop-eEmuE8`, including opening the same Neovim process in another
arrangement and entering more text after reattachment; `native-reattached.png`
was inspected. The full repository check passes with 191 Alpha, 73 Host, 24
protocol and two boundary tests. The signed iPad app and updated XCTest target
build successfully.

The expanded physical-iPad smoke exposed a resize-ordering failure. The test
Host trace showed libghostty sending an in-band resize report before the Host
resized tmux's PTY. Neovim drew into the old grid and lost visible content.
The adapter now reports DEC 2048 unavailable and suppresses its resize reports;
the Host remains responsible for PTY resize. Native geometry must also be
visible and acknowledged before it can resize the Host. This matches
[Neovim's mode negotiation](https://github.com/neovim/neovim/blob/v0.12.4/src/nvim/tui/tui.c#L199),
which enables resize events when the terminal advertises the mode.

With that fix, the iPad passes ACP permission handoff, paste, Neovim input,
reattachment into another arrangement and further input. Evidence:
`/tmp/wve65-resize-order-ipad-verified.json` and the inspected
`/tmp/wve65-resize-order-ipad-verified.png`. Fixture cleanup is confirmed by
`/tmp/wve65-resize-order-ipad-verified-cleanup.json`. This remains an in-process
UIKit smoke, not hardware-keyboard or touch acceptance. The native probe covers
unavailable-mode reporting and suppressed in-band resize at
`/tmp/weave-native-renderer-vYzJMv`. Packaged Electron pairing/relaunch passes at
`/tmp/weave-desktop-elefd8`. The repository check passes with 192 Alpha tests,
73 Host tests, 24 protocol tests and two boundary tests; the final native changes
also pass the probe, desktop build/acceptance, signed iPad build/smoke and XCTest
build-for-testing. No XCTest execution is claimed.

Before enabling this by default, complete physical-iPad acceptance and native
keyboard/IME/selection work. UIKit still needs full hardware key/release coverage.
Mouse reporting, IME marked-text presentation and selection across wrapped/wide
text need further work. UIKit TextKit supplies selection/accessibility over the visible text, whose
geometry must be checked against the native renderer on-device. CoreText currently
draws complete frames; sustained-output performance, dirty-region drawing and
accessibility need acceptance. The prepared iOS library targets physical arm64
iPads, not the Simulator. Native layers currently hide while web menus/dialogs
are open; stacking, zoom and focus recovery need interaction checks.

The default remains xterm.js until those gaps are closed. The native inspection
and synthetic AppKit acceptance helpers are unavailable in ordinary packaged
Electron builds. No candidate app has been published or deployed to the user's
normal desktop installation. The prior iPad app is restored after smoke testing,
without resetting existing pairings or Host data.
