//! ACP v1 conformance: every method in the schema crate's method lists, and every
//! `session/update` kind, observed on the wire between the real client and the fake agent.
//!
//! The transport is an in-process tap that records each JSON-RPC message in both directions,
//! so the assertions are about what was actually exchanged, not what the code intended.

// Test helpers outside `#[test]` functions fail fast too.
#![allow(clippy::expect_used)]

use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use agent_client_protocol::Lines;
use futures::SinkExt;
use futures::StreamExt;
use futures::channel::mpsc;
use pretty_assertions::assert_eq;
use serde_json::Value;
use weave_acp_core::AgentConnection;
use weave_acp_core::AgentEvent;
use weave_acp_core::ClientOptions;
use weave_acp_core::SessionSetup;
use weave_acp_core::is_auth_required;
use weave_acp_core::schema::AGENT_METHOD_NAMES;
use weave_acp_core::schema::AudioContent;
use weave_acp_core::schema::CLIENT_METHOD_NAMES;
use weave_acp_core::schema::ContentBlock;
use weave_acp_core::schema::ElicitationContentValue;
use weave_acp_core::schema::EmbeddedResource;
use weave_acp_core::schema::EmbeddedResourceResource;
use weave_acp_core::schema::ImageContent;
use weave_acp_core::schema::McpServer;
use weave_acp_core::schema::McpServerHttp;
use weave_acp_core::schema::McpServerStdio;
use weave_acp_core::schema::PROTOCOL_LEVEL_METHOD_NAMES;
use weave_acp_core::schema::ResourceLink;
use weave_acp_core::schema::SessionConfigOptionValue;
use weave_acp_core::schema::SessionId;
use weave_acp_core::schema::StopReason;
use weave_acp_core::schema::TextContent;
use weave_acp_core::schema::TextResourceContents;
use weave_fake_agent::FakeAgentConfig;

/// Every `session/update` kind in ACP v1 (`SessionUpdate` in the schema crate).
const UPDATE_KINDS: [&str; 11] = [
    "user_message_chunk",
    "agent_message_chunk",
    "agent_thought_chunk",
    "tool_call",
    "tool_call_update",
    "plan",
    "available_commands_update",
    "current_mode_update",
    "config_option_update",
    "session_info_update",
    "usage_update",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Direction {
    ClientToAgent,
    AgentToClient,
}

type Wire = Arc<Mutex<Vec<(Direction, Value)>>>;

/// Connect the client to a fake agent through a recording tap.
async fn connect_tapped(
    options: ClientOptions,
    config: FakeAgentConfig,
) -> (
    AgentConnection,
    tokio::sync::mpsc::UnboundedReceiver<AgentEvent>,
    Wire,
) {
    let wire: Wire = Arc::default();
    let (client_out, from_client) = mpsc::unbounded::<String>();
    let (to_agent, agent_in) = mpsc::unbounded::<String>();
    let (agent_out, from_agent) = mpsc::unbounded::<String>();
    let (to_client, client_in) = mpsc::unbounded::<String>();
    tokio::spawn(relay(
        from_client,
        to_agent,
        Direction::ClientToAgent,
        Arc::clone(&wire),
    ));
    tokio::spawn(relay(
        from_agent,
        to_client,
        Direction::AgentToClient,
        Arc::clone(&wire),
    ));

    let sink = |sender: mpsc::UnboundedSender<String>| sender.sink_map_err(std::io::Error::other);
    let agent = Lines::new(sink(agent_out), agent_in.map(Ok));
    tokio::spawn(weave_fake_agent::serve_with(agent, config));
    let client = Lines::new(sink(client_out), client_in.map(Ok));
    let (connection, events) = AgentConnection::connect(client, options)
        .await
        .expect("connect");
    (connection, events, wire)
}

async fn relay(
    mut from: mpsc::UnboundedReceiver<String>,
    to: mpsc::UnboundedSender<String>,
    direction: Direction,
    wire: Wire,
) {
    while let Some(line) = from.next().await {
        let message = serde_json::from_str(&line).expect("every line is JSON-RPC");
        wire.lock().expect("wire").push((direction, message));
        if to.unbounded_send(line).is_err() {
            break;
        }
    }
}

/// Methods each side sent, from requests and notifications.
fn methods_sent(wire: &Wire) -> BTreeMap<Direction, BTreeSet<String>> {
    let mut sent: BTreeMap<Direction, BTreeSet<String>> = BTreeMap::new();
    for (direction, message) in wire.lock().expect("wire").iter() {
        let messages = match message {
            Value::Array(batch) => batch.clone(),
            message => vec![message.clone()],
        };
        for message in messages {
            if let Some(method) = message.get("method").and_then(Value::as_str) {
                sent.entry(*direction)
                    .or_default()
                    .insert(method.to_owned());
            }
        }
    }
    sent
}

fn update_kinds(wire: &Wire) -> BTreeSet<String> {
    wire.lock()
        .expect("wire")
        .iter()
        .filter(|(_, message)| {
            message.get("method").and_then(Value::as_str) == Some("session/update")
        })
        .filter_map(|(_, message)| {
            message
                .pointer("/params/update/sessionUpdate")?
                .as_str()
                .map(str::to_owned)
        })
        .collect()
}

/// The method names in one of the schema crate's method-name tables.
fn names(table: impl serde::Serialize) -> BTreeSet<String> {
    let Value::Object(table) = serde_json::to_value(table).expect("method table") else {
        panic!("method tables serialize as objects");
    };
    table
        .values()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

/// Run a prompt, answering permissions with `answer` ("hold" leaves them for the agent to
/// withdraw), accepting elicitations, and cancelling once `cancel_after` updates arrived.
async fn turn(
    connection: &AgentConnection,
    events: &mut tokio::sync::mpsc::UnboundedReceiver<AgentEvent>,
    session: &SessionId,
    prompt: &str,
    answer: &str,
    cancel_after: Option<usize>,
) -> StopReason {
    let blocks = vec![ContentBlock::Text(TextContent::new(prompt))];
    turn_with(connection, events, session, blocks, answer, cancel_after).await
}

async fn turn_with(
    connection: &AgentConnection,
    events: &mut tokio::sync::mpsc::UnboundedReceiver<AgentEvent>,
    session: &SessionId,
    blocks: Vec<ContentBlock>,
    answer: &str,
    cancel_after: Option<usize>,
) -> StopReason {
    let prompt = format!("{:?}", blocks.first());
    connection.prompt(session.clone(), blocks).expect("prompt");
    let mut updates = 0;
    let mut held = Vec::new();
    loop {
        let event = tokio::time::timeout(Duration::from_secs(10), events.recv())
            .await
            .unwrap_or_else(|_| panic!("{prompt}: timed out"))
            .expect("events");
        match event {
            AgentEvent::SessionUpdate(_) => {
                updates += 1;
                if cancel_after == Some(updates) {
                    connection.cancel(session.clone()).expect("cancel");
                }
            }
            AgentEvent::PermissionRequested(request) if answer == "hold" => held.push(request),
            AgentEvent::PermissionRequested(request) => {
                let option = request
                    .request
                    .options
                    .iter()
                    .find(|option| option.option_id.to_string() == answer);
                let option = option.expect("permission option").option_id.clone();
                request.select(option).expect("answer");
            }
            AgentEvent::RequestWithdrawn(key) => {
                let index = held
                    .iter()
                    .position(|request| request.key == key)
                    .expect("held request");
                held.remove(index).withdrawn().expect("answer withdrawal");
            }
            AgentEvent::ElicitationRequested(request) => {
                let content =
                    BTreeMap::from([("name".to_owned(), ElicitationContentValue::from("Ada"))]);
                request.accept(Some(content)).expect("accept");
            }
            AgentEvent::TurnEnded { result, .. } => {
                return result.expect("prompt response").stop_reason;
            }
            AgentEvent::Disconnected(error) => panic!("disconnected: {error:?}"),
            _ => {}
        }
    }
}

#[tokio::test]
async fn every_v1_method_and_update_kind_crosses_the_wire() {
    let config = FakeAgentConfig {
        require_auth: true,
        ..FakeAgentConfig::default()
    };
    let (connection, mut events, wire) = connect_tapped(ClientOptions::default(), config).await;
    connection.initialize().await.expect("initialize");

    let dir = tempfile::tempdir().expect("tempdir");
    let extra = tempfile::tempdir().expect("extra root");
    let setup = SessionSetup {
        cwd: dir.path().canonicalize().expect("cwd"),
        additional_directories: vec![extra.path().to_owned()],
        mcp_servers: vec![
            McpServer::Stdio(McpServerStdio::new("tools", "/bin/sh")),
            McpServer::Http(McpServerHttp::new("docs", "https://mcp.example.com")),
        ],
    };

    // Sign-in gates session work until it succeeds.
    let refused = connection
        .new_session(&setup)
        .await
        .expect_err("auth required first");
    assert!(is_auth_required(&refused));
    connection
        .authenticate("token".into())
        .await
        .expect("authenticate");
    let session = connection
        .new_session(&setup)
        .await
        .expect("session/new")
        .session_id;

    let file = setup.cwd.join("notes.txt");
    let file = file.display();
    let mut turns = vec![
        ("hello", "allow", None),
        ("/think", "allow", None),
        ("/plan", "allow", None),
        ("/switch-mode", "allow", None),
        ("/run echo hi", "allow", None),
        ("/kill-after 100 sleep 5", "allow", None),
        ("/ask", "allow", None),
        ("/connect", "allow", None),
        ("/withdraw", "hold", None),
        ("/extension", "allow", None),
    ];
    let write = format!("/write {file} hello");
    let read = format!("/read {file}");
    turns.insert(4, (write.as_str(), "allow", None));
    turns.insert(5, (read.as_str(), "allow", None));
    for (prompt, answer, cancel_after) in turns {
        let stop = turn(
            &connection,
            &mut events,
            &session,
            prompt,
            answer,
            cancel_after,
        )
        .await;
        assert_eq!(stop, StopReason::EndTurn, "{prompt}");
    }
    // Every content block type in one prompt; the agent advertised every prompt capability.
    let uri = format!("file://{file}");
    let blocks = vec![
        ContentBlock::Text(TextContent::new("look at these")),
        ContentBlock::Image(ImageContent::new("iVBORw0KGgo=", "image/png")),
        ContentBlock::Audio(AudioContent::new("UklGRg==", "audio/wav")),
        ContentBlock::Resource(EmbeddedResource::new(
            EmbeddedResourceResource::TextResourceContents(TextResourceContents::new(
                "hello",
                uri.clone(),
            )),
        )),
        ContentBlock::ResourceLink(ResourceLink::new("notes.txt", uri)),
    ];
    let stop = turn_with(&connection, &mut events, &session, blocks, "allow", None).await;
    assert_eq!(stop, StopReason::EndTurn);

    let stop = turn(
        &connection,
        &mut events,
        &session,
        "/slow 50",
        "allow",
        Some(2),
    )
    .await;
    assert_eq!(stop, StopReason::Cancelled);

    connection
        .set_mode(session.clone(), "ask".into())
        .await
        .expect("set_mode");
    connection
        .set_config_option(
            session.clone(),
            "model".into(),
            SessionConfigOptionValue::value_id("large"),
        )
        .await
        .expect("set_config_option");

    let listed = connection
        .list_sessions(Some(setup.cwd.clone()), None)
        .await
        .expect("session/list");
    assert_eq!(listed.sessions.len(), 1);
    connection
        .load_session(session.clone(), &setup)
        .await
        .expect("session/load");
    connection
        .resume_session(session.clone(), &setup)
        .await
        .expect("session/resume");
    connection
        .close_session(session.clone())
        .await
        .expect("session/close");
    let doomed = connection
        .new_session(&setup)
        .await
        .expect("second session")
        .session_id;
    connection
        .delete_session(doomed)
        .await
        .expect("session/delete");
    connection.logout().await.expect("logout");

    let sent = methods_sent(&wire);
    let client_sent = sent
        .get(&Direction::ClientToAgent)
        .cloned()
        .unwrap_or_default();
    let agent_sent = sent
        .get(&Direction::AgentToClient)
        .cloned()
        .unwrap_or_default();

    // Guard against a vacuous pass: ACP v1 stable has 13 agent methods, 11 client methods
    // and one protocol-level method.
    assert_eq!(
        (
            names(AGENT_METHOD_NAMES).len(),
            names(CLIENT_METHOD_NAMES).len(),
            names(PROTOCOL_LEVEL_METHOD_NAMES).len()
        ),
        (13, 11, 1)
    );

    let agent_methods = names(AGENT_METHOD_NAMES);
    let missing: Vec<_> = agent_methods.difference(&client_sent).collect();
    assert!(
        missing.is_empty(),
        "agent methods the client never called: {missing:?}"
    );

    let client_methods = names(CLIENT_METHOD_NAMES);
    let missing: Vec<_> = client_methods.difference(&agent_sent).collect();
    assert!(
        missing.is_empty(),
        "client methods never exercised: {missing:?}"
    );

    for method in names(PROTOCOL_LEVEL_METHOD_NAMES) {
        assert!(
            agent_sent.contains(&method),
            "{method} never crossed the wire"
        );
    }

    let kinds = update_kinds(&wire);
    let missing: Vec<_> = UPDATE_KINDS
        .iter()
        .filter(|kind| !kinds.contains(**kind))
        .collect();
    assert!(
        missing.is_empty(),
        "session/update kinds never observed: {missing:?}"
    );

    let content_types: BTreeSet<String> = wire
        .lock()
        .expect("wire")
        .iter()
        .filter(|(_, message)| {
            message.get("method").and_then(Value::as_str) == Some("session/prompt")
        })
        .flat_map(|(_, message)| {
            message
                .pointer("/params/prompt")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
        })
        .filter_map(|block| block.get("type").and_then(Value::as_str).map(str::to_owned))
        .collect();
    assert_eq!(
        content_types,
        ["audio", "image", "resource", "resource_link", "text"]
            .map(str::to_owned)
            .into(),
        "every content block type is sent"
    );

    // An unknown `_` request from the agent is answered with "method not found" (-32601).
    let wire_log = wire.lock().expect("wire").clone();
    let ping_id = wire_log
        .iter()
        .find(|(_, message)| {
            message.get("method").and_then(Value::as_str) == Some("_weave_fake/ping")
        })
        .and_then(|(_, message)| message.get("id").cloned())
        .expect("the agent sent _weave_fake/ping");
    let answer = wire_log
        .iter()
        .find(|(direction, message)| {
            *direction == Direction::ClientToAgent
                && message.get("id") == Some(&ping_id)
                && message.get("method").is_none()
        })
        .map(|(_, message)| message.clone())
        .expect("the client answered _weave_fake/ping");
    assert_eq!(
        answer.pointer("/error/code").and_then(Value::as_i64),
        Some(-32601)
    );

    // The client only ever sends agent methods; the agent sends client methods, plus the
    // `_`-prefixed extension traffic used above.
    assert!(
        client_sent.is_subset(
            &agent_methods
                .union(&names(PROTOCOL_LEVEL_METHOD_NAMES))
                .cloned()
                .collect()
        )
    );
    let standard_or_extension = |method: &String| {
        client_methods.contains(method)
            || names(PROTOCOL_LEVEL_METHOD_NAMES).contains(method)
            || method.starts_with('_')
    };
    assert!(
        agent_sent.iter().all(standard_or_extension),
        "{agent_sent:?}"
    );
}

#[tokio::test]
async fn unadvertised_methods_are_refused_without_touching_the_wire() {
    let config = FakeAgentConfig {
        minimal: true,
        ..FakeAgentConfig::default()
    };
    let (connection, _events, wire) = connect_tapped(ClientOptions::default(), config).await;
    connection.initialize().await.expect("initialize");
    let dir = tempfile::tempdir().expect("tempdir");
    let setup = SessionSetup {
        cwd: dir.path().canonicalize().expect("cwd"),
        ..SessionSetup::default()
    };
    let session = connection
        .new_session(&setup)
        .await
        .expect("session/new")
        .session_id;

    let http = SessionSetup {
        mcp_servers: vec![McpServer::Http(McpServerHttp::new(
            "docs",
            "https://mcp.example.com",
        ))],
        ..setup.clone()
    };
    let extra_root = SessionSetup {
        additional_directories: vec![dir.path().to_owned()],
        ..setup.clone()
    };
    let refusals = [
        connection.list_sessions(None, None).await.map(drop),
        connection
            .load_session(session.clone(), &setup)
            .await
            .map(drop),
        connection
            .resume_session(session.clone(), &setup)
            .await
            .map(drop),
        connection.close_session(session.clone()).await,
        connection.delete_session(session.clone()).await,
        connection.logout().await,
        connection.new_session(&http).await.map(drop),
        connection.new_session(&extra_root).await.map(drop),
    ];
    assert!(refusals.iter().all(Result::is_err), "{refusals:?}");

    let client_sent = methods_sent(&wire)
        .remove(&Direction::ClientToAgent)
        .unwrap_or_default();
    assert_eq!(
        client_sent,
        BTreeSet::from(["initialize".to_owned(), "session/new".to_owned()]),
        "nothing gated may reach the agent"
    );
}
