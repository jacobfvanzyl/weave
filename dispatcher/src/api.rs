//! What the `weave` CLI asks the Dispatcher: its status, the Hosts it is paired with, its
//! schedules and their occurrences, and its devices. Each connection says hello first, with
//! the API's version. On the Unix socket the CLI is the Dispatcher's own user; on the WebSocket
//! (WVE-176), which `weave-remote` serves while a device is paired, every connection proves a
//! paired device at hello, by signing its `dispatcher/challenge`, or pairs with a code. A device
//! may ask everything but `devices/*`, which stay on the Dispatcher's own computer.

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;

use agent_client_protocol::ConnectTo;
use agent_client_protocol::ConnectionTo;
use agent_client_protocol::Error;
use agent_client_protocol::Responder;
use agent_client_protocol::Role as _;
use tokio::net::TcpListener;
use tokio::net::TcpStream;
use tokio::net::UnixListener;
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
use weave_host_protocol::dispatcher::AddHostRequest;
use weave_host_protocol::dispatcher::AddHostResponse;
use weave_host_protocol::dispatcher::AddScheduleRequest;
use weave_host_protocol::dispatcher::DISPATCHER_PROTOCOL;
use weave_host_protocol::dispatcher::DISPATCHER_SUBPROTOCOL;
use weave_host_protocol::dispatcher::DispatcherChallenge;
use weave_host_protocol::dispatcher::DispatcherChallengeRequest;
use weave_host_protocol::dispatcher::DispatcherHello;
use weave_host_protocol::dispatcher::DispatcherHelloRequest;
use weave_host_protocol::dispatcher::DispatcherStatusRequest;
use weave_host_protocol::dispatcher::ListHostsRequest;
use weave_host_protocol::dispatcher::ListHostsResponse;
use weave_host_protocol::dispatcher::ListOccurrencesRequest;
use weave_host_protocol::dispatcher::ListOccurrencesResponse;
use weave_host_protocol::dispatcher::ListSchedulesRequest;
use weave_host_protocol::dispatcher::ListSchedulesResponse;
use weave_host_protocol::dispatcher::OccurrenceResponse;
use weave_host_protocol::dispatcher::PauseScheduleRequest;
use weave_host_protocol::dispatcher::RemoveHostRequest;
use weave_host_protocol::dispatcher::RemoveScheduleRequest;
use weave_host_protocol::dispatcher::ResumeScheduleRequest;
use weave_host_protocol::dispatcher::RunScheduleRequest;
use weave_host_protocol::dispatcher::ScheduleResponse;
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
                        if let Err(error) =
                            answer(shared, socket::transport(stream), Peer::Local).await
                        {
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

/// At startup, turn the WebSocket back on when a device is paired (ADR 0016).
pub(crate) async fn resume_remote(shared: &Arc<Shared>) {
    let paired = shared.store.any_device().unwrap_or(false);
    shared.remote.resume(&accept(shared), paired).await;
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
                let shared = Arc::clone(&shared);
                let config = Arc::clone(&config);
                tokio::spawn(async move { websocket(shared, stream, config).await });
            }
            Err(error) => tracing::warn!(%error, "accepting a WebSocket client failed"),
        }
    }
}

async fn websocket(shared: Arc<Shared>, stream: TcpStream, config: Arc<RemoteConfig>) {
    let protocols = [DISPATCHER_SUBPROTOCOL];
    let Some((_, socket)) =
        weave_remote::websocket::upgrade(stream, &config.origins, &protocols).await
    else {
        return;
    };
    weave_remote::websocket::serve_rpc(socket, &config, |transport, link| {
        answer(shared, transport, Peer::Remote(link))
    })
    .await;
}

/// Turn remote access off when no device is paired and no offer is good.
async fn stop_if_unused(shared: &Arc<Shared>) {
    shared
        .remote
        .stop_if_unused(|| shared.store.any_device().unwrap_or(true) || shared.devices.offering())
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
            return Err(Error::new(
                errors::INCOMPATIBLE_PROTOCOL,
                format!(
                    "this Dispatcher speaks version {DISPATCHER_PROTOCOL} of its API, and {} \
                     version {}",
                    request.client.name, request.protocol
                ),
            ));
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
        })
    }

    /// Who the connection is: nobody in particular on the socket, and the device it proves on
    /// the WebSocket. A remote client that proves none is closed after the error.
    fn identify(&self, auth: Auth) -> Result<Option<DeviceInfo>, Error> {
        let Peer::Remote(link) = &self.peer else {
            return match auth {
                Auth::Local => Ok(None),
                Auth::Token { .. } => Err(errors::unauthenticated("tokens aren't accepted")),
                Auth::Device { .. } | Auth::Pair { .. } => Err(errors::unauthenticated(
                    "devices connect over the Dispatcher's WebSocket",
                )),
            };
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
            Auth::Local | Auth::Token { .. } => None,
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

    /// `devices/offer`: a code `weave dispatcher pair` shows, and this connection is told who
    /// takes it. It turns remote access on, and back off once the offer expires if no device
    /// took one.
    async fn offer_device(
        &self,
        request: OfferDeviceRequest,
        cx: ConnectionTo<DispatcherClient>,
    ) -> Result<OfferDeviceResponse, Error> {
        self.local_first()?;
        let shared = &self.shared;
        let url = shared
            .remote
            .start(&accept(shared), || {
                shared.store.any_device().unwrap_or(true)
            })
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

async fn answer(
    shared: Arc<Shared>,
    transport: impl ConnectTo<Dispatcher> + 'static,
    peer: Peer,
) -> Result<(), Error> {
    let connection = Arc::new(Connection {
        id: shared
            .next_connection
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed),
        shared: Arc::clone(&shared),
        peer,
        greeted: AtomicBool::new(false),
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
    handle!(builder, connection, shared, request: AddHostRequest =>
        shared.add_host(request).await.map(|host| AddHostResponse { host }));
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
