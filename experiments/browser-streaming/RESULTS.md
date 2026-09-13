# WVE-79 feasibility slice results

The extension-to-native WebRTC architecture has passed the initial automated media and viewport checks on macOS and Linux Hosts, using a native Mac client and a physical iPad. Those initial results came from an isolated harness. The subsequent Portal/service integration milestone is recorded below; the full Browser product remains incomplete. Jaco confirmed that the physical iPad page animates and that the test tone is audible. Media statistics and that manual confirmation are recorded separately.

## Product integration milestone — 12 September 2026

The product Browser Service now owns capture and WebRTC peers as well as Chromium/profile lifetime. Portal exposes validated tab/view RPCs through its authenticated connection, scopes them to Workspace/action grants and binds each view to the attaching connection. Configured Portal clients can start the separate owner automatically, and builds include the companion executable plus the shared production extension assets.

| Integrated path | Evidence | Boundary |
| --- | --- | --- |
| macOS Portal/service → native Mac | Video, nonzero Opus energy, remote click, independent tab switching and 960×640 → 800×600 generation transition; stale click rejected | Disposable adapter and synthetic fixture; no Alpha pane |
| Compiled Linux Portal harness/service → native Mac | 17,837 decoded frames across almost 10 minutes of sampled statistics, last sample 29 FPS, 960×640 VideoToolbox; nonzero audio energy, playback enabled, recording disabled; selected Tailscale IPv6 UDP route | Not a latency/quality benchmark; small synthetic workload |
| Unrenewed real media grant on macOS | After the 30-second deadline, peers 1 → 0 and captures 1 → 0; browser remained available | Tests expiry with service running, not a frozen-owner fault injection |
| Authenticated Portal RPC | Wrong Workspace, old credentials without browser grants and another connection's view ID rejected; credential revocation detached the view | Synthetic backend isolates authorization from media |
| Physical iPad | Updated Portal-backed receiver build installed | Launch blocked by the device lock; this new path's cross-device handoff remains pending. Earlier harness video/audio confirmation still stands |

Sanitized records: [Mac Portal media](evidence/portal-service-mac.json), [Linux Portal media](evidence/portal-service-linux.json), [real media expiry](evidence/media-expiry-mac.json). The Linux run predates the final small disconnect-backpressure and ICE candidate queue fixes; the final source passed Portal checks and the real macOS expiry acceptance afterward.

Root `bun run check` passed during this milestone. After the final service edits, Portal type checking and all 102 Portal tests passed. The harness TypeScript check, separate Browser Service builds for macOS/Linux, compiled Linux acceptance harness and physical-iPad native build also passed. The production capture extension is now the single asset source for both harnesses.

This is partial product integration. Alpha embedding, Browser Pane composition and Workspace-close behavior, full native input/IME/clipboard/files, MCP/full-CDP event access, agent-created tab discovery, recovery and an all-open-source browser distribution remain open. Existing credentials are not automatically granted browser access. No installed Host configuration or production deployment was changed.

## Environment and evidence

Tests ran on 12 September 2026 using Bun 1.3.14, Chrome/Chrome for Testing 153.0.8010.36, and LiveKitWebRTC XCFramework 150.7871.02 with its published SHA-256 verified before building. Hosts were macOS arm64 and Bazzite Linux x86_64. The iPad was an iPad Air 11-inch (M3). The standalone app used native SwiftUI controls and the library's Metal video view; the browsed page ran exclusively in upstream headless Chrome.

[evidence/mac-host.jsonl](evidence/mac-host.jsonl) and [evidence/linux-host.jsonl](evidence/linux-host.jsonl) contain lifecycle events and sampled native statistics. Sampling retains the first, last and highest-audio-energy sample for each peer and only the selected ICE candidate pair. These are selected evidence records, not a complete raw trace or benchmark dataset. Full live logs remain outside tracked files.

| Path | Observed result | Limit |
| --- | --- | --- |
| macOS Host → native Mac | H.264 decoded by VideoToolbox, approximately 30 FPS on the fixture, nonzero Opus audio energy | Audible speaker output not independently confirmed |
| macOS Host → physical iPad | Native VideoToolbox decoding; audio device playing, recording false | Native video and audible tone manually confirmed during the session |
| Linux Host → native Mac | VideoToolbox decoding, nonzero Opus energy, output playing and recording false | Small synthetic workload |
| Linux Host → physical iPad | VideoToolbox decoding, approximately 29–30 FPS, nonzero Opus energy, output playing and recording false | Actual media route was LAN for this pair |
| Linux Host → Mac over VPN | Selected local and remote ICE candidates used Tailscale IPv6 addresses over UDP | One real VPN configuration; not all VPN/NAT environments |
| Two independent tabs | Mac and iPad received different tabs concurrently; navigation retained the existing stream | Synthetic navigation, not a broad cross-origin corpus |
| Two viewers of one tab | Both received new frames at the same authoritative dimensions | Small viewer count only |
| Real page input | Native Test click incremented the remote counter to 1 | General pointer/keyboard/IME bridge remains implementation work |
| Stale input | An old-generation native click was rejected by the Host | Not adversarial protocol testing or a formal compositor proof |

## Findings that changed the implementation

**CDP emulated size alone was insufficient.** A 960×640 emulated viewport initially produced an 800×600 tab-capture stream. The working path uses one hidden Chrome window per tab, `Browser.setContentsSize`, DPR-1 metrics and matching capture constraints. Separate windows let independently viewed tabs retain different dimensions inside one browser profile. `Browser.setContentsSize` is an experimental upstream CDP API and requires a tested browser pin. [Chrome DevTools Browser domain](https://chromedevtools.github.io/devtools-protocol/tot/Browser/#method-setContentsSize).

**The default Apple audio adapter attempted microphone access.** The first iPad build terminated with a TCC error demanding `NSMicrophoneUsageDescription`, even though the client added no microphone track. The receiver now selects the maintained LiveKit build's AudioEngine adapter, bypasses voice processing and marks input unavailable. The physical device then reported `audioPlaying: true` and `audioRecording: false`, with nonzero received audio energy. No microphone permission was added. This is a dependency-specific API choice to retain in the packaging assessment. [Pinned native dependency](native/pin.json), [LiveKit WebRTC distribution](https://github.com/livekit/webrtc-xcframework).

**Normal tab muting preserves captured sound.** Independent probes on both Hosts set `chrome.tabs.update(tabId, {muted: true})` before capture. Received waveform RMS remained about 0.035 on each Host. That supports ordinary tab muting as the Host-silence mechanism, with upstream tab capture still supplying remote audio. The extension now mutes newly created tabs and the target before capture. A final Linux-to-native Mac/iPad run included that hook: both clients received nonzero audio energy with output playing and recording disabled. After both clients disconnected, capture stopped while the source AudioContext remained running and both fixture tabs still reported muted. Reattachment succeeded. Host silence is established through Chromium mute state, not an independent acoustic measurement of the Host speakers. [Native muted run](evidence/linux-muted-native.jsonl), [Detached muted state](evidence/muted-native-detached.json). [Mac probe](evidence/muted-mac.jsonl), [Linux probe](evidence/muted-linux.jsonl), [Chrome tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs#method-update).

## Viewport handoff and unattended work

The harness retires the old peer/capture before resizing and starts a newly identified media stream afterward. Native input waits for the new peer's matching-size frame. Eight alternating 800×600 and 960×640 handoffs all reached both native receivers. Observed request-to-matching-frame acknowledgement took 526–540 ms, including the test's 100 ms polling granularity. This is a conservative focus-transition measurement, **not** normal click-to-paint latency. [Handoff results](evidence/handoffs.json).

After both viewers disconnected, the Host reported zero viewers and stopped the unused tab capture. The same Chromium instance and pages remained alive. Over a subsequent 56-second no-viewer interval, each page's JavaScript animation counter advanced by 1,705, and tab B's prior click count stayed at 1. Reopening the iPad app produced a new native frame from the retained browser. This proves viewer-independent lifetime in the harness, not Portal restart recovery or durable Workspace profiles. [Detached state](evidence/lifecycle-detached.json), [Unattended state](evidence/lifecycle-unattended.json).

## Performance interpretation

Native statistics repeatedly reported approximately 30 decoded FPS at the tested resolutions. Mac visual inspection showed the fixture, its text and animation in the native view; the initial fixture charset defect was corrected. This is basic feasibility evidence. It does not establish DPR-2 text quality, input latency percentiles, WebGL/video-heavy behavior, thermal limits or a production bitrate budget.

One Linux snapshot with two synthetic tabs/viewers counted 19 Chromium processes, aggregate RSS 1,914,032 KiB and summed lifetime-average CPU of 60%. Aggregate RSS double-counts shared pages and the CPU sample is not an instantaneous or controlled steady-state measurement. This is a reason to measure representative Workspace/browser costs during implementation, not a claimed memory budget.

## Validation and current status

- Frozen Bun installation completed without dependency changes.
- TypeScript check passed for every harness `.ts` file.
- Native macOS and iPad builds passed; the physical iPad app was installed and launched.
- Eight real native handoffs passed; actual native page input and stale-generation rejection were observed.
- Muted-tab waveform probes passed on macOS and Linux.
- Root `bun run check` passed: boundary checks/tests, 28 protocol tests, 263 Alpha tests, Alpha build, Portal checks and 88 Portal tests, and desktop checks.

The iPad initially hit Apple's free-profile app count. Only the generated Alpha UI-test runner was removed to make room for `com.veezee.browser-spike`; Alpha and cmux were preserved.

The architecture has a working cross-platform/native path. The initial feasibility gates passed. Continue into product integration while keeping broader page/codec/DPR coverage, less disruptive handoffs, actual input latency and representative resource measurements as implementation acceptance work. Subsequent product implementation still owns Portal authority/recovery, Workspace profiles, MCP/CDP access, complete native input, clipboard/files, accessible controls and production packaging. WVE-79 is not marked complete by these results.

## Subsequent matched comparison — 13 September 2026

Audio is now deferred. The [CEF/RFB versus WebRTC comparison](../browser-remoting-comparison/README.md) adds measured input latency, scrolling/animation bandwidth, native CPU/RSS, and decoded 1×/2× pixel quality on Mac and physical iPad. It found and tested a standard minimum-frame-rate constraint that removes the initial approximately one-second static-page capture delay. That change exists in the isolated comparison extension; the product extension has not been changed. The report records remaining 2× buffering/motion limits and the RFB tradeoffs. WebRTC remains the accepted implementation baseline pending the user's next architecture decision.
