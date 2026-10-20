---
status: accepted
date: 2026-10-20
---

# Bring Alpha back as the weave Host's client for iPad and iPhone, in Capacitor

ADR 0008 left open whether the Capacitor app would become a client of the weave Host, and ADR 0014 removed it from the tree, to be built new or brought back under WVE-91. It comes back: Alpha's React app, in its Capacitor shell for iPad and iPhone, returns from commit `e30f6e93` as a remote client of the Host (ADR 0010). The Host protocol carries ACP's content unchanged, so Alpha's ACP transcript and the views it built with AI Elements and shadcn components can carry over. What talked to Portal does not. Its native key plugin already makes Secure Enclave keys and signs as the Host checks, though it turns signatures and public keys into Portal's raw formats. The app is chat-first again, built around sessions and their transcripts rather than the terminal-first shell of WVE-65. Its terminals, Workspaces, Host Browser, Client Browser, Electron shell and Portal client stay in history.

## Considered options

- **A native SwiftUI client.** Device keys, a WebSocket that sends no `Origin`, and one `WKWebView` per view (ADR 0012) come naturally, but the transcript (streaming markdown, diffs, tool calls, plans, elicitation forms) would be written again in SwiftUI.
- **A native shell around a web transcript.** A transcript sooner, but two UI stacks to keep in step, with a bridge between them in the middle of every session.

## Consequences

- The WebSocket runs in the web view, which sends `Origin: capacitor://localhost`. The Host refuses an `Origin` its `[remote] origins` doesn't list, so the app needs it listed.
- The Host protocol's TypeScript types are generated from `crates/protocol`. ACP's come from the ACP TypeScript SDK, pinned to the schema the Host's ACP crate uses.
- Views (ADR 0012) render inside an app that is itself a web view: in iframes with an origin per server, or in native `WKWebView`s over it, as the Client Browser did (WVE-80). WVE-96 decides which.
- The same React app can return to the desktop in Electron later.
- The app gets a new bundle id, so the Alpha installed on devices keeps its Portal pairings until it is removed deliberately.
