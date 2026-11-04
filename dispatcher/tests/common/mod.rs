//! What the Dispatcher's tests share: in-process Hosts on loopback WebSockets, each behind a
//! relay that a restart cuts, as a Host process exiting closes its connections, and a
//! Dispatcher answering on its socket.

#![allow(clippy::expect_used, dead_code)]

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
use weave_dispatcher::Clock;
use weave_dispatcher::DeliveryState;
use weave_dispatcher::Dispatcher;
use weave_dispatcher::DispatcherConfig;
use weave_dispatcher::DispatcherPaths;
use weave_dispatcher::SystemClock;
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
use weave_host_protocol::devices::OfferDeviceRequest;
use weave_host_protocol::dispatcher::DispatcherHost;
use weave_host_protocol::hello::ClientCapabilities;
use weave_host_protocol::hello::ClientInfo;
use weave_host_protocol::host::Service;
use weave_host_protocol::policy::PermissionPolicy;
use weave_host_protocol::sessions::ListSessionsRequest;
use weave_host_protocol::sessions::RunRequest;
use weave_host_protocol::sessions::RunResponse;
use weave_host_protocol::sessions::SessionListing;

pub const WAIT: Duration = Duration::from_secs(10);

/// One Host's directory, and the Host running from it behind its relay.
pub struct World {
    pub dir: tempfile::TempDir,
    pub relay: Relay,
    pub daemon: Daemon,
    serving: JoinHandle<()>,
    /// It keeps journals, so a restart finds the turns it cut off.
    journals: bool,
}

impl World {
    pub async fn new() -> Self {
        Self::with(false).await
    }

    /// A Host that keeps journals, whose restarts interrupt the turns it ran, and continue
    /// headless threads' (WVE-144).
    pub async fn with_journals() -> Self {
        Self::with(true).await
    }

    async fn with(journals: bool) -> Self {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            dir.path().join("config.toml"),
            "[agents.fake]\ncommand = \"fake-agent\"\n",
        )
        .expect("config");
        let relay = Relay::new().await;
        let daemon = Daemon::new(config_with(dir.path().to_path_buf(), journals));
        let serving = serve(&daemon, &relay).await;
        Self {
            dir,
            relay,
            daemon,
            serving,
            journals,
        }
    }

    /// The Host's URL, through its relay.
    pub fn url(&self) -> String {
        format!("ws://{}", self.relay.address)
    }

    pub async fn local(&self) -> HostConnection {
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
    pub async fn offer(&self) -> String {
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
    pub async fn restart(&mut self) {
        self.relay.cut();
        self.serving.abort();
        self.daemon.shutdown().await;
        self.daemon = Daemon::new(config_with(self.dir.path().to_path_buf(), self.journals));
        self.serving = serve(&self.daemon, &self.relay).await;
        self.daemon.resume_queues().await;
    }
}

pub fn config(dir: PathBuf) -> DaemonConfig {
    config_with(dir, false)
}

pub fn config_with(dir: PathBuf, journals: bool) -> DaemonConfig {
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
        journals: journals.then(|| dir.join("journals")),
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
pub async fn serve(daemon: &Daemon, relay: &Relay) -> JoinHandle<()> {
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
pub struct Relay {
    pub address: SocketAddr,
    target: Arc<Mutex<Option<SocketAddr>>>,
    last: Mutex<Option<SocketAddr>>,
    open: Arc<Mutex<Vec<AbortHandle>>>,
}

impl Relay {
    pub async fn new() -> Self {
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
            last: Mutex::new(None),
            open,
        }
    }

    pub fn point(&self, to: SocketAddr) {
        *self.target.lock().expect("the target") = Some(to);
        *self.last.lock().expect("the last target") = Some(to);
    }

    /// Take connections again, to where it pointed before it was cut.
    pub fn resume(&self) {
        *self.target.lock().expect("the target") = *self.last.lock().expect("the last target");
    }

    /// Close every connection through it, and take no more until pointed again.
    pub fn cut(&self) {
        *self.target.lock().expect("the target") = None;
        for relayed in self.open.lock().expect("the connections").drain(..) {
            relayed.abort();
        }
    }
}

pub fn info(name: &str) -> ClientInfo {
    ClientInfo {
        name: name.to_owned(),
        version: "0".to_owned(),
    }
}

pub fn dispatcher_config(dir: &std::path::Path) -> DispatcherConfig {
    dispatcher_config_with(dir, Arc::new(SystemClock))
}

pub fn dispatcher_config_with(dir: &std::path::Path, clock: Arc<dyn Clock>) -> DispatcherConfig {
    DispatcherConfig {
        clock,
        name: "Dispatcher".to_owned(),
        secure_enclave: false,
        reach_timeout: Duration::from_secs(2),
        retry: Duration::from_millis(50),
        retry_most: Duration::from_millis(200),
        ..DispatcherConfig::new(DispatcherPaths::in_dir(dir.join("dispatcher")))
    }
}

/// A Dispatcher from `dir`, answering on its socket.
pub fn start(dir: &std::path::Path) -> (Dispatcher, JoinHandle<()>) {
    start_with(dir, Arc::new(SystemClock))
}

/// A Dispatcher from `dir` whose schedules run by `clock`, answering on its socket.
pub fn start_with(dir: &std::path::Path, clock: Arc<dyn Clock>) -> (Dispatcher, JoinHandle<()>) {
    let config = dispatcher_config_with(dir, clock);
    let listening = socket::listen(&config.paths).expect("its socket");
    let dispatcher = Dispatcher::open(config).expect("opened");
    let serving = dispatcher.clone();
    // The lock stays held, with the rest of `listening`, until the task ends.
    let task = tokio::spawn(async move { serving.serve(listening.listener).await });
    (dispatcher, task)
}

/// Its CLI's end, over its socket.
pub async fn ask(dir: &std::path::Path) -> DispatcherConnection {
    let socket = dispatcher_config(dir).paths.socket();
    DispatcherConnection::connect(
        socket::connect(&socket).await.expect("the socket"),
        info("weave-cli"),
    )
    .await
    .expect("hello")
}

/// Wait until `host_id` is as `wanted` says.
pub async fn host_until(
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
pub async fn delivered(dispatcher: &Dispatcher, id: &str) -> RunResponse {
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

pub fn run(world: &World, prompt: &str) -> Work {
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

pub async fn sessions(world: &World) -> usize {
    let local = world.local().await;
    let listed = local
        .send(ListSessionsRequest::default())
        .await
        .expect("sessions/list");
    local.shutdown().await;
    listed.sessions.len()
}

/// The threads on `world`'s Host.
pub async fn threads(world: &World) -> Vec<SessionListing> {
    let local = world.local().await;
    let listed = local
        .send(ListSessionsRequest::default())
        .await
        .expect("sessions/list");
    local.shutdown().await;
    listed.sessions
}
