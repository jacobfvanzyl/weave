//! Terminals through the Host (ADR 0022): `terminals/*` from a real client, against a fake owner
//! that leaves out what weave adds to Rex's model, and against real holders, which outlive the
//! Host that started them.

#![allow(clippy::expect_used)]

use std::collections::BTreeMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::time::Duration;

use agent_client_protocol::Error;
use futures::future::BoxFuture;
use serde_json::Value;
use serde_json::json;
use tokio::sync::mpsc;
use tokio::sync::mpsc::UnboundedReceiver;
use weave_agents::environment::Environment;
use weave_host::Daemon;
use weave_host::DaemonConfig;
use weave_host::terminals::Holders;
use weave_host::terminals::Incoming;
use weave_host::terminals::Launch;
use weave_host::terminals::Outgoing;
use weave_host::terminals::Owner;
use weave_host::terminals::Start;
use weave_host::terminals::Wire;
use weave_host_client::HostConnection;
use weave_host_client::HostEvent;
use weave_host_protocol::errors;
use weave_host_protocol::hello::ClientCapabilities;
use weave_host_protocol::hello::ClientInfo;
use weave_host_protocol::terminals::CloseTerminalRequest;
use weave_host_protocol::terminals::FEATURE;
use weave_host_protocol::terminals::FormatTerminalRequest;
use weave_host_protocol::terminals::ListTerminalsRequest;
use weave_host_protocol::terminals::NewTerminalRequest;
use weave_host_protocol::terminals::SetTerminalLabelRequest;
use weave_host_protocol::terminals::Terminal;
use weave_host_protocol::terminals::TerminalFormat;
use weave_host_protocol::terminals::WatchTerminalsRequest;
use weave_host_protocol::terminals::WriteTerminalRequest;
use weave_host_protocol::worktrees::ReleaseWorktreeRequest;

const WAIT: Duration = Duration::from_secs(20);

const ISOLATED_GIT: &[(&str, &str)] = &[
    ("GIT_CONFIG_GLOBAL", "/dev/null"),
    ("GIT_CONFIG_NOSYSTEM", "1"),
    ("GIT_AUTHOR_NAME", "Test"),
    ("GIT_AUTHOR_EMAIL", "test@example.com"),
    ("GIT_COMMITTER_NAME", "Test"),
    ("GIT_COMMITTER_EMAIL", "test@example.com"),
];

/// A Host with `owner` keeping its terminals, and its agents' environment.
fn daemon(dir: &Path, owner: Option<Arc<dyn Owner>>) -> Daemon {
    let mut vars: BTreeMap<String, String> = ISOLATED_GIT
        .iter()
        .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
        .collect();
    vars.insert("PATH".into(), "/usr/bin:/bin:/usr/sbin:/sbin".into());
    vars.insert("HOME".into(), dir.display().to_string());
    vars.insert("PS1".into(), "$ ".into());
    Daemon::new(DaemonConfig {
        environment: Environment {
            vars,
            ..Environment::default()
        },
        traces: dir.join("traces"),
        terminals: owner,
        ..DaemonConfig::in_process(None)
    })
}

struct Client {
    connection: HostConnection,
    events: UnboundedReceiver<HostEvent>,
}

async fn client(daemon: &Daemon) -> Client {
    let (connection, events) = HostConnection::connect(
        daemon.connect_in_process(),
        ClientInfo {
            name: "test".to_owned(),
            version: "0".to_owned(),
        },
        ClientCapabilities::default(),
    )
    .await
    .expect("connect");
    Client { connection, events }
}

impl Client {
    async fn new_terminal(&self, directory: &Path) -> Terminal {
        self.connection
            .send(NewTerminalRequest {
                directory: directory.to_path_buf(),
                label: Some("dev server".to_owned()),
                opened_from: Some(agent_client_protocol::schema::v1::SessionId::new("s-1")),
                ..NewTerminalRequest::default()
            })
            .await
            .expect("terminals/new")
            .terminal
    }

    async fn list(&self, directory: &Path) -> Vec<Terminal> {
        self.connection
            .send(ListTerminalsRequest {
                directory: directory.to_path_buf(),
            })
            .await
            .expect("terminals/list")
            .terminals
    }

    async fn format(&self, id: &str) -> String {
        self.connection
            .send(FormatTerminalRequest {
                id: id.to_owned(),
                format: TerminalFormat::Text,
                history: true,
                trim: true,
            })
            .await
            .expect("terminals/format")
            .content
    }

    /// Waits for the terminal's screen to hold `text`.
    async fn wait_for_screen(&self, id: &str, text: &str) -> String {
        let deadline = tokio::time::Instant::now() + WAIT;
        loop {
            let screen = self.format(id).await;
            if screen.contains(text) {
                return screen;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "waited for {text:?}; the screen:\n{screen}"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    async fn next_event(&mut self) -> HostEvent {
        tokio::time::timeout(WAIT, self.events.recv())
            .await
            .expect("an event in time")
            .expect("the connection")
    }
}

fn git(dir: &Path, args: &[&str]) {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .envs(ISOLATED_GIT.iter().copied())
        .output()
        .expect("git runs");
    assert!(output.status.success(), "git {args:?}");
}

/// A repository with one commit, by its path with symlinks resolved.
fn repository(dir: &Path) -> PathBuf {
    let repo = dir.join("code/weave");
    std::fs::create_dir_all(repo.join("app")).expect("the repository");
    git(&repo, &["init", "-q", "-b", "main"]);
    std::fs::write(repo.join("README.md"), "weave\n").expect("a file");
    git(&repo, &["add", "README.md"]);
    git(&repo, &["commit", "-q", "-m", "init"]);
    repo.canonicalize().expect("canonical")
}

// A fake owner: terminals in memory, described without `command` or `opened_from`, as an owner
// that isn't a holder may describe them, unless it's told a command runs in them.

#[derive(Default)]
struct FakeOwner {
    terminals: Arc<Mutex<BTreeMap<String, FakeTerminal>>>,
    /// Its terminals say a command runs in them.
    running: bool,
}

struct FakeTerminal {
    start: Start,
    label: Option<String>,
    screen: String,
    connections: Vec<mpsc::Sender<Incoming>>,
}

impl FakeOwner {
    fn running() -> Self {
        Self {
            running: true,
            ..Self::default()
        }
    }
}

fn described(terminal: &FakeTerminal, running: bool) -> Value {
    let mut described = json!({
        "id": terminal.start.id,
        "scope": terminal.start.scope,
        "label": terminal.label,
        "size": {"cols": terminal.start.size.cols, "rows": terminal.start.size.rows},
        "started_at": 1,
    });
    if running {
        described["command"] = json!({"running": true, "command": "npm run dev"});
    }
    described
}

impl Owner for FakeOwner {
    fn find(&self) -> BoxFuture<'_, Vec<String>> {
        let ids = self
            .terminals
            .lock()
            .expect("lock")
            .keys()
            .cloned()
            .collect();
        Box::pin(async move { ids })
    }

    fn start(&self, start: Start) -> BoxFuture<'_, Result<String, Error>> {
        let id = start.id.clone();
        self.terminals.lock().expect("lock").insert(
            id.clone(),
            FakeTerminal {
                label: start.label.clone(),
                start,
                screen: String::new(),
                connections: Vec::new(),
            },
        );
        Box::pin(async move { Ok(id) })
    }

    fn connect<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<Wire, Error>> {
        Box::pin(async move {
            let (outgoing, mut requests) = mpsc::channel::<Outgoing>(64);
            let (incoming_tx, incoming) = mpsc::channel(64);
            self.terminals
                .lock()
                .expect("lock")
                .get_mut(id)
                .ok_or_else(|| errors::unknown_terminal(id))?
                .connections
                .push(incoming_tx.clone());
            let terminals = Arc::clone(&self.terminals);
            let running = self.running;
            let id = id.to_owned();
            tokio::spawn(async move {
                while let Some(message) = requests.recv().await {
                    let Outgoing::Request {
                        id: request,
                        method,
                        args,
                    } = message
                    else {
                        continue;
                    };
                    let (result, events) = {
                        let mut terminals = terminals.lock().expect("lock");
                        let Some(terminal) = terminals.get_mut(&id) else {
                            break;
                        };
                        match method.as_str() {
                            "subscribe" | "describe" => (Ok(described(terminal, running)), vec![]),
                            "set_label" => {
                                terminal.label = args["label"].as_str().map(str::to_owned);
                                (Ok(json!({})), vec![("label_changed", json!({}))])
                            }
                            "write" => {
                                terminal
                                    .screen
                                    .push_str(args["text"].as_str().unwrap_or_default());
                                (Ok(json!({})), vec![])
                            }
                            "format" => (Ok(json!({"content": terminal.screen})), vec![]),
                            "attach" => (
                                Ok(json!({"restore": args["restore"], "snapshot_bytes": 4})),
                                vec![("restore", json!({}))],
                            ),
                            "close" => (
                                Ok(json!({})),
                                vec![("child_exited", json!({"exit_code": 129}))],
                            ),
                            other => (Err(format!("no method {other}")), vec![]),
                        }
                    };
                    let _ = incoming_tx
                        .send(Incoming::Answer {
                            id: request,
                            result,
                        })
                        .await;
                    for (kind, payload) in events {
                        if kind == "restore" {
                            let _ = incoming_tx.send(Incoming::Restore(b"fake".to_vec())).await;
                            continue;
                        }
                        let connections = terminals
                            .lock()
                            .expect("lock")
                            .get(&id)
                            .map(|terminal| terminal.connections.clone())
                            .unwrap_or_default();
                        for connection in connections {
                            let _ = connection
                                .send(Incoming::Event {
                                    kind: kind.to_owned(),
                                    payload: payload.clone(),
                                })
                                .await;
                        }
                        if kind == "child_exited" {
                            terminals.lock().expect("lock").remove(&id);
                        }
                    }
                }
            });
            Ok(Wire { outgoing, incoming })
        })
    }
}

#[tokio::test]
async fn a_host_without_an_owner_has_no_terminals() {
    let dir = tempfile::tempdir().expect("tempdir");
    let daemon = daemon(dir.path(), None);
    let client = client(&daemon).await;
    assert!(
        !client
            .connection
            .hello()
            .features
            .iter()
            .any(|feature| feature == FEATURE)
    );
    let refused = client
        .connection
        .send(ListTerminalsRequest {
            directory: dir.path().to_path_buf(),
        })
        .await;
    assert!(refused.is_err_and(|error| errors::is(&error, errors::TERMINAL_UNAVAILABLE)));
}

#[tokio::test]
async fn terminals_through_the_host_with_an_owner_that_isnt_a_holder() {
    let dir = tempfile::tempdir().expect("tempdir");
    let repo = repository(dir.path());
    let daemon = daemon(dir.path(), Some(Arc::new(FakeOwner::default())));
    let mut client = client(&daemon).await;
    assert!(
        client
            .connection
            .hello()
            .features
            .iter()
            .any(|feature| feature == FEATURE)
    );

    // Watching from a subdirectory watches its worktree.
    let watched = client
        .connection
        .send(WatchTerminalsRequest {
            directory: repo.join("app"),
        })
        .await
        .expect("terminals/watch");
    assert_eq!(watched.scope, repo);
    assert!(watched.terminals.is_empty());

    let terminal = client.new_terminal(&repo.join("app")).await;
    assert_eq!(terminal.scope, repo);
    assert_eq!(terminal.label.as_deref(), Some("dev server"));
    // What weave adds to Rex's model, this owner leaves out.
    assert_eq!(terminal.opened_from, None);
    assert_eq!(terminal.command, None);
    let HostEvent::TerminalUpdated(updated) = client.next_event().await else {
        panic!("terminals/updated");
    };
    assert_eq!(updated.terminal, terminal);
    assert_eq!(client.list(&repo).await, vec![terminal.clone()]);
    // Outside the repository, another scope with none.
    let outside = dir.path().join("elsewhere");
    std::fs::create_dir_all(&outside).expect("a directory");
    assert!(client.list(&outside).await.is_empty());

    let labelled = client
        .connection
        .send(SetTerminalLabelRequest {
            id: terminal.id.clone(),
            label: Some("tests".to_owned()),
        })
        .await
        .expect("terminals/setLabel")
        .terminal;
    assert_eq!(labelled.label.as_deref(), Some("tests"));

    client
        .connection
        .send(WriteTerminalRequest {
            id: terminal.id.clone(),
            text: "make test\r".to_owned(),
        })
        .await
        .expect("terminals/write");
    assert_eq!(client.format(&terminal.id).await, "make test\r");

    client
        .connection
        .send(CloseTerminalRequest {
            id: terminal.id.clone(),
        })
        .await
        .expect("terminals/close");
    loop {
        if let HostEvent::TerminalRemoved(removed) = client.next_event().await {
            assert_eq!(removed.id, terminal.id);
            assert_eq!(removed.scope, repo);
            assert_eq!(removed.exit_code, Some(129));
            break;
        }
    }
    assert!(client.list(&repo).await.is_empty());
    let unknown = client
        .connection
        .send(CloseTerminalRequest { id: terminal.id })
        .await;
    assert!(unknown.is_err_and(|error| errors::is(&error, errors::UNKNOWN_TERMINAL)));
}

#[tokio::test]
async fn a_worktree_with_a_terminal_running_a_command_isnt_released() {
    let dir = tempfile::tempdir().expect("tempdir");
    let repo = repository(dir.path());
    let running = daemon(dir.path(), Some(Arc::new(FakeOwner::running())));
    let client_ = client(&running).await;
    let terminal = client_.new_terminal(&repo).await;
    let refused = client_
        .connection
        .send(ReleaseWorktreeRequest { path: repo.clone() })
        .await;
    let error = refused.expect_err("refused");
    assert!(errors::is(&error, errors::WORKTREE_BUSY));
    assert_eq!(error.data.expect("data")["terminals"], json!([terminal.id]));

    // One that runs nothing is closed with the worktree's sessions.
    let idle = daemon(dir.path(), Some(Arc::new(FakeOwner::default())));
    let mut client = client(&idle).await;
    client
        .connection
        .send(WatchTerminalsRequest {
            directory: repo.clone(),
        })
        .await
        .expect("terminals/watch");
    let terminal = client.new_terminal(&repo).await;
    client
        .connection
        .send(ReleaseWorktreeRequest { path: repo.clone() })
        .await
        .expect("released");
    loop {
        if let HostEvent::TerminalRemoved(removed) = client.next_event().await {
            assert_eq!(removed.id, terminal.id);
            break;
        }
    }
}

// Real holders.

/// `weave-holder`, built once for these tests.
fn holder_binary() -> PathBuf {
    static BINARY: OnceLock<PathBuf> = OnceLock::new();
    BINARY
        .get_or_init(|| {
            let output = std::process::Command::new(env!("CARGO"))
                .args(["build", "-p", "weave-holder", "--message-format=json"])
                .current_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/.."))
                .output()
                .expect("cargo builds weave-holder");
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                .filter(|message| message["target"]["name"] == "weave-holder")
                .find_map(|message| message["executable"].as_str().map(PathBuf::from))
                .expect("weave-holder's executable")
        })
        .clone()
}

fn holders(dir: &Path) -> Arc<dyn Owner> {
    Arc::new(
        Holders::new(dir.join("terminals"), holder_binary(), Launch::Spawn)
            .with_shell(PathBuf::from("/bin/sh")),
    )
}

#[tokio::test(flavor = "multi_thread")]
async fn a_terminal_in_a_holder_outlives_the_host_that_started_it() {
    let dir = tempfile::tempdir().expect("tempdir");
    let cwd = dir.path().canonicalize().expect("canonical");
    let first = daemon(dir.path(), Some(holders(dir.path())));
    let client_ = client(&first).await;
    let terminal = client_.new_terminal(&cwd).await;
    assert_eq!(terminal.scope, cwd);
    assert_eq!(
        terminal
            .opened_from
            .as_ref()
            .map(ToString::to_string)
            .as_deref(),
        Some("s-1")
    );
    assert_eq!(
        terminal.command.as_ref().map(|command| command.running),
        Some(false)
    );
    client_
        .connection
        .send(WriteTerminalRequest {
            id: terminal.id.clone(),
            text: "echo hello-$((6*7))\r".to_owned(),
        })
        .await
        .expect("terminals/write");
    client_.wait_for_screen(&terminal.id, "hello-42").await;
    drop(client_);
    first.stop();
    drop(first);

    // Another Host finds it again, with what it printed.
    let second = daemon(dir.path(), Some(holders(dir.path())));
    let mut client = client(&second).await;
    let found = client.list(&cwd).await;
    assert_eq!(
        found.iter().map(|found| &found.id).collect::<Vec<_>>(),
        [&terminal.id]
    );
    assert_eq!(found[0].label.as_deref(), Some("dev server"));
    client.wait_for_screen(&terminal.id, "hello-42").await;

    client
        .connection
        .send(WatchTerminalsRequest {
            directory: cwd.clone(),
        })
        .await
        .expect("terminals/watch");
    client
        .connection
        .send(CloseTerminalRequest {
            id: terminal.id.clone(),
        })
        .await
        .expect("terminals/close");
    loop {
        if let HostEvent::TerminalRemoved(removed) = client.next_event().await {
            assert_eq!(removed.id, terminal.id);
            break;
        }
    }
    let terminals = dir.path().join("terminals");
    let deadline = tokio::time::Instant::now() + WAIT;
    while terminals.join(format!("{}.json", terminal.id)).exists() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the holder kept its record"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_holder_that_died_is_forgotten() {
    let dir = tempfile::tempdir().expect("tempdir");
    let terminals = dir.path().join("terminals");
    std::fs::create_dir_all(&terminals).expect("the holders' directory");
    std::fs::write(terminals.join("tdead.json"), r#"{"id": "tdead"}"#).expect("a record");
    std::fs::write(terminals.join("tdead.sock"), "").expect("a socket file nobody listens on");
    std::fs::write(terminals.join("tdead.log"), "").expect("a log");
    let daemon = daemon(dir.path(), Some(holders(dir.path())));
    let client = client(&daemon).await;
    assert!(client.list(dir.path()).await.is_empty());
    for leftover in ["tdead.json", "tdead.sock", "tdead.log"] {
        assert!(!terminals.join(leftover).exists(), "{leftover} stayed");
    }
}

// Streams.

type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// `daemon`'s WebSocket on a loopback port of its own.
async fn listen(daemon: &Daemon) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("a port");
    let address = listener.local_addr().expect("its address");
    let serving = daemon.clone();
    tokio::spawn(async move {
        serving
            .serve_remote(listener, weave_host::RemoteConfig::default())
            .await;
    });
    format!("ws://{address}")
}

/// What `weave-holder --version` says its snapshots are.
fn holder_codec() -> String {
    let output = std::process::Command::new(holder_binary())
        .arg("--version")
        .output()
        .expect("weave-holder --version");
    let version = String::from_utf8_lossy(&output.stdout).into_owned();
    let start = version.find('(').expect("a codec") + 1;
    let end = version.rfind(')').expect("a codec");
    version[start..end].to_owned()
}

/// A terminal stream of `ticket`, opened at `size` with `codec`.
async fn stream(url: &str, ticket: &str, size: (u16, u16), codec: &str) -> Socket {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest as _;
    let mut request = url.into_client_request().expect("a request");
    request.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        "weave-terminal".parse().expect("a header"),
    );
    let (mut socket, _) = tokio_tungstenite::connect_async(request)
        .await
        .expect("the stream");
    let open = json!({"ticket": ticket, "size": {"cols": size.0, "rows": size.1}, "codec": codec});
    send_text(&mut socket, open).await;
    socket
}

async fn send_text(socket: &mut Socket, value: Value) {
    use futures::SinkExt as _;
    socket
        .send(tokio_tungstenite::tungstenite::Message::text(
            value.to_string(),
        ))
        .await
        .expect("sent");
}

async fn type_(socket: &mut Socket, text: &str) {
    use futures::SinkExt as _;
    let mut bytes = vec![0x10];
    bytes.extend_from_slice(text.as_bytes());
    socket
        .send(tokio_tungstenite::tungstenite::Message::binary(bytes))
        .await
        .expect("typed");
}

/// What a stream sent: text messages, and the bytes of each binary kind.
#[derive(Default)]
struct Received {
    messages: Vec<Value>,
    restore: Vec<u8>,
    output: Vec<u8>,
    close: Option<u16>,
}

/// Reads `socket` until `done` holds.
async fn read_until(
    socket: &mut Socket,
    received: &mut Received,
    done: impl Fn(&Received) -> bool,
) {
    use futures::StreamExt as _;
    use tokio_tungstenite::tungstenite::Message as Frame;
    let deadline = tokio::time::Instant::now() + WAIT;
    while !done(received) {
        let frame = tokio::time::timeout_at(deadline, socket.next())
            .await
            .unwrap_or_else(|_| {
                panic!(
                    "waited; messages {:?}, output {:?}",
                    received.messages,
                    String::from_utf8_lossy(&received.output)
                )
            });
        match frame {
            Some(Ok(Frame::Text(text))) => received
                .messages
                .push(serde_json::from_str(&text).expect("JSON")),
            Some(Ok(Frame::Binary(bytes))) => match bytes.first() {
                Some(0x01) => received.restore.extend_from_slice(&bytes[1..]),
                Some(0x03) => received.output.extend_from_slice(&bytes[1..]),
                _ => {}
            },
            Some(Ok(Frame::Close(frame))) => {
                received.close = frame.map(|frame| u16::from(frame.code));
                return;
            }
            Some(Ok(_)) => {}
            Some(Err(_)) | None => return,
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stream_relays_a_holders_terminal_to_a_ticket() {
    let dir = tempfile::tempdir().expect("tempdir");
    let cwd = dir.path().canonicalize().expect("canonical");
    let daemon = daemon(dir.path(), Some(holders(dir.path())));
    let url = listen(&daemon).await;
    let client = client(&daemon).await;
    let terminal = client.new_terminal(&cwd).await;
    client
        .connection
        .send(WriteTerminalRequest {
            id: terminal.id.clone(),
            text: "echo before-$((6*7))\r".to_owned(),
        })
        .await
        .expect("terminals/write");
    client.wait_for_screen(&terminal.id, "before-42").await;

    // A client of the holder's codec restores from a snapshot.
    let ticket = client
        .connection
        .send(weave_host_protocol::terminals::AttachTerminalRequest {
            id: terminal.id.clone(),
        })
        .await
        .expect("terminals/attach")
        .ticket;
    let mut socket = stream(&url, &ticket, (100, 30), &holder_codec()).await;
    let mut received = Received::default();
    read_until(&mut socket, &mut received, |received| {
        !received.restore.is_empty()
    })
    .await;
    assert_eq!(received.messages[0]["restore"], "snapshot");
    assert_eq!(received.messages[0]["terminal"]["id"], terminal.id.as_str());

    // Input reaches the shell, and its output comes back.
    type_(&mut socket, "echo stream-$((1+1))\r").await;
    read_until(&mut socket, &mut received, |received| {
        String::from_utf8_lossy(&received.output).contains("stream-2")
    })
    .await;
    // The first stream sized the terminal.
    assert_eq!(
        client.list(&cwd).await[0].size,
        weave_host_protocol::terminals::TerminalSize {
            cols: 100,
            rows: 30
        }
    );

    // A ticket is good once.
    let mut again = stream(&url, &ticket, (80, 24), "x").await;
    let mut refused = Received::default();
    read_until(&mut again, &mut refused, |received| {
        received.close.is_some()
    })
    .await;
    assert_eq!(refused.close, Some(4010));

    // A client of another codec restores from VT, which holds the screen's text.
    let ticket = client
        .connection
        .send(weave_host_protocol::terminals::AttachTerminalRequest {
            id: terminal.id.clone(),
        })
        .await
        .expect("terminals/attach")
        .ticket;
    let mut other = stream(&url, &ticket, (100, 30), "ghostty 0000 snapshot 1").await;
    let mut vt = Received::default();
    read_until(&mut other, &mut vt, |received| {
        String::from_utf8_lossy(&received.restore).contains("stream-2")
    })
    .await;
    assert_eq!(vt.messages[0]["restore"], "vt");

    // The terminal ends: every stream hears it, and is closed.
    client
        .connection
        .send(CloseTerminalRequest {
            id: terminal.id.clone(),
        })
        .await
        .expect("terminals/close");
    read_until(&mut socket, &mut received, |received| {
        received.close.is_some()
    })
    .await;
    assert!(
        received
            .messages
            .iter()
            .any(|message| message.get("exited").is_some()),
        "{:?}",
        received.messages
    );
    assert_eq!(received.close, Some(4011));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_last_device_to_type_sets_the_size() {
    let dir = tempfile::tempdir().expect("tempdir");
    let cwd = dir.path().canonicalize().expect("canonical");
    let daemon = daemon(dir.path(), Some(holders(dir.path())));
    let url = listen(&daemon).await;
    let client = client(&daemon).await;
    let terminal = client.new_terminal(&cwd).await;
    let attach = || async {
        client
            .connection
            .send(weave_host_protocol::terminals::AttachTerminalRequest {
                id: terminal.id.clone(),
            })
            .await
            .expect("terminals/attach")
            .ticket
    };
    let size = || async { client.list(&cwd).await[0].size };
    let wait_for_size = |cols: u16, rows: u16| async move {
        let deadline = tokio::time::Instant::now() + WAIT;
        loop {
            let now = size().await;
            if (now.cols, now.rows) == (cols, rows) {
                return;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "the size stayed {now:?}"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    };

    let mut ipad = stream(&url, &attach().await, (120, 40), "x").await;
    wait_for_size(120, 40).await;
    // Another device joining doesn't resize it, nor does its rotating.
    let mut phone = stream(&url, &attach().await, (50, 30), "x").await;
    send_text(&mut phone, json!({"resize": {"cols": 30, "rows": 50}})).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!((size().await.cols, size().await.rows), (120, 40));
    // Once it types, it does.
    type_(&mut phone, "true\r").await;
    wait_for_size(30, 50).await;
    // And while it's the last to type, its own resizes apply at once.
    send_text(&mut phone, json!({"resize": {"cols": 50, "rows": 30}})).await;
    wait_for_size(50, 30).await;
    // Until the iPad types again.
    type_(&mut ipad, "true\r").await;
    wait_for_size(120, 40).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stream_without_a_good_ticket_is_closed() {
    let dir = tempfile::tempdir().expect("tempdir");
    let daemon = daemon(dir.path(), Some(Arc::new(FakeOwner::default())));
    let url = listen(&daemon).await;
    let mut socket = stream(&url, "made-up", (80, 24), "x").await;
    let mut received = Received::default();
    read_until(&mut socket, &mut received, |received| {
        received.close.is_some()
    })
    .await;
    assert_eq!(received.close, Some(4010));
}

#[tokio::test(flavor = "multi_thread")]
async fn revoking_a_device_closes_its_terminal_streams() {
    use weave_host_client::Credentials;
    use weave_host_client::remote::DeviceKey;
    use weave_host_client::remote::connect_websocket;
    use weave_host_protocol::devices::OfferDeviceRequest;
    use weave_host_protocol::devices::RevokeDeviceRequest;
    use weave_host_protocol::terminals::AttachTerminalRequest;
    use weave_host_protocol::websocket::CLOSE_REVOKED;

    let dir = tempfile::tempdir().expect("tempdir");
    let cwd = dir.path().canonicalize().expect("canonical");
    let daemon = daemon(dir.path(), Some(Arc::new(FakeOwner::default())));
    let url = listen(&daemon).await;
    let local = client(&daemon).await;
    let offer = local
        .connection
        .send(OfferDeviceRequest { name: None })
        .await
        .expect("devices/offer");
    let (transport, _reason) = connect_websocket(&url).await.expect("the WebSocket");
    let (ipad, _events) = HostConnection::connect_with(
        transport,
        ClientInfo {
            name: "weave-ios".to_owned(),
            version: "0".to_owned(),
        },
        ClientCapabilities::default(),
        Credentials::Pair {
            code: offer.code,
            name: "iPad".to_owned(),
            key: DeviceKey::generate(),
        },
    )
    .await
    .expect("paired");
    let device = ipad.hello().device.clone().expect("a device");

    let terminal = local.new_terminal(&cwd).await;
    let ticket = ipad
        .send(AttachTerminalRequest {
            id: terminal.id.clone(),
        })
        .await
        .expect("terminals/attach")
        .ticket;
    let mut socket = stream(&url, &ticket, (80, 24), "x").await;
    let mut received = Received::default();
    read_until(&mut socket, &mut received, |received| {
        !received.restore.is_empty()
    })
    .await;
    assert_eq!(received.restore, b"fake");

    local
        .connection
        .send(RevokeDeviceRequest {
            device_id: device.id,
        })
        .await
        .expect("devices/revoke");
    read_until(&mut socket, &mut received, |received| {
        received.close.is_some()
    })
    .await;
    assert_eq!(received.close, Some(CLOSE_REVOKED));
}
