# Trackpad

Native iPhone/iPad trackpad and Mac companion. On iPad, a blank Pencil tablet
maps absolutely to a selected Mac display. Squeeze Pencil Pro to cycle displays.

Tracked in [WVE-81](https://linear.app/jacobfvanzyl/issue/WVE-81/build-native-mobile-trackpad-and-screen-mapped-pencil-tablet).
The [research and plan](docs/research.md) records API evidence and staged acceptance.
The [pointer and scroll research](docs/research-pointer-scroll.md) explains the motion model and API choices for acceleration, momentum, precision,
and gesture timing. The [motion acceptance record](docs/acceptance/2026-09-22-motion.md)
separates automated checks from remaining hands-on tuning.

## Current preview

The native targets and USB adapter are implemented. The first real iPad-to-Mac
USB handshake and input-message test passed; see the
[acceptance record](docs/acceptance/2026-09-22-usb-preview.md). Trackpad mode supports
relative movement, tap, double-tap, two-finger right-click, double-tap-and-hold
drag, speed-dependent pointer acceleration, and two-axis scrolling with momentum. Pencil mode supports absolute mapping over the full input surface, hover,
coalesced contact samples, and squeeze-to-next-display. Pencil hover/contact
selects tablet mode and suppresses palms; a fresh finger contact selects trackpad
mode once the Pencil is out of range. Mapping changes cancel the old stroke.
While hovering in Pencil mode, a small local dot previews the tip position and
fades with height. It disappears on contact, leaving range, or interruption, and
respects the iPad's Pencil hover-preview preference.

Finger input preserves available coalesced touch samples in capture-time order,
grouping simultaneous finger positions before calculating movement. It retains
original contact identities and rejects duplicate or pre-transition history.
This preserves more measured motion where UIKit supplies extra samples; it does
not force a higher hardware sampling or callback rate. See the
[finger sampling acceptance record](docs/acceptance/2026-09-23-finger-sampling.md).

USB pairing persists in each app's local Keychain. After one explicit pairing,
opening the mobile app reconnects automatically while the companion is running
and the Mac session is active, and starts control when Accessibility is allowed.
The [automatic connection acceptance record](docs/acceptance/2026-09-22-auto-usb.md)
separates implementation and automated checks from physical-device acceptance.

This is an early USB preview. **Wi-Fi, further gesture
tuning, and end-to-end latency measurements remain planned work.**
Pressure/tilt and screen mirroring are outside the initial scope. The mouse event
backend does not promise native Magic Trackpad gesture equivalence.

The initial hardware is iPhone 17e, iPad Air M3/Pencil Pro, and MacBook Air M4
with an external display above its built-in screen. See `docs/acceptance/` for
measured evidence; successful compilation is not device acceptance.

## Build

Requires Xcode with Swift 6, macOS 15+ and iOS/iPadOS 18+. The current build
script targets Apple Silicon Macs. There are no third-party runtime dependencies.
Run commands below from the Weave repository root:

```bash
swift test --package-path trackpad/packages/TrackpadCore
trackpad/scripts/build.sh mac
trackpad/scripts/build.sh ios
trackpad/scripts/build.sh simulator
```

Without `TRACKPAD_DEVELOPMENT_TEAM`, builds are unsigned. For device installation,
set that variable to your own team ID from Xcode Settings → Accounts:

```bash
export TRACKPAD_DEVELOPMENT_TEAM=YOUR_TEAM_ID
trackpad/scripts/build.sh ios
trackpad/scripts/install-ios.sh 'your device name'
TRACKPAD_CONFIGURATION=Release trackpad/scripts/build.sh mac
trackpad/scripts/install-mac.sh
```

Use `TRACKPAD_CONFIGURATION=Release` for performance acceptance. Keep the Mac app
at a stable path with a stable signing identity when testing Accessibility.
`install-mac.sh` installs to `~/Applications/Weave Trackpad.app`, verifies its
signature, and keeps the previous bundle under ignored `.local/previous-apps/`.
Quit the companion before updating; the script refuses to replace a running app.
Personal Team provisioning expires; rebuild and reinstall when it does. On a
new developer identity, iPadOS may require trust under Settings → General → VPN &
Device Management before launch.

`Trackpad.xcodeproj` and shared schemes are committed and directly openable.
`scripts/generate-project.py` reproducibly generates them using Python's standard
library; rerun it after adding app Swift files or changing target settings. Both
targets link the local `TrackpadCore` Swift package. No Bun workspace changes are
needed, and root Bun checks do not validate these apps.

## Try the USB preview

1. Keep Trackpad open on the mobile device and attach its USB cable to the Mac.
2. Open the Mac companion, refresh USB devices, and connect.
3. Choose **Pair and connect** on the mobile device once. Earlier previews only
   remembered per-session approval, so upgrading requires this new pairing step.
4. On Mac, choose **Allow Accessibility…**, grant Trackpad access in System
   Settings. Control then starts automatically for the paired connection.
5. Use the blank surface. Fingers control the trackpad; bring Pencil into hover
   range or touch down to select absolute tablet mapping automatically. Move
   Pencil away and start a fresh finger contact to return to trackpad input.
   Squeeze to cycle screens; after a mid-stroke squeeze, lift before drawing again.

The native mobile toolbar shows the USB connection indicator and an icon-only
disconnect button, allowing iPadOS to arrange them around its window controls. Tap the indicator for connection details. The same blank 16:10 rectangle
is used for both tools, at full available width on iPad. In very short windows
(such as iPhone landscape), it fits within the available height to keep the whole
surface accessible. Pencil coordinates map its entire width and height to the
selected display; different display proportions therefore scale the two axes
differently. See the [mobile UI acceptance notes](docs/acceptance/2026-09-22-ios-cleanup.md).

Subsequent app openings and cable reconnections need neither an approval prompt
nor another **Enable Mac control** click. Only known USB devices are probed
automatically; a second device cannot replace an occupied connection.

**Release input**, **Disconnect**, turning off **Enable Mac control**, or the
menu-bar stop action releases held input and pauses automatic control on Mac.
Use **Resume automatic connections**, explicitly connect/enable again, or restart
the companion to resume. The mobile disconnect icon pauses its listener until
**Reconnect** in the USB popover or the next app opening. The Mac's **Pairing**
menu can forget an attached device, requiring explicit pairing again.

Backgrounding mobile, connection loss, timeout, and Mac sleep end the session
without forgetting the pairing. No held state is replayed on reconnect. Display
changes carry a new generation, rejecting queued old motion. Session deactivation
and best-effort lock signals gate reconnection; there is no dedicated documented
screen-lock API in this implementation. Lock/unlock, permission revocation, and
physical cable loss need hardware acceptance in addition to reducer tests.

Quartz posting explicitly permits local mouse, keyboard, and system events,
including during synthetic dragging. Observers pass local events through and
resynchronize the relative pointer. Local pointer/scroll activity ends a mobile
momentum tail. All devices operate the same macOS cursor.

The companion's **Motion** controls save pointer speed, acceleration, scroll speed,
natural direction, and momentum locally. They do not modify macOS preferences or
Pencil mapping. Double-tap timing uses the Mac's current double-click interval;
a second tap must also be close to the first. Touching during momentum stops the
tail without clicking. A pause before lift or a lingering second finger suppresses
the fling. Changing motion settings releases the current gesture.

**Open motion test** provides a native scroll view and a draggable target. Its
optional **Record local input** captures only pointer/scroll events received by
the grid and saves JSON under
`~/Library/Application Support/WeaveTrackpad/MotionTraces/`. It distinguishes our
tagged events from other sources; other sources may include UI automation and are
not automatically evidence of physical trackpad input. Record native and mobile
trials separately with their settings. Recordings stop on window closure or at
10,000 events. No keystrokes are recorded.

Wire protocol v3 adds persistent pairing and mutual challenge authentication;
update both apps together. A new pairing exchanges a random 256-bit secret only
after explicit approval over the trusted USB connection. Reconnects exchange
HMAC-SHA256 proofs bound to the session, both installation identities, fresh
nonces, and message roles. The Mac enables control only after the mobile confirms
the host proof. Pairing secrets are excluded from diagnostics and preferences.
This authenticates reconnection over USB; it does not encrypt/authenticate every
input frame or supply the security design for a future Wi-Fi transport.
Older/newer incompatible peers fail closed during frame decoding.

The iOS listener binds only to loopback port 49181. The Mac connects through
`/var/run/usbmuxd` and selects only daemon entries marked `USB`. There is no
wireless listener in this preview. USB daemon integration is undocumented OS
behavior, isolated in `apps/macos/USBTransport.swift`.

## Diagnostics

The companion writes a local snapshot to
`~/Library/Application Support/WeaveTrackpad/diagnostics.json`: received messages,
posted events, scroll phase counts, current motion settings, display bounds, and
app heartbeat round trips. RTT is **not**
Pencil-to-visible latency. The baseline uses bounded length-prefixed JSON on an
ordered stream; profiling will determine whether binary encoding or a different
queue is worth introducing.

For a receive-only USB diagnostic, launch both apps with `--usb-diagnostic`.
The mobile app then automatically accepts a companion named `Trackpad diagnostic`
and sends generated pointer, Pencil, and source-timed scroll samples. The burst
waits 200 ms for the mobile view’s initial reset, then exercises a full momentum
lifecycle on the Mac. The Mac diagnostic forcibly disables
input posting. This checks framing and mapping through the real app transport;
it does not test physical touch/Pencil capture. Never treat it as a drawing test.

For simulator-only integration, launch the mobile simulator with
`--usb-diagnostic` and the Mac with `--simulator-diagnostic`. This uses explicit
loopback TCP and labels its evidence **Simulator loopback (not USB)**. Normal
launches require initial pairing and use authenticated reconnection afterward.

## Source layout

```text
apps/ios/                 SwiftUI shell and UIKit capture surface
apps/macos/               Mac companion, usbmuxd adapter, Core Graphics posting
apps/shared/              Network.framework framed stream
packages/TrackpadCore/     Protocol, gesture and input reducers, focused tests
scripts/                  Build, project generation, device installation
docs/                     Research and acceptance evidence
```

This project is independent of Weave Alpha, Portal, and their shared protocol.
Build output and local signing files remain under ignored paths. Do not commit
provisioning profiles, pairing credentials, or Xcode user state.
