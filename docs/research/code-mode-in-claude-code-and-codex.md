# Code mode in Claude Code and Codex

Research snapshot, 2026-11-13. Primary sources only. Codex was read from a clone of `openai/codex` at [`69231e11`](https://github.com/openai/codex/tree/69231e119bfca0b14453515e97d99688ce1c47c9) (`main`, 2026-11-13; latest release `rust-v0.169.0`, published the same day), with its history back to 2026-02-20, and its pull requests, issues and release notes through the GitHub API. Claude Code is closed source, so it was read from its [CHANGELOG.md](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) (top entry 2.1.323), its documentation at [code.claude.com](https://code.claude.com/docs/llms.txt) and the npm registry's publish dates. The two ACP adapters were read from clones of `agentclientprotocol/codex-acp` at [`65676511`](https://github.com/agentclientprotocol/codex-acp/tree/656765115f82253c79f87918abb77189c114a799) (2.6.0) and `agentclientprotocol/claude-agent-acp` at [`7e857d59`](https://github.com/agentclientprotocol/claude-agent-acp/tree/7e857d59ec777356969ab615af83eef02ac43e59) (0.107.0). The model APIs were read from [platform.claude.com](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling) and [developers.openai.com](https://developers.openai.com/api/docs/guides/tools-programmatic-tool-calling.md). Documentation pages were read through a fetch that converts and sometimes summarises them, and they carry no version. Nothing was installed or run. Weave is judged at `4ea2204c` plus uncommitted app work. Sections 1 to 5 are facts. Section 6 lists what wasn't verified. Section 7 is observations for weave.

The question: what is new, as of today, around "code mode" in Claude Code and Codex. Code mode here means an agent calling its tools by writing code that a sandbox runs, instead of emitting one JSON tool call per step and reading each result. The person saw there had been recent developments and asked what they are.

This note uses weave's words (Host, client, thread, turn, pending request, permission policy). Codex's *cell* is one run of one script. Claude Code's *session* and Codex's *thread* are both weave's thread.

## In brief

- **Claude Code shipped Code Mode yesterday.** Version 2.1.323, published 2026-11-12, "Added Code Mode, an experimental opt-in in which Claude writes JavaScript to call its tools". It is off by default, turned on with `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1`, and works only in an interactive terminal session. It does not work with `-p`, the Agent SDK, the VS Code panel, the Desktop app or cloud sessions. Confidence: high, from the changelog and the documentation page.
- **Codex has had code mode since March, and it has been the default tool interface for its current models since July.** The feature flag `code_mode` is still marked under development and off by default, but the model catalogue overrides the flag: every listed model from GPT-5.6 on is `code_mode_only`, which shows the model two tools, `exec` and `wait`, and puts everything else behind JavaScript. Only `gpt-5.5` still calls tools directly. Confidence: high, from the source and the bundled catalogue.
- **So the two products are at opposite ends.** In Codex it is the main path, with a separate V8 host process, eight months of hardening, and open issues about what clients can see. In Claude Code it is one day old, opt-in, and fenced off from every programmatic surface.
- **Permissions stay per nested call in both.** Neither product approves a script as a whole, except Claude Code's auto mode, whose classifier reviews the code once and not each call.
- **Neither shows clients the script.** Codex's app-server emits the nested calls as ordinary items and has no item for the script or for what the model read back; an issue asking for one was opened two days ago. Claude Code shows the nested tool calls in the conversation and keeps the code in the transcript viewer.
- **Both model APIs now have the same thing as a hosted feature.** Anthropic's programmatic tool calling left beta on 2026-02-17 (Python, in Anthropic's container). OpenAI's Programmatic Tool Calling arrived with GPT-5.6 on 2026-07-09 (JavaScript, in a V8 isolate). Both mark each nested call with a `caller`.
- **Measured claims are thin.** Anthropic gives two numbers for its API feature. OpenAI gives none and says to measure. The only measurements of Codex's code mode are users', and they report that the model rarely batches calls unless told to.

## 1. Background, briefly

- **CodeAct and smolagents (2024)** put the idea in print: let the model write code that calls tools. Not re-read for this note.
- **Cloudflare named it "Code Mode"** in 2025. Its later posts describe an MCP server for its whole API with two tools, `search` and `execute` ([Code Mode: give agents an entire API in 1,000 tokens](https://blog.cloudflare.com/code-mode-mcp/)), the same pattern at its MCP portals ([enterprise MCP](https://blog.cloudflare.com/enterprise-mcp/)), and on 2026-07-22 `execute()`, `search()` and `describe()` on the SDK's runtime handles ([changelog](https://developers.cloudflare.com/changelog/post/2026-07-22-mcp-codemode-updates/)). These were found by search and read only as search summaries.
- **Anthropic, 2025-11-04:** [Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp) proposed presenting MCP tools as TypeScript files on disk that the agent lists, reads and imports, with an optional `search_tools`. Its figure, "from 150,000 tokens to 2,000 tokens—a time and cost saving of 98.7%", comes with no benchmark or method and reads as an illustration.
- **Anthropic, 2025-11-24:** [Introducing advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use) launched the tool search tool and programmatic tool calling in beta on the Claude API ([release notes](https://platform.claude.com/docs/en/release-notes/overview)).
- **Other harnesses.** Pi ships `pi-codemode`, a JavaScript sandbox in which scripts call tools, and can mark a tool `codemode` so it is callable only from scripts ([earlier note §2.5](pi-its-control-surface-acp-and-pi-durable.md#25-tools)). Goose documents a code mode of its own ([code-mode.md](https://github.com/block/goose/blob/main/documentation/docs/guides/managing-tools/code-mode.md), seen as a file, not read). opencode and Cursor were not checked.

## 2. Claude Code

### 2.1 Code Mode: what shipped, and when

- **Release.** 2.1.323: "Added Code Mode, an experimental opt-in in which Claude writes JavaScript to call its tools; see https://code.claude.com/docs/en/code-mode to turn it on, or to turn it off for an organization" ([CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)). npm published 2.1.323 on 2026-11-12 at 20:29 UTC. It is the `latest` and `next` tag; `stable` is 2.1.311 (npm registry).
- **Status.** "Code Mode is experimental and off by default. It may change or be removed in any release" ([Code Mode](https://code.claude.com/docs/en/code-mode.md)). No earlier changelog entry mentions it.
- **Turning it on.** `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1` in the shell or in the `env` block of `~/.claude/settings.json`. Claude Code ignores the variable in a project's settings files, "so a repository you clone can't turn on Code Mode for you". It asks for confirmation before the first Code Mode session and then restarts. A `0` anywhere wins over a `1`. An organisation can block it with a `0` in managed settings and cannot turn it on from there ([Code Mode](https://code.claude.com/docs/en/code-mode.md), [environment variables](https://code.claude.com/docs/en/env-vars.md)).
- **Where it runs.** Only "an interactive `claude` session in a terminal. Code Mode doesn't work with `-p`, the Agent SDK, the VS Code panel, the Desktop app, or cloud sessions". It needs the native build, a Claude subscription or Console account (not a gateway, Bedrock, Google Cloud or Foundry), no HIPAA configuration or zero data retention, and one of Opus 5.5, Sonnet 5.5, Haiku 5.5 or Fable 5.2. It also refuses to start with an API key helper, agent teams, OpenTelemetry export, `DISABLE_TELEMETRY`, `--remote-control`, or an installed mod that checks tool calls. A reason of "it isn't open to your account yet" implies a staged rollout.

### 2.2 How it works

- **Language and tool.** Claude writes JavaScript, and "Claude Code runs that code in your session". The tool that runs it is named `REPL`; a hook reads the source from `tool_input.code`. The documentation's example calls a shell through a tagged template, an `edit(path, old, new)` function, and returns its last expression:

  ```javascript
  const files = await $`rg -l "function retryPolicy" src`.text();
  const target = files.trim().split("\n")[0];
  await edit(target, "maxAttempts: 3", "maxAttempts: 5");
  ({ edited: target, tests: $`npm test -- retryPolicy`.nothrow() });
  ```

- **What returns to the model.** "The last line returns the file's path and the test output to Claude", so the script chooses what the model reads.
- **Runtime and sandbox.** Not documented. The page names no JavaScript engine and no isolation for the script itself. It points to Claude Code's existing sandboxing for "limits that don't depend on command text".
- **MCP tools and discovery.** Not documented. The page doesn't say how MCP tools appear to the script or how deferred tools are found from inside it. The [tools reference](https://code.claude.com/docs/en/tools-reference.md) doesn't list `REPL` yet.
- **Long scripts.** A script the model waits for stops after ten minutes, permission prompts included. In auto or `bypassPermissions` mode a script can continue in the background for up to two hours while the person keeps talking.
- **Resuming.** A Code Mode session can be resumed only in the terminal with Code Mode on: "With Code Mode off, Claude Code refuses to resume the session." It can't be moved to the Desktop app, made a background session, or used with Remote Control, Claude in Chrome or computer use.

### 2.3 Permissions

- **Per nested call, by the existing rules.** "Each tool call that Claude's code makes goes through your `deny` and `ask` permission rules and your `PreToolUse` hooks. You don't need to change a rule or matcher for a tool such as `Bash`."
- **Modes that ask.** "The code starts without a review, and you're prompted for each tool call that would prompt you in that mode."
- **Auto mode.** "The classifier reviews each piece of code before it runs, not each tool call. It doesn't see values computed at run time, such as a path taken from search output, so keep rules or hooks for calls you must control." If the model starts more code while earlier code still runs, the earlier code loses its review, and its remaining calls are put to the person with a two-minute countdown, after which they are refused.
- **Checking the script.** A `PreToolUse` hook matching `REPL`.
- **Hooks fail closed.** For a call made from a script, a `PreToolUse` hook that fails or times out refuses the call even when `onFailure` is unset, which differs from direct calls ([hooks](https://code.claude.com/docs/en/hooks.md) points to this).

### 2.4 What the person and a client see

- **In the terminal.** "In the conversation, you see the tool calls, such as the edit's diff, and not the code." The code is in the transcript viewer (`Ctrl+O`) as a collapsed **Code** row.
- **Over the Agent SDK and ACP: nothing, because it doesn't run there.** `claude-agent-acp` 0.107.0 is built on `@anthropic-ai/claude-agent-sdk` 0.3.323 ([package.json](https://github.com/agentclientprotocol/claude-agent-acp/blob/7e857d59ec777356969ab615af83eef02ac43e59/package.json)), and its source has no mention of Code Mode or `REPL`. An ACP client of Claude Code cannot get Code Mode today.

### 2.5 Tool search and deferred MCP tools

This is the older half of the same story, and it does reach the Agent SDK.

- **History.** 2.1.7 (2026-01-13) "Enabled MCP tool search auto mode by default for all users. When MCP tool descriptions exceed 10% of the context window, they are automatically deferred". 2.1.121 (2026-04-27) added `alwaysLoad` for an MCP server. 2.1.285 and 2.1.287 added a per-tool `_meta['anthropic/alwaysLoad']` and `alwaysLoad: false`. 2.1.295 (2026-10-08) raised the cut on descriptions loaded through tool search from 2,048 to 16,384 characters. 2.1.304 (2026-10-19) turned tool search on behind a custom `ANTHROPIC_BASE_URL` ([CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)).
- **Today.** "Tool search is on by default." With `ENABLE_TOOL_SEARCH` unset, "tool definitions [are] deferred and discovered on demand"; `auto` and `auto:N` wait for a share of the context window; `false` loads everything. It "applies to all registered tools, whether they come from remote MCP servers or custom SDK MCP servers", core built-in tools such as Bash, Read and Edit excepted. The model gets a summary of available tools and a `ToolSearch` tool, which loads up to five matches per search; loaded tools stay until the messages that found them are compacted. Limits: 10,000 tools; Opus 4, Sonnet 4, Haiku 4.5 and later ([Agent SDK: tool search](https://code.claude.com/docs/en/agent-sdk/tool-search.md)).
- **Cost stated by Anthropic.** "Tool search adds one extra round-trip each time Claude searches for tools"; under about ten tools, loading everything is "typically faster".

### 2.6 The Claude API: programmatic tool calling

- **Status.** Beta on 2025-11-24. On 2026-02-17, "programmatic tool calling [is] available with no beta header required", and the tool search tool and code execution tool left beta the same day ([release notes](https://platform.claude.com/docs/en/release-notes/overview)). The page's metadata says `status: stable` ([programmatic tool calling](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling)).
- **How.** A tool opts in with `allowed_callers: ["code_execution_20260120"]`. "Claude writes Python code that calls the tool as a function", in Anthropic's code execution container; tools appear as async Python functions that take a dict and return a string. When the code calls a client's tool, the response stops with a `tool_use` block whose `caller` names the code execution run; the client returns a `tool_result` and passes the container id back. A pending call times out after about four minutes.
- **What the model reads.** "Tool results from programmatic calls do not count toward your input/output token usage. Only the final code execution result and Claude's response count."
- **Limits.** Tools with `strict: true` and `disable_parallel_tool_use` are not supported. Tools from the MCP connector "cannot be called programmatically". Not eligible for zero data retention. And `allowed_callers` "is not a hard API-level block on direct calls ... Do not rely on `allowed_callers` as a security boundary."
- **Relation to Claude Code.** Different mechanism. The API feature is Python in Anthropic's container; Claude Code's Code Mode is JavaScript run by Claude Code on the person's computer. No source says Code Mode uses the API feature.

## 3. Codex

### 3.1 What it is called, when it shipped, and its status

- **Name.** Code Mode in prose, `code_mode` in config, crates `codex-code-mode`, `codex-code-mode-host`, `codex-code-mode-protocol` and `codex-code-mode-runtime` ([codex-rs](https://github.com/openai/codex/tree/69231e119bfca0b14453515e97d99688ce1c47c9/codex-rs)).
- **Timeline**, from pull requests and release notes:

| Date | Change |
| --- | --- |
| 2026-03-10 | "Add code_mode experimental feature": "A much narrower and more isolated (no node features) version of js_repl" ([#13418](https://github.com/openai/codex/pull/13418)). The tool is renamed `exec` the same day ([#14254](https://github.com/openai/codex/pull/14254)) |
| 2026-03-13 | `code_mode_only`: the model's tools are restricted to the code mode entry points ([#14617](https://github.com/openai/codex/pull/14617)) |
| 2026-03-21 | From an external Node process to a V8 runtime embedded in Rust, "one V8 runtime thread per active `exec`" ([#15276](https://github.com/openai/codex/pull/15276)) |
| 2026-04-16 | Deferred MCP tools are left out of the `exec` description and found through `ALL_TOOLS` ([#17287](https://github.com/openai/codex/pull/17287)) |
| 2026-05-29 | A model's catalogue entry may set `tool_mode` to `direct`, `code_mode` or `code_mode_only`, overriding the flags ([#25031](https://github.com/openai/codex/pull/25031)) |
| 2026-07-09 | The bundled catalogue adds GPT-5.6 Sol, Terra and Luna, all `code_mode_only` ([`3380969a`](https://github.com/openai/codex/commit/3380969a29134630d56feb6218e8e8dcc5e8196d)), in 0.144.0 the same day |
| 2026-07-30 | V8 moves out of the Codex process into a standalone host, `codex-code-mode-host` ([#36217](https://github.com/openai/codex/pull/36217), 0.147.0), linked against a V8 built with its sandbox ([#36374](https://github.com/openai/codex/pull/36374)) |
| 2026-08-18 | A gRPC protocol for the host, local or remote (0.148.0) |
| 2026-09-16 | The `exec` wrapper is removed from the automatic reviewer's approval scopes; nested tools keep theirs ([#45915](https://github.com/openai/codex/pull/45915)) |
| 2026-10-08 | "JavaScript helpers for streaming promise results as they settle, plus opt-in ranked tool search in Code Mode" (0.162.0) |
| 2026-10-15 | "Interrupting a turn also stops active Code Mode cells and their nested tool calls" (0.163.0) |
| 2026-11-06 | The host truncates output before it reaches Codex (0.167.0); gRPC and host truncation become the default ([#59973](https://github.com/openai/codex/pull/59973), 0.169.0) |
| 2026-11-13 | Incremental tool definitions for code mode sessions, and strict deferral of third-party tools in Code Mode Only (0.168.0, 0.169.0) ([releases](https://github.com/openai/codex/releases)) |

- **Flag against catalogue.** `code_mode` and `code_mode_only` are `Stage::UnderDevelopment`, `default_enabled: false` ([features/src/lib.rs](https://github.com/openai/codex/blob/69231e119bfca0b14453515e97d99688ce1c47c9/codex-rs/features/src/lib.rs#L1309-L1320)), and the configuration reference says of `features.code_mode.enabled`, "This feature is under development and off by default" ([reference](https://developers.openai.com/codex/config-reference.md), which redirects to learn.chatgpt.com). But the mode used is `model_info.tool_mode`, and the flags apply only when the model sets none ([core/src/tools/mod.rs](https://github.com/openai/codex/blob/69231e119bfca0b14453515e97d99688ce1c47c9/codex-rs/core/src/tools/mod.rs#L66-L89)).
- **The catalogue today** ([models.json](https://github.com/openai/codex/blob/69231e119bfca0b14453515e97d99688ce1c47c9/codex-rs/models-manager/models.json)): `gpt-6.1-sol`, `gpt-6.1-terra`, `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, two hidden `gpt-daybreak` models and `codex-auto-review` are `code_mode_only`. `gpt-5.5` sets nothing. Turning the flag on for a model that sets nothing draws a warning that it "does not advertise Code Mode support. This may degrade model performance" ([#29490](https://github.com/openai/codex/pull/29490)).
- **No announcement found.** OpenAI's Codex changelog lists the pull request titles above and nothing that explains the feature. There is no documentation page for it in the repository or, that a search found, on OpenAI's site.

### 3.2 How it works

From the description the model is given ([description.rs](https://github.com/openai/codex/blob/69231e119bfca0b14453515e97d99688ce1c47c9/codex-rs/code-mode-protocol/src/description.rs#L24-L57)):

- **Two tools.** `exec` takes raw JavaScript, "not JSON, quoted strings, or markdown code fences". `wait` resumes or terminates a running cell by `cell_id`.
- **Runtime.** "Evaluates the provided JavaScript code in a fresh V8 isolate as an async module ... Runs raw JavaScript -- no Node, no file system, no network access, no console." The script's only reach is the tools it is given.
- **Tools in the script.** "All nested tools are available on the global `tools` object, for example `await tools.exec_command(...)`. Tool names are exposed as normalized JavaScript identifiers, for example `await tools.mcp__ologs__get_profile(...)`." Built-in tools and MCP tools are called the same way. Each is described to the model as a TypeScript declaration rendered from its JSON Schema, with shared MCP result types such as `CallToolResult`.
- **Discovery.** `ALL_TOOLS` is "metadata for the enabled nested tools as `{ name, description }` entries". Deferred tools are left out of the description: "They are still available on the global `tools` object and listed in `ALL_TOOLS`. To find one, filter `ALL_TOOLS` by `name` and `description`." Behind the flag `code_mode_tool_search` (under development, off), `tools.tool_search({query, limit})` returns BM25-ranked matches with their declarations ([#51209](https://github.com/openai/codex/pull/51209)). Nothing is written to disk as stubs.
- **What returns to the model.** Only what the script emits with `text()`, `image()`, `audio()` or `notify()`. A first-line pragma, `// @exec: {"yield_time_ms": 10000, "max_output_tokens": 1000}`, sets how long before the call yields and the output budget, which "defaults to 10000 tokens". A script still running returns `Script running with cell ID ...` and is picked up with `wait`. `store()` and `load()` keep values between `exec` calls in a thread.
- **Code Mode Only.** A nested tool is hidden from the model's own tool list, so the model must go through `exec` ([spec_plan.rs](https://github.com/openai/codex/blob/69231e119bfca0b14453515e97d99688ce1c47c9/codex-rs/core/src/tools/spec_plan.rs#L887-L915)). Some tools stay direct, among them `request_user_input`, the sleep tool and hosted tools ([#27316](https://github.com/openai/codex/pull/27316), [#34969](https://github.com/openai/codex/pull/34969), [#25890](https://github.com/openai/codex/pull/25890)).
- **Configuration.** `features.code_mode.excluded_tool_namespaces` and `direct_only_tool_namespaces`, and per MCP server `mcp_servers.<id>.omit_tools_from`, which takes `direct`, `deferred` or `code_mode` ([feature_configs.rs](https://github.com/openai/codex/blob/69231e119bfca0b14453515e97d99688ce1c47c9/codex-rs/features/src/feature_configs.rs#L36-L61)). The app-server takes `--code-mode-host <url>` for a remote host.
- **If the host is missing.** In `code_mode` Codex falls back to direct tools with a warning; in `code_mode_only` it fails closed ([#36217](https://github.com/openai/codex/pull/36217)).

### 3.3 Permissions

- **Per nested call.** A nested call is submitted to the same tool runtime as a direct one, under a fresh id of the form `exec-<uuid>` ([delegate.rs](https://github.com/openai/codex/blob/69231e119bfca0b14453515e97d99688ce1c47c9/codex-rs/core/src/tools/code_mode/delegate.rs#L307-L345)), so the sandbox and the approval policy apply to it as they would to a direct call.
- **The wrapper is not approved.** "Code Mode wrappers have no approval scope; their nested tools follow this policy" ([guardian.rs](https://github.com/openai/codex/blob/69231e119bfca0b14453515e97d99688ce1c47c9/codex-rs/protocol/src/openai_models/guardian.rs#L38-L39)).
- **Grants within a cell.** An app-server test covers a script that awaits `request_permissions` and then runs `exec_command` in the same cell, with turn-scoped and thread-scoped grants ([#48017](https://github.com/openai/codex/pull/48017)).
- **Interrupt.** Since 0.163.0 an interrupted turn stops its cells and their nested calls.

### 3.4 What a client sees

- **The app-server emits the nested calls and not the script.** Its `ThreadItem` variants are user and agent messages, plan, reasoning, `commandExecution`, `fileChange`, `mcpToolCall`, `dynamicToolCall`, `collabAgentToolCall`, `subAgentActivity`, `webSearch`, `imageView`, `sleep`, `imageGeneration`, review mode and `contextCompaction` ([item.rs](https://github.com/openai/codex/blob/69231e119bfca0b14453515e97d99688ce1c47c9/codex-rs/app-server-protocol/src/protocol/v2/item.rs#L319)). None is a code mode cell. The script and its result exist as `custom_tool_call` and `custom_tool_call_output` in the rollout and in the experimental `rawResponseItem/completed` notification.
- **An open request, two days old.** [#60694](https://github.com/openai/codex/issues/60694) (2026-11-11, from a third-party client's author, no maintainer reply): "app-server clients see only the nested items ... They do not see the `exec` call itself." It reports a case where the client was sent two complete `aggregatedOutput`s while the model had read a result cut twice, once by the nested tool's limit and once by the `exec` budget. [#57466](https://github.com/openai/codex/issues/57466) asks for the parent `call_id` on nested `commandExecution` items, since the `exec-<uuid>` id "appears on no other rollout record".
- **Over ACP.** `codex-acp` 2.6.0 depends on `@openai/codex` `^0.166.0`, "starts the Codex App Server ... and maps Codex events back into the client" ([README](https://github.com/agentclientprotocol/codex-acp/blob/656765115f82253c79f87918abb77189c114a799/README.md)). It ignores `rawResponseItem/completed` ([CodexEventHandler.ts](https://github.com/agentclientprotocol/codex-acp/blob/656765115f82253c79f87918abb77189c114a799/src/CodexEventHandler.ts#L779)) and has no handling of code mode. An ACP client therefore gets each nested call as a tool call and nothing that groups them or shows the script. No issue or pull request about code mode was found in `codex-acp`, `claude-agent-acp` or the ACP repository.

### 3.5 OpenAI's API equivalents

- **Tool search**, 2026-03-05, with GPT-5.4: "lets models defer large tool surfaces until runtime" ([API changelog](https://developers.openai.com/api/docs/changelog)). A `tool_search` tool, `defer_loading: true` on functions, namespaces or MCP servers, run by OpenAI or by the client; loaded tools are added at the end of the context to keep the cache ([tool search](https://developers.openai.com/api/docs/guides/tools-tool-search.md)).
- **Programmatic Tool Calling**, 2026-07-09, with GPT-5.6, the day Codex's catalogue made those models `code_mode_only`. A hosted `programmatic_tool_calling` tool; each tool sets `allowed_callers` to `direct`, `programmatic` or both. The model's JavaScript runs in "a fresh, isolated V8 runtime" with no Node, network, file system or console, and emits output with `text(...)` or `image(...)`, the same shape as Codex's `exec`. The response carries a `program` item, a `function_call` for each nested call with a `caller` of type `program`, and a `program_output`. The client runs its own functions and returns each result with the `caller` copied ([programmatic tool calling](https://developers.openai.com/api/docs/guides/tools-programmatic-tool-calling.md)).
- **How the two combine.** "Tool search runs at the top level, not inside JavaScript", and "an already-running program cannot invoke tool search". Codex's own code mode differs here: its scripts read `ALL_TOOLS`.
- **Approvals.** An MCP tool's `require_approval` can pause a program. The guide's advice is not to use programmatic calling for "writes or approval-sensitive actions, by default".
- **Agents API.** Programmatic tool calling is "enabled by default and managed by the harness" there, per the same guide.

## 4. Measured claims

| Claim | Who | Basis |
| --- | --- | --- |
| Token use from 150,000 to 2,000, "98.7%" | Anthropic, [2025-11-04](https://www.anthropic.com/engineering/code-execution-with-mcp) | No method given; illustrative |
| Programmatic tool calling: average 43,588 to 27,297 tokens, 37%, "on complex research tasks"; internal knowledge retrieval 25.6% to 28.5%; GIA 46.5% to 51.2% | Anthropic, [2025-11-24](https://www.anthropic.com/engineering/advanced-tool-use) | Internal tests, not published |
| Tool search: about 77K to 8.7K tokens of definitions, 85%; MCP evaluation accuracy 49% to 74% (Opus 4) and 79.5% to 88.1% (Opus 4.5) | Anthropic, same post | Internal tests |
| "On a 75-tool project-management agent benchmark, enabling programmatic tool calling reduced billed input tokens by roughly 38 percent with no change in task accuracy" | Anthropic, [current documentation](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling) | Internal benchmark |
| Programmatic tool calling "can reduce the amount of intermediate tool output added to model context, but the effect depends on the task and tool responses" | OpenAI, [guide](https://developers.openai.com/api/docs/guides/tools-programmatic-tool-calling.md) | No figures; says to measure |
| Claude Code's Code Mode | Anthropic | No figures |
| Codex's code mode | OpenAI | No figures found |
| Telling GPT-5.6 to batch independent calls cut weighted usage by 27 to 45 percent; later revised to about 24 percent for the repeated runs once truncated output was counted | A user, [#35050](https://github.com/openai/codex/issues/35050), 2026-07-24, with a second user's 52-trial replication in the thread | Controlled runs on two repositories; small samples |

## 5. Limits, open issues and criticism

**Codex**

- **The model seldom batches.** [#32503](https://github.com/openai/codex/issues/32503) (2026-07-12, closed 2026-10-01 with no maintainer comment that was found): in a long thread, "only 5 of 739 GPT-5.6 `exec` cells" used `Promise.all`. One call per script costs a model request per call, as direct calls do, plus the wrapper.
- **Two truncations.** A nested tool's output limit and the `exec` budget of 10,000 tokens both apply, so a script that asks for 30,000 tokens from a command still gets 10,000 in total ([#33402](https://github.com/openai/codex/issues/33402), open since 2026-07-15). Batching makes it worse, as #35050's audit found.
- **Clients can't see what the model read** (3.4).
- **Rollout problems.** At launch, `codex exec` with `gpt-5.6-sol` reported no shell tool ([#31894](https://github.com/openai/codex/issues/31894)); on Windows the host exited during its handshake ([#41255](https://github.com/openai/codex/issues/41255)); a request over the 64 MiB frame limit fails before any JavaScript runs ([#60369](https://github.com/openai/codex/issues/60369)).
- **Auditing.** [#60352](https://github.com/openai/codex/issues/60352) asks for a fact saying whether every nested call returned before its cell closed, because cancellation "can retire a waiter while the core invocation remains outstanding".
- **Undocumented.** A default for most users rests on a flag the reference calls under development, and the only description of it is the tool description in the source.

**Claude Code**

- **One day old**, and the limits are the documentation's own (2.1 to 2.3): terminal only, no resume without it, no SDK, no background or remote sessions, hooks that fail closed, and an auto mode review that can't see values computed at run time.
- **No issues found.** A search of `anthropics/claude-code` for Code Mode and `REPL` returned nothing.

**Both model APIs** tell developers not to treat the caller marking as a control: Anthropic says `allowed_callers` is not a security boundary, and OpenAI says to keep application-level approval for high-impact actions whatever the caller.

## 6. Not verified

- **Nothing was run.** No Code Mode session in Claude Code, no Codex turn, no ACP thread. What an ACP client receives from `codex-acp` during a cell is inferred from the app-server's item types and the adapter's source.
- **Claude Code's internals.** The JavaScript engine, any isolation of the script, how MCP tools and deferred tools appear inside it, output limits, and what the saved transcript holds are not in the documentation. Whether Code Mode is being rolled out by account is inferred from one error string.
- **Whether Code Mode will reach the Agent SDK**, and when. No source says.
- **Codex's catalogue at run time.** Codex fetches model metadata from OpenAI's servers; the bundled `models.json` was read, not a live response. That 0.144.0 was the first release with the GPT-5.6 entries is from a commit comparison against the tag.
- **Approval of nested calls in Codex** was read from the dispatch path, a comment and a test's description, not traced through each tool handler. How the Codex TUI draws a cell was not read.
- **`codex-acp` against Codex 0.169.0.** It pins `^0.166.0`. Whether it passes Codex configuration such as `omit_tools_from` was not checked.
- **OpenAI's documentation** redirects from developers.openai.com to learn.chatgpt.com for Codex pages; the fetch followed it, and its summary of the configuration reference covered the first two thirds of the page. The programmatic tool calling guide states no release status; the date is from the API changelog.
- **Anthropic's and OpenAI's figures** are their own and unreproduced. Cloudflare's posts were read as search summaries only.
- **Goose, opencode, Cursor and the CodeAct paper** were not read.
- **GitHub issue counts and states** are the API's on 2026-11-13. "No maintainer reply" means none by an account GitHub marks as a member.

## 7. What this means for weave

Observations, not a plan. Weave is an ACP client: its Host runs Claude Code and Codex through their ACP adapters, gives each agent an MCP server of the Host's tools, and answers each permission request by a policy.

- **Codex threads in weave are probably already in code mode.** Any thread on a GPT-5.6 or GPT-6 model runs `code_mode_only` by the model's metadata, with no setting on weave's side. What the Host journals for such a turn is the nested calls, each as its own tool call, with no sign that a script made them.
- **The permission policy keeps its grain.** In both products a script's calls ask one by one, by the same rules as direct calls, so a policy that answers per tool call sees the same requests. The exception is Claude Code's auto mode, which reviews the script once; it doesn't apply to weave while Code Mode can't run under the Agent SDK.
- **The journal can differ from what the model read.** With Codex, a tool call's recorded output may be complete while the model received a truncated or filtered version, or none of it, since the script decides what to print. Nothing in ACP or in `codex-acp` carries the script or its result today.
- **Calls can arrive together.** A script that uses `Promise.all` makes several nested calls at once, so several tool calls, and several pending requests, can be open in one thread at the same moment.
- **Host MCP tools reach Codex as functions in a script**, named like `tools.mcp__<server>__<tool>`, described as TypeScript rendered from their input schema, and possibly deferred, in which case the model finds them only by filtering names and descriptions in `ALL_TOOLS`. A Host tool's name, description and schema are then all the model has to find it by.
- **Claude Code defers Host MCP tools too, by a different route.** Tool search is on by default under the Agent SDK, so a Host tool is behind `ToolSearch` unless its server is `alwaysLoad` or the tool sets `_meta['anthropic/alwaysLoad']`.
- **Claude Code's Code Mode is out of weave's reach for now**, in both directions: weave can't turn it on for an ACP thread, and a thread started in the terminal with Code Mode on can be resumed only there.
- **Neither vendor has put code mode into a client protocol.** The model APIs mark nested calls with a `caller`; the Codex app-server and ACP have no equivalent. Issue #60694 is the place to watch for the app-server, and there is no ACP proposal that was found.
