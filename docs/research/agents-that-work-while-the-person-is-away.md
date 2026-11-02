# Agents that work while the person is away

Research snapshot, 2026-11-02. Primary sources only: vendor documentation, help centres, changelogs and release notes, vendor blogs, specifications and man pages, all read on 2026-11-02. Nothing was installed, built or run. Two help centres refuse direct fetches with HTTP 403. help.openai.com and openai.com articles were read through a reader proxy that returns the page's own text, and they are cited here by their original URLs. help.x.com could not be read at all, so nothing here about the public `@grok` account on X rests on X's documentation (1.1). `launchd.plist(5)` was read from the man page installed with macOS on Darwin 27.2.0. Vendor pages carry no version unless one is quoted. Where a vendor gives a date, version or status (preview, beta, GA), it is given here too. Sections 1–6 are facts and their sources. Section 7 judges them against weave at `4ca31276` (WVE-144), and section 8 lists what the sources didn't settle.

This note follows [the identity note](agent-identity-and-where-agents-run.md), a snapshot of 2026-10-22. That note covered what an agent is in these products, what persists, where it runs and who it acts as. It doesn't cover how the work done while the person is away is started, timed, reported and picked up, which is this note's subject. Where a product appears in both notes, this one cites the earlier section instead of repeating it. Changes since 2026-10-22, or things that note didn't look at:

- **OpenAI dots** gained texting (beta, 2026-10-28): a dot "will also text you proactively", and asks for approval by sending "a link to review the request in ChatGPT" (1.2). This updates [§4.4](agent-identity-and-where-agents-run.md#44-openai-dots).
- **ChatGPT Pulse is gone.** It was sunset on 2026-06-17 "as proactive updates move into scheduled tasks". ChatGPT's "Tasks" are now **Scheduled tasks**, and Codex's "automations" are the same Scheduled tasks inside the ChatGPT desktop app (1.2).
- **Claude Code has three schedulers.** Cloud scheduled tasks are the former routines that [§3.3](agent-identity-and-where-agents-run.md#33-claude-code-in-the-cloud) mentioned. Desktop scheduled tasks run locally and catch up once after sleep. `/loop` runs inside a session. Remote Control now sends mobile pushes (1.3).
- **xAI ships two away-work products the identity note didn't cover.** Grok **Automations** are scheduled conversations in the Grok app (2026-07-16). **Grok Bot** is a persistent agent with routines, event and webhook triggers, an `@bot` handle on X, and approvals that expire (1.1).
- **Cursor stopped pushing turn-finished notifications** in the week of 2026-08-31 and now pushes only questions and approvals. Cursor Automations add schedules, events and webhooks to [§3.1](agent-identity-and-where-agents-run.md#31-cursor-cloud-agents) (1.4).
- **GitHub Copilot cloud agent gained Automations** (2026-06-02), GitHub Mobile Live Notifications, and Assisted permissions (GA 2026-10-26) (1.6).
- **Google Jules is winding down**: read-only after 2026-11-11, closed on 2026-12-31 (1.7).

## 1. What each product does while the person is away

### 1.1 xAI: Grok Automations, Grok Bot, Grok Build, and `@grok`

xAI now has three products that work without the person, each with its own name. None of their pages is labelled beta.

**Grok Automations** (shipped; [announcement, 2026-07-16](https://x.ai/news/grok-automations)), in the Grok app on grok.com, iOS and Android.

- **Starting.** The person describes the job once, adds files, connectors and skills, picks a mode, and saves. Grok in a chat can also set one up, for example "check the news every morning and flag anything about pricing". Schedules run "once, daily, weekdays, weekly, monthly, or yearly" at a time in the person's time zone. Email triggers run "when an incoming email matches your filters (sender, recipient, or subject)", with that email as context.
- **Telling the person.** Each automation chooses "email, app notification, both, or neither if you'd rather check in yourself".
- **Picking it up.** Grok "opens a real conversation, does the work, and saves the result to its run history", and the person can continue that conversation.
- **Plans.** Scheduled automations are open to all users; "email triggers are included with SuperGrok".
- **Not documented:** limits, missed or failed runs, and what a notification says.
- **Earlier name.** A "Tasks" feature on grok.com appears only in secondary sources from 2025. Whether Automations renamed it is unverified.

**Grok Bot** (shipped; launch date not stated): a persistent agent on "a persistent cloud computer with a browser, filesystem, and terminal" ([overview](https://docs.x.ai/grok-bot/overview)). It is the product closest to WVE-118. The [FAQ](https://docs.x.ai/grok-bot/faq) says "Closing the app, laptop, or phone does not stop a background turn or routine". It also says, unexpectedly, that "Grok Bot signs in with your Cursor account" and that its usage "is metered on your Cursor account, not on Grok or X".

- **Routines** ([Skills, routines and automations](https://docs.x.ai/grok-bot/skills-routines-and-automations)):
  - The person asks in plain words ("every weekday at 8:00 AM", "every 2 hours"). Schedules "must be at least five minutes apart" and use the time zone in **Settings**, where "**Auto-detect** follows this computer". "A new routine waits for its next scheduled time; it doesn't run when it's created."
  - Events come from Slack, GitHub, Linear, Sentry, PagerDuty, email to the Bot, and webhooks. "Only new activity counts: events from before the trigger existed don't start a run."
  - Webhook senders authenticate with `Authorization: Bearer <key>`, not a signature. "A `200` response means Grok Bot accepted the call and started a run, not that the Bot has finished."
  - A Bot owns at most 50 routines, and the app keeps "the 20 most recent run records for each routine", each **Running**, **Succeeded** or **Failed**.
  - Routines run at most 300 times an hour together and 200 times each. A run over a limit "fails with `Automation run rate limit exceeded`" and "isn't retried automatically".
  - "Grok Bot may ask whether to keep routines running after a long period away and pause them if there is no response."
  - Overlapping runs and missed runs aren't described. [Troubleshooting](https://docs.x.ai/grok-bot/troubleshooting) asks for a bug report when a routine that isn't paused "hasn't run for 24 hours or more" with no error.
- **Notifications** ([settings and notifications](https://docs.x.ai/grok-bot/settings-and-notifications#control-notifications)):
  - A per-Bot switch sends "a system or mobile notification when that Bot finishes or is waiting for you".
  - While the desktop app runs on macOS or Windows, notifications go to the desktop. "When a Bot needs your input, your phone is notified about 3 minutes later" unless the person opens that Bot first, and "Finished replies skip your phone". "A focused window stays quiet only for the Bot on screen."
  - The sidebar separates **Needs attention** (a question, approval or handoff) from **Unread activity** (a new result), and "opening a conversation marks its current activity as read" ([attention states](https://docs.x.ai/grok-bot/settings-and-notifications#understand-attention-states)).
  - What a notification says, and what tapping it opens, aren't documented.
- **Approvals while nobody is there.**
  - Cards offer Allow once, Always allow or Deny. An "Auto Review" model checks shell commands, app calls, computer use, changes to routines and triggers, and launches of other agents ([security](https://docs.x.ai/grok-bot/security)).
  - An approval from unattended work, such as a routine, "expires after about 30 minutes. The card then shows **Expired**, and the action doesn't run" ([troubleshooting](https://docs.x.ai/grok-bot/troubleshooting)). Approvals in a chat the person is part of wait for them.
  - xAI's design post says Bots "bring the user in when a decision requires judgment", and the person can take over the Bot's computer and hand it back ([Designing Grok Bot, 2026-09-03](https://x.ai/news/designing-grok-bot)).
- **`@bot` on X** ([Tag on X](https://docs.x.ai/grok-bot/tag-on-x)) is xAI's documented model of an always-reachable agent started by a public event.
  - Tagging `@bot` in a post hands the post to the person's own Bot as a task. The Bot receives the post, the post it replies to, and posts either quotes, including still images.
  - The public reply is only "a short confirmation". "Progress and results stay in that Bot's conversation in the Grok Bot app."
  - It stays quiet when the post has a video, also tags `@grok`, or fails moderation. It isn't offered to accounts in Australia, the UK, the EU, Iceland, Liechtenstein or Norway.

**Grok Build**, xAI's terminal coding agent (shipped).

- `/loop <interval> <prompt>` runs a prompt on a schedule, with a minimum interval of 60 seconds. "Loops expire after 7 days, and at most 50 scheduled tasks can be active at once" ([background tasks](https://docs.x.ai/build/features/background-tasks)).
- Prompts sent during a running turn "are queued, not dropped".
- `/goal` (2026-06-22) runs until a task "is completed and verified", with status, pause, resume and clear ([Introducing /goal](https://x.ai/news/introducing-goal)).

**The public `@grok` account on X: unverified.** X documents it at [help.x.com/en/using-x/about-grok](https://help.x.com/en/using-x/about-grok), but every fetch returned HTTP 403. Only secondary sources describe how a mention starts a reply, what context it reads, and its limits, so nothing here rests on them. xAI's own documented counterpart is `@bot`, above.

**The xAI API** has no callbacks.

- Deferred chat completions return a `request_id` to poll; the result can be fetched "exactly once within 24 hours" ([deferred completions](https://docs.x.ai/developers/advanced-api-usage/deferred-chat-completions)).
- The Batch API is polled until nothing is pending ([Batch API](https://docs.x.ai/developers/advanced-api-usage/batch-api)).
- The only webhooks are those that trigger Grok Bot routines.

### 1.2 OpenAI: dots, Scheduled tasks, Pulse, agent mode, Codex

**Dots** (shipped, rolling out; this updates [§4.4](agent-identity-and-where-agents-run.md#44-openai-dots)):

- **Waking itself.** A dot "can decide when to pause and wake up to continue, so you don't need to put every follow-up on a fixed schedule" ([Tasks and memory § Assigned work](https://learn.chatgpt.com/docs/dots/tasks-and-memory)). Fixed timing needs a saved schedule, which records "When it should run, including the time zone and any end date", "Which changes deserve a notification" and "Where to deliver results". The person reviews recurring work in the **Scheduled** view or asks the dot to list, change or cancel it.
- **Events.** "Connecting Slack or another source alone doesn't create a monitoring task. Ask it to confirm which events it can follow" (same page, Event monitoring). The dot pages don't say whether it polls. ChatGPT itself takes events by webhook: "ChatGPT supports webhook delivery from the draft MCP Events specification; polling and streaming aren't supported" ([What's new, 2026-09-28 to 10-02](https://learn.chatgpt.com/docs/whats-new/september-28-october-2-2026)).
- **Where it tells the person.** The person directs it, for example "keep routine progress in ChatGPT and bring decisions to you in Slack" ([Meet dots](https://learn.chatgpt.com/docs/dots)). "Scheduled runs and proactive updates appear in the conversation" ([Getting started with your dot](https://help.openai.com/en/articles/20001530-getting-started-with-your-dot)). The desktop profile's **Activity** lets the person "open a task to inspect its progress, files, results, or requests for input".
- **Texting** (beta, 2026-10-28, US Pro, iMessage or RCS):
  - "Your dot will also text you proactively with updates" ([release notes](https://help.openai.com/en/articles/6825453-chatgpt-release-notes)).
  - "If your dot needs approval, it sends you a link to review the request in ChatGPT", and "your dot uses context from your conversations to choose where to reach you" ([What's new, 2026-10-28](https://learn.chatgpt.com/docs/whats-new/dots-october-28-2026); [Channels § Texting](https://learn.chatgpt.com/docs/dots/channels#texting)).
  - Texts go through a third-party provider and are "not end-to-end encrypted" ([Getting started](https://help.openai.com/en/articles/20001530-getting-started-with-your-dot)).
  - An earlier mobile release "Fixed extra phone notifications while you're already using ChatGPT" ([What's new, 2026-10-09](https://learn.chatgpt.com/docs/whats-new/dots-october-9-2026)).
- **Approvals.**
  - Action review sorts each action into proceeding, "needs your approval", or a step the person does themselves ([Controls § How action review works](https://learn.chatgpt.com/docs/dots/controls#how-action-review-works)).
  - Waiting work continues when the person opens the request and responds. Some approvals can be given ahead of time, such as "sending recurring messages", and changing a password or moving money always needs the person ([privacy and safety FAQ](https://help.openai.com/en/articles/20001529-dots-privacy-security-and-safety-faqs)).
  - No timeout or skip rule is documented: work waits.
- **An offline computer.** "An Offline status means the computer is unavailable; it doesn't revoke the connection" ([Computers and apps](https://learn.chatgpt.com/docs/dots/computers-and-apps#connect-your-computer)). What happens to local work queued for an offline computer isn't documented.
- **Pausing.** "Pause stops your dot's current main task. It doesn't stop every delegated task or cancel future scheduled runs" ([Controls § Stop work](https://learn.chatgpt.com/docs/dots/controls#stop-work)).

**Scheduled tasks in ChatGPT** (shipped; formerly "Tasks"; [help article](https://help.openai.com/en/articles/10291617-scheduled-tasks-in-chatgpt) unless noted):

- **History.** Tasks moved into Pulse on 2025-12-17. They came back as Scheduled tasks on 2026-06-17, with a Scheduled page and "monitoring tasks" that notify "only when there is something worth reporting" ([release notes](https://help.openai.com/en/articles/6825453-chatgpt-release-notes)).
- **Two kinds of task** ([Scheduled tasks](https://learn.chatgpt.com/docs/automations)).
  - "Standalone scheduled tasks start a new chat for each scheduled run and report results in **Scheduled**."
  - A task scheduled inside a chat returns to that chat, keeping its context.
- **Limits.** Custom schedules take an RRULE. Active tasks are capped at "3 for Free and Go, 5 for Plus, 10 for Business and Edu, and 15 for Pro and Enterprise". Paid plans can run hourly and at exact times; Free plans run at most daily, in "flexible scheduling windows".
- **Event triggers** (2026-08-25) are webhook-based, for Gmail, Slack and GitHub, "up to 30 times per hour and 720 times per day". Events "may be grouped together", and a task can't have an event trigger and a time schedule both.
- **Telling the person.** Settings offer Push, Email or both, plus SMS for some categories ([Notifications](https://learn.chatgpt.com/docs/notifications)). On desktop, "The **Scheduled** view acts as your inbox", and "an unread indicator shows when a run needs your attention" ([Scheduled tasks](https://learn.chatgpt.com/docs/automations)).
- **Pausing.**
  - "If approval is required, the task pauses until you review it."
  - A task pauses "if it is inactive, requires additional action, or its associated chat is archived or deleted".
  - Retries, and how a failed run is reported, aren't documented.
- **Local runs.** Desktop tasks that use local files need "the machine powered on and the ChatGPT desktop app running". Nothing says what happens to a run missed while the machine was off.
- **Approval mode.** These tasks run with `approval_policy = "never"` where the organisation's policy allows it, and otherwise "fall back to the approval behavior of your selected permission mode". They can run in a worktree, "to isolate scheduled-task changes from unfinished local work", or in the main checkout ([Scheduled tasks § Permissions](https://learn.chatgpt.com/docs/automations)).

**Pulse** (launched as a preview for Pro on 2025-09-25; sunset):

- It did "asynchronous research … overnight", "delivered once a day as visual summaries", and the person could save any card into a chat.
- It was sunset on 2026-06-17: "Pulse is being sunset as proactive updates move into scheduled tasks" ([release notes](https://help.openai.com/en/articles/6825453-chatgpt-release-notes)). The Pulse help article now returns 404.

**ChatGPT agent (agent mode)** (shipped; [help article](https://help.openai.com/en/articles/11752874-chatgpt-agent), undated):

- **Confirmation and takeover.** It "will pause for clarification or confirmation when needed" before high-impact actions. For sign-ins it "will pause and prompt you to take control (… → Take over browser)". After the person hands control back, "in some cases it may need to re-establish the run or prompt you again".
- **Repeating a task.** A finished task can be repeated "daily, weekly, or monthly". Each scheduled run counts toward a monthly allowance (Plus 40, Pro 400).
- **Not documented:** what happens when nobody answers a confirmation, and any notification when it finishes. The 2026 release notes put ChatGPT Work forward, which "will always ask for confirmation before consequential actions" (2026-08-25). Whether Work replaces agent mode isn't stated.

**Codex** ([§3.2](agent-identity-and-where-agents-run.md#32-openai-codex-cloud-and-remote-connections) covers where it runs):

- **Scheduled runs.** Automations went GA on 2026-03-12 and are now the Scheduled tasks above. `developers.openai.com/codex/app/automations` redirects to [learn.chatgpt.com/docs/automations](https://learn.chatgpt.com/docs/automations?surface=app). The Codex app merged into the ChatGPT desktop app on 2026-07-09 ([What's new](https://learn.chatgpt.com/docs/whats-new)).
- **Linear.** Assigning an issue or mentioning `@Codex` starts a cloud chat. Progress shows in the issue's Activity, and when done it "posts a summary and a link" ([Linear](https://learn.chatgpt.com/docs/third-party/linear)).
- **Slack.** `@ChatGPT` replaces `@Codex`. A run asks approval through a "private approval card with Allow and Deny" and reports back in the thread ([Slack](https://learn.chatgpt.com/docs/third-party/slack)).
- **GitHub.** `@codex review` and `@codex <task>` ([GitHub](https://learn.chatgpt.com/docs/third-party/github)), and a GitHub Action ([codex-action](https://learn.chatgpt.com/docs/github-action)).
- **Safety pauses.** "Monitoring runs asynchronously and can pause a task… A pause can arrive after the activity that triggered it" ([approvals and security](https://learn.chatgpt.com/docs/agent-approvals-security#safety-monitoring-and-paused-tasks)).

### 1.3 Anthropic: Claude Code and the Claude apps

Claude Code documents three schedulers and compares them in one table ([Desktop scheduled tasks § Compare](https://code.claude.com/docs/en/desktop-scheduled-tasks#compare-scheduling-options)):

| | Cloud | Desktop | `/loop` |
| --- | --- | --- | --- |
| Runs on | Anthropic's cloud | The person's machine | The person's machine |
| Needs the machine on | No | Yes | Yes |
| Needs an open session | No | No | Yes |
| Survives restarts | Yes | Yes | Restored on `--resume`, with exceptions |
| Permission prompts | Auto mode by default | Per task | Inherited from the session |
| Minimum interval | 1 hour | 1 minute when Claude sets it, 1 hour in the forms | 1 minute |

**Cloud scheduled tasks** (research preview; formerly routines; [scheduled tasks](https://code.claude.com/docs/en/routines)). §3.3 covered who these act as. What they do:

- **Triggers.** One task can combine three: "Schedule", "API" and "GitHub". A task with only an API trigger or only a GitHub trigger has no schedule.
- **Schedule** ([§ Add a schedule trigger](https://code.claude.com/docs/en/routines#add-a-schedule-trigger)).
  - Presets are entered in local time. A bare five-field cron is UTC "If the field opens with a `CRON_TZ=` prefix, keep it and write the hours in its zone".
  - Expressions "that run more often than once per hour are rejected".
  - "If you schedule a run exactly on the hour, such as 9:00, it can start several minutes late. To start close to the scheduled time, pick a few minutes past the hour."
  - One-off runs turn the task off afterwards. From the CLI, `/schedule` resolves a phrase such as "tomorrow at 9am" and "confirms the absolute timestamp before saving".
- **API** ([§ Add an API trigger](https://code.claude.com/docs/en/routines#add-an-api-trigger)).
  - Each task has its own endpoint, `/fire`, called with the task's bearer token. "POSTing to the endpoint … starts a new session and returns a session URL."
  - Optional `text` "arrives wrapped in a `<routine-fire-payload>` block that labels it as untrusted data and tells Claude not to follow instructions inside it unless the routine's own prompt says to". So "a routine's saved prompt must opt in to acting on fire text", and "fire text from a leaked token arrive[s] labeled as untrusted data rather than as direct instructions".
- **GitHub** ([§ Add a GitHub trigger](https://code.claude.com/docs/en/routines#add-a-github-trigger)).
  - "Claude Code doesn't reuse sessions across events, so two PR updates produce two independent sessions."
  - Pull request filters cover author, branches, labels, draft and merged.
  - "Events beyond the limit are dropped until the window resets."
- **Limits** ([§ Usage and limits](https://code.claude.com/docs/en/routines#usage-and-limits)).
  - Scheduled runs are capped at 100 an hour per account, and over that cap "The run waits until the limit resets". Run now and API fires instead fail when over their caps.
  - With GitHub disconnected, a task "skips runs until you reconnect, for up to 72 hours", then turns off.
  - While a subscription is paused, its tasks are on hold.
  - No rule for runs missed during an outage, or for overlapping runs, is given.
- **History** ([§ View and interact with runs](https://code.claude.com/docs/en/routines#view-and-interact-with-runs)).
  - Each run opens as a full session that the person can continue.
  - Outcomes "say how the session ended, not whether Claude completed the work your prompt describes".
  - Runs that never started leave a warning beginning "The last run…" with the reason: a concurrency limit, an environment, access, a usage limit ([§ "The last run" warnings](https://code.claude.com/docs/en/routines#the-last-run-didnt-start)).
  - No push or email for a finished run is documented.
- **Permissions** ([§ Permission prompts during a run](https://code.claude.com/docs/en/routines#permission-prompts-during-a-run)).
  - A run starts in auto mode, where "a classifier model allows or blocks actions".
  - Actions matching an ask rule, or blocks past auto mode's thresholds, raise "a permission prompt [that] appears in the run's session and waits until someone answers it".
  - In a Project, "a run can continue a thread rather than start a new session. That run keeps whatever permission mode the thread is in at the time."

**Desktop scheduled tasks** (shipped; Claude Desktop 1.1.5368 or later; [page](https://code.claude.com/docs/en/desktop-scheduled-tasks)). This is the closest analogue to a Host on a laptop.

- **When runs start.** Desktop "checks the schedule every minute while the app is open". "Each task gets a small delay of a few minutes after the scheduled time to stagger API traffic. The delay is deterministic: the same task always starts at the same offset." A Custom cron "is evaluated in your local time".
- **Missed runs** ([§ Missed runs](https://code.claude.com/docs/en/desktop-scheduled-tasks#missed-runs)): "When the app starts or your computer wakes, Desktop checks whether each task missed any runs in the last seven days. If it did, Desktop starts exactly one catch-up run for the most recently missed time and discards anything older. A daily task that missed six days runs once on wake. Desktop shows a notification when a catch-up run starts." The page advises: "A task scheduled for 9am might run at 11pm if your computer was asleep all day. If timing matters, add guardrails to the prompt itself."
- **Overlap.** History shows skipped runs, with the reason: "your computer was asleep, the previous run was still in progress, or other scheduled tasks were already running" ([§ Manage](https://code.claude.com/docs/en/desktop-scheduled-tasks#manage-scheduled-tasks)).
- **Permissions** ([§ Permissions](https://code.claude.com/docs/en/desktop-scheduled-tasks#permissions-for-scheduled-tasks)). In Manual mode a run that needs an unapproved tool "stalls until you approve it". The advice is to "Run now" once and choose "always allow", which carries to later runs and can be revoked per task.
- **Where tasks live.** The prompt is a file, `~/.claude/scheduled-tasks/<task-name>/SKILL.md`, and edits to it "take effect on the next run". "Schedule, folder, model, and enabled state are not in this file."
- **Rescheduling itself.** "A scheduled task can also modify its own schedule or prompt from within a running session using the `update_scheduled_task` MCP tool", for example "rescheduling a code review to run earlier when it detects a release branch has been created."
- **Isolation.** A task can run in its own Git worktree.

**`/loop` and session-scoped tasks** ([scheduled tasks](https://code.claude.com/docs/en/scheduled-tasks)) fire only while the session is open and idle.

- "No catch-up for missed fires": a task due while Claude is busy fires once afterwards.
- Recurring tasks expire after seven days.
- Jitter delays a run by up to half its interval, and at most 30 minutes.

**Cowork scheduled tasks** ([support article](https://support.claude.com/en/articles/13854387-schedule-recurring-tasks-in-claude-cowork)) "run remotely… even when your computer is asleep" for tasks created from 6 October on Pro, Max and Ultra. Tasks that need local files stay local. Missed runs and notifications aren't documented.

**Telling the person.**

- **Remote Control pushes** ([§ Mobile push notifications](https://code.claude.com/docs/en/remote-control#mobile-push-notifications)).
  - "Claude decides when to push. It typically sends one when a long-running task finishes or when it needs a decision from you to continue. You can also request a push in your prompt, for example `notify me when the tests finish`."
  - Beyond two toggles, Push when Claude decides and Push when actions required, "there is no per-event configuration".
  - "Claude Code skips mobile push notifications while you are typing in or focused on the connected terminal." `CLAUDE_CLIENT_PRESENCE_FILE` extends this to "any time you are at the machine": notifications are skipped while the file exists, which a screen-lock listener can create and delete.
- **Waiting questions over Remote Control** ([§ Limitations](https://code.claude.com/docs/en/remote-control#limitations)).
  - "Claude Code keeps permission prompts and `AskUserQuestion` questions open until you answer them."
  - Other forwarded dialogs wait "five minutes by default, then close the dialog and continue with the dialog's no-action default" (`dialogExpiry`).
  - A crashed session in server mode "is served again" when a device sends it a message.
- **Elsewhere.**
  - Desktop shows an OS notification when a session "finishes a task and you aren't currently viewing that session" ([Desktop](https://code.claude.com/docs/en/desktop)).
  - Projects notify on desktop when "a thread hits an error, or a thread needs your input" ([Projects § Overview](https://code.claude.com/docs/en/claude-projects#see-what-needs-you-in-overview)).
  - No push or email is documented for plain cloud sessions. "A session waiting on an MCP approval counts as inactive … and it can expire during that wait" ([cloud sessions](https://code.claude.com/docs/en/claude-code-on-the-web)).
  - The `Notification` hook has matchers for `permission_prompt`, `idle_prompt`, `agent_needs_input` and `agent_completed`, so people wire their own channels ([hooks](https://code.claude.com/docs/en/hooks)).
  - What any of these notifications says isn't documented.

### 1.4 Cursor

§3.1 covered the durable agent record. What's new is how runs start and who hears about them.

- **Automations** ([docs](https://cursor.com/docs/cloud-agent/automations); [changelog, 2026-03-05](https://cursor.com/changelog/03-05-26)). "Automations run on schedules or are triggered by events from Slack, Linear, GitHub, PagerDuty, and webhooks", and since then GitLab, Bitbucket, Sentry and Jira rules too ([release notes, week of 2026-10-12](https://cursor.com/docs/release-notes/cloud-agents)).
  - Schedules take presets or cron. They "may run with a delay but will not start before the indicated time".
  - A webhook trigger is a private URL plus an API key.
  - Runs can open or comment on pull requests and "Send to Slack". "Memories persist across runs" in `MEMORIES.md`.
  - Time zone, minimum interval, missed runs and overlap aren't documented.
- **Other starts.** `@cursor` in Slack and on GitHub pull requests and issues, Linear assignment, and the API ([cloud agents](https://cursor.com/docs/cloud-agent)).
  - **The API.** v1 is in public beta. Its run states are `CREATING, RUNNING, WAITING_FOR_BACKGROUND_WORK, FINISHED, ERROR, CANCELLED, EXPIRED`. A follow-up to a busy agent fails with 409 `agent_busy` unless sent as `delivery: "steer"`, and the event stream resumes with `Last-Event-ID`. v1 webhooks are "coming soon" ([endpoints](https://cursor.com/docs/cloud-agent/api/endpoints)).
  - **v0 status webhooks** carry `statusChange` on `ERROR` or `FINISHED`, signed with `X-Webhook-Signature: sha256=<hex>`, an HMAC-SHA256 of the raw body ([webhooks](https://cursor.com/docs/cloud-agent/api/webhooks)).
- **Telling the person.**
  - "Cloud Agents no longer push a turn-finished notification to your phone or browser… You still get push notifications when an agent asks a question or needs your approval" ([release notes, week of 2026-08-31](https://cursor.com/docs/release-notes/cloud-agents)). The iOS page still promises turn-finished pushes, which is stale ([web and mobile](https://cursor.com/docs/cloud-agent/web-and-mobile)). Live Activities cover up to eight agents.
  - In Slack, "When Cloud Agent completes, you get a notification in Slack", with reactions for running, done and failed ([Slack](https://cursor.com/docs/integrations/slack)).
- **Taking over.** "When you take control of a Cloud Agent's desktop, the agent stops using the computer instead of competing with you" (week of 2026-09-07). This reaches self-hosted machines too (week of 2026-09-21).
- **Not documented:** what happens to an unanswered question.

### 1.5 Devin

§2.3 covered sessions, Triage Devin and "Message session". Since then:

- **Schedules are now Automations.** "Schedules is a legacy feature — new scheduled work is created as an automation" ([scheduled sessions](https://docs.devin.ai/product-guides/scheduled-sessions)). Legacy schedules sent email Always, On failure only (the default) or Never.
- **Automations** ([docs](https://docs.devin.ai/product-guides/automations)).
  - **Triggers.** Slack, GitHub, GitLab, Linear, Jira, Pylon, PagerDuty, Schedule and Webhook, combined with OR.
  - **Schedules.** "Under the hood, schedules use the iCalendar RRULE format." "Each schedule has its own time zone" and keeps local time "across daylight saving changes". Run once disables itself.
  - **Webhooks.** The secret travels in `X-Webhook-Secret`, `Authorization: Bearer`, or `?secret=` ("Prefer a header — query strings are often captured in proxy, CDN, and server access logs"). It isn't an HMAC signature. The payload joins the session prompt, truncated over 200 KB.
  - **Overlap.** By default every matching event starts a run. With queueing on, "Concurrent runs" caps parallel runs, "Queue depth" caps waiting events, and "Events that arrive when the queue is full are dropped". The default rate is "50 runs per hour".
  - **Actions.** Start session, or Message session, which "Sends a message to an existing long-running session".
  - **Reporting.** Email Always, On failure or On success. The Activity tab shows "Whether each invocation succeeded or was skipped".
- **Inbox and push** ([release notes](https://docs.devin.ai/release-notes/overview)).
  - A notification bell and settings for inbox items and phone pushes (2026-10-07), then switches per type, with failure alerts that back off after the 1st, 3rd and 9th consecutive failure (2026-10-09).
  - Answers given in the web app appear in the linked Slack thread (2026-09-09).
  - Devin "resumes promptly after you approve or deny a permission request" (2026-09-23).
- **Sleep** ([usage](https://docs.devin.ai/admin/billing/usage)).
  - A session "sleeps automatically after 30 minutes of inactivity", or after 5 for Lite and API sessions. "While sleeping, Devin does not consume usage", and a message wakes it.
  - Since 2026-10-09 a slept session can be resumed for 14 days, down from 30.
  - In Slack, `sleep`, `archive` and `mute` are commands, and any message in the thread wakes it ([Slack](https://docs.devin.ai/integrations/slack)).
  - The API reports `waiting_for_user` and `waiting_for_approval` ([session API](https://docs.devin.ai/api-reference/v3/sessions/get-organizations-session)).
- **Not documented:** a rule for an unanswered question beyond going to sleep.

### 1.6 GitHub Copilot cloud agent

§2.1 covered identity and attribution. Triggers and reporting:

- **Triggers.**
  - Issue assignment, where Copilot does "not see comments added after assignment", and `@copilot` in pull request comments. "Copilot only responds to comments from people who have write access" ([using the cloud agent](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-cloud-agent-on-github)).
  - Slack and Teams, Jira, and Linear (GA [2026-07-23](https://github.blog/changelog/2026-07-23-copilot-cloud-agent-for-linear-is-now-generally-available/)).
  - A task API in public preview (`POST /agents/repos/{owner}/{repo}/tasks`), with states including `waiting_for_user` and `timed_out`. No completion webhook is documented.
- **Automations** ([changelog, 2026-06-02](https://github.blog/changelog/2026-06-02-schedule-and-automate-tasks-with-copilot-cloud-agent/); [concepts](https://docs.github.com/en/enterprise-cloud@latest/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/about-automations)).
  - Hourly, daily or weekly, plus issue-created and pull-request events.
  - A personal automation is "attributed to the user who created" it.
  - Time zone, missed runs and overlap aren't stated.
- **Telling the person.**
  - When done, Copilot "requests your review", which "triggers a notification".
  - GitHub Mobile Live Notifications track In progress, Completed, Failed and Cancelled ([2026-02-26](https://github.blog/changelog/2026-02-26-github-mobile-track-coding-agent-progress-in-real-time-with-live-notifications/)), and for remote CLI sessions also "Waiting for user input" and Idle ([2026-07-08](https://github.blog/changelog/2026-07-08-github-mobile-live-notifications-for-copilot-cli-sessions/)).
- **Approvals.**
  - Assisted permissions, where "a safety check… decide[s] whether to approve a request or ask you", went GA on [2026-10-26](https://github.blog/changelog/2026-10-26-github-copilot-assisted-permissions-generally-available/).
  - In the connected cloud experience (GA [2026-10-28](https://github.blog/changelog/2026-10-28-work-from-anywhere-with-a-new-connected-copilot-cloud-experience/)), "Copilot asks for approval before any tool call that requires it", and sandboxes snapshot so that a session resumes from any surface.
  - How long an approval waits isn't documented.

### 1.7 Google Jules (winding down)

"Jules will wind down on December 31, 2026", sessions can be finished until 2026-11-11, and after that it is read-only. An export through the `jules` CLI includes `scheduled-tasks.json` ([changelog, 2026-10-29](https://jules.google/docs/changelog/2026-10-29)). What it did is still evidence.

- **Scheduled tasks** (shipped 2025-12-10, [blog](https://blog.google/technology/developers/jules-proactive-updates/); [docs](https://jules.google/docs/scheduled-tasks/)) were daily or weekly. A Scheduled tab showed the last and next run.
- **Triggers.** A GitHub issue labelled "jules" started a task, and Jules posted the pull request link on the issue. On pull requests it reacted with 👀 to each comment it read ([running tasks](https://jules.google/docs/running-tasks/)).
- **Unattended plans.** "If you navigate away, Jules will eventually auto-approve the plan, which is set on a timer… no need to babysit" ([review plan](https://jules.google/docs/review-plan/)). API sessions approve their plans automatically unless `requirePlanApproval` is set. States include `AWAITING_PLAN_APPROVAL` and `AWAITING_USER_FEEDBACK` ([API types](https://jules.google/docs/api/reference/types)).
- **Notifications** were browser-only: "You'll be notified when the task completes or needs your input" ([docs](https://jules.google/docs/)).

### 1.8 Manus

- **Automations.** "Scheduled tasks, available on Manus previously, continue to work in the unified Automations feature" ([Automations](https://manus.im/docs/automations.md)).
  - "Supported GitHub, Shopify, Webhook, and Mail Manus events can be delivered as they happen"; other apps "are checked for new events approximately at intervals".
  - "A trigger can pause after the same failure repeats across several checks", and the remedy is to reauthorise or fix the instructions, then "Test run before resuming it".
  - Scheduled Tasks 2.0 let "scheduled work … stay inside the same task context" ([blog](https://manus.im/en/blog/manus-schedules)).
- **Mail Manus.** "Only emails from pre-approved addresses can trigger Manus tasks"; "Status updates are sent via email", and replying "Cancel" stops a task ([Mail Manus](https://www.manus.im/docs/features/mail-manus)).
- **API v2** ([task lifecycle](https://open.manus.ai/docs/v2/task-lifecycle)).
  - A question is answered with `task.sendMessage`, and an action confirmation with `task.confirmAction`.
  - "Sending any ordinary message while a confirmation is pending skips that action."
  - Webhooks report `task_stopped` with reason `ask` ("Task paused and requires user input or confirmation to continue"), and the receiver must "Respond within 10 seconds" ([webhooks](https://open.manus.ai/docs/v2/webhooks-overview)).
- **Not documented:** push or email for ordinary tasks, and missed runs.

### 1.9 Replit, Lindy, Zapier, Warp

- **Replit Routines** ([docs](https://docs.replit.com/home/routines)).
  - Hourly, daily or weekly, "intervals of one hour or more". "Replit uses your device's time zone when you confirm the schedule."
  - "If other work is running when a Routine is due, the Routine waits", and no second pending run queues.
  - "If Replit needs help or a run fails, it asks for your attention there."
  - The mobile app pushes "Agent needs your help" and "Agent is done working" ([mobile](https://docs.replit.com/features/platforms/mobile-app)).
- **Lindy**, now a Slack-first "teammate".
  - Routines have a trigger, a prompt and a destination: daily, weekly or monthly, or email, Slack, calendar and meeting events. "Personal routines deliver to your default proactive channel", whether Lindy chat, a text or a Slack DM ([routines](https://docs.lindy.ai/teammate/routines.md)).
  - The person chooses "which changes need your approval in shared Slack threads" ([docs](https://docs.lindy.ai/)).
- **Zapier.** Agents became "AI by Zapier", a step in a Zap. "Require approval before running" is now set per tool and pauses the run before that tool ([migration, updated 2026-10-01](https://help.zapier.com/hc/en-us/articles/47402591569805)). How the request reaches the person, and how long it waits, aren't documented.
- **Warp Oz scheduled agents** ([docs](https://docs.warp.dev/platform/triggers/scheduled-agents)).
  - Cloud agents run on five-field cron, with pause, unpause and Run now.
  - "If a scheduled run fails, it does not block future runs", and "Runs execute automatically without human intervention".
  - A run can be forked to the local machine to "pick up where the agent left off" ([viewing runs](https://docs.warp.dev/platform/viewing-cloud-agent-runs/)).

## 2. Side by side

| Product | Started by | Runs where | Missed or overlapping runs | How the person is told | A question with nobody there | Picking it back up |
| --- | --- | --- | --- | --- | --- | --- |
| Grok Automations | Schedule; email filter; chat | xAI's cloud | Not documented | Email, app push, both or neither, per automation | Not documented | Each run is a conversation to continue |
| Grok Bot | Schedule (≥ 5 min); Slack, GitHub, Linear, Sentry, PagerDuty, email; bearer webhook; `@bot` on X | One persistent cloud computer | Not documented; rate-limited runs fail, not retried; routines paused after a long absence | Push on finish or waiting; phone 3 min later if desktop present; finished replies skip the phone | Expires after ~30 min, action not run | Bot conversation; run history of 20 |
| OpenAI dots | Self-chosen wake-ups; saved schedules; event monitoring | OpenAI's cloud computer, plus one personal computer | Not documented | Conversation, Activity, Slack, texts (beta) with a review link | Waits | Activity; the dot's conversation |
| ChatGPT Scheduled tasks | Schedule (RRULE); webhook events (Gmail, Slack, GitHub) | Cloud, or the desktop app for local files | Not documented | Push, email, SMS; Scheduled view as inbox | Pauses until reviewed | New chat per run, or the same chat |
| Claude Code cloud tasks | Schedule (≥ 1 h); `/fire` API; GitHub events | Anthropic's cloud | Waits on rate limit; skips up to 72 h without GitHub | History only | Auto mode; the rest waits | Each run a session; in a Project, the same thread |
| Claude Code Desktop tasks | Schedule; Run now; the task itself | The person's machine | One catch-up for the latest miss in 7 days; skip if previous still running | OS notification, including for a catch-up | Stalls (Manual mode) | Run's session from History |
| Claude Code Remote Control | The person | The person's machine | — | Push decided by Claude or for actions required; skipped while present | Waits; other dialogs time out to no action after 5 min | Same session on any device |
| Cursor | Schedule, events, webhooks; `@cursor`; API | Cursor VM or own machine | Delay but never early; rest not documented | Push for questions and approvals only; Slack | Not documented | Follow-up or steer; take over the desktop |
| Devin | Schedule (RRULE, per-zone); events; webhooks; Slack | Devin's VM or Outposts | All run by default; optional queue with depth, drops when full | Email per outcome; inbox; push; failure backoff 1/3/9 | Sleeps after 30 min idle; resumable for 14 days | Session, Slack thread |
| Copilot cloud agent | Assignment, `@copilot`, Slack/Teams/Jira/Linear, API, Automations | GitHub Actions sandbox | Not documented | Review request; Live Notifications | Assisted check, else asks; wait not documented | Pull request; any surface |
| Jules | Daily or weekly; "jules" label; `@Jules` | Google's cloud | Not documented | Browser notification | Plan auto-approved on a timer | Session, pull request |
| Manus | Schedule; events; webhooks; email | Manus's cloud | Repeated failures pause the trigger | Email for Mail Manus; webhooks | Waits (`ask`); a message skips the action | Same task context |
| Replit Routines | Schedule (≥ 1 h) | Replit | Waits for other work; no second pending | Push for help needed or done | Asks in the chat | Same chat |

## 3. Schedule semantics

| System | Time zone | A run missed while down | Overlap | Delay and jitter | Source |
| --- | --- | --- | --- | --- | --- |
| GitHub Actions `schedule` | UTC; optional IANA `timezone` per entry; spring-forward hours "advance to the next valid time" | No catch-up stated; "can be delayed during periods of high loads… some queued jobs may be dropped" | Not covered by the trigger | "High load times include the start of every hour"; schedule off the hour | [events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule); [syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onschedule) |
| Temporal Schedules | UTC by default, a named zone allowed; "Temporal recommends using UTC" | Taken late if within the Catchup Window, default "one year", minimum 10 s; Backfill for the rest | `Skip` (default), `BufferOne`, `BufferAll`, `CancelOther`, `TerminateOther`, `AllowAll` | Jitter, "bounded by the time until the next scheduled Action"; optional pause on failure | [Schedule](https://docs.temporal.io/schedule#overlap-policy); [missed actions](https://docs.temporal.io/troubleshooting/schedule-missed-actions) |
| Kubernetes CronJob | Controller's local zone, or `.spec.timeZone` (stable since 1.27) | Without `startingDeadlineSeconds`, "no deadline"; with it, later starts are skipped; more than 100 misses and it "does not start the Job" | `Allow` (default), `Forbid` (skip), `Replace` | Two Jobs or none can happen, so Jobs "should be idempotent" | [CronJob](https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/#starting-deadline) |
| systemd timers | A calendar event may name "UTC" or an IANA zone ([systemd.time § Calendar Events](https://www.freedesktop.org/software/systemd/man/latest/systemd.time.html)); timestamps default to the local zone | `Persistent=true` stores the last trigger time; on activation the service runs once at once if it "would have been triggered at least once" while inactive. `OnCalendar=` only, default false | Not covered by the timer page | `RandomizedDelaySec=`, `FixedRandomDelay=`, `AccuracySec=` (default 1 min) | [systemd.timer](https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html#Persistent=) |
| launchd `StartCalendarInterval` | Local time | "Unlike cron which skips job invocations when the computer is asleep, launchd will start the job the next time the computer wakes up. If multiple intervals transpire before the computer is woken, those events will be coalesced into one event" | Not covered by the man page | None | `man 5 launchd.plist` (macOS, Darwin 27.2.0) |
| Cloudflare Cron Triggers | "Cron Triggers execute on UTC time" | Not stated | Not stated | Changes take "up to 15 minutes" to propagate | [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/) |
| Durable Object alarms | Absolute time | "guaranteed at-least-once execution", retried with backoff from 2 s, up to six times | One alarm per object | — | [Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/) |
| n8n Schedule Trigger (2.45.0) | Workflow zone, else the instance's | "Don't Run Missed Executions" (default), "Run the Most Recent Missed Execution", or the same per rule; the durable scheduler records each run before it is due; grace `N8N_SCHEDULER_MISFIRE_GRACE`, 60 s | Not stated | — | [Schedule Trigger](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.scheduletrigger/#node-options); [durable scheduler](https://docs.n8n.io/deploy/host-n8n/configure-n8n/durable-scheduler/) |
| Claude Code Desktop | Local | One catch-up for the latest miss in 7 days, with a notification | Skipped, with the reason shown | Deterministic offset of a few minutes per task | 1.3 |
| Claude Code cloud | Presets local; cron UTC unless `CRON_TZ=` | Not stated; waits on the rate limit | Not stated | On-the-hour runs "several minutes late" | 1.3 |
| Claude Code `/loop` | Session | "No catch-up for missed fires"; one fire after a busy spell | Fires when idle | Up to half the interval, at most 30 min | 1.3 |
| Devin Automations | Per schedule, DST-aware | Not stated | Run all, or a queue with depth that drops when full | — | 1.5 |
| Replit Routines | Device's zone at creation | Not stated | Waits; no second pending run | — | 1.9 |
| Grok Bot routines | Settings, auto-detected | Not stated | Not stated | — | 1.1 |

Three answers to a missed run recur. The first is **skip**: n8n's default, GitHub under load, `/loop`, and a Kubernetes start past its deadline. The second is **one coalesced run for the latest miss**: launchd, systemd's `Persistent=`, Claude Desktop, and n8n's option. The third is **every miss within a window**: Temporal's Catchup Window and Kubernetes without a deadline, capped at 100. The systems that sleep with a laptop all take the second answer: launchd, Claude Desktop, and systemd on a machine that was off. Only Claude Desktop also bounds how far back it looks (seven days) and says so in a notification.

## 4. Webhook semantics

**GitHub** is the sender WVE-146 has to match.

- **Signature.** The `X-Hub-Signature-256` value "always starts with `sha256=`", followed by the hex HMAC-SHA256 "using your webhook's secret token and the payload contents". The payload is handled "as UTF-8" and compared in constant time, "never use a plain `==` operator" ([validating deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)). `X-Hub-Signature` (SHA-1) "is only included for legacy purposes". The page gives a test vector: secret `It's a Secret to Everybody`, payload `Hello, World!`, signature `757107ea…8b043e17`.
- **Headers** ([§ Delivery headers](https://docs.github.com/en/webhooks/webhook-events-and-payloads#delivery-headers)). `X-GitHub-Delivery` is "A globally unique identifier (GUID) to identify the event". The others are `X-GitHub-Event`, `X-GitHub-Hook-ID`, the installation target type and ID, and a `User-Agent` starting `GitHub-Hookshot/`. "Payloads are capped at 25 MB", and above that GitHub delivers nothing ([§ Payload cap](https://docs.github.com/en/webhooks/webhook-events-and-payloads#payload-cap)).
- **Timing and replay** ([best practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks)).
  - "Your server should respond with a 2XX response within 10 seconds", or the delivery counts as failed. The page suggests a queue that processes payloads asynchronously.
  - "To protect against replay attacks, you can use the `X-GitHub-Delivery` header". A redelivery reuses the original value.
  - GitHub's signature covers no timestamp, so the delivery ID is the only replay guard.
- **Redelivery.** "GitHub does not automatically redeliver failed deliveries." "You can redeliver webhook deliveries that occurred in the past 3 days", by hand or through the REST API, by a repository admin, an organisation owner or an app's owner ([redelivering](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks)). The advice is: "If your server goes down, you should redeliver missed webhooks once your server is back up."

**Other schemes:**

| Sender | Authentication | Delivery id and replay | Timeout and retries |
| --- | --- | --- | --- |
| GitHub | HMAC-SHA256 of the body, `sha256=` hex | `X-GitHub-Delivery`, kept on redelivery; no timestamp | 10 s; no automatic retry; manual for 3 days |
| Slack | HMAC-SHA256 of `v0:` + timestamp + `:` + body, in `X-Slack-Signature` | `X-Slack-Request-Timestamp`; reject if more than five minutes off "to protect against replay attacks" ([verifying requests](https://docs.slack.dev/authentication/verifying-requests-from-slack#validating-a-request)) | — |
| Standard Webhooks (spec) | HMAC of `msg_id.timestamp.payload` in `webhook-signature` | "Use the `webhook-id` header as an idempotency key"; check the timestamp against a tolerance | "somewhere between 15 and 30s"; retries "spanning multiple days, with an exponential backoff" and jitter, the example running to about 75 hours ([spec](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md)) |
| Cursor v0 status webhooks | `X-Webhook-Signature: sha256=` HMAC of the raw body | — | Not stated |
| Claude Code `/fire` | Per-task bearer token | Each call starts a new session; payload wrapped as untrusted | 30 fires an hour per task |
| Grok Bot routine webhook | `Authorization: Bearer <key>` | — | `200` means "accepted the call and started a run" |
| Devin webhook trigger | Shared secret in a header or query, no HMAC | — | Payload truncated over 200 KB; queue drops when full |
| Manus API webhooks (outbound) | Separate security page, not read | — | "Respond within 10 seconds" |
| n8n Webhook node | Basic, Header, JWT or n8n user auth; no HMAC documented; optional IP allowlist ([Webhook](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook/)) | — | 16 MB payloads |

The products that take webhooks to start agent runs (Claude, Grok Bot, Devin, Cursor Automations) all use a per-trigger URL with a bearer secret. HMAC signing appears where a platform sends events out: GitHub, Slack, Cursor's status webhooks and Standard Webhooks. Claude Code alone documents treating the payload as untrusted data that the saved prompt must choose to act on.

## 5. Notifications on iOS

Apple's documentation, as it bears on pushes that carry no content (WVE-117):

- **Sensitive data.** "Don't include customer information or any sensitive data… in a notification's payload. If you must include customer information or sensitive data, encrypt it before adding it to the payload. You can use a notification service app extension to decrypt the data on the user's device." Payloads are limited to 4 KB ([Generating a remote notification](https://developer.apple.com/documentation/usernotifications/generating-a-remote-notification)).
- **Notification service extension.** It runs only when the payload has `mutable-content: 1` and "an `alert` dictionary with title, subtitle, or body". It can "Decrypt data sent in an encrypted format" or "Update the notification's content, perhaps by incorporating data from the user's device". It "has only about 30 seconds to modify the payload", and if it calls no completion handler "the system displays the original contents of the notification" ([Modifying content in newly delivered notifications](https://developer.apple.com/documentation/usernotifications/modifying-content-in-newly-delivered-notifications)). The original alert text is therefore what shows when the extension fails.
- **Background (silent) pushes** (`content-available: 1`, `apns-push-type: background`, priority 5) are "low priority… the system doesn't guarantee their delivery", may be throttled, and "don't try to send more than two or three per hour". If the app was force-quit, "the system discards the held notification" ([Pushing background updates](https://developer.apple.com/documentation/usernotifications/pushing-background-updates-to-your-app)).
- **Interruption levels** ([`UNNotificationInterruptionLevel`](https://developer.apple.com/documentation/usernotifications/unnotificationinterruptionlevel)):
  - `passive` "adds the notification to the notification list without lighting up the screen or playing a sound".
  - `active` lights up the screen.
  - `timeSensitive` also "breaks through system notification controls".
  - `critical` "bypasses the mute switch".
  - Time-sensitive delivery needs the Time Sensitive Notifications capability, and critical alerts need an entitlement Apple approves. That rests on Apple's WWDC21 session ([10091](https://developer.apple.com/videos/play/wwdc2021/10091/)), since the entitlement's reference page wasn't found.
- **Grouping and order.** `thread-id` groups related notifications, and `relevance-score` (0 to 1) orders them in the notification summary.

None of the products in section 1 documents what its notifications say. The only content-related rules any of them publishes concern when to push and when not to (section 6).

## 6. Patterns across products

- **Each run is a conversation the person can continue.** Grok Automations, Claude Code cloud and Desktop tasks, ChatGPT Scheduled tasks, Devin and Replit all open a run as a full session. Two ways of placing runs coexist, often in the same product: a new conversation per run, or the same conversation each time. ChatGPT offers standalone or in-chat, Devin Start session or Message session, Claude Code a new session or a Project thread, and Manus "the same task context".
- **The run's record says what happened to the trigger, not just the run.** Skipped runs carry reasons: Claude Desktop names sleep, overlap and concurrency, Devin shows skipped, and Claude cloud's "The last run…" warnings name why a run never started. Claude Code warns that a run's status says "how the session ended, not whether Claude completed the work".
- **Pushes are for questions and approvals.** Cursor removed turn-finished pushes. Grok Bot sends finished replies only to the desktop when it's present. Claude Code lets the agent decide, with a separate "actions required" toggle. Devin, Grok Automations and ChatGPT make delivery a per-task or per-type setting. ChatGPT's monitoring tasks report "only when there is something worth reporting", and dots record "which changes deserve a notification".
- **Presence suppresses or delays pushes.** Claude Code skips pushes while the terminal is focused or a presence file exists. Grok Bot delays the phone by about three minutes while the desktop app runs. OpenAI fixed "extra phone notifications while you're already using ChatGPT".
- **Unanswered approvals in unattended work end in one of three ways.**
  - They wait: Claude Code cloud and Remote Control, ChatGPT tasks and dots, Manus, Claude Desktop in Manual mode.
  - They expire and the action doesn't run: Grok Bot after about 30 minutes, and Claude Code's other forwarded dialogs after 5 minutes with their no-action default.
  - Only Jules expired toward yes, auto-approving a plan, not a tool call.
  - No product found hands a request to the person and then lets a policy approve it after a timeout.
- **A classifier answers first, a person second.** Claude's auto mode, Grok Bot's Auto Review, Copilot's Assisted permissions and dots' action review all approve routine actions and leave the rest for a person. Claude Code and ChatGPT add that a trigger "can't act as approval or consent".
- **Schedules are made in conversation and kept as records.** Grok, ChatGPT, dots, Claude Desktop ("set up a daily code review") and Claude's `/schedule` let the person or the agent create schedules by asking. Claude Desktop also gives a running task an `update_scheduled_task` tool to reschedule itself. Only Claude Desktop keeps part of a task in a file the person can edit, the prompt as `SKILL.md`. The schedule itself is app state everywhere.
- **Absence and failure pause triggers.** Grok Bot pauses routines after a long absence with no answer. ChatGPT pauses inactive tasks. Claude cloud tasks turn off after 72 hours without GitHub. GitHub disables public repositories' schedules after 60 days without activity. Manus pauses after repeated failures, Temporal can pause on a failure, and Devin backs failure alerts off at the 1st, 3rd and 9th.
- **Hourly caps are everywhere, and over a cap a run waits, fails or is dropped.** Claude Code's scheduled runs wait, but its fires fail and excess GitHub events are dropped. Grok Bot's runs fail without retry. Devin drops events when its queue is full.
- **Minimum intervals.** One hour for Claude cloud, Claude Desktop forms and Replit. Five minutes for GitHub Actions and Grok Bot. One minute for in-session loops.

## 7. Fit for weave

Judged against weave at `4ca31276`: ADRs 0011, 0017, 0018, 0023 and 0026, the Host protocol's request keys, interrupted turns and pending requests ([spec](../specs/wve-85-host-protocol.md#request-keys)), and the glossary. Facts are in sections 1–6. What follows are recommendations, each marked as such.

**Constraints.**

- Weave owns no agent loop, so it can't add a classifier of its own. The agent's own mode and the thread's permission policy decide (ADR 0026).
- The Host never reads logins.
- Nothing reaches the Host except through the tailnet.
- Pushes carry no content.
- A Host often runs on a laptop that sleeps, which is Claude Desktop's and launchd's situation, not a cloud scheduler's.

### 7.1 WVE-145: schedules

**Missed occurrences.** The evidence for a Host that sleeps with its computer points one way: launchd, systemd's `Persistent=`, Claude Desktop and n8n's option all run **one** occurrence for the most recent miss and drop the rest. A cloud scheduler's "every miss" (Temporal) fits a service that is meant to be up, not a laptop.

Recommendations:

- At startup or wake, admit one catch-up occurrence for the latest missed time, within a bounded look-back (Claude Desktop uses seven days). Record the older misses as skipped, not run.
- Make it a per-schedule choice, `missed = "latest" | "skip"`. Default to `latest` for a laptop Host, as Claude Desktop does. n8n's default is `skip`, so either default has precedent.
- Key each occurrence on the trigger and its **scheduled** time, not the time it ran. A catch-up and a Host restart during it then admit it once, through the request-key record (`requestKeys`), as WVE-145 plans.
- Tell the agent it is late. Claude Desktop puts the burden on the person's prompt ("A task scheduled for 9am might run at 11pm"). Weave can do better at no cost: put the scheduled time and the actual start in the turn's origin, or in a short preamble the Host adds, so the agent and the transcript see "catch-up for 09:00, started 23:04". Claude Desktop also notifies when a catch-up starts.
- Waking the computer to run a schedule (systemd's `WakeSystem=`) is out of scope for weave. launchd runs the catch-up on wake, which is when the Host notices too.

**Overlap.** Defaults differ: Kubernetes and Devin allow, Temporal skips, Claude Desktop skips, Replit waits without stacking. A schedule that continues a named thread already has an answer in weave's queue, but queuing every occurrence is Temporal's `BufferAll`, which that project warns "should not be treated as an unlimited durable queue". Recommendation: at most one occurrence of a trigger waiting or running per thread (`BufferOne`). An occurrence that finds one already queued is recorded as skipped "previous still running", as Claude Desktop records it. A schedule that opens a new thread per occurrence skips by default too, with "allow" as an option.

**Time zones.** GitHub Actions now takes an IANA `timezone` beside its cron, Kubernetes has `.spec.timeZone`, and Temporal takes a zone name. Devin keeps a zone per schedule and follows DST. Claude Code's cloud cron is UTC unless `CRON_TZ=`, a known source of confusion its docs have to explain. Recommendations:

- Store an explicit IANA zone with every schedule, defaulting to the Host's zone at creation, as Replit does. Show the next run in words, as Grok Bot's **When to run** does.
- Adopt GitHub's documented DST rule for skipped hours (advance to the next valid time). Run a repeated hour once.

**Jitter.** Claude Code's offsets exist to spread API traffic across many users. A single person's Host has no such crowd. Recommendation: no jitter by default. If several schedules land on the same minute, start them in order.

**Minimum interval.** Recommendation: one minute for a local Host (`/loop`, Grok Build), since it pays no one else's capacity. Hourly caps protect the person's own agent subscription, not the Host, and both Claude's and Grok's caps answer an overrun by failing or waiting. A per-trigger hourly cap, with occurrences beyond it recorded as skipped, is cheap insurance against a schedule an agent set badly.

**Pausing on failure.** Recommendation: pause a schedule after N consecutive failed or interrupted occurrences (Manus, Temporal), and pause schedules whose agent's login has expired (Claude cloud's 72-hour rule is the same idea). Through WVE-117, tell the person on the 1st, 3rd and 9th failure, as Devin does.

**Config or Host requests.** Every product surveyed manages schedules as records through its app, and most let the conversation create them. Claude Desktop also gives the running task a tool to reschedule itself, which WVE-118 needs ("can schedule its own wake-ups"). Only Claude Desktop keeps anything in an editable file, and only the prompt. Recommendations:

- Manage schedules through Host requests, offered as the CLI's verbs and as Host tools under the thread's policy (ADR 0026). Keep them in Host state, not `config.toml`. An agent rewriting `config.toml` is a worse surface than a Host tool the policy can see.
- If a static, version-controlled list is wanted, `config.toml` can declare schedules the Host reconciles at startup, but that is a second source of truth to justify later.

**Run history.** Recommendation: list a trigger's occurrences with their outcome, including skipped and why, each linked to its thread and turn. Keep Claude's caveat: an occurrence "succeeded" when its turn ended, which says nothing of whether the work was done.

### 7.2 WVE-146: signed webhooks

- **Match GitHub exactly.**
  - Verify `X-Hub-Signature-256` as `sha256=` plus hex HMAC-SHA256 over the raw body, compared in constant time, and test against GitHub's published vector.
  - Use `X-GitHub-Delivery` as the delivery key. GitHub keeps it on redelivery and its docs name it as the replay guard.
  - Ignore the SHA-1 header.
- **Answer fast, then run.** GitHub fails a delivery after 10 seconds and never retries it by itself. Recommendation: verify, admit through the request-key record, answer 2xx, then start the turn. A `202`, or a `200` that means "accepted, not finished" as Grok Bot documents, is right.
- **Keys outlive redelivery.** GitHub redelivers manually for three days and Standard Webhooks retries for about three. The Host keeps request keys for 14 days, so a redelivery is answered as the first was, which is enough.
- **Replay.** GitHub signs no timestamp. Slack and Standard Webhooks sign one and reject old requests. Recommendation: for GitHub, the delivery key is the replay guard, as GitHub intends. For weave's own senders (scripts, peer services in the tailnet), accept Standard Webhooks' `webhook-id`/`webhook-timestamp`/`webhook-signature` too, which adds timestamp tolerance at little cost. Bearer secrets, which Claude, Grok Bot, Devin and Cursor use for their run triggers, are simpler. They are acceptable only inside the tailnet, and an HMAC never puts the secret on the wire.
- **The payload is untrusted.** Claude Code wraps fire text as `<routine-fire-payload>` "untrusted data" that the saved prompt must opt in to. Recommendation: present the delivery to the agent as a labelled, untrusted block (event type, delivery id, then the body or the fields the trigger selects), with the trigger's own prompt saying what to do with it. Cap its size (Devin truncates at 200 KB) and filter before admitting, so non-matching events start nothing (Claude's pull request filters, Grok's "Only new activity counts").
- **Where the Host takes them.** Every product gives each trigger its own URL. Recommendation: a path per trigger under the Host's existing Serve entry, for tailnet senders. Public senders such as GitHub arrive through the edge (WVE-117), which forwards the signed body and headers untouched, so the Host, not the edge, verifies the signature. Config or Host requests: the same answer as 7.1.

### 7.3 WVE-147: permission requests while a person is attached

The products split three ways (section 6): waiting, expiring to "no", and, for plans only, expiring to "yes".

- **What the products do.** Where a run started without the person, Claude Code keeps the thread's mode (auto mode with a classifier) when the person opens it, and sends the person only what that mode leaves. Grok Bot distinguishes unattended work, whose approvals expire after about 30 minutes and don't run, from chats the person is in, whose approvals wait. No product approves on a timeout after offering a request to a person.
- **Recommendation.** The policy keeps answering what it **approves**, whether or not someone is attached. That is the mode the person chose for the thread, as in Claude's runs. What the policy would **reject** or ask about goes to an attached person as a pending request. If nobody answers within a deadline, or nobody is attached, the policy's `otherwise` applies: reject when it says reject. An `otherwise: "ask"` thread already waits for a person, and with WVE-117 its request becomes a push. Never let a timeout approve.
  - This is option two of WVE-147 with the timeout ending in the policy's answer, never in an approval.
  - A rejection by timeout should journal a notice, as ADR 0026's rejections do, saying it expired.
  - About 30 minutes (Grok Bot) is the only unattended deadline found. Claude's five minutes applies to lesser dialogs.
- **Attached is not present.** Claude Code distinguishes a focused terminal and a presence file from a mere connection, and Grok Bot distinguishes a focused window from a running app. An attached TUI in a background tab, or a suspended iPhone app, is not a person. Recommendation: offer the request to attached clients, but start the deadline, and the push, from the moment it was offered, not from when someone looks.

### 7.4 WVE-168: following into a continuation

There is little direct evidence. No surveyed product documents a follower following a run into its successor. The nearest are these:

- Claude Desktop notifies the person when a catch-up run starts.
- Claude Code's Remote Control serves a crashed server-mode session again when a device messages it, and the conversation carries on in the same session.
- Cursor's event stream resumes with `Last-Event-ID`.
- ChatGPT agent says that after a takeover it "may need to re-establish the run".

Weave's continuation is a new turn in the same thread with `continues` naming the interrupted turn, which is the cleanest of these shapes. Recommendations:

- A `weave run` waiting on turn T treats `turnEnded(T, interrupted)` followed by `turnStarted{continues: T}` as one outcome and exits on the continuation's end. It prints one line that T was interrupted and continued.
- A peer Host's report waits the same way, since the report is about the work, not the process. This also covers a continuation that is itself interrupted and not continued again.
- If WVE-117 lands, an interruption that is continued is worth a push only if the continuation fails. Claude Desktop's "catch-up started" notification is the precedent for telling the person, but weave's interrupted turns are the Host's own doing and the person can't act on them.

### 7.5 WVE-117: the edge

- **When a pending request becomes a push.**
  - The evidence agrees on pushing for questions and approvals: Cursor (only those), Claude's "actions required", Grok Bot's "waiting for you", Replit's "needs your help".
  - Pushing for completions is optional, or left to the agent: Claude's "Push when Claude decides" and "notify me when the tests finish", ChatGPT's "only when there is something worth reporting".
  - Presence holds pushes back: Claude skips them while the terminal is focused, and Grok Bot delays the phone about three minutes while the desktop app is open.
  - **Recommendation.** The Host asks the edge to push when a pending request exists and no client in the foreground has seen it within a short delay (Grok Bot's three minutes is the one figure published). Add a Host tool such as `notify_person` so an agent can ask for a push at the end of a long headless turn, as Claude does. It sends a content-free push like any other.
- **What a push says.** No vendor documents its notification text. Apple's guidance is the usual one: no sensitive data in the payload, or encrypt it and decrypt in a notification service extension (`mutable-content: 1`, about 30 seconds). The extension needs an `alert` to run, and on failure the system shows the alert as sent. Recommendations:
  - A content-free push is an alert whose text is generic ("A thread on <Host name> needs you"), with `thread-id` set to the thread's id so pushes group by thread. The payload carries opaque ids only: Host, thread, pending request.
  - Use `timeSensitive` for a pending request and `passive` for "finished" pushes the agent asked for. Time-sensitive needs the capability (section 5).
  - Background pushes are no substitute for a request that waits: Apple doesn't guarantee them and limits them to two or three an hour.
  - An option the evidence allows without breaking the rule: the Host encrypts a one-line summary with a key the app received at pairing, so the edge carries ciphertext and the extension decrypts it on the device. It shows meaning without the edge seeing content, at the cost of a notification service extension and a key per device. Fetching the text from the Host inside the extension would need the phone's tailnet connection to be up within 30 seconds, which wasn't checked (section 8).
- **What tapping opens.** Dots send "a link to review the request in ChatGPT", and Grok Bot sends the person to the Bot's conversation, where **Needs attention** is a sidebar state. Recommendation: tapping opens the thread at the pending request, using the ids in the payload. If the request was already answered elsewhere, the app says so. Grok's "opening a conversation marks its current activity as read" suggests clearing the push when any client answers. The Host can ask the edge to send a background or replacement push for that.
- **How long the edge keeps deliveries.** GitHub redelivers manually for 3 days and Standard Webhooks retries for about 3 days. Durable Object alarms are at-least-once with six retries. Recommendation: the edge acknowledges GitHub after storing the delivery in the Host's Durable Object, not after the Host accepts it, because GitHub's 10 seconds is shorter than a laptop's sleep. It keeps undelivered deliveries for at least 3 days, matching GitHub's own window, then drops them with a record. The Host's 14-day request keys dedupe whatever arrives twice. Pushes need no retention: a push the person didn't see is replaced by the state they find on opening the app.

### 7.6 WVE-118: always-on agents

- **The closest products.** Grok Bot is the nearest product to this record: a named agent on a persistent computer that keeps running when the app closes, with routines, event and webhook triggers, an inbox of "needs attention", and pushes for "finishes or is waiting". Dots are the other: an agent that "can decide when to pause and wake up", with saved schedules that record their zone, end date, "which changes deserve a notification" and "where to deliver results".
- **Waking itself.** Claude Desktop's `update_scheduled_task` tool and dots' self-chosen wake-ups support WVE-118's "can schedule its own wake-ups". Recommendation: a resident's schedules are ordinary Triggers, created through the same Host requests (7.1) and offered as Host tools under its policy. A one-off schedule is how it wakes itself. Its schedules record which outcomes deserve a push, as dots' do.
- **When to start a new thread.** Products let each trigger choose between a new conversation and the same one (section 6). None documents starting a new one when compaction stops freeing context, and nothing was found on it. Recommendation: per trigger, `thread = "current" | "new"`, plus the person's manual "start a new thread". Defer the compaction rule until it's observed.
- **Absence.** Grok Bot pauses routines after a long absence when the person doesn't answer. Grok Bot and Claude Desktop let pending approvals from unattended work expire or stall. Recommendation: a resident whose pending requests go unanswered for a configurable time pauses its triggers and pushes once to say so, instead of piling up turns. That gives "pending requests wait for the person" a bound.
- **Names.** "Routine" is now Grok Bot's, Replit's and Lindy's word for a trigger, and Claude's former one. "Bot" is xAI's word for this very record, "dot" OpenAI's, "teammate" Lindy's. None of the products here uses "Resident", so [§10.4](agent-identity-and-where-agents-run.md#104-wve-118-always-on-agents)'s preference stands. Weave's "Trigger" has no conflicting use among them.
- **Memory across runs.** Cursor Automations keep `MEMORIES.md` "across runs", Claude Desktop keeps a task's prompt as `SKILL.md`, and Devin's automation sessions don't touch personal memory (§2.3). These support memory as files in the resident's home, already in WVE-118, and add nothing new.

### 7.7 Not worth borrowing

- **A classifier of weave's own.** Auto mode, Auto Review and Assisted permissions are loops weave doesn't own (ADR 0011). The agent's own mode already plays this part (ADR 0026).
- **Auto-approve on a timer**, as Jules did for plans. No product does it for tool calls.
- **SMS or email channels.** Dots' texts are "not end-to-end encrypted" and go through a third party. Content-free APNs pushes through the edge are the whole channel.
- **Grouping events into one run**, as ChatGPT's event triggers do ("may be grouped together"). This is useful at their scale, but it blurs "each occurrence admitted once" for one person's Host.

## 8. Open questions

- **`@grok` on X.** How a public mention is turned into a reply, what context it reads, its limits. help.x.com refused every fetch, and only secondary sources describe it.
- **Grok "Tasks".** Whether Grok Automations renamed it. Only secondary sources mention it.
- **Grok Bot and Cursor.** Why Grok Bot signs in with a Cursor account. The FAQ says so without explanation.
- **Notification contents.** None of xAI, OpenAI, Anthropic, Cursor, Devin, GitHub or Replit documents what its pushes say or what tapping one opens, beyond dots' review link.
- **Missed runs in cloud schedulers.** Claude Code cloud tasks, Cursor Automations, Copilot Automations, Devin Automations, ChatGPT Scheduled tasks and Grok Bot routines don't document what happens to an occurrence missed during their own outage, or to overlapping runs (except Devin's queue).
- **Approval deadlines.** Only Grok Bot (about 30 minutes) and Claude Code's lesser dialogs (5 minutes) publish one. ChatGPT, dots, Devin, Copilot and Manus say only that work waits.
- **Reaching the Host from a notification service extension.** Whether an iOS extension, with about 30 seconds and Tailscale's VPN possibly not connected, can reach a Host over the tailnet to fetch a notification's text. Not tested.
- **The time-sensitive entitlement's reference page.** Not found. The requirement rests on Apple's WWDC21 session 10091.
- **Kubernetes catch-up count.** Whether a CronJob without a deadline starts every missed Job or one. The page gives only the 100-miss cut-off.
- **Temporal and DST**, and **GitHub Actions in a repeated (fall-back) hour.** Neither documents it.
- **ChatGPT agent mode versus ChatGPT Work.** Whether Work has replaced agent mode. The release notes don't say.
- **Manus webhook signatures.** On a page that wasn't read.
- **Secondary sources.** Search results included third-party write-ups of Grok's `@grok` replies, Grok "Tasks", Lindy's older triggers and Zapier's free-plan limits. None is cited, and nothing here rests on them.
