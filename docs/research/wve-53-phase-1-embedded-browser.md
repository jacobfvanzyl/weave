# WVE-53 Phase 1: Apple-platform embedded browser

Date: 2026-08-29

Status: research and spike recommendation; no browser has been implemented or
proved on a device by this document.

## Decision

Phase 1 should be owned by the Alpha client and should not depend on Portal.
The supported Phase 1 matrix is Apple-only: physical iPadOS and macOS, both
backed by an Alpha-owned `WKWebView`. Browser-hosted Alpha is not a supported
embedded-browser host.

Apple exposes the same core WebKit browser surface on both platforms:
navigation and UI delegates, programmatic navigation and history, JavaScript
evaluation, script messaging, snapshots, downloads, and website data stores.
The view host differs: `WKWebView` is a `UIView` on iPadOS and Mac Catalyst, and
an `NSView` in a native macOS app. The shared contract should therefore target
the common WebKit behavior while keeping view hierarchy, lifecycle, native
dialogs, and permission presentation behind small platform adapters.

The first macOS experiment should be Mac Catalyst because it can reuse Alpha's
existing UIKit/Capacitor shell and makes the browser host closest to the iPadOS
implementation. This is not currently configured or proved: Alpha's Xcode
target is iPhone/iPad-only, and Capacitor's supported-platform documentation
does not promise a macOS target. If Catalyst is blocked by Capacitor or plugin
compatibility, use a thin native AppKit Alpha shell while retaining the same
browser-session contract and WebKit manager.

The first runnable slice should prove human browsing: create one session, place
it in a resizable Alpha pane, navigate, go back/forward, reload, close, and report
URL/title/loading/history/error state. It should not add MCP, browser tools,
Playwright, streaming, or agent control.

This is the lowest-risk route to the same real embedded browser engine on iPad
and Mac. It also removes the iframe asymmetry: arbitrary third-party pages may
refuse framing and cross-origin pages cannot be controlled reliably from a
browser-hosted Alpha client, so that platform is explicitly unsupported rather
than represented by a misleading partial browser.

## Facts and inferences

This note uses the following labels:

- **Fact**: directly observed in the fixed Weave/T3 Code source revisions or in
  first-party platform documentation linked here.
- **Inference**: an engineering conclusion drawn from those facts. It still
  needs a runnable spike or product decision.

The Weave source links are fixed at
[`7a9309b`](https://github.com/jacobfvanzyl/weave/tree/7a9309b241065df606d770683f253c57f078341b).
The T3 Code checkout was clean at
[`e9f50c3`](https://github.com/pingdotgg/t3code/tree/e9f50c3efcb02a199042364ead292e164274e716),
dated 2026-08-24. T3 Code is
[MIT licensed](https://github.com/pingdotgg/t3code/blob/e9f50c3efcb02a199042364ead292e164274e716/LICENSE).

## Current Alpha seams

### Platform shell

- **Fact:** Alpha uses Capacitor 8.3.4 and has no Browser or InAppBrowser package
  dependency today. See
  [`product/alpha/package.json`](https://github.com/jacobfvanzyl/weave/blob/7a9309b241065df606d770683f253c57f078341b/product/alpha/package.json#L15-L45).
- **Fact:** the generated iOS package targets iOS 15. See
  [`CapApp-SPM/Package.swift`](https://github.com/jacobfvanzyl/weave/blob/7a9309b241065df606d770683f253c57f078341b/product/alpha/ios/App/CapApp-SPM/Package.swift#L5-L18).
- **Fact:** the current Xcode project uses the `iphoneos` SDK, targets iPhone and
  iPad device families, and does not enable Mac Catalyst. There is no native
  macOS Alpha target in the repository.
- **Fact:** `WeaveBridgeViewController` already subclasses
  `CAPBridgeViewController`, registers a native Capacitor plugin, and is installed
  as the scene's root controller. See
  [`SceneDelegate.swift`](https://github.com/jacobfvanzyl/weave/blob/7a9309b241065df606d770683f253c57f078341b/product/alpha/ios/App/App/SceneDelegate.swift#L175-L200).
- **Fact:** Alpha's `Info.plist` has a scoped `NSAllowsLocalNetworking` ATS setting
  and a local-network usage string. It has no `WKAppBoundDomains` entry. See
  [`Info.plist`](https://github.com/jacobfvanzyl/weave/blob/7a9309b241065df606d770683f253c57f078341b/product/alpha/ios/App/App/Info.plist#L27-L49).
- **Inference:** the root bridge controller is the narrowest iOS ownership seam.
  It can own a browser manager/plugin and insert a sibling or child `WKWebView`
  without making the Portal daemon part of rendering.
- **Inference:** Mac Catalyst is the smallest first macOS probe because it keeps
  this UIKit ownership seam. It is an acceptance question, not an assumed
  Capacitor capability. A native AppKit fallback would need a separate root
  controller/view host but can keep the WebKit session manager and TypeScript
  contract unchanged.

### React shell

- **Fact:** the current pane model is explicit and has no browser pane yet:
  `threads`, `thread`, `editor`, and `project`. See
  [`alpha-pane-layout.ts`](https://github.com/jacobfvanzyl/weave/blob/7a9309b241065df606d770683f253c57f078341b/product/alpha/src/app/alpha-pane-layout.ts#L4-L18).
- **Fact:** non-mobile content uses a measured, persisted horizontal resizable
  layout, while the mobile branch presents a single thread/editor surface. See
  [`alpha-shell.tsx`](https://github.com/jacobfvanzyl/weave/blob/7a9309b241065df606d770683f253c57f078341b/product/alpha/src/components/alpha-shell.tsx#L39-L105)
  and its
  [resizable row](https://github.com/jacobfvanzyl/weave/blob/7a9309b241065df606d770683f253c57f078341b/product/alpha/src/components/alpha-shell.tsx#L146-L197).
- **Fact:** Alpha already observes Capacitor `appStateChange` and runs resume work
  after an inactive-to-active transition. See
  [`use-app-resume.ts`](https://github.com/jacobfvanzyl/weave/blob/7a9309b241065df606d770683f253c57f078341b/product/alpha/src/app/use-app-resume.ts#L4-L23).
- **Inference:** add the browser as an Alpha pane/surface, not as a modal launched
  outside the layout. The native adapter must consume the browser slot's changing
  viewport rectangle and hide/remove its native view when the React surface is
  obscured, unmounted, or zero-sized.

### Protocol and Portal boundary

- **Fact:** the product protocol already exposes a `capabilities: string[]` list
  and stable `hostId`/`threadId` identities. See
  [`product/protocol/src/index.ts`](https://github.com/jacobfvanzyl/weave/blob/7a9309b241065df606d770683f253c57f078341b/product/protocol/src/index.ts#L227-L250).
- **Fact:** Portal currently has no browser or Playwright dependency in
  [`portal/deno.json`](https://github.com/jacobfvanzyl/weave/blob/7a9309b241065df606d770683f253c57f078341b/portal/deno.json#L1-L27),
  and the current product protocol has no browser RPC.
- **Inference:** capability negotiation is the right shape for later work, but
  Phase 1 does not require a Portal capability. The browser session is local UI
  state until there is an explicit Phase 2 control contract.

## Reference implementations

### T3 Code

T3 Code is the most useful code reference because it separates a browser slot in
React from a platform-owned real browser:

- **Fact:** its preview contract explicitly says the feature is desktop-only,
  uses a Chromium `<webview>`, and lets the desktop renderer own the actual view.
  See
  [`packages/contracts/src/preview.ts`](https://github.com/pingdotgg/t3code/blob/e9f50c3efcb02a199042364ead292e164274e716/packages/contracts/src/preview.ts#L1-L9).
- **Fact:** `BrowserSurfaceSlot` measures `getBoundingClientRect()`, observes
  resize, scroll, and window resize, then presents the browser at that rectangle.
  See
  [`BrowserSurfaceSlot.tsx`](https://github.com/pingdotgg/t3code/blob/e9f50c3efcb02a199042364ead292e164274e716/apps/web/src/browser/BrowserSurfaceSlot.tsx#L27-L71).
- **Fact:** `ElectronBrowserHost` is capability-gated by `isElectron` and owns
  `HostedBrowserWebview` instances. See
  [`ElectronBrowserHost.tsx`](https://github.com/pingdotgg/t3code/blob/e9f50c3efcb02a199042364ead292e164274e716/apps/web/src/browser/ElectronBrowserHost.tsx#L72-L98).
- **Fact:** the hosted component renders a real Electron `<webview>` with an
  explicit partition and web preferences. See
  [`HostedBrowserWebview.tsx`](https://github.com/pingdotgg/t3code/blob/e9f50c3efcb02a199042364ead292e164274e716/apps/web/src/browser/HostedBrowserWebview.tsx#L245-L285).
- **Fact:** its desktop manager owns Chromium `WebContents` state, including a
  `human | agent | none` controller. See
  [`Manager.ts`](https://github.com/pingdotgg/t3code/blob/e9f50c3efcb02a199042364ead292e164274e716/apps/desktop/src/preview/Manager.ts#L1-L7)
  and
  [tab state](https://github.com/pingdotgg/t3code/blob/e9f50c3efcb02a199042364ead292e164274e716/apps/desktop/src/preview/Manager.ts#L70-L98).
- **Fact:** automation hosts return `null` outside Electron or without an
  automation bridge. See
  [`PreviewAutomationHosts.tsx`](https://github.com/pingdotgg/t3code/blob/e9f50c3efcb02a199042364ead292e164274e716/apps/web/src/components/preview/PreviewAutomationHosts.tsx#L247-L258).
- **Fact:** the visible agent cursor is a host overlay positioned from pointer
  events, not proof of a browser-native remote cursor. See
  [`AgentBrowserCursor.tsx`](https://github.com/pingdotgg/t3code/blob/e9f50c3efcb02a199042364ead292e164274e716/apps/web/src/components/preview/AgentBrowserCursor.tsx#L14-L64).

**Inference:** copy the architecture—stable session ID, DOM slot, host-owned
browser, capability gate—not the Electron implementation. On iPadOS and macOS,
the host is Alpha/WebKit; T3's Electron-only gate is evidence that the host
boundary matters, not a reason for Alpha to ship Chromium.

### ChatGPT desktop Browser

OpenAI does not document the private renderer implementation, so this reference
is about the user and security contract only:

- **Fact:** the desktop app presents a shared in-chat browser with a profile
  separate from the user's regular browser, explicit browser-data controls, and
  a download location. [Official Browser documentation](https://learn.chatgpt.com/docs/browser#browser)
- **Fact:** Computer Use can open, click, type, inspect rendered state, and take
  screenshots; site access and sensitive actions are approval-gated. File upload
  automation is explicitly unsupported.
  [Official Computer Use section](https://learn.chatgpt.com/docs/browser#computer-use-in-the-browser)
- **Fact:** full CDP access is a separate elevated developer-mode permission.
  [Official Developer mode section](https://learn.chatgpt.com/docs/browser#developer-mode)
- **Fact:** OpenAI separately documents a cloud browser running on another
  computer for mobile/web use. That is a remote-browser model, not evidence that
  the local built-in browser uses streaming.
  [Official ChatGPT Work section](https://learn.chatgpt.com/docs/browser#use-chatgpt-work-to-get-things-done-across-the-web)

**Inference:** Phase 1 should establish profile separation, visible origin, and
human ownership before control is added. Any later privileged control should be
capability- and consent-gated; it should not be implied by merely displaying a
page.

## Platform and option matrix

| Option | macOS Alpha | Physical iPadOS | Pane geometry | Arbitrary sites and auth | Control ceiling | Phase 1 verdict |
| --- | --- | --- | --- | --- | --- | --- |
| Plain `iframe` | Web primitive only | Would run inside Capacitor's shell web view | Excellent | Unreliable: CSP/`X-Frame-Options`, third-party-cookie rules, and popup/permission policy apply | Same-origin/cooperative pages only | Reject as a browser host; use only inside deterministic tests |
| `@capacitor/browser` / `SFSafariViewController` | No supported macOS implementation | System browser controller | Modal/popover, not an Alpha pane | Strong general human browsing and Safari privacy | No DOM/evaluation/snapshot surface | Reject for the embedded-pane requirement; retain for “Open externally” on iPadOS |
| `@capacitor/inappbrowser` WebView | No supported macOS implementation | Custom mobile WebView | Full screen/page sheet/form sheet, not arbitrary pane frame | General human browsing; isolated iOS storage by default | Public API has navigation/load events, no arbitrary geometry/evaluate/snapshot | Reject; it cannot provide the Apple-platform pair or pane host |
| Alpha-owned `WKWebView` | Native WebKit `NSView`, or `UIView` under Catalyst | Native WebKit `UIView` | Yes, if React sends measured slot rectangles | General top-level browsing; WebKit privacy/ATS rules apply | Common delegates, JS evaluation, messaging, snapshots; not CDP | Recommended on both platforms |
| Portal Playwright/Chromium + streamed frames | Can display a remote stream | Can display the same remote stream | Yes, as pixels/canvas/video | General Chromium session on Portal host | High, CDP/Playwright-based | Defer; it breaks the Apple/WebKit lowest-common-denominator strategy |

### Common WebKit floor

Apple documents `WKWebView` for iOS, iPadOS, Mac Catalyst, and macOS. The class
is a `UIView` on iPadOS/Catalyst and an `NSView` on native macOS, while the core
browsing APIs include delegates, history/navigation, JavaScript evaluation,
and snapshots on both.
[WKWebView documentation](https://developer.apple.com/documentation/webkit/wkwebview)

The Phase 1 common contract is therefore meaningful, but should not pretend the
entire UI framework is shared. Keep these behind platform adapters:

- adding, clipping, focusing, and resizing the native view;
- application foreground/background or window activation;
- file panels, downloads, popups, and native permission prompts;
- safe areas, keyboard handling, pointer/trackpad affordances, and accessibility
  integration.

Do not use a macOS-only WebKit feature in the common contract unless there is an
iPadOS equivalent. With Alpha's current iOS 15 floor, use a nonpersistent data
store in the spike rather than raising the floor merely to get named persistent
profiles.

## Why the other options do not meet the requirement

### General-purpose iframe

- **Fact:** CSP `frame-ancestors` lets a resource restrict which origins may
  embed it in `frame`/`iframe`/`object`/`embed`.
  [CSP Level 3](https://www.w3.org/TR/CSP/#directive-frame-ancestors)
- **Fact:** script access across iframe boundaries is subject to the same-origin
  policy; cross-origin cooperation is limited to channels such as `postMessage`.
  [MDN iframe scripting reference](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe#scripting)
- **Fact:** WebKit blocks cross-site cookies by default; authenticated embeds may
  need the Storage Access API and a user-mediated flow.
  [WebKit third-party cookie guidance](https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/)

**Inference:** an iframe remains useful inside a deterministic test fixture, but
it is not a Phase 1 renderer. It cannot satisfy “open arbitrary websites” or a
future promise that the agent can inspect/control the same visible page.

### System and packaged in-app browser plugins

The official Capacitor Browser plugin uses `SFSafariViewController` on iOS and
exposes open/close/load-finished events, not a source-owned pane.
[Capacitor Browser API](https://capacitorjs.com/docs/apis/browser)
Apple itself says to use `WKWebView` when custom controls or interaction with web
content are required.
[SFSafariViewController documentation](https://developer.apple.com/documentation/safariservices/sfsafariviewcontroller)

The official InAppBrowser plugin supports iOS and Android, provides WebView,
system-browser, and external-browser modes, and isolates local storage/cookies
on iOS by default. Its public iOS presentation modes are `PAGE_SHEET`,
`FORM_SHEET`, and `FULL_SCREEN`; the API exposes toolbar/configuration and
navigation events, but no arbitrary pane rectangle, JS evaluation, or snapshot.
[Capacitor InAppBrowser API](https://capacitorjs.com/docs/apis/inappbrowser)

Registry metadata inspected on 2026-08-29:

| Package | Current version | License | Compatibility/constraint |
| --- | --- | --- | --- |
| [`@capacitor/browser`](https://www.npmjs.com/package/@capacitor/browser/v/8.0.4) | 8.0.4 | MIT | `@capacitor/core >=8`; iOS uses `SFSafariViewController` |
| [`@capacitor/inappbrowser`](https://www.npmjs.com/package/@capacitor/inappbrowser/v/4.0.3) | 4.0.3 | MIT | `@capacitor/core >=8`; iOS and Android only |

**Inference:** InAppBrowser can quickly prove that the device can browse a login
flow, but adapting its modal controller into a tracked React pane and later
exposing control would mean forking/replacing the very abstraction it provides.

### Portal-hosted browser stream

Playwright supports a persistent browser context backed by a dedicated user data
directory and warns against automating the user's normal Chrome profile.
[Playwright `launchPersistentContext`](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context)
Chromium CDP exposes `Page.startScreencast`, but the API is experimental and uses
compressed frames plus acknowledgements.
[Chrome DevTools Protocol Page domain](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-startScreencast)

Registry metadata inspected on 2026-08-29 reports Playwright 1.62.1,
Apache-2.0, with Node `>=20`. Portal is a Deno executable with no browser package
today.

**Inference:** a remote browser is feasible and may become necessary for
arbitrary-site parity in browser-hosted Alpha. It is not a Phase 1 shortcut. It
adds browser-process supervision and distribution, profile/credential custody,
frame and input transport, clipboard, download/upload brokering, popup and
permission UX, latency/bandwidth behavior, and reconnection semantics.
Apple's current review rules also require a specific review of a streamed-host
model: web-browsing apps must use WebKit, and Remote Desktop clients have
additional restrictions, including a prohibition on thin clients for
cloud-based apps. This note is not a legal determination.
[App Review Guidelines 2.5.6 and 4.2.7](https://developer.apple.com/app-store/review/guidelines/)

## Apple/WebKit constraints to prove

### Browser ownership and future control ceiling

`WKWebView` is a native view intended for in-app browsing, with navigation and UI
delegates. It also exposes `evaluateJavaScript` and `takeSnapshot`.
[WKWebView documentation](https://developer.apple.com/documentation/webkit/wkwebview)
This establishes technical feasibility for later controlled-page inspection and
screenshots, but it is not Chromium CDP and does not prove parity with T3 Code.

App-Bound Domains are opt-in. An app can list at most ten bound domains; once the
key is added, restricted APIs such as JS injection, message handlers, and cookie
manipulation are denied in ordinary web views. A web view that opts into
`limitsNavigationsToAppBoundDomains` regains those APIs but cannot navigate
outside the list. An app that does not adopt the key retains the older
unrestricted behavior, with the privacy trade-off documented by WebKit.
[WebKit App-Bound Domains](https://webkit.org/blog/10882/app-bound-domains/)

**Spike policy:** do not add `WKAppBoundDomains` in Phase 1. Do not expose script
evaluation through the Phase 1 JS contract. Record App-Bound Domains, privacy,
and any future browser-entitlement requirements as a Phase 2 decision before
control is implemented.

### Cookies and profile lifetime

`WKWebsiteDataStore.default()` persists data to disk; `.nonPersistent()` stores
it in memory. A persistent data store with an application-provided identifier is
intended for profiles but is available only from iOS/iPadOS 17 and macOS 14,
while Alpha currently supports iOS/iPadOS 15.
[WKWebsiteDataStore configuration](https://developer.apple.com/documentation/webkit/wkwebviewconfiguration/websitedatastore)
and
[`init(forIdentifier:)`](https://developer.apple.com/documentation/webkit/wkwebsitedatastore/init(foridentifier:))

**Spike policy:** use one `.nonPersistent()` store for the Phase 1 browser
session on both platforms. This prevents the browser from silently sharing the
shell's persistent site data and makes the evidence unambiguous: login may
survive within the open session but not an app relaunch. A production decision
must later choose among ephemeral browsing, raising both deployment floors for
named persistent profiles, or accepting/shaping default-store sharing.

### TLS and local hosts

ATS requires TLS with acceptable certificates by default. Exceptions weaken
security; `NSAllowsArbitraryLoadsInWebContent` disables ATS for web views and
requires App Store justification.
[Apple ATS guidance](https://developer.apple.com/documentation/security/preventing-insecure-network-connections)
Alpha already has the narrower `NSAllowsLocalNetworking` setting. The spike must
not broaden it and must not bypass certificate failures.

Apple's current local-network technote says traffic originating from
`WKWebView`, `SFSafariViewController`, and Safari does not require local-network
access, although Alpha's native Portal connections do and already have a usage
description. It also says the simulator does not model local-network privacy;
test on a physical device.
[TN3179](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy)

### Popups, files, permissions, and lifecycle

- New-window requests and JavaScript dialogs belong to `WKUIDelegate`; the spike
  must choose same-tab, managed-new-tab, external, or visible denial instead of
  silently losing them.
  [WKUIDelegate](https://developer.apple.com/documentation/webkit/wkuidelegate)
- iOS enables HTML file upload by default; the UI delegate can customize or
  disable the upload panel.
  [Apple upload-panel method](https://developer.apple.com/documentation/webkit/wkuidelegate/webview(_:runopenpanelwith:initiatedbyframe:completionhandler:))
- Downloads need explicit destination, progress, authentication, and error
  behavior.
  [WKDownloadDelegate](https://developer.apple.com/documentation/webkit/wkdownloaddelegate)
- Camera, microphone, geolocation, notifications, and similar permissions need
  an explicit product policy and, where applicable, native usage descriptions.
  Phase 1 should deny them visibly rather than add broad permissions.
- On iPadOS, treat inactive/backgrounded Alpha as suspended. On macOS, handle
  window occlusion, deactivation, close/reopen, and app termination separately.
  Preserve session metadata, remeasure the native view, and refresh navigation
  state after either lifecycle transition; do not claim background automation.

## Recommended contract

The exact names are illustrative, but the seam should be explicit and small:

```ts
type BrowserRendererKind = 'apple-wkwebview' | 'unsupported';

type BrowserCapabilities = {
  renderer: BrowserRendererKind;
  platform: 'ipados' | 'macos' | 'web';
  arbitraryTopLevelNavigation: boolean;
  crossOriginInspection: boolean;
  snapshot: boolean;
  persistentProfile: boolean;
  downloads: 'unsupported' | 'native' | 'brokered';
  uploads: 'unsupported' | 'human-only' | 'brokered';
};

type BrowserSessionState = {
  sessionId: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error?: { code: string; message: string };
};
```

Phase 1 commands should be limited to `create`, `present(rect)`, `navigate`,
`back`, `forward`, `reload`, `hide`, and `close`, plus state events. Allow only
`http:` and `https:` navigation; display the committed origin; do not include
`evaluate`, `click`, `type`, `snapshot`, credentials, or a generic native-call
escape hatch.

Both supported platforms must return `renderer: 'apple-wkwebview'` and the same
command/state semantics. Browser-hosted Alpha returns `renderer: 'unsupported'`
and does not present a fake or reduced browser.

**Inference:** a local session ID rather than a thread ID should own browsing
state. A thread may later reference one or more sessions, but tying native view
lifetime directly to an ACP session would make human browsing depend on agent or
Portal connectivity.

## Exact runnable vertical slice

### 1. Build a deterministic fixture and contract tests

Add an app-owned fixture route/page with links, history state, `target=_blank`, a
file input, a downloadable response, title changes, and a visible query-string
state. Add a second response that denies framing with CSP `frame-ancestors
'none'`. This provides stable evidence without using third-party sites as tests.

Write contract tests for URL scheme rejection, state transitions, capability
reporting, and the browser-hosted unsupported state. Run:

```bash
cd product
bun run test:alpha
bun run build:alpha
```

### 2. Add the shared Alpha browser surface

Add a browser pane/surface with URL field, origin/security indicator,
back/forward/reload/close buttons, load/error states, and a slot element. Measure
the slot with `getBoundingClientRect()` plus `ResizeObserver`; update on window
resize, scroll, pane resize, keyboard/visual viewport change, visibility, and
mount/unmount. Coalesce rectangle events to animation frames. Browser-hosted
Alpha shows a clear platform-unsupported state and does not render an iframe.

### 3. Add one WebKit manager with two Apple hosts

Define the common WebKit manager/session behavior once: create a
`.nonPersistent()` view, navigation commands, state observation, delegate
policy, teardown, and bounded event payloads.

For iPadOS, extend the existing bridge controller with a focused browser plugin
or manager that inserts and clips a child/sibling `WKWebView` below Alpha chrome.

For macOS, first enable and build a Mac Catalyst target. If Alpha and its
required Capacitor plugins work under Catalyst, reuse the same UIKit host with
only lifecycle/input adaptations. If that experiment fails, record the blocker
and add a thin AppKit host that embeds `WKWebView` as an `NSView`; do not fork the
browser contract or session semantics.

Both hosts must:

1. keep the native view aligned to the React slot rectangle;
2. implement navigation/UI delegates for state, errors, popups, upload,
   download, and permission decisions;
3. emit URL/title/loading/back/forward/error state;
4. remove the view and delegates on close; and
5. remeasure/restore visibility after platform lifecycle transitions.

Do not add `WKAppBoundDomains`, a broad ATS exception, browser permissions,
Portal RPC, Playwright, or script-evaluation methods.

### 4. Prove it on macOS and a physical iPad

Run the macOS Alpha target, then build/sync/install the iPadOS app using the
existing Alpha workflow and launch it on a connected physical iPad. Capture a
short recording plus state/event logs for the checklist below. A simulator-only
result is not acceptance for local networking, lifecycle, input, or pane
geometry.

### 5. Make the exit decision

- If Catalyst works, proceed with the shared UIKit/WebKit host on macOS and
  iPadOS.
- If Catalyst is blocked but a thin AppKit host proves the same WebKit contract,
  proceed with the two small native view adapters.
- If neither macOS route can host the same contract without major shell work,
  stop and revisit the Apple-only scope before Phase 2.

## Acceptance and evidence checklist

### Shared contract and chrome

- [ ] One session opens, navigates, goes back/forward, reloads, and closes from
  Alpha browser chrome.
- [ ] URL, title, loading, `canGoBack`, `canGoForward`, and errors remain in sync.
- [ ] The browser pane can be resized without changing unrelated pane ratios or
  covering Alpha chrome.
- [ ] The same command/state contract and Alpha browser chrome run on macOS and
  iPadOS.
- [ ] Browser-hosted Alpha reports the feature as unsupported and does not render
  an iframe substitute.
- [ ] Only `http:`/`https:` are accepted; the committed origin remains visible;
  rejected schemes and certificate failures are not bypassed.

### Physical iPad

- [ ] The same browser chrome drives a native `WKWebView`, not an iframe inside
  the Capacitor shell.
- [ ] A public HTTPS fixture and a reachable local/Tailscale fixture both load;
  actual ATS and local-network results are recorded.
- [ ] The native view remains pixel-aligned through pane resizing, orientation,
  Split View/Stage Manager sizing, keyboard show/hide, scroll, and safe-area
  changes.
- [ ] Background/foreground preserves or explicitly resets the session and
  restores correct geometry; no background execution is claimed.
- [ ] Ephemeral profile behavior is recorded: cookies/login survive normal
  navigation in the open session and do not survive app relaunch.
- [ ] `target=_blank` follows the chosen visible policy.
- [ ] Human file upload is verified on the fixture.
- [ ] A fixture download is either surfaced with a verified destination or shown
  as explicitly unsupported; it is never silently lost.
- [ ] Camera, microphone, geolocation, notifications, and other unimplemented
  permissions are denied with an understandable state; none is silently granted.
- [ ] No `NSAllowsArbitraryLoadsInWebContent`, `WKAppBoundDomains`, or new broad
  privacy usage descriptions are added by the spike.

### macOS

- [ ] The accepted macOS host is recorded as Mac Catalyst or native AppKit, with
  the exact Alpha build, OS, architecture, and Capacitor/plugin compatibility
  results.
- [ ] The browser is a real `WKWebView` and presents the same session state and
  navigation behavior as iPadOS.
- [ ] Pane resizing, window resizing, full screen, hide/show, window close/reopen,
  app deactivate/reactivate, keyboard focus, pointer input, and Retina scaling
  preserve geometry and state.
- [ ] Popup, upload, download, certificate failure, permission denial, and
  ephemeral-profile behavior are recorded and compared with iPadOS.
- [ ] Any AppKit/Catalyst-specific behavior stays behind the native adapter and
  does not leak into the common TypeScript browser contract.

### Scope and evidence

- [ ] Alpha tests and build pass, and the exact iPad build/device/OS are recorded.
- [ ] Screenshot/video evidence on both Apple platforms covers load, navigation,
  resize, popup, upload, download, lifecycle transitions, and an error state.
- [ ] Logs redact URLs beyond origin where they may contain tokens or sensitive
  query data; no cookies, credentials, page text, or form values are logged.
- [ ] Portal code, product browser RPC, MCP server, browser tools, and agent
  control remain unchanged in Phase 1.
- [ ] The result is reported as a runnable spike, not production-ready browsing
  or proof of Phase 2 control.

## Risks and open decisions after the slice

| Risk/decision | What the slice establishes | Follow-up owner |
| --- | --- | --- |
| Mac shell | Whether Mac Catalyst is viable or a thin AppKit shell is required | Alpha/platform |
| Persistent browser profile | Ephemeral behavior and login UX on iPadOS 15+ and macOS | Product/security; decide OS floors and data-retention controls |
| App-Bound Domains/control privacy | Phase 1 avoids injection and preserves arbitrary navigation | Phase 2 architecture/privacy review |
| Downloads/uploads | Human behavior on both Apple platforms and missing broker cases | Product/platform |
| Permissions | Explicitly denied baseline | Product/privacy before adding each native permission |
| Portal streaming | Feasibility constraints only | Separate spike, including App Review assessment |
| Agent/human handoff | Not implemented | Phase 2 must define controller, consent, interruption, and sensitive-action policy |

## Final recommendation

Proceed with an Apple-only `WKWebView` vertical slice behind one Alpha browser
contract. Prove Mac Catalyst first because it offers the most literal reuse of
the existing iPadOS/UIKit shell; fall back to a thin AppKit view host if Catalyst
compatibility is the blocker. Treat T3 Code's DOM-slot and host-owned-browser
split as the architectural reference. Treat ChatGPT desktop Browser as a
reference for profile isolation and explicit control permissions, not as
evidence of an implementation that can be copied.

Do not use an iframe or modal browser plugin as the pane substrate, do not add an
Electron/Chromium host, and do not move Phase 1 into Portal. Browser-hosted Alpha
is outside the embedded-browser support matrix. The product is still
cross-platform at the WebKit session-contract level, with deliberately small
UIKit/Catalyst and AppKit host differences where Apple frameworks require them.
