mod smoke;

use clap::Parser;
use clap::Subcommand;
use tracing_subscriber::EnvFilter;

/// Terminal client for ACP agents.
#[derive(Parser)]
#[command(name = "weave", version)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Run one prompt headlessly and print every ACP event the agent sends.
    Smoke(smoke::SmokeArgs),
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // stdout carries command output; diagnostics (including agent stderr at
    // `RUST_LOG=agent_stderr=debug`) go to stderr.
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("warn")),
        )
        .with_writer(std::io::stderr)
        .init();

    match Cli::parse().command {
        Command::Smoke(args) => smoke::run(args).await,
    }
}
