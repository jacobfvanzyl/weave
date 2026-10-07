//! The popup that completes the agent's advertised slash commands while typing `/name`.
//!
//! Commands are sent as ordinary prompt text; the popup only helps type them.

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Modifier;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::text::Span;
use weave_acp_core::schema::AvailableCommand;
use weave_acp_core::schema::AvailableCommandInput;

use crate::history_cell::dim;
use crate::style;

/// Rows shown at once; the list scrolls to keep the selection visible.
pub const VISIBLE_ROWS: usize = 6;

#[derive(Default)]
pub struct CommandPopup {
    selected: usize,
    /// The composer text when the user dismissed the popup; it stays closed until that changes.
    dismissed_for: Option<String>,
    query: String,
}

/// What a key did to the popup.
pub enum PopupAction<'a> {
    /// Replace the composer text with this command and a space, ready for its input.
    Complete(&'a AvailableCommand),
    /// Send this command now; it takes no input.
    Submit(&'a AvailableCommand),
}

impl CommandPopup {
    /// Commands matching the composer text: prefix matches first, then other subsequence
    /// matches, each in the agent's order. Empty when the popup should be closed.
    pub fn matches<'a>(
        &self,
        text: &str,
        commands: &'a [AvailableCommand],
    ) -> Vec<&'a AvailableCommand> {
        let Some(query) = text.strip_prefix('/') else {
            return Vec::new();
        };
        if query.contains(char::is_whitespace) || self.dismissed_for.as_deref() == Some(text) {
            return Vec::new();
        }
        let query = query.to_lowercase();
        let (prefix, other): (Vec<_>, Vec<_>) = commands
            .iter()
            .filter(|command| is_subsequence(&query, &command.name.to_lowercase()))
            .partition(|command| command.name.to_lowercase().starts_with(&query));
        prefix.into_iter().chain(other).collect()
    }

    /// Keep the selection valid as the query changes.
    pub fn sync(&mut self, text: &str, matches: usize) {
        if self.query != text {
            self.query = text.to_owned();
            self.selected = 0;
        }
        if self
            .dismissed_for
            .as_deref()
            .is_some_and(|dismissed| dismissed != text)
        {
            self.dismissed_for = None;
        }
        self.selected = self.selected.min(matches.saturating_sub(1));
    }

    pub fn move_selection(&mut self, delta: isize, matches: usize) {
        if matches == 0 {
            return;
        }
        let next = (self.selected as isize + delta).rem_euclid(matches as isize);
        self.selected = usize::try_from(next).unwrap_or(0);
    }

    pub fn dismiss(&mut self, text: &str) {
        self.dismissed_for = Some(text.to_owned());
    }

    /// Tab completes; Enter completes a command that takes input and submits one that doesn't.
    pub fn accept<'a>(
        &self,
        matches: &[&'a AvailableCommand],
        submit: bool,
    ) -> Option<PopupAction<'a>> {
        let command = *matches.get(self.selected)?;
        Some(if submit && command.input.is_none() {
            PopupAction::Submit(command)
        } else {
            PopupAction::Complete(command)
        })
    }

    pub fn height(matches: usize) -> u16 {
        u16::try_from(matches.min(VISIBLE_ROWS)).unwrap_or(0)
    }

    pub fn render(&self, matches: &[&AvailableCommand], area: Rect, buf: &mut Buffer) {
        let first = self.selected.saturating_sub(VISIBLE_ROWS - 1);
        let name_width = matches
            .iter()
            .map(|command| command.name.chars().count())
            .max()
            .unwrap_or(0)
            + 1;
        for (row, (index, command)) in matches
            .iter()
            .enumerate()
            .skip(first)
            .take(VISIBLE_ROWS)
            .enumerate()
        {
            let selected = index == self.selected;
            let style = Style::default().add_modifier(Modifier::BOLD);
            let marker = if selected { "› " } else { "  " };
            let description = if selected {
                Style::default()
            } else {
                dim()
            };
            let mut line = Line::from(vec![
                Span::styled(format!("{marker}/{:<name_width$}", command.name), style),
                Span::styled(format!(" {}", command.description), description),
            ]);
            if selected {
                line = line.style(style::selection());
            }
            let y = area.y + u16::try_from(row).unwrap_or(0);
            if y < area.bottom() {
                style::set_line_filled(buf, area.x, y, &line, area.width);
            }
        }
    }
}

/// The hint for a command's input, shown after `/name ` until the user types it.
pub fn input_hint(command: &AvailableCommand) -> Option<&str> {
    match command.input.as_ref()? {
        AvailableCommandInput::Unstructured(input) => Some(input.hint.as_str()),
        _ => None,
    }
}

fn is_subsequence(needle: &str, haystack: &str) -> bool {
    let mut haystack = haystack.chars();
    needle.chars().all(|ch| haystack.any(|other| other == ch))
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    fn commands() -> Vec<AvailableCommand> {
        vec![
            AvailableCommand::new("review", "Review changes"),
            AvailableCommand::new("plan", "Plan work"),
            AvailableCommand::new("prompts", "List prompts"),
        ]
    }

    fn names(matches: &[&AvailableCommand]) -> Vec<String> {
        matches.iter().map(|command| command.name.clone()).collect()
    }

    #[test]
    fn prefix_matches_rank_before_subsequence_matches() {
        let commands = commands();
        let popup = CommandPopup::default();
        assert_eq!(names(&popup.matches("/p", &commands)), ["plan", "prompts"]);
        assert_eq!(names(&popup.matches("/rv", &commands)), ["review"]);
        assert_eq!(
            names(&popup.matches("/", &commands)),
            ["review", "plan", "prompts"]
        );
    }

    #[test]
    fn closes_once_arguments_start_or_when_dismissed() {
        let commands = commands();
        let mut popup = CommandPopup::default();
        assert!(popup.matches("/plan now", &commands).is_empty());
        assert!(popup.matches("plan", &commands).is_empty());
        popup.dismiss("/pl");
        assert!(popup.matches("/pl", &commands).is_empty());
        popup.sync("/pla", 1);
        assert_eq!(names(&popup.matches("/pla", &commands)), ["plan"]);
    }

    #[test]
    fn enter_submits_commands_without_input_and_completes_the_rest() {
        let commands = vec![
            AvailableCommand::new("plan", "Plan"),
            AvailableCommand::new("run", "Run").input(AvailableCommandInput::Unstructured(
                weave_acp_core::schema::UnstructuredCommandInput::new("command"),
            )),
        ];
        let mut popup = CommandPopup::default();
        let matches = popup.matches("/", &commands);
        assert!(
            matches!(popup.accept(&matches, true), Some(PopupAction::Submit(command)) if command.name == "plan")
        );
        popup.move_selection(1, matches.len());
        assert!(
            matches!(popup.accept(&matches, true), Some(PopupAction::Complete(command)) if command.name == "run")
        );
        assert_eq!(input_hint(matches[1]), Some("command"));
    }
}
