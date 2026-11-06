//! `weave agents`: the agents weave launches (`weave-agents`): which there are, moving them to
//! their newest releases ([`update`]), signing in to and out of one directly, and one headless
//! turn with one that prints every ACP event ([`smoke`]).

pub mod smoke;
pub mod update;

use std::path::PathBuf;
use std::process::ExitCode;

use anyhow::Context;
use clap::Args;
use clap::Subcommand;
use weave_agents::registry;

use crate::args::AgentArgs;
use crate::args::WorkspaceArgs;
use crate::config::Config;
use crate::start;
use crate::start::SignedIn;

pub const LOG: &str = "warn";

#[derive(Args)]
pub struct AgentsArgs {
    #[command(subcommand)]
    command: Option<AgentsCommand>,
}

#[derive(Subcommand)]
enum AgentsCommand {
    /// The agents `--agent` accepts: presets, the config's, and the ACP registry's (the
    /// default).
    List(ListArgs),
    /// Move the agents weave launches to their newest releases, after checking each starts.
    Update(update::UpdateArgs),
    /// Sign in to the agent with one of the methods it offers.
    Login(LoginArgs),
    /// Sign out of the agent, if it supports signing out.
    Logout(LogoutArgs),
    /// Run one prompt headlessly and print every ACP event the agent sends.
    Smoke(smoke::SmokeArgs),
}

pub async fn command(args: AgentsArgs) -> anyhow::Result<ExitCode> {
    match args
        .command
        .unwrap_or_else(|| AgentsCommand::List(ListArgs::default()))
    {
        AgentsCommand::List(args) => list(args).await,
        AgentsCommand::Update(args) => update::command(args).await,
        AgentsCommand::Login(args) => login(args).await,
        AgentsCommand::Logout(args) => logout(args).await,
        AgentsCommand::Smoke(args) => smoke::command(args).await,
    }
}

#[derive(Args, Default)]
struct ListArgs {
    /// Fetch the ACP registry again rather than use the copy cached within the last day.
    #[arg(long)]
    refresh: bool,

    /// Config file. Defaults to ~/.config/weave/config.toml.
    #[arg(long)]
    config: Option<PathBuf>,
}

#[derive(Args)]
pub struct LoginArgs {
    #[command(flatten)]
    agent: AgentArgs,

    /// The sign-in method's id; asked for when omitted.
    #[arg(long)]
    method: Option<String>,
}

#[derive(Args)]
pub struct LogoutArgs {
    #[command(flatten)]
    agent: AgentArgs,
}

/// Sign in to the agent directly, without the Host.
pub async fn login(args: LoginArgs) -> anyhow::Result<ExitCode> {
    let launch = args.agent.launch_here(&WorkspaceArgs::default()).await?;
    let (connection, _events) = start::connect_direct(&launch).await?;
    let result = start::sign_in(&connection, &launch.spec, args.method.as_deref()).await;
    connection.shutdown().await;
    match result? {
        SignedIn::Ready => eprintln!("Signed in."),
        SignedIn::Reconnect => eprintln!("Signed in. The next thread will use it."),
    }
    Ok(ExitCode::SUCCESS)
}

/// Sign out of the agent directly, without the Host.
pub async fn logout(args: LogoutArgs) -> anyhow::Result<ExitCode> {
    let launch = args.agent.launch_here(&WorkspaceArgs::default()).await?;
    let (connection, _events) = start::connect_direct(&launch).await?;
    let result = connection.logout().await;
    connection.shutdown().await;
    result.context("logout")?;
    eprintln!("Signed out.");
    Ok(ExitCode::SUCCESS)
}

/// The agents `--agent` accepts: presets and the config's, then the ACP registry's.
async fn list(args: ListArgs) -> anyhow::Result<ExitCode> {
    let config = Config::load(args.config.as_deref())?;
    if let Some(notice) = &config.notice {
        eprintln!("weave: {notice}");
    }
    let config = config.agents;
    let default = config.default_agent.as_deref();
    let marker = |id: &str| {
        if Some(id) == default {
            "  (default)"
        } else {
            ""
        }
    };
    let local: Vec<(String, String)> = config
        .known_agents()
        .into_iter()
        .filter_map(|id| {
            let spec = config.local_agent(&id)?;
            Some((id, spec.display_command()))
        })
        .collect();
    let width = local
        .iter()
        .map(|(id, _)| id.len())
        .max()
        .unwrap_or_default();
    println!("Presets and configured agents:");
    for (id, command) in &local {
        println!("  {id:width$}  {command}{}", marker(id));
    }

    let cache = registry::Cache::default_location()?;
    let loaded = registry::load(&cache, args.refresh).await?;
    if let Some(warning) = &loaded.warning {
        eprintln!("weave: {warning}");
    }
    let agents = &loaded.registry.agents;
    let platform = registry::platform();
    println!();
    println!(
        "ACP registry ({} agents, fetched {} ago):",
        agents.len(),
        registry::age(loaded.fetched)
    );
    let id_width = agents
        .iter()
        .map(|agent| agent.id.len())
        .max()
        .unwrap_or_default();
    let name_width = agents
        .iter()
        .map(|agent| agent.name.chars().count() + 1 + agent.version.len())
        .max()
        .unwrap_or_default();
    for agent in agents {
        let name = format!("{} {}", agent.name, agent.version);
        let how = agent
            .launcher(&platform)
            .map_or("-", registry::Launcher::kind);
        let note = if local.iter().any(|(id, _)| *id == agent.id) {
            "  (the preset or config agent of this name is used)".to_owned()
        } else if how == "-" {
            format!("  (no build for {platform})")
        } else {
            marker(&agent.id).to_owned()
        };
        println!(
            "  {:id_width$}  {name:name_width$}  {how:6}  {}{note}",
            agent.id,
            shorten(&agent.description, 60),
        );
    }
    println!();
    println!("Start one with: weave --agent <id>");
    Ok(ExitCode::SUCCESS)
}

/// `text` cut to `max` characters, with an ellipsis when cut.
fn shorten(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_owned();
    }
    let kept: String = text.chars().take(max.saturating_sub(1)).collect();
    format!("{}…", kept.trim_end())
}
