//! The Dispatcher's connection to one Host: kept up, with backoff, from the Dispatcher's side,
//! since Hosts never connect to it. While connected it watches the Host's threads and sends it
//! the work written down for it, oldest first, and when a thread a schedule's occurrence
//! started goes idle it reads how the occurrence's turn ended. It says, too, that the
//! Dispatcher reaches the person's Hosts, answers the calls the Host passes it for that
//! ([`crate::calls`]), and follows the turns other Hosts' calls began there
//! ([`crate::follows`]). A Host that refuses its key, as after revoking it, isn't tried again
//! until it's paired again.

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
use weave_host_client::HostHandle;
use weave_host_client::reach::reach;
use weave_host_client::remote::CloseReason;
use weave_host_protocol::dispatcher::Reachability;
use weave_host_protocol::errors;
use weave_host_protocol::queue::AddQueuedRequest;
use weave_host_protocol::sessions::Activity;
use weave_host_protocol::sessions::GetSessionRequest;
use weave_host_protocol::sessions::RunRequest;
use weave_host_protocol::sessions::SessionListing;
use weave_host_protocol::sessions::SessionStatus;
use weave_host_protocol::sessions::TurnState;
use weave_host_protocol::sessions::WatchSessionsRequest;
use weave_host_protocol::tools::DeclareToolsRequest;
use weave_host_protocol::websocket::CLOSE_REVOKED;

use crate::Shared;
use crate::calls;
use crate::client_info;
use crate::follows;
use crate::lock;
use crate::now_ms;
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
    pub(crate) status: Reachability,
    pub(crate) why: Option<String>,
    pub(crate) connected_at: Option<u64>,
    /// The connection, while there's one, for calls from other Hosts' agents.
    pub(crate) handle: Option<HostHandle>,
    pub(crate) threads: HashMap<SessionId, SessionListing>,
}

impl Default for Seen {
    fn default() -> Self {
        Self {
            connected: false,
            status: Reachability::Unchecked,
            why: None,
            connected_at: None,
            handle: None,
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

    pub(crate) fn listing(&self, session_id: &SessionId) -> Option<SessionListing> {
        lock(&self.seen).threads.get(session_id).cloned()
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
        note(&seen, Reachability::Refused, Some(why.clone()));
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
                            Reachability::Unreachable,
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
    shared: &Arc<Shared>,
    host: &StoredHost,
    wake: &Notify,
    stop: &CancellationToken,
    seen: &Mutex<Seen>,
    connection: HostConnection,
    mut events: mpsc::UnboundedReceiver<HostEvent>,
    closed: &CloseReason,
) -> Ended {
    let handle = connection.handle();
    // The Host passes the Dispatcher its agents' calls naming another Host from now on.
    let declared = connection
        .send(DeclareToolsRequest {
            tools: Vec::new(),
            hosts: true,
        })
        .await;
    if let Err(error) = declared {
        tracing::warn!(host = %host.host_id, %error, "a Host didn't take the Dispatcher as reaching the person's Hosts");
    }
    {
        let mut seen = lock(seen);
        seen.connected = true;
        seen.status = Reachability::Reachable;
        seen.why = None;
        seen.connected_at = Some(now_ms());
        seen.handle = Some(handle.clone());
    }
    match connection.send(WatchSessionsRequest::default()).await {
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
    send_pending(shared, host, &handle, seen).await;
    settle(shared, host, &connection, None).await;
    look(shared, host, &handle, seen, None).await;
    let ended = loop {
        tokio::select! {
            event = events.recv() => match event {
                Some(HostEvent::SessionUpdated(updated)) => {
                    let listing = updated.session;
                    let session_id = listing.info.session_id.clone();
                    let idle = !matches!(listing.activity, Some(Activity::Running | Activity::Waiting));
                    let waiting = listing.activity == Some(Activity::Waiting);
                    lock(seen).threads.insert(session_id.clone(), listing);
                    if idle {
                        settle(shared, host, &connection, Some(&session_id)).await;
                        follows::check(shared, host, &handle, Some(&session_id)).await;
                    } else if waiting {
                        follows::waiting(shared, host, &handle, &session_id).await;
                    }
                }
                Some(HostEvent::HostCall(call)) => {
                    tokio::spawn(calls::answer(Arc::clone(shared), host.clone(), handle.clone(), *call));
                }
                Some(HostEvent::SessionRemoved(removed)) => {
                    lock(seen).threads.remove(&removed.session_id);
                }
                Some(HostEvent::Disconnected(_)) | None => break None,
                Some(_) => {}
            },
            () = wake.notified() => {
                send_pending(shared, host, &handle, seen).await;
                settle(shared, host, &connection, None).await;
                look(shared, host, &handle, seen, None).await;
            }
            () = stop.cancelled() => break Some(Ended::Stopped),
        }
    };
    connection.shutdown().await;
    {
        let mut seen = lock(seen);
        seen.connected = false;
        seen.handle = None;
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
async fn send_pending(
    shared: &Shared,
    host: &StoredHost,
    connection: &HostHandle,
    seen: &Mutex<Seen>,
) {
    let pending = match shared.store.pending(&host.host_id) {
        Ok(pending) => pending,
        Err(why) => {
            tracing::warn!(host = %host.host_id, %why, "reading the work for a Host failed");
            return;
        }
    };
    for mut delivery in pending {
        if let Work::Prompt(request) = &delivery.work {
            let work = into_thread(request, seen);
            if let Err(why) = shared.store.settle(&delivery.id, &work) {
                tracing::warn!(delivery = %delivery.id, %why, "recording a delivery failed");
                return;
            }
            delivery.work = work;
        }
        match send(connection, &delivery.work).await {
            Ok(answer) => {
                if let Err(why) = shared.store.delivered(&delivery.id, &answer) {
                    tracing::warn!(delivery = %delivery.id, %why, "recording a delivery failed");
                }
                tracing::info!(host = %host.host_id, delivery = %delivery.id, "delivered");
                delivery.answer = Some(answer);
                calls::settled(shared, host, &delivery, None);
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
                calls::settled(shared, host, &delivery, Some(&why));
            }
        }
    }
}

/// Send `work` over `connection`: the Host's answer, as JSON.
pub(crate) async fn send(connection: &HostHandle, work: &Work) -> Result<serde_json::Value, Error> {
    let answer = match work {
        Work::Run(request) | Work::Prompt(request) => {
            serde_json::to_value(connection.send(request.clone()).await?)
        }
        Work::Queue(request) => serde_json::to_value(connection.send(request.clone()).await?),
        Work::Report(request) => serde_json::to_value(connection.send(request.clone()).await?),
    };
    answer.map_err(|error| Error::internal_error().data(error.to_string()))
}

/// How a prompt for a thread reaches it: added to its queue when it's open on the Host, as
/// the Dispatcher last saw it, so it waits for whatever runs there; otherwise run in it, which
/// opens it.
fn into_thread(request: &RunRequest, seen: &Mutex<Seen>) -> Work {
    let seen = lock(seen);
    // A thread that continues in another, as a Bot's does, is prompted there (WVE-168).
    let session_id = request.session_id.as_ref().map(|session_id| {
        let mut latest = session_id.clone();
        for _ in 0..MOST_SUCCESSORS {
            match seen
                .threads
                .get(&latest)
                .and_then(|listing| listing.continued_in.clone())
            {
                Some(next) => latest = next,
                None => break,
            }
        }
        latest
    });
    let open = session_id.as_ref().is_some_and(|session_id| {
        seen.threads
            .get(session_id)
            .is_some_and(|listing| listing.state == SessionStatus::Open)
    });
    match (session_id, open) {
        (Some(session_id), true) => Work::Queue(AddQueuedRequest {
            session_id,
            prompt: request.prompt.clone(),
            key: request.key.clone(),
            caller: None,
            origin: request.origin.clone(),
        }),
        (session_id, _) => Work::Run(RunRequest {
            session_id,
            ..request.clone()
        }),
    }
}

/// Look at the turns other Hosts' calls began here: report those over, and what those that
/// wait on a person ask.
async fn look(
    shared: &Shared,
    host: &StoredHost,
    handle: &HostHandle,
    seen: &Mutex<Seen>,
    only: Option<&SessionId>,
) {
    follows::check(shared, host, handle, only).await;
    let waiting: Vec<SessionId> = lock(seen)
        .threads
        .values()
        .filter(|listing| listing.activity == Some(Activity::Waiting))
        .map(|listing| listing.info.session_id.clone())
        .collect();
    for session_id in waiting {
        follows::waiting(shared, host, handle, &session_id).await;
    }
}

/// How many successors of a thread are followed, at most.
const MOST_SUCCESSORS: usize = 64;

/// Read how the turns occurrences started on the Host ended, in the thread `only` names or
/// in all of them, and write down those that are over.
async fn settle(
    shared: &Shared,
    host: &StoredHost,
    connection: &HostConnection,
    only: Option<&SessionId>,
) {
    let started = match shared.store.started(&host.host_id) {
        Ok(started) => started,
        Err(why) => {
            tracing::warn!(host = %host.host_id, %why, "reading the started occurrences failed");
            return;
        }
    };
    let signed_out = i32::from(Error::auth_required().code);
    for (occurrence, session_id, turn_id) in started {
        if only.is_some_and(|only| *only.0 != *session_id) {
            continue;
        }
        let session_id = SessionId::new(session_id);
        let mut turn_id = turn_id;
        // A turn its Host stopped under that the thread continued ends as its continuation
        // does (WVE-168).
        let got = loop {
            let got = connection
                .send(GetSessionRequest {
                    session_id: session_id.clone(),
                    turn_id: Some(turn_id.clone()),
                })
                .await;
            let next = match &got {
                Ok(got) => got
                    .latest_turn
                    .as_ref()
                    .filter(|turn| turn.state.is_over())
                    .and_then(|turn| turn.continued_in.clone()),
                Err(_) => None,
            };
            let Some(next) = next else { break got };
            if let Err(why) = shared.store.continued(&occurrence, &next) {
                tracing::warn!(%occurrence, %why, "recording an occurrence's continuation failed");
                break got;
            }
            tracing::info!(%occurrence, interrupted = %turn_id, continuation = %next, "an occurrence's turn was interrupted and continued");
            turn_id = next;
        };
        let ended = match got {
            Ok(got) => match got.latest_turn {
                Some(turn) if turn.state.is_over() => Some((
                    turn.state,
                    turn.error.as_ref().map(|error| error.message.clone()),
                    turn.error
                        .as_ref()
                        .is_some_and(|error| i32::from(error.code) == signed_out),
                )),
                Some(_) => None,
                None => Some((
                    TurnState::Failed,
                    Some("its Host has no record of its turn".to_owned()),
                    false,
                )),
            },
            Err(error)
                if errors::is(&error, errors::UNKNOWN_SESSION)
                    || errors::is(&error, errors::UNKNOWN_TURN) =>
            {
                Some((TurnState::Failed, Some(error.message), false))
            }
            Err(error) => {
                tracing::debug!(%occurrence, %error, "reading an occurrence's turn failed");
                None
            }
        };
        if let Some((outcome, why, signed_out)) = ended
            && let Err(why) = shared.store.finish(&occurrence, outcome, why, signed_out)
        {
            tracing::warn!(%occurrence, %why, "recording how an occurrence ended failed");
        }
    }
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
    note(seen, Reachability::Refused, Some(why.to_owned()));
}

fn note(seen: &Mutex<Seen>, status: Reachability, why: Option<String>) {
    let mut seen = lock(seen);
    seen.status = status;
    seen.why = why;
}
