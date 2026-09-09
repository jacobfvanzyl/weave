# OpenHands ACP and Host architecture findings

Historical research snapshot from September 2026, retained during WVE-67 for its ACP, recovery, security, and runtime analysis. Scheduling and Automation proposals were withdrawn; this note is evidence, not an active implementation plan. Platform and repository paths describe the inspected snapshot and may differ after WVE-66.

## 1. Agent Server protocol and event delivery

### Public transport

Agent Server exposes REST under `/api/*` and WebSockets at `/sockets/events/{conversation_id}`. The WebSocket server supports three authentication placements: a preferred first WebSocket message, an authorization header for non-browser clients, and a deprecated query parameter. Its rationale is sound: first-message auth avoids putting a bearer value into the URL ([server socket implementation](https://github.com/OpenHands/software-agent-sdk/blob/94fca578b720df758b9bbf8a2639511b303c78e6/openhands-agent-server/openhands/agent_server/sockets.py#L1-L13)).

The current TypeScript client, however, still [places the API key in the WebSocket query string](https://github.com/OpenHands/software-agent-sdk/blob/94fca578b720df758b9bbf8a2639511b303c78e6/clients/typescript/src/events/websocket-client.ts#L92-L108). Its reconnect loop uses exponential backoff, but it does not maintain a server-confirmed replay cursor or acknowledge processed events ([reconnect implementation](https://github.com/OpenHands/software-agent-sdk/blob/94fca578b720df758b9bbf8a2639511b303c78e6/clients/typescript/src/events/websocket-client.ts#L128-L173)). This is an integration inconsistency Weave should explicitly avoid.

On connect, the server subscribes the socket to live events first and then optionally replays the event history, either all events or events with `timestamp >= since_timestamp`. That ordering prevents a simple replay/live blind spot, but concurrent live and replayed events can interleave and the inclusive timestamp boundary can duplicate events. See the [socket replay and bidirectional message path](https://github.com/OpenHands/software-agent-sdk/blob/94fca578b720df758b9bbf8a2639511b303c78e6/openhands-agent-server/openhands/agent_server/sockets.py#L225-L360).

The browser client compensates at the data-structure layer: `RemoteEventsList` pages historical events over REST, keeps a live cache, merges both sets, and de-duplicates by event ID ([remote event list](https://github.com/OpenHands/software-agent-sdk/blob/94fca578b720df758b9bbf8a2639511b303c78e6/clients/typescript/src/events/remote-events-list.ts#L1-L34), [merge and dedupe](https://github.com/OpenHands/software-agent-sdk/blob/94fca578b720df758b9bbf8a2639511b303c78e6/clients/typescript/src/events/remote-events-list.ts#L125-L188)). That is eventually useful UI behavior, but it is weaker than a protocol that can prove continuity.

**Decision:** keep Weave's sequence/ack/gap semantics as the canonical remote contract. Event UUIDs remain useful for idempotency and causality; timestamps should be presentation/filter fields, not the sole recovery cursor. Authenticate during handshake or in a protected first message, never in browser URLs.

### Durable event semantics

The base OpenHands `Event` is immutable, rejects unknown fields, and contains a UUID, timestamp, source, and optional `parent_id` ([event base](https://github.com/OpenHands/software-agent-sdk/blob/94fca578b720df758b9bbf8a2639511b303c78e6/openhands-sdk/openhands/sdk/event/base.py#L20-L40)). Concrete events are typed discriminated models for messages, actions, observations, conversation-state transitions, errors, ACP tool calls, and other domain changes.

The on-disk event store assigns an integer append index, but that index is not a serialized wire-level event sequence. The store is append-only and can walk a path from the active leaf through `parent_id`; older linear logs have a compatibility fallback ([event-tree traversal](https://github.com/OpenHands/software-agent-sdk/blob/94fca578b720df758b9bbf8a2639511b303c78e6/openhands-sdk/openhands/sdk/conversation/event_store.py#L91-L126), [append/index behavior](https://github.com/OpenHands/software-agent-sdk/blob/94fca578b720df758b9bbf8a2639511b303c78e6/openhands-sdk/openhands/sdk/conversation/event_store.py#L184-L232)). The conversation state has one append chokepoint that stamps the current parent, persists, then advances the active `HEAD` ([conversation append](https://github.com/OpenHands/software-agent-sdk/blob/94fca578b720df758b9bbf8a2639511b303c78e6/openhands-sdk/openhands/sdk/conversation/state.py#L295-L337)).

At the inspected SDK revision, the local conversation callback also persists an event before invoking caller callbacks such as Agent Server PubSub; if persistence raises, publication does not occur ([persist-before-publish callback](https://github.com/OpenHands/software-agent-sdk/blob/94fca578b720df758b9bbf8a2639511b303c78e6/openhands-sdk/openhands/sdk/conversation/impl/local_conversation.py#L412-L435)). That closes a critical server-side ordering hole. It still does not turn the append index into a remotely acknowledged sequence or give reconnecting clients a gap proof.

Branching is therefore a log operation: navigating or forking changes the active leaf while prior branches remain in the store. It does **not** imply the workspace filesystem was rolled back to the same point. Transcript lineage and filesystem snapshots are separate contracts.

`StreamingDeltaEvent` is explicitly transient and is not persisted; reconnecting clients are expected to recover the final durable message rather than every token delta ([streaming event model](https://github.com/OpenHands/software-agent-sdk/blob/94fca578b720df758b9bbf8a2639511b303c78e6/openhands-sdk/openhands/sdk/event/streaming_delta.py#L1-L13)). This is a clean distinction worth copying.

**Decision:** classify every Weave event as durable state, durable audit/progress, or transient projection. Do not make token deltas a recovery obligation. If branching is added, attach an explicit workspace snapshot/revision reference or state plainly that only the conversation view branches.

## 2. Conversation lifecycle, persistence, and recovery

### What is persisted

Conversation states include `idle`, `running`, `paused`, `waiting_for_confirmation`, `finished`, `error`, `stuck`, and `deleting` ([status enum](https://github.com/OpenHands/software-agent-sdk/blob/94fca578b720df758b9bbf8a2639511b303c78e6/openhands-sdk/openhands/sdk/conversation/state.py#L48-L79)). Persistent state includes agent and workspace configuration, execution status, secrets, tags, hook configuration, and agent-specific state such as an ACP provider session ID ([state fields](https://github.com/OpenHands/software-agent-sdk/blob/94fca578b720df758b9bbf8a2639511b303c78e6/openhands-sdk/openhands/sdk/conversation/state.py#L82-L127), [extended persistence](https://github.com/OpenHands/software-agent-sdk/blob/94fca578b720df758b9bbf8a2639511b303c78e6/openhands-sdk/openhands/sdk/conversation/state.py#L197-L228)).

The direct SDK restore API permits a caller to provide a compatible agent: its tools must match the persisted tools, but other configuration may differ. In contrast, Agent Server deliberately restores with `agent=None`, making the persisted definition the execution snapshot for server-managed conversations ([state restore checks](https://github.com/OpenHands/software-agent-sdk/blob/94fca578b720df758b9bbf8a2639511b303c78e6/openhands-sdk/openhands/sdk/conversation/state.py#L450-L500), [Agent Server restore](https://github.com/OpenHands/software-agent-sdk/blob/94fca578b720df758b9bbf8a2639511b303c78e6/openhands-agent-server/openhands/agent_server/event_service.py#L990-L1147)). This is a useful distinction between an SDK escape hatch and server reproducibility.

Remote plugins improve reproducibility further: fetch logic resolves a branch/tag/reference to an exact commit SHA and persists that resolution ([plugin fetch](https://github.com/OpenHands/software-agent-sdk/blob/94fca578b720df758b9bbf8a2639511b303c78e6/openhands-sdk/openhands/sdk/plugin/fetch.py#L69-L95)). But the overall launch contract is distributed across state fields rather than represented as one immutable manifest.

**Decision:** create a versioned `ThreadLaunchProfile`-like value in Weave. It should be immutable after the first durable event and contain at least:

- agent definition ID **and resolved revision/content hash**;
- provider command/package version and ACP capabilities;
- model, reasoning/mode options, and stable defaults;
- ordered tool/plugin/skill/MCP manifest with exact versions or commit SHAs;
- permission policy and grant issuer/audience;
- workspace ID, root, branch/worktree/snapshot identity;
- runtime backend, image digest, UID/GID, network/storage policy;
- environment-variable names and provenance, with values redacted or referenced through a secret store; and
- schema version plus migration rules.

### Recovery is intentionally conservative

When Agent Server loads a conversation that was persisted as `running`, it changes it to `error`. It scans the event log for an action without a matching observation and appends a non-retryable agent error rather than assuming the operation did or did not happen ([recovery logic](https://github.com/OpenHands/software-agent-sdk/blob/94fca578b720df758b9bbf8a2639511b303c78e6/openhands-agent-server/openhands/agent_server/event_service.py#L1155-L1198)). That is the correct default for arbitrary tools: replay can duplicate external effects.

The event store uses process/thread locking, but its source warns that `flock` may be unreliable on NFS ([store locking caveat](https://github.com/OpenHands/software-agent-sdk/blob/94fca578b720df758b9bbf8a2639511b303c78e6/openhands-sdk/openhands/sdk/conversation/event_store.py#L30-L40)). Agent Server adds an execution lease with owner identity, generation number, expiry, host, and process. Takeover increments the generation; renew/write guards reject a stale owner ([lease model](https://github.com/OpenHands/software-agent-sdk/blob/94fca578b720df758b9bbf8a2639511b303c78e6/openhands-agent-server/openhands/agent_server/conversation_lease.py#L18-L37), [takeover and fencing](https://github.com/OpenHands/software-agent-sdk/blob/94fca578b720df758b9bbf8a2639511b303c78e6/openhands-agent-server/openhands/agent_server/conversation_lease.py#L101-L215)).

**Decision:** add a monotonically fenced execution generation anywhere Weave permits reconnection, Portal restart, or competing workers to assume ownership. A lease is not enough unless every durable write verifies the generation. On ambiguous interrupted work, append a terminal recovery event and require an explicit, policy-checked retry.

### Workspace continuity is separate from conversation continuity

OpenHands can create a per-conversation Git worktree and branch named from the conversation ID ([worktree creation](https://github.com/OpenHands/software-agent-sdk/blob/94fca578b720df758b9bbf8a2639511b303c78e6/openhands-agent-server/openhands/agent_server/conversation_service.py#L195-L274)). That reduces cross-conversation source collisions, but it is not a transactionally consistent checkpoint with the event log. Non-Git files, uncommitted state, running processes, external systems, and container volumes can diverge.

**Decision:** model four recovery identities separately: conversation/event cursor, execution owner generation, provider session, and workspace snapshot/revision. Never infer one from another.

## 3. ACP integration: valuable adapter, unsafe authority model

### Session mapping

`ACPAgent` delegates one OpenHands agent to an ACP subprocess. It initializes ACP protocol version 1, then creates or loads an ACP session. One OpenHands step waits for one complete ACP assistant turn and emits a durable finish action/observation when the prompt call returns ([ACP agent definition](https://github.com/OpenHands/software-agent-sdk/blob/94fca578b720df758b9bbf8a2639511b303c78e6/openhands-sdk/openhands/sdk/agent/acp_agent.py#L1603-L1667), [turn finalization](https://github.com/OpenHands/software-agent-sdk/blob/94fca578b720df758b9bbf8a2639511b303c78e6/openhands-sdk/openhands/sdk/agent/acp_agent.py#L3567-L3595)).

The adapter persists the provider's ACP session ID and cwd in `agent_state`, so the next process can call `load_session`. An optional explicit resume-session ID supports a durable external mirror when the OpenHands sandbox filesystem is lost ([session persistence](https://github.com/OpenHands/software-agent-sdk/blob/94fca578b720df758b9bbf8a2639511b303c78e6/openhands-sdk/openhands/sdk/agent/acp_agent.py#L2252-L2276)). The code treats provider session IDs as bearer secrets and masks them from logs. A cwd mismatch or `load_session` request failure starts a fresh provider session ([load/fallback](https://github.com/OpenHands/software-agent-sdk/blob/94fca578b720df758b9bbf8a2639511b303c78e6/openhands-sdk/openhands/sdk/agent/acp_agent.py#L3000-L3053)).

The provider subprocess gets conversation secrets exported into its environment. Precedence is the secret registry, then inherited process environment, then configured defaults. Optional data-directory isolation can redirect provider homes such as `CODEX_HOME` or `HOME` per conversation, but that option defaults to false ([ACP process environment](https://github.com/OpenHands/software-agent-sdk/blob/94fca578b720df758b9bbf8a2639511b303c78e6/openhands-sdk/openhands/sdk/agent/acp_agent.py#L2737-L2761), [data-directory isolation](https://github.com/OpenHands/software-agent-sdk/blob/94fca578b720df758b9bbf8a2639511b303c78e6/openhands-sdk/openhands/sdk/agent/acp_agent.py#L1750-L1766)). Sharing a provider home preserves login and caches, but also couples credentials, config, session metadata, and mutable state across conversations.

**Decision:** persist the provider session ID as an encrypted reference, bind it to conversation/workspace/provider identity, and fail closed on mismatch. Make per-thread provider homes the default; selectively mount a read-only or brokered credential source instead of inheriting all of `HOME` or `CODEX_HOME`.

### Permissions are the sharpest warning

The current OpenHands ACP client callback `request_permission()` simply selects the first option offered by the provider ([permission bridge](https://github.com/OpenHands/software-agent-sdk/blob/94fca578b720df758b9bbf8a2639511b303c78e6/openhands-sdk/openhands/sdk/agent/acp_agent.py#L1513-L1530)). Provider presets request `bypassPermissions` for Claude Code and `agent-full-access` for Codex ([provider registry](https://github.com/OpenHands/software-agent-sdk/blob/94fca578b720df758b9bbf8a2639511b303c78e6/openhands-sdk/openhands/sdk/settings/acp_providers.py#L398-L450)). Meanwhile, filesystem and terminal callbacks are unimplemented because the provider subprocess is expected to execute its own tools ([bridge capability methods](https://github.com/OpenHands/software-agent-sdk/blob/94fca578b720df758b9bbf8a2639511b303c78e6/openhands-sdk/openhands/sdk/agent/acp_agent.py#L1532-L1578)).

This means OpenHands's outer confirmation policy does not mediate the provider's inner ACP tool calls. The runtime sandbox becomes the effective security boundary. It also means the pleasing UI abstraction “waiting for confirmation” can be true for native OpenHands actions while not applying to the nested ACP provider.

Native OpenHands policies are `AlwaysConfirm`, `NeverConfirm`, and `ConfirmRisky`, where unknown risk is treated as requiring confirmation ([confirmation policies](https://github.com/OpenHands/software-agent-sdk/blob/94fca578b720df758b9bbf8a2639511b303c78e6/openhands-sdk/openhands/sdk/security/confirmation_policy.py#L27-L61)). Conversation state currently defaults to `NeverConfirm`, and the agent loop asks the policy before routing an action to `waiting_for_confirmation` ([default](https://github.com/OpenHands/software-agent-sdk/blob/94fca578b720df758b9bbf8a2639511b303c78e6/openhands-sdk/openhands/sdk/conversation/state.py#L82-L127)).

**Decision:** preserve Weave's fail-closed permission request as an end-to-end protocol event. Bind the approval to a cryptographic grant containing principal, conversation, provider process generation, tool/action digest, workspace/root, expiry, and single-use nonce. A disconnect, timeout, missing UI capability, or unknown option must deny or remain pending—never pick an option by position. Provider bypass flags must be prohibited unless the runtime is intentionally autonomous and separately policy-scoped.

### Timeouts and liveness

OpenHands distinguishes provider startup timeout, prompt idle timeout, and retry backoff. The prompt timeout is activity-based, and the adapter sends `session/cancel` when exceeded. It also emits heartbeats because inner ACP tool activity does not naturally reach Agent Server's HTTP layer ([timeout configuration](https://github.com/OpenHands/software-agent-sdk/blob/94fca578b720df758b9bbf8a2639511b303c78e6/openhands-sdk/openhands/sdk/agent/acp_agent.py#L136-L169), [activity heartbeat](https://github.com/OpenHands/software-agent-sdk/blob/94fca578b720df758b9bbf8a2639511b303c78e6/openhands-sdk/openhands/sdk/agent/acp_agent.py#L1492-L1511)).

**Decision:** distinguish transport liveness, provider activity, turn deadline, and tool deadline in Weave. A heartbeat should extend only an idle timeout, never an absolute policy or grant expiry.

## 4. Runtime, sandbox, and deployment backends

OpenHands exposes workspace/runtime variants rather than making the agent loop care where execution happens:

- direct/local execution for trusted development;
- `DockerWorkspace`, which starts a prebuilt Agent Server container, uses `/workspace`, maps port 8000, and can pass environment, volume, network, and GPU options ([Docker workspace configuration](https://github.com/OpenHands/software-agent-sdk/blob/94fca578b720df758b9bbf8a2639511b303c78e6/openhands-workspace/openhands/workspace/docker/workspace.py#L53-L127), [container launch](https://github.com/OpenHands/software-agent-sdk/blob/94fca578b720df758b9bbf8a2639511b303c78e6/openhands-workspace/openhands/workspace/docker/workspace.py#L208-L252));
- a remote Agent Server workspace, which the source recommends for production-style network execution ([remote workspace](https://github.com/OpenHands/software-agent-sdk/blob/94fca578b720df758b9bbf8a2639511b303c78e6/openhands-sdk/openhands/sdk/workspace/remote/base.py#L51-L71));
- an API remote workspace that creates or attaches to an externally managed runtime session; and
- an OpenHands Cloud workspace that provisions or resumes a hosted sandbox by ID ([cloud workspace](https://github.com/OpenHands/software-agent-sdk/blob/94fca578b720df758b9bbf8a2639511b303c78e6/openhands-workspace/openhands/workspace/cloud/workspace.py#L53-L152)).

The default Docker launch is convenience-oriented: it does not itself guarantee denied networking, dropped capabilities, a read-only root filesystem, or least-privilege mounts. Security is determined by deployment flags and what is mounted. Direct local mode has broad host access; Agent Canvas explicitly warns users about that mode ([Canvas local warning](https://github.com/OpenHands/OpenHands/blob/9bd0788840468b4aa4b0c5e7a17dd514e4bc3cab/README.md#L60-L67)).

The abstraction is worth copying, the defaults are not. Weave's runtime contract should expose capabilities and policy facts—filesystem roots, network egress, credential access, browser availability, persistence class, snapshot support, UID/GID, and tool locality—so clients do not infer safety from a backend name such as “Docker.”

## 5. Tools, MCP, plugins, and extensions

### Tool contracts and concurrency

OpenHands tool definitions validate inputs/outputs with JSON Schema Draft 2020-12. Annotations model MCP-style `readOnly`, `destructive`, `idempotent`, and `openWorld` hints ([tool model](https://github.com/OpenHands/software-agent-sdk/blob/94fca578b720df758b9bbf8a2639511b303c78e6/openhands-sdk/openhands/sdk/tool/tool.py#L18-L116), [annotations](https://github.com/OpenHands/software-agent-sdk/blob/94fca578b720df758b9bbf8a2639511b303c78e6/openhands-sdk/openhands/sdk/tool/tool.py#L215-L274)). Tools can declare resource keys; the parallel executor allows concurrency only when claims do not conflict and serializes undeclared tools as the safe fallback ([resource declaration](https://github.com/OpenHands/software-agent-sdk/blob/94fca578b720df758b9bbf8a2639511b303c78e6/openhands-sdk/openhands/sdk/tool/tool.py#L513-L521), [parallel executor contract](https://github.com/OpenHands/software-agent-sdk/blob/94fca578b720df758b9bbf8a2639511b303c78e6/openhands-sdk/openhands/sdk/agent/parallel_executor.py#L1-L16)).

**Decision:** add resource claims to Weave tool metadata. “Parallel-safe” alone is too weak; claims such as workspace path, terminal/process, browser page, repository index, or external record let the scheduler prove non-conflict. Treat MCP annotations as hints supplied by an extension, not authorization facts.

### MCP lifecycle

OpenHands accepts stdio, HTTP/streamable-HTTP, and SSE MCP servers, including headers and OAuth configuration. A router can validate a candidate server and optionally call a tool, but its own source says the caller remains responsible for ensuring the operation is read-only ([MCP validation route](https://github.com/OpenHands/software-agent-sdk/blob/94fca578b720df758b9bbf8a2639511b303c78e6/openhands-agent-server/openhands/agent_server/mcp_router.py#L1-L18), [transport configuration](https://github.com/OpenHands/software-agent-sdk/blob/94fca578b720df758b9bbf8a2639511b303c78e6/openhands-agent-server/openhands/agent_server/mcp_router.py#L75-L183)). The SDK subscribes to `notifications/tools/list_changed`, re-lists tools, and reconciles additions, updates, and removals ([MCP reconciliation](https://github.com/OpenHands/software-agent-sdk/blob/94fca578b720df758b9bbf8a2639511b303c78e6/openhands-sdk/openhands/sdk/mcp/utils.py#L191-L340)).

**Decision:** copy dynamic reconciliation but treat every tool-list change as a launch-profile drift event. Recompute policy/capability exposure, persist the new manifest revision, and do not silently add newly advertised tools to an already approved conversation.

### Plugins and Canvas extensions

SDK plugins bundle skills, hooks, MCP servers, agents, and commands ([plugin model](https://github.com/OpenHands/software-agent-sdk/blob/94fca578b720df758b9bbf8a2639511b303c78e6/openhands-sdk/openhands/sdk/plugin/plugin.py#L36-L71)). This is a strong packaging seam, especially with commit resolution.

Canvas Extensions are a different feature: beta extensions add custom pages backed by authenticated HTTP endpoints. Installation is disabled by default and asks the operator to review the resolved revision, but installed extension code runs in the same browser context—without iframe/worker isolation or fine-grained permissions ([extension trust warning](https://github.com/OpenHands/docs/blob/7c34815ea5583b75a0550d2507fbaa1f41eb06e3/openhands/usage/agent-canvas/canvas-extensions.mdx#L14-L24), [installation and authority](https://github.com/OpenHands/docs/blob/7c34815ea5583b75a0550d2507fbaa1f41eb06e3/openhands/usage/agent-canvas/canvas-extensions.mdx#L57-L75)).

**Decision:** keep runtime plugins and UI extensions separate. UI extensions should be isolated origins/iframes or declarative views with capability-scoped RPC, signed/pinned packages, CSP, explicit network/resource grants, and revocation. “Reviewed commit” is supply-chain provenance, not runtime containment.

## 6. Browser and computer use

The Browser tool is a Playwright-based headless runtime with domain restrictions, per-action timeouts, session expiry, and a unique browser data directory. When running as root it disables Chromium's sandbox and warns about the risk ([browser setup](https://github.com/OpenHands/software-agent-sdk/blob/94fca578b720df758b9bbf8a2639511b303c78e6/openhands-tools/openhands/tools/browser_use/impl.py#L243-L375)). Its actions cover navigation, click, input, tabs, scrolling, state/content, screenshots, and recording. Browser recordings capture DOM mutations, mouse/click/scroll activity into an rrweb artifact; that artifact is distinct from the canonical conversation event log ([recording definition](https://github.com/OpenHands/software-agent-sdk/blob/94fca578b720df758b9bbf8a2639511b303c78e6/openhands-tools/openhands/tools/browser_use/definition.py#L690-L701)).

Agent Canvas's Browser panel is a screenshot viewer: the component renders the latest snapshot as an image, while the WebSocket context updates screenshot and URL state from browser events ([Canvas browser view](https://github.com/OpenHands/OpenHands/blob/9bd0788840468b4aa4b0c5e7a17dd514e4bc3cab/src/components/features/browser/browser-snapshot.tsx#L8-L17), [event projection](https://github.com/OpenHands/OpenHands/blob/9bd0788840468b4aa4b0c5e7a17dd514e4bc3cab/src/contexts/conversation-websocket-context.tsx#L691-L705)). It is not an attended live-browser control/takeover protocol. General VNC/desktop support has been removed: the Agent Server route is deprecated and returns 503 ([desktop route](https://github.com/OpenHands/software-agent-sdk/blob/94fca578b720df758b9bbf8a2639511b303c78e6/openhands-agent-server/openhands/agent_server/desktop_router.py#L16-L28)).

**Decision:** borrow the separation between canonical actions/events and rich replay artifacts. Do not regress Weave's attended browser boundary to an agent-owned headless screenshot stream. Human attachment, current control owner, input revocation, navigation policy, and disconnect behavior need first-class protocol states.

## 7. Observability and privacy

OpenHands explicitly separates three observability surfaces:

1. local, privacy-sensitive LLM logs;
2. Laminar/OpenTelemetry operational traces; and
3. product analytics ([telemetry package contract](https://github.com/OpenHands/software-agent-sdk/blob/94fca578b720df758b9bbf8a2639511b303c78e6/openhands-agent-server/openhands/agent_server/telemetry/__init__.py#L1-L18)).

Product telemetry uses frozen, allowlisted events and constrained scalar fields rather than arbitrary dictionaries or exception text. Conversation outcome events use bucketed magnitudes and avoid paths/raw error strings ([telemetry models](https://github.com/OpenHands/software-agent-sdk/blob/94fca578b720df758b9bbf8a2639511b303c78e6/openhands-agent-server/openhands/agent_server/telemetry/models.py#L1-L16), [conversation events](https://github.com/OpenHands/software-agent-sdk/blob/94fca578b720df758b9bbf8a2639511b303c78e6/openhands-agent-server/openhands/agent_server/telemetry/models.py#L161-L210)). Agent Server defaults to no telemetry exporter; enabled sinks are consent-gated and buffered ([disabled default](https://github.com/OpenHands/software-agent-sdk/blob/94fca578b720df758b9bbf8a2639511b303c78e6/openhands-agent-server/openhands/agent_server/config.py#L133-L160), [telemetry service](https://github.com/OpenHands/software-agent-sdk/blob/94fca578b720df758b9bbf8a2639511b303c78e6/openhands-agent-server/openhands/agent_server/telemetry/service.py#L56-L160)).

Laminar/OTel tracing can export to OTLP or Laminar. Delegation detaches nested trace context and links the child to parent identifiers, avoiding invalid nested context across asynchronous/process boundaries ([observability setup](https://github.com/OpenHands/software-agent-sdk/blob/94fca578b720df758b9bbf8a2639511b303c78e6/openhands-sdk/openhands/sdk/observability/laminar.py#L27-L135), [delegation links](https://github.com/OpenHands/software-agent-sdk/blob/94fca578b720df758b9bbf8a2639511b303c78e6/openhands-sdk/openhands/sdk/observability/laminar.py#L408-L472)).

**Decision:** keep the Weave journal authoritative for user-visible recovery, traces best-effort for operational causality, and analytics schema-constrained and opt-in. Share correlation IDs, not payloads, across planes. Normalize ACP provider/tool activity to spans without pretending those spans are durable session events.

## 8. Multi-agent and delegation

OpenHands has more than one delegation form:

- `DelegateExecutor` creates child Conversations, copies the parent LLM, shares the same workspace path by default, optionally persists children under the parent, inherits the confirmation policy unless overridden, enforces a default maximum of five children, runs assignments concurrently, and consolidates results ([delegate creation](https://github.com/OpenHands/software-agent-sdk/blob/94fca578b720df758b9bbf8a2639511b303c78e6/openhands-tools/openhands/tools/delegate/impl.py#L33-L50), [child setup](https://github.com/OpenHands/software-agent-sdk/blob/94fca578b720df758b9bbf8a2639511b303c78e6/openhands-tools/openhands/tools/delegate/impl.py#L165-L242), [parallel collection](https://github.com/OpenHands/software-agent-sdk/blob/94fca578b720df758b9bbf8a2639511b303c78e6/openhands-tools/openhands/tools/delegate/impl.py#L279-L399)).
- Agent Server supports immutable parent/child conversation links within the same workspace for UI and lifecycle organization; deleting a parent orphans rather than cascades to its children ([relationship validation](https://github.com/OpenHands/software-agent-sdk/blob/94fca578b720df758b9bbf8a2639511b303c78e6/openhands-agent-server/openhands/agent_server/conversation_service.py#L1544-L1562), [deletion behavior](https://github.com/OpenHands/software-agent-sdk/blob/94fca578b720df758b9bbf8a2639511b303c78e6/openhands-agent-server/openhands/agent_server/conversation_service.py#L1841-L1853)).
- `ACPAgent.ask_agent()` can fork the provider's ACP session for an isolated question without changing the main provider session; this is not itself a first-class durable child conversation ([ACP fork](https://github.com/OpenHands/software-agent-sdk/blob/94fca578b720df758b9bbf8a2639511b303c78e6/openhands-sdk/openhands/sdk/agent/acp_agent.py#L4103-L4165)).
- The Workflow tool lets a model generate Python map/reduce/pipeline orchestration with bounded concurrency. The code is validated only on a best-effort basis and executes in-process ([workflow definition](https://github.com/OpenHands/software-agent-sdk/blob/94fca578b720df758b9bbf8a2639511b303c78e6/openhands-tools/openhands/tools/workflow/definition.py#L24-L42), [tool surface](https://github.com/OpenHands/software-agent-sdk/blob/94fca578b720df758b9bbf8a2639511b303c78e6/openhands-tools/openhands/tools/workflow/definition.py#L56-L137)).

The useful model is explicit child identity, bounded fan-out, inherited-or-overridden policy, separate logs, aggregate result, and linked traces. The dangerous defaults are shared mutable workspaces and executing generated orchestration in the trusted server process.

**Decision:** give every delegate its own conversation/process generation and event stream. Make workspace sharing an explicit resource claim, default concurrent writers to isolated worktrees/snapshots, propagate a narrowed permission budget, and represent aggregation durably. If models can generate orchestration code, run it in the sandbox with the same approval and resource controls as any other code execution.

## 10. Security findings to carry into Weave review

These are the high-signal review checks exposed by OpenHands:

- **Unauthenticated-by-default server:** the Agent Server can execute commands and files and must not be exposed without an authenticated edge ([official warning](https://github.com/OpenHands/docs/blob/7c34815ea5583b75a0550d2507fbaa1f41eb06e3/sdk/arch/agent-server.mdx#L61-L65), [public-network warning](https://github.com/OpenHands/docs/blob/7c34815ea5583b75a0550d2507fbaa1f41eb06e3/sdk/arch/agent-server.mdx#L147-L148)). Weave should have no network-reachable unsafe development default.
- **Stable secret encryption key:** restored secrets require a stable `OH_SECRET_KEY`; without the cipher, values are redacted/lost rather than silently exposed. Weave should make key loss and rotation behavior explicit.
- **Provider sessions are bearer capabilities:** do not log them or accept them without binding and authorization.
- **Nested-agent authority:** outer “confirm risky” policy is meaningless if a child/provider is configured for bypass.
- **Shared mutable home:** convenient login reuse is also cross-thread state and credential coupling.
- **Container is not synonymous with sandbox:** verify mounts, UID/GID, capabilities, seccomp, network, persistence, and browser sandbox state.
- **Same-origin extensions are fully trusted:** provenance review cannot replace containment.
- **Dynamic MCP drift:** a server can advertise a new or changed tool after launch; policy must re-evaluate it.
- **Stale writers:** restart/takeover requires fencing, not only a lock file.
- **Ambiguous side effects:** never automatically replay an interrupted arbitrary action.

## 11. Licensing and reuse boundary

The SDK/Agent Server repository is [MIT-licensed](https://github.com/OpenHands/software-agent-sdk/blob/94fca578b720df758b9bbf8a2639511b303c78e6/LICENSE), as are [Agent Canvas](https://github.com/OpenHands/OpenHands/blob/9bd0788840468b4aa4b0c5e7a17dd514e4bc3cab/LICENSE), [Automation](https://github.com/OpenHands/automation/blob/aca9edd6d74875948e943b59af6fdbca6b6a2642/pyproject.toml#L1-L7), and [OpenClaw](https://github.com/openclaw/openclaw/blob/0965053fe6b9341776df147a6934b7485c60b5ca/LICENSE). The unmaintained OpenHands CLI is also MIT, but maintenance status makes it a poor dependency.

MIT permits reuse with preservation of the copyright and license notice. It does not license third-party model providers, provider CLIs, bundled dependencies, trademarks, hosted OpenHands Cloud, or Enterprise services. Those need separate dependency, trademark, and service-term review.

