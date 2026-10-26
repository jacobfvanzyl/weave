//! A holder: one terminal's PTY, its program, and the authoritative libghostty-vt, on a Unix socket
//! that speaks the holder protocol (`protocol.rs`).
//!
//! Its threads share one lock around the terminal. The PTY reader writes the program's output
//! into it and sends the bytes on, a poller follows the foreground process, a signal thread hangs
//! the program up when the holder is told to stop, the main thread waits for the program and ends
//! the holder with it, and each client has a reader and a writer. A client's frames queue in an
//! outbox of its own, so a slow client never holds up the program or the other clients; one that
//! falls `RESYNC_BYTES` behind is resynchronized with a fresh snapshot.

use std::collections::BTreeMap;
use std::collections::VecDeque;
use std::io;
use std::io::Write;
use std::os::fd::AsRawFd;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixListener;
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Condvar;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::PoisonError;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::time::Duration;
use std::time::Instant;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use base64::Engine;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use serde_json::json;

use crate::event::Event;
use crate::event::Process;
use crate::event::Size;
use crate::launch;
use crate::launch::Integration;
use crate::launch::Login;
use crate::protocol;
use crate::protocol::Answer;
use crate::protocol::Failure;
use crate::protocol::Request;
use crate::pty;
use crate::pty::Pty;
use crate::resources;
use crate::vt;
use crate::vt::Format;
use crate::vt::Formatting;
use crate::vt::Terminal;

/// A client this far behind loses what it wasn't sent and gets a fresh snapshot instead.
const RESYNC_BYTES: usize = 4 * 1024 * 1024;
/// How often the foreground process is looked at.
const FOREGROUND_POLL: Duration = Duration::from_millis(250);
/// How long the program's last output may take to arrive after it exits, while something else
/// still holds the PTY open.
const DRAIN: Duration = Duration::from_millis(500);
/// How long clients get to receive the last events before the holder ends.
const FAREWELL: Duration = Duration::from_millis(500);

/// What a holder holds, and where.
pub struct Options {
    /// The holders' directory: records, sockets and Ghostty's resources.
    pub dir: PathBuf,
    pub id: String,
    pub cwd: PathBuf,
    pub label: Option<String>,
    /// The worktree, or directory outside a repository, the terminal belongs to (ADR 0022).
    pub scope: Option<String>,
    /// The thread the terminal was opened from.
    pub opened_from: Option<String>,
    pub size: Size,
    /// The person's login shell.
    pub shell: String,
    /// A command to run under the shell instead of an interactive shell.
    pub command: Option<Vec<String>>,
    /// The environment the program starts in: the agents' (WVE-141).
    pub env: BTreeMap<String, String>,
}

/// The record beside a holder's socket, from which a Host finds it again (`<id>.json`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Record {
    pub id: String,
    /// The holder's process.
    pub pid: u32,
    /// The program's process, which leads its session.
    pub child: i32,
    pub socket: PathBuf,
    pub cwd: PathBuf,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opened_from: Option<String>,
    pub codec: String,
    pub protocol: u32,
    pub version: String,
    pub started_at: u64,
}

/// Where a holder of `id` keeps its socket and record in `dir`.
pub fn paths(dir: &Path, id: &str) -> (PathBuf, PathBuf) {
    (
        dir.join(format!("{id}.sock")),
        dir.join(format!("{id}.json")),
    )
}

/// A holder's id: what names its socket and record, so letters, digits, `-` and `_`.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

struct Outbox {
    frames: VecDeque<Vec<u8>>,
    bytes: usize,
    closed: bool,
}

struct Client {
    outbox: Mutex<Outbox>,
    ready: Condvar,
    attached: AtomicBool,
    subscribed: AtomicBool,
    /// It restores from the formatter's VT rather than a snapshot: another codec's client.
    vt: AtomicBool,
}

impl Client {
    fn push(&self, frame: Vec<u8>) {
        let mut outbox = lock(&self.outbox);
        if outbox.closed {
            return;
        }
        outbox.bytes += frame.len();
        outbox.frames.push_back(frame);
        self.ready.notify_one();
    }

    fn close(&self) {
        lock(&self.outbox).closed = true;
        self.ready.notify_one();
    }
}

struct Inner {
    terminal: Terminal,
    clients: Vec<Arc<Client>>,
    label: Option<String>,
    foreground: Option<Process>,
    generation: u64,
    exit_code: Option<i32>,
}

struct Holder {
    inner: Mutex<Inner>,
    pty: Pty,
    /// Input and query replies reach the PTY whole, never interleaved.
    pty_writes: Mutex<()>,
    record: Mutex<Record>,
    record_path: PathBuf,
    integration: Option<Integration>,
}

impl Holder {
    fn write_pty(&self, bytes: &[u8]) {
        let _writes = lock(&self.pty_writes);
        // The program may have gone; its exit is what ends the holder.
        let _ = self.pty.write_all(bytes);
    }

    fn describe(&self, inner: &Inner) -> Value {
        let record = lock(&self.record);
        json!({
            "id": record.id,
            "label": inner.label,
            "scope": record.scope,
            "opened_from": record.opened_from,
            "pid": record.child,
            "cwd": record.cwd,
            "title": inner.terminal.title(),
            "pwd": inner.terminal.pwd(),
            "process": {"foreground": inner.foreground},
            "size": inner.terminal.size(),
            "command": inner.terminal.command(),
            "program_status": inner.terminal.program_status(),
            "integration": self.integration.map(|integration| format!("{integration:?}").to_lowercase()),
            "codec": record.codec,
            "started_at": record.started_at,
            "exit_code": inner.exit_code,
        })
    }

    fn save_record(&self) -> io::Result<()> {
        write_record(&self.record_path, &lock(&self.record))
    }
}

/// Runs a holder until its program exits, and says how it exited. `ready` hears the record once
/// the socket is up, or what stopped the holder before then.
pub fn serve(options: Options, ready: &mut dyn Write) -> io::Result<i32> {
    match start(options) {
        Ok((holder, listener)) => {
            let record = lock(&holder.record).clone();
            let _ = writeln!(
                ready,
                "{}",
                serde_json::to_string(&record).unwrap_or_default()
            );
            let _ = ready.flush();
            run(holder, listener)
        }
        Err(error) => {
            let _ = writeln!(ready, "{}", json!({"error": error.to_string()}));
            Err(error)
        }
    }
}

fn start(options: Options) -> io::Result<(Arc<Holder>, UnixListener)> {
    if !valid_id(&options.id) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{:?} isn't a holder id", options.id),
        ));
    }
    std::fs::create_dir_all(&options.dir)?;
    std::fs::set_permissions(&options.dir, std::fs::Permissions::from_mode(0o700))?;
    let (socket, record_path) = paths(&options.dir, &options.id);
    let listener = listen(&socket)?;

    let resources = match resources::materialize(&options.dir) {
        Ok(resources) => resources,
        Err(error) => {
            eprintln!("weave-holder: Ghostty's resources: {error}");
            None
        }
    };
    let user = launch::user_name();
    let hush = options
        .env
        .get("HOME")
        .is_some_and(|home| Path::new(home).join(".hushlogin").exists());
    let launch = launch::launch(launch::Options {
        shell: &options.shell,
        command: options.command.as_deref(),
        resources: resources.as_ref(),
        env: options.env,
        login: cfg!(target_os = "macos").then_some(Login { user: &user, hush }),
    });

    let mut terminal =
        Terminal::new(options.size.cols, options.size.rows).map_err(io::Error::other)?;
    if resources.is_some() {
        terminal
            .set_terminfo_name("xterm-ghostty")
            .map_err(io::Error::other)?;
    }
    // The program and every thread after it inherit this mask; signal_thread takes them.
    block_stop_signals();
    let pty = Pty::spawn(&launch, &options.cwd, options.size)?;

    let record = Record {
        id: options.id,
        pid: std::process::id(),
        child: pty.child(),
        socket,
        cwd: options.cwd,
        label: options.label.clone(),
        scope: options.scope,
        opened_from: options.opened_from,
        codec: vt::codec().map_err(io::Error::other)?,
        protocol: protocol::PROTOCOL,
        version: env!("CARGO_PKG_VERSION").into(),
        started_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |since| since.as_millis() as u64),
    };
    write_record(&record_path, &record)?;
    let holder = Arc::new(Holder {
        inner: Mutex::new(Inner {
            terminal,
            clients: Vec::new(),
            label: options.label,
            foreground: None,
            generation: 0,
            exit_code: None,
        }),
        pty,
        pty_writes: Mutex::new(()),
        record: Mutex::new(record),
        record_path,
        integration: launch.integration,
    });
    Ok((holder, listener))
}

/// Binds `socket`, unless a live holder already answers there.
fn listen(socket: &Path) -> io::Result<UnixListener> {
    if UnixStream::connect(socket).is_ok() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!("a holder already answers at {}", socket.display()),
        ));
    }
    match std::fs::remove_file(socket) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
        _ => {}
    }
    let listener = UnixListener::bind(socket)?;
    std::fs::set_permissions(socket, std::fs::Permissions::from_mode(0o600))?;
    Ok(listener)
}

fn write_record(path: &Path, record: &Record) -> io::Result<()> {
    let staging = path.with_extension("json.partial");
    std::fs::write(
        &staging,
        serde_json::to_vec_pretty(record).map_err(io::Error::other)?,
    )?;
    std::fs::rename(&staging, path)
}

fn run(holder: Arc<Holder>, listener: UnixListener) -> io::Result<i32> {
    let (drained_tx, drained_rx) = mpsc::channel();
    {
        let holder = holder.clone();
        std::thread::spawn(move || read_pty(&holder, &drained_tx));
    }
    {
        let holder = holder.clone();
        std::thread::spawn(move || follow_foreground(&holder));
    }
    {
        let holder = holder.clone();
        std::thread::spawn(move || signal_thread(&holder));
    }
    {
        let holder = holder.clone();
        std::thread::spawn(move || accept(&holder, &listener));
    }

    let code = holder.pty.wait()?;
    // The last output, unless something else still holds the PTY open.
    let _ = drained_rx.recv_timeout(DRAIN);
    let clients = {
        let mut inner = lock(&holder.inner);
        inner.exit_code = Some(code);
        let mut events = inner.terminal.exited();
        events.push(Event::ChildExited {
            exit_code: code,
            error: (code != 0).then(|| format!("exited with {code}")),
        });
        for event in &events {
            broadcast(&inner, event);
        }
        for client in &inner.clients {
            client.close();
        }
        inner.clients.clone()
    };
    // Give the writers a moment to send what's left.
    let deadline = Instant::now() + FAREWELL;
    while Instant::now() < deadline && clients.iter().any(|client| lock(&client.outbox).bytes > 0) {
        std::thread::sleep(Duration::from_millis(10));
    }
    let record = lock(&holder.record).clone();
    let _ = std::fs::remove_file(&record.socket);
    let _ = std::fs::remove_file(&holder.record_path);
    Ok(code)
}

fn read_pty(holder: &Holder, drained: &mpsc::Sender<()>) {
    let mut buffer = vec![0; 64 * 1024];
    loop {
        let read = match holder.pty.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(read) => read,
        };
        let bytes = &buffer[..read];
        let mut inner = lock(&holder.inner);
        let effects = inner.terminal.write(bytes);
        if !effects.replies.is_empty() {
            holder.write_pty(&effects.replies);
        }
        send_output(&mut inner, bytes);
        for event in &effects.events {
            broadcast(&inner, event);
        }
    }
    let _ = drained.send(());
}

/// Sends output to every attached client, resynchronizing those too far behind.
fn send_output(inner: &mut Inner, bytes: &[u8]) {
    let frame = protocol::frame(protocol::OUTPUT, bytes);
    let mut restores = Restores::default();
    for client in &inner.clients {
        if !client.attached.load(Ordering::Relaxed) {
            continue;
        }
        let behind = lock(&client.outbox).bytes > RESYNC_BYTES;
        if !behind {
            client.push(frame.clone());
            continue;
        }
        // What it wasn't sent is in a fresh restore, this output included.
        {
            let mut outbox = lock(&client.outbox);
            outbox.frames.clear();
            outbox.bytes = 0;
        }
        let vt = client.vt.load(Ordering::Relaxed);
        if let Some(restore) = restores.get(&inner.terminal, vt) {
            client.push(protocol::json(&Event::Resync {
                codec: vt::codec().unwrap_or_default(),
                restore: restore_name(vt).to_owned(),
                snapshot_bytes: restore.len(),
                size: inner.terminal.size(),
            }));
            send_restore(client, restore);
        }
    }
}

/// The restores clients get, each made once however many clients need it.
#[derive(Default)]
struct Restores {
    snapshot: Option<Option<Vec<u8>>>,
    vt: Option<Option<Vec<u8>>>,
}

impl Restores {
    fn get(&mut self, terminal: &Terminal, vt: bool) -> Option<&Vec<u8>> {
        if vt {
            self.vt
                .get_or_insert_with(|| restore(terminal, true).ok())
                .as_ref()
        } else {
            self.snapshot
                .get_or_insert_with(|| restore(terminal, false).ok())
                .as_ref()
        }
    }
}

/// What a client restores the terminal from: a snapshot, or for a client of another codec the
/// formatter's VT of the visible screen.
fn restore(terminal: &Terminal, vt: bool) -> Result<Vec<u8>, vt::Error> {
    if vt {
        terminal
            .format(Format::Vt, Formatting::RESTORE)
            .map(String::into_bytes)
    } else {
        terminal.snapshot()
    }
}

fn restore_name(vt: bool) -> &'static str {
    if vt { "vt" } else { "snapshot" }
}

fn send_restore(client: &Client, restore: &[u8]) {
    for chunk in restore.chunks(protocol::SNAPSHOT_CHUNK) {
        client.push(protocol::frame(protocol::SNAPSHOT, chunk));
    }
}

fn broadcast(inner: &Inner, event: &Event) {
    let frame = protocol::json(event);
    for client in &inner.clients {
        if client.subscribed.load(Ordering::Relaxed) {
            client.push(frame.clone());
        }
    }
}

fn follow_foreground(holder: &Holder) {
    loop {
        std::thread::sleep(FOREGROUND_POLL);
        let group = holder.pty.foreground();
        let mut inner = lock(&holder.inner);
        if inner.exit_code.is_some() {
            return;
        }
        let Some(group) = group else { continue };
        if inner
            .foreground
            .as_ref()
            .is_some_and(|process| process.pid == group)
        {
            continue;
        }
        let process = Process {
            pid: group,
            name: pty::process_name(group),
        };
        inner.foreground = Some(process.clone());
        inner.generation += 1;
        let event = Event::ProcessChanged {
            generation: inner.generation,
            foreground: process,
            ancestors: Vec::new(),
        };
        broadcast(&inner, &event);
    }
}

const STOP_SIGNALS: [libc::c_int; 3] = [libc::SIGTERM, libc::SIGINT, libc::SIGHUP];

fn stop_signals() -> libc::sigset_t {
    unsafe {
        let mut set: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut set);
        for signal in STOP_SIGNALS {
            libc::sigaddset(&mut set, signal);
        }
        set
    }
}

fn block_stop_signals() {
    let set = stop_signals();
    unsafe { libc::pthread_sigmask(libc::SIG_BLOCK, &set, std::ptr::null_mut()) };
}

/// Told to stop (by systemd, launchd or a person), the holder hangs its program up and ends with
/// it, as a terminal window does when it closes.
fn signal_thread(holder: &Arc<Holder>) {
    let set = stop_signals();
    loop {
        let mut signal = 0;
        if unsafe { libc::sigwait(&set, &mut signal) } == 0 {
            hang_up(holder);
        }
    }
}

/// Hangs the program up, again each second for `HANG_UP_TRIES` seconds while it hasn't exited,
/// as one that was starting may have missed the first, and then kills it.
fn hang_up(holder: &Arc<Holder>) {
    holder.pty.hang_up();
    let holder = Arc::clone(holder);
    std::thread::spawn(move || {
        for _ in 0..HANG_UP_TRIES {
            std::thread::sleep(Duration::from_secs(1));
            if lock(&holder.inner).exit_code.is_some() {
                return;
            }
            holder.pty.hang_up();
        }
        if lock(&holder.inner).exit_code.is_none() {
            holder.pty.kill();
        }
    });
}

/// How many more times a hang-up is tried, a second apart, before the program is killed.
const HANG_UP_TRIES: u32 = 5;

fn accept(holder: &Arc<Holder>, listener: &UnixListener) {
    let owner = unsafe { libc::getuid() };
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        if pty::peer_uid(stream.as_raw_fd()).ok() != Some(owner) {
            continue;
        }
        let Ok(writer) = stream.try_clone() else {
            continue;
        };
        let client = Arc::new(Client {
            outbox: Mutex::new(Outbox {
                frames: VecDeque::new(),
                bytes: 0,
                closed: false,
            }),
            ready: Condvar::new(),
            attached: AtomicBool::new(false),
            vt: AtomicBool::new(false),
            subscribed: AtomicBool::new(false),
        });
        lock(&holder.inner).clients.push(client.clone());
        {
            let client = client.clone();
            std::thread::spawn(move || write_client(&client, writer));
        }
        let holder = holder.clone();
        std::thread::spawn(move || read_client(&holder, &client, stream));
    }
}

fn write_client(client: &Client, mut stream: UnixStream) {
    loop {
        let frame = {
            let mut outbox = lock(&client.outbox);
            while outbox.frames.is_empty() && !outbox.closed {
                outbox = client
                    .ready
                    .wait(outbox)
                    .unwrap_or_else(PoisonError::into_inner);
            }
            match outbox.frames.pop_front() {
                Some(frame) => {
                    outbox.bytes -= frame.len();
                    frame
                }
                None => break,
            }
        };
        if stream.write_all(&frame).is_err() {
            break;
        }
    }
    let _ = stream.shutdown(std::net::Shutdown::Both);
}

fn read_client(holder: &Arc<Holder>, client: &Arc<Client>, mut stream: UnixStream) {
    while let Ok(Some((kind, payload))) = protocol::read_frame(&mut stream) {
        match kind {
            protocol::INPUT => holder.write_pty(&payload),
            protocol::JSON => match serde_json::from_slice::<Request>(&payload) {
                Ok(request) => handle(holder, client, request),
                Err(error) => answer(
                    client,
                    Value::Null,
                    Err(Failure::bad_request(error.to_string())),
                ),
            },
            _ => {}
        }
    }
    client.close();
    lock(&holder.inner)
        .clients
        .retain(|other| !Arc::ptr_eq(other, client));
}

fn answer(client: &Client, id: Value, result: Result<Value, Failure>) {
    let answer = match result {
        Ok(result) => Answer::Result { id, result },
        Err(error) => Answer::Error { id, error },
    };
    client.push(protocol::json(&answer));
}

#[derive(Deserialize)]
struct FormatArgs {
    #[serde(default)]
    format: Option<String>,
    #[serde(default)]
    trim: bool,
    #[serde(default)]
    unwrap: bool,
    /// The history above the screen too.
    #[serde(default)]
    history: bool,
}

#[derive(Deserialize)]
struct AttachArgs {
    /// `snapshot`, the default, or `vt` for a client of another codec.
    #[serde(default)]
    restore: Option<String>,
}

#[derive(Deserialize)]
struct WriteArgs {
    #[serde(default)]
    text: Option<String>,
    /// Bytes, in base64.
    #[serde(default)]
    data: Option<String>,
}

#[derive(Deserialize)]
struct LabelArgs {
    #[serde(default)]
    label: Option<String>,
}

fn args<T: for<'de> Deserialize<'de>>(args: Value) -> Result<T, Failure> {
    let args = if args.is_null() { json!({}) } else { args };
    serde_json::from_value(args).map_err(|error| Failure::bad_request(error.to_string()))
}

fn handle(holder: &Arc<Holder>, client: &Client, request: Request) {
    let Request {
        id,
        method,
        args: raw,
    } = request;
    let mut inner = lock(&holder.inner);
    let result = match method.as_str() {
        "hello" => Ok(json!({
            "protocol": protocol::PROTOCOL,
            "holder": {
                "version": env!("CARGO_PKG_VERSION"),
                "codec": lock(&holder.record).codec,
                "pid": std::process::id(),
            },
            "terminal": holder.describe(&inner),
        })),
        "describe" => Ok(holder.describe(&inner)),
        "subscribe" => {
            client.subscribed.store(true, Ordering::Relaxed);
            Ok(holder.describe(&inner))
        }
        "attach" => match args::<AttachArgs>(raw) {
            // Under the lock, so the answer, the restore and every later output reach this
            // client in that order.
            Ok(args) => {
                let vt = match args.restore.as_deref().unwrap_or("snapshot") {
                    "snapshot" => Ok(false),
                    "vt" => Ok(true),
                    other => Err(Failure::bad_request(format!("no restore {other}"))),
                };
                match vt.and_then(|vt| {
                    restore(&inner.terminal, vt)
                        .map(|restore| (vt, restore))
                        .map_err(|error| Failure::bad_request(error.to_string()))
                }) {
                    Ok((vt, restore)) => {
                        client.subscribed.store(true, Ordering::Relaxed);
                        client.attached.store(true, Ordering::Relaxed);
                        client.vt.store(vt, Ordering::Relaxed);
                        let result = json!({
                            "codec": lock(&holder.record).codec,
                            "restore": restore_name(vt),
                            "snapshot_bytes": restore.len(),
                            "terminal": holder.describe(&inner),
                        });
                        answer(client, id, Ok(result));
                        send_restore(client, &restore);
                        return;
                    }
                    Err(failure) => Err(failure),
                }
            }
            Err(failure) => Err(failure),
        },
        "format" => args::<FormatArgs>(raw).and_then(|args| {
            let format = match args.format.as_deref().unwrap_or("text") {
                "text" | "plain" => Format::Text,
                "vt" => Format::Vt,
                "html" => Format::Html,
                other => return Err(Failure::bad_request(format!("no format {other}"))),
            };
            let formatting = Formatting {
                trim: args.trim,
                unwrap: args.unwrap,
                history: args.history,
            };
            inner
                .terminal
                .format(format, formatting)
                .map(|content| json!({"content": content}))
                .map_err(|error| Failure::bad_request(error.to_string()))
        }),
        "write" => args::<WriteArgs>(raw).and_then(|args| {
            let bytes = match (args.text, args.data) {
                (Some(text), _) => text.into_bytes(),
                (None, Some(data)) => base64::engine::general_purpose::STANDARD
                    .decode(data)
                    .map_err(|error| Failure::bad_request(error.to_string()))?,
                (None, None) => return Err(Failure::bad_request("write takes text or data")),
            };
            holder.write_pty(&bytes);
            Ok(json!({}))
        }),
        "resize" => args::<Size>(raw).and_then(|size| {
            if size.cols == 0 || size.rows == 0 {
                return Err(Failure::bad_request("resize takes cols and rows"));
            }
            let effects = inner
                .terminal
                .resize(size.cols, size.rows)
                .map_err(|error| Failure::bad_request(error.to_string()))?;
            let _ = holder.pty.resize(size);
            if !effects.replies.is_empty() {
                holder.write_pty(&effects.replies);
            }
            for event in effects.events.iter().chain([&Event::SizeChanged(size)]) {
                broadcast(&inner, event);
            }
            Ok(json!(size))
        }),
        "process" => Ok(json!({
            "child": {"pid": holder.pty.child()},
            "foreground": inner.foreground,
        })),
        "pwd" => Ok(json!({"pwd": inner.terminal.pwd()})),
        "title" => Ok(json!({"title": inner.terminal.title()})),
        "size" => Ok(json!(inner.terminal.size())),
        "program_status" => Ok(json!({"records": inner.terminal.program_status()})),
        "set_label" => args::<LabelArgs>(raw).map(|args| {
            inner.label.clone_from(&args.label);
            lock(&holder.record).label.clone_from(&args.label);
            let _ = holder.save_record();
            broadcast(
                &inner,
                &Event::LabelChanged {
                    label: args.label.clone(),
                },
            );
            json!({"label": args.label})
        }),
        "close" => {
            hang_up(holder);
            Ok(json!({}))
        }
        other => Err(Failure {
            code: protocol::Code::MethodNotFound,
            message: format!("no method {other}"),
        }),
    };
    drop(inner);
    answer(client, id, result);
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}
