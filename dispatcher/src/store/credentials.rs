//! The person's credentials at rest (ADR 0036, WVE-239), the thirteenth migration's
//! `credential_key` and `credentials`: the data key sealed under the passphrase's, and each
//! credential's value sealed under the data key. Names and kinds are plain. Nothing here can
//! open a value; [`crate::credentials`] does, while the Dispatcher is unlocked.

use rusqlite::OptionalExtension as _;
use rusqlite::params;
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
    pub(crate) nonce: Vec<u8>,
    pub(crate) sealed: Vec<u8>,
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
                "SELECT name, kind, created_at, updated_at, agent FROM credentials
                 ORDER BY name COLLATE NOCASE",
            )
            .map_err(failed)?;
        let rows = statement
            .query_map([], |row| {
                Ok(Credential {
                    name: row.get(0)?,
                    kind: kind_named(&row.get::<_, String>(1)?)?,
                    created_at: from_sql(row.get(2)?),
                    updated_at: from_sql(row.get(3)?),
                    agent: row.get(4)?,
                })
            })
            .map_err(failed)?;
        rows.collect::<Result<_, _>>().map_err(failed)
    }

    /// Keep a sealed value under `name`, in place of what was there, which keeps when it was
    /// first kept.
    pub(crate) fn set_credential(
        &self,
        name: &str,
        kind: CredentialKind,
        agent: Option<&str>,
        nonce: &[u8],
        sealed: &[u8],
    ) -> Result<Credential, String> {
        let now = now_ms();
        let connection = self.lock();
        connection
            .execute(
                "INSERT INTO credentials (name, kind, nonce, sealed, created_at, updated_at, agent)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6)
                 ON CONFLICT (name) DO UPDATE SET
                     kind = excluded.kind, nonce = excluded.nonce, sealed = excluded.sealed,
                     updated_at = excluded.updated_at, agent = excluded.agent",
                params![name, kind_name(kind), nonce, sealed, to_sql(now), agent],
            )
            .map_err(failed)?;
        connection
            .query_row(
                "SELECT created_at, updated_at FROM credentials WHERE name = ?1",
                [name],
                |row| {
                    Ok(Credential {
                        name: name.to_owned(),
                        kind,
                        agent: agent.map(str::to_owned),
                        created_at: from_sql(row.get(0)?),
                        updated_at: from_sql(row.get(1)?),
                    })
                },
            )
            .map_err(failed)
    }

    pub(crate) fn sealed_credential(&self, name: &str) -> Result<Option<SealedCredential>, String> {
        self.lock()
            .query_row(
                "SELECT name, kind, nonce, sealed FROM credentials WHERE name = ?1",
                [name],
                |row| {
                    Ok(SealedCredential {
                        name: row.get(0)?,
                        kind: kind_named(&row.get::<_, String>(1)?)?,
                        nonce: row.get(2)?,
                        sealed: row.get(3)?,
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
