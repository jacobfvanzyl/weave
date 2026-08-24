# WVE-47: Zed, T3Code, and shadcn UI reference

Date: 2026-08-24

## Conclusion

Alpha should copy Zed's visual grammar and information density, then adopt selected T3Code behaviors without adopting T3Code's more branded, rounded presentation.

The target is a compact, editor-native three-pane shell: a workspace/thread sidebar, a continuous conversation surface, and an optional filesystem/terminal/diff panel. Thin dividers, restrained semantic color, compact toolbars, quiet selected rows, full-width outlined user prompts, unboxed assistant output, and a docked composer should define the appearance. T3Code contributes useful product behaviors: richer thread status, project/worktree metadata, resizable panes, a surface-tabbed right panel, and composer controls for agent/model/mode/effort/access.

## Canonical repositories and local references

| Project | Canonical upstream | Default branch | License | Local reference |
| --- | --- | --- | --- | --- |
| Zed | [`zed-industries/zed`](https://github.com/zed-industries/zed) | `main` | Primarily GPL-3.0-or-later; files explicitly marked otherwise may be Apache-2.0. [Upstream licensing statement](https://github.com/zed-industries/zed/blob/d6449a9e3fb408881d42e9d8a92280431aa7d57f/README.md#licensing) | `/Users/jaco/Documents/VeeZee/reference-sources/zed` at `d6449a9e3fb408881d42e9d8a92280431aa7d57f` |
| T3Code | [`pingdotgg/t3code`](https://github.com/pingdotgg/t3code) | `main` | MIT. [Upstream license](https://github.com/pingdotgg/t3code/blob/e9f50c3efcb02a199042364ead292e164274e716/LICENSE) | `/Users/jaco/Documents/VeeZee/reference-sources/t3code` at `e9f50c3efcb02a199042364ead292e164274e716` |
| shadcn/ui | [`shadcn-ui/ui`](https://github.com/shadcn-ui/ui) | `main` | MIT. [Upstream license](https://github.com/shadcn-ui/ui/blob/ac60ef5c4db4265d71454dd9ecd3f93e255d7211/LICENSE.md) | `/Users/jaco/Documents/VeeZee/reference-sources/shadcn-ui` at `ac60ef5c4db4265d71454dd9ecd3f93e255d7211` (sparse checkout of `skills/`) |

All three checkouts were clean and on `main` when inspected. These fixed revisions make the observations below reproducible even if the upstream interfaces change.

## Source areas worth inspecting

### Zed

- [`crates/sidebar/src/sidebar.rs`](https://github.com/zed-industries/zed/blob/d6449a9e3fb408881d42e9d8a92280431aa7d57f/crates/sidebar/src/sidebar.rs#L6103-L6463) implements the workspace-grouped thread sidebar, filtering, active/hover state, per-thread actions, status, timestamps, remote state, worktree/branch metadata, and diff counts. Its sidebar header and search are at [lines 7197–7271](https://github.com/zed-industries/zed/blob/d6449a9e3fb408881d42e9d8a92280431aa7d57f/crates/sidebar/src/sidebar.rs#L7197-L7271).
- [`crates/ui/src/components/ai/thread_item.rs`](https://github.com/zed-industries/zed/blob/d6449a9e3fb408881d42e9d8a92280431aa7d57f/crates/ui/src/components/ai/thread_item.rs) is the reusable compact thread row seen in the sidebar.
- [`crates/agent_ui/src/agent_panel.rs`](https://github.com/zed-industries/zed/blob/d6449a9e3fb408881d42e9d8a92280431aa7d57f/crates/agent_ui/src/agent_panel.rs#L5778-L6232) owns the agent toolbar, new-thread/agent menus, panel options, and active conversation surface.
- [`crates/agent_ui/src/conversation_view/thread_view.rs`](https://github.com/zed-industries/zed/blob/d6449a9e3fb408881d42e9d8a92280431aa7d57f/crates/agent_ui/src/conversation_view/thread_view.rs#L12134-L12490) composes the transcript, activity/error/permission surfaces, and docked editor. The editor shell and lower control strip are built around [`render_message_editor`](https://github.com/zed-industries/zed/blob/d6449a9e3fb408881d42e9d8a92280431aa7d57f/crates/agent_ui/src/conversation_view/thread_view.rs#L4333-L4460).
- [`crates/agent_ui/src/message_editor.rs`](https://github.com/zed-industries/zed/blob/d6449a9e3fb408881d42e9d8a92280431aa7d57f/crates/agent_ui/src/message_editor.rs) implements the actual prompt editor, mentions, slash commands, attachments, paste/drop behavior, and autocomplete.
- [`crates/project_panel/src/project_panel.rs`](https://github.com/zed-industries/zed/blob/d6449a9e3fb408881d42e9d8a92280431aa7d57f/crates/project_panel/src/project_panel.rs) implements the right-side filesystem tree visible in the supplied Zed screenshot.
- [`docs/src/ai/agent-panel.md`](https://github.com/zed-industries/zed/blob/d6449a9e3fb408881d42e9d8a92280431aa7d57f/docs/src/ai/agent-panel.md) is the first-party behavior guide for threads, external ACP agents, message editing, tool calls, checkpoints, permissions, and running multiple threads.

### T3Code

- [`apps/web/src/components/AppSidebarLayout.tsx`](https://github.com/pingdotgg/t3code/blob/e9f50c3efcb02a199042364ead292e164274e716/apps/web/src/components/AppSidebarLayout.tsx#L139-L243) composes the responsive, persisted-width left sidebar using the project's shadcn-derived `Sidebar` primitives.
- [`apps/web/src/components/Sidebar.tsx`](https://github.com/pingdotgg/t3code/blob/e9f50c3efcb02a199042364ead292e164274e716/apps/web/src/components/Sidebar.tsx#L3370-L3911) implements the current Search/All projects/thread inbox/Settled presentation visible in the supplied screenshot, including status and lifecycle groupings.
- [`apps/web/src/components/ChatView.tsx`](https://github.com/pingdotgg/t3code/blob/e9f50c3efcb02a199042364ead292e164274e716/apps/web/src/components/ChatView.tsx#L6604-L7094) is the main shell. It composes the header, message timeline, floating/docked composer, terminal drawer, and optional right-hand Files/Terminal/Diff/Agents/PR/Preview surfaces.
- [`apps/web/src/components/chat/ChatHeader.tsx`](https://github.com/pingdotgg/t3code/blob/e9f50c3efcb02a199042364ead292e164274e716/apps/web/src/components/chat/ChatHeader.tsx), [`MessagesTimeline.tsx`](https://github.com/pingdotgg/t3code/blob/e9f50c3efcb02a199042364ead292e164274e716/apps/web/src/components/chat/MessagesTimeline.tsx), and [`ChatComposer.tsx`](https://github.com/pingdotgg/t3code/blob/e9f50c3efcb02a199042364ead292e164274e716/apps/web/src/components/chat/ChatComposer.tsx) are the focused sources for the breadcrumb/header, virtualized transcript, and rich composer.
- [`apps/web/src/components/RightPanelTabs.tsx`](https://github.com/pingdotgg/t3code/blob/e9f50c3efcb02a199042364ead292e164274e716/apps/web/src/components/RightPanelTabs.tsx) and [`apps/web/src/components/files/FilePreviewPanel.tsx`](https://github.com/pingdotgg/t3code/blob/e9f50c3efcb02a199042364ead292e164274e716/apps/web/src/components/files/FilePreviewPanel.tsx) implement the tabbed right panel and Files surface.
- [`apps/web/components.json`](https://github.com/pingdotgg/t3code/blob/e9f50c3efcb02a199042364ead292e164274e716/apps/web/components.json) is important context: T3Code already uses shadcn's `base-mira` style, Base UI, Lucide icons, Tailwind CSS variables, and local source-owned components. Its extensive semantic theme and sidebar tokens live in [`apps/web/src/index.css`](https://github.com/pingdotgg/t3code/blob/e9f50c3efcb02a199042364ead292e164274e716/apps/web/src/index.css#L1387-L1492).

## Official shadcn skills

shadcn itself publishes two skills in the canonical repository:

1. [`skills/shadcn`](https://github.com/shadcn-ui/ui/tree/ac60ef5c4db4265d71454dd9ecd3f93e255d7211/skills/shadcn), installed with `npx skills add shadcn/ui`. It makes the CLI and current project configuration authoritative, requires registry search and current component docs before composition, and contains explicit chat/UI composition rules. [Official skills documentation](https://ui.shadcn.com/docs/skills)
2. [`skills/migrate-radix-to-base`](https://github.com/shadcn-ui/ui/tree/ac60ef5c4db4265d71454dd9ecd3f93e255d7211/skills/migrate-radix-to-base), which covers deliberate Radix-to-Base migrations. It is not needed merely to initialize Alpha on Base UI, but it is authoritative if an existing Radix surface is later migrated.

The installed Codex copies at `/Users/jaco/.codex/skills/shadcn` and `/Users/jaco/.codex/skills/migrate-radix-to-base` are not third-party approximations: `diff -rq` reported no differences against those two upstream directories at `ac60ef5…`. The `shadcn` skill used for WVE-47 is therefore the official upstream skill.

The official skill's relevant rules are:

- Prefer existing source-owned components, CLI registry discovery, built-in variants, and semantic tokens; do not recreate stock controls or hard-code palette colors. [Official `SKILL.md`](https://github.com/shadcn-ui/ui/blob/ac60ef5c4db4265d71454dd9ecd3f93e255d7211/skills/shadcn/SKILL.md)
- Use `MessageScroller` for live-follow, anchoring, restoration, prepended history, visibility, and jump-to-latest behavior. Use `Message`, `Bubble`, `Attachment`, and `Marker` for transcript structure instead of hand-rolled rows and scroll logic. [Official chat rule](https://github.com/shadcn-ui/ui/blob/ac60ef5c4db4265d71454dd9ecd3f93e255d7211/skills/shadcn/rules/chat.md) and [chat components announcement](https://ui.shadcn.com/docs/changelog/2026-06-chat-components)
- Use the composable `Sidebar` family for header/content/groups/menu/actions/badges/rail and responsive collapse. [Official Sidebar documentation](https://ui.shadcn.com/docs/components/base/sidebar)
- Use `Resizable` for the desktop pane seams, `Tabs` for T3Code-style right-panel surfaces, `Command` for keyboard-first pickers/search, and `Collapsible` for tool/activity detail. These are all in the [official component catalog](https://ui.shadcn.com/docs/components/base/sidebar#composition).
- There is no dedicated prompt/composer item in the official `@shadcn` registry as inspected with `shadcn search`. Compose it from `InputGroup` + `InputGroupTextarea`, `Button`, `DropdownMenu`/`Popover`, and `Tooltip`; this follows the official form rule rather than creating a styled textarea wrapper. [Official Input Group documentation](https://ui.shadcn.com/docs/components/base/input-group)

## UI comparison from the supplied screenshots

| Dimension | Zed | T3Code | Direction for Alpha |
| --- | --- | --- | --- |
| Shell | Three continuous editor panes with 1 px seams and almost no container chrome. | Three panes too, but the sidebar, chat canvas, and tabbed right panel are more product-branded. | Copy Zed's continuous frame and pane proportions; use T3Code's surface model behind it. |
| Density | Compact headers, rows, icons, and status bars; minimal vertical padding. | More breathing room, larger labels, richer secondary metadata, and larger rounded controls. | Start at Zed density. Allow richer metadata only on active/expanded rows. |
| Shape | Mostly square or subtly rounded panels; selected rows and user prompts are restrained rectangles. | Prominent rounded composer, rounded pills/cards, glass/grain treatments, and stronger elevation. | Keep radius and elevation low. Do not copy T3Code's floating-card composer or grain. |
| Transcript | User prompts are full-width outlined blocks; assistant content sits directly on the canvas. Tool activity is compact and inline. | Assistant output is also content-first, but summaries, status, and tool surfaces carry more hierarchy and whitespace. | `Message` rows with `Bubble variant="outline"` for user prompts and `ghost`/unframed assistant content; use `Marker` and `Collapsible` for activity. |
| Composer | Docked to the bottom edge with a flat editor region and a dense lower control strip. | Floating, heavily rounded composer card with model/access/effort controls, attachment/context affordances, and progress state. | Copy Zed's docked geometry; selectively bring over T3Code's agent/model/mode/effort/access controls in a compact strip. |
| Left navigation | Host/workspace groups and compact thread rows with title, timestamp, status, remote/worktree metadata, and actions. | Search plus project-centric grouping, richer two-line thread cards, status badges, pinning, and Settled lifecycle. | Use Zed row styling with T3Code's search, lifecycle/status semantics, and project/worktree metadata. |
| Right panel | Native project tree, visually part of the editor shell. | Tabbed surfaces for Files, Terminal, Diff, Agents, PRs, and Preview. | Keep Zed's quiet project-panel look but use T3Code's extensible tabbed surface concept once those capabilities arrive. |
| Typography/color | Theme-driven editor typography and restrained neutral semantics. | Sans UI typography, semantic shadcn tokens, brighter branded accents. | Use semantic shadcn tokens but calibrate them to Zed-like dark neutrals; reserve accent color for focus, active work, and errors. |

## Recommended Alpha component map

| Alpha surface | shadcn composition | Source behavior to emulate |
| --- | --- | --- |
| Host/workspace/thread rail | `SidebarProvider`, `Sidebar`, `SidebarHeader`, `SidebarContent`, `SidebarGroup`, `SidebarMenu*`, `Collapsible`, `Badge`, `Tooltip` | Zed compact rows and grouping; T3Code search and lifecycle/status semantics. |
| Desktop shell | `ResizablePanelGroup`, `ResizablePanel`, `ResizableHandle` | Zed's three-pane visual continuity; T3Code's persisted/responsive resizing. |
| Transcript | `MessageScroller*`, `Message`, `Bubble`, `Marker`, `Attachment`, `Collapsible` | Zed prompt/answer geometry and compact activity; shadcn-managed streaming/restore anchoring. |
| Composer | `InputGroup`, `InputGroupTextarea`, `InputGroupAddon`, `Button`, `DropdownMenu`, `Popover`, `Tooltip`, `Separator` | Zed docked editor shell plus T3Code agent/model/mode/effort/access/context controls. |
| Files/Terminal/Diff area | `Tabs`, `ResizablePanel`, `ScrollArea`, `Collapsible`, `ContextMenu` | Zed project tree presentation; T3Code's extensible right-panel surfaces. |
| Mobile/Capacitor | `Sheet` or `Drawer` for the two side panes; keep the transcript/composer primary | Preserve the same hierarchy without compressing three panes into one viewport. |

## Guardrails for the visual checkpoint

- Treat Zed as the visual authority and T3Code as a behavior reference. A T3Code feature should be restyled into Zed's density rather than imported with its original card/pill treatment.
- Keep one semantic token layer in Alpha. Match Zed by tuning `background`, `panel`, `border`, `muted`, `accent`, and focus tokens instead of scattering literal colors.
- Use shadcn components as source-owned primitives, not immutable vendor widgets. Small Alpha-specific variants such as `outline` user prompts or compact thread rows belong in the copied component source.
- Validate the first checkpoint at desktop three-pane, desktop chat-only, and narrow/mobile widths before broad feature work. The checkpoint should include empty, connected/idle, streaming, tool activity, selected thread, disconnected, and error states.
- Inspect and learn from Zed's GPL source, but do not copy GPL implementation text into Alpha without an explicit licensing decision. T3Code's MIT implementation is less restrictive, though its product-specific code should still be adapted rather than transplanted wholesale.
