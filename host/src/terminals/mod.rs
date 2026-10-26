//! Terminals on the Host's computer (ADR 0022, spec "Terminals"). An [`Owner`] keeps each one
//! alive outside the Host, holders today; the Host is the gateway between clients and owners,
//! keeps no terminal and no registry of its own, and finds the owner's terminals again when it
//! starts.
//!
//! For each terminal the Host holds one connection, its control, on which it's subscribed to
//! the terminal's events and asks what it is (`describe`) whenever one says it changed, so its
//! [`Terminal`] is current for `terminals/list` and its scope's watchers. A client's stream of
//! a terminal is a connection of its own (`stream.rs`).

pub mod holder;
pub mod owner;
pub(crate) mod stream;

use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;

use agent_client_protocol::ConnectionTo;
use agent_client_protocol::Error;
use agent_client_protocol::schema::v1::SessionId;
use serde_json::Value;
use serde_json::json;
use tokio::sync::OnceCell;
use tokio::sync::broadcast;
use tokio::sync::mpsc;
use tokio::sync::oneshot;
use weave_host_protocol::HostClient;
use weave_host_protocol::Timestamp;
use weave_host_protocol::errors;
use weave_host_protocol::terminals::ProgramStatus;
use weave_host_protocol::terminals::Terminal;
use weave_host_protocol::terminals::TerminalCommand;
use weave_host_protocol::terminals::TerminalFormat;
use weave_host_protocol::terminals::TerminalProcess;
use weave_host_protocol::terminals::TerminalProcesses;
use weave_host_protocol::terminals::TerminalRemovedNotification;
use weave_host_protocol::terminals::TerminalSize;
use weave_host_protocol::terminals::TerminalUpdatedNotification;
use weave_host_protocol::terminals::stream::TICKET_LIFETIME_MS;

pub use self::holder::Holders;
pub use self::holder::Launch;
use self::owner::CHANNEL_DEPTH;
pub use self::owner::Incoming;
pub use self::owner::Outgoing;
pub use self::owner::Owner;
pub use self::owner::Start;
pub use self::owner::Wire;
use crate::devices::random_bytes;
use crate::journal::now_ms;
use crate::session::lock;

/// How long a request to a terminal's owner may take.
const CALL_TIMEOUT: Duration = Duration::from_secs(10);
/// A terminal's size until a client gives it one.
pub(crate) const DEFAULT_SIZE: TerminalSize = TerminalSize { cols: 80, rows: 24 };

/// The events after which a terminal is described again.
const CHANGES: [&str; 8] = [
    "pwd_changed",
    "title_changed",
    "process_changed",
    "command_changed",
    "program_status_changed",
    "program_status_removed",
    "size_changed",
    "label_changed",
];

pub(crate) struct Terminals {
    owner: Arc<dyn Owner>,
    state: Mutex<State>,
    /// The owner's terminals were found, once, when first needed.
    found: OnceCell<()>,
    tickets: Mutex<HashMap<String, Ticket>>,
    /// Every terminal as it changes, for streams.
    updated: broadcast::Sender<Terminal>,
    /// Who sets each terminal's size, among its streams.
    sizing: Mutex<HashMap<String, Sizing>>,
}

/// A terminal's streams' sizes, and which one last typed: the holder's policy, which the Host
/// applies since it knows the devices (spec, "The terminal stream").
#[derive(Default)]
struct Sizing {
    last: Option<u64>,
    streams: HashMap<u64, TerminalSize>,
}

#[derive(Default)]
struct State {
    entries: BTreeMap<String, Entry>,
    /// Clients watching scopes (`terminals/watch`), by connection.
    watchers: BTreeMap<u64, Watcher>,
}

struct Entry {
    terminal: Terminal,
    control: Control,
    /// What its owner's snapshots are: a client of another codec restores from VT.
    codec: Option<String>,
}

struct Watcher {
    cx: ConnectionTo<HostClient>,
    scopes: BTreeSet<PathBuf>,
}

/// A stream's ticket: for one terminal, to one device, once, before it expires.
#[derive(Clone, Debug)]
pub(crate) struct Ticket {
    pub(crate) terminal: String,
    /// The paired device that asked; none for a local client.
    pub(crate) device: Option<String>,
    expires_at: Timestamp,
}

impl Terminals {
    pub(crate) fn new(owner: Arc<dyn Owner>) -> Arc<Self> {
        Arc::new(Self {
            owner,
            state: Mutex::new(State::default()),
            found: OnceCell::new(),
            tickets: Mutex::new(HashMap::new()),
            updated: broadcast::channel(64).0,
            sizing: Mutex::new(HashMap::new()),
        })
    }

    /// Finds the owner's terminals, the first time it's asked.
    pub(crate) async fn ready(self: &Arc<Self>) {
        self.found
            .get_or_init(|| async {
                for id in self.owner.find().await {
                    if let Err(error) = self.track(&id).await {
                        tracing::warn!(id, %error, "couldn't take up a terminal");
                    }
                }
            })
            .await;
    }

    /// A scope's terminals, oldest first.
    pub(crate) fn list(&self, scope: &Path) -> Vec<Terminal> {
        let state = lock(&self.state);
        let mut terminals: Vec<Terminal> = state
            .entries
            .values()
            .filter(|entry| entry.terminal.scope == scope)
            .map(|entry| entry.terminal.clone())
            .collect();
        terminals.sort_by(|a, b| (a.started_at, &a.id).cmp(&(b.started_at, &b.id)));
        terminals
    }

    /// `terminals/watch`: `respond` with the scope's terminals, then tell `client` of every change
    /// in the scope. Nothing reaches watchers between the two.
    pub(crate) fn watch(
        &self,
        client: u64,
        cx: ConnectionTo<HostClient>,
        scope: &Path,
        respond: impl FnOnce(Vec<Terminal>) -> Result<(), Error>,
    ) -> Result<(), Error> {
        let terminals = self.list(scope);
        let mut state = lock(&self.state);
        respond(terminals)?;
        state
            .watchers
            .entry(client)
            .or_insert_with(|| Watcher {
                cx,
                scopes: BTreeSet::new(),
            })
            .scopes
            .insert(scope.to_path_buf());
        Ok(())
    }

    pub(crate) fn unwatch(&self, client: u64, scope: &Path) {
        let mut state = lock(&self.state);
        if let Some(watcher) = state.watchers.get_mut(&client) {
            watcher.scopes.remove(scope);
        }
    }

    /// The client's connection ended.
    pub(crate) fn forget(&self, client: u64) {
        lock(&self.state).watchers.remove(&client);
        lock(&self.tickets).retain(|_, ticket| ticket.expires_at > now_ms());
    }

    /// Starts a terminal and takes it up.
    pub(crate) async fn start(self: &Arc<Self>, start: Start) -> Result<Terminal, Error> {
        self.ready().await;
        let id = self.owner.start(start).await?;
        self.track(&id).await
    }

    /// Connects to a terminal, subscribes to its events, and follows them.
    async fn track(self: &Arc<Self>, id: &str) -> Result<Terminal, Error> {
        let (control, events) = Control::new(self.owner.connect(id).await?);
        let described = control.call("subscribe", json!({})).await?;
        let terminal = describe(&described)
            .ok_or_else(|| errors::terminal_unavailable("the terminal didn't say what it is"))?;
        lock(&self.state).entries.insert(
            id.to_owned(),
            Entry {
                terminal: terminal.clone(),
                control: control.clone(),
                codec: described["codec"].as_str().map(str::to_owned),
            },
        );
        let _ = self.updated.send(terminal.clone());
        self.tell(&TerminalUpdatedNotification {
            terminal: terminal.clone(),
        });
        let terminals = Arc::clone(self);
        let id = id.to_owned();
        tokio::spawn(async move { terminals.follow(id, control, events).await });
        Ok(terminal)
    }

    async fn follow(
        self: Arc<Self>,
        id: String,
        control: Control,
        mut events: mpsc::Receiver<Incoming>,
    ) {
        let mut exit_code = None;
        while let Some(message) = events.recv().await {
            let Incoming::Event { kind, payload } = message else {
                continue;
            };
            if kind == "child_exited" {
                exit_code = payload["exit_code"]
                    .as_i64()
                    .and_then(|code| i32::try_from(code).ok());
                break;
            }
            if CHANGES.contains(&kind.as_str()) {
                self.refresh(&id, &control).await;
            }
        }
        let removed = lock(&self.state).entries.remove(&id);
        lock(&self.sizing).remove(&id);
        if let Some(entry) = removed {
            self.tell(&TerminalRemovedNotification {
                id,
                scope: entry.terminal.scope,
                exit_code,
            });
        }
    }

    /// Describes the terminal again, and tells its scope's watchers if it changed.
    async fn refresh(&self, id: &str, control: &Control) -> Option<Terminal> {
        let terminal = describe(&control.call("describe", json!({})).await.ok()?)?;
        let changed = {
            let mut state = lock(&self.state);
            let entry = state.entries.get_mut(id)?;
            let changed = entry.terminal != terminal;
            entry.terminal = terminal.clone();
            changed
        };
        if changed {
            let _ = self.updated.send(terminal.clone());
            self.tell(&TerminalUpdatedNotification {
                terminal: terminal.clone(),
            });
        }
        Some(terminal)
    }

    /// Tells the watchers of the notification's scope, dropping those that have gone.
    fn tell<N: TerminalNotification>(&self, notification: &N) {
        let scope = notification.scope();
        lock(&self.state).watchers.retain(|_, watcher| {
            !watcher.scopes.contains(scope)
                || watcher.cx.send_notification(notification.clone()).is_ok()
        });
    }

    fn control(&self, id: &str) -> Result<Control, Error> {
        lock(&self.state)
            .entries
            .get(id)
            .map(|entry| entry.control.clone())
            .ok_or_else(|| errors::unknown_terminal(id))
    }

    /// The terminal, as the Host last described it.
    pub(crate) fn get(&self, id: &str) -> Result<Terminal, Error> {
        lock(&self.state)
            .entries
            .get(id)
            .map(|entry| entry.terminal.clone())
            .ok_or_else(|| errors::unknown_terminal(id))
    }

    /// Hangs the terminal's program up; `terminals/removed` follows once it ends.
    pub(crate) async fn close(&self, id: &str) -> Result<(), Error> {
        self.control(id)?.call("close", json!({})).await.map(|_| ())
    }

    pub(crate) async fn set_label(
        &self,
        id: &str,
        label: Option<String>,
    ) -> Result<Terminal, Error> {
        let control = self.control(id)?;
        control.call("set_label", json!({"label": label})).await?;
        self.refresh(id, &control)
            .await
            .ok_or_else(|| errors::unknown_terminal(id))
    }

    pub(crate) async fn write(&self, id: &str, text: &str) -> Result<(), Error> {
        self.control(id)?
            .call("write", json!({"text": text}))
            .await
            .map(|_| ())
    }

    pub(crate) async fn format(
        &self,
        id: &str,
        format: TerminalFormat,
        history: bool,
        trim: bool,
    ) -> Result<String, Error> {
        let format = match format {
            TerminalFormat::Text => "text",
            TerminalFormat::Vt => "vt",
        };
        let answer = self
            .control(id)?
            .call(
                "format",
                json!({"format": format, "history": history, "trim": trim}),
            )
            .await?;
        Ok(answer["content"].as_str().unwrap_or_default().to_owned())
    }

    /// Asks the terminal's owner to take `size`.
    pub(crate) async fn resize(&self, id: &str, size: TerminalSize) -> Result<(), Error> {
        self.control(id)?
            .call("resize", json!({"cols": size.cols, "rows": size.rows}))
            .await
            .map(|_| ())
    }

    /// A ticket for the terminal's stream, to `device`.
    pub(crate) fn ticket(
        &self,
        id: &str,
        device: Option<String>,
    ) -> Result<(String, Timestamp), Error> {
        self.get(id)?;
        let ticket = base64_url(&random_bytes::<24>());
        let expires_at = now_ms() + TICKET_LIFETIME_MS;
        let mut tickets = lock(&self.tickets);
        tickets.retain(|_, ticket| ticket.expires_at > now_ms());
        tickets.insert(
            ticket.clone(),
            Ticket {
                terminal: id.to_owned(),
                device,
                expires_at,
            },
        );
        Ok((ticket, expires_at))
    }

    /// The ticket, used up, if it's still good.
    pub(crate) fn take_ticket(&self, ticket: &str) -> Option<Ticket> {
        lock(&self.tickets)
            .remove(ticket)
            .filter(|ticket| ticket.expires_at > now_ms())
    }

    /// The codec of the terminal's owner's snapshots.
    pub(crate) fn codec(&self, id: &str) -> Option<String> {
        lock(&self.state)
            .entries
            .get(id)
            .and_then(|entry| entry.codec.clone())
    }

    /// Every terminal as it changes.
    pub(crate) fn updates(&self) -> broadcast::Receiver<Terminal> {
        self.updated.subscribe()
    }

    /// A stream of the terminal joined at `size`; the size to give the terminal when nobody has
    /// typed in one of its streams yet, so the first to attach sizes it.
    pub(crate) fn join(&self, id: &str, stream: u64, size: TerminalSize) -> Option<TerminalSize> {
        let mut sizing = lock(&self.sizing);
        let sizing = sizing.entry(id.to_owned()).or_default();
        sizing.streams.insert(stream, size);
        if sizing.last.is_none() {
            sizing.last = Some(stream);
            Some(size)
        } else {
            None
        }
    }

    /// The stream typed: if another one typed last, this one now sets the size, and its size
    /// is the one to give the terminal.
    pub(crate) fn typed(&self, id: &str, stream: u64) -> Option<TerminalSize> {
        let mut sizing = lock(&self.sizing);
        let sizing = sizing.get_mut(id)?;
        if sizing.last == Some(stream) {
            return None;
        }
        sizing.last = Some(stream);
        sizing.streams.get(&stream).copied()
    }

    /// The stream's device resized; whether its size applies now, as it's the last to type.
    pub(crate) fn resized(&self, id: &str, stream: u64, size: TerminalSize) -> bool {
        let mut sizing = lock(&self.sizing);
        let Some(sizing) = sizing.get_mut(id) else {
            return false;
        };
        sizing.streams.insert(stream, size);
        sizing.last == Some(stream)
    }

    /// Whether the stream is the one that last typed, which gets clipboard writes.
    pub(crate) fn is_last(&self, id: &str, stream: u64) -> bool {
        lock(&self.sizing)
            .get(id)
            .is_some_and(|sizing| sizing.last == Some(stream))
    }

    pub(crate) fn leave(&self, id: &str, stream: u64) {
        let mut sizing = lock(&self.sizing);
        if let Some(entry) = sizing.get_mut(id) {
            entry.streams.remove(&stream);
            if entry.last == Some(stream) {
                entry.last = None;
            }
        }
    }

    /// A new connection to a terminal, for a stream.
    pub(crate) async fn connect(
        &self,
        id: &str,
    ) -> Result<(Control, mpsc::Receiver<Incoming>), Error> {
        self.get(id)?;
        Ok(Control::new(self.owner.connect(id).await?))
    }

    /// The terminals in the worktree at `path` (symlinks resolved), and which of them run a
    /// command.
    pub(crate) fn inside(&self, path: &Path) -> (Vec<String>, Vec<String>) {
        let state = lock(&self.state);
        let inside: Vec<&Entry> = state
            .entries
            .values()
            .filter(|entry| entry.terminal.scope.starts_with(path))
            .collect();
        let busy = inside
            .iter()
            .filter(|entry| {
                entry
                    .terminal
                    .command
                    .as_ref()
                    .is_some_and(|command| command.running)
            })
            .map(|entry| entry.terminal.id.clone())
            .collect();
        let all = inside
            .iter()
            .map(|entry| entry.terminal.id.clone())
            .collect();
        (all, busy)
    }
}

/// A notification of a scope's terminals.
trait TerminalNotification: agent_client_protocol::JsonRpcNotification + Clone {
    fn scope(&self) -> &Path;
}

impl TerminalNotification for TerminalUpdatedNotification {
    fn scope(&self) -> &Path {
        &self.terminal.scope
    }
}

impl TerminalNotification for TerminalRemovedNotification {
    fn scope(&self) -> &Path {
        &self.scope
    }
}

/// Requests waiting for their answers, by id.
type Waiting = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

/// Requests to a terminal's owner over one connection, answered by id.
#[derive(Clone)]
pub(crate) struct Control {
    outgoing: mpsc::Sender<Outgoing>,
    waiting: Waiting,
    next: Arc<AtomicU64>,
}

impl Control {
    /// A control over `wire`, and everything else the owner sends on it.
    pub(crate) fn new(wire: Wire) -> (Self, mpsc::Receiver<Incoming>) {
        let Wire {
            outgoing,
            mut incoming,
        } = wire;
        let waiting: Waiting = Arc::default();
        let (rest_tx, rest) = mpsc::channel(CHANNEL_DEPTH);
        let answers = Arc::clone(&waiting);
        tokio::spawn(async move {
            while let Some(message) = incoming.recv().await {
                match message {
                    Incoming::Answer { id, result } => {
                        if let Some(waiter) = lock(&answers).remove(&id) {
                            let _ = waiter.send(result);
                        }
                    }
                    other => {
                        if rest_tx.send(other).await.is_err() {
                            break;
                        }
                    }
                }
            }
            // Whoever still waits hears the connection went.
            lock(&answers).clear();
        });
        (
            Self {
                outgoing,
                waiting,
                next: Arc::new(AtomicU64::new(1)),
            },
            rest,
        )
    }

    pub(crate) async fn call(&self, method: &str, args: Value) -> Result<Value, Error> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (answer, answered) = oneshot::channel();
        lock(&self.waiting).insert(id, answer);
        let request = Outgoing::Request {
            id,
            method: method.to_owned(),
            args,
        };
        if self.outgoing.send(request).await.is_err() {
            lock(&self.waiting).remove(&id);
            return Err(gone());
        }
        match tokio::time::timeout(CALL_TIMEOUT, answered).await {
            Ok(Ok(Ok(value))) => Ok(value),
            Ok(Ok(Err(message))) => Err(Error::invalid_params().data(json!(message))),
            Ok(Err(_)) => Err(gone()),
            Err(_) => {
                lock(&self.waiting).remove(&id);
                Err(errors::terminal_unavailable(format!(
                    "the terminal didn't answer {method}"
                )))
            }
        }
    }

    /// Sends bytes as typed.
    pub(crate) async fn input(&self, bytes: Vec<u8>) -> Result<(), Error> {
        self.outgoing
            .send(Outgoing::Input(bytes))
            .await
            .map_err(|_| gone())
    }
}

fn gone() -> Error {
    errors::terminal_unavailable("the terminal's connection ended")
}

fn base64_url(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// A terminal as clients see it, from what its owner said of it in Rex's terms (`describe`).
pub(crate) fn describe(described: &Value) -> Option<Terminal> {
    let string = |key: &str| {
        described[key]
            .as_str()
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    };
    let size = &described["size"];
    let foreground = &described["process"]["foreground"];
    let command = &described["command"];
    Some(Terminal {
        id: described["id"].as_str()?.to_owned(),
        scope: PathBuf::from(described["scope"].as_str()?),
        label: string("label"),
        opened_from: string("opened_from").map(SessionId::new),
        title: string("title"),
        pwd: string("pwd").and_then(|pwd| pwd_path(&pwd)),
        process: foreground.is_object().then(|| TerminalProcesses {
            foreground: Some(TerminalProcess {
                pid: foreground["pid"]
                    .as_i64()
                    .and_then(|pid| i32::try_from(pid).ok())
                    .unwrap_or_default(),
                name: foreground["name"].as_str().unwrap_or_default().to_owned(),
            }),
        }),
        size: TerminalSize {
            cols: size["cols"]
                .as_u64()
                .and_then(|cols| u16::try_from(cols).ok())
                .unwrap_or(DEFAULT_SIZE.cols),
            rows: size["rows"]
                .as_u64()
                .and_then(|rows| u16::try_from(rows).ok())
                .unwrap_or(DEFAULT_SIZE.rows),
        },
        command: command.is_object().then(|| TerminalCommand {
            running: command["running"].as_bool().unwrap_or_default(),
            command: command["command"].as_str().map(str::to_owned),
            exit_code: command["exit_code"]
                .as_i64()
                .and_then(|code| i32::try_from(code).ok()),
        }),
        program_status: described["program_status"]
            .as_array()
            .map(|records| {
                records
                    .iter()
                    .filter_map(|record| {
                        serde_json::from_value::<ProgramStatus>(record.clone()).ok()
                    })
                    .collect()
            })
            .unwrap_or_default(),
        started_at: described["started_at"].as_u64().unwrap_or_default(),
    })
}

/// The path in a directory the shell reported (OSC 7) as a URL with a host:
/// `file://host/path`, percent-encoded, or `kitty-shell-cwd://host/path`, as Ghostty's
/// integration sends it.
fn pwd_path(url: &str) -> Option<PathBuf> {
    let (scheme, rest) = url.split_once("://")?;
    let path = &rest[rest.find('/')?..];
    if scheme == "file" {
        Some(PathBuf::from(percent_decode(path)?))
    } else {
        Some(PathBuf::from(path))
    }
}

fn percent_decode(text: &str) -> Option<String> {
    let mut bytes = Vec::with_capacity(text.len());
    let mut rest = text.as_bytes();
    while let Some((&byte, after)) = rest.split_first() {
        if byte == b'%' && after.len() >= 2 {
            let hex = std::str::from_utf8(&after[..2]).ok()?;
            bytes.push(u8::from_str_radix(hex, 16).ok()?);
            rest = &after[2..];
        } else {
            bytes.push(byte);
            rest = after;
        }
    }
    String::from_utf8(bytes).ok()
}

/// A new terminal's id: letters and digits, which name its holder's socket and record.
pub(crate) fn new_id() -> String {
    random_bytes::<8>()
        .iter()
        .fold(String::from("t"), |mut id, byte| {
            id.push_str(&format!("{byte:02x}"));
            id
        })
}

#[cfg(test)]
mod tests;
