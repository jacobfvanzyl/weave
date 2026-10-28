//! Desktop notifications, the terminal title and its working directory, after openai/codex
//! `codex-rs/tui/src/notifications/` and `terminal_title.rs` (Apache-2.0).
//!
//! Notifications go out as OSC 9 on terminals that show them (Ghostty, iTerm2, kitty,
//! WezTerm, Warp), wrapped for tmux, and as a bell elsewhere. The title is set with OSC 0
//! from sanitized text; the shell's own title is pushed at startup and popped on exit where
//! the terminal keeps a title stack. The directory is the thread's, reported with OSC 7 as a
//! `file://` URL, so a multiplexer opens new panes there (ADR 0018).

use std::path::Path;

use url::Url;

/// Longest title, in characters, as Codex bounds it.
const MAX_TITLE_CHARS: usize = 120;
/// Longest notification body.
const MAX_NOTIFICATION_CHARS: usize = 200;

/// Save and restore the terminal's title (XTWINOPS 22/23).
pub const PUSH_TITLE: &str = "\x1b[22;0t";
pub const POP_TITLE: &str = "\x1b[23;0t";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NotifyMethod {
    /// OSC 9, passed through tmux when inside it.
    Osc9 {
        tmux: bool,
    },
    Bell,
}

impl NotifyMethod {
    pub fn detect() -> Self {
        method_from_env(|name| std::env::var(name).ok())
    }

    /// The bytes that raise a notification saying `message`.
    pub fn sequence(self, message: &str) -> String {
        match self {
            Self::Bell => "\x07".to_owned(),
            Self::Osc9 { tmux } => {
                let osc = format!("\x1b]9;{}\x07", sanitize(message, MAX_NOTIFICATION_CHARS));
                if tmux {
                    // DCS passthrough doubles each escape inside it.
                    format!("\x1bPtmux;{}\x1b\\", osc.replace('\x1b', "\x1b\x1b"))
                } else {
                    osc
                }
            }
        }
    }
}

fn method_from_env(var: impl Fn(&str) -> Option<String>) -> NotifyMethod {
    let program = var("TERM_PROGRAM").unwrap_or_default();
    let term = var("TERM").unwrap_or_default();
    let osc9 = matches!(
        program.as_str(),
        "ghostty" | "iTerm.app" | "WezTerm" | "WarpTerminal"
    ) || term == "xterm-kitty"
        || var("KITTY_WINDOW_ID").is_some();
    if osc9 {
        NotifyMethod::Osc9 {
            tmux: var("TMUX").is_some(),
        }
    } else {
        NotifyMethod::Bell
    }
}

/// The bytes that set the window title to `title`.
pub fn title_sequence(title: &str) -> String {
    format!("\x1b]0;{}\x07", sanitize(title, MAX_TITLE_CHARS))
}

/// The bytes that report `directory` as the terminal's working directory, on this computer.
pub fn directory_sequence(directory: &Path) -> Option<String> {
    directory_sequence_on(directory, &hostname().unwrap_or_default())
}

fn directory_sequence_on(directory: &Path, host: &str) -> Option<String> {
    // Percent-encoded, as OSC 7 expects.
    let url = Url::from_file_path(directory).ok()?;
    Some(format!("\x1b]7;file://{host}{}\x07", url.path()))
}

#[cfg(unix)]
fn hostname() -> Option<String> {
    let mut name = [0_u8; 256];
    // SAFETY: writes at most `name.len()` bytes into a live stack buffer.
    let failed = unsafe { libc::gethostname(name.as_mut_ptr().cast(), name.len()) } != 0;
    if failed {
        return None;
    }
    let end = name.iter().position(|byte| *byte == 0)?;
    std::str::from_utf8(&name[..end])
        .ok()
        .filter(|host| host.bytes().all(|byte| byte.is_ascii_graphic()))
        .map(str::to_owned)
}

#[cfg(not(unix))]
fn hostname() -> Option<String> {
    None
}

/// `text` safe to put in an OSC string: control and formatting characters dropped,
/// whitespace runs collapsed, at most `max` characters.
pub fn sanitize(text: &str, max: usize) -> String {
    let mut clean = String::new();
    let mut space = false;
    for ch in text.chars() {
        if ch.is_whitespace() {
            space = !clean.is_empty();
            continue;
        }
        // Bidi and zero-width controls could disguise what the title says.
        if ch.is_control()
            || matches!(ch, '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        {
            continue;
        }
        if space {
            clean.push(' ');
            space = false;
        }
        clean.push(ch);
    }
    if clean.chars().count() > max {
        let kept: String = clean.chars().take(max.saturating_sub(1)).collect();
        return format!("{kept}…");
    }
    clean
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    fn method(vars: &[(&str, &str)]) -> NotifyMethod {
        method_from_env(|name| {
            vars.iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| (*value).to_owned())
        })
    }

    #[test]
    fn osc9_where_the_terminal_shows_it_and_a_bell_elsewhere() {
        assert_eq!(
            method(&[("TERM_PROGRAM", "ghostty")]),
            NotifyMethod::Osc9 { tmux: false }
        );
        assert_eq!(
            method(&[("TERM", "xterm-kitty"), ("TMUX", "/tmp/tmux")]),
            NotifyMethod::Osc9 { tmux: true }
        );
        assert_eq!(
            method(&[("TERM_PROGRAM", "Apple_Terminal")]),
            NotifyMethod::Bell
        );
    }

    #[test]
    fn sequences_carry_clean_text() {
        let osc = NotifyMethod::Osc9 { tmux: false };
        assert_eq!(
            osc.sequence("Done:\n all\x1b[31m good"),
            "\x1b]9;Done: all[31m good\x07"
        );
        let tmux = NotifyMethod::Osc9 { tmux: true };
        assert_eq!(tmux.sequence("hi"), "\x1bPtmux;\x1b\x1b]9;hi\x07\x1b\\");
        assert_eq!(NotifyMethod::Bell.sequence("hi"), "\x07");
        assert_eq!(title_sequence("a\u{202e}b"), "\x1b]0;ab\x07");
        assert_eq!(sanitize("abcdef", 4), "abc…");
    }

    #[test]
    fn the_directory_goes_out_as_a_file_url_naming_this_computer() {
        assert_eq!(
            directory_sequence_on(Path::new("/Users/me/My Repo/ü#"), "mac.local").as_deref(),
            Some("\x1b]7;file://mac.local/Users/me/My%20Repo/%C3%BC%23\x07")
        );
        assert_eq!(
            directory_sequence_on(Path::new("relative"), "mac.local"),
            None
        );
    }
}
