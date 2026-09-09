# WVE-65 global agent supervision checkpoint

Verified on 2026-09-09. WVE-65 remains In Progress; this is not the libghostty renderer delivery.

The Host advertises `thread.attention.v1` and adds bounded attention metadata to authorized Thread summaries. Live runtime evidence distinguishes working, waiting, completed, idle, unavailable and uncertain states. Completion requires a recognized ACP turn result. Listing Threads never restores a provider or attaches another ACP conversation. After Host restart, an unobserved runtime is reported as uncertain rather than inferred idle or completed. Alpha shows stale/unavailable evidence separately and preserves stable Thread ordering.

Permission and elicitation requests remain owned by their Thread when its conversation view detaches. The Host preserves unanswered human requests, including requests arriving with no conversation attached, and delivers them when an authorized conversation loads again. A currently attached recipient retains ownership; another observer cannot answer its request. Non-human client service requests still fail when no client can service them.

Alpha closes its ACP transport before settling local request handlers, so changing conversation does not submit a permission decision. Every ACP event captures its source Thread, including late events after switching. A detached request cannot replace the selected conversation's transcript or error. The first prompt's navigation lock ends when the Host confirms promotion or the provider responds, rather than waiting for the entire Agent Turn.

## Evidence

- Full `bun run check`: passed, including 181 Alpha tests, 70 Host tests, 23 protocol tests and two boundary tests, plus builds and typechecks.
- Authenticated Host scenario: working → waiting → completed; permission raised before detachment and after all conversation attachments close; same request restored on return; another observer cannot answer; cold restart reports uncertain without launching ACP for the listing.
- Client transport test: closing a pending permission sends no decision and emits no misleading cancellation entry.
- Controller tests: late events remain on their source Thread, and a newly accepted first prompt no longer blocks navigation while waiting for approval.
- Packaged Electron with compiled local Host and fixture provider: pairing and relaunch both passed switching to a new conversation and back before approving the original permission. Native paste/copy, Neovim and resizing also passed. Evidence: `/tmp/weave-desktop-li74hW/{pair,reconnect}.json` and PNGs.
- The preceding composition checkpoint also passed on the physical iPad; see `wve-65-compositions.md`. That iPad run predates these agent-supervision changes.

No installed Host was replaced. WVE-65 still requires actual libghostty integration on macOS/iPad, persistent unavailable/rebound path identity, layout refinements and final acceptance of the complete stack. xterm.js remains active in these checkpoints.
