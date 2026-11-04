//! `weave dispatcher`: the Dispatcher (ADR 0027, WVE-175), which keeps triggers and starts
//! work on the person's Hosts as a client of each, paired with it as a service. `run` runs it
//! here; `install` has launchd or systemd keep it running; the rest ask it over its socket.
//!
//! `weave dispatcher add-host studio` pairs it with studio's Host over SSH ([`crate::ssh`]): it
//! runs `weave pair --json` there for a code. Given the URL and code `weave
//! pair` showed there instead, it pairs with those. Its schedules are in [`crate::schedules`].

use std::time::Duration;

use anyhow::Context as _;
use anyhow::bail;
use clap::Args;
use clap::Subcommand;
use weave_dispatcher::Dispatcher;
use weave_dispatcher::DispatcherConfig;
use weave_dispatcher::DispatcherPaths;
use weave_dispatcher::client::DispatcherConnection;
use weave_dispatcher::socket;
use weave_host_protocol::dispatcher::AddHostRequest;
use weave_host_protocol::dispatcher::DispatcherHost;
use weave_host_protocol::dispatcher::DispatcherStatusRequest;
use weave_host_protocol::dispatcher::ListHostsRequest;
use weave_host_protocol::dispatcher::Reachability;
use weave_host_protocol::dispatcher::RemoveHostRequest;
use weave_host_protocol::hello::ClientInfo;

use crate::daemon::ago;
use crate::daemon::now_ms;
use crate::devices::Offered;
use crate::schedules;
use crate::service;
use crate::ssh::Reach;
use crate::ssh::reach;
use crate::ssh::ssh;
use crate::ssh::ssh_name;

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
    AddHost(AddHostArgs),
    /// The Hosts the Dispatcher is paired with, and whether it's connected to each.
    Hosts(JsonArgs),
    /// Forget a Host, and the work waiting for it. The Host lists the Dispatcher among its
    /// devices until you revoke it there with `weave devices revoke`.
    RemoveHost(RemoveHostArgs),
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

#[derive(Args)]
struct AddHostArgs {
    /// The computer SSH reaches the Host on, or the URL `weave pair` shows there.
    host: String,
    /// The code `weave pair` shows there, after its URL.
    code: Option<String>,
    /// What to call it; the computer's name, or its tailnet name, by default.
    #[arg(long)]
    name: Option<String>,
    /// Print the Host as JSON.
    #[arg(long)]
    json: bool,
}

#[derive(Args)]
struct RemoveHostArgs {
    /// The Host's id or name.
    host: String,
}

pub async fn command(args: DispatcherArgs) -> anyhow::Result<()> {
    let paths = DispatcherPaths::from_env().context("no home directory for the Dispatcher")?;
    match args.command {
        DispatcherCommand::Run => run(paths).await,
        DispatcherCommand::Install => install(&paths).await,
        DispatcherCommand::Uninstall => {
            service::uninstall_dispatcher(&paths)?;
            eprintln!("Removed the Dispatcher's service; it no longer runs.");
            Ok(())
        }
        DispatcherCommand::Status(args) => status(&paths, args.json).await,
        DispatcherCommand::AddHost(args) => add_host(&paths, args).await,
        DispatcherCommand::Hosts(args) => {
            let dispatcher = connect(&paths).await?;
            let hosts = dispatcher.send(ListHostsRequest {}).await?.hosts;
            dispatcher.shutdown().await;
            if args.json {
                println!("{}", serde_json::to_string_pretty(&hosts)?);
            } else {
                print!("{}", describe(&hosts, now_ms()));
            }
            Ok(())
        }
        DispatcherCommand::Schedules(args) => schedules::schedules(&paths, args).await,
        DispatcherCommand::Occurrences(args) => schedules::occurrences(&paths, args).await,
        DispatcherCommand::RemoveHost(args) => {
            let dispatcher = connect(&paths).await?;
            dispatcher
                .send(RemoveHostRequest {
                    host: args.host.clone(),
                })
                .await?;
            dispatcher.shutdown().await;
            println!(
                "Forgot {}. It lists the Dispatcher among its devices until you revoke it there \
                 with `weave devices revoke`.",
                args.host
            );
            Ok(())
        }
    }
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
        () = crate::daemon::stop_signal() => {}
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
    print!("\n{}", describe(&hosts, now));
    Ok(())
}

async fn add_host(paths: &DispatcherPaths, args: AddHostArgs) -> anyhow::Result<()> {
    let AddHostArgs {
        host,
        code,
        name,
        json,
    } = args;
    let dispatcher = connect(paths).await?;
    let (url, code, name) = match reach(&host, code)? {
        Reach::Code { url, code } => (url, code, name),
        Reach::Ssh(destination) => {
            let offered: Offered = serde_json::from_str(
                &ssh(&destination, &["pair", "--json"]).context("asking it for a code")?,
            )
            .context("reading what `weave pair --json` said there")?;
            let name = name.or_else(|| Some(ssh_name(&destination)));
            (offered.url, offered.code, name)
        }
    };
    let added = dispatcher.send(AddHostRequest { url, code, name }).await;
    dispatcher.shutdown().await;
    let host = added?.host;
    if json {
        println!("{}", serde_json::to_string_pretty(&host)?);
    } else {
        println!(
            "Paired the Dispatcher with {} ({}) as a service: it starts work there. That Host \
             lists it among its devices as {}.",
            host.name, host.host_id, host.device_id
        );
    }
    Ok(())
}

/// The Dispatcher running from `paths`, said hello to.
pub(crate) async fn connect(paths: &DispatcherPaths) -> anyhow::Result<DispatcherConnection> {
    let transport = socket::connect(&paths.socket()).await.with_context(|| {
        format!(
            "the Dispatcher isn't running from {}; `weave dispatcher install` runs it as a \
             service, or `weave dispatcher run` here",
            paths.dir.display()
        )
    })?;
    let client = ClientInfo {
        name: "weave-cli".to_owned(),
        version: env!("CARGO_PKG_VERSION").to_owned(),
    };
    DispatcherConnection::connect(transport, client)
        .await
        .map_err(|error| anyhow::anyhow!("{}", error.message))
}

fn describe(hosts: &[DispatcherHost], now_ms: u64) -> String {
    if hosts.is_empty() {
        return "The Dispatcher pairs with no Hosts; `weave dispatcher add-host <computer>` \
                pairs it with one over SSH.\n"
            .to_owned();
    }
    let width = hosts
        .iter()
        .map(|host| host.name.chars().count())
        .max()
        .unwrap_or(0);
    hosts
        .iter()
        .map(|host| {
            let why = host.why.as_deref().unwrap_or("no reason given");
            let state = match (host.connected, host.status) {
                (true, _) => match host.connected_at {
                    Some(at) => format!("connected for {}", ago(now_ms, at)),
                    None => "connected".to_owned(),
                },
                (false, Reachability::Unchecked) => "connecting".to_owned(),
                (false, Reachability::Refused) => {
                    format!("refused the Dispatcher: {why}; add it again to pair")
                }
                (false, Reachability::Down) => format!("down: {why}"),
                (false, Reachability::OtherHost) => format!("another Host answers: {why}"),
                (false, Reachability::Reachable | Reachability::Unreachable) => {
                    format!("can't be reached: {why}")
                }
            };
            let pending = match host.pending {
                0 => String::new(),
                1 => ", 1 piece of work waiting".to_owned(),
                pending => format!(", {pending} pieces of work waiting"),
            };
            format!(
                "{}  {:width$}  {}  {state}{pending}\n",
                host.host_id, host.name, host.url
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    #[test]
    fn hosts_are_listed_with_how_the_dispatcher_reaches_them() {
        let host = |id: &str, connected, status, why: Option<&str>, pending| DispatcherHost {
            host_id: id.to_owned(),
            name: "studio".to_owned(),
            url: "wss://studio.example.ts.net:7341".to_owned(),
            device_id: "d-1".to_owned(),
            paired_at: 0,
            connected,
            status,
            why: why.map(str::to_owned),
            connected_at: connected.then_some(1000),
            pending,
        };
        assert_eq!(
            describe(
                &[
                    host("h1", true, Reachability::Reachable, None, 0),
                    host(
                        "h2",
                        false,
                        Reachability::Refused,
                        Some("it revoked the Dispatcher"),
                        2
                    ),
                ],
                61_000
            ),
            "h1  studio  wss://studio.example.ts.net:7341  connected for 1m\n\
             h2  studio  wss://studio.example.ts.net:7341  refused the Dispatcher: it revoked the \
             Dispatcher; add it again to pair, 2 pieces of work waiting\n"
        );
        assert!(describe(&[], 0).starts_with("The Dispatcher pairs with no Hosts"));
    }
}
