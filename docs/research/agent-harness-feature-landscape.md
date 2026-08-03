# Agent harness user-facing feature landscape and Weave roadmap

**Research cutoff:** 2026-07-31<br>
**Weave snapshot:** commit `5e85018b9ea03a4cb49fba2d8a103810d91273b7`, plus the uncommitted worktree inspected on 2026-07-31<br>
**Audience:** Weave product and engineering roadmap planning

## Executive summary

The useful market pattern is no longer “chat that can edit files.” That baseline has commoditized. Strong agent harnesses increasingly combine five user-facing systems:

1. **A controllable work loop:** explicit plan/execute modes, granular approvals, steering while running, and visible progress.
2. **A recoverable workspace:** Git-native diffs, checkpoints or rewind, isolated worktrees/sandboxes, and resumable sessions.
3. **An extensible context system:** repository instructions, rules, skills, MCP/tools, memory, and on-demand context loading.
4. **A delegation system:** background or remote runs, parallel agents, notifications, mobile handoff, and a review queue.
5. **A trustworthy result surface:** artifact previews, code review, validation evidence, usage/cost visibility, and share/deploy handoff.

Weave already has more of the reliability substrate than its UI suggests: cross-shell Chat/Code/Notes products, durable run event replay, request-ID recovery, compaction, approvals, three execution profiles, a real local Portal with files/Git/worktrees/LSP/Jupyter/terminal, plan cards, image attachments, native notifications, and unusually rich document/canvas/code/ink editing. Its largest roadmap gaps are not another chat redesign or another model picker. They are:

- **no active MCP runtime or management UX** despite nearly universal competitor convergence;
- **no current Git-native review surface** (`proposalWorkflowEnabled` is hard-disabled);
- **no workspace checkpoint/rewind UX** tied to agent turns;
- **no first-class background-task control center or delegation UX** despite durable run plumbing;
- **no first-class browser/computer-use session**;
- **no user-facing workflow authoring/run inspection**, even though workflow RPC and backend code already exist;
- **no integrated cost, trace, and validation evidence view**;
- **large GUI–TUI capability skew**.

The recommended roadmap is therefore:

- **Now:** ship Git-native review, MCP runtime/management, turn-linked checkpoints, and a background-run inbox on top of existing seams.
- **Next:** add worktree-backed delegation, a visible browser/computer-use session, trust/usage telemetry, workflow UI, and targeted TUI parity.
- **Later:** broaden connectors/marketplace, collaborative sharing, mobile voice/remote control, and deployment/publishing.

The strategic position is not “be another IDE with AI.” It is **one durable, inspectable agent workspace across desktop, web, mobile, and terminal, with local execution through Portal and remote continuation through the server**.

## Methodology and limitations

This is a **representative landscape**, not a claim to enumerate every product or every SKU. The set intentionally mixes:

- coding-first terminal harnesses;
- IDE-integrated agents;
- cloud/background software-engineering agents;
- agent-native terminals and editors;
- leading general-purpose agent products.

Every external claim is based on a primary source: official documentation/help centers, first-party product pages, or official repositories. Sources were checked through 2026-07-31. Marketing labels were normalized to user-observable behavior; a feature was not credited merely because an underlying SDK could theoretically implement it.

The matrices use:

- **● Verified:** clearly evidenced in reviewed first-party material.
- **◐ Partial / variant-dependent:** preview, experimental, plan/edition/surface dependent, indirect through an extension, or materially narrower than the category.
- **? Not evidenced:** not found in the reviewed first-party material. This is **not** a proof that the feature does not exist.

Other cautions:

- Product capability changes quickly and can vary by plan, operating system, administrator policy, model, or rollout cohort.
- “Mobile” may mean a native app, a PWA, or mobile control of a cloud agent; the notes distinguish these where material.
- “Checkpoint” is reserved for restoring work/session state, not merely reopening chat history.
- “Multi-agent” is reserved for visible delegation/orchestration, not simply running several independent windows.
- Open-source repositories can expose capabilities ahead of a stable release; experimental or current-main behavior is marked partial when the boundary matters.
- **Roo Code is historical at the cutoff:** its official repository says the extension shut down on 2026-05-15 and is archived. It remains useful as a feature-design reference, not as an active roadmap competitor ([official repository](https://github.com/RooCodeInc/Roo-Code)).
- Former Windsurf URLs now redirect to current **Devin Desktop / Cascade** documentation. This report labels the lineage “Windsurf → Devin Desktop/Cascade” and uses the current redirected docs rather than assuming the old product boundary still holds ([current Cascade overview](https://docs.devin.ai/desktop/cascade/cascade)).

## Normalized user-facing taxonomy

| Capability | What counts for this report |
| --- | --- |
| Surface/platform | TUI/CLI, IDE, desktop, web, mobile, and API/headless surfaces a user can actually invoke. |
| Interaction model | Conversational turn-taking, inline editing, autonomous task execution, artifact-centric work, and take-over/handoff behavior. |
| Autonomy and permissions | Per-action approval, allow/deny rules, trust boundaries, plan/read-only modes, auto-run, and interruption/steering. |
| Planning | A visible plan/todo/task graph, read-only planning phase, or explicit plan-to-execute handoff. |
| Tools, MCP, skills, extensions | Built-in tools plus user-installable tools, MCP, skills, plugins, hooks, custom commands, and reusable workflows. |
| Context and memory | Repository instructions, user/project memory, compaction, session resumption, context meters, and controlled retrieval. |
| Repository/workspace navigation | Search/indexing, file mentions, diagnostics/LSP, Git state, worktrees, and multi-root/workspace selection. |
| Terminal/browser/computer use | Shell/PTY execution, long-running process control, web fetch/search, interactive browser, screenshots, or desktop GUI control. |
| Artifact and code-review UX | Diffs, changed-file trees, inline comments, document/canvas/app previews, validation output, and accept/revert flows. |
| Collaboration/multi-agent/delegation | Subagents, agent teams, parallel isolated tasks, human comments/feedback loops, and shared sessions. |
| Background/remote/async | Cloud agents, headless runs, schedules/triggers, notifications, handoff, and work that survives closing the client. |
| Checkpoints/recovery | Workspace rollback, chat+workspace rewind, run replay/resume, crash recovery, and retry from a known state. |
| Observability/cost | Token/context meters, cost/credits, task timelines, tool logs, traces, audit history, and validation evidence. |
| Integrations | GitHub/PRs, issue trackers, chat, cloud/data/business apps, connectors, and APIs. |
| Models/BYOK/local | Model selection, provider keys, gateways, local models, subscription auth, and per-mode model routing. |
| Security/sandboxing | OS/container/cloud isolation, network/filesystem restrictions, trusted folders, secret handling, and admin policy. |
| Customization | Rules/instructions, custom agents/modes, themes/keybindings, hooks, skills, prompt commands, and organization policy. |
| Mobile/voice | Native/PWA access, mobile task control, notifications, speech input, or full voice conversation. |
| Deployment/sharing | PR publication, app deploy/preview, artifact/chat/session sharing, workflow publication, and team handoff. |

## Cross-product findings

### 1. Plan mode is becoming a safety boundary, not just prose

Codex, Claude Code, Gemini CLI, GitHub Copilot CLI, Cline, OpenCode, Roo Code, Cursor-class IDE agents, Warp, Devin, and Replit all expose some version of plan/ask/read-only work before execution. The meaningful implementation pattern is: **inspect freely, prohibit mutations, make the plan visible, then hand off explicitly to execution**. Gemini CLI now documents an experimental read-only Plan Mode; GitHub Copilot CLI explicitly supports plan → “build on autopilot”; Cline carries the same conversation from Plan into Act ([Gemini CLI feature index](https://geminicli.com/docs/), [Copilot CLI overview](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-copilot-cli), [Cline Plan & Act](https://docs.cline.bot/core-workflows/plan-and-act)).

### 2. MCP + skills + rules is the dominant extensibility bundle

MCP alone is no longer a differentiator. Codex, Claude Code/Claude, Gemini CLI, GitHub Copilot, Cursor, current Cascade, OpenCode, Cline, Roo Code, OpenHands, Devin, Warp, and Zed all document MCP or MCP-adjacent integration. The stronger products separate:

- **always-on rules/instructions** for standing constraints;
- **skills** for on-demand procedures and supporting files;
- **MCP/tools** for external capabilities and data;
- **hooks/plugins/workflows** for lifecycle behavior and packaging.

Current Cascade’s documentation gives one of the clearest user-facing distinctions among Rules, `AGENTS.md`, Workflows, Skills, and Memories; GitHub Copilot similarly distinguishes repository instructions, path instructions, `AGENTS.md`, and skills ([Cascade memories and rules](https://docs.devin.ai/desktop/cascade/memories), [GitHub Copilot code-review customization](https://docs.github.com/en/copilot/concepts/agents/code-review), [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)).

### 3. Recovery is moving from chat history to reversible state

Cursor and Cline take automatic workspace snapshots; Gemini CLI has checkpoint/restore and conversation/file rewind; Replit checkpoints include files, environment, conversation, agent memory, and database state; Aider uses Git commits and `/undo`. These are much stronger promises than “you can reopen the conversation” ([Cursor checkpoints](https://docs.cursor.com/en/agent/chat/checkpoints), [Cline IDE workflow](https://docs.cline.bot/usage/ide), [Gemini CLI checkpointing](https://geminicli.com/docs/cli/checkpointing/), [Replit checkpoints and rollbacks](https://docs.replit.com/references/version-control/checkpoints-and-rollbacks), [Aider Git integration](https://aider.chat/docs/git.html)).

### 4. Background agents are becoming a queue with handoff and review

Cursor lets users start remote background agents from web/mobile, follow up, take over, review/merge, and share links. GitHub coding agents turn issues/prompts into pull requests and accept iteration through PR comments, including from GitHub Mobile. Devin supports managed parallel sessions, child sessions, schedules, mobile review, and session analysis. Replit has concurrent background tasks with dependencies. Codex spans local, cloud, desktop, and mobile Remote surfaces ([Cursor web/mobile](https://docs.cursor.com/en/background-agent/web-and-mobile), [GitHub third-party and cloud coding agents](https://docs.github.com/en/copilot/concepts/agents/about-third-party-coding-agents), [Devin recent updates](https://docs.devin.ai/release-notes/overview), [Replit task system](https://docs.replit.com/core-concepts/agent/task-system), [Codex/ChatGPT product documentation](https://learn.chatgpt.com/docs/features)).

The product unit is therefore increasingly **task → isolated execution → notification → review → follow-up/takeover**, not just a long streaming response.

### 5. The review surface is part of the harness

GitHub Copilot has first-class pull-request review; Codex documents code review and integrated Git/worktree flows; Cursor, Cline, Devin, Zed, OpenHands, and Aider all expose changed code through diff/review surfaces. Review is where users assess scope, evidence, and safety after autonomous work. A transcript plus raw tool logs is not enough ([GitHub Copilot code review](https://docs.github.com/en/copilot/concepts/agents/code-review), [Codex development workflows](https://learn.chatgpt.com/docs/features), [Cline official repository](https://github.com/cline/cline), [Devin session tools](https://docs.devin.ai/work-with-devin/devin-session-tools), [Zed Agent](https://zed.dev/docs/ai/zed-agent.html), [OpenHands key features](https://docs.openhands.dev/openhands/usage/key-features)).

### 6. Browser/computer use is splitting into three different capabilities

- **Fetch/search:** retrieve web text; common and low-interaction.
- **Interactive browser:** click/type/scroll, inspect screenshots/console, share takeover; common in Cline, Devin, Replit testing, and general agents.
- **General computer use:** control GUI apps or a virtual desktop; present in ChatGPT, Warp, and Microsoft Researcher, but often preview/permission-sensitive.

Weave should model these separately because they require different permissions, observability, and UI ([Cline browser](https://github.com/cline/cline/blob/main/README.md), [Devin session browser](https://docs.devin.ai/work-with-devin/devin-session-tools), [Warp capabilities](https://docs.warp.dev/agent-platform/capabilities), [Microsoft Researcher computer use](https://support.microsoft.com/en-us/microsoft-365-copilot/get-started-using-researcher-with-computer-use-in-microsoft-365-copilot-frontier), [ChatGPT features](https://learn.chatgpt.com/docs/features)).

### 7. Open model choice is concentrated in independent/local harnesses

Aider, Cline, OpenCode, Zed, and OpenHands emphasize provider choice, API keys/gateways, or local models. Lab-owned products generally offer curated model choice inside their own provider or enterprise cloud integrations. Cline explicitly supports hosted providers, OpenAI-compatible endpoints, Ollama, and LM Studio; Aider documents a broad provider matrix; Zed supports hosted, API-key, gateway, subscription, and local paths ([Cline official repository](https://github.com/cline/cline), [Aider docs](https://aider.chat/docs/), [OpenCode models](https://opencode.ai/v2/docs/models), [Zed AI overview](https://zed.dev/docs/ai/overview)).

### 8. General-purpose agents are converging on the same harness primitives

ChatGPT now exposes projects, long-running work, scheduled tasks, browser/computer use, plugins, files, voice, artifacts/sites, and Codex surfaces. Claude combines Research, artifacts, projects, desktop/local extensions, remote connectors, web, desktop, mobile, and voice. Gemini combines Deep Research, Canvas, Gems, Connected Apps, schedules, memory/personalization, mobile actions, and Live. Microsoft 365 Copilot combines agents, Researcher/Analyst, computer use in a secure virtual environment, connectors, and natural-language workflows ([ChatGPT features](https://learn.chatgpt.com/docs/features), [Claude Research](https://support.anthropic.com/en/articles/11088861-using-research-on-claude-ai), [Claude artifacts](https://support.anthropic.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them), [Gemini Apps help index](https://support.google.com/gemini/), [Microsoft Copilot agents](https://support.microsoft.com/en-us/Microsoft-365-Copilot/get-started-with-agents-in-the-microsoft-365-copilot-app)).

This matters for Weave: document/data/browser/workflow artifacts are not side features anymore; they are becoming the same harness architecture applied outside code.

## Product capability matrix A: work loop and execution

The surface column names the primary documented entry points. Symbols summarize the capability at the product-family level; feature availability can vary by surface and plan.

| Product | Surface(s) | Autonomy / permissions | Planning | Repo / workspace navigation | Terminal / browser / computer | Artifact / review UX | Background / remote / async | Checkpoint / recovery |
| --- | --- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| [Codex](https://learn.chatgpt.com/docs/features) | CLI, IDE, desktop, cloud, GitHub, mobile Remote | ● | ● | ● | ● | ● | ● | ◐ |
| [ChatGPT / Work](https://learn.chatgpt.com/docs/features) | Web, desktop, mobile, browser extension | ● | ● | ◐ | ● | ● | ● | ◐ |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code/cli-usage) | CLI, IDE integrations, headless/SDK | ● | ● | ● | ● | ● | ◐ | ◐ |
| [Claude](https://support.anthropic.com/en/articles/11725091-when-to-use-desktop-and-web-connectors) | Web, desktop, iOS, Android | ◐ | ◐ | ◐ | ◐ | ● | ◐ | ? |
| [Gemini CLI](https://geminicli.com/docs/) | TUI/CLI, headless, IDE integration | ● | ◐ | ● | ● | ◐ | ● | ● |
| [Gemini Apps](https://support.google.com/gemini/) | Web, macOS app, iOS, Android, wearables | ◐ | ◐ | ◐ | ◐ | ● | ● | ? |
| [GitHub Copilot](https://docs.github.com/en/copilot/concepts) | IDEs, CLI, GitHub web, GitHub Mobile, API/SDK | ● | ● | ● | ● | ● | ● | ● |
| [Cursor](https://docs.cursor.com/en/agent/tools) | Desktop IDE, CLI, web, mobile PWA | ● | ● | ● | ● | ● | ● | ● |
| [Windsurf → Devin Desktop/Cascade](https://docs.devin.ai/desktop/cascade/cascade) | Desktop IDE, JetBrains plugins, command center | ● | ● | ● | ● | ● | ◐ | ● |
| [OpenCode](https://opencode.ai/docs/) | TUI, CLI/headless, desktop, web, GitHub Action | ● | ● | ● | ◐ | ◐ | ◐ | ◐ |
| [Cline](https://github.com/cline/cline) | VS Code, JetBrains, CLI/TUI, SDK, ACP | ● | ● | ● | ● | ● | ● | ● |
| [Roo Code — discontinued](https://github.com/RooCodeInc/Roo-Code) | VS Code extension (historical) | ● | ● | ● | ● | ● | ◐ | ● |
| [Aider](https://aider.chat/docs/) | TUI/CLI, experimental local browser UI, editor watch mode | ◐ | ● | ● | ◐ | ● | ◐ | ● |
| [OpenHands / Agent Canvas](https://github.com/OpenHands/OpenHands) | Self-hosted web canvas, agent servers, cloud/remote backends | ● | ◐ | ● | ● | ● | ● | ◐ |
| [Devin](https://docs.devin.ai/get-started/devin-intro) | Web workspace/IDE, API/MCP, mobile web | ● | ● | ● | ● | ● | ● | ◐ |
| [Replit Agent](https://docs.replit.com/core-concepts/agent/task-system) | Web IDE, desktop/mobile access, cloud runtime | ● | ● | ● | ● | ● | ● | ● |
| [Warp](https://docs.warp.dev/agent-platform/capabilities) | Desktop terminal, local/cloud agents | ● | ● | ● | ● | ◐ | ● | ◐ |
| [Zed](https://zed.dev/docs/ai/agents) | Desktop editor, native/ACP agents, terminal threads | ● | ◐ | ● | ◐ | ● | ● | ◐ |
| [Microsoft 365 Copilot](https://support.microsoft.com/en-us/Microsoft-365-Copilot/get-started-with-agents-in-the-microsoft-365-copilot-app) | Web, desktop, mobile, Microsoft 365 apps | ● | ◐ | ? | ◐ | ● | ● | ? |

## Product capability matrix B: platform, context, and distribution

| Product | MCP / tools / skills / extensions | Context / memory / customization | Collaboration / multi-agent | Observability / cost | Integrations | Models / BYOK / local | Security / sandboxing | Mobile / voice | Share / deploy |
| --- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| [Codex](https://learn.chatgpt.com/docs/features) | ● | ● | ● | ◐ | ● | ◐ | ● | ● | ● |
| [ChatGPT / Work](https://learn.chatgpt.com/docs/features) | ● | ● | ◐ | ◐ | ● | ◐ | ● | ● | ● |
| [Claude Code](https://docs.anthropic.com/en/docs/mcp) | ● | ● | ● | ● | ● | ◐ | ● | ◐ | ● |
| [Claude](https://support.anthropic.com/en/articles/11725091-when-to-use-desktop-and-web-connectors) | ● | ● | ◐ | ◐ | ● | ? | ● | ● | ● |
| [Gemini CLI](https://geminicli.com/docs/) | ● | ● | ◐ | ● | ● | ◐ | ● | ? | ◐ |
| [Gemini Apps](https://support.google.com/gemini/) | ● | ● | ◐ | ◐ | ● | ? | ● | ● | ● |
| [GitHub Copilot](https://docs.github.com/en/copilot/concepts) | ● | ● | ● | ● | ● | ◐ | ● | ● | ● |
| [Cursor](https://docs.cursor.com/background-agent) | ● | ● | ◐ | ● | ● | ◐ | ● | ● | ● |
| [Windsurf → Devin Desktop/Cascade](https://docs.devin.ai/desktop/cascade/memories) | ● | ● | ◐ | ● | ● | ◐ | ● | ◐ | ● |
| [OpenCode](https://opencode.ai/docs/config/) | ● | ● | ● | ◐ | ● | ● | ◐ | ? | ● |
| [Cline](https://github.com/cline/cline/blob/main/apps/cli/README.md) | ● | ● | ● | ● | ● | ● | ● | ◐ | ◐ |
| [Roo Code — discontinued](https://roocodeinc.github.io/Roo-Code/features/custom-modes/) | ● | ● | ● | ● | ● | ● | ◐ | ? | ◐ |
| [Aider](https://aider.chat/docs/) | ◐ | ◐ | ? | ● | ● | ● | ◐ | ● | ? |
| [OpenHands / Agent Canvas](https://github.com/OpenHands/OpenHands) | ● | ● | ● | ◐ | ● | ● | ● | ◐ | ● |
| [Devin](https://docs.devin.ai/work-with-devin/advanced-capabilities) | ● | ● | ● | ● | ● | ◐ | ● | ● | ● |
| [Replit Agent](https://docs.replit.com/replitai/managing-connectors) | ◐ | ● | ● | ● | ● | ◐ | ● | ● | ● |
| [Warp](https://docs.warp.dev/knowledge-and-collaboration/warp-drive/agent-mode-context) | ● | ● | ● | ● | ● | ◐ | ● | ◐ | ◐ |
| [Zed](https://zed.dev/docs/ai/zed-agent.html) | ● | ● | ● | ◐ | ● | ● | ● | ? | ◐ |
| [Microsoft 365 Copilot](https://support.microsoft.com/en-us/Microsoft-365-Copilot/get-started-with-agents-in-the-microsoft-365-copilot-app) | ● | ● | ● | ● | ● | ◐ | ● | ● | ● |

## Product evidence notes

These notes explain the most material matrix judgments and keep the matrices from hiding surface/variant boundaries.

### Codex

The current first-party documentation presents Codex across ChatGPT desktop, CLI, IDE extension, cloud, GitHub, Slack, Linear, SDK/App Server/MCP Server, and mobile Remote. It documents plan mode, goals/long-running work, code review, integrated terminal, local/cloud environments, Git worktrees, skills/plugins/hooks/MCP, subagents, permission profiles, sandboxing, computer use, and record/replay. Some recovery and observability behavior is surface-specific, hence partial rather than universal credit ([ChatGPT/Codex feature index](https://learn.chatgpt.com/docs/features), [Codex CLI](https://learn.chatgpt.com/docs/codex/cli), [Codex cloud](https://learn.chatgpt.com/docs/cloud), [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)).

### ChatGPT / Work

ChatGPT’s current feature index includes projects/chats, long-running work, goals, scheduled tasks, notifications, browser, computer use, voice, plugins, web search, image generation/input, file work, visualizations, sites, and office-document plugins. It is broad and artifact-oriented, but repository navigation and workspace restoration are not its primary contract ([ChatGPT features](https://learn.chatgpt.com/docs/features)).

### Claude Code

Claude Code exposes interactive and headless CLI modes, session resume, explicit allowed/disallowed tools, plan permission mode, JSON/stream output, MCP, model selection, and enterprise Bedrock/Vertex/gateway paths. The broader official Claude Code docs and current product surface also cover repository memory/instructions, hooks, skills, subagents, and permission controls; model choice remains Claude-centered even when routed through enterprise infrastructure ([CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-usage), [setup and enterprise providers](https://docs.anthropic.com/en/docs/claude-code/getting-started), [MCP](https://docs.anthropic.com/en/docs/mcp), [LLM gateway](https://docs.anthropic.com/en/docs/claude-code/llm-gateway)).

### Claude

Claude supports web, desktop, and iOS/Android, with Research across web/desktop/mobile, shareable interactive artifacts, remote connectors, local desktop extensions, and mobile voice. These capabilities are frequently plan-dependent and do not form a code-workspace recovery system, so several cells are partial ([Research](https://support.anthropic.com/en/articles/11088861-using-research-on-claude-ai), [artifacts](https://support.anthropic.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them), [desktop and web connectors](https://support.anthropic.com/en/articles/11725091-when-to-use-desktop-and-web-connectors), [mobile voice](https://support.anthropic.com/en/articles/11101966-using-voice-mode-on-claude-mobile-apps)).

### Gemini CLI

Gemini CLI’s current feature index explicitly lists extensions, agent skills, checkpointing, headless mode, hooks, IDE integration, MCP, model routing/selection, experimental Plan Mode, experimental subagents/remote subagents, rewind, sandboxing, sessions/history, task planning, web search/fetch, telemetry, and automation. Tool safety includes approval prompts, trusted folders, and OS/container sandboxes; checkpointing can restore both project state and conversation/tool history ([documentation index](https://geminicli.com/docs/), [tools](https://geminicli.com/docs/reference/tools/), [checkpointing](https://geminicli.com/docs/cli/checkpointing/), [sandboxing](https://geminicli.com/docs/cli/sandbox/), [commands/session rewind](https://geminicli.com/docs/reference/commands/)).

### Gemini Apps

Gemini Apps documents web and mobile apps, Gemini Live, screen actions and multi-step Android actions, Deep Research, Canvas, Gems, connected apps, GitHub repository import, schedules, skills, personalization/memory, sharing, and export. These are broad general-agent capabilities, but they do not evidence a local code-agent permission/checkpoint loop ([Gemini Apps help index](https://support.google.com/gemini/), [scheduled actions](https://support.google.com/gemini/answer/16316416)).

### GitHub Copilot

GitHub Copilot spans IDE agents, a full CLI with interactive/plan/autopilot modes, a GitHub cloud coding agent, code review, GitHub Mobile initiation, custom agents/subagents, skills/plugins/MCP, memory, context compaction/checkpoints, local/cloud sandboxes, enterprise policy, usage limits, and PR-centered handoff. Cloud agents run in ephemeral GitHub Actions environments and return pull requests for review/iteration ([Copilot concepts](https://docs.github.com/en/copilot/concepts), [CLI](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-copilot-cli), [autopilot](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/autopilot), [context/checkpoints](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/context-management), [cloud agent](https://docs.github.com/en/copilot/concepts/agents/cloud-agent), [code review](https://docs.github.com/en/copilot/concepts/agents/code-review)).

### Cursor

Cursor’s foreground agent exposes codebase/web search, edits, terminal, MCP, guardrails, and auto-run. Project/user rules and approved memories persist context. Automatic checkpoints restore agent edits. Background agents run asynchronously in isolated remote VMs, auto-run commands, support follow-up/takeover, and can be started from web or mobile PWA, then reviewed/merged in the desktop IDE ([agent tools](https://docs.cursor.com/en/agent/tools), [rules](https://docs.cursor.com/context/rules), [memories](https://docs.cursor.com/en/context/memories), [checkpoints](https://docs.cursor.com/en/agent/chat/checkpoints), [background agents](https://docs.cursor.com/background-agent), [web/mobile](https://docs.cursor.com/en/background-agent/web-and-mobile)).

### Windsurf → Devin Desktop/Cascade

The current redirected documentation describes Cascade inside Devin Desktop with Code/Chat modes, a continuously refined plan/todo list, queued messages, tools/MCP, voice input, named checkpoints/revert, real-time awareness, lint integration, conversation sharing, previous-conversation mentions, simultaneous Cascades, worktrees, workflows, skills, hooks, rules, memories, and one-click app deployment. Some features are legacy-Cascade-only, plan/edition dependent, or transitioning to Devin Local, so family-level cells are sometimes partial ([Cascade overview](https://docs.devin.ai/desktop/cascade/cascade), [memories/rules/skills/workflows distinctions](https://docs.devin.ai/desktop/cascade/memories), [MCP](https://docs.devin.ai/desktop/cascade/mcp)).

### OpenCode

OpenCode documents primary agents and subagents, Build/Plan modes, granular allow/ask/deny permissions for tools and commands, skills, MCP, LSP, web search, multiple providers/models, manual/automatic session sharing, TUI, headless CLI, desktop, web, and GitHub Action surfaces. The web server and attached TUI can share the same session state. Browser/computer control and automatic workspace snapshots were not clearly evidenced in the reviewed current docs ([agents](https://opencode.ai/docs/agents), [configuration/sharing/surfaces](https://opencode.ai/docs/config/), [web](https://dev.opencode.ai/docs/web/), [models/providers](https://opencode.ai/v2/docs/models)).

### Cline

Cline’s shared core now spans VS Code, JetBrains, CLI/TUI, SDK, and ACP. Official docs/repo evidence Plan/Act, per-change and per-command approval or auto-approve, syntax-highlighted diffs, browser control with screenshots/console, terminal and long-running processes, checkpoints/undo, rules, skills, plugins, MCP, many hosted and local providers, token/cost tracking, subagents/teams, schedules, and chat connectors. Mobile is indirect through Telegram/Google Chat/WhatsApp connectors rather than a first-class Cline mobile workspace ([official repository](https://github.com/cline/cline), [CLI README](https://github.com/cline/cline/blob/main/apps/cli/README.md), [Plan & Act](https://docs.cline.bot/core-workflows/plan-and-act), [IDE/checkpoints](https://docs.cline.bot/usage/ide)).

### Roo Code — discontinued

Before shutdown, Roo Code exposed Code/Architect/Ask/Debug/custom modes, auto-approval, Boomerang/orchestrator tasks, checkpoints, codebase indexing, context condensing, MCP, marketplace, skills, slash commands, todo lists, worktrees, terminal integration, model profiles, and cost visibility. The official repository was archived and states the extension shut down on 2026-05-15, so these are historical design references only ([official archived repository and shutdown notice](https://github.com/RooCodeInc/Roo-Code), [official archived custom-mode documentation](https://roocodeinc.github.io/Roo-Code/features/custom-modes/), [official archived MCP documentation](https://roocodeinc.github.io/Roo-Code/features/mcp/using-mcp-in-roo/)).

### Aider

Aider is a Git-centric terminal pair programmer with code/ask/architect/help modes, repository maps, explicit file/context management, automatic commits, `/diff` and `/undo`, configurable lint/test loops, broad provider/BYOK/local-model support, token reporting, shell commands, web-page ingestion, voice input, IDE watch mode, and an experimental local browser UI. It does not present a modern multi-agent, MCP, remote-task, or sandbox control plane in the reviewed docs ([documentation index](https://aider.chat/docs/), [chat modes](https://aider.chat/docs/usage/modes.html), [Git](https://aider.chat/docs/git.html), [lint/test](https://aider.chat/docs/usage/lint-test.html), [commands](https://aider.chat/docs/usage/commands.html), [browser UI](https://aider.chat/docs/usage/browser.html)).

### OpenHands / Agent Canvas

The current OpenHands repository describes Agent Canvas as a self-hosted control center for OpenHands and ACP-compatible agents across local, Docker, VM, cloud, and remote backends, with scheduled/event automations and integrations. The current product UI documents chat, changes, embedded VS Code, terminal, app preview, and browser tabs; Docker is the recommended local sandbox. The exact recovery/checkpoint and mobile contracts were not clearly evidenced in the reviewed current material ([Agent Canvas repository](https://github.com/OpenHands/OpenHands), [key features](https://docs.openhands.dev/openhands/usage/key-features), [Docker sandbox](https://docs.openhands.dev/openhands/usage/sandboxes/docker)).

### Devin

Devin exposes a conversational cloud software-engineering session with an embedded IDE, shell, and interactive browser that users can watch and take over. It supports planning, parallel/child sessions, skills, playbooks, organization knowledge, MCP/API session control, schedules, event search/analysis, PR review, integrations, mobile review/share, and voice follow-ups. Model/BYOK/local execution is not the core user contract, and recovery is more session/snapshot oriented than an explicit turn-level local rollback in the reviewed docs ([introduction](https://docs.devin.ai/get-started/devin-intro), [session tools](https://docs.devin.ai/work-with-devin/devin-session-tools), [skills](https://docs.devin.ai/product-guides/skills), [MCP/automation](https://docs.devin.ai/work-with-devin/devin-mcp), [recent updates](https://docs.devin.ai/release-notes/overview)).

### Replit Agent

Replit Agent combines planning and dependency-aware background tasks, cloud workspace editing, browser-based app testing, collaboration, connectors, memory, comprehensive checkpoints/rollback, cost per checkpoint, and one-click publishing/deployment. Checkpoints include files, conversation, environment configuration, agent memory, and database contents. Provider choice is mostly platform-managed, with limited enterprise BYOK rather than a general local-model harness ([task system](https://docs.replit.com/core-concepts/agent/task-system), [checkpoints](https://docs.replit.com/references/version-control/checkpoints-and-rollbacks), [connectors and enterprise BYOK](https://docs.replit.com/replitai/managing-connectors), [Agent 3 update](https://docs.replit.com/updates/2025/09/12/changelog)).

### Warp

Warp’s agent platform documents slash commands, skills, editable plans, task lists, model choice, rules, full interactive terminal use, computer use, MCP, codebase indexing, profiles/permissions, web search, local/cloud agents, and shared Warp Drive context. Its terminal handoff is unusually explicit: user and agent can take over the same live PTY. Review/checkpoint, mobile, and deployment behavior is less central or variant-dependent ([capability overview](https://docs.warp.dev/agent-platform/capabilities), [full terminal use](https://docs.warp.dev/agent-platform/capabilities/full-terminal-use), [MCP](https://docs.warp.dev/agent-platform/capabilities/mcp), [Warp Drive context](https://docs.warp.dev/knowledge-and-collaboration/warp-drive/agent-mode-context)).

### Zed

Zed supports a native agent, ACP external agents, and terminal threads in one Threads Sidebar; multiple threads can run across projects/worktrees. The native agent has project search/edit/terminal/diagnostics, tool permissions and sandboxing, profiles, skills, instructions, MCP, subagents, and a review UI. Zed supports hosted providers, API keys, subscriptions, gateways, and local models. Fetch/search is supported, but general computer use, mobile, and deploy/share are not core evidenced surfaces ([AI overview](https://zed.dev/docs/ai/overview), [agent paths](https://zed.dev/docs/ai/agents), [Zed Agent](https://zed.dev/docs/ai/zed-agent.html), [tools and subagents](https://zed.dev/docs/ai/tools), [privacy/security](https://zed.dev/docs/ai/privacy-and-security)).

### Microsoft 365 Copilot

Microsoft 365 Copilot provides general chat plus installable/shareable agents, Researcher and Analyst, connectors, Microsoft 365-grounded context, and natural-language Workflows with schedules/events and a visual designer. Researcher with Computer Use (Frontier) runs browser and terminal actions in a temporary virtual computer and asks for confirmation before sensitive actions. This is a business-work harness rather than a repository workspace, but it is strong evidence for secure remote computer-use, artifacts, workflow authoring, sharing, and admin policy ([agents](https://support.microsoft.com/en-us/Microsoft-365-Copilot/get-started-with-agents-in-the-microsoft-365-copilot-app), [Researcher](https://support.microsoft.com/en-us/microsoft-365-copilot/get-started-with-researcher-in-microsoft-365-copilot), [Researcher computer use](https://support.microsoft.com/en-us/microsoft-365-copilot/get-started-using-researcher-with-computer-use-in-microsoft-365-copilot-frontier), [Workflows](https://support.microsoft.com/en-US/Microsoft-365-Copilot/get-started-with-workflows-in-microsoft-365-copilot)).

## Weave current-state map

Status meanings:

- **Current:** an active user-facing path is evidenced across the relevant client/runtime.
- **Partial:** meaningful substrate or a narrower surface exists, but the normalized capability is not complete.
- **Missing:** searched relevant paths and found no active user-facing implementation.
- **Unclear:** code suggests something may exist, but the user-facing path or production contract could not be established.

### Summary

| Normalized capability | Weave status | Concrete evidence | Product interpretation |
| --- | --- | --- | --- |
| Surface/platform | **Current** | `README.md`; `desktop/package.json`; `web/package.json`; `mobile/package.json`; `tui/deno.json`; `packages/client/src/lib/products.ts` | Electron, web, Capacitor iOS, and TUI exist. The shared GUI has Code, Notes, and root Chat products. TUI is materially narrower. |
| Interaction model | **Current** | `packages/client/src/components/chat/AssistantChat.tsx`; `packages/client/src/lib/chat-steering.ts`; `packages/client/src/components/chat/AskUserCard.tsx`; `packages/client/src/lib/rpc-chat-transport.ts` | Streaming chat, tool activity, ask-user, steer-while-running, cancel, attachments, model/reasoning/speed selection. |
| Autonomy and permissions | **Current** | `portal/src/execution-policy.ts`; `packages/client/src/components/chat/tool-approval.ts`; `packages/protocol/src/v2/dtos.ts`; `packages/client/src/components/chat/AssistantChat.tsx` | `observe`, sandboxed `workspace`, and unrestricted `host` profiles; approval-request/response UI. Workspace sandbox uses Seatbelt on macOS and bubblewrap on Linux with network denied. |
| Planning | **Partial** | `packages/client/src/components/chat/AssistantChat.tsx`; `packages/client/src/components/chat/PlanSidebar.tsx`; `packages/client/src/lib/plan-state.ts`; `packages/client/src/stores/chat-store.ts`; `portal/src/execution-policy.ts` | The execution menu exposes a selectable **Plan / observe** profile, and Portal enforces that observe is read-only with no shell execution. Threads also have a visible, persisted plan with step status and optional artifact path. The remaining gap is an explicit plan→execute review/approval handoff. |
| Tools, MCP, skills, extensions | **Partial** | `server/src/modules/user-artifacts/repository.ts`; `packages/client/src/lib/prompts-api.ts`; `portal/src/main.ts`; `portal/src/context_discovery_test.ts`; `packages/protocol/src/v2/contracts.ts` | Skills, prompts, `AGENTS.md`, context discovery, and rich Portal tools exist. **MCP does not:** `mcp` appears only as a context-file kind; no active server discovery, transport, tool registry, status, auth, or management UX was evidenced. |
| Context and memory | **Partial** | `packages/client/src/components/chat/AssistantChat.tsx`; `packages/client/src/lib/thread-compaction-display.ts`; `server/src/agent/thread-compaction.ts`; `server/src/agent/run-repository.ts` | Context meter, durable thread history, resume/replay, and compaction exist. No user-facing cross-thread/project memory capture, inspection, approval, or forgetting UX was evidenced. |
| Repo/workspace navigation | **Current** | `server/src/modules/code/routes/projects.ts`; `server/src/modules/code/projects/git-state.ts`; `server/src/modules/code/git/service.ts`; `packages/client/src/lib/chat-state-api.ts`; `portal/src/main.ts`; `portal/src/lsp.ts` | Project/workspace model, Git status/diff/log/show/fetch/pull, branches/worktrees, file list/read/write/watch, editor, LSP, and Jupyter are real seams. |
| Terminal | **Current** | `packages/client/src/components/terminal/TerminalPanel.tsx`; `packages/client/src/components/terminal/XtermTerminalView.tsx`; `portal/src/terminal.ts`; `packages/protocol/src/v2/contracts.ts` | Persistent tmux-backed workspace/general terminals with attach/detach/replay and shared GUI presentation. |
| Browser/computer use | **Missing** | Search across `packages/client`, `desktop`, `web`, `mobile`, `portal`, server modules, and protocol found no browser-session/computer-use contract or UI. | Web fetch through an agent tool is not equivalent to a visible interactive browser or computer session. |
| Artifact UX | **Current** | `packages/client/src/components/editor/CoppermindDocumentEditor.tsx`; `packages/client/src/components/editor/ExcalidrawDocumentEditor.tsx`; `packages/client/src/lib/coppermind-*`; `packages/client/src/lib/jupyter-output.ts`; `packages/client/src/lib/note-display.ts` | Rich document, canvas/Excalidraw, code, ink, notebook output, Notes, and image attachment surfaces are a real differentiator. |
| Code-review UX | **Missing** | `packages/client/src/lib/proposal-workflow.ts`; `packages/client/src/components/proposals/ProposalReviewPane.tsx`; `portal/src/main.ts` Git tools | Proposal-era code remains, but `proposalWorkflowEnabled` is hard-coded `false`; it is dormant/inert, not a current review feature. Portal already supplies much of the Git substrate needed for a replacement. |
| Collaboration/multi-agent/delegation | **Missing** | Multiple independent threads exist in `packages/client/src/stores/chat-store.ts`, but no active subagent/delegation/team contract was evidenced in client, protocol, modules, Portal, or TUI. | Parallel chats are not multi-agent delegation. Worktrees exist but are not connected to a delegation UX. |
| Background/remote/async | **Partial** | `server/src/agent/run-coordinator.ts`; `server/src/agent/run-repository.ts`; `packages/client/src/lib/rpc-chat-transport.ts`; `server/src/modules/notifications/service.ts`; `packages/client/src/lib/notifications/*` | Runs persist server-side and replay by ordered event; lost starts recover by request ID; completion/action notifications exist. There is no clear user-facing “dispatch/background/take over/review queue” product loop. |
| Checkpoints/recovery | **Partial** | `server/src/agent/run-repository.ts`; `server/src/agent/run-coordinator.ts`; `packages/client/src/lib/rpc-chat-transport.ts`; `portal/src/command-sessions.ts`; `portal/src/terminal.ts` | Strong run and terminal replay/recovery. No turn-linked snapshot of workspace changes or one-click chat/workspace rewind. Generic interrupted-run continuation is not the same as approval recovery. |
| Observability/cost | **Partial** | `packages/client/src/components/chat/AssistantChat.tsx` context meter; `packages/client/src/components/chat/turn-timing.ts`; `tui/src/types.ts`; `server/src/agent/evals/*`; run metadata/repository | Context percentage, usage data shapes, timing, durable events, eval machinery, and trace metadata exist. No coherent user-facing cost/credits, run timeline, policy decisions, validation evidence, or audit explorer. |
| Integrations | **Partial** | Portal/Git and notes modules; `server/src/modules/index.ts`; `server/src/workflows/*`; `packages/protocol/src/v2/contracts.ts` | Strong local execution and Git integration; workflow backend/RPC exists. No broad connector system or active MCP bridge. |
| Models/BYOK/local | **Partial** | `packages/client/src/lib/models.ts`; `packages/client/src/components/chat/AssistantChat.tsx`; `tui/src/models.ts`; `server/src/rpc/methods.ts` | GUI exposes model, reasoning effort, and speed; TUI resolves a configured model but lacks picker parity. Provider/BYOK/local-model setup is not a polished cross-surface user feature. |
| Security/sandboxing | **Current** | `portal/src/execution-policy.ts`; approval DTOs/contracts; `server/src/modules/notes/storage/resolver.ts` secret-key redaction | Concrete least-privilege profiles, OS sandbox invocation, network denial, tool denial, and approvals. Linux sandbox support should remain operationally qualified until live-tested on target hosts. |
| Customization | **Partial** | `server/src/modules/user-artifacts/repository.ts`; `packages/client/src/lib/prompts-api.ts`; `packages/client/src/lib/slash-commands.ts`; `portal/src/main.ts`; `portal/src/context_discovery_test.ts`; `packages/client/src/lib/shortcuts/*` | Skills, prompts, `AGENTS.md`, slash expansion, shortcuts, and themes exist, but there is no unified customization manager, activation/explanation UX, hook/plugin packaging, or MCP UI. |
| Mobile/voice | **Partial** | `mobile/package.json`; `mobile/src`; `packages/client/src/lib/mobile-connection-adapter.ts`; local notifications | Real Capacitor iOS shell and shared client; no voice input/conversation, mobile task-control specialization, or verified Android package. |
| Deployment/sharing | **Missing** | `scripts/dokploy-server.ts` and `server:deploy` are operator deployment, not an end-user share/deploy feature; no active session/artifact publishing contract was evidenced. | Keep infrastructure deployment separate from user-facing preview, share, PR, or artifact publication. |
| Workflow authoring/run UI | **Missing** | `server/src/workflows/*`; `workflow.definition.*` and `workflow.run.*` in `packages/protocol/src/v2/contracts.ts`; no matching client calls/components | Backend definition/run/start/list/get/cancel/subscribe is substantial, but no client authoring, trigger, run inspection, or intervention surface was evidenced. |

### Surface parity detail

The GUI shells share `@weave/client`, so Electron, web, and Capacitor inherit most Chat/Code/Notes behavior. The TUI is intentionally narrower. Its source evidences project/workspace detection, thread creation/resume/archive, streamed text/tool rendering, model display, and context percentage (`tui/src/main.ts`, `tui/src/components/app.ts`, `tui/src/rendering.ts`, `tui/src/models.ts`). It does **not** evidence GUI parity for:

- tool approval cards;
- execution-profile selection;
- plan cards/artifacts;
- interactive model/reasoning/speed selection;
- image attachments;
- editor/terminal panels;
- notifications;
- ask-user structured forms;
- workspace/Git management.

This is not inherently a defect. The roadmap should decide whether the TUI is a focused remote-control surface or a first-class peer; accidental ambiguity will create recurring parity debt.

### Strong seams to build on

1. **Portal is already a local agent runtime boundary.** It owns file, Git, worktree, terminal, LSP, and Jupyter contracts instead of burying them in an IDE renderer.
2. **The protocol is already eventful and bidirectional.** Run events, approvals, terminal events, file watch, LSP, Jupyter, and workflow subscriptions are concrete foundations for background work and live takeover.
3. **The run repository is already durable.** This substantially lowers the cost of building a task inbox, reconnect, and audit timeline.
4. **Workspaces and worktrees are already domain objects.** Multi-agent isolation need not start from raw filesystem conventions.
5. **The shared client already hosts rich artifacts.** Weave can unify code, notes, canvases, notebook output, and agent work rather than becoming a narrower IDE clone.
6. **Security profiles are concrete.** New MCP/browser/delegation features can integrate with an existing `observe | workspace | host` policy instead of inventing a second permission model.

## Gap-to-opportunity map

| Market expectation | Weave gap | Existing seam | Smallest credible product slice |
| --- | --- | --- | --- |
| Review autonomous work in one place | Proposal review is disabled; no current Git review | Portal Git status/diff/log/show; workspace model; dormant diff components | Working-tree changed-file list + unified diff + per-file accept/stage/restore + “send review feedback to thread.” |
| Extend with standard tools | No active MCP runtime/UI | User artifacts, prompts/skills, protocol/RPC, approval UI | User-scoped stdio + Streamable HTTP MCP config, status/tool list, per-server enable/disable, tool calls routed through existing approvals. |
| Undo an agent turn safely | Run replay exists; workspace rollback does not | Git/worktree tools, run IDs/events, message IDs | Snapshot changed paths before first mutation in a turn; show compare/restore from the turn footer; keep Git history untouched. |
| Delegate and come back later | Runs persist, but there is no task inbox/handoff | Run repository, request-ID recovery, notifications, thread sidebar | “Run in background,” active/needs-attention/completed filters, notification deep-link, steer/cancel/take over. |
| Parallel agents without races | No subagent UX | Worktree create/list/switch/remove; workspace/thread ownership | Spawn one child task into one new worktree, display parent/child relation, gather result and diff; no recursive teams initially. |
| See/test the running app | No browser/computer surface | Portal connections, binary transfer, client panes, approval/profile system | Portal-hosted Playwright browser session with screenshot/console/network events and explicit click/type approval classes. |
| Know what happened and what it cost | Data exists but no coherent UI | Run events, context usage, turn timing, evals, trace metadata | Run timeline drawer with model/profile/context, tool duration/status, approval decisions, validation commands, token usage; cost only when provider pricing is known. |
| Build repeatable automations | Backend exists; no client | `server/src/workflows`, workflow RPC/contracts, notifications | Read-only workflow list + run history first; then manual trigger/cancel; authoring after real workflows prove the schema. |
| Durable project knowledge | No memory management UX | Skills/prompts/AGENTS discovery, notes/artifacts | “Remember as…” action that writes a reviewable project rule/skill/note; no opaque auto-memory initially. |
| Cross-surface control | TUI/mobile lag GUI | Shared server/protocol; notifications; TUI stream | Define explicit remote-control parity: list active runs, inspect status/plan, steer/cancel, respond to approvals/questions. |

## Prioritization criteria

Score roadmap candidates against six criteria:

1. **Trust impact:** Does it make autonomous work safer to inspect, constrain, undo, or verify?
2. **Existing-seam leverage:** Can Weave expose value from code that already exists rather than create a parallel subsystem?
3. **Cross-product leverage:** Does it improve Code, Notes, and general Chat, or unlock multiple future integrations?
4. **Loop completeness:** Does it close a user journey from request through execution to review/recovery?
5. **Differentiation:** Does it strengthen Weave’s local+remote, multi-surface workspace rather than chase IDE incumbents feature-for-feature?
6. **Operational risk:** Can it ship as a narrow, reversible slice with explicit permissions, migration boundaries, and measurable behavior?

Using those criteria, review/recovery/extensibility/background control rank above autocomplete, broad connector catalogs, or cosmetic chat changes.

## Prioritized Weave roadmap

### Now: complete the trustworthy single-agent loop

#### N1. Git-native Review surface

**Outcome:** every code task ends in a reviewable, workspace-scoped diff, independent of whether the agent created an explicit proposal.

**Thin slice**

- Add a `Review` main-pane mode for the active Git workspace.
- Support working tree vs `HEAD` first; changed-file tree + unified diff.
- Add stage/unstage and safe file restore with explicit confirmation.
- Persist human review comments keyed by workspace, comparison, path, line, and diff fingerprint.
- Expose comments to the active agent and add “Send feedback” as a normal steering/follow-up message.
- Show validation evidence adjacent to the diff when a run records test/lint commands.

**Dependencies:** Portal Git contracts, workspace target resolution, protocol DTOs for diff/comments, replacement of dormant Proposal navigation.<br>
**Do not include yet:** hosted PR review, collaborative cursors, merge UI, or rewriting historical Proposal data.

#### N2. MCP runtime and management

**Outcome:** Weave can connect standard external tools without one-off provider code, while preserving its existing permission model.

**Thin slice**

- User-scoped configured servers: stdio and Streamable HTTP.
- Server list with connection/auth/error state and discovered tools.
- Enable/disable/reload; no marketplace initially.
- Lazy tool exposure/search so large tool catalogs do not consume every prompt.
- Map MCP tool calls to existing approval parts and execution profiles.
- Redact secrets in config display, logs, and persisted provider metadata.

**Dependencies:** server-side MCP client/runtime, protocol methods/events, user-artifact storage decision, approval-policy mapping, audit metadata.<br>
**Do not include yet:** arbitrary UI apps from MCP, public registry, organization marketplace, or automatic installation.

#### N3. Turn-linked checkpoints and rewind

**Outcome:** users can compare and restore the workspace to before an agent mutation without conflating recovery with Git history.

**Thin slice**

- Before the first mutation in a run turn, record baseline hashes/content for changed paths within configured limits.
- Attach the checkpoint ID to run/message events.
- Add `Compare` and `Restore workspace` to the completed turn.
- On restore, preview affected paths and refuse/ask when current manual edits diverge.
- Keep “restore conversation” separate; start with workspace-only restore.

**Dependencies:** mutation boundary in Portal tools, object storage/retention, binary/large-file limits, diff preview, concurrency guard.<br>
**Do not include yet:** full environment/database snapshots or magical rollback of external side effects.

#### N4. Background-run inbox and handoff

**Outcome:** a user can leave a task running, get notified, return to the exact state, and take over safely.

**Thin slice**

- Explicit `Run in background` action using the current durable run.
- Sidebar filters: active, needs attention, completed, failed.
- Notification deep-link to the task/approval/question.
- Status summary: phase, current tool, elapsed time, plan progress, validation state.
- Steer, cancel, answer, approve/deny, and take over from the inbox.

**Dependencies:** run list/query contract, notification routing, retained-run lifecycle, reliable approval recovery.<br>
**Do not include yet:** remote VM provisioning or multi-agent fan-out; prove the single background-run loop first.

### Next: controlled delegation and visible execution

#### X1. Worktree-backed child tasks

Start with one parent spawning one bounded child task into one automatically created worktree. Show the relationship in the thread sidebar; gather a structured summary plus Git diff; require review before integrating. Add concurrency limits, target-specific permissions, and cleanup preview. General recursive agent teams can wait.

#### X2. Browser session, then computer use

Build a Portal-hosted browser session first: URL, screenshot stream, console/network log, click/type/scroll, takeover, and an event timeline. Reuse execution profiles and approvals, with separate permissions for navigation, credential entry, downloads/uploads, and external writes. Only after browser reliability and auditability are proven should Weave generalize to OS-level computer use.

#### X3. Run timeline, usage, and validation evidence

Unify durable run events, model/profile selection, context/compaction, tool durations, approval decisions, command exit status, and verifier/eval evidence in a user-facing timeline. Compute monetary cost only where provider pricing and cache accounting are reliable; otherwise show tokens/credits without invented precision.

#### X4. Workflow visibility before workflow authoring

Expose the existing backend in this order:

1. definition list/detail;
2. run history/detail/event timeline;
3. manual trigger/cancel;
4. schedule/webhook status;
5. guarded form-based authoring for proven state/action types.

Avoid starting with a generic visual DAG builder. Real run inspection will reveal which authoring abstractions deserve UI.

#### X5. Project knowledge manager

Create one place to inspect and edit active `AGENTS.md`, prompts, skills, and project notes, including scope and activation explanation. Add explicit “remember as project rule/note/skill” actions. Prefer reviewable durable artifacts over opaque automatic memory; optional suggestions can come later with user approval.

#### X6. Defined TUI/mobile remote-control parity

Do not chase the entire GUI. Make TUI and mobile excellent remote controls for:

- active/needs-attention runs;
- plan/status/context;
- steering/cancel;
- approvals and ask-user responses;
- notification deep-links;
- compact diff/validation summaries;
- handoff to desktop/web for rich review.

This gives the smaller surfaces a crisp job and avoids permanent ambiguous parity.

### Later: distribution, ecosystem, and broad collaboration

#### L1. Connector and plugin catalog

After MCP runtime stability, add installable bundles that can include MCP configuration, skills, prompts, and optional safe UI. Add provenance, signature/trust, permission preview, updates, and organization allowlists before promoting a marketplace.

#### L2. Shared review and task collaboration

Add shareable task/review links, participants, comments, presence, and role-based actions. Keep Git/workspace ownership explicit. Collaboration should grow from the review session model, not from transcript sharing alone.

#### L3. Mobile voice and remote engineering

Add push-to-talk prompt/steering and spoken summaries first. Voice should operate existing task controls; it should not create a parallel voice-only agent state. Follow with mobile-friendly plan, diff summary, approval, and handoff experiences.

#### L4. Preview, deploy, and publish

Add user-facing app preview URLs, guarded deploy targets, artifact publishing, and PR publication as typed actions with environment/permission review. Do not expose the operator Dokploy deployment path as an end-user feature.

#### L5. Broader computer-use and knowledge-work agents

Once browser security, artifacts, workflows, and connectors are mature, extend Weave beyond code into repeatable research, document, spreadsheet, mail/calendar, and operations tasks. The existing Chat/Notes/Coppermind surfaces make this plausible, but the reliable control loop should come first.

## Explicit anti-priorities

1. **Do not build another autocomplete engine or chase inline completion parity.** Cursor, Copilot, Windsurf/Devin Desktop, and Zed own deep editor-native completion loops; it does not leverage Weave’s strongest seams.
2. **Do not rebuild a full IDE.** Portal + shared editor/terminal should stay deep enough for agent work and takeover, while external IDEs remain valid companions.
3. **Do not revive Proposal as the primary coding workflow.** Review actual Git changes after work; keep historical Proposal artifacts inert.
4. **Do not launch a connector marketplace before a secure MCP runtime.** Catalog breadth without transport, approval, provenance, and auditability creates support and security debt.
5. **Do not ship recursive multi-agent teams before checkpoints, worktree isolation, and review.** Parallelism multiplies race conditions and review load.
6. **Do not call run replay “workspace recovery.”** A durable transcript does not restore files or external side effects.
7. **Do not auto-create opaque long-term memories by default.** Prefer explicit, reviewable project rules/notes/skills; suggestions may be opt-in.
8. **Do not expose generic computer use before a visible browser-session pilot.** Browser scope gives a smaller permission and observability boundary.
9. **Do not present estimated dollars when pricing metadata is incomplete.** Accurate token/credit/context evidence is better than false cost precision.
10. **Do not make every surface identical.** Define desktop/web as creation/review surfaces and TUI/mobile as focused execution/control surfaces.
11. **Do not turn operator deployment into user deployment.** `server:deploy` is infrastructure; end-user preview/deploy needs typed targets, permissions, evidence, and rollback.
12. **Do not optimize for discontinued products.** Roo Code patterns can inform modes/orchestration, but current roadmap validation should weight active products and current first-party docs.

## Suggested roadmap scorecard

Use this as a starting point for quarterly prioritization; scores are directional (5 is strongest/best, except risk where 5 is highest risk).

| Candidate | Trust impact | Existing-seam leverage | Cross-product leverage | Loop completeness | Differentiation | Delivery risk | Recommended horizon |
| --- | :---: | :---: | :---: | :---: | :---: | :---: | --- |
| Git-native Review | 5 | 5 | 3 | 5 | 4 | 3 | Now |
| MCP runtime/manager | 4 | 4 | 5 | 4 | 3 | 4 | Now |
| Turn-linked checkpoints | 5 | 4 | 4 | 5 | 4 | 4 | Now |
| Background-run inbox | 4 | 5 | 5 | 5 | 5 | 3 | Now |
| Worktree child task | 4 | 5 | 3 | 4 | 5 | 4 | Next |
| Browser session | 4 | 3 | 5 | 4 | 4 | 5 | Next |
| Run/usage/evidence timeline | 5 | 5 | 5 | 4 | 4 | 3 | Next |
| Workflow run UI | 3 | 5 | 5 | 4 | 5 | 3 | Next |
| Knowledge manager | 4 | 4 | 5 | 3 | 4 | 3 | Next |
| TUI/mobile control parity | 3 | 4 | 4 | 4 | 4 | 3 | Next |
| Plugin/connector catalog | 3 | 2 | 5 | 3 | 3 | 5 | Later |
| Shared review/tasks | 4 | 3 | 4 | 4 | 4 | 5 | Later |
| Voice | 2 | 3 | 4 | 2 | 3 | 3 | Later |
| Preview/deploy/publish | 4 | 2 | 4 | 4 | 4 | 5 | Later |

## Decision checkpoints before implementation

Before converting this roadmap into tickets, resolve these product decisions explicitly:

1. Is the first Review comparison **working tree vs `HEAD`** only, or must base branch/commit comparisons ship together?
2. Are MCP servers initially **user-scoped**, **project-scoped**, or both? Where do secrets live relative to user artifacts?
3. Is a checkpoint allowed to store file content server-side, or must local workspaces keep snapshot material only in Portal?
4. Does “background” initially mean **server run continues while the client disconnects**, or does it also require a separately provisioned remote execution host?
5. Should child tasks always receive a new worktree, or may read-only research children share a workspace?
6. Is the browser hosted by Portal on the user’s machine, by a remote Portal, or by the server infrastructure?
7. Which run events are safe and useful to persist/display as audit evidence, and what is the retention/redaction policy?
8. Is TUI a focused control client or a first-class feature peer? The answer determines whether approval/plan/model selection are gaps or intentional exclusions.

## Bottom line

Weave is not far behind on core runtime reliability; it is behind on **making that reliability legible and actionable to users**. The highest-return roadmap work exposes existing durable runs, Portal isolation, Git/worktrees, plans, and notifications as a coherent loop:

> delegate safely → observe progress → intervene → review evidence and diff → restore if needed → continue from any surface

That loop is more defensible than copying a single competitor’s IDE chrome, and it maps directly onto Weave’s current architecture.
