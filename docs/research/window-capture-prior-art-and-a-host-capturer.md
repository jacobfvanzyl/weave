# Window capture prior art, and a capturer in the Host

Research snapshot, 2026-11-15. Primary sources only: clones read at the commits in section 1, Apple's documentation through its JSON pages, three WWDC transcripts, two Apple Developer Forums replies by Apple staff, the WebCodecs specification's source, and Tauri 2.12.5 and wry 0.57.2 as the app's lockfile pins them. Nothing was built, installed or run, and no stream was seen. Weave is judged at `6bdd342c`. Sections 1 to 9 are facts. Section 10 lists what wasn't verified. Sections 11 and 12 are analysis for weave and a spike shape, not a plan.

This note follows [Sill's window streaming, and a screen Block](sill-window-streaming-and-a-screen-block.md), "the Sill note" below, and doesn't repeat it. Since that note the person has chosen a direction for a spike: **the weave Host itself acts as a virtual display handler and captures one window per Block**. Two requirements came with it: as little overhead as possible on the Mac, and a Mac must be able to show its own windows in the weave app, the Mac's app showing a window of the same Mac's Host.

The question: what Sunshine, Moonlight and other open projects do that such a capturer should take, what costs a capture pipeline its CPU and energy, how a Mac shows its own window without encoding and decoding it, and who can hold the permissions.

## In brief

- **Sunshine on a Mac captures displays only, and has no virtual display.** It uses ScreenCaptureKit with a display filter on macOS 14 and later, and encodes with VideoToolbox directly from the captured pixel buffers. Apollo's virtual display is a Windows driver. No open project read here does per-window capture on a virtual display except Sill.
- **What makes Sunshine and Moonlight fast is mostly not available to weave as it stands.** UDP with forward error correction, loss reports every 50 ms and reference-frame invalidation all assume a datagram path between the two ends. Weave's devices reach a Host over TCP through the Dispatcher. VideoToolbox has no reference-frame invalidation either, so Sunshine falls back to a keyframe on a Mac.
- **What does carry over is the encoder discipline**: hardware only, low-latency rate control, no frame reordering, an unbounded keyframe interval with keyframes on request, one frame in the encoder at a time, and the capture's pixel buffers handed to the encoder untouched.
- **Apple's own guidance gives the low-overhead recipe**: capture in a 4:2:0 format for encoding, let ScreenCaptureKit scale in hardware to the output size, skip frames whose status is idle, and return surfaces to the pool fast. The low-latency encoder mode "always uses a hardware-accelerated video encoder in order to save powers" (WWDC21).
- **On one Mac, no codec is needed.** DeskPad shows a virtual display in its own window by assigning each captured `IOSurface` to a layer's `contents`. An `IOSurface` can also cross processes through a Mach port or an XPC object. Tauri gives the Mac app its `NSWindow` and `WKWebView`, and a transparent web view through a private key behind a feature flag.
- **Permissions follow a code signature, and the Host has none that lasts.** Apple's TN3127: ad hoc signed code "has a DR but it's tied to that specific version of the code", so macOS "can't reliably track the identity". For a launchd agent, Apple's forum reply is that TCC "has to be able to identify some app as the responsible code". The Mac app is already signed with an Apple Development identity.
- **The virtual display is private API with real costs**: an AppKit event loop in the owning process, a cursor that can wander onto it, and one open report of `kernel_task` growth in Sill.

## 1. What was read

| Project | Commit | Licence | Read |
| --- | --- | --- | --- |
| [Sunshine](https://github.com/LizardByte/Sunshine) (GitHub now names it `SunshineStream/Sunshine`; 43,444 stars) | [`43b74505`](https://github.com/LizardByte/Sunshine/tree/43b74505bc938e2a044d83b11a1ce13199a75753), 2026-11-15 | GPL-3.0 | `src/platform/macos/`, parts of `src/stream.cpp`, `src/video.cpp`, `docs/` |
| [moonlight-common-c](https://github.com/moonlight-stream/moonlight-common-c) | [`94c65fd3`](https://github.com/moonlight-stream/moonlight-common-c/tree/94c65fd364d17b223f00a8763c9a5d94a66cb8dd), 2026-11-13 | GPL-3.0 | `Limelight.h`, greps of the control, RTSP and video queue sources |
| [moonlight-ios](https://github.com/moonlight-stream/moonlight-ios) | `02dc9780`, 2026-09-26 | GPL-3.0 | one file through the API, `VideoDecoderRenderer.m` |
| [Apollo](https://github.com/ClassicOldSong/Apollo) | `adc5c5a0`, 2026-05-21 | GPL-3.0 | `README.md`, the platform directories' listings |
| [RustDesk](https://github.com/rustdesk/rustdesk) | `7949eca1`, 2026-11-15 | AGPL-3.0 | `libs/scrap/src/quartz/`, greps of `libs/scrap` |
| [scrcpy](https://github.com/Genymobile/scrcpy) | `a60891ae`, 2026-10-08 | Apache-2.0 | `doc/develop.md`, `SurfaceEncoder.java` |
| [neko](https://github.com/m1k1o/neko) | `4d0bb35b`, 2026-11-13 | Apache-2.0 | `README.md` only |
| [DeskPad](https://github.com/Stengo/DeskPad) | [`c3349f0e`](https://github.com/Stengo/DeskPad/tree/c3349f0e237e000cb4826fb3ea1cdd1c44949461), 2026-02-28 | MIT | the private header, the screen view, the mouse side effect, `README.md` |
| [screencapturekit-rs](https://github.com/doom-fish/screencapturekit-rs) | `c11c9a95`, 2026-11-02, version 11.1.2 | MIT or Apache-2.0 | `Cargo.toml`, `README.md`, the filter and surface modules' signatures |
| [objc2](https://github.com/madsmtm/objc2) | `8a5abacd`, 2026-10-17, framework crates 0.3.2 | Zlib, Apache-2.0 or MIT (the core crates MIT) | `LICENSE.md`, the framework crates' feature lists |
| [Sill](https://github.com/Saffsanity/sill) | `aea35475`, as the Sill note | Apache-2.0 | `VirtualDisplay.swift` and `VirtualStage.swift` header comments |

The GPL and AGPL projects were read for their design. Their code can't be taken into weave without taking their licence.

## 2. Sunshine on a Mac

- **Capture is of a display, never a window.** `SCCapture` builds `[[SCContentFilter alloc] initWithDisplay:display excludingWindows:@[]]`, on macOS 14 or later, and falls back to AVFoundation's `AVCaptureScreenInput` if a stream won't start (`src/platform/macos/sc_capture.mm`, `sc_capture_loop.h`, `av_video.m`). No window filter and no `CGVirtualDisplay` were found in `src/platform/macos/`.
- **Capture settings.** The cursor is in the picture (`showsCursor = YES`), the resolution is `SCCaptureResolutionBest`, and the queue depth is 8, "the documented maximum", because "WindowServer only delivers while it has a free surface, so the pipeline must keep the number of sample buffers it holds at once … well below this, or delivery stalls". The frame interval is nine tenths of one over the frame rate: "an interval of exactly 1/fps beats against WindowServer's delivery clock and suppresses frames that arrive marginally early" (`sc_capture.mm`).
- **The newest frame wins.** A delivered sample buffer replaces the one waiting, and the comment says "No SCFrameStatus filtering: any sample buffer carrying pixels is a real update" (`sc_capture.mm`).
- **The pixel format is the encoder's.** The encoder asks the capture for 8-bit or 10-bit 4:2:0 biplanar video range before the stream starts, and then "encodes captured CVPixelBuffers directly through a VTCompressionSession" (`vt_encoder.mm`, file header and line 363). No colour conversion on the CPU was found on this path.
- **Encoder settings** (`vt_encoder.mm`): hardware required, since "VideoToolbox's software encoder is far slower than Sunshine's own"; `EnableLowLatencyRateControl` tried for H.264 anywhere and for any codec on Apple silicon, with a fall back to standard rate control; `RealTime`; `AllowFrameReordering` off; `MaxKeyFrameInterval` at the integer maximum, with `ForceKeyFrame` per frame when asked; `AverageBitRate`, and "no DataRateLimits under low-latency rate control: with a hard byte window it drops frames". `EnableLTR` is turned off for H.264 because "some client hardware decoders mishandle that and freeze".
- **One frame in flight.** "The session is driven strictly one frame in flight: each submission blocks until the output callback delivers the encoded frame" (`vt_encoder.mm`).
- **No reference-frame invalidation on a Mac.** "VideoToolbox has no reference frame invalidation; recover with an IDR frame instead" (`src/video.cpp`, line 659). Only its NVENC encoder carries the `REF_FRAMES_INVALIDATION` flag in the lines read.
- **A static screen still sends frames.** "Because many clients expect a constant stream of video frames, a certain amount of duplicate frames are sent"; the floor defaults to half the frame rate (`docs/configuration.md`, `minimum_fps_target`; `src/video.cpp`, line 2552).
- **Permissions.** Sunshine asks for Screen Recording and for posting events (`CGRequestScreenCaptureAccess`, `CGRequestPostEventAccess`), and "restarts once after missing required permissions are granted". Its advice on signing: "Development builds should use a consistent Apple-issued signing identity so macOS can recognize the app across updates", and if a switch is on but access is denied, "remove that Sunshine entry and add the installed app again" (`docs/getting_started.md`, `src/platform/macos/misc.mm`).
- **Apollo's virtual display is Windows only.** "Currently Virtual Display support is Windows only", through the SudoVDA driver; "the virtual display is created upon the stream starts and removed once the app quits", and each client gets "a fixed identity … so your display configuration will be automatically remembered" (`README.md`). Its `src/platform/macos/` has no virtual display file.

## 3. The GameStream protocol, as Sunshine and Moonlight speak it

- **Channels.** An RTSP handshake over TCP (`OPTIONS`, `DESCRIBE`, `SETUP`, `ANNOUNCE`, `PLAY` in moonlight-common-c's `RtspConnection.c`), video and audio as RTP over UDP sockets of their own (`src/stream.cpp`), and a control stream over ENet with reliable and unsequenced packets (`ControlStream.c`).
- **Forward error correction.** Reed-Solomon parity per video frame, 20 percent by default, "at the cost of increasing bandwidth usage" (`docs/configuration.md`, `fec_percentage`; `src/stream.cpp`). Moonlight's bitrate note: the video bitrate is "about 20% lower when using the standard 20% FEC configuration" (`Limelight.h`).
- **Loss is reported, not retransmitted.** The client sends loss statistics every 50 ms and a ping every 100 ms (`ControlStream.c`, `LOSS_REPORT_INTERVAL_MS`, `PERIODIC_PING_INTERVAL_MS`).
- **Recovery without a keyframe, where the encoder can.** The client sends `IDX_INVALIDATE_REF_FRAMES` with a first and last frame, or `IDX_REQUEST_IDR_FRAME` (`src/stream.cpp`). A renderer declares `CAPABILITY_REFERENCE_FRAME_INVALIDATION_AVC`, `_HEVC` or `_AV1`; a decoder that can't go on returns `DR_NEED_IDR` (`Limelight.h`).
- **Pacing inside a frame.** The sender spreads a frame's packets in batches against a per-millisecond budget rather than sending them at once (`src/stream.cpp`, "Do pacing within the frame").
- **Packet size.** "Max video packet size in bytes (use 1024 if unsure)", capped at 1024 for a remote stream "to avoid MTU-related issues" (`Limelight.h`).
- **Remote or local** is guessed from whether the address is in the RFC 1918 blocks (`STREAM_CFG_AUTO`, `Limelight.h`).
- **Moonlight on iOS** draws with an `AVSampleBufferDisplayLayer` and a `CADisplayLink` at the stream's frame rate, with optional frame pacing (`VideoDecoderRenderer.m`), as Sill's device app does.
- **Pairing** is a PIN exchange over HTTPS with certificates (`src/nvhttp.cpp`, `getservercert`). It wasn't read further.

## 4. Other projects

- **RustDesk** captures a Mac's display with `CGDisplayStreamCreateWithDispatchQueue`, passes on frames whose status is `FrameComplete`, and compares each with the last, returning would-block when equal (`libs/scrap/src/quartz/capturer.rs`, `libs/scrap/src/common/quartz.rs`). Apple's macOS 15 notes call that API deprecated (section 5). VideoToolbox appears in its hardware codec list (`libs/scrap/src/common/hwcodec.rs`). No per-window capture was found.
- **scrcpy** is the smallest framing of the lot: a 12-byte header per packet holding a config flag, a key frame flag, a 61-bit timestamp and a 32-bit size, and a 12-byte packet with the width and height when the size changes. The client "decodes the video frames, and displays them as soon as possible, without buffering" (`doc/develop.md`). Its encoder repeats the last frame after 100 ms of no change and makes a keyframe every 10 seconds (`SurfaceEncoder.java`).
- **neko** streams a desktop in a Linux container over WebRTC: "Smooth video because it uses WebRTC and not images sent over WebSockets" (`README.md`). Nothing in it captures a Mac. What WebRTC brings to a browser client was not read from its source.
- **DeskPad** is the open project nearest to "a Mac showing its own windows". It makes a virtual display and "mirrors" it in its own window (`README.md`). See sections 7 and 8.
- **screencapturekit-rs** (crate `screencapturekit` 11.1.2) offers a window filter (`SCContentFilter::create().with_window(&window)`), `IOSurface` access and a frame status module, and names "zero-copy frame delivery via `IOSurface` / Metal". It builds a Swift bridge, so it needs the Swift toolchain: its troubleshooting says "Build fails with Swift bridge errors | `xcode-select --install`". It has no encoder.
- **objc2's framework crates** are generated from Apple's SDKs. `objc2-screen-capture-kit` has features for `SCStream`, `SCShareableContent` and `SCContentSharingPicker`, `objc2-video-toolbox` for `VTCompressionSession` and its properties, and `objc2-io-surface` for the surface. They need no Swift. The app's shell already links this generation through Tauri: `objc2` 0.6.5 and `objc2-app-kit`, `objc2-io-surface`, `objc2-quartz-core` and `objc2-web-kit` 0.3.2 (weave, `app/src-tauri/Cargo.lock`).

## 5. ScreenCaptureKit, from Apple

- **One window.** `init(desktopIndependentWindow:)` "creates a filter that captures only the specified window" ([reference](https://developer.apple.com/documentation/screencapturekit/sccontentfilter/init(desktopindependentwindow:)), macOS 12.3). "No child, pop-up, or other windows … will be included" ([WWDC22, session 10155](https://developer.apple.com/videos/play/wwdc2022/10155/)).
- **Covered and off-screen windows.** "When the source window is occluded or partially occluded, the stream output always includes the window's full content. And this also applies to the case when the window is completely off-screen or moved to other displays." A minimized window pauses the stream until it is restored (same session).
- **Sill's finding sits beside that, not against it.** Its stage exists because "ScreenCaptureKit only delivers frames when a window repaints, and macOS stops repainting a window that is fully covered" (Sill, `VirtualStage.swift`). Apple's sentence is about what a frame holds; Sill's is about whether new frames come.
- **Scaling is done for you.** "ScreenCaptureKit always performs hardware scaling on the captured window so it never exceeds the frame output as the source window resizes" (WWDC22). `scalesToFit` is used "during independent window capture", and `sourceRect` is ignored for a single window ([scalesToFit](https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration/scalestofit), [sourceRect](https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration/sourcerect)).
- **Frame rate.** `minimumFrameInterval` defaults to 0, "the maximum supported frame rate"; with 1/60, "you will receive frame update no more than 60 fps, and no more than the content's native frame rate" ([reference](https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration/minimumframeinterval), WWDC22).
- **Idle frames are marked.** `SCFrameStatus.idle` is "a status that indicates the system didn't generate a new frame because the display didn't change", read from the sample buffer's attachments ([reference](https://developer.apple.com/documentation/screencapturekit/scframestatus/idle)).
- **Dirty rectangles.** `dirtyRects` gives "the areas of a video frame that contain changes"; Apple suggests using them "to only encode and transmit the regions with new updates" ([reference](https://developer.apple.com/documentation/screencapturekit/scstreamframeinfo/dirtyrects), WWDC22).
- **The surface pool.** `queueDepth` is three to eight, three by default. "The number of surfaces left in the pool … equals the queue depth minus the number of surfaces held by your app", and holding them too long means the stream "enters a stall, and will start to miss new frames" (WWDC22).
- **Pixel format.** "Use pixel format YUV420 for encoding and streaming", and "BGRA pixel format for onscreen display" (WWDC22). Sunshine's comment lists what Apple documents: "only BGRA, l10r, 420v and 420f".
- **The cursor** "is visible by default" and `showsCursor` turns it off ([reference](https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration/showscursor)).
- **A running stream can be changed** with `updateConfiguration` and `updateContentFilter`, both macOS 12.3.
- **Measured by Apple, in OBS.** Against OBS's older window capture, which dipped "as low as 7 fps", ScreenCaptureKit delivered 60 fps, with "up to 15 percent less RAM" and CPU "cut by up to half" (WWDC22).
- **Permission.** "The first time you run this sample, the system prompts you to grant the app Screen Recording permission. After you grant permission, you need to restart the app to enable capture" ([sample](https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-in-macos)). `CGPreflightScreenCaptureAccess` and `CGRequestScreenCaptureAccess` exist since macOS 10.15; their pages have no text.
- **The system picker.** `SCContentSharingPicker` (macOS 14) is "a picker presented by the operating system"; "the system shares an SCContentFilter with your application", and every stream shows in "a new Video menu bar item" with a live preview ([reference](https://developer.apple.com/documentation/screencapturekit/sccontentsharingpicker), [WWDC23, session 10136](https://developer.apple.com/videos/play/wwdc2023/10136/)).
- **macOS 15.** "Applications utilizing deprecated APIs for content capture such as `CGDisplayStream` & `CGWindowListCreateImage` can trigger system alerts indicating they might be able to collect detailed information about the user. Developers need to migrate to `ScreenCaptureKit` and `SCContentSharingPicker`" ([release notes](https://developer.apple.com/documentation/macos-release-notes/macos-15-release-notes)).

## 6. VideoToolbox, from Apple

- **Low-latency rate control.** `kVTVideoEncoderSpecification_EnableLowLatencyRateControl` (macOS 11.3) "enforces the following behaviors: Infinite GOP (all P frames following the beginning IDR). No frame reordering (B frame) or looking ahead. Only High profiles … Temporal Layer structure" ([reference](https://developer.apple.com/documentation/videotoolbox/kvtvideoencoderspecification_enablelowlatencyratecontrol)).
- **It is hardware, and it was H.264.** "The low-latency mode always uses a hardware-accelerated video encoder in order to save powers", "the supported video codec type in this mode is H.264", and it "can reduce the delay of up to 100 milliseconds for a 720p 30fps video" ([WWDC21, session 10158](https://developer.apple.com/videos/play/wwdc2021/10158/)). Sunshine tries it for HEVC on Apple silicon and logs which mode it got (section 2).
- **Long-term references** are VideoToolbox's answer to loss. With `EnableLTR`, the receiver acknowledges frames, and `ForceLTRRefresh` then makes a frame "predicted from one of these acknowledged LTRs", which "is much smaller … compared to a key frame"; with none acknowledged "the encoder will generate a key frame" (WWDC21; `kVTCompressionPropertyKey_EnableLTR`, macOS 12).
- **Real time.** `kVTCompressionPropertyKey_RealTime` recommends "that encoding stay timely"; `PrioritizeEncodingSpeedOverQuality` (macOS 11) is "a hint … to maximize its speed"; `MaximumRealTimeFrameRate` (macOS 15) tells the encoder "the maximum possible rate" of frames.
- **The hardware encoder can be busy.** `RequireHardwareAcceleratedVideoEncoder` fails the session when "the hardware encoding resources on the machine are busy" ([reference](https://developer.apple.com/documentation/videotoolbox/kvtvideoencoderspecification_requirehardwareacceleratedvideoencoder)). Sill measured it: 57 fps fell to 33 to 36 beside another encoder (the Sill note, section 4).
- **The input is an image buffer.** `VTCompressionSessionEncodeFrame` takes the buffer and "the session and/or encoder retains the image buffer as long as necessary" ([reference](https://developer.apple.com/documentation/videotoolbox/vtcompressionsessionencodeframe(_:imagebuffer:presentationtimestamp:duration:frameproperties:sourceframerefcon:infoflagsout:))). Apple's page doesn't use the words zero copy.

## 7. The virtual display

- **It is private.** Sill: the four classes "live in CoreGraphics.framework but are in no public header. They have existed since macOS 11 … but Apple can rename or remove them in any release" (`VirtualDisplay.swift`). DeskPad carries the header as `CGVirtualDisplayPrivate.h`, credited to another author in 2021. A header dump of macOS 26.4 still lists `CGVirtualDisplay`, `CGVirtualDisplayDescriptor`, `CGVirtualDisplayMode` and `CGVirtualDisplaySettings` ([thatmarcel/macOS-26.4-headers](https://github.com/thatmarcel/macOS-26.4-headers)). Apple documents none of them.
- **Its shape** (DeskPad's header): a descriptor with a name, maximum pixels, a size in millimetres, vendor, product and serial numbers, a queue and a termination handler; settings with a list of modes (width, height, refresh rate) and `hiDPI`; and `applySettings:`.
- **HiDPI.** DeskPad sets `hiDPI = 1` with fifteen modes. Sill gives one mode in points, and "with hiDPI = 1 macOS derives two modes" (`VirtualDisplay.swift`, line 178).
- **Arrangement is remembered by identity.** "macOS remembers a display's arrangement … and chosen mode by vendorID/productID/serial. Keep those stable" (Sill). DeskPad: "Launching the app is equivalent to plugging in a monitor, so macOS will take care of properly arranging your windows to their previous configuration" (`README.md`).
- **Lifetime.** "The display exists exactly as long as this object holds the `CGVirtualDisplay` instance … windows on it are moved back to a real display by the window server. If the process dies the display goes with it." The window server may also remove it "on its own (sleep, display arbitration)", which the termination handler reports (Sill, `VirtualDisplay.swift`, `VirtualStage.swift`).
- **The event loop** it needs is in the Sill note, section 3.
- **The cursor can go there.** DeskPad polls the mouse every 0.25 s to see whether it is on the virtual display, then "will highlight its title bar in blue and move the application window to the front to let you know where you are"; a click in its window calls `CGDisplayMoveCursorToPoint` (`MouseLocationSideEffect.swift`, `README.md`). Sill records where the cursor was "before the host first drove it onto the virtual display" and warps it back on release (`VirtualStage.swift`).
- **Other windows land there.** Sill evicts them: "a stranger there covers the staged window and takes its clicks" (`VirtualStage.swift`).
- **Sill captures the display, not the window**, on the virtual display: it "hands the coordinator a display filter plus the crop rectangle of the window on it" (`VirtualStage.swift`).
- **Open users found by a code search** for the descriptor class include DeskPad, Sill, BetterCast, SideScreen, opendisplay and a script in cmux's tests. They weren't read.

## 8. One Mac: showing a window without a codec

- **DeskPad does it in one process.** Its stream handler is `self?.view.layer?.contents = surface`, where the surface is the `IOSurface` each frame arrives as (`ScreenViewController.swift`). No encoder, no copy in its code. It uses `CGDisplayStream`, the API section 5 says now alerts.
- **A layer takes an image as contents.** Apple's page for `CALayer.contents` names `CGImage` and `NSImage`; it doesn't name `IOSurface` ([reference](https://developer.apple.com/documentation/quartzcore/calayer/contents)).
- **A surface crosses processes.** IOSurface is "a framebuffer object suitable for sharing across process boundaries". `IOSurfaceCreateMachPort` is for when "you need to atomically or securely pass an IOSurface to another task without making the surface global to the entire system", `IOSurfaceLookupFromMachPort` rebuilds it, and `IOSurfaceCreateXPCObject` wraps it for XPC. `kIOSurfaceIsGlobal`, which let "any task in the system" look a surface up by ID, is deprecated since macOS 10.11 ([IOSurface](https://developer.apple.com/documentation/iosurface)).
- **Tauri hands over the native views.** `WebviewWindow::ns_window`, `ns_view` and `with_webview` (whose `inner()` is the `WKWebView`) are in Tauri 2.12.5 (`src/webview/webview_window.rs`).
- **A transparent web view uses a private key.** wry sets `drawsBackground` to false on the configuration and comments "NOTE: Private API — `drawsBackground` is a private KVC key" (`wry-0.57.2/src/wkwebview/mod.rs`). Tauri puts it behind its `macos-private-api` feature. The weave app sets neither transparency nor that feature today (`app/src-tauri/src/lib.rs`).
- **Child web views** are behind Tauri's `unstable` feature (`Window::add_child`, `src/window/mod.rs`), built with wry's `build_as_child`.
- **Electron has the same idea.** Its offscreen rendering has a shared texture mode where "the frames are directly copied in GPU textures, thus this mode is very fast", and which needs "a native node module" ([Electron docs](https://www.electronjs.org/docs/latest/tutorial/offscreen-rendering)). The page doesn't say what handle a Mac gets.
- **Raw frames in the page.** WebCodecs has `VideoFrame(AllowSharedBufferSource data, VideoFrameBufferInit init)` with `NV12`, `I420` and `BGRA` among its formats, and without `transfer` it makes "a new media resource containing a copy of data" ([spec source](https://github.com/w3c/webcodecs/blob/main/index.src.html), lines 3433, 3688, 4605 to 4635).
- **The decoder's latency hint.** `optimizeForLatency` is a "hint that the selected decoder SHOULD be configured to minimize the number of EncodedVideoChunks that have to be decoded before a VideoFrame is output" (same source, line 2137).

## 9. Input and permissions, from Apple and weave

- **Posting events.** `CGEvent.post(tap:)` "posts a Quartz event into the event stream at a specified location". `postToPid(_:)` exists since macOS 10.11 and its page has no text. `CGPreflightPostEventAccess` and `CGRequestPostEventAccess` exist since macOS 10.15, also without text. Sunshine files the second under `Privacy_Accessibility` (`misc.mm`).
- **Accessibility.** `AXIsProcessTrustedWithOptions` "returns whether the current process is a trusted accessibility client". `kAXPositionAttribute` is "the global screen coordinates of the top-left corner", with 0,0 at the corner "of the screen that displays the menu bar".
- **Grants follow the designated requirement.** macOS records "your app's DR in its database of apps authorized" and checks each later version against it. "Unsigned code has no DR. Ad hoc signed code … has a DR but it's tied to that specific version of the code. In both cases macOS can't reliably track the identity of the code … If you tweak the code and run it again, macOS repeats that prompt" ([TN3127](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements)).
- **Identities differ.** A build signed with an Apple Development identity "gets a different DR than a distribution build signed with your Developer ID", so a grant to one doesn't reach the other (TN3127).
- **A launchd agent needs responsible code.** "For this to work the TCC subsystem has to be able to identify some app as the responsible code for your agent. For example, if your agent were a helper tool embedded in an app, TCC would recognise that and treat the app as the responsible code, using its name in the permission alert" (Apple staff, [forums thread 694948](https://developer.apple.com/forums/thread/694948), November 2021, on screen capture from a launch agent).
- **Responsible code needn't be running.** "It's common for there to be responsible code but no responsible process. For example, if an app has a login item, the login item might be running when the app is not." And "there is no general API for managing this" (Apple staff, [forums thread 731504](https://developer.apple.com/forums/thread/731504), June 2023).
- **launchd's own note.** `AssociatedBundleIdentifiers` "indicates which bundles are associated with this job in the System Settings Login Items UI"; and "daemons and agents managed by launchd are subject to macOS user privacy protections" (`man launchd.plist` on macOS 27.2).
- **The entitlement for remote desktops.** Persistent Content Capture "enables VNC apps to view and record the screen", and is granted on request (the Sill note, section 9).
- **The Host on a Mac** is a launchd agent whose plist has a label, `ProgramArguments`, `RunAtLoad`, `KeepAlive` and log paths, and no `AssociatedBundleIdentifiers` or `MachServices` (weave, `cli/src/service/launchd.rs`, `render`). Its binary is whatever `cargo build --release` linked, copied to `~/.local/bin/weave` when it differs, with no `codesign` step (`scripts/update-hosts`).
- **The helper precedent.** `weave-holder` is built and copied beside `weave` by the same script, started by the Host "outside its own process tree" (ADR 0022).
- **The Mac app is signed.** `bun run mac:install` "signs with the Apple Development identity of the iOS app's team, or ad hoc (`WEAVE_SIGNING_IDENTITY` names another), and isn't notarized" (weave, `app/AGENTS.md`, `app/scripts/mac.ts`). Its bundle id is `com.veezee.weave`, and it reaches this Mac's Host "over its Unix socket" and terminals on `terminals.sock` (`app/AGENTS.md`).
- **A carried connection is one of two kinds**, `Host` or `Terminal` (weave, `protocol/src/dispatcher.rs`, `CarriedStream`).

## 10. Not verified

- **Nothing was run.** No capture, no encode, no layer, no grant. Every cost and latency figure above is its source's.
- **Partial reading.** Sunshine's protocol was read by search, not through; pairing and encryption barely. moonlight-qt wasn't read, and moonlight-ios only in one file. neko's source wasn't read. BetterDisplay and Chromium's test harness, which Sill's comment names as users of the virtual display, weren't found or read.
- **Whether a bare binary run by launchd can hold Screen Recording or Accessibility at all**, which process TCC holds responsible when the Host starts a helper, and whether a grant to an ad hoc signed binary survives a rebuild. Apple's two statements (section 9) point one way; neither is a test.
- **Whether a self-signed identity gives a designated requirement stable enough for TCC.** TN3127 covers Apple-issued identities. Not found.
- **Whether `SCContentSharingPicker` spares an app the Screen Recording permission.** Neither its reference page nor the WWDC23 transcript says so.
- **macOS 15's recurring Screen Recording reminder.** Apple's release notes speak only of alerts for the deprecated APIs.
- **Low-latency rate control with HEVC.** Apple's sources say H.264 and "only High profiles". Sunshine's code tries it for HEVC on Apple silicon; whether it succeeds wasn't seen.
- **How many hardware encoder sessions a Mac runs at once**, and what a second costs the first, beyond Sill's one measurement.
- **`CGEventPostToPid`'s behaviour**: whether it reaches a window that isn't frontmost, or on another display, without moving the cursor. Apple's page is empty.
- **Assigning an `IOSurface` to `CALayer.contents`.** DeskPad does it; Apple's page doesn't list it.
- **Passing a surface from a launchd agent to the app.** The Mach port and XPC calls exist. Whether an agent with no `MachServices` entry and an app with no XPC service can exchange one in practice wasn't tested, and a Unix socket carrying one wasn't found in Apple's documentation.
- **`CGVirtualDisplay` limits**: how many at once, the largest mode, behaviour across sleep, and the `kernel_task` report in Sill's #359.
- **Display arrangement** by `CGConfigureDisplayOrigin` or otherwise, to keep the cursor from reaching a virtual display. Not looked up.
- **WebCodecs in the app's `WKWebView`**, on the Mac and on iOS: support, hardware decode, `VideoFrame` from a buffer, and latency. As in the Sill note.
- **Tauri's `unstable` child web views and transparent web view on macOS 27** were read in source, not tried.

## 11. The two requirements

Analysis from here on.

### 11.1 What costs CPU, GPU and energy, and how to avoid each

- **Frames nobody needs.** The window server composes a frame for every capture stream that asks. Ask for the Block's frame rate at most, and take none while no device shows the Block: Sill stops everything with no device connected, and a Block that is off-screen in the app, in a hidden tab, should count as not shown.
- **Frames that didn't change.** Drop every frame whose status is idle before the encoder sees it. Sunshine doesn't filter, and then pads a static screen to half the frame rate because Moonlight's clients want a steady stream. A weave page has no such need: a static window should cost no encoding at all, and scrcpy's 100 ms repeat is the most a client-side jitter estimate would want.
- **Copies and colour conversion.** Ask ScreenCaptureKit for 4:2:0 biplanar, as Apple says and Sunshine and Sill do, and hand the buffer to the encoder as it came. The conversion from the window server's BGRA then happens on the GPU inside the capture, once.
- **Scaling after capture.** Set the stream's width and height to the Block's pixel size on the showing device and let ScreenCaptureKit scale. On a virtual display sized for the Block the window is already that size and nothing scales.
- **Software encoding.** Require hardware and treat failure as an error to show, as Sunshine does, since the fallback costs a CPU core. Sill's fallback to software "while that is busy" is the opposite choice, made for a single stream.
- **Encoder work per frame.** Low-latency rate control where it is granted, no reordering, no periodic keyframes. A keyframe every few seconds, as Sill sends, costs bitrate for a window that is mostly still; an unbounded interval with keyframes on request, as Sunshine and Apple's low-latency mode have it, costs nothing while still.
- **Held surfaces.** Keep at most the newest frame and the one in the encoder. Both Sunshine's comment and Apple's session say a held surface stalls delivery.
- **Several streams.** One encoder session per window per size. Two devices showing a Block at one size should share a session. Each further session contends for the one hardware encoder, by Apple's page and Sill's measurement, so the count is a budget the Host should keep and the spike should measure.
- **The cursor.** Leave it out of the capture (`showsCursor` off) and send it apart, as Sill does, so a moving pointer alone makes no video frames.
- **Dirty rectangles** are a further saving Apple names, at the price of a codec of weave's own. Not for a spike.

The numbers a source states: Apple's "up to 100 milliseconds" saved at 720p30 in low-latency mode, OBS's CPU "cut by up to half" and RAM down 15 percent against the older window capture, and Sill's 57 to 33 to 36 fps beside a second encoder. None is a cost in watts or percent of a core for one window, which is what the spike must produce.

### 11.2 A Mac showing its own windows

The capturer and the viewer are one computer, so encoding and decoding again is the waste to avoid. Four ways, cheapest in new code first.

1. **The same HEVC stream, over loopback.** No new path: the Host's stream reaches the page as a terminal's does. It costs one hardware encode and one decode per frame that changes, plus two copies of the compressed frame. This is the baseline, and it may be small: both ends are hardware, and a still window sends nothing. *Possible in Tauri today*, if the page decodes at all (section 10).
2. **Raw frames to the page.** A `VideoFrame` from a buffer copies it unless transferred, and the bytes still cross the loopback WebSocket. By arithmetic, a window of 1600 by 1000 points at 2x is 3200 by 2000 pixels: 25.6 MB a frame as BGRA, 9.6 MB as NV12, so 576 MB a second at 60 fps in the cheaper format before any copy inside WebKit. This spends memory bandwidth to save an encoder that is hardware anyway. *Possible, and not worth trying first.*
3. **A native layer where the Block is, fed surfaces by the Host's capturer.** The capturer sends each frame's `IOSurface` to the app's core by Mach port or XPC; the core sets it as the contents of a layer in the app's window, as DeskPad does in one process. No encode, no decode, no copy. Two placements:
   - *Above the web view*, as a sibling view. No transparency and no private key. Nothing the page draws can overlap the Block: a menu, a floating Block or a drag preview would pass under the picture. Wry's child web views sit this way.
   - *Under a transparent web view*, with the page leaving a hole. Page content overlaps correctly. It needs Tauri's `macos-private-api` feature, a private key of WebKit's.
   Either way the layer's frame must track a DOM rectangle through scroll, drag, resize and tab changes. The page knows the rectangle a frame before the core does, so the layer lags the page by an IPC round trip unless the page stops animating around it. Floating and minimized Blocks, and the app's own zoom, each need a rule. *Possible in Tauri 2.12 through `ns_window` and `with_webview`*; the surface hand-off from a launchd agent is the unverified part.
4. **The app captures for itself.** The Mac app is a signed bundle that can hold Screen Recording, so it could run ScreenCaptureKit in its own process, put the surface in its own layer, and not involve the Host for windows of its own Mac. This removes the cross-process step and the Host's permission problem for the local case. It also makes two capturers with two permission holders, one for local viewing and one for devices, and a window shown on the Mac and the iPad at once would be captured twice. It is against the stated direction, and it is the fallback if the hand-off in 3 can't be made to work.

**Recursion.** A single-window filter never includes another window, so a Block showing some other app's window can't show the weave app inside itself. Only choosing the weave app's own window recurses, and the catalogue can leave it out. A display capture of a virtual display can't include the app either, as long as the app's window isn't on it.

**Focus and input, without a virtual display.** The window is on the person's real screen, perhaps under the weave app. A click posted at its position goes to whatever is frontmost there, which is the weave app itself. The window would have to be raised first, and then it covers the app. For the local case without a virtual display, a Block is honestly a live preview, and clicking it should bring the real window forward.

**What the virtual display changes.** The window leaves the real screen and exists only in the Block, which is DeskPad's model and is what "a window that lives in a Block" asks for. It keeps repainting, it is never covered, and it can be sized and scaled for the Block. Three things come with it:

- *One pointer.* Sill moves the Mac's cursor onto the virtual display for a person who is elsewhere. Here the person is at the Mac, and the cursor is theirs. Posting a click at the window's place on the virtual display takes the real cursor off the real screen. The choices are to capture the pointer while it is over the Block, as a virtual machine's window does, drawing a sprite in the Block and warping back on leaving; or to post to the process with `CGEventPostToPid` and leave the cursor alone, whose behaviour is unknown.
- *Activation.* Typing into the window means its app is active and the weave app isn't. The menu bar becomes the other app's. That may be acceptable, since it is what clicking any other window does.
- *The display is real to macOS.* The cursor can wander onto it, new windows can open on it, Mission Control shows it, and the person's arrangement gains an entry. DeskPad lives with this and tells the person where the cursor is; Sill evicts strangers and keeps the identity stable so the arrangement is remembered.

Whether the window should leave the screen is a product question the spike can inform and not settle: for an iOS Simulator beside its thread it reads well; for Xcode it may not.

### 11.3 Who holds the permissions

What the evidence supports:

- The Host binary is replaced on every update and isn't signed by the script. If the linker leaves it ad hoc signed, as is usual on Apple silicon but wasn't checked here, TN3127 says such a signature identifies one version; if it is unsigned, it has no designated requirement at all. Either way a grant to `~/.local/bin/weave` should be expected to lapse on every `scripts/update-hosts`, as Sill's notes also say.
- A launchd agent that is a bare tool has no app for TCC to name as responsible code, by Apple's forum reply. Whether it can be granted at all, by adding the binary by hand in System Settings, is not established.
- A stable designated requirement needs a signing identity that stays the same across builds. The repository has one already: the Apple Development identity the Mac app and the iOS app sign with. A Developer ID would be the distribution answer; a self-signed identity is untested.

Three holders, in the order the spike should try them:

1. **A helper inside the Mac app's bundle**, signed with the app, started by the Host from the bundle's path. Apple's reply covers this case in so many words: TCC "would recognise that and treat the app as the responsible code". The grant reads "Weave" in System Settings and survives Host updates. The Host then depends on the app being installed on that Mac, and the helper updates with the app, not with the Host.
2. **A helper beside the Host**, as `weave-holder` is, signed in `scripts/update-hosts` with the same identity under a fixed identifier. It keeps the Host self-contained. Whether TCC accepts a tool with no bundle, started by an agent, is the open question.
3. **The Host itself**, signed the same way. Simplest, and it puts AppKit's event loop and a private API in the process that holds every thread.

## 12. A spike shape

The smallest thing that answers the open questions, in weave's architecture.

- **Where the capturer lives.** A helper process, not the Host. The virtual display wants `NSApplication.run()` on a main thread, which the Host's runtime owns; a crash in private API shouldn't take threads with it; and the helper is the thing to sign and grant. One helper per Host, not per Block, holding every stream: unlike a terminal, a capture has nothing to outlive the Host for, and the Host should be able to stop all capture by stopping one process.
- **Rust or Swift.** Rust, with the objc2 framework crates the app's shell already links, so `scripts/update-hosts` builds it with cargo as it builds `weave-holder`, and no Swift toolchain is needed on a Host. The cost is writing the delegate and the blocks by hand in unsafe code where Sill has a few thousand lines of checked Swift to read from. If the first week goes to fighting bindings, a small Swift program that reuses Sill's Apache-2.0 sources is the fallback, and `screencapturekit-rs` is not a shortcut since it needs Swift too. The helper should be empty on Linux and the Host should say it has no screens there.
- **The stream.** A third `CarriedStream`, `Screen`, opened with a ticket from a `screens/attach` request, as a terminal's is. A WebSocket with a subprotocol of its own. Binary frames are a kind byte and a payload: parameter sets with the coded size; an access unit with a key flag and a timestamp, as scrcpy's 12 bytes and Sill's 14 have it. Text frames are JSON: the Block's size in pixels and its scale from the device, a keyframe request, input, and later the cursor's image and position. Sill's two pacing rules apply as the Sill note describes; nothing of GameStream's transport does until there is a datagram path.
- **Codec.** HEVC, hardware required, real time, no reordering, unbounded keyframe interval, low-latency rate control when granted. H.264 as a switch, for the low-latency mode Apple documents and for older web views.
- **The local case.** When the stream's client is on the Host's computer, which the Host knows from the socket it arrived on, the client may ask for surfaces in place of frames. The helper then sends each frame's `IOSurface` to the app's core, and the core draws it in a layer above the web view at the Block's rectangle. The spike builds this second, after the loopback HEVC path has been measured, and builds the placement above the web view first because it needs no private key.
- **The Block.** A type `weave.screen` whose props name what it shows on its Session's Host: a window by the catalogue's id, with the app's bundle id and the title as a way to find it again after a restart. Closing the Block stops its capture and, with a virtual display, puts the window back.
- **Choosing a window.** A `screens/list` request returning the Host's windows: id, app, title, size, whether on screen. No thumbnails in the spike. The weave app's own windows are left out.
- **The virtual display.** One per shown Block, sized to the Block in points at the device's scale, with a stable identity per Block. The spike builds capture of the real window first and the display second, so each measurement exists with and without it.
- **Input.** Pointer and keys as fractions and HID usages, posted as CGEvents, after video works. For the local case, pointer capture over the Block.
- **Left out.** Audio, clipboard, menus, gestures, thumbnails, several devices at different sizes, adaptive bitrate, dirty rectangles, Linux, and any change to the Dispatcher beyond carrying one more stream kind.

### What the spike should measure

- **Grants.** For each holder in 11.3: whether Screen Recording and Accessibility can be granted, what name System Settings shows, and whether both survive `scripts/update-hosts --here`, a restart of the Host, a reinstall of the app, and a reboot. Whether macOS shows a recurring reminder over a week.
- **Cost at rest and in motion.** CPU of the helper and of `WindowServer`, GPU, and energy impact, for one window: still; with a blinking cursor; scrolling text; video at 60 fps. Each with and without the virtual display, and with one, two and three Blocks.
- **The local paths.** The same four loads through loopback HEVC and through shared surfaces, with the app's and the web content process's CPU added.
- **Latency.** Glass to glass with a camera on a millisecond counter: on the Mac by each local path; to the iPad and iPhone through the Dispatcher at home and away.
- **The page.** Whether `VideoDecoder` takes the stream in the app's web view on the Mac, the iPad and the iPhone, in hardware, and the time from a frame's arrival to the canvas.
- **The layer.** How far the native layer trails its Block during a scroll, a drag of a floating Block and a window resize.
- **The encoder.** Frame rate and encode time of one stream as a second and third start, and beside an iOS Simulator recording.
- **The virtual display.** Memory of `kernel_task` and `WindowServer` over an hour at 60 and 120 Hz; what happens on sleep, on lid close, and when the helper is killed; how many displays macOS allows.
- **The cursor.** Whether `CGEventPostToPid` clicks and types in a window on a virtual display without moving the pointer.

### Decisions that should wait for those

- Which process holds the grants, and so whether the Host depends on the app on a Mac.
- Whether the local case earns a native layer, or loopback HEVC is cheap enough to be the only path.
- Whether the virtual display is on by default, optional per Block, or dropped.
- HEVC alone or H.264 beside it.
- Whether a screen Block takes input on the same Mac at all, or is a preview that raises the real window.
- Whether the cost of TCP through the Dispatcher calls for a datagram path, which is where Sunshine's techniques would start to apply.

### Risks

- **Private API.** `CGVirtualDisplay` is undocumented, can change in any release, and already misbehaves for one of Sill's users. A transparent web view would add a second private key. The design must work, degraded, without either.
- **Permissions may not be holdable where the direction wants them.** If only an app bundle can hold the grants, "the Host captures" becomes "a helper the app ships captures for the Host", and a Mac Host without the app has no screens.
- **The window leaves the person's screen.** A crash between moving a window and restoring it strands it on a display that then vanishes. macOS moves it back; where it lands is the window server's choice. Sill keeps an emergency snapshot for this.
- **Two code paths for one Block.** Surfaces locally and frames remotely double what can break, for a saving not yet measured.
- **Unsafe Rust against Objective-C delegates and blocks** is easy to get subtly wrong, and nothing here is testable off a Mac.
- **The hardware encoder is shared** with the person's other tools, the iOS Simulator's recorder among them.
- **Licences.** Sunshine, Moonlight and Apollo are GPL-3.0 and RustDesk AGPL-3.0: design only. Sill, scrcpy and DeskPad permit reuse with attribution.
