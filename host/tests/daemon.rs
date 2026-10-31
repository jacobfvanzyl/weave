//! The Host end to end: real clients (`weave-host-client`) connected in-process to a Host
//! whose agents are in-process fake agents sharing one state file, as separate processes of
//! one agent would share its storage.

#![allow(clippy::expect_used)]

use std::collections::HashMap;
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
use weave_fake_agent::FakeAgentConfig;
use weave_fake_agent::StdioMcp;
use weave_fake_agent::StdioPipes;
use weave_host::Daemon;
use weave_host::DaemonConfig;
use weave_host::Launch;
use weave_host::Launcher;
use weave_host::Withheld;
use weave_host::mcp;
use weave_host_client::HostConnection;
use weave_host_client::HostEvent;
use weave_host_protocol::Host;
use weave_host_protocol::HostClient;
use weave_host_protocol::VersionRange;
use weave_host_protocol::errors;
use weave_host_protocol::events::SessionEvent;
use weave_host_protocol::files::FileEntry;
use weave_host_protocol::files::FileKind;
use weave_host_protocol::files::LIST_FEATURE as LIST_FILES_FEATURE;
use weave_host_protocol::files::ListFilesRequest;
use weave_host_protocol::hello::Auth;
use weave_host_protocol::hello::ClientCapabilities;
use weave_host_protocol::hello::ClientInfo;
use weave_host_protocol::hello::HelloRequest;
use weave_host_protocol::host::DRAIN_FEATURE;
use weave_host_protocol::host::DrainRequest;
use weave_host_protocol::host::Service;
use weave_host_protocol::host::StatusRequest;
use weave_host_protocol::pending::AnswerPendingRequest;
use weave_host_protocol::pending::PendingKind;
use weave_host_protocol::pending::PendingRequest;
use weave_host_protocol::pending::Resolution;
use weave_host_protocol::policy::PermissionPolicy;
use weave_host_protocol::policy::Unapproved;
use weave_host_protocol::queue::AddQueuedRequest;
use weave_host_protocol::queue::AddQueuedResponse;
use weave_host_protocol::queue::FEATURE as QUEUE_FEATURE;
use weave_host_protocol::queue::QueuePause;
use weave_host_protocol::queue::RemoveQueuedRequest;
use weave_host_protocol::queue::ResumeQueueRequest;
use weave_host_protocol::sessions::Activity;
use weave_host_protocol::sessions::AttachSessionRequest;
use weave_host_protocol::sessions::AttachSessionResponse;
use weave_host_protocol::sessions::CloseSessionRequest;
use weave_host_protocol::sessions::CloseWhen;
use weave_host_protocol::sessions::CreateSessionRequest;
use weave_host_protocol::sessions::DeleteSessionRequest;
use weave_host_protocol::sessions::DetachSessionRequest;
use weave_host_protocol::sessions::GetSessionRequest;
use weave_host_protocol::sessions::GetSessionResponse;
use weave_host_protocol::sessions::JournalPosition;
use weave_host_protocol::sessions::ListSessionsRequest;
use weave_host_protocol::sessions::OBSERVE_FEATURE;
use weave_host_protocol::sessions::RenameSessionRequest;
use weave_host_protocol::sessions::RunRequest;
use weave_host_protocol::sessions::SessionListing;
use weave_host_protocol::sessions::SessionState;
use weave_host_protocol::sessions::SessionStatus;
use weave_host_protocol::sessions::TurnOrigin;
use weave_host_protocol::sessions::TurnState;
use weave_host_protocol::sessions::UnwatchSessionsRequest;
use weave_host_protocol::sessions::WATCH_FEATURE;
use weave_host_protocol::sessions::WatchSessionsRequest;
use weave_host_protocol::tools::CLIPBOARD_WRITE;
use weave_host_protocol::tools::ClientToolResult;
use weave_host_protocol::turns::CancelTurnRequest;
use weave_host_protocol::turns::REQUEST_KEYS_FEATURE;
use weave_host_protocol::turns::STEER_FEATURE;
use weave_host_protocol::turns::StartTurnRequest;
use weave_host_protocol::turns::SteerOutcome;
use weave_host_protocol::turns::SteerTurnRequest;
use weave_host_protocol::turns::SteerTurnResponse;
use weave_host_protocol::turns::TURN_IDS_FEATURE;
use weave_host_protocol::worktrees::CreateWorktreeRequest;
use weave_host_protocol::worktrees::CreateWorktreeResponse;
use weave_host_protocol::worktrees::Divergence;
use weave_host_protocol::worktrees::FEATURE as WORKTREES_FEATURE;
use weave_host_protocol::worktrees::GitLocation;
use weave_host_protocol::worktrees::ListWorktreesRequest;
use weave_host_protocol::worktrees::ReleaseWorktreeRequest;
use weave_host_protocol::worktrees::RemoveWorktreeRequest;
use weave_host_protocol::worktrees::RemoveWorktreeResponse;
use weave_host_protocol::worktrees::Worktree;

const WAIT: Duration = Duration::from_secs(10);

/// Fake agents in-process, sharing `state` so sessions outlive any one of them. The stdio
/// MCP servers they're given are the Host's bridge, which they run in-process too: the same
/// relay `weave mcp-bridge` runs, to the Host's MCP socket.
fn fake_agents(state: PathBuf, require_auth: bool) -> Launcher {
    fake_agents_with(state, require_auth, false)
}

/// [`fake_agents`], advertising MCP servers over ACP when `mcp_over_acp`.
fn fake_agents_with(state: PathBuf, require_auth: bool, mcp_over_acp: bool) -> Launcher {
    fake_agents_tuned(state, move |config| {
        config.require_auth = require_auth;
        config.mcp_over_acp = mcp_over_acp;
    })
}

/// [`fake_agents`], with `tune` making changes of its own to each one's configuration.
fn fake_agents_tuned(
    state: PathBuf,
    tune: impl Fn(&mut FakeAgentConfig) + Send + Sync + 'static,
) -> Launcher {
    Arc::new(move |launch: &Launch, options: ClientOptions, _traces| {
        let mut config = FakeAgentConfig {
            state_path: Some(state.clone()),
            stdio_mcp: in_process_bridge(),
            ..FakeAgentConfig::default()
        };
        tune(&mut config);
        // In-process, but with the environment a process would start with, for its terminals.
        let environment = launch.agent_environment();
        Box::pin(async move {
            let (client, agent) = Channel::duplex();
            tokio::spawn(weave_fake_agent::serve_with(agent, config));
            AgentConnection::connect_in(client, options, environment)
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

/// The names agent processes were started with, by directory.
type Started = Arc<std::sync::Mutex<Vec<(PathBuf, String)>>>;

impl World {
    fn new() -> Self {
        let dir = tempfile::tempdir().expect("tempdir");
        // Two agents the Host knows from its config; the launcher runs both as the fake one.
        std::fs::write(
            dir.path().join("config.toml"),
            "[agents.fake]\ncommand = \"fake-agent\"\nmode = \"code\"\n\n\
             [agents.other]\ndescription = \"Another fake agent\"\ncommand = \"other-agent\"\n",
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

    /// A Host whose drain gives up after `timeout`, and the names its agent processes were
    /// started with, by directory.
    fn daemon_draining(&self, timeout: Duration) -> (Daemon, Started) {
        let mut config = self.config(
            false,
            Duration::from_secs(60),
            Duration::from_secs(60),
            false,
        );
        config.drain_timeout = timeout;
        let started = Arc::new(std::sync::Mutex::new(Vec::new()));
        let record = Arc::clone(&started);
        let launcher = config.launcher.clone();
        config.launcher = Arc::new(move |launch: &Launch, options, traces| {
            record
                .lock()
                .expect("lock")
                .push((launch.cwd.clone(), launch.process.clone()));
            launcher(launch, options, traces)
        });
        (Daemon::new(config), started)
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

    /// A Host with journals whose agents advertise nothing optional, deleting sessions included.
    fn daemon_minimal(&self) -> Daemon {
        let mut config = self.config(
            true,
            Duration::from_secs(60),
            Duration::from_secs(60),
            false,
        );
        config.launcher = fake_agents_tuned(self.dir.path().join("agent-state.json"), |config| {
            config.minimal = true;
        });
        Daemon::new(config)
    }

    /// A Host whose agents list their sessions in every directory whatever `cwd` asks, as
    /// Claude's lists a repository's other worktrees.
    fn daemon_listing_every_directory(&self) -> Daemon {
        let mut config = self.config(
            false,
            Duration::from_secs(60),
            Duration::from_secs(60),
            false,
        );
        config.launcher = fake_agents_tuned(self.dir.path().join("agent-state.json"), |config| {
            config.list_every_directory = true;
        });
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
            drain_timeout: weave_host::DEFAULT_DRAIN_TIMEOUT,
            blank_grace,
            launcher: fake_agents(self.dir.path().join("agent-state.json"), require_auth),
            config_file: Some(self.dir.path().join("config.toml")),
            registry_cache: Some(self.dir.path().join("cache")),
            agents: Default::default(),
            withheld: Withheld::default(),
            environment: Environment {
                vars: ISOLATED_GIT
                    .iter()
                    .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
                    .collect(),
                ..Environment::default()
            },
            service: Service::InProcess,
            traces: self.dir.path().join("traces"),
            devices: Some(self.dir.path().join("devices.json")),
            upstream: Arc::new(weave_agents::update::Offline),
            mcp_socket: None,
            mcp_bridge: vec!["weave-mcp-bridge".to_owned()],
            remote: None,
            terminals: None,
            peers: None,
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

    /// A repository at `code/weave` with one commit on `main`, by its path with symlinks
    /// resolved, as the Host gives paths in repositories.
    fn repository(&self) -> PathBuf {
        let repo = self.dir.path().join("code/weave");
        std::fs::create_dir_all(&repo).expect("the repository's directory");
        git(&repo, &["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("README.md"), "weave\n").expect("a file");
        git(&repo, &["add", "README.md"]);
        git(&repo, &["commit", "-q", "-m", "init"]);
        repo.canonicalize().expect("canonical")
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
    /// Titles the session was renamed to through the Host, and by whom.
    renamed: Vec<(String, Option<TurnOrigin>)>,
    /// Each turn's origin, and the queued prompt it started from.
    origins: Vec<(TurnOrigin, Option<String>)>,
    /// Each turn's id.
    turn_ids: Vec<Option<String>>,
    /// Prompts that joined the queue, by id, and those taken out.
    queued: Vec<String>,
    unqueued: Vec<String>,
    /// Why the queue paused, each time, and how often it resumed.
    paused: Vec<QueuePause>,
    resumed: usize,
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

    /// A session in `dir`, prompted once so it isn't blank.
    async fn session_in(&mut self, world: &World, dir: &Path) -> SessionState {
        let state = self
            .connection
            .send(CreateSessionRequest {
                cwd: dir.to_path_buf(),
                ..Self::create_request(world, "fake")
            })
            .await
            .expect("session/create");
        self.prompt(&state.session_id, "hello").await;
        self.until_turn_ends(&mut Seen::default(), None).await;
        state
    }

    /// The Host's own listing, across agents, of the sessions in `repo`'s repository.
    async fn in_repository(&self, repo: &Path) -> Vec<SessionListing> {
        self.connection
            .send(ListSessionsRequest {
                repo: Some(repo.to_path_buf()),
                ..ListSessionsRequest::default()
            })
            .await
            .expect("sessions/list")
            .sessions
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
                observe: false,
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
                repo: None,
                activity: None,
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
                key: None,
            })
            .await
            .expect("turn/start")
            .seq
    }

    async fn queue(&self, session_id: &SessionId, text: &str) -> AddQueuedResponse {
        self.queue_keyed(session_id, text, None)
            .await
            .expect("queue/add")
    }

    async fn queue_keyed(
        &self,
        session_id: &SessionId,
        text: &str,
        key: Option<&str>,
    ) -> Result<AddQueuedResponse, Error> {
        self.connection
            .send(AddQueuedRequest {
                session_id: session_id.clone(),
                prompt: vec![ContentBlock::from(text.to_owned())],
                key: key.map(str::to_owned),
                caller: None,
            })
            .await
    }

    async fn steer(&self, session_id: &SessionId, text: &str) -> SteerTurnResponse {
        self.connection
            .send(SteerTurnRequest {
                session_id: session_id.clone(),
                prompt: vec![ContentBlock::from(text.to_owned())],
                caller: None,
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

    /// Watch the Host's sessions: how they list now.
    async fn watch(&self) -> Vec<SessionListing> {
        self.connection
            .send(WatchSessionsRequest {})
            .await
            .expect("sessions/watch")
            .sessions
    }

    /// The next change to the Host's sessions this client hears of, passing over the rest.
    async fn change(&mut self) -> Change {
        loop {
            match self.next().await {
                HostEvent::SessionUpdated(updated) => {
                    return Change::Updated(Box::new(updated.session));
                }
                HostEvent::SessionRemoved(removed) => return Change::Removed(removed.session_id),
                _ => {}
            }
        }
    }

    /// Whether a change to the Host's sessions comes within a moment.
    async fn hears_a_change(&mut self) -> bool {
        tokio::time::timeout(Duration::from_millis(300), self.change())
            .await
            .is_ok()
    }

    /// Changes until one `done` accepts, which is the last.
    async fn changes_until(&mut self, mut done: impl FnMut(&Change) -> bool) -> Vec<Change> {
        let mut changes = Vec::new();
        loop {
            let change = self.change().await;
            let last = done(&change);
            changes.push(change);
            if last {
                return changes;
            }
        }
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
            SessionEvent::TurnStarted {
                prompt,
                origin,
                queued_id,
                turn_id,
                ..
            } => {
                self.started += 1;
                self.origins.push((origin, queued_id));
                self.turn_ids.push(turn_id);
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
            SessionEvent::Renamed { title, by } => self.renamed.push((title, by)),
            SessionEvent::Queued { queued_id, .. } => self.queued.push(queued_id),
            SessionEvent::Unqueued { queued_id, .. } => self.unqueued.push(queued_id),
            SessionEvent::QueuePaused { reason } => self.paused.push(reason),
            SessionEvent::QueueResumed { .. } => self.resumed += 1,
            _ => {}
        }
        false
    }
}

/// A change to the Host's sessions, as a watching client hears it.
#[derive(Debug, PartialEq)]
enum Change {
    Updated(Box<SessionListing>),
    Removed(SessionId),
}

impl Change {
    fn state(&self) -> Option<(SessionStatus, Option<Activity>)> {
        match self {
            Change::Updated(listing) => Some((listing.state, listing.activity)),
            Change::Removed(_) => None,
        }
    }
}

/// Git for a test's repositories, away from the configuration of whoever runs the tests.
const ISOLATED_GIT: &[(&str, &str)] = &[
    ("GIT_CONFIG_GLOBAL", "/dev/null"),
    ("GIT_CONFIG_NOSYSTEM", "1"),
    ("GIT_AUTHOR_NAME", "Test"),
    ("GIT_AUTHOR_EMAIL", "test@example.com"),
    ("GIT_COMMITTER_NAME", "Test"),
    ("GIT_COMMITTER_EMAIL", "test@example.com"),
];

/// Run git in `dir`, as the person would in a terminal; what it printed.
fn git(dir: &Path, args: &[&str]) -> String {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .envs(ISOLATED_GIT.iter().copied())
        .output()
        .expect("git runs");
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
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
        remote: None,
        session_id: None,
        additional_directories: Vec::new(),
        prompt: vec![ContentBlock::from(format!("write {} ok", path.display()))],
        policy: PermissionPolicy {
            approve,
            otherwise: Unapproved::Reject,
        },
        attach: false,
        trace: false,
        key: None,
        caller: None,
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
        turn_id: None,
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
async fn a_restarted_host_keeps_its_sessions_order_and_titles_and_taking_one_up_changes_neither() {
    let world = World::new();
    let before = {
        let daemon = world.daemon(true, Duration::from_secs(60));
        let mut client = world.client(&daemon).await;
        for prompt in ["the older one", "the newer one"] {
            let session_id = client.create(&world).await;
            client.prompt(&session_id, prompt).await;
            client.until_turn_ends(&mut Seen::default(), None).await;
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let listed = client.watch().await;
        daemon.shutdown().await;
        listed
    };
    let shown = |listed: &[SessionListing]| -> Vec<(SessionId, Option<String>, Option<u64>)> {
        listed
            .iter()
            .map(|listing| {
                (
                    listing.info.session_id.clone(),
                    listing.info.title.clone(),
                    listing.last_activity_at,
                )
            })
            .collect()
    };
    assert_eq!(
        before
            .iter()
            .map(|listing| listing.info.title.as_deref())
            .collect::<Vec<_>>(),
        [Some("the newer one"), Some("the older one")]
    );

    // Left open, they're listed as they were.
    let daemon = world.daemon(true, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    assert_eq!(shown(&client.watch().await), shown(&before));

    // Taken up again, as a TUI re-attaching does, the older one stays where it was and keeps its
    // agent's title, though its agent tells its commands again.
    let older = before[1].info.session_id.clone();
    client.attach(&older).await;
    client.until_turn_ends(&mut Seen::default(), None).await;
    wait_for(|| daemon.status().sessions.len() == 1).await;
    assert_eq!(shown(&client.watch().await), shown(&before));
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
async fn sessions_a_stopped_host_left_open_close_if_nobody_takes_them_up_within_the_grace() {
    let world = World::new();
    let (unclaimed, claimed) = {
        let daemon = world.daemon(true, Duration::from_secs(60));
        let mut client = world.client(&daemon).await;
        let unclaimed = client.create(&world).await;
        client.prompt(&unclaimed, "first").await;
        client.until_turn_ends(&mut Seen::default(), None).await;
        let claimed = client.create(&world).await;
        client.prompt(&claimed, "second").await;
        client.until_turn_ends(&mut Seen::default(), None).await;
        daemon.shutdown().await;
        (unclaimed, claimed)
    };
    let journal = world.journals().join(format!("{unclaimed}.jsonl"));
    let age = || {
        std::fs::metadata(&journal)
            .and_then(|metadata| metadata.modified())
            .expect("the journal's age")
    };
    let left = age();
    let host_wide = async |client: &TestClient| {
        client
            .connection
            .send(ListSessionsRequest {
                agent_id: None,
                cwd: None,
                repo: None,
                activity: None,
                cursor: None,
            })
            .await
            .expect("sessions/list")
            .sessions
            .into_iter()
            .map(|listing| (listing.info.session_id, listing.state))
            .collect::<HashMap<_, _>>()
    };

    let daemon = world.daemon(true, Duration::from_secs(60));
    let mut watcher = world.client(&daemon).await;
    let listed = watcher.watch().await;
    assert!(
        listed
            .iter()
            .all(|listing| listing.state == SessionStatus::Suspended)
    );
    // A client takes one up within the grace, as the TUI does after a restart...
    let mut client = world.client(&daemon).await;
    client.attach(&claimed).await;
    client.until_turn_ends(&mut Seen::default(), None).await;

    // ...and once the grace has passed, the other closes, keeping its age.
    daemon.close_unclaimed();
    watcher
        .changes_until(|change| {
            matches!(change, Change::Updated(listing)
                if listing.info.session_id == unclaimed && listing.state == SessionStatus::Closed)
        })
        .await;
    let states = host_wide(&client).await;
    assert_eq!(states[&unclaimed], SessionStatus::Closed);
    assert_eq!(states[&claimed], SessionStatus::Open);
    assert_eq!(age(), left);

    // A later Host finds it closed, and it still opens again, in a new journal.
    daemon.shutdown().await;
    let daemon = world.daemon(true, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    assert_eq!(host_wide(&client).await[&unclaimed], SessionStatus::Closed);
    assert!(client.attach(&unclaimed).await.replay.reset);
}

#[tokio::test]
async fn deleting_a_session_its_agent_cant_delete_still_forgets_it_in_the_host() {
    let world = World::new();
    let daemon = world.daemon_minimal();
    let mut client = world.client(&daemon).await;
    let session_id = client.create(&world).await;
    client.prompt(&session_id, "hello").await;
    client.until_turn_ends(&mut Seen::default(), None).await;
    let mut watcher = world.client(&daemon).await;
    watcher.watch().await;
    assert!(world.has_journal(&session_id));

    client
        .connection
        .send(DeleteSessionRequest {
            session_id: session_id.clone(),
            agent_id: None,
        })
        .await
        .expect("session/delete");
    assert!(!world.has_journal(&session_id));
    watcher
        .changes_until(|change| *change == Change::Removed(session_id.clone()))
        .await;
}

#[tokio::test]
async fn deleting_a_session_whose_directory_is_gone_forgets_it_in_the_host() {
    let world = World::new();
    let worktree = world.cwd().join("worktree");
    std::fs::create_dir(&worktree).expect("the worktree");
    let daemon = world.daemon(true, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    let session_id = client
        .connection
        .send(CreateSessionRequest {
            cwd: worktree.clone(),
            ..TestClient::create_request(&world, "fake")
        })
        .await
        .expect("session/create")
        .session_id;
    client.prompt(&session_id, "hello").await;
    client.until_turn_ends(&mut Seen::default(), None).await;
    client
        .connection
        .send(CloseSessionRequest {
            session_id: session_id.clone(),
        })
        .await
        .expect("session/close");
    std::fs::remove_dir_all(&worktree).expect("the worktree removed");

    client
        .connection
        .send(DeleteSessionRequest {
            session_id: session_id.clone(),
            agent_id: None,
        })
        .await
        .expect("session/delete");
    assert!(!world.has_journal(&session_id));
    // The agent, which would have had to run there, keeps its own history of it.
    let agents_own = client
        .connection
        .send(ListSessionsRequest {
            agent_id: Some("fake".to_owned()),
            cwd: Some(worktree),
            repo: None,
            activity: None,
            cursor: None,
        })
        .await
        .expect("sessions/list")
        .sessions;
    assert!(
        agents_own
            .iter()
            .any(|listing| listing.info.session_id == session_id
                && listing.state == SessionStatus::Closed)
    );
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

/// A command in a Host-run terminal finds what the agent's own would: a tool on the login
/// shell's `PATH` that the Host's own lacks, as under launchd or systemd (WVE-141).
#[cfg(unix)]
#[tokio::test]
async fn host_run_terminals_start_in_the_agents_environment() {
    use std::os::unix::fs::PermissionsExt;

    let world = World::new();
    let bin = world.dir.path().join("login-bin");
    std::fs::create_dir(&bin).expect("bin");
    let tool = bin.join("weave-login-tool");
    std::fs::write(&tool, "#!/bin/sh\necho \"found by $WEAVE_AGENT_PROCESS\"\n").expect("tool");
    std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o755)).expect("mode");
    let mut config = world.config(
        false,
        Duration::from_secs(60),
        Duration::from_secs(60),
        false,
    );
    config.environment.vars.insert(
        "PATH".to_owned(),
        format!("{}:/usr/bin:/bin", bin.display()),
    );
    let daemon = Daemon::new(config);
    let mut client = world.client(&daemon).await;
    let session_id = client.create(&world).await;
    client.prompt(&session_id, "run weave-login-tool").await;
    let mut seen = Seen::default();
    client.until_turn_ends(&mut seen, None).await;
    // Its agent's process name too, so a `weave daemon restart` there knows its own turn.
    assert!(
        seen.terminal.starts_with("found by a-"),
        "{:?}",
        seen.terminal
    );
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

/// Left with `ifUnused` while its turn runs, a session closes when the turn ends rather than
/// after the idle grace, unless a client attaches before then (WVE-159).
#[tokio::test]
async fn a_session_left_mid_turn_closes_when_its_turn_ends_unless_one_attaches() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    let leave = |session_id: &SessionId| DetachSessionRequest {
        session_id: session_id.clone(),
        close: CloseWhen::IfUnused,
    };
    let open = |session_id: &SessionId| {
        daemon
            .status()
            .sessions
            .iter()
            .any(|session| &session.info.session_id == session_id)
    };

    let left = client.create(&world).await;
    client.prompt(&left, "slow 3").await;
    client.connection.send(leave(&left)).await.expect("detach");
    // Its turn carries on, and then it closes.
    assert!(open(&left));
    wait_for(|| !open(&left)).await;

    let taken_back = client.create(&world).await;
    client.prompt(&taken_back, "slow 3").await;
    client
        .connection
        .send(leave(&taken_back))
        .await
        .expect("detach");
    let mut other = world.client(&daemon).await;
    other.attach(&taken_back).await;
    other.until_turn_ends(&mut Seen::default(), None).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(open(&taken_back));
}

/// An observer is sent what clients are without being one: it isn't counted, keeps no session
/// open, closes none by leaving, and never opens one that's closed (WVE-108).
#[tokio::test]
async fn an_observer_follows_a_session_without_holding_it() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    let session_id = client.create(&world).await;
    let open = || {
        daemon
            .status()
            .sessions
            .iter()
            .any(|session| session.info.session_id == session_id)
    };
    let observe = AttachSessionRequest {
        session_id: session_id.clone(),
        after: None,
        agent_id: None,
        cwd: None,
        trace: false,
        observe: true,
    };
    let leave = DetachSessionRequest {
        session_id: session_id.clone(),
        close: CloseWhen::IfUnused,
    };

    let mut observer = world.client(&daemon).await;
    assert!(
        observer
            .connection
            .hello()
            .features
            .iter()
            .any(|feature| feature == OBSERVE_FEATURE)
    );
    let observed = observer
        .connection
        .send(observe.clone())
        .await
        .expect("observe");
    assert_eq!(observed.state.clients, 1);
    client.prompt(&session_id, "slow 2").await;
    let mut seen = Seen::default();
    observer.until_turn_ends(&mut seen, None).await;
    assert_eq!((seen.started, seen.ended), (1, Some(StopReason::EndTurn)));
    assert!(seen.agent.contains("Chunk 2 of 2"), "{seen:?}");

    // Leaving closes nothing, though it asks to.
    observer
        .connection
        .send(leave.clone())
        .await
        .expect("detach");
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(open());

    // Observing again, it doesn't keep the session open once the client leaves.
    observer
        .connection
        .send(observe.clone())
        .await
        .expect("observe");
    client.connection.send(leave).await.expect("detach");
    wait_for(|| !open()).await;

    // Closed, it isn't opened again for an observer.
    let error = observer
        .connection
        .send(observe)
        .await
        .expect_err("a closed session");
    assert!(errors::is(&error, errors::SESSION_NOT_OPEN), "{error}");
    assert!(!open());
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
async fn continue_finds_no_session_in_another_directory_though_the_agent_lists_it() {
    let world = World::new();
    let daemon = world.daemon_listing_every_directory();
    let mut client = world.client(&daemon).await;
    // A session open in another worktree, which the agent lists here too.
    let worktree = world.cwd().join("worktree");
    std::fs::create_dir(&worktree).expect("another directory");
    client.session_in(&world, &worktree).await;
    assert_eq!(client.list(&world).await, Vec::<SessionId>::new());
    let here = client.session_in(&world, &world.cwd()).await.session_id;
    assert_eq!(client.list(&world).await, [here]);
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
            observe: false,
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

#[tokio::test]
async fn a_watcher_hears_of_sessions_it_isnt_attached_to_from_first_prompt_to_deletion() {
    let world = World::new();
    let daemon = world.daemon(true, Duration::from_secs(60));
    let mut watcher = world.client(&daemon).await;
    assert!(
        watcher
            .connection
            .hello()
            .features
            .iter()
            .any(|feature| feature == WATCH_FEATURE)
    );
    assert_eq!(watcher.watch().await, Vec::new());

    // Blank, it isn't listed, so there's nothing to hear.
    let mut driver = world.client(&daemon).await;
    let session_id = driver.create(&world).await;
    assert!(!watcher.hears_a_change().await);

    // Prompted, it appears, then runs, waits on a person, runs again and goes idle, titled.
    let path = world.cwd().join("watched.txt");
    driver
        .prompt(&session_id, &format!("write {} hello", path.display()))
        .await;
    let (asked_in, pending) = driver.asked(&mut Seen::default()).await;
    driver
        .allow(&asked_in, &pending, "allow")
        .await
        .expect("answer");
    driver.until_turn_ends(&mut Seen::default(), None).await;
    let changes = watcher
        .changes_until(|change| change.state() == Some((SessionStatus::Open, Some(Activity::Idle))))
        .await;
    let mut activities: Vec<Activity> = changes
        .iter()
        .filter_map(|change| change.state().and_then(|(_, activity)| activity))
        .collect();
    activities.dedup();
    assert_eq!(
        activities,
        [
            Activity::Running,
            Activity::Waiting,
            Activity::Running,
            Activity::Idle
        ]
    );
    let Some(Change::Updated(last)) = changes.last() else {
        panic!("no update: {changes:?}");
    };
    assert_eq!(last.info.session_id, session_id);
    assert_eq!(last.info.cwd, world.cwd());
    assert_eq!(last.agent_id, "fake");
    assert_eq!(last.clients, 1);
    assert!(last.info.title.is_some(), "the agent titled it: {last:?}");

    // Closed, opened again by attaching, then deleted.
    driver
        .connection
        .send(CloseSessionRequest {
            session_id: session_id.clone(),
        })
        .await
        .expect("session/close");
    let closed = watcher
        .changes_until(|change| {
            change
                .state()
                .is_some_and(|(state, _)| state == SessionStatus::Closed)
        })
        .await;
    assert_eq!(
        closed.last().and_then(Change::state),
        Some((SessionStatus::Closed, None))
    );
    let mut other = world.client(&daemon).await;
    other.attach(&session_id).await;
    watcher
        .changes_until(|change| {
            change
                .state()
                .is_some_and(|(state, _)| state == SessionStatus::Open)
        })
        .await;
    driver
        .connection
        .send(DeleteSessionRequest {
            session_id: session_id.clone(),
            agent_id: None,
        })
        .await
        .expect("session/delete");
    let gone = watcher
        .changes_until(|change| matches!(change, Change::Removed(_)))
        .await;
    assert_eq!(gone.last(), Some(&Change::Removed(session_id)));
}

#[tokio::test]
async fn a_watcher_hears_of_sessions_suspended_when_the_host_stops_and_blank_ones_closed() {
    let world = World::new();
    let daemon = world.daemon(true, Duration::from_secs(60));
    let mut driver = world.client(&daemon).await;
    let kept = driver.create(&world).await;
    driver.prompt(&kept, "hello").await;
    driver.until_turn_ends(&mut Seen::default(), None).await;
    let mut watcher = world.client(&daemon).await;
    let listed = watcher.watch().await;
    assert_eq!(
        listed
            .iter()
            .map(|listing| (
                listing.info.session_id.clone(),
                listing.state,
                listing.activity
            ))
            .collect::<Vec<_>>(),
        [(kept.clone(), SessionStatus::Open, Some(Activity::Idle))]
    );

    // One nobody prompted goes, closed, with nothing left of it.
    let blank = driver.create(&world).await;
    driver
        .connection
        .send(CloseSessionRequest {
            session_id: blank.clone(),
        })
        .await
        .expect("session/close");
    assert_eq!(watcher.change().await, Change::Removed(blank));

    daemon.shutdown().await;
    let suspended = watcher
        .changes_until(|change| {
            change
                .state()
                .is_some_and(|(state, _)| state == SessionStatus::Suspended)
        })
        .await;
    let Some(Change::Updated(listing)) = suspended.last() else {
        panic!("no update: {suspended:?}");
    };
    assert_eq!(listing.info.session_id, kept);
    assert_eq!((listing.activity, listing.clients), (None, 0));
}

#[tokio::test]
async fn a_watcher_that_unwatches_hears_no_more() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let mut watcher = world.client(&daemon).await;
    watcher.watch().await;
    watcher
        .connection
        .send(UnwatchSessionsRequest {})
        .await
        .expect("sessions/unwatch");
    let mut driver = world.client(&daemon).await;
    let session_id = driver.create(&world).await;
    driver.prompt(&session_id, "hello").await;
    driver.until_turn_ends(&mut Seen::default(), None).await;
    assert!(!watcher.hears_a_change().await);
}

#[tokio::test]
async fn a_client_lists_directories_on_the_hosts_computer() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let client = world.client(&daemon).await;
    assert!(
        client
            .connection
            .hello()
            .features
            .iter()
            .any(|feature| feature == LIST_FILES_FEATURE)
    );
    let tree = world.cwd().join("tree");
    for dir in ["beta", "Alpha", ".hidden"] {
        std::fs::create_dir_all(tree.join(dir)).expect("directory");
    }
    std::fs::write(tree.join("c.txt"), "c").expect("file");
    std::os::unix::fs::symlink(tree.join("beta"), tree.join("link")).expect("symlink");
    std::os::unix::fs::symlink(tree.join("nowhere"), tree.join("gone")).expect("symlink");
    let list = |path: PathBuf, hidden: bool| {
        client.connection.send(ListFilesRequest {
            path: Some(path),
            hidden,
        })
    };
    let entry = |name: &str, kind: FileKind| FileEntry {
        name: name.to_owned(),
        kind,
    };

    // Directories first, a symlink to one among them, then by name; `..` worked out.
    let listed = list(tree.join("beta/.."), false).await.expect("files/list");
    assert_eq!(listed.path, tree);
    assert_eq!(listed.parent.as_deref(), Some(world.cwd().as_path()));
    assert_eq!(
        listed.entries,
        [
            entry("Alpha", FileKind::Directory),
            entry("beta", FileKind::Directory),
            entry("link", FileKind::Directory),
            entry("c.txt", FileKind::File),
            entry("gone", FileKind::Other),
        ]
    );
    assert!(!listed.truncated);
    let hidden = list(tree.clone(), true).await.expect("files/list");
    assert_eq!(hidden.entries[0], entry(".hidden", FileKind::Directory));

    // Without a path, the home directory.
    let home = client
        .connection
        .send(ListFilesRequest::default())
        .await
        .expect("files/list");
    assert_eq!(home.path, home.home);

    for (path, why) in [
        (
            PathBuf::from("tree"),
            "tree isn't an absolute path".to_owned(),
        ),
        (
            tree.join("missing"),
            format!("{} doesn't exist", tree.join("missing").display()),
        ),
        (
            tree.join("c.txt"),
            format!("{} isn't a directory", tree.join("c.txt").display()),
        ),
    ] {
        let error = list(path, false).await.expect_err("refused");
        assert_eq!(
            error.data.as_ref().and_then(|data| data.as_str()),
            Some(why.as_str())
        );
    }
}

#[tokio::test]
async fn a_tool_call_sent_before_the_session_is_set_up_waits_for_it() {
    let world = World::new();
    let mut config = world.config(
        false,
        Duration::from_secs(60),
        Duration::from_secs(60),
        false,
    );
    config.launcher = fake_agents_tuned(world.dir.path().join("agent-state.json"), |config| {
        config.mcp_over_acp = true;
        config.call_on_new = Some(CLIPBOARD_WRITE.to_owned());
    });
    let daemon = Daemon::new(config);
    let mut client = world.tool_client(&daemon).await;
    client.create(&world).await;
    // The call reached the Host before `session/new` was answered. It waited for the session
    // rather than failing as one for no session, then found no turn to send it to.
    let mut seen = Seen::default();
    while !seen.agent.starts_with("Early ") {
        let event = client.next().await;
        client.note(event, &mut seen, None).await;
    }
    assert_eq!(
        seen.agent,
        "Early clipboard_write: No turn is running, so nobody's device can run it."
    );
}

#[tokio::test]
async fn a_session_opened_again_declares_the_host_mcp_server_anew() {
    let world = World::new();
    let daemon = world.daemon_over_acp();
    let mut client = world.tool_client(&daemon).await;
    let session_id = client.create(&world).await;
    let declared = |seen: &Seen| {
        seen.agent
            .rsplit("MCP servers: ")
            .next()
            .unwrap_or_default()
            .to_owned()
    };
    client.prompt(&session_id, "mcp").await;
    let mut before = Seen::default();
    client.until_turn_ends(&mut before, None).await;
    client
        .connection
        .send(CloseSessionRequest {
            session_id: session_id.clone(),
        })
        .await
        .expect("session/close");

    let mut again = world.tool_client(&daemon).await;
    again.attach(&session_id).await;
    again.prompt(&session_id, "mcp").await;
    let mut after = Seen::default();
    while !after.agent.contains("MCP servers: ") || after.ended.is_none() {
        let event = again.next().await;
        again.note(event, &mut after, None).await;
    }
    assert!(declared(&before).starts_with("weave (acp "), "{before:?}");
    assert!(declared(&after).starts_with("weave (acp "), "{after:?}");
    assert_ne!(declared(&before), declared(&after));

    // The new declaration is the one that works.
    again.prompt(&session_id, COPY).await;
    let mut seen = Seen::default();
    let (_, call) = again.tool_call(&mut seen).await;
    again
        .run_tool(&session_id, &call, ClientToolResult::text("Copied."))
        .await
        .expect("the target answers");
    again.until_turn_ends(&mut seen, None).await;
    assert!(
        seen.agent.contains("clipboard_write answered: Copied."),
        "{seen:?}"
    );
}

fn rename(session_id: &SessionId, title: &str) -> RenameSessionRequest {
    RenameSessionRequest {
        session_id: session_id.clone(),
        title: title.to_owned(),
    }
}

#[tokio::test]
async fn a_session_renamed_through_the_host_keeps_its_title() {
    let world = World::new();
    let daemon = world.daemon(true, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    let mut watcher = world.client(&daemon).await;
    watcher.watch().await;
    let session_id = client.create(&world).await;

    for (title, why) in [
        ("   ".to_owned(), "a title can't be empty"),
        ("x".repeat(201), "a title is at most 200 characters"),
    ] {
        let error = client
            .connection
            .send(rename(&session_id, &title))
            .await
            .expect_err("refused");
        assert_eq!(
            error.data.as_ref().and_then(|data| data.as_str()),
            Some(why)
        );
    }
    client
        .connection
        .send(rename(&session_id, "  Parser fixes "))
        .await
        .expect("session/rename");

    // The agent titles a session after its first prompt; that doesn't replace the rename.
    client.prompt(&session_id, "hello").await;
    let mut seen = Seen::default();
    client.until_turn_ends(&mut seen, None).await;
    assert_eq!(
        seen.renamed,
        [(
            "Parser fixes".to_owned(),
            Some(TurnOrigin::Client {
                name: "test".to_owned(),
                id: client.connection.client_id().clone(),
                device: None,
            })
        )]
    );
    let changes = watcher
        .changes_until(|change| change.state() == Some((SessionStatus::Open, Some(Activity::Idle))))
        .await;
    for change in &changes {
        let Change::Updated(listing) = change else {
            panic!("{changes:?}");
        };
        assert_eq!(listing.info.title.as_deref(), Some("Parser fixes"));
    }
    let titles = |listings: Vec<SessionListing>| {
        listings
            .into_iter()
            .map(|listing| listing.info.title)
            .collect::<Vec<_>>()
    };
    let host = client
        .connection
        .send(ListSessionsRequest::default())
        .await
        .expect("sessions/list");
    assert_eq!(titles(host.sessions), [Some("Parser fixes".to_owned())]);
    assert_eq!(
        titles(client.listing(&world).await),
        [Some("Parser fixes".to_owned())]
    );

    // A Host that stopped and started again keeps it.
    daemon.shutdown().await;
    let daemon = world.daemon(true, Duration::from_secs(60));
    let mut later = world.client(&daemon).await;
    let resumed = later.attach(&session_id).await;
    assert_eq!(resumed.state.title.as_deref(), Some("Parser fixes"));

    // So does a session closed and opened again, in a new journal.
    later
        .connection
        .send(CloseSessionRequest {
            session_id: session_id.clone(),
        })
        .await
        .expect("session/close");
    let error = later
        .connection
        .send(rename(&session_id, "Closed"))
        .await
        .expect_err("refused");
    assert!(errors::is(&error, errors::SESSION_NOT_OPEN), "{error}");
    let mut again = world.client(&daemon).await;
    let reopened = again.attach(&session_id).await;
    assert!(reopened.replay.reset);
    assert_eq!(reopened.state.title.as_deref(), Some("Parser fixes"));
}

#[tokio::test]
async fn an_agent_renames_its_own_session_with_a_host_tool_even_headless() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    let run = client
        .connection
        .send(RunRequest {
            agent_id: "fake".to_owned(),
            cwd: world.cwd(),
            remote: None,
            session_id: None,
            additional_directories: Vec::new(),
            prompt: vec![ContentBlock::from(
                r#"tool rename_session {"title": "Named by its agent"}"#.to_owned(),
            )],
            policy: PermissionPolicy {
                approve: Vec::new(),
                otherwise: Unapproved::Reject,
            },
            attach: true,
            trace: false,
            key: None,
            caller: None,
        })
        .await
        .expect("session/run");
    let mut seen = Seen::default();
    client.until_turn_ends(&mut seen, None).await;
    assert_eq!(seen.renamed, [("Named by its agent".to_owned(), None)]);
    assert!(
        seen.agent
            .contains("rename_session answered: Renamed this thread to “Named by its agent”."),
        "{seen:?}"
    );
    assert_eq!(
        run.state.map(|state| state.session_id),
        Some(run.session_id.clone())
    );

    // An empty title is the agent's mistake, told it as a tool error.
    let session_id = run.session_id;
    client
        .prompt(&session_id, r#"tool rename_session {"title": " "}"#)
        .await;
    let mut seen = Seen::default();
    client.until_turn_ends(&mut seen, None).await;
    assert!(
        seen.agent
            .contains("rename_session failed: Not renamed: a title can't be empty."),
        "{seen:?}"
    );

    // Configured off, it isn't offered.
    let config = world.dir.path().join("config.toml");
    let text = std::fs::read_to_string(&config).expect("config");
    std::fs::write(&config, format!("host_tools = []\n{text}")).expect("config");
    let other = client.create(&world).await;
    client
        .prompt(&other, r#"tool rename_session {"title": "Not offered"}"#)
        .await;
    let mut seen = Seen::default();
    client.until_turn_ends(&mut seen, None).await;
    assert!(
        seen.agent.starts_with("rename_session couldn't be called")
            && seen.agent.contains("unknown tool: rename_session"),
        "{seen:?}"
    );
    assert!(seen.renamed.is_empty());
}

fn path_text(path: &Path) -> &str {
    path.to_str().expect("a UTF-8 path")
}

#[tokio::test]
async fn a_session_in_a_worktree_says_its_repository_and_branch_and_lists_by_repository() {
    let world = World::new();
    let repo = world.repository();
    git(
        &repo,
        &[
            "remote",
            "add",
            "origin",
            "https://someone:secret@github.com/jacobfvanzyl/weave.git",
        ],
    );
    let worktree = repo.with_file_name("weave.feature-auth");
    git(
        &repo,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "feature/auth",
            path_text(&worktree),
        ],
    );
    std::fs::create_dir(worktree.join("src")).expect("a subdirectory");
    let expected = GitLocation {
        repo: repo.clone(),
        worktree: worktree.clone(),
        branch: Some("feature/auth".to_owned()),
        // Without the credentials in its URL.
        remote: Some("github.com/jacobfvanzyl/weave".to_owned()),
    };
    let session_id = {
        let daemon = world.daemon(true, Duration::from_secs(60));
        let mut client = world.client(&daemon).await;
        let state = client.session_in(&world, &worktree.join("src")).await;
        assert_eq!(state.git.as_ref(), Some(&expected));
        let elsewhere = client.session_in(&world, &world.cwd()).await;
        assert_eq!(elsewhere.git, None);

        // Any directory in the repository names it, another worktree included.
        let listed = client.in_repository(&worktree).await;
        assert_eq!(
            listed
                .iter()
                .map(|listing| (&listing.info.session_id, listing.git.as_ref()))
                .collect::<Vec<_>>(),
            [(&state.session_id, Some(&expected))]
        );
        // Only the Host's own listing goes by repository.
        let refused = client
            .connection
            .send(ListSessionsRequest {
                agent_id: Some("fake".to_owned()),
                repo: Some(repo.clone()),
                ..ListSessionsRequest::default()
            })
            .await;
        assert!(refused.is_err(), "{refused:?}");
        let outside = client
            .connection
            .send(ListSessionsRequest {
                repo: Some(world.cwd()),
                ..ListSessionsRequest::default()
            })
            .await;
        assert!(
            outside
                .as_ref()
                .is_err_and(|error| errors::is(error, errors::NOT_A_REPOSITORY)),
            "{outside:?}"
        );
        daemon.shutdown().await;
        state.session_id
    };

    // A later Host has it from the journal.
    let daemon = world.daemon(true, Duration::from_secs(60));
    let client = world.client(&daemon).await;
    let listed = client.in_repository(&repo).await;
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].info.session_id, session_id);
    assert_eq!(listed[0].git.as_ref(), Some(&expected));
}

#[tokio::test]
async fn a_session_says_the_branch_its_worktree_switched_to_once_a_turn_ends() {
    let world = World::new();
    let repo = world.repository();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    let state = client.session_in(&world, &repo).await;
    assert_eq!(
        state.git.as_ref().and_then(|git| git.branch.as_deref()),
        Some("main")
    );

    git(&repo, &["switch", "-q", "-c", "feature/next"]);
    client.prompt(&state.session_id, "hello again").await;
    // Attached clients hear of it, and listings say it.
    let changed = tokio::time::timeout(WAIT, async {
        loop {
            if let HostEvent::Changed(changed) = client.next().await
                && let Some(git) = changed.git
            {
                return git;
            }
        }
    })
    .await
    .expect("the session's new branch in time");
    assert_eq!(changed.branch.as_deref(), Some("feature/next"));
    let listed = client.in_repository(&repo).await;
    assert_eq!(
        listed[0].git.as_ref().and_then(|git| git.branch.as_deref()),
        Some("feature/next")
    );
}

#[tokio::test]
async fn a_client_makes_a_worktree_beside_the_repository_and_starts_a_session_in_it() {
    let world = World::new();
    let repo = world.repository();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    assert!(
        client
            .connection
            .hello()
            .features
            .iter()
            .any(|feature| feature == WORKTREES_FEATURE)
    );
    let create = |branch: &str, base: Option<&str>| CreateWorktreeRequest {
        repo: repo.clone(),
        branch: branch.to_owned(),
        base: base.map(str::to_owned),
    };

    // Where worktrunk would put it, on a new branch from the default one.
    let created = client
        .connection
        .send(create("feature/auth", None))
        .await
        .expect("worktrees/create");
    let worktree = repo.with_file_name("weave.feature-auth");
    assert_eq!(
        created,
        CreateWorktreeResponse {
            path: worktree.clone(),
            branch: "feature/auth".to_owned(),
            created_branch: true,
        }
    );
    assert_eq!(
        git(&worktree, &["rev-parse", "--abbrev-ref", "HEAD"]),
        "feature/auth"
    );
    let state = client.session_in(&world, &created.path).await;
    assert_eq!(
        state.git,
        Some(GitLocation {
            repo: repo.clone(),
            worktree: worktree.clone(),
            branch: Some("feature/auth".to_owned()),
            remote: None,
        })
    );

    // A branch that exists is checked out rather than made, and takes no base.
    git(&repo, &["branch", "existing"]);
    let refused = client
        .connection
        .send(create("existing", Some("main")))
        .await;
    assert!(refused.is_err(), "{refused:?}");
    let existing = client
        .connection
        .send(create("existing", None))
        .await
        .expect("a worktree for a branch that exists");
    assert!(!existing.created_branch);
    assert_eq!(existing.path, repo.with_file_name("weave.existing"));

    // A branch another worktree has, a name that isn't a branch's, and a directory outside
    // any repository are refused.
    for (request, code) in [
        (create("feature/auth", None), None),
        (create("bad..name", None), None),
        (create("-f", None), None),
        (
            CreateWorktreeRequest {
                repo: world.cwd(),
                ..create("elsewhere", None)
            },
            Some(errors::NOT_A_REPOSITORY),
        ),
    ] {
        let refused = client.connection.send(request).await;
        assert!(
            refused
                .as_ref()
                .is_err_and(|error| code.is_none_or(|code| errors::is(error, code))),
            "{refused:?}"
        );
    }
}

#[tokio::test]
async fn worktrees_list_with_their_status_and_the_sessions_in_each() {
    let world = World::new();
    let repo = world.repository();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    let worktree = client
        .connection
        .send(CreateWorktreeRequest {
            repo: repo.clone(),
            branch: "feature/auth".to_owned(),
            base: None,
        })
        .await
        .expect("worktrees/create")
        .path;
    let in_primary = client.session_in(&world, &repo).await.session_id;
    let in_worktree = client.session_in(&world, &worktree).await.session_id;
    // A commit only it has, and a file git doesn't track yet.
    std::fs::write(worktree.join("auth.rs"), "fn login() {}\n").expect("a file");
    git(&worktree, &["add", "auth.rs"]);
    git(&worktree, &["commit", "-q", "-m", "Log in"]);
    std::fs::write(worktree.join("notes.md"), "todo\n").expect("a file");

    let listed = client
        .connection
        .send(ListWorktreesRequest {
            repo: worktree.clone(),
        })
        .await
        .expect("worktrees/list");
    assert_eq!(listed.repo, repo);
    assert_eq!(listed.default_branch.as_deref(), Some("main"));
    let head = |dir: &Path| Some(git(dir, &["rev-parse", "HEAD"]));
    assert_eq!(
        listed.worktrees,
        vec![
            Worktree {
                path: repo.clone(),
                branch: Some("main".to_owned()),
                head: head(&repo),
                primary: true,
                changes: false,
                divergence: Some(Divergence::default()),
                upstream: None,
                sessions: vec![in_primary],
            },
            Worktree {
                path: worktree.clone(),
                branch: Some("feature/auth".to_owned()),
                head: head(&worktree),
                primary: false,
                changes: true,
                divergence: Some(Divergence {
                    ahead: 1,
                    behind: 0,
                }),
                upstream: None,
                sessions: vec![in_worktree],
            },
        ]
    );
}

#[tokio::test]
async fn removing_a_worktree_waits_for_its_sessions_and_keeps_what_isnt_merged() {
    let world = World::new();
    let repo = world.repository();
    let daemon = world.daemon(true, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    let create = |branch: &str| CreateWorktreeRequest {
        repo: repo.clone(),
        branch: branch.to_owned(),
        base: None,
    };
    let remove = |path: &Path, force: bool| RemoveWorktreeRequest {
        path: path.to_path_buf(),
        force,
        delete_branch: false,
    };
    let worktree = client
        .connection
        .send(create("merged"))
        .await
        .expect("worktrees/create")
        .path;
    let session_id = client.session_in(&world, &worktree).await.session_id;

    // Neither removing nor releasing it goes ahead while a request in its session waits.
    let target = worktree.join("out.txt");
    client
        .prompt(&session_id, &format!("write {} hello", target.display()))
        .await;
    let (_, asked) = client.asked(&mut Seen::default()).await;
    let busy = client.connection.send(remove(&worktree, true)).await;
    assert!(
        busy.as_ref()
            .is_err_and(|error| errors::is(error, errors::WORKTREE_BUSY)),
        "{busy:?}"
    );
    let busy = client
        .connection
        .send(ReleaseWorktreeRequest {
            path: worktree.clone(),
        })
        .await;
    assert!(
        busy.as_ref()
            .is_err_and(|error| errors::is(error, errors::WORKTREE_BUSY)),
        "{busy:?}"
    );
    client
        .allow(&session_id, &asked, "allow")
        .await
        .expect("answered");
    client.until_turn_ends(&mut Seen::default(), None).await;

    // What the turn wrote isn't committed, so it goes only by force, leaving the session open.
    let changed = client.connection.send(remove(&worktree, false)).await;
    assert!(
        changed
            .as_ref()
            .is_err_and(|error| errors::is(error, errors::UNCOMMITTED_CHANGES)),
        "{changed:?}"
    );
    assert_eq!(
        client.in_repository(&repo).await[0].state,
        SessionStatus::Open
    );
    let removed = client
        .connection
        .send(remove(&worktree, true))
        .await
        .expect("worktrees/remove");
    assert_eq!(
        removed,
        RemoveWorktreeResponse {
            closed: vec![session_id.clone()],
            branch: Some("merged".to_owned()),
            // Its branch adds nothing to main, so it goes too.
            branch_deleted: true,
        }
    );
    assert!(!worktree.exists());
    assert_eq!(git(&repo, &["branch", "--list", "merged"]), "");
    // The session is closed, not forgotten.
    assert_eq!(
        client.in_repository(&repo).await[0].state,
        SessionStatus::Closed
    );
    assert!(world.has_journal(&session_id));

    // A branch with commits main doesn't have stays.
    let unmerged = client
        .connection
        .send(create("unmerged"))
        .await
        .expect("worktrees/create")
        .path;
    std::fs::write(unmerged.join("idea.md"), "maybe\n").expect("a file");
    git(&unmerged, &["add", "idea.md"]);
    git(&unmerged, &["commit", "-q", "-m", "An idea"]);
    let idle = client.session_in(&world, &unmerged).await.session_id;
    let released = client
        .connection
        .send(ReleaseWorktreeRequest {
            path: unmerged.clone(),
        })
        .await
        .expect("worktrees/release");
    assert_eq!(released.closed, vec![idle]);
    let removed = client
        .connection
        .send(remove(&unmerged, false))
        .await
        .expect("worktrees/remove");
    assert!(removed.closed.is_empty());
    assert!(!removed.branch_deleted);
    assert_eq!(git(&repo, &["branch", "--list", "unmerged"]), "unmerged");

    // The primary worktree stays.
    let primary = client.connection.send(remove(&repo, true)).await;
    assert!(primary.is_err(), "{primary:?}");
    assert!(repo.join("README.md").exists());
}

/// A client's own origin, as the Host gives it in its events.
fn own_origin(client: &TestClient) -> TurnOrigin {
    TurnOrigin::Client {
        name: "test".to_owned(),
        id: client.connection.client_id().to_owned(),
        device: None,
    }
}

impl TestClient {
    /// Events until `count` turns have ended.
    async fn until_turns_end(&mut self, seen: &mut Seen, count: usize) {
        for _ in 0..count {
            self.until_turn_ends(seen, None).await;
        }
    }

    /// Events until the queue pauses.
    async fn until_paused(&mut self, seen: &mut Seen) {
        while seen.paused.is_empty() {
            let event = self.next().await;
            self.note(event, seen, None).await;
        }
    }
}

#[tokio::test]
async fn a_prompt_queued_during_a_turn_starts_the_next_one_with_its_own_origin() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let mut first = world.client(&daemon).await;
    assert!(
        first
            .connection
            .hello()
            .features
            .iter()
            .any(|f| f == QUEUE_FEATURE)
    );
    let session_id = first.create(&world).await;
    let second = world.client(&daemon).await;

    // Adding to an idle session starts a turn at once.
    let started = first.queue(&session_id, "slow 3").await;
    assert!(started.started);
    // Added while that turn runs, by another client that isn't attached, it waits.
    let queued = second.queue(&session_id, "and then this").await;
    assert!(!queued.started);
    assert!(queued.seq > started.seq);

    let mut seen = Seen::default();
    first.until_turns_end(&mut seen, 2).await;
    assert_eq!(seen.queued, std::slice::from_ref(&queued.queued_id));
    assert_eq!(
        seen.origins,
        [
            (own_origin(&first), Some(started.queued_id)),
            (own_origin(&second), Some(queued.queued_id)),
        ]
    );
    assert!(seen.agent.ends_with("You said: and then this"), "{seen:?}");
    let attached = first.attach(&session_id).await;
    assert!(attached.state.queue.is_empty());
}

#[tokio::test]
async fn attached_clients_share_one_queue_and_removing_a_prompt_removes_it_for_both() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let mut first = world.client(&daemon).await;
    let session_id = first.create(&world).await;
    first.queue(&session_id, "slow 4").await;
    let kept = first.queue(&session_id, "kept").await;
    let mut second = world.client(&daemon).await;
    let attached = second.attach(&session_id).await;
    let ids: Vec<&str> = attached.state.queue.iter().map(|q| q.id.as_str()).collect();
    assert_eq!(
        ids,
        [kept.queued_id.as_str()],
        "a later client sees the queue"
    );
    assert_eq!(attached.state.queue[0].origin, own_origin(&first));

    let dropped = second.queue(&session_id, "dropped").await;
    let removed = first
        .connection
        .send(RemoveQueuedRequest {
            session_id: session_id.clone(),
            queued_id: dropped.queued_id.clone(),
        })
        .await
        .expect("queue/remove")
        .removed
        .expect("it was waiting");
    assert_eq!(removed.id, dropped.queued_id);
    // Removing it again finds it gone.
    let again = second
        .connection
        .send(RemoveQueuedRequest {
            session_id: session_id.clone(),
            queued_id: dropped.queued_id.clone(),
        })
        .await
        .expect("queue/remove");
    assert_eq!(again.removed, None);

    let mut seen = Seen::default();
    second.until_turns_end(&mut seen, 2).await;
    assert_eq!(seen.unqueued, std::slice::from_ref(&dropped.queued_id));
    assert_eq!(seen.started, 2, "{seen:?}");
    assert!(seen.agent.ends_with("You said: kept"), "{seen:?}");
    assert!(!seen.user.contains("dropped"));
    let mut seen = Seen::default();
    first.until_turns_end(&mut seen, 2).await;
    assert_eq!(seen.unqueued, [dropped.queued_id]);
}

#[tokio::test]
async fn cancelling_a_turn_pauses_the_queue_until_a_client_resumes_it() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    let session_id = client.create(&world).await;
    client.queue(&session_id, "slow 20").await;
    let waiting = client.queue(&session_id, "after the cancel").await;
    client
        .connection
        .send(CancelTurnRequest {
            session_id: session_id.clone(),
        })
        .await
        .expect("turn/cancel");
    let mut seen = Seen::default();
    client.until_turn_ends(&mut seen, None).await;
    client.until_paused(&mut seen).await;
    assert_eq!(seen.ended, Some(StopReason::Cancelled));
    assert_eq!(seen.paused, [QueuePause::Cancelled]);
    let attached = world.client(&daemon).await.attach(&session_id).await;
    assert_eq!(attached.state.queue_paused, Some(QueuePause::Cancelled));
    assert_eq!(attached.state.queue.len(), 1);
    assert_eq!(attached.state.activity, Activity::Idle, "nothing started");

    client
        .connection
        .send(ResumeQueueRequest {
            session_id: session_id.clone(),
        })
        .await
        .expect("queue/resume");
    let mut seen = Seen::default();
    client.until_turn_ends(&mut seen, None).await;
    assert_eq!(seen.resumed, 1);
    assert_eq!(
        seen.origins[0].1.as_deref(),
        Some(waiting.queued_id.as_str())
    );

    // Adding to a paused queue resumes it, oldest first; so does prompting the session.
    client.queue(&session_id, "slow 20").await;
    let older = client.queue(&session_id, "older").await;
    client
        .connection
        .send(CancelTurnRequest {
            session_id: session_id.clone(),
        })
        .await
        .expect("turn/cancel");
    let mut seen = Seen::default();
    client.until_turn_ends(&mut seen, None).await;
    client.until_paused(&mut seen).await;
    let newer = client.queue(&session_id, "newer").await;
    assert!(!newer.started);
    client.until_turns_end(&mut seen, 2).await;
    let from_queue: Vec<Option<String>> = seen.origins.iter().map(|o| o.1.clone()).collect();
    assert_eq!(
        from_queue[1..],
        [Some(older.queued_id), Some(newer.queued_id)]
    );
    assert_eq!(seen.resumed, 1);
}

#[tokio::test]
async fn a_queue_outlasts_a_host_restart_paused_for_a_person_or_running_headless() {
    let world = World::new();
    let (interactive, headless) = {
        let daemon = world.daemon(true, Duration::from_secs(60));
        let mut client = world.client(&daemon).await;
        let interactive = client.create(&world).await;
        client.queue(&interactive, "slow 50").await;
        let waiting = client.queue(&interactive, "still here").await;
        let run = client
            .connection
            .send(RunRequest {
                prompt: vec![ContentBlock::from("slow 50".to_owned())],
                attach: true,
                ..run_request(&world, &world.cwd().join("unused"), Vec::new())
            })
            .await
            .expect("session/run");
        let headless = run.session_id;
        client.queue(&headless, "headless next").await;
        daemon.shutdown().await;
        (interactive, (headless, waiting.queued_id))
    };
    let (headless, waiting) = headless;

    let daemon = world.daemon(true, Duration::from_secs(60));
    daemon.resume_queues().await;
    let mut client = world.client(&daemon).await;
    // The headless session's queue ran without anyone.
    let mut watcher = world.client(&daemon).await;
    watcher.attach(&headless).await;
    let mut seen = Seen::default();
    watcher.until_turn_ends(&mut seen, None).await;
    while !seen.agent.contains("You said: headless next") {
        watcher.until_turn_ends(&mut seen, None).await;
    }

    // The interactive one's waits for a person, its interrupted turn ended.
    let attached = client.attach(&interactive).await;
    assert_eq!(attached.state.queue_paused, Some(QueuePause::Interrupted));
    let ids: Vec<&str> = attached.state.queue.iter().map(|q| q.id.as_str()).collect();
    assert_eq!(ids, [waiting.as_str()]);
    assert!(attached.state.turns.is_empty());
    client
        .connection
        .send(ResumeQueueRequest {
            session_id: interactive.clone(),
        })
        .await
        .expect("queue/resume");
    let mut seen = Seen::default();
    while !seen.agent.contains("You said: still here") {
        client.until_turn_ends(&mut seen, None).await;
    }
}

#[tokio::test]
async fn a_closed_sessions_queue_carries_on_into_its_new_journal() {
    let world = World::new();
    let daemon = world.daemon(true, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    let session_id = client.create(&world).await;
    client.queue(&session_id, "slow 50").await;
    let waiting = client.queue(&session_id, "carried").await;
    client
        .connection
        .send(CloseSessionRequest {
            session_id: session_id.clone(),
        })
        .await
        .expect("session/close");
    let attached = client.attach(&session_id).await;
    assert!(attached.replay.reset, "a new journal");
    assert_eq!(attached.state.queue_paused, Some(QueuePause::Interrupted));
    let ids: Vec<&str> = attached.state.queue.iter().map(|q| q.id.as_str()).collect();
    assert_eq!(ids, [waiting.queued_id.as_str()]);
}

#[tokio::test]
async fn a_repeated_keyed_request_answers_as_the_first_and_starts_nothing_even_after_a_restart() {
    let world = World::new();
    let (session_id, first_turn, first_queued, first_run) = {
        let daemon = world.daemon(true, Duration::from_secs(60));
        let mut client = world.client(&daemon).await;
        assert!(
            client
                .connection
                .hello()
                .features
                .iter()
                .any(|f| f == REQUEST_KEYS_FEATURE)
        );
        let session_id = client.create(&world).await;
        let turn = StartTurnRequest {
            session_id: session_id.clone(),
            prompt: vec![ContentBlock::from("slow 3".to_owned())],
            key: Some("turn-1".to_owned()),
        };
        let first = client
            .connection
            .send(turn.clone())
            .await
            .expect("turn/start");
        // Sent again while that turn runs, it isn't refused as one: it's the same request.
        let again = client.connection.send(turn.clone()).await.expect("repeat");
        assert_eq!(again, first);
        let queued = client
            .queue_keyed(&session_id, "queued once", Some("queue-1"))
            .await
            .expect("queue/add");
        let repeat = client
            .queue_keyed(&session_id, "queued once", Some("queue-1"))
            .await
            .expect("repeat");
        assert_eq!(repeat, queued);
        // The same key for another request is refused.
        let reused = client
            .queue_keyed(&session_id, "something else", Some("queue-1"))
            .await
            .expect_err("another request");
        assert!(errors::is(&reused, errors::KEY_REUSED));
        let mut seen = Seen::default();
        client.until_turns_end(&mut seen, 2).await;
        assert_eq!(seen.started, 2, "{seen:?}");

        let run = RunRequest {
            key: Some("run-1".to_owned()),
            ..run_request(&world, &world.cwd().join("unused"), Vec::new())
        };
        let ran = client
            .connection
            .send(run.clone())
            .await
            .expect("session/run");
        let rerun = client.connection.send(run).await.expect("repeat");
        assert_eq!(rerun.session_id, ran.session_id);
        // A repeat names the turn the first started, so its caller can follow it.
        assert!(first.turn_id.is_some() && ran.turn_id.is_some());
        assert_eq!(rerun.turn_id, ran.turn_id);
        daemon.shutdown().await;
        (session_id, first, queued, ran.session_id)
    };

    let daemon = world.daemon(true, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    client.attach_caught_up(&session_id).await;
    let again = client
        .connection
        .send(StartTurnRequest {
            session_id: session_id.clone(),
            prompt: vec![ContentBlock::from("slow 3".to_owned())],
            key: Some("turn-1".to_owned()),
        })
        .await
        .expect("repeat after a restart");
    assert_eq!(again, first_turn);
    let queued = client
        .queue_keyed(&session_id, "queued once", Some("queue-1"))
        .await
        .expect("repeat after a restart");
    assert_eq!(queued, first_queued);
    let rerun = client
        .connection
        .send(RunRequest {
            key: Some("run-1".to_owned()),
            ..run_request(&world, &world.cwd().join("unused"), Vec::new())
        })
        .await
        .expect("repeat after a restart");
    assert_eq!(rerun.session_id, first_run);
    // Nothing started: the session is idle, and its journal has the two turns it had.
    let listing = client
        .connection
        .send(ListSessionsRequest::default())
        .await
        .expect("list");
    let session = listing
        .sessions
        .iter()
        .find(|listing| listing.info.session_id == session_id)
        .expect("listed");
    assert_eq!(session.activity, Some(Activity::Idle));
    assert!(
        !client.hears_a_turn_start().await,
        "a repeat started a turn"
    );
}

#[tokio::test]
async fn a_turn_goes_by_its_prompts_id_and_reads_as_queued_running_or_how_it_ended() {
    let world = World::new();
    let daemon = world.daemon(true, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    assert!(
        client
            .connection
            .hello()
            .features
            .iter()
            .any(|f| f == TURN_IDS_FEATURE)
    );
    let session_id = client.create(&world).await;
    let first = client.queue(&session_id, "slow 3").await;
    let second = client.queue(&session_id, "and then this").await;
    let read = async |client: &TestClient, turn_id: &str| {
        client
            .connection
            .send(GetSessionRequest {
                session_id: session_id.clone(),
                turn_id: Some(turn_id.to_owned()),
            })
            .await
            .map(|got| got.latest_turn.expect("the turn"))
    };
    let running = read(&client, &first.queued_id).await.expect("running");
    assert_eq!(running.state, TurnState::Running);
    assert_eq!(running.turn_id.as_ref(), Some(&first.queued_id));
    let queued = read(&client, &second.queued_id).await.expect("queued");
    assert_eq!(queued.state, TurnState::Queued);
    assert!(!queued.running);
    // A running turn is named in the session's state, and only open sessions running one list
    // as running.
    let attached = client.attach(&session_id).await;
    assert_eq!(
        attached
            .state
            .turns
            .first()
            .and_then(|turn| turn.turn_id.as_ref()),
        Some(&first.queued_id)
    );
    let doing = async |client: &TestClient, activity| {
        client
            .connection
            .send(ListSessionsRequest {
                activity: Some(activity),
                ..ListSessionsRequest::default()
            })
            .await
            .expect("sessions/list")
            .sessions
            .into_iter()
            .map(|listing| listing.info.session_id)
            .collect::<Vec<_>>()
    };
    assert_eq!(
        doing(&client, Activity::Running).await,
        std::slice::from_ref(&session_id)
    );
    assert!(doing(&client, Activity::Idle).await.is_empty());
    let refused = client
        .connection
        .send(ListSessionsRequest {
            agent_id: Some("fake".to_owned()),
            activity: Some(Activity::Idle),
            ..ListSessionsRequest::default()
        })
        .await
        .expect_err("an activity with an agent");
    assert_eq!(refused.code, Error::invalid_params().code);

    let mut seen = Seen::default();
    client.until_turns_end(&mut seen, 2).await;
    // Attaching again replayed the first turn's start.
    seen.turn_ids.dedup();
    assert_eq!(
        seen.turn_ids,
        [
            Some(first.queued_id.clone()),
            Some(second.queued_id.clone())
        ]
    );
    let ended = read(&client, &second.queued_id).await.expect("ended");
    assert_eq!(ended.state, TurnState::Ended);
    assert_eq!(ended.message.as_deref(), Some("You said: and then this"));
    assert_eq!(
        read(&client, &first.queued_id).await.expect("ended").state,
        TurnState::Ended
    );
    assert_eq!(
        doing(&client, Activity::Idle).await,
        std::slice::from_ref(&session_id)
    );

    // turn/start gives its turn an id of the Host's.
    let started = client
        .connection
        .send(StartTurnRequest {
            session_id: session_id.clone(),
            prompt: vec![ContentBlock::from("hello".to_owned())],
            key: None,
        })
        .await
        .expect("turn/start");
    let turn_id = started.turn_id.expect("an id");
    client.until_turn_ends(&mut seen, None).await;
    assert_eq!(seen.turn_ids.last(), Some(&Some(turn_id.clone())));
    assert_eq!(
        client
            .get(&session_id)
            .await
            .latest_turn
            .and_then(|latest| latest.turn_id),
        Some(turn_id)
    );
    let unknown = read(&client, "q-none").await.expect_err("no such turn");
    assert!(errors::is(&unknown, errors::UNKNOWN_TURN));

    // A closed session's turns read from its journal.
    client
        .connection
        .send(CloseSessionRequest {
            session_id: session_id.clone(),
        })
        .await
        .expect("session/close");
    assert_eq!(
        read(&client, &second.queued_id).await.expect("ended").state,
        TurnState::Ended
    );
}

#[tokio::test]
async fn a_turn_asking_a_person_reads_as_waiting() {
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
    client.asked(&mut Seen::default()).await;
    let latest = client.get(&session_id).await.latest_turn.expect("a turn");
    assert_eq!(latest.state, TurnState::Waiting);
    assert!(latest.running);
}

#[tokio::test]
async fn an_agent_lists_the_agents_it_can_hand_work_to() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    let caller = client.create(&world).await;
    let listed = client.call_tool(&caller, "list_agents", "{}").await;
    let answer = tool_answer(&listed.agent, "list_agents");
    let other = answer["agents"]
        .as_array()
        .and_then(|agents| agents.iter().find(|agent| agent["id"] == "other"))
        .unwrap_or_else(|| panic!("other in {answer}"));
    assert_eq!(other["description"], "Another fake agent");
}

#[tokio::test]
async fn a_key_a_stopped_host_never_answered_is_found_in_the_journal() {
    let world = World::new();
    let (session_id, first) = {
        let daemon = world.daemon(true, Duration::from_secs(60));
        let mut client = world.client(&daemon).await;
        let session_id = client.create(&world).await;
        let first = client
            .connection
            .send(StartTurnRequest {
                session_id: session_id.clone(),
                prompt: vec![ContentBlock::from("hello".to_owned())],
                key: Some("lost-answer".to_owned()),
            })
            .await
            .expect("turn/start");
        client.until_turn_ends(&mut Seen::default(), None).await;
        daemon.shutdown().await;
        (session_id, first)
    };
    // As if the Host stopped after the turn started but before it recorded the answer.
    let record = world.dir.path().join("admissions.jsonl");
    let lines = std::fs::read_to_string(&record).expect("the record");
    let admitted: Vec<&str> = lines
        .lines()
        .filter(|line| !line.contains("\"answered\""))
        .collect();
    std::fs::write(&record, admitted.join("\n") + "\n").expect("the record");

    let daemon = world.daemon(true, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    client.attach_caught_up(&session_id).await;
    let again = client
        .connection
        .send(StartTurnRequest {
            session_id: session_id.clone(),
            prompt: vec![ContentBlock::from("hello".to_owned())],
            key: Some("lost-answer".to_owned()),
        })
        .await
        .expect("repeat");
    assert_eq!(again, first);
    assert!(!client.hears_a_turn_start().await);
}

impl TestClient {
    /// Attach to `session_id` and read its replay through, so what comes next is new.
    async fn attach_caught_up(&mut self, session_id: &SessionId) {
        let head = self.attach(session_id).await.state.journal.head;
        if head == 0 {
            return;
        }
        loop {
            if let HostEvent::Event(event) = self.next().await
                && event.seq >= head
            {
                return;
            }
        }
    }

    /// Whether a turn starts in an attached session within a moment.
    async fn hears_a_turn_start(&mut self) -> bool {
        tokio::time::timeout(Duration::from_millis(400), async {
            loop {
                if let HostEvent::Event(event) = self.next().await
                    && matches!(event.event, SessionEvent::TurnStarted { .. })
                {
                    return;
                }
            }
        })
        .await
        .is_ok()
    }
}

/// What a tool answered in an agent's text (`<tool> answered: <JSON>`), as JSON.
fn tool_answer(agent: &str, tool: &str) -> serde_json::Value {
    let marker = format!("{tool} answered: ");
    let at = agent
        .rfind(&marker)
        .unwrap_or_else(|| panic!("{tool} answered in {agent:?}"));
    serde_json::Deserializer::from_str(&agent[at + marker.len()..])
        .into_iter::<serde_json::Value>()
        .next()
        .and_then(Result::ok)
        .unwrap_or_else(|| panic!("JSON after {marker:?} in {agent:?}"))
}

/// A session's id in a tool's JSON answer.
fn answered_session(agent: &str, tool: &str) -> SessionId {
    let answer = tool_answer(agent, tool);
    SessionId::new(
        answer["sessionId"]
            .as_str()
            .unwrap_or_else(|| panic!("a sessionId in {answer}"))
            .to_owned(),
    )
}

impl TestClient {
    /// Run `tool` with `arguments` in `session_id`'s agent, through the fake agent's `tool`
    /// script; what this client saw of that turn.
    async fn call_tool(&mut self, session_id: &SessionId, tool: &str, arguments: &str) -> Seen {
        self.prompt(session_id, &format!("tool {tool} {arguments}"))
            .await;
        let mut seen = Seen::default();
        self.until_turn_ends(&mut seen, None).await;
        seen
    }

    /// Events until a message from the Host about another session reaches this one: as a turn
    /// it starts or a steer into its turn. Its text.
    async fn told(&mut self, seen: &mut Seen) -> String {
        loop {
            let said = seen
                .origins
                .iter()
                .any(|(origin, _)| matches!(origin, TurnOrigin::Session { .. }));
            if said
                || seen
                    .steered
                    .iter()
                    .any(|(text, _)| text.starts_with("[weave]"))
            {
                let start = seen.user.find("[weave]");
                let steered = seen
                    .steered
                    .iter()
                    .find(|(text, _)| text.starts_with("[weave]"));
                return match (start, steered) {
                    (Some(at), _) => seen.user[at..].to_owned(),
                    (None, Some((text, _))) => text.clone(),
                    (None, None) => panic!("told nothing: {seen:?}"),
                };
            }
            let event = self.next().await;
            self.note(event, seen, None).await;
        }
    }

    async fn get(&self, session_id: &SessionId) -> GetSessionResponse {
        self.connection
            .send(GetSessionRequest {
                session_id: session_id.clone(),
                turn_id: None,
            })
            .await
            .expect("sessions/get")
    }
}

#[tokio::test]
async fn an_agent_starts_a_session_with_another_agent_and_hears_how_its_turn_ended() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    let caller = client.create(&world).await;
    let mut started = client
        .call_tool(
            &caller,
            "start_session",
            r#"{"agentId": "other", "prompt": "slow 3"}"#,
        )
        .await;
    let said = started.agent.clone();
    let delegated = answered_session(&said, "start_session");
    assert_ne!(delegated, caller);
    // Without a policy asked for, it runs under the caller's.
    assert_eq!(
        tool_answer(&said, "start_session")["policy"],
        serde_json::to_value(PermissionPolicy::ask()).expect("json")
    );

    // It's a session of its own, which says who started it.
    let got = client.get(&delegated).await;
    assert_eq!(got.session.agent_id, "other");
    assert_eq!(got.session.started_by.as_ref(), Some(&caller));
    let latest = got.latest_turn.expect("a turn");
    assert_eq!(
        latest.origin,
        TurnOrigin::Session {
            session_id: caller.clone(),
            report: false,
            host: None,
            host_name: None,
        }
    );
    let listed = client
        .connection
        .send(ListSessionsRequest::default())
        .await
        .expect("sessions/list");
    let listing = listed
        .sessions
        .iter()
        .find(|listing| listing.info.session_id == delegated)
        .expect("listed");
    assert_eq!(listing.started_by.as_ref(), Some(&caller));

    // Its turn's end reaches the caller, from the delegated session, with what its agent said.
    let told = client.told(&mut started).await;
    assert!(told.contains("finished its turn"), "{told}");
    assert!(told.contains("Chunk 3 of 3."), "{told}");
    assert!(told.contains(&delegated.to_string()), "{told}");
    // The message's own turn tells the delegated session nothing back: no turns go to and fro.
    tokio::time::sleep(Duration::from_millis(500)).await;
    let latest = client.get(&delegated).await.latest_turn.expect("a turn");
    assert_eq!(
        latest.prompt,
        vec![ContentBlock::from("slow 3".to_owned())],
        "{latest:?}"
    );

    // Its own journal has its turn, from the caller.
    let mut watcher = world.client(&daemon).await;
    watcher.attach(&delegated).await;
    let mut seen = Seen::default();
    watcher.until_turn_ends(&mut seen, None).await;
    assert_eq!(
        seen.origins.first().map(|(origin, _)| origin.clone()),
        Some(TurnOrigin::Session {
            session_id: caller.clone(),
            report: false,
            host: None,
            host_name: None,
        })
    );
    assert!(seen.agent.contains("Chunk 3 of 3."));
}

#[tokio::test]
async fn a_delegated_session_approves_no_more_than_the_session_that_started_it() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    let caller = client
        .connection
        .send(CreateSessionRequest {
            policy: Some(PermissionPolicy {
                approve: vec![ToolKind::Read],
                otherwise: Unapproved::Ask,
            }),
            ..TestClient::create_request(&world, "fake")
        })
        .await
        .expect("session/create")
        .session_id;
    let said = client
        .call_tool(
            &caller,
            "start_session",
            r#"{"agentId": "other", "prompt": "hello", "approve": ["read", "edit", "execute"], "otherwise": "reject"}"#,
        )
        .await
        .agent;
    let delegated = answered_session(&said, "start_session");
    let narrowed = PermissionPolicy::headless(vec![ToolKind::Read]);
    assert_eq!(
        tool_answer(&said, "start_session")["policy"],
        serde_json::to_value(&narrowed).expect("json")
    );
    let attached = world.client(&daemon).await.attach(&delegated).await;
    assert_eq!(attached.state.policy, narrowed);
    assert_eq!(attached.state.started_by.as_ref(), Some(&caller));
}

#[tokio::test]
async fn an_agent_reads_and_acts_on_any_session_and_hears_how_its_turn_there_ended() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    let caller = client.create(&world).await;
    let mut person = world.client(&daemon).await;
    let persons = person.session_in(&world, &world.cwd()).await.session_id;

    // Reading answers as sessions/get does.
    let said = client
        .call_tool(
            &caller,
            "read_session",
            &format!(r#"{{"sessionId": "{persons}"}}"#),
        )
        .await
        .agent;
    let got = client.get(&persons).await;
    assert_eq!(
        tool_answer(&said, "read_session"),
        serde_json::to_value(&got).expect("json")
    );
    assert_eq!(
        got.latest_turn.and_then(|turn| turn.message).as_deref(),
        Some("You said: hello")
    );
    let said = client
        .call_tool(&caller, "list_sessions", r#"{}"#)
        .await
        .agent;
    let listed = tool_answer(&said, "list_sessions");
    assert!(
        listed["sessions"]
            .as_array()
            .is_some_and(|sessions| sessions
                .iter()
                .any(|session| session["info"]["sessionId"] == persons.to_string())),
        "{listed}"
    );

    // It steers and cancels a turn the person began in a thread it didn't start.
    person.prompt(&persons, "slow 30").await;
    let said = client
        .call_tool(
            &caller,
            "steer_session",
            &format!(r#"{{"sessionId": "{persons}", "prompt": "and the docs"}}"#),
        )
        .await
        .agent;
    assert!(said.contains("steer_session answered:"), "{said}");
    let said = client
        .call_tool(
            &caller,
            "cancel_session_turn",
            &format!(r#"{{"sessionId": "{persons}"}}"#),
        )
        .await
        .agent;
    assert!(said.contains("cancel_session_turn answered: {}"), "{said}");
    let mut seen = Seen::default();
    person.until_turn_ends(&mut seen, None).await;
    assert_eq!(seen.ended, Some(StopReason::Cancelled));

    // It prompts that thread, and hears how the turn it began there ended.
    let mut seen = client
        .call_tool(
            &caller,
            "prompt_session",
            &format!(r#"{{"sessionId": "{persons}", "prompt": "slow 3"}}"#),
        )
        .await;
    assert!(
        seen.agent.contains("prompt_session answered:"),
        "{}",
        seen.agent
    );
    let latest = client.get(&persons).await.latest_turn.expect("a turn");
    assert_eq!(
        latest.origin,
        TurnOrigin::Session {
            session_id: caller.clone(),
            report: false,
            host: None,
            host_name: None,
        }
    );
    let told = client.told(&mut seen).await;
    assert!(told.contains("finished its turn"), "{told}");
    assert!(told.contains("Chunk 3 of 3."), "{told}");

    // The report's turn tells the person's thread nothing back: no turns go to and fro.
    tokio::time::sleep(Duration::from_millis(500)).await;
    let latest = client.get(&persons).await.latest_turn.expect("a turn");
    assert_eq!(
        latest.prompt,
        vec![ContentBlock::from("slow 3".to_owned())],
        "{latest:?}"
    );
    let reported = client.get(&caller).await.latest_turn.expect("a turn");
    assert_eq!(
        reported.origin,
        TurnOrigin::Session {
            session_id: persons.clone(),
            report: true,
            host: None,
            host_name: None,
        }
    );
}

#[tokio::test]
async fn delegation_stops_at_its_depth_and_its_running_limit() {
    let world = World::new();
    let config = world.dir.path().join("config.toml");
    let text = std::fs::read_to_string(&config).expect("config");
    std::fs::write(&config, format!("[delegation]\nrunning = 1\n\n{text}")).expect("config");
    let daemon = world.daemon(false, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    let caller = client.create(&world).await;
    let mut seen = client
        .call_tool(
            &caller,
            "start_session",
            r#"{"agentId": "other", "prompt": "hello"}"#,
        )
        .await;
    let delegated = answered_session(&seen.agent, "start_session");
    client.told(&mut seen).await;

    // The delegated session can't start one of its own.
    let mut other = world.client(&daemon).await;
    other.attach_caught_up(&delegated).await;
    let said = other
        .call_tool(
            &delegated,
            "start_session",
            r#"{"agentId": "fake", "prompt": "hello"}"#,
        )
        .await
        .agent;
    assert!(
        said.contains("start_session failed:") && said.contains("can't start threads"),
        "{said}"
    );

    // With it running, one is as many as this Host allows.
    let said = client
        .call_tool(
            &caller,
            "prompt_session",
            &format!(r#"{{"sessionId": "{delegated}", "prompt": "slow 30"}}"#),
        )
        .await
        .agent;
    assert!(said.contains("prompt_session answered:"), "{said}");
    let said = client
        .call_tool(
            &caller,
            "start_session",
            r#"{"agentId": "other", "prompt": "hello"}"#,
        )
        .await
        .agent;
    assert!(
        said.contains("start_session failed:") && said.contains("already has 1 delegated thread"),
        "{said}"
    );

    // Cancelling its turn frees the room, and the caller hears it was cancelled.
    let mut seen = client
        .call_tool(
            &caller,
            "cancel_session_turn",
            &format!(r#"{{"sessionId": "{delegated}"}}"#),
        )
        .await;
    assert!(
        seen.agent.contains("cancel_session_turn answered: {}"),
        "{}",
        seen.agent
    );
    let told = client.told(&mut seen).await;
    assert!(told.contains("had its turn cancelled"), "{told}");
}

#[tokio::test]
async fn the_caller_is_told_when_a_delegated_session_waits_on_a_person() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    let caller = client.create(&world).await;
    let path = world.cwd().join("delegated.txt");
    // Told while its own turn still runs, or after.
    let mut seen = client
        .call_tool(
            &caller,
            "start_session",
            &format!(
                r#"{{"agentId": "other", "prompt": "write {} written"}}"#,
                path.display()
            ),
        )
        .await;
    let delegated = answered_session(&seen.agent, "start_session");
    let told = client.told(&mut seen).await;
    assert!(told.contains("is waiting on a person"), "{told}");
    assert!(told.contains("asks permission"), "{told}");
    assert!(told.contains("you can't"), "{told}");
    assert!(!path.exists());

    // A person attached to it answers, and the caller hears how it ended.
    let mut person = world.client(&daemon).await;
    let attached = person.attach(&delegated).await;
    let pending = attached.state.pending.first().cloned().expect("waiting");
    person
        .allow(&delegated, &pending, "allow")
        .await
        .expect("answered");
    let mut seen = Seen::default();
    loop {
        let told = client.told(&mut seen).await;
        if told.contains("finished its turn") {
            break;
        }
        seen = Seen::default();
    }
    assert!(path.exists());
}

#[tokio::test]
async fn a_caller_closed_meanwhile_is_taken_up_again_to_hear_how_its_delegated_turn_ended() {
    let world = World::new();
    let daemon = world.daemon(true, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    let caller = client.create(&world).await;
    let said = client
        .call_tool(
            &caller,
            "start_session",
            r#"{"agentId": "other", "prompt": "slow 5"}"#,
        )
        .await
        .agent;
    let delegated = answered_session(&said, "start_session");
    client
        .connection
        .send(CloseSessionRequest {
            session_id: caller.clone(),
        })
        .await
        .expect("session/close");
    let from_delegated = TurnOrigin::Session {
        session_id: delegated.clone(),
        report: true,
        host: None,
        host_name: None,
    };
    tokio::time::timeout(WAIT, async {
        loop {
            let latest = client.get(&caller).await.latest_turn;
            if latest.is_some_and(|turn| turn.origin == from_delegated && !turn.running) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("the caller to hear of it");
    let got = client.get(&caller).await;
    assert!(
        got.latest_turn
            .and_then(|turn| turn.message)
            .is_some_and(|message| message.contains("finished its turn")),
    );
}

#[tokio::test]
async fn a_drain_waits_for_running_turns_and_starts_no_new_ones() {
    let world = World::new();
    let (daemon, _) = world.daemon_draining(WAIT);
    let mut client = world.client(&daemon).await;
    assert!(
        client
            .connection
            .hello()
            .features
            .iter()
            .any(|f| f == DRAIN_FEATURE)
    );
    let running = client.create(&world).await;
    let idle = client.create(&world).await;
    client.prompt(&running, "slow 5").await;

    let ready = client
        .connection
        .send(DrainRequest {
            wait: false,
            except: None,
        })
        .await
        .expect("host/drain");
    assert_eq!(ready.running, 1);
    // No new turns: refused, or queued for the Host that comes back.
    let refused = client
        .connection
        .send(StartTurnRequest {
            session_id: idle.clone(),
            prompt: vec![ContentBlock::from("hello".to_owned())],
            key: None,
        })
        .await
        .expect_err("turn/start is refused");
    assert!(errors::is(&refused, errors::HOST_STOPPING), "{refused:?}");
    let refused = client
        .connection
        .send(run_request(&world, &world.cwd().join("file"), Vec::new()))
        .await
        .expect_err("session/run is refused");
    assert!(errors::is(&refused, errors::HOST_STOPPING), "{refused:?}");
    assert!(!client.queue(&idle, "later").await.started);

    let drained = client
        .connection
        .send(DrainRequest {
            wait: true,
            except: None,
        })
        .await
        .expect("host/drain");
    assert_eq!(drained.running, 0);
    let status = daemon.status();
    assert!(
        status
            .sessions
            .iter()
            .all(|session| session.activity == Some(Activity::Idle)),
        "{status:?}"
    );
    assert_eq!(client.attach(&idle).await.state.queue.len(), 1);
}

#[tokio::test]
async fn a_drain_gives_up_at_its_timeout_and_leaves_out_the_turn_that_asked() {
    let world = World::new();
    let (daemon, started) = world.daemon_draining(Duration::from_millis(300));
    let mut client = world.client(&daemon).await;
    let dir = world.cwd().join("asking");
    std::fs::create_dir_all(&dir).expect("a directory");
    let asking = client.session_in(&world, &dir).await.session_id;
    let other = client.create(&world).await;
    client.prompt(&asking, "slow 50").await;
    client.prompt(&other, "slow 50").await;
    let process = started
        .lock()
        .expect("lock")
        .iter()
        .find(|(cwd, _)| cwd.ends_with("asking"))
        .map(|(_, process)| process.clone())
        .expect("the asking session's agent");

    // The other turn holds the drain until its timeout and is left running; the asking one
    // isn't counted.
    let drained = tokio::time::timeout(
        WAIT,
        client.connection.send(DrainRequest {
            wait: true,
            except: Some(process),
        }),
    )
    .await
    .expect("answered at the timeout")
    .expect("host/drain");
    assert_eq!(drained.running, 1);
}

#[tokio::test]
async fn a_drain_ends_when_the_client_that_asked_goes_and_queued_prompts_start() {
    let world = World::new();
    let (daemon, _) = world.daemon_draining(WAIT);
    let mut client = world.client(&daemon).await;
    let session_id = client.create(&world).await;
    let asking = world.client(&daemon).await;
    asking
        .connection
        .send(DrainRequest {
            wait: false,
            except: None,
        })
        .await
        .expect("host/drain");
    assert!(!client.queue(&session_id, "later").await.started);

    asking.connection.shutdown().await;
    let mut seen = Seen::default();
    client.until_turn_ends(&mut seen, None).await;
    assert!(seen.agent.ends_with("You said: later"), "{seen:?}");
}

#[tokio::test]
async fn a_signal_waits_for_running_turns_unless_a_client_drained_first() {
    let world = World::new();
    let (daemon, _) = world.daemon_draining(WAIT);
    let mut client = world.client(&daemon).await;
    let session_id = client.create(&world).await;
    client.prompt(&session_id, "slow 5").await;
    assert_eq!(daemon.drain().await, 0);
    assert_eq!(daemon.status().sessions[0].activity, Some(Activity::Idle));

    let world = World::new();
    let (daemon, _) = world.daemon_draining(WAIT);
    let mut client = world.client(&daemon).await;
    let session_id = client.create(&world).await;
    client.prompt(&session_id, "slow 50").await;
    let ready = client
        .connection
        .send(DrainRequest {
            wait: false,
            except: None,
        })
        .await
        .expect("host/drain");
    assert_eq!(ready.running, 1);
    // `weave daemon stop --now` drained first, so the signal that follows doesn't wait.
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(2), daemon.drain())
            .await
            .expect("no wait"),
        1
    );
}
