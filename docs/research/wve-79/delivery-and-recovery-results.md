# Browser delivery and recovery checkpoint

WVE-79, 2026-09-16. This follows the accepted interaction, Retina RFB, Mac Metal and zlib-ng checkpoint, committed as `ee6ee4c1`. Audio, webpage accessibility and the upstream Mac HTML select-menu regression remain deferred.

## iPad delivery measurements

The iPad Air M3 ran the same 20-second scrolling fixture at 929 × 751 logical pixels and 1858 × 1502 framebuffer pixels. Runs used software CEF, lossless ZRLE, zlib-ng and the normal iPad CGImage presenter. The fixture reverses direction every five seconds. There were no concurrent builds or other acceptance fixtures during the measured runs; the user's ordinary Host remained running. This is a quiet-fixture comparison, not a claim that the whole Mac was idle.

Latency is the fixture's input capture to native layer submission, measured on the iPad during the first forward segment. It is not physical scanout latency. Content FPS counts distinct decoded scroll positions. The network diagnostics use stock WebSocket ping/pong and URLSession completion callbacks; they add measurement overhead and remain opt-in.

| Route / configuration | Content FPS | Median latency | p95 latency | Stream Mbps |
| --- | ---: | ---: | ---: | ---: |
| LAN, plain WebSocket | 12.45 | 217 ms | 348 ms | 22.77 |
| Trusted Tailscale hostname, TLS, default A | 16.75 | 144 ms | 300 ms | 30.21 |
| Same TLS route, responsiveData B | 17.20 | 154 ms | 374 ms | 32.56 |
| Same TLS route, default A repeat | 17.10 | 139 ms | 271 ms | 31.95 |

All four runs retained the exact final scroll displacement, reported zero failed input RPCs and passed the native sample-coverage check. None passed the 60 FPS cadence gate. The initial diagnostic run exceeded the old sample limit and is excluded; the collector now retains up to 100,000 records, and the summarizer rejects incomplete frame coverage. Fixture pairing cleanup is also awaited and checked before a run returns.

The plain-WebSocket Tailscale-IP attempt failed at pairing. It produced no performance result. The successful LAN and VPN routes therefore differ in TLS as well as addressing and path; the table does **not** establish that VPN or encryption makes delivery faster. It also does not determine whether Tailscale used a direct peer path or relay for every packet.

Apple documents `responsiveData` for interactive connections where a quick response is expected. In the matched A/B/A comparison it did not improve latency or useful throughput enough to justify a default change. The option remains diagnostic only. [Apple network service type documentation](https://developer.apple.com/documentation/foundation/nsurlrequest/networkservicetype-swift.enum/responsivedata)

### Where the time goes

The final default TLS run gives the following component medians. These distributions describe overlapping pipeline stages and must not be added to reconstruct one input's latency.

| Stage | Median |
| --- | ---: |
| Client input queue | 12 ms |
| Input RPC round trip | 17 ms |
| Portal queue / authorization / page lookup | 0.002 / 0.035 / 0.239 ms |
| Host native input command | 9.35 ms |
| WebSocket ping round trip while streaming | 9.91 ms |
| Decode-loop wait between updates | 19.84 ms |
| Update transfer wall time excluding decoder CPU | 24.53 ms |
| Decoder CPU per update | 9.18 ms |
| Frame copy | 1.63 ms |
| Native main-queue wait | 0.014 ms |
| CGImage layer submission | 2.17 ms |

URLSession receive-to-bridge scheduling and local socket writes were around hundredths of a millisecond. The native request-send completion was also sub-millisecond; this is local send completion, not a server acknowledgement. Portal's application WebSocket buffer was usually empty, with a maximum of approximately 110 KB; observed buffer drain intervals had a 10 ms median and 39 ms p95. This does not expose bytes queued in either kernel or prove absence of network queueing.

CEF continued painting at approximately 60 FPS while the client displayed about 17 FPS. The evidence puts the largest remaining opportunity in the serialized update request, encoding/transfer and decoding path. Reworking authorization, moving the small local bridge or adopting the network hint is unlikely to produce a major latency improvement. Mac Metal remains the accepted default; these measurements do not establish an iPad Metal battery advantage.

For a subsequent bounded performance experiment, compare stock LibVNC update/encoding choices and measure request-to-first-byte and complete-update age before changing transport policy. Retain lossless 2× pixels, validate displacement and stale-frame recovery, and reject an apparent FPS gain if latency tails or bandwidth regress substantially. The previously failed early-request experiment is not adopted. Achieving 60 FPS remains an open performance objective, not an accepted result.

## Lifecycle and recovery

The current integrated Mac acceptance uses real CEF, Browser Service IPC, Portal authentication and maintained MCP tools. Disposable state and a private fixture server keep user pages and Profiles outside the test scope.

- ACP/MCP can discover all Host Profiles, inspect an existing human page, create a page as a Right split, evaluate, capture a screenshot, read console/network events and step the debugger. The added `close_page` check verifies removal of both the live page and its Pane composition.
- Separate temporary Panes have separate cookies and local storage. A website popup shares its opener's temporary identity. Closing the opener retains the popup's storage; closing the last related page deletes the temporary Profile and its data directory.
- Reopening Portal and its public RPC server against the same Browser Service preserves the trusted pairing, Host/Pane identity, browser generation and live JavaScript activity.
- Killing only the isolated Profile's native process makes its page unavailable. An ordinary create retry does not silently recreate it. Explicit Restore retains Page/Profile identity, rotates generation and rejects commands carrying the old generation.
- Restarting the Browser Service leaves persisted page records unavailable until explicit Restore. Orderly shutdown preserves persistent cookies/local storage and temporary storage still owned by a surviving Pane.
- An immediately preceding local-storage write was lost in the forced-crash case. This is recorded separately from orderly shutdown persistence; the product does not promise crash durability for writes Chromium has not flushed.
- Two authenticated viewers retain focus/viewport authority, 2× geometry and exact captured pixels. Popup close and credential revocation stop the relevant attachment without closing the unrelated live page.

### Slow viewer limit

The current RFB worker belongs to a Profile, not to each viewer. An authenticated client sending an incomplete RFB reply blocked another display's greeting within that Profile, while Chromium's JavaScript and CDP continued. Closing the stalled peer through Portal restored the other display in **26 ms** on the Mac. This proves cancellation and recovery; it does not prove independent progress for healthy viewers while a stalled viewer remains connected.

The stock non-threaded LibVNC implementation has blocking reads and writes. Its default client wait is 20 seconds, and its write loop contains a five-second `select` retry even when a shorter client timeout is configured. The existing native worker test separately covers a non-reading raw framebuffer consumer: staging/resize/close remain prompt, and Linux worker recovery permits that stock five-second wait. Portal also caps its application output buffer at 4 MiB. Those bounds do not make a slow viewer harmless to another viewer in the same Profile. Avoid claiming per-viewer isolation without a separate design and acceptance gate.

### ACP process cleanup

The real configured Codex ACP provider successfully inspected the shared fixture through `weave-browser`, then reproduced the post-prompt process-group `EPERM`. A minimal shell launcher with a sleeping descendant reproduced the same transient error; after 20 ms, the group was absent (`ESRCH`). This is consistent with Darwin's group signaling and exiting-process behavior. [Apple XNU signal implementation](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_sig.c)

ACP cleanup now retries the same private process group for at most 200 ms on Darwin `EPERM`. Persistent permission errors still reject. Escalation errors are returned through the close promise rather than escaping a timer callback. Focused tests cover the transient case, persistent failure and termination without touching an unrelated process. The real configured provider then repeated its successful page inspection and exited cleanly (exit code 0). The full repository check passed 505 tests, plus builds and type checks.

## Evidence and outstanding gate

Measurements: `/tmp/weave-browser-scroll-thmgcm` (LAN), `tneXcS` (TLS default), `khqfFu` (TLS responsiveData), `2YBopG` (TLS default repeat). Each contains the fixture result, native timing records, Host timings, CEF diagnostics and a generated `summary.json`. The incomplete `m5f1X3` run and failed `dZyqq9` pairing are excluded.

Mac acceptance evidence: `/tmp/weave-rfb-step3.json`, `/tmp/wve79-browser-recovery.json`, `/tmp/wve79-agent-acceptance.json`. Reusable entry points are `browser-rfb-portal-acceptance.ts`, `browser-recovery-acceptance.ts` and `browser-agent-acceptance.ts` under `product/portal/scripts`.

**The Linux gate subsequently passed on 2026-09-16 after Bazzite returned online.** The checks below supersede the earlier connectivity blocker. Broader IME, file transfer, dialog and packaging decisions remain for the requested step-4 discussion.

## Linux acceptance and precision wheel correction

The isolated Linux checkout used the checkpoint source, Bun 1.3.14, Node 24.19.0, the same pinned software CEF 152 build and zlib-ng 2.3.3. It reused prepared upstream dependencies and built the current adapter; no Chromium source build, GPU enablement, Xvfb or deployed Linux Host changes were needed. The pinned maintained chrome-devtools-mcp 1.9.0 package was installed with lifecycle scripts disabled.

The Linux lifecycle and deterministic ACP/MCP checks passed: live Portal reconnection, explicit Restore and generation rotation after a native crash, orderly Browser Service storage preservation, independent temporary identities, popup sharing/last-close deletion, agent creation as a Right split and removal of both the Page and Pane on agent close. Debugger pause/step/resume, snapshot, screenshot, console and network access passed. This is an actual ACP-to-MCP-to-CEF integration test with a deterministic provider, not an additional real Codex-provider run. The real provider and its clean exit were already accepted on the Mac.

The stronger interaction gate found a real wheel issue. In a nested area with a horizontal scrollbar, a native `(deltaX=32, deltaY=120)` input reached the DOM unchanged but moved Linux Chromium only 105 vertical pixels. Waiting 900 ms instead of 200 ms did not change that result. The adapter now sets upstream `EVENTFLAG_PRECISION_SCROLLING_DELTA` because Alpha supplies pixel deltas. CEF's Aura delegate maps this flag to Chromium's corresponding UI flag. No browser fork, custom event replay or protocol change was introduced. [CEF Aura wheel translation](https://github.com/chromiumembedded/cef/blob/master/libcef/browser/native/browser_platform_delegate_native_aura.cc)

With that flag, both Hosts pass the unchanged scroll-displacement requirements: ten quarter-pixel inputs produce three accumulated pixels; nested scrolling moves exactly 120 vertically and 32 horizontally without moving the page; `preventDefault` cancels movement; and wheel/button ordering is retained. Linux's native selected-word deletion keeps a separator that the Mac removes, so the fixture accepts either exact remaining string and verifies the subsequent Unicode paste. The fixture now also awaits compositor frames after inserting its scroll target, and the external-capture timeout no longer extends every interaction wait.

The Mac native LibVNCClient decoded Linux Portal output through a private SSH stream forward over Tailscale. Two captures at **2000 × 1600** compared with Chromium's PNG with **zero differing pixels**. The stock client's resize request did not override Portal's viewport ownership. This proves current Linux Host output with an independent native decoder; it is not a claim that the normal iPad app connected directly to the Linux fixture. The Mac/iPad app builds and their Mac-Host acceptance remain as recorded above.

Linux shared-view focus/viewport handoff, context actions, editable/read-only/password handling, popup Right splits, shared close, unattended JavaScript and credential revocation passed. A partial RFB client still couples displays within its Profile: Chromium continued and closing the peer recovered the next display in approximately **26–29 ms**. The same limit remains on the Mac. Native worker cancellation/resize tests and the 80-update, 5,431,340-byte exact compression compatibility check passed on both platforms. Linux process-group tests passed; the Darwin-specific transient-error test was correctly skipped there.

[Linux recovery evidence](evidence/linux-acceptance-20260916/recovery.json), [ACP/MCP evidence](evidence/linux-acceptance-20260916/agent.json), [RFB/interaction evidence](evidence/linux-acceptance-20260916/rfb.json), [native decoder result](evidence/linux-acceptance-20260916/decoder.json), [pixel comparison](evidence/linux-acceptance-20260916/comparison.json), and [build/capture provenance](evidence/linux-acceptance-20260916/provenance.json) are retained in the repository.
