//! Terminals' streams, for the page (ADR 0032, WVE-205). A terminal's bytes never cross Tauri's
//! IPC: the page opens a WebSocket for each terminal it draws, here, on a loopback port the core
//! listens on, and the core passes it through to the stream the Host serves: this Mac's Host's
//! on `terminals.sock`, as local clients reach it, or any other Host's through the Dispatcher,
//! which the core opens and proves the device on, as it does every connection ([`crate::core`]).
//! The page speaks the stream's protocol on it itself (`Open` with the ticket `terminals/attach`
//! gave it, then frames); the core reads none of it.
//!
//! Loopback isn't the app's alone, as a Unix socket's mode makes one: any program on this Mac,
//! and any page in a browser, can connect to the port. So the page asks the core for each stream
//! ([`Streams::offer`]) and gets an address with a key in it, random, good once and for half a
//! minute; the core takes a connection only at such an address, and from a page only when it's
//! the app's own (`Origin`). When the app's page loads again, the streams it had and the keys it
//! hadn't used go.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::time::Duration;
use std::time::Instant;

use futures::SinkExt as _;
use futures::StreamExt as _;
use tokio::io::AsyncRead;
use tokio::io::AsyncWrite;
use tokio::net::TcpListener;
use tokio::net::TcpStream;
use tokio::net::UnixStream;
use tokio::task::AbortHandle;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest as _;
use tokio_tungstenite::tungstenite::handshake::server::ErrorResponse;
use tokio_tungstenite::tungstenite::handshake::server::Request;
use tokio_tungstenite::tungstenite::handshake::server::Response;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use weave_host_client::carry;
use weave_host_protocol::dispatcher::CarriedStream;
use weave_host_protocol::terminals::stream::SUBPROTOCOL;

use crate::core::Core;
use crate::core::Failure;

/// How long the page has to open a stream it asked for.
const KEY_LIFETIME: Duration = Duration::from_secs(30);

/// The built app's page.
const APP_ORIGIN: &str = "tauri://localhost";

/// Where a stream goes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Target {
    /// This Mac's Host, on its terminal socket.
    Local,
    /// Another Host, by id, through the Dispatcher.
    Host(String),
}

struct Offered {
    target: Target,
    until: Instant,
}

/// The streams the page may open, and those it has.
pub struct Streams {
    /// Where the core listens, once it does.
    address: Mutex<Option<SocketAddr>>,
    /// Whether Vite's pages on this computer are the app's too, as under `tauri dev`.
    dev: bool,
    offered: Mutex<HashMap<String, Offered>>,
    open: Mutex<Vec<AbortHandle>>,
}

fn locked<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Streams {
    pub fn new(dev: bool) -> Self {
        Self {
            address: Mutex::new(None),
            dev,
            offered: Mutex::new(HashMap::new()),
            open: Mutex::new(Vec::new()),
        }
    }

    /// An address the page opens one WebSocket at, soon, for a stream to `target`.
    pub fn offer(&self, target: Target) -> Result<String, Failure> {
        let address = (*locked(&self.address)).ok_or_else(|| {
            Failure::new(
                "connection",
                "The app isn't listening for its terminals' streams.",
            )
        })?;
        let mut bytes = [0_u8; 32];
        getrandom::fill(&mut bytes)
            .map_err(|error| Failure::new("connection", format!("no random key: {error}")))?;
        let key: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
        let now = Instant::now();
        let mut offered = locked(&self.offered);
        offered.retain(|_, offer| offer.until > now);
        offered.insert(
            key.clone(),
            Offered {
                target,
                until: now + KEY_LIFETIME,
            },
        );
        Ok(format!("ws://{address}/{key}"))
    }

    /// Ends every stream and forgets every key, as when the page loads again.
    pub fn close_all(&self) {
        locked(&self.offered).clear();
        for stream in locked(&self.open).drain(..) {
            stream.abort();
        }
    }

    /// How many streams are open.
    pub fn len(&self) -> usize {
        let mut open = locked(&self.open);
        open.retain(|stream| !stream.is_finished());
        open.len()
    }

    /// Whether none is.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// The target a key was offered for, once.
    fn take(&self, key: &str) -> Option<Target> {
        let offer = locked(&self.offered).remove(key)?;
        (offer.until > Instant::now()).then_some(offer.target)
    }

    /// Whether a page at `origin` is the app's. A connection that names none isn't a page's.
    fn own_page(&self, origin: Option<&str>) -> bool {
        match origin {
            None => true,
            Some(APP_ORIGIN) => true,
            Some(origin) => {
                self.dev
                    && ["http://localhost", "http://127.0.0.1"].iter().any(|own| {
                        origin == *own
                            || origin
                                .strip_prefix(own)
                                .is_some_and(|rest| rest.starts_with(':'))
                    })
            }
        }
    }
}

/// Starts listening for the page's streams on a loopback port of its own. Call it once, inside
/// the runtime.
pub fn listen(core: &Arc<Core>) -> std::io::Result<SocketAddr> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    listener.set_nonblocking(true)?;
    let listener = TcpListener::from_std(listener)?;
    let address = listener.local_addr()?;
    *locked(&core.streams().address) = Some(address);
    let core = Arc::clone(core);
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            };
            let _ = stream.set_nodelay(true);
            let serving = Arc::clone(&core);
            let task = tokio::spawn(async move { serve(&serving, stream).await });
            let mut open = locked(&core.streams().open);
            open.retain(|stream| !stream.is_finished());
            open.push(task.abort_handle());
        }
    });
    Ok(address)
}

fn refuse(status: StatusCode, why: &str) -> ErrorResponse {
    let mut response = ErrorResponse::new(Some(why.to_owned()));
    *response.status_mut() = status;
    response
}

/// One connection from the page: takes it if it's at an address offered, then passes it through
/// to the stream there.
// The handshake's callback answers with tungstenite's own response.
#[allow(clippy::result_large_err)]
async fn serve(core: &Arc<Core>, stream: TcpStream) {
    let streams = core.streams();
    let mut target = None;
    let accepted =
        tokio_tungstenite::accept_hdr_async(stream, |request: &Request, mut response: Response| {
            let header = |name: &str| {
                request
                    .headers()
                    .get(name)
                    .and_then(|value| value.to_str().ok())
            };
            if !streams.own_page(header("Origin")) {
                return Err(refuse(StatusCode::FORBIDDEN, "not the app's page"));
            }
            let asked = header("Sec-WebSocket-Protocol")
                .is_some_and(|protocols| protocols.split(',').any(|one| one.trim() == SUBPROTOCOL));
            if !asked {
                return Err(refuse(StatusCode::BAD_REQUEST, "not a terminal's stream"));
            }
            let key = request.uri().path().trim_start_matches('/');
            let Some(offered) = streams.take(key) else {
                return Err(refuse(StatusCode::FORBIDDEN, "no stream was offered here"));
            };
            target = Some(offered);
            response.headers_mut().insert(
                "Sec-WebSocket-Protocol",
                HeaderValue::from_static(SUBPROTOCOL),
            );
            Ok(response)
        })
        .await;
    let (Ok(mut page), Some(target)) = (accepted, target) else {
        return;
    };
    match core.terminal_stream(&target).await {
        Ok(Upstream::Local(host)) => splice(page, *host).await,
        Ok(Upstream::Carried(host)) => splice(page, *host).await,
        Err(failure) => {
            // A close frame's reason is at most 123 bytes.
            let mut reason = failure.message;
            let mut end = reason.len().min(120);
            while !reason.is_char_boundary(end) {
                end -= 1;
            }
            reason.truncate(end);
            let _ = page
                .close(Some(CloseFrame {
                    code: CloseCode::Error,
                    reason: reason.into(),
                }))
                .await;
        }
    }
}

/// A terminal's stream as the Host serves it.
pub enum Upstream {
    Local(Box<WebSocketStream<UnixStream>>),
    Carried(Box<carry::Socket>),
}

impl Core {
    /// Opens the stream at `target`: the page's `Open` is its first frame.
    async fn terminal_stream(&self, target: &Target) -> Result<Upstream, Failure> {
        match target {
            Target::Local => {
                let socket = self.terminal_socket().ok_or_else(|| {
                    Failure::new("connection", "This Mac has no home directory for its Host.")
                })?;
                local(socket).await.map(Box::new).map(Upstream::Local)
            }
            Target::Host(host) => {
                let via = self.via()?;
                let (carried, _) =
                    carry::open(&via, self.client(), host, CarriedStream::Terminal).await?;
                match carried {
                    carry::Carried::WebSocket(socket) => Ok(Upstream::Carried(socket)),
                    carry::Carried::Socket(..) => Err(Failure::new(
                        "connection",
                        "The Dispatcher carried the stream over its socket, which the app doesn't use.",
                    )),
                }
            }
        }
    }
}

/// This Mac's Host's terminal socket, as a WebSocket: only this user's programs reach it.
async fn local(socket: PathBuf) -> Result<WebSocketStream<UnixStream>, Failure> {
    let unreachable = |error: &dyn std::fmt::Display| {
        Failure::new(
            "connection",
            format!(
                "Couldn't reach this Mac's Host's terminals at {}: {error}. Update the Host if \
                 it's older than this app.",
                socket.display()
            ),
        )
    };
    let stream = UnixStream::connect(&socket)
        .await
        .map_err(|error| unreachable(&error))?;
    let mut request = "ws://localhost/"
        .into_client_request()
        .map_err(|error| unreachable(&error))?;
    request.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        HeaderValue::from_static(SUBPROTOCOL),
    );
    let (socket, _) = tokio_tungstenite::client_async(request, stream)
        .await
        .map_err(|error| unreachable(&error))?;
    Ok(socket)
}

/// Passes every frame through, both ways, unread, until either end closes; a close goes through
/// with its code and reason, as the Host's say why a stream ended. One frame at a time each way,
/// so an end that reads slowly slows the other, and the Host sees a page that fell behind.
async fn splice<P, H>(mut page: WebSocketStream<P>, mut host: WebSocketStream<H>)
where
    P: AsyncRead + AsyncWrite + Unpin,
    H: AsyncRead + AsyncWrite + Unpin,
{
    loop {
        tokio::select! {
            message = page.next() => match message {
                Some(Ok(message @ (Message::Text(_) | Message::Binary(_)))) => {
                    if host.send(message).await.is_err() {
                        let _ = page.close(None).await;
                        return;
                    }
                }
                Some(Ok(Message::Close(frame))) => {
                    let _ = host.close(frame).await;
                    return;
                }
                // Each side answers its own pings.
                Some(Ok(_)) => {
                    if page.flush().await.is_err() {
                        let _ = host.close(None).await;
                        return;
                    }
                }
                Some(Err(_)) | None => {
                    let _ = host.close(None).await;
                    return;
                }
            },
            message = host.next() => match message {
                Some(Ok(message @ (Message::Text(_) | Message::Binary(_)))) => {
                    if page.send(message).await.is_err() {
                        let _ = host.close(None).await;
                        return;
                    }
                }
                Some(Ok(Message::Close(frame))) => {
                    let _ = page.close(frame).await;
                    return;
                }
                Some(Ok(_)) => {
                    if host.flush().await.is_err() {
                        let _ = page.close(None).await;
                        return;
                    }
                }
                Some(Err(_)) | None => {
                    let _ = page.close(None).await;
                    return;
                }
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn only_the_apps_own_pages_may_open_a_stream() {
        let built = Streams::new(false);
        assert!(built.own_page(Some("tauri://localhost")));
        assert!(built.own_page(None));
        assert!(!built.own_page(Some("http://localhost:5174")));
        assert!(!built.own_page(Some("https://example.com")));
        let dev = Streams::new(true);
        assert!(dev.own_page(Some("http://localhost:5174")));
        assert!(dev.own_page(Some("http://127.0.0.1:5174")));
        assert!(!dev.own_page(Some("http://localhost.example.com")));
        assert!(!dev.own_page(Some("https://example.com")));
    }

    #[test]
    fn a_key_is_good_once_and_goes_when_the_page_loads_again() {
        let streams = Streams::new(false);
        assert_eq!(
            streams.offer(Target::Local).map_err(|failure| failure.kind),
            Err("connection")
        );
        *locked(&streams.address) = Some(SocketAddr::from(([127, 0, 0, 1], 4000)));
        let key = |url: String| {
            url.strip_prefix("ws://127.0.0.1:4000/")
                .map(str::to_owned)
                .unwrap_or_default()
        };
        let first = key(streams
            .offer(Target::Host("h-1".to_owned()))
            .unwrap_or_default());
        assert_eq!(first.len(), 64);
        assert_eq!(streams.take(&first), Some(Target::Host("h-1".to_owned())));
        assert_eq!(streams.take(&first), None);
        assert_eq!(streams.take("nothing"), None);
        let second = key(streams.offer(Target::Local).unwrap_or_default());
        assert_ne!(second, first);
        streams.close_all();
        assert_eq!(streams.take(&second), None);
    }
}
