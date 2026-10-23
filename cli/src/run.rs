//! `weave run`: one prompt in a headless session, in the weave Host.
//!
//! The session's permission requests are answered by its policy: the tool kinds given with
//! `--approve` are allowed once, everything else is rejected, and elicitations are dismissed,
//! since nobody is there to answer. The reply streams to stdout until the turn ends; with
//! `--detach` the turn is left running in the Host, to attach to later with `weave --resume`.

use std::io::IsTerminal;
use std::io::Read;
use std::io::Write;
use std::process::ExitCode;

use anyhow::Context;
use anyhow::bail;
use clap::Args;
use weave_acp_core::schema::ContentBlock;
use weave_acp_core::schema::PromptResponse;
use weave_acp_core::schema::SessionUpdate;
use weave_acp_core::schema::StopReason;
use weave_host_client::HostEvent;
use weave_host_protocol::events::SessionEvent;
use weave_host_protocol::policy::PermissionPolicy;
use weave_host_protocol::sessions::CloseWhen;
use weave_host_protocol::sessions::DetachSessionRequest;
use weave_host_protocol::sessions::ListSessionsRequest;
use weave_host_protocol::sessions::RunRequest;
use weave_host_protocol::turns::CancelTurnRequest;

use crate::args::AgentArgs;
use crate::args::ApproveArgs;
use crate::args::SessionArgs;
use crate::args::WorkspaceArgs;
use crate::args::reopen_command;
use crate::daemon::Target;
use crate::recent::Recent;
use crate::start::StartMode;
use crate::start::choose;

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

    /// Leave the turn running in the weave Host and print the session's id.
    #[arg(long)]
    detach: bool,

    /// Print every session update as a JSON line instead of the reply's text.
    #[arg(long)]
    json: bool,

    /// Run the agent in this process rather than the weave Host.
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
        .host_launch(&args.workspace, chosen.agent, chosen.cwd)?;
    if let Some(notice) = &launch.config.notice {
        eprintln!("weave: {notice}");
    }
    if args.detach && matches!(target, Target::InProcess) {
        bail!("--detach needs the weave Host, which the config turns off");
    }
    let host = target.host(&launch, &args.workspace, args.agent.config_file())?;
    let (connection, mut events) = host.connect("weave-cli").await?;
    let session_id = match mode {
        StartMode::Resume(session_id) => Some(session_id),
        // The open session here first, as the Host lists them.
        StartMode::Continue => {
            let listed = connection
                .send(ListSessionsRequest {
                    agent_id: Some(launch.agent_id().to_owned()),
                    cwd: Some(launch.cwd.clone()),
                    repo: None,
                    cursor: None,
                })
                .await;
            match listed.map(|listed| listed.sessions.into_iter().next()) {
                Ok(Some(latest)) => Some(latest.info.session_id),
                Ok(None) => {
                    eprintln!("weave: no earlier session here; starting one");
                    None
                }
                Err(error) => {
                    connection.shutdown().await;
                    host.finish().await;
                    return Err(error).context("finding the last session here");
                }
            }
        }
        StartMode::New | StartMode::Pick => None,
    };
    let request = RunRequest {
        agent_id: launch.agent_id().to_owned(),
        cwd: launch.cwd.clone(),
        session_id,
        additional_directories: launch.additional_directories.clone(),
        prompt: vec![ContentBlock::from(prompt)],
        policy,
        attach: !args.detach,
        trace: launch.trace,
    };
    let response = match connection.send(request).await {
        Ok(response) => {
            if let Some(recent) = &recent {
                recent.record(&launch.cwd, &launch.agent);
            }
            response
        }
        Err(error) => {
            connection.shutdown().await;
            host.finish().await;
            return Err(error).context("starting the run");
        }
    };
    let session_id = response.session_id;
    for notice in response.state.iter().flat_map(|state| &state.notices) {
        eprintln!("weave: {notice}");
    }
    if let Some(trace) = response
        .state
        .as_ref()
        .and_then(|state| state.trace.as_ref())
    {
        eprintln!("weave: tracing the agent to {}", trace.display());
    }
    if args.detach {
        connection.shutdown().await;
        println!("{session_id}");
        eprintln!(
            "Running in the weave Host; attach with: {}",
            reopen_command(&launch.agent, &session_id.to_string())
        );
        return Ok(ExitCode::SUCCESS);
    }

    let mut out = Output::new(args.json);
    let mut cancelling = false;
    let outcome: anyhow::Result<PromptResponse> = loop {
        let event = tokio::select! {
            event = events.recv() => event,
            _ = tokio::signal::ctrl_c() => {
                if cancelling {
                    break Err(anyhow::anyhow!("abandoned before the agent stopped"));
                }
                cancelling = true;
                eprintln!("\nweave: cancelling (Ctrl-C again to leave it)");
                connection
                    .send(CancelTurnRequest {
                        session_id: session_id.clone(),
                    })
                    .await?;
                continue;
            }
        };
        match event {
            Some(HostEvent::Event(notification)) if notification.session_id == session_id => {
                match notification.event {
                    SessionEvent::Update { notification }
                        if notification.session_id == session_id =>
                    {
                        out.update(&notification.update)?;
                    }
                    SessionEvent::TurnEnded {
                        session_id: ended,
                        response,
                        error,
                    } if ended == session_id => {
                        break match (response, error) {
                            (Some(response), _) => Ok(response),
                            (None, Some(error)) => Err(error.into()),
                            (None, None) => Err(anyhow::anyhow!("the turn ended unexplained")),
                        };
                    }
                    SessionEvent::Closed { reason } => {
                        break Err(anyhow::anyhow!("the session ended: {reason}"));
                    }
                    _ => {}
                }
            }
            // A new session's policy answers what the agent asks. A session that asks its
            // clients instead (continued with --resume) waits for one that can answer.
            Some(HostEvent::PendingAdded(_)) => {
                eprintln!("weave: the agent is waiting on you; answer it in the TUI");
            }
            Some(HostEvent::Disconnected(Some(error))) => {
                break Err(anyhow::anyhow!("lost the weave Host: {error}"));
            }
            Some(HostEvent::Disconnected(None)) | None => {
                break Err(anyhow::anyhow!("lost the weave Host"));
            }
            _ => {}
        }
    };
    out.finish()?;
    // Done with it: close it rather than leave it idle in the Host.
    let _ = connection
        .send(DetachSessionRequest {
            session_id: session_id.clone(),
            close: CloseWhen::IfUnused,
        })
        .await;
    connection.shutdown().await;
    host.finish().await;
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
