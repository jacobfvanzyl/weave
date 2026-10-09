//! `weave sessions`: the sessions open in the daemon, and stopping or closing one without
//! attaching to it.

use anyhow::Context;
use anyhow::bail;
use clap::Args;
use clap::Subcommand;
use weave_acp_core::AgentConnection;
use weave_acp_core::daemon_protocol::Activity;
use weave_acp_core::daemon_protocol::AgentChoice;
use weave_acp_core::daemon_protocol::EndSessionRequest;
use weave_acp_core::daemon_protocol::LiveSession;
use weave_acp_core::daemon_protocol::StatusRequest;
use weave_acp_core::schema::SessionId;

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
    /// List the sessions open in the daemon (the default).
    List(ListArgs),
    /// Stop the turn a session is running, as Esc does in the TUI.
    Cancel(SessionArg),
    /// Close a session for every client: its turn ends and its agent stops. `weave --resume`
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
                println!("The weave daemon isn't running, so no sessions are open.");
                Ok(())
            }
            SessionsCommand::Cancel(_) | SessionsCommand::Close(_) => {
                bail!("the weave daemon isn't running, so no sessions are open")
            }
        };
    };
    let result = run(&connection, command).await;
    connection.shutdown().await;
    result
}

async fn run(connection: &AgentConnection, command: SessionsCommand) -> anyhow::Result<()> {
    let sessions = connection.extension(StatusRequest {}).await?.sessions;
    match command {
        SessionsCommand::List(ListArgs { json: true }) => {
            println!("{}", serde_json::to_string_pretty(&sessions)?);
        }
        SessionsCommand::List(_) => print!("{}", describe(&sessions, now_ms())),
        SessionsCommand::Cancel(SessionArg { session_id }) => {
            let session = find(&sessions, &session_id)?;
            if session.activity == Activity::Idle {
                eprintln!("No turn is running in {session_id}.");
                return Ok(());
            }
            connection.cancel(SessionId::new(session_id.clone()))?;
            eprintln!("Asked the agent to stop the turn in {session_id}.");
        }
        SessionsCommand::Close(SessionArg { session_id }) => {
            find(&sessions, &session_id)?;
            connection
                .extension(EndSessionRequest {
                    session_id: SessionId::new(session_id.clone()),
                })
                .await
                .context("closing the session")?;
            eprintln!("Closed {session_id}; weave --resume {session_id} reopens it.");
        }
    }
    Ok(())
}

fn find<'a>(sessions: &'a [LiveSession], session_id: &str) -> anyhow::Result<&'a LiveSession> {
    sessions
        .iter()
        .find(|session| session.session_id.to_string() == session_id)
        .with_context(|| {
            format!("{session_id} isn't open in the daemon (`weave sessions` lists those that are)")
        })
}

fn describe(sessions: &[LiveSession], now_ms: u64) -> String {
    if sessions.is_empty() {
        return "No sessions open.\n".to_owned();
    }
    let mut out = String::new();
    for session in sessions {
        let activity = match session.activity {
            Activity::Idle => "idle",
            Activity::Running => "running",
            Activity::Waiting => "waiting on you",
        };
        let clients = match session.clients {
            0 => "no clients".to_owned(),
            1 => "1 client".to_owned(),
            count => format!("{count} clients"),
        };
        let headless = if session.policy.is_headless() {
            ", headless"
        } else {
            ""
        };
        let agent = session
            .choice
            .as_ref()
            .map_or_else(|| session.agent.clone(), AgentChoice::describe);
        let about = match &session.title {
            Some(title) => format!("{title} · {agent}"),
            None => agent,
        };
        out.push_str(&format!(
            "{}  {activity}, {clients}{headless}, active {} ago\n  {about}\n  in {}\n",
            session.session_id,
            ago(now_ms, session.last_activity_ms),
            session.cwd.display(),
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;
    use weave_acp_core::policy::PermissionPolicy;

    use super::*;

    #[test]
    fn each_session_says_what_its_doing() {
        assert_eq!(describe(&[], 0), "No sessions open.\n");
        let session = LiveSession {
            session_id: "s1".into(),
            cwd: "/repo".into(),
            agent: "npx claude-agent-acp".into(),
            choice: Some(AgentChoice::Named("claude".into())),
            title: Some("Fix the build".into()),
            activity: Activity::Waiting,
            clients: 0,
            policy: PermissionPolicy::headless(Vec::new()),
            started_at_ms: 0,
            last_activity_ms: 30_000,
        };
        assert_eq!(
            describe(std::slice::from_ref(&session), 7_230_000),
            "s1  waiting on you, no clients, headless, active 2h ago\n  Fix the build · claude\n  in \
             /repo\n"
        );
        assert!(find(&[session], "s2").is_err());
    }
}
