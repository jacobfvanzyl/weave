//! `weave threads`: the threads open in the weave Host, and reading, prompting, steering,
//! stopping or closing one without attaching to it, from a shell or a script, any agent's
//! included (ADR 0023).

use anyhow::Context;
use anyhow::anyhow;
use anyhow::bail;
use clap::Args;
use clap::Subcommand;
use weave_acp_core::schema::ContentBlock;
use weave_acp_core::schema::SessionId;
use weave_acp_core::schema::StopReason;
use weave_host_client::HostConnection;
use weave_host_protocol::host::StatusRequest;
use weave_host_protocol::queue::AddQueuedRequest;
use weave_host_protocol::sessions::Activity;
use weave_host_protocol::sessions::CloseSessionRequest;
use weave_host_protocol::sessions::GetSessionRequest;
use weave_host_protocol::sessions::LatestTurn;
use weave_host_protocol::sessions::SessionListing;
use weave_host_protocol::sessions::TurnOrigin;
use weave_host_protocol::turns::CancelTurnRequest;
use weave_host_protocol::turns::SteerOutcome;
use weave_host_protocol::turns::SteerTurnRequest;

use crate::daemon::ago;
use crate::daemon::control;
use crate::daemon::now_ms;
use crate::daemon::paths;
use crate::exit;
use crate::run::describe_stop;
use crate::run::prompt_text;

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
    /// queue for the running one to end.
    Prompt(PromptArgs),
    /// Send a message into a thread's running turn, without starting another; it fails when no
    /// turn runs.
    Steer(PromptArgs),
    /// Stop the turn a thread is running, as Esc does in the TUI.
    Cancel(SessionArg),
    /// Close a thread for every client: its turn ends and its agent stops. `weave --resume`
    /// can still reopen it from the agent's history.
    Close(SessionArg),
}

#[derive(Args, Default)]
struct ListArgs {
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

    /// Print the Host's answer (`sessions/get`) as JSON.
    #[arg(long)]
    json: bool,
}

#[derive(Args)]
struct PromptArgs {
    #[arg(value_name = "THREAD_ID")]
    session_id: String,

    /// The prompt; read from stdin when omitted or `-`.
    prompt: Vec<String>,
}

pub async fn command(args: SessionsArgs) -> anyhow::Result<()> {
    let paths = paths()?;
    let command = args
        .command
        .unwrap_or_else(|| SessionsCommand::List(ListArgs::default()));
    let Some(connection) = control(&paths).await? else {
        return match command {
            SessionsCommand::List(ListArgs { json: true }) => {
                println!("[]");
                Ok(())
            }
            SessionsCommand::List(_) => {
                println!("The weave Host isn't running, so no threads are open.");
                Ok(())
            }
            SessionsCommand::Read(_)
            | SessionsCommand::Prompt(_)
            | SessionsCommand::Steer(_)
            | SessionsCommand::Cancel(_)
            | SessionsCommand::Close(_) => Err(exit::unreachable(anyhow!(
                "the weave Host isn't running, so no threads are open"
            ))),
        };
    };
    let result = run(&connection, command).await;
    connection.shutdown().await;
    result
}

async fn run(connection: &HostConnection, command: SessionsCommand) -> anyhow::Result<()> {
    match command {
        SessionsCommand::List(ListArgs { json }) => {
            let sessions = open(connection).await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&sessions)?);
            } else {
                print!("{}", describe(&sessions, now_ms()));
            }
        }
        SessionsCommand::Read(ReadArgs { session_id, json }) => {
            let got = connection
                .send(GetSessionRequest {
                    session_id: SessionId::new(session_id),
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
                    eprint!("{}", describe_turn(latest));
                    if let Some(message) = &latest.message {
                        println!("{message}");
                    }
                }
                None => eprintln!("No turns yet."),
            }
        }
        SessionsCommand::Prompt(PromptArgs { session_id, prompt }) => {
            let prompt = prompt_text(&prompt)?;
            find(&open(connection).await?, &session_id)?;
            let queued = connection
                .send(AddQueuedRequest {
                    session_id: SessionId::new(session_id.clone()),
                    prompt: vec![ContentBlock::from(prompt)],
                    key: None,
                })
                .await
                .context("prompting the thread")?;
            if queued.started {
                eprintln!("Started a turn in {session_id}.");
            } else {
                eprintln!("Queued for {session_id}, after the turn it's running.");
            }
        }
        SessionsCommand::Steer(PromptArgs { session_id, prompt }) => {
            let prompt = prompt_text(&prompt)?;
            find(&open(connection).await?, &session_id)?;
            let steered = connection
                .send(SteerTurnRequest {
                    session_id: SessionId::new(session_id.clone()),
                    prompt: vec![ContentBlock::from(prompt)],
                })
                .await
                .context("steering the thread")?;
            match steered.outcome {
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
    }
    Ok(())
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

/// A thread's latest turn: where it came from, how it stands, and its prompt.
fn describe_turn(latest: &LatestTurn) -> String {
    let from = match &latest.origin {
        TurnOrigin::Client { name, device, .. } => device.clone().unwrap_or_else(|| name.clone()),
        TurnOrigin::Run {} => "a headless run".to_owned(),
        TurnOrigin::Session {
            session_id,
            report: false,
        } => format!("thread {session_id}"),
        TurnOrigin::Session {
            session_id,
            report: true,
        } => format!("the Host's report on thread {session_id}"),
    };
    let how = match (&latest.error, &latest.response) {
        _ if latest.running => "running".to_owned(),
        (Some(error), _) => format!("failed: {}", error.message),
        (None, Some(response)) => match response.stop_reason {
            StopReason::EndTurn => "finished".to_owned(),
            reason => format!("stopped: {}", describe_stop(reason)),
        },
        (None, None) => "ended".to_owned(),
    };
    let prompt: Vec<String> = latest
        .prompt
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text(text) => Some(text.text.clone()),
            _ => None,
        })
        .collect();
    let mut out = format!("Latest turn, from {from}, {how}:\n");
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
            prompt: vec![ContentBlock::from(
                "address the review\non the PR".to_owned(),
            )],
            origin: TurnOrigin::Session {
                session_id: "s0".into(),
                report: false,
            },
            started_at: 0,
            running: true,
            response: None,
            error: None,
            message: None,
        };
        assert_eq!(
            describe_turn(&turn),
            "Latest turn, from thread s0, running:\n  > address the review\n  > on the PR\n"
        );
        let finished = LatestTurn {
            origin: TurnOrigin::Run {},
            running: false,
            response: Some(PromptResponse::new(StopReason::EndTurn)),
            ..turn
        };
        assert!(
            describe_turn(&finished).starts_with("Latest turn, from a headless run, finished:")
        );
        let cancelled = LatestTurn {
            origin: TurnOrigin::Session {
                session_id: "s2".into(),
                report: true,
            },
            response: Some(PromptResponse::new(StopReason::Cancelled)),
            ..finished
        };
        assert!(
            describe_turn(&cancelled).starts_with(
                "Latest turn, from the Host's report on thread s2, stopped: cancelled:"
            )
        );
    }
}
