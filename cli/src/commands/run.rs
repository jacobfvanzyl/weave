//! `weave run`: one prompt in a headless thread, in the weave Host.
//!
//! The thread's permission requests are answered by its policy: the tool kinds given with
//! `--approve` are allowed once, everything else is rejected, and elicitations are dismissed,
//! since nobody is there to answer. The reply streams to stdout until the turn ends, or with
//! `--json` the thread's journal events (`thread/event`) as JSON lines; with `--detach` the
//! turn is left running in the Host, to attach to later with `weave --resume`, and the thread's
//! id, or with `--json` the Host's answer (`thread/run`), is printed.

use std::process::ExitCode;

use anyhow::Context;
use anyhow::bail;
use clap::Args;
use weave_acp_core::schema::ContentBlock;
use weave_host_client::HostConnection;
use weave_host_protocol::policy::PermissionPolicy;
use weave_host_protocol::threads::AttachThreadRequest;
use weave_host_protocol::threads::CloseWhen;
use weave_host_protocol::threads::DetachThreadRequest;
use weave_host_protocol::threads::GetThreadRequest;
use weave_host_protocol::threads::LatestTurn;
use weave_host_protocol::threads::ListThreadsRequest;
use weave_host_protocol::threads::RunRequest;
use weave_host_protocol::threads::ThreadId;
use weave_host_protocol::turns::CancelTurnRequest;
use weave_host_protocol::turns::TurnId;

use crate::args::AgentArgs;
use crate::args::ApproveArgs;
use crate::args::ThreadArgs;
use crate::args::WorkspaceArgs;
use crate::args::prompt_text;
use crate::args::reopen_command;
use crate::exit;
use crate::exit::Status;
use crate::host::Target;
use crate::recent::Recent;
use crate::start::StartMode;
use crate::start::choose;
use crate::turn::Follower;
use crate::turn::Link;
use crate::turn::Outcome;
use crate::turn::Output;
use crate::turn::Pick;
use crate::turn::Print;
use crate::turn::WaitArgs;
use crate::turn::report;
use crate::turn::sleep_until;

pub const LOG: &str = "warn";

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
    thread: ThreadArgs,

    #[command(flatten)]
    approve: ApproveArgs,

    /// The mode a new thread starts in, by the agent's id or name for it, such as Claude's
    /// `default`; the agent's configured `mode` when omitted, which approves for itself what
    /// `--approve` doesn't.
    #[arg(long, value_name = "MODE", conflicts_with_all = ["resume", "continue_last"])]
    mode: Option<String>,

    /// Leave the turn running in the weave Host and print the thread's id.
    #[arg(long)]
    detach: bool,

    /// A name of your choosing, such as a UUID: running again with it, after a dropped
    /// connection, starts nothing twice and follows the turn the first run started.
    #[arg(long)]
    key: Option<String>,

    /// A label for a new thread, to find it by (`weave threads list --label`); repeatable.
    #[arg(long = "label", value_name = "LABEL", conflicts_with_all = ["resume", "continue_last"])]
    labels: Vec<String>,

    #[command(flatten)]
    waiting: WaitArgs,

    /// Print the thread's journal events (`thread/event`) as JSON lines instead of the reply's
    /// text; with --detach, the Host's answer (`thread/run`).
    #[arg(long)]
    json: bool,

    /// Run the agent in this process rather than the weave Host.
    #[arg(long, conflicts_with_all = ["detach", "timeout"])]
    no_daemon: bool,

    /// Run it on another of your Hosts, by its id or name as `weave hosts` lists them, through
    /// the Dispatcher. A new thread works in this directory's counterpart under the home there,
    /// unless --cwd names one there.
    #[arg(long, value_name = "HOST", conflicts_with = "no_daemon")]
    host: Option<String>,

    /// Run it in a Project, by its name or id as `weave projects` lists them: in its location on
    /// the Host, a repository's primary worktree. On this computer's Host unless --host names
    /// another; a Project with no location there is refused.
    #[arg(long, value_name = "PROJECT", conflicts_with = "cwd")]
    project: Option<String>,
}

pub async fn command(mut args: RunArgs) -> anyhow::Result<ExitCode> {
    let prompt = prompt_text(&args.prompt)?;
    let policy = PermissionPolicy::headless(args.approve.kinds()?);
    let mode = args.thread.mode();
    if matches!(mode, StartMode::Pick) {
        bail!("--resume needs a thread id here; choosing from a list is the TUI's");
    }
    let recent = Recent::default_location();
    let disabled = args.agent.load_config()?.daemon.enabled == Some(false);
    let on = args.host.as_deref();
    let target = Target::choose(on.is_none() && (args.no_daemon || disabled), on).await?;
    if let Some(project) = &args.project {
        let dir = crate::projects::directory(project, target.on()).await?;
        args.workspace.in_project(dir);
    }
    let chosen = choose(
        &mode,
        args.agent.choice(),
        &args.workspace,
        &target,
        recent.as_ref(),
    )
    .await?;
    if let Some(note) = &chosen.note {
        eprintln!("weave: {note}");
    }
    let elsewhere = target.carried().map(|carry| carry.host.clone());
    let launch = args.agent.host_launch(
        &args.workspace,
        chosen.agent,
        chosen.cwd,
        elsewhere.as_deref(),
    )?;
    if let Some(notice) = &launch.config.notice {
        eprintln!("weave: {notice}");
    }
    if args.detach && matches!(target, Target::InProcess) {
        bail!("--detach needs the weave Host, which the config turns off");
    }
    let host = target.host(&launch, &args.workspace, args.agent.config_file())?;
    let (connection, events) = host.connect("weave-cli").await?;
    let thread_id = match mode {
        StartMode::Resume(thread_id) => Some(thread_id),
        // The open thread here first, as the Host lists them.
        StartMode::Continue => {
            let listed = connection
                .send(ListThreadsRequest {
                    agent_id: Some(launch.agent_id().to_owned()),
                    cwd: Some(launch.cwd.clone()),
                    repo: None,
                    activity: None,
                    cursor: None,
                    labels: Vec::new(),
                })
                .await;
            match listed.map(|listed| listed.threads.into_iter().next()) {
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
        thread_id,
        additional_directories: launch.additional_directories.clone(),
        mode: args.mode.clone(),
        prompt: vec![ContentBlock::from(prompt)],
        policy,
        attach: !args.detach,
        trace: launch.trace,
        key: args.key.clone(),
        caller: None,
        origin: None,
        labels: args.labels.clone(),
    };
    let response = match connection.send(request).await {
        Ok(response) => {
            // Another computer's directories aren't this one's to remember.
            if let Some(recent) = recent.as_ref().filter(|_| elsewhere.is_none()) {
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
    let thread_id = response.thread_id.clone();
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
            println!("{thread_id}");
        }
        eprintln!(
            "Running in the weave Host; attach with: {}",
            reopen_command(&launch.agent, &thread_id.to_string(), elsewhere.as_deref())
        );
        if let Some(turn) = &response.turn_id {
            let on = elsewhere
                .as_deref()
                .map(|host| format!("--host {host} "))
                .unwrap_or_default();
            eprintln!("`weave threads {on}follow {thread_id} --turn {turn}` waits for its turn.");
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
            if let Some(over) = ended_turn(&connection, &thread_id, response.turn_id.clone()).await
            {
                connection.shutdown().await;
                host.finish().await;
                if let Some(message) = over.message.filter(|_| !args.json) {
                    println!("{message}");
                }
                return Ok(Status::of_state(over.state).into());
            }
            let observed = connection
                .send(AttachThreadRequest {
                    thread_id: thread_id.clone(),
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
    let mut link = Link::new(connection, events, host.again());
    // A Host in this process ends with it, and the turn too, so it waits through everything.
    let in_process = matches!(target, Target::InProcess);
    let mut follower =
        Follower::new(&state, pick, print).until_ends(args.waiting.keep_waiting || in_process);
    let deadline = args.waiting.deadline();
    let mut out = Output::new(args.json);
    let mut cancelling = false;
    let outcome: anyhow::Result<Outcome> = loop {
        let event = tokio::select! {
            event = link.events.recv() => event,
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
                link.connection
                    .send(CancelTurnRequest {
                        thread_id: thread_id.clone(),
                    })
                    .await?;
                continue;
            }
        };
        // A new thread's policy answers what the agent asks. A thread that asks its clients
        // instead (continued with --resume) waits for one that can answer, and this stops
        // waiting then, unless asked to wait on.
        match follower.handle(event, &mut out) {
            // The Host went away: follow on once it's back.
            Ok(Some(Outcome::Lost(_))) => {
                match follower.reattach(&mut link, &mut out, deadline).await {
                    Ok(Some(outcome)) => break Ok(outcome),
                    Ok(None) => {}
                    Err(error) => break Err(error),
                }
            }
            Ok(Some(outcome)) => break Ok(outcome),
            Ok(None) => {}
            Err(error) => break Err(error),
        }
    };
    out.finish()?;
    // Done with it: close it rather than leave it idle in the Host, unless its turn goes on.
    let goes_on = matches!(&outcome, Ok(Outcome::Waiting(_) | Outcome::TimedOut));
    let connection = link.connection;
    let _ = connection
        .send(DetachThreadRequest {
            thread_id: thread_id.clone(),
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
            "weave: thread {thread_id}; continue it with {}",
            reopen_command(&launch.agent, &thread_id.to_string(), elsewhere.as_deref())
        );
    }
    let status = report(outcome, &thread_id, follower.turn(), args.json, false)?;
    Ok(status.into())
}

/// The turn `turn_id` of the thread, once it's over: a repeated run's, whose thread may have
/// closed since, so there's nothing to follow.
async fn ended_turn(
    connection: &HostConnection,
    thread_id: &ThreadId,
    turn_id: Option<TurnId>,
) -> Option<LatestTurn> {
    let got = connection
        .send(GetThreadRequest {
            thread_id: thread_id.clone(),
            turn_id: Some(turn_id?),
        })
        .await
        .ok()?;
    got.latest_turn.filter(|turn| turn.state.is_over())
}
