# Reducing lossless Retina Browser latency

Research date: 2026-09-15. WVE-79. Baseline: `4707e615`, CEF 152.0.6 / Chromium 152.0.7977.83, LibVNC 0.9.15. This is source research and analysis of the existing Mac measurements; it does not claim a new optimization has been implemented or measured. The interaction pass may change the baseline before the next runs.

Keep the accepted 2× lossless image, upstream Chromium, native Mac/iPad display, Host ownership, and audio disabled. The best first target is work that blocks CEF's main loop; the next substantial target is native image submission. Neither requires a new remoting protocol. Do not begin by weakening authorization or lowering image quality.

## What the existing evidence establishes

The [Retina report](retina-rendering.md) contains sequential 20-second Mac loopback runs at the same logical viewport. They measure software input capture to native layer submission, **not photons, display scanout, or iPad latency**. The [2× summary](evidence/mac-retina-20260915/2x-summary.json) reports:

| Measurement | Existing 2× result | Interpretation |
| --- | ---: | --- |
| Physical image | 2298 × 1702 | About 15.65 MB of BGRA pixels per complete image |
| Distinct scrolling cadence | 22.2 FPS | Below the 60-FPS goal |
| Input to native layer | 188.7 ms median; 209.6 ms p95 | End-to-end software marker result for the initial forward segment |
| Client input queue | 17.8 ms median | Queueing exists despite bounded wheel coalescing |
| Input RPC | 23.2 ms median | Completion includes the Host/native boundary |
| Portal authorization | 0.057 ms median; 0.130 ms p95 | Too small to be the first optimization target |
| Portal page lookup | 0.392 ms median | Also comparatively small |
| Native request interval labelled `cdp` | 22.5 ms median | Includes dispatch through the managed runtime; human wheel is already native CEF input, so this label does not establish a CDP wheel bottleneck |
| CEF paint cadence | 24.1 FPS mean | The stream is not receiving 60 fresh images |
| RFB pump time | 660.8 ms per second, mean | Substantial time on the same thread that pumps CEF |
| Worst RFB pump in each interval | 34.4 ms median | Already exceeds a 16.7-ms frame interval |
| Native full-image copy | 1.35 ms median | Real, but less than layer submission |
| Native main queue wait | 0.017 ms median | No evidence of a large dispatch backlog in this run |
| Native submission interval | 12.99 ms median; 17.39 ms p95 | Includes image creation, layer assignment/transaction, and release; not GPU execution or scanout |
| Decode CPU | 14.8% of one core | Not enough evidence to name decoding the dominant bottleneck |
| RFB stream | 43.2 Mbps | Compressed traffic, not the amount of pixel copying |

These are different overlapping intervals and populations. Do not sum their medians into a latency budget, or assume the 189-ms result falls to a particular number when one interval is removed. The 1× run reached 37.5 FPS and 111-ms median; 1.5× was worse than either run. Repeated paired runs are needed before attributing causation.

## Current pipeline and the first bottleneck hypothesis

[CEF Host](../../../product/portal/native/browser/cef-host.cc) explicitly disables GPU and GPU compositing. Its loop calls `CefDoMessageLoopWork`, reads/dispatches control commands, processes each page's RFB clients, and sleeps for 1 ms. `OnPaint` copies dirty pixels into LibVNC's framebuffer. `rfbProcessEvents(screen, 0)` runs synchronously; zero means no initial event wait, not zero encoding/socket work. LibVNC's implementation iterates clients and generates their framebuffer updates from this call. [LibVNC event loop source](https://github.com/LibVNC/libvncserver/blob/LibVNCServer-0.9.15/src/libvncserver/main.c)

**Hypothesis:** synchronous RFB compression/output delays both CEF scheduling and incoming input, which can explain lower paint cadence and longer native command completion at 2×. Slow passive viewers may also delay the active viewer or another page in the same Profile process. The current pump timer does not separate compression, pixel translation, and socket blocking, so a time profile is required before choosing threading or another encoder.

## Ranked experiments

### 1. Separate compression cost from CEF scheduling

Add bounded timings around command dispatch, CEF work, paint copy, RFB encoding/output, and native response emission. Capture a native Time Profiler trace during the existing fixture, first with one viewer and then a slow second viewer. Use opt-in timings and fixture IDs; avoid collecting webpage text, URLs, or clipboard contents in performance traces.

The smallest diagnostic comparison is negotiated `zrle`, `hextile`, and `raw` at identical 2× geometry. Verify the actual negotiated encoding. A raw full image at 60 FPS would require about **7.51 Gbps** before framing; raw is primarily a diagnostic or high-capacity local-link candidate. Dirty updates can be much smaller. Hextile may spend less time compressing and more bandwidth; that tradeoff must be measured on iPad Wi-Fi as well as Mac loopback.

There is an important stock-library limitation: pinned ZRLE initializes zlib with `Z_DEFAULT_COMPRESSION`; a client compression-level preference is not automatically a ZRLE tuning knob. Do not record a level-1 experiment without proving that the encoder uses it. [Pinned ZRLE stream implementation](https://github.com/LibVNC/libvncserver/blob/LibVNCServer-0.9.15/src/libvncserver/zrleoutstream.c)

If encoding/output dominates, evaluate LibVNC's supported background loop first. Its threading facilities, modified-region locks, resize handling, and shutdown paths are available upstream. They do not make arbitrary writes to the framebuffer safe. Audit ownership and locks before enabling them. Holding a framebuffer lock for an entire compression/send operation would simply transfer the stall back to `OnPaint`. [LibVNC API introduction](https://libvnc.github.io/doc/html/libvncserver_doc.html), [thread and resize implementation](https://github.com/LibVNC/libvncserver/blob/LibVNCServer-0.9.15/src/libvncserver/main.c)

If the stock loop cannot protect CEF with acceptably little adapter code, a bounded worker owning the RFB screen is the fallback: copy/merge dirty data into owned staging memory and let CEF continue. Keep at most the newest unencoded state with the union of dirty regions. This is an experiment design, not a recommendation to add a general frame scheduler. Never drop bytes or arbitrary encoded rectangles from a stateful RFB/zlib stream.

### 2. Remove native image-allocation/submission overhead

[WeaveBrowserSurface](../../../product/alpha/native/browser/WeaveBrowserSurface.mm) retains one decoded framebuffer, makes an immutable full-frame `NSData` copy per completed update, creates a new `CGImage`, and assigns it to `CALayer.contents`. It already coalesces pending main-queue presentations and disables implicit layer animations. It does not currently time actual presentation.

Start by splitting the existing 13-ms submission interval into provider/image creation, layer assignment, transaction commit, and releases. Cache immutable color-space state as a small cleanup, but do not assume that explains 13 ms. Compare the current path with one narrow reusable Metal texture/staging-buffer presenter shared by Mac and iPad. Retain the decoder and ordinary RFB protocol; use BGRA with a verified sRGB/color-management path and exact pixel alignment. Keep a stable decoder framebuffer initially, then upload dirty regions through the upstream update callback. If presentation is skipped, retain all dirty regions since the last submitted image.

Apple supports textures backed by an `IOSurface` or `MTLBuffer`, allowing reusable storage. That makes a native staging/presentation experiment possible; it does not make compressed network pixels zero-copy. Reusing memory while a GPU still reads it is incorrect. Use a small bounded resource pool and completion ownership, following Apple's cross-platform example. [Metal texture storage](https://developer.apple.com/documentation/metal/mtltexture), [CPU/GPU synchronization sample](https://developer.apple.com/documentation/metal/synchronizing-cpu-and-gpu-work)

Compare two and three drawable slots and retain only the newest pending image. More buffering can raise throughput while increasing frame age. Avoid waiting for a drawable on the UI thread: `nextDrawable` can wait, and disabling its timeout can make that indefinite. [Drawable timeout API](https://developer.apple.com/documentation/quartzcore/cametallayer/allowsnextdrawabletimeout)

Where supported by deployment targets, evaluate `CAMetalDisplayLink` with `preferredFrameLatency = 1`. Apple permits values 1 or 2 and explicitly does not guarantee the final latency equals the preference. A display link is a presentation deadline mechanism, not a reason to hold fresh network frames for an extra timer period. Record `MTLDrawable.presentedTime`/presentation callbacks in the experiment; the timestamp is a closer software endpoint than layer assignment, and a zero value can indicate a dropped frame. [Frame latency preference](https://developer.apple.com/documentation/quartzcore/cametaldisplaylink/preferredframelatency), [presentation timestamp](https://developer.apple.com/documentation/metal/mtldrawable/presentedtime)

### 3. Let CEF schedule itself; test GPU with the existing CPU callback

The native adapter is a standalone CEF application. `CefRunMessageLoop` is therefore a stronger stock-API candidate than maintaining a polling loop indefinitely. Move control arrival onto scheduled CEF tasks, keep rendering calls on the required thread, and keep RFB work out of that loop. If an external loop remains necessary, use `external_message_pump` and `OnScheduleMessagePumpWork` rather than an unconditional 1-ms polling interval. CEF itself recommends these APIs. Thread affinity and clean shutdown remain requirements; do not assume the Windows/Linux multithreaded-loop option applies on Mac. [Pinned CEF message-loop contract](https://github.com/chromiumembedded/cef/blob/708dc14/include/cef_app.h), [pump callback contract](https://github.com/chromiumembedded/cef/blob/708dc14/include/cef_browser_process_handler.h)

Separately compare the current forced-software mode with GPU enabled while retaining the ordinary `OnPaint` CPU buffer. This has less maintenance cost than adopting accelerated texture callbacks immediately. `OnPaint` and `OnAcceleratedPaint` are selected by the shared-texture setting; a CPU pixel callback should not be conflated with a requirement to disable all browser GPU work. Confirm actual GPU feature status, WebGL behavior, screenshot fidelity, and crash-free startup in the packaged sandboxed app. Linux's headless Ozone/GPU availability needs separate proof. [Pinned rendering API](https://github.com/chromiumembedded/cef/blob/708dc14/include/cef_render_handler.h)

Treat accelerated OSR as a later branch if GPU-enabled `OnPaint` still shows expensive readback. CEF exposes an IOSurface on Mac and native-buffer planes on Linux, but the callback's handle is transient: it cannot be cached or used after callback return. The application must copy into owned resources. RFB still needs CPU-addressable exact pixels for its current encoders. The proposed benefit is better producer scheduling/readback overlap; there is no evidence yet that it outweighs the platform-specific glue. [Accelerated paint ownership](https://github.com/chromiumembedded/cef/blob/708dc14/include/cef_render_handler.h)

### 4. Reduce avoidable request/response waits on real links

The native LibVNC client sends its next incremental framebuffer request **before** calling `FinishedFrameBufferUpdate`. Moving image submission after that callback does not newly enable this overlap. It still sends the request after decoding the prior update. Upstream recommends continuously requesting updates for high-latency links, but states that the `ContinuousUpdates` extension is not supported by LibVNC. This is not an available switch in our pinned stack. [Pinned client update completion](https://github.com/LibVNC/libvncserver/blob/LibVNCServer-0.9.15/src/libvncclient/rfbclient.c), [upstream latency guidance](https://github.com/LibVNC/libvncserver/blob/master/README.md#tackling-high-latency)

A bounded early/pipelined standard incremental-request experiment is preferable to implementing the extension. Keep LibVNC socket writes serialized; do not call a client object concurrently from arbitrary timer threads. Verify backpressure and resize transitions, and avoid a fixed stream of requests when nothing changes. RFB allows multiple requests to be satisfied by one update, so request count is not a frame-credit count. [RFB update/request semantics](https://github.com/rfbproto/rfbproto/blob/master/rfbproto.rst#framebufferupdaterequest)

The input connection also awaits each RPC, preserving order and bounding queued wheel work. After fixing CEF stalls, measure how much real network RTT remains in that serialization. A small bounded window of ordered input can overlap replies; it must not reorder click/key boundaries, wheel direction changes, focus changes, or viewport changes. Preserve per-message session, view, generation, and focus-epoch validation at dispatch time. Preserve revocation checks after asynchronous work. Keep display-only RFB sockets unable to grant input. Do not optimize authorization based on the current sub-millisecond measurements. [Product input queue](../../../product/alpha/src/browser/browser-view-connection.ts), [Host ownership and authorization](../../../product/portal/src/browser-pages.ts)

Measure WebSocket message availability, socket-buffer backpressure, Portal relay queue age, and RTT before replacing the transport or increasing buffers. Large buffers can conceal an accumulating old-image backlog. An iPad run on the actual LAN/VPN is essential: loopback does not establish a network latency floor.

## Approaches to defer

- **CopyRect from guessed scroll offsets:** Chromium dirty rectangles identify changed pixels, not guaranteed pixel motion. Sticky elements, overlays, nested scrolling, and effects can invalidate a translated rectangle. It requires an exact pixel-validation mechanism or an authoritative producer signal before use, adding maintenance. Keep stock lossless encodings first. [CEF dirty-rectangle contract](https://github.com/chromiumembedded/cef/blob/708dc14/include/cef_render_handler.h), [RFB CopyRect](https://github.com/rfbproto/rfbproto/blob/master/rfbproto.rst#copyrect)
- **Client-side predicted scrolling:** it can display the wrong state for canceled/nested/custom wheel handlers and requires reconciliation. Keep real Chromium input semantics.
- **Shared IOSurface across Host and client:** useful only across local process boundaries; it cannot eliminate the remote decode step for an iPad or remote Mac. A separate local fast path would add another behavior to maintain.
- **Lossy encoding, reduced color depth, or density drops:** these change the accepted quality target and are not the present latency pass.
- **External begin-frame control or a new codec/protocol:** no current evidence justifies owning another scheduler or decoder.

## Measurement and acceptance plan

1. Freeze a post-interaction build and collect three baseline runs per condition on Mac and iPad. Record device model/OS, source and runtime identity, physical and logical viewport, actual network route/RTT, power/thermal state, and one versus two viewers. Use an isolated fixture/profile, preserving personal pages and credentials.
2. Run one change at a time, then a paired baseline again: encoder isolation, native presenter, CEF scheduling/GPU mode, and request overlap. Prioritize the measured dominant stage rather than automatically implementing every experiment.
3. Report median/p95 input-to-layer (or drawable-presented), distinct-content intervals, oldest pending frame age, CEF paint cadence, encoder/decode CPU, memory, and Mbps. Compare a dense scrolling fixture, static text/selection, nested canceled wheel input, and representative development content. Higher FPS with older frames is not a latency win.
4. Verify exact RFB pixels against the current CEF screenshot at 2×, scale-only focus transfer, popup surfaces, selection/copy, overlays, reconnect, slow passive viewers, stale input rejection, and revocation. GPU rasterization may produce different antialiasing than software; transport fidelity is checked against the active producer, and perceived text quality still needs review.
5. Keep a candidate only when repeated results improve latency without losing displacement, freshness, fidelity, or security/lifetime behavior. A 60-FPS budget is 16.7 ms between distinct images, not a promise of 16.7-ms network input latency. Confirm apparent responsiveness on the installed Mac and physical iPad; use external high-frame-rate capture if a photon-level claim is needed.

The first likely implementation decision is whether stock LibVNC threading or a small owned handoff can isolate its measured long pump calls. The native presenter is the next well-supported experiment. GPU/CEF loop improvements and network request overlap then address the remaining measured costs. These rankings can change after the new Mac/iPad profiles; no performance guarantee is implied.

## Follow-up: native profiles narrow the expensive work

A later Mac 2× run owned by the interaction/profile pass is available at `/tmp/weave-browser-scroll-7GtEcv`; its summary and native sampling files were read for this addendum. It reports 28.2 distinct FPS, 191.1-ms median input-to-layer, about 650 ms/sec in the RFB pump, and 9.62-ms median native submission. This is a fresh baseline with work in progress, not an isolated optimization result. The delivery report should retain its exact build identity and permanent evidence paths.

The CEF stack sample contains 5,057 samples below `rfbProcessEvents`, including 4,233 under `rfbSendRectEncodingZRLE` with zlib `deflate` descendants. The Alpha stack contains 2,144 samples under `CA::Render::copy_image`, including 1,542 below `vImageConverterConvert` and transfer-curve (`DoTRCs`) processing. Sample counts are overlapping stack populations, not additive durations. They reinforce compression isolation and show that native submission includes expensive color conversion, rather than merely a full-image memcpy.

Before writing a Metal presenter, inspect actual `CALayer.contentsFormat` on both devices and compare an explicit `kCAContentsFormatRGBA8Uint` hint. Apple says this is the default but UIKit/AppKit may replace it. It is a cheap bounded experiment, not a promised way to avoid color conversion. Keep the image's explicit sRGB tag; declaring the same bytes DeviceRGB or removing color matching would change the quality contract. [Layer format contract](https://developer.apple.com/documentation/quartzcore/calayer/contentsformat)

If the conversion remains expensive, test reusable Metal/IOSurface-backed storage with an explicit sRGB `CAMetalLayer.colorspace`. Apple documents that a nil layer color space disables color matching. `BGRA8Unorm_sRGB` performs sRGB/linear conversion for texture operations; the shader and output configuration must agree so that the pipeline neither double-decodes nor omits transfer conversion. Preserve the source's sRGB byte interpretation and compare both decoded bytes and rendered output on Mac and iPad. A GPU presentation path may relocate conversion work, but color-managed composition still exists and must remain correct. [Metal layer color space](https://developer.apple.com/documentation/quartzcore/cametallayer/colorspace), [sRGB pixel format](https://developer.apple.com/documentation/metal/mtlpixelformat/bgra8unorm_srgb)

## Product boundary for this pass

The user authorized research and profiling after the interaction work. Diagnostic flags compare stock APIs without changing installed defaults: `WEAVE_BROWSER_GPU=1` enables CEF's ordinary GPU-backed `OnPaint` path only when diagnostics are enabled; `WEAVE_BROWSER_RFB_ENCODING=hextile|raw` selects an existing lossless decoder preference. These are experiments, not adopted performance fixes. Final measurements and their limits are recorded in [the profiling report](interaction-latency-profile.md).

The fresh native report identifies the existing layer format as `RGBA8`. Explicitly requesting the same format is therefore not a promising change for this build; the color-conversion cost remains despite that format.
