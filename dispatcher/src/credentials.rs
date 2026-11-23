//! The person's credentials (ADR 0036, WVE-239): what lets their agents and git act as them,
//! kept encrypted in the Dispatcher's database and read only while it is unlocked.
//!
//! Each value is sealed with XChaCha20-Poly1305 under a random data key, bound to the
//! credential's name and kind so a row can't be passed off as another. The data key is itself
//! sealed under a key Argon2id makes from the person's passphrase, so the passphrase could be
//! changed without sealing every value again. The passphrase and the data key are never
//! written down: the Dispatcher holds the data key in memory from `credentials/unlock` until it
//! stops or `credentials/lock`, and a stolen database gives up names, kinds, expiry times and
//! renewal errors and nothing else. Names and kinds are plain, so listing and removing work
//! while locked.

use std::sync::Mutex;

use agent_client_protocol::Error;
use argon2::Algorithm;
use argon2::Argon2;
use argon2::Params;
use argon2::Version;
use chacha20poly1305::KeyInit as _;
use chacha20poly1305::XChaCha20Poly1305;
use chacha20poly1305::aead::Aead as _;
use chacha20poly1305::aead::Payload;
use weave_host_protocol::Timestamp;
use weave_host_protocol::credentials::HeldCredential;
use weave_host_protocol::dispatcher::Credential;
use weave_host_protocol::dispatcher::CredentialKind;
use weave_host_protocol::dispatcher::CredentialsState;
use weave_host_protocol::dispatcher::CredentialsStatus;
use weave_host_protocol::errors;
use zeroize::Zeroizing;

use crate::internal;
use crate::invalid;
use crate::lock;
use crate::signins;
use crate::store::Store;
use crate::store::credentials::SealedKey;

/// The fewest characters a new passphrase may have.
pub const SHORTEST_PASSPHRASE: usize = 12;
/// The longest a credential's name may be, and its value: a sign-in file is a few kilobytes.
const LONGEST_NAME: usize = 100;
const LONGEST_VALUE: usize = 256 * 1024;

const KEY_LENGTH: usize = 32;
const NONCE_LENGTH: usize = 24;
const SALT_LENGTH: usize = 16;

pub(crate) type Key = Zeroizing<[u8; KEY_LENGTH]>;

/// What Argon2id costs: the memory in kibibytes, the passes over it, and the lanes. Kept with
/// the sealed key, so a Dispatcher that raises its own later still opens what it sealed before.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KdfCost {
    pub memory_kib: u32,
    pub passes: u32,
    pub lanes: u32,
}

impl Default for KdfCost {
    /// OWASP's second Argon2id recommendation: 64 MiB, three passes, one lane.
    fn default() -> Self {
        Self {
            memory_kib: 64 * 1024,
            passes: 3,
            lanes: 1,
        }
    }
}

/// The data key, while the Dispatcher is unlocked.
#[derive(Default)]
pub(crate) struct Credentials {
    key: Mutex<Option<Key>>,
}

/// A sign-in opened for renewal: holds a clone of the data key so a rotated refresh token can
/// still be sealed back into SQLite even if the person locks the Dispatcher mid-flight.
pub(crate) struct OpenedSignIn {
    pub(crate) key: Key,
    pub(crate) agent: String,
    pub(crate) value: Zeroizing<String>,
    pub(crate) updated_at: Timestamp,
}

fn random<const N: usize>() -> Result<[u8; N], Error> {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes)
        .map_err(|error| internal(format!("no randomness for a credential: {error}")))?;
    Ok(bytes)
}

/// The key `passphrase` makes with `salt`, at `cost`.
fn derived(passphrase: &str, salt: &[u8], cost: KdfCost) -> Result<Key, Error> {
    let params = Params::new(cost.memory_kib, cost.passes, cost.lanes, Some(KEY_LENGTH))
        .map_err(|error| internal(format!("the credentials' key cost is wrong: {error}")))?;
    let mut key = Zeroizing::new([0u8; KEY_LENGTH]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(passphrase.as_bytes(), salt, key.as_mut_slice())
        .map_err(|error| internal(format!("deriving the credentials' key: {error}")))?;
    Ok(key)
}

fn cipher(key: &Key) -> XChaCha20Poly1305 {
    let key: &[u8; KEY_LENGTH] = key;
    XChaCha20Poly1305::new(key.into())
}

fn seal(
    key: &Key,
    nonce: &[u8; NONCE_LENGTH],
    plain: &[u8],
    bound_to: &[u8],
) -> Result<Vec<u8>, Error> {
    cipher(key)
        .encrypt(
            nonce.into(),
            Payload {
                msg: plain,
                aad: bound_to,
            },
        )
        .map_err(|_| internal("sealing a credential failed".to_owned()))
}

/// What was sealed, or none when the key is wrong or the row was changed.
fn opened(key: &Key, nonce: &[u8], sealed: &[u8], bound_to: &[u8]) -> Option<Zeroizing<Vec<u8>>> {
    let nonce: &[u8; NONCE_LENGTH] = nonce.try_into().ok()?;
    cipher(key)
        .decrypt(
            nonce.into(),
            Payload {
                msg: sealed,
                aad: bound_to,
            },
        )
        .ok()
        .map(Zeroizing::new)
}

/// What a credential's value is bound to: its name and kind.
fn binding(name: &str, kind: CredentialKind) -> Vec<u8> {
    let kind = match kind {
        CredentialKind::Token => "token",
        CredentialKind::SignIn => "signIn",
    };
    format!("weave credential\n{kind}\n{name}").into_bytes()
}

const KEY_BINDING: &[u8] = b"weave credentials key";

fn locked() -> Error {
    errors::credentials_locked(
        "the Dispatcher's credentials are locked: `weave credentials unlock` opens them",
    )
}

impl Credentials {
    pub(crate) fn is_unlocked(&self) -> bool {
        lock(&self.key).is_some()
    }

    pub(crate) fn status(&self, store: &Store) -> Result<CredentialsStatus, Error> {
        let state = if lock(&self.key).is_some() {
            CredentialsState::Unlocked
        } else if store.sealed_key().map_err(internal)?.is_some() {
            CredentialsState::Locked
        } else {
            CredentialsState::Unset
        };
        let count = store.credential_count().map_err(internal)?;
        Ok(CredentialsStatus { state, count })
    }

    /// Take the passphrase and hold the data key it opens. With `create`, make the data key and
    /// seal it under `passphrase`, which only a store with none takes.
    pub(crate) fn unlock(
        &self,
        store: &Store,
        passphrase: &str,
        create: bool,
        cost: KdfCost,
    ) -> Result<CredentialsStatus, Error> {
        let sealed = store.sealed_key().map_err(internal)?;
        let key = match (sealed, create) {
            (Some(_), true) => {
                return Err(invalid(
                    "the credentials have a passphrase already: unlock with it",
                ));
            }
            (None, false) => {
                return Err(errors::credentials_locked(
                    "the credentials have no passphrase yet: `weave credentials unlock` sets one",
                ));
            }
            (None, true) => {
                if passphrase.chars().count() < SHORTEST_PASSPHRASE {
                    return Err(invalid(format!(
                        "a passphrase has at least {SHORTEST_PASSPHRASE} characters"
                    )));
                }
                let salt = random::<SALT_LENGTH>()?;
                let nonce = random::<NONCE_LENGTH>()?;
                let key: Key = Zeroizing::new(random::<KEY_LENGTH>()?);
                let wrapping = derived(passphrase, &salt, cost)?;
                let sealed = seal(&wrapping, &nonce, key.as_slice(), KEY_BINDING)?;
                // Another unlock may have set one meanwhile; only the first is kept.
                if !store
                    .set_sealed_key(&SealedKey {
                        salt: salt.to_vec(),
                        cost,
                        nonce: nonce.to_vec(),
                        sealed,
                    })
                    .map_err(internal)?
                {
                    return Err(invalid(
                        "the credentials have a passphrase already: unlock with it",
                    ));
                }
                key
            }
            (Some(sealed), false) => {
                let wrapping = derived(passphrase, &sealed.salt, sealed.cost)?;
                let opened = opened(&wrapping, &sealed.nonce, &sealed.sealed, KEY_BINDING)
                    .ok_or_else(|| errors::unauthenticated("that isn't the passphrase"))?;
                let mut key = Zeroizing::new([0u8; KEY_LENGTH]);
                if opened.len() != KEY_LENGTH {
                    return Err(internal(
                        "the credentials' key is the wrong size".to_owned(),
                    ));
                }
                key.copy_from_slice(&opened);
                key
            }
        };
        *lock(&self.key) = Some(key);
        self.status(store)
    }

    /// Forget the data key.
    pub(crate) fn lock(&self, store: &Store) -> Result<CredentialsStatus, Error> {
        *lock(&self.key) = None;
        self.status(store)
    }

    fn key(&self) -> Result<Key, Error> {
        lock(&self.key).clone().ok_or_else(locked)
    }

    /// Keep `value` under `name`, in place of what was there.
    pub(crate) fn set(
        &self,
        store: &Store,
        name: &str,
        kind: CredentialKind,
        agent: Option<&str>,
        value: &str,
    ) -> Result<Credential, Error> {
        let name = name.trim();
        if name.is_empty() || name.len() > LONGEST_NAME || name.chars().any(char::is_control) {
            return Err(invalid(format!(
                "a credential's name is 1 to {LONGEST_NAME} characters on one line"
            )));
        }
        if value.is_empty() || value.len() > LONGEST_VALUE {
            return Err(invalid(format!(
                "a credential's value is 1 to {LONGEST_VALUE} bytes"
            )));
        }
        // A sign-in is for an agent, and is that agent's own file: checked by making the copy
        // a Host would get of it.
        let (agent, expires_at) = match (kind, agent) {
            (CredentialKind::SignIn, Some(agent)) => {
                let held = signins::copy(name, agent, value).map_err(invalid)?;
                (Some(agent), held.expires_at)
            }
            (CredentialKind::SignIn, None) => {
                return Err(invalid("a sign-in names the agent it is for"));
            }
            (CredentialKind::Token, Some(_)) => {
                return Err(invalid("only a sign-in is for an agent"));
            }
            (CredentialKind::Token, None) => (None, None),
        };
        let key = self.key()?;
        let nonce = random::<NONCE_LENGTH>()?;
        let sealed = seal(&key, &nonce, value.as_bytes(), &binding(name, kind))?;
        store
            .set_credential(name, kind, agent, expires_at, &nonce, &sealed)
            .map_err(internal)
    }

    /// Open a sign-in for renewal. Fails with `credentialsLocked` while locked, or invalid
    /// params when `name` doesn't exist or isn't a sign-in.
    pub(crate) fn open_for_renewal(
        &self,
        store: &Store,
        name: &str,
    ) -> Result<OpenedSignIn, Error> {
        let key = self.key()?;
        let kept = store
            .sealed_credential(name)
            .map_err(internal)?
            .ok_or_else(|| invalid(format!("no credential called {name}")))?;
        if kept.kind != CredentialKind::SignIn {
            return Err(invalid(format!(
                "{name} isn't a sign-in, so it isn't renewed"
            )));
        }
        let agent = kept
            .agent
            .ok_or_else(|| invalid(format!("sign-in {name} names no agent")))?;
        let plain = opened(
            &key,
            &kept.nonce,
            &kept.sealed,
            &binding(&kept.name, kept.kind),
        )
        .ok_or_else(|| internal(format!("credential {name} doesn't open with this key")))?;
        let value = std::str::from_utf8(&plain)
            .map_err(|_| internal(format!("credential {name} isn't text")))?
            .to_owned();
        Ok(OpenedSignIn {
            key,
            agent,
            value: Zeroizing::new(value),
            updated_at: kept.updated_at,
        })
    }

    /// Seal a renewed sign-in back under `name` if it hasn't been replaced or removed since
    /// `expected_updated_at`.
    pub(crate) fn save_renewed(
        store: &Store,
        key: &Key,
        name: &str,
        agent: &str,
        expected_updated_at: Timestamp,
        value: &str,
    ) -> Result<Option<Credential>, Error> {
        let held = signins::copy(name, agent, value).map_err(internal)?;
        let nonce = random::<NONCE_LENGTH>()?;
        let sealed = seal(
            key,
            &nonce,
            value.as_bytes(),
            &binding(name, CredentialKind::SignIn),
        )?;
        store
            .replace_renewed_credential(name, expected_updated_at, held.expires_at, &nonce, &sealed)
            .map_err(internal)
    }

    /// The copies a Host holds: each sign-in as its agent's program takes it, unable to renew.
    /// Tokens aren't given yet: a git credential goes with its Project. None while locked.
    pub(crate) fn for_hosts(&self, store: &Store) -> Result<Option<Vec<HeldCredential>>, Error> {
        let Some(key) = lock(&self.key).clone() else {
            return Ok(None);
        };
        let mut copies = Vec::new();
        for credential in store.credentials().map_err(internal)? {
            let (CredentialKind::SignIn, Some(agent)) = (credential.kind, &credential.agent) else {
                continue;
            };
            let Some(kept) = store
                .sealed_credential(&credential.name)
                .map_err(internal)?
            else {
                continue;
            };
            let opened = opened(
                &key,
                &kept.nonce,
                &kept.sealed,
                &binding(&kept.name, kept.kind),
            )
            .and_then(|plain| String::from_utf8(plain.to_vec()).ok().map(Zeroizing::new));
            // One that won't open or isn't the agent's file any more is left out, not a
            // reason to give Hosts none.
            match opened.map(|value| signins::copy(&credential.name, agent, &value)) {
                Some(Ok(copy)) => {
                    if credential.expires_at.is_none()
                        && let Some(expires_at) = copy.expires_at
                    {
                        let _ = store.set_credential_expiry(&credential.name, expires_at);
                    }
                    copies.push(copy);
                }
                Some(Err(why)) => {
                    tracing::warn!(credential = %credential.name, %why, "a sign-in can't be given to Hosts");
                }
                None => {
                    tracing::warn!(credential = %credential.name, "a sign-in doesn't open with this key");
                }
            }
        }
        Ok(Some(copies))
    }

    pub(crate) fn list(store: &Store) -> Result<Vec<Credential>, Error> {
        store.credentials().map_err(internal)
    }

    pub(crate) fn remove(store: &Store, name: &str) -> Result<(), Error> {
        if store.remove_credential(name).map_err(internal)? {
            Ok(())
        } else {
            Err(invalid(format!("no credential called {name}")))
        }
    }

    /// A credential's kind and value, for giving to a Host; none when there is none of that
    /// name. Never answered to a client.
    pub(crate) fn value(
        &self,
        store: &Store,
        name: &str,
    ) -> Result<Option<(CredentialKind, Zeroizing<String>)>, Error> {
        let key = self.key()?;
        let Some(kept) = store.sealed_credential(name).map_err(internal)? else {
            return Ok(None);
        };
        let plain = opened(
            &key,
            &kept.nonce,
            &kept.sealed,
            &binding(&kept.name, kept.kind),
        )
        .ok_or_else(|| internal(format!("credential {name} doesn't open with this key")))?;
        let value = std::str::from_utf8(&plain)
            .map_err(|_| internal(format!("credential {name} isn't text")))?
            .to_owned();
        Ok(Some((kept.kind, Zeroizing::new(value))))
    }
}
