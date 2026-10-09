//! Conversation state: turns agent events and key presses into transcript lines, live
//! viewport content, and commands for the app loop.
//!
//! Shaped after Codex's `ChatWidget`. It performs no I/O: finished lines queue up for
//! [`ChatWidget::take_history`], and protocol actions come back as [`AppCommand`]s.

use std::collections::HashSet;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::time::Duration;
use std::time::Instant;

use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyModifiers;
use crossterm::event::MouseEvent;
use ratatui::buffer::Buffer;
use ratatui::layout::Position;
use ratatui::layout::Rect;
use ratatui::style::Modifier;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::text::Span;
use weave_acp_core::AgentEvent;
use weave_acp_core::ElicitationRequest;
use weave_acp_core::MaybeUndefined;
use weave_acp_core::PermissionRequest;
use weave_acp_core::schema::AvailableCommand;
use weave_acp_core::schema::CompactionId;
use weave_acp_core::schema::CompactionUpdate;
use weave_acp_core::schema::ContentBlock;
use weave_acp_core::schema::ContentChunk;
use weave_acp_core::schema::ElicitationId;
use weave_acp_core::schema::ElicitationMode;
use weave_acp_core::schema::ElicitationScope;
use weave_acp_core::schema::Error;
use weave_acp_core::schema::ListSessionsResponse;
use weave_acp_core::schema::MessageId;
use weave_acp_core::schema::PromptResponse;
use weave_acp_core::schema::SessionConfigOption;
use weave_acp_core::schema::SessionConfigOptionCategory;
use weave_acp_core::schema::SessionId;
use weave_acp_core::schema::SessionMessage;
use weave_acp_core::schema::SessionMessageChunk;
use weave_acp_core::schema::SessionModeState;
use weave_acp_core::schema::SessionUpdate;
use weave_acp_core::schema::StateUpdate;
use weave_acp_core::schema::StopReason;
use weave_acp_core::schema::SubagentUpdate;
use weave_acp_core::schema::TerminalExitStatus;
use weave_acp_core::schema::TerminalId;
use weave_acp_core::schema::ToolCallId;
use weave_acp_core::schema::ToolCallStatus;

use crate::attachments::Attachment;
use crate::clipboard;
use crate::command_popup;
use crate::command_popup::CommandPopup;
use crate::command_popup::PopupAction;
use crate::compaction;
use crate::compaction::Compaction;
use crate::composer::Composer;
use crate::composer::ComposerAction;
use crate::conventions;
use crate::conventions::thought_heading;
use crate::elicitation::ElicitationOutcome;
use crate::elicitation::ElicitationView;
use crate::file_popup;
use crate::file_popup::FileIndex;
use crate::file_popup::FilePopup;
use crate::footer;
use crate::footer::FindKeys;
use crate::footer::FooterMode;
use crate::footer::FooterProps;
use crate::footer::StatusItem;
use crate::footer::StatusValues;
use crate::history_cell::dim;
use crate::history_cell::home_relative;
use crate::permission::Decision;
use crate::permission::PermissionView;
use crate::permission::Subject;
use crate::session::OpenedSession;
use crate::session::Reopened;
use crate::session::SessionTarget;
use crate::session_picker::PickerAction;
use crate::session_picker::SessionPicker;
use crate::settings;
use crate::settings::PickerOutcome;
use crate::settings::SettingChange;
use crate::settings::SettingsPicker;
use crate::status::Status;
use crate::status::status_line;
use crate::streaming::MessageStream;
use crate::streaming::StreamKind;
use crate::streaming::render_compact;
use crate::style;
use crate::subagents;
use crate::subagents::Subagent;
use crate::tool_call::ExploreGroup;
use crate::tool_call::RenderContext;
use crate::tool_call::ToolCallCell;
use crate::tool_output::TerminalTranscripts;
use crate::transcript::FindStatus;
use crate::transcript::Reading;
use crate::transcript::TranscriptCell;
use crate::transcript::TranscriptView;
use crate::vim::CursorShape;
use crate::wrapping::DisplayLine;
use crate::wrapping::plain_lines;

/// How long a first Ctrl-C keeps the second one armed to quit.
const QUIT_WINDOW: Duration = Duration::from_secs(2);

/// How long the note that a selection was copied stays up.
const COPIED_NOTE: Duration = Duration::from_secs(2);

#[derive(Debug, PartialEq, Eq)]
pub enum AppCommand {
    Prompt(String),
    Cancel,
    /// `session/cancel` for a subagent's current work, which it lets the client stop.
    CancelSubagent(SessionId),
    /// Change a session setting; the result comes back through [`ChatWidget::setting_changed`].
    ChangeSetting(SettingChange),
    /// `session/list`; the result comes back through [`ChatWidget::sessions_listed`].
    ListSessions {
        all_directories: bool,
        cursor: Option<String>,
    },
    /// Switch to another session (or a new one); see [`ChatWidget::begin_session`].
    OpenSession {
        target: SessionTarget,
        title: Option<String>,
        /// The directory an existing session works in, when the list said.
        cwd: Option<PathBuf>,
    },
    DeleteSession(SessionId),
    /// Open a URL the user consented to in their browser.
    OpenUrl(String),
    /// Put text the user selected on the clipboard.
    Copy(String),
    /// Run a command from shell mode in the session directory; its output comes back
    /// through [`ChatWidget::shell_output`] and [`ChatWidget::shell_exited`].
    RunShell {
        id: String,
        command: String,
    },
    /// Stop a command started with [`AppCommand::RunShell`].
    KillShell(String),
    /// Ctrl+V: attach the clipboard's image; it comes back through
    /// [`ChatWidget::attach_image`].
    PasteImage,
    /// Something needs the user, such as a finished turn or an approval; the app raises a
    /// desktop notification when the terminal isn't focused.
    Notify(String),
    Quit,
}

/// Which optional session methods the agent offers.
#[derive(Clone, Copy, Debug, Default)]
pub struct SessionAbilities {
    pub list: bool,
    pub delete: bool,
}

struct Turn {
    started: Instant,
    cancelling: bool,
    /// What the status line calls the work: "Working", or the heading of the agent's latest
    /// thought, as Codex shows reasoning headers. And when it last changed.
    label: String,
    label_since: Instant,
}

struct Stashed {
    session_id: SessionId,
    /// Its fullscreen transcript.
    cells: Vec<TranscriptCell>,
    resumable: bool,
}

struct PendingPermission {
    request: PermissionRequest,
    view: PermissionView,
}

struct PendingElicitation {
    request: ElicitationRequest,
    view: ElicitationView,
}

pub struct ChatWidget {
    agent_name: String,
    cwd: PathBuf,
    abilities: SessionAbilities,
    /// The session prompts go to and whose events are shown; others' events are ignored.
    active_session: Option<SessionId>,
    /// Waiting for a session to finish loading; prompts wait until it has.
    opening: bool,
    session_picker: Option<SessionPicker>,
    elicitations: VecDeque<PendingElicitation>,
    /// URL elicitations the user accepted, awaiting their optional completion notice.
    accepted_urls: HashSet<ElicitationId>,
    width: u16,
    /// The transcript weave draws and scrolls itself in fullscreen mode. Without it, finished
    /// lines queue in `pending_history` for the terminal's scrollback.
    transcript: Option<TranscriptView>,
    /// Inline mode keeps the transcript too, for the full-screen pager Ctrl+T opens (Codex's
    /// transcript overlay); `pager_open` while it shows.
    pager: Option<TranscriptView>,
    pager_open: bool,
    /// The session being left, kept until the next one opens so a failed switch can go back.
    stashed: Option<Stashed>,
    pending_history: Vec<Line<'static>>,
    has_history: bool,
    stream: Option<MessageStream>,
    /// Tool calls still running, in the order they started.
    tool_calls: Vec<ToolCallCell>,
    /// Finished reads and searches since anything else, shown as one `Exploring` entry until
    /// something else arrives, as Codex groups its exploring commands.
    exploring: ExploreGroup,
    /// Tool calls already committed; later updates to them are ignored.
    committed_tool_calls: HashSet<ToolCallId>,
    /// Context compactions not yet finished, in the order they started.
    compactions: Vec<Compaction>,
    /// Compactions already committed; later updates to them are ignored.
    committed_compactions: HashSet<CompactionId>,
    turn: Option<Turn>,
    permissions: VecDeque<PendingPermission>,
    composer: Composer,
    queued: VecDeque<String>,
    modes: Option<SessionModeState>,
    config_options: Vec<SessionConfigOption>,
    settings: Option<SettingsPicker>,
    commands: Vec<AvailableCommand>,
    popup: CommandPopup,
    terminals: TerminalTranscripts,
    context: Option<(u64, u64)>,
    /// The session's cumulative cost and its currency, when the agent reports one.
    cost: Option<(f64, String)>,
    /// The session's title, as the agent last reported it.
    title: Option<String>,
    disconnected: bool,
    quit_armed_until: Option<Instant>,
    /// The active session has a conversation worth reopening later.
    resumable: bool,
    /// Confirmation that a selection was copied, until it expires.
    copied: Option<(String, Instant)>,
    /// The agent's latest reply this turn, for the notification when it ends.
    last_reply: Option<String>,
    /// Shell commands run so far, for naming the next.
    shell_runs: usize,
    /// Images pasted into prompts, `[image 1]` first.
    images: Vec<PathBuf>,
    /// The session directory's files, for the `@` picker.
    files: FileIndex,
    file_popup: FilePopup,
    /// The `?` shortcuts panel is open.
    shortcuts_open: bool,
    /// What the footer's status line shows.
    status_items: Vec<StatusItem>,
    /// Whether the Vim composer is enabled (`[tui] vim = true`).
    vim: bool,
    /// Whether sessions outlive the TUI, in the weave daemon: Ctrl+D then leaves even while
    /// a turn runs, and the turn carries on.
    detachable: bool,
    /// Subagents this session created, in the order they appeared, each with its own chat.
    subagents: Vec<Subagent>,
    /// The subagent whose transcript is shown instead of this session's.
    watching: Option<SessionId>,
    subagent_picker: Option<subagents::Picker>,
    /// Messages between this session and another, while they stream.
    messages: Vec<SessionMessageEntry>,
    /// In a subagent's own chat: what its parent is called.
    parent_label: Option<String>,
}

/// A message between sessions as this chat shows it.
struct MessageShape {
    /// The other session's name.
    label: String,
    outgoing: bool,
    /// Whether the other session is one of this one's subagents.
    to_subagent: bool,
    text: String,
}

impl MessageShape {
    fn lines(&self, width: usize) -> Vec<DisplayLine> {
        if !self.to_subagent {
            return subagents::message_lines(!self.outgoing, &self.label, &self.text, width);
        }
        let text = self.text.clone();
        let event = if self.outgoing {
            subagents::Event::SentInput { text }
        } else {
            subagents::Event::MessageFrom { text }
        };
        subagents::event_lines(&self.label, &event, width)
    }
}

/// A message between sessions, as it streams in.
struct SessionMessageEntry {
    id: MessageId,
    sender: Option<SessionId>,
    recipient: Option<SessionId>,
    text: String,
}

impl ChatWidget {
    pub fn new(agent_name: String, cwd: PathBuf, abilities: SessionAbilities, width: u16) -> Self {
        let files = FileIndex::new(cwd.clone());
        Self {
            agent_name,
            cwd,
            abilities,
            active_session: None,
            opening: false,
            session_picker: None,
            elicitations: VecDeque::new(),
            accepted_urls: HashSet::new(),
            width,
            transcript: None,
            pager: Some(TranscriptView::detailed()),
            pager_open: false,
            stashed: None,
            pending_history: Vec::new(),
            has_history: false,
            stream: None,
            tool_calls: Vec::new(),
            exploring: ExploreGroup::default(),
            committed_tool_calls: HashSet::new(),
            compactions: Vec::new(),
            committed_compactions: HashSet::new(),
            turn: None,
            permissions: VecDeque::new(),
            composer: Composer::default(),
            queued: VecDeque::new(),
            modes: None,
            config_options: Vec::new(),
            settings: None,
            commands: Vec::new(),
            popup: CommandPopup::default(),
            terminals: TerminalTranscripts::new(),
            context: None,
            cost: None,
            title: None,
            disconnected: false,
            quit_armed_until: None,
            resumable: false,
            copied: None,
            last_reply: None,
            shell_runs: 0,
            images: Vec::new(),
            files,
            file_popup: FilePopup::default(),
            shortcuts_open: false,
            status_items: StatusItem::DEFAULT.to_vec(),
            vim: false,
            detachable: false,
            subagents: Vec::new(),
            watching: None,
            subagent_picker: None,
            messages: Vec::new(),
            parent_label: None,
        }
    }

    /// Show `items` in the footer's status line; none shows `? for shortcuts` instead.
    pub fn with_status_line(mut self, items: Vec<StatusItem>) -> Self {
        self.status_items = items;
        self
    }

    /// Enable the Vim composer: new blank threads open in it, a new line in the basic
    /// composer moves there, and Ctrl+G switches between them.
    pub fn with_vim(mut self, enabled: bool) -> Self {
        self.vim = enabled;
        self.composer.set_vim_available(enabled);
        self
    }

    /// Work in `cwd` from now on: the directory a session opened from another one works in.
    pub fn set_cwd(&mut self, cwd: PathBuf) {
        if cwd != self.cwd {
            self.files = FileIndex::new(cwd.clone());
            self.cwd = cwd;
        }
    }

    /// Sessions outlive the TUI, in the weave daemon, so leaving needn't stop a turn.
    pub fn with_detach(mut self, detachable: bool) -> Self {
        self.detachable = detachable;
        self
    }

    /// Draw the transcript in the widget (fullscreen) instead of handing it to scrollback.
    pub fn fullscreen(mut self) -> Self {
        self.transcript = Some(TranscriptView::new());
        self.pager = None;
        self
    }

    /// Whether the inline pager (Ctrl+T) is showing.
    #[cfg(test)]
    pub fn pager_open(&self) -> bool {
        self.pager_open
    }

    /// Whether inline mode shows a full-screen overlay: the Ctrl+T pager, or a watched
    /// subagent's transcript.
    pub fn overlay_open(&self) -> bool {
        self.pager_open || (self.transcript.is_none() && self.watching.is_some())
    }

    /// The startup banner, followed by any `notices` worth the user's attention.
    pub fn push_header(&mut self, agent_version: Option<&str>, notices: &[String]) {
        let settings = settings::summary(&self.config_options, self.modes.as_ref()).join(" · ");
        self.push_cell(TranscriptCell::header(
            self.agent_name.clone(),
            agent_version.map(str::to_owned),
            home_relative(&self.cwd),
            (!settings.is_empty()).then_some(settings),
        ));
        for notice in notices {
            self.push_cell(TranscriptCell::error(notice));
        }
        // The header stays when the transcript is cleared for another session.
        if let Some(view) = &mut self.transcript {
            view.pin();
        }
    }

    /// Switch to `session_id`. Its events show from now on; a replay follows for loads.
    pub fn begin_session(&mut self, session_id: SessionId, title: Option<&str>) {
        self.finish_live_cells();
        self.answer_pending_requests_cancelled();
        // Like Codex, a fullscreen transcript shows one session at a time.
        let cells = self
            .transcript
            .as_mut()
            .map(TranscriptView::take_session)
            .unwrap_or_default();
        self.stashed = self.active_session.take().map(|session_id| Stashed {
            session_id,
            cells,
            resumable: self.resumable,
        });
        self.resumable = false;
        // Tool call ids are only unique within a session, and a reload replays its own.
        self.committed_tool_calls.clear();
        self.compactions.clear();
        self.committed_compactions.clear();
        // Subagents belong to the session that created them.
        self.subagents.clear();
        self.watching = None;
        self.subagent_picker = None;
        self.messages.clear();
        self.turn = None;
        self.queued.clear();
        self.commands.clear();
        self.modes = None;
        self.config_options.clear();
        self.context = None;
        self.cost = None;
        self.title = title.map(str::to_owned);
        self.session_picker = None;
        self.settings = None;
        self.active_session = Some(session_id);
        self.opening = true;
        if let Some(title) = title {
            self.push_cell(TranscriptCell::info(&format!("Session: {title}")));
        }
    }

    /// The session opened by [`Self::begin_session`] is ready for prompts.
    pub fn session_ready(&mut self, opened: OpenedSession) {
        if self.active_session.as_ref() != Some(&opened.session_id) {
            let title = self.has_history.then_some("new session");
            self.begin_session(opened.session_id.clone(), title);
        }
        // A loaded session's replay is over: what it finished settles into the transcript.
        // Unless a turn is still running in it, attached to mid-stream.
        if self.turn.is_none() {
            self.end_stream();
            self.commit_finished_tool_calls();
            self.flush_exploring();
        }
        self.opening = false;
        self.stashed = None;
        self.resumable |= opened.reopened.is_some();
        self.modes = opened.modes;
        self.config_options = opened.config_options;
        // A new, blank thread starts in the Vim composer, for a first message to write out.
        if self.vim && opened.reopened.is_none() {
            self.composer.enter_vim();
        }
        if opened.reopened == Some(Reopened::Resumed) {
            self.push_cell(TranscriptCell::info(
                "Resumed; the agent did not replay earlier messages",
            ));
        }
    }

    /// Opening a session failed; go back to `previous` (or the picker, at startup).
    pub fn session_failed(
        &mut self,
        error: &Error,
        previous: Option<SessionId>,
    ) -> Vec<AppCommand> {
        self.opening = false;
        if let Some(stashed) = self.stashed.take()
            && previous.as_ref() == Some(&stashed.session_id)
        {
            self.resumable = stashed.resumable;
            if let Some(view) = &mut self.transcript {
                view.restore_session(stashed.cells);
            }
        }
        self.push_error(&format!("Couldn't open the session: {error}"));
        self.active_session = previous;
        if self.active_session.is_none() && self.abilities.list {
            return self.open_session_picker(true);
        }
        Vec::new()
    }

    /// Show the session picker; `startup` means there is no session to return to.
    pub fn open_session_picker(&mut self, startup: bool) -> Vec<AppCommand> {
        self.session_picker = Some(SessionPicker::new(self.abilities.delete, startup));
        vec![AppCommand::ListSessions {
            all_directories: false,
            cursor: None,
        }]
    }

    pub fn sessions_listed(&mut self, result: Result<ListSessionsResponse, Error>, append: bool) {
        let Some(picker) = &mut self.session_picker else {
            return;
        };
        match result {
            Ok(response) => picker.listed(response.sessions, response.next_cursor, append),
            Err(error) => picker.failed(format!("Couldn't list sessions: {error}")),
        }
    }

    pub fn session_deleted(&mut self, session_id: &SessionId, result: Result<(), Error>) {
        match (result, &mut self.session_picker) {
            (Ok(()), Some(picker)) => picker.deleted(session_id),
            (Ok(()), None) => {}
            (Err(error), _) => self.push_error(&format!("Couldn't delete the session: {error}")),
        }
    }

    pub fn active_session(&self) -> Option<&SessionId> {
        self.active_session.as_ref()
    }

    /// Whether `session_id` is the active session, or no session is tracked yet.
    fn is_active(&self, session_id: &SessionId) -> bool {
        self.active_session
            .as_ref()
            .is_none_or(|active| active == session_id)
    }

    pub fn set_size(&mut self, width: u16, height: u16) {
        if width != self.width
            && let Some(view) = &mut self.transcript
        {
            view.resized();
        }
        self.width = width;
        self.composer.set_screen_height(height);
        for subagent in &mut self.subagents {
            subagent.chat.set_size(width, height);
        }
    }

    /// The terminal cursor the composer wants, or `None` for the terminal's own: the Vim
    /// composer's block, bar or underline while it has the keys.
    pub fn cursor_shape(&self) -> Option<CursorShape> {
        if self.has_overlay()
            || self.pager_open
            || self.find_status().is_some_and(|find| find.editing)
        {
            return None;
        }
        self.composer.cursor_shape()
    }

    /// The session to offer reopening on exit: the active one, once it has a conversation.
    pub fn resumable_session(&self) -> Option<&SessionId> {
        self.active_session.as_ref().filter(|_| self.resumable)
    }

    /// Whether a turn is running in the active session.
    pub fn turn_running(&self) -> bool {
        self.turn.is_some()
    }

    /// Lines to write into scrollback above the viewport, in order.
    pub fn take_history(&mut self) -> Vec<Line<'static>> {
        std::mem::take(&mut self.pending_history)
    }

    /// Whether the viewport changes over time on its own (the status timer and shimmer).
    pub fn is_animating(&self) -> bool {
        // While the picker waits for the index, frames keep coming to show it when ready.
        let indexing = self.files.is_indexing() && self.mention_query().is_some();
        self.turn.is_some() || self.copied.is_some() || indexing
    }

    /// The window title, as Codex sets it: activity, the session's title, and the project.
    /// A spinner while the agent works; a blinking dot while it waits for the user.
    pub fn terminal_title(&self, now: Instant) -> String {
        const SPINNER: [&str; 10] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
        let waiting = !self.permissions.is_empty() || !self.elicitations.is_empty();
        let elapsed =
            now.saturating_duration_since(self.turn.as_ref().map_or(now, |turn| turn.started));
        let indicator = if waiting {
            let on = (elapsed.as_millis() / 1000).is_multiple_of(2);
            Some(if on { "●" } else { "○" })
        } else if self.turn.is_some() {
            usize::try_from(elapsed.as_millis() / 100 % 10)
                .ok()
                .map(|frame| SPINNER[frame])
        } else {
            None
        };
        let project = self
            .cwd
            .file_name()
            .map(|name| name.to_string_lossy().into_owned());
        let names: Vec<String> = self.title.iter().cloned().chain(project).collect();
        let names = if names.is_empty() {
            "weave".to_owned()
        } else {
            names.join(" · ")
        };
        match indicator {
            Some(indicator) => format!("{indicator} {names}"),
            None => names,
        }
    }

    /// Run `command` from shell mode: shown live as `Running`, then `You ran`, with its
    /// output. It stays local; ACP has no way to give the agent what the user ran.
    fn start_shell(&mut self, command: String) -> Vec<AppCommand> {
        self.shell_runs += 1;
        let id = format!("user-shell-{}", self.shell_runs);
        self.commit_finished_tool_calls();
        self.tool_calls
            .push(ToolCallCell::user_shell(&id, &command));
        vec![AppCommand::RunShell { id, command }]
    }

    pub fn shell_output(&mut self, id: &str, text: &str) {
        self.terminals
            .entry(id.to_owned().into())
            .or_default()
            .append(text);
        self.note_activity();
    }

    pub fn shell_exited(&mut self, id: &str, status: TerminalExitStatus) {
        let succeeded = status.exit_code == Some(0);
        self.terminals
            .entry(id.to_owned().into())
            .or_default()
            .set_exit(status);
        if let Some(cell) = self
            .tool_calls
            .iter_mut()
            .find(|cell| cell.id.to_string() == id)
        {
            cell.status = if succeeded {
                ToolCallStatus::Completed
            } else {
                ToolCallStatus::Failed
            };
        }
        self.note_activity();
    }

    /// Advance time-based state between frames.
    pub fn tick(&mut self, now: Instant) {
        if self.copied.as_ref().is_some_and(|(_, until)| now >= *until) {
            self.copied = None;
        }
    }

    pub fn handle_agent_event(&mut self, event: AgentEvent) -> Vec<AppCommand> {
        match event {
            AgentEvent::SessionUpdate(notification) => {
                if self.is_active(&notification.session_id) {
                    self.handle_update(notification.update);
                } else if let Some(path) = self.path_to(&notification.session_id) {
                    // A subagent's own update, for its transcript.
                    self.chat_at_mut(&path).handle_update(notification.update);
                    self.note_activity();
                }
                Vec::new()
            }
            AgentEvent::PermissionRequested(request) => {
                if self.is_active(&request.request.session_id) {
                    self.handle_permission(request)
                        .map(AppCommand::Notify)
                        .into_iter()
                        .collect()
                } else if let Some(path) = self.path_to(&request.request.session_id) {
                    // A subagent asks: its own chat says what about, and the user answers here.
                    let label = self.label_at(&path);
                    let subject = self.chat_at_mut(&path).permission_subject(&request);
                    self.queue_permission(request, subject, Some(&label))
                        .map(AppCommand::Notify)
                        .into_iter()
                        .collect()
                } else {
                    let _ = request.cancel();
                    Vec::new()
                }
            }
            AgentEvent::ElicitationRequested(request) => self
                .handle_elicitation(request)
                .map(AppCommand::Notify)
                .into_iter()
                .collect(),
            AgentEvent::RequestWithdrawn(key) => {
                let withdrawn = if let Some(index) = self
                    .permissions
                    .iter()
                    .position(|pending| pending.request.key == key)
                {
                    self.permissions
                        .remove(index)
                        .map(|pending| pending.request.withdrawn())
                } else if let Some(index) = self
                    .elicitations
                    .iter()
                    .position(|pending| pending.request.key == key)
                {
                    self.elicitations
                        .remove(index)
                        .map(|pending| pending.request.withdrawn())
                } else {
                    None
                };
                if withdrawn.is_some() {
                    self.push_cell(TranscriptCell::info("The agent withdrew its request"));
                }
                Vec::new()
            }
            AgentEvent::ElicitationCompleted(id) => {
                // Unknown or already-completed ids are ignored, as the spec requires.
                if self.accepted_urls.remove(&id) {
                    self.push_cell(TranscriptCell::info(
                        "The agent finished the step you opened in the browser",
                    ));
                }
                Vec::new()
            }
            AgentEvent::TurnEnded { session_id, result } => {
                if self.is_active(&session_id) {
                    self.end_turn(result)
                } else {
                    Vec::new()
                }
            }
            AgentEvent::TurnRunning {
                session_id,
                elapsed,
            } => {
                if self.is_active(&session_id) {
                    self.turn_running_elsewhere(elapsed);
                }
                Vec::new()
            }
            AgentEvent::SessionEnded { session_id, reason } => {
                if self.active_session.as_ref() == Some(&session_id) {
                    self.finish_live_cells();
                    self.answer_pending_requests_cancelled();
                    self.turn = None;
                    self.disconnected = true;
                    self.push_error(&format!("Session ended: {reason}"));
                }
                Vec::new()
            }
            AgentEvent::TerminalOutput { terminal_id, text } => {
                self.terminal_output(&terminal_id, &text);
                self.note_activity();
                Vec::new()
            }
            AgentEvent::TerminalExited {
                terminal_id,
                status,
            } => {
                self.terminal_exited(&terminal_id, &status);
                Vec::new()
            }
            AgentEvent::Disconnected(error) => {
                self.finish_live_cells();
                self.answer_pending_requests_cancelled();
                self.turn = None;
                self.disconnected = true;
                let reason =
                    error.map_or_else(|| "the agent exited".to_owned(), |error| error.to_string());
                self.push_error(&format!("Disconnected: {reason}"));
                Vec::new()
            }
        }
    }

    /// The way down to a subagent's chat, as indices from this one, if it is a descendant.
    fn path_to(&self, id: &SessionId) -> Option<Vec<usize>> {
        for (index, subagent) in self.subagents.iter().enumerate() {
            if &subagent.id == id {
                return Some(vec![index]);
            }
            if let Some(mut path) = subagent.chat.path_to(id) {
                path.insert(0, index);
                return Some(path);
            }
        }
        None
    }

    fn chat_at(&self, path: &[usize]) -> &ChatWidget {
        match path.split_first() {
            Some((first, rest)) => self
                .subagents
                .get(*first)
                .map_or(self, |subagent| subagent.chat.chat_at(rest)),
            None => self,
        }
    }

    fn chat_at_mut(&mut self, path: &[usize]) -> &mut ChatWidget {
        let Some((first, rest)) = path.split_first() else {
            return self;
        };
        if *first >= self.subagents.len() {
            return self;
        }
        self.subagents[*first].chat.chat_at_mut(rest)
    }

    /// The subagent at `path`.
    fn subagent_at(&self, path: &[usize]) -> Option<&Subagent> {
        let (last, parent) = path.split_last()?;
        self.chat_at(parent).subagents.get(*last)
    }

    fn label_at(&self, path: &[usize]) -> String {
        self.subagent_at(path)
            .map_or_else(|| "A subagent".to_owned(), Subagent::label)
    }

    /// What another session is called, from this chat: one of its subagents, or its parent.
    fn session_label(&self, id: &SessionId) -> String {
        if let Some(path) = self.path_to(id) {
            return self.label_at(&path);
        }
        self.parent_label
            .clone()
            .unwrap_or_else(|| "another agent".to_owned())
    }

    /// The chat whose transcript is shown: this one, or the subagent being watched.
    fn shown(&self) -> &ChatWidget {
        match self.watching.as_ref().and_then(|id| self.path_to(id)) {
            Some(path) => self.chat_at(&path),
            None => self,
        }
    }

    fn shown_mut(&mut self) -> &mut ChatWidget {
        match self.watching.clone().and_then(|id| self.path_to(&id)) {
            Some(path) => self.chat_at_mut(&path),
            None => self,
        }
    }

    /// The subagent being watched.
    fn watched(&self) -> Option<&Subagent> {
        let path = self.path_to(self.watching.as_ref()?)?;
        self.subagent_at(&path)
    }

    /// Every agent in the order Alt+Right visits them: this session, then each subagent
    /// before its own, in the order they appeared.
    fn agent_order(&self) -> Vec<Option<SessionId>> {
        fn walk(chat: &ChatWidget, order: &mut Vec<Option<SessionId>>) {
            for subagent in &chat.subagents {
                order.push(Some(subagent.id.clone()));
                walk(&subagent.chat, order);
            }
        }
        let mut order = vec![None];
        walk(self, &mut order);
        order
    }

    /// Watch the next or previous agent, as Codex's Alt+Right and Alt+Left do.
    fn cycle_agents(&mut self, forward: bool) {
        let order = self.agent_order();
        let current = order
            .iter()
            .position(|id| *id == self.watching)
            .unwrap_or(0);
        let next = if forward {
            (current + 1) % order.len()
        } else {
            (current + order.len() - 1) % order.len()
        };
        self.watch(order.get(next).cloned().flatten());
    }

    fn watch(&mut self, id: Option<SessionId>) {
        self.watching = id.filter(|id| self.path_to(id).is_some());
        if let Some(view) = &mut self.shown_mut().transcript {
            view.follow();
        }
    }

    /// The picker's rows: this session, then every subagent, nested under its parent.
    fn picker_entries(&self) -> Vec<subagents::PickerEntry> {
        fn walk(
            chat: &ChatWidget,
            depth: usize,
            now: Instant,
            entries: &mut Vec<subagents::PickerEntry>,
        ) {
            for subagent in &chat.subagents {
                entries.push(subagents::PickerEntry {
                    id: Some(subagent.id.clone()),
                    label: subagent.label(),
                    description: subagent.description.clone(),
                    running: subagent.is_running(),
                    activity: subagent.activity(now),
                    depth,
                });
                walk(&subagent.chat, depth + 1, now, entries);
            }
        }
        let now = Instant::now();
        let mut entries = vec![subagents::PickerEntry {
            id: None,
            label: "Main".to_owned(),
            description: None,
            running: self.turn.is_some(),
            activity: if self.turn.is_some() {
                "working".to_owned()
            } else {
                String::new()
            },
            depth: 0,
        }];
        walk(self, 0, now, &mut entries);
        entries
    }

    fn running_subagents(&self) -> usize {
        fn count(chat: &ChatWidget) -> usize {
            chat.subagents
                .iter()
                .map(|subagent| usize::from(subagent.is_running()) + count(&subagent.chat))
                .sum()
        }
        count(self)
    }

    /// Offer `/subagents`, which opens the picker here rather than going to the agent.
    fn offer_subagents_command(&mut self) {
        if !self
            .commands
            .iter()
            .any(|command| command.name == subagents::COMMAND)
        {
            self.commands.push(AvailableCommand::new(
                subagents::COMMAND,
                subagents::COMMAND_DESCRIPTION,
            ));
        }
    }

    /// A new subagent's own chat, which shows its updates as this chat shows the session's.
    fn subagent_chat(&self, id: &SessionId, label: &str) -> ChatWidget {
        let abilities = SessionAbilities {
            list: false,
            delete: false,
        };
        let mut chat =
            ChatWidget::new(label.to_owned(), self.cwd.clone(), abilities, self.width).fullscreen();
        chat.begin_session(id.clone(), None);
        chat.session_ready(OpenedSession {
            session_id: id.clone(),
            modes: None,
            config_options: Vec::new(),
            reopened: Some(Reopened::Loaded),
            cwd: None,
        });
        chat
    }

    /// A subagent appeared, or what the parent says about it changed: its label, controls
    /// or work. Its arrival and the end of its work become rows here, as in Codex.
    fn apply_subagent_update(&mut self, update: SubagentUpdate) {
        let now = Instant::now();
        let existing = self
            .subagents
            .iter()
            .position(|subagent| subagent.id == update.session_id);
        let index = match existing {
            Some(index) => index,
            None => {
                let number = self.subagents.len() + 1;
                let label = format!("Subagent {number}");
                let mut chat = self.subagent_chat(&update.session_id, &label);
                chat.parent_label = Some(self.agent_label());
                self.subagents.push(Subagent {
                    id: update.session_id.clone(),
                    title: None,
                    description: None,
                    number,
                    cancel: false,
                    state: None,
                    since: now,
                    chat: Box::new(chat),
                });
                self.offer_subagents_command();
                self.subagents.len() - 1
            }
        };
        let previous = self.subagents[index].apply(&update, now);
        let label = self.subagents[index].label();
        self.subagents[index].chat.agent_name.clone_from(&label);
        if existing.is_none() {
            let event = subagents::Event::Spawned {
                description: self.subagents[index].description.clone(),
            };
            self.push_subagent_event(&label, event);
        }
        let MaybeUndefined::Value(state) = &update.state else {
            return;
        };
        if matches!(state, StateUpdate::Idle(_)) {
            // Its work is over for now: what it said settles into its transcript.
            self.subagents[index].chat.finish_live_cells();
        }
        let reply = self.subagents[index].chat.last_reply.clone();
        if let Some(event) = subagents::Event::for_state(previous.as_ref(), state, reply) {
            self.push_subagent_event(&label, event);
        }
        if let StateUpdate::Idle(idle) = state
            && idle.stop_reason == Some(StopReason::Cancelled)
        {
            let id = update.session_id.clone();
            self.cancel_requests_from(&id);
        }
    }

    fn push_subagent_event(&mut self, label: &str, event: subagents::Event) {
        let label = label.to_owned();
        self.push_cell(TranscriptCell::new(move |width| {
            subagents::event_lines(&label, &event, width)
        }));
    }

    /// What this chat is called by its subagents: "Main", or its own label.
    fn agent_label(&self) -> String {
        if self.parent_label.is_some() {
            self.agent_name.clone()
        } else {
            "Main".to_owned()
        }
    }

    /// A cancelled subagent's pending requests resolve as cancelled, as the RFD asks.
    fn cancel_requests_from(&mut self, id: &SessionId) {
        let (cancelled, kept): (VecDeque<_>, VecDeque<_>) = std::mem::take(&mut self.permissions)
            .into_iter()
            .partition(|pending| &pending.request.request.session_id == id);
        self.permissions = kept;
        for pending in cancelled {
            let _ = pending.request.cancel();
        }
    }

    fn message_entry(
        &mut self,
        id: &MessageId,
        sender: Option<SessionId>,
        recipient: Option<SessionId>,
    ) -> &mut SessionMessageEntry {
        let index = match self.messages.iter().position(|entry| &entry.id == id) {
            Some(index) => index,
            None => {
                self.end_stream();
                self.messages.push(SessionMessageEntry {
                    id: id.clone(),
                    sender: None,
                    recipient: None,
                    text: String::new(),
                });
                self.messages.len() - 1
            }
        };
        let entry = &mut self.messages[index];
        // Participants, once known, stay known.
        if sender.is_some() {
            entry.sender = sender;
        }
        if recipient.is_some() {
            entry.recipient = recipient;
        }
        entry
    }

    fn apply_session_message(&mut self, message: SessionMessage) {
        let entry = self.message_entry(
            &message.message_id,
            message.sender_session_id,
            message.recipient_session_id,
        );
        match message.content {
            MaybeUndefined::Undefined => {}
            MaybeUndefined::Null => entry.text.clear(),
            MaybeUndefined::Value(blocks) => {
                entry.text = blocks.iter().map(content_text).collect();
            }
        }
        self.note_activity();
    }

    fn append_session_message(&mut self, chunk: SessionMessageChunk) {
        let entry = self.message_entry(
            &chunk.message_id,
            chunk.sender_session_id,
            chunk.recipient_session_id,
        );
        entry.text.push_str(&content_text(&chunk.content));
        self.note_activity();
    }

    /// How a message between sessions shows here: to or from one of this session's
    /// subagents, as Codex shows those, or to or from this one's parent.
    fn message_shape(&self, entry: &SessionMessageEntry) -> MessageShape {
        let own = self.active_session.as_ref();
        let outgoing = entry
            .sender
            .as_ref()
            .is_some_and(|sender| Some(sender) == own)
            || entry
                .recipient
                .as_ref()
                .is_some_and(|recipient| Some(recipient) != own);
        let other = if outgoing {
            entry.recipient.as_ref()
        } else {
            entry.sender.as_ref()
        };
        MessageShape {
            label: other.map_or_else(|| "another agent".to_owned(), |id| self.session_label(id)),
            outgoing,
            to_subagent: other.is_some_and(|id| self.path_to(id).is_some()),
            text: entry.text.clone(),
        }
    }

    /// Commit the messages that were streaming.
    fn flush_messages(&mut self) {
        if self.messages.is_empty() {
            return;
        }
        for entry in std::mem::take(&mut self.messages) {
            let shape = self.message_shape(&entry);
            self.push_cell(TranscriptCell::new(move |width| shape.lines(width)));
        }
    }

    fn terminal_output(&mut self, terminal_id: &TerminalId, text: &str) {
        self.terminals
            .entry(terminal_id.clone())
            .or_default()
            .append(text);
        // A subagent's tool calls embed terminals too.
        for subagent in &mut self.subagents {
            subagent.chat.terminal_output(terminal_id, text);
        }
    }

    fn terminal_exited(&mut self, terminal_id: &TerminalId, status: &TerminalExitStatus) {
        self.terminals
            .entry(terminal_id.clone())
            .or_default()
            .set_exit(status.clone());
        for subagent in &mut self.subagents {
            subagent.chat.terminal_exited(terminal_id, status);
        }
    }

    /// The outcome of an [`AppCommand::ChangeSetting`]. Config option changes return every
    /// option's new state.
    pub fn setting_changed(
        &mut self,
        change: SettingChange,
        result: Result<Option<Vec<SessionConfigOption>>, Error>,
    ) {
        match (change, result) {
            (_, Err(error)) => self.push_error(&format!("Couldn't change the setting: {error}")),
            (SettingChange::ConfigOption(..), Ok(options)) => {
                if let Some(options) = options {
                    self.replace_config_options(options);
                }
            }
            (SettingChange::Mode(mode_id), Ok(_)) => {
                if let Some(modes) = &mut self.modes {
                    modes.current_mode_id = mode_id;
                }
                if let Some(name) = self.current_mode_name().map(str::to_owned) {
                    self.push_cell(TranscriptCell::info(&format!("Mode set to {name}")));
                }
            }
        }
    }

    fn replace_config_options(&mut self, options: Vec<SessionConfigOption>) {
        let changes = settings::describe_changes(&self.config_options, &options);
        self.config_options = options;
        if !changes.is_empty() {
            self.end_stream();
            self.push_cell(TranscriptCell::info(&changes.join(" · ")));
        }
    }

    /// Record which `@` mentions went to the agent as attachments.
    pub fn note_attachments(&mut self, attachments: &[Attachment]) {
        if attachments.is_empty() {
            return;
        }
        let list = attachments
            .iter()
            .map(|attachment| format!("{} ({})", attachment.name, attachment.kind))
            .collect::<Vec<_>>()
            .join(", ");
        self.push_cell(TranscriptCell::info(&format!("Attached {list}")));
    }

    /// The agent rejected the prompt request before the turn could start.
    pub fn prompt_failed(&mut self, error: &Error) {
        self.turn = None;
        self.push_error(&format!("Prompt failed: {error}"));
    }

    fn handle_update(&mut self, update: SessionUpdate) {
        // A message between sessions ends when something else arrives.
        if !matches!(
            update,
            SessionUpdate::SessionMessage(_) | SessionUpdate::SessionMessageChunk(_)
        ) {
            self.flush_messages();
        }
        match update {
            SessionUpdate::AgentMessageChunk(chunk) => {
                self.stream_content(StreamKind::Agent, &chunk)
            }
            SessionUpdate::AgentThoughtChunk(chunk) => {
                self.stream_content(StreamKind::Thought, &chunk)
            }
            // Sent when an agent replays a session's history.
            SessionUpdate::UserMessageChunk(chunk) => self.stream_content(StreamKind::User, &chunk),
            SessionUpdate::ToolCall(call) => {
                self.end_stream();
                self.note_activity();
                if self.committed_tool_calls.contains(&call.tool_call_id) {
                    return;
                }
                let cell = ToolCallCell::new(call);
                match self.tool_calls.iter_mut().find(|live| live.id == cell.id) {
                    Some(live) => *live = cell,
                    None => {
                        // A finished call stays live until the next entry, as Codex keeps its
                        // active cell, so updates trailing its completion still reach it: a
                        // replay sends the completed call before its output.
                        self.commit_finished_tool_calls();
                        self.tool_calls.push(cell);
                    }
                }
            }
            SessionUpdate::ToolCallUpdate(update) => {
                self.end_stream();
                self.note_activity();
                self.apply_tool_call_update(update.tool_call_id, &update.fields);
            }
            SessionUpdate::Plan(plan) => {
                self.end_stream();
                self.push_cell(TranscriptCell::plan(plan));
            }
            SessionUpdate::CurrentModeUpdate(update) => {
                if let Some(modes) = &mut self.modes {
                    modes.current_mode_id = update.current_mode_id;
                }
                // Agents with config options report the change there too.
                if !self.config_options.is_empty() {
                    return;
                }
                if let Some(name) = self.current_mode_name().map(str::to_owned) {
                    self.end_stream();
                    self.push_cell(TranscriptCell::info(&format!("Mode changed to {name}")));
                }
            }
            SessionUpdate::UsageUpdate(usage) => {
                self.context = Some((usage.used, usage.size));
                // Cumulative, so a report without a cost leaves the last one standing.
                if let Some(cost) = usage.cost {
                    self.cost = Some((cost.amount, cost.currency));
                }
            }
            SessionUpdate::ConfigOptionUpdate(update) => {
                self.replace_config_options(update.config_options)
            }
            SessionUpdate::AvailableCommandsUpdate(update) => {
                self.commands = update.available_commands;
                if !self.subagents.is_empty() {
                    self.offer_subagents_command();
                }
                self.sync_popup();
            }
            SessionUpdate::SubagentUpdate(update) => self.apply_subagent_update(update),
            SessionUpdate::SessionMessage(message) => self.apply_session_message(message),
            SessionUpdate::SessionMessageChunk(chunk) => self.append_session_message(chunk),
            SessionUpdate::SessionInfoUpdate(info) => match info.title {
                MaybeUndefined::Value(title) => self.title = Some(title),
                MaybeUndefined::Null => self.title = None,
                _ => {}
            },
            SessionUpdate::CompactionUpdate(update) => self.apply_compaction_update(update),
            // A chunk for an id the agent hasn't started is out of order; it's dropped.
            SessionUpdate::CompactionSummaryChunk(chunk) => {
                if let Some(live) = self
                    .compactions
                    .iter_mut()
                    .find(|live| live.id == chunk.compaction_id)
                {
                    live.append(chunk.content);
                }
            }
            _ => {}
        }
    }

    /// The first update for an id places the compaction in the timeline; later ones patch
    /// it, and once finished it is committed there.
    fn apply_compaction_update(&mut self, update: CompactionUpdate) {
        if self.committed_compactions.contains(&update.compaction_id) {
            return;
        }
        self.note_activity();
        let now = Instant::now();
        match self
            .compactions
            .iter_mut()
            .find(|live| live.id == update.compaction_id)
        {
            Some(live) => live.apply(update, now),
            None => {
                // Only a new entity ends the message before it; patches don't split one.
                self.end_stream();
                self.compactions.push(Compaction::new(update, now));
            }
        }
        let (finished, running): (Vec<_>, Vec<_>) = std::mem::take(&mut self.compactions)
            .into_iter()
            .partition(Compaction::is_finished);
        self.compactions = running;
        for compaction in finished {
            self.commit_compaction(compaction);
        }
    }

    fn commit_compaction(&mut self, compaction: Compaction) {
        self.committed_compactions.insert(compaction.id.clone());
        self.push_cell(TranscriptCell::compaction(compaction));
    }

    fn apply_tool_call_update(
        &mut self,
        id: ToolCallId,
        fields: &weave_acp_core::schema::ToolCallUpdateFields,
    ) {
        if self.committed_tool_calls.contains(&id) {
            return;
        }
        match self.tool_calls.iter_mut().find(|live| live.id == id) {
            Some(live) => live.apply(fields),
            // An update for a call never announced starts one, unless it has nothing to show,
            // such as only `_meta` for a call the agent reported another way (a subagent).
            None if has_content(fields) => {
                self.tool_calls.push(ToolCallCell::from_update(id, fields));
            }
            None => {}
        }
    }

    /// Show a permission prompt; returns what a notification about it should say.
    fn handle_permission(&mut self, request: PermissionRequest) -> Option<String> {
        let subject = self.permission_subject(&request);
        if self.turn.as_ref().is_some_and(|turn| turn.cancelling) {
            // The protocol requires every pending request to resolve as cancelled.
            let _ = request.cancel();
            return None;
        }
        self.queue_permission(request, subject, None)
    }

    /// What a permission request asks about, from the tool call it names in this chat.
    fn permission_subject(&mut self, request: &PermissionRequest) -> Subject {
        let call = &request.request.tool_call;
        self.apply_tool_call_update(call.tool_call_id.clone(), &call.fields);
        self.tool_calls
            .iter()
            .find(|live| live.id == call.tool_call_id)
            .map_or_else(
                || Subject::about("this tool call"),
                |live| live.permission_subject(&self.cwd),
            )
    }

    /// Show a permission prompt, naming the subagent that asks when one does; returns what a
    /// notification about it should say.
    fn queue_permission(
        &mut self,
        request: PermissionRequest,
        mut subject: Subject,
        from: Option<&str>,
    ) -> Option<String> {
        if let Some(from) = from {
            subject.question = format!("{from}: {}", subject.question);
        }
        let notice = match subject.detail.first() {
            Some(detail) => format!("Approval requested: {detail}"),
            None => subject.question.clone(),
        };
        let view = PermissionView::new(subject, request.request.options.clone());
        self.permissions
            .push_back(PendingPermission { request, view });
        Some(notice)
    }

    /// Show an elicitation; returns what a notification about it should say.
    fn handle_elicitation(&mut self, request: ElicitationRequest) -> Option<String> {
        // A session-scoped request for a session not shown here cannot be answered by the user.
        let scope = match &request.request.mode {
            ElicitationMode::Form(form) => Some(&form.scope),
            ElicitationMode::Url(url) => Some(&url.scope),
            _ => None,
        };
        if let Some(ElicitationScope::Session(scope)) = scope
            && !self.is_active(&scope.session_id)
        {
            let _ = request.cancel();
            return None;
        }
        match ElicitationView::new(&request.request, &self.agent_name) {
            Some(view) => {
                let notice = format!("{} asks: {}", self.agent_name, request.request.message);
                self.elicitations
                    .push_back(PendingElicitation { request, view });
                Some(notice)
            }
            None => {
                let _ = request.cancel();
                None
            }
        }
    }

    fn end_turn(&mut self, result: Result<PromptResponse, Error>) -> Vec<AppCommand> {
        self.finish_live_cells();
        // An agent must resolve its permission requests before ending the turn; any left over
        // can no longer be answered meaningfully.
        self.answer_pending_requests_cancelled();
        let turn = self.turn.take();
        let was_cancelling = turn.as_ref().is_some_and(|turn| turn.cancelling);
        let notice = match &result {
            Ok(response) if response.stop_reason == StopReason::Cancelled => None,
            Ok(response) if response.stop_reason == StopReason::EndTurn => Some(
                self.last_reply
                    .as_deref()
                    .map_or_else(|| "Turn complete".to_owned(), str::to_owned),
            ),
            Ok(_) => Some("The turn stopped early".to_owned()),
            Err(error) => Some(format!("Turn failed: {error}")),
        };
        match result {
            Ok(response) => {
                if response.stop_reason == StopReason::EndTurn
                    && let Some(turn) = &turn
                {
                    self.push_cell(TranscriptCell::turn_summary(
                        turn.started.elapsed(),
                        clock_label(),
                    ));
                }
                let note = match response.stop_reason {
                    StopReason::EndTurn => None,
                    StopReason::Cancelled => Some("Turn cancelled"),
                    StopReason::MaxTokens => Some("Stopped: the agent reached its token limit"),
                    StopReason::MaxTurnRequests => {
                        Some("Stopped: the turn made too many model requests")
                    }
                    StopReason::Refusal => Some("The agent refused to continue"),
                    _ => Some("Stopped for an unrecognized reason"),
                };
                if let Some(note) = note {
                    self.push_cell(TranscriptCell::info(note));
                }
            }
            Err(error) => self.push_error(&format!("Turn failed: {error}")),
        }
        if was_cancelling {
            return Vec::new();
        }
        // A queued message goes straight on, so nothing needs the user yet.
        match self.queued.pop_front() {
            Some(text) => self.start_prompt(text),
            None => notice.map(AppCommand::Notify).into_iter().collect(),
        }
    }

    pub fn handle_paste(&mut self, text: &str) {
        if self
            .viewed_mut()
            .is_some_and(|(view, live)| view.find_paste(text, &live))
        {
            return;
        }
        if let Some(pending) = self.elicitations.front_mut() {
            pending.view.handle_paste(text);
            return;
        }
        if self.permissions.is_empty() && self.settings.is_none() && self.session_picker.is_none() {
            // A dragged-in image file pastes as its path; attach it instead, as Codex does.
            if !self.composer.is_shell()
                && let Some(path) = clipboard::pasted_image_path(text, &self.cwd)
            {
                self.attach_image(path);
                return;
            }
            self.composer.insert_str(text);
            self.sync_popup();
        }
    }

    /// Attach an image to the draft, shown there as `[image N]` as Codex shows them.
    pub fn attach_image(&mut self, path: PathBuf) {
        self.images.push(path);
        let space = self
            .composer
            .char_before_cursor()
            .is_some_and(|ch| !ch.is_whitespace());
        let lead = if space { " " } else { "" };
        self.composer
            .insert_str(&format!("{lead}[image {}] ", self.images.len()));
        self.sync_popup();
    }

    /// The images a prompt's text still refers to, with their labels.
    pub fn prompt_images(&self, text: &str) -> Vec<(String, PathBuf)> {
        self.images
            .iter()
            .enumerate()
            .map(|(index, path)| (format!("image {}", index + 1), path))
            .filter(|(label, _)| text.contains(&format!("[{label}]")))
            .map(|(label, path)| (label, path.clone()))
            .collect()
    }

    /// Show a note from outside the conversation.
    pub fn report_info(&mut self, message: &str) {
        self.push_cell(TranscriptCell::info(message));
    }

    pub fn handle_key(&mut self, key: KeyEvent) -> Vec<AppCommand> {
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        // Find's query takes every key while it's typed, Ctrl+C included, as in Codex.
        if self.find_key(key) {
            return Vec::new();
        }
        if ctrl && key.code == KeyCode::Char('c') {
            return self.interrupt();
        }
        self.quit_armed_until = None;
        if ctrl
            && key.code == KeyCode::Char('d')
            && self.composer.is_empty()
            && (self.turn.is_none() || self.detachable)
        {
            return vec![AppCommand::Quit];
        }
        if self.pager_open {
            self.handle_pager_key(key);
            return Vec::new();
        }
        if let Some(commands) = self.handle_subagent_key(key) {
            return commands;
        }
        if key.code == KeyCode::F(3) && self.watching.is_some() {
            if let Some(view) = &mut self.shown_mut().transcript {
                view.begin_find();
            }
            return Vec::new();
        }
        if ctrl && key.code == KeyCode::Char('t') && self.watching.is_some() {
            if let Some(view) = &mut self.shown_mut().transcript {
                let detailed = view.is_detailed();
                view.set_detailed(!detailed);
            }
            return Vec::new();
        }
        if key.code == KeyCode::F(3) {
            match &mut self.transcript {
                Some(view) => view.begin_find(),
                // Inline, Find searches in the pager.
                None => {
                    if let Some(pager) = &mut self.pager {
                        self.pager_open = true;
                        pager.follow();
                        pager.begin_find();
                    }
                }
            }
            return Vec::new();
        }
        if ctrl && key.code == KeyCode::Char('t') {
            match &mut self.transcript {
                Some(view) => {
                    let detailed = view.is_detailed();
                    view.set_detailed(!detailed);
                }
                None => {
                    self.pager_open = true;
                    if let Some(pager) = &mut self.pager {
                        pager.follow();
                    }
                }
            }
            return Vec::new();
        }
        if let Some(commands) = self.handle_scroll_key(key) {
            return commands;
        }

        if let Some(pending) = self.permissions.front_mut() {
            return match pending.view.handle_key(key) {
                Some(Decision::Select(option_id)) => {
                    if let Some(pending) = self.permissions.pop_front() {
                        let _ = pending.request.select(option_id);
                    }
                    Vec::new()
                }
                Some(Decision::CancelTurn) => self.cancel_turn(),
                None => Vec::new(),
            };
        }

        if let Some(pending) = self.elicitations.front_mut() {
            let Some(outcome) = pending.view.handle_key(key) else {
                return Vec::new();
            };
            let Some(pending) = self.elicitations.pop_front() else {
                return Vec::new();
            };
            return match outcome {
                ElicitationOutcome::Accept(content) => {
                    let _ = pending.request.accept(content);
                    Vec::new()
                }
                ElicitationOutcome::OpenUrl(url) => {
                    if let ElicitationView::Url(view) = &pending.view {
                        self.accepted_urls.insert(view.elicitation_id.clone());
                    }
                    let _ = pending.request.accept(None);
                    vec![AppCommand::OpenUrl(url)]
                }
                ElicitationOutcome::Decline => {
                    let _ = pending.request.decline();
                    Vec::new()
                }
                ElicitationOutcome::Cancel => {
                    let _ = pending.request.cancel();
                    Vec::new()
                }
            };
        }

        if let Some(mut picker) = self.subagent_picker.take() {
            let entries = self.picker_entries();
            match picker.handle_key(key, &entries) {
                Some(subagents::PickerAction::Watch(id)) => self.watch(id),
                Some(subagents::PickerAction::Close) => {}
                None => self.subagent_picker = Some(picker),
            }
            return Vec::new();
        }

        if let Some(picker) = &mut self.session_picker {
            let Some(action) = picker.handle_key(key) else {
                return Vec::new();
            };
            return match action {
                PickerAction::Open(session) => vec![AppCommand::OpenSession {
                    target: SessionTarget::Existing(session.session_id),
                    title: session.title,
                    cwd: Some(session.cwd),
                }],
                PickerAction::New => vec![AppCommand::OpenSession {
                    target: SessionTarget::New,
                    title: None,
                    cwd: None,
                }],
                PickerAction::Close => {
                    self.session_picker = None;
                    Vec::new()
                }
                PickerAction::Delete(session_id) => vec![AppCommand::DeleteSession(session_id)],
                PickerAction::List {
                    all_directories,
                    cursor,
                } => {
                    vec![AppCommand::ListSessions {
                        all_directories,
                        cursor,
                    }]
                }
            };
        }

        if ctrl && key.code == KeyCode::Char('r') {
            if self.turn.is_some() {
                self.push_cell(TranscriptCell::info(
                    "Finish or cancel the current turn before switching sessions",
                ));
                return Vec::new();
            }
            if !self.abilities.list {
                self.push_cell(TranscriptCell::info("This agent can't list its sessions"));
                return Vec::new();
            }
            return self.open_session_picker(false);
        }

        if let Some(picker) = &mut self.settings {
            return match picker.handle_key(key, &self.config_options, self.modes.as_ref()) {
                PickerOutcome::Open => Vec::new(),
                PickerOutcome::Close => {
                    self.settings = None;
                    Vec::new()
                }
                // The picker stays open, showing the change once the agent confirms it.
                PickerOutcome::Apply(change) => vec![AppCommand::ChangeSetting(change)],
            };
        }
        if ctrl && key.code == KeyCode::Char('o') {
            if !self.disconnected {
                self.settings = Some(SettingsPicker::new());
            }
            return Vec::new();
        }
        if key.code == KeyCode::BackTab {
            return settings::next_mode(&self.config_options, self.modes.as_ref())
                .filter(|_| !self.disconnected)
                .map(AppCommand::ChangeSetting)
                .into_iter()
                .collect();
        }
        if self.shortcuts_open {
            self.shortcuts_open = false;
            if matches!(key.code, KeyCode::Char('?') | KeyCode::Esc) {
                return Vec::new();
            }
        } else if key.code == KeyCode::Char('?')
            && key.modifiers.difference(KeyModifiers::SHIFT).is_empty()
            && self.composer.is_empty()
            && !self.composer.is_vim()
        {
            self.shortcuts_open = true;
            return Vec::new();
        }
        if ctrl && key.code == KeyCode::Char('v') {
            return vec![AppCommand::PasteImage];
        }
        if ctrl && key.code == KeyCode::Char('g') {
            if self.vim {
                self.composer.toggle_vim();
                self.sync_popup();
            }
            return Vec::new();
        }
        if self.handle_file_popup_key(key) {
            return Vec::new();
        }
        if let Some(commands) = self.handle_popup_key(key) {
            return commands;
        }
        if key.code == KeyCode::Esc && self.composer.is_shell() && self.composer.is_empty() {
            self.composer.leave_shell();
            return Vec::new();
        }
        // Watching a subagent, Esc goes back to this session, after popups have had it and
        // unless a Vim draft is being edited.
        if key.code == KeyCode::Esc
            && self.watching.is_some()
            && self
                .composer
                .vim()
                .is_none_or(|vim| vim.mode() == crate::vim::Mode::Normal)
        {
            self.watch(None);
            return Vec::new();
        }
        // In the Vim composer, Esc only ever changes mode; Ctrl+C interrupts.
        if key.code == KeyCode::Esc && !self.composer.is_vim() {
            return self.cancel_turn();
        }
        let action = self.composer.handle_key(key);
        self.sync_popup();
        self.submit(action)
    }

    /// Keys for subagents, once there are any: Alt+Left and Alt+Right watch the previous and
    /// next agent, as in Codex (Alt+B and Alt+F too, on an empty draft, for terminals that
    /// send those for Option+arrows).
    fn handle_subagent_key(&mut self, key: KeyEvent) -> Option<Vec<AppCommand>> {
        if self.subagents.is_empty() {
            return None;
        }
        let alt = key.modifiers.contains(KeyModifiers::ALT);
        let empty = self.composer.is_empty();
        match key.code {
            KeyCode::Left if alt => self.cycle_agents(false),
            KeyCode::Right if alt => self.cycle_agents(true),
            KeyCode::Char('b') if alt && empty => self.cycle_agents(false),
            KeyCode::Char('f') if alt && empty => self.cycle_agents(true),
            _ => return None,
        }
        Some(Vec::new())
    }

    fn open_subagent_picker(&mut self) {
        let entries = self.picker_entries();
        self.subagent_picker = Some(subagents::Picker::new(&entries, self.watching.as_ref()));
    }

    /// Fullscreen transcript navigation. It comes before prompts and pickers so the transcript
    /// can be read while one is open: PageUp/PageDown, Ctrl+Home/End (or Alt+< and Alt+>),
    /// and Esc back to the newest output while reading.
    fn handle_scroll_key(&mut self, key: KeyEvent) -> Option<Vec<AppCommand>> {
        // Esc belongs to the Vim composer, which uses it to change modes.
        let vim = self.composer.is_vim() && !self.has_overlay();
        let view = self.shown_mut().transcript.as_mut()?;
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        let alt = key.modifiers.contains(KeyModifiers::ALT);
        let shift = key.modifiers.contains(KeyModifiers::SHIFT);
        match key.code {
            KeyCode::PageUp => view.scroll_pages(-1),
            KeyCode::PageDown => view.scroll_pages(1),
            KeyCode::Home if ctrl => view.scroll_to_start(),
            KeyCode::End if ctrl => view.follow(),
            KeyCode::Char('<') if alt => view.scroll_to_start(),
            KeyCode::Char('>') if alt => view.follow(),
            KeyCode::Char(',') if alt && shift => view.scroll_to_start(),
            KeyCode::Char('.') if alt && shift => view.follow(),
            KeyCode::Esc if view.reading() != Reading::Latest && !vim => view.follow(),
            _ => return None,
        }
        Some(Vec::new())
    }

    /// Find's keys in whichever transcript is showing; returns whether the key was Find's.
    fn find_key(&mut self, key: KeyEvent) -> bool {
        self.viewed_mut()
            .is_some_and(|(view, live)| view.find_key(key, &live))
    }

    /// The Find status of whichever transcript is showing, while Find is open.
    fn find_status(&self) -> Option<FindStatus<'_>> {
        self.viewed().and_then(TranscriptView::find_status)
    }

    /// The transcript being looked at, with the live rows drawn under it: a watched
    /// subagent's, the inline pager, or this session's.
    fn viewed_mut(&mut self) -> Option<(&mut TranscriptView, Vec<DisplayLine>)> {
        let width = self.content_width();
        if self.watching.is_some() {
            let chat = self.shown_mut();
            let live = chat.live_lines(width);
            return chat.transcript.as_mut().map(|view| (view, live));
        }
        let live = self.live_lines(width);
        let view = if self.pager_open {
            self.pager.as_mut()
        } else {
            self.transcript.as_mut()
        };
        view.map(|view| (view, live))
    }

    fn viewed(&self) -> Option<&TranscriptView> {
        if self.watching.is_some() {
            return self.shown().transcript.as_ref();
        }
        if self.pager_open {
            self.pager.as_ref()
        } else {
            self.transcript.as_ref()
        }
    }

    /// The inline pager's keys: scrolling, Find (`/`, then `n` and `N` between matches, as
    /// in less), and closing on Esc, q or Ctrl+T.
    fn handle_pager_key(&mut self, key: KeyEvent) {
        let live = self.live_lines(self.content_width());
        let Some(pager) = &mut self.pager else {
            self.pager_open = false;
            return;
        };
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        let finding = pager.find_status().is_some();
        match key.code {
            KeyCode::Char('/') | KeyCode::F(3) => pager.begin_find(),
            KeyCode::Char('n') if finding => {
                pager.find_key(
                    KeyEvent::new(KeyCode::Char('p'), KeyModifiers::CONTROL),
                    &live,
                );
            }
            KeyCode::Char('N') if finding => {
                pager.find_key(
                    KeyEvent::new(KeyCode::Char('n'), KeyModifiers::CONTROL),
                    &live,
                );
            }
            KeyCode::Esc | KeyCode::Char('q') => self.pager_open = false,
            KeyCode::Char('t') if ctrl => self.pager_open = false,
            KeyCode::Up | KeyCode::Char('k') => pager.scroll_rows(-1),
            KeyCode::Down | KeyCode::Char('j') => pager.scroll_rows(1),
            KeyCode::PageUp | KeyCode::Char('b') => pager.scroll_pages(-1),
            KeyCode::PageDown | KeyCode::Char(' ') => pager.scroll_pages(1),
            KeyCode::Home | KeyCode::Char('g') => pager.scroll_to_start(),
            KeyCode::End | KeyCode::Char('G') => pager.follow(),
            _ => {}
        }
    }

    /// Wheel scrolling and drag selection in the fullscreen transcript (or the inline pager);
    /// a finished selection is copied.
    pub fn handle_mouse(&mut self, event: MouseEvent) -> Vec<AppCommand> {
        let Some((view, live)) = self.viewed_mut() else {
            return Vec::new();
        };
        match view.handle_mouse(event, &live) {
            Some(text) if !text.is_empty() => {
                let count = text.chars().count();
                let noun = if count == 1 {
                    "character"
                } else {
                    "characters"
                };
                let note = format!("Copied {count} {noun}");
                self.copied = Some((note, Instant::now() + COPIED_NOTE));
                vec![AppCommand::Copy(text)]
            }
            _ => Vec::new(),
        }
    }

    /// The `@` mention being typed: where it starts in the draft and what follows the `@`.
    fn mention_query(&self) -> Option<(usize, String)> {
        if self.composer.is_shell() || self.has_overlay() || !self.composer.completes() {
            return None;
        }
        let (start, word) = self.composer.word_before_cursor();
        let query = word.strip_prefix('@')?;
        let query = query.strip_prefix('"').unwrap_or(query);
        (!self.file_popup.is_dismissed(start, query)).then(|| (start, query.to_owned()))
    }

    /// The file picker's matches while an `@` mention is being typed: `Some(None)` while the
    /// files are still being indexed.
    fn file_matches(&self) -> Option<Option<Vec<String>>> {
        let (_, query) = self.mention_query()?;
        self.files.ensure();
        Some(self.files.search(&query, file_popup::VISIBLE_ROWS))
    }

    /// Keys the file picker claims while open: selection, completion, and dismissal.
    fn handle_file_popup_key(&mut self, key: KeyEvent) -> bool {
        let Some((start, query)) = self.mention_query() else {
            return false;
        };
        let matches = self.files.search(&query, file_popup::VISIBLE_ROWS);
        let count = matches.as_ref().map_or(0, Vec::len);
        let plain = key.modifiers.difference(KeyModifiers::SHIFT).is_empty();
        match key.code {
            KeyCode::Up => self.file_popup.move_selection(-1, count),
            KeyCode::Down => self.file_popup.move_selection(1, count),
            KeyCode::Esc => self.file_popup.dismiss(start, &query),
            KeyCode::Tab | KeyCode::Enter if plain && count > 0 => {
                let chosen = matches
                    .as_ref()
                    .and_then(|matches| matches.get(self.file_popup.selected()));
                if let Some(path) = chosen {
                    self.composer
                        .replace_before_cursor(start, &file_popup::mention_for(path));
                }
            }
            _ => return false,
        }
        true
    }

    /// Keys the command popup claims while open: selection, completion, and dismissal.
    fn handle_popup_key(&mut self, key: KeyEvent) -> Option<Vec<AppCommand>> {
        let text = self.composer.text().to_owned();
        let matches: Vec<AvailableCommand> = self
            .popup
            .matches(&text, &self.commands)
            .into_iter()
            .cloned()
            .collect();
        if matches.is_empty() {
            return None;
        }
        let refs: Vec<&AvailableCommand> = matches.iter().collect();
        let plain = key.modifiers.difference(KeyModifiers::SHIFT).is_empty();
        let action = match key.code {
            KeyCode::Up => {
                self.popup.move_selection(-1, refs.len());
                return Some(Vec::new());
            }
            KeyCode::Down => {
                self.popup.move_selection(1, refs.len());
                return Some(Vec::new());
            }
            KeyCode::Esc => {
                self.popup.dismiss(&text);
                return Some(Vec::new());
            }
            KeyCode::Tab => self.popup.accept(&refs, false),
            KeyCode::Enter if plain && key.modifiers.is_empty() => self.popup.accept(&refs, true),
            _ => return None,
        };
        match action {
            Some(PopupAction::Complete(command)) => {
                self.composer.clear();
                self.composer.insert_str(&format!("/{} ", command.name));
                self.sync_popup();
                Some(Vec::new())
            }
            Some(PopupAction::Submit(command)) => {
                self.composer.clear();
                self.composer.insert_str(&format!("/{}", command.name));
                let action = self.composer.submit_draft();
                self.sync_popup();
                Some(self.submit(action))
            }
            _ => None,
        }
    }

    fn sync_popup(&mut self) {
        if let Some((_, query)) = self.mention_query() {
            self.file_popup.sync(&query);
        }
        let text = self.composer.text().to_owned();
        let count = self.popup.matches(&text, &self.commands).len();
        self.popup.sync(&text, count);
    }

    fn submit(&mut self, action: ComposerAction) -> Vec<AppCommand> {
        if let ComposerAction::Submit(text) = &action {
            if text.trim() == format!("/{}", subagents::COMMAND) && !self.subagents.is_empty() {
                self.open_subagent_picker();
                return Vec::new();
            }
            // A message goes to this session, so it is what to watch.
            self.watching = None;
        }
        match action {
            ComposerAction::Submit(text) if self.disconnected || self.active_session.is_none() => {
                self.composer.insert_str(&text);
                Vec::new()
            }
            ComposerAction::Submit(text) if self.turn.is_some() || self.opening => {
                self.queued.push_back(text);
                Vec::new()
            }
            ComposerAction::Submit(text) => self.start_prompt(text),
            ComposerAction::Shell(command) => self.start_shell(command),
            ComposerAction::None => Vec::new(),
        }
    }

    /// Ctrl-C: stop the turn if one runs, else clear the draft, else arm (then confirm) quitting.
    fn interrupt(&mut self) -> Vec<AppCommand> {
        // Watching a subagent at work that may be stopped, Ctrl+C stops it.
        if let Some(watched) = self.watched()
            && watched.is_running()
            && watched.cancel
        {
            return vec![AppCommand::CancelSubagent(watched.id.clone())];
        }
        if self.turn.is_some() {
            return self.cancel_turn();
        }
        // Then a shell command still running.
        if let Some(cell) = self
            .tool_calls
            .iter()
            .find(|cell| cell.is_user_shell() && !cell.is_finished())
        {
            return vec![AppCommand::KillShell(cell.id.to_string())];
        }
        if !self.composer.is_empty() {
            self.composer.clear();
            return Vec::new();
        }
        let now = Instant::now();
        if self.quit_armed_until.is_some_and(|until| now < until) {
            return vec![AppCommand::Quit];
        }
        self.quit_armed_until = Some(now + QUIT_WINDOW);
        Vec::new()
    }

    fn start_prompt(&mut self, text: String) -> Vec<AppCommand> {
        // Anything still live belongs to what came before, such as a replay the agent sent
        // after answering `session/load`; the new turn's output must not join it.
        self.finish_live_cells();
        self.push_cell(TranscriptCell::user(&text));
        self.resumable = true;
        self.last_reply = None;
        // Sending a message returns to the newest output, where its reply will appear.
        if let Some(view) = &mut self.transcript {
            view.end_find();
            view.follow();
        }
        let now = Instant::now();
        self.turn = Some(Turn {
            started: now,
            cancelling: false,
            label: "Working".to_owned(),
            label_since: now,
        });
        vec![AppCommand::Prompt(text)]
    }

    /// A turn this client didn't start is running: another client's (through the weave
    /// daemon), or one that was underway when this client attached. It ends like any other.
    fn turn_running_elsewhere(&mut self, elapsed: Duration) {
        if self.turn.is_some() {
            return;
        }
        let now = Instant::now();
        self.resumable = true;
        self.last_reply = None;
        self.turn = Some(Turn {
            started: now.checked_sub(elapsed).unwrap_or(now),
            cancelling: false,
            label: "Working".to_owned(),
            label_since: now,
        });
    }

    fn cancel_turn(&mut self) -> Vec<AppCommand> {
        let Some(turn) = &mut self.turn else {
            return Vec::new();
        };
        if turn.cancelling {
            return Vec::new();
        }
        turn.cancelling = true;
        self.answer_pending_requests_cancelled();
        // Like Codex, give queued follow-ups back for editing rather than sending them.
        if !self.queued.is_empty() && self.composer.is_empty() {
            let restored = self.queued.drain(..).collect::<Vec<_>>().join("\n");
            self.composer.insert_str(&restored);
        }
        vec![AppCommand::Cancel]
    }

    /// Resolve every outstanding request as cancelled: permissions (as the protocol requires
    /// on cancellation) and elicitations (dismissed with the turn).
    fn answer_pending_requests_cancelled(&mut self) {
        for pending in self.permissions.drain(..) {
            let _ = pending.request.cancel();
        }
        for pending in self.elicitations.drain(..) {
            let _ = pending.request.cancel();
        }
    }

    fn stream_content(&mut self, kind: StreamKind, chunk: &ContentChunk) {
        // A new kind, or a different message id where the agent provides them, starts a
        // new message; chunks without ids continue the current one.
        let new_message = self.stream.as_ref().is_some_and(|stream| {
            stream.kind() != kind
                || matches!((stream.message_id(), &chunk.message_id), (Some(current), Some(next)) if current != next)
        });
        if new_message {
            self.end_stream();
        }
        let width = self.content_width();
        let message_id = chunk.message_id.clone();
        let stream = self
            .stream
            .get_or_insert_with(|| MessageStream::new(kind, width, message_id));
        let first = !stream.has_committed();
        stream.push(&content_text(&chunk.content));
        if kind == StreamKind::Thought
            && let Some(heading) = thought_heading(stream.source())
            && let Some(turn) = &mut self.turn
            && turn.label != heading
        {
            turn.label = heading;
            turn.label_since = Instant::now();
        }
        // Fullscreen keeps the whole message live, reflowing with the screen, until it ends;
        // thoughts stay live in both modes and end as a preview.
        if let Some(view) = &mut self.transcript {
            view.note_activity();
            return;
        }
        if kind == StreamKind::Thought {
            return;
        }
        let lines = stream.take_complete();
        self.commit_stream_lines(first, lines);
    }

    fn end_stream(&mut self) {
        let Some(stream) = self.stream.take() else {
            return;
        };
        if stream.kind() == StreamKind::Agent && !stream.source().trim().is_empty() {
            self.last_reply = Some(stream.source().to_owned());
        }
        if self.transcript.is_some() || stream.kind() == StreamKind::Thought {
            let kind = stream.kind();
            let source = stream.into_source();
            if !source.trim().is_empty() {
                self.push_cell(TranscriptCell::message(kind, source));
            }
            return;
        }
        let first = !stream.has_committed();
        let (kind, source) = (stream.kind(), stream.source().to_owned());
        let lines = stream.finish();
        self.commit_stream_lines(first, lines);
        // Scrollback got the lines as they streamed; the pager keeps the message whole.
        if let Some(pager) = &mut self.pager
            && !source.trim().is_empty()
        {
            pager.push(TranscriptCell::message(kind, source));
        }
    }

    fn commit_stream_lines(&mut self, first: bool, lines: Vec<Line<'static>>) {
        if lines.is_empty() {
            return;
        }
        if first {
            self.commit_finished_tool_calls();
            self.flush_exploring();
            self.push_lines(lines);
        } else {
            self.pending_history.extend(lines);
        }
    }

    fn commit_finished_tool_calls(&mut self) {
        let (finished, running): (Vec<_>, Vec<_>) = std::mem::take(&mut self.tool_calls)
            .into_iter()
            .partition(ToolCallCell::is_finished);
        self.tool_calls = running;
        for cell in finished {
            self.commit_tool_call(cell);
        }
    }

    fn commit_tool_call(&mut self, cell: ToolCallCell) {
        self.committed_tool_calls.insert(cell.id.clone());
        if cell.is_exploration() {
            self.exploring.push(cell);
            return;
        }
        let terminals = self.terminals_of(std::slice::from_ref(&cell));
        self.push_cell(TranscriptCell::tool_call(cell, self.cwd.clone(), terminals));
    }

    /// Copies of the terminals `calls` embed, as they stand.
    fn terminals_of(&self, calls: &[ToolCallCell]) -> TerminalTranscripts {
        calls
            .iter()
            .flat_map(ToolCallCell::terminal_ids)
            .filter_map(|id| {
                let transcript = self.terminals.get(&id)?.clone();
                Some((id, transcript))
            })
            .collect()
    }

    /// End the exploring group: it becomes one `Explored` entry.
    fn flush_exploring(&mut self) {
        if self.exploring.is_empty() {
            return;
        }
        let group = std::mem::take(&mut self.exploring);
        let terminals = self.terminals_of(group.calls());
        self.push_cell_after_exploring(TranscriptCell::explored(
            group,
            self.cwd.clone(),
            terminals,
        ));
    }

    /// Commit everything still live, as it stands, when the turn ends.
    fn finish_live_cells(&mut self) {
        self.flush_messages();
        self.end_stream();
        for cell in std::mem::take(&mut self.tool_calls) {
            self.commit_tool_call(cell);
        }
        self.flush_exploring();
        for compaction in std::mem::take(&mut self.compactions) {
            self.commit_compaction(compaction);
        }
    }

    /// Commit `cell` after anything finished that came before it.
    fn push_cell(&mut self, cell: TranscriptCell) {
        self.flush_messages();
        self.commit_finished_tool_calls();
        self.flush_exploring();
        self.push_cell_after_exploring(cell);
    }

    fn push_cell_after_exploring(&mut self, cell: TranscriptCell) {
        match &mut self.transcript {
            Some(view) => {
                view.push(cell);
                self.has_history = true;
            }
            None => {
                let lines = plain_lines(cell.lines(self.content_width(), false).iter().cloned());
                self.push_lines(lines);
                if let Some(pager) = &mut self.pager {
                    pager.push(cell);
                }
            }
        }
    }

    /// Queue a cell's lines for scrollback, after a blank separator.
    fn push_lines(&mut self, lines: Vec<Line<'static>>) {
        if self.has_history {
            self.pending_history.push(Line::default());
        }
        self.pending_history.extend(lines);
        self.has_history = true;
    }

    fn push_error(&mut self, message: &str) {
        self.push_cell(TranscriptCell::error(message));
    }

    /// Output changed while the reader may be scrolled away from it.
    fn note_activity(&mut self) {
        if let Some(view) = &mut self.transcript {
            view.note_activity();
        }
    }

    fn content_width(&self) -> usize {
        usize::from(self.width.max(10))
    }

    fn current_mode_name(&self) -> Option<&str> {
        let modes = self.modes.as_ref()?;
        modes
            .available_modes
            .iter()
            .find(|mode| mode.id == modes.current_mode_id)
            .map(|mode| mode.name.as_str())
    }

    /// Live lines above the composer: running tool calls and the streaming message's tail.
    fn live_lines(&self, width: usize) -> Vec<DisplayLine> {
        let detail = self
            .transcript
            .as_ref()
            .is_some_and(TranscriptView::is_detailed);
        let cx = RenderContext {
            cwd: &self.cwd,
            terminals: &self.terminals,
            detail,
            now: Some(Instant::now()),
        };
        let mut lines = Vec::new();
        // Reads and searches, finished and running, show as the one group they'll join.
        let (exploring, others): (Vec<&ToolCallCell>, Vec<&ToolCallCell>) = self
            .tool_calls
            .iter()
            .partition(|cell| cell.is_exploration());
        if !self.exploring.is_empty() || !exploring.is_empty() {
            let mut group = self.exploring.clone();
            for cell in exploring {
                group.push(cell.clone());
            }
            lines.push(DisplayLine::default());
            // Outside a turn (a replay the agent sent late) nothing more is coming.
            lines.extend(group.lines(width, &cx, self.turn.is_some()));
        }
        for cell in others {
            lines.push(DisplayLine::default());
            lines.extend(cell.lines(width, &cx));
        }
        for entry in &self.messages {
            lines.push(DisplayLine::default());
            lines.extend(self.message_shape(entry).lines(width));
        }
        if let Some(stream) = &self.stream {
            if self.transcript.is_some() || stream.kind() == StreamKind::Thought {
                let message = if detail {
                    stream.render_all(width)
                } else {
                    render_compact(stream.kind(), stream.source(), width)
                };
                if !message.is_empty() {
                    lines.push(DisplayLine::default());
                    lines.extend(message);
                }
            } else {
                let tail = stream.tail();
                if !tail.is_empty() {
                    if !stream.has_committed() || !self.tool_calls.is_empty() {
                        lines.push(DisplayLine::default());
                    }
                    lines.extend(tail.into_iter().map(DisplayLine::plain));
                }
            }
        }
        lines
    }

    fn status_lines(&self, now: Instant) -> Vec<Line<'static>> {
        let mut lines = Vec::new();
        // A running compaction takes the status line, on its own clock, as in Codex.
        let compacting = self
            .compactions
            .iter()
            .filter(|compaction| compaction.is_running())
            .find_map(Compaction::started);
        if let Some(started) = compacting
            && !self.turn.as_ref().is_some_and(|turn| turn.cancelling)
        {
            let status = Status {
                label: compaction::RUNNING_LABEL,
                label_since: started,
                started,
                hint: if self.turn.is_some() {
                    "esc to interrupt"
                } else {
                    "agent working"
                },
            };
            lines.push(status_line(&status, now));
            lines.push(Line::from(Span::styled(
                format!("  └ {}", compaction::RUNNING_DETAIL),
                dim(),
            )));
        } else if let Some(turn) = &self.turn {
            let (label, since, hint) = if turn.cancelling {
                ("Cancelling", turn.started, "waiting for the agent")
            } else {
                (turn.label.as_str(), turn.label_since, "esc to interrupt")
            };
            let status = Status {
                label,
                label_since: since,
                started: turn.started,
                hint,
            };
            lines.push(status_line(&status, now));
        }
        for text in &self.queued {
            let first_line = text.lines().next().unwrap_or_default();
            lines.push(Line::from(Span::styled(format!(" ↳ {first_line}"), dim())));
        }
        // Subagents can work on after the turn that started them.
        let running = self.running_subagents();
        if running > 0 {
            let noun = if running == 1 {
                "subagent"
            } else {
                "subagents"
            };
            lines.push(Line::from(vec![
                Span::styled(format!("  {running} {noun} running · "), dim()),
                Span::raw(format!("/{}", subagents::COMMAND)),
                Span::styled(" or ⌥← ⌥→ to watch", dim()),
            ]));
        }
        lines
    }

    fn footer(&self, width: u16, now: Instant) -> Line<'static> {
        let mode = if self.disconnected {
            FooterMode::Disconnected
        } else if self.quit_armed_until.is_some_and(|until| now < until) {
            FooterMode::QuitReminder
        } else if self.has_overlay() {
            FooterMode::Overlay
        } else if self.shortcuts_open {
            FooterMode::ShortcutsOpen
        } else if self.composer.is_shell() {
            FooterMode::Shell
        } else {
            FooterMode::Contextual {
                composer_empty: self.composer.is_empty(),
                working: self.turn.is_some(),
            }
        };
        let values = self.status_values();
        let props = FooterProps {
            mode,
            items: &self.status_items,
            values: &values,
            vim: self.composer.is_vim() && !self.has_overlay(),
        };
        footer::footer_line(&props, usize::from(width))
    }

    fn status_values(&self) -> StatusValues {
        let current =
            |category| settings::current(&self.config_options, self.modes.as_ref(), &category);
        StatusValues {
            agent: self.agent_name.clone(),
            model: current(SessionConfigOptionCategory::Model),
            // The level, then model settings that are on, as "high fast".
            reasoning: {
                let parts: Vec<String> = current(SessionConfigOptionCategory::ThoughtLevel)
                    .into_iter()
                    .chain(conventions::model_toggles_on(&self.config_options))
                    .collect();
                (!parts.is_empty()).then(|| parts.join(" "))
            },
            mode: current(SessionConfigOptionCategory::Mode),
            directory: home_relative(&self.cwd),
            session: self.title.clone(),
            context_used: self
                .context
                .filter(|(_, size)| *size > 0)
                .map(|(used, size)| (used.saturating_mul(100) / size).min(100)),
            cost: self.cost.clone(),
            settings: settings::any(&self.config_options, self.modes.as_ref()),
        }
    }

    /// Whether a prompt or picker has replaced the composer.
    fn has_overlay(&self) -> bool {
        !self.permissions.is_empty()
            || !self.elicitations.is_empty()
            || self.session_picker.is_some()
            || self.settings.is_some()
            || self.subagent_picker.is_some()
    }

    fn popup_matches(&self) -> Vec<&AvailableCommand> {
        // A shell command isn't a slash command, and Normal mode keys aren't typing.
        if self.composer.is_shell() || !self.composer.completes() {
            return Vec::new();
        }
        self.popup.matches(self.composer.text(), &self.commands)
    }

    fn input_height(&self, width: u16) -> u16 {
        if let Some(pending) = self.permissions.front() {
            return pending.view.desired_height(width);
        }
        if let Some(pending) = self.elicitations.front() {
            return pending.view.desired_height(width);
        }
        if let Some(picker) = &self.subagent_picker {
            let rows = picker.lines(&self.picker_entries()).len();
            return u16::try_from(rows).unwrap_or(u16::MAX);
        }
        if let Some(picker) = &self.session_picker {
            return picker.desired_height();
        }
        if let Some(picker) = &self.settings {
            return picker.desired_height(&self.config_options, self.modes.as_ref());
        }
        let shortcuts = if self.shortcuts_open {
            u16::try_from(
                footer::shortcut_lines(usize::from(width), self.vim, self.detachable).len(),
            )
            .unwrap_or(u16::MAX)
        } else {
            0
        };
        shortcuts + self.composer.box_height(width)
    }

    /// Rows under the input: the slash command popup, which replaces the footer as in Codex,
    /// or the footer.
    fn footer_height(&self) -> u16 {
        if self.has_overlay() || self.find_status().is_some_and(|status| status.editing) {
            return 1;
        }
        if let Some(matches) = self.file_matches() {
            return FilePopup::height(matches.as_deref());
        }
        CommandPopup::height(self.popup_matches().len()).max(1)
    }

    /// The hint for the input of the command being typed, as in `/run ` → "shell command".
    fn command_hint(&self) -> Option<&str> {
        let name = self.composer.text().strip_prefix('/')?.strip_suffix(' ')?;
        let command = self.commands.iter().find(|command| command.name == name)?;
        command_popup::input_hint(command)
    }

    /// The turn status and queued messages, spaced from a prompt below them.
    fn status_block(&self, now: Instant) -> Vec<Line<'static>> {
        let mut lines = self.status_lines(now);
        if !lines.is_empty() && (!self.permissions.is_empty() || !self.elicitations.is_empty()) {
            lines.push(Line::default());
        }
        lines
    }

    /// Everything drawn above the composer or permission prompt.
    fn lines_above_input(&self, width: u16, now: Instant) -> Vec<Line<'static>> {
        let mut lines = plain_lines(self.live_lines(usize::from(width)));
        lines.push(Line::default());
        lines.extend(self.status_block(now));
        lines
    }

    /// The row under the fullscreen transcript: a copy confirmation, or how to get back to the
    /// newest output when scrolled away from it.
    fn transcript_note(&self, now: Instant) -> Line<'static> {
        if let Some((note, until)) = &self.copied
            && now < *until
        {
            return Line::from(Span::styled(format!("  {note}"), dim()));
        }
        if let Some(status) = self.viewed().and_then(TranscriptView::find_status) {
            let mut spans = vec![Span::raw("  ")];
            spans.extend(footer::find_hints(&status, FindKeys::Screen));
            return Line::from(spans);
        }
        if let Some(watched) = self.watched() {
            return watching_note(watched, now);
        }
        match self.transcript.as_ref().map(TranscriptView::reading) {
            Some(Reading::Earlier) => {
                Line::from(Span::styled("  ↑ scrolled back · esc for latest", dim()))
            }
            Some(Reading::EarlierWithNewOutput) => Line::from(Span::styled(
                "  ↓ new output below · esc for latest",
                Style::default().fg(style::accent()),
            )),
            _ if self
                .transcript
                .as_ref()
                .is_some_and(TranscriptView::is_detailed) =>
            {
                Line::from(vec![
                    Span::styled("  Full transcript · ", style::secondary()),
                    Span::raw("⌃t"),
                    Span::styled(" to return", style::secondary()),
                ])
            }
            _ => Line::default(),
        }
    }

    pub fn desired_height(&self, width: u16) -> u16 {
        let above = self.lines_above_input(width, Instant::now()).len();
        let total = above + usize::from(self.input_height(width) + self.footer_height());
        u16::try_from(total).unwrap_or(u16::MAX)
    }

    /// Draw the inline pager over the whole screen: the full transcript with live output
    /// below it, a title row, and its keys.
    pub fn render_pager(&self, area: Rect, buf: &mut Buffer) {
        if let Some(watched) = self.watched()
            && !self.pager_open
        {
            return self.render_watched_overlay(watched, area, buf);
        }
        let Some(pager) = &self.pager else {
            return;
        };
        if area.height < 3 {
            return;
        }
        let title = Line::from(vec![
            Span::styled("─ ", dim()),
            Span::styled("Transcript", Style::default().add_modifier(Modifier::BOLD)),
            Span::styled(" ", dim()),
            Span::styled(
                "─".repeat(usize::from(area.width).saturating_sub(13)),
                dim(),
            ),
        ]);
        buf.set_line(area.x, area.y, &title, area.width);
        let body = Rect::new(area.x, area.y + 1, area.width, area.height - 2);
        let width = usize::from(area.width.max(10));
        pager.render(body, buf, width, &self.live_lines(width));
        let hints = match pager.find_status() {
            Some(status) => {
                let mut spans = vec![Span::raw("  ")];
                if status.editing {
                    // The pager draws no terminal cursor; a block stands in for it.
                    let (line, _) = footer::find_query_line(status.query);
                    spans.extend(line.spans);
                    spans.push(Span::styled(
                        " ",
                        Style::default().add_modifier(Modifier::REVERSED),
                    ));
                    spans.push(Span::raw("  "));
                }
                spans.extend(footer::find_hints(&status, FindKeys::Pager));
                Line::from(spans)
            }
            None => Line::from(vec![
                Span::raw("  ↑↓ pgup pgdn"),
                Span::styled(" scroll · ", style::secondary()),
                Span::raw("/"),
                Span::styled(" find · ", style::secondary()),
                Span::raw("esc"),
                Span::styled(" or ", style::secondary()),
                Span::raw("⌃t"),
                Span::styled(" close", style::secondary()),
            ]),
        };
        buf.set_line(area.x, area.bottom() - 1, &hints, area.width);
    }

    /// Inline mode: a watched subagent's transcript over the whole screen, as the pager is.
    fn render_watched_overlay(&self, watched: &Subagent, area: Rect, buf: &mut Buffer) {
        if area.height < 3 {
            return;
        }
        let label = watched.label();
        let title = Line::from(vec![
            Span::styled("─ ", dim()),
            Span::styled(label.clone(), Style::default().add_modifier(Modifier::BOLD)),
            Span::styled(" ", dim()),
            Span::styled(
                "─".repeat(usize::from(area.width).saturating_sub(label.chars().count() + 3)),
                dim(),
            ),
        ]);
        buf.set_line(area.x, area.y, &title, area.width);
        let body = Rect::new(area.x, area.y + 1, area.width, area.height - 2);
        let width = usize::from(area.width.max(10));
        if let Some(view) = &watched.chat.transcript {
            view.render(body, buf, width, &watched.chat.live_lines(width));
        }
        buf.set_line(
            area.x,
            area.bottom() - 1,
            &watching_note(watched, Instant::now()),
            area.width,
        );
    }

    /// Draw the inline viewport. Returns where the terminal cursor belongs, if anywhere.
    pub fn render(&self, area: Rect, buf: &mut Buffer) -> Option<Position> {
        let now = Instant::now();
        let above = self.lines_above_input(area.width, now);
        self.render_input(area, buf, &above, now)
    }

    /// Draw the whole screen in fullscreen mode: the transcript, with the status, input and
    /// footer pinned below it. Returns where the terminal cursor belongs, if anywhere.
    pub fn render_screen(&self, area: Rect, buf: &mut Buffer) -> Option<Position> {
        let Some(view) = &self.transcript else {
            return self.render(area, buf);
        };
        let now = Instant::now();
        let mut above = vec![self.transcript_note(now)];
        above.extend(self.status_block(now));
        // As in Codex, the input takes at most two thirds of the screen, but at least 8 rows.
        let cap = (area.height.saturating_mul(2) / 3).max(8).min(area.height);
        let wanted =
            above.len() + usize::from(self.input_height(area.width) + self.footer_height());
        let bottom_height = u16::try_from(wanted).unwrap_or(u16::MAX).min(cap);
        let transcript_area = Rect::new(area.x, area.y, area.width, area.height - bottom_height);
        let width = usize::from(area.width.max(10));
        // A watched subagent's transcript takes this session's place, as in Codex.
        let shown = self.shown();
        let view = shown.transcript.as_ref().unwrap_or(view);
        view.render(transcript_area, buf, width, &shown.live_lines(width));
        let bottom = Rect::new(area.x, transcript_area.bottom(), area.width, bottom_height);
        self.render_input(bottom, buf, &above, now)
    }

    /// Draw `above`, then the input and footer, into `area`, dropping the oldest of `above`
    /// when space is short.
    fn render_input(
        &self,
        area: Rect,
        buf: &mut Buffer,
        above: &[Line<'static>],
        now: Instant,
    ) -> Option<Position> {
        let footer_height = self.footer_height().min(area.height);
        let input_height = self
            .input_height(area.width)
            .min(area.height.saturating_sub(footer_height));

        let room = usize::from(area.height.saturating_sub(input_height + footer_height));
        let skip = above.len().saturating_sub(room);
        let mut y = area.y;
        for line in above.iter().skip(skip) {
            buf.set_line(area.x, y, line, area.width);
            y += 1;
        }

        let input_area = Rect::new(area.x, y, area.width, input_height);
        let footer_area = Rect::new(
            area.x,
            (y + input_height).min(area.bottom().saturating_sub(footer_height)),
            area.width,
            footer_height,
        );
        let cursor = if let Some(pending) = self.permissions.front() {
            pending.view.render(input_area, buf);
            None
        } else if let Some(pending) = self.elicitations.front() {
            pending.view.render(input_area, buf)
        } else if let Some(picker) = &self.subagent_picker {
            picker.render(&self.picker_entries(), input_area, buf);
            None
        } else if let Some(picker) = &self.session_picker {
            picker.render(input_area, buf);
            None
        } else if let Some(picker) = &self.settings {
            picker.render(input_area, buf, &self.config_options, self.modes.as_ref());
            None
        } else {
            let mut composer_area = input_area;
            if self.shortcuts_open {
                let lines =
                    footer::shortcut_lines(usize::from(area.width), self.vim, self.detachable);
                let height = u16::try_from(lines.len())
                    .unwrap_or(u16::MAX)
                    .min(input_area.height.saturating_sub(1));
                for (offset, line) in (0..height).zip(&lines) {
                    buf.set_line(area.x, input_area.y + offset, line, area.width);
                }
                composer_area.y += height;
                composer_area.height -= height;
            }
            Some(
                self.composer
                    .render_box(composer_area, buf, self.command_hint()),
            )
        };
        let matches = self.popup_matches();
        if let Some(status) = self.find_status().filter(|status| status.editing) {
            // Find's query is typed where the footer was, as in Codex; the cursor goes there.
            let (line, column) = footer::find_query_line(status.query);
            let line = Line::from([vec![Span::raw("  ")], line.spans].concat());
            buf.set_line(area.x, footer_area.y, &line, area.width);
            let x = u16::try_from(2 + column)
                .unwrap_or(u16::MAX)
                .min(area.width.saturating_sub(1));
            return Some(Position::new(area.x + x, footer_area.y));
        }
        // A Vim search is typed in the footer row, as on Vim's command line.
        if let Some(prompt) = self.composer.vim().and_then(crate::vim::Vim::search_prompt)
            && !self.has_overlay()
        {
            let line = Line::from(vec![Span::raw("  "), Span::raw(prompt.clone())]);
            buf.set_line(area.x, footer_area.y, &line, area.width);
            let x = u16::try_from(2 + unicode_width::UnicodeWidthStr::width(prompt.as_str()))
                .unwrap_or(u16::MAX)
                .min(area.width.saturating_sub(1));
            return Some(Position::new(area.x + x, footer_area.y));
        }
        if let Some(files) = self.file_matches() {
            self.file_popup.render(files.as_deref(), footer_area, buf);
        } else if !self.has_overlay() && !matches.is_empty() {
            self.popup.render(&matches, footer_area, buf);
        } else {
            buf.set_line(
                area.x,
                footer_area.y,
                &self.footer(area.width, now),
                area.width,
            );
        }
        cursor
    }
}

/// The note while watching a subagent: which, what it is doing, and the keys.
fn watching_note(watched: &Subagent, now: Instant) -> Line<'static> {
    let mut spans = vec![
        Span::styled("  Watching ", style::secondary()),
        Span::styled(
            watched.label(),
            Style::default()
                .fg(style::accent())
                .add_modifier(Modifier::BOLD),
        ),
    ];
    let activity = watched.activity(now);
    if !activity.is_empty() {
        spans.push(Span::styled(format!(" · {activity}"), dim()));
    }
    spans.push(Span::styled(" · ", style::secondary()));
    spans.push(Span::raw("⌥← ⌥→"));
    spans.push(Span::styled(" switch · ", style::secondary()));
    spans.push(Span::raw("esc"));
    spans.push(Span::styled(" back", style::secondary()));
    if watched.is_running() && watched.cancel {
        spans.push(Span::styled(" · ", style::secondary()));
        spans.push(Span::raw("⌃c"));
        spans.push(Span::styled(" stop it", style::secondary()));
    }
    Line::from(spans)
}

/// Whether a tool call update says anything a cell could show.
fn has_content(fields: &weave_acp_core::schema::ToolCallUpdateFields) -> bool {
    fields.kind.is_some()
        || fields.status.is_some()
        || fields.title.is_some()
        || fields.name.is_some()
        || fields.content.is_some()
        || fields.locations.is_some()
        || fields.raw_input.is_some()
        || fields.raw_output.is_some()
}

/// The time of day for turn summaries; fixed in tests so snapshots stay stable.
fn clock_label() -> String {
    if cfg!(test) {
        "12:00".to_owned()
    } else {
        chrono::Local::now().format("%H:%M").to_string()
    }
}

fn content_text(content: &ContentBlock) -> String {
    match content {
        ContentBlock::Text(text) => text.text.clone(),
        ContentBlock::Image(_) => "[image]".to_owned(),
        ContentBlock::Audio(_) => "[audio]".to_owned(),
        ContentBlock::ResourceLink(link) => format!("[{}]({})", link.name, link.uri),
        ContentBlock::Resource(_) => "[embedded resource]".to_owned(),
        _ => "[unsupported content]".to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;
    use weave_acp_core::schema::AvailableCommandInput;
    use weave_acp_core::schema::AvailableCommandsUpdate;
    use weave_acp_core::schema::ContentChunk;
    use weave_acp_core::schema::SessionConfigOptionCategory;
    use weave_acp_core::schema::SessionConfigOptionValue;
    use weave_acp_core::schema::SessionConfigSelectOption;

    use crate::vim;
    use crate::vim::Vim;
    use weave_acp_core::schema::SessionInfo;
    use weave_acp_core::schema::SessionNotification;
    use weave_acp_core::schema::Terminal;
    use weave_acp_core::schema::TerminalExitStatus;
    use weave_acp_core::schema::ToolCall;
    use weave_acp_core::schema::ToolCallContent;
    use weave_acp_core::schema::ToolCallStatus;
    use weave_acp_core::schema::ToolCallUpdate;
    use weave_acp_core::schema::ToolCallUpdateFields;
    use weave_acp_core::schema::ToolKind;
    use weave_acp_core::schema::UnstructuredCommandInput;

    use super::*;

    fn chat() -> ChatWidget {
        chat_with(Vec::new())
    }

    /// A widget with session `s1` open and `options` as its settings.
    fn chat_with(options: Vec<SessionConfigOption>) -> ChatWidget {
        let abilities = SessionAbilities {
            list: true,
            delete: true,
        };
        let mut chat = ChatWidget::new("Agent".into(), PathBuf::from("/repo"), abilities, 60);
        chat.session_ready(OpenedSession {
            session_id: "s1".into(),
            modes: None,
            config_options: options,
            reopened: None,
            cwd: None,
        });
        chat
    }

    fn update(update: SessionUpdate) -> AgentEvent {
        AgentEvent::SessionUpdate(SessionNotification::new("s1", update))
    }

    fn text_chunk(text: &str) -> AgentEvent {
        update(SessionUpdate::AgentMessageChunk(ContentChunk::new(
            text.into(),
        )))
    }

    fn turn_ended(stop_reason: StopReason) -> AgentEvent {
        AgentEvent::TurnEnded {
            session_id: "s1".into(),
            result: Ok(PromptResponse::new(stop_reason)),
        }
    }

    fn history(chat: &mut ChatWidget) -> Vec<String> {
        chat.take_history()
            .iter()
            .map(ToString::to_string)
            .collect()
    }

    fn submit(chat: &mut ChatWidget, text: &str) -> Vec<AppCommand> {
        chat.handle_paste(text);
        chat.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
    }

    /// A chat with the Vim composer enabled, on a new blank session.
    fn vim_chat(reopened: Option<Reopened>) -> ChatWidget {
        let abilities = SessionAbilities {
            list: true,
            delete: true,
        };
        let mut chat =
            ChatWidget::new("Agent".into(), PathBuf::from("/repo"), abilities, 60).with_vim(true);
        chat.session_ready(OpenedSession {
            session_id: "s1".into(),
            modes: None,
            config_options: Vec::new(),
            reopened,
            cwd: None,
        });
        chat
    }

    fn type_text(chat: &mut ChatWidget, text: &str) {
        for ch in text.chars() {
            chat.handle_key(key(KeyCode::Char(ch)));
        }
    }

    #[test]
    fn new_blank_threads_open_in_the_vim_composer_and_replies_do_not() {
        let mut chat = vim_chat(None);
        assert!(chat.composer.is_vim());
        // The mode shows in the composer's bottom row, not the footer.
        let mut screen = rows(&chat, 60);
        let footer = screen.pop().unwrap_or_default();
        assert!(footer.starts_with("  Agent"), "{footer}");
        assert!(footer.ends_with("⌃↵ send"), "{footer}");
        assert_eq!(screen.pop().as_deref(), Some("INSERT"), "{screen:?}");
        // Enter is a new line; Ctrl+Enter sends, and the reply starts basic.
        type_text(&mut chat, "write");
        chat.handle_key(key(KeyCode::Enter));
        type_text(&mut chat, "this");
        assert_eq!(
            chat.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::CONTROL)),
            [AppCommand::Prompt("write\nthis".into())]
        );
        assert!(!chat.composer.is_vim());

        // A reopened session continues a conversation.
        let chat = vim_chat(Some(Reopened::Loaded));
        assert!(!chat.composer.is_vim());
    }

    #[test]
    fn esc_in_the_vim_composer_changes_mode_and_never_interrupts() {
        let mut chat = vim_chat(None);
        type_text(&mut chat, "go");
        chat.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::CONTROL));
        assert!(chat.turn.is_some());
        // Back in the Vim composer for a follow-up, Esc leaves Insert mode, then does nothing.
        chat.handle_key(KeyEvent::new(KeyCode::Char('g'), KeyModifiers::CONTROL));
        assert!(chat.composer.is_vim());
        type_text(&mut chat, "more");
        assert!(chat.handle_key(key(KeyCode::Esc)).is_empty());
        assert!(chat.handle_key(key(KeyCode::Esc)).is_empty());
        assert_eq!(chat.composer.vim().map(Vim::mode), Some(vim::Mode::Normal));
        assert!(chat.turn.as_ref().is_some_and(|turn| !turn.cancelling));
        // Ctrl+C still interrupts.
        assert_eq!(
            chat.handle_key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL)),
            [AppCommand::Cancel]
        );
    }

    #[test]
    fn ctrl_g_switches_composers_only_when_vim_is_enabled() {
        let mut chat = chat();
        chat.handle_key(KeyEvent::new(KeyCode::Char('g'), KeyModifiers::CONTROL));
        assert!(!chat.composer.is_vim());

        let mut chat = vim_chat(Some(Reopened::Loaded));
        type_text(&mut chat, "draft");
        chat.handle_key(KeyEvent::new(KeyCode::Char('g'), KeyModifiers::CONTROL));
        assert!(chat.composer.is_vim());
        chat.handle_key(KeyEvent::new(KeyCode::Char('g'), KeyModifiers::CONTROL));
        assert!(!chat.composer.is_vim());
        assert_eq!(chat.composer.text(), "draft");
        // Shift+Enter moves a growing draft into it.
        chat.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::SHIFT));
        assert!(chat.composer.is_vim());
        assert_eq!(chat.composer.text(), "draft\n");
    }

    #[test]
    fn normal_mode_keys_are_not_typing() {
        let mut chat = vim_chat(None);
        // `?` is text in Insert mode, not the shortcuts panel.
        type_text(&mut chat, "?");
        assert!(!chat.shortcuts_open);
        chat.handle_key(key(KeyCode::Esc));
        chat.handle_key(key(KeyCode::Char('d')));
        chat.handle_key(key(KeyCode::Char('d')));
        assert!(chat.composer.is_empty());
        // A search is typed in the footer row.
        type_text(&mut chat, "ione two");
        chat.handle_key(key(KeyCode::Esc));
        type_text(&mut chat, "?on");
        let footer = rows(&chat, 60).pop().unwrap_or_default();
        assert_eq!(footer, "  ?on");
        chat.handle_key(key(KeyCode::Enter));
        let mut screen = rows(&chat, 60);
        let footer = screen.pop().unwrap_or_default();
        assert!(footer.starts_with("  Agent"), "{footer}");
        assert_eq!(screen.pop().as_deref(), Some("NORMAL"), "{screen:?}");
    }

    #[test]
    fn a_turn_streams_text_and_commits_tool_calls_when_they_finish() {
        let mut chat = chat();
        assert_eq!(
            submit(&mut chat, "do it"),
            [AppCommand::Prompt("do it".into())]
        );

        chat.handle_agent_event(text_chunk("Reading the "));
        chat.handle_agent_event(text_chunk("file.\nThen"));
        chat.handle_agent_event(update(SessionUpdate::ToolCall(
            ToolCall::new("t1", "Read a.rs").kind(ToolKind::Read),
        )));
        assert_eq!(
            history(&mut chat),
            ["", "› do it", "", "", "• Reading the file.", "  Then"]
        );

        chat.handle_agent_event(update(SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(
            "t1",
            ToolCallUpdateFields::new().status(ToolCallStatus::Completed),
        ))));
        chat.handle_agent_event(text_chunk("Done."));
        assert_eq!(
            chat.handle_agent_event(turn_ended(StopReason::EndTurn)),
            [AppCommand::Notify("Done.".into())]
        );

        assert_eq!(
            history(&mut chat),
            [
                "",
                "• Explored",
                "  └ Read a.rs",
                "",
                "• Done.",
                "",
                "  Worked for less than a second • 12:00"
            ]
        );
        assert!(!chat.is_animating());
    }

    #[test]
    fn a_turn_started_elsewhere_runs_here_until_it_ends() {
        // Another client of the weave daemon prompts: its message, its turn and the reply
        // show here, and a message typed meanwhile waits for the turn as with one's own.
        let mut chat = chat();
        chat.handle_agent_event(update(SessionUpdate::UserMessageChunk(ContentChunk::new(
            "from the other window".into(),
        ))));
        chat.handle_agent_event(AgentEvent::TurnRunning {
            session_id: "s1".into(),
            elapsed: Duration::from_secs(90),
        });
        assert!(chat.is_animating());
        assert!(submit(&mut chat, "next").is_empty());
        chat.handle_agent_event(text_chunk("Done."));
        assert_eq!(
            chat.handle_agent_event(turn_ended(StopReason::EndTurn)),
            [AppCommand::Prompt("next".into())]
        );
        let history = history(&mut chat);
        assert!(
            history.contains(&"› from the other window".to_owned()),
            "{history:?}"
        );
        assert!(
            history
                .iter()
                .any(|line| line.contains("Worked for 1m 30s")),
            "{history:?}"
        );
    }

    #[test]
    fn attaching_mid_turn_keeps_the_reply_in_one_message() {
        let mut chat = chat();
        chat.begin_session("s2".into(), None);
        let s2 = |update| AgentEvent::SessionUpdate(SessionNotification::new("s2", update));
        chat.handle_agent_event(s2(SessionUpdate::UserMessageChunk(ContentChunk::new(
            "go".into(),
        ))));
        chat.handle_agent_event(s2(SessionUpdate::AgentMessageChunk(ContentChunk::new(
            "Half ".into(),
        ))));
        chat.handle_agent_event(AgentEvent::TurnRunning {
            session_id: "s2".into(),
            elapsed: Duration::ZERO,
        });
        chat.session_ready(OpenedSession {
            session_id: "s2".into(),
            modes: None,
            config_options: Vec::new(),
            reopened: Some(Reopened::Loaded),
            cwd: None,
        });
        chat.handle_agent_event(s2(SessionUpdate::AgentMessageChunk(ContentChunk::new(
            "and the rest.".into(),
        ))));
        chat.handle_agent_event(AgentEvent::TurnEnded {
            session_id: "s2".into(),
            result: Ok(PromptResponse::new(StopReason::EndTurn)),
        });
        let history = history(&mut chat);
        assert!(
            history.contains(&"• Half and the rest.".to_owned()),
            "{history:?}"
        );
    }

    #[test]
    fn ctrl_d_leaves_a_running_turn_only_when_the_daemon_keeps_it() {
        let ctrl_d = KeyEvent::new(KeyCode::Char('d'), KeyModifiers::CONTROL);
        let mut chat = chat();
        submit(&mut chat, "do it");
        assert!(chat.handle_key(ctrl_d).is_empty());
        let mut chat = chat_with(Vec::new()).with_detach(true);
        submit(&mut chat, "do it");
        assert_eq!(chat.handle_key(ctrl_d), [AppCommand::Quit]);
        assert!(chat.turn_running());
    }

    #[test]
    fn a_session_from_another_directory_moves_the_client_there() {
        let mut chat = chat();
        chat.set_cwd(PathBuf::from("/elsewhere/repo"));
        assert_eq!(chat.status_values().directory, "/elsewhere/repo");
        assert_eq!(chat.cwd, PathBuf::from("/elsewhere/repo"));
    }

    #[test]
    fn a_session_the_daemon_ends_takes_no_more_prompts() {
        let mut chat = chat();
        submit(&mut chat, "do it");
        // Another session ending changes nothing here.
        chat.handle_agent_event(AgentEvent::SessionEnded {
            session_id: "other".into(),
            reason: "idle".into(),
        });
        assert!(chat.is_animating());
        chat.handle_agent_event(AgentEvent::SessionEnded {
            session_id: "s1".into(),
            reason: "the agent exited".into(),
        });
        assert!(!chat.is_animating());
        let history = history(&mut chat);
        assert!(
            history
                .iter()
                .any(|line| line.contains("Session ended: the agent exited")),
            "{history:?}"
        );
        assert!(submit(&mut chat, "more").is_empty());
    }

    #[test]
    fn messages_sent_during_a_turn_are_queued_until_it_ends() {
        let mut chat = chat();
        submit(&mut chat, "first");
        assert!(submit(&mut chat, "second").is_empty());

        let commands = chat.handle_agent_event(turn_ended(StopReason::EndTurn));
        assert_eq!(commands, [AppCommand::Prompt("second".into())]);
    }

    #[test]
    fn escape_cancels_and_returns_queued_messages_to_the_composer() {
        let mut chat = chat();
        submit(&mut chat, "first");
        submit(&mut chat, "follow-up");

        let escape = KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE);
        assert_eq!(chat.handle_key(escape), [AppCommand::Cancel]);
        assert_eq!(chat.handle_key(escape), []);
        assert_eq!(chat.composer.text(), "follow-up");

        assert!(
            chat.handle_agent_event(turn_ended(StopReason::Cancelled))
                .is_empty()
        );
        assert_eq!(
            history(&mut chat).last().map(String::as_str),
            Some("• Turn cancelled")
        );
    }

    #[test]
    fn ctrl_c_twice_quits_when_idle() {
        let mut chat = chat();
        let ctrl_c = KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL);
        assert!(chat.handle_key(ctrl_c).is_empty());
        assert_eq!(chat.handle_key(ctrl_c), [AppCommand::Quit]);
    }

    fn rows(chat: &ChatWidget, width: u16) -> Vec<String> {
        let area = Rect::new(0, 0, width, chat.desired_height(width));
        let mut buf = Buffer::empty(area);
        chat.render(area, &mut buf);
        (0..area.height)
            .map(|y| {
                (0..area.width)
                    .map(|x| buf[(x, y)].symbol())
                    .collect::<String>()
                    .trim_end()
                    .to_owned()
            })
            .collect()
    }

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    #[test]
    fn embedded_terminals_stream_live_and_commit_with_their_exit() {
        let mut chat = chat();
        submit(&mut chat, "go");
        chat.take_history();
        chat.handle_agent_event(update(SessionUpdate::ToolCall(
            ToolCall::new("t1", "Run tests")
                .kind(ToolKind::Execute)
                .status(ToolCallStatus::InProgress)
                .content(vec![ToolCallContent::Terminal(Terminal::new("term-1"))]),
        )));
        chat.handle_agent_event(AgentEvent::TerminalOutput {
            terminal_id: "term-1".into(),
            text: "\x1b[32mok\x1b[0m 1\n".into(),
        });
        assert!(rows(&chat, 60).contains(&"  └ ok 1".to_owned()));

        chat.handle_agent_event(AgentEvent::TerminalExited {
            terminal_id: "term-1".into(),
            status: TerminalExitStatus::new().exit_code(1),
        });
        chat.handle_agent_event(update(SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(
            "t1",
            ToolCallUpdateFields::new().status(ToolCallStatus::Failed),
        ))));
        // Finished, it stays live until the next entry, then commits with its output.
        assert!(history(&mut chat).is_empty());
        chat.handle_agent_event(text_chunk("It failed.\n"));
        assert_eq!(
            history(&mut chat),
            ["", "• Run tests", "  └ ok 1", "", "• It failed."]
        );
    }

    #[test]
    fn a_slash_command_chosen_with_enter_sends_from_the_vim_composer() {
        let mut chat = vim_chat(None);
        chat.handle_agent_event(update(SessionUpdate::AvailableCommandsUpdate(
            AvailableCommandsUpdate::new(vec![AvailableCommand::new("plan", "Make a plan")]),
        )));
        type_text(&mut chat, "/pl");
        assert_eq!(
            chat.handle_key(key(KeyCode::Enter)),
            [AppCommand::Prompt("/plan".into())]
        );
    }

    #[test]
    fn slash_commands_complete_from_the_agents_list() {
        let mut chat = chat();
        chat.handle_agent_event(update(SessionUpdate::AvailableCommandsUpdate(
            AvailableCommandsUpdate::new(vec![
                AvailableCommand::new("plan", "Make a plan"),
                AvailableCommand::new("run", "Run a command").input(
                    AvailableCommandInput::Unstructured(UnstructuredCommandInput::new(
                        "shell command",
                    )),
                ),
            ]),
        )));
        chat.handle_paste("/r");
        assert!(
            rows(&chat, 60)
                .iter()
                .any(|row| row.starts_with("› /run") && row.ends_with("Run a command"))
        );

        // Tab completes and the command's input hint appears.
        assert!(chat.handle_key(key(KeyCode::Tab)).is_empty());
        assert_eq!(chat.composer.text(), "/run ");
        assert!(rows(&chat, 60).contains(&"› /run shell command".to_owned()));

        // A command without input is sent as soon as it is chosen.
        chat.composer.clear();
        chat.handle_paste("/pl");
        assert_eq!(
            chat.handle_key(key(KeyCode::Enter)),
            [AppCommand::Prompt("/plan".into())]
        );
    }

    #[test]
    fn shift_tab_cycles_the_mode_and_results_are_announced() {
        let options = vec![
            SessionConfigOption::select(
                "mode",
                "Mode",
                "ask",
                vec![
                    SessionConfigSelectOption::new("ask", "Ask"),
                    SessionConfigSelectOption::new("code", "Code"),
                ],
            )
            .category(SessionConfigOptionCategory::Mode),
        ];
        let mut chat = chat_with(options);
        let change =
            SettingChange::ConfigOption("mode".into(), SessionConfigOptionValue::value_id("code"));
        assert_eq!(
            chat.handle_key(key(KeyCode::BackTab)),
            [AppCommand::ChangeSetting(change.clone())]
        );

        let updated = vec![
            SessionConfigOption::select(
                "mode",
                "Mode",
                "code",
                vec![
                    SessionConfigSelectOption::new("ask", "Ask"),
                    SessionConfigSelectOption::new("code", "Code"),
                ],
            )
            .category(SessionConfigOptionCategory::Mode),
        ];
        chat.setting_changed(change, Ok(Some(updated)));
        // The transcript announces it; the footer stays as it was.
        assert_eq!(history(&mut chat), ["• Mode set to Code"]);
        let footer = rows(&chat, 80).pop().unwrap_or_default();
        assert!(
            footer.starts_with("  Agent  ") && footer.ends_with("  ⌃o Settings"),
            "{footer}"
        );
    }

    #[test]
    fn ctrl_o_opens_settings_that_stay_open_as_choices_apply() {
        let options = vec![SessionConfigOption::boolean("verbose", "Verbose", false)];
        let mut chat = chat_with(options);
        assert!(
            chat.handle_key(KeyEvent::new(KeyCode::Char('o'), KeyModifiers::CONTROL))
                .is_empty()
        );
        assert!(rows(&chat, 60).iter().any(|row| row == "› Verbose  off"));
        let change =
            SettingChange::ConfigOption("verbose".into(), SessionConfigOptionValue::boolean(true));
        assert_eq!(
            chat.handle_key(key(KeyCode::Enter)),
            [AppCommand::ChangeSetting(change.clone())]
        );
        // Still open, and showing the change once the agent confirms it.
        let confirmed = vec![SessionConfigOption::boolean("verbose", "Verbose", true)];
        chat.setting_changed(change, Ok(Some(confirmed)));
        assert!(rows(&chat, 60).iter().any(|row| row == "› Verbose  on"));
        assert!(chat.handle_key(key(KeyCode::Esc)).is_empty());
        assert!(chat.settings.is_none());
    }

    #[test]
    fn the_footer_carries_the_status_line_and_context() {
        let options = vec![SessionConfigOption::boolean("verbose", "Verbose", false)];
        let mut chat = chat_with(options);
        chat.context = Some((25, 100));
        let footer = chat.footer(60, Instant::now()).to_string();
        assert!(footer.starts_with("  Agent · 25%  "), "{footer}");
        assert!(footer.trim_end().ends_with("  ⌃o Settings"), "{footer}");

        chat.status_items.clear();
        let footer = chat.footer(60, Instant::now()).to_string();
        assert!(
            footer.starts_with("  ? for shortcuts  ")
                && footer.trim_end().ends_with("  ⌃o Settings"),
            "{footer}"
        );
    }

    #[test]
    fn fast_mode_joins_the_reasoning_level() {
        let level = |current: &'static str| {
            SessionConfigOption::select(
                "effort",
                "Reasoning effort",
                current,
                vec![
                    SessionConfigSelectOption::new("low", "Low"),
                    SessionConfigSelectOption::new("high", "High"),
                ],
            )
            .category(SessionConfigOptionCategory::ThoughtLevel)
        };
        let fast = |on: bool| {
            SessionConfigOption::boolean("fast-mode", "Fast mode", on)
                .category(SessionConfigOptionCategory::ModelConfig)
        };
        let reasoning = |options| chat_with(options).status_values().reasoning;
        assert_eq!(
            reasoning(vec![level("high"), fast(true)]).as_deref(),
            Some("High fast")
        );
        assert_eq!(
            reasoning(vec![level("high"), fast(false)]).as_deref(),
            Some("High")
        );
        assert_eq!(reasoning(vec![fast(true)]).as_deref(), Some("fast"));
        assert_eq!(reasoning(Vec::new()), None);
    }

    #[test]
    fn question_mark_opens_the_shortcuts_and_any_key_closes_them() {
        let mut chat = chat();
        assert!(chat.handle_key(key(KeyCode::Char('?'))).is_empty());
        let shown = rows(&chat, 80);
        assert!(shown.iter().any(|row| row.trim() == "Keyboard shortcuts"));
        assert_eq!(shown.last().map(|row| row.trim()), Some("? / esc close"));
        chat.handle_key(key(KeyCode::Esc));
        assert!(
            !rows(&chat, 80)
                .iter()
                .any(|row| row.trim() == "Keyboard shortcuts")
        );
        assert!(chat.composer.is_empty());

        // With a draft, `?` is just text.
        chat.handle_paste("why");
        chat.handle_key(key(KeyCode::Char('?')));
        assert_eq!(chat.composer.text(), "why?");
    }

    #[test]
    fn thought_headings_name_the_work_in_progress() {
        let mut chat = chat();
        submit(&mut chat, "go");
        chat.handle_agent_event(update(SessionUpdate::AgentThoughtChunk(ContentChunk::new(
            "**Inspecting the parser**\n\nLooking at tokens.".into(),
        ))));
        assert!(
            rows(&chat, 60)
                .iter()
                .any(|row| row.starts_with("• Inspecting the parser (0s • esc to interrupt)"))
        );
    }

    #[test]
    fn events_from_other_sessions_are_ignored() {
        let mut chat = chat();
        chat.handle_agent_event(AgentEvent::SessionUpdate(SessionNotification::new(
            "elsewhere",
            SessionUpdate::AgentMessageChunk(ContentChunk::new("stray\n".into())),
        )));
        assert!(history(&mut chat).is_empty());
    }

    #[test]
    fn loading_a_session_replays_its_history_under_a_heading() {
        let mut chat = chat();
        chat.take_history();
        chat.begin_session("s2".into(), Some("Fix the build"));
        for update in [
            SessionUpdate::UserMessageChunk(ContentChunk::new("fix it".into())),
            SessionUpdate::AgentMessageChunk(ContentChunk::new("Done.".into())),
        ] {
            chat.handle_agent_event(AgentEvent::SessionUpdate(SessionNotification::new(
                "s2", update,
            )));
        }
        chat.session_ready(OpenedSession {
            session_id: "s2".into(),
            modes: None,
            config_options: Vec::new(),
            reopened: Some(Reopened::Loaded),
            cwd: None,
        });
        assert_eq!(
            history(&mut chat),
            [
                "• Session: Fix the build",
                "",
                "",
                "› fix it",
                "",
                "",
                "• Done."
            ]
        );
        assert_eq!(
            submit(&mut chat, "next"),
            [AppCommand::Prompt("next".into())]
        );
    }

    #[test]
    fn replays_show_tool_calls_whose_ids_were_seen_in_another_session() {
        let mut chat = chat();
        let finished = || {
            SessionUpdate::ToolCall(
                ToolCall::new("call-1", "Run it")
                    .kind(ToolKind::Execute)
                    .status(ToolCallStatus::Completed),
            )
        };
        chat.handle_agent_event(update(finished()));
        chat.begin_session("s2".into(), None);
        assert_eq!(history(&mut chat), ["• Run it"]);

        chat.handle_agent_event(AgentEvent::SessionUpdate(SessionNotification::new(
            "s2",
            finished(),
        )));
        chat.session_ready(OpenedSession {
            session_id: "s2".into(),
            modes: None,
            config_options: Vec::new(),
            reopened: Some(Reopened::Loaded),
            cwd: None,
        });
        assert_eq!(history(&mut chat), ["", "• Run it"]);
    }

    #[test]
    fn replayed_messages_with_different_ids_stay_separate() {
        let mut chat = chat();
        for (id, text) in [("u1", "first"), ("u2", "second")] {
            let chunk = ContentChunk::new(text.into())
                .message_id(weave_acp_core::schema::MessageId::new(id));
            chat.handle_agent_event(update(SessionUpdate::UserMessageChunk(chunk)));
        }
        chat.handle_agent_event(text_chunk("reply"));
        // The reply is still streaming, so it stays live; the user messages were committed apart.
        assert_eq!(
            history(&mut chat),
            ["", "› first", "", "", "", "› second", ""]
        );
    }

    #[test]
    fn prompts_wait_while_a_session_loads() {
        let mut chat = chat();
        chat.begin_session("s2".into(), None);
        assert!(submit(&mut chat, "too soon").is_empty());
        assert_eq!(chat.queued.len(), 1);
    }

    #[test]
    fn ctrl_r_opens_the_picker_and_choosing_opens_that_session() {
        let mut chat = chat();
        let ctrl_r = KeyEvent::new(KeyCode::Char('r'), KeyModifiers::CONTROL);
        assert_eq!(
            chat.handle_key(ctrl_r),
            [AppCommand::ListSessions {
                all_directories: false,
                cursor: None
            }]
        );
        chat.sessions_listed(
            Ok(ListSessionsResponse::new(vec![
                SessionInfo::new("s9", "/repo").title("Earlier work".to_owned()),
            ])),
            false,
        );
        assert!(
            rows(&chat, 60)
                .iter()
                .any(|row| row.starts_with("› Earlier work"))
        );
        assert_eq!(
            chat.handle_key(key(KeyCode::Enter)),
            [AppCommand::OpenSession {
                target: SessionTarget::Existing("s9".into()),
                title: Some("Earlier work".into()),
                cwd: Some(PathBuf::from("/repo")),
            }]
        );
    }

    #[test]
    fn a_failed_open_returns_to_the_previous_session() {
        let mut chat = chat();
        chat.begin_session("s2".into(), Some("Broken"));
        chat.session_failed(&Error::internal_error(), Some("s1".into()));
        assert_eq!(chat.active_session(), Some(&SessionId::from("s1")));
    }

    #[test]
    fn viewport_shows_running_tool_calls_and_the_composer() {
        let mut chat = chat();
        submit(&mut chat, "go");
        chat.take_history();
        chat.handle_agent_event(update(SessionUpdate::ToolCall(
            ToolCall::new("t1", "Run tests")
                .kind(ToolKind::Execute)
                .status(ToolCallStatus::InProgress),
        )));

        let area = Rect::new(0, 0, 60, chat.desired_height(60));
        let mut buf = Buffer::empty(area);
        chat.render(area, &mut buf);
        let rows: Vec<String> = (0..area.height)
            .map(|y| {
                (0..area.width)
                    .map(|x| buf[(x, y)].symbol())
                    .collect::<String>()
                    .trim_end()
                    .to_owned()
            })
            .collect();
        // The bullet animates while the call runs.
        assert!(rows[1].ends_with(" Run tests"), "{rows:?}");
        assert!(
            rows[3].starts_with("• Working (0s • esc to interrupt)"),
            "{rows:?}"
        );
        assert_eq!(rows[5], "›");
    }

    fn fullscreen_chat() -> ChatWidget {
        let abilities = SessionAbilities {
            list: true,
            delete: true,
        };
        let mut chat =
            ChatWidget::new("Agent".into(), PathBuf::from("/repo"), abilities, 40).fullscreen();
        chat.session_ready(OpenedSession {
            session_id: "s1".into(),
            modes: None,
            config_options: Vec::new(),
            reopened: None,
            cwd: None,
        });
        chat
    }

    fn screen_rows(chat: &ChatWidget, width: u16, height: u16) -> Vec<String> {
        let area = Rect::new(0, 0, width, height);
        let mut buf = Buffer::empty(area);
        chat.render_screen(area, &mut buf);
        (0..height)
            .map(|y| {
                (0..width)
                    .map(|x| buf[(x, y)].symbol())
                    .collect::<String>()
                    .trim_end()
                    .to_owned()
            })
            .collect()
    }

    fn reply(chat: &mut ChatWidget, id: &str, text: &str) {
        let chunk =
            ContentChunk::new(text.into()).message_id(weave_acp_core::schema::MessageId::new(id));
        chat.handle_agent_event(update(SessionUpdate::AgentMessageChunk(chunk)));
    }

    #[test]
    fn fullscreen_keeps_the_transcript_out_of_scrollback_and_reflows_it() {
        let mut chat = fullscreen_chat();
        submit(&mut chat, "go");
        reply(&mut chat, "m1", &"word ".repeat(30));
        chat.handle_agent_event(turn_ended(StopReason::EndTurn));
        assert!(chat.take_history().is_empty());

        let count = |rows: Vec<String>| rows.iter().filter(|row| row.contains("word")).count();
        assert!(count(screen_rows(&chat, 30, 20)) > count(screen_rows(&chat, 60, 20)));
    }

    #[test]
    fn escape_returns_to_the_newest_output_before_it_interrupts() {
        let mut chat = fullscreen_chat();
        submit(&mut chat, "go");
        for n in 1..=12 {
            reply(&mut chat, &format!("m{n}"), &format!("reply {n}"));
        }
        assert!(screen_rows(&chat, 40, 10).contains(&"• reply 12".to_owned()));

        chat.handle_key(key(KeyCode::PageUp));
        let rows = screen_rows(&chat, 40, 10);
        assert!(!rows.contains(&"• reply 12".to_owned()), "{rows:?}");
        assert!(rows.iter().any(|row| row.contains("esc for latest")));

        assert_eq!(chat.handle_key(key(KeyCode::Esc)), []);
        assert!(screen_rows(&chat, 40, 10).contains(&"• reply 12".to_owned()));
        assert_eq!(chat.handle_key(key(KeyCode::Esc)), [AppCommand::Cancel]);
    }

    #[test]
    fn dragging_over_the_transcript_copies_the_selection() {
        let mut chat = fullscreen_chat();
        reply(&mut chat, "m1", "copy me");
        screen_rows(&chat, 40, 10);
        let mouse = |kind, column| MouseEvent {
            kind,
            column,
            row: 1,
            modifiers: KeyModifiers::NONE,
        };
        let left = crossterm::event::MouseButton::Left;
        use crossterm::event::MouseEventKind;
        chat.handle_mouse(mouse(MouseEventKind::Down(left), 2));
        chat.handle_mouse(mouse(MouseEventKind::Drag(left), 8));
        assert_eq!(
            chat.handle_mouse(mouse(MouseEventKind::Up(left), 8)),
            [AppCommand::Copy("copy me".into())]
        );
        assert!(
            screen_rows(&chat, 40, 10)
                .iter()
                .any(|row| row.trim() == "Copied 7 characters")
        );
    }

    #[test]
    fn fullscreen_shows_one_session_and_a_failed_switch_restores_the_last() {
        let mut chat = fullscreen_chat();
        chat.push_header(None, &[]);
        submit(&mut chat, "first session");
        chat.handle_agent_event(turn_ended(StopReason::EndTurn));

        chat.begin_session("s2".into(), Some("Other"));
        let rows = screen_rows(&chat, 40, 24);
        assert!(
            rows.iter().any(|row| row.starts_with("  >_ weave")),
            "{rows:?}"
        );
        assert!(rows.contains(&"• Session: Other".to_owned()));
        assert!(!rows.contains(&"› first session".to_owned()));

        chat.session_failed(&Error::internal_error(), Some("s1".into()));
        let rows = screen_rows(&chat, 40, 24);
        assert!(rows.contains(&"› first session".to_owned()), "{rows:?}");
        assert!(!rows.contains(&"• Session: Other".to_owned()));
        assert_eq!(chat.resumable_session(), Some(&SessionId::from("s1")));
    }

    /// A finished command that printed ten lines.
    fn ten_line_command(chat: &mut ChatWidget) {
        chat.handle_agent_event(update(SessionUpdate::ToolCall(
            ToolCall::new("t1", "seq 1 10")
                .kind(ToolKind::Execute)
                .status(ToolCallStatus::InProgress)
                .raw_input(serde_json::json!({"command": "seq 1 10"}))
                .content(vec![ToolCallContent::Terminal(Terminal::new("term"))]),
        )));
        chat.handle_agent_event(AgentEvent::TerminalOutput {
            terminal_id: "term".into(),
            text: "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n".into(),
        });
        chat.handle_agent_event(update(SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(
            "t1",
            ToolCallUpdateFields::new().status(ToolCallStatus::Completed),
        ))));
        chat.handle_agent_event(turn_ended(StopReason::EndTurn));
    }

    #[test]
    fn ctrl_t_shows_the_full_transcript_and_back() {
        let mut chat = fullscreen_chat();
        submit(&mut chat, "count");
        ten_line_command(&mut chat);
        let compact = screen_rows(&chat, 60, 30);
        assert!(
            compact
                .iter()
                .any(|row| row.trim() == "+7 lines (⌃t to view transcript)")
        );

        let ctrl_t = KeyEvent::new(KeyCode::Char('t'), KeyModifiers::CONTROL);
        assert!(chat.handle_key(ctrl_t).is_empty());
        let full = screen_rows(&chat, 60, 30);
        assert!(full.iter().any(|row| row.trim() == "10"), "{full:?}");
        assert!(
            full.iter()
                .any(|row| row.trim() == "Full transcript · ⌃t to return")
        );

        chat.handle_key(ctrl_t);
        assert_eq!(screen_rows(&chat, 60, 30), compact);
    }

    #[test]
    fn ctrl_t_inline_opens_a_pager_that_esc_closes() {
        let mut chat = chat();
        submit(&mut chat, "count");
        chat.handle_agent_event(text_chunk("Counted."));
        ten_line_command(&mut chat);
        chat.handle_key(KeyEvent::new(KeyCode::Char('t'), KeyModifiers::CONTROL));
        assert!(chat.pager_open());

        let area = Rect::new(0, 0, 60, 30);
        let mut buf = Buffer::empty(area);
        chat.render_pager(area, &mut buf);
        let rows: Vec<String> = (0..area.height)
            .map(|y| {
                (0..area.width)
                    .map(|x| buf[(x, y)].symbol())
                    .collect::<String>()
                    .trim_end()
                    .to_owned()
            })
            .collect();
        assert!(rows[0].starts_with("─ Transcript ─"));
        assert!(rows.iter().any(|row| row.trim() == "10"), "{rows:?}");
        assert!(
            rows.iter().any(|row| row.starts_with("• Counted.")),
            "{rows:?}"
        );

        // Keys scroll the pager and don't reach the composer; Esc closes it.
        chat.handle_key(key(KeyCode::Char('x')));
        assert!(chat.composer.is_empty());
        chat.handle_key(key(KeyCode::Esc));
        assert!(!chat.pager_open());
    }

    #[test]
    fn a_compaction_shows_in_the_status_then_in_the_transcript() {
        use weave_acp_core::schema::CompactionStatus;
        use weave_acp_core::schema::CompactionSummaryChunk;

        let mut chat = fullscreen_chat();
        submit(&mut chat, "go");
        reply(&mut chat, "m1", "Before.");
        chat.handle_agent_event(update(SessionUpdate::CompactionUpdate(
            CompactionUpdate::new("c1", CompactionStatus::InProgress),
        )));
        chat.handle_agent_event(update(SessionUpdate::CompactionSummaryChunk(
            CompactionSummaryChunk::new("c1", "Kept: the parser work.".into()),
        )));
        // A chunk for a compaction never started is dropped.
        chat.handle_agent_event(update(SessionUpdate::CompactionSummaryChunk(
            CompactionSummaryChunk::new("c9", "stray".into()),
        )));
        let rows = screen_rows(&chat, 60, 14);
        assert!(
            rows.iter()
                .any(|row| row.starts_with("• Compacting context (0s • esc to interrupt)")),
            "{rows:?}"
        );
        assert!(
            rows.contains(&"  └ Making room to continue.".to_owned()),
            "{rows:?}"
        );

        chat.handle_agent_event(update(SessionUpdate::CompactionUpdate(
            CompactionUpdate::new("c1", CompactionStatus::Completed),
        )));
        // Updates to a committed compaction are ignored.
        chat.handle_agent_event(update(SessionUpdate::CompactionUpdate(
            CompactionUpdate::new("c1", CompactionStatus::Failed),
        )));
        reply(&mut chat, "m2", "After.");
        chat.handle_agent_event(turn_ended(StopReason::EndTurn));
        let rows = screen_rows(&chat, 60, 14);
        let at = |text: &str| rows.iter().position(|row| row.starts_with(text));
        assert!(at("• Before.") < at("• Context compacted · 0s"), "{rows:?}");
        assert!(at("• Context compacted · 0s") < at("• After."), "{rows:?}");
        assert!(
            rows.contains(&"  └ Kept a summary: 1 line (⌃t to view transcript)".to_owned()),
            "{rows:?}"
        );
        assert!(!rows.iter().any(|row| row.contains("stray")), "{rows:?}");
        assert!(!rows.iter().any(|row| row.contains("failed")), "{rows:?}");

        chat.handle_key(KeyEvent::new(KeyCode::Char('t'), KeyModifiers::CONTROL));
        let rows = screen_rows(&chat, 60, 14);
        assert!(
            rows.contains(&"  Kept: the parser work.".to_owned()),
            "{rows:?}"
        );
    }

    #[test]
    fn an_update_for_an_unknown_call_with_nothing_to_show_starts_nothing() {
        let mut chat = chat();
        submit(&mut chat, "go");
        chat.handle_agent_event(update(SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(
            "agent-call",
            ToolCallUpdateFields::new(),
        ))));
        assert!(chat.tool_calls.is_empty());
        chat.handle_agent_event(update(SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(
            "late-call",
            ToolCallUpdateFields::new().title("Read a.rs"),
        ))));
        assert_eq!(chat.tool_calls.len(), 1);
    }

    #[test]
    fn subagents_show_as_codex_rows_and_can_be_watched_and_stopped() {
        use weave_acp_core::schema::IdleStateUpdate;
        use weave_acp_core::schema::RunningStateUpdate;
        use weave_acp_core::schema::SessionCancelCapabilities;
        use weave_acp_core::schema::SubagentSessionCapabilities;

        let mut chat = fullscreen_chat();
        submit(&mut chat, "go");
        let robie = SessionId::new("s1:robie");
        chat.handle_agent_event(update(SessionUpdate::SubagentUpdate(
            SubagentUpdate::new(robie.clone())
                .title("Robie".to_owned())
                .description("Counts the files".to_owned())
                .capabilities(
                    SubagentSessionCapabilities::new().cancel(SessionCancelCapabilities::new()),
                )
                .state(StateUpdate::Running(RunningStateUpdate::new())),
        )));
        chat.handle_agent_event(update(SessionUpdate::SessionMessage(
            SessionMessage::new("m1")
                .sender_session_id(SessionId::new("s1"))
                .recipient_session_id(robie.clone())
                .content(MaybeUndefined::Value(vec!["Count them".into()])),
        )));
        // The child's own update goes to its transcript, not this one.
        chat.handle_agent_event(AgentEvent::SessionUpdate(SessionNotification::new(
            robie.clone(),
            SessionUpdate::AgentMessageChunk(ContentChunk::new("There are 12 files.".into())),
        )));
        let rows = screen_rows(&chat, 60, 20);
        for row in [
            "• Spawned Robie",
            "  └ Counts the files",
            "• Sent input to Robie",
            "  └ Count them",
        ] {
            assert!(rows.contains(&row.to_owned()), "{row:?} in {rows:?}");
        }
        assert!(!rows.iter().any(|row| row.contains("12 files")), "{rows:?}");
        assert!(
            rows.iter().any(|row| row.contains("1 subagent running")),
            "{rows:?}"
        );

        // Alt+Right watches it, as in Codex; Ctrl+C stops it rather than this turn.
        chat.handle_key(KeyEvent::new(KeyCode::Right, KeyModifiers::ALT));
        let rows = screen_rows(&chat, 60, 20);
        assert!(
            rows.contains(&"• There are 12 files.".to_owned()),
            "{rows:?}"
        );
        assert!(
            rows.iter()
                .any(|row| row.starts_with("  Watching Robie · running")),
            "{rows:?}"
        );
        assert_eq!(
            chat.handle_key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL)),
            [AppCommand::CancelSubagent(robie.clone())]
        );
        // Esc goes back to this session without touching its turn.
        assert!(chat.handle_key(key(KeyCode::Esc)).is_empty());
        assert!(chat.turn.as_ref().is_some_and(|turn| !turn.cancelling));

        chat.handle_agent_event(update(SessionUpdate::SubagentUpdate(
            SubagentUpdate::new(robie).state(StateUpdate::Idle(
                IdleStateUpdate::new().stop_reason(StopReason::EndTurn),
            )),
        )));
        let rows = screen_rows(&chat, 60, 20);
        assert!(rows.contains(&"• Completed Robie".to_owned()), "{rows:?}");
        assert!(
            rows.contains(&"  └ There are 12 files.".to_owned()),
            "{rows:?}"
        );

        // `/subagents` opens the picker here rather than going to the agent.
        chat.handle_paste("/subagents");
        assert!(chat.handle_key(key(KeyCode::Enter)).is_empty());
        let rows = screen_rows(&chat, 60, 20);
        assert!(rows.iter().any(|row| row.trim() == "Subagents"), "{rows:?}");
        assert!(
            rows.iter()
                .any(|row| row.contains("2. • Robie  idle  Counts the files")),
            "{rows:?}"
        );
        chat.handle_key(key(KeyCode::Down));
        chat.handle_key(key(KeyCode::Enter));
        assert!(
            screen_rows(&chat, 60, 20)
                .iter()
                .any(|row| row.starts_with("  Watching Robie · idle")),
        );
    }

    #[test]
    fn f3_finds_text_in_the_fullscreen_transcript() {
        let mut chat = fullscreen_chat();
        submit(&mut chat, "go");
        for n in 1..=12 {
            reply(&mut chat, &format!("m{n}"), &format!("reply {n}"));
        }
        chat.handle_agent_event(turn_ended(StopReason::EndTurn));
        screen_rows(&chat, 40, 12);
        chat.handle_key(key(KeyCode::F(3)));
        for ch in "reply 3".chars() {
            chat.handle_key(key(KeyCode::Char(ch)));
        }
        // The query goes to Find, not the composer, and is typed where the footer was.
        assert!(chat.composer.is_empty());
        let rows = screen_rows(&chat, 40, 12);
        assert!(rows.contains(&"• reply 3".to_owned()), "{rows:?}");
        assert!(!rows.contains(&"• reply 12".to_owned()), "{rows:?}");
        assert!(rows.iter().any(|row| row == "  Find: reply 3"), "{rows:?}");
        assert!(
            rows.iter()
                .any(|row| row.starts_with("  1 of 1 · enter accept")),
            "{rows:?}"
        );

        // Accepted, the composer has the keys again; Esc returns to the newest output.
        chat.handle_key(key(KeyCode::Enter));
        chat.handle_key(key(KeyCode::Char('x')));
        assert_eq!(chat.composer.text(), "x");
        let rows = screen_rows(&chat, 40, 12);
        assert!(
            rows.iter().any(|row| row.contains("⌃p older · ⌃n newer")),
            "{rows:?}"
        );
        assert_eq!(chat.handle_key(key(KeyCode::Esc)), []);
        assert!(screen_rows(&chat, 40, 12).contains(&"• reply 12".to_owned()));
    }

    #[test]
    fn f3_inline_finds_in_the_pager() {
        let mut chat = chat();
        submit(&mut chat, "count");
        ten_line_command(&mut chat);
        chat.handle_agent_event(text_chunk("Counted."));
        chat.handle_key(key(KeyCode::F(3)));
        assert!(chat.pager_open());
        let area = Rect::new(0, 0, 40, 12);
        let mut buf = Buffer::empty(area);
        chat.render_pager(area, &mut buf);
        for ch in "count".chars() {
            chat.handle_key(key(KeyCode::Char(ch)));
        }
        chat.render_pager(area, &mut buf);
        let bottom: String = (0..area.width)
            .map(|x| buf[(x, area.height - 1)].symbol())
            .collect();
        assert!(bottom.starts_with("  Find: count   2 of 2"), "{bottom:?}");

        // Accepted, n and N step through matches as in less; Esc leaves Find, then the pager.
        chat.handle_key(key(KeyCode::Enter));
        chat.handle_key(key(KeyCode::Char('n')));
        assert_eq!(
            chat.find_status().and_then(|status| status.place),
            Some((1, 2))
        );
        chat.handle_key(key(KeyCode::Esc));
        assert!(chat.pager_open());
        assert_eq!(chat.find_status(), None);
        chat.handle_key(key(KeyCode::Esc));
        assert!(!chat.pager_open());
        assert!(chat.composer.is_empty());
    }

    #[test]
    fn output_reported_under_the_calls_own_id_shows_when_replayed() {
        // As codex-acp replays a command: the completed call with terminal content keyed by
        // its own id, then its output and exit through the terminal extension, which the
        // connection turns into terminal events.
        let mut chat = chat();
        chat.handle_agent_event(update(SessionUpdate::ToolCall(
            ToolCall::new("exec-1", "Run tests")
                .kind(ToolKind::Execute)
                .status(ToolCallStatus::Completed)
                .raw_input(serde_json::json!({"command": ["/bin/zsh", "-lc", "cargo test"]}))
                .content(vec![ToolCallContent::Terminal(Terminal::new("exec-1"))]),
        )));
        chat.handle_agent_event(AgentEvent::TerminalOutput {
            terminal_id: "exec-1".into(),
            text: "test result: ok\n".into(),
        });
        chat.handle_agent_event(AgentEvent::TerminalExited {
            terminal_id: "exec-1".into(),
            status: TerminalExitStatus::new().exit_code(0),
        });
        chat.handle_agent_event(update(SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(
            "exec-1",
            ToolCallUpdateFields::new(),
        ))));
        // The next entry commits it, output included.
        chat.handle_agent_event(text_chunk("Tests pass."));
        chat.handle_agent_event(turn_ended(StopReason::EndTurn));
        let history = history(&mut chat);
        assert_eq!(
            history[..4],
            [
                "• Ran cargo test",
                "  └ test result: ok",
                "",
                "• Tests pass."
            ],
            "{history:?}"
        );
    }

    #[test]
    fn a_late_replay_ends_before_the_next_prompt() {
        let mut chat = chat();
        chat.take_history();
        // Replayed after the session opened, with no turn running.
        chat.handle_agent_event(text_chunk("Earlier answer."));
        submit(&mut chat, "next");
        chat.handle_agent_event(text_chunk("New answer."));
        chat.handle_agent_event(turn_ended(StopReason::EndTurn));
        let history = history(&mut chat);
        assert!(
            history.contains(&"• Earlier answer.".to_owned()),
            "{history:?}"
        );
        assert!(history.contains(&"• New answer.".to_owned()), "{history:?}");
    }

    #[test]
    fn finished_turns_and_requests_ask_for_a_notification() {
        let mut chat = chat();
        submit(&mut chat, "go");
        chat.handle_agent_event(text_chunk("All   done,\nboss."));
        assert_eq!(
            chat.handle_agent_event(turn_ended(StopReason::EndTurn)),
            [AppCommand::Notify("All   done,\nboss.".into())]
        );
        // A cancelled turn was the user's doing.
        submit(&mut chat, "again");
        assert!(
            chat.handle_agent_event(turn_ended(StopReason::Cancelled))
                .is_empty()
        );
    }

    #[test]
    fn the_title_shows_activity_session_and_project() {
        let mut chat = chat();
        chat.title = Some("Fix the build".into());
        let now = Instant::now();
        assert_eq!(chat.terminal_title(now), "Fix the build · repo");
        submit(&mut chat, "go");
        let started = chat.turn.as_ref().map(|turn| turn.started).unwrap_or(now);
        assert_eq!(chat.terminal_title(started), "⠋ Fix the build · repo");
        assert_eq!(
            chat.terminal_title(started + Duration::from_millis(250)),
            "⠹ Fix the build · repo"
        );
    }

    #[test]
    fn bang_runs_a_shell_command_that_ctrl_c_stops() {
        let mut chat = chat();
        chat.handle_key(key(KeyCode::Char('!')));
        assert!(chat.composer.is_shell() && chat.composer.is_empty());
        chat.handle_paste("ls");
        assert_eq!(
            chat.handle_key(key(KeyCode::Enter)),
            [AppCommand::RunShell {
                id: "user-shell-1".into(),
                command: "ls".into()
            }]
        );
        assert!(!chat.composer.is_shell());
        let ctrl_c = KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL);
        assert_eq!(
            chat.handle_key(ctrl_c),
            [AppCommand::KillShell("user-shell-1".into())]
        );
        chat.shell_output("user-shell-1", "a.rs\n");
        chat.shell_exited("user-shell-1", TerminalExitStatus::new().exit_code(0));
        chat.handle_agent_event(text_chunk("next\n"));
        assert_eq!(
            history(&mut chat),
            ["• You ran ls", "  └ a.rs", "", "• next"]
        );
    }

    #[test]
    fn pasted_images_become_tokens_the_prompt_refers_to() {
        let mut chat = chat();
        chat.handle_paste("what is");
        chat.attach_image(PathBuf::from("/tmp/a.png"));
        chat.attach_image(PathBuf::from("/tmp/b.png"));
        assert_eq!(chat.composer.text(), "what is [image 1] [image 2] ");
        assert_eq!(
            chat.handle_key(KeyEvent::new(KeyCode::Char('v'), KeyModifiers::CONTROL)),
            [AppCommand::PasteImage]
        );
        // Deleting a token drops its image.
        assert_eq!(
            chat.prompt_images("what is [image 2]"),
            [("image 2".to_owned(), PathBuf::from("/tmp/b.png"))]
        );
    }

    #[test]
    fn at_opens_a_file_picker_that_completes_paths() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir(dir.path().join("src")).expect("src");
        std::fs::write(dir.path().join("src/parser.rs"), "x").expect("file");
        std::fs::write(dir.path().join("README.md"), "x").expect("file");
        let abilities = SessionAbilities {
            list: true,
            delete: true,
        };
        let mut chat = ChatWidget::new("Agent".into(), dir.path().to_path_buf(), abilities, 60);
        chat.handle_paste("look at @pars");
        // The index builds in the background.
        let shown = loop {
            let rows = rows(&chat, 60);
            if !rows.iter().any(|row| row.contains("Searching files")) {
                break rows;
            }
            std::thread::sleep(Duration::from_millis(5));
        };
        assert!(
            shown.iter().any(|row| row == "› src/parser.rs"),
            "{shown:?}"
        );
        chat.handle_key(key(KeyCode::Tab));
        assert_eq!(chat.composer.text(), "look at @src/parser.rs ");
        // Esc leaves the mention as typed.
        chat.handle_paste("@READ");
        chat.handle_key(key(KeyCode::Esc));
        assert!(!rows(&chat, 60).iter().any(|row| row.contains("README.md")));
    }
}
