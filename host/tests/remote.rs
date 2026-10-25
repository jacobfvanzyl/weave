//! Remote clients end to end: a Host serving its WebSocket on a loopback port, paired devices
//! connecting through `weave-host-client`'s WebSocket transport, and in-process fake agents.
//! The spec is `docs/specs/wve-90-remote-clients.md`.

#![allow(clippy::expect_used)]

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use agent_client_protocol::Channel;
use agent_client_protocol::ConnectionTo;
use agent_client_protocol::Error;
use agent_client_protocol::Role as _;
use futures::StreamExt as _;
use futures::future::BoxFuture;
use pretty_assertions::assert_eq;
use tokio::sync::mpsc::UnboundedReceiver;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest as _;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use weave_acp_core::AgentConnection;
use weave_acp_core::ClientOptions;
use weave_acp_core::schema::ContentBlock;
use weave_agents::environment::Environment;
use weave_fake_agent::FakeAgentConfig;
use weave_host::Daemon;
use weave_host::DaemonConfig;
use weave_host::Launch;
use weave_host::Launcher;
use weave_host::RemoteConfig;
use weave_host::RemoteSettings;
use weave_host::Serve;
use weave_host::Withheld;
use weave_host_client::ConnectError;
use weave_host_client::Credentials;
use weave_host_client::HostConnection;
use weave_host_client::HostEvent;
use weave_host_client::remote::CloseReason;
use weave_host_client::remote::DeviceKey;
use weave_host_client::remote::connect_websocket;
use weave_host_protocol::Host;
use weave_host_protocol::HostClient;
use weave_host_protocol::VersionRange;
use weave_host_protocol::agents::LogoutAgentRequest;
use weave_host_protocol::agents::UpdateAgentRequest;
use weave_host_protocol::devices::DeviceInfo;
use weave_host_protocol::devices::ListDevicesRequest;
use weave_host_protocol::devices::OfferDeviceRequest;
use weave_host_protocol::devices::RevokeDeviceRequest;
use weave_host_protocol::devices::auth_message;
use weave_host_protocol::errors;
use weave_host_protocol::events::SessionEvent;
use weave_host_protocol::files::ListFilesRequest;
use weave_host_protocol::hello::Auth;
use weave_host_protocol::hello::ChallengeRequest;
use weave_host_protocol::hello::ClientCapabilities;
use weave_host_protocol::hello::ClientInfo;
use weave_host_protocol::hello::HelloRequest;
use weave_host_protocol::host::Service;
use weave_host_protocol::host::ShutdownRequest;
use weave_host_protocol::host::StatusRequest;
use weave_host_protocol::sessions::AttachSessionRequest;
use weave_host_protocol::sessions::CreateSessionRequest;
use weave_host_protocol::sessions::TurnOrigin;
use weave_host_protocol::sessions::WatchSessionsRequest;
use weave_host_protocol::turns::StartTurnRequest;
use weave_host_protocol::websocket::APP_ORIGIN;
use weave_host_protocol::websocket::CLOSE_REVOKED;
use weave_host_protocol::websocket::CLOSE_UNAUTHENTICATED;
use weave_host_protocol::websocket::SUBPROTOCOL;

const WAIT: Duration = Duration::from_secs(10);

struct World {
    dir: tempfile::TempDir,
}

impl World {
    fn new() -> Self {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            dir.path().join("config.toml"),
            "[agents.fake]\ncommand = \"fake-agent\"\n",
        )
        .expect("config");
        Self { dir }
    }

    fn daemon(&self) -> Daemon {
        Daemon::new(self.config())
    }

    /// A Host whose remote access pairing turns on, with `serve` for its Serve entry.
    fn daemon_with_remote(&self, serve: Arc<FakeServe>, offer_lifetime: Duration) -> Daemon {
        let mut settings = RemoteSettings::new(serve);
        settings.listen = "127.0.0.1:0".parse().expect("an address");
        settings.offer_lifetime = offer_lifetime;
        settings.serve_retry = Duration::from_millis(50);
        Daemon::new(DaemonConfig {
            remote: Some(settings),
            ..self.config()
        })
    }

    fn config(&self) -> DaemonConfig {
        let state: PathBuf = self.dir.path().join("agent-state.json");
        let launcher: Launcher = Arc::new(move |_launch: &Launch, options: ClientOptions, _| {
            let config = FakeAgentConfig {
                state_path: Some(state.clone()),
                ..FakeAgentConfig::default()
            };
            Box::pin(async move {
                let (client, agent) = Channel::duplex();
                tokio::spawn(weave_fake_agent::serve_with(agent, config));
                AgentConnection::connect(client, options)
                    .await
                    .map_err(|error| Error::internal_error().data(error.to_string()))
            })
        });
        DaemonConfig {
            journals: None,
            idle_grace: Duration::from_secs(60),
            blank_grace: Duration::from_secs(60),
            launcher,
            config_file: Some(self.dir.path().join("config.toml")),
            registry_cache: Some(self.dir.path().join("cache")),
            agents: Default::default(),
            withheld: Withheld::default(),
            environment: Environment::default(),
            service: Service::InProcess,
            traces: self.dir.path().join("traces"),
            devices: Some(self.dir.path().join("devices.json")),
            upstream: Arc::new(weave_agents::update::Offline),
            mcp_socket: None,
            mcp_bridge: vec!["weave-mcp-bridge".to_owned()],
            remote: None,
        }
    }
}

/// A Tailscale Serve that records what the Host asks of it, and hands out `ws://` URLs.
#[derive(Default)]
struct FakeServe {
    calls: std::sync::Mutex<Vec<String>>,
    /// Why `ensure` fails, while it should.
    refuse: std::sync::Mutex<Option<String>>,
}

impl FakeServe {
    fn calls(&self) -> Vec<String> {
        self.calls.lock().expect("calls").clone()
    }

    fn refuse(&self, why: Option<&str>) {
        *self.refuse.lock().expect("refuse") = why.map(str::to_owned);
    }
}

impl Serve for FakeServe {
    fn ensure(&self, listen: SocketAddr) -> BoxFuture<'_, Result<String, String>> {
        Box::pin(async move {
            self.calls.lock().expect("calls").push("ensure".to_owned());
            match self.refuse.lock().expect("refuse").clone() {
                Some(why) => Err(why),
                None => Ok(format!("ws://{listen}")),
            }
        })
    }

    fn remove(&self, _listen: SocketAddr) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            self.calls.lock().expect("calls").push("remove".to_owned());
            Ok(())
        })
    }
}

/// Where the Host's WebSocket listens, as `host/status` says, while remote access is on.
async fn remote_address(local: &HostConnection) -> Option<String> {
    local
        .send(StatusRequest {})
        .await
        .expect("host/status")
        .remote
}

/// Wait until nothing listens at `address` any more.
async fn closed(address: &str) {
    let deadline = tokio::time::Instant::now() + WAIT;
    while tokio::net::TcpStream::connect(address).await.is_ok() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "{address} still listens"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// `daemon`'s WebSocket on a loopback port of its own.
async fn listen(daemon: &Daemon, config: RemoteConfig) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("a port");
    let address: SocketAddr = listener.local_addr().expect("its address");
    let serving = daemon.clone();
    tokio::spawn(async move { serving.serve_remote(listener, config).await });
    format!("ws://{address}")
}

fn info(name: &str) -> ClientInfo {
    ClientInfo {
        name: name.to_owned(),
        version: "0".to_owned(),
    }
}

async fn local(daemon: &Daemon) -> (HostConnection, UnboundedReceiver<HostEvent>) {
    HostConnection::connect(
        daemon.connect_in_process(),
        info("weave"),
        ClientCapabilities::default(),
    )
    .await
    .expect("a local client")
}

async fn remote(
    url: &str,
    credentials: Credentials,
) -> (
    Result<(HostConnection, UnboundedReceiver<HostEvent>), ConnectError>,
    CloseReason,
) {
    let (transport, reason) = connect_websocket(url).await.expect("the WebSocket");
    let connected = HostConnection::connect_with(
        transport,
        info("weave-ios"),
        ClientCapabilities::default(),
        credentials,
    )
    .await;
    (connected, reason)
}

/// Pair a new device through `local`, which makes the offer.
async fn pair(local: &HostConnection, url: &str, name: &str) -> (DeviceInfo, DeviceKey) {
    let offer = local
        .send(OfferDeviceRequest { name: None })
        .await
        .expect("devices/offer");
    let key = DeviceKey::generate();
    let (connected, _) = remote(
        url,
        Credentials::Pair {
            code: offer.code,
            name: name.to_owned(),
            key: key.clone(),
        },
    )
    .await;
    let (connection, _) = connected.expect("paired");
    let device = connection.hello().device.clone().expect("a device");
    connection.shutdown().await;
    (device, key)
}

fn device(device: &DeviceInfo, key: &DeviceKey, host_id: Option<String>) -> Credentials {
    Credentials::Device {
        device_id: device.id.clone(),
        key: key.clone(),
        host_id,
    }
}

async fn next(events: &mut UnboundedReceiver<HostEvent>) -> HostEvent {
    tokio::time::timeout(WAIT, events.recv())
        .await
        .expect("an event in time")
        .expect("the connection is open")
}

/// Wait for the connection to end.
async fn disconnected(events: &mut UnboundedReceiver<HostEvent>) {
    loop {
        if let HostEvent::Disconnected(_) = next(events).await {
            return;
        }
    }
}

#[tokio::test]
async fn a_device_pairs_once_and_connects_with_its_key_after_that() {
    let world = World::new();
    let daemon = world.daemon();
    let url = listen(&daemon, RemoteConfig::default()).await;
    let (local, mut local_events) = local(&daemon).await;
    let host_id = local.hello().host.id.clone();
    assert!(!host_id.is_empty());

    let offer = local
        .send(OfferDeviceRequest {
            name: Some("Jaco's iPad".to_owned()),
        })
        .await
        .expect("devices/offer");
    let key = DeviceKey::generate();
    let pairing = Credentials::Pair {
        code: offer.code.clone(),
        name: "iPad".to_owned(),
        key: key.clone(),
    };
    let (connected, _) = remote(&url, pairing.clone()).await;
    let (paired, _) = connected.expect("paired");
    let device = paired.hello().device.clone().expect("the device");
    assert_eq!(device.name, "Jaco's iPad", "the offer's name wins");
    loop {
        if let HostEvent::DevicePaired(notification) = next(&mut local_events).await {
            assert_eq!(notification.device.id, device.id);
            break;
        }
    }
    paired.shutdown().await;

    // The code is used up.
    let (again, reason) = remote(&url, pairing).await;
    assert!(matches!(again, Err(ConnectError::Refused(_))));
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(
        reason.get().map(|(code, _)| code),
        Some(CLOSE_UNAUTHENTICATED)
    );

    // From now on, the device signs a challenge.
    let (connected, _) = remote(&url, self::device(&device, &key, Some(host_id))).await;
    let (connection, _) = connected.expect("the device connects");
    assert_eq!(connection.hello().device, Some(device.clone()));
    let devices = local
        .send(ListDevicesRequest {})
        .await
        .expect("devices/list")
        .devices;
    assert_eq!(devices.len(), 1);
    assert_eq!(
        (devices[0].id.clone(), devices[0].connections),
        (device.id, 1)
    );
    connection.shutdown().await;
}

#[tokio::test]
async fn wrong_keys_unknown_devices_and_local_auth_are_refused_alike() {
    let world = World::new();
    let daemon = world.daemon();
    let url = listen(&daemon, RemoteConfig::default()).await;
    let (local, _local_events) = local(&daemon).await;
    let (device, _key) = pair(&local, &url, "iPad").await;

    let attempts = [
        self::device(&device, &DeviceKey::generate(), None),
        Credentials::Device {
            device_id: "d-nobody".to_owned(),
            key: DeviceKey::generate(),
            host_id: None,
        },
        Credentials::Local,
    ];
    let mut messages = Vec::new();
    for credentials in attempts {
        let (connected, reason) = remote(&url, credentials).await;
        let Err(ConnectError::Refused(error)) = connected else {
            panic!("refused");
        };
        assert!(errors::is(&error, errors::UNAUTHENTICATED), "{error}");
        messages.push(error.message);
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(
            reason.get().map(|(code, _)| code),
            Some(CLOSE_UNAUTHENTICATED)
        );
    }
    messages.dedup();
    assert_eq!(
        messages.len(),
        1,
        "every failure reads the same: {messages:?}"
    );

    // A device checks the challenge comes from its own Host before signing.
    let (connected, _) = remote(
        &url,
        self::device(&device, &_key, Some("another-host".to_owned())),
    )
    .await;
    assert!(matches!(connected, Err(ConnectError::WrongHost)));
}

/// A raw client over the WebSocket, to send what `weave-host-client` wouldn't.
async fn raw(url: &str) -> (ConnectionTo<Host>, tokio::task::JoinHandle<()>) {
    let (transport, _) = connect_websocket(url).await.expect("the WebSocket");
    let (cx_tx, cx_rx) = tokio::sync::oneshot::channel();
    let driver = tokio::spawn(async move {
        let _ = HostClient
            .builder()
            .connect_with(transport, async move |cx: ConnectionTo<Host>| {
                let _ = cx_tx.send(cx.clone());
                cx.incoming_closed().await;
                Ok(())
            })
            .await;
    });
    (cx_rx.await.expect("connected"), driver)
}

#[tokio::test]
async fn a_challenge_is_good_for_one_hello() {
    let world = World::new();
    let daemon = world.daemon();
    let url = listen(&daemon, RemoteConfig::default()).await;
    let (local, _local_events) = local(&daemon).await;
    let (device, key) = pair(&local, &url, "iPad").await;

    let (cx, driver) = raw(&url).await;
    let challenge = cx
        .send_request(ChallengeRequest {})
        .block_task()
        .await
        .expect("host/challenge");
    let hello = HelloRequest {
        protocol: VersionRange::supported(),
        client: info("raw"),
        auth: Auth::Device {
            device_id: device.id.clone(),
            signature: key.sign(&auth_message(
                &challenge.host_id,
                &device.id,
                &challenge.nonce,
            )),
        },
        capabilities: ClientCapabilities::default(),
    };
    cx.send_request(hello.clone())
        .block_task()
        .await
        .expect("the first hello");
    let replayed = cx
        .send_request(hello)
        .block_task()
        .await
        .expect_err("the same signature again");
    assert!(errors::is(&replayed, errors::UNAUTHENTICATED), "{replayed}");
    driver.abort();
}

#[tokio::test]
async fn the_socket_takes_no_device_auth_and_gives_no_challenges() {
    let world = World::new();
    let daemon = world.daemon();
    let (local, _events) = local(&daemon).await;
    let challenge = local
        .send(ChallengeRequest {})
        .await
        .expect_err("no challenge for a local client");
    assert!(
        errors::is(&challenge, errors::UNAUTHENTICATED),
        "{challenge}"
    );
    let (connected, _) = (
        HostConnection::connect_with(
            daemon.connect_in_process(),
            info("weave"),
            ClientCapabilities::default(),
            Credentials::Pair {
                code: "x".to_owned(),
                name: "iPad".to_owned(),
                key: DeviceKey::generate(),
            },
        )
        .await,
        (),
    );
    assert!(matches!(connected, Err(ConnectError::Refused(_))));
}

#[tokio::test]
async fn remote_clients_do_everything_but_administer_the_host() {
    let world = World::new();
    let daemon = world.daemon();
    let url = listen(&daemon, RemoteConfig::default()).await;
    let (local, _local_events) = local(&daemon).await;
    let (device, key) = pair(&local, &url, "Jaco's iPad").await;
    let (connected, _) = remote(&url, self::device(&device, &key, None)).await;
    let (remote, mut events) = connected.expect("connects");

    for refused in [
        remote.send(ShutdownRequest {}).await.map(|_| ()),
        remote.send(ListDevicesRequest {}).await.map(|_| ()),
        remote
            .send(OfferDeviceRequest { name: None })
            .await
            .map(|_| ()),
        remote
            .send(RevokeDeviceRequest {
                device_id: device.id.clone(),
            })
            .await
            .map(|_| ()),
        remote
            .send(LogoutAgentRequest {
                agent_id: "fake".to_owned(),
            })
            .await
            .map(|_| ()),
        remote
            .send(UpdateAgentRequest {
                agent_id: "claude".to_owned(),
            })
            .await
            .map(|_| ()),
    ] {
        let error = refused.expect_err("forbidden");
        assert!(errors::is(&error, errors::FORBIDDEN), "{error}");
    }
    remote.send(StatusRequest {}).await.expect("host/status");
    // Watching the Host's sessions isn't administering it.
    let watched = remote
        .send(WatchSessionsRequest {})
        .await
        .expect("sessions/watch");
    assert_eq!(watched.sessions, Vec::new());
    // Nor is listing a directory.
    let listed = remote
        .send(ListFilesRequest {
            path: Some(world.dir.path().to_path_buf()),
            hidden: false,
        })
        .await
        .expect("files/list");
    assert_eq!(listed.path, world.dir.path());

    // A session and a turn, whose origin names the device.
    let state = remote
        .send(CreateSessionRequest {
            agent_id: "fake".to_owned(),
            cwd: world.dir.path().to_path_buf(),
            additional_directories: Vec::new(),
            mode: None,
            policy: None,
            trace: false,
        })
        .await
        .expect("session/create");
    remote
        .send(StartTurnRequest {
            session_id: state.session_id.clone(),
            prompt: vec![ContentBlock::from("hello".to_owned())],
            key: None,
        })
        .await
        .expect("turn/start");
    loop {
        if let HostEvent::Event(notification) = next(&mut events).await
            && let SessionEvent::TurnStarted { origin, .. } = notification.event
        {
            let TurnOrigin::Client { device, .. } = origin else {
                panic!("a client's turn");
            };
            assert_eq!(device.as_deref(), Some("Jaco's iPad"));
            break;
        }
    }
    // Prompted, the watched session appears.
    loop {
        if let HostEvent::SessionUpdated(updated) = next(&mut events).await {
            assert_eq!(updated.session.info.session_id, state.session_id);
            break;
        }
    }
    remote.shutdown().await;
}

#[tokio::test]
async fn a_replay_many_times_the_limit_arrives_whole() {
    let world = World::new();
    let daemon = world.daemon();
    let limit = 64 * 1024;
    let config = RemoteConfig {
        behind_limit: limit,
        ..RemoteConfig::default()
    };
    let url = listen(&daemon, config).await;
    let (local, mut local_events) = local(&daemon).await;
    let (device, key) = pair(&local, &url, "iPhone").await;

    // A thread with a long journal: each prompt and the agent's echo of it are twice the limit.
    let state = local
        .send(CreateSessionRequest {
            agent_id: "fake".to_owned(),
            cwd: world.dir.path().to_path_buf(),
            additional_directories: Vec::new(),
            mode: None,
            policy: None,
            trace: false,
        })
        .await
        .expect("session/create");
    for _ in 0..4 {
        local
            .send(StartTurnRequest {
                session_id: state.session_id.clone(),
                prompt: vec![ContentBlock::from("x".repeat(limit * 2))],
                key: None,
            })
            .await
            .expect("turn/start");
        loop {
            if let HostEvent::Event(notification) = next(&mut local_events).await
                && let SessionEvent::TurnEnded { .. } = notification.event
            {
                break;
            }
        }
    }

    // A phone opening it gets all of it, though it all waits to be sent at once.
    let (connected, reason) = remote(&url, self::device(&device, &key, None)).await;
    let (remote, mut events) = connected.expect("connects");
    let attached = remote
        .send(AttachSessionRequest {
            session_id: state.session_id.clone(),
            after: None,
            agent_id: None,
            cwd: None,
            trace: false,
        })
        .await
        .expect("session/attach");
    let head = attached.state.journal.head;
    let mut replayed = 0;
    loop {
        match next(&mut events).await {
            HostEvent::Event(notification) => {
                replayed += serde_json::to_vec(&notification).expect("JSON").len();
                if notification.seq == head {
                    break;
                }
            }
            HostEvent::Disconnected(_) => panic!("closed: {:?}", reason.get()),
            _ => {}
        }
    }
    assert!(replayed > 8 * limit, "{replayed} bytes replayed");
    remote
        .send(StatusRequest {})
        .await
        .expect("still connected");
    assert_eq!(reason.get(), None);
    remote.shutdown().await;
}

#[tokio::test]
async fn revoking_a_device_closes_its_connections() {
    let world = World::new();
    let daemon = world.daemon();
    let url = listen(&daemon, RemoteConfig::default()).await;
    let (local, _local_events) = local(&daemon).await;
    let (device, key) = pair(&local, &url, "iPad").await;
    let (connected, reason) = remote(&url, self::device(&device, &key, None)).await;
    let (_remote, mut events) = connected.expect("connects");

    local
        .send(RevokeDeviceRequest {
            device_id: device.id.clone(),
        })
        .await
        .expect("devices/revoke");
    disconnected(&mut events).await;
    assert_eq!(reason.get().map(|(code, _)| code), Some(CLOSE_REVOKED));
    let (again, _) = remote(&url, self::device(&device, &key, None)).await;
    assert!(matches!(again, Err(ConnectError::Refused(_))));
    let devices = local.send(ListDevicesRequest {}).await.expect("list");
    assert!(devices.devices.is_empty());
}

/// An upgrade with `subprotocol` and `origin`, answered or refused.
async fn upgrade(
    url: &str,
    subprotocol: Option<&str>,
    origin: Option<&str>,
) -> Result<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    u16,
> {
    let mut request = url.into_client_request().expect("a request");
    if let Some(subprotocol) = subprotocol {
        request.headers_mut().insert(
            "Sec-WebSocket-Protocol",
            HeaderValue::from_str(subprotocol).expect("a header"),
        );
    }
    if let Some(origin) = origin {
        request
            .headers_mut()
            .insert("Origin", HeaderValue::from_str(origin).expect("a header"));
    }
    match tokio_tungstenite::connect_async(request).await {
        Ok((socket, _)) => Ok(socket),
        Err(tokio_tungstenite::tungstenite::Error::Http(response)) => {
            Err(response.status().as_u16())
        }
        Err(error) => panic!("{error}"),
    }
}

#[tokio::test]
async fn upgrades_need_the_subprotocol_and_an_allowed_origin() {
    let world = World::new();
    let daemon = world.daemon();
    let url = listen(
        &daemon,
        RemoteConfig {
            origins: vec!["https://allowed.example.com".to_owned()],
            ..RemoteConfig::default()
        },
    )
    .await;
    assert_eq!(upgrade(&url, None, None).await.err(), Some(400));
    assert_eq!(
        upgrade(&url, Some(SUBPROTOCOL), Some("https://example.com"))
            .await
            .err(),
        Some(403)
    );
    assert!(upgrade(&url, Some(SUBPROTOCOL), None).await.is_ok());
    // The app's origin needs no config (ADR 0016); others need listing.
    assert!(
        upgrade(
            &url,
            Some(&format!("other, {SUBPROTOCOL}")),
            Some(APP_ORIGIN)
        )
        .await
        .is_ok()
    );
    assert!(
        upgrade(&url, Some(SUBPROTOCOL), Some("https://allowed.example.com"))
            .await
            .is_ok()
    );
}

#[tokio::test]
async fn a_client_that_proves_no_device_in_time_is_closed() {
    let world = World::new();
    let daemon = world.daemon();
    let config = RemoteConfig {
        hello_deadline: Duration::from_millis(200),
        ..RemoteConfig::default()
    };
    let url = listen(&daemon, config).await;
    let (local, _local_events) = local(&daemon).await;
    let (device, key) = pair(&local, &url, "iPad").await;
    let (connected, _) = remote(&url, self::device(&device, &key, None)).await;
    let (proved, _events) = connected.expect("connects");

    let (transport, reason) = connect_websocket(&url).await.expect("the WebSocket");
    let (cx_tx, cx_rx) = tokio::sync::oneshot::channel();
    let silent = tokio::spawn(async move {
        let _ = HostClient
            .builder()
            .connect_with(transport, async move |cx: ConnectionTo<Host>| {
                let _ = cx_tx.send(cx.clone());
                cx.incoming_closed().await;
                Ok(())
            })
            .await;
    });
    drop(cx_rx.await.expect("connected"));
    tokio::time::timeout(WAIT, silent)
        .await
        .expect("closed in time")
        .expect("ended");
    assert_eq!(
        reason.get().map(|(code, _)| code),
        Some(CLOSE_UNAUTHENTICATED)
    );
    tokio::time::sleep(Duration::from_millis(300)).await;
    proved
        .send(StatusRequest {})
        .await
        .expect("a proved device stays");
}

#[tokio::test]
async fn a_client_that_stops_answering_pings_is_closed() {
    let world = World::new();
    let daemon = world.daemon();
    let config = RemoteConfig {
        ping_interval: Duration::from_millis(100),
        ..RemoteConfig::default()
    };
    let url = listen(&daemon, config).await;

    // One that answers stays.
    let (local, _local_events) = local(&daemon).await;
    let (device, key) = pair(&local, &url, "iPad").await;
    let (connected, _) = remote(&url, self::device(&device, &key, None)).await;
    let (answering, _events) = connected.expect("connects");
    tokio::time::sleep(Duration::from_millis(500)).await;
    answering
        .send(StatusRequest {})
        .await
        .expect("still connected");

    // One that reads nothing never answers, and is closed.
    let mut silent = upgrade(&url, Some(SUBPROTOCOL), None)
        .await
        .expect("upgrades");
    tokio::time::sleep(Duration::from_millis(500)).await;
    let ended = tokio::time::timeout(WAIT, async {
        loop {
            match silent.next().await {
                None | Some(Err(_)) | Some(Ok(Message::Close(_))) => return,
                Some(Ok(_)) => {}
            }
        }
    })
    .await;
    assert!(ended.is_ok(), "the Host closed it");
    let _ = silent.close(None).await;
}

#[tokio::test]
async fn pairing_turns_remote_access_on_and_the_last_revoke_turns_it_off() {
    let world = World::new();
    let serve = Arc::new(FakeServe::default());
    let daemon = world.daemon_with_remote(Arc::clone(&serve), Duration::from_secs(300));
    let (local, _events) = local(&daemon).await;
    assert_eq!(
        remote_address(&local).await,
        None,
        "nothing listens before pairing"
    );
    assert!(serve.calls().is_empty());

    let offer = local
        .send(OfferDeviceRequest { name: None })
        .await
        .expect("devices/offer");
    let address = remote_address(&local).await.expect("listening");
    assert_eq!(offer.url, Some(format!("ws://{address}")));
    assert_eq!(serve.calls(), ["ensure"]);

    let url = offer.url.expect("a URL");
    let (connected, _) = remote(
        &url,
        Credentials::Pair {
            code: offer.code,
            name: "iPad".to_owned(),
            key: DeviceKey::generate(),
        },
    )
    .await;
    let (connection, _) = connected.expect("paired");
    let first = connection.hello().device.clone().expect("a device");
    connection.shutdown().await;
    let (second, _) = pair(&local, &url, "iPhone").await;
    assert_eq!(serve.calls(), ["ensure"], "one entry, made once");

    local
        .send(RevokeDeviceRequest {
            device_id: first.id,
        })
        .await
        .expect("revoked");
    assert!(
        remote_address(&local).await.is_some(),
        "a device is still paired"
    );
    local
        .send(RevokeDeviceRequest {
            device_id: second.id,
        })
        .await
        .expect("revoked");
    assert_eq!(remote_address(&local).await, None);
    assert_eq!(serve.calls(), ["ensure", "remove"]);
    closed(&address).await;
}

#[tokio::test]
async fn an_offer_nobody_takes_turns_remote_access_off_again() {
    let world = World::new();
    let serve = Arc::new(FakeServe::default());
    let daemon = world.daemon_with_remote(Arc::clone(&serve), Duration::from_millis(200));
    let (local, _events) = local(&daemon).await;
    local
        .send(OfferDeviceRequest { name: None })
        .await
        .expect("devices/offer");
    let address = remote_address(&local).await.expect("listening");
    closed(&address).await;
    assert_eq!(remote_address(&local).await, None);
    assert_eq!(serve.calls(), ["ensure", "remove"]);
}

#[tokio::test]
async fn an_offer_fails_when_serve_cannot_reach_the_host() {
    let world = World::new();
    let serve = Arc::new(FakeServe::default());
    serve.refuse(Some(
        "Serve is off for your tailnet; turn it on at https://login.tailscale.com/f/serve",
    ));
    let daemon = world.daemon_with_remote(Arc::clone(&serve), Duration::from_secs(300));
    let (local, _events) = local(&daemon).await;
    let error = local
        .send(OfferDeviceRequest { name: None })
        .await
        .expect_err("no offer");
    assert!(errors::is(&error, errors::REMOTE_UNAVAILABLE));
    assert!(
        error
            .message
            .contains("https://login.tailscale.com/f/serve")
    );
    assert_eq!(remote_address(&local).await, None, "nothing left listening");
    assert_eq!(serve.calls(), ["ensure", "remove"]);
}

#[tokio::test]
async fn a_host_with_paired_devices_turns_remote_access_back_on() {
    let world = World::new();
    let first_serve = Arc::new(FakeServe::default());
    let first = world.daemon_with_remote(first_serve, Duration::from_secs(300));
    let (first_local, _events) = local(&first).await;
    let offer = first_local
        .send(OfferDeviceRequest { name: None })
        .await
        .expect("devices/offer");
    let (paired, key) = pair(&first_local, &offer.url.expect("a URL"), "iPad").await;

    // A later Host, from the same devices.json, as after a restart, with Serve not ready yet.
    let serve = Arc::new(FakeServe::default());
    serve.refuse(Some("Tailscale isn't running"));
    let daemon = world.daemon_with_remote(Arc::clone(&serve), Duration::from_secs(300));
    daemon.resume_remote().await;
    let (local, _events) = local(&daemon).await;
    let address = remote_address(&local).await.expect("listening again");
    assert_eq!(serve.calls(), ["ensure"]);

    // It listens meanwhile, and tries the Serve entry again until it's there.
    let url = format!("ws://{address}");
    let (connected, _) = remote(&url, device(&paired, &key, None)).await;
    connected.expect("the device connects").0.shutdown().await;
    serve.refuse(None);
    let deadline = tokio::time::Instant::now() + WAIT;
    while serve.calls().len() < 2 {
        assert!(tokio::time::Instant::now() < deadline, "tried again");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let offer = local
        .send(OfferDeviceRequest { name: None })
        .await
        .expect("devices/offer");
    assert_eq!(offer.url, Some(url));
}
