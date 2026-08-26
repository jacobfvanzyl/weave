# A2UI over the current Agent Client Protocol

_Research snapshot: 2026-08-26. Primary sources only: the official ACP specification/repository and RFDs, the official A2UI specification/repository, and current Weave source. Upstream source links are pinned to ACP `63d16e3b` and A2UI `2bb84230`; Weave observations are from `bfbc5dfc`._

## Answer

**A2UI can be supported over stable ACP v1, but ACP does not currently define a native or interoperable A2UI binding.** The viable current design is a bilateral, capability-negotiated profile that:

1. advertises A2UI protocol versions, catalogs, delivery, and action modes in ACP capability `_meta`;
2. carries server-to-client A2UI batches in a normal ACP embedded resource with MIME type `application/a2ui+json` inside `session/update`;
3. carries a user action as a new `session/prompt` when turn semantics are acceptable, or through a negotiated `_`-prefixed custom request when a true out-of-band or mid-turn action is required; and
4. keeps ordinary ACP text, tool, plan, permission, elicitation, and diff output as the portable fallback and authoritative control surfaces.

This is valid composition of the two specifications, not evidence that an arbitrary ACP agent or client supports A2UI. A sender must not emit A2UI unless both sides negotiated the same A2UI version, catalog, and binding behavior.

The recommendation for Weave is therefore a staged profile over **stable ACP v1**, beginning with a read-only, additive generated pane. Do not make ACP v2, Embedded Views, MCP-over-ACP, `session/inject`, or ACP's remote transport drafts prerequisites.

## What is stable and what is not

| Surface | Current status | Consequence |
| --- | --- | --- |
| ACP wire protocol | Stable protocol version is `1`; wire compatibility comes from `initialize.protocolVersion`, not the schema package version. [ACP versioning](https://github.com/agentclientprotocol/agent-client-protocol/blob/63d16e3bd638d0a0021aab75e4ebc29b7cc77c22/README.md#L19-L29) | Base an implementation on v1 and negotiate extensions separately. |
| ACP v1 A2UI support | No A2UI capability, method, session-update variant, or content-block variant exists in the current v1 schema. Its closed `ContentBlock` union is text, image, audio, resource link, or embedded resource. [v1 schema](https://github.com/agentclientprotocol/agent-client-protocol/blob/63d16e3bd638d0a0021aab75e4ebc29b7cc77c22/schema/v1/schema.json#L596-L682) | There is no official “A2UI over ACP” interoperability claim. Use existing embedded resources and ACP's extension points; do not invent `type: "a2ui"` or `sessionUpdate: "a2ui"`. |
| A2UI wire protocol | A2UI v0.9.1 is the current production release; v1.0 is a release candidate and the project remains an early public preview. [A2UI status](https://github.com/a2ui-project/a2ui/blob/2bb8423060308bbdea8ba468dabed4fc256d18ea/README.md#L12-L19) | Pin the wire payload to `v0.9.1`; do not silently accept v1.0-shaped messages. |
| ACP v2 | Draft; the maintainers say pieces can change and recommend version negotiation plus feature flags rather than production-by-default. [v2 draft announcement](https://github.com/agentclientprotocol/agent-client-protocol/blob/63d16e3bd638d0a0021aab75e4ebc29b7cc77c22/docs/announcements/acp-v2-draft.mdx#L57-L65) | Useful future direction, not the current baseline. |
| ACP remote transport | Stable ACP recommends newline-delimited JSON-RPC over stdio. Streamable HTTP is still labeled a draft, while custom transports are permitted. [v1 transport](https://github.com/agentclientprotocol/agent-client-protocol/blob/63d16e3bd638d0a0021aab75e4ebc29b7cc77c22/docs/protocol/v1/transports.mdx#L6-L27) | A2UI carriage does not standardize Weave's WebSocket hosting layer. Treat remote transport and A2UI as separate contracts. |

Two adjacent ACP proposals are not current solutions:

- [Embedded Views PR #1849](https://github.com/agentclientprotocol/agent-client-protocol/pull/1849) is open at this snapshot. It proposes immutable web resources rendered in a client-owned, opaque-origin sandbox with native ACP fallback. That is a web-bundle model, not A2UI's declarative catalog model, and it is not stable ACP.
- [`session/inject` PR #1261](https://github.com/agentclientprotocol/agent-client-protocol/pull/1261) is open at this snapshot. It proposes queued/steering input during a turn as part of v2 work. Stable v1 does not provide that operation.

## Why the composition works

A2UI is explicitly transport-agnostic. A conforming transport must provide ordered reliable delivery, message framing, metadata for capabilities and optional data-model synchronization, and an optional return channel for interactive actions. [A2UI transport contract](https://github.com/a2ui-project/a2ui/blob/2bb8423060308bbdea8ba468dabed4fc256d18ea/specification/v0_9_1/docs/a2ui_protocol.md#L80-L93)

Stable ACP v1 provides the pieces needed for that contract:

| A2UI need | Stable ACP v1 primitive | Remaining binding decision |
| --- | --- | --- |
| Ordered, framed server output | Ordered JSON-RPC connection plus `session/update` notifications | Define one A2UI array per embedded-resource content block and preserve notification order. |
| Typed data payload | `ContentBlock::Resource` with inline text, URI, and MIME type | Use `application/a2ui+json`; parse `resource.text` as a JSON array. |
| Capability/catalog negotiation | Capability-object `_meta` during `initialize` | Define a collision-resistant Weave profile and intersection rules. |
| Per-action metadata | Request `_meta` | Define where `a2uiClientDataModel`, an action ID, and binding version live. |
| Client action return channel | `session/prompt`, or a negotiated custom request whose method begins `_` | Choose turn-boundary or out-of-band semantics explicitly. |
| Replay/lifecycle | `session/load` replay plus implementation durability | Preserve/reconstruct complete A2UI surface state; `session/resume` alone does not replay. |
| Graceful fallback | Ordinary ACP content/update types | Always retain useful non-A2UI output. |

ACP content blocks are used in prompts, model output, and tool results, and deliberately share MCP's structure so tool output can be forwarded without transformation. [ACP content](https://github.com/agentclientprotocol/agent-client-protocol/blob/63d16e3bd638d0a0021aab75e4ebc29b7cc77c22/docs/protocol/v1/content.mdx#L6-L18) An embedded text resource carries `uri`, optional `mimeType`, and `text`; it requires `promptCapabilities.embeddedContext` only when sent **to** the agent in a prompt. [ACP embedded resources](https://github.com/agentclientprotocol/agent-client-protocol/blob/63d16e3bd638d0a0021aab75e4ebc29b7cc77c22/docs/protocol/v1/content.mdx#L104-L159) [Prompt capabilities](https://github.com/agentclientprotocol/agent-client-protocol/blob/63d16e3bd638d0a0021aab75e4ebc29b7cc77c22/docs/protocol/v1/initialization.mdx#L202-L218)

The A2UI project already uses exactly this media type and embedded-resource shape in its official MCP binding: clients detect `application/a2ui+json`, route it to an A2UI renderer, and should receive fallback text alongside dynamic UI. [A2UI over MCP](https://github.com/a2ui-project/a2ui/blob/2bb8423060308bbdea8ba468dabed4fc256d18ea/docs/public/guides/a2ui_over_mcp.md#L83-L95) [Dynamic results and fallback](https://github.com/a2ui-project/a2ui/blob/2bb8423060308bbdea8ba468dabed4fc256d18ea/docs/public/guides/a2ui_over_mcp.md#L162-L199) This makes embedded-resource carriage the least novel stable-v1 mapping.

## Proposed Weave profile on ACP v1

The JSON below is a **Weave-owned proposal**, not part of either upstream specification. Names and versions must be treated as a versioned product contract before implementation.

### 1. Negotiate capabilities during `initialize`

An A2UI-capable Weave client advertises its supported protocol and catalog IDs under the ACP capability object's `_meta`:

```json
{
  "protocolVersion": 1,
  "clientCapabilities": {
    "_meta": {
      "weave.dev": {
        "a2ui": {
          "bindingVersion": 1,
          "protocolVersions": ["v0.9.1"],
          "supportedCatalogIds": [
            "https://a2ui.org/specification/v0_9_1/catalogs/basic/catalog.json"
          ],
          "delivery": ["embedded-resource"],
          "actions": ["session-prompt"]
        }
      }
    }
  }
}
```

The agent or Portal responds in `agentCapabilities._meta["weave.dev"].a2ui` with the selected binding/protocol, the catalogs it will emit, whether it accepts data-model synchronization, and the enabled action mode:

```json
{
  "protocolVersion": 1,
  "agentCapabilities": {
    "promptCapabilities": {
      "embeddedContext": true
    },
    "_meta": {
      "weave.dev": {
        "a2ui": {
          "bindingVersion": 1,
          "protocolVersion": "v0.9.1",
          "catalogIds": [
            "https://a2ui.org/specification/v0_9_1/catalogs/basic/catalog.json"
          ],
          "delivery": "embedded-resource",
          "actions": "session-prompt",
          "acceptsDataModel": false
        }
      }
    }
  }
}
```

If there is no exact intersection, A2UI is disabled and only normal ACP output is sent. An agent must not set `actions: "session-prompt"` unless it also advertises `promptCapabilities.embeddedContext`.

ACP expressly allows `_meta` on all protocol types, forbids custom root fields, reserves `_`-prefixed JSON-RPC methods for extensions, and recommends advertising extensions in capability `_meta`. [ACP extensibility](https://github.com/agentclientprotocol/agent-client-protocol/blob/63d16e3bd638d0a0021aab75e4ebc29b7cc77c22/docs/protocol/v1/extensibility.mdx#L8-L43) [Extension methods and negotiation](https://github.com/agentclientprotocol/agent-client-protocol/blob/63d16e3bd638d0a0021aab75e4ebc29b7cc77c22/docs/protocol/v1/extensibility.mdx#L50-L134)

A2UI itself requires catalog negotiation. A catalog ID is an agreed identifier, conventionally URI-shaped but not a resource the client should fetch, and the server must emit a catalog the client understands. [A2UI catalog compatibility](https://github.com/a2ui-project/a2ui/blob/2bb8423060308bbdea8ba468dabed4fc256d18ea/specification/v0_9_1/docs/a2ui_protocol.md#L308-L318) The official A2A binding likewise advertises the supported protocol version and catalogs as capabilities. [A2UI capability example](https://github.com/a2ui-project/a2ui/blob/2bb8423060308bbdea8ba468dabed4fc256d18ea/specification/v0_9_1/docs/a2ui_extension_specification.md#L109-L139)

### 2. Send A2UI output as normal ACP message content

Use an `agent_message_chunk`, not a new session-update discriminator:

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "sess_abc",
    "update": {
      "sessionUpdate": "agent_message_chunk",
      "messageId": "msg_commit_summary",
      "content": {
        "type": "resource",
        "resource": {
          "uri": "a2ui://weave/sessions/sess_abc/surfaces/commit-summary/batches/1",
          "mimeType": "application/a2ui+json",
          "text": "[{\"version\":\"v0.9.1\",\"createSurface\":{\"surfaceId\":\"commit-summary\",\"catalogId\":\"https://a2ui.org/specification/v0_9_1/catalogs/basic/catalog.json\"}},{\"version\":\"v0.9.1\",\"updateComponents\":{\"surfaceId\":\"commit-summary\",\"components\":[{\"id\":\"root\",\"component\":\"Text\",\"text\":\"No changes\"}]}}]"
        },
        "_meta": {
          "weave.dev/a2ui": { "bindingVersion": 1 }
        }
      }
    }
  }
}
```

Binding rules:

- `resource.text` must decode to an array of A2UI v0.9.1 messages, matching the official A2UI binding's array and MIME conventions. Receivers process messages sequentially; the array is not transactional, and one invalid message does not cancel later messages. [A2UI data encoding](https://github.com/a2ui-project/a2ui/blob/2bb8423060308bbdea8ba468dabed4fc256d18ea/specification/v0_9_1/docs/a2ui_extension_specification.md#L170-L190)
- The resource URI is an opaque identity and is never dereferenced. Scope `surfaceId` to the ACP `sessionId` even though the A2UI payload itself contains only `surfaceId`.
- Use a fresh `messageId` for the logical generated UI message. ACP permits message chunks with the same ID to be grouped, but the A2UI batch itself should remain complete in one resource block unless the profile later defines cross-block framing. [ACP message chunks](https://github.com/agentclientprotocol/agent-client-protocol/blob/63d16e3bd638d0a0021aab75e4ebc29b7cc77c22/docs/protocol/v1/prompt-turn.mdx#L152-L169)
- Keep ordinary text and/or native ACP tool/plan output as the useful fallback. A non-A2UI client can display or ignore the resource without losing the conversation's meaning.
- Do not put the actual UI only in `_meta`: `_meta` is the binding/correlation layer, while the embedded resource is the displayable, replayable content.

### 3. Return actions at a turn boundary

For a click or form submission that should become the next user turn, send the A2UI action array as embedded context in `session/prompt`:

```json
{
  "jsonrpc": "2.0",
  "id": 42,
  "method": "session/prompt",
  "params": {
    "sessionId": "sess_abc",
    "prompt": [
      {
        "type": "resource",
        "resource": {
          "uri": "a2ui://weave/sessions/sess_abc/actions/action_01",
          "mimeType": "application/a2ui+json",
          "text": "[{\"version\":\"v0.9.1\",\"action\":{\"name\":\"open_diff\",\"surfaceId\":\"commit-summary\",\"sourceComponentId\":\"open-diff-button\",\"timestamp\":\"2026-08-26T10:00:00Z\",\"context\":{\"path\":\"src/main.ts\"}}}]"
        }
      }
    ],
    "_meta": {
      "weave.dev/a2ui": {
        "bindingVersion": 1,
        "actionId": "action_01"
      }
    }
  }
}
```

This requires the agent to advertise `promptCapabilities.embeddedContext`. It intentionally inherits ACP's turn response, cancellation, transcript, and `stopReason` semantics. The A2UI client event schema defines `name`, `surfaceId`, `sourceComponentId`, `timestamp`, and resolved `context`; it also defines renderer error events. [A2UI client event schema](https://github.com/a2ui-project/a2ui/blob/2bb8423060308bbdea8ba468dabed4fc256d18ea/specification/v0_9_1/json/client_to_server.json#L1-L98)

This mode is not suitable while another ACP prompt is active. Queue or disable the control until the turn completes. Do not retry an action automatically after an uncertain disconnect: `actionId` must be idempotent at the application boundary.

### 4. Use a custom request only when turn semantics are wrong

For actions that must be out-of-band, hidden from the conversational transcript, acknowledged without starting a model turn, or accepted while a turn is active, negotiate an ACP request such as:

```json
{
  "jsonrpc": "2.0",
  "id": "action_01",
  "method": "_weave.dev/a2ui/action",
  "params": {
    "sessionId": "sess_abc",
    "actionId": "action_01",
    "messages": [
      {
        "version": "v0.9.1",
        "action": {
          "name": "open_diff",
          "surfaceId": "commit-summary",
          "sourceComponentId": "open-diff-button",
          "timestamp": "2026-08-26T10:00:00Z",
          "context": { "path": "src/main.ts" }
        }
      }
    ]
  }
}
```

This is ACP-compliant extension traffic but not portable ACP behavior. It needs a defined result/error schema, authorization, idempotency, cancellation policy, and explicit routing through every intermediary. An unrecognized custom request receives JSON-RPC “Method not found”; an unrecognized custom notification is merely ignored. A request is preferable for user actions because it supplies an acknowledgement and failure signal. [ACP custom requests/notifications](https://github.com/agentclientprotocol/agent-client-protocol/blob/63d16e3bd638d0a0021aab75e4ebc29b7cc77c22/docs/protocol/v1/extensibility.mdx#L41-L109)

## Lifecycle, replay, and compatibility

A2UI is stateful. A surface must be created before updates; its `surfaceId` and `catalogId` are fixed until deletion; one component must eventually be `root`; and `deleteSurface` disposes it. [A2UI surface lifecycle](https://github.com/a2ui-project/a2ui/blob/2bb8423060308bbdea8ba468dabed4fc256d18ea/specification/v0_9_1/docs/a2ui_protocol.md#L173-L186) [Delete and stream example](https://github.com/a2ui-project/a2ui/blob/2bb8423060308bbdea8ba468dabed4fc256d18ea/specification/v0_9_1/docs/a2ui_protocol.md#L264-L291)

Map that lifecycle onto ACP as follows:

- The ownership key is `(ACP sessionId, A2UI surfaceId)`. Reject an action or update that crosses sessions or refers to a deleted/unknown surface.
- Apply batches in durable ACP event order. On replay, deduplicate by the transport event ID/sequence when available and never repeat action side effects.
- ACP `session/load` requires the agent to replay the conversation as `session/update`; `session/resume` restores the session without replay. [ACP load](https://github.com/agentclientprotocol/agent-client-protocol/blob/63d16e3bd638d0a0021aab75e4ebc29b7cc77c22/docs/protocol/v1/session-setup.mdx#L104-L178) [ACP resume](https://github.com/agentclientprotocol/agent-client-protocol/blob/63d16e3bd638d0a0021aab75e4ebc29b7cc77c22/docs/protocol/v1/session-setup.mdx#L213-L243) A renderer attaching through resume alone needs a persisted derived surface snapshot or a subsequent authoritative reload.
- A compacted journal cannot reconstruct a surface if its `createSurface` or foundational component/data updates have expired. Before interactive production use, persist a validated surface snapshot/checkpoint or guarantee full authoritative replay after a gap.
- ACP's prompt `stopReason` completes the turn. Do not invent an A2UI completion meaning. Surface lifetime may span turns and ends only by explicit deletion, session close, or renderer disposal.
- An A2UI-ignorant ACP client must still receive a coherent transcript. Generated UI should be additive, and core ACP permission, elicitation, tool, plan, terminal, and diff semantics must remain available.

## Current Weave seams

The embedded-resource profile fits the existing clean Portal path better than a custom agent notification:

- Alpha pins ACP SDK 1.4.0, at [package.json](../../product/alpha/package.json#L15), preserves `ContentBlock[]` in transcript messages, and renders all five stable v1 variants. Its embedded-resource renderer currently displays text in a `<pre>`, so MIME-based A2UI routing belongs at [content-block-view.tsx](../../product/alpha/src/chat/content-block-view.tsx#L64) without changing ACP parsing.
- Alpha currently initializes with fixed ordinary ACP capabilities and no capability `_meta`, at [acp-client.ts](../../product/alpha/src/chat/acp-client.ts#L168). It would need to advertise the proposed A2UI client capability and refuse rendering unless the agent/Portal selects it.
- Portal initializes the provider once with fixed capabilities before a browser attachment initializes, at [provider-protocol.ts](../../product/portal/src/provider-protocol.ts#L6) and [thread-runtime.ts](../../product/portal/src/thread-runtime.ts#L125). A downstream `initialize` is answered later from that cached upstream result plus Portal's capabilities, rather than forwarding downstream capabilities, at [thread-runtime.ts](../../product/portal/src/thread-runtime.ts#L238). Portal therefore cannot blindly relay the first attached renderer's catalog support upstream. It must act as the capability broker: advertise only the catalog/profile it can safely mediate, while tracking and persisting capabilities per attachment.
- Portal journals only `session/update`, adds monotonic event identity, and replays those updates. Other agent notifications are live fan-out, at [thread-runtime.ts](../../product/portal/src/thread-runtime.ts#L573). This is the decisive reason to carry A2UI in normal message content rather than a custom server notification.
- Portal currently permits one active prompt and rejects a concurrent prompt, at [thread-runtime.ts](../../product/portal/src/thread-runtime.ts#L360). Turn-boundary actions must be queued/disabled; the custom action request requires a new explicitly authorized forwarding route because Portal currently forwards only two fixed attachment request methods, at [thread-runtime.ts](../../product/portal/src/thread-runtime.ts#L68) and [thread-runtime.ts](../../product/portal/src/thread-runtime.ts#L383).
- The journal retains 10,000 events and records a compaction watermark, at [thread-journal.ts](../../product/portal/src/thread-journal.ts#L23) and [thread-journal.ts](../../product/portal/src/thread-journal.ts#L126). A2UI needs a surface checkpoint strategy for `RESUME_GAP`; replaying only post-watermark deltas is not sufficient.
- Weave already has the appropriate naming and capability pattern under `weave.dev` and `_weave.dev/...`, at [product protocol](../../product/protocol/src/index.ts#L5) and [acp-extension.ts](../../product/portal/src/acp-extension.ts#L21).

Tool-call content is another narrow interception point because [ToolCallView](../../product/alpha/src/chat/tool-call-view.tsx#L27) delegates content items to the same `ContentBlockView`. However, completed tool calls are collapsed by default, at [tool-call-view.tsx](../../product/alpha/src/chat/tool-call-view.tsx#L78). For the first visible generated pane, the agent should therefore project the A2UI resource into a normal agent message even if an MCP tool originally produced it; the tool output may retain its own resource as provenance.

Multiple Alpha clients may attach to one Portal thread. A sender cannot tailor a single provider update to one renderer after the fact. For a first implementation, Portal should expose one canonical, allowlisted A2UI catalog and ensure every A2UI resource also has a useful ACP fallback. Clients without the capability render the fallback or the existing generic resource view.

## Security requirements

“Declarative” reduces risk relative to executing generated code, but it is not an authorization or validation boundary. A production profile should require all of the following:

- Validate every envelope against the exact negotiated A2UI version and every component/function against an allowlisted, locally installed catalog **before** journaling or rendering it. A2UI v0.9 is prompt-first and explicitly requires robust post-generation validation. [A2UI v0.9 validation warning](https://github.com/a2ui-project/a2ui/blob/2bb8423060308bbdea8ba468dabed4fc256d18ea/specification/v0_9_1/docs/a2ui_protocol.md#L31-L40)
- Never fetch arbitrary code or catalog definitions from `catalogId`; it is an identifier, not a resolvable URL. Disable inline/dynamic catalogs for the initial profile.
- Bound batch bytes, batch length, surfaces per session, components per surface, string sizes, reference depth/cycles, data-model size, update rate, and renderer work. Reject malformed component graphs before they reach React.
- Allowlist URL/media schemes and origins, sanitize Markdown, and exclude arbitrary HTML, script, iframe, webview, and custom code execution from the initial catalog.
- Keep Weave chrome, identity, permissions, authentication, elicitation, and destructive confirmations outside agent-authored surfaces. Generated UI must be visibly agent-authored and must not impersonate native permission controls.
- Treat an A2UI action as untrusted user intent. Validate it server-side, bind it to the owning session/surface/component, re-authorize every side effect, and use ACP's normal permission path where applicable. A2UI's client-side checks are UX validation, not data-integrity enforcement. [A2UI action validation](https://github.com/a2ui-project/a2ui/blob/2bb8423060308bbdea8ba468dabed4fc256d18ea/docs/public/concepts/actions.md#L63-L68)
- Default `sendDataModel` to false. When enabled it sends the entire surface data model with actions, which may expose secrets or unrelated state. Redact, size-limit, and scope it to the owning agent/session. [A2UI data-model sync](https://github.com/a2ui-project/a2ui/blob/2bb8423060308bbdea8ba468dabed4fc256d18ea/docs/public/concepts/actions.md#L177-L200)
- Give actions stable idempotency IDs and do not automatically retry after disconnection or an uncertain prompt result.

## Alternatives and future evolution

### A2UI through MCP connected to an ACP agent

An MCP server can return A2UI in an embedded resource, and ACP deliberately shares MCP's content-block structure. That is useful when UI originates from a tool. It does **not** guarantee that an arbitrary ACP agent will transparently forward that resource to its ACP client or preserve its MIME metadata; the agent or Portal still needs an A2UI-aware adapter and capability agreement.

The ACP [MCP-over-ACP RFD](https://github.com/agentclientprotocol/agent-client-protocol/blob/63d16e3bd638d0a0021aab75e4ebc29b7cc77c22/docs/rfds/mcp-over-acp.mdx#L37-L106) multiplexes an MCP server connection through ACP. It changes how the agent reaches MCP tools, not how an ACP client negotiates or renders A2UI. ACP's current documentation lists it under [Draft](https://github.com/agentclientprotocol/agent-client-protocol/blob/63d16e3bd638d0a0021aab75e4ebc29b7cc77c22/docs/docs.json#L181-L201), so it should not be confused with an A2UI binding.

### Custom server notification

Stable ACP allows `_`-prefixed notifications, so `_weave.dev/a2ui/update` is syntactically possible. It is a poor primary Weave carrier today because unrecognized clients ignore it and current Portal does not journal arbitrary notifications. Use it only for derived, disposable live signals; keep canonical UI state in replayable `session/update` content.

### ACP v2 custom content blocks

Draft ACP v2 allows custom content-block types beginning with `_`, so a future `_weave.dev/a2ui` block could eliminate the embedded-resource wrapper. [v2 custom content](https://github.com/agentclientprotocol/agent-client-protocol/blob/63d16e3bd638d0a0021aab75e4ebc29b7cc77c22/docs/protocol/v2/content.mdx#L14-L20) That is cleaner only after v2 stabilizes and Weave supports v1 and v2 side by side. The MIME resource profile remains the interoperable v1 fallback.

### Embedded Views

If ACP Embedded Views stabilizes, it may serve applications that require a bundled web UI. A2UI remains useful when Weave wants native components, a narrow allowlisted catalog, deterministic theme integration, and no remote code. Both models should preserve a canonical native ACP fallback.

## Recommended delivery sequence

1. **Read-only proof:** define `weave.dev.a2ui` binding v1; install one pinned A2UI v0.9.1 renderer and one Weave-owned allowlisted catalog; render a commit-summary body inside existing Weave chrome; accept only `createSurface`, `updateComponents`, `updateDataModel`, and `deleteSurface`; retain text fallback.
2. **Durability:** validate on ingress, journal resource blocks, derive/persist surface checkpoints, test reconnect/replay/compaction gaps, and test mixed A2UI/non-A2UI attachments.
3. **Turn-boundary actions:** add `session-prompt` actions only for idle sessions with `embeddedContext`, action IDs, server-side authorization, and uncertain-delivery behavior.
4. **Out-of-band actions if justified:** add `_weave.dev/a2ui/action` only after defining routing, acknowledgement, cancellation, permission, and replay semantics. Do not wait for or emulate `session/inject`.
5. **Track upstream:** revisit ACP v2, Embedded Views, MCP-over-ACP, and remote transport when they stabilize; upstream an A2UI binding proposal only after the Weave profile has interoperability evidence.

## Conclusion

The exact answer is **yes by composition, no as a standardized ACP feature**. Stable ACP v1 already offers the safest carrier—an `application/a2ui+json` embedded resource in a normal agent message—and the right negotiation hooks. The blockers are not JSON transport; they are bilateral agent support, catalog negotiation, action semantics, replay/checkpointing, multi-client brokering, and security. Those are tractable in Weave without adopting draft ACP surfaces, provided the first slice is additive and read-only.
