# Browser interaction pass — 2026-09-15

The accepted baseline remains native 2× lossless RFB. This pass adds hover and standard cursor feedback, middle-button input, repeat-click word/paragraph selection, drag cancellation, plain-text clipboard operations, an editing context menu, and address/reload/history shortcuts. It keeps upstream CEF and the existing authenticated display/control split.

Human pointer events use CEF's embedding API, as wheel input already did. ACP agents keep full CDP response semantics. Pending hover positions coalesce without crossing click boundaries. Mouse entry enables bounded cursor-state refresh; a focused iPad input also refreshes Chromium edit state to control its software keyboard. Repeat touch taps supply click counts; a long press opens the app's editing menu. Native browser content remains visible under that menu.

Copy and Cut request CEF's current selection through a focus-epoch-checked view operation. They write the client clipboard only after a user editing action. Cut rechecks selection after the asynchronous write before requesting deletion. Paste supplies plain text through the existing input queue. No Host OS clipboard is used. View closure, an ownership change, or overlay isolation prevents new page input. Clipboard text is bounded to 32 KiB. This is plain-text selection transfer: rich HTML/images, webpage-defined copy handlers, custom cursor images, native touch selection handles, and full drag-and-drop remain outside this pass.

The private Browser Service is version 8 and the CEF adapter handshake is version 4; those components must upgrade together. The public interaction operation is additive under product protocol 8. The old Host safely rejects that operation rather than granting unscoped selection access.

## Deferred dropdowns

The user explicitly chose to defer ordinary HTML select dropdowns pending an upstream fix, retaining stock CEF. The Mac probe confirmed `:open=true`, document focus, and `appearance:auto`, but no OSR popup callbacks or pixels. Source inspection found a Chromium preference application that can undo CEF's initial OSR external-menu setting, followed by an empty external-menu handler in CEF OSR. See [the source investigation](cef-select-popup-research.md). The experimental popup compositor and key mapping were removed rather than shipping an unvalidated implementation. Website `window.open` pages still use the existing Right-split behavior.

## Validation

- Root checks passed: 306 Alpha, 40 protocol, 145 Portal, and 2 boundary tests, including builds/type checks. Subsequent focused checks cover clipboard races and navigation shortcuts.
- Real Mac CEF/Portal acceptance passed at 2×: hover, pointer cursor, double/triple-click selection, stale-selection ownership rejection, deletion, Unicode insertion, native wheel semantics, focus handoff, and zero differing pixels against Chromium's PNG reference. [Evidence](evidence/interactions-20260915/portal.json)
- Physical iPad scrolling and keyboard-dismissal resize passed at 1858 × 1502 pixels with preserved displacement. A regression test covers a layout update arriving during an in-flight viewport claim. [Evidence](evidence/interactions-20260915/ipad-zrle-full-2x.json)
- Packaged native Alpha click/text input passed. [Evidence](evidence/interactions-20260915/mac-basic-input.json)

The first iPad automation attempt incorrectly used an existing mounted address field and navigated the user's Linear Pane to the fixture. Its original page/Profile were restored through browser history and verified at `https://linear.app/intake`. That run is excluded from performance evidence. Acceptance now selects the exact fixture Host, waits for its menu item to become enabled, and requires a newly created visible Pane with a blank address before navigating. It fails closed if that Pane cannot be found.

Clipboard ordering and shortcuts have component tests and the CEF editing path has native acceptance. The user confirmed on the installed iPad build that long-pressing Browser content shows the Copy/Cut/Paste/Select All menu while the page remains visible, and both look correct. This verifies menu presentation and retained page visibility; individual clipboard transfers have not yet received separate human confirmation.

## Installed for review

The normal Mac and iPad builds are installed and launched. The signed Mac app passed `codesign --verify --deep --strict`. The installed Host reports source hash `4447f1bfd96eb5055e4400d759e3dbffb457a6f70068deb38357854a0e294ddf`; the Browser Service confirms version 8 and the restored existing page is available at scale 2. The Host and native Browser runtime were replaced together, with the previous artifacts backed up. The original Terminal Service process remains running. These are work-in-progress artifacts after `4707e615`, not a new commit or release.

The existing iPad app container was retained. The fixture pairing cleanup reported success, and the final normal launch has acceptance/diagnostic flags disabled. GPU and alternate RFB encoding flags remain diagnostic-only; the installed default remains software CEF with ZRLE lossless display.

## Contextual editing and iPad keyboard follow-up — 2026-09-16

The transparent browser input proxy used to be editable whenever a Pane had focus, causing iPadOS to open its keyboard on ordinary page taps. It now starts read-only. A deliberate content tap arms software input, and upstream `CefRenderHandler::OnVirtualKeyboardRequested` decides whether the focused remote target needs a keyboard and which input mode it uses. Dismissing the keyboard or leaving the Pane clears that intent; polling cannot reopen it. Basic hardware text input remains available while the software keyboard is dismissed.

The remote edit-state reply arrives after the original touch event. The iPad bridge therefore uses public `WKWebView.evaluateJavaScript` for the embedding client's focus request. The readonly input blurs before that native call; refreshing blur and focus within one script did not open the keyboard on the device. The internal blur is kept out of the shared Pane focus manager so its restoration cannot compete with the native focus request. A per-request input token prevents a late callback from taking focus from a different input or Pane. This follows [WebKit's documented embedding-client keyboard behavior](https://bugs.webkit.org/show_bug.cgi?id=195884), without private API or Chromium changes.

The editing menu requests Chromium's context parameters at the clicked location before opening the Alpha overlay. Its Copy, Cut, Paste and Select All items are conditional on upstream edit capabilities and selection. Read-only fields exclude mutations, password fields exclude Copy/Cut, and a page that cancels its context event produces no replacement editing menu. Context requests use the same view/focus ownership checks and ordered input queue; responses after local focus loss are discarded. The client clipboard is accessed only when an editing item is selected.

Native Mac CEF/Portal acceptance passed for editable, read-only, disabled, password and contenteditable targets, cancelled context menus, and stale ownership rejection. The lossless comparison remained exact at 2000 × 1600. The root check passed 309 Alpha, 43 protocol, 145 Portal and 2 boundary tests. Subsequent focused checks cover the iPad native focus request. XCTest could not enable device automation, so the isolated in-app keyboard fixture instead passed twice consecutively on the physical iPad. Each run verified no keyboard on Pane focus/ordinary taps/read-only content, a 422-point viewport reduction for editable input, text received by Chromium, explicit dismissal staying closed, a second editable tap reopening it, and body taps hiding it. This is real WebKit/UIKit device behavior driven in-process, not a passed XCTest touch run. [Native context evidence](evidence/context-keyboard-20260916/portal.json) and [iPad evidence](evidence/context-keyboard-20260916/ipad.json).

The final normal Mac/iPad builds are installed and running, with the acceptance driver excluded. The installed Mac app matches the final packaged bundle and its signature validates. Portal is healthy at source hash `58b2d76c380b91954f01ea0481aa0fa848cb8720b0a5cf16efe8f87f57ca0f8e`; its matching Browser runtime is installed. The existing browser identity and Terminal Service PID 13352 were preserved. Fixture pairing cleanup returned `removed: true`, and the XCTest runner is no longer installed. The changes remain uncommitted. WVE-79 was updated and remains In Progress.

## Checkpoint review — 2026-09-16

The independent Standards review found no documented hard violations. The Spec review found that Copy/Cut could be dropped while an asynchronous focus claim had no acknowledged epoch. Explicit clipboard state reads now wait for queued input/focus work and still cancel on actual focus loss; cursor polling remains independent. A delayed-acknowledgement regression test covers both cases. Deliberate iPad Pencil/mouse activation now arms keyboard intent as touch activation does.

Cut's text recheck detects changed text, but it is not an atomic selection identity check against concurrent agents or other clients. The implementation comment now states that limit. Shared browser input remains cooperative; equal-text reselection by another controller can race with Cut. This is recorded for the broader input/lifecycle work rather than claimed as transactional clipboard editing.

Jaco confirmed the final installed iPad keyboard behavior after the focus-restoration correction.
