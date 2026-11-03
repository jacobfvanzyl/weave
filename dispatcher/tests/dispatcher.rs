//! The Dispatcher against in-process Hosts on loopback WebSockets: pairing as a service through
//! its socket, reconnecting after a Host restarts, and starting work once across its own
//! restarts. Each Host sits behind a relay that a restart cuts, as a Host process exiting
//! closes its connections.

#![allow(clippy::expect_used)]

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use agent_client_protocol::Channel;
use agent_client_protocol::Error;
use pretty_assertions::assert_eq;
use tokio::net::TcpListener;
use tokio::net::TcpStream;
use tokio::task::AbortHandle;
use tokio::task::JoinHandle;
use weave_acp_core::AgentConnection;
use weave_acp_core::ClientOptions;
use weave_acp_core::schema::ContentBlock;
use weave_agents::environment::Environment;
use weave_dispatcher::DeliveryState;
use weave_dispatcher::Dispatcher;
use weave_dispatcher::DispatcherConfig;
use weave_dispatcher::DispatcherPaths;
use weave_dispatcher::Work;
use weave_dispatcher::client::DispatcherConnection;
use weave_dispatcher::socket;
use weave_fake_agent::FakeAgentConfig;
use weave_host::Daemon;
use weave_host::DaemonConfig;
use weave_host::Launch;
use weave_host::Launcher;
use weave_host::RemoteConfig;
use weave_host::Withheld;
use weave_host_client::HostConnection;
use weave_host_protocol::devices::ListDevicesRequest;
use weave_host_protocol::devices::OfferDeviceRequest;
use weave_host_protocol::devices::RevokeDeviceRequest;
use weave_host_protocol::dispatcher::AddHostRequest;
use weave_host_protocol::dispatcher::DispatcherHost;
use weave_host_protocol::dispatcher::DispatcherStatusRequest;
use weave_host_protocol::dispatcher::ListHostsRequest;
use weave_host_protocol::hello::ClientCapabilities;
use weave_host_protocol::hello::ClientInfo;
use weave_host_protocol::host::Service;
use weave_host_protocol::peers::PeerStatus;
use weave_host_protocol::policy::PermissionPolicy;
use weave_host_protocol::sessions::ListSessionsRequest;
use weave_host_protocol::sessions::RunRequest;
use weave_host_protocol::sessions::RunResponse;

const WAIT: Duration = Duration::from_secs(10);

/// One Host's directory, and the Host running from it behind its relay.
struct World {
    dir: tempfile::TempDir,
    relay: Relay,
    daemon: Daemon,
    serving: JoinHandle<()>,
}

impl World {
    async fn new() -> Self {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            dir.path().join("config.toml"),
            "[agents.fake]\ncommand = \"fake-agent\"\n",
        )
        .expect("config");
        let relay = Relay::new().await;
        let daemon = Daemon::new(config(dir.path().to_path_buf()));
        let serving = serve(&daemon, &relay).await;
        Self {
            dir,
            relay,
            daemon,
            serving,
        }
    }

    /// The Host's URL, through its relay.
    fn url(&self) -> String {
        format!("ws://{}", self.relay.address)
    }

    async fn local(&self) -> HostConnection {
        let (connection, _events) = HostConnection::connect(
            self.daemon.connect_in_process(),
            info("weave"),
            ClientCapabilities::default(),
        )
        .await
        .expect("a local client");
        connection
    }

    /// A code the Dispatcher pairs with.
    async fn offer(&self) -> String {
        let local = self.local().await;
        let offer = local
            .send(OfferDeviceRequest { name: None })
            .await
            .expect("devices/offer");
        local.shutdown().await;
        offer.code
    }

    /// Stop the Host, closing every connection to it, and start another from the same
    /// directory, which is the same Host with the same paired devices.
    async fn restart(&mut self) {
        self.relay.cut();
        self.serving.abort();
        self.daemon.shutdown().await;
        self.daemon = Daemon::new(config(self.dir.path().to_path_buf()));
        self.serving = serve(&self.daemon, &self.relay).await;
    }
}

fn config(dir: PathBuf) -> DaemonConfig {
    let state = dir.join("agent-state.json");
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
        drain_timeout: weave_host::DEFAULT_DRAIN_TIMEOUT,
        blank_grace: Duration::from_secs(60),
        launcher,
        config_file: Some(dir.join("config.toml")),
        registry_cache: Some(dir.join("cache")),
        agents: Default::default(),
        withheld: Withheld::default(),
        environment: Environment::default(),
        service: Service::InProcess,
        traces: dir.join("traces"),
        devices: Some(dir.join("devices.json")),
        upstream: Arc::new(weave_agents::update::Offline),
        mcp_socket: None,
        mcp_bridge: vec!["weave-mcp-bridge".to_owned()],
        remote: None,
        terminals: None,
        peers: None,
    }
}

/// Serve `daemon`'s WebSocket on a port of its own, and point `relay` at it.
async fn serve(daemon: &Daemon, relay: &Relay) -> JoinHandle<()> {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("a port");
    relay.point(listener.local_addr().expect("its address"));
    let serving = daemon.clone();
    tokio::spawn(async move {
        serving
            .serve_remote(listener, RemoteConfig::default())
            .await
    })
}

/// A TCP relay on a port that stays the same, to wherever it points now.
struct Relay {
    address: SocketAddr,
    target: Arc<Mutex<Option<SocketAddr>>>,
    open: Arc<Mutex<Vec<AbortHandle>>>,
}

impl Relay {
    async fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("a port");
        let address = listener.local_addr().expect("its address");
        let target: Arc<Mutex<Option<SocketAddr>>> = Arc::default();
        let open: Arc<Mutex<Vec<AbortHandle>>> = Arc::default();
        let (to, opened) = (Arc::clone(&target), Arc::clone(&open));
        tokio::spawn(async move {
            while let Ok((mut inbound, _)) = listener.accept().await {
                let Some(to) = *to.lock().expect("the target") else {
                    continue;
                };
                let relayed = tokio::spawn(async move {
                    if let Ok(mut outbound) = TcpStream::connect(to).await {
                        let _ = tokio::io::copy_bidirectional(&mut inbound, &mut outbound).await;
                    }
                });
                opened
                    .lock()
                    .expect("the connections")
                    .push(relayed.abort_handle());
            }
        });
        Self {
            address,
            target,
            open,
        }
    }

    fn point(&self, to: SocketAddr) {
        *self.target.lock().expect("the target") = Some(to);
    }

    /// Close every connection through it, and take no more until pointed again.
    fn cut(&self) {
        *self.target.lock().expect("the target") = None;
        for relayed in self.open.lock().expect("the connections").drain(..) {
            relayed.abort();
        }
    }
}

fn info(name: &str) -> ClientInfo {
    ClientInfo {
        name: name.to_owned(),
        version: "0".to_owned(),
    }
}

fn dispatcher_config(dir: &std::path::Path) -> DispatcherConfig {
    DispatcherConfig {
        name: "Dispatcher".to_owned(),
        secure_enclave: false,
        reach_timeout: Duration::from_secs(2),
        retry: Duration::from_millis(50),
        retry_most: Duration::from_millis(200),
        ..DispatcherConfig::new(DispatcherPaths::in_dir(dir.join("dispatcher")))
    }
}

/// A Dispatcher from `dir`, answering on its socket.
fn start(dir: &std::path::Path) -> (Dispatcher, JoinHandle<()>) {
    let config = dispatcher_config(dir);
    let listening = socket::listen(&config.paths).expect("its socket");
    let dispatcher = Dispatcher::open(config).expect("opened");
    let serving = dispatcher.clone();
    // The lock stays held, with the rest of `listening`, until the task ends.
    let task = tokio::spawn(async move { serving.serve(listening.listener).await });
    (dispatcher, task)
}

/// Its CLI's end, over its socket.
async fn ask(dir: &std::path::Path) -> DispatcherConnection {
    let socket = dispatcher_config(dir).paths.socket();
    DispatcherConnection::connect(
        socket::connect(&socket).await.expect("the socket"),
        info("weave-cli"),
    )
    .await
    .expect("hello")
}

/// Wait until `host_id` is as `wanted` says.
async fn host_until(
    dispatcher: &Dispatcher,
    host_id: &str,
    wanted: impl Fn(&DispatcherHost) -> bool,
) -> DispatcherHost {
    tokio::time::timeout(WAIT, async {
        loop {
            let hosts = dispatcher.hosts().expect("hosts");
            if let Some(host) = hosts.into_iter().find(|host| host.host_id == host_id)
                && wanted(&host)
            {
                return host;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the Host in time")
}

/// Wait until the delivery `id` isn't pending, and read the Host's answer.
async fn delivered(dispatcher: &Dispatcher, id: &str) -> RunResponse {
    let delivery = tokio::time::timeout(WAIT, async {
        loop {
            let delivery = dispatcher.delivery(id).expect("read").expect("there");
            if delivery.state != DeliveryState::Pending {
                return delivery;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("delivered in time");
    assert_eq!(delivery.state, DeliveryState::Delivered, "{delivery:?}");
    serde_json::from_value(delivery.answer.expect("an answer")).expect("a run's answer")
}

fn run(world: &World, prompt: &str) -> Work {
    Work::Run(RunRequest {
        agent_id: "fake".to_owned(),
        cwd: world.dir.path().to_path_buf(),
        remote: None,
        session_id: None,
        additional_directories: Vec::new(),
        mode: None,
        prompt: vec![ContentBlock::from(prompt.to_owned())],
        policy: PermissionPolicy::ask(),
        attach: false,
        trace: false,
        key: None,
        caller: None,
        origin: None,
    })
}

async fn sessions(world: &World) -> usize {
    let local = world.local().await;
    let listed = local
        .send(ListSessionsRequest::default())
        .await
        .expect("sessions/list");
    local.shutdown().await;
    listed.sessions.len()
}

#[tokio::test(flavor = "multi_thread")]
async fn the_dispatcher_starts_work_on_each_host_once_across_restarts() {
    let mut studio = World::new().await;
    let mut mini = World::new().await;
    let dir = tempfile::tempdir().expect("tempdir");
    let (dispatcher, serving) = start(dir.path());

    // Paired through its socket, as a service of each Host.
    let cli = ask(dir.path()).await;
    let mut added = Vec::new();
    for (world, name) in [(&studio, "studio"), (&mini, "mini")] {
        let host = cli
            .send(AddHostRequest {
                url: world.url(),
                code: world.offer().await,
                name: Some(name.to_owned()),
            })
            .await
            .expect("hosts/add")
            .host;
        assert_eq!(host.name, name);
        added.push(host.host_id);
    }
    let (studio_id, mini_id) = (added[0].clone(), added[1].clone());
    let local = studio.local().await;
    let devices = local
        .send(ListDevicesRequest {})
        .await
        .expect("devices/list")
        .devices;
    assert_eq!(
        devices
            .iter()
            .map(|device| (device.name.as_str(), device.service))
            .collect::<Vec<_>>(),
        vec![("Dispatcher", true)]
    );
    local.shutdown().await;
    for host_id in [&studio_id, &mini_id] {
        host_until(&dispatcher, host_id, |host| host.connected).await;
    }
    let listed = cli.send(ListHostsRequest {}).await.expect("hosts/list");
    assert_eq!(listed.hosts.len(), 2);

    // A headless turn on each.
    let first = dispatcher
        .deliver(&studio_id, run(&studio, "hello"))
        .expect("written down");
    let on_mini = dispatcher
        .deliver(&mini_id, run(&mini, "hello"))
        .expect("written down");
    let started = delivered(&dispatcher, &first.id).await;
    delivered(&dispatcher, &on_mini.id).await;
    tokio::time::timeout(WAIT, async {
        while !dispatcher
            .threads(&studio_id)
            .iter()
            .any(|thread| thread.info.session_id == started.session_id)
        {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the thread it started, watched");

    // One Host restarts: the Dispatcher connects again, and work waiting for it gets there.
    let before = host_until(&dispatcher, &mini_id, |host| host.connected)
        .await
        .connected_at;
    mini.restart().await;
    host_until(&dispatcher, &mini_id, |host| {
        host.connected && host.connected_at > before
    })
    .await;
    let after = dispatcher
        .deliver(&mini_id, run(&mini, "after the restart"))
        .expect("written down");
    delivered(&dispatcher, &after.id).await;

    // The Dispatcher stops after the Host took the work but before it wrote that down, as a
    // crash would: started again, it sends it again, and the Host starts nothing twice.
    cli.shutdown().await;
    dispatcher.stop().await;
    serving.abort();
    let _ = serving.await;
    let database = dispatcher_config(dir.path()).paths.database();
    rusqlite::Connection::open(&database)
        .expect("the database")
        .execute(
            "UPDATE deliveries SET state = 'pending', answer = NULL WHERE id = ?1",
            [&first.id],
        )
        .expect("as though never answered");
    let (dispatcher, serving) = start(dir.path());
    let again = delivered(&dispatcher, &first.id).await;
    assert_eq!(again.session_id, started.session_id);
    assert_eq!(again.turn_id, started.turn_id);
    assert_eq!(sessions(&studio).await, 1);
    let status = ask(dir.path())
        .await
        .send(DispatcherStatusRequest {})
        .await
        .expect("dispatcher/status");
    assert_eq!(status.pending, 0);

    dispatcher.stop().await;
    serving.abort();
    studio.restart().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_host_that_revokes_the_dispatcher_is_left_until_paired_again() {
    let studio = World::new().await;
    let dir = tempfile::tempdir().expect("tempdir");
    let (dispatcher, serving) = start(dir.path());
    let host = dispatcher
        .add_host(AddHostRequest {
            url: studio.url(),
            code: studio.offer().await,
            name: None,
        })
        .await
        .expect("paired");
    host_until(&dispatcher, &host.host_id, |host| host.connected).await;

    let local = studio.local().await;
    local
        .send(RevokeDeviceRequest {
            device_id: host.device_id.clone(),
        })
        .await
        .expect("devices/revoke");
    local.shutdown().await;
    let refused = host_until(&dispatcher, &host.host_id, |host| {
        host.status == PeerStatus::Refused
    })
    .await;
    assert!(!refused.connected);
    assert_eq!(refused.why.as_deref(), Some("it revoked the Dispatcher"));

    // A refusal stands across a restart, and work waits for the Host meanwhile.
    dispatcher.stop().await;
    serving.abort();
    let _ = serving.await;
    let (dispatcher, serving) = start(dir.path());
    let waiting = dispatcher
        .deliver(&host.host_id, run(&studio, "hello"))
        .expect("written down");
    let still = host_until(&dispatcher, &host.host_id, |host| {
        host.status == PeerStatus::Refused
    })
    .await;
    assert_eq!(still.pending, 1);

    // Pairing again is the way back, and the waiting work gets there.
    dispatcher
        .add_host(AddHostRequest {
            url: studio.url(),
            code: studio.offer().await,
            name: None,
        })
        .await
        .expect("paired again");
    delivered(&dispatcher, &waiting.id).await;
    dispatcher.stop().await;
    serving.abort();
}
