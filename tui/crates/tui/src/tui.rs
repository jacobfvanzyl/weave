//! Terminal mode setup, teardown, and drawing each frame.
//!
//! Fullscreen (the default, as in Codex) takes the alternate screen and draws everything,
//! with mouse reporting on for wheel scrolling and selection. Inline keeps a viewport below
//! the shell prompt and writes finished history into the terminal's native scrollback.

use std::io;
use std::io::Stdout;
use std::io::Write;
use std::io::stdout;
use std::time::Duration;

use base64::Engine;
use crossterm::Command;
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
use crossterm::terminal::EnterAlternateScreen;
use crossterm::terminal::LeaveAlternateScreen;
use crossterm::terminal::disable_raw_mode;
use crossterm::terminal::enable_raw_mode;
use crossterm::terminal::supports_keyboard_enhancement;
use ratatui::backend::CrosstermBackend;
use ratatui::layout::Position;
use ratatui::layout::Rect;
use ratatui::layout::Size;
use ratatui::text::Line;

use crate::custom_terminal::Frame;
use crate::custom_terminal::Terminal;
use crate::highlight;
use crate::insert_history::insert_history_lines;
use crate::insert_history::make_room_above;
use crate::palette;
use crate::palette::Palette;
use crate::wrapping::wrap_line;

/// Rows always left above the viewport so history can scroll through a valid region.
const HISTORY_ROWS_RESERVED: u16 = 2;
/// How long to wait for in-flight input when leaving raw mode.
const INPUT_DRAIN_WINDOW: Duration = Duration::from_millis(30);
/// Larger copies are refused rather than sent through OSC 52, as in Codex.
const OSC52_MAX_BYTES: usize = 100_000;

/// How weave uses the terminal.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScreenMode {
    /// The alternate screen, with weave drawing and scrolling the transcript itself.
    Fullscreen,
    /// A viewport below the shell prompt; finished history goes to native scrollback.
    Inline,
}

pub struct Tui {
    terminal: Terminal<CrosstermBackend<Stdout>>,
    mode: ScreenMode,
    last_screen: Size,
    keyboard_enhanced: bool,
}

impl Tui {
    pub fn init(mode: ScreenMode) -> io::Result<Self> {
        enable_raw_mode()?;
        install_panic_hook(mode);
        // Ask for the terminal's colors before anything else reads input.
        let palette = Palette::detect();
        tracing::info!(?palette, "terminal palette");
        palette::set(palette);
        highlight::warm_up();
        if mode == ScreenMode::Fullscreen {
            // Entered before the keyboard flags are pushed: some terminals keep a separate
            // flag stack per screen.
            execute!(stdout(), EnterAlternateScreen, EnableMouseReporting)?;
        }
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
        let backend = CrosstermBackend::new(stdout());
        let terminal = match mode {
            ScreenMode::Fullscreen => Terminal::with_cursor_position(backend, Position::ORIGIN),
            ScreenMode::Inline => Terminal::new(backend)?,
        };
        let last_screen = terminal.size()?;
        Ok(Self {
            terminal,
            mode,
            last_screen,
            keyboard_enhanced,
        })
    }

    pub fn mode(&self) -> ScreenMode {
        self.mode
    }

    pub fn size(&self) -> io::Result<Size> {
        self.terminal.size()
    }

    /// Fullscreen: draw the whole screen, repainting it in full after a resize.
    pub fn draw_screen<F>(&mut self, render: F) -> io::Result<()>
    where
        F: FnOnce(&mut Frame<'_>),
    {
        let screen = self.terminal.size()?;
        let area = Rect::new(0, 0, screen.width, screen.height);
        queue!(self.terminal.backend_mut(), BeginSynchronizedUpdate)?;
        let mut result = Ok(());
        if area != self.terminal.viewport_area {
            result = self.terminal.replace_viewport_area(area);
        }
        if result.is_ok() {
            result = self.terminal.draw(render);
        }
        queue!(self.terminal.backend_mut(), EndSynchronizedUpdate)?;
        self.terminal.backend_mut().flush()?;
        self.last_screen = screen;
        result
    }

    /// Put `text` on the clipboard: through `pbcopy` on a local Mac, otherwise by asking the
    /// terminal with OSC 52 (wrapped for tmux), which also reaches the client over SSH.
    pub fn copy(&mut self, text: &str) {
        let remote =
            std::env::var_os("SSH_CONNECTION").is_some() || std::env::var_os("SSH_TTY").is_some();
        if cfg!(target_os = "macos") && !remote && copy_with_pbcopy(text).is_ok() {
            return;
        }
        if text.len() > OSC52_MAX_BYTES {
            tracing::warn!(
                bytes = text.len(),
                "selection too large to copy through OSC 52"
            );
            return;
        }
        let encoded = base64::engine::general_purpose::STANDARD.encode(text);
        let sequence = if std::env::var_os("TMUX").is_some() {
            format!("\x1bPtmux;\x1b\x1b]52;c;{encoded}\x07\x1b\\")
        } else {
            format!("\x1b]52;c;{encoded}\x07")
        };
        let backend = self.terminal.backend_mut();
        if let Err(error) = backend
            .write_all(sequence.as_bytes())
            .and_then(|()| backend.flush())
        {
            tracing::warn!(%error, "failed to copy through OSC 52");
        }
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

    /// Restore the terminal. Inline mode clears the viewport so the shell resumes right after
    /// history; fullscreen returns to the screen as it was before weave started.
    pub fn exit(mut self) {
        if self.mode == ScreenMode::Inline {
            let top = self.terminal.viewport_area.y;
            let _ = queue!(
                self.terminal.backend_mut(),
                MoveTo(0, top),
                Clear(ClearType::FromCursorDown)
            );
            let _ = self.terminal.backend_mut().flush();
        }
        restore(self.keyboard_enhanced, self.mode);
    }
}

fn copy_with_pbcopy(text: &str) -> io::Result<()> {
    let mut child = std::process::Command::new("pbcopy")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(text.as_bytes())?;
    }
    let status = child.wait()?;
    if status.success() {
        Ok(())
    } else {
        Err(io::Error::other(format!("pbcopy exited with {status}")))
    }
}

/// Mouse reporting for presses, drags while a button is held, and the wheel, in SGR form.
/// Unlike crossterm's `EnableMouseCapture`, plain motion stays off, so moving the pointer
/// doesn't wake the app.
struct EnableMouseReporting;

impl Command for EnableMouseReporting {
    fn write_ansi(&self, f: &mut impl std::fmt::Write) -> std::fmt::Result {
        f.write_str("\x1b[?1000h\x1b[?1002h\x1b[?1006h")
    }

    #[cfg(windows)]
    fn execute_winapi(&self) -> io::Result<()> {
        crossterm::event::EnableMouseCapture.execute_winapi()
    }
}

struct DisableMouseReporting;

impl Command for DisableMouseReporting {
    fn write_ansi(&self, f: &mut impl std::fmt::Write) -> std::fmt::Result {
        f.write_str("\x1b[?1006l\x1b[?1002l\x1b[?1000l")
    }

    #[cfg(windows)]
    fn execute_winapi(&self) -> io::Result<()> {
        crossterm::event::DisableMouseCapture.execute_winapi()
    }
}

fn restore(keyboard_enhanced: bool, mode: ScreenMode) {
    // Popped before leaving the alternate screen, where the flags were pushed.
    if keyboard_enhanced {
        let _ = execute!(stdout(), PopKeyboardEnhancementFlags);
    }
    if mode == ScreenMode::Fullscreen {
        let _ = execute!(stdout(), DisableMouseReporting, LeaveAlternateScreen);
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

fn install_panic_hook(mode: ScreenMode) {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        // Popping is harmless when nothing was pushed.
        restore(true, mode);
        previous(info);
    }));
}
