//! Reaching the weave daemon, which runs agents so sessions outlive the TUI: the per-user one
//! over its socket, started on first use, or one inside this process (`--no-daemon`). And
//! `weave daemon`, which manages the per-user one.

use std::collections::BTreeMap;
use std::fs::OpenOptions;
use std::io;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use anyhow::Context;
use anyhow::bail;
use clap::Args;
use clap::Subcommand;
use tokio::sync::mpsc::UnboundedReceiver;
use weave_acp_core::AgentConnection;
use weave_acp_core::AgentEvent;
use weave_acp_core::ClientOptions;
use weave_acp_core::daemon_protocol;
use weave_acp_core::daemon_protocol::Activity;
use weave_acp_core::daemon_protocol::ClientHello;
use weave_acp_core::daemon_protocol::DaemonHello;
use weave_acp_core::daemon_protocol::DaemonStatus;
use weave_acp_core::daemon_protocol::Launch;
use weave_acp_core::daemon_protocol::PROTOCOL_VERSION;
use weave_acp_core::daemon_protocol::ShutdownRequest;
use weave_acp_core::daemon_protocol::StatusRequest;
use weave_daemon::DaemonConfig;
use weave_daemon::DaemonPaths;
use weave_daemon::socket;
use weave_tui::Reconnection;
use weave_tui::Reconnector;

/// A background daemon exits once nothing has been open or connected for this long.
const BACKGROUND_IDLE_EXIT: Duration = Duration::from_secs(10 * 60);
/// How long to wait for a daemon to start listening, or to stop.
const STARTUP_WAIT: Duration = Duration::from_secs(10);
/// A log bigger than this is set aside (as `daemon.log.old`) when a daemon starts.
const LOG_LIMIT: u64 = 10 * 1024 * 1024;

/// Where this invocation's agents run.
#[derive(Clone)]
pub enum Target {
    /// The per-user daemon, started on first use.
    Shared(DaemonPaths),
    /// A daemon inside this process, which ends with it.
    InProcess(weave_daemon::Daemon),
}

impl Target {
    pub fn choose(no_daemon: bool) -> anyhow::Result<Self> {
        if no_daemon {
            return Ok(Self::InProcess(weave_daemon::Daemon::new(
                DaemonConfig::in_memory(),
            )));
        }
        Ok(Self::Shared(paths()?))
    }

    /// Connect and initialize, asking the daemon for `launch`'s agent.
    pub async fn connect(
        &self,
        launch: Launch,
        options: ClientOptions,
    ) -> anyhow::Result<(AgentConnection, UnboundedReceiver<AgentEvent>)> {
        let (connection, events) = match self {
            Self::Shared(paths) => AgentConnection::connect(open(paths).await?, options).await?,
            Self::InProcess(daemon) => {
                AgentConnection::connect(daemon.connect_in_process(), options).await?
            }
        };
        let hello = ClientHello {
            protocol: PROTOCOL_VERSION,
            launch: Some(launch),
        };
        let initialized = connection
            .initialize_with(Some(daemon_protocol::meta(&hello)))
            .await;
        let checked = match initialized {
            Ok(init) => check_version(daemon_protocol::read_meta(init.meta.as_ref())),
            Err(error) => Err(error.into()),
        };
        if let Err(error) = checked {
            connection.shutdown().await;
            return Err(error);
        }
        Ok((connection, events))
    }

    /// How the TUI reaches the per-user daemon again after it goes away, without starting
    /// one: a restarted daemon is picked up, a stopped one stays stopped. None in-process.
    pub fn reconnector(&self, launch: Launch, options: ClientOptions) -> Option<Reconnector> {
        let Self::Shared(paths) = self else {
            return None;
        };
        let paths = paths.clone();
        Some(Arc::new(move || {
            let (paths, launch) = (paths.clone(), launch.clone());
            Box::pin(async move { reconnect(&paths, launch, options).await })
        }))
    }

    /// Stop an in-process daemon's agents; the shared daemon keeps running.
    pub async fn finish(&self) {
        if let Self::InProcess(daemon) = self {
            daemon.shutdown().await;
        }
    }
}

/// `launch` as the daemon gets it, with this process's environment for the agent to inherit.
pub fn daemon_launch(launch: &crate::args::Launch) -> Launch {
    let environment: BTreeMap<String, String> = std::env::vars_os()
        .filter_map(|(name, value)| Some((name.into_string().ok()?, value.into_string().ok()?)))
        .collect();
    Launch {
        spec: launch.spec.clone(),
        choice: Some(launch.agent.clone()),
        cwd: launch.cwd.clone(),
        environment,
        trace: launch.trace.clone(),
    }
}

/// One attempt to reach a running daemon again.
async fn reconnect(paths: &DaemonPaths, launch: Launch, options: ClientOptions) -> Reconnection {
    let Ok(transport) = socket::connect(&paths.socket).await else {
        return Reconnection::NotYet;
    };
    let Ok((connection, events)) = AgentConnection::connect(transport, options).await else {
        return Reconnection::NotYet;
    };
    let hello = ClientHello {
        protocol: PROTOCOL_VERSION,
        launch: Some(launch),
    };
    match connection
        .initialize_with(Some(daemon_protocol::meta(&hello)))
        .await
    {
        Ok(init) => match check_version(daemon_protocol::read_meta(init.meta.as_ref())) {
            Ok(()) => Reconnection::Connected(connection, events),
            Err(error) => {
                connection.shutdown().await;
                Reconnection::Incompatible(error.to_string())
            }
        },
        // Still starting up, say.
        Err(_) => {
            connection.shutdown().await;
            Reconnection::NotYet
        }
    }
}

fn check_version(hello: Option<DaemonHello>) -> anyhow::Result<()> {
    match hello {
        Some(hello) if hello.protocol == PROTOCOL_VERSION => Ok(()),
        Some(hello) => bail!(
            "the running weave daemon (version {}, pid {}) speaks a different protocol than this \
             weave; restart it with `weave daemon restart`",
            hello.version,
            hello.pid
        ),
        None => bail!("the weave daemon's socket answered, but not as a weave daemon"),
    }
}

pub(crate) fn paths() -> anyhow::Result<DaemonPaths> {
    DaemonPaths::from_env().context("no home directory for the weave daemon; set WEAVE_DAEMON_DIR")
}

/// A connection to the per-user daemon, starting it if it isn't running.
async fn open(paths: &DaemonPaths) -> anyhow::Result<socket::Transport> {
    match socket::connect(&paths.socket).await {
        Ok(transport) => return Ok(transport),
        Err(error) if not_running(&error) => {}
        Err(error) => {
            return Err(error).with_context(|| format!("connecting to {}", paths.socket.display()));
        }
    }
    start_in_background(paths)?;
    wait_until_listening(paths).await
}

fn not_running(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused
    )
}

/// Start `weave daemon run` detached from this terminal, logging to the daemon's log.
fn start_in_background(paths: &DaemonPaths) -> anyhow::Result<()> {
    paths
        .prepare()
        .with_context(|| format!("creating {}", paths.dir.display()))?;
    let log_path = paths.log();
    if std::fs::metadata(&log_path).is_ok_and(|metadata| metadata.len() > LOG_LIMIT) {
        let _ = std::fs::rename(&log_path, log_path.with_extension("log.old"));
    }
    let mut log_options = OpenOptions::new();
    log_options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        log_options.mode(0o600);
    }
    let log = log_options
        .open(&log_path)
        .with_context(|| format!("opening {}", log_path.display()))?;
    let executable = std::env::current_exe().context("finding the weave executable")?;
    let mut command = std::process::Command::new(executable);
    command
        .args(["daemon", "run", "--idle-exit"])
        .arg(BACKGROUND_IDLE_EXIT.as_secs().to_string())
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log);
    // Its own process group, so the terminal's signals (Ctrl+C, a closing window) miss it.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn().context("starting the weave daemon")?;
    // Reap it if it exits while this process still runs.
    std::thread::spawn(move || child.wait());
    Ok(())
}

async fn wait_until_listening(paths: &DaemonPaths) -> anyhow::Result<socket::Transport> {
    let deadline = Instant::now() + STARTUP_WAIT;
    loop {
        tokio::time::sleep(Duration::from_millis(50)).await;
        match socket::connect(&paths.socket).await {
            Ok(transport) => return Ok(transport),
            Err(error) if not_running(&error) && Instant::now() < deadline => {}
            Err(error) => {
                return Err(error).with_context(|| {
                    format!(
                        "the weave daemon didn't start; see {}",
                        paths.log().display()
                    )
                });
            }
        }
    }
}

/// A connection for managing the daemon, if it's running.
pub(crate) async fn control(paths: &DaemonPaths) -> anyhow::Result<Option<AgentConnection>> {
    let transport = match socket::connect(&paths.socket).await {
        Ok(transport) => transport,
        Err(error) if not_running(&error) => return Ok(None),
        Err(error) => {
            return Err(error).with_context(|| format!("connecting to {}", paths.socket.display()));
        }
    };
    let (connection, _events) =
        AgentConnection::connect(transport, ClientOptions::default()).await?;
    let hello = ClientHello {
        protocol: PROTOCOL_VERSION,
        launch: None,
    };
    let init = connection
        .initialize_with(Some(daemon_protocol::meta(&hello)))
        .await?;
    if let Err(error) = check_version(daemon_protocol::read_meta(init.meta.as_ref())) {
        connection.shutdown().await;
        return Err(error);
    }
    Ok(Some(connection))
}

#[derive(Args)]
pub struct DaemonArgs {
    #[command(subcommand)]
    command: DaemonCommand,
}

#[derive(Subcommand)]
enum DaemonCommand {
    /// Serve in the foreground until stopped (for launchd, or to watch its log).
    Run(RunArgs),
    /// Start the daemon in the background, if it isn't running.
    Start,
    /// Stop the daemon and its agents. Sessions it had open can be reopened later.
    Stop,
    /// Stop the daemon if it's running, then start it again: after rebuilding weave.
    Restart,
    /// What the daemon is running.
    Status,
}

#[derive(Args)]
struct RunArgs {
    /// Exit after this many seconds with no sessions open and no clients connected.
    #[arg(long, value_name = "SECONDS")]
    idle_exit: Option<u64>,
}

pub async fn command(args: DaemonArgs) -> anyhow::Result<()> {
    let paths = paths()?;
    match args.command {
        DaemonCommand::Run(run) => serve(&paths, run.idle_exit.map(Duration::from_secs)).await,
        DaemonCommand::Start => start(&paths).await,
        DaemonCommand::Stop => {
            if !stop(&paths).await? {
                eprintln!("The weave daemon isn't running.");
            }
            Ok(())
        }
        DaemonCommand::Restart => {
            stop(&paths).await?;
            start(&paths).await
        }
        DaemonCommand::Status => status(&paths).await,
    }
}

async fn serve(paths: &DaemonPaths, idle_exit: Option<Duration>) -> anyhow::Result<()> {
    let listening = socket::listen(paths)
        .with_context(|| format!("listening on {}", paths.socket.display()))?;
    let daemon = weave_daemon::Daemon::new(DaemonConfig::persistent(paths));
    let stopper = daemon.clone();
    tokio::spawn(async move {
        stop_signal().await;
        stopper.stop();
    });
    tracing::info!(
        socket = %paths.socket.display(),
        pid = std::process::id(),
        version = env!("CARGO_PKG_VERSION"),
        "weave daemon serving"
    );
    daemon.serve(listening.listener, idle_exit).await;
    let _ = std::fs::remove_file(&paths.socket);
    tracing::info!("weave daemon stopped");
    Ok(())
}

/// SIGTERM or SIGINT. A closing terminal's SIGHUP is ignored.
async fn stop_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::SignalKind;
        use tokio::signal::unix::signal;
        let (Ok(mut terminate), Ok(mut interrupt), Ok(_hangup)) = (
            signal(SignalKind::terminate()),
            signal(SignalKind::interrupt()),
            signal(SignalKind::hangup()),
        ) else {
            return std::future::pending().await;
        };
        tokio::select! {
            _ = terminate.recv() => {}
            _ = interrupt.recv() => {}
        }
    }
    #[cfg(not(unix))]
    let _ = tokio::signal::ctrl_c().await;
}

async fn start(paths: &DaemonPaths) -> anyhow::Result<()> {
    if let Some(connection) = control(paths).await? {
        let status = connection.extension(StatusRequest {}).await?;
        connection.shutdown().await;
        eprintln!("The weave daemon is already running (pid {}).", status.pid);
        return Ok(());
    }
    start_in_background(paths)?;
    drop(wait_until_listening(paths).await?);
    eprintln!(
        "Started the weave daemon on {}; it logs to {}.",
        paths.socket.display(),
        paths.log().display()
    );
    Ok(())
}

/// Stop the daemon and wait for it to go. Returns whether it was running.
async fn stop(paths: &DaemonPaths) -> anyhow::Result<bool> {
    let Some(connection) = control(paths).await? else {
        return Ok(false);
    };
    connection.extension(ShutdownRequest {}).await?;
    connection.shutdown().await;
    let deadline = Instant::now() + STARTUP_WAIT;
    while socket::connect(&paths.socket).await.is_ok() {
        if Instant::now() >= deadline {
            bail!("the weave daemon didn't stop");
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    eprintln!("Stopped the weave daemon.");
    Ok(true)
}

async fn status(paths: &DaemonPaths) -> anyhow::Result<()> {
    let Some(connection) = control(paths).await? else {
        println!(
            "The weave daemon isn't running ({}).",
            paths.socket.display()
        );
        return Ok(());
    };
    let status = connection.extension(StatusRequest {}).await;
    connection.shutdown().await;
    print!("{}", describe(&status?, paths, now_ms()));
    Ok(())
}

fn describe(status: &DaemonStatus, paths: &DaemonPaths, now_ms: u64) -> String {
    let running = status
        .sessions
        .iter()
        .filter(|session| session.activity != Activity::Idle)
        .count();
    let sessions = match (status.sessions.len(), running) {
        (0, _) => "No sessions open.".to_owned(),
        (1, 0) => "1 session open; `weave sessions` lists it.".to_owned(),
        (1, _) => "1 session open, at work; `weave sessions` lists it.".to_owned(),
        (open, 0) => format!("{open} sessions open; `weave sessions` lists them."),
        (open, running) => {
            format!("{open} sessions open, {running} at work; `weave sessions` lists them.")
        }
    };
    format!(
        "weave daemon {} (pid {}), up {}\n  socket   {}\n  journals {}\n\n{sessions}\n",
        status.version,
        status.pid,
        ago(now_ms, status.started_at_ms),
        paths.socket.display(),
        paths.journals().display(),
    )
}

pub(crate) fn ago(now_ms: u64, then_ms: u64) -> String {
    let seconds = now_ms.saturating_sub(then_ms) / 1000;
    match seconds {
        0..60 => format!("{seconds}s"),
        60..3600 => format!("{}m", seconds / 60),
        3600..86400 => format!("{}h", seconds / 3600),
        _ => format!("{}d", seconds / 86400),
    }
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        })
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;
    use weave_acp_core::daemon_protocol::LiveSession;
    use weave_acp_core::daemon_protocol::PermissionPolicy;

    use super::*;

    #[test]
    fn status_says_what_the_daemon_has_open() {
        let paths = DaemonPaths::in_dir("/state/weave/daemon".into());
        let mut status = DaemonStatus {
            protocol: PROTOCOL_VERSION,
            version: "0.1.0".into(),
            pid: 42,
            started_at_ms: 0,
            sessions: Vec::new(),
        };
        assert!(describe(&status, &paths, 90_000).ends_with("No sessions open.\n"));
        status.sessions.push(LiveSession {
            session_id: "s1".into(),
            cwd: "/repo".into(),
            agent: "npx claude-agent-acp".into(),
            choice: None,
            title: Some("Fix the build".into()),
            activity: Activity::Waiting,
            clients: 0,
            policy: PermissionPolicy::ask(),
            started_at_ms: 0,
            last_activity_ms: 30_000,
        });
        assert_eq!(
            describe(&status, &paths, 7_230_000),
            "weave daemon 0.1.0 (pid 42), up 2h\n  socket   /state/weave/daemon/daemon.sock\n  \
             journals /state/weave/daemon/sessions\n\n1 session open, at work; `weave sessions` \
             lists it.\n"
        );
    }
}
