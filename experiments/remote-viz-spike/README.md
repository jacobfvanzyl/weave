# Remote Viz compositor spike — WVE-79

This is an isolated feasibility experiment based on Jaco's Remote Chromium Viz Compositor Spike document. It reopens Chromium patching and a custom native compositor for investigation; it does not replace the accepted WebRTC backend without evidence.

First gate: capture actual post-aggregation Chromium frames and independent raster resources, then replay them correctly. Live transport is deliberately gated on that result.

Chromium is pinned in `chromium-pin.json`. Source findings, build state, empirical measurements and unverified proposals are recorded separately under `docs/`.

The patched headless Chromium build succeeded. Native offline replay now covers the observed texture/uniform-mask subset, finite 2D affine transforms and a single transparent-edge Gaussian-blur render pass. All five frames in each new affine/filter fixture replay, with measured differences from Chromium: 619 pixels above tolerance for rotation, 887 for the combined scale/skew/fractional case, and 3,797 for blur at 800×600. Earlier primitive and OOPIF static references remain exact.

This is a bounded feasibility result, not general or pixel-perfect browser compatibility. Native Metal multisampling and Apple's MPS blur keep the code small; they do not reproduce Skia exactly. Filter chains/backdrops, perspective, native presentation/input, iPad runtime acceptance and live transport remain open. See [measurements and exact limits](docs/measurements.md). WebRTC remains the accepted backend.

## Deferred fallback: framebuffer remoting

User decision, 2026-09-12: evaluate framebuffer remoting if the current Viz spike requires too much ongoing client maintenance or fails to meet latency or visual fidelity expectations. Continue the current spike; this records a fallback for later evaluation, not a backend change.

The fallback would let Chromium complete composition on the Host and send updates to the finished image, such as changed pixel rectangles and optional copy operations, to a native client. It need not use video encoding. Prefer an existing open-source remote-display implementation over a custom protocol; see the [open-source alternatives research](../../docs/research/wve-79-open-source-browser-remoting.md).

If triggered, compare it with the Viz results and the existing WebRTC baseline using end-to-end input-to-display latency, text and effects fidelity, scrolling and animation behavior, bandwidth, and ongoing integration/client maintenance. Preserve the agreed macOS/Linux Hosts, native macOS/iOS clients, audio, Workspace profiles and focus-based viewport ownership requirements. The user authorized the first framebuffer gate on 2026-09-13. The SPICE/CocoaSpice experiment stopped before browser integration: shared displays worked experimentally, but additional viewers received no audio, and the Apple frameworks-only packaging shortcut failed to link. See the [first-gate evidence and limits](../framebuffer-spike/README.md). A subsequent [RFB/LibVNC experiment](../rfb-spike/README.md), with audio deferred by the user, passed native synthetic Mac/iPad acceptance and controlled pixel-exact CEF browser comparisons on both Hosts. Performance comparison remains open; the accepted backend has not changed.

## Run the independent Metal check

From the repository root on macOS with Xcode:

```sh
mkdir -p experiments/remote-viz-spike/.build
xcrun swiftc -swift-version 5 -O experiments/remote-viz-spike/client-apple/Replay.swift -o experiments/remote-viz-spike/.build/viz-replay -framework Metal -framework MetalPerformanceShaders -framework CoreGraphics -framework ImageIO -framework UniformTypeIdentifiers
python3 experiments/remote-viz-spike/tools/synthetic_capture.py experiments/remote-viz-spike/.build/synthetic
experiments/remote-viz-spike/.build/viz-replay experiments/remote-viz-spike/.build/synthetic-rendered experiments/remote-viz-spike/.build/synthetic/frame-1.json experiments/remote-viz-spike/.build/synthetic/frame-2.json experiments/remote-viz-spike/.build/synthetic/frame-3.json > experiments/remote-viz-spike/evidence/synthetic-replay.jsonl
experiments/remote-viz-spike/.build/viz-replay experiments/remote-viz-spike/.build/synthetic-rendered experiments/remote-viz-spike/.build/synthetic/pass-crop.json experiments/remote-viz-spike/.build/synthetic/source-copy.json > experiments/remote-viz-spike/evidence/synthetic-sampling-replay.jsonl
python3 experiments/remote-viz-spike/tools/check_synthetic.py experiments/remote-viz-spike/.build experiments/remote-viz-spike/evidence/synthetic-replay.jsonl
```

This is offline native GPU replay with explicit subset rejection. The frames above are synthetic. After those fixtures exist, run the texture/mask checks:

```sh
python3 experiments/remote-viz-spike/tools/check_texture_mask.py
python3 experiments/remote-viz-spike/tools/check_affine_blur.py
python3 experiments/remote-viz-spike/tools/replay_corpus.py experiments/remote-viz-spike/.build/actual/corpus-mask experiments/remote-viz-spike/evidence/actual-mask-corpus.json
```

The corpus runner reads actual captures already on disk and compares the final static frame with a sibling `NAME-reference.png`. It records rejections as measurement results; a zero runner exit is not a claim that every fixture replayed. A live native browser window, input bridge and network protocol are not implemented yet.

## Fixture coverage

| Page | Purpose |
| --- | --- |
| `primitives.html` | Colors, text, border and an embedded image |
| `transforms.html` | Promoted integer translation and animation; also the interactive application with buttons, text input, scrolling and dynamically inserted rows |
| `transforms-advanced.html` | Static scale and rotation; scale may be rasterized upstream |
| `affine.html` | Paused compositor scale animation, skew and fractional translation/source sampling |
| `clipping.html` | Rectangular/nested clipping and promoted content under a rounded clip |
| `opacity.html` | Nested opacity and overlapping promoted layers |
| `effects.html` | Blur and shadow; inspect actual pass/filter state |
| `iframe.html` / `child.html` | Different loopback hostnames with site isolation; animated by default, fixed-position reference with `OOPIF_STATIC=1` |

CSS features do not imply a particular Viz quad or state: some effects can be baked into raster resources. Record the actual capture corpus and replay result for each case. The current strict decoder intentionally rejects several advanced states.

[Chromium findings](docs/chromium-findings.md), [semantic constraints](docs/semantics-research.md), [interim measurements](docs/measurements.md), [build and artifact strategy](docs/build-strategy.md), [capture patch](server/chromium-patches/README.md).
