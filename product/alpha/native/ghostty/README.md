# Native terminal integration candidate

`pin.json` fixes the Ghostty source revision and Zig version used by the WVE-65
native-library probe. Run it from the repository root:

```sh
bun run probe:ghostty
```

The command requires macOS, Xcode with the iPhoneOS SDK, and Zig 0.16.0. Bun owns
the task; Zig and Apple's compiler build the native library. Source and outputs
are cached under `~/.cache/weave/ghostty/<revision>/`, outside the application
workspace. `WEAVE_GHOSTTY_SOURCE` may point to an existing clean checkout of the
exact revision. The probe rejects a different or modified checkout.

It builds `libghostty-vt`, runs a native macOS test of fragmented UTF-8, ANSI
state, alternate-screen restoration and render-state resize, and links the same
probe into an iOS arm64 dylib. `probe.json` records exactly those results. The
probe does not install anything on the iPad or claim native view acceptance.

The current [upstream build configuration](https://github.com/ghostty-org/ghostty/blob/4a70ee4718ba0967bcfd72f43adb715bf65a860d/src/build/Config.zig#L132)
rejects the full Ghostty renderer on iOS and permits `libghostty-vt` there.
The [internal embedding header](https://github.com/ghostty-org/ghostty/blob/4a70ee4718ba0967bcfd72f43adb715bf65a860d/include/ghostty.h#L1)
also directs external embedders to the public libraries. The public
[render-state interface](https://github.com/ghostty-org/ghostty/blob/4a70ee4718ba0967bcfd72f43adb715bf65a860d/include/ghostty/vt/render.h)
provides terminal cells, styles and dirty tracking; it is not a ready-made
Metal view.

Alpha now has an opt-in shared CoreText renderer with UIKit and AppKit adapters.
It consumes the renderer-owned terminal output stream. Electron uses a narrow
Node-API bridge in the main process, while iPad uses a Capacitor plugin. Neither
native adapter owns Host credentials or terminal processes.

```sh
bun run probe:native-renderer
VITE_NATIVE_TERMINAL=1 VITE_ALPHA_ACCEPTANCE=1 bun run build:desktop
VITE_NATIVE_TERMINAL=1 VITE_ALPHA_ACCEPTANCE=1 bun run build:ipad
```

The build scripts prepare ignored native artifacts under `native/.build/` and
package Ghostty's license. Desktop headers match the exact Electron version;
new downloads are checked against Electron's SHA-256 manifest. The iOS library
currently targets physical arm64 iPads. The Simulator is not covered by this
candidate.

See [the native acceptance checkpoint](../../../../docs/acceptance/wve-65-native-renderer.md)
for evidence and remaining input, rendering and device acceptance gaps. xterm.js
remains the default until those are closed. Omit `VITE_ALPHA_ACCEPTANCE` for
ordinary builds; native inspection and synthetic AppKit input helpers are only
compiled into the desktop acceptance build.
