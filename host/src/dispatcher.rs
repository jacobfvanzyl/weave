//! The Dispatcher this Host joined (ADR 0030, WVE-194), and the connection the Host keeps open
//! to it. `dispatcher/join` takes the code `hosts/offer` gave there. The Host connects, proves a
//! key of its own (`key.json`, in the Secure Enclave where it can be) and learns the
//! Dispatcher's, which it keeps among its devices as the service it joined
//! ([`crate::devices`]); `dispatcher.json` keeps where the Dispatcher is. From then on the Host
//! connects again whenever the connection drops, with backoff, proving its key each time, and
//! serves the Host protocol over the connection as it does a remote client's, the Dispatcher
//! saying hello with its own key. A Host the Dispatcher removed is told so, by the connection
//! closing with [`CLOSE_REVOKED`] or by its key being refused, and forgets the Dispatcher.
//!
//! The Dispatcher carries the person's devices' connections to the Host (WVE-195): over the
//! Host's connection it asks `dispatcher/carry` with a token and the device, and the Host opens
//! another connection to it where it joined it, presents the token, and serves that connection
//! for the device as a remote client ([`carry`]). Leaving the Dispatcher, or its removing the
//! Host, closes them.

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use agent_client_protocol::Error;
use futures::future::BoxFuture;
use serde::Deserialize;
use serde::Serialize;
use tokio::io::AsyncRead;
use tokio::io::AsyncWrite;
use tokio_util::sync::CancellationToken;
use weave_host_client::remote::DeviceKey;
use weave_host_client::remote::Opened;
use weave_host_client::remote::open_dispatcher;
use weave_host_protocol::Timestamp;
use weave_host_protocol::devices::DeviceInfo;
use weave_host_protocol::dispatcher::CarriedStream;
use weave_host_protocol::dispatcher::CarryRequest;
use weave_host_protocol::dispatcher::ConnectHostRequest;
use weave_host_protocol::dispatcher::DISPATCHER_HOST_SUBPROTOCOL;
use weave_host_protocol::dispatcher::DISPATCHER_PROTOCOL;
use weave_host_protocol::dispatcher::DispatcherAddress;
use weave_host_protocol::dispatcher::DispatcherChallengeRequest;
use weave_host_protocol::dispatcher::HostCarryRequest;
use weave_host_protocol::dispatcher::HostConnected;
use weave_host_protocol::dispatcher::HostJoin;
use weave_host_protocol::dispatcher::JoinDispatcherRequest;
use weave_host_protocol::dispatcher::JoinedDispatcher;
use weave_host_protocol::dispatcher::host_connect_message;
use weave_host_protocol::errors;
use weave_host_protocol::websocket::CLOSE_REVOKED;
use weave_remote::preamble;
use weave_remote::websocket;
use weave_remote::websocket::RemoteConfig;
use weave_remote::websocket::WebSocketStream;

use crate::Shared;
use crate::devices::write_private;
use crate::journal::now_ms;
use crate::paths::DaemonPaths;
use crate::thread::lock;

/// The WebSocket's own close code for a connection that ends as it should.
const CLOSE_NORMAL: u16 = 1000;

/// How a Host keeps the Dispatcher it joins.
#[derive(Clone, Debug)]
pub struct DispatcherSettings {
    /// `dispatcher.json`.
    pub record: PathBuf,
    /// The Host's own key.
    pub key: PathBuf,
    /// Keep the key in the Secure Enclave where there is one; tests keep it in the file.
    pub secure_enclave: bool,
    /// How long connecting and proving its key may take.
    pub timeout: Duration,
    /// How long it waits to connect again after the first failure; each failure after that
    /// doubles it, up to `retry_most`.
    pub retry: Duration,
    pub retry_most: Duration,
    /// The connection's pings and backlog, as for remote clients.
    pub websocket: RemoteConfig,
}

impl DispatcherSettings {
    /// In the Host's directory, with the key in the Secure Enclave where there is one.
    pub fn in_dir(paths: &DaemonPaths) -> Self {
        Self {
            record: paths.dispatcher(),
            key: paths.key(),
            secure_enclave: true,
            timeout: Duration::from_secs(10),
            retry: Duration::from_secs(1),
            retry_most: Duration::from_secs(60),
            websocket: RemoteConfig::default(),
        }
    }
}

/// `dispatcher.json`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    id: String,
    name: String,
    address: DispatcherAddress,
    /// What the Dispatcher calls this Host.
    host_name: String,
    joined_at: Timestamp,
}

/// The Dispatcher the Host joined, if it joined one, and how its connection stands.
pub(crate) struct Joined {
    settings: Option<DispatcherSettings>,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    record: Option<Record>,
    /// The connection, while there's one.
    link: Option<Arc<websocket::Link>>,
    connected_at: Option<Timestamp>,
    why: Option<String>,
    /// Stops the task that keeps the connection.
    stop: Option<CancellationToken>,
    /// Closes the connections the Host opened for the Dispatcher to carry devices'.
    carried: CancellationToken,
}

impl State {
    /// Close the connections carried for the Dispatcher, as when the Host leaves it.
    fn end_carried(&mut self) {
        std::mem::take(&mut self.carried).cancel();
    }
}

impl Joined {
    /// The Dispatcher `settings.record` says the Host joined; none for a Host that joins none.
    pub(crate) fn load(settings: Option<DispatcherSettings>) -> Self {
        let record = settings
            .as_ref()
            .and_then(|settings| read(&settings.record));
        Self {
            settings,
            state: Mutex::new(State {
                record,
                ..State::default()
            }),
        }
    }

    /// The Dispatcher the Host joined, and how its connection stands.
    pub(crate) fn status(&self) -> Option<JoinedDispatcher> {
        let state = lock(&self.state);
        let record = state.record.as_ref()?;
        Some(JoinedDispatcher {
            id: record.id.clone(),
            name: record.name.clone(),
            address: record.address.clone(),
            host_name: record.host_name.clone(),
            joined_at: record.joined_at,
            connected: state.link.is_some(),
            connected_at: state.connected_at,
            why: state.why.clone(),
        })
    }

    /// Whether the Host joined a Dispatcher, which keeps it running when it's otherwise idle.
    pub(crate) fn is_joined(&self) -> bool {
        lock(&self.state).record.is_some()
    }

    fn note(&self, why: impl Into<String>) {
        lock(&self.state).why = Some(why.into());
    }
}

/// At startup, keep a connection to the Dispatcher the Host joined, if it joined one.
pub(crate) fn resume(shared: &Arc<Shared>) {
    let record = lock(&shared.dispatcher.state).record.clone();
    if let Some(record) = record {
        start(shared, record, None);
    }
}

/// `dispatcher/join`: join the Dispatcher at `request.address` with its code, and keep a
/// connection to it from then on, in place of any Dispatcher joined before.
pub(crate) async fn join(
    shared: &Arc<Shared>,
    request: JoinDispatcherRequest,
) -> Result<JoinedDispatcher, Error> {
    let settings = shared.dispatcher.settings.clone().ok_or_else(|| {
        invalid("this Host runs inside a client, so it joins no Dispatcher".to_owned())
    })?;
    let key = DeviceKey::kept(&settings.key, settings.secure_enclave).map_err(internal)?;
    let name = request
        .name
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(computer_name);
    let mut opened = open(&request.address, settings.timeout)
        .await
        .map_err(unavailable)?;
    let join = HostJoin {
        code: request.code,
        public_key: key.jwk(),
    };
    let proving = prove(&mut opened, shared, &key, &name, Some(join), None);
    let connected = tokio::time::timeout(settings.timeout, proving)
        .await
        .map_err(|_| {
            unavailable(format!(
                "the Dispatcher at {} didn't answer within {} seconds",
                request.address,
                settings.timeout.as_secs_f32()
            ))
        })??;
    let record = Record {
        id: connected.dispatcher_id,
        name: connected.dispatcher_name,
        address: request.address,
        host_name: connected.name,
        joined_at: now_ms(),
    };
    {
        // Another Dispatcher than the one before is told that the Host left it, and what it
        // carried closes.
        let mut state = lock(&shared.dispatcher.state);
        let other = state
            .record
            .as_ref()
            .is_some_and(|before| before.id != record.id);
        if other {
            if let Some(link) = &state.link {
                link.close(CLOSE_REVOKED);
            }
            state.end_carried();
        }
    }
    shared.devices.join(
        &record.id,
        &record.name,
        connected.public_key,
        CLOSE_REVOKED,
    );
    write_private(&settings.record, &record)
        .map_err(|error| internal(format!("writing {}: {error}", settings.record.display())))?;
    {
        let mut state = lock(&shared.dispatcher.state);
        state.record = Some(record.clone());
        state.why = None;
    }
    tracing::info!(dispatcher = %record.id, name = %record.name, "joined the Dispatcher");
    start(shared, record, Some(opened));
    shared
        .dispatcher
        .status()
        .ok_or_else(|| internal("the Dispatcher it joined went missing".to_owned()))
}

/// `dispatcher/leave`: forget the Dispatcher the Host joined, telling it if it's connected.
pub(crate) fn leave(shared: &Shared) -> Result<(), Error> {
    let (link, stop) = {
        let mut state = lock(&shared.dispatcher.state);
        if state.record.take().is_none() {
            return Err(invalid("this Host hasn't joined a Dispatcher".to_owned()));
        }
        state.why = None;
        state.end_carried();
        (state.link.take(), state.stop.take())
    };
    if let Some(link) = link {
        link.close(CLOSE_REVOKED);
    }
    if let Some(stop) = stop {
        stop.cancel();
    }
    forget_files(shared);
    tracing::info!("left the Dispatcher");
    Ok(())
}

/// The Host is stopping: close the connection to the Dispatcher, which it connects again on
/// the next start.
pub(crate) fn stop(shared: &Shared) {
    let stop = {
        let mut state = lock(&shared.dispatcher.state);
        state.end_carried();
        state.stop.take()
    };
    if let Some(stop) = stop {
        stop.cancel();
    }
}

/// Keep a connection to the Dispatcher `record` names, starting with `first` if there's one,
/// in place of the task there was.
fn start(shared: &Arc<Shared>, record: Record, first: Option<Opened>) {
    let stop = CancellationToken::new();
    if let Some(old) = lock(&shared.dispatcher.state).stop.replace(stop.clone()) {
        old.cancel();
    }
    tokio::spawn(keep(Arc::clone(shared), record, first, stop));
}

/// Why connecting failed.
enum Failed {
    /// The Dispatcher refused the Host's key: it removed the Host.
    Refused(String),
    /// Nothing answered, or the connection broke: try again later.
    Again(String),
}

/// Serve the Dispatcher over `first`, then connect again whenever the connection drops, with
/// backoff, until stopped or removed.
async fn keep(
    shared: Arc<Shared>,
    record: Record,
    mut first: Option<Opened>,
    stop: CancellationToken,
) {
    let Some(settings) = shared.dispatcher.settings.clone() else {
        return;
    };
    let mut delay = settings.retry;
    loop {
        let opened = match first.take() {
            Some(opened) => Ok(opened),
            None => tokio::select! {
                connected = reconnect(&shared, &settings, &record) => connected,
                () = stop.cancelled() => return,
            },
        };
        match opened {
            Ok(opened) => {
                delay = settings.retry;
                let closed = serve(&shared, opened, &settings.websocket, &stop).await;
                if stop.is_cancelled() {
                    return;
                }
                if closed == Some(CLOSE_REVOKED) {
                    forget(&shared, "the Dispatcher removed this Host");
                    return;
                }
                tracing::info!("lost the connection to the Dispatcher; connecting again");
                shared
                    .dispatcher
                    .note("its connection closed; connecting again");
            }
            Err(Failed::Refused(why)) => {
                forget(&shared, &why);
                return;
            }
            Err(Failed::Again(why)) => {
                tracing::debug!(%why, "couldn't reach the Dispatcher");
                shared.dispatcher.note(why);
            }
        }
        tokio::select! {
            () = tokio::time::sleep(delay) => {}
            () = stop.cancelled() => return,
        }
        delay = delay.saturating_mul(2).min(settings.retry_most);
    }
}

/// Connect to the Dispatcher `record` names again and prove the Host's key.
async fn reconnect(
    shared: &Shared,
    settings: &DispatcherSettings,
    record: &Record,
) -> Result<Opened, Failed> {
    let key = DeviceKey::kept(&settings.key, settings.secure_enclave).map_err(Failed::Again)?;
    let mut opened = open(&record.address, settings.timeout)
        .await
        .map_err(Failed::Again)?;
    let proving = prove(
        &mut opened,
        shared,
        &key,
        &record.host_name,
        None,
        Some(&record.id),
    );
    match tokio::time::timeout(settings.timeout, proving).await {
        Ok(Ok(_)) => Ok(opened),
        Ok(Err(error)) if errors::is(&error, errors::UNAUTHENTICATED) => Err(Failed::Refused(
            format!("the Dispatcher refused this Host: {}", error.message),
        )),
        Ok(Err(error)) => Err(Failed::Again(error.message)),
        Err(_) => Err(Failed::Again(format!(
            "the Dispatcher at {} didn't answer within {} seconds",
            record.address,
            settings.timeout.as_secs_f32()
        ))),
    }
}

/// Open the Dispatcher's WebSocket at `address`, within `timeout`.
async fn open(address: &DispatcherAddress, timeout: Duration) -> Result<Opened, String> {
    match tokio::time::timeout(
        timeout,
        open_dispatcher(address, DISPATCHER_HOST_SUBPROTOCOL),
    )
    .await
    {
        Ok(Ok(opened)) => Ok(opened),
        Ok(Err(error)) => Err(format!("nothing answered at {address}: {error}")),
        Err(_) => Err(format!(
            "nothing answered at {address} within {} seconds",
            timeout.as_secs_f32()
        )),
    }
}

/// Ask for the Dispatcher's challenge and prove the Host's key, joining with `join` if given.
/// `expected` is the Dispatcher the Host joined before, which has to be the one that answers.
async fn prove(
    opened: &mut Opened,
    shared: &Shared,
    key: &DeviceKey,
    name: &str,
    join: Option<HostJoin>,
    expected: Option<&str>,
) -> Result<HostConnected, Error> {
    match opened {
        Opened::Tcp(socket) => prove_on(&mut **socket, shared, key, name, join, expected).await,
        Opened::Unix(socket) => prove_on(&mut **socket, shared, key, name, join, expected).await,
    }
}

async fn prove_on<S: AsyncRead + AsyncWrite + Unpin>(
    socket: &mut WebSocketStream<S>,
    shared: &Shared,
    key: &DeviceKey,
    name: &str,
    join: Option<HostJoin>,
    expected: Option<&str>,
) -> Result<HostConnected, Error> {
    let challenge = preamble::ask(socket, 1, &DispatcherChallengeRequest {}).await?;
    if let Some(expected) = expected
        && challenge.dispatcher_id != expected
    {
        return Err(unavailable(
            "another Dispatcher answers there now: `weave hosts add` joins the one that should be"
                .to_owned(),
        ));
    }
    let host_id = shared.devices.host_id();
    let signature = key
        .sign(&host_connect_message(
            &challenge.dispatcher_id,
            &host_id,
            &challenge.nonce,
        ))
        .map_err(internal)?;
    let request = ConnectHostRequest {
        protocol: DISPATCHER_PROTOCOL,
        host_id,
        name: name.to_owned(),
        version: env!("CARGO_PKG_VERSION").to_owned(),
        signature,
        join,
    };
    let connected = preamble::ask(socket, 2, &request).await?;
    if connected.dispatcher_id != challenge.dispatcher_id {
        return Err(unavailable(
            "the Dispatcher answered as another Dispatcher than its challenge named".to_owned(),
        ));
    }
    Ok(connected)
}

/// Serve the Host protocol over `opened`, the Dispatcher being the client, until it closes or
/// the task is stopped. The close code the Dispatcher sent, if it sent one.
async fn serve(
    shared: &Arc<Shared>,
    opened: Opened,
    config: &RemoteConfig,
    stop: &CancellationToken,
) -> Option<u16> {
    match opened {
        Opened::Tcp(socket) => serve_on(shared, *socket, config, stop).await,
        Opened::Unix(socket) => serve_on(shared, *socket, config, stop).await,
    }
}

async fn serve_on<S>(
    shared: &Arc<Shared>,
    socket: WebSocketStream<S>,
    config: &RemoteConfig,
    stop: &CancellationToken,
) -> Option<u16>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let served: Arc<Mutex<Option<Arc<websocket::Link>>>> = Arc::default();
    let seen = Arc::clone(&served);
    websocket::serve_rpc(socket, config, |transport, link| {
        {
            let mut state = lock(&shared.dispatcher.state);
            state.link = Some(Arc::clone(&link));
            state.connected_at = Some(now_ms());
            state.why = None;
        }
        *lock(&seen) = Some(Arc::clone(&link));
        let shared = Arc::clone(shared);
        let stop = stop.clone();
        async move {
            // Stopped, it closes the connection rather than dropping the client, so the client
            // ends as any does, detaching from what it watched.
            let serving = crate::client::serve_joined(shared, transport, Arc::clone(&link));
            tokio::pin!(serving);
            tokio::select! {
                served = &mut serving => served,
                () = stop.cancelled() => {
                    link.close(CLOSE_NORMAL);
                    serving.await
                }
            }
        }
    })
    .await;
    let link = lock(&served).take();
    {
        let mut state = lock(&shared.dispatcher.state);
        let same =
            matches!((&state.link, &link), (Some(now), Some(ours)) if Arc::ptr_eq(now, ours));
        if same {
            state.link = None;
        }
    }
    link.and_then(|link| link.peer_closed())
}

/// `dispatcher/carry`: connect to the Dispatcher the Host joined again, for the device it names,
/// present `request.token`, and once the Dispatcher has taken it, serve that connection for the
/// device: the Host protocol, whose hello takes the Dispatcher's word for the device, or a
/// terminal's stream with a ticket of that device's.
pub(crate) async fn carry(shared: &Arc<Shared>, request: CarryRequest) -> Result<(), Error> {
    let settings = shared.dispatcher.settings.clone().ok_or_else(|| {
        invalid("this Host runs inside a client, so it joins no Dispatcher".to_owned())
    })?;
    let (record, carried) = {
        let state = lock(&shared.dispatcher.state);
        (state.record.clone(), state.carried.clone())
    };
    let record =
        record.ok_or_else(|| invalid("this Host hasn't joined a Dispatcher".to_owned()))?;
    let mut opened = open(&record.address, settings.timeout)
        .await
        .map_err(unavailable)?;
    let presenting = present(&mut opened, &record.id, request.token);
    tokio::time::timeout(settings.timeout, presenting)
        .await
        .map_err(|_| {
            unavailable(format!(
                "the Dispatcher at {} didn't take the connection within {} seconds",
                record.address,
                settings.timeout.as_secs_f32()
            ))
        })??;
    let device = DeviceInfo {
        service: false,
        ..request.device
    };
    tracing::info!(device = %device.id, name = %device.name, stream = ?request.stream, "the Dispatcher carries a device's connection");
    let shared = Arc::clone(shared);
    let config = settings.websocket;
    let stream = request.stream;
    tokio::spawn(async move {
        match opened {
            Opened::Tcp(socket) => {
                serve_carried(shared, *socket, config, device, stream, carried).await;
            }
            Opened::Unix(socket) => {
                serve_carried(shared, *socket, config, device, stream, carried).await;
            }
        }
    });
    Ok(())
}

/// Ask for the Dispatcher's challenge, check it's `expected`, the one the Host joined, and
/// present `token`.
async fn present(opened: &mut Opened, expected: &str, token: String) -> Result<(), Error> {
    match opened {
        Opened::Tcp(socket) => present_on(&mut **socket, expected, token).await,
        Opened::Unix(socket) => present_on(&mut **socket, expected, token).await,
    }
}

async fn present_on<S: AsyncRead + AsyncWrite + Unpin>(
    socket: &mut WebSocketStream<S>,
    expected: &str,
    token: String,
) -> Result<(), Error> {
    let challenge = preamble::ask(socket, 1, &DispatcherChallengeRequest {}).await?;
    if challenge.dispatcher_id != expected {
        return Err(unavailable(
            "another Dispatcher answers there now: `weave hosts add` joins the one that should be"
                .to_owned(),
        ));
    }
    preamble::ask(socket, 2, &HostCarryRequest { token }).await?;
    Ok(())
}

/// Serve `socket`, a connection the Dispatcher carries for `device`, as `stream` says, until
/// either end closes it or `stop` is cancelled, as when the Host leaves the Dispatcher.
///
/// Its future is boxed and declared `Send`: the client it serves can ask for another carried
/// connection, and the compiler can't infer `Send` around that cycle.
fn serve_carried<S>(
    shared: Arc<Shared>,
    socket: WebSocketStream<S>,
    config: RemoteConfig,
    device: DeviceInfo,
    stream: CarriedStream,
    stop: CancellationToken,
) -> BoxFuture<'static, ()>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    Box::pin(serve_carried_now(
        shared, socket, config, device, stream, stop,
    ))
}

async fn serve_carried_now<S>(
    shared: Arc<Shared>,
    socket: WebSocketStream<S>,
    config: RemoteConfig,
    device: DeviceInfo,
    stream: CarriedStream,
    stop: CancellationToken,
) where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    match stream {
        CarriedStream::Host => {
            websocket::serve_rpc(socket, &config, |transport, link| async move {
                let serving =
                    crate::client::serve_carried(shared, transport, Arc::clone(&link), device);
                tokio::pin!(serving);
                tokio::select! {
                    served = &mut serving => served,
                    () = stop.cancelled() => {
                        link.close(CLOSE_NORMAL);
                        serving.await
                    }
                }
            })
            .await;
        }
        CarriedStream::Terminal => {
            let serving =
                crate::terminals::stream::serve(shared, socket, Arc::new(config), Some(device.id));
            tokio::select! {
                () = serving => {}
                () = stop.cancelled() => {}
            }
        }
    }
}

/// The Dispatcher removed the Host, saying `why`: forget it.
fn forget(shared: &Shared, why: &str) {
    tracing::warn!(%why, "the Dispatcher removed this Host; `weave hosts add` joins it again");
    {
        let mut state = lock(&shared.dispatcher.state);
        state.record = None;
        state.link = None;
        state.stop = None;
        state.end_carried();
    }
    forget_files(shared);
}

/// Remove the Dispatcher from the Host's devices and its record.
fn forget_files(shared: &Shared) {
    shared.devices.leave();
    if let Some(settings) = &shared.dispatcher.settings
        && let Err(error) = std::fs::remove_file(&settings.record)
        && error.kind() != std::io::ErrorKind::NotFound
    {
        tracing::warn!(%error, path = %settings.record.display(), "couldn't remove the Dispatcher's record");
    }
}

fn read(path: &Path) -> Option<Record> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(error) => {
            tracing::warn!(%error, path = %path.display(), "reading the Dispatcher's record failed");
            return None;
        }
    };
    serde_json::from_slice(&bytes)
        .inspect_err(|error| {
            tracing::warn!(%error, path = %path.display(), "the Dispatcher's record doesn't parse");
        })
        .ok()
}

/// This computer's name, without macOS's `.local`: what the Dispatcher calls the Host when it
/// isn't told.
fn computer_name() -> String {
    #[cfg(unix)]
    {
        let mut buffer = [0u8; 256];
        // SAFETY: the buffer is ours and its length is given.
        let read = unsafe { libc::gethostname(buffer.as_mut_ptr().cast(), buffer.len()) };
        if read == 0 {
            let end = buffer.iter().position(|byte| *byte == 0).unwrap_or(0);
            let name = String::from_utf8_lossy(&buffer[..end]);
            let name = name.strip_suffix(".local").unwrap_or(&name);
            if !name.is_empty() {
                return name.to_owned();
            }
        }
    }
    "this computer".to_owned()
}

fn invalid(why: String) -> Error {
    let mut error = Error::invalid_params();
    error.message = why;
    error
}

fn internal(why: String) -> Error {
    let mut error = Error::internal_error();
    error.message = why;
    error
}

fn unavailable(why: String) -> Error {
    Error::new(errors::REMOTE_UNAVAILABLE, why)
}
