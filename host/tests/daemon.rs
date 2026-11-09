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
use weave_host_protocol::events::ThreadEvent;
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
use weave_host_protocol::mcp::McpServerSource;
use weave_host_protocol::mcp::McpServerState;
use weave_host_protocol::mcp::McpServerStatus;
use weave_host_protocol::mcp::McpTransport;
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
use weave_host_protocol::threads::Activity;
use weave_host_protocol::threads::AttachThreadRequest;
use weave_host_protocol::threads::AttachThreadResponse;
use weave_host_protocol::threads::CloseThreadRequest;
use weave_host_protocol::threads::CloseWhen;
use weave_host_protocol::threads::CreateThreadRequest;
use weave_host_protocol::threads::DeleteThreadRequest;
use weave_host_protocol::threads::DetachThreadRequest;
use weave_host_protocol::threads::GetThreadRequest;
use weave_host_protocol::threads::GetThreadResponse;
use weave_host_protocol::threads::JournalPosition;
use weave_host_protocol::threads::LabelThreadRequest;
use weave_host_protocol::threads::ListThreadsRequest;
use weave_host_protocol::threads::MAX_LABELS;
use weave_host_protocol::threads::OBSERVE_FEATURE;
use weave_host_protocol::threads::RenameThreadRequest;
use weave_host_protocol::threads::RunRequest;
use weave_host_protocol::threads::SetSuccessorRequest;
use weave_host_protocol::threads::ThreadId;
use weave_host_protocol::threads::ThreadListing;
use weave_host_protocol::threads::ThreadState;
use weave_host_protocol::threads::ThreadStatus;
use weave_host_protocol::threads::TurnOrigin;
use weave_host_protocol::threads::TurnState;
use weave_host_protocol::threads::UnwatchThreadsRequest;
use weave_host_protocol::threads::WATCH_FEATURE;
use weave_host_protocol::threads::WatchThreadsRequest;
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

/// Fake agents in-process, sharing `state` so threads outlive any one of them. The stdio
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

    /// A Host whose blank threads close `blank_grace` after nothing needs them.
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

    /// A Host with journals whose agents advertise nothing optional, deleting threads included.
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

    /// A Host whose agents list their threads in every directory whatever `cwd` asks, as
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
            sessions: journals.then(|| self.dir.path().join("layouts")),
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
            former_serve: None,
            terminals: None,
            home: None,
            retired: Vec::new(),
            dispatcher: None,
        }
    }

    fn journals(&self) -> PathBuf {
        self.dir.path().join("threads")
    }

    /// Whether the Host keeps a journal of `thread_id`. The fake agent's ids need no
    /// escaping in a file name.
    fn has_journal(&self, thread_id: &ThreadId) -> bool {
        self.journals().join(format!("{thread_id}.jsonl")).exists()
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
    /// Why it closed, and who closed it.
    closed: Option<(String, Option<TurnOrigin>)>,
    notices: Vec<String>,
    /// Titles the thread was renamed to through the Host, and by whom.
    renamed: Vec<(String, Option<TurnOrigin>)>,
    /// The successors clients named for it.
    continued_in: Vec<ThreadId>,
    /// Its labels each time they changed.
    labelled: Vec<Vec<String>>,
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
    fn create_request(world: &World, agent: &str) -> CreateThreadRequest {
        CreateThreadRequest {
            agent_id: agent.to_owned(),
            cwd: world.cwd(),
            additional_directories: Vec::new(),
            mode: None,
            policy: None,
            trace: false,
            labels: Vec::new(),
        }
    }

    async fn create(&mut self, world: &World) -> ThreadId {
        self.create_with(world, "fake").await.thread_id
    }

    /// A thread in `dir`, prompted once so it isn't blank.
    async fn thread_in(&mut self, world: &World, dir: &Path) -> ThreadState {
        let state = self
            .connection
            .send(CreateThreadRequest {
                cwd: dir.to_path_buf(),
                ..Self::create_request(world, "fake")
            })
            .await
            .expect("thread/create");
        self.prompt(&state.thread_id, "hello").await;
        self.until_turn_ends(&mut Seen::default(), None).await;
        state
    }

    /// The Host's own listing, across agents, of the threads in `repo`'s repository.
    async fn in_repository(&self, repo: &Path) -> Vec<ThreadListing> {
        self.connection
            .send(ListThreadsRequest {
                repo: Some(repo.to_path_buf()),
                ..ListThreadsRequest::default()
            })
            .await
            .expect("threads/list")
            .threads
    }

    async fn create_with(&mut self, world: &World, agent: &str) -> ThreadState {
        let state = self
            .connection
            .send(Self::create_request(world, agent))
            .await
            .expect("thread/create");
        self.position = Some(JournalPosition {
            journal: state.journal.id.clone(),
            seq: state.journal.head,
        });
        state
    }

    async fn attach(&mut self, thread_id: &ThreadId) -> AttachThreadResponse {
        self.attach_after(thread_id, None)
            .await
            .expect("thread/attach")
    }

    async fn attach_after(
        &mut self,
        thread_id: &ThreadId,
        after: Option<JournalPosition>,
    ) -> Result<AttachThreadResponse, Error> {
        let attached = self
            .connection
            .send(AttachThreadRequest {
                thread_id: thread_id.clone(),
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

    /// The threads the fake agent's listing gives for the world's directory, in order.
    async fn list(&self, world: &World) -> Vec<ThreadId> {
        self.listing(world)
            .await
            .into_iter()
            .map(|listing| listing.info.session_id)
            .collect()
    }

    async fn listing(&self, world: &World) -> Vec<ThreadListing> {
        self.connection
            .send(ListThreadsRequest {
                agent_id: Some("fake".to_owned()),
                cwd: Some(world.cwd()),
                repo: None,
                activity: None,
                cursor: None,
                labels: Vec::new(),
            })
            .await
            .expect("threads/list")
            .threads
    }

    async fn prompt(&self, thread_id: &ThreadId, text: &str) -> u64 {
        self.connection
            .send(StartTurnRequest {
                thread_id: thread_id.clone(),
                prompt: vec![ContentBlock::from(text.to_owned())],
                key: None,
            })
            .await
            .expect("turn/start")
            .seq
    }

    async fn queue(&self, thread_id: &ThreadId, text: &str) -> AddQueuedResponse {
        self.queue_keyed(thread_id, text, None)
            .await
            .expect("queue/add")
    }

    async fn queue_keyed(
        &self,
        thread_id: &ThreadId,
        text: &str,
        key: Option<&str>,
    ) -> Result<AddQueuedResponse, Error> {
        self.connection
            .send(AddQueuedRequest {
                thread_id: thread_id.clone(),
                prompt: vec![ContentBlock::from(text.to_owned())],
                key: key.map(str::to_owned),
                caller: None,
                origin: None,
            })
            .await
    }

    async fn steer(&self, thread_id: &ThreadId, text: &str) -> SteerTurnResponse {
        self.connection
            .send(SteerTurnRequest {
                thread_id: thread_id.clone(),
                prompt: vec![ContentBlock::from(text.to_owned())],
                caller: None,
                origin: None,
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
                if matches!(event.event, ThreadEvent::TurnSteered { .. }) {
                    seen.steered_seqs.push(event.seq);
                }
                return seen.note(event.event);
            }
            HostEvent::PendingAdded(added) => {
                if let Some(option) = allow {
                    self.allow(&added.thread_id, &added.pending, option)
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
        thread_id: &ThreadId,
        pending: &PendingRequest,
        option: &str,
    ) -> Result<(), Error> {
        self.connection
            .send(AnswerPendingRequest {
                thread_id: thread_id.clone(),
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
    async fn tool_call(&mut self, seen: &mut Seen) -> (ThreadId, PendingRequest) {
        loop {
            match self.next().await {
                HostEvent::PendingAdded(added)
                    if matches!(added.pending.request, PendingKind::ClientTool { .. }) =>
                {
                    return (added.thread_id, added.pending);
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
        thread_id: &ThreadId,
        call: &PendingRequest,
        result: ClientToolResult,
    ) -> Result<(), Error> {
        self.connection
            .send(AnswerPendingRequest {
                thread_id: thread_id.clone(),
                pending_id: call.id.clone(),
                permission: None,
                elicitation: None,
                client_tool: Some(result),
            })
            .await
            .map(drop)
    }

    /// Watch the Host's threads: how they list now.
    async fn watch(&self) -> Vec<ThreadListing> {
        self.connection
            .send(WatchThreadsRequest::default())
            .await
            .expect("threads/watch")
            .threads
    }

    /// The next change to the Host's threads this client hears of, passing over the rest.
    async fn change(&mut self) -> Change {
        loop {
            match self.next().await {
                HostEvent::ThreadUpdated(updated) => {
                    return Change::Updated(Box::new(updated.thread));
                }
                HostEvent::ThreadRemoved(removed) => return Change::Removed(removed.thread_id),
                _ => {}
            }
        }
    }

    /// Whether a change to the Host's threads comes within a moment.
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
    async fn asked(&mut self, seen: &mut Seen) -> (ThreadId, PendingRequest) {
        loop {
            match self.next().await {
                HostEvent::PendingAdded(added) => return (added.thread_id, added.pending),
                event => {
                    self.note(event, seen, None).await;
                }
            }
        }
    }
}

impl Seen {
    /// Record an event; returns whether it ended a turn.
    fn note(&mut self, event: ThreadEvent) -> bool {
        match event {
            ThreadEvent::Update { notification } => match notification.update {
                SessionUpdate::UserMessageChunk(chunk) => self.user.push_str(&text(&chunk.content)),
                SessionUpdate::AgentMessageChunk(chunk) => {
                    self.agent.push_str(&text(&chunk.content));
                }
                _ => {}
            },
            ThreadEvent::TurnStarted {
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
            ThreadEvent::TurnSteered { prompt, .. } => {
                let text = prompt.iter().map(text).collect();
                self.steered.push((text, self.agent.len()));
            }
            ThreadEvent::TerminalOutput { data, .. } => self.terminal.push_str(&data),
            ThreadEvent::TurnEnded {
                response, error, ..
            } => {
                self.ended = match (response, error) {
                    (Some(response), _) => Some(response.stop_reason),
                    // A turn a stopped Host cut off, replayed.
                    (None, Some(error)) if errors::is(&error, errors::INTERRUPTED) => None,
                    (None, Some(error)) => panic!("the turn failed: {error}"),
                    (None, None) => None,
                };
                return true;
            }
            ThreadEvent::Closed { reason, by } => self.closed = Some((reason, by)),
            ThreadEvent::Notice { text } => self.notices.push(text),
            ThreadEvent::Renamed { title, by } => self.renamed.push((title, by)),
            ThreadEvent::ContinuedIn { successor, .. } => self.continued_in.push(successor),
            ThreadEvent::Labelled { labels, .. } => self.labelled.push(labels),
            ThreadEvent::Queued { queued_id, .. } => self.queued.push(queued_id),
            ThreadEvent::Unqueued { queued_id, .. } => self.unqueued.push(queued_id),
            ThreadEvent::QueuePaused { reason } => self.paused.push(reason),
            ThreadEvent::QueueResumed { .. } => self.resumed += 1,
            _ => {}
        }
        false
    }
}

/// A change to the Host's threads, as a watching client hears it.
#[derive(Debug, PartialEq)]
enum Change {
    Updated(Box<ThreadListing>),
    Removed(ThreadId),
}

impl Change {
    fn state(&self) -> Option<(ThreadStatus, Option<Activity>)> {
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
        thread_id: None,
        additional_directories: Vec::new(),
        mode: None,
        prompt: vec![ContentBlock::from(format!("write {} ok", path.display()))],
        policy: PermissionPolicy {
            approve,
            otherwise: Unapproved::Reject,
        },
        attach: false,
        trace: false,
        key: None,
        caller: None,
        origin: None,
        labels: Vec::new(),
    }
}

#[tokio::test]
async fn a_client_reattaches_mid_turn_and_sees_the_whole_transcript() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let mut first = world.client(&daemon).await;
    let thread_id = first.create(&world).await;
    first.prompt(&thread_id, "slow 4").await;
    // Two chunks in, the first client goes away.
    let mut seen = Seen::default();
    while seen.agent.matches("Chunk").count() < 2 {
        let event = first.next().await;
        first.note(event, &mut seen, None).await;
    }
    first.connection.shutdown().await;

    let mut second = world.client(&daemon).await;
    let attached = second.attach(&thread_id).await;
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
    let thread_id = first.create(&world).await;
    let mut second = world.client(&daemon).await;
    second.attach(&thread_id).await;
    first.prompt(&thread_id, "slow 50").await;
    let mut seen = Seen::default();
    while !seen.agent.contains("Chunk 1 of 50") {
        let event = first.next().await;
        first.note(event, &mut seen, None).await;
    }

    let answer = first.steer(&thread_id, "say hi instead").await;
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
    later.attach(&thread_id).await;
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
    let thread_id = client.create(&world).await;
    let not_running = SteerTurnResponse {
        outcome: SteerOutcome::NotRunning,
        seq: None,
        turn_id: None,
    };
    assert_eq!(client.steer(&thread_id, "hi").await, not_running);

    client.prompt(&thread_id, "hello").await;
    client.until_turn_ends(&mut Seen::default(), None).await;
    assert_eq!(client.steer(&thread_id, "too late").await, not_running);
    let attached = client.attach(&thread_id).await;
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
    let thread_id = first.create(&world).await;
    first.prompt(&thread_id, "hello").await;
    first.until_turn_ends(&mut Seen::default(), None).await;
    let position = first.position.clone();
    first.connection.shutdown().await;

    // While it's away, another turn runs.
    let mut other = world.client(&daemon).await;
    other.attach(&thread_id).await;
    other.prompt(&thread_id, "again").await;
    other.until_turn_ends(&mut Seen::default(), None).await;

    let mut back = world.client(&daemon).await;
    let attached = back
        .attach_after(&thread_id, position)
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
        .attach_after(&thread_id, Some(elsewhere))
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
    let thread_id = first.create(&world).await;
    let mut second = world.client(&daemon).await;
    second.attach(&thread_id).await;

    let target = world.cwd().join("out.txt");
    first
        .prompt(&thread_id, &format!("write {} hello", target.display()))
        .await;
    // Both are asked; the second answers, and the first hears it was.
    let (_, asked_first) = first.asked(&mut Seen::default()).await;
    let mut seen = Seen::default();
    let (_, asked_second) = second.asked(&mut seen).await;
    assert_eq!(asked_first.id, asked_second.id);
    second
        .allow(&thread_id, &asked_second, "allow")
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
                    !matches!(event.event, ThreadEvent::TurnEnded { .. }),
                    "the turn ended before the answer was told"
                );
            }
            _ => {}
        }
    }
    let late = first.allow(&thread_id, &asked_first, "allow").await;
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
    let thread_id = first.create(&world).await;
    let target = world.cwd().join("later.txt");
    first
        .prompt(&thread_id, &format!("write {} later", target.display()))
        .await;
    first.asked(&mut Seen::default()).await;
    first.connection.shutdown().await;

    // A client attaching later finds the request still waiting, and answers it.
    let mut second = world.client(&daemon).await;
    let attached = second.attach(&thread_id).await;
    let pending = attached
        .state
        .pending
        .first()
        .cloned()
        .expect("still pending");
    assert!(matches!(pending.request, PendingKind::Permission { .. }));
    assert_eq!(attached.state.activity, Activity::Waiting);
    second
        .allow(&thread_id, &pending, "allow")
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
    let thread_id = client.create(&world).await;
    client
        .prompt(
            &thread_id,
            &format!("write {} never", world.cwd().join("never.txt").display()),
        )
        .await;
    let (_, asked) = client.asked(&mut Seen::default()).await;
    client
        .connection
        .send(CancelTurnRequest {
            thread_id: thread_id.clone(),
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
    let thread_id = daemon
        .run(run_request(&world, &approved, vec![ToolKind::Edit]))
        .await
        .expect("run");
    wait_for(|| approved.exists()).await;
    wait_for(|| {
        daemon.status().threads.iter().any(|thread| {
            thread.info.session_id == thread_id && thread.activity == Some(Activity::Idle)
        })
    })
    .await;

    // Through `thread/run`, attached for the whole turn, as `weave run` is.
    let mut client = world.client(&daemon).await;
    let mut request = run_request(&world, &rejected, Vec::new());
    request.attach = true;
    let response = client.connection.send(request).await.expect("thread/run");
    assert!(response.state.is_some(), "attached");
    let mut seen = Seen::default();
    let mut origin = None;
    let mut notices = Vec::new();
    loop {
        let event = client.next().await;
        if let HostEvent::Event(event) = &event {
            match &event.event {
                ThreadEvent::TurnStarted {
                    origin: started, ..
                } => origin = Some(started.clone()),
                ThreadEvent::Notice { text } => notices.push(text.clone()),
                _ => {}
            }
        }
        if client.note(event, &mut seen, None).await {
            break;
        }
    }
    assert_eq!(origin, Some(TurnOrigin::Run {}));
    assert!(seen.user.starts_with("write "));
    assert!(!rejected.exists(), "the policy rejected the write");
    // And the thread says so, and how a run would approve it (WVE-166).
    assert!(
        notices.iter().any(
            |notice| notice.contains("This thread's policy rejected “Write ")
                && notice.contains("`weave run --approve edit`")
        ),
        "{notices:?}"
    );
    let status = client
        .connection
        .send(StatusRequest {})
        .await
        .expect("host/status");
    assert!(
        status
            .threads
            .iter()
            .any(|thread| thread.info.session_id == response.thread_id && thread.headless)
    );
}

#[tokio::test]
async fn a_restarted_host_takes_threads_up_from_their_journals() {
    let world = World::new();
    let thread_id = {
        let daemon = world.daemon(true, Duration::from_secs(60));
        let mut client = world.client(&daemon).await;
        let thread_id = client.create(&world).await;
        client.prompt(&thread_id, "hello there").await;
        client.until_turn_ends(&mut Seen::default(), None).await;
        daemon.shutdown().await;
        thread_id
    };

    let daemon = world.daemon(true, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    client.attach(&thread_id).await;
    // The history comes once, from the journal, not again from the agent.
    let mut seen = Seen::default();
    client.until_turn_ends(&mut seen, None).await;
    assert_eq!(seen.user, "hello there");
    client.prompt(&thread_id, "again").await;
    client.until_turn_ends(&mut seen, None).await;
    assert_eq!(seen.agent, "You said: hello thereYou said: again");
}

/// A journal as a Host of the Host protocol's version 2 left it (WVE-200): in `sessions`, naming
/// its thread `sessionId`, and a thread on another Host as `{"session": …}`. A Host of version 3
/// moves the journals to `threads` once, lists the thread with its title and labels, and takes it
/// up from its journal, which keeps what version 2 wrote as it was.
#[tokio::test]
async fn a_version_2_journal_opens_in_a_version_3_host() {
    let world = World::new();
    let thread_id = {
        let daemon = world.daemon(true, Duration::from_secs(60));
        let mut client = world.client(&daemon).await;
        let thread_id = client.create(&world).await;
        client.prompt(&thread_id, "hello there").await;
        client.until_turn_ends(&mut Seen::default(), None).await;
        daemon.shutdown().await;
        thread_id
    };
    let file = format!("{thread_id}.jsonl");
    let mut lines: Vec<String> = std::fs::read_to_string(world.journals().join(&file))
        .expect("the journal")
        .lines()
        .map(|line| {
            let mut record: serde_json::Value = serde_json::from_str(line).expect("a record");
            if let Some(id) = record
                .as_object_mut()
                .and_then(|record| record.remove("threadId"))
            {
                record["sessionId"] = id;
            }
            if record["type"] == "turnStarted" {
                record["origin"] = serde_json::json!({"session": {
                    "sessionId": "s-other", "host": "h-2", "hostName": "homelab"
                }});
            }
            record.to_string()
        })
        .collect();
    lines.insert(
        1,
        r#"{"type":"renamed","title":"Named in version 2"}"#.to_owned(),
    );
    lines.insert(2, r#"{"type":"labelled","labels":["kept"]}"#.to_owned());
    let sessions = world.dir.path().join("sessions");
    std::fs::rename(world.journals(), &sessions).expect("where version 2 kept them");
    std::fs::write(sessions.join(&file), lines.join("\n") + "\n").expect("as version 2 wrote it");

    let daemon = world.daemon(true, Duration::from_secs(60));
    assert!(!sessions.exists());
    assert!(world.journals().join(&file).exists());
    let mut client = world.client(&daemon).await;
    let listed = client.listing(&world).await;
    let listing = listed
        .iter()
        .find(|listing| listing.info.session_id == thread_id)
        .expect("listed");
    assert_eq!(listing.state, ThreadStatus::Suspended);
    assert_eq!(listing.info.title.as_deref(), Some("Named in version 2"));
    assert_eq!(listing.labels, ["kept"]);

    client.attach(&thread_id).await;
    let mut seen = Seen::default();
    client.until_turn_ends(&mut seen, None).await;
    assert_eq!(seen.user, "hello there");
    assert_eq!(seen.renamed, [("Named in version 2".to_owned(), None)]);
    assert!(
        matches!(
            &seen.origins[..],
            [(TurnOrigin::Thread { thread_id, host, .. }, None)]
                if thread_id.0.as_ref() == "s-other" && host.as_deref() == Some("h-2")
        ),
        "{:?}",
        seen.origins
    );
    client.prompt(&thread_id, "again").await;
    client.until_turn_ends(&mut seen, None).await;
    assert_eq!(seen.agent, "You said: hello thereYou said: again");
    daemon.shutdown().await;

    // What version 2 wrote stays as it was; what the Host wrote since says thread.
    let text = std::fs::read_to_string(world.journals().join(&file)).expect("the journal");
    let records: Vec<serde_json::Value> = text
        .lines()
        .map(|line| serde_json::from_str(line).expect("a record"))
        .collect();
    assert_eq!(records[0]["sessionId"], thread_id.0.as_ref());
    let started: Vec<&serde_json::Value> = records
        .iter()
        .filter(|record| record["type"] == "turnStarted")
        .collect();
    assert_eq!(started.len(), 2);
    assert_eq!(started[0]["sessionId"], thread_id.0.as_ref());
    assert_eq!(started[1]["threadId"], thread_id.0.as_ref());
    assert!(started[1].get("sessionId").is_none());
}

#[tokio::test]
async fn a_restarted_host_keeps_its_threads_order_and_titles_and_taking_one_up_changes_neither() {
    let world = World::new();
    let before = {
        let daemon = world.daemon(true, Duration::from_secs(60));
        let mut client = world.client(&daemon).await;
        for prompt in ["the older one", "the newer one"] {
            let thread_id = client.create(&world).await;
            client.prompt(&thread_id, prompt).await;
            client.until_turn_ends(&mut Seen::default(), None).await;
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let listed = client.watch().await;
        daemon.shutdown().await;
        listed
    };
    let shown = |listed: &[ThreadListing]| -> Vec<(ThreadId, Option<String>, Option<u64>)> {
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
    wait_for(|| daemon.status().threads.len() == 1).await;
    assert_eq!(shown(&client.watch().await), shown(&before));
}

#[tokio::test]
async fn idle_threads_close_after_their_grace_and_reopen_in_the_agent() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_millis(100));
    let mut client = world.client(&daemon).await;
    let thread_id = client.create(&world).await;
    client.prompt(&thread_id, "first").await;
    client.until_turn_ends(&mut Seen::default(), None).await;
    client.connection.shutdown().await;
    wait_for(|| daemon.status().threads.is_empty()).await;

    // Closed, it's loaded from the agent, whose replay fills a new journal.
    let mut client = world.client(&daemon).await;
    let attached = client.attach(&thread_id).await;
    assert!(attached.replay.reset);
    let mut seen = Seen::default();
    client.prompt(&thread_id, "back").await;
    client.until_turn_ends(&mut seen, None).await;
    assert_eq!(seen.agent, "You said: firstYou said: back");
}

#[tokio::test]
async fn blank_threads_are_left_out_of_the_list_until_prompted() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    let thread_id = client.create(&world).await;
    // A blank thread offers nothing a new one doesn't, so it isn't listed even by an agent
    // that saved it, as the fake agent does.
    assert_eq!(client.list(&world).await, Vec::<ThreadId>::new());
    client.prompt(&thread_id, "hello").await;
    client.until_turn_ends(&mut Seen::default(), None).await;
    assert_eq!(client.list(&world).await, [thread_id]);
}

#[tokio::test]
async fn a_client_reattaching_to_a_blank_thread_is_told_it_is_blank() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    let state = client.create_with(&world, "fake").await;
    assert!(state.blank);
    let thread_id = state.thread_id;
    // As after a reload, which reattaches by id.
    let mut again = world.client(&daemon).await;
    assert!(again.attach(&thread_id).await.state.blank);
    client.prompt(&thread_id, "hello").await;
    client.until_turn_ends(&mut Seen::default(), None).await;
    let mut later = world.client(&daemon).await;
    assert!(!later.attach(&thread_id).await.state.blank);
}

#[tokio::test]
async fn a_blank_thread_closes_soon_after_it_is_left_and_keeps_no_journal() {
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

    wait_for(|| daemon.status().threads.len() == 1).await;
    // The prompted thread waits out the idle grace and keeps its journal.
    assert_eq!(daemon.status().threads[0].info.session_id, prompted);
    assert!(world.has_journal(&prompted));
    assert!(!world.has_journal(&blank));
}

#[tokio::test]
async fn a_stopping_host_closes_blank_threads_instead_of_leaving_them_open() {
    let world = World::new();
    let daemon = world.daemon(true, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    let prompted = client.create(&world).await;
    client.prompt(&prompted, "hello").await;
    client.until_turn_ends(&mut Seen::default(), None).await;
    let blank = client.create(&world).await;
    daemon.shutdown().await;
    // The prompted thread is left for a later Host to take up; the blank one is gone.
    assert!(world.has_journal(&prompted));
    assert!(!world.has_journal(&blank));
}

#[tokio::test]
async fn threads_a_stopped_host_left_open_stop_leading_the_list_after_the_idle_grace() {
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
            .send(CloseThreadRequest {
                thread_id: closed.clone(),
            })
            .await
            .expect("thread/close");
        daemon.shutdown().await;
        (left_open, closed)
    };
    // Within the grace, it leads the list, as an open thread would.
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
    let order: Vec<&ThreadId> = listing
        .iter()
        .map(|listing| &listing.info.session_id)
        .collect();
    assert_eq!(order, [&closed, &left_open]);
    assert_eq!(listing[1].state, ThreadStatus::Suspended);
    // ...but it still reopens from its journal.
    client.attach(&left_open).await;
    let mut seen = Seen::default();
    client.until_turn_ends(&mut seen, None).await;
    assert_eq!(seen.user, "first");
}

#[tokio::test]
async fn threads_a_stopped_host_left_open_close_if_nobody_takes_them_up_within_the_grace() {
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
            .send(ListThreadsRequest {
                agent_id: None,
                cwd: None,
                repo: None,
                activity: None,
                cursor: None,
                labels: Vec::new(),
            })
            .await
            .expect("threads/list")
            .threads
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
            .all(|listing| listing.state == ThreadStatus::Suspended)
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
                if listing.info.session_id == unclaimed && listing.state == ThreadStatus::Closed)
        })
        .await;
    let states = host_wide(&client).await;
    assert_eq!(states[&unclaimed], ThreadStatus::Closed);
    assert_eq!(states[&claimed], ThreadStatus::Open);
    assert_eq!(age(), left);

    // A later Host finds it closed, and it still opens again, in a new journal.
    daemon.shutdown().await;
    let daemon = world.daemon(true, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    assert_eq!(host_wide(&client).await[&unclaimed], ThreadStatus::Closed);
    assert!(client.attach(&unclaimed).await.replay.reset);
}

#[tokio::test]
async fn deleting_a_thread_its_agent_cant_delete_still_forgets_it_in_the_host() {
    let world = World::new();
    let daemon = world.daemon_minimal();
    let mut client = world.client(&daemon).await;
    let thread_id = client.create(&world).await;
    client.prompt(&thread_id, "hello").await;
    client.until_turn_ends(&mut Seen::default(), None).await;
    let mut watcher = world.client(&daemon).await;
    watcher.watch().await;
    assert!(world.has_journal(&thread_id));

    client
        .connection
        .send(DeleteThreadRequest {
            thread_id: thread_id.clone(),
            agent_id: None,
        })
        .await
        .expect("thread/delete");
    assert!(!world.has_journal(&thread_id));
    watcher
        .changes_until(|change| *change == Change::Removed(thread_id.clone()))
        .await;
}

#[tokio::test]
async fn deleting_a_thread_whose_directory_is_gone_forgets_it_in_the_host() {
    let world = World::new();
    let worktree = world.cwd().join("worktree");
    std::fs::create_dir(&worktree).expect("the worktree");
    let daemon = world.daemon(true, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    let thread_id = client
        .connection
        .send(CreateThreadRequest {
            cwd: worktree.clone(),
            ..TestClient::create_request(&world, "fake")
        })
        .await
        .expect("thread/create")
        .thread_id;
    client.prompt(&thread_id, "hello").await;
    client.until_turn_ends(&mut Seen::default(), None).await;
    client
        .connection
        .send(CloseThreadRequest {
            thread_id: thread_id.clone(),
        })
        .await
        .expect("thread/close");
    std::fs::remove_dir_all(&worktree).expect("the worktree removed");

    client
        .connection
        .send(DeleteThreadRequest {
            thread_id: thread_id.clone(),
            agent_id: None,
        })
        .await
        .expect("thread/delete");
    assert!(!world.has_journal(&thread_id));
    // The agent, which would have had to run there, keeps its own history of it.
    let agents_own = client
        .connection
        .send(ListThreadsRequest {
            agent_id: Some("fake".to_owned()),
            cwd: Some(worktree),
            repo: None,
            activity: None,
            cursor: None,
            labels: Vec::new(),
        })
        .await
        .expect("threads/list")
        .threads;
    assert!(agents_own.iter().any(
        |listing| listing.info.session_id == thread_id && listing.state == ThreadStatus::Closed
    ));
}

#[tokio::test]
async fn command_output_reaches_clients_and_is_replayed() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    let thread_id = client.create(&world).await;
    client.prompt(&thread_id, "run echo from-the-host").await;
    let mut seen = Seen::default();
    client.until_turn_ends(&mut seen, None).await;
    assert_eq!(seen.terminal, "from-the-host\n");

    let mut late = world.client(&daemon).await;
    late.attach(&thread_id).await;
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
    let thread_id = client.create(&world).await;
    client.prompt(&thread_id, "run weave-login-tool").await;
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
async fn threads_list_with_their_activity_and_close_when_left() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    let thread_id = client.create(&world).await;
    client.prompt(&thread_id, "hello").await;
    client.until_turn_ends(&mut Seen::default(), None).await;
    let listing = client.listing(&world).await;
    let entry = listing
        .iter()
        .find(|listing| listing.info.session_id == thread_id)
        .expect("the open thread is listed");
    assert_eq!(
        (entry.state, entry.clients, entry.activity),
        (ThreadStatus::Open, 1, Some(Activity::Idle))
    );
    // Across agents too.
    let everything = client
        .connection
        .send(ListThreadsRequest::default())
        .await
        .expect("threads/list");
    assert!(
        everything
            .threads
            .iter()
            .any(|listing| listing.info.session_id == thread_id && listing.agent_id == "fake")
    );

    client
        .connection
        .send(DetachThreadRequest {
            thread_id,
            close: CloseWhen::IfUnused,
        })
        .await
        .expect("thread/detach");
    wait_for(|| daemon.status().threads.is_empty()).await;
}

/// Left with `ifUnused` while its turn runs, a thread closes when the turn ends rather than
/// after the idle grace, unless a client attaches before then (WVE-159).
#[tokio::test]
async fn a_thread_left_mid_turn_closes_when_its_turn_ends_unless_one_attaches() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    let leave = |thread_id: &ThreadId| DetachThreadRequest {
        thread_id: thread_id.clone(),
        close: CloseWhen::IfUnused,
    };
    let open = |thread_id: &ThreadId| {
        daemon
            .status()
            .threads
            .iter()
            .any(|thread| &thread.info.session_id == thread_id)
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

/// An observer is sent what clients are without being one: it isn't counted, keeps no thread
/// open, closes none by leaving, and never opens one that's closed (WVE-108).
#[tokio::test]
async fn an_observer_follows_a_thread_without_holding_it() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    let thread_id = client.create(&world).await;
    let open = || {
        daemon
            .status()
            .threads
            .iter()
            .any(|thread| thread.info.session_id == thread_id)
    };
    let observe = AttachThreadRequest {
        thread_id: thread_id.clone(),
        after: None,
        agent_id: None,
        cwd: None,
        trace: false,
        observe: true,
    };
    let leave = DetachThreadRequest {
        thread_id: thread_id.clone(),
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
    client.prompt(&thread_id, "slow 2").await;
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

    // Observing again, it doesn't keep the thread open once the client leaves.
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
        .expect_err("a closed thread");
    assert!(errors::is(&error, errors::THREAD_NOT_OPEN), "{error}");
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
    let thread_id = client.create(&world).await;
    assert!(
        daemon
            .status()
            .threads
            .iter()
            .any(|thread| thread.info.session_id == thread_id)
    );
}

#[tokio::test]
async fn open_threads_lead_the_list_so_continue_finds_them() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let mut left = world.client(&daemon).await;
    let open = left.create(&world).await;
    left.prompt(&open, "first").await;
    left.until_turn_ends(&mut Seen::default(), None).await;
    left.connection.shutdown().await;
    // A thread used more recently, but closed, so the agent lists it first.
    let mut other = world.client(&daemon).await;
    let closed = other.create(&world).await;
    other.prompt(&closed, "later").await;
    other.until_turn_ends(&mut Seen::default(), None).await;
    other
        .connection
        .send(CloseThreadRequest {
            thread_id: closed.clone(),
        })
        .await
        .expect("thread/close");
    wait_for(|| daemon.status().threads.len() == 1).await;
    assert_eq!(other.list(&world).await, [open, closed]);
}

#[tokio::test]
async fn continue_finds_no_thread_in_another_directory_though_the_agent_lists_it() {
    let world = World::new();
    let daemon = world.daemon_listing_every_directory();
    let mut client = world.client(&daemon).await;
    // A thread open in another worktree, which the agent lists here too.
    let worktree = world.cwd().join("worktree");
    std::fs::create_dir(&worktree).expect("another directory");
    client.thread_in(&world, &worktree).await;
    assert_eq!(client.list(&world).await, Vec::<ThreadId>::new());
    let here = client.thread_in(&world, &world.cwd()).await.thread_id;
    assert_eq!(client.list(&world).await, [here]);
}

#[tokio::test]
async fn closing_a_thread_closes_it_for_every_client() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    let thread_id = client.create(&world).await;
    client.prompt(&thread_id, "slow 20").await;
    let control = world.client(&daemon).await;
    control
        .connection
        .send(CloseThreadRequest {
            thread_id: thread_id.clone(),
        })
        .await
        .expect("thread/close");
    let mut failed = false;
    let reason = loop {
        if let HostEvent::Event(event) = client.next().await {
            match event.event {
                ThreadEvent::Closed { reason, .. } => break reason,
                ThreadEvent::TurnEnded { error, .. } => failed = error.is_some(),
                _ => {}
            }
        }
    };
    assert!(failed, "the turn ends with the thread");
    assert_eq!(reason, "closed by a client");
    assert!(daemon.status().threads.is_empty());
    let again = control
        .connection
        .send(CloseThreadRequest { thread_id })
        .await;
    assert!(
        again
            .as_ref()
            .is_err_and(|error| errors::is(error, errors::THREAD_NOT_OPEN)),
        "{again:?}"
    );
}

#[tokio::test]
async fn threads_a_stopped_host_left_open_lead_the_list_with_headless_ones_marked() {
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
                .threads
                .iter()
                .all(|thread| thread.activity == Some(Activity::Idle))
        })
        .await;
        // Used last but closed, so the agent lists it first.
        let mut other = world.client(&daemon).await;
        let closed = other.create(&world).await;
        other.prompt(&closed, "later").await;
        other.until_turn_ends(&mut Seen::default(), None).await;
        other
            .connection
            .send(CloseThreadRequest {
                thread_id: closed.clone(),
            })
            .await
            .expect("close");
        daemon.shutdown().await;
        (interactive, headless, closed)
    };

    let daemon = world.daemon(true, Duration::from_secs(60));
    let client = world.client(&daemon).await;
    let listing = client.listing(&world).await;
    let order: Vec<&ThreadId> = listing
        .iter()
        .map(|listing| &listing.info.session_id)
        .collect();
    assert_eq!(order, [&headless, &interactive, &closed]);
    let flags: Vec<bool> = listing.iter().map(|listing| listing.headless).collect();
    assert_eq!(flags, [true, false, false]);
}

#[tokio::test]
async fn a_thread_opens_only_with_its_own_agent_and_says_where_it_works() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    let thread_id = client.create(&world).await;

    let other = world.client(&daemon).await;
    let refused = other
        .connection
        .send(AttachThreadRequest {
            thread_id: thread_id.clone(),
            after: None,
            agent_id: Some("other".to_owned()),
            cwd: None,
            trace: false,
            observe: false,
        })
        .await
        .expect_err("another agent's thread");
    assert!(errors::is(&refused, errors::WRONG_AGENT), "{refused}");

    // Attached from anywhere, the thread still works in its own directory.
    let mut second = world.client(&daemon).await;
    let attached = second.attach(&thread_id).await;
    assert_eq!(attached.state.cwd, world.cwd());
    assert_eq!(attached.state.agent.id, "fake");
}

#[tokio::test]
async fn one_connection_reaches_threads_of_two_agents() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    let fake = client.create_with(&world, "fake").await;
    let other = client.create_with(&world, "other").await;
    assert_eq!(
        (fake.agent.id.as_str(), other.agent.id.as_str()),
        ("fake", "other")
    );
    client.prompt(&fake.thread_id, "one").await;
    client.until_turn_ends(&mut Seen::default(), None).await;
    client.prompt(&other.thread_id, "two").await;
    let mut seen = Seen::default();
    client.until_turn_ends(&mut seen, None).await;
    assert_eq!(seen.agent, "You said: two");
    let status = daemon.status();
    assert_eq!(status.threads.len(), 2);
}

#[tokio::test]
async fn new_threads_start_in_the_configured_mode_unless_asked_for_another() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    // The fake agent offers its modes as a config option, which takes precedence.
    let current_mode = |state: &ThreadState| {
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

    // A headless run starts in it too, as `weave run` and a thread delegating do (WVE-166).
    let path = world.cwd().join("ran.txt");
    let ran = |mode: Option<&str>| {
        let mut request = run_request(&world, &path, Vec::new());
        request.attach = true;
        request.mode = mode.map(str::to_owned);
        request
    };
    let configured = client.connection.send(ran(None)).await.expect("run");
    let configured = configured.state.expect("attached");
    assert_eq!(current_mode(&configured).as_deref(), Some("code"));
    let asked = client.connection.send(ran(Some("ask"))).await.expect("run");
    assert_eq!(
        current_mode(&asked.state.expect("attached")).as_deref(),
        Some("ask")
    );
    let missing = client
        .connection
        .send(ran(Some("nonsense")))
        .await
        .expect("run");
    let notices = missing.state.expect("attached").notices;
    assert!(
        notices
            .iter()
            .any(|notice| notice.contains("no mode nonsense")),
        "{notices:?}"
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
        .send_request(hello(VersionRange { min: 4, max: 5 }))
        .block_task()
        .await
        .expect_err("no common version");
    assert!(errors::is(&newer, errors::INCOMPATIBLE_PROTOCOL), "{newer}");
    // Version 3 renamed version 2's session to thread, keeping none of its names (WVE-200).
    let older = cx
        .send_request(hello(VersionRange { min: 2, max: 2 }))
        .block_task()
        .await
        .expect_err("no common version");
    assert!(errors::is(&older, errors::INCOMPATIBLE_PROTOCOL), "{older}");
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
    assert_eq!(accepted.protocol, 3);
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
    assert_eq!(protocol, Some(3));
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
    let thread_id = runner.create(&world).await;
    let mut other = world.tool_client(&daemon).await;
    other.attach(&thread_id).await;

    runner.prompt(&thread_id, COPY).await;
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
        .run_tool(&thread_id, &call, ClientToolResult::text("not mine"))
        .await;
    assert!(
        refused
            .as_ref()
            .is_err_and(|error| errors::is(error, errors::NOT_TARGET)),
        "{refused:?}"
    );

    runner
        .run_tool(&thread_id, &call, ClientToolResult::text("Copied."))
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
    let thread_id = client.create(&world).await;
    client.prompt(&thread_id, COPY).await;
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
    client.connection.send(request).await.expect("thread/run");
    let mut seen = Seen::default();
    client.until_turn_ends(&mut seen, None).await;
    assert!(seen.agent.contains("came from a headless run"), "{seen:?}");
}

#[tokio::test]
async fn a_client_tool_call_fails_as_one_that_may_have_run_when_its_client_leaves() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let mut runner = world.tool_client(&daemon).await;
    let thread_id = runner.create(&world).await;
    let mut watcher = world.client(&daemon).await;
    watcher.attach(&thread_id).await;

    runner.prompt(&thread_id, COPY).await;
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
    let thread_id = runner.create(&world).await;
    runner.prompt(&thread_id, COPY).await;
    let (_, call) = runner.tool_call(&mut Seen::default()).await;
    runner
        .connection
        .send(CancelTurnRequest {
            thread_id: thread_id.clone(),
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
        .run_tool(&thread_id, &call, ClientToolResult::text("too late"))
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
    let thread_id = runner.create(&world).await;
    runner.prompt(&thread_id, COPY).await;
    let mut seen = Seen::default();
    runner.until_turn_ends(&mut seen, None).await;
    assert!(
        seen.agent.contains("unknown tool: clipboard_write"),
        "{seen:?}"
    );
}

#[tokio::test]
async fn a_client_beside_the_host_doesnt_keep_an_idle_one_running() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let info = || ClientInfo {
        name: "test".to_owned(),
        version: "0".to_owned(),
    };
    let serving = |name: &str| {
        let listener = tokio::net::UnixListener::bind(world.dir.path().join(name)).expect("bind");
        let daemon = daemon.clone();
        tokio::spawn(async move {
            daemon
                .serve(listener, Some(Duration::from_millis(100)))
                .await
        })
    };

    // A client connected the ordinary way keeps it running.
    let counted = HostConnection::connect(
        daemon.connect_in_process(),
        info(),
        ClientCapabilities::default(),
    )
    .await
    .expect("connect");
    let served = serving("counted.sock");
    tokio::time::sleep(Duration::from_millis(2500)).await;
    assert!(!served.is_finished(), "it stayed up for its client");
    drop(counted);
    served.abort();

    // One beside it, as `weave daemon`'s follower of threads for Rex, doesn't.
    let _beside = HostConnection::connect(
        daemon.connect_beside(),
        info(),
        ClientCapabilities::default(),
    )
    .await
    .expect("connect");
    let served = serving("beside.sock");
    tokio::time::timeout(WAIT, served)
        .await
        .expect("it went once idle")
        .expect("served");
}

#[tokio::test]
async fn listings_say_who_opened_a_thread_and_its_clients_hear_who_closed_it() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let mut opener = world.client(&daemon).await;
    let thread_id = opener.create(&world).await;
    opener.prompt(&thread_id, "hello").await;
    opener.until_turn_ends(&mut Seen::default(), None).await;
    let listed = opener
        .connection
        .send(ListThreadsRequest::default())
        .await
        .expect("threads/list")
        .threads;
    let listing = listed
        .iter()
        .find(|listing| listing.info.session_id == thread_id)
        .expect("listed");
    assert!(
        matches!(
            &listing.opened_by,
            Some(TurnOrigin::Client { id, .. }) if id == opener.connection.client_id()
        ),
        "{listing:?}"
    );
    assert!(listing.opened_at.is_some());

    // Another client closes it for everyone, and the first hears who did.
    let mut closer = world.client(&daemon).await;
    closer.attach(&thread_id).await;
    closer
        .connection
        .send(CloseThreadRequest {
            thread_id: thread_id.clone(),
        })
        .await
        .expect("thread/close");
    let mut seen = Seen::default();
    while seen.closed.is_none() {
        let event = opener.next().await;
        opener.note(event, &mut seen, None).await;
    }
    let (reason, by) = seen.closed.expect("closed");
    assert_eq!(reason, "closed by a client");
    assert!(
        matches!(&by, Some(TurnOrigin::Client { id, .. }) if id == closer.connection.client_id()),
        "{by:?}"
    );
}

#[tokio::test]
async fn a_threads_mcp_servers_say_how_each_one_is() {
    let world = World::new();
    std::fs::write(
        world.dir.path().join("config.toml"),
        "[agents.fake]\ncommand = \"fake-agent\"\n\n\
         [[mcp_servers]]\nname = \"shell\"\ncommand = \"/bin/sh\"\n\n\
         [[mcp_servers]]\nname = \"missing\"\ncommand = \"weave-no-such-server\"\n",
    )
    .expect("config");
    let daemon = world.daemon(false, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    let state = client.create_with(&world, "fake").await;
    let status = |name: &str, source, transport, state, reason: Option<&str>| McpServerStatus {
        name: name.to_owned(),
        source,
        transport,
        state,
        reason: reason.map(str::to_owned),
    };
    assert_eq!(
        state.mcp_servers,
        [
            status(
                "weave",
                McpServerSource::Host,
                Some(McpTransport::Stdio),
                McpServerState::Declared,
                None,
            ),
            status(
                "shell",
                McpServerSource::Config,
                Some(McpTransport::Stdio),
                McpServerState::Passed,
                None,
            ),
            status(
                "missing",
                McpServerSource::Config,
                None,
                McpServerState::Skipped,
                Some("weave-no-such-server not found on PATH"),
            ),
        ]
    );

    // Its own server is connected once the agent speaks to it, and attached clients hear so.
    client.prompt(&state.thread_id, COPY).await;
    let servers = tokio::time::timeout(WAIT, async {
        loop {
            if let HostEvent::Changed(changed) = client.next().await
                && let Some(servers) = changed.mcp_servers
                && servers[0].state == McpServerState::Connected
            {
                return servers;
            }
        }
    })
    .await
    .expect("the change in time");
    assert_eq!(servers[1..], state.mcp_servers[1..]);

    // A client attaching later sees it as it is now.
    let mut later = world.client(&daemon).await;
    let attached = later.attach(&state.thread_id).await;
    assert_eq!(attached.state.mcp_servers, servers);
}

#[tokio::test]
async fn the_host_mcp_server_over_acp_says_so() {
    let world = World::new();
    let daemon = world.daemon_over_acp();
    let mut client = world.client(&daemon).await;
    let state = client.create_with(&world, "fake").await;
    assert_eq!(state.mcp_servers.len(), 1);
    assert_eq!(state.mcp_servers[0].transport, Some(McpTransport::Acp));
    assert_eq!(state.mcp_servers[0].state, McpServerState::Declared);
}

#[tokio::test]
async fn an_agent_on_an_older_mcp_is_refused_and_its_clients_told() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    let thread_id = client.create(&world).await;
    client.prompt(&thread_id, "mcp-legacy").await;
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

    // Later clients see it in the journal, and in the server's status.
    let mut later = world.client(&daemon).await;
    let attached = later.attach_after(&thread_id, None).await.expect("attach");
    let own = &attached.state.mcp_servers[0];
    assert_eq!(own.state, McpServerState::Unavailable);
    assert!(
        own.reason
            .as_deref()
            .is_some_and(|reason| reason.contains("predates MCP 2026-07-28")),
        "{own:?}"
    );
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
    // Declaring the server for a thread starts the socket.
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
async fn a_watcher_hears_of_threads_it_isnt_attached_to_from_first_prompt_to_deletion() {
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
    let thread_id = driver.create(&world).await;
    assert!(!watcher.hears_a_change().await);

    // Prompted, it appears, then runs, waits on a person, runs again and goes idle, titled.
    let path = world.cwd().join("watched.txt");
    driver
        .prompt(&thread_id, &format!("write {} hello", path.display()))
        .await;
    let (asked_in, pending) = driver.asked(&mut Seen::default()).await;
    driver
        .allow(&asked_in, &pending, "allow")
        .await
        .expect("answer");
    driver.until_turn_ends(&mut Seen::default(), None).await;
    let changes = watcher
        .changes_until(|change| change.state() == Some((ThreadStatus::Open, Some(Activity::Idle))))
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
    assert_eq!(last.info.session_id, thread_id);
    assert_eq!(last.info.cwd, world.cwd());
    assert_eq!(last.agent_id, "fake");
    assert_eq!(last.clients, 1);
    assert!(last.info.title.is_some(), "the agent titled it: {last:?}");

    // Closed, opened again by attaching, then deleted.
    driver
        .connection
        .send(CloseThreadRequest {
            thread_id: thread_id.clone(),
        })
        .await
        .expect("thread/close");
    let closed = watcher
        .changes_until(|change| {
            change
                .state()
                .is_some_and(|(state, _)| state == ThreadStatus::Closed)
        })
        .await;
    assert_eq!(
        closed.last().and_then(Change::state),
        Some((ThreadStatus::Closed, None))
    );
    let mut other = world.client(&daemon).await;
    other.attach(&thread_id).await;
    watcher
        .changes_until(|change| {
            change
                .state()
                .is_some_and(|(state, _)| state == ThreadStatus::Open)
        })
        .await;
    driver
        .connection
        .send(DeleteThreadRequest {
            thread_id: thread_id.clone(),
            agent_id: None,
        })
        .await
        .expect("thread/delete");
    let gone = watcher
        .changes_until(|change| matches!(change, Change::Removed(_)))
        .await;
    assert_eq!(gone.last(), Some(&Change::Removed(thread_id)));
}

#[tokio::test]
async fn a_watcher_hears_of_threads_suspended_when_the_host_stops_and_blank_ones_closed() {
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
        [(kept.clone(), ThreadStatus::Open, Some(Activity::Idle))]
    );

    // One nobody prompted goes, closed, with nothing left of it.
    let blank = driver.create(&world).await;
    driver
        .connection
        .send(CloseThreadRequest {
            thread_id: blank.clone(),
        })
        .await
        .expect("thread/close");
    assert_eq!(watcher.change().await, Change::Removed(blank));

    daemon.shutdown().await;
    let suspended = watcher
        .changes_until(|change| {
            change
                .state()
                .is_some_and(|(state, _)| state == ThreadStatus::Suspended)
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
        .send(UnwatchThreadsRequest {})
        .await
        .expect("threads/unwatch");
    let mut driver = world.client(&daemon).await;
    let thread_id = driver.create(&world).await;
    driver.prompt(&thread_id, "hello").await;
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
async fn a_tool_call_sent_before_the_thread_is_set_up_waits_for_it() {
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
    // rather than failing as one for no thread, then found no turn to send it to.
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
async fn a_thread_opened_again_declares_the_host_mcp_server_anew() {
    let world = World::new();
    let daemon = world.daemon_over_acp();
    let mut client = world.tool_client(&daemon).await;
    let thread_id = client.create(&world).await;
    let declared = |seen: &Seen| {
        seen.agent
            .rsplit("MCP servers: ")
            .next()
            .unwrap_or_default()
            .to_owned()
    };
    client.prompt(&thread_id, "mcp").await;
    let mut before = Seen::default();
    client.until_turn_ends(&mut before, None).await;
    client
        .connection
        .send(CloseThreadRequest {
            thread_id: thread_id.clone(),
        })
        .await
        .expect("thread/close");

    let mut again = world.tool_client(&daemon).await;
    again.attach(&thread_id).await;
    again.prompt(&thread_id, "mcp").await;
    let mut after = Seen::default();
    while !after.agent.contains("MCP servers: ") || after.ended.is_none() {
        let event = again.next().await;
        again.note(event, &mut after, None).await;
    }
    assert!(declared(&before).starts_with("weave (acp "), "{before:?}");
    assert!(declared(&after).starts_with("weave (acp "), "{after:?}");
    assert_ne!(declared(&before), declared(&after));

    // The new declaration is the one that works.
    again.prompt(&thread_id, COPY).await;
    let mut seen = Seen::default();
    let (_, call) = again.tool_call(&mut seen).await;
    again
        .run_tool(&thread_id, &call, ClientToolResult::text("Copied."))
        .await
        .expect("the target answers");
    again.until_turn_ends(&mut seen, None).await;
    assert!(
        seen.agent.contains("clipboard_write answered: Copied."),
        "{seen:?}"
    );
}

fn rename(thread_id: &ThreadId, title: &str) -> RenameThreadRequest {
    RenameThreadRequest {
        thread_id: thread_id.clone(),
        title: title.to_owned(),
    }
}

#[tokio::test]
async fn a_thread_renamed_through_the_host_keeps_its_title() {
    let world = World::new();
    let daemon = world.daemon(true, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    let mut watcher = world.client(&daemon).await;
    watcher.watch().await;
    let thread_id = client.create(&world).await;

    for (title, why) in [
        ("   ".to_owned(), "a title can't be empty"),
        ("x".repeat(201), "a title is at most 200 characters"),
    ] {
        let error = client
            .connection
            .send(rename(&thread_id, &title))
            .await
            .expect_err("refused");
        assert_eq!(
            error.data.as_ref().and_then(|data| data.as_str()),
            Some(why)
        );
    }
    client
        .connection
        .send(rename(&thread_id, "  Parser fixes "))
        .await
        .expect("thread/rename");

    // The agent titles a thread after its first prompt; that doesn't replace the rename.
    client.prompt(&thread_id, "hello").await;
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
        .changes_until(|change| change.state() == Some((ThreadStatus::Open, Some(Activity::Idle))))
        .await;
    for change in &changes {
        let Change::Updated(listing) = change else {
            panic!("{changes:?}");
        };
        assert_eq!(listing.info.title.as_deref(), Some("Parser fixes"));
    }
    let titles = |listings: Vec<ThreadListing>| {
        listings
            .into_iter()
            .map(|listing| listing.info.title)
            .collect::<Vec<_>>()
    };
    let host = client
        .connection
        .send(ListThreadsRequest::default())
        .await
        .expect("threads/list");
    assert_eq!(titles(host.threads), [Some("Parser fixes".to_owned())]);
    assert_eq!(
        titles(client.listing(&world).await),
        [Some("Parser fixes".to_owned())]
    );

    // A Host that stopped and started again keeps it.
    daemon.shutdown().await;
    let daemon = world.daemon(true, Duration::from_secs(60));
    let mut later = world.client(&daemon).await;
    let resumed = later.attach(&thread_id).await;
    assert_eq!(resumed.state.title.as_deref(), Some("Parser fixes"));

    // So does a thread closed and opened again, in a new journal.
    later
        .connection
        .send(CloseThreadRequest {
            thread_id: thread_id.clone(),
        })
        .await
        .expect("thread/close");
    let error = later
        .connection
        .send(rename(&thread_id, "Closed"))
        .await
        .expect_err("refused");
    assert!(errors::is(&error, errors::THREAD_NOT_OPEN), "{error}");
    let mut again = world.client(&daemon).await;
    let reopened = again.attach(&thread_id).await;
    assert!(reopened.replay.reset);
    assert_eq!(reopened.state.title.as_deref(), Some("Parser fixes"));
}

#[tokio::test]
async fn an_agent_renames_its_own_thread_with_a_host_tool_even_headless() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    let run = client
        .connection
        .send(RunRequest {
            agent_id: "fake".to_owned(),
            cwd: world.cwd(),
            remote: None,
            thread_id: None,
            additional_directories: Vec::new(),
            mode: None,
            prompt: vec![ContentBlock::from(
                r#"tool rename_thread {"title": "Named by its agent"}"#.to_owned(),
            )],
            policy: PermissionPolicy {
                approve: Vec::new(),
                otherwise: Unapproved::Reject,
            },
            attach: true,
            trace: false,
            key: None,
            caller: None,
            origin: None,
            labels: Vec::new(),
        })
        .await
        .expect("thread/run");
    let mut seen = Seen::default();
    client.until_turn_ends(&mut seen, None).await;
    assert_eq!(seen.renamed, [("Named by its agent".to_owned(), None)]);
    assert!(
        seen.agent
            .contains("rename_thread answered: Renamed this thread to “Named by its agent”."),
        "{seen:?}"
    );
    assert_eq!(
        run.state.map(|state| state.thread_id),
        Some(run.thread_id.clone())
    );

    // An empty title is the agent's mistake, told it as a tool error.
    let thread_id = run.thread_id;
    client
        .prompt(&thread_id, r#"tool rename_thread {"title": " "}"#)
        .await;
    let mut seen = Seen::default();
    client.until_turn_ends(&mut seen, None).await;
    assert!(
        seen.agent
            .contains("rename_thread failed: Not renamed: a title can't be empty."),
        "{seen:?}"
    );

    // Configured off, it isn't offered.
    let config = world.dir.path().join("config.toml");
    let text = std::fs::read_to_string(&config).expect("config");
    std::fs::write(&config, format!("host_tools = []\n{text}")).expect("config");
    let other = client.create(&world).await;
    client
        .prompt(&other, r#"tool rename_thread {"title": "Not offered"}"#)
        .await;
    let mut seen = Seen::default();
    client.until_turn_ends(&mut seen, None).await;
    assert!(
        seen.agent.starts_with("rename_thread couldn't be called")
            && seen.agent.contains("unknown tool: rename_thread"),
        "{seen:?}"
    );
    assert!(seen.renamed.is_empty());
}

fn path_text(path: &Path) -> &str {
    path.to_str().expect("a UTF-8 path")
}

#[tokio::test]
async fn a_thread_in_a_worktree_says_its_repository_and_branch_and_lists_by_repository() {
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
    let thread_id = {
        let daemon = world.daemon(true, Duration::from_secs(60));
        let mut client = world.client(&daemon).await;
        let state = client.thread_in(&world, &worktree.join("src")).await;
        assert_eq!(state.git.as_ref(), Some(&expected));
        let elsewhere = client.thread_in(&world, &world.cwd()).await;
        assert_eq!(elsewhere.git, None);

        // Any directory in the repository names it, another worktree included.
        let listed = client.in_repository(&worktree).await;
        assert_eq!(
            listed
                .iter()
                .map(|listing| (&listing.info.session_id, listing.git.as_ref()))
                .collect::<Vec<_>>(),
            [(&state.thread_id, Some(&expected))]
        );
        // Only the Host's own listing goes by repository.
        let refused = client
            .connection
            .send(ListThreadsRequest {
                agent_id: Some("fake".to_owned()),
                repo: Some(repo.clone()),
                ..ListThreadsRequest::default()
            })
            .await;
        assert!(refused.is_err(), "{refused:?}");
        let outside = client
            .connection
            .send(ListThreadsRequest {
                repo: Some(world.cwd()),
                ..ListThreadsRequest::default()
            })
            .await;
        assert!(
            outside
                .as_ref()
                .is_err_and(|error| errors::is(error, errors::NOT_A_REPOSITORY)),
            "{outside:?}"
        );
        daemon.shutdown().await;
        state.thread_id
    };

    // A later Host has it from the journal.
    let daemon = world.daemon(true, Duration::from_secs(60));
    let client = world.client(&daemon).await;
    let listed = client.in_repository(&repo).await;
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].info.session_id, thread_id);
    assert_eq!(listed[0].git.as_ref(), Some(&expected));
}

#[tokio::test]
async fn a_thread_says_the_branch_its_worktree_switched_to_once_a_turn_ends() {
    let world = World::new();
    let repo = world.repository();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    let state = client.thread_in(&world, &repo).await;
    assert_eq!(
        state.git.as_ref().and_then(|git| git.branch.as_deref()),
        Some("main")
    );

    git(&repo, &["switch", "-q", "-c", "feature/next"]);
    client.prompt(&state.thread_id, "hello again").await;
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
    .expect("the thread's new branch in time");
    assert_eq!(changed.branch.as_deref(), Some("feature/next"));
    let listed = client.in_repository(&repo).await;
    assert_eq!(
        listed[0].git.as_ref().and_then(|git| git.branch.as_deref()),
        Some("feature/next")
    );
}

#[tokio::test]
async fn a_client_makes_a_worktree_beside_the_repository_and_starts_a_thread_in_it() {
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
    let state = client.thread_in(&world, &created.path).await;
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
async fn worktrees_list_with_their_status_and_the_threads_in_each() {
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
    let in_primary = client.thread_in(&world, &repo).await.thread_id;
    let in_worktree = client.thread_in(&world, &worktree).await.thread_id;
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
                threads: vec![in_primary],
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
                threads: vec![in_worktree],
            },
        ]
    );
}

#[tokio::test]
async fn removing_a_worktree_waits_for_its_threads_and_keeps_what_isnt_merged() {
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
    let thread_id = client.thread_in(&world, &worktree).await.thread_id;

    // Neither removing nor releasing it goes ahead while a request in its thread waits.
    let target = worktree.join("out.txt");
    client
        .prompt(&thread_id, &format!("write {} hello", target.display()))
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
        .allow(&thread_id, &asked, "allow")
        .await
        .expect("answered");
    client.until_turn_ends(&mut Seen::default(), None).await;

    // What the turn wrote isn't committed, so it goes only by force, leaving the thread open.
    let changed = client.connection.send(remove(&worktree, false)).await;
    assert!(
        changed
            .as_ref()
            .is_err_and(|error| errors::is(error, errors::UNCOMMITTED_CHANGES)),
        "{changed:?}"
    );
    assert_eq!(
        client.in_repository(&repo).await[0].state,
        ThreadStatus::Open
    );
    let removed = client
        .connection
        .send(remove(&worktree, true))
        .await
        .expect("worktrees/remove");
    assert_eq!(
        removed,
        RemoveWorktreeResponse {
            closed: vec![thread_id.clone()],
            branch: Some("merged".to_owned()),
            // Its branch adds nothing to main, so it goes too.
            branch_deleted: true,
        }
    );
    assert!(!worktree.exists());
    assert_eq!(git(&repo, &["branch", "--list", "merged"]), "");
    // The thread is closed, not forgotten.
    assert_eq!(
        client.in_repository(&repo).await[0].state,
        ThreadStatus::Closed
    );
    assert!(world.has_journal(&thread_id));

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
    let idle = client.thread_in(&world, &unmerged).await.thread_id;
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
    let thread_id = first.create(&world).await;
    let second = world.client(&daemon).await;

    // Adding to an idle thread starts a turn at once.
    let started = first.queue(&thread_id, "slow 3").await;
    assert!(started.started);
    // Added while that turn runs, by another client that isn't attached, it waits.
    let queued = second.queue(&thread_id, "and then this").await;
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
    let attached = first.attach(&thread_id).await;
    assert!(attached.state.queue.is_empty());
}

#[tokio::test]
async fn attached_clients_share_one_queue_and_removing_a_prompt_removes_it_for_both() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let mut first = world.client(&daemon).await;
    let thread_id = first.create(&world).await;
    first.queue(&thread_id, "slow 4").await;
    let kept = first.queue(&thread_id, "kept").await;
    let mut second = world.client(&daemon).await;
    let attached = second.attach(&thread_id).await;
    let ids: Vec<&str> = attached.state.queue.iter().map(|q| q.id.as_str()).collect();
    assert_eq!(
        ids,
        [kept.queued_id.as_str()],
        "a later client sees the queue"
    );
    assert_eq!(attached.state.queue[0].origin, own_origin(&first));

    let dropped = second.queue(&thread_id, "dropped").await;
    let removed = first
        .connection
        .send(RemoveQueuedRequest {
            thread_id: thread_id.clone(),
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
            thread_id: thread_id.clone(),
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
    let thread_id = client.create(&world).await;
    client.queue(&thread_id, "slow 20").await;
    let waiting = client.queue(&thread_id, "after the cancel").await;
    client
        .connection
        .send(CancelTurnRequest {
            thread_id: thread_id.clone(),
        })
        .await
        .expect("turn/cancel");
    let mut seen = Seen::default();
    client.until_turn_ends(&mut seen, None).await;
    client.until_paused(&mut seen).await;
    assert_eq!(seen.ended, Some(StopReason::Cancelled));
    assert_eq!(seen.paused, [QueuePause::Cancelled]);
    let attached = world.client(&daemon).await.attach(&thread_id).await;
    assert_eq!(attached.state.queue_paused, Some(QueuePause::Cancelled));
    assert_eq!(attached.state.queue.len(), 1);
    assert_eq!(attached.state.activity, Activity::Idle, "nothing started");

    client
        .connection
        .send(ResumeQueueRequest {
            thread_id: thread_id.clone(),
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

    // Adding to a paused queue resumes it, oldest first; so does prompting the thread.
    client.queue(&thread_id, "slow 20").await;
    let older = client.queue(&thread_id, "older").await;
    client
        .connection
        .send(CancelTurnRequest {
            thread_id: thread_id.clone(),
        })
        .await
        .expect("turn/cancel");
    let mut seen = Seen::default();
    client.until_turn_ends(&mut seen, None).await;
    client.until_paused(&mut seen).await;
    let newer = client.queue(&thread_id, "newer").await;
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
            .expect("thread/run");
        let headless = run.thread_id;
        client.queue(&headless, "headless next").await;
        daemon.shutdown().await;
        (interactive, (headless, waiting.queued_id))
    };
    let (headless, waiting) = headless;

    let daemon = world.daemon(true, Duration::from_secs(60));
    daemon.resume_queues().await;
    let mut client = world.client(&daemon).await;
    // The headless thread's queue ran without anyone.
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
            thread_id: interactive.clone(),
        })
        .await
        .expect("queue/resume");
    let mut seen = Seen::default();
    while !seen.agent.contains("You said: still here") {
        client.until_turn_ends(&mut seen, None).await;
    }
}

#[tokio::test]
async fn a_turn_the_host_stopped_under_is_interrupted_and_a_headless_one_continued_once() {
    let world = World::new();
    let (interactive, headless, cut) = {
        let daemon = world.daemon(true, Duration::from_secs(60));
        let mut client = world.client(&daemon).await;
        let interactive = client.create(&world).await;
        client.queue(&interactive, "slow 50").await;
        let run = client
            .connection
            .send(RunRequest {
                prompt: vec![ContentBlock::from("slow 50".to_owned())],
                ..run_request(&world, &world.cwd().join("unused"), Vec::new())
            })
            .await
            .expect("thread/run");
        daemon.shutdown().await;
        (
            interactive,
            run.thread_id,
            run.turn_id.expect("the run's turn"),
        )
    };
    let latest = async |daemon: &Daemon, thread_id: &ThreadId, turn_id: Option<&str>| {
        let client = world.client(daemon).await;
        client
            .connection
            .send(GetThreadRequest {
                thread_id: thread_id.clone(),
                turn_id: turn_id.map(str::to_owned),
            })
            .await
            .expect("threads/get")
            .latest_turn
            .expect("a turn")
    };

    // The headless thread's turn was interrupted, and a turn from its origin continues it.
    let daemon = world.daemon(true, Duration::from_secs(60));
    daemon.resume_queues().await;
    let interrupted = latest(&daemon, &headless, Some(&cut)).await;
    assert_eq!(interrupted.state, TurnState::Interrupted);
    assert!(
        interrupted
            .error
            .as_ref()
            .is_some_and(|error| errors::is(error, errors::INTERRUPTED)),
        "{interrupted:?}"
    );
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let continued = loop {
        let turn = latest(&daemon, &headless, None).await;
        if turn.continues.is_some() && turn.state.is_over() {
            break turn;
        }
        assert!(tokio::time::Instant::now() < deadline, "{turn:?}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    assert_eq!(continued.continues.as_deref(), Some(cut.as_str()));
    assert_eq!(continued.state, TurnState::Ended);
    // The interrupted turn names its successor, journaled with its end.
    let interrupted = latest(&daemon, &headless, Some(&cut)).await;
    assert_eq!(interrupted.continued_in, continued.turn_id);
    assert_eq!(continued.origin, TurnOrigin::Run {});
    let prompt: String = continued
        .prompt
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text(text) => Some(text.text.as_str()),
            _ => None,
        })
        .collect();
    assert!(prompt.contains("cut off"), "{prompt}");

    // The interactive one's waits for a person.
    let mut client = world.client(&daemon).await;
    let attached = client.attach(&interactive).await;
    assert!(attached.state.turns.is_empty());
    let turn = latest(&daemon, &interactive, None).await;
    assert_eq!(turn.state, TurnState::Interrupted);
    assert_eq!(turn.continues, None);
    client.connection.shutdown().await;
    daemon.shutdown().await;

    // A continuation the Host stops under, as a turn that brought it down would, isn't
    // continued again.
    let id = headless.to_string();
    let journal = std::fs::read_dir(world.journals())
        .expect("the journals")
        .flatten()
        .map(|entry| entry.path())
        .find(|path| {
            std::fs::read_to_string(path).is_ok_and(|text| {
                text.lines()
                    .next()
                    .is_some_and(|header| header.contains(&id))
            })
        })
        .expect("the headless thread's journal");
    let text = std::fs::read_to_string(&journal).expect("the journal");
    let lines: Vec<&str> = text.lines().collect();
    let cut_off = lines
        .iter()
        .position(|line| line.contains(r#""type":"turnEnded""#))
        .expect("the interrupted turn's end");
    assert!(
        lines[cut_off + 1].contains(r#""type":"turnStarted""#)
            && lines[cut_off + 1].contains(&format!(r#""continues":"{cut}""#)),
        "the continuation starts with the interrupted turn's end: {}",
        lines[cut_off + 1]
    );
    let end = lines
        .iter()
        .rposition(|line| line.contains(r#""type":"turnEnded""#))
        .expect("the continuation's end");
    std::fs::write(&journal, format!("{}\n", lines[..end].join("\n"))).expect("the journal");
    let daemon = world.daemon(true, Duration::from_secs(60));
    daemon.resume_queues().await;
    let turn = latest(&daemon, &headless, None).await;
    assert_eq!(turn.state, TurnState::Interrupted);
    assert_eq!(turn.continues.as_deref(), Some(cut.as_str()));
    tokio::time::sleep(Duration::from_millis(200)).await;
    let still = latest(&daemon, &headless, None).await;
    assert_eq!(still.turn_id, turn.turn_id, "nothing continued it");
}

#[tokio::test]
async fn a_closed_threads_queue_carries_on_into_its_new_journal() {
    let world = World::new();
    let daemon = world.daemon(true, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    let thread_id = client.create(&world).await;
    client.queue(&thread_id, "slow 50").await;
    let waiting = client.queue(&thread_id, "carried").await;
    client
        .connection
        .send(CloseThreadRequest {
            thread_id: thread_id.clone(),
        })
        .await
        .expect("thread/close");
    let attached = client.attach(&thread_id).await;
    assert!(attached.replay.reset, "a new journal");
    assert_eq!(attached.state.queue_paused, Some(QueuePause::Interrupted));
    let ids: Vec<&str> = attached.state.queue.iter().map(|q| q.id.as_str()).collect();
    assert_eq!(ids, [waiting.queued_id.as_str()]);
}

#[tokio::test]
async fn a_repeated_keyed_request_answers_as_the_first_and_starts_nothing_even_after_a_restart() {
    let world = World::new();
    let (thread_id, first_turn, first_queued, first_run) = {
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
        let thread_id = client.create(&world).await;
        let turn = StartTurnRequest {
            thread_id: thread_id.clone(),
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
            .queue_keyed(&thread_id, "queued once", Some("queue-1"))
            .await
            .expect("queue/add");
        let repeat = client
            .queue_keyed(&thread_id, "queued once", Some("queue-1"))
            .await
            .expect("repeat");
        assert_eq!(repeat, queued);
        // The same key for another request is refused.
        let reused = client
            .queue_keyed(&thread_id, "something else", Some("queue-1"))
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
            .expect("thread/run");
        let rerun = client.connection.send(run).await.expect("repeat");
        assert_eq!(rerun.thread_id, ran.thread_id);
        // A repeat names the turn the first started, so its caller can follow it.
        assert!(first.turn_id.is_some() && ran.turn_id.is_some());
        assert_eq!(rerun.turn_id, ran.turn_id);
        daemon.shutdown().await;
        (thread_id, first, queued, ran.thread_id)
    };

    let daemon = world.daemon(true, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    client.attach_caught_up(&thread_id).await;
    let again = client
        .connection
        .send(StartTurnRequest {
            thread_id: thread_id.clone(),
            prompt: vec![ContentBlock::from("slow 3".to_owned())],
            key: Some("turn-1".to_owned()),
        })
        .await
        .expect("repeat after a restart");
    assert_eq!(again, first_turn);
    let queued = client
        .queue_keyed(&thread_id, "queued once", Some("queue-1"))
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
    assert_eq!(rerun.thread_id, first_run);
    // Nothing started: the thread is idle, and its journal has the two turns it had.
    let listing = client
        .connection
        .send(ListThreadsRequest::default())
        .await
        .expect("list");
    let thread = listing
        .threads
        .iter()
        .find(|listing| listing.info.session_id == thread_id)
        .expect("listed");
    assert_eq!(thread.activity, Some(Activity::Idle));
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
    let thread_id = client.create(&world).await;
    let first = client.queue(&thread_id, "slow 3").await;
    let second = client.queue(&thread_id, "and then this").await;
    let read = async |client: &TestClient, turn_id: &str| {
        client
            .connection
            .send(GetThreadRequest {
                thread_id: thread_id.clone(),
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
    // A running turn is named in the thread's state, and only open threads running one list
    // as running.
    let attached = client.attach(&thread_id).await;
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
            .send(ListThreadsRequest {
                activity: Some(activity),
                ..ListThreadsRequest::default()
            })
            .await
            .expect("threads/list")
            .threads
            .into_iter()
            .map(|listing| listing.info.session_id)
            .collect::<Vec<_>>()
    };
    assert_eq!(
        doing(&client, Activity::Running).await,
        std::slice::from_ref(&thread_id)
    );
    assert!(doing(&client, Activity::Idle).await.is_empty());
    let refused = client
        .connection
        .send(ListThreadsRequest {
            agent_id: Some("fake".to_owned()),
            activity: Some(Activity::Idle),
            ..ListThreadsRequest::default()
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
        std::slice::from_ref(&thread_id)
    );

    // turn/start gives its turn an id of the Host's.
    let started = client
        .connection
        .send(StartTurnRequest {
            thread_id: thread_id.clone(),
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
            .get(&thread_id)
            .await
            .latest_turn
            .and_then(|latest| latest.turn_id),
        Some(turn_id)
    );
    let unknown = read(&client, "q-none").await.expect_err("no such turn");
    assert!(errors::is(&unknown, errors::UNKNOWN_TURN));

    // A closed thread's turns read from its journal.
    client
        .connection
        .send(CloseThreadRequest {
            thread_id: thread_id.clone(),
        })
        .await
        .expect("thread/close");
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
    let thread_id = client.create(&world).await;
    client
        .prompt(
            &thread_id,
            &format!("write {} never", world.cwd().join("never.txt").display()),
        )
        .await;
    client.asked(&mut Seen::default()).await;
    let latest = client.get(&thread_id).await.latest_turn.expect("a turn");
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
    let (thread_id, first) = {
        let daemon = world.daemon(true, Duration::from_secs(60));
        let mut client = world.client(&daemon).await;
        let thread_id = client.create(&world).await;
        let first = client
            .connection
            .send(StartTurnRequest {
                thread_id: thread_id.clone(),
                prompt: vec![ContentBlock::from("hello".to_owned())],
                key: Some("lost-answer".to_owned()),
            })
            .await
            .expect("turn/start");
        client.until_turn_ends(&mut Seen::default(), None).await;
        daemon.shutdown().await;
        (thread_id, first)
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
    client.attach_caught_up(&thread_id).await;
    let again = client
        .connection
        .send(StartTurnRequest {
            thread_id: thread_id.clone(),
            prompt: vec![ContentBlock::from("hello".to_owned())],
            key: Some("lost-answer".to_owned()),
        })
        .await
        .expect("repeat");
    assert_eq!(again, first);
    assert!(!client.hears_a_turn_start().await);
}

impl TestClient {
    /// Attach to `thread_id` and read its replay through, so what comes next is new.
    async fn attach_caught_up(&mut self, thread_id: &ThreadId) {
        let head = self.attach(thread_id).await.state.journal.head;
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

    /// Whether a turn starts in an attached thread within a moment.
    async fn hears_a_turn_start(&mut self) -> bool {
        tokio::time::timeout(Duration::from_millis(400), async {
            loop {
                if let HostEvent::Event(event) = self.next().await
                    && matches!(event.event, ThreadEvent::TurnStarted { .. })
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

/// A thread's id in a tool's JSON answer.
fn answered_thread(agent: &str, tool: &str) -> ThreadId {
    let answer = tool_answer(agent, tool);
    ThreadId::new(
        answer["threadId"]
            .as_str()
            .unwrap_or_else(|| panic!("a threadId in {answer}"))
            .to_owned(),
    )
}

impl TestClient {
    /// Run `tool` with `arguments` in `thread_id`'s agent, through the fake agent's `tool`
    /// script; what this client saw of that turn.
    async fn call_tool(&mut self, thread_id: &ThreadId, tool: &str, arguments: &str) -> Seen {
        self.prompt(thread_id, &format!("tool {tool} {arguments}"))
            .await;
        let mut seen = Seen::default();
        self.until_turn_ends(&mut seen, None).await;
        seen
    }

    /// Events until a message from the Host about another thread reaches this one: as a turn
    /// it starts or a steer into its turn. Its text.
    async fn told(&mut self, seen: &mut Seen) -> String {
        loop {
            let said = seen
                .origins
                .iter()
                .any(|(origin, _)| matches!(origin, TurnOrigin::Thread { .. }));
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

    async fn get(&self, thread_id: &ThreadId) -> GetThreadResponse {
        self.connection
            .send(GetThreadRequest {
                thread_id: thread_id.clone(),
                turn_id: None,
            })
            .await
            .expect("threads/get")
    }
}

#[tokio::test]
async fn an_agent_starts_a_thread_with_another_agent_and_hears_how_its_turn_ended() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    let caller = client.create(&world).await;
    let mut started = client
        .call_tool(
            &caller,
            "start_thread",
            r#"{"agentId": "other", "prompt": "slow 3"}"#,
        )
        .await;
    let said = started.agent.clone();
    let delegated = answered_thread(&said, "start_thread");
    assert_ne!(delegated, caller);
    // Without a policy asked for, it runs under the caller's.
    assert_eq!(
        tool_answer(&said, "start_thread")["policy"],
        serde_json::to_value(PermissionPolicy::ask()).expect("json")
    );

    // It's a thread of its own, which says who started it.
    let got = client.get(&delegated).await;
    assert_eq!(got.thread.agent_id, "other");
    assert_eq!(got.thread.started_by.as_ref(), Some(&caller));
    let latest = got.latest_turn.expect("a turn");
    assert_eq!(
        latest.origin,
        TurnOrigin::Thread {
            thread_id: caller.clone(),
            report: false,
            host: None,
            host_name: None,
        }
    );
    let listed = client
        .connection
        .send(ListThreadsRequest::default())
        .await
        .expect("threads/list");
    let listing = listed
        .threads
        .iter()
        .find(|listing| listing.info.session_id == delegated)
        .expect("listed");
    assert_eq!(listing.started_by.as_ref(), Some(&caller));

    // Its turn's end reaches the caller, from the delegated thread, with what its agent said.
    let told = client.told(&mut started).await;
    assert!(told.contains("finished its turn"), "{told}");
    assert!(told.contains("Chunk 3 of 3."), "{told}");
    assert!(told.contains(&delegated.to_string()), "{told}");
    // The message's own turn tells the delegated thread nothing back: no turns go to and fro.
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
        Some(TurnOrigin::Thread {
            thread_id: caller.clone(),
            report: false,
            host: None,
            host_name: None,
        })
    );
    assert!(seen.agent.contains("Chunk 3 of 3."));
}

#[tokio::test]
async fn a_delegated_thread_approves_no_more_than_the_thread_that_started_it() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    let caller = client
        .connection
        .send(CreateThreadRequest {
            policy: Some(PermissionPolicy {
                approve: vec![ToolKind::Read],
                otherwise: Unapproved::Ask,
            }),
            ..TestClient::create_request(&world, "fake")
        })
        .await
        .expect("thread/create")
        .thread_id;
    let said = client
        .call_tool(
            &caller,
            "start_thread",
            r#"{"agentId": "other", "prompt": "hello", "approve": ["read", "edit", "execute"], "otherwise": "reject"}"#,
        )
        .await
        .agent;
    let delegated = answered_thread(&said, "start_thread");
    let narrowed = PermissionPolicy::headless(vec![ToolKind::Read]);
    assert_eq!(
        tool_answer(&said, "start_thread")["policy"],
        serde_json::to_value(&narrowed).expect("json")
    );
    let attached = world.client(&daemon).await.attach(&delegated).await;
    assert_eq!(attached.state.policy, narrowed);
    assert_eq!(attached.state.started_by.as_ref(), Some(&caller));
}

#[tokio::test]
async fn an_agent_reads_and_acts_on_any_thread_and_hears_how_its_turn_there_ended() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    let caller = client.create(&world).await;
    let mut person = world.client(&daemon).await;
    let persons = person.thread_in(&world, &world.cwd()).await.thread_id;

    // Reading answers as threads/get does.
    let said = client
        .call_tool(
            &caller,
            "read_thread",
            &format!(r#"{{"threadId": "{persons}"}}"#),
        )
        .await
        .agent;
    let got = client.get(&persons).await;
    assert_eq!(
        tool_answer(&said, "read_thread"),
        serde_json::to_value(&got).expect("json")
    );
    assert_eq!(
        got.latest_turn.and_then(|turn| turn.message).as_deref(),
        Some("You said: hello")
    );
    let said = client
        .call_tool(&caller, "list_threads", r#"{}"#)
        .await
        .agent;
    let listed = tool_answer(&said, "list_threads");
    assert!(
        listed["threads"].as_array().is_some_and(|threads| threads
            .iter()
            .any(|thread| thread["info"]["sessionId"] == persons.to_string())),
        "{listed}"
    );

    // It steers a turn the person began in a thread it didn't start; the steer takes the turn
    // over, which ends once it's answered.
    person.prompt(&persons, "slow 30").await;
    let said = client
        .call_tool(
            &caller,
            "steer_thread",
            &format!(r#"{{"threadId": "{persons}", "prompt": "and the docs"}}"#),
        )
        .await
        .agent;
    assert!(said.contains("steer_thread answered:"), "{said}");
    let mut seen = Seen::default();
    person.until_turn_ends(&mut seen, None).await;
    assert!(seen.agent.contains("You steered: and the docs"), "{seen:?}");

    // And it cancels one.
    person.prompt(&persons, "slow 30").await;
    let said = client
        .call_tool(
            &caller,
            "cancel_thread_turn",
            &format!(r#"{{"threadId": "{persons}"}}"#),
        )
        .await
        .agent;
    assert!(said.contains("cancel_thread_turn answered: {}"), "{said}");
    let mut seen = Seen::default();
    person.until_turn_ends(&mut seen, None).await;
    assert_eq!(seen.ended, Some(StopReason::Cancelled));

    // It prompts that thread, and hears how the turn it began there ended.
    let mut seen = client
        .call_tool(
            &caller,
            "prompt_thread",
            &format!(r#"{{"threadId": "{persons}", "prompt": "slow 3"}}"#),
        )
        .await;
    assert!(
        seen.agent.contains("prompt_thread answered:"),
        "{}",
        seen.agent
    );
    let latest = client.get(&persons).await.latest_turn.expect("a turn");
    assert_eq!(
        latest.origin,
        TurnOrigin::Thread {
            thread_id: caller.clone(),
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
        TurnOrigin::Thread {
            thread_id: persons.clone(),
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
            "start_thread",
            r#"{"agentId": "other", "prompt": "hello"}"#,
        )
        .await;
    let delegated = answered_thread(&seen.agent, "start_thread");
    client.told(&mut seen).await;

    // The delegated thread can't start one of its own.
    let mut other = world.client(&daemon).await;
    other.attach_caught_up(&delegated).await;
    let said = other
        .call_tool(
            &delegated,
            "start_thread",
            r#"{"agentId": "fake", "prompt": "hello"}"#,
        )
        .await
        .agent;
    assert!(
        said.contains("start_thread failed:") && said.contains("can't start threads"),
        "{said}"
    );

    // With it running, one is as many as this Host allows.
    let said = client
        .call_tool(
            &caller,
            "prompt_thread",
            &format!(r#"{{"threadId": "{delegated}", "prompt": "slow 30"}}"#),
        )
        .await
        .agent;
    assert!(said.contains("prompt_thread answered:"), "{said}");
    let said = client
        .call_tool(
            &caller,
            "start_thread",
            r#"{"agentId": "other", "prompt": "hello"}"#,
        )
        .await
        .agent;
    assert!(
        said.contains("start_thread failed:") && said.contains("already has 1 delegated thread"),
        "{said}"
    );

    // Cancelling its turn frees the room, and the caller hears it was cancelled.
    let mut seen = client
        .call_tool(
            &caller,
            "cancel_thread_turn",
            &format!(r#"{{"threadId": "{delegated}"}}"#),
        )
        .await;
    assert!(
        seen.agent.contains("cancel_thread_turn answered: {}"),
        "{}",
        seen.agent
    );
    let told = client.told(&mut seen).await;
    assert!(told.contains("had its turn cancelled"), "{told}");
}

#[tokio::test]
async fn a_thread_names_its_successor_once_and_listings_and_its_clients_carry_it() {
    let world = World::new();
    let daemon = world.daemon(true, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    let mut ids = Vec::new();
    for _ in 0..3 {
        let thread_id = client.create(&world).await;
        client.queue(&thread_id, "hello").await;
        client.until_turn_ends(&mut Seen::default(), None).await;
        ids.push(thread_id);
    }
    let [old, new, other] = [ids[0].clone(), ids[1].clone(), ids[2].clone()];
    let mut watcher = world.client(&daemon).await;
    watcher.attach(&old).await;
    let mut watching = world.client(&daemon).await;
    watching.watch().await;
    let set = async |thread_id: &ThreadId, successor: &ThreadId| {
        client
            .connection
            .send(SetSuccessorRequest {
                thread_id: thread_id.clone(),
                successor: successor.clone(),
            })
            .await
    };

    // Not itself, nor a thread the Host has no record of.
    let itself = set(&old, &old).await.expect_err("not itself");
    assert_eq!(itself.code, Error::invalid_params().code, "{itself:?}");
    let unknown = set(&old, &ThreadId::new("nowhere"))
        .await
        .expect_err("not an unknown thread");
    assert!(errors::is(&unknown, errors::UNKNOWN_THREAD), "{unknown:?}");

    // Named once: the same again does nothing, another is refused, and none leads back.
    set(&old, &new).await.expect("thread/setSuccessor");
    set(&old, &new).await.expect("the same again");
    let another = set(&old, &other).await.expect_err("named once");
    assert!(another.to_string().contains("named once"), "{another:?}");
    let back = set(&new, &old).await.expect_err("no cycle");
    assert!(
        back.to_string().contains("through its successors"),
        "{back:?}"
    );

    // Its clients hear of it, and its listing carries it.
    let mut seen = Seen::default();
    while seen.continued_in.is_empty() {
        let event = watcher.next().await;
        watcher.note(event, &mut seen, None).await;
    }
    assert_eq!(seen.continued_in, std::slice::from_ref(&new));
    // Watchers hear of it as a change to its listing.
    loop {
        if let Change::Updated(listing) = watching.change().await
            && listing.info.session_id == old
            && listing.continued_in.is_some()
        {
            assert_eq!(listing.continued_in, Some(new.clone()));
            break;
        }
    }
    assert_eq!(
        client.get(&old).await.thread.continued_in,
        Some(new.clone())
    );
    assert_eq!(client.get(&new).await.thread.continued_in, None);
    watcher.connection.shutdown().await;
    client.connection.shutdown().await;
    daemon.shutdown().await;

    // It outlasts the Host, and a closed thread's new journal.
    let daemon = world.daemon(true, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    assert_eq!(
        client.get(&old).await.thread.continued_in,
        Some(new.clone())
    );
    let attached = client.attach(&old).await;
    assert_eq!(attached.state.continued_in, Some(new.clone()));
    client
        .connection
        .send(CloseThreadRequest {
            thread_id: old.clone(),
        })
        .await
        .expect("thread/close");
    let attached = client.attach(&old).await;
    assert_eq!(attached.state.continued_in, Some(new));
}

#[tokio::test]
async fn threads_carry_labels_from_their_start_and_listings_filter_by_them() {
    let world = World::new();
    let daemon = world.daemon(true, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    let labels = |labels: &[&str]| labels.iter().map(|label| (*label).to_owned()).collect();

    // Labels a thread starts with are checked.
    let bad = client
        .connection
        .send(CreateThreadRequest {
            labels: labels(&["has space"]),
            ..TestClient::create_request(&world, "fake")
        })
        .await
        .expect_err("not a label");
    assert_eq!(bad.code, Error::invalid_params().code, "{bad:?}");
    let bot = client
        .connection
        .send(CreateThreadRequest {
            labels: labels(&["bot:daily"]),
            ..TestClient::create_request(&world, "fake")
        })
        .await
        .expect("thread/create");
    assert_eq!(bot.labels, labels(&["bot:daily"]));
    let bot = bot.thread_id;
    client.queue(&bot, "hello").await;
    client.until_turn_ends(&mut Seen::default(), None).await;
    let run = client
        .connection
        .send(RunRequest {
            labels: labels(&["dispatcher"]),
            ..run_request(&world, &world.cwd().join("unused"), Vec::new())
        })
        .await
        .expect("thread/run")
        .thread_id;
    let plain = client.create(&world).await;
    client.queue(&plain, "hello").await;
    client.until_turn_ends(&mut Seen::default(), None).await;

    // Listings carry them, and filter by every label asked for.
    let listed = async |client: &TestClient, wanted: &[&str]| {
        let mut ids: Vec<ThreadId> = client
            .connection
            .send(ListThreadsRequest {
                labels: labels(wanted),
                ..ListThreadsRequest::default()
            })
            .await
            .expect("threads/list")
            .threads
            .into_iter()
            .map(|listing| listing.info.session_id)
            .collect();
        ids.sort_by_key(ToString::to_string);
        ids
    };
    assert_eq!(
        listed(&client, &["bot:daily"]).await,
        std::slice::from_ref(&bot)
    );
    assert_eq!(
        listed(&client, &["dispatcher"]).await,
        std::slice::from_ref(&run)
    );
    assert!(
        listed(&client, &["bot:daily", "dispatcher"])
            .await
            .is_empty()
    );
    assert_eq!(listed(&client, &[]).await.len(), 3);
    let with_agent = client
        .connection
        .send(ListThreadsRequest {
            agent_id: Some("fake".to_owned()),
            labels: labels(&["bot:daily"]),
            ..ListThreadsRequest::default()
        })
        .await
        .expect_err("labels only without an agent");
    assert_eq!(with_agent.code, Error::invalid_params().code);

    // A watcher for a label hears of the threads that carry it, and of one that stops
    // carrying it once more.
    let mut watching = world.client(&daemon).await;
    let watched = watching
        .connection
        .send(WatchThreadsRequest {
            labels: labels(&["bot:daily"]),
        })
        .await
        .expect("threads/watch")
        .threads;
    assert_eq!(watched.len(), 1);
    let mut attached = world.client(&daemon).await;
    attached.attach(&plain).await;
    let label = async |thread_id: &ThreadId, add: &[&str], remove: &[&str]| {
        client
            .connection
            .send(LabelThreadRequest {
                thread_id: thread_id.clone(),
                add: labels(add),
                remove: labels(remove),
            })
            .await
    };
    let after = label(&plain, &["bot:daily", "keep"], &[])
        .await
        .expect("thread/label");
    assert_eq!(after.labels, labels(&["bot:daily", "keep"]));
    let updated = loop {
        if let Change::Updated(listing) = watching.change().await {
            break listing;
        }
    };
    assert_eq!(updated.info.session_id, plain);
    let after = label(&plain, &[], &["bot:daily"])
        .await
        .expect("thread/label");
    assert_eq!(after.labels, labels(&["keep"]));
    let last = loop {
        if let Change::Updated(listing) = watching.change().await {
            break listing;
        }
    };
    assert_eq!(
        (last.info.session_id.clone(), last.labels.clone()),
        (plain.clone(), labels(&["keep"]))
    );
    // Past that, it hears nothing of the thread: the next it hears is of one it watches.
    client
        .connection
        .send(RenameThreadRequest {
            thread_id: plain.clone(),
            title: "Not watched".to_owned(),
        })
        .await
        .expect("thread/rename");
    label(&bot, &["more"], &[]).await.expect("thread/label");
    let next = loop {
        if let Change::Updated(listing) = watching.change().await {
            break listing;
        }
    };
    assert_eq!(next.info.session_id, bot);

    // Attached clients see each change; labels are checked, and a thread carries few.
    let mut seen = Seen::default();
    while seen.labelled.len() < 2 {
        let event = attached.next().await;
        attached.note(event, &mut seen, None).await;
    }
    assert_eq!(
        seen.labelled,
        [labels(&["bot:daily", "keep"]), labels(&["keep"])]
    );
    let bad = label(&plain, &["no spaces please"], &[])
        .await
        .expect_err("not a label");
    assert_eq!(bad.code, Error::invalid_params().code);
    let many: Vec<String> = (0..MAX_LABELS).map(|n| format!("l{n}")).collect();
    let too_many = client
        .connection
        .send(LabelThreadRequest {
            thread_id: plain.clone(),
            add: many,
            remove: Vec::new(),
        })
        .await
        .expect_err("too many");
    assert!(too_many.to_string().contains("at most"), "{too_many:?}");
    for connected in [watching, attached, client] {
        connected.connection.shutdown().await;
    }
    daemon.shutdown().await;

    // They outlast the Host, and a closed thread's new journal.
    let daemon = world.daemon(true, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    assert_eq!(client.get(&plain).await.thread.labels, labels(&["keep"]));
    client.attach(&bot).await;
    client
        .connection
        .send(CloseThreadRequest {
            thread_id: bot.clone(),
        })
        .await
        .expect("thread/close");
    let attached = client.attach(&bot).await;
    assert_eq!(attached.state.labels, labels(&["bot:daily", "more"]));
}

#[tokio::test]
async fn listings_carry_context_usage_and_the_last_compaction() {
    let world = World::new();
    let thread_id = {
        let daemon = world.daemon(true, Duration::from_secs(60));
        let mut client = world.client(&daemon).await;
        let thread_id = client.create(&world).await;
        client.queue(&thread_id, "hello").await;
        client.until_turn_ends(&mut Seen::default(), None).await;
        let listed = client.get(&thread_id).await.thread;
        let context = listed.context.expect("its usage");
        assert_eq!(context.size, 200_000);
        assert!(context.used > 0, "{context:?}");
        assert_eq!(listed.last_compaction, None);

        // A watcher hears of a compaction, and then of what it left.
        let mut watching = world.client(&daemon).await;
        watching.watch().await;
        client.queue(&thread_id, "compact").await;
        let compacted = loop {
            if let Change::Updated(listing) = watching.change().await
                && let Some(last) = listing.last_compaction
                && last.used.is_some()
            {
                break last;
            }
        };
        let listed = client.get(&thread_id).await.thread;
        assert_eq!(listed.last_compaction, Some(compacted));
        watching.connection.shutdown().await;
        client.connection.shutdown().await;
        daemon.shutdown().await;
        thread_id
    };

    // They outlast the Host, suspended and taken up again.
    let daemon = world.daemon(true, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    let suspended = client.get(&thread_id).await.thread;
    assert!(suspended.context.is_some());
    assert!(suspended.last_compaction.is_some());
    client.attach(&thread_id).await;
    let open = client.get(&thread_id).await.thread;
    assert_eq!(open.state, ThreadStatus::Open);
    assert_eq!(open.last_compaction, suspended.last_compaction);
    assert_eq!(open.context, suspended.context);

    // And a closed thread's new journal.
    client
        .connection
        .send(CloseThreadRequest {
            thread_id: thread_id.clone(),
        })
        .await
        .expect("thread/close");
    client.attach(&thread_id).await;
    let reopened = client.get(&thread_id).await.thread;
    assert_eq!(reopened.last_compaction, suspended.last_compaction);
}

#[tokio::test]
async fn a_labelled_threads_journal_outlasts_pruning() {
    let world = World::new();
    let (labelled, plain) = {
        let daemon = world.daemon(true, Duration::from_secs(60));
        let mut client = world.client(&daemon).await;
        let mut ids = Vec::new();
        for labels in [vec!["bot:daily".to_owned()], Vec::new()] {
            let state = client
                .connection
                .send(CreateThreadRequest {
                    labels,
                    ..TestClient::create_request(&world, "fake")
                })
                .await
                .expect("thread/create");
            client.queue(&state.thread_id, "hello").await;
            client.until_turn_ends(&mut Seen::default(), None).await;
            client
                .connection
                .send(CloseThreadRequest {
                    thread_id: state.thread_id.clone(),
                })
                .await
                .expect("thread/close");
            ids.push(state.thread_id);
        }
        client.connection.shutdown().await;
        daemon.shutdown().await;
        (ids[0].clone(), ids[1].clone())
    };
    // Both untouched for longer than journals are kept.
    let long_ago = std::time::SystemTime::now() - Duration::from_secs(30 * 24 * 60 * 60);
    for entry in std::fs::read_dir(world.journals())
        .expect("the journals")
        .flatten()
    {
        std::fs::File::options()
            .write(true)
            .open(entry.path())
            .and_then(|file| file.set_modified(long_ago))
            .expect("backdate");
    }

    let daemon = world.daemon(true, Duration::from_secs(60));
    let client = world.client(&daemon).await;
    assert_eq!(
        client.get(&labelled).await.thread.labels,
        ["bot:daily".to_owned()]
    );
    let gone = client
        .connection
        .send(GetThreadRequest {
            thread_id: plain,
            turn_id: None,
        })
        .await
        .expect_err("pruned");
    assert!(errors::is(&gone, errors::UNKNOWN_THREAD), "{gone:?}");
}

#[tokio::test]
async fn a_report_to_a_thread_goes_to_its_successor() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    let caller = client.create(&world).await;
    let successor = client.create(&world).await;
    let started = client
        .call_tool(
            &caller,
            "start_thread",
            r#"{"agentId": "other", "prompt": "slow 5"}"#,
        )
        .await;
    let delegated = answered_thread(&started.agent, "start_thread");
    client
        .connection
        .send(SetSuccessorRequest {
            thread_id: caller.clone(),
            successor: successor.clone(),
        })
        .await
        .expect("thread/setSuccessor");

    // The delegated turn's end reaches the successor, where the caller's work goes on.
    let mut watcher = world.client(&daemon).await;
    watcher.attach(&successor).await;
    let mut seen = Seen::default();
    let told = watcher.told(&mut seen).await;
    assert!(told.contains("finished its turn"), "{told}");
    assert!(told.contains(&delegated.to_string()), "{told}");
    let latest = client.get(&caller).await.latest_turn.expect("a turn");
    assert!(
        !matches!(latest.origin, TurnOrigin::Thread { report: true, .. }),
        "{latest:?}"
    );
}

#[tokio::test]
async fn the_caller_is_told_when_a_delegated_thread_waits_on_a_person() {
    let world = World::new();
    let daemon = world.daemon(false, Duration::from_secs(60));
    let mut client = world.client(&daemon).await;
    let caller = client.create(&world).await;
    let path = world.cwd().join("delegated.txt");
    // Told while its own turn still runs, or after.
    let mut seen = client
        .call_tool(
            &caller,
            "start_thread",
            &format!(
                r#"{{"agentId": "other", "prompt": "write {} written"}}"#,
                path.display()
            ),
        )
        .await;
    let delegated = answered_thread(&seen.agent, "start_thread");
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
            "start_thread",
            r#"{"agentId": "other", "prompt": "slow 5"}"#,
        )
        .await
        .agent;
    let delegated = answered_thread(&said, "start_thread");
    client
        .connection
        .send(CloseThreadRequest {
            thread_id: caller.clone(),
        })
        .await
        .expect("thread/close");
    let from_delegated = TurnOrigin::Thread {
        thread_id: delegated.clone(),
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
            thread_id: idle.clone(),
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
        .expect_err("thread/run is refused");
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
            .threads
            .iter()
            .all(|thread| thread.activity == Some(Activity::Idle)),
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
    let asking = client.thread_in(&world, &dir).await.thread_id;
    let other = client.create(&world).await;
    client.prompt(&asking, "slow 50").await;
    client.prompt(&other, "slow 50").await;
    let process = started
        .lock()
        .expect("lock")
        .iter()
        .find(|(cwd, _)| cwd.ends_with("asking"))
        .map(|(_, process)| process.clone())
        .expect("the asking thread's agent");

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
    let thread_id = client.create(&world).await;
    let asking = world.client(&daemon).await;
    asking
        .connection
        .send(DrainRequest {
            wait: false,
            except: None,
        })
        .await
        .expect("host/drain");
    assert!(!client.queue(&thread_id, "later").await.started);

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
    let thread_id = client.create(&world).await;
    client.prompt(&thread_id, "slow 5").await;
    assert_eq!(daemon.drain().await, 0);
    assert_eq!(daemon.status().threads[0].activity, Some(Activity::Idle));

    let world = World::new();
    let (daemon, _) = world.daemon_draining(WAIT);
    let mut client = world.client(&daemon).await;
    let thread_id = client.create(&world).await;
    client.prompt(&thread_id, "slow 50").await;
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

/// Sessions and their layouts (WVE-202).
mod sessions {
    use pretty_assertions::assert_eq;
    use serde_json::json;
    use weave_host_protocol::sessions::EndSessionRequest;
    use weave_host_protocol::sessions::FEATURE as SESSIONS_FEATURE;
    use weave_host_protocol::sessions::GetSessionRequest;
    use weave_host_protocol::sessions::ListSessionsRequest;
    use weave_host_protocol::sessions::Session;
    use weave_host_protocol::sessions::SetSessionRequest;
    use weave_host_protocol::sessions::UnwatchSessionsRequest;
    use weave_host_protocol::sessions::WatchSessionsRequest;

    use super::*;

    /// A layout with one tab showing `block`.
    fn layout(block: &str) -> serde_json::Value {
        json!({
            "version": 1,
            "tabs": [{"id": "tab-1", "root": {"kind": "block", "id": block, "type": "weave.thread"}}],
        })
    }

    fn set(
        directory: &Path,
        layout: serde_json::Value,
        if_revision: Option<u64>,
    ) -> SetSessionRequest {
        SetSessionRequest {
            directory: directory.to_path_buf(),
            layout,
            if_revision,
        }
    }

    impl TestClient {
        /// The next Session notification, past whatever else comes.
        async fn session_event(&mut self) -> HostEvent {
            loop {
                let event = self.next().await;
                if matches!(
                    event,
                    HostEvent::SessionUpdated(_) | HostEvent::SessionEnded(_)
                ) {
                    return event;
                }
            }
        }

        async fn updated(&mut self) -> Session {
            match self.session_event().await {
                HostEvent::SessionUpdated(updated) => updated.session,
                other => panic!("expected sessions/updated, got {other:?}"),
            }
        }

        async fn ended(&mut self) -> PathBuf {
            match self.session_event().await {
                HostEvent::SessionEnded(ended) => ended.directory,
                other => panic!("expected sessions/ended, got {other:?}"),
            }
        }

        /// Whether a Session notification comes soon.
        async fn hears_of_a_session(&mut self) -> bool {
            tokio::time::timeout(Duration::from_millis(300), self.session_event())
                .await
                .is_ok()
        }

        async fn sessions(&self) -> Vec<Session> {
            self.connection
                .send(ListSessionsRequest {})
                .await
                .expect("sessions/list")
                .sessions
        }

        async fn session(&self, directory: &Path) -> Result<Session, Error> {
            self.connection
                .send(GetSessionRequest {
                    directory: directory.to_path_buf(),
                })
                .await
                .map(|response| response.session)
        }
    }

    #[tokio::test]
    async fn two_clients_set_get_and_watch_a_session_and_the_newest_write_wins() {
        let world = World::new();
        let repo = world.repository();
        let app = repo.join("app");
        std::fs::create_dir(&app).expect("a subdirectory");
        let daemon = world.daemon(false, Duration::from_secs(60));
        let mut mac = world.client(&daemon).await;
        let mut ipad = world.client(&daemon).await;
        assert!(
            mac.connection
                .hello()
                .features
                .iter()
                .any(|feature| feature == SESSIONS_FEATURE)
        );

        // One watches every Session, the other the one its subdirectory is in, which has none
        // yet.
        let all = mac
            .connection
            .send(WatchSessionsRequest::default())
            .await
            .expect("sessions/watch");
        assert_eq!((all.directory, all.sessions), (None, Vec::new()));
        let one = ipad
            .connection
            .send(WatchSessionsRequest {
                directory: Some(app.clone()),
            })
            .await
            .expect("sessions/watch");
        assert_eq!(one.directory, Some(repo.clone()));
        assert!(one.sessions.is_empty());
        assert!(errors::is(
            &ipad.session(&app).await.expect_err("no Session yet"),
            errors::NO_SESSION
        ));

        // The first write makes the Session, at the worktree, and both hear it.
        let first = mac
            .connection
            .send(set(&app, layout("a"), Some(0)))
            .await
            .expect("sessions/set")
            .session;
        assert_eq!(first.directory, repo);
        assert_eq!(first.revision, 1);
        assert_eq!(first.layout, Some(layout("a")));
        assert_eq!(
            first.git.as_ref().and_then(|git| git.branch.as_deref()),
            Some("main")
        );
        assert_eq!(mac.updated().await, first);
        assert_eq!(ipad.updated().await, first);
        assert_eq!(ipad.session(&repo).await.expect("sessions/get"), first);

        // A write from a revision that's gone is refused, saying the current one.
        let stale = ipad
            .connection
            .send(set(&repo, layout("b"), Some(0)))
            .await
            .expect_err("a stale revision");
        assert!(errors::is(&stale, errors::REVISION_CONFLICT));
        assert_eq!(stale.data, Some(json!({"revision": 1})));

        // Without one, the newest write wins, under the next revision.
        let second = ipad
            .connection
            .send(set(&repo, layout("b"), None))
            .await
            .expect("sessions/set")
            .session;
        assert_eq!(second.revision, 2);
        assert_eq!(mac.updated().await, second);
        assert_eq!(ipad.updated().await, second);
        assert_eq!(mac.session(&app).await.expect("sessions/get"), second);

        // Listed, without the layout.
        let listed = mac.sessions().await;
        assert_eq!(
            listed,
            vec![Session {
                layout: None,
                ..second.clone()
            }]
        );

        // Revisions only go up, and one that stops watching hears no more.
        ipad.connection
            .send(UnwatchSessionsRequest {
                directory: Some(repo.clone()),
            })
            .await
            .expect("sessions/unwatch");
        let third = mac
            .connection
            .send(set(&repo, layout("c"), Some(2)))
            .await
            .expect("sessions/set")
            .session;
        assert_eq!(third.revision, 3);
        assert_eq!(mac.updated().await.revision, 3);
        assert!(!ipad.hears_of_a_session().await);

        // A layout past the limit is refused.
        let huge = json!({"version": 1, "tabs": [], "padding": "x".repeat(1024 * 1024)});
        assert!(mac.connection.send(set(&repo, huge, None)).await.is_err());
        assert_eq!(mac.session(&repo).await.expect("sessions/get").revision, 3);
    }

    #[tokio::test]
    async fn a_prompted_thread_makes_its_directorys_session_which_lists_it() {
        let world = World::new();
        let repo = world.repository();
        let notes = world.cwd().join("notes");
        std::fs::create_dir(&notes).expect("a directory");
        let notes = notes.canonicalize().expect("canonical");
        let daemon = world.daemon(false, Duration::from_secs(60));
        let mut watcher = world.client(&daemon).await;
        watcher
            .connection
            .send(WatchSessionsRequest::default())
            .await
            .expect("sessions/watch");
        let mut client = world.client(&daemon).await;

        // A blank thread makes none.
        client
            .connection
            .send(CreateThreadRequest {
                cwd: notes.clone(),
                ..TestClient::create_request(&world, "fake")
            })
            .await
            .expect("thread/create");
        assert!(!watcher.hears_of_a_session().await);
        assert_eq!(client.sessions().await, Vec::new());

        // A prompted one does: in a subdirectory of a repository, the worktree's.
        let sub = repo.join("src");
        std::fs::create_dir(&sub).expect("a subdirectory");
        let thread_id = client.thread_in(&world, &sub).await.thread_id;
        let made = watcher.updated().await;
        assert_eq!(made.directory, repo);
        assert_eq!(made.revision, 0);
        assert_eq!(made.layout, None);
        assert_eq!(made.threads, vec![thread_id.clone()]);

        // Outside a repository, the directory's own; the newest thread first.
        let first = client.thread_in(&world, &notes).await.thread_id;
        assert_eq!(watcher.updated().await.directory, notes);
        let second = client.thread_in(&world, &notes).await.thread_id;
        assert!(!watcher.hears_of_a_session().await);
        let listed = client.sessions().await;
        let directories: Vec<&Path> = listed
            .iter()
            .map(|session| session.directory.as_path())
            .collect();
        assert_eq!(directories, [repo.as_path(), notes.as_path()]);
        assert_eq!(listed[0].threads, vec![thread_id]);
        assert_eq!(listed[1].threads, vec![second, first]);
        assert!(listed[1].git.is_none());
    }

    #[tokio::test]
    async fn a_session_survives_a_host_restart() {
        let world = World::new();
        let dir = world.cwd();
        let kept = {
            let daemon = world.daemon(true, Duration::from_secs(60));
            let client = world.client(&daemon).await;
            client
                .connection
                .send(set(&dir, layout("a"), None))
                .await
                .expect("sessions/set");
            let kept = client
                .connection
                .send(set(&dir, layout("b"), Some(1)))
                .await
                .expect("sessions/set")
                .session;
            daemon.shutdown().await;
            kept
        };

        let daemon = world.daemon(true, Duration::from_secs(60));
        let client = world.client(&daemon).await;
        assert_eq!(client.session(&dir).await.expect("sessions/get"), kept);
        let next = client
            .connection
            .send(set(&dir, layout("c"), Some(2)))
            .await
            .expect("sessions/set")
            .session;
        assert_eq!(next.revision, 3);
        assert_eq!(next.created_at, kept.created_at);
    }

    #[tokio::test]
    async fn a_session_ends_with_its_worktree() {
        let world = World::new();
        let repo = world.repository();
        let daemon = world.daemon(false, Duration::from_secs(60));
        let mut client = world.client(&daemon).await;
        client
            .connection
            .send(WatchSessionsRequest::default())
            .await
            .expect("sessions/watch");
        let worktree = |branch: &str| CreateWorktreeRequest {
            repo: repo.clone(),
            branch: branch.to_owned(),
            base: None,
        };

        // Removed through the Host.
        let removed = client
            .connection
            .send(worktree("removed"))
            .await
            .expect("worktrees/create")
            .path;
        client
            .connection
            .send(set(&removed, layout("a"), None))
            .await
            .expect("sessions/set");
        assert_eq!(client.updated().await.directory, removed);
        client
            .connection
            .send(RemoveWorktreeRequest {
                path: removed.clone(),
                force: false,
                delete_branch: false,
            })
            .await
            .expect("worktrees/remove");
        assert_eq!(client.ended().await, removed);

        // Released before something else removes it, as worktrunk does.
        let released = client
            .connection
            .send(worktree("released"))
            .await
            .expect("worktrees/create")
            .path;
        client
            .connection
            .send(set(&released, layout("a"), None))
            .await
            .expect("sessions/set");
        client.updated().await;
        client
            .connection
            .send(ReleaseWorktreeRequest {
                path: released.clone(),
            })
            .await
            .expect("worktrees/release");
        assert_eq!(client.ended().await, released);
        git(
            &repo,
            &["worktree", "remove", released.to_str().expect("utf-8")],
        );

        // Removed behind the Host's back: it ends when the Host next lists them.
        let behind = client
            .connection
            .send(worktree("behind"))
            .await
            .expect("worktrees/create")
            .path;
        client
            .connection
            .send(set(&behind, layout("a"), None))
            .await
            .expect("sessions/set");
        client.updated().await;
        git(
            &repo,
            &["worktree", "remove", behind.to_str().expect("utf-8")],
        );
        assert_eq!(client.sessions().await, Vec::new());
        assert_eq!(client.ended().await, behind);
    }

    #[tokio::test]
    async fn a_session_ends_by_hand_unless_something_in_it_is_busy() {
        let world = World::new();
        let dir = world.cwd().canonicalize().expect("canonical");
        let daemon = world.daemon(false, Duration::from_secs(60));
        let mut client = world.client(&daemon).await;
        let thread_id = client.thread_in(&world, &dir).await.thread_id;
        assert_eq!(
            client.session(&dir).await.expect("sessions/get").threads,
            vec![thread_id.clone()]
        );

        // Not while its thread waits on a person.
        let target = dir.join("out.txt");
        client
            .prompt(&thread_id, &format!("write {} hello", target.display()))
            .await;
        let (_, asked) = client.asked(&mut Seen::default()).await;
        let end = || EndSessionRequest {
            directory: dir.clone(),
        };
        let busy = client.connection.send(end()).await.expect_err("busy");
        assert!(errors::is(&busy, errors::SESSION_BUSY), "{busy:?}");
        client
            .allow(&thread_id, &asked, "allow")
            .await
            .expect("answered");
        client.until_turn_ends(&mut Seen::default(), None).await;

        // Then it ends, leaving its thread open.
        client.connection.send(end()).await.expect("sessions/end");
        assert!(errors::is(
            &client.session(&dir).await.expect_err("ended"),
            errors::NO_SESSION
        ));
        let again = client.connection.send(end()).await.expect_err("ended");
        assert!(errors::is(&again, errors::NO_SESSION));
        let listed = client
            .connection
            .send(ListThreadsRequest {
                cwd: Some(dir.clone()),
                ..ListThreadsRequest::default()
            })
            .await
            .expect("threads/list")
            .threads;
        assert_eq!(listed[0].state, ThreadStatus::Open);
    }
}
