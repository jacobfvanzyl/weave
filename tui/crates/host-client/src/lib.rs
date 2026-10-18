//! A client of the weave Host: connecting and saying hello, typed requests, and everything the
//! Host sends, in the order it sent it.
//!
//! Notifications arrive as [`HostEvent`]s on one channel. Opening a session with
//! [`HostHandle::open`] answers on that channel too, ahead of the events that follow the
//! answer on the wire, so a client knows whether to reset its transcript before the replay
//! arrives.
//!
//! Local clients use the Unix socket; remote ones, the Host's WebSocket and a paired device
//! ([`remote`]).

pub mod remote;

use agent_client_protocol::ConnectTo;
use agent_client_protocol::ConnectionTo;
use agent_client_protocol::Error;
use agent_client_protocol::ErrorCode;
use agent_client_protocol::JsonRpcRequest;
use agent_client_protocol::Role as _;
use tokio::sync::mpsc;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use weave_host_protocol::Host;
use weave_host_protocol::HostClient;
use weave_host_protocol::VersionRange;
use weave_host_protocol::agents::UpdateAvailableNotification;
use weave_host_protocol::devices::DevicePairedNotification;
use weave_host_protocol::devices::NewDevice;
use weave_host_protocol::devices::auth_message;
use weave_host_protocol::errors;
use weave_host_protocol::events::ElicitationCompletedNotification;
use weave_host_protocol::events::SessionChangedNotification;
use weave_host_protocol::events::SessionEventNotification;
use weave_host_protocol::hello::Auth;
use weave_host_protocol::hello::ChallengeRequest;
use weave_host_protocol::hello::ClientCapabilities;
use weave_host_protocol::hello::ClientId;
use weave_host_protocol::hello::ClientInfo;
use weave_host_protocol::hello::HelloRequest;
use weave_host_protocol::hello::HelloResponse;
use weave_host_protocol::pending::PendingAddedNotification;
use weave_host_protocol::pending::PendingResolvedNotification;
use weave_host_protocol::sessions::AttachSessionRequest;
use weave_host_protocol::sessions::CreateSessionRequest;
use weave_host_protocol::sessions::Replay;
use weave_host_protocol::sessions::SessionState;

pub use crate::remote::Credentials;

/// Everything the Host sends, in order.
#[derive(Debug)]
pub enum HostEvent {
    /// A journaled event of a session this client is attached to.
    Event(Box<SessionEventNotification>),
    Changed(SessionChangedNotification),
    PendingAdded(Box<PendingAddedNotification>),
    PendingResolved(PendingResolvedNotification),
    ElicitationCompleted(ElicitationCompletedNotification),
    /// A device took the offer this client made (`devices/offer`).
    DevicePaired(DevicePairedNotification),
    /// A newer version of an attached session's agent is out.
    UpdateAvailable(UpdateAvailableNotification),
    /// The answer to [`HostHandle::open`], ahead of the events that follow it.
    Opened {
        tag: u64,
        result: Result<Box<OpenedSession>, Error>,
    },
    /// The connection ended. Carries the reason unless it closed cleanly.
    Disconnected(Option<Error>),
}

/// A session opened by [`HostHandle::open`], with this client attached.
#[derive(Clone, Debug)]
pub struct OpenedSession {
    pub state: SessionState,
    /// What the replay that follows covers; none for a new session.
    pub replay: Option<Replay>,
}

/// A session to open: a new one, or one by id.
#[derive(Clone, Debug)]
pub enum Open {
    Create(CreateSessionRequest),
    Attach(AttachSessionRequest),
}

#[derive(Debug, thiserror::Error)]
pub enum ConnectError {
    #[error("couldn't reach the weave Host: {0}")]
    Connection(Error),
    /// The Host speaks no version this client does, as after an upgrade of one of them.
    #[error("{0}")]
    Incompatible(String),
    #[error("the weave Host refused the connection: {0}")]
    Refused(Error),
    /// The Host isn't the one the device paired with.
    #[error("this isn't the weave Host this device paired with")]
    WrongHost,
}

/// One connection to the Host. Dereferences to its [`HostHandle`].
pub struct HostConnection {
    handle: HostHandle,
    shutdown: oneshot::Sender<()>,
    driver: JoinHandle<()>,
}

impl std::ops::Deref for HostConnection {
    type Target = HostHandle;

    fn deref(&self) -> &HostHandle {
        &self.handle
    }
}

/// A cloneable handle for everything the client asks of the Host.
#[derive(Clone)]
pub struct HostHandle {
    cx: ConnectionTo<Host>,
    events: mpsc::UnboundedSender<HostEvent>,
    hello: HelloResponse,
}

impl HostConnection {
    /// Connect over `transport` and say hello as `client`, authenticating as a local client.
    pub async fn connect(
        transport: impl ConnectTo<HostClient> + 'static,
        client: ClientInfo,
        capabilities: ClientCapabilities,
    ) -> Result<(Self, mpsc::UnboundedReceiver<HostEvent>), ConnectError> {
        Self::connect_with(transport, client, capabilities, Credentials::Local).await
    }

    /// Connect over `transport` and say hello as `client` with `credentials`: a paired
    /// device answers the Host's challenge first.
    pub async fn connect_with(
        transport: impl ConnectTo<HostClient> + 'static,
        client: ClientInfo,
        capabilities: ClientCapabilities,
        credentials: Credentials,
    ) -> Result<(Self, mpsc::UnboundedReceiver<HostEvent>), ConnectError> {
        let (events, mut event_rx) = mpsc::unbounded_channel();
        let on_event = events.clone();
        let on_changed = events.clone();
        let on_added = events.clone();
        let on_resolved = events.clone();
        let on_completed = events.clone();
        let on_paired = events.clone();
        let on_update = events.clone();
        // Handlers run inside the dispatch loop, in the order messages arrived; each only
        // passes its message on.
        let builder = HostClient
            .builder()
            .name("weave-host-client")
            .on_receive_notification(
                async move |notification: SessionEventNotification, _cx| {
                    let _ = on_event.send(HostEvent::Event(Box::new(notification)));
                    Ok(())
                },
                agent_client_protocol::on_receive_notification!(),
            )
            .on_receive_notification(
                async move |notification: SessionChangedNotification, _cx| {
                    let _ = on_changed.send(HostEvent::Changed(notification));
                    Ok(())
                },
                agent_client_protocol::on_receive_notification!(),
            )
            .on_receive_notification(
                async move |notification: PendingAddedNotification, _cx| {
                    let _ = on_added.send(HostEvent::PendingAdded(Box::new(notification)));
                    Ok(())
                },
                agent_client_protocol::on_receive_notification!(),
            )
            .on_receive_notification(
                async move |notification: PendingResolvedNotification, _cx| {
                    let _ = on_resolved.send(HostEvent::PendingResolved(notification));
                    Ok(())
                },
                agent_client_protocol::on_receive_notification!(),
            )
            .on_receive_notification(
                async move |notification: ElicitationCompletedNotification, _cx| {
                    let _ = on_completed.send(HostEvent::ElicitationCompleted(notification));
                    Ok(())
                },
                agent_client_protocol::on_receive_notification!(),
            )
            .on_receive_notification(
                async move |notification: DevicePairedNotification, _cx| {
                    let _ = on_paired.send(HostEvent::DevicePaired(notification));
                    Ok(())
                },
                agent_client_protocol::on_receive_notification!(),
            )
            .on_receive_notification(
                async move |notification: UpdateAvailableNotification, _cx| {
                    let _ = on_update.send(HostEvent::UpdateAvailable(notification));
                    Ok(())
                },
                agent_client_protocol::on_receive_notification!(),
            );

        let (cx_tx, cx_rx) = oneshot::channel();
        let (shutdown, shutdown_rx) = oneshot::channel::<()>();
        let disconnected = events.clone();
        let driver = tokio::spawn(async move {
            let result = builder
                .connect_with(transport, async move |cx: ConnectionTo<Host>| {
                    let closed = cx.clone();
                    let _ = cx_tx.send(cx);
                    tokio::select! {
                        _ = shutdown_rx => {}
                        () = closed.incoming_closed() => {}
                    }
                    Ok(())
                })
                .await;
            let _ = disconnected.send(HostEvent::Disconnected(result.err()));
        });
        let Ok(cx) = cx_rx.await else {
            let error = match event_rx.recv().await {
                Some(HostEvent::Disconnected(Some(error))) => error,
                _ => Error::internal_error().data("the connection ended"),
            };
            return Err(ConnectError::Connection(error));
        };
        let hello = match say_hello(&cx, client, capabilities, credentials).await {
            Ok(hello) => hello,
            Err(error) => {
                let _ = shutdown.send(());
                let _ = driver.await;
                return Err(error);
            }
        };
        Ok((
            Self {
                handle: HostHandle { cx, events, hello },
                shutdown,
                driver,
            },
            event_rx,
        ))
    }

    pub fn handle(&self) -> HostHandle {
        self.handle.clone()
    }

    /// Close the connection. The Host detaches it from its sessions; nothing else changes.
    pub async fn shutdown(self) {
        let _ = self.shutdown.send(());
        let _ = self.driver.await;
    }
}

/// `host/hello` with `credentials`, after the challenge a paired device signs.
async fn say_hello(
    cx: &ConnectionTo<Host>,
    client: ClientInfo,
    capabilities: ClientCapabilities,
    credentials: Credentials,
) -> Result<HelloResponse, ConnectError> {
    let auth = match credentials {
        Credentials::Local => Auth::Local,
        Credentials::Pair { code, name, key } => Auth::Pair {
            code,
            device: NewDevice {
                name,
                public_key: key.jwk(),
            },
        },
        Credentials::Device {
            device_id,
            key,
            host_id,
        } => {
            let challenge = cx
                .send_request(ChallengeRequest {})
                .block_task()
                .await
                .map_err(hello_failed)?;
            if host_id.is_some_and(|expected| expected != challenge.host_id) {
                return Err(ConnectError::WrongHost);
            }
            let message = auth_message(&challenge.host_id, &device_id, &challenge.nonce);
            Auth::Device {
                device_id,
                signature: key.sign(&message),
            }
        }
    };
    let request = HelloRequest {
        protocol: VersionRange::supported(),
        client,
        auth,
        capabilities,
    };
    cx.send_request(request)
        .block_task()
        .await
        .map_err(hello_failed)
}

/// Why `host/hello` failed, as the client should explain it.
fn hello_failed(error: Error) -> ConnectError {
    if errors::is(&error, errors::INCOMPATIBLE_PROTOCOL) {
        return ConnectError::Incompatible(format!(
            "the weave Host and this weave don't speak a common protocol version ({}); \
             restart the Host with `weave daemon restart`",
            error.message
        ));
    }
    // A Host from before this protocol answers nothing but ACP.
    if error.code == ErrorCode::MethodNotFound {
        return ConnectError::Incompatible(
            "the running weave Host is older than this weave; restart it with `weave daemon \
             restart`"
                .to_owned(),
        );
    }
    ConnectError::Refused(error)
}

impl HostHandle {
    /// What the Host said at hello.
    pub fn hello(&self) -> &HelloResponse {
        &self.hello
    }

    /// This connection, as the Host names it in turn origins and answers.
    pub fn client_id(&self) -> &ClientId {
        &self.hello.client_id
    }

    /// Any request, answered when the Host answers.
    pub async fn send<Request: JsonRpcRequest>(
        &self,
        request: Request,
    ) -> Result<Request::Response, Error> {
        self.cx.send_request(request).block_task().await
    }

    /// Open a session; the answer arrives as [`HostEvent::Opened`] with `tag`, in order with
    /// the session's events.
    pub fn open(&self, open: Open, tag: u64) -> Result<(), Error> {
        let events = self.events.clone();
        match open {
            Open::Create(request) => {
                self.cx
                    .send_request(request)
                    .on_receiving_result(async move |result| {
                        let result = result.map(|state| {
                            Box::new(OpenedSession {
                                state,
                                replay: None,
                            })
                        });
                        let _ = events.send(HostEvent::Opened { tag, result });
                        Ok(())
                    })
            }
            Open::Attach(request) => {
                self.cx
                    .send_request(request)
                    .on_receiving_result(async move |result| {
                        let result = result.map(|attached| {
                            Box::new(OpenedSession {
                                state: attached.state,
                                replay: Some(attached.replay),
                            })
                        });
                        let _ = events.send(HostEvent::Opened { tag, result });
                        Ok(())
                    })
            }
        }
    }
}
