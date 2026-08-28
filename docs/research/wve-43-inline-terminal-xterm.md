# WVE-43 inline Terminal xterm investigation

_Investigation snapshot: 2026-08-28, deliberately performed after the docked Terminal implementation._

## Decision

Keep Alpha's current inline ACP Terminal reference renderer for WVE-43. The new product-owned xterm view can render a supplied string read-only, but Alpha does not currently possess the ACP terminal output that an inline instance would need. Connecting the new persistent user-shell protocol by matching `terminalId` would conflate two unrelated lifecycles and is not safe.

## Evidence

- ACP 1.4 `ToolCallContent::Terminal` contains only an Agent-owned `terminalId`. Output is obtained through the separate client-side `terminal/output` request and remains displayable after `terminal/release`.
- Alpha's ACP initialization does not advertise the ACP `terminal` client capability, and its ACP client has no handlers for `terminal/create`, `terminal/output`, `terminal/wait_for_exit`, `terminal/kill`, or `terminal/release`.
- The clean Portal provider bridge likewise does not implement those Agent-to-client methods. Alpha therefore receives an inline Terminal reference, not a retained output snapshot.
- WVE-43's `terminal.*` product RPCs represent persistent, Workspace-scoped user shells owned by Portal. ACP inline terminals represent commands created by an Agent through the ACP client contract. Their IDs, retention, release rules, and authority are intentionally independent.
- `XtermTerminalView` now has a genuine `readOnly` mode that disables stdin and suppresses input callbacks. Its docked form still fits to a controlled panel and reports grid resize, while an inline transcript renderer would need bounded intrinsic height, no resize/control traffic, stable transcript persistence, copy/accessibility checks, and released-output retention.

## Safe follow-up seam

A later ACP-terminal slice can reuse or factor the xterm rendering core after it:

1. implements the full ACP terminal client lifecycle in the Host that owns the Agent process;
2. persists terminal output with the transcript so released terminals remain renderable;
3. associates output with ACP session and terminal identity rather than Portal user-shell identity;
4. exposes an inline presentation mode with fixed/bounded rows, read-only input, no control lease, and no resize RPC; and
5. verifies selection/copy, screen-reader fallback text, streaming ordering, truncation, exit status, and transcript reload.

Until that contract exists, replacing the inline reference card with xterm would be a visual shell around missing or incorrectly sourced data.
