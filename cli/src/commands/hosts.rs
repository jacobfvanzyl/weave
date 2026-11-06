//! The Hosts the Dispatcher is paired with (ADR 0027, WVE-175), which it starts work on as a
//! service: pairing it with one, listing them, and forgetting one.
//!
//! Adding `studio` pairs the Dispatcher with studio's Host over SSH ([`crate::ssh`]): it runs
//! `weave pair --json` there for a code. Given the URL and code `weave pair` showed there
//! instead, it pairs with those.

use anyhow::Context as _;
use clap::Args;
use weave_dispatcher::DispatcherPaths;
use weave_host_protocol::dispatcher::AddHostRequest;
use weave_host_protocol::dispatcher::DispatcherHost;
use weave_host_protocol::dispatcher::ListHostsRequest;
use weave_host_protocol::dispatcher::Reachability;
use weave_host_protocol::dispatcher::RemoveHostRequest;

use crate::clock::ago;
use crate::clock::now_ms;
use crate::commands::devices::Offered;
use crate::dispatcher::connect;
use crate::ssh::Reach;
use crate::ssh::reach;
use crate::ssh::ssh;
use crate::ssh::ssh_name;

#[derive(Args)]
pub struct AddArgs {
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
pub struct RemoveArgs {
    /// The Host's id or name.
    host: String,
}

pub(crate) async fn add(paths: &DispatcherPaths, args: AddArgs) -> anyhow::Result<()> {
    let AddArgs {
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

/// The Hosts the Dispatcher is paired with, and how it reaches each.
pub(crate) async fn list(paths: &DispatcherPaths, json: bool) -> anyhow::Result<()> {
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
pub(crate) async fn remove(paths: &DispatcherPaths, args: RemoveArgs) -> anyhow::Result<()> {
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
