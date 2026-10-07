//! The prompt editor: multi-line text with readline-style editing and submission history.

use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyModifiers;
use ratatui::buffer::Buffer;
use ratatui::layout::Position;
use ratatui::layout::Rect;
use ratatui::style::Color;
use ratatui::style::Modifier;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::text::Span;
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

use crate::style;
use crate::style::dim;

const PROMPT: &str = "› ";
const PROMPT_WIDTH: u16 = 2;
/// A shaded row above and below the text, as in Codex's composer.
const BOX_PADDING: u16 = 1;
/// A column kept clear at the box's right edge.
const RIGHT_MARGIN: u16 = 1;
/// Rows the composer may grow to before it scrolls.
const MAX_ROWS: usize = 8;

#[derive(Debug, PartialEq, Eq)]
pub enum ComposerAction {
    None,
    Submit(String),
    /// A command to run in the user's shell, from shell mode.
    Shell(String),
}

#[derive(Default)]
pub struct Composer {
    text: String,
    /// Byte offset of the cursor, always on a grapheme boundary.
    cursor: usize,
    history: Vec<String>,
    /// Position while browsing history, and the draft it replaced.
    browsing: Option<(usize, String)>,
    /// Shell mode, entered by typing `!` first, as in Codex: Enter runs the text as a
    /// command instead of sending it.
    shell: bool,
}

impl Composer {
    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn is_empty(&self) -> bool {
        self.text.is_empty()
    }

    pub fn clear(&mut self) {
        self.text.clear();
        self.cursor = 0;
        self.browsing = None;
        self.shell = false;
    }

    /// The whitespace-delimited word ending at the cursor, and where it starts.
    pub fn word_before_cursor(&self) -> (usize, &str) {
        let before = &self.text[..self.cursor];
        let start = before.rfind(char::is_whitespace).map_or(0, |index| {
            index + before[index..].chars().next().map_or(1, char::len_utf8)
        });
        (start, &before[start..])
    }

    /// Replace the text from `start` to the cursor with `text`.
    pub fn replace_before_cursor(&mut self, start: usize, text: &str) {
        self.text.replace_range(start..self.cursor, text);
        self.cursor = start + text.len();
    }

    /// The character just before the cursor.
    pub fn char_before_cursor(&self) -> Option<char> {
        self.text[..self.cursor].chars().next_back()
    }

    pub fn is_shell(&self) -> bool {
        self.shell
    }

    pub fn leave_shell(&mut self) {
        self.shell = false;
    }

    pub fn insert_str(&mut self, text: &str) {
        let text = text.replace("\r\n", "\n").replace('\r', "\n");
        self.text.insert_str(self.cursor, &text);
        self.cursor += text.len();
    }

    pub fn handle_key(&mut self, key: KeyEvent) -> ComposerAction {
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        let alt = key.modifiers.contains(KeyModifiers::ALT);
        // `!` first enters shell mode instead of being typed; Backspace on an empty line
        // leaves it.
        if self.text.is_empty() && !ctrl && !alt {
            match key.code {
                KeyCode::Char('!') if !self.shell => {
                    self.shell = true;
                    return ComposerAction::None;
                }
                KeyCode::Backspace if self.shell => {
                    self.shell = false;
                    return ComposerAction::None;
                }
                _ => {}
            }
        }
        match key.code {
            KeyCode::Enter
                if key
                    .modifiers
                    .intersects(KeyModifiers::SHIFT | KeyModifiers::ALT) =>
            {
                self.insert_str("\n");
            }
            KeyCode::Char('j') if ctrl => self.insert_str("\n"),
            KeyCode::Enter => return self.submit(),
            KeyCode::Char('a') if ctrl => self.cursor = self.line_start(),
            KeyCode::Home => self.cursor = self.line_start(),
            KeyCode::Char('e') if ctrl => self.cursor = self.line_end(),
            KeyCode::End => self.cursor = self.line_end(),
            KeyCode::Char('b') if alt => self.cursor = self.word_start(),
            KeyCode::Char('f') if alt => self.cursor = self.word_end(),
            KeyCode::Left if ctrl || alt => self.cursor = self.word_start(),
            KeyCode::Right if ctrl || alt => self.cursor = self.word_end(),
            KeyCode::Char('b') if ctrl => self.cursor = self.prev_boundary(),
            KeyCode::Left => self.cursor = self.prev_boundary(),
            KeyCode::Char('f') if ctrl => self.cursor = self.next_boundary(),
            KeyCode::Right => self.cursor = self.next_boundary(),
            KeyCode::Char('w') if ctrl => self.delete_back_to(self.word_start()),
            KeyCode::Backspace if alt || ctrl => self.delete_back_to(self.word_start()),
            KeyCode::Backspace => self.delete_back_to(self.prev_boundary()),
            KeyCode::Char('h') if ctrl => self.delete_back_to(self.prev_boundary()),
            KeyCode::Delete => self.delete_forward_to(self.next_boundary()),
            KeyCode::Char('d') if ctrl => self.delete_forward_to(self.next_boundary()),
            KeyCode::Char('u') if ctrl => self.delete_back_to(self.line_start()),
            KeyCode::Char('k') if ctrl => self.delete_forward_to(self.line_end()),
            KeyCode::Up => self.move_vertically(-1),
            KeyCode::Down => self.move_vertically(1),
            KeyCode::Tab => self.insert_str("    "),
            KeyCode::Char(ch) if !ctrl && !alt => {
                let mut buffer = [0; 4];
                self.insert_str(ch.encode_utf8(&mut buffer));
            }
            _ => {}
        }
        ComposerAction::None
    }

    fn submit(&mut self) -> ComposerAction {
        if self.text.trim().is_empty() {
            return ComposerAction::None;
        }
        let text = std::mem::take(&mut self.text);
        self.cursor = 0;
        self.browsing = None;
        if self.history.last() != Some(&text) {
            self.history.push(text.clone());
        }
        if std::mem::take(&mut self.shell) {
            return ComposerAction::Shell(text);
        }
        ComposerAction::Submit(text)
    }

    fn line_start(&self) -> usize {
        self.text[..self.cursor]
            .rfind('\n')
            .map_or(0, |index| index + 1)
    }

    fn line_end(&self) -> usize {
        self.text[self.cursor..]
            .find('\n')
            .map_or(self.text.len(), |index| self.cursor + index)
    }

    fn prev_boundary(&self) -> usize {
        self.text[..self.cursor]
            .grapheme_indices(true)
            .next_back()
            .map_or(0, |(index, _)| index)
    }

    fn next_boundary(&self) -> usize {
        self.text[self.cursor..]
            .graphemes(true)
            .next()
            .map_or(self.cursor, |grapheme| self.cursor + grapheme.len())
    }

    /// Start of the word before the cursor, skipping whitespace first.
    fn word_start(&self) -> usize {
        let before = &self.text[..self.cursor];
        let trimmed = before.trim_end();
        trimmed.rfind(char::is_whitespace).map_or(0, |index| {
            index + trimmed[index..].chars().next().map_or(1, char::len_utf8)
        })
    }

    /// End of the word after the cursor, skipping whitespace first.
    fn word_end(&self) -> usize {
        let after = &self.text[self.cursor..];
        let skipped = after.len() - after.trim_start().len();
        let rest = &after[skipped..];
        self.cursor + skipped + rest.find(char::is_whitespace).unwrap_or(rest.len())
    }

    fn delete_back_to(&mut self, start: usize) {
        self.text.replace_range(start..self.cursor, "");
        self.cursor = start;
    }

    fn delete_forward_to(&mut self, end: usize) {
        self.text.replace_range(self.cursor..end, "");
    }

    /// Move to the neighbouring source line at the same column, or through submission
    /// history when already on the first or last line.
    fn move_vertically(&mut self, direction: isize) {
        let start = self.line_start();
        let column = self.text[start..self.cursor].graphemes(true).count();
        let target_start = if direction < 0 {
            if start == 0 {
                return self.browse_history(-1);
            }
            self.text[..start - 1]
                .rfind('\n')
                .map_or(0, |index| index + 1)
        } else {
            let end = self.line_end();
            if end == self.text.len() {
                return self.browse_history(1);
            }
            end + 1
        };
        let target_end = self.text[target_start..]
            .find('\n')
            .map_or(self.text.len(), |index| target_start + index);
        self.cursor = self.text[target_start..target_end]
            .grapheme_indices(true)
            .nth(column)
            .map_or(target_end, |(index, _)| target_start + index);
    }

    fn browse_history(&mut self, direction: isize) {
        let next = match (&self.browsing, direction < 0) {
            (None, true) if !self.history.is_empty() => Some(self.history.len() - 1),
            (Some((index, _)), true) => Some(index.saturating_sub(1)),
            (Some((index, _)), false) => Some(index + 1),
            _ => return,
        };
        let Some(next) = next else {
            return;
        };
        let draft = match self.browsing.take() {
            Some((_, draft)) => draft,
            None => self.text.clone(),
        };
        if next >= self.history.len() {
            self.text = draft;
        } else {
            self.text = self.history[next].clone();
            self.browsing = Some((next, draft));
        }
        self.cursor = self.text.len();
    }

    /// Wrapped display rows and the cursor's (row, column) within them.
    fn layout(&self, width: u16) -> (Vec<String>, (usize, u16)) {
        let content_width = width.saturating_sub(PROMPT_WIDTH).max(1);
        let mut rows = vec![String::new()];
        let mut column: u16 = 0;
        let mut cursor = (0, 0);
        for (index, grapheme) in self.text.grapheme_indices(true) {
            if index == self.cursor {
                cursor = (rows.len() - 1, column);
            }
            if grapheme == "\n" {
                rows.push(String::new());
                column = 0;
                continue;
            }
            let grapheme_width = u16::try_from(grapheme.width()).unwrap_or(1);
            if column + grapheme_width > content_width {
                rows.push(String::new());
                column = 0;
            }
            if let Some(row) = rows.last_mut() {
                row.push_str(grapheme);
            }
            column += grapheme_width;
        }
        if self.cursor >= self.text.len() {
            if column >= content_width {
                rows.push(String::new());
                column = 0;
            }
            cursor = (rows.len() - 1, column);
        }
        (rows, cursor)
    }

    pub fn desired_height(&self, width: u16) -> u16 {
        let (rows, _) = self.layout(width);
        u16::try_from(rows.len().min(MAX_ROWS)).unwrap_or(1)
    }

    /// Height of the shaded box at `width`: the text rows plus padding.
    pub fn box_height(&self, width: u16) -> u16 {
        self.desired_height(width.saturating_sub(RIGHT_MARGIN)) + 2 * BOX_PADDING
    }

    /// Draw the composer as Codex does, in a box shaded from the terminal's background with
    /// a row of padding above and below. Returns where the terminal cursor belongs.
    pub fn render_box(&self, area: Rect, buf: &mut Buffer, hint: Option<&str>) -> Position {
        buf.set_style(area, style::composer());
        // Space for the text comes first when the screen is too short for the padding.
        let padding = if area.height > 2 * BOX_PADDING {
            BOX_PADDING
        } else {
            0
        };
        let inner = Rect::new(
            area.x,
            area.y + padding,
            area.width.saturating_sub(RIGHT_MARGIN),
            area.height - 2 * padding,
        );
        self.render(inner, buf, hint)
    }

    /// Draw into `area` and return where the terminal cursor belongs. `hint` is shown dimmed
    /// after single-line text, such as the input a slash command expects. An empty composer
    /// shows only the prompt, except in shell mode, which says what it runs.
    pub fn render(&self, area: Rect, buf: &mut Buffer, hint: Option<&str>) -> Position {
        let prompt = if self.shell {
            Span::styled(
                "! ",
                Style::default()
                    .fg(Color::LightRed)
                    .add_modifier(Modifier::BOLD),
            )
        } else {
            Span::styled(PROMPT, Style::default().add_modifier(Modifier::BOLD))
        };
        if self.text.is_empty() {
            let placeholder = if self.shell {
                "Run a shell command"
            } else {
                ""
            };
            let line = Line::from(vec![prompt, Span::styled(placeholder, dim())]);
            buf.set_line(area.x, area.y, &line, area.width);
            return Position::new(area.x + PROMPT_WIDTH, area.y);
        }
        let (rows, (cursor_row, cursor_column)) = self.layout(area.width);
        let visible = usize::from(area.height.max(1));
        let first_visible = cursor_row.saturating_sub(visible - 1);
        for (offset, row) in rows.iter().skip(first_visible).take(visible).enumerate() {
            let index = first_visible + offset;
            let lead = if index == 0 {
                prompt.clone()
            } else {
                Span::raw("  ")
            };
            let mut spans = vec![lead, Span::raw(row.clone())];
            if let Some(hint) = hint
                && rows.len() == 1
            {
                spans.push(Span::styled(hint.to_owned(), dim()));
            }
            let line = Line::from(spans);
            let y = area.y + u16::try_from(offset).unwrap_or(0);
            buf.set_line(area.x, y, &line, area.width);
        }
        let row = u16::try_from(cursor_row - first_visible).unwrap_or(0);
        Position::new(area.x + PROMPT_WIDTH + cursor_column, area.y + row)
    }
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    fn with(code: KeyCode, modifiers: KeyModifiers) -> KeyEvent {
        KeyEvent::new(code, modifiers)
    }

    fn typed(text: &str) -> Composer {
        let mut composer = Composer::default();
        for ch in text.chars() {
            composer.handle_key(key(KeyCode::Char(ch)));
        }
        composer
    }

    #[test]
    fn enter_submits_and_shift_enter_adds_a_line() {
        let mut composer = typed("hi");
        composer.handle_key(with(KeyCode::Enter, KeyModifiers::SHIFT));
        composer.handle_key(key(KeyCode::Char('x')));
        assert_eq!(
            composer.handle_key(key(KeyCode::Enter)),
            ComposerAction::Submit("hi\nx".into())
        );
        assert!(composer.is_empty());
    }

    #[test]
    fn blank_input_is_not_submitted() {
        let mut composer = typed("   ");
        assert_eq!(
            composer.handle_key(key(KeyCode::Enter)),
            ComposerAction::None
        );
    }

    #[test]
    fn word_editing() {
        let mut composer = typed("one two three");
        composer.handle_key(with(KeyCode::Char('w'), KeyModifiers::CONTROL));
        assert_eq!(composer.text(), "one two ");
        composer.handle_key(with(KeyCode::Char('b'), KeyModifiers::ALT));
        composer.handle_key(with(KeyCode::Char('k'), KeyModifiers::CONTROL));
        assert_eq!(composer.text(), "one ");
    }

    #[test]
    fn up_and_down_recall_history_and_restore_the_draft() {
        let mut composer = typed("first");
        composer.handle_key(key(KeyCode::Enter));
        for ch in "draft".chars() {
            composer.handle_key(key(KeyCode::Char(ch)));
        }
        composer.handle_key(key(KeyCode::Up));
        assert_eq!(composer.text(), "first");
        composer.handle_key(key(KeyCode::Down));
        assert_eq!(composer.text(), "draft");
    }

    #[test]
    fn cursor_follows_wrapping() {
        let composer = typed("abcdefgh");
        let (rows, cursor) = composer.layout(6);
        assert_eq!(rows, ["abcd", "efgh", ""]);
        assert_eq!(cursor, (2, 0));
    }

    #[test]
    fn paste_normalizes_line_endings() {
        let mut composer = Composer::default();
        composer.insert_str("a\r\nb\rc");
        assert_eq!(composer.text(), "a\nb\nc");
    }
}
