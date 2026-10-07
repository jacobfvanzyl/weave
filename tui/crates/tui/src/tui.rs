//! Terminal mode setup, teardown, and the per-frame viewport/history update.

use std::io;
use std::io::Stdout;
use std::io::Write;
use std::io::stdout;
use std::time::Duration;

use crossterm::cursor::MoveTo;
use crossterm::cursor::Show;
use crossterm::event;
use crossterm::event::DisableBracketedPaste;
use crossterm::event::EnableBracketedPaste;
use crossterm::event::KeyboardEnhancementFlags;
use crossterm::event::PopKeyboardEnhancementFlags;
use crossterm::event::PushKeyboardEnhancementFlags;
use crossterm::execute;
use crossterm::queue;
use crossterm::terminal::BeginSynchronizedUpdate;
use crossterm::terminal::Clear;
use crossterm::terminal::ClearType;
use crossterm::terminal::EndSynchronizedUpdate;
use crossterm::terminal::disable_raw_mode;
use crossterm::terminal::enable_raw_mode;
use crossterm::terminal::supports_keyboard_enhancement;
use ratatui::backend::CrosstermBackend;
use ratatui::layout::Size;
use ratatui::text::Line;

use crate::custom_terminal::Frame;
use crate::custom_terminal::Terminal;
use crate::insert_history::insert_history_lines;
use crate::insert_history::make_room_above;
use crate::wrapping::wrap_line;

/// Rows always left above the viewport so history can scroll through a valid region.
const HISTORY_ROWS_RESERVED: u16 = 2;
/// How long to wait for in-flight input when leaving raw mode.
const INPUT_DRAIN_WINDOW: Duration = Duration::from_millis(30);

pub struct Tui {
    terminal: Terminal<CrosstermBackend<Stdout>>,
    last_screen: Size,
    keyboard_enhanced: bool,
}

impl Tui {
    pub fn init() -> io::Result<Self> {
        enable_raw_mode()?;
        install_panic_hook();
        execute!(stdout(), EnableBracketedPaste)?;
        // Disambiguated keys let Shift+Enter insert a newline instead of submitting. Release
        // events stay off: one arriving after exit would land in the shell as stray input.
        let keyboard_enhanced = supports_keyboard_enhancement().unwrap_or(false);
        if keyboard_enhanced {
            execute!(
                stdout(),
                PushKeyboardEnhancementFlags(
                    KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES
                        | KeyboardEnhancementFlags::REPORT_ALTERNATE_KEYS
                )
            )?;
        }
        let terminal = Terminal::new(CrosstermBackend::new(stdout()))?;
        let last_screen = terminal.size()?;
        Ok(Self {
            terminal,
            last_screen,
            keyboard_enhanced,
        })
    }

    pub fn size(&self) -> io::Result<Size> {
        self.terminal.size()
    }

    /// Write `history` into scrollback, fit the viewport to `height`, and draw it.
    pub fn draw<F>(&mut self, history: Vec<Line<'static>>, height: u16, render: F) -> io::Result<()>
    where
        F: FnOnce(&mut Frame<'_>),
    {
        let screen = self.terminal.size()?;
        queue!(self.terminal.backend_mut(), BeginSynchronizedUpdate)?;
        let result = self.update_and_draw(screen, history, height, render);
        queue!(self.terminal.backend_mut(), EndSynchronizedUpdate)?;
        self.terminal.backend_mut().flush()?;
        self.last_screen = screen;
        result
    }

    fn update_and_draw<F>(
        &mut self,
        screen: Size,
        history: Vec<Line<'static>>,
        height: u16,
        render: F,
    ) -> io::Result<()>
    where
        F: FnOnce(&mut Frame<'_>),
    {
        let max_height = screen.height.saturating_sub(HISTORY_ROWS_RESERVED).max(1);
        let mut area = self.terminal.viewport_area;
        area.width = screen.width;
        area.height = height.clamp(1, max_height);
        if area.bottom() > screen.height {
            // Growing past the bottom pushes the oldest history up. When the terminal itself
            // shrank, it already moved that content, so only re-anchor.
            if screen.height >= self.last_screen.height {
                make_room_above(
                    &mut self.terminal,
                    area.top(),
                    area.bottom() - screen.height,
                )?;
            }
            area.y = screen.height - area.height;
        }
        if area != self.terminal.viewport_area {
            self.terminal.replace_viewport_area(area)?;
        }

        // Lines were wrapped when created; re-wrap any the terminal has since become too narrow for.
        let width = usize::from(screen.width);
        let history: Vec<Line<'static>> = history
            .iter()
            .flat_map(|line| wrap_line(line, width))
            .collect();
        insert_history_lines(&mut self.terminal, &history)?;
        self.terminal.draw(render)
    }

    /// Restore the terminal, clearing the viewport so the shell resumes right after history.
    pub fn exit(mut self) {
        let top = self.terminal.viewport_area.y;
        let _ = queue!(
            self.terminal.backend_mut(),
            MoveTo(0, top),
            Clear(ClearType::FromCursorDown)
        );
        let _ = self.terminal.backend_mut().flush();
        restore(self.keyboard_enhanced);
    }
}

fn restore(keyboard_enhanced: bool) {
    if keyboard_enhanced {
        let _ = execute!(stdout(), PopKeyboardEnhancementFlags);
    }
    let _ = execute!(stdout(), DisableBracketedPaste, Show);
    // Consume input already in flight (such as the tail of the quitting keystroke) while still
    // in raw mode, so the shell never receives it.
    while event::poll(INPUT_DRAIN_WINDOW).unwrap_or(false) {
        if event::read().is_err() {
            break;
        }
    }
    let _ = disable_raw_mode();
}

fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        // Popping is harmless when nothing was pushed.
        restore(true);
        previous(info);
    }));
}
