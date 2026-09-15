# Retina Browser Pane trial — 2026-09-15

The Mac trial renders at the focused client's display density, capped at 2×. The page keeps its logical viewport dimensions and input coordinates. RFB carries a higher-resolution lossless image. Density follows focus ownership, including scale-only changes when the client moves between displays; passive viewers follow the owner.

CEF's upstream `GetScreenInfo` / `device_scale_factor` determines the physical dimensions supplied to `OnPaint`. No browser fork, new codec, or client text reconstruction is involved. [CEF API](https://github.com/chromiumembedded/cef/blob/708dc14/include/cef_render_handler.h)

The public viewport gains optional `deviceScaleFactor` (omitted means 1×). Width and height remain logical. Physical dimensions use the same float scale as CEF and are rounded up. Logical viewports retain their 4096-axis/8-Mpixel bounds. Physical framebuffers are limited to 8192 per axis and 16 Mpixels; the client reduces density, in steps of 1/64, before exceeding that budget. Private Browser Service version 7 and native runtime version 3 prevent mixing incompatible local components. These components must be upgraded together; existing Profiles and Pane IDs survive, but browser process replacement reloads live pages.

The native display uses whole-point dimensions and aligns Mac frames to backing pixels. It retains the existing nearest-neighbor filtering and lossless ZRLE/hextile/raw decoding. Input waits for physical frame dimensions while preserving logical click and wheel units. Pending input is invalidated when density changes. Closing the creation menu allows the first viewport claim; subsequent overlays retain an existing claim.

## Correctness evidence

An isolated authenticated Portal test passed at 2×:

- 1000 × 800 logical viewport, 2000 × 1600 native RFB image.
- Zero different pixels between decoded RFB and Chromium's PNG screenshot.
- Logical click coordinates, fractional wheel movement, nested vertical/horizontal scrolling, and page wheel cancellation preserved.
- Scale-only 2× → 1× → 2× changes retained logical width and page state.
- Repeated same-size focus claims preserved unchanged pixels.
- Stale-owner rejection, popup Right splits, shared close, and unattended page lifetime passed.

Evidence: [Portal acceptance](evidence/mac-retina-20260915/portal-acceptance.json).

## Scrolling comparison

Three sequential 20-second Mac loopback runs used the same dense fixture, logical viewport 1149 × 851, and synthetic wheel input through the mounted product surface. This measures input capture to native layer submission, not physical screen scanout. It is a short comparison, not a 60-FPS acceptance claim or a forecast for every website.

| Density | Physical frame | Distinct scrolling FPS | Median input to layer | Stream bandwidth |
| --- | --- | ---: | ---: | ---: |
| 1× | 1149 × 851 | 37.5 | 111 ms | 33.2 Mbps |
| 1.5× | 1724 × 1277 | 23.5 | 322 ms | 34.4 Mbps |
| 2× | 2298 × 1702 | 22.2 | 189 ms | 43.2 Mbps |

All runs preserved scroll displacement. Neither baseline nor Retina passed the 60-FPS cadence gate on this fixture. The fractional-density result is exploratory and did not offer a useful compromise. The 2× run paints/processes four times the pixels; actual compressed bandwidth grew about 30%. Further profiling should separate CEF paint/compression time from native presentation before selecting another optimization.

The installed trial uses 2× on Retina displays so the user can assess text fidelity and scrolling on real pages. No iPad or Linux acceptance was performed in this pass. Audio remains deferred.

The user accepted the installed Mac trial on 2026-09-15: text quality is substantially better, with a slight subjective increase in scroll latency. Retain 2× as the quality baseline; the 60-FPS target remains open.

- [1× summary](evidence/mac-retina-20260915/1x-summary.json) · [native image](evidence/mac-retina-20260915/1x.png)
- [1.5× summary](evidence/mac-retina-20260915/1.5x-summary.json) · [native image](evidence/mac-retina-20260915/1.5x.png)
- [2× summary](evidence/mac-retina-20260915/2x-summary.json) · [native image](evidence/mac-retina-20260915/2x.png)

The removed CEF build cache was restored from the repository's pinned archive and SHA-256. Reusable SDK/wrapper artifacts now live under `~/.cache/weave/cef/b0f277f1025dcedd690f59dfe3d1ec5e2f7f90564d0e5de997e6fc3c1febfa48`; pass that path as `--dependencies` to `product/portal/scripts/build-browser-runtime.py`. Only the small adapter needs rebuilding for subsequent source edits.
