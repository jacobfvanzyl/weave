//! Opt-in acceptance against real ACP adapters, using their existing logins.
//!
//! ```bash
//! WEAVE_LIVE_AGENTS=claude,codex cargo test -p weave-acp-core --test live_agents -- --ignored --nocapture
//! ```
//!
//! For each agent: a prompt turn, a permission request (rejected, leaving no file), a
//! cancellation, and a session resume on a fresh connection that remembers the first turn.

// Test helpers outside `#[test]` functions fail fast too.
#![allow(clippy::expect_used)]

use std::path::Path;
use std::time::Duration;

use tokio::sync::mpsc::UnboundedReceiver;
use weave_acp_core::AgentConnection;
use weave_acp_core::AgentEvent;
use weave_acp_core::AgentSpec;
use weave_acp_core::ClientOptions;
use weave_acp_core::SessionSetup;
use weave_acp_core::schema::ContentBlock;
use weave_acp_core::schema::PermissionOptionKind;
use weave_acp_core::schema::SessionId;
use weave_acp_core::schema::SessionModeId;
use weave_acp_core::schema::SessionUpdate;
use weave_acp_core::schema::StopReason;
use weave_acp_core::schema::TextContent;

const TURN_TIMEOUT: Duration = Duration::from_secs(180);

#[derive(Default)]
struct Turn {
    message: String,
    permission_requests: usize,
    stop_reason: Option<StopReason>,
}

async fn connect(id: &str) -> (AgentConnection, UnboundedReceiver<AgentEvent>) {
    let spec = AgentSpec::preset(id).expect("preset");
    let (connection, events) = AgentConnection::spawn(&spec, None, ClientOptions::default())
        .await
        .expect("spawn");
    connection.initialize().await.expect("initialize");
    (connection, events)
}

/// Run a prompt; reject every permission request; cancel after `cancel_after_chunks` chunks.
async fn run(
    connection: &AgentConnection,
    events: &mut UnboundedReceiver<AgentEvent>,
    session: &SessionId,
    prompt: &str,
    cancel_after_chunks: Option<usize>,
) -> Turn {
    connection
        .prompt(
            session.clone(),
            vec![ContentBlock::Text(TextContent::new(prompt))],
        )
        .expect("prompt");
    let mut turn = Turn::default();
    let mut chunks = 0;
    loop {
        let event = tokio::time::timeout(TURN_TIMEOUT, events.recv())
            .await
            .unwrap_or_else(|_| panic!("timed out: {prompt}"))
            .expect("events");
        match event {
            AgentEvent::SessionUpdate(notification) => {
                if let SessionUpdate::AgentMessageChunk(chunk) = &notification.update {
                    chunks += 1;
                    if let ContentBlock::Text(text) = &chunk.content {
                        turn.message.push_str(&text.text);
                    }
                    if cancel_after_chunks == Some(chunks) {
                        connection.cancel(session.clone()).expect("cancel");
                    }
                }
            }
            AgentEvent::PermissionRequested(request) => {
                turn.permission_requests += 1;
                let reject = request
                    .request
                    .options
                    .iter()
                    .find(|option| option.kind == PermissionOptionKind::RejectOnce)
                    .map(|option| option.option_id.clone());
                match reject {
                    Some(option) => request.select(option).expect("reject"),
                    None => request.cancel().expect("cancel permission"),
                }
            }
            AgentEvent::ElicitationRequested(request) => request.cancel().expect("dismiss"),
            AgentEvent::TurnEnded { result, .. } => {
                turn.stop_reason = Some(result.expect("prompt response").stop_reason);
                return turn;
            }
            AgentEvent::Disconnected(error) => panic!("disconnected: {error:?}"),
            _ => {}
        }
    }
}

/// Codex writes inside the workspace without asking unless it is in read-only mode.
async fn require_approval(id: &str, connection: &AgentConnection, session: &SessionId) {
    if id == "codex" {
        connection
            .set_mode(session.clone(), SessionModeId::new("read-only"))
            .await
            .expect("read-only mode");
    }
}

async fn accept(id: &str) {
    let dir = tempfile::tempdir().expect("tempdir");
    let setup = SessionSetup {
        cwd: dir.path().canonicalize().expect("cwd"),
        ..SessionSetup::default()
    };
    let (connection, mut events) = connect(id).await;
    let session = connection
        .new_session(&setup)
        .await
        .expect("session/new")
        .session_id;
    eprintln!("[{id}] session {session}");

    let turn = run(
        &connection,
        &mut events,
        &session,
        "Reply with exactly the word ORCHID and nothing else.",
        None,
    )
    .await;
    assert_eq!(
        turn.stop_reason,
        Some(StopReason::EndTurn),
        "[{id}] prompt turn"
    );
    assert!(
        turn.message.contains("ORCHID"),
        "[{id}] reply: {:?}",
        turn.message
    );
    eprintln!("[{id}] prompt turn ok");

    require_approval(id, &connection, &session).await;
    let turn = run(
        &connection,
        &mut events,
        &session,
        "Create a file named acceptance.txt in the current directory containing the word hi. \
         Use your file-writing tool directly; do not ask me in chat.",
        None,
    )
    .await;
    assert!(
        turn.permission_requests > 0,
        "[{id}] expected a permission request: {:?}",
        turn.message
    );
    assert!(
        !Path::new(&setup.cwd).join("acceptance.txt").exists(),
        "[{id}] a rejected write landed"
    );
    eprintln!(
        "[{id}] permission request rejected ({} asked)",
        turn.permission_requests
    );

    let turn = run(
        &connection,
        &mut events,
        &session,
        "Count from 1 to 300, one number per line, with a short comment on each.",
        Some(2),
    )
    .await;
    assert_eq!(
        turn.stop_reason,
        Some(StopReason::Cancelled),
        "[{id}] cancellation"
    );
    eprintln!("[{id}] cancellation ok");

    connection.shutdown().await;
    let (connection, mut events) = connect(id).await;
    connection
        .resume_session(session.clone(), &setup)
        .await
        .expect("session/resume");
    let turn = run(
        &connection,
        &mut events,
        &session,
        "What exact word did my first message in this conversation ask you to reply with? \
         Reply with just that word.",
        None,
    )
    .await;
    assert!(
        turn.message.contains("ORCHID"),
        "[{id}] resumed session forgot: {:?}",
        turn.message
    );
    eprintln!("[{id}] resume ok");
    connection.shutdown().await;
}

#[tokio::test]
#[ignore = "talks to real agents with their logins; run with WEAVE_LIVE_AGENTS and --ignored"]
async fn live_agents_pass_acceptance() {
    let agents = std::env::var("WEAVE_LIVE_AGENTS").unwrap_or_else(|_| "claude,codex".to_owned());
    for id in agents.split(',').map(str::trim).filter(|id| !id.is_empty()) {
        accept(id).await;
    }
}
