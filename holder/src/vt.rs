//! One terminal's screen in libghostty-vt: a program's output written into it, read back through
//! the formatter, and encoded as a snapshot that another libghostty-vt of the same codec restores.

use std::ptr;

use crate::ffi;

/// A libghostty-vt call that didn't succeed.
#[derive(Debug, thiserror::Error)]
#[error("libghostty-vt: {call} returned {code}")]
pub struct Error {
    call: &'static str,
    code: ffi::GhosttyResult,
}

fn check(call: &'static str, code: ffi::GhosttyResult) -> Result<(), Error> {
    if code == ffi::GHOSTTY_SUCCESS {
        Ok(())
    } else {
        Err(Error { call, code })
    }
}

/// What the formatter writes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    /// The characters alone.
    Text,
    /// VT sequences that draw the screen again, with its styles, cursor, modes, palette and
    /// keyboard state, which any terminal can restore from.
    Vt,
}

/// A terminal's screen and history.
pub struct Terminal {
    raw: ffi::GhosttyTerminal,
}

// libghostty-vt's terminal is used from one thread at a time: the holder keeps it under a lock.
unsafe impl Send for Terminal {}

impl Terminal {
    pub fn new(cols: u16, rows: u16) -> Result<Self, Error> {
        let mut raw: ffi::GhosttyTerminal = ptr::null_mut();
        check("ghostty_terminal_new", unsafe {
            ffi::ghostty_terminal_new(ptr::null(), &mut raw, cols, rows)
        })?;
        Ok(Self { raw })
    }

    /// Writes a program's output, as the PTY gave it.
    pub fn write(&mut self, bytes: &[u8]) {
        unsafe { ffi::ghostty_terminal_vt_write(self.raw, bytes.as_ptr(), bytes.len()) }
    }

    /// The screen and its history through the formatter, trailing blank lines trimmed.
    pub fn format(&self, format: Format) -> Result<String, Error> {
        let styled = format == Format::Vt;
        let options = ffi::GhosttyFormatterTerminalOptions {
            size: size_of::<ffi::GhosttyFormatterTerminalOptions>(),
            emit: match format {
                Format::Text => ffi::GHOSTTY_FORMATTER_FORMAT_PLAIN,
                Format::Vt => ffi::GHOSTTY_FORMATTER_FORMAT_VT,
            },
            unwrap: false,
            trim: true,
            extra: ffi::GhosttyFormatterTerminalExtra {
                size: size_of::<ffi::GhosttyFormatterTerminalExtra>(),
                palette: styled,
                modes: styled,
                scrolling_region: styled,
                tabstops: styled,
                pwd: styled,
                keyboard: styled,
                screen: ffi::GhosttyFormatterScreenExtra {
                    size: size_of::<ffi::GhosttyFormatterScreenExtra>(),
                    cursor: styled,
                    style: styled,
                    hyperlink: styled,
                    protection: styled,
                    kitty_keyboard: styled,
                    charsets: styled,
                },
            },
            selection: ptr::null(),
        };
        let mut formatter: ffi::GhosttyFormatter = ptr::null_mut();
        check("ghostty_formatter_terminal_new", unsafe {
            ffi::ghostty_formatter_terminal_new(ptr::null(), &mut formatter, self.raw, options)
        })?;
        let mut out: *mut u8 = ptr::null_mut();
        let mut len = 0;
        let formatted = check("ghostty_formatter_format_alloc", unsafe {
            ffi::ghostty_formatter_format_alloc(formatter, ptr::null(), &mut out, &mut len)
        });
        unsafe { ffi::ghostty_formatter_free(formatter) };
        formatted?;
        Ok(String::from_utf8_lossy(&take(out, len)).into_owned())
    }

    /// The whole terminal as a snapshot, which a libghostty-vt of the same codec restores.
    pub fn snapshot(&self) -> Result<Vec<u8>, Error> {
        let mut out: *mut u8 = ptr::null_mut();
        let mut len = 0;
        check("ghostty_snapshot_encode_alloc", unsafe {
            ffi::ghostty_snapshot_encode_alloc(self.raw, ptr::null(), &mut out, &mut len)
        })?;
        Ok(take(out, len))
    }
}

impl Drop for Terminal {
    fn drop(&mut self) {
        unsafe { ffi::ghostty_terminal_free(self.raw) }
    }
}

/// Copies and frees a buffer libghostty-vt allocated.
fn take(out: *mut u8, len: usize) -> Vec<u8> {
    if out.is_null() {
        return Vec::new();
    }
    let bytes = unsafe { std::slice::from_raw_parts(out, len) }.to_vec();
    unsafe { ffi::ghostty_free(ptr::null(), out, len) };
    bytes
}

/// The Ghostty commit this holder's libghostty-vt was built from (`ghostty.toml`).
pub const GHOSTTY_COMMIT: &str = env!("WEAVE_GHOSTTY_COMMIT");

/// Names this build's snapshots: the Ghostty commit and the snapshot format's version, read from
/// a snapshot's envelope (8 bytes of magic, then a little-endian u16). libghostty-vt reports the
/// same version at every commit, so only the commit tells two builds apart.
pub fn codec() -> Result<String, Error> {
    let snapshot = Terminal::new(2, 2)?.snapshot()?;
    let version = match snapshot.get(8..10) {
        Some(&[low, high]) => u16::from_le_bytes([low, high]),
        _ => 0,
    };
    Ok(format!("ghostty {GHOSTTY_COMMIT} snapshot {version}"))
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    #[test]
    fn formats_what_was_written() {
        let mut terminal = Terminal::new(20, 5).unwrap();
        terminal.write(b"hello\r\n\x1b[1;31mworld\x1b[0m");
        assert_eq!(terminal.format(Format::Text).unwrap(), "hello\nworld");
    }

    #[test]
    fn a_terminal_restored_from_vt_matches() {
        let mut terminal = Terminal::new(30, 6).unwrap();
        terminal.write(b"one\r\n\x1b[4mtwo\x1b[0m\r\n\x1b]0;title\x07three \x1b[38;5;208mfour");
        let mut restored = Terminal::new(30, 6).unwrap();
        restored.write(terminal.format(Format::Vt).unwrap().as_bytes());
        assert_eq!(
            restored.format(Format::Vt).unwrap(),
            terminal.format(Format::Vt).unwrap()
        );
        assert_eq!(
            restored.format(Format::Text).unwrap(),
            "one\ntwo\nthree four"
        );
    }

    #[test]
    fn the_codec_names_the_pinned_commit() {
        assert_eq!(
            codec().unwrap(),
            format!("ghostty {GHOSTTY_COMMIT} snapshot 1")
        );
        assert_eq!(GHOSTTY_COMMIT.len(), 40);
    }
}
