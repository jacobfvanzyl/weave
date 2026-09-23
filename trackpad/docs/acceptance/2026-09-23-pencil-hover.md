# WVE-81: local Pencil hover dot

The user requested a Pencil hover dot like Apple Notes. The custom UIKit
surface now draws a 6-point light dot with a dark outline at the Pencil's local
hover location. Its opacity decreases with hover height. This is a Notes-style
preview drawn by this app, not an Apple Notes component or brush footprint.

The existing Pencil-only `UIHoverGestureRecognizer` drives a single shape layer
directly, with implicit Core Animation animations disabled. Rendering does not
wait for the Mac or change the transmitted coordinates. The dot respects
`UIPencilInteraction.prefersHoverToolPreview`, appears only on the connected
input surface, and hides on contact, hover exit/cancellation, finger takeover,
mapping/geometry reset, disconnection, or view removal. It adds no touch target
or local ink.

Apple's [hover sample](https://developer.apple.com/documentation/uikit/adopting-hover-support-for-apple-pencil)
documents custom local hover previews driven by location and `zOffset`.
The installed UIKit SDK documents the user's hover-preview preference.

Validation: signed iOS Release build passed. The app installed and launched on
the physical iPad Air M3, then automatically reconnected to the Mac with control
enabled (confirmed by the companion's current diagnostic snapshot).
Pencil Pro hover appearance and contact/exit behavior require physical-device
feedback; a build does not establish those results.
