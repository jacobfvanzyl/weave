//! The Dispatcher's own id and the devices paired with it (WVE-176): the person's other
//! computers, whose CLI reaches its WebSocket, each with the public key it proves itself with.
//! The Dispatcher keeps no secret for a device.

use rusqlite::OptionalExtension as _;
use rusqlite::params;
use weave_host_protocol::devices::Device;
use weave_host_protocol::devices::Jwk;

use super::Store;
use super::failed;
use super::from_sql;
use super::json;
use super::to_sql;

/// A device paired with the Dispatcher.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct StoredDevice {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) public_key: Jwk,
    pub(crate) paired_at: u64,
    pub(crate) last_seen_at: Option<u64>,
}

impl StoredDevice {
    /// As `devices/list` shows it, with `connections` open now.
    pub(crate) fn listing(&self, connections: u32) -> Device {
        Device {
            id: self.id.clone(),
            name: self.name.clone(),
            paired_at: self.paired_at,
            last_seen_at: self.last_seen_at,
            connections,
            service: false,
        }
    }
}

impl Store {
    /// The Dispatcher's id, made the first time it's asked for: 16 random bytes in unpadded
    /// base64url, as a Host's.
    pub(crate) fn identity(&self) -> Result<String, String> {
        let connection = self.lock();
        let id: Option<String> = connection
            .query_row("SELECT id FROM identity", [], |row| row.get(0))
            .optional()
            .map_err(failed)?;
        if let Some(id) = id {
            return Ok(id);
        }
        let id = weave_remote::pairing::random_id(16);
        connection
            .execute("INSERT INTO identity (id) VALUES (?1)", params![id])
            .map_err(failed)?;
        Ok(id)
    }

    pub(crate) fn devices(&self) -> Result<Vec<StoredDevice>, String> {
        let connection = self.lock();
        let mut statement = connection
            .prepare(
                "SELECT id, name, public_key, paired_at, last_seen_at FROM devices \
                 ORDER BY paired_at, id",
            )
            .map_err(failed)?;
        statement
            .query_map([], device)
            .and_then(Iterator::collect)
            .map_err(failed)
    }

    pub(crate) fn device(&self, id: &str) -> Result<Option<StoredDevice>, String> {
        self.lock()
            .query_row(
                "SELECT id, name, public_key, paired_at, last_seen_at FROM devices WHERE id = ?1",
                params![id],
                device,
            )
            .optional()
            .map_err(failed)
    }

    pub(crate) fn add_device(&self, device: &StoredDevice) -> Result<(), String> {
        let key = serde_json::to_string(&device.public_key).map_err(|error| error.to_string())?;
        self.lock()
            .execute(
                "INSERT INTO devices (id, name, public_key, paired_at, last_seen_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    device.id,
                    device.name,
                    key,
                    to_sql(device.paired_at),
                    device.last_seen_at.map(to_sql),
                ],
            )
            .map_err(failed)?;
        Ok(())
    }

    /// Note that `id` said hello at `at`.
    pub(crate) fn device_seen(&self, id: &str, at: u64) -> Result<(), String> {
        self.lock()
            .execute(
                "UPDATE devices SET last_seen_at = ?2 WHERE id = ?1",
                params![id, to_sql(at)],
            )
            .map_err(failed)?;
        Ok(())
    }

    /// Forget `id`; whether there was such a device.
    pub(crate) fn remove_device(&self, id: &str) -> Result<bool, String> {
        let removed = self
            .lock()
            .execute("DELETE FROM devices WHERE id = ?1", params![id])
            .map_err(failed)?;
        Ok(removed > 0)
    }

    /// Whether any device is paired, which keeps remote access on.
    pub(crate) fn any_device(&self) -> Result<bool, String> {
        self.lock()
            .query_row("SELECT EXISTS (SELECT 1 FROM devices)", [], |row| {
                row.get(0)
            })
            .map_err(failed)
    }
}

fn device(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredDevice> {
    Ok(StoredDevice {
        id: row.get(0)?,
        name: row.get(1)?,
        public_key: json(2, &row.get::<_, String>(2)?)?,
        paired_at: from_sql(row.get(3)?),
        last_seen_at: row.get::<_, Option<i64>>(4)?.map(from_sql),
    })
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    fn jwk() -> Jwk {
        Jwk {
            kty: "EC".to_owned(),
            crv: "P-256".to_owned(),
            x: "x".to_owned(),
            y: "y".to_owned(),
        }
    }

    #[test]
    fn the_dispatchers_id_is_made_once_and_kept() {
        let store = Store::in_memory();
        let id = store.identity().expect("an id");
        assert_eq!(id.len(), 22);
        assert_eq!(store.identity().expect("the same id"), id);
    }

    #[test]
    fn a_device_is_kept_seen_and_forgotten() {
        let store = Store::in_memory();
        assert!(!store.any_device().expect("asked"));
        let device = StoredDevice {
            id: "d-1".to_owned(),
            name: "mac".to_owned(),
            public_key: jwk(),
            paired_at: 5,
            last_seen_at: Some(5),
        };
        store.add_device(&device).expect("added");
        assert!(store.any_device().expect("asked"));
        store.device_seen("d-1", 9).expect("seen");
        let seen = StoredDevice {
            last_seen_at: Some(9),
            ..device
        };
        assert_eq!(store.device("d-1").expect("read"), Some(seen.clone()));
        assert_eq!(store.devices().expect("listed"), vec![seen]);
        assert!(store.remove_device("d-1").expect("removed"));
        assert!(!store.remove_device("d-1").expect("asked"));
        assert!(!store.any_device().expect("asked"));
    }
}
