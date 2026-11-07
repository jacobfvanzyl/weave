//! `weave hosts`: the person's Hosts that joined the Dispatcher (ADR 0030, WVE-194), which it
//! starts work on as a service over the connection each keeps open to it: listing them, having
//! one join, and removing one.
//!
//! `weave hosts add` has this computer's Host join: it asks the Dispatcher for a code
//! (`hosts/offer`) and hands it to the Host (`dispatcher/join`), with the Dispatcher's socket as
//! the address when the Dispatcher runs here. `weave hosts add studio` does the same for studio's
//! Host over SSH ([`crate::ssh`]), running `weave hosts add <url> <code>` there, which joins the
//! Host of the computer it runs on with a code shown elsewhere, as `weave hosts add --code`
//! shows one for a computer SSH doesn't reach. `weave dispatcher connect` offers the first
//! ([`join_from`]).

use std::process::ExitCode;

use anyhow::Context as _;
use anyhow::bail;
use clap::Args;
use clap::Subcommand;
use weave_dispatcher::DispatcherPaths;
use weave_dispatcher::client::DispatcherConnection;
use weave_dispatcher::computer_name;
use weave_host_client::HostConnection;
use weave_host_protocol::dispatcher::DispatcherAddress;
use weave_host_protocol::dispatcher::DispatcherHost;
use weave_host_protocol::dispatcher::JoinDispatcherRequest;
use weave_host_protocol::dispatcher::JoinDispatcherResponse;
use weave_host_protocol::dispatcher::JoinedDispatcher;
use weave_host_protocol::dispatcher::ListHostsRequest;
use weave_host_protocol::dispatcher::OfferHostRequest;
use weave_host_protocol::dispatcher::OfferHostResponse;
use weave_host_protocol::dispatcher::Reachability;
use weave_host_protocol::dispatcher::RemoveHostRequest;

use crate::clock::ago;
use crate::clock::now_ms;
use crate::dispatcher;
use crate::dispatcher::connect;
use crate::host;
use crate::ssh::JOIN;
use crate::ssh::Reach;
use crate::ssh::reach_for;
use crate::ssh::ssh;
use crate::ssh::ssh_name;

pub const LOG: &str = "warn";

#[derive(Args)]
pub struct HostsArgs {
    #[command(subcommand)]
    command: Option<HostsCommand>,
}

#[derive(Subcommand)]
enum HostsCommand {
    /// The Hosts that joined the Dispatcher, and whether each is connected (the default).
    List(ListArgs),
    /// Have a Host join the Dispatcher, so it starts work there: this computer's, another's
    /// over SSH (`weave hosts add studio`), or, on the Host's computer, with the URL and code
    /// `weave hosts add --code` shows.
    Add(AddArgs),
    /// Remove a Host, and the work waiting for it. A Host connected now forgets the Dispatcher;
    /// one that isn't is refused when it next connects.
    Remove(RemoveArgs),
}

#[derive(Args, Default)]
struct ListArgs {
    /// Print them as JSON.
    #[arg(long)]
    json: bool,
}

#[derive(Args)]
struct AddArgs {
    /// The computer SSH reaches the Host on, or the Dispatcher's URL that `weave hosts add
    /// --code` shows; this computer's Host without one.
    host: Option<String>,
    /// The code `weave hosts add --code` shows, after the Dispatcher's URL.
    code: Option<String>,
    /// Show a URL and code that join a Host on a computer SSH doesn't reach, instead.
    #[arg(long = "code", id = "show_code", conflicts_with_all = ["host", "code", "name"])]
    show_code: bool,
    /// What the Dispatcher calls the Host; its computer's name by default.
    #[arg(long)]
    name: Option<String>,
    /// Print what the Host joined as JSON.
    #[arg(long)]
    json: bool,
}

#[derive(Args)]
struct RemoveArgs {
    /// The Host's id or name.
    host: String,
}

pub async fn command(args: HostsArgs) -> anyhow::Result<ExitCode> {
    let done = match args
        .command
        .unwrap_or_else(|| HostsCommand::List(ListArgs::default()))
    {
        HostsCommand::List(ListArgs { json }) => list(&dispatcher::paths()?, json).await,
        HostsCommand::Add(args) => add(args).await,
        HostsCommand::Remove(args) => remove(&dispatcher::paths()?, args).await,
    };
    done.map(|()| ExitCode::SUCCESS)
}

async fn add(args: AddArgs) -> anyhow::Result<()> {
    let AddArgs {
        host,
        code,
        show_code,
        name,
        json,
    } = args;
    if show_code {
        return show(json).await;
    }
    let (place, joined) = match host {
        None => {
            let reached = dispatcher::reach(&dispatcher::paths()?).await?;
            let here = reached.paired.is_none();
            let joined = join_here(
                &reached.connection,
                name.unwrap_or_else(computer_name),
                here,
            )
            .await;
            reached.connection.shutdown().await;
            ("This computer".to_owned(), joined?)
        }
        Some(host) => match reach_for(&JOIN, &host, code)? {
            Reach::Code { url, code } => {
                let joined = join_local(DispatcherAddress::Url(url), code, name).await?;
                ("This computer".to_owned(), joined)
            }
            Reach::Ssh(destination) => {
                let name = name.unwrap_or_else(|| ssh_name(&destination));
                let joined = join_over_ssh(&destination, &name).await?;
                (destination, joined)
            }
        },
    };
    if json {
        println!("{}", serde_json::to_string_pretty(&joined)?);
    } else {
        println!(
            "{place}'s Host joined the {} as {}: it starts work there.",
            joined.name, joined.host_name
        );
    }
    Ok(())
}

/// `weave hosts add --code`: a URL and code that join a Host elsewhere.
async fn show(json: bool) -> anyhow::Result<()> {
    let dispatcher = connect(&dispatcher::paths()?).await?;
    let offer = dispatcher.send(OfferHostRequest { here: false }).await;
    dispatcher.shutdown().await;
    let offer = offer?;
    let DispatcherAddress::Url(url) = &offer.address else {
        bail!("the Dispatcher gave no URL for a Host on another computer to join at");
    };
    if json {
        println!("{}", serde_json::to_string_pretty(&offer)?);
    } else {
        let minutes = offer.expires_at.saturating_sub(now_ms()).div_ceil(60_000);
        println!(
            "On the computer whose Host should join, within {minutes} minutes:\n\n    weave \
             hosts add {url} {}",
            offer.code
        );
    }
    Ok(())
}

/// Have studio's Host join, over SSH: a code for a Host elsewhere, which `weave hosts add <url>
/// <code>` there takes.
async fn join_over_ssh(destination: &str, name: &str) -> anyhow::Result<JoinedDispatcher> {
    let dispatcher = connect(&dispatcher::paths()?).await?;
    let offer = dispatcher.send(OfferHostRequest { here: false }).await;
    dispatcher.shutdown().await;
    let OfferHostResponse { code, address, .. } = offer?;
    let DispatcherAddress::Url(url) = address else {
        bail!("the Dispatcher gave no URL for a Host on another computer to join at");
    };
    let said = ssh(
        destination,
        &["hosts", "add", &url, &code, "--name", name, "--json"],
    )
    .context("having its Host join")?;
    serde_json::from_str(&said).context("reading what `weave hosts add --json` said there")
}

/// Have this computer's Host join the Dispatcher at `address` with `code`, as `name`.
async fn join_local(
    address: DispatcherAddress,
    code: String,
    name: Option<String>,
) -> anyhow::Result<JoinedDispatcher> {
    let here = running_host().await?;
    let joined = here
        .send(JoinDispatcherRequest {
            address,
            code,
            name: Some(name.unwrap_or_else(computer_name)),
        })
        .await;
    here.shutdown().await;
    Ok(joined
        .map_err(|error| anyhow::anyhow!("{}", error.message))?
        .dispatcher)
}

/// This computer's Host, to have it join.
async fn running_host() -> anyhow::Result<HostConnection> {
    match host::control(&host::paths()?).await? {
        Some(here) => Ok(here),
        None => bail!(
            "no weave Host runs here to join the Dispatcher; `weave daemon install` keeps one \
             running"
        ),
    }
}

/// Have this computer's Host join `dispatcher`, as `name`. `here`: the Dispatcher runs on this
/// computer, so the Host joins over its socket.
pub(crate) async fn join_here(
    dispatcher: &DispatcherConnection,
    name: String,
    here: bool,
) -> anyhow::Result<JoinedDispatcher> {
    let host = running_host().await?;
    let joined = join_from(dispatcher, &host, name, here).await;
    host.shutdown().await;
    joined
}

/// Have the Host `host` is connected to join `dispatcher`, as `name`, with a code from it.
pub(crate) async fn join_from(
    dispatcher: &DispatcherConnection,
    host: &HostConnection,
    name: String,
    here: bool,
) -> anyhow::Result<JoinedDispatcher> {
    let offer = dispatcher.send(OfferHostRequest { here }).await?;
    let JoinDispatcherResponse { dispatcher: joined } = host
        .send(JoinDispatcherRequest {
            address: offer.address,
            code: offer.code,
            name: Some(name),
        })
        .await
        .map_err(|error| anyhow::anyhow!("{}", error.message))?;
    Ok(joined)
}

/// The Hosts that joined the Dispatcher, and how each stands.
async fn list(paths: &DispatcherPaths, json: bool) -> anyhow::Result<()> {
    let dispatcher = connect(paths).await?;
    let hosts = dispatcher.send(ListHostsRequest {}).await?.hosts;
    dispatcher.shutdown().await;
    if json {
        println!("{}", serde_json::to_string_pretty(&hosts)?);
    } else {
        print!("{}", describe(&hosts, now_ms()));
    }
    Ok(())
}

/// Remove a Host, and the work waiting for it.
async fn remove(paths: &DispatcherPaths, args: RemoveArgs) -> anyhow::Result<()> {
    let dispatcher = connect(paths).await?;
    let removed = dispatcher
        .send(RemoveHostRequest {
            host: args.host.clone(),
        })
        .await;
    dispatcher.shutdown().await;
    removed?;
    println!(
        "Removed {} from the Dispatcher. If it's connected, it forgets the Dispatcher now; if \
         not, the Dispatcher refuses it when it next connects. `weave hosts add` there joins it \
         again.",
        args.host
    );
    Ok(())
}

pub(crate) fn describe(hosts: &[DispatcherHost], now_ms: u64) -> String {
    if hosts.is_empty() {
        return "No Hosts have joined the Dispatcher; `weave hosts add` joins this computer's, \
                and `weave hosts add <computer>` another's over SSH.\n"
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
                (false, Reachability::Unchecked) => {
                    "hasn't connected since the Dispatcher started".to_owned()
                }
                (false, Reachability::Unjoined) => {
                    "paired before Hosts joined the Dispatcher: `weave hosts add` there joins it"
                        .to_owned()
                }
                (false, Reachability::Refused) => {
                    format!("{why}: `weave hosts add` there joins it again")
                }
                (false, _) => match host.connected_at {
                    Some(at) => format!("not connected since {} ago: {why}", ago(now_ms, at)),
                    None => format!("not connected: {why}"),
                },
            };
            let pending = match host.pending {
                0 => String::new(),
                1 => ", 1 piece of work waiting".to_owned(),
                pending => format!(", {pending} pieces of work waiting"),
            };
            let place = if host.here { "  here" } else { "" };
            format!(
                "{}  {:width$}{place}  {state}{pending}\n",
                host.host_id, host.name
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    #[test]
    fn hosts_are_listed_with_how_each_stands() {
        let host = |id: &str, connected, status, why: Option<&str>, pending| DispatcherHost {
            host_id: id.to_owned(),
            name: "studio".to_owned(),
            url: String::new(),
            device_id: "D-1".to_owned(),
            paired_at: 0,
            joined_at: Some(0),
            here: false,
            connected,
            status,
            why: why.map(str::to_owned),
            connected_at: (status != Reachability::Unchecked).then_some(1000),
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
                        Some("it left the Dispatcher"),
                        2
                    ),
                    host(
                        "h3",
                        false,
                        Reachability::Unreachable,
                        Some("its connection closed; it connects again when it can"),
                        0
                    ),
                    host("h4", false, Reachability::Unchecked, None, 0),
                    host("h5", false, Reachability::Unjoined, None, 0),
                ],
                61_000
            ),
            "h1  studio  connected for 1m\n\
             h2  studio  it left the Dispatcher: `weave hosts add` there joins it again, 2 pieces \
             of work waiting\n\
             h3  studio  not connected since 1m ago: its connection closed; it connects again \
             when it can\n\
             h4  studio  hasn't connected since the Dispatcher started\n\
             h5  studio  paired before Hosts joined the Dispatcher: `weave hosts add` there joins \
             it\n"
        );
        assert!(describe(&[], 0).starts_with("No Hosts have joined the Dispatcher"));
    }
}
