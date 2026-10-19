# Mastra and Pi Durable as a persistent agent runtime

Research snapshot, 2026-10-18. Mastra was read at `mastra-ai/mastra` main [`f5af51c5`](https://github.com/mastra-ai/mastra/tree/f5af51c52d5bffac6717643e7367ce99a9fe967d) (`@mastra/core` 1.79.0-alpha.3; the latest npm release is 1.78.0, published 2026-10-15). Pi was read at `earendil-works/pi` main [`482c1381`](https://github.com/earendil-works/pi/tree/482c1381a00d8d00bc81697e4a980c593db6803e) (all packages at 1.3.0 plus unreleased changes; tag `v1.3.0` is `71023aec`, published 2026-10-15). Tags `v1.0.0` through `v1.3.0` were fetched to compare. Nothing from either clone was installed or run. Sections 1–4 are facts and their sources; section 5 judges them against the weave Host at `cbb22e77`.

Pi Durable's `main` already contains unreleased breaking changes (durable sleeps, a crash-loop guard, host wake-ups, SQLite schema v2). Where a fact holds only on `main`, it says so.

## 1. Mastra

### 1.1 Identity, licence, cadence, and maturity

Mastra is developed by Kepler Software, Inc., which does business as Mastra ([enterprise licence preamble](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/ee/LICENSE)). The repository README carries a Y Combinator W25 badge ([README](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/README.md?plain=1#L1-L12)).

The licence is split. Everything outside directories named `ee/` is Apache 2.0. Code under `ee/` uses the "Mastra Enterprise Edition License", which is source-available, not open source, and allows production use only with a written agreement and a licence key ([LICENSE.md](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/LICENSE.md?plain=1#L1-L16), [ee/LICENSE §3](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/ee/LICENSE)). At the inspected commit the `ee/` directories are `packages/core/src/auth/ee` (licence checks and fine-grained authorization), `packages/core/src/agent-builder/ee`, `packages/editor/src/ee` (agent and workflow builders), and EE parts of the playground UI. The durable agent, workflow, storage, memory, ACP, MCP, and Mastra Code packages are Apache 2.0 (`license` fields in [core](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/packages/core/package.json) and [code-sdk](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/mastracode/sdk/package.json)). The EE licence says Enterprise Features are identified "by designation and not by name", and the designation can appear in the repository, the software, the documentation, or an order exhibit ([ee/LICENSE §2](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/ee/LICENSE)).

`@mastra/core` 1.0.0 was published on 2026-01-20. The last 0.x release was 0.24.9, on 2025-12-19. By 2026-10-15 there had been 91 stable 1.x releases, with 1.78.0 the latest. Minor releases come out roughly weekly (npm registry `time` metadata, queried 2026-10-18). The commercial products are the hosted "Mastra platform": Observability, Studio, and Server ([deployment overview](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/docs/deployment/overview.mdx?plain=1#L36-L44)). There is also a model gateway at `gateway-api.mastra.ai`, used when `MASTRA_GATEWAY_API_KEY` is set ([gateway source](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/packages/core/src/llm/model/gateways/mastra.ts#L39-L46)).

Size: the monorepo has 169 package manifests named `@mastra/*` or `mastracode`. `packages/core/src` alone holds about 331,000 lines of non-test TypeScript (counted from the clone). On the GitHub API, the repository showed 584 open issues and about 467 listed contributors on 2026-10-18. The first-party adopters it names are its own products: Mastra Code, and Mastra Factory, a "software factory" ([harness overview](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/docs/harness/overview.mdx?plain=1#L12-L14), [Agent Controller doc](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/docs/harness/agent-controller.mdx?plain=1#L11-L15)).

Maturity varies by feature. Core is 1.x. Durable agents ([doc](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/docs/harness/durable-agents.mdx?plain=1#L11-L17)) and workers ([doc](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/docs/deployment/workers.mdx?plain=1#L18-L22)) are marked beta: "Breaking changes may occur without a major version bump until the API is stable." Section 1.14 lists breaking changes that shipped in minor versions.

### 1.2 Core abstractions

- **Agent.** `new Agent({ id, instructions, model, tools, memory, agents, workspace, ... })`. The loop is `agent.stream()` / `agent.generate()`, which iterates model calls and tool calls until the model stops or a step limit or `stopWhen` condition is hit.
- **Tools.** Created with `createTool()` and typed schemas. A tool can require approval (`requireApproval`) or pause itself with `suspend()` ([HITL doc](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/docs/agents/human-in-the-loop.mdx?plain=1#L12)).
- **Memory.** Threads and resources, message history, working memory, semantic recall, and Observational Memory ([OM doc](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/docs/memory/observational-memory.mdx?plain=1#L14-L16)).
- **Workflows.** `createWorkflow()` / `createStep()`, composed with `.then`, `.branch`, `.parallel`, `.dowhile`, `.foreach`, `.sleep`, and `.sleepUntil`. A step can `suspend()` and later be resumed.
- **Subagents.** A parent agent's `agents` map, added in 1.8.0 ([subagents doc](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/docs/subagents.mdx?plain=1#L9-L13)).
- **Processors.** Input and output processors are the middleware layer ([processors doc](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/docs/agents/processors.mdx?plain=1#L10-L15)).
- **The Mastra instance.** `new Mastra({ agents, workflows, storage, pubsub, ... })` is the registry that supplies shared storage, logging, and observability. An agent imported directly "can still work with its own local configuration, but it won't have access to those shared services" ([agents overview](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/docs/agents/overview.mdx?plain=1#L76)).
- **Harness.** This is Mastra's name for a set of separately adoptable features for long-running work: durable agents, background tasks, goals, schedules, signals, signal providers, `AgentController`, and `createCodingAgent()` ([harness overview](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/docs/harness/overview.mdx?plain=1#L16-L29)).
- **AgentController and Session.** A shared host for interactive applications. Each Session owns its mode, model, state, event bus, run control, approvals, and thread binding ([Agent Controller doc](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/docs/harness/agent-controller.mdx?plain=1#L92-L100)). The class was named `Harness` until 1.47.0 ([changelog](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/packages/core/CHANGELOG.md?plain=1#L19486-L19492)).

### 1.3 Durability model

Mastra has three separate durability mechanisms: workflow snapshots, durable agents (which are built on workflows), and a few harness features that keep their own state. Each has different guarantees.

**Workflow snapshots.** A snapshot is the whole run state stored as one JSON document: step results, active paths, suspended paths, serialized step graph, request context, and result. It is keyed by `runId` in the `workflows` storage domain. Every write replaces the previous one, so this is snapshotting, not event sourcing. From the source, the default engine calls `persistStepUpdate` around step execution, and it builds and writes the full `WorkflowRunState` each time the persistence predicate allows ([`handlers/entry.ts`](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/packages/core/src/workflows/handlers/entry.ts#L169-L253)). Plain workflows persist every update by default (`shouldPersistSnapshot ?? (() => true)`, [`workflow.ts`](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/packages/core/src/workflows/workflow.ts#L1953)).

`suspend()` persists the snapshot. `run.resume({ step, resumeData })` loads it and continues, and this can happen in another process later ([snapshots doc](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/docs/workflows/snapshots.mdx?plain=1#L9-L33)). After a crash, the built server's boot handler calls `mastra.restartAllActiveWorkflowRuns()` and `mastra.recoverAllDurableAgents()` ([deployer handler](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/packages/deployer/src/server/handlers/restart-active-runs.ts#L6-L20)). The first one resumes "from the last active step". `recovery.workflows` defaults to `'auto'`, and a workflow can opt out with `autoRestartActiveRuns: false` ([workflows overview](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/docs/workflows/overview.mdx?plain=1#L497-L511), [Mastra class reference](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/reference/core/mastra-class.mdx?plain=1#L396-L410)). The workers doc lists as a known limitation that a crash during step execution "leaves the run in `running` status without an automatic retry" ([workers doc](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/docs/deployment/workers.mdx?plain=1#L410-L414)). Read together, recovery happens on the next boot of a server that runs the boot handler, not while the server keeps running. A custom server has to call these methods itself ([run-recovery design note](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/packages/core/src/agent/durable/run-recovery.md?plain=1#L13-L21)).

On the default engine, `.sleep()` and `.sleepUntil()` are in-process abortable timers, and `wrapDurableOperation` is a no-op that engines such as Inngest override ([`default.ts`](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/packages/core/src/workflows/default.ts#L141-L176)). From the source, a sleeping default-engine run does not survive a restart as a timer; it would be re-driven by the boot restart.

**Plain `Agent` tool approval and suspension.** These use snapshots. Storage must be configured, or resume fails with "snapshot not found". Agent snapshots are "minimal resume artifacts" and are deleted when the run finishes ([HITL doc](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/docs/agents/human-in-the-loop.mdx?plain=1#L60-L62)). `Agent.listSuspendedRuns()` finds runs waiting on approval or `suspend()`. Its reference says discovery "continues to work after a server restart and across multiple server instances" ([reference](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/reference/agents/listSuspendedRuns.mdx?plain=1#L12-L14)). A suspended approval can therefore wait for days and be answered from a new process with `approveToolCall({ runId, toolCallId })`. The docs describe crash recovery of an in-flight run only for durable agents.

**Durable agents** (`@mastra/core/agent/durable`, added in 1.45.0, beta). `createDurableAgent({ agent })` runs the agent loop inside a workflow. Chunks are published to PubSub, and a cache lets late subscribers catch up ([doc](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/docs/harness/durable-agents.mdx?plain=1#L19-L95)). There are three variants:

- `createDurableAgent()`: in-process.
- `createEventedAgent()`: starts the workflow without blocking the caller.
- `createInngestAgent()` (`@mastra/inngest`): runs on Inngest.

From the source, the loop is a `.dowhile` over an iteration workflow with these steps ([`durable-loop-builder.ts`](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/packages/core/src/agent/durable/workflows/durable-loop-builder.ts#L515-L634), [loop](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/packages/core/src/agent/durable/workflows/durable-loop-builder.ts#L997-L1000)):

1. Map state to model input.
2. One `llmExecutionStep` (one model call).
3. Extract tool calls.
4. `.foreach(toolCallStep)`: one step per tool call. Concurrency defaults to 10, and tool sets that can request approval or suspend run sequentially.
5. Collect results, map them back to state, check background tasks, and drain queued signals.
6. Update iteration state, check `isTaskComplete`, and evaluate goals.

So the unit of checkpointing is one model call and one tool call, not one token or one message.

What a plain `DurableAgent` persists depends on configuration ([doc](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/docs/harness/durable-agents.mdx?plain=1#L283-L319), [source policy](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/packages/core/src/agent/durable/durable-agent.ts#L2379-L2403)):

- `pending`, `paused`, and `suspended` snapshots are always written, because HITL resume depends on them.
- `running` checkpoints are written at every step only when `recovery.durableAgents: 'auto'` is set or a custom `shouldPersistSnapshot` includes `running`. The default is `'off'`.
- With recovery off, a `running` checkpoint is written only at step boundaries reached after `mastra.shutdown()` starts. "A run that crashes before then ... has no checkpoint" and cannot be recovered ([doc](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/docs/harness/durable-agents.mdx?plain=1#L364)).
- Evented agents always write the full set. Inngest agents write only `suspended`, because Inngest's step memoization provides durability ([doc](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/docs/harness/durable-agents.mdx?plain=1#L319)).
- When memory is a fixed `Memory` instance, `running` checkpoints store references to stored message rows instead of copying the transcript. This followed reports that every step re-saved the whole conversation (issues #20747 and #26600, both closed).

What a crash does, from the run-recovery design note in the source tree:

- Recovery restarts the workflow "from the last persisted snapshot. Every step after it runs again, including model calls and tool calls."
- Message and part ids come from the snapshot, so the redo upserts the same rows rather than appending new ones. "A real model can produce different content on the redo; the redo overwrites what the crashed execution flushed." ([run-recovery.md](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/packages/core/src/agent/durable/run-recovery.md?plain=1#L50-L56))
- Tools are at-least-once: "A tool that was running when the process died runs again on the redo ... Tools in durable agents should be idempotent. Declaring which tool calls are safe to replay is tracked in #25780." ([run-recovery.md](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/packages/core/src/agent/durable/run-recovery.md?plain=1#L98-L100)). Issue #25780, "Make interrupted tool recovery depend on an explicit replay-safety declaration", was open on 2026-10-18.
- A subagent delegation is one tool call. If recovery replays it, "the entire sub-agent run starts again and can repeat inner LLM calls and already-completed tool side effects" ([doc warning](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/docs/harness/durable-agents.mdx?plain=1#L291-L295)).
- Known gaps listed in the same note: "The evented engine re-runs a step that finished before the crash instead of continuing past it (COR-1354)". "Evented durable-agent recovery fails at some crash points" ([run-recovery.md](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/packages/core/src/agent/durable/run-recovery.md?plain=1#L108-L111)).
- Recovery is opt-in. `recovery.durableAgents: 'auto'` re-drives orphaned runs on boot, one at a time with a 30-second budget per run. `recover(runId, { force })`, `recoverActiveRuns()`, and `recoverAllDurableAgents()` do it manually ([doc](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/docs/harness/durable-agents.mdx?plain=1#L321-L372)).

Durable agents support tool approval. `stream(..., { requireToolApproval: true, onSuspended })` suspends the workflow, and `durableAgent.resume(runId, { approved: true })` continues it ([doc](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/docs/harness/durable-agents.mdx?plain=1#L264-L281)). Because `suspended` snapshots are always written, the suspension survives restarts. Function-valued `requireToolApproval` is not allowed for durable or stored agents, because options must be serialized ([HITL doc](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/docs/agents/human-in-the-loop.mdx?plain=1#L169)).

**Leases and fencing.** Every `stream()`, `generate()`, `resume()`, and `recover()` claims the run ([doc](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/docs/harness/durable-agents.mdx?plain=1#L374-L407), [leases design note](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/packages/core/src/agent/durable/leases.md?plain=1#L23-L71)). How strong the claim is depends on the store:

- If the workflows store supports run fencing, the claim is a row in `mastra_workflow_run_owners` with a generation number. Every write carries `(runId, generation, ownerId)`, and the adapter rejects stale writes atomically. The memory domain gets a matching fence.
- Fencing stores at this commit: in-memory, pg, libsql/turso, mysql, mssql, oracledb, spanner, dsql, Cloudflare D1, Cloudflare DO storage, Convex, MongoDB (replica set), DynamoDB, Redis, Upstash, and Valkey.
- Otherwise the claim is a PubSub lease. That gives mutual exclusion, but "writes from an execution that lost the run aren't rejected". `GoogleCloudPubSub` has no leases, so "every claim succeeds".
- The user doc says claims renew every 10 s and lapse 30 s after the last renewal ([doc](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/docs/harness/durable-agents.mdx?plain=1#L376)). The source default is a 15 s TTL with renewal every third of it ([`run-ownership.ts`](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/packages/core/src/agent/run-ownership.ts#L9)), and the design note gives "10–15s after the crash" ([run-recovery.md](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/packages/core/src/agent/durable/run-recovery.md?plain=1#L80-L84)).
- Other leases cover thread runs (one active run per memory thread), thread claims, evented step deduplication, and background tasks (`leaseDurationMs`, default 30 s, compared on the worker's clock) ([leases.md table](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/packages/core/src/agent/durable/leases.md?plain=1#L5-L13)).

**Inngest and Temporal.**

- `@mastra/inngest` maps each workflow to an Inngest function and each step to an Inngest step. Inngest memoizes step results and skips completed steps on retry ([Inngest guide](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/integrations/deploy/inngest.mdx?plain=1#L12-L20)). It also provides `createInngestAgent()`, where "each tool call becomes a memoized step" ([doc](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/docs/harness/durable-agents.mdx?plain=1#L147-L167)).
- `@mastra/temporal` (0.4.16 on npm) compiles each `createStep()` into a Temporal activity and each `createWorkflow()` into a Temporal workflow at worker bundle time. Workflow ids must be static string literals ([Temporal guide](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/integrations/deploy/temporal.mdx?plain=1#L8-L18), [constraints](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/integrations/deploy/temporal.mdx?plain=1#L227-L230)). No durable-agent factory was found in `workflows/temporal/src`.
- A Cloudflare Workflows executor for durable agents is an open request (#20953).

**What is not durable in Mastra**, as documented or as found in the source:

- In-flight plain `DurableAgent` runs with the default recovery setting (see above).
- The resumable-stream cache. It is in memory by default, so replay after a disconnect works within one process unless a Redis or Valkey cache is configured. If a cache write fails, the event is delivered live but cannot be replayed ([doc](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/docs/harness/durable-agents.mdx?plain=1#L199-L216)).
- AgentController live state: session state, permission grants, follow-up queue, event bus, and active stream ([Session reference](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/reference/agent-controller/session.mdx?plain=1#L928)).
- AgentController approval gates. The doc says "An approval gate lives in memory, so every approval answered after a restart is stale" ([doc](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/docs/harness/agent-controller.mdx?plain=1#L453-L468)). The source also has `Session.respondToPersistedToolApproval()`, which answers an approval stored with a suspended run after a restart by looking it up through `listSuspendedRuns` ([`session.ts`](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/packages/core/src/agent-controller/session.ts#L4757-L4791)). It is not in the reference docs. Open issue #27363 reports that `respond()` drops the gate before the resume lands.
- Background-task executors. These are "in process memory". After a restart, the caller of `resume()` must re-register them ([background tasks doc](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/docs/harness/background-tasks.mdx?plain=1#L304)). Task records themselves "survive process restarts" ([L27](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/docs/harness/background-tasks.mdx?plain=1#L27)).
- The in-process worker mode, which "doesn't survive process crashes" ([workers doc](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/docs/deployment/workers.mdx?plain=1#L91)).
- Mastra Code's own `/schedules`, which are not written to storage ([schedules doc](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/docs/harness/schedules.mdx?plain=1#L207)).

### 1.4 Storage

Storage is split into domains: `memory`, `workflows` (snapshots), `observability`, `scores`, `datasets`, `experiments`, `backgroundTasks`, `schedules`, and `threadState`. An adapter implements some or all of them. `MastraCompositeStore` routes different domains to different backends ([storage doc](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/docs/storage.mdx?plain=1#L41-L69)).

The docs recommend libSQL with a local file for development and PostgreSQL for production. They say to keep `file:./mastra.db` out of multi-process production ([storage doc](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/docs/storage.mdx?plain=1#L71-L111)). `stores/` in the repository has 32 adapter packages covering storage and vector backends, including pg, libsql, turso, mysql, mssql, mongodb, dynamodb, redis, upstash, valkey, cloudflare (KV and DO), cloudflare-d1, convex, spanner, dsql, clickhouse, and duckdb. Only six implement the schedules domain: libsql, pg, mysql, mongodb, convex, and spanner ([schedules reference](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/reference/schedules/overview.mdx?plain=1#L38)).

Schema changes are applied by the adapter's `init()`, which creates tables and adds missing columns (`ADD COLUMN IF NOT EXISTS`). `disableInit: true` lets deploys run `init()` separately ([pg config](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/stores/pg/src/shared/config.ts#L19-L38)). No versioned migration ledger was found. Messages are stored as JSON in "V2 format" ([storage reference](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/reference/storage/overview.mdx)).

### 1.5 Runtime targets

The docs list Node.js 22.13 or later, Bun, Deno, and Cloudflare ([deployment overview](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/docs/deployment/overview.mdx?plain=1#L14-L21)). `@mastra/core` declares `"node": ">=22.13.0"` ([package.json](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/packages/core/package.json#L1005-L1007)). The `mastra build` output is described as "a standalone Node.js server" that runs on Node.js, Bun, or Deno ([server deploy doc](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/docs/deployment/mastra-server.mdx?plain=1#L10)). The only Bun job found in CI is an "E2E monorepo" job pinned to Bun 1.2.15 ([e2e-tests.yml](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/.github/workflows/e2e-tests.yml#L169-L172)). No Bun runtime test suite was found.

For multiple processes, the docs list PubSub backends: in-process `EventEmitterPubSub` (the default), `UnixSocketPubSub` (one host), Redis Streams, Valkey Streams, and Google Cloud Pub/Sub. They also describe separate orchestration, scheduler, and background-task workers selected with `MASTRA_WORKERS` ([workers doc](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/docs/deployment/workers.mdx?plain=1#L36-L91)).

### 1.6 Triggers and scheduling

- **Schedules** (1.50.0). `mastra.schedules.create({ agentId | workflowId, cron, prompt, threadId? })` is persisted and "survive[s] restarts and redeploys" ([schedules doc](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/docs/harness/schedules.mdx?plain=1#L11-L19)). A threadless fire is an isolated `generate()`. A threaded fire sends a signal into the thread. Workflows can also declare a `schedule` field.
- The scheduler worker polls storage and must be a single instance: "Multiple schedulers polling the same storage would fire duplicate events" ([workers doc](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/docs/deployment/workers.mdx?plain=1#L66)).
- **Signals and signal providers** (1.39.0). These deliver external events into threads: a GitHub provider (`signals/github`), webhook and task signal providers, and notification inboxes ([signals doc](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/docs/harness/signals.mdx?plain=1#L11-L30)).
- **Channels.** Slack, Discord, Teams, and Telegram adapters have webhook routes per controller ([Agent Controller doc](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/docs/harness/agent-controller.mdx?plain=1#L380-L424)).
- **Queues.** These come through PubSub backends. The workers doc lists "No dead-letter queue" as a limitation ([workers doc](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/docs/deployment/workers.mdx?plain=1#L412)).
- Inngest workflows can also use Inngest cron and flow control.

### 1.7 Interactive features

- **Streaming.** `stream()` returns `MastraModelOutput`. `fullStream` yields typed chunks such as `text-start`, `text-delta`, `reasoning-delta`, `tool-call`, `tool-call-delta`, `tool-result`, `tool-call-approval`, `tool-call-suspended`, `step-finish`, `finish`, `abort`, and `background-task-*` ([ChunkType reference](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/reference/streaming/ChunkType.mdx)). Token usage is on the result ([MastraModelOutput reference](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/reference/streaming/agents/MastraModelOutput.mdx?plain=1#L186-L190)).
- **AgentController events.** The controller emits `message_start` / `message_update` / `message_end`, `tool_approval_required`, `tool_suspended`, and `display_state_changed`. The message events changed shape in a breaking way in 1.68.0 (see 1.14).
- **Cancellation.** `abortSignal` on calls. Durable agents add `abortRunStream(runId)` and `abortThreadStream()`, which work across processes over a shared PubSub. Before 1.62.0 these recorded the abort without stopping the run ([DurableAgent reference](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/reference/agents/durable-agent.mdx?plain=1#L379-L412)).
- **Steering and queueing.** There are two different mechanisms:
  - Signals: `agent.sendMessage()` delivers input "inside that agent loop" at the next loop boundary. Input that arrives while the model has produced only reasoning or metadata cancels that request and re-sends it with the new input. Providers may still bill the cancelled request. Running tools are not cancelled. This interruption does not apply on Inngest, or when the step runs in a different process ([signals doc](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/docs/harness/signals.mdx?plain=1#L58-L70)). `queueMessage()` waits for the run to finish.
  - AgentController: `session.steer()` "Abort[s] the active run, then send[s] content as a new message", and `followUp()` queues ([Session reference](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/reference/agent-controller/session.mdx?plain=1#L182-L216)).
  - Without a shared PubSub, a signal can reach an instance that is not running the agent, which then starts its own run "leaving ... the thread processed twice" ([signals doc](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/docs/harness/signals.mdx?plain=1#L446-L452)).
- **Tool approval.** See 1.3. For AgentController, `permissions.setForCategory` / `setForTool` take `allow`, `ask`, or `deny`, and `respondToToolApproval()` / `respondToToolSuspension()` answer them ([doc](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/docs/harness/agent-controller.mdx?plain=1#L277-L334)).
- **Multiple clients and replay.**
  - Durable agents: `observe(runId)` replays all cached events and then follows live. Observing does not own the run. `offset` is an inclusive PubSub event index and is not exposed on the public stream ([doc](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/docs/harness/durable-agents.mdx?plain=1#L169-L197)).
  - AgentController over HTTP (`@mastra/client-js`): "The server doesn't replay events missed while the stream was down". Clients re-read `session.state()` on reconnect ([doc](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/docs/harness/agent-controller.mdx?plain=1#L495-L526)).
  - `agent.subscribeToThread()` attaches to whatever run is active on a thread.
- **Branching.** Memory has `cloneThread` and `copyThread` ([reference list](https://github.com/mastra-ai/mastra/tree/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/reference/memory)). AgentController subagents can be `forked: true` to clone the parent thread. Workflows have time travel (re-run from a step).
- **Compaction.** "Mastra doesn't provide compaction out of the box, though you could implement it with a custom processor." The docs recommend Observational Memory, in which background Observer and Reflector agents keep an observation log that replaces raw history as it grows. `TokenLimiter` prunes to a budget ([context engineering guide](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/docs/guides/context-engineering.mdx?plain=1#L273-L296)). `Memory.summarizeThread()` produces a summary on demand without writing it back.
- **Token and cost accounting.** Usage comes back per stream. Observability metrics include input and output token counters. A built-in cost ledger per thread was not found.

### 1.8 Coding-agent readiness

- **Workspaces.** A `Workspace` combines a filesystem and a sandbox. Filesystem tools are `mastra_workspace_read_file`, `write_file`, `edit_file`, `list_files`, `delete`, `file_stat`, `mkdir`, and `grep`. Sandbox tools are `execute_command` (with background processes), `get_process_output`, and `kill_process` ([workspace reference](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/reference/workspace/workspace-class.mdx?plain=1#L734-L798)).
- **Sandbox providers** under `workspaces/`: Docker, E2B, E2B desktop, Daytona, Modal, Vercel, Cloudflare sandbox, Apple container, Railway, Blaxel, AgentCore, AgentFS, and others.
- **Skills.** Follow the Agent Skills `SKILL.md` format ([skills doc](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/docs/sandbox/skills.mdx)). `AGENTS.md` is handled in `agent-controller.ts`, the `tool-result-reminder` processor, and the Mastra Code prompts (from the source).
- **`createCodingAgent()`** (1.48.0) returns a plain `Agent` with a local workspace, a task signal provider, network-retry processors, and the goal-judge prompt. "The default workspace runs commands on the host machine with the permissions of your application process" ([reference](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/reference/coding-agent/create-coding-agent.mdx?plain=1#L10-L39)).
- **Mastra Code.** Mastra ships its own coding agent.
  - `mastracode` is the TUI; npm 0.47.1, `main` at 0.48.0-alpha.3.
  - `@mastra/code-sdk` is "the agent core behind Mastra Code ... everything except the terminal UI"; npm 1.14.0.
  - Both are built on `AgentController` in `@mastra/core` ([code-sdk README](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/mastracode/sdk/README.md?plain=1#L1-L25)).
  - Mastra Factory (`mastracode/factory*`) is a multi-task host on the same SDK.
- **Prompt caching.** Core exposes Anthropic `cacheControl` through `providerOptions` on tools and memory. Mastra Code's Claude Max provider places cache breakpoints itself (from the source, [`claude-max.ts`](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/mastracode/sdk/src/providers/claude-max.ts#L96-L122)). The OM docs describe keeping the prompt prefix stable for caching.

### 1.9 Model and provider layer

- **AI SDK.** Mastra vendors Vercel AI SDK versions 4 through 7 (`packages/_vendored/ai_v4` … `ai_v7`) and depends on `@ai-sdk/provider` specs v2–v4 ([core package.json](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/packages/core/package.json#L903-L935)). Any AI SDK `LanguageModel` can be passed in.
- **Model router.** Accepts `"provider/model"` strings. Its generated registry has 218 provider entries ([provider-registry.json](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/packages/core/src/llm/model/provider-registry.json)). Gateways cover the Mastra gateway, OpenRouter, Azure, and others.
- **Subscription OAuth.** `@mastra/core` does not ship login flows. The Mastra gateway has an OAuth path in which a caller-supplied `customFetch` owns authorization ([gateway source](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/packages/core/src/llm/model/gateways/mastra.ts#L101-L127)). The flows themselves are in `@mastra/code-sdk`:
  - Anthropic (Claude Pro/Max, a paste-code PKCE flow the source comments say was "inspired by pi-mono's OAuth implementation"; [source](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/mastracode/sdk/src/auth/providers/anthropic.ts#L1-L27)).
  - OpenAI ChatGPT Plus/Pro (Codex), GitHub Copilot (device code), Kimi For Coding, and xAI.
  - Several accounts per provider with rotation ([Mastra Code configuration](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/mastra-code/configuration.mdx?plain=1#L97-L133)).
- **Reasoning.** Arrives as `reasoning-*` chunks. Model fallback and switching models mid-thread (`session.model.switch`) are supported. Reasoning is not carried across providers in the same way as in pi-ai; Mastra's `MessageList` converts formats.

### 1.10 Protocol interop

- **ACP client.** `@mastra/acp` (npm 0.4.2) is a client for ACP agents. `AcpAgent` wraps an ACP agent process as a Mastra subagent, and `createACPTool()` exposes one as a tool. Claude Code works through `@agentclientprotocol/claude-agent-acp`; Cline, OpenCode, and Gemini CLI are listed as well ([ACP connection doc](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/docs/connections/acp.mdx?plain=1#L9-L45)).
  - By default `onPermissionRequest` selects the first option offered, or cancels if there is none ([reference](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/reference/acp/acp-agent.mdx?plain=1#L131-L138)).
  - Only `agent_message_chunk` updates become `text-delta` chunks, and `resumeStream()` is not supported ([reference](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/reference/acp/acp-agent.mdx?plain=1#L204-L218)).
  - File operations go through a Mastra `Workspace`, but the agent process "isn't sandboxed or isolated" ([doc](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/docs/connections/acp.mdx?plain=1#L37)).
  - Separate adapters wrap the Claude Agent SDK (`@mastra/claude`), the OpenAI Agents SDK (`@mastra/openai`), and the Cursor SDK (`@mastra/cursor`) ([agent-sdks](https://github.com/mastra-ai/mastra/tree/f5af51c52d5bffac6717643e7367ce99a9fe967d/agent-sdks)).
- **ACP server.** Only Mastra Code has one (`mastracode --acp` / `acpMain()` from `@mastra/code-sdk`). It supports ACP v1 initialize, new sessions, text prompts, tool updates, permissions, cancellation, configuration, and command discovery. It does not support session loading, and `ask_user` is disabled ([ACP server reference](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/reference/code-sdk/acp-server.mdx?plain=1#L127-L137), [README](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/mastracode/sdk/README.md?plain=1#L61-L107)). No generic ACP server for arbitrary Mastra agents was found. `@agentclientprotocol/sdk` appears only in `mastracode/*` and `agent-sdks/acp`. Mastra is not in the ACP registry (registry commit `3d4b5369`).
- **MCP.** `@mastra/mcp` provides `MCPClient` and also lets you author MCP servers that expose agents, tools, and workflows ([README](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/packages/mcp/README.md?plain=1#L1-L5)).
- **A2A.** Version 0.3.0, both serving and consuming ([doc](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/docs/connections/a2a.mdx?plain=1#L12)).
- **AG-UI.** Through `@ag-ui/mastra` for CopilotKit ([doc](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/integrations/agentic-ui/copilotkit.mdx?plain=1#L15)). There are also AI SDK UI and assistant-ui integrations.
- **Own wire protocol.** HTTP routes under the Mastra server, with `@mastra/client-js` as the client and `/agent-controller/...` routes for sessions.

### 1.11 Server and deployment footprint

`mastra build` produces a Hono server. `mastra dev` runs it with Studio, the dev UI. Server adapters mount Mastra routes on Express, Fastify, Hono, Koa, NestJS, Next.js, Elysia, or TanStack Start. They "don't run file-based discovery", so agents must be registered in code ([server adapters doc](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/docs/server/server-adapters.mdx?plain=1#L18-L22)). With an adapter, the host calls `mastra.startWorkers()` itself ([workers doc](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/docs/src/content/en/docs/deployment/workers.mdx?plain=1#L89)). Deployers exist for Vercel, Netlify, Cloudflare, Mastra cloud, and sandboxes. Auth providers are in `auth/*`.

As a library, `Agent` can be used without the server. Durable agents need registration on a `Mastra` instance with storage, or recovery fails with `DURABLE_AGENT_RECOVER_NO_MASTRA` / `NO_STORAGE` ([run-recovery.md](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/packages/core/src/agent/durable/run-recovery.md?plain=1#L7-L11)). `@mastra/core` lists `hono`, `hono-openapi`, `chat`, `posthog-node`, `@a2a-js/sdk`, and `execa` as runtime dependencies ([package.json](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/packages/core/package.json#L903-L935)).

**Telemetry is on by default.** `@mastra/core` sends PostHog events to `us.posthog.com` unless `MASTRA_TELEMETRY_DISABLED` is set ([`posthog.ts`](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/packages/core/src/telemetry/posthog.ts#L5-L25)). The built server starts model-token-usage reporting every 15 minutes and an instance-summary report ([deployer](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/packages/deployer/src/server/index.ts#L627), [L685](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/packages/deployer/src/server/index.ts#L685)).

### 1.12 Observability

Mastra has its own tracing (spans per agent, model, and tool) with exporters for OpenTelemetry (`observability/otel-exporter`, `otel-bridge`), Langfuse, LangSmith, Braintrust, Arize, Datadog, Sentry, PostHog, Laminar, and its own platform ([observability tree](https://github.com/mastra-ai/mastra/tree/f5af51c52d5bffac6717643e7367ce99a9fe967d/observability)). It also has evals and scorers (`@mastra/evals`, datasets, experiments) and Studio for local runs and traces.

### 1.13 Extensibility

- Input and output processors, including per-step hooks: `processInputStep`, `computeStateSignal`.
- `createTool()` and dynamic tools.
- Storage adapters per domain, with a shared test suite under `stores/_test-utils`.
- Gateways and custom providers.
- PubSub and lease providers (`LeaseProvider`).
- Custom execution engines: the default, evented, Inngest, and Temporal engines all subclass the engine and override sleep and `wrapDurableOperation`.
- Workspace filesystems and sandboxes.
- Signal providers and channel adapters.

### 1.14 Risks: churn, flags, bus factor, and open issues

- **Breaking changes in minors.** In 1.68.0 the AgentController stream event format changed ([changelog](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/packages/core/CHANGELOG.md?plain=1#L6459-L6471)). In 1.47.0 `Harness` was renamed to `AgentController` and the `/harness` server routes were removed ([changelog](https://github.com/mastra-ai/mastra/blob/f5af51c52d5bffac6717643e7367ce99a9fe967d/packages/core/CHANGELOG.md?plain=1#L19486-L19492)). Earlier entries marked "Harness is under active development" removed `Harness.subscribe()` and the thread methods. The `@mastra/core` changelog is 49,594 lines long.
- **Beta flags.** Durable agents, workers, and dynamic workflow definitions are beta. Cross-agent signals and schedule tools in Mastra Code are experimental toggles.
- **Durability bugs since the summer, all closed by 2026-10-18:**
  - #25891: `recoverActiveRuns()` cleaned up suspended runs.
  - #26433: a run finished by boot recovery could not be replayed with `observe()`.
  - #26600 and #20747: checkpoints rewrote the full conversation at every step.
  - #25248: a recovery crash in 1.71.0.
  - #22209: `EventedAgent` never deleted finished snapshots, so they were re-driven.
  - #22636: evented `recover()` crashed after a restart.
  - #21343: recovered runs were not re-announced on the thread topic.
- **Open on 2026-10-18:** #25780 (replay-safety declaration for tools), #27363 (AgentController approval gate race), #25775 (durable agents and step limits), #24426 (chat route reattach for durable agents), and #20953 (Cloudflare Workflows executor). The run-recovery note also lists the two evented-engine gaps quoted in 1.3.
- **Bus factor.** Commits to `packages/core/src/agent/durable` come mostly from `mastra-platform[bot]` (120), then `abhiaiyer91` (36), `rase-` (21), `taofeeq-deru` (20), `TylerBarnes` (18), and `NikAiyer` (17) (GitHub API, 2026-10-18).
- **Licence.** The EE terms apply only to designated features (1.1).

## 2. Pi Durable

### 2.1 Identity, licence, cadence, and maturity

Pi Durable is the npm package `@earendil-works/pi-durable`, in `packages/durable` of `earendil-works/pi`. The old `badlogic/pi-mono` repository URL redirects there (GitHub API). It is MIT licensed ([package.json](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/package.json#L1-L4), [L137](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/package.json#L137)). The package author is "Earendil Works".

Earendil describes itself as a public benefit company started by Armin Ronacher and Colin Daymond Hanna ([earendil.com/purpose](https://earendil.com/purpose/)). Its first-party hosted service for Pi is Radius, an AI gateway with analytics, sharing, and web search. It is "early alpha" and no pricing is shown ([radius.earendil.com](https://radius.earendil.com/)). That Earendil acquired Pi from Mario Zechner appears only in secondary coverage and is unverified here. The commit history shows Zechner (`badlogic`) as the main author.

Pi Durable was announced with Pi 1.0 on 2026-10-01 as "an experimental new package". It "does not replace the Pi coding agent" and is "a framework for building any agentic application, coding agents included" ([Pi Durable post](https://earendil.com/posts/pi-durable/), [Pi 1.0 post](https://earendil.com/posts/pi-1-0/)). The README opens with "**Experimental.** The API changes without notice between releases" ([README](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/README.md?plain=1#L3)).

All packages in the monorepo share one version number. npm shows `pi-durable` 0.0.1 on 2026-09-19, then 0.86.0 through 0.99.2, then 1.0.0 (2026-10-01), 1.0.1–1.0.4 (2026-10-03 to 10-05), 1.1.0 (10-07), 1.2.0 (10-12), and 1.3.0 (10-15). Versions 1.0.3, 1.0.4, 1.1.0, and 1.2.0 each have a "Breaking Changes" section, and so does `[Unreleased]` ([CHANGELOG](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/CHANGELOG.md?plain=1#L3-L175)). The 1.x number follows the coding agent's version and is not a stability claim for Durable.

Size: the post says the source "without tests, is about 15,000 lines". Counted from the clone, `packages/durable/src` at `main` has 25,564 physical lines of TypeScript including comments and blanks, and 123 test files. A 5,612-line normative spec sits at `docs/spec.md`.

Authorship of `packages/durable` on the GitHub API on 2026-10-18: `badlogic` (Mario Zechner) 125 commits, `mitsuhiko` (Armin Ronacher) 38, `christianklotz` 7, `davidbrai` 1.

Adopters: the post names Earendil's own upcoming Slack and GitHub triage bots. Pi 1.0 claims "hundreds of thousands" of weekly users of Pi itself; that is a vendor claim and is not about Durable.

### 2.2 Core abstractions

From the README concepts section and the spec ([README](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/README.md?plain=1#L80-L101), [spec §1](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/docs/spec.md?plain=1#L41-L78)):

- **Harness.** One open storage plus the machinery that runs agents on it. "All changes go through one line of atomic commits, and nothing is shown before its commit is stored."
- **Conversation.** A transcript of immutable **entries**: `pi.user`, `pi.assistant`, `pi.tool-result`, `pi.system`, `pi.reset`, `pi.compaction`, or your own kinds. Conversations can be forked at any entry.
- **Document.** Typed JSON state committed atomically with entries, stored as Chord deltas with periodic full bases. The built-in documents are `pi.agent`, `pi.provider`, `pi.live`, `pi.inbox`, and `pi.usage`.
- **Task.** A durable state machine (`defineTask({ name, version, initial, phases, abort, migrate })`) that checkpoints at every step. Every task has an owner: its conversation or another task.
- **Submission.** Input or a write handed to a conversation, which can be awaited.
- **Extension.** A named bundle of tools, prompt sections, hooks, wrappers, and tasks, installed in a process-local **registry**. Conversations store extension names, not code.
- **Agent.** The per-conversation selection of model, thinking level, extensions, tools, instructions, and `cwd`, stored in `pi.agent`.

There is no separate agent-loop API. The loop is built from built-in tasks. `pi.generation` makes one model request and owns the `pi.tool` tasks for that round's tool calls. It waits for them, then hands the run to the next generation ([README](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/README.md?plain=1#L94-L101), [spec §8.3](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/docs/spec.md?plain=1#L4129-L4301)).

"Pi Durable has no built-in subagents." A subagent is a tool that creates a conversation owned by its tool task ([post](https://earendil.com/posts/pi-durable/); [README example](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/README.md?plain=1#L624-L669)). There are no workflows as a separate concept. Custom tasks with child tasks, waits, and sleeps fill that role ([README](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/README.md?plain=1#L671-L696)).

### 2.3 Durability model

**What is persisted, and when.** Every state change is a Session commit. One commit is atomic across entries, task records, submissions, and document deltas. "All visible progress is durable. There is no volatile publication path." External effects run outside the commit ([spec invariants](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/docs/spec.md?plain=1#L63-L78)).

- **Model request.** A `prepare` commit appends any system-prompt deltas and pins model, thinking level, stream options, and the context `cutoff` into a `request` checkpoint.
- **Streaming.** Partials are committed into `pi.live` at most every 100 ms by default (`settings.progress`), so "a crash loses at most that window" ([README](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/README.md?plain=1#L490)).
- **Final message.** Classified in one commit that also starts the tool round.
- **Tool call.** One commit records intent (`{ phase: "execute", arguments, replay }`) before `execute()` runs. Running output is committed on the same 100 ms throttle, and the result commit appends `pi.tool-result` ([spec §8.4](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/docs/spec.md?plain=1#L4303-L4361)).

This is event-sourced-like for transcripts, which are append-only immutable entries, and delta-plus-base for documents. Task records are full replacements of the checkpoint ([spec §5.1](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/docs/spec.md?plain=1#L1922-L1938)).

**Crash mid-LLM-stream.** On reopen, surviving `running` tasks become `pending`. The `request` phase first turns any committed partial into an aborted `pi.assistant` entry. It then "resends the same committed messages with the same pinned model, thinking level, and stream options, and reruns `beforeRequest`" ([spec §8.3](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/docs/spec.md?plain=1#L4216-L4229), [source](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/src/harness/generation.ts#L208-L231), [`convertPartial`](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/src/harness/generation.ts#L423-L431)). Model calls are therefore at-least-once, and the partial stays in the transcript marked aborted.

**Crash mid-tool.** Tools default to `replay: "unsafe"` ([spec](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/docs/spec.md?plain=1#L3146)). On recovery the `execute` phase reruns the tool only if both the stored and the current declaration are `safe`. Otherwise it commits an `interrupted` error result with the output committed so far ("Tool X was interrupted and may have partially run"), and the model decides what to do ([source](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/src/harness/tool.ts#L178-L196), [README](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/README.md?plain=1#L265)). So an unsafe tool runs at most once and a safe tool runs at least once.

Nested tool calls (`api.executeTool()`) are keyed so that a replay-safe caller reattaches to calls it already made. The spec states plainly: "This is not exactly-once execution ... a replay-safe tool with external effects still needs its own idempotency" ([spec §7.3](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/docs/spec.md?plain=1#L3195-L3203)). The general pattern is intent, effect, outcome: "Reopening in an intent phase means the effect may have happened. The phase handler retries safely, polls an external handle, or records interruption" ([spec §5.2](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/docs/spec.md?plain=1#L2035-L2051)).

**Between steps.** A crash between commits loses nothing that was committed. Phases rerun from their top ([spec §5.6](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/docs/spec.md?plain=1#L2412-L2431)).

**Exactly-once submission.** A submission with a `requestId` is deduplicated per conversation, so "a client that retries after a crash gets the original submission back" ([README](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/README.md?plain=1#L117-L126), [spec §6](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/docs/spec.md?plain=1#L2549-L2552)). The deduplication covers admission only, not effects.

**Hooks and approval.**

- Hooks run off the commit line and "a crash before the consuming commit may rerun them". Hooks use task memos, small first-writer-wins values, for durable decisions ([spec §7.2](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/docs/spec.md?plain=1#L2896-L2918)).
- The post's approval example awaits `askInSlack(call)` inside a `beforeTool` hook and stores the answer in a memo. After a restart, "the hook finds the stored answer instead of asking again" ([post](https://earendil.com/posts/pi-durable/)). The wait itself holds the tool task's invocation in memory. If the process dies before the answer is stored, the hook asks again.
- No primitive persists a pending tool call so that a run can stop with nothing held in memory and resume days later from an external approval or a client-side tool result. The issue requesting this, #10852 "Pi Durable support for client-side tool execution and tool approval", was open with no maintainer reply on 2026-10-18.
- The spec says never to await "humans" inside a commit callback ([spec §12](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/docs/spec.md?plain=1#L5514-L5516)).
- A custom task can wait durably on other tasks (`waiting`) or on time (`sleeping`), but not on an external signal.

**Sleep and timers.** On `main` but unreleased, a task ends its phase with `runtime.sleepUntil(until, checkpoint)`. The sleep is stored, holds no invocation, survives restarts, and resumes when the Harness clock reaches `until`. Retry backoffs and deferred-provider polls use the same mechanism ([README](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/README.md?plain=1#L128-L152), [spec §5.6](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/docs/spec.md?plain=1#L2399-L2474)). `HarnessOptions.onWake` lets an evictable host such as a Cloudflare Durable Object arm its own alarm and call `resume()` ([README](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/README.md?plain=1#L154-L200)). In released 1.3.0, `TaskRuntime.sleep()` waited inside a phase, so it "holds an invocation and, after a restart, reruns the phase and restarts the wait" ([CHANGELOG Unreleased](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/CHANGELOG.md?plain=1#L5-L11)). Issues #10325 and #10857, which concern host-driven wake-ups, were still open.

**Crash loops.** On `main` but unreleased, open counts each `running` task that a crash cut off. After `settings.restartLimit` consecutive crashes without progress (default 5), the task is parked until `retryTask(id)` ([README](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/README.md?plain=1#L202-L210), [spec §5.4](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/docs/spec.md?plain=1#L2184-L2204), [source](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/src/harness/scheduler.ts#L359-L386)). Released 1.3.0 resumes such tasks indefinitely.

**Leases and locking.** None across processes: "One process owns a storage at a time; there is no cross-process locking" ([README](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/README.md?plain=1#L772)). Inside one process, the Session's single mutation line serializes all commits ([spec §4](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/docs/spec.md?plain=1#L1692-L1729)). The v1.0.0 demo coding agent added its own file lock, which went stale 10 s after a crash ([v1.0.0 README](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/src/experimental/durable/README.md?plain=1#L12-L16)).

**Close and storage errors.** `close()` writes stopped tasks back as `pending` without counting a restart. A storage error is fatal: the Harness closes itself, and the host reopens and resubmits with the same `requestId` ([README](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/README.md?plain=1#L801-L817), [spec §10.1](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/docs/spec.md?plain=1#L5276-L5341)).

**What is not durable:**

- Watches. "A client that joins late or reconnects starts from the current view; nothing is replayed." A slow watch keeps 100 frames and then collapses them into one snapshot ([README](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/README.md?plain=1#L488)).
- Up to one progress window (100 ms) of streamed partials and tool output.
- Work in a phase before its next commit, which reruns.
- The registry. Code is reinstalled by the new process, and tasks whose definitions are missing stay blocked until it is.
- The provider-side state of a cut-off request.
- In-memory waits, such as a hook awaiting a human.
- JSONL without `fsync`, which survives process crashes but not power loss ([README](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/README.md?plain=1#L748-L753)).

### 2.4 Storage

There are four backends ([README](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/README.md?plain=1#L746-L799)):

- **Memory.** Nothing is persisted. It is the reference semantics.
- **SQLite** via Node's `node:sqlite`. One file, WAL with `synchronous = NORMAL`, so the newest commit "may be lost on power or host failure". Recommended for long-running agents. Only the working set is kept in memory.
- **JSONL.** An append-only directory with a commit-marker protocol and optional `fsync`. It keeps the whole history in memory.
- **Cloudflare Durable Object SQLite.**

The `Storage` interface is about 15 methods: `commit(writes)`, `mintId`, keyed lookups, and cursor scans ([spec §10](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/docs/spec.md?plain=1#L5077-L5204)). A conformance suite (`registerStorageConformance`) and benchmarks are exported for custom backends. The post suggests Postgres or a key-value store as targets ([post](https://earendil.com/posts/pi-durable/)). No Postgres adapter ships.

SQLite migrations run automatically on open. Schema v2 (unreleased) rebuilds the task table, and "A migrated database cannot be opened by 1.3.0 or earlier" ([CHANGELOG](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/CHANGELOG.md?plain=1#L9), [spec §11.2](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/docs/spec.md?plain=1#L5383-L5400)). The store is append-only, and no API deletes a conversation. A request for one, #11026, was open.

### 2.5 Runtime targets

`engines` is `"node": ">=22.19.0"` ([package.json](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/package.json#L143-L145)). The test suite runs on Node and also inside Cloudflare Workers (`test-workers`, `@cloudflare/vitest-plugin`). The README says the portable SQLite and JSONL cores "run without Node APIs, for example on Bun or in Cloudflare Durable Objects, given an asynchronous `SqliteDatabase` facade" ([README](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/README.md?plain=1#L772)). The shipped Node adapter imports `node:sqlite` (`@earendil-works/chord/sqlite/node`). Bun's current Node-compatibility page marks `node:sqlite` as fully implemented ([bun.com docs](https://bun.com/docs/runtime/nodejs-compat)). Whether Bun 1.3.14 had it, and whether Durable passes on Bun, was not verified. No Bun CI job exists for Durable. Pi's CLI binaries are built with `bun build --compile` on Bun 1.3.14 ([build-binaries.yml](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/.github/workflows/build-binaries.yml#L41-L44)), which shows that the coding agent runs under Bun, not Durable.

The runtime is single-process per storage. Tools can run elsewhere through an `ExecutionEnv`. `@earendil-works/pi-env` deploys a small Rust daemon over SSH and exposes `RemoteExecutionEnv` and `openTerminal()` with a PTY ([pi-env README](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/env/README.md?plain=1#L1-L10)).

### 2.6 Triggers and scheduling

There is no cron, webhook, or queue integration. The host calls `submit()`. Building blocks are durable task sleeps (unreleased on `main`), background tasks (`background: true`) that outlive the turn, and `onWake` for evictable hosts. The post gives "a reminder that fires tomorrow" as a use of a background task ([post](https://earendil.com/posts/pi-durable/)).

### 2.7 Interactive features

- **Event model.** Two exist. Structural: `viewState()` / `watch()` deliver the conversation view and then the exact Chord operations of each commit. Agent events: `watchEvents()` is marked experimental and produces `message_start`/`message_update` (text, thinking, and tool-call-argument deltas), `tool_execution_*`, `run_*`, `turn_*`, `inbox_update`, `usage_changed`, `auto_retry_*`, and `compaction_*`, derived from commits. It covers one conversation, not its subtree, and its "protocol may change without notice" ([spec §9.4](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/docs/spec.md?plain=1#L4815-L4978)).
- **Abort.** `conversation.abort()` withdraws queued inputs and aborts the current work bottom-up. Each task's abort handler cleans up its own effects. `{ background: true }` also reaches background work ([README](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/README.md?plain=1#L624-L664)). Cancelling a caller's `Context` cancels only the wait.
- **Steering and queueing.** `submit({ whenBusy: "steer" })` places input after the current tool round. `"followUp"` (the default) starts the next run. `"reject"` throws. Writes append without asking the model. `steeringMode` / `followUpMode` choose one-at-a-time or all ([README](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/README.md?plain=1#L492-L509)). The queue is the durable `pi.inbox` document.
- **Tool approval.** Hooks only (see 2.3): `beforeTool` returns `{ block }` or rewritten arguments.
- **Multiple clients.** Any number of in-process subscribers can attach. A late joiner gets the current view, including the in-flight partial, running tools, and the inbox, and then deltas. Remote clients are left to the host: "thread.watch() delivers the exact operations of every commit, small enough to send over a socket" ([post](https://earendil.com/posts/pi-durable/)). `@earendil-works/chord` provides replicated state over memory, IPC, or WebSocket links ([Chord README](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/chord/README.md?plain=1#L1-L11)), but Durable does not use those links (from the source). Watch events reach only listeners in the owning process (#10749, closed without change). There is no replay from a cursor.
- **Branching.** `conversation.fork(entryId)` sees the parent's entries up to that point without copying, gets a fresh provider session id, and starts its documents from `initial`, `current`, or `asOf` ([README](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/README.md?plain=1#L615-L622), [L714-L736](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/README.md?plain=1#L714-L736)). `reset(handoff)` starts a new context and keeps older entries searchable.
- **Compaction.** Built in, and runs as a task while the conversation keeps working.
  - Background compaction starts `backgroundTokens` below the blocking threshold.
  - Generation blocks only above `contextWindow − reserveTokens`.
  - On a context-overflow error it compacts and retries once.
  - Manual `compact(instructions)` is available, and `beforeCompact` can decline or supply a summary.
  - Thresholds can be overridden per model. Older entries stay in storage ([README](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/README.md?plain=1#L538-L576)).
- **Usage and cost.** `pi.usage` records token and cost totals per `provider/model` and per tool, including failed and aborted attempts. `harness.usage()` sums them over the Session ([README](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/README.md?plain=1#L738-L744)).

### 2.8 Coding-agent readiness, and how Durable relates to the Pi packages

- **Built-in tools.** `@earendil-works/pi-durable/tools` provides `read`, `write`, `edit`, `bash`, and `powershell`, plus the `CodingTools` extension. The tools act only through the call's `ExecutionEnv`, which is `NodeExecutionEnv`, pi-env's remote and local environments, or your own. Per-conversation environments, for example one container each, come from the `env` callback ([README](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/README.md?plain=1#L233-L265), [L415-L448](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/README.md?plain=1#L415-L448)). Codemode (a QuickJS sandbox whose scripts call tools as nested calls and survive restarts by deterministic replay) and BM25 `tool_search` are ported from the coding agent ([README](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/README.md?plain=1#L337-L356)). No Docker, E2B, or Daytona adapters ship.
- **Skills and AGENTS.md.** Not shipped. The spec and post show `ContextFiles`/`Skills` sections as code the host writes ([spec](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/docs/spec.md?plain=1#L2777-L2806)).
- **Prompt caching.** Prompt sections and tool changes are stored as positional system entries, and only changes are re-sent, which "keeps provider prompt caches warm". Each conversation persists a UUIDv7 that is forwarded to pi-ai as `sessionId` for cache and session affinity ([README](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/README.md?plain=1#L358-L366), [L115](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/README.md?plain=1#L115)).
- **Package relationships.** From the source, Durable imports only `@earendil-works/chord`, `@earendil-works/pi-ai`, and `@earendil-works/pi-codemode` ([package.json](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/package.json#L146-L153)). It does not use `pi-agent-core`'s `Agent` loop or `pi-coding-agent`'s tools or sessions. It has its own generation and tool tasks and its own tool implementations.
  - The experimental harness in `pi-agent-core` was removed in 1.0.0 with the note "Use `@earendil-works/pi-durable` for durable sessions" ([agent CHANGELOG](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/agent/CHANGELOG.md?plain=1#L31)).
  - The coding agent does not depend on Durable ([package.json](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/coding-agent/package.json#L43-L49)).
  - A normal interactive `pi` session is a JSONL session tree under `~/.pi/agent/sessions` ([sessions doc](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/coding-agent/docs/sessions.md?plain=1#L1-L50)). No converter to Durable storage was found.
  - Coding-agent extensions cannot run under `Harness`. That gap was the subject of open issue #10386.
  - The post says lessons "will flow back into Pi the coding agent" ([post](https://earendil.com/posts/pi-durable/)).
- **Demo agents.** The post links a small coding agent and a vacation planner built on Durable, both at tag `v1.0.0` ([v1.0.0 tree](https://github.com/earendil-works/pi/tree/v1.0.0/packages/coding-agent/src/experimental/durable)). They were removed in 1.2.0 together with "the unreleased experimental server, client, and plugin stack" and the unreleased `pi-client`, `pi-protocol`, and `pi-server` packages ([coding-agent CHANGELOG](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/coding-agent/CHANGELOG.md?plain=1#L128)).
- **Subagents.** A tool pattern (2.2). The examples include foreground and persistent background subagents with spawn, steer, and stop, which survive restarts (`test/examples/22-*`, `23-*`). The maintainer suggests using a separate in-memory Harness for subagents that should not be durable (#11045, maintainer comment).

### 2.9 Model and provider layer

Pi Durable uses `@earendil-works/pi-ai`, Pi's own provider layer; it does not use the AI SDK.

- **Coverage.** 34 named providers plus any OpenAI-compatible endpoint ([pi-ai README](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/ai/README.md?plain=1#L60-L97)).
- **Subscription OAuth.** Built into pi-ai: Anthropic (Claude Pro/Max), OpenAI "Sign in with ChatGPT", OpenAI Codex (legacy), GitHub Copilot, and OpenRouter ([README](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/ai/README.md?plain=1#L1710-L1720)). Refresh runs under a credential-store lock "so concurrent requests and processes cannot double-refresh". "OAuth login flows are Node-only" ([L1633](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/ai/README.md?plain=1#L1633)).
- **Reasoning.** Thinking levels run `off` through `max`.
- **Cross-provider handoff.** Supported mid-conversation. Thinking blocks are dropped when the model changes ([README](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/ai/README.md?plain=1#L1499-L1539)).
- **Use in Durable.** Durable takes a `Models` object or a function returning one, so credentials and the catalogue can change at runtime ([spec](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/docs/spec.md?plain=1#L361-L399)). `configure({ model })` applies from the next request.

### 2.10 Protocol interop

Durable exposes no ACP, MCP, A2A, AG-UI, or HTTP interface.

- **ACP.** Asked about an ACP adapter for Durable, the maintainer answered "no, that is something you can build yourself on top of it" (#10389, `badlogic`, 2026-10-08).
- **MCP.** Durable has no MCP client. A proposed `pi-durable/mcp` extension (#10837) was auto-closed. `pi-mcp` is a standalone client-only package that the coding agent uses ([pi-mcp README](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/mcp/README.md?plain=1#L1-L5)). The plumbing for one exists in Durable: nested calls, `callers`, deferred tools, and codemode namespaces.
- **Remote attachment.** The host ships `watch()` ops or `watchEvents()` batches over its own transport (2.7).

### 2.11 Server and deployment footprint

Durable is a library with no HTTP server, UI, auth, CLI, or telemetry. The host supplies storage, the registry, `models`, `settings`, `env`, and, optionally, clocks and timers (`now`, `setTimer`, `onWake`) ([spec HarnessOptions](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/docs/spec.md?plain=1#L361-L399)). Settings are read live through getters and are never stored. Importing the package root loads TypeBox, which costs "about 23 MB of peak RSS unbundled" ([README](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/README.md?plain=1#L799)).

### 2.12 Observability

- `onReport(error, info)` reports `session_failed`, `task_faulted`, `task_parked`, `extension_error`, `host_error`, and others ([spec §10.1](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/docs/spec.md?plain=1#L5343-L5371)).
- `inspect()` shows live tasks and blocked reasons.
- `taskGraph()` / `watchTaskGraph()` provide a live tree of tasks ([README](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/README.md?plain=1#L698-L712)).
- Task records carry `startedAt` / `endedAt`, and tool results carry `durationMs`.
- No OpenTelemetry and no dev UI. `@earendil-works/pi-telemetry` (callback contracts, no exporter) is not a Durable dependency. `pi-evals` exists in the monorepo for the coding agent.

### 2.13 Extensibility

- Extensions: tools, prompt sections, hooks (`beforeRequest`, `afterResponse`, `onYield`, `afterTools`, `beforeTool`, `afterTool`, `beforeCompact`), wrappers (`wrapTool`), and custom tasks ([README](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/README.md?plain=1#L594-L613)).
- Typed documents.
- Custom `Storage` and `ExecutionEnv`, with conformance suites.
- Hot reload: installing an extension under an existing name replaces it; running work finishes on the old code; new phases use the new code ([README](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/README.md?plain=1#L450-L460)).
- A conversation's entry kinds and document kinds are part of its persisted protocol ([spec §12](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/docs/spec.md?plain=1#L5533-L5538)).

### 2.14 Risks: churn, flags, bus factor, and open issues

- **Churn.** Breaking changes appeared in 1.0.3, 1.0.4, 1.1.0, 1.2.0, and `[Unreleased]` within 15 days. Examples: `ToolExecutionResult.content` was renamed `output`; any storage error now fails the Session; `TaskRuntime.sleep()` was removed; SQLite schema v2 cannot be rolled back ([CHANGELOG](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/CHANGELOG.md?plain=1#L3-L66)).
- **Experimental surfaces.** The whole package is marked experimental, and `watchEvents()` is experimental within it.
- **Bus factor.** About three-quarters of Durable commits are by one author (2.1). Issues from new contributors are auto-closed and reopened at the maintainers' discretion. #10389, #10837, #10852, and #10749 show this.
- **Closed durability bugs:** wait cycles deadlocked (#10411); the system baseline was misplaced after compaction (#10904); a 3 MiB image read exhausted a 128 MB Durable Object (#10923).
- **Open on 2026-10-18:** #10852 (durable HITL and client-side tools), #10857 and #10325 (sleep wake-ups on Durable Objects), #11026 (deleting a conversation), #10535 (retry delays as task state), #10386 (hosting coding-agent extensions), and #11043 (running in a browser worker).
- **Non-goals in the spec:** CRDT or offline multi-writer merge, a semantic event journal, and "forced termination of non-cooperative extension code inside one process" ([spec §13](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/durable/docs/spec.md?plain=1#L5598-L5612)).
- **Licence.** MIT, no constraints.

### 2.15 Pi 1.0 itself

Pi 1.0 (2026-10-01) is the stable release of the coding agent ([post](https://earendil.com/posts/pi-1-0/), [CHANGELOG 1.0.0](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/coding-agent/CHANGELOG.md?plain=1#L287-L331)). The 1.0 post lists:

- Codemode with native MCP support.
- Non-LLM models.
- Virtual models through extensions.
- Deferred tool loading.
- Anthropic cache warming.
- Mid-conversation system messages.
- Fullscreen TUI by default.

MCP and codemode actually landed in 0.99.0 on 2026-09-29, alongside "Sign in with ChatGPT" ([CHANGELOG 0.99.0](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/coding-agent/CHANGELOG.md?plain=1#L391-L397)). MCP servers connect over stdio or streamable HTTP ([MCP doc](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/coding-agent/docs/mcp.md?plain=1#L1-L3)).

The coding agent can be driven three ways:

- RPC mode: `pi --mode rpc`, JSONL commands, responses, and events on stdio, with a typed `RpcClient` ([RPC doc](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/coding-agent/docs/rpc.md?plain=1#L1-L10)).
- An in-process SDK, `createAgentSession()` for Node or Bun ([SDK doc](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/coding-agent/docs/sdk.md?plain=1#L1-L20)).
- JSON and print modes.

Sessions are JSONL entry trees with `/tree`, `/fork`, `/clone`, and compaction ([sessions doc](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/coding-agent/docs/sessions.md?plain=1#L1-L50)). They are not crash-resumable mid-turn. The Durable post describes the coding agent's model as "If the process dies, you look at what happened and tell it to continue" ([post](https://earendil.com/posts/pi-durable/)).

### 2.16 ACP adapters for Pi

No official ACP adapter exists; nothing in `earendil-works/pi` mentions ACP. The community adapter `svkozak/pi-acp` is MIT, at v0.0.34 (npm 2026-09-24, last push 2026-10-06), and is listed in the ACP registry as `pi-acp` ([registry entry](https://github.com/agentclientprotocol/registry/blob/3d4b536978c55c5810d9fc0b8e23ef74180eba70/pi-acp/agent.json), [README](https://github.com/svkozak/pi-acp/blob/04d0a15d6bb42bb65cce5c9caedcdcb2cdcb6905/README.md)).

How it works: it speaks ACP JSON-RPC on stdio, spawns `pi --mode rpc`, and requires pi 0.81.0 or later. It maps streaming to `agent_message_chunk` and tools to `tool_call` / `tool_call_update` with structured diffs for `edit`, and it supports `session/load` through a session map.

Its documented limitations: no ACP `fs/*` or `terminal/*` delegation; MCP servers passed through ACP are not wired to pi; no separate thought stream; the queue is implemented client-side. It wraps the interactive coding agent, not Durable. Other forks and alternatives (`victor-software-house/pi-acp`, which uses the SDK in-process, and `pi-acpinator` in Rust) were found only through search results and were not inspected.

## 3. Side-by-side

| Dimension | Mastra (core 1.78.0 / main 1.79.0-alpha.3) | Pi Durable (1.3.0 / main 482c1381) |
| --- | --- | --- |
| Owner, licence | Kepler Software, Inc. (Mastra, YC W25); Apache 2.0 outside `ee/`; `ee/` source-available, production use needs a licence key | Earendil Works (PBC); MIT |
| Maturity claim | Core 1.x since 2026-01-20, about weekly minors; durable agents and workers marked beta | "Experimental. The API changes without notice"; lockstep 1.x version; 8 releases in 15 days |
| Size | About 331k lines of non-test TS in `packages/core/src`; 169 packages | About 15k lines (Earendil's figure) / 25.6k physical lines in `src` |
| Agent loop | `Agent.stream()`/`generate()`; durable loop = workflow `.dowhile` of LLM step + `.foreach` tool steps | Built-in tasks `pi.generation` → `pi.tool` × n → next generation |
| Persistence model | Full-state workflow snapshots (replace per write) + memory rows | Atomic commits of immutable entries, task records, and document deltas |
| Checkpoint granularity | Per workflow step: one LLM call, one tool call; in-flight checkpoints only with `recovery.durableAgents: 'auto'` | Per task phase; partials and tool output every 100 ms; tool intent before execution |
| Crash mid-LLM | Step re-runs from last snapshot; model re-called | Partial kept as aborted entry; same request re-sent |
| Crash mid-tool | Tool re-runs (at-least-once); replay-safety flag requested (#25780 open) | Re-runs only if `replay: "safe"`; else `interrupted` result |
| Idempotency aids | Message ids reused on redo; storage fencing of stale writes | `requestId` exactly-once admission; nested-call keys; memos |
| HITL across restarts | Yes: suspended snapshots persist; `listSuspendedRuns`, `approveToolCall`, `resume` | No durable pending-approval primitive; hook waits in memory (#10852 open) |
| Durable sleep/timers | Workflow `.sleep` is in-process on the default engine; Inngest overrides | Stored sleeps on `main` only (unreleased); `onWake` for evictable hosts |
| Multi-process ownership | Run claims with generation fencing (most stores) or PubSub lease; 15 s TTL in source | None: one process per storage, no cross-process locking |
| Storage | 32 storage/vector adapter packages; pg recommended for production; libSQL for development; composite routing | Memory, SQLite (`node:sqlite`), JSONL, Cloudflare DO SQLite; conformance suite |
| Migrations | Adapter `init()` creates and adds columns; `disableInit` for CI | Automatic on open; schema v2 not readable by ≤1.3.0 |
| Runtimes | Node ≥22.13; docs list Bun, Deno, Cloudflare | Node ≥22.19; Cloudflare Workers tested; Bun claimed via facade, untested |
| Scheduling/triggers | Persisted cron schedules (single scheduler instance), signals, signal providers, channels, PubSub workers, Inngest cron | None built in; host submits; background tasks and sleeps as primitives |
| Streaming format | Typed chunks (`text-delta`, `tool-call`, …); AgentController `message_*` events | Chord ops per commit, or experimental agent events (`message_update` deltas, `tool_execution_*`) |
| Steering | Signals inject at loop boundary and cancel reasoning-only requests; AgentController `steer()` aborts then resends | `whenBusy: "steer"` after the tool round; follow-ups; durable inbox |
| Multi-client and replay | Durable agents: `observe(runId)` replays cache (in-memory by default, Redis for restarts); controller HTTP stream: no replay | In-process views and watches; late join gets current view; no replay; no cross-process watch |
| Branching | `cloneThread`/`copyThread`; forked subagents; workflow time travel | `fork(entryId)` with per-document fork policy; `reset(handoff)` |
| Compaction | Not built in ("Friends don't let friends do compaction"); Observational Memory; `TokenLimiter` | Built-in background, blocking, and overflow compaction task; manual `compact()` |
| Usage/cost | Token usage per stream; metrics | `pi.usage` per model and tool incl. failed attempts; `harness.usage()` |
| Coding tools | Workspace fs and sandbox tools; many sandbox providers; skills; `createCodingAgent()`; Mastra Code product | `read`/`write`/`edit`/`bash`/`powershell`; codemode; `tool_search`; pi-env remote envs over SSH |
| Subagents | `agents` map; AgentController subagent types; ACP/Claude/OpenAI/Cursor SDK agents | Pattern: tool-owned conversation; examples only |
| Provider layer | Vendored AI SDK v4–v7, model router (218 registry providers), gateways | pi-ai (34 named providers + OpenAI-compatible) |
| Subscription OAuth | In `@mastra/code-sdk` (Claude Pro/Max, ChatGPT/Codex, Copilot, Kimi, xAI), not in core | In pi-ai (Claude Pro/Max, ChatGPT, Codex, Copilot, OpenRouter); Node-only login |
| ACP | Client: `@mastra/acp` (AcpAgent, createACPTool); server: only `mastracode --acp`, no session load | None; maintainer: build it yourself; community `pi-acp` wraps the coding agent, not Durable |
| MCP | `@mastra/mcp` client and server | None in Durable; `pi-mcp` client used by the coding agent |
| Other protocols | A2A 0.3.0, AG-UI (via `@ag-ui/mastra`), HTTP server + `client-js` | None |
| Server footprint | Hono server, Studio, deployers, server adapters; core depends on hono | Library only; host supplies everything |
| Telemetry to vendor | PostHog on by default; `MASTRA_TELEMETRY_DISABLED` | None found |
| Observability | Tracing with OTel and many exporters; evals; Studio | `onReport`, `inspect()`, task graph; no OTel |
| Extensibility | Processors, tools, storage domains, PubSub/lease providers, engines, workspaces, signal providers | Extensions (tools, sections, hooks, wrappers, tasks), documents, Storage/ExecutionEnv, hot reload |

## 4. Open questions

- Whether Pi Durable runs on Bun 1.3.14, which is what weave pins: in particular `node:sqlite` in that Bun release, the `NodeExecutionEnv` process and file APIs, and `/images/node` worker threads. The README claims portability through a facade, but no Bun test or CI job exists.
- Whether Mastra's durable-agent and workflow code is exercised under Bun. The docs list Bun as supported. The only Bun CI job found is a monorepo e2e test on Bun 1.2.15.
- Mastra's lease timing. The user doc says 10 s renewal and a 30 s lapse. The source default and design note say a 15 s TTL with renewal every 5 s. Which governs a given store was not tested.
- The exact replay guarantee of `createInngestAgent()` for a step that is in flight when a worker dies. The Mastra docs say steps are memoized. The at-least-once behaviour of an in-flight Inngest step comes from Inngest's semantics and was not verified in Inngest's own docs here.
- Whether AgentController sessions backed by a durable agent can serve a client that reconnects after a server restart and re-renders pending approvals. `respondToPersistedToolApproval()` exists in the source but is undocumented, and #27363 is open.
- Whether Mastra Code (`@mastra/code-sdk`) has its own compaction, given that core does not. Not inspected.
- Pi Durable performance and reliability numbers. The only figures found (SIGKILL recovery counts, ms per step) are in a third-party issue comment on #10386 and are unverified.
- That Earendil acquired Pi from Mario Zechner, and the governance terms, come only from secondary coverage (trendingtopics.eu, letsdatascience.com).
- Pi 1.0's "hundreds of thousands" of weekly users is a vendor claim.
- Provider terms for subscription OAuth in a third-party harness were checked for section 5: Anthropic's are explicit and prohibitive for Free, Pro, and Max; OpenAI's tolerance of ChatGPT sign-in rests on public statements, not contract terms.
- Whether Pi Durable will add a durable external-wait primitive for HITL or client-side tools (#10852), a cross-process watch, or a Postgres storage. There was no maintainer statement on any of these.
- Whether Mastra will add replay-safety declarations for tools (#25780). The issue is open; no timeline was found.

## 5. Fit for weave

Judged against weave at `cbb22e77`: the Rust weave Host of [ADR 0008](../adr/0008-weave-daemon-is-the-host.md), not Portal.

### 5.1 What the Host already is

The brief asks for a persistent runtime that serves interactive coding and long-running headless or triggered work equally. Most of that runtime already exists in `tui/crates/daemon`. The Host is a per-user launchd process. It runs one ACP agent process per open session and journals everything clients are sent, numbered. Clients attach from a journal position and receive only what they missed, across Host restarts. Permission requests and elicitations are Host objects that every attached client sees; the first answer counts. The same machinery runs headless sessions, whose permission policy answers for nobody. It also handles steering, subagent sessions, agent updates in place, Host tools through the Host-owned MCP server ([ADR 0009](../adr/0009-client-tools-through-a-host-owned-mcp-server.md)), and remote devices proven by Secure Enclave keys ([ADR 0010](../adr/0010-remote-clients-through-the-tailnet-with-device-keys.md)). Interactive and headless work are already one code path. They differ only in who answers pending requests.

What the Host does not do is run the agent loop. Claude Code (through claude-agent-acp) and Codex own model calls, tools, context, compaction, and the person's own login. Measured against the brief, the gaps are:

- **Triggers.** None yet. `Daemon::run` is the documented seam a trigger will call ([`lib.rs`](../../tui/crates/daemon/src/lib.rs#L679-L686)).
- **Surviving a Host restart mid-turn.** The agent processes die with the Host, and a resumed session journals the interrupted turn as cancelled ([Host protocol spec](../../tui/docs/specs/wve-85-host-protocol.md#L371-L373)). This is the Pi coding agent's model too: "If the process dies, you look at what happened and tell it to continue" (2.15).
- **Waits that outlast a restart.** A pending request ends with its turn.
- **Orchestration across sessions or agents**, beyond ACP subagents inside one agent.
- **An owned loop.** Without one, weave cannot checkpoint inside a turn, mix models within a run, or account cost per tool.

### 5.2 Three layers, decided separately

"Agent runtime" bundles three layers, and the candidates cover them very differently. Deciding them together makes the question look bigger than it is.

**The client-facing Host** covers sessions, journals, attach and replay, pending requests, authentication, and remote access. Neither candidate is a credible owner. Pi Durable has no server or authentication. Its watches are in-process only, and "a client that joins late or reconnects starts from the current view; nothing is replayed" (2.7). Mastra's AgentController HTTP stream does not replay missed events. Its durable-agent `observe()` replays an in-memory cache unless Redis is configured, and the offset is not on the public stream (1.7). Weave's position-based replay is exactly the property the [OpenHands research](openhands-and-weave-acp.md) chose to keep as the canonical remote contract. Adopting either framework here would mean rebuilding that contract on top of it, in a second language, in place of a Host that already works.

**The agent loop, for interactive coding,** should stay with the vendor agents. Quality is one reason: Claude Code and Codex are the harnesses the TUI was built to render. Credentials are the decisive one. Anthropic's [legal and compliance page](https://code.claude.com/docs/en/legal-and-compliance) reserves Free, Pro, and Max OAuth for "Claude Code and other native Anthropic applications". It says developers "should use API key authentication", and that Anthropic does not permit third-party developers "to route requests through Free, Pro, or Max plan credentials". Signing in to the unmodified Claude Code binary with one's own subscription is explicitly allowed, and that is what weave does now. pi-ai and Mastra Code both ship Claude Pro/Max login flows (1.9, 2.9). Using them inside a weave-owned loop would break Anthropic's terms, and it would break this repository's rule that agents "authenticate with their own CLI logins, and this project never reads or stores them" ([`tui/AGENTS.md`](../../tui/AGENTS.md)). ChatGPT sign-in inside third-party harnesses is tolerated by OpenAI statements, but no contract term grants it. A loop weave owns is therefore a loop billed by API key, at least for Claude. That suits headless, triggered, and custom-tool work. It does not suit replacing interactive coding.

**Durable execution and triggers** is where the Host's gap is real and the candidates differ most. Neither framework can checkpoint inside a Claude Code or Codex turn, because those loops are opaque processes. Framework durability applies only to loops weave owns. For vendor agents, durability can only come from the Host: process lifetime, draining, and resume-and-continue.

### 5.3 Mastra

Mastra offers the most features: persisted cron schedules, signals and a GitHub signal provider, chat channels, human-in-the-loop suspensions that survive restarts, and run fencing across processes (1.3, 1.6). Little of that fits weave's slot:

- **Durable agents.** They are beta, crash recovery is off by default, and recovery re-runs tools at least once, including whole subagent runs. Declaring which tools are safe to replay is an open issue (#25780). For coding tools that run shells and edit files, that is the wrong default.
- **Schedules.** They fire Mastra agents and workflows, not ACP sessions. The scheduler is one polling instance, which is no more than the Host would write against `Daemon::run`.
- **ACP.** `@mastra/acp` turns only message chunks into stream text. It approves permission requests with the first option offered unless overridden, and it cannot resume streams (1.10). Weave's ACP layer is complete, with conformance tests.
- **Weight.** `@mastra/core` alone is about 331,000 lines. It has its own server, storage domains, PostHog telemetry on by default, enterprise-licensed directories, and breaking changes in minor releases (1.1, 1.11, 1.14).

Mastra would be the right choice for a different product: a hosted, multi-tenant TypeScript agent service on Postgres, with Slack and GitHub channels, evals, and Studio. For a per-user Host that brokers vendor agents, it duplicates the Host, weakens the client contract, and would be the largest and fastest-changing dependency in the repository.

### 5.4 Pi Durable

Pi Durable's semantics are the better match for agent tools. It commits intent before every effect, and tools are replay-unsafe by default: an interrupted unsafe tool gets an "interrupted" result instead of running twice. It also has exactly-once admission by `requestId`, partials committed every 100 ms, built-in compaction, and usage accounting per model and tool (2.3, 2.7). It is a small MIT library with no server and no telemetry (2.11), so it embeds without a fight over who owns the process.

It cannot be the foundation today, for four reasons:

- It is self-declared experimental. Four of its eight releases in 15 days broke the API, and the unreleased SQLite schema v2 cannot be rolled back (2.14).
- Sleeps that survive a restart exist only on unreleased `main`.
- It has no wait for an external answer that survives a restart. #10852 is open with no maintainer reply.
- It has no triggers, no replay, and no cross-process ownership (2.3, 2.6, 2.7).

None of these gaps matter much in the slot where it fits: an agent the Host runs over ACP. In that slot the Host provides replay, triggers, and clients.

### 5.5 Recommendation

1. **Keep the Rust Host as the runtime authority.** Neither candidate makes a case to own the client protocol, sessions, journals, authentication, or remote access. Both are weaker than the Host on the contract clients depend on.
2. **Do not adopt Mastra**, in whole or in part.
3. **Close the headless gaps in the Host, without a framework.** This covers most of the brief:
   - **Triggers.** Schedules and webhooks call `Daemon::run`. Reuse WVE-64's admission rule (a durable execution record per accepted occurrence, keyed, created before the run starts), not its engine.
   - **Drain on restart.** `weave daemon restart` waits for running turns, or offers to, as Mastra's server drains in-flight turns.
   - **Continue after a crash.** A headless session's permission policy may continue an interrupted turn after resume. The journal records it as its own outcome rather than "cancelled". The `product/` glossary already names this one: "uncertain".
   - **A per-session agent supervisor**, if restarts mid-run still hurt. It would hold an agent's stdio across Host restarts, as the Terminal Service did for terminals.
   - **Orchestration without an owned loop.** Host tools on the ADR 0009 MCP server (open a session in another agent, run a turn, await its outcome) let Claude Code delegate to Codex through the Host, with journals and permission policies intact.
4. **When weave needs its own loop, build it as an ACP agent on Pi Durable**, launched by the Host like any preset. This keeps ADR 0008's seam.
   - It runs under Node as a child process, so the Bun pin does not apply; `tui/` is not a Bun workspace.
   - The maintainer's answer is to write the ACP adapter yourself (#10389). `pi-acp` is a working model of one, though it wraps the coding agent (2.16).
   - The mapping is direct. A conversation is an ACP session; Durable's own storage answers `session/load`. `watchEvents()` becomes `session/update`. A `beforeTool` hook becomes `session/request_permission`, which is a Host pending request. `whenBusy: "steer"` serves the steering extension.
   - A restart re-runs the hook and raises the pending request again. On a per-user Host that is acceptable while #10852 is open.
   - It takes API keys from the login-shell environment the Host already passes to agents, so weave still never stores a credential.
   - Prototype it with an exact pin. Before relying on it, require released durable sleeps, a durable external wait, and a stretch of releases without storage-format breaks.
5. **Revisit this decision** if any of these change:
   - Anthropic's terms change.
   - Pi Durable stabilises with durable waits and cross-process watches.
   - The product turns into a hosted multi-tenant service. Mastra is the stronger candidate there.
   - Weave decides to drop vendor harnesses for coding entirely. Pi Durable would then carry interactive work too, at API prices.

### 5.6 The brief, need by need

| Need | Host today | With 5.5 items 3–4 | If Mastra owned the stack |
| --- | --- | --- | --- |
| Interactive coding with Claude/Codex on the person's subscription | Yes | Unchanged | Through `@mastra/acp`, with less rendering fidelity; own loop on API keys |
| Attach and detach, catch up from a position, several clients | Yes | Unchanged | No replay on the controller stream; in-memory or Redis cache for durable runs |
| Steering, queued prompts, shared pending requests | Yes | Unchanged | Steering aborts and resends in AgentController |
| Headless runs under a policy | Yes | Unchanged | Yes |
| Schedules and webhooks | No | Host triggers | Yes, Mastra agents and workflows only |
| Survive a Host restart mid-turn | Cancelled | Drain, continue under policy, later a supervisor; owned loop resumes inside the turn | Durable agents with `recovery: 'auto'`, tools re-run |
| Approval that waits for days | While the Host runs | Same; owned loop re-raises it after a restart | Yes, through suspended snapshots |
| Cross-agent orchestration | ACP subagents only | Host MCP tools | Yes, inside Mastra |
| Model mixing and cost per tool | No | Owned loop | Yes |
