# Unified Agent Panes

WVE-79 · 2026-09-13 · In Progress

The accepted model is implemented in the shared composition contract, Host lifecycle and live Alpha shell. Agent, Terminal and Browser content now share one Pane layout and chrome component. An Agent Pane owns one Thread; several can appear in the same Workspace. Client presentation selects one Workspace and one Pane. The separate agent dock, its width/side settings and cross-Workspace last-visible selection are absent from the live shell.

New Agent Panes create durable Threads immediately. Existing active Threads migrate into their assigned Workspace layouts. Moving a Thread moves its existing Pane, and archiving removes only that Pane and collapses its split. A confirmed close stops active work within Portal's serialized lifecycle before archiving. Layout writes cannot remove or impersonate Agent content. Composition visibility also checks each presented Thread's inspection grant.

Each Thread uses an independent ACP connection. Prompts, cancellation, permissions, elicitation, modes and configuration bind to the Pane's Thread identity. Draft text is keyed by the Host-qualified Thread identity, so providers using the same upstream session ID cannot share a composer draft. Phone navigation presents one Pane from the shared tree and does not request a keyboard.

## Compatibility and browser scope

Composition schema 3 and Portal protocol 7 require matching builds. Schema-2 migration retains existing Workspace and terminal/layout identities. Unknown schema versions remain fail-closed. Browser Pane identity/Profile/last-URL leaves and the common frame are available to the forthcoming RFB integration; this change does not implement the CEF/RFB product renderer or expose a working New Browser Pane command. Audio remains deferred.

## Validation

- Root `bun run check`: tooling and boundary checks, 33 protocol tests, 266 Alpha tests, 109 Portal tests, Alpha production build and desktop type checks passed.
- New coverage: mixed-content parsing, duplicate Thread rejection, schema migration/restart idempotence, 20-Thread balanced insertion, Pane identity across moves, terminal exit preserving Agent Panes, archive pruning, confirmed active-work closure, shared UI chrome/focus, independent composers, phone keyboard behavior and per-Thread ACP routing/late-close handling.
- Packaged Mac acceptance: fresh pairing and a subsequent app restart/reconnect both passed against an isolated compiled Host and real fixture ACP process. Verified two visible Agent Panes during a pending permission, shared rails, single focus, native terminal paste/Neovim/IME, split/maximize lifetime and Workspace reattachment.

- Physical iPad Air 11-inch (M3), iPadOS: app-driven UIKit smoke passed against the isolated Host over Tailscale TLS. Shared rails/focus, two Agent Panes during pending permission, ACP completion, native terminal paste/Neovim, Workspace reattachment, software-keyboard dismissal and native composition commit passed. This is not manual keyboard, VoiceOver or system-IME acceptance.
- Native driver fixes: wait for enabled menu items and opening transitions; scope the selected Agent row to the tested Workspace; wait for the acceptance page's readiness signal before consuming iPad input; simulate deliberate composer input separately from keyboard-free Pane navigation.
- Evidence: [Mac first connection](unified-pane-evidence/mac-pair.json), [Mac reconnect](unified-pane-evidence/mac-reconnect.json), [shared pane screenshot](unified-pane-evidence/mac-pane-layout.png), [iPad smoke](unified-pane-evidence/ipad-smoke.json), [iPad fixture connection cleanup](unified-pane-evidence/ipad-cleanup.json). The Mac screenshot captures web chrome; native terminal content is verified separately by the app driver.

The isolated fixture Host, agent processes and Terminal Service were stopped. No commit, PR or release has been made.

## Installed development build

At the user's request, fresh builds without the acceptance flag were installed on the Mac and physical iPad on 2026-09-13. Alpha was updated in place, retaining saved connections. RFB Spike and cmux SELF were removed from the iPad; the temporary XCTest runner was removed after validation.

The local Mac Portal was upgraded to protocol 7 with its existing signing identity. Installed component hashes match the source build, whose source hash is `31ab1cdf3dfd389562321be7df4eaa40e4120529a06278308b206f0716d3634a`. Configuration, binaries and Host state were backed up under `~/.local/share/weave/backups/wve79-install-20260913-152510` before migration. The live Host composition migrated from schema 2 to 3, retaining the existing Workspace and Terminal identities and adding the existing Thread as an Agent Pane. The running Terminal Service and terminal sessions survived the Portal restart. Remote Hosts were not changed.

Installed-profile verification exposed an invalid executable in the cached Codex ACP package (`ENOEXEC`). Portal's Codex agent now uses the adapter's supported `CODEX_PATH=/opt/homebrew/bin/codex` override, pointing to the working local Codex 0.154.0 installation. No installed dependency was edited. The existing conversation reloaded successfully in the Mac app after restart.

The physical iPad's installed-profile XCTest passed: selecting an existing terminal, opening Connections over its native surface, closing the overlay and retaining the terminal. The free-provisioning limit from the earlier attempt was cleared by the authorized development-app removal. This check does not submit a new prompt or terminate any existing Host work.

## Mac direct-click focus correction

Follow-up testing reproduced terminal text selection working while keystrokes stayed in the Agent composer. AppKit focus acknowledgements and an already-running `focusWeb` request could race with the terminal's pointer intent. The late composer focus event also overwrote Workspace Pane selection, allowing the composer to remain the keyboard target.

The Mac adapter now reports pointer intent before its explicit responder assignment. The shared focus owner reasserts a newer target after an older asynchronous handoff completes, and Workspace selection uses the same stale-focus fence as keyboard ownership. Two regression tests fail without their respective fixes; all 268 Alpha tests and the production desktop build pass. Live Mac verification covers direct composer-to-terminal clicks, terminal keystrokes and switching back to the composer. The iPad installation and Host processes are unchanged by this correction.

## Pane rails, split menu and local drafts — 13 September 2026

Pane title rails focus their Pane. Mac top-row rails retain native window dragging through a non-consuming native mouse-down observer. Agent rails have Archive and one Split control. Split first offers Down (initial focus) and Right, with no visible direction heading, then Terminal, Agent, Browser; the source Pane type receives initial focus. Browser remains unavailable pending product integration.

New Agent Panes are local drafts. The pane rail and sidebar tile use the same theme peach **Draft** chip. A missing Thread title also retains this chip until the provider supplies a title; execution-directory names are never substituted as Agent titles. This title placeholder does not change the persisted Thread’s lifecycle. Empty drafts disappear when another Pane is activated; typed drafts remain in memory for the current client session until sent or explicitly discarded. Multiple typed drafts can coexist. Menus, composer controls and window/application focus changes do not count as activating another Pane. These drafts are neither shared with other devices nor persisted as Host Threads or layout leaves.

First Send creates the Host Thread and positions its Host-owned Pane where the draft was shown, retaining direction and execution context/provider inheritance. Draft creation and layout failure are retryable; a successful creation is remembered so a later layout retry does not create a duplicate Thread. Pane activation after Send wins over the eventual creation response. Provider settings become available after the provider session exists.

Validation: Alpha suite 282 tests passed, followed by the added first-send focus-race regression passing with the complete controller file (34 tests). Mac live acceptance proved the direction menu has no heading, default Enter/Enter opens an Agent draft below its source, the Draft chip appears, empty drafts disappear on terminal rail activation, typed text survives activation of a terminal, and explicit draft discard leaves the Host catalog and composition byte-for-byte unchanged. No test prompt was sent to the user's provider. Desktop packaging and connected-iPad device builds pass; updated installs preserve connections and terminal sessions.

An earlier archive acceptance of a persisted empty test Thread returned `kill() failed: EPERM`. Retrying its archive removed the test Pane. That Host process-group shutdown error is not claimed fixed by local draft creation and remains a separate lifecycle follow-up for persisted Threads. The user's original conversation and terminals were preserved.
