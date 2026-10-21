//! The Host's WebSocket, for remote clients: the person's other devices, which reach it
//! through Tailscale Serve. It listens on loopback only, and since Serve's connections and
//! local processes' look the same from here, every connection has to prove a paired device
//! in `host/hello` ([`crate::devices`]); `local` is never accepted on it.
//!
//! One JSON-RPC message per text frame, through the ACP SDK's [`Lines`]. The upgrade must ask
//! for the `weave-host` subprotocol and carry no `Origin`, the app's, or one the configuration
//! allows.
//! The Host pings every 20 seconds and closes a connection that doesn't answer by the next
//! ping, one that proves no device within 30 seconds, and one with more than 8 MiB waiting
//! to be sent, which then reconnects and attaches after its position. See `docs/specs/wve-90-remote-clients.md`.

use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicU16;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::task::Context;
use std::task::Poll;
use std::time::Duration;

use agent_client_protocol::Lines;
use futures::SinkExt as _;
use futures::StreamExt as _;
use futures::future::BoxFuture;
use futures::stream::SplitSink;
use tokio::net::TcpListener;
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::server::ErrorResponse;
use tokio_tungstenite::tungstenite::handshake::server::Request;
use tokio_tungstenite::tungstenite::handshake::server::Response;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_util::sync::CancellationToken;
use weave_host_protocol::Timestamp;
use weave_host_protocol::websocket::APP_ORIGIN;
use weave_host_protocol::websocket::CLOSE_BEHIND;
use weave_host_protocol::websocket::CLOSE_UNAUTHENTICATED;
use weave_host_protocol::websocket::MAX_MESSAGE;
use weave_host_protocol::websocket::SUBPROTOCOL;

use crate::Shared;
use crate::devices::Closer;
use crate::devices::random_bytes;
use crate::journal::now_ms;
use crate::session::lock;

/// How often the Host pings, and how long a peer has to answer.
const PING_INTERVAL: Duration = Duration::from_secs(20);
/// How much may wait to be sent to one connection before it's closed as fallen behind.
const BEHIND_LIMIT: usize = 8 * 1024 * 1024;
/// How long a challenge stays good.
const CHALLENGE_LIFETIME_MS: Timestamp = 30 * 1000;
/// How long closing waits for what's being written and for the close frame.
const CLOSE_GRACE: Duration = Duration::from_secs(5);
/// How long a connection has to prove a paired device before it's closed.
const HELLO_DEADLINE: Duration = Duration::from_secs(30);

/// How the WebSocket treats its clients.
#[derive(Clone, Debug)]
pub struct RemoteConfig {
    /// `Origin` values allowed besides none, which native clients send.
    pub origins: Vec<String>,
    /// How often to ping, and how long a client has to answer.
    pub ping_interval: Duration,
    /// How much may wait to be sent to one client before it's closed as fallen behind.
    pub behind_limit: usize,
    /// How long a connection has to prove a paired device.
    pub hello_deadline: Duration,
}

impl Default for RemoteConfig {
    fn default() -> Self {
        Self {
            origins: Vec::new(),
            ping_interval: PING_INTERVAL,
            behind_limit: BEHIND_LIMIT,
            hello_deadline: HELLO_DEADLINE,
        }
    }
}

/// One WebSocket connection, as its client connection sees it: its challenge, and closing it.
pub(crate) struct Link {
    close: mpsc::UnboundedSender<u16>,
    /// A close code to send once the next message has gone, as after a failed hello's error.
    close_after_next: AtomicU16,
    challenge: Mutex<Option<(String, Timestamp)>>,
    last_pong_ms: AtomicU64,
    /// It has proved a paired device.
    proved: AtomicBool,
}

impl Link {
    /// The connection proved a paired device, so the hello deadline no longer applies.
    pub(crate) fn proved(&self) {
        self.proved.store(true, Ordering::SeqCst);
    }

    /// A new challenge for this connection, replacing any before it.
    pub(crate) fn challenge(&self) -> (String, Timestamp) {
        let nonce = base64_url(&random_bytes::<32>());
        let expires_at = now_ms() + CHALLENGE_LIFETIME_MS;
        *lock(&self.challenge) = Some((nonce.clone(), expires_at));
        (nonce, expires_at)
    }

    /// The live challenge, used up: one hello per challenge.
    pub(crate) fn take_challenge(&self) -> Option<String> {
        lock(&self.challenge)
            .take()
            .filter(|(_, expires_at)| *expires_at > now_ms())
            .map(|(nonce, _)| nonce)
    }

    /// Close with `code` once the next message has gone.
    pub(crate) fn close_after_next(&self, code: u16) {
        self.close_after_next.store(code, Ordering::SeqCst);
    }
}

impl Closer for Link {
    fn close(&self, code: u16) {
        let _ = self.close.send(code);
    }
}

fn base64_url(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
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

/// Whether an upgrade may go ahead: it asks for the subprotocol, and its `Origin`, if any, is
/// the app's ([`APP_ORIGIN`]) or one the configuration allows.
fn admit(request: &Request, origins: &[String]) -> Result<(), (StatusCode, &'static str)> {
    let asks = request
        .headers()
        .get_all("Sec-WebSocket-Protocol")
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .any(|protocol| protocol.trim() == SUBPROTOCOL);
    if !asks {
        return Err((
            StatusCode::BAD_REQUEST,
            "ask for the weave-host subprotocol",
        ));
    }
    match request.headers().get("Origin") {
        None => Ok(()),
        Some(origin) => {
            let origin = origin.to_str().unwrap_or_default();
            if origin == APP_ORIGIN || origins.iter().any(|allowed| allowed == origin) {
                Ok(())
            } else {
                Err((
                    StatusCode::FORBIDDEN,
                    "connections from this origin aren't allowed",
                ))
            }
        }
    }
}

fn refusal(status: StatusCode, why: &str) -> ErrorResponse {
    let mut response = ErrorResponse::new(Some(why.to_owned()));
    *response.status_mut() = status;
    response
}

async fn connection(shared: Arc<Shared>, stream: TcpStream, config: Arc<RemoteConfig>) {
    // tungstenite's upgrade callback returns its HTTP response as the error, unboxed.
    #[allow(clippy::result_large_err)]
    let callback = |request: &Request, mut response: Response| match admit(request, &config.origins)
    {
        Ok(()) => {
            response.headers_mut().insert(
                "Sec-WebSocket-Protocol",
                HeaderValue::from_static(SUBPROTOCOL),
            );
            Ok(response)
        }
        Err((status, why)) => {
            tracing::info!(why, "refused a WebSocket upgrade");
            Err(refusal(status, why))
        }
    };
    let limits = WebSocketConfig::default()
        .max_message_size(Some(MAX_MESSAGE))
        .max_frame_size(Some(MAX_MESSAGE));
    let socket =
        match tokio_tungstenite::accept_hdr_async_with_config(stream, callback, Some(limits)).await
        {
            Ok(socket) => socket,
            Err(error) => {
                tracing::debug!(%error, "a WebSocket upgrade failed");
                return;
            }
        };
    let (sink, stream) = socket.split();
    let (close, close_rx) = mpsc::unbounded_channel();
    let link = Arc::new(Link {
        close,
        close_after_next: AtomicU16::new(0),
        challenge: Mutex::new(None),
        last_pong_ms: AtomicU64::new(now_ms()),
        proved: AtomicBool::new(false),
    });
    let deadline = {
        let link = Arc::clone(&link);
        let after = config.hello_deadline;
        tokio::spawn(async move {
            tokio::time::sleep(after).await;
            if !link.proved.load(Ordering::SeqCst) {
                tracing::info!("closed a WebSocket client that proved no device in time");
                link.close(CLOSE_UNAUTHENTICATED);
            }
        })
    };
    let (data, data_rx) = mpsc::unbounded_channel();
    let queued = Arc::new(AtomicUsize::new(0));
    let done = CancellationToken::new();
    let writer = tokio::spawn(write(
        sink,
        data_rx,
        close_rx,
        Arc::clone(&queued),
        Arc::clone(&link),
        done.clone(),
        config.ping_interval,
    ));
    let incoming = {
        let link = Arc::clone(&link);
        stream
            .take_until(done.clone().cancelled_owned())
            .filter_map(move |message| {
                std::future::ready(match message {
                    Ok(Message::Text(text)) => Some(Ok(text.to_string())),
                    Ok(Message::Pong(_)) => {
                        link.last_pong_ms.store(now_ms(), Ordering::SeqCst);
                        None
                    }
                    Ok(Message::Binary(_)) => Some(Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "the Host protocol is sent in text frames",
                    ))),
                    Ok(Message::Ping(_) | Message::Close(_) | Message::Frame(_)) => None,
                    Err(error) => Some(Err(io::Error::other(error))),
                })
            })
    };
    let outgoing = Outgoing {
        data: Some(data),
        queued,
        limit: config.behind_limit,
        link: Arc::clone(&link),
    };
    let transport = Lines::new(outgoing, incoming);
    if let Err(error) = crate::client::serve_remote(shared, transport, Arc::clone(&link)).await {
        tracing::debug!(%error, "WebSocket client connection ended");
    }
    deadline.abort();
    // The writer may be stuck on a peer that's gone; closing doesn't wait for it long.
    link.close(u16::from(CloseCode::Normal));
    let _ = writer.await;
}

/// What the client connection sends, counted until the writer has sent it.
struct Outgoing {
    data: Option<mpsc::UnboundedSender<String>>,
    queued: Arc<AtomicUsize>,
    limit: usize,
    link: Arc<Link>,
}

impl futures::Sink<String> for Outgoing {
    type Error = io::Error;

    fn poll_ready(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Result<(), io::Error>> {
        Poll::Ready(Ok(()))
    }

    fn start_send(self: Pin<&mut Self>, line: String) -> Result<(), io::Error> {
        let this = self.get_mut();
        let Some(data) = &this.data else {
            return Err(io::ErrorKind::BrokenPipe.into());
        };
        let waiting = this.queued.fetch_add(line.len(), Ordering::SeqCst) + line.len();
        if waiting > this.limit {
            this.link.close(CLOSE_BEHIND);
            this.data = None;
            return Err(io::Error::other("the client fell behind"));
        }
        data.send(line)
            .map_err(|_| io::Error::from(io::ErrorKind::BrokenPipe))
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Result<(), io::Error>> {
        Poll::Ready(Ok(()))
    }

    fn poll_close(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Result<(), io::Error>> {
        self.get_mut().data = None;
        Poll::Ready(Ok(()))
    }
}

type Sink = SplitSink<WebSocketStream<TcpStream>, Message>;

/// What happened to one frame.
enum Sent {
    Done,
    Failed,
    /// Asked to close with this code before it had gone.
    Close(u16),
}

/// Send `message`, unless asked to close first.
async fn send(sink: &mut Sink, message: Message, close: &mut mpsc::UnboundedReceiver<u16>) -> Sent {
    tokio::select! {
        biased;
        code = close.recv() => Sent::Close(code.unwrap_or(u16::from(CloseCode::Normal))),
        result = sink.send(message) => if result.is_ok() { Sent::Done } else { Sent::Failed },
    }
}

/// Send what the client connection queues, pings, and the close frame.
async fn write(
    mut sink: Sink,
    mut data: mpsc::UnboundedReceiver<String>,
    mut close: mpsc::UnboundedReceiver<u16>,
    queued: Arc<AtomicUsize>,
    link: Arc<Link>,
    done: CancellationToken,
    ping_interval: Duration,
) {
    let mut pings =
        tokio::time::interval_at(tokio::time::Instant::now() + ping_interval, ping_interval);
    let mut pinged_at: Option<Timestamp> = None;
    let code = loop {
        tokio::select! {
            biased;
            code = close.recv() => break code,
            line = data.recv() => {
                let Some(line) = line else {
                    break Some(u16::from(CloseCode::Normal));
                };
                let length = line.len();
                match send(&mut sink, Message::text(line), &mut close).await {
                    Sent::Done => {}
                    Sent::Failed => break None,
                    Sent::Close(code) => break Some(code),
                }
                queued.fetch_sub(length, Ordering::SeqCst);
                match link.close_after_next.swap(0, Ordering::SeqCst) {
                    0 => {}
                    code => break Some(code),
                }
            }
            _ = pings.tick() => {
                if let Some(sent) = pinged_at
                    && link.last_pong_ms.load(Ordering::SeqCst) < sent
                {
                    tracing::debug!("a WebSocket client stopped answering pings");
                    break None;
                }
                pinged_at = Some(now_ms());
                match send(&mut sink, Message::Ping(Vec::new().into()), &mut close).await {
                    Sent::Done => {}
                    Sent::Failed => break None,
                    Sent::Close(code) => break Some(code),
                }
            }
        }
    };
    if let Some(code) = code {
        let frame = CloseFrame {
            code: CloseCode::from(code),
            reason: reason(code).into(),
        };
        let _ = tokio::time::timeout(CLOSE_GRACE, sink.send(Message::Close(Some(frame)))).await;
    }
    let _ = tokio::time::timeout(CLOSE_GRACE, sink.close()).await;
    done.cancel();
}

fn reason(code: u16) -> &'static str {
    use weave_host_protocol::websocket::CLOSE_REVOKED;
    match code {
        CLOSE_REVOKED => "the device was revoked",
        CLOSE_BEHIND => "fell behind; attach again after your position",
        CLOSE_UNAUTHENTICATED => "not authenticated",
        _ => "",
    }
}

#[cfg(test)]
mod tests {
    use futures::Sink as _;
    use pretty_assertions::assert_eq;

    use super::*;

    fn link() -> (Arc<Link>, mpsc::UnboundedReceiver<u16>) {
        let (close, close_rx) = mpsc::unbounded_channel();
        let link = Arc::new(Link {
            close,
            close_after_next: AtomicU16::new(0),
            challenge: Mutex::new(None),
            last_pong_ms: AtomicU64::new(0),
            proved: AtomicBool::new(false),
        });
        (link, close_rx)
    }

    #[test]
    fn a_challenge_is_good_once_and_not_after_it_expires() {
        let (link, _) = link();
        let (nonce, _) = link.challenge();
        assert_eq!(link.take_challenge(), Some(nonce));
        assert_eq!(link.take_challenge(), None);
        link.challenge();
        *lock(&link.challenge) = Some(("old".to_owned(), now_ms() - 1));
        assert_eq!(link.take_challenge(), None);
    }

    #[test]
    fn a_client_with_too_much_waiting_is_closed_as_fallen_behind() {
        let (link, mut close) = link();
        let (data, mut data_rx) = mpsc::unbounded_channel();
        let mut outgoing = Outgoing {
            data: Some(data),
            queued: Arc::new(AtomicUsize::new(0)),
            limit: 10,
            link,
        };
        let mut outgoing = Pin::new(&mut outgoing);
        assert!(outgoing.as_mut().start_send("123456".to_owned()).is_ok());
        assert!(outgoing.as_mut().start_send("123456".to_owned()).is_err());
        assert_eq!(close.try_recv().ok(), Some(CLOSE_BEHIND));
        assert_eq!(data_rx.try_recv().ok().as_deref(), Some("123456"));
        assert!(
            outgoing.as_mut().start_send("1".to_owned()).is_err(),
            "and stays closed"
        );
    }
}
