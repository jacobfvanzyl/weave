# Bounded iPad lossless RFB optimization

WVE-79, 2026-09-13. Jaco selected lossless RFB as the priority and authorized
one bounded iPad optimization pass. Audio is deferred. This pass does not
change the product backend or expand the custom Viz compositor.

## Result and decision

**The bounded pass is complete; it did not establish a reliable scrolling
improvement.** Keep the acknowledgment option disabled by default. Both tuned
runs remain below 30 decoded updates/s, and overlap the control-run variation.
The original earlier comparison measured 20.8 updates/s; fresh controls measured
11.4 and 18.2. This route variability prevents treating the first tuned run's
increase over the first control as a proven optimization.

| Run | Presentation | Click p50 / p95 ms | Scroll updates/s | Scroll Mb/s | Scroll CPU, one core |
| --- | --- | ---: | ---: | ---: | ---: |
| baseline | on | 47.2 / 101.0 | 11.4 | 7.12 | 13.9% |
| no-present | off (diagnostic) | 47.5 / 109.9 | 16.8 | 10.35 | 14.9% |
| more-acks | on | 35.6 / 109.7 | 17.1 | 10.66 | 19.6% |
| control-repeat | on | 43.1 / 120.8 | 18.2 | 11.31 | 20.3% |
| more-acks-repeat | on | 44.0 / 79.9 | 16.3 | 10.22 | 18.3% |

All five runs completed with **120/120 input responses**, no input timeouts,
and exact agreement on all **2,112,000 static content pixels per run**. The
96 responses in the four normal-presentation runs are user-facing-path
measurements; the other 24 belong to the diagnostic without presentation.
The main-thread guard skipped no presentations during these runs. Neither
physical display cadence nor touch-to-photon latency was measured.

During scrolling, full-frame copies averaged 2.0–2.2 ms in the presented runs.
Main-queue p95 was below 0.2 ms; image submission averaged below 0.6 ms. With
presentation disabled, the handler averaged 8.9 ms of thread CPU and 22.3 ms
of wall time in the steady scrolling window, and scrolling still reached only
16.8 updates/s. This evidence does not justify a custom Metal renderer as the
next response to the current stalls.

The tuned repeat still records TCP retransmissions. The small public socket
setting did not resolve the transport behavior. No encoding, browser, library,
or protocol fork was introduced, and no host-wide networking setting changed.

**Continue to prefer lossless RFB, but keep the iPad scrolling gate open.**
Preserve the existing WebRTC implementation and keep Viz expansion paused.
Any later performance work should target the amount of lossless data sent and
TCP behavior on the actual route, using maintained components. A renderer
rewrite is not supported by this pass. Requiring a stable 30 FPS at DPR 2 would
remain a blocker to declaring this composition accepted; prioritizing lossless
pixels does not by itself waive that goal.

The original RFB Spike app was restored on iPad. All benchmark processes were
stopped; Linux cleanup was read back. Native Mac compilation and Python syntax
checks passed. The candidate remains an explicit experiment-only environment
switch; no product source or installed library was edited.

Evidence: [acceptance checks](evidence/rfb-optimization-validation.json),
[structured run summaries](evidence/rfb-optimization-summary.json), and each `ipad-opt-*` run's
native logs, independent PNGs, configuration and Host samples. Linux socket
samples are in the two `*-repeat/server-tcp.jsonl` files. The repeated control
and tuned runs record identical source hashes, differing in the socket option.

## Scope and method

Use the existing Linux CEF Host, LibVNC 0.9.15 ZRLE decoder and native
UIImageView receiver at 1920 × 1280 pixels (960 × 640 CSS, DPR 2). Keep the
same corpus, 24 measured input responses, static reference image and phase
windows as the original comparison. Retain the one-pending-presentation guard.

Instrument full-frame copy duration, main queue delay, image submission
cost, and LibVNC message-handler wall time. Additional handler thread CPU
measurement was added after the initial instrumented baseline. Handler wall
time includes socket reads, decoding and the synchronous completion callback;
it is not a pure decoder measurement. Thread CPU likewise includes those
callbacks. Main-thread submission is not physical display presentation.

A diagnostic run disables all image copies and native presentation, while
retaining the decoder, marker probe and static image validation. This is only
a bottleneck diagnostic, not a candidate user-facing implementation.

The single optimization candidate enables Apple's public `TCP_SENDMOREACKS`
socket option after connection setup. The experiment verifies both the setter
result and the value read back from the socket. Apple documents this option as
acknowledging every other incoming packet instead of its acknowledgment
reduction algorithm. It does not disable every delayed acknowledgment, change
RFB framing, add a frame queue or change image fidelity. See the
[Apple TCP manual source](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/man/man4/tcp.4).

Source inspection found that LibVNCClient already sends its next incremental
framebuffer request before the completion callback; both library endpoints
already set TCP_NODELAY. Those are not new optimization opportunities here.
The relevant pinned sources are `src/libvncclient/rfbclient.c` and
`src/libvncclient/sockets.c` in LibVNCServer 0.9.15.

## Reproduction

```sh
BENCH_CLIENT=ipad python3 experiments/browser-remoting-comparison/run.py linux rfb 2 ipad-opt-baseline
BENCH_CLIENT=ipad BENCH_NO_PRESENT=1 python3 experiments/browser-remoting-comparison/run.py linux rfb 2 ipad-opt-no-present
BENCH_CLIENT=ipad BENCH_MORE_ACKS=1 python3 experiments/browser-remoting-comparison/run.py linux rfb 2 ipad-opt-more-acks
```

Use a unique run label for each repetition. `run.py` builds and installs the
isolated RFB benchmark in the existing Browser Spike app slot; private runtime
configuration remains under ignored `.build/`. No Chromium rebuild or library
patch is required.

## What the instrumentation can establish

The image-copy and main-queue costs are measured separately. The diagnostic
without presentation still stalls, which rules out image presentation as the
sole explanation; it does not prove copying has no performance cost. CPU
measurements include all work in the instrumented handler and are not an
isolated ZRLE decoder microbenchmark.

The repeated control also has read-only Linux `ss -tin` samples. During the
captured interval, `bytes_retrans` grows from 93,175 to 129,256, the socket's
retransmission timeout reaches 554 ms, and its congestion window falls to one
segment. These are direct observations of TCP retransmission/recovery, not
proof of the underlying cause (Wi-Fi loss, reordering, acknowledgment delay,
or another route behavior). A sample reports a 3 ms minimum RTT, so the long
stalls cannot be described simply as a uniformly slow path. No host-wide TCP
settings were changed. The sampled Linux socket uses BBR.

The tests use the existing direct Tailscale route between Bazzite and iPad.
The host's live peer status reported the iPad endpoint at
`192.168.1.137:41641`. These are not arbitrary-internet or TURN measurements.

The original interactive shared-viewport implementation is unchanged. This
performance pass checks automated browser input and pixel reconstruction; it
does not repeat the earlier human-confirmed two-viewer resize acceptance.
