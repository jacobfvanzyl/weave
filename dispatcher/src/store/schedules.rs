//! Schedules and their occurrences (WVE-145). An occurrence is written down, with the
//! delivery that starts it, in one transaction, keyed on its schedule and scheduled time, so
//! however often the Dispatcher considers that time it records it once, and a restart neither
//! loses it nor starts it again.

use agent_client_protocol::schema::v1::SessionId;
use rusqlite::Connection;
use rusqlite::OptionalExtension as _;
use rusqlite::Transaction;
use rusqlite::params;
use weave_host_protocol::dispatcher::Missed;
use weave_host_protocol::dispatcher::Occurrence;
use weave_host_protocol::dispatcher::OccurrenceState;
use weave_host_protocol::dispatcher::Overlap;
use weave_host_protocol::dispatcher::ScheduledRun;
use weave_host_protocol::sessions::TurnState;

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
    pub(crate) cron: String,
    pub(crate) zone: String,
    pub(crate) host_id: String,
    pub(crate) run: ScheduledRun,
    pub(crate) missed: Missed,
    pub(crate) overlap: Overlap,
    pub(crate) created_at: u64,
    /// The times up to which its occurrences have been considered.
    pub(crate) considered_until: u64,
    pub(crate) paused: Option<String>,
    pub(crate) failures: u32,
}

impl StoredSchedule {
    pub(crate) fn new_id() -> String {
        format!("sch-{}", random_id())
    }
}

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
     created_at, considered_until, paused, failures FROM schedules";

const SELECT_OCCURRENCE: &str = "SELECT id, schedule_id, scheduled_at, late, manual, state, \
     outcome, why, session_id, turn_id, recorded_at, ended_at FROM occurrences";

impl Store {
    pub(crate) fn add_schedule(&self, schedule: &StoredSchedule) -> Result<(), String> {
        let run = serde_json::to_string(&schedule.run).map_err(|error| error.to_string())?;
        self.lock()
            .execute(
                "INSERT INTO schedules (id, name, cron, zone, host_id, run, missed, overlap, \
                 created_at, considered_until, paused, failures) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
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
                    schedule.failures
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
                other => failed(other),
            })
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
    /// running, unless the schedule allows that.
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
        let id = occurrence_id();
        let fired = if going {
            let skipped = insert_occurrence(
                &transaction,
                &NewOccurrence {
                    id,
                    schedule_id: &schedule.id,
                    at,
                    late,
                    manual,
                    state: OccurrenceState::Skipped,
                    why: Some("its previous occurrence was still waiting or running"),
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
                "SELECT occurrences.id, occurrences.session_id, occurrences.turn_id \
                 FROM occurrences JOIN schedules ON schedules.id = occurrences.schedule_id \
                 WHERE schedules.host_id = ?1 AND occurrences.state = 'started' \
                 AND occurrences.session_id IS NOT NULL AND occurrences.turn_id IS NOT NULL",
            )
            .map_err(failed)?;
        let rows = statement
            .query_map(params![host_id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .map_err(failed)?;
        rows.collect::<Result<_, _>>().map_err(failed)
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
        session_id: row.get::<_, Option<String>>(8)?.map(SessionId::new),
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
            })
            .expect("a Host");
        let schedule = StoredSchedule {
            id: "sch-1".to_owned(),
            name: "daily".to_owned(),
            cron: "0 9 * * *".to_owned(),
            zone: "UTC".to_owned(),
            host_id: "h1".to_owned(),
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
        };
        store.add_schedule(&schedule).expect("a schedule");
        (store, schedule)
    }

    fn work(occurrence: &str) -> Work {
        Work::Queue(AddQueuedRequest {
            session_id: "s-1".into(),
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
        assert_eq!(listed[0].session_id, Some("s-1".into()));
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
