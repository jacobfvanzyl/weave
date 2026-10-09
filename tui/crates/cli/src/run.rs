//! `weave run`: one prompt in a headless session, in the daemon.
//!
//! The session's permission requests are answered by its policy: the tool kinds given with
//! `--approve` are allowed once, everything else is rejected, and elicitations are dismissed,
//! since nobody is there to answer. The reply streams to stdout until the turn ends; with
//! `--detach` the turn is left running in the daemon, to attach to later with `weave --resume`.

use std::io::IsTerminal;
use std::io::Read;
use std::io::Write;
use std::process::ExitCode;

use anyhow::Context;
use anyhow::bail;
use clap::Args;
use weave_acp_core::AgentEvent;
use weave_acp_core::ClientOptions;
use weave_acp_core::daemon_protocol::RunRequest;
use weave_acp_core::policy::PermissionPolicy;
use weave_acp_core::schema::ContentBlock;
use weave_acp_core::schema::SessionUpdate;
use weave_acp_core::schema::StopReason;

use crate::args::AgentArgs;
use crate::args::ApproveArgs;
use crate::args::SessionArgs;
use crate::args::WorkspaceArgs;
use crate::args::reopen_command;
use crate::daemon::Target;
use crate::daemon::daemon_launch;
use crate::recent::Recent;
use crate::start::StartMode;
use crate::start::choose;
use crate::start::session_setup;

#[derive(Args)]
pub struct RunArgs {
    /// The prompt; read from stdin when omitted or `-`. Before the agent's arguments, whose
    /// custom command comes last, after `--`.
    prompt: Vec<String>,

    #[command(flatten)]
    agent: AgentArgs,

    #[command(flatten)]
    workspace: WorkspaceArgs,

    /// Continue a session (`--resume <id>`, or `--continue` for the last one here) instead
    /// of starting one.
    #[command(flatten)]
    session: SessionArgs,

    #[command(flatten)]
    approve: ApproveArgs,

    /// Leave the turn running in the daemon and print the session's id.
    #[arg(long)]
    detach: bool,

    /// Print every session update as a JSON line instead of the reply's text.
    #[arg(long)]
    json: bool,

    /// Run the agent in this process rather than the daemon.
    #[arg(long, conflicts_with = "detach")]
    no_daemon: bool,
}

pub async fn run(args: RunArgs) -> anyhow::Result<ExitCode> {
    let prompt = prompt_text(&args.prompt)?;
    let policy = PermissionPolicy::headless(args.approve.kinds()?);
    let mode = args.session.mode();
    if matches!(mode, StartMode::Pick) {
        bail!("--resume needs a session id here; choosing from a list is the TUI's");
    }
    let recent = Recent::default_location();
    let disabled = args.agent.load_config()?.daemon.enabled == Some(false);
    let target = Target::choose(args.no_daemon || disabled)?;
    let chosen = choose(
        &mode,
        args.agent.choice(),
        &args.workspace,
        &target,
        recent.as_ref(),
    )?;
    if let Some(note) = &chosen.note {
        eprintln!("weave: {note}");
    }
    let launch = args
        .agent
        .launch(&args.workspace, chosen.agent, chosen.cwd)
        .await?;
    if args.detach && matches!(target, Target::InProcess(_)) {
        bail!("--detach needs the daemon, which the config turns off");
    }
    // Nobody can sign in at a terminal partway through a headless run.
    let options = ClientOptions {
        terminal_auth: false,
        ..launch.options
    };
    let (connection, mut events) = target.connect(daemon_launch(&launch), options).await?;
    let (setup, notices) = session_setup(&launch, &connection);
    for notice in notices {
        eprintln!("weave: {notice}");
    }
    let session_id = match mode {
        StartMode::Resume(session_id) => Some(session_id),
        // The live session here first, as the daemon lists them.
        StartMode::Continue => {
            let listed = connection
                .list_sessions(Some(launch.cwd.clone()), None)
                .await;
            match listed.map(|listed| listed.sessions.into_iter().next()) {
                Ok(Some(latest)) => Some(latest.session_id),
                Ok(None) => {
                    eprintln!("weave: no earlier session here; starting one");
                    None
                }
                Err(error) => {
                    connection.shutdown().await;
                    target.finish().await;
                    return Err(error).context("finding the last session here");
                }
            }
        }
        StartMode::New | StartMode::Pick => None,
    };
    let request = RunRequest {
        launch: daemon_launch(&launch),
        session_id,
        additional_directories: setup.additional_directories,
        mcp_servers: setup.mcp_servers,
        prompt: vec![ContentBlock::from(prompt)],
        policy,
        attach: !args.detach,
    };
    let session_id = match connection.extension(request).await {
        Ok(response) => {
            if let Some(recent) = &recent {
                recent.record(&launch.cwd, &launch.agent);
            }
            response.session_id
        }
        Err(error) => {
            connection.shutdown().await;
            target.finish().await;
            return Err(error).context("starting the run");
        }
    };
    if args.detach {
        connection.shutdown().await;
        println!("{session_id}");
        eprintln!(
            "Running in the weave daemon; attach with: {}",
            reopen_command(&launch.agent, &session_id.to_string())
        );
        return Ok(ExitCode::SUCCESS);
    }

    let mut out = Output::new(args.json);
    let mut cancelling = false;
    let outcome = loop {
        let event = tokio::select! {
            event = events.recv() => event,
            _ = tokio::signal::ctrl_c() => {
                if cancelling {
                    break Err(anyhow::anyhow!("abandoned before the agent stopped"));
                }
                cancelling = true;
                eprintln!("\nweave: cancelling (Ctrl-C again to leave it)");
                connection.cancel(session_id.clone())?;
                continue;
            }
        };
        match event {
            Some(AgentEvent::SessionUpdate(notification))
                if notification.session_id == session_id =>
            {
                out.update(&notification.update)?;
            }
            Some(AgentEvent::TurnEnded {
                session_id: ended,
                result,
            }) if ended == session_id => break result.map_err(anyhow::Error::from),
            Some(AgentEvent::SessionEnded { reason, .. }) => {
                break Err(anyhow::anyhow!("the session ended: {reason}"));
            }
            Some(AgentEvent::Disconnected(Some(error))) => {
                break Err(anyhow::anyhow!("lost the daemon: {error}"));
            }
            Some(AgentEvent::Disconnected(None)) | None => {
                break Err(anyhow::anyhow!("lost the daemon"));
            }
            // A new session's policy answers what the agent asks. A session that asks its
            // clients instead (continued with --session) has to wait for one that can answer.
            Some(AgentEvent::PermissionRequested(request)) => {
                eprintln!("weave: the agent asks permission; answer it in the TUI");
                let _ = request.cancel();
            }
            Some(AgentEvent::ElicitationRequested(request)) => {
                eprintln!("weave: the agent asks a question; answer it in the TUI");
                let _ = request.cancel();
            }
            _ => {}
        }
    };
    out.finish()?;
    // Done with it: close it rather than leave it idle in the daemon.
    let _ = connection.close_session(session_id.clone()).await;
    connection.shutdown().await;
    target.finish().await;
    let response = outcome?;
    eprintln!(
        "weave: session {session_id}; continue it with {}",
        reopen_command(&launch.agent, &session_id.to_string())
    );
    match response.stop_reason {
        StopReason::EndTurn => Ok(ExitCode::SUCCESS),
        reason => {
            eprintln!("weave: the turn stopped: {}", describe_stop(reason));
            Ok(ExitCode::FAILURE)
        }
    }
}

/// The prompt from the arguments, or stdin when there are none or just `-`.
fn prompt_text(words: &[String]) -> anyhow::Result<String> {
    let from_stdin = words.is_empty() || words == ["-"];
    let text = if from_stdin {
        if std::io::stdin().is_terminal() {
            bail!("give a prompt, or pipe one in");
        }
        let mut text = String::new();
        std::io::stdin()
            .read_to_string(&mut text)
            .context("reading the prompt from stdin")?;
        text
    } else {
        words.join(" ")
    };
    let text = text.trim().to_owned();
    if text.is_empty() {
        bail!("the prompt is empty");
    }
    Ok(text)
}

fn describe_stop(reason: StopReason) -> &'static str {
    match reason {
        StopReason::Cancelled => "cancelled",
        StopReason::MaxTokens => "the agent reached its token limit",
        StopReason::MaxTurnRequests => "too many model requests",
        StopReason::Refusal => "the agent refused",
        _ => "for an unrecognized reason",
    }
}

/// The reply as it streams: text to stdout, tool calls noted on stderr; or every update as
/// JSON.
struct Output {
    json: bool,
    /// Whether the last thing written to stdout ended its line.
    at_line_start: bool,
}

impl Output {
    fn new(json: bool) -> Self {
        Self {
            json,
            at_line_start: true,
        }
    }

    fn update(&mut self, update: &SessionUpdate) -> anyhow::Result<()> {
        let mut stdout = std::io::stdout().lock();
        if self.json {
            writeln!(stdout, "{}", serde_json::to_string(update)?)?;
            return Ok(stdout.flush()?);
        }
        match update {
            SessionUpdate::AgentMessageChunk(chunk) => {
                if let ContentBlock::Text(text) = &chunk.content {
                    write!(stdout, "{}", text.text)?;
                    self.at_line_start = text.text.ends_with('\n');
                }
            }
            SessionUpdate::ToolCall(call) => {
                eprintln!("• {}", call.title);
            }
            _ => {}
        }
        Ok(stdout.flush()?)
    }

    fn finish(&mut self) -> anyhow::Result<()> {
        if !self.json && !self.at_line_start {
            println!();
        }
        Ok(())
    }
}
