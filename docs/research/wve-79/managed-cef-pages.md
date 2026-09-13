# WVE-79: managed CEF pages and private RFB

The Browser Service now manages the selected prebuilt CEF/RFB backend. The isolated macOS and Bazzite Linux acceptance runs passed on 13 September 2026. This is the runtime integration layer; Alpha Browser Panes, the authenticated Portal display transport, and complete ACP browser routing are still to be connected.

## Implemented behavior

One CEF process owns each persistent Host Profile, and several pages in that Profile share it. Each page has a durable UUID, title, last URL and optional opener UUID. Its CEF browser owns the live document and navigation history. The catalog survives service shutdown; Restore explicitly recreates a page at its last recorded URL. Restore does not recover JavaScript state or reconstruct navigation history.

The adapter exposes page creation, close, navigation, back/forward/reload, viewport resize and native CEF DevTools calls through private stdin/stdout JSON-RPC. There is no CDP TCP listener. Each page publishes RFB through a private Unix socket beneath a random 0700 directory; the socket is 0600. RFB sockets are deliberately passive: their pointer, keyboard and resize messages cannot control the page. Portal will grant input and viewport authority through its authenticated control path.

CEF-created popups become managed pages carrying their opener identity and inheriting their Profile. The current service records those events. Creating the corresponding right-hand Workspace split is part of the next composition layer.

Private Browser Service IPC is version 3. The opt-in `browser.cefExecutable` configuration selects the new runtime. The legacy Chrome/WebRTC implementation remains separate transitional code. This change does not advertise a finished public CEF/RFB capability or modify the installed Host configuration.

CEF's own cache singleton prevents a second process from opening the same Profile. The adapter handles relaunch without opening a default Chrome window. There is no additional persistent PID lock to recover. The service serializes page lifecycle operations, coalesces concurrent creation retries, rejects stale runtime generations, preserves records on shutdown, and requires explicit Restore after process loss.

## Acceptance evidence

| Check | macOS Host | Linux Host |
| --- | --- | --- |
| HTTP page loads and native CDP evaluation | Pass | Pass |
| Concurrent Profile-owner exclusion | Pass | Pass |
| Separate Profile local storage | Pass | Pass |
| Several pages reuse one Profile runtime | Pass | Pass |
| 1000 × 800 viewport applied in Chromium | Pass | Pass |
| Timers continue after client disposal | Pass | Pass |
| Popup has opener and inherited Profile | Pass | Pass |
| Explicit Restore after service restart | Pass | Pass |
| Local storage survives restart | Pass | Pass |
| Old command generation rejected | Pass | Pass |
| Native RFB decode matches reference screenshot | 0 differing pixels | 0 differing pixels |
| Passive RFB click and resize rejected | Pass | Pass |

The pixel comparison uses a static fixture with a real Chromium-rendered button and text, decoded by LibVNCClient into CoreGraphics. Each capture contains 800,000 pixels. The Linux capture reaches the Mac through a temporary SSH Unix-socket tunnel over Tailscale. This proves the adapter's RFB stream and native decoder, not the future Portal tunnel or installed iPad integration. The fixture does not establish scrolling throughput, latency, 60 FPS, popup-widget fidelity or broad website compatibility.

[Mac result](evidence/managed-runtime/mac.json), [Linux result](evidence/managed-runtime/linux.json), [pixel comparison](evidence/managed-runtime/pixels.json), [Mac capture](evidence/managed-runtime/mac-rfb.png), [Linux capture](evidence/managed-runtime/linux-rfb.png), [test output](evidence/managed-runtime/tests.txt).

Portal typechecking passed. Nineteen focused tests passed with 96 assertions, covering the existing service/Profile RPC contracts and the new page catalog, concurrent retries, explicit Restore, runtime loss, popup lifecycle, failed persistence and shutdown rejection. The real acceptance script separately exercises native CEF and persistent browser storage.

## Problems found and resolved

The Mac runtime initially created pages and evaluated JavaScript but stalled before sending HTTP requests. A process sample identified a wait in `SecItemCopyMatching`; Chromium was waiting for access to its cookie-encryption key. The adapter now uses the existing VeeZee Apple Development signing identity, and the user approved the native Keychain prompt. HTTP and persistent Profile acceptance then passed, including after rebuilding the signed adapter. No mock Keychain or encryption-disabling flag was added.

The pinned CEF build uses Chromium's default Safe Storage Keychain item. Current upstream source exposes configurable Keychain service/account names behind a newer API guard, but those fields are absent from our pinned SDK. Product-specific Keychain names therefore remain a future upstream-package evaluation, alongside release signing and unattended startup behavior. [CEF settings](https://github.com/chromiumembedded/cef/blob/master/include/internal/cef_types.h)

CEF requires canonical cache paths. Resolving the Profile directory before launch fixes the macOS `/tmp` versus `/private/tmp` mismatch that otherwise allowed an in-memory fallback. Local-storage persistence was retested with a valid on-disk cache.

LibVNCClient 0.9.15's Unix connection helper calculates the address length using `sizeof(sun_family)` rather than the offset of `sun_path`; those differ on macOS. The acceptance helper supplies a connected descriptor and uses the library's public existing-connection path. No installed dependency was edited. Native Portal display transport should likewise supply its authorized connection to the decoder.

The first Linux popup fixture omitted a user gesture and was blocked by Chromium. The corrected fixture marks that evaluation as a user gesture. Earlier failed runs are not counted as successful acceptance.

## Building and reproducing

The small native adapter uses prepared upstream CEF 152.0.6 / Chromium 152.0.7977.83 and LibVNCServer/LibVNCClient 0.9.15 dependencies. Pins and checksums are recorded in `product/portal/native/browser/dependencies.json`. The Mac product build reads the dedicated `product/portal/native/.build/browser` cache; it does not compile Chromium. Linux acceptance reused its existing pinned CEF SDK and wrapper plus the Host's LibVNCServer 0.9.15 library. Automated clean dependency preparation and distributable Linux packaging remain work.

```sh
WEAVE_BROWSER_CODESIGN_IDENTITY='<stable Apple signing identity>' \
  python product/portal/scripts/build-browser-runtime.py

CEF_BINARY="$PWD/product/portal/dist/browser-runtime/Weave Browser.app/Contents/MacOS/Weave Browser" \
  bun product/portal/scripts/managed-browser-acceptance.ts

bun test product/portal/src/managed-browser-pages_test.ts \
  product/portal/src/browser-service_test.ts \
  product/portal/src/browser-profiles_test.ts \
  product/portal/src/browser-profile-rpc_test.ts
bun run check:portal
```

The acceptance script owns temporary profiles and processes, retaining failed-run state for diagnosis. Set `BROWSER_RFB_SNAPSHOT_BINARY` to the compiled `native/browser/rfb-snapshot.m` helper to test native pixels and passive-viewer boundaries. `BROWSER_CAPTURE_READY` supports an externally orchestrated capture, as used for Linux-to-Mac decoding. It writes the socket manifest and waits for a `.done` marker; use a fresh path for each run.

## Next integration layer

1. Add authorized page/view RPC and RFB forwarding to Portal, with explicit Profile grants, revocation, backpressure and latest-focused-client viewport ownership. A readable RFB socket must never itself confer input authority.
2. Connect Browser Pane creation, shared closure and explicit Restore to Workspace composition. Add Profile selection, last-used suggestions and inherited right-hand splits.
3. Embed native LibVNCClient display on Mac and iPad in the common pane frame; connect navigation controls, input, keyboard/IME and focus. Reinstall both product clients for user acceptance at that point.
4. Route maintained MCP/CDP tooling through Portal's authorized page ownership. Native per-page CDP is working, but arbitrary target creation, event multiplexing and large results are not a finished agent interface.

Before broad browser use, handle CEF `PET_POPUP` widget painting, cursor updates, permissions/dialogs, downloads, clipboard and full input; bound slow viewers so RFB encoding or writes cannot stall the CEF UI thread. DPR is currently 1. Graceful restart is validated; abrupt service death, Host reboot, cookie/login persistence, Linux encryption-at-rest configuration, stable release signing/notarization and update migration require further acceptance. Audio remains disabled and 60 FPS remains a target.
