# GPU CEF, Metal presentation and compression

15 September 2026. WVE-79 remains In Progress. All tests used upstream CEF 152.0.6 and lossless physical 2× pixels; audio and webpage accessibility remain deferred.

## Decisions

- **GPU CEF remains off.** The display path works, but reliable CDP screenshots do not. No attempted preflight, frame-clock or event-loop workaround is shipped.
- **Use Metal on Mac**, with automatic CGImage fallback. This substantially reduces the measured CPU cost of presentation while preserving exact pixels.
- **Keep the current presenter on iPad.** Metal is implemented and correctness-tested there, but remains diagnostic opt-in: its CPU cost was similar and it added GPU work. The data does not establish an iPad energy improvement.
- **Adopt zlib-ng on the Host**, retaining `--compression system` as a rollback/control build. It improves throughput and the iPad median response at the cost of more bytes per frame. The build uses private, symbol-prefixed upstream zlib-ng; it does not change ZRLE, compression level, the browser SDK or the client decoder.

## GPU reliability

Fresh/retained Pages, embedded/raw-pipe CDP, resize, idle and RFB viewer disconnect exposed intermittent screenshot timeouts. Runtime.evaluate continued to work and the Page remained visible. A returned PNG must match both current color pixels and geometry to pass.

The attempts covered `CDPScreenshotNewSurface`, view capture, DOM repaint, CEF show/invalidate, same-session `Page.bringToFront`, external begin frames and CEF's standard event loop. Short successful runs did not survive the combined checks. In the final standard-loop experiment, the first screenshot passed and the second after idle timed out. The experimental adapter was removed; its patch and the reproducer are retained for upstream investigation.

See [source analysis and experiment outcomes](gpu-screenshot-reliability.md). This is a specific agent screenshot blocker, not evidence that Chromium GPU rendering in general is unusable.

## Metal correctness and ownership

The presenter uses stock CAMetalLayer and Metal, two reusable BGRA textures, at most two GPU submissions in flight, and one replaceable pending decoded frame. The render queue owns drawable size and acquisition for its frame snapshot. The UI thread owns view layout. It uploads sRGB pixels, samples without filtering and forces opaque alpha because RFB's fourth byte is padding. There is no display-link loop or GPU work when no new frame arrives.

Resource or command failure falls back to the established CGImage presenter. Diagnostics can force failure, select either presenter, or read back the actual drawable after GPU completion. Expensive readback is disabled in product and performance runs.

Validation:

- Mac fixture: 392 recorded Metal frames, zero differing pixels, including 110 frames in the scroll measurement interval.
- iPad fixture: zero differing pixels; 124 verified frames within the measurement interval. Scroll displacement was preserved and no input RPC failed.
- A standalone Mac CAMetalLayer test repeatedly resized through 2000×1600, 800×1000, 1862×1502 and 1200×800: all 40 frames matched RGB exactly, with opaque alpha.
- Forced Metal failure retained the page and completed scrolling through CGImage.

Readback verifies the drawable, not final WindowServer color management or physical scanout. The normal installed UI still needs human visual acceptance of the composed page and overlays.

## Presenter comparison

Each condition used a 20-second scrolling fixture and the same native CEF wheel path. CPU values are thread CPU time spent creating/uploading/submitting the frame, excluding drawable wait. GPU values are Metal command duration. The response metric runs from the software input timestamp to layer/command submission, not photons on the display.

| Device and presenter | CPU per frame, median | Metal GPU work, median | Result |
| --- | ---: | ---: | --- |
| Mac CGImage, two runs | 19.72 / 17.27 ms | Not instrumented | Existing baseline |
| Mac Metal, two runs | 1.91 / 1.77 ms | 0.384 / 0.399 ms | Roughly 90% less presenter CPU |
| iPad CGImage, two runs | 2.21 / 2.46 ms | Not instrumented | Already inexpensive |
| iPad Metal, two runs | 2.50 / 2.53 ms | 0.525 / 0.534 ms | No demonstrated CPU/energy win |

The first Mac CGImage run briefly overlapped launching the normal iPad app; use the final CGImage run and two Metal runs for the cleaner comparison. Mac input-to-submit medians were 166.5 ms for that CGImage run and 155.9–165.3 ms for Metal. Other Host work continued throughout; absolute FPS is not directly comparable with earlier runs. The following compression comparison uses the same Mac presenter for all four runs.

On iPad, the route showed large stalls and tail variance: Metal response medians were 179–198 ms versus 318–360 ms for CGImage, but FPS remained approximately 11–14 across both conditions. These runs do not prove an isolated latency gain or battery benefit from Metal.

Mac powermetrics was unavailable without interactive administrator access. Power Profiler is unsupported for this Mac target. On iPad, devicectl installed/launched/controlled the app, but Instruments repeatedly timed out waiting for the same device to boot. No battery duration, watts or joules result is claimed. Revisit iPad adoption with an on-device, battery-powered power trace when Instruments can connect.

## Private compressor compatibility

The candidate is upstream zlib-ng 2.3.3, archive SHA-256 `f9c65aa9c852eb8255b636fd9f07ce1c406f061ec19a2e7d508b318ca0c907d1`, built as static zlib compatibility mode with `weave_rfb_` symbols. The cache key includes compiler, architecture, SDK and flags. LibVNCServer is rebuilt against the private headers/archive; `nm` verifies prefixed RFB deflate references. Alpha's decoder is unchanged.

Both Mac arm64 and Linux x86-64 passed 69 upstream CTest cases and the worker cancellation, resize and lifecycle test. GoogleTest is excluded to avoid an unpinned test download; this is not the entire upstream suite. A small-output-buffer continuing stream test passed 80 successive updates totaling 5,431,340 exact decoded bytes. Mac's independent decoder uses system zlib 1.2.12; Linux's distribution Python uses its own zlib-ng-compatible library. Linux CEF also passed isolated startup, Retina geometry, RFB greeting, CDP PNG and Page closure. No Linux Host deployment was changed.

See [dependency research and build rationale](lossless-compression-backends.md). Build the candidate with `build-browser-runtime.py --compression zlib-ng`; `--compression system` preserves the control build. The script builds and tests the private dependency without modifying installed dependencies.

## Compression comparison

Mac loopback, Metal for every run, 2298×1702 physical pixels. Order: system, candidate, candidate, system.

| Backend | Distinct content FPS | Input-to-submit median | p95 | Bandwidth | RFB pump wall time per second |
| --- | ---: | ---: | ---: | ---: | ---: |
| System, first | 16.35 | 156 ms | 214 ms | 31.57 Mbps | 822 ms |
| zlib-ng, first | 20.90 | 157 ms | 190 ms | 44.37 Mbps | 765 ms |
| zlib-ng, second | 21.05 | 143 ms | 167 ms | 44.69 Mbps | 770 ms |
| System, second | 16.35 | 179 ms | 211 ms | 31.51 Mbps | 822 ms |

The candidate delivers roughly 28% more frames and lower pump time, but costs about 41% more bandwidth, or approximately 10% more bytes per delivered frame. Decoder CPU rises with the additional frames. This is a throughput tradeoff; it is not a 60 FPS result or proof of lower total energy. All four runs preserved displacement with zero failed input RPCs.

iPad to Mac Host over the same LAN/VPN hostname, CGImage for every run, 1858×1502 physical pixels. Order: system, candidate, candidate, system.

| Backend | Distinct content FPS | Input-to-submit median | p95 | Bandwidth | RFB pump wall time per second |
| --- | ---: | ---: | ---: | ---: | ---: |
| System, first | 11.85 | 276 ms | 782 ms | 20.35 Mbps | 368 ms |
| zlib-ng, first | 13.90 | 210 ms | 763 ms | 25.86 Mbps | 276 ms |
| zlib-ng, second | 13.55 | 204 ms | 764 ms | 25.56 Mbps | 278 ms |
| System, second | 11.95 | 257 ms | 838 ms | 19.74 Mbps | 361 ms |

The iPad gains approximately 15% in delivered FPS and 22% in median response, with approximately 28% more total bandwidth. Its tail stalls remain. Pump wall time is not isolated compressor CPU time; it includes stock RFB processing and output. More received frames also consume more decoder CPU. The gain justifies adoption for the current LAN/VPN development use, but total battery savings and 60 FPS remain unproved.

Final native Portal acceptance with the candidate compared an actual 2000×1600 RFB image with Chromium's CDP PNG: **zero different pixels**. Pointer, selection, Unicode paste, native wheel, scale-only handoff, repeated same-viewport claims, stale focus rejection, unattended work, popup Right splitting and display revocation all passed.

## Validation and installation

`bun run check` passed: 306 Alpha, 41 protocol, 145 Portal and two boundary tests (494 total), plus builds and type checks. The final Metal resize test passed again, and an injected failure selected the newest static frame for fallback. Mac runtime signing and verification passed. The installed Host executable is unchanged; only its signed Browser runtime is replaced, with a rollback copy under the Weave backups directory. The existing Terminal Service remains alive, and the original Linear Page/Profile was restored with its identity, URL and 2× geometry intact. The signed normal Mac and iPad builds are installed and launched, preserving both app containers. Mac uses Metal by default; iPad uses CGImage. The final iPad fixture cleanup reported `removed:true`.

## Evidence

Machine-readable summaries, capability failures and native test results are under [gpu-metal-compression-20260915](evidence/gpu-metal-compression-20260915/). Temporary fixture credentials and Profile data are deliberately excluded. Commands and source are retained so measurements can be repeated on a quiet Host and a stable iPad route.
