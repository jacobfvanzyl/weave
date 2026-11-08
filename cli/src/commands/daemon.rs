//! `weave daemon`: managing the per-user weave Host, which runs agents so threads outlive the
//! TUI: running it in the foreground, starting and stopping it in the background, installing
//! it as a service, and saying what it runs.

use std::path::Path;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use clap::Args;
use clap::Subcommand;
use weave_agents::environment::CAPTURE_TIMEOUT;
use weave_agents::environment::Environment;
use weave_host::DaemonConfig;
use weave_host::DaemonPaths;
use weave_host::socket;
use weave_host_protocol::host::HostStatus;
use weave_host_protocol::host::Service;
use weave_host_protocol::host::StatusRequest;
use weave_host_protocol::threads::Activity;

use crate::clock::ago;
use crate::clock::now_ms;
use crate::commands::stop_signal;
use crate::exit::Status;
use crate::host::control;
use crate::host::drain;
use crate::host::paths;
use crate::host::start_in_background;
use crate::host::stop;
use crate::host::wait_until_listening;
use crate::service;

/// What `weave daemon run` logs, and `weave daemon status` says, while the config has a
/// `[remote]` (WVE-197).
const REMOTE_NOTICE: &str = "The config's [remote] does nothing now: Hosts don't listen for remote \
                             clients, which reach them through the Dispatcher, and `weave pair` \
                             pairs a device with it. Remove [remote] from the config.";

/// A Host's stderr is its log, agents' stderr included, as `--log-file` has it.
pub const LOG: &str = "info,agent_stderr=debug";

#[derive(Args)]
pub struct DaemonArgs {
    #[command(subcommand)]
    command: Option<DaemonCommand>,
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
    /// What the Host is running (the default).
    Status(StatusArgs),
    /// Run the Host as a service (launchd's on macOS, systemd's on Linux): kept running,
    /// with no idle exit.
    Install,
    /// Remove the service `install` wrote, stopping the Host.
    Uninstall,
}

#[derive(Args, Default)]
struct StatusArgs {
    /// Print the Host's answer (`host/status`) as JSON; nothing when it isn't running.
    #[arg(long)]
    json: bool,
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
    let command = args
        .command
        .unwrap_or_else(|| DaemonCommand::Status(StatusArgs::default()));
    let done = match command {
        DaemonCommand::Run(run) => serve(&paths, run).await,
        DaemonCommand::Start => start(&paths).await,
        DaemonCommand::Stop(stop_args) => {
            if !stop(&paths, stop_args.now).await? {
                eprintln!("The weave Host isn't running.");
            }
            Ok(())
        }
        DaemonCommand::Restart(stop_args) => restart(&paths, stop_args.now).await,
        DaemonCommand::Status(StatusArgs { json }) => {
            return status(&paths, json).await.map(ExitCode::from);
        }
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
    let login_path = environment.vars.get("PATH").cloned();
    let open_threads = open_threads(run.config.as_deref());
    let mut config = DaemonConfig::persistent(paths, service, environment);
    config.former_serve = former_serve(run.config.as_deref());
    config.config_file = run.config;
    let daemon = weave_host::Daemon::new(config);
    if open_threads {
        follow_threads_in_rex(&daemon, paths, login_path.as_deref());
    }
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
    // it joined a Dispatcher, through which devices reach it and which can't start it again.
    let idle_exit = if run.launchd || run.systemd {
        None
    } else {
        run.idle_exit.map(Duration::from_secs)
    };
    let removing = daemon.clone();
    tokio::spawn(async move { removing.remove_serve_entry().await });
    daemon.resume_dispatcher();
    let queues = daemon.clone();
    tokio::spawn(async move { queues.resume_queues().await });
    let streams = daemon.clone();
    let terminal_socket = paths.terminal_socket();
    tokio::spawn(async move {
        if let Err(error) = streams.serve_terminal_streams(&terminal_socket).await {
            tracing::warn!(%error, socket = %terminal_socket.display(), "local terminal streams aren't served");
        }
    });
    daemon.serve(listening.listener, idle_exit).await;
    let _ = std::fs::remove_file(&paths.socket);
    tracing::info!("weave Host stopped");
    Ok(())
}

/// Whether the config has threads opened from the app open in Rex (`[rex] open_threads`).
fn open_threads(config: Option<&Path>) -> bool {
    match crate::config::Config::load(config) {
        Ok(config) => config.rex.open_threads.unwrap_or(false),
        Err(error) => {
            tracing::error!(error = %format!("{error:#}"), "the config can't be read; threads won't open in Rex");
            false
        }
    }
}

/// Open threads from the app in this computer's Rex (ADR 0025), through a client beside the
/// Host that doesn't keep an idle one running.
fn follow_threads_in_rex(
    daemon: &weave_host::Daemon,
    paths: &DaemonPaths,
    login_path: Option<&str>,
) {
    let path = login_path
        .map(str::to_owned)
        .or_else(|| std::env::var("PATH").ok())
        .unwrap_or_default();
    let Some(rex) = crate::rex_threads::find_rex(&path) else {
        tracing::info!("[rex] open_threads: there's no rex on the login shell's PATH");
        return;
    };
    let daemon = daemon.clone();
    let record = paths.dir.join("rex-threads.json");
    tokio::spawn(async move { crate::rex_threads::follow(daemon, rex, record).await });
}

/// The Tailscale Serve entry the Host made for remote clients before they reached it through the
/// Dispatcher (WVE-197), which it removes if its directory shows it served them: the one that
/// forwarded to 127.0.0.1:7341, or to the config's `[remote] listen`, which `[remote]` is still
/// read for, and logged as doing nothing else. With `[remote] url` it made none.
fn former_serve(config: Option<&Path>) -> Option<weave_host::FormerServe> {
    let remote = match crate::config::Config::load(config) {
        Ok(config) => config.remote,
        Err(error) => {
            tracing::error!(error = %format!("{error:#}"), "the config can't be read; the Host looks for the Serve entry it made on its default port");
            None
        }
    };
    if remote.is_some() {
        tracing::warn!("{REMOTE_NOTICE}");
    }
    let listen = match remote {
        Some(remote) => remote.former_listen()?,
        None => crate::config::FORMER_LISTEN.parse().ok()?,
    };
    Some(weave_host::FormerServe::new(
        listen,
        Arc::new(weave_host::tailscale::TailscaleServe::HOST),
    ))
}

/// [`REMOTE_NOTICE`], while the default config has a `[remote]`.
fn remote_notice() -> Option<String> {
    crate::config::Config::load(None)
        .ok()?
        .remote
        .map(|_| REMOTE_NOTICE.to_owned())
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

/// `weave daemon status`: [`Status::Unreachable`] when the Host isn't running, as `systemctl
/// status` exits 3 for a unit that isn't active. With `json`, stdout has only the Host's answer,
/// and what's said about the service goes to stderr.
async fn status(paths: &DaemonPaths, json: bool) -> anyhow::Result<Status> {
    let installed = service::installed(paths);
    let mut notes = if installed {
        service::notes(paths)
    } else {
        Vec::new()
    };
    notes.extend(remote_notice());
    let Some(connection) = control(paths).await? else {
        let service = if installed {
            format!("; its {} service is installed", service::manager_name())
        } else {
            String::new()
        };
        let said = format!(
            "The weave Host isn't running ({}){service}.",
            paths.socket.display()
        );
        if json {
            eprintln!("{said}");
        } else {
            println!("{said}");
        }
        print_notes(&notes, json);
        return Ok(Status::Unreachable);
    };
    let status = connection.send(StatusRequest {}).await;
    connection.shutdown().await;
    let status = status?;
    if json {
        println!("{}", serde_json::to_string_pretty(&status)?);
    } else {
        print!("{}", describe(&status, paths, now_ms()));
    }
    print_notes(&notes, json);
    Ok(Status::Success)
}

/// What the person may want to change about the service, each as a paragraph of its own: on
/// stderr when stdout is JSON.
fn print_notes(notes: &[String], json: bool) {
    for note in notes {
        if json {
            eprintln!("\n{note}");
        } else {
            println!("\n{note}");
        }
    }
}

fn describe(status: &HostStatus, paths: &DaemonPaths, now_ms: u64) -> String {
    let running = status
        .threads
        .iter()
        .filter(|thread| {
            thread
                .activity
                .is_some_and(|activity| activity != Activity::Idle)
        })
        .count();
    let threads = match (status.threads.len(), running) {
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
    let serve_entry = status
        .serve_entry
        .as_ref()
        .map(|left| {
            format!(
                "\nRemote clients reach this Host through the Dispatcher now, but it couldn't \
                 remove the Tailscale Serve entry it made for them on HTTPS port {}: {}. Remove it \
                 with:\n  {}\n",
                left.port, left.why, left.command
            )
        })
        .unwrap_or_default();
    let dispatcher = status
        .dispatcher
        .as_ref()
        .map(|joined| {
            let state = match (joined.connected, joined.connected_at, &joined.why) {
                (true, Some(at), _) => format!("connected for {}", ago(now_ms, at)),
                (true, None, _) => "connected".to_owned(),
                (false, _, Some(why)) => format!("not connected: {why}"),
                (false, _, None) => "not connected yet".to_owned(),
            };
            format!(
                "  joined   the {} at {}, as {}; {state}\n",
                joined.name, joined.address, joined.host_name
            )
        })
        .unwrap_or_default();
    format!(
        "weave Host {} (pid {}), up {}, run {service}\n  socket   {}\n  journals {}\n{dispatcher}  agents get {environment} environment\n\n{threads}\n{serve_entry}",
        status.version,
        status.pid,
        ago(now_ms, status.started_at),
        paths.socket.display(),
        paths.journals().display(),
    )
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;
    use weave_acp_core::schema::SessionInfo;
    use weave_host_protocol::PROTOCOL_VERSION;
    use weave_host_protocol::host::EnvironmentSource;
    use weave_host_protocol::threads::ThreadListing;
    use weave_host_protocol::threads::ThreadStatus;

    use super::*;

    fn serve_entry_left() -> weave_host_protocol::host::ServeEntryLeft {
        weave_host_protocol::host::ServeEntryLeft {
            port: 7341,
            command: "sudo tailscale serve --https=7341 off".to_owned(),
            why: "only root may".to_owned(),
        }
    }

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
            threads: Vec::new(),
            serve_entry: None,
            dispatcher: None,
        };
        assert!(describe(&status, &paths, 90_000).ends_with("No threads open.\n"));
        status.threads.push(ThreadListing {
            info: SessionInfo::new("s1", "/repo").title("Fix the build".to_owned()),
            agent_id: "claude".into(),
            state: ThreadStatus::Open,
            activity: Some(Activity::Waiting),
            clients: 0,
            headless: false,
            last_activity_at: Some(30_000),
            git: None,
            started_by: None,
            started_by_host: None,
            opened_by: None,
            opened_at: None,
            continued_in: None,
            labels: Vec::new(),
            context: None,
            last_compaction: None,
        });
        assert_eq!(
            describe(&status, &paths, 7_230_000),
            "weave Host 0.1.0 (pid 42), up 2h, run on demand\n  socket   \
             /state/weave/daemon/daemon.sock\n  journals /state/weave/daemon/threads\n  agents \
             get your login shell's environment\n\n1 thread open, at work; `weave threads` \
             lists it.\n"
        );
        status.serve_entry = Some(serve_entry_left());
        assert!(describe(&status, &paths, 7_230_000).ends_with(
            "lists it.\n\nRemote clients reach this Host through the Dispatcher now, but it \
             couldn't remove the Tailscale Serve entry it made for them on HTTPS port 7341: only \
             root may. Remove it with:\n  sudo tailscale serve --https=7341 off\n"
        ));
        status.serve_entry = None;
        status.dispatcher = Some(weave_host_protocol::dispatcher::JoinedDispatcher {
            id: "D1".to_owned(),
            name: "Dispatcher on homelab-1".to_owned(),
            address: weave_host_protocol::dispatcher::DispatcherAddress::Url(
                "wss://homelab-1.example.ts.net:7342".to_owned(),
            ),
            host_name: "studio".to_owned(),
            joined_at: 0,
            connected: true,
            connected_at: Some(7_170_000),
            why: None,
        });
        assert!(describe(&status, &paths, 7_230_000).contains(
            "\n  joined   the Dispatcher on homelab-1 at wss://homelab-1.example.ts.net:7342, as \
             studio; connected for 1m\n"
        ));
    }
}
