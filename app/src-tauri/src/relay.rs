//! The core relays each connection it opened to the page (ADR 0032): a Host's Unix socket, one
//! JSON-RPC message per line, or a WebSocket to the Dispatcher, one per text frame, which is
//! its API or a connection it carries to a Host. The core reads nothing on it once it's the
//! page's: the page is the client of the Host protocol and of the Dispatcher's API.
//!
//! Messages that arrive together cross to the page together, so a thread's replay of thousands
//! of events crosses in a few batches rather than one call each.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use futures::FutureExt as _;
use futures::SinkExt as _;
use futures::StreamExt as _;
use serde::Serialize;
use tokio::io::AsyncBufReadExt as _;
use tokio::io::AsyncWriteExt as _;
use tokio::io::BufReader;
use tokio::net::UnixStream;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use weave_host_client::carry::Socket;

/// At most this much text crosses to the page in one batch; a single larger message crosses
/// alone.
const BATCH_BYTES: usize = 256 * 1024;

/// What a relayed connection tells the page.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Incoming {
    /// Messages, in the order they arrived.
    Messages { texts: Vec<String> },
    /// The connection ended: on a WebSocket, with its close code and reason when it had them.
    Closed {
        #[serde(skip_serializing_if = "Option::is_none")]
        code: Option<u16>,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
}

/// Where a connection's messages go: the page's channel, which says whether it's still there.
pub type Sink = Box<dyn Fn(Incoming) -> bool + Send + Sync>;

/// A connection the core opened, once it's the page's.
pub enum Pipe {
    /// A Host's Unix socket.
    Lines(UnixStream),
    /// The Dispatcher's WebSocket: its API, or a connection it carries.
    WebSocket(Box<Socket>),
}

enum Outgoing {
    Text(String),
    Close,
}

/// The connections the page has open, by id.
#[derive(Default)]
pub struct Relay {
    next: AtomicU64,
    open: Mutex<HashMap<u64, mpsc::UnboundedSender<Outgoing>>>,
}

impl Relay {
    /// Relays `pipe` to `sink` until either end closes it: its id, for [`Relay::send`] and
    /// [`Relay::close`].
    pub fn start(self: &Arc<Self>, pipe: Pipe, sink: Sink) -> u64 {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let (outgoing, rx) = mpsc::unbounded_channel();
        self.connections().insert(id, outgoing);
        let relay = Arc::clone(self);
        tokio::spawn(async move {
            let ended = match pipe {
                Pipe::Lines(stream) => lines(stream, rx, &sink).await,
                Pipe::WebSocket(socket) => websocket(*socket, rx, &sink).await,
            };
            relay.connections().remove(&id);
            // The page closed it, or isn't there to hear.
            if let Some(closed) = ended {
                sink(closed);
            }
        });
        id
    }

    /// Sends `text` on connection `id`.
    pub fn send(&self, id: u64, text: String) -> Result<(), String> {
        self.connections()
            .get(&id)
            .and_then(|outgoing| outgoing.send(Outgoing::Text(text)).ok())
            .ok_or_else(|| "the connection has ended".to_owned())
    }

    /// Closes connection `id`, if it's open. The page hears nothing more from it.
    pub fn close(&self, id: u64) {
        if let Some(outgoing) = self.connections().remove(&id) {
            let _ = outgoing.send(Outgoing::Close);
        }
    }

    /// Closes every connection, as when the page loads again.
    pub fn close_all(&self) {
        for (_, outgoing) in self.connections().drain() {
            let _ = outgoing.send(Outgoing::Close);
        }
    }

    /// How many connections are open.
    pub fn len(&self) -> usize {
        self.connections().len()
    }

    /// Whether none is.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    fn connections(
        &self,
    ) -> std::sync::MutexGuard<'_, HashMap<u64, mpsc::UnboundedSender<Outgoing>>> {
        self.open.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Relays a Unix socket: what the page should hear when it ends, none when the page closed it
/// or is gone. Reading a line isn't safe to cancel, so a task of its own reads them.
async fn lines(
    stream: UnixStream,
    mut outgoing: mpsc::UnboundedReceiver<Outgoing>,
    sink: &Sink,
) -> Option<Incoming> {
    let (reader, mut writer) = stream.into_split();
    let (batches, mut read) = mpsc::channel::<Vec<String>>(4);
    let reading = tokio::spawn(async move {
        let mut reader = BufReader::new(reader);
        loop {
            let mut texts = Vec::new();
            let mut size = 0;
            // A line, then any more already read: they cross together.
            loop {
                let mut line = String::new();
                match reader.read_line(&mut line).await {
                    Ok(0) | Err(_) => {
                        if !texts.is_empty() {
                            let _ = batches.send(texts).await;
                        }
                        return;
                    }
                    Ok(_) => push_line(&mut texts, &mut size, line),
                }
                if size >= BATCH_BYTES || !reader.buffer().contains(&b'\n') {
                    break;
                }
            }
            if !texts.is_empty() && batches.send(texts).await.is_err() {
                return;
            }
        }
    });
    let closed = || Incoming::Closed {
        code: None,
        reason: None,
    };
    let ended = loop {
        tokio::select! {
            batch = read.recv() => match batch {
                Some(texts) => {
                    if !sink(Incoming::Messages { texts }) {
                        break None;
                    }
                }
                None => break Some(closed()),
            },
            message = outgoing.recv() => match message {
                Some(Outgoing::Text(text)) => {
                    let line = format!("{text}\n");
                    if writer.write_all(line.as_bytes()).await.is_err() {
                        break Some(closed());
                    }
                }
                Some(Outgoing::Close) | None => break None,
            },
        }
    };
    reading.abort();
    let _ = writer.shutdown().await;
    ended
}

fn push_line(texts: &mut Vec<String>, size: &mut usize, line: String) {
    let text = line.trim_end_matches(['\n', '\r']);
    if text.trim().is_empty() {
        return;
    }
    *size += text.len();
    texts.push(text.to_owned());
}

/// Relays a WebSocket: what the page should hear when it ends, none when the page closed it or
/// is gone.
async fn websocket(
    socket: Socket,
    mut outgoing: mpsc::UnboundedReceiver<Outgoing>,
    sink: &Sink,
) -> Option<Incoming> {
    let (mut write, mut read) = socket.split();
    loop {
        tokio::select! {
            message = read.next() => {
                let mut texts = Vec::new();
                let mut size = 0;
                let mut ended = None;
                let mut next = message;
                loop {
                    match next {
                        Some(Ok(Message::Text(text))) => {
                            size += text.len();
                            texts.push(text.to_string());
                        }
                        Some(Ok(Message::Close(frame))) => {
                            ended = Some(Incoming::Closed {
                                code: frame.as_ref().map(|frame| u16::from(frame.code)),
                                reason: frame
                                    .map(|frame| frame.reason.to_string())
                                    .filter(|reason| !reason.is_empty()),
                            });
                            break;
                        }
                        Some(Ok(_)) => {}
                        Some(Err(_)) | None => {
                            ended = Some(Incoming::Closed { code: None, reason: None });
                            break;
                        }
                    }
                    if size >= BATCH_BYTES {
                        break;
                    }
                    // More frames already here cross with these.
                    match read.next().now_or_never() {
                        Some(more) => next = more,
                        None => break,
                    }
                }
                if !texts.is_empty() && !sink(Incoming::Messages { texts }) {
                    let _ = write.close().await;
                    return None;
                }
                if ended.is_some() {
                    return ended;
                }
            }
            message = outgoing.recv() => match message {
                Some(Outgoing::Text(text)) => {
                    if write.send(Message::text(text)).await.is_err() {
                        return Some(Incoming::Closed { code: None, reason: None });
                    }
                }
                Some(Outgoing::Close) | None => {
                    let _ = write
                        .send(Message::Close(Some(CloseFrame {
                            code: CloseCode::Normal,
                            reason: "".into(),
                        })))
                        .await;
                    let _ = write.close().await;
                    return None;
                }
            },
        }
    }
}
