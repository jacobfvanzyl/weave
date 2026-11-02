# Always-on agents and long-running context

Research snapshot, 2026-11-02. Primary sources only. Repositories were read at these commits: `openclaw/openclaw` [`9ee32610`](https://github.com/openclaw/openclaw/tree/9ee3261087083810b4697ce21d54bee10b135cc5) (docs only; newer than the identity note's `969d4e53`), `NousResearch/hermes-agent` [`59cb994b`](https://github.com/NousResearch/hermes-agent/tree/59cb994b2e5a4eed07e168bfbd6b3160a2e276d7) (docs only; newer than `3d7e6874`), `agentclientprotocol/agent-client-protocol` [`8fed1ac3`](https://github.com/agentclientprotocol/agent-client-protocol/tree/8fed1ac366e0e2f7e3f3264019780392fb36b12c) (docs only), `agentclientprotocol/claude-agent-acp` [`eb78afa8`](https://github.com/agentclientprotocol/claude-agent-acp/tree/eb78afa8556b8fc4082495e48e3fd1762fb6a50f) and `zed-industries/codex-acp` [`296069e8`](https://github.com/zed-industries/codex-acp/tree/296069e841634cd4bb9bc4515602d836e49231ec) (the adapters weave runs, source only), and the pinned `agent-client-protocol-schema` 1.10.2 in the local Cargo registry. Vendor documentation that carries no version (docs.x.ai/grok-bot, learn.chatgpt.com, code.claude.com, docs.letta.com) was read on 2026-11-02 through each site's Markdown twin. Nothing was installed, built or run. Sections 1–3 are facts and their sources. Section 4 judges them against weave at `e7db435a` and the Dispatcher as decided on 2026-11-02, and every recommendation there is marked as one. Section 5 lists what the sources didn't settle.

This note follows two earlier ones and cites them instead of repeating them. [The identity note](agent-identity-and-where-agents-run.md) (2026-10-22) covered what an always-on agent is in Letta ([§4.1](agent-identity-and-where-agents-run.md#41-letta)), OpenClaw ([§4.2](agent-identity-and-where-agents-run.md#42-openclaw)), Hermes ([§4.3](agent-identity-and-where-agents-run.md#43-hermes-agent)) and dots ([§4.4](agent-identity-and-where-agents-run.md#44-openai-dots)), and proposed the record WVE-118 describes ([§10.4](agent-identity-and-where-agents-run.md#104-wve-118-always-on-agents)). [The away note](agents-that-work-while-the-person-is-away.md) (2026-11-02) covered how such agents are started, timed, reported and picked up: Grok Bot ([§1.1](agents-that-work-while-the-person-is-away.md#11-xai-grok-automations-grok-bot-grok-build-and-grok)), dots ([§1.2](agents-that-work-while-the-person-is-away.md#12-openai-dots-scheduled-tasks-pulse-agent-mode-codex)) and WVE-118's fit ([§7.6](agents-that-work-while-the-person-is-away.md#76-wve-118-always-on-agents)). Neither looked at how one conversation survives weeks of use, which is this note's subject. What has changed or was missed since:

- **Hermes now has Bot Mode.** "A Bot is a profile" with "one permanent **Bot Chat**", in which `/new` is rerouted to `/compact` (1.4). That is the closest product shape to WVE-118 found so far, and it contradicts the identity note's reading of "Bot" as only Hermes's chat-platform account.
- **OpenClaw retired its heartbeat as a feature.** Heartbeats are now ordinary automation jobs, and `HEARTBEAT.md` is imported once into a job's "scratch" (1.3).
- **Hermes core dropped time-based resets.** Gateway conversations "do not reset after inactivity or at a daily boundary" (2.2).
- **ACP's session compaction RFD is Completed**, and its completion removes the `unstable_session_compaction` Cargo feature weave still names (2.7).
- **Claude Code loads `CLAUDE.md` from an additional directory** only with `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` set, and never `AGENTS.md` from one ([memory](https://code.claude.com/docs/en/memory#load-from-additional-directories)). This settles one of the identity note's [open questions](agent-identity-and-where-agents-run.md#9-open-questions).

## 1. What makes an always-on agent different from a thread

### 1.1 Grok Bot (xAI; shipped)

- **Identity.** "A Bot is a durable AI teammate with a name, a job, its own conversation, and working context that develops over time" ([Create and manage Bots](https://docs.x.ai/grok-bot/bots)). xAI's advice is to give each Bot "a clear job" and to create another Bot when a job has a distinct goal, tools, approval boundary or schedule.
- **Computer.** Bots "have separate roles and conversations, but they share the computer" ([same page](https://docs.x.ai/grok-bot/bots#organize-a-team-of-bots)). The away note covered the persistent cloud computer.
- **Memory.** A Bot keeps "stable preferences, important facts, and summaries from its work, which lets it keep a role over time without replaying every prior message", including "a dated log of what it has worked on with you". It "decides on its own when something is worth keeping" and "doesn't ask first". There is no memory screen: the person asks in chat what it remembers, or asks it to forget. A few facts about the person (name, time zone) are shared by all their Bots ([What a Bot remembers](https://docs.x.ai/grok-bot/bots#what-a-bot-remembers)). Where memory is stored, and when it is loaded, isn't documented.
- **One conversation, resettable.** "Reset a conversation: Memory is kept". After a reset, "the conversation history starts over, and the Bot's memory, files, routines, and settings are kept" ([What resets or deletes memory](https://docs.x.ai/grok-bot/bots#what-resets-or-deletes-memory)). The advice is to "Start a thread or a new Bot when a conversation has changed to a different long-lived job" ([Keep conversations effective](https://docs.x.ai/grok-bot/chat-and-collaboration#keep-conversations-effective)). Threads hang feedback on one result "to keep the main transcript focused" ([Use threads and reactions](https://docs.x.ai/grok-bot/chat-and-collaboration#use-threads-and-reactions)).
- **Channels.** A personal Bot asked from the person's own Slack DM replies in "The app chat, not Slack". In a shared Slack channel thread it refuses, since it acts for nobody ([Let Bots hand work off](https://docs.x.ai/grok-bot/chat-and-collaboration#let-bots-hand-work-off)). `@bot` on X was covered in the away note.
- **Triggers and results.** A routine's run reports into the Bot's own chat: "check the Bot's chat for the result" ([Skills and routines](https://docs.x.ai/grok-bot/skills-routines-and-automations#test-before-enabling)).
- **Skills.** "Make it reliable, save the method as a skill". Private skills are "one library shared by all your Bots" (same page).
- **Background work.** Coding work goes to a Cursor Cloud Agent. When it finishes, the Bot attaches the agent's cited files "to its reply" ([Results from Cloud Agents](https://docs.x.ai/grok-bot/files-and-results#results-from-cloud-agents)).

### 1.2 OpenAI dots (shipped, rolling out)

- **One agent, several visible conversations.** "You reach the same dot in ChatGPT, Slack, Teams, or a call… Messages stay in their respective channels, while your dot can use relevant context across them" ([Meet dots](https://learn.chatgpt.com/docs/dots)). "The visible conversations remain distinct. A message in ChatGPT isn't automatically copied into your Slack conversation" ([Across messaging channels](https://learn.chatgpt.com/docs/dots/tasks-and-memory#across-messaging-channels)).
- **Memory.** Three layers: "the conversation it is working in, relevant ChatGPT memory, and its own saved notes". The notes "are separate from ChatGPT's saved memory and are not a complete transcript" ([Context and memory](https://learn.chatgpt.com/docs/dots/tasks-and-memory#context-and-memory)).
- **Search over the past.** "Your dot can search your past ChatGPT conversations for relevant context… it isn't the same as persistent memory" (same section).
- **Work that runs elsewhere.** The dot "can divide work among background agents that run in parallel and report back to it", and new tasks each have "its own conversation; it doesn't automatically receive every conversation you've had with your dot" ([Assigned work](https://learn.chatgpt.com/docs/dots/tasks-and-memory#assigned-work)). In proactive research, "the background agents report their findings to your dot" ([Proactive research](https://learn.chatgpt.com/docs/dots/tasks-and-memory#proactive-research)).
- **Context limits.** How the dot's own conversation stays within a context window isn't documented. "Calls use selected conversation context" is the only statement.

### 1.3 OpenClaw (open source)

- **The main session.** Every direct message from any channel "lands in **one rolling conversation**: the main session". It is "an ordinary session with the standard key `agent:<agentId>:main`" ([main-session.md](https://github.com/openclaw/openclaw/blob/9ee3261087083810b4697ce21d54bee10b135cc5/docs/concepts/main-session.md?plain=1#L10-L21)). What makes it special is routing: "heartbeats wake it, background work reports back to it, and activity elsewhere flows up to it". The web app calls it **Home** ([L25-L29](https://github.com/openclaw/openclaw/blob/9ee3261087083810b4697ce21d54bee10b135cc5/docs/concepts/main-session.md?plain=1#L25-L29)).
- **What flows in.** Three things flow in ([L57-L79](https://github.com/openclaw/openclaw/blob/9ee3261087083810b4697ce21d54bee10b135cc5/docs/concepts/main-session.md?plain=1#L57-L79)):
  - New sessions queue a system notice that Home "sees on its next turn or scheduled heartbeat; creation does not trigger an extra wake-up".
  - Group activity becomes "compact notices — coalesced per conversation, never one wake-up per message".
  - Sub-agents "announce their results back to the session that started them".
- **Isolation is a setting.** `session.dmScope: "per-channel-peer"` gives each sender a session of their own and turns cross-conversation recall off ([L120-L139](https://github.com/openclaw/openclaw/blob/9ee3261087083810b4697ce21d54bee10b135cc5/docs/concepts/main-session.md?plain=1#L120-L139)).
- **Heartbeat, now a job.**
  - "Heartbeat monitoring now uses ordinary automation jobs", and Doctor converts old monitors and `HEARTBEAT.md` ([heartbeat.md](https://github.com/openclaw/openclaw/blob/9ee3261087083810b4697ce21d54bee10b135cc5/docs/gateway/heartbeat.md?plain=1#L12-L21)).
  - First setup makes one **Proactive check** job that "runs every 30 minutes… uses the agent's main conversation, waits for idle execution, and delivers to a resolved owner DM" ([L131-L142](https://github.com/openclaw/openclaw/blob/9ee3261087083810b4697ce21d54bee10b135cc5/docs/gateway/heartbeat.md?plain=1#L131-L142)).
  - Job policies include `activeHours` and `idleOnly` ([L176-L184](https://github.com/openclaw/openclaw/blob/9ee3261087083810b4697ce21d54bee10b135cc5/docs/gateway/heartbeat.md?plain=1#L176-L184)).
  - A check with nothing to say returns `NO_REPLY` and is not delivered ([L218-L228](https://github.com/openclaw/openclaw/blob/9ee3261087083810b4697ce21d54bee10b135cc5/docs/gateway/heartbeat.md?plain=1#L218-L228)).
  - The main-session page still says "heartbeats wake it", which is now true of that job.
- **Standing intents.** "Event-conditioned" instructions ("when the release candidate is mentioned, remind me…") are kept in SQLite and "checked before eligible interactive replies". Clock-time reminders stay with scheduled jobs ([standing-intents.md](https://github.com/openclaw/openclaw/blob/9ee3261087083810b4697ce21d54bee10b135cc5/docs/concepts/standing-intents.md?plain=1#L10-L22)).
- Memory, compaction, resets and cron targets are in 2.1. Identity files (`SOUL.md`, `IDENTITY.md`) were covered in [§4.2](agent-identity-and-where-agents-run.md#42-openclaw).

### 1.4 Hermes Agent: profiles and Bot Mode (open source)

- **A Bot is a profile.** "Bot Mode turns your Hermes profiles into a roster of named **Bots**. Each Bot has its own role, model, memory, skills, and avatar" ([bot-mode.md](https://github.com/NousResearch/hermes-agent/blob/59cb994b2e5a4eed07e168bfbd6b3160a2e276d7/website/docs/user-guide/bot-mode.md?plain=1#L8-L17)). It is on by default in the desktop app. "There is no new primitive to learn… Bot Mode is a UI over that primitive" (same lines). The profile glossary was covered in [§4.3](agent-identity-and-where-agents-run.md#43-hermes-agent), and Hermes now adds "Bot Mode bot" to it ([profiles.md](https://github.com/NousResearch/hermes-agent/blob/59cb994b2e5a4eed07e168bfbd6b3160a2e276d7/website/docs/user-guide/profiles.md?plain=1#L19-L31)).
- **One canonical conversation.** Each Bot has "a canonical, persistent **Bot Chat**". It is a "forever-chat": `/new` in it "would fork the relationship into a scratch session — the one thing Bot Mode promises never happens. The composer reroutes it to `/compact` instead: fresh working context, same conversation." Other sessions of the same profile keep `/new` ([L42-L46](https://github.com/NousResearch/hermes-agent/blob/59cb994b2e5a4eed07e168bfbd6b3160a2e276d7/website/docs/user-guide/bot-mode.md?plain=1#L42-L46)). The Bot Chat is just a session "titled exactly `Bot Chat`" ([L198-L221](https://github.com/NousResearch/hermes-agent/blob/59cb994b2e5a4eed07e168bfbd6b3160a2e276d7/website/docs/user-guide/bot-mode.md?plain=1#L198-L221)).
- **Routines.** Routines "are plain Hermes cron jobs namespaced `[bot:<name>] <routine>`", and "Runs land in the Bot's own chat history" ([L104-L108](https://github.com/NousResearch/hermes-agent/blob/59cb994b2e5a4eed07e168bfbd6b3160a2e276d7/website/docs/user-guide/bot-mode.md?plain=1#L104-L108)). Cron's `bot-chat` target delivers a run's output "into a profile's canonical 'Bot Chat' session as a real message". The bot "acts on anything that needs action". "Each delivery costs the target bot one full agent turn", and delivery is "durably queued immediately, whether the bot is idle or busy" ([cron.md](https://github.com/NousResearch/hermes-agent/blob/59cb994b2e5a4eed07e168bfbd6b3160a2e276d7/website/docs/user-guide/features/cron.md?plain=1#L702-L712)).
- **Bot to bot.** `message_agent` delivers "into the teammate's canonical Bot Chat". Delivery is "fire-and-forget", and the reply comes back as a completion notification ([L185](https://github.com/NousResearch/hermes-agent/blob/59cb994b2e5a4eed07e168bfbd6b3160a2e276d7/website/docs/user-guide/bot-mode.md?plain=1#L185)).
- **Across machines.** "A Bot's chats, sessions, memory, and routines live on the machine that owns the profile". Other machines' Bots are reached by `@name-device` over the desktop's relay ([L362-L368](https://github.com/NousResearch/hermes-agent/blob/59cb994b2e5a4eed07e168bfbd6b3160a2e276d7/website/docs/user-guide/bot-mode.md?plain=1#L362-L368)).
- **Messaging gateways.** Sessions are keyed per source, for example `agent:main:telegram:dm:<chat_id>` ([sessions.md](https://github.com/NousResearch/hermes-agent/blob/59cb994b2e5a4eed07e168bfbd6b3160a2e276d7/website/docs/user-guide/sessions.md?plain=1#L1037-L1050)). Unlike OpenClaw's default, these are not collapsed into one.
- **Skills from experience.** The agent's `skill_manage` tool is "the agent's **procedural memory**". The system prompt asks it to record a non-trivial workflow as a skill ([skills.md](https://github.com/NousResearch/hermes-agent/blob/59cb994b2e5a4eed07e168bfbd6b3160a2e276d7/website/docs/user-guide/features/skills.md?plain=1#L606-L620)). A curator moves unused agent-created skills "through `active → stale → archived`" and "never auto-deletes" ([curator.md](https://github.com/NousResearch/hermes-agent/blob/59cb994b2e5a4eed07e168bfbd6b3160a2e276d7/website/docs/user-guide/features/curator.md?plain=1#L9-L11)).

### 1.5 Letta (open source harness and cloud)

- **One agent, many conversations.** "One agent can have many conversations, and every conversation uses the same agent identity and long-term memory". On when to start a new one: "There is no correct answer. Many users tend to have a single, very long main thread… All Letta conversations can be of infinite length, and a long thread alone is not a reason to restart" ([Conversations](https://docs.letta.com/concepts/conversations#when-to-start-a-new-conversation)).
- **Memory** is MemFS, a git repository. "Files at the memory root are loaded into the agent's system prompt on every turn". Directories with their own `MEMORY.md` "stay out of context until they are needed" ([MemFS](https://docs.letta.com/concepts/memfs#memory-structure)). [§4.1](agent-identity-and-where-agents-run.md#41-letta) covered the rule that memory edits take effect at the next prompt compilation.
- **A turn that leaves memory alone.** `stateless: true` runs a session that "does not load or change the agent's memory" ([Sessions](https://docs.letta.com/agent-sdk/sessions)).
- **Channels.** Telegram, WhatsApp, Slack, Discord, Signal and custom channels reach the same agent ([llms.txt](https://docs.letta.com/llms.txt)). How channels map to conversations wasn't read.

### 1.6 Claude Code and Claude Projects (Anthropic)

- **Claude Code** has no always-on agent record. Its nearest pieces were covered in the identity note ([§3.3](agent-identity-and-where-agents-run.md#33-claude-code-in-the-cloud)) and the away note ([§1.3](agents-that-work-while-the-person-is-away.md#13-anthropic-claude-code-and-the-claude-apps)): scheduled tasks, Remote Control, auto memory. Inside a session, Claude can wake itself. A self-paced `/loop` uses the `ScheduleWakeup` tool, and `CronCreate` schedules a session-scoped task ([scheduled tasks](https://code.claude.com/docs/en/scheduled-tasks#manage-session-scoped-scheduled-tasks)). ACP's v2 background-work RFD lists both tools as work that "start[s] new turns later" ([background-work.mdx](https://github.com/agentclientprotocol/agent-client-protocol/blob/8fed1ac366e0e2f7e3f3264019780392fb36b12c/docs/rfds/v2/background-work.mdx?plain=1#L24-L35)).
- **Claude Projects** (public beta) is the closest Anthropic shape. It is "one coordinating conversation with Claude plus the threads it starts". The project conversation is "one long-running session where Claude acts as coordinator… It sees what threads report back, not every step they take". Each thread is "a separate session with its own context window" that "reports back to the conversation when it finishes" ([Projects](https://code.claude.com/docs/en/claude-projects)). Scheduled tasks created from a project "run as threads in that project". Project memory was covered in §3.3. Context is in 2.5.

### 1.7 Devin

Covered in [§2.3](agent-identity-and-where-agents-run.md#23-devin): a memory drive (a git repository of Markdown with a `MEMORY.md` index) whose "new memories apply to future sessions", and long-lived sessions that automations message ("Message session"). The away note added sleep after 30 minutes idle and resumption for 14 days ([§1.5](agents-that-work-while-the-person-is-away.md#15-devin)). Nothing new was read.

### 1.8 Feature matrix

"—" means not documented or not read.

| | Name and identity | Computer | Memory: what, loaded when, who edits | Conversations | Channels | Wakes without the person | Inbox, attention | Unattended approvals | Skills | Background work comes back |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Grok Bot | Named Bot with a job and picture | One persistent cloud computer shared by the person's Bots | Preferences, rules, facts, dated work log; the Bot saves unasked; person edits by asking | One per Bot, resettable with memory kept; threads for side feedback; group chats | App, Slack DM (reply lands in app), X `@bot`, email | Routines: schedules, events, webhooks | Needs attention vs unread | Expire after ~30 min | Saved from chat; one library for all Bots | Cloud Agent results attached to the Bot's reply |
| dots | Named dot with a handle | Cloud computer plus one personal computer | ChatGPT memory plus the dot's own notes; dot edits | One dot, a distinct conversation per channel; tasks have their own | ChatGPT, Slack, Teams, calls, texts (beta) | Self-chosen wake-ups, schedules, events | Activity, Scheduled view | Wait | — | Background agents report to the dot |
| OpenClaw | Agent with `IDENTITY.md`, `SOUL.md` | Gateway host; placed workers | `MEMORY.md`, `USER.md` at session start; daily notes searched; agent writes; dreaming promotes | One main session (`agent:main:main`) by default; others isolated by setting | Every DM channel into the main session by default | Automation jobs in main, isolated, current or named sessions; standing intents | — | Isolated runs are "explicitly unattended" | Workspace skills | Sub-agents announce to the starter; jobs announce to a chat |
| Hermes Bot Mode | Bot = profile, avatar, title | The machine owning the profile | `MEMORY.md` 2,200 chars, `USER.md` 1,375, frozen at session start; agent writes; background review every 10 prompts | One forever Bot Chat plus ordinary sessions | Gateway per platform, keyed per chat | Cron routines into Bot Chat; `/heartbeat` per session | Unread state in roster | — | Agent-created via `skill_manage`; curator | `bot-chat` delivery is a full turn in Bot Chat |
| Letta | Agent with id and persona | Any connected computer | MemFS git repo; root files every turn; agent writes; dreaming | Many per agent, "infinite length" | Telegram, WhatsApp, Slack, Discord, Signal | Schedules (not read) | — | — | Agent-owned skills | Subagents (not read) |
| Claude Projects | A project | Anthropic cloud, or the person's computer per thread | Project instructions and memory files | One coordinating conversation plus threads | Claude apps | Scheduled tasks as threads | Overview, Waiting on you | Per thread's mode | Account skills, plugins | Threads report back to the conversation |
| Devin | Sessions; a persistent session as monitor | VM per session | Memory drive (git, `MEMORY.md`); later sessions | Session per task; messageable long sessions | Slack, Linear, GitHub | Automations: start or message a session | Inbox, push | Sleep, resumable 14 days | — | Child sessions |
| weave today | None above the thread | The Host's computer | `CLAUDE.md`/`AGENTS.md` in the thread's directory; the agent's own auto memory | Threads; nothing designates one as current | Clients only (single-user) | None yet (triggers planned: WVE-145, WVE-146) | "Needs you" from `activity` | Thread's policy and agent mode | The agent's own | Reports to the thread whose agent began the turn |

The difference from an ordinary thread is not the loop. Every product above runs the same model loop in its long-lived conversation as in any other. The difference is a record above conversations (name, memory, triggers), one conversation that everything is routed into, and a policy that keeps that conversation usable for weeks.

## 2. Context over weeks

### 2.1 OpenClaw

- **Default: never reset, compact in place.** "No automatic reset (default `mode: "none"`) - sessions keep the same `sessionId`; compaction manages the active context as the conversation grows" ([session.md](https://github.com/openclaw/openclaw/blob/9ee3261087083810b4697ce21d54bee10b135cc5/docs/concepts/session.md?plain=1#L255-L305)). This was already the default at `969d4e53`.
- **Opt-in resets.**
  - Daily (`atHour`, default 4) and idle (`idleMinutes`) resets, "whichever expires first wins", overridable by type (`direct`, `group`, `thread`) and by channel, plus manual `/new` and `/reset`.
  - "The message that triggers an automatic reset continues in the new conversation". Heartbeat, cron and exec turns "do not extend daily or idle reset freshness".
  - A reset discards "queued system-event notices for the old session… so stale background updates are not prepended" (same lines).
  - "Reset assigns a new live session id but keeps the previous SQLite transcript searchable under the same main-session key" ([main-session.md](https://github.com/openclaw/openclaw/blob/9ee3261087083810b4697ce21d54bee10b135cc5/docs/concepts/main-session.md?plain=1#L99-L118)).
- **Memory files and when they load** ([memory.md](https://github.com/openclaw/openclaw/blob/9ee3261087083810b4697ce21d54bee10b135cc5/docs/concepts/memory.md?plain=1#L18-L71)).
  - `USER.md` and `MEMORY.md` are "Loaded at the start of a session".
  - Daily notes `memory/YYYY-MM-DD.md` are indexed for search but "not injected into the bootstrap prompt on every turn". "Today's and yesterday's dated notes load automatically on a bare `/new` or `/reset`".
  - `DREAMS.md` holds the dreaming diary.
  - When `MEMORY.md` outgrows the bootstrap budget, the injected copy is truncated ([agent-workspace.md](https://github.com/openclaw/openclaw/blob/9ee3261087083810b4697ce21d54bee10b135cc5/docs/concepts/agent-workspace.md?plain=1#L145): 20,000 characters per file, 60,000 in total).
- **On reset.** The bundled `session-memory` hook "Saves the ended session's recent user/assistant text on `/new`, `/reset`… or automatic daily/idle rollover" to `memory/YYYY-MM-DD-HHMM.md`, 15 messages by default ([bundled-hooks.md](https://github.com/openclaw/openclaw/blob/9ee3261087083810b4697ce21d54bee10b135cc5/docs/automation/hooks/bundled-hooks.md?plain=1#L116-L127)).
- **Compaction** ([compaction.md](https://github.com/openclaw/openclaw/blob/9ee3261087083810b4697ce21d54bee10b135cc5/docs/concepts/compaction.md?plain=1#L11-L23)).
  - Older turns are summarised into one entry and recent messages are kept. "The full conversation history stays on disk. Compaction only changes what the model sees on the next turn".
  - Auto-compaction is on by default and starts "at the smaller of 75% of the active window and the window minus its compaction reserve" ([L79-L88](https://github.com/openclaw/openclaw/blob/9ee3261087083810b4697ce21d54bee10b135cc5/docs/concepts/compaction.md?plain=1#L79-L88)).
  - `/compact <focus>` forces it. A running turn gets 60 seconds to finish before it is cancelled ([L156-L168](https://github.com/openclaw/openclaw/blob/9ee3261087083810b4697ce21d54bee10b135cc5/docs/concepts/compaction.md?plain=1#L156-L168)).
- **Memory flush before compaction.** "Before compaction summarizes your conversation, OpenClaw runs a silent turn that reminds the agent to save important context to durable memory". It is on by default ([memory.md L275-L330](https://github.com/openclaw/openclaw/blob/9ee3261087083810b4697ce21d54bee10b135cc5/docs/concepts/memory.md?plain=1#L275-L330)).
  - It "uses a private copy of the conversation, so its housekeeping messages never appear in later user turns".
  - Its `write` "appends only to the daily note", and replayed whole notes are rejected.
  - A failed flush doesn't prevent compaction.
  - Flush turns disable provider-side compaction so the flush "sees the unsummarized history" ([compaction.md L394](https://github.com/openclaw/openclaw/blob/9ee3261087083810b4697ce21d54bee10b135cc5/docs/concepts/compaction.md?plain=1#L394)).
- **Not for agents that compact themselves.** "Native Codex and Claude CLI keep their own compaction policies" ([L88](https://github.com/openclaw/openclaw/blob/9ee3261087083810b4697ce21d54bee10b135cc5/docs/concepts/compaction.md?plain=1#L88)).
  - For `claude-cli`, "Claude Code compacts internally", so OpenClaw's automatic compaction "defers to Claude Code". An explicit `/compact` "sends its native `/compact` command", and OpenClaw passes its budget through `CLAUDE_CODE_AUTO_COMPACT_WINDOW` ([cli-backends.md](https://github.com/openclaw/openclaw/blob/9ee3261087083810b4697ce21d54bee10b135cc5/docs/gateway/cli-backends.md?plain=1#L738-L766)).
  - Stored CLI sessions are "provider-owned continuity" ([L523](https://github.com/openclaw/openclaw/blob/9ee3261087083810b4697ce21d54bee10b135cc5/docs/gateway/cli-backends.md?plain=1#L523)).
  - "The flush never runs for CLI-backend sessions such as `claude-cli/*`, or for backends that compact natively. For those sessions, the prompt's 'before your final reply' save is the only capture point" ([memory-provider.md](https://github.com/openclaw/openclaw/blob/9ee3261087083810b4697ce21d54bee10b135cc5/docs/plugins/knowledge/memory-provider.md?plain=1#L186-L188); stated for the Knowledge provider).
- **Pruning tool results.** Session pruning "trims **old tool results**" without rewriting conversation text ([session-pruning.md](https://github.com/openclaw/openclaw/blob/9ee3261087083810b4697ce21d54bee10b135cc5/docs/concepts/session-pruning.md?plain=1#L9-L16)). It is opt-in (`mode: "cache-ttl"`).
- **Dreaming.** A scheduled sweep "promotes only qualified owner or agent-derived items into long-term memory (`MEMORY.md`)" and writes a reviewable diary to `DREAMS.md`. It is on by default ([memory.md L331-L357](https://github.com/openclaw/openclaw/blob/9ee3261087083810b4697ce21d54bee10b135cc5/docs/concepts/memory.md?plain=1#L331-L357)). "The default heartbeat prompt performs no memory maintenance on its own" ([L61-L63](https://github.com/openclaw/openclaw/blob/9ee3261087083810b4697ce21d54bee10b135cc5/docs/concepts/memory.md?plain=1#L61-L63)).
- **Search over old sessions.**
  - `sessions_search` searches user and assistant text in past sessions and hands back keys for `sessions_history` to reopen, "including retained history from before a session reset". At most 25 hits, with 300-unit excerpts ([session-search.md](https://github.com/openclaw/openclaw/blob/9ee3261087083810b4697ce21d54bee10b135cc5/docs/concepts/session-search.md?plain=1#L11-L48)).
  - `memory_search` is hybrid vector and keyword search over memory files, and over transcripts when session indexing is on ([memory.md L205-L235](https://github.com/openclaw/openclaw/blob/9ee3261087083810b4697ce21d54bee10b135cc5/docs/concepts/memory.md?plain=1#L205-L235)).
  - Optional "remember across conversations" retrieves from the agent's other private sessions ([session.md](https://github.com/openclaw/openclaw/blob/9ee3261087083810b4697ce21d54bee10b135cc5/docs/concepts/session.md?plain=1#L234-L253)).
- **Where scheduled work runs.** A job's session is one of four ([payloads.md](https://github.com/openclaw/openclaw/blob/9ee3261087083810b4697ce21d54bee10b135cc5/docs/automation/cron-jobs/payloads.md?plain=1#L482-L489)):
  - `main`: "Owning agent's main session".
  - `isolated`: "Dedicated `cron:<jobId>`", with "A new transcript/session id per run" ([L513](https://github.com/openclaw/openclaw/blob/9ee3261087083810b4697ce21d54bee10b135cc5/docs/automation/cron-jobs/payloads.md?plain=1#L513)).
  - `current`: a child run that reads "a bounded tail" of the creating conversation.
  - `session:<id>`: a persistent named session.
  - Agent-turn jobs default to the creating conversation, and callers without one fall back to `isolated`.
  - To come back to a conversation later, the agent adds "a one-shot `at` job… `sessionTarget: "session:<your session key>"`" ([L501](https://github.com/openclaw/openclaw/blob/9ee3261087083810b4697ce21d54bee10b135cc5/docs/automation/cron-jobs/payloads.md?plain=1#L501)).
  - Isolated runs are "explicitly unattended": the final reply "must be the deliverable", and nothing to report returns `NO_REPLY` ([L519](https://github.com/openclaw/openclaw/blob/9ee3261087083810b4697ce21d54bee10b135cc5/docs/automation/cron-jobs/payloads.md?plain=1#L519)).
- **How isolated results come back.**
  - With `announce`, "OpenClaw writes one assistant message into that chat's transcript so the next reply can use it as context". "The private run transcript and tool history are not copied" ([delivery.md](https://github.com/openclaw/openclaw/blob/9ee3261087083810b4697ce21d54bee10b135cc5/docs/automation/cron-jobs/delivery.md?plain=1#L37-L49)).
  - Writing the result does not start a turn: "A result committed to the conversation does not itself resume the original agent" ([payloads.md L497](https://github.com/openclaw/openclaw/blob/9ee3261087083810b4697ce21d54bee10b135cc5/docs/automation/cron-jobs/payloads.md?plain=1#L497)).

### 2.2 Hermes Agent

- **No time-based resets in core.** "Gateway conversations do not reset after inactivity or at a daily boundary. Use `/new` or `/reset`… context compression remains automatic". Legacy `session_reset` settings are ignored, with a warning. A catalog plugin restores them ([sessions.md](https://github.com/NousResearch/hermes-agent/blob/59cb994b2e5a4eed07e168bfbd6b3160a2e276d7/website/docs/user-guide/sessions.md?plain=1#L1076-L1095)). A gateway restart "is **not** a boundary — the same session resumes" ([L1124-L1141](https://github.com/NousResearch/hermes-agent/blob/59cb994b2e5a4eed07e168bfbd6b3160a2e276d7/website/docs/user-guide/sessions.md?plain=1#L1124-L1141)).
- **But the docs argue for boundaries.** "Because gateway conversations never expire on their own, it is easy to run one session for weeks. That works, but it quietly defeats the learning loop and inflates costs" ([L1097-L1121](https://github.com/NousResearch/hermes-agent/blob/59cb994b2e5a4eed07e168bfbd6b3160a2e276d7/website/docs/user-guide/sessions.md?plain=1#L1097-L1121)).
  - "**Memory only pays off at boundaries.**" Memory is injected at session start, and in a never-ending session "the agent has no reason to consult memory".
  - "A fresh session with distilled memory is almost always cheaper than a month-old thread".
  - The advice is "end a session when you finish a task or topic", and to ask the agent to "remember anything worth keeping" before resetting.
  - "Before reset, the agent saves memories and skills from the expiring session" ([L1194](https://github.com/NousResearch/hermes-agent/blob/59cb994b2e5a4eed07e168bfbd6b3160a2e276d7/website/docs/user-guide/sessions.md?plain=1#L1194)).
- **Memory is frozen at session start.** "The system prompt injection is captured once at session start and never changes mid-session… to preserve the LLM's prefix cache" ([memory.md](https://github.com/NousResearch/hermes-agent/blob/59cb994b2e5a4eed07e168bfbd6b3160a2e276d7/website/docs/user-guide/features/memory.md?plain=1#L57-L65)).
  - Stores are bounded: `MEMORY.md` 2,200 characters and `USER.md` 1,375 ([L182-L183](https://github.com/NousResearch/hermes-agent/blob/59cb994b2e5a4eed07e168bfbd6b3160a2e276d7/website/docs/user-guide/features/memory.md?plain=1#L176-L200)). A write over the limit fails until the agent frees room in the same batch.
  - "Don't point two agent processes at the same Hermes home directory" ([L23](https://github.com/NousResearch/hermes-agent/blob/59cb994b2e5a4eed07e168bfbd6b3160a2e276d7/website/docs/user-guide/features/memory.md?plain=1#L23)).
- **Memory nudges.** "Every 10 user prompts → a forked review agent looks at the conversation and decides whether anything should be saved to memory", and every 10 tool iterations in one turn for skills ([codex-app-server-runtime.md](https://github.com/NousResearch/hermes-agent/blob/59cb994b2e5a4eed07e168bfbd6b3160a2e276d7/website/docs/user-guide/features/codex-app-server-runtime.md?plain=1#L250-L253)). The review is a fork that reuses the warm prompt cache, and it reports `💾 Memory updated` in chat ([memory.md L364-L375](https://github.com/NousResearch/hermes-agent/blob/59cb994b2e5a4eed07e168bfbd6b3160a2e276d7/website/docs/user-guide/features/memory.md?plain=1#L364-L375)). The intervals are `memory.nudge_interval` and `skills.creation_nudge_interval`.
- **Compression** ([configuration.md](https://github.com/NousResearch/hermes-agent/blob/59cb994b2e5a4eed07e168bfbd6b3160a2e276d7/website/docs/user-guide/configuration.md?plain=1#L1035-L1110)).
  - It is a separate summariser call that fires at `threshold: 0.50` of the context limit, with an optional absolute `threshold_tokens`. A "lean" tail keeps 10–25K tokens, plus "session_search recovery pointers in the summary".
  - `protect_first_n: 3` pins the opening exchange "so the original goal stays visible". For "long-running rolling-compaction sessions" the docs suggest 0.
  - `in_place` (default `true`) compacts "without rotating the session id", and soft-archives the pre-compaction turns, "still searchable via `session_search`". With `false`, each compaction makes a new session linked to its parent, titled `name #2`, `#3` ([sessions.md L337-L345](https://github.com/NousResearch/hermes-agent/blob/59cb994b2e5a4eed07e168bfbd6b3160a2e276d7/website/docs/user-guide/sessions.md?plain=1#L337-L345) still describes this as the behaviour).
  - `idle_compact_after_seconds` (opt-in) compacts a session that resumes after a long idle spell, "so a long-lived thread… doesn't re-read its full stale context".
  - `proactive_prune_tokens` (opt-in) prunes old tool results without a model call.
- **Search over the past.** `session_search` runs SQLite FTS5 "across all past conversations… It makes no LLM calls and returns views of actual messages" ([sessions.md L954-L1033](https://github.com/NousResearch/hermes-agent/blob/59cb994b2e5a4eed07e168bfbd6b3160a2e276d7/website/docs/user-guide/sessions.md?plain=1#L954-L1033)). It offers discovery, scroll around a message, read a session, and browse. The agent is told to use it "before asking them to repeat themselves".
  - Auto-pruning of ended sessions is off by default (90 days when on), and active sessions are never pruned ([L1195](https://github.com/NousResearch/hermes-agent/blob/59cb994b2e5a4eed07e168bfbd6b3160a2e276d7/website/docs/user-guide/sessions.md?plain=1#L1189-L1250)).
- **Heartbeats in the conversation.** `/heartbeat every 10m <prompt>` gives "the **current session** one recurring instruction", fired "as a normal user turn — same conversation, same context, same prompt cache" ([heartbeat.md](https://github.com/NousResearch/hermes-agent/blob/59cb994b2e5a4eed07e168bfbd6b3160a2e276d7/website/docs/user-guide/features/heartbeat.md?plain=1#L9-L28)).
  - It is idle-only, "Missed ticks coalesce", user messages win, and its state "follows context-compression session rotations" ([L44-L53](https://github.com/NousResearch/hermes-agent/blob/59cb994b2e5a4eed07e168bfbd6b3160a2e276d7/website/docs/user-guide/features/heartbeat.md?plain=1#L44-L53)).
  - A turn that ends with `NO_REPLY` sends nothing, and the injected prompt tells the agent not to invent work.
  - The page contrasts it with cron, which runs "A fresh isolated session per tick".
- **Cron.** The gateway "ticks the scheduler every 60 seconds, running any due jobs in isolated agent sessions" ([cron.md L423](https://github.com/NousResearch/hermes-agent/blob/59cb994b2e5a4eed07e168bfbd6b3160a2e276d7/website/docs/user-guide/features/cron.md?plain=1#L421-L437)).
  - Results go to `origin`, local files, a platform, or `bot-chat` (1.4) ([L645-L700](https://github.com/NousResearch/hermes-agent/blob/59cb994b2e5a4eed07e168bfbd6b3160a2e276d7/website/docs/user-guide/features/cron.md?plain=1#L645-L700)).
  - By default a delivery "does not live in the chat's conversation history". Opt-in **continuable** jobs mirror it as "a labelled user turn (`[Cron delivery: <task name>]`)" so a reply has context ([L791-L840](https://github.com/NousResearch/hermes-agent/blob/59cb994b2e5a4eed07e168bfbd6b3160a2e276d7/website/docs/user-guide/features/cron.md?plain=1#L791-L840)).
  - Scheduled runs can't manage cron unless `cron.allow_agent_scheduling: true` ([L43](https://github.com/NousResearch/hermes-agent/blob/59cb994b2e5a4eed07e168bfbd6b3160a2e276d7/website/docs/user-guide/features/cron.md?plain=1#L43), [L384-L420](https://github.com/NousResearch/hermes-agent/blob/59cb994b2e5a4eed07e168bfbd6b3160a2e276d7/website/docs/user-guide/features/cron.md?plain=1#L384-L420)).

### 2.3 Letta

- **Compaction is automatic and conversations don't need restarting.** "As it approaches the model's context limit, compaction happens automatically: Letta summarizes older messages while keeping recent messages in the active context". "A compaction summary can omit exact wording or provenance. The message history remains available, and the agent can use conversation search to recover relevant earlier context" ([Conversations](https://docs.letta.com/concepts/conversations#conversation-context-and-agent-memory)).
- **Durable knowledge lives outside the conversation.** "Long-term knowledge belongs to the agent's MemFS memory, not one conversation" (same section). Root memory files are in the system prompt every turn (1.5).
- **Sleep-time work.** "Dreaming uses background subagents to review recent conversations, consolidate useful lessons, and update memory without interrupting your active work" ([Memory & dreaming](https://docs.letta.com/configuration/memory#dreaming)). Its trigger is `"step-count"`, `"compaction-event"` or `"off"`. Its behaviour is either to "remind the agent to update memory" or to "launch a background dreaming subagent" ([SDK memory](https://docs.letta.com/agent-sdk/memory#dreaming)). Dreaming subagents edit memory in git worktrees "without blocking the main agent" ([MemFS](https://docs.letta.com/concepts/memfs)).
- **Terminology.** The current docs say memory blocks, MemFS and conversation search. The MemGPT-era "core, recall and archival memory" don't appear in the current documentation index ([llms.txt](https://docs.letta.com/llms.txt)), and whether the server API still has an archival store wasn't checked.

### 2.4 Grok Bot and dots

- **Grok Bot.** One conversation per Bot. Memory keeps "summaries from its work… without replaying every prior message", and a reset keeps memory (1.1). Whether the conversation is compacted, summarised or truncated as it grows isn't documented. Cross-conversation search exists, though "Search availability can vary during rollout" ([Find prior work](https://docs.x.ai/grok-bot/chat-and-collaboration#find-prior-work)).
- **dots.** Context is "a selection" of conversation, memory, notes and tool results, and the dot can search past ChatGPT conversations (1.2). How the dot's own conversation is bounded isn't documented.

### 2.5 Claude Code and Claude Projects

- **Auto-compaction.** "Claude Code compacts automatically as you approach the limit, so a full context window doesn't end your session" ([context window](https://code.claude.com/docs/en/context-window#when-your-context-fills-up)).
  - Thresholds depend on the model: at the model's limit by default, at about 967K on native-1M models, at 200K for Sonnet and Opus 4.6 without extended context ([model config](https://code.claude.com/docs/en/model-config#default-auto-compact-thresholds)).
  - `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, `autoCompactWindow`, `--autocompact` and `/autocompact` set the window ([Set the auto-compact window](https://code.claude.com/docs/en/model-config#set-the-auto-compact-window)).
- **Manual.** `/compact <focus>`, partial summaries through `/rewind`, and "`/clear` when switching to unrelated work" (same page).
- **What survives compaction.** Project-root `CLAUDE.md` and unscoped rules are "Re-injected from disk", and so is auto memory ([What survives compaction](https://code.claude.com/docs/en/context-window#what-survives-compaction)).
  - Also re-injected: skill descriptions, a fresh git status, the plan, up to five recently modified files, and invoked skill bodies (5,000 tokens each, 25,000 in all).
  - Background commands and subagents "Keep running".
  - Path-scoped rules and nested `CLAUDE.md` are summarised away and reloaded on demand. `SessionStart` hooks matching `compact` run again.
  - A memory file the agent edited before compaction is therefore what the compacted conversation starts from.
- **Idle compaction.** On by default, it compacts a conversation that reached 200,000 tokens after about an hour idle, "before the prompt cache expired" ([idleCompaction](https://code.claude.com/docs/en/settings-reference#idlecompaction)). The conditions list only interactive surfaces: the terminal, the VS Code panel, and the desktop Code tab.
- **Hooks.**
  - `PreCompact` runs before manual or automatic compaction. It can block it, by exit code 2 or `"decision": "block"`. It receives `trigger` and `custom_instructions`, and Claude Code discards its `systemMessage` ([PreCompact](https://code.claude.com/docs/en/hooks#precompact)).
  - `PostCompact` receives `compact_summary`.
  - Neither hook gives the model a turn, so neither is a memory flush.
- **Auto memory.**
  - It lives at `~/.claude/projects/<project>/memory/`, keyed by the git repository, so "all worktrees and subdirectories within the same repo share one auto memory directory". It is machine-local.
  - "The first 200 lines of `MEMORY.md`, or the first 25KB, whichever comes first, are loaded at the start of every conversation". Memory files are excluded from the transcript retention sweep ([memory](https://code.claude.com/docs/en/memory)).
- **Retention and resume.**
  - Transcripts are deleted "once they're older than `cleanupPeriodDays`", 30 days by default ([.claude directory](https://code.claude.com/docs/en/claude-directory#cleaned-up-automatically)). That bounds how long a closed weave thread can be reopened from Claude's own history.
  - A resumed session doesn't restore `--add-dir` directories ([sessions](https://code.claude.com/docs/en/sessions#what-a-resumed-session-restores)).
- **Claude Projects' coordinator.** "You don't manage context windows in a project. Threads compact automatically, and the conversation works from recent messages, recent threads, and project memory rather than its full history, so it keeps going for as long as the project runs. Put anything that must never be dropped in project memory" ([Projects](https://code.claude.com/docs/en/claude-projects#choose-models-and-let-claude-manage-context)).
  - A thread that runs out of context may say it "continues in a fresh session, it carries on by itself". Otherwise the person asks the coordinator for a new thread ([Other messages](https://code.claude.com/docs/en/claude-projects#other-messages)).
  - A thread idle longer than the one-hour cache "re-reads its whole conversation… For new work, ask Claude to start a fresh thread" ([See and reduce a project's usage](https://code.claude.com/docs/en/claude-projects#see-and-reduce-a-projects-usage)).

### 2.6 Codex

- **Auto-compaction.** `model_auto_compact_token_limit` is the "Token threshold that triggers automatic history compaction (unset uses model defaults)". `compact_prompt` overrides the summary prompt. `PreCompact` and `PostCompact` hooks exist ([config reference](https://learn.chatgpt.com/docs/config-file/config-reference)).
- **Manual.** `/compact` makes Codex "replace earlier turns with a concise summary", and `/clear` and `/new` start a fresh chat ([slash commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli#keep-transcripts-lean-with-compact)).
- **Memories** are off by default. When on, Codex turns "useful context from eligible prior chats into local memory files" under `~/.codex/memories/`, in the background, after "a chat has been idle long enough" ([Memories](https://learn.chatgpt.com/docs/customization/memories)).
- **What survives compaction.** Whether `AGENTS.md` is re-read after compaction isn't documented.

### 2.7 ACP: what a client can see or trigger

- **Context size is stable ACP.** `usage_update` carries `used` ("Tokens currently in context"), `size` ("Total context window size") and an optional cumulative `cost`. The motivation was that clients couldn't "warn users when a session is approaching context limits or suggest compaction" ([session-usage RFD](https://github.com/agentclientprotocol/agent-client-protocol/blob/8fed1ac366e0e2f7e3f3264019780392fb36b12c/docs/rfds/session-usage.mdx?plain=1#L20-L67)). The RFD is Completed ([docs.json](https://github.com/agentclientprotocol/agent-client-protocol/blob/8fed1ac366e0e2f7e3f3264019780392fb36b12c/docs/docs.json#L242-L266)). In the pinned schema crate 1.10.2, `UsageUpdate` is not behind a Cargo feature.
- **Compaction is report-only.** `compaction_update` (`in_progress`, `completed`, `failed`, `cancelled`) and `compaction_summary_chunk` let an agent report a compaction and its "user-displayable summary" at its place in the timeline ([session-compaction RFD](https://github.com/agentclientprotocol/agent-client-protocol/blob/8fed1ac366e0e2f7e3f3264019780392fb36b12c/docs/rfds/session-compaction.mdx?plain=1#L11-L44)). The client opts in with `clientCapabilities.session.compaction` ([L166-L190](https://github.com/agentclientprotocol/agent-client-protocol/blob/8fed1ac366e0e2f7e3f3264019780392fb36b12c/docs/rfds/session-compaction.mdx?plain=1#L166-L190)).
  - The RFD is Completed, and completion "makes compaction available unconditionally and removes the `unstable_session_compaction` Cargo feature" ([L228-L236](https://github.com/agentclientprotocol/agent-client-protocol/blob/8fed1ac366e0e2f7e3f3264019780392fb36b12c/docs/rfds/session-compaction.mdx?plain=1#L224-L240)).
  - Neither the RFD nor the v1 guide ([prompt-turn](https://github.com/agentclientprotocol/agent-client-protocol/blob/8fed1ac366e0e2f7e3f3264019780392fb36b12c/docs/protocol/v1/prompt-turn.mdx?plain=1#L275)) defines a client request to compact, to clear context, or to be warned before a compaction.
- **A client compacts by prompting a slash command.** This is in the adapters' source, not in ACP.
  - `claude-agent-acp` passes `/compact` through to Claude Code ([acp-agent.ts L2214](https://github.com/agentclientprotocol/claude-agent-acp/blob/eb78afa8556b8fc4082495e48e3fd1762fb6a50f/src/acp-agent.ts#L2214)) and reports compactions as `compaction_update` when the client advertises the capability ([context-compaction.ts L47](https://github.com/agentclientprotocol/claude-agent-acp/blob/eb78afa8556b8fc4082495e48e3fd1762fb6a50f/src/context-compaction.ts#L47)). It lists `clear` among unsupported commands ([L13625-L13626](https://github.com/agentclientprotocol/claude-agent-acp/blob/eb78afa8556b8fc4082495e48e3fd1762fb6a50f/src/acp-agent.ts#L13625-L13634)).
  - `codex-acp` maps `/compact` to Codex's compact operation ([thread.rs L3183](https://github.com/zed-industries/codex-acp/blob/296069e841634cd4bb9bc4515602d836e49231ec/src/thread.rs#L3183)) and sends `usage_update` with the model's context window ([L1132](https://github.com/zed-industries/codex-acp/blob/296069e841634cd4bb9bc4515602d836e49231ec/src/thread.rs#L1132)). It reports a compaction only as the agent text "Context compacted" ([L1457](https://github.com/zed-industries/codex-acp/blob/296069e841634cd4bb9bc4515602d836e49231ec/src/thread.rs#L1455-L1457)), not as `compaction_update`.
- **Drafts that would add signals.** End-turn token usage, session status and session archive are Draft at this commit (docs.json above).

### 2.8 Side by side

| | Conversation lifetime by default | Automatic new conversation | Compaction | Memory write before losing context | Reloaded at the boundary | Background consolidation | Search over the past |
| --- | --- | --- | --- | --- | --- | --- | --- |
| OpenClaw | Forever (main session) | Opt-in daily or idle, per type and channel | Built-in at ~75%; defers to Claude Code and Codex | Silent flush turn before compaction (not for CLI backends); transcript tail to a dated note on reset | `MEMORY.md`, `USER.md`; last two daily notes after `/new` | Dreaming into `MEMORY.md` | `sessions_search`, `memory_search` |
| Hermes | Forever on gateways; Bot Chat never resets | None in core (plugin) | At 50%, in place by default; opt-in idle compaction | Background review every 10 prompts; save before reset | Frozen `MEMORY.md`, `USER.md` at session start | Curator for skills | `session_search` (FTS5) |
| Letta | Forever ("infinite length") | None | Automatic near the limit | Dreaming on step count or on compaction | Root MemFS files every turn | Dreaming subagents | Conversation search |
| Grok Bot | One per Bot | None documented; manual reset keeps memory | Not documented | The Bot saves unasked | Not documented | Not documented | Palette search, rolling out |
| dots | Not documented | Not documented | Not documented | The dot keeps notes | Not documented | Proactive research | Past ChatGPT conversations |
| Claude Projects | Coordinator forever | Out-of-context threads may continue in a fresh session | Threads compact; coordinator works from recent messages and memory | Project memory | Project instructions and memory | — | — |
| Claude Code | Session | None | Near the limit; idle compaction (interactive only) | `PreCompact` hook (no model turn) | `CLAUDE.md` and auto memory re-injected after compaction | — | `/resume` picker; 30-day transcripts |
| Codex | Chat | None | Model default or configured limit | `PreCompact` hook | — | Memories from idle chats (opt-in) | `/resume` |

## 3. Patterns

- **One canonical conversation, routed into.** OpenClaw's main session, Hermes's Bot Chat, Grok Bot's conversation, the dot and Claude Projects' coordinator are where triggers, background results and the person's messages converge. Letta leaves the choice to the person, and Hermes keeps ordinary sessions beside the Bot Chat. Only OpenClaw and dots document what happens with several channels, and they differ. OpenClaw collapses DMs into one conversation. Dots keep a visible conversation per channel and share only notes.
- **The canonical conversation is kept alive by compaction, not rotation.** OpenClaw ("no automatic reset" by default), Hermes (no time resets, `/new` turned into `/compact` in Bot Chat), Letta ("a long thread alone is not a reason to restart") and Claude Projects all compact in place. Rotation is opt-in (OpenClaw's daily and idle resets) or manual (`/new`, Grok's reset).
- **But boundaries are where memory works.** Hermes argues it plainly: memory is injected at session start, so a never-ending session never consults it and costs more every turn. Claude Code narrows the gap, since compaction re-injects `CLAUDE.md` and auto memory from disk, so compaction acts as a soft boundary for memory files. Hermes freezes memory for the prompt cache, so its compaction doesn't do that.
- **Write memory before context is lost.** There are four places to do it:
  - Before compaction, as a silent flush turn (OpenClaw).
  - Before a reset, by saving memories or the transcript tail (Hermes, OpenClaw's `session-memory` hook).
  - Periodically, as a review fork every N prompts (Hermes) or a dreaming trigger on step count or compaction (Letta).
  - Unprompted, whenever the agent judges something worth keeping (Grok Bot, dots, Claude auto memory).
  - OpenClaw cannot flush for agents that compact themselves, which is weave's situation (2.1).
- **Two tiers of memory, bounded.** A small always-loaded tier (`MEMORY.md` capped at 200 lines in Claude Code, 2,200 characters in Hermes, a bootstrap budget in OpenClaw, root files in Letta), and a larger tier read on demand (daily notes, topic files, MemFS directories). Promotion from the second to the first is a background job: OpenClaw's dreaming, Letta's dreaming, Devin's dreaming session.
- **Heartbeats either share the conversation or don't.** In-conversation, idle-only, coalescing heartbeats: Hermes `/heartbeat`, OpenClaw's Proactive check in the main session. Isolated runs report back instead: OpenClaw `isolated` with announce, Hermes cron with `bot-chat`, Claude Projects threads, dots' background agents. They report back in one of two ways:
  - **As a turn**: Hermes `bot-chat` ("one full agent turn"), Projects threads reporting to the coordinator, weave's reports.
  - **As a transcript entry without a turn**: OpenClaw's announce ("does not itself resume the original agent"), Hermes continuable jobs.
- **Quiet turns.** Scheduled checks with nothing to say end with `NO_REPLY` and deliver nothing (OpenClaw, Hermes).
- **Search over old conversations is a tool the agent calls**, not something loaded automatically: OpenClaw `sessions_search`, Hermes `session_search`, Letta conversation search, dots' search of past conversations. Hermes's compaction summary carries "recovery pointers" into it.
- **Tool output is pruned separately from compaction**: OpenClaw session pruning, Hermes proactive prune.

## 4. Fit for weave

Judged against weave at `e7db435a` and the Dispatcher as decided on 2026-11-02 ([ADR 0027](../adr/0027-the-dispatcher-starts-work-on-the-persons-hosts-as-a-client-of-them.md), proposed). Facts about weave are cited. Everything marked **Recommendation** is a judgement.

### 4.1 Where weave stands

- **Weave owns no loop** ([ADR 0011](../adr/0011-the-host-stays-the-runtime-authority.md)). Compaction, memory loading and auto memory are the agent's. This is OpenClaw's `claude-cli` position, where OpenClaw defers compaction and its flush never runs (2.1).
- **Context size.**
  - The Host journals every ACP update, `usage_update` among them, but doesn't count it as activity ([journal.rs](../../host/src/journal.rs#L242-L262)). The TUI reads `used` and `size` from it ([chat.rs](../../tui/src/chat.rs#L2298)).
  - `SessionListing`, which `sessions/list`, `sessions/get` and `sessions/watch` return, has no context fields ([spec](../specs/wve-85-host-protocol.md#L389-L405)).
  - An observing attach sees the updates live, but only for an open thread ([L492-L497](../specs/wve-85-host-protocol.md#L492-L497)).
- **Compaction updates.** Weave advertises compaction by default (`compaction = false` withholds it, [config.rs](../../agents/src/config.rs#L158-L159)), and pins `agent-client-protocol` 3.0.0 with `unstable_session_compaction` ([Cargo.toml](../../Cargo.toml#L22)), the feature ACP's completion removes.
- **Continuing a thread.** `session/run` with `sessionId` opens a thread and starts a turn in it, under a request key ([spec](../specs/wve-85-host-protocol.md#L677-L700)). `queue/add` and `turn/steer` prompt an open one.
- **Reports.** Reports go only to the thread "whose agent began" a turn. "Turns a client sends are reported to nobody" ([L969-L977](../specs/wve-85-host-protocol.md#L969-L977)). A Dispatcher is a client, so nothing reports its runs to a resident's thread for it.
- **Reading old threads.** `sessions/get` and `read_session` return one turn, with `message` holding its last agent message ([L414-L443](../specs/wve-85-host-protocol.md#L414-L443)). Nothing reads or searches a whole closed thread without opening it.
- **Retention.** Journals untouched for 14 days are pruned, never an open session's ([host/AGENTS.md](../../host/AGENTS.md#L19)), and request keys go with them ([spec](../specs/wve-85-host-protocol.md#L809)).

| Mechanism | Products | Weave primitive today | Dispatcher composes it? | Missing |
| --- | --- | --- | --- | --- |
| Named record above threads | All | None | Yes, as its SQLite record | — |
| One current thread, routed into | OpenClaw, Hermes, Grok, dots, Projects | Thread, queue, request keys | Yes: `queue/add` into the record's current thread | Thread labels (planned); a successor link (4.3) |
| Compaction in place | All | The agent's own; `compaction_update` journaled | Can prompt `/compact` where the thread advertises it | ACP has no compact request; codex-acp reports no `compaction_update` |
| Context-size signal | ACP `usage_update` | Journaled; not in listings | Only by observing each open thread | `context: {used, size}` in `SessionListing` and `sessions/watch` (Host) |
| Memory flush before losing context | OpenClaw, Hermes | Prompting a thread | Yes, for planned rotation or a planned `/compact` | No hook before the agent's own auto-compaction (agents, ACP) |
| Memory files reloaded | All | `CLAUDE.md`/`AGENTS.md` in the thread's directory | Home is the thread's `cwd` | — |
| Rotation to a new thread | OpenClaw resets, Grok reset, Hermes `/new` | `session/run` without `sessionId` | Yes | Reports and attached clients stay on the old thread (4.3) |
| In-thread heartbeat | Hermes, OpenClaw | `queue/add` with a key | Yes | Trigger origin (planned); quiet turns |
| Isolated run reporting back | OpenClaw, Hermes, Projects, dots | Delegation reports, for agent-started turns only | Yes, by relaying the result itself | A trigger origin that says "result of run X" |
| Search over old threads | OpenClaw, Hermes, Letta, dots | `read_session` (one turn) | No | Longer retention for labelled threads; a Host read and search method and tool |
| Self-scheduled wake-ups | dots, Claude Code, OpenClaw `at` jobs | — | Yes, with Dispatcher tools via the Host MCP server | — |
| Skills from experience | Hermes, Grok | The agent's own skills | — | Nothing weave needs to own |
| Channels | OpenClaw, Hermes, Grok, dots | Deferred | — | See 4.6 |

### 4.2 Deciding when to start a new thread

- **Signals the Dispatcher could use.** It can count days (daily rotation) and idle time from `lastActivityAt` in `sessions/watch`. It can count compactions and context size only from journal events: `usage_update` and `compaction_update`.
- **"Compaction no longer frees enough"** can be read as `used/size` from the first `usage_update` after a `completed` `compaction_update`. If even right after compacting the thread starts above some fraction, rotate.
  - For Claude Code this works now, since claude-agent-acp sends both.
  - For Codex, codex-acp sends `usage_update` but marks compaction only in agent text (2.7), so the Dispatcher would see usage drop without a compaction event. It could infer a compaction from a drop in `used`, which is a guess.
- **What products do.** None of them rotates on that signal. OpenClaw and Hermes rotate on time or by hand. Letta and Hermes's Bot Chat never rotate. Claude Projects' threads "continue in a fresh session" when out of context, without a published rule (2.5).
- **Recommendation.**
  - Add the latest `usage_update` to the Host's session summary: `SessionListing.context: {used, size}`, sent in `sessions/updated` when it changes beyond a step, and journaled as today.
  - Add the time and post-compaction `used` of the last completed `compaction_update`.
  - That makes the signal one watch for the Dispatcher instead of an observing attach per resident, and the app can show it too. It reads only ACP-defined fields, so it doesn't branch on the agent.
- **Recommendation.** Default to OpenClaw's and Letta's policy:
  - No automatic rotation, compaction in place, and a per-resident option for daily rotation at an hour.
  - Rotation when post-compaction usage stays high.
  - The person's manual "new thread".
  - Hermes's argument for boundaries is a reason to offer daily rotation, not to default to it. With Claude Code, memory files are re-injected after compaction anyway (2.5).

### 4.3 A memory flush, then rotation

- **Composable today.** The Dispatcher can do it in four steps:
  1. `queue/add` a flush prompt ("write what's worth keeping to your memory files and commit") into the current thread under a request key.
  2. Wait for that turn's `turnEnded` by turn id ([spec](../specs/wve-85-host-protocol.md#L700-L706)).
  3. `session/run` a new thread in the home with an opening prompt that names the previous thread.
  4. Record the new thread as current.
  - With Claude Code the same flush can precede a `/compact` prompt instead of a rotation, and the compacted context then re-reads the memory files the flush wrote.
- **Risks.** Each is a fact about weave today, with the gap it leaves:
  - **Reports go to the old thread.** A delegated turn the old thread's agent began reports to the old thread when it ends, taking it up again if it's closed ([spec](../specs/wve-85-host-protocol.md#L969-L977)). A rotation in the middle of delegated work splits the conversation.
    - **Recommendation**: rotate only when `list_sessions` shows none of the old thread's delegated threads running, or give the Host a successor link (below).
  - **Clients stay on the old thread.** A TUI pane attached to the old thread stays there. WVE-168's question of following into a continuation has the same shape (away note [§7.4](agents-that-work-while-the-person-is-away.md#74-wve-168-following-into-a-continuation)).
    - **Recommendation**: a Host field on a thread naming its successor (`continuedIn`), set by whoever rotates it. Clients offer to follow it, and reports to a thread that has a successor go to the successor. It is generic, not resident-specific.
  - **Racing triggers.** A trigger that arrives during the flush would queue in the old thread. The Dispatcher owns its triggers' queue (decided), so it holds them until the new thread exists.
  - **Two writers on the home.** If the new thread starts before the flush turn ends, two agent processes edit the memory files at once ([§10.4](agent-identity-and-where-agents-run.md#104-wve-118-always-on-agents)). Waiting for `turnEnded` avoids it. A git home lets the flush commit, so a bad write can be reverted.
  - **A flush can't precede the agent's own auto-compaction.** ACP and both adapters give no warning before it (2.7), and Claude Code's `PreCompact` hook can't give the model a turn (2.5). OpenClaw has the same gap with these agents.
    - **Recommendation**: keep the residents' agents' own threshold above the Dispatcher's. For Claude Code that means `CLAUDE_CODE_AUTO_COMPACT_WINDOW` in `[agents.<id>] env`, as OpenClaw does. The Dispatcher then reaches its threshold first and runs flush-then-`/compact` itself.
    - It finds `/compact` among the thread's ACP `available_commands_update` commands rather than by knowing the agent.
    - Without that, rely on Hermes's and Grok's approach: the agent writes memory as it goes, prompted by the memory files' own instructions.
  - **Cost.** A flush is a full turn over the whole context. Hermes runs its review as a fork that reuses the prompt cache. Weave can't fork a turn, so the flush should run before the cache goes cold. That is under an hour for Claude, as both Projects and idle compaction note.

### 4.4 Heartbeats, and isolated runs that report back

- **In-thread heartbeats are composable now.**
  - A schedule `queue/add`s into the current thread under the key "trigger + scheduled time".
  - **Recommendation**: copy Hermes's rules. Idle-only, so the Dispatcher skips an occurrence while `activity` isn't idle and the person's messages win. Missed ticks coalesce. One heartbeat at most waiting per thread, which matches the away note's `BufferOne` ([§7.1](agents-that-work-while-the-person-is-away.md#71-wve-145-schedules)).
  - Each heartbeat costs a turn and context in the canonical thread. OpenClaw and Hermes both suppress delivery of `NO_REPLY`.
  - **Recommendation**: the planned trigger origin is enough for clients to fold quiet heartbeat turns away. No Host notion of silence is needed.
- **Isolated runs.**
  - The Dispatcher can `session/run` a new thread per occurrence, but nothing reports it back, since a client's turns are reported to nobody (4.1). The Dispatcher can relay the result itself: wait for `turnEnded`, read `LatestTurn.message`, and `queue/add` it into the resident's current thread. That is Hermes's `bot-chat` delivery, one full turn.
  - The alternative is to prompt the resident's thread to `start_session` the work, so the Host's report comes back. That costs a turn in the canonical thread before and after.
  - **Recommendation**: the Dispatcher relays. The relayed prompt's origin is the trigger origin with the run's thread and turn, so clients link to the run as they link reports.
- **No transcript entry without a turn.** OpenClaw writes the result into the transcript without starting a turn (2.1). ACP gives a client no way to add to an agent's context without a prompt, so in weave every delivery to a resident is a turn.
- **Recommendation: choose per trigger.** Heartbeats that need the conversation's context run in the thread. Self-contained jobs run isolated and are relayed only when the result needs the resident's attention, decided by the job's own prompt ("reply `NO_REPLY` if nothing changed", which the Dispatcher can recognise in `message`). That is the split Hermes draws between `/heartbeat` and cron.

### 4.5 Search over past threads

- **What a resident loses today.**
  - A rotated thread's journal is pruned 14 days after it was last touched. A thread reopened from Claude's own history is gone after 30 days (2.5).
  - Agents can read a thread's last turn, not search them. `rename_session`, `list_sessions` and `read_session` are the only Host tools that look back ([spec](../specs/wve-85-host-protocol.md#L919-L945)).
- **What products give the agent.** A search tool over transcripts that returns excerpts and keys to reopen (OpenClaw, Hermes), with bounds on hits and excerpt size.
- **Recommendation, cheapest first.**
  1. Make rotation write a dated note into the home's `memory/` (OpenClaw's `session-memory` hook), so `grep` over a git home finds old work with no Host change.
  2. Exempt labelled threads from journal pruning. The labels are already planned, and the Dispatcher labels the threads it rotates.
  3. Add a Host method and tool to read a range of a thread's journal, open or not, and later to search journals by text (`search_sessions`, Hermes-shaped: no model calls, excerpts, a key to read more). That needs an index the Host doesn't have.
  - The Dispatcher can't do any of the Host steps itself, since journals are the Host's.

### 4.6 Channels (deferred)

Weave stays single-user, and channels are deferred until dogfooded (2026-10-22). For the record, channels would need:

- An adapter per platform at the edge.
- A rule mapping a sender to a resident.
- The OpenClaw-versus-dots choice: one conversation for all channels, or a conversation per channel with shared memory files.
- Where a reply goes (Grok Bot answers a Slack DM "in the app chat, not Slack").
- Isolation once anyone but the person can write. OpenClaw says ownership "is not a security boundary" ([§4.2](agent-identity-and-where-agents-run.md#42-openclaw)), and Hermes's group sessions are per user by default.

Nothing here argues for building them.

### 4.7 Names

What the products call this thing: **Bot** (Grok Bot, Hermes Bot Mode), **dot** (OpenAI), **agent** with a main session called **Home** (OpenClaw), **agent** (Letta), **profile** (Hermes's underlying record), **project** (Claude), **teammate** (Lindy, Grok's own description). Letta's docs use "resident" once, as an adjective: "a resident engineering teammate" ([SDK memory](https://docs.letta.com/agent-sdk/memory)). OpenClaw uses it only for resident memory in RAM.

| Candidate | Elsewhere | Conflicts in `CONTEXT.md` | Fit |
| --- | --- | --- | --- |
| Bot | Grok Bot and Hermes Bot Mode, for exactly this record | None; colloquially also chat-platform bots and X's `@bot` | Now the most common word for this record. The identity note's objection, Hermes's messaging accounts, no longer holds, since Hermes uses it for this record too |
| Aide | None surveyed | None | Says it works for the person; short; reads well ("the aide's thread") |
| Steward | None surveyed | None | Suggests owning an area (a repository, an inbox), which matches the advice to give each one "a clear job" |
| Familiar | None surveyed | None | Personal and lives with the person; whimsical |
| Persona | OpenClaw's "per-persona scope"; elsewhere the instruction layer | None | The identity note's fallback; suggests a prompt, not a record with triggers |
| Companion | Consumer chat products | None | Suggests chat, not work |
| Resident | Adjective only (Letta, OpenClaw) | None; reads like resident memory or a resident process | Disliked by the person |
| Agent, Thread, Trigger, Holder, Host, Profile | — | Taken in `CONTEXT.md`, or by Zed, Delta and Copilot presets ([§10.4](agent-identity-and-where-agents-run.md#104-wve-118-always-on-agents)) | Avoid |

**Recommendation.** "Bot" if weave should use the word the two closest products use. "Steward" or "Aide" if it wants its own. Whichever is chosen, its canonical thread needs a name too: OpenClaw says Home and Hermes says Bot Chat. "Its current thread" works without a new term.

### 4.8 Can the Dispatcher handle all of it?

Mostly, with four Host additions and two limits it can't remove.

- **The Dispatcher alone:**
  - The record, with name, Host, agent, policy, home and current thread.
  - Schedules, webhooks, heartbeats and self-scheduled wake-ups through its own MCP tools.
  - Idle-only, coalescing delivery into the current thread.
  - Isolated runs with relayed results.
  - Flush-then-compact and flush-then-rotate.
  - Holding triggers during a rotation.
  - Daily and idle rotation policies.
- **Host additions (Recommendation):**
  - Thread labels and a trigger origin (both planned).
  - Context usage and the last compaction in `SessionListing` and `sessions/watch` (4.2).
  - A successor link that clients follow and reports honour (4.3).
  - Retention exemption for labelled threads, and a journal read and search method and tool (4.5).
- **Limits outside weave:**
  - ACP can't request a compaction or warn before one. Prompting `/compact` is an adapter convention.
  - codex-acp reports compaction as text.
  - No ACP client can add context without a turn.
  - Each limit is a candidate for an ACP RFD or an adapter change, not something weave can add.

## 5. Open questions

- **Grok Bot and dots context handling.** Whether either compacts, summarises or truncates its long-lived conversation, and when. Neither documents it.
- **Codex after compaction.** Whether Codex re-reads `AGENTS.md` after a compaction, as Claude Code re-injects `CLAUDE.md`. Not documented on the pages read.
- **Idle compaction under ACP.** Whether Claude Code's idle compaction runs under the Agent SDK that claude-agent-acp uses. Its conditions name only interactive surfaces.
- **Prompting `/compact` while a turn runs.** How claude-agent-acp and codex-acp treat a `/compact` prompt queued behind a running turn. The source shows they pass it on, and weave's queue would start it only after the turn ends, but neither path was run.
- **Codex compaction events.** Whether a newer codex-acp sends `compaction_update`. `296069e8` doesn't.
- **Claude's transcript age.** Whether `cleanupPeriodDays` ages a transcript from its last write or its creation. The docs say "older than".
- **Hermes compaction docs.** `in_place` defaults to `true`, but `sessions.md` still describes session rotation on compression as the behaviour. Which is current in code wasn't checked.
- **Hermes approvals in unattended cron runs** weren't read.
- **Letta archival memory.** Whether the Letta server still offers it, and how Letta's channels map to conversations.
- **OpenClaw's flush for CLI backends.** The "flush never runs" statement is on the Knowledge provider's page. Whether `memory-core` behaves the same for `claude-cli` sessions is implied by "Native Codex and Claude CLI keep their own compaction policies", not stated.
- **Claude Projects.** How the coordinator "works from recent messages, recent threads, and project memory" is not described further.
- **Secondary sources.** Search results included third-party posts on Codex auto-compaction defaults. None is cited, and nothing here rests on them.
