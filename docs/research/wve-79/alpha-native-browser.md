# WVE-79: native Alpha Browser Pane integration

The first Browser Pane integration is implemented and installed in the main Weave app on the Mac and connected iPad as of 13 September 2026. The Mac Host now runs the managed CEF backend. This is an in-progress build for testing. The user confirmed integrated iPad animation, clicks and text entry, then confirmed the crop fix and motion improvement. Sustained 60 FPS and the remaining interaction gates stay open.

## Product behavior

- Browser is available in the shared Down/Right split flow and the new-Workspace menu. It uses the shared Pane rail, focus boundary and sidebar selection.
- Creating a Pane selects an existing Host Profile or creates a named persistent Profile. Splitting a Browser suggests its Profile. Other creation uses the last Profile used in that Workspace, currently remembered locally on each client.
- One Pane is one Host-owned page. Back, Forward, Reload, address entry, explicit Restore and confirmed shared closure are wired to Portal. Page-created pages inherit the Profile and become Right splits through Portal's lifecycle reconciliation.
- The latest client to activate a Pane claims the server viewport. Passive viewers follow it. Input waits until the native framebuffer matches the acknowledged size. Losing or reconnecting a display leaves the page alive.
- The creation dialog retains its page ID across retries. A display failure offers Reconnect display. Host disconnect removes the native view and reconnect creates a new lease.
- Audio remains disabled. There is no webpage accessibility bridge.

## Native boundary

`native/browser/WeaveBrowserSurface.mm` is shared Objective-C++ for AppKit and UIKit. Foundation carries the authenticated binary WebSocket directly to LibVNCClient 0.9.15. A bounded socket pair joins the WebSocket and decoder workers. Native frames are presented through CGImage/CALayer; pixels never pass through the React or Capacitor bridge.

The Electron addon and Capacitor plugin expose fixed create/connect/control/layout/close operations. The shell retains authentication signing and authorized Portal input. It does not expose arbitrary native paths or decoder operations to webpages. The native layer follows the Pane geometry, hides for shell overlays, and lets the shell receive input.

Keyboard input uses CDP key dispatch and Unicode insertion. The shell supplies pointer buttons, drag, wheel, basic touch scrolling and text insertion. These are an initial input path: native clipboard export, full IME/caret positioning, native cursor shape, hover fidelity and popup widgets are not finished.

The LibVNC build is pinned and cached separately for macOS arm64 and iOS arm64. Both client builds reuse it. Portal's source hash excludes generated `.build` directories rather than reading cached SDK contents. No Chromium source build is needed for these builds.

## Evidence

A disposable Host and the packaged Alpha acceptance build exercised the actual Profile picker, new Browser-only Workspace, native addon, authenticated WebSocket, decoder and authorized input. Chromium recorded one button click and the exact Unicode text `Weave ✓`. The native screenshot matched the CEF reference at 1147 × 849 with **zero differing pixels**. The capture came from the native Browser layer, not WebContents capture, which excludes that layer.

The acceptance run used protocol v7 immediately before the compatibility-only v8 change. The installed normal builds use v8 and include the subsequent retry and reconnect corrections. The installed app is not the acceptance-flavored build.

Evidence is in [evidence/alpha-native](evidence/alpha-native/): the native/reference images, acceptance result, pixel comparison and focused test logs. Validation completed:

- 288 Alpha tests across 58 files, including the decoded-size input barrier, stalled-detach cleanup and late attachment disposal.
- 136 Portal tests before the final legacy pairing correction, followed by all nine security tests including a new pre-browser pairing regression. Portal TypeScript passes after the correction.
- 39 shared protocol tests.
- Normal Mac packaging and iPad Debug device builds, including the shared Objective-C++ module and Swift plugin.
- Signed Host and CEF runtime verification.

Static pixel equality is not an FPS or latency result. Earlier standalone iPad spike acceptance does not establish acceptance of this integrated client.

## Daily installation

Installed the matching Mac app and Host components, installed and launched the main iPad app, and enabled the installed managed CEF runtime. The iPad inventory contained only the main Weave development app, so no extra spike app needed removal. No iPhone or Linux deployment was changed.

The Host reports shared protocol v8. The Mac app reconnected with the existing Odin composition and Casual greeting Thread. The terminal owner retained PID 13352 throughout the Host restart. Existing credentials and application profiles were retained. The initial app composer was empty before restart.

Backups are under `~/.local/share/weave/backups/browser-integration-20260913-185638/` and the desktop installer's timestamped backup. Host files were replaced by rename, preserving the running terminal owner. CEF was installed under `~/Library/Application Support/Weave/Portal/browser-runtime/Weave Browser.app` with its stable development signing identity. The Host config now points `browser.cefExecutable` there.

The live Profile picker caught two installation differences absent from the disposable fixture:

1. The current Electron credential predates even the transitional browser actions. The migration now recognizes both pre-browser and transitional unrestricted administrative pairings. Explicit Profile scopes and opt-outs remain restricted; tests cover both histories.
2. The older Host state directory had mode 0755. It was verified as a real directory owned by the current user, then restricted to 0700 to satisfy Browser Service privacy requirements. Profile contents were not removed or moved.

The installed Browser Service responds to Profile listing after those repairs. The first attempt at the installed Profile picker occurred before the repairs and failed; the user subsequently created the test Profile/page on the iPad and confirmed display, clicks and text input. A loopback-only fixture at `http://127.0.0.1:4199` on the Mac is running for the user's integrated check. CEF fetches it on the Host, including when an iPad displays the page. It provides animation, a click counter, text input, scrolling and a child-page button. Its temporary source is `/tmp/wve79-browser-installed-fixture.ts`.

## Remaining gates

1. Expand the confirmed iPad animation/click/text/scroll check to hardware/software keyboard, IME, background/foreground, connection loss and sustained two-device focus handoff.
2. Measure scrolling FPS, bandwidth, latency and native memory/CPU with real content. 60 FPS is the goal, not a verified result.
3. Complete popup-widget compositing, cursor and hover behavior, clipboard, IME/caret integration, dialogs, permissions and file transfer. Page-created child Panes are distinct from CEF popup widgets.
4. Surface layout-capacity failure to the user; Portal currently closes an unplaceable popup and logs the cause.
5. Route full authorized agent MCP/CDP control through Portal with concrete Profile grants. The public human input API deliberately accepts only its narrow CDP input methods.
6. Rerun the integrated native clients against Linux. Prior Linux Portal/RFB evidence remains useful but used the earlier acceptance transport bridge.

## Installed feedback: crop and animation jank

The user first confirmed animation, clicks and text input, but reported substantial animation/scroll jank and a crop around the Clicks button on both platforms. The Mac UI reproduction showed black pixels outside the next dirty rectangle.

The crop was a producer bug: every focus claim called `rfbNewFramebuffer`, including unchanged sizes. That cleared retained pixels while Chromium correctly repainted only the changed region. The native CEF adapter now preserves the framebuffer on same-size requests and requests a view invalidation after a real resize.

The real Portal acceptance now repeats same-size focus claims, changes a small rectangle, captures RFB **before** requesting the CEF reference screenshot, and compares decoded pixels automatically on Mac. Capturing the CEF reference first masks this failure by causing a repaint. The regression fails against the old runtime with 783,963 differing pixels out of 800,000 and passes the corrected runtime with zero differences. The fixed runtime is installed; the Mac UI repeated click retained the full page. The user's subsequent iPad response was: “Yes much better.”

A separate pointer safeguard records the decoded size when the gesture occurs. If a focus claim reflows the page before delivery, that gesture claims the viewport only; it is not replayed against a target that moved. A focused regression covers that handoff. The latest Mac and iPad builds include it.

Animation profiling used opt-in `WEAVE_BROWSER_DIAGNOSTICS=1` instrumentation, bounded to 300 recent timing/count samples in the app's temporary directory, with no URLs, pixels or input data. Profiling is disabled in the final installed launch. These measurements count native layer submissions, not display scanout:

| Sample | Native submissions/s | Typical interval | p95 interval |
| --- | ---: | ---: | ---: |
| Initial integrated iPad | 25.39 | 33.40 ms | 98.16 ms |
| Only remove per-frame shell notifications | 25.51 | 33.35 ms | 99.51 ms |
| Also remove the RFB producer's 5 ms defer timer | 50.11 | 16.86 ms | 20.01 ms |
| Later user-confirmed sample | 49.83 | 16.72 ms | 21.43 ms |

The Host's 10-second requestAnimationFrame sample measured 60.00 callbacks/s. Initial receiver decode CPU was about 1.74% of one core, framebuffer copy median 0.62 ms and main-thread queue median 0.05 ms. Removing shell notifications alone did not improve delivered cadence. The larger improvement followed removal of the additional RFB deferral, while retaining upstream RFB decoding and lossless encodings. CEF already batches paints.

The short samples used different viewport sizes as the user switched devices and layout (461 × 749 initially, 563 × 852 and later 1077 × 849). They establish a useful improvement, supported by user feedback, but are not a controlled scrolling benchmark or a 60 FPS acceptance result. Timing evidence and crop regression artifacts are in [evidence/alpha-native/jank](evidence/alpha-native/jank/).

Applying the producer correction required replacing the test Profile's native runtime. Only the two localhost fixture pages were open; their identities, text values and counters were saved and restored. The terminal owner remained running. The final Mac/iPad app replacements preserve Host-owned page lifetime.
