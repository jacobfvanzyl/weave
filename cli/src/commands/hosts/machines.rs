//! `weave hosts launch`, `machines` and `destroy` (WVE-238, a spike behind the `machines`
//! feature): a Host on a machine made in the cloud, from nothing to joined, and gone again.
//!
//! The launch runs here, in the CLI, against the Dispatcher's existing API (`hosts/offer` and
//! `hosts/list`), through the seams in `weave_dispatcher::machines`; the Dispatcher's own
//! process isn't changed. So the CLI reads the provider's token and the Tailscale key, from the
//! environment:
//!
//! | Variable | Holds |
//! | --- | --- |
//! | `FLY_API_TOKEN` | A Fly API token |
//! | `WEAVE_FLY_APP` | The Fly app that holds the machines, made if it isn't there |
//! | `WEAVE_FLY_ORG` | The Fly organisation a new app goes in; `personal` by default |
//! | `WEAVE_FLY_REGION` | Where machines are made; `jnb` by default |
//! | `WEAVE_HOST_IMAGE` | The image a machine boots (`scripts/host-image`) |
//! | `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_CLIENT_SECRET` | A Tailscale OAuth client that may make auth keys for the tag, with which each launch mints a key of its own |
//! | `WEAVE_TS_TAG` | The tag those keys give their nodes; `tag:weave-host` by default |
//! | `TS_AUTHKEY` | A key to use as it is, in place of minting one |

use std::time::Duration;

use anyhow::Context as _;
use anyhow::anyhow;
use clap::Args;
use weave_dispatcher::DispatcherPaths;
use weave_dispatcher::machines::Launch;
use weave_dispatcher::machines::Machines;
use weave_dispatcher::machines::fly::Fly;
use weave_dispatcher::machines::fly::FlyConfig;
use weave_dispatcher::machines::launch;
use weave_dispatcher::machines::tailscale::TailscaleClient;
use weave_host_protocol::dispatcher::RemoveHostRequest;

use crate::dispatcher::connect;

#[derive(Args)]
pub(super) struct LaunchArgs {
    /// What the Dispatcher calls the Host, and the provider the machine.
    #[arg(long)]
    name: String,
    /// The image the machine boots; `$WEAVE_HOST_IMAGE` without one.
    #[arg(long)]
    image: Option<String>,
    /// Its memory, in megabytes.
    #[arg(long, default_value_t = 1024)]
    memory: u32,
    #[arg(long, default_value_t = 1)]
    cpus: u32,
    /// The size of the disk the Host keeps its state on, in gigabytes.
    #[arg(long, default_value_t = 1)]
    disk: u32,
    /// How long to wait for the Host to join, in seconds, before destroying the machine.
    #[arg(long, default_value_t = 240)]
    wait: u64,
}

#[derive(Args)]
pub(super) struct DestroyArgs {
    /// The machine's name or id, as `weave hosts machines` lists them.
    machine: String,
}

fn variable(name: &str) -> anyhow::Result<String> {
    std::env::var(name)
        .ok()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!("${name} isn't set"))
}

fn fly() -> anyhow::Result<Fly> {
    let mut config = FlyConfig::new(variable("FLY_API_TOKEN")?, variable("WEAVE_FLY_APP")?);
    if let Ok(org) = variable("WEAVE_FLY_ORG") {
        config.org = org;
    }
    if let Ok(region) = variable("WEAVE_FLY_REGION") {
        config.region = region;
    }
    Ok(Fly::new(config)?)
}

/// The key the machine joins the tailnet with: one given, or one minted for it, or none when
/// the Dispatcher isn't reached over a tailnet.
async fn tailscale_key(name: &str) -> anyhow::Result<Option<String>> {
    if let Ok(key) = variable("TS_AUTHKEY") {
        return Ok(Some(key));
    }
    let (Ok(id), Ok(secret)) = (
        variable("TS_OAUTH_CLIENT_ID"),
        variable("TS_OAUTH_CLIENT_SECRET"),
    ) else {
        return Ok(None);
    };
    let mut client = TailscaleClient::new(id, secret);
    if let Ok(tag) = variable("WEAVE_TS_TAG") {
        client.tag = tag;
    }
    Ok(Some(client.mint_key(&format!("weave host {name}")).await?))
}

pub(super) async fn launch_host(paths: &DispatcherPaths, args: LaunchArgs) -> anyhow::Result<()> {
    let image = match args.image {
        Some(image) => image,
        None => variable("WEAVE_HOST_IMAGE").context("no --image")?,
    };
    let fly = fly()?;
    let tailscale_key = tailscale_key(&args.name).await?;
    let dispatcher = connect(paths).await?;
    let launched = launch(
        &dispatcher,
        &fly,
        Launch {
            tailscale_key,
            cpus: args.cpus,
            memory_mb: args.memory,
            state_gb: args.disk,
            wait: Duration::from_secs(args.wait),
            ..Launch::new(args.name, image)
        },
    )
    .await;
    dispatcher.shutdown().await;
    let launched = launched?;
    println!(
        "{} joined the Dispatcher from machine {} in {} seconds: it starts work there.",
        launched.host.name,
        launched.machine.id,
        launched.took.as_secs()
    );
    Ok(())
}

pub(super) async fn list_machines() -> anyhow::Result<()> {
    let machines = fly()?.list().await?;
    if machines.is_empty() {
        println!("No machines; `weave hosts launch --name <name>` makes one.");
    }
    for machine in machines {
        println!("{}  {}  {}", machine.id, machine.name, machine.state);
    }
    Ok(())
}

/// Destroy a machine and its disk, and remove the Host of its name from the Dispatcher.
pub(super) async fn destroy_machine(
    paths: &DispatcherPaths,
    args: DestroyArgs,
) -> anyhow::Result<()> {
    let fly = fly()?;
    let machine = fly
        .list()
        .await?
        .into_iter()
        .find(|machine| machine.id == args.machine || machine.name == args.machine)
        .ok_or_else(|| anyhow!("no machine {} that weave made", args.machine))?;
    fly.destroy(&machine.id).await?;
    println!("Destroyed machine {} ({}).", machine.name, machine.id);
    let dispatcher = connect(paths).await?;
    let removed = dispatcher
        .send(RemoveHostRequest {
            host: machine.name.clone(),
        })
        .await;
    dispatcher.shutdown().await;
    match removed {
        Ok(_) => println!("Removed {} from the Dispatcher.", machine.name),
        Err(error) => println!(
            "The Dispatcher has no Host called {} to remove: {}",
            machine.name, error.message
        ),
    }
    Ok(())
}
