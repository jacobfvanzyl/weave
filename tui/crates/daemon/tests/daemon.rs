//! The Host end to end: real clients (`weave-host-client`) connected in-process to a Host
//! whose agents are in-process fake agents sharing one state file, as separate processes of
//! one agent would share its storage.

#![allow(clippy::expect_used)]

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use agent_client_protocol::Channel;
use agent_client_protocol::ConnectionTo;
use agent_client_protocol::Error;
use agent_client_protocol::Role as _;
use pretty_assertions::assert_eq;
use tokio::sync::mpsc::UnboundedReceiver;
use weave_acp_core::AgentConnection;
use weave_acp_core::ClientOptions;
use weave_acp_core::schema::ContentBlock;
use weave_acp_core::schema::InitializeRequest;
use weave_acp_core::schema::PermissionOptionId;
use weave_acp_core::schema::RequestPermissionOutcome;
use weave_acp_core::schema::RequestPermissionResponse;
use weave_acp_core::schema::SelectedPermissionOutcome;
use weave_acp_core::schema::SessionConfigKind;
use weave_acp_core::schema::SessionConfigOptionCategory;
use weave_acp_core::schema::SessionId;
use weave_acp_core::schema::SessionUpdate;
use weave_acp_core::schema::StopReason;
use weave_acp_core::schema::ToolKind;
use weave_agents::environment::Environment;
use weave_daemon::Daemon;
use weave_daemon::DaemonConfig;
use weave_daemon::Launch;
use weave_daemon::Launcher;
use weave_daemon::Withheld;
use weave_daemon::mcp;
use weave_fake_agent::FakeAgentConfig;
use weave_fake_agent::StdioMcp;
use weave_fake_agent::StdioPipes;
use weave_host_client::HostConnection;
use weave_host_client::HostEvent;
use weave_host_protocol::Host;
use weave_host_protocol::HostClient;
use weave_host_protocol::VersionRange;
use weave_host_protocol::errors;
use weave_host_protocol::events::SessionEvent;
use weave_host_protocol::hello::Auth;
use weave_host_protocol::hello::ClientCapabilities;
use weave_host_protocol::hello::ClientInfo;
use weave_host_protocol::hello::HelloRequest;
use weave_host_protocol::host::Service;
use weave_host_protocol::host::StatusRequest;
use weave_host_protocol::pending::AnswerPendingRequest;
use weave_host_protocol::pending::PendingKind;
use weave_host_protocol::pending::PendingRequest;
use weave_host_protocol::pending::Resolution;
use weave_host_protocol::policy::PermissionPolicy;
use weave_host_protocol::policy::Unapproved;
use weave_host_protocol::sessions::Activity;
use weave_host_protocol::sessions::AttachSessionRequest;
use weave_host_protocol::sessions::AttachSessionResponse;
use weave_host_protocol::sessions::CloseSessionRequest;
use weave_host_protocol::sessions::CloseWhen;
use weave_host_protocol::sessions::CreateSessionRequest;
use weave_host_protocol::sessions::DetachSessionRequest;
use weave_host_protocol::sessions::JournalPosition;
use weave_host_protocol::sessions::ListSessionsRequest;
use weave_host_protocol::sessions::RunRequest;
use weave_host_protocol::sessions::SessionListing;
use weave_host_protocol::sessions::SessionState;
use weave_host_protocol::sessions::SessionStatus;
use weave_host_protocol::sessions::TurnOrigin;
use weave_host_protocol::tools::CLIPBOARD_WRITE;
use weave_host_protocol::tools::ClientToolResult;
use weave_host_protocol::turns::CancelTurnRequest;
use weave_host_protocol::turns::STEER_FEATURE;
use weave_host_protocol::turns::StartTurnRequest;
use weave_host_protocol::turns::SteerOutcome;
use weave_host_protocol::turns::SteerTurnRequest;
use weave_host_protocol::turns::SteerTurnResponse;

const WAIT: Duration = Duration::from_secs(10);

/// Fake agents in-process, sharing `state` so sessions outlive any one of them. The stdio
/// MCP servers they're given are the Host's bridge, which they run in-process too: the same
/// relay `weave mcp-bridge` runs, to the Host's MCP socket.
fn fake_agents(state: PathBuf, require_auth: bool) -> Launcher {
    fake_agents_with(state, require_auth, false)
}

/// [`fake_agents`], advertising MCP servers over ACP when `mcp_over_acp`.
fn fake_agents_with(state: PathBuf, require_auth: bool, mcp_over_acp: bool) -> Launcher {
    Arc::new(move |_launch: &Launch, options: ClientOptions, _traces| {
        let config = FakeAgentConfig {
            state_path: Some(state.clone()),
            require_auth,
            mcp_over_acp,
            stdio_mcp: in_process_bridge(),
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

/// Runs a stdio MCP server's bridge in-process, with the socket and token it was given.
fn in_process_bridge() -> StdioMcp {
    StdioMcp::new(|server| {
        Box::pin(async move {
            let var = |name: &str| {
                server
                    .env
                    .iter()
                    .find(|var| var.name == name)
                    .map(|var| var.value.clone())
                    .ok_or_else(|| std::io::Error::other(format!("no {name}")))
            };
            let socket = PathBuf::from(var(mcp::SOCKET_VARIABLE)?);
            let token = var(mcp::TOKEN_VARIABLE)?;
            let (agent, bridge) = tokio::io::duplex(1 << 16);
            let (from_agent, to_agent) = tokio::io::split(bridge);
            tokio::spawn(async move {
                let _ = mcp::relay(&socket, &token, from_agent, to_agent).await;
            });
            let (read, write) = tokio::io::split(agent);
            let pipes: StdioPipes = (Box::new(read), Box::new(write));
            Ok(pipes)
        })
    })
}

struct World {
    dir: tempfile::TempDir,
}

impl World {
    fn new() -> Self {
        let dir = tempfile::tempdir().expect("tempdir");
        // Two agents the Host knows from its config; the launcher runs both as the fake one.
        std::fs::write(
            dir.path().join("config.toml"),
            "[agents.fake]\ncommand = \"fake-agent\"\nmode = \"code\"\n\n\
             [agents.other]\ncommand = \"other-agent\"\n",
        )
        .expect("config");
        Self { dir }
    }

    fn daemon(&self, journals: bool, idle_grace: Duration) -> Daemon {
        self.daemon_with(journals, idle_grace, Duration::from_secs(60), false)
    }

    /// A Host whose blank sessions close `blank_grace` after nothing needs them.
    fn daemon_with(
        &self,
        journals: bool,
        idle_grace: Duration,
        blank_grace: Duration,
        require_auth: bool,
    ) -> Daemon {
        Daemon::new(self.config(journals, idle_grace, blank_grace, require_auth))
    }

    /// A Host whose agents take MCP servers over ACP.
    fn daemon_over_acp(&self) -> Daemon {
        let mut config = self.config(
            false,
            Duration::from_secs(60),
            Duration::from_secs(60),
            false,
        );
        config.launcher = fake_agents_with(self.dir.path().join("agent-state.json"), false, true);
        Daemon::new(config)
    }

    fn config(
        &self,
        journals: bool,
        idle_grace: Duration,
        blank_grace: Duration,
        require_auth: bool,
    ) -> DaemonConfig {
        DaemonConfig {
            journals: journals.then(|| self.journals()),
            idle_grace,
            blank_grace,
            launcher: fake_agents(self.dir.path().join("agent-state.json"), require_auth),
            config_file: Some(self.dir.path().join("config.toml")),
            registry_cache: Some(self.dir.path().join("cache")),
            agents: Default::default(),
            withheld: Withheld::default(),
            environment: Environment::default(),
            service: Service::InProcess,
            traces: self.dir.path().join("traces"),
            devices: Some(self.dir.path().join("devices.json")),
            upstream: Arc::new(weave_agents::update::Offline),
            mcp_socket: None,
            mcp_bridge: vec!["weave-mcp-bridge".to_owned()],
            remote: None,
        }
    }

    fn journals(&self) -> PathBuf {
        self.dir.path().join("sessions")
    }

    /// Whether the Host keeps a journal of `session_id`. The fake agent's ids need no
    /// escaping in a file name.
    fn has_journal(&self, session_id: &SessionId) -> bool {
        self.journals().join(format!("{session_id}.jsonl")).exists()
    }

    fn cwd(&self) -> PathBuf {
        self.dir.path().to_path_buf()
    }

    async fn client(&self, daemon: &Daemon) -> TestClient {
        self.client_with(daemon, ClientCapabilities::default())
            .await
    }

    /// A client that runs client tools, as the TUI does.
    async fn tool_client(&self, daemon: &Daemon) -> TestClient {
        let capabilities = ClientCapabilities {
            client_tools: vec![CLIPBOARD_WRITE.to_owned()],
            ..ClientCapabilities::default()
        };
        self.client_with(daemon, capabilities).await
    }

    async fn client_with(&self, daemon: &Daemon, capabilities: ClientCapabilities) -> TestClient {
        let (connection, events) = HostConnection::connect(
            daemon.connect_in_process(),
            ClientInfo {
                name: "test".to_owned(),
                version: "0".to_owned(),
            },
            capabilities,
        )
        .await
        .expect("connect");
        TestClient {
            connection,
            events,
            position: None,
        }
    }
}

struct TestClient {
    connection: HostConnection,
    events: UnboundedReceiver<HostEvent>,
    /// The last event seen, to catch up from.
    position: Option<JournalPosition>,
}

/// What a client saw, flattened for assertions.
#[derive(Default, Debug)]
struct Seen {
    user: String,
    agent: String,
    terminal: String,
    started: usize,
    /// Messages steered into turns, with how much of the agent's text came before each.
    steered: Vec<(String, usize)>,
    /// Their positions.
    steered_seqs: Vec<u64>,
    ended: Option<StopReason>,
    closed: Option<String>,
    notices: Vec<String>,
}

fn text(block: &ContentBlock) -> String {
    match block {
        ContentBlock::Text(text) => text.text.clone(),
        _ => String::new(),
    }
}

impl TestClient {
    fn create_request(world: &World, agent: &str) -> CreateSessionRequest {
        CreateSessionRequest {
            agent_id: agent.to_owned(),
            cwd: world.cwd(),
            additional_directories: Vec::new(),
            mode: None,
            policy: None,
            trace: false,
        }
    }

    async fn create(&mut self, world: &World) -> SessionId {
        self.create_with(world, "fake").await.session_id
    }

    async fn create_with(&mut self, world: &World, agent: &str) -> SessionState {
        let state = self
            .connection
            .send(Self::create_request(world, agent))
            .await
            .expect("session/create");
        self.position = Some(JournalPosition {
            journal: state.journal.id.clone(),
            seq: state.journal.head,
        });
        state
    }

    async fn attach(&mut self, session_id: &SessionId) -> AttachSessionResponse {
        self.attach_after(session_id, None)
            .await
            .expect("session/attach")
    }

    async fn attach_after(
        &mut self,
        session_id: &SessionId,
        after: Option<JournalPosition>,
    ) -> Result<AttachSessionResponse, Error> {
        let attached = self
            .connection
            .send(AttachSessionRequest {
                session_id: session_id.clone(),
                after,
                agent_id: None,
                cwd: None,
                trace: false,
            })
            .await?;
        self.position = Some(JournalPosition {
            journal: attached.state.journal.id.clone(),
            seq: attached.state.journal.head,
        });
        Ok(attached)
    }

    /// The sessions the fake agent's listing gives for the world's directory, in order.
    async fn list(&self, world: &World) -> Vec<SessionId> {
        self.listing(world)
            .await
            .into_iter()
            .map(|listing| listing.info.session_id)
            .collect()
    }

    async fn listing(&self, world: &World) -> Vec<SessionListing> {
        self.connection
            .send(ListSessionsRequest {
                agent_id: Some("fake".to_owned()),
                cwd: Some(world.cwd()),
                cursor: None,
            })
            .await
            .expect("sessions/list")
            .sessions
    }

    async fn prompt(&self, session_id: &SessionId, text: &str) -> u64 {
        self.connection
            .send(StartTurnRequest {
                session_id: session_id.clone(),
                prompt: vec![ContentBlock::from(text.to_owned())],
            })
            .await
            .expect("turn/start")
            .seq
    }

    async fn steer(&self, session_id: &SessionId, text: &str) -> SteerTurnResponse {
        self.connection
            .send(SteerTurnRequest {
                session_id: session_id.clone(),
                prompt: vec![ContentBlock::from(text.to_owned())],
            })
            .await
            .expect("turn/steer")
    }

    async fn next(&mut self) -> HostEvent {
        tokio::time::timeout(WAIT, self.events.recv())
            .await
            .expect("an event in time")
            .expect("connected")
    }

    /// Events until the turn ends, answering permission requests with `allow`.
    async fn until_turn_ends(&mut self, seen: &mut Seen, allow: Option<&str>) {
        loop {
            let event = self.next().await;
            if self.note(event, seen, allow).await {
                return;
            }
        }
    }

    /// Record an event; returns whether it ended the turn.
    async fn note(&mut self, event: HostEvent, seen: &mut Seen, allow: Option<&str>) -> bool {
        match event {
            HostEvent::Event(event) => {
                self.position = Some(JournalPosition {
                    journal: self
                        .position
                        .as_ref()
                        .map(|position| position.journal.clone())
                        .unwrap_or_default(),
                    seq: event.seq,
                });
                if matches!(event.event, SessionEvent::TurnSteered { .. }) {
                    seen.steered_seqs.push(event.seq);
                }
                return seen.note(event.event);
            }
            HostEvent::PendingAdded(added) => {
                if let Some(option) = allow {
                    self.allow(&added.session_id, &added.pending, option)
                        .await
                        .expect("answer");
                }
            }
            _ => {}
        }
        false
    }

    async fn allow(
        &self,
        session_id: &SessionId,
        pending: &PendingRequest,
        option: &str,
    ) -> Result<(), Error> {
        self.connection
            .send(AnswerPendingRequest {
                session_id: session_id.clone(),
                pending_id: pending.id.clone(),
                permission: Some(RequestPermissionResponse::new(
                    RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(
                        PermissionOptionId::new(option.to_owned()),
                    )),
                )),
                elicitation: None,
                client_tool: None,
            })
            .await
            .map(drop)
    }

    /// Wait for a pending client tool call.
    async fn tool_call(&mut self, seen: &mut Seen) -> (SessionId, PendingRequest) {
        loop {
            match self.next().await {
                HostEvent::PendingAdded(added)
                    if matches!(added.pending.request, PendingKind::ClientTool { .. }) =>
                {
                    return (added.session_id, added.pending);
                }
                event => {
                    self.note(event, seen, None).await;
                }
            }
        }
    }

    /// Answer a client tool call with `result`.
    async fn run_tool(
        &self,
        session_id: &SessionId,
        call: &PendingRequest,
        result: ClientToolResult,
    ) -> Result<(), Error> {
        self.connection
            .send(AnswerPendingRequest {
                session_id: session_id.clone(),
                pending_id: call.id.clone(),
                permission: None,
                elicitation: None,
                client_tool: Some(result),
            })
            .await
            .map(drop)
    }

    /// Wait for a pending permission request.
    async fn asked(&mut self, seen: &mut Seen) -> (SessionId, PendingRequest) {
        loop {
            match self.next().await {
                HostEvent::PendingAdded(added) => return (added.session_id, added.pending),
                event => {
                    self.note(event, seen, None).await;
                }
            }
        }
    }
}

impl Seen {
    /// Record an event; returns whether it ended a turn.
    fn note(&mut self, event: SessionEvent) -> bool {
        match event {
            SessionEvent::Update { notification } => match notification.update {
                SessionUpdate::UserMessageChunk(chunk) => self.user.push_str(&text(&chunk.content)),
                SessionUpdate::AgentMessageChunk(chunk) => {
                    self.agent.push_str(&text(&chunk.content));
                }
                _ => {}
            },
            SessionEvent::TurnStarted { prompt, .. } => {
                self.started += 1;
                for block in &prompt {
                    self.user.push_str(&text(block));
                }
            }
            SessionEvent::TurnSteered { prompt, .. } => {
                let text = prompt.iter().map(text).collect();
                self.steered.push((text, self.agent.len()));
            }
            SessionEvent::TerminalOutput { data, .. } => self.terminal.push_str(&data),
            SessionEvent::TurnEnded {
                response, error, ..
            } => {
                self.ended = match (response, error) {
                    (Some(response), _) => Some(response.stop_reason),
                    (None, Some(error)) => panic!("the turn failed: {error}"),
                    (None, None) => None,
                };
                return true;
            }
            SessionEvent::Closed { reason } => self.closed = Some(reason),
            SessionEvent::Notice { text } => self.notices.push(text),
            _ => {}
        }
        false
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

fn run_request(world: &World, path: &Path, approve: Vec<ToolKind>) -> RunRequest {
    RunRequest {
        agent_id: "fake".to_owned(),
        cwd: world.cwd(),
        session_id: None,
        additional_directories: Vec::new(),
        prompt: vec![ContentBlock::from(format!("write {} ok", path.display()))],
        policy: PermissionPolicy {
            approve,
            otherwise: Unapproved::Reject,
        },
        attach: false,
        trace: false,
    }
}

#[tokio::test]
async fn a_client_reattaches_mid_turn_and_sees_the_whole_transcript() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let mut first = world.client(&daemon).await;
    let session_id = first.create(&world).await;
    first.prompt(&session_id, "slow 4").await;
    // Two chunks in, the first client goes away.
    let mut seen = Seen::default();
    while seen.agent.matches("Chunk").count() < 2 {
        let event = first.next().await;
        first.note(event, &mut seen, None).await;
    }
    first.connection.shutdown().await;

    let mut second = world.client(&daemon).await;
    let attached = second.attach(&session_id).await;
    assert_eq!(attached.state.turns.len(), 1, "told the turn is running");
    assert!(
        attached.replay.reset,
        "nothing to catch up from: everything"
    );
    let mut seen = Seen::default();
    second.until_turn_ends(&mut seen, None).await;
    assert_eq!(seen.user, "slow 4");
    assert_eq!(
        seen.agent,
        "Chunk 1 of 4.\nChunk 2 of 4.\nChunk 3 of 4.\nChunk 4 of 4.\n"
    );
    assert_eq!(seen.ended, Some(StopReason::EndTurn));
}

#[tokio::test]
async fn a_steered_message_joins_the_running_turn_for_every_client() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let mut first = world.client(&daemon).await;
    assert!(
        first
            .connection
            .hello()
            .features
            .iter()
            .any(|feature| feature == STEER_FEATURE)
    );
    let session_id = first.create(&world).await;
    let mut second = world.client(&daemon).await;
    second.attach(&session_id).await;
    first.prompt(&session_id, "slow 50").await;
    let mut seen = Seen::default();
    while !seen.agent.contains("Chunk 1 of 50") {
        let event = first.next().await;
        first.note(event, &mut seen, None).await;
    }

    let answer = first.steer(&session_id, "say hi instead").await;
    assert_eq!(answer.outcome, SteerOutcome::Steered);
    first.until_turn_ends(&mut seen, None).await;
    let mut other = Seen::default();
    second.until_turn_ends(&mut other, None).await;
    for seen in [&seen, &other] {
        let [(steered, at)] = seen.steered.as_slice() else {
            panic!("one steered message: {seen:?}");
        };
        assert_eq!(steered, "say hi instead");
        // It joined the turn before the agent answered it, and the turn ended once.
        assert!(
            seen.agent[*at..].starts_with("You steered: say hi instead"),
            "{seen:?}"
        );
        assert!(!seen.agent.contains("Chunk 50 of 50"), "{seen:?}");
        assert_eq!(seen.ended, Some(StopReason::EndTurn));
    }

    // A client attaching later replays it in place.
    let mut later = world.client(&daemon).await;
    later.attach(&session_id).await;
    let mut replayed = Seen::default();
    later.until_turn_ends(&mut replayed, None).await;
    assert_eq!(replayed.steered, other.steered);
    assert_eq!(
        replayed.steered_seqs,
        answer.seq.into_iter().collect::<Vec<_>>()
    );
}

#[tokio::test]
async fn steering_with_no_turn_running_sends_nothing() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    let session_id = client.create(&world).await;
    let not_running = SteerTurnResponse {
        outcome: SteerOutcome::NotRunning,
        seq: None,
    };
    assert_eq!(client.steer(&session_id, "hi").await, not_running);

    client.prompt(&session_id, "hello").await;
    client.until_turn_ends(&mut Seen::default(), None).await;
    assert_eq!(client.steer(&session_id, "too late").await, not_running);
    let attached = client.attach(&session_id).await;
    assert!(attached.state.turns.is_empty());
    let mut seen = Seen::default();
    client.until_turn_ends(&mut seen, None).await;
    assert!(seen.steered.is_empty(), "{seen:?}");
}

#[tokio::test]
async fn a_client_catches_up_from_its_position_without_the_rest() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let mut first = world.client(&daemon).await;
    let session_id = first.create(&world).await;
    first.prompt(&session_id, "hello").await;
    first.until_turn_ends(&mut Seen::default(), None).await;
    let position = first.position.clone();
    first.connection.shutdown().await;

    // While it's away, another turn runs.
    let mut other = world.client(&daemon).await;
    other.attach(&session_id).await;
    other.prompt(&session_id, "again").await;
    other.until_turn_ends(&mut Seen::default(), None).await;

    let mut back = world.client(&daemon).await;
    let attached = back
        .attach_after(&session_id, position)
        .await
        .expect("attach");
    assert!(!attached.replay.reset);
    let mut seen = Seen::default();
    back.until_turn_ends(&mut seen, None).await;
    assert_eq!(seen.user, "again", "only what it missed");
    assert_eq!(seen.agent, "You said: again");

    // From another journal's position, it gets everything, and is told to start over.
    let mut stranger = world.client(&daemon).await;
    let elsewhere = JournalPosition {
        journal: "another".to_owned(),
        seq: 2,
    };
    let attached = stranger
        .attach_after(&session_id, Some(elsewhere))
        .await
        .expect("attach");
    assert!(attached.replay.reset);
    assert_eq!(attached.replay.from, 1);
}

#[tokio::test]
async fn attached_clients_share_turns_and_the_first_answer_wins() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let mut first = world.client(&daemon).await;
    let session_id = first.create(&world).await;
    let mut second = world.client(&daemon).await;
    second.attach(&session_id).await;

    let target = world.cwd().join("out.txt");
    first
        .prompt(&session_id, &format!("write {} hello", target.display()))
        .await;
    // Both are asked; the second answers, and the first hears it was.
    let (_, asked_first) = first.asked(&mut Seen::default()).await;
    let mut seen = Seen::default();
    let (_, asked_second) = second.asked(&mut seen).await;
    assert_eq!(asked_first.id, asked_second.id);
    second
        .allow(&session_id, &asked_second, "allow")
        .await
        .expect("the first answer");
    loop {
        match first.next().await {
            HostEvent::PendingResolved(resolved) => {
                assert_eq!(resolved.pending_id, asked_first.id);
                assert_eq!(resolved.outcome, Resolution::Answered);
                assert_eq!(resolved.by.as_ref(), Some(second.connection.client_id()));
                break;
            }
            HostEvent::Event(event) => {
                assert!(
                    !matches!(event.event, SessionEvent::TurnEnded { .. }),
                    "the turn ended before the answer was told"
                );
            }
            _ => {}
        }
    }
    let late = first.allow(&session_id, &asked_first, "allow").await;
    assert!(
        late.as_ref()
            .is_err_and(|error| errors::is(error, errors::ALREADY_RESOLVED)),
        "{late:?}"
    );
    second.until_turn_ends(&mut seen, None).await;
    // The second client saw the first's prompt, in a turn it didn't start.
    assert!(seen.user.starts_with("write "), "{seen:?}");
    assert_eq!(seen.started, 1);
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
    let session_id = first.create(&world).await;
    let target = world.cwd().join("later.txt");
    first
        .prompt(&session_id, &format!("write {} later", target.display()))
        .await;
    first.asked(&mut Seen::default()).await;
    first.connection.shutdown().await;

    // A client attaching later finds the request still waiting, and answers it.
    let mut second = world.client(&daemon).await;
    let attached = second.attach(&session_id).await;
    let pending = attached
        .state
        .pending
        .first()
        .cloned()
        .expect("still pending");
    assert!(matches!(pending.request, PendingKind::Permission { .. }));
    assert_eq!(attached.state.activity, Activity::Waiting);
    second
        .allow(&session_id, &pending, "allow")
        .await
        .expect("answer");
    second.until_turn_ends(&mut Seen::default(), None).await;
    assert_eq!(
        std::fs::read_to_string(&target).ok().as_deref(),
        Some("later\n")
    );
}

#[tokio::test]
async fn cancelling_cancels_pending_requests_for_every_client() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    let session_id = client.create(&world).await;
    client
        .prompt(
            &session_id,
            &format!("write {} never", world.cwd().join("never.txt").display()),
        )
        .await;
    let (_, asked) = client.asked(&mut Seen::default()).await;
    client
        .connection
        .send(CancelTurnRequest {
            session_id: session_id.clone(),
        })
        .await
        .expect("turn/cancel");
    let mut seen = Seen::default();
    let mut cancelled = false;
    loop {
        match client.next().await {
            HostEvent::PendingResolved(resolved) => {
                assert_eq!(resolved.pending_id, asked.id);
                cancelled = resolved.outcome == Resolution::Cancelled;
            }
            event => {
                if client.note(event, &mut seen, None).await {
                    break;
                }
            }
        }
    }
    assert!(cancelled);
    assert!(!world.cwd().join("never.txt").exists());
}

#[tokio::test]
async fn headless_runs_follow_their_policy() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let approved = world.cwd().join("approved.txt");
    let rejected = world.cwd().join("rejected.txt");

    // In-process, as a trigger would: nobody attached.
    let session_id = daemon
        .run(run_request(&world, &approved, vec![ToolKind::Edit]))
        .await
        .expect("run");
    wait_for(|| approved.exists()).await;
    wait_for(|| {
        daemon.status().sessions.iter().any(|session| {
            session.info.session_id == session_id && session.activity == Some(Activity::Idle)
        })
    })
    .await;

    // Through `session/run`, attached for the whole turn, as `weave run` is.
    let mut client = world.client(&daemon).await;
    let mut request = run_request(&world, &rejected, Vec::new());
    request.attach = true;
    let response = client.connection.send(request).await.expect("session/run");
    assert!(response.state.is_some(), "attached");
    let mut seen = Seen::default();
    let mut origin = None;
    loop {
        let event = client.next().await;
        if let HostEvent::Event(event) = &event
            && let SessionEvent::TurnStarted {
                origin: started, ..
            } = &event.event
        {
            origin = Some(started.clone());
        }
        if client.note(event, &mut seen, None).await {
            break;
        }
    }
    assert_eq!(origin, Some(TurnOrigin::Run {}));
    assert!(seen.user.starts_with("write "));
    assert!(!rejected.exists(), "the policy rejected the write");
    let status = client
        .connection
        .send(StatusRequest {})
        .await
        .expect("host/status");
    assert!(
        status
            .sessions
            .iter()
            .any(|session| session.info.session_id == response.session_id && session.headless)
    );
}

#[tokio::test]
async fn a_restarted_host_takes_sessions_up_from_their_journals() {
    let world = World::new();
    let session_id = {
        let daemon = world.daemon(true, Duration::from_secs(60));
        let mut client = world.client(&daemon).await;
        let session_id = client.create(&world).await;
        client.prompt(&session_id, "hello there").await;
        client.until_turn_ends(&mut Seen::default(), None).await;
        daemon.shutdown().await;
        session_id
    };

    let daemon = world.daemon(true, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    client.attach(&session_id).await;
    // The history comes once, from the journal, not again from the agent.
    let mut seen = Seen::default();
    client.until_turn_ends(&mut seen, None).await;
    assert_eq!(seen.user, "hello there");
    client.prompt(&session_id, "again").await;
    client.until_turn_ends(&mut seen, None).await;
    assert_eq!(seen.agent, "You said: hello thereYou said: again");
}

#[tokio::test]
async fn idle_sessions_close_after_their_grace_and_reopen_in_the_agent() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_millis(100));
    let mut client = world.client(&daemon).await;
    let session_id = client.create(&world).await;
    client.prompt(&session_id, "first").await;
    client.until_turn_ends(&mut Seen::default(), None).await;
    client.connection.shutdown().await;
    wait_for(|| daemon.status().sessions.is_empty()).await;

    // Closed, it's loaded from the agent, whose replay fills a new journal.
    let mut client = world.client(&daemon).await;
    let attached = client.attach(&session_id).await;
    assert!(attached.replay.reset);
    let mut seen = Seen::default();
    client.prompt(&session_id, "back").await;
    client.until_turn_ends(&mut seen, None).await;
    assert_eq!(seen.agent, "You said: firstYou said: back");
}

#[tokio::test]
async fn blank_sessions_are_left_out_of_the_list_until_prompted() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    let session_id = client.create(&world).await;
    // A blank session offers nothing a new one doesn't, so it isn't listed even by an agent
    // that saved it, as the fake agent does.
    assert_eq!(client.list(&world).await, Vec::<SessionId>::new());
    client.prompt(&session_id, "hello").await;
    client.until_turn_ends(&mut Seen::default(), None).await;
    assert_eq!(client.list(&world).await, [session_id]);
}

#[tokio::test]
async fn a_client_reattaching_to_a_blank_session_is_told_it_is_blank() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    let state = client.create_with(&world, "fake").await;
    assert!(state.blank);
    let session_id = state.session_id;
    // As after a reload, which reattaches by id.
    let mut again = world.client(&daemon).await;
    assert!(again.attach(&session_id).await.state.blank);
    client.prompt(&session_id, "hello").await;
    client.until_turn_ends(&mut Seen::default(), None).await;
    let mut later = world.client(&daemon).await;
    assert!(!later.attach(&session_id).await.state.blank);
}

#[tokio::test]
async fn a_blank_session_closes_soon_after_it_is_left_and_keeps_no_journal() {
    let world = World::new();
    let daemon = world.daemon_with(
        true,
        Duration::from_secs(60),
        Duration::from_millis(100),
        false,
    );
    let mut used = world.client(&daemon).await;
    let prompted = used.create(&world).await;
    used.prompt(&prompted, "hello").await;
    used.until_turn_ends(&mut Seen::default(), None).await;
    used.connection.shutdown().await;
    let mut left = world.client(&daemon).await;
    let blank = left.create(&world).await;
    assert!(world.has_journal(&blank));
    left.connection.shutdown().await;

    wait_for(|| daemon.status().sessions.len() == 1).await;
    // The prompted session waits out the idle grace and keeps its journal.
    assert_eq!(daemon.status().sessions[0].info.session_id, prompted);
    assert!(world.has_journal(&prompted));
    assert!(!world.has_journal(&blank));
}

#[tokio::test]
async fn a_stopping_host_closes_blank_sessions_instead_of_leaving_them_open() {
    let world = World::new();
    let daemon = world.daemon(true, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    let prompted = client.create(&world).await;
    client.prompt(&prompted, "hello").await;
    client.until_turn_ends(&mut Seen::default(), None).await;
    let blank = client.create(&world).await;
    daemon.shutdown().await;
    // The prompted session is left for a later Host to take up; the blank one is gone.
    assert!(world.has_journal(&prompted));
    assert!(!world.has_journal(&blank));
}

#[tokio::test]
async fn sessions_a_stopped_host_left_open_stop_leading_the_list_after_the_idle_grace() {
    let world = World::new();
    let (left_open, closed) = {
        let daemon = world.daemon(true, Duration::from_secs(60));
        let mut client = world.client(&daemon).await;
        let left_open = client.create(&world).await;
        client.prompt(&left_open, "first").await;
        client.until_turn_ends(&mut Seen::default(), None).await;
        // Used later but closed, so the agent lists it first.
        let closed = client.create(&world).await;
        client.prompt(&closed, "later").await;
        client.until_turn_ends(&mut Seen::default(), None).await;
        client
            .connection
            .send(CloseSessionRequest {
                session_id: closed.clone(),
            })
            .await
            .expect("session/close");
        daemon.shutdown().await;
        (left_open, closed)
    };
    // Within the grace, it leads the list, as an open session would.
    let daemon = world.daemon(true, Duration::from_secs(60));
    let client = world.client(&daemon).await;
    assert_eq!(
        client.list(&world).await,
        [left_open.clone(), closed.clone()]
    );

    // After it, it's where the agent lists it, as if it had closed by itself...
    let grace = Duration::from_millis(200);
    tokio::time::sleep(grace + Duration::from_millis(100)).await;
    let daemon = world.daemon(true, grace);
    let mut client = world.client(&daemon).await;
    let listing = client.listing(&world).await;
    let order: Vec<&SessionId> = listing
        .iter()
        .map(|listing| &listing.info.session_id)
        .collect();
    assert_eq!(order, [&closed, &left_open]);
    assert_eq!(listing[1].state, SessionStatus::Suspended);
    // ...but it still reopens from its journal.
    client.attach(&left_open).await;
    let mut seen = Seen::default();
    client.until_turn_ends(&mut seen, None).await;
    assert_eq!(seen.user, "first");
}

#[tokio::test]
async fn command_output_reaches_clients_and_is_replayed() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    let session_id = client.create(&world).await;
    client.prompt(&session_id, "run echo from-the-host").await;
    let mut seen = Seen::default();
    client.until_turn_ends(&mut seen, None).await;
    assert_eq!(seen.terminal, "from-the-host\n");

    let mut late = world.client(&daemon).await;
    late.attach(&session_id).await;
    let mut seen = Seen::default();
    late.until_turn_ends(&mut seen, None).await;
    assert_eq!(seen.terminal, "from-the-host\n");
}

#[tokio::test]
async fn sessions_list_with_their_activity_and_close_when_left() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    let session_id = client.create(&world).await;
    client.prompt(&session_id, "hello").await;
    client.until_turn_ends(&mut Seen::default(), None).await;
    let listing = client.listing(&world).await;
    let entry = listing
        .iter()
        .find(|listing| listing.info.session_id == session_id)
        .expect("the open session is listed");
    assert_eq!(
        (entry.state, entry.clients, entry.activity),
        (SessionStatus::Open, 1, Some(Activity::Idle))
    );
    // Across agents too.
    let everything = client
        .connection
        .send(ListSessionsRequest::default())
        .await
        .expect("sessions/list");
    assert!(
        everything
            .sessions
            .iter()
            .any(|listing| listing.info.session_id == session_id && listing.agent_id == "fake")
    );

    client
        .connection
        .send(DetachSessionRequest {
            session_id,
            close: CloseWhen::IfUnused,
        })
        .await
        .expect("session/detach");
    wait_for(|| daemon.status().sessions.is_empty()).await;
}

#[tokio::test]
async fn a_client_signs_in_through_the_host_and_retries() {
    let world = World::new();
    let daemon = world.daemon_with(
        false,
        Duration::from_secs(60),
        Duration::from_secs(60),
        true,
    );
    let mut client = world.client(&daemon).await;
    let error = client
        .connection
        .send(TestClient::create_request(&world, "fake"))
        .await
        .expect_err("the agent wants a sign-in first");
    assert!(weave_acp_core::is_auth_required(&error), "{error}");
    client
        .connection
        .send(weave_host_protocol::agents::AuthenticateAgentRequest {
            agent_id: "fake".to_owned(),
            method_id: "token".into(),
        })
        .await
        .expect("agents/authenticate");
    let session_id = client.create(&world).await;
    assert!(
        daemon
            .status()
            .sessions
            .iter()
            .any(|session| session.info.session_id == session_id)
    );
}

#[tokio::test]
async fn open_sessions_lead_the_list_so_continue_finds_them() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let mut left = world.client(&daemon).await;
    let open = left.create(&world).await;
    left.prompt(&open, "first").await;
    left.until_turn_ends(&mut Seen::default(), None).await;
    left.connection.shutdown().await;
    // A session used more recently, but closed, so the agent lists it first.
    let mut other = world.client(&daemon).await;
    let closed = other.create(&world).await;
    other.prompt(&closed, "later").await;
    other.until_turn_ends(&mut Seen::default(), None).await;
    other
        .connection
        .send(CloseSessionRequest {
            session_id: closed.clone(),
        })
        .await
        .expect("session/close");
    wait_for(|| daemon.status().sessions.len() == 1).await;
    assert_eq!(other.list(&world).await, [open, closed]);
}

#[tokio::test]
async fn closing_a_session_closes_it_for_every_client() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    let session_id = client.create(&world).await;
    client.prompt(&session_id, "slow 20").await;
    let control = world.client(&daemon).await;
    control
        .connection
        .send(CloseSessionRequest {
            session_id: session_id.clone(),
        })
        .await
        .expect("session/close");
    let mut failed = false;
    let reason = loop {
        if let HostEvent::Event(event) = client.next().await {
            match event.event {
                SessionEvent::Closed { reason } => break reason,
                SessionEvent::TurnEnded { error, .. } => failed = error.is_some(),
                _ => {}
            }
        }
    };
    assert!(failed, "the turn ends with the session");
    assert_eq!(reason, "closed by a client");
    assert!(daemon.status().sessions.is_empty());
    let again = control
        .connection
        .send(CloseSessionRequest { session_id })
        .await;
    assert!(
        again
            .as_ref()
            .is_err_and(|error| errors::is(error, errors::SESSION_NOT_OPEN)),
        "{again:?}"
    );
}

#[tokio::test]
async fn sessions_a_stopped_host_left_open_lead_the_list_with_headless_ones_marked() {
    let world = World::new();
    let (interactive, headless, closed) = {
        let daemon = world.daemon(true, Duration::from_secs(60));
        let mut left = world.client(&daemon).await;
        let interactive = left.create(&world).await;
        left.prompt(&interactive, "mine").await;
        left.until_turn_ends(&mut Seen::default(), None).await;
        left.connection.shutdown().await;
        let mut run = run_request(&world, &world.cwd().join("unused"), Vec::new());
        run.prompt = vec![ContentBlock::from("a headless run".to_owned())];
        run.policy = PermissionPolicy::headless(Vec::new());
        let headless = daemon.run(run).await.expect("run");
        wait_for(|| {
            daemon
                .status()
                .sessions
                .iter()
                .all(|session| session.activity == Some(Activity::Idle))
        })
        .await;
        // Used last but closed, so the agent lists it first.
        let mut other = world.client(&daemon).await;
        let closed = other.create(&world).await;
        other.prompt(&closed, "later").await;
        other.until_turn_ends(&mut Seen::default(), None).await;
        other
            .connection
            .send(CloseSessionRequest {
                session_id: closed.clone(),
            })
            .await
            .expect("close");
        daemon.shutdown().await;
        (interactive, headless, closed)
    };

    let daemon = world.daemon(true, Duration::from_secs(60));
    let client = world.client(&daemon).await;
    let listing = client.listing(&world).await;
    let order: Vec<&SessionId> = listing
        .iter()
        .map(|listing| &listing.info.session_id)
        .collect();
    assert_eq!(order, [&headless, &interactive, &closed]);
    let flags: Vec<bool> = listing.iter().map(|listing| listing.headless).collect();
    assert_eq!(flags, [true, false, false]);
}

#[tokio::test]
async fn a_session_opens_only_with_its_own_agent_and_says_where_it_works() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    let session_id = client.create(&world).await;

    let other = world.client(&daemon).await;
    let refused = other
        .connection
        .send(AttachSessionRequest {
            session_id: session_id.clone(),
            after: None,
            agent_id: Some("other".to_owned()),
            cwd: None,
            trace: false,
        })
        .await
        .expect_err("another agent's session");
    assert!(errors::is(&refused, errors::WRONG_AGENT), "{refused}");

    // Attached from anywhere, the session still works in its own directory.
    let mut second = world.client(&daemon).await;
    let attached = second.attach(&session_id).await;
    assert_eq!(attached.state.cwd, world.cwd());
    assert_eq!(attached.state.agent.id, "fake");
}

#[tokio::test]
async fn one_connection_reaches_sessions_of_two_agents() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    let fake = client.create_with(&world, "fake").await;
    let other = client.create_with(&world, "other").await;
    assert_eq!(
        (fake.agent.id.as_str(), other.agent.id.as_str()),
        ("fake", "other")
    );
    client.prompt(&fake.session_id, "one").await;
    client.until_turn_ends(&mut Seen::default(), None).await;
    client.prompt(&other.session_id, "two").await;
    let mut seen = Seen::default();
    client.until_turn_ends(&mut seen, None).await;
    assert_eq!(seen.agent, "You said: two");
    let status = daemon.status();
    assert_eq!(status.sessions.len(), 2);
}

#[tokio::test]
async fn new_sessions_start_in_the_configured_mode_unless_asked_for_another() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    // The fake agent offers its modes as a config option, which takes precedence.
    let current_mode = |state: &SessionState| {
        state
            .config_options
            .iter()
            .find_map(|option| match (&option.category, &option.kind) {
                (Some(SessionConfigOptionCategory::Mode), SessionConfigKind::Select(select)) => {
                    Some(select.current_value.to_string())
                }
                _ => None,
            })
    };
    let configured = client.create_with(&world, "fake").await;
    assert_eq!(current_mode(&configured).as_deref(), Some("code"));
    let mut request = TestClient::create_request(&world, "fake");
    request.mode = Some("Ask".to_owned());
    let asked = client.connection.send(request).await.expect("create");
    assert_eq!(current_mode(&asked).as_deref(), Some("ask"));
    let mut request = TestClient::create_request(&world, "fake");
    request.mode = Some("nonsense".to_owned());
    let missing = client.connection.send(request).await.expect("create");
    assert!(
        missing
            .notices
            .iter()
            .any(|notice| notice.contains("no mode nonsense")),
        "{:?}",
        missing.notices
    );
}

#[tokio::test]
async fn agents_are_listed_and_unknown_ones_refused() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let client = world.client(&daemon).await;
    let listed = client
        .connection
        .send(weave_host_protocol::agents::ListAgentsRequest::default())
        .await
        .expect("agents/list");
    let ids: Vec<&str> = listed
        .agents
        .iter()
        .map(|agent| agent.id.as_str())
        .collect();
    for id in ["claude", "codex", "gemini", "fake", "other"] {
        assert!(ids.contains(&id), "{ids:?}");
    }
    let got = client
        .connection
        .send(weave_host_protocol::agents::GetAgentRequest {
            agent_id: "fake".to_owned(),
        })
        .await
        .expect("agents/get");
    assert!(got.initialize.agent_capabilities.load_session);
    let refused = client
        .connection
        .send(TestClient::create_request(&world, "nobody"))
        .await
        .expect_err("no such agent");
    assert!(errors::is(&refused, errors::UNKNOWN_AGENT), "{refused}");
}

/// A raw connection, to say things a well-behaved client wouldn't.
async fn raw(daemon: &Daemon) -> (ConnectionTo<Host>, tokio::task::JoinHandle<()>) {
    let transport = daemon.connect_in_process();
    let (cx_tx, cx_rx) = tokio::sync::oneshot::channel();
    let driver = tokio::spawn(async move {
        let _ = HostClient
            .builder()
            .connect_with(transport, async move |cx: ConnectionTo<Host>| {
                let _ = cx_tx.send(cx.clone());
                cx.incoming_closed().await;
                Ok(())
            })
            .await;
    });
    (cx_rx.await.expect("connected"), driver)
}

#[tokio::test]
async fn hello_comes_first_and_settles_the_version() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let (cx, driver) = raw(&daemon).await;
    let early = cx
        .send_request(StatusRequest {})
        .block_task()
        .await
        .expect_err("before hello");
    assert!(errors::is(&early, errors::UNAUTHENTICATED), "{early}");
    let hello = |protocol| HelloRequest {
        protocol,
        client: ClientInfo {
            name: "raw".to_owned(),
            version: "0".to_owned(),
        },
        auth: Auth::Local,
        capabilities: ClientCapabilities::default(),
    };
    let newer = cx
        .send_request(hello(VersionRange { min: 3, max: 4 }))
        .block_task()
        .await
        .expect_err("no common version");
    assert!(errors::is(&newer, errors::INCOMPATIBLE_PROTOCOL), "{newer}");
    let mut token = hello(VersionRange::supported());
    token.auth = Auth::Token {
        token: "x".to_owned(),
    };
    let refused = cx
        .send_request(token)
        .block_task()
        .await
        .expect_err("no tokens yet");
    assert!(errors::is(&refused, errors::UNAUTHENTICATED), "{refused}");
    let accepted = cx
        .send_request(hello(VersionRange { min: 1, max: 9 }))
        .block_task()
        .await
        .expect("hello");
    assert_eq!(accepted.protocol, 2);
    driver.abort();
}

/// A TUI built before this protocol says ACP `initialize`, and reads the version it's told.
#[tokio::test]
async fn a_client_from_before_this_protocol_is_told_the_version() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let (cx, driver) = raw(&daemon).await;
    let answer = cx
        .send_request(InitializeRequest::new(weave_acp_core::ProtocolVersion::V1))
        .block_task()
        .await
        .expect("initialize");
    let protocol = answer
        .meta
        .as_ref()
        .and_then(|meta| meta.get("weave"))
        .and_then(|weave| weave.get("protocol"))
        .and_then(serde_json::Value::as_u64);
    assert_eq!(protocol, Some(2));
    driver.abort();
}

/// The fake agent's script for a client tool call.
const COPY: &str = r#"tool clipboard_write {"text": "cargo test"}"#;

#[tokio::test]
async fn a_client_tool_call_goes_to_the_client_that_sent_the_turn() {
    client_tools_reach_the_turns_client(false).await;
}

#[tokio::test]
async fn client_tools_reach_agents_that_take_mcp_over_acp() {
    client_tools_reach_the_turns_client(true).await;
}

/// The call is a pending request every attached client sees, which only the client that sent
/// the turn may answer, through the stdio bridge or over ACP.
async fn client_tools_reach_the_turns_client(over_acp: bool) {
    let world = World::new();
    let daemon = if over_acp {
        world.daemon_over_acp()
    } else {
        world.daemon(false, Duration::from_secs(60))
    };
    let mut runner = world.tool_client(&daemon).await;
    let session_id = runner.create(&world).await;
    let mut other = world.tool_client(&daemon).await;
    other.attach(&session_id).await;

    runner.prompt(&session_id, COPY).await;
    let mut seen = Seen::default();
    let (_, call) = runner.tool_call(&mut seen).await;
    assert_eq!(
        call.request,
        PendingKind::ClientTool {
            tool: CLIPBOARD_WRITE.to_owned(),
            arguments: serde_json::json!({"text": "cargo test"})
                .as_object()
                .cloned()
                .expect("an object"),
            target: runner.connection.client_id().clone(),
        }
    );
    let (_, seen_by_other) = other.tool_call(&mut Seen::default()).await;
    assert_eq!(seen_by_other.id, call.id);
    let refused = other
        .run_tool(&session_id, &call, ClientToolResult::text("not mine"))
        .await;
    assert!(
        refused
            .as_ref()
            .is_err_and(|error| errors::is(error, errors::NOT_TARGET)),
        "{refused:?}"
    );

    runner
        .run_tool(&session_id, &call, ClientToolResult::text("Copied."))
        .await
        .expect("the target answers");
    runner.until_turn_ends(&mut seen, None).await;
    assert!(
        seen.agent.contains("clipboard_write answered: Copied."),
        "{seen:?}"
    );
}

#[tokio::test]
async fn a_client_tool_call_fails_at_once_without_a_client_that_runs_it() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_secs(60));
    // This client runs no client tools.
    let mut client = world.client(&daemon).await;
    let session_id = client.create(&world).await;
    client.prompt(&session_id, COPY).await;
    let mut seen = Seen::default();
    client.until_turn_ends(&mut seen, None).await;
    assert!(
        seen.agent.contains(
            "clipboard_write failed: The device of the person who sent this turn can't run \
             clipboard_write."
        ),
        "{seen:?}"
    );

    // Nor has a headless run anyone's device.
    let mut request = run_request(&world, &world.cwd().join("unused"), Vec::new());
    request.prompt = vec![ContentBlock::from(COPY.to_owned())];
    request.attach = true;
    client.connection.send(request).await.expect("session/run");
    let mut seen = Seen::default();
    client.until_turn_ends(&mut seen, None).await;
    assert!(seen.agent.contains("came from a headless run"), "{seen:?}");
}

#[tokio::test]
async fn a_client_tool_call_fails_as_one_that_may_have_run_when_its_client_leaves() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let mut runner = world.tool_client(&daemon).await;
    let session_id = runner.create(&world).await;
    let mut watcher = world.client(&daemon).await;
    watcher.attach(&session_id).await;

    runner.prompt(&session_id, COPY).await;
    let (_, call) = runner.tool_call(&mut Seen::default()).await;
    runner.connection.shutdown().await;

    let mut seen = Seen::default();
    let mut resolved = None;
    loop {
        let event = watcher.next().await;
        if let HostEvent::PendingResolved(event) = &event {
            resolved = Some((event.pending_id.clone(), event.outcome));
        }
        if watcher.note(event, &mut seen, None).await {
            break;
        }
    }
    assert_eq!(resolved, Some((call.id, Resolution::Cancelled)));
    assert!(seen.agent.contains("the tool may have run"), "{seen:?}");
}

#[tokio::test]
async fn cancelling_the_turn_cancels_its_client_tool_call() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let mut runner = world.tool_client(&daemon).await;
    let session_id = runner.create(&world).await;
    runner.prompt(&session_id, COPY).await;
    let (_, call) = runner.tool_call(&mut Seen::default()).await;
    runner
        .connection
        .send(CancelTurnRequest {
            session_id: session_id.clone(),
        })
        .await
        .expect("turn/cancel");
    loop {
        if let HostEvent::PendingResolved(resolved) = runner.next().await {
            assert_eq!(resolved.pending_id, call.id);
            assert_eq!(resolved.outcome, Resolution::Cancelled);
            break;
        }
    }
    let late = runner
        .run_tool(&session_id, &call, ClientToolResult::text("too late"))
        .await;
    assert!(
        late.as_ref()
            .is_err_and(|error| errors::is(error, errors::ALREADY_RESOLVED)),
        "{late:?}"
    );
}

#[tokio::test]
async fn the_configuration_decides_which_client_tools_agents_are_offered() {
    let world = World::new();
    std::fs::write(
        world.dir.path().join("config.toml"),
        "client_tools = []\n\n[agents.fake]\ncommand = \"fake-agent\"\n",
    )
    .expect("config");
    let daemon = world.daemon(false, Duration::from_secs(60));
    let mut runner = world.tool_client(&daemon).await;
    let session_id = runner.create(&world).await;
    runner.prompt(&session_id, COPY).await;
    let mut seen = Seen::default();
    runner.until_turn_ends(&mut seen, None).await;
    assert!(
        seen.agent.contains("unknown tool: clipboard_write"),
        "{seen:?}"
    );
}

#[tokio::test]
async fn an_agent_on_an_older_mcp_is_refused_and_its_clients_told() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    let session_id = client.create(&world).await;
    client.prompt(&session_id, "mcp-legacy").await;
    let mut seen = Seen::default();
    client.until_turn_ends(&mut seen, None).await;
    assert!(seen.agent.contains("weave refused initialize"), "{seen:?}");
    assert!(seen.agent.contains("-32022"), "{seen:?}");
    // The notice may come after the turn's end.
    while seen.notices.is_empty() {
        let event = client.next().await;
        client.note(event, &mut seen, None).await;
    }
    assert_eq!(seen.notices.len(), 1);
    assert!(
        seen.notices[0].contains("predates MCP 2026-07-28"),
        "{seen:?}"
    );

    // Later clients see it in the journal.
    let mut later = world.client(&daemon).await;
    later.attach_after(&session_id, None).await.expect("attach");
    let mut replayed = Seen::default();
    while replayed.notices.is_empty() {
        let event = later.next().await;
        later.note(event, &mut replayed, None).await;
    }
}

#[tokio::test]
async fn the_mcp_socket_is_private_and_refuses_an_unknown_token() {
    use tokio::io::AsyncReadExt;
    use tokio::io::AsyncWriteExt;

    let world = World::new();
    let socket = world.dir.path().join("mcp.sock");
    let mut config = world.config(
        false,
        Duration::from_secs(60),
        Duration::from_secs(60),
        false,
    );
    config.mcp_socket = Some(socket.clone());
    let daemon = Daemon::new(config);
    let mut client = world.client(&daemon).await;
    // Declaring the server for a session starts the socket.
    client.create(&world).await;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&socket)
            .expect("the socket")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    let (agent, bridge) = tokio::io::duplex(4096);
    let (from_agent, to_agent) = tokio::io::split(bridge);
    tokio::spawn(async move {
        let _ = mcp::relay(&socket, "not-a-token", from_agent, to_agent).await;
    });
    let (mut read, mut write) = tokio::io::split(agent);
    let discover = r#"{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}"#;
    write
        .write_all(format!("{discover}\n").as_bytes())
        .await
        .expect("written");
    // The Host closes the connection without answering.
    let mut answer = String::new();
    tokio::time::timeout(WAIT, read.read_to_string(&mut answer))
        .await
        .expect("closed in time")
        .expect("read");
    assert_eq!(answer, "");
}
