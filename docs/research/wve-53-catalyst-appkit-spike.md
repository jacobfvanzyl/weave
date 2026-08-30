# WVE-53 Catalyst and AppKit spike

Date: 2026-08-29

Status: Phase 1 gate passed. Mac Catalyst is rejected for the current Capacitor shell; proceed to
incorporation with native AppKit and physical-iPadOS WebKit hosts behind one browser-session
contract. Portal/MCP and agent control remain Phase 2.

## Question

Can the current Alpha client add a native macOS browser surface while retaining the same WebKit floor intended for physical iPadOS?

The gate was deliberately narrow:

1. Try the existing Capacitor iOS shell as a Mac Catalyst application.
2. If Capacitor is the blocker, build a disposable AppKit host that renders the real Alpha React shell and an independent browser `WKWebView` side by side.
3. Prove navigation, focus, resizing, hide/show, and browser teardown without adding Portal RPC or agent control.

## Catalyst result: reject for Alpha's current shell

Enabling `SUPPORTS_MACCATALYST` exposed a Mac Catalyst destination in Xcode, but the application cannot link. Capacitor 8.3.4's distributed SwiftPM artifacts contain no Mac Catalyst library:

```text
Capacitor.xcframework: While building for Mac Catalyst, no library for this platform was found
Cordova.xcframework: While building for Mac Catalyst, no library for this platform was found
```

This occurs in Capacitor's core binary artifacts before Alpha-specific code or optional plugins become relevant. The ordinary iOS Simulator build succeeds from the same checkout. The temporary Catalyst project setting was reverted after recording the result.

Verdict: do not spend more Phase 1 time trying to make the existing Capacitor target a Catalyst app. Doing so would require replacing or rebuilding a foundational dependency rather than adding the browser feature.

## AppKit result: proceed

The disposable prototype lives at `product/alpha/prototypes/macos-wkwebview-host` on branch `spike/wve-53-catalyst`.

It uses a single native window containing:

- an AppKit-owned `WKWebView` loading the existing Alpha Vite application;
- a sibling, non-persistent `WKWebView` for general web content;
- a native location field and back, forward, reload, reset, close, and show controls;
- a resizable split view;
- a destructive reset that removes the old browser view and creates a new browser session.

The repeatable smoke mode rendered both real pages and recorded all assertions as true:

| Assertion | Result |
| --- | --- |
| Alpha loaded from `http://127.0.0.1:5174/?mock=sidebar` | Pass |
| Browser loaded `https://example.com` | Pass |
| Alpha and browser are distinct `WKWebView` instances | Pass |
| Browser uses `WKWebsiteDataStore.nonPersistent()` | Pass |
| Location field accepts first-responder focus | Pass |
| Navigation reached `example.org` | Pass |
| Back returned to `example.com` | Pass |
| Forward returned to `example.org` | Pass |
| Browser pane collapsed and restored | Pass |
| Browser reset created a fresh view and reloaded the default page | Pass |
| Window laid out at 1400x900 content size and resized to 1180x720 | Pass |
| Native view rendered to a 2360x1440 Retina PNG | Pass |

The existing Alpha test suite remained green at 185 tests across 36 files, the production Alpha build passed, and the product dependency boundary remained clean.

## What this establishes

The Apple-only direction is viable, but the macOS shell should be native AppKit rather than Mac Catalyst:

- iPadOS keeps the existing Capacitor/UIKit application and adds an Alpha-owned sibling `WKWebView`.
- macOS gets a thin AppKit application that owns both the Alpha shell `WKWebView` and browser `WKWebView`.
- React owns browser session intent and pane geometry through a small cross-platform bridge; each native shell owns the actual WebKit view hierarchy.
- The common contract can stay at the iPadOS WebKit floor: open, navigate, back, forward, reload, focus, close, observe state, and update geometry.

This copies the useful T3 Code seam—React slot plus host-owned browser—without importing Electron or Chromium.

## Still not proved by the first host slice

This spike does not establish:

- live Portal pairing inside the AppKit-hosted Alpha shell;
- OAuth callback and credential policy;
- multiple browser sessions, OAuth callback handling, hardened packaging, or app distribution;
- any MCP, Portal proxy, browser tool, or agent-control behavior.

## Docked Browser slice

The follow-up slice promotes Browser into Alpha's existing workspace dock model instead of keeping
the prototype's fixed native split view.

Observed behavior:

- Browser is a first-class dock panel alongside Terminal and Project.
- It defaults to Right and exposes the same context-menu, keyboard-menu, and touch long-press
  placement interaction as Terminal.
- It can move between Bottom and Right while revealing the panel beneath the vacated dock.
- Bottom and Right retain their existing independent remembered sizes.
- Browser uses the same maximize/restore workspace replacement path and controls as Terminal.
- Closing the Browser pane hides the native surface but retains its in-memory session; restarting
  the native host or using Reset creates a fresh non-persistent WebKit session.
- The v3 dock state migrates existing v2 Terminal placement, per-scope openness, Project state, and
  remembered sizes while adding Browser closed on Right.

The React/native contract is deliberately small. Alpha sends `status`, `present(frame)`, `hide`,
`navigate`, `back`, `forward`, `reload`, `stop`, and `reset` commands through the AppKit shell's
`alphaBrowser` WebKit message handler. AppKit returns bounded URL, title, loading, history, and error
state through `weave:alpha-browser-state`. The React slot observes its own rectangle and window,
scroll, and resize changes; AppKit converts the top-left CSS rectangle to its bottom-left native
coordinate space and places the separately owned browser `WKWebView` above the Alpha shell.

Two native smoke runs rendered ordinary HTTPS content into the actual measured slot:

| Layout | Result |
| --- | --- |
| Browser Right | Pass: narrow full-height native surface beside Alpha |
| Browser Bottom | Pass: wide short native surface below the workspace while Project remains Right |

Both runs passed distinct-WebView ownership, non-persistent storage, measured-slot presentation,
address-field focus, navigation to a second origin, back, forward, reset, window resize, and native
Retina capture. React acceptance separately drives Bottom/Right movement, maximize/restore, and
close/reopen; driving those React transitions by executing a DOM click from inside the same native
WebKit callback would make the test driver re-enter its own synchronous bridge rather than model a
human click.

### Physical iPadOS host

The Capacitor `WeaveBridgeViewController` now installs the same `alphaBrowser` message handler and
owns an independent `WKWebView` above the shell WebView. It uses a non-persistent website data store,
maps React's top-left CSS slot rectangle directly into UIKit points, retains the browser session
while hidden, recreates it on Reset, reports navigation state to React, and handles new-window links
in the visible browser rather than creating a hidden tab.

The signed build compiled, installed, and launched on the connected physical iPad. A debug-only,
environment-gated smoke path captured the actual device window through the app data container. The
results were read back from the device rather than inferred from successful installation:

| Physical-iPad assertion | Result |
| --- | --- |
| React detects the native `alphaBrowser` handler | Pass |
| Unsupported fallback is absent | Pass |
| Right slot presents native Example Domain | Pass at `(545.6, 44.0, 634.4, 744.0)` points |
| Bottom slot presents native Example Domain while Project remains Right | Pass at `(171.8, 556.0, 372.7, 232.0)` points |
| Maximize uses the Terminal workspace-replacement path | Pass at `(382.4, 44.0, 797.6, 744.0)` points |
| Browser navigation finishes at `https://example.com/` | Pass |

React verification remains green at 37 test files and 191 tests, the production build passes, the
product dependency boundary is clean, and the signed iOS build succeeds. The later fixture and
lifecycle slices complete the broader Phase 1 matrix on both Apple targets.

## Deterministic fixture and browser policy slice

`product/alpha/prototypes/browser-fixture` now provides a disposable Bun HTTP server rather than
relying on public sites. Its six HTTP tests and 33 assertions cover stable resources for normal and
history navigation, redirect, slow and 500 responses, a target-blank popup, CSP/X-Frame denial,
multipart upload, attachment download, permission requests, an observable cookie round trip, and a
deterministic page for native snapshot/type/key/click/wait/scroll control.
It has no Portal, MCP, or agent dependency.

Both native hosts now expose the same policy through the existing browser-state event:

| Surface | Phase 1 policy |
| --- | --- |
| Popup/new-window links | Load in the current visible Browser session |
| Uploads | Human-selected files through the platform system picker |
| Downloads | Cancel and display an explicit unavailable notice |
| Camera/microphone | Reject `getUserMedia` at document start, retain the native delegate denial, and advertise the policy continuously |
| Geolocation, notifications, other permissions | Leave at WebKit/platform defaults and say so explicitly |
| Non-HTTP(S) top-level URLs | Reject rather than escape to another app or local-file surface |
| Browser data | Use a non-persistent store; Reset creates a fresh store |

The Browser pane displays the stable policy in a compact, single-line banner and displays attempted
popup/download/media actions as non-destructive notices. Errors remain a separate destructive
state. macOS implements file selection with `NSOpenPanel`; iPadOS deliberately retains WebKit's
Safari-like system picker behavior.

The repeatable macOS fixture smoke passed in both Right and Bottom docks. The final Right-dock run
reported every assertion true: fixture load; second-page, back, and forward navigation; reload with
same-session storage retained; popup routed into the same visible session plus notice; attachment
download blocked plus notice; unsupported scheme rejected; unreachable DNS failure visible and
recovery successful; content-termination state visible and recovery successful; cookie present
before Reset and absent after Reset; independent WebViews; non-persistent data store; measured slot;
address focus; window resize; policy visible; and native PNG capture. Separate macOS processes proved
that a cookie seeded in one process was absent in the next.

The native-only controllability probe operated the exact visible macOS browser and passed a bounded
DOM snapshot, input focus and value change, `Enter` key dispatch, click plus asynchronous wait, and
scroll-to-target. This proves the host can support deterministic structured primitives; it does not
choose or expose a Portal/MCP protocol.

The fixture reports `permission:camera:denied:TypeError`: media capture is not exposed in this
unsigned HTTP context, so the request fails before WebKit asks the native delegate. The
document-start policy still prevents permission access when the API is exposed, while the native
delegate remains a second denial boundary where available.

The updated signed app also compiled, installed, and ran on the connected physical iPad. Plain HTTP
fixture navigation was rejected by App Transport Security, so the run used a temporary Tailscale
Serve HTTPS origin without weakening the app's ATS policy. The device-written report recorded every
automated assertion as passing:

| Physical-iPad fixture assertion | Result |
| --- | --- |
| Fixture, push-state, back, forward, and redirect navigation | Pass |
| Popup remains in the visible Browser session | Pass |
| Attachment download and unsupported top-level scheme are blocked | Pass |
| CSP frame denial and rendered HTTP 500 response | Pass |
| Slow navigation starts and can be stopped | Pass |
| Reload retains same-session state and renders the fixture again | Pass |
| Unreachable DNS failure is visible and navigation recovers | Pass |
| Content-termination state is visible and navigation recovers | Pass |
| Cookie is present before Reset and absent afterward | Pass |
| Cookie seeded in one app process is absent after terminate-and-relaunch | Pass |
| Camera request produces a page-visible denial | Pass (`permission:camera:denied:TypeError`) |
| Native snapshot/type/key/click/wait/scroll probe on the visible browser | Pass |
| System document picker cancellation leaves the input empty | Pass |
| System document picker submits a file end to end | Pass (`2025-Ala-Carte-Menu-Final.pdf`, 522,702 bytes, `application/pdf`) |

The human picker results were read back from each running native host rather than inferred from the
picker merely appearing. macOS `NSOpenPanel` cancellation left the input empty, and a successful
local submission returned file metadata from the fixture server. The fixture parses the multipart
request in memory and does not save or log file contents.

Both hosts exercise `webViewWebContentProcessDidTerminate` with the exact visible browser instance
and prove visible failure state followed by successful navigation recovery. Full application
process termination is real on both targets. WebKit provides no public deterministic test hook for
killing only an iPadOS WebContent process, so the spike deliberately invokes the public delegate
boundary rather than using private APIs; incorporation must retain the handler and accept
opportunistic OS-level termination coverage.

## Phase 1 gate verdict: proceed to incorporation

| Gate | Result |
| --- | --- |
| Research, engine/package/license, and platform matrix recorded | Pass |
| One browser-session abstraction drives both Apple hosts | Pass |
| Navigation, history, loading/failure, storage, popup, file, permission, and embedding behavior observed | Pass |
| Browser host and lifecycle owner identified per platform | Pass |
| Exact visible browser supports deterministic native control primitives | Pass |

The incorporation architecture is:

- **Shared contract:** Alpha owns one bounded browser-session state/command contract at the iPadOS
  WebKit floor. It does not expose raw `WKWebView`, JavaScript evaluation, cookies, or debugging.
- **iPadOS host:** the existing Capacitor/UIKit shell owns the sibling browser `WKWebView`.
- **macOS host:** a thin AppKit shell owns both the Alpha shell and browser `WKWebView`; do not revive
  the rejected Catalyst path or add Electron/Chromium for Phase 1.
- **Lifecycle/data:** one visible session, hidden rather than destroyed on pane close; Reset and app
  restart create a fresh `WKWebsiteDataStore.nonPersistent()` profile.
- **Policy:** popups stay in-session, downloads remain unavailable until explicitly designed,
  uploads are human-selected, camera/mic stay denied, other permissions remain WebKit defaults, and
  top-level navigation is limited to HTTP(S).
- **Control readiness:** native structured primitives are feasible on the same visible session, but
  Portal addressing, authorization, leases, result bounds, and agent-visible actions remain Phase 2.

The prototype harness is primary-source evidence on the spike branch, not production code. Rewrite
the validated boundaries as deep production modules, move durable acceptance into those modules,
and then delete the prototype-only environment variables, polling files, and fixture hooks from the
incorporation branch.

## Reproduction

Start Alpha:

```sh
cd product
bun run dev:alpha
```

Start and test the deterministic fixture in a second terminal:

```sh
cd product/alpha
bun run browser:fixture:test
bun run browser:fixture
```

Build and run the macOS prototype:

```sh
cd alpha/prototypes/macos-wkwebview-host
swift build --scratch-path /tmp/wve-53-macos-host-build
PROTOTYPE_SMOKE_OUTPUT=/tmp/wve-53-macos-host.png \
  BROWSER_FIXTURE_URL=http://127.0.0.1:5175/ \
  swift run --scratch-path /tmp/wve-53-macos-host-build
```

The external scratch path prevents Vite from watching SwiftPM compiler artifacts beneath Alpha's
source root. The smoke run writes `/tmp/wve-53-macos-host.png` and
`/tmp/wve-53-macos-host.json`, then exits.

Use `PROTOTYPE_RESTART_STAGE=seed` and then `verify`, with a distinct
`PROTOTYPE_RESTART_OUTPUT` for each process, to reproduce cross-process cookie disposal. Use
`PROTOTYPE_HUMAN_OUTPUT` for a long-running human file-picker report; the optional
`PROTOTYPE_UPLOAD_DIRECTORY` chooses the initial `NSOpenPanel` directory.

Build, install, and launch the iPad host from the repository root:

```sh
xcodebuild \
  -project product/alpha/ios/App/App.xcodeproj \
  -scheme App \
  -destination 'generic/platform=iOS' \
  -derivedDataPath /tmp/wve53-alpha-derived \
  build
xcrun devicectl device install app \
  --device <device-id> \
  /tmp/wve53-alpha-derived/Build/Products/Debug-iphoneos/App.app
xcrun devicectl device process launch \
  --device <device-id> \
  com.veezee.alpha
```

The optional debug smoke is enabled only when `WVE53_BROWSER_SMOKE=1`. Set
`WVE53_BROWSER_SMOKE_DOCK=bottom` to force the Bottom layout and
`WVE53_BROWSER_SMOKE_MAXIMIZE=1` to exercise the real maximize control. Set
`WVE53_BROWSER_SMOKE_URL` to a fixture URL reachable from the iPad. It writes
`Library/Caches/wve53-ipad-browser.png` and `wve53-ipad-browser-state.json` inside the Alpha app
data container for `devicectl device copy from`. Run separate launches with
`WVE53_BROWSER_RESTART_STAGE=seed` and `verify`, using `--terminate-existing` between them, to
reproduce full-process ephemeral-cookie disposal.
