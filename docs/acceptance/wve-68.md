# WVE-68: Deferred surfaces disconnected

Alpha exposes ACP conversations and xterm.js terminals. Filetree, Editor, and Browser references are isolated under `product/deferred/`, outside application builds and tests. Host startup no longer creates a Browser broker, MCP socket, provider subscriptions, or reverse RPC transport. New credentials no longer receive Browser actions. Existing Host filesystem and ACP/terminal authority remain supported.

The shell ignores deferred panes in existing persisted layouts while preserving terminal scope, placement, sizing, and open state. Both live and mock controllers stop initializing filetree/editor state. iPad retains its Capacitor application WebView and native credential plugin; the transitional AppKit app retains only its application WebView.

Validation on 2026-09-09:

- Product boundary and protocol checks pass.
- Alpha: 34 test files, 174 tests pass; production typecheck and Vite build pass.
- Host: lint and 57 tests pass, including authenticated ACP/recovery, filesystem, and real tmux backend coverage.
- Signed AppKit acceptance build: native WebKit renders xterm.js; synthetic keyboard input is echoed through the mock controller; composer send/cancel and terminal hide/reopen pass; deferred surfaces absent. Screenshot inspected. This proves native shell behavior with fixture data, separately from real Host tests.
- Physical iPad: Debug build and installation pass. Launch was rejected by iPadOS because the device was locked. Device interaction acceptance remains pending and must pass before issue/parent closure.

The acceptance-only frontend runner is gated by `VITE_ALPHA_ACCEPTANCE=1` and `?mock=chat&acceptance=1`. Production builds do not activate it. Native iPad runner uses `--shell-acceptance` in Debug builds and writes `Documents/shell-acceptance.json` and `.png`. The transitional macOS runner writes `/tmp/weave-shell-macos.json` and `.png`.
