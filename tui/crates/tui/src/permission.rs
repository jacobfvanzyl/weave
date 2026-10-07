//! The `session/request_permission` prompt that replaces the composer while it is open.

use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Color;
use ratatui::style::Modifier;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::text::Span;
use weave_acp_core::schema::PermissionOption;
use weave_acp_core::schema::PermissionOptionId;
use weave_acp_core::schema::PermissionOptionKind;

use crate::history_cell::dim;
use crate::wrapping::wrap_with_prefix;

#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    Select(PermissionOptionId),
    /// Nothing to reject with: the user wants the whole turn stopped.
    CancelTurn,
}

pub struct PermissionView {
    title: String,
    options: Vec<PermissionOption>,
    selected: usize,
}

impl PermissionView {
    pub fn new(title: String, options: Vec<PermissionOption>) -> Self {
        Self {
            title,
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
        [
            PermissionOptionKind::RejectOnce,
            PermissionOptionKind::RejectAlways,
        ]
        .iter()
        .find_map(|kind| self.options.iter().find(|option| option.kind == *kind))
        .map_or(Decision::CancelTurn, |option| {
            Decision::Select(option.option_id.clone())
        })
    }

    fn lines(&self, width: usize) -> Vec<Line<'static>> {
        let heading = Line::from(vec![
            Span::styled("Allow ", Style::default().add_modifier(Modifier::BOLD)),
            Span::styled(
                self.title.clone(),
                Style::default()
                    .fg(Color::Cyan)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled("?", Style::default().add_modifier(Modifier::BOLD)),
        ]);
        let mut lines = wrap_with_prefix(&heading, width, &Line::from("  "), &Line::from("  "));
        for (index, option) in self.options.iter().enumerate() {
            let selected = index == self.selected;
            let style = if selected {
                Style::default()
                    .fg(Color::Cyan)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default()
            };
            let marker = if selected { "› " } else { "  " };
            let first = Line::from(Span::styled(format!("{marker}{}. ", index + 1), style));
            let content = Line::from(Span::styled(option.name.clone(), style));
            lines.extend(wrap_with_prefix(
                &content,
                width,
                &first,
                &Line::from("     "),
            ));
        }
        let escape = match self.reject() {
            Decision::Select(_) => "esc reject",
            Decision::CancelTurn => "esc stop turn",
        };
        lines.push(Line::from(Span::styled(
            format!("  ↑↓ choose · enter confirm · {escape}"),
            dim(),
        )));
        lines
    }

    pub fn desired_height(&self, width: u16) -> u16 {
        u16::try_from(self.lines(usize::from(width)).len()).unwrap_or(u16::MAX)
    }

    pub fn render(&self, area: Rect, buf: &mut Buffer) {
        for (line, y) in self
            .lines(usize::from(area.width))
            .iter()
            .zip(area.y..area.bottom())
        {
            buf.set_line(area.x, y, line, area.width);
        }
    }
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
        let mut view = PermissionView::new("Write a.txt".into(), options());
        assert_eq!(view.handle_key(key(KeyCode::Down)), None);
        assert_eq!(
            view.handle_key(key(KeyCode::Enter)),
            Some(Decision::Select("always".into()))
        );
    }

    #[test]
    fn digits_choose_directly_and_escape_rejects() {
        let mut view = PermissionView::new("Write a.txt".into(), options());
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
            "Run".into(),
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
}
