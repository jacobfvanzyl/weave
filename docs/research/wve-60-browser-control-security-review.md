# WVE-60 Browser control acceptance and security review

Date: 2026-08-30
Decision: proceed for explicit, attended Alpha use; do not treat this as approval for unattended or general production rollout

## Evidence boundary

Acceptance must travel through the Thread-scoped `weave-visible-browser` MCP adapter, Portal broker, authenticated Alpha connection, and the exact visible Apple `WKWebView`. A hidden browser, direct fixture request, native-only probe, build/install result, or app screenshot without tool correlation is not equivalent evidence.

`product/alpha/acceptance/browser-control/journal-evidence.ts` converts Portal's durable Thread journal into a versioned evidence record. It fails unless the run uses HTTPS (with a narrow explicit loopback-HTTP exception for local packaged-macOS diagnosis), chains each action from the preceding fresh view, covers navigate/fill/key/click/scroll, reaches the named visible fixture state, and returns a non-empty inline screenshot or private artifact. A navigation timeout is accepted only when a later successful observation proves that the exact requested URL loaded, and the record retains both the reconciled navigation outcome and the typed `TIMEOUT`. The record retains platform, Thread, sequence range, tab, generation, control revision, action classes, typed failures, and screenshot presence; it does not retain page text or form values.

## Threat review

| Threat | Current control | Residual risk and decision |
| --- | --- | --- |
| Private-network access | Only an explicitly visible, Thread-attached browser can be observed. Navigation is HTTP(S)-only and control is revocable. Portal has no remotely reachable browser listener. | A controlled page can still navigate to private HTTP(S) services. This is acceptable only for attended Alpha use. General rollout needs a product decision on private-address navigation warnings or confirmation. |
| Prompt injection and hostile page text | The agent receives a bounded semantic projection, not HTML, cookies, headers, storage, console, or network bodies. Element references are opaque and one-view scoped. | Visible page text remains untrusted model input. Agent instructions and product policy must treat it as data. Consequential site actions remain an attended-use boundary. |
| Secret entry | Password and file inputs are absent from the projection; fill rejects both even if a stale descriptor is supplied. Input values are omitted. There is no clipboard, cookie, credential, storage, or raw-JavaScript tool. | A person may independently enter secrets into the shared browser. Observe mode can still expose visible page text around them, so the user must revoke access before handling sensitive content. |
| Uploads and downloads | File inputs are not targetable. Uploads stay in the human system picker. Downloads are blocked by both navigation-action and response policy. | No agent upload/download is approved. Adding either requires a separate threat review and explicit file provenance UI. |
| Popups and cross-origin frames | Popups stay in the same visible session. Cross-origin frame contents are not projected and generate a warning. | Sites whose required controls live in cross-origin frames require human handoff; no coordinate or debugging fallback is allowed. |
| Media and permissions | Camera and microphone are denied by the shared host policy. Other WebKit permissions remain explicit platform defaults. | Any future permission grant needs a visible, platform-owned prompt and must revoke control while pending. |
| Lease or token theft | Exact Host/Thread/client/tab addressing, authenticated Alpha transport, mode-`0600` Unix socket, rotating 15-minute MCP token, lease expiry, and connection binding limit replay. | A same-user local compromise can act with that user's rights. The design does not claim to defend against a fully compromised macOS account. |
| Human/agent races | Observe and control are separate. Work is serialized behind a bounded queue. Trusted pointer/keyboard input, Take over, tab replacement, Thread change, pane hide/close, app background, and Portal disconnect revoke or suspend access. | WebKit work may complete locally after cancellation, but its result is discarded. Consequential-action confirmation remains a later product policy. |
| Oversized or retained evidence | Text, elements, duration, results, and screenshots are capped. Screenshots above 256 KiB become private five-minute artifacts. Expired files are removed on a timer and startup cleanup. Redacted audits rotate at 1 MiB and retain at most one prior segment. | A screenshot is intentionally sensitive evidence. Operators must not copy the private artifact directory into ordinary logs or bug reports. |
| Provider, network, or Portal loss | Provider disconnect detaches and aborts active work. The MCP integration test proves an in-flight old lease fails and only a freshly attached provider on a new tab can continue. | A reconnect never silently restores user consent. The person must opt in again on the visible pane. |

## Proceed criteria met

- The shared Apple engine exposes one allowlisted semantic implementation to UIKit and AppKit.
- Portal separates observe/control grants, exact routing, typed failure behavior, cancellation/deadlines, bounded concurrency, token rotation, artifacts, and redacted audit retention.
- Alpha continuously identifies access mode, controller, Thread title, and Thread ID; control is off by default and Take over is immediate.
- Maintained native suites cover deterministic navigation, errors, policy, storage reset/restart, semantic control, and screenshots. Thread MCP integration covers denial, interruption, provider loss, and fresh reconnect.
- Signed packaged macOS and signed physical-iPad builds are required for release evidence. Journal evidence must prove the core visible task on both.

## Remaining rollout gates

These gates do not block the WVE-53 research/incorporation closeout, but they do block any claim of unattended or general production readiness:

1. Decide and implement confirmation policy for consequential clicks and private-address navigation.
2. Obtain an independent security review of the Apple script projection, local MCP process boundary, and artifact lifecycle.
3. Define product-level audit export/retention administration if the rotating local audit is insufficient.
4. Add accessible user education that page content can be hostile and that observe mode may expose visible sensitive text.
5. Re-run signed macOS and physical-iPad evidence for every WebKit floor or protocol-version change.

The decision is therefore **proceed for attended Alpha use** and **do not proceed for unattended/general rollout** until the five gates above are resolved in separately tracked delivery work.
