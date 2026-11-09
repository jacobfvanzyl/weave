//! Carrying the person's devices' connections to their Hosts (ADR 0030, WVE-195). A device asks
//! for a Host on the WebSocket, with a subprotocol of its own, by proving its key as it does at
//! `dispatcher/hello` and then naming the Host in `hosts/open`; on the Dispatcher's computer it
//! asks the same on the Dispatcher's socket, after a hello there. Over the Host's own connection
//! the Dispatcher asks `dispatcher/carry`, with a one-time token and the device; the Host opens
//! another connection to the Dispatcher and presents the token with a nonce of its own, which
//! the Dispatcher signs with its key so the Host knows whom it serves ([`Carries::expected`]);
//! then the Dispatcher answers `hosts/open` and joins the two connections ([`Carries::arrive`],
//! [`splice`]).
//!
//! From then on it passes every data frame through without reading it: the Host protocol, or a
//! terminal's stream. Each side's pings stay with that side, either side's close code is passed
//! to the other, and a side is read only as fast as the other takes what it sent, so a device
//! that falls behind falls behind in the Host, which closes it as it would any remote client.
//! On the socket a WebSocket message is one line, so it carries only the Host protocol.
//!
//! Revoking a device closes its carried connections, its end with
//! [`weave_host_protocol::websocket::CLOSE_REVOKED`] and the Host's normally; removing a Host
//! closes everything carried to it.

use std::collections::HashMap;
use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;

use agent_client_protocol::Error;
use futures::Sink;
use futures::SinkExt as _;
use futures::Stream;
use futures::StreamExt as _;
use serde_json::Value;
use serde_json::json;
use tokio::io::AsyncBufReadExt as _;
use tokio::io::AsyncRead;
use tokio::io::AsyncWrite;
use tokio::io::AsyncWriteExt as _;
use tokio::io::BufReader;
use tokio::net::unix::OwnedReadHalf;
use tokio::net::unix::OwnedWriteHalf;
use tokio::sync::mpsc;
use tokio::sync::oneshot;
use tokio_tungstenite::tungstenite;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use weave_host_protocol::Timestamp;
use weave_host_protocol::devices::DeviceInfo;
use weave_host_protocol::dispatcher::CARRY_FEATURE;
use weave_host_protocol::dispatcher::CarriedStream;
use weave_host_protocol::dispatcher::CarryRequest;
use weave_host_protocol::dispatcher::DISPATCHER_PROTOCOL;
use weave_host_protocol::dispatcher::DispatcherChallenge;
use weave_host_protocol::dispatcher::DispatcherHello;
use weave_host_protocol::dispatcher::DispatcherHelloRequest;
use weave_host_protocol::dispatcher::HostUnavailable;
use weave_host_protocol::dispatcher::LOCAL_DEVICE;
use weave_host_protocol::dispatcher::OpenHostRequest;
use weave_host_protocol::dispatcher::OpenedHost;
use weave_host_protocol::dispatcher::Reachability;
use weave_host_protocol::errors;
use weave_host_protocol::hello::Auth;
use weave_host_protocol::websocket::CLOSE_UNAUTHENTICATED;
use weave_remote::pairing::Closer;
use weave_remote::pairing::random_id;
use weave_remote::preamble;
use weave_remote::websocket::RemoteConfig;
use weave_remote::websocket::WebSocketStream;

use crate::Shared;
use crate::lock;
use crate::now_ms;

/// How long a device has to sign its challenge.
const CHALLENGE_LIFETIME_MS: Timestamp = 30 * 1000;
/// How many frames may wait for a side beyond what's being written to it: the rest wait in the
/// other side, which isn't read meanwhile.
const BUFFER: usize = 16;
/// How long closing a side waits for what's being written and for the close frame.
const CLOSE_GRACE: Duration = Duration::from_secs(5);

/// The tokens Hosts present to join their ends, and the connections carried now.
#[derive(Default)]
pub(crate) struct Carries {
    pending: Mutex<HashMap<String, Pending>>,
    live: Mutex<HashMap<u64, Live>>,
}

/// A token given to a Host, until it presents it.
struct Pending {
    /// The Host it was given to.
    host_id: String,
    expires_at: Timestamp,
    arrived: oneshot::Sender<Side>,
}

/// A connection carried now, to `host_id`.
struct Live {
    host_id: String,
    closer: Arc<Closing>,
}

impl Carries {
    /// The Host presented `token` on a connection it opened: give the waiting device that
    /// connection's end. Whether the token was good.
    pub(crate) fn arrive(&self, token: &str, side: Side) -> bool {
        let pending = lock(&self.pending).remove(token);
        match pending {
            Some(pending) if pending.expires_at > now_ms() => pending.arrived.send(side).is_ok(),
            _ => false,
        }
    }

    /// The Host `token` was given to, while it's waiting for that Host: checked before a Host
    /// presenting it is answered, with the Dispatcher's signature for that Host.
    pub(crate) fn expected(&self, token: &str) -> Option<String> {
        lock(&self.pending)
            .get(token)
            .filter(|pending| pending.expires_at > now_ms())
            .map(|pending| pending.host_id.clone())
    }

    /// Close everything carried to `host_id`, as removing the Host does.
    pub(crate) fn close_host(&self, host_id: &str) {
        let closers: Vec<Arc<Closing>> = lock(&self.live)
            .values()
            .filter(|live| live.host_id == host_id)
            .map(|live| Arc::clone(&live.closer))
            .collect();
        for closer in closers {
            closer.close(u16::from(CloseCode::Normal));
        }
    }

    /// A new token for `host_id`'s end, good for `lifetime`, and where its end arrives.
    fn expect(&self, host_id: &str, lifetime: Duration) -> (String, oneshot::Receiver<Side>) {
        let token = random_id(32);
        let (arrived, end) = oneshot::channel();
        let now = now_ms();
        let lifetime_ms = Timestamp::try_from(lifetime.as_millis()).unwrap_or(Timestamp::MAX);
        let mut pending = lock(&self.pending);
        pending.retain(|_, pending| pending.expires_at > now);
        pending.insert(
            token.clone(),
            Pending {
                host_id: host_id.to_owned(),
                expires_at: now.saturating_add(lifetime_ms),
                arrived,
            },
        );
        (token, end)
    }
}

/// Closes a carried connection from elsewhere, as revoking its device does: the device's end
/// with the code given, and the Host's normally.
struct Closing(mpsc::UnboundedSender<u16>);

impl Closer for Closing {
    fn close(&self, code: u16) {
        let _ = self.0.send(code);
    }
}

type Frames = Pin<Box<dyn Stream<Item = Result<Message, tungstenite::Error>> + Send>>;
type FrameSink = Pin<Box<dyn Sink<Message, Error = tungstenite::Error> + Send>>;

/// One end of a carried connection: a WebSocket, or the lines of the Dispatcher's socket.
pub(crate) struct Side {
    sink: FrameSink,
    frames: Frames,
    /// Pings and close codes are the WebSocket's; a socket's lines have neither.
    websocket: bool,
}

impl Side {
    pub(crate) fn websocket<S>(socket: WebSocketStream<S>) -> Self
    where
        S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        let (sink, frames) = socket.split();
        Self {
            sink: Box::pin(sink),
            frames: Box::pin(frames),
            websocket: true,
        }
    }

    /// A socket connection whose every line is one text frame. Binary frames can't be carried
    /// on it; the end of the socket is its close.
    fn lines(reader: BufReader<OwnedReadHalf>, writer: OwnedWriteHalf) -> Self {
        let frames = futures::stream::unfold(reader.lines(), |mut lines| async move {
            match lines.next_line().await {
                Ok(Some(line)) => Some((Ok(Message::text(line)), lines)),
                Ok(None) => Some((Ok(Message::Close(None)), lines)),
                Err(error) => Some((Err(tungstenite::Error::Io(error)), lines)),
            }
        });
        let sink = futures::sink::unfold(writer, |mut writer, message: Message| async move {
            match message {
                Message::Text(text) => {
                    writer.write_all(text.as_bytes()).await?;
                    writer.write_all(b"\n").await?;
                }
                Message::Close(_) => writer.shutdown().await?,
                Message::Binary(_) => {
                    return Err(tungstenite::Error::Io(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "the Dispatcher's socket carries text only",
                    )));
                }
                Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => {}
            }
            Ok(writer)
        });
        Self {
            sink: Box::pin(sink),
            frames: Box::pin(frames),
            websocket: false,
        }
    }
}

/// A device's connection on the WebSocket with the carry subprotocol: its challenge, hello and
/// `hosts/open`, then the Host's end joined to it until either closes.
pub(crate) async fn device<S>(
    shared: Arc<Shared>,
    mut socket: WebSocketStream<S>,
    config: Arc<RemoteConfig>,
) where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let asked = match tokio::time::timeout(config.hello_deadline, prove(&shared, &mut socket)).await
    {
        Ok(Some(asked)) => asked,
        Ok(None) => return,
        Err(_) => {
            tracing::info!("closed a device's carried connection that proved nothing in time");
            preamble::close(&mut socket, CLOSE_UNAUTHENTICATED).await;
            return;
        }
    };
    let (device, id, request) = asked;
    let host = match open(&shared, &device, &request).await {
        Ok(host) => host,
        Err(error) => {
            preamble::answer::<_, ()>(&mut socket, id, Err(error)).await;
            preamble::close(&mut socket, u16::from(CloseCode::Normal)).await;
            return;
        }
    };
    let (opened, end) = host;
    if !preamble::answer(&mut socket, id, Ok(opened.clone())).await {
        return;
    }
    carry(
        &shared,
        Some(device),
        opened,
        Side::websocket(socket),
        end,
        config.ping_interval,
    )
    .await;
}

/// The device's challenge and hello, proving its key as `dispatcher/hello` does on the API's
/// WebSocket, and its `hosts/open`: the device, the request's id and what it asks. `None` once
/// a refusal has been answered and the connection closed.
async fn prove<S: AsyncRead + AsyncWrite + Unpin>(
    shared: &Shared,
    socket: &mut WebSocketStream<S>,
) -> Option<(DeviceInfo, Value, OpenHostRequest)> {
    let asked = preamble::next_request(socket).await?;
    if asked.method != "dispatcher/challenge" {
        refuse(socket, asked.id, "say dispatcher/challenge first").await;
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
    if asked.method != "dispatcher/hello" {
        refuse(socket, asked.id, "say dispatcher/hello next").await;
        return None;
    }
    let hello = asked.params::<DispatcherHelloRequest>().and_then(|hello| {
        if hello.protocol != DISPATCHER_PROTOCOL {
            return Err(crate::api::incompatible(&hello));
        }
        let device = match hello.auth {
            Some(Auth::Device {
                device_id,
                signature,
            }) if now_ms() <= expires_at => {
                shared
                    .devices
                    .verify(&shared.store, &shared.id, &device_id, &nonce, &signature)?
            }
            _ => None,
        };
        device.ok_or_else(|| errors::unauthenticated("this device couldn't be authenticated"))
    });
    let device = match hello {
        Ok(device) => device,
        Err(error) => {
            tracing::info!(why = %error.message, "refused a device's carried connection");
            preamble::answer::<_, ()>(socket, asked.id, Err(error)).await;
            preamble::close(socket, CLOSE_UNAUTHENTICATED).await;
            return None;
        }
    };
    let said = DispatcherHello {
        protocol: DISPATCHER_PROTOCOL,
        version: env!("CARGO_PKG_VERSION").to_owned(),
        id: shared.id.clone(),
        device: Some(device.clone()),
        features: crate::api::features(),
    };
    if !preamble::answer(socket, asked.id, Ok(said)).await {
        return None;
    }
    let asked = preamble::next_request(socket).await?;
    if asked.method != "hosts/open" {
        let error = Error::invalid_request().data("say hosts/open next");
        preamble::answer::<_, ()>(socket, asked.id, Err(error)).await;
        preamble::close(socket, u16::from(CloseCode::Normal)).await;
        return None;
    }
    match asked.params::<OpenHostRequest>() {
        Ok(request) => Some((device, asked.id, request)),
        Err(error) => {
            preamble::answer::<_, ()>(socket, asked.id, Err(error)).await;
            preamble::close(socket, u16::from(CloseCode::Normal)).await;
            None
        }
    }
}

async fn refuse<S: AsyncRead + AsyncWrite + Unpin>(
    socket: &mut WebSocketStream<S>,
    id: Value,
    why: &str,
) {
    preamble::answer::<_, ()>(socket, id, Err(errors::unauthenticated(why))).await;
    preamble::close(socket, CLOSE_UNAUTHENTICATED).await;
}

/// A client on the Dispatcher's computer asked `hosts/open` on its socket, request `id`, after
/// a hello there: carry its connection, whose lines are the Host protocol, to the Host it names.
pub(crate) async fn local(
    shared: Arc<Shared>,
    id: Value,
    request: Result<OpenHostRequest, Error>,
    reader: BufReader<OwnedReadHalf>,
    mut writer: OwnedWriteHalf,
) {
    let device = DeviceInfo {
        id: LOCAL_DEVICE.to_owned(),
        name: crate::computer_name(),
        service: false,
    };
    let opened = match request {
        Ok(OpenHostRequest {
            stream: CarriedStream::Terminal,
            ..
        }) => Err(crate::invalid(
            "a terminal's stream is carried on the Dispatcher's WebSocket: its socket carries \
             text only",
        )),
        Ok(request) => open(&shared, &device, &request).await,
        Err(error) => Err(error),
    };
    let answer = match &opened {
        Ok((opened, _)) => json!({"jsonrpc": "2.0", "id": id, "result": opened}),
        Err(error) => json!({"jsonrpc": "2.0", "id": id, "error": error}),
    };
    let line = format!("{answer}\n");
    if writer.write_all(line.as_bytes()).await.is_err() {
        return;
    }
    let Ok((opened, end)) = opened else {
        return;
    };
    let ping_interval = RemoteConfig::default().ping_interval;
    carry(
        &shared,
        None,
        opened,
        Side::lines(reader, writer),
        end,
        ping_interval,
    )
    .await;
}

/// Have the Host `request` names open its end of a connection for `device`: the Host, and its
/// end once it has presented the token it was given.
async fn open(
    shared: &Arc<Shared>,
    device: &DeviceInfo,
    request: &OpenHostRequest,
) -> Result<(OpenedHost, Side), Error> {
    let host = shared.resolve_host(&request.host)?;
    let handle = {
        let links = lock(&shared.links);
        links
            .get(&host.host_id)
            .map(crate::link::Link::seen)
            .filter(|seen| seen.connected)
            .and_then(|seen| seen.handle)
    };
    let Some(handle) = handle else {
        let listed = shared
            .hosts()?
            .into_iter()
            .find(|listed| listed.host_id == host.host_id);
        let (status, why) = listed.map_or_else(
            || (Reachability::Unchecked, None),
            |listed| (listed.status, listed.why),
        );
        let why = why.unwrap_or_else(|| "the Dispatcher isn't connected to it".to_owned());
        return Err(unavailable(
            status,
            format!("{} can't be reached: {why}", host.name),
        ));
    };
    if !handle.hello().features.iter().any(|f| f == CARRY_FEATURE) {
        return Err(unavailable(
            Reachability::Reachable,
            format!(
                "{} runs a weave that doesn't take devices' connections through the Dispatcher \
                 yet: update it there",
                host.name
            ),
        ));
    }
    let timeout = shared.config.reach_timeout;
    let (token, arrived) = shared.carries.expect(&host.host_id, timeout);
    let asked = handle.send(CarryRequest {
        token: token.clone(),
        device: device.clone(),
        stream: request.stream,
    });
    let waited = tokio::time::timeout(timeout, async {
        tokio::pin!(asked);
        tokio::pin!(arrived);
        let mut answered = false;
        loop {
            tokio::select! {
                end = &mut arrived => {
                    return end.map_err(|_| unavailable(
                        Reachability::Reachable,
                        format!("{} didn't open a connection for this device", host.name),
                    ));
                }
                result = &mut asked, if !answered => {
                    answered = true;
                    if let Err(error) = result {
                        return Err(unavailable(
                            Reachability::Reachable,
                            format!(
                                "{} couldn't open a connection for this device: {}",
                                host.name, error.message
                            ),
                        ));
                    }
                }
            }
        }
    })
    .await;
    lock(&shared.carries.pending).remove(&token);
    let end = waited.unwrap_or_else(|_| {
        Err(unavailable(
            Reachability::Reachable,
            format!(
                "{} didn't open a connection for this device within {} seconds",
                host.name,
                timeout.as_secs_f32()
            ),
        ))
    })?;
    tracing::info!(host = %host.host_id, device = %device.id, stream = ?request.stream, "carrying a device's connection to a Host");
    Ok((
        OpenedHost {
            host_id: host.host_id,
            name: host.name,
        },
        end,
    ))
}

fn unavailable(status: Reachability, why: String) -> Error {
    let data = HostUnavailable {
        status,
        why: why.clone(),
    };
    errors::host_unavailable(why).data(json!(data))
}

/// Carry `device`'s end and the Host's to each other until either closes, or the device is
/// revoked or the Host removed. `device` is none on the Dispatcher's socket, which nobody
/// revokes.
async fn carry(
    shared: &Arc<Shared>,
    device: Option<DeviceInfo>,
    host: OpenedHost,
    device_end: Side,
    host_end: Side,
    ping_interval: Duration,
) {
    let number = shared.next_connection.fetch_add(1, Ordering::Relaxed);
    let (closing, closed) = mpsc::unbounded_channel();
    let closer = Arc::new(Closing(closing));
    if let Some(device) = &device {
        shared
            .devices
            .connected(&device.id, number, Arc::clone(&closer) as Arc<dyn Closer>);
    }
    lock(&shared.carries.live).insert(
        number,
        Live {
            host_id: host.host_id.clone(),
            closer,
        },
    );
    splice(
        device_end,
        host_end,
        ping_interval,
        closed,
        shared.stop.clone(),
    )
    .await;
    lock(&shared.carries.live).remove(&number);
    if let Some(device) = &device {
        shared.devices.disconnected(&device.id, number);
    }
    tracing::debug!(host = %host.host_id, "a carried connection closed");
}

/// How one side's reading ended.
enum Ended {
    /// It closed, with this frame.
    Closed(Option<CloseFrame>),
    /// It went, or stopped answering.
    Lost,
}

/// Which side ended first, or that the Dispatcher closes both.
enum Ending {
    Device(Ended),
    Host(Ended),
    /// Revoked or removed: the device's end gets this code.
    Closed(u16),
}

/// Pass frames between `device` and `host` until one closes, which the other is told, or
/// `closed` names a code to close the device's end with, or the Dispatcher stops.
async fn splice(
    device: Side,
    host: Side,
    ping_interval: Duration,
    mut closed: mpsc::UnboundedReceiver<u16>,
    stop: tokio_util::sync::CancellationToken,
) {
    let (to_device, device_data) = mpsc::channel(BUFFER);
    let (to_host, host_data) = mpsc::channel(BUFFER);
    let (close_device, device_close) = oneshot::channel();
    let (close_host, host_close) = oneshot::channel();
    let device_pong = Arc::new(AtomicU64::new(now_ms()));
    let host_pong = Arc::new(AtomicU64::new(now_ms()));
    let device_writer = tokio::spawn(write(
        device.sink,
        device_data,
        device_close,
        Arc::clone(&device_pong),
        device.websocket.then_some(ping_interval),
    ));
    let host_writer = tokio::spawn(write(
        host.sink,
        host_data,
        host_close,
        Arc::clone(&host_pong),
        host.websocket.then_some(ping_interval),
    ));
    let from_device = read(device.frames, to_host, device_pong);
    let from_host = read(host.frames, to_device, host_pong);
    tokio::pin!(from_device, from_host, device_writer, host_writer);
    let ending = tokio::select! {
        ended = &mut from_device => Ending::Device(ended),
        ended = &mut from_host => Ending::Host(ended),
        _ = &mut device_writer => Ending::Device(Ended::Lost),
        _ = &mut host_writer => Ending::Host(Ended::Lost),
        code = closed.recv() => Ending::Closed(code.unwrap_or(u16::from(CloseCode::Normal))),
        () = stop.cancelled() => Ending::Closed(u16::from(CloseCode::Away)),
    };
    let normal = || frame(u16::from(CloseCode::Normal), "");
    let (device_frame, host_frame) = match ending {
        Ending::Device(ended) => (None, Some(passed_on(ended))),
        Ending::Host(ended) => (Some(passed_on(ended)), None),
        Ending::Closed(code) => (Some(frame(code, "")), Some(normal())),
    };
    let _ = close_device.send(device_frame);
    let _ = close_host.send(host_frame);
    // What each side sent before the end is written to the other first, unless it takes long.
    let finishing = async {
        let _ = (&mut device_writer).await;
        let _ = (&mut host_writer).await;
    };
    if tokio::time::timeout(CLOSE_GRACE * 2, finishing)
        .await
        .is_err()
    {
        device_writer.abort();
        host_writer.abort();
    }
}

/// The close the other side is told of, for how this one ended: its own code, where it may be
/// sent on, as a Host closing a device that fell behind does.
fn passed_on(ended: Ended) -> CloseFrame {
    match ended {
        Ended::Closed(Some(closed)) if is_sendable(closed.code) => closed,
        Ended::Closed(_) => frame(u16::from(CloseCode::Normal), ""),
        Ended::Lost => frame(
            u16::from(CloseCode::Away),
            "the other end of the connection went",
        ),
    }
}

/// Whether a close code may be sent in a close frame: not the ones that only report a close.
fn is_sendable(code: CloseCode) -> bool {
    !matches!(
        code,
        CloseCode::Status | CloseCode::Abnormal | CloseCode::Tls | CloseCode::Reserved(_)
    )
}

fn frame(code: u16, reason: &str) -> CloseFrame {
    CloseFrame {
        code: CloseCode::from(code),
        reason: reason.to_owned().into(),
    }
}

/// Read one side, sending its data frames on to the other, no faster than the other takes them.
async fn read(mut frames: Frames, to: mpsc::Sender<Message>, pong: Arc<AtomicU64>) -> Ended {
    while let Some(frame) = frames.next().await {
        match frame {
            Ok(message @ (Message::Text(_) | Message::Binary(_))) => {
                if to.send(message).await.is_err() {
                    return Ended::Lost;
                }
            }
            Ok(Message::Pong(_)) => pong.store(now_ms(), Ordering::SeqCst),
            Ok(Message::Ping(_) | Message::Frame(_)) => {}
            Ok(Message::Close(frame)) => return Ended::Closed(frame),
            Err(_) => return Ended::Lost,
        }
    }
    Ended::Lost
}

/// Write what comes for one side and ping it, every `pings` on a WebSocket, until told how to
/// close it: with a frame, after what came before it, or with none when it closed itself.
/// Ends early when the side stops answering pings or can't be written to.
async fn write(
    mut sink: FrameSink,
    mut data: mpsc::Receiver<Message>,
    mut close: oneshot::Receiver<Option<CloseFrame>>,
    pong: Arc<AtomicU64>,
    pings: Option<Duration>,
) {
    let interval = pings.unwrap_or(Duration::from_secs(3600));
    let mut ticks = tokio::time::interval_at(tokio::time::Instant::now() + interval, interval);
    let mut pinged_at: Option<Timestamp> = None;
    let closing = loop {
        tokio::select! {
            closing = &mut close => break closing.ok(),
            message = data.recv() => {
                let Some(message) = message else {
                    // The other side stopped: wait to be told how to close.
                    break (&mut close).await.ok();
                };
                match send(&mut sink, message, &mut close).await {
                    Sent::Done => {}
                    Sent::Failed => return,
                    Sent::Closing(closing) => break closing,
                }
            }
            _ = ticks.tick(), if pings.is_some() => {
                if let Some(sent) = pinged_at
                    && pong.load(Ordering::SeqCst) < sent
                {
                    tracing::debug!("one end of a carried connection stopped answering pings");
                    return;
                }
                pinged_at = Some(now_ms());
                match send(&mut sink, Message::Ping(Vec::new().into()), &mut close).await {
                    Sent::Done => {}
                    Sent::Failed => return,
                    Sent::Closing(closing) => break closing,
                }
            }
        }
    };
    if let Some(Some(frame)) = closing {
        while let Ok(message) = data.try_recv() {
            match tokio::time::timeout(CLOSE_GRACE, sink.send(message)).await {
                Ok(Ok(())) => {}
                _ => break,
            }
        }
        let _ = tokio::time::timeout(CLOSE_GRACE, sink.send(Message::Close(Some(frame)))).await;
    }
    let _ = tokio::time::timeout(CLOSE_GRACE, sink.close()).await;
}

/// How sending one frame went.
enum Sent {
    Done,
    Failed,
    /// Told how to close while it was being sent, which it was given a little longer to finish.
    Closing(Option<Option<CloseFrame>>),
}

/// Send `message`, which a close coming meanwhile lets finish, for a while, before it closes: a
/// Host's last answer reaches the device ahead of the close that follows it.
async fn send(
    sink: &mut FrameSink,
    message: Message,
    close: &mut oneshot::Receiver<Option<CloseFrame>>,
) -> Sent {
    let sending = sink.send(message);
    tokio::pin!(sending);
    tokio::select! {
        biased;
        sent = &mut sending => match sent {
            Ok(()) => Sent::Done,
            Err(_) => Sent::Failed,
        },
        closing = close => {
            let _ = tokio::time::timeout(CLOSE_GRACE, &mut sending).await;
            Sent::Closing(closing.ok())
        }
    }
}
