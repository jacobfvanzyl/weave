# Matched browser-remoting evaluation — WVE-79

Completed first comparison, 2026-09-13. Audio is disabled. This is an isolated comparison of the existing CEF/LibVNC framebuffer and Chrome-extension/native-libwebrtc paths. It does not switch the product backend.

## Outcome

The measured tradeoff supports **one bounded iPad optimization pass for RFB/CEF before deciding whether to replace WebRTC**. Keep WebRTC as the accepted implementation baseline meanwhile, and keep expansion of the custom Viz compositor paused. Jaco accepted the lossless RFB priority. The [completed bounded iPad pass](rfb-ipad-optimization.md) preserved exact pixels and input but did not establish a reliable scrolling improvement. The iPad scrolling gate remains open; no production backend has changed.

RFB provides exact reconstructed browser pixels, low input latency on the Linux route, and almost no idle display traffic or client work. Its current client composition costs more CPU during motion and its pull-driven stream fell below the scrolling target on iPad. WebRTC provides much cheaper, smoother scrolling on iPad, with video compression artifacts, more idle work when configured for responsive static-page updates, and more buffering delay at 2× density. Neither clears all the provisional performance goals yet.

### Matched results

Each table row has **24 successful input responses**. The latency endpoint is decoded-pixel arrival, not displayed photons. The matrix uses the same page and geometry; codec quality modes remain different: lossless ZRLE versus adaptive lossy H.264. Rates are steady-phase windows with boundary samples removed. All WebRTC rows below use the standard minimum-frame-rate fix.

| Route / density | Backend | Click p50 / p95 (ms) | Scrolling updates/s | Scrolling Mb/s | Client CPU, one core | Client RSS MiB |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Linux → Mac, 1× | RFB / ZRLE | 28.1 / 44.6 | 30.0 | 3.715 | 17.6% | 96.4 |
| Linux → Mac, 1× | WebRTC / H.264, min 30 FPS | 46.8 / 78.7 | 30.0 | 0.192 | 7.4% | 113.8 |
| Linux → Mac, 2× | RFB / ZRLE | 32.8 / 46.1 | 30.0 | 19.006 | 31.3% | 130.3 |
| Linux → Mac, 2× | WebRTC / H.264, min 30 FPS | 165.7 / 183.8 | 29.9 | 0.589 | 7.9% | 107.9 |
| Linux → iPad, 2× | RFB / ZRLE | 38.9 / 106.2 | 20.8 | 13.428 | 24.4% | 46.7 |
| Linux → iPad, 2× | WebRTC / H.264, min 30 FPS | 118.0 / 201.0 | 30.0 | 0.585 | 12.1% | 59.0 |
| Mac → Mac, 1× | RFB / ZRLE | 59.9 / 67.3 | 30.0 | 4.222 | 13.0% | 96.3 |
| Mac → Mac, 1× | WebRTC / H.264, min 30 FPS | 57.8 / 64.5 | 30.0 | 0.204 | 3.4% | 111.7 |

RFB bytes include its TCP application stream; WebRTC bytes are video RTP payload. These are useful stream-volume indicators, not identical wire-byte accounting. CPU is percent of one core (100% = one fully occupied core), including the benchmark probe and native image/video view. RSS is the client process's resident memory, not total system/graphics memory. Compare CPU within the same client device. Host CPU/RSS phase estimates and raw counters are included in the per-run JSON; summed Host RSS double-counts shared mappings and must not be treated as physical browser memory.

The repeat Linux 1× RFB run gave 28.1/44.6 ms, compared with 30.7/45.3 ms in the initial run. On the same Mac Host, both backends were around 58–60 ms median: RFB is not universally faster on every platform.

### Fidelity and motion

All successful RFB static-content comparisons were pixel-exact, including **2,112,000 content pixels** at 2× density on both native Mac and physical iPad. The metric excludes the changing header. WebRTC's tuned Linux 2× runs had mean absolute RGB error **1.38/255 on Mac** and **1.41/255 on iPad**; about 17.7% of iPad content pixels differed by more than two levels in at least one RGB channel. This quantifies decoded-pixel differences, not perceptual acceptability. Inspect the [interactive image comparison](comparison.html) for fine black, red and blue text. Each receiver is compared against its own browser's independent CDP screenshot, not against another browser version's layout.

On iPad at 2×:

| Workload | RFB updates/s | WebRTC updates/s | RFB Mb/s | WebRTC Mb/s |
| --- | ---: | ---: | ---: | ---: |
| scroll | 20.8 | 30.0 | 13.428 | 0.585 |
| animation | 27.4 | 30.0 | 0.019 | 0.015 |
| dense | 26.3 | 15.5 | 7.000 | 2.490 |

WebRTC's dense-motion phase settles around 2.5 Mbps while losing frame cadence. That suggests an encoder/adaptation tradeoff worth testing; these measurements do not establish a bandwidth or frame-rate ceiling for WebRTC. We did not tune bitrate, sender adaptation or receiver playout delay. RFB's iPad frame-gap p95 during scrolling was 116 ms versus WebRTC's 37 ms, so average FPS alone understates its uneven cadence.

The iPad RFB client used approximately 0.5% of one core during idle viewing, versus 11.7% for the minimum-30-FPS WebRTC client. During scrolling the figures were 24.4% and 12.1%. The RFB adapter copies a full 1920×1280×4 image for a presentation (9.83 MB); at 30 presentations/s that is about 295 MB/s for that copy alone. Its one-presentation queue is bounded. Dirty-region texture updates might reduce this cost, but have not been implemented or measured here.

### What the tuning established

The original WebRTC capture settings produced small static-page input p95 around **1,033 ms at 1×** and more than one second at 2×. Applying the standard minimum-frame-rate constraint reduced Linux-to-Mac 1× p95 to **79 ms**. This change is proven in the isolated extension, not applied to the product extension. Its higher idle CPU is part of the tradeoff.

At 2×, the tuned Mac receiver's mean video decode time during the input phase was **3.4 ms**, while its mean jitter-buffer residence was **136 ms**. The iPad input phase had roughly **69 ms** mean buffer residence. Buffering accounts for a substantial part of the observed delay; a public receiver-delay control is not exposed by the pinned SDK's Objective-C `RTCRtpReceiver` header. No private API, SDK patch or browser fork was attempted.

The earlier research proposed p95 ≤150 ms on LAN and ≥30 displayed FPS during normal scrolling. RFB's iPad decoded cadence is below that motion target; tuned WebRTC's iPad decoded-input p95 is already above the LAN latency target. These are necessary pipeline checks. Physical display scanout, touch-to-photon delay and panel color/text acceptance remain unmeasured.

### Original bounded-pass scope — now completed

The following scope was carried out in [the optimization report](rfb-ipad-optimization.md).

Evaluate RFB's iPad limitation in isolation, with the same corpus and a repeatable baseline. Separate receive/decode timing, framebuffer-copy/main-thread presentation cost, and request/response network cadence. Test changes through public LibVNC APIs and ordinary AppKit/UIKit/Metal image presentation only. Stop if meeting the scrolling goal requires a library fork, a growing custom protocol layer, or browser-rendering semantics on the client. Any sustained improvement must retain exact screenshots, 24/24 input responses, bounded queues and the prior shared viewport behavior.

If low bandwidth and smooth scrolling take priority over exact pixels, keep WebRTC primary and carry the proven capture-constraint change into its next integration slice. Its next performance questions are bitrate/adaptation and playout buffering. Audio stays completely deferred in either direction.

### Evidence and scope

- [Full structured summaries](evidence/summary.json), [machine/engine metadata](evidence/machines.json), [source hashes](evidence/source-sha256.json).
- Each run directory contains native JSONL, owned Host process-tree samples, Host logs, configuration, process exit, independent reference state/PNG, received PNG and derived summary. iPad runs also contain build/install/copy logs.
- Eleven non-pilot runs completed with 24/24 responses: **264 measured input responses**. Two earlier pilots and the explicit timeout/launch failures are retained separately. The failed paths are excluded from comparisons.
- Native Mac/iPad builds, Linux CEF adapter compilation, compiled Linux Bun Host, focused TypeScript checking, Python compilation and extension syntax checks passed. Runtime geometry confirmed 960×640 CSS with DPR 1 or 2 and 960×640 or 1920×1280 received pixels. Audio tracks were absent and native WebRTC audio playback was false.
- The corpus is a deterministic development-like fixture (docs/source/logs, small animation, dense 2D canvas). It is not real-app coverage, video decoding, WebGL, IME, popup, clipboard/file, accessibility or multi-viewer scaling acceptance. GPU-enabled Host rendering, hostile network conditions and long-duration thermal behavior remain open.
- Chrome and CEF use different Chromium versions and process compositions. Both render in software for these tests. Chrome for Testing is compatibility evidence; the all-open-source packaged-browser distribution remains a separate requirement. RFB is unencrypted at its protocol layer here, carried over Tailscale; production Portal authorization, secure stream attachment and browser sandboxing remain integration work.
- The machines retained other user workloads. These are indicative measurements with small latency samples and approximate Host-resource phase alignment, not laboratory guarantees.

## Method

Both paths use the same deterministic local development corpus, 960×640 CSS viewport, 30 Hz changing content, software Chromium rendering, one native viewer, and no audio. Test 1× and 2× raster density separately. Linux connects directly over Tailscale. The first Mac pilots used unconstrained local interfaces/loopback; final Mac runs bind RFB to the Mac Tailscale address and restrict WebRTC ICE candidates to Tailscale IPv4 addresses. Same-Mac runs remain local traffic, not a remote network measurement. Native image/video presentation remains active.

The corpus comprises idle documentation, 24 native-submitted clicks, scrolling source/log rows, a small animation, dense changing canvas content, and fine text/colored edges. Dense canvas motion is a stress fixture, not representative video decoding. Scrolling is driven by the identical page script, avoiding unmatched gesture cadence. A black/white marker carries page phase, click counter and frame sequence. Phase 6 is static for screenshot comparison.

Latency uses a single monotonic native-client clock: immediately before input submission to the first matching decoded frame callback. This includes input transport, browser processing/rendering, capture/encoding, network and decoding. It excludes main-thread image presentation and physical display scanout. No unsynchronized server/client timestamp subtraction is used.

RFB reports TCP received bytes from `TCP_CONNECTION_INFO`; WebRTC reports inbound RTP payload bytes from standard receiver statistics. Neither is total wire traffic; RTP/TCP/IP/Tailscale headers, signaling, retransmission accounting and control traffic differ. Values must retain this distinction.

CPU is cumulative process time, sampled once per second. Host figures sample the owned process tree. The initial Linux RFB run used coarse `ps` CPU time; subsequent runs use Linux clock ticks and retain CPU totals for observed children after they exit. Very short-lived processes may escape the sampler. Phase alignment is approximate and trims boundary samples; RSS sums resident sets and can double-count shared browser pages. Client CPU/RSS comes from its own process. A frame-marker probe converts WebRTC buffers to I420 and records conversion time; this diagnostic cost belongs to the measured client and must not be described as production decoder cost. RFB retains the existing full-frame copy/CGImage presentation path.

Frames count distinct visible sequence numbers, not repeated decoder deliveries or RFB rectangles. Software rendering and browser versions are recorded explicitly. These tests compare backend compositions, not an isolated protocol with identical upstream rendering internals. Retained engine pins differ: CEF Chromium 152.0.7977.83 versus installed/previously downloaded Chrome 153.0.8010.36. No browser source rebuild is required.

The first `pilot` run validates instrumentation and is excluded from the comparison. It precedes the adjustment that makes fine text visible in the viewport.

## Run

`python3 experiments/browser-remoting-comparison/build.py` builds optimized Mac native clients and the small CEF adapter against existing pinned dependencies. The existing accepted experiment apps remain untouched. The isolated WebRTC extension differs by setting audio capture to false. `run.py <mac|linux> <rfb|webrtc> <1|2> [repeat-label]` runs a bounded single Mac-client test and captures native logs, Host process-tree resources, received/reference screenshots and runtime geometry. Linux uses the task directory `/var/home/admin/weave-remoting-comparison` and the already assembled CEF runtime. Private connection files and profiles remain under ignored `.build/`.

Run `build-ipad-projects.py` after the original native spike projects have been generated. Set `BENCH_CLIENT=ipad` for a physical-device run and `BENCH_EXTENSION=extension-minfps` for the tuned WebRTC variant. The runner uses the task-owned app slot and private connection resource. Run `summarize.py`, then `report.py` after the measurements to produce the report.

## Investigations during measurement

- The custom `readTimeout=5` in the earlier RFB spike failed during a large 2× initial frame. LibVNC 0.9.15 `ReadFromRFBServer` accumulates EAGAIN retries and compares that count with an assumed retry duration; retries need not each consume that duration. The failed run disconnected within its first second. Restoring upstream `DEFAULT_READ_TIMEOUT` (0), with an independent 115-second native watchdog and bounded runner, allowed the 2× run to complete. No installed library source was patched. The failed evidence is retained under `linux-rfb-dpr2-timeout-failed`. Production timeout ownership still needs a proper design.
- Baseline WebRTC capture showed about one-second small-update latency after a static page, while moving content arrived near 30 FPS. The `extension-minfps` experiment uses `track.applyConstraints({frameRate:{min:30,ideal:30,max:30}})`, with no encoder/client fork. This is the standard [Media Capture constraints API](https://www.w3.org/TR/mediacapture-streams/). Upstream WebRTC [frame-cadence code](https://chromium.googlesource.com/external/webrtc/+/master/video/video_stream_encoder.cc) also distinguishes screen-content zero-Hertz mode based on minimum-rate constraints; that is a reason to test this setting, not proof of the exact cause in the pinned binary. Actual latency and idle costs are measured separately below.
