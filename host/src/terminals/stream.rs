//! A terminal's stream (spec, "The terminal stream"): a WebSocket of its own on the Host's
//! remote listener, with subprotocol `weave-terminal`, which the listener hands here.
//!
//! The client's first text frame names a ticket `terminals/attach` gave its device; the Host
//! takes a connection of its own to the terminal's owner and attaches, with a snapshot for a
//! client of the owner's codec and the formatter's VT for another. From then on the owner's
//! restore and output frames reach the client unchanged, read from the owner only as fast as
//! the client takes them, so a slow client falls behind in the owner, which resynchronizes it.
//! Input goes the other way, and the size follows the device that last typed. Clipboard writes
//! go to that device alone; bells, notifications and progress to every stream.

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use futures::SinkExt as _;
use futures::StreamExt as _;
use serde_json::Value;
use serde_json::json;
use tokio::net::TcpStream;
use tokio::sync::broadcast;
use tokio::sync::mpsc;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message as Frame;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
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

use super::Control;
use super::Incoming;
use super::Terminals;
use crate::Shared;
use crate::devices::Closer;
use crate::websocket::RemoteConfig;

type Socket = WebSocketStream<TcpStream>;

/// Closes a stream from elsewhere, as revoking its device does.
struct StreamCloser(mpsc::UnboundedSender<u16>);

impl Closer for StreamCloser {
    fn close(&self, code: u16) {
        let _ = self.0.send(code);
    }
}

/// Serves one terminal stream until either end closes it.
pub(crate) async fn serve(shared: Arc<Shared>, mut socket: Socket, config: Arc<RemoteConfig>) {
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
    let id = ticket.terminal;
    let restore = if terminals.codec(&id).as_deref() == Some(open.codec.as_str()) {
        Restore::Snapshot
    } else {
        Restore::Vt
    };
    let attached = match terminals.connect(&id).await {
        Ok((control, incoming)) => control
            .call("attach", json!({"restore": restore_name(restore)}))
            .await
            .map(|answer| (control, incoming, answer)),
        Err(error) => Err(error),
    };
    let (control, incoming, restore_bytes) = match attached {
        Ok((control, incoming, answer)) => (
            control,
            incoming,
            answer["snapshot_bytes"].as_u64().unwrap_or_default(),
        ),
        Err(error) => {
            tracing::info!(%error, "a terminal stream couldn't attach");
            close(&mut socket, CLOSE_EXITED, "the terminal ended").await;
            return;
        }
    };

    let stream = shared.next_client.fetch_add(1, Ordering::Relaxed);
    let (closer, closed) = mpsc::unbounded_channel();
    if let Some(device) = &ticket.device {
        shared
            .devices
            .connected(device, stream, Arc::new(StreamCloser(closer.clone())));
    }
    if let Some(size) = terminals.join(&id, stream, open.size)
        && let Err(error) = terminals.resize(&id, size).await
    {
        tracing::debug!(%error, "couldn't size a terminal for its first stream");
    }
    let opened = terminals.get(&id).map(|terminal| Opened {
        terminal,
        restore,
        restore_bytes,
    });
    let relay = match opened {
        Ok(opened) => {
            let text = serde_json::to_string(&opened).unwrap_or_default();
            if socket.send(Frame::text(text)).await.is_ok() {
                let link = Link {
                    terminals: &terminals,
                    id: &id,
                    stream,
                    control: &control,
                    restore,
                };
                link.relay(socket, incoming, closed, config.ping_interval)
                    .await
            } else {
                None
            }
        }
        Err(_) => {
            close(&mut socket, CLOSE_EXITED, "the terminal ended").await;
            None
        }
    };
    if let Some(code) = relay {
        tracing::debug!(code, "a terminal stream closed");
    }
    terminals.leave(&id, stream);
    if let Some(device) = &ticket.device {
        shared.devices.disconnected(device, stream);
    }
}

fn restore_name(restore: Restore) -> &'static str {
    match restore {
        Restore::Snapshot => "snapshot",
        Restore::Vt => "vt",
    }
}

/// The client's first text frame, if it's an [`Open`].
async fn first_open(socket: &mut Socket) -> Option<Open> {
    while let Some(frame) = socket.next().await {
        match frame.ok()? {
            Frame::Text(text) => return serde_json::from_str(&text).ok(),
            Frame::Ping(_) | Frame::Pong(_) => {}
            _ => return None,
        }
    }
    None
}

async fn close(socket: &mut Socket, code: u16, reason: &str) {
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
    async fn relay(
        &self,
        socket: Socket,
        mut incoming: mpsc::Receiver<Incoming>,
        mut closed: mpsc::UnboundedReceiver<u16>,
        ping_interval: Duration,
    ) -> Option<u16> {
        let (mut sink, mut frames) = socket.split();
        let mut updates = self.terminals.updates();
        let mut pings =
            tokio::time::interval_at(tokio::time::Instant::now() + ping_interval, ping_interval);
        let mut answered = true;
        let code = loop {
            tokio::select! {
                code = closed.recv() => break code,
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
                    }),
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
        let Ok(ClientMessage::Resize(size)) = serde_json::from_str::<ClientMessage>(text) else {
            return;
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

fn text(payload: &Value, key: &str) -> String {
    payload[key].as_str().unwrap_or_default().to_owned()
}
