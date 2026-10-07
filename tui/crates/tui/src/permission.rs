//! The `session/request_permission` prompt that replaces the composer while it is open,
//! drawn as Codex's approval dialog (`codex-rs/tui/src/bottom_pane/approval_overlay.rs`,
//! Apache-2.0): a bold question, what it is about (the command, the edits), numbered options
//! with letter shortcuts, and how to confirm.

use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Modifier;
use ratatui::style::Style;
use ratatui::style::Stylize;
use ratatui::text::Line;
use ratatui::text::Span;
use weave_acp_core::schema::PermissionOption;
use weave_acp_core::schema::PermissionOptionId;
use weave_acp_core::schema::PermissionOptionKind;

use crate::style;
use crate::wrapping::wrap_with_prefix;

#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    Select(PermissionOptionId),
    /// Nothing to reject with: the user wants the whole turn stopped.
    CancelTurn,
}

/// What a permission prompt asks about.
#[derive(Clone, Debug, Default)]
pub struct Subject {
    /// "Would you like to run the following command?"
    pub question: String,
    /// The command, the edits or the target, shown under the question.
    pub detail: Vec<Line<'static>>,
}

impl Subject {
    pub fn about(title: &str) -> Self {
        Self {
            question: format!("Would you like to allow {title}?"),
            detail: Vec::new(),
        }
    }
}

pub struct PermissionView {
    subject: Subject,
    options: Vec<PermissionOption>,
    selected: usize,
}

impl PermissionView {
    pub fn new(subject: Subject, options: Vec<PermissionOption>) -> Self {
        Self {
            subject,
            options,
            selected: 0,
        }
    }

    pub fn handle_key(&mut self, key: KeyEvent) -> Option<Decision> {
        match key.code {
            KeyCode::Up | KeyCode::Char('k') => {
                self.selected = self.selected.saturating_sub(1);
                None
            }
            KeyCode::Down | KeyCode::Char('j') => {
                self.selected = (self.selected + 1).min(self.options.len().saturating_sub(1));
                None
            }
            KeyCode::Enter => self.choose(self.selected),
            KeyCode::Char(digit @ '1'..='9') => {
                let index = digit as usize - '1' as usize;
                (index < self.options.len())
                    .then(|| self.choose(index))
                    .flatten()
            }
            KeyCode::Esc => Some(self.reject()),
            KeyCode::Char(letter) => (0..self.options.len())
                .find(|index| self.shortcut(*index) == Some(Shortcut::Letter(letter)))
                .and_then(|index| self.choose(index)),
            _ => None,
        }
    }

    fn choose(&self, index: usize) -> Option<Decision> {
        self.options
            .get(index)
            .map(|option| Decision::Select(option.option_id.clone()))
    }

    /// Prefer a one-time rejection, then a permanent one.
    fn reject(&self) -> Decision {
        self.reject_index()
            .and_then(|index| self.choose(index))
            .unwrap_or(Decision::CancelTurn)
    }

    fn reject_index(&self) -> Option<usize> {
        [
            PermissionOptionKind::RejectOnce,
            PermissionOptionKind::RejectAlways,
        ]
        .iter()
        .find_map(|kind| self.options.iter().position(|option| option.kind == *kind))
    }

    /// The key for option `index`, as Codex shows it after the option: `y` to allow once,
    /// `a` always, `d` to reject always, and `esc` for the rejection Escape picks.
    fn shortcut(&self, index: usize) -> Option<Shortcut> {
        if Some(index) == self.reject_index() {
            return Some(Shortcut::Escape);
        }
        let kind = self.options.get(index)?.kind;
        let letter = match kind {
            PermissionOptionKind::AllowOnce => 'y',
            PermissionOptionKind::AllowAlways => 'a',
            PermissionOptionKind::RejectAlways => 'd',
            _ => return None,
        };
        // Only the first option of a kind gets its letter.
        let first = self.options.iter().position(|option| option.kind == kind);
        (first == Some(index)).then_some(Shortcut::Letter(letter))
    }

    /// The prompt's rows, with which are the selected option's.
    fn lines(&self, width: usize) -> (Vec<Line<'static>>, std::ops::Range<usize>) {
        let indent = Line::from("  ");
        let mut lines = vec![Line::default()];
        lines.extend(wrap_with_prefix(
            &Line::from(self.subject.question.clone().bold()),
            width,
            &indent,
            &indent,
        ));
        if !self.subject.detail.is_empty() {
            lines.push(Line::default());
            for detail in &self.subject.detail {
                lines.extend(wrap_with_prefix(detail, width, &indent, &indent));
            }
        }
        lines.push(Line::default());
        let mut selected = 0..0;
        for (index, option) in self.options.iter().enumerate() {
            let is_selected = index == self.selected;
            let marker = if is_selected { "› " } else { "  " };
            let first = Line::from(format!("{marker}{}. ", index + 1));
            let mut content = vec![Span::raw(option.name.clone())];
            match self.shortcut(index) {
                Some(Shortcut::Letter(letter)) => {
                    content.push(Span::raw(" ("));
                    content.push(letter.to_string().bold());
                    content.push(Span::raw(")"));
                }
                Some(Shortcut::Escape) => {
                    content.push(Span::raw(" ("));
                    content.push("esc".bold());
                    content.push(Span::raw(")"));
                }
                None => {}
            }
            let start = lines.len();
            let rows = wrap_with_prefix(&Line::from(content), width, &first, &Line::from("     "));
            lines.extend(rows.into_iter().map(|row| {
                if is_selected {
                    row.style(style::selection())
                } else {
                    row
                }
            }));
            if is_selected {
                selected = start..lines.len();
            }
        }
        lines.push(Line::default());
        let escape = match self.reject() {
            Decision::Select(_) => " to cancel",
            Decision::CancelTurn => " to stop the turn",
        };
        lines.push(Line::from(vec![
            Span::styled("  Press ", style::secondary()),
            Span::styled("enter", Style::default().add_modifier(Modifier::BOLD)),
            Span::styled(" to confirm or ", style::secondary()),
            Span::styled("esc", Style::default().add_modifier(Modifier::BOLD)),
            Span::styled(escape, style::secondary()),
        ]));
        (lines, selected)
    }

    pub fn desired_height(&self, width: u16) -> u16 {
        u16::try_from(self.lines(usize::from(width)).0.len()).unwrap_or(u16::MAX)
    }

    pub fn render(&self, area: Rect, buf: &mut Buffer) {
        let (lines, _) = self.lines(usize::from(area.width));
        for (line, y) in lines.iter().zip(area.y..area.bottom()) {
            style::set_line_filled(buf, area.x, y, line, area.width);
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Shortcut {
    Letter(char),
    Escape,
}

#[cfg(test)]
mod tests {
    use crossterm::event::KeyModifiers;
    use pretty_assertions::assert_eq;

    use super::*;

    fn options() -> Vec<PermissionOption> {
        vec![
            PermissionOption::new("allow", "Yes", PermissionOptionKind::AllowOnce),
            PermissionOption::new("always", "Always", PermissionOptionKind::AllowAlways),
            PermissionOption::new("deny", "No", PermissionOptionKind::RejectOnce),
        ]
    }

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    #[test]
    fn arrows_and_enter_choose_an_option() {
        let mut view = PermissionView::new(Subject::about("Write a.txt"), options());
        assert_eq!(view.handle_key(key(KeyCode::Down)), None);
        assert_eq!(
            view.handle_key(key(KeyCode::Enter)),
            Some(Decision::Select("always".into()))
        );
    }

    #[test]
    fn digits_choose_directly_and_escape_rejects() {
        let mut view = PermissionView::new(Subject::about("Write a.txt"), options());
        assert_eq!(
            view.handle_key(key(KeyCode::Char('1'))),
            Some(Decision::Select("allow".into()))
        );
        assert_eq!(
            view.handle_key(key(KeyCode::Esc)),
            Some(Decision::Select("deny".into()))
        );
        assert_eq!(view.handle_key(key(KeyCode::Char('9'))), None);
    }

    #[test]
    fn escape_without_a_reject_option_stops_the_turn() {
        let mut view = PermissionView::new(
            Subject::about("Run"),
            vec![PermissionOption::new(
                "ok",
                "Yes",
                PermissionOptionKind::AllowOnce,
            )],
        );
        assert_eq!(
            view.handle_key(key(KeyCode::Esc)),
            Some(Decision::CancelTurn)
        );
    }

    #[test]
    fn letters_pick_options_as_codex_labels_them() {
        let mut view = PermissionView::new(Subject::about("Run"), options());
        assert_eq!(
            view.handle_key(key(KeyCode::Char('a'))),
            Some(Decision::Select("always".into()))
        );
        let (lines, selected) = view.lines(60);
        let text: Vec<String> = lines.iter().map(|line| line.to_string().trim_end().to_owned()).collect();
        assert_eq!(
            text,
            [
                "",
                "  Would you like to allow Run?",
                "",
                "› 1. Yes (y)",
                "  2. Always (a)",
                "  3. No (esc)",
                "",
                "  Press enter to confirm or esc to cancel"
            ]
        );
        assert_eq!(selected, 3..4);
    }
}
