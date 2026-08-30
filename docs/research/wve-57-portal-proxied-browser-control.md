# WVE-57: Portal-proxied control of the visible Alpha Browser

Date: 2026-08-29
Status: selected design and vertical-slice incorporation record

## Decision

Keep the product interface Portal-native and add MCP only as an adapter for the ACP agent. Keep the model-facing surface small, while making the hidden Portal broker capability-negotiated and strict about identity, leases, cancellation, and bounds.

The visible `WKWebView` remains owned by the Apple host. Alpha attaches that exact browser session to one Thread over its existing authenticated Portal WebSocket. Portal holds the attachment and lease, routes bounded commands to the attached Alpha connection, and exposes two model-facing MCP tools:

```ts
type BrowserControl = {
  see(input?: { url?: string; wait?: BrowserCondition; screenshot?: boolean }): Promise<BrowserView>;
  act(input: { viewId: string; action: BrowserAction; expect?: BrowserCondition; screenshot?: boolean }): Promise<BrowserView>;
};
```

`BrowserAction` is a closed union for `click`, `fill`, `key`, and `scroll`; `see` optionally performs HTTP(S) navigation and a bounded text or URL wait. A missing attachment is a typed `NOT_ATTACHED` tool failure. There is deliberately no arbitrary JavaScript, cookie API, file-upload action, hidden-browser creation, raw selector escape hatch, CDP endpoint, or debugging listener in the first slice.

This is a deep module: callers learn two entry points while the implementation hides transport correlation, capability negotiation, the human/agent lease, stale-command rejection, cancellation, WebKit script execution, screenshot encoding, redaction, and result limits.

## Interface designs considered

1. **Minimal broker and two tools.** This has the smallest implementation, but makes future operations widen the broker itself and risks moving policy into transport handlers.
2. **Generic capability registry.** A `discover / lease / invoke` broker provides the strongest extensibility and test seam, but exposing that generic operation vocabulary directly to a model makes ordinary browsing verbose and leaks infrastructure concepts.
3. **Evidence-bearing browser turns.** `see / act / handoff` is the clearest collaborative model, but making handoff a blocking agent tool adds lifecycle work that is not needed to prove explicit user takeover in this spike.

The selected combination uses `browser_see` and `browser_act` as the ergonomic agent interface, a capability-negotiated `BrowserControlBroker` internally, and Alpha's visible **Agent / Take over** control as the human lease boundary. A later incorporation issue may add a first-class handoff tool without changing the broker or native host protocol.

## Why this seam fits the code that exists

Alpha already has a small UI-to-native browser module: `getSnapshot`, `subscribe`, and `send`; its command union controls the exact native browser surface rather than an iframe ([Alpha browser session](../../product/alpha/src/app/alpha-browser-session.ts#L28-L43)). Both Apple hosts own a separate, non-persistent `WKWebView` and already translate shell commands into navigation and state ([iPadOS host](../../product/alpha/ios/App/App/AlphaBrowserHost.swift#L52-L168), [macOS host](../../product/alpha/macos/Sources/WeaveAlpha/WeaveAlpha.swift#L52-L204)). The browser-control implementation belongs beside those hosts, behind one native `execute(operation)` seam; it should not be spread through React.

Alpha and Portal already share an authenticated JSON-RPC WebSocket. The Alpha peer currently rejects every inbound request with `Method not supported by Weave`, which is the precise seam to deepen into bidirectional RPC ([current Alpha peer](../../product/alpha/src/portal-client.ts#L59-L127)). Portal already validates methods and params before dispatch ([Portal RPC server](../../product/portal/src/server.ts#L175-L205)), advertises explicit capabilities ([Portal capability projection](../../product/portal/src/portal.ts#L198-L233)), and has authorization routing that distinguishes observe from control for Terminal ([Portal authorization](../../product/portal/src/portal.ts#L455-L527)). Browser control should reuse those patterns.

Portal also already passes an explicit `mcpServers` list into ACP `session/new` and restore, but currently supplies an empty list ([Thread creation and restore](../../product/portal/src/thread-runtime.ts#L140-L225)). Stable ACP session setup accepts MCP servers; the official TypeScript SDK exposes `withMcpServer` for `session/new` ([ACP TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk/blob/main/src/acp.ts)). This makes MCP an adapter at the agent seam rather than the product protocol itself.

## The module and its adapters

### External interface

The MCP adapter publishes:

- `browser_see({ url?, wait?, screenshot? })` — observes the visible browser and may first navigate to an HTTP(S) URL. It returns URL/title/loading, bounded visible text, semantic interactive elements with opaque references, revisions, and optionally one screenshot.
- `browser_act({ viewId, action, expect?, screenshot? })` — performs one closed, typed action and returns a fresh view. `click` and `fill` consume an opaque reference from the named fresh view; stale view IDs fail closed.

The human attachment interface is Alpha UI, not an agent tool: `Enable agent control` attaches the current visible Browser to the selected Thread, and `Take over` or disabling control revokes it immediately. The agent cannot attach itself or open a hidden second browser.

### Portal module

The Portal implementation has three entry points:

```ts
type BrowserControlBroker = {
  attach(connection: AlphaConnection, offer: BrowserOffer): BrowserLease;
  invoke(scope: ThreadScope, request: BrowserRequest, signal: AbortSignal): Promise<BrowserResponse>;
  detach(leaseId: string, reason: BrowserDetachReason): void;
};
```

The deletion test is useful here: deleting this module would force lease ownership, tuple routing, timeouts, request correlation, stale revisions, size checks, and reconnect behavior into the Portal WebSocket handler, MCP tool handlers, and both Apple hosts. Concentrating them therefore creates leverage and locality rather than a pass-through.

### Adapters

1. **Alpha JSON-RPC adapter.** Upgrades the existing authenticated socket to accept `browser.control.execute` and `browser.control.cancel` from Portal. It validates the tuple, lease ID, connection generation, command revision, deadline, operation, and input before calling the native module.
2. **Apple WebKit adapters.** UIKit and AppKit satisfy the same native interface. They use public `WKWebView` script and snapshot methods on the main actor. Apple documents frame/content-world JavaScript evaluation, asynchronous JavaScript, and native snapshots on `WKWebView` ([WKWebView](https://developer.apple.com/documentation/webkit/wkwebview/)); WebKit calls must run on the main thread ([WebKit for AppKit and UIKit](https://developer.apple.com/documentation/webkit/webkit-for-appkit-and-uikit)). Use a native-owned isolated `WKContentWorld` and argument passing, not string interpolation into page-world JavaScript. DOM effects remain visible across content worlds ([`evaluateJavaScript` content-world behavior](https://developer.apple.com/documentation/webkit/wkwebview/evaluatejavascript%28_%3Ain%3Acontentworld%3A%29)).
3. **MCP adapter.** Portal adds a Thread-scoped stdio MCP declaration to ACP session setup. A small `weave-portal browser-mcp` adapter speaks MCP on stdio and reaches the in-process broker through a mode-`0600` local socket with a short-lived, Thread-bound capability. Stdio avoids adding an HTTP listener; the MCP specification says stdio servers should obtain credentials from their environment, while local HTTP servers require origin validation, loopback binding, and authentication ([MCP authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization), [MCP transports](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)). MCP remains valuable because tools are model-controlled and schema-described, but the product must retain visible invocation and denial controls ([MCP tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)).

Do not create hypothetical extra seams. The two real Apple adapters justify the native interface. MCP and Alpha JSON-RPC are real adapters to the Portal broker. Provider-native tools and an ACP extension are unnecessary in this variant.

## Addressing, attachment, and lease rules

Every offer and command carries the stable address `(hostId, threadId, clientId, tabId)`:

- `hostId` is Portal's authenticated host identity.
- `threadId` is the Portal Thread whose ACP session receives the MCP tools.
- `clientId` is a stable random Alpha installation identity stored with the paired Portal credential.
- `tabId` identifies the visible native Browser session. Resetting/replacing the `WKWebView` creates a new `tabId` and invalidates snapshots and in-flight work.

Portal never chooses “the most recently focused” client. The user explicitly attaches one tuple. A lease additionally contains an unguessable `leaseId`, connection generation, monotonic `revision`, allowed operation set, and idle expiry. It is bound to the authenticated Alpha socket and exact ACP Thread runtime. Changing Thread, disconnecting Alpha, resetting the Browser, revoking the Portal credential, archiving the Thread, stopping the ACP runtime, or pressing Take over detaches it.

Human interaction wins. Pointer, keyboard, navigation-bar, or reset activity increments a `humanRevision`; an in-flight agent action observing a changed revision finishes as `TAKEN_OVER`, and subsequent actions fail until the user explicitly resumes control. This avoids simultaneous writers while leaving ordinary browsing fully usable whenever control is disabled.

Requests are serialized per tab. Portal assigns a request ID and absolute deadline, forwards cancellation, and rejects responses whose lease, socket generation, tab ID, or revision no longer matches. WebKit work that cannot be physically interrupted may finish locally, but its result is discarded after cancellation; waits poll an abort flag and navigation can call `stopLoading`.

## Capability and data contract

An Alpha offer advertises a version plus operations, limits, and platform, for example:

```json
{
  "version": 1,
  "operations": ["see", "act"],
  "authorization": { "observe": true, "control": true },
  "limits": { "maxResultBytes": 2097152, "maxScreenshotBytes": 1500000, "maxElements": 200, "maxDurationMs": 30000 },
  "platform": "iPadOS"
}
```

Portal intersects this with its protocol version and MCP tool set. Unsupported operations are reported rather than silently rerouted. T3 Code demonstrates the same useful separation: typed operation capabilities and exact tab targeting live in a shared contract, while handlers collapse all tools into one broker invocation ([T3 contract at source snapshot `e9f50c3`](https://github.com/pingdotgg/t3code/blob/e9f50c3efcb02a199042364ead292e164274e716/packages/contracts/src/previewAutomation.ts#L25-L78), [T3 handlers](https://github.com/pingdotgg/t3code/blob/e9f50c3efcb02a199042364ead292e164274e716/apps/server/src/mcp/toolkits/preview/handlers.ts#L37-L94)). Its broker pins a multi-step provider session to one physical browser host and correlates requests, connection identity, tab identity, and timeouts ([T3 broker](https://github.com/pingdotgg/t3code/blob/e9f50c3efcb02a199042364ead292e164274e716/apps/server/src/mcp/PreviewAutomationBroker.ts#L426-L584)). We should copy that routing lesson, not its much broader operation surface.

Snapshots are a capped projection, not a DOM dump:

- URL, title, loading state, viewport, at most 64 KiB of normalized visible text, and at most 200 visible interactive elements.
- Each element returns role, accessible name, bounds, state, and an opaque locator ID scoped to `{tabId, documentRevision, snapshotId}`. Do not return page selectors or HTML.
- Redact password values, file paths, authorization-like fields, hidden elements, cookies, storage, headers, and request bodies. Text input values are omitted by default.
- Screenshot is opt-in, viewport-only, re-encoded with a 1.5 MiB result cap. Small results may be returned as image content; results above 256 KiB are moved to a private five-minute Portal artifact and returned as an MCP resource link. The original tool response therefore never carries unbounded base64.
- No console or network capture in the vertical slice. Public `WKWebView` provides navigation delegates, script evaluation, and snapshots, not a supported CDP-equivalent network-inspection interface. Later console support would be an explicitly bounded injected adapter; full request/response interception remains out of scope.
- Upload controls may be reported as requiring human action. The agent cannot set a path or drive the system picker.

Typed failures include `NOT_ATTACHED`, `LEASE_REVOKED`, `CONTROL_INTERRUPTED`, `STALE_TAB`, `STALE_VIEW`, `UNSUPPORTED`, `INVALID_TARGET`, `TIMEOUT`, `CANCELLED`, `RESULT_TOO_LARGE`, `NAVIGATION_FAILED`, `HOST_DISCONNECTED`, and `BUSY`. Error text is bounded and must not echo page secrets. The MCP adapter preserves the code, message, and retryability as tool-error evidence.

## Threat model

The protected assets are the user's authenticated page state, what is visible on screen, and the ability to mutate sites as the user. Threats include a page spoofing snapshot content, a stale or wrong Thread controlling the browser, another paired client winning a routing race, replay after reconnect/reset, MCP credential leakage, oversized page/screenshot results, and page-controlled strings leaking secrets into model context.

Mitigations are explicit human attachment; exact tuple and lease binding; authenticated existing transport; short-lived Thread-scoped local MCP capability; monotonic revisions; strict schemas and limits at every seam; isolated native-owned scripts; no raw evaluation/debugging/cookies; visible agent-control state and action pulse; immediate takeover/revocation; structured audit records containing action kind and target identity but not typed text or page contents.

## Deterministic vertical slice

Use the existing Alpha browser acceptance fixture and one task on both packaged macOS and a physical iPadOS device:

1. User opens the Browser pane, selects the active Thread, and enables agent control.
2. Agent calls `browser_see({ url: fixtureURL, wait: ... })`.
3. Agent fills a fixed value using the returned opaque reference, sends a key, clicks the fixture button, waits for a deterministic result, and requests a screenshot on the final `browser_act`.
4. Acceptance asserts the app-written evidence and fixture state refer to the same visible native `tabId`; the screenshot must visibly contain the result.
5. A second scenario presses Take over during a wait and proves `CONTROL_INTERRUPTED` or `LEASE_REVOKED`; a reconnect scenario proves the old lease and stale command cannot resume.

The slice is complete only when both Apple hosts execute the same protocol and the human can see every action on the Browser surface. A successful Portal/MCP call without visible-device evidence is not sufficient.

## Implementation checkpoint

The spike now contains the versioned protocol, Portal broker, bidirectional Alpha RPC, native UIKit and AppKit execution, explicit **Agent / Take over** control, and Thread-scoped stdio MCP adapter. Verification on 2026-08-29:

- Product boundary: 2 tests passed.
- Product Protocol: 19 tests passed with 55 assertions.
- Portal: 61 tests passed, including lease routing, revocation during in-flight work, stale human revisions, cancellation, result limits, least-privilege MCP socket arguments, and typed MCP failures.
- Alpha: 38 test files and 194 tests passed; the production Vite build passed.
- macOS: Swift debug build passed; the packaged app was rebuilt, signed, and passed designated-requirement verification.
- iPadOS: the signed physical-device build passed, then installed and launched on the paired iPad Air 11-inch (M3).
- Live MCP startup exposed and then verified the required Deno permissions: the adapter can read, write, and connect only to the mode-`0600` Unix socket and can read only its three Thread-scoped environment variables.

The visible-device task passed on 2026-08-30 through the real Thread-scoped MCP adapter, Portal broker, authenticated Alpha connection, and the exact `WKWebView` shown on the physical iPad. Codex used only `browser_see` and `browser_act`, consumed each fresh opaque view, filled `WVE-57`, sent key `K`, clicked **Apply control value**, and observed `control:applied:WVE-57:key:K`. The final result returned PNG screenshot evidence from tab `D4786CBD-89B3-41CD-8AB9-D7CA45122FFC` at generation `1` and control revision `0`. This run also exposed and fixed two native integration defects: `callAsyncJavaScript` named arguments must be referenced directly, and stale-view authority must live in the trusted native host rather than page JavaScript. Apple's API defines dictionary keys as named JavaScript arguments ([`callAsyncJavaScript`](https://developer.apple.com/documentation/webkit/wkwebview/callasyncjavascript%28_%3Aarguments%3Ain%3Acontentworld%3A%29?changes=latest__8__8)).

Packaged-macOS validation on 2026-08-30 exposed a separate shell defect: `WKWebView.loadFileURL` loaded `index.html`, but WebKit did not execute the Vite ES-module graph, leaving a signed white window. The AppKit host now serves its bundled public directory from the same-origin `weave://app` scheme with bounded path resolution and explicit MIME types. After rebuilding and re-signing, Computer Use captured the complete Alpha Connections UI at `weave://app/index.html`, proving the packaged React shell mounts visibly. The remaining macOS control/takeover run is blocked at the validation harness rather than the product: the T3 client SDK Node runtime does not expose the Computer Use `nativePipe`, `launchServices`, or trusted-RPC service registration needed for a persistent read-then-action session. Its signed legacy MCP bridge also hangs after initialization, while direct SDK socket access is intentionally one-shot. Do not treat read-only screenshot capture as macOS control acceptance.

The explicit takeover-during-wait scenario remains an acceptance gate rather than an inferred success.

## Tradeoffs and follow-ups

This variant is intentionally smaller than T3 Code's preview system. Two tools and opaque locators reduce model flexibility but materially shrink the injection and data-exfiltration surface. Stdio MCP plus a local Portal backchannel adds one adapter process, but avoids a new remotely reachable listener and reuses ACP's existing session setup. Explicit tuple selection is less magical than focus-based routing but deterministic across multiple Macs/iPads.

The incorporation backlog is ordered by native Linear blocking relations:

1. **WVE-61** — harden the Browser protocol, Portal broker, audit, artifact path, and least-privilege MCP transport.
2. **WVE-58** — extract and harden the shared Apple visible-browser control host.
3. **WVE-59** — incorporate the visible attachment, controller identity, and takeover state into Alpha UX.
4. **WVE-60** — automate and security-review packaged macOS and physical-iPad acceptance.

Arbitrary JavaScript, console/network capture, uploads, multiple tabs, recordings, and unattended/background control remain separate decisions.
