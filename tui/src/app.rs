//! The event loop: terminal input and the Host's messages in, frames and Host requests out.
//!
//! Requests whose answers the UI waits on (settings, session lists) run on their own tasks
//! and report back as [`AppEvent`]s, so the loop never blocks on the Host. Opening a session
//! answers on the Host connection's own channel instead, in order with the session's events,
//! so the transcript is ready for the replay that follows.

use std::collections::HashMap;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;

use crossterm::event::Event;
use crossterm::event::KeyEventKind;
use futures::future::BoxFuture;
use tokio::sync::Semaphore;
use tokio::sync::mpsc;
use tokio::sync::mpsc::UnboundedReceiver;
use tokio::sync::oneshot;
use tokio::time::MissedTickBehavior;
use weave_acp_core::schema::ContentBlock;
use weave_acp_core::schema::Error;
use weave_acp_core::schema::InitializeResponse;
use weave_acp_core::schema::PromptCapabilities;
use weave_acp_core::schema::SessionConfigOption;
use weave_acp_core::schema::SessionId;
use weave_acp_core::schema::TerminalExitStatus;
use weave_acp_core::supports_steering;
use weave_host_client::HostConnection;
use weave_host_client::HostEvent;
use weave_host_client::HostHandle;
use weave_host_client::Open;
use weave_host_protocol::agents::UPDATES_FEATURE;
use weave_host_protocol::agents::UpdateAgentRequest;
use weave_host_protocol::errors;
use weave_host_protocol::events::SessionEvent;
use weave_host_protocol::pending::AnswerPendingRequest;
use weave_host_protocol::pending::PendingKind;
use weave_host_protocol::pending::PendingRequest;
use weave_host_protocol::queue::AddQueuedRequest;
use weave_host_protocol::queue::FEATURE as QUEUE_FEATURE;
use weave_host_protocol::queue::QueuedPrompt;
use weave_host_protocol::queue::RemoveQueuedRequest;
use weave_host_protocol::queue::ResumeQueueRequest;
use weave_host_protocol::sessions::AttachSessionRequest;
use weave_host_protocol::sessions::CloseWhen;
use weave_host_protocol::sessions::CreateSessionRequest;
use weave_host_protocol::sessions::DeleteSessionRequest;
use weave_host_protocol::sessions::DetachSessionRequest;
use weave_host_protocol::sessions::JournalPosition;
use weave_host_protocol::sessions::ListSessionsRequest;
use weave_host_protocol::sessions::ListSessionsResponse;
use weave_host_protocol::sessions::RENAME_FEATURE;
use weave_host_protocol::sessions::RenameSessionRequest;
use weave_host_protocol::sessions::ReopenSessionRequest;
use weave_host_protocol::sessions::SessionAgent;
use weave_host_protocol::sessions::SessionState;
use weave_host_protocol::sessions::SetConfigOptionRequest;
use weave_host_protocol::sessions::SetModeRequest;
use weave_host_protocol::sessions::TurnOrigin;
use weave_host_protocol::tools::CLIPBOARD_WRITE;
use weave_host_protocol::tools::ClientToolResult;
use weave_host_protocol::turns::CancelTurnRequest;
use weave_host_protocol::turns::STEER_FEATURE;
use weave_host_protocol::turns::StartTurnRequest;
use weave_host_protocol::turns::SteerTurnRequest;
use weave_host_protocol::turns::SteerTurnResponse;

use crate::attachments::prompt_blocks;
use crate::chat::AppCommand;
use crate::chat::ChatWidget;
use crate::chat::Queued;
use crate::chat::SessionAbilities;
use crate::clipboard;
use crate::events::ChatEvent;
use crate::events::ElicitationAsk;
use crate::events::PermissionAsk;
use crate::footer::StatusItem;
use crate::input::Input;
use crate::markdown;
use crate::markdown::Rendering;
use crate::session::OpenedSession;
use crate::session::SessionTarget;
use crate::settings::SettingChange;
use crate::thumbnails;
use crate::thumbnails::Thumbnail;
use crate::tui::ScreenMode;
use crate::tui::Tui;
use crate::updates::Dismissed;

/// How long to wait for the weave Host to come back after it went away.
const RECONNECT_WINDOW: Duration = Duration::from_secs(15);
/// How often to look for it meanwhile.
const RECONNECT_INTERVAL: Duration = Duration::from_millis(250);
/// How long quitting waits for a blank session to close; the Host closes it later anyway.
const CLOSE_ON_QUIT_TIMEOUT: Duration = Duration::from_secs(2);

/// Connects to the weave Host again after it went away, without starting one, so a restarted
/// Host is picked up and a stopped one stays stopped.
pub type Reconnector = Arc<dyn Fn() -> BoxFuture<'static, Reconnection> + Send + Sync>;

/// One attempt to reach the weave Host again.
pub enum Reconnection {
    Connected(Box<HostConnection>, UnboundedReceiver<HostEvent>),
    /// No Host is listening, yet.
    NotYet,
    /// A Host answered that this TUI can't work with, as after an upgrade.
    Incompatible(String),
}

/// Animation frame interval while a turn runs.
const FRAME_INTERVAL: Duration = Duration::from_millis(80);
/// Host events applied per frame before input gets a turn.
const EVENTS_PER_FRAME: usize = 256;

/// A connection to the Host, ready for the interactive client.
pub struct Session {
    pub connection: HostConnection,
    pub events: UnboundedReceiver<HostEvent>,
    /// The agent this client's sessions run with, by id.
    pub agent_id: String,
    pub agent_name: String,
    pub agent_version: Option<String>,
    /// What the agent said about itself: what prompts may carry, which session methods it has.
    pub agent: InitializeResponse,
    /// Where new sessions work, until an opened session says otherwise.
    pub cwd: PathBuf,
    pub additional_directories: Vec<PathBuf>,
    /// Have the Host trace sessions opened from here.
    pub trace: bool,
    /// The session to start in, opened already, or `None` to start in the session picker.
    pub opened: Option<weave_host_client::OpenedSession>,
    /// Things worth telling the user at startup.
    pub notices: Vec<String>,
}

/// How the client looks.
pub struct UiOptions {
    pub screen: ScreenMode,
    /// What the footer's status line shows; empty shows `? for shortcuts` instead.
    pub status_line: Vec<StatusItem>,
    /// Desktop notifications when a turn ends or the agent needs you, while unfocused.
    pub notifications: bool,
    /// Keep the window title on the session and what the agent is doing.
    pub terminal_title: bool,
    /// The Vim composer, for new blank threads and multi-line drafts.
    pub vim: bool,
    /// Show pasted images above the composer, where the terminal draws images.
    pub images: bool,
    /// What agent Markdown is drawn as: Mermaid diagrams and math, or their source.
    pub rendering: Rendering,
    /// Sessions outlive the TUI, in the weave Host: leaving with Ctrl+D keeps a turn running.
    pub detachable: bool,
    /// How to reach the weave Host again when it goes away; none for one in this process.
    pub reconnect: Option<Reconnector>,
    /// Where the versions whose update notice the user dismissed are kept; none keeps them
    /// for this run only.
    pub dismissed_updates: Option<PathBuf>,
}

/// How the client ended.
pub struct Exit {
    /// The session to offer reopening: the active one, if it had a conversation.
    pub resumable_session: Option<SessionId>,
    /// Whether its turn was still running, to carry on in the weave Host.
    pub turn_running: bool,
    /// `/reload`: start again in place, reattaching to `active_session`.
    pub reload: bool,
    /// The session shown when it ended, conversation or not.
    pub active_session: Option<SessionId>,
}

/// Results of requests the loop made off the UI thread.
enum AppEvent {
    SettingChanged(
        SettingChange,
        Result<Option<Vec<SessionConfigOption>>, Error>,
    ),
    SessionsListed(Result<ListSessionsResponse, Error>, bool),
    SessionDeleted(SessionId, Result<(), Error>),
    PromptFailed(Error),
    /// The Host's answer to a message steered into a session's turn.
    Steered {
        session_id: SessionId,
        text: String,
        result: Result<SteerTurnResponse, Error>,
    },
    /// The clipboard's image, saved for attaching, or why there wasn't one.
    ImagePasted(Result<PathBuf, String>),
    /// An image's thumbnail, by its id, or why there isn't one.
    ThumbnailLoaded(u32, Result<Thumbnail, String>),
    /// Output from a shell-mode command, then how it ended.
    ShellOutput(String, String),
    ShellExited(String, TerminalExitStatus),
    /// The weave Host is back, connected afresh.
    Reconnected(Box<HostConnection>, UnboundedReceiver<HostEvent>),
    /// A Host is back that this TUI can't work with.
    HostIncompatible(String),
    /// No Host came back in time.
    ReconnectGaveUp,
    /// The Host's answer to `/update`'s `agents/update`: the version new sessions get.
    AgentUpdated(Result<String, Error>),
    /// The Host's answer to `session/reopen`.
    SessionReopened(SessionId, Result<(), Error>),
    /// `/rename` failed; a rename that worked shows as its `renamed` event.
    RenameFailed(Error),
    /// The Host couldn't queue a message, which goes back to the draft.
    QueueFailed(String, Error),
    /// This client's queued messages the Host took out for editing, in order.
    Unqueued(Vec<String>),
    /// `/queue` failed.
    ResumeFailed(Error),
}

/// Why a session is being opened, for when the Host answers.
enum OpenKind {
    /// Switching to it (or starting in it), leaving `previous`.
    Open { previous: Option<SessionId> },
    /// Back to the session shown, after reconnecting.
    Reattach,
}

/// Run the interactive client until the user quits, then close the connection.
pub async fn run(session: Session, ui: UiOptions) -> anyhow::Result<Exit> {
    let UiOptions {
        screen,
        status_line,
        notifications,
        terminal_title,
        vim,
        images,
        rendering,
        detachable,
        reconnect,
        dismissed_updates,
    } = ui;
    markdown::set_rendering(rendering);
    let Session {
        connection,
        events,
        agent_id,
        agent_name,
        agent_version,
        agent,
        cwd,
        additional_directories,
        trace,
        opened,
        notices,
    } = session;
    let abilities = SessionAbilities {
        // The Host lists sessions whatever the agent offers.
        list: true,
        delete: agent
            .agent_capabilities
            .session_capabilities
            .delete
            .is_some(),
    };
    let dismissed = Dismissed::load(dismissed_updates);
    let updatable = connection
        .hello()
        .features
        .iter()
        .any(|feature| feature == UPDATES_FEATURE);
    let renamable = connection
        .hello()
        .features
        .iter()
        .any(|feature| feature == RENAME_FEATURE);
    let queueable = connection
        .hello()
        .features
        .iter()
        .any(|feature| feature == QUEUE_FEATURE);
    let mut tui = Tui::init(screen, images)?;
    let size = tui.size()?;
    // The session works where the Host says, and so does this client.
    let cwd = opened
        .as_ref()
        .map_or(cwd, |opened| opened.state.cwd.clone());
    let mut chat = ChatWidget::new(agent_name, cwd.clone(), abilities, size.width)
        .with_status_line(status_line)
        .with_vim(vim)
        .with_detach(detachable)
        .with_updates(updatable, dismissed.versions().clone())
        .with_rename(renamable)
        .with_host_queue(queueable)
        .with_thumbnails(tui.shows_images());
    chat.set_size(size.width, size.height);
    if screen == ScreenMode::Fullscreen {
        chat = chat.fullscreen();
    }
    let mut app = App {
        handle: connection.handle(),
        connection,
        reconnect,
        agent_id,
        cwd,
        additional_directories,
        trace,
        prompt_capabilities: agent.agent_capabilities.prompt_capabilities.clone(),
        results: None,
        notifications,
        terminal_title,
        focused: true,
        shells: HashMap::new(),
        reload: false,
        opens: HashMap::new(),
        next_tag: 1,
        position: None,
        replay_until: None,
        decoding: Arc::new(Semaphore::new(1)),
        dismissed,
    };
    let startup = match opened {
        Some(opened) => {
            chat.begin_session(opened.state.session_id.clone(), None);
            app.session_opened(&mut chat, &opened)
        }
        None => chat.open_session_picker(true),
    };
    chat.push_header(agent_version.as_deref(), &notices);
    let result = app.run(&mut tui, &mut chat, events, startup).await;
    tui.exit();
    // A blank session has nothing to come back to, so it closes now and its agent stops,
    // rather than when the Host's grace for it ends. A reload reattaches to it instead.
    if !app.reload
        && let Some(session_id) = chat.blank_session().cloned()
    {
        let close = app.handle.send(DetachSessionRequest {
            session_id,
            close: CloseWhen::IfUnused,
        });
        if let Ok(Err(error)) = tokio::time::timeout(CLOSE_ON_QUIT_TIMEOUT, close).await {
            tracing::debug!(%error, "couldn't close the blank session");
        }
    }
    app.connection.shutdown().await;
    result.map(|()| Exit {
        resumable_session: chat.resumable_session().cloned(),
        turn_running: chat.turn_running(),
        reload: app.reload,
        active_session: chat.active_session().cloned(),
    })
}

struct App {
    handle: HostHandle,
    /// The connection to the Host; replaced when it reconnects.
    connection: HostConnection,
    reconnect: Option<Reconnector>,
    agent_id: String,
    /// Where the active session works.
    cwd: PathBuf,
    additional_directories: Vec<PathBuf>,
    trace: bool,
    prompt_capabilities: PromptCapabilities,
    results: Option<mpsc::UnboundedSender<AppEvent>>,
    notifications: bool,
    terminal_title: bool,
    /// Whether the terminal has focus, from its focus reports.
    focused: bool,
    /// Shell-mode commands still running, by id, and how to stop each.
    shells: HashMap<String, oneshot::Sender<()>>,
    /// Quitting to start again in place (`/reload`).
    reload: bool,
    /// Sessions being opened, by the tag their answer comes back with.
    opens: HashMap<u64, OpenKind>,
    next_tag: u64,
    /// The last event of the active session's journal this client has, to catch up from.
    position: Option<JournalPosition>,
    /// The last position the active session's replay covers, while it arrives.
    replay_until: Option<u64>,
    /// Thumbnails of images messages carry are decoded one at a time.
    decoding: Arc<Semaphore>,
    /// The versions whose update notice the user dismissed.
    dismissed: Dismissed,
}

impl App {
    async fn run(
        &mut self,
        tui: &mut Tui,
        chat: &mut ChatWidget,
        mut events: UnboundedReceiver<HostEvent>,
        startup: Vec<AppCommand>,
    ) -> anyhow::Result<()> {
        let mut input = Input::start();
        let (app_tx, mut app_events) = mpsc::unbounded_channel();
        self.results = Some(app_tx);
        let mut frames = tokio::time::interval(FRAME_INTERVAL);
        frames.set_missed_tick_behavior(MissedTickBehavior::Skip);
        if self.execute(tui, chat, startup) {
            return Ok(());
        }
        loop {
            if self.terminal_title {
                tui.set_title(&chat.terminal_title(Instant::now()));
            }
            draw(tui, chat)?;
            tui.set_cursor_shape(chat.cursor_shape());
            let commands = tokio::select! {
                event = input.next() => match event {
                    Some(Ok(Event::FocusGained)) => {
                        self.focused = true;
                        Vec::new()
                    }
                    Some(Ok(Event::FocusLost)) => {
                        self.focused = false;
                        Vec::new()
                    }
                    Some(event) => handle_terminal_event(chat, event?),
                    None => vec![AppCommand::Quit],
                },
                Some(event) = events.recv() => {
                    let mut commands = self.host_event(chat, event);
                    // Apply a burst of streamed updates together so each frame shows several.
                    for _ in 0..EVENTS_PER_FRAME {
                        match events.try_recv() {
                            Ok(event) => commands.extend(self.host_event(chat, event)),
                            Err(_) => break,
                        }
                    }
                    commands
                }
                Some(event) = app_events.recv() => match event {
                    AppEvent::Reconnected(connection, reconnected) => {
                        events = reconnected;
                        self.reconnected(chat, *connection)
                    }
                    event => self.handle_app_event(chat, event),
                },
                _ = frames.tick(), if chat.is_animating() => {
                    chat.tick(Instant::now());
                    Vec::new()
                }
            };
            if self.execute(tui, chat, commands) {
                return Ok(());
            }
        }
    }

    /// What the Host sent, for the chat.
    fn host_event(&mut self, chat: &mut ChatWidget, event: HostEvent) -> Vec<AppCommand> {
        match event {
            HostEvent::Event(notification) => {
                // Another session's, as one just left.
                if chat.active_session() != Some(&notification.session_id) {
                    return Vec::new();
                }
                if let Some(position) = &mut self.position {
                    position.seq = notification.seq;
                }
                let replayed = self
                    .replay_until
                    .is_some_and(|until| notification.seq <= until);
                let notification = *notification;
                let mut commands = self.session_event(
                    chat,
                    notification.session_id,
                    notification.event,
                    notification.at,
                    replayed,
                );
                if self
                    .replay_until
                    .is_some_and(|until| notification.seq >= until)
                {
                    self.replay_until = None;
                    chat.replay_finished();
                }
                commands.shrink_to_fit();
                commands
            }
            // The TUI makes no pairing offers, and watches no sessions.
            HostEvent::Changed(_)
            | HostEvent::DevicePaired(_)
            | HostEvent::SessionUpdated(_)
            | HostEvent::SessionRemoved(_) => Vec::new(),
            HostEvent::UpdateAvailable(notification) => {
                if chat.active_session() == Some(&notification.session_id) {
                    chat.update_available(notification.update);
                }
                Vec::new()
            }
            HostEvent::PendingAdded(added) => {
                if chat.active_session() != Some(&added.session_id) {
                    return Vec::new();
                }
                self.pending(chat, &added.session_id, added.pending.clone())
            }
            HostEvent::PendingResolved(resolved) => {
                let elsewhere = resolved
                    .by
                    .as_ref()
                    .is_some_and(|by| by != self.handle.client_id());
                chat.handle_agent_event(ChatEvent::RequestResolved {
                    id: resolved.pending_id,
                    outcome: resolved.outcome,
                    elsewhere,
                })
            }
            HostEvent::ElicitationCompleted(completed) => chat.handle_agent_event(
                ChatEvent::ElicitationCompleted(completed.notification.elicitation_id),
            ),
            HostEvent::Opened { tag, result } => {
                let Some(kind) = self.opens.remove(&tag) else {
                    return Vec::new();
                };
                self.opened(chat, kind, result)
            }
            HostEvent::Disconnected(error) => self.disconnected(chat, error),
        }
    }

    /// A journaled event of the active session.
    fn session_event(
        &mut self,
        chat: &mut ChatWidget,
        root: SessionId,
        event: SessionEvent,
        at: u64,
        replayed: bool,
    ) -> Vec<AppCommand> {
        let event = match event {
            SessionEvent::Update { notification } => ChatEvent::SessionUpdate(*notification),
            SessionEvent::TurnStarted {
                session_id,
                prompt,
                origin,
                queued_id,
            } => {
                // The queue a session's state gave covers the replay.
                let mut commands = Vec::new();
                if let Some(id) = queued_id.clone().filter(|_| !replayed) {
                    commands = chat.handle_agent_event(ChatEvent::Unqueued { id });
                }
                // This client's own prompt is on screen already, and its turn running, unless
                // it waited in the Host's queue.
                if self.is_mine(&origin) && !replayed && queued_id.is_none() {
                    return commands;
                }
                commands.extend(chat.handle_agent_event(ChatEvent::TurnStarted {
                    session_id,
                    prompt,
                    elapsed: since(at),
                    replayed,
                }));
                return commands;
            }
            // The queue a session's state gave covers the replay.
            SessionEvent::Queued { .. }
            | SessionEvent::Unqueued { .. }
            | SessionEvent::QueuePaused { .. }
            | SessionEvent::QueueResumed { .. }
                if replayed =>
            {
                return Vec::new();
            }
            SessionEvent::Queued {
                queued_id,
                prompt,
                origin,
            } => ChatEvent::Queued {
                id: queued_id,
                text: prompt_text(&prompt),
                mine: self.is_mine(&origin),
            },
            SessionEvent::Unqueued { queued_id, .. } => ChatEvent::Unqueued { id: queued_id },
            SessionEvent::QueuePaused { .. } => ChatEvent::QueuePaused(true),
            SessionEvent::QueueResumed { .. } => ChatEvent::QueuePaused(false),
            // Shown as it joins the turn, this client's own messages too.
            SessionEvent::TurnSteered {
                session_id, prompt, ..
            } => ChatEvent::TurnSteered { session_id, prompt },
            SessionEvent::TurnEnded {
                session_id,
                response,
                error,
            } => ChatEvent::TurnEnded {
                session_id,
                result: match (response, error) {
                    (Some(response), _) => Ok(response),
                    (None, Some(error)) => Err(error),
                    (None, None) => Err(Error::internal_error().data("the turn ended unexplained")),
                },
                replayed,
            },
            SessionEvent::TerminalOutput { terminal_id, data } => ChatEvent::TerminalOutput {
                terminal_id,
                text: data,
            },
            SessionEvent::TerminalExit {
                terminal_id,
                status,
            } => ChatEvent::TerminalExited {
                terminal_id,
                status,
            },
            SessionEvent::AgentReopened {
                agent,
                previous,
                modes,
                config_options,
                failed,
            } => {
                // The new process says what prompts may carry now, and whether it steers. A
                // replay's is history: the session's state said what runs now.
                if !replayed {
                    self.agent_changed(chat, &agent);
                }
                ChatEvent::AgentReopened {
                    agent,
                    previous,
                    modes,
                    config_options,
                    failed,
                    replayed,
                }
            }
            SessionEvent::Closed { reason } if !replayed => ChatEvent::SessionEnded {
                session_id: root,
                reason,
            },
            SessionEvent::Notice { text } => ChatEvent::Notice(text),
            SessionEvent::Renamed { title, by } => ChatEvent::Renamed {
                title,
                by: match by {
                    None => "The agent".to_owned(),
                    Some(TurnOrigin::Client { id, .. }) if id == *self.handle.client_id() => {
                        "You".to_owned()
                    }
                    Some(TurnOrigin::Client { name, device, .. }) => device.unwrap_or(name),
                    Some(TurnOrigin::Run {}) => "A headless run".to_owned(),
                    Some(TurnOrigin::Session { .. }) => "Another thread".to_owned(),
                },
            },
            SessionEvent::Closed { .. } | SessionEvent::Unknown => return Vec::new(),
        };
        chat.handle_agent_event(event)
    }

    /// The Host answered an open: show the session, then what's running and waiting in it.
    fn opened(
        &mut self,
        chat: &mut ChatWidget,
        kind: OpenKind,
        result: Result<Box<weave_host_client::OpenedSession>, Error>,
    ) -> Vec<AppCommand> {
        match (kind, result) {
            (OpenKind::Open { previous }, Ok(opened)) => {
                // Let go of the session left, which closes if nothing else needs it.
                if let Some(previous) =
                    previous.filter(|previous| *previous != opened.state.session_id)
                {
                    let handle = self.handle.clone();
                    tokio::spawn(async move {
                        handle
                            .send(DetachSessionRequest {
                                session_id: previous,
                                close: CloseWhen::IfUnused,
                            })
                            .await
                    });
                }
                self.session_opened(chat, &opened)
            }
            (OpenKind::Open { previous }, Err(error)) => chat.session_failed(&error, previous),
            (OpenKind::Reattach, Ok(opened)) => {
                let reset = opened.replay.as_ref().is_some_and(|replay| replay.reset);
                if reset {
                    // The transcript here isn't the journal's any more: it starts over.
                    chat.begin_session(opened.state.session_id.clone(), None);
                    return self.session_opened(chat, &opened);
                }
                self.track(chat, &opened);
                self.agent_changed(chat, &opened.state.agent);
                chat.reattached(OpenedSession::from_state(
                    &opened.state,
                    opened.replay.as_ref(),
                ));
                chat.set_release(opened.state.agent.release.clone());
                if let Some(update) = opened.state.update.clone() {
                    chat.update_available(update);
                }
                self.show_state(chat, &opened.state)
            }
            (OpenKind::Reattach, Err(error)) => {
                chat.report_info(&format!("Couldn't reattach to the thread: {error}"));
                Vec::new()
            }
        }
    }

    /// Show a session opened for this client, before its replay arrives.
    fn session_opened(
        &mut self,
        chat: &mut ChatWidget,
        opened: &weave_host_client::OpenedSession,
    ) -> Vec<AppCommand> {
        self.cwd.clone_from(&opened.state.cwd);
        chat.set_cwd(opened.state.cwd.clone());
        self.agent_changed(chat, &opened.state.agent);
        chat.session_ready(OpenedSession::from_state(
            &opened.state,
            opened.replay.as_ref(),
        ));
        chat.set_release(opened.state.agent.release.clone());
        if let Some(update) = opened.state.update.clone() {
            chat.update_available(update);
        }
        self.track(chat, opened);
        let mut commands = self.show_state(chat, &opened.state);
        commands.extend(chat.send_kept_messages());
        commands
    }

    /// Follow what the session's agent says about itself: what prompts may carry, and
    /// whether its turns can be steered (the Host takes `turn/steer`, and the agent takes
    /// steering).
    fn agent_changed(&mut self, chat: &mut ChatWidget, agent: &SessionAgent) {
        self.prompt_capabilities = agent
            .initialize
            .agent_capabilities
            .prompt_capabilities
            .clone();
        let steerable = self
            .handle
            .hello()
            .features
            .iter()
            .any(|feature| feature == STEER_FEATURE)
            && supports_steering(&agent.initialize);
        chat.set_steerable(steerable);
    }

    /// Follow the session's journal from where `opened`'s replay starts.
    fn track(&mut self, chat: &mut ChatWidget, opened: &weave_host_client::OpenedSession) {
        // A new session's first events follow its answer too.
        let from = opened.replay.as_ref().map_or(1, |replay| replay.from);
        let head = opened.state.journal.head;
        self.position = Some(JournalPosition {
            journal: opened.state.journal.id.clone(),
            seq: from.saturating_sub(1),
        });
        self.replay_until = (head >= from).then_some(head);
        if self.replay_until.is_none() {
            chat.replay_finished();
        }
    }

    /// What's running and waiting in a session just opened.
    fn show_state(&self, chat: &mut ChatWidget, state: &SessionState) -> Vec<AppCommand> {
        let mut commands = Vec::new();
        for turn in &state.turns {
            commands.extend(chat.handle_agent_event(ChatEvent::TurnRunning {
                session_id: turn.session_id.clone(),
                elapsed: since(turn.started_at),
            }));
        }
        for pending in &state.pending {
            commands.extend(self.pending(chat, &state.session_id, pending.clone()));
        }
        let queued = state
            .queue
            .iter()
            .map(|queued| self.queued(queued))
            .collect();
        chat.set_queue(queued, state.queue_paused.is_some());
        commands
    }

    /// A prompt in the Host's queue, as the chat shows it.
    fn queued(&self, queued: &QueuedPrompt) -> Queued {
        Queued {
            id: Some(queued.id.clone()),
            text: prompt_text(&queued.prompt),
            mine: self.is_mine(&queued.origin),
        }
    }

    /// Whether this client is `origin`.
    fn is_mine(&self, origin: &TurnOrigin) -> bool {
        matches!(origin, TurnOrigin::Client { id, .. } if id == self.handle.client_id())
    }

    /// The Host went away: reconnect when it's back, unless it was in this process.
    fn disconnected(&mut self, chat: &mut ChatWidget, error: Option<Error>) -> Vec<AppCommand> {
        let Some(reconnect) = self.reconnect.clone() else {
            return chat.handle_agent_event(ChatEvent::Disconnected(error));
        };
        chat.daemon_lost();
        self.replay_until = None;
        self.spawn(async move {
            let deadline = Instant::now() + RECONNECT_WINDOW;
            loop {
                match reconnect().await {
                    Reconnection::Connected(connection, events) => {
                        return AppEvent::Reconnected(connection, events);
                    }
                    Reconnection::Incompatible(why) => return AppEvent::HostIncompatible(why),
                    Reconnection::NotYet if Instant::now() < deadline => {
                        tokio::time::sleep(RECONNECT_INTERVAL).await;
                    }
                    Reconnection::NotYet => return AppEvent::ReconnectGaveUp,
                }
            }
        });
        Vec::new()
    }

    /// Carry on over the new connection, and reattach to the session shown.
    fn reconnected(
        &mut self,
        chat: &mut ChatWidget,
        connection: HostConnection,
    ) -> Vec<AppCommand> {
        let old = std::mem::replace(&mut self.connection, connection);
        tokio::spawn(old.shutdown());
        self.handle = self.connection.handle();
        self.opens.clear();
        chat.reconnected()
    }

    fn handle_app_event(&mut self, chat: &mut ChatWidget, event: AppEvent) -> Vec<AppCommand> {
        match event {
            AppEvent::Reconnected(..) => Vec::new(),
            // The restart picked up a build this TUI doesn't match; so does a reload.
            AppEvent::HostIncompatible(why) => {
                tracing::info!(%why, "the weave Host changed; reloading");
                vec![AppCommand::Reload]
            }
            AppEvent::ReconnectGaveUp => {
                chat.reconnect_gave_up();
                Vec::new()
            }
            AppEvent::SettingChanged(change, result) => {
                chat.setting_changed(change, result);
                Vec::new()
            }
            AppEvent::SessionsListed(result, append) => {
                chat.sessions_listed(result, append);
                Vec::new()
            }
            AppEvent::SessionDeleted(session_id, result) => {
                chat.session_deleted(&session_id, result);
                Vec::new()
            }
            AppEvent::PromptFailed(error) => {
                chat.prompt_failed(&error);
                Vec::new()
            }
            AppEvent::QueueFailed(text, error) => {
                chat.queue_failed(&text, &error);
                Vec::new()
            }
            AppEvent::Unqueued(texts) => {
                chat.unqueued(&texts);
                Vec::new()
            }
            AppEvent::ResumeFailed(error) => {
                chat.report_info(&format!("Couldn't start the queue again: {error}"));
                Vec::new()
            }
            AppEvent::Steered {
                session_id,
                text,
                result,
            } => chat.steer_answered(&session_id, text, result),
            AppEvent::ImagePasted(Ok(path)) => chat.attach_image(path),
            AppEvent::ImagePasted(Err(reason)) => {
                chat.report_info(&format!("Couldn't paste an image: {reason}"));
                Vec::new()
            }
            AppEvent::ThumbnailLoaded(id, Ok(thumbnail)) => {
                chat.thumbnail_loaded(id, Some(thumbnail));
                Vec::new()
            }
            // The image is still attached or carried; it just isn't shown.
            AppEvent::ThumbnailLoaded(id, Err(error)) => {
                tracing::debug!(id, %error, "couldn't make a thumbnail");
                chat.thumbnail_loaded(id, None);
                Vec::new()
            }
            AppEvent::ShellOutput(id, text) => {
                chat.shell_output(&id, &text);
                Vec::new()
            }
            AppEvent::ShellExited(id, status) => {
                self.shells.remove(&id);
                chat.shell_exited(&id, status);
                Vec::new()
            }
            AppEvent::AgentUpdated(result) => chat.agent_updated(result),
            AppEvent::SessionReopened(session_id, result) => {
                chat.session_reopened(&session_id, result);
                Vec::new()
            }
            AppEvent::RenameFailed(error) => {
                let why = error
                    .data
                    .as_ref()
                    .and_then(serde_json::Value::as_str)
                    .map_or_else(|| error.message.clone(), str::to_owned);
                chat.report_info(&format!("Couldn't rename the thread: {why}"));
                Vec::new()
            }
        }
    }

    /// Carry out commands, and any they lead to. Returns whether the user quit.
    fn execute(&mut self, tui: &mut Tui, chat: &mut ChatWidget, commands: Vec<AppCommand>) -> bool {
        let mut queue: VecDeque<AppCommand> = commands.into();
        while let Some(command) = queue.pop_front() {
            match command {
                AppCommand::Prompt(text) => {
                    let Some(session_id) = chat.active_session().cloned() else {
                        continue;
                    };
                    let images = chat.prompt_images(&text);
                    let (prompt, attachments) =
                        prompt_blocks(&text, &self.cwd, &self.prompt_capabilities, &images);
                    chat.note_attachments(&attachments);
                    let handle = self.handle.clone();
                    self.spawn_unless_ok(async move {
                        handle
                            .send(StartTurnRequest {
                                session_id,
                                prompt,
                                key: None,
                            })
                            .await
                            .err()
                            .map(AppEvent::PromptFailed)
                    });
                }
                AppCommand::Enqueue(text) => {
                    let Some(session_id) = chat.active_session().cloned() else {
                        continue;
                    };
                    // What it attaches shows in the message once its turn starts.
                    let images = chat.prompt_images(&text);
                    let (prompt, _) =
                        prompt_blocks(&text, &self.cwd, &self.prompt_capabilities, &images);
                    let handle = self.handle.clone();
                    self.spawn_unless_ok(async move {
                        handle
                            .send(AddQueuedRequest {
                                session_id,
                                prompt,
                                key: None,
                            })
                            .await
                            .err()
                            .map(|error| AppEvent::QueueFailed(text, error))
                    });
                }
                AppCommand::Unqueue(ids) => {
                    let Some(session_id) = chat.active_session().cloned() else {
                        continue;
                    };
                    let handle = self.handle.clone();
                    self.spawn(async move {
                        // One at a time, so they come back in order.
                        let mut texts = Vec::new();
                        for queued_id in ids {
                            let removed = handle
                                .send(RemoveQueuedRequest {
                                    session_id: session_id.clone(),
                                    queued_id,
                                })
                                .await;
                            if let Ok(Some(removed)) = removed.map(|answer| answer.removed) {
                                texts.push(prompt_text(&removed.prompt));
                            }
                        }
                        AppEvent::Unqueued(texts)
                    });
                }
                AppCommand::ResumeQueue => {
                    let Some(session_id) = chat.active_session().cloned() else {
                        continue;
                    };
                    let handle = self.handle.clone();
                    self.spawn_unless_ok(async move {
                        handle
                            .send(ResumeQueueRequest { session_id })
                            .await
                            .err()
                            .map(AppEvent::ResumeFailed)
                    });
                }
                AppCommand::Steer(text) => {
                    let Some(session_id) = chat.active_session().cloned() else {
                        continue;
                    };
                    // What it attaches shows in the message once it joins the turn.
                    let images = chat.prompt_images(&text);
                    let (prompt, _) =
                        prompt_blocks(&text, &self.cwd, &self.prompt_capabilities, &images);
                    let handle = self.handle.clone();
                    self.spawn(async move {
                        let result = handle
                            .send(SteerTurnRequest {
                                session_id: session_id.clone(),
                                prompt,
                            })
                            .await;
                        AppEvent::Steered {
                            session_id,
                            text,
                            result,
                        }
                    });
                }
                AppCommand::Cancel => {
                    if let Some(session_id) = chat.active_session().cloned() {
                        self.cancel(session_id);
                    }
                }
                // A subagent's cancel is the ordinary one, for its session.
                AppCommand::CancelSubagent(session_id) => self.cancel(session_id),
                AppCommand::ChangeSetting(change) => {
                    if let Some(session_id) = chat.active_session().cloned() {
                        self.spawn_setting_change(session_id, change);
                    }
                }
                AppCommand::ListSessions {
                    all_directories,
                    cursor,
                } => {
                    let request = ListSessionsRequest {
                        agent_id: Some(self.agent_id.clone()),
                        cwd: (!all_directories).then(|| self.cwd.clone()),
                        repo: None,
                        cursor: cursor.clone(),
                    };
                    let append = cursor.is_some();
                    let handle = self.handle.clone();
                    self.spawn(async move {
                        AppEvent::SessionsListed(handle.send(request).await, append)
                    });
                }
                AppCommand::OpenSession { target, title, cwd } => {
                    queue.extend(self.open_session(chat, target, title, cwd));
                }
                AppCommand::DeleteSession(session_id) => {
                    let handle = self.handle.clone();
                    let request = DeleteSessionRequest {
                        session_id: session_id.clone(),
                        agent_id: Some(self.agent_id.clone()),
                    };
                    self.spawn(async move {
                        let result = handle.send(request).await.map(drop);
                        AppEvent::SessionDeleted(session_id, result)
                    });
                }
                AppCommand::AnswerPermission { id, response } => {
                    self.answer(chat, id, |request| AnswerPendingRequest {
                        permission: Some(response),
                        ..request
                    });
                }
                AppCommand::AnswerElicitation { id, response } => {
                    self.answer(chat, id, |request| AnswerPendingRequest {
                        elicitation: Some(response),
                        ..request
                    });
                }
                AppCommand::OpenUrl(url) => open_in_browser(&url),
                AppCommand::RunShell { id, command } => {
                    if let Some(results) = self.results.clone() {
                        let (kill, killed) = oneshot::channel();
                        self.shells.insert(id.clone(), kill);
                        let cwd = self.cwd.clone();
                        tokio::spawn(run_shell(id, command, cwd, results, killed));
                    }
                }
                AppCommand::PasteImage => {
                    self.spawn(async {
                        let saved = tokio::task::spawn_blocking(clipboard::save_image).await;
                        AppEvent::ImagePasted(saved.unwrap_or_else(|error| Err(error.to_string())))
                    });
                }
                AppCommand::LoadThumbnail { id, path } => {
                    self.spawn(async move {
                        let loaded =
                            tokio::task::spawn_blocking(move || Thumbnail::load(&path)).await;
                        AppEvent::ThumbnailLoaded(
                            id,
                            loaded.unwrap_or_else(|error| Err(error.to_string())),
                        )
                    });
                }
                AppCommand::DecodeThumbnail { id, data } => {
                    let queue = Arc::clone(&self.decoding);
                    self.spawn(async move {
                        // One at a time, so a replay's images don't all decode at once.
                        let _turn = queue.acquire_owned().await;
                        let decoded =
                            tokio::task::spawn_blocking(move || Thumbnail::from_base64(&data))
                                .await;
                        AppEvent::ThumbnailLoaded(
                            id,
                            decoded.unwrap_or_else(|error| Err(error.to_string())),
                        )
                    });
                }
                AppCommand::KillShell(id) => {
                    if let Some(kill) = self.shells.remove(&id) {
                        let _ = kill.send(());
                    }
                }
                AppCommand::Copy(text) => tui.copy(&text),
                AppCommand::RunClientTool {
                    session_id,
                    pending_id,
                    tool,
                    arguments,
                } => {
                    let result = run_client_tool(tui, &tool, &arguments);
                    self.answer_client_tool(session_id, pending_id, result);
                }
                // As Codex, only while the terminal isn't in front of the user.
                AppCommand::Notify(message) => {
                    if self.notifications && !self.focused {
                        tui.notify(&message);
                    }
                }
                AppCommand::Quit => return true,
                AppCommand::Reload => {
                    self.reload = true;
                    return true;
                }
                AppCommand::UpdateAgent => {
                    let handle = self.handle.clone();
                    let request = UpdateAgentRequest {
                        agent_id: self.agent_id.clone(),
                    };
                    self.spawn(async move {
                        let result = handle.send(request).await;
                        AppEvent::AgentUpdated(result.map(|response| response.version))
                    });
                }
                AppCommand::ReopenSession(session_id) => {
                    let handle = self.handle.clone();
                    self.spawn(async move {
                        let result = handle
                            .send(ReopenSessionRequest {
                                session_id: session_id.clone(),
                            })
                            .await
                            .map(drop);
                        AppEvent::SessionReopened(session_id, result)
                    });
                }
                AppCommand::Rename { session_id, title } => {
                    let handle = self.handle.clone();
                    self.spawn_unless_ok(async move {
                        let request = RenameSessionRequest { session_id, title };
                        handle.send(request).await.err().map(AppEvent::RenameFailed)
                    });
                }
                AppCommand::DismissUpdate { agent_id, version } => {
                    self.dismissed.dismiss(&agent_id, &version);
                }
                AppCommand::Reattach(session_id) => {
                    let request = AttachSessionRequest {
                        session_id,
                        after: self.position.clone(),
                        agent_id: Some(self.agent_id.clone()),
                        cwd: Some(self.cwd.clone()),
                        trace: self.trace,
                    };
                    if let Err(error) = self.request_open(Open::Attach(request), OpenKind::Reattach)
                    {
                        chat.report_info(&format!("Couldn't reattach to the thread: {error}"));
                    }
                }
            }
        }
        false
    }

    /// Open `target`: a new session, or an existing one, whose events show from now on.
    fn open_session(
        &mut self,
        chat: &mut ChatWidget,
        target: SessionTarget,
        title: Option<String>,
        cwd: Option<PathBuf>,
    ) -> Vec<AppCommand> {
        let previous = chat.active_session().cloned();
        let open = match target {
            SessionTarget::New => Open::Create(CreateSessionRequest {
                agent_id: self.agent_id.clone(),
                cwd: self.cwd.clone(),
                additional_directories: self.additional_directories.clone(),
                mode: None,
                policy: None,
                trace: self.trace,
            }),
            SessionTarget::Existing(session_id) => {
                let title = title.unwrap_or_else(|| session_id.to_string());
                chat.begin_session(session_id.clone(), Some(&title));
                // A session from another directory reopens in its own.
                Open::Attach(AttachSessionRequest {
                    session_id,
                    after: None,
                    agent_id: Some(self.agent_id.clone()),
                    cwd: Some(cwd.unwrap_or_else(|| self.cwd.clone())),
                    trace: self.trace,
                })
            }
        };
        self.position = None;
        self.replay_until = None;
        match self.request_open(
            open,
            OpenKind::Open {
                previous: previous.clone(),
            },
        ) {
            Ok(()) => Vec::new(),
            Err(error) => chat.session_failed(&error, previous),
        }
    }

    fn request_open(&mut self, open: Open, kind: OpenKind) -> Result<(), Error> {
        let tag = self.next_tag;
        self.next_tag += 1;
        self.opens.insert(tag, kind);
        let sent = self.handle.open(open, tag);
        if sent.is_err() {
            self.opens.remove(&tag);
        }
        sent
    }

    fn cancel(&self, session_id: SessionId) {
        let handle = self.handle.clone();
        tokio::spawn(async move {
            if let Err(error) = handle.send(CancelTurnRequest { session_id }).await {
                tracing::warn!(%error, "failed to cancel the turn");
            }
        });
    }

    /// A pending request of the active session: one to show, or a client tool call to run
    /// when it's for this client. Other clients' calls are theirs to run.
    fn pending(
        &self,
        chat: &mut ChatWidget,
        session_id: &SessionId,
        pending: PendingRequest,
    ) -> Vec<AppCommand> {
        if let PendingKind::ClientTool {
            tool,
            arguments,
            target,
        } = pending.request
        {
            if target != *self.handle.client_id() {
                return Vec::new();
            }
            return vec![AppCommand::RunClientTool {
                session_id: session_id.clone(),
                pending_id: pending.id,
                tool,
                arguments,
            }];
        }
        pending_event(pending).map_or_else(Vec::new, |event| chat.handle_agent_event(event))
    }

    /// Answer a client tool call with what running it here gave.
    fn answer_client_tool(
        &self,
        session_id: SessionId,
        pending_id: String,
        result: ClientToolResult,
    ) {
        let handle = self.handle.clone();
        tokio::spawn(async move {
            let request = AnswerPendingRequest {
                session_id,
                pending_id,
                permission: None,
                elicitation: None,
                client_tool: Some(result),
            };
            if let Err(error) = handle.send(request).await
                && !errors::is(&error, errors::ALREADY_RESOLVED)
            {
                tracing::warn!(%error, "couldn't answer the agent's client tool call");
            }
        });
    }

    /// Answer a pending request of the active session. Another client may have answered it
    /// first, which is no failure.
    fn answer(
        &self,
        chat: &ChatWidget,
        pending_id: String,
        fill: impl FnOnce(AnswerPendingRequest) -> AnswerPendingRequest,
    ) {
        let Some(session_id) = chat.active_session().cloned() else {
            return;
        };
        let request = fill(AnswerPendingRequest {
            session_id,
            pending_id,
            permission: None,
            elicitation: None,
            client_tool: None,
        });
        let handle = self.handle.clone();
        tokio::spawn(async move {
            match handle.send(request).await {
                Err(error) if !errors::is(&error, errors::ALREADY_RESOLVED) => {
                    tracing::warn!(%error, "couldn't answer the agent's request");
                }
                _ => {}
            }
        });
    }

    fn spawn_setting_change(&self, session_id: SessionId, change: SettingChange) {
        let handle = self.handle.clone();
        self.spawn(async move {
            let result = match &change {
                SettingChange::ConfigOption(config_id, value) => handle
                    .send(SetConfigOptionRequest {
                        session_id,
                        config_id: config_id.clone(),
                        value: value.clone(),
                    })
                    .await
                    .map(|response| Some(response.config_options)),
                SettingChange::Mode(mode_id) => handle
                    .send(SetModeRequest {
                        session_id,
                        mode_id: mode_id.clone(),
                    })
                    .await
                    .map(|_| None),
            };
            AppEvent::SettingChanged(change, result)
        });
    }

    fn spawn(&self, task: impl Future<Output = AppEvent> + Send + 'static) {
        if let Some(results) = self.results.clone() {
            tokio::spawn(async move {
                let _ = results.send(task.await);
            });
        }
    }

    /// Run `task`, reporting back only what it says to.
    fn spawn_unless_ok(&self, task: impl Future<Output = Option<AppEvent>> + Send + 'static) {
        if let Some(results) = self.results.clone() {
            tokio::spawn(async move {
                if let Some(event) = task.await {
                    let _ = results.send(event);
                }
            });
        }
    }
}

/// A pending request, as the chat shows it; client tool calls it doesn't.
fn pending_event(pending: PendingRequest) -> Option<ChatEvent> {
    match pending.request {
        PendingKind::Permission { request } => {
            Some(ChatEvent::PermissionRequested(PermissionAsk {
                id: pending.id,
                request,
            }))
        }
        PendingKind::Elicitation { request } => {
            Some(ChatEvent::ElicitationRequested(ElicitationAsk {
                id: pending.id,
                request,
            }))
        }
        PendingKind::ClientTool { .. } => None,
    }
}

/// Run a client tool here, for the agent.
fn run_client_tool(
    tui: &mut Tui,
    tool: &str,
    arguments: &serde_json::Map<String, serde_json::Value>,
) -> ClientToolResult {
    match tool {
        CLIPBOARD_WRITE => match arguments.get("text").and_then(serde_json::Value::as_str) {
            Some(text) => match tui.try_copy(text) {
                Ok(()) => ClientToolResult::text("Copied to the clipboard."),
                Err(why) => ClientToolResult::error(why),
            },
            None => ClientToolResult::error("clipboard_write needs `text`, a string."),
        },
        _ => ClientToolResult::error(format!("This client doesn't run {tool}.")),
    }
}

/// How long ago `at` was.
/// What a queued prompt says, as the composer would hold it: its text, and a placeholder for
/// each image.
fn prompt_text(prompt: &[ContentBlock]) -> String {
    let mut images = 0;
    let parts: Vec<String> = prompt
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text(text) => Some(text.text.clone()),
            ContentBlock::Image(_) => {
                images += 1;
                Some(format!("[image {images}]"))
            }
            _ => None,
        })
        .collect();
    parts.join(" ")
}

fn since(at: u64) -> Duration {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        });
    Duration::from_millis(now.saturating_sub(at))
}

/// Run a shell-mode command in `cwd`, streaming its output (stdout and stderr together, as
/// a terminal shows them) until it exits or `killed` fires.
async fn run_shell(
    id: String,
    command: String,
    cwd: PathBuf,
    results: mpsc::UnboundedSender<AppEvent>,
    killed: oneshot::Receiver<()>,
) {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "sh".to_owned());
    let spawned = tokio::process::Command::new(&shell)
        .arg("-c")
        .arg(&command)
        .current_dir(&cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn();
    let mut child = match spawned {
        Ok(child) => child,
        Err(error) => {
            let _ = results.send(AppEvent::ShellOutput(
                id.clone(),
                format!("{shell}: {error}\n"),
            ));
            let status = TerminalExitStatus::new().exit_code(127);
            let _ = results.send(AppEvent::ShellExited(id, status));
            return;
        }
    };
    let forward = |stream: Option<Box<dyn tokio::io::AsyncRead + Unpin + Send>>| {
        let results = results.clone();
        let id = id.clone();
        tokio::spawn(async move {
            use tokio::io::AsyncReadExt;
            let Some(mut stream) = stream else {
                return;
            };
            let mut buffer = [0_u8; 4096];
            while let Ok(read) = stream.read(&mut buffer).await {
                if read == 0 {
                    break;
                }
                let text = String::from_utf8_lossy(&buffer[..read]).into_owned();
                if results
                    .send(AppEvent::ShellOutput(id.clone(), text))
                    .is_err()
                {
                    break;
                }
            }
        })
    };
    let stdout = forward(child.stdout.take().map(|out| Box::new(out) as _));
    let stderr = forward(child.stderr.take().map(|err| Box::new(err) as _));
    let status = tokio::select! {
        status = child.wait() => status,
        _ = killed => {
            let _ = child.start_kill();
            child.wait().await
        }
    };
    // All output is in before the exit is reported.
    let _ = stdout.await;
    let _ = stderr.await;
    let status = match status {
        Ok(status) => exit_status(status),
        Err(error) => {
            let _ = results.send(AppEvent::ShellOutput(id.clone(), format!("{error}\n")));
            TerminalExitStatus::new().exit_code(1)
        }
    };
    let _ = results.send(AppEvent::ShellExited(id, status));
}

fn exit_status(status: std::process::ExitStatus) -> TerminalExitStatus {
    #[cfg(unix)]
    let signal = {
        use std::os::unix::process::ExitStatusExt;
        status.signal().map(|signal| match signal {
            1 => "SIGHUP".to_owned(),
            2 => "SIGINT".to_owned(),
            9 => "SIGKILL".to_owned(),
            15 => "SIGTERM".to_owned(),
            other => format!("signal {other}"),
        })
    };
    #[cfg(not(unix))]
    let signal = None;
    TerminalExitStatus::new()
        .exit_code(status.code().and_then(|code| u32::try_from(code).ok()))
        .signal(signal)
}

/// Open a URL the user explicitly consented to, in their default browser. Nothing here fetches it.
fn open_in_browser(url: &str) {
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("open");
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = std::process::Command::new("xdg-open");
    #[cfg(windows)]
    let mut command = {
        let mut command = std::process::Command::new("cmd");
        command.args(["/C", "start", ""]);
        command
    };
    let spawned = command
        .arg(url)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
    if let Err(error) = spawned {
        tracing::warn!(%error, "failed to open the browser");
    }
}

fn handle_terminal_event(chat: &mut ChatWidget, event: Event) -> Vec<AppCommand> {
    match event {
        Event::Key(key) if matches!(key.kind, KeyEventKind::Press | KeyEventKind::Repeat) => {
            chat.handle_key(key)
        }
        Event::Paste(text) => chat.handle_paste(&text),
        Event::Mouse(event) => chat.handle_mouse(event),
        Event::Resize(width, height) => {
            chat.set_size(width, height);
            Vec::new()
        }
        _ => Vec::new(),
    }
}

fn draw(tui: &mut Tui, chat: &mut ChatWidget) -> std::io::Result<()> {
    // Inline mode shows the Ctrl+T transcript on the alternate screen, as Codex's pager.
    if tui.mode() == ScreenMode::Inline && chat.overlay_open() {
        tui.enter_overlay()?;
        return tui.draw_screen(|frame| {
            let area = frame.area();
            chat.render_pager(area, frame.buffer_mut());
        });
    }
    if tui.overlay_open() {
        tui.leave_overlay()?;
    }
    if tui.shows_images() {
        let width = tui.size()?.width;
        thumbnails::set_cell_size(tui.cell_size());
        tui.set_images(chat.terminal_images(width));
    }
    if tui.mode() == ScreenMode::Fullscreen {
        return tui.draw_screen(|frame| {
            let area = frame.area();
            if let Some(cursor) = chat.render_screen(area, frame.buffer_mut()) {
                frame.set_cursor_position(cursor);
            }
        });
    }
    let width = tui.size()?.width;
    let history = chat.take_history();
    let height = chat.desired_height(width);
    tui.draw(history, height, |frame| {
        let area = frame.area();
        if let Some(cursor) = chat.render(area, frame.buffer_mut()) {
            frame.set_cursor_position(cursor);
        }
    })
}
