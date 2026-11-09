//! The event loop: terminal input and the Host's messages in, frames and Host requests out.
//!
//! Requests whose answers the UI waits on (settings, thread lists) run on their own tasks
//! and report back as [`AppEvent`]s, so the loop never blocks on the Host. Opening a thread
//! answers on the Host connection's own channel instead, in order with the thread's events,
//! so the transcript is ready for the replay that follows.

use std::collections::HashMap;
use std::collections::VecDeque;
use std::io::IsTerminal;
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
use weave_acp_core::schema::AgentCapabilities;
use weave_acp_core::schema::ContentBlock;
use weave_acp_core::schema::Error;
use weave_acp_core::schema::InitializeResponse;
use weave_acp_core::schema::PromptCapabilities;
use weave_acp_core::schema::SessionConfigOption;
use weave_acp_core::schema::TerminalExitStatus;
use weave_acp_core::supports_steering;
use weave_host_client::HostConnection;
use weave_host_client::HostEvent;
use weave_host_client::HostHandle;
use weave_host_client::Open;
use weave_host_protocol::agents::UPDATES_FEATURE;
use weave_host_protocol::agents::UpdateAgentRequest;
use weave_host_protocol::errors;
use weave_host_protocol::events::ThreadEvent;
use weave_host_protocol::mcp::FEATURE as MCP_SERVERS_FEATURE;
use weave_host_protocol::pending::AnswerPendingRequest;
use weave_host_protocol::pending::PendingKind;
use weave_host_protocol::pending::PendingRequest;
use weave_host_protocol::queue::AddQueuedRequest;
use weave_host_protocol::queue::FEATURE as QUEUE_FEATURE;
use weave_host_protocol::queue::QueuedPrompt;
use weave_host_protocol::queue::RemoveQueuedRequest;
use weave_host_protocol::queue::ResumeQueueRequest;
use weave_host_protocol::terminals::CloseTerminalRequest;
use weave_host_protocol::terminals::FEATURE as TERMINALS_FEATURE;
use weave_host_protocol::terminals::FormatTerminalRequest;
use weave_host_protocol::terminals::NewTerminalRequest;
use weave_host_protocol::terminals::SetTerminalLabelRequest;
use weave_host_protocol::terminals::Terminal;
use weave_host_protocol::terminals::TerminalFormat;
use weave_host_protocol::terminals::UnwatchTerminalsRequest;
use weave_host_protocol::terminals::WatchTerminalsRequest;
use weave_host_protocol::terminals::WriteTerminalRequest;
use weave_host_protocol::threads::AttachThreadRequest;
use weave_host_protocol::threads::CloseWhen;
use weave_host_protocol::threads::CreateThreadRequest;
use weave_host_protocol::threads::DeleteThreadRequest;
use weave_host_protocol::threads::DetachThreadRequest;
use weave_host_protocol::threads::JournalPosition;
use weave_host_protocol::threads::ListThreadsRequest;
use weave_host_protocol::threads::ListThreadsResponse;
use weave_host_protocol::threads::RENAME_FEATURE;
use weave_host_protocol::threads::RenameThreadRequest;
use weave_host_protocol::threads::ReopenThreadRequest;
use weave_host_protocol::threads::SetConfigOptionRequest;
use weave_host_protocol::threads::SetModeRequest;
use weave_host_protocol::threads::ThreadAgent;
use weave_host_protocol::threads::ThreadId;
use weave_host_protocol::threads::ThreadState;
use weave_host_protocol::threads::TurnOrigin;
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
use crate::chat::ThreadAbilities;
use crate::clipboard;
use crate::events::ChatEvent;
use crate::events::ElicitationAsk;
use crate::events::PermissionAsk;
use crate::footer::StatusItem;
use crate::input::Input;
use crate::links;
use crate::markdown;
use crate::markdown::Rendering;
use crate::rex::Pane;
use crate::rex::Rex;
use crate::runs;
use crate::settings::SettingChange;
use crate::thread::OpenedThread;
use crate::thread::ThreadTarget;
use crate::thumbnails;
use crate::thumbnails::Thumbnail;
use crate::tui::ScreenMode;
use crate::tui::Tui;
use crate::updates::Dismissed;

/// How long to wait for the weave Host to come back after it went away.
const RECONNECT_WINDOW: Duration = Duration::from_secs(15);
/// How often to look for it meanwhile.
const RECONNECT_INTERVAL: Duration = Duration::from_millis(250);
/// How long quitting waits for a blank thread to close; the Host closes it later anyway.
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
pub struct Connected {
    pub connection: HostConnection,
    pub events: UnboundedReceiver<HostEvent>,
    /// The agent this client's threads run with, by id.
    pub agent_id: String,
    pub agent_name: String,
    pub agent_version: Option<String>,
    /// What the agent said about itself: what prompts may carry, which thread methods it has.
    pub agent: InitializeResponse,
    /// Where new threads work, until an opened thread says otherwise.
    pub cwd: PathBuf,
    pub additional_directories: Vec<PathBuf>,
    /// Have the Host trace threads opened from here.
    pub trace: bool,
    /// The thread to start in, opened already, or `None` to start in the thread picker.
    pub opened: Option<weave_host_client::OpenedThread>,
    /// Things worth telling the user at startup.
    pub notices: Vec<String>,
    /// The Host the thread is on, when it's another computer's, reached through the Dispatcher
    /// (WVE-195): the status line names it. Its directories aren't this computer's, so the
    /// terminal isn't told them, and its terminals don't show in Rex panes here.
    pub host: Option<String>,
}

/// How the client looks.
pub struct UiOptions {
    pub screen: ScreenMode,
    /// What the footer's status line shows; empty shows `? for shortcuts` instead.
    pub status_line: Vec<StatusItem>,
    /// Desktop notifications when a turn ends or the agent needs you, while unfocused.
    pub notifications: bool,
    /// Keep the window title on the thread and what the agent is doing.
    pub terminal_title: bool,
    /// The Vim composer, for new blank threads and multi-line drafts.
    pub vim: bool,
    /// Show pasted images above the composer, where the terminal draws images.
    pub images: bool,
    /// What agent Markdown is drawn as: Mermaid diagrams and math, or their source.
    pub rendering: Rendering,
    /// Threads outlive the TUI, in the weave Host: leaving with Ctrl+D keeps a turn running.
    pub detachable: bool,
    /// How to reach the weave Host again when it goes away; none for one in this process.
    pub reconnect: Option<Reconnector>,
    /// Where the versions whose update notice the user dismissed are kept; none keeps them
    /// for this run only.
    pub dismissed_updates: Option<PathBuf>,
}

/// How the client ended.
pub struct Exit {
    /// The thread to offer reopening: the active one, if it had a conversation.
    pub resumable_thread: Option<ThreadId>,
    /// Whether its turn was still running, to carry on in the weave Host.
    pub turn_running: bool,
    /// `/reload`: start again in place, reattaching to `active_thread`.
    pub reload: bool,
    /// The thread shown when it ended, conversation or not.
    pub active_thread: Option<ThreadId>,
}

/// Results of requests the loop made off the UI thread.
enum AppEvent {
    SettingChanged(
        SettingChange,
        Result<Option<Vec<SessionConfigOption>>, Error>,
    ),
    ThreadsListed(Result<ListThreadsResponse, Error>, bool),
    ThreadDeleted(ThreadId, Result<(), Error>),
    PromptFailed(Error),
    /// The Host's answer to a message steered into a thread's turn.
    Steered {
        thread_id: ThreadId,
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
    /// The Host's answer to `/update`'s `agents/update`: the version new threads get.
    AgentUpdated(Result<String, Error>),
    /// The Host's answer to `thread/reopen`.
    ThreadReopened(ThreadId, Result<(), Error>),
    /// `/rename` failed; a rename that worked shows as its `renamed` event.
    RenameFailed(Error),
    /// The Host couldn't queue a message, which goes back to the draft.
    QueueFailed(String, Error),
    /// This client's queued messages the Host took out for editing, in order.
    Unqueued(Vec<String>),
    /// `/queue` failed.
    ResumeFailed(Error),
    /// The worktree's terminals, as `terminals/watch` answered: its scope and its terminals.
    TerminalsWatched(Result<(PathBuf, Vec<Terminal>), Error>),
    /// The terminals' Rex panes now, or why Rex didn't do what was asked.
    Panes(Result<Vec<Pane>, String>),
    /// A terminal the thread panel started, to show.
    TerminalStarted(Result<Terminal, Error>),
    /// A terminal's screen as text, by its id, or why it couldn't be read.
    TerminalRead(String, Result<String, String>),
    /// Something asked of a terminal failed.
    TerminalFailed(String),
}

/// Why a thread is being opened, for when the Host answers.
enum OpenKind {
    /// Switching to it (or starting in it), leaving `previous`.
    Open { previous: Option<ThreadId> },
    /// Back to the thread shown, after reconnecting.
    Reattach,
}

/// Run the interactive client until the user quits, then close the connection.
pub async fn run(connected: Connected, ui: UiOptions) -> anyhow::Result<Exit> {
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
    links::set_label_only(links::label_only_for(
        |name| std::env::var(name).ok(),
        std::io::stdout().is_terminal(),
    ));
    let Connected {
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
        host,
    } = connected;
    let abilities = ThreadAbilities {
        // The Host lists threads whatever the agent offers.
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
    let reports_mcp_servers = connection
        .hello()
        .features
        .iter()
        .any(|feature| feature == MCP_SERVERS_FEATURE);
    let has_terminals = connection
        .hello()
        .features
        .iter()
        .any(|feature| feature == TERMINALS_FEATURE);
    // Terminals show in Rex panes only when another process can attach to the Host's.
    // A pane's `weave terminals attach` reaches this computer's Host only.
    let rex = (has_terminals && detachable && host.is_none())
        .then(Rex::detect)
        .flatten();
    let elsewhere = host.is_some();
    let mut tui = Tui::init(screen, images)?;
    let size = tui.size()?;
    // The thread works where the Host says, and so does this client.
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
        .with_mcp_servers(reports_mcp_servers)
        .with_rex(rex.is_some())
        .with_host(host)
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
        closing: false,
        reopenable: reopenable(&agent.agent_capabilities),
        opens: HashMap::new(),
        next_tag: 1,
        position: None,
        replay_until: None,
        decoding: Arc::new(Semaphore::new(1)),
        dismissed,
        has_terminals,
        watched: None,
        watch_pending: false,
        rex,
        panes: Vec::new(),
        closed_elsewhere: false,
        elsewhere,
    };
    let startup = match opened {
        Some(opened) => {
            chat.begin_thread(opened.state.thread_id.clone(), None);
            app.thread_opened(&mut chat, &opened)
        }
        None => chat.open_thread_picker(true),
    };
    chat.push_header(agent_version.as_deref(), &notices);
    let result = app.run(&mut tui, &mut chat, events, startup).await;
    tui.exit();
    // A blank thread has nothing to come back to, and one the person is done with
    // (`/exit`, Ctrl+C) opens again from the agent's history, so either closes once nothing
    // else needs it and its agent stops, rather than when the Host's grace for it ends. A
    // reload reattaches instead, and Ctrl+D leaves it open.
    let closing = chat
        .thread_to_close(app.closing, app.reopenable)
        .filter(|_| !app.reload)
        .cloned();
    if let Some(thread_id) = closing {
        let close = app.handle.send(DetachThreadRequest {
            thread_id,
            close: CloseWhen::IfUnused,
        });
        if let Ok(Err(error)) = tokio::time::timeout(CLOSE_ON_QUIT_TIMEOUT, close).await {
            tracing::debug!(%error, "couldn't close the thread");
        }
    }
    app.connection.shutdown().await;
    if app.closed_elsewhere
        && let Some(rex) = app.rex.clone()
    {
        // Its terminal panes go with it, their terminals still running, and then its own pane
        // if nothing else is in its tab.
        let panes = std::mem::take(&mut app.panes);
        let _ = tokio::task::spawn_blocking(move || {
            for pane in &panes {
                let _ = rex.hide(&panes, &pane.terminal);
            }
            rex.close_if_alone();
        })
        .await;
    }
    result.map(|()| Exit {
        resumable_thread: chat.resumable_thread().cloned(),
        turn_running: chat.turn_running(),
        reload: app.reload,
        active_thread: chat.active_thread().cloned(),
    })
}

struct App {
    handle: HostHandle,
    /// The connection to the Host; replaced when it reconnects.
    connection: HostConnection,
    reconnect: Option<Reconnector>,
    agent_id: String,
    /// Where the active thread works.
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
    /// Quitting done with the thread: `/exit` or Ctrl+C rather than Ctrl+D.
    closing: bool,
    /// The thread's agent can open it again once it's closed, by loading or resuming it.
    reopenable: bool,
    /// Threads being opened, by the tag their answer comes back with.
    opens: HashMap<u64, OpenKind>,
    next_tag: u64,
    /// The last event of the active thread's journal this client has, to catch up from.
    position: Option<JournalPosition>,
    /// The last position the active thread's replay covers, while it arrives.
    replay_until: Option<u64>,
    /// Thumbnails of images messages carry are decoded one at a time.
    decoding: Arc<Semaphore>,
    /// The versions whose update notice the user dismissed.
    dismissed: Dismissed,
    /// The Host has terminals (feature `terminals`).
    has_terminals: bool,
    /// The worktree whose terminals this client watches.
    watched: Option<PathBuf>,
    /// Watch them once the app runs: a thread opened before it did.
    watch_pending: bool,
    /// The Rex pane this TUI runs in, which shows terminals in panes beside it.
    rex: Option<Rex>,
    /// The terminals' panes, in the order placed.
    panes: Vec<Pane>,
    /// Another client closed the thread for everyone, so this TUI quits, and leaves Rex as it
    /// found it.
    closed_elsewhere: bool,
    /// The Host is another computer's, whose directories the terminal isn't told.
    elsewhere: bool,
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
        self.find_panes();
        if std::mem::take(&mut self.watch_pending) {
            self.watch_terminals();
        }
        let mut frames = tokio::time::interval(FRAME_INTERVAL);
        frames.set_missed_tick_behavior(MissedTickBehavior::Skip);
        if self.execute(tui, chat, startup) {
            return Ok(());
        }
        loop {
            if self.terminal_title {
                tui.set_title(&chat.terminal_title(Instant::now()));
            }
            tui.set_program_status(chat.program_status());
            if chat.active_thread().is_some() && !self.elsewhere {
                tui.set_directory(&self.cwd);
            }
            draw(tui, chat)?;
            tui.set_cursor_shape(chat.cursor_shape());
            let commands = tokio::select! {
                event = input.next() => match event {
                    Some(Ok(Event::FocusGained)) => {
                        self.focused = true;
                        chat.focus_gained();
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
                // Another thread's, as one just left.
                if chat.active_thread() != Some(&notification.thread_id) {
                    return Vec::new();
                }
                if let Some(position) = &mut self.position {
                    position.seq = notification.seq;
                }
                let replayed = self
                    .replay_until
                    .is_some_and(|until| notification.seq <= until);
                let notification = *notification;
                let mut commands = self.thread_event(
                    chat,
                    notification.thread_id,
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
            HostEvent::Changed(changed) => {
                if chat.active_thread() == Some(&changed.thread_id)
                    && let Some(servers) = changed.mcp_servers
                {
                    chat.set_mcp_servers(servers);
                }
                Vec::new()
            }
            HostEvent::TerminalUpdated(updated) => {
                if self.watched.as_ref() == Some(&updated.terminal.scope) {
                    chat.terminal_updated(updated.terminal);
                }
                Vec::new()
            }
            HostEvent::TerminalRemoved(removed) => {
                if self.watched.as_ref() == Some(&removed.scope) {
                    chat.terminal_removed(&removed.id);
                }
                // Its pane closes as its attach ends.
                self.panes.retain(|pane| pane.terminal != removed.id);
                Vec::new()
            }
            // What the TUI doesn't ask for: watching threads and Sessions, and calls to a
            // service.
            HostEvent::ThreadUpdated(_)
            | HostEvent::ThreadRemoved(_)
            | HostEvent::SessionUpdated(_)
            | HostEvent::SessionEnded(_)
            | HostEvent::ToolCall(_)
            | HostEvent::HostCall(_)
            | HostEvent::ToolCallCancelled(_) => Vec::new(),
            HostEvent::UpdateAvailable(notification) => {
                if chat.active_thread() == Some(&notification.thread_id) {
                    chat.update_available(notification.update);
                }
                Vec::new()
            }
            HostEvent::PendingAdded(added) => {
                if chat.active_thread() != Some(&added.thread_id) {
                    return Vec::new();
                }
                self.pending(chat, &added.thread_id, added.pending.clone())
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

    /// A journaled event of the active thread.
    fn thread_event(
        &mut self,
        chat: &mut ChatWidget,
        root: ThreadId,
        event: ThreadEvent,
        at: u64,
        replayed: bool,
    ) -> Vec<AppCommand> {
        let event = match event {
            ThreadEvent::Update { notification } => ChatEvent::SessionUpdate(*notification),
            ThreadEvent::TurnStarted {
                thread_id,
                prompt,
                origin,
                queued_id,
                ..
            } => {
                // The queue a thread's state gave covers the replay.
                let mut commands = Vec::new();
                if let Some(id) = queued_id.clone().filter(|_| !replayed) {
                    commands = chat.handle_agent_event(ChatEvent::Unqueued { id });
                }
                // This client's own prompt is on screen already, and its turn running, unless
                // it waited in the Host's queue.
                if self.is_mine(&origin) && !replayed && queued_id.is_none() {
                    return commands;
                }
                commands.extend(chat.handle_journal_event(
                    ChatEvent::TurnStarted {
                        thread_id,
                        prompt,
                        elapsed: since(at),
                        replayed,
                        started_by: match origin {
                            TurnOrigin::Service { name, label, .. } => {
                                Some(format!("{label}, via {name}"))
                            }
                            _ => None,
                        },
                    },
                    at,
                ));
                return commands;
            }
            // The queue a thread's state gave covers the replay.
            ThreadEvent::Queued { .. }
            | ThreadEvent::Unqueued { .. }
            | ThreadEvent::QueuePaused { .. }
            | ThreadEvent::QueueResumed { .. }
                if replayed =>
            {
                return Vec::new();
            }
            ThreadEvent::Queued {
                queued_id,
                prompt,
                origin,
            } => ChatEvent::Queued {
                id: queued_id,
                text: prompt_text(&prompt),
                mine: self.is_mine(&origin),
            },
            ThreadEvent::Unqueued { queued_id, .. } => ChatEvent::Unqueued { id: queued_id },
            ThreadEvent::QueuePaused { .. } => ChatEvent::QueuePaused(true),
            ThreadEvent::QueueResumed { .. } => ChatEvent::QueuePaused(false),
            // Shown as it joins the turn, this client's own messages too.
            ThreadEvent::TurnSteered {
                thread_id, prompt, ..
            } => ChatEvent::TurnSteered { thread_id, prompt },
            ThreadEvent::TurnEnded {
                thread_id,
                response,
                error,
            } => ChatEvent::TurnEnded {
                thread_id,
                result: match (response, error) {
                    (Some(response), _) => Ok(response),
                    (None, Some(error)) => Err(error),
                    (None, None) => Err(Error::internal_error().data("the turn ended unexplained")),
                },
                replayed,
            },
            ThreadEvent::TerminalOutput { terminal_id, data } => ChatEvent::TerminalOutput {
                terminal_id,
                text: data,
            },
            ThreadEvent::TerminalExit {
                terminal_id,
                status,
            } => ChatEvent::TerminalExited {
                terminal_id,
                status,
            },
            ThreadEvent::AgentReopened {
                agent,
                previous,
                modes,
                config_options,
                failed,
            } => {
                // The new process says what prompts may carry now, and whether it steers. A
                // replay's is history: the thread's state said what runs now.
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
            ThreadEvent::Closed { reason, by } if !replayed => {
                // Another client closed it for everyone: this TUI is done with it (WVE-167).
                if closed_by_another(by.as_ref(), self.handle.client_id()) {
                    self.closed_elsewhere = true;
                    return vec![AppCommand::Quit];
                }
                ChatEvent::ThreadEnded {
                    thread_id: root,
                    reason,
                }
            }
            ThreadEvent::Notice { text } => ChatEvent::Notice(text),
            ThreadEvent::Renamed { title, by } => ChatEvent::Renamed {
                title,
                by: match by {
                    None => "The agent".to_owned(),
                    Some(TurnOrigin::Client { id, .. }) if id == *self.handle.client_id() => {
                        "You".to_owned()
                    }
                    Some(TurnOrigin::Client { name, device, .. }) => device.unwrap_or(name),
                    Some(TurnOrigin::Run {}) => "A headless run".to_owned(),
                    Some(TurnOrigin::Thread {
                        host_name: Some(name),
                        ..
                    }) => format!("A thread on {name}"),
                    Some(TurnOrigin::Thread { host: None, .. }) => "Another thread".to_owned(),
                    Some(TurnOrigin::Thread { host: Some(_), .. }) => {
                        "A thread on another Host".to_owned()
                    }
                    Some(TurnOrigin::Service { name, .. }) => name,
                },
            },
            ThreadEvent::ContinuedIn { successor, .. } => ChatEvent::ContinuedIn { successor },
            // Labels are for clients that group threads by them, which this one doesn't yet.
            ThreadEvent::Closed { .. } | ThreadEvent::Labelled { .. } | ThreadEvent::Unknown => {
                return Vec::new();
            }
        };
        chat.handle_journal_event(event, at)
    }

    /// The Host answered an open: show the thread, then what's running and waiting in it.
    fn opened(
        &mut self,
        chat: &mut ChatWidget,
        kind: OpenKind,
        result: Result<Box<weave_host_client::OpenedThread>, Error>,
    ) -> Vec<AppCommand> {
        match (kind, result) {
            (OpenKind::Open { previous }, Ok(opened)) => {
                // Let go of the thread left, which closes if nothing else needs it.
                if let Some(previous) =
                    previous.filter(|previous| *previous != opened.state.thread_id)
                {
                    let handle = self.handle.clone();
                    tokio::spawn(async move {
                        handle
                            .send(DetachThreadRequest {
                                thread_id: previous,
                                close: CloseWhen::IfUnused,
                            })
                            .await
                    });
                }
                self.thread_opened(chat, &opened)
            }
            (OpenKind::Open { previous }, Err(error)) => chat.thread_failed(&error, previous),
            (OpenKind::Reattach, Ok(opened)) => {
                let reset = opened.replay.as_ref().is_some_and(|replay| replay.reset);
                if reset {
                    // The transcript here isn't the journal's any more: it starts over.
                    chat.begin_thread(opened.state.thread_id.clone(), None);
                    return self.thread_opened(chat, &opened);
                }
                self.track(chat, &opened);
                // A restarted Host has no watchers.
                self.watched = None;
                self.watch_terminals();
                self.agent_changed(chat, &opened.state.agent);
                chat.reattached(OpenedThread::from_state(
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

    /// Show a thread opened for this client, before its replay arrives.
    fn thread_opened(
        &mut self,
        chat: &mut ChatWidget,
        opened: &weave_host_client::OpenedThread,
    ) -> Vec<AppCommand> {
        self.cwd.clone_from(&opened.state.cwd);
        chat.set_cwd(opened.state.cwd.clone());
        self.agent_changed(chat, &opened.state.agent);
        chat.thread_ready(OpenedThread::from_state(
            &opened.state,
            opened.replay.as_ref(),
        ));
        chat.set_release(opened.state.agent.release.clone());
        if let Some(update) = opened.state.update.clone() {
            chat.update_available(update);
        }
        self.track(chat, opened);
        self.watch_terminals();
        let mut commands = self.show_state(chat, &opened.state);
        commands.extend(chat.send_kept_messages());
        commands
    }

    /// Watch the open thread's worktree's terminals, letting go of the last one's.
    fn watch_terminals(&mut self) {
        if !self.has_terminals {
            return;
        }
        if self.results.is_none() {
            self.watch_pending = true;
            return;
        }
        let handle = self.handle.clone();
        let previous = self.watched.take();
        let directory = self.cwd.clone();
        self.spawn(async move {
            if let Some(scope) = previous {
                let _ = handle.send(UnwatchTerminalsRequest { scope }).await;
            }
            let watched = handle.send(WatchTerminalsRequest { directory }).await;
            AppEvent::TerminalsWatched(watched.map(|answer| (answer.scope, answer.terminals)))
        });
    }

    /// The panes this TUI placed before a `/reload`, which Rex still has.
    fn find_panes(&self) {
        let Some(rex) = self.rex.clone() else {
            return;
        };
        self.spawn(async move {
            let placed = tokio::task::spawn_blocking(move || rex.placed()).await;
            AppEvent::Panes(placed.map_err(|error| error.to_string()))
        });
    }

    /// Run `act` on the Rex panes off the UI thread; what it leaves comes back as panes.
    fn on_panes(
        &self,
        act: impl FnOnce(&Rex, &[Pane]) -> Result<Vec<Pane>, String> + Send + 'static,
    ) {
        let Some(rex) = self.rex.clone() else {
            return;
        };
        let panes = self.panes.clone();
        self.spawn(async move {
            let done = tokio::task::spawn_blocking(move || act(&rex, &panes)).await;
            AppEvent::Panes(done.unwrap_or_else(|error| Err(error.to_string())))
        });
    }

    /// Follow what the thread's agent says about itself: what prompts may carry, and
    /// whether its turns can be steered (the Host takes `turn/steer`, and the agent takes
    /// steering).
    fn agent_changed(&mut self, chat: &mut ChatWidget, agent: &ThreadAgent) {
        self.reopenable = reopenable(&agent.initialize.agent_capabilities);
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

    /// Follow the thread's journal from where `opened`'s replay starts.
    fn track(&mut self, chat: &mut ChatWidget, opened: &weave_host_client::OpenedThread) {
        // A new thread's first events follow its answer too.
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

    /// What's running and waiting in a thread just opened.
    fn show_state(&self, chat: &mut ChatWidget, state: &ThreadState) -> Vec<AppCommand> {
        let mut commands = Vec::new();
        for turn in &state.turns {
            commands.extend(chat.handle_agent_event(ChatEvent::TurnRunning {
                thread_id: turn.thread_id.clone(),
                elapsed: since(turn.started_at),
            }));
        }
        for pending in &state.pending {
            commands.extend(self.pending(chat, &state.thread_id, pending.clone()));
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

    /// Carry on over the new connection, and reattach to the thread shown.
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
            AppEvent::ThreadsListed(result, append) => {
                chat.threads_listed(result, append);
                Vec::new()
            }
            AppEvent::ThreadDeleted(thread_id, result) => {
                chat.thread_deleted(&thread_id, result);
                Vec::new()
            }
            AppEvent::TerminalsWatched(Ok((scope, terminals))) => {
                self.watched = Some(scope);
                chat.set_terminals(terminals);
                Vec::new()
            }
            AppEvent::TerminalsWatched(Err(error)) => {
                tracing::debug!(%error, "couldn't watch the worktree's terminals");
                Vec::new()
            }
            AppEvent::Panes(Ok(panes)) => {
                chat.set_shown_terminals(panes.iter().map(|pane| pane.terminal.clone()).collect());
                self.panes = panes;
                Vec::new()
            }
            AppEvent::Panes(Err(why)) => {
                chat.report_info(&format!("Rex didn't show the terminal: {why}"));
                Vec::new()
            }
            AppEvent::TerminalStarted(Ok(terminal)) => {
                let (id, label) = (terminal.id.clone(), crate::thread_panel::name(&terminal));
                chat.terminal_updated(terminal);
                if self.rex.is_some() {
                    vec![AppCommand::ShowTerminal { id, label }]
                } else {
                    chat.report_info(&format!("Started terminal {label}"));
                    Vec::new()
                }
            }
            AppEvent::TerminalStarted(Err(error)) => {
                chat.report_info(&format!("Couldn't start a terminal: {error}"));
                Vec::new()
            }
            AppEvent::TerminalRead(id, screen) => {
                chat.terminal_read(&id, screen);
                Vec::new()
            }
            AppEvent::TerminalFailed(why) => {
                chat.report_info(&why);
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
                thread_id,
                text,
                result,
            } => chat.steer_answered(&thread_id, text, result),
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
            AppEvent::ThreadReopened(thread_id, result) => {
                chat.thread_reopened(&thread_id, result);
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
                    let Some(thread_id) = chat.active_thread().cloned() else {
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
                                thread_id,
                                prompt,
                                key: None,
                            })
                            .await
                            .err()
                            .map(AppEvent::PromptFailed)
                    });
                }
                AppCommand::Enqueue(text) => {
                    let Some(thread_id) = chat.active_thread().cloned() else {
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
                                thread_id,
                                prompt,
                                key: None,
                                caller: None,
                                origin: None,
                            })
                            .await
                            .err()
                            .map(|error| AppEvent::QueueFailed(text, error))
                    });
                }
                AppCommand::Unqueue(ids) => {
                    let Some(thread_id) = chat.active_thread().cloned() else {
                        continue;
                    };
                    let handle = self.handle.clone();
                    self.spawn(async move {
                        // One at a time, so they come back in order.
                        let mut texts = Vec::new();
                        for queued_id in ids {
                            let removed = handle
                                .send(RemoveQueuedRequest {
                                    thread_id: thread_id.clone(),
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
                    let Some(thread_id) = chat.active_thread().cloned() else {
                        continue;
                    };
                    let handle = self.handle.clone();
                    self.spawn_unless_ok(async move {
                        handle
                            .send(ResumeQueueRequest { thread_id })
                            .await
                            .err()
                            .map(AppEvent::ResumeFailed)
                    });
                }
                AppCommand::Steer(text) => {
                    let Some(thread_id) = chat.active_thread().cloned() else {
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
                                thread_id: thread_id.clone(),
                                prompt,
                                caller: None,
                                origin: None,
                            })
                            .await;
                        AppEvent::Steered {
                            thread_id,
                            text,
                            result,
                        }
                    });
                }
                AppCommand::Cancel => {
                    if let Some(thread_id) = chat.active_thread().cloned() {
                        self.cancel(thread_id);
                    }
                }
                // A subagent's cancel is the ordinary one, for its thread.
                AppCommand::CancelSubagent(thread_id) => self.cancel(thread_id),
                AppCommand::ChangeSetting(change) => {
                    if let Some(thread_id) = chat.active_thread().cloned() {
                        self.spawn_setting_change(thread_id, change);
                    }
                }
                AppCommand::ListThreads {
                    all_directories,
                    cursor,
                } => {
                    let request = ListThreadsRequest {
                        agent_id: Some(self.agent_id.clone()),
                        cwd: (!all_directories).then(|| self.cwd.clone()),
                        repo: None,
                        activity: None,
                        cursor: cursor.clone(),
                        labels: Vec::new(),
                    };
                    let append = cursor.is_some();
                    let handle = self.handle.clone();
                    self.spawn(async move {
                        AppEvent::ThreadsListed(handle.send(request).await, append)
                    });
                }
                AppCommand::OpenThread { target, title, cwd } => {
                    queue.extend(self.open_thread(chat, target, title, cwd));
                }
                AppCommand::ShowTerminal { id, label } => {
                    self.on_panes(move |rex, panes| rex.show(panes, &id, &label));
                }
                AppCommand::HideTerminal(id) => {
                    self.on_panes(move |rex, panes| rex.hide(panes, &id));
                }
                AppCommand::NewTerminal => {
                    let handle = self.handle.clone();
                    let request = NewTerminalRequest {
                        directory: self.cwd.clone(),
                        label: None,
                        opened_from: chat.active_thread().cloned(),
                        command: None,
                        size: None,
                    };
                    self.spawn(async move {
                        AppEvent::TerminalStarted(
                            handle.send(request).await.map(|answer| answer.terminal),
                        )
                    });
                }
                AppCommand::RenameTerminal { id, label } => {
                    let handle = self.handle.clone();
                    let label = Some(label.trim().to_owned()).filter(|label| !label.is_empty());
                    self.spawn_unless_ok(async move {
                        handle
                            .send(SetTerminalLabelRequest { id, label })
                            .await
                            .err()
                            .map(|error| {
                                AppEvent::TerminalFailed(format!("Couldn't rename it: {error}"))
                            })
                    });
                }
                AppCommand::EndTerminal(id) => {
                    let handle = self.handle.clone();
                    self.spawn_unless_ok(async move {
                        handle
                            .send(CloseTerminalRequest { id })
                            .await
                            .err()
                            .map(|error| {
                                AppEvent::TerminalFailed(format!("Couldn't end it: {error}"))
                            })
                    });
                }
                AppCommand::ReadTerminal(id) => {
                    let handle = self.handle.clone();
                    self.spawn(async move {
                        let read = handle
                            .send(FormatTerminalRequest {
                                id: id.clone(),
                                format: TerminalFormat::Text,
                                history: false,
                                trim: true,
                            })
                            .await
                            .map(|answer| answer.content)
                            .map_err(|error| error.to_string());
                        AppEvent::TerminalRead(id, read)
                    });
                }
                AppCommand::WriteTerminal { id, text } => {
                    let handle = self.handle.clone();
                    self.spawn_unless_ok(async move {
                        handle
                            .send(WriteTerminalRequest { id, text })
                            .await
                            .err()
                            .map(|error| {
                                AppEvent::TerminalFailed(format!("Couldn't type into it: {error}"))
                            })
                    });
                }
                AppCommand::DeleteThread(thread_id) => {
                    let handle = self.handle.clone();
                    let request = DeleteThreadRequest {
                        thread_id: thread_id.clone(),
                        agent_id: Some(self.agent_id.clone()),
                    };
                    self.spawn(async move {
                        let result = handle.send(request).await.map(drop);
                        AppEvent::ThreadDeleted(thread_id, result)
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
                        // The shell is this computer's, and the thread's directory another's.
                        if self.elsewhere {
                            let _ = results.send(AppEvent::ShellOutput(
                                id.clone(),
                                "Shell commands run on this computer, and this thread works on \
                                 another: run them in one of its terminals (/thread)\n"
                                    .to_owned(),
                            ));
                            let status = TerminalExitStatus::new().exit_code(1);
                            let _ = results.send(AppEvent::ShellExited(id, status));
                            continue;
                        }
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
                    thread_id,
                    pending_id,
                    tool,
                    arguments,
                } => {
                    let result = run_client_tool(tui, &tool, &arguments);
                    self.answer_client_tool(thread_id, pending_id, result);
                }
                // As Codex, only while the terminal isn't in front of the user.
                AppCommand::Notify(message) => {
                    if self.notifications && !self.focused {
                        tui.notify(&message);
                    }
                }
                AppCommand::Quit => return true,
                AppCommand::Exit => {
                    self.closing = true;
                    return true;
                }
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
                AppCommand::ReopenThread(thread_id) => {
                    let handle = self.handle.clone();
                    self.spawn(async move {
                        let result = handle
                            .send(ReopenThreadRequest {
                                thread_id: thread_id.clone(),
                            })
                            .await
                            .map(drop);
                        AppEvent::ThreadReopened(thread_id, result)
                    });
                }
                AppCommand::Rename { thread_id, title } => {
                    let handle = self.handle.clone();
                    self.spawn_unless_ok(async move {
                        let request = RenameThreadRequest { thread_id, title };
                        handle.send(request).await.err().map(AppEvent::RenameFailed)
                    });
                }
                AppCommand::DismissUpdate { agent_id, version } => {
                    self.dismissed.dismiss(&agent_id, &version);
                }
                AppCommand::Reattach(thread_id) => {
                    let request = AttachThreadRequest {
                        thread_id,
                        after: self.position.clone(),
                        agent_id: Some(self.agent_id.clone()),
                        cwd: Some(self.cwd.clone()),
                        trace: self.trace,
                        observe: false,
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

    /// Open `target`: a new thread, or an existing one, whose events show from now on.
    fn open_thread(
        &mut self,
        chat: &mut ChatWidget,
        target: ThreadTarget,
        title: Option<String>,
        cwd: Option<PathBuf>,
    ) -> Vec<AppCommand> {
        let previous = chat.active_thread().cloned();
        let open = match target {
            ThreadTarget::New => Open::Create(CreateThreadRequest {
                agent_id: self.agent_id.clone(),
                cwd: self.cwd.clone(),
                additional_directories: self.additional_directories.clone(),
                mode: None,
                policy: None,
                trace: self.trace,
                labels: Vec::new(),
            }),
            ThreadTarget::Existing(thread_id) => {
                let title = title.unwrap_or_else(|| thread_id.to_string());
                chat.begin_thread(thread_id.clone(), Some(&title));
                // A thread from another directory reopens in its own.
                Open::Attach(AttachThreadRequest {
                    thread_id,
                    after: None,
                    agent_id: Some(self.agent_id.clone()),
                    cwd: Some(cwd.unwrap_or_else(|| self.cwd.clone())),
                    trace: self.trace,
                    observe: false,
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
            Err(error) => chat.thread_failed(&error, previous),
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

    fn cancel(&self, thread_id: ThreadId) {
        let handle = self.handle.clone();
        tokio::spawn(async move {
            if let Err(error) = handle.send(CancelTurnRequest { thread_id }).await {
                tracing::warn!(%error, "failed to cancel the turn");
            }
        });
    }

    /// A pending request of the active thread: one to show, or a client tool call to run
    /// when it's for this client. Other clients' calls are theirs to run.
    fn pending(
        &self,
        chat: &mut ChatWidget,
        thread_id: &ThreadId,
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
                thread_id: thread_id.clone(),
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
        thread_id: ThreadId,
        pending_id: String,
        result: ClientToolResult,
    ) {
        let handle = self.handle.clone();
        tokio::spawn(async move {
            let request = AnswerPendingRequest {
                thread_id,
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

    /// Answer a pending request of the active thread. Another client may have answered it
    /// first, which is no failure.
    fn answer(
        &self,
        chat: &ChatWidget,
        pending_id: String,
        fill: impl FnOnce(AnswerPendingRequest) -> AnswerPendingRequest,
    ) {
        let Some(thread_id) = chat.active_thread().cloned() else {
            return;
        };
        let request = fill(AnswerPendingRequest {
            thread_id,
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

    fn spawn_setting_change(&self, thread_id: ThreadId, change: SettingChange) {
        let handle = self.handle.clone();
        self.spawn(async move {
            let result = match &change {
                SettingChange::ConfigOption(config_id, value) => handle
                    .send(SetConfigOptionRequest {
                        thread_id,
                        config_id: config_id.clone(),
                        value: value.clone(),
                    })
                    .await
                    .map(|response| Some(response.config_options)),
                SettingChange::Mode(mode_id) => handle
                    .send(SetModeRequest {
                        thread_id,
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

/// Whether another client closed a thread for everyone: the TUI quits then. Its own close, and
/// one nobody asked for (its agent exited, its worktree went), leave it showing why.
fn closed_by_another(by: Option<&TurnOrigin>, me: &str) -> bool {
    matches!(by, Some(TurnOrigin::Client { id, .. }) if id != me)
}

/// Whether an agent can open a closed thread again: by loading it, or resuming it.
fn reopenable(capabilities: &AgentCapabilities) -> bool {
    capabilities.load_session || capabilities.session_capabilities.resume.is_some()
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

/// How long ago `at` was.
fn since(at: u64) -> Duration {
    Duration::from_millis(runs::now_millis().saturating_sub(at))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn another_clients_close_quits_the_tui_and_nothing_else_does() {
        let client = |id: &str| TurnOrigin::Client {
            name: "weave-app".to_owned(),
            id: id.to_owned(),
            device: Some("iPad".to_owned()),
        };
        assert!(closed_by_another(Some(&client("c9")), "c1"));
        assert!(!closed_by_another(Some(&client("c1")), "c1"));
        assert!(!closed_by_another(None, "c1"));
        assert!(!closed_by_another(Some(&TurnOrigin::Run {}), "c1"));
    }
}
