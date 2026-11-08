//! A terminal's stream (spec, "The terminal stream"): a WebSocket of its own, with subprotocol
//! `weave-terminal`, on the Host's terminal socket for local clients ([`serve_local`]), or on a
//! connection the Dispatcher carries (WVE-195), which comes over a connection the Host opened to
//! it, for the device the Dispatcher named, whose ticket it must be; the Dispatcher closes it
//! when it revokes the device. The Host listens for no other (WVE-197).
//!
//! The client's first text frame names a ticket `terminals/attach` gave its device; the Host
//! takes a connection of its own to the terminal's owner and attaches, with a snapshot for a
//! client of the owner's codec and the formatter's VT for another. From then on the owner's
//! restore and output frames reach the client unchanged, read from the owner only as fast as
//! the client takes them, so a slow client falls behind in the owner, which resynchronizes it.
//! Input goes the other way, and the size follows the device that last typed. The size reaches
//! the client in order with the output, as the owner took it. Clipboard writes go to that device
//! alone; bells, notifications and progress to every stream.

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use futures::SinkExt as _;
use futures::StreamExt as _;
use serde_json::Value;
use serde_json::json;
use tokio::io::AsyncRead;
use tokio::io::AsyncWrite;
use tokio::net::UnixListener;
use tokio::net::UnixStream;
use tokio::sync::broadcast;
use tokio::sync::mpsc;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message as Frame;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use weave_host_protocol::terminals::Terminal;
use weave_host_protocol::terminals::TerminalSize;
use weave_host_protocol::terminals::stream::CLOSE_EXITED;
use weave_host_protocol::terminals::stream::CLOSE_TICKET;
use weave_host_protocol::terminals::stream::ClientMessage;
use weave_host_protocol::terminals::stream::INPUT;
use weave_host_protocol::terminals::stream::Message;
use weave_host_protocol::terminals::stream::OUTPUT;
use weave_host_protocol::terminals::stream::Open;
use weave_host_protocol::terminals::stream::Opened;
use weave_host_protocol::terminals::stream::RESTORE;
use weave_host_protocol::terminals::stream::Restore;
use weave_host_protocol::terminals::stream::SUBPROTOCOL;
use weave_remote::websocket::RemoteConfig;

use super::Control;
use super::Incoming;
use super::Terminals;
use crate::Shared;

/// What a stream's WebSocket runs over: a Unix connection on the terminal socket, or one the
/// Host opened to the Dispatcher, over TCP or its socket.
pub(crate) trait Transport: AsyncRead + AsyncWrite + Unpin + Send + 'static {}

impl<T: AsyncRead + AsyncWrite + Unpin + Send + 'static> Transport for T {}

/// Accepts local clients' streams on `listener`, the Host's terminal socket, until the Host
/// stops: the same WebSocket as the Dispatcher carries, from peers of the Host's own user only.
pub(crate) async fn serve_local(shared: Arc<Shared>, listener: UnixListener) {
    let owner = crate::socket::owner(&listener);
    let config = Arc::new(RemoteConfig::default());
    let mut stop = shared.stop.subscribe();
    loop {
        tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => {
                    if !matches!(crate::socket::peer(&stream, owner), crate::socket::Peer::Owner) {
                        tracing::warn!("refused a terminal stream from another user");
                        continue;
                    }
                    let shared = Arc::clone(&shared);
                    let config = Arc::clone(&config);
                    tokio::spawn(async move { local(shared, stream, config).await });
                }
                Err(error) => tracing::warn!(%error, "accepting a terminal stream failed"),
            },
            changed = stop.changed() => {
                if changed.is_err() || *stop.borrow() {
                    break;
                }
            }
        }
    }
}

/// One local client's stream: the upgrade, which must ask for `weave-terminal`, then [`serve`].
async fn local(shared: Arc<Shared>, stream: UnixStream, config: Arc<RemoteConfig>) {
    // tungstenite's upgrade callback returns its HTTP response as the error, unboxed.
    #[allow(clippy::result_large_err)]
    let callback =
        |request: &tokio_tungstenite::tungstenite::handshake::server::Request,
         mut response: tokio_tungstenite::tungstenite::handshake::server::Response| {
            let asked = request
                .headers()
                .get_all("Sec-WebSocket-Protocol")
                .iter()
                .filter_map(|value| value.to_str().ok())
                .flat_map(|value| value.split(','))
                .any(|protocol| protocol.trim() == SUBPROTOCOL);
            if !asked {
                let mut refusal =
                    tokio_tungstenite::tungstenite::handshake::server::ErrorResponse::new(Some(
                        format!("ask for the {SUBPROTOCOL} subprotocol"),
                    ));
                *refusal.status_mut() =
                    tokio_tungstenite::tungstenite::http::StatusCode::BAD_REQUEST;
                return Err(refusal);
            }
            response.headers_mut().insert(
                "Sec-WebSocket-Protocol",
                tokio_tungstenite::tungstenite::http::HeaderValue::from_static(SUBPROTOCOL),
            );
            Ok(response)
        };
    match tokio_tungstenite::accept_hdr_async(stream, callback).await {
        Ok(socket) => serve(shared, socket, config, None).await,
        Err(error) => tracing::debug!(%error, "a local terminal stream's upgrade failed"),
    }
}

/// Serves one terminal stream until either end closes it. `carried` is the device a stream the
/// Dispatcher carries is for, which its ticket must be.
pub(crate) async fn serve<T: Transport>(
    shared: Arc<Shared>,
    mut socket: WebSocketStream<T>,
    config: Arc<RemoteConfig>,
    carried: Option<String>,
) {
    let Some(terminals) = shared.terminals.clone() else {
        close(&mut socket, CLOSE_TICKET, "this Host has no terminals").await;
        return;
    };
    terminals.ready().await;
    let open = match tokio::time::timeout(config.hello_deadline, first_open(&mut socket)).await {
        Ok(Some(open)) => open,
        _ => {
            close(&mut socket, CLOSE_TICKET, "say which ticket first").await;
            return;
        }
    };
    let Some(ticket) = terminals.take_ticket(&open.ticket) else {
        close(&mut socket, CLOSE_TICKET, "the ticket isn't good").await;
        return;
    };
    if let Some(carried) = &carried
        && ticket.device.as_ref() != Some(carried)
    {
        close(&mut socket, CLOSE_TICKET, "the ticket is another device's").await;
        return;
    }
    let id = ticket.terminal;
    let restore = if terminals.codec(&id).as_deref() == Some(open.codec.as_str()) {
        Restore::Snapshot
    } else {
        Restore::Vt
    };

    // The stream joins, and sizes the terminal if it's to, before it attaches, so the restore is
    // made at the size it opens with. Later sizes come in order with the output.
    let stream = shared.next_client.fetch_add(1, Ordering::Relaxed);
    if let Some(size) = terminals.join(&id, stream, open.size)
        && let Err(error) = terminals.resize(&id, size).await
    {
        tracing::debug!(%error, "couldn't size a terminal for its first stream");
    }
    let updates = terminals.updates();
    let attached = match terminals.connect(&id).await {
        Ok((control, incoming)) => control
            .call(
                "attach",
                json!({"restore": restore_name(restore), "history": open.history}),
            )
            .await
            .map(|answer| (control, incoming, answer)),
        Err(error) => Err(error),
    };
    // The terminal as the restore has it.
    let attached = attached.and_then(|(control, incoming, answer)| {
        let terminal =
            super::describe(&answer["terminal"]).map_or_else(|| terminals.get(&id), Ok)?;
        let opened = Opened {
            terminal,
            restore,
            restore_bytes: answer["snapshot_bytes"].as_u64().unwrap_or_default(),
        };
        Ok((control, incoming, opened))
    });
    let (control, incoming, opened) = match attached {
        Ok(attached) => attached,
        Err(error) => {
            tracing::info!(%error, "a terminal stream couldn't attach");
            terminals.leave(&id, stream);
            close(&mut socket, CLOSE_EXITED, "the terminal ended").await;
            return;
        }
    };

    let text = serde_json::to_string(&opened).unwrap_or_default();
    let relay = if socket.send(Frame::text(text)).await.is_ok() {
        let link = Link {
            terminals: &terminals,
            id: &id,
            stream,
            control: &control,
            restore,
        };
        link.relay(socket, incoming, updates, config.ping_interval)
            .await
    } else {
        None
    };
    if let Some(code) = relay {
        tracing::debug!(code, "a terminal stream closed");
    }
    terminals.leave(&id, stream);
}

fn restore_name(restore: Restore) -> &'static str {
    match restore {
        Restore::Snapshot => "snapshot",
        Restore::Vt => "vt",
    }
}

/// The client's first text frame, if it's an [`Open`].
async fn first_open<T: Transport>(socket: &mut WebSocketStream<T>) -> Option<Open> {
    while let Some(frame) = socket.next().await {
        match frame.ok()? {
            Frame::Text(text) => return serde_json::from_str(&text).ok(),
            Frame::Ping(_) | Frame::Pong(_) => {}
            _ => return None,
        }
    }
    None
}

async fn close<T: Transport>(socket: &mut WebSocketStream<T>, code: u16, reason: &str) {
    let frame = CloseFrame {
        code: CloseCode::from(code),
        reason: reason.to_owned().into(),
    };
    let _ = tokio::time::timeout(
        Duration::from_secs(5),
        socket.send(Frame::Close(Some(frame))),
    )
    .await;
}

/// One stream's end of its terminal.
struct Link<'a> {
    terminals: &'a Arc<Terminals>,
    id: &'a str,
    stream: u64,
    control: &'a Control,
    restore: Restore,
}

impl Link<'_> {
    /// Relays until either end closes; the close code sent, if any.
    async fn relay<T: Transport>(
        &self,
        socket: WebSocketStream<T>,
        mut incoming: mpsc::Receiver<Incoming>,
        mut updates: broadcast::Receiver<Terminal>,
        ping_interval: Duration,
    ) -> Option<u16> {
        let (mut sink, mut frames) = socket.split();
        let mut pings =
            tokio::time::interval_at(tokio::time::Instant::now() + ping_interval, ping_interval);
        let mut answered = true;
        let code = loop {
            tokio::select! {
                message = incoming.recv() => {
                    let Some(message) = message else { break Some(CLOSE_EXITED) };
                    let (frame, then_close) = self.frame_for(message);
                    if let Some(frame) = frame
                        && sink.send(frame).await.is_err()
                    {
                        break None;
                    }
                    if then_close {
                        break Some(CLOSE_EXITED);
                    }
                }
                update = updates.recv() => match update {
                    Ok(terminal) if terminal.id == self.id => {
                        let text = serde_json::to_string(&Message::Updated(Box::new(terminal)))
                            .unwrap_or_default();
                        if sink.send(Frame::text(text)).await.is_err() {
                            break None;
                        }
                    }
                    Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => break None,
                },
                frame = frames.next() => match frame {
                    Some(Ok(Frame::Binary(bytes))) => self.input(&bytes).await,
                    Some(Ok(Frame::Text(text))) => self.message(&text).await,
                    Some(Ok(Frame::Pong(_))) => answered = true,
                    Some(Ok(Frame::Ping(_) | Frame::Frame(_))) => {}
                    Some(Ok(Frame::Close(_)) | Err(_)) | None => break None,
                },
                _ = pings.tick() => {
                    if !answered {
                        break None;
                    }
                    answered = false;
                    if sink.send(Frame::Ping(Vec::new().into())).await.is_err() {
                        break None;
                    }
                }
            }
        };
        if let Some(code) = code {
            let frame = CloseFrame {
                code: CloseCode::from(code),
                reason: "".into(),
            };
            let _ =
                tokio::time::timeout(Duration::from_secs(5), sink.send(Frame::Close(Some(frame))))
                    .await;
        }
        let _ = tokio::time::timeout(Duration::from_secs(5), sink.close()).await;
        code
    }

    /// What the client is sent for something the owner sent, and whether the stream ends after.
    fn frame_for(&self, message: Incoming) -> (Option<Frame>, bool) {
        match message {
            Incoming::Restore(bytes) => (Some(binary(RESTORE, &bytes)), false),
            Incoming::Output(bytes) => (Some(binary(OUTPUT, &bytes)), false),
            Incoming::Answer { .. } => (None, false),
            Incoming::Event { kind, payload } => {
                let message = match kind.as_str() {
                    "bell" => Some(Message::Bell {}),
                    "desktop_notification" => Some(Message::Notification {
                        title: text(&payload, "title"),
                        body: text(&payload, "body"),
                    }),
                    "progress_report" => Some(Message::Progress {
                        state: text(&payload, "state"),
                        progress: payload["progress"]
                            .as_u64()
                            .and_then(|progress| u8::try_from(progress).ok()),
                    }),
                    "clipboard_written" if self.terminals.is_last(self.id, self.stream) => {
                        Some(Message::Clipboard {
                            text: text(&payload, "text"),
                        })
                    }
                    "resync" => Some(Message::Resync {
                        restore: self.restore,
                        restore_bytes: payload["snapshot_bytes"].as_u64().unwrap_or_default(),
                        size: size(&payload["size"])
                            .or_else(|| {
                                self.terminals
                                    .get(self.id)
                                    .ok()
                                    .map(|terminal| terminal.size)
                            })
                            .unwrap_or(super::DEFAULT_SIZE),
                    }),
                    "size_changed" => size(&payload).map(Message::Resized),
                    "child_exited" => {
                        let exit_code = payload["exit_code"]
                            .as_i64()
                            .and_then(|code| i32::try_from(code).ok())
                            .unwrap_or_default();
                        let text = serde_json::to_string(&Message::Exited { exit_code })
                            .unwrap_or_default();
                        return (Some(Frame::text(text)), true);
                    }
                    _ => None,
                };
                let frame = message.map(|message| {
                    Frame::text(serde_json::to_string(&message).unwrap_or_default())
                });
                (frame, false)
            }
        }
    }

    /// Input from the client; once it types, its device sets the terminal's size.
    async fn input(&self, bytes: &[u8]) {
        let Some((&INPUT, input)) = bytes.split_first() else {
            return;
        };
        if let Some(size) = self.terminals.typed(self.id, self.stream) {
            let _ = self.terminals.resize(self.id, size).await;
        }
        let _ = self.control.input(input.to_vec()).await;
    }

    async fn message(&self, text: &str) {
        let size = match serde_json::from_str::<ClientMessage>(text) {
            Ok(ClientMessage::Resize(size)) => size,
            Ok(ClientMessage::Resync {}) => {
                if let Err(error) = self.control.call("resync", json!({})).await {
                    tracing::debug!(%error, "the terminal's owner sent no fresh restore");
                }
                return;
            }
            Err(_) => return,
        };
        let size = TerminalSize {
            cols: size.cols.max(2),
            rows: size.rows.max(2),
        };
        if self.terminals.resized(self.id, self.stream, size) {
            let _ = self.terminals.resize(self.id, size).await;
        }
    }
}

fn binary(kind: u8, payload: &[u8]) -> Frame {
    let mut bytes = Vec::with_capacity(payload.len() + 1);
    bytes.push(kind);
    bytes.extend_from_slice(payload);
    Frame::binary(bytes)
}

fn size(payload: &Value) -> Option<TerminalSize> {
    Some(TerminalSize {
        cols: u16::try_from(payload["cols"].as_u64()?).ok()?,
        rows: u16::try_from(payload["rows"].as_u64()?).ok()?,
    })
}

fn text(payload: &Value, key: &str) -> String {
    payload[key].as_str().unwrap_or_default().to_owned()
}
