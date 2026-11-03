//! What the `weave dispatcher` CLI asks the Dispatcher over its socket: its status, and the
//! Hosts it is paired with. Each connection says hello first, with the API's version.

use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;

use agent_client_protocol::ConnectTo;
use agent_client_protocol::ConnectionTo;
use agent_client_protocol::Error;
use agent_client_protocol::Responder;
use agent_client_protocol::Role as _;
use tokio::net::UnixListener;
use weave_host_protocol::Dispatcher;
use weave_host_protocol::DispatcherClient;
use weave_host_protocol::Empty;
use weave_host_protocol::dispatcher::AddHostRequest;
use weave_host_protocol::dispatcher::AddHostResponse;
use weave_host_protocol::dispatcher::DISPATCHER_PROTOCOL;
use weave_host_protocol::dispatcher::DispatcherHello;
use weave_host_protocol::dispatcher::DispatcherHelloRequest;
use weave_host_protocol::dispatcher::DispatcherStatusRequest;
use weave_host_protocol::dispatcher::ListHostsRequest;
use weave_host_protocol::dispatcher::ListHostsResponse;
use weave_host_protocol::dispatcher::RemoveHostRequest;
use weave_host_protocol::errors;

use crate::Shared;
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
            Ok((stream, _)) if socket::from_owner(&stream, owner) => {
                let shared = Arc::clone(&shared);
                tokio::spawn(async move {
                    if let Err(error) = answer(shared, socket::transport(stream)).await {
                        tracing::debug!(%error, "a CLI connection ended");
                    }
                });
            }
            Ok(_) => tracing::warn!("refused a connection from another user"),
            Err(error) => tracing::warn!(%error, "accepting a connection failed"),
        }
    }
}

async fn answer(
    shared: Arc<Shared>,
    transport: impl ConnectTo<Dispatcher> + 'static,
) -> Result<(), Error> {
    let greeted = Arc::new(AtomicBool::new(false));
    let hello = Arc::clone(&greeted);
    let (on_status, on_list, on_add, on_remove) = (
        Arc::clone(&shared),
        Arc::clone(&shared),
        Arc::clone(&shared),
        Arc::clone(&shared),
    );
    let (status_greeted, list_greeted, add_greeted, remove_greeted) = (
        Arc::clone(&greeted),
        Arc::clone(&greeted),
        Arc::clone(&greeted),
        Arc::clone(&greeted),
    );
    let stop = shared.stop.clone();
    Dispatcher
        .builder()
        .name("weave-dispatcher")
        .on_receive_request(
            async move |request: DispatcherHelloRequest, responder: Responder<_>, _cx| {
                if request.protocol != DISPATCHER_PROTOCOL {
                    return responder.respond_with_error(Error::new(
                        errors::INCOMPATIBLE_PROTOCOL,
                        format!(
                            "this Dispatcher speaks version {DISPATCHER_PROTOCOL} of its API, \
                             and {} version {}",
                            request.client.name, request.protocol
                        ),
                    ));
                }
                hello.store(true, Ordering::Relaxed);
                responder.respond(DispatcherHello {
                    protocol: DISPATCHER_PROTOCOL,
                    version: env!("CARGO_PKG_VERSION").to_owned(),
                })
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |_request: DispatcherStatusRequest, responder: Responder<_>, _cx| {
                responder.respond_with_result(
                    greeted_first(&status_greeted).and_then(|()| on_status.status()),
                )
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |_request: ListHostsRequest, responder: Responder<_>, _cx| {
                responder.respond_with_result(
                    greeted_first(&list_greeted)
                        .and_then(|()| on_list.hosts())
                        .map(|hosts| ListHostsResponse { hosts }),
                )
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: AddHostRequest,
                        responder: Responder<_>,
                        cx: ConnectionTo<DispatcherClient>| {
                // Pairing waits on the Host, which a handler must not do.
                let shared = Arc::clone(&on_add);
                let greeted = Arc::clone(&add_greeted);
                cx.spawn(async move {
                    let added = match greeted_first(&greeted) {
                        Ok(()) => shared.add_host(request).await,
                        Err(error) => Err(error),
                    };
                    responder.respond_with_result(added.map(|host| AddHostResponse { host }))
                })
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: RemoveHostRequest,
                        responder: Responder<_>,
                        cx: ConnectionTo<DispatcherClient>| {
                let shared = Arc::clone(&on_remove);
                let greeted = Arc::clone(&remove_greeted);
                cx.spawn(async move {
                    let removed = match greeted_first(&greeted) {
                        Ok(()) => shared.remove_host(&request.host).await,
                        Err(error) => Err(error),
                    };
                    responder.respond_with_result(removed.map(|()| Empty {}))
                })
            },
            agent_client_protocol::on_receive_request!(),
        )
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

fn greeted_first(greeted: &AtomicBool) -> Result<(), Error> {
    if greeted.load(Ordering::Relaxed) {
        Ok(())
    } else {
        Err(Error::new(
            errors::UNAUTHENTICATED,
            "say dispatcher/hello first",
        ))
    }
}
