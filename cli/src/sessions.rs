//! `weave threads`: the threads open in the weave Host, and reading, prompting, steering,
//! stopping or closing one without attaching to it, from a shell or a script, any agent's
//! included (ADR 0023); and watching them all, or following one, as they change (WVE-108).

use std::io::Write;
use std::process::ExitCode;

use agent_client_protocol::JsonRpcMessage;
use anyhow::Context;
use anyhow::anyhow;
use anyhow::bail;
use clap::Args;
use clap::Subcommand;
use tokio::sync::mpsc::UnboundedReceiver;
use weave_acp_core::schema::ContentBlock;
use weave_acp_core::schema::SessionId;
use weave_acp_core::schema::StopReason;
use weave_host_client::HostConnection;
use weave_host_client::HostEvent;
use weave_host_protocol::host::StatusRequest;
use weave_host_protocol::queue::AddQueuedRequest;
use weave_host_protocol::queue::AddQueuedResponse;
use weave_host_protocol::sessions::Activity;
use weave_host_protocol::sessions::AttachSessionRequest;
use weave_host_protocol::sessions::AttachSessionResponse;
use weave_host_protocol::sessions::CloseSessionRequest;
use weave_host_protocol::sessions::GetSessionRequest;
use weave_host_protocol::sessions::LatestTurn;
use weave_host_protocol::sessions::OBSERVE_FEATURE;
use weave_host_protocol::sessions::SessionListing;
use weave_host_protocol::sessions::SessionUpdatedNotification;
use weave_host_protocol::sessions::TurnOrigin;
use weave_host_protocol::sessions::TurnState;
use weave_host_protocol::sessions::WATCH_FEATURE;
use weave_host_protocol::sessions::WatchSessionsRequest;
use weave_host_protocol::turns::CancelTurnRequest;
use weave_host_protocol::turns::SteerOutcome;
use weave_host_protocol::turns::SteerTurnRequest;
use weave_host_protocol::turns::TURN_IDS_FEATURE;

use crate::daemon::ago;
use crate::daemon::control_with_events;
use crate::daemon::now_ms;
use crate::daemon::paths;
use crate::exit;
use crate::exit::Status;
use crate::run::Output;
use crate::run::describe_stop;
use crate::run::prompt_text;
use crate::turn::Follower;
use crate::turn::Pick;
use crate::turn::Print;
use crate::turn::WaitArgs;
use crate::turn::report;

#[derive(Args)]
pub struct SessionsArgs {
    #[command(subcommand)]
    command: Option<SessionsCommand>,
}

#[derive(Subcommand)]
enum SessionsCommand {
    /// List the threads open in the weave Host (the default).
    List(ListArgs),
    /// Read a thread: how it lists and its latest turn on stderr, and the agent's last message
    /// in that turn on stdout.
    Read(ReadArgs),
    /// Send a thread a prompt: it starts a turn at once if none runs, or waits in the thread's
    /// queue for the running one to end. The prompt's id is its turn's.
    Prompt(PromptArgs),
    /// Send a message into a thread's running turn, without starting another; it fails when no
    /// turn runs.
    Steer(MessageArgs),
    /// Stop the turn a thread is running, as Esc does in the TUI.
    Cancel(SessionArg),
    /// Close a thread for every client: its turn ends and its agent stops. `weave --resume`
    /// can still reopen it from the agent's history.
    Close(SessionArg),
    /// Print the Host's threads as they open, change and close, as JSON lines: a
    /// `sessions/updated` for each at first, then one for every change, until stopped.
    Watch,
    /// Follow an open thread as it goes, without being one of its clients: the agent's reply
    /// as text, or with --json its journal events (`session/event`) as JSON lines.
    Follow(FollowArgs),
}

#[derive(Args, Default)]
struct ListArgs {
    /// Only the threads doing this.
    #[arg(long, value_parser = ["idle", "running", "waiting"])]
    activity: Option<String>,

    /// Print them as JSON.
    #[arg(long)]
    json: bool,
}

#[derive(Args)]
struct SessionArg {
    #[arg(value_name = "THREAD_ID")]
    session_id: String,
}

#[derive(Args)]
struct ReadArgs {
    #[arg(value_name = "THREAD_ID")]
    session_id: String,

    /// Read this turn rather than the latest, as `threads prompt` named it.
    #[arg(long, value_name = "TURN_ID")]
    turn: Option<String>,

    /// Print the Host's answer (`sessions/get`) as JSON.
    #[arg(long)]
    json: bool,
}

#[derive(Args)]
struct MessageArgs {
    #[arg(value_name = "THREAD_ID")]
    session_id: String,

    /// The prompt; read from stdin when omitted or `-`.
    prompt: Vec<String>,

    /// Print the Host's answer (`queue/add`, or `turn/steer`) as JSON; with --wait, the turn's
    /// journal events as JSON lines.
    #[arg(long)]
    json: bool,
}

#[derive(Args)]
struct PromptArgs {
    #[command(flatten)]
    message: MessageArgs,

    /// A name of your choosing, such as a UUID: prompting again with it, after a dropped
    /// connection, queues nothing twice and answers as the first time did.
    #[arg(long)]
    key: Option<String>,

    /// Wait for the turn and print the agent's reply, exiting as `weave run` does.
    #[arg(long)]
    wait: bool,

    #[command(flatten)]
    waiting: WaitArgs,
}

#[derive(Args)]
struct FollowArgs {
    #[arg(value_name = "THREAD_ID")]
    session_id: String,

    /// Follow this turn, as `threads prompt` or `run --detach` named it, from its start to its
    /// end, exiting as `weave run` does for it; one that has ended prints at once.
    #[arg(long, value_name = "TURN_ID", conflicts_with = "after")]
    turn: Option<String>,

    /// Start after this position in its journal rather than with what happens next.
    #[arg(long, value_name = "SEQ")]
    after: Option<u64>,

    /// Stop when a turn ends, exiting as `weave run` does for it: the next turn to start, or
    /// without --after, the one running now.
    #[arg(long)]
    until_turn_ends: bool,

    #[command(flatten)]
    waiting: WaitArgs,

    /// Print its journal events as JSON lines.
    #[arg(long)]
    json: bool,
}

pub async fn command(args: SessionsArgs) -> anyhow::Result<ExitCode> {
    let paths = paths()?;
    let command = args
        .command
        .unwrap_or_else(|| SessionsCommand::List(ListArgs::default()));
    let Some((connection, events)) = control_with_events(&paths).await? else {
        return match command {
            SessionsCommand::List(ListArgs { json: true, .. }) => {
                println!("[]");
                Ok(ExitCode::SUCCESS)
            }
            SessionsCommand::List(_) => {
                println!("The weave Host isn't running, so no threads are open.");
                Ok(ExitCode::SUCCESS)
            }
            SessionsCommand::Read(_)
            | SessionsCommand::Prompt(_)
            | SessionsCommand::Steer(_)
            | SessionsCommand::Cancel(_)
            | SessionsCommand::Close(_)
            | SessionsCommand::Watch
            | SessionsCommand::Follow(_) => Err(exit::unreachable(anyhow!(
                "the weave Host isn't running, so no threads are open"
            ))),
        };
    };
    let result = match command {
        SessionsCommand::Watch => watch(&connection, events).await,
        SessionsCommand::Follow(args) => follow(&connection, events, args).await,
        SessionsCommand::Prompt(args) if args.wait => {
            prompt_and_wait(&connection, events, args).await
        }
        command => run(&connection, command).await.map(|()| Status::Success),
    };
    connection.shutdown().await;
    result.map(ExitCode::from)
}

async fn run(connection: &HostConnection, command: SessionsCommand) -> anyhow::Result<()> {
    match command {
        SessionsCommand::List(ListArgs { activity, json }) => {
            let mut sessions = open(connection).await?;
            if let Some(activity) = activity {
                sessions.retain(|session| session.activity.is_some_and(|is| name(is) == activity));
            }
            if json {
                println!("{}", serde_json::to_string_pretty(&sessions)?);
            } else {
                print!("{}", describe(&sessions, now_ms()));
            }
        }
        SessionsCommand::Read(ReadArgs {
            session_id,
            turn,
            json,
        }) => {
            if turn.is_some() {
                offers(connection, TURN_IDS_FEATURE)?;
            }
            let asked = turn.is_some();
            let got = connection
                .send(GetSessionRequest {
                    session_id: SessionId::new(session_id),
                    turn_id: turn,
                })
                .await
                .context("reading the thread")?;
            if json {
                println!("{}", serde_json::to_string_pretty(&got)?);
                return Ok(());
            }
            eprint!("{}", describe(std::slice::from_ref(&got.session), now_ms()));
            match &got.latest_turn {
                Some(latest) => {
                    eprint!("{}", describe_turn(latest, asked));
                    if let Some(message) = &latest.message {
                        println!("{message}");
                    }
                }
                None => eprintln!("No turns yet."),
            }
        }
        SessionsCommand::Prompt(args) => {
            let session_id = args.message.session_id.clone();
            let json = args.message.json;
            let queued = add_prompt(connection, args).await?;
            let turn = &queued.queued_id;
            if json {
                println!("{}", serde_json::to_string_pretty(&queued)?);
            } else if queued.started {
                eprintln!("Started turn {turn} in {session_id}.");
            } else {
                eprintln!("Queued turn {turn} for {session_id}, after the turn it's running.");
            }
        }
        SessionsCommand::Steer(MessageArgs {
            session_id,
            prompt,
            json,
        }) => {
            let prompt = prompt_text(&prompt)?;
            find(&open(connection).await?, &session_id)?;
            let steered = connection
                .send(SteerTurnRequest {
                    session_id: SessionId::new(session_id.clone()),
                    prompt: vec![ContentBlock::from(prompt)],
                    caller: None,
                })
                .await
                .context("steering the thread")?;
            if json {
                println!("{}", serde_json::to_string_pretty(&steered)?);
            }
            match steered.outcome {
                SteerOutcome::Steered if json => {}
                SteerOutcome::Steered => eprintln!("Steered the turn in {session_id}."),
                SteerOutcome::NotRunning => bail!(
                    "no turn is running in {session_id}, so nothing was sent; `weave threads \
                     prompt {session_id}` starts one"
                ),
            }
        }
        SessionsCommand::Cancel(SessionArg { session_id }) => {
            let sessions = open(connection).await?;
            let session = find(&sessions, &session_id)?;
            if session.activity == Some(Activity::Idle) {
                eprintln!("No turn is running in {session_id}.");
                return Ok(());
            }
            connection
                .send(CancelTurnRequest {
                    session_id: SessionId::new(session_id.clone()),
                })
                .await?;
            eprintln!("Asked the agent to stop the turn in {session_id}.");
        }
        SessionsCommand::Close(SessionArg { session_id }) => {
            find(&open(connection).await?, &session_id)?;
            connection
                .send(CloseSessionRequest {
                    session_id: SessionId::new(session_id.clone()),
                })
                .await
                .context("closing the thread")?;
            eprintln!("Closed {session_id}; weave --resume {session_id} reopens it.");
        }
        SessionsCommand::Watch | SessionsCommand::Follow(_) => {}
    }
    Ok(())
}

/// `weave threads watch`: `sessions/watch`, a line a notification, until the Host goes or
/// whatever reads the lines does.
async fn watch(
    connection: &HostConnection,
    mut events: UnboundedReceiver<HostEvent>,
) -> anyhow::Result<Status> {
    offers(connection, WATCH_FEATURE)?;
    let watched = connection
        .send(WatchSessionsRequest {})
        .await
        .context("watching the threads")?;
    for session in watched.sessions {
        if !line(&SessionUpdatedNotification { session })? {
            return Ok(Status::Success);
        }
    }
    loop {
        let printed = match events.recv().await {
            Some(HostEvent::SessionUpdated(updated)) => line(&*updated)?,
            Some(HostEvent::SessionRemoved(removed)) => line(&removed)?,
            Some(HostEvent::Disconnected(_)) | None => {
                return Err(exit::unreachable(anyhow!("lost the weave Host")));
            }
            Some(_) => true,
        };
        if !printed {
            return Ok(Status::Success);
        }
    }
}

/// `weave threads follow`: observe the thread (`session/attach` with `observe`), printing what
/// happens in it after `--after`, or from now, or the turn `--turn` names.
async fn follow(
    connection: &HostConnection,
    mut events: UnboundedReceiver<HostEvent>,
    args: FollowArgs,
) -> anyhow::Result<Status> {
    if args.turn.is_some() {
        offers(connection, TURN_IDS_FEATURE)?;
    }
    let session_id = SessionId::new(args.session_id);
    let observed = observe(connection, &session_id).await?;
    let head = observed.state.journal.head;
    let running = observed
        .state
        .turns
        .iter()
        .find(|turn| turn.session_id == session_id)
        .and_then(|turn| turn.turn_id.clone());
    let (pick, print) = match (args.turn.clone(), args.after) {
        (Some(turn), _) => (Pick::Turn(turn), Print::Turn),
        (None, Some(after)) => (Pick::After(after), Print::After(after)),
        // From now: the turn running, or else the next to start.
        (None, None) => match running {
            Some(turn) => (Pick::Turn(turn), Print::After(head)),
            None => (Pick::After(head), Print::After(head)),
        },
    };
    let until_ends = args.until_turn_ends || args.turn.is_some();
    let mut follower = Follower::new(&observed.state, pick, print);
    if until_ends {
        follower = follower.until_ends(args.waiting.keep_waiting);
    }
    let mut out = Output::new(args.json);
    let outcome = follower
        .follow(&mut events, &mut out, args.waiting.deadline())
        .await?;
    out.finish()?;
    report(
        outcome,
        &session_id,
        follower.turn(),
        args.json,
        !until_ends,
    )
}

/// `weave threads prompt --wait`: follow the thread, so nothing of its turn is missed, then
/// prompt it, and wait for that turn as `follow --turn` does.
async fn prompt_and_wait(
    connection: &HostConnection,
    mut events: UnboundedReceiver<HostEvent>,
    args: PromptArgs,
) -> anyhow::Result<Status> {
    offers(connection, TURN_IDS_FEATURE)?;
    let session_id = SessionId::new(args.message.session_id.clone());
    let json = args.message.json;
    let deadline = args.waiting.deadline();
    let keep_waiting = args.waiting.keep_waiting;
    let observed = observe(connection, &session_id).await?;
    let queued = add_prompt(connection, args).await?;
    let mut follower = Follower::new(
        &observed.state,
        Pick::Turn(queued.queued_id.clone()),
        Print::Turn,
    )
    .until_ends(keep_waiting);
    let mut out = Output::new(json);
    let outcome = follower.follow(&mut events, &mut out, deadline).await?;
    out.finish()?;
    report(outcome, &session_id, Some(&queued.queued_id), json, false)
}

/// `queue/add` for `weave threads prompt`, to a thread that's open.
async fn add_prompt(
    connection: &HostConnection,
    args: PromptArgs,
) -> anyhow::Result<AddQueuedResponse> {
    let prompt = prompt_text(&args.message.prompt)?;
    let session_id = args.message.session_id;
    find(&open(connection).await?, &session_id)?;
    connection
        .send(AddQueuedRequest {
            session_id: SessionId::new(session_id),
            prompt: vec![ContentBlock::from(prompt)],
            key: args.key,
            caller: None,
        })
        .await
        .context("prompting the thread")
}

/// Observe the thread: its journal so far, and what happens next, as a follower that isn't one
/// of its clients.
async fn observe(
    connection: &HostConnection,
    session_id: &SessionId,
) -> anyhow::Result<AttachSessionResponse> {
    offers(connection, OBSERVE_FEATURE)?;
    connection
        .send(AttachSessionRequest {
            session_id: session_id.clone(),
            after: None,
            agent_id: None,
            cwd: None,
            trace: false,
            observe: true,
        })
        .await
        .context("following the thread")
}

/// Fail unless the Host offers `feature`, as one older than this weave may not.
fn offers(connection: &HostConnection, feature: &str) -> anyhow::Result<()> {
    if connection.hello().features.iter().any(|f| f == feature) {
        return Ok(());
    }
    bail!(
        "the weave Host running is older than this weave and can't do that; `weave daemon \
         restart` runs this one's"
    )
}

/// Print `notification` as a line of JSON, `{"method", "params"}`. False once nothing reads
/// stdout any more, as when a pipe's reader has gone.
fn line(notification: &impl JsonRpcMessage) -> anyhow::Result<bool> {
    let message = notification
        .to_untyped_message()
        .map_err(|error| anyhow!("{error}"))?;
    let text = serde_json::json!({"method": message.method, "params": message.params});
    let mut stdout = std::io::stdout().lock();
    match writeln!(stdout, "{text}").and_then(|()| stdout.flush()) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::BrokenPipe => Ok(false),
        Err(error) => Err(error.into()),
    }
}

/// The threads open in the Host.
async fn open(connection: &HostConnection) -> anyhow::Result<Vec<SessionListing>> {
    Ok(connection.send(StatusRequest {}).await?.sessions)
}

fn find<'a>(
    sessions: &'a [SessionListing],
    session_id: &str,
) -> anyhow::Result<&'a SessionListing> {
    sessions
        .iter()
        .find(|session| session.info.session_id.to_string() == session_id)
        .with_context(|| {
            format!(
                "{session_id} isn't open in the weave Host (`weave threads` lists those that are)"
            )
        })
}

fn describe(sessions: &[SessionListing], now_ms: u64) -> String {
    if sessions.is_empty() {
        return "No threads open.\n".to_owned();
    }
    let mut out = String::new();
    for session in sessions {
        let activity = match session.activity {
            Some(Activity::Running) => "running",
            Some(Activity::Waiting) => "waiting on you",
            Some(Activity::Idle) | None => "idle",
        };
        let clients = match session.clients {
            0 => "no clients".to_owned(),
            1 => "1 client".to_owned(),
            count => format!("{count} clients"),
        };
        let headless = if session.headless { ", headless" } else { "" };
        let agent = &session.agent_id;
        let about = match &session.info.title {
            Some(title) => format!("{title} · {agent}"),
            None => agent.clone(),
        };
        let branch = session
            .git
            .as_ref()
            .and_then(|git| git.branch.as_ref())
            .map(|branch| format!(" on {branch}"))
            .unwrap_or_default();
        out.push_str(&format!(
            "{}  {activity}, {clients}{headless}, active {} ago\n  {about}\n  in {}{branch}\n",
            session.info.session_id,
            ago(now_ms, session.last_activity_at.unwrap_or(now_ms)),
            session.info.cwd.display(),
        ));
        if let Some(starter) = &session.started_by {
            out.push_str(&format!("  started by thread {starter}\n"));
        }
    }
    out
}

/// What `--activity` calls `activity`.
fn name(activity: Activity) -> &'static str {
    match activity {
        Activity::Idle => "idle",
        Activity::Running => "running",
        Activity::Waiting => "waiting",
    }
}

/// A thread's latest turn, or the one `asked` for: where it came from, how it stands, and its
/// prompt.
fn describe_turn(latest: &LatestTurn, asked: bool) -> String {
    let from = match &latest.origin {
        TurnOrigin::Client { name, device, .. } => device.clone().unwrap_or_else(|| name.clone()),
        TurnOrigin::Run {} => "a headless run".to_owned(),
        TurnOrigin::Session {
            session_id,
            host,
            host_name,
            report,
        } => {
            let on = match (host_name, host) {
                (Some(name), _) => format!(" on {name}"),
                (None, Some(host)) => format!(" on Host {host}"),
                (None, None) => String::new(),
            };
            if *report {
                format!("the Host's report on thread {session_id}{on}")
            } else {
                format!("thread {session_id}{on}")
            }
        }
    };
    let stopped = |latest: &LatestTurn| {
        let reason = latest
            .response
            .as_ref()
            .map_or(StopReason::EndTurn, |response| response.stop_reason);
        format!("stopped: {}", describe_stop(reason))
    };
    let how = match latest.state {
        TurnState::Queued => "queued".to_owned(),
        TurnState::Running => "running".to_owned(),
        TurnState::Waiting => "waiting on a person".to_owned(),
        TurnState::Ended => "finished".to_owned(),
        TurnState::Stopped | TurnState::Cancelled => stopped(latest),
        TurnState::Failed => match &latest.error {
            Some(error) => format!("failed: {}", error.message),
            None => "ended unexplained".to_owned(),
        },
    };
    let prompt: Vec<String> = latest
        .prompt
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text(text) => Some(text.text.clone()),
            _ => None,
        })
        .collect();
    let which = match (&latest.turn_id, asked) {
        (Some(turn), true) => format!("Turn {turn}"),
        (Some(turn), false) => format!("Latest turn {turn}"),
        (None, _) => "Latest turn".to_owned(),
    };
    let mut out = format!("{which}, from {from}, {how}:\n");
    for line in prompt.join("\n").lines() {
        out.push_str(&format!("  > {line}\n"));
    }
    out
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;
    use weave_acp_core::schema::PromptResponse;
    use weave_acp_core::schema::SessionInfo;
    use weave_host_protocol::sessions::SessionStatus;
    use weave_host_protocol::worktrees::GitLocation;

    use super::*;

    #[test]
    fn each_session_says_what_its_doing() {
        assert_eq!(describe(&[], 0), "No threads open.\n");
        let session = SessionListing {
            info: SessionInfo::new("s1", "/repo").title("Fix the build".to_owned()),
            agent_id: "claude".into(),
            state: SessionStatus::Open,
            activity: Some(Activity::Waiting),
            clients: 0,
            headless: true,
            last_activity_at: Some(30_000),
            git: None,
            started_by: None,
            started_by_host: None,
        };
        assert_eq!(
            describe(std::slice::from_ref(&session), 7_230_000),
            "s1  waiting on you, no clients, headless, active 2h ago\n  Fix the build · claude\n  in \
             /repo\n"
        );
        let on_a_branch = SessionListing {
            git: Some(GitLocation {
                repo: "/repo".into(),
                worktree: "/repo".into(),
                branch: Some("main".to_owned()),
                remote: None,
            }),
            ..session.clone()
        };
        assert!(describe(&[on_a_branch], 7_230_000).ends_with("  in /repo on main\n"));
        let delegated = SessionListing {
            started_by: Some("s0".into()),
            ..session.clone()
        };
        assert!(describe(&[delegated], 7_230_000).ends_with("  started by thread s0\n"));
        assert!(find(&[session], "s2").is_err());
    }

    #[test]
    fn a_latest_turn_says_where_it_came_from_and_how_it_stands() {
        let turn = LatestTurn {
            turn_id: None,
            state: TurnState::Running,
            prompt: vec![ContentBlock::from(
                "address the review\non the PR".to_owned(),
            )],
            origin: TurnOrigin::Session {
                session_id: "s0".into(),
                report: false,
                host: None,
                host_name: None,
            },
            started_at: 0,
            running: true,
            response: None,
            error: None,
            message: None,
        };
        assert_eq!(
            describe_turn(&turn, false),
            "Latest turn, from thread s0, running:\n  > address the review\n  > on the PR\n"
        );
        let waiting = LatestTurn {
            turn_id: Some("q-1".to_owned()),
            state: TurnState::Waiting,
            ..turn.clone()
        };
        assert!(
            describe_turn(&waiting, false)
                .starts_with("Latest turn q-1, from thread s0, waiting on a person:")
        );
        assert!(describe_turn(&waiting, true).starts_with("Turn q-1, from thread s0,"));
        let finished = LatestTurn {
            state: TurnState::Ended,
            origin: TurnOrigin::Run {},
            running: false,
            response: Some(PromptResponse::new(StopReason::EndTurn)),
            ..turn
        };
        assert!(
            describe_turn(&finished, false)
                .starts_with("Latest turn, from a headless run, finished:")
        );
        let cancelled = LatestTurn {
            state: TurnState::Cancelled,
            origin: TurnOrigin::Session {
                session_id: "s2".into(),
                report: true,
                host: None,
                host_name: None,
            },
            response: Some(PromptResponse::new(StopReason::Cancelled)),
            ..finished
        };
        assert!(
            describe_turn(&cancelled, false).starts_with(
                "Latest turn, from the Host's report on thread s2, stopped: cancelled:"
            )
        );
        let queued = LatestTurn {
            state: TurnState::Queued,
            response: None,
            ..cancelled
        };
        assert!(describe_turn(&queued, false).contains(", queued:"));
    }
}
