//! Subagents, from ACP's draft Subagent Sessions RFD, shown as Codex shows its own
//! (`codex-rs/tui/src/multi_agents.rs`, `app/agent_navigation.rs`, Apache-2.0): rows in the
//! parent's transcript for what happens to each child (`• Spawned`, `• Sent input to`,
//! `• Completed`), a `/subagents` picker with a dot that is green while a child works, and
//! Alt+Left / Alt+Right to watch another agent's transcript.
//!
//! Each child is its own session with its own updates, kept in a chat of its own; the parent
//! only knows its label, controls and current work state.

use std::time::Instant;

use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Color;
use ratatui::style::Modifier;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::text::Span;
use unicode_segmentation::UnicodeSegmentation;
use weave_acp_core::MaybeUndefined;
use weave_acp_core::schema::SessionId;
use weave_acp_core::schema::StateUpdate;
use weave_acp_core::schema::StopReason;
use weave_acp_core::schema::SubagentUpdate;

use crate::chat::ChatWidget;
use crate::history_cell::dim;
use crate::status::format_elapsed;
use crate::style;
use crate::wrapping::DisplayLine;
use crate::wrapping::wrap_sourced;

/// Longest preview of a message or reply in the parent's rows, as Codex bounds them.
const PROMPT_PREVIEW: usize = 160;
const REPLY_PREVIEW: usize = 240;

/// The local command that opens the picker, as Codex names its own.
pub const COMMAND: &str = "subagents";
pub const COMMAND_DESCRIPTION: &str = "Switch between this session's subagents";

/// A child session the parent created and owns.
pub struct Subagent {
    pub id: SessionId,
    /// The parent's title for the child, if it gave one.
    pub title: Option<String>,
    /// The parent's description of the child's role.
    pub description: Option<String>,
    /// Its place among its siblings, from 1, for a label when it has no title.
    pub number: usize,
    /// Whether the client may cancel its current work.
    pub cancel: bool,
    pub state: Option<StateUpdate>,
    /// When it last started working.
    pub since: Instant,
    /// Its own transcript.
    pub chat: Box<ChatWidget>,
}

impl Subagent {
    /// The child's name: its title, or "Subagent N".
    pub fn label(&self) -> String {
        self.title
            .clone()
            .unwrap_or_else(|| format!("Subagent {}", self.number))
    }

    pub fn is_running(&self) -> bool {
        matches!(self.state, Some(StateUpdate::Running(_)))
    }

    /// Apply an update's patches: omitted fields stay, `null` clears, a value replaces.
    /// Returns the state it had before.
    pub fn apply(&mut self, update: &SubagentUpdate, now: Instant) -> Option<StateUpdate> {
        patch(&mut self.title, &update.title);
        patch(&mut self.description, &update.description);
        match &update.capabilities {
            MaybeUndefined::Undefined => {}
            MaybeUndefined::Null => self.cancel = false,
            MaybeUndefined::Value(capabilities) => self.cancel = capabilities.cancel.is_some(),
        }
        let previous = self.state.clone();
        match &update.state {
            MaybeUndefined::Undefined => {}
            MaybeUndefined::Null => self.state = None,
            MaybeUndefined::Value(state) => {
                if matches!(state, StateUpdate::Running(_))
                    && !matches!(previous, Some(StateUpdate::Running(_)))
                {
                    self.since = now;
                }
                self.state = Some(state.clone());
            }
        }
        previous
    }

    /// What the child is doing, for the picker.
    pub fn activity(&self, now: Instant) -> String {
        match &self.state {
            Some(StateUpdate::Running(_)) => format!(
                "running {}",
                format_elapsed(now.saturating_duration_since(self.since))
            ),
            Some(StateUpdate::RequiresAction(_)) => "needs you".to_owned(),
            Some(StateUpdate::Idle(_)) => "idle".to_owned(),
            Some(StateUpdate::Unknown(_)) => "unknown".to_owned(),
            Some(_) | None => String::new(),
        }
    }
}

fn patch(field: &mut Option<String>, value: &MaybeUndefined<String>) {
    match value {
        MaybeUndefined::Undefined => {}
        MaybeUndefined::Null => *field = None,
        MaybeUndefined::Value(value) => {
            *field = Some(value.trim().to_owned()).filter(|value| !value.is_empty());
        }
    }
}

/// What happened to a child, as a row in its parent's transcript.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Event {
    Spawned {
        description: Option<String>,
    },
    /// Back to work after being idle.
    Resumed,
    Completed {
        reply: Option<String>,
    },
    Interrupted,
    /// Stopped for a reason other than finishing or being cancelled.
    Stopped {
        reason: String,
    },
    /// Idle without saying why.
    Finished,
    /// The agent can no longer tell what the child is doing.
    Unknown,
    /// A message the parent sent the child.
    SentInput {
        text: String,
    },
    /// A message the child sent its parent.
    MessageFrom {
        text: String,
    },
}

impl Event {
    /// The row for a change of work state, if it is one worth a row.
    pub fn for_state(
        previous: Option<&StateUpdate>,
        state: &StateUpdate,
        reply: Option<String>,
    ) -> Option<Self> {
        let was_idle = matches!(previous, Some(StateUpdate::Idle(_)));
        match state {
            StateUpdate::Running(_) if was_idle => Some(Self::Resumed),
            StateUpdate::Idle(_) if was_idle => None,
            StateUpdate::Idle(idle) => Some(match &idle.stop_reason {
                Some(StopReason::EndTurn) => Self::Completed { reply },
                Some(StopReason::Cancelled) => Self::Interrupted,
                Some(StopReason::MaxTokens) => Self::Stopped {
                    reason: "it reached its token limit".to_owned(),
                },
                Some(StopReason::MaxTurnRequests) => Self::Stopped {
                    reason: "it reached its request limit".to_owned(),
                },
                Some(StopReason::Refusal) => Self::Stopped {
                    reason: "it refused to continue".to_owned(),
                },
                Some(_) => Self::Stopped {
                    reason: "it stopped".to_owned(),
                },
                None => Self::Finished,
            }),
            StateUpdate::Unknown(_) if !matches!(previous, Some(StateUpdate::Unknown(_))) => {
                Some(Self::Unknown)
            }
            _ => None,
        }
    }
}

/// A row in the parent's transcript, as Codex's: `• Spawned Robie` with details under `└`.
pub fn event_lines(label: &str, event: &Event, width: usize) -> Vec<DisplayLine> {
    let (verb, after, detail): (&str, &str, Option<String>) = match event {
        Event::Spawned { description } => ("Spawned ", "", description.clone()),
        Event::Resumed => ("Resumed ", "", None),
        Event::Completed { reply } => (
            "Completed ",
            "",
            reply.as_deref().map(|reply| preview(reply, REPLY_PREVIEW)),
        ),
        Event::Interrupted => ("Interrupted ", "", None),
        Event::Stopped { reason } => ("Stopped ", "", Some(format!("Because {reason}"))),
        Event::Finished => ("Finished ", "", None),
        Event::Unknown => ("Lost track of ", "", None),
        Event::SentInput { text } => ("Sent input to ", "", Some(preview(text, PROMPT_PREVIEW))),
        Event::MessageFrom { text } => ("Message from ", "", Some(preview(text, REPLY_PREVIEW))),
    };
    let title = Line::from(vec![
        Span::styled("• ", dim()),
        Span::styled(verb, Style::default().add_modifier(Modifier::BOLD)),
        Span::styled(label.to_owned(), label_style()),
        Span::raw(after),
    ]);
    let mut lines = vec![DisplayLine::whole(title)];
    if let Some(detail) = detail.filter(|detail| !detail.is_empty()) {
        let first = Line::from(Span::styled("  └ ", dim()));
        let rest = Line::from("    ");
        lines.extend(wrap_sourced(&Line::from(detail), width, &first, &rest));
    }
    lines
}

/// A message as the child's own transcript shows it: from or to its parent.
pub fn message_lines(incoming: bool, other: &str, text: &str, width: usize) -> Vec<DisplayLine> {
    let heading = if incoming { "From " } else { "To " };
    let title = Line::from(vec![
        Span::styled("• ", dim()),
        Span::styled(heading, Style::default().add_modifier(Modifier::BOLD)),
        Span::styled(other.to_owned(), label_style()),
    ]);
    let mut lines = vec![DisplayLine::whole(title)];
    let first = Line::from(Span::styled("  └ ", dim()));
    let rest = Line::from("    ");
    for paragraph in text.lines() {
        let prefix = if lines.len() == 1 { &first } else { &rest };
        lines.extend(wrap_sourced(
            &Line::from(paragraph.to_owned()),
            width,
            prefix,
            &rest,
        ));
    }
    lines
}

fn label_style() -> Style {
    Style::default()
        .fg(style::accent())
        .add_modifier(Modifier::BOLD)
}

/// `text` on one line, cut to `max` characters.
fn preview(text: &str, max: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.graphemes(true).count() <= max {
        return flat;
    }
    let kept: String = flat.graphemes(true).take(max.saturating_sub(1)).collect();
    format!("{}…", kept.trim_end())
}

/// One row of the picker: the main session, or a subagent.
pub struct PickerEntry {
    /// `None` for the main session.
    pub id: Option<SessionId>,
    pub label: String,
    pub description: Option<String>,
    pub running: bool,
    pub activity: String,
    /// How deep it is under the main session, for indenting nested subagents.
    pub depth: usize,
}

/// The `/subagents` picker, as Codex's: pick an agent to watch.
#[derive(Default)]
pub struct Picker {
    selected: usize,
}

pub enum PickerAction {
    Watch(Option<SessionId>),
    Close,
}

impl Picker {
    /// Start on the agent being watched.
    pub fn new(entries: &[PickerEntry], watching: Option<&SessionId>) -> Self {
        let selected = entries
            .iter()
            .position(|entry| entry.id.as_ref() == watching)
            .unwrap_or(0);
        Self { selected }
    }

    pub fn handle_key(&mut self, key: KeyEvent, entries: &[PickerEntry]) -> Option<PickerAction> {
        match key.code {
            KeyCode::Esc => Some(PickerAction::Close),
            KeyCode::Up | KeyCode::Char('k') => {
                self.selected = self.selected.saturating_sub(1);
                None
            }
            KeyCode::Down | KeyCode::Char('j') => {
                self.selected = (self.selected + 1).min(entries.len().saturating_sub(1));
                None
            }
            KeyCode::Enter => entries
                .get(self.selected)
                .map(|entry| PickerAction::Watch(entry.id.clone())),
            KeyCode::Char(digit @ '1'..='9') => {
                let index = digit as usize - '1' as usize;
                entries
                    .get(index)
                    .map(|entry| PickerAction::Watch(entry.id.clone()))
            }
            _ => None,
        }
    }

    pub fn lines(&self, entries: &[PickerEntry]) -> Vec<Line<'static>> {
        let mut lines = vec![
            Line::from(Span::styled(
                "  Subagents",
                Style::default().add_modifier(Modifier::BOLD),
            )),
            Line::from(Span::styled(
                "  Select an agent to watch. ⌥← previous, ⌥→ next.",
                dim(),
            )),
            Line::default(),
        ];
        for (index, entry) in entries.iter().enumerate() {
            let selected = index == self.selected;
            let marker = if selected { "› " } else { "  " };
            let dot = if entry.running {
                Span::styled("• ", Style::default().fg(Color::Green))
            } else {
                Span::styled("• ", dim())
            };
            let mut spans = vec![
                Span::raw(format!("{marker}{}. ", index + 1)),
                Span::raw("  ".repeat(entry.depth)),
                dot,
                Span::styled(
                    entry.label.clone(),
                    Style::default().add_modifier(Modifier::BOLD),
                ),
            ];
            if !entry.activity.is_empty() {
                spans.push(Span::styled(format!("  {}", entry.activity), dim()));
            }
            if let Some(description) = &entry.description {
                spans.push(Span::styled(
                    format!("  {}", preview(description, 80)),
                    dim(),
                ));
            }
            let line = Line::from(spans);
            lines.push(if selected {
                line.style(style::selection())
            } else {
                line
            });
        }
        lines.push(Line::default());
        lines.push(Line::from(Span::styled("  enter select · esc back", dim())));
        lines
    }

    pub fn render(&self, entries: &[PickerEntry], area: Rect, buf: &mut Buffer) {
        for (line, y) in self.lines(entries).iter().zip(area.y..area.bottom()) {
            style::set_line_filled(buf, area.x, y, line, area.width);
        }
    }
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;
    use weave_acp_core::schema::IdleStateUpdate;
    use weave_acp_core::schema::RunningStateUpdate;

    use super::*;

    fn text(lines: &[DisplayLine]) -> Vec<String> {
        lines.iter().map(|row| row.line.to_string()).collect()
    }

    #[test]
    fn rows_read_as_codex_reads_them() {
        assert_eq!(
            text(&event_lines(
                "Robie",
                &Event::Spawned {
                    description: Some("Investigates test failures".into())
                },
                60
            )),
            ["• Spawned Robie", "  └ Investigates test failures"]
        );
        assert_eq!(
            text(&event_lines(
                "Robie",
                &Event::Completed {
                    reply: Some("39916800".into())
                },
                60
            )),
            ["• Completed Robie", "  └ 39916800"]
        );
        assert_eq!(
            text(&event_lines("Robie", &Event::Interrupted, 60)),
            ["• Interrupted Robie"]
        );
        assert_eq!(
            text(&message_lines(true, "Main", "Check Windows too.", 60)),
            ["• From Main", "  └ Check Windows too."]
        );
    }

    #[test]
    fn work_state_changes_pick_their_row() {
        let running = StateUpdate::Running(RunningStateUpdate::new());
        let done = StateUpdate::Idle(IdleStateUpdate::new().stop_reason(StopReason::EndTurn));
        let cancelled =
            StateUpdate::Idle(IdleStateUpdate::new().stop_reason(StopReason::Cancelled));
        assert_eq!(
            Event::for_state(Some(&running), &done, Some("ok".into())),
            Some(Event::Completed {
                reply: Some("ok".into())
            })
        );
        assert_eq!(
            Event::for_state(Some(&running), &cancelled, None),
            Some(Event::Interrupted)
        );
        assert_eq!(
            Event::for_state(Some(&done), &running, None),
            Some(Event::Resumed)
        );
        assert_eq!(Event::for_state(Some(&done), &done, None), None);
        assert_eq!(Event::for_state(None, &running, None), None);
    }

    #[test]
    fn previews_are_one_line_and_bounded() {
        assert_eq!(preview("a\n  b", 10), "a b");
        assert_eq!(preview("abcdef", 4), "abc…");
    }
}
