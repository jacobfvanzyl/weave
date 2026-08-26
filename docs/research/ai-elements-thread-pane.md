# AI Elements coverage for the Alpha Thread Pane

_Research snapshot: 2026-08-26. First-party Vercel documentation and source only. No packages or skills were installed._

## Conclusion

This note is the detailed component/surface follow-on to the existing [WVE-47 ACP chat UI library decision](./wve-47-acp-chat-ui-library-evaluation.md). That decision is not reopened here: Alpha keeps its Weave-owned ACP transcript reducer, official shadcn transcript shell, and selected source-owned AI Elements renderers. AI Elements does not become a conversation runtime or transport.

AI Elements is a strong fit for the Thread Pane as source-owned presentation and interaction building blocks. Its shadcn registry copies component source into the application, and Vercel explicitly treats that ownership and customization as part of the design. The current ACP transcript reducer remains authoritative because AI Elements' richer components are typed around AI SDK v6 `UIMessage`, `ToolUIPart`, `FileUIPart`, and `LanguageModelUsage`, not Agent Client Protocol events. ([official usage and ownership](https://elements.ai-sdk.dev/docs/usage), [current message source](https://github.com/vercel/ai-elements/blob/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/packages/elements/src/message.tsx), [current tool source](https://github.com/vercel/ai-elements/blob/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/packages/elements/src/tool.tsx))

The best initial substitutions are:

1. `MessageResponse` for streaming Markdown rendering.
2. `Reasoning` for thought chunks.
3. The `PromptInput` compound-component structure for the composer, while retaining Alpha's exact colors, typography, spacing, row behavior, configuration controls, and send/stop treatment.
4. `Context` behind the existing compact context-usage trigger.
5. `Tool`, `Plan`, `Confirmation`, `Question`, and `Attachments` as visual shells only where an ACP adapter can preserve the richer protocol semantics.

Do **not** replace the ACP transcript, tool-permission model, plan model, general elicitation form, compaction marker, diagnostics, or current composer configuration model with AI SDK-shaped state. Those are product behavior, not replaceable presentation primitives.

There is one important integration caveat. AI Elements' current reference project uses Radix-backed shadcn components, Lucide icons, and several `asChild` composition calls; Alpha uses the `base-mira` Base UI style and Hugeicons. React 19 and Tailwind 4 line up, but a registry install is not enough evidence that each component will compile and behave correctly against Alpha's Base UI wrappers. Adopt one component at a time, inspect the generated diff, translate Radix `asChild` composition to Base UI `render` composition where necessary, replace Lucide icons, and run focused rendered tests. This is an inference from the official source and Alpha's checked-in `components.json`, not an incompatibility statement made by Vercel. ([AI Elements setup requirements](https://elements.ai-sdk.dev/docs/setup), [upstream shadcn configuration](https://github.com/vercel/ai-elements/blob/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/packages/shadcn-ui/components.json), [upstream Radix-backed Collapsible](https://github.com/vercel/ai-elements/blob/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/packages/shadcn-ui/components/ui/collapsible.tsx), [Alpha shadcn configuration](../../product/alpha/components.json))

## What AI Elements actually is

AI Elements is both a component catalog and a custom shadcn registry. The CLI is a thin wrapper around `shadcn add`; it resolves requested names to `https://elements.ai-sdk.dev/api/registry/<component>.json`. The official setup also exposes the namespaced shadcn form `npx shadcn@latest add @ai-elements/message`. Components land in the configured component directory, normally `@/components/ai-elements/`, and are then application-owned source. ([CLI implementation](https://github.com/vercel/ai-elements/blob/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/packages/cli/index.js), [setup guide](https://elements.ai-sdk.dev/docs/setup), [usage and customization](https://elements.ai-sdk.dev/docs/usage))

The inspected upstream head is [`6a9d5b1`](https://github.com/vercel/ai-elements/tree/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd), dated 2026-08-21. It contains 49 component source files and the CLI package reports version `1.9.0`. The current setup guide specifies React 19, Next.js 14+, AI SDK, shadcn/ui, and Tailwind CSS 4. The component package itself uses React 19.2, AI SDK 6, Streamdown, and component-specific dependencies such as Shiki, `use-stick-to-bottom`, `tokenlens`, `media-chrome`, `react-jsx-parser`, and React Flow. ([component package manifest](https://github.com/vercel/ai-elements/blob/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/packages/elements/package.json), [CLI manifest](https://github.com/vercel/ai-elements/blob/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/packages/cli/package.json), [setup guide](https://elements.ai-sdk.dev/docs/setup))

Vercel's stated component principles are composability, small APIs, accessibility, streaming performance, AI SDK alignment, CSS-variable theming, and source ownership in the shadcn tradition. The docs claim a WCAG 2.1 AA baseline, semantic HTML, ARIA, keyboard navigation, and screen-reader support. Treat that as the intended baseline, then verify the exact adopted composition in Alpha; for example, the current `ConversationScrollButton` renders an icon-only button without an accessible name unless the caller supplies one. ([official philosophy](https://elements.ai-sdk.dev/docs/philosophy), [official benefits](https://elements.ai-sdk.dev/docs/benefits), [conversation source](https://github.com/vercel/ai-elements/blob/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/packages/elements/src/conversation.tsx))

## Current Alpha Thread Pane surface

Alpha currently has five presentation layers and one protocol-owned state layer:

| Surface | Current Alpha behavior | Product behavior that must survive |
| --- | --- | --- |
| Scroll container | shadcn-native `MessageScroller`, item anchors, scroll-to-end button, auto-scroll, content visibility | User scroll position, reliable streaming follow, explicit user-message anchors, long-thread performance |
| Messages and parts | User/assistant alignment, Alpha bubbles, Markdown, thoughts, images, audio, resource links, embedded text/binary resources | Existing thread visual language, ACP block order, adjacent text coalescing, mixed content |
| Agent activity | Tool calls, raw input/output, locations, diffs, terminal references, multi-option permissions, plans, compaction, diagnostics | Exact ACP status and response semantics |
| Elicitation | Schema-driven forms plus URL-mode requests | ACP validation, accepted/declined/cancelled/completed lifecycle, all supported field types |
| Composer | Frameless compact textarea, two-to-eight rows, Enter/Shift+Enter, modes, arbitrary config options, context usage, send/stop | Existing composer appearance and interaction, ACP cancellation, mobile blur, future command/context affordances |
| State | `AcpTranscript` reduced from journal/session events | Replay, optimistic reconciliation, split-chunk ordering, session truth |

The relevant local sources are [`chat-pane.tsx`](../../product/alpha/src/chat/chat-pane.tsx), [`content-block-view.tsx`](../../product/alpha/src/chat/content-block-view.tsx), [`tool-call-view.tsx`](../../product/alpha/src/chat/tool-call-view.tsx), [`plan-view.tsx`](../../product/alpha/src/chat/plan-view.tsx), [`elicitation-view.tsx`](../../product/alpha/src/chat/elicitation-view.tsx), and [`acp-transcript.ts`](../../product/alpha/src/chat/acp-transcript.ts).

## Mature shared-client parity requirements

Alpha is intentionally cleaner than the legacy shared client, but `packages/client` is evidence of product behaviors the Thread Pane may need to regain. AI Elements can reduce presentation work for some of them; it cannot be allowed to erase their state, recovery, or workbench behavior. The main local reference is [`AssistantChat.tsx`](../../packages/client/src/components/chat/AssistantChat.tsx), with dedicated [`GuidedTaskCard.tsx`](../../packages/client/src/components/chat/GuidedTaskCard.tsx) and [`AskUserCard.tsx`](../../packages/client/src/components/chat/AskUserCard.tsx).

| Mature behavior | AIE coverage | Ownership / migration implication |
| --- | --- | --- |
| Sanitized GFM, links, tables, task lists, images, fenced/inline code, deferred highlighting while streaming, copy fallback | `MessageResponse` + `CodeBlock` cover most rendering | Verify Streamdown sanitization, incomplete fences, copy behavior, image failure, and deferred heavy highlighting before replacing the mature renderer |
| Reasoning grouping/deduplication, hide/show preference, collapse once visible output follows | `Reasoning` supplies streaming open/close; `ChainOfThought` supplies structured steps | ACP view-model grouping and user preference remain Weave-owned; customize AIE open/close rules rather than accepting its one-second close as product truth |
| Grouped tool activity summaries, busy/complete/error state, hidden tools, persisted collapsed state, individual raw result copy | `Tool` and `Task` supply shells | Tool classification, grouping, side effects, stable identity, and per-thread collapse preference remain Weave-owned |
| Tool-driven thread rename, plan update, proposal state, and opening proposal/plan artifacts in the workbench editor | `Plan`, `Artifact`, and action primitives help display | Side effects and Editor Pane routing remain controller/store behavior, never renderer behavior |
| Guided plan/proposal dock with completed/total/blocked state, artifact and review actions, and a composer visibility toggle | `Plan` is a useful shell | Preserve the dock relationship to the composer and Editor Pane; stock `Plan` has no statuses, review state, or proposal semantics |
| Multi-question ask-user flow with option descriptions, custom answers, step navigation, cancel, submit errors, pending dock, and read-only answer replay | `Question` covers one choice/freeform form | Compose one AIE `Question` per question or keep the current card; the sequence, resume payload, dock, cancellation, and replay summary remain Weave-owned |
| Inline and docked tool approval, disabled/submitting states, response replay | `Confirmation` supplies binary approval regions | ACP permission options may be richer than approve/deny; retain the protocol-specific action set |
| Image attachments in user messages and composer, object-URL fetching, upload completion/recovery, steering-message attachments | `Attachments` + `PromptInput` provide previews and local selection | Upload, transfer, retry, and steering acknowledgement remain Weave-owned. Do not enable UI before ACP/Portal transport supports it |
| Per-thread composer drafts, server-ack tracking, restore-on-send/upload failure, and protection against clearing newly typed text | `PromptInputProvider` owns in-memory text only | Draft persistence and acknowledgement are outside AIE; adapt its submit/reset behavior to the existing recovery contract |
| Slash command discovery, keyboard menu, highlighted command token, prompt expansion, and local `/compact` handling | `PromptInputCommand*` supplies command-list pieces | Available-command/prompt data, expansion, command routing, and compaction stay in the ACP/controller layer |
| Sending a steering message during an active run, separate steering failure state, and stop-generation | `PromptInputSubmit` supplies submit/stop visuals | Active-run identity, stale-run checks, cancellation, optimistic state, and recovery stay Weave-owned |
| Model, reasoning effort, service tier/speed, and execution profile controls | `ModelSelector` + `PromptInputSelect` can present choices | Capability filtering, defaults, request payloads, and disable-while-running rules remain Weave-owned |
| Streamed/query-refreshed context usage and cost | `Context` is a close display fit | Reconcile stream and fetched usage in the controller, then pass the resolved display values into AIE |
| Running duration, completed duration, empty-thread prompts, read-only removed workspace, authentication/connect errors | `Shimmer` can help status text; no full replacement | Preserve explicit status/accessibility and product lifecycle logic |
| Per-thread viewport persistence by visible message anchor plus follow-bottom state, robust restore through DOM/size changes | `Conversation` only owns stick-to-bottom | Keep shadcn `MessageScroller` and Weave's per-thread persistence seam; AIE does not replace restoration across thread switches |
| Auto-collapse completed assistant work only while following the bottom, with manual expansion | No direct complete primitive | Keep it in the view model/view preference layer; `Task`/`Reasoning` can render the collapsed regions |
| Stream resume, persisted-message reconciliation, run polling, stop reconciliation, render error boundaries | No AIE replacement | These remain controller/runtime reliability features outside presentational components |

This parity list is not a requirement to port every legacy behavior immediately. It is a guardrail: when Alpha adds the corresponding product capability, adopting AIE should shorten renderer code without reintroducing the legacy second-runtime boundary or dropping recovery semantics.

## Thread-by-thread replacement map

### 1. Conversation scrolling

AI Elements `Conversation` wraps `use-stick-to-bottom`, renders the container as `role="log"`, smooth-scrolls initially and on resize, and supplies an at-bottom-aware `ConversationScrollButton`. It also has an optional Markdown conversation download helper. ([conversation documentation](https://elements.ai-sdk.dev/components/conversation), [conversation source](https://github.com/vercel/ai-elements/blob/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/packages/elements/src/conversation.tsx))

**Recommendation:** retain the current shadcn `MessageScroller` for the first migration. It already sits under the desired shadcn umbrella and has per-item anchors plus `content-visibility` optimizations that `Conversation` does not provide. Revisit `Conversation` only with long-thread, user-scroll, streaming-resize, resume, and mobile tests. If adopted, pass an explicit `aria-label` to its icon-only scroll button and preserve the current max-width/content padding classes.

### 2. Message frames, Markdown, code, actions, and branches

The `Message` suite supplies user/assistant alignment, `MessageContent`, an action row with labeled/tooltip buttons, response branches with previous/next/page controls, and `MessageResponse`. `MessageResponse` is a memoized Streamdown renderer with GFM-compatible streaming Markdown plus CJK, code, math, and Mermaid plugins; it only re-renders when text or animation state changes. ([message documentation](https://elements.ai-sdk.dev/components/message), [message source](https://github.com/vercel/ai-elements/blob/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/packages/elements/src/message.tsx))

`CodeBlock` adds Shiki highlighting, line numbers, language selection, filename/header composition, and clipboard actions. ([code-block documentation](https://elements.ai-sdk.dev/components/code-block), [code-block source](https://github.com/vercel/ai-elements/blob/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/packages/elements/src/code-block.tsx))

**Recommendation:** adopt `MessageResponse` first and override it to Alpha's `text-xs/relaxed` visual contract. Keep the current `Message` and `Bubble` shells until a visual comparison proves an AIE frame can reproduce them exactly. Add `MessageActions`/`MessageAction` when copy, retry, feedback, or share actions are product requirements. Defer `MessageBranch` until ACP exposes durable alternative-response identity; local-only branch state would not survive resume.

The ACP block renderer must still coalesce adjacent text chunks before passing them to `MessageResponse`; AIE does not replace that reducer concern. Decide deliberately whether math and Mermaid are acceptable executable/rendered response capabilities before enabling their Streamdown plugins.

### 3. Reasoning and progressive status

`Reasoning` is a controlled or uncontrolled collapsible that opens while streaming, measures duration, and closes one second after streaming ends. Its content is Streamdown-rendered and its trigger uses `Shimmer` while active. `ChainOfThought` is a separate structured timeline for labeled steps, descriptions, statuses, search results, and images. ([reasoning documentation](https://elements.ai-sdk.dev/components/reasoning), [reasoning source](https://github.com/vercel/ai-elements/blob/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/packages/elements/src/reasoning.tsx), [chain-of-thought documentation](https://elements.ai-sdk.dev/components/chain-of-thought), [chain-of-thought source](https://github.com/vercel/ai-elements/blob/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/packages/elements/src/chain-of-thought.tsx))

**Recommendation:** replace the current thought `Collapsible` with a restyled `Reasoning`; it closely matches the ACP thought chunk and improves streaming behavior. Keep Alpha's "Thinking" label/icon treatment if preferred. Do not use `ChainOfThought` unless the protocol supplies structured reasoning steps; inventing them from prose would create false semantics.

Use `Shimmer` for short, textual in-progress labels where motion is appropriate, but keep the existing screen-reader-only live status as the authoritative accessibility announcement. ([shimmer documentation](https://elements.ai-sdk.dev/components/shimmer), [shimmer source](https://github.com/vercel/ai-elements/blob/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/packages/elements/src/shimmer.tsx))

### 4. Tool calls and approvals

`Tool` supplies a collapsible frame, AI SDK v6 state badges, JSON input rendering, and object/string/error output rendering through `CodeBlock`. Its state vocabulary is `input-streaming`, `input-available`, `approval-requested`, `approval-responded`, `output-available`, `output-denied`, and `output-error`. `Confirmation` conditionally renders request, accepted, rejected, and action regions from AI SDK approval state. ([tool documentation](https://elements.ai-sdk.dev/components/tool), [tool source](https://github.com/vercel/ai-elements/blob/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/packages/elements/src/tool.tsx), [confirmation documentation](https://elements.ai-sdk.dev/components/confirmation), [confirmation source](https://github.com/vercel/ai-elements/blob/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/packages/elements/src/confirmation.tsx))

**Recommendation:** reuse the `Tool` composition and visual shell, not its `ToolPart` state model or stock body. Add an explicit adapter from ACP `pending | in_progress | completed | failed` to local presentation status, while continuing to render ACP locations, content blocks, text diffs, terminal references, and raw input/output with current components. Do not feed ACP state through a cast to `ToolUIPart`.

ACP permission requests can expose multiple named options and kinds, while AIE `Confirmation` models an approved/rejected result. Keep Alpha's option loop and action callback. The AIE alert shell and request/accepted/rejected regions are reusable only after a semantic adapter is defined; `ConfirmationAction` itself is safe as a styled button.

The code-oriented AIE catalog can improve individual tool outputs without changing the tool model:

| AIE element | Useful ACP payload | Recommendation |
| --- | --- | --- |
| `CodeBlock` | Raw JSON, source snippets, text diffs | Adopt selectively; retain Alpha-specific diff coloring and path header |
| `Terminal` | Captured terminal output | Adopt when ACP supplies actual output, not merely a terminal ID |
| `TestResults` | Structured test suites/cases | Adopt only from structured tool output |
| `StackTrace` | JavaScript/Node stack traces | Adopt after type/format detection |
| `Commit` | Structured commit metadata and file changes | Adopt for commit tools, not arbitrary text |
| `Snippet` | One-line commands or hashes | Low-risk inline enhancement |
| `EnvironmentVariables`, `PackageInfo`, `SchemaDisplay`, `Agent` | Specialized structured tool results | Defer until a named ACP tool contract exists |

These are all presentation components in the official code catalog. ([terminal docs](https://elements.ai-sdk.dev/components/terminal), [test-results docs](https://elements.ai-sdk.dev/components/test-results), [stack-trace docs](https://elements.ai-sdk.dev/components/stack-trace), [commit docs](https://elements.ai-sdk.dev/components/commit), [specialized code component sources](https://github.com/vercel/ai-elements/tree/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/packages/elements/src))

### 5. Plans, tasks, queues, checkpoints, and compaction

`Plan` is a collapsible Card shell with a streaming title/description shimmer, action, content, and footer. It does not define plan-entry statuses or priorities. `Task` is a collapsible list presentation with file chips; `Queue` models queued messages and todos with sections and actions. `Checkpoint` is a history separator with an optional restore trigger. ([plan documentation](https://elements.ai-sdk.dev/components/plan), [plan source](https://github.com/vercel/ai-elements/blob/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/packages/elements/src/plan.tsx), [task documentation](https://elements.ai-sdk.dev/components/task), [queue documentation](https://elements.ai-sdk.dev/components/queue), [checkpoint documentation](https://elements.ai-sdk.dev/components/checkpoint))

**Recommendation:** use the restyled `Plan` shell around Alpha's existing ACP plan-entry renderer. Preserve `pending | in_progress | completed`, priority, Markdown/file formats, and URI behavior. `Task` is useful for nested tool activity but is not a replacement for ACP plan entries. `Queue` is relevant only if Weave introduces queued prompts or a distinct todo stream.

Do not relabel context compaction as a checkpoint. A checkpoint promises restoration; the current compaction marker records a context-management event. Keep the current marker and optionally use `Shimmer` for its active status. Adopt `Checkpoint` only when the backend exposes a real restore/fork action and durable checkpoint identity.

### 6. Elicitation and confirmation questions

The newly added `Question` component supports controlled/uncontrolled single or multiple choice, optional freeform text, accessible radio/checkbox roles, and async submission. Its documentation is present at the inspected upstream head but was not yet published at the public component route on the research date. ([question documentation source](https://github.com/vercel/ai-elements/blob/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/apps/docs/content/components/%28chatbot%29/question.mdx), [question source](https://github.com/vercel/ai-elements/blob/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/packages/elements/src/question.tsx))

**Recommendation:** use `Question` for the subset of ACP elicitations that are exactly a single/multiple choice plus optional text. Keep the current schema form for booleans, numbers, integers, constrained strings, email/URI/date/date-time formats, validation, and URL-mode elicitations. The general form cannot be replaced by `Question` without losing protocol capability.

`Confirmation` is appropriate for a truly binary confirmation but not for multi-option tool permission requests. Both paths must preserve accepted, declined, cancelled, and completed ACP lifecycle state after the controls disappear.

### 7. Sources, citations, files, images, audio, and other content blocks

`Sources` is a collapsible response-level source list. `InlineCitation` is a hover-card citation with carousel, source, and quote composition. These should be used only for provenance data, not for every ACP `resource_link`. ([sources documentation](https://elements.ai-sdk.dev/components/sources), [inline-citation documentation](https://elements.ai-sdk.dev/components/inline-citation), [inline citation source](https://github.com/vercel/ai-elements/blob/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/packages/elements/src/inline-citation.tsx))

`Attachments` renders AI SDK `FileUIPart` and `SourceDocumentUIPart` as grid, inline, or list items, with image/video previews, file/media labels, hover cards, and remove actions. `Image` renders the AI SDK `Experimental_GeneratedImage` base64 shape. `AudioPlayer` is a composable `media-chrome` player, while `Transcription` renders time-synchronized transcript segments. ([attachments documentation](https://elements.ai-sdk.dev/components/attachments), [attachments source](https://github.com/vercel/ai-elements/blob/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/packages/elements/src/attachments.tsx), [image source](https://github.com/vercel/ai-elements/blob/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/packages/elements/src/image.tsx), [audio-player documentation](https://elements.ai-sdk.dev/components/audio-player), [transcription documentation](https://elements.ai-sdk.dev/components/transcription))

**Recommendation:** add a narrow adapter from each ACP content block to an Alpha-owned display shape, then use AIE presentation where it fits:

| ACP block | AIE fit | Decision |
| --- | --- | --- |
| `text` | `MessageResponse` | Replace current direct Streamdown rendering |
| `image` | `Attachments` or `Image` after base64/data-URL adaptation | Prefer `Attachments` when filename/MIME metadata matters |
| `audio` | `AudioPlayer` after data-URL adaptation | Adopt later; compare bundle and mobile behavior with native `<audio>` |
| `resource_link` | `Attachments` for a file/source, `Source` for actual citation provenance | Do not assume every link is a citation |
| Embedded text resource | `CodeBlock` or current framed preformatted block | Choose by MIME/language; preserve URI and MIME header |
| Embedded binary resource | `Attachments` | Preserve unavailable/download semantics; do not expose encoded-byte count as file size |

The current composer action accepts text only, so prompt attachments should not be exposed merely because `PromptInput` supports them. Wait until the ACP send path has an explicit content-block/file contract and recovery behavior.

### 8. Composer and its subcontrols

`PromptInput` is the broadest AIE compound component. It provides:

- self-managed or provider-managed text and attachment state;
- a form-level `onSubmit({ text, files })` contract;
- a textarea with Enter-to-submit, Shift+Enter newline, IME protection, paste-to-attach, and backspace-to-remove-last-attachment behavior;
- local or document-level drag/drop, file type/count/size validation, and blob-to-data-URL conversion;
- header, body, footer, tools, tooltip buttons, submit/stop/error status, action menus, screenshot capture, selects, hover cards, tabs, and command-menu pieces;
- referenced-source state and file-dialog helpers.

These behaviors are in the official [Prompt Input documentation](https://elements.ai-sdk.dev/components/prompt-input) and [source](https://github.com/vercel/ai-elements/blob/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/packages/elements/src/prompt-input.tsx).

**Recommendation:** adopt the compound structure, but make the installed source conform to the existing composer—not the reverse. Preserve:

- `bg-composer-background` and the current flat, full-width, top-border composition;
- the frameless textarea, `text-xs/relaxed`, current horizontal padding, and two-to-eight-row behavior;
- the exact placeholder and the future `@` context / `/` commands promise;
- mode and arbitrary session-config controls on the lower left;
- context usage plus the existing send/stop button on the lower right;
- immediate ACP cancellation and mobile keyboard blur behavior.

Suggested component seam:

```tsx
<PromptInput className="alpha-composer" onSubmit={adaptPrompt}>
  <PromptInputBody>
    <PromptInputTextarea className="alpha-composer-textarea" />
  </PromptInputBody>
  <PromptInputFooter className="alpha-composer-footer">
    <PromptInputTools>{/* current ConfigControls */}</PromptInputTools>
    <div>{/* restyled Context + PromptInputSubmit */}</div>
  </PromptInputFooter>
</PromptInput>
```

This is an architectural sketch, not an implementation prescription. In particular, AIE clears local input after a successful async `onSubmit` and retains it when the promise rejects, while Alpha currently clears before calling `sendPrompt`. Pick and test the intended optimistic behavior instead of accepting the library default accidentally. AIE's stock `PromptInputTextarea` also uses `field-sizing-content`, `min-h-16`, and `max-h-48`, so Alpha's current composer height needs explicit overrides. ([prompt input source](https://github.com/vercel/ai-elements/blob/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/packages/elements/src/prompt-input.tsx))

`PromptInputSelect` can host ACP mode/config selects, but it does not replace their protocol-driven option model. `ModelSelector` is a searchable Dialog/Command palette and is useful only if the session exposes enough models to warrant search, grouping, logos, and metadata. ([model-selector documentation](https://elements.ai-sdk.dev/components/model-selector), [model-selector source](https://github.com/vercel/ai-elements/blob/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/packages/elements/src/model-selector.tsx))

`Context` is a close fit for the current usage ring: it accepts used/max tokens, can show input/output/reasoning/cache breakdown, and can estimate cost with `tokenlens` when given an AI SDK usage object and model ID. Keep the existing tiny ring as a custom trigger, and use the AIE hover content only for data that ACP actually supplies. ([context documentation](https://elements.ai-sdk.dev/components/context), [context source](https://github.com/vercel/ai-elements/blob/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/packages/elements/src/context.tsx))

### 9. Suggestions, speech, dictation, and voice

`Suggestions` is a horizontally scrollable list of buttons that returns a suggestion string. It is suitable for empty-state or next-prompt actions, but Alpha currently has no server-authoritative suggestion model. ([suggestion documentation](https://elements.ai-sdk.dev/components/suggestion), [suggestion source](https://github.com/vercel/ai-elements/blob/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/packages/elements/src/suggestion.tsx))

`SpeechInput` prefers browser Web Speech recognition and falls back to `MediaRecorder`, requiring the caller to send the Blob to a transcription service. `MicSelector` enumerates audio devices and requests media permission. `VoiceSelector`, `AudioPlayer`, `Transcription`, and animated Rive `Persona` cover output voice selection/playback and voice-agent state. ([speech-input documentation](https://elements.ai-sdk.dev/components/speech-input), [speech-input source](https://github.com/vercel/ai-elements/blob/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/packages/elements/src/speech-input.tsx), [mic-selector documentation](https://elements.ai-sdk.dev/components/mic-selector), [voice component sources](https://github.com/vercel/ai-elements/tree/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/packages/elements/src))

**Recommendation:** defer voice controls. They require permission, secure-context, browser/Capacitor, transcription-service, and mobile lifecycle decisions outside a visual migration. If added later, `SpeechInput` can write into `PromptInputProvider`, but the transcript should be reviewed before sending.

### 10. Artifact-like and web-preview content

`Artifact` is a generic generated-output frame with header, title, description, close/action controls, and scrollable content. `WebPreview` adds an address field, navigation controls, a sandboxed iframe, and a collapsible console. `JSXPreview` uses `react-jsx-parser` to render generated JSX; `Sandbox` combines code/output/error states; `FileTree` renders hierarchical files. ([artifact documentation](https://elements.ai-sdk.dev/components/artifact), [artifact source](https://github.com/vercel/ai-elements/blob/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/packages/elements/src/artifact.tsx), [web-preview documentation](https://elements.ai-sdk.dev/components/web-preview), [web-preview source](https://github.com/vercel/ai-elements/blob/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/packages/elements/src/web-preview.tsx), [JSX preview documentation](https://elements.ai-sdk.dev/components/jsx-preview), [sandbox documentation](https://elements.ai-sdk.dev/components/sandbox))

**Recommendation:** do not put full artifacts or previews into the Thread Pane. Use compact tool/result affordances in the thread, then open rich content in Alpha's separate Editor Pane. `Artifact` and `WebPreview` can be reused inside that pane later, while the Thread entry retains identity and an "open" action. This matches the current workbench layout and avoids turning long, streaming threads into nested editors.

Treat generated JSX as executable content. Do not adopt `JSXPreview` until component allowlisting, error isolation, and security behavior have a product contract. `WebPreviewBody` does set an iframe sandbox and title in upstream source, but the current sandbox includes `allow-scripts` and `allow-same-origin`; URLs and trust boundaries still require review. ([web preview iframe source](https://github.com/vercel/ai-elements/blob/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/packages/elements/src/web-preview.tsx), [JSX preview source](https://github.com/vercel/ai-elements/blob/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/packages/elements/src/jsx-preview.tsx))

## Vite, Base UI, and bundle caveats

### Official facts

- The published setup target is React 19, Next.js 14+, AI SDK, shadcn/ui, and Tailwind CSS 4; Vite is not named as a supported setup target in the AI Elements guide. ([setup guide](https://elements.ai-sdk.dev/docs/setup))
- Component source is copied into the consumer and generally consists of React client components; the inspected Thread-relevant source does not import Next.js runtime modules. ([usage guide](https://elements.ai-sdk.dev/docs/usage), [component source directory](https://github.com/vercel/ai-elements/tree/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/packages/elements/src))
- Upstream currently develops against a New York shadcn configuration whose primitives import `radix-ui`, and AIE source uses `asChild` in multiple components. It imports Lucide icons directly. ([upstream shadcn config](https://github.com/vercel/ai-elements/blob/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/packages/shadcn-ui/components.json), [upstream UI package](https://github.com/vercel/ai-elements/blob/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/packages/shadcn-ui/package.json), [plan source using `asChild`](https://github.com/vercel/ai-elements/blob/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/packages/elements/src/plan.tsx))
- Individual registry responses derive npm and shadcn dependencies from the selected component's imports. Installing the whole registry collects dependencies for all 49 components. ([registry route](https://github.com/vercel/ai-elements/blob/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/apps/docs/app/api/registry/%5Bcomponent%5D/route.ts))
- The source workspace currently develops AI Elements against `ai ^6.0.105`, while individual registry responses declare the dependency only as the unversioned package name `ai`. A registry install can therefore resolve a different AI SDK major from the one used to develop the inspected source. ([component package manifest](https://github.com/vercel/ai-elements/blob/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/packages/elements/package.json), [message registry response](https://elements.ai-sdk.dev/api/registry/message.json))
- `MessageResponse` adds Streamdown plugins, `CodeBlock` adds Shiki, `Conversation` adds `use-stick-to-bottom`, `Context` adds `tokenlens`, `AudioPlayer` adds `media-chrome`, `Persona` adds Rive, `JSXPreview` adds `react-jsx-parser`, `Terminal` adds `ansi-to-react`, and workflow canvas elements add React Flow. ([component manifest](https://github.com/vercel/ai-elements/blob/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/packages/elements/package.json))

### Recommendations for Alpha

1. Use the shadcn registry for provenance, but add only a named component at a time; never add `all` for this migration.
2. Inspect generated files and dependency changes before accepting them. Do not overwrite existing Alpha Base UI primitives wholesale.
3. Keep AIE components in `src/components/ai-elements/` so upstream-derived code is visible and isolated from the current `src/components/ui/` layer.
4. Translate `asChild` and Radix-specific styling/state assumptions to the Base UI composition APIs already used by Alpha.
5. Replace Lucide imports with Hugeicons in adopted source to keep the current icon system and visual rhythm.
6. Keep AIE-to-ACP conversion in small Alpha adapters; do not leak AI SDK types into `AcpTranscript`.
7. Remove AIE's AI SDK type-only imports in favor of Alpha-owned ACP view-model types where practical. If an adopted component needs the runtime package, pin and verify the intended AI SDK major instead of accepting the ambient latest resolution.
8. Measure the production bundle after each rich renderer. Markdown/code/math/Mermaid, Shiki, media, Rive, JSX parsing, and React Flow should not arrive as one migration.
9. Run the same code under Vite web and Capacitor before claiming framework compatibility. The absence of Next imports makes Vite adoption plausible, but Vercel's official setup does not promise it.

## Official agent skill

Vercel publishes and documents an official `ai-elements` agent skill. The supported installation command shown both in AI Elements docs and its Skills listing is:

```bash
npx skills add vercel/ai-elements
```

No second installation form is documented on those official pages. The skill says it teaches component installation and use, composable patterns, AI SDK conventions, shadcn theming/styling, and troubleshooting. ([AI Elements skill documentation](https://elements.ai-sdk.dev/docs/skill), [official Skills listing](https://skills.sh/vercel/ai-elements))

The skill itself is checked into the same `vercel/ai-elements` repository under `skills/ai-elements/`. It contains the main `SKILL.md`, one generated reference per component, and example scripts; the root repository has a `generate-skills` script. The latest inspected repository commit adds the new Question component and its skill reference in the same tree, so the skill appears to be maintained alongside the library rather than as an unrelated package. That is repository evidence, not a guaranteed release-synchronization SLA. ([skill source](https://github.com/vercel/ai-elements/tree/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/skills/ai-elements), [skill generator](https://github.com/vercel/ai-elements/blob/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/packages/scripts/src/generate-skills.ts), [inspected repository head](https://github.com/vercel/ai-elements/commit/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd))

Do not install the skill as part of the UI migration automatically. It changes agent guidance, not application runtime, and should be a separate user-level or repository-tooling decision.

## Complete current catalog and Thread Pane relevance

The following table accounts for all 49 component files at the inspected upstream revision. Category names follow the official documentation navigation. ([official component catalog](https://elements.ai-sdk.dev/components), [source directory](https://github.com/vercel/ai-elements/tree/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd/packages/elements/src))

| Official category | Components | Thread Pane disposition |
| --- | --- | --- |
| Chatbot | `attachments`, `chain-of-thought`, `checkpoint`, `confirmation`, `context`, `conversation`, `inline-citation`, `message`, `model-selector`, `plan`, `prompt-input`, `question`, `queue`, `reasoning`, `shimmer`, `sources`, `suggestion`, `task`, `tool` | Core evaluation set. Adopt or adapt as mapped above; several require ACP semantics first. |
| Code | `agent`, `artifact`, `code-block`, `commit`, `environment-variables`, `file-tree`, `jsx-preview`, `package-info`, `sandbox`, `schema-display`, `snippet`, `stack-trace`, `terminal`, `test-results`, `web-preview` | Use as structured tool-result renderers or in the Editor Pane. Do not inline full artifacts by default. |
| Voice | `audio-player`, `mic-selector`, `persona`, `speech-input`, `transcription`, `voice-selector` | Audio content can use `audio-player`; defer the voice-agent surface. |
| Workflow | `canvas`, `connection`, `controls`, `edge`, `node`, `panel`, `toolbar` | Out of scope for the linear Thread Pane; relevant only to a future graph/workflow artifact. |
| Utilities | `image`, `open-in-chat` | `image` can adapt generated/ACP image data. `open-in-chat` is unrelated to an in-product agent thread. |

## Proposed adoption sequence

This is a recommendation, not work performed by this research.

1. **Foundation spike:** add only `message` in a disposable branch, adapt it to Base UI/Hugeicons, render the existing ACP showcase through `MessageResponse`, and compare snapshots, accessibility, streaming, long lines, code, and bundle output. Keep the current message frame.
2. **Reasoning:** add and restyle `reasoning`; prove split thought chunks, active streaming, completion, reload, and reduced-motion behavior.
3. **Composer:** add `prompt-input` source, preserve the current composer pixel and keyboard contract, and initially disable attachments/screenshots/commands that have no ACP send path. Map running to submit/stop without importing `useChat`.
4. **Context:** add `context` behind the current ring, rendering only ACP-supported usage/cost fields.
5. **Tool shell:** adopt the visual composition while retaining the ACP body, permission buttons, statuses, and reducer. Add `code-block` only if bundle and rendering behavior are acceptable.
6. **Plan and simple elicitation:** wrap current plan content in the AIE shell; use `Question` only for an explicitly detected compatible schema subset.
7. **Rich parts:** adapt attachments/audio/sources with provenance-aware data types. Open artifacts and previews in the Editor Pane.
8. **Deferred semantics:** branching, checkpoints, queue, suggestions, model search, and voice only after the product/backend contracts exist.

## Acceptance checks for any migration

- Current user/assistant alignment, bubble treatment, typography, max width, and composer appearance are visually unchanged unless deliberately approved.
- A resumed ACP transcript renders the same entry order and status as before; no AI SDK cast becomes state authority.
- Split streaming Markdown, code fences, incomplete syntax, long unbroken text, and adjacent ACP text blocks remain stable.
- Manual scrolling is not stolen during streaming; the end button is keyboard accessible and has an accessible name.
- Thought content auto-opens/closes only according to the accepted product behavior and honors reduced motion.
- All tool states, locations, diffs, terminal references, raw data, failures, and multi-option permissions remain reachable.
- Plan priorities/formats and every supported elicitation schema still work.
- Enter, Shift+Enter, IME composition, disabled send, stop, mobile keyboard blur, and error/optimistic composer behavior are explicit tests.
- Web and Capacitor builds pass; Base UI trigger composition, portals, focus return, tooltips, selects, and collapsibles are tested in rendered UI.
- Bundle changes are recorded per adopted component; rich optional dependencies are not pulled in accidentally.
- No artifact-like content regresses the separate Editor Pane architecture.
