//! Schedules and their occurrences (WVE-145). An occurrence is written down, with the
//! delivery that starts it, in one transaction, keyed on its schedule and scheduled time, so
//! however often the Dispatcher considers that time it records it once, and a restart neither
//! loses it nor starts it again. A one-off has one time (`at`), and a Bot's schedule prompts
//! the Bot, skipping its occurrences while the Bot is paused (WVE-118). A Bot's own wake-up is a
//! one-off its thread asked for (`wake_call`), counted, listed and cancelled while it's still to
//! come, and forgotten a week after its time once its occurrence is over. A schedule a Bot added
//! itself (`made_call`, WVE-178) is counted among the Bot's schedules as it's added.

use rusqlite::Connection;
use rusqlite::OptionalExtension as _;
use rusqlite::Transaction;
use rusqlite::params;
use weave_host_protocol::dispatcher::Missed;
use weave_host_protocol::dispatcher::Occurrence;
use weave_host_protocol::dispatcher::OccurrenceState;
use weave_host_protocol::dispatcher::Overlap;
use weave_host_protocol::dispatcher::ScheduledRun;
use weave_host_protocol::threads::ThreadId;
use weave_host_protocol::threads::TurnState;

use super::Delivery;
use super::Store;
use super::Work;
use super::failed;
use super::from_sql;
use super::insert_delivery;
use super::json;
use super::random_id;
use super::to_sql;
use crate::now_ms;

/// Failed or interrupted occurrences in a row that pause a schedule.
pub(crate) const FAILURES_TO_PAUSE: u32 = 3;

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct StoredSchedule {
    pub(crate) id: String,
    pub(crate) name: String,
    /// Empty for a one-off.
    pub(crate) cron: String,
    /// A one-off's time.
    pub(crate) at: Option<u64>,
    pub(crate) zone: String,
    /// The Bot's Host, for a Bot's schedule.
    pub(crate) host_id: String,
    /// What it was added with; for a Bot's schedule its prompt, the rest being the Bot's.
    pub(crate) run: ScheduledRun,
    /// The Bot each occurrence prompts.
    pub(crate) bot_id: Option<String>,
    pub(crate) missed: Missed,
    pub(crate) overlap: Overlap,
    pub(crate) created_at: u64,
    /// The times up to which its occurrences have been considered.
    pub(crate) considered_until: u64,
    pub(crate) paused: Option<String>,
    pub(crate) failures: u32,
    /// For a Bot's own wake-up, the Host's id for the `wake_me` call that asked for it.
    pub(crate) wake_call: Option<String>,
    /// For a schedule a Bot added itself, the Host's id for the `add_schedule` call that added
    /// it.
    pub(crate) made_call: Option<String>,
}

impl StoredSchedule {
    pub(crate) fn new_id() -> String {
        format!("sch-{}", random_id())
    }
}

/// What writing down a Bot's wake-up did.
#[derive(Debug, PartialEq)]
pub(crate) enum WakeUp {
    /// Written down.
    Added(StoredSchedule),
    /// The call that asked for it was written down before: the wake-up it made.
    Again(StoredSchedule),
    /// The Bot has this many still to come, the most it may have.
    Full(u32),
}

/// What writing down a schedule a Bot added itself did.
#[derive(Debug, PartialEq)]
pub(crate) enum BotSchedule {
    /// Written down.
    Added(StoredSchedule),
    /// The call that added it was written down before: the schedule it added.
    Again(StoredSchedule),
    /// The Bot has this many schedules, wake-ups aside, the most it may have when it adds one.
    Full(u32),
}

/// A Bot's wake-up still to come: its time not yet reached by the scheduler, and no occurrence
/// of it but by hand.
const TO_COME: &str = "schedules.wake_call IS NOT NULL \
     AND schedules.considered_until < schedules.at AND NOT EXISTS (SELECT 1 FROM occurrences \
     WHERE occurrences.schedule_id = schedules.id AND occurrences.manual = 0)";

/// What considering an occurrence did.
pub(crate) enum Fired {
    /// Written down, with the delivery that starts it.
    Started(Occurrence, Box<Delivery>),
    /// Written down as skipped, saying why.
    Skipped(Occurrence),
    /// Written down before.
    Already,
}

/// How an occurrence ended.
pub(crate) enum Ending<'a> {
    /// Its Host refused it.
    Refused(&'a str),
    /// Its turn is over.
    Turn {
        outcome: TurnState,
        why: Option<String>,
        /// The agent's login has expired, so it fails until someone signs in again.
        signed_out: bool,
    },
}

const SELECT_SCHEDULE: &str = "SELECT id, name, cron, zone, host_id, run, missed, overlap, \
     created_at, considered_until, paused, failures, at, bot_id, wake_call, made_call FROM schedules";

const SELECT_OCCURRENCE: &str = "SELECT id, schedule_id, scheduled_at, late, manual, state, \
     outcome, why, thread_id, turn_id, recorded_at, ended_at FROM occurrences";

impl Store {
    pub(crate) fn add_schedule(&self, schedule: &StoredSchedule) -> Result<(), String> {
        insert_schedule(&self.lock(), schedule)
    }

    /// Write down `schedule`, a Bot's wake-up, unless the call that asked for it was written
    /// down before, or the Bot has `most` still to come already.
    pub(crate) fn add_wake_up(
        &self,
        schedule: &StoredSchedule,
        most: u32,
    ) -> Result<WakeUp, String> {
        let mut connection = self.lock();
        let transaction = connection.transaction().map_err(failed)?;
        let before = transaction
            .query_row(
                &format!("{SELECT_SCHEDULE} WHERE bot_id = ?1 AND wake_call = ?2"),
                params![schedule.bot_id, schedule.wake_call],
                self::schedule,
            )
            .optional()
            .map_err(failed)?;
        if let Some(before) = before {
            return Ok(WakeUp::Again(before));
        }
        let coming: u32 = transaction
            .query_row(
                &format!("SELECT count(*) FROM schedules WHERE bot_id = ?1 AND {TO_COME}"),
                params![schedule.bot_id],
                |row| row.get(0),
            )
            .map_err(failed)?;
        if coming >= most {
            return Ok(WakeUp::Full(coming));
        }
        insert_schedule(&transaction, schedule)?;
        transaction.commit().map_err(failed)?;
        Ok(WakeUp::Added(schedule.clone()))
    }

    /// Write down `schedule`, which a Bot added itself, unless the call that added it was
    /// written down before, or the Bot has `most` schedules already, wake-ups aside, its
    /// person's included.
    pub(crate) fn add_bot_schedule(
        &self,
        schedule: &StoredSchedule,
        most: u32,
    ) -> Result<BotSchedule, String> {
        let mut connection = self.lock();
        let transaction = connection.transaction().map_err(failed)?;
        let before = transaction
            .query_row(
                &format!("{SELECT_SCHEDULE} WHERE bot_id = ?1 AND made_call = ?2"),
                params![schedule.bot_id, schedule.made_call],
                self::schedule,
            )
            .optional()
            .map_err(failed)?;
        if let Some(before) = before {
            return Ok(BotSchedule::Again(before));
        }
        let had: u32 = transaction
            .query_row(
                "SELECT count(*) FROM schedules WHERE bot_id = ?1 AND wake_call IS NULL",
                params![schedule.bot_id],
                |row| row.get(0),
            )
            .map_err(failed)?;
        if had >= most {
            return Ok(BotSchedule::Full(had));
        }
        insert_schedule(&transaction, schedule)?;
        transaction.commit().map_err(failed)?;
        Ok(BotSchedule::Added(schedule.clone()))
    }

    /// `bot_id`'s wake-ups still to come, soonest first.
    pub(crate) fn wake_ups(&self, bot_id: &str) -> Result<Vec<StoredSchedule>, String> {
        let connection = self.lock();
        let mut statement = connection
            .prepare(&format!(
                "{SELECT_SCHEDULE} WHERE bot_id = ?1 AND {TO_COME} ORDER BY at, id"
            ))
            .map_err(failed)?;
        let rows = statement
            .query_map(params![bot_id], schedule)
            .map_err(failed)?;
        rows.collect::<Result<_, _>>().map_err(failed)
    }

    /// Forget `bot_id`'s wake-up `id` if it's still to come, giving what it was.
    pub(crate) fn cancel_wake_up(
        &self,
        bot_id: &str,
        id: &str,
    ) -> Result<Option<StoredSchedule>, String> {
        let mut connection = self.lock();
        let transaction = connection.transaction().map_err(failed)?;
        let found = transaction
            .query_row(
                &format!("{SELECT_SCHEDULE} WHERE id = ?1 AND bot_id = ?2 AND {TO_COME}"),
                params![id, bot_id],
                schedule,
            )
            .optional()
            .map_err(failed)?;
        if found.is_some() {
            transaction
                .execute("DELETE FROM schedules WHERE id = ?1", params![id])
                .map_err(failed)?;
            transaction.commit().map_err(failed)?;
        }
        Ok(found)
    }

    /// Forget the Bots' wake-ups whose time was before `before` and whose occurrence, if it
    /// has one, is over: how many.
    pub(crate) fn prune_wake_ups(&self, before: u64) -> Result<usize, String> {
        self.lock()
            .execute(
                "DELETE FROM schedules WHERE wake_call IS NOT NULL AND at < ?1 \
                 AND NOT EXISTS (SELECT 1 FROM occurrences \
                 WHERE occurrences.schedule_id = schedules.id \
                 AND occurrences.state IN ('waiting', 'started'))",
                params![to_sql(before)],
            )
            .map_err(failed)
    }

    pub(crate) fn schedules(&self) -> Result<Vec<StoredSchedule>, String> {
        let connection = self.lock();
        let mut statement = connection
            .prepare(&format!("{SELECT_SCHEDULE} ORDER BY name"))
            .map_err(failed)?;
        let rows = statement.query_map([], schedule).map_err(failed)?;
        rows.collect::<Result<_, _>>().map_err(failed)
    }

    /// The schedule `by` names, by id or else by name.
    pub(crate) fn find_schedule(&self, by: &str) -> Result<Option<StoredSchedule>, String> {
        let connection = self.lock();
        let found = connection
            .query_row(
                &format!("{SELECT_SCHEDULE} WHERE id = ?1"),
                params![by],
                schedule,
            )
            .optional()
            .map_err(failed)?;
        match found {
            Some(found) => Ok(Some(found)),
            None => connection
                .query_row(
                    &format!("{SELECT_SCHEDULE} WHERE name = ?1"),
                    params![by],
                    schedule,
                )
                .optional()
                .map_err(failed),
        }
    }

    pub(crate) fn remove_schedule(&self, id: &str) -> Result<bool, String> {
        self.lock()
            .execute("DELETE FROM schedules WHERE id = ?1", params![id])
            .map(|removed| removed > 0)
            .map_err(failed)
    }

    pub(crate) fn pause(&self, id: &str, why: &str) -> Result<(), String> {
        self.lock()
            .execute(
                "UPDATE schedules SET paused = ?2 WHERE id = ?1",
                params![id, why],
            )
            .map(drop)
            .map_err(failed)
    }

    /// Run again from `now`, catching up nothing missed while paused, its failures forgotten.
    pub(crate) fn resume(&self, id: &str, now: u64) -> Result<(), String> {
        self.lock()
            .execute(
                "UPDATE schedules SET paused = NULL, failures = 0, considered_until = ?2 \
                 WHERE id = ?1",
                params![id, to_sql(now)],
            )
            .map(drop)
            .map_err(failed)
    }

    /// Its occurrences up to `until` have been considered.
    pub(crate) fn considered(&self, id: &str, until: u64) -> Result<(), String> {
        self.lock()
            .execute(
                "UPDATE schedules SET considered_until = max(considered_until, ?2) WHERE id = ?1",
                params![id, to_sql(until)],
            )
            .map(drop)
            .map_err(failed)
    }

    /// Write down the occurrence of `schedule_id` due `at` as skipped, saying `why`, unless it
    /// was written down before.
    pub(crate) fn skip(
        &self,
        schedule_id: &str,
        at: u64,
        why: &str,
        now: u64,
    ) -> Result<Option<Occurrence>, String> {
        let mut connection = self.lock();
        let transaction = connection.transaction().map_err(failed)?;
        let skipped = insert_occurrence(
            &transaction,
            &NewOccurrence {
                id: occurrence_id(),
                schedule_id,
                at,
                late: false,
                manual: false,
                state: OccurrenceState::Skipped,
                why: Some(why),
                delivery_id: None,
                now,
            },
        )
        .map_err(failed)?;
        transaction.commit().map_err(failed)?;
        Ok(skipped)
    }

    /// Write down `schedule`'s occurrence due `at`, and the delivery `work` makes for it from
    /// the occurrence's id, or skip it while the schedule's previous one is still waiting or
    /// running, unless the schedule allows that, or while the Bot it prompts is paused, unless
    /// it's run by hand.
    pub(crate) fn fire(
        &self,
        schedule: &StoredSchedule,
        at: u64,
        late: bool,
        manual: bool,
        now: u64,
        work: impl FnOnce(&str) -> Work,
    ) -> Result<Fired, String> {
        let mut connection = self.lock();
        let transaction = connection.transaction().map_err(failed)?;
        let seen: bool = transaction
            .query_row(
                "SELECT count(*) > 0 FROM occurrences \
                 WHERE schedule_id = ?1 AND scheduled_at = ?2 AND manual = ?3",
                params![schedule.id, to_sql(at), manual],
                |row| row.get(0),
            )
            .map_err(failed)?;
        if seen {
            return Ok(Fired::Already);
        }
        let overlaps = schedule.overlap == Overlap::Skip || schedule.run.thread.is_some();
        let going: bool = overlaps
            && transaction
                .query_row(
                    "SELECT count(*) > 0 FROM occurrences \
                     WHERE schedule_id = ?1 AND state IN ('waiting', 'started')",
                    params![schedule.id],
                    |row| row.get(0),
                )
                .map_err(failed)?;
        let paused: Option<(String, String)> = match (&schedule.bot_id, manual) {
            (Some(bot_id), false) => transaction
                .query_row(
                    "SELECT name, paused FROM bots WHERE id = ?1 AND paused IS NOT NULL",
                    params![bot_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(failed)?,
            _ => None,
        };
        let skipping = match paused {
            Some((bot, why)) => Some(format!("the Bot {bot} is paused: {why}")),
            None if going => {
                Some("its previous occurrence was still waiting or running".to_owned())
            }
            None => None,
        };
        let id = occurrence_id();
        let fired = if let Some(why) = &skipping {
            let skipped = insert_occurrence(
                &transaction,
                &NewOccurrence {
                    id,
                    schedule_id: &schedule.id,
                    at,
                    late,
                    manual,
                    state: OccurrenceState::Skipped,
                    why: Some(why),
                    delivery_id: None,
                    now,
                },
            )
            .map_err(failed)?;
            skipped.map_or(Fired::Already, Fired::Skipped)
        } else {
            let delivery =
                insert_delivery(&transaction, &schedule.host_id, work(&id)).map_err(failed)?;
            let started = insert_occurrence(
                &transaction,
                &NewOccurrence {
                    id,
                    schedule_id: &schedule.id,
                    at,
                    late,
                    manual,
                    state: OccurrenceState::Waiting,
                    why: None,
                    delivery_id: Some(&delivery.id),
                    now,
                },
            )
            .map_err(failed)?;
            match started {
                Some(occurrence) => Fired::Started(occurrence, Box::new(delivery)),
                None => Fired::Already,
            }
        };
        transaction.commit().map_err(failed)?;
        Ok(fired)
    }

    /// The occurrences on `host_id` whose turn started and hasn't been seen to end: each one's
    /// id, thread and turn.
    pub(crate) fn started(&self, host_id: &str) -> Result<Vec<(String, String, String)>, String> {
        let connection = self.lock();
        let mut statement = connection
            .prepare(
                "SELECT occurrences.id, occurrences.thread_id, occurrences.turn_id \
                 FROM occurrences JOIN schedules ON schedules.id = occurrences.schedule_id \
                 WHERE schedules.host_id = ?1 AND occurrences.state = 'started' \
                 AND occurrences.thread_id IS NOT NULL AND occurrences.turn_id IS NOT NULL",
            )
            .map_err(failed)?;
        let rows = statement
            .query_map(params![host_id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .map_err(failed)?;
        rows.collect::<Result<_, _>>().map_err(failed)
    }

    /// The occurrence `id`'s turn was interrupted, and its thread continued it in `turn_id`,
    /// which it ends with.
    pub(crate) fn continued(&self, id: &str, turn_id: &str) -> Result<(), String> {
        self.lock()
            .execute(
                "UPDATE occurrences SET turn_id = ?2 WHERE id = ?1 AND state = 'started'",
                params![id, turn_id],
            )
            .map(drop)
            .map_err(failed)
    }

    /// The occurrence `id`'s turn is over, as `outcome` says.
    pub(crate) fn finish(
        &self,
        id: &str,
        outcome: TurnState,
        why: Option<String>,
        signed_out: bool,
    ) -> Result<(), String> {
        let mut connection = self.lock();
        let transaction = connection.transaction().map_err(failed)?;
        end(
            &transaction,
            id,
            Ending::Turn {
                outcome,
                why,
                signed_out,
            },
        )
        .map_err(failed)?;
        transaction.commit().map_err(failed)
    }

    /// The latest occurrences, of `schedule_id` or of every schedule, newest first.
    pub(crate) fn occurrences(
        &self,
        schedule_id: Option<&str>,
        limit: u32,
    ) -> Result<Vec<Occurrence>, String> {
        let connection = self.lock();
        let order = "ORDER BY scheduled_at DESC, recorded_at DESC LIMIT";
        let mut statement = match schedule_id {
            Some(_) => connection.prepare(&format!(
                "{SELECT_OCCURRENCE} WHERE schedule_id = ?1 {order} ?2"
            )),
            None => connection.prepare(&format!("{SELECT_OCCURRENCE} {order} ?1")),
        }
        .map_err(failed)?;
        let rows = match schedule_id {
            Some(schedule_id) => statement.query_map(params![schedule_id, limit], occurrence),
            None => statement.query_map(params![limit], occurrence),
        }
        .map_err(failed)?;
        rows.collect::<Result<_, _>>().map_err(failed)
    }
}

/// End occurrence `id` as `ending` says, and count it toward pausing its schedule: a failure
/// or interruption adds one, and three in a row pause it; any other ending forgets them. An
/// agent signed out pauses it at once.
pub(super) fn end(
    transaction: &Transaction<'_>,
    id: &str,
    ending: Ending<'_>,
) -> rusqlite::Result<()> {
    let (state, outcome, why, failing, signed_out) = match ending {
        Ending::Refused(why) => (
            OccurrenceState::Failed,
            None,
            Some(why.to_owned()),
            true,
            false,
        ),
        Ending::Turn {
            outcome,
            why,
            signed_out,
        } => (
            OccurrenceState::Finished,
            Some(outcome),
            why,
            matches!(outcome, TurnState::Failed | TurnState::Interrupted),
            signed_out,
        ),
    };
    let updated = transaction.execute(
        "UPDATE occurrences SET state = ?2, outcome = ?3, why = ?4, ended_at = ?5 \
         WHERE id = ?1 AND state IN ('waiting', 'started')",
        params![
            id,
            name_of(&state),
            outcome.as_ref().map(name_of),
            why,
            to_sql(now_ms())
        ],
    )?;
    if updated == 0 {
        return Ok(());
    }
    let schedule_id: String = transaction.query_row(
        "SELECT schedule_id FROM occurrences WHERE id = ?1",
        params![id],
        |row| row.get(0),
    )?;
    if !failing {
        transaction.execute(
            "UPDATE schedules SET failures = 0 WHERE id = ?1",
            params![schedule_id],
        )?;
        return Ok(());
    }
    transaction.execute(
        "UPDATE schedules SET failures = failures + 1 WHERE id = ?1",
        params![schedule_id],
    )?;
    let failures: u32 = transaction.query_row(
        "SELECT failures FROM schedules WHERE id = ?1",
        params![schedule_id],
        |row| row.get(0),
    )?;
    let last = why.unwrap_or_else(|| "no reason given".to_owned());
    let paused = if signed_out {
        Some(format!(
            "its agent needs signing in again on its Host ({last})"
        ))
    } else if failures >= FAILURES_TO_PAUSE {
        Some(format!(
            "it failed {failures} times in a row; the last said: {last}"
        ))
    } else {
        None
    };
    if let Some(paused) = paused {
        transaction.execute(
            "UPDATE schedules SET paused = ?2 WHERE id = ?1 AND paused IS NULL",
            params![schedule_id, paused],
        )?;
    }
    Ok(())
}

/// Write `schedule` down, or say why it can't be.
fn insert_schedule(connection: &Connection, schedule: &StoredSchedule) -> Result<(), String> {
    let run = serde_json::to_string(&schedule.run).map_err(|error| error.to_string())?;
    connection
        .execute(
            "INSERT INTO schedules (id, name, cron, zone, host_id, run, missed, overlap, \
             created_at, considered_until, paused, failures, at, bot_id, wake_call, made_call) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
            params![
                schedule.id,
                schedule.name,
                schedule.cron,
                schedule.zone,
                schedule.host_id,
                run,
                name_of(&schedule.missed),
                name_of(&schedule.overlap),
                to_sql(schedule.created_at),
                to_sql(schedule.considered_until),
                schedule.paused,
                schedule.failures,
                schedule.at.map(to_sql),
                schedule.bot_id,
                schedule.wake_call,
                schedule.made_call
            ],
        )
        .map(drop)
        .map_err(|error| match error {
            rusqlite::Error::SqliteFailure(failure, Some(message))
                if failure.code == rusqlite::ErrorCode::ConstraintViolation
                    && message.contains("schedules.name") =>
            {
                format!("there's a schedule called {} already", schedule.name)
            }
            rusqlite::Error::SqliteFailure(failure, _)
                if failure.code == rusqlite::ErrorCode::ConstraintViolation =>
            {
                format!(
                    "the Host or Bot the schedule {} names has gone from the Dispatcher",
                    schedule.name
                )
            }
            other => failed(other),
        })
}

struct NewOccurrence<'a> {
    id: String,
    schedule_id: &'a str,
    at: u64,
    late: bool,
    manual: bool,
    state: OccurrenceState,
    why: Option<&'a str>,
    delivery_id: Option<&'a str>,
    now: u64,
}

/// Write `new` down, unless its schedule's occurrence at that time was written down before.
fn insert_occurrence(
    connection: &Connection,
    new: &NewOccurrence<'_>,
) -> rusqlite::Result<Option<Occurrence>> {
    let inserted = connection.execute(
        "INSERT OR IGNORE INTO occurrences (id, schedule_id, scheduled_at, late, manual, state, \
         why, delivery_id, recorded_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            new.id,
            new.schedule_id,
            to_sql(new.at),
            new.late,
            new.manual,
            name_of(&new.state),
            new.why,
            new.delivery_id,
            to_sql(new.now)
        ],
    )?;
    if inserted == 0 {
        return Ok(None);
    }
    connection
        .query_row(
            &format!("{SELECT_OCCURRENCE} WHERE id = ?1"),
            params![new.id],
            occurrence,
        )
        .map(Some)
}

fn occurrence_id() -> String {
    format!("occ-{}", random_id())
}

fn schedule(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredSchedule> {
    Ok(StoredSchedule {
        id: row.get(0)?,
        name: row.get(1)?,
        cron: row.get(2)?,
        zone: row.get(3)?,
        host_id: row.get(4)?,
        run: json(5, &row.get::<_, String>(5)?)?,
        missed: named(6, &row.get::<_, String>(6)?)?,
        overlap: named(7, &row.get::<_, String>(7)?)?,
        created_at: from_sql(row.get(8)?),
        considered_until: from_sql(row.get(9)?),
        paused: row.get(10)?,
        failures: row.get(11)?,
        at: row.get::<_, Option<i64>>(12)?.map(from_sql),
        bot_id: row.get(13)?,
        wake_call: row.get(14)?,
        made_call: row.get(15)?,
    })
}

fn occurrence(row: &rusqlite::Row<'_>) -> rusqlite::Result<Occurrence> {
    Ok(Occurrence {
        id: row.get(0)?,
        schedule_id: row.get(1)?,
        scheduled_at: from_sql(row.get(2)?),
        late: row.get(3)?,
        manual: row.get(4)?,
        state: named(5, &row.get::<_, String>(5)?)?,
        outcome: row
            .get::<_, Option<String>>(6)?
            .map(|text| named(6, &text))
            .transpose()?,
        why: row.get(7)?,
        thread_id: row.get::<_, Option<String>>(8)?.map(ThreadId::new),
        turn_id: row.get(9)?,
        recorded_at: from_sql(row.get(10)?),
        ended_at: row.get::<_, Option<i64>>(11)?.map(from_sql),
    })
}

/// A unit variant's name, as serde gives it: `latest`, `skipped`, `interrupted`.
fn name_of(value: &impl serde::Serialize) -> String {
    match serde_json::to_value(value) {
        Ok(serde_json::Value::String(name)) => name,
        _ => String::new(),
    }
}

/// The unit variant named `name` in column `index`.
fn named<T: serde::de::DeserializeOwned>(index: usize, name: &str) -> rusqlite::Result<T> {
    json(
        index,
        &serde_json::Value::String(name.to_owned()).to_string(),
    )
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;
    use weave_acp_core::schema::ContentBlock;
    use weave_host_protocol::policy::PermissionPolicy;
    use weave_host_protocol::queue::AddQueuedRequest;

    use super::*;
    use crate::store::StoredHost;

    fn store() -> (Store, StoredSchedule) {
        let store = Store::in_memory();
        store
            .put_host(&StoredHost {
                host_id: "h1".to_owned(),
                name: "studio".to_owned(),
                url: "wss://studio".to_owned(),
                device_id: "d-1".to_owned(),
                paired_at: 1,
                refused: None,
                public_key: None,
                joined_at: None,
                here: false,
            })
            .expect("a Host");
        let schedule = StoredSchedule {
            id: "sch-1".to_owned(),
            name: "daily".to_owned(),
            cron: "0 9 * * *".to_owned(),
            at: None,
            zone: "UTC".to_owned(),
            host_id: "h1".to_owned(),
            bot_id: None,
            run: ScheduledRun {
                agent_id: "fake".to_owned(),
                cwd: "/repo".into(),
                prompt: vec![ContentBlock::from("hello".to_owned())],
                policy: PermissionPolicy::ask(),
                mode: None,
                thread: None,
            },
            missed: Missed::Latest,
            overlap: Overlap::Skip,
            created_at: 1,
            considered_until: 1,
            paused: None,
            failures: 0,
            wake_call: None,
            made_call: None,
        };
        store.add_schedule(&schedule).expect("a schedule");
        (store, schedule)
    }

    /// A wake-up of `bot_id`'s at `at`, asked for by the call `call`.
    fn wake_up(base: &StoredSchedule, bot_id: &str, call: &str, at: u64) -> StoredSchedule {
        let id = StoredSchedule::new_id();
        StoredSchedule {
            name: format!("wake-up-{id}"),
            id,
            cron: String::new(),
            at: Some(at),
            bot_id: Some(bot_id.to_owned()),
            wake_call: Some(call.to_owned()),
            ..base.clone()
        }
    }

    #[test]
    fn a_bots_wake_ups_are_counted_listed_cancelled_and_forgotten_once_done() {
        let (store, base) = store();
        let bot = store
            .add_bot(
                &crate::store::NewBot {
                    name: "odin".to_owned(),
                    host_id: "h1".to_owned(),
                    agent_id: "fake".to_owned(),
                    home: "~/odin".into(),
                    policy: PermissionPolicy::ask(),
                    mode: None,
                    new_thread_at: None,
                    created_by: None,
                    emoji: None,
                    color: None,
                    zone: "UTC".to_owned(),
                    pause_after: 1000,
                },
                1,
            )
            .expect("a Bot");
        let first = wake_up(&base, &bot.id, "c-1", 1000);
        assert_eq!(
            store.add_wake_up(&first, 2).expect("written"),
            WakeUp::Added(first.clone())
        );
        // The same call again, as a Host repeating it would: the one it made.
        let repeat = wake_up(&base, &bot.id, "c-1", 5000);
        assert_eq!(
            store.add_wake_up(&repeat, 2).expect("read"),
            WakeUp::Again(first.clone())
        );
        let second = wake_up(&base, &bot.id, "c-2", 500);
        assert!(matches!(
            store.add_wake_up(&second, 2).expect("written"),
            WakeUp::Added(_)
        ));
        assert_eq!(
            store
                .add_wake_up(&wake_up(&base, &bot.id, "c-3", 700), 2)
                .expect("read"),
            WakeUp::Full(2)
        );
        let ids = |listed: Vec<StoredSchedule>| -> Vec<String> {
            listed.into_iter().map(|schedule| schedule.id).collect()
        };
        assert_eq!(
            ids(store.wake_ups(&bot.id).expect("listed")),
            [second.id.clone(), first.id.clone()],
            "soonest first, and not the person's schedule"
        );

        assert_eq!(
            store
                .cancel_wake_up(&bot.id, &second.id)
                .expect("cancelled")
                .map(|schedule| schedule.id),
            Some(second.id.clone())
        );
        assert_eq!(
            store.cancel_wake_up(&bot.id, &second.id).expect("asked"),
            None
        );
        assert_eq!(
            store.cancel_wake_up(&bot.id, &base.id).expect("asked"),
            None,
            "the person's own schedule isn't a wake-up"
        );

        // Its time comes: no longer to come, nor to cancel, and forgotten once it's over.
        let Fired::Started(occurrence, _) = store
            .fire(&first, 1000, false, false, 1000, work)
            .expect("fired")
        else {
            panic!("started");
        };
        assert_eq!(
            ids(store.wake_ups(&bot.id).expect("listed")),
            [] as [String; 0]
        );
        assert_eq!(
            store.cancel_wake_up(&bot.id, &first.id).expect("asked"),
            None
        );
        assert_eq!(
            store.prune_wake_ups(2000).expect("pruned"),
            0,
            "still going"
        );
        store
            .finish(&occurrence.id, TurnState::Ended, None, false)
            .expect("finished");
        assert_eq!(store.prune_wake_ups(1000).expect("pruned"), 0, "not yet");
        assert_eq!(store.prune_wake_ups(2000).expect("pruned"), 1);
        assert_eq!(store.find_schedule(&first.id).expect("read"), None);
        assert!(store.find_schedule(&base.id).expect("read").is_some());
    }

    #[test]
    fn a_bots_own_schedules_are_counted_with_the_persons_but_not_its_wake_ups() {
        let (store, base) = store();
        let bot = store
            .add_bot(
                &crate::store::NewBot {
                    name: "odin".to_owned(),
                    host_id: "h1".to_owned(),
                    agent_id: "fake".to_owned(),
                    home: "~/odin".into(),
                    policy: PermissionPolicy::ask(),
                    mode: None,
                    new_thread_at: None,
                    created_by: None,
                    emoji: None,
                    color: None,
                    zone: "UTC".to_owned(),
                    pause_after: 1000,
                },
                1,
            )
            .expect("a Bot");
        let named = |name: &str, call: Option<&str>| StoredSchedule {
            id: StoredSchedule::new_id(),
            name: name.to_owned(),
            bot_id: Some(bot.id.clone()),
            made_call: call.map(str::to_owned),
            ..base.clone()
        };
        store
            .add_schedule(&named("the person's", None))
            .expect("the person's own for odin");
        store
            .add_wake_up(&wake_up(&base, &bot.id, "c-0", 1000), 5)
            .expect("a wake-up");
        let first = named("first", Some("c-1"));
        assert_eq!(
            store.add_bot_schedule(&first, 3).expect("written"),
            BotSchedule::Added(first.clone())
        );
        // The same call again, as a Host repeating it would: the one it added.
        assert_eq!(
            store
                .add_bot_schedule(&named("again", Some("c-1")), 3)
                .expect("read"),
            BotSchedule::Again(first)
        );
        assert!(matches!(
            store
                .add_bot_schedule(&named("second", Some("c-2")), 3)
                .expect("written"),
            BotSchedule::Added(_)
        ));
        assert_eq!(
            store
                .add_bot_schedule(&named("third", Some("c-3")), 3)
                .expect("read"),
            BotSchedule::Full(3),
            "the person's counts, the wake-up doesn't"
        );
        assert_eq!(
            store
                .find_schedule("first")
                .expect("read")
                .map(|found| found.made_call),
            Some(Some("c-1".to_owned()))
        );
    }

    fn work(occurrence: &str) -> Work {
        Work::Queue(AddQueuedRequest {
            thread_id: "s-1".into(),
            prompt: Vec::new(),
            key: Some(format!("schedule/{occurrence}")),
            caller: None,
            origin: None,
        })
    }

    #[test]
    fn an_occurrence_is_written_down_once_with_its_delivery() {
        let (store, schedule) = store();
        let Fired::Started(occurrence, delivery) = store
            .fire(&schedule, 100, false, false, 100, work)
            .expect("fired")
        else {
            panic!("started");
        };
        assert_eq!(occurrence.state, OccurrenceState::Waiting);
        assert!(matches!(
            store
                .fire(&schedule, 100, false, false, 101, work)
                .expect("again"),
            Fired::Already
        ));
        store
            .delivered(&delivery.id, &serde_json::json!({"queuedId": "q-1"}))
            .expect("delivered");
        let listed = store.occurrences(Some(&schedule.id), 10).expect("listed");
        assert_eq!(listed[0].state, OccurrenceState::Started);
        assert_eq!(listed[0].thread_id, Some("s-1".into()));
        assert_eq!(listed[0].turn_id.as_deref(), Some("q-1"));
        assert_eq!(store.started("h1").expect("started").len(), 1);
    }

    #[test]
    fn one_still_going_skips_the_next_and_failures_in_a_row_pause_the_schedule() {
        let (store, schedule) = store();
        let Fired::Started(first, _) = store
            .fire(&schedule, 100, false, false, 100, work)
            .expect("fired")
        else {
            panic!("started");
        };
        let Fired::Skipped(skipped) = store
            .fire(&schedule, 200, false, false, 200, work)
            .expect("fired")
        else {
            panic!("skipped");
        };
        assert_eq!(
            skipped.why.as_deref(),
            Some("its previous occurrence was still waiting or running")
        );

        store
            .finish(&first.id, TurnState::Failed, Some("boom".to_owned()), false)
            .expect("finished");
        for at in [300, 400] {
            let Fired::Started(_, delivery) = store
                .fire(&schedule, at, false, false, at, work)
                .expect("fired")
            else {
                panic!("started");
            };
            store.failed(&delivery.id, "no such agent").expect("failed");
        }
        let paused = store
            .find_schedule("daily")
            .expect("found")
            .expect("there")
            .paused;
        assert_eq!(
            paused.as_deref(),
            Some("it failed 3 times in a row; the last said: no such agent")
        );
        store.resume(&schedule.id, 500).expect("resumed");
        let resumed = store
            .find_schedule(&schedule.id)
            .expect("found")
            .expect("there");
        assert_eq!(
            (resumed.paused, resumed.failures, resumed.considered_until),
            (None, 0, 500)
        );
    }
}
