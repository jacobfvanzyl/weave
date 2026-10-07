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
use crate::config::AlternateScreen;
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

    /// Run inline instead of fullscreen: a viewport below the prompt, with history in the
    /// terminal's own scrollback. Also `alternate_screen = "never"` under `[tui]` in the config.
    #[arg(long)]
    no_alt_screen: bool,
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
            run_tui(cli.agent, cli.session, cli.no_alt_screen).await
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

async fn run_tui(args: AgentArgs, session: SessionArgs, no_alt_screen: bool) -> anyhow::Result<()> {
    let launch = args.launch()?;
    let screen = match (no_alt_screen, launch.config.tui.alternate_screen) {
        (true, _) | (false, AlternateScreen::Never) => weave_tui::ScreenMode::Inline,
        (false, AlternateScreen::Auto | AlternateScreen::Always) => {
            weave_tui::ScreenMode::Fullscreen
        }
    };
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
    let (status_line, unknown) = status_line_items(&launch.config);
    let mut notices = started.notices;
    if !unknown.is_empty() {
        notices.push(format!(
            "Unknown status line items {}; expected some of {}",
            unknown.join(", "),
            weave_tui::StatusItem::names().join(", ")
        ));
    }
    let exit = weave_tui::run(
        weave_tui::Session {
            connection: started.connection,
            events: started.events,
            agent_name,
            agent_version,
            setup: started.setup,
            opened: started.opened,
            notices,
        },
        weave_tui::UiOptions {
            screen,
            status_line,
        },
    )
    .await?;
    // Fullscreen leaves nothing behind in the terminal, so say how to get back, as Codex does.
    if let Some(session_id) = exit.resumable_session {
        let command = resume_command(std::env::args().skip(1), &session_id.to_string());
        println!("To continue this session, run: {command}");
    }
    Ok(())
}

/// The configured status line items, and any names that aren't items.
fn status_line_items(config: &config::Config) -> (Vec<weave_tui::StatusItem>, Vec<String>) {
    let Some(names) = &config.tui.status_line else {
        return (weave_tui::StatusItem::DEFAULT.to_vec(), Vec::new());
    };
    let mut items = Vec::new();
    let mut unknown = Vec::new();
    for name in names {
        match weave_tui::StatusItem::parse(name) {
            Some(item) => items.push(item),
            None => unknown.push(name.clone()),
        }
    }
    (items, unknown)
}

/// This invocation's command line, reopening `session_id` in place of any session choice.
fn resume_command(args: impl IntoIterator<Item = String>, session_id: &str) -> String {
    let mut words = vec!["weave".to_owned()];
    let mut agent_command = Vec::new();
    let mut args = args.into_iter().peekable();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--" => {
                agent_command.push(arg);
                agent_command.extend(args.by_ref());
            }
            "--continue" => {}
            // The optional id is the next word, unless that is another option.
            "--resume" => {
                args.next_if(|next| !next.starts_with('-'));
            }
            _ if arg.starts_with("--resume=") => {}
            _ => words.push(arg),
        }
    }
    words.extend(["--resume".to_owned(), session_id.to_owned()]);
    words.extend(agent_command);
    words
        .iter()
        .map(|word| shell_quote(word))
        .collect::<Vec<_>>()
        .join(" ")
}

fn shell_quote(word: &str) -> String {
    let plain = !word.is_empty()
        && word
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_./:=@%+,".contains(c));
    if plain {
        word.to_owned()
    } else {
        format!("'{}'", word.replace('\'', "'\\''"))
    }
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

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    fn words(line: &str) -> Vec<String> {
        line.split(' ').map(str::to_owned).collect()
    }

    #[test]
    fn the_resume_command_replaces_the_session_choice() {
        assert_eq!(
            resume_command(words("--agent claude --continue"), "s1"),
            "weave --agent claude --resume s1"
        );
        assert_eq!(
            resume_command(words("--resume old --no-fs"), "s1"),
            "weave --no-fs --resume s1"
        );
        assert_eq!(
            resume_command(words("--resume --cwd /tmp/repo"), "s1"),
            "weave --cwd /tmp/repo --resume s1"
        );
        assert_eq!(
            resume_command(words("--resume=old -- ./agent --acp"), "s1"),
            "weave --resume s1 -- ./agent --acp"
        );
        let quoted = resume_command(vec!["--cwd".into(), "it's here".into()], "s1");
        assert_eq!(quoted, "weave --cwd 'it'\\''s here' --resume s1");
    }
}
