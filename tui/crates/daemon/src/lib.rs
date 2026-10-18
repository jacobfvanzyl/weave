//! The weave Host: agent sessions that outlive the clients using them.
//!
//! Clients (the TUI, `weave run`, later others) speak the Host protocol
//! ([`weave_host_protocol`]) to it; it speaks ACP to the agents it launches, through
//! `weave-acp-core`. A client names an agent by id and a directory; the Host resolves the agent
//! from its configuration ([`weave_agents`]) and starts it with the agent environment it
//! captured. One connection reaches every session on the Host.
//!
//! Each open session has its own agent process, started in the session's directory. A session
//! stays open while a client is attached, while a turn runs or waits on a person, and for an
//! idle grace period after that; a client leaving doesn't stop its turn. Everything a
//! session's clients are sent goes into its numbered journal, so a client that attaches later
//! catches up from the last position it saw, and a Host that restarts can take the session up
//! again. Requests that wait on a person are pending requests every attached client sees, and
//! clients that attach later; the first answer counts. A session's
//! [`PermissionPolicy`](weave_host_protocol::policy::PermissionPolicy) answers what it can
//! without anyone.
//!
//! When a session opens, the Host looks for a newer version of its agent in the background
//! and tells the session's clients of one; `agents/update` moves the agent's new sessions to
//! it, and `session/reopen` an open session, which keeps its id and journal (`updates`).
//!
//! A Host serves a Unix socket ([`socket`]), or, without one, a single client in the same
//! process ([`Daemon::connect_in_process`]). Remote clients, on the person's other devices,
//! reach it through a loopback WebSocket ([`Daemon::serve_remote`]) and prove a paired device.

mod client;
mod devices;
mod instance;
mod journal;
mod modes;
pub mod paths;
mod session;
pub mod socket;
mod updates;
mod websocket;

use std::collections::BTreeMap;
use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::atomic::AtomicU64;
use std::time::Duration;
use std::time::Instant;

use agent_client_protocol::Channel;
use agent_client_protocol::ConnectTo;
use agent_client_protocol::Error;
use tokio::net::UnixListener;
use tokio::sync::watch;
use weave_acp_core::AgentHandle;
use weave_acp_core::AgentSpec;
use weave_acp_core::ClientOptions;
use weave_acp_core::schema::InitializeResponse;
use weave_acp_core::schema::SessionId;
use weave_agents::environment::Environment;
use weave_agents::update::Upstream;
use weave_host_protocol::Host;
use weave_host_protocol::PROTOCOL_VERSION;
use weave_host_protocol::agents::AgentRelease;
use weave_host_protocol::agents::AgentSource;
use weave_host_protocol::errors;
use weave_host_protocol::host::EnvironmentSource;
use weave_host_protocol::host::HostStatus;
use weave_host_protocol::host::Service;
use weave_host_protocol::sessions::RunRequest;
use weave_host_protocol::sessions::SessionAgent;

use crate::instance::Instance;
pub use crate::instance::Launch;
use crate::instance::LaunchKey;
pub use crate::instance::Launcher;
pub use crate::instance::process_launcher;
pub use crate::journal::Recorded;
pub use crate::journal::RecordedChoice;
use crate::journal::now_ms;
pub use crate::paths::DaemonPaths;
use crate::session::Command;
use crate::session::SessionHandle;
use crate::session::lock;
pub use crate::websocket::RemoteConfig;

/// How long a session nothing needs stays open: no client attached, no turn running.
pub const DEFAULT_IDLE_GRACE: Duration = Duration::from_secs(30 * 60);
/// How long a blank session (new, never prompted) nothing needs stays open: long enough for
/// a client's `/reload` or reconnect to reattach.
pub const DEFAULT_BLANK_GRACE: Duration = Duration::from_secs(60);
/// How long an agent process started for no session waits to be taken by one.
const SPARE_GRACE: Duration = Duration::from_secs(60);
/// Journals untouched for this long are removed when a Host starts, and while it runs.
const JOURNAL_RETENTION: Duration = Duration::from_secs(14 * 24 * 60 * 60);
/// How often a running Host prunes journals.
const PRUNE_INTERVAL: Duration = Duration::from_secs(60 * 60);
/// How long stopping waits for each session's agent.
const SUSPEND_TIMEOUT: Duration = Duration::from_secs(10);

pub struct DaemonConfig {
    /// Where session journals are written; `None` keeps them in memory only.
    pub journals: Option<PathBuf>,
    /// How long a session nothing needs stays open.
    pub idle_grace: Duration,
    /// How long a blank session nothing needs stays open.
    pub blank_grace: Duration,
    pub launcher: Launcher,
    /// The config file agents and MCP servers come from; the default one when absent.
    pub config_file: Option<PathBuf>,
    /// Where the ACP registry's catalog and agents are kept; the default place when absent.
    pub registry_cache: Option<PathBuf>,
    /// Agents the client that started an in-process Host gave, ahead of the config's.
    pub agents: BTreeMap<String, AgentSpec>,
    /// Client services every agent goes without, as `--no-fs` and `--no-terminal` ask of an
    /// in-process Host.
    pub withheld: Withheld,
    /// What agents start with, under their own settings.
    pub environment: Environment,
    pub service: Service,
    /// Where protocol traces are written.
    pub traces: PathBuf,
    /// The record of paired devices and the Host's id; none keeps them in memory only.
    pub devices: Option<PathBuf>,
    /// Where newer versions of agents come from: npm and the ACP registry, or a test's.
    pub upstream: Arc<dyn Upstream>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Withheld {
    pub fs: bool,
    pub terminals: bool,
}

impl DaemonConfig {
    /// A Host inside one client: journals in memory, agents as processes with the client's
    /// own environment.
    pub fn in_process(config_file: Option<PathBuf>) -> Self {
        Self {
            journals: None,
            idle_grace: DEFAULT_IDLE_GRACE,
            blank_grace: DEFAULT_BLANK_GRACE,
            launcher: process_launcher(),
            config_file,
            registry_cache: None,
            agents: BTreeMap::new(),
            withheld: Withheld::default(),
            environment: Environment::process(),
            service: Service::InProcess,
            traces: std::env::temp_dir().join("weave-traces"),
            devices: None,
            upstream: Arc::new(weave_agents::update::Network),
        }
    }

    /// The per-user Host, with journals and traces in its directory.
    pub fn persistent(paths: &DaemonPaths, service: Service, environment: Environment) -> Self {
        Self {
            journals: Some(paths.journals()),
            environment,
            service,
            traces: paths.dir.join("traces"),
            devices: Some(paths.devices()),
            ..Self::in_process(None)
        }
    }
}

/// An agent ready to start, as the Host resolved it.
#[derive(Clone)]
pub(crate) struct Agent {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) source: AgentSource,
    /// The version launched, for presets and registry agents.
    pub(crate) version: Option<String>,
    /// A preset's npm package.
    pub(crate) package: Option<String>,
    pub(crate) spec: AgentSpec,
    pub(crate) options: ClientOptions,
    /// The mode its new sessions start in.
    pub(crate) mode: Option<String>,
    /// The configuration it came from, for its MCP servers.
    pub(crate) config: Arc<weave_agents::Config>,
}

impl Agent {
    /// The version launched, as clients see it; none for agents the configuration gives a
    /// command.
    pub(crate) fn release(&self) -> Option<AgentRelease> {
        let name = match self.source {
            AgentSource::Preset => self.package.clone()?,
            AgentSource::Registry => self.name.clone(),
            AgentSource::Config => return None,
        };
        Some(AgentRelease {
            name,
            version: self.version.clone()?,
        })
    }

    /// Where newer versions of it are looked for.
    pub(crate) fn feed(&self) -> Option<updates::Feed> {
        self.version.as_ref()?;
        updates::Feed::of(self.source, &self.id, self.package.as_deref())
    }

    /// The agent as a session's clients see it, once it answered `initialize`.
    pub(crate) fn session_agent(&self, initialize: InitializeResponse) -> SessionAgent {
        let name = initialize.agent_info.as_ref().map_or_else(
            || self.name.clone(),
            |info| info.title.clone().unwrap_or_else(|| info.name.clone()),
        );
        SessionAgent {
            id: self.id.clone(),
            name,
            initialize,
            release: self.release(),
        }
    }
}

pub(crate) struct Shared {
    pub(crate) config: DaemonConfig,
    registry: Mutex<Registry>,
    pub(crate) devices: devices::Devices,
    pub(crate) updates: updates::Updates,
    /// The WebSocket's address, while it's served.
    remote: Mutex<Option<String>>,
    started_ms: u64,
    pub(crate) next_client: AtomicU64,
    pub(crate) stop: watch::Sender<bool>,
}

impl Shared {
    pub(crate) fn registry(&self) -> MutexGuard<'_, Registry> {
        lock(&self.registry)
    }

    /// The configuration, read afresh, so edits apply to the next session.
    pub(crate) fn load_config(&self) -> Result<weave_agents::Config, Error> {
        weave_agents::Config::load(self.config.config_file.as_deref())
            .map(|loaded| loaded.config)
            .map_err(|error| Error::internal_error().data(format!("{error:#}")))
    }

    pub(crate) fn registry_cache(&self) -> Result<weave_agents::registry::Cache, Error> {
        match &self.config.registry_cache {
            Some(root) => Ok(weave_agents::registry::Cache::new(root.clone())),
            None => weave_agents::registry::Cache::default_location()
                .map_err(|error| Error::internal_error().data(format!("{error:#}"))),
        }
    }

    /// The agent `agent_id` names, from the agents an in-process Host was given, then the
    /// configuration, the presets and the ACP registry.
    pub(crate) async fn resolve(&self, agent_id: &str) -> Result<Agent, Error> {
        let config = self.load_config()?;
        let mode = config.mode(agent_id).map(str::to_owned);
        let (name, source, version, package, spec, mut options) =
            match self.config.agents.get(agent_id) {
                Some(spec) => (
                    agent_id.to_owned(),
                    AgentSource::Config,
                    None,
                    None,
                    spec.clone(),
                    ClientOptions::default(),
                ),
                None => {
                    let cache = self.registry_cache()?;
                    let resolved = weave_agents::resolve(&config, agent_id, &cache)
                        .await
                        .map_err(|error| Error::internal_error().data(format!("{error:#}")))?
                        .ok_or_else(|| errors::unknown_agent(agent_id))?;
                    if let Some(warning) = &resolved.warning {
                        tracing::warn!("{warning}");
                    }
                    let source = match resolved.source {
                        weave_agents::Source::Config => AgentSource::Config,
                        weave_agents::Source::Preset => AgentSource::Preset,
                        weave_agents::Source::Registry => AgentSource::Registry,
                    };
                    (
                        resolved.name,
                        source,
                        resolved.version,
                        resolved.package,
                        resolved.spec,
                        resolved.options,
                    )
                }
            };
        if self.config.withheld.fs {
            options.read_files = false;
            options.write_files = false;
        }
        if self.config.withheld.terminals {
            options.terminals = false;
        }
        Ok(Agent {
            id: agent_id.to_owned(),
            name,
            source,
            version,
            package,
            spec,
            options,
            mode,
            config: Arc::new(config),
        })
    }

    pub(crate) fn launch(&self, agent: &Agent, cwd: &Path) -> Launch {
        Launch {
            agent_id: agent.id.clone(),
            spec: agent.spec.clone(),
            cwd: cwd.to_path_buf(),
            environment: self.config.environment.vars.clone(),
        }
    }

    /// An initialized agent for a new or reopened session: a spare one, or a new one.
    pub(crate) async fn instance(
        &self,
        agent: &Agent,
        cwd: &Path,
        options: ClientOptions,
    ) -> Result<Instance, Error> {
        let launch = self.launch(agent, cwd);
        let key = LaunchKey::new(&launch, options);
        if let Some(spare) = self.registry().spares.remove(&key) {
            return Ok(spare.instance);
        }
        let instance = Instance::start(&self.config.launcher, &launch, options).await?;
        if let Some(init) = instance.init() {
            self.registry().initialized.insert(key, init.clone());
        }
        Ok(instance)
    }

    /// Keep an agent no session took, as after `auth_required`, for the next request; it
    /// stops if nothing takes it for a while.
    pub(crate) fn keep_spare(self: &Arc<Self>, instance: Instance) {
        let key = instance.key.clone();
        let generation = {
            let mut registry = self.registry();
            if registry.spares.contains_key(&key) {
                drop(registry);
                tokio::spawn(instance.connection.shutdown());
                return;
            }
            registry.next_spare += 1;
            let generation = registry.next_spare;
            registry.spares.insert(
                key.clone(),
                Spare {
                    instance,
                    generation,
                },
            );
            generation
        };
        let shared = Arc::clone(self);
        tokio::spawn(async move {
            tokio::time::sleep(SPARE_GRACE).await;
            let expired = {
                let mut registry = shared.registry();
                match registry.spares.get(&key) {
                    Some(spare) if spare.generation == generation => registry.spares.remove(&key),
                    _ => None,
                }
            };
            if let Some(spare) = expired {
                spare.instance.connection.shutdown().await;
            }
        });
    }

    /// An agent to ask something of outside any session (list, delete, sign in): an open
    /// session's of the same agent, or a spare.
    pub(crate) async fn agent_handle(
        self: &Arc<Self>,
        agent: &Agent,
        cwd: &Path,
        options: ClientOptions,
    ) -> Result<AgentHandle, Error> {
        let key = LaunchKey::new(&self.launch(agent, cwd), options);
        {
            let registry = self.registry();
            if let Some(spare) = registry.spares.get(&key) {
                return Ok(spare.instance.connection.handle());
            }
            let live = registry
                .sessions
                .values()
                .find(|session| session.key == key)
                .map(|session| session.agent.clone());
            if let Some(agent) = live {
                return Ok(agent);
            }
        }
        let instance = self.instance(agent, cwd, options).await?;
        let handle = instance.connection.handle();
        self.keep_spare(instance);
        Ok(handle)
    }

    /// The spare agents of `agent_id`, which the next sessions for it take.
    pub(crate) fn spare_handles(&self, agent_id: &str) -> Vec<AgentHandle> {
        self.registry()
            .spares
            .values()
            .filter(|spare| spare.instance.agent_id == agent_id)
            .map(|spare| spare.instance.connection.handle())
            .collect()
    }

    /// Stop the spare agents of `agent_id`, as after signing in through a terminal, so the
    /// next ones start signed in.
    pub(crate) fn drop_spares(&self, agent_id: &str) {
        let dropped: Vec<Spare> = {
            let mut registry = self.registry();
            let keys: Vec<LaunchKey> = registry
                .spares
                .iter()
                .filter(|(_, spare)| spare.instance.agent_id == agent_id)
                .map(|(key, _)| key.clone())
                .collect();
            keys.iter()
                .filter_map(|key| registry.spares.remove(key))
                .collect()
        };
        for spare in dropped {
            tokio::spawn(spare.instance.connection.shutdown());
        }
    }

    /// Where `session_id`'s protocol trace goes.
    pub(crate) fn trace_path(&self, session_id: &SessionId) -> Result<PathBuf, Error> {
        journal::create_private_dir(&self.config.traces).map_err(|error| {
            Error::internal_error().data(format!(
                "creating {}: {error}",
                self.config.traces.display()
            ))
        })?;
        let file = journal::path_for(&self.config.traces, session_id);
        Ok(file.with_extension("jsons"))
    }

    pub(crate) fn status(&self) -> HostStatus {
        let mut sessions: Vec<_> = self
            .registry()
            .sessions
            .values()
            .map(SessionHandle::summary)
            .collect();
        sessions.sort_by_key(|session| session.last_activity_ms);
        HostStatus {
            protocol: PROTOCOL_VERSION,
            version: env!("CARGO_PKG_VERSION").to_owned(),
            pid: std::process::id(),
            started_at: self.started_ms,
            service: self.config.service,
            environment: match self.config.environment.source {
                weave_agents::environment::Source::LoginShell => EnvironmentSource::LoginShell,
                weave_agents::environment::Source::Process => EnvironmentSource::Process,
            },
            sessions: sessions.iter().map(session::Summary::listing).collect(),
            remote: lock(&self.remote).clone(),
        }
    }
}

/// An agent started for no session yet.
pub(crate) struct Spare {
    instance: Instance,
    /// Which keeping of it this is, so an old expiry leaves a newer one alone.
    generation: u64,
}

#[derive(Default)]
pub(crate) struct Registry {
    /// Open sessions, by id.
    pub(crate) sessions: HashMap<SessionId, SessionHandle>,
    /// Subagent sessions, and the open session they belong to.
    pub(crate) children: HashMap<SessionId, SessionId>,
    /// Each agent's `initialize` answer, so asking again starts nothing.
    pub(crate) initialized: HashMap<LaunchKey, InitializeResponse>,
    /// Every session the journals record, open or not: which agent, where, under which
    /// policy, and whether it was closed or left open by a Host that stopped.
    pub(crate) known: HashMap<SessionId, Recorded>,
    /// Agents started for no session yet.
    spares: HashMap<LaunchKey, Spare>,
    next_spare: u64,
    /// Clients connected now.
    pub(crate) clients: usize,
}

impl Registry {
    /// The open session `session_id` is, or belongs to as a subagent.
    pub(crate) fn live(&self, session_id: &SessionId) -> Option<SessionHandle> {
        let root = self.children.get(session_id).unwrap_or(session_id);
        self.sessions.get(root).cloned()
    }
}

#[derive(Clone)]
pub struct Daemon {
    shared: Arc<Shared>,
}

impl Daemon {
    pub fn new(config: DaemonConfig) -> Self {
        let known = match &config.journals {
            Some(journals) => {
                journal::prune(journals, JOURNAL_RETENTION, &[]);
                journal::index(journals)
            }
            None => HashMap::new(),
        };
        let (stop, _) = watch::channel(false);
        let devices = devices::Devices::load(config.devices.clone());
        Self {
            shared: Arc::new(Shared {
                devices,
                updates: updates::Updates::default(),
                remote: Mutex::new(None),
                config,
                registry: Mutex::new(Registry {
                    known,
                    ..Registry::default()
                }),
                started_ms: now_ms(),
                next_client: AtomicU64::new(1),
                stop,
            }),
        }
    }

    /// Serve one client over `transport` until it disconnects.
    pub async fn serve_client(
        &self,
        transport: impl ConnectTo<Host> + 'static,
    ) -> Result<(), Error> {
        client::serve(Arc::clone(&self.shared), transport).await
    }

    /// A connection to this Host from the same process.
    pub fn connect_in_process(&self) -> Channel {
        let (client, host) = Channel::duplex();
        let this = self.clone();
        tokio::spawn(async move {
            if let Err(error) = this.serve_client(host).await {
                tracing::debug!(%error, "in-process client ended");
            }
        });
        client
    }

    /// Accept clients on `listener` until asked to stop, or until nothing has been open or
    /// connected for `idle_exit`. Then stop every session, leaving them recoverable. Only
    /// peers with the socket owner's user id are served.
    pub async fn serve(&self, listener: UnixListener, idle_exit: Option<Duration>) {
        let owner = socket::owner(&listener);
        let mut stop = self.shared.stop.subscribe();
        let mut checks = tokio::time::interval(Duration::from_secs(1));
        // Starting pruned already.
        let mut prunes =
            tokio::time::interval_at(tokio::time::Instant::now() + PRUNE_INTERVAL, PRUNE_INTERVAL);
        let mut idle_since: Option<Instant> = None;
        loop {
            tokio::select! {
                accepted = listener.accept() => match accepted {
                    Ok((stream, _)) => {
                        match socket::peer(&stream, owner) {
                            socket::Peer::Owner => {}
                            socket::Peer::Other(uid) => {
                                tracing::warn!(uid, "refused a connection from another user");
                                continue;
                            }
                            socket::Peer::Unknown => {
                                tracing::debug!("a connection closed before it could be checked");
                                continue;
                            }
                        }
                        let this = self.clone();
                        tokio::spawn(async move {
                            if let Err(error) = this.serve_client(socket::transport(stream)).await {
                                tracing::debug!(%error, "client connection ended");
                            }
                        });
                    }
                    Err(error) => tracing::warn!(%error, "accepting a client failed"),
                },
                changed = stop.changed() => {
                    if changed.is_err() || *stop.borrow() {
                        break;
                    }
                }
                _ = prunes.tick() => self.prune(),
                _ = checks.tick(), if idle_exit.is_some() => {
                    let quiet = {
                        let registry = self.shared.registry();
                        registry.sessions.is_empty() && registry.clients == 0
                    };
                    if !quiet {
                        idle_since = None;
                    } else if let Some(limit) = idle_exit
                        && idle_since.get_or_insert_with(Instant::now).elapsed() >= limit
                    {
                        tracing::info!("idle; exiting");
                        break;
                    }
                }
            }
        }
        self.shutdown().await;
    }

    /// Accept remote clients on `listener`, a loopback address Tailscale Serve forwards to,
    /// until the Host stops. Each has to prove a paired device at hello.
    pub async fn serve_remote(&self, listener: tokio::net::TcpListener, config: RemoteConfig) {
        *lock(&self.shared.remote) = listener
            .local_addr()
            .ok()
            .map(|address| address.to_string());
        websocket::serve(Arc::clone(&self.shared), listener, config).await;
        *lock(&self.shared.remote) = None;
    }

    /// Remove journals untouched for the retention period, except open sessions', and forget
    /// the sessions they recorded.
    fn prune(&self) {
        let Some(journals) = &self.shared.config.journals else {
            return;
        };
        let live: Vec<SessionId> = self.shared.registry().sessions.keys().cloned().collect();
        journal::prune(journals, JOURNAL_RETENTION, &live);
        self.shared
            .registry()
            .known
            .retain(|session_id, _| journal::path_for(journals, session_id).exists());
    }

    /// Ask [`Self::serve`] to stop.
    pub fn stop(&self) {
        let _ = self.shared.stop.send(true);
    }

    /// Stop every session's agent, and the spare ones. Their journals stay open, so a later
    /// Host can take them up again.
    pub async fn shutdown(&self) {
        let sessions: Vec<SessionHandle> =
            self.shared.registry().sessions.values().cloned().collect();
        let stops = sessions.iter().map(|session| {
            tokio::time::timeout(
                SUSPEND_TIMEOUT,
                session.finish(|done| Command::Suspend { done }),
            )
        });
        futures::future::join_all(stops).await;
        let spares: Vec<Spare> = self
            .shared
            .registry()
            .spares
            .drain()
            .map(|(_, spare)| spare)
            .collect();
        for spare in spares {
            spare.instance.connection.shutdown().await;
        }
    }

    /// What the Host has open.
    pub fn status(&self) -> HostStatus {
        self.shared.status()
    }

    /// Open a session (`request.session_id`, or a new one), start a turn in it and leave it
    /// running under the request's policy, with no client attached: what `session/run` does,
    /// and what a trigger calls directly.
    pub async fn run(&self, request: RunRequest) -> Result<SessionId, Error> {
        client::run(&self.shared, request, None)
            .await
            .map(|(session_id, _)| session_id)
    }
}

/// What the per-user Host's journal in `paths` records about `session_id`: the agent and
/// directory to reopen it with. Read from disk, so the Host needn't be running.
pub fn recorded_session(paths: &DaemonPaths, session_id: &SessionId) -> Option<Recorded> {
    journal::recorded(&paths.journals(), session_id)
}
