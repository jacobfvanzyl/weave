//! A client of the Dispatcher's API, as the `weave dispatcher` CLI is: connect to its socket,
//! say hello, and ask.

use agent_client_protocol::ConnectTo;
use agent_client_protocol::ConnectionTo;
use agent_client_protocol::Error;
use agent_client_protocol::JsonRpcRequest;
use agent_client_protocol::Role as _;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use weave_host_protocol::Dispatcher;
use weave_host_protocol::DispatcherClient;
use weave_host_protocol::dispatcher::DISPATCHER_PROTOCOL;
use weave_host_protocol::dispatcher::DispatcherHello;
use weave_host_protocol::dispatcher::DispatcherHelloRequest;
use weave_host_protocol::hello::ClientInfo;

pub struct DispatcherConnection {
    cx: ConnectionTo<Dispatcher>,
    hello: DispatcherHello,
    shutdown: oneshot::Sender<()>,
    driver: JoinHandle<()>,
}

impl DispatcherConnection {
    /// Connect over `transport` as `client` and say hello.
    pub async fn connect(
        transport: impl ConnectTo<DispatcherClient> + 'static,
        client: ClientInfo,
    ) -> Result<Self, Error> {
        let (cx_tx, cx_rx) = oneshot::channel();
        let (shutdown, shutdown_rx) = oneshot::channel::<()>();
        let (ended_tx, ended_rx) = oneshot::channel();
        let driver = tokio::spawn(async move {
            let result = DispatcherClient
                .builder()
                .name("weave-dispatcher-client")
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
        let hello = cx
            .send_request(DispatcherHelloRequest {
                protocol: DISPATCHER_PROTOCOL,
                client,
            })
            .block_task()
            .await;
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
            shutdown,
            driver,
        })
    }

    pub fn hello(&self) -> &DispatcherHello {
        &self.hello
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
