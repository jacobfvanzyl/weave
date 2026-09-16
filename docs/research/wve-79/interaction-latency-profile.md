# Browser interaction and latency profile — 2026-09-15

Follow-up: the recommended sequence was executed. See [worker results and adoption decisions](latency-worker-results.md) for the installed optimization, rejected experiments, and updated measurements.

WVE-79. Keep the accepted 2× lossless RFB display and stock CEF. The interaction pass is implemented; this profiling pass identifies the next optimization targets without changing production rendering defaults. Audio remains disabled. Ordinary HTML select menus are deferred by user decision pending an upstream CEF fix.

## Method and limits

These are short, sequential measurements from the work in progress after `4707e615`, using CEF 152.0.6 / Chromium 152.0.7977.83 and LibVNC 0.9.15. The fixture injects 120-Hz wheel events through the mounted Alpha input surface, with direction reversals every five seconds. A lossless pixel marker identifies the scroll displacement in native frames. Each valid run preserved the requested final displacement and reported no failed input RPCs.

Latency is **software event capture to native layer submission**, measured in the first forward segment. It excludes physical display scanout. Distinct FPS counts changed scroll markers, not repeated layer submissions. Stage timings overlap: their medians cannot be added into an end-to-end latency budget. These runs establish bottlenecks and promising experiments, not repeatable performance guarantees or a 60-FPS result. Mac stack sampling ran during the Mac trials and may add overhead.

The Mac used loopback with a 1149 × 851 logical viewport and 2298 × 1702 physical pixels. The physical iPad Air 11-inch M3 connected to the Mac using trusted WSS over Tailscale. Native diagnostics identify individual display surfaces, preventing another retained Pane from replacing or contaminating the fixture's results. Isolated fixture Hosts use temporary state and preserve the existing app container.

## Results

| Condition | Distinct FPS | Input-to-layer median / p95 | Stream Mbps | Evidence |
| --- | ---: | ---: | ---: | --- |
| Mac, default ZRLE, 2×, 30 s | 28.2 | 191 / 226 ms | 56.8 | [Summary](evidence/interactions-20260915/mac-zrle-2x.json) |
| Mac, GPU enabled with ordinary OnPaint, ZRLE, 2×, 20 s | 28.9 | 131 / 165 ms | 60.5 | [Summary](evidence/interactions-20260915/mac-gpu-zrle-2x.json) |
| Mac, Hextile, 2×, 20 s | 42.0 | 120 / 145 ms | 1163.8 | [Summary](evidence/interactions-20260915/mac-hextile-2x.json) |
| iPad, ZRLE, 2×, full height, 30 s | 12.3 | 211 / 307 ms | 21.6 | [Summary](evidence/interactions-20260915/ipad-zrle-full-2x.json) |
| iPad, ZRLE, 2×, keyboard visible, 30 s | 17.2 | 159 / 702 ms | 12.6 | [Summary](evidence/interactions-20260915/ipad-zrle-keyboard-2x.json) |

The keyboard-visible iPad run used 929 × 329 logical / 1858 × 658 physical pixels. Its smaller image and real network route make it unsuitable for a direct platform comparison with the Mac. The full-height run used 929 × 751 logical / 1858 × 1502 physical pixels. It passed after correcting a dropped-resize race when keyboard dismissal overlapped an in-flight focus claim.

## What the profiles establish

**CEF's main thread spends substantial time in RFB compression/output.** The baseline pump occupied about 650 ms per second. The native stack sample contains 5,057 samples below `rfbProcessEvents`, including 4,233 under ZRLE encoding with zlib `deflate` descendants. These are overlapping stack populations, not additive durations. Encoding on the same thread as CEF delays both painting and input dispatch. [CEF stack sample](evidence/interactions-20260915/cef-sample.txt.gz)

**Mac presentation includes CPU color conversion.** Its median full-image copy was 1.18 ms, main-queue wait 0.015 ms, and image/layer submission 9.62 ms. The Alpha sample contains 2,144 samples under `CA::Render::copy_image`, including 1,542 below `vImageConverterConvert` and transfer-curve processing. Actual layer format is already RGBA8. Reapplying that format is unlikely to help. Removing sRGB tagging or color matching would weaken the accepted fidelity contract. [Alpha stack sample](evidence/interactions-20260915/alpha-sample.txt.gz)

**GPU-enabled ordinary OnPaint is a promising small stock-API change.** Its exploratory run reduced median response by about 60 ms and let CEF paint at about 60 FPS, but the client still showed only about 29 distinct scroll frames per second. The RFB pump remained expensive. This needs repeated paired runs and fidelity/startup validation before adoption; it is currently diagnostic-only.

**Hextile is an expensive throughput tradeoff.** It raised distinct cadence to 42 FPS and reduced latency, but used around 1.16 Gbps. It is not recommended as the general LAN/VPN default. A full-frame raw 2× stream at 60 FPS would require roughly 7.51 Gbps before framing, so no general-purpose raw trial is warranted by these results. Pinned ZRLE hardcodes zlib's default compression: the generic compression-level preference is not a working ZRLE tuning control.

**The iPad tail needs transport/request-cadence investigation.** In its smaller-view run, native copy took 1.10 ms, submission 1.72 ms, and main-queue wait 0.046 ms median. Chromium painted about 60 FPS while the client presented 17 distinct FPS. Input RPC median was 17 ms with a long tail; measured frame intervals also had large stalls. A separate five-probe Tailscale check used direct UDP and returned 128, 19, 124, 5, and 7 ms. That check was not simultaneous with the benchmark and does not prove the cause of every stall. The full-height run reached 12.3 distinct FPS with 211-ms median / 307-ms p95 response. Its copy and submission medians were 2.18 and 2.87 ms, while CEF painted 47 FPS. This confirms a larger delivery gap at normal geometry. The evidence supports measuring RTT, request timing, relay backpressure, and frame age before blaming iPad rendering or changing protocols.

Portal authorization remains sub-millisecond. Removing ownership checks would not address the measured costs.

## Recommended implementation order

1. **Validate GPU-enabled ordinary OnPaint as the next small change.** Repeat paired Mac and iPad runs, compare exact transport pixels against the active Chromium producer, and check text quality, startup, resize, overlays, and reconnect. Keep a software fallback; Linux needs separate acceptance before a cross-Host default changes.
2. **Move RFB compression/output off CEF's main thread.** Start with upstream LibVNC threading facilities. Audit framebuffer ownership, resize, shutdown, and slow-viewer behavior; a lock held through compression/socket writes would merely move the stall back into paint. If required, use a small bounded handoff retaining the newest unencoded state and accumulated dirty regions. Never discard bytes from an already-encoded stateful stream.
3. **Test bounded request overlap on the iPad route.** Instrument receive availability, relay queue age, and RFB request timing first. The client already requests its next update before its completed-frame callback, but after decoding. LibVNC does not support ContinuousUpdates; use standard request semantics and serialized socket ownership for a bounded early-request experiment. Input reply overlap is a separate experiment and must preserve click/key/focus/resize ordering and authorization.
4. **Reduce Mac color-conversion/submission cost with reusable native storage.** If the earlier steps leave this cost material, compare a small shared Metal/sRGB presenter with the current CGImage path. Preserve explicit color management and bounded resource ownership. Measure drawable presentation timestamps as well as submission, on both devices.

Do not introduce predicted scrolling, inferred CopyRect motion, lower density, lossy encoding, a Chromium fork, or a new display protocol as the first response to these measurements. The target remains at least 57 distinct FPS with p95 frame interval at most 25 ms and p99 at most 50 ms, alongside lower median/p95 response, preserved displacement, exact pixels, and bounded stale-frame age. None of the current Retina runs passes that cadence gate.

Primary-source contracts, alternatives, and API limitations are detailed in [the latency research](retina-latency-research.md). Interaction behavior and the upstream dropdown decision are recorded in [the interaction report](browser-interactions.md).
