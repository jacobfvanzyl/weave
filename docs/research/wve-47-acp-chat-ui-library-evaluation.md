# WVE-47: ACP chat UI library evaluation

**Status:** Decision-ready research
**Checked:** 2026-08-24
**Scope:** Alpha's main chat pane. This does not select or change Portal's transport, persistence, recovery, filesystem, or terminal implementation.

## Decision

Do **not** put another conversation runtime between Alpha and ACP.

Use this rendering stack:

1. a Weave-owned ACP transcript reducer and view model;
2. the official shadcn `MessageScroller`, `Message`, `Bubble`, `Attachment`, and `Marker` primitives for the transcript shell;
3. Streamdown for streamed Markdown;
4. selected, source-owned AI Elements components for agent-specific surfaces such as tools, plans, confirmations, terminal output, and code artifacts, adapted to Weave's ACP view-model types rather than Vercel AI SDK types.

This is a composable rendering stack rather than an all-in-one chat runtime. It gives Alpha the strongest ACP fidelity, stays aligned with its Base UI/shadcn design system, remains fully mockable, and avoids translating durable ACP state into a second protocol-shaped message model.

The best packaged runtime among the alternatives is assistant-ui's `ExternalStoreRuntime`. It should be the fallback only if implementation shows that Weave is rebuilding valuable generic runtime behavior such as branching, edit/regenerate semantics, or message action orchestration. It should not be Alpha's starting point.

## Why ACP changes the library choice

ACP's wire envelope is JSON-RPC, but the payload is not just a list of chat messages. The current stable-v1 schema has three distinct UI-facing channels.

### 1. Session updates

`session/update` carries a discriminated `SessionUpdate` union. The current SDK schema defines fifteen variants:

- transcript content: `user_message_chunk`, `agent_message_chunk`, `agent_thought_chunk`;
- durable activity: `tool_call`, `tool_call_update`, `plan`, `plan_update`, and `plan_removed`;
- session and composer state: `available_commands_update`, `current_mode_update`, `config_option_update`, `session_info_update`, `usage_update`.
- context lifecycle: `compaction_update` and `compaction_summary_chunk`.

Content chunks can include a stable `messageId`, which is the correct identity for coalescing streamed chunks. A content block can be text, image, audio, resource link, or embedded resource. ACP recommends Markdown rendering for text. Tool calls have independent `toolCallId` identity and incremental updates; their content can be a normal content block, a diff, or an embedded terminal. Plan updates replace the complete plan rather than appending a message. These details come from the pinned [stable-v1 schema snapshot](https://github.com/agentclientprotocol/agent-client-protocol/blob/e0e07cdeacefd019a46d867dd24ffd963c430e7c/schema/v1/schema.json) and the [ACP prompt-turn documentation](https://agentclientprotocol.com/protocol/prompt-turn).

### 2. Agent-to-client requests

Permissions are `session/request_permission` JSON-RPC requests correlated with a tool call, not message parts. The current schema also defines `elicitation/create` for form- or URL-based structured input. These require interactive rows or overlays plus a request/response callback owned by the ACP client. They cannot safely be reduced to assistant prose. See [ACP tool-call permissions](https://agentclientprotocol.com/protocol/tool-calls#requesting-permission) and the pinned [`CreateElicitationRequest` schema](https://github.com/agentclientprotocol/agent-client-protocol/blob/e0e07cdeacefd019a46d867dd24ffd963c430e7c/schema/v1/schema.json).

### 3. Client capabilities and lifecycle

Filesystem and terminal operations are separate client-side protocol methods. Prompt completion returns a `stopReason`. Unknown `_meta` values must be preserved without assuming their meaning. These belong to the session controller and Portal integration even when the pane presents their results.

The implication is straightforward: a library whose canonical state is `Message[]` cannot represent ACP without a lossy or synthetic projection. Alpha first needs an ACP-native reducer that can emit transcript rows, ambient session state, and pending interactive requests separately.

## Required ACP-to-UI mapping

| ACP surface | Alpha view-model target | Main-pane treatment |
| --- | --- | --- |
| `user_message_chunk` | user content row keyed by `messageId` | Zed-like user block; text and attachments |
| `agent_message_chunk` | agent content row keyed by `messageId` | streamed Markdown and rich content blocks |
| `agent_thought_chunk` | reasoning row keyed by `messageId` | collapsible thinking/activity treatment |
| `tool_call` | tool row keyed by `toolCallId` | title, kind, state, locations, input/output |
| `tool_call_update` | patch the matching tool row | preserve identity; replace collection fields as ACP specifies |
| Tool `content` | typed child content | Markdown/media/resource rendering |
| Tool `diff` | diff child | dedicated diff renderer |
| Tool `terminal` | terminal child keyed by terminal ID | existing Portal terminal surface, embedded in activity |
| `plan` | current plan row/state | replace the full plan; show entry status and priority |
| `available_commands_update` | composer command state | slash-command picker, not a synthetic chat message |
| mode/config updates | session control state | composer/bottom-rail controls |
| info/usage updates | session metadata | title/status/context or cost affordances |
| `session/request_permission` | pending request keyed by JSON-RPC request and tool ID | inline confirmation actions; response stays in ACP client |
| `elicitation/create` | pending form or URL request | structured form/link UI; response stays in ACP client |
| prompt `stopReason` | turn lifecycle state | stop/error/cancel/end treatment |
| unknown update or `_meta` | raw preserved event | generic diagnostic fallback, never silently dropped |

## What the reference clients actually use

### T3Code

The local T3Code reference was inspected at [`e9f50c3`](https://github.com/pingdotgg/t3code/commit/e9f50c3efcb02a199042364ead292e164274e716), app version `0.0.33`.

T3Code does not use assistant-ui, Vercel AI SDK UI, or another packaged chat runtime. It owns a product-specific timeline and combines:

- [`@legendapp/list` 3.3.5](https://www.legendapp.com/open-source/list/v3/react/getting-started/) for a virtualized DOM-native timeline;
- [`react-markdown` 10.1.0](https://github.com/remarkjs/react-markdown) plus remark/rehype plugins;
- [`@pierre/diffs` 1.3.0-beta.10](https://github.com/pierrecomputer/pierre) for diff rendering;
- bespoke scroll anchoring, minimap, work/tool grouping, plan, composer, and timeline-row logic.

Its fixed source snapshot shows the custom [`MessagesTimeline`](https://github.com/pingdotgg/t3code/blob/e9f50c3efcb02a199042364ead292e164274e716/apps/web/src/components/chat/MessagesTimeline.tsx), [`MessagesTimeline.logic`](https://github.com/pingdotgg/t3code/blob/e9f50c3efcb02a199042364ead292e164274e716/apps/web/src/components/chat/MessagesTimeline.logic.ts), and [`ChatMarkdown`](https://github.com/pingdotgg/t3code/blob/e9f50c3efcb02a199042364ead292e164274e716/apps/web/src/components/ChatMarkdown.tsx). Locally, those files are approximately 2,727, 1,153, and 1,927 lines respectively. Its row union distinguishes messages, grouped and live work, folds, proposed plans, turn plans, and working state.

The useful lesson is its architecture, not code to copy: high-quality coding-agent chat converges on a typed timeline rather than a generic human-chat message list. The cost of building every scroll and rendering primitive itself is substantial.

### Legacy Weave clients

The legacy shared client uses `@assistant-ui/react`, `@assistant-ui/react-ai-sdk`, `@ai-sdk/react`, and `ai`, with current lock resolutions of assistant-ui `0.14.26` and AI SDK React `3.0.226`. Its [`AssistantChat.tsx`](../../packages/client/src/components/chat/AssistantChat.tsx) is approximately 3,251 lines and adds custom rendering for Markdown, reasoning, tools, plans, images, compaction, approvals, timing, composer controls, and scroll behavior. [`rpc-chat-transport.ts`](../../packages/client/src/lib/rpc-chat-transport.ts) bridges a Weave RPC transport into assistant-ui's AI SDK runtime.

That implementation proves assistant-ui can be customized deeply, but it also demonstrates the risk for the clean product stack: ACP/Portal state would be converted into AI SDK messages and then normalized again by assistant-ui. Reload handling already has to tolerate assistant-ui changing persisted part shapes and merging adjacent assistant content. The library did not remove the need for an application-specific timeline; it added another state and conversion boundary around it.

### Alpha today

Alpha currently has the opposite problem. [`portal-client.ts`](../../product/alpha/src/portal-client.ts) flattens each `session/update` into:

```ts
type ConversationItem = {
  id: string
  role: 'user' | 'agent' | 'tool' | 'system'
  text: string
  append?: boolean
}
```

The fallback extracts `content.text`, `title`, or the update kind. This discards ACP `messageId`, structured content blocks, tool identity and update semantics, plan replacement, commands, modes, config, usage, session info, `_meta`, and interactive requests. The first chat-pane implementation step must therefore replace this flattening seam with the ACP-native reducer. Changing visual components before that would bake data loss into the new UI.

## Candidate evaluation

Versions and repository snapshots below were checked on 2026-08-24. Scores are relative to Alpha's direct-ACP architecture, not general-purpose chatbot quality.

| Candidate | ACP fidelity | Transport independence | Zed/shadcn fit | Agent-specific surfaces | Main cost | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| shadcn chat primitives + Weave reducer | Excellent | Excellent | Excellent | Must compose specialized rows | We own the view model and row renderers | **Adopt** |
| AI Elements source components | Good after retargeting types | Good if `useChat` is not adopted | Excellent | Excellent | AI SDK-shaped types and Lucide assumptions | **Use selectively** |
| assistant-ui `ExternalStoreRuntime` | Good through projection | Good | Fair; brings its own runtime and Radix dependencies | Excellent | Second message/runtime model; pre-1.0 churn | Reserve as fallback |
| AI SDK UI runtime | Good through projection | Custom transport possible | Good | Excellent | Duplicates ACP transport and state machine | Reject runtime |
| T3Code-style bespoke + LegendList | Excellent | Excellent | Excellent | Whatever we build | Very high implementation/maintenance cost | Borrow patterns only |
| CopilotKit | Fair through ACP-to-AG-UI bridge | Poor for this architecture | Customizable | Excellent | Adds AG-UI and usually a runtime/proxy | Reject |
| Stream Chat React | Poor | Poor; Channel/Stream backend model | Customizable | Human-chat focused | Proprietary source license and backend coupling | Exclude |
| Chatscope | Poor | Excellent | Poor | Human-chat primitives only | Most ACP UI remains custom | Reject |

### Official shadcn chat primitives

The June 2026 shadcn chat components are unusually well aligned with ACP. The official [`MessageScroller`](https://ui.shadcn.com/docs/components/base/message-scroller) explicitly owns transcript scroll behavior without owning messages, AI state, transport, persistence, branching, or model state. It supports stable row IDs, turn-independent anchors, streamed growth, saved transcript restoration, prepended history, jump-to-message, visibility, keyboard access, and a live-region transcript. Its documented performance target is hundreds to low thousands of rich turns, using imperative scroll state and `content-visibility` while keeping rows in the DOM.

The companion [`Message`](https://ui.shadcn.com/docs/components/base/message), `Bubble`, `Attachment`, and `Marker` components are source-owned layout primitives. They match Alpha's existing shadcn/Base UI direction and allow ACP rows—not a library message type—to be their children. This is the most important distinction in the comparison.

### Vercel AI Elements

AI Elements `1.9.0` at [`6a9d5b18`](https://github.com/vercel/ai-elements/commit/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd) provides the strongest ready-made catalog of agent surfaces. Relevant components include [message](https://elements.ai-sdk.dev/components/message), [tool](https://elements.ai-sdk.dev/components/tool), plan, reasoning, confirmation, terminal, code block, file tree, task, checkpoint, test results, and artifacts.

Its components are installed as application-owned shadcn-style source. That is attractive, but the official tool API is typed around the AI SDK's `ToolUIPart` state machine, examples use `useChat`, and icons assume Lucide. Alpha should copy only selected renderers and replace their public types with its own ACP view model and their icons with Hugeicons. It should not add AI SDK UI as the state authority.

### assistant-ui

assistant-ui `0.15.16` at [`dcf6d51d`](https://github.com/assistant-ui/assistant-ui/commit/dcf6d51dce910559caee9d04b3afa373894af128) is the best complete runtime candidate. Its [`ExternalStoreRuntime`](https://www.assistant-ui.com/docs/runtimes/custom/external-store) lets an application own persistence and synchronization, and its message primitives cover text, image, file, reasoning, sources, tools, generative UI, and named data parts. Tool rendering and approvals are mature.

The mismatch is structural. Weave must convert its typed ACP timeline into `ThreadMessageLike`; plans, permissions, elicitation, and session updates become data parts or state outside the runtime. The documented external message converter merges adjacent assistant messages by default, and even with `joinStrategy: "none"` assistant-ui remains another identity, branching, queue, and thread model. Its current package also introduces Radix dependencies beside Alpha's Base UI stack. This is a reasonable trade if Alpha later needs its generic runtime features, but it is not justified for initial rendering.

### Vercel AI SDK UI

AI SDK UI has a rich [`UIMessage`](https://ai-sdk.dev/docs/reference/ai-sdk-core/ui-message) part model and supports a [custom chat transport](https://ai-sdk.dev/docs/ai-sdk-ui/transport). A custom ACP transport is technically possible. It would still translate Portal's journal and JSON-RPC lifecycle into Vercel's message-stream state machine, while Weave already owns reconnection, fan-out, rehydration, and session state. Use individual AI Elements renderers without adopting this runtime.

### CopilotKit

CopilotKit `1.69.0` at [`4c975dad`](https://github.com/CopilotKit/CopilotKit/commit/4c975dad4983a78dc3a34418afe8fd34931480b8) offers headless and composed tool, reasoning, activity, custom-message, and human-in-the-loop rendering. However, CopilotKit is built around [AG-UI](https://docs.copilotkit.ai/agent-spec/backend/ag-ui): messages, state, tools, and lifecycle are AG-UI events, normally routed through its runtime over HTTP/SSE. Adopting it would require an ACP-to-AG-UI bridge and introduce the additional protocol boundary the new stack is trying to avoid.

### Stream Chat React and Chatscope

Stream Chat React has mature lists, media, threads, reactions, unread state, and virtualization, but its [`MessageList`](https://getstream.io/chat/docs/sdk/react/components/core-components/message-list/) consumes Stream `Channel` state and the source [license](https://github.com/GetStream/stream-chat-react/blob/master/LICENSE) restricts use to Stream customers and its API. It is not suitable for an open-source direct-ACP client.

[Chatscope](https://chatscope.io/docs/) is MIT and transport-neutral, but its value is ordinary human-chat chrome. Reasoning, plans, tools, permissions, terminal output, diffs, locations, and ACP extension events would all remain bespoke. Alpha already has a better primitive system.

## Recommended architecture

```text
ACP JSON-RPC and Portal journal
              |
              v
      AcpTranscriptReducer
      - preserves raw payloads and _meta
      - coalesces chunks by messageId
      - patches tools by toolCallId
      - replaces plans atomically
      - separates ambient state and pending requests
              |
              v
          ChatPaneModel
      +----------------------+----------------------+------------------+
      | transcript rows      | session/composer     | pending requests |
      | messages/thoughts    | mode/config/commands | permissions      |
      | tools/plans/markers  | usage/turn lifecycle | elicitations     |
      +----------------------+----------------------+------------------+
              |
              v
 shadcn MessageScroller + Alpha-owned row renderers
              |
      +-------+---------+----------------+
      | Streamdown      | AI Elements    | Portal surfaces
      | streamed text   | adapted tools  | terminal/files/diffs
      | and code        | plans/confirm  | via typed callbacks
      +-----------------+----------------+---------------
```

The reducer should live behind a fixture-friendly interface. The entire pane can then be mocked with recorded or handcrafted ACP events, including reconnect and replay sequences, without a live Host. Renderers receive typed view data and callbacks; they never send JSON-RPC directly.

## Implementation sequence

1. Define the lossless ACP event and `ChatPaneModel` unions in the clean product protocol/client boundary.
2. Implement and unit-test a pure reducer with fixtures for all fifteen session updates, rich content, tool updates, whole-plan replacement, permissions, elicitation, unknown extensions, replay, and optimistic-echo deduplication.
3. Replace Alpha's `ConversationItem` flattening with reducer dispatch while leaving the existing mock/live switch intact.
4. Add the official shadcn chat primitives and render user/agent text rows first.
5. Add Streamdown with safe links and streaming/incomplete-Markdown tests.
6. Adapt AI Elements-style reasoning, tool, plan, and confirmation views to ACP types; do not expose `UIMessage` or `ToolUIPart` outside copied implementation details.
7. Reuse the existing product terminal/filesystem capabilities through typed callbacks and add dedicated diff/resource renderers.
8. Profile long restored threads. Start with `MessageScroller`; introduce LegendList behind the row-view boundary only if real transcripts exceed its documented comfortable range or profiling shows a paint/memory problem.
9. Re-evaluate assistant-ui only if a concrete missing generic behavior is expensive enough to justify a second runtime model.

## Acceptance implications

The first chat-pane milestone should prove more than visual parity:

- a fixture can render every stable ACP update and request shape without a Host;
- live and rehydrated transcripts produce the same `ChatPaneModel`;
- chunk and tool identities survive reconnect and replay;
- plan replacement, permission responses, and elicitation are not represented as fake prose;
- unknown extensions remain visible through a generic fallback and preserved raw data;
- scrolling does not steal the reader's position during streaming or history prepend;
- no dependency in the chat pane owns ACP transport, thread persistence, terminal, or filesystem execution.

## Source index

- [ACP stable-v1 schema snapshot](https://github.com/agentclientprotocol/agent-client-protocol/blob/e0e07cdeacefd019a46d867dd24ffd963c430e7c/schema/v1/schema.json)
- [ACP prompt turn](https://agentclientprotocol.com/protocol/prompt-turn)
- [ACP tool calls](https://agentclientprotocol.com/protocol/tool-calls)
- [shadcn chat components announcement](https://ui.shadcn.com/docs/changelog/2026-06-chat-components)
- [shadcn MessageScroller](https://ui.shadcn.com/docs/components/base/message-scroller)
- [AI Elements usage](https://elements.ai-sdk.dev/docs/usage)
- [AI Elements message](https://elements.ai-sdk.dev/components/message)
- [AI Elements tool](https://elements.ai-sdk.dev/components/tool)
- [Streamdown](https://github.com/vercel/streamdown/blob/main/packages/streamdown/README.md)
- [assistant-ui ExternalStoreRuntime](https://www.assistant-ui.com/docs/runtimes/custom/external-store)
- [assistant-ui message primitives](https://www.assistant-ui.com/docs/primitives/message)
- [AI SDK UI custom transport](https://ai-sdk.dev/docs/ai-sdk-ui/transport)
- [CopilotKit AG-UI connection](https://docs.copilotkit.ai/agent-spec/backend/ag-ui)
- [Stream Chat React MessageList](https://getstream.io/chat/docs/sdk/react/components/core-components/message-list/)
- [Chatscope docs](https://chatscope.io/docs/)
