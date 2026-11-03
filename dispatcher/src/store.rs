//! The Dispatcher's state, in SQLite (ADR 0027): the Hosts it is paired with and the work
//! written down for them. Later issues add triggers, their occurrences and Bots, each as a
//! migration of its own.

use std::path::Path;
use std::sync::Mutex;
use std::sync::MutexGuard;

use rusqlite::Connection;
use rusqlite::OptionalExtension as _;
use rusqlite::params;
use serde::Deserialize;
use serde::Serialize;
use weave_host_protocol::queue::AddQueuedRequest;
use weave_host_protocol::sessions::RunRequest;

use crate::now_ms;

/// Each migration takes the database from the version before it to its own number, its index
/// plus one, which `PRAGMA user_version` records. They are never edited once released.
const MIGRATIONS: [&str; 1] = ["
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
"];

/// A Host the Dispatcher is paired with.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct StoredHost {
    pub(crate) host_id: String,
    pub(crate) name: String,
    pub(crate) url: String,
    pub(crate) device_id: String,
    pub(crate) paired_at: u64,
    /// Why it refused the Dispatcher, as after revoking it, until it's paired again.
    pub(crate) refused: Option<String>,
}

/// What the Dispatcher asks a Host to do: start a headless turn, or add to a thread's queue.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Work {
    Run(RunRequest),
    Queue(AddQueuedRequest),
}

impl Work {
    pub(crate) fn key(&self) -> Option<&str> {
        match self {
            Self::Run(request) => request.key.as_deref(),
            Self::Queue(request) => request.key.as_deref(),
        }
    }

    fn keyed(mut self, key: String) -> Self {
        match &mut self {
            Self::Run(request) => request.key = Some(key),
            Self::Queue(request) => request.key = Some(key),
        }
        self
    }
}

/// Work written down for a Host before it is sent, so it reaches the Host once however often
/// it's sent.
#[derive(Clone, Debug, PartialEq)]
pub struct Delivery {
    pub id: String,
    pub host_id: String,
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
                "SELECT host_id, name, url, device_id, paired_at, refused FROM hosts \
                 ORDER BY name, host_id",
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
                })
            })
            .map_err(failed)?;
        rows.collect::<Result<_, _>>().map_err(failed)
    }

    /// Keep `host`, replacing what pairing with it before kept, its refusal included.
    pub(crate) fn put_host(&self, host: &StoredHost) -> Result<(), String> {
        self.lock()
            .execute(
                "INSERT INTO hosts (host_id, name, url, device_id, paired_at, refused) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6) \
                 ON CONFLICT (host_id) DO UPDATE SET name = ?2, url = ?3, device_id = ?4, \
                 paired_at = ?5, refused = ?6",
                params![
                    host.host_id,
                    host.name,
                    host.url,
                    host.device_id,
                    to_sql(host.paired_at),
                    host.refused
                ],
            )
            .map(drop)
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

    /// Forget `host_id`, and the work written down for it. Whether there was one.
    pub(crate) fn remove_host(&self, host_id: &str) -> Result<bool, String> {
        self.lock()
            .execute("DELETE FROM hosts WHERE host_id = ?1", params![host_id])
            .map(|removed| removed > 0)
            .map_err(failed)
    }

    /// Write `work` down for `host_id`, under its own request key or else one made from the
    /// delivery's id.
    pub(crate) fn add_delivery(&self, host_id: &str, work: Work) -> Result<Delivery, String> {
        let id = format!("w-{}", random_id());
        let work = match work.key() {
            Some(_) => work,
            None => work.keyed(format!("dispatcher/{id}")),
        };
        let delivery = Delivery {
            id,
            host_id: host_id.to_owned(),
            work,
            state: DeliveryState::Pending,
            created_at: now_ms(),
            delivered_at: None,
            answer: None,
            error: None,
        };
        let work = serde_json::to_string(&delivery.work).map_err(|error| error.to_string())?;
        self.lock()
            .execute(
                "INSERT INTO deliveries (id, host_id, work, state, created_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    delivery.id,
                    delivery.host_id,
                    work,
                    delivery.state.name(),
                    to_sql(delivery.created_at)
                ],
            )
            .map_err(|error| match error {
                rusqlite::Error::SqliteFailure(failure, _)
                    if failure.code == rusqlite::ErrorCode::ConstraintViolation =>
                {
                    format!("the Dispatcher isn't paired with Host {host_id}")
                }
                other => failed(other),
            })?;
        Ok(delivery)
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

    pub(crate) fn delivered(&self, id: &str, answer: &serde_json::Value) -> Result<(), String> {
        self.lock()
            .execute(
                "UPDATE deliveries SET state = 'delivered', delivered_at = ?2, answer = ?3 \
                 WHERE id = ?1",
                params![id, to_sql(now_ms()), answer.to_string()],
            )
            .map(drop)
            .map_err(failed)
    }

    pub(crate) fn failed(&self, id: &str, why: &str) -> Result<(), String> {
        self.lock()
            .execute(
                "UPDATE deliveries SET state = 'failed', delivered_at = ?2, error = ?3 \
                 WHERE id = ?1",
                params![id, to_sql(now_ms()), why],
            )
            .map(drop)
            .map_err(failed)
    }
}

const SELECT_DELIVERY: &str =
    "SELECT id, host_id, work, state, created_at, delivered_at, answer, error FROM deliveries";

fn delivery(row: &rusqlite::Row<'_>) -> rusqlite::Result<Delivery> {
    let state: String = row.get(3)?;
    Ok(Delivery {
        id: row.get(0)?,
        host_id: row.get(1)?,
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
fn random_id() -> String {
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
        }
    }

    fn queue(key: Option<&str>) -> Work {
        Work::Queue(AddQueuedRequest {
            session_id: "s-1".into(),
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
