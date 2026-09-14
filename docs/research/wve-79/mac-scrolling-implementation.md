# Mac lossless scrolling implementation and acceptance

WVE-79 · 2026-09-13. This implements the first bounded pass of the [scrolling plan](scrolling-upstream-findings.md). Testing and installation are Mac-only; no iPad or Linux Host was accessed.

## What changed

The initial integrated test exposed input starvation even while native presentation ran near 60 Hz. A wheel request waited for Chromium's DevTools response before sending the next event. Responses commonly took two or three frame intervals. At 120 input events/s the 64-entry client queue filled, introducing seconds of queued motion and rejecting further input.

The client now sends the first wheel promptly and combines compatible pending deltas, preserving their sum. Pointer location, direction, modifiers, non-wheel events, focus and resize form boundaries. Losing visibility/focus invalidates queued input; pointer events from a previous viewport cannot be replayed against reflowed content. DOM line/page units become CSS pixels, including horizontal page width. One RPC remains in flight, with a bounded pending accumulator.

Portal now performs two credential reloads per input instead of four. Both authorization boundaries remain: before page lookup and again before dispatch. There is no authorization cache. A regression test revokes the credential during page lookup and verifies that input never reaches Chromium. Page lookup was retained because its measured cost was below a millisecond.

Coalescing alone removed the backlog but left scrolling near 30 FPS. A bounded probe of upstream `CefBrowserHost::SendMouseWheelEvent` reached 59.9 distinct scroll updates/s, without changing the renderer or encoder. The product now uses this API for supported human wheel events. It keeps Chromium responsible for hit testing, nested scroll containers, wheel listeners and cancellation. This avoids adding a custom asynchronous CDP input protocol or batching protocol.

The existing private `page.cdp` request carries an optional `nativeInput` hint and a view/focus token supplied by Portal after authorization. Agent CDP commands retain their full DevTools responses. Unknown event fields and unsupported parameter forms fall back to CDP. Older native runtimes ignore the hint and retain existing behavior; no public protocol version changes. A human wheel acknowledgment means CEF accepted the event, not that a frame reached the display.

CEF's API accepts integer CSS pixels. A small native accumulator rounds cumulative fractional movement within a gesture rather than rounding each event independently. Its remainder resets on ownership, target, modifier, direction, idle, non-wheel input or resize boundaries. At a boundary at most half a CSS pixel per axis remains unrepresented. Ten quarter-pixel deltas produce three pixels rather than zero; 1,000 quarter-pixel deltas produce exactly 250 pixels.

Relevant implementation: [client ordering](../../../product/alpha/src/browser/browser-view-connection.ts), [Portal authorization and dispatch](../../../product/portal/src/browser-pages.ts), [CEF adapter](../../../product/portal/native/browser/cef-host.cc), [fractional input](../../../product/portal/native/browser/wheel-input.h). The upstream API is declared in the pinned CEF 152 SDK and [the pinned browser-host header](https://github.com/chromiumembedded/cef/blob/708dc14/include/cef_browser.h).

## Measurement method

The benchmark creates disposable local Portal, Browser Service, CEF Profile and Alpha app state. It opens a real native Browser Pane through the product UI. The daily Host credentials and Workspace state are not used. The fixture combines small text, a sticky header, code, nested overflow containers and vector images.

Each measured run waits for the acknowledged native viewport, warms up for two seconds, then sends pixel wheel events at 120 Hz for 60 seconds, reversing direction every five seconds. A final 6.5-second phase lets input settle and the bounded diagnostic writer flush. Baseline and candidate runs alternate three times. Both use the same instrumented CEF binary; the frozen baseline Portal sends ordinary CDP requests, and its frozen Alpha retains the old input queue. No builds run during these final comparisons.

The Host page and decoded framebuffer are **1147 × 849 at page DPR 1**. The Mac shell reports DPR 2; that does not make the remotely rendered page DPR 2. All traffic uses Mac loopback through Portal's authenticated WebSocket transport. These are not LAN/VPN or physical iPad results.

Two fixture pixels encode scroll position and animation sequence. The native client reads them only when `WEAVE_BROWSER_FIXTURE_MARKERS=1`. Distinct scrolling FPS counts changes to scroll position, not animation callbacks or repeated frame submissions. Frame intervals use the native monotonic clock. Software event-to-layer estimates match cumulative displacement in the first forward segment using same-Mac epoch timestamps; they are not physical input-to-photon measurements. Baseline targets that never appear during that segment are censored and reported through matched-sample counts, so latency figures must not be treated as a complete distribution of all baseline input.

Opt-in diagnostics record bounded numeric timings/counts for client queue/RPC, Portal authorization/page lookup/dispatch, CEF paint counts and dirty area, RFB pump duration, native copy/main-queue/submission, received bytes and decoder CPU. Process CPU/RSS are sampled estimates for the disposable harness and descendants. No credentials, key contents, URLs or browser Profile files are included in the archived evidence.

An exploratory run that began before viewport readiness and a run overlapping a build were excluded. Early probe results are distinct from final product acceptance.

## Final scrolling results

Three interleaved 60-second repetitions, all at the same 1147 × 849 framebuffer:

| Run | Baseline distinct FPS | Candidate distinct FPS | Baseline queue p95 | Candidate queue p95 | Candidate frame p95 / p99 | Candidate software latency p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 25.38 | 59.87 | 3100 ms | 17.6 ms | 18.2 / 19.0 ms | 112 ms |
| 2 | 29.13 | 58.12 | 2548 ms | 15.2 ms | 18.6 / 33.5 ms | 109 ms |
| 3 | 28.28 | 59.37 | 2583 ms | 17.3 ms | 18.3 / 20.5 ms | 90 ms |

All three candidates pass the proposed cadence gate (at least 57 distinct updates/s, p95 interval at most 25 ms, p99 at most 50 ms). All preserve the scripted displacement exactly: the timer's actual direction/event counts predict final scroll positions of 0, 32 and 16 pixels respectively, and Chromium reports exactly those values. The baselines should each end at zero but instead end at 632, 520 and 616 pixels after overflowing the old input queue.

The low-latency goal is **not met**: candidate software p95 is 90–112 ms, above the proposed 80 ms target. The earlier whole-pixel probe's 77 ms p95 did not repeat consistently in final product runs. Do not substitute that best probe for the product results.

The separate 60-second no-input animation control produces 59.83 distinct updates/s, with 18.3 ms p95 and 19.0 ms p99 intervals. Candidate scrolling uses about 49.9–51.4 Mbps of lossless RFB traffic. The RFB pump occupies approximately 530–570 ms of each second on the CEF loop, including encoding/socket work; its worst individual calls reach 14.5–16.9 ms. That is a scheduling risk worth investigating even though this viewport meets the cadence gate. These wall-time measurements are not encoder CPU attribution.

Raw numeric evidence, summaries and the independent lossless checkpoint are retained under [mac-scrolling-20260913](evidence/mac-scrolling-20260913/manifest.json). Baseline latency estimates contain only 138–141 matched targets from the first forward segment; every candidate matched 540. Reported cadence is native layer submission of changed content, not camera-verified scanout.

## Correctness checks

- Client burst test: 1,000 fractional wheel events behind a stalled RPC preserve total displacement with one pending batch.
- Button/key, direction, target and modifier boundaries retain order. Hiding/re-focusing cannot replay stale queued input, and rejected ownership stops further input.
- Native accumulator checks preserve fractional totals and reset state at gesture boundaries.
- Real CEF/Portal acceptance confirms fractional movement, nested vertical and horizontal scrolling, page cancellation, and wheel-before-button ordering.
- The existing two-client ownership, stale input, repeated same-size focus, popup Right split, unattended lifetime and credential revocation checks pass.
- A settled native RFB capture matches Chromium's reference at 1000 × 800 with **zero differing pixels**. The native capture precedes the reference capture so a screenshot-triggered repaint cannot hide the crop regression.

## Remaining gates

The 60 FPS result applies to this Mac route, fixture, viewport and scripted input. It does not establish physical scanout timing, natural trackpad feel on arbitrary pages, higher pixel-count performance, slow/passive viewer behavior or iPad touch performance. Audio and the webpage accessibility bridge remain deferred.

RFB encoding still executes on the CEF loop and consumes a substantial fraction of its time. The next latency experiment should isolate its scheduling and slow-viewer impact, then evaluate an upstream-synchronized worker with bounded framebuffer handoff if justified. Main-queue wait and framebuffer copy are small in these traces; a custom Metal renderer is not the next change. Sustained 60 FPS and low input latency remain separate acceptance gates.

## Installed Mac validation

The normal acceptance-disabled Alpha build and signed Host/CEF artifacts are installed. The restored daily test Pane renders at 1077 × 849; scrolling down/up and clicking the counter through the installed Mac UI work without cropping. The terminal owner remains PID 13352, with the existing nvim/zsh Panes retained. Installed Host and CEF hashes match the packaged artifacts in the evidence record. Full repository checks pass: 293 Alpha, 138 Portal and 39 protocol tests, plus boundary/tooling/build checks.

The Host initially lacked its stable signing identity; it was re-signed as `xyz.veezee.weave.portal` using the existing Apple Development identity. The background LaunchAgent then remained blocked during workspace directory inspection, with macOS TCC authorization requests for Documents access. The same signed binary starts and serves normally from the interactive session. On 2026-09-14, after the user approved Documents access locally, the interactive Host was stopped and the original LaunchAgent was loaded successfully. Its background process served a healthy HTTPS endpoint with the same source hash, and the Mac app reconnected with the Browser page and existing pane list intact. The existing terminal and Browser Service processes survived the handover. Background startup is now verified; no TCC database or security setting was modified by the agent.

Installation backups are under `~/.local/share/weave/backups/browser-scrolling-20260913-203227/` and the normal desktop installer's timestamped backup directory. Browser Profile and Pane records were retained across graceful Browser Service shutdown and explicit page restoration; the test page itself reloaded.

## Reproduction

Build an acceptance Alpha with `VITE_ALPHA_ACCEPTANCE=1 bun product/alpha/scripts/build-desktop.ts`, and the signed small CEF adapter with `product/portal/scripts/build-browser-runtime.py`. Run:

```sh
WEAVE_BROWSER_DIAGNOSTICS=1 \
  CEF_BINARY="/absolute/path/Weave Browser.app/Contents/MacOS/Weave Browser" \
  bun product/alpha/scripts/browser-scroll-acceptance.ts
bun product/alpha/scripts/summarize-browser-scroll.ts /tmp/weave-browser-scroll-XXXXXX
```

`ALPHA_BINARY` can select a frozen acceptance app; `BROWSER_SCROLL_SECONDS` defaults to 60. `BROWSER_SCROLL_ANIMATION=1` runs the no-input animation control. Acceptance builds are not the daily installation; rebuild without `VITE_ALPHA_ACCEPTANCE` before installing.

Native fractional checks: compile and run `product/portal/scripts/browser-wheel-acceptance.cc` with C++20. Full native/control/fidelity checks use `product/portal/scripts/browser-rfb-portal-acceptance.ts` with `CEF_BINARY`, `BROWSER_RFB_SNAPSHOT_BINARY`, and a fresh `BROWSER_EVIDENCE` path.
