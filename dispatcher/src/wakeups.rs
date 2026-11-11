//! A Bot's own wake-ups (WVE-118): the service tools the Dispatcher declares on every Host's link
//! (WVE-171), which a Bot's thread calls through the Host MCP server to be prompted again later,
//! to list what it asked for, and to cancel one.
//!
//! - A wake-up is a one-off schedule naming the Bot, marked with the Host's id for the call that
//!   asked for it (`wake_call`), so the same call makes one however often it comes. It fires as
//!   any Bot schedule's occurrence does ([`crate::scheduler`]): into the Bot's current thread,
//!   held while it starts a new one, skipped while it's paused, once across restarts; its turn's
//!   origin is `wake-up <name>`. A week after its time, once its occurrence is over, the
//!   scheduler forgets it.
//! - Only a Bot's own thread may call them: on the Bot's Host, its current thread, one it had,
//!   or the new one it's starting. Any other thread gets a tool error in words for its agent, as
//!   does a wake-up less than a minute away, or one past the most a Bot may have to come.

use std::sync::Arc;

use agent_client_protocol::schema::v1::ContentBlock;
use serde::Deserialize;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Map;
use serde_json::Number;
use serde_json::Value;
use serde_json::json;
use weave_host_client::HostHandle;
use weave_host_protocol::dispatcher::Missed;
use weave_host_protocol::dispatcher::Overlap;
use weave_host_protocol::dispatcher::ScheduledRun;
use weave_host_protocol::tools::AnswerToolRequest;
use weave_host_protocol::tools::ClientToolResult;
use weave_host_protocol::tools::Tool;
use weave_host_protocol::tools::ToolCallNotification;

use crate::Shared;
use crate::scheduler::Plan;
use crate::store::StoredBot;
use crate::store::StoredHost;
use crate::store::StoredSchedule;
use crate::store::WakeUp;

/// Ask to be woken later: a one-off prompt to the Bot's thread.
pub(crate) const WAKE_ME: &str = "wake_me";

/// The calling Bot's wake-ups still to come.
pub(crate) const LIST_WAKEUPS: &str = "list_wakeups";

/// Cancel one of the calling Bot's wake-ups still to come.
pub(crate) const CANCEL_WAKEUP: &str = "cancel_wakeup";

/// How soon a wake-up may be, at the soonest.
const SOONEST: u64 = 60 * 1000;

/// How many wake-ups still to come a Bot may have.
const MOST: u32 = 20;

/// What a thread that isn't a Bot's is told.
const NOT_A_BOTS: &str = "Only a Bot's own thread can ask to be woken, or list or cancel its \
     wake-ups, and this thread isn't one of a Bot's: a Bot is a named assistant the person's \
     Dispatcher keeps, and its threads are those the Dispatcher started for it.";

/// The tools the Dispatcher declares on every Host, in the order agents see them.
pub(crate) fn tools() -> Vec<Tool> {
    let only = "Only for a Bot's own thread: a Bot is a named assistant the person's weave \
                Dispatcher keeps, working in threads the Dispatcher starts for it. Unless you \
                are working as one of the person's Bots, don't call this: it refuses every other \
                thread.";
    vec![
        Tool {
            name: WAKE_ME.to_owned(),
            title: "Wake me later".to_owned(),
            description: format!(
                "{only} Ask to be woken later: at the time you give, the Dispatcher sends \
                 prompt to the Bot's thread as a prompt of its own, starting a turn there, in \
                 the Bot's newest thread if it has started another by then. Give exactly one of \
                 at or in, at least a minute from now. If the Bot is paused at that time, its \
                 thread having waited on the person too long, the wake-up is skipped. A Bot may \
                 have at most {MOST} wake-ups still to come; list_wakeups lists them and \
                 cancel_wakeup cancels one. Answers with the wake-up's id and its time, in the \
                 Bot's time zone, as JSON."
            ),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "prompt": {"type": "string", "minLength": 1, "description": "What to tell \
                        yourself then: everything you'll need to act on it, since by then you \
                        may have done other work, or moved to a newer thread."},
                    "at": {"type": "string", "description": "When to be woken, as an RFC 3339 \
                        time with its offset, such as 2026-11-10T15:00:00+02:00. Not with in."},
                    "in": {"type": "integer", "minimum": 60, "description": "When to be woken, \
                        as a whole number of seconds from now, such as 7200 for two hours. Not \
                        with at."}
                },
                "required": ["prompt"],
                "additionalProperties": false
            }),
        },
        Tool {
            name: LIST_WAKEUPS.to_owned(),
            title: "List my wake-ups".to_owned(),
            description: format!(
                "{only} List the wake-ups this Bot asked for with wake_me that are still to \
                 come, soonest first: each one's id, its time (at, and when as people read it, \
                 in the Bot's time zone) and its prompt. Answers with them as JSON."
            ),
            input_schema: json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }),
        },
        Tool {
            name: CANCEL_WAKEUP.to_owned(),
            title: "Cancel a wake-up".to_owned(),
            description: format!(
                "{only} Cancel one of this Bot's wake-ups still to come, so its prompt is never \
                 sent. Answers with the wake-up it cancelled as JSON."
            ),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "id": {"type": "string", "description": "The wake-up's id, as wake_me or \
                        list_wakeups gave it."}
                },
                "required": ["id"],
                "additionalProperties": false
            }),
        },
    ]
}

/// Answer `call`, which came from `calling` over `from`.
pub(crate) async fn answer(
    shared: Arc<Shared>,
    calling: StoredHost,
    from: HostHandle,
    call: ToolCallNotification,
) {
    let result = match respond(&shared, &calling, &call) {
        Ok(text) => ClientToolResult::text(text),
        Err(why) => ClientToolResult::error(why),
    };
    let answered = from
        .send(AnswerToolRequest {
            call_id: call.call_id,
            result,
        })
        .await;
    if let Err(error) = answered {
        tracing::debug!(host = %calling.host_id, %error, "answering a tool call failed");
    }
}

/// The text the agent gets for `call`, or why it failed.
fn respond(
    shared: &Shared,
    calling: &StoredHost,
    call: &ToolCallNotification,
) -> Result<String, String> {
    let tool = call.tool.as_str();
    if ![WAKE_ME, LIST_WAKEUPS, CANCEL_WAKEUP].contains(&tool) {
        return Err(format!("The Dispatcher has no tool {tool}."));
    }
    let bot = own_bot(shared, calling, &call.caller.thread_id.0)?;
    match tool {
        WAKE_ME => wake_me(
            shared,
            &bot,
            &call.call_id,
            arguments(tool, &call.arguments)?,
        ),
        LIST_WAKEUPS => list(shared, &bot),
        _ => cancel(shared, &bot, arguments(tool, &call.arguments)?),
    }
}

/// The Bot whose own thread `thread`, on `calling`, is: its current thread, one it had, or the
/// new one it's starting.
fn own_bot(shared: &Shared, calling: &StoredHost, thread: &str) -> Result<StoredBot, String> {
    let bots = shared
        .store
        .bots()
        .map_err(|why| format!("The Dispatcher couldn't read its Bots: {why}."))?;
    bots.into_iter()
        .find(|bot| bot.host_id == calling.host_id && owns(bot, thread))
        .ok_or_else(|| NOT_A_BOTS.to_owned())
}

fn owns(bot: &StoredBot, thread: &str) -> bool {
    bot.thread.as_deref() == Some(thread)
        || bot.threads.iter().any(|had| had.thread_id == thread)
        || bot
            .new_thread
            .as_ref()
            .and_then(|new_thread| new_thread.thread.as_deref())
            == Some(thread)
}

/// `wake_me`'s arguments.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WakeMe {
    prompt: String,
    #[serde(default)]
    at: Option<String>,
    #[serde(default, rename = "in")]
    after: Option<Number>,
}

/// `cancel_wakeup`'s arguments.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Cancel {
    id: String,
}

/// A wake-up as the tools give it.
#[derive(Serialize)]
struct Listed {
    id: String,
    /// RFC 3339, in the Bot's time zone.
    at: String,
    /// As people read it: "Wed 4 Nov 09:00 SAST".
    when: String,
    prompt: String,
}

#[derive(Serialize)]
struct Wakeups {
    wakeups: Vec<Listed>,
}

#[derive(Serialize)]
struct Cancelled {
    cancelled: Listed,
}

fn arguments<T: DeserializeOwned>(tool: &str, arguments: &Map<String, Value>) -> Result<T, String> {
    serde_json::from_value(Value::Object(arguments.clone()))
        .map_err(|error| format!("The arguments don't fit {tool}'s input: {error}."))
}

/// `wake_me`: write down a wake-up for `bot`, asked for by the call `call_id`.
fn wake_me(
    shared: &Shared,
    bot: &StoredBot,
    call_id: &str,
    asked: WakeMe,
) -> Result<String, String> {
    if asked.prompt.trim().is_empty() {
        return Err("A wake-up needs a prompt: what to tell yourself then.".to_owned());
    }
    let now = shared.config.clock.now();
    let at = when(now, asked.at.as_deref(), asked.after.as_ref())?;
    let plan = Plan::once(at, &bot.zone).map_err(|why| format!("The Bot's {why}."))?;
    if at < now.saturating_add(SOONEST) {
        return Err(if at <= now {
            format!(
                "A wake-up has to be at least a minute from now, and {} has passed.",
                plan.describe(at)
            )
        } else {
            format!(
                "A wake-up has to be at least a minute from now, and {} is only {} seconds away.",
                plan.describe(at),
                (at - now) / 1000
            )
        });
    }
    let id = StoredSchedule::new_id();
    let short: String = id
        .strip_prefix("sch-")
        .unwrap_or(&id)
        .chars()
        .take(12)
        .collect();
    let schedule = StoredSchedule {
        name: format!("wake-up-{short}"),
        id,
        cron: String::new(),
        at: Some(at),
        zone: bot.zone.clone(),
        host_id: bot.host_id.clone(),
        run: ScheduledRun {
            agent_id: bot.agent_id.clone(),
            cwd: bot.home.clone(),
            prompt: vec![ContentBlock::from(asked.prompt)],
            policy: bot.policy.clone(),
            mode: bot.mode.clone(),
            thread: None,
        },
        bot_id: Some(bot.id.clone()),
        missed: Missed::Latest,
        overlap: Overlap::Skip,
        created_at: now,
        considered_until: now,
        paused: None,
        failures: 0,
        wake_call: Some(call_id.to_owned()),
    };
    let written = shared
        .store
        .add_wake_up(&schedule, MOST)
        .map_err(|why| format!("The Dispatcher couldn't write the wake-up down: {why}."))?;
    match written {
        WakeUp::Added(added) => {
            tracing::info!(bot = %bot.name, schedule = %added.id, at, "a Bot asked to be woken");
            shared.schedules_changed.notify_one();
            to_text(&listed(&added))
        }
        WakeUp::Again(before) => to_text(&listed(&before)),
        WakeUp::Full(coming) => Err(format!(
            "{} has {coming} wake-ups still to come, the most a Bot may have: cancel one with \
             cancel_wakeup, or wait for one to come, before asking for another.",
            bot.name
        )),
    }
}

/// When `at` or `after`, seconds from `now`, says to wake: exactly one of them.
fn when(now: u64, at: Option<&str>, after: Option<&Number>) -> Result<u64, String> {
    let at = match (at, after) {
        (Some(_), Some(_)) => return Err("Give at or in, not both.".to_owned()),
        (None, None) => {
            return Err(
                "Give when to be woken: at, a time, or in, a number of seconds from now."
                    .to_owned(),
            );
        }
        (Some(at), None) => {
            let at: jiff::Timestamp = at.trim().parse().map_err(|error| {
                format!(
                    "at isn't an RFC 3339 time with its offset, such as \
                     2026-11-10T15:00:00+02:00: {error}."
                )
            })?;
            u64::try_from(at.as_millisecond()).map_err(|_| "at is before 1970.".to_owned())?
        }
        (None, Some(seconds)) => {
            let whole = seconds.as_u64().or_else(|| {
                seconds
                    .as_f64()
                    .filter(|seconds| seconds.is_finite() && *seconds >= 0.0)
                    .map(|seconds| seconds.round() as u64)
            });
            let whole = whole.ok_or_else(|| {
                format!("in is a whole number of seconds from now, not {seconds}.")
            })?;
            whole
                .checked_mul(1000)
                .and_then(|after| now.checked_add(after))
                .ok_or_else(|| "in is further from now than the Dispatcher can count.".to_owned())?
        }
    };
    i64::try_from(at)
        .ok()
        .and_then(|ms| jiff::Timestamp::from_millisecond(ms).ok())
        .map(|_| at)
        .ok_or_else(|| "That's further from now than the Dispatcher can count.".to_owned())
}

/// `list_wakeups`: `bot`'s wake-ups still to come.
fn list(shared: &Shared, bot: &StoredBot) -> Result<String, String> {
    let coming = shared
        .store
        .wake_ups(&bot.id)
        .map_err(|why| format!("The Dispatcher couldn't read the wake-ups: {why}."))?;
    to_text(&Wakeups {
        wakeups: coming.iter().map(listed).collect(),
    })
}

/// `cancel_wakeup`: forget one of `bot`'s wake-ups still to come.
fn cancel(shared: &Shared, bot: &StoredBot, asked: Cancel) -> Result<String, String> {
    let id = asked.id.trim();
    let cancelled = shared
        .store
        .cancel_wake_up(&bot.id, id)
        .map_err(|why| format!("The Dispatcher couldn't cancel the wake-up: {why}."))?;
    match cancelled {
        Some(cancelled) => {
            tracing::info!(bot = %bot.name, schedule = %cancelled.id, "a Bot cancelled a wake-up");
            shared.schedules_changed.notify_one();
            to_text(&Cancelled {
                cancelled: listed(&cancelled),
            })
        }
        None => Err(format!(
            "{} has no wake-up {id} still to come: list_wakeups lists those it has.",
            bot.name
        )),
    }
}

fn listed(schedule: &StoredSchedule) -> Listed {
    let at = schedule.at.unwrap_or_default();
    let plan = Plan::once(at, &schedule.zone).ok();
    Listed {
        id: schedule.id.clone(),
        at: plan
            .as_ref()
            .map(|plan| plan.rfc3339(at))
            .unwrap_or_default(),
        when: plan
            .as_ref()
            .map(|plan| plan.describe(at))
            .unwrap_or_default(),
        prompt: schedule
            .run
            .prompt
            .iter()
            .filter_map(|block| match block {
                ContentBlock::Text(text) => Some(text.text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n"),
    }
}

fn to_text(value: &impl Serialize) -> Result<String, String> {
    serde_json::to_string_pretty(value).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    #[test]
    fn a_wake_up_is_at_a_time_or_in_seconds_but_not_both() {
        let now = 1_000_000;
        let seconds = |value: Value| match value {
            Value::Number(number) => number,
            other => panic!("a number: {other}"),
        };
        assert_eq!(when(now, None, Some(&seconds(json!(90)))), Ok(1_090_000));
        assert_eq!(when(now, None, Some(&seconds(json!(90.4)))), Ok(1_090_000));
        assert_eq!(
            when(now, Some("1970-01-01T02:00:00+02:00"), None),
            Ok(0),
            "its offset counts"
        );
        assert_eq!(
            when(now, Some("2026-11-04T09:00:00Z"), None),
            Ok(1_793_782_800_000)
        );
        for (at, after, said) in [
            (Some("2026-11-04T09:00:00Z"), Some(json!(60)), "not both"),
            (None, None, "Give when"),
            (Some("2026-11-04 09:00"), None, "RFC 3339"),
            (Some("2026-11-04T09:00:00"), None, "RFC 3339"),
            (None, Some(json!(-5)), "whole number of seconds"),
            (None, Some(json!(u64::MAX)), "further from now"),
        ] {
            let after = after.map(seconds);
            let why = when(now, at, after.as_ref()).expect_err("refused");
            assert!(why.contains(said), "{why}");
        }
        let names: Vec<String> = tools().into_iter().map(|tool| tool.name).collect();
        assert_eq!(names, [WAKE_ME, LIST_WAKEUPS, CANCEL_WAKEUP]);
    }
}
