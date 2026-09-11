# WVE-51: iPad keyboard resize latency

Date: 2026-08-28

## Conclusion

Alpha should not restructure its pane tree first. The installed `@capacitor/keyboard` 8.0.5 implementation deliberately
waits for the iOS keyboard animation duration **plus 200 ms** before resizing the native WebView. That matches the
observed pause and the official plugin's still-open bug report.

The smallest useful experiment is a durable Bun dependency patch matching the official repository's open fix: keep
Capacitor's native resize mode, but make its show/hide frame update immediate. Validate that patch on the physical iPad
before changing Alpha's layout. If any animation jank remains after that, coalesce Alpha's `visualViewport` writes to
one animation frame. Moving only the composer while leaving the WebView full-height is possible, but it creates more
keyboard geometry and transcript-occlusion work than this non-critical issue warrants.

## Verified current behavior

- Alpha installs `@capacitor/keyboard` 8.0.5. Its Capacitor config does not set `plugins.Keyboard.resize`, and the
  official default is `native`, meaning the plugin resizes the whole native WebView. Alpha's keyboard hook changes
  only the form accessory bar and WebView scrolling; it does not change resize mode. See
  [Alpha's Capacitor config](../../product/alpha/capacitor.config.ts),
  [keyboard hook](../../product/alpha/src/app/use-native-keyboard.ts), and the
  [8.0.5 resize-mode contract](https://github.com/ionic-team/capacitor-keyboard/blob/v8.0.5/README.md#keyboardresize).
- On `UIKeyboardWillShowNotification`, the installed iOS plugin calculates the final keyboard overlap, then calls
  `setKeyboardHeight` with `UIKeyboardAnimationDurationUserInfoKey + 0.2`. That helper schedules `_updateFrame` after
  the delay; in native mode `_updateFrame` finally shortens the WebView frame. The plugin sends the JavaScript
  `keyboardWillShow` event immediately, before that deferred frame update. See the pinned
  [8.0.5 show handler](https://github.com/ionic-team/capacitor-keyboard/blob/v8.0.5/ios/Sources/KeyboardPlugin/Keyboard.m#L223-L264)
  and [deferred resize implementation](https://github.com/ionic-team/capacitor-keyboard/blob/v8.0.5/ios/Sources/KeyboardPlugin/Keyboard.m#L306-L364).
- The official plugin issue describes the same symptom: on iOS the app resizes after the keyboard animation finishes,
  while the expected behavior is to resize before it starts. It remains open as of this research.
  [Capacitor Keyboard issue 19](https://github.com/ionic-team/capacitor-keyboard/issues/19).
- Alpha already sizes its fixed shell from `visualViewport.height` and `offsetTop`, updating CSS variables on viewport
  resize and scroll events. This adapts correctly once the native WebView/visual viewport changes, but cannot make a
  deferred native frame change occur earlier. See [AlphaShell's viewport synchronization](../../product/alpha/src/components/alpha-shell.tsx).
- UIKit posts `keyboardWillShowNotification` immediately before presenting the keyboard and provides the ending frame,
  animation duration, and curve. Apple cautions that the keyboard frame is in screen coordinates and must be converted
  for Split View, Slide Over, and Stage Manager. [Apple keyboard-will-show documentation](https://developer.apple.com/documentation/uikit/uiresponder/keyboardwillshownotification).

## Options

| Option | Scope | Expected effect | Trade-offs | Recommendation |
| --- | --- | --- | --- | --- |
| Patch the plugin's native resize delay to zero | Very small native dependency patch | Removes the known animation-duration-plus-200-ms wait while preserving Alpha's current layout and native resize contract | The official fix is still an unmerged PR, so Weave must carry and recheck the patch when upgrading | **Try first** |
| Pre-size Alpha on `keyboardWillShow` | Small TypeScript change in the existing keyboard/viewport hooks | Uses the already-immediate event and `keyboardHeight` to set Alpha's final shell height before the plugin eventually resizes the WebView | Duplicates native geometry; scalar height can be wrong for floating/split keyboards and Stage Manager; two resize authorities can flicker | Fallback if dependency patching is undesirable |
| Coalesce `visualViewport` handling with `requestAnimationFrame` | Tiny TypeScript optimization | Limits root CSS-variable writes and cascading layout work to once per rendered frame | Cannot remove the plugin's deterministic delay; helps only if tracing shows repeated relayout jank afterward | Safe follow-up, not the primary fix |
| Set `KeyboardResize.None` and lift only the composer | Medium React/CSS work | Eliminates full-app resize; composer can translate above a docked keyboard immediately | Transcript needs new occlusion padding and scroll anchoring; side panes remain behind the keyboard; `keyboardHeight` lacks the rectangle needed for robust floating/split-keyboard placement | Do not pursue for this non-critical issue |
| Use `UIKeyboardLayoutGuide` in a custom native bridge controller | Medium-to-large native architecture change | Lets Auto Layout track the keyboard, including optional undocked/floating behavior | Introduces a custom Capacitor controller/layout seam solely for keyboard behavior | Technically strongest, disproportionate here |
| Switch from `native` to `body` resize | Small config change | Resizes only `body`; viewport-relative units remain unchanged | The same delayed `setKeyboardHeight` path drives body mode, and Alpha's body is fixed while its shell follows `visualViewport`; it does not address the root cause | Do not use as a latency fix |

Capacitor's official mode definitions are in the
[8.0.5 Keyboard README](https://github.com/ionic-team/capacitor-keyboard/blob/v8.0.5/README.md#keyboardresize).
Apple's `keyboardLayoutGuide` tracks the keyboard position; its optional `followsUndockedKeyboard` behavior also shows
why a single keyboard-height value is not a complete iPad geometry model. See
[Apple's keyboard layout guide](https://developer.apple.com/documentation/uikit/uiview/keyboardlayoutguide) and
[undocked keyboard behavior](https://developer.apple.com/documentation/uikit/uikeyboardlayoutguide/followsundockedkeyboard).

## Recommended experiment

1. Record timestamps for textarea focus, `keyboardWillShow`, first `visualViewport.resize`, `keyboardDidShow`, and the
   first paint at the final shell height on the physical iPad. This distinguishes the known native wait from any later
   web-layout work.
2. Carry the three-line behavior change from the official open PR as a reproducible Bun patch rather than editing
   `node_modules`: show and hide call `setKeyboardHeight` with zero delay. The PR changes only one Objective-C file and
   is explicitly intended to resolve the official slow-resize issue.
   [Capacitor Keyboard PR 50](https://github.com/ionic-team/capacitor-keyboard/pull/50),
   [exact proposed commit](https://github.com/ionic-team/capacitor-keyboard/commit/bbac4c3).
3. Test docked keyboard show/hide, rotate with the keyboard open, Stage Manager/Split View if used, floating/split
   keyboard, app background/resume, and hardware-keyboard shortcut-bar behavior. Keep the patch only if the physical
   iPad result is visibly better without a jump, exposed backdrop, or stale shrunken frame.
4. Only if the patched native resize is timely but still visibly choppy, batch Alpha's existing viewport synchronization
   in `requestAnimationFrame` and compare the same measurements. Avoid a composer-overlay redesign unless the product
   later decides that panes should intentionally remain full-height behind the software keyboard.

## Confidence boundary

The deterministic delay and current mode are verified from Alpha's installed package and official pinned source. The
recommendations have not yet been installed or measured on the physical iPad. The open PR is strong evidence for the
smallest fix, but it is not an accepted Capacitor release and therefore needs device validation and an upgrade-removal
note if adopted.
