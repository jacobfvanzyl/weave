# Native RFB transfer timing and request cadence

2026-09-15. Bounded source review of `WeaveBrowserSurface.mm`, pinned LibVNCClient 0.9.15, and Apple networking APIs. No code changes or benchmarks in this research pass.

The next useful change is **instrumentation plus a controlled `responsiveData` comparison**, preserving URLSession WebSockets and the current bounded socket bridge. Early incremental requests are possible through a public API, but there is no clean stock callback that starts the next request immediately after reading a framebuffer-update header. Do not introduce a custom RFB parser or concurrent calls on the client to obtain that behavior.

## Evidence motivating the experiment

The implementation agent reports two Mac worker runs around 34.7 FPS and 111 ms response, compared with approximately 28 FPS and 188 ms before worker isolation. Reported iPad runs were 14.7 FPS / 341 ms and 13.85 FPS / 164 ms, with p95 near 735 ms and native submission below 3 ms. These are parent-reported measurements, not independently reproduced here. They establish a substantial variable delay outside the final native submission, but do not by themselves isolate Wi-Fi, VPN routing, server encoding, transfer, decoder CPU, or scheduling. GPU CEF remains excluded from this comparison because the implementation agent observed intermittent screenshot timeouts.

## Stock Apple service hint

Set `NSURLNetworkServiceTypeResponsiveData` on the ephemeral `NSURLSessionConfiguration` **before** constructing the session. This keeps the existing `webSocketTaskWithURL:protocols:` creation path and its required Portal WebSocket subprotocol. No request-header reconstruction or transport change is necessary. The local Xcode Foundation headers expose the configuration property; Apple's API documents session-wide service classification. [Configuration API](https://developer.apple.com/documentation/foundation/urlsessionconfiguration/networkservicetype), [WebSocket task API](https://developer.apple.com/documentation/foundation/urlsessionwebsockettask).

Apple describes service classes as hints that help prioritize traffic and balance radio wake-up, battery life, and performance. Its WWDC18 guidance calls `responsiveData` slightly higher priority than default and recommends using it judiciously. A user-operated browser display is a reasonable candidate for an A/B experiment, but this is an inference about workload suitability, not a latency guarantee. [Service-class definitions](https://developer.apple.com/documentation/foundation/nsurlrequest/networkservicetype-swift.enum), [Apple's networking guidance](https://developer.apple.com/videos/play/wwdc2018/714/).

Do not promise that the hint prioritizes all incoming framebuffer traffic, survives a VPN's outer tunnel, or fixes a congested access point. Apple's cited end-to-end marking example specifically concerns Cisco Fast Lane. Current configuration documentation also discusses separate cellular network-slicing entitlements; those are not a prerequisite being proposed for this LAN/VPN hint experiment. Keep default classification as the control, record the selected class in diagnostics, and compare repeated interleaved runs on the same route and viewport. Do not substitute voice/video classes just to obtain a higher priority.

## Minimal timing instrumentation

The current decoder loop measures thread CPU across `HandleRFBServerMessage` but not its elapsed wall time. That function reads and decodes an entire RFB message, invokes rectangle callbacks, sends the automatic next incremental request, and invokes `presentPixels`. It can block waiting for the remainder of a message after `WaitForMessage` reports the first available bytes. [Pinned handler implementation](https://github.com/LibVNC/libvncserver/blob/LibVNCServer-0.9.15/src/libvncclient/rfbclient.c#L2041-L2571).

Record bounded per-call samples on the decoder thread:

| Field | Interpretation |
| --- | --- |
| `rfbWaitWallMs` | Time inside the preceding `WaitForMessage`; ordinary idle waits are not frame latency |
| `rfbHandlerWallMs` | Monotonic elapsed time around the complete handler |
| `rfbHandlerCPUMs` | `CLOCK_THREAD_CPUTIME_ID` delta around that same call |
| `rfbHandlerOffCPUMs` | Wall minus CPU, labelled blocked/descheduled time rather than network time |
| Update count before/after | Identifies handlers that completed framebuffer updates without inspecting protocol bytes |
| Dimensions and timestamps | Correlates resize and fixture presentations without recording page contents |

A high wall/low CPU handler suggests waiting or descheduling; high CPU points toward decoding, pixel copy, or other callbacks on that thread. Neither result alone identifies the specific transfer hop. The handler's CPU includes the full `NSData` framebuffer copy in `presentPixels`; it is not pure ZRLE decode CPU. Measure that copy separately if subtraction is useful, using matching CPU clocks rather than subtracting a wall-time measurement from CPU time.

Store each handler sample **after it returns** in a decoder-owned bounded buffer, or transfer a completed plain sample to the diagnostics writer. The existing `decodeCPU` counter is updated after `presentPixels` queues main-thread work, so a presentation sample can contain the previous handler's cumulative CPU. Do not correlate that counter as if it precisely describes the current displayed frame.

For the smallest additional attribution, measure WebSocket binary-message interarrival/size and socket-bridge write duration. A long bridge write suggests downstream decode/backpressure; long handler off-CPU intervals with an empty bridge suggest insufficient incoming bytes, but can still reflect server production or scheduling. Keep the current rule that the next WebSocket receive begins only after the current message enters the bounded socket buffer. An unbounded receive FIFO would confound the test and grow stale-frame latency.

The outbound bridge waits for the URLSession send completion before reading another chunk. A send-completion duration can be logged separately; do not interpret it as a server acknowledgement or round-trip time. URLSession exposes asynchronous message-oriented send/receive over WebSockets, not an application-level framebuffer receipt acknowledgement. [Apple WebSocket API](https://developer.apple.com/documentation/foundation/urlsessionwebsockettask).

## What early requests can and cannot do without a fork

The pinned handler already calls `SendIncrementalFramebufferUpdateRequest` **before** `FinishedFrameBufferUpdate`, which the product uses for `presentPixels`. Moving a request before native presentation therefore duplicates existing behavior. The public helper uses the client's current update rectangle and delegates to `SendFramebufferUpdateRequest`; the latter respects the library's resize-in-progress guard. [Pinned request functions](https://github.com/LibVNC/libvncserver/blob/LibVNCServer-0.9.15/src/libvncclient/rfbclient.c#L1476-L1520).

Three possible approaches have different limits:

| Approach | Supported surface | Assessment |
| --- | --- | --- |
| Request from first `GotFrameBufferUpdate` callback, once per update | Public rectangle callback and request function, on decoder thread | Can overlap remaining rectangles, but the callback runs only after that rectangle is decoded. A single large ZRLE rectangle gets essentially no earlier overlap. Automatic end-of-update request remains. |
| Send one extra incremental request after `WaitForMessage` succeeds and before calling the handler | Public request function, same decoder thread | Can overlap transfer/decode of the incoming message. The message may instead be a resize, cursor, or other server message; there is no header information at this boundary. It adds to automatic requests and requires a carefully bounded diagnostic policy. |
| Request on another thread or after peeking raw headers | No additional clean ownership guarantee in the current client integration | Reject for this pass: concurrent client access or a maintained parser is unnecessary complexity. |

RFB permits multiple outstanding update requests and allows one update to satisfy several requests. Thus extra requests are protocol-valid, but they do not create a guaranteed one-request/one-frame credit system. The server may coalesce them, or extra production can increase queued display data. [RFB request semantics](https://www.rfc-editor.org/rfc/rfc6143.html#section-7.5.3).

The source review did not find a public switch that suppresses LibVNCClient's automatic incremental request while retaining its standard handler. Do not repurpose resize flags or mutate internal capability state to suppress it. If timing proves a material request round-trip gap, run a diagnostic-only public-API overlap comparison with explicit request counters and bounded outgoing policy, measuring response p95 and queued bytes as well as FPS. Retain it only if it improves fresh-frame latency through resize, reconnect, and slow-client acceptance. Until that evidence exists, the smallest maintained design is the existing automatic request cadence.

## Appendix: stock zlib encoding at compression level 1

**Yes: pinned LibVNC supports lossless `zlib` encoding with negotiated compression level 1, independently of JPEG and PNG.** This is a smaller next experiment than replacing the presenter or compressor dependency. Before `rfbInitClient`, configure:

```cpp
client->appData.encodingsString = "zlib hextile raw";
client->appData.compressLevel = 1;
client->appData.enableJPEG = FALSE;
```

Use `"zlib raw"` to simplify an isolated comparison. Preserve the current 32-bit pixel format, RGB channel maxima/shifts, physical viewport, and color space. No change to image fidelity is inherent in DEFLATE compression level: level 1 prioritizes compression speed over compressed size. [Upstream zlib level semantics](https://zlib.net/manual.html#Basic).

The exact negotiation path is present in pinned source: the client recognizes `zlib`, appends its encoding ID, and emits the compression-level pseudoencoding for a valid `appData.compressLevel` from 0 through 9. The server picks the first supported requested encoding, stores the pseudoencoding value in `cl->zlibCompressLevel`, and the zlib encoder passes it to `deflateInit2`. Both client and server zlib paths require `LIBVNCSERVER_HAVE_LIBZ`; neither requires JPEG/PNG. The current server default is level 5 when no level is negotiated. [Client negotiation](https://github.com/LibVNC/libvncserver/blob/LibVNCServer-0.9.15/src/libvncclient/rfbclient.c#L1288-L1357), [server negotiation](https://github.com/LibVNC/libvncserver/blob/LibVNCServer-0.9.15/src/libvncserver/rfbserver.c#L2330-L2493), [zlib encoder](https://github.com/LibVNC/libvncserver/blob/LibVNCServer-0.9.15/src/libvncserver/zlib.c).

This differs from current ZRLE: selecting `zrle` does not request the compression-level pseudoencoding, and the ZRLE compressor initializes with `Z_DEFAULT_COMPRESSION`. Merely assigning `compressLevel=1` while retaining `zrle` first does not implement this experiment. [ZRLE initialization](https://github.com/LibVNC/libvncserver/blob/LibVNCServer-0.9.15/src/libvncserver/zrleoutstream.c#L91).

Caveats and acceptance:

- **Reconnect for every compression-level comparison.** The zlib encoder reads the configured level only when initializing its persistent stream. It does not call `deflateParams` after later SetEncodings messages; changing the field during an existing stream is not evidence the level changed.
- The encoder translates pixels into a scratch buffer and maintains full-screen-sized before/after compression buffers per viewer. This can increase server memory and pixel-copy cost relative to ZRLE; measure multiple viewers.
- Large rectangles are split into bands of roughly 32,768 pixels, with at least two scanlines, and output is flushed after each maximum-size band. That upstream behavior permits encode/transfer/decode overlap without adding an early-request parser. It may also produce more rectangles and messages. Tiny areas can be sent raw. [Band sizing](https://github.com/LibVNC/libvncserver/blob/LibVNCServer-0.9.15/include/rfb/rfb.h#L888-L901), [band loop and flush](https://github.com/LibVNC/libvncserver/blob/LibVNCServer-0.9.15/src/libvncserver/zlib.c#L240-L312).
- Lower encoder CPU is a hypothesis to test; higher network bytes may worsen iPad p95 despite a Mac win. Compare fresh connections using the same fixture, 2× viewport, route and service-class setting. Record negotiated encoding/level from worker-owned diagnostic state, RFB pump CPU/wall, handler CPU/wall, bytes, native FPS, and response median/p95; verify exact pixels and resize/reconnect.

**Later alternative: zlib-ng in upstream compatibility mode.** Its documented `ZLIB_COMPAT=ON` build exposes the zlib-compatible API and includes Arm optimizations. A private, checksum-pinned server-only dependency could accelerate the existing ZRLE or zlib compressor without changing RFB encoding or requiring matching client compression libraries. Link its matching headers/archive explicitly and verify the resulting binary resolves the intended implementation; do not replace the operating system's zlib or rely on global injection. Keep client builds unchanged for the first comparison. This adds dependency packaging and cross-platform validation, and does not promise identical compression ratio or a specific speedup. Try the existing stock zlib level first. [zlib-ng upstream build options and architecture support](https://github.com/zlib-ng/zlib-ng#build-options).
