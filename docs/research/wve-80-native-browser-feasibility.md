# WVE-80 native browser feasibility

Date: 16 September 2026. Status: WKWebView inside SwiftUI approved and implemented. The popup/download capability gate passes; the complete Client Browser and full milestone acceptance remain unfinished.

## Standard-build promotion — 5 October

Client Browser is now included in ordinary Apple builds, with availability determined by the native bridge and OS support. The React feature flag and native prototype compile conditions have been removed. The Electron bridge, Capacitor plugin and shared Swift facade use production Client Browser names. Existing profile identifiers and pane checkpoint keys are unchanged. The isolated feasibility screen and webpage fixture reporting remain acceptance/debug-only.

Normal Mac downloads now use a persistent folder under Downloads and expose Show in Finder after completion. iPad downloads remain in the app's Documents folder and expose native sharing. Named profiles, recently closed pages, real-site compatibility, full accessibility and crash/offline recovery remain unfinished; this promotion does not complete WVE-80.

Validation used Bun 1.3.14 and the frozen lockfile:

- Root tooling, boundary and all 46 protocol tests passed.
- All 321 Alpha tests passed with two workers. The initial default-parallel root check timed out in existing UI tests during concurrent builds.
- All 151 Host tests passed with a 15-second per-test bound; the initial five-second bound timed out in one existing profile-scope test. Host and desktop type checks and the normal renderer build passed.
- The normal Mac native build and desktop packaging passed without a Client Browser feature flag. The bundle includes `weave-client-browser.node` and the camera/microphone usage descriptions.
- Real-shell Mac Workspace acceptance passed creation, selection, movement, cancelled-close overlay retention and confirmed closure, retaining native page identity `2DF696C2-3FE3-4662-BC8C-9234837675B5`. This used the normal native browser addon, an isolated acceptance renderer/profile and a disposable Host with real terminals and no Host Browser backend. Shell controls were driven in-process; this is not a new native webpage input/accessibility or popup/download acceptance run. Evidence: `/tmp/weave-wve80-promotion-runtime/run-final/result.json`.
- The normal iPad build was blocked by missing Xcode account/provisioning profiles. An unsigned generic iOS build passed with no Client Browser compile flag. The physical iPad was unavailable, so installation and physical acceptance were not repeated.

The disposable Host and terminals were shut down and generated pairing inputs removed. The installed live Host remains healthy on protocol 8; using the newly built Alpha against it requires a matching protocol-9 Host upgrade. Its state and installed runtime were not changed during this validation.

## Workspace popup and shell-reload acceptance — 16 September

The Workspace path now passes a native-input sequence on Mac and physical iPad: navigate through the SwiftUI address field, type an unsent field, submit a POST into a new window, receive its opener callback with the original body and profile cookie, close the popup from its webpage, reload the React shell, and verify that both the native page and original document/form state remain alive. Confirmed shared closure then removes the native page. This is deterministic fixture evidence, not a new real-provider OAuth sign-in.

The first Mac reload failed because the shell navigation guard cancelled its own document reload after native surfaces had hidden. The guard now permits only an exact reload of the current trusted shell URL; other top-level navigations retain the existing external-URL policy. A subsequent run passed. Adopted popup address fields also remained at about:blank when navigation completed before the SwiftUI observer attached. Committed-address updates now belong to the native model, preserve active address editing, and observe the current committed history item for same-document navigation. The final Mac UI showed the actual popup URL.

The final physical iPad XCTest completed in 25.222 seconds with all functional steps passing. Its known popup accessibility hit-point assertion remains an expected failure; the close action uses a real coordinate tap. The earlier run using the accessibility element tap failed, so this must not be described as full accessibility acceptance.

Evidence:

- Final Mac: `/tmp/weave-wve80-recovery-host/mac-run/result.json`, native page `09AD7EBA-E250-4D0C-B864-C4622E70E676` and unchanged document identity `95d6cd62-b89c-4ff5-9844-29b47c457d61`.
- Final physical iPad: `/tmp/weave-wve80-recovery-ipad-final.xcresult` and `/tmp/weave-wve80-recovery-ipad-final.json`, native page `CF9DED66-8997-457B-983D-444CD200E5AA` and unchanged document identity `51e5eae9-5560-47c4-9663-b4464846d4b7`.
- Accessibility failure: `/tmp/weave-wve80-recovery-ipad-attached.xcresult`; final suite retains one expected assertion failure.
- `bun run check`: `/tmp/weave-wve80-recovery-check.log` passed (46 protocol, 316 Alpha, 151 Portal tests; root tooling and desktop type checks). Later address-model changes compiled in both native builds and ran in the final Mac/iPad sequence.
- iPad cleanup read-back: `/tmp/weave-wve80-recovery-ipad-cleanup.json` reports `removed: true` for the disposable acceptance Host.

To reproduce, start `client-browser-fixture.ts` with TLS and an evidence directory, then start `client-browser-workspace-fixture.ts` with `WEAVE_CLIENT_BROWSER_RECOVERY_URL` set to that fixture's exact URL. Its private per-device inputs select the recovery sequence. Build both shells with `VITE_CLIENT_BROWSER_PROTOTYPE=1 VITE_ALPHA_ACCEPTANCE=1`. Use the Mac `--host-acceptance` launch with its private input file; enter the fixture URL, type `WVE-80 retained form`, submit POST popup, close it and click Check retained state after shell reload. On iPad, run `AlphaUITests.testClientBrowserWorkspacePopupAndShellReload` with `WEAVE_CLIENT_BROWSER_FIXTURE` set to the same URL and attach mode configured as described below. The recovery bookmark excludes the pairing token and lives only in the acceptance shell's session storage.

The feature remains opt-in. Multiple named profiles and recently closed pages are unfinished. Real-provider OAuth in a Workspace, process crash/app restart, simultaneous two-device offline closure, full accessibility and the recorded service-worker/passkey limits remain open. A shell reload preserving an existing process is not crash recovery.

## Earlier Workspace integration acceptance

The opt-in Client Browser now opens inside an existing Workspace in both shells. Product names are **Host Browser** and **Client Browser** throughout the active spec, pane types and UI. Composition schema 4 migrates legacy `browser` leaves to `host-browser` without changing identities; new `client-browser` leaves share only identity, placement and initial URL. Protocol 9 requires matching Host and client builds.

Host-authorized create, move, close and reconciliation preserve a native page keyed by Host and Pane identity. Ordinary Workspace selection, React unmounting and movement hide or reattach the existing WebKit page. Local committed addresses and the persistent default profile association are checkpointed on-device. Popup adoption preserves the supplied WebKit page; other devices receive an initial blank page instead of replaying the popup transaction. These paths have focused contract/lifecycle tests; Workspace OAuth and cross-device offline recovery still need native acceptance.

The latest real-shell acceptance passed on macOS 26.6.2 and a physical iPad running iPadOS 27.0, using a disposable TLS Portal with real terminals and no Host Browser backend. Both runs created a Workspace and Client Browser through shell controls, switched away and back, moved the pane, cancelled a close under an overlay, and confirmed closure. Native WebKit identity remained unchanged until confirmed close. The shell controls were driven in-process and the native adapters supplied page identity; this is not a full native content-input or VoiceOver pass. Physical minimum-OS-26 acceptance remains open.

- Mac result: `/tmp/weave-wve80-workspace-final/mac-run/result.json`, page identity `3C7EB477-76D5-4496-A7F3-99CADA8E6BBD`.
- Physical iPad result: `/tmp/weave-wve80-client-ipad-final.json`, page identity `8C848CBD-F96A-4CB1-A08D-51756138EA6C`; installed build log `/tmp/weave-wve80-client-ipad-installed-build.log`.
- Repository validation: `/tmp/weave-wve80-current-check.log`; 46 protocol tests, 316 Alpha tests and 151 Portal tests passed, along with root tooling and desktop type checks.

Concurrent Mac polling and iPad pairing exposed a security-state persistence race: a reader could replace the in-memory state while a mutation awaited audit I/O, causing the redeemed credential to be omitted from disk. Persistence now writes the captured mutation state. A regression with concurrent readers and eight pairings failed before the fix and passed after reopening the stored credentials. Evidence: `/tmp/weave-wve80-security-race-before.log` and `/tmp/weave-wve80-security-race-after.log`.

The integration remains behind `VITE_CLIENT_BROWSER_PROTOTYPE=1` and the matching native compile flag. Named profile management, recently closed pages, full native focus/accessibility, Workspace popup login, renderer/process recovery and two-device offline closure remain open. No production Host deployment or release has occurred. The final iPad acceptance-only cleanup retry removed the exact disposable Host URLs (`/tmp/weave-wve80-client-ipad-cleanup.json`); the fixture servers were stopped and the installed app was relaunched normally. The cleanup harness now supports retry without repeating lifecycle actions and records errors on failure. The earlier temporary Mac sign-in is historical evidence: that process is no longer present at final read-back, so its in-memory session is not claimed to survive.

## Earlier signed-in Linear and physical acceptance

Continuation on 16 September 2026. The user signed in to Linear through Google in the Mac prototype. The authentication method is user-confirmed; the resulting authenticated session was independently exercised through the native UI. Weave team issues load, WVE-80 opens with its description and editable controls, and a native search for WVE-80 returns the matching issue. Reload keeps the session authenticated. Opening/closing the React shell overlay preserves the search state and native page identity CEC9C0EE. Navigating the right pane independently leaves Linear intact. No issue edits or comments were submitted through the webpage. Persistence across app restart is not claimed: this prototype deliberately uses temporary website stores, and the signed-in Mac process was left running.

The Mac native file picker selected a generated 26-byte file and the HTTPS fixture received an exact checksum match: SHA-256 `26a97898b0f8525293e817e4b00f8ac95578ac6625e48a87daf3f08768266a0b`. The origin-labelled native text prompt returned the complete string `native prompt check`. These close the Mac picker-to-upload and full text-prompt checks; iPad equivalents and permission denial/persistence remain open.

The full physical iPad XCTest now finishes in 41.9 seconds after explicitly waiting for the software keyboard to disappear before tapping the resized shell. Native typing/overlay retention, all four popup cases, attachment/authenticated/blob downloads and live cancellation execute to completion. All three files were copied from this run and byte-verified (26, 26 and 20 bytes). Four expected assertions still report that popup close lacks an accessibility hit point; the functional test uses real touch coordinates. This is a functional pass with known accessibility defects. The earlier floating obstruction did not recur in this run; its precise cause remains unverified.

Current evidence: `/tmp/weave-wve80-session-ipad.xcresult`, `/tmp/weave-wve80-session-ipad.json`, `/tmp/weave-wve80-session-downloads/`, `/tmp/weave-wve80-session-build.log`, `/tmp/weave-wve80-https/fixture.json`. Build-for-testing and diff checks pass. The only executable-source change in this continuation is test synchronization and a screenshot before overlay activation; earlier root checks were not rerun for that test-only change.

A later return to the Mac fixture observed an existing service worker whose cached fixture response was missing; its handler reported a null-response error. This does not revoke the earlier successful registration/cache fetch, but offline/cache-eviction recovery remains unverified. Do not equate service-worker API support with durable offline acceptance.

### Workspace-only scope decision

On 16 September the user confirmed that a Client Browser pane can only open inside an existing Workspace. No standalone window, local-only Workspace or external-link launch path is required. Continue with shared Workspace integration; opening a new pane requires a successful Host composition mutation. Existing local pages may continue browsing while disconnected, but new shared panes must not appear as if the Host accepted them.

This supersedes the earlier recommendation to implement no-Host launch behavior for browser entitlement eligibility. Default-browser registration and the associated capability application are deferred. The observed iPad service-worker absence and unavailable passkey probes remain compatibility limits; Workspace integration does not resolve them. No entitlement, Developer Portal or selected-default-browser change was made. Apple references remain in the capability section below.

## Earlier accessibility, HTTPS and real-site pass

Follow-up on 16 September 2026. User-selected compatibility targets are Linear (primary), Cloudflare Dashboard and GitHub.

| Case | Mac | Physical iPad |
| --- | --- | --- |
| Native accessibility tree | Shell, SwiftUI toolbar and webpage descendants now exposed | Page/control descendants exposed; popup hit point still fails |
| Address focus and page input | Native typing, link Tab focus and Cmd+L observed; complete command/activation/overlay focus acceptance remains open | Earlier native typing/overlay retention passed; hardware keyboard and VoiceOver remain open |
| Trusted HTTPS context | Passed with valid certificate | Passed with the same certificate |
| Service worker and cached fetch | Registration plus cached-response fetch passed | navigator.serviceWorker absent in the current signed app |
| Platform passkey availability | Platform and conditional availability report false | Same result |
| Linear login page | Renders with accessible Google/email/SSO/passkey controls | Not yet exercised |
| Cloudflare login page | Renders with accessible native page controls | Not yet exercised |
| Cloudflare to GitHub authentication redirect | Reached GitHub sign-in for Cloudflare | Not yet exercised |
| Authenticated Linear use | Google sign-in user-confirmed; issue list/detail, search, reload and overlay retention passed | Pending |

The macOS host now owns an ordinary AppKit root containing Chromium and the SwiftUI hosts as siblings. Chromium previously exposed only its own accessibility subtree. The fix uses public AppKit APIs and no private swizzling. It is prototype-only; full VoiceOver and production terminal/overlay composition acceptance remain open. An extra UIKit wrapper did not resolve the iPad popup accessibility defect and was removed. The functional test records the known accessibility assertion as an expected failure and uses the visible frame for real touch; this does not constitute accessibility acceptance.

Native origin-labelled JavaScript dialogs, file-picker delegation and media-permission decisions are implemented. A confirm callback and a text-prompt callback were observed on Mac; the prompt interaction was interrupted, so exact full-text acceptance remains open. The media fixture reported a granted stream, automatically stopped after three seconds; denial, persistence and iPad permission behavior remain unverified. File upload now has a synthetic metadata/checksum endpoint, but picker-to-upload acceptance has not been completed.

### Browser capability and signing gate

Apple documents service-worker support for iOS apps approved for the managed default-browser entitlement. App-bound domains are another restricted mechanism; their bounded domain model does not satisfy this general browser. The installed iPad app has ordinary development signing entitlements and no browser capability. Do not add an unsupported entitlement or claim that an OS-26 floor alone grants full browser capability. [Apple browser preparation](https://developer.apple.com/documentation/xcode/preparing-your-app-to-be-the-default-browser), [WebKit app-bound domains](https://webkit.org/blog/10882/app-bound-domains/).

Ordinary WKWebView passkeys require associated domains, which cannot provide arbitrary third-party website support without the website owner's association. Apple documents a managed macOS browser entitlement for arbitrary relying-party passkeys/security keys, requested by an organization account holder. Investigate the appropriate Apple-approved browser capability and user credential-access flow on each platform before accepting passkey parity. False availability probes on this fixture are not themselves a failed real-site ceremony. [Apple passkey support](https://developer.apple.com/documentation/authenticationservices/supporting-passkeys), [Browser credential entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.web-browser.public-key-credential), [Passkey use in browsers](https://developer.apple.com/documentation/authenticationservices/passkey-use-in-web-browsers).

No browser entitlement was added, no Developer Portal application was submitted, and no existing Safari/Chrome profile was imported. Account sign-in, MFA and passkey ceremonies remain user-attended acceptance.

The HTTPS fixture supports WEAVE_CLIENT_BROWSER_TLS_CERT, WEAVE_CLIENT_BROWSER_TLS_KEY and WEAVE_CLIENT_BROWSER_BIND. This run bound the server to the Mac's Tailscale address using a valid certificate; no certificate-validation bypass or existing Tailscale Serve change was needed. Keep private keys outside the repository. Disk exhaustion interrupted later fixture responses: evidence writes now fail independently of endpoint responses and /health reports evidenceWriteError. A healthy evidence store is required before treating the resulting logs as complete.

Latest build validation: native Mac module and locally packaged Electron app build, signed iPad build-for-testing, root bun run check and desktop typechecks pass. The current prototype is installed on the connected iPad. This is not a notarized/distribution release or minimum-iPadOS-26 acceptance.

Evidence: /tmp/weave-wve80-ax/human-browser.json, /tmp/weave-wve80-https/fixture.json, /tmp/weave-wve80-ax-ipad.xcresult (explicit popup AX failure), /tmp/weave-wve80-ax-check.log. Two subsequent physical test runs failed at overlay/popup assertions during the disk-space incident; they do not supersede the earlier successful functional test. After disk recovery, /tmp/weave-wve80-https-complete.xcresult still fails when opening the shell overlay. Its recorded screen shows an additional dark floating surface over the top-right shell controls; the source of that obstruction is unverified. Thus the current full physical suite is not green, even with a healthy HTTPS fixture. A preceding expected-failure run terminated at the first known AX assertion and is not evidence that the remaining functional steps ran; the test now explicitly continues across only that expected assertion.

## Earlier popup/download result

The user approved a directly owned WKWebView inside the shared SwiftUI host. The prototype uses public WKNavigationDelegate, WKUIDelegate and WKDownloadDelegate APIs. SwiftUI continues to own native controls and presentation. A popup returns the exact WKWebView created with WebKit's supplied configuration, then the shell adopts that page into a separate prototype pane. Requests are never replayed from extracted URLs.

| Case | Mac | Physical iPad |
| --- | --- | --- |
| Popup creation, opener callback and cookie inheritance | Passed | Passed |
| POST popup with explicit opener and original body | Passed; `proof=wve80-post-body` received | Passed; same body received |
| Blank popup followed by delayed navigation | Passed | Passed |
| Script-driven popup close | Passed | Passed via real touch coordinates |
| Default target-blank no-opener behavior | Not rerun after adapter switch | Passed |
| Attachment and cookie-authenticated downloads | Both files read back, exact 26-byte contents | Both files copied from container, exact 26-byte contents |
| Blob download | File read back, exact 20-byte contents | File copied from container, exact 20-byte contents |
| Active streamed download cancellation | Passed; stopped at 3,342,336 bytes | Passed; stopped at 851,968 bytes |
| Native typing and retention through shell overlay | Earlier hosting run; WK popup resize retained page | Passed in the WK adapter test |
| Accessibility (at this earlier run) | Native descendants absent; fixed in follow-up above | Native controls/page contents present; popup close reports no hittable AX point despite working touch |

The physical iPad XCTest `testHumanBrowserPopupDownloadsAndRetention` passed in 38.6 seconds. It uses native text input, actual touch events and UI assertions; it does not script the page to fake interaction. The fixture separately records opener callbacks and native download completion. An initial Xcode application launch failed; the passing test attached to the same signed app after a successful devicectl launch. Its popup close helper uses the visible AX frame because XCTest's element tap reported no hittable point. This is **not** full accessibility acceptance.

The download destination is deliberately disposable: a per-download UUID directory under the Mac temporary directory or iPad app Documents. The native UI displays status/byte counts and Cancel. Production destination picking/sharing, resume/recovery and app-wide ownership across pane closure remain later work. Closing a prototype page cancels its transfers.

A navigation converted to a download can report WebKit policy-interruption error 102. The adapter suppresses that expected navigation error only after its own download-policy decision; download errors remain visible through WKDownloadDelegate.

The blob fixture initially used an unqualified URL object in an inline handler and failed before starting a transfer. It now uses window.URL explicitly and reports script errors. The earlier pure-SwiftUI blob case was unverified, not evidence of a renderer failure.

Validation: shared Swift source compiles for Mac and iOS; Electron staging and iPad test builds pass; `bun run check` passes. Mac acceptance used the existing Electron runtime with the staged app to avoid another packaged-runtime copy on a nearly full disk. The updated signed iPad prototype is installed. A new notarized Mac release and minimum-OS-26 iPad run have not been tested.

Current local evidence:

- `/tmp/weave-wve80-results/mac-wkwebview-verified.json`: Mac callbacks, downloads and cancellation.
- `/tmp/weave-wve80-wk-ipad.json`: native iPad snapshots and callbacks.
- `/tmp/weave-wve80-wk-ipad-touch.xcresult`: passing physical UI test.
- `/tmp/weave-wve80-wk-passing-attachments/`: native screenshot and accessibility tree from that passing test.
- `/tmp/weave-wve80-results/ipad-*`: the three completed files copied from the iPad and byte-verified.
- `/tmp/weave-wve80-wk-check.log`: successful repository checks.

Real login providers/passkeys, HTTPS-only iPad capabilities, permission presentation, file uploads, full VoiceOver support and production profiles/pane composition remain open. The fixture demonstrates cookie continuity, not a real OAuth provider's embedded-browser policy.

## Historical pure SwiftUI run

| Case | Evidence | Outcome |
| --- | --- | --- |
| Mac native hosting | Packaged Electron app on macOS 26.6.2; two visible SwiftUI pages with distinct native identities | Passed |
| Mac keyboard input | Typed `WVE-80 native input` into the left webpage; native fixture emitted input events | Passed |
| Independent navigation | Right page navigated to `?pane=right&next=1` while left retained its address and input | Passed |
| Shell overlay | Both native views hide for the React overlay and return with the same native identities; typed input survives | Passed |
| `window.open` | Real click returned no window; fixture reported `window-open: false` | Failed |
| `target=_blank` and POST popup | Navigation decider received `newWindow: true` with GET/POST; no child page appeared | Failed |
| Attachment download | Server served attachment; navigation response observed `application/octet-stream`, `attachment: true`, then selected `.download`; no destination/completion UI appeared | Failed gate |
| Cookie-authenticated download | Request carried the fixture cookie and received the attachment response; still no destination/completion flow | Failed gate |
| Blob download | Fixture exists, but this run did not capture a conclusive click-to-download result | Not verified |
| Mac service worker | Both localhost pages registered their worker successfully | Registration passed; offline/update not tested |
| Web API feature probes | Mac reported secure context, passkey/media/screen-share/WebGPU API presence | Presence only; no end-to-end claim |
| Accessibility | Computer-use accessibility tree exposed shell controls but omitted native page contents; public parent-child AX override did not resolve it and was removed | Unresolved; VoiceOver acceptance still required |
| Physical iPad | Signed debug build installed and launched on iPad Air 11 M3, iPadOS 27.0; native screenshot plus two loaded page snapshots | Hosting/loading passed |
| iPad secure APIs | Fixture was HTTP over LAN, so secure-context APIs were absent | Environment limitation; repeat over trusted HTTPS |
| iPad touch, hardware keyboard, resize/background | Not exercised by the captured loading run | Not verified |
| Password/passkey/OAuth, file picker, media permission, full screen | Not exercised against actual sites | Not verified |

The Swift source compiled with Xcode 26.6 / Swift 6.3.3 against SDK 26.5. The iPad's OS 27 run does not substitute for minimum-OS 26 acceptance. Mac build was locally packaged, not a notarized release build.

Local evidence from this session:

- `/tmp/weave-wve80-results/mac-before-ax.json`: native snapshots and fixture events.
- `/tmp/weave-wve80-results/fixture-before-ax.json`: fixture request methods and cookie-presence records.
- `/tmp/weave-wve80-ipad.json` and `/tmp/weave-wve80-ipad.png`: copied from the physical app container.
- `/tmp/weave-wve80-check.log`: successful repository checks.
- `/tmp/weave-wve80-normal-desktop.log` and `/tmp/weave-wve80-normal-ipad.log`: successful normal builds with the prototype disabled; normal Mac packaging omitted the native addon and fixture screen.

These temporary paths are session artifacts, not portable repository fixtures. Reproduce them using the commands below.

## Implementation boundaries

- `product/alpha/native/client-browser/`: shared Swift module and public N-API/AppKit Mac adapter.
- `product/alpha/ios/App/App/ClientBrowserPlugin.swift`: Capacitor adapter and proper child-view-controller hosting (promoted from the prototype).
- `product/alpha/src/client-browser/`: temporary two-slot React screen and create/adopt/layout/snapshot/close interface.
- `product/alpha/scripts/client-browser-fixture.ts`: local pages, popup callbacks, download endpoints, input and capability reports.

The browser owns its live page outside SwiftUI view recomputation. Shell/native calls use surface identities and bounded geometry/event payloads. The native prototype is compiled only with the explicit prototype flag. The Electron bridge activates in flagged OS-26 builds for both Workspace panes and the separate fixture screen; the prototype launch argument activates fixture evidence recording. Normal packaging omits the native addon and frontend experiment. There is no agent control endpoint. Passive fixture messages are test instrumentation only.

The disposable screen remains useful for capability fixtures. Shared pane schema, migration and local close checkpoints are now implemented in the separate Workspace integration. Full named profile management, recently-closed UI and production focus acceptance remain open.

## Reproduction

Use macOS and Xcode 26+, Bun 1.3.14, and OS 26+ targets. From the repository root, first start the fixture in a separate terminal:

```sh
WEAVE_CLIENT_BROWSER_EVIDENCE=/tmp/weave-wve80-mac bun product/alpha/scripts/client-browser-fixture.ts
```

Build and launch the Mac prototype:

```sh
VITE_CLIENT_BROWSER_PROTOTYPE=1 bun run build:desktop
WEAVE_ALPHA_ACCEPTANCE_DIR=/tmp/weave-wve80-mac 'product/alpha/release/Weave Alpha-darwin-arm64/Weave Alpha.app/Contents/MacOS/Weave Alpha' --client-browser-prototype
```

The Mac uses an isolated user-data directory beneath the evidence directory. It writes native/fixture state to `client-browser.json`. Use normal native input to exercise each fixture; API-presence reports are not functional acceptance.

Build the iPad prototype:

```sh
VITE_CLIENT_BROWSER_PROTOTYPE=1 bun run build:ipad
```

Install `product/alpha/.ipad-build/Build/Products/Debug-iphoneos/App.app` with `xcrun devicectl device install app`, then launch `com.veezee.alpha` with `--client-browser-prototype` and a `WEAVE_CLIENT_BROWSER_FIXTURE` environment variable pointing at the Mac's reachable fixture address. Installing preserves the app container. The debug prototype records `Documents/client-browser-prototype.json` and `.png`; copy them with `devicectl device copy from`. It does not isolate the installed application bundle from ordinary Alpha, so return to a normal build when done.

Normal `bun run build:desktop` and `bun run build:ipad` omit the prototype compile flags. The rest of Alpha's deployment target is unchanged; OS 26 availability guards apply to this experiment.

## Public API evidence

The installed SDK exposes `WebPage.NavigationDeciding` and `DialogPresenting` (including file input), but no public new-view creation callback or download delegate attachment on `WebPage`. Selecting navigation policy `.download` is not a download-lifecycle API. Exporting page content through Transferable is also a different operation.

Apple provides the required lower-level boundaries through [WKUIDelegate new-view creation](https://developer.apple.com/documentation/webkit/wkuidelegate/webview(_:createwebviewwith:for:windowfeatures:)) and [WKDownloadDelegate](https://developer.apple.com/documentation/webkit/wkdownloaddelegate). [WebKit for SwiftUI](https://developer.apple.com/documentation/webkit/webkit-for-swiftui) remains appropriate for hosting and controls, but its web-page abstraction did not meet this prototype's required cases.

## Staged Mac and physical UI-test reproduction

To avoid copying Electron into another app bundle, use:

```sh
VITE_ALPHA_ACCEPTANCE=1 bun product/alpha/scripts/build-desktop.ts --stage-only
WEAVE_ALPHA_ACCEPTANCE_DIR=/tmp/weave-wve80-wk bun run --cwd product/alpha electron .electron --client-browser-prototype
```

Build the iPad app with `VITE_ALPHA_ACCEPTANCE=1 bun run build:ipad`, then build the Acceptance scheme for testing in Debug with the same `product/alpha/.ipad-build` derived-data directory. No Client Browser compile condition is needed. The generated `Build/Products/Acceptance_iphoneos<SDK>-arm64.xctestrun` contains the AlphaUITests configuration. Set its test-runner EnvironmentVariables keys `WEAVE_CLIENT_BROWSER_FIXTURE` to the reachable fixture URL and `WEAVE_CLIENT_BROWSER_ATTACH` to `1`. These are generated local settings, not tracked credentials.

Install the app and prelaunch it with devicectl using `--client-browser-prototype` and the fixture environment variable. Then run `xcodebuild test-without-building` with the generated xctestrun, the physical device destination, and `-only-testing:AlphaUITests/AlphaUITests/testClientBrowserPopupDownloadsAndRetention`. The attach mode avoids the observed Xcode/device application-launch failure. Keep the prelaunch explicit: attach mode must only target the isolated prototype screen.
