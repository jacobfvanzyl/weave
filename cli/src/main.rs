mod args;
mod clock;
mod commands;
mod config;
mod dispatcher;
mod exit;
mod host;
mod recent;
mod rex_threads;
mod service;
mod ssh;
mod start;
mod turn;

use std::fs::File;
use std::io::IsTerminal;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Mutex;

use anyhow::Context;
use clap::Parser;
use clap::Subcommand;
use tracing_subscriber::EnvFilter;
use weave_acp_core::schema::SessionId;

use crate::args::AgentArgs;
use crate::args::AgentChoice;
use crate::args::SessionArgs;
use crate::args::WorkspaceArgs;
use crate::commands::agents;
use crate::commands::daemon;
use crate::commands::devices;
use crate::commands::run;
use crate::commands::terminals;
use crate::commands::threads;
use crate::commands::worktrees;
use crate::config::AlternateScreen;
use crate::exit::Status;
use crate::host::Target;
use crate::recent::Recent;

/// Terminal client for ACP agents.
#[derive(Parser)]
#[command(name = "weave", version, args_conflicts_with_subcommands = true)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,

    #[command(flatten)]
    agent: AgentArgs,

    #[command(flatten)]
    workspace: WorkspaceArgs,

    #[command(flatten)]
    session: SessionArgs,

    /// Write diagnostics to this file (with --no-daemon, agent stderr too).
    #[arg(long)]
    log_file: Option<PathBuf>,

    /// Run inline instead of fullscreen: a viewport below the prompt, with history in the
    /// terminal's own scrollback. Also `alternate_screen = "never"` under `[tui]` in the config.
    #[arg(long)]
    no_alt_screen: bool,

    /// Run the agent in a Host inside this process rather than the shared weave Host, so its
    /// threads end when weave does. Also `enabled = false` under `[daemon]` in the config.
    #[arg(long)]
    no_daemon: bool,
}

#[derive(Subcommand)]
enum Command {
    /// Run one prompt in a headless thread in the weave Host, printing the reply.
    Run(run::RunArgs),
    /// Threads open in the weave Host: list, read, prompt or steer them, stop a turn, or close
    /// one.
    #[command(name = "threads", alias = "sessions")]
    Threads(threads::ThreadsArgs),
    /// Git worktrees: what worktrunk asks the weave Host before it removes one.
    Worktrees(worktrees::WorktreesArgs),
    /// The weave Host's terminals: show one here, as the TUI does in a Rex pane.
    #[command(name = "terminal")]
    Terminals(terminals::TerminalsArgs),
    /// Manage the weave Host, which runs agents so their threads outlive the TUI.
    Daemon(daemon::DaemonArgs),
    /// Pair another of your devices with the weave Host, to reach it over your tailnet.
    Pair(devices::PairArgs),
    /// Devices paired with the weave Host: list them, or revoke one.
    Devices(devices::DevicesArgs),
    /// The Dispatcher, which starts work on your Hosts while you're away: run or install it,
    /// and pair it with your Hosts.
    Dispatcher(commands::dispatcher::DispatcherArgs),
    /// Move the agents weave launches to their newest releases, after checking each starts.
    Update(agents::update::UpdateArgs),
    /// Run one prompt headlessly and print every ACP event the agent sends.
    Smoke(agents::smoke::SmokeArgs),
    /// Sign in to the agent with one of the methods it offers.
    Login(agents::LoginArgs),
    /// Sign out of the agent, if it supports signing out.
    Logout(agents::LogoutArgs),
    /// List the agents `--agent` accepts: presets, the config's, and the ACP registry's.
    Agents(agents::ListArgs),
    /// The weave Host's MCP server for an agent: relays MCP on stdio to the Host's MCP socket,
    /// which the environment names. The Host declares it to agents; it isn't for people.
    #[command(hide = true)]
    McpBridge,
}

#[tokio::main]
async fn main() -> ExitCode {
    match command(Cli::parse()).await {
        Ok(code) => code,
        Err(error) => {
            eprintln!("Error: {error:?}");
            Status::of_error(&error).into()
        }
    }
}

async fn command(mut cli: Cli) -> anyhow::Result<ExitCode> {
    let Some(command) = cli.command.take() else {
        return tui(cli).await;
    };
    match command {
        Command::Run(args) => logged(run::LOG, run::command(args)).await,
        Command::Threads(args) => logged(threads::LOG, threads::command(args)).await,
        Command::Worktrees(args) => logged(worktrees::LOG, worktrees::command(args)).await,
        Command::Terminals(args) => logged(terminals::LOG, terminals::command(args)).await,
        Command::Daemon(args) => logged(daemon::LOG, daemon::command(args)).await,
        Command::Pair(args) => logged(devices::LOG, devices::pair(args)).await,
        Command::Devices(args) => logged(devices::LOG, devices::command(args)).await,
        Command::Dispatcher(args) => {
            logged(
                commands::dispatcher::LOG,
                commands::dispatcher::command(args),
            )
            .await
        }
        Command::Update(args) => logged(agents::LOG, agents::update::command(args)).await,
        Command::Smoke(args) => logged(agents::LOG, agents::smoke::command(args)).await,
        Command::Login(args) => logged(agents::LOG, agents::login(args)).await,
        Command::Logout(args) => logged(agents::LOG, agents::logout(args)).await,
        Command::Agents(args) => logged(agents::LOG, agents::list(args)).await,
        // Stdout carries MCP; diagnostics go to stderr, the agent's to keep.
        Command::McpBridge => logged("warn", mcp_bridge()).await,
    }
}

/// A subcommand, with its diagnostics on stderr at `level` unless `RUST_LOG` says otherwise.
async fn logged(
    level: &str,
    command: impl Future<Output = anyhow::Result<ExitCode>>,
) -> anyhow::Result<ExitCode> {
    log_to_stderr(level);
    command.await
}

/// The TUI, which owns the terminal, so diagnostics can only go to a file.
async fn tui(cli: Cli) -> anyhow::Result<ExitCode> {
    if let Some(path) = &cli.log_file {
        let file =
            File::create(path).with_context(|| format!("creating log {}", path.display()))?;
        tracing_subscriber::fmt()
            .with_env_filter(env_filter("info,agent_stderr=debug"))
            .with_writer(Mutex::new(file))
            .with_ansi(false)
            .init();
    }
    run_tui(cli).await.map(|()| ExitCode::SUCCESS)
}

/// `weave mcp-bridge`: relay the agent's MCP between stdio and the Host's MCP socket.
async fn mcp_bridge() -> anyhow::Result<ExitCode> {
    let socket = std::env::var_os(weave_host::mcp::SOCKET_VARIABLE)
        .map(PathBuf::from)
        .context("the weave Host starts this for its agents; it has no MCP socket to relay to")?;
    let token = std::env::var(weave_host::mcp::TOKEN_VARIABLE)
        .context("the weave Host starts this for its agents; it has no token to relay with")?;
    weave_host::mcp::relay(&socket, &token, tokio::io::stdin(), tokio::io::stdout())
        .await
        .with_context(|| format!("relaying to {}", socket.display()))?;
    Ok(ExitCode::SUCCESS)
}

/// Diagnostics (including agent stderr at `RUST_LOG=agent_stderr=debug`) go to stderr.
fn log_to_stderr(default: &str) {
    tracing_subscriber::fmt()
        .with_env_filter(env_filter(default))
        .with_writer(std::io::stderr)
        // Colors only for a terminal: a background daemon's stderr is its log file.
        .with_ansi(std::io::stderr().is_terminal())
        .init();
}

fn env_filter(default: &str) -> EnvFilter {
    EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(default))
}

async fn run_tui(cli: Cli) -> anyhow::Result<()> {
    let mode = cli.session.mode();
    let explicit = cli.agent.choice();
    let recent = Recent::default_location();
    let disabled = cli.agent.load_config()?.daemon.enabled == Some(false);
    let target = Target::choose(cli.no_daemon || disabled)?;
    let chosen = start::choose(
        &mode,
        explicit.clone(),
        &cli.workspace,
        &target,
        recent.as_ref(),
    )?;
    if let Some(note) = &chosen.note {
        eprintln!("{note}");
    }
    let launch = cli
        .agent
        .host_launch(&cli.workspace, chosen.agent, chosen.cwd)?;
    let host = target.host(&launch, &cli.workspace, cli.agent.config_file())?;
    let no_alt_screen = cli.no_alt_screen;
    let screen = match (no_alt_screen, launch.config.tui.alternate_screen) {
        (true, _) | (false, AlternateScreen::Never) => weave_tui::ScreenMode::Inline,
        (false, AlternateScreen::Auto | AlternateScreen::Always) => {
            weave_tui::ScreenMode::Fullscreen
        }
    };
    let started = start::start(&launch, &host, &mode).await?;
    if let Some(recent) = &recent {
        recent.record(&launch.cwd, &launch.agent);
    }
    let (agent_name, agent_version) = match started.agent.agent_info.clone() {
        Some(info) => (info.title.unwrap_or(info.name), Some(info.version)),
        None => (launch.agent.describe(), None),
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
    if let Some(trace) = started
        .opened
        .as_ref()
        .and_then(|opened| opened.state.trace.as_ref())
    {
        notices.push(format!("Tracing the agent to {}", trace.display()));
    }
    let exit = weave_tui::run(
        weave_tui::Session {
            connection: started.connection,
            events: started.events,
            agent_id: launch.agent_id().to_owned(),
            agent_name,
            agent_version,
            agent: started.agent,
            cwd: launch.cwd.clone(),
            additional_directories: launch.additional_directories.clone(),
            trace: launch.trace,
            opened: started.opened,
            notices,
        },
        weave_tui::UiOptions {
            screen,
            status_line,
            notifications: launch.config.tui.notifications.unwrap_or(true),
            terminal_title: launch.config.tui.terminal_title.unwrap_or(true),
            vim: launch.config.tui.vim.unwrap_or(false),
            images: launch.config.tui.images != config::Images::Never,
            rendering: weave_tui::Rendering {
                mermaid: launch.config.tui.mermaid.unwrap_or(true),
                math: launch.config.tui.math.unwrap_or(true),
            },
            detachable: host.is_shared(),
            reconnect: host.reconnector(),
            dismissed_updates: weave_tui::dismissed_updates_file(),
        },
    )
    .await;
    host.finish().await;
    let exit = exit?;
    // Name the agent when the command line didn't, or named another, so a resume reopens the
    // session with its own.
    let agent = (explicit.as_ref() != Some(&launch.agent)).then_some(&launch.agent);
    if exit.reload {
        return reload(exit.active_session.as_ref(), agent);
    }
    // Fullscreen leaves nothing behind in the terminal, so say how to get back, as Codex does.
    if let Some(session_id) = exit.resumable_session {
        let command = resume_command(std::env::args().skip(1), &session_id.to_string(), agent);
        if exit.turn_running && host.is_shared() {
            println!("The turn carries on in the weave Host. To attach again, run: {command}");
        } else {
            println!("To continue this thread, run: {command}");
        }
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

/// `/reload`: replace this process with whatever weave binary is at its path now (a rebuilt
/// one, say), reattaching to `session` (or starting as this one did, without one). The Host
/// and its agents carry on regardless.
fn reload(session: Option<&SessionId>, agent: Option<&AgentChoice>) -> anyhow::Result<()> {
    let args: Vec<String> = match session {
        Some(session_id) => resume_args(std::env::args().skip(1), &session_id.to_string(), agent),
        None => std::env::args().skip(1).collect(),
    };
    let executable = std::env::current_exe().context("finding the weave executable")?;
    eprintln!("Reloading weave…");
    let mut command = std::process::Command::new(&executable);
    command.args(&args);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Only returns if it couldn't.
        Err(command.exec()).with_context(|| format!("reloading {}", executable.display()))
    }
    #[cfg(not(unix))]
    {
        let status = command
            .status()
            .with_context(|| format!("reloading {}", executable.display()))?;
        std::process::exit(status.code().unwrap_or(1));
    }
}

/// This invocation's command line, reopening `session_id` in place of any session choice.
fn resume_command(
    args: impl IntoIterator<Item = String>,
    session_id: &str,
    agent: Option<&AgentChoice>,
) -> String {
    let mut words = vec!["weave".to_owned()];
    words.extend(resume_args(args, session_id, agent));
    args::shell_words(&words)
}

/// This invocation's arguments, reopening `session_id` in place of any session choice, and
/// naming `agent` in place of the one given, when there's one to name.
fn resume_args(
    args: impl IntoIterator<Item = String>,
    session_id: &str,
    agent: Option<&AgentChoice>,
) -> Vec<String> {
    let mut words = Vec::new();
    let mut agent_command = Vec::new();
    match agent {
        Some(AgentChoice::Named(id)) => words.extend(["--agent".to_owned(), id.clone()]),
        Some(AgentChoice::Command(command)) => {
            agent_command.push("--".to_owned());
            agent_command.extend(command.iter().cloned());
        }
        None => {}
    }
    let mut args = args.into_iter().peekable();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            // The agent named instead replaces the one the command line gave.
            "--agent" if agent.is_some() => {
                args.next();
            }
            _ if agent.is_some() && arg.starts_with("--agent=") => {}
            "--" if agent.is_some() => break,
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
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    #[test]
    fn the_command_line_is_well_formed() {
        use clap::CommandFactory;
        Cli::command().debug_assert();
        let parses = |line: &[&str]| Cli::try_parse_from(line).is_ok();
        // Prompts come first and the custom agent command last, in run and smoke alike.
        assert!(parses(&[
            "weave",
            "run",
            "--approve",
            "read,edit",
            "fix",
            "it",
            "--",
            "agent",
            "--acp"
        ]));
        assert!(parses(&["weave", "smoke", "hi", "--approve", "all"]));
        // Sessions are named the same way everywhere.
        assert!(parses(&["weave", "run", "--resume", "s1", "again"]));
        assert!(parses(&["weave", "run", "--continue", "again"]));
        assert!(parses(&["weave", "--continue"]));
        assert!(!parses(&["weave", "run", "--session", "s1", "again"]));
        // Signing in takes no workspace.
        assert!(parses(&[
            "weave", "login", "--agent", "claude", "--trace", "t.jsonl"
        ]));
        assert!(!parses(&["weave", "login", "--cwd", "/tmp"]));
        assert!(parses(&["weave", "threads"]));
        assert!(parses(&["weave", "threads", "close", "s1"]));
        assert!(parses(&["weave", "threads", "list", "--json"]));
        // Its name before threads.
        assert!(parses(&["weave", "sessions", "cancel", "s1"]));
    }

    /// Every command's `--help`, depth first, so a change to the command line shows in review.
    #[test]
    fn every_command_says_what_it_does() {
        use clap::CommandFactory;
        let mut command = Cli::command();
        command.build();
        let mut text = String::new();
        help(&mut command, &mut text);
        insta::assert_snapshot!(text);
    }

    fn help(command: &mut clap::Command, text: &mut String) {
        let name = command
            .get_bin_name()
            .unwrap_or(command.get_name())
            .to_owned();
        let rendered = command.render_long_help().to_string();
        text.push_str(&format!("$ {name} --help\n{}\n", rendered.trim_end()));
        for command in command.get_subcommands_mut() {
            if !command.is_hide_set() && command.get_name() != "help" {
                text.push('\n');
                help(command, text);
            }
        }
    }

    fn words(line: &str) -> Vec<String> {
        line.split(' ').map(str::to_owned).collect()
    }

    #[test]
    fn the_resume_command_replaces_the_session_choice() {
        assert_eq!(
            resume_command(words("--agent claude --continue"), "s1", None),
            "weave --agent claude --resume s1"
        );
        assert_eq!(
            resume_command(words("--resume old --no-fs"), "s1", None),
            "weave --no-fs --resume s1"
        );
        assert_eq!(
            resume_command(words("--resume --cwd /tmp/repo"), "s1", None),
            "weave --cwd /tmp/repo --resume s1"
        );
        assert_eq!(
            resume_command(words("--resume=old -- ./agent --acp"), "s1", None),
            "weave --resume s1 -- ./agent --acp"
        );
        let quoted = resume_command(vec!["--cwd".into(), "it's here".into()], "s1", None);
        assert_eq!(quoted, "weave --cwd 'it'\\''s here' --resume s1");
        // An agent the command line didn't name, such as the one `--continue` found, is named.
        let codex = AgentChoice::Named("codex".into());
        assert_eq!(
            resume_command(words("--continue --no-fs"), "s1", Some(&codex)),
            "weave --agent codex --no-fs --resume s1"
        );
        let custom = AgentChoice::Command(vec!["./agent".into(), "--acp".into()]);
        assert_eq!(
            resume_command(words("--continue"), "s1", Some(&custom)),
            "weave --resume s1 -- ./agent --acp"
        );
        // As arguments, for /reload to start again with.
        assert_eq!(
            resume_args(words("--continue --no-alt-screen"), "s1", Some(&codex)),
            words("--agent codex --no-alt-screen --resume s1")
        );
        // A resumed session's own agent replaces the one given.
        assert_eq!(
            resume_command(words("--agent claude --resume s1"), "s1", Some(&codex)),
            "weave --agent codex --resume s1"
        );
        assert_eq!(
            resume_command(words("--resume s1 -- ./other"), "s1", Some(&codex)),
            "weave --agent codex --resume s1"
        );
    }
}
