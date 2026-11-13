---
status: accepted
date: 2026-11-13
---

# The iPad and iPhone run the Mac's Tauri shell, and Capacitor goes

ADR 0032 put the app on the Mac in Tauri and kept Capacitor on the iPad and iPhone, for three native parts Tauri couldn't host there: the device's key in the Secure Enclave, terminals drawn natively under the web view, and Surfaces. That left two shells, two ways to reach a Host, two terminals and a Swift project to keep beside the Rust.

The iPad and iPhone now run the Mac's shell, `app/src-tauri` built for iOS, and Capacitor is gone (WVE-221). One shell and one Rust core serve every device.

- **The core does on a device what it does on the Mac,** less the Mac's own Host: it pairs with the Dispatcher, keeps the device's key in the Secure Enclave (`weave-host-client`, which already had it for the Mac), proves every connection itself and relays it to the page. The page neither holds the key nor opens a WebSocket to the Dispatcher.
- **Terminals are drawn in the page on every device,** by libghostty-vt in WebAssembly, as ADR 0032 settled for the Mac. The page takes touch itself: a tap for the keyboard, a drag to scroll, a hold to select, and a bar of the keys a software keyboard lacks.
- **Surfaces are dropped** (WVE-183). Tauri gives the app no scene of its own for a second display, and they weren't in use.
- **Pushes, when they come, need a Swift plugin of weave's own.** Tauri has none. That is accepted, and nothing is built for it now.
- **A browser stays a third shell behind the platform seam** (`app/src/app/platform.ts`): its own WebSockets and a WebCrypto key, drawing no terminals. Nothing of Tauri's is imported outside the Mac's and the device's sides of that seam, so a web build later is a matter of that shell, not of the app.

## The gate

ADR 0032 named the test for a terminal in the page: a flood of output and typing latency, against the native terminal. On the Mac it passed by measurement (WVE-205). On the iPad and iPhone the person ran the two apps side by side, the Capacitor one and this one under a second bundle id, both against their own Dispatcher and Hosts, and judged the page's terminal good enough to replace the native one (2026-11-13, iPad Air 11-inch (M3) and iPhone 17e). No figures were recorded there, so that is a judgement by hand, not a measurement.

## Considered options

- **Keep both shells,** as ADR 0032 had it. Every feature of the shell was written twice, and the iPad reached Hosts by a path the Mac didn't share.
- **A native terminal in a Tauri plugin on iOS.** Tauri documents no way to put a native view under its web view, and the page's terminal held up.
- **Keep Capacitor for the iPhone alone, for Surfaces.** A shell for one feature nobody was using.

## Consequences

- **Supersedes ADR 0032 for the iPad and iPhone,** and its expectation that Tauri there waited on native views and pushes. What it settled for the Mac stands.
- **Amends ADR 0015.** The app is no longer in Capacitor anywhere.
- **Amends ADR 0022.** The app's libghostty-vt runs in the web view on every device. A terminal's bytes still cross no bridge: the page opens each stream as a WebSocket on a loopback port, which the core passes through to the Host's.
- **Devices pair again, once.** The Capacitor app kept its pairing in its preferences and its key under a name of its own; the core keeps its own of both. The app installs over the old one under the same bundle id, `com.veezee.weave`, and shows the pairing screen. The old key stays in the device's Keychain, unused, and the old device stays listed on the Dispatcher until `weave devices revoke` removes it.
- **The native terminal, its renderer's tests and its simulator check are removed** with `app/ios`. The page's terminal has its own tests and the Mac's terminal check; nothing yet runs that check on a device.
- **The Dispatcher still names Capacitor's origin** (`capacitor://localhost`, `weave-host-protocol`'s `APP_ORIGIN`) as the page it takes. No shell sends it now, since the core opens the connections. A web build will need an origin of its own allowed there.
- **Not yet seen on a device:** a hardware keyboard, `weave://` links, and pushes, which there are none of.
