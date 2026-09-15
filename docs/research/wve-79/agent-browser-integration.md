# Thread-scoped ACP access to Host Browser Profiles

WVE-79, 14 September 2026. Implementation and acceptance on macOS; iPad and Linux validation remain deferred at the user's request.

## Product contract

An explicit Browser Profile grant belongs to one Thread. It survives moving that Thread's Agent Pane and restarting Portal, and can be revoked from the Agent Pane's **Browser access** dialog. Another Thread using the same agent receives no access. Only a trusted human pairing can edit grants, subject to its Thread access. Saves use an expected revision to reject stale edits.

A grant gives the Thread control of the selected Profile's signed-in browser identity and pages across Host Workspaces. This is intentionally broader than the Thread's Workspace. Agents can continue unattended. Revocation disconnects debugger sessions and rejects subsequent commands and late results, while preserving the shared pages. A command already executing in Chromium may have taken effect before revocation; revocation does not undo it.

One Browser Pane remains one Host-owned page. MCP `new_page` creates a Pane to the Right of the requesting Thread's Agent Pane because the browser-level creation request has no opener. A page's own popup uses the existing native opener rule: inherit its Profile and split the opener to the Right. MCP close removes the corresponding shared Pane. Profile and browser-process lifecycle remain Portal-owned.

## Composition

```text
ACP provider, scoped to one Thread
  -> injected stdio MCP server (Node)
     -> pinned chrome-devtools-mcp tools
     -> Portal Profile selection and raw CDP tools
        -> authenticated loopback Portal gateway
           -> private Browser Service Unix socket
              -> Chromium inherited CDP pipe (fd 3 / fd 4)
                 -> Profile-owned CEF browser and its shared pages
Human Alpha -> existing Portal RFB route -> the same pages
```

The tooling package pins **chrome-devtools-mcp 1.9.0** in its own Bun lockfile. It uses the upstream programmatic server, SDK transport and schemas without patching dependencies. Its three Portal-specific tools list granted Profiles, select a Profile, and expose session-scoped CDP commands/events. The upstream tools provide snapshots, screenshots, evaluation, console/network inspection and other browser automation. Usage statistics, update checking and CrUX requests are disabled. The upstream workspace setting uses the Thread execution directory for tool artifacts.

The maintained server supports connecting to an existing WebSocket endpoint with headers. Portal injects an endpoint and random per-runtime token through the MCP environment; the token is not a command-line argument. The endpoint binds to loopback, requires the token and rejects browser Origin headers. Grant checks apply before dispatch and before returning data. Tokens rotate when the Thread runtime is recreated. [Upstream configuration](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/configuration.md).

The pinned CEF runtime is **152.0.6+g708dc14**, Chromium **152.0.7977.83**. Chromium's standard null-delimited remote debugging pipe avoids a raw browser debugging TCP listener. Each consumer uses `Target.attachToBrowserTarget` to get an independent browser-level session, with its own child sessions and bounded event queue. Portal's own native page controls remain separate. The Browser Service expires abandoned sessions; it owns the pipe across Portal connections. [Chromium remote debugging implementation](https://github.com/chromium/chromium/blob/main/chrome/browser/devtools/remote_debugging_server.cc).

Two narrow compatibility/lifecycle adaptations are necessary:

- Route `Target.createTarget` and `Target.closeTarget` through Portal's native page lifecycle. Reject browser shutdown and creating/discarding browser contexts through this path.
- Add an `other` target exclusion to MCP's auto-attach filter. This CEF build transiently exposes native pages as `other`; without the filter Puppeteer can retain an incompatible target object before Chromium reports a page. The raw CDP tool keeps the caller's filter unchanged.

These adaptations are empirically verified against the pins above. They must be retested when upgrading CEF or MCP. The wrapper imports upstream programmatic and bundled SDK modules; those import paths are another upgrade check.

## Boundaries and limitations

- Raw CDP is powerful browser control, not an OS filesystem sandbox. Granting a Profile is a trust decision. Artifact workspace options and tool descriptions do not enforce arbitrary raw-CDP file access. Existing ACP execution permissions remain a separate concern.
- Human viewport ownership remains focus-based. The MCP emulation tool category is disabled. An agent using raw emulation CDP can still change the shared page; the raw tool explicitly describes the shared viewport contract.
- Audio stays parked. RFB display and native CEF scrolling are unchanged by this tooling layer.
- Node is an explicit Host prerequisite (`browser.nodeExecutable`); acceptance used Node **24.19.0**. The tools are packaged alongside the Host. Browser tools are advertised only when configured. The current installer does not provision Node automatically.
- Public protocol 8 gains additive `browser.grants.v1` methods. Private Browser Service protocol becomes **5** and native runtime handshake **2**, so this update requires replacing/restarting those components together. Profile storage and Pane identities persist; live JavaScript state does not survive a browser-process restart.
- Loopback controls reject concurrent raw control operations with a retryable error. Each Thread permits four MCP debugger sockets; the service caps debugger sessions at 32. CDP messages/queues are bounded at 16 MiB, with 4,096 queued events per consumer. A slow consumer must reconnect instead of accumulating unbounded state.

## Validation

`bun run check` passed: 294 Alpha tests across 59 files, 40 protocol tests, 143 Portal tests, and two root script tests, plus type checks/build checks in that command.

The disposable native acceptance runs the real Browser Service, pinned CEF, authenticated Portal RPC, ACP Thread runtime, a deterministic ACP provider, and the actual pinned MCP server over stdio. It verifies:

- No implicit grant; another Profile cannot be selected; another Thread using the same agent inherits nothing.
- MCP tools enumerate, create a native page, and insert its Browser Pane into the Host composition to the Right.
- Snapshot, screenshot, page mutation, console event and network request inspection work against that page.
- An independent raw CDP session attaches, enables the debugger, pauses, steps and resumes based on debugger events.
- A page keeps running without a viewer; revocation rejects MCP use and leaves the page alive.
- The entire fixture exits cleanly and removes its disposable Profiles and state.

Unit coverage also verifies durable grants, stale saves, invalid public contracts, forged tokens/Origins, late results across revoke/regrant, late debugger creation after revocation, pipe framing and isolated session events. Native RFB regression acceptance passed with exact pixels (zero differing pixels at 1000 × 800), native wheel/nested/fractional input, ordered delivery, popup Right split, viewport focus handoff, unattended lifetime and display revocation.

The initial deterministic provider run proved ACP/MCP protocol integration but missed discovery of pages created before the MCP connection. The follow-up below adds that regression and real Codex ACP prompt acceptance. Linux/iPad and other providers remain separate acceptance gates.

Reproduce on Mac:

```sh
bun install --cwd product/portal/browser-tools --frozen-lockfile --ignore-scripts
CEF_BINARY='/absolute/path/Weave Browser.app/Contents/MacOS/Weave Browser' \
  bun product/portal/scripts/browser-agent-acceptance.ts
```

The script writes `/tmp/wve79-agent-acceptance.json` and `/tmp/wve79-agent-screenshot.png`; override with `BROWSER_AGENT_EVIDENCE` and `BROWSER_AGENT_SCREENSHOT`. It does not use the installed Host state.

## Installed Mac check

The signed Host, private Browser Service, native runtime, pinned browser-tools bundle and Alpha client were installed and launched on the Mac. `/health` reported the expected new source hash and unchanged Host identity. The existing terminal owner remained PID 13352. The previous public-site Browser Pane was restored with its original Profile/Pane IDs, URL and scroll position; no typed form input was present before restart.

In the installed Alpha, **Browser access** loaded the Host Profile list with no grant inherited. Selecting a Profile and canceling left it ungranted on reopening. Saving the empty selection persisted revision 1 for the existing Thread, with an empty Profile list. No existing Thread was granted browser access as part of installation.

Rollback components/configuration are retained under `~/.local/share/weave/backups/browser-agent-20260914-074753/`; Alpha's installer retained the previous app separately. The scrolling checkpoint is committed at `23f93de5`; the ACP integration and discovery correction are included in the subsequent WVE-79 checkpoint.


## Follow-up: existing-page discovery and provider context

The first installed-provider attempt correctly had a Profile grant and a running MCP process, but the agent used Computer Use/cmux and concluded that the Weave page was unavailable. Its trace contained no Weave browser tool calls.

A real Codex ACP probe then exposed a separate transport bug: an existing page was absent from the first `list_pages` response. Command replies bypassed the polled CDP event queue, so Puppeteer could receive the discovery-complete response before the discovery events. The private service now queues streamed command responses and events in their Chromium wire order. Raw CDP requests retain their request/result API. This requires Browser Service protocol 5; the native CEF handshake stays at 2 and no native rebuild is needed.

A regression reproduced the empty initial list before the fix. It now discovers and snapshots a human-created page on the first connection before exercising MCP-created pages. A focused pipe test verifies event/response/event order within one native output chunk.

The stdio wrapper now supplies standard MCP initialization instructions identifying Weave's Host-owned Browser Panes, Profile grants and discovery flow. Tool descriptions also name Weave Browser Panes. Upstream tools and schemas are unchanged. The fixture asserts that this context reaches an MCP client.

With the corrected stream and metadata, the real configured **codex-acp 1.10.0 / Codex 0.154.0** provider answered an ordinary browser-access prompt by reading the granted fixture page's correct title and first heading, without changing it. Two natural-language runs reached the expected result. The isolated real-provider harness also exposed an intermittent existing process-group cleanup `EPERM` after the successful prompt; this is separate from browser access and is not counted as a clean fixture exit. The deterministic ACP acceptance repeated with a clean exit, and the full root check passed (143 Portal tests).

`product/portal/scripts/browser-provider-acceptance.ts` is an opt-in provider check. Set `PORTAL_CONFIG` to the configured Host launchers and `CEF_BINARY` to the native runtime. It creates a disposable Profile and page, uses a normal read-only prompt, and cleans the browser fixture even if provider shutdown reports an error. It does not attach to the user's Thread or grant itself an existing Profile.

The corrected Host, Browser Service and browser-tools package were installed on the Mac. The user's grant file was preserved byte-for-byte, the existing terminal owner survived, and the previous Browser Pane was restored. Rollback components are under `~/.local/share/weave/backups/browser-discovery-20260914-080748/`.

Final installed acceptance used the same existing Agent Pane and Thread that produced the user's screenshot. A normal read-only prompt caused `weave_browser_profiles`, `list_pages` and `take_snapshot` calls, with no Computer Use calls. The reply correctly identified the existing Linear page's title and first H1. The successful reply was visually verified in Alpha; page contents were not changed. This closes the real installed Codex provider browser-access gate for this case.
