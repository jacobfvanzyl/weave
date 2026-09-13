# WVE-79: authorized Portal RFB transport

Portal now authorizes managed CEF page inspection, navigation, Restore, viewer attachment, focus and input. Its separate `/browser/rfb` WebSocket carries binary RFB after authentication. Real CEF acceptance passed on macOS and Bazzite Linux on 13 September 2026, including native decoding and exact pixel comparison.

Portal transport and the first Browser Pane lifecycle are implemented. The latest real Mac acceptance creates its disposable Pane through public Portal RPC, then uses the authenticated WebSocket for native viewing. The subsequent [native Alpha integration](alpha-native-browser.md) adds Profile selection and native Mac/iPad embedding. Its installed-device acceptance is tracked separately from these transport checks.

## Authority and lifetime

`browser.pages.v1` advertises the new page/view RPCs. A Host configured with the managed CEF backend no longer advertises the transitional WebRTC capability. Older Chrome-backed configurations retain their existing behavior.

Every page operation names a Profile. Fully trusted human Alpha pairings may inspect and control all current and future Profiles on their Host. Agent and restricted credentials require explicit `browser.profile.inspect` or `browser.profile.control` grants for concrete Profile IDs; control permits inspection. Profile metadata management, Workspace grants and wildcard Profile IDs alone confer no page access. Full human pairing has a Host-issued marker and the complete administrative action set. Restart and rotation preserve it; migration recognizes older unrestricted administrative pairings while retaining explicit Profile scopes and opt-outs. ACP credentials must never inherit the full human pairing grant set. The public page summary omits the private RFB socket path. Titles and last URLs come from the validated catalog rather than unbounded runtime metadata.

Each viewer belongs to the RPC session that attached it. Attachment returns a random single-use ticket valid for 30 seconds. The display WebSocket authenticates with the existing Portal challenge-response scheme, using the distinct `/browser/rfb` audience. Its credential and principal must match the ticket's owner. The ticket travels in the authenticated bind message, not a URL or query string. The server responds with `browser.rfb.ready`, then exchanges binary RFB data without a per-frame JSON/base64 envelope.

Closing the RPC session, detaching the viewer or ending its permission closes its display transport. It leaves the CEF page and Profile alive. The grant is checked again after asynchronous attachment work and periodically while viewing. The nominal recheck interval is five seconds; a check that does not finish within two seconds closes that view. An unavailable private Browser Service therefore cannot postpone checks indefinitely. The server also bounds attachment time, input frames/queues and pending display output; a slow display is disconnected instead of accumulating stale pixels.

## Focus and input

Focus operations from all clients share one ordered queue per page. A successful focus applies that client's viewport and issues a new `focusEpoch`. An ordinary resize must carry the current epoch and cannot claim focus. Input must likewise carry the current epoch and originate from the controlling viewer. This prevents a client that used to own focus from continuing to type, click or resize after another client's activation.

RFB connections remain passive. Their keyboard, pointer and resize messages do not control CEF. Authorized input uses the upstream CDP `Input.dispatchMouseEvent`, `Input.dispatchKeyEvent` and `Input.insertText` methods through Portal. Arbitrary CDP methods are not accepted by this public input API. Complete agent MCP/CDP routing is still separate work.

The focus response confirms the server resize request, not a newly decoded native frame. Alpha now holds input until its native decoder reports the acknowledged framebuffer size; the integration report records that barrier and its tests. The current result does not claim that all native keyboard/IME, cursor or popup behavior is complete.

## Browser Pane lifecycle

`browser.panes.v1` adds atomic page/Pane creation (including a browser-only Workspace), page-preserving moves, and shared closure. A Pane ID is its page ID. Create and close retries are idempotent. Live closure requires confirmation and the current page generation. A failed composition write leaves the same recoverable page ID for retry, rather than creating a second page. Revocation during native creation prevents publication of the Pane.

Portal reconciles the durable catalog once per second while Browser Panes exist, using its Workspace lifecycle queue. A page opened by another page inherits its Profile and becomes a Right split beside its opener, even without viewers. Navigation updates its last committed URL. Native page closure removes the corresponding Pane. Explicit closure also ends unplaced children; already placed child pages survive their opener. Layout-capacity failures close the unplaceable popup and log the reason. A visible product error for that limit still needs integration.

Generic composition replacement cannot create or close Browser Panes or move them between Workspaces. Workspace-close previews include browser pages, their live generations and uncertain unsaved work. Confirmation tokens become stale after runtime replacement. Restricted clients cannot inspect a Workspace containing a Profile they cannot inspect.

The Mac real run validates creation, popup Right placement and shared popup closure. RPC tests additionally validate moves, close previews, stale generations, revoked creation, browser-only Workspaces, native closure and popup-capacity handling. These new lifecycle paths have not yet been rerun on Linux or installed in Alpha.

## Validation

The real acceptance path on each Host exercised:

- An HTTP page rendered by the managed CEF process.
- Two authenticated RPC clients sharing that page, with viewport focus handed from 800 × 600 to 1000 × 800.
- Rejection of the previous owner's input and successful current-owner mouse input.
- RFB passing through the new Portal WebSocket and a temporary decoder transport into native LibVNCClient.
- A native resize attempt remaining passive.
- Browser timers continuing after both RPC clients disconnected.
- Credential revocation closing a fresh display while the page remained alive.

Native screenshots on both Hosts matched their CEF reference images with zero differing pixels at 1000 × 800. The Linux acceptance used the compiled Portal harness on Bazzite and a temporary SSH forward to reach its decoder socket from the Mac. This tests the Linux Portal/WebSocket runtime and native Mac decoding; it is not the final native Mac-to-Host or iPad connection implementation. The temporary bridge is an acceptance tool, not a product dependency.

Focused tests cover explicit Profile permission, private-path removal, cross-session view access, ticket theft/replay/expiry, revocation during attachment, focus ordering, disconnect during resize, stale input, runtime loss, stalled revalidation and oversized binary input. The final full Portal run passed 134 tests; two subsequent focused popup-layout tests passed. All 39 protocol tests and Portal/Alpha TypeScript checks passed. Evidence is recorded under [evidence/portal-rfb](evidence/portal-rfb/).

This is a static pixel/authority check. Four framebuffer updates in the fixture are not a frame-rate measurement. Audio remains disabled; 60 FPS, scrolling latency, slow native decoders and broader website fidelity are still acceptance gates.

## Reproduction

```sh
CEF_BINARY="$PWD/product/portal/dist/browser-runtime/Weave Browser.app/Contents/MacOS/Weave Browser" \
BROWSER_RFB_SNAPSHOT_BINARY="$PWD/product/portal/dist/browser-runtime/rfb-snapshot" \
  bun product/portal/scripts/browser-rfb-portal-acceptance.ts

bun test product/portal/src/browser-pages_test.ts \
  product/portal/src/browser-page-rpc_test.ts \
  product/protocol/src/browser-pages.test.ts
bun run test:portal
bun run check:portal
```

For externally driven native capture, set a fresh `BROWSER_CAPTURE_READY` path instead of a local decoder binary. The harness publishes its private decoder socket and waits for a `.done` marker. Evidence must include the external decoder result and image comparison; the marker alone does not establish successful decoding.

These isolated transport checks did not replace installed applications. The subsequent Alpha integration installs matching protocol-v8 Mac/iPad clients and the Mac Host; see [installation evidence and remaining acceptance](alpha-native-browser.md). Older clients are excluded from the new compositions because their close dialogs omit browser consequences. Full keyboard/IME and pointer fidelity, popup widgets and cursor behavior remain follow-up work.
