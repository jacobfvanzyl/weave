//! The person's credentials at rest (ADR 0036, WVE-239), the thirteenth migration's
//! `credential_key` and `credentials`: the data key sealed under the passphrase's, and each
//! credential's value sealed under the data key. Names, kinds, expiry times and renewal errors
//! are plain. Nothing here can open a value; [`crate::credentials`] does, while the Dispatcher
//! is unlocked.

use rusqlite::OptionalExtension as _;
use rusqlite::params;
use weave_host_protocol::Timestamp;
use weave_host_protocol::dispatcher::Credential;
use weave_host_protocol::dispatcher::CredentialKind;

use super::Store;
use super::failed;
use super::from_sql;
use super::to_sql;
use crate::credentials::KdfCost;
use crate::now_ms;

/// The data key as it is kept: sealed under the key the passphrase makes with `salt` at `cost`.
pub(crate) struct SealedKey {
    pub(crate) salt: Vec<u8>,
    pub(crate) cost: KdfCost,
    pub(crate) nonce: Vec<u8>,
    pub(crate) sealed: Vec<u8>,
}

/// A credential as it is kept.
pub(crate) struct SealedCredential {
    pub(crate) name: String,
    pub(crate) kind: CredentialKind,
    pub(crate) agent: Option<String>,
    pub(crate) nonce: Vec<u8>,
    pub(crate) sealed: Vec<u8>,
    pub(crate) updated_at: Timestamp,
}

fn kind_name(kind: CredentialKind) -> &'static str {
    match kind {
        CredentialKind::Token => "token",
        CredentialKind::SignIn => "signIn",
    }
}

fn kind_named(name: &str) -> rusqlite::Result<CredentialKind> {
    match name {
        "token" => Ok(CredentialKind::Token),
        "signIn" => Ok(CredentialKind::SignIn),
        other => Err(rusqlite::Error::InvalidColumnType(
            1,
            format!("credential kind {other}"),
            rusqlite::types::Type::Text,
        )),
    }
}

fn row_to_credential(row: &rusqlite::Row<'_>) -> rusqlite::Result<Credential> {
    Ok(Credential {
        name: row.get(0)?,
        kind: kind_named(&row.get::<_, String>(1)?)?,
        created_at: from_sql(row.get(2)?),
        updated_at: from_sql(row.get(3)?),
        agent: row.get(4)?,
        expires_at: row.get::<_, Option<i64>>(5)?.map(from_sql),
        renewal_error: row.get(6)?,
    })
}

impl Store {
    pub(crate) fn sealed_key(&self) -> Result<Option<SealedKey>, String> {
        self.lock()
            .query_row(
                "SELECT salt, memory_kib, passes, lanes, nonce, sealed FROM credential_key",
                [],
                |row| {
                    Ok(SealedKey {
                        salt: row.get(0)?,
                        cost: KdfCost {
                            memory_kib: row.get(1)?,
                            passes: row.get(2)?,
                            lanes: row.get(3)?,
                        },
                        nonce: row.get(4)?,
                        sealed: row.get(5)?,
                    })
                },
            )
            .optional()
            .map_err(failed)
    }

    /// Keep the sealed data key, unless one is kept already; whether it was kept.
    pub(crate) fn set_sealed_key(&self, key: &SealedKey) -> Result<bool, String> {
        self.lock()
            .execute(
                "INSERT OR IGNORE INTO credential_key
                     (id, salt, memory_kib, passes, lanes, nonce, sealed, created_at)
                 VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    key.salt,
                    key.cost.memory_kib,
                    key.cost.passes,
                    key.cost.lanes,
                    key.nonce,
                    key.sealed,
                    to_sql(now_ms()),
                ],
            )
            .map(|changed| changed == 1)
            .map_err(failed)
    }

    pub(crate) fn credential_count(&self) -> Result<u32, String> {
        self.lock()
            .query_row("SELECT COUNT(*) FROM credentials", [], |row| row.get(0))
            .map_err(failed)
    }

    /// The credentials, by name, without their values.
    pub(crate) fn credentials(&self) -> Result<Vec<Credential>, String> {
        let connection = self.lock();
        let mut statement = connection
            .prepare(
                "SELECT name, kind, created_at, updated_at, agent, expires_at, renewal_error
                 FROM credentials
                 ORDER BY name COLLATE NOCASE",
            )
            .map_err(failed)?;
        let rows = statement.query_map([], row_to_credential).map_err(failed)?;
        rows.collect::<Result<_, _>>().map_err(failed)
    }

    /// One credential's metadata, without its value.
    pub(crate) fn credential(&self, name: &str) -> Result<Option<Credential>, String> {
        self.lock()
            .query_row(
                "SELECT name, kind, created_at, updated_at, agent, expires_at, renewal_error
                 FROM credentials WHERE name = ?1",
                [name],
                row_to_credential,
            )
            .optional()
            .map_err(failed)
    }

    /// Keep a sealed value under `name`, in place of what was there, which keeps when it was
    /// first kept and clears any renewal error.
    pub(crate) fn set_credential(
        &self,
        name: &str,
        kind: CredentialKind,
        agent: Option<&str>,
        expires_at: Option<Timestamp>,
        nonce: &[u8],
        sealed: &[u8],
    ) -> Result<Credential, String> {
        let now = now_ms();
        let connection = self.lock();
        connection
            .execute(
                "INSERT INTO credentials
                     (name, kind, nonce, sealed, created_at, updated_at, agent, expires_at, renewal_error)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6, ?7, NULL)
                 ON CONFLICT (name) DO UPDATE SET
                     kind = excluded.kind, nonce = excluded.nonce, sealed = excluded.sealed,
                     updated_at = excluded.updated_at, agent = excluded.agent,
                     expires_at = excluded.expires_at, renewal_error = NULL",
                params![
                    name,
                    kind_name(kind),
                    nonce,
                    sealed,
                    to_sql(now),
                    agent,
                    expires_at.map(to_sql),
                ],
            )
            .map_err(failed)?;
        connection
            .query_row(
                "SELECT name, kind, created_at, updated_at, agent, expires_at, renewal_error
                 FROM credentials WHERE name = ?1",
                [name],
                row_to_credential,
            )
            .map_err(failed)
    }

    /// Save a renewed sign-in if the credential wasn't replaced or removed while it was renewing
    /// (`updated_at == expected_updated_at`). Returns the updated row, or `None` if it moved.
    pub(crate) fn replace_renewed_credential(
        &self,
        name: &str,
        expected_updated_at: Timestamp,
        expires_at: Option<Timestamp>,
        nonce: &[u8],
        sealed: &[u8],
    ) -> Result<Option<Credential>, String> {
        let now = now_ms().max(expected_updated_at.saturating_add(1));
        let connection = self.lock();
        let changed = connection
            .execute(
                "UPDATE credentials
                 SET nonce = ?1, sealed = ?2, updated_at = ?3, expires_at = ?4, renewal_error = NULL
                 WHERE name = ?5 AND kind = 'signIn' AND updated_at = ?6",
                params![
                    nonce,
                    sealed,
                    to_sql(now),
                    expires_at.map(to_sql),
                    name,
                    to_sql(expected_updated_at),
                ],
            )
            .map_err(failed)?;
        if changed == 0 {
            return Ok(None);
        }
        connection
            .query_row(
                "SELECT name, kind, created_at, updated_at, agent, expires_at, renewal_error
                 FROM credentials WHERE name = ?1",
                [name],
                row_to_credential,
            )
            .optional()
            .map_err(failed)
    }

    /// Record why renewing `name` failed, if it hasn't been replaced since `expected_updated_at`.
    pub(crate) fn record_renewal_error(
        &self,
        name: &str,
        expected_updated_at: Timestamp,
        error: &str,
    ) -> Result<(), String> {
        self.lock()
            .execute(
                "UPDATE credentials SET renewal_error = ?1
                 WHERE name = ?2 AND updated_at = ?3",
                params![error, name, to_sql(expected_updated_at)],
            )
            .map(|_| ())
            .map_err(failed)
    }

    /// Backfill `expires_at` on a sign-in stored before migration 15, if still empty.
    pub(crate) fn set_credential_expiry(
        &self,
        name: &str,
        expires_at: Timestamp,
    ) -> Result<(), String> {
        self.lock()
            .execute(
                "UPDATE credentials SET expires_at = ?1
                 WHERE name = ?2 AND expires_at IS NULL",
                params![to_sql(expires_at), name],
            )
            .map(|_| ())
            .map_err(failed)
    }

    pub(crate) fn sealed_credential(&self, name: &str) -> Result<Option<SealedCredential>, String> {
        self.lock()
            .query_row(
                "SELECT name, kind, agent, nonce, sealed, updated_at
                 FROM credentials WHERE name = ?1",
                [name],
                |row| {
                    Ok(SealedCredential {
                        name: row.get(0)?,
                        kind: kind_named(&row.get::<_, String>(1)?)?,
                        agent: row.get(2)?,
                        nonce: row.get(3)?,
                        sealed: row.get(4)?,
                        updated_at: from_sql(row.get(5)?),
                    })
                },
            )
            .optional()
            .map_err(failed)
    }

    /// Forget the credential called `name`; whether there was one.
    pub(crate) fn remove_credential(&self, name: &str) -> Result<bool, String> {
        self.lock()
            .execute("DELETE FROM credentials WHERE name = ?1", [name])
            .map(|changed| changed == 1)
            .map_err(failed)
    }
}
