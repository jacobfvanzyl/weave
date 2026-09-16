# Native browser embedding for human browsing

## Assessment

**Use a shared Weave browser interface backed by Electron `WebContentsView` on desktop and `WKWebView` on iPad/iPhone.** This is the strongest fit for the clarified target: modern websites and web apps, tabs, logins, downloads and permissions. The browser engine runs on the client device. It is a separate product surface from the Host Browser.

These are established native embedding APIs, but they provide engines and integration hooks rather than a finished browser. Weave would supply tab management, navigation UI, permission decisions, download presentation and lifecycle policy. Cross-platform consistency should live in that product interface; Chromium and WebKit will retain platform differences. The APIs do not support a promise that every site behaves exactly as it does in Chrome or Safari.[^electron-view][^wkview]

For mobile implementation reuse, **evaluate `@capgo/capacitor-inappbrowser` before committing to a custom plugin**. Its current API is substantially more capable than the official Capacitor plugins: it documents identified instances, retained hidden views, mutable bounds and touch passthrough. It is a credible adapter candidate, subject to real split-pane, profile and permission tests. Direct `WKWebView` remains the clearer ownership boundary if that wrapper needs substantial modification.[^capgo]

Research and source access date: **16 September 2026**. This is an options assessment, not an accepted specification or implementation. No candidate was installed or exercised in a signed Weave build during this research. Public API availability, source inspection and proposed acceptance checks are distinguished below.

## Fit with the current repository

Repository inspection at `b08c9a6a61b5467ee2c6f6424006b63534e64e6d` establishes:

- [`product/alpha/package.json`](../../product/alpha/package.json) pins Electron `44.3.0` and declares Capacitor core/iOS `^8.3.4`. The checked native mobile target is iOS; its deployment target is 15.0. Android is a future consideration.
- [`src/browser/native-browser.ts`](../../product/alpha/src/browser/native-browser.ts) selects the desktop bridge or Capacitor plugin behind a shared interface. The current browser is a native **display and input client for a Host browser**, not a local `WKWebView`.
- [`electron/native-browser.ts`](../../product/alpha/electron/native-browser.ts) bridges `weave-browser.node`; the iOS plugin inserts a native browser surface below the shell WebView. The terminal uses an analogous platform adapter pattern.
- Existing geometry and lifecycle concepts are useful precedents. Input routing is not reusable unchanged: current browser presentation and shell routing were designed around a stream, while a local WebView must receive native pointer, touch, keyboard, selection, accessibility and focus events.
- The earlier [Phase 1 embedded-browser research](wve-53-phase-1-embedded-browser.md) and `product/deferred/` snapshots describe an older architecture. They are historical references, not current build inputs.

**Architectural inference:** reuse the platform-adapter and pane-presentation pattern, while giving the Client Browser separate sessions, profile storage and lifecycle. Do not reuse the Host Browser's remote rendering connection or forward human keystrokes to its Host session. A Client Browser should load a URL even when no Host browser session exists. In this local design, `localhost`, VPN reachability, file uploads and downloads refer to the client device; accessing a Host's loopback development server would require an explicit reachable address or forwarding feature.

## Candidate comparison

| Option | What it supplies | Fit for Weave |
| --- | --- | --- |
| **Electron `WebContentsView` + custom Capacitor `WKWebView` adapter** | Chromium on desktop; system WebKit on Apple mobile; direct lifecycle, navigation and native delegates | **Recommended baseline.** Strong ownership and native pane integration; browser UI and policy remain ours.[^electron-view][^wkview] |
| **Electron `WebContentsView` + Capgo InAppBrowser** | Same engine split; mobile wrapper supplies identified views, bounds updates, visibility, navigation/events and download handling | **Best reuse candidate to validate.** No Electron backend; Weave still owns the shared interface. Inspect actual release/source and test simultaneous panes and isolation before adopting.[^capgo] |
| **Official `@capacitor/inappbrowser` / `@capacitor/browser`** | WebView presentation, system browser presentation or external navigation; the Browser plugin uses Safari View Controller on iOS | Useful for a browsing sheet or fallback. Their public APIs do not provide the keyed, retained, arbitrarily positioned view management required by Weave panes.[^capacitor-iab][^capacitor-browser] |
| **`WKWebView` in both Electron macOS and Capacitor iOS** | Common Apple framework, with AppKit/UIKit adapters and a custom Electron native addon | Plausible Apple-only alternative. More native integration work on desktop, and no Windows/Linux solution. Shared WebKit does not mean identical OS features, Safari account state or a ready browser UI.[^wkview][^wkextensions] |
| **CEF desktop + `WKWebView` mobile** | Native Chromium embedding with Chrome/Alloy runtime styles | Credible if a demonstrated Electron limitation becomes decisive. Adds a second Chromium integration/update pipeline to an Electron app and still needs the mobile adapter. It does not solve iOS engine parity.[^cef][^cef-runtime] |
| **Qt WebEngine / Qt WebView** | Chromium APIs on desktop; platform WebViews through the separate WebView module | Qt WebEngine supports Windows, Linux and macOS, not the needed iOS engine. Qt WebView restores platform-specific engines and adds Qt to the existing shells.[^qt] |
| **GeckoView** | Mozilla's Android embedding library, with WebExtension support | Worth considering for a future Android browser requiring Gecko capabilities. Not a shared Electron/iOS foundation.[^gecko][^gecko-extensions] |
| **WRY / Tauri ecosystem** | Rust abstraction over platform WebViews | A real shared embedding library, but different engines remain and Weave gains another native integration stack. No demonstrated advantage over its existing Electron/Capacitor boundaries.[^wry] |
| **Alternative iOS engines / Servo** | Engine-porting infrastructure or an alternative embeddable engine | Not the default route to this scope. Apple alternative-engine programs are regional and conditional; an engine project is not a complete compatible browser product.[^apple-eu][^apple-japan][^servo] |

For Electron, avoid starting new work with `BrowserView` (deprecated) or the `<webview>` tag: Electron explicitly recommends alternatives to `<webview>` because of architectural changes affecting stability. `WebContentsView` is a native view in the window hierarchy, not an iframe; external pages remain top-level browser contents rather than depending on the target site's iframe policy.[^webview][^browserview][^electron-view]

## What the target requires from the adapters

| Capability | Electron desktop | Capacitor Apple mobile | Work / limitation |
| --- | --- | --- | --- |
| Modern page rendering | Bundled Chromium through `webContents` | OS WebKit through `WKWebView` | Test representative apps on the minimum supported OS as well as current OS. “Safari supports it” is not sufficient evidence for a configured embedded view.[^electron-view][^wkview] |
| Tabs, navigation and popups | Multiple `WebContentsView`s, navigation events and `setWindowOpenHandler` | Multiple `WKWebView`s; navigation/UI delegates create popup views | Weave owns tabs, history UI, close behavior and opener relationships. OAuth popups need a functioning child-window lifecycle, not just opening the popup URL in an unrelated tab.[^webcontents][^wkui] |
| Persistent logins / private sessions | Persistent or memory-only Electron sessions | Default persistent or nonpersistent `WKWebsiteDataStore`; named persistent stores on newer OS versions | Keep browser storage separate from the privileged app shell and Host Browser. Multiple persistent mobile profiles need an OS availability decision; the current iOS 15 floor cannot simply assume newer profile APIs.[^session][^datastore][^wk17] |
| Downloads and uploads | Session download events, `DownloadItem`, standard file selection | `WKDownload`/delegate, document/file selection and native sharing | Implement destination, progress, cancel/retry and user access to saved files. Validate attachment responses, authenticated and blob downloads, PDF behavior, multiple uploads and background interruption.[^download][^wkdownload][^wkui] |
| Site permissions | Session request/check handlers and device/capture hooks | WebKit delegates plus OS app permissions | Build origin-aware decisions and settings. OS permission to the app and consent for a website are distinct. A listed permission type does not prove the corresponding web feature works on every platform.[^session][^wkui][^capture] |
| Audio/video calls | Chromium WebRTC and platform device permissions | WebKit media support; `getUserMedia` exposed when app capture prerequisites are met | Test real calls, deny/retry, camera/mic indicators, audio routing and backgrounding. Screen sharing is a separate capability from camera/mic.[^wkmedia][^capture] |
| Find, zoom, PDF, developer inspection | `findInPage`, zoom, print/PDF and DevTools APIs | Native WebKit find/PDF APIs; inspectability for Safari Web Inspector | These are integration hooks. Remote inspection from a Mac is not an on-iPad desktop DevTools UI.[^webcontents][^wkview][^inspect] |

### Login compatibility is the main qualification

Ordinary username/password forms, cookies and web storage are suitable for these engines. The difficult cases are identity-provider restrictions and OS credential integration. Google explicitly disallows OAuth in embedded user agents under the developer's control, and its error documentation includes a user following an ordinary site link into a Google authorization flow inside `WKWebView`. Removing agent control does not remove that classification.[^google-policy][^google-errors]

For authentication owned by Weave, a system authentication session or external browser can complete a supported callback flow. For an arbitrary website, opening its login externally does **not** generically transfer its authenticated session back into Weave's isolated browser. The practical fallback may be to continue that website in the system browser. This should be tested against the user's actual daily sites before claiming broad login parity.[^google-errors][^safari-controller]

Apple documents automatic handling of web authentication challenges in `WKWebView`, so passkeys should not be declared categorically unsupported. Validate real relying parties, credential providers and the signed app's configuration. On the current Electron `44.3.0`, `app.configureWebAuthn` supports device-bound Touch ID credentials with signing prerequisites; those credentials are not synced through iCloud Keychain. The newer `platformPasskeys` integration appears in Electron's development line and is not part of the checked 44.3.0 API. It is an upgrade candidate, not current Weave capability.[^apple-passkeys][^electron44-auth][^electron-main-auth][^electron45]

### Service workers and advanced web features need separate evidence

Treat arbitrary-origin service workers on iOS as an early acceptance gate. Apple documents service-worker capability for apps with the default-browser entitlement; WebKit also has App-Bound Domains behavior. A static list of at most ten app-bound domains is not a general-browser solution. This research does not establish current unrestricted service-worker behavior for Weave's signed, non-default-browser Capacitor app. Verify registration, update and offline reload on unrelated sites; decide whether entitlement eligibility is necessary rather than assuming engine support alone settles it.[^default-browser][^app-bound]

Camera/microphone capture and desktop screen sharing are different paths. Electron has explicit desktop capture integration. Do not promise iPad `getDisplayMedia`, screen-audio capture or unrestricted background web execution from camera/mic support; these need their own platform checks.[^capture][^wkmedia]

WebGPU is now part of Safari 26, so “WebKit has no WebGPU” is stale. Its availability is still tied to OS/device support and must be probed inside the actual WebView. WebUSB, WebSerial, filesystem handles and similar APIs should be exposed as platform capabilities, not artificially promised through a common facade.[^webkit26][^session]

## Reuse tradeoffs and browser boundaries

The official Capacitor InAppBrowser distinguishes WebView, system-browser and external-browser modes. Its iOS presentation styles are sheets or fullscreen. `SFSafariViewController` brings useful Safari UI, including Reader, AutoFill and content blocking, but Apple explicitly requires modal presentation and says not to embed it as a child view controller. It therefore cannot serve as an arbitrary Weave split pane.[^capacitor-iab][^safari-controller]

Capgo is different: its documented `openWebView` returns an ID, `updateDimensions` changes bounds, and hide/show retains view state. Registry metadata and the published **8.17.1** tarball confirm these interfaces are published, not just unreleased README claims; the package declares **MPL-2.0**. Its foreground partial-frame mode documents direct interaction and outside-frame touch passthrough. Its behind-shell examples instead forward overlay gestures through `dispatchInputEvent`; that is not proof of native keyboard, selection or accessibility routing. Review the injected page-to-app interface and storage isolation. Concurrent visible views and Weave overlay composition remain untested.[^capgo][^capgo-release]

A shared Weave interface can describe browser/tab identity, profile, navigation, geometry, visibility, focus, loading/title/URL state, popup requests, permissions and downloads. Capability reporting should carry platform differences. This is a proposed seam, not a settled contract. Native WebViews should handle actual webpage input and selection; the browser pane should not acquire the Host Host Browser's control API just because both display web pages.

Electron's remote-content guidance remains applicable to a Client Browser: disable Node integration, preserve isolation/sandboxing, avoid a privileged preload in arbitrary websites, validate shell IPC and use explicit permission handlers. Electron warns that default permission approval is unsuitable for arbitrary remote pages. This is normal browser integration work, independent of agent access.[^security]

### Optional capabilities outside the clarified target

- **Extensions:** Electron supports a subset and explicitly does not promise arbitrary Chrome Web Store extensions. Conversely, public `WKWebExtension` APIs shipped with Safari 18.4; the controller header specifies iOS 18.4/macOS 15.4. Supporting them still requires extension loading, permissions, tabs/windows integration and distribution decisions. Neither route inherits the user's installed Chrome/Safari extensions automatically.[^extensions][^wkextensions][^wkextension-header]
- **Password manager and browser account sync:** cookie persistence is not a Chrome/Safari account, saved-password manager or synchronized tab/history product. System credential integrations can improve login without implementing those products; actual provider behavior remains an acceptance question.[^apple-passkeys][^electron44-auth]
- **DRM and codecs:** do not infer streaming-service support from HTML video playback. Castlabs maintains a separate Electron distribution for Widevine integration, and Qt explicitly does not ship Widevine. That would be a separate dependency and site-compatibility decision, not a requirement for the initial browsing scope.[^castlabs][^qt-features]
- **A single Chromium engine everywhere:** Apple currently has an EU program for iOS 17.4+/iPadOS 18+, with a separate embedded entitlement requiring browsing to occupy most of the display, visible URL and an external-browser route. It includes an update-submission obligation within 15 days of a new embedded-engine version. Japan's iOS 26.2+ in-app route is restricted to browser-engine stewards. These do not form a general worldwide Chromium plugin for Weave's iPad panes. BrowserEngineKit supplies infrastructure, not Chromium itself.[^apple-eu][^apple-japan]

## Recommended next evidence

Once implementation is associated with an issue, use a small native-pane spike to settle the highest-risk behavior rather than building a broad browser shell first:

1. Render a local page in Electron `WebContentsView` and mobile `WKWebView`, comparing direct WebKit with Capgo if reuse remains attractive. Keep two panes visible, resize/switch them, show shell overlays, and test selection, hardware keyboard, software keyboard and accessibility focus.
2. Exercise real daily websites: password login, Google/Microsoft sign-in where used, passkeys, popup callback, persisted login after restart and logout. Record in-pane success separately from external-browser fallback.
3. Test cookie/storage isolation from the Capacitor/Electron shell and Host Browser; test the profile behavior supported by the chosen iOS minimum.
4. Exercise authenticated and blob downloads, uploads, PDF preview/save, camera/mic calls, permission denial/retry and app backgrounding.
5. Verify service workers/offline reload and feature probes on both the oldest supported iPadOS and a current physical iPad. Add screen sharing or WebGPU acceptance only for sites that require them.

The result should be a small supported-site/capability matrix with observed failures and fallbacks. For the user's clarified scope, the native-adapter route is credible; unconditional every-site parity remains an unsupported claim.

## Sources

[^electron-view]: [Electron: WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view).
[^wkview]: [Apple: WKWebView](https://developer.apple.com/documentation/webkit/wkwebview).
[^capgo]: [Capgo: Capacitor InAppBrowser API and examples](https://github.com/Cap-go/capacitor-inappbrowser).
[^capgo-release]: [Published Capgo 8.17.1 registry metadata](https://registry.npmjs.org/@capgo/capacitor-inappbrowser/8.17.1) and [published package tarball](https://registry.npmjs.org/@capgo/capacitor-inappbrowser/-/capacitor-inappbrowser-8.17.1.tgz), inspected for `dist/esm/definitions.d.ts`; registry `gitHead` is `50062ca16a09cb068c9dd10b34f39607ceb1d5a1`.
[^capacitor-iab]: [Capacitor: official InAppBrowser](https://capacitorjs.com/docs/apis/inappbrowser).
[^capacitor-browser]: [Capacitor: official Browser](https://capacitorjs.com/docs/apis/browser).
[^cef]: [Chromium Embedded Framework](https://github.com/chromiumembedded/cef).
[^cef-runtime]: [CEF: Chrome/Alloy runtime migration and embedding modes](https://github.com/chromiumembedded/cef/issues/3685).
[^qt]: [Qt WebEngine overview and supported platforms](https://doc.qt.io/qt-6/qtwebengine-overview.html).
[^gecko]: [Mozilla: GeckoView](https://mozilla.github.io/geckoview/).
[^gecko-extensions]: [Mozilla: GeckoView WebExtensions](https://firefox-source-docs.mozilla.org/mobile/android/geckoview/consumer/web-extensions.html).
[^wry]: [WRY source and platform integration](https://github.com/tauri-apps/wry).
[^servo]: [Servo: project scope](https://servo.org/about/).
[^webview]: [Electron: webview warning](https://www.electronjs.org/docs/latest/api/webview-tag).
[^browserview]: [Electron: deprecated BrowserView](https://www.electronjs.org/docs/latest/api/browser-view).
[^webcontents]: [Electron: webContents navigation, window creation, find, print and DevTools](https://www.electronjs.org/docs/latest/api/web-contents).
[^wkui]: [Apple: WKUIDelegate](https://developer.apple.com/documentation/webkit/wkuidelegate).
[^session]: [Electron: session, profiles, storage and permission handlers](https://www.electronjs.org/docs/latest/api/session).
[^datastore]: [Apple: WKWebsiteDataStore](https://developer.apple.com/documentation/webkit/wkwebsitedatastore).
[^wk17]: [WebKit: Safari 17 API additions, including data-store profiles](https://webkit.org/blog/14445/webkit-features-in-safari-17-0/).
[^download]: [Electron: DownloadItem](https://www.electronjs.org/docs/latest/api/download-item).
[^wkdownload]: [Apple: WKDownload](https://developer.apple.com/documentation/webkit/wkdownload).
[^capture]: [Electron: desktopCapturer and capture prerequisites](https://www.electronjs.org/docs/latest/api/desktop-capturer).
[^wkmedia]: [WebKit: getUserMedia in WKWebView](https://webkit.org/blog/11353/mediarecorder-api/).
[^inspect]: [WebKit: enabling web-content inspection in apps](https://webkit.org/blog/13936/enabling-the-inspection-of-web-content-in-apps/).
[^google-policy]: [Google: OAuth 2.0 secure-browser policy](https://developers.google.com/identity/protocols/oauth2/policies).
[^google-errors]: [Google: OAuth disallowed_useragent and embedded-link behavior](https://developers.google.com/identity/protocols/oauth2/javascript-implicit-flow#authorization-endpoint).
[^safari-controller]: [Apple: SFSafariViewController, modal-only presentation and data boundaries](https://developer.apple.com/documentation/safariservices/sfsafariviewcontroller).
[^apple-passkeys]: [Apple: passkey use in web browsers](https://developer.apple.com/documentation/authenticationservices/passkey-use-in-web-browsers).
[^electron44-auth]: [Electron v44.3.0: configureWebAuthn](https://github.com/electron/electron/blob/v44.3.0/docs/api/app.md#appconfigurewebauthnoptions-macos).
[^electron-main-auth]: [Electron development source: platform passkeys](https://github.com/electron/electron/blob/main/docs/api/app.md#appconfigurewebauthnoptions-macos).
[^electron45]: [Electron v45.0.0-alpha.2: platform-passkey fixes in the development release](https://releases.electronjs.org/release/v45.0.0-alpha.2).
[^default-browser]: [Apple: default-browser capabilities and eligibility](https://developer.apple.com/documentation/xcode/preparing-your-app-to-be-the-default-browser).
[^app-bound]: [WebKit: App-Bound Domains and the ten-domain limit](https://webkit.org/blog/10882/app-bound-domains/).
[^webkit26]: [WebKit: Safari 26.0 features](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/).
[^security]: [Electron: security guidance for remote content](https://www.electronjs.org/docs/latest/tutorial/security).
[^extensions]: [Electron: Chrome extension support and explicit limitations](https://www.electronjs.org/docs/latest/api/extensions).
[^wkextensions]: [WebKit: public extension APIs in Safari 18.4](https://webkit.org/blog/16574/webkit-features-in-safari-18-4/).
[^wkextension-header]: [WebKit: WKWebExtensionController availability and integration](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/API/Cocoa/WKWebExtensionController.h).
[^castlabs]: [Castlabs: Electron for Content Security](https://github.com/castlabs/electron-releases).
[^qt-features]: [Qt: codecs and Widevine requirements](https://doc.qt.io/qt-6/qtwebengine-features.html).
[^apple-eu]: [Apple: alternative browser engines in the EU](https://developer.apple.com/support/alternative-browser-engines/).
[^apple-japan]: [Apple: alternative browser engines in Japan](https://developer.apple.com/support/alternative-browser-engines-jp/).
