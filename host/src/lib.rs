//! The weave Host: agent threads that outlive the clients using them.
//!
//! Clients (the TUI, `weave run`, later others) speak the Host protocol
//! ([`weave_host_protocol`]) to it; it speaks ACP to the agents it launches, through
//! `weave-acp-core`. A client names an agent by id and a directory; the Host resolves the agent
//! from its configuration ([`weave_agents`]) and starts it with the agent environment it
//! captured. One connection reaches every thread on the Host.
//!
//! Each open thread has its own agent process, started in the thread's directory. A thread
//! stays open while a client is attached, while a turn runs or waits on a person, and for an
//! idle grace period after that; a client leaving doesn't stop its turn. Everything a
//! thread's clients are sent goes into its numbered journal, so a client that attaches later
//! catches up from the last position it saw, and a Host that restarts can take the thread up
//! again. Requests that wait on a person are pending requests every attached client sees, and
//! clients that attach later; the first answer counts. A thread's
//! [`PermissionPolicy`](weave_host_protocol::policy::PermissionPolicy) answers what it can
//! without anyone.
//!
//! The Host is git-aware (ADR 0019, [`git`]): it records where in a repository each thread's
//! directory is, and lists, makes and removes a repository's worktrees for clients.
//!
//! When a thread opens, the Host looks for a newer version of its agent in the background
//! and tells the thread's clients of one; `agents/update` moves the agent's new threads to
//! it, and `thread/reopen` an open thread, which keeps its id and journal (`updates`).
//!
//! A Host serves a Unix socket ([`socket`]), or, without one, a single client in the same
//! process ([`Daemon::connect_in_process`]). It listens for nothing else: the person's devices
//! reach it through the Dispatcher it joined, which carries their connections to it over
//! connections the Host opens itself ([`dispatcher`], ADR 0030). Hosts listened for them behind a
//! Tailscale Serve entry of their own until WVE-197, which a Host removes when it starts
//! ([`serve_entry`]).

mod admissions;
mod client;
mod devices;
mod dispatcher;
mod files;
mod git;
mod host_tools;
mod instance;
mod journal;
pub mod mcp;
mod modes;
pub mod paths;
mod queue;
mod serve_entry;
mod service_tools;
mod sessions;
pub mod socket;
pub mod terminals;
mod thread;
mod updates;

use std::collections::BTreeMap;
use std::collections::HashMap;
use std::collections::HashSet;
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
use agent_client_protocol::ConnectionTo;
use agent_client_protocol::Error;
use tokio::net::UnixListener;
use tokio::sync::watch;
use weave_acp_core::AgentHandle;
use weave_acp_core::AgentSpec;
use weave_acp_core::ClientOptions;
use weave_acp_core::schema::InitializeResponse;
use weave_agents::environment::Environment;
use weave_agents::update::Upstream;
use weave_host_protocol::Host;
use weave_host_protocol::HostClient;
use weave_host_protocol::PROTOCOL_VERSION;
use weave_host_protocol::agents::AgentRelease;
use weave_host_protocol::agents::AgentSource;
use weave_host_protocol::errors;
use weave_host_protocol::host::EnvironmentSource;
use weave_host_protocol::host::HostStatus;
use weave_host_protocol::host::Service;
use weave_host_protocol::threads::Activity;
use weave_host_protocol::threads::RunRequest;
use weave_host_protocol::threads::ThreadAgent;
use weave_host_protocol::threads::ThreadId;
use weave_host_protocol::threads::ThreadListing;
use weave_host_protocol::threads::ThreadRemovedNotification;
use weave_host_protocol::threads::ThreadUpdatedNotification;
use weave_host_protocol::worktrees::GitLocation;
pub use weave_remote::access::Serve;
pub use weave_remote::tailscale;
pub use weave_remote::websocket::RemoteConfig;

pub use crate::dispatcher::DispatcherSettings;
pub use crate::instance::AGENT_PROCESS_VARIABLE;
use crate::instance::Instance;
pub use crate::instance::Launch;
use crate::instance::LaunchKey;
pub use crate::instance::Launcher;
pub use crate::instance::process_launcher;
pub use crate::journal::Recorded;
pub use crate::journal::RecordedChoice;
use crate::journal::now_ms;
pub use crate::paths::DaemonPaths;
pub use crate::serve_entry::FormerServe;
use crate::thread::Command;
use crate::thread::Summary;
use crate::thread::ThreadHandle;
use crate::thread::lock;

/// How long a thread nothing needs stays open: no client attached, no turn running.
pub const DEFAULT_IDLE_GRACE: Duration = Duration::from_secs(30 * 60);
/// How long a blank thread (new, never prompted) nothing needs stays open: long enough for
/// a client's `/reload` or reconnect to reattach.
pub const DEFAULT_BLANK_GRACE: Duration = Duration::from_secs(60);
/// How long an agent process started for no thread waits to be taken by one.
const SPARE_GRACE: Duration = Duration::from_secs(60);
/// Journals untouched for this long are removed when a Host starts, and while it runs.
const JOURNAL_RETENTION: Duration = Duration::from_secs(14 * 24 * 60 * 60);
/// Why a thread a stopped Host left suspended was closed.
const UNCLAIMED: &str = "nobody took it up after the Host restarted";
/// How often a running Host prunes journals.
const PRUNE_INTERVAL: Duration = Duration::from_secs(60 * 60);
/// How long stopping waits for each thread's agent.
const SUSPEND_TIMEOUT: Duration = Duration::from_secs(10);
/// How long a Host about to stop waits for its running turns to end (WVE-143).
pub const DEFAULT_DRAIN_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// How often a drain looks whether turns are still running.
const DRAIN_POLL: Duration = Duration::from_millis(200);

pub struct DaemonConfig {
    /// Where thread journals are written; `None` keeps them in memory only.
    pub journals: Option<PathBuf>,
    /// Where Sessions' layouts are kept (WVE-202); `None` keeps them in memory only.
    pub sessions: Option<PathBuf>,
    /// How long a thread nothing needs stays open.
    pub idle_grace: Duration,
    /// How long stopping waits for running turns to end.
    pub drain_timeout: Duration,
    /// How long a blank thread nothing needs stays open.
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
    /// The record of the Host's id and the Dispatcher it joined; none keeps them in memory only.
    pub devices: Option<PathBuf>,
    /// Where newer versions of agents come from: npm and the ACP registry, or a test's.
    pub upstream: Arc<dyn Upstream>,
    /// The socket `weave mcp-bridge` connects to; one in a private temporary directory when
    /// absent.
    pub mcp_socket: Option<PathBuf>,
    /// The command, with its arguments, agents run as the Host MCP server's stdio bridge.
    pub mcp_bridge: Vec<String>,
    /// The Tailscale Serve entry the Host made for remote clients before WVE-197, which it
    /// removes if its `devices` show it served them; none for a Host that touches no Serve
    /// entry, as one inside a client, or one a test runs.
    pub former_serve: Option<FormerServe>,
    /// What keeps terminals alive for clients (ADR 0022); none for a Host without terminals, as
    /// one inside a client, or one installed without `weave-holder`.
    pub terminals: Option<Arc<dyn terminals::Owner>>,
    /// The home directory `~/…` paths between Hosts are under (ADR 0029); `$HOME` when none.
    pub home: Option<PathBuf>,
    /// Files earlier Hosts left that this one removes when it starts: a peer Host's
    /// `peers.json` and `host-key.json`, retired with peer Hosts (ADR 0029).
    pub retired: Vec<PathBuf>,
    /// Where the Host keeps the Dispatcher it joins (ADR 0030) and its own key for it; none for
    /// a Host that joins none, as one inside a client.
    pub dispatcher: Option<DispatcherSettings>,
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
            sessions: None,
            idle_grace: DEFAULT_IDLE_GRACE,
            drain_timeout: DEFAULT_DRAIN_TIMEOUT,
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
            mcp_socket: None,
            mcp_bridge: bridge_command(),
            former_serve: None,
            terminals: None,
            home: None,
            retired: Vec::new(),
            dispatcher: None,
        }
    }

    /// The per-user Host, with journals and traces in its directory.
    pub fn persistent(paths: &DaemonPaths, service: Service, environment: Environment) -> Self {
        Self {
            journals: Some(paths.journals()),
            sessions: Some(paths.sessions()),
            environment,
            service,
            traces: paths.dir.join("traces"),
            devices: Some(paths.devices()),
            mcp_socket: Some(paths.mcp_socket()),
            terminals: terminals::Holders::beside_this_program(paths.terminals())
                .map(|holders| Arc::new(holders) as Arc<dyn terminals::Owner>),
            retired: paths.retired(),
            dispatcher: Some(DispatcherSettings::in_dir(paths)),
            ..Self::in_process(None)
        }
    }
}

/// `weave mcp-bridge`, run from this binary.
fn bridge_command() -> Vec<String> {
    std::env::current_exe()
        .map(|exe| vec![exe.display().to_string(), "mcp-bridge".to_owned()])
        .unwrap_or_default()
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
    /// The mode its new threads start in.
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

    /// The agent as a thread's clients see it, once it answered `initialize`.
    pub(crate) fn thread_agent(&self, initialize: InitializeResponse) -> ThreadAgent {
        let name = initialize.agent_info.as_ref().map_or_else(
            || self.name.clone(),
            |info| info.title.clone().unwrap_or_else(|| info.name.clone()),
        );
        ThreadAgent {
            id: self.id.clone(),
            name,
            initialize,
            release: self.release(),
        }
    }
}

pub(crate) struct Shared {
    pub(crate) config: DaemonConfig,
    /// Request keys, admitted before their requests act.
    pub(crate) admissions: Arc<admissions::Admissions>,
    /// The Host MCP server.
    pub(crate) mcp: Arc<mcp::Mcp>,
    /// Git, with the agents' environment.
    pub(crate) git: git::Git,
    registry: Mutex<Registry>,
    pub(crate) devices: devices::Devices,
    /// The Dispatcher the Host joined, and its connection to it (ADR 0030).
    pub(crate) dispatcher: dispatcher::Joined,
    /// The connections serving services' tools, and calls waiting on them (WVE-171).
    pub(crate) service_tools: service_tools::ServiceTools,
    pub(crate) updates: updates::Updates,
    /// The Serve entry the Host made for remote clients before WVE-197, while it's left.
    pub(crate) serve_entry: serve_entry::ServeEntry,
    started_ms: u64,
    pub(crate) next_client: AtomicU64,
    pub(crate) stop: watch::Sender<bool>,
    /// Clients watching the Host's threads (`threads/watch`), by connection. Taken before
    /// the registry, never while holding it.
    watchers: Mutex<BTreeMap<u64, Watcher>>,
    /// The drain before the Host stops, while one is on: no new turns start.
    drain: Mutex<Option<Drain>>,
    /// Terminals, when the Host has an owner for them.
    pub(crate) terminals: Option<Arc<terminals::Terminals>>,
    /// Sessions and their layouts (WVE-202).
    pub(crate) sessions: sessions::Sessions,
    /// Held while a report takes up the thread it's for, so that two reports at once don't
    /// take it up twice (`host_tools::tell`).
    pub(crate) taking_up_for_reports: tokio::sync::Mutex<()>,
}

/// A thread in a Session, as [`Shared::session_contents`] lists it.
struct SessionThread {
    thread_id: ThreadId,
    last_activity: u64,
}

/// A drain before the Host stops.
#[derive(Debug, Default)]
struct Drain {
    /// The agent process whose turn isn't waited for: the one that asked.
    except: Option<String>,
    /// The client that asked (`host/drain`), whose going away before the Host stops ends the
    /// drain; none when a signal began it.
    client: Option<u64>,
    /// Waited for, or not to be: the stop that follows goes ahead at once.
    over: bool,
}

impl Shared {
    pub(crate) fn registry(&self) -> MutexGuard<'_, Registry> {
        lock(&self.registry)
    }

    /// Whether the Host is draining before it stops, so starts no new turns.
    pub(crate) fn draining(&self) -> bool {
        lock(&self.drain).is_some()
    }

    /// Drain, if the Host isn't already: for `client`'s `host/drain`, or for a signal.
    /// `except` names the agent process whose turn isn't waited for.
    pub(crate) fn begin_drain(&self, except: Option<String>, client: Option<u64>) {
        let mut drain = lock(&self.drain);
        let drain = drain.get_or_insert_with(Drain::default);
        if except.is_some() {
            drain.except = except;
        }
        if client.is_some() {
            drain.client = client;
        }
    }

    /// Wait, if `wait`, until no turn runs but the excepted one, or `timeout` passes. How
    /// many still run, which the stop that follows cuts off without waiting again.
    pub(crate) async fn wait_for_turns(&self, wait: bool, timeout: Duration) -> usize {
        let deadline = Instant::now() + if wait { timeout } else { Duration::ZERO };
        let running = loop {
            let running = self.running_turns();
            if running == 0 || Instant::now() >= deadline {
                break running;
            }
            tokio::time::sleep(DRAIN_POLL).await;
        };
        if let Some(drain) = lock(&self.drain).as_mut() {
            drain.over = true;
        }
        running
    }

    /// Whether the drain was waited for, or not to be, so a stop goes ahead at once.
    fn drain_over(&self) -> bool {
        lock(&self.drain).as_ref().is_some_and(|drain| drain.over)
    }

    /// Turns running, or waiting on someone, but for the excepted agent process's.
    fn running_turns(&self) -> usize {
        let except = lock(&self.drain)
            .as_ref()
            .and_then(|drain| drain.except.clone());
        self.registry()
            .threads
            .values()
            .map(ThreadHandle::summary)
            .filter(|summary| {
                summary.activity != Activity::Idle
                    && except.as_deref() != Some(summary.agent_process.as_str())
            })
            .count()
    }

    /// The client that asked for the drain went before the Host stopped: drain no more, and
    /// let queues start what waits in them.
    pub(crate) fn lapse_drain(&self, client: u64) {
        let lapsed = {
            let mut drain = lock(&self.drain);
            let asked = drain
                .as_ref()
                .is_some_and(|drain| drain.client == Some(client));
            if asked && !*self.stop.borrow() {
                *drain = None;
            }
            asked && drain.is_none()
        };
        if lapsed {
            tracing::info!("the client that asked for a drain went; turns start again");
            for thread in self.registry().threads.values() {
                let _ = thread.send(Command::Advance);
            }
        }
    }

    /// The configuration, read afresh, so edits apply to the next thread.
    /// The home directory `~/…` paths between Hosts are under.
    pub(crate) fn home(&self) -> PathBuf {
        self.config.home.clone().unwrap_or_else(client::home)
    }

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
            process: Launch::new_process(),
        }
    }

    /// An initialized agent for a new or reopened thread: a spare one, or a new one.
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
        self.provide_mcp(&instance);
        if let Some(init) = instance.init() {
            self.registry().initialized.insert(key, init.clone());
        }
        Ok(instance)
    }

    /// Answer the agent's MCP-over-ACP requests with the Host MCP server.
    pub(crate) fn provide_mcp(&self, instance: &Instance) {
        instance
            .connection
            .handle()
            .provide_mcp(self.mcp.provider());
    }

    /// Keep an agent no thread took, as after `auth_required`, for the next request; it
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

    /// An agent to ask something of outside any thread (list, delete, sign in): an open
    /// thread's of the same agent, or a spare.
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
                .threads
                .values()
                .find(|thread| thread.key == key)
                .map(|thread| thread.agent.clone());
            if let Some(agent) = live {
                return Ok(agent);
            }
        }
        let instance = self.instance(agent, cwd, options).await?;
        let handle = instance.connection.handle();
        self.keep_spare(instance);
        Ok(handle)
    }

    /// The spare agents of `agent_id`, which the next threads for it take.
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

    /// Where `thread_id`'s protocol trace goes.
    pub(crate) fn trace_path(&self, thread_id: &ThreadId) -> Result<PathBuf, Error> {
        journal::create_private_dir(&self.config.traces).map_err(|error| {
            Error::internal_error().data(format!(
                "creating {}: {error}",
                self.config.traces.display()
            ))
        })?;
        let file = journal::path_for(&self.config.traces, thread_id);
        Ok(file.with_extension("jsons"))
    }

    /// The threads the Host has a journal for, across agents, most recently active first:
    /// what `threads/list` gives without an agent, and `threads/watch` starts from. Blank
    /// threads aren't listed. With `cwd`, only those there; with `repo`, a primary worktree,
    /// only those in its repository.
    pub(crate) fn listings(&self, cwd: Option<&Path>, repo: Option<&Path>) -> Vec<ThreadListing> {
        let registry = self.registry();
        let in_scope = |dir: &Path, git: Option<&GitLocation>| {
            cwd.is_none_or(|cwd| cwd == dir)
                && repo.is_none_or(|repo| git.is_some_and(|git| git.repo == repo))
        };
        let mut threads: Vec<ThreadListing> = registry
            .threads
            .values()
            .filter(|thread| !thread.is_blank())
            .map(ThreadHandle::summary)
            .filter(|summary| in_scope(&summary.cwd, summary.git.as_ref()))
            .map(|summary| summary.listing())
            .collect();
        for (thread_id, recorded) in &registry.known {
            if registry.threads.contains_key(thread_id)
                || !in_scope(&recorded.cwd, recorded.git.as_ref())
            {
                continue;
            }
            let Some(agent_id) = recorded.agent_id() else {
                continue;
            };
            threads.push(client::dormant(thread_id, agent_id, recorded));
        }
        threads.sort_by_key(|listing| std::cmp::Reverse(listing.last_activity_at));
        threads
    }

    /// Each thread the Host has a record of, open or not, blank ones aside: its directory with
    /// symlinks resolved, and when it was last active.
    pub(crate) fn thread_directories(&self) -> Vec<(ThreadId, PathBuf, u64)> {
        let threads: Vec<(ThreadId, PathBuf, u64)> = {
            let registry = self.registry();
            let open = registry
                .threads
                .values()
                .filter(|thread| !thread.is_blank())
                .map(ThreadHandle::summary)
                .map(|summary| (summary.thread_id, summary.cwd, summary.last_activity_ms));
            let dormant = registry
                .known
                .iter()
                .filter(|(thread_id, _)| !registry.threads.contains_key(*thread_id))
                .map(|(thread_id, recorded)| {
                    (
                        thread_id.clone(),
                        recorded.cwd.clone(),
                        recorded.last_activity_ms,
                    )
                });
            open.chain(dormant).collect()
        };
        threads
            .into_iter()
            .map(|(thread_id, cwd, last_activity)| (thread_id, git::canonical(&cwd), last_activity))
            .collect()
    }

    /// The Session a directory is in: the deepest worktree it's in, or the directory itself
    /// outside a repository, with symlinks resolved; and where in a repository that is.
    pub(crate) async fn session_scope(
        &self,
        directory: &Path,
    ) -> Result<(PathBuf, Option<GitLocation>), Error> {
        if !directory.is_absolute() || !directory.is_dir() {
            return Err(Error::invalid_params().data(serde_json::json!(format!(
                "{} isn't a directory",
                directory.display()
            ))));
        }
        Ok(match self.git.locate(directory).await {
            Some(location) => (location.worktree.clone(), Some(location)),
            None => (git::canonical(directory), None),
        })
    }

    /// Which of `threads` and `terminals`, as the Session at `directory` names its own, are
    /// still there: the threads, open or not, most recently active first, and the terminals'
    /// ids, oldest first.
    pub(crate) fn session_contents(
        &self,
        directory: &Path,
        threads: &[ThreadId],
        terminals: &[String],
    ) -> (Vec<ThreadId>, Vec<String>) {
        let mut there = self.threads_in_session(directory);
        there.retain(|thread| threads.contains(&thread.thread_id));
        there.sort_by_key(|thread| std::cmp::Reverse(thread.last_activity));
        let there = there.into_iter().map(|thread| thread.thread_id).collect();
        let mut running = self.terminals_in_session(directory, false);
        running.retain(|id| terminals.contains(id));
        (there, running)
    }

    /// Whether each of `threads` and `terminals` is in `directory`, a Session's, as
    /// `sessions/add` needs of what it adds: a thread by its worktree or its directory, blank
    /// ones too, and a terminal by its scope.
    pub(crate) async fn in_directory(
        &self,
        directory: &Path,
        threads: &[ThreadId],
        terminals: &[String],
    ) -> Result<(), Error> {
        /// Where a thread runs, when the Host has a record of it.
        type Place = Option<(PathBuf, Option<GitLocation>)>;
        // Taken from the registry first, so it isn't held while directories are resolved.
        let places: Vec<(ThreadId, Place)> = {
            let registry = self.registry();
            threads
                .iter()
                .map(|thread_id| {
                    let place = match registry.threads.get(thread_id) {
                        Some(thread) => {
                            let summary = thread.summary();
                            Some((summary.cwd, summary.git))
                        }
                        None => registry
                            .known
                            .get(thread_id)
                            .map(|recorded| (recorded.cwd.clone(), recorded.git.clone())),
                    };
                    (thread_id.clone(), place)
                })
                .collect()
        };
        for (thread_id, place) in places {
            let inside = match place {
                Some((_, Some(git))) => git.worktree == directory,
                Some((cwd, None)) => git::canonical(&cwd) == directory,
                None => false,
            };
            if !inside {
                return Err(Error::invalid_params().data(format!(
                    "the thread {thread_id} isn't in {}",
                    directory.display()
                )));
            }
        }
        if terminals.is_empty() {
            return Ok(());
        }
        let running = match &self.terminals {
            Some(owner) => {
                owner.ready().await;
                owner.list(directory)
            }
            None => Vec::new(),
        };
        for id in terminals {
            if !running.iter().any(|terminal| &terminal.id == id) {
                return Err(Error::invalid_params().data(format!(
                    "the terminal {id} isn't in {}",
                    directory.display()
                )));
            }
        }
        Ok(())
    }

    /// Close what's in the Session at `directory` (symlinks resolved) before it ends
    /// (`sessions/end`): refused, with nothing closed, while a thread of its runs a turn or waits
    /// on a request, or a terminal of its runs a command; otherwise its terminals end and its
    /// open threads close, blank ones included. Only what's the Session's: a thread or terminal
    /// in its directory that no client added to it, as one started from a terminal, is left as
    /// it is.
    pub(crate) async fn close_session(&self, directory: &Path) -> Result<(), Error> {
        let (own_threads, own_terminals) = self.sessions.members(directory).unwrap_or_default();
        // Taken from the registry first, so it isn't held while directories are resolved.
        let mut inside: Vec<(ThreadHandle, Summary)> = self
            .registry()
            .threads
            .values()
            .map(|thread| (thread.clone(), thread.summary()))
            .collect();
        inside.retain(|(_, summary)| {
            own_threads.contains(&summary.thread_id)
                && match &summary.git {
                    Some(git) => git.worktree == directory,
                    None => git::canonical(&summary.cwd) == directory,
                }
        });
        let busy: Vec<ThreadId> = inside
            .iter()
            .filter(|(_, summary)| summary.activity != Activity::Idle)
            .map(|(_, summary)| summary.thread_id.clone())
            .collect();
        let (terminals, busy_terminals): (Vec<String>, Vec<String>) = match &self.terminals {
            Some(terminals) => {
                terminals.ready().await;
                let mut listed = terminals.list(directory);
                listed.retain(|terminal| own_terminals.contains(&terminal.id));
                let busy = listed
                    .iter()
                    .filter(|terminal| {
                        terminal
                            .command
                            .as_ref()
                            .is_some_and(|command| command.running)
                    })
                    .map(|terminal| terminal.id.clone())
                    .collect();
                (
                    listed.into_iter().map(|terminal| terminal.id).collect(),
                    busy,
                )
            }
            None => (Vec::new(), Vec::new()),
        };
        if !busy.is_empty() || !busy_terminals.is_empty() {
            return Err(errors::session_busy(&busy, &busy_terminals));
        }
        if let Some(owner) = &self.terminals {
            for id in &terminals {
                // One that ended meanwhile is gone already.
                let _ = owner.close(id).await;
            }
        }
        for (thread, _) in inside {
            // One that ended meanwhile is closed already.
            let _ = thread
                .finish(|done| Command::End {
                    reason: "its Session ended".to_owned(),
                    by: None,
                    done,
                })
                .await;
        }
        Ok(())
    }

    /// What the thread `by` started in `directory` joins the Session there, when `by` is in it:
    /// a thread its agent started, or a terminal opened from it. The Host makes no Session for
    /// it otherwise (WVE-203).
    pub(crate) fn started_in_session(
        &self,
        directory: &Path,
        by: &ThreadId,
        thread: Option<&ThreadId>,
        terminal: Option<&str>,
    ) {
        self.sessions.add_started(
            directory,
            by,
            thread,
            terminal,
            &|directory, threads, terminals| self.session_contents(directory, threads, terminals),
        );
    }

    /// The ids of the terminals in the Session at `directory`, oldest first; with `busy`, only
    /// those running a command.
    fn terminals_in_session(&self, directory: &Path, busy: bool) -> Vec<String> {
        let Some(terminals) = &self.terminals else {
            return Vec::new();
        };
        terminals
            .list(directory)
            .into_iter()
            .filter(|terminal| {
                !busy
                    || terminal
                        .command
                        .as_ref()
                        .is_some_and(|command| command.running)
            })
            .map(|terminal| terminal.id)
            .collect()
    }

    /// The threads the Host has a record of in the directory of the Session at `directory`,
    /// blank ones too: one a client just started as a Block is the Session's before it's prompted.
    fn threads_in_session(&self, directory: &Path) -> Vec<SessionThread> {
        let threads: Vec<(SessionThread, PathBuf, Option<GitLocation>)> = {
            let registry = self.registry();
            let open = registry
                .threads
                .values()
                .map(ThreadHandle::summary)
                .map(|summary| {
                    let thread = SessionThread {
                        thread_id: summary.thread_id,
                        last_activity: summary.last_activity_ms,
                    };
                    (thread, summary.cwd, summary.git)
                });
            let dormant = registry
                .known
                .iter()
                .filter(|(thread_id, _)| !registry.threads.contains_key(*thread_id))
                .map(|(thread_id, recorded)| {
                    let thread = SessionThread {
                        thread_id: thread_id.clone(),
                        last_activity: recorded.last_activity_ms,
                    };
                    (thread, recorded.cwd.clone(), recorded.git.clone())
                });
            open.chain(dormant).collect()
        };
        // Resolved outside the registry, which isn't held while the file system is asked.
        threads
            .into_iter()
            .filter(|(_, cwd, git)| match git {
                Some(git) => git.worktree == directory,
                None => git::canonical(cwd) == directory,
            })
            .map(|(thread, _, _)| thread)
            .collect()
    }

    /// Let the worktree at `path` (symlinks resolved) go before it's removed: refused while a
    /// thread in it runs a turn or waits on a request, otherwise closing the threads open in
    /// it, blank ones included. Those it closed.
    pub(crate) async fn release(&self, path: &Path) -> Result<Vec<ThreadId>, Error> {
        // Taken from the registry first, so it isn't held while directories are resolved.
        let mut inside: Vec<(ThreadHandle, Summary)> = self
            .registry()
            .threads
            .values()
            .map(|thread| (thread.clone(), thread.summary()))
            .collect();
        inside.retain(|(_, summary)| git::canonical(&summary.cwd).starts_with(path));
        let busy: Vec<ThreadId> = inside
            .iter()
            .filter(|(_, summary)| summary.activity != Activity::Idle)
            .map(|(_, summary)| summary.thread_id.clone())
            .collect();
        let (terminals, busy_terminals) = match &self.terminals {
            Some(terminals) => {
                terminals.ready().await;
                terminals.inside(path)
            }
            None => (Vec::new(), Vec::new()),
        };
        if !busy.is_empty() || !busy_terminals.is_empty() {
            return Err(errors::worktree_busy(&busy, &busy_terminals));
        }
        if let Some(owner) = &self.terminals {
            for id in &terminals {
                // One that ended meanwhile is gone already.
                let _ = owner.close(id).await;
            }
        }
        let mut closed = Vec::new();
        for (thread, summary) in inside {
            // One that ended meanwhile is closed already.
            let _ = thread
                .finish(|done| Command::End {
                    reason: "its worktree was removed".to_owned(),
                    by: None,
                    done,
                })
                .await;
            closed.push(summary.thread_id);
        }
        Ok(closed)
    }

    /// `threads/watch`: `respond` with the Host's threads as they are, then tell `client` of
    /// every change from there on. Nothing reaches watchers between the two, so the client
    /// misses nothing and hears nothing older than its listing.
    ///
    /// With `labels`, only the threads that carry every one of them (WVE-173).
    pub(crate) fn watch(
        &self,
        client: u64,
        cx: ConnectionTo<HostClient>,
        labels: Vec<String>,
        respond: impl FnOnce(Vec<ThreadListing>) -> Result<(), Error>,
    ) -> Result<(), Error> {
        let mut watchers = lock(&self.watchers);
        let mut threads = self.listings(None, None);
        threads.retain(|listing| client::labelled(listing, &labels));
        let matched = threads
            .iter()
            .map(|listing| listing.info.session_id.clone())
            .collect();
        respond(threads)?;
        watchers.insert(
            client,
            Watcher {
                cx,
                labels,
                matched,
            },
        );
        Ok(())
    }

    pub(crate) fn unwatch(&self, client: u64) {
        lock(&self.watchers).remove(&client);
    }

    /// Tell the clients watching the Host's threads how `thread` lists now, dropping those
    /// that have gone. A watcher for labels hears of it while it carries them, and once more
    /// when a change takes it out of what it watches.
    pub(crate) fn tell_updated(&self, thread: ThreadListing) {
        let thread_id = thread.info.session_id.clone();
        let notification = ThreadUpdatedNotification { thread };
        lock(&self.watchers).retain(|_, watcher| {
            let told = if watcher.labels.is_empty() {
                true
            } else if client::labelled(&notification.thread, &watcher.labels) {
                watcher.matched.insert(thread_id.clone());
                true
            } else {
                watcher.matched.remove(&thread_id)
            };
            !told || watcher.cx.send_notification(notification.clone()).is_ok()
        });
    }

    /// Tell the clients watching the Host's threads that `thread_id` is gone: those that
    /// watch it.
    pub(crate) fn tell_removed(&self, thread_id: ThreadId) {
        let notification = ThreadRemovedNotification { thread_id };
        lock(&self.watchers).retain(|_, watcher| {
            let told = watcher.labels.is_empty() || watcher.matched.remove(&notification.thread_id);
            !told || watcher.cx.send_notification(notification.clone()).is_ok()
        });
    }

    pub(crate) fn status(&self) -> HostStatus {
        let mut threads: Vec<_> = self
            .registry()
            .threads
            .values()
            .map(ThreadHandle::summary)
            .collect();
        threads.sort_by_key(|thread| thread.last_activity_ms);
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
            threads: threads.iter().map(thread::Summary::listing).collect(),
            serve_entry: self.serve_entry.left(),
            dispatcher: self.dispatcher.status(),
        }
    }
}

/// An agent started for no thread yet.
pub(crate) struct Spare {
    instance: Instance,
    /// Which keeping of it this is, so an old expiry leaves a newer one alone.
    generation: u64,
}

/// A client watching the Host's threads, for the labels it asked for, if any.
struct Watcher {
    cx: ConnectionTo<HostClient>,
    labels: Vec<String>,
    /// The threads that carried them when it last heard of each, with `labels`.
    matched: HashSet<ThreadId>,
}

#[derive(Default)]
pub(crate) struct Registry {
    /// Open threads, by id.
    pub(crate) threads: HashMap<ThreadId, ThreadHandle>,
    /// Subagent threads, and the open thread they belong to.
    pub(crate) children: HashMap<ThreadId, ThreadId>,
    /// Each agent's `initialize` answer, so asking again starts nothing.
    pub(crate) initialized: HashMap<LaunchKey, InitializeResponse>,
    /// Every thread the journals record, open or not: which agent, where, under which
    /// policy, and whether it was closed or left open by a Host that stopped.
    pub(crate) known: HashMap<ThreadId, Recorded>,
    /// Agents started for no thread yet.
    spares: HashMap<LaunchKey, Spare>,
    next_spare: u64,
    /// Clients connected now.
    pub(crate) clients: usize,
    /// Threads being taken up from their journals now. Nothing else writes those journals
    /// meanwhile.
    pub(crate) taking_up: HashSet<ThreadId>,
}

impl Registry {
    /// The open thread `thread_id` is, or belongs to as a subagent.
    pub(crate) fn live(&self, thread_id: &ThreadId) -> Option<ThreadHandle> {
        self.threads.get(&self.root(thread_id)).cloned()
    }

    /// The thread `thread_id` is, or belongs to as an open subagent thread, whose journal
    /// holds its events.
    pub(crate) fn root(&self, thread_id: &ThreadId) -> ThreadId {
        self.children.get(thread_id).unwrap_or(thread_id).clone()
    }

    /// Where `thread_id`'s work goes on now (WVE-168): the last of its successors, or itself
    /// when it names none.
    pub(crate) fn latest_successor(&self, thread_id: &ThreadId) -> ThreadId {
        let mut latest = thread_id.clone();
        for _ in 0..MAX_SUCCESSORS {
            match self
                .known
                .get(&latest)
                .and_then(|recorded| recorded.successor.clone())
            {
                Some(next) => latest = next,
                None => break,
            }
        }
        latest
    }
}

/// The threads `known` that carry labels, whose journals pruning keeps (WVE-173).
fn labelled(known: &HashMap<ThreadId, Recorded>) -> Vec<ThreadId> {
    known
        .iter()
        .filter(|(_, recorded)| !recorded.labels.is_empty())
        .map(|(thread_id, _)| thread_id.clone())
        .collect()
}

/// How many successors of a thread are followed, at most.
pub(crate) const MAX_SUCCESSORS: usize = 64;

#[derive(Clone)]
pub struct Daemon {
    shared: Arc<Shared>,
}

impl Daemon {
    pub fn new(mut config: DaemonConfig) -> Self {
        let known = match &config.journals {
            Some(journals) => {
                match journal::move_from_version_2(journals) {
                    Ok(true) => tracing::info!(
                        to = %journals.display(),
                        "moved the journals from where version 2 of the Host protocol kept them"
                    ),
                    Ok(false) => {}
                    Err(error) => tracing::warn!(
                        %error,
                        to = %journals.display(),
                        "couldn't move the journals from where version 2 of the Host protocol kept them"
                    ),
                }
                // Read first, so labelled threads' journals are kept.
                let mut known = journal::index(journals);
                journal::prune(journals, JOURNAL_RETENTION, &labelled(&known));
                known.retain(|thread_id, _| journal::path_for(journals, thread_id).exists());
                known
            }
            None => HashMap::new(),
        };
        let (stop, _) = watch::channel(false);
        let devices = devices::Devices::load(config.devices.clone());
        let joined = dispatcher::Joined::load(config.dispatcher.clone());
        let admissions = Arc::new(admissions::Admissions::load(
            config.journals.as_deref(),
            JOURNAL_RETENTION,
        ));
        let terminals = config.terminals.clone().map(terminals::Terminals::new);
        let config_sessions = config.sessions.clone();
        for retired in &config.retired {
            match std::fs::remove_file(retired) {
                Ok(()) => {
                    tracing::info!(path = %retired.display(), "removed a peer Host's file: Hosts reach each other through the Dispatcher now");
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    tracing::warn!(path = %retired.display(), %error, "couldn't remove a peer Host's file");
                }
            }
        }
        Self {
            shared: Arc::new_cyclic(|shared| Shared {
                admissions,
                mcp: Arc::new(mcp::Mcp::new(shared.clone())),
                git: git::Git::new(&config.environment.vars),
                devices,
                dispatcher: joined,
                service_tools: service_tools::ServiceTools::default(),
                updates: updates::Updates::default(),
                serve_entry: serve_entry::ServeEntry::new(config.former_serve.take()),
                config,
                registry: Mutex::new(Registry {
                    known,
                    ..Registry::default()
                }),
                started_ms: now_ms(),
                next_client: AtomicU64::new(1),
                stop,
                watchers: Mutex::new(BTreeMap::new()),
                drain: Mutex::new(None),
                terminals,
                sessions: sessions::Sessions::load(config_sessions),
                taking_up_for_reports: tokio::sync::Mutex::new(()),
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

    /// A connection from the same process for a client that runs beside the Host, which
    /// doesn't keep it running when it's otherwise idle: `weave daemon`'s follower of threads
    /// for Rex (ADR 0025).
    pub fn connect_beside(&self) -> Channel {
        let (client, host) = Channel::duplex();
        let shared = Arc::clone(&self.shared);
        tokio::spawn(async move {
            if let Err(error) = client::serve_beside(shared, host).await {
                tracing::debug!(%error, "a client beside the Host ended");
            }
        });
        client
    }

    /// Accept clients on `listener` until asked to stop, or until nothing has been open or
    /// connected for `idle_exit`. Then stop every thread, leaving them recoverable. Only
    /// peers with the socket owner's user id are served.
    pub async fn serve(&self, listener: UnixListener, idle_exit: Option<Duration>) {
        let owner = socket::owner(&listener);
        let mut stop = self.shared.stop.subscribe();
        let mut checks = tokio::time::interval(Duration::from_secs(1));
        // Starting pruned already.
        let mut prunes =
            tokio::time::interval_at(tokio::time::Instant::now() + PRUNE_INTERVAL, PRUNE_INTERVAL);
        // Threads a stopped Host left suspended have the idle grace to be taken up.
        let unclaimed = tokio::time::sleep(self.shared.config.idle_grace);
        tokio::pin!(unclaimed);
        let mut unclaimed_closed = false;
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
                () = &mut unclaimed, if !unclaimed_closed => {
                    unclaimed_closed = true;
                    self.close_unclaimed();
                }
                _ = checks.tick(), if idle_exit.is_some() => {
                    let quiet = {
                        let registry = self.shared.registry();
                        registry.threads.is_empty() && registry.clients == 0
                    } && !self.shared.dispatcher.is_joined();
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

    /// Serve local clients' terminal streams on `socket`, beside the Host's own, until the Host
    /// stops; nothing for a Host without terminals.
    pub async fn serve_terminal_streams(&self, socket: &Path) -> std::io::Result<()> {
        if self.shared.terminals.is_none() {
            return Ok(());
        }
        let listener = socket::bind_private(socket)?;
        terminals::stream::serve_local(Arc::clone(&self.shared), listener).await;
        let _ = std::fs::remove_file(socket);
        Ok(())
    }

    /// At startup, connect to the Dispatcher the Host joined, if it joined one (ADR 0030).
    pub fn resume_dispatcher(&self) {
        dispatcher::resume(&self.shared);
    }

    /// Join the Dispatcher at `request.address` with the code it gave, as `dispatcher/join`
    /// does, and keep a connection to it.
    pub async fn join_dispatcher(
        &self,
        request: weave_host_protocol::dispatcher::JoinDispatcherRequest,
    ) -> Result<weave_host_protocol::dispatcher::JoinedDispatcher, Error> {
        dispatcher::join(&self.shared, request).await
    }

    /// The Dispatcher the Host joined, and how its connection stands.
    pub fn dispatcher(&self) -> Option<weave_host_protocol::dispatcher::JoinedDispatcher> {
        self.shared.dispatcher.status()
    }

    /// At startup, remove the Tailscale Serve entry the Host made for remote clients before
    /// they reached it through the Dispatcher (WVE-197), if its directory shows it served them;
    /// a Host that can't says so in `host/status`, with the command for the person.
    pub async fn remove_serve_entry(&self) {
        self.shared.serve_entry.remove(&self.shared.devices).await;
    }

    /// Remove journals untouched for the retention period, except open and labelled threads',
    /// and forget the threads they recorded.
    fn prune(&self) {
        let Some(journals) = &self.shared.config.journals else {
            return;
        };
        let kept: Vec<ThreadId> = {
            let registry = self.shared.registry();
            let mut kept = labelled(&registry.known);
            kept.extend(registry.threads.keys().cloned());
            kept
        };
        journal::prune(journals, JOURNAL_RETENTION, &kept);
        self.shared.admissions.prune(JOURNAL_RETENTION);
        let mut pruned = Vec::new();
        self.shared.registry().known.retain(|thread_id, _| {
            let kept = journal::path_for(journals, thread_id).exists();
            if !kept {
                pruned.push(thread_id.clone());
            }
            kept
        });
        for thread_id in pruned {
            self.shared.tell_removed(thread_id);
        }
    }

    /// Close the threads a stopped Host left suspended that nobody has taken up since this
    /// one started: [`Self::serve`] does so once the idle grace has passed, as it would have
    /// closed them had it kept running. Their journals end closed, keeping their age, and
    /// watchers hear of it. They can still be opened again from their agents' histories.
    pub fn close_unclaimed(&self) {
        let Some(journals) = &self.shared.config.journals else {
            return;
        };
        let mut closed = Vec::new();
        {
            let mut registry = self.shared.registry();
            let unclaimed: Vec<ThreadId> = registry
                .known
                .iter()
                .filter(|(thread_id, recorded)| {
                    !recorded.closed
                        && !registry.threads.contains_key(*thread_id)
                        && !registry.taking_up.contains(*thread_id)
                })
                .map(|(thread_id, _)| thread_id.clone())
                .collect();
            for thread_id in unclaimed {
                if let Err(error) = journal::close(journals, &thread_id, UNCLAIMED) {
                    tracing::warn!(%error, %thread_id, "couldn't close a suspended thread");
                    continue;
                }
                if let Some(recorded) = registry.known.get_mut(&thread_id) {
                    recorded.closed = true;
                    if let Some(agent_id) = recorded.agent_id() {
                        closed.push(client::dormant(&thread_id, agent_id, recorded));
                    }
                }
            }
        }
        for thread in closed {
            tracing::info!(thread_id = %thread.info.session_id, "closed a suspended session nobody took up");
            self.shared.tell_updated(thread);
        }
    }

    /// At startup, take up the suspended headless threads whose queue holds prompts and isn't
    /// paused, so their queue runs with nobody attached (WVE-107), and those a stopped Host was
    /// running a turn in, which they continue (WVE-144). Interactive threads wait for a client.
    pub async fn resume_queues(&self) {
        let Some(journals) = &self.shared.config.journals else {
            return;
        };
        let waiting: Vec<(ThreadId, Recorded)> = self
            .shared
            .registry()
            .known
            .iter()
            .filter(|(_, recorded)| !recorded.closed && recorded.policy.is_headless())
            .map(|(thread_id, recorded)| (thread_id.clone(), recorded.clone()))
            .collect();
        for (thread_id, recorded) in waiting {
            let Some(agent_id) = recorded.agent_id() else {
                continue;
            };
            // Its queue waits, or a turn the stopped Host ran in it is to be continued.
            let ready =
                journal::read(&journal::path_for(journals, &thread_id)).is_ok_and(|records| {
                    queue::Queue::from_records(&records).is_ready()
                        || journal::open_turns(&records)
                            .iter()
                            .any(|open| open.thread_id == thread_id)
                });
            if !ready {
                continue;
            }
            tracing::info!(%thread_id, "taking up a headless thread whose queue waits or whose turn was cut off");
            if let Err(error) = client::take_up(
                &self.shared,
                agent_id,
                recorded.cwd.clone(),
                thread_id.clone(),
                recorded.policy.clone(),
            )
            .await
            {
                tracing::warn!(%error, %thread_id, "couldn't take up a thread whose queue waits");
            }
        }
    }

    /// Ask [`Self::serve`] to stop.
    pub fn stop(&self) {
        let _ = self.shared.stop.send(true);
    }

    /// Get ready to stop, as on SIGTERM: start no new turns, and wait up to the drain
    /// timeout for the running ones to end, unless a client's `host/drain` was waited for
    /// already. How many still run.
    pub async fn drain(&self) -> usize {
        self.shared.begin_drain(None, None);
        let wait = !self.shared.drain_over();
        let running = self.shared.running_turns();
        if wait && running > 0 {
            tracing::info!(running, "waiting for running turns before stopping");
        }
        let left = self
            .shared
            .wait_for_turns(wait, self.shared.config.drain_timeout)
            .await;
        if left > 0 {
            tracing::warn!(left, "stopping with turns still running");
        }
        left
    }

    /// Stop every thread's agent, and the spare ones. Their journals stay open, so a later
    /// Host can take them up again.
    pub async fn shutdown(&self) {
        dispatcher::stop(&self.shared);
        let threads: Vec<ThreadHandle> = self.shared.registry().threads.values().cloned().collect();
        let stops = threads.iter().map(|thread| {
            tokio::time::timeout(
                SUSPEND_TIMEOUT,
                thread.finish(|done| Command::Suspend { done }),
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

    /// Open a thread (`request.thread_id`, or a new one), start a turn in it and leave it
    /// running under the request's policy, with no client attached: what `thread/run` does,
    /// and what a trigger calls directly.
    pub async fn run(&self, request: RunRequest) -> Result<ThreadId, Error> {
        client::run(&self.shared, request, None)
            .await
            .map(|answer| answer.thread_id)
    }
}

/// What the per-user Host's journal in `paths` records about `thread_id`: the agent and
/// directory to reopen it with. Read from disk, so the Host needn't be running.
pub fn recorded_thread(paths: &DaemonPaths, thread_id: &ThreadId) -> Option<Recorded> {
    journal::recorded(&paths.journals(), thread_id)
}

/// The id of the Host in `paths`, which the Dispatcher knows it by, as its directory keeps it:
/// none before it first ran. Read from disk, so the Host needn't be running: `--project` finds
/// the Project's location on this computer's Host by it (WVE-189).
pub fn own_id(paths: &DaemonPaths) -> Option<String> {
    let bytes = std::fs::read(paths.devices()).ok()?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    value
        .get("hostId")?
        .as_str()
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
}

/// What the Host in `paths` is known by among the person's Hosts: its id, and the name the
/// Dispatcher it joined calls it. Read from disk, so the Host needn't be running: a client
/// asked for a Host by either reaches this one over its socket rather than through the
/// Dispatcher (WVE-195).
pub fn known_as(paths: &DaemonPaths) -> Vec<String> {
    let read = |path: PathBuf, field: &str| {
        let bytes = std::fs::read(path).ok()?;
        let value: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
        value.get(field)?.as_str().map(str::to_owned)
    };
    [
        read(paths.devices(), "hostId"),
        read(paths.dispatcher(), "hostName"),
    ]
    .into_iter()
    .flatten()
    .filter(|known| !known.is_empty())
    .collect()
}
