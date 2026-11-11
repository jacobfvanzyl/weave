//! Bots (ADR 0028, WVE-118): each a name, an agent, a permission policy and a home on the one Host
//! it names, with the threads it has had there, the last its current one. A new thread is a
//! sequence of steps ([`NewThread`]), each written down in the transaction that makes the
//! delivery it sends, under a key made from the Bot and how many new threads it has begun, so a
//! restart, the Dispatcher's or the Host's, takes it up where it was and starts nothing twice.
//! A change checks names in the transaction that makes it, so two at once can't both take one.

use std::path::PathBuf;

use rusqlite::Connection;
use rusqlite::OptionalExtension as _;
use rusqlite::Transaction;
use rusqlite::params;
use weave_host_protocol::policy::PermissionPolicy;

use super::Delivery;
use super::Store;
use super::Work;
use super::answered_thread;
use super::failed;
use super::from_sql;
use super::insert_delivery_as;
use super::json;
use super::random_id;
use super::to_sql;
use crate::now_ms;

/// Why a change to the Bots didn't happen.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum BotError {
    /// The request was wrong, as this says.
    Refused(String),
    /// The database failed.
    Failed(String),
}

impl From<rusqlite::Error> for BotError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Failed(failed(error))
    }
}

/// A Bot as the Dispatcher keeps it.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct StoredBot {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) agent_id: String,
    pub(crate) host_id: String,
    pub(crate) home: PathBuf,
    pub(crate) policy: PermissionPolicy,
    pub(crate) mode: Option<String>,
    /// `HH:MM`, in `zone`.
    pub(crate) new_thread_at: Option<String>,
    pub(crate) zone: String,
    pub(crate) pause_after: u64,
    /// Its current thread.
    pub(crate) thread: Option<String>,
    /// Why its schedules are paused.
    pub(crate) paused: Option<String>,
    /// Since when its current thread has waited on the person, by the scheduler's clock.
    pub(crate) waiting_since: Option<u64>,
    /// The daily new thread's times up to which it has been considered, by the scheduler's
    /// clock.
    pub(crate) new_thread_considered: u64,
    /// The daily new thread that came due, for its Host's link to start once it has seen the
    /// current thread had a turn since it started.
    pub(crate) new_thread_due: Option<u64>,
    /// How many new threads it has begun, which keys each one's deliveries.
    pub(crate) new_threads: u64,
    pub(crate) created_at: u64,
    pub(crate) updated_at: u64,
    /// Oldest first, the current one last.
    pub(crate) threads: Vec<StoredThread>,
    /// The new thread being started.
    pub(crate) new_thread: Option<NewThread>,
}

/// One of a Bot's threads.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct StoredThread {
    pub(crate) thread_id: String,
    /// The turn it started with, so a daily new thread can tell whether it has had another.
    pub(crate) first_turn: Option<String>,
    pub(crate) started_at: u64,
    pub(crate) ended_at: Option<u64>,
}

/// A new thread being started for a Bot, as far as it has got.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct NewThread {
    /// Which of the Bot's new threads it is, from 1.
    pub(crate) number: u64,
    pub(crate) step: Step,
    /// The thread it takes over from.
    pub(crate) from: String,
    /// Where in the home the thread it takes over from notes itself: `threads/<date>-<id>.md`.
    pub(crate) note: Option<String>,
    /// The delivery asking the old thread to save what's worth keeping.
    pub(crate) save: Option<String>,
    /// The delivery starting the new thread.
    pub(crate) start: Option<String>,
    /// The new thread, once its Host answered, and the turn it started with.
    pub(crate) thread: Option<String>,
    pub(crate) first_turn: Option<String>,
    pub(crate) began_at: u64,
}

/// Where a new thread's sequence is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Step {
    /// Waiting for the current thread to be idle.
    Waiting,
    /// The save prompt is written down for the current thread; waiting for its turn to end.
    Saving,
    /// The new thread is written down; waiting for its Host to start it.
    Starting,
    /// The new thread started; the old one is to name it as its successor.
    Naming,
}

impl Step {
    fn name(self) -> &'static str {
        match self {
            Self::Waiting => "waiting",
            Self::Saving => "saving",
            Self::Starting => "starting",
            Self::Naming => "naming",
        }
    }

    fn named(name: &str) -> Self {
        match name {
            "saving" => Self::Saving,
            "starting" => Self::Starting,
            "naming" => Self::Naming,
            _ => Self::Waiting,
        }
    }
}

/// A new Bot, checked but for its name and Host, which [`Store::add_bot`] checks.
#[derive(Clone, Debug)]
pub(crate) struct NewBot {
    pub(crate) name: String,
    pub(crate) host_id: String,
    pub(crate) agent_id: String,
    pub(crate) home: PathBuf,
    pub(crate) policy: PermissionPolicy,
    pub(crate) mode: Option<String>,
    pub(crate) new_thread_at: Option<String>,
    pub(crate) zone: String,
    pub(crate) pause_after: u64,
}

/// What `bots/update` changes, checked but for the name.
#[derive(Clone, Debug, Default)]
pub(crate) struct BotChange {
    pub(crate) name: Option<String>,
    pub(crate) policy: Option<PermissionPolicy>,
    pub(crate) mode: Option<Option<String>>,
    pub(crate) new_thread_at: Option<Option<String>>,
    pub(crate) zone: Option<String>,
    pub(crate) pause_after: Option<u64>,
}

impl Store {
    /// The Bots, by name.
    pub(crate) fn bots(&self) -> Result<Vec<StoredBot>, String> {
        all(&self.lock()).map_err(failed)
    }

    /// The Bot `by` names, by id or else by name, ignoring case.
    pub(crate) fn find_bot(&self, by: &str) -> Result<Option<StoredBot>, String> {
        find(&self.lock(), by).map_err(failed)
    }

    /// A new Bot, with no thread yet, its daily new thread considered from `now`.
    pub(crate) fn add_bot(&self, new: &NewBot, now: u64) -> Result<StoredBot, BotError> {
        let mut connection = self.lock();
        let transaction = connection.transaction()?;
        let name = free_name(&transaction, &new.name, None)?;
        joined(&transaction, &new.host_id)?;
        let id = format!("b-{}", random_id());
        let created = now_ms();
        transaction.execute(
            "INSERT INTO bots (id, name, agent_id, host_id, home, policy, mode, new_thread_at, \
             zone, pause_after, new_thread_considered, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)",
            params![
                id,
                name,
                new.agent_id,
                new.host_id,
                text(&new.home),
                to_json(&new.policy)?,
                new.mode,
                new.new_thread_at,
                new.zone,
                to_sql(new.pause_after),
                to_sql(now),
                to_sql(created)
            ],
        )?;
        let bot = find(&transaction, &id)?.ok_or_else(|| missing(&id))?;
        transaction.commit()?;
        Ok(bot)
    }

    /// Change the Bot `by` names as `change` says, all or none; a daily new thread whose time
    /// or zone changes is considered from `now`.
    pub(crate) fn update_bot(
        &self,
        by: &str,
        change: &BotChange,
        now: u64,
    ) -> Result<StoredBot, BotError> {
        let mut connection = self.lock();
        let transaction = connection.transaction()?;
        let bot = find(&transaction, by)?.ok_or_else(|| missing(by))?;
        let name = match &change.name {
            Some(name) => free_name(&transaction, name, Some(&bot.id))?,
            None => bot.name.clone(),
        };
        let policy = change.policy.as_ref().unwrap_or(&bot.policy);
        let mode = change.mode.as_ref().unwrap_or(&bot.mode);
        let new_thread_at = change.new_thread_at.as_ref().unwrap_or(&bot.new_thread_at);
        let zone = change.zone.as_ref().unwrap_or(&bot.zone);
        let pause_after = change.pause_after.unwrap_or(bot.pause_after);
        let changed = name != bot.name
            || *policy != bot.policy
            || *mode != bot.mode
            || *new_thread_at != bot.new_thread_at
            || *zone != bot.zone
            || pause_after != bot.pause_after;
        if changed {
            let considered = match *new_thread_at != bot.new_thread_at || *zone != bot.zone {
                true => now,
                false => bot.new_thread_considered,
            };
            transaction.execute(
                "UPDATE bots SET name = ?2, policy = ?3, mode = ?4, new_thread_at = ?5, \
                 zone = ?6, pause_after = ?7, new_thread_considered = ?8, updated_at = ?9 \
                 WHERE id = ?1",
                params![
                    bot.id,
                    name,
                    to_json(policy)?,
                    mode,
                    new_thread_at,
                    zone,
                    to_sql(pause_after),
                    to_sql(considered),
                    to_sql(now_ms())
                ],
            )?;
        }
        let bot = find(&transaction, &bot.id)?.ok_or_else(|| missing(by))?;
        transaction.commit()?;
        Ok(bot)
    }

    /// Forget the Bot `by` names, its threads' records, its schedules and the prompts still
    /// written down for it, giving what it was.
    pub(crate) fn remove_bot(&self, by: &str) -> Result<StoredBot, BotError> {
        let mut connection = self.lock();
        let transaction = connection.transaction()?;
        let bot = find(&transaction, by)?.ok_or_else(|| missing(by))?;
        transaction.execute("DELETE FROM bots WHERE id = ?1", params![bot.id])?;
        transaction.commit()?;
        Ok(bot)
    }

    /// Write down a prompt for `bot` that `make` makes from the delivery's id, under `key`: the
    /// delivery written down under that key before, if there is one.
    pub(crate) fn add_bot_prompt(
        &self,
        bot: &StoredBot,
        key: Option<&str>,
        make: impl FnOnce(&str) -> Work,
    ) -> Result<Delivery, String> {
        let mut connection = self.lock();
        let transaction = connection.transaction().map_err(failed)?;
        if let Some(key) = key {
            let before: Option<String> = transaction
                .query_row(
                    "SELECT id FROM deliveries WHERE bot_id = ?1 AND coalesce(\
                     json_extract(work, '$.bot.key'), json_extract(work, '$.run.key'), \
                     json_extract(work, '$.queue.key')) = ?2",
                    params![bot.id, key],
                    |row| row.get(0),
                )
                .optional()
                .map_err(failed)?;
            if let Some(before) = before {
                let delivery = transaction
                    .query_row(
                        &format!("{} WHERE id = ?1", super::SELECT_DELIVERY),
                        params![before],
                        super::delivery,
                    )
                    .map_err(failed)?;
                return Ok(delivery);
            }
        }
        let delivery =
            insert_delivery_as(&transaction, &bot.host_id, Some(&bot.id), make).map_err(failed)?;
        transaction.commit().map_err(failed)?;
        Ok(delivery)
    }

    /// Whether another of `bot_id`'s prompts than `except` is starting its first thread: sent
    /// as `thread/run` with no thread, and not yet answered.
    pub(crate) fn bot_starting(&self, bot_id: &str, except: &str) -> Result<bool, String> {
        self.lock()
            .query_row(
                "SELECT EXISTS (SELECT 1 FROM deliveries WHERE bot_id = ?1 AND id != ?2 \
                 AND state = 'pending' AND json_type(work, '$.run') IS NOT NULL \
                 AND json_type(work, '$.run.threadId') IS NULL \
                 AND id NOT IN (SELECT start_delivery FROM bot_new_threads \
                 WHERE bot_id = ?1 AND start_delivery IS NOT NULL))",
                params![bot_id, except],
                |row| row.get(0),
            )
            .map_err(failed)
    }

    /// Begin the Bot `bot_id`'s next new thread: from now on its prompts wait. Refused for a
    /// Bot with no thread yet, or one starting a new thread already.
    pub(crate) fn begin_new_thread(&self, bot_id: &str, now: u64) -> Result<StoredBot, BotError> {
        let mut connection = self.lock();
        let transaction = connection.transaction()?;
        let bot = find(&transaction, bot_id)?.ok_or_else(|| missing(bot_id))?;
        let Some(from) = &bot.thread else {
            return Err(BotError::Refused(format!(
                "{} has no thread yet: the first prompt that reaches it starts one",
                bot.name
            )));
        };
        if bot.new_thread.is_some() {
            return Err(BotError::Refused(format!(
                "{} is starting a new thread already",
                bot.name
            )));
        }
        let number = bot.new_threads + 1;
        transaction.execute(
            "INSERT INTO bot_new_threads (bot_id, number, step, from_thread, began_at) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                bot.id,
                to_sql(number),
                Step::Waiting.name(),
                from,
                to_sql(now)
            ],
        )?;
        transaction.execute(
            "UPDATE bots SET new_threads = ?2, new_thread_due = NULL WHERE id = ?1",
            params![bot.id, to_sql(number)],
        )?;
        let bot = find(&transaction, &bot.id)?.ok_or_else(|| missing(bot_id))?;
        transaction.commit()?;
        Ok(bot)
    }

    /// Write down the prompt asking the thread `bot_id`'s new thread `number` takes over from to
    /// save itself, noting itself at `note`, unless that step was taken already.
    pub(crate) fn save_new_thread(
        &self,
        bot: &StoredBot,
        number: u64,
        note: &str,
        make: impl FnOnce(&str) -> Work,
    ) -> Result<Option<Delivery>, String> {
        self.step_new_thread(bot, number, Step::Waiting, |transaction| {
            let delivery = insert_delivery_as(transaction, &bot.host_id, Some(&bot.id), make)?;
            transaction.execute(
                "UPDATE bot_new_threads SET step = ?2, note = ?3, save_delivery = ?4 \
                 WHERE bot_id = ?1",
                params![bot.id, Step::Saving.name(), note, delivery.id],
            )?;
            Ok(delivery)
        })
    }

    /// Write down `thread/run` starting `bot_id`'s new thread `number`, unless that step was
    /// taken already.
    pub(crate) fn start_new_thread(
        &self,
        bot: &StoredBot,
        number: u64,
        make: impl FnOnce(&str) -> Work,
    ) -> Result<Option<Delivery>, String> {
        self.step_new_thread(bot, number, Step::Saving, |transaction| {
            let delivery = insert_delivery_as(transaction, &bot.host_id, Some(&bot.id), make)?;
            transaction.execute(
                "UPDATE bot_new_threads SET step = ?2, start_delivery = ?3 WHERE bot_id = ?1",
                params![bot.id, Step::Starting.name(), delivery.id],
            )?;
            Ok(delivery)
        })
    }

    /// Take the step from `from` that `take` takes, in one transaction, if `bot`'s new thread
    /// `number` is at `from` still.
    fn step_new_thread(
        &self,
        bot: &StoredBot,
        number: u64,
        from: Step,
        take: impl FnOnce(&Transaction<'_>) -> rusqlite::Result<Delivery>,
    ) -> Result<Option<Delivery>, String> {
        let mut connection = self.lock();
        let transaction = connection.transaction().map_err(failed)?;
        let at: Option<String> = transaction
            .query_row(
                "SELECT step FROM bot_new_threads WHERE bot_id = ?1 AND number = ?2",
                params![bot.id, to_sql(number)],
                |row| row.get(0),
            )
            .optional()
            .map_err(failed)?;
        if at.as_deref() != Some(from.name()) {
            return Ok(None);
        }
        let delivery = take(&transaction).map_err(failed)?;
        transaction.commit().map_err(failed)?;
        Ok(Some(delivery))
    }

    /// `bot_id`'s new thread `number` has started and been named its successor: it's the
    /// current thread from now, the one before ended, and the Bot's prompts go on. Whether it
    /// was still to finish.
    pub(crate) fn finish_new_thread(&self, bot_id: &str, number: u64) -> Result<bool, String> {
        let mut connection = self.lock();
        let transaction = connection.transaction().map_err(failed)?;
        let started: Option<(String, String, Option<String>)> = transaction
            .query_row(
                "SELECT from_thread, thread_id, first_turn FROM bot_new_threads \
                 WHERE bot_id = ?1 AND number = ?2 AND step = ?3 AND thread_id IS NOT NULL",
                params![bot_id, to_sql(number), Step::Naming.name()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(failed)?;
        let Some((from, thread, first_turn)) = started else {
            return Ok(false);
        };
        let now = now_ms();
        transaction
            .execute(
                "UPDATE bot_threads SET ended_at = ?3 WHERE bot_id = ?1 AND thread_id = ?2 \
                 AND ended_at IS NULL",
                params![bot_id, from, to_sql(now)],
            )
            .map_err(failed)?;
        transaction
            .execute(
                "INSERT OR IGNORE INTO bot_threads (bot_id, thread_id, first_turn, started_at) \
                 VALUES (?1, ?2, ?3, ?4)",
                params![bot_id, thread, first_turn, to_sql(now)],
            )
            .map_err(failed)?;
        transaction
            .execute(
                "UPDATE bots SET thread_id = ?2, waiting_since = NULL, paused = NULL \
                 WHERE id = ?1",
                params![bot_id, thread],
            )
            .map_err(failed)?;
        transaction
            .execute(
                "DELETE FROM bot_new_threads WHERE bot_id = ?1",
                params![bot_id],
            )
            .map_err(failed)?;
        transaction.commit().map_err(failed)?;
        Ok(true)
    }

    /// `bot_id`'s current thread has waited on the person since `since`, or, with none, no
    /// longer waits, which resumes the Bot's schedules if they were paused for it.
    pub(crate) fn bot_waiting(&self, bot_id: &str, since: Option<u64>) -> Result<(), String> {
        let connection = self.lock();
        match since {
            Some(since) => connection.execute(
                "UPDATE bots SET waiting_since = ?2 WHERE id = ?1 AND waiting_since IS NULL",
                params![bot_id, to_sql(since)],
            ),
            None => connection.execute(
                "UPDATE bots SET waiting_since = NULL, paused = NULL WHERE id = ?1",
                params![bot_id],
            ),
        }
        .map(drop)
        .map_err(failed)
    }

    /// Pause `bot_id`'s schedules, saying `why`, if its thread waits still since `since`.
    pub(crate) fn pause_bot(&self, bot_id: &str, since: u64, why: &str) -> Result<bool, String> {
        self.lock()
            .execute(
                "UPDATE bots SET paused = ?3 WHERE id = ?1 AND waiting_since = ?2 \
                 AND paused IS NULL",
                params![bot_id, to_sql(since), why],
            )
            .map(|paused| paused > 0)
            .map_err(failed)
    }

    /// `bot_id`'s daily new thread has been considered up to `considered`, and `due`, if it
    /// came due, is for its Host's link to start.
    pub(crate) fn new_thread_considered(
        &self,
        bot_id: &str,
        due: Option<u64>,
        considered: u64,
    ) -> Result<(), String> {
        self.lock()
            .execute(
                "UPDATE bots SET new_thread_considered = max(new_thread_considered, ?3), \
                 new_thread_due = coalesce(?2, new_thread_due) WHERE id = ?1",
                params![bot_id, due.map(to_sql), to_sql(considered)],
            )
            .map(drop)
            .map_err(failed)
    }

    /// `bot_id`'s daily new thread that came due won't start: its thread had no turn since it
    /// started.
    pub(crate) fn new_thread_not_due(&self, bot_id: &str) -> Result<(), String> {
        self.lock()
            .execute(
                "UPDATE bots SET new_thread_due = NULL WHERE id = ?1",
                params![bot_id],
            )
            .map(drop)
            .map_err(failed)
    }
}

/// The Host took delivery `id`, `work`, answering `answer`: a `thread/run` for a Bot that started
/// a thread is its new thread, if it's the one the Bot's new-thread sequence started, or else
/// its first, if it has none yet.
pub(super) fn answered(
    transaction: &Transaction<'_>,
    id: &str,
    work: &Work,
    answer: &serde_json::Value,
) -> rusqlite::Result<()> {
    let Work::Run(request) = work else {
        return Ok(());
    };
    if request.thread_id.is_some() {
        return Ok(());
    }
    let bot_id: Option<String> = transaction
        .query_row(
            "SELECT bot_id FROM deliveries WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .optional()?
        .flatten();
    let (Some(bot_id), Some(thread)) = (bot_id, answered_thread(answer)) else {
        return Ok(());
    };
    let turn = answer.get("turnId").and_then(serde_json::Value::as_str);
    let named = transaction.execute(
        "UPDATE bot_new_threads SET step = ?3, thread_id = ?4, first_turn = ?5 \
         WHERE bot_id = ?1 AND start_delivery = ?2 AND step = ?6",
        params![
            bot_id,
            id,
            Step::Naming.name(),
            thread,
            turn,
            Step::Starting.name()
        ],
    )?;
    if named > 0 {
        return Ok(());
    }
    let first = transaction.execute(
        "UPDATE bots SET thread_id = ?2 WHERE id = ?1 AND thread_id IS NULL",
        params![bot_id, thread],
    )?;
    if first > 0 {
        transaction.execute(
            "INSERT OR IGNORE INTO bot_threads (bot_id, thread_id, first_turn, started_at) \
             VALUES (?1, ?2, ?3, ?4)",
            params![bot_id, thread, turn, to_sql(now_ms())],
        )?;
        tracing::info!(bot = %bot_id, %thread, "a Bot's first thread started");
    }
    Ok(())
}

/// The Host refused delivery `id`: if it was to start a Bot's new thread, the Bot keeps the
/// thread it has, and its prompts go on there.
pub(super) fn refused(transaction: &Transaction<'_>, id: &str) -> rusqlite::Result<()> {
    let abandoned = transaction.execute(
        "DELETE FROM bot_new_threads WHERE start_delivery = ?1 AND step = ?2",
        params![id, Step::Starting.name()],
    )?;
    if abandoned > 0 {
        tracing::warn!(delivery = %id, "a Bot's Host refused its new thread; it keeps the one it has");
    }
    Ok(())
}

fn missing(by: &str) -> BotError {
    BotError::Refused(format!("there's no Bot {by}"))
}

/// Refused unless `host_id` joined the Dispatcher.
fn joined(connection: &Connection, host_id: &str) -> Result<(), BotError> {
    let known: bool = connection.query_row(
        "SELECT EXISTS (SELECT 1 FROM hosts WHERE host_id = ?1)",
        params![host_id],
        |row| row.get(0),
    )?;
    match known {
        true => Ok(()),
        false => Err(BotError::Refused(format!(
            "the Host {host_id} hasn't joined the Dispatcher: `weave hosts add` there joins it"
        ))),
    }
}

/// `name`, trimmed, if no other Bot than `except` has it, ignoring case.
fn free_name(
    connection: &Connection,
    name: &str,
    except: Option<&str>,
) -> Result<String, BotError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(BotError::Refused("a Bot needs a name".to_owned()));
    }
    if name.chars().any(char::is_control) {
        return Err(BotError::Refused(
            "a Bot's name is one line of text".to_owned(),
        ));
    }
    let folded = name.to_lowercase();
    let taken = all(connection)?
        .into_iter()
        .find(|bot| Some(bot.id.as_str()) != except && bot.name.to_lowercase() == folded);
    match taken {
        Some(taken) => Err(BotError::Refused(format!(
            "there's a Bot called {} already",
            taken.name
        ))),
        None => Ok(name.to_owned()),
    }
}

fn to_json(policy: &PermissionPolicy) -> Result<String, BotError> {
    serde_json::to_string(policy).map_err(|error| BotError::Failed(error.to_string()))
}

fn text(path: &std::path::Path) -> String {
    path.to_string_lossy().into_owned()
}

/// Every Bot with its threads and the new thread it's starting, by name.
fn all(connection: &Connection) -> rusqlite::Result<Vec<StoredBot>> {
    let mut statement = connection.prepare(
        "SELECT id, name, agent_id, host_id, home, policy, mode, new_thread_at, zone, \
         pause_after, thread_id, paused, waiting_since, new_thread_considered, new_thread_due, \
         new_threads, created_at, updated_at FROM bots ORDER BY name COLLATE NOCASE, id",
    )?;
    let mut bots: Vec<StoredBot> = statement
        .query_map([], |row| {
            Ok(StoredBot {
                id: row.get(0)?,
                name: row.get(1)?,
                agent_id: row.get(2)?,
                host_id: row.get(3)?,
                home: row.get::<_, String>(4)?.into(),
                policy: json(5, &row.get::<_, String>(5)?)?,
                mode: row.get(6)?,
                new_thread_at: row.get(7)?,
                zone: row.get(8)?,
                pause_after: from_sql(row.get(9)?),
                thread: row.get(10)?,
                paused: row.get(11)?,
                waiting_since: row.get::<_, Option<i64>>(12)?.map(from_sql),
                new_thread_considered: from_sql(row.get(13)?),
                new_thread_due: row.get::<_, Option<i64>>(14)?.map(from_sql),
                new_threads: from_sql(row.get(15)?),
                created_at: from_sql(row.get(16)?),
                updated_at: from_sql(row.get(17)?),
                threads: Vec::new(),
                new_thread: None,
            })
        })?
        .collect::<Result<_, _>>()?;
    let mut statement = connection.prepare(
        "SELECT bot_id, thread_id, first_turn, started_at, ended_at FROM bot_threads \
         ORDER BY started_at, rowid",
    )?;
    let threads = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            StoredThread {
                thread_id: row.get(1)?,
                first_turn: row.get(2)?,
                started_at: from_sql(row.get(3)?),
                ended_at: row.get::<_, Option<i64>>(4)?.map(from_sql),
            },
        ))
    })?;
    for thread in threads {
        let (bot_id, thread) = thread?;
        if let Some(bot) = bots.iter_mut().find(|bot| bot.id == bot_id) {
            bot.threads.push(thread);
        }
    }
    let mut statement = connection.prepare(
        "SELECT bot_id, number, step, from_thread, note, save_delivery, start_delivery, \
         thread_id, first_turn, began_at FROM bot_new_threads",
    )?;
    let starting = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            NewThread {
                number: from_sql(row.get(1)?),
                step: Step::named(&row.get::<_, String>(2)?),
                from: row.get(3)?,
                note: row.get(4)?,
                save: row.get(5)?,
                start: row.get(6)?,
                thread: row.get(7)?,
                first_turn: row.get(8)?,
                began_at: from_sql(row.get(9)?),
            },
        ))
    })?;
    for new_thread in starting {
        let (bot_id, new_thread) = new_thread?;
        if let Some(bot) = bots.iter_mut().find(|bot| bot.id == bot_id) {
            bot.new_thread = Some(new_thread);
        }
    }
    Ok(bots)
}

/// The Bot `by` names, by id or else by name, ignoring case.
fn find(connection: &Connection, by: &str) -> rusqlite::Result<Option<StoredBot>> {
    let mut bots = all(connection)?;
    let folded = by.trim().to_lowercase();
    let found = bots.iter().position(|bot| bot.id == by).or_else(|| {
        bots.iter()
            .position(|bot| bot.name.to_lowercase() == folded)
    });
    Ok(found.map(|index| bots.swap_remove(index)))
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;
    use weave_host_protocol::threads::RunRequest;
    use weave_host_protocol::threads::ThreadId;

    use super::*;
    use crate::store::StoredHost;

    fn store() -> Store {
        let store = Store::in_memory();
        store
            .put_host(&StoredHost {
                host_id: "h-lab".to_owned(),
                name: "homelab".to_owned(),
                url: String::new(),
                device_id: "d-dispatcher".to_owned(),
                paired_at: 1,
                refused: None,
                public_key: None,
                joined_at: Some(1),
                here: false,
            })
            .expect("a Host");
        store
    }

    fn new(name: &str) -> NewBot {
        NewBot {
            name: name.to_owned(),
            host_id: "h-lab".to_owned(),
            agent_id: "fake".to_owned(),
            home: "~/odin".into(),
            policy: PermissionPolicy::ask(),
            mode: None,
            new_thread_at: None,
            zone: "UTC".to_owned(),
            pause_after: 1000,
        }
    }

    fn refused<T: std::fmt::Debug>(result: Result<T, BotError>) -> String {
        match result {
            Err(BotError::Refused(why)) => why,
            other => panic!("not refused: {other:?}"),
        }
    }

    fn run(thread_id: Option<&str>) -> Work {
        Work::Run(RunRequest {
            agent_id: "fake".to_owned(),
            cwd: "~/odin".into(),
            remote: None,
            thread_id: thread_id.map(|thread| ThreadId::new(thread.to_owned())),
            additional_directories: Vec::new(),
            mode: None,
            prompt: Vec::new(),
            policy: PermissionPolicy::ask(),
            attach: false,
            trace: false,
            key: None,
            caller: None,
            origin: None,
            labels: Vec::new(),
        })
    }

    #[test]
    fn names_are_unique_ignoring_case_and_a_host_has_to_have_joined() {
        let store = store();
        let odin = store.add_bot(&new(" Odin "), 5).expect("added");
        assert_eq!(odin.name, "Odin");
        assert!(odin.id.starts_with("b-"), "{}", odin.id);
        assert_eq!(odin.new_thread_considered, 5);
        assert_eq!(
            refused(store.add_bot(&new("ODIN"), 5)),
            "there's a Bot called Odin already"
        );
        assert!(refused(store.add_bot(&new("two\nlines"), 5)).contains("one line"));
        let stranger = refused(store.add_bot(
            &NewBot {
                host_id: "h-nobody".to_owned(),
                ..new("loki")
            },
            5,
        ));
        assert!(stranger.contains("hasn't joined"), "{stranger}");
        let thor = store.add_bot(&new("thor"), 5).expect("added");
        let taken = refused(store.update_bot(
            &thor.id,
            &BotChange {
                name: Some("odin".to_owned()),
                ..BotChange::default()
            },
            6,
        ));
        assert_eq!(taken, "there's a Bot called Odin already");
        let renamed = store
            .update_bot(
                "ODIN",
                &BotChange {
                    name: Some("ODIN".to_owned()),
                    new_thread_at: Some(Some("09:00".to_owned())),
                    ..BotChange::default()
                },
                7,
            )
            .expect("renamed");
        assert_eq!(
            (renamed.name.as_str(), renamed.new_thread_considered),
            ("ODIN", 7)
        );
        assert!(store.remove_host("h-lab").expect("removed"));
        assert_eq!(store.bots().expect("bots"), Vec::new());
    }

    #[test]
    fn the_first_thread_answered_is_the_bots_and_a_new_thread_goes_step_by_step() {
        let store = store();
        let bot = store.add_bot(&new("odin"), 1).expect("added");
        assert!(refused(store.begin_new_thread(&bot.id, 2)).contains("has no thread yet"));
        let keyed = |_: &str| match run(None) {
            Work::Run(request) => Work::Run(RunRequest {
                key: Some("k".to_owned()),
                ..request
            }),
            other => other,
        };
        let first = store
            .add_bot_prompt(&bot, Some("k"), keyed)
            .expect("written");
        assert_eq!(
            store
                .add_bot_prompt(&bot, Some("k"), keyed)
                .expect("the same")
                .id,
            first.id
        );
        let second = store
            .add_bot_prompt(&bot, None, |_| run(None))
            .expect("written");
        assert!(store.bot_starting(&bot.id, &second.id).expect("asked"));
        store
            .delivered(
                &first.id,
                &serde_json::json!({"threadId": "s-1", "turnId": "t-1"}),
            )
            .expect("delivered");
        let bot = store.find_bot("odin").expect("found").expect("there");
        assert_eq!(bot.thread.as_deref(), Some("s-1"));
        assert_eq!(bot.threads[0].first_turn.as_deref(), Some("t-1"));
        assert!(!store.bot_starting(&bot.id, &second.id).expect("asked"));

        let bot = store.begin_new_thread(&bot.id, 3).expect("begun");
        let started = bot.new_thread.clone().expect("starting");
        assert_eq!((started.number, started.step), (1, Step::Waiting));
        assert!(refused(store.begin_new_thread(&bot.id, 4)).contains("already"));
        assert_eq!(
            store
                .start_new_thread(&bot, 1, |_| run(None))
                .expect("not yet"),
            None
        );
        store
            .save_new_thread(&bot, 1, "threads/x.md", |_| run(Some("s-1")))
            .expect("saved")
            .expect("written");
        assert_eq!(
            store
                .save_new_thread(&bot, 1, "threads/x.md", |_| run(Some("s-1")))
                .expect("once"),
            None
        );
        let start = store
            .start_new_thread(&bot, 1, |_| run(None))
            .expect("started")
            .expect("written");
        store
            .delivered(
                &start.id,
                &serde_json::json!({"threadId": "s-2", "turnId": "t-9"}),
            )
            .expect("delivered");
        let naming = store.find_bot("odin").expect("found").expect("there");
        let step = naming.new_thread.clone().expect("still starting");
        assert_eq!(
            (step.step, step.thread.as_deref()),
            (Step::Naming, Some("s-2"))
        );
        assert_eq!(naming.thread.as_deref(), Some("s-1"));
        assert!(store.finish_new_thread(&bot.id, 1).expect("finished"));
        assert!(!store.finish_new_thread(&bot.id, 1).expect("once"));
        let done = store.find_bot("odin").expect("found").expect("there");
        assert_eq!(done.thread.as_deref(), Some("s-2"));
        assert_eq!(done.new_thread, None);
        let threads: Vec<(&str, bool)> = done
            .threads
            .iter()
            .map(|thread| (thread.thread_id.as_str(), thread.ended_at.is_some()))
            .collect();
        assert_eq!(threads, [("s-1", true), ("s-2", false)]);
    }

    #[test]
    fn a_new_thread_its_host_refuses_leaves_the_bot_its_thread() {
        let store = store();
        let bot = store.add_bot(&new("odin"), 1).expect("added");
        let first = store
            .add_bot_prompt(&bot, None, |_| run(None))
            .expect("written");
        store
            .delivered(&first.id, &serde_json::json!({"threadId": "s-1"}))
            .expect("delivered");
        let bot = store.begin_new_thread(&bot.id, 2).expect("begun");
        store
            .save_new_thread(&bot, 1, "n", |_| run(Some("s-1")))
            .expect("saved");
        let start = store
            .start_new_thread(&bot, 1, |_| run(None))
            .expect("started")
            .expect("written");
        store.failed(&start.id, "no such agent").expect("failed");
        let bot = store.find_bot(&bot.id).expect("found").expect("there");
        assert_eq!(
            (bot.thread.as_deref(), bot.new_thread, bot.new_threads),
            (Some("s-1"), None, 1)
        );
    }
}
