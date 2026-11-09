//! Reaching the weave Host, which runs agents so threads outlive the TUI: the per-user one
//! over its socket, started on first use, or one inside this process (`--no-daemon`); one of
//! the person's Hosts on another computer, through the Dispatcher (`--host`, ADR 0030,
//! WVE-195); and stopping the per-user one. `weave daemon` manages it
//! ([`crate::commands::daemon`]).

use std::collections::BTreeMap;
use std::io;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::OnceLock;
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
use weave_host_client::carry;
use weave_host_client::carry::CarryError;
use weave_host_client::carry::Via;
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
use crate::background;
use crate::exit;
use crate::paired;
use crate::service;

/// A background Host exits once nothing has been open or connected for this long.
const BACKGROUND_IDLE_EXIT: Duration = Duration::from_secs(10 * 60);
/// How long to wait for a Host to start listening, or to stop.
const STARTUP_WAIT: Duration = Duration::from_secs(10);
/// How long the Dispatcher has to carry a connection to another computer's Host and the Host to
/// answer its hello.
const CARRY_WAIT: Duration = Duration::from_secs(20);

/// Where this invocation's agents run, before it knows which agent.
pub enum Target {
    /// The per-user Host, started on first use.
    Shared(DaemonPaths),
    /// A Host inside this process, which ends with it.
    InProcess,
    /// One of the person's Hosts on another computer, through the Dispatcher.
    Carried(Carry),
}

/// The Host this invocation talks to.
pub enum Host {
    Shared(DaemonPaths),
    InProcess(weave_host::Daemon),
    Carried(Carry),
}

/// One of the person's Hosts on another computer, which the Dispatcher carries this client's
/// connections to (ADR 0030, WVE-195): through the Dispatcher running here, or the one this
/// computer is paired with ([`crate::paired`]).
#[derive(Clone)]
pub struct Carry {
    /// As `--host` named it: its id, or what the Dispatcher calls it.
    pub host: String,
    via: Via,
    /// What the Dispatcher calls it, once it has carried a connection there.
    name: Arc<OnceLock<String>>,
}

impl Carry {
    /// The Host `host` names, through the Dispatcher running from this computer's Dispatcher
    /// directory if one answers there, and otherwise the one this computer is paired with.
    pub async fn to(host: &str) -> anyhow::Result<Self> {
        let paths = crate::dispatcher::paths()?;
        let via = if tokio::net::UnixStream::connect(paths.socket())
            .await
            .is_ok()
        {
            Via::Socket(paths.socket())
        } else if let Some(paired) = crate::dispatcher::remote_pairing()? {
            Via::Paired {
                url: paired.url,
                dispatcher_id: paired.dispatcher_id,
                device_id: paired.device_id,
                key: paired::key()?,
            }
        } else {
            bail!(
                "--host reaches your other Hosts through the Dispatcher, but none runs here and \
                 this computer isn't paired with one: `weave dispatcher connect <its computer>` \
                 pairs it"
            );
        };
        Ok(Self {
            host: host.to_owned(),
            via,
            name: Arc::default(),
        })
    }

    /// What the Dispatcher calls the Host, or as `--host` named it until it's been reached.
    pub fn name(&self) -> String {
        self.name
            .get()
            .cloned()
            .unwrap_or_else(|| self.host.clone())
    }

    /// Connect to the Host through the Dispatcher and say hello as `client`.
    pub async fn connect(
        &self,
        client: &str,
    ) -> anyhow::Result<(HostConnection, UnboundedReceiver<HostEvent>)> {
        match self.reach(client).await {
            Ok(connected) => Ok(connected),
            Err(error) => Err(self.failed(error)),
        }
    }

    async fn reach(
        &self,
        client: &str,
    ) -> Result<(HostConnection, UnboundedReceiver<HostEvent>), CarryError> {
        let reached = carry::reach(
            &self.via,
            client_info(client),
            ClientCapabilities {
                // Sign-in runs on the Host's computer.
                terminal_sign_in: false,
                ..capabilities(client)
            },
            &self.host,
            CARRY_WAIT,
        )
        .await?;
        let _ = self.name.set(reached.host.name);
        Ok((reached.connection, reached.events))
    }

    /// Why the Host couldn't be reached, exiting as an unreachable Host does when waiting may
    /// help.
    fn failed(&self, error: CarryError) -> anyhow::Error {
        let host = &self.host;
        match error {
            CarryError::Dispatcher { .. } | CarryError::Unavailable(_) => {
                exit::unreachable(anyhow::anyhow!("couldn't reach {host}: {error}"))
            }
            CarryError::Refused(_) => anyhow::anyhow!(
                "couldn't reach {host}: {error}; `weave dispatcher connect` pairs this computer \
                 again"
            ),
            CarryError::Refusal(_) => anyhow::anyhow!("couldn't reach {host}: {error}"),
            CarryError::Hello(error) => {
                anyhow::Error::from(error).context(format!("couldn't reach {host}"))
            }
        }
    }

    /// Reach the Host again, as after it went away: `None` while it can't be yet.
    async fn again(
        &self,
        client: &str,
    ) -> anyhow::Result<Option<(HostConnection, UnboundedReceiver<HostEvent>)>> {
        match self.reach(client).await {
            Ok(connected) => Ok(Some(connected)),
            Err(error) if error.may_pass() => Ok(None),
            Err(error) => Err(self.failed(error)),
        }
    }
}

/// How a command reaches its Host again once it goes away, without starting one.
#[derive(Clone)]
pub(crate) enum Again {
    Shared(DaemonPaths),
    Carried(Carry),
}

impl Again {
    /// The Host, if it's there: `None` while it isn't yet.
    pub(crate) async fn connect(
        &self,
        client: &str,
    ) -> anyhow::Result<Option<(HostConnection, UnboundedReceiver<HostEvent>)>> {
        match self {
            Self::Shared(paths) => control_with_events(paths).await,
            Self::Carried(carry) => carry.again(client).await,
        }
    }
}

impl Target {
    /// The per-user Host, or one in this process with `no_daemon`; with `host`, the person's
    /// Host that names, through the Dispatcher, unless it's this computer's own.
    pub async fn choose(no_daemon: bool, host: Option<&str>) -> anyhow::Result<Self> {
        if let Some(host) = host {
            let paths = paths()?;
            let here = weave_host::known_as(&paths)
                .iter()
                .any(|known| known.eq_ignore_ascii_case(host));
            if here {
                return Ok(Self::Shared(paths));
            }
            return Ok(Self::Carried(Carry::to(host).await?));
        }
        if no_daemon {
            return Ok(Self::InProcess);
        }
        Ok(Self::Shared(paths()?))
    }

    /// The Host `--project` names a directory on: the one on another computer, or else this
    /// computer's.
    pub fn on(&self) -> crate::projects::On<'_> {
        match self {
            Self::Carried(carry) => crate::projects::On::Host(&carry.host),
            Self::Shared(_) | Self::InProcess => crate::projects::On::Here,
        }
    }

    /// The Host on another computer, when it's one.
    pub fn carried(&self) -> Option<&Carry> {
        match self {
            Self::Carried(carry) => Some(carry),
            Self::Shared(_) | Self::InProcess => None,
        }
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
        let shared = || {
            if let AgentChoice::Command(_) = &launch.agent {
                bail!(
                    "the weave Host runs agents its config defines: add this one under \
                     [agents.<id>] with its command, and use --agent <id>; or use --no-daemon"
                );
            }
            if withheld != Withheld::default() {
                bail!(
                    "--no-fs and --no-terminal apply with --no-daemon; for the weave Host, set \
                     fs = false or terminal = false under the agent in the config"
                );
            }
            Ok(())
        };
        match self {
            Self::Shared(paths) => {
                shared()?;
                Ok(Host::Shared(paths.clone()))
            }
            Self::Carried(carry) => {
                shared()?;
                Ok(Host::Carried(carry.clone()))
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
            Self::Carried(carry) => return carry.connect(client).await,
        };
        connected.map_err(anyhow::Error::from)
    }

    /// How to reach the Host again after it goes away; none in-process.
    pub(crate) fn again(&self) -> Option<Again> {
        match self {
            Self::Shared(paths) => Some(Again::Shared(paths.clone())),
            Self::InProcess(_) => None,
            Self::Carried(carry) => Some(Again::Carried(carry.clone())),
        }
    }

    /// Whether threads outlive this process.
    pub fn is_shared(&self) -> bool {
        matches!(self, Self::Shared(_) | Self::Carried(_))
    }

    /// The Host's name, when it's another computer's, reached through the Dispatcher.
    pub fn elsewhere(&self) -> Option<String> {
        match self {
            Self::Carried(carry) => Some(carry.name()),
            Self::Shared(_) | Self::InProcess(_) => None,
        }
    }

    /// How the TUI reaches the Host again after it goes away, without starting one: a
    /// restarted Host is picked up, a stopped one stays stopped, and another computer's is
    /// reached through the Dispatcher again. None in-process.
    pub fn reconnector(&self) -> Option<Reconnector> {
        match self {
            Self::Shared(paths) => {
                let paths = paths.clone();
                Some(Arc::new(move || {
                    let paths = paths.clone();
                    Box::pin(async move { reconnect(&paths).await })
                }))
            }
            Self::Carried(carry) => {
                let carry = carry.clone();
                Some(Arc::new(move || {
                    let carry = carry.clone();
                    Box::pin(async move { reconnect_carried(&carry).await })
                }))
            }
            Self::InProcess(_) => None,
        }
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

/// One attempt to reach another computer's Host again through the Dispatcher.
async fn reconnect_carried(carry: &Carry) -> Reconnection {
    match carry.reach(TUI).await {
        Ok((connection, events)) => Reconnection::Connected(Box::new(connection), events),
        Err(CarryError::Hello(ConnectError::Incompatible(why))) => Reconnection::Incompatible(why),
        // The Dispatcher or the Host may come back; a revoked device waits out the window.
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
    let idle_exit = BACKGROUND_IDLE_EXIT.as_secs().to_string();
    background::spawn(
        &["daemon", "run", "--idle-exit", &idle_exit],
        &paths.log(),
        "the weave Host",
    )
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
