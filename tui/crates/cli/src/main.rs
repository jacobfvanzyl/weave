mod agent_args;
mod config;
mod smoke;
mod start;

use std::fs::File;
use std::path::PathBuf;
use std::sync::Mutex;

use anyhow::Context;
use clap::Args;
use clap::Parser;
use clap::Subcommand;
use tracing_subscriber::EnvFilter;

use crate::agent_args::AgentArgs;
use crate::start::SignedIn;
use crate::start::StartMode;

/// Terminal client for ACP agents.
#[derive(Parser)]
#[command(name = "weave", version, args_conflicts_with_subcommands = true)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,

    #[command(flatten)]
    agent: AgentArgs,

    #[command(flatten)]
    session: SessionArgs,

    /// Write diagnostics, including agent stderr, to this file.
    #[arg(long)]
    log_file: Option<PathBuf>,
}

#[derive(Args)]
struct SessionArgs {
    /// Reopen a session: by id, or choose one from a list when no id is given.
    #[arg(long, value_name = "SESSION_ID", num_args = 0..=1, conflicts_with = "continue_last")]
    resume: Option<Option<String>>,

    /// Reopen the most recent session in this directory.
    #[arg(long = "continue")]
    continue_last: bool,
}

#[derive(Subcommand)]
enum Command {
    /// Run one prompt headlessly and print every ACP event the agent sends.
    Smoke(smoke::SmokeArgs),
    /// Sign in to the agent with one of the methods it offers.
    Login(LoginArgs),
    /// Sign out of the agent, if it supports signing out.
    Logout(LogoutArgs),
}

#[derive(Args)]
struct LoginArgs {
    #[command(flatten)]
    agent: AgentArgs,

    /// The sign-in method's id; asked for when omitted.
    #[arg(long)]
    method: Option<String>,
}

#[derive(Args)]
struct LogoutArgs {
    #[command(flatten)]
    agent: AgentArgs,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Some(Command::Smoke(args)) => {
            log_to_stderr();
            smoke::run(args).await
        }
        Some(Command::Login(args)) => {
            log_to_stderr();
            login(args).await
        }
        Some(Command::Logout(args)) => {
            log_to_stderr();
            logout(args).await
        }
        None => {
            // The TUI owns the terminal, so diagnostics can only go to a file.
            if let Some(path) = &cli.log_file {
                let file = File::create(path)
                    .with_context(|| format!("creating log {}", path.display()))?;
                tracing_subscriber::fmt()
                    .with_env_filter(env_filter("info,agent_stderr=debug"))
                    .with_writer(Mutex::new(file))
                    .with_ansi(false)
                    .init();
            }
            run_tui(cli.agent, cli.session).await
        }
    }
}

/// Diagnostics (including agent stderr at `RUST_LOG=agent_stderr=debug`) go to stderr.
fn log_to_stderr() {
    tracing_subscriber::fmt()
        .with_env_filter(env_filter("warn"))
        .with_writer(std::io::stderr)
        .init();
}

fn env_filter(default: &str) -> EnvFilter {
    EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(default))
}

async fn run_tui(args: AgentArgs, session: SessionArgs) -> anyhow::Result<()> {
    let launch = args.launch()?;
    let mode = match (session.resume, session.continue_last) {
        (Some(Some(id)), _) => StartMode::Resume(id.into()),
        (Some(None), _) => StartMode::Pick,
        (None, true) => StartMode::Continue,
        (None, false) => StartMode::New,
    };
    eprintln!("Starting {}", launch.spec.display_command());
    let started = start::start(&launch, &mode).await?;
    let agent = started
        .connection
        .agent()
        .and_then(|agent| agent.agent_info.clone());
    let (agent_name, agent_version) = match agent {
        Some(info) => (info.title.unwrap_or(info.name), Some(info.version)),
        None => (launch.spec.command.clone(), None),
    };
    weave_tui::run(weave_tui::Session {
        connection: started.connection,
        events: started.events,
        agent_name,
        agent_version,
        setup: started.setup,
        opened: started.opened,
        notices: started.notices,
    })
    .await
}

async fn login(args: LoginArgs) -> anyhow::Result<()> {
    let launch = args.agent.launch()?;
    let (connection, _events) = start::connect(&launch).await?;
    let result = start::sign_in(&connection, &launch.spec, args.method.as_deref()).await;
    connection.shutdown().await;
    match result? {
        SignedIn::Ready => eprintln!("Signed in."),
        SignedIn::Reconnect => eprintln!("Signed in. The next session will use it."),
    }
    Ok(())
}

async fn logout(args: LogoutArgs) -> anyhow::Result<()> {
    let launch = args.agent.launch()?;
    let (connection, _events) = start::connect(&launch).await?;
    let result = connection.logout().await;
    connection.shutdown().await;
    result.context("logout")?;
    eprintln!("Signed out.");
    Ok(())
}
