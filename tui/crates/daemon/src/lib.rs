//! The weave daemon: agent sessions that outlive the clients using them.
//!
//! The daemon is an ACP agent to its clients (the TUI, `weave run`) and an ACP client to the
//! agents it launches, through `weave-acp-core` like any other client. A client names the
//! agent it wants at `initialize` and then speaks plain ACP; [`weave_acp_core::daemon_protocol`]
//! covers the rest.
//!
//! Each live session has its own agent process, started in the session's directory with the
//! environment of the client that opened it. A session stays live while a client is attached,
//! while a turn runs or waits on a person, and for an idle grace period after that; quitting a
//! client doesn't stop its turn. Everything a session's clients are sent goes into its
//! journal, so a client that attaches later (`session/load`) sees the whole transcript, and a
//! daemon that restarts can take the session up again. Requests that wait on a person go to
//! every attached client, and to clients that attach later, until one answers; a session's
//! [`PermissionPolicy`](weave_acp_core::daemon_protocol::PermissionPolicy) answers what it can
//! without anyone.
//!
//! A daemon serves a Unix socket ([`socket`]), or, without one, a single client in the same
//! process ([`Daemon::connect_in_process`]).

mod client;
mod instance;
mod journal;
pub mod paths;
mod session;
pub mod socket;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::atomic::AtomicU64;
use std::time::Duration;
use std::time::Instant;

use agent_client_protocol::Agent;
use agent_client_protocol::Channel;
use agent_client_protocol::ConnectTo;
use agent_client_protocol::Error;
use tokio::net::UnixListener;
use tokio::sync::watch;
use weave_acp_core::daemon_protocol::DaemonStatus;
use weave_acp_core::daemon_protocol::PROTOCOL_VERSION;
use weave_acp_core::daemon_protocol::RunRequest;
use weave_acp_core::schema::InitializeResponse;
use weave_acp_core::schema::SessionId;

use crate::instance::LaunchKey;
pub use crate::instance::Launcher;
pub use crate::instance::process_launcher;
pub use crate::journal::Recorded;
use crate::journal::now_ms;
pub use crate::paths::DaemonPaths;
use crate::session::Command;
use crate::session::SessionHandle;
use crate::session::lock;

/// How long a session nothing needs stays open: no client attached, no turn running.
pub const DEFAULT_IDLE_GRACE: Duration = Duration::from_secs(30 * 60);
/// Journals untouched for this long are removed when a daemon starts.
const JOURNAL_RETENTION: Duration = Duration::from_secs(14 * 24 * 60 * 60);
/// How long stopping waits for each session's agent.
const SUSPEND_TIMEOUT: Duration = Duration::from_secs(10);

pub struct DaemonConfig {
    /// Where session journals are written; `None` keeps them in memory only.
    pub journals: Option<PathBuf>,
    /// How long a session nothing needs stays open.
    pub idle_grace: Duration,
    pub launcher: Launcher,
}

impl DaemonConfig {
    /// A daemon inside one client: journals in memory, agents as processes.
    pub fn in_memory() -> Self {
        Self {
            journals: None,
            idle_grace: DEFAULT_IDLE_GRACE,
            launcher: process_launcher(),
        }
    }

    /// The per-user daemon, with journals in its directory.
    pub fn persistent(paths: &DaemonPaths) -> Self {
        Self {
            journals: Some(paths.journals()),
            ..Self::in_memory()
        }
    }
}

pub(crate) struct Shared {
    pub(crate) config: DaemonConfig,
    registry: Mutex<Registry>,
    started_ms: u64,
    pub(crate) next_client: AtomicU64,
    pub(crate) stop: watch::Sender<bool>,
}

impl Shared {
    pub(crate) fn registry(&self) -> MutexGuard<'_, Registry> {
        lock(&self.registry)
    }
}

#[derive(Default)]
pub(crate) struct Registry {
    /// Live sessions, by id.
    pub(crate) sessions: HashMap<SessionId, SessionHandle>,
    /// Subagent sessions, and the live session they belong to.
    pub(crate) children: HashMap<SessionId, SessionId>,
    /// Each agent's `initialize` answer, so clients attaching to it don't start another.
    pub(crate) initialized: HashMap<LaunchKey, InitializeResponse>,
    /// Every session the journals record, live or not: which agent, where, under which
    /// policy, and whether it was closed or left open by a daemon that stopped.
    pub(crate) known: HashMap<SessionId, Recorded>,
    /// Clients connected now.
    pub(crate) clients: usize,
}

impl Registry {
    /// The live session `session_id` is, or belongs to as a subagent.
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
                journal::prune(journals, JOURNAL_RETENTION);
                journal::index(journals)
            }
            None => HashMap::new(),
        };
        let (stop, _) = watch::channel(false);
        Self {
            shared: Arc::new(Shared {
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
        transport: impl ConnectTo<Agent> + 'static,
    ) -> Result<(), Error> {
        client::serve(Arc::clone(&self.shared), transport).await
    }

    /// A connection to this daemon from the same process.
    pub fn connect_in_process(&self) -> Channel {
        let (client, daemon) = Channel::duplex();
        let this = self.clone();
        tokio::spawn(async move {
            if let Err(error) = this.serve_client(daemon).await {
                tracing::debug!(%error, "in-process client ended");
            }
        });
        client
    }

    /// Accept clients on `listener` until asked to stop, or until nothing has been open or
    /// connected for `idle_exit`. Then stop every session, leaving them recoverable.
    pub async fn serve(&self, listener: UnixListener, idle_exit: Option<Duration>) {
        let mut stop = self.shared.stop.subscribe();
        let mut checks = tokio::time::interval(Duration::from_secs(1));
        let mut idle_since: Option<Instant> = None;
        loop {
            tokio::select! {
                accepted = listener.accept() => match accepted {
                    Ok((stream, _)) => {
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

    /// Ask [`Self::serve`] to stop.
    pub fn stop(&self) {
        let _ = self.shared.stop.send(true);
    }

    /// Stop every session's agent. Their journals stay open, so a later daemon can take
    /// them up again.
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
    }

    /// What the daemon has open.
    pub fn status(&self) -> DaemonStatus {
        client::status(&self.shared)
    }

    /// Open a session (`request.session_id`, or a new one), send it the prompt and leave the
    /// turn running under the request's policy, with no client attached: what `_weave/run`
    /// does, and what a trigger calls directly.
    pub async fn run(&self, request: RunRequest) -> Result<SessionId, Error> {
        client::run(&self.shared, request, None).await
    }
}

/// What the per-user daemon's journal in `paths` records about `session_id`: the agent and
/// directory to reopen it with. Read from disk, so the daemon needn't be running.
pub fn recorded_session(paths: &DaemonPaths, session_id: &SessionId) -> Option<Recorded> {
    journal::recorded(&paths.journals(), session_id)
}

/// The extension version and the daemon's own, for `initialize` and `_weave/status`.
pub(crate) fn hello() -> weave_acp_core::daemon_protocol::DaemonHello {
    weave_acp_core::daemon_protocol::DaemonHello {
        protocol: PROTOCOL_VERSION,
        version: env!("CARGO_PKG_VERSION").to_owned(),
        pid: std::process::id(),
    }
}
