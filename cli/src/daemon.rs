//! Reaching the weave Host, which runs agents so sessions outlive the TUI: the per-user one
//! over its socket, started on first use, or one inside this process (`--no-daemon`). And
//! `weave daemon`, which manages the per-user one.

use std::collections::BTreeMap;
use std::fs::OpenOptions;
use std::io;
use std::path::Path;
use std::path::PathBuf;
use std::process::ExitCode;
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
use weave_host::DaemonConfig;
use weave_host::DaemonPaths;
use weave_host::Withheld;
use weave_host::socket;
use weave_host_client::ConnectError;
use weave_host_client::HostConnection;
use weave_host_client::HostEvent;
use weave_host_protocol::hello::ClientCapabilities;
use weave_host_protocol::hello::ClientInfo;
use weave_host_protocol::host::DRAIN_FEATURE;
use weave_host_protocol::host::DrainRequest;
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
use crate::exit;
use crate::exit::Status;
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
    InProcess(weave_host::Daemon),
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
                Ok(Host::InProcess(weave_host::Daemon::new(config)))
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
            return Err(exit::unreachable(error)
                .context(format!("connecting to {}", paths.socket.display())));
        }
    }
    if service::installed(paths) {
        return Err(exit::unreachable(anyhow::anyhow!(
            "the weave Host's service is installed but not running; start it with `weave \
             daemon start`"
        )));
    }
    start_in_background(paths).map_err(exit::unreachable)?;
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
    // A session of its own, without this terminal: the terminal's signals (Ctrl+C, a closing
    // window) miss it, and nothing it runs can take the terminal over, as an interactive shell's
    // job control did, leaving the shell that started it in the background (WVE-154).
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: between fork and exec, setsid only makes the child a session leader; it
        // allocates nothing and takes no lock.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
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
                return Err(exit::unreachable(error).context(format!(
                    "the weave Host didn't start; see {}",
                    paths.log().display()
                )));
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
            return Err(exit::unreachable(error)
                .context(format!("connecting to {}", paths.socket.display())));
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
    /// Serve in the foreground until stopped (for launchd or systemd, or to watch its log).
    Run(RunArgs),
    /// Start the Host in the background, if it isn't running.
    Start,
    /// Stop the Host and its agents once running turns end. Threads it had open can be
    /// reopened later.
    Stop(StopArgs),
    /// Stop the Host if it's running, once running turns end, then start it again: after
    /// rebuilding weave.
    Restart(StopArgs),
    /// What the Host is running.
    Status,
    /// Run the Host as a service (launchd's on macOS, systemd's on Linux): kept running,
    /// with no idle exit.
    Install,
    /// Remove the service `install` wrote, stopping the Host.
    Uninstall,
}

#[derive(Args)]
struct StopArgs {
    /// Don't wait for running turns: stop them now. Threads they're in can be reopened later.
    #[arg(long)]
    now: bool,
}

#[derive(Args)]
struct RunArgs {
    /// Exit after this many seconds with no threads open and no clients connected.
    #[arg(long, value_name = "SECONDS")]
    idle_exit: Option<u64>,

    /// The config file agents and MCP servers come from. Defaults to
    /// ~/.config/weave/config.toml.
    #[arg(long)]
    config: Option<PathBuf>,

    /// Run as launchd's service, as `weave daemon install` sets it up.
    #[arg(long, hide = true, conflicts_with = "systemd")]
    launchd: bool,

    /// Run as systemd's service, as `weave daemon install` sets it up.
    #[arg(long, hide = true)]
    systemd: bool,
}

pub async fn command(args: DaemonArgs) -> anyhow::Result<ExitCode> {
    let paths = paths()?;
    let done = match args.command {
        DaemonCommand::Run(run) => serve(&paths, run).await,
        DaemonCommand::Start => start(&paths).await,
        DaemonCommand::Stop(stop_args) => {
            if !stop(&paths, stop_args.now).await? {
                eprintln!("The weave Host isn't running.");
            }
            Ok(())
        }
        DaemonCommand::Restart(stop_args) => restart(&paths, stop_args.now).await,
        DaemonCommand::Status => return status(&paths).await.map(ExitCode::from),
        DaemonCommand::Install => service::install(&paths).await,
        DaemonCommand::Uninstall => service::uninstall(&paths).await,
    };
    done.map(|()| ExitCode::SUCCESS)
}

async fn serve(paths: &DaemonPaths, run: RunArgs) -> anyhow::Result<()> {
    let listening = socket::listen(paths)
        .with_context(|| format!("listening on {}", paths.socket.display()))?;
    let environment = Environment::capture(CAPTURE_TIMEOUT).await;
    let service = if run.launchd {
        Service::Launchd
    } else if run.systemd {
        Service::Systemd
    } else {
        Service::OnDemand
    };
    let mut config = DaemonConfig::persistent(paths, service, environment);
    config.remote = Some(remote_settings(run.config.as_deref()));
    config.config_file = run.config;
    let daemon = weave_host::Daemon::new(config);
    let stopper = daemon.clone();
    tokio::spawn(async move {
        stop_signal().await;
        // Running turns end first, unless a client drained already; a second signal stops
        // them now.
        tokio::select! {
            _ = stopper.drain() => {}
            () = stop_signal() => tracing::info!("stopping without waiting for running turns"),
        }
        stopper.stop();
    });
    tracing::info!(
        socket = %paths.socket.display(),
        pid = std::process::id(),
        version = env!("CARGO_PKG_VERSION"),
        "weave Host serving"
    );
    // A service keeps it running; one started on demand goes when it's no longer used, unless
    // paired devices need it, which can't start it again.
    let idle_exit = if run.launchd || run.systemd {
        None
    } else {
        run.idle_exit.map(Duration::from_secs)
    };
    let resuming = daemon.clone();
    tokio::spawn(async move { resuming.resume_remote().await });
    let queues = daemon.clone();
    tokio::spawn(async move { queues.resume_queues().await });
    daemon.serve(listening.listener, idle_exit).await;
    let _ = std::fs::remove_file(&paths.socket);
    tracing::info!("weave Host stopped");
    Ok(())
}

/// How the Host serves remote clients once pairing turns that on (ADR 0016): the defaults,
/// with the config's `[remote]` over them. A `[remote]` that can't be used is logged, and the
/// defaults stand.
fn remote_settings(config: Option<&Path>) -> weave_host::RemoteSettings {
    let mut settings =
        weave_host::RemoteSettings::new(Arc::new(weave_host::tailscale::TailscaleServe));
    let configured = match crate::config::Config::load(config) {
        Ok(config) => config.remote,
        Err(error) => {
            tracing::error!(error = %format!("{error:#}"), "the config can't be read; remote access uses its defaults");
            None
        }
    };
    let Some(configured) = configured else {
        return settings;
    };
    match configured.listen() {
        Ok(address) => settings.listen = address,
        Err(error) => tracing::error!(error = %format!("{error:#}"), "[remote] listen ignored"),
    }
    settings.url = configured.url;
    settings.websocket.origins = configured.origins;
    settings
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

/// Stop the Host if it's running, once its turns end unless `now`, and start it again. An
/// installed service's manager does both, so a restart asked for from inside the Host, as by
/// an agent, isn't cut off halfway.
async fn restart(paths: &DaemonPaths, now: bool) -> anyhow::Result<()> {
    if !service::installed(paths) {
        stop(paths, now).await?;
        return start(paths).await;
    }
    let draining = drain(paths, now).await?;
    service::restart(paths).await?;
    drop(draining);
    drop(wait_until_listening(paths).await?);
    eprintln!(
        "Restarted the weave Host on {}; it logs to {}.",
        paths.socket.display(),
        paths.log().display()
    );
    Ok(())
}

/// Have the Host start no new turns and, unless `now`, wait for its running ones to end,
/// saying so, before it's stopped. The connection returned holds the drain until the Host
/// stops; none when the Host isn't running or can't drain. A turn of the agent running this,
/// as when an agent restarts the Host, isn't waited for.
async fn drain(paths: &DaemonPaths, now: bool) -> anyhow::Result<Option<HostConnection>> {
    let connection = match control(paths).await {
        Ok(Some(connection)) => connection,
        Ok(None) => return Ok(None),
        // A Host of another version stops on SIGTERM, which drains it as this would.
        Err(error) if matches!(error.downcast_ref(), Some(ConnectError::Incompatible(_))) => {
            return Ok(None);
        }
        Err(error) => return Err(error),
    };
    if !connection
        .hello()
        .features
        .iter()
        .any(|f| f == DRAIN_FEATURE)
    {
        return Ok(Some(connection));
    }
    let except = std::env::var(weave_host::AGENT_PROCESS_VARIABLE)
        .ok()
        .filter(|process| !process.is_empty());
    let ready = connection
        .send(DrainRequest {
            wait: false,
            except: except.clone(),
        })
        .await?;
    let turns = |count: u32| match count {
        1 => "1 running turn".to_owned(),
        count => format!("{count} running turns"),
    };
    if ready.running == 0 {
        return Ok(Some(connection));
    }
    if now {
        eprintln!("Stopping {} with the Host.", turns(ready.running));
        return Ok(Some(connection));
    }
    eprintln!(
        "Waiting for {} to end, for up to {} minutes; Ctrl+C or --now stops them now.",
        turns(ready.running),
        weave_host::DEFAULT_DRAIN_TIMEOUT.as_secs() / 60
    );
    tokio::select! {
        drained = connection.send(DrainRequest { wait: true, except }) => {
            let left = drained?.running;
            if left > 0 {
                eprintln!("Stopping {} that didn't end in time.", turns(left));
            }
        }
        _ = tokio::signal::ctrl_c() => eprintln!("Stopping them now."),
    }
    Ok(Some(connection))
}

/// Stop the Host, once its running turns end unless `now`, and wait for it to go. Returns
/// whether it was running.
pub(crate) async fn stop(paths: &DaemonPaths, now: bool) -> anyhow::Result<bool> {
    let _draining = drain(paths, now).await?;
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

/// `weave daemon status`: [`Status::Unreachable`] when the Host isn't running, as `systemctl
/// status` exits 3 for a unit that isn't active.
async fn status(paths: &DaemonPaths) -> anyhow::Result<Status> {
    let installed = service::installed(paths);
    let notes = if installed {
        service::notes(paths)
    } else {
        Vec::new()
    };
    let Some(connection) = control(paths).await? else {
        let service = if installed {
            format!("; its {} service is installed", service::manager_name())
        } else {
            String::new()
        };
        println!(
            "The weave Host isn't running ({}){service}.",
            paths.socket.display()
        );
        print_notes(&notes);
        return Ok(Status::Unreachable);
    };
    let status = connection.send(StatusRequest {}).await;
    connection.shutdown().await;
    print!("{}", describe(&status?, paths, now_ms()));
    print_notes(&notes);
    Ok(Status::Success)
}

/// What the person may want to change about the service, each as a paragraph of its own.
fn print_notes(notes: &[String]) {
    for note in notes {
        println!("\n{note}");
    }
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
        (0, _) => "No threads open.".to_owned(),
        (1, 0) => "1 thread open; `weave threads` lists it.".to_owned(),
        (1, _) => "1 thread open, at work; `weave threads` lists it.".to_owned(),
        (open, 0) => format!("{open} threads open; `weave threads` lists them."),
        (open, running) => {
            format!("{open} threads open, {running} at work; `weave threads` lists them.")
        }
    };
    let service = match status.service {
        Service::Launchd => "launchd",
        Service::Systemd => "systemd",
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
        assert!(describe(&status, &paths, 90_000).ends_with("No threads open.\n"));
        status.sessions.push(SessionListing {
            info: SessionInfo::new("s1", "/repo").title("Fix the build".to_owned()),
            agent_id: "claude".into(),
            state: SessionStatus::Open,
            activity: Some(Activity::Waiting),
            clients: 0,
            headless: false,
            last_activity_at: Some(30_000),
            git: None,
            started_by: None,
        });
        assert_eq!(
            describe(&status, &paths, 7_230_000),
            "weave Host 0.1.0 (pid 42), up 2h, run on demand\n  socket   \
             /state/weave/daemon/daemon.sock\n  journals /state/weave/daemon/sessions\n  agents \
             get your login shell's environment\n\n1 thread open, at work; `weave threads` \
             lists it.\n"
        );
        status.remote = Some("127.0.0.1:7341".to_owned());
        assert!(
            describe(&status, &paths, 7_230_000)
                .contains("\n  remote   127.0.0.1:7341, for paired devices (`weave devices`)\n")
        );
    }
}
