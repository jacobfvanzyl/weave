//! A client of the Dispatcher's API, as the `weave` CLI is: connect to its socket, or to its
//! WebSocket as a paired device ([`DispatcherConnection::connect_with`]), say hello, and ask.

use agent_client_protocol::ConnectTo;
use agent_client_protocol::ConnectionTo;
use agent_client_protocol::Error;
use agent_client_protocol::JsonRpcRequest;
use agent_client_protocol::Role as _;
use tokio::sync::mpsc;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use weave_host_client::Credentials;
use weave_host_protocol::Dispatcher;
use weave_host_protocol::DispatcherClient;
use weave_host_protocol::devices::Device;
use weave_host_protocol::devices::DevicePairedNotification;
use weave_host_protocol::devices::NewDevice;
use weave_host_protocol::dispatcher::DISPATCHER_PROTOCOL;
use weave_host_protocol::dispatcher::DispatcherChallengeRequest;
use weave_host_protocol::dispatcher::DispatcherHello;
use weave_host_protocol::dispatcher::DispatcherHelloRequest;
use weave_host_protocol::dispatcher::dispatcher_auth_message;
use weave_host_protocol::errors;
use weave_host_protocol::hello::Auth;
use weave_host_protocol::hello::ClientInfo;

pub struct DispatcherConnection {
    cx: ConnectionTo<Dispatcher>,
    hello: DispatcherHello,
    /// The devices that took this connection's pairing offers.
    paired: mpsc::UnboundedReceiver<Device>,
    shutdown: oneshot::Sender<()>,
    driver: JoinHandle<()>,
}

impl DispatcherConnection {
    /// Connect over `transport`, the Dispatcher's socket, as `client` and say hello.
    pub async fn connect(
        transport: impl ConnectTo<DispatcherClient> + 'static,
        client: ClientInfo,
    ) -> Result<Self, Error> {
        Self::connect_with(transport, client, Credentials::Local).await
    }

    /// Connect over `transport` as `client` and say hello with `credentials`: on the
    /// WebSocket, a paired device signs the Dispatcher's challenge first, and with `host_id`
    /// checks it's the Dispatcher it paired with.
    pub async fn connect_with(
        transport: impl ConnectTo<DispatcherClient> + 'static,
        client: ClientInfo,
        credentials: Credentials,
    ) -> Result<Self, Error> {
        let (cx_tx, cx_rx) = oneshot::channel();
        let (shutdown, shutdown_rx) = oneshot::channel::<()>();
        let (ended_tx, ended_rx) = oneshot::channel();
        let (paired_tx, paired) = mpsc::unbounded_channel();
        let driver = tokio::spawn(async move {
            let result = DispatcherClient
                .builder()
                .name("weave-dispatcher-client")
                .on_receive_notification(
                    async move |notification: DevicePairedNotification, _cx| {
                        let _ = paired_tx.send(notification.device);
                        Ok(())
                    },
                    agent_client_protocol::on_receive_notification!(),
                )
                .connect_with(transport, async move |cx: ConnectionTo<Dispatcher>| {
                    let closed = cx.clone();
                    let _ = cx_tx.send(cx);
                    tokio::select! {
                        _ = shutdown_rx => {}
                        () = closed.incoming_closed() => {}
                    }
                    Ok(())
                })
                .await;
            let _ = ended_tx.send(result);
        });
        let Ok(cx) = cx_rx.await else {
            let error = match ended_rx.await {
                Ok(Err(error)) => error,
                _ => Error::internal_error().data("the connection ended"),
            };
            return Err(error);
        };
        let hello = match auth(&cx, credentials).await {
            Ok(auth) => {
                cx.send_request(DispatcherHelloRequest {
                    protocol: DISPATCHER_PROTOCOL,
                    client,
                    auth,
                })
                .block_task()
                .await
            }
            Err(error) => Err(error),
        };
        let hello = match hello {
            Ok(hello) => hello,
            Err(error) => {
                let _ = shutdown.send(());
                let _ = driver.await;
                return Err(error);
            }
        };
        Ok(Self {
            cx,
            hello,
            paired,
            shutdown,
            driver,
        })
    }

    pub fn hello(&self) -> &DispatcherHello {
        &self.hello
    }

    /// The next device that takes one of this connection's `devices/offer`s; none once the
    /// connection ends.
    pub async fn paired(&mut self) -> Option<Device> {
        self.paired.recv().await
    }

    /// Any request, answered when the Dispatcher answers.
    pub async fn send<Request: JsonRpcRequest>(
        &self,
        request: Request,
    ) -> Result<Request::Response, Error> {
        self.cx.send_request(request).block_task().await
    }

    pub async fn shutdown(self) {
        let _ = self.shutdown.send(());
        let _ = self.driver.await;
    }
}

/// What `credentials` say at hello, after the challenge a paired device signs.
async fn auth(
    cx: &ConnectionTo<Dispatcher>,
    credentials: Credentials,
) -> Result<Option<Auth>, Error> {
    Ok(match credentials {
        Credentials::Local => None,
        // Which the Dispatcher refuses: its word is for Hosts.
        Credentials::Dispatcher => Some(Auth::Dispatcher),
        Credentials::Pair {
            code,
            name,
            key,
            service,
        } => Some(Auth::Pair {
            code,
            device: NewDevice {
                name,
                public_key: key.jwk(),
                service,
            },
        }),
        Credentials::Device {
            device_id,
            key,
            host_id,
        } => {
            let challenge = cx
                .send_request(DispatcherChallengeRequest {})
                .block_task()
                .await?;
            if host_id.is_some_and(|expected| expected != challenge.dispatcher_id) {
                return Err(errors::unauthenticated(
                    "another Dispatcher answers there now; pair with it again",
                ));
            }
            let message =
                dispatcher_auth_message(&challenge.dispatcher_id, &device_id, &challenge.nonce);
            let signature = key.sign(&message).map_err(|why| {
                Error::internal_error().data(format!("signing the challenge: {why}"))
            })?;
            Some(Auth::Device {
                device_id,
                signature,
            })
        }
    })
}
