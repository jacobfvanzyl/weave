//! Writes finished history above the viewport, into the terminal's own scrollback.
//!
//! Adapted from openai/codex `codex-rs/tui/src/insert_history.rs` (Apache-2.0). History is
//! inserted with escape sequences rather than a ratatui render: a scroll region limited to the
//! rows above the viewport lets new lines push older ones into native scrollback while the
//! viewport stays put.

use std::fmt;
use std::io;
use std::io::Write;

use crossterm::Command;
use crossterm::cursor::MoveTo;
use crossterm::queue;
use crossterm::style::Attribute;
use crossterm::style::Print;
use crossterm::style::SetAttribute;
use crossterm::style::SetBackgroundColor;
use crossterm::style::SetForegroundColor;
use crossterm::terminal::Clear;
use crossterm::terminal::ClearType;
use ratatui::backend::Backend;
use ratatui::backend::IntoCrossterm;
use ratatui::style::Modifier;
use ratatui::style::Style;
use ratatui::text::Line;

use crate::custom_terminal::Terminal;

/// Insert `lines` above the viewport. Lines must already fit the viewport width.
pub fn insert_history_lines<B>(
    terminal: &mut Terminal<B>,
    lines: &[Line<'static>],
) -> io::Result<()>
where
    B: Backend<Error = io::Error> + Write,
{
    if lines.is_empty() {
        return Ok(());
    }
    let screen = terminal.size()?;
    let mut area = terminal.viewport_area;
    let restore = terminal.last_known_cursor_pos;
    let writer = terminal.backend_mut();
    let mut remaining = lines;

    // While the viewport is not yet at the bottom of the screen, move it down instead of
    // scrolling anything into scrollback, and write the first lines into the freed rows.
    if area.bottom() < screen.height {
        let room = usize::from(screen.height - area.bottom()).min(lines.len());
        let room_rows = u16::try_from(room).unwrap_or(u16::MAX);
        queue!(
            writer,
            SetScrollRegion(area.top() + 1..screen.height),
            MoveTo(0, area.top())
        )?;
        for _ in 0..room_rows {
            // Reverse index at the top margin scrolls the region down by one row.
            queue!(writer, Print("\x1bM"))?;
        }
        queue!(writer, ResetScrollRegion)?;
        for (row, line) in (area.top()..).zip(&lines[..room]) {
            queue!(writer, MoveTo(0, row))?;
            write_line(writer, line)?;
        }
        area.y += room_rows;
        remaining = &lines[room..];
    }

    // ┌─Screen───────────────────────┐
    // │┌╌Scroll region╌╌╌╌╌╌╌╌╌╌╌╌╌╌┐│  With the viewport at the bottom, the rest are
    // │┆                            ┆│  written at the bottom of a region above it, so
    // │█╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┘│  older rows scroll off the top into scrollback.
    // │╭─Viewport───────────────────╮│
    // │╰────────────────────────────╯│
    // └──────────────────────────────┘
    if !remaining.is_empty() {
        // A region needs at least two rows; callers keep that much room above the viewport.
        if area.top() >= 2 {
            queue!(
                writer,
                SetScrollRegion(1..area.top()),
                MoveTo(0, area.top() - 1)
            )?;
            for line in remaining {
                queue!(writer, Print("\r\n"))?;
                write_line(writer, line)?;
            }
            queue!(writer, ResetScrollRegion)?;
        } else if let Some(line) = remaining.last() {
            queue!(writer, MoveTo(0, 0))?;
            write_line(writer, line)?;
        }
    }
    queue!(writer, MoveTo(restore.x, restore.y))?;

    if area != terminal.viewport_area {
        terminal.set_viewport_area(area);
    }
    Ok(())
}

/// Scroll the rows above the viewport up by `rows`, pushing the oldest into scrollback, so the
/// viewport can grow upward into the freed space.
pub fn make_room_above<B>(
    terminal: &mut Terminal<B>,
    viewport_top: u16,
    rows: u16,
) -> io::Result<()>
where
    B: Backend<Error = io::Error> + Write,
{
    if rows == 0 || viewport_top < 2 {
        return Ok(());
    }
    let restore = terminal.last_known_cursor_pos;
    let writer = terminal.backend_mut();
    queue!(
        writer,
        SetScrollRegion(1..viewport_top),
        MoveTo(0, viewport_top - 1)
    )?;
    for _ in 0..rows {
        queue!(writer, Print("\r\n"))?;
    }
    queue!(writer, ResetScrollRegion, MoveTo(restore.x, restore.y))?;
    Ok(())
}

fn write_line<W: Write>(writer: &mut W, line: &Line<'_>) -> io::Result<()> {
    queue!(
        writer,
        SetAttribute(Attribute::Reset),
        Clear(ClearType::UntilNewLine)
    )?;
    for span in &line.spans {
        apply_style(writer, line.style.patch(span.style))?;
        // History bypasses ratatui's buffer, so filter control characters here: agent output
        // is untrusted and must not be able to emit escape sequences.
        let text: String = span.content.chars().filter(|c| !c.is_control()).collect();
        queue!(writer, Print(text), SetAttribute(Attribute::Reset))?;
    }
    Ok(())
}

fn apply_style<W: Write>(writer: &mut W, style: Style) -> io::Result<()> {
    if let Some(fg) = style.fg {
        queue!(writer, SetForegroundColor(fg.into_crossterm()))?;
    }
    if let Some(bg) = style.bg {
        queue!(writer, SetBackgroundColor(bg.into_crossterm()))?;
    }
    let modifiers = style.add_modifier - style.sub_modifier;
    for (modifier, attribute) in [
        (Modifier::BOLD, Attribute::Bold),
        (Modifier::DIM, Attribute::Dim),
        (Modifier::ITALIC, Attribute::Italic),
        (Modifier::UNDERLINED, Attribute::Underlined),
        (Modifier::REVERSED, Attribute::Reverse),
        (Modifier::CROSSED_OUT, Attribute::CrossedOut),
    ] {
        if modifiers.contains(modifier) {
            queue!(writer, SetAttribute(attribute))?;
        }
    }
    Ok(())
}

/// DECSTBM: limit scrolling to rows `start..=end` (1-based, inclusive).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SetScrollRegion(pub std::ops::Range<u16>);

impl Command for SetScrollRegion {
    fn write_ansi(&self, f: &mut impl fmt::Write) -> fmt::Result {
        write!(f, "\x1b[{};{}r", self.0.start, self.0.end)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResetScrollRegion;

impl Command for ResetScrollRegion {
    fn write_ansi(&self, f: &mut impl fmt::Write) -> fmt::Result {
        write!(f, "\x1b[r")
    }
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;
    use ratatui::layout::Position;
    use ratatui::layout::Rect;
    use ratatui::text::Line;

    use super::*;
    use crate::test_backend::VT100Backend;

    fn rows(terminal: &Terminal<VT100Backend>) -> Vec<String> {
        terminal
            .backend()
            .vt100()
            .screen()
            .rows(0, 40)
            .map(|row| row.trim_end().to_owned())
            .collect()
    }

    fn draw_viewport(terminal: &mut Terminal<VT100Backend>, text: &str) {
        terminal
            .draw(|frame| {
                let area = frame.area();
                frame
                    .buffer_mut()
                    .set_string(area.x, area.y, text, Style::default());
            })
            .expect("draw");
    }

    #[test]
    fn history_pushes_viewport_down_until_it_reaches_the_bottom() {
        let mut terminal =
            Terminal::with_cursor_position(VT100Backend::new(20, 6), Position::ORIGIN);
        terminal.set_viewport_area(Rect::new(0, 0, 20, 2));
        draw_viewport(&mut terminal, "viewport");

        insert_history_lines(&mut terminal, &[Line::from("one"), Line::from("two")])
            .expect("insert");
        draw_viewport(&mut terminal, "viewport");

        assert_eq!(terminal.viewport_area, Rect::new(0, 2, 20, 2));
        assert_eq!(rows(&terminal), ["one", "two", "viewport", "", "", ""]);
    }

    #[test]
    fn history_scrolls_older_lines_off_once_the_viewport_is_at_the_bottom() {
        let mut terminal = Terminal::with_cursor_position(
            VT100Backend::with_scrollback(20, 4, 10),
            Position::ORIGIN,
        );
        terminal.set_viewport_area(Rect::new(0, 2, 20, 2));
        draw_viewport(&mut terminal, "viewport");

        let lines: Vec<Line<'static>> = ["a", "b", "c"].into_iter().map(Line::from).collect();
        insert_history_lines(&mut terminal, &lines).expect("insert");

        assert_eq!(terminal.viewport_area, Rect::new(0, 2, 20, 2));
        assert_eq!(rows(&terminal), ["b", "c", "viewport", ""]);
    }

    #[test]
    fn a_single_line_above_a_top_anchored_viewport_lands_in_row_zero() {
        let mut terminal =
            Terminal::with_cursor_position(VT100Backend::new(20, 6), Position::ORIGIN);
        terminal.set_viewport_area(Rect::new(0, 0, 20, 2));
        draw_viewport(&mut terminal, "viewport");

        insert_history_lines(&mut terminal, &[Line::from("first")]).expect("insert");
        draw_viewport(&mut terminal, "viewport");

        assert_eq!(rows(&terminal), ["first", "viewport", "", "", "", ""]);
    }

    #[test]
    fn overflow_beyond_the_free_rows_scrolls_into_scrollback() {
        let mut terminal = Terminal::with_cursor_position(
            VT100Backend::with_scrollback(20, 5, 10),
            Position::ORIGIN,
        );
        terminal.set_viewport_area(Rect::new(0, 0, 20, 2));
        draw_viewport(&mut terminal, "viewport");

        let lines: Vec<Line<'static>> = ["a", "b", "c", "d", "e"]
            .into_iter()
            .map(Line::from)
            .collect();
        insert_history_lines(&mut terminal, &lines).expect("insert");

        assert_eq!(terminal.viewport_area, Rect::new(0, 3, 20, 2));
        assert_eq!(rows(&terminal), ["c", "d", "e", "viewport", ""]);
    }

    #[test]
    fn control_characters_never_reach_the_terminal() {
        let mut terminal =
            Terminal::with_cursor_position(VT100Backend::new(20, 4), Position::ORIGIN);
        terminal.set_viewport_area(Rect::new(0, 0, 20, 1));

        insert_history_lines(&mut terminal, &[Line::from("ok\x1b[2Jstill")]).expect("insert");

        assert_eq!(rows(&terminal)[0], "ok[2Jstill");
    }
}
