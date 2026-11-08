//! `weave terminals attach <id>`: one of the Host's terminals in the terminal this runs in, as
//! `ssh` would show a shell (ADR 0022, WVE-167). The TUI opens it in a Rex pane beside itself,
//! and anyone can run it in any terminal.
//!
//! It has no emulator of its own. The Host's terminal stream reaches it on the Host's terminal
//! socket; a VT restore, the history included, then the program's output go to stdout, with what
//! the holder answers or the Host delivers left out (`filter`), and stdin goes back as input,
//! encoded by the terminal it runs in from the modes the output set there. The size follows the
//! device that last typed: while another device's holds, it draws nothing and says so, and typing
//! here takes the size back with a fresh restore. After a Host restart it attaches again; when
//! the terminal ends it exits, and the pane with it. Closing it leaves the terminal running.

mod filter;

use std::io::Write as _;
use std::process::ExitCode;
use std::time::Duration;

use anyhow::Context as _;
use anyhow::bail;
use base64::Engine as _;
use clap::Args;
use clap::Subcommand;
use futures::SinkExt as _;
use futures::StreamExt as _;
use tokio::net::UnixStream;
use tokio::sync::mpsc;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message as Frame;
use tokio_tungstenite::tungstenite::client::IntoClientRequest as _;
use weave_host::paths::DaemonPaths;
use weave_host::socket;
use weave_host_client::HostConnection;
use weave_host_protocol::errors;
use weave_host_protocol::terminals::AttachTerminalRequest;
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
use weave_host_protocol::terminals::stream::SUBPROTOCOL;

use self::filter::Filter;
use crate::host;

/// Its stdout is the terminal's screen.
pub const LOG: &str = "error";

/// This client's name to the Host.
const CLIENT: &str = "weave-terminal";
/// How often it tries the Host again once it's gone.
const RETRY: Duration = Duration::from_millis(500);
/// Its codec: none, so restores are the formatter's VT, which any terminal draws.
const CODEC: &str = "none";

#[derive(Args)]
pub struct TerminalsArgs {
    #[command(subcommand)]
    command: TerminalsCommand,
}

#[derive(Subcommand)]
enum TerminalsCommand {
    /// Show one of the weave Host's terminals here, and type into it. Closing this leaves the
    /// terminal running; it ends when its shell exits.
    Attach {
        /// The terminal's id, as `terminals/list` gives it.
        id: String,
    },
}

pub async fn command(args: TerminalsArgs) -> anyhow::Result<ExitCode> {
    match args.command {
        TerminalsCommand::Attach { id } => attach(&id).await,
    }
}

async fn attach(id: &str) -> anyhow::Result<ExitCode> {
    let paths = host::paths()?;
    let raw = RawMode::enable()?;
    let (input, mut typed) = mpsc::unbounded_channel();
    std::thread::spawn(move || read_stdin(input));
    let mut window = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::window_change())?;
    let mut screen = Screen;
    let mut first = true;
    loop {
        match attach_once(&paths, id, &mut screen, &mut typed, &mut window, first).await {
            Ok(Ended::Exited) => break,
            Ok(Ended::HostGone) => {
                first = false;
                screen.notice("The weave Host went away; attaching again once it's back…");
                tokio::time::sleep(RETRY).await;
            }
            Err(error) => {
                drop(raw);
                return Err(error);
            }
        }
    }
    drop(raw);
    Ok(ExitCode::SUCCESS)
}

enum Ended {
    /// The terminal ended.
    Exited,
    /// The Host went away, or isn't there yet.
    HostGone,
}

/// One attach, until the terminal ends or the Host goes. Errors are for good: the terminal
/// isn't the Host's, or the Host isn't running on the first try.
async fn attach_once(
    paths: &DaemonPaths,
    id: &str,
    screen: &mut Screen,
    typed: &mut mpsc::UnboundedReceiver<Vec<u8>>,
    window: &mut tokio::signal::unix::Signal,
    first: bool,
) -> anyhow::Result<Ended> {
    let transport = match socket::connect(&paths.socket).await {
        Ok(transport) => transport,
        Err(error) if first => {
            return Err(crate::exit::unreachable(error)).context("the weave Host isn't running");
        }
        Err(_) => return Ok(Ended::HostGone),
    };
    let Ok((connection, _events)) = HostConnection::connect(
        transport,
        host::client_info(CLIENT),
        host::capabilities(CLIENT),
    )
    .await
    else {
        return Ok(Ended::HostGone);
    };
    let ticket = match connection
        .send(AttachTerminalRequest { id: id.to_owned() })
        .await
    {
        Ok(answer) => answer.ticket,
        Err(error) if errors::is(&error, errors::UNKNOWN_TERMINAL) => {
            // Once attached, a terminal the Host no longer has has ended.
            if first {
                bail!("the weave Host has no terminal {id}");
            }
            return Ok(Ended::Exited);
        }
        Err(error) => return Err(anyhow::Error::from(error)).context("terminals/attach"),
    };
    let Ok(stream) = UnixStream::connect(paths.terminal_socket()).await else {
        if first {
            bail!(
                "the weave Host doesn't stream terminals to local clients; update it with \
                 `weave daemon restart`"
            );
        }
        return Ok(Ended::HostGone);
    };
    let mut request = "ws://localhost/"
        .into_client_request()
        .context("the stream's request")?;
    request.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        SUBPROTOCOL.parse().context("the stream's subprotocol")?,
    );
    let Ok((mut socket, _)) = tokio_tungstenite::client_async(request, stream).await else {
        return Ok(Ended::HostGone);
    };
    let size = window_size();
    let open = Open {
        ticket,
        size,
        codec: CODEC.to_owned(),
        history: true,
    };
    if send_json(&mut socket, &open).await.is_err() {
        return Ok(Ended::HostGone);
    }
    let mut link = Link {
        own: size,
        terminal: size,
        filter: Filter::default(),
        restore_left: 0,
    };
    relay(&mut socket, &mut link, screen, typed, window).await
}

/// This end of a stream: its size and the terminal's, and what it's drawing.
struct Link {
    /// The size of the terminal this runs in.
    own: TerminalSize,
    /// The size the terminal has, which another device may have set.
    terminal: TerminalSize,
    filter: Filter,
    /// Bytes of restore still to come before output, after an `Opened` or a resync.
    restore_left: u64,
}

impl Link {
    /// It draws only at its own size: another device's would garble it.
    fn draws(&self) -> bool {
        self.own == self.terminal
    }
}

async fn relay(
    socket: &mut WebSocketStream<UnixStream>,
    link: &mut Link,
    screen: &mut Screen,
    typed: &mut mpsc::UnboundedReceiver<Vec<u8>>,
    window: &mut tokio::signal::unix::Signal,
) -> anyhow::Result<Ended> {
    let mut opened = false;
    loop {
        tokio::select! {
            frame = socket.next() => match frame {
                Some(Ok(Frame::Text(text))) => {
                    if !opened {
                        opened = true;
                        let Ok(answer) = serde_json::from_str::<Opened>(&text) else {
                            return Ok(Ended::HostGone);
                        };
                        link.terminal = answer.terminal.size;
                        link.restore_left = answer.restore_bytes;
                        link.filter = Filter::default();
                        if link.draws() {
                            screen.clear();
                        } else {
                            screen.sized_elsewhere(link.terminal);
                        }
                        continue;
                    }
                    let Ok(message) = serde_json::from_str::<Message>(&text) else {
                        continue;
                    };
                    if let Some(ended) = on_message(socket, link, screen, message).await {
                        return Ok(ended);
                    }
                }
                Some(Ok(Frame::Binary(bytes))) => {
                    let Some((&kind, payload)) = bytes.split_first() else { continue };
                    if kind == RESTORE {
                        let len = u64::try_from(payload.len()).unwrap_or(u64::MAX);
                        link.restore_left = link.restore_left.saturating_sub(len);
                    }
                    if (kind == RESTORE || kind == OUTPUT) && link.draws() {
                        screen.write(&link.filter.feed(payload));
                    }
                }
                Some(Ok(Frame::Close(frame))) => {
                    let code = frame.map(|frame| u16::from(frame.code));
                    return match code {
                        Some(CLOSE_EXITED) => Ok(Ended::Exited),
                        Some(CLOSE_TICKET) => bail!("the weave Host refused the terminal's ticket"),
                        _ => Ok(Ended::HostGone),
                    };
                }
                Some(Ok(_)) => {}
                Some(Err(_)) | None => return Ok(Ended::HostGone),
            },
            bytes = typed.recv() => {
                let Some(bytes) = bytes else { return Ok(Ended::Exited) };
                let mut frame = Vec::with_capacity(bytes.len() + 1);
                frame.push(INPUT);
                frame.extend_from_slice(&bytes);
                if socket.send(Frame::binary(frame)).await.is_err() {
                    return Ok(Ended::HostGone);
                }
            }
            _ = window.recv() => {
                link.own = window_size();
                let resize = ClientMessage::Resize(link.own);
                if send_json(socket, &resize).await.is_err() {
                    return Ok(Ended::HostGone);
                }
            }
        }
    }
}

/// Acts on one of the Host's text frames; what ended the stream, if it did.
async fn on_message(
    socket: &mut WebSocketStream<UnixStream>,
    link: &mut Link,
    screen: &mut Screen,
    message: Message,
) -> Option<Ended> {
    match message {
        Message::Resized(size) => {
            let drew = link.draws();
            link.terminal = size;
            if link.draws() && !drew {
                // This device has the size again: a fresh restore replaces what it missed.
                if send_json(socket, &ClientMessage::Resync {}).await.is_err() {
                    return Some(Ended::HostGone);
                }
            } else if !link.draws() {
                screen.sized_elsewhere(size);
            }
        }
        Message::Resync {
            restore_bytes,
            size,
            ..
        } => {
            link.terminal = size;
            link.restore_left = restore_bytes;
            link.filter = Filter::default();
            if link.draws() {
                screen.clear();
            } else {
                screen.sized_elsewhere(size);
            }
        }
        Message::Clipboard { text } => screen.clipboard(&text),
        Message::Notification { title, body } => screen.notify(&title, &body),
        Message::Exited { .. } => return Some(Ended::Exited),
        _ => {}
    }
    None
}

async fn send_json(
    socket: &mut WebSocketStream<UnixStream>,
    message: &impl serde::Serialize,
) -> Result<(), tokio_tungstenite::tungstenite::Error> {
    let text = serde_json::to_string(message).unwrap_or_default();
    socket.send(Frame::text(text)).await
}

/// The terminal this runs in.
struct Screen;

impl Screen {
    fn write(&self, bytes: &[u8]) {
        let mut out = std::io::stdout().lock();
        let _ = out.write_all(bytes);
        let _ = out.flush();
    }

    /// An empty screen and scrollback, for a restore to fill.
    fn clear(&self) {
        self.write(b"\x1b[!p\x1b[H\x1b[2J\x1b[3J");
    }

    /// One dim line on an empty screen.
    fn notice(&self, text: &str) {
        self.clear();
        self.write(format!("\x1b[2m{text}\x1b[0m\r\n").as_bytes());
    }

    fn sized_elsewhere(&self, size: TerminalSize) {
        self.notice(&format!(
            "Another device has this terminal at {}×{}; type here to take it back.",
            size.cols, size.rows
        ));
    }

    /// A clipboard write the Host sent this device, the last to type.
    fn clipboard(&self, text: &str) {
        let encoded = base64::engine::general_purpose::STANDARD.encode(text);
        self.write(format!("\x1b]52;c;{encoded}\x07").as_bytes());
    }

    fn notify(&self, title: &str, body: &str) {
        let clean = |text: &str| text.replace(['\x07', '\x1b', ';'], " ");
        self.write(format!("\x1b]777;notify;{};{}\x07", clean(title), clean(body)).as_bytes());
    }
}

/// The size of the terminal this runs in.
fn window_size() -> TerminalSize {
    let (cols, rows) = crossterm::terminal::size().unwrap_or((80, 24));
    TerminalSize {
        cols: cols.max(2),
        rows: rows.max(2),
    }
}

/// Reads stdin on a thread of its own: a read on tokio's blocking pool would keep the process
/// from exiting once the terminal ends.
fn read_stdin(typed: mpsc::UnboundedSender<Vec<u8>>) {
    use std::io::Read as _;
    let mut stdin = std::io::stdin();
    let mut buffer = vec![0; 4096];
    loop {
        match stdin.read(&mut buffer) {
            Ok(0) | Err(_) => return,
            Ok(read) => {
                if typed.send(buffer[..read].to_vec()).is_err() {
                    return;
                }
            }
        }
    }
}

/// The terminal in raw mode, as long as this lives.
struct RawMode;

impl RawMode {
    fn enable() -> anyhow::Result<Self> {
        crossterm::terminal::enable_raw_mode().context("putting the terminal in raw mode")?;
        Ok(Self)
    }
}

impl Drop for RawMode {
    fn drop(&mut self) {
        let _ = crossterm::terminal::disable_raw_mode();
    }
}
