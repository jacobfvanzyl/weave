//! What the `weave` CLI asks the Dispatcher: its status, the Hosts that joined it and codes
//! to join with, its schedules and their occurrences, the person's Projects and Bots, and its
//! devices. Each connection says
//! hello first, with the API's version. On the Unix socket the CLI is the Dispatcher's own
//! user; on the WebSocket (WVE-176), which `weave-remote` serves while a device is paired or a
//! Host joined over it, every connection proves a paired device at hello, by signing its
//! `dispatcher/challenge`, or pairs with a code. A device may ask everything but `devices/*`,
//! which stay on the Dispatcher's own computer. A Host's own connection asks for a subprotocol
//! of its own, and [`crate::joins`] takes it; so does a device's connection to one of the
//! person's Hosts, which [`crate::carry`] takes, as it does one on the socket whose hello is
//! followed by `hosts/open`.

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;

use agent_client_protocol::ByteStreams;
use agent_client_protocol::ConnectTo;
use agent_client_protocol::ConnectionTo;
use agent_client_protocol::Error;
use agent_client_protocol::Responder;
use agent_client_protocol::Role as _;
use serde::de::DeserializeOwned;
use serde_json::Value;
use serde_json::json;
use tokio::io::AsyncBufReadExt as _;
use tokio::io::AsyncReadExt as _;
use tokio::io::AsyncWriteExt as _;
use tokio::io::BufReader;
use tokio::net::TcpListener;
use tokio::net::TcpStream;
use tokio::net::UnixListener;
use tokio::net::UnixStream;
use tokio_util::compat::TokioAsyncReadCompatExt as _;
use tokio_util::compat::TokioAsyncWriteCompatExt as _;
use tokio_util::sync::CancellationToken;
use weave_host_protocol::Dispatcher;
use weave_host_protocol::DispatcherClient;
use weave_host_protocol::Empty;
use weave_host_protocol::devices::DeviceInfo;
use weave_host_protocol::devices::ListDevicesRequest;
use weave_host_protocol::devices::ListDevicesResponse;
use weave_host_protocol::devices::OfferDeviceRequest;
use weave_host_protocol::devices::OfferDeviceResponse;
use weave_host_protocol::devices::RevokeDeviceRequest;
use weave_host_protocol::dispatcher::AddBotRequest;
use weave_host_protocol::dispatcher::AddProjectRequest;
use weave_host_protocol::dispatcher::AddScheduleRequest;
use weave_host_protocol::dispatcher::BOTS_FEATURE;
use weave_host_protocol::dispatcher::BotResponse;
use weave_host_protocol::dispatcher::DISPATCHER_CARRY_SUBPROTOCOL;
use weave_host_protocol::dispatcher::DISPATCHER_HOST_SUBPROTOCOL;
use weave_host_protocol::dispatcher::DISPATCHER_PROTOCOL;
use weave_host_protocol::dispatcher::DISPATCHER_SUBPROTOCOL;
use weave_host_protocol::dispatcher::DispatcherAddress;
use weave_host_protocol::dispatcher::DispatcherChallenge;
use weave_host_protocol::dispatcher::DispatcherChallengeRequest;
use weave_host_protocol::dispatcher::DispatcherHello;
use weave_host_protocol::dispatcher::DispatcherHelloRequest;
use weave_host_protocol::dispatcher::DispatcherStatusRequest;
use weave_host_protocol::dispatcher::GetBotRequest;
use weave_host_protocol::dispatcher::GetProjectRequest;
use weave_host_protocol::dispatcher::ListBotsRequest;
use weave_host_protocol::dispatcher::ListBotsResponse;
use weave_host_protocol::dispatcher::ListHostsRequest;
use weave_host_protocol::dispatcher::ListHostsResponse;
use weave_host_protocol::dispatcher::ListOccurrencesRequest;
use weave_host_protocol::dispatcher::ListOccurrencesResponse;
use weave_host_protocol::dispatcher::ListProjectsRequest;
use weave_host_protocol::dispatcher::ListProjectsResponse;
use weave_host_protocol::dispatcher::ListSchedulesRequest;
use weave_host_protocol::dispatcher::ListSchedulesResponse;
use weave_host_protocol::dispatcher::NewBotThreadRequest;
use weave_host_protocol::dispatcher::OccurrenceResponse;
use weave_host_protocol::dispatcher::OfferHostRequest;
use weave_host_protocol::dispatcher::OfferHostResponse;
use weave_host_protocol::dispatcher::OpenHostRequest;
use weave_host_protocol::dispatcher::PROJECTS_FEATURE;
use weave_host_protocol::dispatcher::PauseScheduleRequest;
use weave_host_protocol::dispatcher::ProjectResponse;
use weave_host_protocol::dispatcher::RemoveBotRequest;
use weave_host_protocol::dispatcher::RemoveHostRequest;
use weave_host_protocol::dispatcher::RemoveProjectRequest;
use weave_host_protocol::dispatcher::RemoveScheduleRequest;
use weave_host_protocol::dispatcher::ResumeScheduleRequest;
use weave_host_protocol::dispatcher::RunScheduleRequest;
use weave_host_protocol::dispatcher::ScheduleResponse;
use weave_host_protocol::dispatcher::SendToBotRequest;
use weave_host_protocol::dispatcher::UpdateBotRequest;
use weave_host_protocol::dispatcher::UpdateProjectRequest;
use weave_host_protocol::errors;
use weave_host_protocol::hello::Auth;
use weave_host_protocol::websocket::CLOSE_REVOKED;
use weave_host_protocol::websocket::CLOSE_UNAUTHENTICATED;
use weave_remote::access::Accept;
use weave_remote::pairing::Closer;
use weave_remote::websocket::Link;
use weave_remote::websocket::RemoteConfig;

use crate::Shared;
use crate::lock;
use crate::socket;

/// Accept the CLI's connections on `listener` until the Dispatcher stops. Only the socket
/// owner's are served.
pub(crate) async fn serve(shared: Arc<Shared>, listener: UnixListener) {
    let owner = socket::owner(&listener);
    loop {
        let accepted = tokio::select! {
            accepted = listener.accept() => accepted,
            () = shared.stop.cancelled() => return,
        };
        match accepted {
            Ok((stream, _)) => match socket::from_owner(&stream, owner) {
                Some(true) => {
                    let shared = Arc::clone(&shared);
                    tokio::spawn(async move {
                        if let Err(error) = local(shared, stream).await {
                            tracing::debug!(%error, "a CLI connection ended");
                        }
                    });
                }
                Some(false) => tracing::warn!("refused a connection from another user"),
                None => tracing::debug!("refused a connection whose user can't be told"),
            },
            Err(error) => tracing::warn!(%error, "accepting a connection failed"),
        }
    }
}

/// A connection on the socket: the API, or, after a hello, one carried to a Host (`hosts/open`,
/// WVE-195), one line per message either way. The Dispatcher answers the hello itself, to see
/// what follows it, and hands anything else to the API with the hello said.
async fn local(shared: Arc<Shared>, stream: UnixStream) -> Result<(), Error> {
    let (read, mut write) = stream.into_split();
    let mut reader = BufReader::new(read);
    let mut line = String::new();
    if reader.read_line(&mut line).await.unwrap_or(0) == 0 {
        return Ok(());
    }
    let mut greeted = false;
    if let Some((id, hello)) = request_of::<DispatcherHelloRequest>(&line, "dispatcher/hello") {
        let said = local_hello(&shared, hello);
        greeted = said.is_ok();
        let answer = match said {
            Ok(said) => json!({"jsonrpc": "2.0", "id": id, "result": said}),
            Err(error) => json!({"jsonrpc": "2.0", "id": id, "error": error}),
        };
        if write
            .write_all(format!("{answer}\n").as_bytes())
            .await
            .is_err()
        {
            return Ok(());
        }
        line.clear();
        if reader.read_line(&mut line).await.unwrap_or(0) == 0 {
            return Ok(());
        }
        if greeted && let Some(id) = id_of(&line, "hosts/open") {
            let request = request_of::<OpenHostRequest>(&line, "hosts/open")
                .map(|(_, request)| request)
                .ok_or_else(|| crate::invalid("hosts/open takes the Host, by id or name"));
            crate::carry::local(shared, id, request, reader, write).await;
            return Ok(());
        }
    }
    let replayed = std::io::Cursor::new(line.into_bytes()).chain(reader);
    let transport = ByteStreams::new(write.compat_write(), replayed.compat());
    answer(shared, transport, Peer::Local, greeted).await
}

/// The id of `line`, if it's a `method` request.
fn id_of(line: &str, method: &str) -> Option<Value> {
    let message: Value = serde_json::from_str(line).ok()?;
    (message.get("method")?.as_str()? == method).then(|| message.get("id").cloned())?
}

/// `line`'s id and params, if it's a `method` request whose params are a `T`.
fn request_of<T: DeserializeOwned>(line: &str, method: &str) -> Option<(Value, T)> {
    let id = id_of(line, method)?;
    let mut message: Value = serde_json::from_str(line).ok()?;
    let params = message
        .get_mut("params")
        .map(Value::take)
        .unwrap_or_else(|| json!({}));
    Some((id, serde_json::from_value(params).ok()?))
}

/// `dispatcher/hello` on the socket, whose peer is the Dispatcher's own user.
fn local_hello(shared: &Shared, request: DispatcherHelloRequest) -> Result<DispatcherHello, Error> {
    if request.protocol != DISPATCHER_PROTOCOL {
        return Err(incompatible(&request));
    }
    local_auth(request.auth.unwrap_or(Auth::Local))?;
    Ok(DispatcherHello {
        protocol: DISPATCHER_PROTOCOL,
        version: env!("CARGO_PKG_VERSION").to_owned(),
        id: shared.id.clone(),
        device: None,
        features: features(),
    })
}

/// The optional parts of the API this Dispatcher answers, which its hello names.
pub(crate) fn features() -> Vec<String> {
    vec![PROJECTS_FEATURE.to_owned(), BOTS_FEATURE.to_owned()]
}

/// What a hello on the socket may say: nothing, which is the Dispatcher's own user.
fn local_auth(auth: Auth) -> Result<(), Error> {
    match auth {
        Auth::Local => Ok(()),
        Auth::Token { .. } => Err(errors::unauthenticated("tokens aren't accepted")),
        Auth::Device { .. } | Auth::Pair { .. } => Err(errors::unauthenticated(
            "devices connect over the Dispatcher's WebSocket",
        )),
        Auth::Dispatcher => Err(errors::unauthenticated(
            "the Dispatcher's word for a device is for Hosts",
        )),
    }
}

/// A hello of another version of the Dispatcher's API than this one's.
pub(crate) fn incompatible(request: &DispatcherHelloRequest) -> Error {
    Error::new(
        errors::INCOMPATIBLE_PROTOCOL,
        format!(
            "this Dispatcher speaks version {DISPATCHER_PROTOCOL} of its API, and {} version {}",
            request.client.name, request.protocol
        ),
    )
}

/// At startup, turn the WebSocket back on when a device is paired or a Host joined over it
/// (ADR 0016).
pub(crate) async fn resume_remote(shared: &Arc<Shared>) {
    let paired = shared.store.any_device().unwrap_or(false)
        || shared.store.any_remote_host().unwrap_or(false);
    shared.remote.resume(&accept(shared), paired).await;
}

/// A code a Host joins with, and where it connects: for a Host elsewhere the WebSocket, which
/// this turns on and back off once the code expires if no Host joined with it; for one `here`,
/// the socket.
pub(crate) async fn offer_host(
    shared: &Arc<Shared>,
    here: bool,
) -> Result<OfferHostResponse, Error> {
    let address = match here {
        true => DispatcherAddress::Socket(shared.config.paths.hosts_socket()),
        false => {
            let url = shared
                .remote
                .start(&accept(shared), || remote_in_use(shared))
                .await?;
            DispatcherAddress::Url(url)
        }
    };
    let lifetime = shared.remote.offer_lifetime();
    let lifetime_ms = u64::try_from(lifetime.as_millis()).unwrap_or(u64::MAX);
    let (code, expires_at) = shared.joins.offer(lifetime_ms);
    if !here {
        let later = Arc::clone(shared);
        tokio::spawn(async move {
            tokio::time::sleep(lifetime + std::time::Duration::from_millis(100)).await;
            stop_if_unused(&later).await;
        });
    }
    Ok(OfferHostResponse {
        code,
        expires_at,
        address,
    })
}

/// Whether a device is paired or a Host joined over the WebSocket, either of which keeps it on.
fn remote_in_use(shared: &Shared) -> bool {
    shared.store.any_device().unwrap_or(true) || shared.store.any_remote_host().unwrap_or(true)
}

/// What remote access does with its listener: answer the person's devices on it.
fn accept(shared: &Arc<Shared>) -> Accept {
    let shared = Arc::clone(shared);
    Arc::new(move |listener, stop| {
        tokio::spawn(serve_websocket(Arc::clone(&shared), listener, stop));
    })
}

async fn serve_websocket(shared: Arc<Shared>, listener: TcpListener, stop: CancellationToken) {
    let config = Arc::new(
        shared
            .remote
            .settings()
            .map(|settings| settings.websocket.clone())
            .unwrap_or_default(),
    );
    loop {
        let accepted = tokio::select! {
            accepted = listener.accept() => accepted,
            () = stop.cancelled() => return,
            () = shared.stop.cancelled() => return,
        };
        match accepted {
            Ok((stream, _)) => {
                // Nagle's algorithm off, as where host-client dials: small messages, such as a
                // terminal's echo, go out at once.
                let _ = stream.set_nodelay(true);
                let shared = Arc::clone(&shared);
                let config = Arc::clone(&config);
                tokio::spawn(async move { websocket(shared, stream, config).await });
            }
            Err(error) => tracing::warn!(%error, "accepting a WebSocket client failed"),
        }
    }
}

async fn websocket(shared: Arc<Shared>, stream: TcpStream, config: Arc<RemoteConfig>) {
    let protocols = [
        DISPATCHER_SUBPROTOCOL,
        DISPATCHER_HOST_SUBPROTOCOL,
        DISPATCHER_CARRY_SUBPROTOCOL,
    ];
    let Some((protocol, socket)) =
        weave_remote::websocket::upgrade(stream, &config.origins, &protocols).await
    else {
        return;
    };
    if protocol == DISPATCHER_HOST_SUBPROTOCOL {
        crate::joins::connection(shared, socket, config, false).await;
        return;
    }
    if protocol == DISPATCHER_CARRY_SUBPROTOCOL {
        crate::carry::device(shared, socket, config).await;
        return;
    }
    weave_remote::websocket::serve_rpc(socket, &config, |transport, link| {
        answer(shared, transport, Peer::Remote(link), false)
    })
    .await;
}

/// Turn remote access off when no device is paired, no Host joined over it and no offer is
/// good.
pub(crate) async fn stop_if_unused(shared: &Arc<Shared>) {
    shared
        .remote
        .stop_if_unused(|| {
            remote_in_use(shared) || shared.devices.offering() || shared.joins.offering()
        })
        .await;
}

/// Where a connection comes from.
enum Peer {
    /// The Unix socket, whose peer is the Dispatcher's own user.
    Local,
    /// The WebSocket: a remote client, which proves a paired device at hello.
    Remote(Arc<Link>),
}

/// One connection to the API.
struct Connection {
    id: u64,
    shared: Arc<Shared>,
    peer: Peer,
    greeted: AtomicBool,
    /// The paired device a remote client proved at hello.
    device: Mutex<Option<DeviceInfo>>,
}

impl Connection {
    fn greeted_first(&self) -> Result<(), Error> {
        if self.greeted.load(Ordering::Relaxed) {
            Ok(())
        } else {
            Err(Error::new(
                errors::UNAUTHENTICATED,
                "say dispatcher/hello first",
            ))
        }
    }

    /// For what only a client on the Dispatcher's own computer may ask: `devices/*`.
    fn local_first(&self) -> Result<(), Error> {
        self.greeted_first()?;
        match self.peer {
            Peer::Local => Ok(()),
            Peer::Remote(_) => Err(Error::new(
                errors::FORBIDDEN,
                "only a client on the Dispatcher's computer may do this",
            )),
        }
    }

    fn hello(&self, request: DispatcherHelloRequest) -> Result<DispatcherHello, Error> {
        if request.protocol != DISPATCHER_PROTOCOL {
            return Err(incompatible(&request));
        }
        let device = self.identify(request.auth.unwrap_or(Auth::Local))?;
        if let (Some(device), Peer::Remote(link)) = (&device, &self.peer) {
            let mut current = lock(&self.device);
            if let Some(previous) = current.take() {
                self.shared.devices.disconnected(&previous.id, self.id);
            }
            link.proved();
            let closer: Arc<dyn Closer> = Arc::clone(link) as Arc<dyn Closer>;
            self.shared.devices.connected(&device.id, self.id, closer);
            *current = Some(device.clone());
        }
        self.greeted.store(true, Ordering::Relaxed);
        Ok(DispatcherHello {
            protocol: DISPATCHER_PROTOCOL,
            version: env!("CARGO_PKG_VERSION").to_owned(),
            id: self.shared.id.clone(),
            device,
            features: features(),
        })
    }

    /// Who the connection is: nobody in particular on the socket, and the device it proves on
    /// the WebSocket. A remote client that proves none is closed after the error.
    fn identify(&self, auth: Auth) -> Result<Option<DeviceInfo>, Error> {
        let Peer::Remote(link) = &self.peer else {
            return local_auth(auth).map(|()| None);
        };
        let shared = &self.shared;
        let device = match auth {
            Auth::Device {
                device_id,
                signature,
            } => match link.take_challenge() {
                Some(nonce) => shared.devices.verify(
                    &shared.store,
                    &shared.id,
                    &device_id,
                    &nonce,
                    &signature,
                )?,
                None => None,
            },
            Auth::Pair { code, device } => shared.devices.pair(&shared.store, &code, device)?,
            Auth::Local | Auth::Token { .. } | Auth::Dispatcher => None,
        };
        if device.is_none() {
            tracing::info!("refused a remote client's hello");
            link.close_after_next(CLOSE_UNAUTHENTICATED);
            return Err(errors::unauthenticated(
                "this device couldn't be authenticated",
            ));
        }
        Ok(device)
    }

    /// `dispatcher/challenge`, for a remote client to sign at hello.
    fn challenge(&self) -> Result<DispatcherChallenge, Error> {
        let Peer::Remote(link) = &self.peer else {
            return Err(errors::unauthenticated(
                "challenges are for the Dispatcher's WebSocket",
            ));
        };
        let (nonce, expires_at) = link.challenge();
        Ok(DispatcherChallenge {
            dispatcher_id: self.shared.id.clone(),
            nonce,
            expires_at,
        })
    }

    /// `devices/offer`: a code `weave pair` shows, and this connection is told who takes it.
    /// It turns remote access on, and back off once the offer expires if no device took one.
    async fn offer_device(
        &self,
        request: OfferDeviceRequest,
        cx: ConnectionTo<DispatcherClient>,
    ) -> Result<OfferDeviceResponse, Error> {
        self.local_first()?;
        let shared = &self.shared;
        let url = shared
            .remote
            .start(&accept(shared), || remote_in_use(shared))
            .await?;
        let lifetime = shared.remote.offer_lifetime();
        let lifetime_ms = u64::try_from(lifetime.as_millis()).unwrap_or(u64::MAX);
        let (code, expires_at) = shared.devices.offer(request.name, cx, lifetime_ms);
        let later = Arc::clone(shared);
        tokio::spawn(async move {
            tokio::time::sleep(lifetime + std::time::Duration::from_millis(100)).await;
            stop_if_unused(&later).await;
        });
        Ok(OfferDeviceResponse {
            code,
            expires_at,
            url: Some(url),
        })
    }

    /// `hosts/offer`: a code a Host joins with. For a Host elsewhere it turns remote access on,
    /// and back off once the code expires if no Host joined with it; for one here (`here`),
    /// which only a client on the Dispatcher's computer may ask for, it gives the socket.
    async fn offer_host(&self, request: OfferHostRequest) -> Result<OfferHostResponse, Error> {
        match request.here {
            true => self.local_first()?,
            false => self.greeted_first()?,
        }
        offer_host(&self.shared, request.here).await
    }

    /// `devices/revoke`: forget a device and close its connections. The last one gone turns
    /// remote access off.
    async fn revoke_device(&self, request: RevokeDeviceRequest) -> Result<Empty, Error> {
        self.local_first()?;
        let shared = &self.shared;
        shared
            .devices
            .revoke(&shared.store, &request.device_id, CLOSE_REVOKED)?;
        stop_if_unused(shared).await;
        Ok(Empty {})
    }
}

/// Answer a request of type `$request` with `$answer`, an expression of `$shared` and
/// `$request` that may wait, off the dispatch loop, once the connection has said hello.
macro_rules! handle {
    ($builder:ident, $connection:ident, $shared:ident, $request:ident: $type:ty => $answer:expr) => {
        let $builder = {
            let connection = Arc::clone(&$connection);
            $builder.on_receive_request(
                async move |$request: $type,
                            responder: Responder<_>,
                            cx: ConnectionTo<DispatcherClient>| {
                    let connection = Arc::clone(&connection);
                    cx.spawn(async move {
                        let $shared = Arc::clone(&connection.shared);
                        let answer = match connection.greeted_first() {
                            Ok(()) => $answer,
                            Err(error) => Err(error),
                        };
                        responder.respond_with_result(answer)
                    })
                },
                agent_client_protocol::on_receive_request!(),
            )
        };
    };
}

/// Answer the API on `transport` until it closes; `greeted`, its hello was answered already.
async fn answer(
    shared: Arc<Shared>,
    transport: impl ConnectTo<Dispatcher> + 'static,
    peer: Peer,
    greeted: bool,
) -> Result<(), Error> {
    let connection = Arc::new(Connection {
        id: shared
            .next_connection
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed),
        shared: Arc::clone(&shared),
        peer,
        greeted: AtomicBool::new(greeted),
        device: Mutex::new(None),
    });
    let result = handlers(&connection, transport).await;
    if let Some(device) = lock(&connection.device).take() {
        shared.devices.disconnected(&device.id, connection.id);
    }
    result
}

async fn handlers(
    connection: &Arc<Connection>,
    transport: impl ConnectTo<Dispatcher> + 'static,
) -> Result<(), Error> {
    let stop = connection.shared.stop.clone();
    let on_hello = Arc::clone(connection);
    let on_challenge = Arc::clone(connection);
    let on_offer = Arc::clone(connection);
    let on_list = Arc::clone(connection);
    let on_revoke = Arc::clone(connection);
    let on_offer_host = Arc::clone(connection);
    let builder = Dispatcher
        .builder()
        .name("weave-dispatcher")
        .on_receive_request(
            async move |request: DispatcherHelloRequest, responder: Responder<_>, _cx| {
                responder.respond_with_result(on_hello.hello(request))
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |_request: DispatcherChallengeRequest, responder: Responder<_>, _cx| {
                responder.respond_with_result(on_challenge.challenge())
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: OfferDeviceRequest,
                        responder: Responder<_>,
                        cx: ConnectionTo<DispatcherClient>| {
                let connection = Arc::clone(&on_offer);
                let to = cx.clone();
                cx.spawn(async move {
                    responder.respond_with_result(connection.offer_device(request, to).await)
                })
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |_request: ListDevicesRequest, responder: Responder<_>, _cx| {
                let listed = on_list.local_first().and_then(|()| {
                    let shared = &on_list.shared;
                    shared
                        .devices
                        .list(&shared.store)
                        .map(|devices| ListDevicesResponse { devices })
                });
                responder.respond_with_result(listed)
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: OfferHostRequest,
                        responder: Responder<_>,
                        cx: ConnectionTo<DispatcherClient>| {
                let connection = Arc::clone(&on_offer_host);
                cx.spawn(async move {
                    responder.respond_with_result(connection.offer_host(request).await)
                })
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: RevokeDeviceRequest,
                        responder: Responder<_>,
                        cx: ConnectionTo<DispatcherClient>| {
                let connection = Arc::clone(&on_revoke);
                cx.spawn(async move {
                    responder.respond_with_result(connection.revoke_device(request).await)
                })
            },
            agent_client_protocol::on_receive_request!(),
        );
    handle!(builder, connection, shared, _request: DispatcherStatusRequest => shared.status());
    handle!(builder, connection, shared, _request: ListHostsRequest =>
        shared.hosts().map(|hosts| ListHostsResponse { hosts }));
    handle!(builder, connection, shared, request: RemoveHostRequest =>
        shared.remove_host(&request.host).await.map(|()| Empty {}));
    handle!(builder, connection, shared, _request: ListSchedulesRequest =>
        shared.schedules().map(|schedules| ListSchedulesResponse { schedules }));
    handle!(builder, connection, shared, request: AddScheduleRequest =>
        shared.add_schedule(request).map(|schedule| ScheduleResponse { schedule }));
    handle!(builder, connection, shared, request: RemoveScheduleRequest =>
        shared.remove_schedule(&request.schedule).map(|()| Empty {}));
    handle!(builder, connection, shared, request: PauseScheduleRequest =>
        shared.pause_schedule(&request.schedule).map(|schedule| ScheduleResponse { schedule }));
    handle!(builder, connection, shared, request: ResumeScheduleRequest =>
        shared.resume_schedule(&request.schedule).map(|schedule| ScheduleResponse { schedule }));
    handle!(builder, connection, shared, request: RunScheduleRequest =>
        shared.run_schedule(&request.schedule).map(|occurrence| OccurrenceResponse { occurrence }));
    handle!(builder, connection, shared, request: ListOccurrencesRequest =>
        shared
            .occurrences(request.schedule.as_deref(), request.limit)
            .map(|occurrences| ListOccurrencesResponse { occurrences }));
    handle!(builder, connection, shared, _request: ListProjectsRequest =>
        shared.projects().map(|projects| ListProjectsResponse { projects }));
    handle!(builder, connection, shared, request: GetProjectRequest =>
        shared.project(&request.project).map(|project| ProjectResponse { project }));
    handle!(builder, connection, shared, request: AddProjectRequest =>
        shared.add_project(request).map(|project| ProjectResponse { project }));
    handle!(builder, connection, shared, request: UpdateProjectRequest =>
        shared.update_project(request).map(|project| ProjectResponse { project }));
    handle!(builder, connection, shared, request: RemoveProjectRequest =>
        shared.remove_project(&request.project).map(|()| Empty {}));
    handle!(builder, connection, shared, _request: ListBotsRequest =>
        shared.bots().map(|bots| ListBotsResponse { bots }));
    handle!(builder, connection, shared, request: GetBotRequest =>
        shared.bot(&request.bot).map(|bot| BotResponse { bot }));
    handle!(builder, connection, shared, request: AddBotRequest =>
        shared.add_bot(request).map(|bot| BotResponse { bot }));
    handle!(builder, connection, shared, request: UpdateBotRequest =>
        shared.update_bot(request).map(|bot| BotResponse { bot }));
    handle!(builder, connection, shared, request: RemoveBotRequest =>
        shared.remove_bot(&request.bot).map(|()| Empty {}));
    handle!(builder, connection, shared, request: SendToBotRequest =>
        shared.send_to_bot(request));
    handle!(builder, connection, shared, request: NewBotThreadRequest =>
        shared.new_bot_thread(&request.bot).map(|bot| BotResponse { bot }));
    builder
        .connect_with(
            transport,
            async move |cx: ConnectionTo<DispatcherClient>| {
                tokio::select! {
                    () = cx.incoming_closed() => {}
                    () = stop.cancelled() => {}
                }
                Ok(())
            },
        )
        .await
}
