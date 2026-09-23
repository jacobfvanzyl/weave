**Pointer acceleration and scroll momentum — research for WVE-81**

Researched 22 September 2026 against Apple documentation, Apple's published
IOHIDFamily source, WebKit's event-injection code, and the installed Xcode 26.6
SDK. This note separates documented behavior, local experiments, and proposed
product tuning. It does not establish equivalence to a physical Magic Trackpad.

The next increment should add speed-dependent relative pointer movement and an
interruptible scrolling tail, while correcting scroll phase encoding and
retaining fractional movement. Those changes belong together: the current
backend rounds each scroll sample, and its scroll phase field uses AppKit values
where Core Graphics values are required. Pencil's absolute mapping should remain
independent of the relative-pointer acceleration model.

**What Apple's default behavior actually specifies**

Apple describes default pointer acceleration qualitatively: fast movement
traverses more quickly, while slow movement gives more precision. Tracking speed
is adjustable. The Mouse advanced settings expose an acceleration toggle; this
does not establish a corresponding public API that evaluates the active
trackpad curve for arbitrary UIKit touch deltas. [Apple's tracking and scrolling
settings guide](https://support.apple.com/guide/mac-help/change-mouse-or-trackpad-tracking-double-click-and-scrolling-speed-mchlp1138/mac).

Apple's published IOHIDFamily implementation applies acceleration to pointer
events before their accelerated children enter later processing. It can select
user or driver parametric curves and falls back to tables; pointer resolution,
acceleration selection, and report timing also participate. The available source
is useful evidence of the architecture, not proof that one set of constants
describes every current Mac trackpad. Inspected revision:
`777ccd9698845aadf711e32d843c8c9b777431d9`. [Pointer/scroll filter, including
`accelerateEvent` and `createPointerAlgorithm`](https://github.com/apple-oss-distributions/IOHIDFamily/blob/777ccd9698845aadf711e32d843c8c9b777431d9/IOHIDEventSystemPlugIns/IOHIDPointerScrollFilter.cpp).

In that source, the pointer accelerator calculates speed from the magnitude of
the two-dimensional movement and uses one resulting multiplier for both axes.
Report timing can adjust the speed estimate. Its scroll accelerator keeps
recent samples and resets its history after a direction change or a sufficiently
long gap. These are useful design precedents, but copying their numeric input
scale would be inappropriate: our input is UIKit points, not the same device
counts. [Acceleration implementation](https://github.com/apple-oss-distributions/IOHIDFamily/blob/777ccd9698845aadf711e32d843c8c9b777431d9/IOHIDEventSystemPlugIns/IOHIDAcceleration.cpp).

The parametric implementation supports polynomial and tangent segments,
interpolating between curves for a requested acceleration setting. A single
linear multiplier therefore does not recreate that behavior. Neither the
reviewed documentation nor this source establishes a universal, supported
“current macOS default curve” suitable for directly applying to mobile touch
coordinates. [Parametric and table algorithms](https://github.com/apple-oss-distributions/IOHIDFamily/blob/777ccd9698845aadf711e32d843c8c9b777431d9/IOHIDEventSystemPlugIns/IOHIDAccelerationAlgorithm.cpp).

Our mouse events specify a final cursor position in global coordinates; that is
the contract of `CGEvent`'s mouse constructor. Consequently, the reasonable
implementation is to calculate relative pointer acceleration ourselves, then
post the resulting position. Treating a `.cghidEventTap` posting location as a
request to run raw device motion through Apple's trackpad acceleration pipeline
would be an unsupported assumption. This is an architectural inference from the
constructor and HID source, not a measured claim about every event field.
[Mouse event constructor](https://developer.apple.com/documentation/coregraphics/cgevent/init(mouseeventsource:mousetype:mousecursorposition:mousebutton:)).

For scrolling, Apple explicitly documents inertia as scrolling that continues
and then slows after fingers lift; disabling inertia makes scrolling stop at
lift. Scroll speed is separately configurable. The guide does not publish the
velocity estimator, decay constants, or a guaranteed factory tail duration.
[Pointer Control settings](https://support.apple.com/guide/mac-help/change-pointer-control-settings-for-accessibility-unac899/mac).

**The event contract matters as much as the motion curve**

AppKit receives a stream of scroll events after lift. During contact scrolling,
`momentumPhase` is none. During momentum, `phase` is none and `momentumPhase`
progresses through began, changed, and ended. AppKit routes the momentum stream
to the view under the pointer at momentum start even if the pointer subsequently
moves. This supports generating the tail in our input backend; it provides no
contract that an arbitrary `NSScrollView` invents a device momentum stream when
we merely send an end event. Content elasticity and application animation are
separate concerns. [Apple's event handling guide](https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/EventOverview/HandlingTouchEvents/HandlingTouchEvents.html),
[NSEvent momentumPhase](https://developer.apple.com/documentation/appkit/nsevent/momentumphase).

Use the Core Graphics phase enums when writing Core Graphics fields:

| Meaning | CG scroll field | CG momentum field | AppKit phase value after conversion |
| --- | ---: | ---: | ---: |
| None | 0 | 0 | 0 |
| Begin | 1 | 1 | 1 |
| Change/continue | 2 | 2 | 4 |
| End | 4 | 3 | 8 |
| Cancel contact | 8 | Not defined | 16 |
| Contact may begin | 128 | Not defined | 32 |

These values are declared in the installed SDK's `CGEventTypes.h`. WebKit's
test runner independently maps gesture phases to `CGGesturePhase` and momentum
phases to `CGMomentumScrollPhase`, uses pixel scroll events, and marks them
continuous before converting to `NSEvent`. Do not copy `NSEvent.Phase.rawValue`
into either Core Graphics field. A zero-delta terminal event still has a role:
it closes the sequence even when there is no remaining motion.
[CGScrollPhase](https://developer.apple.com/documentation/coregraphics/cgscrollphase),
[CGMomentumScrollPhase](https://developer.apple.com/documentation/coregraphics/cgmomentumscrollphase),
[WebKit event sender](https://github.com/WebKit/WebKit/blob/main/Tools/WebKitTestRunner/mac/EventSenderProxy.mm).

Local validation on macOS 26.6.2 with Xcode 26.6 constructed events and converted
them to `NSEvent` in memory, without posting any events. CG contact values
`1,2,4,8` became AppKit `1,4,8,16`; CG momentum `1,2,3` became AppKit `1,4,8`.
The current preview's `.changed.rawValue == 4` therefore decoded as
ended, and `.ended.rawValue == 8` decoded as cancelled. The probe artifacts are
local and ignored: `trackpad/.local/research/scroll-event-probe.swift` and `.txt`.
This confirms the conversion error; it does not by itself prove application
compatibility after a fix.

Precise deltas avoid line-sized stepping. AppKit instructs consumers to use
`scrollingDeltaX/Y`; when `hasPreciseScrollingDeltas` is false they should scale
by a line/row height, otherwise they scroll by the amount directly.
[Precise scrolling](https://developer.apple.com/documentation/appkit/nsevent/hasprecisescrollingdeltas),
[scrollingDeltaY](https://developer.apple.com/documentation/appkit/nsevent/scrollingdeltay).

Core Graphics has integer point deltas, line delta fields, and 16.16 fixed-point
fields. Its event source also carries a pixels-per-line conversion, documented
as roughly ten by default. These representations should not be populated with
unrelated numbers. Construct pixel events and let the constructor establish
consistent alternative representations. [Event fields](https://developer.apple.com/documentation/coregraphics/cgeventfield),
[pixelsPerLine](https://developer.apple.com/documentation/coregraphics/cgeventsource/pixelsperline).

The local probe additionally tried setting point and fixed-point fields with
fractional values. Point values `0.25` and `0.5` became zero and produced zero
precise AppKit delta; `1.25` became one point even though the fixed-point field
retained `1.25`. Therefore keep a signed fractional remainder in our scroll
quantizer rather than discarding each small sample or assuming a double setter
makes an integer point field fractional. Emit integral pixel movement when the
accumulator crosses the threshold. Preserve lifecycle events even with zero
movement; clear residue at cancellation and gesture boundaries to avoid a later
unrelated gesture inheriting motion.

**Related behavior worth including**

- **Natural direction:** Apple's definition is that content moves in the same
  direction as the fingers. Expose a local preference and apply the sign once
  to both contact and momentum movement. Verify vertical and horizontal signs
  in a real app; the posted-event route should not be assumed to inherit the
  physical trackpad's device settings automatically.
  [Trackpad settings](https://support.apple.com/guide/mac-help/change-trackpad-settings-mchlp1226/mac).
- **Avoid forced axis locking initially:** `NSScrollView` already has
  `usesPredominantAxisScrolling`, defaulting to true, and applications can turn
  it off for freely pannable content such as a canvas. Preserve both axes in
  our stream. Add optional sender-side axis assistance only if device tests
  demonstrate unwanted diagonal drift; an unconditional lock would remove
  useful information from apps that intentionally support diagonal movement.
  [Predominant-axis scrolling](https://developer.apple.com/documentation/appkit/nsscrollview/usespredominantaxisscrolling).
- **Prompt stopping:** a fresh touch should stop any existing tail before the
  next tap, drag, or scroll is recognized. Disconnect, stop control, mode change,
  sleep, cancellation, and invalid session state must close the momentum phase
  and clear its timer/history. This is our safety and interaction policy.
- **Coherent gesture timing:** obtain the Mac's current double-click interval
  rather than keeping a separate hardcoded 0.3-second assumption. The same local
  probe returned 0.5 seconds on this Mac. Tune click distance and touch slop
  together, without delaying immediate pointer feedback.
  [NSEvent doubleClickInterval](https://developer.apple.com/documentation/appkit/nsevent/doubleclickinterval).
- **Keep bounce in the destination app:** we do not know its scrollable bounds.
  Do not synthesize a rebound into opposite-direction wheel events; that would
  conflict with the destination's own elasticity and scrolling rules.

**A proposed model to tune, not an Apple preset**

Use one transport-independent component for relative motion and another for
scroll dynamics. Keep session validation and actual Core Graphics posting as
separate boundaries. Start with these properties:

1. Pointer speed uses input sample timestamps, not packet arrival intervals.
   Apply a continuous, bounded gain increasing with two-dimensional speed,
   with a low-speed precision region and a user tracking-speed multiplier.
   Apply the same gain to X and Y and to ordinary relative dragging. Keep
   fractional cursor coordinates. Reset speed history at touch boundaries,
   mode changes, and long gaps. Never accelerate absolute Pencil coordinates.
2. Estimate release velocity from a short recent interval of actual scroll
   samples. A stationary pause before lift must decay the estimate, producing
   no fling. Reversal must promptly discard the previous direction's velocity.
   Reject nonsensical timestamps and cap extreme values.
3. Generate the tail on the Mac using elapsed monotonic time. An explicit,
   testable starting model is `v(t) = v0 * exp(-t/tau)` with exact displacement
   integration over each update interval. A candidate `tau` around 0.25 seconds
   is a tuning proposal, not a measured macOS default. Expose scroll speed and
   inertia on/off first; keep the decay parameter internal until hands-on
   comparison shows whether another control is useful.
4. Keep contact movement immediate; do not add a display-frame delay to pointer
   input merely to make the momentum scheduler convenient. Tail cadence can
   follow a suitable Mac timer/display cadence while its integral remains
   independent of cadence. Stop below a defined threshold and cap duration.
   A long scheduler stall should stop safely, not replay a large jump.
5. Integrate motion before integer scroll quantization, retain residue across
   tail ticks, and emit one terminal momentum event. A new contact cancels the
   old tail before it starts a new gesture. Do not stack successive flings in
   this first increment; measure before adding that behavior.

UIKit's `UIScrollView.decelerationRate` describes its own content deceleration
and defaults to `.normal`; it is not a public macOS device momentum constant.
Apple's WWDC discussion is valuable for velocity continuity and interruptible
motion, but it discusses iPhone interfaces. It does not justify labeling a
UIKit-derived curve “Mac default.” [UIScrollView decelerationRate](https://developer.apple.com/documentation/uikit/uiscrollview/decelerationrate-swift.property),
[Designing Fluid Interfaces, WWDC18](https://developer.apple.com/videos/play/wwdc2018/803/).

**Measurement and acceptance experiment**

Build a small native observation surface that logs only pointer and scroll
events it receives, not keys or unrelated global activity. For each event
record monotonic time, precise deltas, both phases, and source classification.
Use the built-in Mac trackpad as the reference and the USB iPad as the candidate.
Record OS, display refresh rates, scaling, tracking speed, scroll speed,
natural-scrolling setting, and inertia setting. Do not reset the user's system
preferences to invent a factory-default reference.

For pointer movement, compare slow small-target acquisition, medium movement,
and fast traversal across the built-in and upper Dell displays. Use repeated
similar physical strokes and record cursor travel; this is comparative feel
evidence, not an exact physical gain curve without independently measured finger
travel. Test reversal, diagonal motion, drag precision, and edge transitions.

For a stronger native reference, the diagnostic `NSView` can set
`allowedTouchTypes = [.indirect]` and record `NSTouch` identity, phase,
`normalizedPosition`, `deviceSize`, and `isResting` alongside its locally
received mouse/scroll events. Apple's coordinates begin at the lower left;
`deviceSize` is documented in points (for example, 72 ppi), **not millimeters**.
Multiplying normalized position by device size provides a device-relative
coordinate for comparing finger travel. It still does not expose the raw HID
counts or prove an exact internal acceleration function. Keep the pointer
inside the observation view during capture and report missing/cancelled samples.
An optional resting-touch diagnostic can use `wantsRestingTouches = true` to
avoid mistaking transitions into resting state for physical lift; record the
resting flag rather than treating resting fingers as intentional movement.
[Allowed touch types](https://developer.apple.com/documentation/appkit/nsview/allowedtouchtypes),
[NSTouch normalizedPosition](https://developer.apple.com/documentation/appkit/nstouch/normalizedposition),
[NSTouch deviceSize](https://developer.apple.com/documentation/appkit/nstouch/devicesize),
[Resting touch delivery](https://developer.apple.com/documentation/appkit/nsview/wantsrestingtouches).

For scrolling, capture slow precise movement, short and long flicks, a held
pause before lift, direction reversal, diagonal panning, touch-to-stop, repeated
flings, and disconnect during momentum. Compare initial tail velocity, distance,
time to stop, update intervals, and the sequence of phases. Check a native
`NSScrollView`, Safari, and a scrollable editor or Finder view, including an
application that permits two-dimensional scrolling. Destination apps can differ.

Deterministic tests should establish cadence-independent distance, timestamp
robustness, diagonal invariance, retained subpixel movement, no tail after a
pause, no opposite-direction residue, cancellation after fresh contact, and
exactly one terminal phase. The existing in-memory event conversion probe
should become a focused backend check. These checks establish invariants;
only the installed-device trials establish comfort and compatibility.


**Audit of this prototype and proposed implementation order**

The installed app was not changed during this research. Local probes constructed
objects in memory and exercised copies of pure gesture code; they did not post
input, change macOS preferences, or capture unrelated input. WVE-81 remains the
existing issue association; this document is the proposed next increment.

| Current code | Consequence | Change in this increment |
| --- | --- | --- |
| `apps/macos/MacModel.swift` multiplies every relative delta by 1.7 | Slow and fast motion have the same gain | Time-normalized adaptive gain, plus a linear option and pointer-speed setting |
| `MacModel` writes `NSEvent.Phase.rawValue` into the CG scroll field | Changed becomes ended; ended becomes cancelled | A dedicated CG event encoder, checked through `NSEvent(cgEvent:)` |
| `MacModel` rounds every scroll delta separately | Slow motion disappears; the future tail would end in coarse steps | Signed fractional accumulation and proper zero-motion lifecycle events |
| `InputSample.time` is transported but unused for motion dynamics | Using arrival timing later would make feel vary with transport jitter | Estimate speed from ordered source timestamps; use a Mac monotonic clock only for tail scheduling |
| `FingerGestures` begins a double-tap drag solely within 0.3 seconds | Timing differs from the Mac, and a distant second tap becomes a drag | Negotiate `NSEvent.doubleClickInterval`; require spatial proximity; keep tap duration a distinct threshold |
| No contact-start message for an ordinary stationary finger | The Mac cannot stop a tail immediately until movement or a click arrives | Explicit contact-boundary/cancel semantics before gesture interpretation |
| `FingerGestures.end` feeds the final positions through movement logic | A naive velocity estimator could mistake lift noise for a new fling | Estimate release velocity from a bounded history and account for the pause before lift |
| Finger capture uses callback snapshots; Pencil already uses coalesced samples | Relative sampling behavior can differ with callback frequency | Measure finger coalescing; preserve time order and synchronized two-finger centroids before enabling it |
| `origins` retains ended single-touch IDs | Repeated single-finger sessions retain unnecessary state | Clear per-contact origins at their lifecycle boundary |

Two reproductions strengthen this audit. A tap at `(10,10)` followed 0.15 seconds
later by a touch at `(400,400)` emits `dragBegin` in the current recognizer. A
sequence of 100 scroll deltas of 0.25 pixels emits zero total pixels under the
current rounding, despite representing 25 pixels of movement. The current Mac
reported a 0.5-second double-click interval through AppKit. That is this user's
live setting, not a claim about every Mac's factory default.

Implement the pass in this order:

1. **Correct the output contract and build a reference view.** Extract the Mac
   event construction from connection/UI code. Verify contact and momentum
   phases, X/Y signs, precise pixel deltas, and fractional accumulation before
   tuning any curve. Add a small opt-in local diagnostic surface to compare the
   built-in trackpad with this app. Pointer deltas should also be populated
   coherently for apps that read event deltas rather than only cursor position.
2. **Add pointer dynamics.** A pure `PointerDynamics` component in the shared
   package consumes source-timed deltas, computes one bounded gain from vector
   speed, and preserves displacement. It runs on the Mac, which owns the output
   coordinate space and settings. Retain immediate event dispatch. Keep a
   coherent logical pointer position across batched events and resynchronize
   when the physical Mac pointer is used; validate this against a burst test,
   since repeated reads of global cursor position should not be assumed to
   acknowledge every previously queued post. Speed history resets when the
   finger lifts. Absolute Pencil mapping bypasses this component entirely.
3. **Add scroll dynamics and cancellation.** A pure `ScrollDynamics` state
   machine owns direct scrolling, pending release, momentum, and idle states.
   Compute velocity from source times; generate the tail locally on the Mac so
   its cadence does not depend on USB/Wi-Fi packet delivery. Integrate elapsed
   time rather than multiplying by a fixed factor per tick. A touch that stops
   momentum must not also click accidentally. Handle staggered two-finger lift:
   remaining contact must not trigger an unwanted fling or a pointer jump.
   Re-flick initially replaces the old tail rather than stacking speeds.
4. **Unify gesture settings and interruptions.** Add the contact and settings
   semantics to the versioned protocol, updating both apps together. A stale
   callback must not resurrect cancelled momentum. End the tail on new contact,
   Pencil entry, stop control, disconnect, sleep/lock, display/session change,
   and settings change. Verify the Mac lock signal explicitly; the preview's
   sleep handler alone is not evidence of lock coverage.
5. **Tune on the actual devices.** Start with adaptive pointer movement enabled,
   a linear alternative, separate pointer/scroll speed controls, natural
   direction, and inertia on/off. Keep low-level curve coefficients internal.
   Store device-specific tuning locally if iPhone and iPad need different gains;
   UIKit points and `UIScreen.scale` are not a physical-DPI calibration API.
   Compare the existing 60 Hz built-in and 120 Hz Dell, without changing system
   preferences. Record the selected settings rather than calling the result
   an exact factory-default clone.

Focused acceptance includes one displacement represented as many small samples
versus fewer large samples, the same source samples under different delivery
jitter, 60/120 Hz momentum schedules, stale timestamps, slow reversals, sustained
diagonal movement, pause-then-lift, staggered lift, stop-touch without click,
new-scroll cancellation, and disconnect during inertia. Use Finder, a native
text/scroll view, Safari, and a two-axis canvas for actual app compatibility.
Detailed native settings are reference inputs; the app should never rewrite the
user's global mouse/trackpad preferences.

Drag lock/reposition grace, three-finger dragging, pinch/rotation, browser
navigation swipes, haptics, and Wi-Fi stay outside this increment. Apple's
accessibility guide documents drag-lock and brief reposition behavior, but each
adds interaction choices beyond the current tap-and-hold drag. They can follow
once ordinary pointing and scrolling are predictable. Pressure/tilt and Pencil
screen mapping are unchanged by the proposed relative-motion work.
