# Browser Service — WVE-79

The selected product direction is prebuilt CEF with lossless RFB, Host-owned Browser Profiles and one page per Browser Pane. The Profile catalog and managed CEF page layers are implemented below. The existing Workspace/tab/WebRTC backend remains transitional experimental code; it has not become the selected CEF/RFB backend. Alpha Browser UI and the complete agent/debugging interface remain implementation work.

## Host-owned Profile foundation

The service persists named Profiles independently of Workspaces in a private `profiles.json` catalog. Host-generated Profile IDs are stable across renames, which require the observed revision. Profile data lives in private `profile-data/<profileId>` directories. Old Workspace-hashed directories are left intact and are not silently adopted as Host Profiles.

Portal exposes the additive `browser.profiles.v1` capability with list/create/rename RPCs. `browser.profile.manage` permits catalog metadata management; it does not grant access to signed-in browser identity. Inspection/control requires explicit `browserProfileIds` plus the respective action. The control grant also permits listing that Profile. Workspace and directory grants do not imply Profile access, and `*` does not grant Profile access. Existing credentials are not upgraded to new Profile permissions. New default administrative pairings can manage metadata but still have no implicit Profile identity grants.

Private IPC version 3 includes Profile catalog operations and opt-in managed CEF page operations. Concurrent opens share one runtime per Profile, with separate processes and storage between Profiles. Renaming and caller disconnect do not replace a runtime; runtime loss remains unavailable on subsequent open calls. The private IPC remains a same-user trusted boundary, not a remote agent endpoint. Configure `browser.cefExecutable` with the absolute managed CEF executable to select the new backend. The older Profile-addressed Chrome/CDP launcher is disabled when CEF is configured.

Validation: `bun test product/portal/src/browser-profiles_test.ts product/portal/src/browser-profile-rpc_test.ts product/portal/src/security_test.ts product/protocol/src/browser-profiles.test.ts`. For isolated real-browser acceptance, run `CHROME_BINARY=/absolute/path/to/chromium bun product/portal/scripts/browser-profile-acceptance.ts`. Set `BROWSER_SERVICE_BINARY` to test a compiled service. The script owns disposable state and processes, preserves diagnosis state on failure and cleans up after a successful run.

Still to integrate: Browser Pane Workspace Composition, last-used Profile suggestions, inherited right-hand splits, client shared close and explicit Restore, Profile deletion, credential/agent grant UI, actual ACP MCP/CDP routing, native Alpha display and its pane lifecycle. The accepted Profile grant semantics are implemented in Portal's credential authority; that does not establish a complete agent control path.

## Managed CEF pages

`managed-pages.ts` persists page identities, owning Profile, title, last URL and opener identity. `managed-process.ts` runs one native CEF adapter per Profile over private stdin/stdout RPC. The adapter uses public CEF APIs and LibVNCServer, exposing passive RFB on private Unix sockets. CEF's cache singleton excludes concurrent owners. Viewer loss does not close a page; service shutdown retains catalog records and Restore explicitly recreates live state with a new generation.

Mac and Linux real acceptance passed HTTP/CDP, Profile isolation and persistence, shared Profile runtime, popup inheritance, viewport changes, unattended work, Restore and stale-command rejection. Native RFB captures from both Hosts matched Chromium's reference screenshot exactly. Mac persistent Profiles require a stable signing identity and native Keychain access. The SDK is prebuilt; no Chromium source build is needed.

Portal now exposes `browser.pages.v1` and an authenticated binary `/browser/rfb` WebSocket for managed pages. Views belong to an RPC session; a single-use ticket binds a display connection to the same credential, while focus epochs protect input and viewport ownership across clients. Explicit Profile grants remain mandatory. The real Portal transport passed native decode/authority acceptance on Mac and Linux. See [Portal RFB transport](../../../../docs/research/wve-79/portal-rfb-transport.md). Browser Pane creation/closure, Profile selection and product native embedding remain separate work.

See [managed runtime implementation and acceptance](../../../../docs/research/wve-79/managed-cef-pages.md) for evidence, build commands, resolved Keychain/socket issues and remaining gates. This layer has not yet been installed as the daily Host backend or embedded in the Alpha Browser Pane. Audio is disabled; this acceptance does not establish 60 FPS.

## Transitional Workspace/WebRTC backend

The remaining sections describe the earlier backend and its acceptance evidence. Its Workspace ownership and tab terminology are superseded by the current domain model. Portal owns remote authorization and signaling through its existing authenticated RPC connection.

## Running and packaging

Configure Portal with `browser: { executable: "/absolute/path/to/chromium" }`. The first browser request starts the separate owner if its private Unix socket is unavailable. Source execution uses Bun; packaged Portal uses the sibling `weave-browser-service` executable and `browser-extension` directory. Portal builds now include both, and macOS signing includes the service executable. Existing credentials need explicit browser actions and Workspace grants; they are not silently broadened. New default pairings include them. No installed Host configuration is changed by building this code.

For isolated service development:

```sh
bun product/portal/src/browser-service/main.ts /absolute/private/state /absolute/path/to/chromium
bun product/portal/scripts/build-browser-service.ts
bun product/portal/scripts/build-browser-service.ts --linux
```

`BrowserServiceClient` uses JSON-RPC over HTTP on a same-user Unix socket. Its version/generation handshake rejects stale owners. Disposing a client closes IPC only; `workspace.close` ends the selected browser and preserves its profile. Profiles use hashes of exact Workspace identities, never client-supplied directory paths. This local interface is trusted execution, not a per-CDP-command authorization boundary. Chromium CDP and the authenticated capture-extension WebSocket listen on loopback only.

One browser is launched per Workspace, including concurrent open requests. Browser loss remains unavailable; an open request does not silently replace live state. Normal service shutdown closes owned children and retains profiles. Service crash or Host reboot requires explicit profile-lock recovery; no automatic adoption, PID-based termination or profile deletion is attempted. Recovery tooling is not implemented yet.

## Portal and media contracts

The additive `browser.stream.v1` capability exposes tab list/create/navigate/close and view attach/focus/signal/frame/click/detach operations. Portal checks `browser.observe` or `browser.control`, the Workspace grant, current Workspace existence and its Execution Context access. Every view belongs to the authenticated connection that attached it. A different connection cannot reuse its view ID. Authorization is checked again after an awaited attachment, before event delivery and before renewal.

Portal renews authorized views every 10 seconds. The service and extension enforce a 30-second peer deadline; disconnect or revocation detaches the view. Removing the last viewer stops capture while the browser remains available for unattended work. Expiry is a bounded fallback if immediate detachment cannot reach the owner. It is not instantaneous revocation during a broken connection.

The latest explicit focus from a controlling view sets the tab viewport. Passive viewers follow. A size change retires old capture/peers, applies window size plus DPR-1 metrics, takes a compositor screenshot barrier, then negotiates fresh media for all viewers. Click input is allowed only for the current owner after acknowledgement of a matching peer, generation and frame size. This guards viewport transitions, not arbitrary navigation or DOM changes. Same-size focus handoff does not restart media.

The MV3 extension is the single production asset source, also used by the legacy spike harness. It uses upstream tab capture, H.264/Opus and direct WebRTC without TURN/SFU. Service-owned tabs are muted at the Host while captured audio reaches clients. Tab creation currently uses one hidden window per tab to retain independent viewport sizes.

IPC parents and profiles require 0700 and the socket uses 0600. IPC requests/results are bounded at 1 MiB, with 64 concurrent operations. Browser/profile count, view count, signaling payloads, pending events and queued ICE candidates are also bounded. Full CDP event delivery and large debugging results still need a maintained streaming interface.

## Validation

```sh
bun test product/portal/src/browser-service_test.ts product/portal/src/browsers_test.ts product/portal/src/browser-rpc_test.ts
CHROME_BINARY=/absolute/path/to/chromium bun product/portal/scripts/browser-service-acceptance.ts
CHROME_BINARY=/absolute/path/to/chromium bun product/portal/scripts/browser-media-expiry-acceptance.ts
CHROME_BINARY=/absolute/path/to/chromium bun experiments/browser-streaming/portal-host.ts
```

Tests exercise actual child-process CDP fixtures and Unix connections, concurrent automatic startup, authorization, connection ownership, revocation and late attachment. The real Chromium scripts check profile isolation/persistence, caller-independent execution, stale generations and actual peer/capture removal after an unrenewed 30-second grant. The separate native receiver adapter exercises real authenticated Portal RPC with disposable state and credentials. See [native acceptance results](../../../../experiments/browser-streaming/RESULTS.md).

## Remaining integration

Native Alpha embedding, Profile selection, full agent-created page control, full pointer/keyboard/IME input, clipboard/files, maintained MCP/CDP access, browser upgrade/recovery and broader media acceptance remain open. Current viewports are DPR 1 and input is click-only. Full human pairing now includes all Host Profiles; agent and restricted credentials still require explicit Profile IDs. Portal implements Browser Pane creation/move/close, Right-split popup reconciliation and browser-aware Workspace closure; see the managed RFB transport report for current evidence.

Browser distribution/pinning and the open-source-only deliverable remain packaging gates. Real acceptance currently uses Chrome for Testing; that does not establish an all-open-source packaged product. The selected direction is the managed CEF/RFB backend above; the preceding WebRTC evidence is retained as a comparison, and the Viz path is parked.
