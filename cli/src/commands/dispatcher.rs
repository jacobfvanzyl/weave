//! `weave dispatcher`: the Dispatcher (ADR 0027, WVE-175), which keeps triggers and starts
//! work on the person's Hosts as a client of each, paired with it as a service. `run` runs it in
//! the foreground; `start`, `stop` and `restart` in the background, or through its service once
//! `install` has launchd or systemd keep it running; `status`, the default, asks it over its
//! socket. Its Hosts are [`crate::commands::hosts`]'s, its schedules
//! [`crate::commands::schedules`]'.

use std::process::ExitCode;

use anyhow::Context as _;
use anyhow::bail;
use clap::Args;
use clap::Subcommand;
use weave_dispatcher::Dispatcher;
use weave_dispatcher::DispatcherConfig;
use weave_dispatcher::DispatcherPaths;
use weave_dispatcher::socket;
use weave_host_protocol::dispatcher::DispatcherStatusRequest;
use weave_host_protocol::dispatcher::ListHostsRequest;

use crate::background;
use crate::clock::ago;
use crate::clock::now_ms;
use crate::commands::hosts;
use crate::commands::stop_signal;
use crate::dispatcher;
use crate::dispatcher::connect;
use crate::service;

/// `run`'s stderr is its log, as the Host's is.
pub const LOG: &str = "info";

#[derive(Args)]
pub struct DispatcherArgs {
    #[command(subcommand)]
    command: Option<DispatcherCommand>,
}

#[derive(Subcommand)]
enum DispatcherCommand {
    /// Run the Dispatcher in the foreground until stopped (for launchd or systemd, or to watch
    /// its log).
    Run,
    /// Start the Dispatcher in the background, if it isn't running.
    Start,
    /// Stop the Dispatcher. Nothing runs on schedule until it starts again; then each schedule
    /// catches up as its `--missed` says.
    Stop,
    /// Stop the Dispatcher if it's running, then start it again: after rebuilding weave.
    Restart,
    /// Whether the Dispatcher runs, and how it reaches its Hosts (the default).
    Status(JsonArgs),
    /// Have launchd or systemd run the Dispatcher, from login or boot, and restart it if it
    /// stops.
    Install,
    /// Stop the Dispatcher's service and remove it.
    Uninstall,
}

#[derive(Args, Default)]
struct JsonArgs {
    /// Print it as JSON.
    #[arg(long)]
    json: bool,
}

pub async fn command(args: DispatcherArgs) -> anyhow::Result<ExitCode> {
    let paths = dispatcher::paths()?;
    let done = match args
        .command
        .unwrap_or_else(|| DispatcherCommand::Status(JsonArgs::default()))
    {
        DispatcherCommand::Run => run(paths).await,
        DispatcherCommand::Start => start(&paths).await,
        DispatcherCommand::Stop => {
            if !stop(&paths).await? {
                eprintln!("The Dispatcher isn't running.");
            }
            Ok(())
        }
        DispatcherCommand::Restart => restart(&paths).await,
        DispatcherCommand::Status(args) => status(&paths, args.json).await,
        DispatcherCommand::Install => install(&paths).await,
        DispatcherCommand::Uninstall => {
            service::uninstall_dispatcher(&paths)?;
            eprintln!("Removed the Dispatcher's service; it no longer runs.");
            Ok(())
        }
    };
    done.map(|()| ExitCode::SUCCESS)
}

/// `weave dispatcher run`: hold the directory's lock, answer on its socket, and keep the
/// Hosts connected until SIGTERM or SIGINT. Its work is kept as it goes, so stopping it drains
/// nothing.
async fn run(paths: DispatcherPaths) -> anyhow::Result<()> {
    let listening = socket::listen(&paths)
        .with_context(|| format!("listening on {}", paths.socket().display()))?;
    let dispatcher = Dispatcher::open(DispatcherConfig::new(paths.clone()))
        .map_err(anyhow::Error::msg)
        .context("opening the Dispatcher's state")?;
    tracing::info!(dir = %paths.dir.display(), "the Dispatcher is running");
    tokio::select! {
        () = dispatcher.serve(listening.listener) => {}
        () = stop_signal() => {}
    }
    dispatcher.stop().await;
    tracing::info!("the Dispatcher stopped");
    Ok(())
}

async fn install(paths: &DispatcherPaths) -> anyhow::Result<()> {
    if !service::dispatcher_installed(paths) && socket::connect(&paths.socket()).await.is_ok() {
        bail!(
            "a Dispatcher already runs from {}, not as a service: `weave dispatcher stop` stops it, \
             and the service takes over",
            paths.dir.display()
        );
    }
    let (executable, lingering) = service::install_dispatcher(paths)?;
    if !dispatcher::answers(paths).await {
        bail!(
            "installed the Dispatcher's service, but it didn't answer within {} seconds; its log \
             is {}",
            dispatcher::STARTUP_WAIT.as_secs(),
            paths.log().display()
        );
    }
    let lingering = lingering.map(|note| format!(" {note}")).unwrap_or_default();
    eprintln!(
        "Installed the Dispatcher as a {} service. It runs {} and restarts it if it stops; \
         `weave dispatcher uninstall` removes it.{lingering} Pair it with a Host with `weave hosts \
         add <computer>`.",
        service::manager_name(),
        executable.display()
    );
    Ok(())
}

/// Start the Dispatcher in the background, or have its service's manager start it, and wait for
/// it to answer.
async fn start(paths: &DispatcherPaths) -> anyhow::Result<()> {
    if socket::connect(&paths.socket()).await.is_ok() {
        eprintln!(
            "The Dispatcher is already running from {}.",
            paths.dir.display()
        );
        return Ok(());
    }
    if service::dispatcher_installed(paths) {
        service::start_dispatcher(paths)?;
    } else {
        paths
            .prepare()
            .with_context(|| format!("creating {}", paths.dir.display()))?;
        background::spawn(&["dispatcher", "run"], &paths.log(), "the Dispatcher")?;
    }
    if !dispatcher::answers(paths).await {
        bail!(
            "the Dispatcher didn't answer within {} seconds; its log is {}",
            dispatcher::STARTUP_WAIT.as_secs(),
            paths.log().display()
        );
    }
    eprintln!(
        "Started the Dispatcher from {}; it logs to {}.",
        paths.dir.display(),
        paths.log().display()
    );
    Ok(())
}

/// Stop the Dispatcher, through its service's manager when it's installed, which would start it
/// again otherwise, and wait for it to go. Returns whether it was running.
async fn stop(paths: &DispatcherPaths) -> anyhow::Result<bool> {
    let running = socket::connect(&paths.socket()).await.is_ok();
    if service::dispatcher_installed(paths) {
        service::stop_dispatcher(paths)?;
    } else if running {
        weave_host::socket::terminate_listener(&paths.socket())
            .await
            .with_context(|| format!("stopping the Dispatcher on {}", paths.socket().display()))?;
    }
    if !running {
        return Ok(false);
    }
    dispatcher::wait_until_stopped(paths).await?;
    eprintln!("Stopped the Dispatcher.");
    Ok(true)
}

/// Stop the Dispatcher if it's running, and start it again, through its service's manager when
/// it's installed.
async fn restart(paths: &DispatcherPaths) -> anyhow::Result<()> {
    if !service::dispatcher_installed(paths) {
        stop(paths).await?;
        return start(paths).await;
    }
    service::restart_dispatcher(paths).await?;
    if !dispatcher::answers(paths).await {
        bail!(
            "restarted the Dispatcher's service, but it didn't answer within {} seconds; its log \
             is {}",
            dispatcher::STARTUP_WAIT.as_secs(),
            paths.log().display()
        );
    }
    eprintln!(
        "Restarted the Dispatcher from {}; it logs to {}.",
        paths.dir.display(),
        paths.log().display()
    );
    Ok(())
}

async fn status(paths: &DispatcherPaths, json: bool) -> anyhow::Result<()> {
    let Ok(dispatcher) = connect(paths).await else {
        let installed = if service::dispatcher_installed(paths) {
            format!(
                "Its {} service is installed but it isn't answering; its log is {}.",
                service::manager_name(),
                paths.log().display()
            )
        } else {
            "`weave dispatcher install` runs it as a service, or `weave dispatcher start` here."
                .to_owned()
        };
        bail!(
            "the Dispatcher isn't running from {}. {installed}",
            paths.dir.display()
        );
    };
    let status = dispatcher.send(DispatcherStatusRequest {}).await?;
    let hosts = dispatcher.send(ListHostsRequest {}).await?.hosts;
    dispatcher.shutdown().await;
    if json {
        let value = serde_json::json!({"status": status, "hosts": hosts});
        println!("{}", serde_json::to_string_pretty(&value)?);
        return Ok(());
    }
    let now = now_ms();
    let service = if service::dispatcher_installed(paths) {
        format!("its {} service", service::manager_name())
    } else {
        "a process of its own".to_owned()
    };
    println!(
        "The Dispatcher {} (pid {}) has run for {} as {service}, from {}. It pairs with Hosts \
         as \"{}\", and {} waiting for a Host.",
        status.version,
        status.pid,
        ago(now, status.started_at),
        paths.dir.display(),
        status.name,
        match status.pending {
            0 => "has no work".to_owned(),
            1 => "has 1 piece of work".to_owned(),
            pending => format!("has {pending} pieces of work"),
        }
    );
    print!("\n{}", hosts::describe(&hosts, now));
    Ok(())
}
