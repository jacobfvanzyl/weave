//! A Bot's own wake-ups (WVE-118): the first of the Dispatcher's service tools ([`super`]),
//! which a Bot's thread calls to be prompted again later, to list what it asked for, and to
//! cancel one.
//!
//! - A wake-up is a one-off schedule naming the Bot, marked with the Host's id for the call that
//!   asked for it (`wake_call`), so the same call makes one however often it comes. It fires as
//!   any Bot schedule's occurrence does ([`crate::scheduler`]): into the Bot's current thread,
//!   held while it starts a new one, skipped while it's paused, once across restarts; its turn's
//!   origin is `wake-up <name>`. A week after its time, once its occurrence is over, the
//!   scheduler forgets it.
//! - A wake-up less than a minute away, or one past the most a Bot may have to come, is refused.

use agent_client_protocol::v1::schema::ContentBlock;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Number;
use serde_json::json;
use weave_host_protocol::dispatcher::Missed;
use weave_host_protocol::dispatcher::Overlap;
use weave_host_protocol::dispatcher::ScheduledRun;
use weave_host_protocol::tools::Tool;

use super::ONLY;
use super::text_of;
use super::to_text;
use crate::Shared;
use crate::scheduler::Plan;
use crate::store::StoredBot;
use crate::store::StoredSchedule;
use crate::store::WakeUp;

/// Ask to be woken later: a one-off prompt to the Bot's thread.
pub(super) const WAKE_ME: &str = "wake_me";

/// The calling Bot's wake-ups still to come.
pub(super) const LIST_WAKEUPS: &str = "list_wakeups";

/// Cancel one of the calling Bot's wake-ups still to come.
pub(super) const CANCEL_WAKEUP: &str = "cancel_wakeup";

/// These tools, in the order agents see them.
pub(super) const NAMES: &[&str] = &[WAKE_ME, LIST_WAKEUPS, CANCEL_WAKEUP];

/// What only a Bot's own thread can do with them, as one that isn't is told.
pub(super) const CAN: &str = "ask to be woken, or list or cancel its wake-ups";

/// How soon a wake-up may be, at the soonest.
const SOONEST: u64 = 60 * 1000;

/// How many wake-ups still to come a Bot may have.
const MOST: u32 = 20;

/// The wake-up tools, in the order agents see them.
pub(super) fn tools() -> Vec<Tool> {
    vec![
        Tool {
            name: WAKE_ME.to_owned(),
            title: "Wake me later".to_owned(),
            description: format!(
                "{ONLY} Ask to be woken later: at the time you give, the Dispatcher sends \
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
                "{ONLY} List the wake-ups this Bot asked for with wake_me that are still to \
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
                "{ONLY} Cancel one of this Bot's wake-ups still to come, so its prompt is never \
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

/// `wake_me`'s arguments.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct WakeMe {
    prompt: String,
    #[serde(default)]
    at: Option<String>,
    #[serde(default, rename = "in")]
    after: Option<Number>,
}

/// `cancel_wakeup`'s arguments.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Cancel {
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

/// `wake_me`: write down a wake-up for `bot`, asked for by the call `call_id`.
pub(super) fn wake_me(
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
        made_call: None,
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
pub(super) fn list(shared: &Shared, bot: &StoredBot) -> Result<String, String> {
    let coming = shared
        .store
        .wake_ups(&bot.id)
        .map_err(|why| format!("The Dispatcher couldn't read the wake-ups: {why}."))?;
    to_text(&Wakeups {
        wakeups: coming.iter().map(listed).collect(),
    })
}

/// `cancel_wakeup`: forget one of `bot`'s wake-ups still to come.
pub(super) fn cancel(shared: &Shared, bot: &StoredBot, asked: Cancel) -> Result<String, String> {
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
        prompt: text_of(&schedule.run.prompt),
    }
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;
    use serde_json::Value;

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
    }
}
