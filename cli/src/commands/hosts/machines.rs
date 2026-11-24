//! `weave hosts launch`, `machines` (and `machines config`), and `destroy` (ADR 0036, WVE-238,
//! WVE-239): cloud machines managed by the Dispatcher using provider tokens stored in
//! `weave credentials`. No provider secrets live in the CLI's environment.

use clap::Args;
use clap::Subcommand;
use weave_dispatcher::DispatcherPaths;
use weave_dispatcher::machines::DEFAULT_FLY_CREDENTIAL;
use weave_dispatcher::machines::DEFAULT_FLY_ORG;
use weave_dispatcher::machines::DEFAULT_FLY_REGION;
use weave_dispatcher::machines::DEFAULT_TAILSCALE_CREDENTIAL;
use weave_dispatcher::machines::tailscale::DEFAULT_TAG;
use weave_host_protocol::dispatcher::DestroyMachineRequest;
use weave_host_protocol::dispatcher::GetMachineSettingsRequest;
use weave_host_protocol::dispatcher::LaunchMachineRequest;
use weave_host_protocol::dispatcher::ListMachinesRequest;
use weave_host_protocol::dispatcher::MACHINES_FEATURE;
use weave_host_protocol::dispatcher::MachineSettings;
use weave_host_protocol::dispatcher::UpdateMachineRequest;
use weave_host_protocol::dispatcher::UpdateMachineSettingsRequest;

use crate::dispatcher::connect;
use crate::dispatcher::require;

#[derive(Args)]
pub(super) struct LaunchArgs {
    /// What the Dispatcher calls the Host, and the provider the machine.
    #[arg(long)]
    name: String,
    /// The image the machine boots; uses the Dispatcher's configured default without one.
    #[arg(long)]
    image: Option<String>,
    /// Its memory, in megabytes.
    #[arg(long, default_value_t = 1024)]
    memory: u32,
    #[arg(long, default_value_t = 1)]
    cpus: u32,
    /// The size of the disk the Host keeps its state on, in gigabytes.
    #[arg(long, default_value_t = 5)]
    disk: u32,
    /// How long to wait for the Host to join, in seconds, before destroying the machine.
    #[arg(long, default_value_t = 240)]
    wait: u64,
    /// Print what the Dispatcher answered as JSON.
    #[arg(long)]
    json: bool,
}

#[derive(Args)]
pub(super) struct MachinesArgs {
    #[command(subcommand)]
    command: Option<MachinesCommand>,
    /// Print the machines as JSON.
    #[arg(long)]
    json: bool,
}

#[derive(Subcommand)]
enum MachinesCommand {
    /// Show or update the Dispatcher's non-secret cloud machine settings (Fly app/region/org,
    /// default image, Tailscale OAuth client ID/tag, and credential names). Secrets stay in
    /// `weave credentials`.
    Config(ConfigArgs),
    /// Update one or all running cloud machines to a new image in place, keeping their volume,
    /// Host identity, and Tailscale state.
    Update(UpdateArgs),
}

#[derive(Args)]
struct UpdateArgs {
    /// The machine's name or id, as `weave hosts machines` lists them.
    #[arg(required_unless_present = "all", conflicts_with = "all")]
    machine: Option<String>,
    /// Update every cloud machine weave made.
    #[arg(long)]
    all: bool,
    /// The image to roll onto; uses the Dispatcher's configured default without one.
    #[arg(long)]
    image: Option<String>,
    /// How long to wait for each Host to reconnect, in seconds.
    #[arg(long, default_value_t = 240)]
    wait: u64,
    /// Print what the Dispatcher answered as JSON.
    #[arg(long)]
    json: bool,
}

#[derive(Args)]
struct ConfigArgs {
    /// The Fly app that holds the machines, made in `--fly-org` if absent.
    #[arg(long)]
    fly_app: Option<String>,
    /// The Fly organisation a new app goes in (`personal` by default).
    #[arg(long)]
    fly_org: Option<String>,
    /// Where Fly machines are made (`jnb` by default).
    #[arg(long)]
    fly_region: Option<String>,
    /// Name of the `token` credential in `weave credentials` holding the Fly API token (`fly`
    /// by default).
    #[arg(long)]
    fly_credential: Option<String>,
    /// Default container image launched machines boot.
    #[arg(long)]
    image: Option<String>,
    /// Tailscale OAuth client ID (non-secret), paired with `--tailscale-credential` to mint
    /// single-use ephemeral keys.
    #[arg(long, conflicts_with = "clear_tailscale_client_id")]
    tailscale_client_id: Option<String>,
    /// Stop minting Tailscale auth keys on launch.
    #[arg(long)]
    clear_tailscale_client_id: bool,
    /// Name of the `token` credential in `weave credentials` holding the Tailscale OAuth
    /// client secret (`tailscale` by default).
    #[arg(long)]
    tailscale_credential: Option<String>,
    /// The tag minted Tailscale keys give their nodes (`tag:weave-host` by default).
    #[arg(long)]
    tailscale_tag: Option<String>,
    /// Print the settings as JSON.
    #[arg(long)]
    json: bool,
}

impl ConfigArgs {
    fn has_changes(&self) -> bool {
        self.fly_app.is_some()
            || self.fly_org.is_some()
            || self.fly_region.is_some()
            || self.fly_credential.is_some()
            || self.image.is_some()
            || self.tailscale_client_id.is_some()
            || self.clear_tailscale_client_id
            || self.tailscale_credential.is_some()
            || self.tailscale_tag.is_some()
    }
}

#[derive(Args)]
pub(super) struct DestroyArgs {
    /// The machine's name or id, as `weave hosts machines` lists them.
    machine: String,
    /// Print what the Dispatcher answered as JSON.
    #[arg(long)]
    json: bool,
}

fn said(error: agent_client_protocol::Error) -> anyhow::Error {
    anyhow::anyhow!("{}", error.message)
}

pub(super) async fn launch_host(paths: &DispatcherPaths, args: LaunchArgs) -> anyhow::Result<()> {
    let json = args.json;
    let dispatcher = connect(paths).await?;
    let launched = async {
        require(&dispatcher, MACHINES_FEATURE, "cloud machines")?;
        dispatcher
            .send(LaunchMachineRequest {
                name: args.name,
                image: args.image,
                cpus: Some(args.cpus),
                memory_mb: Some(args.memory),
                state_gb: Some(args.disk),
                wait_secs: Some(args.wait),
            })
            .await
            .map_err(said)
    }
    .await;
    dispatcher.shutdown().await;
    let launched = launched?;
    if json {
        println!("{}", serde_json::to_string_pretty(&launched)?);
    } else {
        println!(
            "{} joined the Dispatcher from machine {} in {} seconds: it starts work there.",
            launched.host.name,
            launched.machine.id,
            launched.took_ms / 1000
        );
    }
    Ok(())
}

pub(super) async fn machines(paths: &DispatcherPaths, args: MachinesArgs) -> anyhow::Result<()> {
    match args.command {
        Some(MachinesCommand::Config(config)) => configure(paths, config).await,
        Some(MachinesCommand::Update(update)) => update_machines(paths, update).await,
        None => list_machines(paths, args.json).await,
    }
}

async fn update_machines(paths: &DispatcherPaths, args: UpdateArgs) -> anyhow::Result<()> {
    let json = args.json;
    let dispatcher = connect(paths).await?;
    let outcome = async {
        require(&dispatcher, MACHINES_FEATURE, "cloud machines")?;
        let targets = if args.all {
            dispatcher
                .send(ListMachinesRequest {})
                .await
                .map_err(said)?
                .machines
                .into_iter()
                .map(|machine| machine.name)
                .collect::<Vec<_>>()
        } else {
            args.machine.into_iter().collect()
        };
        let mut updated = Vec::with_capacity(targets.len());
        for target in targets {
            let response = dispatcher
                .send(UpdateMachineRequest {
                    machine: target,
                    image: args.image.clone(),
                    wait_secs: Some(args.wait),
                })
                .await
                .map_err(said)?;
            updated.push(response);
        }
        Ok::<_, anyhow::Error>(updated)
    }
    .await;
    dispatcher.shutdown().await;
    let updated = outcome?;
    if json {
        if args.all {
            println!("{}", serde_json::to_string_pretty(&updated)?);
        } else if let Some(one) = updated.first() {
            println!("{}", serde_json::to_string_pretty(one)?);
        }
        return Ok(());
    }
    if updated.is_empty() {
        println!("No machines to update.");
        return Ok(());
    }
    for one in updated {
        let image = one
            .machine
            .image
            .as_deref()
            .map(|image| format!(" to {image}"))
            .unwrap_or_default();
        println!(
            "Updated {} ({}){} and reconnected in {} seconds.",
            one.host.name,
            one.machine.id,
            image,
            one.took_ms / 1000
        );
    }
    Ok(())
}

async fn list_machines(paths: &DispatcherPaths, json: bool) -> anyhow::Result<()> {
    let dispatcher = connect(paths).await?;
    let listed = async {
        require(&dispatcher, MACHINES_FEATURE, "cloud machines")?;
        dispatcher
            .send(ListMachinesRequest {})
            .await
            .map_err(said)
            .map(|response| response.machines)
    }
    .await;
    dispatcher.shutdown().await;
    let machines = listed?;
    if json {
        println!("{}", serde_json::to_string_pretty(&machines)?);
        return Ok(());
    }
    if machines.is_empty() {
        println!("No machines; `weave hosts launch --name <name>` makes one.");
    }
    for machine in machines {
        match machine.image.as_deref() {
            Some(image) => println!(
                "{}  {}  {}  {}",
                machine.id, machine.name, machine.state, image
            ),
            None => println!("{}  {}  {}", machine.id, machine.name, machine.state),
        }
    }
    Ok(())
}

async fn configure(paths: &DispatcherPaths, args: ConfigArgs) -> anyhow::Result<()> {
    let json = args.json;
    let dispatcher = connect(paths).await?;
    let settings = async {
        require(&dispatcher, MACHINES_FEATURE, "cloud machines")?;
        if args.has_changes() {
            let tailscale_client_id = if args.clear_tailscale_client_id {
                Some(None)
            } else {
                args.tailscale_client_id.map(Some)
            };
            dispatcher
                .send(UpdateMachineSettingsRequest {
                    fly_app: args.fly_app.map(Some),
                    fly_org: args.fly_org.map(Some),
                    fly_region: args.fly_region.map(Some),
                    fly_credential: args.fly_credential.map(Some),
                    image: args.image.map(Some),
                    tailscale_client_id,
                    tailscale_credential: args.tailscale_credential.map(Some),
                    tailscale_tag: args.tailscale_tag.map(Some),
                })
                .await
                .map_err(said)
                .map(|response| response.settings)
        } else {
            dispatcher
                .send(GetMachineSettingsRequest {})
                .await
                .map_err(said)
                .map(|response| response.settings)
        }
    }
    .await;
    dispatcher.shutdown().await;
    let settings = settings?;
    if json {
        println!("{}", serde_json::to_string_pretty(&settings)?);
    } else {
        print!("{}", describe_settings(&settings));
    }
    Ok(())
}

/// Destroy a machine and its disk, and remove the Host of its name from the Dispatcher.
pub(super) async fn destroy_machine(
    paths: &DispatcherPaths,
    args: DestroyArgs,
) -> anyhow::Result<()> {
    let json = args.json;
    let dispatcher = connect(paths).await?;
    let destroyed = async {
        require(&dispatcher, MACHINES_FEATURE, "cloud machines")?;
        dispatcher
            .send(DestroyMachineRequest {
                machine: args.machine,
            })
            .await
            .map_err(said)
    }
    .await;
    dispatcher.shutdown().await;
    let destroyed = destroyed?;
    if json {
        println!("{}", serde_json::to_string_pretty(&destroyed)?);
    } else {
        println!(
            "Destroyed machine {} ({}).",
            destroyed.machine.name, destroyed.machine.id
        );
        if destroyed.host_removed {
            println!("Removed {} from the Dispatcher.", destroyed.machine.name);
        } else {
            println!(
                "The Dispatcher had no Host called {} to remove.",
                destroyed.machine.name
            );
        }
    }
    Ok(())
}

fn describe_settings(settings: &MachineSettings) -> String {
    let fly_app = settings.fly_app.as_deref().unwrap_or("(unset)");
    let fly_org = settings.fly_org.as_deref().unwrap_or(DEFAULT_FLY_ORG);
    let fly_region = settings.fly_region.as_deref().unwrap_or(DEFAULT_FLY_REGION);
    let fly_credential = settings
        .fly_credential
        .as_deref()
        .unwrap_or(DEFAULT_FLY_CREDENTIAL);
    let image = settings.image.as_deref().unwrap_or("(unset)");
    let tailscale_client_id = settings
        .tailscale_client_id
        .as_deref()
        .unwrap_or("(unset; no tailnet key minted)");
    let tailscale_credential = settings
        .tailscale_credential
        .as_deref()
        .unwrap_or(DEFAULT_TAILSCALE_CREDENTIAL);
    let tailscale_tag = settings.tailscale_tag.as_deref().unwrap_or(DEFAULT_TAG);
    format!(
        "fly app              {fly_app}\n\
         fly org              {fly_org}\n\
         fly region           {fly_region}\n\
         fly credential       {fly_credential}\n\
         image                {image}\n\
         tailscale client id  {tailscale_client_id}\n\
         tailscale credential {tailscale_credential}\n\
         tailscale tag        {tailscale_tag}\n"
    )
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    #[test]
    fn settings_describe_defaults_and_configured_values() {
        let defaults = describe_settings(&MachineSettings::default());
        assert!(
            defaults.contains("fly app              (unset)\n"),
            "{defaults}"
        );
        assert!(
            defaults.contains("fly org              personal\n"),
            "{defaults}"
        );
        assert!(
            defaults.contains("fly region           jnb\n"),
            "{defaults}"
        );
        assert!(
            defaults.contains("fly credential       fly\n"),
            "{defaults}"
        );
        assert!(
            defaults.contains("tailscale credential tailscale\n"),
            "{defaults}"
        );
        assert!(
            defaults.contains("tailscale tag        tag:weave-host\n"),
            "{defaults}"
        );

        let configured = describe_settings(&MachineSettings {
            fly_app: Some("weave-hosts".to_owned()),
            fly_org: None,
            fly_region: Some("ams".to_owned()),
            fly_credential: Some("my-fly".to_owned()),
            image: Some("registry.fly.io/weave-hosts:latest".to_owned()),
            tailscale_client_id: Some("k123456CNTRL".to_owned()),
            tailscale_credential: None,
            tailscale_tag: None,
        });
        assert_eq!(
            configured,
            "fly app              weave-hosts\n\
             fly org              personal\n\
             fly region           ams\n\
             fly credential       my-fly\n\
             image                registry.fly.io/weave-hosts:latest\n\
             tailscale client id  k123456CNTRL\n\
             tailscale credential tailscale\n\
             tailscale tag        tag:weave-host\n"
        );
    }
}
