//! The daemon end to end: real clients (`weave-acp-core`) connected in-process to a daemon
//! whose agents are in-process fake agents sharing one state file, as separate processes of
//! one agent would share its storage.

#![allow(clippy::expect_used)]

use std::collections::BTreeMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use agent_client_protocol::Channel;
use agent_client_protocol::Error;
use pretty_assertions::assert_eq;
use tokio::sync::mpsc::UnboundedReceiver;
use weave_acp_core::AgentConnection;
use weave_acp_core::AgentEvent;
use weave_acp_core::AgentSpec;
use weave_acp_core::ClientOptions;
use weave_acp_core::SessionSetup;
use weave_acp_core::daemon_protocol;
use weave_acp_core::daemon_protocol::Activity;
use weave_acp_core::daemon_protocol::AgentChoice;
use weave_acp_core::daemon_protocol::ClientHello;
use weave_acp_core::daemon_protocol::DaemonHello;
use weave_acp_core::daemon_protocol::Launch;
use weave_acp_core::daemon_protocol::PROTOCOL_VERSION;
use weave_acp_core::daemon_protocol::PermissionPolicy;
use weave_acp_core::daemon_protocol::RunRequest;
use weave_acp_core::daemon_protocol::StatusRequest;
use weave_acp_core::daemon_protocol::Unapproved;
use weave_acp_core::schema::ContentBlock;
use weave_acp_core::schema::SessionId;
use weave_acp_core::schema::SessionUpdate;
use weave_acp_core::schema::StopReason;
use weave_acp_core::schema::ToolKind;
use weave_daemon::Daemon;
use weave_daemon::DaemonConfig;
use weave_daemon::Launcher;
use weave_fake_agent::FakeAgentConfig;

const WAIT: Duration = Duration::from_secs(10);

/// Fake agents in-process, sharing `state` so sessions outlive any one of them.
fn fake_agents(state: PathBuf, require_auth: bool) -> Launcher {
    Arc::new(move |_launch: &Launch, options: ClientOptions, _traces| {
        let config = FakeAgentConfig {
            state_path: Some(state.clone()),
            require_auth,
            ..FakeAgentConfig::default()
        };
        Box::pin(async move {
            let (client, agent) = Channel::duplex();
            tokio::spawn(weave_fake_agent::serve_with(agent, config));
            AgentConnection::connect(client, options)
                .await
                .map_err(|error| Error::internal_error().data(error.to_string()))
        })
    })
}

struct World {
    dir: tempfile::TempDir,
}

impl World {
    fn new() -> Self {
        Self {
            dir: tempfile::tempdir().expect("tempdir"),
        }
    }

    fn daemon(&self, journals: bool, idle_grace: Duration) -> Daemon {
        Daemon::new(DaemonConfig {
            journals: journals.then(|| self.dir.path().join("sessions")),
            idle_grace,
            launcher: fake_agents(self.dir.path().join("agent-state.json"), false),
        })
    }

    fn cwd(&self) -> PathBuf {
        self.dir.path().to_path_buf()
    }

    fn launch(&self) -> Launch {
        self.launch_of(AgentChoice::Named("fake".into()))
    }

    fn launch_of(&self, choice: AgentChoice) -> Launch {
        Launch {
            spec: AgentSpec::new("fake-agent", Vec::<String>::new()),
            choice: Some(choice),
            cwd: self.cwd(),
            environment: BTreeMap::new(),
            trace: None,
        }
    }

    fn setup(&self) -> SessionSetup {
        SessionSetup {
            cwd: self.cwd(),
            ..SessionSetup::default()
        }
    }

    async fn client(&self, daemon: &Daemon) -> TestClient {
        self.client_with(daemon, ClientOptions::default(), self.launch())
            .await
            .expect("initialize")
    }

    async fn client_with(
        &self,
        daemon: &Daemon,
        options: ClientOptions,
        launch: Launch,
    ) -> Result<TestClient, weave_acp_core::InitializeError> {
        let (connection, events) = AgentConnection::connect(daemon.connect_in_process(), options)
            .await
            .expect("connect");
        let hello = ClientHello {
            protocol: PROTOCOL_VERSION,
            launch: Some(launch),
        };
        let init = connection
            .initialize_with(Some(daemon_protocol::meta(&hello)))
            .await?;
        let daemon_hello: Option<DaemonHello> = daemon_protocol::read_meta(init.meta.as_ref());
        assert_eq!(
            daemon_hello.map(|hello| hello.protocol),
            Some(PROTOCOL_VERSION)
        );
        Ok(TestClient { connection, events })
    }
}

struct TestClient {
    connection: AgentConnection,
    events: UnboundedReceiver<AgentEvent>,
}

/// What a client saw, flattened for assertions.
#[derive(Default, Debug)]
struct Seen {
    user: String,
    agent: String,
    terminal: String,
    turns_running: usize,
    ended: Option<StopReason>,
}

impl TestClient {
    async fn new_session(&self, world: &World) -> SessionId {
        self.connection
            .new_session(&world.setup())
            .await
            .expect("session/new")
            .session_id
    }

    fn prompt(&self, session_id: &SessionId, text: &str) {
        self.connection
            .prompt(
                session_id.clone(),
                vec![ContentBlock::from(text.to_owned())],
            )
            .expect("session/prompt");
    }

    async fn next(&mut self) -> AgentEvent {
        tokio::time::timeout(WAIT, self.events.recv())
            .await
            .expect("an event in time")
            .expect("connected")
    }

    /// Events until the turn ends, answering permission requests with `allow`.
    async fn until_turn_ends(&mut self, seen: &mut Seen, allow: Option<&str>) {
        loop {
            let event = self.next().await;
            if self.note(event, seen, allow) {
                return;
            }
        }
    }

    /// Record an event; returns whether it ended the turn.
    fn note(&mut self, event: AgentEvent, seen: &mut Seen, allow: Option<&str>) -> bool {
        match event {
            AgentEvent::SessionUpdate(notification) => match notification.update {
                SessionUpdate::UserMessageChunk(chunk) => seen.user.push_str(&text(&chunk.content)),
                SessionUpdate::AgentMessageChunk(chunk) => {
                    seen.agent.push_str(&text(&chunk.content));
                }
                _ => {}
            },
            AgentEvent::TerminalOutput { text, .. } => seen.terminal.push_str(&text),
            AgentEvent::TurnRunning { .. } => seen.turns_running += 1,
            AgentEvent::PermissionRequested(request) => match allow {
                Some(option) => request.select(option.to_owned().into()).expect("answer"),
                None => drop(request),
            },
            AgentEvent::TurnEnded { result, .. } => {
                seen.ended = Some(result.expect("the turn succeeds").stop_reason);
                return true;
            }
            _ => {}
        }
        false
    }
}

fn text(block: &ContentBlock) -> String {
    match block {
        ContentBlock::Text(text) => text.text.clone(),
        _ => String::new(),
    }
}

async fn wait_for(mut condition: impl FnMut() -> bool) {
    tokio::time::timeout(WAIT, async {
        while !condition() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the condition in time");
}

#[tokio::test]
async fn a_client_reattaches_mid_turn_and_sees_the_whole_transcript() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let mut first = world.client(&daemon).await;
    let session_id = first.new_session(&world).await;
    first.prompt(&session_id, "slow 4");
    // Two chunks in, the first client goes away.
    let mut seen = Seen::default();
    while seen.agent.matches("Chunk").count() < 2 {
        let event = first.next().await;
        first.note(event, &mut seen, None);
    }
    first.connection.shutdown().await;

    let mut second = world.client(&daemon).await;
    second
        .connection
        .load_session(session_id.clone(), &world.setup())
        .await
        .expect("session/load attaches");
    let mut seen = Seen::default();
    second.until_turn_ends(&mut seen, None).await;
    assert_eq!(seen.user, "slow 4");
    assert_eq!(
        seen.agent,
        "Chunk 1 of 4.\nChunk 2 of 4.\nChunk 3 of 4.\nChunk 4 of 4.\n"
    );
    assert_eq!(
        seen.turns_running, 1,
        "told the turn was running when it attached"
    );
    assert_eq!(seen.ended, Some(StopReason::EndTurn));
}

#[tokio::test]
async fn attached_clients_share_turns_and_the_first_answer_wins() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let mut first = world.client(&daemon).await;
    let session_id = first.new_session(&world).await;
    let mut second = world.client(&daemon).await;
    second
        .connection
        .load_session(session_id.clone(), &world.setup())
        .await
        .expect("attach");

    let target = world.cwd().join("out.txt");
    first.prompt(&session_id, &format!("write {} hello", target.display()));
    // Both are asked; the second answers, and the first's prompt is withdrawn.
    let asked_first = loop {
        if let AgentEvent::PermissionRequested(request) = first.next().await {
            break request;
        }
    };
    let mut seen = Seen::default();
    let asked_second = loop {
        match second.next().await {
            AgentEvent::PermissionRequested(request) => break request,
            event => {
                second.note(event, &mut seen, None);
            }
        }
    };
    assert_eq!(
        asked_first.request.tool_call.tool_call_id,
        asked_second.request.tool_call.tool_call_id
    );
    asked_second
        .select("allow".to_owned().into())
        .expect("answer");
    loop {
        match first.next().await {
            AgentEvent::RequestWithdrawn(key) => {
                assert_eq!(key, asked_first.key);
                break;
            }
            AgentEvent::TurnEnded { .. } => panic!("the turn ended before the withdrawal"),
            _ => {}
        }
    }
    let _ = asked_first.withdrawn();
    second.until_turn_ends(&mut seen, None).await;
    // The second client saw the first's prompt and a turn it didn't start.
    assert!(seen.user.starts_with("write "), "{seen:?}");
    assert_eq!(seen.turns_running, 1);
    assert_eq!(seen.ended, Some(StopReason::EndTurn));
    let mut first_seen = Seen::default();
    first.until_turn_ends(&mut first_seen, None).await;
    assert_eq!(first_seen.ended, Some(StopReason::EndTurn));
    assert_eq!(
        std::fs::read_to_string(&target).ok().as_deref(),
        Some("hello\n")
    );
}

#[tokio::test]
async fn a_client_leaving_doesnt_answer_for_the_others() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let mut first = world.client(&daemon).await;
    let session_id = first.new_session(&world).await;
    let target = world.cwd().join("later.txt");
    first.prompt(&session_id, &format!("write {} later", target.display()));
    let asked = loop {
        if let AgentEvent::PermissionRequested(request) = first.next().await {
            break request;
        }
    };
    // As the TUI does when it switches away from a session.
    asked.cancel().expect("cancelled");
    first.connection.shutdown().await;

    let mut second = world.client(&daemon).await;
    second
        .connection
        .load_session(session_id, &world.setup())
        .await
        .expect("attach");
    let mut seen = Seen::default();
    second.until_turn_ends(&mut seen, Some("allow")).await;
    assert_eq!(
        std::fs::read_to_string(&target).ok().as_deref(),
        Some("later\n")
    );
}

#[tokio::test]
async fn cancelling_answers_pending_permissions_for_every_client() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    let session_id = client.new_session(&world).await;
    client.prompt(
        &session_id,
        &format!("write {} never", world.cwd().join("never.txt").display()),
    );
    let _asked = loop {
        if let AgentEvent::PermissionRequested(request) = client.next().await {
            break request;
        }
    };
    client
        .connection
        .cancel(session_id.clone())
        .expect("session/cancel");
    let mut seen = Seen::default();
    client.until_turn_ends(&mut seen, None).await;
    assert!(!world.cwd().join("never.txt").exists());
}

#[tokio::test]
async fn headless_runs_follow_their_policy() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let approved = world.cwd().join("approved.txt");
    let rejected = world.cwd().join("rejected.txt");
    let run = |path: &Path, approve: Vec<ToolKind>| RunRequest {
        launch: world.launch(),
        session_id: None,
        additional_directories: Vec::new(),
        mcp_servers: Vec::new(),
        prompt: vec![ContentBlock::from(format!("write {} ok", path.display()))],
        policy: PermissionPolicy {
            approve,
            otherwise: Unapproved::Reject,
        },
        attach: false,
    };

    // In-process, as a trigger would: nobody attached.
    let session_id = daemon
        .run(run(&approved, vec![ToolKind::Edit]))
        .await
        .expect("run");
    wait_for(|| approved.exists()).await;
    wait_for(|| {
        daemon
            .status()
            .sessions
            .iter()
            .any(|session| session.session_id == session_id && session.activity == Activity::Idle)
    })
    .await;

    // Through `_weave/run`, attached for the whole turn, as `weave run` is.
    let mut client = world.client(&daemon).await;
    let mut request = run(&rejected, Vec::new());
    request.attach = true;
    let response = client
        .connection
        .extension(request)
        .await
        .expect("_weave/run");
    let mut seen = Seen::default();
    client.until_turn_ends(&mut seen, None).await;
    assert!(seen.user.starts_with("write "));
    assert_eq!(seen.turns_running, 1);
    assert!(!rejected.exists(), "the policy rejected the write");
    let status = client
        .connection
        .extension(StatusRequest {})
        .await
        .expect("_weave/status");
    assert!(
        status
            .sessions
            .iter()
            .any(|session| session.session_id == response.session_id
                && session.policy.otherwise == Unapproved::Reject)
    );
}

#[tokio::test]
async fn a_restarted_daemon_takes_sessions_up_from_their_journals() {
    let world = World::new();
    let session_id = {
        let daemon = world.daemon(true, Duration::from_secs(60));
        let mut client = world.client(&daemon).await;
        let session_id = client.new_session(&world).await;
        client.prompt(&session_id, "hello there");
        client.until_turn_ends(&mut Seen::default(), None).await;
        daemon.shutdown().await;
        session_id
    };

    let daemon = world.daemon(true, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    client
        .connection
        .load_session(session_id.clone(), &world.setup())
        .await
        .expect("session/load recovers");
    // The history comes once, from the journal, not again from the agent.
    let mut seen = Seen::default();
    client.prompt(&session_id, "again");
    client.until_turn_ends(&mut seen, None).await;
    assert_eq!(seen.agent, "You said: hello thereYou said: again");
    assert_eq!(seen.user, "hello there");
}

#[tokio::test]
async fn idle_sessions_close_after_their_grace_and_reopen_in_the_agent() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_millis(100));
    let client = world.client(&daemon).await;
    let session_id = client.new_session(&world).await;
    client.connection.shutdown().await;
    wait_for(|| daemon.status().sessions.is_empty()).await;

    // No longer live, it's loaded from the agent like any other session.
    let mut client = world.client(&daemon).await;
    client
        .connection
        .load_session(session_id.clone(), &world.setup())
        .await
        .expect("session/load");
    client.prompt(&session_id, "back");
    let mut seen = Seen::default();
    client.until_turn_ends(&mut seen, None).await;
    assert_eq!(seen.agent, "You said: back");
}

#[tokio::test]
async fn command_output_reaches_clients_and_is_replayed() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    let session_id = client.new_session(&world).await;
    client.prompt(&session_id, "run echo from-the-daemon");
    let mut seen = Seen::default();
    client.until_turn_ends(&mut seen, None).await;
    assert_eq!(seen.terminal, "from-the-daemon\n");

    let mut late = world.client(&daemon).await;
    late.connection
        .load_session(session_id.clone(), &world.setup())
        .await
        .expect("attach");
    let mut replayed = String::new();
    while let Ok(event) = late.events.try_recv() {
        if let AgentEvent::TerminalOutput { text, .. } = event {
            replayed.push_str(&text);
        }
    }
    assert_eq!(replayed, "from-the-daemon\n");
}

#[tokio::test]
async fn sessions_list_with_their_activity_and_close_when_left() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let client = world.client(&daemon).await;
    let session_id = client.new_session(&world).await;
    let listed = client
        .connection
        .list_sessions(Some(world.cwd()), None)
        .await
        .expect("session/list");
    let entry = listed
        .sessions
        .iter()
        .find(|info| info.session_id == session_id)
        .expect("the live session is listed");
    let live: Option<daemon_protocol::ListedSession> =
        daemon_protocol::read_meta(entry.meta.as_ref());
    assert_eq!(live.map(|live| live.clients), Some(1));

    client
        .connection
        .close_session(session_id)
        .await
        .expect("session/close");
    wait_for(|| daemon.status().sessions.is_empty()).await;
}

#[tokio::test]
async fn a_client_signs_in_through_its_own_agent_and_retries() {
    let world = World::new();
    let daemon = Daemon::new(DaemonConfig {
        journals: None,
        idle_grace: Duration::from_secs(60),
        launcher: fake_agents(world.dir.path().join("agent-state.json"), true),
    });
    let client = world.client(&daemon).await;
    let error = client
        .connection
        .new_session(&world.setup())
        .await
        .expect_err("the agent wants a sign-in first");
    assert!(weave_acp_core::is_auth_required(&error), "{error}");
    client
        .connection
        .authenticate("token".into())
        .await
        .expect("authenticate");
    let session_id = client.new_session(&world).await;
    assert!(
        daemon
            .status()
            .sessions
            .iter()
            .any(|session| session.session_id == session_id)
    );
}

#[tokio::test]
async fn live_sessions_lead_the_list_so_continue_finds_them() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let mut left = world.client(&daemon).await;
    let live = left.new_session(&world).await;
    left.prompt(&live, "first");
    left.until_turn_ends(&mut Seen::default(), None).await;
    left.connection.shutdown().await;
    // A session used more recently, but closed, so the agent lists it first.
    let mut other = world.client(&daemon).await;
    let closed = other.new_session(&world).await;
    other.prompt(&closed, "later");
    other.until_turn_ends(&mut Seen::default(), None).await;
    other
        .connection
        .close_session(closed.clone())
        .await
        .expect("session/close");
    wait_for(|| daemon.status().sessions.len() == 1).await;

    let listed = other
        .connection
        .list_sessions(Some(world.cwd()), None)
        .await
        .expect("session/list");
    let order: Vec<&SessionId> = listed
        .sessions
        .iter()
        .map(|info| &info.session_id)
        .collect();
    assert_eq!(order, [&live, &closed]);
}

#[tokio::test]
async fn ending_a_session_ends_it_for_every_client() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    let session_id = client.new_session(&world).await;
    client.prompt(&session_id, "slow 20");
    let control = world.client(&daemon).await;
    control
        .connection
        .extension(weave_acp_core::daemon_protocol::EndSessionRequest {
            session_id: session_id.clone(),
        })
        .await
        .expect("_weave/end_session");
    let reason = loop {
        match client.next().await {
            AgentEvent::SessionEnded { reason, .. } => break reason,
            AgentEvent::TurnEnded { result, .. } => {
                assert!(result.is_err(), "the turn ends with the session");
            }
            _ => {}
        }
    };
    assert_eq!(reason, "closed from the command line");
    assert!(daemon.status().sessions.is_empty());
    let again = control
        .connection
        .extension(weave_acp_core::daemon_protocol::EndSessionRequest { session_id })
        .await;
    assert!(again.is_err(), "it isn't open any more");
}

fn listed(info: &weave_acp_core::schema::SessionInfo) -> daemon_protocol::ListedSession {
    daemon_protocol::read_meta(info.meta.as_ref()).unwrap_or_default()
}

#[tokio::test]
async fn sessions_a_stopped_daemon_left_open_lead_the_list_with_headless_ones_marked() {
    let world = World::new();
    let (interactive, headless, closed) = {
        let daemon = world.daemon(true, Duration::from_secs(60));
        let mut left = world.client(&daemon).await;
        let interactive = left.new_session(&world).await;
        left.prompt(&interactive, "mine");
        left.until_turn_ends(&mut Seen::default(), None).await;
        left.connection.shutdown().await;
        let headless = daemon
            .run(RunRequest {
                launch: world.launch(),
                session_id: None,
                additional_directories: Vec::new(),
                mcp_servers: Vec::new(),
                prompt: vec![ContentBlock::from("a headless run".to_owned())],
                policy: PermissionPolicy::headless(Vec::new()),
                attach: false,
            })
            .await
            .expect("run");
        wait_for(|| {
            daemon
                .status()
                .sessions
                .iter()
                .all(|session| session.activity == Activity::Idle)
        })
        .await;
        // Used last but closed, so the agent lists it first.
        let mut other = world.client(&daemon).await;
        let closed = other.new_session(&world).await;
        other.prompt(&closed, "later");
        other.until_turn_ends(&mut Seen::default(), None).await;
        other
            .connection
            .close_session(closed.clone())
            .await
            .expect("close");
        daemon.shutdown().await;
        (interactive, headless, closed)
    };

    let daemon = world.daemon(true, Duration::from_secs(60));
    // Listed by a client offering less than the one that opened them: they still lead.
    let options = ClientOptions {
        read_files: false,
        ..ClientOptions::default()
    };
    let client = world
        .client_with(&daemon, options, world.launch())
        .await
        .expect("initialize");
    let listed_sessions = client
        .connection
        .list_sessions(Some(world.cwd()), None)
        .await
        .expect("session/list");
    let order: Vec<&SessionId> = listed_sessions
        .sessions
        .iter()
        .map(|info| &info.session_id)
        .collect();
    assert_eq!(order, [&headless, &interactive, &closed]);
    let flags: Vec<bool> = listed_sessions
        .sessions
        .iter()
        .map(|info| listed(info).headless)
        .collect();
    assert_eq!(flags, [true, false, false]);
}

#[tokio::test]
async fn a_session_opens_only_with_its_own_agent_and_says_where_it_works() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let client = world.client(&daemon).await;
    let session_id = client.new_session(&world).await;

    let other = world
        .client_with(
            &daemon,
            ClientOptions::default(),
            world.launch_of(AgentChoice::Named("other".into())),
        )
        .await
        .expect("initialize");
    let refused = other
        .connection
        .load_session(session_id.clone(), &world.setup())
        .await
        .expect_err("another agent's session");
    assert!(refused.to_string().contains("runs with fake"), "{refused}");

    // Loaded from elsewhere, the session still works in its own directory.
    let elsewhere = SessionSetup {
        cwd: std::env::temp_dir(),
        ..SessionSetup::default()
    };
    let second = world.client(&daemon).await;
    let loaded = second
        .connection
        .load_session(session_id, &elsewhere)
        .await
        .expect("session/load");
    let opened: Option<daemon_protocol::OpenedSession> =
        daemon_protocol::read_meta(loaded.meta.as_ref());
    assert_eq!(opened.map(|opened| opened.cwd), Some(world.cwd()));
}
