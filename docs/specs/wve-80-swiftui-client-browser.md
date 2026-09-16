# WVE-80: SwiftUI Client Browser

Planning draft, 16 September 2026. [Linear issue](https://linear.app/jacobfvanzyl/issue/WVE-80/plan-and-build-the-swiftui-client-browser-for-apple-clients), currently In Progress. The opt-in native prototype and initial Workspace integration are implemented; full product acceptance is still open.

The user approved the delivery sequence on 16 September 2026. Begin with native hosting and browser capability validation; the remaining detailed proposals do not block that milestone.

## Agreed direction

- Apple devices only, using the existing Electron macOS and Capacitor iOS/iPadOS shells.
- The new browser requires macOS 26 and iOS/iPadOS 26. Supporting older operating systems with another browser implementation is outside this plan.
- Host a shared SwiftUI browser module through AppKit and UIKit. The user approved a directly owned WKWebView inside SwiftUI on 16 September after the pure SwiftUI API failed the popup/download gate.
- One webpage per Workspace pane. Opening a new Client Browser pane requires an existing Workspace and an accepted Host composition change. No standalone browser window, local-only Workspace or external-link launch path is included. There is no nested tab strip.
- Share pane placement and its initial address. Once opened, each device navigates independently and retains its own current address, history, cookies and live page state.
- Closing a shared Client Browser pane closes its page on every connected device. Retain each device's last address and profile association for reopening; do not promise recovery of unsent forms. Disconnected devices apply the closure when they reconcile with the Host.
- Support multiple named persistent local profiles from the first version. Profiles, sign-ins and website data are independent on each device.
- Modern websites and web apps, navigation, persistent logins, uploads/downloads and site permissions are the target. The initial real-site acceptance set is Linear (primary), Cloudflare Dashboard and GitHub.
- Compatibility limit: default-browser eligibility and its external URL launch requirements are deferred under the agreed Workspace-only scope. Do not expand the product to obtain browser entitlements. The HTTPS prototype currently lacks iPad service workers and reports platform passkeys unavailable on both builds. Full parity is not established by WKWebView or the OS-26 floor alone. See the feasibility report for runtime evidence and Apple sources.
- This is a separate Client Browser. Its WebKit execution and website storage are local to each Apple client. The current Host Browser remains a different runtime and pane type.

## Remaining decisions and resolved details

1. **First open and restoration:** a device with no local record loads the shared initial address. A returning device restores its own last committed address and profile. Later navigation never rewrites the shared initial address. These rules implement the agreed independent-navigation model; details of explicit reset remain open.
2. **Profile defaults:** multiple named persistent profiles are agreed. Proposed first-run behavior creates a named Default profile; new panes use the device's selected default unless explicitly changed. Private browsing is outside the initial agreed scope. The exact default/profile-switch UI is a proposal.
3. **Recovery UI and downloads:** shared closure is agreed to close pages everywhere while retaining each device's address/profile association. A local recently-closed entry can implement reopening. Define whether active downloads continue independently and how the existing shared Close Transaction presents active work. Live forms are not recoverable.
4. **Product naming (resolved):** use **Host Browser** for the existing Host runtime and **Client Browser** for native local browsing. Their persisted pane kinds are `host-browser` and `client-browser`.
5. **Website compatibility:** the WKWebView adapter is agreed and passes the fixture popup/download cases. Actual login providers, passkeys, permissions, offline service workers and accessibility still require acceptance.
6. **OS enforcement:** require OS 26 for this feature. Whether the entire app adopts that minimum or older installations retain an explicit unsupported state needs packaging confirmation.

## Current code constraints

The current [`PaneLayoutNode`](../../product/protocol/src/composition.ts) uses composition schema 4 with terminal, agent, Host Browser and Client Browser leaves. The Host Browser leaf stores a Host profile identity and last committed URL; the Client Browser leaf stores only its shared initial URL. Schema 2/3 migration renames legacy `browser` leaves to `host-browser` without changing their identities. [`browser-panes.ts`](../../product/protocol/src/browser-panes.ts) creates and closes a real Host page. These existing records cannot be reinterpreted as local WebKit pages.

[ADR 0006](../adr/0006-unify-workspace-pane-types.md) gives all panes a shared Host-owned layout and Close Transaction semantics. The new browser can participate in this layout without placing its cookies, webpage objects or native browser operations in Portal. If its placement is shared, some additive Host/protocol work is required even though browsing is local.

The native precedent is already present: [`electron/native-browser.ts`](../../product/alpha/electron/native-browser.ts), the [iOS browser plugin](../../product/alpha/ios/App/App/NativeBrowserPlugin.swift), and the [pane focus owner](../../product/alpha/src/app/pane-focus.tsx). Their current browser implementation is a remote display client. Reuse lifecycle/geometry concepts, not the remote stream/input implementation.

On iPad, [`WeaveSurfaceContainer`](../../product/alpha/ios/App/App/SceneDelegate.swift) routes native terminal input underneath the transparent React shell. Mac has a similar container in [`electron-terminal.mm`](../../product/alpha/native/ghostty/electron-terminal.mm). Introduce browser participation deliberately so browser gestures, text editing and VoiceOver reach the native content and shell overlays retain priority.

## Proposed module ownership

| Module | Owns | Does not own |
| --- | --- | --- |
| Shared Swift browser module | Live page identity; navigation UI/model; local profiles and restoration; permissions; download presentation; page errors and native lifecycle | Workspace composition authority or Host Browser state |
| AppKit host adapter | NSHostingView/controller; native parent attachment; geometry/focus; Objective-C-compatible facade for the Electron addon | A second browser model |
| UIKit host adapter | UIHostingController containment; native parent attachment; safe area/keyboard geometry; Capacitor adapter | A second browser model |
| Alpha React adapter | Pane creation and placement; top rail; shared focus/overlay policy; forwarding app commands; displaying compact pane metadata | Cookies, website DOM or independent navigation-history state |
| Host composition integration | New pane identity/type; layout and cross-client create/move/close metadata chosen by the product model | WebKit execution, website storage or client-browser automation |

Proposed source placement is `product/alpha/native/client-browser/`, with one Swift package or shared source target and small platform host files. Final package layout follows the build proof. Keep this separate from `native/browser/`, which is the existing Host Browser display implementation.

## Native interface sketch

This is an illustrative interface, not a committed wire contract:

- `attach(paneId, initialAddress, presentation)` returns a surface handle and a current metadata snapshot. Reattachment finds the existing local page; it does not reload by default.
- `present(surfaceId, rectangle, visible, inputBlocked, focusIntent, appearance)` updates native hosting. Pane selection and text-entry focus are separate intents.
- `command(paneId, action)` handles a bounded set of application commands such as focus-address, back, forward, reload, stop and find.
- `detach(surfaceId)` removes presentation while retaining the page according to lifecycle policy.
- `close(paneId, disposition)` performs deliberate local closure/recovery after the shared close operation resolves.
- Events publish title/loading/error/focus changes and requests for shell actions, such as creating an adjacent pane. Browser navigation and profile data remain inside the Swift module except metadata explicitly chosen for shared state.

Retain the page outside SwiftUI view-body recomputation. A page has one live presentation at a time on a client; moving or resizing its pane must not create another page. Hide, detach, close and renderer reload have different semantics. Native callbacks carry pane/surface identity so delayed events cannot update a replaced pane.

Native webpage input goes directly to WebKit. Do not expose a JavaScript-evaluation escape hatch or translate human keystrokes into Host Browser commands. A narrow native interface reduces the number of state transitions React must coordinate.

## Browser UI and behavior proposal

The existing React top rail keeps Workspace split/move/close and focus controls. A SwiftUI navigation row inside the pane owns the address field, committed-origin/security state, back/forward, reload/stop and an overflow menu. Find, downloads, site permissions and profile selection use native presentation. Narrow panes adapt controls rather than introducing a second tab model.

Keyboard command routing must preserve native web editing and the focused pane. Cover address focus, find, reload, back/forward and close consistently on Mac and attached iPad keyboards. Merely selecting a pane on iPad/iPhone must not summon the software keyboard.

A human-requested new page creates an adjacent pane through the shell. Website-created windows require more than extracting a URL: preserve request semantics, opener relationships, shared profile and script-driven close where supported. Test target=_blank, window.open followed by location changes, POST-to-new-window and OAuth callback communication. Define how a locally created popup maps to a shared pane without asking another device to replay the popup transaction.

## Persistence and lifecycle proposal

WebKit owns cookies and website storage in a dedicated local WKWebsiteDataStore. Store the browser's pane/profile catalog separately from app credentials and the Host Browser. Do not share the Capacitor shell's default store just to obtain persistence.

Each named profile has an app-owned UUID and a corresponding persistent WebKit data-store identifier. Names are editable labels, not storage keys. Two profiles with the same display name on different devices are not the same identity and do not synchronize credentials. The initial profile UI includes create, rename, select and delete/clear with explicit consequences for open pages using the affected store. Persist the local profile selection with the pane checkpoint; no local profile UUID belongs in shared composition.

A device opening a shared pane for the first time uses its local default profile. Profile changes after loading must explicitly recreate the page in the selected store and warn about losing current page state; cookies must not be copied between profiles. Popups inherit the opener's local profile. A shared pane movement preserves its local page/profile association on each device.

Persist enough metadata to recover a pane's profile and last committed address after app termination. Do not promise restoration of JavaScript heap, unsent forms, full back/forward history or a live call. Normal hide/show and pane moves should preserve the actual live page. Process loss should show an explicit reload/recovery state.

Keep profiles independent from pane/Workspace lifetime. Closing a pane must not erase a shared profile; clearing website data is a separate action. Downloads need an owner independent of the currently displayed page, with explicit cancellation semantics on close and interruption semantics on app suspension.

Shared closure saves a local recently-closed record before releasing the page. This stores last committed address, local profile identity and enough source identity for recovery. The proposed reopen operation creates a new shared pane, with explicit restoration lineage if other devices should recover their corresponding local checkpoints; it must not silently resurrect a deleted pane record. Missing or deleted local profiles require a visible profile choice. Ordinary navigation after reopening remains local. Final recovery lineage and retention limits are implementation-design questions, not a promise of full session restoration.

Host disconnection should not terminate local browsing already attached to a recoverable Workspace view. Shared layout mutations while disconnected require a separate queue/conflict design if supported; the initial implementation should not pretend they succeeded remotely. Another client's removal of a shared pane must reconcile with local recovery policy rather than silently deleting browser data.

The agreed shared-close model means an offline device can keep a page alive until it learns of the removal. On reconnection, save its recovery metadata and close the page before presenting the reconciled Workspace. Do not resurrect the shared pane from an older local snapshot.

## API coverage gate

Source inspection on 16 September used the installed MacOSX26.5 SDK's public WebKit and _WebKit_SwiftUI swiftinterfaces. They expose WebPage, navigation decisions/authentication challenges, file-input dialog presentation, website data stores, media authorization and capture state. This is source evidence only.

The inspected WebPage surface does not expose obvious equivalents of WKUIDelegate's new-view creation callback or WKNavigationDelegate's download transition/delegate attachment. A navigation decision returning `.download` and a page's Transferable export support do not by themselves prove a usable download manager. Validate built-in behavior and public integration hooks before assuming parity.

The first prototype must resolve:

- popup creation/opener/callback/close behavior;
- authenticated, blob and attachment downloads, progress, destination and cancellation;
- normal password and passkey login, plus the actual OAuth providers used by daily sites;
- service-worker registration, update and offline reload on unrelated origins in the signed app;
- microphone/camera requests and native file input.

If WebView/WebPage cannot meet a required case with public APIs, present the evidence and compare a WKWebView representable inside the same SwiftUI module with explicit scope reduction. Do not silently switch adapters or adopt private WebKit introspection. SwiftUI hosting itself remains the accepted architectural direction.

## Agreed delivery sequence and exit evidence

| Milestone | Deliverable | Evidence required to proceed |
| --- | --- | --- |
| 1. Native/API feasibility | Shared Swift module hosted in both shells; deterministic web fixtures | Two independent visible panes; native selection/input/accessibility; stable page across resize/hide; popup/download/login gate outcomes |
| 2. Pane integration | New pane type, creation/move/close, React/native focus interface | Existing pane identities preserved; correct cross-client state; unsupported client handling; terminal and Host Browser regression checks |
| 3. Daily browsing | Native controls, local profiles, restart recovery, uploads/downloads, permissions | Signed Mac and physical iPad evidence for required sites and failure paths |
| 4. Lifecycle and release acceptance | Recovery, background/foreground, keyboard/safe areas, packaging and migration | Cross-device close/offline scenarios; app/renderer reload; old state read-back; measured resource behavior and documented compatibility limits |

The first milestone should be a real page in the real shells, not a polished standalone SwiftUI browser. It needs a small fixture server and disposable browser data. Do not use existing signed-in profiles for destructive persistence/closure tests.

Focused checks should cover browser lifecycle/state transitions, native-interface identity validation, composition compatibility/migration and close consequences. Native acceptance is essential for input, overlays, permissions, popup behavior and downloads. Run the root checks once implementation reaches the relevant milestone; document API-only evidence separately from compiled and installed behavior.

## Compatibility and rollout

If a shared new leaf is adopted, extend the composition schema and product capability/version handling rather than overloading `kind: browser`. Preserve existing pane, node, profile, terminal and thread identities. Older clients must not rewrite compositions containing a pane they do not understand. New clients need explicit handling for Hosts that do not support the new pane type.

An OS 26 requirement must be reflected in native build targets and packaged feature availability, not only a JavaScript check. If keeping the rest of Alpha runnable on older OS versions, prevent loading OS-26-only symbols before the availability check. This packaging choice remains open.

No Host browser service replacement, agent grants/control changes, credential migration, browser account sync, extension store or DRM parity work is included. Follow-up compatibility features should be driven by required sites and observed failures.

## Sources

- [Apple: WebKit for SwiftUI](https://developer.apple.com/videos/play/wwdc2025/231/).
- [Apple: cross-platform browser sample](https://developer.apple.com/documentation/webkit/building-a-cross-platform-web-browser).
- [Apple: WKUIDelegate](https://developer.apple.com/documentation/webkit/wkuidelegate).
- [Apple: WKNavigationDelegate](https://developer.apple.com/documentation/webkit/wknavigationdelegate).
- [Apple: SwiftUI integration](https://developer.apple.com/videos/play/wwdc2019/231/).
- [Original options research](../research/native-client-browser-embedding.md), including authentication and service-worker caveats.

## First prototype evidence

See [native feasibility results](../research/wve-80-native-browser-feasibility.md). Two native pages run in both shells; the pure SwiftUI renderer failed the popup/download gate on Mac. The user approved a directly owned WKWebView inside SwiftUI; that adapter is implemented and passes popup/opener/POST and download completion/cancellation fixtures on Mac and physical iPad. The complete milestone, including accessibility and real login acceptance, is not marked complete.

## Workspace integration implementation

The new `client-browser.pane.create`, `.move` and `.close` operations mutate shared placement under the Host lifecycle queue. Creation and movement require an existing Workspace; no Host browser backend is used. Local URLs, profile IDs and cookies are rejected at the shared Client Browser boundary. Composition replacement cannot add, remove, change the initial address of, or move a Client Browser Pane between Workspaces outside its lifecycle operation. Protocol 9 fences older clients. Client Browser composition access is limited to fully trusted Alpha pairings, following the existing fully trusted Host Browser profile policy; restricted external credentials do not gain access to Client Browser panes.

Native surfaces are keyed by Host and Pane identity, independent of Workspace and React component lifetime. Detaching hides presentation; reattaching finds the same page. Renderer reload hides native presentation and recovers by the same key. A dedicated reconciliation RPC confirms actual shared removal instead of inferring it from a filtered composition. Disconnection alone never closes a local page. Shared close checkpoints its local committed address and website-store identity before releasing WebKit; active page downloads are cancelled. Recently-closed UI and restoration lineage remain in the recovery milestone.

A popup is adopted locally before its shared Pane is published, preserving WebKit's exact supplied view and opener relationship. Its shared initial address is `about:blank`: other devices must not replay a POST, authorization callback or popup transaction. If placement fails, authoritative membership reconciliation releases the unplaced page. A lost RPC reply must not destroy a popup whose Pane was actually committed. Ordinary independent navigation never updates the shared initial URL.

The Workspace integration remains behind `VITE_CLIENT_BROWSER_PROTOTYPE=1` (and the corresponding native compile flag). Supported Apple builds expose New Client Browser inside a Workspace and a Client Browser split choice. Other builds retain an explicit unavailable presentation. The integration build has a dedicated persistent local default profile; multiple named profile management remains required before the first complete product version.


The initial Workspace lifecycle passed on the staged Mac shell and an installed physical iPad build using a disposable TLS Host with real terminals. Both retained native page identity through selection, movement and a cancelled close, then removed the native page after confirmed shared closure. Root checks pass. See the [acceptance report](../research/wve-80-native-browser-feasibility.md#earlier-workspace-integration-acceptance) for evidence and the remaining native input, accessibility, popup and cross-device recovery gates; this does not mark the full milestone or first version complete.


Workspace POST-popup and shell-reload fixtures now pass through native page input on Mac and physical iPad. The callback preserves the original request body, opener and local cookie; script closure removes the popup Pane. Reload retains native page identity, document identity and an unsent field. The iPad popup still lacks an accessibility hit point, so its functional touch pass is not accessibility acceptance. Real-provider Workspace OAuth, process crash/app restart and simultaneous two-device offline reconciliation remain open. See the latest acceptance report for exact evidence.
