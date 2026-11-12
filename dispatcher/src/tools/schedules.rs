//! A Bot's own schedules (WVE-178): the recurring schedules that prompt it, the person's for it
//! as well as those it added itself, wake-ups aside, which the Bot adds, lists, pauses, resumes
//! and removes with these tools as the person asks it to.
//!
//! - One it adds is checked as `schedules/add` checks a Bot's schedule ([`Shared::new_schedule`]),
//!   in the Bot's time zone unless it names another, and marked with the Host's id for the call
//!   (`made_call`), so the same call adds one however often it comes and its turns' origin says
//!   the Bot made it (`schedule <name> by <bot>`, [`crate::scheduler::fire`]). It may come every
//!   five minutes at most ([`too_often`]), and a Bot that has 20 schedules, wake-ups aside, adds
//!   no more.
//! - The others act on a schedule that prompts the calling Bot, by id or name, the person's
//!   too; any other schedule, a wake-up included, is refused.

use agent_client_protocol::schema::v1::ContentBlock;
use serde::Deserialize;
use serde::Serialize;
use serde_json::json;
use weave_host_protocol::dispatcher::AddScheduleRequest;
use weave_host_protocol::dispatcher::Missed;
use weave_host_protocol::dispatcher::OccurrenceState;
use weave_host_protocol::dispatcher::Overlap;
use weave_host_protocol::threads::TurnState;
use weave_host_protocol::tools::Tool;

use super::ONLY;
use super::sentence;
use super::text_of;
use super::to_text;
use crate::Shared;
use crate::bots::said;
use crate::scheduler::Plan;
use crate::store::BotSchedule;
use crate::store::StoredBot;
use crate::store::StoredSchedule;

/// Add a recurring schedule that prompts the calling Bot.
pub(super) const ADD_SCHEDULE: &str = "add_schedule";

/// The schedules that prompt the calling Bot, wake-ups aside.
pub(super) const LIST_SCHEDULES: &str = "list_schedules";

/// Pause one of them.
pub(super) const PAUSE_SCHEDULE: &str = "pause_schedule";

/// Resume one of them.
pub(super) const RESUME_SCHEDULE: &str = "resume_schedule";

/// Remove one of them.
pub(super) const REMOVE_SCHEDULE: &str = "remove_schedule";

/// These tools, in the order agents see them.
pub(super) const NAMES: &[&str] = &[
    ADD_SCHEDULE,
    LIST_SCHEDULES,
    PAUSE_SCHEDULE,
    RESUME_SCHEDULE,
    REMOVE_SCHEDULE,
];

/// What only a Bot's own thread can do with them, as one that isn't is told.
pub(super) const CAN: &str = "add, list, pause, resume or remove its schedules";

/// How many schedules a Bot may have, wake-ups aside, when it adds one.
const MOST: u32 = 20;

/// How soon after another a Bot's own schedule may come, at the soonest: five minutes.
const OFTENEST: u64 = 5 * 60 * 1000;

/// How many of a cron expression's next times are looked at to see how often it comes: more
/// than a day's at every five minutes, so the hours a day repeats and the turn of the day are
/// both among them.
const LOOKED_AT: usize = 300;

/// The schedule tools, in the order agents see them.
pub(super) fn tools() -> Vec<Tool> {
    let by = json!({
        "type": "object",
        "properties": {
            "id": {"type": "string", "minLength": 1, "description": "The schedule's id, or its \
                name, as list_schedules gives them."}
        },
        "required": ["id"],
        "additionalProperties": false
    });
    vec![
        Tool {
            name: ADD_SCHEDULE.to_owned(),
            title: "Add a schedule".to_owned(),
            description: format!(
                "{ONLY} Add a schedule that prompts this Bot again and again, at the times a \
                 cron expression gives, when the person asks for one: at each, the Dispatcher \
                 sends prompt to the Bot's thread as a prompt of its own, starting a turn \
                 there, in the Bot's newest thread. A time that comes while the one before is \
                 still running, or while the Bot is paused, its thread having waited on the \
                 person too long, is skipped; one missed while the Dispatcher couldn't run it \
                 runs once, late. It may come every 5 minutes at most, and a Bot may have at \
                 most {MOST} schedules, wake-ups aside. For one prompt later, use wake_me \
                 instead. list_schedules lists them, and pause_schedule, resume_schedule and \
                 remove_schedule change one. Answers with the schedule as JSON: its id, name, \
                 cron, zone, prompt and next time."
            ),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "name": {"type": "string", "minLength": 1, "description": "A short name \
                        for it, unique among all the person's schedules, such as \
                        morning-brief."},
                    "cron": {"type": "string", "minLength": 1, "description": "When it comes: \
                        five fields, minute hour day-of-month month weekday, such as \
                        0 9 * * 1-5 for 09:00 on weekdays, or a name such as @daily."},
                    "prompt": {"type": "string", "minLength": 1, "description": "What to tell \
                        yourself each time: everything you'll need to act on it, since by then \
                        you may be in a newer thread."},
                    "zone": {"type": "string", "description": "The IANA time zone the cron \
                        expression is read in, such as Africa/Johannesburg; the Bot's own when \
                        absent."}
                },
                "required": ["name", "cron", "prompt"],
                "additionalProperties": false
            }),
        },
        Tool {
            name: LIST_SCHEDULES.to_owned(),
            title: "List my schedules".to_owned(),
            description: format!(
                "{ONLY} List the schedules that prompt this Bot, by name: those the person \
                 added for it as well as those it added itself, wake-ups aside (list_wakeups \
                 lists those). Each one's id, name, cron, zone and prompt; why it's paused, if \
                 it is; when it next comes (at, and when as people read it, in its time zone); \
                 its last time and how that went; and addedByYou, when this Bot added it. \
                 Answers with them as JSON."
            ),
            input_schema: json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }),
        },
        Tool {
            name: PAUSE_SCHEDULE.to_owned(),
            title: "Pause a schedule".to_owned(),
            description: format!(
                "{ONLY} Pause one of the schedules that prompt this Bot, the person's too, so it \
                 doesn't come until resume_schedule resumes it. Answers with the schedule as \
                 JSON."
            ),
            input_schema: by.clone(),
        },
        Tool {
            name: RESUME_SCHEDULE.to_owned(),
            title: "Resume a schedule".to_owned(),
            description: format!(
                "{ONLY} Resume one of the schedules that prompt this Bot that's paused: it comes \
                 again from now, catching up nothing it missed while paused. Answers with the \
                 schedule as JSON."
            ),
            input_schema: by.clone(),
        },
        Tool {
            name: REMOVE_SCHEDULE.to_owned(),
            title: "Remove a schedule".to_owned(),
            description: format!(
                "{ONLY} Remove one of the schedules that prompt this Bot for good, the person's \
                 too, so remove one only when the person asks; to stop it for a while, pause \
                 it. A turn it started goes on. Answers with the schedule it removed as JSON."
            ),
            input_schema: by,
        },
    ]
}

/// `add_schedule`'s arguments.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Add {
    name: String,
    cron: String,
    prompt: String,
    #[serde(default)]
    zone: Option<String>,
}

/// The schedule the other tools name, by id or name.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct By {
    id: String,
}

/// A schedule as the tools give it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Listed {
    id: String,
    name: String,
    cron: String,
    zone: String,
    prompt: String,
    /// Why it's paused, while it is.
    #[serde(skip_serializing_if = "Option::is_none")]
    paused: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    next: Option<Time>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last: Option<Last>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    added_by_you: bool,
}

#[derive(Serialize)]
struct Time {
    /// RFC 3339, in the schedule's time zone.
    at: String,
    /// As people read it: "Wed 4 Nov 09:00 SAST".
    when: String,
}

/// Its latest time, and how it went.
#[derive(Serialize)]
struct Last {
    #[serde(flatten)]
    time: Time,
    state: OccurrenceState,
    #[serde(skip_serializing_if = "Option::is_none")]
    outcome: Option<TurnState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    why: Option<String>,
}

#[derive(Serialize)]
struct Schedules {
    schedules: Vec<Listed>,
}

#[derive(Serialize)]
struct Removed {
    removed: Listed,
}

/// `add_schedule`: write down a schedule prompting `bot`, added by the call `call_id`.
pub(super) fn add(
    shared: &Shared,
    bot: &StoredBot,
    call_id: &str,
    asked: Add,
) -> Result<String, String> {
    if asked.prompt.trim().is_empty() {
        return Err("A schedule needs a prompt: what to tell yourself each time.".to_owned());
    }
    let zone = asked
        .zone
        .map(|zone| zone.trim().to_owned())
        .filter(|zone| !zone.is_empty())
        .unwrap_or_else(|| bot.zone.clone());
    let request = AddScheduleRequest {
        name: asked.name,
        cron: Some(asked.cron),
        at: None,
        zone: Some(zone),
        host: None,
        bot: Some(bot.id.clone()),
        agent_id: None,
        cwd: None,
        prompt: vec![ContentBlock::from(asked.prompt)],
        policy: None,
        mode: None,
        thread: None,
        missed: Missed::Latest,
        overlap: Overlap::Skip,
    };
    let mut schedule = shared
        .new_schedule(request)
        .map_err(|error| sentence(&said(&error)))?;
    let plan = Plan::new(&schedule.cron, &schedule.zone).map_err(|why| sentence(&why))?;
    if let Some((first, then)) = too_often(&plan, schedule.created_at) {
        return Err(format!(
            "{} would come at {} and again at {}: a Bot's own schedule may come every 5 minutes \
             at most.",
            schedule.cron,
            plan.describe(first),
            plan.describe(then)
        ));
    }
    schedule.made_call = Some(call_id.to_owned());
    let written = shared
        .store
        .add_bot_schedule(&schedule, MOST)
        .map_err(|why| sentence(&why))?;
    match written {
        BotSchedule::Added(added) => {
            tracing::info!(bot = %bot.name, schedule = %added.name, "a Bot added a schedule");
            shared.schedules_changed.notify_one();
            to_text(&listed(shared, &added)?)
        }
        BotSchedule::Again(before) => to_text(&listed(shared, &before)?),
        BotSchedule::Full(had) => Err(format!(
            "{} has {had} schedules, wake-ups aside, the most a Bot may have when it adds one: \
             remove one with remove_schedule, if the person agrees, before adding another.",
            bot.name
        )),
    }
}

/// The first two of `plan`'s next [`LOOKED_AT`] times after `now` that come closer together
/// than [`OFTENEST`], if any do.
fn too_often(plan: &Plan, now: u64) -> Option<(u64, u64)> {
    let mut last = plan.next_after(now)?;
    for _ in 1..LOOKED_AT {
        let next = plan.next_after(last)?;
        if next.saturating_sub(last) < OFTENEST {
            return Some((last, next));
        }
        last = next;
    }
    None
}

/// `list_schedules`: the schedules prompting `bot`, wake-ups aside, by name.
pub(super) fn list(shared: &Shared, bot: &StoredBot) -> Result<String, String> {
    let schedules = shared
        .store
        .schedules()
        .map_err(|why| format!("The Dispatcher couldn't read its schedules: {why}."))?;
    let listed = schedules
        .iter()
        .filter(|schedule| prompts(schedule, bot) && schedule.wake_call.is_none())
        .map(|schedule| listed(shared, schedule))
        .collect::<Result<_, _>>()?;
    to_text(&Schedules { schedules: listed })
}

/// `pause_schedule`: pause one of `bot`'s schedules, unless it's paused already.
pub(super) fn pause(shared: &Shared, bot: &StoredBot, asked: By) -> Result<String, String> {
    let schedule = own_schedule(shared, bot, &asked.id)?;
    if schedule.paused.is_none() {
        shared
            .store
            .pause(&schedule.id, &format!("{} paused it", bot.name))
            .map_err(|why| format!("The Dispatcher couldn't pause it: {why}."))?;
        tracing::info!(bot = %bot.name, schedule = %schedule.name, "a Bot paused a schedule");
        shared.schedules_changed.notify_one();
    }
    to_text(&listed(shared, &schedule)?)
}

/// `resume_schedule`: resume one of `bot`'s schedules from now, if it's paused.
pub(super) fn resume(shared: &Shared, bot: &StoredBot, asked: By) -> Result<String, String> {
    let schedule = own_schedule(shared, bot, &asked.id)?;
    if schedule.paused.is_some() {
        shared
            .store
            .resume(&schedule.id, shared.config.clock.now())
            .map_err(|why| format!("The Dispatcher couldn't resume it: {why}."))?;
        tracing::info!(bot = %bot.name, schedule = %schedule.name, "a Bot resumed a schedule");
        shared.schedules_changed.notify_one();
    }
    to_text(&listed(shared, &schedule)?)
}

/// `remove_schedule`: forget one of `bot`'s schedules.
pub(super) fn remove(shared: &Shared, bot: &StoredBot, asked: By) -> Result<String, String> {
    let schedule = own_schedule(shared, bot, &asked.id)?;
    let removed = listed(shared, &schedule)?;
    shared
        .store
        .remove_schedule(&schedule.id)
        .map_err(|why| format!("The Dispatcher couldn't remove it: {why}."))?;
    tracing::info!(bot = %bot.name, schedule = %schedule.name, "a Bot removed a schedule");
    shared.schedules_changed.notify_one();
    to_text(&Removed { removed })
}

fn prompts(schedule: &StoredSchedule, bot: &StoredBot) -> bool {
    schedule.bot_id.as_deref() == Some(bot.id.as_str())
}

/// The schedule `by` names, by id or name, if it prompts `bot` and isn't a wake-up.
fn own_schedule(shared: &Shared, bot: &StoredBot, by: &str) -> Result<StoredSchedule, String> {
    let by = by.trim();
    let found = shared
        .store
        .find_schedule(by)
        .map_err(|why| format!("The Dispatcher couldn't read its schedules: {why}."))?;
    match found {
        Some(schedule) if prompts(&schedule, bot) && schedule.wake_call.is_none() => Ok(schedule),
        Some(schedule) if prompts(&schedule, bot) => Err(format!(
            "{by} is one of {}'s wake-ups, which these tools leave alone: cancel_wakeup cancels \
             it.",
            bot.name
        )),
        Some(_) => Err(format!(
            "The schedule {by} isn't {}'s: a Bot manages only the schedules that prompt it, \
             which list_schedules lists.",
            bot.name
        )),
        None => Err(format!(
            "There's no schedule {by}: list_schedules lists {}'s.",
            bot.name
        )),
    }
}

/// `schedule` as the tools give it, as it is now.
fn listed(shared: &Shared, schedule: &StoredSchedule) -> Result<Listed, String> {
    let current = shared.schedule(&schedule.id).map_err(|error| {
        format!(
            "The Dispatcher couldn't read the schedule: {}",
            said(&error)
        )
    })?;
    let plan = Plan::of(schedule).ok();
    let time = |at: u64| {
        plan.as_ref().map(|plan| Time {
            at: plan.rfc3339(at),
            when: plan.describe(at),
        })
    };
    Ok(Listed {
        last: current.last.and_then(|last| {
            Some(Last {
                time: time(last.scheduled_at)?,
                state: last.state,
                outcome: last.outcome,
                why: last.why,
            })
        }),
        next: current.next_at.and_then(time),
        paused: current.paused,
        id: current.id,
        name: current.name,
        cron: current.cron,
        zone: current.zone,
        prompt: text_of(&schedule.run.prompt),
        added_by_you: schedule.made_call.is_some(),
    })
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    fn at(text: &str) -> u64 {
        let at: jiff::Timestamp = text.parse().expect("a time");
        u64::try_from(at.as_millisecond()).expect("after 1970")
    }

    #[test]
    fn a_bots_own_schedule_comes_every_five_minutes_at_most() {
        let now = at("2026-11-04T00:30:00Z");
        let often = |cron: &str| {
            let plan = Plan::new(cron, "UTC").expect("a plan");
            too_often(&plan, now).map(|(first, then)| (plan.describe(first), plan.describe(then)))
        };
        for fine in [
            "*/5 * * * *",
            "0 9 * * 1-5",
            "@daily",
            "0 9 1 1 *",
            "55 23 * * *",
            "0,30 * * * *",
        ] {
            assert_eq!(often(fine), None, "{fine}");
        }
        let pair = |first: &str, then: &str| Some((first.to_owned(), then.to_owned()));
        assert_eq!(
            often("* * * * *"),
            pair("Wed 4 Nov 00:31 UTC", "Wed 4 Nov 00:32 UTC")
        );
        assert_eq!(
            often("*/4 * * * *"),
            pair("Wed 4 Nov 00:32 UTC", "Wed 4 Nov 00:36 UTC")
        );
        assert_eq!(
            often("0,1 9 * * *"),
            pair("Wed 4 Nov 09:00 UTC", "Wed 4 Nov 09:01 UTC")
        );
        // Over the turn of the day: 23:59 and the next day's 00:00.
        assert_eq!(
            often("0,59 0,23 * * *"),
            pair("Wed 4 Nov 23:59 UTC", "Thu 5 Nov 00:00 UTC")
        );
    }
}
