// Adapted from openai/codex `codex-rs/tui/src/custom_terminal.rs` (Apache-2.0), which is
// derived from `ratatui::Terminal`, licensed under the following terms:
//
// The MIT License (MIT)
// Copyright (c) 2016-2022 Florian Dehau
// Copyright (c) 2023-2025 The Ratatui Developers
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

//! A ratatui terminal whose inline viewport can move and resize between frames.
//!
//! Finished history lives in the terminal's own scrollback above the viewport (see
//! `insert_history`), so only the viewport is diffed and redrawn.

use std::io;
use std::io::Write;

use crossterm::cursor::MoveTo;
use crossterm::queue;
use crossterm::terminal::Clear;
use crossterm::terminal::ClearType;
use ratatui::backend::Backend;
use ratatui::buffer::Buffer;
use ratatui::layout::Position;
use ratatui::layout::Rect;
use ratatui::layout::Size;

/// One frame's drawing surface: the viewport's buffer in absolute screen coordinates.
pub struct Frame<'a> {
    area: Rect,
    buffer: &'a mut Buffer,
    cursor_position: Option<Position>,
}

impl Frame<'_> {
    pub fn area(&self) -> Rect {
        self.area
    }

    pub fn buffer_mut(&mut self) -> &mut Buffer {
        self.buffer
    }

    pub fn set_cursor_position(&mut self, position: Position) {
        self.cursor_position = Some(position);
    }
}

pub struct Terminal<B>
where
    B: Backend<Error = io::Error> + Write,
{
    backend: B,
    /// The current and previous frames, diffed so only changed cells are written.
    buffers: [Buffer; 2],
    current: usize,
    hidden_cursor: bool,
    pub viewport_area: Rect,
    /// Where the cursor was last left, restored after out-of-band history writes.
    pub last_known_cursor_pos: Position,
}

impl<B> Drop for Terminal<B>
where
    B: Backend<Error = io::Error> + Write,
{
    fn drop(&mut self) {
        if self.hidden_cursor {
            let _ = self.show_cursor();
        }
    }
}

impl<B> Terminal<B>
where
    B: Backend<Error = io::Error> + Write,
{
    /// Start an inline viewport at the cursor's current row.
    pub fn new(mut backend: B) -> io::Result<Self> {
        let cursor = backend.get_cursor_position().unwrap_or_else(|error| {
            // Some PTYs never answer the cursor position query; start at the top instead of failing.
            tracing::warn!(%error, "cursor position unavailable; anchoring the viewport at the top");
            Position::ORIGIN
        });
        Ok(Self::with_cursor_position(backend, cursor))
    }

    pub fn with_cursor_position(backend: B, cursor: Position) -> Self {
        Self {
            backend,
            buffers: [Buffer::empty(Rect::ZERO), Buffer::empty(Rect::ZERO)],
            current: 0,
            hidden_cursor: false,
            viewport_area: Rect::new(0, cursor.y, 0, 0),
            last_known_cursor_pos: cursor,
        }
    }

    #[cfg(test)]
    pub fn backend(&self) -> &B {
        &self.backend
    }

    pub fn backend_mut(&mut self) -> &mut B {
        &mut self.backend
    }

    pub fn size(&self) -> io::Result<Size> {
        self.backend.size()
    }

    /// Move or resize the viewport while keeping each buffer's contents, which is
    /// correct when the screen content moved with it (as when history scrolls it down).
    pub fn set_viewport_area(&mut self, area: Rect) {
        for buffer in &mut self.buffers {
            buffer.resize(area);
        }
        self.viewport_area = area;
    }

    /// Move or resize the viewport onto a cleared screen region and repaint it in full.
    pub fn replace_viewport_area(&mut self, area: Rect) -> io::Result<()> {
        let clear_from = self.viewport_area.y.min(area.y);
        self.clear_from_row(clear_from)?;
        self.set_viewport_area(area);
        for buffer in &mut self.buffers {
            buffer.reset();
        }
        Ok(())
    }

    /// Clear the screen from `row` down, leaving history above it untouched.
    pub fn clear_from_row(&mut self, row: u16) -> io::Result<()> {
        queue!(
            self.backend,
            MoveTo(0, row),
            Clear(ClearType::FromCursorDown)
        )?;
        self.last_known_cursor_pos = Position::new(0, row);
        Ok(())
    }

    /// Render one frame into the viewport and write only the cells that changed.
    pub fn draw<F>(&mut self, render: F) -> io::Result<()>
    where
        F: FnOnce(&mut Frame<'_>),
    {
        let area = self.viewport_area;
        let mut frame = Frame {
            area,
            buffer: &mut self.buffers[self.current],
            cursor_position: None,
        };
        render(&mut frame);
        let cursor_position = frame.cursor_position;

        let previous = &self.buffers[1 - self.current];
        let current = &self.buffers[self.current];
        let updates = previous.diff(current);
        if let Some(&(x, y, _)) = updates.last() {
            self.last_known_cursor_pos = Position::new(x, y);
        }
        if !updates.is_empty() && !self.hidden_cursor {
            self.backend.hide_cursor()?;
            self.hidden_cursor = true;
        }
        self.backend.draw(updates.into_iter())?;

        match cursor_position {
            Some(position) => {
                self.set_cursor_position(position)?;
                self.show_cursor()?;
            }
            None if !self.hidden_cursor => self.hide_cursor()?,
            None => {}
        }

        self.buffers[1 - self.current].reset();
        self.current = 1 - self.current;
        Backend::flush(&mut self.backend)
    }

    pub fn hide_cursor(&mut self) -> io::Result<()> {
        self.backend.hide_cursor()?;
        self.hidden_cursor = true;
        Ok(())
    }

    pub fn show_cursor(&mut self) -> io::Result<()> {
        self.backend.show_cursor()?;
        self.hidden_cursor = false;
        Ok(())
    }

    pub fn set_cursor_position(&mut self, position: Position) -> io::Result<()> {
        self.backend.set_cursor_position(position)?;
        self.last_known_cursor_pos = position;
        Ok(())
    }
}
