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
use ratatui::buffer::Buffer;
use ratatui::layout::Position;
use ratatui::layout::Rect;
use ratatui::style::Color;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::text::Span;
use weave_acp_core::AgentEvent;
use weave_acp_core::PermissionRequest;
use weave_acp_core::schema::ContentBlock;
use weave_acp_core::schema::Error;
use weave_acp_core::schema::PromptResponse;
use weave_acp_core::schema::SessionModeState;
use weave_acp_core::schema::SessionUpdate;
use weave_acp_core::schema::StopReason;
use weave_acp_core::schema::ToolCallId;

use crate::composer::Composer;
use crate::composer::ComposerAction;
use crate::history_cell;
use crate::history_cell::SessionHeader;
use crate::history_cell::ToolCallCell;
use crate::history_cell::dim;
use crate::permission::Decision;
use crate::permission::PermissionView;
use crate::status::status_line;
use crate::streaming::MessageStream;
use crate::streaming::StreamKind;

/// How long a first Ctrl-C keeps the second one armed to quit.
const QUIT_WINDOW: Duration = Duration::from_secs(2);

#[derive(Debug, PartialEq, Eq)]
pub enum AppCommand {
    Prompt(String),
    Cancel,
    Quit,
}

struct Turn {
    started: Instant,
    cancelling: bool,
}

struct PendingPermission {
    request: PermissionRequest,
    view: PermissionView,
}

pub struct ChatWidget {
    agent_name: String,
    cwd: PathBuf,
    width: u16,
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
    context: Option<(u64, u64)>,
    disconnected: bool,
    quit_armed_until: Option<Instant>,
}

impl ChatWidget {
    pub fn new(
        agent_name: String,
        cwd: PathBuf,
        modes: Option<SessionModeState>,
        width: u16,
    ) -> Self {
        Self {
            agent_name,
            cwd,
            width,
            pending_history: Vec::new(),
            has_history: false,
            stream: None,
            tool_calls: Vec::new(),
            committed_tool_calls: HashSet::new(),
            turn: None,
            permissions: VecDeque::new(),
            composer: Composer::default(),
            queued: VecDeque::new(),
            modes,
            context: None,
            disconnected: false,
            quit_armed_until: None,
        }
    }

    pub fn push_header(&mut self, agent_version: Option<&str>) {
        let mode = self.current_mode_name().map(str::to_owned);
        let header = SessionHeader {
            agent: &self.agent_name,
            agent_version,
            cwd: &self.cwd,
            mode: mode.as_deref(),
        };
        let lines = history_cell::session_header(&header, self.content_width());
        self.push_cell(lines);
    }

    pub fn set_width(&mut self, width: u16) {
        self.width = width;
    }

    /// Lines to write into scrollback above the viewport, in order.
    pub fn take_history(&mut self) -> Vec<Line<'static>> {
        std::mem::take(&mut self.pending_history)
    }

    /// Whether the viewport changes over time on its own (the status timer and shimmer).
    pub fn is_animating(&self) -> bool {
        self.turn.is_some()
    }

    pub fn handle_agent_event(&mut self, event: AgentEvent) -> Vec<AppCommand> {
        match event {
            AgentEvent::SessionUpdate(notification) => {
                self.handle_update(notification.update);
                Vec::new()
            }
            AgentEvent::PermissionRequested(request) => {
                self.handle_permission(request);
                Vec::new()
            }
            AgentEvent::TurnEnded { result, .. } => self.end_turn(result),
            AgentEvent::Disconnected(error) => {
                self.finish_live_cells();
                self.answer_pending_permissions_cancelled();
                self.turn = None;
                self.disconnected = true;
                let reason =
                    error.map_or_else(|| "the agent exited".to_owned(), |error| error.to_string());
                self.push_error(&format!("Disconnected: {reason}"));
                Vec::new()
            }
        }
    }

    /// The agent rejected the prompt request before the turn could start.
    pub fn prompt_failed(&mut self, error: &Error) {
        self.turn = None;
        self.push_error(&format!("Prompt failed: {error}"));
    }

    fn handle_update(&mut self, update: SessionUpdate) {
        match update {
            SessionUpdate::AgentMessageChunk(chunk) => {
                self.stream_content(StreamKind::Agent, &chunk.content)
            }
            SessionUpdate::AgentThoughtChunk(chunk) => {
                self.stream_content(StreamKind::Thought, &chunk.content)
            }
            SessionUpdate::UserMessageChunk(chunk) => {
                self.end_stream();
                let lines =
                    history_cell::user_message(&content_text(&chunk.content), self.content_width());
                self.push_cell(lines);
            }
            SessionUpdate::ToolCall(call) => {
                self.end_stream();
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
                self.apply_tool_call_update(update.tool_call_id, &update.fields);
                self.commit_finished_tool_calls();
            }
            SessionUpdate::Plan(plan) => {
                self.end_stream();
                let lines = history_cell::plan(&plan, self.content_width());
                self.push_cell(lines);
            }
            SessionUpdate::CurrentModeUpdate(update) => {
                if let Some(modes) = &mut self.modes {
                    modes.current_mode_id = update.current_mode_id;
                }
                if let Some(name) = self.current_mode_name().map(str::to_owned) {
                    self.end_stream();
                    let lines = history_cell::info(
                        &format!("Mode changed to {name}"),
                        self.content_width(),
                    );
                    self.push_cell(lines);
                }
            }
            SessionUpdate::UsageUpdate(usage) => self.context = Some((usage.used, usage.size)),
            // Commands, config options and session info drive UI that arrives with later
            // milestones; nothing in the transcript depends on them.
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

    fn end_turn(&mut self, result: Result<PromptResponse, Error>) -> Vec<AppCommand> {
        self.finish_live_cells();
        // An agent must resolve its permission requests before ending the turn; any left over
        // can no longer be answered meaningfully.
        self.answer_pending_permissions_cancelled();
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
                    let lines = history_cell::info(note, self.content_width());
                    self.push_cell(lines);
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
        if self.permissions.is_empty() {
            self.composer.insert_str(text);
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

        if key.code == KeyCode::Esc {
            return self.cancel_turn();
        }
        match self.composer.handle_key(key) {
            ComposerAction::Submit(text) if self.disconnected => {
                self.composer.insert_str(&text);
                Vec::new()
            }
            ComposerAction::Submit(text) if self.turn.is_some() => {
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
        let lines = history_cell::user_message(&text, self.content_width());
        self.push_cell(lines);
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
        self.answer_pending_permissions_cancelled();
        // Like Codex, give queued follow-ups back for editing rather than sending them.
        if !self.queued.is_empty() && self.composer.is_empty() {
            let restored = self.queued.drain(..).collect::<Vec<_>>().join("\n");
            self.composer.insert_str(&restored);
        }
        vec![AppCommand::Cancel]
    }

    fn answer_pending_permissions_cancelled(&mut self) {
        for pending in self.permissions.drain(..) {
            let _ = pending.request.cancel();
        }
    }

    fn stream_content(&mut self, kind: StreamKind, content: &ContentBlock) {
        if self
            .stream
            .as_ref()
            .is_some_and(|stream| stream.kind() != kind)
        {
            self.end_stream();
        }
        let width = self.content_width();
        let stream = self
            .stream
            .get_or_insert_with(|| MessageStream::new(kind, width));
        let first = !stream.has_committed();
        stream.push(&content_text(content));
        let lines = stream.take_complete();
        self.commit_stream_lines(first, lines);
    }

    fn end_stream(&mut self) {
        if let Some(stream) = self.stream.take() {
            let first = !stream.has_committed();
            let lines = stream.finish();
            self.commit_stream_lines(first, lines);
        }
    }

    fn commit_stream_lines(&mut self, first: bool, lines: Vec<Line<'static>>) {
        if lines.is_empty() {
            return;
        }
        if first {
            self.push_cell(lines);
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
        let lines = cell.lines(self.content_width(), &self.cwd);
        self.committed_tool_calls.insert(cell.id);
        self.push_cell(lines);
    }

    /// Commit everything still live, as it stands, when the turn ends.
    fn finish_live_cells(&mut self) {
        self.end_stream();
        for cell in std::mem::take(&mut self.tool_calls) {
            self.commit_tool_call(cell);
        }
    }

    fn push_cell(&mut self, lines: Vec<Line<'static>>) {
        if self.has_history {
            self.pending_history.push(Line::default());
        }
        self.pending_history.extend(lines);
        self.has_history = true;
    }

    fn push_error(&mut self, message: &str) {
        let lines = history_cell::error(message, self.content_width());
        self.push_cell(lines);
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
            lines.extend(cell.lines(width, &self.cwd));
        }
        if let Some(stream) = &self.stream {
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
        let hints = if self.disconnected {
            Span::styled(
                "agent disconnected · ctrl+c to quit",
                Style::default().fg(Color::Red),
            )
        } else if self.quit_armed_until.is_some_and(|until| now < until) {
            Span::styled("ctrl+c again to quit", Style::default())
        } else if self.turn.is_some() {
            Span::styled("enter queue a message · esc interrupt", dim())
        } else {
            Span::styled("enter send · shift+enter newline · ctrl+c quit", dim())
        };
        let mut details = self.agent_name.clone();
        if let Some(mode) = self.current_mode_name() {
            details.push_str(&format!(" · {mode}"));
        }
        if let Some((used, size)) = self.context
            && size > 0
        {
            let left = 100u64.saturating_sub(used.saturating_mul(100) / size);
            details.push_str(&format!(" · {left}% context left"));
        }
        let left_width = hints.content.chars().count() + 2;
        let gap = usize::from(width).saturating_sub(left_width + details.chars().count());
        let mut spans = vec![Span::raw("  "), hints];
        if gap >= 2 {
            spans.push(Span::raw(" ".repeat(gap)));
            spans.push(Span::styled(details, dim()));
        }
        Line::from(spans)
    }

    fn input_height(&self, width: u16) -> u16 {
        match self.permissions.front() {
            Some(pending) => pending.view.desired_height(width),
            None => self.composer.desired_height(width),
        }
    }

    /// Everything drawn above the composer or permission prompt.
    fn lines_above_input(&self, width: u16, now: Instant) -> Vec<Line<'static>> {
        let mut lines = self.live_lines(usize::from(width));
        lines.push(Line::default());
        let status = self.status_lines(now);
        let has_status = !status.is_empty();
        lines.extend(status);
        if has_status && !self.permissions.is_empty() {
            lines.push(Line::default());
        }
        lines
    }

    pub fn desired_height(&self, width: u16) -> u16 {
        let above = self.lines_above_input(width, Instant::now()).len();
        let total = above + usize::from(self.input_height(width)) + 1;
        u16::try_from(total).unwrap_or(u16::MAX)
    }

    /// Draw the viewport. Returns where the terminal cursor belongs, if anywhere.
    pub fn render(&self, area: Rect, buf: &mut Buffer) -> Option<Position> {
        let now = Instant::now();
        let input_height = self
            .input_height(area.width)
            .min(area.height.saturating_sub(1));
        let above = self.lines_above_input(area.width, now);

        // When space is short, keep the newest live lines and drop the oldest.
        let room = usize::from(area.height.saturating_sub(input_height + 1));
        let skip = above.len().saturating_sub(room);
        let mut y = area.y;
        for line in above.iter().skip(skip) {
            buf.set_line(area.x, y, line, area.width);
            y += 1;
        }

        let input_area = Rect::new(area.x, y, area.width, input_height);
        let cursor = match self.permissions.front() {
            Some(pending) => {
                pending.view.render(input_area, buf);
                None
            }
            None => {
                let placeholder = format!("Ask {} anything", self.agent_name);
                Some(self.composer.render(input_area, buf, &placeholder))
            }
        };
        let footer_y = (y + input_height).min(area.bottom().saturating_sub(1));
        buf.set_line(area.x, footer_y, &self.footer(area.width, now), area.width);
        cursor
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
    use weave_acp_core::schema::ContentChunk;
    use weave_acp_core::schema::SessionNotification;
    use weave_acp_core::schema::ToolCall;
    use weave_acp_core::schema::ToolCallStatus;
    use weave_acp_core::schema::ToolCallUpdate;
    use weave_acp_core::schema::ToolCallUpdateFields;
    use weave_acp_core::schema::ToolKind;

    use super::*;

    fn chat() -> ChatWidget {
        ChatWidget::new("Agent".into(), PathBuf::from("/repo"), None, 60)
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
}
