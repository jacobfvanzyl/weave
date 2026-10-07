//! Session lifecycle, sign-in, MCP setup and elicitation against the fake agent.

// Test helpers outside `#[test]` functions fail fast too.
#![allow(clippy::expect_used)]

mod common;

use std::collections::BTreeMap;
use std::path::PathBuf;

use common::ElicitationReply;
use common::Harness;
use common::setup_for;
use common::transcript;
use pretty_assertions::assert_eq;
use weave_acp_core::AgentEvent;
use weave_acp_core::ClientOptions;
use weave_acp_core::SessionSetup;
use weave_acp_core::is_auth_required;
use weave_acp_core::schema::ElicitationContentValue;
use weave_acp_core::schema::ElicitationMode;
use weave_acp_core::schema::McpServer;
use weave_acp_core::schema::McpServerHttp;
use weave_acp_core::schema::McpServerSse;
use weave_acp_core::schema::McpServerStdio;
use weave_acp_core::schema::SessionUpdate;
use weave_fake_agent::FakeAgentConfig;

#[tokio::test]
async fn sessions_list_newest_first_and_paginate_with_opaque_cursors() {
    let config = FakeAgentConfig {
        page_size: 1,
        ..FakeAgentConfig::default()
    };
    let mut harness = Harness::start_with(ClientOptions::default(), config).await;
    harness.turn("first session", "allow").await;
    let second = harness
        .connection
        .new_session(&harness.setup())
        .await
        .expect("second session");
    harness.session_id = second.session_id.clone();
    harness.turn("second session", "allow").await;

    let cwd = harness.setup().cwd;
    let page = harness
        .connection
        .list_sessions(Some(cwd.clone()), None)
        .await
        .expect("list");
    assert_eq!(page.sessions.len(), 1);
    assert_eq!(page.sessions[0].session_id, second.session_id);
    assert_eq!(page.sessions[0].title.as_deref(), Some("second session"));
    let cursor = page.next_cursor.expect("a second page");

    let page = harness
        .connection
        .list_sessions(Some(cwd), Some(cursor))
        .await
        .expect("list page 2");
    assert_eq!(page.sessions[0].title.as_deref(), Some("first session"));
    assert_eq!(page.next_cursor, None);

    let elsewhere = harness
        .connection
        .list_sessions(Some(PathBuf::from("/nowhere")), None)
        .await
        .expect("list");
    assert!(elsewhere.sessions.is_empty());
}

#[tokio::test]
async fn loading_replays_history_before_returning_and_resuming_does_not() {
    let mut harness = Harness::start(ClientOptions::default()).await;
    let original = harness.session_id.clone();
    harness.turn("remember this", "allow").await;
    harness.drain();

    let setup = harness.setup();
    harness
        .connection
        .load_session(original.clone(), &setup)
        .await
        .expect("load");
    let replay = harness.drain();
    let replay = transcript(&replay);
    assert_eq!(
        replay.first().map(String::as_str),
        Some("user: remember this")
    );
    let agent_text: String = replay[1..]
        .iter()
        .filter_map(|line| line.strip_prefix("agent: "))
        .collect();
    assert_eq!(agent_text, "You said: remember this");

    harness
        .connection
        .resume_session(original.clone(), &setup)
        .await
        .expect("resume");
    assert!(transcript(&harness.drain()).is_empty());

    // The resumed session takes prompts again.
    let log = harness.turn("still here", "allow").await;
    assert_eq!(log.message, "You said: still here");
}

#[tokio::test]
async fn closed_sessions_stop_taking_prompts_and_deleted_ones_leave_the_list() {
    let mut harness = Harness::start(ClientOptions::default()).await;
    harness.turn("doomed", "allow").await;
    let session = harness.session_id.clone();

    harness
        .connection
        .close_session(session.clone())
        .await
        .expect("close");
    harness
        .connection
        .prompt(session.clone(), vec!["after close".into()])
        .expect("send prompt");
    let ended = loop {
        if let Some(AgentEvent::TurnEnded { result, .. }) = harness.events.recv().await {
            break result;
        }
    };
    assert!(ended.is_err(), "a closed session must refuse prompts");

    harness
        .connection
        .delete_session(session.clone())
        .await
        .expect("delete");
    // Deleting again succeeds silently.
    harness
        .connection
        .delete_session(session)
        .await
        .expect("delete again");
    let listed = harness
        .connection
        .list_sessions(None, None)
        .await
        .expect("list");
    assert!(listed.sessions.is_empty());
}

#[tokio::test]
async fn sessions_survive_agent_restarts() {
    let state = tempfile::NamedTempFile::new().expect("state file");
    let config = FakeAgentConfig {
        state_path: Some(state.path().to_owned()),
        ..FakeAgentConfig::default()
    };
    let mut first = Harness::start_with(ClientOptions::default(), config.clone()).await;
    first.turn("before restart", "allow").await;
    let session = first.session_id.clone();
    let setup = first.setup();
    first.connection.shutdown().await;

    let (connection, mut events) = Harness::connect(ClientOptions::default(), config).await;
    let listed = connection.list_sessions(None, None).await.expect("list");
    assert_eq!(listed.sessions[0].session_id, session);
    connection
        .load_session(session, &setup)
        .await
        .expect("load");
    let replay: Vec<AgentEvent> = std::iter::from_fn(|| events.try_recv().ok()).collect();
    assert_eq!(
        transcript(&replay).first().map(String::as_str),
        Some("user: before restart")
    );
}

#[tokio::test]
async fn sign_in_gates_sessions_until_authenticated_and_logout_restores_the_gate() {
    let config = FakeAgentConfig {
        require_auth: true,
        ..FakeAgentConfig::default()
    };
    let (connection, _events) = Harness::connect(ClientOptions::default(), config).await;
    let dir = tempfile::tempdir().expect("tempdir");
    let setup = setup_for(&dir);

    let refused = connection
        .new_session(&setup)
        .await
        .expect_err("auth required");
    assert!(is_auth_required(&refused), "{refused:?}");

    // Without terminal-auth support only the agent-driven method is offered.
    let methods = &connection.agent().expect("initialized").auth_methods;
    assert_eq!(methods.len(), 1);
    connection
        .authenticate(methods[0].id().clone())
        .await
        .expect("authenticate");
    connection
        .new_session(&setup)
        .await
        .expect("session after sign-in");

    connection.logout().await.expect("logout");
    let refused = connection
        .new_session(&setup)
        .await
        .expect_err("auth required again");
    assert!(is_auth_required(&refused));
}

#[tokio::test]
async fn terminal_sign_in_methods_are_never_sent_to_authenticate() {
    let options = ClientOptions {
        terminal_auth: true,
        ..ClientOptions::default()
    };
    let (connection, _events) = Harness::connect(options, FakeAgentConfig::default()).await;
    let methods = &connection.agent().expect("initialized").auth_methods;
    assert_eq!(
        methods.len(),
        2,
        "terminal sign-in is offered once the client supports it"
    );
    let refused = connection
        .authenticate("terminal-login".into())
        .await
        .expect_err("client-side refusal");
    assert!(
        refused.to_string().contains("terminal sign-in"),
        "{refused}"
    );
}

#[tokio::test]
async fn mcp_servers_reach_the_agent_and_unadvertised_transports_are_refused_locally() {
    let mut harness = Harness::start(ClientOptions::default()).await;
    let mut setup = harness.setup();
    setup.mcp_servers = vec![
        McpServer::Stdio(McpServerStdio::new("files", "/usr/bin/true")),
        McpServer::Http(McpServerHttp::new("remote", "https://mcp.example.com")),
    ];
    harness.session_id = harness
        .connection
        .new_session(&setup)
        .await
        .expect("session")
        .session_id;
    let log = harness.turn("/mcp", "allow").await;
    assert_eq!(
        log.message,
        "MCP servers: files (stdio /usr/bin/true); remote (http https://mcp.example.com)."
    );

    // The fake agent does not advertise SSE, so the client must not send it.
    setup.mcp_servers = vec![McpServer::Sse(McpServerSse::new(
        "legacy",
        "https://sse.example.com",
    ))];
    let refused = harness
        .connection
        .new_session(&setup)
        .await
        .expect_err("sse refused");
    assert!(
        refused.to_string().contains("mcpCapabilities.sse"),
        "{refused}"
    );
}

#[tokio::test]
async fn additional_directories_need_the_capability_and_are_sent_otherwise() {
    let harness = Harness::start(ClientOptions::default()).await;
    let extra = tempfile::tempdir().expect("extra dir");
    let setup = SessionSetup {
        additional_directories: vec![extra.path().to_owned()],
        ..harness.setup()
    };
    harness
        .connection
        .new_session(&setup)
        .await
        .expect("the fake agent advertises extra roots");
}

#[tokio::test]
async fn form_elicitations_return_the_users_values() {
    let mut harness = Harness::start(ClientOptions::default()).await;
    harness.elicitation_reply = ElicitationReply::Accept(Some(BTreeMap::from([
        ("name".to_owned(), ElicitationContentValue::from("Ada")),
        ("age".to_owned(), ElicitationContentValue::Integer(36)),
        (
            "toppings".to_owned(),
            ElicitationContentValue::StringArray(vec!["cheese".into(), "basil".into()]),
        ),
    ])));
    let log = harness.turn("/ask", "allow").await;

    let request = log.elicitations.first().expect("an elicitation");
    let ElicitationMode::Form(form) = &request.mode else {
        panic!("expected a form");
    };
    assert_eq!(
        form.requested_schema.required.as_deref(),
        Some(&["name".to_owned()][..])
    );
    assert_eq!(
        log.message,
        "Thanks! You told me: age=36, name=Ada, toppings=[cheese basil]."
    );

    harness.elicitation_reply = ElicitationReply::Decline;
    assert_eq!(
        harness.turn("/ask", "allow").await.message,
        "You declined to answer."
    );
}

#[tokio::test]
async fn url_elicitations_complete_out_of_band() {
    let mut harness = Harness::start(ClientOptions::default()).await;
    harness.elicitation_reply = ElicitationReply::Accept(None);
    let log = harness.turn("/connect", "allow").await;

    let ElicitationMode::Url(url) = &log.elicitations[0].mode else {
        panic!("expected a URL elicitation");
    };
    assert!(url.url.starts_with("https://example.com/"));
    assert_eq!(log.completions, std::slice::from_ref(&url.elicitation_id));
    assert!(log.message.ends_with("Connected."), "{}", log.message);
}

#[tokio::test]
async fn agents_fall_back_when_elicitation_is_not_offered() {
    let options = ClientOptions {
        elicitation: false,
        ..ClientOptions::default()
    };
    let mut harness = Harness::start(options).await;
    let log = harness.turn("/ask", "allow").await;
    assert!(log.elicitations.is_empty());
    assert_eq!(log.message, "The client does not offer form elicitation.");
    assert!(
        log.updates
            .iter()
            .all(|update| !matches!(update, SessionUpdate::ToolCall(_)))
    );
}
