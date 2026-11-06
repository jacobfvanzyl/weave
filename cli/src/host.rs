//! Reaching the weave Host, which runs agents so sessions outlive the TUI: the per-user one
//! over its socket, started on first use, or one inside this process (`--no-daemon`); and
//! stopping the per-user one. `weave daemon` manages it ([`crate::commands::daemon`]).

use std::collections::BTreeMap;
use std::fs::OpenOptions;
use std::io;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;

use anyhow::Context;
use anyhow::bail;
use tokio::sync::mpsc::UnboundedReceiver;
use weave_acp_core::AgentSpec;
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
use weave_host_protocol::host::ShutdownRequest;
use weave_host_protocol::tools::CLIPBOARD_WRITE;
use weave_tui::Reconnection;
use weave_tui::Reconnector;

use crate::args::AgentChoice;
use crate::args::COMMAND_AGENT;
use crate::args::HostLaunch;
use crate::args::WorkspaceArgs;
use crate::exit;
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

    /// The shared Host's paths, to reach it again; none in-process.
    pub(crate) fn paths(&self) -> Option<DaemonPaths> {
        match self {
            Self::Shared(paths) => Some(paths.clone()),
            Self::InProcess(_) => None,
        }
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
pub(crate) fn start_in_background(paths: &DaemonPaths) -> anyhow::Result<()> {
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
    Ok(control_with_events(paths)
        .await?
        .map(|(connection, _events)| connection))
}

/// A connection to the Host, if it's running, and what it sends.
pub(crate) async fn control_with_events(
    paths: &DaemonPaths,
) -> anyhow::Result<Option<(HostConnection, UnboundedReceiver<HostEvent>)>> {
    let transport = match socket::connect(&paths.socket).await {
        Ok(transport) => transport,
        Err(error) if not_running(&error) => return Ok(None),
        Err(error) => {
            return Err(exit::unreachable(error)
                .context(format!("connecting to {}", paths.socket.display())));
        }
    };
    let connected = HostConnection::connect(
        transport,
        client_info("weave-cli"),
        capabilities("weave-cli"),
    )
    .await?;
    Ok(Some(connected))
}

/// Have the Host start no new turns and, unless `now`, wait for its running ones to end,
/// saying so, before it's stopped. The connection returned holds the drain until the Host
/// stops; none when the Host isn't running or can't drain. A turn of the agent running this,
/// as when an agent restarts the Host, isn't waited for.
pub(crate) async fn drain(
    paths: &DaemonPaths,
    now: bool,
) -> anyhow::Result<Option<HostConnection>> {
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
