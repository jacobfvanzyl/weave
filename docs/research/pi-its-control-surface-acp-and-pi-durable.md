# Pi, its control surface, ACP, and the state of Pi Durable

Research snapshot, 2026-11-12. Primary sources only. Pi was read from a clone of `earendil-works/pi` at [`6249ca27`](https://github.com/earendil-works/pi/tree/6249ca27d2230a93d2fd44c3ceb3a651bc2baaec) (`main`, 2026-11-12; every package at 1.5.2, tag `v1.5.2` published 2026-11-10). The ACP adapters were read from clones of `svkozak/pi-acp` at [`04d0a15d`](https://github.com/svkozak/pi-acp/tree/04d0a15d6bb42bb65cce5c9caedcdcb2cdcb6905) (`main`, 2026-10-06; npm `pi-acp` 0.0.34, 2026-09-24) and `openma-ai/pi-acp` at [`ffea89d2`](https://github.com/openma-ai/pi-acp/tree/ffea89d285ea6d8219a4b86f23429f4ebf5e644e) (`main`, 2026-10-17; npm `@openma/pi-acp` 0.1.8). The ACP registry was read at [`5cda4057`](https://github.com/agentclientprotocol/registry/tree/5cda40570d370166a2e389486991b4db42cee3a9) and ACP's RFDs through the GitHub API at `agentclientprotocol/agent-client-protocol` [`c392d7e9`](https://github.com/agentclientprotocol/agent-client-protocol/tree/c392d7e9d1de01337b749c0070929933e9f6f09f). Issues, pull requests, stars and release dates come from the GitHub API through `gh`, versions from the npm registry and crates.io, positioning from [pi.dev](https://pi.dev), [earendil.com/posts](https://earendil.com/posts/) and Mario Zechner's own blog, all on 2026-11-12. Nothing was installed, built or run. Weave is judged at `d6210089` plus the uncommitted WVE-220 work. Sections 1 to 6 are facts. Section 7 judges them for weave. Section 8 lists what wasn't verified.

The question: the person wants control over an agent's loop, system prompts, context management and tool management inside weave, got glimpses of that control with Pi, and asked for the state of Pi Durable. The plan this note informs is to run Pi under weave as an ACP agent as a spike, keep a list of every control reached for and every place ACP gets in the way, and decide from that whether to write a weave-native harness as an ACP agent. A second claim to test: that with a harness weave controls, ACP's `_meta` and extension methods, advertised by capability, lift the ceiling of a slow, lowest-common-denominator protocol.

[Mastra and Pi Durable as a persistent agent runtime](mastra-vs-pi-durable-agent-runtime.md) (2026-10-18) already covers Pi Durable 1.3.0 in depth (its §2), Pi 1.0 (§2.15) and `pi-acp` (§2.16), and led to [ADR 0011](../adr/0011-the-host-stays-the-runtime-authority.md): the Host stays the runtime authority and weave owns an agent loop only as an ACP agent. This note doesn't repeat it. It reports what changed in the 25 days since, and adds what that note left out: the coding agent's control surface, its RPC and SDK, and the adapters read as source. Two notes written today, [Standard Agents](standard-agents-and-its-specification.md) and [OpenBot, CopilotKit and AG-UI](openbot-copilotkit-and-ag-ui.md), reach the same verdict about loops by another road and are cited where they bear. This note uses weave's words (Host, Dispatcher, thread, turn, steer, queued prompt, pending request, Bot, home, Session, Block) and puts Pi's word in italics where it differs. Pi's *session* is weave's thread. Pi's *turn* is one model request and its tool calls; several make a *run*, which is weave's turn.

## In brief

- **Pi is `earendil-works/pi`, and the name is unambiguous here.** It is Mario Zechner's coding agent, formerly `badlogic/pi-mono` and `@mariozechner/pi-coding-agent`, acquired by Earendil Inc. on 2026-04-08 with Zechner joining. MIT, 1.5.2, a release every few days, 121,654 stars. Confidence: high.
- **Pi Durable is `@earendil-works/pi-durable`, a first-party package in the same repository.** It is a separate harness from the coding agent, with its own loop, and is still marked "Experimental. The API changes without notice between releases" at 1.5.2. Confidence: high. Two third-party projects with similar names exist and are not it (6.1).
- **Pi's control is real, and most of it is not a protocol.** Replacing the system prompt, rewriting the context before each model request, replacing built-in tools, supplying the compaction summary and editing the provider payload are done by TypeScript extensions loaded into Pi's process, or by files in `.pi/`. Pi's own RPC mode carries none of them. ACP has no place for them and doesn't need one: they are harness code and harness configuration, set on the Host's disk.
- **What must cross the wire is small, and ACP already has most of it.** Steering is the same pre-standard `_session/steering` extension weave implements. Client-provided system prompts became stable ACP on 2026-11-06, 25 days after the draft, and session compaction on 2026-10-06. Weave pins the ACP crate at 3.0.0; the current one is 5.2.0. Part of the ceiling the person feels is weave's pin, and part is that Claude Code and Codex are closed loops, which no protocol changes.
- **Pi runs under weave today with no code, and three things won't work.** `weave --agent pi-acp` launches the registry's adapter. With it, the Host MCP server doesn't reach Pi (so no client tools, Host tools or a Bot's wake-up tools), a steer has nowhere to go, and the permission policy has nothing to answer because Pi asks no permission. The first is partly weave's: the Host MCP server speaks MCP 2026-07-28 only, and Pi's MCP client speaks 2025-11-25.
- **Pi Durable moved toward what weave lacked and away from what the earlier note planned on.** Durable sleeps shipped in 1.4.0. Signals, tools that park and approval gates that survive a restart are on `main`, unreleased. But 1.5.0 had more than thirty breaking changes and removed `watchEvents()`, which the earlier note's recommendation mapped onto `session/update`. It remains single-process, with no replay and no ACP. Earendil is building its own Host-like product on it (6.4).
- **The spike is worth a day. A native Rust harness is not yet justified.** Pi's loop is 2,555 lines; what surrounds it is 65,000. If weave wants an owned loop soon, a weave-written ACP agent on Pi's SDK costs a small fraction of a Rust harness and keeps Pi's extensions.

## 1. What Pi is

### 1.1 Name, owner, licence, cadence

- **Repository.** [`earendil-works/pi`](https://github.com/earendil-works/pi): "AI agent toolkit: unified LLM API, agent loop, TUI, coding agent CLI". `badlogic/pi-mono` redirects to it (GitHub API). Created 2025-08-09; 121,654 stars, 15,685 forks, 278 open issues; last push 2026-11-12.
- **Owner.** Earendil Inc., a public benefit corporation founded by Armin Ronacher and Colin Daymond Hanna. Its post of 2026-04-08 announces "the acquisition of the Pi Open Source project" and that "Mario Zechner becomes a major Earendil stakeholder and team member" ([Announcing Pi & Lefos](https://earendil.com/posts/announcing-pi-and-lefos/)). This settles what the earlier note could only take from secondary coverage. The `LICENSE` is MIT, "Copyright (c) 2025 Mario Zechner" ([LICENSE](https://github.com/earendil-works/pi/blob/6249ca27d2230a93d2fd44c3ceb3a651bc2baaec/LICENSE)).
- **Site.** [pi.dev](https://pi.dev), "a minimal agent harness", footer "Earendil Inc. & Contributors", documentation at pi.dev/docs. The adapter's README calls Pi "fka shitty coding agent"; that older site wasn't checked.
- **Packages.** `@earendil-works/pi-coding-agent` 1.5.2, published 2026-11-10; 64 versions since the scope was created on 2026-05-07. `@mariozechner/pi-coding-agent` stopped at 0.73.1 on 2026-05-07 and is deprecated: "please use @earendil-works/pi-coding-agent instead going forward" (npm registry). All packages share one version number.
- **Cadence.** 1.0.0 on 2026-10-01, then 1.0.1 to 1.0.4, 1.1.0, 1.2.0, 1.3.0, 1.4.0 (10-21), 1.5.0 (11-02), 1.5.1 (11-09), 1.5.2 (11-10): twelve releases in six weeks (GitHub releases). The 1.x number is the coding agent's; breaking changes in minor releases are routine in the libraries (6.2).
- **Runtime.** Node.js 22.19 or newer; the CLI installs with `curl -fsSL https://pi.dev/install.sh | sh` or `npm install -g --ignore-scripts @earendil-works/pi-coding-agent` ([README](https://github.com/earendil-works/pi/blob/6249ca27d2230a93d2fd44c3ceb3a651bc2baaec/README.md)).
- **Contribution policy.** "New issues and PRs from new contributors are auto-closed by default. Maintainers review auto-closed issues daily" (README). Several issues cited below were closed this way without a maintainer's answer, which is not the same as a decision.
- **Other things called Pi.** Weave's own [bridge Pi](../hardware/bridge-pi.md) is a Raspberry Pi and unrelated. No other coding agent of the name was found.

### 1.2 The layers

Sizes are physical lines of non-test TypeScript in `src`, comments and blanks included, counted from the clone.

| Package | What it is | Usable alone for | Lines, files |
| --- | --- | --- | --- |
| `pi-ai` | Provider layer: one streaming API over many providers, the model catalogue, API-key resolution, OAuth logins and refresh ([README](https://github.com/earendil-works/pi/blob/6249ca27d2230a93d2fd44c3ceb3a651bc2baaec/packages/ai/README.md)) | Any program that calls models | 28,759 in 211 |
| `pi-agent-core` | The loop: `Agent`, tool calling, steering and follow-up queues, events. Depends only on `pi-ai` and `pi-schema` | A loop of one's own, with one's own tools and storage | 2,555 in 6 |
| `pi-coding-agent` | The product: sessions, compaction, system prompt, built-in tools, resources, extensions, and the interactive, print, JSON and RPC modes | The CLI, the SDK, RPC | 78,777 in 265, of which `core/` 36,662 in 103, interactive mode 22,680, RPC mode 1,824 |
| `pi-tui` | Terminal UI library with differential rendering | Terminal apps | 19,977 in 46 |
| `pi-mcp` | A standalone MCP client, with no dependency on the official SDK or other Pi packages | MCP clients | 4,746 in 28 |
| `pi-codemode` | A JavaScript sandbox in which scripts call tools | Tool orchestration | 3,051 in 17 |
| `pi-durable` | A separate, durable harness (section 6). Depends on `chord`, `pi-ai`, `pi-codemode`, not on `pi-agent-core` or `pi-coding-agent` | Agents that survive restarts | 35,600 in 102 |
| `chord` | "Object runtime for apps across processes": contracts, documents, a store, links, plugins with hot reload | Earendil's own hosts (6.4) | 60,544 in 299 |
| `pi-env` | Remote execution environments for Pi Durable: a small Rust daemon reached over SSH | Tools on another machine | 2,575 in 9 |
| `pi-schema`, `pi-telemetry` | JSON Schema builders; vendor-neutral telemetry contracts | | 4,852; 1,630 |

The loop itself is four files: `agent-loop.ts` (959 lines), `agent.ts` (623), `types.ts` (551) and `proxy.ts` (397) ([packages/agent/src](https://github.com/earendil-works/pi/tree/6249ca27d2230a93d2fd44c3ceb3a651bc2baaec/packages/agent/src)). Its options are the seams everything else hangs on: `convertToLlm`, `transformContext`, `prepareNextTurn`, `getSteeringMessages`, `getFollowUpMessages`, `toolExecution`, `beforeToolCall` and `afterToolCall` ([types.ts](https://github.com/earendil-works/pi/blob/6249ca27d2230a93d2fd44c3ceb3a651bc2baaec/packages/agent/src/types.ts#L208-L341)).

In the coding agent, the session object that ties the loop to storage, compaction and extensions is one file of 4,579 lines (`core/agent-session.ts`); the session tree is 2,036 (`session-manager.ts`); compaction and branch summaries about 1,670; the built-in tools about 3,300; the system prompt builder 228.

## 2. Pi's control surface

### 2.1 Position

Zechner's founding post states the aim: "Exactly controlling what goes into the model's context yields better outputs", "pi is my attempt to build myself a tool where I'm in control as much as possible", with a system prompt and tool definitions "below 1000 tokens", four tools, "full YOLO mode", and no MCP, sub-agents, plan mode, background bash or to-dos built in ([2025-11-30](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)). Two of those have moved. MCP is built in since 0.99.0, through codemode ([You Said No MCP!](https://earendil.com/posts/you-said-no-mcp/), 2026-09-29: "the MCP of today is not the MCP of yesteryear"). The rest stands: "Pi ships with powerful defaults but skips features like sub-agents and plan mode. Ask Pi to build what you want, or install a package that does it your way" ([README](https://github.com/earendil-works/pi/blob/6249ca27d2230a93d2fd44c3ceb3a651bc2baaec/README.md)).

### 2.2 The system prompt

- **Replace or append, by flag or file.** `--system-prompt <text|path>` "replaces the default system prompt"; `--append-system-prompt` appends and repeats ([cli.md](https://github.com/earendil-works/pi/blob/6249ca27d2230a93d2fd44c3ceb3a651bc2baaec/packages/coding-agent/docs/cli.md)). `SYSTEM.md` and `APPEND_SYSTEM.md` do the same from the agent directory (`~/.pi/agent/`) or the project's `.pi/`; the project file wins and the two aren't combined ([configuration.md](https://github.com/earendil-works/pi/blob/6249ca27d2230a93d2fd44c3ceb3a651bc2baaec/packages/coding-agent/docs/configuration.md)).
- **Per turn, by extension.** `before_agent_start` hands a handler the prompt and the structured options it was built from (`customPrompt`, `forceSystemPrompt`, `selectedTools`, `hiddenTools`, `toolSnippets`, `toolGuidelines`, `promptGuidelines`, `sections`, `appendSystemPrompt`, `contextFiles`, `skills`), all mutable. Pi "diffs the resulting prompt sections against what the model already has and appends one system message patching only the changed sections", so models that take mid-conversation system messages keep their cached prefix; returning a whole `systemPrompt` replaces it and costs a cache miss ([extensions.md, before_agent_start](https://github.com/earendil-works/pi/blob/6249ca27d2230a93d2fd44c3ceb3a651bc2baaec/packages/coding-agent/docs/extensions.md#before_agent_start)).
- **Context files.** `AGENTS.override.md`, `AGENTS.md` or `CLAUDE.md`, from the agent directory and the working directory, load "regardless of project trust" unless `--no-context-files` ([security.md](https://github.com/earendil-works/pi/blob/6249ca27d2230a93d2fd44c3ceb3a651bc2baaec/packages/coding-agent/docs/security.md)).

### 2.3 Context: what the model sees

- **Per request.** `context` gets a deep copy of the messages before every model call and returns a changed list; Pi restores the prompt and tool declarations around it. `context_with_system` then gets the full transcript, system messages included, and "owns the prompt and tool declarations for the request". After those, `before_provider_headers` mutates headers and `before_provider_request` can replace the provider payload itself; `after_provider_response` and `provider_stream_event` observe ([extensions.md, lifecycle](https://github.com/earendil-works/pi/blob/6249ca27d2230a93d2fd44c3ceb3a651bc2baaec/packages/coding-agent/docs/extensions.md#lifecycle-overview)).
- **Compaction.** Automatic when `contextTokens > contextWindow - reserveTokens` (16,384 by default), on a provider overflow error, or by `/compact [instructions]`. `session_before_compact` can cancel it or supply the summary and the first kept entry itself; the original entries stay in the session ([compaction.md](https://github.com/earendil-works/pi/blob/6249ca27d2230a93d2fd44c3ceb3a651bc2baaec/packages/coding-agent/docs/compaction.md)).
- **Editing in place.** A `context_edit` entry is an "append-only edit of one earlier context-producing entry. It changes only future model context": it omits or replaces one earlier message for the model while the raw history stays ([session-format.md](https://github.com/earendil-works/pi/blob/6249ca27d2230a93d2fd44c3ceb3a651bc2baaec/packages/coding-agent/docs/session-format.md#contexteditentry)).
- **Branching.** A session is a tree. `/tree` moves within one file, optionally summarising the branch left behind; `/fork` starts a new session from an earlier user message; `/clone` copies the active branch ([sessions.md](https://github.com/earendil-works/pi/blob/6249ca27d2230a93d2fd44c3ceb3a651bc2baaec/packages/coding-agent/docs/sessions.md)).
- **Prompt cache.** A `cache_warming_decision` event lets an extension overrule Pi's decision to refresh the cache while idle.

### 2.4 Sessions on disk

JSONL files under `~/.pi/agent/sessions/--<path>--/<timestamp>_<session-id>.jsonl`, format version 3. Every entry has an `id` and a `parentId`; the kinds are a header, message, model change, thinking-level change, usage, compaction, context edit, branch summary, custom (an extension's state), custom message, label and session info. Context is rebuilt from the active branch ([session-format.md](https://github.com/earendil-works/pi/blob/6249ca27d2230a93d2fd44c3ceb3a651bc2baaec/packages/coding-agent/docs/session-format.md)). A session records its working directory and "never changes it", which is weave's rule for a thread. A session is not resumable mid-turn: Earendil's own description is "If the process dies, you look at what happened and tell it to continue" ([Pi Durable post](https://earendil.com/posts/pi-durable/)).

### 2.5 Tools

- **Built in.** `read`, `bash`, `edit`, `write` on by default; `grep`, `find`, `ls` and, on Windows, `powershell` available; `codemode` and `tool_search` as built-in extensions, off until an MCP server needs them ([cli.md, tools](https://github.com/earendil-works/pi/blob/6249ca27d2230a93d2fd44c3ceb3a651bc2baaec/packages/coding-agent/docs/cli.md)).
- **Choosing.** `--tools`, `--exclude-tools`, `--no-builtin-tools`, `--no-tools`, the `defaultTools` setting, and at run time `pi.setActiveTools(names)`.
- **Adding and replacing.** `pi.registerTool(definition)` adds one. An extension's tool with a built-in's name replaces it ("Extension's read tool replaces built-in read"), which is how the Gondolin and SSH examples run the built-ins somewhere else ([extensions.md, custom tools](https://github.com/earendil-works/pi/blob/6249ca27d2230a93d2fd44c3ceb3a651bc2baaec/packages/coding-agent/docs/extensions.md#custom-tools)).
- **Gating.** `tool_call` fires before a tool runs: "Can block", and `event.input` is mutable, with no re-validation after. `tool_result` can rewrite the result. Both apply to MCP tools too.
- **Exposure.** A tool is `direct` (declared to the model), `deferred` (declared after `tool_search` finds it), `codemode` (callable only from scripts) or `hidden` ([mcp.md](https://github.com/earendil-works/pi/blob/6249ca27d2230a93d2fd44c3ceb3a651bc2baaec/packages/coding-agent/docs/mcp.md#control-tool-exposure)).

### 2.6 Extensions, and everything else that loads

- **Extensions** are "TypeScript modules loaded into the Pi process. Their factory functions register tools, commands, shortcuts, providers, event handlers, renderers, and terminal UI" ([how-pi-works.md](https://github.com/earendil-works/pi/blob/6249ca27d2230a93d2fd44c3ceb3a651bc2baaec/packages/coding-agent/docs/how-pi-works.md)). The reference is 3,367 lines. Events cover startup and trust, sessions (start, switch, fork, compact, tree, shutdown), the agent (`before_agent_start`, `agent_start`, `agent_end`, `agent_before_settle`, `agent_settled`, `turn_start`, `turn_end`, message and tool execution events), the six request hooks of 2.3, model and thinking-level changes, `tool_call`, `tool_result`, `user_bash` and `input`, which can transform or swallow what the person typed. `turn_end` and `agent_before_settle` can append entries and ask for the run to continue, which is how a loop is extended from outside. Methods include `sendMessage`, `sendUserMessage`, `appendEntry`, `registerCommand`, `registerProvider`, `registerVirtualModel`, `registerMcpServer`, `setModel` and `exec`.
- **UI.** Dialogs (`select`, `confirm`, `input`, `editor`), notifications, status, widgets, header, footer, custom components, overlays, a custom editor, message and tool renderers. Only the dialogs and the fire-and-forget calls survive outside the terminal UI (3.2).
- **Skills** follow the Agent Skills specification: `SKILL.md` folders, advertised by name and description and loaded on demand ([skills.md](https://github.com/earendil-works/pi/blob/6249ca27d2230a93d2fd44c3ceb3a651bc2baaec/packages/coding-agent/docs/skills.md)). **Prompt templates** expand `/name` into message text. **Themes** colour the terminal. **Pi packages** bundle all four for `pi install npm:…` or `git:…` ([packages.md](https://github.com/earendil-works/pi/blob/6249ca27d2230a93d2fd44c3ceb3a651bc2baaec/packages/coding-agent/docs/packages.md)).
- **Sub-agents and plan mode** are examples, not features: `examples/extensions/subagent` and `examples/extensions/plan-mode` ([examples](https://github.com/earendil-works/pi/tree/6249ca27d2230a93d2fd44c3ceb3a651bc2baaec/packages/coding-agent/examples/extensions)).
- **MCP** is a client over stdio and streamable HTTP, configured in `~/.pi/agent/mcp.json` or `.pi/mcp.json`, or per session by `pi.registerMcpServer`. Legacy SSE "is not supported". `pi-mcp` requests protocol `2025-11-25`, accepts back to `2024-11-05`, and opens with `initialize` ([protocol/types.ts](https://github.com/earendil-works/pi/blob/6249ca27d2230a93d2fd44c3ceb3a651bc2baaec/packages/mcp/src/protocol/types.ts#L4-L9), [client.ts](https://github.com/earendil-works/pi/blob/6249ca27d2230a93d2fd44c3ceb3a651bc2baaec/packages/mcp/src/client.ts#L221-L242)). This matters in 4.4.

### 2.7 Permissions

There are none. "Pi does not include a built-in permission system for restricting filesystem, process, network, or credential access" (README); it "does not ask for approval before every tool call" ([security.md](https://github.com/earendil-works/pi/blob/6249ca27d2230a93d2fd44c3ceb3a651bc2baaec/packages/coding-agent/docs/security.md)). The stated answer is a container, a VM or a sandbox. An approval step is an extension: `examples/extensions/permission-gate.ts` blocks `rm -rf`, `sudo` and `chmod 777` from `tool_call` unless `ctx.ui.select` returns "Yes", and blocks outright with no UI.

**Project trust** is a different thing: whether a folder's `.pi/settings.json`, `.pi/mcp.json`, extensions, skills, prompts, themes and `SYSTEM.md` load at all. Print, JSON and RPC modes can't show the prompt, so without `--approve`, a saved decision in `~/.pi/agent/trust.json`, or `defaultProjectTrust: "always"`, they skip those files. Context files load either way.

## 3. Driving Pi from another program

### 3.1 The four ways

Print mode (`--print`) runs one prompt and writes the answer. JSON mode (`--mode json`) writes the event stream as JSONL and exits. RPC mode (`--mode rpc`) is a long-lived child process speaking JSONL on stdin and stdout. The SDK (`createAgentSession()`) embeds Pi in a Node or Bun process. "All interfaces use the same agent and session mechanisms" ([how-pi-works.md](https://github.com/earendil-works/pi/blob/6249ca27d2230a93d2fd44c3ceb3a651bc2baaec/packages/coding-agent/docs/how-pi-works.md)).

### 3.2 RPC: the whole surface

Thirty-three commands ([rpc-types.ts](https://github.com/earendil-works/pi/blob/6249ca27d2230a93d2fd44c3ceb3a651bc2baaec/packages/coding-agent/src/modes/rpc/rpc-types.ts#L22-L74), [rpc-commands.md](https://github.com/earendil-works/pi/blob/6249ca27d2230a93d2fd44c3ceb3a651bc2baaec/packages/coding-agent/docs/rpc-commands.md)):

| Group | Commands |
| --- | --- |
| Prompting | `prompt` (with `images` and, during a run, a required `streamingBehavior` of `steer` or `followUp`), `steer`, `follow_up`, `abort`, `clear_queue`, `new_session` |
| State | `get_state`, `get_messages`, `get_session_stats`, `get_last_assistant_text`, `get_commands` |
| Model | `set_model`, `cycle_model`, `get_available_models`, `set_thinking_level`, `cycle_thinking_level`, `get_available_thinking_levels` |
| Queue | `set_steering_mode`, `set_follow_up_mode` (`all` or `one-at-a-time`) |
| Compaction and retry | `compact` (with `customInstructions`), `set_auto_compaction`, `set_auto_retry`, `abort_retry` |
| Shell | `bash` (with `excludeFromContext`), `abort_bash` |
| Session | `switch_session`, `fork` (by `entryId`), `clone`, `get_fork_messages`, `get_entries` (with `since`), `get_tree`, `set_session_name`, `export_html` |

- **Events** ([json.md](https://github.com/earendil-works/pi/blob/6249ca27d2230a93d2fd44c3ceb3a651bc2baaec/packages/coding-agent/docs/json.md)): `agent_start`, `agent_end`, `agent_settled`, `turn_start`, `turn_end`, `message_start`, `message_update` (text, thinking and tool-call deltas), `message_end`, `tool_execution_start`, `_update`, `_end`, `queue_update` (both queues, whole), `entry_appended`, `session_info_changed`, `thinking_level_changed`, `compaction_start` and `compaction_end` (with the summary, `firstKeptEntryId`, tokens before and after), `auto_retry_*`, `summarization_retry_*`, and RPC's own `bash_execution_update` and `extension_error`. A client waits for `agent_settled`, not `agent_end`, to know Pi is idle.
- **Steering.** A steer "is delivered after the current assistant turn finishes executing its tool calls, before the next LLM call"; a follow-up "only when agent stops". Neither interrupts a running tool.
- **Extension UI** is a sub-protocol: `extension_ui_request` for `select`, `confirm`, `input` and `editor`, which block on an `extension_ui_response`, and for `notify`, `setStatus`, `setWidget`, `setTitle` and `set_editor_text`, which don't. Custom components, the footer, header, themes and terminal input are no-ops ([rpc-extension-ui.md](https://github.com/earendil-works/pi/blob/6249ca27d2230a93d2fd44c3ceb3a651bc2baaec/packages/coding-agent/docs/rpc-extension-ui.md)).
- **What RPC does not have.** No command sets the system prompt, the tool set, an MCP server or project trust: those are command-line flags when the process starts, files, or extensions. There is `get_tree` but no command to move within the tree. An issue asking for per-session MCP registration over RPC was auto-closed and then withdrawn by its author in favour of an extension ([#11067](https://github.com/earendil-works/pi/issues/11067)).

### 3.3 The SDK

`createAgentSession()` returns an `AgentSession` with `prompt()`, `steer()`, `followUp()`, `abort()`, `waitForIdle()`, `subscribe()`, and read access to `messages`, `model`, `thinkingLevel`, `systemPrompt` and the active tools. Every boundary can be supplied: `modelRuntime`, `settingsManager`, `sessionManager` (a file or `SessionManager.inMemory()`), `resourceLoader` (extensions, skills, templates, context files, including inline extension factories), and `tools`, `noTools`, `excludeTools`, `customTools`. `AgentSessionRuntime` adds `newSession()`, `switchSession()`, `fork()` and `importFromJsonl()` ([sdk.md](https://github.com/earendil-works/pi/blob/6249ca27d2230a93d2fd44c3ceb3a651bc2baaec/packages/coding-agent/docs/sdk.md)). SDK sessions don't load the built-in codemode, tool-search and MCP extensions unless asked.

The difference that matters: the SDK reaches everything in section 2, because the host can pass its own extension factories. RPC reaches only 3.2. Earendil's own guidance is RPC for "other languages, isolated processes, IDEs" and the SDK for "Node.js or Bun hosts that want complete API access" ([rpc.md](https://github.com/earendil-works/pi/blob/6249ca27d2230a93d2fd44c3ceb3a651bc2baaec/packages/coding-agent/docs/rpc.md)).

## 4. Pi and ACP

### 4.1 First party: none

Nothing in `earendil-works/pi` speaks ACP. Zechner on the first request, 2025-12-13: "I currently have no need for ACP support, so that's a no for me I'm afraid. It should however be trivial to build an ACP adapter on top of RPC mode" ([#175](https://github.com/earendil-works/pi/issues/175)). On Pi Durable, 2026-10-08: "no, that is something you can build yourself on top of it" ([#10389](https://github.com/earendil-works/pi/issues/10389), closed as not planned). pi.dev doesn't mention ACP.

### 4.2 `svkozak/pi-acp`: the registry's adapter

- **What and who.** Sergii Kozak's adapter, MIT, 4,427 lines of TypeScript in 17 files. It "spawns `pi --mode rpc`, bridging requests/events between the two", needs `pi` 0.81.0 or later on `PATH`, and calls itself "an MVP-style adapter" whose "development is centered around Zed" ([README](https://github.com/svkozak/pi-acp/blob/04d0a15d6bb42bb65cce5c9caedcdcb2cdcb6905/README.md)). 770 stars, 216 forks.
- **In the registry.** `pi-acp` 0.0.34, distributed as `npx pi-acp@0.0.34` ([agent.json](https://github.com/agentclientprotocol/registry/blob/5cda40570d370166a2e389486991b4db42cee3a9/pi-acp/agent.json)).
- **Activity.** Last release 0.0.34 on 2026-09-24, last commit to `main` 2026-10-06, 102 open issues and pull requests. The open pull requests are what weave would want: `_session/steering` over Pi's `steer` ([#176](https://github.com/svkozak/pi-acp/pull/176), 2026-11-06), passing the client's MCP servers through ([#181](https://github.com/svkozak/pi-acp/pull/181), 2026-11-12), extension dialogs as form elicitation ([#180](https://github.com/svkozak/pi-acp/pull/180)), `session/fork` ([#171](https://github.com/svkozak/pi-acp/pull/171)). A pull request for a client system prompt through `_meta.systemPrompt` was closed unmerged ([#124](https://github.com/svkozak/pi-acp/pull/124)). Nothing has merged in five weeks.

What it implements, from [`agent.ts`](https://github.com/svkozak/pi-acp/blob/04d0a15d6bb42bb65cce5c9caedcdcb2cdcb6905/src/acp/agent.ts#L239-L272) and [`session.ts`](https://github.com/svkozak/pi-acp/blob/04d0a15d6bb42bb65cce5c9caedcdcb2cdcb6905/src/acp/session.ts):

| ACP | In `pi-acp` 0.0.34 |
| --- | --- |
| `initialize` | Protocol 1. `loadSession: true`; `promptCapabilities` image yes, audio no, embedded context only with an environment variable; `mcpCapabilities` http and sse false; `sessionCapabilities` `list` and `delete`. No `_meta` capabilities |
| `session/new`, `session/load` | Yes. Load reattaches to Pi's own session file through a map at `~/.pi/pi-acp/session-map.json` and replays it. No `session/resume`, `fork` or `close` |
| `session/prompt`, `session/cancel` | Yes. Cancel calls Pi's `abort` and clears the adapter's own queue |
| A prompt during a turn | Queued in the adapter, announced as text. Pi's `steer` is not used |
| Updates | `agent_message_chunk`, `agent_thought_chunk` (the README still says there is no thought stream), `tool_call` and `tool_call_update` with locations and a structured diff for `edit`, `available_commands_update`, `usage_update`, `session_info_update` |
| Shell output | Zed's `_meta` convention: `terminal_info`, `terminal_output`, `terminal_exit` |
| Modes and config | Modes are Pi's thinking levels. Config options are model and thinking level |
| Slash commands | Pi's prompt templates and `/skill:name`, plus the adapter's `compact`, `autocompact`, `export`, `session`, `name`, `steering`, `follow-up`, `changelog` |
| Permission requests | Only for an extension's dialog: `confirm` becomes `session/request_permission` with `allow_once` and `reject_once`; `select` becomes one with every choice marked `allow_once`; `input` and `editor` are cancelled with a notice |
| `fs/*`, `terminal/*` | Not used: "pi reads/writes and executes locally" |
| MCP servers from the client | "Accepted in ACP params and stored in session state, but not wired through to pi" |
| Compaction | Text chunks on `auto_compaction_start` and `auto_compaction_end`. Pi's event stream now documents `compaction_start` and `compaction_end` (3.2), so these may no longer fire. No `compaction_update` |
| Subagents, elicitation, client system prompt, extension methods | None |
| Authentication | Terminal auth: relaunches itself with `--terminal-login`. It never touches Pi's credentials |

What of Pi it loses: everything in 3.2 it doesn't call (`steer`, `fork`, `clone`, `get_tree`, queue modes except through its slash commands), and everything RPC doesn't carry (3.2).

### 4.3 `openma-ai/pi-acp`: what a fuller adapter looks like

`@openma/pi-acp` 0.1.8 (Apache-2.0, 7,360 lines in 24 files) "runs pi in-process on the pi SDK (`createAgentSessionRuntime`)" ([README](https://github.com/openma-ai/pi-acp/blob/ffea89d285ea6d8219a4b86f23429f4ebf5e644e/README.md)). From its source it advertises `sessionCapabilities` `list`, `delete`, `fork`, `resume` and `close`, `mcpCapabilities.http`, and `_meta: { steering: { supported: true } }` ([agent.ts](https://github.com/openma-ai/pi-acp/blob/ffea89d285ea6d8219a4b86f23429f4ebf5e644e/src/acp/agent.ts#L340-L380)); handles `_session/steering` with the `promptRequired` answer when idle, plus its own `_pi/add_directory`, `_pi/trust_project` and `_pi/emit_event`; registers the client's MCP servers on Pi's MCP extension; emits `compaction_update`; turns extension dialogs into `elicitation/create` with a permission-request fallback; delegates `read`, `edit`, `write` and `bash` to the client's `fs` and `terminal` when offered; and forwards every extension event as `_meta`.

It is the best evidence here for the `_meta` claim, and thin as a dependency: one author, 26 commits, 4 stars, not in the registry, depends on Pi `^1.1.0` while Pi's libraries break in minors, and its `main` has not moved since 2026-10-17 (the repository shows a later push, to something other than `main`). `regadas/pi-acp` (MIT, 2 stars, pushed 2026-11-09, not on npm) is another independent adapter; it and the other small forks a GitHub search finds were not read.

### 4.4 Launching it from weave, and what won't work

**What it takes.** Nothing but a name. A registry agent launches "exactly as the ACP registry describes them, with the version it lists" ([agents/AGENTS.md](../../agents/AGENTS.md)), so `weave --agent pi-acp` runs `npx -y pi-acp@0.0.34`. The computer needs Node 22.19 or newer, `pi` on the `PATH` of the login shell's environment, and a Pi login or an API key in that environment. An optional `[agents.pi-acp]` table adjusts it (`fs = false`, `terminal = false`, a `description`). The other adapter is a config agent: `[agents.pi]` with `command = "npx"` and `args = ["-y", "@openma/pi-acp@0.1.8"]`. Neither warrants a preset: presets pin versions weave smoke-checks, and weave never branches on the agent.

**What should work**, from the source, untested: prompts with images, streamed text and thoughts, tool calls with diffs, shell output through the `_meta` convention `acp-core/src/terminal_meta.rs` already reads, reopening a thread by `session/load`, slash commands, model and thinking level, context usage, queued prompts (the Host holds its own queue, so the adapter's never fills).

**What won't**, with `pi-acp` 0.0.34:

- **The Host MCP server.** The adapter stores the `mcpServers` weave passes and does nothing with them, so the `weave mcp-bridge` server never starts. No client tools, no Host tools (delegated threads, `rename_thread`), no service tools (a Bot's wake-ups and schedules, `create_bot`), no upstream servers.
- **That gap is deeper than the adapter.** With servers passed through, as #181 and the openma adapter do, Pi's MCP client would open with `initialize` at `2025-11-25` (2.6). The Host MCP server "speaks MCP 2026-07-28 only" and refuses `initialize` with `-32022`, and the thread journals a notice that the agent can't use client tools ([host/AGENTS.md](../../host/AGENTS.md)). Neither adapter advertises `mcpCapabilities.acp`, and that route would end at the same client.
- **Steering.** The adapter doesn't advertise `_meta.steering.supported`, so the Host has no steer to pass. What weave does with a steer then was not traced.
- **The permission policy.** Pi asks nothing, so a policy has nothing to answer and a headless thread runs every tool with the person's own permissions. If a gate extension is loaded, a `confirm` arrives as a well-formed permission request; a `select` arrives with every choice, the refusal included, marked `allow_once` and a tool kind of `other`, which a policy can't tell apart.
- **Modes.** Weave's `mode` setting would pick a thinking level.
- **Compaction updates and subagent threads.** Neither is sent.
- **Project files.** A thread's `.pi/` directory is skipped unless trust was saved or defaulted (2.7), because RPC mode can't ask.

## 5. Logins and billing

- **Where.** `/login` saves the credential in `~/.pi/agent/auth.json`, which "can contain API keys and OAuth tokens". An entry may instead be a command prefixed with `!` that prints the key, and environment variables work for every provider with one ([providers.md](https://github.com/earendil-works/pi/blob/6249ca27d2230a93d2fd44c3ceb3a651bc2baaec/packages/coding-agent/docs/providers.md)).
- **API keys.** Thirty-odd providers by environment variable (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY` and so on), plus ambient credentials for Amazon Bedrock and Google Vertex AI.
- **Subscription and account logins.** OAuth flows ship in `pi-ai` for Anthropic (Claude Pro and Max), OpenAI (Sign in with ChatGPT), OpenAI Codex (superseded by the former), GitHub Copilot, Kimi For Coding, xAI, Meta, OpenRouter (which mints an API key) and Radius, Earendil's own gateway ([auth/oauth](https://github.com/earendil-works/pi/tree/6249ca27d2230a93d2fd44c3ceb3a651bc2baaec/packages/ai/src/auth/oauth), [pi-ai README](https://github.com/earendil-works/pi/blob/6249ca27d2230a93d2fd44c3ceb3a651bc2baaec/packages/ai/README.md)). No Gemini subscription login was found; Gemini is by API key or Vertex.
- **Anthropic, in Pi's words.** With a Claude subscription login active, Pi warns: "Anthropic subscription auth is active. Third-party harness usage draws from extra usage and is billed per token, not your Claude plan limits. Manage extra usage at https://claude.ai/settings/usage" ([interactive-mode.ts](https://github.com/earendil-works/pi/blob/6249ca27d2230a93d2fd44c3ceb3a651bc2baaec/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L334)). That is Pi's statement of Anthropic's behaviour, not Anthropic's.
- **Anthropic, in its own words** ([Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance), read 2026-11-12): OAuth "is intended exclusively for purchasers of Claude Free, Pro, Max, Ultra, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications." Developers "should use API key authentication", and Anthropic "does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users." It "reserves the right to take measures to enforce these restrictions and may do so without prior notice." The page still allows "an end user ... signing in to the unmodified Claude Code binary with their own Claude subscription", which is what weave's Claude preset does.
- **The reading.** Using Pi's Claude login is, on Anthropic's text, outside what the subscription is for, and on Pi's text is billed per token anyway. Either way an Anthropic model in Pi costs API prices. No primary source from OpenAI on ChatGPT sign-in in third-party harnesses was read.
- **For weave's rule.** Pi keeps its own login in its own file, as Claude Code and Codex do, and the adapter never reads it. Weave would neither read nor store anything.

## 6. Pi Durable

### 6.1 What it is, and what it isn't

`@earendil-works/pi-durable`, in `packages/durable` of the same repository, MIT, by Earendil. "A durable agent harness. Conversations, model turns, tool calls, and your own state are committed to storage before anything is shown. If the process dies mid-turn, reopening the storage picks the work up where it stopped" ([README](https://github.com/earendil-works/pi/blob/6249ca27d2230a93d2fd44c3ceb3a651bc2baaec/packages/durable/README.md)). Announced with Pi 1.0 on 2026-10-01: "It does not replace the Pi coding agent"; "Pi Durable is experimental, and the API might still change" ([post](https://earendil.com/posts/pi-durable/)).

It is not the coding agent made durable. It has its own loop, built from the tasks `pi.generation` and `pi.tool`, its own tools and its own storage, and shares only `pi-ai` and `pi-codemode` with the coding agent. Coding-agent extensions don't run on it; the issue asking for that is open ([#10386](https://github.com/earendil-works/pi/issues/10386)). The earlier note's [§2](mastra-vs-pi-durable-agent-runtime.md#2-pi-durable) has the architecture: what a commit holds, what a crash does to a model request and to a tool, storage, compaction, forks.

Other things with the name, found by a GitHub search and not read: [`disler/durable-pi`](https://github.com/disler/durable-pi), a third-party "Durable Pi playground and agent network" (361 stars, last pushed 2026-10-11); [`vercel-labs/durable-harness`](https://github.com/vercel-labs/durable-harness), which runs several coding agents, Pi among them, on Vercel's Workflow SDK (308 stars); and Earendil's own [`pi-durable-cloudflare`](https://github.com/earendil-works/pi-durable-cloudflare), a sample of Pi Durable on Cloudflare Durable Objects ([post](https://earendil.com/posts/pi-durable-on-cloudflare/), 2026-10-16). "Pi Durable" without qualification means the Earendil package.

### 6.2 What changed since 2026-10-18

| | 2026-10-18 (1.3.0, earlier note) | 2026-11-12 (1.5.2; `main` at `6249ca27`) |
| --- | --- | --- |
| Status line | "Experimental. The API changes without notice" | The same, word for word |
| Size of `src` | 25,564 lines | 35,600 lines in 102 files; the normative spec grew from 5,612 to 7,266 lines |
| Durable sleeps | `main` only | Released in 1.4.0 (2026-10-21): "a sleeping task holds no invocation, survives restarts" |
| Host wake-ups (`wake()`, `onWake`) | `main` only | Released in 1.4.0; the two Durable Object issues are closed ([#10857](https://github.com/earendil-works/pi/issues/10857), [#10325](https://github.com/earendil-works/pi/issues/10325)) |
| Crash loops | Resumed for ever | 1.4.0 parked a task after 5 restarts; 1.5.0 ends it instead, visibly |
| A model request cut off by a crash | Re-sent on open | 1.5.0: "the attempt counts as failed under `settings.retry`", then backs off |
| A wait for something outside (approval, a client's tool result, a webhook) | None; a hook held the wait in memory | On `main`, unreleased: signals (`defineSignal`, `harness.signal()`), tools that park (`execute()` may return `{ sleep }` or `{ wait }`), and `beforeTool` gates that sleep and are asked again on every wake and every open. Examples 38 to 46 include "asking a person", "a tool that waits for a webhook" and "an approval gate" |
| Agent event stream (`watchEvents()`) | Experimental | Removed in 1.5.0 with its types: "A renderer renders state instead of assembling it from events". Hosts follow document, conversation and task-graph watches, which deliver each commit's operations |
| Storage interface | `commit(writes)` | 1.5.0: `commit(batches, receive, context)`, a group of commits per call |
| Storage format | SQLite schema v2 unreleased | Schema v2 released in 1.4.0, "a deployment cannot roll back past this release". Unreleased: `pi.tool` version 4 and `pi.generation` version 3, "not meant to be opened by an older Harness" |
| Processes | One per storage, no locking | The same: "One process writes a storage at a time; there is no cross-process locking". JSONL gained a read-only open for a viewer |
| Replay for a late client | None | None: a client "that joins late or reconnects starts from the current view" |
| ACP, MCP | Neither | Neither. The cross-process watch issue is closed ([#10749](https://github.com/earendil-works/pi/issues/10749)); the MCP extension proposal is closed, not planned ([#10837](https://github.com/earendil-works/pi/issues/10837)) |
| Deleting a conversation | Open | Still open ([#11026](https://github.com/earendil-works/pi/issues/11026)) |

Sources: [CHANGELOG](https://github.com/earendil-works/pi/blob/6249ca27d2230a93d2fd44c3ceb3a651bc2baaec/packages/durable/CHANGELOG.md), [README](https://github.com/earendil-works/pi/blob/6249ca27d2230a93d2fd44c3ceb3a651bc2baaec/packages/durable/README.md).

- **Churn hasn't slowed.** 1.4.0 has a Breaking Changes section, 1.5.0 has more than thirty entries in its own, and `[Unreleased]` has five more.
- **The parked-work design landed yesterday.** Zechner's tracking issue of 2026-11-11 lists signals, parks, gates and hook tasks as done on `main` and what remains: code mode that parks its sandbox while its nested calls are parked, and the hosts' side, "UI for parked calls" ([#12026](https://github.com/earendil-works/pi/issues/12026)). The original request for durable approval and client-side tools is still open ([#10852](https://github.com/earendil-works/pi/issues/10852)).
- **Activity.** The newest issues about Durable are a day old, several from the maintainers. Development is daily.

### 6.3 Maturity, in one line

Released on npm, in lockstep with the coding agent's version; self-declared experimental; changing shape every release; developed daily by a small team; used in Earendil's own prototypes (6.4) and a few dozen third-party repositories that a GitHub search finds, none read.

### 6.4 Earendil's own hosts on it

Two things in the repository show where Durable is headed, and both are close to weave.

- **p2** (`apps/p2`): "A self-hosted Pi Durable UI built from independent Chord plugins", with an owner's sign-in, device sessions, guest sharing, session workers and remote access through Radius. Its README opens "p2 is a prototype. It will be gone soon. ... Do not build on it" ([README](https://github.com/earendil-works/pi/blob/6249ca27d2230a93d2fd44c3ceb3a651bc2baaec/apps/p2/README.md)).
- **p3, "Pi Roam"** (`apps/p3/docs`, design notes only): "A personal Pi instance with its sessions and its own plugins; everything extensible", with backups and remote access through Radius, "a one-click cloud machine", and "Environments stay: connect as many machines as you want." Its stated rule: "The instance is the trust boundary" ([status-2026-11-09.md](https://github.com/earendil-works/pi/blob/6249ca27d2230a93d2fd44c3ceb3a651bc2baaec/apps/p3/docs/status-2026-11-09.md), [direction-pi-roam.md](https://github.com/earendil-works/pi/blob/6249ca27d2230a93d2fd44c3ceb3a651bc2baaec/apps/p3/docs/direction-pi-roam.md), marked "Notes only, nothing decided").

Neither is announced on the blog or the site. They are internal design work in a public repository. Read as direction: Earendil is building a personal, always-on, remotely reachable agent host with tools on several machines. That is weave's Host, Dispatcher and app, built on an owned loop.

## 7. Fit for weave

Judgement from here on.

### 7.1 Where the control lives

The person's four wants sort into three places, and only one of them is a wire.

- **Code inside the harness.** Rewriting the context before a request, supplying a compaction summary, replacing a tool's implementation, patching prompt sections, editing the provider payload. Pi gives these to in-process extensions and to nobody else: its own RPC mode has no command for any of them (3.2). ACP has no place for them and shouldn't. A client doesn't send a context transform over a socket forty times a turn; it installs one.
- **Configuration on the Host's disk.** The system prompt file, the tool selection, the model, the compaction threshold, which extensions and skills load. For Pi this is `~/.pi/agent/` and a directory's `.pi/`. For a Bot it would be files in its home, which is already where a Bot's memory is. Nothing crosses a wire.
- **What a client has to see or do while a turn runs.** Steer, cancel, answer a question, pick a model, ask for compaction, see that compaction happened, fork. This is the only part a protocol carries, and it is short.

So the complaint that ACP is a lowest common denominator is half right. It is, and for most of what the person wants it doesn't matter, because the control was never going to be in the protocol. What blocks them today is that Claude Code and Codex are closed loops: weave "has nowhere to put a hook", as the Standard Agents note put it of the same wish ([§5.1](standard-agents-and-its-specification.md#51-what-differs-and-what-it-rules-out)).

### 7.2 The `_meta` claim, tested

The claim holds, with three qualifications.

- **It holds.** Steering is the proof in weave's own tree: `_meta.steering.supported` and `_session/steering` in `acp-core/src/steering.rs`. An open pull request implements the same extension over Pi's `steer`, and the openma adapter ships it, with the same `promptRequired` answer weave asks for. The openma adapter also shows how far `_meta` stretches: extension events, per-tool attribution, three `_pi/` methods, all advertised and ignorable.
- **The standard is not slow just now.** Client-Provided System Prompt went from Draft on 2026-10-12 to Completed on 2026-11-06, in ACP v1 and v2, with "implementations ... landed in the Claude Agent and Codex adapters" while in Preview. Session Compaction completed on 2026-10-06; Elicitation on 2026-07-24 ([RFD updates](https://github.com/agentclientprotocol/agent-client-protocol/blob/c392d7e9d1de01337b749c0070929933e9f6f09f/docs/rfds/updates.mdx)). The Rust crate is at 5.2.0 where weave pins 3.0.0 (crates.io: 3.2.0 on 2026-10-08, 5.0.0 on 2026-11-02, 5.2.0 on 2026-11-10). The counter-example is steering itself: its RFD pull request has been open since 2026-05-19 ([#1261](https://github.com/agentclientprotocol/agent-client-protocol/pull/1261)).
- **There is a second ceiling, and it is weave's.** An extension method has to cross the Host protocol too, and be drawn by the TUI and the app. Steering cost a `turn/steer` request, a journal event and UI in two clients. Each new control costs that again, which is a reason to keep the wire list short, not a reason to doubt the mechanism.
- **Pi itself lowers the ceiling before ACP does.** An adapter over RPC can't offer what RPC lacks. Only an adapter on the SDK reaches all of Pi, which is why the openma adapter is in-process.

### 7.3 Which controls go where

"ACP" means stable v1 or a Completed RFD as of today. "Weave" means implemented at the 3.0.0 pin.

| Pi control | Carried by | In weave today | In `pi-acp` 0.0.34 |
| --- | --- | --- | --- |
| Replace or append the system prompt, per thread | ACP `systemPrompt` on session setup, `append` and `override` (Completed 2026-11-06) | No: not in the pinned schema (1.10.2) | No. Files or flags instead |
| Prompt sections, guidelines, per-turn patches | Harness code or config | n/a | n/a (extension) |
| Context files (`AGENTS.md`, `CLAUDE.md`) | Files in the directory | Yes, nothing to do | Yes |
| Per-request context transform, context edits, provider payload | Harness code. No place in a protocol | n/a | n/a (extension) |
| Model and thinking level | ACP config options | Yes | Yes |
| Which tools are on | ACP config options could carry a named tool set; otherwise config | Config options yes | No |
| Replace or add tools | Harness code; or MCP servers the client passes; or the Host MCP server | Host MCP server, 2026-07-28 only | No |
| Ask before a tool runs | ACP `session/request_permission` | Yes, with the permission policy | Only if an extension asks |
| Ask the person something else | ACP elicitation (Completed 2026-07-24) | Yes | No; `input` and `editor` are cancelled |
| Steer a running turn | `_session/steering`, an extension advertised in `_meta` | Yes | No (open PR #176) |
| Queue a prompt, reorder, clear | The Host's own queue | Yes | Not needed |
| Cancel | ACP `session/cancel` | Yes | Yes |
| Compact now, with instructions | A slash command the agent lists | Yes | Yes (`/compact`) |
| See that compaction happened | ACP `compaction_update` (Completed 2026-10-06) | Yes, at the Preview draft | No |
| Turn auto-compaction off, set the threshold | Config option, or config | Config options yes | Slash command |
| Supply the compaction summary | Harness code. A client doing it would need an extension method | No | n/a (extension) |
| Fork a thread at a message | ACP `session/fork` RFD (stage not checked) | No | No (open PR #171) |
| Move within one session's tree, with a branch summary | No ACP concept; an extension method. Pi's RPC lacks it too | No | No |
| Reopen, list, delete | ACP `session/load`, `list`, `delete` | Load yes | Yes |
| Skills, prompt templates | Slash commands | Yes | Yes |
| Usage and cost | ACP `usage_update` | Yes | Context size only |
| Extension status lines, widgets, custom events | `_meta` on `session_info_update`, by convention per agent | No | Notifications as text |
| Custom terminal UI from an extension | No place | n/a | n/a |
| Sub-agents | Pi has none. ACP's subagents RFD is draft | Yes, both drafts | No |

Three rows need `_meta` or an extension method and are worth having: steering (done), tree navigation, and a client-supplied compaction summary. Everything else is either already ACP, or harness code and config.

### 7.4 The candidates

| Candidate | Verdict | What it costs |
| --- | --- | --- |
| Pi as a weave agent through `pi-acp`, today | Fits with caveats | Nothing to launch. No Host MCP server, no steer, no permission requests; API billing for Claude |
| Pi's SDK behind a weave-written ACP adapter | Fits | A Node program of a few thousand lines outside the Cargo workspace, pinned to a Pi minor, re-pinned as Pi breaks |
| Pi as the harness for Bots | Fits with caveats, blocked on MCP | The Host MCP gap closed first; a trust decision for the home; API billing |
| Pi's design as the model for a Rust harness | Fits as a model; the build doesn't fit yet | The loop is small. The provider layer and the plugin story are not |
| Pi Durable as the base of an owned loop | Fits with caveats; wait | Its ACP adapter is weave's to write, against an API that changes every release |
| Pi Durable in place of the Host's journals or the Dispatcher | Doesn't fit | ADR 0011's answer stands |

**Pi through `pi-acp`, today: fits with caveats.** It is the cheapest way to hold Pi's controls in a weave thread: put a `SYSTEM.md`, a `settings.json` and an extension or two under `~/.pi/agent/` or the thread's `.pi/`, and they apply. The caveats are 4.4's. For an interactive spike in a scratch repository none of them blocks. For daily use the missing steer and the missing Host tools would, and the adapter's maintainer hasn't merged in five weeks. The ledger the person plans should have three columns per entry: the control reached for, where it lived (extension, file, slash command, nowhere), and whether anything had to cross ACP. This note's expectation is that the third column will be short.

**Pi's SDK behind a weave-written adapter: fits.** The existing adapter is thin where weave needs it thick, and it can't be otherwise, because it sits on RPC. An adapter on the SDK reaches everything, and weave's own would be narrower than openma's 7,360 lines: no editor delegation, no auth flows, no Zed conventions; just weave's updates, `_session/steering`, `compaction_update`, `systemPrompt`, permission requests from a gate weave writes as an inline extension, and an MCP route that reaches the Host. It runs as a child process like any agent, so ADR 0011's seam holds and the Host learns nothing about Pi. Costs: a TypeScript package in a Rust repository (as `app/` is), Node 22.19, and a pin on a library that breaks in minors, 1.5.0's tool-schema change among them. The openma adapter is Apache-2.0 and worth reading as the worked example, and worth a week's trial before writing anything.

**Pi as the harness for Bots: fits with caveats, blocked on MCP.**

- **What fits.** A Bot is a Dispatcher record and a home whose files are its memory ([ADR 0028](../adr/0028-bots-are-dispatcher-records-whose-work-goes-on-in-ordinary-threads.md)). Pi reads the home's `AGENTS.md` or `CLAUDE.md` unprompted. A `.pi/` directory in the home would hold the Bot's own system prompt, tool set, compaction settings, skills and extensions, under git with the rest of its memory: the control the person wants, per Bot, with no protocol involved. The adapter lists `/compact`, which is how ADR 0028 means the Dispatcher to compact a Bot. A Bot's permission policy would have little to do.
- **What blocks.** A Bot manages its wake-ups and schedules through service tools on the Host MCP server, and makes other Bots the same way. Pi can't reach that server (4.4). Until it can, a Pi Bot can be prompted and scheduled from outside and can't schedule itself.
- **What it costs.** Model usage at API prices where Claude Code runs on the subscription. No permission asks unless weave supplies the gate. A saved trust decision for each home, since the adapter's Pi can't ask.
- **Closing the gap** has two ends. Weave's: let the Host MCP server answer `initialize` for older revisions, which [ADR 0009](../adr/0009-client-tools-through-a-host-owned-mcp-server.md) rejected because it "adds a second, stateful lifecycle", accepting that "an agent whose MCP client doesn't speak 2026-07-28 gets no client tools". Pi's: `pi-mcp` gaining 2026-07-28, which nothing read here announces. A weave-written adapter has a third way, registering the Host's tools as Pi tools directly through an inline extension, which skips MCP inside the agent and is probably the cleanest.

**Pi's design as the model for a Rust harness: fits as a model.**

- **Size.** The loop is 2,555 lines in six files, and a Rust one would be about that. Around it, Pi's session object, tree, compaction, prompt builder and tools are roughly 12,000 lines, the rest of `core/` another 24,000, and the provider layer 28,759 with a generated model catalogue and nine OAuth flows. A harness with one provider, four tools, JSONL sessions and compaction is perhaps 8,000 to 12,000 lines of Rust before it is as good as Pi on a bad day. That is an estimate from Pi's sizes, not a measurement.
- **Crate boundaries Pi's layering suggests.** A provider crate that knows nothing of agents (`pi-ai`). A loop crate that depends only on it and takes its storage, context and tool policy as functions (`pi-agent-core`'s eight options). A harness crate with sessions, compaction, the prompt, tools and resources. A binary that speaks ACP as an agent, which `fake-agent/` already shows weave doing in Rust. None would depend on `host/` or `protocol/`.
- **What to copy.** The loop's seams, by name. The session as an append-only tree of entries from which context is rebuilt, with compaction and context edits as entries, so nothing is ever rewritten. The prompt as named sections, diffed and patched mid-conversation to keep the provider's cache. `agent_settled` as distinct from the end of one run. Tool exposure as four levels. Steering delivered after the current tool round, never mid-tool.
- **What doesn't carry over.** Pi's control is cheap because an extension is a TypeScript file loaded into the process. Rust has no equivalent. A Rust harness would offer hooks as external commands, as MCP servers, as WebAssembly, or as recompilation, each slower to write than the thing the person got a glimpse of. This, more than line count, is the argument for owning the loop in TypeScript on Pi's SDK first and learning which hooks are actually used.
- **And the earlier note's caution holds**: an owned loop is billed by API key, at least for Claude ([§5.2](mastra-vs-pi-durable-agent-runtime.md#52-three-layers-decided-separately)).

**Pi Durable: fits with caveats as the base of an owned loop; wait.** Item by item:

- **Threads that outlive the Host process.** A Durable agent is still a child of the Host and dies with it. What it adds is that on reopening it resumes inside the turn, where today the Host journals an interrupted turn and a headless thread continues once. That is a real gain for an owned loop, and only for one. It raises an ACP question the earlier note didn't: a resumed run produces updates with no `session/prompt` outstanding, and ACP has no turn the agent starts. Weave's steering extension has the nearest idea, a turn answered as detached.
- **Waits that survive a restart.** Parks and sleeping gates are what weave's pending requests lack: "a pending request ends with its turn". They are a day old on `main` and unreleased.
- **Bots that sleep and wake.** Durable sleeps and signals overlap wake-ups, schedules and occurrences, which the Dispatcher already keeps, across Hosts, with catch-up. A sleep inside an agent needs its process alive, or a host that arms a timer and reopens it (`onWake`). That host would be the Host, doing the Dispatcher's job a second time. No gain.
- **Agents not tied to one computer.** Durable's answer is `pi-env`, tools on another machine over SSH, with storage on one. Weave's is a Host per computer and delegated threads through the Dispatcher. They don't compose, and weave's is built.
- **Journals and replay.** Durable still gives a late client the current view and nothing before it. The Host's journal is the stronger contract, as ADR 0011 found.
- **The earlier note's conditions**, before relying on it: released durable sleeps (met, 1.4.0), a durable external wait (on `main`), and "a stretch of releases without storage-format breaks" (not met). Its sketch of the adapter needs redoing: `watchEvents()` is gone, so `session/update` would be derived from the operations of conversation watches.
- **A warning from 6.4.** Earendil is building the product weave is. Taking Durable as a base means depending on a competitor's experimental library whose roadmap is its own hosts.

### 7.5 Ranked: what to do

Spike first:

1. **Run Pi under weave as it is.** `weave --agent pi-acp` in a scratch repository, with an API key or a non-Anthropic login. Keep the three-column ledger of 7.4. One day. It tests 4.4's lists, which are from source and unproven.
2. **Try the same with `@openma/pi-acp` as a config agent**, for a second day. It should exercise weave's existing steering and compaction support against a real second agent, and show whether its MCP passthrough gets as far as the Host's refusal. It also shows what a full adapter feels like before deciding to write one.
3. **Bump the ACP pin and try `systemPrompt` on Claude Code and Codex.** This is the one control on the person's list that the agents weave already runs now accept through stable ACP. It needs the crate past 3.0.0 and a field on thread creation in the Host protocol. It gives a Bot its own instructions without a new harness, and it is worth doing whatever happens with Pi.
4. **Look again at the Host MCP server's reach.** ADR 0009 accepted that an agent with an older MCP client gets no client tools. Since then the server has come to carry Host tools and service tools, which a Bot needs to schedule itself, so the same rule now costs more. Either the server answers older revisions, or an adapter weave writes hands Pi the tools directly, or weave accepts that such agents can't be Bots that manage themselves. This decision gates Pi for Bots.
5. **Then choose**, from the ledger: live with the registry adapter and send it the steering patch that already exists; write weave's own adapter on Pi's SDK; or conclude the controls used were few enough that a `systemPrompt` and a Bot's home files cover them.

Watch:

- **Pi Durable's next release**: whether signals, parks and gates ship, and whether a release goes by without a storage or API break. Issues [#12026](https://github.com/earendil-works/pi/issues/12026), [#10852](https://github.com/earendil-works/pi/issues/10852), [#10386](https://github.com/earendil-works/pi/issues/10386).
- **p3 and Pi Roam**: if it ships, it is the nearest thing to weave from a team with a loop of its own.
- **`svkozak/pi-acp`**: whether #176 and #181 merge, or the registry entry goes stale against Pi 1.x.
- **ACP's steering RFD** (#1261): when it lands, weave's extension becomes a compatibility shim.
- **Anthropic's terms** on subscription logins, and what Pi's warning says after any change.
- **`pi-mcp` and MCP 2026-07-28.**

Not worth doing now: a Rust harness; an ACP adapter over Pi Durable; a preset for Pi; anything that reads Pi's `auth.json`.

### 7.6 Open questions

- Which controls did the person actually use in Pi? The ledger answers this, and the answer decides between a file in a Bot's home and a harness.
- Is API billing acceptable for the work an owned loop would do? If it is only for Bots and headless work, as ADR 0011 assumed, yes. If the person wants Pi for interactive coding in place of Claude Code, the cost is a different size.
- Should a control surface belong to the agent's directory (`.pi/`, per harness) or to weave (a Bot's record in the Dispatcher, passed as `systemPrompt` and config options)? The second works across agents and is poorer; the first is rich and Pi-only.
- For an owned loop, does weave want Pi's extension model, or its own smaller set of hooks? The spike should count how many of Pi's 40-odd events were touched.
- Is there a Rust provider layer worth building on? Not researched here, and it is the larger half of a native harness.
- Would Earendil take an ACP mode in the coding agent? Zechner's 2025 answer was that he'd "be happy to merge a nice PR" for "a new mode". The adapters exist; none has been offered upstream that was found.
- How should a turn the agent resumes by itself appear in ACP and in the journal? It matters for any durable loop, not only Pi's.

## 8. Not verified

- **Nothing was run.** Pi, the adapters and Pi Durable were read, not installed. Section 4.4's lists of what would and wouldn't work under weave are from the adapters' source and weave's guides, not from a thread.
- **Weave's behaviour without steering support.** That the Host has no steer to pass to an agent that doesn't advertise the extension is from `host/AGENTS.md` and `acp-core/src/steering.rs`; what a client then sees was not traced. That the pinned ACP schema lacks `systemPrompt` is from a text search of the vendored 1.10.2 schema crate.
- **`@openma/pi-acp` against Pi 1.5.2.** It depends on `^1.1.0`; whether it still builds and runs was not tested. Its claims were checked against its source only for capabilities, steering, MCP registration, compaction updates and elicitation. Its repository shows a push on 2026-11-11 that is not on `main`; what was pushed wasn't found.
- **Whether `pi-acp` 0.0.34 still gets compaction events from Pi 1.5.** It listens for `auto_compaction_start`; Pi's current documentation names `compaction_start`. When the name changed was not found in the changelog.
- **Anthropic's billing of third-party harnesses as "extra usage".** Only Pi's source says so. Anthropic's page was read on 2026-11-12 through a fetch that converts the page, and carries no date. Its consumer and commercial terms were not read.
- **OpenAI, GitHub and the other providers' terms** for subscription logins in a third-party harness. Not read.
- **The acquisition's terms.** Earendil's post says an acquisition happened and that Zechner joined. Licence and governance commitments were not stated in what was read.
- **Counts from APIs.** Stars, forks, issue counts and dates are the GitHub API's on 2026-11-12; npm and crates.io versions likewise. Line counts are physical lines, comments and blanks included.
- **ACP RFD stages** other than client system prompt, session compaction, elicitation and the steering pull request: `session/fork`, `resume`, `close`, `list`, `delete`, `session/options` and configurable providers were seen as files, not checked for stage.
- **Third-party Pi Durable projects and the other ACP adapters** were listed from a GitHub search and not read.
- **p2 and p3.** p2's README and p3's status and direction notes were read in part. Pi Roam is not announced anywhere public that was found; it may change or stop.
- **Pi Durable's unreleased features** were read from the changelog, the README and the tracking issue, not from the implementation or its tests.
- **The older site.** Whether shittycodingagent.ai still resolves, and to what, was not checked.
- **Model and provider names** in Pi's documentation were taken as written.
- **Weave's side.** The Host MCP server's protocol version, the bridge and the permission policy's option kinds were read from `host/AGENTS.md`, `agents/src/config.rs`, `agents/src/registry.rs`, `acp-core/src` and `protocol/src/policy.rs`. No Linear issue was read.
