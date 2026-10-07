mod agent_args;
mod smoke;

use std::fs::File;
use std::path::PathBuf;
use std::sync::Mutex;

use anyhow::Context;
use clap::Parser;
use clap::Subcommand;
use tracing_subscriber::EnvFilter;
use weave_acp_core::AgentConnection;
use weave_acp_core::schema::ErrorCode;

use crate::agent_args::AgentArgs;

/// Terminal client for ACP agents.
#[derive(Parser)]
#[command(name = "weave", version, args_conflicts_with_subcommands = true)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,

    #[command(flatten)]
    agent: AgentArgs,

    /// Write diagnostics, including agent stderr, to this file.
    #[arg(long)]
    log_file: Option<PathBuf>,
}

#[derive(Subcommand)]
enum Command {
    /// Run one prompt headlessly and print every ACP event the agent sends.
    Smoke(smoke::SmokeArgs),
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Some(Command::Smoke(args)) => {
            // stdout carries command output; diagnostics (including agent stderr at
            // `RUST_LOG=agent_stderr=debug`) go to stderr.
            tracing_subscriber::fmt()
                .with_env_filter(env_filter("warn"))
                .with_writer(std::io::stderr)
                .init();
            smoke::run(args).await
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
            run_tui(cli.agent).await
        }
    }
}

fn env_filter(default: &str) -> EnvFilter {
    EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(default))
}

async fn run_tui(args: AgentArgs) -> anyhow::Result<()> {
    let spec = args.spec()?;
    let cwd = args.cwd()?;
    let trace = args.trace()?;

    eprintln!("Starting {}", spec.display_command());
    let (connection, events) = AgentConnection::spawn(&spec, trace, args.client_options()).await?;
    let init = match connection.initialize().await {
        Ok(init) => init,
        Err(error) => {
            connection.shutdown().await;
            return Err(error.into());
        }
    };
    let session = match connection.new_session(cwd.clone()).await {
        Ok(session) => session,
        Err(error) => {
            connection.shutdown().await;
            if error.code == ErrorCode::AuthRequired {
                anyhow::bail!(
                    "the agent requires authentication ({error}); sign in with its own CLI first"
                );
            }
            return Err(error).context("session/new");
        }
    };

    let (agent_name, agent_version) = match init.agent_info {
        Some(info) => (info.title.unwrap_or(info.name), Some(info.version)),
        None => (spec.command.clone(), None),
    };
    weave_tui::run(weave_tui::Session {
        connection,
        events,
        session_id: session.session_id,
        agent_name,
        agent_version,
        modes: session.modes,
        config_options: session.config_options.unwrap_or_default(),
        cwd,
    })
    .await
}
