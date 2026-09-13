# Post-aggregation rendering semantics

This is **source inspection**, not an empirical Chromium capture or compatibility result. The inspected revision is Chromium **153.0.8010.36**, commit **507c6ee3e2f3b2ca0e660547e5b9ea4820c67f4c**, resolved through the Chromium GitHub mirror's [tag reference](https://api.github.com/repos/chromium/chromium/git/ref/tags/153.0.8010.36). All source links below are immutable links to that commit. No Chromium checkout or build was performed for this note.

## Findings that change the proposed spike

1. **The leading seam is credible, but it is an internal renderer contract.** `Display::DrawAndSwap` calls `SurfaceAggregator::Aggregate`, then passes the render-pass list to its renderer. `AggregatedRenderPass` explicitly is not Mojo-serializable and is local to the Viz process. A stock Chrome extension or CDP endpoint does not follow from this seam: exposing it requires Chromium integration. The smallest inspection hook belongs immediately after `Aggregate`, before `Display` calls its occlusion culler and before `DirectRenderer` performs overlay processing. [Display flow][display], [aggregated pass contract][pass], [renderer overlay flow][direct]
2. **The initial material list needs correction.** At this seam the pass quad is `AggregatedRenderPassDrawQuad`; creation of `CompositorRenderPassDrawQuad` in an aggregated pass is forbidden by static assertions. `kYuvVideoContent` and `kStreamVideoContent` are removed enum values; texture quads cover those paths. Foreground and backdrop filters live on the aggregated pass **quad**, not on `AggregatedRenderPass` at this revision. [Material enum][quad], [pass restrictions][pass], [filter fields][passquad]
3. **Post-aggregation does not guarantee pre-rasterized input in every configuration.** The final Skia renderer can raster `PictureDrawQuad` display items. Its tile path can also receive a paint-op buffer through raw draw. The first resource-only experiment must disable those paths, reject them with explicit diagnostics, or materialize their pixels on the server. A successful ordinary tile capture does not establish their absence for every browser configuration. [Skia renderer, `DrawPictureQuad` and `DrawTileDrawQuad`][skia]
4. **Supporting four material enums is not equivalent to supporting ordinary websites.** The same four enums carry masks, rounded corners, gradient clipping, blend modes, filters, perspective/3D sorting, texture sampling and color behavior. Unsupported *state* needs the same explicit reporting as unsupported materials. [Shared state][sqs], [pass quad][passquad], [texture quad][texture], [Skia renderer][skia]

## What aggregation does resolve

`CopyQuadsToPass` treats `SurfaceDrawQuad` specially, calling `HandleSurfaceQuad` instead of copying that surface reference to the destination. `EmitSurfaceContent` recurses through referenced surfaces, transforms and clips their content, handles device-scale mismatches, remaps passes and either merges the child root pass or emits a pass reference. It guards surface cycles. When a referenced surface is unavailable, the aggregator can emit the surface's default background color and fallback gutters. Therefore “flattening” here means resolving a surface dependency graph into a render-pass graph; it does not mean flattening all content into one texture or one pass. [Surface resolution implementation][aggregator]

This supports the expectation that an OOPIF's embedded surface belongs in the resulting graph **when that child surface has an active frame and is embedded under the chosen root**. It does not prove an OOPIF acceptance case: capture a real cross-origin frame in a separate renderer process and verify its changing pixels in replay. Nor does it prove all popups, browser UI or separate native windows belong under a tab's root. `Aggregate` starts from one specific `SurfaceId`; each intended visible surface must be shown to belong to that root or handled as a separate stream. [Aggregate entry and surface traversal][aggregator]

The output also retains some display concerns outside the simple pass/quad schema: content color usage, surface damage metadata, delegated ink and tracked element rectangles. Delegated ink is subsequently handed separately to the renderer. Excluding it is an explicit spike limitation, not automatic semantic equivalence. [Aggregated frame][frame], [Display flow][display]

## Ordering, coordinates and texture sampling

- `QuadList` stores **front-to-back** order. Chromium's ordinary alpha painter iterates `BackToFront`, and it sends quads with nonzero `sorting_context_id` through polygon/BSP processing. Preserve the recorded ordering, then reverse it for conventional back-to-front drawing. A matrix vertex shader alone does not reproduce CSS 3D intersection semantics. Reject nonzero sorting contexts in the initial subset. [Quad list][list], [DirectRenderer drawing loop][direct]
- Quad `rect` and `visible_rect` are in content coordinates. `quad_to_target_transform` maps those into the target's physical pixels; the shared clip and mask geometry are in target coordinates. Pass output/damage rectangles are physical-pixel rectangles and can have nonzero origins. Do not apply device scale again to coordinates already in pass pixels. [DrawQuad coordinate contract][quad], [shared state][sqs], [render-pass fields][passinternal]
- Tile coordinates are unnormalized pixel coordinates. Texture quads can use either normalized or unnormalized coordinates and provide conversion helpers. When `visible_rect` crops geometry, UVs must be cropped proportionally rather than stretching the whole texture into the smaller visible rectangle. `DrawTileDrawQuad` does exactly that. [Tile fields][tile], [texture conversion helpers][texture], [Skia tile drawing][skia]
- Tile sampling also accounts for valid texel bounds and the originating layer's right/bottom edges. Rounded masks and edge anti-aliasing cannot be reproduced merely with a rectangular scissor. A first proof can use integer-aligned translation and no masks; rotations and fractional translations need separate comparisons. [DrawQuad edge helpers][quad], [Skia `DrawTileDrawQuad` and `PrepareCanvas`][skia]
- Canonical server-side BGRA8/sRGB resource conversion is a useful restriction, but it does not by itself specify blend-space behavior, output color transforms or all texture alpha handling. `TextureDrawQuad::force_rgbx`, its background color and the renderer's color conversion are observable state. Report those as unsupported or implement them explicitly. [Texture fields][texture], [Skia color and image drawing][skia]

## Damage, cache and capture pitfalls

For the first replay, render all passes completely and use damage only as telemetry. Chromium's renderer can skip undamaged non-root passes and retain render-pass backing textures. Damage describes what needs redrawing relative to retained compositor state; it is not a texture-content generation number or a complete resource invalidation contract. Pass cache residency and source raster-resource residency are separate caches. [Render-pass cache fields][passinternal], [DirectRenderer `CanSkipRenderPass` and scissor logic][direct]

The `Aggregate` implementation contains a comment saying root damage restricts aggregated quads, but the inspected `CopyQuadsToPass` loop copies ordinary quads without a direct damage-intersection early exit. The current code **does** intersect pass damage with root damage. Do not claim from that comment alone that this revision necessarily omits undamaged quads. Capture before later occlusion/overlay mutation, dump full pass state, and independently verify complete replay across initial frame, no-damage frame, move, resize and reattachment. [Aggregation and damage code][aggregator], [Display occlusion call][display]

The source also explicitly ties full damage/redraw decisions to cached passes, copy requests, moving-pixel filters, changing merge state and expanded parent clips. A naive “empty damage means keep everything” remote rule can become incorrect after a lost resource or fresh client. Reconnection needs a complete current state and full redraw, irrespective of Chromium's latest damage. This is a protocol inference from the retained-state logic, not a measured failure of the proposed protocol. [SurfaceAggregator `RenderPassNeedsFullDamage` and `UpdateNeedsRedraw`][aggregator], [renderer backing checks][direct]

Enabling video capture/copy requests changes whether aggregation merges surface-root passes. Therefore simultaneously taking reference screenshots can perturb pass structure and allocations. Record whether capture is enabled and separate a screenshot comparison run from resource-churn measurements, or measure the perturbation. [SurfaceAggregator `EmitSurfaceContent`, `has_video_capture`][aggregator]

Protected textures and required overlays are not ordinary remotely readable resources. The aggregator can replace secure-output content with black for an insecure/copy-output path, and the Skia renderer has fallback behavior for content requiring overlays. The spike must report excluded protected/video cases rather than treating a black result as a missing compositor primitive. [Texture protection fields][texture], [SurfaceAggregator secure-output handling][aggregator], [Skia `RequiresOverlay` branch][skia]

## Smallest credible supported subset

This is a **proposed acceptance subset**, not a measured claim about common-site coverage:

| Component | Initial restriction | Explicit rejection / follow-up |
| --- | --- | --- |
| Materials | SolidColor, Tile, Texture, AggregatedRenderPass | Picture, SharedElement, Surface remaining after aggregation, DebugBorder, VideoHole, invalid/unknown |
| Geometry | Finite 2D affine transforms; first proof uses integer translation; explicit pass origins and cropped UVs | Nonzero 3D sorting contexts, perspective until a separate test passes |
| Shared state | Rectangular target clip, opacity, SrcOver, empty mask filter | Rounded/gradient masks and other blend modes |
| Pass reference | Acyclic dependency on an earlier pass, plain texture sampling | Foreground/backdrop filters, mask texture, arbitrary backdrop bounds, mipmap requirement |
| Raster | Fully readable single-plane canonical BGRA8 premultiplied sRGB | Raw-draw backing, unavailable/protected data, YUV/HDR until converted/tested |
| Texture extras | Explicit supported alpha/background/sampling behavior | force-rgbx, display masks and other non-default state unless implemented |
| Damage | Full redraw of every pass; retained raster-resource cache | Partial redraw and render-pass backing reuse until independently tested |

These restrictions follow from the actual fields and renderer branches, and keep the prototype honest about its visual domain. Start with a rasterized text/image tile that moves between frames while its bytes remain unchanged. Add clipped/opacity content and a nontrivial child pass separately. Then run deterministic OOPIF, fractional transform, rounded-corner, filter and blend-mode fixtures to measure which assumption breaks first. [Quad definitions][quad], [shared state][sqs], [pass quad][passquad], [Skia drawing branches][skia]

For each frame, count not only materials but also non-default blend modes, masks, filter types, sorting contexts, protected/video flags, source formats, texture-coordinate modes and raw-draw attempts. Log the **exact rejected field** with pass/quad/resource IDs. This is a recommended measurement design, not upstream functionality.

## Consequence for the architecture decision

Source inspection supports continuing with a small post-aggregation capture experiment. It does not establish a stable public Viz protocol, complete common-site rendering, practical readback cost, headless runtime reachability of the hook, or maintainable patch size. The strongest current warning is semantic scope: final composition still contains substantial Skia and display behavior, even after Blink paint and surface aggregation. Resource extraction and an independently reconstructed capture remain the gate before writing live transport.

[aggregator]: https://github.com/chromium/chromium/blob/507c6ee3e2f3b2ca0e660547e5b9ea4820c67f4c/components/viz/service/display/surface_aggregator.cc
[display]: https://github.com/chromium/chromium/blob/507c6ee3e2f3b2ca0e660547e5b9ea4820c67f4c/components/viz/service/display/display.cc#L819-L968
[direct]: https://github.com/chromium/chromium/blob/507c6ee3e2f3b2ca0e660547e5b9ea4820c67f4c/components/viz/service/display/direct_renderer.cc
[skia]: https://github.com/chromium/chromium/blob/507c6ee3e2f3b2ca0e660547e5b9ea4820c67f4c/components/viz/service/display/skia_renderer.cc
[quad]: https://github.com/chromium/chromium/blob/507c6ee3e2f3b2ca0e660547e5b9ea4820c67f4c/components/viz/common/quads/draw_quad.h
[sqs]: https://github.com/chromium/chromium/blob/507c6ee3e2f3b2ca0e660547e5b9ea4820c67f4c/components/viz/common/quads/shared_quad_state.h
[pass]: https://github.com/chromium/chromium/blob/507c6ee3e2f3b2ca0e660547e5b9ea4820c67f4c/components/viz/common/quads/aggregated_render_pass.h
[passquad]: https://github.com/chromium/chromium/blob/507c6ee3e2f3b2ca0e660547e5b9ea4820c67f4c/components/viz/common/quads/aggregated_render_pass_draw_quad.h
[passinternal]: https://github.com/chromium/chromium/blob/507c6ee3e2f3b2ca0e660547e5b9ea4820c67f4c/components/viz/common/quads/render_pass_internal.h
[frame]: https://github.com/chromium/chromium/blob/507c6ee3e2f3b2ca0e660547e5b9ea4820c67f4c/components/viz/service/display/aggregated_frame.h
[list]: https://github.com/chromium/chromium/blob/507c6ee3e2f3b2ca0e660547e5b9ea4820c67f4c/components/viz/common/quads/quad_list.h
[tile]: https://github.com/chromium/chromium/blob/507c6ee3e2f3b2ca0e660547e5b9ea4820c67f4c/components/viz/common/quads/tile_draw_quad.h
[texture]: https://github.com/chromium/chromium/blob/507c6ee3e2f3b2ca0e660547e5b9ea4820c67f4c/components/viz/common/quads/texture_draw_quad.h

## Diagnostic capture schema audit

The draft `server/chromium-patches/viz_remote_capture.h` was inspected against the same pinned revision. This is a source-level schema audit, not successful decoding of a captured frame. For the strict tile/solid/unmasked, unfiltered pass subset, **the existing trace helpers already expose the essential reconstruction fields**:

| Required state | Actual trace representation |
| --- | --- |
| Pass output geometry / clear behavior | `output_rect`, `has_transparent_background`; full-redraw replay can ignore damage/cache hints |
| Ordered quad and SQS lists | `quad_list` plus `shared_quad_state_list`; each quad's `shared_quad_state.index` links them |
| Transform | `quad_to_target_transform`: 16 numeric values, **row-major** |
| Crop and clipping | Quad `rect` / `visible_rect`, optional SQS `clip_rect` |
| Basic compositing | `needs_blending`, `are_contents_opaque`, SQS `opacity`, string `blend_mode`, `sorting_context_id` |
| Tile sampling | `tex_coord_rect` in pixel coordinates, `nearest_neighbor`, `force_anti_aliasing_off`; SQS `quad_layer_rect` provides tile edge context |
| Solid color | `color` string plus `force_anti_aliasing_off` |
| Child pass reference | Pass `id` and quad `render_pass_id.id_ref`; unmasked pass quads have no valid base `resource_id` |
| Subset rejection | Pass-quad `filters`/`backdrop_filters`, optional backdrop bounds, mipmap flag; masks currently a diagnostic string |

Sources: [`RenderPassInternal::AsValueInto`](https://github.com/chromium/chromium/blob/507c6ee3e2f3b2ca0e660547e5b9ea4820c67f4c/components/viz/common/quads/render_pass_internal.cc#L110-L151), [`DrawQuad::AsValueInto`](https://github.com/chromium/chromium/blob/507c6ee3e2f3b2ca0e660547e5b9ea4820c67f4c/components/viz/common/quads/draw_quad.cc#L46-L83), [`SharedQuadState::AsValueInto`](https://github.com/chromium/chromium/blob/507c6ee3e2f3b2ca0e660547e5b9ea4820c67f4c/components/viz/common/quads/shared_quad_state.cc#L87-L108), [`ContentDrawQuadBase::ExtendValue`](https://github.com/chromium/chromium/blob/507c6ee3e2f3b2ca0e660547e5b9ea4820c67f4c/components/viz/common/quads/content_draw_quad_base.cc#L47-L52), [`MathUtil` matrix serialization](https://github.com/chromium/chromium/blob/507c6ee3e2f3b2ca0e660547e5b9ea4820c67f4c/cc/base/math_util.cc#L953-L961).

There are three concrete serialization improvements worth making before relying on the dump for replay:

1. **Add numeric `solid_color_rgba` (and texture background RGBA if texture support is admitted).** The upstream color helper writes six-decimal `%f` values into a diagnostic string and omits the closing parenthesis. A pinned decoder can parse it for simple colors, but it is not a lossless `SkColor4f` representation. It also uses float color components rather than CSS-style integer RGB. [`SolidColorDrawQuad::ExtendValue`](https://github.com/chromium/chromium/blob/507c6ee3e2f3b2ca0e660547e5b9ea4820c67f4c/components/viz/common/quads/solid_color_draw_quad.cc#L51-L55), [`SkColor4fToRgbaString`](https://github.com/chromium/chromium/blob/507c6ee3e2f3b2ca0e660547e5b9ea4820c67f4c/ui/gfx/color_utils.cc#L701-L703).
2. **Add a Boolean `mask_filter_is_empty` per SQS.** Strict-subset admission currently must interpret `mask_filter_info.ToString()`. An explicit predicate derived from `IsEmpty()` reliably says whether the client may omit that effect. This avoids implementing diagnostic-string parsing merely to reject masks. A structured mask payload is unnecessary while all nonempty masks are rejected. [`SQS diagnostic mask field`](https://github.com/chromium/chromium/blob/507c6ee3e2f3b2ca0e660547e5b9ea4820c67f4c/components/viz/common/quads/shared_quad_state.cc#L87-L108), [`MaskFilterInfo::ToString`](https://github.com/chromium/chromium/blob/507c6ee3e2f3b2ca0e660547e5b9ea4820c67f4c/ui/gfx/geometry/mask_filter_info.cc#L65-L78).
3. **Prefer explicit unsigned resource IDs as strings for quad links.** Trace `DrawQuad.resource_id` is the actual ID when the mapping is empty, but it is cast to a signed `int`. The draft resource table already uses unsigned decimal strings. A decoder can recover the value using uint32 conversion; an explicit matching string removes that mismatch. This is a representation caveat rather than absent information in a short run. [`ResourceIdIndex`](https://github.com/chromium/chromium/blob/507c6ee3e2f3b2ca0e660547e5b9ea4820c67f4c/components/viz/common/quads/draw_quad.cc#L71-L83), [`AggregatedRenderPass` empty mapping](https://github.com/chromium/chromium/blob/507c6ee3e2f3b2ca0e660547e5b9ea4820c67f4c/components/viz/common/quads/aggregated_render_pass.cc#L218-L238).

Pass links are recoverable without adding fields: the pass ID has form `AggregatedRenderPass/0x123`, while a reference is `{"id_ref":"0x123"}`. Normalize the prefix. The snapshot helper does not gate emission on whether its trace category is enabled; it simply writes the category and ID. [`viz::TracedValue` helpers](https://github.com/chromium/chromium/blob/507c6ee3e2f3b2ca0e660547e5b9ea4820c67f4c/components/viz/common/traced_value.cc#L20-L42).

The captured resource table supplies dimensions, row bytes, generation and filename, so tile bytes can be resolved through each quad's ID. One separate cache correctness caveat in the draft: generation comparison checks pixel bytes but not dimensions. Equal byte vectors with a different width/height must still trigger a new texture generation or explicit reallocation; the dimensions are already serialized, so this needs a cache-key adjustment rather than a new field.

No additional general filter/path serializer is needed to establish the proposed strict-subset proof. Reject nonempty foreground/backdrop filters, nonzero sorting contexts, nonempty mask state, non-SrcOver blending, unsupported materials and mipmap-dependent passes, and replay every admitted pass fully. A successful decode under those restrictions must not be described as lossless replay of all trace JSON.

## Offline client audit corrections

A subsequent read-only audit found three concrete mismatches in the first Metal decoder. The client now fixes the first two and explicitly rejects the third:

- Plain pass quads sample a pixel rectangle starting at zero with the consuming quad's size. They do not necessarily stretch the entire child backing into that quad. The fix normalizes that pixel extent by the backing dimensions, then applies visible-rectangle cropping. [Pass coordinate helper](https://github.com/chromium/chromium/blob/507c6ee3e2f3b2ca0e660547e5b9ea4820c67f4c/components/viz/common/quads/aggregated_render_pass_draw_quad.h#L68), [software pass sampling](https://github.com/chromium/chromium/blob/507c6ee3e2f3b2ca0e660547e5b9ea4820c67f4c/components/viz/service/display/software_renderer.cc#L546-L590).
- In the admitted unmasked/SrcOver subset, `needs_blending || opacity < 1` selects blending; otherwise Chromium replaces with Src. The client now has both Metal pipeline states. [Blending predicate](https://github.com/chromium/chromium/blob/507c6ee3e2f3b2ca0e660547e5b9ea4820c67f4c/components/viz/common/quads/draw_quad.h#L87-L94), [software blend setup](https://github.com/chromium/chromium/blob/507c6ee3e2f3b2ca0e660547e5b9ea4820c67f4c/components/viz/service/display/software_renderer.cc#L313-L318).
- Software tile sampling constrains filtering to the source subrectangle. Clamping a Metal sampler only to the whole texture can bleed neighboring pixels when a tile subrectangle is scaled. The first proof now admits only integral one-to-one tile sampling. [Strict source sampling](https://github.com/chromium/chromium/blob/507c6ee3e2f3b2ca0e660547e5b9ea4820c67f4c/components/viz/service/display/software_renderer.cc#L505-L515).

The software reference also quantizes tile/pass opacity using eight-bit `setAlpha`; solid colors use `setAlphaf`. The Metal decoder retains floating opacity. This is a known small image-comparison difference to measure, not a resource-reuse failure. [Opacity setup](https://github.com/chromium/chromium/blob/507c6ee3e2f3b2ca0e660547e5b9ea4820c67f4c/components/viz/service/display/software_renderer.cc#L313-L318), [solid color alpha](https://github.com/chromium/chromium/blob/507c6ee3e2f3b2ca0e660547e5b9ea4820c67f4c/components/viz/service/display/software_renderer.cc#L433-L437).

Synthetic GPU pixel checks now cover the first two corrections, and an unsupported scaled tile is rejected without writing an output image. No actual Chromium frame had been replayed at the time of this audit.
