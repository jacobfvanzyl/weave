# Measurements — interim

## Affine and blur gate — 13 September 2026

All five captured frames of each new fixture now replay through the native client. The added behavior uses **four-sample Metal multisampling** and **MPSImageGaussianBlur**, with no custom Gaussian kernel or custom edge-coverage shader. The client accepts finite nonsingular 2D affine transforms and fractional/scaled tile sources; perspective and 3D sorting remain rejected. The filtered-pass subset is one isotropic Gaussian blur with transparent/decal edges, unit filter scale/origin, no backdrop filter and a matching child backing.

| Fixture, 800×600 DPR 1 | Pixels with RGBA error >2/255 | Maximum RGB error | Maximum alpha error |
| --- | ---: | ---: | ---: |
| Rotation plus static rasterized scale | 619 (0.129%) | 29/255 | 0 |
| Actual compositor scale, skew, fractional translation | 887 (0.185%) | 49/255 | 77/255 |
| Blur render pass plus rasterized box shadow | 3,797 (0.791%) | 9/255 | 0 |

These are per-pixel channel comparisons of the final static frame with a separate same-state Chromium screenshot, not perceptual scores. Differences were inspected visually: the affine cases concentrate differences at boundaries, with smaller text-sampling differences; the blur differences stay in its expanded footprint. RGBA maxima include alpha, which matters for composition. The largest affine alpha difference must not be described simply as a small color error.

The old static CSS scale case was insufficient: Chromium rasterized its card at the enlarged size and sent an identity linear transform. A new paused CSS scale-animation fixture emits an actual 0.875 scale over the original 230×110 resource. It also exercises skew and a 0.25/0.5-pixel translation with fractional source coordinates. [Actual matrices and sampling inputs](../evidence/actual-affine-filter-inputs.json).

The blur fixture now verifies a genuine two-pass graph: a 240×120 child pass is filtered into Chromium's reported `[-6,-6,252,132]` output rectangle, then placed in the parent. The box shadow in that fixture is already rasterized; this is not proof of a client-side drop-shadow filter. Filter chains, backdrop blur, other filter types, non-unit filter transforms and filter-mask textures remain rejected.

To avoid inventing Skia's bounds rules, the capture records the single-blur tile mode and obtains output bounds through Chromium's existing filter implementation. The successful incremental rebuild took **22.50 seconds / three steps**. One preceding compile attempt failed on a protected Skia-filter member; it was corrected to the public `PaintFilter::GetSkFilter` accessor. The regenerated patch matches the remote compiled header and passes reverse applicability checking.

Apple describes its Gaussian kernel as an approximation. The kernel and Skia need not produce identical weights or rounding. Chromium's software renderer also chooses edge antialiasing per draw; the current client uses four-sample coverage for a whole pass containing nontrivial affine transforms. In particular, this can antialias an axis-aligned scaled edge that Chromium draws without AA. Matching those choices more closely would require further client integration. [Apple Gaussian blur](https://developer.apple.com/documentation/metalperformanceshaders/mpsimagegaussianblur), [transparent-edge configuration](https://developer.apple.com/documentation/metalperformanceshaders/mpsunaryimagekernel/edgemode), [pinned Chromium software renderer](https://github.com/chromium/chromium/blob/507c6ee3e2f3b2ca0e660547e5b9ea4820c67f4c/components/viz/service/display/software_renderer.cc), [filter construction](https://github.com/chromium/chromium/blob/507c6ee3e2f3b2ca0e660547e5b9ea4820c67f4c/cc/paint/render_surface_filters.cc).

The main Swift replay file is now 399 lines, including capture loading, validation, Metal setup, native mask handling and PNG export. The capture helper is 310 lines. Line count is not a maintenance estimate: the owned semantics still include pass ordering/bounds, sampling, alpha, clipping, resource identity and explicit unsupported-state validation. Native APIs keep this gate small, but they do not eliminate Chromium-version and fidelity obligations.

Existing primitive/OOPIF exact matches, opacity/mask comparisons and all 28 translation-animation frames retain their prior results. New synthetic output tests verify 90-degree rotation, 2× scaling, shear, blur expansion/symmetry/premultiplication, and rejection of perspective, singular transforms, chains, backdrop filters, scaled filters and non-decal blur. macOS runtime and iOS arm64 compilation pass. iPad runtime, live presentation/input/transport, optimized resource extraction and representative latency remain untested.

[Corpus results](../evidence/actual-affine-filter-corpus.json), [regressions](../evidence/affine-filter-regressions.json), [synthetic checks](../evidence/synthetic-affine-blur.json), [native affine image](../evidence/native-replay/affine-native.png), [affine reference](../evidence/native-replay/affine-reference.png), [affine difference](../evidence/native-replay/affine-diff.png), [native blur](../evidence/native-replay/effects-native.png), [blur difference](../evidence/native-replay/effects-diff.png).

The gate demonstrates a feasible native-API replay subset, with measured fidelity limits. It does not approve those limits for the product. The next choice is physical-iPad evaluation with these limits recorded, or the deferred framebuffer comparison before further custom compositor work. WebRTC remains the accepted implementation baseline.

Local execution briefly hit disk pressure (about 117 MiB free). Only three disposable binaries built by this spike were removed: the local Linux Portal acceptance harness and the macOS/Linux Browser Service outputs. Source, evidence, browser profiles, applications, and the completed remote Chromium build were preserved.

## Native texture/mask replay — preceding result

The capture now includes structured mask bounds/radii/gradient presence, exact texture background color and resource origin. Regenerating the diagnostic patch and rebuilding the same Chromium checkout took **19.24 seconds and three build steps**. No clean rebuild was needed.

The Swift client implements the observed top-left, transparent-background texture subset with normalized or pixel source coordinates and strict source bounds. Uniform circular rounded masks use CoreGraphics for coverage and Metal for composition; masks are cached at their bounding-box size. The scrollbar mask uploads 1,152 bytes once across the animated capture. This reuses Apple's rasterizer instead of introducing a custom antialiasing implementation, with the measured Skia differences below.

| Fixture | Native offline result versus Chromium reference |
| --- | --- |
| Primitives | All 4 captured frames replay; final static image exact |
| Static cross-process iframe | All 6 frames replay; final static image exact; separate parent `page` and child `iframe` targets verified in both reference and capture runs |
| Nested/overlapping opacity | All 4 frames replay; maximum channel error 1/255 |
| Interactive translation page | All 7 static frames replay; 13 of 480,000 pixels exceed 2/255, confined to the rounded scrollbar thumb; maximum error 21/255 |
| Nested and rounded clipping | All 4 frames replay; 33 pixels exceed 2/255, confined to rounded clipping edges; maximum error 13/255 |
| Animated translation | All 28 frames replay; 22 verified same-resource transform changes and 22 native frames with resource reuse and zero raster uploads |
| Blur/shadow | Rejects a filtered render-pass quad; blur fidelity is unproven |
| Scale/rotation | Rejects a non-translation transform; affine fidelity is unproven |

The static references are separate runs of the same patched Chromium binary at 800×600, DPR 1, with the same fixture state; screenshot capture is disabled during resource measurements. Comparisons use decoded RGB/RGBA channel values, not a perceptual metric or color-profile proof. Animated frames are not compared with separately timed screenshots. Representative [native page](../evidence/native-replay/transforms-native.png), [Chromium reference](../evidence/native-replay/transforms-reference.png), [amplified difference](../evidence/native-replay/transforms-diff.png), [rounded clipping](../evidence/native-replay/clipping-native.png) and [iframe](../evidence/native-replay/iframe-native.png) were inspected visually.

The previously observed texture and scrollbar-mask blockers are resolved for this subset. Masked Src replacement is supported only for opaque sources; translucent replacement, gradients and unequal corner radii still fail explicitly. Unsupported texture origins/background/video/protection states also fail. Native round-mask antialiasing is close but not pixel-identical to Chromium. This remains a maintenance/fidelity decision, not a universal browser-rendering solution.

[Corpus metrics](../evidence/actual-mask-corpus.json), [translation/reuse metrics](../evidence/actual-replay-progress.json), [actual animated replay](../evidence/actual-mask-animated-replay.jsonl), [OOPIF verification](../evidence/actual-oopif-validation.json), [texture/mask regression checks](../evidence/synthetic-texture-mask.json).

The original synthetic movement, pass dependency, crop, source-replacement and alpha/orientation checks still pass. New native checks cover tile/texture equivalence, normalized coordinates, strict scaled source bounds, mask interior/corner/origin and explicit unsupported-state rejection. macOS compilation/runtime checks passed. The same Swift source cross-compiles for iOS arm64 (iOS 17 minimum, iPhoneOS 26.5 SDK); it has not been installed or runtime-tested on iPad. No full repository check was needed for this isolated experiment-only change.

Capture still rereads all resource pixels: the animated run examined 37,738,700 bytes to write 3,281,240 raster payload bytes. That diagnostic overhead is not an optimized dirty-resource path. Neither debug-build offline replay timings nor PNG export measure presentation latency. Live transport, input, frame/resource lifetime, broader effects/transforms, GPU capture and native iPad replay remain open.

## First actual Chromium capture — initial result, 12 September 2026

The six-worker Bazzite `headless_shell` build succeeded after 7h9m18.53s, reporting 31,271 build steps. The automatic capture/validation probe then completed on the pinned patched browser.

- Captured 30 actual post-aggregation frames and validated every referenced raster payload.
- Observed 23 unambiguous transform changes with the same resource ID, generation and raster hash, requiring zero new associated raster payload bytes for those moving resources.
- Across the complete capture: 3,543,384 raster payload bytes, 40,757,796 raster bytes examined, 320,375 diagnostic JSON bytes and 16 unique resource versions. These are local diagnostic extraction totals, not network bandwidth or production performance. The much larger examined-byte total remains an overhead concern to measure.
- Actual materials were solid color (5), texture content (9) and tiled content (10). No aggregated render-pass quad appeared in this first corpus, so it does not validate real multi-pass reconstruction.
- Native Metal replay on Apple M4 rendered three startup frames containing a single solid quad each, then rejected page-content frame 4 at a texture quad used by the scrollbar. It did not silently omit the quad or produce a page output.
- The same corpus also contains a rounded scrollbar-thumb mask with radius 4.5, outside the current strict client subset. That remains an additional implementation gap after texture support.

The initial assumption that this ordinary interactive fixture would fit the solid/tile/pass-only client was incorrect. Resource reuse is now demonstrated in real Chromium; complete page replay and fidelity are not. Supporting texture/mask semantics is client work. Additional structured mask fields may require a small capture-patch change and incremental rebuild, but these findings do not require another clean Chromium build.

[Build result](../evidence/build-status.json), [actual capture analysis](../evidence/actual-transforms-capture.json), [native rejection](../evidence/actual-transforms-rejection.json), [startup-only native replay](../evidence/actual-transforms-replay.jsonl).

The raw capture and raster files remain in ignored `.build/actual/transforms-first` locally and the isolated Bazzite capture directory. Do not use the native WebRTC spike as evidence for this different architecture.

## Observed

- Pinned Chromium source checkout on Bazzite succeeded; the capture patch passed `git apply --check` against its exact commit.
- The patched Chromium display translation unit compiled successfully. Its initial fresh prerequisite build took about 12.5 minutes, then the internal-linkage fix rebuilt successfully in 14.69 seconds. The subsequent full build and capture results are recorded above; this earlier object compilation was not itself a capture result.
- Standalone Swift/Metal offline replay compiled and ran on Apple M4.
- Three explicitly synthetic frames used two render passes and a persistent texture. Native resource upload was 3,072 bytes initially and zero bytes for each later frame, with one cache reuse per frame.
- Pixel checks passed for movement, render-pass dependency, drawing order, rectangular clipping and premultiplied opacity. A deliberately unsupported mask was rejected without writing an output image.
- An independent source audit found and corrected child-pass texture stretching and unconditional SrcOver blending. Additional synthetic pixel checks passed for a consuming quad smaller than its backing, a nonzero child-pass origin and Src replacement. Scaled tile sampling now rejects explicitly; its strict source-subrectangle filtering is not implemented.

[Native synthetic statistics](../evidence/synthetic-replay.jsonl), [pixel checks](../evidence/synthetic-pixel-check.json), [unsupported-state rejection](../evidence/synthetic-rejection.json).

These prove a narrow client implementation path. They do not prove Chromium emits the expected stable resources, that actual page composition is reproduced, or that the model improves bandwidth/performance. Synthetic timing includes JSON/resource loading, Metal submission/wait and PNG export; it is not presentation or network latency.

## Stock Chromium software-compositing diagnostic

With `--disable-gpu --disable-gpu-compositing`, stock Linux Chromium kept the card as layer 5 (230×130), changed its transform from x=30 to x=430 after a real CDP-dispatched mouse click, retained paintCount 2, and emitted no subsequent LayerTree paint events during the observation interval. The DOM click counter became 1. This supports the presence of compositor-only movement in the proposed first configuration. It is **not** a measurement of Viz raster bytes or resource identity. CDP LayerTree matrices are column-major; the separate Viz trace matrices used by the replay are row-major.

[Raw LayerTree diagnostic](../evidence/stock-software-layers.json), [reproducible probe](../tools/stock-layer-probe.ts).

## Still to measure

Broader quad/state coverage; optimized source read/copy overhead; live interaction and metadata/resource bandwidth; frame lifetime/deletion; dirty-frame comparison; native iPad behavior; perceptual LAN behavior. Initial real corpus, resource reuse, static OOPIF and image-comparison results are recorded above.

At this earlier stage the client accepted integer translation, one-to-one integral tiles, the restricted texture subset, solid and unfiltered pass quads, SrcOver/Src replacement, rectangular clipping, opacity and uniform rounded masks. The later affine and single-blur extension is recorded above; broader filters and gradient/complex masks still require work. The software reference quantizes tile/pass opacity to eight bits; the current Metal path retains floating opacity, consistent with the measured one-channel difference in the opacity case.

The cross-origin iframe fixture was verified under stock software-composited Chrome with `--site-per-process`: the parent was a 127.0.0.1 page and the localhost child appeared as a separate `iframe` CDP target. That original diagnostic established the fixture as an OOPIF case; the later actual static reconstruction is recorded above. [OOPIF setup evidence](../evidence/stock-software-oopif.json).
