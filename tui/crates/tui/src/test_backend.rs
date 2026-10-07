//! A ratatui backend that renders into an in-memory vt100 screen.
//!
//! Adapted from openai/codex `codex-rs/tui/src/test_backend.rs` (Apache-2.0).

use std::io;
use std::io::Write;

use ratatui::backend::Backend;
use ratatui::backend::ClearType;
use ratatui::backend::CrosstermBackend;
use ratatui::backend::WindowSize;
use ratatui::buffer::Cell;
use ratatui::layout::Position;
use ratatui::layout::Size;

pub struct VT100Backend {
    inner: CrosstermBackend<vt100::Parser>,
}

impl VT100Backend {
    pub fn new(width: u16, height: u16) -> Self {
        Self::with_scrollback(width, height, 0)
    }

    pub fn with_scrollback(width: u16, height: u16, scrollback_len: usize) -> Self {
        crossterm::style::force_color_output(true);
        Self {
            inner: CrosstermBackend::new(vt100::Parser::new(height, width, scrollback_len)),
        }
    }

    pub fn vt100(&self) -> &vt100::Parser {
        self.inner.writer()
    }
}

impl Write for VT100Backend {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.inner.writer_mut().write(buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.writer_mut().flush()
    }
}

impl Backend for VT100Backend {
    type Error = io::Error;

    fn draw<'a, I>(&mut self, content: I) -> io::Result<()>
    where
        I: Iterator<Item = (u16, u16, &'a Cell)>,
    {
        self.inner.draw(content)
    }

    fn hide_cursor(&mut self) -> io::Result<()> {
        self.inner.hide_cursor()
    }

    fn show_cursor(&mut self) -> io::Result<()> {
        self.inner.show_cursor()
    }

    fn get_cursor_position(&mut self) -> io::Result<Position> {
        Ok(self.vt100().screen().cursor_position().into())
    }

    fn set_cursor_position<P: Into<Position>>(&mut self, position: P) -> io::Result<()> {
        self.inner.set_cursor_position(position)
    }

    fn clear(&mut self) -> io::Result<()> {
        self.inner.clear()
    }

    fn clear_region(&mut self, clear_type: ClearType) -> io::Result<()> {
        self.inner.clear_region(clear_type)
    }

    fn size(&self) -> io::Result<Size> {
        let (rows, cols) = self.vt100().screen().size();
        Ok(Size::new(cols, rows))
    }

    fn window_size(&mut self) -> io::Result<WindowSize> {
        Ok(WindowSize {
            columns_rows: self.size()?,
            pixels: Size::new(640, 480),
        })
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.writer_mut().flush()
    }
}
