# WVE-79: existing display protocols and native Apple components

Research checked 2026-09-12. Scope: open-source remoting components that could carry an upstream Chromium browser's output from macOS and Linux Hosts into native Mac/iPad clients. This is source and artifact research, not runtime acceptance. The existing Viz build was not changed by this investigation.

## Findings that change the decision

**A custom browser-to-Metal protocol is not the only way to get native display without a webview.** SPICE, RDP and RFB already provide native protocol implementations, image compression and incremental display updates. SPICE has an existing Cocoa/Metal client package for both Apple platforms. RDP has reusable C and Rust implementations. These can sit downstream of a browser's completed pixel buffers, avoiding a Chromium fork and a bespoke graphics decoder.

**The most concrete non-video composition to investigate is CEF offscreen output → a small SPICE producer → spice-server → CocoaSpice.** The server's own release tests instantiate a drawable producer without QEMU, a guest OS or Xorg. However, this is an adapter to an established library, not a prebuilt browser-streaming product. Its most serious mismatch is simultaneous viewers: spice-server 0.16.0 still labels multiple-client mode experimental, and the normal connection path disconnects the preceding client. See the source audit below.

**None of these pixel-buffer adapters preserves Chromium's original Viz texture identities or guarantees transform-only page movement with no raster retransmission.** They retain remote output surfaces, compressed image history and sometimes explicit cached images. That can still deliver the desired browser product. It answers a different performance question from the current Viz experiment.

| Candidate | Reusable component | Existing Host path | Native Apple path | Main mismatch |
| --- | --- | --- | --- | --- |
| SPICE + CocoaSpice | Server library, codecs/caches, input/audio channels, Cocoa/Metal client | Library binaries on macOS and Linux; custom browser producer needed | Source package declares macOS and iOS | Multiple viewers experimental; dependency packaging and browser adapter |
| RDP + FreeRDP / IronRDP | Protocol libraries and server building blocks | Linux xrdp; MacRDP on macOS; custom pixel producer also possible | FreeRDP iOS port; native desktop clients | Full desktop servers do not supply Workspace/tab isolation; embedded client work remains |
| Xpra | Persistent individual application remoting with hybrid image/video/scroll encoding | Seamless X11 applications; macOS desktop shadowing | Packaged native macOS client; no native iPad client found | Host asymmetry and iPad port |
| RFB + LibVNC | Small C framebuffer server/client API | Custom framebuffer producer on either Host | Native integration feasible; no current Apple XCFramework established | Separate audio and synchronization, less browser-specific support |
| Waypipe / Greenfield | Wayland buffers and surface/window protocol | Linux applications | Waypipe expects Wayland compositor; Greenfield renders in a browser | Apple compositor/client port and macOS Host gap |
| KasmVNC | Packaged Linux application/desktop streaming | Linux | Browser client | Explicitly incompatible with ordinary native VNC viewers |

The table is an assessment of the sources below. “Existing Host path” does not mean that a complete desktop server is an embeddable per-tab SDK.

## SPICE: credible without a VM, conditional because of shared viewers

### What already exists

The protocol supports drawing operations, image/palette caches, copy operations and video streams, with separate input, cursor, playback and record channels. Its audio protocol includes raw PCM and Opus. These are established protocol features, rather than promises that a particular Apple package enables every codec. [SPICE protocol](https://www.spice-space.org/spice-protocol.html)

[CocoaSpice](https://github.com/utmapp/CocoaSpice) is an actual reusable package, used to build macOS and iOS clients. Its renderer exposes displays and cursors as Metal textures. The package manifest declares iOS 11 and macOS 10.14 minimums, and exports `CocoaSpice` and `CocoaSpiceNoUsb`; these minimums are declarations, not this task's modern-device acceptance results. [Pinned Package.swift](https://github.com/utmapp/CocoaSpice/blob/127033fa3e59cd49678f49ed54f8adfc060afb56/Package.swift)

CocoaSpice connects playback channels through `spice_audio_get` when `audioEnabled` is enabled. It also implements TCP, Unix socket and TLS connection setup, including a server public-key property. [Pinned CSConnection.m](https://github.com/utmapp/CocoaSpice/blob/127033fa3e59cd49678f49ed54f8adfc060afb56/Sources/CocoaSpice/CSConnection.m)

This is not a single self-contained binary package: CocoaSpice's instructions require linking GLib, GStreamer and `libspice-client-glib-2.0`, with USB optional. UTM documents a build system that turns its native dependencies into Apple frameworks and carries patches for some dependencies. Reusing this route means accepting a native dependency build/package pipeline, although it does not require compiling Chromium. [CocoaSpice usage](https://github.com/utmapp/CocoaSpice#usage), [UTM dependency build](https://github.com/utmapp/UTM/blob/main/Documentation/Dependencies.md)

The **server library itself is available precompiled on macOS**. Homebrew currently lists spice-server 0.16.0 bottles for Apple Silicon macOS, Intel Sonoma and Linux arm64/x86_64. This is evidence for library portability and packaging, not evidence of an already-built native Mac browser producer. [Homebrew's spice-server package](https://formulae.brew.sh/formula/spice-server)

### Exact producer seam, checked in the stable release

Inspected the official [spice-0.16.0 source archive](https://www.spice-space.org/download/releases/spice-0.16.0.tar.bz2), 1,682,389 bytes, SHA-256 `0a6ec9528f05371261bbb2d46ff35e7b5c45ff89bb975a99af95a5f20ff4717d`. Source was read in memory; no package was installed.

`server/tests/test-display-base.cpp` is a direct demonstration of a non-VM producer:

- `test_new` constructs a `SpiceServer` with `spice_server_new` and initializes it against a `SpiceCoreInterface`.
- `test_add_display_interface` registers a `QXLInstance` using `spice_server_add_interface`.
- `create_primary_surface` supplies dimensions, stride, format and backing memory to `spice_qxl_create_primary_surface`.
- `test_spice_create_update_from_bitmap` creates a `QXLDrawable` of type `QXL_DRAW_COPY`, points it at a `QXLImage` and supplies a bounding rectangle and bitmap bytes.
- `get_command`, `req_cmd_notification` and `release_resource` implement the producer queue and ownership boundary. These callbacks run in server worker context.

Thus QXL is also a host-side library interface; using it does **not** require emulating a PCI QXL device or booting a guest. The test is the primary evidence for that distinction. [Stable release, `server/tests/test-display-base.cpp`](https://www.spice-space.org/download/releases/spice-0.16.0.tar.bz2)

The public `server/spice-qxl.h` declares that interface and the wakeup, surface lifecycle and `client_monitors_config` callbacks. `server/spice-audio.h` separately exposes playback start/stop, buffer acquisition/submission and sample-rate selection. [Stable release public headers](https://www.spice-space.org/download/releases/spice-0.16.0.tar.bz2)

### Proposed adapter, with its actual ownership

This is a design inference from those APIs:

1. A prebuilt CEF browser instance emits `OnPaint` updates. That callback supplies a whole BGRA image and changed rectangles, at pixel scale, with a top-left origin. View and popup painting are separate events. [CEF render handler](https://github.com/chromiumembedded/cef/blob/master/include/cef_render_handler.h)
2. Our producer copies/coalesces dirty rectangles into owned buffers, queues QXL bitmap-copy commands, and retains each allocation until SPICE's resource-release callback. It creates or replaces the primary surface on resize. The callback must not block the browser's UI thread on a slow viewer.
3. spice-server supplies wire encoding, transport, client cache bookkeeping and playback channels. CocoaSpice decodes/presents the remote surface in the native client.
4. Portal remains the authority for profile/session ownership and focus-based viewport selection. It tells the browser its approved size; generic monitor-resize messages must not independently override that authority.
5. Audio packets from `CefAudioHandler` are floating-point PCM. A bounded conversion/interleave step would supply SPICE's signed 16-bit stereo playback format; configure compatible sample rates or use an existing converter. Timestamp alignment and discontinuities need testing. [CEF audio handler](https://github.com/chromiumembedded/cef/blob/master/include/cef_audio_handler.h), [SPICE playback header in release](https://www.spice-space.org/download/releases/spice-0.16.0.tar.bz2)

This removes our own image codec, wire decoder and Metal page compositor. We still own popup composition/placement, pixel lifetime, resize generations, input-to-browser mapping, stream backpressure and Portal authorization. The simpler initial implementation should use completed opaque tab pixels, rather than try to map all Viz effects onto SPICE's drawing model.

### What is cached, and what is not

In `server/dcc-send.cpp`, cacheable image IDs are looked up in the client's pixmap cache; a hit produces `SPICE_IMAGE_TYPE_FROM_CACHE` instead of image payload. This is real retained-image reuse. The identity belongs to the producer's QXL image, not to a discovered Chromium texture. Distinct images with accidentally reused IDs would be a producer correctness bug. [Stable release cache implementation](https://www.spice-space.org/download/releases/spice-0.16.0.tar.bz2)

For the proposed CEF adapter, an already-composited dirty rectangle contains the page after transforms. A moving layer commonly changes pixels at both old and new positions. Merely wrapping those rectangles in SPICE does not recover that layer or its transform. We could add content-addressed tile IDs or copy/motion detection, but that is additional custom logic; compression history is already available without claiming equivalent Viz resource retention. This distinction is an inference from the CEF callback and SPICE image interfaces.

### Early blockers and acceptance gates

**Shared viewers are the first gate.** In the 0.16.0 `README`, multiple clients remain under “Experimental Features”, enabled by `SPICE_DEBUG_ALLOW_MC=1`. `server/reds.cpp` sets `allow_multiple_clients` from that environment variable; absent it, a new main connection calls `reds_disconnect`. The file also says that one server per process is the intended use, even though multiple objects can technically be created. [Stable release README and reds.cpp](https://www.spice-space.org/download/releases/spice-0.16.0.tar.bz2)

Possible responses are to prove the upstream multi-client path for our restricted feature set, or give each viewer a separate SPICE session fed from the same browser output. The latter introduces fanout, extra server state and likely duplicated encoding/cache cost. Neither should be described as free reuse. Audio behavior across viewers and reconnects also needs explicit verification.

**Local GPU sharing is not remote GPU transport.** UTM's native fast path can pass IOSurface references locally, but its graphics documentation explicitly distinguishes this from remote operation. Do not interpret CocoaSpice Metal output or `spice_qxl_gl_scanout` file descriptors as a network path for Chromium GPU textures. Start with the ordinary bitmap protocol across LAN/VPN. [UTM graphics architecture](https://github.com/utmapp/UTM/blob/main/Documentation/Graphics.md)

Recommended bounded follow-up if SPICE is shortlisted: two simultaneous native viewers of one synthetic producer, rapid resize and reconnect, then CEF text/scroll/popups plus audible stereo output on physical iPad. Measure bytes and CPU against the existing WebRTC route. Failure of the multi-client or Apple dependency gate should stop this route before substantial Portal work.

### License declarations and a newer native client

The stable spice-server archive declares **LGPL-2.1-or-later**. CocoaSpice declares **Apache-2.0**. GLib declares **LGPL-2.1-or-later**; GStreamer declares LGPL for its framework and documents differing external plugin dependencies. The selected spice-gtk package must retain its own notices: Fedora's package records LGPL-2.1-or-later plus MIT/BSD components. These are component declarations, not a conclusion about the resulting app's distribution terms. [Server release](https://www.spice-space.org/download/releases/spice-0.16.0.tar.bz2), [CocoaSpice license](https://github.com/utmapp/CocoaSpice/blob/main/LICENSE), [GLib](https://docs.gtk.org/glib/), [GStreamer licensing](https://gstreamer.freedesktop.org/documentation/frequently-asked-questions/licensing.html), [spice-gtk package manifest](https://packages.fedoraproject.org/pkgs/spice-gtk/spice-gtk/)

**SwiftSpice** is a newer MIT implementation that avoids GLib and provides native Swift/Metal components with bundled static XCFramework dependencies. Its current requirements are Apple Silicon, macOS 26, Swift 6.3/Xcode 26.6; its manifest does not declare iOS. The README explicitly leaves audible playback/microphone hardware validation and important performance gates pending. It is a useful watchlist/library-design reference, not a proven Mac+iPad replacement. [SwiftSpice](https://github.com/BeriBeli/spice-swift), [Package.swift](https://github.com/BeriBeli/spice-swift/blob/main/Package.swift)

## RDP: mature building blocks, different completeness levels

RDP's graphics pipeline has offscreen surfaces, surface-to-surface blits, cache transfers and fills. The separate MS-RDPCR2 specification also describes scene-graph composition. **A protocol specification is not evidence that our chosen open-source client and server implement that entire composition extension.** No working general Viz-to-RDPCR2 adapter was established. [Graphics pipeline overview](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpegfx/5229ee1e-1cb4-4178-9739-a36f1258b685), [Composition surface management](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpcr2/80a199ac-359a-493c-9983-8d619af23507)

**FreeRDP** is an Apache-licensed C library with client and server code. Current iOS build instructions target iOS 15+, require Xcode 26+ and separate OpenSSL/FFmpeg dependencies, and describe building iFreeRDP from source. This is a genuine native iPad path, but no ready-to-import current Apple XCFramework was established. Release 3.31.1, published 2026-09-02, has source archives/signatures/checksums. [Project](https://github.com/FreeRDP/FreeRDP), [iOS instructions](https://github.com/FreeRDP/FreeRDP/blob/master/docs/README.ios), [3.31.1 release](https://github.com/FreeRDP/FreeRDP/releases/tag/3.31.1)

Do not use the presence of `server/shadow/Mac` as proof of a maintained Mac Host solution. Its source captures `CGMainDisplayID` with `CGDisplayStream` and explicitly calls `freerdp_server_warn_unmaintained` in `ShadowSubsystemEntry`. This is desktop dirty-pixel capture, not browser scene extraction. [Pinned Mac shadow source](https://github.com/FreeRDP/FreeRDP/blob/e5f2cf530fa4dbf4166839799c1e0d7f9640355a/server/shadow/Mac/mac_shadow.c)

**IronRDP** is MIT-or-Apache-2.0 and explicitly modular: protocol codecs, sans-I/O session state machines, virtual channels and a server skeleton. Its advertised channels include audio playback and dynamic resize. Native desktop targets are Windows/macOS/Linux; a finished iPad UI/FFI package was not established. [IronRDP](https://github.com/Devolutions/IronRDP)

Its `BitmapUpdate` API accepts x/y, dimensions, pixel format, bytes and stride, then encodes/fragments the update. This is a particularly clear alternative seam for completed browser dirty rectangles. The simple API is not a promise that all EGFX codecs/cache operations are selected automatically. [BitmapUpdate API](https://docs.rs/ironrdp-server/latest/ironrdp_server/struct.BitmapUpdate.html)

Artifact read-back caught a documentation mismatch: the repository README describes prebuilt viewer and agent downloads, but GitHub's release API returned **no assets** for `ironrdp-viewer-v0.1.0`; `ironrdp-agent-v0.1.0` does contain Linux/macOS/Windows archives. Do not promise a viewer binary from the README alone. [Viewer release](https://github.com/Devolutions/IronRDP/releases/tag/ironrdp-viewer-v0.1.0), [Agent release](https://github.com/Devolutions/IronRDP/releases/tag/ironrdp-agent-v0.1.0)

**MacRDP** is an actual native Mac server built on IronRDP, not a VNC bridge. Version 0.9.6 release assets include Apple Silicon CLI and app archives. The project supports desktop capture, audio and optional hardware H.264; it describes itself as a v0, single-session/single-user server with vendored IronRDP divergence. Its virtual display does not create a Workspace-isolated browser service. It is useful interoperability/Host capture precedent, or an optional whole-desktop backend, but is not a drop-in Portal tab service. License: MIT or Apache-2.0. [MacRDP scope](https://github.com/clintcan/macrdp), [0.9.6 artifacts](https://github.com/clintcan/macrdp/releases/tag/v0.9.6)

**xrdp** supplies a packaged Linux session server, reconnect and dynamic resize; Xorg integration uses xorgxrdp, and audio requires additional modules. It targets GNU/Linux and declares Apache-2.0. A Linux browser-in-session deployment is feasible, but a corresponding native macOS session model is not provided by xrdp. [xrdp README](https://github.com/neutrinolabs/xrdp/blob/devel/README.md)

Assessment: RDP is credible when generic remote applications/desktops or interoperability with third-party clients is valuable. A focused browser product still needs a producer, client embedding and Portal policy. FreeRDP offers the clearer existing iOS route; IronRDP offers an attractive custom server/library boundary. This task did not compare their performance.

## Xpra: closest existing persistent application model, wrong Apple coverage

Xpra's seamless mode runs persistent X11 applications and supports disconnect/reconnect without losing state. It provides signed native macOS packages and Linux packages, plus audio forwarding. Its license declaration is GPLv2+. [Project and downloads](https://github.com/Xpra-org/xpra)

Its image/video encoding engine can choose compressed RGB, PNG/WebP/JPEG, video codecs and scroll motion vectors according to the content and connection. This is more nuanced than sending a continuous full-frame video stream, but it is still window-pixel remoting, not Chromium render-pass export. [Encoding documentation](https://github.com/Xpra-org/xpra/blob/master/docs/Usage/Encodings.md)

The official client matrix calls the native implementation the complete reference client and lists Linux, Windows and macOS. It does not establish a native iOS client. Using its HTML5 client on iPad would violate our no-webview requirement. [Client matrix](https://github.com/Xpra-org/xpra/blob/master/docs/Usage/Clients.md)

macOS server support is **shadowing an existing display**. The project notes that shadowed displays generally must remain active/unlocked and that some platforms incur high CPU overhead. That is materially different from independent persistent X11 application sessions. [Shadow mode](https://github.com/Xpra-org/xpra/blob/master/docs/Usage/Shadow.md)

Assessment: excellent source of window/session and adaptive-encoding precedents; a stronger candidate if Hosts become Linux-only and we accept an iPad client project. Under the current constraints, it does not reduce enough integration work.

## RFB/VNC: simple framebuffer composition, audio outside the core protocol

RFB is defined in RFC 6143 around framebuffer rectangles. `CopyRect` reuses pixels already present in the destination framebuffer, and encodings such as ZRLE compress updates. The core protocol does not supply the required audio stream; vendor extensions should not be presumed interoperable. [RFC 6143](https://www.rfc-editor.org/rfc/rfc6143.html)

LibVNCServer/LibVNCClient are cross-platform C libraries deliberately intended for embedding. They support raw pixels, CopyRect and several compressed encodings. This makes CEF `OnPaint` → changed framebuffer regions → LibVNCServer → native LibVNCClient a plausible smaller display-only adapter. The project ships GPL-2.0 license text and a CMake source build; no current iPad binary package was established. [LibVNC](https://github.com/LibVNC/libvncserver), [license](https://github.com/LibVNC/libvncserver/blob/master/COPYING)

Compared with SPICE, this can simplify the producer but adds a separate audio path and timing/lifecycle coordination. With WebRTC audio already present, a hybrid is possible, but two transports are not automatically less glue than WebRTC for both tracks. Correct CopyRect detection also remains producer work: CEF does not report original Viz layer motion. These are architectural inferences.

TigerVNC provides maintained desktop tooling and a native macOS viewer, rather than a demonstrated all-Apple embedded SDK. Its 1.16.2 release is dated 2026-03-26; the project site directs binary users to its package distribution. [TigerVNC](https://tigervnc.org/), [release](https://github.com/TigerVNC/tigervnc/releases/tag/v1.16.2)

**KasmVNC must not be treated as a drop-in server for LibVNC or an ordinary native VNC viewer.** Its own README says it has departed from RFB and does not support legacy VNC viewers. Version 1.5.0 has many Linux package artifacts, but the intended client is a browser. Its GPL source remains useful encoding/application-streaming precedent; the server and Apple-native-client gap persists. [KasmVNC](https://github.com/kasmtech/KasmVNC), [1.5.0 artifacts](https://github.com/kasmtech/KasmVNC/releases/tag/v1.5.0)

## Wayland remoting: surface reuse is at a different boundary

Wayland applications submit buffers to a compositor, which places those surfaces on screen. This is a composable application/display boundary, but it does not imply that a browser exports every internal CSS/Viz layer as a Wayland surface. [Wayland architecture](https://wayland.freedesktop.org/architecture.html)

Waypipe proxies Wayland messages and the file-descriptor-backed data those messages refer to. Its author's primary description explains mirrored shared buffers and transmitting changes relative to the mirror. This offers real buffer reuse without a browser fork, provided a compatible compositor exists at the other end. [Author's architecture account](https://mstoeckl.com/notes/gsoc/blog.html)

The present upstream GitLab page blocked automated access, so current release/license details were not fully verified from upstream; mirrors were used only for discovery. Do not make an up-to-date production claim from the 2019 article. Independently of maintenance status, the existing architecture needs a native Apple Wayland compositor/client port, and does not provide a native macOS Chromium Host boundary. Audio is not part of the Wayland drawing protocol.

Greenfield implements a Wayland compositor in the browser for remote Linux applications. The repository declares AGPL-3.0. Its latest visible release is `1.0.0-rc1` from 2023; the default branch had a 2025-10-15 commit, so it is not accurate to infer abandonment just from that release date. It supplies neither our native iPad renderer nor a native macOS Host implementation. [Greenfield](https://github.com/udevbe/greenfield), [release](https://github.com/udevbe/greenfield/releases/tag/1.0.0-rc1)

## Excluded after the open-source-only decision

NoMachine has prebuilt macOS/Linux servers and Apple mobile clients, and documents Linux-only virtual application/desktop sessions. It is a useful product precedent, but the current product was excluded from our shortlist after the user's open-source-only instruction. Old open-source NX components should not be confused with access to the current NoMachine implementation or a reusable native SDK. [Current platform support](https://www.nomachine.com/support/supported-operating-systems-and-supported-applications), [virtual desktop scope](https://www.nomachine.com/support/documents/creating-nomachine-virtual-desktop-sessions-on-linux)

## Recommendation within this subtask

Keep the existing stock-Chromium/WebRTC route as the implementation baseline while comparing alternatives. The most valuable additional protocol experiment would be **a bounded CEF/SPICE/CocoaSpice comparison**, starting with two viewers and Apple dependency packaging before browser integration. It avoids a Chromium fork and can reuse a native renderer, but the simultaneous-viewer limitation prevents calling it a straightforward replacement today.

RDP libraries are the next composable option if generic desktop interoperability becomes a product requirement. RFB is the smallest display-only option, with a separate audio cost. Xpra and Wayland remoting become much more competitive if native macOS Hosts or native iPad clients are relaxed. No surveyed library removes Portal's responsibility for Workspace profiles, tab identity, authorized ACP/CDP access, unattended lifetime and latest-focus viewport ownership.

## Source inventory and verification limits

Primary sources are linked at the claims above. Key independently read artifacts:

| Source | Revision/artifact observed | Why it matters |
| --- | --- | --- |
| Official spice-server archive | 0.16.0, SHA-256 recorded above | Public QXL/audio interfaces, direct producer tests, cache behavior, multiple-client flag |
| CocoaSpice | `127033fa3e59cd49678f49ed54f8adfc060afb56` | Apple platform declaration, audio connection, native package ownership |
| FreeRDP | `e5f2cf530fa4dbf4166839799c1e0d7f9640355a`; release 3.31.1 | Explicitly unmaintained Mac shadow path; existing modern iOS source instructions |
| IronRDP | `be39881eacdfed336f781d8c9a6ca4368da0dd35`; viewer/agent 0.1.0 | Modular implementation; actual release asset mismatch |
| MacRDP | `e55937f0f940ea63d632ca69bae58263430cb4af`; 0.9.6 assets | Real prebuilt Mac Host server, scoped limitations |
| Xpra | `a1a489e3e75855d75a01680bcf1384084a51851d`; 6.5.3 release | Persistent application protocol and macOS shadow distinction |
| LibVNC | `42494999e6492aaab9c1db785ecd293ef10b3aed`; 0.9.15 release | Embeddable framebuffer API |
| TigerVNC | `886800c78567931a2e7dfbb48861f84f11672b0b`; 1.16.2 release | Existing native desktop viewer |
| KasmVNC | `98d25c652dde03b41d5379fbdfe2cb26fc2f9461`; 1.5.0 Linux assets | Native VNC incompatibility despite name |
| Greenfield | `6c578f4db7ec027eb1d8a5f7ec6e09f7646dbb57`; 1.0.0-rc1 | Browser compositor, not Apple-native SDK |

Release/commit metadata was read from the projects' public GitHub API. Later API calls hit the anonymous rate limit; raw source and official documentation remained accessible. No binaries from these projects were executed, no playback/performance claims were accepted from a build alone, and no licensing compatibility determination was made.
