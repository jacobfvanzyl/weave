# USB preview acceptance — 22 September 2026

Issue: WVE-81. This records the first native implementation, separating automated
checks, real transport evidence, and human input acceptance.

## Build and hardware

- Xcode 26.6 (17F113), Swift 6.3.3; Swift 6 strict concurrency checks.
- MacBook Air M4, macOS 26.6.2 (25G83).
- Physical iPad Air 11-inch M3, iPadOS 27.0 beta (24A435), Developer Mode enabled.
- Built-in Retina display: global bounds `(0, 0, 1470, 956)`, current mode 60 Hz.
- Dell S3220DGF above it: global bounds `(-437, -1305, 2320, 1305)`, current
  mode 120 Hz. Core Graphics reports these logical mapping bounds.
- iPhone 17e remains a hardware acceptance target; no iPhone run is claimed here.
- Debug and Release device builds succeeded. Debug simulator and signed Debug
  and Release Mac builds succeeded. The only remaining build warning concerns
  skipped App Intents metadata extraction; these apps define no App Intents.
- Physical iPad installation and independent launch both succeeded. macOS
  companion is installed at `~/Applications/Weave Trackpad.app`.
- Codesign verification passed. The local Personal Team profile expires
  29 September 2026; rebuild/reinstall will be needed after expiration. Signing
  assets are not checked in.

## Automated correctness

Eleven Swift package tests passed, covering:

- Fragmented/adjacent frames and oversized/unknown-version rejection.
- Negative display origins, clamped corners, and aspect-preserving tablet area.
- Release-before-squeeze, stale generation rejection, and lift before new contact.
- Duplicate/nonfinite samples and disconnect releases.
- Display removal during a stroke and topology changes between strokes.
- Two-finger tap arbitration, scroll cancellation, double-tap dragging, and
  consistent click counts on release.

These tests exercise the pure reducers and protocol. They do not simulate Pencil
hardware, prove macOS permission behavior, or measure visible latency.

## Real USB evidence

The Mac enumerated the physical iPad as a usbmuxd entry with `ConnectionType=USB`
and connected to its loopback listener on port 49181 through the daemon's
`Connect` protocol. CoreDevice independently reported the device as wired. Both
native apps completed hello/approval/ready and exchanged ongoing ping/pong
messages with no debugger attached.

The diagnostic delivered ten generated input samples plus the initial capture
reset. Subsequent physical-device capture produced additional packets; one
saved session snapshot contained 231 received messages and 86 heartbeat RTT
samples. Input posting was forcibly disabled, and the snapshot showed zero
posted events. This establishes a working bidirectional ordinary USB transport
and device-to-Mac input-message path, independently of Accessibility.

The mobile listener binds only `127.0.0.1`; the Mac adapter filters out network
usbmuxd entries. This test had no Wi-Fi data path or fallback. Wi-Fi radios were
not disabled. A separate radio-off and cable-pull acceptance remains useful.

One short Release diagnostic snapshot reported heartbeat RTT p50 2.83 ms and
p95 23.12 ms over 86 samples. These are preliminary application-level round trips
under development-machine load, including both main queues, framing, encoding,
and heartbeat processing. They are **not one-way latency or Pencil-to-visible
latency**, and are not a product performance result. Further repeated trials
should keep thermal state, workload, sampling interval, and test duration fixed.

## Simulator UI and lifecycle evidence

An iPad Air 11-inch M4 simulator (iOS 26.5) connected to the Mac companion using
an explicit receive-only loopback diagnostic. The evidence was labelled
`Simulator loopback (not USB)` and kept separate from the physical USB run.

- Visually checked trackpad and Pencil layouts.
- The selected Dell display produced a centered 16:9 tablet region within the
  portrait iPad surface.
- Simulated finger interaction increased received input messages in trackpad
  mode. Repeating taps/drags in Pencil mode left the count unchanged at 16.
- Returning to the simulator Home screen closed the connection. The Mac snapshot
  changed to disconnected, with control disabled and zero posted events.
- Mac UI was also inspected; text truncation in setup guidance was corrected.

## Remaining acceptance

Normal app launches require approval on the mobile device. The Mac received
Accessibility permission, and both apps were restarted in normal mode. The user
then confirmed that finger movement/clicking, Pencil drawing alignment, and
squeeze switching between the Dell and built-in display all worked quite well.
The Mac separately recorded more than 4,700 posted events during hands-on use.
This is user-confirmed basic acceptance; it does not cover every interruption
or drawing-app compatibility case below.

- [x] User confirmed visible finger movement/clicking, aligned Pencil drawing,
  and physical Pencil Pro squeeze switching between the two displays.
- [ ] Separately exercise right-click, double-click, drag, and scrolling in Finder,
  native text views, and a browser; record each result.
- [ ] Confirm Pencil hover against small targets and all four corners; test
  squeeze during hover, mid-stroke, and after display removal.
- [ ] Confirm normal consent denial, background/lock, cable removal, app quit,
  permission removal, and timeout all release held input; reconnect stays idle.
- [ ] Run equivalent trackpad acceptance on the iPhone 17e.
- [ ] Add scroll momentum and tune sensitivity, tap timing, and scroll feel.
- [ ] Add authenticated Wi-Fi pairing and transport selection.
- [ ] Measure physical input-to-visible response separately on the 60 Hz built-in
  and 120 Hz external display; compare cable, hub, and Wi-Fi under matched load.

No Wi-Fi implementation, pressure/tilt support, or visible-latency result is
claimed for this preview. WVE-81 remains In Progress.
