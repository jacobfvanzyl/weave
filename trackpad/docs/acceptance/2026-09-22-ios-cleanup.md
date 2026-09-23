# WVE-81: mobile UI cleanup and automatic tools

22 September 2026. Requested changes: remove the app icon/title, mode picker,
inner border, surface instructions, and footer; put the transport indicator in
the title position; make disconnect an icon; use a full-width blank surface
with the MacBook Air trackpad's proportions; select finger/Pencil input automatically.

## Behavior

- Header contains a compact USB indicator and an accessible icon-only disconnect
  button when connected. Connection details/errors remain available by tapping
  the indicator. Wi-Fi has not been implemented, so the UI only advertises USB.
- One blank 16:10 surface is shared by both tools. It fills the iPad's available
  width in portrait and landscape. Very short windows fit to height to keep the
  complete rectangle accessible without distorting its ratio.
- Pencil uses the whole rectangle for normalized absolute mapping to the selected
  display. This intentionally replaces the previous display-aspect inset. For
  a selected display with different proportions, horizontal and vertical scale
  differ; this follows the requested fixed-shape, fully active tablet surface.
- Pencil hover or contact selects Pencil mode synchronously, releasing any old
  finger gesture/momentum first. Direct Pencil contact also works without hover.
  A new finger contact selects trackpad mode after Pencil leaves range.
- Fingers already resting during Pencil use remain ignored through lift, and
  cannot resume from movement or steal control mid-stroke. Mapping/rotation
  interruptions also require old finger contacts to lift. Pencil squeeze keeps
  the existing release-and-lift-before-resuming behavior across display changes.
- Mode changes no longer increment the display-mapping revision, preventing a
  delayed SwiftUI update from cancelling a newly started automatic Pencil stroke.

## Proportion and API references

The current Mac identifies as Mac16,12 (13-inch M4 Air). The chosen 1.6 ratio
comes from a hands-on measurement of the 13-inch M2 Air's 12.8 × 8 cm trackpad;
Notebookcheck's M3/M4 reviews describe unchanged input devices/case design.
Applying that ratio to the current Air is an inference from this shared design,
not a new physical measurement of this user's laptop.

- [Galaxus hands-on measurement](https://www.galaxus.be/en/page/a-hands-on-test-of-the-apple-macbook-air-m2-24279)
- [M3 input-device comparison](https://www.notebookcheck.net/Apple-MacBook-Air-13-M3-review-A-lot-faster-and-with-Wi-Fi-6E.811129.0.html)
- [M4 design comparison](https://www.notebookcheck.net/The-passively-cooled-M4-SoC-makes-the-competition-look-old-Apple-MacBook-Air-13-M4-base-model-review.1002534.0.html)
- [Apple Pencil hover API](https://developer.apple.com/documentation/uikit/adopting-hover-support-for-apple-pencil)

## Validation

32 Swift tests pass, including four new physical-tool arbitration cases:
Pencil hover takeover/finger return, direct Pencil contact and palm suppression,
held fingers across mapping interruption, and preserving Pencil contact during
interruption. Signed iOS Release and simulator builds pass.

The updated signed app installed and launched on the physical iPad Air M3.
Simulator iPad Air 11-inch visual checks confirm the blank full-width 16:10
surface in portrait and landscape, removal of title/picker/instructions/border/
footer, and the connection-details popover. Physical hover, palm handling,
automatic switching, and squeeze remain subject to user device acceptance.

## Physical-device acceptance

After installation and reconnection, the user tested finger movement, Pencil
hover/contact, and return to a fresh finger contact and reported **“Switching
works well.”** Automatic tool switching is accepted on the iPad Air M3/Pencil Pro.

The additional iPhone simulator launch was interrupted when the shared simulator
service shut that device down and another simulator became active. No iPhone
visual acceptance is claimed for this pass; the completed visual checks were on
the iPad simulator. The other active simulator was not repurposed for this task.

## Native toolbar follow-up

The user supplied a floating-window screenshot showing iPadOS window controls
covering the custom USB header, then approved moving the header into a native
toolbar. The mobile screen now uses a `NavigationStack` with `.topBarLeading`
connection status and `.topBarTrailing` disconnect. The title remains empty;
there is no additional heading, mode picker, or instructional prose. The toolbar
background is hidden so the app retains its minimal appearance.

This removes the fixed-padding custom header and lets the system navigation bar
arrange items around window controls. Apple documents this automatic behavior
in [Make your UIKit app more flexible](https://developer.apple.com/videos/play/wwdc2025/282/?time=764).
The input surface and automatic tool arbitration are unchanged.

Signed iOS Release and simulator builds passed. The updated app installed and
launched on the physical iPad Air M3. Automated visual verification could not be
completed: the desktop UI tool returned `cgWindowNotFound` for both the companion
and Simulator. The simulator app itself installed and launched through simctl.
The user subsequently checked the same floating-window layout and confirmed
**“Yes, it clears them.”** Traffic-light clearance is accepted on the physical iPad.
