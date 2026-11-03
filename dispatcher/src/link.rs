//! The Dispatcher's connection to one Host: kept up, with backoff, from the Dispatcher's side,
//! since Hosts never connect to it. While connected it watches the Host's threads and sends it
//! the work written down for it, oldest first. A Host that refuses its key, as after revoking
//! it, isn't tried again until it's paired again.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;

use agent_client_protocol::Error;
use agent_client_protocol::schema::v1::SessionId;
use tokio::sync::Notify;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use weave_host_client::Credentials;
use weave_host_client::HostConnection;
use weave_host_client::HostEvent;
use weave_host_client::reach::reach;
use weave_host_client::remote::CloseReason;
use weave_host_protocol::errors;
use weave_host_protocol::peers::PeerStatus;
use weave_host_protocol::sessions::SessionListing;
use weave_host_protocol::sessions::WatchSessionsRequest;
use weave_host_protocol::websocket::CLOSE_REVOKED;

use crate::Shared;
use crate::client_info;
use crate::lock;
use crate::now_ms;
use crate::store::Delivery;
use crate::store::StoredHost;
use crate::store::Work;

pub(crate) struct Link {
    /// Rung when work is written down for the Host.
    wake: Arc<Notify>,
    stop: CancellationToken,
    seen: Arc<Mutex<Seen>>,
    task: JoinHandle<()>,
}

/// How the link stands, and the Host's threads as it last saw them.
#[derive(Clone)]
pub(crate) struct Seen {
    pub(crate) connected: bool,
    pub(crate) status: PeerStatus,
    pub(crate) why: Option<String>,
    pub(crate) connected_at: Option<u64>,
    threads: HashMap<SessionId, SessionListing>,
}

impl Default for Seen {
    fn default() -> Self {
        Self {
            connected: false,
            status: PeerStatus::Unchecked,
            why: None,
            connected_at: None,
            threads: HashMap::new(),
        }
    }
}

/// How a connection ended.
enum Ended {
    /// The Dispatcher stopped, or let the Host go.
    Stopped,
    /// The Host revoked the Dispatcher.
    Revoked,
    /// It closed, or nothing came from it.
    Lost,
}

impl Link {
    pub(crate) fn start(shared: Arc<Shared>, host: StoredHost) -> Self {
        let wake = Arc::new(Notify::new());
        let stop = shared.stop.child_token();
        let seen = Arc::new(Mutex::new(Seen::default()));
        let task = tokio::spawn(keep(
            shared,
            host,
            Arc::clone(&wake),
            stop.clone(),
            Arc::clone(&seen),
        ));
        Self {
            wake,
            stop,
            seen,
            task,
        }
    }

    pub(crate) fn wake(&self) {
        self.wake.notify_one();
    }

    pub(crate) fn stop(&self) {
        self.stop.cancel();
    }

    /// Wait for the link to end, once it's been stopped.
    pub(crate) async fn stopped(self) {
        self.stop.cancel();
        let _ = self.task.await;
    }

    pub(crate) fn seen(&self) -> Seen {
        lock(&self.seen).clone()
    }

    pub(crate) fn threads(&self) -> Vec<SessionListing> {
        let mut threads: Vec<SessionListing> = lock(&self.seen).threads.values().cloned().collect();
        threads.sort_by(|a, b| a.info.session_id.0.cmp(&b.info.session_id.0));
        threads
    }
}

/// Keep a connection to `host` until stopped or refused.
async fn keep(
    shared: Arc<Shared>,
    host: StoredHost,
    wake: Arc<Notify>,
    stop: CancellationToken,
    seen: Arc<Mutex<Seen>>,
) {
    if let Some(why) = &host.refused {
        note(&seen, PeerStatus::Refused, Some(why.clone()));
        return;
    }
    let mut delay = shared.config.retry;
    loop {
        let credentials = Credentials::Device {
            device_id: host.device_id.clone(),
            key: shared.key.clone(),
            host_id: Some(host.host_id.clone()),
        };
        let attempt = tokio::select! {
            reached = reach(
                &host.url,
                client_info(),
                credentials,
                shared.config.reach_timeout,
                "the Dispatcher",
            ) => reached,
            () = stop.cancelled() => return,
        };
        match attempt {
            Ok((connection, events, closed)) => {
                delay = shared.config.retry;
                tracing::info!(host = %host.host_id, "connected to a Host");
                match follow(
                    &shared, &host, &wake, &stop, &seen, connection, events, &closed,
                )
                .await
                {
                    Ended::Stopped => return,
                    Ended::Revoked => {
                        refused(&shared, &host, &seen, "it revoked the Dispatcher");
                        return;
                    }
                    Ended::Lost => {
                        tracing::info!(host = %host.host_id, "lost the connection to a Host");
                        note(
                            &seen,
                            PeerStatus::Unreachable,
                            Some("the connection closed".to_owned()),
                        );
                    }
                }
            }
            Err(unreached) if unreached.refused() => {
                refused(&shared, &host, &seen, &unreached.why);
                return;
            }
            Err(unreached) => {
                tracing::debug!(host = %host.host_id, why = %unreached, "couldn't reach a Host");
                note(&seen, unreached.status, Some(unreached.why));
            }
        }
        tokio::select! {
            () = tokio::time::sleep(delay) => {}
            () = stop.cancelled() => return,
        }
        delay = delay.saturating_mul(2).min(shared.config.retry_most);
    }
}

/// Watch the Host's threads and send it its work while the connection lasts.
#[allow(clippy::too_many_arguments)]
async fn follow(
    shared: &Shared,
    host: &StoredHost,
    wake: &Notify,
    stop: &CancellationToken,
    seen: &Mutex<Seen>,
    connection: HostConnection,
    mut events: mpsc::UnboundedReceiver<HostEvent>,
    closed: &CloseReason,
) -> Ended {
    {
        let mut seen = lock(seen);
        seen.connected = true;
        seen.status = PeerStatus::Reachable;
        seen.why = None;
        seen.connected_at = Some(now_ms());
    }
    match connection.send(WatchSessionsRequest {}).await {
        Ok(watched) => {
            lock(seen).threads = watched
                .sessions
                .into_iter()
                .map(|listing| (listing.info.session_id.clone(), listing))
                .collect();
        }
        Err(error) => {
            tracing::warn!(host = %host.host_id, %error, "watching a Host's threads failed")
        }
    }
    send_pending(shared, host, &connection).await;
    let ended = loop {
        tokio::select! {
            event = events.recv() => match event {
                Some(HostEvent::SessionUpdated(updated)) => {
                    let listing = updated.session;
                    lock(seen).threads.insert(listing.info.session_id.clone(), listing);
                }
                Some(HostEvent::SessionRemoved(removed)) => {
                    lock(seen).threads.remove(&removed.session_id);
                }
                Some(HostEvent::Disconnected(_)) | None => break None,
                Some(_) => {}
            },
            () = wake.notified() => send_pending(shared, host, &connection).await,
            () = stop.cancelled() => break Some(Ended::Stopped),
        }
    };
    connection.shutdown().await;
    {
        let mut seen = lock(seen);
        seen.connected = false;
        seen.threads.clear();
    }
    match ended {
        Some(ended) => ended,
        None if closed.get().is_some_and(|(code, _)| code == CLOSE_REVOKED) => Ended::Revoked,
        None => Ended::Lost,
    }
}

/// Send the Host the work written down for it, oldest first, until it's all taken or the
/// connection fails. Work the Host refuses is failed, saying why; work it couldn't take now,
/// as while it stops, is sent again on the next connection.
async fn send_pending(shared: &Shared, host: &StoredHost, connection: &HostConnection) {
    let pending = match shared.store.pending(&host.host_id) {
        Ok(pending) => pending,
        Err(why) => {
            tracing::warn!(host = %host.host_id, %why, "reading the work for a Host failed");
            return;
        }
    };
    for delivery in pending {
        match send(connection, &delivery).await {
            Ok(answer) => {
                if let Err(why) = shared.store.delivered(&delivery.id, &answer) {
                    tracing::warn!(delivery = %delivery.id, %why, "recording a delivery failed");
                }
                tracing::info!(host = %host.host_id, delivery = %delivery.id, "delivered");
            }
            Err(error) if again(&error) => {
                tracing::info!(host = %host.host_id, delivery = %delivery.id, %error, "a Host couldn't take work now");
                return;
            }
            Err(error) => {
                let why = error.message.clone();
                if let Err(why) = shared.store.failed(&delivery.id, &why) {
                    tracing::warn!(delivery = %delivery.id, %why, "recording a delivery failed");
                }
                tracing::warn!(host = %host.host_id, delivery = %delivery.id, %why, "a Host refused work");
            }
        }
    }
}

async fn send(
    connection: &HostConnection,
    delivery: &Delivery,
) -> Result<serde_json::Value, Error> {
    let answer = match &delivery.work {
        Work::Run(request) => serde_json::to_value(connection.send(request.clone()).await?),
        Work::Queue(request) => serde_json::to_value(connection.send(request.clone()).await?),
    };
    answer.map_err(|error| Error::internal_error().data(error.to_string()))
}

/// Whether sending `error`'s work again later may go otherwise: the Host is stopping, or the
/// connection failed rather than the Host answering.
fn again(error: &Error) -> bool {
    errors::is(error, errors::HOST_STOPPING) || error.code == Error::internal_error().code
}

/// The Host refused the Dispatcher: say why until it's paired again, which a restart keeps.
fn refused(shared: &Shared, host: &StoredHost, seen: &Mutex<Seen>, why: &str) {
    tracing::warn!(host = %host.host_id, %why, "a Host refused the Dispatcher; pair it again to reach it");
    if let Err(error) = shared.store.set_refused(&host.host_id, Some(why)) {
        tracing::warn!(host = %host.host_id, %error, "recording a refusal failed");
    }
    note(seen, PeerStatus::Refused, Some(why.to_owned()));
}

fn note(seen: &Mutex<Seen>, status: PeerStatus, why: Option<String>) {
    let mut seen = lock(seen);
    seen.status = status;
    seen.why = why;
}
