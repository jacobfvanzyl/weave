//! Reaching the weave Host, which runs agents so sessions outlive the TUI: the per-user one
//! over its socket, started on first use, or one inside this process (`--no-daemon`). And
//! `weave daemon`, which manages the per-user one.

use std::collections::BTreeMap;
use std::fs::OpenOptions;
use std::io;
use std::path::Path;
use std::path::PathBuf;
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
use weave_acp_core::AgentSpec;
use weave_agents::environment::CAPTURE_TIMEOUT;
use weave_agents::environment::Environment;
use weave_daemon::DaemonConfig;
use weave_daemon::DaemonPaths;
use weave_daemon::RemoteConfig;
use weave_daemon::Withheld;
use weave_daemon::socket;
use weave_host_client::ConnectError;
use weave_host_client::HostConnection;
use weave_host_client::HostEvent;
use weave_host_protocol::hello::ClientCapabilities;
use weave_host_protocol::hello::ClientInfo;
use weave_host_protocol::host::HostStatus;
use weave_host_protocol::host::Service;
use weave_host_protocol::host::ShutdownRequest;
use weave_host_protocol::host::StatusRequest;
use weave_host_protocol::sessions::Activity;
use weave_host_protocol::tools::CLIPBOARD_WRITE;
use weave_tui::Reconnection;
use weave_tui::Reconnector;

use crate::args::AgentChoice;
use crate::args::COMMAND_AGENT;
use crate::args::HostLaunch;
use crate::args::WorkspaceArgs;
use crate::service;

/// A background Host exits once nothing has been open or connected for this long.
const BACKGROUND_IDLE_EXIT: Duration = Duration::from_secs(10 * 60);
/// How long to wait for a Host to start listening, or to stop.
const STARTUP_WAIT: Duration = Duration::from_secs(10);
/// A log bigger than this is set aside (as `daemon.log.old`) when a Host starts.
const LOG_LIMIT: u64 = 10 * 1024 * 1024;

/// Where this invocation's agents run, before it knows which agent.
pub enum Target {
    /// The per-user Host, started on first use.
    Shared(DaemonPaths),
    /// A Host inside this process, which ends with it.
    InProcess,
}

/// The Host this invocation talks to.
pub enum Host {
    Shared(DaemonPaths),
    InProcess(weave_daemon::Daemon),
}

impl Target {
    pub fn choose(no_daemon: bool) -> anyhow::Result<Self> {
        if no_daemon {
            return Ok(Self::InProcess);
        }
        Ok(Self::Shared(paths()?))
    }

    /// The Host for `launch`. One in this process is given a custom command as an agent of
    /// its own, and withholds what the workspace asks it to; the shared one can't be.
    pub fn host(
        &self,
        launch: &HostLaunch,
        workspace: &WorkspaceArgs,
        config_file: Option<PathBuf>,
    ) -> anyhow::Result<Host> {
        let withheld = workspace.withheld();
        match self {
            Self::Shared(paths) => {
                if let AgentChoice::Command(_) = &launch.agent {
                    bail!(
                        "the weave Host runs agents its config defines: add this one under \
                         [agents.<id>] with its command, and use --agent <id>; or use \
                         --no-daemon"
                    );
                }
                if withheld != Withheld::default() {
                    bail!(
                        "--no-fs and --no-terminal apply with --no-daemon; for the weave Host, \
                         set fs = false or terminal = false under the agent in the config"
                    );
                }
                Ok(Host::Shared(paths.clone()))
            }
            Self::InProcess => {
                let mut config = DaemonConfig::in_process(config_file);
                config.withheld = withheld;
                if let AgentChoice::Command(words) = &launch.agent
                    && let Some((command, args)) = words.split_first()
                {
                    config.agents =
                        BTreeMap::from([(COMMAND_AGENT.to_owned(), AgentSpec::new(command, args))]);
                }
                Ok(Host::InProcess(weave_daemon::Daemon::new(config)))
            }
        }
    }
}

impl Host {
    /// Connect and say hello as `client`.
    pub async fn connect(
        &self,
        client: &str,
    ) -> anyhow::Result<(HostConnection, UnboundedReceiver<HostEvent>)> {
        let connected = match self {
            Self::Shared(paths) => {
                HostConnection::connect(
                    open(paths).await?,
                    client_info(client),
                    capabilities(client),
                )
                .await
            }
            Self::InProcess(daemon) => {
                HostConnection::connect(
                    daemon.connect_in_process(),
                    client_info(client),
                    capabilities(client),
                )
                .await
            }
        };
        connected.map_err(anyhow::Error::from)
    }

    /// Whether sessions outlive this process.
    pub fn is_shared(&self) -> bool {
        matches!(self, Self::Shared(_))
    }

    /// How the TUI reaches the per-user Host again after it goes away, without starting one:
    /// a restarted Host is picked up, a stopped one stays stopped. None in-process.
    pub fn reconnector(&self) -> Option<Reconnector> {
        let Self::Shared(paths) = self else {
            return None;
        };
        let paths = paths.clone();
        Some(Arc::new(move || {
            let paths = paths.clone();
            Box::pin(async move { reconnect(&paths).await })
        }))
    }

    /// Stop an in-process Host's agents; the shared one keeps running.
    pub async fn finish(&self) {
        if let Self::InProcess(daemon) = self {
            daemon.shutdown().await;
        }
    }
}

pub(crate) fn client_info(name: &str) -> ClientInfo {
    ClientInfo {
        name: name.to_owned(),
        version: env!("CARGO_PKG_VERSION").to_owned(),
    }
}

/// This client runs on the Host's computer, so it can run sign-in commands in its terminal.
/// The TUI also runs client tools: it puts text on its terminal's clipboard.
pub(crate) fn capabilities(client: &str) -> ClientCapabilities {
    ClientCapabilities {
        terminal_sign_in: true,
        client_tools: if client == TUI {
            vec![CLIPBOARD_WRITE.to_owned()]
        } else {
            Vec::new()
        },
    }
}

/// The TUI's client name.
pub(crate) const TUI: &str = "weave-tui";

/// One attempt to reach a running Host again.
async fn reconnect(paths: &DaemonPaths) -> Reconnection {
    let Ok(transport) = socket::connect(&paths.socket).await else {
        return Reconnection::NotYet;
    };
    match HostConnection::connect(transport, client_info(TUI), capabilities(TUI)).await {
        Ok((connection, events)) => Reconnection::Connected(Box::new(connection), events),
        Err(ConnectError::Incompatible(why)) => Reconnection::Incompatible(why),
        // Still starting up, say.
        Err(_) => Reconnection::NotYet,
    }
}

pub(crate) fn paths() -> anyhow::Result<DaemonPaths> {
    DaemonPaths::from_env().context("no home directory for the weave Host; set WEAVE_DAEMON_DIR")
}

/// A connection to the per-user Host, starting it if it isn't running.
pub(crate) async fn open(paths: &DaemonPaths) -> anyhow::Result<socket::Transport> {
    match socket::connect(&paths.socket).await {
        Ok(transport) => return Ok(transport),
        Err(error) if not_running(&error) => {}
        Err(error) => {
            return Err(error).with_context(|| format!("connecting to {}", paths.socket.display()));
        }
    }
    if service::installed(paths) {
        bail!(
            "the weave Host's service is installed but not running; start it with `weave \
             daemon start`"
        );
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

/// Start `weave daemon run` detached from this terminal, logging to the Host's log.
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
    let mut child = command.spawn().context("starting the weave Host")?;
    // Reap it if it exits while this process still runs.
    std::thread::spawn(move || child.wait());
    Ok(())
}

pub(crate) async fn wait_until_listening(paths: &DaemonPaths) -> anyhow::Result<socket::Transport> {
    let deadline = Instant::now() + STARTUP_WAIT;
    loop {
        tokio::time::sleep(Duration::from_millis(50)).await;
        match socket::connect(&paths.socket).await {
            Ok(transport) => return Ok(transport),
            Err(error) if not_running(&error) && Instant::now() < deadline => {}
            Err(error) => {
                return Err(error).with_context(|| {
                    format!("the weave Host didn't start; see {}", paths.log().display())
                });
            }
        }
    }
}

/// Wait for the Host to stop listening.
pub(crate) async fn wait_until_stopped(paths: &DaemonPaths) -> anyhow::Result<()> {
    let deadline = Instant::now() + STARTUP_WAIT;
    while socket::connect(&paths.socket).await.is_ok() {
        if Instant::now() >= deadline {
            bail!("the weave Host didn't stop");
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    Ok(())
}

/// A connection for managing the Host, if it's running.
pub(crate) async fn control(paths: &DaemonPaths) -> anyhow::Result<Option<HostConnection>> {
    let transport = match socket::connect(&paths.socket).await {
        Ok(transport) => transport,
        Err(error) if not_running(&error) => return Ok(None),
        Err(error) => {
            return Err(error).with_context(|| format!("connecting to {}", paths.socket.display()));
        }
    };
    let (connection, _events) = HostConnection::connect(
        transport,
        client_info("weave-cli"),
        capabilities("weave-cli"),
    )
    .await?;
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
    /// Start the Host in the background, if it isn't running.
    Start,
    /// Stop the Host and its agents. Sessions it had open can be reopened later.
    Stop,
    /// Stop the Host if it's running, then start it again: after rebuilding weave.
    Restart,
    /// What the Host is running.
    Status,
    /// Run the Host as a launchd user agent: at login, kept running, with no idle exit.
    Install,
    /// Remove the launchd user agent `install` wrote, stopping the Host.
    Uninstall,
}

#[derive(Args)]
struct RunArgs {
    /// Exit after this many seconds with no sessions open and no clients connected.
    #[arg(long, value_name = "SECONDS")]
    idle_exit: Option<u64>,

    /// The config file agents and MCP servers come from. Defaults to
    /// ~/.config/weave/config.toml.
    #[arg(long)]
    config: Option<PathBuf>,

    /// Run as launchd's service, as `weave daemon install` sets it up.
    #[arg(long, hide = true)]
    launchd: bool,
}

pub async fn command(args: DaemonArgs) -> anyhow::Result<()> {
    let paths = paths()?;
    match args.command {
        DaemonCommand::Run(run) => serve(&paths, run).await,
        DaemonCommand::Start => start(&paths).await,
        DaemonCommand::Stop => {
            if !stop(&paths).await? {
                eprintln!("The weave Host isn't running.");
            }
            Ok(())
        }
        DaemonCommand::Restart => {
            stop(&paths).await?;
            start(&paths).await
        }
        DaemonCommand::Status => status(&paths).await,
        DaemonCommand::Install => service::install(&paths).await,
        DaemonCommand::Uninstall => service::uninstall(&paths).await,
    }
}

async fn serve(paths: &DaemonPaths, run: RunArgs) -> anyhow::Result<()> {
    let listening = socket::listen(paths)
        .with_context(|| format!("listening on {}", paths.socket.display()))?;
    let environment = Environment::capture(CAPTURE_TIMEOUT).await;
    let service = if run.launchd {
        Service::Launchd
    } else {
        Service::OnDemand
    };
    let remote = remote_listener(run.config.as_deref()).await;
    let mut config = DaemonConfig::persistent(paths, service, environment);
    config.config_file = run.config;
    let daemon = weave_daemon::Daemon::new(config);
    let stopper = daemon.clone();
    tokio::spawn(async move {
        stop_signal().await;
        stopper.stop();
    });
    tracing::info!(
        socket = %paths.socket.display(),
        pid = std::process::id(),
        version = env!("CARGO_PKG_VERSION"),
        "weave Host serving"
    );
    // launchd keeps it running; one started on demand goes when it's no longer used, unless
    // it serves remote clients, which can't start it again.
    let idle_exit = if run.launchd || remote.is_some() {
        None
    } else {
        run.idle_exit.map(Duration::from_secs)
    };
    let serving_remote = remote.map(|(listener, config)| {
        let daemon = daemon.clone();
        tokio::spawn(async move { daemon.serve_remote(listener, config).await })
    });
    daemon.serve(listening.listener, idle_exit).await;
    if let Some(serving) = serving_remote {
        serving.abort();
    }
    let _ = std::fs::remove_file(&paths.socket);
    tracing::info!("weave Host stopped");
    Ok(())
}

/// The WebSocket for remote clients, when the config has a `[remote]`. A `[remote]` that
/// can't be used is logged, and the Host serves local clients only.
async fn remote_listener(config: Option<&Path>) -> Option<(tokio::net::TcpListener, RemoteConfig)> {
    let settings = match crate::config::Config::load(config) {
        Ok(config) => config.remote?,
        Err(error) => {
            tracing::error!(error = %format!("{error:#}"), "no remote clients: the config can't be read");
            return None;
        }
    };
    let address = match settings.listen() {
        Ok(address) => address,
        Err(error) => {
            tracing::error!(error = %format!("{error:#}"), "no remote clients");
            return None;
        }
    };
    match tokio::net::TcpListener::bind(address).await {
        Ok(listener) => {
            tracing::info!(%address, "serving remote clients");
            Some((
                listener,
                RemoteConfig {
                    origins: settings.origins,
                    ..RemoteConfig::default()
                },
            ))
        }
        Err(error) => {
            tracing::error!(%error, %address, "no remote clients: can't listen");
            None
        }
    }
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
        let status = connection.send(StatusRequest {}).await?;
        connection.shutdown().await;
        eprintln!("The weave Host is already running (pid {}).", status.pid);
        return Ok(());
    }
    if service::installed(paths) {
        service::start(paths)?;
    } else {
        start_in_background(paths)?;
    }
    drop(wait_until_listening(paths).await?);
    eprintln!(
        "Started the weave Host on {}; it logs to {}.",
        paths.socket.display(),
        paths.log().display()
    );
    Ok(())
}

/// Stop the Host and wait for it to go. Returns whether it was running.
pub(crate) async fn stop(paths: &DaemonPaths) -> anyhow::Result<bool> {
    if service::installed(paths) {
        let running = socket::connect(&paths.socket).await.is_ok();
        service::stop(paths)?;
        wait_until_stopped(paths).await?;
        if running {
            eprintln!("Stopped the weave Host.");
        }
        return Ok(running);
    }
    match control(paths).await {
        Ok(Some(connection)) => {
            connection.send(ShutdownRequest {}).await?;
            connection.shutdown().await;
        }
        Ok(None) => return Ok(false),
        // A Host of another version, as after rebuilding weave, can't be asked to stop; it
        // stops on SIGTERM all the same.
        Err(error) if matches!(error.downcast_ref(), Some(ConnectError::Incompatible(_))) => {
            socket::terminate_listener(&paths.socket)
                .await
                .with_context(|| {
                    format!("stopping the weave Host on {}", paths.socket.display())
                })?;
        }
        Err(error) => return Err(error),
    }
    wait_until_stopped(paths).await?;
    eprintln!("Stopped the weave Host.");
    Ok(true)
}

async fn status(paths: &DaemonPaths) -> anyhow::Result<()> {
    let installed = service::installed(paths);
    let Some(connection) = control(paths).await? else {
        let service = if installed {
            "; its launchd service is installed"
        } else {
            ""
        };
        println!(
            "The weave Host isn't running ({}){service}.",
            paths.socket.display()
        );
        return Ok(());
    };
    let status = connection.send(StatusRequest {}).await;
    connection.shutdown().await;
    print!("{}", describe(&status?, paths, now_ms()));
    Ok(())
}

fn describe(status: &HostStatus, paths: &DaemonPaths, now_ms: u64) -> String {
    let running = status
        .sessions
        .iter()
        .filter(|session| {
            session
                .activity
                .is_some_and(|activity| activity != Activity::Idle)
        })
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
    let service = match status.service {
        Service::Launchd => "launchd",
        Service::OnDemand => "on demand",
        Service::InProcess => "in-process",
    };
    let environment = match status.environment {
        weave_host_protocol::host::EnvironmentSource::LoginShell => "your login shell's",
        weave_host_protocol::host::EnvironmentSource::Process => {
            "its own (the login shell's couldn't be read)"
        }
    };
    let remote = status
        .remote
        .as_ref()
        .map(|address| format!("  remote   {address}, for paired devices (`weave devices`)\n"))
        .unwrap_or_default();
    format!(
        "weave Host {} (pid {}), up {}, run {service}\n  socket   {}\n  journals {}\n{remote}  agents get {environment} environment\n\n{sessions}\n",
        status.version,
        status.pid,
        ago(now_ms, status.started_at),
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
    use weave_acp_core::schema::SessionInfo;
    use weave_host_protocol::PROTOCOL_VERSION;
    use weave_host_protocol::host::EnvironmentSource;
    use weave_host_protocol::sessions::SessionListing;
    use weave_host_protocol::sessions::SessionStatus;

    use super::*;

    #[test]
    fn status_says_what_the_host_has_open() {
        let paths = DaemonPaths::in_dir("/state/weave/daemon".into());
        let mut status = HostStatus {
            protocol: PROTOCOL_VERSION,
            version: "0.1.0".into(),
            pid: 42,
            started_at: 0,
            service: Service::OnDemand,
            environment: EnvironmentSource::LoginShell,
            sessions: Vec::new(),
            remote: None,
        };
        assert!(describe(&status, &paths, 90_000).ends_with("No sessions open.\n"));
        status.sessions.push(SessionListing {
            info: SessionInfo::new("s1", "/repo").title("Fix the build".to_owned()),
            agent_id: "claude".into(),
            state: SessionStatus::Open,
            activity: Some(Activity::Waiting),
            clients: 0,
            headless: false,
            last_activity_at: Some(30_000),
        });
        assert_eq!(
            describe(&status, &paths, 7_230_000),
            "weave Host 0.1.0 (pid 42), up 2h, run on demand\n  socket   \
             /state/weave/daemon/daemon.sock\n  journals /state/weave/daemon/sessions\n  agents \
             get your login shell's environment\n\n1 session open, at work; `weave sessions` \
             lists it.\n"
        );
        status.remote = Some("127.0.0.1:7341".to_owned());
        assert!(
            describe(&status, &paths, 7_230_000)
                .contains("\n  remote   127.0.0.1:7341, for paired devices (`weave devices`)\n")
        );
    }
}
