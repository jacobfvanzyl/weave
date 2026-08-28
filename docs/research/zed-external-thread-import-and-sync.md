# Syncing Alpha-created external-agent Threads into Zed

**Research date:** 2026-08-26

**Status:** Implemented for the product Portal under WVE-51; physical Zed acceptance completed

**Upstream snapshots:** Zed [`ac099b4`](https://github.com/zed-industries/zed/tree/ac099b4a809a564f06907125e7a536c33cb60084), ACP [`72ce169`](https://github.com/agentclientprotocol/agent-client-protocol/tree/72ce1692294740abf4776b56f33158c75db6e531), Codex ACP [`50f69e5`](https://github.com/agentclientprotocol/codex-acp/tree/50f69e57ca761ccafd2ca29de7fb591068277516)

**Draft-preflight addendum:** 2026-08-28 against Zed [`4b3ef3e`](https://github.com/zed-industries/zed/tree/4b3ef3e45a64f30525324ef8d0d60c1adca2cd7a)

## Conclusion

Yes, an Alpha-created Thread can be made discoverable and continuable in Zed, but the supported integration surface is the External Agent's ACP session API, not Zed's private SQLite database, an Electron window API, or the current `zed` CLI.

Zed now has a first-party **Import Threads** flow. It connects to each configured External Agent, calls ACP `session/list`, writes returned sessions into its own Thread History as archived metadata, and calls `session/load` or `session/resume` when the user opens one. This is the intended inverse of Weave's existing Zed-to-Portal observation path. Alpha or its future Electron shell should therefore make Portal Threads available through a Zed-configured Weave ACP adapter; it should not attempt to create or mutate Zed rows itself.

There is one product limitation: current Zed import is user-triggered and there is no public CLI/deep-link/API for importing a specific external session silently. A zero-click Electron-driven sync would need a small upstream Zed API or an explicit Zed integration/fork. The supported near-term experience is:

1. Alpha creates and owns the Thread in Portal.
2. The Weave External Agent adapter advertises `sessionCapabilities.list` and returns that Thread from `session/list`.
3. The user chooses **Import Threads** in Zed.
4. Zed stores its own presentation metadata and opens the Thread through the same adapter.

WVE-51 now includes the product-Portal adapter because it is the smallest supported path that proves Alpha-to-Zed
continuity without coupling Alpha to Zed's private storage. WVE-52 still owns Weave archive/restore semantics; the
adapter deliberately does not map them to Zed archive or ACP delete.

## Decision matrix

| Option | Current status | Recommendation |
| --- | --- | --- |
| Expose Portal Threads through ACP `session/list`, `session/load`/`session/resume` | First-party ACP and Zed path | **Use this.** It preserves Portal authority and avoids a Zed-version dependency. |
| Let the existing Weave connector pass the provider's `session/list` through unchanged | Mechanically works for providers that implement it, including current Codex ACP | Useful for a proof only. It omits Portal-only identity/lifecycle rules and leaks provider delete semantics. |
| Launch `zed://agent` or a Zed action from Electron | Can open the Agent Panel or create a new external thread | Insufficient. The public URL/action inputs do not select an existing session or import it. |
| Automate Zed's Import Threads modal | Technically possible with UI automation | Unsupported and brittle; acceptable only as an acceptance harness, not a product boundary. |
| Insert/update Zed's `sidebar_threads` SQLite table | Technically possible with version-specific code and careful locking | **Do not use.** It is private, migratable UI metadata and bypasses Zed invariants and in-memory state. |
| Link or reuse Zed's Rust `agent_ui` crates in Electron | Source is available under GPL and deeply GPUI-coupled | Not a practical Electron integration; it becomes a Zed fork/licensing and release-coupling decision. |

## Current Weave and Alpha seams

### The existing Zed-to-Weave direction

The earlier Host implementation already exposes a Zed-compatible stdio command. `weave-host acp connect` opens a mode-`0600` Unix socket to the daemon and relays newline-delimited ACP without adding Weave fields. The documented Zed custom-agent configuration launches that command from each project context. See [the connector documentation](../../portal/README.md#experimental-direct-host-acp-proof) and [the local gateway](../../portal/src/acp/local-gateway.ts#L30-L215).

When Zed sends a successful `session/new`, `session/load`, or `session/resume`, `AcpSessionTracker` observes the request/response pair and upserts the provider session into Weave's Host Thread catalog. Prompts touch recency; close and delete update status. This is why Zed-originated sessions already appear on the Weave side. See [session-tracker.ts](../../portal/src/acp/session-tracker.ts#L18-L86) and the catalog's host-scoped `(agentId, workspaceId, acpSessionId)` index in [thread-catalog.ts](../../portal/src/acp/thread-catalog.ts#L57-L79).

The broker forwards unhandled initialized ACP requests to the provider, so `session/list` currently passes through when the underlying adapter implements it. It has special durable handling for `session/load`, prompt serialization, event replay, and provider recovery, but not a Portal-authored list response. See [session-broker.ts](../../portal/src/acp/session-broker.ts#L365-L555).

### Alpha-created Threads

The current product Portal creates an Alpha Thread by starting a provider `session/new`, then stores two identities:

- `threadId`: Weave's logical Thread identity;
- `acpSessionId`: the provider-owned ACP session identity.

See [thread-runtime.ts](../../product/portal/src/thread-runtime.ts#L120-L167), [the product catalog](../../product/portal/src/catalog.ts#L4-L48), and the shared [ThreadSummary](../../product/protocol/src/index.ts#L175-L184). Alpha lists, creates, and attaches through authenticated Portal RPC; attachment then speaks ordinary ACP over the Thread route. See [portal.ts](../../product/portal/src/portal.ts#L173-L209) and [portal-client.ts](../../product/alpha/src/portal-client.ts#L144-L185).

The product Portal now exposes its own mode-`0600` Unix-socket gateway and a thin `weave-portal acp connect` stdio
command. The adapter lists product-Portal Threads, maps an opaque host-scoped session ID back to the logical
`threadId`, and delegates load, resume, and prompts to the existing hosted runtime and durable journal. It does not
reuse the earlier Host catalog or leak the provider `acpSessionId`. See [the product adapter](../../product/portal/src/local-acp.ts),
[Portal routing](../../product/portal/src/portal.ts), and [the operator documentation](../../product/portal/README.md#zed-external-agent).

## What Zed supports now

### New-thread drafts use a provisional ACP session

Zed's new-thread draft is not session-free. It is only **uncommitted as an ACP-backed entry in Zed's Thread
History**: Zed may persist a local `ThreadId` and typed draft, but keeps the metadata `session_id` empty until the
first message. Creating or activating the draft immediately builds a `ConversationView`; with no saved session to
resume, that view calls the External Agent connection's `new_session`. [Draft activation and reuse](https://github.com/zed-industries/zed/blob/4b3ef3e45a64f30525324ef8d0d60c1adca2cd7a/crates/agent_ui/src/agent_panel.rs#L1800-L1873), [draft construction](https://github.com/zed-industries/zed/blob/4b3ef3e45a64f30525324ef8d0d60c1adca2cd7a/crates/agent_ui/src/agent_panel.rs#L2975-L3066), and [the new-vs-resume branch](https://github.com/zed-industries/zed/blob/4b3ef3e45a64f30525324ef8d0d60c1adca2cd7a/crates/agent_ui/src/conversation_view.rs#L1142-L1170).

For an ACP External Agent, `AcpConnection::new_session` sends the standard `session/new` request with the project's
working directories and MCP servers. The response supplies the real ACP `sessionId` plus optional `modes` and
`configOptions`. Zed registers that session in memory before showing the ready composer. It therefore has an Agent
session before the user sends a prompt, even though the draft has no messages and Zed deliberately withholds that
session ID from its persisted/history representation. [ACP new-session implementation](https://github.com/zed-industries/zed/blob/4b3ef3e45a64f30525324ef8d0d60c1adca2cd7a/crates/agent_servers/src/acp.rs#L1601-L1707), [draft definition](https://github.com/zed-industries/zed/blob/4b3ef3e45a64f30525324ef8d0d60c1adca2cd7a/crates/acp_thread/src/acp_thread.rs#L2342-L2359), and [metadata promotion](https://github.com/zed-industries/zed/blob/4b3ef3e45a64f30525324ef8d0d60c1adca2cd7a/crates/agent_ui/src/thread_metadata_store.rs#L1274-L1347).

That provisional session is the preflight that populates the composer controls:

1. Zed prefers `configOptions` whenever the Agent returns them and ignores the legacy `modes` state in that case.
   It renders every returned option in Agent-provided order. Standard semantic categories identify model, mode,
   model configuration, and thought/reasoning level controls. [Zed's config precedence](https://github.com/zed-industries/zed/blob/4b3ef3e45a64f30525324ef8d0d60c1adca2cd7a/crates/agent_servers/src/acp.rs#L4447-L4458), [selector construction](https://github.com/zed-industries/zed/blob/4b3ef3e45a64f30525324ef8d0d60c1adca2cd7a/crates/agent_ui/src/conversation_view.rs#L1305-L1344), and [ACP config categories](https://agentclientprotocol.com/protocol/v1/session-config-options#option-categories).
2. A draft-time selection calls `session/set_config_option` with that provisional `sessionId`, `configId`, and value.
   Zed replaces its cached state with the complete `configOptions` response, so a model change can immediately
   repopulate dependent reasoning choices. Agent-originated `config_option_update` notifications refresh the same
   selectors. [Zed set-config implementation](https://github.com/zed-industries/zed/blob/4b3ef3e45a64f30525324ef8d0d60c1adca2cd7a/crates/agent_servers/src/acp.rs#L4511-L4544), [ACP update contract](https://agentclientprotocol.com/protocol/v1/session-config-options#setting-a-config-option).
3. If the Agent only returns legacy `modes`, Zed renders `ModeSelector`; changes call `session/set_mode` against the
   provisional session. [Zed mode implementation](https://github.com/zed-industries/zed/blob/4b3ef3e45a64f30525324ef8d0d60c1adca2cd7a/crates/agent_servers/src/acp.rs#L4460-L4500).
4. The first prompt adds the first entry to the in-memory `AcpThread`. Since Zed defines a draft as a thread whose
   entry list is empty, that event promotes the same session rather than creating a second one; the metadata store
   then persists the already-issued ACP session ID. [Prompt send path](https://github.com/zed-industries/zed/blob/4b3ef3e45a64f30525324ef8d0d60c1adca2cd7a/crates/acp_thread/src/acp_thread.rs#L3616-L3712), [draft metadata behavior](https://github.com/zed-industries/zed/blob/4b3ef3e45a64f30525324ef8d0d60c1adca2cd7a/crates/agent_ui/src/thread_metadata_store.rs#L1490-L1506).

When an unused draft view is actually released, Zed sends `session/close` if the Agent advertised that capability.
ACP close frees active resources; it is not session deletion and does not promise that an Agent never durably created
the session. [Zed release handling](https://github.com/zed-industries/zed/blob/4b3ef3e45a64f30525324ef8d0d60c1adca2cd7a/crates/agent_ui/src/conversation_view.rs#L850-L865), [Zed close implementation](https://github.com/zed-industries/zed/blob/4b3ef3e45a64f30525324ef8d0d60c1adca2cd7a/crates/agent_servers/src/acp.rs#L1813-L1878), and [ACP close semantics](https://agentclientprotocol.com/protocol/v1/session-setup#closing-active-sessions).

There is no standard ACP call that discovers session-specific configuration without establishing a session. The
standard contract returns initial configuration during session setup, and later changes are session-scoped.
[ACP session setup](https://agentclientprotocol.com/protocol/v1/session-setup#creating-a-session) and [ACP initial config state](https://agentclientprotocol.com/protocol/v1/session-config-options#initial-state).

For Alpha, matching Zed without making empty drafts visible as durable Portal Threads therefore requires a
**provisional Portal runtime**, not a client-only placeholder and not a second provider session on first send:

- prepare the draft by starting one provider ACP session and return its session ID only through an opaque,
  authenticated provisional handle plus its mode/config state;
- route draft-time `session/set_config_option` or legacy `session/set_mode` through that handle;
- keep the provisional runtime out of `thread.list`, the durable Thread catalog, Zed `session/list`, and archive state;
- on the first prompt, atomically promote the same runtime into a durable Portal Thread before sending the prompt;
- on abandonment or timeout, call `session/close` when supported and discard the provisional handle.

Caching the last session's controls in Alpha could make the UI appear populated, but it is not equivalent: options
are Agent-, version-, authentication-, workspace-, and current-model-dependent, and ACP explicitly allows a model
selection to change the available reasoning choices. A proper preflight must remain authoritative at the Portal/Agent
session boundary.

### Agent-initiated Thread titles are standard ACP

Stable ACP v1 supports the Agent-owned rename case. The Agent sends an ordinary `session/update` notification for
the active session with `update.sessionUpdate: "session_info_update"` and a `title`. The title is a partial metadata
update: omission leaves it unchanged and `null` clears it. No extra capability negotiation is defined because the
message uses the existing Agent-to-Client session-update channel. ACP calls the object a session; associating its
`sessionId` with a visible Thread is the Client's responsibility. [Stable v1 notification shape](https://github.com/agentclientprotocol/agent-client-protocol/blob/schema-v1.21.0/schema/v1/schema.json#L3617-L3646), [stable update variant and type](https://github.com/agentclientprotocol/agent-client-protocol/blob/schema-v1.21.0/schema/v1/schema.json#L3795-L3810), and [title update semantics and example](https://github.com/agentclientprotocol/agent-client-protocol/blob/9f40e018012a2634af9ecab1d89157561fcffba5/docs/protocol/v1/session-list.mdx#L177-L217).

`session/list` is the complementary discovery surface. Its `SessionInfo.title` is the Agent-reported current title
for a stored session; a Client uses `session_info_update` for the live change and the later list value when rebuilding
history. [Stable `SessionInfo.title`](https://github.com/agentclientprotocol/agent-client-protocol/blob/schema-v1.21.0/schema/v1/schema.json#L3274-L3317) and [session-list field contract](https://github.com/agentclientprotocol/agent-client-protocol/blob/9f40e018012a2634af9ecab1d89157561fcffba5/docs/protocol/v1/session-list.mdx#L129-L156). The update began as an RFD but was explicitly stabilized with `session/list` in ACP 0.11.1; the RFD is now design history, not a draft dependency. [Stabilization announcement](https://github.com/agentclientprotocol/agent-client-protocol/blob/9f40e018012a2634af9ecab1d89157561fcffba5/docs/announcements/session-info-update-stabilized.mdx#L1-L13) and [0.11.1 changelog](https://github.com/agentclientprotocol/agent-client-protocol/blob/9f40e018012a2634af9ecab1d89157561fcffba5/CHANGELOG.md#L319-L325).

The repository's installed `@agentclientprotocol/sdk` 1.4.0 already includes
`SessionInfoUpdate { title?: string | null; updatedAt?: string | null; _meta?: ... }` in the stable `SessionUpdate`
union. [Official SDK union](https://github.com/agentclientprotocol/typescript-sdk/blob/v1.4.0/src/schema/types.gen.ts#L3690-L3708), [official SDK type](https://github.com/agentclientprotocol/typescript-sdk/blob/v1.4.0/src/schema/types.gen.ts#L4189-L4214), and [Alpha dependency](../../product/alpha/package.json#L13-L18).

Current Zed consumes this standard notification in both places that matter. It forwards the update to its session-list
watcher, and the active `AcpThread` replaces its generated title and emits `TitleUpdated`; metadata persistence then
stores the new title. A user-supplied Zed title override deliberately remains higher priority, so an Agent update does
not clobber an explicit local rename. [ACP notification routing](https://github.com/zed-industries/zed/blob/cf1900f44d30c771207e36e2c9094b6c1f659bea/crates/agent_servers/src/acp.rs#L4862-L4866), [active-thread title update](https://github.com/zed-industries/zed/blob/cf1900f44d30c771207e36e2c9094b6c1f659bea/crates/acp_thread/src/acp_thread.rs#L2613-L2623), [metadata-change emission](https://github.com/zed-industries/zed/blob/cf1900f44d30c771207e36e2c9094b6c1f659bea/crates/agent_ui/src/conversation_view.rs#L1588-L1605), and [Zed title-override precedence](https://github.com/zed-industries/zed/blob/cf1900f44d30c771207e36e2c9094b6c1f659bea/crates/agent_ui/src/thread_metadata_store.rs#L308-L342).

The opposite direction is not standardized. Stable ACP has no Client-to-Agent `session/rename` request and
`session/new` has no title field. The completed Session Info Update RFD mentions a Client request only as a possible
future addition, and a current open proposal asks for `session/rename` plus `session/new.title`. Vendor commands such
as `/rename` and `_meta.sessionTitle` are therefore bilateral extensions, not portable ACP. [Stable new-session request](https://github.com/agentclientprotocol/agent-client-protocol/blob/schema-v1.21.0/schema/v1/schema.json#L4739-L4775), [RFD future direction](https://github.com/agentclientprotocol/agent-client-protocol/blob/9f40e018012a2634af9ecab1d89157561fcffba5/docs/rfds/session-info-update.mdx#L140-L158), and [open rename proposal](https://github.com/agentclientprotocol/agent-client-protocol/issues/1978).

Weave now completes this presentation contract. Portal validates that `session_info_update` belongs to the runtime's
ACP session, applies `title` and valid `updatedAt` metadata to the durable `ThreadSummary`, persists it before fan-out,
and preserves provisional-draft titles without listing the draft before its first prompt. The Portal-authored
`session/list` therefore returns the current Agent title after restart. Alpha continues updating its active transcript
and also applies the metadata immediately to the matching Host-scoped sidebar Thread, without waiting for its periodic
Host snapshot refresh. `title: null` clears the catalog title and returns the UI to its Workspace-name fallback; an
update for another session cannot rename the Thread. Older ACP Clients that ignore this union variant degrade to
seeing the title only on a later list/refresh. See [Portal update handling](../../product/portal/src/thread-runtime.ts),
[Portal list projection](../../product/portal/src/local-acp.ts), and
[Alpha live projection](../../product/alpha/src/app/use-live-alpha-controller.ts).

### First-party external Thread import

Zed's official documentation says configured External Agents can expose existing sessions for import. Imported sessions enter Thread History as archived entries; sessions without a working directory are skipped; re-import skips sessions already known to Zed. [Zed External Agents documentation at the inspected commit](https://github.com/zed-industries/zed/blob/ac099b4a809a564f06907125e7a536c33cb60084/docs/src/ai/external-agents.md#L186-L194).

The source implements that contract as follows:

- During initialization, Zed creates an `AcpSessionList` only when the agent advertises `sessionCapabilities.list`; it separately records whether `sessionCapabilities.delete` is advertised. [Capability handling](https://github.com/zed-industries/zed/blob/ac099b4a809a564f06907125e7a536c33cb60084/crates/agent_servers/src/acp.rs#L1045-L1065).
- Zed maps its list abstraction directly to ACP `session/list`, forwarding optional `cwd` and pagination cursor and converting `sessionId`, working directories, title, and update time. [ACP list adapter](https://github.com/zed-industries/zed/blob/ac099b4a809a564f06907125e7a536c33cb60084/crates/agent_servers/src/acp.rs#L559-L599).
- The import dialog asks every relevant connection store: one local project context plus each open remote project context. It paginates until `nextCursor` ends. [Connection-store selection](https://github.com/zed-industries/zed/blob/ac099b4a809a564f06907125e7a536c33cb60084/crates/agent_ui/src/thread_import.rs#L641-L672), [fetch and pagination](https://github.com/zed-industries/zed/blob/ac099b4a809a564f06907125e7a536c33cb60084/crates/agent_ui/src/thread_import.rs#L689-L819).
- Import deduplicates by ACP `sessionId`, requires working directories, creates a new Zed-local `ThreadId`, retains the configured `agentId` and project/remote identity, and sets `archived: true`. [Import conversion](https://github.com/zed-industries/zed/blob/ac099b4a809a564f06907125e7a536c33cb60084/crates/agent_ui/src/thread_import.rs#L855-L888).
- Opening a history row unarchives the Zed-local row and routes through the saved agent and session. [Open path](https://github.com/zed-industries/zed/blob/ac099b4a809a564f06907125e7a536c33cb60084/crates/agent_ui/src/agent_panel.rs#L4407-L4484). Zed uses `session/load` when available and `session/resume` when that is the advertised restore surface. [ACP restore implementations](https://github.com/zed-industries/zed/blob/ac099b4a809a564f06907125e7a536c33cb60084/crates/agent_servers/src/acp.rs#L1729-L1808).

ACP v1 defines exactly this discovery path: the agent advertises `sessionCapabilities.list`; `session/list` returns an opaque unique `sessionId`, absolute `cwd`, optional additional directories, title, `updatedAt`, and cursor pagination. [ACP v1 Session List](https://github.com/agentclientprotocol/agent-client-protocol/blob/72ce1692294740abf4776b56f33158c75db6e531/docs/protocol/v1/session-list.mdx#L35-L175). `session/load` replays history as ordinary `session/update` notifications, while `session/resume` reattaches without replay. [ACP v1 restore semantics](https://github.com/agentclientprotocol/agent-client-protocol/blob/72ce1692294740abf4776b56f33158c75db6e531/docs/protocol/v1/session-setup.mdx#L104-L188), [resume semantics](https://github.com/agentclientprotocol/agent-client-protocol/blob/72ce1692294740abf4776b56f33158c75db6e531/docs/protocol/v1/session-setup.mdx#L190-L243).

Current Codex ACP already advertises list/resume/load/delete and maps `session/list` to Codex app-server `thread/list`, returning the Codex Thread ID, cwd, title/preview, and update time. [Codex capabilities](https://github.com/agentclientprotocol/codex-acp/blob/50f69e57ca761ccafd2ca29de7fb591068277516/src/CodexAcpServer.ts#L315-L348), [list mapping](https://github.com/agentclientprotocol/codex-acp/blob/50f69e57ca761ccafd2ca29de7fb591068277516/src/CodexAcpClient.ts#L1068-L1121). Consequently, passing the provider response through can prove the concept for Codex-created Alpha sessions, but it is not the correct long-term ownership boundary.

### Zed's private representation

Zed deliberately stores only enough local metadata to populate and route the sidebar. `ThreadMetadata` contains a Zed-local `thread_id`, optional ACP `session_id`, `agent_id`, title and timestamps, ordered worktree paths, optional remote-connection identity, and the local archived flag. [ThreadMetadata](https://github.com/zed-industries/zed/blob/ac099b4a809a564f06907125e7a536c33cb60084/crates/agent_ui/src/thread_metadata_store.rs#L306-L364).

That metadata is in a private, release-channel-scoped SQLite `sidebar_threads` table. Its schema is evolved by in-process migrations and has already changed from a session-primary-key table to a separate UUID BLOB `thread_id`, with later archive, worktree, remote, interaction, and title-override columns. [Schema and migrations](https://github.com/zed-industries/zed/blob/ac099b4a809a564f06907125e7a536c33cb60084/crates/agent_ui/src/thread_metadata_store.rs#L1368-L1465). Zed locates the database below its platform data directory, in `db/0-<release-channel>/db.sqlite`, and opens it in WAL mode while keeping an in-memory indexed mirror. [Paths](https://github.com/zed-industries/zed/blob/ac099b4a809a564f06907125e7a536c33cb60084/crates/paths/src/paths.rs#L143-L167), [database path and settings](https://github.com/zed-industries/zed/blob/ac099b4a809a564f06907125e7a536c33cb60084/crates/db/src/db.rs#L125-L168), [in-memory indexes](https://github.com/zed-industries/zed/blob/ac099b4a809a564f06907125e7a536c33cb60084/crates/agent_ui/src/thread_metadata_store.rs#L497-L510).

Direct writes would therefore have to track channel paths, every migration, Zed's UUID BLOB encoding, serialized path ordering and remote-connection JSON, WAL/lock behavior, foreign-key cleanup, and the running process's stale in-memory indexes. Even a successful insert could point at an unconfigured agent, an unavailable remote project, or a session the agent cannot restore. This storage is useful for read-only diagnostics against a pinned Zed build, not as Alpha's integration contract.

### No targeted public automation surface

The public custom External Agent action accepts only an `agent` ID and creates a new thread; it has no existing-session input. [NewExternalAgentThread](https://github.com/zed-industries/zed/blob/ac099b4a809a564f06907125e7a536c33cb60084/crates/agent_ui/src/agent_ui.rs#L379-L413). The current `zed://agent` URL parser accepts only an optional prompt and opens a new Agent Panel thread. [URL parsing](https://github.com/zed-industries/zed/blob/ac099b4a809a564f06907125e7a536c33cb60084/crates/zed/src/zed/open_listener.rs#L225-L233). There is no `agentId` plus `sessionId` import URL or CLI option in this source snapshot.

This means a future Electron Alpha can install/configure the Weave External Agent entry, launch/focus Zed, and explain the import action, but cannot currently tell stock Zed to persist a particular session without user interaction. A suitable upstream addition would be a narrow, idempotent action or URL such as “import external session by configured agent ID and ACP session ID,” with Zed still validating it via `session/list` and owning the row.

## Recommended integration architecture

Keep three identities and responsibilities separate:

```text
Alpha / Portal identity               Zed-facing ACP identity              Zed-local identity

(hostId, threadId) --adapter map--> opaque sessionId --Zed import--> random ThreadId
        |                                  |                              |
        | Portal owns catalog,             | ACP list/load/resume          | Zed owns sidebar,
        | archive, journal, runtime         | only                          | archive and layout
        v                                  v                              v
 provider acpSessionId remains private to Portal and its runtime broker
```

The Zed-facing `sessionId` should be an opaque, stable gateway identity derived from or durably mapped to `(hostId, threadId)`, not the raw provider `acpSessionId`. On `session/load`/`session/resume`, the adapter resolves that identity through the owning Portal and lets Portal bind the correct provider session and replay its authoritative journal. This has four benefits:

1. identical raw Thread or provider session IDs on two WVE-51 Hosts cannot collide;
2. provider-session replacement during recovery does not invalidate Zed metadata;
3. Portal authorization and workspace scoping remain enforceable at every lookup;
4. Zed does not learn or become authoritative for Alpha's host registry.

Use the existing host-local `weave-host` stdio topology for Zed local and SSH Remote projects. Zed launches an External Agent separately in one local context and each remote-project context; `session/list` must return paths valid in that context. A local Electron aggregator must not return a remote Host's absolute paths as if they were local Zed worktrees. If Alpha eventually offers multi-Host import, either:

- expose one configured Weave External Agent per reachable project/Host context; or
- build a local companion adapter that lists only Threads whose workspaces map to the current Zed connection context, while remote Zed continues to use the host-local connector.

The adapter should initially implement Portal-authored `session/list` rather than blindly forwarding the provider list:

- list durable Portal Threads authorized for the connector's Host/workspace context;
- return the opaque host-scoped session ID, absolute workspace cwd, title, and update time;
- paginate deterministically;
- resolve load/resume back to Portal `threadId` and let the journal replay;
- keep provider-specific `_meta` optional and non-authoritative;
- do not invent Zed-private methods or required metadata.

## Lifecycle and deletion boundaries

Zed archive and WVE-52 archive are two independent presentation states:

- Zed imports every discovered external session as locally archived, then locally unarchives it when opened.
- WVE-52 archives a Portal Thread and hides it from Alpha's active list while retaining the journal, provider-session mapping, and ability to restore.
- ACP `session/close` frees active runtime resources; it is not archive.
- ACP `session/delete` removes a session from future lists and may be soft or hard delete; it is not reversible archive. [ACP delete semantics](https://github.com/agentclientprotocol/agent-client-protocol/blob/72ce1692294740abf4776b56f33158c75db6e531/docs/protocol/v1/session-delete.mdx#L33-L88).

Do not map either Zed archive or ACP delete to WVE-52 archive. Unless Weave deliberately designs and authorizes true provider deletion, the Zed-facing adapter should not advertise `sessionCapabilities.delete`. Zed removes its local row first and calls the agent's `session/delete` only when that capability is present. [Zed delete path](https://github.com/zed-industries/zed/blob/ac099b4a809a564f06907125e7a536c33cb60084/crates/agent_ui/src/threads_archive_view.rs#L807-L850). Current Codex ACP does advertise delete, so blind capability passthrough exposes a destructive provider operation that is outside WVE-52.

Portal-archived Threads should remain listable to the Zed adapter unless a later product decision explicitly defines a cross-client visibility policy. Suppressing them would make Weave's reversible UI state change the standard ACP history surface, contradicting WVE-52's “Weave state only; standard ACP unchanged” boundary.

## Delivery boundaries for WVE-51 and WVE-52

### WVE-51: multi-Host aggregation

WVE-51 preserves these multi-Host and Zed-facing invariants:

- preserve canonical `(hostId, threadId)` identity through selection, recency, search, creation, ACP attachment, and reconnect;
- never collapse same-valued raw IDs from different Hosts;
- retain owning Host and workspace routing information outside display labels;
- make partial Host failure explicit without rewriting or dropping cached identity;
- expose enough host/workspace metadata for a later adapter to determine whether a Thread's cwd belongs to the current local or Zed Remote project context.

This is required because current Zed import deduplicates globally by raw ACP `sessionId`, not by `(agentId, remote connection, sessionId)`. Host scoping must therefore be encoded in the opaque Zed-facing session ID before any multi-Host list is exposed.

### WVE-52: archive and restore

WVE-52 should, without mapping state into ACP:

- persist archive state against Portal `threadId`, not the replaceable provider session ID;
- retain `acpSessionId`, journal, workspace, owning Host, timestamps, and recovery state after archive;
- define archive behavior during an active prompt without sending provider `session/close` or `session/delete` by accident;
- keep archive/restore idempotent and host-authorized;
- allow a later standard ACP load/resume of the same logical Thread after an Alpha archive/restore cycle;
- ensure archive changes do not advertise the destructive ACP delete capability.

## Physical acceptance completed

On 2026-08-26, stock Zed 1.17.2 was exercised through Computer Use against the installed product Portal:

1. An authenticated `thread.create` request—the same Portal RPC path Alpha uses—created and prompted
   `Acceptance WVE51_ALPHA_TO_ZED_IMPORT_SETUP`.
2. Zed's real **Import External Agent Threads** dialog discovered the configured `weave-codex` source and imported
   two new sessions; its history count moved from 30 to 32.
3. Opening the uniquely titled entry replayed the earlier Alpha-path prompt and exact response through `session/load`.
4. A new Zed prompt returned `WVE51_ZED_IMPORT_CONTINUITY_OK` exactly. The Portal journal contained the marker, and a
   second connector load after a Portal daemon restart replayed it successfully with 30 session updates.
5. Read-only inspection confirmed Zed stores only its local archived/routing metadata in `sidebar_threads`; no Zed
   database writes were used.

The remaining broader compatibility matrix is:

1. Repeat with two WVE-51 Hosts that intentionally use identical raw `threadId` and `acpSessionId` fixtures.
2. Complete the WVE-52 archive/restore UI matrix while confirming no ACP delete is advertised or invoked.
3. Run once through a Zed SSH Remote project and verify every returned cwd is valid in that connection context.

If product requirements demand silent or continuous import rather than the supported user-triggered import, stop after this spike and pursue an upstream Zed action/deep link. Do not treat SQLite injection or UI automation as completion.

## Versioning risks

- Zed's inspected build depends on `agent-client-protocol = 2.0.0` with unstable features but its External Agent adapter currently uses the v1 schema. Pin and test the negotiated protocol rather than inferring behavior from the crate major version. [Zed dependency](https://github.com/zed-industries/zed/blob/ac099b4a809a564f06907125e7a536c33cb60084/Cargo.toml#L517).
- ACP v2 removes `session/load`; `session/resume` gains an optional replay cursor and list/resume/close become baseline when the agent advertises the session surface. The adapter must negotiate v1 and v2 explicitly when Zed migrates. [ACP v2 lifecycle migration](https://github.com/agentclientprotocol/agent-client-protocol/blob/72ce1692294740abf4776b56f33158c75db6e531/docs/protocol/v2/migration.mdx#L555-L587).
- Zed's private database schema and import UI can change independently of ACP. Relying on ACP limits compatibility work to the protocol adapter and acceptance matrix.
- Provider session listing can have different filtering, pagination, title, archive, or deletion behavior. Portal-authored list results are necessary once logical Weave Thread identity differs from provider identity.
