---
status: accepted
date: 2026-11-08
---

# The app runs on the Mac in Tauri, and the iPad and iPhone keep Capacitor

The app is to replace Rex at the desk (ADR 0031, WVE-199), so it has to run on the Mac. Today it is React in a Capacitor shell for the iPad and iPhone (ADR 0015), with three native parts:

- device keys in the Secure Enclave;
- terminals drawn natively under the web view with libghostty-vt (ADR 0022);
- Surfaces on a second screen (WVE-183).

WVE-198 compared the ways to bring the app to the Mac ([research](../research/herdr-t3code-and-a-tauri-app.md)).

The Mac runs the same React app in Tauri, and the iPad and iPhone keep Capacitor. Both shells sit behind a platform seam beside `AppController`, which covers device keys, terminals, the local Host and windows. The UI, the Host store and the transcript stay in TypeScript, shared by both.

- **The Mac's Rust core links `weave-host-client`.**
  - It reaches the Mac's own Host over its Unix socket, as local clients do (ADR 0030).
  - It reaches every other Host through the Dispatcher, with the device's key in the Secure Enclave.
  - It relays each Host connection to the page. It isn't a second client of the Host protocol.
- **Terminals on the Mac are libghostty-vt built to WebAssembly and drawn on a canvas.**
  - The build uses the holder's Ghostty pin.
  - Each terminal is fed by a WebSocket the page opens itself, never by Tauri's IPC. For the Mac's own Host, the core serves `terminals.sock` to the page as a loopback WebSocket with a token per launch.
  - If the iPad's native terminal does clearly better on a flood of output or on typing latency, the Mac switches to the native renderer in an `NSView` (WVE-205).

## Considered options

- **Tauri on the iPad and iPhone too, one shell everywhere.**
  - Tauri 2 documents no way to put a native view under the web view. It has no push plugin and no app or scene delegate the app can change, and its Swift plugins run only on iOS.
  - The iPad and iPhone would lose the native terminal and the Surface.
  - Revisit when Tauri can host native views and take pushes. The platform seam makes that a change of shell, not of app.
- **Electron, as Alpha had and T3 Code has.** It brings Chromium and Node, and none of the Rust core's reach: the local socket and the Secure Enclave would need a helper process or Node modules.
- **GPUI, as Herdr's app uses.** It is native, and draws libghostty-vt directly. But the UI would be written again in Rust, apart from the React the iPad and iPhone keep.
- **The iPad app on the Mac, as "Designed for iPad" or Mac Catalyst.** It is the least work, but iPad-shaped and Mac-only.
- **A native terminal on the Mac from the start.** `WeaveTerminalRenderer.mm` already builds for macOS, but Tauri documents no way to put an `NSView` beside its web view. WebAssembly on a canvas is how T3 Code's desktop app draws libghostty-vt.

## Consequences

- **Amends ADR 0015.** The app returns to the desktop in Tauri, not Electron.
- **Amends ADR 0022 for the Mac only.** There, the app's libghostty-vt runs in the web view; the iPad and iPhone keep drawing natively. Both follow the same Ghostty pin, and the same rule for restores across codecs.
- **One engine on Apple's devices.** The Mac's web view is WKWebView, the same engine as on the iPad. Linux and Windows, later, bring WebKitGTK and WebView2.
- **Terminal bytes never cross a bridge on any device,** as ADR 0022 already requires on iOS.
- **New work for a Mac app:** signing, notarization and updates (WVE-204).

## Settled in WVE-204 (2026-11-10)

- **The shell is `app/src-tauri`,** a crate outside the repository's Cargo workspace, with its own lockfile, so Tauri's dependencies don't join the workspace's build.
- **The Mac shares the computer's pairing.** The core proves itself with the pairing and Secure Enclave key the CLI keeps (`weave-host-client`'s `paired`, written by `weave dispatcher connect`), so the Mac is one device to the Dispatcher, and revoking it cuts off both.
- **The core proves every connection itself,** the Dispatcher's API included, and hands the page connections already open. The page never holds the key nor asks it to sign: it renders what agents write.
- **This Mac's own Host stays reachable without the Dispatcher,** over its socket, as ADR 0030 keeps for local clients; every other Host goes through the Dispatcher.
- **Signing, notarization and updates:** for now a release build signed with the person's Apple Development identity and installed by `bun run mac:install`; no notarization or updater until the app goes beyond this Mac. Linux and Windows stay later.
