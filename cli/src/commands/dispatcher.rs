//! `weave dispatcher`: the Dispatcher (ADR 0027, WVE-175), which keeps triggers and starts
//! work on the person's Hosts as a client of each, paired with it as a service. `run` runs it
//! here; `install` has launchd or systemd keep it running; `status` asks it over its socket.
//! The Hosts it's paired with are [`crate::commands::hosts`]'s, its schedules
//! [`crate::commands::schedules`]'.

use std::process::ExitCode;
use std::time::Duration;

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

use crate::clock::ago;
use crate::clock::now_ms;
use crate::commands::hosts;
use crate::commands::schedules;
use crate::commands::stop_signal;
use crate::dispatcher;
use crate::dispatcher::connect;
use crate::service;

/// `run`'s stderr is its log, as the Host's is.
pub const LOG: &str = "info";

/// How long `install` waits for the service's Dispatcher to answer.
const START_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Args)]
pub struct DispatcherArgs {
    #[command(subcommand)]
    command: DispatcherCommand,
}

#[derive(Subcommand)]
enum DispatcherCommand {
    /// Run the Dispatcher here, until stopped.
    Run,
    /// Have launchd or systemd run the Dispatcher, from login or boot, and restart it if it
    /// stops.
    Install,
    /// Stop the Dispatcher's service and remove it.
    Uninstall,
    /// Whether the Dispatcher runs, and how it reaches its Hosts.
    Status(JsonArgs),
    /// Pair the Dispatcher with a Host as a service, over SSH (`weave dispatcher add-host
    /// studio`) or with the URL and code `weave pair` shows there.
    AddHost(hosts::AddArgs),
    /// The Hosts the Dispatcher is paired with, and whether it's connected to each.
    Hosts(JsonArgs),
    /// Forget a Host, and the work waiting for it. The Host lists the Dispatcher among its
    /// devices until you revoke it there with `weave devices revoke`.
    RemoveHost(hosts::RemoveArgs),
    /// Schedules, which start a headless turn on a Host at the times a cron expression gives:
    /// list, add, remove, pause, resume or run one.
    Schedules(schedules::SchedulesArgs),
    /// What schedules did each time they came due, newest first.
    Occurrences(schedules::OccurrencesArgs),
}

#[derive(Args)]
struct JsonArgs {
    /// Print it as JSON.
    #[arg(long)]
    json: bool,
}

pub async fn command(args: DispatcherArgs) -> anyhow::Result<ExitCode> {
    let paths = dispatcher::paths()?;
    let done = match args.command {
        DispatcherCommand::Run => run(paths).await,
        DispatcherCommand::Install => install(&paths).await,
        DispatcherCommand::Uninstall => {
            service::uninstall_dispatcher(&paths)?;
            eprintln!("Removed the Dispatcher's service; it no longer runs.");
            Ok(())
        }
        DispatcherCommand::Status(args) => status(&paths, args.json).await,
        DispatcherCommand::AddHost(args) => hosts::add(&paths, args).await,
        DispatcherCommand::Hosts(args) => hosts::list(&paths, args.json).await,
        DispatcherCommand::Schedules(args) => schedules::schedules(&paths, args).await,
        DispatcherCommand::Occurrences(args) => schedules::occurrences(&paths, args).await,
        DispatcherCommand::RemoveHost(args) => hosts::remove(&paths, args).await,
    };
    done.map(|()| ExitCode::SUCCESS)
}

/// `weave dispatcher run`: hold the directory's lock, answer on its socket, and keep the
/// Hosts connected until SIGTERM or SIGINT.
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
            "a Dispatcher already runs from {}, not as a service: stop it first, and the service \
             takes over",
            paths.dir.display()
        );
    }
    let (executable, lingering) = service::install_dispatcher(paths)?;
    let answered = tokio::time::timeout(START_TIMEOUT, async {
        loop {
            if let Ok(dispatcher) = connect(paths).await {
                dispatcher.shutdown().await;
                return;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await;
    if answered.is_err() {
        bail!(
            "installed the Dispatcher's service, but it didn't answer within {} seconds; its log \
             is {}",
            START_TIMEOUT.as_secs(),
            paths.log().display()
        );
    }
    let lingering = lingering.map(|note| format!(" {note}")).unwrap_or_default();
    eprintln!(
        "Installed the Dispatcher as a {} service. It runs {} and restarts it if it stops; \
         `weave dispatcher uninstall` removes it.{lingering} Pair it with a Host with `weave \
         dispatcher add-host <computer>`.",
        service::manager_name(),
        executable.display()
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
            "`weave dispatcher install` runs it as a service, or `weave dispatcher run` here."
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
