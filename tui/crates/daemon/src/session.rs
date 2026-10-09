//! A live session: the agent process bound to it, its journal, the clients attached to it,
//! its turns, and the requests waiting on a person. One task owns all of it, so every client
//! sees the session's events in the same order, and an attaching client gets a consistent
//! cut: the journal so far, then everything after.

use std::collections::BTreeMap;
use std::collections::HashMap;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;
use std::time::Instant;

use agent_client_protocol::Client;
use agent_client_protocol::ConnectionTo;
use agent_client_protocol::Error;
use agent_client_protocol::JsonRpcNotification;
use agent_client_protocol::Responder;
use futures::future::BoxFuture;
use tokio::sync::mpsc;
use tokio::sync::oneshot;
use weave_acp_core::AgentConnection;
use weave_acp_core::AgentEvent;
use weave_acp_core::AgentHandle;
use weave_acp_core::ElicitationRequest;
use weave_acp_core::PermissionRequest;
use weave_acp_core::RequestKey;
use weave_acp_core::Traces;
use weave_acp_core::daemon_protocol::Activity;
use weave_acp_core::daemon_protocol::AgentChoice;
use weave_acp_core::daemon_protocol::LiveSession;
use weave_acp_core::daemon_protocol::PermissionPolicy;
use weave_acp_core::daemon_protocol::SessionEndedNotification;
use weave_acp_core::daemon_protocol::TerminalExitNotification;
use weave_acp_core::daemon_protocol::TerminalOutputNotification;
use weave_acp_core::daemon_protocol::TurnNotification;
use weave_acp_core::daemon_protocol::TurnState;
use weave_acp_core::policy::ToolKinds;
use weave_acp_core::schema::CompleteElicitationNotification;
use weave_acp_core::schema::ContentBlock;
use weave_acp_core::schema::ContentChunk;
use weave_acp_core::schema::CreateElicitationResponse;
use weave_acp_core::schema::ElicitationAction;
use weave_acp_core::schema::ElicitationMode;
use weave_acp_core::schema::ElicitationScope;
use weave_acp_core::schema::PromptResponse;
use weave_acp_core::schema::RequestPermissionOutcome;
use weave_acp_core::schema::RequestPermissionResponse;
use weave_acp_core::schema::SessionConfigOption;
use weave_acp_core::schema::SessionId;
use weave_acp_core::schema::SessionModeState;
use weave_acp_core::schema::SessionNotification;
use weave_acp_core::schema::SessionUpdate;
use weave_acp_core::strip_terminal_events;

use crate::Shared;
use crate::instance::Instance;
use crate::instance::LaunchKey;
use crate::journal::Entry;
use crate::journal::Journal;
use crate::journal::Recorded;
use crate::journal::now_ms;

/// How long closing the agent's session may take before its process is stopped anyway.
const CLOSE_TIMEOUT: Duration = Duration::from_secs(5);

/// One connection to the daemon.
pub(crate) type ClientId = u64;

/// What a load or resume answers with: the session's modes and config options now.
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

/// How the sender of a prompt hears back.
pub(crate) enum Reply {
    /// A client's `session/prompt`, answered when the turn ends.
    Responder(Responder<PromptResponse>),
    /// `_weave/run`, told only whether the prompt went out.
    Started(oneshot::Sender<Result<(), Error>>),
}

impl Reply {
    pub(crate) fn fail(self, error: Error) {
        match self {
            Self::Responder(responder) => {
                let _ = responder.respond_with_error(error);
            }
            Self::Started(started) => {
                let _ = started.send(Err(error));
            }
        }
    }
}

/// A client's answer to a request the session forwarded to it.
pub(crate) enum Answer {
    Permission(RequestPermissionResponse),
    Elicitation(CreateElicitationResponse),
}

pub(crate) enum Command {
    /// Attach a client: replay the journal to it first when it loads the session, then
    /// tell it what's running and ask it what's pending.
    Attach {
        client: ClientId,
        cx: ConnectionTo<Client>,
        replay: bool,
        done: oneshot::Sender<Snapshot>,
    },
    Detach {
        client: ClientId,
    },
    Prompt {
        /// The sending client; none for `_weave/run`.
        client: Option<ClientId>,
        session_id: SessionId,
        prompt: Vec<ContentBlock>,
        reply: Reply,
    },
    Cancel {
        session_id: SessionId,
    },
    /// A client changed a mode or config option; the others hear of it.
    Changed {
        client: ClientId,
        notification: Box<SessionNotification>,
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
    /// Stop the agent but leave the session recoverable: the daemon is stopping.
    Suspend {
        done: oneshot::Sender<()>,
    },
    Answered {
        pending: u64,
        client: ClientId,
        answer: Result<Answer, Error>,
    },
}

/// The daemon's handle on a live session.
#[derive(Clone)]
pub(crate) struct SessionHandle {
    pub(crate) commands: mpsc::UnboundedSender<Command>,
    pub(crate) agent: AgentHandle,
    pub(crate) key: LaunchKey,
    /// Where the agent's protocol is traced, for each attached client that asked.
    pub(crate) traces: Arc<Traces>,
    pub(crate) summary: Arc<Mutex<LiveSession>>,
}

impl SessionHandle {
    pub(crate) async fn attach(
        &self,
        client: ClientId,
        cx: ConnectionTo<Client>,
        replay: bool,
    ) -> Result<Snapshot, Error> {
        let (done, attached) = oneshot::channel();
        self.send(Command::Attach {
            client,
            cx,
            replay,
            done,
        })?;
        attached.await.map_err(|_| ended())
    }

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

    pub(crate) fn summary(&self) -> LiveSession {
        lock(&self.summary).clone()
    }
}

fn ended() -> Error {
    Error::invalid_request().data("the session has ended")
}

/// What a newly opened session starts with.
pub(crate) struct Opened {
    pub(crate) session_id: SessionId,
    pub(crate) instance: Instance,
    pub(crate) journal: Journal,
    pub(crate) policy: PermissionPolicy,
    pub(crate) snapshot: Snapshot,
    pub(crate) cwd: PathBuf,
    pub(crate) agent: String,
    pub(crate) choice: Option<AgentChoice>,
}

/// Start the task that owns a session, and register it with the daemon.
pub(crate) fn start(shared: &Arc<Shared>, opened: Opened) -> SessionHandle {
    let Opened {
        session_id,
        instance,
        journal,
        policy,
        snapshot,
        cwd,
        agent,
        choice,
    } = opened;
    let (commands_tx, commands) = mpsc::unbounded_channel();
    let now = now_ms();
    let summary = Arc::new(Mutex::new(LiveSession {
        session_id: session_id.clone(),
        cwd: cwd.clone(),
        agent,
        choice: choice.clone(),
        title: None,
        activity: Activity::Idle,
        clients: 0,
        policy: policy.clone(),
        started_at_ms: now,
        last_activity_ms: now,
    }));
    let Instance {
        connection,
        events,
        key,
        traces,
    } = instance;
    let handle = SessionHandle {
        commands: commands_tx.clone(),
        agent: connection.handle(),
        key,
        traces,
        summary: Arc::clone(&summary),
    };
    {
        let mut registry = shared.registry();
        registry.sessions.insert(session_id.clone(), handle.clone());
        registry.known.insert(
            session_id.clone(),
            Recorded {
                agent: handle.key.spec().clone(),
                choice,
                cwd,
                policy: policy.clone(),
                closed: false,
                last_activity_ms: now,
            },
        );
    }
    let actor = Actor {
        root: session_id,
        shared: Arc::clone(shared),
        agent: connection.handle(),
        connection: Some(connection),
        events,
        commands,
        commands_tx,
        journal,
        clients: BTreeMap::new(),
        children: HashSet::new(),
        turns: HashMap::new(),
        pending: Vec::new(),
        next_pending: 1,
        policy,
        tool_kinds: ToolKinds::default(),
        snapshot,
        summary,
        idle_since: None,
        stopping: None,
        waiting: Vec::new(),
    };
    tokio::spawn(actor.run());
    handle
}

struct Turn {
    started: Instant,
    /// The client whose prompt this is, to answer when it ends.
    sender: Option<(ClientId, Responder<PromptResponse>)>,
}

enum PendingRequest {
    Permission(PermissionRequest),
    Elicitation(ElicitationRequest),
}

/// A request waiting on a person, and the clients it was forwarded to. Dropping a client's
/// entry withdraws the request from that client.
struct Pending {
    id: u64,
    session_id: Option<SessionId>,
    request: PendingRequest,
    forwards: HashMap<ClientId, oneshot::Sender<()>>,
}

impl Pending {
    fn key(&self) -> RequestKey {
        match &self.request {
            PendingRequest::Permission(request) => request.key,
            PendingRequest::Elicitation(request) => request.key,
        }
    }

    fn answer(self, answer: Answer) {
        let result = match (self.request, answer) {
            (PendingRequest::Permission(request), Answer::Permission(response)) => {
                request.respond_with(response)
            }
            (PendingRequest::Elicitation(request), Answer::Elicitation(response)) => {
                request.respond_with(response)
            }
            _ => Ok(()),
        };
        if let Err(error) = result {
            tracing::debug!(%error, "couldn't pass an answer on to the agent");
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
    /// The daemon is stopping; the journal stays open for a later daemon to recover.
    Suspended,
}

struct Actor {
    root: SessionId,
    shared: Arc<Shared>,
    agent: AgentHandle,
    connection: Option<AgentConnection>,
    events: mpsc::UnboundedReceiver<AgentEvent>,
    commands: mpsc::UnboundedReceiver<Command>,
    /// For the tasks that wait on clients' answers.
    commands_tx: mpsc::UnboundedSender<Command>,
    journal: Journal,
    clients: BTreeMap<ClientId, ConnectionTo<Client>>,
    /// Subagent sessions the agent reported under this one.
    children: HashSet<SessionId>,
    /// Turns running, by session: this one's, or a subagent's.
    turns: HashMap<SessionId, Turn>,
    pending: Vec<Pending>,
    next_pending: u64,
    policy: PermissionPolicy,
    /// Each tool call's kind, as reported, for the policy.
    tool_kinds: ToolKinds,
    snapshot: Snapshot,
    summary: Arc<Mutex<LiveSession>>,
    /// When nothing last needed the session; it closes once that's the idle grace ago.
    idle_since: Option<Instant>,
    stopping: Option<Ending>,
    /// Told once the session has stopped.
    waiting: Vec<oneshot::Sender<()>>,
}

impl Actor {
    async fn run(mut self) {
        let grace = self.shared.config.idle_grace;
        loop {
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
                cx,
                replay,
                done,
            } => {
                let snapshot = self.attach(client, cx, replay);
                let _ = done.send(snapshot);
            }
            Command::Detach { client } => self.detach(client),
            Command::Prompt {
                client,
                session_id,
                prompt,
                reply,
            } => self.prompt(client, session_id, prompt, reply),
            Command::Cancel { session_id } => self.cancel(&session_id),
            Command::Changed {
                client,
                notification,
            } => {
                if notification.session_id == self.root {
                    self.snapshot.apply(&notification.update);
                }
                self.broadcast(notification.as_ref(), Some(client));
                self.journal.append(Entry::Update { notification });
            }
            Command::Close { client, done } => {
                self.detach(client);
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
            Command::Answered {
                pending,
                client,
                answer,
            } => self.answered(pending, client, answer),
        }
    }

    fn attach(&mut self, client: ClientId, cx: ConnectionTo<Client>, replay: bool) -> Snapshot {
        if replay {
            for entry in self.journal.entries() {
                let sent = match entry {
                    Entry::Update { notification } => {
                        cx.send_notification(notification.as_ref().clone())
                    }
                    Entry::TerminalOutput { terminal_id, data } => {
                        cx.send_notification(TerminalOutputNotification {
                            session_id: self.root.clone(),
                            terminal_id: terminal_id.clone(),
                            data: data.clone(),
                        })
                    }
                    Entry::TerminalExit {
                        terminal_id,
                        status,
                    } => cx.send_notification(TerminalExitNotification {
                        session_id: self.root.clone(),
                        terminal_id: terminal_id.clone(),
                        status: status.clone(),
                    }),
                    _ => Ok(()),
                };
                if sent.is_err() {
                    break;
                }
            }
        }
        self.clients.insert(client, cx.clone());
        // What the agent sent before the request that brought this client here was answered
        // (a load's replay, say) reaches it before that answer.
        while let Ok(event) = self.events.try_recv() {
            self.agent_event(event);
        }
        for (session_id, turn) in &self.turns {
            let elapsed = u64::try_from(turn.started.elapsed().as_millis()).unwrap_or(u64::MAX);
            let _ = cx.send_notification(TurnNotification {
                session_id: session_id.clone(),
                turn: TurnState::Running {
                    elapsed_ms: elapsed,
                },
            });
        }
        for pending in &mut self.pending {
            forward(pending, client, &cx, &self.commands_tx);
        }
        self.snapshot.clone()
    }

    fn detach(&mut self, client: ClientId) {
        self.clients.remove(&client);
        for pending in &mut self.pending {
            pending.forwards.remove(&client);
        }
    }

    fn prompt(
        &mut self,
        client: Option<ClientId>,
        session_id: SessionId,
        prompt: Vec<ContentBlock>,
        reply: Reply,
    ) {
        if self.turns.contains_key(&session_id) {
            reply.fail(Error::invalid_request().data("a turn is already running in this session"));
            return;
        }
        if let Err(error) = self.agent.prompt(session_id.clone(), prompt.clone()) {
            reply.fail(error);
            return;
        }
        // Agents don't echo prompts, so this is how the other clients and the journal see it.
        // The agent's events come after: this task reads them next.
        for block in prompt {
            let notification = SessionNotification::new(
                session_id.clone(),
                SessionUpdate::UserMessageChunk(ContentChunk::new(block)),
            );
            self.journal.append(Entry::Update {
                notification: Box::new(notification.clone()),
            });
            self.broadcast(&notification, client);
        }
        self.journal.append(Entry::TurnStarted {
            session_id: session_id.clone(),
            at_ms: now_ms(),
        });
        self.broadcast(
            &TurnNotification {
                session_id: session_id.clone(),
                turn: TurnState::Running { elapsed_ms: 0 },
            },
            client,
        );
        let sender = match reply {
            Reply::Responder(responder) => client.map(|client| (client, responder)),
            Reply::Started(started) => {
                let _ = started.send(Ok(()));
                None
            }
        };
        self.turns.insert(
            session_id,
            Turn {
                started: Instant::now(),
                sender,
            },
        );
    }

    /// `session/cancel` from any client. The protocol has the client answer every pending
    /// permission request as cancelled; the daemon is that client.
    fn cancel(&mut self, session_id: &SessionId) {
        let (cancelled, kept) = std::mem::take(&mut self.pending)
            .into_iter()
            .partition(|pending| pending.session_id.as_ref() == Some(session_id));
        self.pending = kept;
        for pending in cancelled {
            pending.cancel();
        }
        if let Err(error) = self.agent.cancel(session_id.clone()) {
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
                self.journal.append(Entry::Update {
                    notification: Box::new(notification.clone()),
                });
                self.broadcast(&notification, None);
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
                self.broadcast(&CompleteElicitationNotification::new(id), None);
            }
            AgentEvent::RequestWithdrawn(key) => {
                if let Some(index) = self.pending.iter().position(|p| p.key() == key) {
                    self.pending.remove(index).withdrawn();
                }
            }
            AgentEvent::TurnEnded { session_id, result } => self.turn_ended(session_id, result),
            AgentEvent::TerminalOutput { terminal_id, text } => {
                self.journal.append(Entry::TerminalOutput {
                    terminal_id: terminal_id.clone(),
                    data: text.clone(),
                });
                let notification = TerminalOutputNotification {
                    session_id: self.root.clone(),
                    terminal_id,
                    data: text,
                };
                self.broadcast(&notification, None);
            }
            AgentEvent::TerminalExited {
                terminal_id,
                status,
            } => {
                self.journal.append(Entry::TerminalExit {
                    terminal_id: terminal_id.clone(),
                    status: status.clone(),
                });
                let notification = TerminalExitNotification {
                    session_id: self.root.clone(),
                    terminal_id,
                    status,
                };
                self.broadcast(&notification, None);
            }
            // Only a daemon sends these.
            AgentEvent::TurnRunning { .. } | AgentEvent::SessionEnded { .. } => {}
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
        if self.children.insert(child.clone()) {
            self.shared
                .registry()
                .children
                .insert(child.clone(), self.root.clone());
        }
    }

    fn ask(&mut self, session_id: Option<SessionId>, request: PendingRequest) {
        let mut pending = Pending {
            id: self.next_pending,
            session_id,
            request,
            forwards: HashMap::new(),
        };
        self.next_pending += 1;
        for (client, cx) in &self.clients {
            forward(&mut pending, *client, cx, &self.commands_tx);
        }
        self.pending.push(pending);
    }

    /// A client answered. The first real answer goes to the agent and the request is withdrawn
    /// from everyone else. A cancelled permission isn't one: the TUI cancels what's pending when
    /// it leaves a session, and a cancelled turn's requests were already answered here. A
    /// dismissed elicitation is, once no other client could still answer it.
    fn answered(&mut self, id: u64, client: ClientId, answer: Result<Answer, Error>) {
        let Some(index) = self.pending.iter().position(|pending| pending.id == id) else {
            return;
        };
        self.pending[index].forwards.remove(&client);
        let answer = match answer {
            Ok(Answer::Permission(response))
                if matches!(response.outcome, RequestPermissionOutcome::Cancelled) =>
            {
                return;
            }
            Ok(Answer::Elicitation(response))
                if matches!(response.action, ElicitationAction::Cancel)
                    && !self.pending[index].forwards.is_empty() =>
            {
                return;
            }
            Ok(answer) => answer,
            Err(_) => return,
        };
        self.pending.remove(index).answer(answer);
    }

    fn turn_ended(&mut self, session_id: SessionId, result: Result<PromptResponse, Error>) {
        let turn = self.turns.remove(&session_id);
        // An agent resolves its requests before ending a turn; any left can't matter now.
        let (leftover, kept) = std::mem::take(&mut self.pending)
            .into_iter()
            .partition(|pending| pending.session_id.as_ref() == Some(&session_id));
        self.pending = kept;
        for pending in leftover {
            pending.cancel();
        }
        let (stop_reason, error) = match &result {
            Ok(response) => (Some(response.stop_reason), None),
            Err(error) => (None, Some(error.clone())),
        };
        self.journal.append(Entry::TurnEnded {
            session_id: session_id.clone(),
            stop_reason,
            error: error.clone(),
        });
        let sender = turn.and_then(|turn| turn.sender);
        let except = sender.as_ref().map(|(client, _)| *client);
        if let Some((_, responder)) = sender {
            let _ = responder.respond_with_result(result);
        }
        self.broadcast(
            &TurnNotification {
                session_id,
                turn: TurnState::Ended { stop_reason, error },
            },
            except,
        );
    }

    /// Send to every attached client but `except`, dropping clients that have gone.
    fn broadcast<N: JsonRpcNotification + Clone>(
        &mut self,
        notification: &N,
        except: Option<ClientId>,
    ) {
        self.clients.retain(|client, cx| {
            Some(*client) == except || cx.send_notification(notification.clone()).is_ok()
        });
    }

    fn update_summary(&self) {
        let mut summary = lock(&self.summary);
        summary.clients = self.clients.len();
        summary.activity = if !self.pending.is_empty() {
            Activity::Waiting
        } else if !self.turns.is_empty() {
            Activity::Running
        } else {
            Activity::Idle
        };
    }

    async fn finish(mut self, ending: Ending) {
        let suspended = matches!(ending, Ending::Suspended);
        let reason = match &ending {
            Ending::Closed(reason) | Ending::AgentGone(reason) => reason.clone(),
            Ending::Suspended => "the daemon stopped".to_owned(),
        };
        // Nothing reaches this session from now on.
        {
            let last_activity_ms = lock(&self.summary).last_activity_ms;
            let mut registry = self.shared.registry();
            registry.sessions.remove(&self.root);
            for child in &self.children {
                registry.children.remove(child);
            }
            // Left open for a later daemon when this one stops; closed otherwise.
            if let Some(known) = registry.known.get_mut(&self.root) {
                known.closed = !suspended;
                known.last_activity_ms = last_activity_ms;
            }
        }
        let error = Error::internal_error().data(format!("the session ended: {reason}"));
        for (session_id, turn) in std::mem::take(&mut self.turns) {
            let except = turn.sender.as_ref().map(|(client, _)| *client);
            if let Some((_, responder)) = turn.sender {
                let _ = responder.respond_with_error(error.clone());
            }
            if !suspended {
                self.journal.append(Entry::TurnEnded {
                    session_id: session_id.clone(),
                    stop_reason: None,
                    error: Some(error.clone()),
                });
            }
            self.broadcast(
                &TurnNotification {
                    session_id,
                    turn: TurnState::Ended {
                        stop_reason: None,
                        error: Some(error.clone()),
                    },
                },
                except,
            );
        }
        for pending in std::mem::take(&mut self.pending) {
            pending.cancel();
        }
        self.broadcast(
            &SessionEndedNotification {
                session_id: self.root.clone(),
                reason: reason.clone(),
            },
            None,
        );
        if matches!(ending, Ending::Closed(_))
            && self.agent.agent().is_some_and(|agent| {
                agent
                    .agent_capabilities
                    .session_capabilities
                    .close
                    .is_some()
            })
        {
            let close = self.agent.close_session(self.root.clone());
            if let Ok(Err(error)) = tokio::time::timeout(CLOSE_TIMEOUT, close).await {
                tracing::debug!(%error, "the agent didn't close the session");
            }
        }
        if !suspended {
            self.journal.append(Entry::Closed {
                reason,
                at_ms: now_ms(),
            });
        }
        if let Some(connection) = self.connection.take() {
            connection.shutdown().await;
        }
        for waiting in self.waiting {
            let _ = waiting.send(());
        }
    }
}

/// Ask `client` the pending request, reporting its answer back to the session unless the
/// request is withdrawn from it first.
fn forward(
    pending: &mut Pending,
    client: ClientId,
    cx: &ConnectionTo<Client>,
    commands: &mpsc::UnboundedSender<Command>,
) {
    let (withdraw, withdrawn) = oneshot::channel::<()>();
    pending.forwards.insert(client, withdraw);
    let answer: BoxFuture<'static, Result<Answer, Error>> = match &pending.request {
        PendingRequest::Permission(request) => {
            let sent = cx.send_request(request.request.clone());
            Box::pin(async move { sent.block_task().await.map(Answer::Permission) })
        }
        PendingRequest::Elicitation(request) => {
            let sent = cx.send_request(request.request.clone());
            Box::pin(async move { sent.block_task().await.map(Answer::Elicitation) })
        }
    };
    let commands = commands.clone();
    let id = pending.id;
    tokio::spawn(async move {
        tokio::select! {
            answer = answer => {
                let _ = commands.send(Command::Answered { pending: id, client, answer });
            }
            // Dropping the request asks the client to withdraw it.
            _ = withdrawn => {}
        }
    });
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
