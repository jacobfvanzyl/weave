# RFB worker ownership and cancellation

Implementation follow-up: the shared executor and separate stock `WITH_THREADS=OFF` server build are now implemented. The builder uses `lib-rfb-executor-{mac,linux}-v1`; CEF calls moved into `rfb-display.h`. The research below describes the pre-implementation audit. See [measured results](latency-worker-results.md).

Mac and Linux tests passed, with a platform-specific cancellation limit: on Linux, local socket shutdown did not always wake a blocked `select(write)` until LibVNC's five-second retry. Page close/create remained below 100 ms; the worker recovered within 5.5 seconds. Shutdown therefore does not guarantee immediate recovery of every output path. A slow viewer can still delay other displays sharing the Profile executor.

Research date: 2026-09-15. Source review only; no implementation, builds, or benchmarks in this pass. Target: pinned LibVNCServer 0.9.15 and `product/portal/native/browser/cef-host.cc`, retaining lossless physical-resolution pixels, Portal control, and upstream CEF.

## Recommendation and newly identified blocker

Move all RFB screen operations off CEF's UI thread. Keep a bounded latest-pixels staging buffer between CEF and an RFB-owned framebuffer, with a short mutex covering only pixel copies and metadata. No LibVNC call, encoder, socket operation, or thread join belongs inside that mutex. This can use dirty-row copies; a full-frame copy on every paint is not required.

**Do not assume one independent worker per Page is safe with the currently cached pthread-enabled library.** Every `rfbGetScreen` calls `rfbClientListInit`, which unconditionally initializes the same file-static `rfbClientListMutex`. Creating another screen while existing workers use that mutex can reinitialize a live mutex. `INIT_MUTEX` is directly `pthread_mutex_init`, with no once guard. Serializing only screen creation does not exclude existing pumps. The same pattern remains in upstream master inspected today; no verified upgrade fix was found. [Pinned client-list initialization](https://github.com/LibVNC/libvncserver/blob/LibVNCServer-0.9.15/src/libvncserver/rfbserver.c#L144-L164), [pinned mutex macros](https://github.com/LibVNC/libvncserver/blob/LibVNCServer-0.9.15/include/rfb/threading.h), [current upstream source](https://github.com/LibVNC/libvncserver/blob/master/src/libvncserver/rfbserver.c).

The smallest source-unmodified fallback is a **Host-specific LibVNC build with its supported `WITH_THREADS=OFF` option, and one shared RFB executor owning all screens in that process**. C++ can still run that executor on a worker thread; the option disables LibVNC's own threading. Keep client libraries and their headers unchanged. Give this server variant a separate cache identity and include directory, since the option changes public structure layout. This removes the global mutex problem and avoids assuming other library globals are safe across concurrent screens. It serializes pages' encoders, so it protects CEF responsiveness without promising independent display throughput per Page. [Upstream build options and configuration](https://github.com/LibVNC/libvncserver/blob/LibVNCServer-0.9.15/CMakeLists.txt).

Independent per-Page workers remain a useful later ownership model, conditional on an upstream fix plus a globals audit, or a separate process per RFB screen. Neither is required to test whether removing compression from CEF restores input/paint scheduling. A process per screen provides stronger isolation but adds lifecycle and pixel IPC work; it is not the minimal first step.

Implementation decision after this source review: use **one shared worker per native Profile process**, with bounded staging owned separately for each Page, and the stock server-only build option above. Ordinary Page close requests cancellation and asynchronous cleanup; it does not join the shared worker. Join the executor only during process shutdown after stopping its producers.

## What the pinned implementation actually does

The product currently calls `CefDoMessageLoopWork`, accepts RFB viewers, and runs `rfbProcessEvents(screen, 0)` in the same main loop. `OnPaint` writes directly into `screen->frameBuffer`. Resize calls `rfbNewFramebuffer`, then restores BGRA channel shifts and rebuilds client translation functions. The Page destructor closes its listener, shuts down RFB, frees the application-owned framebuffer, and cleans up the screen. These operations are serialized today; moving just the pump introduces concurrent framebuffer readers and writers.

In LibVNC's foreground event loop, `rfbProcessEvents` reads client messages and updates clients sequentially. `rfbUpdateClient` calls `rfbSendFramebufferUpdate` synchronously when `deferUpdateTime == 0`, as configured here. That call includes translation, compression, and writes. Passing zero to the pump only removes the initial polling wait; it does not make a complete pump nonblocking. [Pinned event/update loop](https://github.com/LibVNC/libvncserver/blob/LibVNCServer-0.9.15/src/libvncserver/main.c#L1273-L1330).

The cached Mac configuration has `LIBVNCSERVER_HAVE_LIBPTHREAD=1`. `rfbRunEventLoop(..., TRUE)` starts a listener thread; clients then have input/output threads. The background output path holds `sendMutex` across framebuffer encoding and transmission. Its update mutex protects region bookkeeping, not arbitrary producer writes to framebuffer bytes. `rfbNewFramebuffer` locks every client's send mutex while changing screen state. [Background client loop and startup](https://github.com/LibVNC/libvncserver/blob/LibVNCServer-0.9.15/src/libvncserver/main.c#L453-L714), [framebuffer replacement](https://github.com/LibVNC/libvncserver/blob/LibVNCServer-0.9.15/src/libvncserver/main.c#L1071-L1152).

Consequently, enabling the background loop alone is insufficient. Locking CEF painting behind those send locks would move the compression stall into `OnPaint`; calling resize from CEF would still wait for encoders. A display-hook lock held until the display-finished hook has the same problem. These are not suitable zero-copy shortcuts.

## Adapter boundary and ownership

Keep a small `RfbPageDisplay` abstraction; the number of executor threads should not leak into Page's interface.

| Owner | State and operations |
| --- | --- |
| CEF UI thread | Browser, logical viewport/scale, wheel accumulator, focus, CDP, page lifecycle, JSON-RPC replies/events, validation of incoming paints against expected physical dimensions |
| Shared handoff | Latest staging pixels, physical dimensions, resize generation, accumulated dirty region, stop state; one mutex for pixel/metadata access |
| RFB executor | Every `rfbScreenInfo`, its application-owned framebuffer, listeners, accepted sockets, all LibVNC calls and callbacks, translation setup, pump metrics, cleanup |
| Cancellation registry | Independently owned duplicate socket descriptors; short registry mutex; shutdown can interrupt socket I/O without accessing LibVNC client structures |

Suggested methods are `start`, `submitPaint`, `resize`, `requestStop`, `drainStatus`, and final cleanup. Constructors/start must communicate readiness asynchronously or through a bounded initialization phase, so the Host never reports an RFB endpoint before its listener exists. Failed initialization must report failure through the UI-owned command/event channel.

The executor must not retain or call a `Page*`, `CefBrowser`, or mutable CEF dictionary. Give it owned configuration and a shared handoff object whose lifetime extends through cleanup. Forward plain completion/error records to the UI. Page close stops new submissions before releasing that shared state.

## Dirty-pixel handoff without a full copy per paint

Use two persistent images at the current physical size: staging and RFB framebuffer. At 2298 × 1702 × 4 bytes each is about 15.6 MB. Allocation is per size change, not per frame. This proposal adds one staging image and one extra dirty-row copy relative to today's direct paint; the copy and mutex wait need measurement.

1. On a matching CEF `OnPaint`, clamp dirty rectangles as today. Under the handoff mutex, copy those rows from CEF's callback buffer into staging and union the dirty area into pending damage. CEF's callback buffer cannot be retained for asynchronous reading. Initialize a new-size staging image from the complete first matching callback, then mark it fully dirty.
2. Between pumps, the executor takes the handoff mutex, copies accumulated dirty rows from staging into its framebuffer, consumes that damage, and releases the mutex. Copying damage metadata alone and then reading staging outside the lock would race the next paint.
3. Only after releasing the mutex, call `rfbMarkRectAsModified` for the consumed damage and run the pump. CEF can now update staging while the encoder reads a stable framebuffer.
4. Preserve the **union of all damage since the worker last consumed it**. Overwriting the pending rectangle list with the latest callback's list loses changes from skipped paints. Keep bounded metadata: one bounding rectangle is simplest and correct, at the cost of sometimes encoding unchanged pixels. A capped rectangle list with a full-region fallback can reduce that cost if evidence justifies it.
5. Repeated paints while the worker is busy update the same staging image. There is no frame FIFO and no unbounded queue. Intermediate visual states may be omitted; the next transmitted pixels remain exact for the latest consumed image.

Do not skip a callback merely because the mutex is busy unless its damage is retained and reconstructed from a later complete callback. Otherwise a final small update can disappear permanently. A short pixel-copy critical section is the straightforward correctness choice; it avoids compression waits but is not a claim of zero UI blocking.

With a shared executor, rotate through active screens. Consume their latest damage before their next pump; do not accumulate a work item for every paint. Wait on a condition variable with a bounded timer when idle, since connected RFB clients can request updates without a new CEF paint. Keep `deferUpdateTime=0` for this comparison.

## Resize and framebuffer lifetime

Logical dimensions and device scale remain UI-owned. Preserve the current same-size/same-scale no-op and the rule that dimensions sent to RFB are physical pixels. A resize changes the staging generation and replaces its storage. Reject old-size paints, and only publish pixels with metadata for the current generation. Generation prevents queued stale handoffs; it is not a substitute for checking CEF's actual paint dimensions.

The worker performs `rfbNewFramebuffer` between pumps, restores the existing BGRA format, and refreshes translation functions **before another client operation**. This is safe by executor confinement rather than by relying on LibVNC internal locks. The replacement function resets the server pixel format and updates client resize/dirty state; it does not free the previous application framebuffer. Keep the old allocation until replacement returns, then free it. [Pinned resize implementation](https://github.com/LibVNC/libvncserver/blob/LibVNCServer-0.9.15/src/libvncserver/main.c#L1071-L1152).

For the smallest behavior-preserving implementation, retain the existing blank resize image followed by fresh paint. An optional later change can keep the old display until the first full matching paint arrives, but must preserve client geometry/input gating and handle page paint failure. Do not conflate that interaction change with initial worker isolation.

The UI must not wait for the encoder to acknowledge resize before accepting further CEF control. Existing backend resize returns before a displayed-frame guarantee; preserve that distinction and continue using the native view's existing dimension checks. No input coordinates should be inferred from worker-owned mutable screen fields.

## Slow clients and shutdown

`rfbNewClient` itself sets the accepted socket nonblocking and attempts TCP_NODELAY, even for the current Unix-socket transport; the TCP option can log a harmless non-TCP failure. It also writes the protocol header before returning. Therefore cancellation registration must happen **before** calling it. [Pinned new-client implementation](https://github.com/LibVNC/libvncserver/blob/LibVNCServer-0.9.15/src/libvncserver/rfbserver.c#L297-L545).

**`maxClientWait` is not a millisecond output deadline.** In 0.9.15, `rfbWriteExact` waits in hardcoded five-second `select` calls after EAGAIN, counts complete timeouts, and resets that counter when the socket becomes writable. A value of 100 does not produce a 100 ms bound, and a trickling reader can repeatedly reset the wait. The default is 20 seconds. A partial read can also block a pump. [Pinned socket read/write implementation](https://github.com/LibVNC/libvncserver/blob/LibVNCServer-0.9.15/src/libvncserver/sockets.c#L735-L963).

For cancellation without cross-thread LibVNC access:

1. After accept, create a CLOEXEC duplicate descriptor and a stable registry token. Under the registry mutex, recheck stop state, then register the duplicate before `rfbNewClient`. If stopping, reject the connection before entering the library.
2. On success, assign a tiny client-data record containing the token and an adapter-owned registry reference; install `clientGoneHook`. The library cannot run another pump before this setup in the foreground worker model. On construction failure, remove/close the duplicate through the token's failure path. Audit ownership of the original descriptor on each library failure path; do not blindly close a possibly already-closed descriptor.
3. `clientGoneHook` removes the token and closes its duplicate under the registry mutex. Do not look up by `cl->sock`, which can already be invalid when this callback runs. Never depend on a saved raw descriptor number remaining unreused.
4. `requestStop` marks stopping and, under that same registry mutex, performs `shutdown(dup, SHUT_RDWR)` on registered duplicates. It does not close them or call `rfbCloseClient`, `rfbShutdownServer`, or inspect the client list. The worker keeps ownership of original descriptors; registry synchronization protects duplicate lifetime.
5. The executor leaves the current library call, stops accepting, runs `rfbShutdownServer(screen, TRUE)`, frees the primary framebuffer, nulls its pointer, and calls `rfbScreenCleanup`. The listener/path and remaining registry tokens are cleaned up exactly once. LibVNC does not free the primary framebuffer for the application. [Pinned cleanup](https://github.com/LibVNC/libvncserver/blob/LibVNCServer-0.9.15/src/libvncserver/main.c#L1155-L1254), [client-gone callback lifecycle](https://github.com/LibVNC/libvncserver/blob/LibVNCServer-0.9.15/src/libvncserver/rfbserver.c#L553-L612).

Socket shutdown must be acceptance-tested on both Mac and Linux to prove it interrupts the exact blocked read/write path used here. It cannot interrupt CPU compression mid-call. Avoid joining a live encoder on the CEF UI thread for ordinary Page close; let the executor finish cleanup and return a completion record. Process teardown can wait after CEF callbacks stop. If an implementation uses a synchronous join initially, measure and disclose that remaining close latency rather than describing it as fully nonblocking.

A single worker's pump still visits viewers sequentially. A passive reader can delay another viewer; with the shared executor it can delay other pages too. Latest-frame staging bounds memory and preserves CEF responsiveness, **not viewer fairness**. Keep Portal's bounded media queues and close backpressured peers; add an independently enforceable stalled-send deadline if needed, using the registry to interrupt a socket. Do not promise per-viewer isolation from `maxClientWait`. A deadline should identify the stalled client via worker-side hooks/progress data and be enforced independently of the blocked worker, not indiscriminately disconnect every healthy viewer.

## Alternatives and validation gates

### Build and call-site audit

`product/portal/scripts/build-browser-runtime.py` currently assumes preprepared `lib-{mac,linux}` directories and links their `libvncserver.a`; it does not configure that library. The minimal reproducible build change is to configure a distinct `lib-server-single-{mac,linux}` directory from the same checksum-pinned source, with Release/static libraries and `-DWITH_THREADS=OFF`, build only the `vncserver` target, and select both its generated `include/rfb/rfbconfig.h` and archive. Preserve the existing disabled optional feature set and platform SDK/architecture flags. Do not reuse a successful old build based only on archive existence; validate the configuration or encode it in the variant path. Do not manually undefine threading in the adapter while linking the old archive.

`product/alpha/scripts/prepare-native-browser.ts` separately prepares `vncclient` for Mac and iOS. It should remain unchanged for this Host optimization. `build-browser-runtime.py` already links pthread on Linux for C++/CEF needs; removing LibVNC internal threading does not mean removing process threading support. When `WITH_THREADS=OFF`, conditionally compiled LibVNC fields such as `backgroundLoop` may not exist: use the foreground API without assigning such fields unconditionally.

A source search found all current product Host LibVNC calls and screen-field accesses in `cef-host.cc`: destructor, initialization, `OnPaint`, resize, and pump. Move all five groups behind the adapter, including dimension reads in `OnPaint`; retain UI-owned expected dimensions for that check. `screenData` must reference worker-owned state, not Page, and the existing no-op pointer/key hooks and resize-prohibited hook must remain free of CEF/UI calls. The native Mac/iPad LibVNC clients execute in separate applications, so their threading configuration is outside the Host executor. This is a source inventory, not post-implementation thread-safety verification.

| Option | Benefit | Limitation |
| --- | --- | --- |
| Shared executor + server `WITH_THREADS=OFF` | Stock build option, no CEF compression, confined library globals, small adapter | Encoders serialize; stalled sockets need external cancellation |
| One Page worker + existing pthread build | Attractive Page isolation | Blocked by observed global mutex reinitialization; not approved as safe |
| LibVNC background event loop | Upstream per-client I/O threads | Shared framebuffer synchronization, resize send locks, custom Unix accept requires `rfbStartOnHoldClient`, same global initialization issue |
| Separate RFB process per Page | Isolates globals and CPU/socket stalls | Extra process lifecycle and pixel IPC; larger maintained surface |
| Lock the existing framebuffer during encoding | Avoids extra pixel copy | Makes CEF wait for compression/output and defeats the purpose |

Diagnostics must also respect ownership. `BrowserDiagnostics` currently mutates vectors, counters, `FILE*`, and reporting state from both `paint` and `pump` conceptually. Moving pump requires changing that arrangement: accumulate worker pump metrics separately, transfer bounded plain samples/counters to the UI, and keep existing reporting on one thread; alternatively move reporting entirely to the worker and send paint counters through the handoff. Do not merely call its existing methods concurrently. Record staging-copy time, lock wait, damage area, worker pump time, dropped intermediate generations, and stop-to-cleanup time.

Before performance claims, validate exact 2× pixels during concurrent paint, rapid alternating resize, Page close during stalled protocol read and stalled output, duplicate-descriptor cleanup, reconnect, and multiple pages opening while another scrolls. Include active plus passive viewers, prove stale-focus/revoked-client input remains rejected through Portal, and run Mac and iPad native display acceptance. Compare CEF paint cadence, input-to-visible median/p95, native FPS, and CPU under the same viewport and page. Worker isolation overlaps work; it does not reduce ZRLE's intrinsic CPU cost or establish a 60 FPS guarantee.
