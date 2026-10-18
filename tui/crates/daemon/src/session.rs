//! An open session: the agent process bound to it, its journal, the clients attached to it,
//! its turns, and the requests waiting on a person. One task owns all of it, so every client
//! sees the session's events in the same order, and an attaching client gets a consistent
//! cut: its answer, the journal after the position it asked from, then everything after.
//!
//! `session/reopen` swaps the agent process for one of the version the agent's new sessions
//! get, once no turn runs and no request waits, taking the session up again through ACP; the
//! journal goes on, marked where the version changed.

use std::cmp::Ordering as Order;
use std::collections::BTreeMap;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::Instant;

use agent_client_protocol::ConnectionTo;
use agent_client_protocol::Error;
use agent_client_protocol::JsonRpcNotification;
use agent_client_protocol::Responder;
use tokio::sync::mpsc;
use tokio::sync::oneshot;
use weave_acp_core::AgentConnection;
use weave_acp_core::AgentEvent;
use weave_acp_core::AgentHandle;
use weave_acp_core::ClientOptions;
use weave_acp_core::ElicitationRequest;
use weave_acp_core::PermissionRequest;
use weave_acp_core::ProtocolVersion;
use weave_acp_core::RequestKey;
use weave_acp_core::SteerOutcome;
use weave_acp_core::Traces;
use weave_acp_core::schema::CompleteElicitationNotification;
use weave_acp_core::schema::ContentBlock;
use weave_acp_core::schema::CreateElicitationResponse;
use weave_acp_core::schema::ElicitationMode;
use weave_acp_core::schema::ElicitationScope;
use weave_acp_core::schema::InitializeResponse;
use weave_acp_core::schema::PromptResponse;
use weave_acp_core::schema::RequestPermissionResponse;
use weave_acp_core::schema::SessionConfigOption;
use weave_acp_core::schema::SessionId;
use weave_acp_core::schema::SessionInfo;
use weave_acp_core::schema::SessionModeState;
use weave_acp_core::schema::SessionNotification;
use weave_acp_core::schema::SessionUpdate;
use weave_acp_core::strip_terminal_events;
use weave_agents::lock::compare;
use weave_host_protocol::HostClient;
use weave_host_protocol::agents::AgentRelease;
use weave_host_protocol::agents::AgentUpdate;
use weave_host_protocol::agents::UpdateAvailableNotification;
use weave_host_protocol::errors;
use weave_host_protocol::events::ElicitationCompletedNotification;
use weave_host_protocol::events::SessionChangedNotification;
use weave_host_protocol::events::SessionEventNotification;
use weave_host_protocol::pending::PendingAddedNotification;
use weave_host_protocol::pending::PendingKind;
use weave_host_protocol::pending::PendingResolvedNotification;
use weave_host_protocol::pending::Resolution;
use weave_host_protocol::policy::PermissionPolicy;
use weave_host_protocol::policy::ToolKinds;
use weave_host_protocol::sessions::Activity;
use weave_host_protocol::sessions::AttachSessionResponse;
use weave_host_protocol::sessions::JournalHead;
use weave_host_protocol::sessions::JournalPosition;
use weave_host_protocol::sessions::ReopenSessionResponse;
use weave_host_protocol::sessions::Replay;
use weave_host_protocol::sessions::RunningTurn;
use weave_host_protocol::sessions::SessionAgent;
use weave_host_protocol::sessions::SessionListing;
use weave_host_protocol::sessions::SessionState;
use weave_host_protocol::sessions::SessionStatus;
use weave_host_protocol::sessions::TurnOrigin;
use weave_host_protocol::turns::SteerTurnResponse;

use crate::Agent;
use crate::Shared;
use crate::instance::Instance;
use crate::instance::LaunchKey;
use crate::journal::Entry;
use crate::journal::Journal;
use crate::journal::Recorded;
use crate::journal::RecordedChoice;
use crate::journal::now_ms;
use crate::updates::Feed;
use crate::updates::describe;

/// How long closing the agent's session may take before its process is stopped anyway.
const CLOSE_TIMEOUT: Duration = Duration::from_secs(5);

/// One connection to the Host.
pub(crate) type ClientId = u64;

/// An attached client: how to reach it.
#[derive(Clone)]
pub(crate) struct ClientLink {
    pub(crate) cx: ConnectionTo<HostClient>,
}

/// What a session's agent says about it now: its modes and config options.
#[derive(Clone, Debug, Default)]
pub(crate) struct Snapshot {
    pub(crate) modes: Option<SessionModeState>,
    pub(crate) config_options: Vec<SessionConfigOption>,
}

impl Snapshot {
    fn apply(&mut self, update: &SessionUpdate) {
        match update {
            SessionUpdate::CurrentModeUpdate(update) => {
                if let Some(modes) = &mut self.modes {
                    modes.current_mode_id = update.current_mode_id.clone();
                }
            }
            SessionUpdate::ConfigOptionUpdate(update) => {
                self.config_options = update.config_options.clone();
            }
            _ => {}
        }
    }
}

/// Where an attaching client's replay starts.
pub(crate) enum ReplayFrom {
    /// The whole journal.
    Start,
    /// After the last event the client handled, unless that was in another journal.
    After(JournalPosition),
    /// Nothing: from what happens next, as for a run that attaches to see its turn.
    Now,
}

/// How an attaching client is answered: before its replay, so it knows where it starts.
pub(crate) enum AttachReply {
    /// `session/create`.
    Created(Responder<SessionState>),
    /// `session/attach`.
    Attached(Responder<AttachSessionResponse>),
    /// `session/run` with `attach`, which answers once its turn has started.
    Run(oneshot::Sender<SessionState>),
}

impl AttachReply {
    fn send(self, state: SessionState, replay: Replay) {
        let sent = match self {
            Self::Created(responder) => responder.respond(state),
            Self::Attached(responder) => responder.respond(AttachSessionResponse { state, replay }),
            Self::Run(sender) => {
                let _ = sender.send(state);
                Ok(())
            }
        };
        if let Err(error) = sent {
            tracing::debug!(%error, "couldn't answer an attaching client");
        }
    }

    pub(crate) fn fail(self, error: Error) {
        match self {
            Self::Created(responder) => {
                let _ = responder.respond_with_error(error);
            }
            Self::Attached(responder) => {
                let _ = responder.respond_with_error(error);
            }
            Self::Run(_) => {}
        }
    }
}

/// A client's answer to a pending request.
pub(crate) enum Answer {
    Permission(RequestPermissionResponse),
    Elicitation(CreateElicitationResponse),
}

pub(crate) enum Command {
    /// Attach a client: answer it, send it the journal after `after`, then what follows.
    Attach {
        client: ClientId,
        link: ClientLink,
        from: ReplayFrom,
        /// Worth telling the client, such as skipped MCP servers.
        notices: Vec<String>,
        trace: Option<PathBuf>,
        reply: AttachReply,
    },
    Detach {
        client: ClientId,
    },
    Prompt {
        origin: TurnOrigin,
        session_id: SessionId,
        prompt: Vec<ContentBlock>,
        /// The position of the turn's `turnStarted`, once it has started.
        reply: oneshot::Sender<Result<u64, Error>>,
    },
    /// A message for the running turn; see [`Steer`].
    Steer(Steer),
    Cancel {
        session_id: SessionId,
    },
    /// A client changed a mode or config option; every client hears of it.
    Changed {
        notification: Box<SessionNotification>,
    },
    Answer {
        pending_id: String,
        /// The answering client's `clientId`.
        by: String,
        answer: Answer,
        reply: oneshot::Sender<Result<(), Error>>,
    },
    /// A client is done with the session, which closes if nothing else needs it.
    Close {
        client: ClientId,
        done: oneshot::Sender<()>,
    },
    /// Close the session for good, as when it's deleted.
    End {
        reason: String,
        done: oneshot::Sender<()>,
    },
    /// Stop the agent but leave the session recoverable: the Host is stopping.
    Suspend {
        done: oneshot::Sender<()>,
    },
    /// The newest version of the session's agent; clients hear of it if it's newer than the
    /// one the session runs.
    UpdateAvailable {
        latest: String,
    },
    /// `session/reopen`: once nothing runs or waits, take the session up in a new process of
    /// the agent's current version.
    Reopen {
        reply: oneshot::Sender<Result<ReopenSessionResponse, Error>>,
    },
}

/// `turn/steer`: a message for a running turn, waiting for the agent to take it.
pub(crate) struct Steer {
    pub(crate) origin: TurnOrigin,
    pub(crate) session_id: SessionId,
    pub(crate) prompt: Vec<ContentBlock>,
    pub(crate) reply: oneshot::Sender<Result<SteerTurnResponse, Error>>,
}

/// What a session is, for listings and status.
#[derive(Clone, Debug)]
pub(crate) struct Summary {
    pub(crate) session_id: SessionId,
    pub(crate) agent_id: String,
    pub(crate) cwd: PathBuf,
    pub(crate) title: Option<String>,
    pub(crate) activity: Activity,
    pub(crate) clients: u32,
    pub(crate) policy: PermissionPolicy,
    pub(crate) last_activity_ms: u64,
}

impl Summary {
    pub(crate) fn listing(&self) -> SessionListing {
        let mut info = SessionInfo::new(self.session_id.clone(), self.cwd.clone());
        info.title.clone_from(&self.title);
        SessionListing {
            info,
            agent_id: self.agent_id.clone(),
            state: SessionStatus::Open,
            activity: Some(self.activity),
            clients: self.clients,
            headless: self.policy.is_headless(),
            last_activity_at: Some(self.last_activity_ms),
        }
    }
}

/// The Host's handle on an open session.
#[derive(Clone)]
pub(crate) struct SessionHandle {
    pub(crate) commands: mpsc::UnboundedSender<Command>,
    pub(crate) agent: AgentHandle,
    pub(crate) key: LaunchKey,
    pub(crate) agent_id: String,
    /// Where the agent's protocol is traced, for each attached client that asked.
    pub(crate) traces: Arc<Traces>,
    pub(crate) summary: Arc<Mutex<Summary>>,
    /// Where newer versions of its agent are looked for.
    pub(crate) feed: Option<Feed>,
    blank: Arc<AtomicBool>,
}

impl SessionHandle {
    /// Send a command and wait for the session to carry it out.
    pub(crate) async fn finish(
        &self,
        command: impl FnOnce(oneshot::Sender<()>) -> Command,
    ) -> Result<(), Error> {
        let (done, finished) = oneshot::channel();
        self.send(command(done))?;
        finished.await.map_err(|_| ended())
    }

    pub(crate) fn send(&self, command: Command) -> Result<(), Error> {
        self.commands.send(command).map_err(|_| ended())
    }

    pub(crate) fn summary(&self) -> Summary {
        lock(&self.summary).clone()
    }

    /// Whether the session is blank: `session/create` opened it, and nobody has prompted it.
    /// There's nothing in it to come back to.
    pub(crate) fn is_blank(&self) -> bool {
        self.blank.load(Ordering::Relaxed)
    }
}

pub(crate) fn ended() -> Error {
    Error::invalid_request().data("the session has ended")
}

/// What a newly opened session starts with.
pub(crate) struct Opened {
    pub(crate) session_id: SessionId,
    pub(crate) instance: Instance,
    pub(crate) agent: SessionAgent,
    /// The agent as the Host resolved it, to start again if the session is reopened.
    pub(crate) resolved: Agent,
    pub(crate) journal: Journal,
    pub(crate) policy: PermissionPolicy,
    pub(crate) snapshot: Snapshot,
    pub(crate) cwd: PathBuf,
    pub(crate) additional_directories: Vec<PathBuf>,
    /// Opened by `session/create`, so blank until it's prompted.
    pub(crate) blank: bool,
}

/// Start the task that owns a session, and register it with the Host.
pub(crate) fn start(shared: &Arc<Shared>, opened: Opened) -> SessionHandle {
    let Opened {
        session_id,
        instance,
        agent,
        resolved,
        journal,
        policy,
        snapshot,
        cwd,
        additional_directories,
        blank,
    } = opened;
    let blank = Arc::new(AtomicBool::new(blank));
    let (commands_tx, commands) = mpsc::unbounded_channel();
    let now = now_ms();
    let summary = Arc::new(Mutex::new(Summary {
        session_id: session_id.clone(),
        agent_id: agent.id.clone(),
        cwd: cwd.clone(),
        title: None,
        activity: Activity::Idle,
        clients: 0,
        policy: policy.clone(),
        last_activity_ms: now,
    }));
    let Instance {
        agent_id: _,
        connection,
        events,
        key,
        traces,
    } = instance;
    let options = key.options();
    let handle = SessionHandle {
        commands: commands_tx,
        agent: connection.handle(),
        key,
        agent_id: agent.id.clone(),
        traces: Arc::clone(&traces),
        summary: Arc::clone(&summary),
        feed: resolved.feed(),
        blank: Arc::clone(&blank),
    };
    {
        let mut registry = shared.registry();
        registry.sessions.insert(session_id.clone(), handle.clone());
        registry.known.insert(
            session_id.clone(),
            Recorded {
                agent: handle.key.spec().clone(),
                choice: Some(RecordedChoice::Named(agent.id.clone())),
                cwd: cwd.clone(),
                policy: policy.clone(),
                closed: false,
                last_activity_ms: now,
            },
        );
    }
    let actor = Actor {
        root: session_id,
        shared: Arc::clone(shared),
        handle: connection.handle(),
        connection: Some(connection),
        events,
        commands,
        journal,
        clients: BTreeMap::new(),
        children: Vec::new(),
        turns: HashMap::new(),
        pending: Vec::new(),
        next_pending: 1,
        steers: HashMap::new(),
        next_steer: 1,
        policy,
        tool_kinds: ToolKinds::default(),
        snapshot,
        agent,
        resolved,
        options,
        traces,
        update: None,
        reopens: Vec::new(),
        cwd,
        additional_directories,
        summary,
        reported: Reported::default(),
        blank,
        idle_since: None,
        stopping: None,
        waiting: Vec::new(),
    };
    tokio::spawn(actor.run());
    handle
}

struct Turn {
    started_ms: u64,
    origin: TurnOrigin,
}

enum PendingRequest {
    Permission(PermissionRequest),
    Elicitation(ElicitationRequest),
}

/// A request waiting on a person.
struct Pending {
    id: String,
    session_id: Option<SessionId>,
    created_ms: u64,
    request: PendingRequest,
}

impl Pending {
    fn key(&self) -> RequestKey {
        match &self.request {
            PendingRequest::Permission(request) => request.key,
            PendingRequest::Elicitation(request) => request.key,
        }
    }

    /// As clients see it.
    fn describe(&self) -> weave_host_protocol::pending::PendingRequest {
        weave_host_protocol::pending::PendingRequest {
            id: self.id.clone(),
            session_id: self.session_id.clone(),
            created_at: self.created_ms,
            request: match &self.request {
                PendingRequest::Permission(request) => PendingKind::Permission {
                    request: request.request.clone(),
                },
                PendingRequest::Elicitation(request) => PendingKind::Elicitation {
                    request: request.request.clone(),
                },
            },
        }
    }

    fn cancel(self) {
        let _ = match self.request {
            PendingRequest::Permission(request) => request.cancel(),
            PendingRequest::Elicitation(request) => request.cancel(),
        };
    }

    fn withdrawn(self) {
        let _ = match self.request {
            PendingRequest::Permission(request) => request.withdrawn(),
            PendingRequest::Elicitation(request) => request.withdrawn(),
        };
    }
}

/// How a session stops.
enum Ending {
    /// Closed: the agent's session too, and the journal says so.
    Closed(String),
    /// The agent went away by itself.
    AgentGone(String),
    /// The Host is stopping; the journal stays open for a later Host to recover.
    Suspended,
}

/// What attached clients were last told about the session, to tell them what changes.
#[derive(Default, PartialEq)]
struct Reported {
    activity: Option<Activity>,
    clients: Option<u32>,
    title: Option<String>,
    blank: Option<bool>,
}

struct Actor {
    root: SessionId,
    shared: Arc<Shared>,
    handle: AgentHandle,
    connection: Option<AgentConnection>,
    events: mpsc::UnboundedReceiver<AgentEvent>,
    commands: mpsc::UnboundedReceiver<Command>,
    journal: Journal,
    clients: BTreeMap<ClientId, ClientLink>,
    /// Subagent sessions the agent reported under this one, in order.
    children: Vec<SessionId>,
    /// Turns running, by session: this one's, or a subagent's.
    turns: HashMap<SessionId, Turn>,
    pending: Vec<Pending>,
    next_pending: u64,
    /// Messages steered into turns, by tag, until the agent answers.
    steers: HashMap<u64, Steer>,
    next_steer: u64,
    policy: PermissionPolicy,
    /// Each tool call's kind, as reported, for the policy.
    tool_kinds: ToolKinds,
    snapshot: Snapshot,
    agent: SessionAgent,
    /// The agent as the Host resolved it when its process started.
    resolved: Agent,
    /// The client services its process is offered.
    options: ClientOptions,
    traces: Arc<Traces>,
    /// A newer version of the agent, once one is known.
    update: Option<AgentUpdate>,
    /// `session/reopen`s waiting for the turn and requests to end.
    reopens: Vec<oneshot::Sender<Result<ReopenSessionResponse, Error>>>,
    cwd: PathBuf,
    additional_directories: Vec<PathBuf>,
    summary: Arc<Mutex<Summary>>,
    reported: Reported,
    /// Whether the session is blank; see [`SessionHandle::is_blank`].
    blank: Arc<AtomicBool>,
    /// When nothing last needed the session; it closes once that's the idle grace ago.
    idle_since: Option<Instant>,
    stopping: Option<Ending>,
    /// Told once the session has stopped.
    waiting: Vec<oneshot::Sender<()>>,
}

impl Actor {
    async fn run(mut self) {
        loop {
            // A blank session has nothing to come back to, so it doesn't wait long.
            let grace = if self.blank.load(Ordering::Relaxed) {
                self.shared.config.blank_grace
            } else {
                self.shared.config.idle_grace
            };
            let deadline = self.idle_since.map(|since| since + grace);
            tokio::select! {
                command = self.commands.recv() => match command {
                    Some(command) => self.command(command),
                    None => self.stop(Ending::Suspended),
                },
                event = self.events.recv() => match event {
                    Some(event) => self.agent_event(event),
                    None => self.stop(Ending::AgentGone("the agent exited".to_owned())),
                },
                () = sleep_until(deadline), if deadline.is_some() => {
                    self.stop(Ending::Closed("idle".to_owned()));
                }
            }
            if self.stopping.is_none()
                && !self.reopens.is_empty()
                && self.turns.is_empty()
                && self.pending.is_empty()
            {
                self.reopen().await;
            }
            if let Some(ending) = self.stopping.take() {
                self.finish(ending).await;
                return;
            }
            self.idle_since = if self.is_idle() {
                Some(self.idle_since.unwrap_or_else(Instant::now))
            } else {
                None
            };
            self.update_summary();
        }
    }

    fn stop(&mut self, ending: Ending) {
        if self.stopping.is_none() {
            self.stopping = Some(ending);
        }
    }

    fn is_idle(&self) -> bool {
        self.clients.is_empty() && self.turns.is_empty() && self.pending.is_empty()
    }

    fn command(&mut self, command: Command) {
        match command {
            Command::Attach {
                client,
                link,
                from,
                notices,
                trace,
                reply,
            } => self.attach(client, link, from, notices, trace, reply),
            Command::Detach { client } => {
                self.clients.remove(&client);
            }
            Command::Prompt {
                origin,
                session_id,
                prompt,
                reply,
            } => {
                let _ = reply.send(self.prompt(origin, session_id, prompt));
            }
            Command::Steer(steer) => self.steer(steer),
            Command::Cancel { session_id } => self.cancel(&session_id),
            Command::Changed { notification } => {
                if notification.session_id == self.root {
                    self.snapshot.apply(&notification.update);
                }
                self.record(Entry::Update { notification });
            }
            Command::Answer {
                pending_id,
                by,
                answer,
                reply,
            } => {
                let _ = reply.send(self.answer(&pending_id, by, answer));
            }
            Command::Close { client, done } => {
                self.clients.remove(&client);
                if self.is_idle() {
                    self.waiting.push(done);
                    self.stop(Ending::Closed("closed".to_owned()));
                } else {
                    let _ = done.send(());
                }
            }
            Command::End { reason, done } => {
                self.waiting.push(done);
                self.stop(Ending::Closed(reason));
            }
            Command::Suspend { done } => {
                self.waiting.push(done);
                self.stop(Ending::Suspended);
            }
            Command::UpdateAvailable { latest } => self.update_available(latest),
            Command::Reopen { reply } => self.reopens.push(reply),
        }
    }

    /// The newest version of the agent is `latest`: tell attached clients, once, if it's
    /// newer than the one running.
    fn update_available(&mut self, latest: String) {
        let Some(release) = &self.agent.release else {
            return;
        };
        let newer = compare(&latest, &release.version) == Order::Greater;
        if !newer
            || self
                .update
                .as_ref()
                .is_some_and(|update| update.latest == latest)
        {
            return;
        }
        let update = AgentUpdate {
            agent_id: self.agent.id.clone(),
            name: release.name.clone(),
            running: release.version.clone(),
            latest,
        };
        self.update = Some(update.clone());
        self.broadcast(&UpdateAvailableNotification {
            session_id: self.root.clone(),
            update,
        });
    }

    fn attach(
        &mut self,
        client: ClientId,
        link: ClientLink,
        from: ReplayFrom,
        notices: Vec<String>,
        trace: Option<PathBuf>,
        reply: AttachReply,
    ) {
        // What the agent sent before the request that brought this client here was answered
        // (a load's replay, say) goes into the journal first.
        while let Ok(event) = self.events.try_recv() {
            self.agent_event(event);
        }
        let journal_id = self.journal.id();
        let (from, reset) = match from {
            ReplayFrom::After(after) if after.journal == journal_id => {
                (after.seq.saturating_add(1), false)
            }
            ReplayFrom::After(_) | ReplayFrom::Start => (1, true),
            ReplayFrom::Now => (self.journal.head().saturating_add(1), false),
        };
        self.clients.insert(client, link.clone());
        let state = self.state(notices, trace);
        reply.send(state, Replay { from, reset });
        let skip = usize::try_from(from).unwrap_or(usize::MAX);
        for (seq, record) in self.journal.records().iter().enumerate().skip(skip) {
            let Some(event) = record.entry.event() else {
                continue;
            };
            let notification = SessionEventNotification {
                session_id: self.root.clone(),
                seq: u64::try_from(seq).unwrap_or(u64::MAX),
                at: record.at,
                event,
            };
            if link.cx.send_notification(notification).is_err() {
                self.clients.remove(&client);
                return;
            }
        }
    }

    /// The session as a client attaching now sees it.
    fn state(&self, notices: Vec<String>, trace: Option<PathBuf>) -> SessionState {
        let summary = lock(&self.summary).clone();
        SessionState {
            session_id: self.root.clone(),
            agent: self.agent.clone(),
            cwd: self.cwd.clone(),
            additional_directories: self.additional_directories.clone(),
            title: summary.title,
            state: SessionStatus::Open,
            activity: self.activity(),
            clients: u32::try_from(self.clients.len()).unwrap_or(u32::MAX),
            blank: self.blank.load(Ordering::Relaxed),
            policy: self.policy.clone(),
            modes: self.snapshot.modes.clone(),
            config_options: self.snapshot.config_options.clone(),
            turns: self
                .turns
                .iter()
                .map(|(session_id, turn)| RunningTurn {
                    session_id: session_id.clone(),
                    started_at: turn.started_ms,
                    origin: turn.origin.clone(),
                })
                .collect(),
            pending: self.pending.iter().map(Pending::describe).collect(),
            subagents: self.children.clone(),
            journal: JournalHead {
                id: self.journal.id(),
                head: self.journal.head(),
            },
            notices,
            trace,
            update: self.update.clone(),
        }
    }

    fn prompt(
        &mut self,
        origin: TurnOrigin,
        session_id: SessionId,
        prompt: Vec<ContentBlock>,
    ) -> Result<u64, Error> {
        if self.turns.contains_key(&session_id) {
            return Err(errors::turn_running());
        }
        self.handle.prompt(session_id.clone(), prompt.clone())?;
        self.blank.store(false, Ordering::Relaxed);
        let (seq, at) = self.record(Entry::TurnStarted {
            session_id: session_id.clone(),
            at_ms: now_ms(),
            prompt,
            origin: Some(origin.clone()),
        });
        self.turns.insert(
            session_id,
            Turn {
                started_ms: at,
                origin,
            },
        );
        Ok(seq)
    }

    /// `turn/steer`: pass the message to the agent, whose answer comes back as
    /// [`AgentEvent::Steered`], in order with the turn's updates.
    fn steer(&mut self, steer: Steer) {
        // Only a turn the Host started is steered, so a turn ends only where the Host sees it.
        if !self.turns.contains_key(&steer.session_id) {
            let _ = steer.reply.send(Ok(not_running()));
            return;
        }
        let tag = self.next_steer;
        self.next_steer += 1;
        match self
            .handle
            .steer(steer.session_id.clone(), steer.prompt.clone(), tag)
        {
            Ok(()) => {
                self.steers.insert(tag, steer);
            }
            Err(error) => {
                let _ = steer.reply.send(Err(error));
            }
        }
    }

    /// The agent answered a steered message: one it took is journaled where it joined the
    /// turn, after the updates the agent sent first.
    fn steered(&mut self, tag: u64, result: Result<SteerOutcome, Error>) {
        let Some(steer) = self.steers.remove(&tag) else {
            return;
        };
        let answer = match result {
            Ok(outcome @ (SteerOutcome::Injected | SteerOutcome::StartedNewTurn)) => {
                if outcome == SteerOutcome::StartedNewTurn {
                    tracing::warn!(
                        session = %self.root,
                        "the agent started a turn of its own with a steered message; \
                         the Host won't see it end"
                    );
                }
                let (seq, _) = self.record(Entry::TurnSteered {
                    session_id: steer.session_id,
                    prompt: steer.prompt,
                    origin: steer.origin,
                });
                Ok(SteerTurnResponse {
                    outcome: weave_host_protocol::turns::SteerOutcome::Steered,
                    seq: Some(seq),
                })
            }
            Ok(SteerOutcome::PromptRequired) => Ok(not_running()),
            Ok(SteerOutcome::Failed | SteerOutcome::Unknown) => {
                Err(Error::internal_error().data("the agent couldn't take the message"))
            }
            Err(error) => Err(error),
        };
        let _ = steer.reply.send(answer);
    }

    /// `turn/cancel`. The protocol has the client answer every pending permission request
    /// as cancelled; the Host is that client.
    fn cancel(&mut self, session_id: &SessionId) {
        self.resolve_where(
            |pending| pending.session_id.as_ref() == Some(session_id),
            Resolution::Cancelled,
        );
        if let Err(error) = self.handle.cancel(session_id.clone()) {
            tracing::warn!(%error, "failed to send session/cancel");
        }
    }

    fn agent_event(&mut self, event: AgentEvent) {
        lock(&self.summary).last_activity_ms = now_ms();
        match event {
            AgentEvent::SessionUpdate(mut notification) => {
                // Output in `_meta` already came through as terminal events.
                strip_terminal_events(&mut notification.update);
                self.tool_kinds.observe(&notification.update);
                if notification.session_id == self.root {
                    self.snapshot.apply(&notification.update);
                    if let SessionUpdate::SessionInfoUpdate(info) = &notification.update
                        && let Some(title) = info.title.value()
                    {
                        lock(&self.summary).title = Some(title.clone());
                    }
                } else {
                    self.adopt(&notification.session_id);
                }
                self.record(Entry::Update {
                    notification: Box::new(notification),
                });
            }
            AgentEvent::PermissionRequested(request) => {
                let kind = self.tool_kinds.of(&request.request);
                match self.policy.answer(&request.request, kind) {
                    Some(response) => {
                        tracing::info!(
                            session = %self.root,
                            tool = %request.request.tool_call.tool_call_id,
                            outcome = ?response.outcome,
                            "permission answered by the session's policy"
                        );
                        let _ = request.respond_with(response);
                    }
                    None => {
                        let session_id = Some(request.request.session_id.clone());
                        self.ask(session_id, PendingRequest::Permission(request));
                    }
                }
            }
            AgentEvent::ElicitationRequested(request) => {
                if self.policy.dismisses_elicitations() {
                    let _ = request.cancel();
                } else {
                    let scope = match &request.request.mode {
                        ElicitationMode::Form(form) => Some(&form.scope),
                        ElicitationMode::Url(url) => Some(&url.scope),
                        _ => None,
                    };
                    let session_id = match scope {
                        Some(ElicitationScope::Session(scope)) => Some(scope.session_id.clone()),
                        _ => None,
                    };
                    self.ask(session_id, PendingRequest::Elicitation(request));
                }
            }
            AgentEvent::ElicitationCompleted(id) => {
                self.broadcast(&ElicitationCompletedNotification {
                    session_id: self.root.clone(),
                    notification: CompleteElicitationNotification::new(id),
                });
            }
            AgentEvent::RequestWithdrawn(key) => {
                if let Some(index) = self.pending.iter().position(|p| p.key() == key) {
                    let pending = self.pending.remove(index);
                    self.resolved(&pending.id, Resolution::Withdrawn, None);
                    pending.withdrawn();
                }
            }
            AgentEvent::TurnEnded { session_id, result } => self.turn_ended(session_id, result),
            AgentEvent::Steered { tag, result, .. } => self.steered(tag, result),
            AgentEvent::TerminalOutput { terminal_id, text } => {
                self.record(Entry::TerminalOutput {
                    terminal_id,
                    data: text,
                });
            }
            AgentEvent::TerminalExited {
                terminal_id,
                status,
            } => {
                self.record(Entry::TerminalExit {
                    terminal_id,
                    status,
                });
            }
            AgentEvent::Disconnected(error) => {
                let reason = error.map_or_else(
                    || "the agent exited".to_owned(),
                    |error| format!("the agent disconnected: {error}"),
                );
                self.stop(Ending::AgentGone(reason));
            }
        }
    }

    /// A subagent session the agent reports under this one: requests for it come here.
    fn adopt(&mut self, child: &SessionId) {
        if !self.children.contains(child) {
            self.children.push(child.clone());
            self.shared
                .registry()
                .children
                .insert(child.clone(), self.root.clone());
        }
    }

    fn ask(&mut self, session_id: Option<SessionId>, request: PendingRequest) {
        let pending = Pending {
            id: format!("p{}", self.next_pending),
            session_id,
            created_ms: now_ms(),
            request,
        };
        self.next_pending += 1;
        self.broadcast(&PendingAddedNotification {
            session_id: self.root.clone(),
            pending: pending.describe(),
        });
        self.pending.push(pending);
    }

    /// `pending/answer`: the first answer goes to the agent.
    fn answer(&mut self, pending_id: &str, by: String, answer: Answer) -> Result<(), Error> {
        let index = self
            .pending
            .iter()
            .position(|pending| pending.id == pending_id)
            .ok_or_else(errors::already_resolved)?;
        let matches = matches!(
            (&self.pending[index].request, &answer),
            (PendingRequest::Permission(_), Answer::Permission(_))
                | (PendingRequest::Elicitation(_), Answer::Elicitation(_))
        );
        if !matches {
            return Err(Error::invalid_params().data("that answer is for another kind of request"));
        }
        let pending = self.pending.remove(index);
        self.resolved(&pending.id, Resolution::Answered, Some(by));
        let passed = match (pending.request, answer) {
            (PendingRequest::Permission(request), Answer::Permission(response)) => {
                request.respond_with(response)
            }
            (PendingRequest::Elicitation(request), Answer::Elicitation(response)) => {
                request.respond_with(response)
            }
            _ => Ok(()),
        };
        if let Err(error) = passed {
            tracing::debug!(%error, "couldn't pass an answer on to the agent");
        }
        Ok(())
    }

    /// Resolve the pending requests `which` picks as `outcome`, answering the agent as the
    /// protocol asks for a cancelled turn.
    fn resolve_where(&mut self, which: impl Fn(&Pending) -> bool, outcome: Resolution) {
        let (resolved, kept): (Vec<_>, Vec<_>) = std::mem::take(&mut self.pending)
            .into_iter()
            .partition(which);
        self.pending = kept;
        for pending in resolved {
            self.resolved(&pending.id, outcome, None);
            pending.cancel();
        }
    }

    fn resolved(&mut self, pending_id: &str, outcome: Resolution, by: Option<String>) {
        self.broadcast(&PendingResolvedNotification {
            session_id: self.root.clone(),
            pending_id: pending_id.to_owned(),
            outcome,
            by,
        });
    }

    fn turn_ended(&mut self, session_id: SessionId, result: Result<PromptResponse, Error>) {
        self.turns.remove(&session_id);
        // An agent resolves its requests before ending a turn; any left can't matter now.
        self.resolve_where(
            |pending| pending.session_id.as_ref() == Some(&session_id),
            Resolution::Cancelled,
        );
        self.record(Entry::turn_ended(session_id, &result));
    }

    /// Journal `entry` and send it to every attached client. Returns its position and time.
    fn record(&mut self, entry: Entry) -> (u64, u64) {
        let event = entry.event();
        let (seq, at) = self.journal.append(entry);
        if let Some(event) = event {
            self.broadcast(&SessionEventNotification {
                session_id: self.root.clone(),
                seq,
                at,
                event,
            });
        }
        (seq, at)
    }

    /// Send to every attached client, dropping clients that have gone.
    fn broadcast<N: JsonRpcNotification + Clone>(&mut self, notification: &N) {
        self.clients
            .retain(|_, link| link.cx.send_notification(notification.clone()).is_ok());
    }

    fn activity(&self) -> Activity {
        if !self.pending.is_empty() {
            Activity::Waiting
        } else if !self.turns.is_empty() {
            Activity::Running
        } else {
            Activity::Idle
        }
    }

    /// Keep the summary current, and tell attached clients what changed.
    fn update_summary(&mut self) {
        let activity = self.activity();
        let clients = u32::try_from(self.clients.len()).unwrap_or(u32::MAX);
        let title = {
            let mut summary = lock(&self.summary);
            summary.clients = clients;
            summary.activity = activity;
            summary.title.clone()
        };
        let now = Reported {
            activity: Some(activity),
            clients: Some(clients),
            title,
            blank: Some(self.blank.load(Ordering::Relaxed)),
        };
        if now == self.reported {
            return;
        }
        let notification = SessionChangedNotification {
            session_id: self.root.clone(),
            activity: changed(&now.activity, &self.reported.activity),
            clients: changed(&now.clients, &self.reported.clients),
            title: changed(&now.title, &self.reported.title),
            blank: changed(&now.blank, &self.reported.blank),
        };
        self.reported = now;
        self.broadcast(&notification);
    }

    async fn finish(mut self, ending: Ending) {
        // A blank session isn't worth leaving for a later Host, or keeping a journal of.
        let blank = self.blank.load(Ordering::Relaxed);
        let ending = match ending {
            Ending::Suspended if blank => Ending::Closed("the Host stopped".to_owned()),
            ending => ending,
        };
        let suspended = matches!(ending, Ending::Suspended);
        let reason = match &ending {
            Ending::Closed(reason) | Ending::AgentGone(reason) => reason.clone(),
            Ending::Suspended => "the Host stopped".to_owned(),
        };
        // Nothing reaches this session from now on.
        {
            let last_activity_ms = lock(&self.summary).last_activity_ms;
            let mut registry = self.shared.registry();
            registry.sessions.remove(&self.root);
            for child in &self.children {
                registry.children.remove(child);
            }
            // Left open for a later Host when this one stops; closed otherwise.
            if blank {
                registry.known.remove(&self.root);
            } else if let Some(known) = registry.known.get_mut(&self.root) {
                known.closed = !suspended;
                known.last_activity_ms = last_activity_ms;
            }
        }
        let pending_all = |_: &Pending| true;
        if suspended {
            // The journal stays as it was, for a later Host to carry on from.
            for pending in std::mem::take(&mut self.pending) {
                pending.cancel();
            }
        } else {
            let error = Error::internal_error().data(format!("the session ended: {reason}"));
            let turns: Vec<SessionId> = self
                .turns
                .drain()
                .map(|(session_id, _)| session_id)
                .collect();
            for session_id in turns {
                self.record(Entry::turn_ended(session_id, &Err(error.clone())));
            }
            self.resolve_where(pending_all, Resolution::Cancelled);
            self.record(Entry::Closed {
                reason,
                at_ms: now_ms(),
            });
        }
        if matches!(ending, Ending::Closed(_)) {
            self.close_in_agent().await;
        }
        if blank {
            self.journal.discard();
        } else {
            // A journal that fell behind gets one last chance to be written out.
            self.journal.flush();
        }
        if let Some(connection) = self.connection.take() {
            connection.shutdown().await;
        }
        for waiting in self.waiting {
            let _ = waiting.send(());
        }
    }
}

impl Actor {
    /// `session/reopen`, now that nothing runs or waits: answer everyone who asked.
    async fn reopen(&mut self) {
        let replies = std::mem::take(&mut self.reopens);
        let result = self.swap_agent().await;
        for reply in replies {
            let _ = reply.send(result.clone());
        }
    }

    /// Start the agent's current version and take the session up in it, in place of the
    /// process running it. A version that doesn't start leaves the session as it was; one that
    /// can't take the session up gives way to the version that ran it.
    async fn swap_agent(&mut self) -> Result<ReopenSessionResponse, Error> {
        // What the running process sent last goes into the journal first.
        while let Ok(event) = self.events.try_recv() {
            self.agent_event(event);
        }
        if self.stopping.is_some() {
            return Err(ended());
        }
        let cant = || {
            Error::method_not_found().data(
                "the agent can't resume or load sessions, so this one can't move to another \
                 process; new sessions start the agent's current version",
            )
        };
        if !self.handle.agent().is_some_and(takes_sessions_up) {
            return Err(cant());
        }
        let agent = self.shared.resolve(&self.resolved.id).await?;
        let wanted = agent
            .release()
            .map_or_else(|| agent.id.clone(), |release| release.version);
        let mut fresh = self.start(&agent).await.map_err(|error| {
            Error::internal_error().data(format!(
                "{wanted} doesn't start, so the session stays as it was: {}",
                describe(&error)
            ))
        })?;
        if !fresh.init().is_some_and(takes_sessions_up) {
            fresh.connection.shutdown().await;
            return Err(cant());
        }
        let previous = self.agent.release.clone();
        self.let_go().await;
        let error = match self.take_up(&mut fresh, &agent).await {
            Ok(snapshot) => return Ok(self.carry_on_with(fresh, agent, snapshot, previous, None)),
            Err(error) => error,
        };
        fresh.connection.shutdown().await;
        let failed = format!("{wanted} couldn't resume the session: {}", describe(&error));
        tracing::warn!(session = %self.root, "{failed}; reopening it on the version it ran");
        let old = self.resolved.clone();
        let restarted = match self.start(&old).await {
            Ok(mut instance) => match self.take_up(&mut instance, &old).await {
                Ok(snapshot) => Ok((instance, snapshot)),
                Err(error) => {
                    instance.connection.shutdown().await;
                    Err(error)
                }
            },
            Err(error) => Err(error),
        };
        match restarted {
            Ok((instance, snapshot)) => {
                Ok(self.carry_on_with(instance, old, snapshot, previous, Some(failed)))
            }
            Err(error) => {
                let reason = format!(
                    "{failed}, and the version it ran couldn't take it up again: {}",
                    describe(&error)
                );
                self.stop(Ending::AgentGone(reason.clone()));
                Err(Error::internal_error().data(reason))
            }
        }
    }

    /// A process of `agent` for this session, traced for the clients that asked. (These take
    /// `&mut self`: the actor isn't `Sync`, so its futures can't hold `&Actor`.)
    async fn start(&mut self, agent: &Agent) -> Result<Instance, Error> {
        let launch = self.shared.launch(agent, &self.cwd);
        Instance::start_traced(
            &self.shared.config.launcher,
            &launch,
            self.options,
            Arc::clone(&self.traces),
        )
        .await
    }

    /// Close the session in the running process, and stop it.
    async fn let_go(&mut self) {
        self.close_in_agent().await;
        if let Some(connection) = self.connection.take() {
            connection.shutdown().await;
        }
    }

    /// Close the session in its agent, if the agent closes sessions.
    async fn close_in_agent(&mut self) {
        let closes = self.handle.agent().is_some_and(|agent| {
            agent
                .agent_capabilities
                .session_capabilities
                .close
                .is_some()
        });
        if closes {
            let close = self.handle.close_session(self.root.clone());
            if let Ok(Err(error)) = tokio::time::timeout(CLOSE_TIMEOUT, close).await {
                tracing::debug!(%error, "the agent didn't close the session");
            }
        }
    }

    /// Take the session up in `instance`: resumed, or loaded with its replay dropped, which
    /// the journal has already.
    async fn take_up(&mut self, instance: &mut Instance, agent: &Agent) -> Result<Snapshot, Error> {
        let (setup, _) = crate::client::setup(
            agent,
            instance,
            self.cwd.clone(),
            self.additional_directories.clone(),
        );
        let resumes = instance.init().is_some_and(|init| {
            init.agent_capabilities
                .session_capabilities
                .resume
                .is_some()
        });
        let (modes, config_options) = if resumes {
            instance
                .connection
                .resume_session(self.root.clone(), &setup)
                .await
                .map(|response| (response.modes, response.config_options))?
        } else {
            let loaded = instance
                .connection
                .load_session(self.root.clone(), &setup)
                .await
                .map(|response| (response.modes, response.config_options));
            instance.discard_queued_events();
            loaded?
        };
        Ok(Snapshot {
            modes,
            config_options: config_options.unwrap_or_default(),
        })
    }

    /// Carry on with `instance` as the session's agent, and journal the change.
    fn carry_on_with(
        &mut self,
        instance: Instance,
        agent: Agent,
        snapshot: Snapshot,
        previous: Option<AgentRelease>,
        failed: Option<String>,
    ) -> ReopenSessionResponse {
        let initialize = instance
            .init()
            .cloned()
            .unwrap_or_else(|| InitializeResponse::new(ProtocolVersion::V1));
        let Instance {
            connection,
            events,
            key,
            ..
        } = instance;
        // The old process won't answer a steer now.
        for (_, steer) in self.steers.drain() {
            let _ = steer.reply.send(Ok(not_running()));
        }
        self.agent = agent.session_agent(initialize);
        self.handle = connection.handle();
        self.connection = Some(connection);
        self.events = events;
        self.snapshot = snapshot;
        // An update the new version caught up with isn't one any more.
        let running = self
            .agent
            .release
            .as_ref()
            .map(|release| release.version.clone());
        self.update = self.update.take().and_then(|mut update| {
            let running = running.clone()?;
            (compare(&update.latest, &running) == Order::Greater).then(|| {
                update.running = running;
                update
            })
        });
        {
            let mut registry = self.shared.registry();
            if let Some(handle) = registry.sessions.get_mut(&self.root) {
                handle.agent = self.handle.clone();
                handle.key = key.clone();
                handle.feed = agent.feed();
            }
            if let Some(known) = registry.known.get_mut(&self.root) {
                known.agent = key.spec().clone();
            }
        }
        self.resolved = agent;
        self.record(Entry::AgentReopened {
            agent: Box::new(self.agent.clone()),
            previous,
            modes: self.snapshot.modes.clone(),
            config_options: self.snapshot.config_options.clone(),
            failed,
        });
        ReopenSessionResponse { version: running }
    }
}

/// Whether the agent takes sessions up again, by resuming or loading them.
fn takes_sessions_up(init: &InitializeResponse) -> bool {
    init.agent_capabilities
        .session_capabilities
        .resume
        .is_some()
        || init.agent_capabilities.load_session
}

/// No turn was running to steer, so nothing was sent.
fn not_running() -> SteerTurnResponse {
    SteerTurnResponse {
        outcome: weave_host_protocol::turns::SteerOutcome::NotRunning,
        seq: None,
    }
}

/// `new`, if it isn't what clients were last told.
fn changed<T: Clone + PartialEq>(new: &Option<T>, old: &Option<T>) -> Option<T> {
    (new != old).then(|| new.clone()).flatten()
}

async fn sleep_until(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline.into()).await,
        None => std::future::pending().await,
    }
}

pub(crate) fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}
