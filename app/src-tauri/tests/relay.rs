//! The core's relay against a dev Host and a dev Dispatcher: the repository's debug `weave`, in
//! directories of their own, so they never touch this computer's Host, its Dispatcher or its
//! pairing. The Dispatcher's WebSocket is on a free loopback port with `--url` set, so pairing
//! turns it on without a Tailscale Serve entry, as the app's `*.host.test.ts` do.
//!
//! Build the binaries first, or this skips: `(cd ../.. && cargo build -p weave-cli)`. With
//! `weave-holder` built too (`-p weave-holder`), the dev Host has terminals, and the test opens
//! their streams as the page does.
//!
//! One test, its steps in order: the core's pairing is the process's `XDG_STATE_HOME`, which
//! only one test may set.

#![allow(clippy::expect_used)]

use std::net::TcpListener;
use std::path::Path;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;

use futures::SinkExt as _;
use futures::StreamExt as _;
use pretty_assertions::assert_eq;
use serde_json::Value;
use serde_json::json;
use tokio::process::Child;
use tokio::process::Command;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest as _;
use weave_app::core::Core;
use weave_app::relay::Incoming;
use weave_app::relay::Sink;
use weave_app::terminals;
use weave_host_protocol::hello::ClientInfo;

const WAIT: Duration = Duration::from_secs(20);

fn weave() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/debug/weave")
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .and_then(|listener| listener.local_addr())
        .map(|address| address.port())
        .expect("a free port")
}

async fn until(what: &str, mut ready: impl AsyncFnMut() -> bool) {
    let deadline = Instant::now() + WAIT;
    while !ready().await {
        assert!(
            Instant::now() < deadline,
            "didn't get {what} within {WAIT:?}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// What a relayed connection told the page.
struct Page {
    incoming: mpsc::UnboundedReceiver<Incoming>,
    /// Messages from a batch not yet taken.
    waiting: Vec<String>,
}

fn page() -> (Sink, Page) {
    let (tx, incoming) = mpsc::unbounded_channel();
    let sink: Sink = Box::new(move |message| tx.send(message).is_ok());
    (
        sink,
        Page {
            incoming,
            waiting: Vec::new(),
        },
    )
}

impl Page {
    /// The next thing the connection says: a message, or how it closed.
    async fn next(&mut self) -> Result<Value, Incoming> {
        loop {
            if !self.waiting.is_empty() {
                let text = self.waiting.remove(0);
                return Ok(serde_json::from_str(&text).expect("JSON"));
            }
            let incoming = tokio::time::timeout(WAIT, self.incoming.recv())
                .await
                .expect("the relay to say something")
                .expect("the relay to be there");
            match incoming {
                Incoming::Messages { texts } => {
                    assert!(!texts.is_empty(), "an empty batch");
                    self.waiting = texts;
                }
                closed => return Err(closed),
            }
        }
    }

    /// The answer to request `id`, past any notification.
    async fn answer(&mut self, id: u64) -> Value {
        loop {
            let message = self
                .next()
                .await
                .expect("an answer, not the connection closing");
            if message["id"] == json!(id) {
                return message;
            }
        }
    }

    async fn closed(&mut self) -> Incoming {
        loop {
            if let Err(closed) = self.next().await {
                return closed;
            }
        }
    }
}

type Stream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// The page's WebSocket at an address the core offered, or how the core refused it.
async fn page_socket(url: &str, origin: Option<&str>, subprotocol: &str) -> Result<Stream, String> {
    let mut request = url.into_client_request().expect("a request");
    request.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        subprotocol.parse().expect("a subprotocol"),
    );
    if let Some(origin) = origin {
        request
            .headers_mut()
            .insert("Origin", origin.parse().expect("an origin"));
    }
    tokio_tungstenite::connect_async(request)
        .await
        .map(|(socket, _)| socket)
        .map_err(|error| error.to_string())
}

/// Opens the stream with `ticket`, types a command, and waits for what it prints: the restore
/// and the output arrive as binary frames, the page's keys go as one.
async fn types_in_a_terminal(mut socket: Stream, ticket: &str) -> Stream {
    let open = json!({"ticket": ticket, "size": {"cols": 70, "rows": 20}, "codec": "a test's"});
    socket
        .send(Message::Text(open.to_string().into()))
        .await
        .expect("sent");
    let mut opened = false;
    let mut typed = false;
    let mut restore = 0_u64;
    let mut output = String::new();
    let deadline = Instant::now() + WAIT;
    while !output.contains("hi-42") {
        let left = deadline.saturating_duration_since(Instant::now());
        let message = tokio::time::timeout(left, socket.next())
            .await
            .expect("the terminal's output")
            .expect("the stream to stay open")
            .expect("a frame");
        match message {
            Message::Text(text) => {
                let message: Value = serde_json::from_str(&text).expect("JSON");
                if !opened {
                    assert_eq!(message["restore"], json!("vt"));
                    assert_eq!(message["terminal"]["size"], json!({"cols": 70, "rows": 20}));
                    restore = message["restoreBytes"].as_u64().expect("a length");
                    opened = true;
                }
            }
            Message::Binary(bytes) => match bytes.first() {
                Some(0x01) => restore = restore.saturating_sub(bytes.len() as u64 - 1),
                Some(0x03) => output.push_str(&String::from_utf8_lossy(&bytes[1..])),
                other => panic!("a frame of kind {other:?}"),
            },
            Message::Close(frame) => panic!("the stream closed: {frame:?}"),
            _ => {}
        }
        if opened && restore == 0 && !typed {
            let mut input = vec![0x10];
            input.extend_from_slice(b"echo hi-$((6*7))\r");
            socket
                .send(Message::Binary(input.into()))
                .await
                .expect("sent");
            typed = true;
        }
    }
    socket
}

fn request(id: u64, method: &str, params: Value) -> String {
    json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}).to_string()
}

fn hello(auth: &str) -> Value {
    json!({
        "protocol": {"min": 3, "max": 3},
        "client": {"name": "weave-app-test", "version": "0"},
        "auth": {"method": auth},
        "capabilities": {},
    })
}

struct Dev {
    root: tempfile::TempDir,
    host: Child,
    dispatcher: Child,
}

impl Dev {
    fn daemon(&self) -> PathBuf {
        self.root.path().join("daemon")
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(weave());
        command
            .args(args)
            .env("WEAVE_DAEMON_DIR", self.daemon())
            .env("WEAVE_DISPATCHER_DIR", self.root.path().join("dispatcher"))
            // Its own state, so nothing reads this computer's pairing.
            .env("XDG_STATE_HOME", self.root.path().join("state"))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        command
    }

    async fn run(&self, args: &[&str]) -> String {
        let output = self.command(args).output().await.expect("weave runs");
        assert!(
            output.status.success(),
            "weave {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).into_owned()
    }

    async fn start() -> Self {
        // Sockets need a short path: macOS allows 104 bytes.
        let root = tempfile::Builder::new()
            .prefix("weave-app-")
            .tempdir_in("/tmp")
            .expect("a directory");
        std::fs::write(root.path().join("config.toml"), "").expect("a config");
        let port = free_port();
        let mut dev = Self {
            root,
            host: Command::new("true").spawn().expect("a placeholder"),
            dispatcher: Command::new("true").spawn().expect("a placeholder"),
        };
        let config = dev.root.path().join("config.toml");
        dev.host = dev
            .command(&["daemon", "run", "--config", &config.display().to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("the dev Host");
        let address = format!("127.0.0.1:{port}");
        let url = format!("ws://{address}");
        dev.dispatcher = dev
            .command(&["dispatcher", "run", "--listen", &address, "--url", &url])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("the dev Dispatcher");
        let (socket, dispatcher_socket) = (
            dev.daemon().join("daemon.sock"),
            dev.root.path().join("dispatcher/dispatcher.sock"),
        );
        until("the dev Host and Dispatcher's sockets", async || {
            socket.exists() && dispatcher_socket.exists()
        })
        .await;
        dev.run(&["hosts", "add", "--name", "dev", "--json"]).await;
        dev
    }

    /// A code the Mac pairs with once, and the URL to pair at.
    async fn offer(&self) -> (String, String) {
        let offered: Value =
            serde_json::from_str(&self.run(&["pair", "--json"]).await).expect("JSON");
        (
            offered["url"].as_str().expect("a url").to_owned(),
            offered["code"].as_str().expect("a code").to_owned(),
        )
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn the_core_relays_this_macs_host_and_the_hosts_the_dispatcher_carries() {
    if !weave().exists() {
        eprintln!("skipped: build weave first, `(cd ../.. && cargo build -p weave-cli)`");
        return;
    }
    let mut dev = Dev::start().await;
    // The core's own pairing, where `paired` keeps it.
    // SAFETY: this is the only test in this binary, and nothing else reads the environment yet.
    unsafe { std::env::set_var("XDG_STATE_HOME", dev.root.path().join("mac")) };
    let core = Arc::new(Core::new(
        ClientInfo {
            name: "weave-app-test".to_owned(),
            version: "0".to_owned(),
        },
        Some(dev.daemon().join("daemon.sock")),
    ));

    // This Mac's Host, over its socket: the core finds its id, and relays the page's hello.
    let local = core
        .local_host()
        .await
        .expect("the dev Host answers on its socket");
    let (sink, mut local_page) = page();
    let id = core.open_local(sink).await.expect("its socket");
    core.relay()
        .send(id, request(1, "host/hello", hello("local")))
        .expect("sent");
    let answer = local_page.answer(1).await;
    assert_eq!(answer["result"]["host"]["id"], json!(local.host_id));

    // Not paired yet: nothing goes through the Dispatcher.
    assert_eq!(core.pairing().expect("read"), None);
    let (sink, _) = page();
    let unpaired = core
        .open_host(&local.host_id, sink)
        .await
        .expect_err("unpaired");
    assert_eq!(unpaired.kind, "unpaired");

    // Pairing with a code: the core proves the new device, saves the pairing, and relays the
    // Dispatcher's API, said hello to.
    let (url, code) = dev.offer().await;
    let (sink, mut api) = page();
    let opened = core
        .pair(&url, &code, "Test Mac", sink)
        .await
        .expect("paired");
    assert_eq!(
        opened
            .hello
            .device
            .as_ref()
            .map(|device| device.name.as_str()),
        Some("Test Mac")
    );
    let pairing = core.pairing().expect("read").expect("a pairing");
    assert_eq!(pairing.url, url);
    assert_eq!(pairing.dispatcher_id, opened.hello.id);
    // The page's requests on it start at 1.
    let mut asked = 0;
    let mut listed = Value::Null;
    until("the dev Host to be listed as connected", async || {
        asked += 1;
        core.relay()
            .send(opened.id, request(asked, "hosts/list", json!({})))
            .expect("sent");
        listed = api.answer(asked).await;
        listed["result"]["hosts"].as_array().is_some_and(|hosts| {
            hosts.iter().any(|host| {
                host["hostId"] == json!(local.host_id) && host["connected"] == json!(true)
            })
        })
    })
    .await;

    // Once paired, the API again, as the app opens it at launch.
    let (sink, mut again) = page();
    let reopened = core.open_dispatcher(sink).await.expect("the API");
    assert_eq!(reopened.hello.id, opened.hello.id);
    core.relay()
        .send(reopened.id, request(1, "hosts/list", json!({})))
        .expect("sent");
    assert!(again.answer(1).await["result"]["hosts"].is_array());

    // The Host, carried through the Dispatcher: the page says hello as the device it names.
    let (sink, mut carried) = page();
    let carried_id = core.open_host(&local.host_id, sink).await.expect("carried");
    core.relay()
        .send(carried_id, request(1, "host/hello", hello("dispatcher")))
        .expect("sent");
    let answer = carried.answer(1).await;
    assert_eq!(answer["result"]["host"]["id"], json!(local.host_id));
    assert_eq!(answer["result"]["device"]["name"], json!("Test Mac"));

    // A Host the Dispatcher doesn't have.
    let (sink, _) = page();
    let unknown = core
        .open_host("no-such-host", sink)
        .await
        .expect_err("refused");
    assert_eq!(unknown.kind, "unavailable");

    // Terminals' streams: the page opens a WebSocket of its own for each, at an address the
    // core offers it once, and speaks the stream on it. This Mac's Host's goes to its terminal
    // socket; another's through the Dispatcher, as the device the core proves.
    if weave().with_file_name("weave-holder").exists() {
        assert_eq!(
            core.offer_terminal_stream(None)
                .expect_err("not listening yet")
                .kind,
            "connection"
        );
        let address = terminals::listen(&core).expect("a loopback port");
        assert!(address.ip().is_loopback());
        let directory = dev.root.path().display().to_string();
        core.relay()
            .send(
                id,
                request(2, "terminals/new", json!({"directory": directory})),
            )
            .expect("sent");
        let terminal = local_page.answer(2).await["result"]["terminal"]["id"]
            .as_str()
            .expect("a terminal")
            .to_owned();

        // Only at an address offered, once, and only from the app's own page.
        let offered = core.offer_terminal_stream(None).expect("an address");
        assert!(offered.starts_with(&format!("ws://{address}/")));
        let elsewhere = format!("ws://{address}/{}", "0".repeat(64));
        assert!(
            page_socket(&elsewhere, None, "weave-terminal")
                .await
                .is_err()
        );
        let other_page = core.offer_terminal_stream(None).expect("an address");
        assert!(
            page_socket(&other_page, Some("https://example.com"), "weave-terminal")
                .await
                .is_err()
        );
        let not_a_stream = core.offer_terminal_stream(None).expect("an address");
        assert!(
            page_socket(&not_a_stream, Some("tauri://localhost"), "something-else")
                .await
                .is_err()
        );

        // This Mac's Host's, with the ticket its socket gave.
        core.relay()
            .send(id, request(3, "terminals/attach", json!({"id": terminal})))
            .expect("sent");
        let ticket = local_page.answer(3).await["result"]["ticket"]
            .as_str()
            .expect("a ticket")
            .to_owned();
        let socket = page_socket(&offered, Some("tauri://localhost"), "weave-terminal")
            .await
            .expect("the stream");
        assert!(
            page_socket(&offered, Some("tauri://localhost"), "weave-terminal")
                .await
                .is_err(),
            "an address is good once"
        );
        let mut local_stream = types_in_a_terminal(socket, &ticket).await;
        assert_eq!(core.streams().len(), 1);

        // The same terminal through the Dispatcher: the ticket is the carried connection's
        // device's, which the stream's is too.
        core.relay()
            .send(
                carried_id,
                request(2, "terminals/attach", json!({"id": terminal})),
            )
            .expect("sent");
        let ticket = carried.answer(2).await["result"]["ticket"]
            .as_str()
            .expect("a ticket")
            .to_owned();
        let offered = core
            .offer_terminal_stream(Some(&local.host_id))
            .expect("an address");
        let socket = page_socket(&offered, Some("tauri://localhost"), "weave-terminal")
            .await
            .expect("the stream");
        let carried_stream = types_in_a_terminal(socket, &ticket).await;
        assert_eq!(core.streams().len(), 2);
        drop(carried_stream);

        // A ticket that isn't the Host's: its close, with its code, reaches the page.
        let offered = core.offer_terminal_stream(None).expect("an address");
        let mut refused = page_socket(&offered, None, "weave-terminal")
            .await
            .expect("the stream");
        let open =
            json!({"ticket": "nonsense", "size": {"cols": 70, "rows": 20}, "codec": "a test's"});
        refused
            .send(Message::Text(open.to_string().into()))
            .await
            .expect("sent");
        let closed = loop {
            match tokio::time::timeout(WAIT, refused.next())
                .await
                .expect("a close")
            {
                Some(Ok(Message::Close(frame))) => break frame.map(|frame| u16::from(frame.code)),
                Some(Ok(_)) => {}
                other => panic!("the stream ended without a close: {other:?}"),
            }
        };
        assert_eq!(closed, Some(4010));

        // A Host the Dispatcher doesn't have: the page hears why as the stream closes.
        let offered = core
            .offer_terminal_stream(Some("no-such-host"))
            .expect("an address");
        let mut nowhere = page_socket(&offered, None, "weave-terminal")
            .await
            .expect("the stream");
        match tokio::time::timeout(WAIT, nowhere.next())
            .await
            .expect("a close")
        {
            Some(Ok(Message::Close(Some(frame)))) => assert_eq!(u16::from(frame.code), 1011),
            other => panic!("expected a close with why, got {other:?}"),
        }

        // The page loading again: its streams go, and the keys it hadn't used.
        let unused = core.offer_terminal_stream(None).expect("an address");
        core.streams().close_all();
        until("the streams to end", async || core.streams().is_empty()).await;
        assert!(page_socket(&unused, None, "weave-terminal").await.is_err());
        assert!(
            tokio::time::timeout(WAIT, async {
                while let Some(Ok(_)) = local_stream.next().await {}
            })
            .await
            .is_ok(),
            "the page's socket ends with its stream"
        );
        core.relay()
            .send(id, request(4, "terminals/close", json!({"id": terminal})))
            .expect("sent");
        local_page.answer(4).await;
    } else {
        eprintln!(
            "skipped terminals: build the holder, `(cd ../.. && cargo build -p weave-holder)`"
        );
    }

    // The page closing a connection: the core lets it go, and the page hears nothing more.
    let open = core.relay().len();
    core.relay().close(carried_id);
    assert_eq!(core.relay().len(), open - 1);

    // A page that's gone: the next message finds no one, and the core closes the connection.
    let (sink, page_gone) = page();
    let gone = core.open_local(sink).await.expect("its socket");
    drop(page_gone);
    core.relay()
        .send(gone, request(1, "host/hello", hello("local")))
        .expect("sent");
    until("the core to let a gone page's connection go", async || {
        core.relay().send(gone, String::new()).is_err()
    })
    .await;

    // The Host stopping: the page hears its connections end.
    dev.host.kill().await.expect("stopped");
    assert_eq!(
        local_page.closed().await,
        Incoming::Closed {
            code: None,
            reason: None
        }
    );

    // Forgetting the pairing: nothing goes through the Dispatcher again until the Mac pairs.
    core.forget().expect("forgot");
    assert_eq!(core.pairing().expect("read"), None);
    let (sink, _) = page();
    assert_eq!(
        core.open_dispatcher(sink).await.expect_err("unpaired").kind,
        "unpaired"
    );

    core.relay().close_all();
    let _ = dev.dispatcher.kill().await;
}
