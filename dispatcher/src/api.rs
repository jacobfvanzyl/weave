//! What the `weave dispatcher` CLI asks the Dispatcher over its socket: its status, the Hosts
//! it is paired with, and its schedules and their occurrences. Each connection says hello
//! first, with the API's version.

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
use weave_host_protocol::dispatcher::AddScheduleRequest;
use weave_host_protocol::dispatcher::DISPATCHER_PROTOCOL;
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

/// Answer a request of type `$request` with `$answer`, an expression of `$shared` and
/// `$request` that may wait, off the dispatch loop, once the connection has said hello.
macro_rules! handle {
    ($builder:ident, $shared:ident, $greeted:ident, $request:ident: $type:ty => $answer:expr) => {
        let $builder = {
            let shared = Arc::clone(&$shared);
            let greeted = Arc::clone(&$greeted);
            $builder.on_receive_request(
                async move |$request: $type,
                            responder: Responder<_>,
                            cx: ConnectionTo<DispatcherClient>| {
                    let $shared = Arc::clone(&shared);
                    let greeted = Arc::clone(&greeted);
                    cx.spawn(async move {
                        let answer = match greeted_first(&greeted) {
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
) -> Result<(), Error> {
    let greeted = Arc::new(AtomicBool::new(false));
    let hello = Arc::clone(&greeted);
    let stop = shared.stop.clone();
    let builder = Dispatcher
        .builder()
        .name("weave-dispatcher")
        .on_receive_request(
            async move |request: DispatcherHelloRequest, responder: Responder<_>, _cx| {
                if request.protocol != DISPATCHER_PROTOCOL {
                    return responder.respond_with_error(Error::new(
                    errors::INCOMPATIBLE_PROTOCOL,
                    format!(
                        "this Dispatcher speaks version {DISPATCHER_PROTOCOL} of its API, and {} \
                         version {}",
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
        );
    handle!(builder, shared, greeted, _request: DispatcherStatusRequest => shared.status());
    handle!(builder, shared, greeted, _request: ListHostsRequest =>
        shared.hosts().map(|hosts| ListHostsResponse { hosts }));
    handle!(builder, shared, greeted, request: AddHostRequest =>
        shared.add_host(request).await.map(|host| AddHostResponse { host }));
    handle!(builder, shared, greeted, request: RemoveHostRequest =>
        shared.remove_host(&request.host).await.map(|()| Empty {}));
    handle!(builder, shared, greeted, _request: ListSchedulesRequest =>
        shared.schedules().map(|schedules| ListSchedulesResponse { schedules }));
    handle!(builder, shared, greeted, request: AddScheduleRequest =>
        shared.add_schedule(request).map(|schedule| ScheduleResponse { schedule }));
    handle!(builder, shared, greeted, request: RemoveScheduleRequest =>
        shared.remove_schedule(&request.schedule).map(|()| Empty {}));
    handle!(builder, shared, greeted, request: PauseScheduleRequest =>
        shared.pause_schedule(&request.schedule).map(|schedule| ScheduleResponse { schedule }));
    handle!(builder, shared, greeted, request: ResumeScheduleRequest =>
        shared.resume_schedule(&request.schedule).map(|schedule| ScheduleResponse { schedule }));
    handle!(builder, shared, greeted, request: RunScheduleRequest =>
        shared.run_schedule(&request.schedule).map(|occurrence| OccurrenceResponse { occurrence }));
    handle!(builder, shared, greeted, request: ListOccurrencesRequest =>
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
