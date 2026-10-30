mod args;
mod config;
mod daemon;
mod devices;
mod exit;
mod recent;
mod run;
mod service;
mod sessions;
mod smoke;
mod start;
mod update;
mod worktrees;

use std::fs::File;
use std::io::IsTerminal;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Mutex;

use anyhow::Context;
use clap::Args;
use clap::Parser;
use clap::Subcommand;
use tracing_subscriber::EnvFilter;
use weave_acp_core::schema::SessionId;
use weave_agents::registry;

use crate::args::AgentArgs;
use crate::args::AgentChoice;
use crate::args::SessionArgs;
use crate::args::WorkspaceArgs;
use crate::config::AlternateScreen;
use crate::daemon::Target;
use crate::exit::Status;
use crate::recent::Recent;
use crate::start::SignedIn;

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
    Sessions(sessions::SessionsArgs),
    /// Git worktrees: what worktrunk asks the weave Host before it removes one.
    Worktrees(worktrees::WorktreesArgs),
    /// Manage the weave Host, which runs agents so their threads outlive the TUI.
    Daemon(daemon::DaemonArgs),
    /// Pair another of your devices with the weave Host, to reach it over your tailnet.
    Pair(devices::PairArgs),
    /// Devices paired with the weave Host: list them, or revoke one.
    Devices(devices::DevicesArgs),
    /// Move the agents weave launches to their newest releases, after checking each starts.
    Update(update::UpdateArgs),
    /// Run one prompt headlessly and print every ACP event the agent sends.
    Smoke(smoke::SmokeArgs),
    /// Sign in to the agent with one of the methods it offers.
    Login(LoginArgs),
    /// Sign out of the agent, if it supports signing out.
    Logout(LogoutArgs),
    /// List the agents `--agent` accepts: presets, the config's, and the ACP registry's.
    Agents(AgentsArgs),
    /// The weave Host's MCP server for an agent: relays MCP on stdio to the Host's MCP socket,
    /// which the environment names. The Host declares it to agents; it isn't for people.
    #[command(hide = true)]
    McpBridge,
}

#[derive(Args)]
struct AgentsArgs {
    /// Fetch the ACP registry again rather than use the copy cached within the last day.
    #[arg(long)]
    refresh: bool,

    /// Config file. Defaults to ~/.config/weave/config.toml.
    #[arg(long)]
    config: Option<PathBuf>,
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
    match cli.command.take() {
        Some(Command::Run(args)) => {
            log_to_stderr("warn");
            run::run(args).await
        }
        Some(Command::Sessions(args)) => {
            log_to_stderr("warn");
            sessions::command(args).await
        }
        Some(Command::Worktrees(args)) => {
            log_to_stderr("warn");
            worktrees::command(args).await
        }
        Some(Command::Daemon(args)) => {
            // A Host's stderr is its log, agents' stderr included, as `--log-file` has it.
            log_to_stderr("info,agent_stderr=debug");
            daemon::command(args).await
        }
        Some(Command::Pair(args)) => {
            log_to_stderr("warn");
            devices::pair(args).await.map(|()| ExitCode::SUCCESS)
        }
        Some(Command::Devices(args)) => {
            log_to_stderr("warn");
            devices::devices(args).await.map(|()| ExitCode::SUCCESS)
        }
        Some(Command::Update(args)) => {
            log_to_stderr("warn");
            update::command(args).await
        }
        Some(Command::Smoke(args)) => {
            log_to_stderr("warn");
            smoke::run(args).await.map(|()| ExitCode::SUCCESS)
        }
        Some(Command::Login(args)) => {
            log_to_stderr("warn");
            login(args).await.map(|()| ExitCode::SUCCESS)
        }
        Some(Command::Logout(args)) => {
            log_to_stderr("warn");
            logout(args).await.map(|()| ExitCode::SUCCESS)
        }
        Some(Command::Agents(args)) => {
            log_to_stderr("warn");
            agents(args).await.map(|()| ExitCode::SUCCESS)
        }
        Some(Command::McpBridge) => {
            // Stdout carries MCP; diagnostics go to stderr, the agent's to keep.
            log_to_stderr("warn");
            mcp_bridge().await.map(|()| ExitCode::SUCCESS)
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
            run_tui(cli).await.map(|()| ExitCode::SUCCESS)
        }
    }
}

/// `weave mcp-bridge`: relay the agent's MCP between stdio and the Host's MCP socket.
async fn mcp_bridge() -> anyhow::Result<()> {
    let socket = std::env::var_os(weave_host::mcp::SOCKET_VARIABLE)
        .map(PathBuf::from)
        .context("the weave Host starts this for its agents; it has no MCP socket to relay to")?;
    let token = std::env::var(weave_host::mcp::TOKEN_VARIABLE)
        .context("the weave Host starts this for its agents; it has no token to relay with")?;
    weave_host::mcp::relay(&socket, &token, tokio::io::stdin(), tokio::io::stdout())
        .await
        .with_context(|| format!("relaying to {}", socket.display()))
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

async fn login(args: LoginArgs) -> anyhow::Result<()> {
    let launch = args.agent.launch_here(&WorkspaceArgs::default()).await?;
    let (connection, _events) = start::connect_direct(&launch).await?;
    let result = start::sign_in(&connection, &launch.spec, args.method.as_deref()).await;
    connection.shutdown().await;
    match result? {
        SignedIn::Ready => eprintln!("Signed in."),
        SignedIn::Reconnect => eprintln!("Signed in. The next thread will use it."),
    }
    Ok(())
}

async fn logout(args: LogoutArgs) -> anyhow::Result<()> {
    let launch = args.agent.launch_here(&WorkspaceArgs::default()).await?;
    let (connection, _events) = start::connect_direct(&launch).await?;
    let result = connection.logout().await;
    connection.shutdown().await;
    result.context("logout")?;
    eprintln!("Signed out.");
    Ok(())
}

async fn agents(args: AgentsArgs) -> anyhow::Result<()> {
    let config = config::Config::load(args.config.as_deref())?;
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
    Ok(())
}

/// `text` cut to `max` characters, with an ellipsis when cut.
fn shorten(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_owned();
    }
    let kept: String = text.chars().take(max.saturating_sub(1)).collect();
    format!("{}…", kept.trim_end())
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
