//! The Dispatcher's connection to one Host: the one the Host opened when it joined, or since
//! (ADR 0030), which the Dispatcher takes up once the Host has proved itself ([`crate::joins`]).
//! Over it the Dispatcher is a client of the Host: while connected it watches the Host's
//! threads and sends it the work written down for it, oldest first, and when a thread a
//! schedule's occurrence started goes idle it reads how the occurrence's turn ended. It says,
//! too, that the Dispatcher reaches the person's Hosts, answers the calls the Host passes it
//! for that ([`crate::calls`]), and follows the turns other Hosts' calls began there
//! ([`crate::follows`]). It settles the prompts for the Bots on the Host as it sends them, and
//! carries their new threads on as the watch says their threads go idle or wait
//! ([`crate::bots`]); it declares the Dispatcher's own tools there, a Bot's wake-ups, and
//! answers their calls ([`crate::wakeups`]). A Host that leaves isn't taken up again until it
//! joins again.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use agent_client_protocol::Error;
use tokio::sync::Notify;
use tokio::sync::mpsc;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use weave_host_client::Credentials;
use weave_host_client::HostConnection;
use weave_host_client::HostEvent;
use weave_host_client::HostHandle;
use weave_host_protocol::dispatcher::Reachability;
use weave_host_protocol::errors;
use weave_host_protocol::hello::ClientCapabilities;
use weave_host_protocol::queue::AddQueuedRequest;
use weave_host_protocol::threads::Activity;
use weave_host_protocol::threads::GetThreadRequest;
use weave_host_protocol::threads::RunRequest;
use weave_host_protocol::threads::ThreadId;
use weave_host_protocol::threads::ThreadListing;
use weave_host_protocol::threads::ThreadStatus;
use weave_host_protocol::threads::TurnState;
use weave_host_protocol::threads::WatchThreadsRequest;
use weave_host_protocol::tools::DeclareToolsRequest;
use weave_host_protocol::websocket::CLOSE_REVOKED;
use weave_host_protocol::websocket::CLOSE_UNAUTHENTICATED;
use weave_remote::websocket;

use crate::Shared;
use crate::bots;
use crate::calls;
use crate::client_info;
use crate::follows;
use crate::lock;
use crate::now_ms;
use crate::store::StoredHost;
use crate::store::Work;
use crate::wakeups;

pub(crate) struct Link {
    /// Rung when work is written down for the Host.
    wake: Arc<Notify>,
    stop: CancellationToken,
    seen: Arc<Mutex<Seen>>,
    /// The Host's connection, to close it with a code of the Dispatcher's choosing.
    closer: Arc<websocket::Link>,
    /// Told once the connection has closed.
    gone: Mutex<Option<oneshot::Receiver<()>>>,
    task: JoinHandle<()>,
}

/// How long stopping waits for a Host's connection to close, beyond the WebSocket's own grace.
const GONE_WAIT: Duration = Duration::from_secs(6);

/// A Host's own connection, once it has proved itself: what the Dispatcher says the Host
/// protocol over.
pub(crate) struct Arrival {
    pub(crate) transport: websocket::Transport,
    pub(crate) link: Arc<websocket::Link>,
    /// Told once the connection has closed, after the link is done with it.
    pub(crate) gone: oneshot::Receiver<()>,
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
    pub(crate) threads: HashMap<ThreadId, ThreadListing>,
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
    /// The Dispatcher stopped, let the Host go, or took up a newer connection from it.
    Stopped,
    /// The Host left the Dispatcher.
    Revoked,
    /// It closed, or nothing came from it.
    Lost,
}

impl Link {
    /// Take up `arrival`, the connection `host` opened, until it closes or the link stops;
    /// `done` is told once it has, and the connection may close.
    pub(crate) fn start(
        shared: Arc<Shared>,
        host: StoredHost,
        arrival: Arrival,
        done: oneshot::Sender<()>,
    ) -> Self {
        let wake = Arc::new(Notify::new());
        let stop = shared.stop.child_token();
        let seen = Arc::new(Mutex::new(Seen::default()));
        let closer = Arc::clone(&arrival.link);
        let Arrival {
            transport,
            link,
            gone,
        } = arrival;
        let task = tokio::spawn(take(
            shared,
            host,
            transport,
            link,
            Arc::clone(&wake),
            stop.clone(),
            Arc::clone(&seen),
            done,
        ));
        Self {
            wake,
            stop,
            seen,
            closer,
            gone: Mutex::new(Some(gone)),
            task,
        }
    }

    pub(crate) fn wake(&self) {
        self.wake.notify_one();
    }

    pub(crate) fn stop(&self) {
        self.stop.cancel();
    }

    /// Close the Host's connection telling it it was removed, so it forgets the Dispatcher,
    /// and stop.
    pub(crate) fn revoke(&self) {
        self.closer.close(CLOSE_REVOKED);
        self.stop.cancel();
    }

    /// Wait for the link to end, once it's been stopped, and for its connection to close.
    pub(crate) async fn stopped(self) {
        self.stop.cancel();
        let _ = self.task.await;
        let gone = lock(&self.gone).take();
        if let Some(gone) = gone {
            let _ = tokio::time::timeout(GONE_WAIT, gone).await;
        }
    }

    pub(crate) fn seen(&self) -> Seen {
        lock(&self.seen).clone()
    }

    /// Whether the Host is connected now.
    pub(crate) fn connected(&self) -> bool {
        lock(&self.seen).connected
    }

    pub(crate) fn listing(&self, thread_id: &ThreadId) -> Option<ThreadListing> {
        lock(&self.seen).threads.get(thread_id).cloned()
    }

    pub(crate) fn threads(&self) -> Vec<ThreadListing> {
        let mut threads: Vec<ThreadListing> = lock(&self.seen).threads.values().cloned().collect();
        threads.sort_by(|a, b| a.info.session_id.0.cmp(&b.info.session_id.0));
        threads
    }
}

/// Say hello to `host` over the connection it opened, and follow it until it ends.
#[allow(clippy::too_many_arguments)]
async fn take(
    shared: Arc<Shared>,
    host: StoredHost,
    transport: websocket::Transport,
    closer: Arc<websocket::Link>,
    wake: Arc<Notify>,
    stop: CancellationToken,
    seen: Arc<Mutex<Seen>>,
    done: oneshot::Sender<()>,
) {
    let credentials = Credentials::Device {
        device_id: shared.id.clone(),
        key: shared.key.clone(),
        host_id: Some(host.host_id.clone()),
    };
    let hello = tokio::time::timeout(
        shared.config.reach_timeout,
        HostConnection::connect_with(
            transport,
            client_info(),
            ClientCapabilities::default(),
            credentials,
        ),
    );
    let said = tokio::select! {
        said = hello => said,
        () = stop.cancelled() => {
            let _ = done.send(());
            return;
        }
    };
    match said {
        Ok(Ok((connection, events))) => {
            tracing::info!(host = %host.host_id, "a Host connected");
            match follow(
                &shared, &host, &wake, &stop, &seen, connection, events, &closer,
            )
            .await
            {
                Ended::Stopped => {}
                Ended::Revoked => refused(&shared, &host, &seen, "it left the Dispatcher"),
                Ended::Lost => {
                    tracing::info!(host = %host.host_id, "lost a Host's connection");
                    note(
                        &seen,
                        Reachability::Unreachable,
                        Some("its connection closed; it connects again when it can".to_owned()),
                    );
                }
            }
        }
        Ok(Err(error)) => {
            tracing::warn!(host = %host.host_id, %error, "a Host refused the Dispatcher's hello");
            note(
                &seen,
                Reachability::Refused,
                Some(format!("it refused the Dispatcher's hello: {error}")),
            );
            closer.close(CLOSE_UNAUTHENTICATED);
        }
        Err(_) => note(
            &seen,
            Reachability::Unreachable,
            Some(format!(
                "it didn't answer the Dispatcher's hello within {} seconds",
                shared.config.reach_timeout.as_secs_f32()
            )),
        ),
    }
    let _ = done.send(());
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
    closer: &websocket::Link,
) -> Ended {
    let handle = connection.handle();
    // The Host offers its threads the Dispatcher's own tools, a Bot's wake-ups, and passes the
    // Dispatcher its agents' calls naming another Host, from now on.
    let declared = connection
        .send(DeclareToolsRequest {
            tools: wakeups::tools(),
            hosts: true,
        })
        .await;
    if let Err(error) = declared {
        tracing::warn!(host = %host.host_id, %error, "a Host didn't take the Dispatcher's tools, nor it as reaching the person's Hosts");
    }
    {
        let mut seen = lock(seen);
        seen.connected = true;
        seen.status = Reachability::Reachable;
        seen.why = None;
        seen.connected_at = Some(now_ms());
        seen.handle = Some(handle.clone());
    }
    match connection.send(WatchThreadsRequest::default()).await {
        Ok(watched) => {
            lock(seen).threads = watched
                .threads
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
    if bots::advance(shared, host, &handle, seen, None).await {
        wake.notify_one();
    }
    let ended = loop {
        tokio::select! {
            event = events.recv() => match event {
                Some(HostEvent::ThreadUpdated(updated)) => {
                    let listing = updated.thread;
                    let thread_id = listing.info.session_id.clone();
                    let idle = !matches!(listing.activity, Some(Activity::Running | Activity::Waiting));
                    let waiting = listing.activity == Some(Activity::Waiting);
                    lock(seen).threads.insert(thread_id.clone(), listing);
                    if idle {
                        settle(shared, host, &connection, Some(&thread_id)).await;
                        follows::check(shared, host, &handle, Some(&thread_id)).await;
                    } else if waiting {
                        follows::waiting(shared, host, &handle, &thread_id).await;
                    }
                    if bots::advance(shared, host, &handle, seen, Some(&thread_id)).await {
                        wake.notify_one();
                    }
                }
                Some(HostEvent::HostCall(call)) => {
                    tokio::spawn(calls::answer(Arc::clone(shared), host.clone(), handle.clone(), *call));
                }
                Some(HostEvent::ToolCall(call)) => {
                    tokio::spawn(wakeups::answer(Arc::clone(shared), host.clone(), handle.clone(), *call));
                }
                Some(HostEvent::ThreadRemoved(removed)) => {
                    lock(seen).threads.remove(&removed.thread_id);
                }
                Some(HostEvent::Disconnected(_)) | None => break None,
                Some(_) => {}
            },
            () = wake.notified() => {
                send_pending(shared, host, &handle, seen).await;
                settle(shared, host, &connection, None).await;
                look(shared, host, &handle, seen, None).await;
                if bots::advance(shared, host, &handle, seen, None).await {
                    wake.notify_one();
                }
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
        None if closer.peer_closed() == Some(CLOSE_REVOKED) => Ended::Revoked,
        None => Ended::Lost,
    }
}

/// Send the Host the work written down for it, oldest first, until it's all taken or the
/// connection fails. Work the Host refuses is failed, saying why; work it couldn't take now,
/// as while it stops, is sent again on the next connection. A Bot's prompt that has to wait
/// stays written down, and what comes after it goes on.
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
        let settled = match &delivery.work {
            Work::Prompt(request) => Some(into_thread(request, seen)),
            Work::Bot(prompt) => match bots::settle(shared, &delivery, prompt, seen) {
                Some(work) => Some(work),
                None => continue,
            },
            _ => None,
        };
        if let Some(work) = settled {
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
                if delivery.bot_id.is_some() {
                    bots::delivered(connection, seen, &delivery, &answer).await;
                }
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
        // Settled into one of those before it's first sent.
        Work::Bot(_) => {
            return Err(Error::internal_error().data("a Bot's prompt not yet settled"));
        }
    };
    answer.map_err(|error| Error::internal_error().data(error.to_string()))
}

/// How a prompt for a thread reaches it: added to its queue when it's open on the Host, as
/// the Dispatcher last saw it, so it waits for whatever runs there; otherwise run in it, which
/// opens it.
pub(crate) fn into_thread(request: &RunRequest, seen: &Mutex<Seen>) -> Work {
    let seen = lock(seen);
    // A thread that continues in another, as a Bot's does, is prompted there (WVE-168).
    let thread_id = request.thread_id.as_ref().map(|thread_id| {
        let mut latest = thread_id.clone();
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
    let open = thread_id.as_ref().is_some_and(|thread_id| {
        seen.threads
            .get(thread_id)
            .is_some_and(|listing| listing.state == ThreadStatus::Open)
    });
    match (thread_id, open) {
        (Some(thread_id), true) => Work::Queue(AddQueuedRequest {
            thread_id,
            prompt: request.prompt.clone(),
            key: request.key.clone(),
            caller: None,
            origin: request.origin.clone(),
        }),
        (thread_id, _) => Work::Run(RunRequest {
            thread_id,
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
    only: Option<&ThreadId>,
) {
    follows::check(shared, host, handle, only).await;
    let waiting: Vec<ThreadId> = lock(seen)
        .threads
        .values()
        .filter(|listing| listing.activity == Some(Activity::Waiting))
        .map(|listing| listing.info.session_id.clone())
        .collect();
    for thread_id in waiting {
        follows::waiting(shared, host, handle, &thread_id).await;
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
    only: Option<&ThreadId>,
) {
    let started = match shared.store.started(&host.host_id) {
        Ok(started) => started,
        Err(why) => {
            tracing::warn!(host = %host.host_id, %why, "reading the started occurrences failed");
            return;
        }
    };
    let signed_out = i32::from(Error::auth_required().code);
    for (occurrence, thread_id, turn_id) in started {
        if only.is_some_and(|only| *only.0 != *thread_id) {
            continue;
        }
        let thread_id = ThreadId::new(thread_id);
        let mut turn_id = turn_id;
        // A turn its Host stopped under that the thread continued ends as its continuation
        // does (WVE-168).
        let got = loop {
            let got = connection
                .send(GetThreadRequest {
                    thread_id: thread_id.clone(),
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
                if errors::is(&error, errors::UNKNOWN_THREAD)
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
pub(crate) fn again(error: &Error) -> bool {
    errors::is(error, errors::HOST_STOPPING) || error.code == Error::internal_error().code
}

/// The Host refused the Dispatcher: say why until it's paired again, which a restart keeps.
fn refused(shared: &Shared, host: &StoredHost, seen: &Mutex<Seen>, why: &str) {
    tracing::warn!(host = %host.host_id, %why, "a Host left the Dispatcher; it has to join again");
    shared.carries.close_host(&host.host_id);
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
