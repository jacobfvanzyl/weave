//! The Host's WebSocket, for remote clients: the person's other devices, which reach it
//! through Tailscale Serve and prove a paired device in `host/hello` ([`crate::devices`]);
//! `local` is never accepted on it. `weave-remote` carries the connection
//! ([`weave_remote::websocket`]).
//!
//! The upgrade asks for the `weave-host` subprotocol, or for `weave-terminal`, a terminal's
//! stream, which `terminals::stream` serves with its ticket in place of a hello. See
//! `docs/specs/wve-90-remote-clients.md`.

use std::sync::Arc;

use futures::future::BoxFuture;
use tokio::net::TcpListener;
use tokio::net::TcpStream;
use tokio_util::sync::CancellationToken;
use weave_host_protocol::terminals::stream::SUBPROTOCOL as TERMINAL_SUBPROTOCOL;
use weave_host_protocol::websocket::SUBPROTOCOL;
use weave_remote::access::Accept;
use weave_remote::websocket::Link;
use weave_remote::websocket::RemoteConfig;

use crate::Shared;
use crate::thread::Backlog;

impl Backlog for Link {
    fn replaying(&self, bytes: usize) {
        Link::replaying(self, bytes);
    }
}

/// What remote access does with its listener: serve the Host's remote clients on it.
pub(crate) fn accept(shared: &Arc<Shared>) -> Accept {
    let shared = Arc::clone(shared);
    Arc::new(move |listener, stop| {
        let config = shared
            .remote
            .settings()
            .map(|settings| settings.websocket.clone())
            .unwrap_or_default();
        tokio::spawn(serve(Arc::clone(&shared), listener, config, stop));
    })
}

/// Accept remote clients on `listener` until `stop_serving` is cancelled or the Host stops.
///
/// Its future is boxed and declared `Send`: a client connection can turn remote access on,
/// which serves more connections, and the compiler can't infer `Send` around that cycle.
pub(crate) fn serve(
    shared: Arc<Shared>,
    listener: TcpListener,
    config: RemoteConfig,
    stop_serving: CancellationToken,
) -> BoxFuture<'static, ()> {
    Box::pin(async move {
        let config = Arc::new(config);
        let mut stop = shared.stop.subscribe();
        loop {
            tokio::select! {
                () = stop_serving.cancelled() => break,
                accepted = listener.accept() => match accepted {
                    Ok((stream, _)) => {
                        let shared = Arc::clone(&shared);
                        let config = Arc::clone(&config);
                        tokio::spawn(async move { connection(shared, stream, config).await });
                    }
                    Err(error) => tracing::warn!(%error, "accepting a WebSocket client failed"),
                },
                changed = stop.changed() => {
                    if changed.is_err() || *stop.borrow() {
                        break;
                    }
                }
            }
        }
    })
}

async fn connection(shared: Arc<Shared>, stream: TcpStream, config: Arc<RemoteConfig>) {
    let protocols = [SUBPROTOCOL, TERMINAL_SUBPROTOCOL];
    let Some((protocol, socket)) =
        weave_remote::websocket::upgrade(stream, &config.origins, &protocols).await
    else {
        return;
    };
    if protocol == TERMINAL_SUBPROTOCOL {
        crate::terminals::stream::serve(shared, socket, config).await;
        return;
    }
    weave_remote::websocket::serve_rpc(socket, &config, |transport, link| {
        crate::client::serve_remote(shared, transport, link)
    })
    .await;
}

/// Turn remote access on if it isn't, and give the URL devices connect to (ADR 0016).
pub(crate) async fn start(shared: &Arc<Shared>) -> Result<String, agent_client_protocol::Error> {
    shared
        .remote
        .start(&accept(shared), || shared.devices.any_paired())
        .await
}

/// Turn remote access off when no device is paired and no offer is good.
pub(crate) async fn stop_if_unused(shared: &Arc<Shared>) {
    shared
        .remote
        .stop_if_unused(|| shared.devices.any_paired() || shared.devices.offering())
        .await;
}
