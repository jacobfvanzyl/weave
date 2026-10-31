//! `weave run`: one prompt in a headless session, in the weave Host.
//!
//! The session's permission requests are answered by its policy: the tool kinds given with
//! `--approve` are allowed once, everything else is rejected, and elicitations are dismissed,
//! since nobody is there to answer. The reply streams to stdout until the turn ends, or with
//! `--json` the session's journal events (`session/event`) as JSON lines; with `--detach` the
//! turn is left running in the Host, to attach to later with `weave --resume`, and the thread's
//! id, or with `--json` the Host's answer (`session/run`), is printed.

use std::io::IsTerminal;
use std::io::Read;
use std::io::Write;
use std::process::ExitCode;

use anyhow::Context;
use anyhow::bail;
use clap::Args;
use weave_acp_core::schema::ContentBlock;
use weave_acp_core::schema::SessionId;
use weave_acp_core::schema::SessionUpdate;
use weave_acp_core::schema::StopReason;
use weave_host_client::HostConnection;
use weave_host_protocol::events::SessionEvent;
use weave_host_protocol::events::SessionEventNotification;
use weave_host_protocol::policy::PermissionPolicy;
use weave_host_protocol::sessions::AttachSessionRequest;
use weave_host_protocol::sessions::CloseWhen;
use weave_host_protocol::sessions::DetachSessionRequest;
use weave_host_protocol::sessions::GetSessionRequest;
use weave_host_protocol::sessions::LatestTurn;
use weave_host_protocol::sessions::ListSessionsRequest;
use weave_host_protocol::sessions::RunRequest;
use weave_host_protocol::turns::CancelTurnRequest;
use weave_host_protocol::turns::TurnId;

use crate::args::AgentArgs;
use crate::args::ApproveArgs;
use crate::args::SessionArgs;
use crate::args::WorkspaceArgs;
use crate::args::reopen_command;
use crate::daemon::Target;
use crate::exit;
use crate::exit::Status;
use crate::recent::Recent;
use crate::start::StartMode;
use crate::start::choose;
use crate::turn::Follower;
use crate::turn::Outcome;
use crate::turn::Pick;
use crate::turn::Print;
use crate::turn::WaitArgs;
use crate::turn::report;
use crate::turn::sleep_until;

#[derive(Args)]
pub struct RunArgs {
    /// The prompt; read from stdin when omitted or `-`. Before the agent's arguments, whose
    /// custom command comes last, after `--`.
    prompt: Vec<String>,

    #[command(flatten)]
    agent: AgentArgs,

    #[command(flatten)]
    workspace: WorkspaceArgs,

    /// Continue a thread (`--resume <id>`, or `--continue` for the last one here) instead
    /// of starting one.
    #[command(flatten)]
    session: SessionArgs,

    #[command(flatten)]
    approve: ApproveArgs,

    /// Leave the turn running in the weave Host and print the thread's id.
    #[arg(long)]
    detach: bool,

    /// A name of your choosing, such as a UUID: running again with it, after a dropped
    /// connection, starts nothing twice and follows the turn the first run started.
    #[arg(long)]
    key: Option<String>,

    #[command(flatten)]
    waiting: WaitArgs,

    /// Print the thread's journal events (`session/event`) as JSON lines instead of the reply's
    /// text; with --detach, the Host's answer (`session/run`).
    #[arg(long)]
    json: bool,

    /// Run the agent in this process rather than the weave Host.
    #[arg(long, conflicts_with_all = ["detach", "timeout"])]
    no_daemon: bool,
}

pub async fn run(args: RunArgs) -> anyhow::Result<ExitCode> {
    let prompt = prompt_text(&args.prompt)?;
    let policy = PermissionPolicy::headless(args.approve.kinds()?);
    let mode = args.session.mode();
    if matches!(mode, StartMode::Pick) {
        bail!("--resume needs a thread id here; choosing from a list is the TUI's");
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
                    activity: None,
                    cursor: None,
                })
                .await;
            match listed.map(|listed| listed.sessions.into_iter().next()) {
                Ok(Some(latest)) => Some(latest.info.session_id),
                Ok(None) => {
                    eprintln!("weave: no earlier thread here; starting one");
                    None
                }
                Err(error) => {
                    connection.shutdown().await;
                    host.finish().await;
                    return Err(error).context("finding the last thread here");
                }
            }
        }
        StartMode::New | StartMode::Pick => None,
    };
    let request = RunRequest {
        agent_id: launch.agent_id().to_owned(),
        cwd: launch.cwd.clone(),
        remote: None,
        session_id,
        additional_directories: launch.additional_directories.clone(),
        prompt: vec![ContentBlock::from(prompt)],
        policy,
        attach: !args.detach,
        trace: launch.trace,
        key: args.key.clone(),
        caller: None,
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
    let session_id = response.session_id.clone();
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
        if args.json {
            println!("{}", serde_json::to_string_pretty(&response)?);
        } else {
            println!("{session_id}");
        }
        eprintln!(
            "Running in the weave Host; attach with: {}",
            reopen_command(&launch.agent, &session_id.to_string())
        );
        if let Some(turn) = &response.turn_id {
            eprintln!("`weave threads follow {session_id} --turn {turn}` waits for its turn.");
        }
        return Ok(ExitCode::SUCCESS);
    }

    // A repeat under the same key attached nothing: follow the thread instead, from the start
    // of the turn the first run started.
    let (state, print) = match response.state {
        Some(state) => {
            let head = state.journal.head;
            (*state, Print::After(head))
        }
        None => {
            if let Some(over) = ended_turn(&connection, &session_id, response.turn_id.clone()).await
            {
                connection.shutdown().await;
                host.finish().await;
                if let Some(message) = over.message.filter(|_| !args.json) {
                    println!("{message}");
                }
                return Ok(Status::of_state(over.state).into());
            }
            let observed = connection
                .send(AttachSessionRequest {
                    session_id: session_id.clone(),
                    after: None,
                    agent_id: None,
                    cwd: None,
                    trace: false,
                    observe: true,
                })
                .await;
            match observed {
                Ok(observed) => (observed.state, Print::Turn),
                Err(error) => {
                    connection.shutdown().await;
                    host.finish().await;
                    return Err(error).context("following the thread");
                }
            }
        }
    };
    let pick = match &response.turn_id {
        Some(turn) => Pick::Turn(turn.clone()),
        None => Pick::After(state.journal.head),
    };
    // A Host in this process ends with it, and the turn too, so it waits through everything.
    let in_process = matches!(target, Target::InProcess);
    let mut follower =
        Follower::new(&state, pick, print).until_ends(args.waiting.keep_waiting || in_process);
    let deadline = args.waiting.deadline();
    let mut out = Output::new(args.json);
    let mut cancelling = false;
    let outcome: anyhow::Result<Outcome> = loop {
        let event = tokio::select! {
            event = events.recv() => event,
            () = sleep_until(deadline) => break Ok(Outcome::TimedOut),
            _ = tokio::signal::ctrl_c() => {
                if cancelling {
                    break Err(exit::fail(
                        Status::Cancelled,
                        anyhow::anyhow!("abandoned before the agent stopped"),
                    ));
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
        // A new session's policy answers what the agent asks. A session that asks its clients
        // instead (continued with --resume) waits for one that can answer, and this stops
        // waiting then, unless asked to wait on.
        match follower.handle(event, &mut out) {
            Ok(Some(outcome)) => break Ok(outcome),
            Ok(None) => {}
            Err(error) => break Err(error),
        }
    };
    out.finish()?;
    // Done with it: close it rather than leave it idle in the Host, unless its turn goes on.
    let goes_on = matches!(&outcome, Ok(Outcome::Waiting(_) | Outcome::TimedOut));
    let _ = connection
        .send(DetachSessionRequest {
            session_id: session_id.clone(),
            close: if goes_on {
                CloseWhen::Never
            } else {
                CloseWhen::IfUnused
            },
        })
        .await;
    connection.shutdown().await;
    host.finish().await;
    let outcome = outcome?;
    if matches!(
        outcome,
        Outcome::Ended {
            response: Some(_),
            ..
        }
    ) {
        eprintln!(
            "weave: thread {session_id}; continue it with {}",
            reopen_command(&launch.agent, &session_id.to_string())
        );
    }
    let status = report(outcome, &session_id, follower.turn(), args.json, false)?;
    Ok(status.into())
}

/// The turn `turn_id` of the thread, once it's over: a repeated run's, whose thread may have
/// closed since, so there's nothing to follow.
async fn ended_turn(
    connection: &HostConnection,
    session_id: &SessionId,
    turn_id: Option<TurnId>,
) -> Option<LatestTurn> {
    let got = connection
        .send(GetSessionRequest {
            session_id: session_id.clone(),
            turn_id: Some(turn_id?),
        })
        .await
        .ok()?;
    got.latest_turn.filter(|turn| turn.state.is_over())
}

/// The prompt from the arguments, or stdin when there are none or just `-`.
pub(crate) fn prompt_text(words: &[String]) -> anyhow::Result<String> {
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

pub(crate) fn describe_stop(reason: StopReason) -> &'static str {
    match reason {
        StopReason::Cancelled => "cancelled",
        StopReason::MaxTokens => "the agent reached its token limit",
        StopReason::MaxTurnRequests => "too many model requests",
        StopReason::Refusal => "the agent refused",
        _ => "for an unrecognized reason",
    }
}

/// The reply as it streams: text to stdout, tool calls noted on stderr; or every journal event
/// as a JSON line. `weave threads follow` prints a thread it follows the same way.
pub(crate) struct Output {
    json: bool,
    /// Whether the last thing written to stdout ended its line.
    at_line_start: bool,
}

impl Output {
    pub(crate) fn new(json: bool) -> Self {
        Self {
            json,
            at_line_start: true,
        }
    }

    pub(crate) fn event(
        &mut self,
        session_id: &SessionId,
        notification: &SessionEventNotification,
    ) -> anyhow::Result<()> {
        if self.json {
            let mut stdout = std::io::stdout().lock();
            writeln!(stdout, "{}", serde_json::to_string(notification)?)?;
            return Ok(stdout.flush()?);
        }
        match &notification.event {
            SessionEvent::Update { notification } if notification.session_id == *session_id => {
                self.update(&notification.update)
            }
            _ => Ok(()),
        }
    }

    fn update(&mut self, update: &SessionUpdate) -> anyhow::Result<()> {
        let mut stdout = std::io::stdout().lock();
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

    pub(crate) fn is_json(&self) -> bool {
        self.json
    }

    pub(crate) fn finish(&mut self) -> anyhow::Result<()> {
        if !self.json && !self.at_line_start {
            println!();
        }
        Ok(())
    }
}
