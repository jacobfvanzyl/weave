//! `weave sessions`: the sessions open in the weave Host, and stopping or closing one
//! without attaching to it.

use anyhow::Context;
use anyhow::bail;
use clap::Args;
use clap::Subcommand;
use weave_acp_core::schema::SessionId;
use weave_host_client::HostConnection;
use weave_host_protocol::host::StatusRequest;
use weave_host_protocol::sessions::Activity;
use weave_host_protocol::sessions::CloseSessionRequest;
use weave_host_protocol::sessions::SessionListing;
use weave_host_protocol::turns::CancelTurnRequest;

use crate::daemon::ago;
use crate::daemon::control;
use crate::daemon::now_ms;
use crate::daemon::paths;

#[derive(Args)]
pub struct SessionsArgs {
    #[command(subcommand)]
    command: Option<SessionsCommand>,
}

#[derive(Subcommand)]
enum SessionsCommand {
    /// List the threads open in the weave Host (the default).
    List(ListArgs),
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
            SessionsCommand::Cancel(_) | SessionsCommand::Close(_) => {
                bail!("the weave Host isn't running, so no threads are open")
            }
        };
    };
    let result = run(&connection, command).await;
    connection.shutdown().await;
    result
}

async fn run(connection: &HostConnection, command: SessionsCommand) -> anyhow::Result<()> {
    let sessions = connection.send(StatusRequest {}).await?.sessions;
    match command {
        SessionsCommand::List(ListArgs { json: true }) => {
            println!("{}", serde_json::to_string_pretty(&sessions)?);
        }
        SessionsCommand::List(_) => print!("{}", describe(&sessions, now_ms())),
        SessionsCommand::Cancel(SessionArg { session_id }) => {
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
            find(&sessions, &session_id)?;
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

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;
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
}
