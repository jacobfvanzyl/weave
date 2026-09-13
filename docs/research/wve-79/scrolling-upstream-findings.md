# Lossless Browser scrolling toward 60 FPS

WVE-79 · 2026-09-13 · Research and proposed experiments, not implemented performance claims.

Baseline implementation: commit `b892f1fc` (native Browser Panes, unified pane types, experiments and acceptance evidence). The full repository check passed before that commit. This plan does not claim that any new scrolling optimization below has been implemented.

Start with the Mac input path and Host scheduling. They contain avoidable serialized work, whereas the existing evidence does not justify replacing native Core Animation presentation with Metal. Keep CEF and LibVNC upstream, the existing lossless pixel format, Profile authorization and focus epochs. **The iPad is currently in use: do not inspect, restart, install or run tests on it.** Initial profiling and candidate changes should use the Mac; physical iPad acceptance resumes only when the user makes it available.

## What the current implementation establishes

| Finding | Evidence | Implication |
| --- | --- | --- |
| Every wheel/pointer delta enters one client promise queue and waits for the complete RPC response before the next operation starts. The queue permits 64 pending operations. | [BrowserViewConnection](../../../product/alpha/src/browser/browser-view-connection.ts), `enqueue` and `input` | Input throughput can be limited by an entire round trip plus Host work per delta. This is a confirmed dependency, not a measurement of its present cost. |
| Every input is also ordered per page on Portal. Before CDP dispatch it performs two authorization passes and a Browser Service `page.list`. Each authorization pass calls `assertActive` directly, then `authorize`, which calls `assertActive` again. Each `assertActive` rereads and parses the security state JSON. | [Browser access](../../../product/portal/src/browser-pages.ts), [security](../../../product/portal/src/security.ts), `#reload` | Four credential-file reads/parses per input are redundant work worth measuring. Preserve revalidation around asynchronous state changes; deleting all checks or using an arbitrary long cache would weaken revocation. |
| Page listing reads an in-memory catalog after initial loading, but crosses Browser Service IPC and the catalog ordering queue. CDP dispatch crosses another service/native boundary. | [Managed page catalog](../../../product/portal/src/browser-service/managed-pages.ts) | Do not claim that every input rereads the page catalog from disk. The confirmed repeated disk work is the security state. |
| iPad dragging is currently translated to mouse-wheel deltas, ending when the finger lifts. Mac DOM wheel events pass raw deltas through without normalizing `deltaMode`. | [Native Browser input](../../../product/alpha/src/components/native-browser-view.tsx) | Cadence and gesture semantics are separate problems. A smoother stream alone does not add natural touch momentum or fix units. |
| CEF paints and `rfbProcessEvents` execute on the same loop, followed by a 1 ms sleep. GPU and GPU compositing are disabled. The paint cap is already 60; RFB defer time is already zero. | [CEF Host](../../../product/portal/native/browser/cef-host.cc) | Encoding or socket writes can delay Chromium work. Raising the cap or removing a now-absent defer timer is not a new fix. |
| The native client already keeps only the latest pending presentation, disables implicit layer animations, and sends shell callbacks only on initial dimensions/resize. | [Native surface](../../../product/alpha/native/browser/WeaveBrowserSurface.mm) | Retain these improvements. A display-link clock can improve pacing but cannot invent missing browser frames. |

The previous isolated iPad experiment measured roughly 2.0–2.2 ms per full-frame copy, less than 0.2 ms main-queue p95, and less than 0.6 ms mean submission cost. Turning presentation off still achieved only 16.8 decoded updates/s on that route. Repeated controls varied considerably and TCP retransmissions were observed. These are older Linux-to-iPad benchmark results, not a current product profile. They argue against assuming that the native drawing API is the main bottleneck. [Experiment and raw evidence](../../../experiments/browser-remoting-comparison/rfb-ipad-optimization.md)

## Proposed sequence and decision gates

### 1. Establish a reproducible Mac baseline

Use the installed integration path with an isolated test Workspace/Profile and deterministic long pages: text with a sticky header, nested overflow panels, a code-heavy page, and mixed image/text content. Record the current viewport and pixel dimensions explicitly. Begin at DPR 1, then repeat a representative higher pixel count; do not silently reduce resolution to meet the goal.

Run three interleaved baseline/candidate repetitions of 60 seconds of active scrolling, after warm-up. Use both real trackpad input and scripted scroll input; the script isolates rendering but cannot establish human gesture feel. Include a page-driven animation run with no client input to distinguish input starvation from pixel throughput. Keep an idle/viewer-disconnect phase and a second passive Mac viewer to expose cross-viewer blocking.

Instrument monotonic durations at: event capture, client queue wait, RPC acknowledgment, Portal queue/authorization/page lookup/CDP completion, CEF paint interval/dirty area, RFB pump duration/encoded bytes, native socket wait/decode CPU, framebuffer copy and display submission. Do not subtract clocks on different Hosts without explicit synchronization. CDP acknowledgment is not visual response. Use a visible sequence marker for event-to-visible-content checks and an external high-speed recording when claiming physical input-to-photon latency.

Proposed targets, to be evaluated per route and viewport:

- At least 57 **distinct presented content updates/s** on the simple animation and scrolling corpus for each 60-second run, with presentation interval p95 at most 25 ms and p99 at most 50 ms. A 60 Hz callback counter does not satisfy this target.
- At least 30% lower p95 input-to-visible-response than baseline; aim for p50 at most 50 ms and p95 at most 80 ms on a healthy direct LAN. Report VPN results separately.
- No accumulating input backlog during sustained motion, no delayed tail of queued motion after the gesture ends, and no skipped button/key transitions. Test focus handoff, reflow, cancellation and revocation while scrolling.
- Zero differing pixels on deterministic settled checkpoints and preserved sharp text. Record bitrate, CPU and memory alongside latency; reject changes that merely trade a short smooth sample for unbounded queues or sustained resource growth.

These thresholds are proposed acceptance criteria, not measurements or a guarantee of 60 FPS on every page/network.

### 2. Remove input backlog before adding a new transport

First normalize wheel units and coalesce adjacent wheel deltas for the same gesture, page, focus epoch, modifier state and target location. Preserve total displacement within each compatible segment; never merge across focus/resize, button/key boundaries or target changes, and never use “latest delta wins,” which loses movement. Keep the first delta prompt and a bounded pending accumulator, rather than one queued RPC per hardware event. Initially retain one in-flight command so ordering remains simple.

Then remove the duplicate `assertActive` inside each authorization pass, and measure the remaining security reads. Replace `page.list` on every input with a generation-scoped lookup owned by the Browser Service, if profiling supports it. Any shared authorization snapshot needs explicit invalidation for grant changes, expiry, rotation and external credential-store writes; preserve fail-closed behavior across awaits and test revocation races.

If the measured RPC round trip still limits throughput below the target, use bounded ordered input batches over the existing authenticated connection, with sequence/epoch checks and cumulative acknowledgments. Keep focus/resize as barriers. Only investigate a dedicated input stream if batching remains inadequate. Never send unrestricted CDP or unauthenticated RFB input to bypass Portal's control authority.

For later iPad work, evaluate real touch start/move/end/cancel via the standard CDP `Input.dispatchTouchEvent` or CEF `SendTouchEvent`, with Chromium owning page hit testing and gesture behavior. Verify touch scrolling and momentum against the pinned runtime before adoption. Avoid implementing a second scrolling engine or translating the screenshot locally: nested scrollers, fixed elements and page event handlers make that behavior difficult to keep correct. CDP also exposes synthetic scroll gestures, useful for benchmarks, but these are not a replacement for faithfully forwarding human touch. [CDP Input definitions](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/Input.pdl), [CEF browser input API at the pinned revision](https://github.com/chromiumembedded/cef/blob/708dc14/include/cef_browser.h)

AppKit exposes precise scrolling deltas and momentum phases if DOM events prove insufficient. Prefer its existing event semantics over custom inertia curves. That is a small native input adapter to evaluate after measuring the common queue; it does not require a new renderer. [Apple precise deltas](https://developer.apple.com/documentation/appkit/nsevent/hasprecisescrollingdeltas), [Apple momentum phase](https://developer.apple.com/documentation/appkit/nsevent/momentumphase)

### 3. Keep RFB work from stalling the Host

Profile `rfbProcessEvents`: the pinned implementation calls `rfbUpdateClient`, which can send an update synchronously. If this consumes a material part of the 16.7 ms budget or a slow viewer stalls other pages, give RFB a worker-owned framebuffer and bounded paint handoff. Use upstream synchronization/background-loop facilities where suitable; do not merely turn on threading while `OnPaint` and resize still mutate the same buffer unsafely. Preserve dirty-region merging and apply only complete generations. Drop obsolete pending snapshots before encoding; never discard arbitrary bytes or rectangles from an already encoded stateful RFB stream. [Pinned LibVNC event/update implementation](https://github.com/LibVNC/libvncserver/blob/LibVNCServer-0.9.15/src/libvncserver/main.c)

If paint production itself remains below target after removing that contention, A/B upstream GPU-enabled CEF with the existing CPU `OnPaint` path. Retain the sandbox and software fallback and validate macOS and Linux separately. The existing 60 setting is a maximum, not a promised output rate. Prefer CEF's supported message-pump scheduling callback over adding a bespoke frame scheduler. External BeginFrame is public, but increases scheduling responsibility; it is a later experiment only if normal upstream scheduling is measured to be the limiting stage. [Pinned frame-rate contract](https://github.com/chromiumembedded/cef/blob/708dc14/include/internal/cef_types.h), [CEF scheduling callback](https://github.com/chromiumembedded/cef/blob/708dc14/include/cef_browser_process_handler.h)

### 4. Tune lossless transport only where the measurements point

Benchmark the already-supported ZRLE, Hextile and Raw encodings on the same corpus and route, recording bytes and encoder/decoder CPU. Raw is a high-bandwidth diagnostic; it is not an acceptable blanket optimization. Try other upstream lossless encodings only as a bounded library/build option with independent pixel checks. In 0.9.15, Tight decoding is compiled behind JPEG support, which this build disables; “enable Tight” is not just changing an encoding string. If explored, explicitly disable JPEG transmission and prove exact output. [Pinned client encoding negotiation/decoder](https://github.com/LibVNC/libvncserver/blob/LibVNCServer-0.9.15/src/libvncclient/rfbclient.c)

The client already sends its next incremental request before the finished-update callback. It still waits for the previous update to be decoded first. Extra requests are an experiment only if traces show request-wait idle gaps: RFB permits one update to satisfy several outstanding requests, so a timer that sends 60 requests/s does not guarantee 60 updates/s. [RFB demand-driven updates](https://www.rfc-editor.org/rfc/rfc6143.html#section-3)

ContinuousUpdates is a documented extension requiring negotiation on both ends; source inspection of the pinned LibVNC 0.9.15 client/server found no implementation. It is not an existing switch in this stack. Do not add a private fork for it during the first pass. Revisit an upstream library upgrade or another maintained implementation only if request pacing is a proven residual bottleneck. [ContinuousUpdates specification](https://github.com/rfbproto/rfbproto/blob/master/rfbproto.rst#747-enablecontinuousupdates)

Record the actual direct/VPN route and retransmissions when network stalls occur. The prior TCP_SENDMOREACKS experiment did not establish a reliable gain; do not repeat it as a default setting or infer that TCP_NODELAY is missing. Apple socket behavior and the product's WebSocket transport differ from the earlier direct-socket benchmark.

### 5. Native presentation, then deferred iPad acceptance

If main-thread pacing still shows visible jitter once frames arrive quickly enough, consume the newest complete snapshot using `CADisplayLink`/the supported AppKit display-link API. Keep memory bounded and callbacks in an appropriate run-loop mode. Request 60 Hz where supported, pause when inactive, and measure content updates separately from display ticks. Apple documents the requested rate as a preference affected by hardware/system conditions. [CADisplayLink](https://developer.apple.com/documentation/quartzcore/cadisplaylink), [preferred frame-rate range](https://developer.apple.com/documentation/quartzcore/cadisplaylink/preferredframeraterange)

When the user makes the iPad available, repeat the same physical touch, scrolling, two-viewer focus and fidelity acceptance there. Mac results alone cannot close the iPad gate. Do not claim sustained 60 FPS from the previously observed short approximately 50-updates/s animation sample.

## Options to defer

**Metal:** defer a custom renderer until copy/upload/presentation consumes a measured material share of the frame budget after upstream/input fixes. It cannot repair a blocked Host encoder, RPC queue or packet loss. GPU CEF capture is a separate question: the pinned `OnAcceleratedPaint` contract describes macOS IOSurface and Linux native buffers, while the pinned macOS window-info header still has a Windows-only shared-texture comment. Treat this documentation inconsistency as a reason for a runtime probe, not proof of unsupported macOS or a free zero-copy RFB pipeline. Native buffers would still need CPU-readable pixels for the current lossless encoder. [Pinned render handler](https://github.com/chromiumembedded/cef/blob/708dc14/include/cef_render_handler.h), [pinned macOS types](https://github.com/chromiumembedded/cef/blob/708dc14/include/internal/cef_types_mac.h)

**CopyRect:** supported by RFB, but CEF supplies dirty pixels rather than exact “move this old rectangle” instructions. Its scroll-offset callback is not sufficient proof that all viewport pixels translated: sticky headers, nested scrollers and animations invalidate that assumption. Merely advertising CopyRect cannot create those operations. Defer custom motion detection and verification until bandwidth remains the dominant constraint after upstream encodings, with a clear maintenance budget. [RFB CopyRect](https://www.rfc-editor.org/rfc/rfc6143.html#section-7.7.2), [CEF paint/scroll callbacks](https://github.com/chromiumembedded/cef/blob/708dc14/include/cef_render_handler.h)

The first bounded implementation pass should therefore deliver **Mac baseline instrumentation, coalesced ordered input with preserved semantics, removal of duplicate authorization work, and an evidence-based decision on separating RFB work from CEF**. Advance to encoding or renderer experiments only when the resulting traces identify the remaining bottleneck.
