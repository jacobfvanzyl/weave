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
use ratatui::style::Color;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::text::Span;
use weave_acp_core::AgentEvent;
use weave_acp_core::ElicitationRequest;
use weave_acp_core::MaybeUndefined;
use weave_acp_core::PermissionRequest;
use weave_acp_core::schema::AvailableCommand;
use weave_acp_core::schema::ContentBlock;
use weave_acp_core::schema::ContentChunk;
use weave_acp_core::schema::ElicitationId;
use weave_acp_core::schema::ElicitationMode;
use weave_acp_core::schema::ElicitationScope;
use weave_acp_core::schema::Error;
use weave_acp_core::schema::ListSessionsResponse;
use weave_acp_core::schema::PromptResponse;
use weave_acp_core::schema::SessionConfigOption;
use weave_acp_core::schema::SessionId;
use weave_acp_core::schema::SessionModeState;
use weave_acp_core::schema::SessionUpdate;
use weave_acp_core::schema::StopReason;
use weave_acp_core::schema::ToolCallId;

use crate::attachments::Attachment;
use crate::command_popup;
use crate::command_popup::CommandPopup;
use crate::command_popup::PopupAction;
use crate::composer::Composer;
use crate::composer::ComposerAction;
use crate::elicitation::ElicitationOutcome;
use crate::elicitation::ElicitationView;
use crate::history_cell::ToolCallCell;
use crate::history_cell::dim;
use crate::permission::Decision;
use crate::permission::PermissionView;
use crate::session::OpenedSession;
use crate::session::Reopened;
use crate::session::SessionTarget;
use crate::session_picker::PickerAction;
use crate::session_picker::SessionPicker;
use crate::settings;
use crate::settings::PickerOutcome;
use crate::settings::SettingChange;
use crate::settings::SettingsPicker;
use crate::status::status_line;
use crate::streaming::MessageStream;
use crate::streaming::StreamKind;
use crate::tool_output::TerminalTranscripts;
use crate::transcript::Reading;
use crate::transcript::TranscriptCell;
use crate::transcript::TranscriptView;

/// Footer width given to the session title before it is shortened.
const TITLE_WIDTH: usize = 32;

/// How long a first Ctrl-C keeps the second one armed to quit.
const QUIT_WINDOW: Duration = Duration::from_secs(2);

/// How long the note that a selection was copied stays up.
const COPIED_NOTE: Duration = Duration::from_secs(2);

#[derive(Debug, PartialEq, Eq)]
pub enum AppCommand {
    Prompt(String),
    Cancel,
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
    },
    DeleteSession(SessionId),
    /// Open a URL the user consented to in their browser.
    OpenUrl(String),
    /// Put text the user selected on the clipboard.
    Copy(String),
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
    /// The session being left, kept until the next one opens so a failed switch can go back.
    stashed: Option<Stashed>,
    pending_history: Vec<Line<'static>>,
    has_history: bool,
    stream: Option<MessageStream>,
    /// Tool calls still running, in the order they started.
    tool_calls: Vec<ToolCallCell>,
    /// Tool calls already committed; later updates to them are ignored.
    committed_tool_calls: HashSet<ToolCallId>,
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
    /// The session's title, as the agent last reported it.
    title: Option<String>,
    disconnected: bool,
    quit_armed_until: Option<Instant>,
    /// The active session has a conversation worth reopening later.
    resumable: bool,
    /// Confirmation that a selection was copied, until it expires.
    copied: Option<(String, Instant)>,
}

impl ChatWidget {
    pub fn new(agent_name: String, cwd: PathBuf, abilities: SessionAbilities, width: u16) -> Self {
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
            stashed: None,
            pending_history: Vec::new(),
            has_history: false,
            stream: None,
            tool_calls: Vec::new(),
            committed_tool_calls: HashSet::new(),
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
            title: None,
            disconnected: false,
            quit_armed_until: None,
            resumable: false,
            copied: None,
        }
    }

    /// Draw the transcript in the widget (fullscreen) instead of handing it to scrollback.
    pub fn fullscreen(mut self) -> Self {
        self.transcript = Some(TranscriptView::new());
        self
    }

    /// The startup banner, followed by any `notices` worth the user's attention.
    pub fn push_header(&mut self, agent_version: Option<&str>, notices: &[String]) {
        let settings = settings::summary(&self.config_options, self.modes.as_ref()).join(" · ");
        self.push_cell(TranscriptCell::header(
            self.agent_name.clone(),
            agent_version.map(str::to_owned),
            self.cwd.clone(),
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
        self.turn = None;
        self.queued.clear();
        self.commands.clear();
        self.modes = None;
        self.config_options.clear();
        self.context = None;
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
        self.end_stream();
        self.opening = false;
        self.stashed = None;
        self.resumable |= opened.reopened.is_some();
        self.modes = opened.modes;
        self.config_options = opened.config_options;
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

    pub fn set_width(&mut self, width: u16) {
        if width != self.width
            && let Some(view) = &mut self.transcript
        {
            view.resized();
        }
        self.width = width;
    }

    /// The session to offer reopening on exit: the active one, once it has a conversation.
    pub fn resumable_session(&self) -> Option<&SessionId> {
        self.active_session.as_ref().filter(|_| self.resumable)
    }

    /// Lines to write into scrollback above the viewport, in order.
    pub fn take_history(&mut self) -> Vec<Line<'static>> {
        std::mem::take(&mut self.pending_history)
    }

    /// Whether the viewport changes over time on its own (the status timer and shimmer).
    pub fn is_animating(&self) -> bool {
        self.turn.is_some() || self.copied.is_some()
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
                }
                Vec::new()
            }
            AgentEvent::PermissionRequested(request) => {
                if self.is_active(&request.request.session_id) {
                    self.handle_permission(request);
                } else {
                    let _ = request.cancel();
                }
                Vec::new()
            }
            AgentEvent::ElicitationRequested(request) => {
                self.handle_elicitation(request);
                Vec::new()
            }
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
            AgentEvent::TerminalOutput { terminal_id, text } => {
                self.terminals.entry(terminal_id).or_default().append(&text);
                self.note_activity();
                Vec::new()
            }
            AgentEvent::TerminalExited {
                terminal_id,
                status,
            } => {
                self.terminals
                    .entry(terminal_id)
                    .or_default()
                    .set_exit(status);
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
                    None => self.tool_calls.push(cell),
                }
                self.commit_finished_tool_calls();
            }
            SessionUpdate::ToolCallUpdate(update) => {
                self.end_stream();
                self.note_activity();
                self.apply_tool_call_update(update.tool_call_id, &update.fields);
                self.commit_finished_tool_calls();
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
            SessionUpdate::UsageUpdate(usage) => self.context = Some((usage.used, usage.size)),
            SessionUpdate::ConfigOptionUpdate(update) => {
                self.replace_config_options(update.config_options)
            }
            SessionUpdate::AvailableCommandsUpdate(update) => {
                self.commands = update.available_commands;
                self.sync_popup();
            }
            SessionUpdate::SessionInfoUpdate(info) => match info.title {
                MaybeUndefined::Value(title) => self.title = Some(title),
                MaybeUndefined::Null => self.title = None,
                _ => {}
            },
            _ => {}
        }
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
            None => self.tool_calls.push(ToolCallCell::from_update(id, fields)),
        }
    }

    fn handle_permission(&mut self, request: PermissionRequest) {
        let call = &request.request.tool_call;
        self.apply_tool_call_update(call.tool_call_id.clone(), &call.fields);
        if self.turn.as_ref().is_some_and(|turn| turn.cancelling) {
            // The protocol requires every pending request to resolve as cancelled.
            let _ = request.cancel();
            return;
        }
        let title = call.fields.title.clone().unwrap_or_else(|| {
            self.tool_calls
                .iter()
                .find(|live| live.id == call.tool_call_id)
                .map_or_else(
                    || "this tool call".to_owned(),
                    |live| live.title().to_owned(),
                )
        });
        let view = PermissionView::new(title, request.request.options.clone());
        self.permissions
            .push_back(PendingPermission { request, view });
    }

    fn handle_elicitation(&mut self, request: ElicitationRequest) {
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
            return;
        }
        match ElicitationView::new(&request.request, &self.agent_name) {
            Some(view) => self
                .elicitations
                .push_back(PendingElicitation { request, view }),
            None => {
                let _ = request.cancel();
            }
        }
    }

    fn end_turn(&mut self, result: Result<PromptResponse, Error>) -> Vec<AppCommand> {
        self.finish_live_cells();
        // An agent must resolve its permission requests before ending the turn; any left over
        // can no longer be answered meaningfully.
        self.answer_pending_requests_cancelled();
        let was_cancelling = self.turn.take().is_some_and(|turn| turn.cancelling);
        match result {
            Ok(response) => {
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
        match self.queued.pop_front() {
            Some(text) => self.start_prompt(text),
            None => Vec::new(),
        }
    }

    pub fn handle_paste(&mut self, text: &str) {
        if let Some(pending) = self.elicitations.front_mut() {
            pending.view.handle_paste(text);
            return;
        }
        if self.permissions.is_empty() && self.settings.is_none() && self.session_picker.is_none() {
            self.composer.insert_str(text);
            self.sync_popup();
        }
    }

    pub fn handle_key(&mut self, key: KeyEvent) -> Vec<AppCommand> {
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        if ctrl && key.code == KeyCode::Char('c') {
            return self.interrupt();
        }
        self.quit_armed_until = None;
        if ctrl && key.code == KeyCode::Char('d') && self.composer.is_empty() && self.turn.is_none()
        {
            return vec![AppCommand::Quit];
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

        if let Some(picker) = &mut self.session_picker {
            let Some(action) = picker.handle_key(key) else {
                return Vec::new();
            };
            return match action {
                PickerAction::Open(session) => vec![AppCommand::OpenSession {
                    target: SessionTarget::Existing(session.session_id),
                    title: session.title,
                }],
                PickerAction::New => vec![AppCommand::OpenSession {
                    target: SessionTarget::New,
                    title: None,
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
                PickerOutcome::Apply(change) => {
                    self.settings = None;
                    vec![AppCommand::ChangeSetting(change)]
                }
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
        if let Some(commands) = self.handle_popup_key(key) {
            return commands;
        }
        if key.code == KeyCode::Esc {
            return self.cancel_turn();
        }
        let action = self.composer.handle_key(key);
        self.sync_popup();
        self.submit(action)
    }

    /// Fullscreen transcript navigation. It comes before prompts and pickers so the transcript
    /// can be read while one is open: PageUp/PageDown, Ctrl+Home/End (or Alt+< and Alt+>),
    /// and Esc back to the newest output while reading.
    fn handle_scroll_key(&mut self, key: KeyEvent) -> Option<Vec<AppCommand>> {
        let view = self.transcript.as_mut()?;
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
            KeyCode::Esc if view.reading() != Reading::Latest => view.follow(),
            _ => return None,
        }
        Some(Vec::new())
    }

    /// Wheel scrolling and drag selection in the fullscreen transcript; a finished selection
    /// is copied.
    pub fn handle_mouse(&mut self, event: MouseEvent) -> Vec<AppCommand> {
        if self.transcript.is_none() {
            return Vec::new();
        }
        let live = self.live_lines(self.content_width());
        let Some(view) = &mut self.transcript else {
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
                let action = self
                    .composer
                    .handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
                self.sync_popup();
                Some(self.submit(action))
            }
            _ => None,
        }
    }

    fn sync_popup(&mut self) {
        let text = self.composer.text().to_owned();
        let count = self.popup.matches(&text, &self.commands).len();
        self.popup.sync(&text, count);
    }

    fn submit(&mut self, action: ComposerAction) -> Vec<AppCommand> {
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
            ComposerAction::None => Vec::new(),
        }
    }

    /// Ctrl-C: stop the turn if one runs, else clear the draft, else arm (then confirm) quitting.
    fn interrupt(&mut self) -> Vec<AppCommand> {
        if self.turn.is_some() {
            return self.cancel_turn();
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
        self.push_cell(TranscriptCell::user(&text));
        self.resumable = true;
        // Sending a message returns to the newest output, where its reply will appear.
        if let Some(view) = &mut self.transcript {
            view.follow();
        }
        self.turn = Some(Turn {
            started: Instant::now(),
            cancelling: false,
        });
        vec![AppCommand::Prompt(text)]
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
        // Fullscreen keeps the whole message live, reflowing with the screen, until it ends.
        if let Some(view) = &mut self.transcript {
            view.note_activity();
            return;
        }
        let lines = stream.take_complete();
        self.commit_stream_lines(first, lines);
    }

    fn end_stream(&mut self) {
        let Some(stream) = self.stream.take() else {
            return;
        };
        if self.transcript.is_some() {
            let kind = stream.kind();
            let source = stream.into_source();
            if !source.trim().is_empty() {
                self.push_cell(TranscriptCell::message(kind, source));
            }
            return;
        }
        let first = !stream.has_committed();
        let lines = stream.finish();
        self.commit_stream_lines(first, lines);
    }

    fn commit_stream_lines(&mut self, first: bool, lines: Vec<Line<'static>>) {
        if lines.is_empty() {
            return;
        }
        if first {
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
        let terminals = cell
            .terminal_ids()
            .filter_map(|id| Some((id.clone(), self.terminals.get(id)?.clone())))
            .collect();
        self.push_cell(TranscriptCell::tool_call(cell, self.cwd.clone(), terminals));
    }

    /// Commit everything still live, as it stands, when the turn ends.
    fn finish_live_cells(&mut self) {
        self.end_stream();
        for cell in std::mem::take(&mut self.tool_calls) {
            self.commit_tool_call(cell);
        }
    }

    fn push_cell(&mut self, cell: TranscriptCell) {
        match &mut self.transcript {
            Some(view) => {
                view.push(cell);
                self.has_history = true;
            }
            None => {
                let lines = cell.lines(self.content_width()).to_vec();
                self.push_lines(lines);
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
    fn live_lines(&self, width: usize) -> Vec<Line<'static>> {
        let mut lines = Vec::new();
        for cell in &self.tool_calls {
            lines.push(Line::default());
            lines.extend(cell.lines(width, &self.cwd, &self.terminals));
        }
        if let Some(stream) = &self.stream
            && self.transcript.is_some()
        {
            let message = stream.render_all(width);
            if !message.is_empty() {
                lines.push(Line::default());
                lines.extend(message);
            }
        } else if let Some(stream) = &self.stream {
            let tail = stream.tail();
            if !tail.is_empty() {
                if !stream.has_committed() || !self.tool_calls.is_empty() {
                    lines.push(Line::default());
                }
                lines.extend(tail);
            }
        }
        lines
    }

    fn status_lines(&self, now: Instant) -> Vec<Line<'static>> {
        let mut lines = Vec::new();
        if let Some(turn) = &self.turn {
            let (label, hint) = if turn.cancelling {
                ("Cancelling", "waiting for the agent")
            } else {
                ("Working", "esc to interrupt")
            };
            lines.push(status_line(label, turn.started, now, hint));
        }
        for text in &self.queued {
            let first_line = text.lines().next().unwrap_or_default();
            lines.push(Line::from(Span::styled(
                format!("  ↳ queued: {first_line}"),
                dim(),
            )));
        }
        lines
    }

    fn footer(&self, width: u16, now: Instant) -> Line<'static> {
        // Hints in display order, each with how early it gives way when space is short.
        let (mut hints, hint_style): (Vec<(&str, u8)>, Style) = if self.disconnected {
            (
                vec![("agent disconnected · ctrl+c to quit", 0)],
                Style::default().fg(Color::Red),
            )
        } else if self.quit_armed_until.is_some_and(|until| now < until) {
            (vec![("ctrl+c again to quit", 0)], Style::default())
        } else if self.has_overlay() {
            // Prompts and pickers show their own keys.
            (Vec::new(), dim())
        } else if self.turn.is_some() {
            (vec![("⏎ queue", 1), ("esc interrupt", 0)], dim())
        } else {
            let mut hints = vec![("⏎ send", 0), ("⇧⏎ newline", 3)];
            if settings::next_mode(&self.config_options, self.modes.as_ref()).is_some() {
                hints.push(("⇧⇥ mode", 2));
            }
            if !self.config_options.is_empty() || self.modes.is_some() {
                hints.push(("⌃O settings", 1));
            }
            hints.push(("⌃C quit", 0));
            (hints, dim())
        };
        let mut details = Vec::new();
        if let Some(title) = &self.title {
            details.push(truncate(title, TITLE_WIDTH));
        }
        details.push(self.agent_name.clone());
        details.extend(settings::summary(&self.config_options, self.modes.as_ref()));
        if let Some((used, size)) = self.context
            && size > 0
        {
            let left = 100u64.saturating_sub(used.saturating_mul(100) / size);
            details.push(format!("{left}% context left"));
        }

        let width = usize::from(width);
        let joined = |hints: &[(&str, u8)]| {
            hints
                .iter()
                .map(|(hint, _)| *hint)
                .collect::<Vec<_>>()
                .join(" · ")
        };
        let fits = |hints: &str, details: &[String]| {
            let details = details.join(" · ");
            2 + hints.chars().count() + 2 + details.chars().count() <= width
        };
        // Shed the most optional hints first, then the leading details (the agent name).
        while !fits(&joined(&hints), &details) {
            if let Some(index) = hints
                .iter()
                .enumerate()
                .filter(|(_, (_, priority))| *priority > 0)
                .max_by_key(|(index, (_, priority))| (*priority, *index))
                .map(|(index, _)| index)
            {
                hints.remove(index);
            } else if details.len() > 1 {
                details.remove(0);
            } else {
                break;
            }
        }
        let hints = joined(&hints);
        let details = details.join(" · ");
        let mut spans = vec![Span::raw("  "), Span::styled(hints.clone(), hint_style)];
        let gap = width.saturating_sub(2 + hints.chars().count() + details.chars().count());
        if gap >= 2 {
            spans.push(Span::raw(" ".repeat(gap)));
            spans.push(Span::styled(details, dim()));
        }
        Line::from(spans)
    }

    /// Whether a prompt or picker has replaced the composer.
    fn has_overlay(&self) -> bool {
        !self.permissions.is_empty()
            || !self.elicitations.is_empty()
            || self.session_picker.is_some()
            || self.settings.is_some()
    }

    fn popup_matches(&self) -> Vec<&AvailableCommand> {
        self.popup.matches(self.composer.text(), &self.commands)
    }

    fn input_height(&self, width: u16) -> u16 {
        if let Some(pending) = self.permissions.front() {
            return pending.view.desired_height(width);
        }
        if let Some(pending) = self.elicitations.front() {
            return pending.view.desired_height(width);
        }
        if let Some(picker) = &self.session_picker {
            return picker.desired_height();
        }
        if let Some(picker) = &self.settings {
            return picker.desired_height(&self.config_options, self.modes.as_ref());
        }
        CommandPopup::height(self.popup_matches().len()) + self.composer.desired_height(width)
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
        let mut lines = self.live_lines(usize::from(width));
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
        match self.transcript.as_ref().map(TranscriptView::reading) {
            Some(Reading::Earlier) => {
                Line::from(Span::styled("  ↑ scrolled back · esc for latest", dim()))
            }
            Some(Reading::EarlierWithNewOutput) => Line::from(Span::styled(
                "  ↓ new output below · esc for latest",
                Style::default().fg(Color::Cyan),
            )),
            _ => Line::default(),
        }
    }

    pub fn desired_height(&self, width: u16) -> u16 {
        let above = self.lines_above_input(width, Instant::now()).len();
        let total = above + usize::from(self.input_height(width)) + 1;
        u16::try_from(total).unwrap_or(u16::MAX)
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
        let wanted = above.len() + usize::from(self.input_height(area.width)) + 1;
        let bottom_height = u16::try_from(wanted).unwrap_or(u16::MAX).min(cap);
        let transcript_area = Rect::new(area.x, area.y, area.width, area.height - bottom_height);
        let width = usize::from(area.width.max(10));
        view.render(transcript_area, buf, width, &self.live_lines(width));
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
        let input_height = self
            .input_height(area.width)
            .min(area.height.saturating_sub(1));

        let room = usize::from(area.height.saturating_sub(input_height + 1));
        let skip = above.len().saturating_sub(room);
        let mut y = area.y;
        for line in above.iter().skip(skip) {
            buf.set_line(area.x, y, line, area.width);
            y += 1;
        }

        let input_area = Rect::new(area.x, y, area.width, input_height);
        let cursor = if let Some(pending) = self.permissions.front() {
            pending.view.render(input_area, buf);
            None
        } else if let Some(pending) = self.elicitations.front() {
            pending.view.render(input_area, buf)
        } else if let Some(picker) = &self.session_picker {
            picker.render(input_area, buf);
            None
        } else if let Some(picker) = &self.settings {
            picker.render(input_area, buf, &self.config_options, self.modes.as_ref());
            None
        } else {
            let matches = self.popup_matches();
            let popup_height = CommandPopup::height(matches.len()).min(input_area.height);
            let popup_area = Rect::new(input_area.x, input_area.y, input_area.width, popup_height);
            self.popup.render(&matches, popup_area, buf);
            let composer_area = Rect::new(
                input_area.x,
                input_area.y + popup_height,
                input_area.width,
                input_area.height - popup_height,
            );
            let placeholder = format!("Ask {} anything", self.agent_name);
            Some(
                self.composer
                    .render(composer_area, buf, &placeholder, self.command_hint()),
            )
        };
        let footer_y = (y + input_height).min(area.bottom().saturating_sub(1));
        buf.set_line(area.x, footer_y, &self.footer(area.width, now), area.width);
        cursor
    }
}

fn truncate(text: &str, width: usize) -> String {
    if text.chars().count() <= width {
        return text.to_owned();
    }
    let kept: String = text.chars().take(width.saturating_sub(1)).collect();
    format!("{kept}…")
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
            ["› do it", "", "• Reading the file.", "  Then"]
        );

        chat.handle_agent_event(update(SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(
            "t1",
            ToolCallUpdateFields::new().status(ToolCallStatus::Completed),
        ))));
        chat.handle_agent_event(text_chunk("Done."));
        assert!(
            chat.handle_agent_event(turn_ended(StopReason::EndTurn))
                .is_empty()
        );

        assert_eq!(history(&mut chat), ["", "✓ Read a.rs  read", "", "• Done."]);
        assert!(!chat.is_animating());
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
        assert_eq!(
            history(&mut chat),
            ["", "✗ Run tests  execute", "  └ ok 1", "    exit 1"]
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
        assert_eq!(history(&mut chat), ["• Mode set to Code"]);
        assert!(
            rows(&chat, 80)
                .last()
                .is_some_and(|footer| footer.ends_with("Agent · Code"))
        );
    }

    #[test]
    fn ctrl_o_opens_settings_and_applies_a_choice() {
        let options = vec![SessionConfigOption::boolean("verbose", "Verbose", false)];
        let mut chat = chat_with(options);
        assert!(
            chat.handle_key(KeyEvent::new(KeyCode::Char('o'), KeyModifiers::CONTROL))
                .is_empty()
        );
        assert!(rows(&chat, 60).iter().any(|row| row == "› Verbose  off"));
        assert_eq!(
            chat.handle_key(key(KeyCode::Enter)),
            [AppCommand::ChangeSetting(SettingChange::ConfigOption(
                "verbose".into(),
                SessionConfigOptionValue::boolean(true)
            ))]
        );
        assert!(chat.settings.is_none());
    }

    #[test]
    fn narrow_footers_shed_optional_hints_before_details() {
        let options = vec![SessionConfigOption::boolean("verbose", "Verbose", false)];
        let mut chat = chat_with(options);
        chat.context = Some((25, 100));
        let footer = chat.footer(60, Instant::now()).to_string();
        assert!(
            footer.starts_with("  ⏎ send · ⌃O settings · ⌃C quit"),
            "{footer}"
        );
        assert!(footer.ends_with("Agent · 75% context left"), "{footer}");

        let footer = chat.footer(40, Instant::now()).to_string();
        assert_eq!(
            footer.trim_end(),
            "  ⏎ send · ⌃C quit      75% context left"
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
        });
        assert_eq!(
            history(&mut chat),
            ["• Session: Fix the build", "", "› fix it", "", "• Done."]
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
        chat.take_history();

        chat.begin_session("s2".into(), None);
        chat.handle_agent_event(AgentEvent::SessionUpdate(SessionNotification::new(
            "s2",
            finished(),
        )));
        assert_eq!(history(&mut chat), ["", "✓ Run it  execute"]);
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
        assert_eq!(history(&mut chat), ["› first", "", "› second"]);
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
                title: Some("Earlier work".into())
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
        assert_eq!(rows[1], "◐ Run tests  execute");
        assert!(
            rows[3].starts_with("◦ Working (0s • esc to interrupt)"),
            "{rows:?}"
        );
        assert_eq!(rows[4], "› Ask Agent anything");
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
        let rows = screen_rows(&chat, 40, 12);
        assert!(
            rows.iter().any(|row| row.starts_with("• weave")),
            "{rows:?}"
        );
        assert!(rows.contains(&"• Session: Other".to_owned()));
        assert!(!rows.contains(&"› first session".to_owned()));

        chat.session_failed(&Error::internal_error(), Some("s1".into()));
        let rows = screen_rows(&chat, 40, 12);
        assert!(rows.contains(&"› first session".to_owned()), "{rows:?}");
        assert!(!rows.contains(&"• Session: Other".to_owned()));
        assert_eq!(chat.resumable_session(), Some(&SessionId::from("s1")));
    }
}
