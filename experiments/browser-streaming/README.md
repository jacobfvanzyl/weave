# Browser streaming feasibility slice — WVE-79

This is an isolated vertical slice of the accepted browser architecture: service-owned upstream Chrome, an MV3 capture extension, and a native Swift/libwebrtc receiver on Mac and iPad. It exercises real media and focus handoff before product integration. [Results and limits](RESULTS.md).

The native receiver remains a separate test application. Capture assets and browser ownership now live in the product Browser Service. Both harness modes use synthetic pages, disposable state and test credentials; neither uses installed Host state, personal Chrome profiles or the installed Alpha application.

## Run

Use repository Bun 1.3.14. From the repository root:

```sh
bun install --frozen-lockfile
bun experiments/browser-streaming/host.ts
```

The Mac default browser is `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`. Set `CHROME_BINARY` to a supported upstream Chrome executable on Linux. The tested browser is Chrome/Chrome for Testing 153.0.8010.36. It must support the experimental CDP Extensions APIs. No browser sandbox disabling flags are used.

`SPIKE_HOST` selects the address written to the native connection configuration. `SPIKE_PORT` defaults to 9879 and `SPIKE_BIND` defaults to `0.0.0.0`. Set an explicit LAN or VPN address on multi-interface Hosts. The extension uses a separate loopback connection and capability. The harness writes the viewer configuration to `.build/connection.json` with mode 0600; never commit or publish it. Each Host launch invalidates the previous configuration.

```sh
bun experiments/browser-streaming/build-native.ts mac
open experiments/browser-streaming/.build/BrowserSpike.app

bun experiments/browser-streaming/build-native.ts ipad
```

The native build downloads and checksum-verifies the exact XCFramework in `native/pin.json`. It uses the library's Metal view, H.264 decoder and output-only AudioEngine adapter. No microphone track or microphone usage permission is configured. The Mac app is ad-hoc signed; the iPad harness uses the repository's existing Personal Team and the distinct bundle ID `com.veezee.browser-spike`. Its generated Xcode project and build products stay under `.build`.

For a remote Host, copy its private configuration to an ignored local file and build with `SPIKE_CONNECTION=/absolute/path/to/connection.json`. Run builds sequentially: they share generated receiver resources. A Mac executable can alternatively use `WEAVE_BROWSER_SPIKE_CONFIG=/absolute/path/to/connection.json` at launch. An already installed iPad build contains the connection configuration used when it was built; rebuild/install after changing Hosts or restarting the harness.

Use `xcrun devicectl list devices`, then the normal `device install app` / `device process launch` commands with the selected device identifier and `.build/ipad/Build/Products/Debug-iphoneos/BrowserSpike.app`. Free provisioning may require removing a generated test runner to make room; preserve actual user applications.

## Exercise

- Tab A / Tab B activate and capture the selected tab. A tab's native viewers share one viewport.
- Claim / resize alternates the requested viewport between 800×600 and 960×640. Passive viewers follow.
- Toggle tone starts/stops a quiet synthetic tab tone. Test click changes the remote counter; Stale click deliberately sends an obsolete generation and must be rejected.
- Disconnect tears down that viewer. The last viewer leaving stops capture; the browser and fixture JavaScript remain alive. Relaunch the native app to reconnect.

The harness uses one hidden Chrome window per tab, `Browser.setContentsSize`, DPR-1 device metrics and capture constraints. Handoff stops the old capture/peers, applies geometry, obtains a compositor screenshot barrier, then starts fresh capture/peers. Native coordinate input remains disabled until a frame from the newly identified peer has the expected dimensions. This is a conservative spike strategy, not a claim that an arbitrary old RTP frame carries Portal geometry metadata.

The extension uses Chrome tab muting to keep service-owned tabs silent at the Host; tab capture still receives audio. Separate muted-tab probes passed on both Hosts, and a final Linux-to-native Mac/iPad run verified the hook through playback, disconnect and reattachment. The results distinguish the Chromium mute-state evidence from an acoustic measurement.

Administrative harness actions are available through `control.ts` using the private configuration. For example:

```sh
bun experiments/browser-streaming/control.ts experiments/browser-streaming/.build/connection.json navigate B
bun experiments/browser-streaming/handoff-acceptance.ts connection.json live-host-log.jsonl mac-viewer-id ipad-viewer-id
```

The handoff acceptance drives eight real viewport changes and waits for both native receivers' matching-frame acknowledgements. It requires two connected viewers and a live local copy of the Host's JSONL log. `inspect-fixture.ts` provides read-only diagnostics for a known temporary spike profile; it inspects only synthetic fixture pages.

## Portal-backed integration acceptance

```sh
CHROME_BINARY=/absolute/path/to/chromium bun experiments/browser-streaming/portal-host.ts
```

This launches an isolated Portal plus a separate Browser Service. Each native viewer gets its own authenticated Portal RPC connection through a disposable adapter, so tab/view operations exercise the actual product authorization and signaling paths. The adapter is not the Alpha native bridge. It defaults to loopback port 9892; remote acceptance requires explicit `SPIKE_BIND` and `SPIKE_HOST`. The private receiver configuration is `.build/portal/connection.json`. Build the receiver with `SPIKE_CONNECTION` pointing to it.

For a packaged service, set `BROWSER_SERVICE_EXECUTABLE` to the compiled executable with its sibling `browser-extension` assets. `SPIKE_OUTPUT` and `SPIKE_FIXTURE_PATH` support compiling the acceptance harness itself for Linux. Graceful shutdown removes only the disposable acceptance state and its owned browser. This harness deliberately shuts down its owner at the end; normal Portal shutdown preserves browser ownership.

[Mac Portal media evidence](evidence/portal-service-mac.json) covers video, audio telemetry, click input, tab switching and viewport-generation rejection. [Real media expiry evidence](evidence/media-expiry-mac.json) covers peer/capture removal without renewal while Chromium remains available. Current results and remaining product boundaries are recorded in [RESULTS.md](RESULTS.md).

## Independent Browser Service integration

The harness now shares its Chromium adapter with the [Browser Service foundation](../../product/portal/src/browser-service/README.md). Set `BROWSER_SERVICE_STATE` to an explicitly started service's private state directory to route browser operations through its Unix socket. In this mode, harness shutdown stops capture and detaches; the service retains its browser and persistent Workspace profile. Default mode still owns and removes a temporary fixture profile.

The Linux service-to-native-Mac regression run is recorded in [service-native-mac.json](evidence/service-native-mac.json). This verifies media across the independent owner boundary, not Portal authorization or Alpha product embedding.

## Validation and boundaries

```sh
bun product/alpha/node_modules/typescript/bin/tsc -p experiments/browser-streaming/tsconfig.json
bun experiments/browser-streaming/build-native.ts mac
bun experiments/browser-streaming/build-native.ts ipad
bun run check
```

For the independent muted-tab audio probe:

```sh
SPIKE_MUTE_TAB=1 bun docs/research/wve-79/webrtc-tab-capture-probe.ts
```

WebRTC carries encrypted media directly. **The harness signaling is plain WebSocket on a trusted LAN/VPN and uses disposable capabilities.** Do not connect real/private browsing data or expose this harness publicly. Production must use Portal's authenticated secure signaling, bounded grants, revocation and recovery contract. No TURN/SFU is involved.

The native slice does not implement general pointer/IME/touch/clipboard behavior, production reconnect, agent tooling, permission UX, accessible webpage semantics, codec fallback or browser update orchestration. Persistent Workspace profiles and Portal authority are now implemented in the product service and exercised separately above. The test controls are harness UI, not the proposed product UI. Small text, WebGL, video-heavy pages, DPR-2 quality, thermal behavior and audio route changes need broader acceptance during implementation.

Stop a Host with Ctrl-C to close its owned Chrome process and remove its temporary profile. Disconnect native viewers first for the no-viewer test. Stop only the spike's own processes on remote Hosts; keep the temporary installation isolated from existing services. `.build` contains downloaded dependencies, generated applications, session capabilities and local logs and is ignored by Git.
