//! The prompt editor: multi-line text with readline-style editing and submission history,
//! or, when enabled, Vim editing (`vim.rs`) with relative line numbers, for longer drafts.

use std::cell::Cell;
use std::ops::Range;

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
use crate::vim::CursorShape;
use crate::vim::Mode;
use crate::vim::Outcome;
use crate::vim::Vim;

const PROMPT: &str = "› ";
const PROMPT_WIDTH: u16 = 2;
/// A shaded row above and below the text, as in Codex's composer.
const BOX_PADDING: u16 = 1;
/// A column kept clear at the box's right edge.
const RIGHT_MARGIN: u16 = 1;
/// Rows the composer may grow to before it scrolls.
const MAX_ROWS: usize = 8;
/// The Vim composer's limits, as a share of the screen: at most 12 rows or 40% of it.
const VIM_MAX_ROWS: usize = 12;
const VIM_MIN_ROWS: usize = 3;
/// Rows kept in view above and below the cursor while scrolling, as Vim's `scrolloff`.
const SCROLL_OFF: usize = 2;

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
    /// Vim editing, while the draft is in the Vim composer.
    vim: Option<Vim>,
    /// Whether a new line moves the draft into the Vim composer (`[tui] vim = true`).
    vim_available: bool,
    /// How many rows the Vim composer may take, from the screen's height.
    vim_rows: usize,
    /// The Vim composer's first visible row, kept between frames as it scrolls.
    scroll: Cell<usize>,
}

/// One row of the Vim composer: the logical line it shows part of, and which bytes.
struct VimRow {
    line: usize,
    first: bool,
    range: Range<usize>,
}

/// The Vim composer drawn into an area: where the cursor goes, and how many lines are out
/// of view above and below.
struct VimView {
    cursor: Position,
    above: usize,
    below: usize,
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
        if self.vim.is_some() {
            self.vim = Some(Vim::new(Mode::Insert));
        }
    }

    /// Let a new line move the draft into the Vim composer.
    pub fn set_vim_available(&mut self, available: bool) {
        self.vim_available = available;
    }

    /// Size the Vim composer for a screen `height` rows tall.
    pub fn set_screen_height(&mut self, height: u16) {
        self.vim_rows = (usize::from(height) * 2 / 5).clamp(VIM_MIN_ROWS, VIM_MAX_ROWS);
    }

    pub fn is_vim(&self) -> bool {
        self.vim.is_some()
    }

    pub fn vim(&self) -> Option<&Vim> {
        self.vim.as_ref()
    }

    /// Move the draft into the Vim composer, in Insert mode, keeping its text.
    pub fn enter_vim(&mut self) {
        if self.vim.is_none() {
            self.shell = false;
            self.browsing = None;
            self.scroll.set(0);
            self.vim = Some(Vim::new(Mode::Insert));
        }
    }

    pub fn leave_vim(&mut self) {
        self.vim = None;
    }

    pub fn toggle_vim(&mut self) {
        if self.vim.is_some() {
            self.leave_vim();
        } else {
            self.enter_vim();
        }
    }

    /// Whether slash commands and `@` mentions complete as they're typed: always in the
    /// basic composer, and in Insert mode in the Vim one.
    pub fn completes(&self) -> bool {
        self.vim
            .as_ref()
            .is_none_or(|vim| vim.mode() == Mode::Insert)
    }

    /// The terminal cursor the Vim composer wants, or `None` for the terminal's own.
    pub fn cursor_shape(&self) -> Option<CursorShape> {
        self.vim.as_ref().map(Vim::cursor_shape)
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
        self.note_edit();
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

    /// An edit from outside the editor (a paste or a completion), for Vim's undo.
    fn note_edit(&mut self) {
        if let Some(vim) = &mut self.vim {
            vim.before_external_edit(&self.text, self.cursor);
        }
    }

    pub fn insert_str(&mut self, text: &str) {
        self.note_edit();
        let text = text.replace("\r\n", "\n").replace('\r', "\n");
        self.text.insert_str(self.cursor, &text);
        self.cursor += text.len();
    }

    pub fn handle_key(&mut self, key: KeyEvent) -> ComposerAction {
        if let Some(vim) = &mut self.vim {
            return match vim.handle_key(&mut self.text, &mut self.cursor, key) {
                Outcome::Submit => self.submit(),
                Outcome::HistoryPrevious => {
                    self.browse_history(-1);
                    self.cursor = 0;
                    ComposerAction::None
                }
                Outcome::HistoryNext => {
                    self.browse_history(1);
                    self.cursor = 0;
                    ComposerAction::None
                }
                Outcome::Handled => ComposerAction::None,
            };
        }
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
                self.new_line();
            }
            KeyCode::Char('j') if ctrl => self.new_line(),
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

    /// A new line in the basic composer, which moves a growing draft into the Vim composer
    /// when it's available.
    fn new_line(&mut self) {
        if self.vim_available && !self.shell {
            self.enter_vim();
        }
        self.insert_str("\n");
    }

    fn submit(&mut self) -> ComposerAction {
        if self.text.trim().is_empty() {
            return ComposerAction::None;
        }
        let text = std::mem::take(&mut self.text);
        self.cursor = 0;
        self.browsing = None;
        // The next draft, a reply, starts in the basic composer.
        self.vim = None;
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
        let rows = if self.vim.is_some() {
            let (rows, _) = self.vim_layout(width);
            let cap = if self.vim_rows == 0 {
                VIM_MAX_ROWS
            } else {
                self.vim_rows
            };
            rows.len().min(cap)
        } else {
            let (rows, _) = self.layout(width);
            rows.len().min(MAX_ROWS)
        };
        u16::try_from(rows).unwrap_or(1)
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
        if self.vim.is_none() {
            return self.render(inner, buf, hint);
        }
        let view = self.render_vim(inner, buf);
        // Lines scrolled out of view are counted in the padding rows.
        if padding > 0 {
            let marker = |count: usize, arrow: &str| {
                Line::from(Span::styled(format!("{arrow} {count} more  "), dim()))
            };
            if view.above > 0 {
                let line = marker(view.above, "↑");
                draw_right(buf, area, area.y, &line);
            }
            if view.below > 0 {
                let line = marker(view.below, "↓");
                draw_right(buf, area, area.bottom() - 1, &line);
            }
        }
        view.cursor
    }

    /// The Vim composer's rows at `width`, after a gutter of line numbers, and the gutter's
    /// width.
    fn vim_layout(&self, width: u16) -> (Vec<VimRow>, u16) {
        let lines = self.text.matches('\n').count() + 1;
        let digits = lines.to_string().len().max(2);
        let gutter = u16::try_from(digits + 1).unwrap_or(3);
        let content_width = usize::from(width.saturating_sub(gutter).max(1));
        let mut rows = Vec::new();
        let mut start = 0;
        for (line, text) in self.text.split('\n').enumerate() {
            let mut row_start = start;
            let mut column = 0;
            let mut first = true;
            for (offset, grapheme) in text.grapheme_indices(true) {
                let grapheme_width = grapheme.width();
                if column + grapheme_width > content_width && column > 0 {
                    rows.push(VimRow {
                        line,
                        first,
                        range: row_start..start + offset,
                    });
                    first = false;
                    row_start = start + offset;
                    column = 0;
                }
                column += grapheme_width;
            }
            rows.push(VimRow {
                line,
                first,
                range: row_start..start + text.len(),
            });
            start += text.len() + 1;
        }
        (rows, gutter)
    }

    /// Draw the Vim composer: relative line numbers in a gutter (the cursor's line numbered
    /// from the top, as Vim's `number` with `relativenumber` does), the text, and any Visual
    /// selection, scrolled to keep the cursor in view.
    fn render_vim(&self, area: Rect, buf: &mut Buffer) -> VimView {
        let (rows, gutter) = self.vim_layout(area.width);
        let cursor_row = rows
            .iter()
            .rposition(|row| row.range.start <= self.cursor)
            .unwrap_or(0);
        let cursor_line = rows.get(cursor_row).map_or(0, |row| row.line);
        let visible = usize::from(area.height.max(1));
        let off = SCROLL_OFF.min(visible.saturating_sub(1) / 2);
        let mut top = self.scroll.get().min(rows.len().saturating_sub(1));
        if cursor_row < top + off {
            top = cursor_row.saturating_sub(off);
        }
        if cursor_row + off >= top + visible {
            top = cursor_row + off + 1 - visible;
        }
        top = top.min(rows.len().saturating_sub(visible));
        self.scroll.set(top);
        let selection = self
            .vim
            .as_ref()
            .and_then(|vim| vim.selection(&self.text, self.cursor));
        let number_width = usize::from(gutter) - 1;
        for (offset, row) in rows.iter().skip(top).take(visible).enumerate() {
            let y = area.y + u16::try_from(offset).unwrap_or(0);
            let number = if !row.first {
                Span::raw(" ".repeat(usize::from(gutter)))
            } else if row.line == cursor_line {
                Span::styled(
                    format!("{:<number_width$} ", row.line + 1),
                    Style::default().add_modifier(Modifier::BOLD),
                )
            } else {
                Span::styled(
                    format!("{:>number_width$} ", row.line.abs_diff(cursor_line)),
                    dim(),
                )
            };
            let line = Line::from(vec![
                number,
                Span::raw(self.text[row.range.clone()].to_owned()),
            ]);
            buf.set_line(area.x, y, &line, area.width);
            if let Some((selected, _)) = &selection {
                let from = selected.start.max(row.range.start);
                let to = selected.end.min(row.range.end);
                // An empty line inside the selection still shows one selected cell.
                let empty_inside = row.range.is_empty()
                    && selected.start <= row.range.start
                    && row.range.start < selected.end.max(selected.start + 1);
                if from < to || empty_inside {
                    let start = self.text[row.range.start..from.max(row.range.start)].width();
                    let width = if from < to {
                        self.text[from..to].width()
                    } else {
                        1
                    };
                    let x = area.x + gutter + u16::try_from(start).unwrap_or(0);
                    let cells = u16::try_from(width)
                        .unwrap_or(0)
                        .min(area.right().saturating_sub(x));
                    buf.set_style(Rect::new(x, y, cells, 1), style::selection());
                }
            }
        }
        let lines_in = |rows: &[VimRow]| {
            let mut lines: Vec<usize> = rows.iter().map(|row| row.line).collect();
            lines.dedup();
            lines.len()
        };
        let above = lines_in(&rows[..top.min(rows.len())]);
        let below = lines_in(&rows[(top + visible).min(rows.len())..]);
        let column = rows.get(cursor_row).map_or(0, |row| {
            self.text[row.range.start..self.cursor.max(row.range.start)].width()
        });
        let row = u16::try_from(cursor_row - top).unwrap_or(0);
        VimView {
            cursor: Position::new(
                area.x + gutter + u16::try_from(column).unwrap_or(0),
                area.y + row,
            ),
            above,
            below,
        }
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

/// Draw `line` against the right edge of `area` on row `y`.
fn draw_right(buf: &mut Buffer, area: Rect, y: u16, line: &Line<'_>) {
    let width = u16::try_from(line.width()).unwrap_or(u16::MAX);
    if width < area.width {
        buf.set_line(area.right() - width, y, line, width);
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

    fn screen(composer: &Composer, width: u16, height: u16) -> Vec<String> {
        let area = Rect::new(0, 0, width, height);
        let mut buf = Buffer::empty(area);
        composer.render_box(area, &mut buf, None);
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

    #[test]
    fn a_new_line_moves_the_draft_into_vim_when_available() {
        let mut composer = typed("hi");
        composer.handle_key(with(KeyCode::Enter, KeyModifiers::SHIFT));
        assert!(!composer.is_vim());

        let mut composer = typed("hi");
        composer.set_vim_available(true);
        composer.handle_key(with(KeyCode::Enter, KeyModifiers::SHIFT));
        assert!(composer.is_vim());
        assert_eq!(composer.vim().map(Vim::mode), Some(Mode::Insert));
        composer.handle_key(key(KeyCode::Char('x')));
        assert_eq!(composer.text(), "hi\nx");
        // Enter is a new line here; Ctrl+Enter sends, and the reply starts in the basic
        // composer again.
        composer.handle_key(key(KeyCode::Enter));
        assert_eq!(
            composer.handle_key(with(KeyCode::Enter, KeyModifiers::CONTROL)),
            ComposerAction::Submit("hi\nx\n".into())
        );
        assert!(!composer.is_vim());
    }

    #[test]
    fn the_vim_composer_numbers_lines_relative_to_the_cursor() {
        let mut composer = Composer::default();
        composer.enter_vim();
        composer.insert_str("one\ntwo\nthree");
        composer.handle_key(key(KeyCode::Esc));
        composer.handle_key(key(KeyCode::Char('k')));
        assert_eq!(
            screen(&composer, 20, 5),
            ["", " 1 one", "2  two", " 1 three", ""]
        );
        assert_eq!(composer.cursor_shape(), Some(CursorShape::Block));
        assert!(!composer.completes());
        composer.handle_key(key(KeyCode::Char('i')));
        assert_eq!(composer.cursor_shape(), Some(CursorShape::Bar));
        assert!(composer.completes());
    }

    #[test]
    fn the_vim_composer_scrolls_within_its_cap_and_counts_what_is_hidden() {
        let mut composer = Composer::default();
        composer.set_screen_height(20);
        composer.enter_vim();
        let lines: Vec<String> = (1..=20).map(|n| format!("line {n}")).collect();
        composer.insert_str(&lines.join("\n"));
        // 40% of 20 rows.
        assert_eq!(composer.desired_height(40), 8);
        let rows = screen(&composer, 40, 10);
        assert_eq!(rows[0].trim(), "↑ 12 more");
        assert_eq!(rows[8], "20 line 20");
        assert_eq!(rows[9], "");
        // Going to the top keeps the cursor in view and counts the lines below instead.
        composer.handle_key(key(KeyCode::Esc));
        composer.handle_key(key(KeyCode::Char('g')));
        composer.handle_key(key(KeyCode::Char('g')));
        let rows = screen(&composer, 40, 10);
        assert_eq!(rows[1], "1  line 1");
        assert_eq!(rows[9].trim(), "↓ 12 more");
    }

    #[test]
    fn a_visual_selection_is_highlighted() {
        let mut composer = Composer::default();
        composer.enter_vim();
        composer.insert_str("one two");
        composer.handle_key(key(KeyCode::Esc));
        composer.handle_key(key(KeyCode::Char('0')));
        composer.handle_key(key(KeyCode::Char('v')));
        composer.handle_key(key(KeyCode::Char('e')));
        let area = Rect::new(0, 0, 20, 3);
        let mut buf = Buffer::empty(area);
        composer.render_box(area, &mut buf, None);
        let selected: String = (0..20)
            // Without known terminal colors, as in tests, the selection is reversed.
            .filter(|x| buf[(*x, 1)].modifier.contains(Modifier::REVERSED))
            .map(|x| buf[(x, 1)].symbol())
            .collect();
        assert_eq!(selected, "one");
    }

    #[test]
    fn paste_normalizes_line_endings() {
        let mut composer = Composer::default();
        composer.insert_str("a\r\nb\rc");
        assert_eq!(composer.text(), "a\nb\nc");
    }
}
