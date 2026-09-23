# Trackpad project

This directory owns the native mobile trackpad and mapped Pencil tablet app
tracked by WVE-81. Read `README.md`, `docs/research.md`, and the live issue before
implementation. Use the repository's pinned Linear CLI and tracker conventions
from `../docs/agents/issue-tracker.md`.

Keep app targets, shared Swift packages, dependencies, build scripts, generated
artifacts, and acceptance notes inside this directory. Alpha, Portal, and their
shared protocol are separate applications; their Electron/Capacitor/Bun runtime
choices do not prescribe this project's native implementation. Do not add this
app to the root Bun workspaces or runtime graph as part of routine setup.

Use UIKit for raw mobile touch/Pencil input and AppKit/Core Graphics for Mac
input posting. Keep transport adapters independent of gesture and mapping logic.
Prove ordinary USB communication early; distinguish source-backed feasibility
from on-device success. Pressure/tilt and native Magic Trackpad equivalence are
not requirements for the initial mouse/scroll backend.

The Mac owns display mapping. Squeeze cycles the selected display only in mapped
Pencil mode. Release active strokes before changing mapping and reject samples
from earlier mapping generations. Every interruption must release the input
held by this session; a reconnection must not restore pressed buttons.

Use local, focused Swift/Xcode checks once targets exist, and keep real-device
acceptance separate from unit tests and simulator results. Record actual
hardware/OS/refresh rates with latency evidence. Do not claim USB success from a
wireless route or visible latency from packet RTT alone.

Preserve existing Weave installations, credentials, Host state, and device
profiles. Use distinct app bundle identifiers and local build output. Do not
commit signing assets, provisioning profiles, pairing keys, or machine-specific
Xcode user data. Track canonical Linear status separately from implementation
and device acceptance.
