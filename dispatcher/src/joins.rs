//! Hosts joining the Dispatcher (ADR 0030, WVE-194), and connecting to it from then on. A Host
//! joins with a one-time code `hosts/offer` gave, good for five minutes, and a P-256 key of its
//! own. Every connection it opens after that proves the key, by signing the Dispatcher's
//! challenge in `hosts/connect`, before the Dispatcher takes the connection up as the Host's
//! link ([`crate::link`]) and says `host/hello` over it. Hosts on other computers connect to the
//! Dispatcher's WebSocket with a subprotocol of their own; one on the Dispatcher's computer
//! connects to the socket in its directory, over which the same WebSocket runs.

use std::sync::Arc;
use std::sync::Mutex;

use agent_client_protocol::Error;
use tokio::io::AsyncRead;
use tokio::io::AsyncWrite;
use tokio::net::UnixListener;
use tokio::sync::oneshot;
use weave_host_protocol::Timestamp;
use weave_host_protocol::dispatcher::ConnectHostRequest;
use weave_host_protocol::dispatcher::DISPATCHER_HOST_SUBPROTOCOL;
use weave_host_protocol::dispatcher::DISPATCHER_PROTOCOL;
use weave_host_protocol::dispatcher::DispatcherChallenge;
use weave_host_protocol::dispatcher::HostConnected;
use weave_host_protocol::dispatcher::host_connect_message;
use weave_host_protocol::errors;
use weave_host_protocol::websocket::CLOSE_UNAUTHENTICATED;
use weave_remote::pairing::Offers;
use weave_remote::pairing::random_id;
use weave_remote::pairing::signed;
use weave_remote::pairing::verifying_key;
use weave_remote::preamble;
use weave_remote::websocket;
use weave_remote::websocket::RemoteConfig;
use weave_remote::websocket::WebSocketStream;

use crate::Shared;
use crate::internal;
use crate::link::Arrival;
use crate::link::Link;
use crate::lock;
use crate::now_ms;
use crate::socket;
use crate::store::StoredHost;

/// How long a Host has to sign its challenge.
const CHALLENGE_LIFETIME_MS: Timestamp = 30 * 1000;

/// The live codes Hosts join with.
#[derive(Default)]
pub(crate) struct Joins {
    offers: Mutex<Offers<()>>,
}

impl Joins {
    /// A new code, good for `lifetime_ms`, and when it expires.
    pub(crate) fn offer(&self, lifetime_ms: Timestamp) -> (String, Timestamp) {
        lock(&self.offers).offer(None, (), lifetime_ms)
    }

    /// Whether a code is still good, which keeps remote access on while it is.
    pub(crate) fn offering(&self) -> bool {
        lock(&self.offers).any_live()
    }

    /// Use up the live code `code`; whether there was one.
    fn take(&self, code: &str) -> bool {
        lock(&self.offers).take(code).is_some()
    }
}

/// Take Hosts' connections on `listener`, the socket Hosts on the Dispatcher's own computer
/// connect to, until the Dispatcher stops. Only the socket owner's are served.
pub(crate) async fn serve_socket(shared: Arc<Shared>, listener: UnixListener) {
    let owner = socket::owner(&listener);
    let config = Arc::new(RemoteConfig::default());
    loop {
        let accepted = tokio::select! {
            accepted = listener.accept() => accepted,
            () = shared.stop.cancelled() => return,
        };
        match accepted {
            Ok((stream, _)) => match socket::from_owner(&stream, owner) {
                Some(true) => {
                    let shared = Arc::clone(&shared);
                    let config = Arc::clone(&config);
                    tokio::spawn(async move {
                        let protocols = [DISPATCHER_HOST_SUBPROTOCOL];
                        if let Some((_, socket)) = websocket::upgrade(stream, &[], &protocols).await
                        {
                            connection(shared, socket, config, true).await;
                        }
                    });
                }
                Some(false) => tracing::warn!("refused a Host's connection from another user"),
                None => tracing::debug!("refused a Host's connection whose user can't be told"),
            },
            Err(error) => tracing::warn!(%error, "accepting a Host's connection failed"),
        }
    }
}

/// A Host's own connection: its challenge and `hosts/connect`, then the Host protocol, with the
/// Dispatcher as the Host's client, until either end closes it. `here`: it came over the
/// Dispatcher's socket.
pub(crate) async fn connection<S>(
    shared: Arc<Shared>,
    mut socket: WebSocketStream<S>,
    config: Arc<RemoteConfig>,
    here: bool,
) where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let host = match tokio::time::timeout(config.hello_deadline, prove(&shared, &mut socket, here))
        .await
    {
        Ok(Some(host)) => host,
        Ok(None) => return,
        Err(_) => {
            tracing::info!("closed a Host's connection that proved nothing in time");
            preamble::close(&mut socket, CLOSE_UNAUTHENTICATED).await;
            return;
        }
    };
    let (gone, gone_rx) = oneshot::channel();
    websocket::serve_rpc(socket, &config, |transport, link| async move {
        link.proved();
        let (done, finished) = oneshot::channel();
        let arrival = Arrival {
            transport,
            link,
            gone: gone_rx,
        };
        shared.arrived(host, arrival, done);
        let _ = finished.await;
        Ok(())
    })
    .await;
    let _ = gone.send(());
}

/// Answer the Host's `dispatcher/challenge` and `hosts/connect`: the Host, once it has proved
/// itself. `None` once a refusal has been answered and the connection closed.
async fn prove<S: AsyncRead + AsyncWrite + Unpin>(
    shared: &Shared,
    socket: &mut WebSocketStream<S>,
    here: bool,
) -> Option<StoredHost> {
    let asked = preamble::next_request(socket).await?;
    if asked.method != "dispatcher/challenge" {
        refuse(
            socket,
            asked.id,
            "say dispatcher/challenge first".to_owned(),
        )
        .await;
        return None;
    }
    let nonce = random_id(32);
    let expires_at = now_ms() + CHALLENGE_LIFETIME_MS;
    let challenge = DispatcherChallenge {
        dispatcher_id: shared.id.clone(),
        nonce: nonce.clone(),
        expires_at,
    };
    if !preamble::answer(socket, asked.id, Ok(challenge)).await {
        return None;
    }
    let asked = preamble::next_request(socket).await?;
    if asked.method != "hosts/connect" {
        refuse(socket, asked.id, "say hosts/connect next".to_owned()).await;
        return None;
    }
    let admitted = asked
        .params::<ConnectHostRequest>()
        .and_then(|request| shared.admit(request, &nonce, expires_at, here));
    match admitted {
        Ok((host, connected)) => preamble::answer(socket, asked.id, Ok(connected))
            .await
            .then_some(host),
        Err(error) => {
            tracing::info!(why = %error.message, "refused a Host's connection");
            preamble::answer::<_, ()>(socket, asked.id, Err(error)).await;
            preamble::close(socket, CLOSE_UNAUTHENTICATED).await;
            None
        }
    }
}

async fn refuse<S: AsyncRead + AsyncWrite + Unpin>(
    socket: &mut WebSocketStream<S>,
    id: serde_json::Value,
    why: String,
) {
    preamble::answer::<_, ()>(socket, id, Err(errors::unauthenticated(why))).await;
    preamble::close(socket, CLOSE_UNAUTHENTICATED).await;
}

impl Shared {
    /// The Host `request` says it is, if its signature of `nonce` is its key's: the key it joins
    /// with now, with a live code, or the one it joined with before.
    fn admit(
        &self,
        request: ConnectHostRequest,
        nonce: &str,
        expires_at: Timestamp,
        here: bool,
    ) -> Result<(StoredHost, HostConnected), Error> {
        if request.protocol != DISPATCHER_PROTOCOL {
            return Err(Error::new(
                errors::INCOMPATIBLE_PROTOCOL,
                format!(
                    "this Dispatcher speaks version {DISPATCHER_PROTOCOL} of its API, and the Host \
                     version {}",
                    request.protocol
                ),
            ));
        }
        if now_ms() > expires_at {
            return Err(errors::unauthenticated("the challenge expired"));
        }
        let message = host_connect_message(&self.id, &request.host_id, nonce);
        let known = self.store.host(&request.host_id).map_err(internal)?;
        let host = match request.join {
            Some(join) => {
                if verifying_key(&join.public_key).is_none()
                    || !signed(&join.public_key, &message, &request.signature)
                {
                    return Err(errors::unauthenticated(
                        "the Host's signature doesn't match the key it joins with",
                    ));
                }
                if !self.joins.take(&join.code) {
                    return Err(errors::unauthenticated(
                        "the code may have expired or been used: `weave hosts add` shows a new one",
                    ));
                }
                let now = now_ms();
                let name = match request.name.trim() {
                    "" => known
                        .as_ref()
                        .map_or_else(|| request.host_id.clone(), |host| host.name.clone()),
                    name => name.to_owned(),
                };
                let host = StoredHost {
                    host_id: request.host_id,
                    name,
                    url: String::new(),
                    device_id: self.id.clone(),
                    paired_at: known.as_ref().map_or(now, |host| host.paired_at),
                    refused: None,
                    public_key: Some(join.public_key),
                    joined_at: Some(now),
                    here,
                };
                self.store.put_host(&host).map_err(internal)?;
                tracing::info!(host = %host.host_id, name = %host.name, "a Host joined");
                host
            }
            None => {
                let Some(host) = known else {
                    return Err(errors::unauthenticated(
                        "this Host hasn't joined the Dispatcher, or was removed: `weave hosts \
                         add` joins it",
                    ));
                };
                if host.refused.is_some() {
                    return Err(errors::unauthenticated(
                        "this Host left the Dispatcher: `weave hosts add` joins it again",
                    ));
                }
                let proved = host
                    .public_key
                    .as_ref()
                    .is_some_and(|key| signed(key, &message, &request.signature));
                if !proved {
                    return Err(errors::unauthenticated(
                        "the Host's signature doesn't match the key it joined with",
                    ));
                }
                host
            }
        };
        let connected = HostConnected {
            dispatcher_id: self.id.clone(),
            dispatcher_name: self.config.name.clone(),
            public_key: self.key.jwk(),
            name: host.name.clone(),
        };
        Ok((host, connected))
    }

    /// Take up `arrival`, `host`'s connection, in place of any it had before.
    fn arrived(self: &Arc<Self>, host: StoredHost, arrival: Arrival, done: oneshot::Sender<()>) {
        let host_id = host.host_id.clone();
        let link = Link::start(Arc::clone(self), host, arrival, done);
        if let Some(old) = lock(&self.links).insert(host_id, link) {
            old.stop();
        }
    }
}
