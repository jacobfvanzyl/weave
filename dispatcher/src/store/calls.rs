//! Calls a Host's agents make to the person's other Hosts (ADR 0029, WVE-185), and the turns
//! they began there. A call that starts a turn is a delivery to the named Host with a `calls`
//! row naming the calling Host and thread; once the Host takes it, a `follows` row keeps the
//! turn until it ends there and the calling thread has been told, across the Dispatcher's
//! restarts. The calling Host keeps no record of either.

use rusqlite::OptionalExtension as _;
use rusqlite::Transaction;
use rusqlite::params;

use super::Delivery;
use super::Store;
use super::Work;
use super::failed;
use super::insert_delivery;
use super::random_id;
use super::to_sql;
use crate::now_ms;

/// Who a call came from: the thread whose agent asked, on the calling Host.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Call {
    pub(crate) calling_host: String,
    pub(crate) caller: String,
    /// It starts a delegated thread of the caller's, which counts toward its
    /// `[delegation] running`.
    pub(crate) delegated: bool,
    /// The named Host's answer to it was lost, so the caller hasn't heard whether it started.
    pub(crate) lost: bool,
}

/// A turn a call began, followed until it ends.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Follow {
    pub(crate) id: String,
    pub(crate) host_id: String,
    pub(crate) thread_id: String,
    pub(crate) turn_id: String,
    pub(crate) calling_host: String,
    pub(crate) caller: String,
    pub(crate) delegated: bool,
    /// The pending requests in it the caller has been told wait on a person.
    pub(crate) told: Vec<String>,
}

impl Store {
    /// Write down `work` for `host_id`, a call from `call`'s thread, before it's first sent.
    pub(crate) fn add_call(
        &self,
        host_id: &str,
        work: Work,
        call: &Call,
    ) -> Result<Delivery, String> {
        let mut connection = self.lock();
        let transaction = connection.transaction().map_err(failed)?;
        let delivery = insert_delivery(&transaction, host_id, work).map_err(failed)?;
        transaction
            .execute(
                "INSERT INTO calls (delivery_id, calling_host, caller, delegated) \
                 VALUES (?1, ?2, ?3, ?4)",
                params![delivery.id, call.calling_host, call.caller, call.delegated],
            )
            .map_err(failed)?;
        transaction.commit().map_err(failed)?;
        Ok(delivery)
    }

    /// The call delivery `id` is, if it's one.
    pub(crate) fn call(&self, id: &str) -> Result<Option<Call>, String> {
        self.lock()
            .query_row(
                "SELECT calling_host, caller, delegated, lost FROM calls WHERE delivery_id = ?1",
                params![id],
                |row| {
                    Ok(Call {
                        calling_host: row.get(0)?,
                        caller: row.get(1)?,
                        delegated: row.get(2)?,
                        lost: row.get(3)?,
                    })
                },
            )
            .optional()
            .map_err(failed)
    }

    /// The named Host's answer to the call delivery `id` was lost: it's sent again, and its
    /// caller told what came of it.
    pub(crate) fn lost(&self, id: &str) -> Result<(), String> {
        self.lock()
            .execute(
                "UPDATE calls SET lost = 1 WHERE delivery_id = ?1",
                params![id],
            )
            .map(drop)
            .map_err(failed)
    }

    /// How many of `caller`'s delegated threads on other Hosts run a turn it began, or may: the
    /// turns followed, and the calls not yet taken.
    pub(crate) fn delegated_running(
        &self,
        calling_host: &str,
        caller: &str,
    ) -> Result<u32, String> {
        let connection = self.lock();
        let following: u32 = connection
            .query_row(
                "SELECT count(*) FROM follows \
                 WHERE calling_host = ?1 AND caller = ?2 AND delegated = 1",
                params![calling_host, caller],
                |row| row.get(0),
            )
            .map_err(failed)?;
        let sending: u32 = connection
            .query_row(
                "SELECT count(*) FROM calls JOIN deliveries ON deliveries.id = calls.delivery_id \
                 WHERE calls.calling_host = ?1 AND calls.caller = ?2 AND calls.delegated = 1 \
                 AND deliveries.state = 'pending'",
                params![calling_host, caller],
                |row| row.get(0),
            )
            .map_err(failed)?;
        Ok(following + sending)
    }

    /// The turns followed on `host_id`.
    pub(crate) fn follows(&self, host_id: &str) -> Result<Vec<Follow>, String> {
        let connection = self.lock();
        let mut statement = connection
            .prepare(
                "SELECT id, host_id, thread_id, turn_id, calling_host, caller, delegated, told \
                 FROM follows WHERE host_id = ?1 ORDER BY created_at, rowid",
            )
            .map_err(failed)?;
        let rows = statement
            .query_map(params![host_id], |row| {
                let told: String = row.get(7)?;
                Ok(Follow {
                    id: row.get(0)?,
                    host_id: row.get(1)?,
                    thread_id: row.get(2)?,
                    turn_id: row.get(3)?,
                    calling_host: row.get(4)?,
                    caller: row.get(5)?,
                    delegated: row.get(6)?,
                    told: serde_json::from_str(&told).unwrap_or_default(),
                })
            })
            .map_err(failed)?;
        rows.collect::<Result<_, _>>().map_err(failed)
    }

    /// The followed turn `id` was interrupted, and its thread continued it in `turn_id`.
    pub(crate) fn continued_follow(&self, id: &str, turn_id: &str) -> Result<(), String> {
        self.lock()
            .execute(
                "UPDATE follows SET turn_id = ?2 WHERE id = ?1",
                params![id, turn_id],
            )
            .map(drop)
            .map_err(failed)
    }

    /// The caller of the followed turn `id` was told of the requests `told` names.
    pub(crate) fn told(&self, id: &str, told: &[String]) -> Result<(), String> {
        let told = serde_json::to_string(told).map_err(|error| error.to_string())?;
        self.lock()
            .execute(
                "UPDATE follows SET told = ?2 WHERE id = ?1",
                params![id, told],
            )
            .map(drop)
            .map_err(failed)
    }

    /// Stop following `follow`, writing down the report to its caller, `report`, for the
    /// calling Host in the same transaction, so the caller is told once.
    pub(crate) fn unfollow(&self, follow: &Follow, report: Option<Work>) -> Result<(), String> {
        let mut connection = self.lock();
        let transaction = connection.transaction().map_err(failed)?;
        let removed = transaction
            .execute("DELETE FROM follows WHERE id = ?1", params![follow.id])
            .map_err(failed)?;
        if removed > 0
            && let Some(report) = report
        {
            insert_delivery(&transaction, &follow.calling_host, report).map_err(failed)?;
        }
        transaction.commit().map_err(failed)
    }
}

/// The call delivery `id` was taken, beginning `turn_id` in `thread_id`: follow it.
pub(super) fn begun(
    transaction: &Transaction<'_>,
    id: &str,
    thread_id: &str,
    turn_id: &str,
) -> rusqlite::Result<()> {
    let call: Option<(String, String, String, bool)> = transaction
        .query_row(
            "SELECT deliveries.host_id, calls.calling_host, calls.caller, calls.delegated \
             FROM calls JOIN deliveries ON deliveries.id = calls.delivery_id \
             WHERE calls.delivery_id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    let Some((host_id, calling_host, caller, delegated)) = call else {
        return Ok(());
    };
    transaction.execute(
        "INSERT OR IGNORE INTO follows \
         (id, host_id, thread_id, turn_id, calling_host, caller, delegated, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            format!("f-{}", random_id()),
            host_id,
            thread_id,
            turn_id,
            calling_host,
            caller,
            delegated,
            to_sql(now_ms())
        ],
    )?;
    Ok(())
}
