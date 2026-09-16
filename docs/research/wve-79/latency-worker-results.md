# Retina RFB latency optimization — 2026-09-15

WVE-79. This follows the [agreed investigation order](interaction-latency-profile.md). Adopt the RFB executor, retain software CEF, ZRLE, and the existing sRGB CGImage presenter. Keep 2× lossless pixels. Audio remains parked and ordinary HTML select menus remain deferred pending upstream CEF work.

## Decision and measured outcome

Moving compression and socket output off CEF's main thread produced the clearest improvement. Two Mac worker runs measured **111–112 ms median input-to-layer latency and 34.7 distinct scroll FPS**, compared with **186–189 ms and 25–28 FPS** in the three software baseline runs. The worker lets CEF paint at about 60 FPS while the encoder catches up with the newest accumulated damage. This is a roughly 40% reduction in measured Mac response time, not a 60-FPS client result.

The iPad remains limited by delivery cadence and variable waits. The worker runs reached about 14–15 FPS, but their latency tails varied too much to claim a consistent improvement. No tested Retina condition met the 57-FPS cadence gate.

All runs below used stock CEF 152.0.6 / Chromium 152.0.7977.83, LibVNC 0.9.15, and 2× pixels. Mac used 2298 × 1702 physical pixels over loopback; iPad used 1858 × 1502 over trusted WSS to the Mac's Tailscale address. Runs lasted 20 seconds and were sequential. Mac stack sampling added the same profiling overhead to the trials. Input-to-layer latency measures software event capture to layer submission in the first forward scroll segment; it excludes physical display scanout. The stage timings overlap and cannot be summed. These are bounded experiments, not production guarantees.

| Condition | Distinct FPS | Median / p95 response, ms | Mbps | Outcome |
| --- | ---: | ---: | ---: | --- |
| Mac software baseline, 3 runs | 28.2 / 27.6 / 25.0 | 188 / 213; 186 / 198; 189 / 206 | 56 / 55 / 48 | Reference |
| Mac GPU baseline, 3 runs | 29.1 / 29.9 / 22.5 | 120 / 142; 127 / 150; 128 / 159 | 63 / 64 / 43 | Blocked by screenshot reliability |
| Mac worker, 2 runs | 34.7 / 34.7 | 111 / 126; 112 / 127 | 67 / 67 | Adopt |
| iPad software baseline | 12.1 | 234 / 837 | 21 | Reference; variable route |
| iPad GPU baseline | 12.7 | 205 / 650 | 20 | GPU gate failed elsewhere |
| iPad worker, 2 runs | 14.7 / 13.9 | 341 / 757; 164 / 736 | 24 / 24 | No consistent latency win established |
| iPad worker with added timing instrumentation | 15.2 | 168 / 267 | 26 | Delivery timing reference |
| iPad worker + zlib level 1, 2 runs | 15.1 / 15.1 | 185 / 277; 171 / 306 | 75 / 76 | Reject as default |
| Mac worker + zlib level 1 | 24.1 | 141 / 162 | 195 | Reject as default |
| Mac worker + experimental Metal, 2 runs | 33.7 / 35.1 | 101 / 116; 103 / 118 | 65 / 68 | Retain research prototype only |

Every row in this table preserved final scroll displacement with zero failed input RPCs. Individual summaries are in [the evidence directory](evidence/latency-worker-20260915). The failed prefetch trial is saved separately and excluded from valid performance comparisons.

## 1. GPU-enabled CEF: promising, blocked

CDP `SystemInfo.getInfo` confirmed ANGLE Metal on Apple M4, with GPU compositing and rasterization enabled. The three paired Mac trials consistently improved median response. Late-run cadence declined in both conditions; there was no recorded thermal warning, and the cause was not established.

However, `Page.captureScreenshot` intermittently timed out after the native viewer disconnected: one GPU acceptance failed, a repeat passed exact pixels, and another GPU acceptance with the worker failed at the same screenshot step. Software worker acceptance passed. The RFB PNG existed in each failed GPU case but the reference screenshot did not. This identifies the failing command; it does not yet prove an upstream root cause.

Reliable unattended agent control is part of the architecture, so GPU mode remains diagnostic-only. The iPad GPU sequence completed one off/on pair; the next device launch failed before measurement. Do not describe it as three completed iPad pairs. Linux GPU acceleration was not accepted as a default.

## 2. RFB executor: implemented and installed

[`rfb-display.h`](../../../product/portal/native/browser/rfb-display.h) owns one executor per native Profile process. All LibVNC server calls and library framebuffers stay on that thread. CEF copies current damage into a separate latest-image buffer under a short mutex. The worker copies accumulated damage, releases that mutex, and then compresses/sends. Damage metadata is bounded; it collapses to a full image after 256 rectangles. It never drops encoded bytes from a live stateful stream.

The separate stock LibVNCServer build uses `WITH_THREADS=OFF`. Pinned `rfbGetScreen` initializes a process-global client-list mutex on each screen creation when threading is enabled, so one worker per Page with that build is not a safe shortcut. Alpha's client library is unchanged. The [ownership research](rfb-worker-design.md) records the primary-source audit and build constraints.

Resize publishes the first matching new-size paint as a complete image. Page close marks the display stopped and shuts down registered duplicate sockets without joining the worker. The worker owns library teardown. A standalone test covers incomplete handshakes, a raw viewer that stops reading, concurrent staging/resize, repeated Page disposal, and process shutdown.

**Remaining limitation:** a blocked viewer can delay display delivery for other Pages in the same Profile. CEF input and painting continue. On Linux, local `shutdown` does not necessarily wake `select(write)` while a Unix socket peer remains open with a full receive buffer; LibVNC's next retry can take five seconds. Tests require Page close/create to return within 100 ms and background worker recovery within 5.5 seconds. The existing six-second process shutdown grace covers that observed path. This is not per-viewer isolation or a general bound on a trickling live viewer. Portal retains its existing media queue limits.

Mac worker profiling still spends roughly 800 ms per second in RFB processing, with typical maximum pumps around 25 ms. Moving the work improved responsiveness through overlap; it did not make ZRLE compression cheaper.

## 3. iPad request and delivery timing: instrumented, defaults retained

The instrumented iPad run measured median RFB handler wall time of 26.2 ms, handler thread CPU of 9.7 ms, receive gap of 25.1 ms, and native layer submission of 2.3 ms. Handler wall time excludes the subsequent full-image copy. Wall time minus CPU includes blocked and descheduled time; it is not a pure network measurement. The receive-gap p95 was 104 ms. This supports further work on transport and request cadence before replacing the iPad presenter.

A diagnostic early incremental request, sent before the stock handler while retaining its automatic post-decode request, disconnected during the run. It reported a failed input RPC and did not preserve displacement. Its lower initial latency is invalid as an optimization result. The experiment was removed.

Stock zlib level 1 used about three times the bandwidth on iPad without improving latency or FPS, and also lost to ZRLE on Mac. ZRLE remains the default. The diagnostic encoding selector and timing fields remain available for reproducible research. See [request-cadence research](rfb-request-cadence.md) for upstream protocol and library constraints. URLSession service hints, explicit relay pause/drain backpressure, and zlib-ng were researched or considered but were not implemented or validated in this pass.

## 4. Mac presentation: useful prototype, not adopted

The experimental presenter uses standard Metal, explicit sRGB source/target textures and layer color space, two reusable source textures, and a bounded newest-image slot. GPU/drawable waits occur on a render queue. It reduced submission time from about 10 ms to 1–2 ms and shaved roughly 8–10 ms from end-to-end response, while distinct FPS remained 34–35.

The experiment's Metal path was confirmed in diagnostic records. This was not a visual fidelity acceptance: command submission does not prove displayed pixels, and the existing acceptance capture reads CGImage layer contents rather than a Metal drawable. OS window/display capture was unavailable in this session. iPad Metal was not evaluated. The prototype therefore lives outside the build in [the experiment directory](experiments/metal-presenter), with its integration patch; production continues using the established color-managed presenter.

## Validation and installation

- Root `bun run check` passed: 306 Alpha, 41 protocol, 145 Portal, and 2 boundary tests, plus builds/type checks.
- Standalone worker lifecycle/cancellation tests passed on Mac and Linux. A ThreadSanitizer run of the Mac adapter/test completed without reports; the linked stock LibVNC archive was not sanitizer-instrumented.
- Final Mac native acceptance passed with **zero differing pixels at 2000 × 1600**, including scale-only handoff, focus ownership, selection, cut/Unicode paste, native wheel behavior, unattended control, Right-split popup behavior, and display revocation without killing the Browser. [Evidence](evidence/latency-worker-20260915/mac-native-acceptance.json)
- Bazzite compiled the current adapter and passed an isolated software CEF smoke: 800 × 600 logical viewport at 2×, RFB 3.8 greeting, CDP PNG screenshot, Page close, and clean runtime exit. This is not full Linux native pixel acceptance or a Linux deployment. [Evidence](evidence/latency-worker-20260915/linux-smoke.json)
- Physical iPad scroll acceptance passed with the worker. The user separately confirmed the long-press editing menu and retained page visibility during the interaction pass.
- The normal Mac and iPad apps and matched Mac Host/Browser runtime were built and installed, preserving the app containers and existing Profile. Host source hash: `31d016a1696ffb3f01d1d49341e79291c69074141c359a7626231706d4a80465`; private Browser Service 8, native handshake 4, public protocol 8. This is uncommitted work after `4707e615`, not a new release.
- Terminal Service PID 13352 remained running. The existing Linear page was restored with its original Page/Profile identity at 2×. iPad fixture cleanup reported `removed: true` before the normal app was reinstalled.

Next, target the remaining server compression cost and iPad transfer gaps. A bounded stock dependency comparison such as zlib-ng is more aligned with the minimal-glue requirement than adopting a custom presenter for an 8–10 ms saving. First retain exact-pixel and reliability gates; separately measure relay queue age/drain behavior and simultaneous route RTT so transport changes can be attributed. Do not weaken profile, focus, or authorization semantics to chase sub-millisecond checks.
