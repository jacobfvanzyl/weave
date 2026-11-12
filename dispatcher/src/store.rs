//! The Dispatcher's state, in SQLite (ADR 0027): the Hosts it is paired with, the work
//! written down for them, schedules and their occurrences ([`schedules`]), and the calls Hosts'
//! agents make to the person's other Hosts and the turns they began there ([`calls`]), and its
//! own id and the devices paired with it ([`devices`]), the person's Projects ([`projects`]),
//! and their Bots ([`bots`]). Later issues add other triggers, each as a migration of its own.

mod bots;
mod calls;
mod devices;
mod projects;
mod schedules;

pub(crate) use bots::BotChange;
pub(crate) use bots::BotError;
pub(crate) use bots::MOST_BOTS;
pub(crate) use bots::NewBot;
pub(crate) use bots::NewThread;
pub(crate) use bots::Step;
pub(crate) use bots::StoredBot;
pub(crate) use bots::too_many;

pub(crate) use calls::Call;
pub(crate) use calls::Follow;

pub(crate) use devices::StoredDevice;

pub(crate) use projects::Change;
pub(crate) use projects::ProjectError;

pub(crate) use schedules::BotSchedule;
pub(crate) use schedules::Fired;
pub(crate) use schedules::StoredSchedule;
pub(crate) use schedules::WakeUp;

use std::path::Path;
use std::sync::Mutex;
use std::sync::MutexGuard;

use agent_client_protocol::schema::v1::ContentBlock;
use rusqlite::Connection;
use rusqlite::OptionalExtension as _;
use rusqlite::params;
use serde::Deserialize;
use serde::Serialize;
use weave_host_protocol::devices::Jwk;
use weave_host_protocol::queue::AddQueuedRequest;
use weave_host_protocol::threads::ReportThreadRequest;
use weave_host_protocol::threads::RunRequest;
use weave_host_protocol::threads::ServiceOrigin;

use crate::now_ms;

/// Each migration takes the database from the version before it to its own number, its index
/// plus one, which `PRAGMA user_version` records. They are never edited once released.
const MIGRATIONS: [&str; 10] = [
    "
    CREATE TABLE hosts (
        host_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        device_id TEXT NOT NULL,
        paired_at INTEGER NOT NULL,
        refused TEXT
    );
    CREATE TABLE deliveries (
        id TEXT PRIMARY KEY,
        host_id TEXT NOT NULL REFERENCES hosts (host_id) ON DELETE CASCADE,
        work TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        delivered_at INTEGER,
        answer TEXT,
        error TEXT
    );
    CREATE INDEX deliveries_by_host ON deliveries (host_id, state);
",
    "
    CREATE TABLE schedules (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        cron TEXT NOT NULL,
        zone TEXT NOT NULL,
        host_id TEXT NOT NULL REFERENCES hosts (host_id) ON DELETE CASCADE,
        run TEXT NOT NULL,
        missed TEXT NOT NULL,
        overlap TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        considered_until INTEGER NOT NULL,
        paused TEXT,
        failures INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE occurrences (
        id TEXT PRIMARY KEY,
        schedule_id TEXT NOT NULL REFERENCES schedules (id) ON DELETE CASCADE,
        scheduled_at INTEGER NOT NULL,
        late INTEGER NOT NULL,
        manual INTEGER NOT NULL,
        state TEXT NOT NULL,
        outcome TEXT,
        why TEXT,
        delivery_id TEXT REFERENCES deliveries (id) ON DELETE SET NULL,
        session_id TEXT,
        turn_id TEXT,
        recorded_at INTEGER NOT NULL,
        ended_at INTEGER,
        UNIQUE (schedule_id, scheduled_at, manual)
    );
    CREATE INDEX occurrences_by_delivery ON occurrences (delivery_id);
    CREATE INDEX occurrences_by_state ON occurrences (state);
",
    "
    CREATE TABLE calls (
        delivery_id TEXT PRIMARY KEY REFERENCES deliveries (id) ON DELETE CASCADE,
        calling_host TEXT NOT NULL,
        caller TEXT NOT NULL,
        delegated INTEGER NOT NULL,
        lost INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE follows (
        id TEXT PRIMARY KEY,
        host_id TEXT NOT NULL REFERENCES hosts (host_id) ON DELETE CASCADE,
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        calling_host TEXT NOT NULL,
        caller TEXT NOT NULL,
        delegated INTEGER NOT NULL,
        told TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        UNIQUE (host_id, session_id, turn_id, calling_host, caller)
    );
    CREATE INDEX follows_by_host ON follows (host_id, session_id);
",
    "
    CREATE TABLE identity (
        id TEXT NOT NULL
    );
    CREATE TABLE devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        public_key TEXT NOT NULL,
        paired_at INTEGER NOT NULL,
        last_seen_at INTEGER
    );
",
    // Hosts join the Dispatcher (ADR 0030): a Host with no key was paired before that.
    "
    ALTER TABLE hosts ADD COLUMN public_key TEXT;
    ALTER TABLE hosts ADD COLUMN joined_at INTEGER;
    ALTER TABLE hosts ADD COLUMN here INTEGER NOT NULL DEFAULT 0;
",
    // The Host protocol's version 3 says thread where version 2 said session (WVE-200): the
    // columns, and the work written down for Hosts, which is sent to them again as it is. The
    // Hosts' answers stay as version 2 gave them, and are read under both names.
    "
    ALTER TABLE occurrences RENAME COLUMN session_id TO thread_id;
    ALTER TABLE follows RENAME COLUMN session_id TO thread_id;
    UPDATE deliveries
        SET work = json_set(json_remove(work, '$.run.sessionId'), '$.run.threadId',
            json_extract(work, '$.run.sessionId'))
        WHERE json_type(work, '$.run.sessionId') IS NOT NULL;
    UPDATE deliveries
        SET work = json_set(json_remove(work, '$.run.caller.sessionId'), '$.run.caller.threadId',
            json_extract(work, '$.run.caller.sessionId'))
        WHERE json_type(work, '$.run.caller.sessionId') IS NOT NULL;
    UPDATE deliveries
        SET work = json_set(json_remove(work, '$.prompt.sessionId'), '$.prompt.threadId',
            json_extract(work, '$.prompt.sessionId'))
        WHERE json_type(work, '$.prompt.sessionId') IS NOT NULL;
    UPDATE deliveries
        SET work = json_set(json_remove(work, '$.prompt.caller.sessionId'), '$.prompt.caller.threadId',
            json_extract(work, '$.prompt.caller.sessionId'))
        WHERE json_type(work, '$.prompt.caller.sessionId') IS NOT NULL;
    UPDATE deliveries
        SET work = json_set(json_remove(work, '$.queue.sessionId'), '$.queue.threadId',
            json_extract(work, '$.queue.sessionId'))
        WHERE json_type(work, '$.queue.sessionId') IS NOT NULL;
    UPDATE deliveries
        SET work = json_set(json_remove(work, '$.queue.caller.sessionId'), '$.queue.caller.threadId',
            json_extract(work, '$.queue.caller.sessionId'))
        WHERE json_type(work, '$.queue.caller.sessionId') IS NOT NULL;
    UPDATE deliveries
        SET work = json_set(json_remove(work, '$.report.sessionId'), '$.report.threadId',
            json_extract(work, '$.report.sessionId'))
        WHERE json_type(work, '$.report.sessionId') IS NOT NULL;
    UPDATE deliveries
        SET work = json_set(json_remove(work, '$.report.about.sessionId'), '$.report.about.threadId',
            json_extract(work, '$.report.about.sessionId'))
        WHERE json_type(work, '$.report.about.sessionId') IS NOT NULL;
",
    // Projects (ADR 0031, WVE-189), each with at most one location on each Host. A Host's
    // removal takes its locations; its leaving doesn't.
    "
    CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        remote TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX projects_by_name ON projects (name COLLATE NOCASE);
    CREATE TABLE project_locations (
        project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
        host_id TEXT NOT NULL REFERENCES hosts (host_id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        added_at INTEGER NOT NULL,
        PRIMARY KEY (project_id, host_id),
        UNIQUE (host_id, path)
    );
",
    // Bots (ADR 0028, WVE-118): each on one Host, whose removal takes it, its schedules and the
    // prompts waiting for it. `bot_threads` are the threads it has had, the current one last;
    // `bot_new_threads` the new-thread sequence under way, step by step. A schedule may name a
    // Bot, and may be a one-off (`at`, its `cron` empty); a delivery for a Bot names it. A Bot's
    // own wake-up is a one-off its thread asked for with `wake_me`, which `wake_call` names: the
    // Host's id for that tool call, once per Bot, so the same call makes one.
    "
    CREATE TABLE bots (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        host_id TEXT NOT NULL REFERENCES hosts (host_id) ON DELETE CASCADE,
        home TEXT NOT NULL,
        policy TEXT NOT NULL,
        mode TEXT,
        new_thread_at TEXT,
        zone TEXT NOT NULL,
        pause_after INTEGER NOT NULL,
        thread_id TEXT,
        paused TEXT,
        waiting_since INTEGER,
        new_thread_considered INTEGER NOT NULL,
        new_thread_due INTEGER,
        new_threads INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX bots_by_name ON bots (name COLLATE NOCASE);
    CREATE TABLE bot_threads (
        bot_id TEXT NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL,
        first_turn TEXT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        PRIMARY KEY (bot_id, thread_id)
    );
    CREATE TABLE bot_new_threads (
        bot_id TEXT PRIMARY KEY REFERENCES bots (id) ON DELETE CASCADE,
        number INTEGER NOT NULL,
        step TEXT NOT NULL,
        from_thread TEXT NOT NULL,
        note TEXT,
        save_delivery TEXT,
        start_delivery TEXT,
        thread_id TEXT,
        first_turn TEXT,
        began_at INTEGER NOT NULL
    );
    ALTER TABLE schedules ADD COLUMN at INTEGER;
    ALTER TABLE schedules ADD COLUMN bot_id TEXT REFERENCES bots (id) ON DELETE CASCADE;
    ALTER TABLE schedules ADD COLUMN wake_call TEXT;
    CREATE UNIQUE INDEX schedules_by_wake_call ON schedules (bot_id, wake_call);
    ALTER TABLE deliveries ADD COLUMN bot_id TEXT REFERENCES bots (id) ON DELETE CASCADE;
    CREATE INDEX deliveries_by_bot ON deliveries (bot_id, state);
",
    // The Bot that made a Bot, when one did (WVE-178): its id, kept once that Bot is gone, so
    // no foreign key.
    "
    ALTER TABLE bots ADD COLUMN created_by TEXT;
",
    // A schedule a Bot added itself with `add_schedule` (WVE-178): `made_call` is the Host's id
    // for that tool call, once per Bot, as `wake_call` is for a wake-up.
    "
    ALTER TABLE schedules ADD COLUMN made_call TEXT;
    CREATE UNIQUE INDEX schedules_by_made_call ON schedules (bot_id, made_call);
",
];

/// A Host that joined the Dispatcher, or was paired with it before Hosts joined it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct StoredHost {
    pub(crate) host_id: String,
    pub(crate) name: String,
    /// Where the Dispatcher dialed a Host paired before Hosts joined it; empty for one that
    /// joined.
    pub(crate) url: String,
    /// The device the Host knows the Dispatcher as: its own id, for a Host that joined.
    pub(crate) device_id: String,
    pub(crate) paired_at: u64,
    /// Why it left or refused the Dispatcher, until it joins again.
    pub(crate) refused: Option<String>,
    /// The key it proves itself with; none for a Host paired before Hosts joined.
    pub(crate) public_key: Option<Jwk>,
    pub(crate) joined_at: Option<u64>,
    /// It joined over the Dispatcher's socket, on the Dispatcher's own computer.
    pub(crate) here: bool,
}

/// What the Dispatcher asks a Host to do: start a headless turn, add to a thread's queue, or
/// report to a thread on a turn its agent began on another Host.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Work {
    Run(RunRequest),
    Queue(AddQueuedRequest),
    /// A prompt for the thread `sessionId` names: added to its queue if it's open when first
    /// sent, otherwise run in it, which opens it. Which it is is written down before it's sent,
    /// so every send asks the same under its key.
    Prompt(RunRequest),
    Report(ReportThreadRequest),
    /// A prompt for a Bot (WVE-118), settled when first sent, as a thread's prompt is, into
    /// its current thread, or into `thread/run` starting its first ([`crate::bots`]).
    Bot(BotPrompt),
}

/// A prompt for a Bot, whose thread is settled when it's first sent: its current thread then,
/// or a new one in its home when it has none. It waits while the Bot starts a new thread, and
/// while another of its prompts starts its first.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BotPrompt {
    pub bot_id: String,
    pub prompt: Vec<ContentBlock>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    /// What sent it: `bot <name>`, or `schedule <name>` for a Bot's schedule.
    pub origin: ServiceOrigin,
}

impl Work {
    pub(crate) fn key(&self) -> Option<&str> {
        match self {
            Self::Run(request) | Self::Prompt(request) => request.key.as_deref(),
            Self::Queue(request) => request.key.as_deref(),
            Self::Report(request) => request.key.as_deref(),
            Self::Bot(prompt) => prompt.key.as_deref(),
        }
    }

    fn keyed(mut self, key: String) -> Self {
        match &mut self {
            Self::Run(request) | Self::Prompt(request) => request.key = Some(key),
            Self::Queue(request) => request.key = Some(key),
            Self::Report(request) => request.key = Some(key),
            Self::Bot(prompt) => prompt.key = Some(key),
        }
        self
    }

    /// The thread and turn the Host's `answer` to this says it started, if it says.
    pub(crate) fn started(&self, answer: &serde_json::Value) -> Option<(String, String)> {
        let text = |name: &str| answer.get(name)?.as_str().map(str::to_owned);
        match self {
            Self::Run(_) | Self::Prompt(_) => {
                Some((answered_thread(answer)?.to_owned(), text("turnId")?))
            }
            Self::Queue(request) => Some((request.thread_id.0.to_string(), text("queuedId")?)),
            Self::Report(_) | Self::Bot(_) => None,
        }
    }
}

/// The thread a Host's answer to `thread/run` names: its `threadId`, or the `sessionId` a
/// version-2 Host answered `session/run` with, as answers stored before WVE-200 have it.
pub(crate) fn answered_thread(answer: &serde_json::Value) -> Option<&str> {
    ["threadId", "sessionId"]
        .into_iter()
        .find_map(|name| answer.get(name)?.as_str())
}

/// Work written down for a Host before it is sent, so it reaches the Host once however often
/// it's sent.
#[derive(Clone, Debug, PartialEq)]
pub struct Delivery {
    pub id: String,
    pub host_id: String,
    /// The Bot it's for, if it is one's (WVE-118).
    pub bot_id: Option<String>,
    /// What it asks, always under a request key.
    pub work: Work,
    pub state: DeliveryState,
    pub created_at: u64,
    pub delivered_at: Option<u64>,
    /// The Host's answer, once it took it.
    pub answer: Option<serde_json::Value>,
    /// Why the Host refused it, when it did.
    pub error: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeliveryState {
    /// Not yet taken by the Host: sent again each time the Dispatcher connects to it.
    Pending,
    /// The Host took it.
    Delivered,
    /// The Host refused it, saying why; it isn't sent again.
    Failed,
}

impl DeliveryState {
    fn name(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Delivered => "delivered",
            Self::Failed => "failed",
        }
    }

    fn named(name: &str) -> Self {
        match name {
            "delivered" => Self::Delivered,
            "failed" => Self::Failed,
            _ => Self::Pending,
        }
    }
}

pub(crate) struct Store {
    connection: Mutex<Connection>,
}

impl Store {
    /// The database at `path`, created and migrated to the newest version as needed.
    pub(crate) fn open(path: &Path) -> Result<Self, String> {
        let shown = |error: rusqlite::Error| format!("{}: {error}", path.display());
        let mut connection = Connection::open(path).map_err(shown)?;
        connection
            .execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")
            .map_err(shown)?;
        migrate(&mut connection).map_err(shown)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
                .map_err(|error| format!("{}: {error}", path.display()))?;
        }
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    /// An empty database in memory, for tests.
    #[cfg(test)]
    fn in_memory() -> Self {
        let mut connection = Connection::open_in_memory().expect("an in-memory database");
        connection
            .execute_batch("PRAGMA foreign_keys = ON;")
            .expect("foreign keys");
        migrate(&mut connection).expect("migrated");
        Self {
            connection: Mutex::new(connection),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Connection> {
        self.connection
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub(crate) fn hosts(&self) -> Result<Vec<StoredHost>, String> {
        let connection = self.lock();
        let mut statement = connection
            .prepare(
                "SELECT host_id, name, url, device_id, paired_at, refused, public_key, \
                 joined_at, here FROM hosts ORDER BY name, host_id",
            )
            .map_err(failed)?;
        let rows = statement
            .query_map([], |row| {
                Ok(StoredHost {
                    host_id: row.get(0)?,
                    name: row.get(1)?,
                    url: row.get(2)?,
                    device_id: row.get(3)?,
                    paired_at: from_sql(row.get(4)?),
                    refused: row.get(5)?,
                    public_key: row
                        .get::<_, Option<String>>(6)?
                        .map(|key| json(6, &key))
                        .transpose()?,
                    joined_at: row.get::<_, Option<i64>>(7)?.map(from_sql),
                    here: row.get(8)?,
                })
            })
            .map_err(failed)?;
        rows.collect::<Result<_, _>>().map_err(failed)
    }

    /// The Host `host_id`, if it's known.
    pub(crate) fn host(&self, host_id: &str) -> Result<Option<StoredHost>, String> {
        Ok(self
            .hosts()?
            .into_iter()
            .find(|host| host.host_id == host_id))
    }

    /// Keep `host`, replacing what joining or pairing before kept, its refusal included.
    pub(crate) fn put_host(&self, host: &StoredHost) -> Result<(), String> {
        let key = host
            .public_key
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(|error| error.to_string())?;
        self.lock()
            .execute(
                "INSERT INTO hosts (host_id, name, url, device_id, paired_at, refused, \
                 public_key, joined_at, here) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) \
                 ON CONFLICT (host_id) DO UPDATE SET name = ?2, url = ?3, device_id = ?4, \
                 paired_at = ?5, refused = ?6, public_key = ?7, joined_at = ?8, here = ?9",
                params![
                    host.host_id,
                    host.name,
                    host.url,
                    host.device_id,
                    to_sql(host.paired_at),
                    host.refused,
                    key,
                    host.joined_at.map(to_sql),
                    host.here
                ],
            )
            .map(drop)
            .map_err(failed)
    }

    /// Whether a Host joined over the WebSocket, which keeps remote access on for it.
    pub(crate) fn any_remote_host(&self) -> Result<bool, String> {
        self.lock()
            .query_row(
                "SELECT EXISTS (SELECT 1 FROM hosts WHERE public_key IS NOT NULL AND here = 0 \
                 AND refused IS NULL)",
                [],
                |row| row.get(0),
            )
            .map_err(failed)
    }

    pub(crate) fn set_refused(&self, host_id: &str, why: Option<&str>) -> Result<(), String> {
        self.lock()
            .execute(
                "UPDATE hosts SET refused = ?2 WHERE host_id = ?1",
                params![host_id, why],
            )
            .map(drop)
            .map_err(failed)
    }

    /// Forget `host_id`, the work written down for it and its Projects' locations, which
    /// changes those Projects. Whether there was one.
    pub(crate) fn remove_host(&self, host_id: &str) -> Result<bool, String> {
        let mut connection = self.lock();
        let transaction = connection.transaction().map_err(failed)?;
        transaction
            .execute(
                "UPDATE projects SET updated_at = ?2 WHERE id IN \
                 (SELECT project_id FROM project_locations WHERE host_id = ?1)",
                params![host_id, to_sql(now_ms())],
            )
            .map_err(failed)?;
        let removed = transaction
            .execute("DELETE FROM hosts WHERE host_id = ?1", params![host_id])
            .map_err(failed)?;
        transaction.commit().map_err(failed)?;
        Ok(removed > 0)
    }

    /// Write `work` down for `host_id`, under its own request key or else one made from the
    /// delivery's id.
    pub(crate) fn add_delivery(&self, host_id: &str, work: Work) -> Result<Delivery, String> {
        insert_delivery(&self.lock(), host_id, work).map_err(|error| match error {
            rusqlite::Error::SqliteFailure(failure, _)
                if failure.code == rusqlite::ErrorCode::ConstraintViolation =>
            {
                format!("the Dispatcher isn't paired with Host {host_id}")
            }
            other => failed(other),
        })
    }

    pub(crate) fn delivery(&self, id: &str) -> Result<Option<Delivery>, String> {
        self.lock()
            .query_row(
                &format!("{SELECT_DELIVERY} WHERE id = ?1"),
                params![id],
                delivery,
            )
            .optional()
            .map_err(failed)
    }

    /// The work written down for `host_id` that it hasn't taken, oldest first.
    pub(crate) fn pending(&self, host_id: &str) -> Result<Vec<Delivery>, String> {
        let connection = self.lock();
        let mut statement = connection
            .prepare(&format!(
                "{SELECT_DELIVERY} WHERE host_id = ?1 AND state = 'pending' ORDER BY rowid"
            ))
            .map_err(failed)?;
        let rows = statement
            .query_map(params![host_id], delivery)
            .map_err(failed)?;
        rows.collect::<Result<_, _>>().map_err(failed)
    }

    /// How much work waits: for `host_id`, or for every Host.
    pub(crate) fn pending_count(&self, host_id: Option<&str>) -> Result<u32, String> {
        let connection = self.lock();
        let count: u32 = match host_id {
            Some(host_id) => connection.query_row(
                "SELECT count(*) FROM deliveries WHERE host_id = ?1 AND state = 'pending'",
                params![host_id],
                |row| row.get(0),
            ),
            None => connection.query_row(
                "SELECT count(*) FROM deliveries WHERE state = 'pending'",
                [],
                |row| row.get(0),
            ),
        }
        .map_err(failed)?;
        Ok(count)
    }

    /// The Host took delivery `id`, answering `answer`; an occurrence it was for has started.
    pub(crate) fn delivered(&self, id: &str, answer: &serde_json::Value) -> Result<(), String> {
        let mut connection = self.lock();
        let transaction = connection.transaction().map_err(failed)?;
        transaction
            .execute(
                "UPDATE deliveries SET state = 'delivered', delivered_at = ?2, answer = ?3 \
                 WHERE id = ?1",
                params![id, to_sql(now_ms()), answer.to_string()],
            )
            .map_err(failed)?;
        let work: Option<String> = transaction
            .query_row(
                "SELECT work FROM deliveries WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .optional()
            .map_err(failed)?;
        let work = work.and_then(|work| serde_json::from_str::<Work>(&work).ok());
        let started = work.as_ref().and_then(|work| work.started(answer));
        if let Some((thread_id, turn_id)) = &started {
            calls::begun(&transaction, id, thread_id, turn_id).map_err(failed)?;
        }
        if let Some(work) = &work {
            bots::answered(&transaction, id, work, answer).map_err(failed)?;
        }
        let (thread_id, turn_id) = started.unzip();
        transaction
            .execute(
                "UPDATE occurrences SET state = 'started', thread_id = ?2, turn_id = ?3 \
                 WHERE delivery_id = ?1 AND state = 'waiting'",
                params![id, thread_id, turn_id],
            )
            .map_err(failed)?;
        transaction.commit().map_err(failed)
    }

    /// The Host refused delivery `id`, saying `why`; an occurrence it was for failed.
    pub(crate) fn failed(&self, id: &str, why: &str) -> Result<(), String> {
        let mut connection = self.lock();
        let transaction = connection.transaction().map_err(failed)?;
        transaction
            .execute(
                "UPDATE deliveries SET state = 'failed', delivered_at = ?2, error = ?3 \
                 WHERE id = ?1",
                params![id, to_sql(now_ms()), why],
            )
            .map_err(failed)?;
        let occurrence: Option<String> = transaction
            .query_row(
                "SELECT id FROM occurrences WHERE delivery_id = ?1 AND state = 'waiting'",
                params![id],
                |row| row.get(0),
            )
            .optional()
            .map_err(failed)?;
        if let Some(occurrence) = occurrence {
            schedules::end(&transaction, &occurrence, schedules::Ending::Refused(why))
                .map_err(failed)?;
        }
        bots::refused(&transaction, id).map_err(failed)?;
        transaction.commit().map_err(failed)
    }

    /// Write down which request delivery `id` asks, before it's first sent.
    pub(crate) fn settle(&self, id: &str, work: &Work) -> Result<(), String> {
        let work = serde_json::to_string(work).map_err(|error| error.to_string())?;
        self.lock()
            .execute(
                "UPDATE deliveries SET work = ?2 WHERE id = ?1",
                params![id, work],
            )
            .map(drop)
            .map_err(failed)
    }
}

/// Write `work` down for `host_id`, under its own request key or else one made from the
/// delivery's id; a Bot's prompt names its Bot.
fn insert_delivery(
    connection: &Connection,
    host_id: &str,
    work: Work,
) -> rusqlite::Result<Delivery> {
    let bot_id = match &work {
        Work::Bot(prompt) => Some(prompt.bot_id.clone()),
        _ => None,
    };
    insert_delivery_as(connection, host_id, bot_id.as_deref(), |_| work)
}

/// Write down for `host_id` the work `make` makes from the delivery's id, under its own request
/// key or else one made from that id, for the Bot `bot_id` if it names one.
fn insert_delivery_as(
    connection: &Connection,
    host_id: &str,
    bot_id: Option<&str>,
    make: impl FnOnce(&str) -> Work,
) -> rusqlite::Result<Delivery> {
    let id = format!("w-{}", random_id());
    let work = make(&id);
    let work = match work.key() {
        Some(_) => work,
        None => work.keyed(format!("dispatcher/{id}")),
    };
    let delivery = Delivery {
        id,
        host_id: host_id.to_owned(),
        bot_id: bot_id.map(str::to_owned),
        work,
        state: DeliveryState::Pending,
        created_at: now_ms(),
        delivered_at: None,
        answer: None,
        error: None,
    };
    let work = serde_json::to_string(&delivery.work)
        .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
    connection.execute(
        "INSERT INTO deliveries (id, host_id, work, state, created_at, bot_id) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            delivery.id,
            delivery.host_id,
            work,
            delivery.state.name(),
            to_sql(delivery.created_at),
            delivery.bot_id
        ],
    )?;
    Ok(delivery)
}

const SELECT_DELIVERY: &str = "SELECT id, host_id, work, state, created_at, delivered_at, \
     answer, error, bot_id FROM deliveries";

fn delivery(row: &rusqlite::Row<'_>) -> rusqlite::Result<Delivery> {
    let state: String = row.get(3)?;
    Ok(Delivery {
        id: row.get(0)?,
        host_id: row.get(1)?,
        bot_id: row.get(8)?,
        work: json(2, &row.get::<_, String>(2)?)?,
        state: DeliveryState::named(&state),
        created_at: from_sql(row.get(4)?),
        delivered_at: row.get::<_, Option<i64>>(5)?.map(from_sql),
        answer: row
            .get::<_, Option<String>>(6)?
            .map(|text| json(6, &text))
            .transpose()?,
        error: row.get(7)?,
    })
}

/// Column `index`'s JSON.
fn json<T: serde::de::DeserializeOwned>(index: usize, text: &str) -> rusqlite::Result<T> {
    serde_json::from_str(text).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}

/// Take the database through the migrations it hasn't had, each in a transaction of its own.
fn migrate(connection: &mut Connection) -> rusqlite::Result<()> {
    let version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    let done = usize::try_from(version).unwrap_or(0);
    for (index, migration) in (1i64..).zip(MIGRATIONS.iter()).skip(done) {
        let transaction = connection.transaction()?;
        transaction.execute_batch(migration)?;
        transaction.pragma_update(None, "user_version", index)?;
        transaction.commit()?;
    }
    Ok(())
}

/// A time in milliseconds as SQLite keeps it, which is signed.
fn to_sql(ms: u64) -> i64 {
    i64::try_from(ms).unwrap_or(i64::MAX)
}

fn from_sql(ms: i64) -> u64 {
    u64::try_from(ms).unwrap_or(0)
}

fn failed(error: rusqlite::Error) -> String {
    format!("the Dispatcher's database: {error}")
}

/// 10 random bytes in lowercase hex.
pub(crate) fn random_id() -> String {
    let mut bytes = [0u8; 10];
    // The system's random source failing is no state to go on in.
    #[allow(clippy::expect_used)]
    getrandom::fill(&mut bytes).expect("the system's random source works");
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;
    use weave_acp_core::schema::ContentBlock;

    use super::*;

    fn host(id: &str) -> StoredHost {
        StoredHost {
            host_id: id.to_owned(),
            name: format!("host {id}"),
            url: format!("wss://{id}.example.ts.net:7341"),
            device_id: format!("d-{id}"),
            paired_at: 1,
            refused: None,
            public_key: None,
            joined_at: None,
            here: false,
        }
    }

    fn queue(key: Option<&str>) -> Work {
        Work::Queue(AddQueuedRequest {
            thread_id: "s-1".into(),
            prompt: vec![ContentBlock::from("hello".to_owned())],
            key: key.map(str::to_owned),
            caller: None,
            origin: None,
        })
    }

    #[test]
    fn migrating_again_changes_nothing() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("dispatcher.db");
        let store = Store::open(&path).expect("created");
        store.put_host(&host("h1")).expect("kept");
        drop(store);
        let store = Store::open(&path).expect("opened again");
        assert_eq!(store.hosts().expect("hosts"), vec![host("h1")]);
        let version: i64 = store
            .lock()
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("a version");
        assert_eq!(usize::try_from(version), Ok(MIGRATIONS.len()));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(&path).expect("file").permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    /// A database from before the Host protocol said thread (WVE-200): its
    /// columns said session, and so did the work it wrote down and the Hosts' answers.
    #[test]
    fn a_version_2_database_says_thread_once_migrated() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("dispatcher.db");
        let connection = Connection::open(&path).expect("created");
        for (version, migration) in (1i64..).zip(&MIGRATIONS[..5]) {
            connection.execute_batch(migration).expect("migrated");
            connection
                .pragma_update(None, "user_version", version)
                .expect("versioned");
        }
        connection
            .execute_batch(
                r#"
                INSERT INTO hosts (host_id, name, url, device_id, paired_at)
                    VALUES ('h1', 'host h1', '', 'd-h1', 1);
                INSERT INTO deliveries (id, host_id, work, state, created_at, answer) VALUES
                    ('d-run', 'h1', '{"run": {"agentId": "fake", "cwd": "/code",
                        "sessionId": "s-1", "prompt": [], "policy": {}, "key": "k-run",
                        "caller": {"sessionId": "s-9", "host": "h2"}}}',
                        'delivered', 1, '{"sessionId": "s-1", "turnId": "t-1"}'),
                    ('d-queue', 'h1', '{"queue": {"sessionId": "s-1", "prompt": [],
                        "key": "k-queue"}}', 'pending', 2, NULL),
                    ('d-report', 'h1', '{"report": {"sessionId": "s-9", "about":
                        {"sessionId": "s-1", "host": "h1"}, "text": "done", "key": "k-report"}}',
                        'pending', 3, NULL);
                INSERT INTO schedules (id, name, cron, zone, host_id, run, missed, overlap,
                        created_at, considered_until)
                    VALUES ('sc-1', 'daily', '0 9 * * *', 'UTC', 'h1',
                        '{"agentId": "fake", "cwd": "/code", "prompt": [], "policy": {}}',
                        'skip', 'skip', 1, 1);
                INSERT INTO occurrences (id, schedule_id, scheduled_at, late, manual, state,
                        session_id, turn_id, recorded_at)
                    VALUES ('o-1', 'sc-1', 1, 0, 0, 'started', 's-1', 't-1', 1);
                INSERT INTO follows (id, host_id, session_id, turn_id, calling_host, caller,
                        delegated, created_at)
                    VALUES ('f-1', 'h1', 's-1', 't-1', 'h2', 's-9', 1, 1);
                "#,
            )
            .expect("version-2 rows");
        drop(connection);

        let store = Store::open(&path).expect("migrated");
        let run = store.delivery("d-run").expect("read").expect("there");
        let Work::Run(request) = &run.work else {
            panic!("{:?}", run.work);
        };
        assert_eq!(request.thread_id, Some("s-1".into()));
        assert_eq!(
            request
                .caller
                .as_ref()
                .map(|caller| caller.thread_id.clone()),
            Some("s-9".into())
        );
        let answer = run.answer.expect("an answer");
        assert_eq!(answered_thread(&answer), Some("s-1"));
        assert_eq!(
            run.work.started(&answer),
            Some(("s-1".to_owned(), "t-1".to_owned()))
        );
        let pending = store.pending("h1").expect("pending");
        let works: Vec<&Work> = pending.iter().map(|delivery| &delivery.work).collect();
        assert!(
            matches!(works[..], [Work::Queue(queued), Work::Report(report)]
                if queued.thread_id == "s-1".into()
                    && report.thread_id == "s-9".into()
                    && report.about.thread_id == "s-1".into()),
            "{works:?}"
        );
        let occurrences = store.occurrences(Some("sc-1"), 10).expect("occurrences");
        assert_eq!(occurrences[0].thread_id, Some("s-1".into()));
        let follows = store.follows("h1").expect("follows");
        assert_eq!(follows[0].thread_id, "s-1");
    }

    #[test]
    fn work_waits_under_a_key_until_the_host_takes_or_refuses_it() {
        let store = Store::in_memory();
        store.put_host(&host("h1")).expect("kept");
        let made = store.add_delivery("h1", queue(None)).expect("written");
        assert_eq!(
            made.work.key(),
            Some(format!("dispatcher/{}", made.id).as_str())
        );
        let own = store
            .add_delivery("h1", queue(Some("daily@1")))
            .expect("written");
        assert_eq!(own.work.key(), Some("daily@1"));
        assert_eq!(
            store
                .pending("h1")
                .expect("pending")
                .iter()
                .map(|delivery| delivery.id.clone())
                .collect::<Vec<_>>(),
            vec![made.id.clone(), own.id.clone()]
        );

        store
            .delivered(&made.id, &serde_json::json!({"queuedId": "q-1"}))
            .expect("delivered");
        store.failed(&own.id, "no such agent").expect("failed");
        assert_eq!(store.pending_count(None).expect("a count"), 0);
        let delivered = store.delivery(&made.id).expect("read").expect("there");
        assert_eq!(delivered.state, DeliveryState::Delivered);
        assert_eq!(
            delivered.answer,
            Some(serde_json::json!({"queuedId": "q-1"}))
        );
        let refused = store.delivery(&own.id).expect("read").expect("there");
        assert_eq!(refused.state, DeliveryState::Failed);
        assert_eq!(refused.error.as_deref(), Some("no such agent"));
    }

    #[test]
    fn work_is_only_for_a_paired_host_and_goes_with_it() {
        let store = Store::in_memory();
        let unpaired = store.add_delivery("h9", queue(None)).expect_err("no Host");
        assert!(unpaired.contains("isn't paired with Host h9"), "{unpaired}");
        store.put_host(&host("h1")).expect("kept");
        store.add_delivery("h1", queue(None)).expect("written");
        assert!(store.remove_host("h1").expect("removed"));
        assert_eq!(store.pending_count(None).expect("a count"), 0);
        assert!(!store.remove_host("h1").expect("nothing to remove"));
    }
}
