# RFB framebuffer experiment — WVE-79

2026-09-13. User authorized the RFB/LibVNC experiment and **parked audio completely**. This supersedes audio as an acceptance condition for the current experiment. The accepted WebRTC implementation and the separate Viz capture/replay work are preserved.

**Result so far:** native Mac/iPad packaging and shared synthetic viewing pass. A prebuilt CEF engine now feeds rendered browser pixels into RFB on macOS and Linux. Three controlled browser screenshots reconstruct exactly through RFB: Mac at 800×600 and 1000×700, Linux at 800×600. Physical-iPad acceptance is confirmed for both the synthetic path and the real Chromium page from the Linux Host.

The [matched performance comparison](../browser-remoting-comparison/README.md) is now complete. It records exact RFB pixels and low input latency, plus an unresolved 2× iPad scrolling limit. WebRTC remains the accepted implementation baseline pending the next architecture decision.

## Architecture tested

```text
Host: CEF OnPaint -> owned BGRA framebuffer + dirty rectangles -> LibVNCServer
                                                                    |
                                              direct RFB over LAN/Tailscale
                                                                    |
Apple: UIImageView / NSImageView <- CGImage <- LibVNCClient framebuffer
```

LibVNC owns protocol negotiation, sharing, rectangle encoding/decoding and framebuffer updates. The Apple app uses native image presentation; it contains no WebView, custom browser compositor, video decoder or audio integration. The host uses CEF's public offscreen/render/input APIs. No Chromium patch or Chromium source build is involved.

Pinned components:

- LibVNCServer/LibVNCClient **0.9.15**, upstream source, GPL-2.0; [archive pin and SHA-256](pin.json), [upstream](https://github.com/LibVNC/libvncserver/tree/LibVNCServer-0.9.15).
- CEF **152.0.6+g708dc14 / Chromium 152.0.7977.83**, matching prebuilt minimal distributions for Mac arm64 and Linux x64. [Distribution metadata](cef-pin.json), [Linux archive verification](evidence/cef-linux-artifact.json), [upstream build index](https://cef-builds.spotifycdn.com/index.html).
- Apple SDK zlib provides lossless compression. Optional JPEG/PNG libraries, GStreamer, TLS libraries, WebSockets, file transfer and example UI frameworks are disabled in this isolated build. ZRLE was negotiated in the runtime tests.
- Bazzite synthetic and CEF servers link its installed `libvncserver.so.1` (0.9.15). Development headers and CMake tooling were downloaded/extracted into the task directory, not installed into the OS.

The native library build took **7.97 seconds on Mac and 5.54 seconds for iOS**. Client static archives were **171,136 and 170,816 bytes**, respectively. These are library/archive sizes, not app download sizes or memory measurements. CEF's C++ wrapper was compiled against the downloaded engine; this is not a browser-engine build. [Build evidence](evidence/library-build.json).

## Native synthetic gate

The producer renders a moving bar, a click-controlled rectangle, and a frame marker. The native viewers connect as shared clients. A test button sends RFB pointer events; Claim viewport sends standard ExtendedDesktopSize. The most recent explicit claim changes the server size, and other viewers follow it.

The user confirmed on the connected **iPad Air 11-inch M3**: “Animation, click, and shared resize all work.” This covered the native Mac and iPad viewers attached directly to Bazzite over Tailscale, including the iPad's 800×1000 viewport. [User acceptance](evidence/user-acceptance.json), [iPad console](evidence/ipad-linux-console.log), [Mac console](evidence/mac-native-linux-final.log), [server events](evidence/linux-native-final-server.log).

A separate automated run used two diagnostic clients against each Host, with different viewport claims, clicks, a disconnect/reconnect, and a persistent first viewer:

| Host | First viewer checked frames | Second viewer | Reconnected viewer | Mismatched pixels |
| --- | ---: | ---: | ---: | ---: |
| Mac | 392 | 112 | 112 | 0 |
| Linux | 381 | 107 | 107 | 0 |

**1,211 frames** matched the producer's independent pixel formula across those runs. Cursors were requested separately so server cursor overlays did not contaminate the pixel comparison; cursor presentation is not implemented. The checker excludes its two metadata pixels and the top-left cursor region. All six diagnostic clients and both bounded servers exited successfully. [Structured results](evidence/synthetic-summary.json), [process exits](evidence/synthetic-processes.json).

The checker caught and drove a real repair: `rfbNewFramebuffer` reinitializes server pixel format on resize. The adapter restores BGRA shifts and rebuilds each viewer's translation table before sending subsequent pixels. Merely observing a successful size change would have missed swapped red/blue channels. Early physical-viewer logs precede this repair; the subsequent pixel tests and browser resize comparison verify it.

Apple's free developer profile had already reached its three-app limit. The iOS harness therefore reuses the task-owned `com.veezee.browser-spike` slot, with display name **RFB Spike**. Alpha and cmux were preserved. The prior signed WebRTC BrowserSpike app remains under `experiments/browser-streaming/.build/ipad/Build/Products/Debug-iphoneos/` for restoration. Mac uses its own `com.veezee.rfb-spike` bundle.

## Real Chromium gate

`cef-host.cc` creates one offscreen CEF browser. `OnPaint` copies changed BGRA rectangles into the framebuffer and tells LibVNCServer which regions changed. RFB input reaches CEF's mouse API. A viewport request resizes the framebuffer and calls CEF `WasResized`. Detaching a viewer does not close the browser.

The fixture includes browser text, rounded corners, a transformed card, shadows, blur, an animation and a DOM click counter. For comparisons, DevTools pauses animation at a fixed time. An independent Chromium `Page.captureScreenshot` image is compared with the framebuffer received and saved by the native RFB client.

| Host / viewport | Pixels compared | Pixels different | Maximum channel error |
| --- | ---: | ---: | ---: |
| Mac, 800×600 | 480,000 | 0 | 0 |
| Mac, 1000×700 after RFB resize | 700,000 | 0 | 0 |
| Linux, 800×600 | 480,000 | 0 | 0 |

[Mac comparison](evidence/cef-mac-comparison.json), [Mac resize comparison](evidence/cef-mac-resized-comparison.json), [Linux comparison](evidence/cef-linux-comparison.json). This is equality of decoded RGB/RGBA pixels for these controlled frames, not a claim of universal browser compatibility, physical display colorimetry, or native Retina performance.

The Mac RFB click incremented the DOM counter to 1, verified independently over CDP. Resizing reached the page as `innerWidth=1000`, `innerHeight=700`. A task-profile localStorage marker survived restarting the Mac CEF process; [restart state](evidence/cef-mac-restart-state.json). CDP was exercised directly on the loopback DevTools endpoint; Portal/ACP authorization and MCP integration were not added.

On Linux, the initial incorrectly assembled runtime could not find ICU data. Co-locating the runtime binary, Release libraries and Resources fixed that. Initialization then stalled in `first_run::internal::ShowEulaDialog`, demonstrated by a debugger stack. Standard first-run suppression switches resolved the stall. **The successful Linux run has DISPLAY unset and uses `--ozone-platform=headless`.** A private Xvfb test was used to diagnose the stall and was stopped; it is not needed by the successful configuration. [Stack evidence](evidence/linux-init-stack.log), [successful headless log](evidence/cef-linux-basic-host.log).

[Native Mac browser reception](evidence/mac-native-cef.log), [both viewers on Linux CEF](evidence/cef-linux-basic-host.log), [iPad browser console](evidence/ipad-cef-linux-console.log). On 2026-09-13 Jaco confirmed the real-browser physical-iPad check: “Browser animation, click, and shared resize work.” This covers the animated gold bar, Test click incrementing the page’s Clicks counter, and Claim viewport resizing the page on both native viewers. The exact confirmation is recorded in [user acceptance](evidence/user-acceptance.json).

## Limits and next evaluation

This is an isolated feasibility adapter, not a production Browser Service backend:

- Audio is deferred. No audio transport, microphone, synchronization or audio acceptance was attempted.
- CEF is running with software rendering and the sandbox disabled for the local fixture. Production sandboxing, secure attachment authorization and engine-update packaging are not implemented. RFB test endpoints are restricted to loopback or the Host's Tailscale address, carry only the task fixture, and use no RFB authentication; that is not a production security design.
- Claim viewport is an explicit test button. Automatic activation/focus ownership through Portal remains to be wired. Other clients passively follow a claim; passive view layout changes do not claim it.
- Only one browser/profile and left-click forwarding are implemented. Workspace profiles/tabs, full input/IME, touch/scroll, cursor display, browser popups, clipboard, downloads and file uploads remain open. Popup paints log as unsupported; they are not silently accepted as complete browser coverage.
- Native presentation copies a completed framebuffer into a CGImage, with at most one queued presentation copy. This is deliberately simple and not an optimized dirty-region Metal upload path.
- Last-viewer detachment leaves CEF running, but unused paint/capture work is not suspended. Long-duration lifecycle, crash recovery and production backpressure are not established.
- The first matched input-to-decoded-pixel, scrolling/bandwidth, CPU/RSS and 1×/2× density measurements are in [the comparison report](../browser-remoting-comparison/README.md). Physical display latency/color, GPU-enabled rendering, real-app coverage and long-duration behavior remain unmeasured. The current 2× iPad RFB scrolling cadence is below the provisional 30 FPS goal.

The matched comparison supports a bounded iPad RFB optimization pass using public library APIs and native image presentation. Keep expansion of the custom Viz compositor paused and retain WebRTC as the implementation baseline while that decision remains open. Audio remains deferred.

## Reproduction

All generated dependencies, apps, profiles and build products live under ignored `.build/`. No installed dependency source was modified. Native source and the experiment scripts are outside that directory. No root/product checks were needed because this work only changes isolated experiments and research evidence.

1. Download the LibVNC archive in `pin.json`, verify SHA-256, and extract into `.build/`.
2. Run `python3 experiments/rfb-spike/build-libraries.py` and `python3 experiments/rfb-spike/build-native.py`.
3. Build `server.c`, `probe.c` and `snapshot.m` against the resulting static libraries (zlib plus Foundation/ImageIO/CoreGraphics for the snapshot tool). `run-synthetic.py` rebuilds the synthetic Mac server and the remote Linux server before running its matrix; the diagnostic client must already be built.
4. Install the generated iPad app with `devicectl`; launch using `RFB_HOST` and `RFB_PORT` environment variables. Launch the Mac app executable with the same variables. Tests use ports 15910–15916.
5. Download the matching CEF archives in `cef-pin.json`, verify the published SHA-1 and recorded SHA-256, and extract. Configure each distribution with CMake `-DCMAKE_BUILD_TYPE=Release -DUSE_SANDBOX=OFF` (also `-DPROJECT_ARCH=arm64` on Mac), then build target `libcef_dll_wrapper` with four jobs.
6. Run `build-cef-mac.py` to assemble the Mac app and helper bundles. For Linux, link `cef-host.cc` to the wrapper, `libcef.so`, `libvncserver.so.1`, dl and pthread; place it alongside the CEF Release and Resources files. `CEF_RESOURCES` points to that assembled runtime.
7. Start the Host with `cef-host bind-ip port seconds task-profile file:///.../page.html`. Linux uses `--ozone-platform=headless --no-first-run --no-default-browser-check --password-store=basic` with DISPLAY unset. DevTools listens on loopback port 19229.
8. Use `control.ts` to freeze or resume the owned page through CDP. Use `snapshot` to save received pixels, then `experiments/remote-viz-spike/tools/compare_images.py` for exact comparisons. Linux CDP is forwarded over SSH to Mac port 19230; its RFB display uses direct Tailscale connectivity.

The successful controls were also used to verify input and persisted task-profile state. Production profiles, credentials, Portal instances and the completed remote Chromium/Viz build remain untouched.
