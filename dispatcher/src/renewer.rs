//! Automatic and on-demand sign-in renewal (ADR 0036, WVE-239).
//!
//! While the Dispatcher's credentials are unlocked, a background task watches each sign-in's
//! expiry and renews it before its access token dies (1 hour before for Claude, 24 hours before
//! for Codex) by running the vendor's own program through [`crate::signins::Renewer`].
//!
//! Renewals are serialized so two attempts never race and rotate a vendor's refresh token out
//! from under each other. A failed renewal records the reason on the credential and backs off
//! (1m, 5m, 15m, 1h) until the next retry, an unlock, a replacement, or a manual renew.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;

use agent_client_protocol::Error;
use weave_host_protocol::Timestamp;
use weave_host_protocol::dispatcher::Credential;
use weave_host_protocol::dispatcher::CredentialKind;

use crate::Shared;
use crate::credentials::Credentials;
use crate::internal;
use crate::lock;
use crate::signins;

/// Retry delays after consecutive renewal failures, in milliseconds.
const BACKOFF_MS: [u64; 4] = [60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000, 60 * 60 * 1000];

/// Fallback wake interval while unlocked when no sign-in has a known expiry.
const IDLE_WAIT_MS: u64 = 60 * 60 * 1000;

/// Per-credential renewal retry backoff, held in memory.
#[derive(Default)]
pub(crate) struct Backoffs {
    entries: Mutex<HashMap<String, Backoff>>,
}

#[derive(Clone, Copy)]
struct Backoff {
    failures: usize,
    retry_at: Timestamp,
}

impl Backoffs {
    fn retry_at(&self, name: &str) -> Option<Timestamp> {
        lock(&self.entries).get(name).map(|entry| entry.retry_at)
    }

    fn failed(&self, name: &str, now: Timestamp) -> Timestamp {
        let mut entries = lock(&self.entries);
        let failures = entries
            .get(name)
            .map_or(0, |entry| entry.failures.saturating_add(1));
        let delay = BACKOFF_MS[failures.min(BACKOFF_MS.len() - 1)];
        let retry_at = now.saturating_add(delay);
        entries.insert(name.to_owned(), Backoff { failures, retry_at });
        retry_at
    }

    pub(crate) fn clear(&self, name: &str) {
        lock(&self.entries).remove(name);
    }

    pub(crate) fn clear_all(&self) {
        lock(&self.entries).clear();
    }
}

/// Watch every sign-in and renew each before its access token expires, until the Dispatcher
/// stops. Does nothing while the credentials are locked.
pub(crate) async fn run(shared: Arc<Shared>) {
    loop {
        if !shared.credentials.is_unlocked() {
            tokio::select! {
                () = shared.credentials_changed.notified() => continue,
                () = shared.stop.cancelled() => return,
            }
        }
        // Backfill expiry on any sign-in stored before migration 15 while we have the key.
        let _ = shared.credentials.for_hosts(&shared.store);

        let now = shared.config.clock.now();
        let credentials = match shared.store.credentials() {
            Ok(credentials) => credentials,
            Err(why) => {
                tracing::warn!(%why, "reading credentials for renewal failed");
                tokio::select! {
                    () = shared.config.clock.wait_until(now.saturating_add(BACKOFF_MS[0])) => continue,
                    () = shared.credentials_changed.notified() => continue,
                    () = shared.stop.cancelled() => return,
                }
            }
        };

        let mut due = Vec::new();
        let mut next_wake: Option<Timestamp> = None;
        for credential in credentials {
            let (CredentialKind::SignIn, Some(agent), Some(expires_at)) = (
                credential.kind,
                credential.agent.as_deref(),
                credential.expires_at,
            ) else {
                continue;
            };
            let lead = signins::renew_before(agent);
            let due_at = expires_at.saturating_sub(lead);
            let effective = match shared.renew_backoffs.retry_at(&credential.name) {
                Some(retry_at) => due_at.max(retry_at),
                None => due_at,
            };
            if now >= effective {
                due.push(credential.name);
            } else {
                next_wake = Some(next_wake.map_or(effective, |cur| cur.min(effective)));
            }
        }

        if !due.is_empty() {
            for name in due {
                if shared.stop.is_cancelled() {
                    return;
                }
                if !shared.credentials.is_unlocked() {
                    break;
                }
                match renew_one(&shared, &name).await {
                    Ok(updated) => {
                        tracing::info!(
                            credential = %updated.name,
                            expires_at = updated.expires_at,
                            "renewed sign-in"
                        );
                    }
                    Err(error) => {
                        tracing::warn!(
                            credential = %name,
                            why = %error.message,
                            "renewing sign-in failed"
                        );
                    }
                }
            }
            continue;
        }

        let wake = next_wake.unwrap_or_else(|| now.saturating_add(IDLE_WAIT_MS));
        tokio::select! {
            () = shared.config.clock.wait_until(wake) => {}
            () = shared.credentials_changed.notified() => {}
            () = shared.stop.cancelled() => return,
        }
    }
}

/// Renew the sign-in `name` now, serialized against other renewals, and sync every connected
/// Host once saved.
pub(crate) async fn renew_one(shared: &Arc<Shared>, name: &str) -> Result<Credential, Error> {
    let _guard = shared.renewing.lock().await;
    let opened = shared.credentials.open_for_renewal(&shared.store, name)?;
    let now = shared.config.clock.now();
    match shared
        .config
        .renewer
        .renew(&opened.agent, &opened.value)
        .await
    {
        Ok(fresh) => {
            let saved = Credentials::save_renewed(
                &shared.store,
                &opened.key,
                name,
                &opened.agent,
                opened.updated_at,
                &fresh,
            )?;
            shared.renew_backoffs.clear(name);
            match saved {
                Some(credential) => {
                    shared.sync_credentials();
                    shared.credentials_changed.notify_one();
                    Ok(credential)
                }
                None => {
                    // The credential was replaced or removed while renewal was running; don't
                    // clobber the person's newer value.
                    shared
                        .store
                        .credential(name)
                        .map_err(internal)?
                        .ok_or_else(|| crate::invalid(format!("no credential called {name}")))
                }
            }
        }
        Err(why) => {
            let _ = shared
                .store
                .record_renewal_error(name, opened.updated_at, &why);
            shared.renew_backoffs.failed(name, now);
            Err(internal(why))
        }
    }
}
