//! What the Dispatcher's tests share: in-process Hosts that join the Dispatcher over its socket
//! (ADR 0030), each through a relay that a restart cuts, as a Host process exiting closes its
//! connections, and each with a home of its own and agents that call Host tools (the fake
//! agent's `tool` script); and a Dispatcher answering on its socket.

#![allow(clippy::expect_used, dead_code)]

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;

use agent_client_protocol::Channel;
use agent_client_protocol::Error;
use futures::future::BoxFuture;
use pretty_assertions::assert_eq;
use serde_json::json;
use tokio::net::UnixListener;
use tokio::net::UnixStream;
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
use weave_host::DispatcherSettings;
use weave_host::Launch;
use weave_host::Launcher;
use weave_host::RemoteConfig;
use weave_host::Withheld;
use weave_host::terminals::Incoming;
use weave_host::terminals::Outgoing;
use weave_host::terminals::Owner;
use weave_host::terminals::Start;
use weave_host::terminals::Wire;
use weave_host_client::HostConnection;
use weave_host_protocol::dispatcher::DispatcherAddress;
use weave_host_protocol::dispatcher::DispatcherHost;
use weave_host_protocol::dispatcher::JoinDispatcherRequest;
use weave_host_protocol::dispatcher::JoinedDispatcher;
use weave_host_protocol::hello::ClientCapabilities;
use weave_host_protocol::hello::ClientInfo;
use weave_host_protocol::host::Service;
use weave_host_protocol::policy::PermissionPolicy;
use weave_host_protocol::threads::ListThreadsRequest;
use weave_host_protocol::threads::RunRequest;
use weave_host_protocol::threads::RunResponse;
use weave_host_protocol::threads::ThreadListing;

pub const WAIT: Duration = Duration::from_secs(10);

/// Git for a test's repositories, away from the configuration of whoever runs the tests.
pub const ISOLATED_GIT: &[(&str, &str)] = &[
    ("GIT_CONFIG_GLOBAL", "/dev/null"),
    ("GIT_CONFIG_NOSYSTEM", "1"),
    ("GIT_AUTHOR_NAME", "Test"),
    ("GIT_AUTHOR_EMAIL", "test@example.com"),
    ("GIT_COMMITTER_NAME", "Test"),
    ("GIT_COMMITTER_EMAIL", "test@example.com"),
];

/// A Host's configuration: the fake agent, and deep enough delegation for a thread another
/// Host's agent started to start one of its own, which one hop keeps from other Hosts.
pub const CONFIG: &str = "[agents.fake]\ncommand = \"fake-agent\"\n\n[delegation]\ndepth = 3\n";

/// One Host's directory, and the Host running from it, which reaches the Dispatcher through its
/// relay.
pub struct World {
    pub dir: tempfile::TempDir,
    pub relay: Relay,
    pub daemon: Daemon,
    /// It keeps journals, so a restart finds the turns it cut off.
    journals: bool,
    /// Its terminals' owner, if it has terminals.
    terminals: Option<Arc<dyn Owner>>,
    /// Its connections to the Dispatcher's pings and backlog.
    websocket: RemoteConfig,
}

impl World {
    pub async fn new() -> Self {
        Self::with(false, None, RemoteConfig::default()).await
    }

    /// A Host that keeps journals, whose restarts interrupt the turns it ran, and continue
    /// headless threads' (WVE-144).
    pub async fn with_journals() -> Self {
        Self::with(true, None, RemoteConfig::default()).await
    }

    /// A Host with terminals, which a fake owner keeps: each echoes what's typed into it.
    pub async fn with_terminals() -> Self {
        Self::with(
            false,
            Some(Arc::new(EchoingOwner::default())),
            RemoteConfig::default(),
        )
        .await
    }

    /// A Host whose connections to the Dispatcher, its own and those it carries, have
    /// `websocket`'s pings and backlog.
    pub async fn with_websocket(websocket: RemoteConfig) -> Self {
        Self::with(false, None, websocket).await
    }

    async fn with(
        journals: bool,
        terminals: Option<Arc<dyn Owner>>,
        websocket: RemoteConfig,
    ) -> Self {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join("config.toml"), CONFIG).expect("config");
        std::fs::create_dir_all(dir.path().join("home")).expect("home");
        let relay = Relay::new(&dir.path().join("relay.sock")).await;
        let daemon = Daemon::new(Self::config(
            dir.path(),
            journals,
            terminals.clone(),
            websocket.clone(),
        ));
        Self {
            dir,
            relay,
            daemon,
            journals,
            terminals,
            websocket,
        }
    }

    fn config(
        dir: &Path,
        journals: bool,
        terminals: Option<Arc<dyn Owner>>,
        websocket: RemoteConfig,
    ) -> DaemonConfig {
        let mut config = config_with(dir.to_path_buf(), journals);
        if let Some(dispatcher) = config.dispatcher.as_mut() {
            dispatcher.websocket = websocket;
        }
        DaemonConfig {
            terminals,
            ..config
        }
    }

    /// The Host's id.
    pub async fn host_id(&self) -> String {
        let local = self.local().await;
        let id = local.hello().host.id.clone();
        local.shutdown().await;
        id
    }

    /// Join the Dispatcher from `dispatcher_dir`, through the relay to its socket, as `name`.
    pub async fn join(&self, dispatcher: &Dispatcher, dispatcher_dir: &Path, name: &str) {
        let code = dispatcher.offer_host(true).await.expect("hosts/offer").code;
        self.join_with(dispatcher_dir, code, name)
            .await
            .expect("joined");
    }

    /// Join the Dispatcher from `dispatcher_dir` with `code`, through the relay to its socket.
    pub async fn join_with(
        &self,
        dispatcher_dir: &Path,
        code: String,
        name: &str,
    ) -> Result<JoinedDispatcher, Error> {
        self.relay
            .point(&dispatcher_config(dispatcher_dir).paths.hosts_socket());
        self.daemon
            .join_dispatcher(JoinDispatcherRequest {
                address: DispatcherAddress::Socket(self.relay.path.clone()),
                code,
                name: Some(name.to_owned()),
            })
            .await
    }

    /// The home `~/…` paths between Hosts are under.
    pub fn home(&self) -> PathBuf {
        self.dir.path().join("home")
    }

    /// Add `toml` to the Host's configuration, which it reads as it goes.
    pub fn configure(&self, toml: &str) {
        std::fs::write(
            self.dir.path().join("config.toml"),
            format!("{CONFIG}{toml}"),
        )
        .expect("config");
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

    /// Stop the Host, closing every connection it has, and start another from the same
    /// directory, which is the same Host, joined to the same Dispatcher.
    pub async fn restart(&mut self) {
        self.relay.cut();
        self.daemon.shutdown().await;
        self.daemon = Daemon::new(Self::config(
            self.dir.path(),
            self.journals,
            self.terminals.clone(),
            self.websocket.clone(),
        ));
        self.relay.resume();
        self.daemon.resume_dispatcher();
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
            mcp_over_acp: true,
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
        sessions: None,
        idle_grace: Duration::from_secs(60),
        drain_timeout: weave_host::DEFAULT_DRAIN_TIMEOUT,
        blank_grace: Duration::from_secs(60),
        launcher,
        config_file: Some(dir.join("config.toml")),
        registry_cache: Some(dir.join("cache")),
        agents: Default::default(),
        withheld: Withheld::default(),
        environment: Environment {
            vars: ISOLATED_GIT
                .iter()
                .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
                .collect(),
            ..Environment::default()
        },
        service: Service::InProcess,
        traces: dir.join("traces"),
        devices: Some(dir.join("devices.json")),
        upstream: Arc::new(weave_agents::update::Offline),
        mcp_socket: None,
        mcp_bridge: vec!["weave-mcp-bridge".to_owned()],
        former_serve: None,
        terminals: None,
        home: Some(dir.join("home")),
        retired: Vec::new(),
        dispatcher: Some(DispatcherSettings {
            secure_enclave: false,
            timeout: Duration::from_secs(2),
            retry: Duration::from_millis(50),
            retry_most: Duration::from_millis(200),
            websocket: RemoteConfig::default(),
            ..DispatcherSettings::in_dir(&weave_host::DaemonPaths::in_dir(dir))
        }),
    }
}

/// A relay on a Unix socket of its own, which a Host joins the Dispatcher through, to the
/// Dispatcher's socket wherever it points now.
pub struct Relay {
    pub path: PathBuf,
    target: Arc<Mutex<Option<PathBuf>>>,
    last: Mutex<Option<PathBuf>>,
    open: Arc<Mutex<Vec<AbortHandle>>>,
    /// Pass what the Dispatcher sends, and drop what the Host answers, as a Host that stops
    /// answering mid-request does.
    deaf: Arc<AtomicBool>,
}

impl Relay {
    pub async fn new(path: &Path) -> Self {
        let listener = UnixListener::bind(path).expect("a socket");
        let target: Arc<Mutex<Option<PathBuf>>> = Arc::default();
        let open: Arc<Mutex<Vec<AbortHandle>>> = Arc::default();
        let deaf: Arc<AtomicBool> = Arc::default();
        let (to, opened, deafened) = (Arc::clone(&target), Arc::clone(&open), Arc::clone(&deaf));
        tokio::spawn(async move {
            while let Ok((inbound, _)) = listener.accept().await {
                let Some(to) = to.lock().expect("the target").clone() else {
                    continue;
                };
                let deaf = Arc::clone(&deafened);
                let relayed = tokio::spawn(async move {
                    if let Ok(outbound) = UnixStream::connect(&to).await {
                        relay(inbound, outbound, deaf).await;
                    }
                });
                opened
                    .lock()
                    .expect("the connections")
                    .push(relayed.abort_handle());
            }
        });
        Self {
            path: path.to_path_buf(),
            target,
            last: Mutex::new(None),
            open,
            deaf,
        }
    }

    /// Drop what the Host answers from now on, until [`Self::resume`].
    pub fn deafen(&self) {
        self.deaf.store(true, Ordering::SeqCst);
    }

    pub fn point(&self, to: &Path) {
        *self.target.lock().expect("the target") = Some(to.to_path_buf());
        *self.last.lock().expect("the last target") = Some(to.to_path_buf());
    }

    /// Take connections again, to where it pointed before it was cut.
    pub fn resume(&self) {
        self.deaf.store(false, Ordering::SeqCst);
        *self.target.lock().expect("the target") =
            self.last.lock().expect("the last target").clone();
    }

    /// Close every connection through it, and take no more until pointed again.
    pub fn cut(&self) {
        *self.target.lock().expect("the target") = None;
        for relayed in self.open.lock().expect("the connections").drain(..) {
            relayed.abort();
        }
    }
}

/// Copy between `inbound`, the Host, and `outbound`, the Dispatcher, both ways, dropping what
/// the Host says while `deaf`.
async fn relay(inbound: UnixStream, outbound: UnixStream, deaf: Arc<AtomicBool>) {
    use tokio::io::AsyncReadExt as _;
    use tokio::io::AsyncWriteExt as _;
    let (mut host_reads, mut host_writes) = inbound.into_split();
    let (mut dispatcher_reads, mut dispatcher_writes) = outbound.into_split();
    let up = async move {
        let mut buffer = vec![0u8; 16 * 1024];
        loop {
            let read = match host_reads.read(&mut buffer).await {
                Ok(0) | Err(_) => return,
                Ok(read) => read,
            };
            if deaf.load(Ordering::SeqCst) {
                continue;
            }
            if dispatcher_writes.write_all(&buffer[..read]).await.is_err() {
                return;
            }
        }
    };
    let down = async move {
        let _ = tokio::io::copy(&mut dispatcher_reads, &mut host_writes).await;
    };
    tokio::select! {
        () = up => {}
        () = down => {}
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
        thread_id: None,
        additional_directories: Vec::new(),
        mode: None,
        prompt: vec![ContentBlock::from(prompt.to_owned())],
        policy: PermissionPolicy::ask(),
        attach: false,
        trace: false,
        key: None,
        caller: None,
        origin: None,
        labels: Vec::new(),
    })
}

/// How many threads `world`'s Host has.
pub async fn thread_count(world: &World) -> usize {
    let local = world.local().await;
    let listed = local
        .send(ListThreadsRequest::default())
        .await
        .expect("threads/list");
    local.shutdown().await;
    listed.threads.len()
}

/// The threads on `world`'s Host.
pub async fn threads(world: &World) -> Vec<ThreadListing> {
    let local = world.local().await;
    let listed = local
        .send(ListThreadsRequest::default())
        .await
        .expect("threads/list");
    local.shutdown().await;
    listed.threads
}

/// Terminals in memory: each answers what the Host asks of its owner, sends `fake` as its restore
/// when attached, and echoes what's typed into it as its output.
#[derive(Default)]
pub struct EchoingOwner {
    terminals: Mutex<Vec<Start>>,
}

impl Owner for EchoingOwner {
    fn find(&self) -> BoxFuture<'_, Vec<String>> {
        let ids = self
            .terminals
            .lock()
            .expect("lock")
            .iter()
            .map(|start| start.id.clone())
            .collect();
        Box::pin(async move { ids })
    }

    fn start(&self, start: Start) -> BoxFuture<'_, Result<String, Error>> {
        let id = start.id.clone();
        self.terminals.lock().expect("lock").push(start);
        Box::pin(async move { Ok(id) })
    }

    fn connect<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<Wire, Error>> {
        Box::pin(async move {
            let start = self
                .terminals
                .lock()
                .expect("lock")
                .iter()
                .find(|start| start.id == id)
                .cloned()
                .ok_or_else(|| weave_host_protocol::errors::unknown_terminal(id))?;
            let (outgoing, mut requests) = tokio::sync::mpsc::channel::<Outgoing>(64);
            let (incoming_tx, incoming) = tokio::sync::mpsc::channel(64);
            tokio::spawn(async move {
                while let Some(message) = requests.recv().await {
                    match message {
                        Outgoing::Input(bytes) => {
                            let _ = incoming_tx.send(Incoming::Output(bytes)).await;
                        }
                        Outgoing::Request { id, method, .. } => {
                            let described = json!({
                                "id": start.id,
                                "scope": start.scope,
                                "size": {"cols": start.size.cols, "rows": start.size.rows},
                                "started_at": 1,
                            });
                            let result = match method.as_str() {
                                "subscribe" | "describe" => Ok(described),
                                "attach" => Ok(json!({"snapshot_bytes": 4})),
                                _ => Ok(json!({})),
                            };
                            let _ = incoming_tx.send(Incoming::Answer { id, result }).await;
                            if method == "attach" {
                                let _ = incoming_tx.send(Incoming::Restore(b"fake".to_vec())).await;
                            }
                        }
                    }
                }
            });
            Ok(Wire { outgoing, incoming })
        })
    }
}
