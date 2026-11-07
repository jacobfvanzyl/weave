//! `weave hosts`: the person's Hosts the Dispatcher is paired with (ADR 0027, WVE-175), which it
//! starts work on as a service: listing them, pairing it with one, and forgetting one.
//!
//! `weave hosts add studio` pairs the Dispatcher with studio's Host over SSH ([`crate::ssh`]): it
//! runs `weave pair --json` there for a code. Given the URL and code `weave pair` showed there
//! instead, it pairs with those; given neither, with this computer's Host, which it asks for a
//! code itself ([`add_here`]), as `weave dispatcher connect` offers to.

use std::process::ExitCode;

use anyhow::Context as _;
use anyhow::bail;
use clap::Args;
use clap::Subcommand;
use weave_dispatcher::DispatcherPaths;
use weave_dispatcher::client::DispatcherConnection;
use weave_dispatcher::computer_name;
use weave_host_client::HostConnection;
use weave_host_protocol::devices::OfferDeviceRequest;
use weave_host_protocol::dispatcher::AddHostRequest;
use weave_host_protocol::dispatcher::DispatcherHost;
use weave_host_protocol::dispatcher::ListHostsRequest;
use weave_host_protocol::dispatcher::Reachability;
use weave_host_protocol::dispatcher::RemoveHostRequest;
use weave_host_protocol::errors;

use crate::clock::ago;
use crate::clock::now_ms;
use crate::commands::devices::Offered;
use crate::dispatcher;
use crate::dispatcher::connect;
use crate::host;
use crate::ssh::Reach;
use crate::ssh::reach;
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
    /// The Hosts the Dispatcher is paired with, and whether it's connected to each (the
    /// default).
    List(ListArgs),
    /// Pair the Dispatcher with a Host as a service: this computer's, or another's over SSH
    /// (`weave hosts add studio`) or with the URL and code `weave pair` shows there.
    Add(AddArgs),
    /// Forget a Host, and the work waiting for it. The Host lists the Dispatcher among its
    /// devices until you revoke it there with `weave devices revoke`.
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
    /// The computer SSH reaches the Host on, or the URL `weave pair` shows there; this
    /// computer's Host without one.
    host: Option<String>,
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
struct RemoveArgs {
    /// The Host's id or name.
    host: String,
}

pub async fn command(args: HostsArgs) -> anyhow::Result<ExitCode> {
    let paths = dispatcher::paths()?;
    let done = match args
        .command
        .unwrap_or_else(|| HostsCommand::List(ListArgs::default()))
    {
        HostsCommand::List(ListArgs { json }) => list(&paths, json).await,
        HostsCommand::Add(args) => add(&paths, args).await,
        HostsCommand::Remove(args) => remove(&paths, args).await,
    };
    done.map(|()| ExitCode::SUCCESS)
}

async fn add(paths: &DispatcherPaths, args: AddArgs) -> anyhow::Result<()> {
    let AddArgs {
        host,
        code,
        name,
        json,
    } = args;
    let dispatcher = connect(paths).await?;
    let added = match host {
        Some(host) => add_elsewhere(&dispatcher, &host, code, name).await,
        None => add_here(&dispatcher, name.unwrap_or_else(computer_name)).await,
    };
    dispatcher.shutdown().await;
    let host = added?;
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

/// Pair the Dispatcher with the Host `host` and `code` reach.
async fn add_elsewhere(
    dispatcher: &DispatcherConnection,
    host: &str,
    code: Option<String>,
    name: Option<String>,
) -> anyhow::Result<DispatcherHost> {
    let (url, code, name) = match reach(host, code)? {
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
    Ok(dispatcher
        .send(AddHostRequest { url, code, name })
        .await?
        .host)
}

/// Pair the Dispatcher with this computer's Host, as `name`, with a code it asks that Host for.
pub(crate) async fn add_here(
    dispatcher: &DispatcherConnection,
    name: String,
) -> anyhow::Result<DispatcherHost> {
    let Some(here) = host::control(&host::paths()?).await? else {
        bail!(
            "no weave Host runs here to pair the Dispatcher with; `weave daemon install` keeps \
             one running"
        );
    };
    let added = add_from(dispatcher, &here, name).await;
    here.shutdown().await;
    added
}

/// Pair the Dispatcher with the Host `here` is connected to, as `name`, with a code from it. The
/// offer turns that Host's remote access on, as `weave pair` does, for the Dispatcher to reach it.
pub(crate) async fn add_from(
    dispatcher: &DispatcherConnection,
    here: &HostConnection,
    name: String,
) -> anyhow::Result<DispatcherHost> {
    let offer = match here.send(OfferDeviceRequest { name: None }).await {
        Ok(offer) => offer,
        Err(error) if errors::is(&error, errors::REMOTE_UNAVAILABLE) => bail!("{}", error.message),
        Err(error) => return Err(error.into()),
    };
    let Some(url) = offer.url else {
        bail!(
            "the running weave Host is older than this weave and can't turn remote access on; \
             restart it with `weave daemon restart`"
        );
    };
    Ok(dispatcher
        .send(AddHostRequest {
            url,
            code: offer.code,
            name: Some(name),
        })
        .await?
        .host)
}

/// The Hosts the Dispatcher is paired with, and how it reaches each.
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

/// Forget a Host, and the work waiting for it.
async fn remove(paths: &DispatcherPaths, args: RemoveArgs) -> anyhow::Result<()> {
    let dispatcher = connect(paths).await?;
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

pub(crate) fn describe(hosts: &[DispatcherHost], now_ms: u64) -> String {
    if hosts.is_empty() {
        return "The Dispatcher pairs with no Hosts; `weave hosts add <computer>` pairs it with \
                one over SSH.\n"
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
