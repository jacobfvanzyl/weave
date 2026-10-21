//! A remote client for trying the Host's WebSocket by hand (WVE-90's live check): pair a
//! device, list the Host's sessions, and attach to one, prompting it and reconnecting after a
//! dropped network from the last position seen.
//!
//! ```text
//! cargo run -p weave-host-client --example remote -- pair wss://mac.example.ts.net:7341 <code>
//! cargo run -p weave-host-client --example remote -- sessions
//! cargo run -p weave-host-client --example remote -- attach <session-id> [prompt]
//! ```
//!
//! The device's key is kept, unencrypted, in `$WEAVE_REMOTE_DEVICE` (by default
//! `weave-remote-device.json` in the system's temporary directory), mode 0600. Revoke it with
//! `weave devices revoke` when done. `WEAVE_REMOTE_DROP_AFTER=<n>` has `attach` end its
//! connection once after `n` events, as a dropped network would, to try catching up.

#![allow(clippy::expect_used, clippy::print_stdout, clippy::print_stderr)]

use std::path::PathBuf;
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::Deserialize;
use serde::Serialize;
use weave_host_client::Credentials;
use weave_host_client::HostConnection;
use weave_host_client::HostEvent;
use weave_host_client::remote::DeviceKey;
use weave_host_client::remote::connect_websocket;
use weave_host_protocol::events::SessionEvent;
use weave_host_protocol::hello::ClientCapabilities;
use weave_host_protocol::hello::ClientInfo;
use weave_host_protocol::host::StatusRequest;
use weave_host_protocol::sessions::AttachSessionRequest;
use weave_host_protocol::sessions::JournalPosition;
use weave_host_protocol::turns::StartTurnRequest;
use weave_host_protocol::websocket::CLOSE_REVOKED;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Saved {
    url: String,
    host_id: String,
    device_id: String,
    name: String,
    /// The private key, unpadded base64url.
    key: String,
}

fn saved_path() -> PathBuf {
    std::env::var_os("WEAVE_REMOTE_DEVICE")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("weave-remote-device.json"))
}

fn client() -> ClientInfo {
    ClientInfo {
        name: "weave-remote-example".to_owned(),
        version: env!("CARGO_PKG_VERSION").to_owned(),
    }
}

fn load() -> Saved {
    let path = saved_path();
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|_| panic!("no device at {}; pair first", path.display()));
    serde_json::from_str(&text).expect("a saved device")
}

fn save(saved: &Saved) {
    let path = saved_path();
    let json = serde_json::to_string_pretty(saved).expect("serializes");
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    use std::io::Write as _;
    options
        .open(&path)
        .and_then(|mut file| file.write_all(json.as_bytes()))
        .expect("saves the device");
    println!("Saved the device to {}.", path.display());
}

async fn connect(
    saved: &Saved,
) -> Result<
    (
        HostConnection,
        tokio::sync::mpsc::UnboundedReceiver<HostEvent>,
        weave_host_client::remote::CloseReason,
    ),
    String,
> {
    let key = URL_SAFE_NO_PAD
        .decode(&saved.key)
        .ok()
        .and_then(|bytes| DeviceKey::from_bytes(&bytes))
        .expect("a saved key");
    let (transport, reason) = connect_websocket(&saved.url)
        .await
        .map_err(|error| format!("couldn't reach {}: {error}", saved.url))?;
    let (connection, events) = HostConnection::connect_with(
        transport,
        client(),
        ClientCapabilities::default(),
        Credentials::Device {
            device_id: saved.device_id.clone(),
            key,
            host_id: Some(saved.host_id.clone()),
        },
    )
    .await
    .map_err(|error| error.to_string())?;
    Ok((connection, events, reason))
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        ["pair", url, code] => pair(url, code).await,
        ["sessions"] => sessions().await,
        ["attach", session_id] => attach(session_id, None).await,
        ["attach", session_id, prompt] => attach(session_id, Some(prompt)).await,
        _ => {
            eprintln!(
                "usage: remote pair <url> <code> | remote sessions | remote attach <session-id> [prompt]"
            );
            std::process::exit(2);
        }
    }
}

async fn pair(url: &str, code: &str) {
    let key = DeviceKey::generate();
    let (transport, _) = connect_websocket(url).await.expect("the WebSocket");
    let name = format!("{} (test client)", hostname());
    let (connection, _events) = HostConnection::connect_with(
        transport,
        client(),
        ClientCapabilities::default(),
        Credentials::Pair {
            code: code.to_owned(),
            name: name.clone(),
            key: key.clone(),
        },
    )
    .await
    .unwrap_or_else(|error| panic!("pairing failed: {error}"));
    let device = connection.hello().device.clone().expect("a device");
    println!("Paired as {} ({}).", device.name, device.id);
    save(&Saved {
        url: url.to_owned(),
        host_id: connection.hello().host.id.clone(),
        device_id: device.id,
        name: device.name,
        key: URL_SAFE_NO_PAD.encode(key.to_bytes()),
    });
    connection.shutdown().await;
}

fn hostname() -> String {
    std::process::Command::new("hostname")
        .arg("-s")
        .output()
        .ok()
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "this computer".to_owned())
}

async fn sessions() {
    let saved = load();
    let (connection, _events, _) = connect(&saved)
        .await
        .unwrap_or_else(|error| panic!("{error}"));
    let status = connection
        .send(StatusRequest {})
        .await
        .expect("host/status");
    println!(
        "weave Host {} on {}, as {}:",
        status.version, saved.url, saved.name
    );
    for session in status.sessions {
        let title = session.info.title.unwrap_or_default();
        println!(
            "  {}  {:?}  {}  {}",
            session.info.session_id, session.activity, session.agent_id, title
        );
    }
    connection.shutdown().await;
}

/// Attach to `session_id` and print what arrives, prompting it once if asked, and attach
/// again after the last position seen whenever the connection drops.
async fn attach(session_id: &str, mut prompt: Option<&str>) {
    let saved = load();
    let mut position: Option<JournalPosition> = None;
    let mut drop_after: Option<usize> = std::env::var("WEAVE_REMOTE_DROP_AFTER")
        .ok()
        .and_then(|n| n.parse().ok());
    loop {
        let (connection, mut events, reason) = match connect(&saved).await {
            Ok(connected) => connected,
            Err(error) => {
                eprintln!("{error}; trying again");
                tokio::time::sleep(Duration::from_secs(2)).await;
                continue;
            }
        };
        let attached = connection
            .send(AttachSessionRequest {
                session_id: session_id.to_owned().into(),
                after: position.clone(),
                agent_id: None,
                cwd: None,
                trace: false,
            })
            .await
            .expect("session/attach");
        let journal = attached.state.journal.id.clone();
        eprintln!(
            "[attached{}; replaying from {}]",
            if attached.replay.reset {
                ", from the start"
            } else {
                ""
            },
            attached.replay.from
        );
        if let Some(text) = prompt.take() {
            connection
                .send(StartTurnRequest {
                    session_id: session_id.to_owned().into(),
                    prompt: vec![text.to_owned().into()],
                })
                .await
                .expect("turn/start");
        }
        let mut seen = 0;
        while let Some(event) = events.recv().await {
            match event {
                HostEvent::Event(notification) => {
                    position = Some(JournalPosition {
                        journal: journal.clone(),
                        seq: notification.seq,
                    });
                    show(&notification.event);
                    seen += 1;
                    if drop_after == Some(seen) {
                        drop_after = None;
                        eprintln!("\n[dropping the connection]");
                        connection.shutdown().await;
                        break;
                    }
                }
                HostEvent::Disconnected(_) => break,
                _ => {}
            }
        }
        if let Some((code, why)) = reason.get() {
            eprintln!("\n[closed: {code} {why}]");
            if code == CLOSE_REVOKED {
                return;
            }
        } else {
            eprintln!("\n[disconnected]");
        }
        eprintln!("[reconnecting]");
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

fn show(event: &SessionEvent) {
    use agent_client_protocol::schema::v1::ContentBlock;
    use agent_client_protocol::schema::v1::SessionUpdate;
    match event {
        SessionEvent::TurnStarted { prompt, origin, .. } => {
            let text: String = prompt
                .iter()
                .filter_map(|block| match block {
                    ContentBlock::Text(text) => Some(text.text.as_str()),
                    _ => None,
                })
                .collect();
            println!("\n> {text}   [{origin:?}]");
        }
        SessionEvent::Update { notification } => {
            if let SessionUpdate::AgentMessageChunk(chunk) = &notification.update
                && let ContentBlock::Text(text) = &chunk.content
            {
                print!("{}", text.text);
                use std::io::Write as _;
                let _ = std::io::stdout().flush();
            }
        }
        SessionEvent::TurnEnded { .. } => println!("\n[turn ended]"),
        _ => {}
    }
}
