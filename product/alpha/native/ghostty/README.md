# Native terminal integration

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

Alpha uses the shared CoreText renderer with UIKit and AppKit adapters as its only terminal renderer.
It consumes the renderer-owned terminal output stream. Electron uses a narrow
Node-API bridge in the main process, while iPad uses a Capacitor plugin. Neither
native adapter owns Host credentials or terminal processes.

```sh
bun run probe:native-renderer
VITE_ALPHA_ACCEPTANCE=1 bun run build:desktop
VITE_ALPHA_ACCEPTANCE=1 bun run build:ipad
```

The build scripts prepare ignored native artifacts under `native/.build/` and
package Ghostty's license. Desktop headers match the exact Electron version;
new downloads are checked against Electron's SHA-256 manifest. The iOS library
currently targets physical arm64 iPads. The Simulator is not covered by this
integration.

Normal `build:desktop`, `dev:desktop` and `build:ipad` commands include native
libghostty automatically. There is no JavaScript terminal fallback or renderer
feature flag. Browser previews show an unavailable surface instead.

WVE-65 delivers this default. Remaining attended device acceptance, the complete
terminal stress/handoff matrix, restoration-contract work and the permission-card
status defect are deferred to [WVE-72](https://linear.app/jacobfvanzyl/issue/WVE-72).
See [the default-renderer evidence](../../../../docs/acceptance/wve-65-native-default.md)
for completed checks and their limits. Set `VITE_ALPHA_ACCEPTANCE=1` only for
acceptance artifacts; ordinary builds omit native inspection and synthetic
AppKit input helpers.

### Replicated Terminal state

WVE-75 replaces tmux capture with public libghostty binary snapshots from the
persistent Host Terminal Service. Client replicas restore READY before paged
history and then apply ordered live bytes. Only the service generates PTY
query replies; replicas retain upstream human keyboard, mouse and paste
encoders, including Kitty keyboard modes. The exact upstream codec pin must
match. No older text snapshot decoder or tmux keyboard restriction remains.

Kitty images are disabled: neither the current painter nor upstream snapshots
provide the required image restoration. Terminal output does not gain native
clipboard, notification or external-file privileges. See the
[service contract](../../../portal/src/terminal-service/README.md) for the
lifetime, feature policy, bounds and deliberate maintenance behavior.

### Terminal appearance

Both native shells bundle and register JetBrains Mono Nerd Font TTFs with
CoreText. Web font registration is independent. Native input composition uses
the same font metrics as the terminal cells. The renderer draws the cursor
shape supplied by libghostty (block, bar, underline or hollow) and respects its
visibility, including cursor state restored by the Host snapshot.

The default foreground, background, cursor, ANSI palette and native selection
use Catppuccin Mocha. Explicit application RGB/OSC colours retain their meaning.
New Weave shells receive lavender/dark `ZVM_VI_HIGHLIGHT_*` defaults for
zsh-vi-mode; explicit Host environment or shell configuration can override them.
Already-running shells retain their current shell variables.


The emulation grid always matches the Host screen dimensions. Native layout only
measures local column/row capacity for input ownership; it does not reflow the
terminal. A smaller pane clips the logical screen at the top-left with no scaling,
panning or cursor following. A larger pane leaves unused background visible.
Both native shells clip overlays and selection as well as terminal drawing;
TextKit uses the logical grid width rather than wrapping to the iPad viewport.
Protocol 6 binary screen notifications replace the grid and screen at the Host capture
watermark after a PTY resize, before subsequent output. The last attachment to
send input retains size ownership; passive geometry changes only record capacity.
