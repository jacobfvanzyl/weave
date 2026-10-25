//! Web links in agent text as terminal hyperlinks (OSC 8), after openai/codex
//! `codex-rs/tui/src/terminal_hyperlinks.rs` and `markdown_render/web_links.rs` (Apache-2.0).
//!
//! A link travels beside the text it labels, as the columns of a row it covers ([`RowLink`]), and
//! becomes escape sequences only where the row reaches the terminal: cells of the fullscreen
//! buffer, or the inline history writer. So the bytes never count towards layout, and they wrap
//! only what weave's own wrapping put there. Only `http` and `https` destinations with a host
//! qualify, at most 8 KiB, with control characters taken out; the terminal opens them, and weave
//! fetches nothing.
//!
//! Where the terminal is known to make them clickable, outside multiplexers, a link shows only
//! its label; anywhere else it keeps its destination after it, so a label never hides the only
//! usable URL.

use std::num::NonZeroU16;
use std::ops::Range;
use std::sync::Arc;
use std::sync::OnceLock;

use ratatui::buffer::Buffer;
use ratatui::buffer::CellDiffOption;
use ratatui::buffer::CellWidth;
use url::Url;

/// Destinations are repeated in every linked cell; longer ones stay plain text.
const MAX_DESTINATION_BYTES: usize = 8 * 1024;

/// A link on one row: the columns of its label there, and where it goes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RowLink {
    pub columns: Range<u16>,
    pub destination: Arc<str>,
}

/// `destination` as a hyperlink may carry it: an `http` or `https` URL with a host, without
/// control characters, at most 8 KiB.
pub fn web_destination(destination: &str) -> Option<Arc<str>> {
    if destination.len() > MAX_DESTINATION_BYTES {
        return None;
    }
    let safe: String = destination.chars().filter(|ch| !ch.is_control()).collect();
    let parsed = Url::parse(&safe).ok()?;
    (matches!(parsed.scheme(), "http" | "https") && parsed.host_str().is_some())
        .then(|| safe.into())
}

/// The sequence that starts a hyperlink to `destination`, from [`web_destination`].
pub fn open(destination: &str) -> String {
    format!("\x1b]8;;{destination}\x07")
}

/// The sequence that ends a hyperlink.
pub const CLOSE: &str = "\x1b]8;;\x07";

static LABEL_ONLY: OnceLock<bool> = OnceLock::new();

/// Record, at startup, whether links show only their labels. Only the first call counts.
pub fn set_label_only(label_only: bool) {
    let _ = LABEL_ONLY.set(label_only);
}

/// Whether links show only their labels; not before startup, and not in tests.
pub fn label_only() -> bool {
    LABEL_ONLY.get().copied().unwrap_or(false)
}

/// Whether a terminal with this environment makes hyperlinks clickable, so a link can show only
/// its label: Codex's list of terminals, outside tmux, Zellij and GNU Screen. Unknown terminals,
/// Apple's Terminal and Warp keep the destination.
pub fn label_only_for(var: impl Fn(&str) -> Option<String>, stdout_is_terminal: bool) -> bool {
    let set = |name: &str| var(name).is_some_and(|value| !value.is_empty());
    let term = var("TERM").unwrap_or_default();
    if !stdout_is_terminal
        || ["TMUX", "TMUX_PANE", "ZELLIJ", "ZELLIJ_SESSION_NAME", "STY"]
            .into_iter()
            .any(set)
        || term == "dumb"
        || term.starts_with("screen")
        || term.starts_with("tmux")
    {
        return false;
    }
    if let Some(program) = var("TERM_PROGRAM").filter(|program| !program.is_empty()) {
        let normalized: String = program
            .chars()
            .filter(|ch| !matches!(ch, ' ' | '-' | '_' | '.'))
            .map(|ch| ch.to_ascii_lowercase())
            .collect();
        return matches!(
            normalized.as_str(),
            "ghostty"
                | "iterm"
                | "iterm2"
                | "itermapp"
                | "wezterm"
                | "kitty"
                | "vscode"
                | "alacritty"
                | "konsole"
                | "gnometerminal"
                | "vte"
                | "windowsterminal"
                | "rex"
        );
    }
    [
        "GHOSTTY_RESOURCES_DIR",
        "WEZTERM_VERSION",
        "ITERM_SESSION_ID",
        "KITTY_WINDOW_ID",
        "ALACRITTY_SOCKET",
        "KONSOLE_VERSION",
        "GNOME_TERMINAL_SCREEN",
        "VTE_VERSION",
        "WT_SESSION",
    ]
    .into_iter()
    .any(set)
        || term.contains("kitty")
        || matches!(term.as_str(), "xterm-ghostty" | "wezterm" | "alacritty")
}

/// Make the cells `links` cover on row `y`, from column `x`, hyperlinks. Each cell's symbol is
/// wrapped in its own pair of sequences, and keeps its width for ratatui's diff.
pub fn mark(buf: &mut Buffer, x: u16, y: u16, width: u16, links: &[RowLink]) {
    let area = buf.area;
    for link in links {
        let mut skip = 0u16;
        for column in link.columns.clone() {
            if skip > 0 {
                skip -= 1;
                continue;
            }
            if column >= width {
                break;
            }
            let position = (x.saturating_add(column), y);
            if position.0 >= area.right() || position.1 >= area.bottom() {
                break;
            }
            let cell = &mut buf[position];
            if cell.diff_option == CellDiffOption::Skip {
                continue;
            }
            let cell_width = cell.cell_width();
            skip = cell_width.saturating_sub(1);
            let symbol = format!("{}{}{CLOSE}", open(&link.destination), cell.symbol());
            cell.set_symbol(&symbol)
                .set_diff_option(CellDiffOption::ForcedWidth(
                    NonZeroU16::new(cell_width).unwrap_or(NonZeroU16::MIN),
                ));
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use pretty_assertions::assert_eq;
    use ratatui::layout::Rect;
    use ratatui::text::Line;

    use super::*;

    #[test]
    fn only_web_destinations_with_a_host_qualify() {
        assert_eq!(
            web_destination("https://example.com/a").as_deref(),
            Some("https://example.com/a")
        );
        assert_eq!(
            web_destination("https://example.com/\u{1b}]8;;x").as_deref(),
            Some("https://example.com/]8;;x")
        );
        for rejected in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "mailto:a@b.c",
            "#section",
            "relative/path",
            "http://",
        ] {
            assert_eq!(web_destination(rejected), None, "{rejected}");
        }
        let long = format!("https://example.com/{}", "a".repeat(MAX_DESTINATION_BYTES));
        assert_eq!(web_destination(&long), None);
    }

    fn label_only_with(vars: &[(&str, &str)]) -> bool {
        let vars: HashMap<&str, &str> = vars.iter().copied().collect();
        label_only_for(|name| vars.get(name).map(|value| (*value).to_owned()), true)
    }

    #[test]
    fn labels_stand_alone_only_in_terminals_known_to_open_links_outside_multiplexers() {
        assert!(label_only_with(&[("TERM_PROGRAM", "ghostty")]));
        assert!(label_only_with(&[("TERM_PROGRAM", "iTerm.app")]));
        assert!(label_only_with(&[("TERM_PROGRAM", "rex")]));
        assert!(label_only_with(&[("KITTY_WINDOW_ID", "1")]));
        assert!(label_only_with(&[("TERM", "xterm-ghostty")]));
        assert!(!label_only_with(&[("TERM_PROGRAM", "Apple_Terminal")]));
        assert!(!label_only_with(&[("TERM_PROGRAM", "WarpTerminal")]));
        assert!(!label_only_with(&[("TERM", "xterm-256color")]));
        assert!(!label_only_with(&[
            ("TERM_PROGRAM", "ghostty"),
            ("TMUX", "/tmp/tmux-501/default,1,0")
        ]));
        assert!(!label_only_with(&[
            ("TERM_PROGRAM", "ghostty"),
            ("ZELLIJ", "0")
        ]));
        assert!(!label_only_with(&[("TERM", "screen-256color")]));
        assert!(!label_only_for(
            |name| (name == "TERM_PROGRAM").then(|| "ghostty".to_owned()),
            false
        ));
    }

    #[test]
    fn marked_cells_carry_the_link_and_keep_their_width() {
        let mut buf = Buffer::empty(Rect::new(0, 0, 10, 1));
        buf.set_line(0, 0, &Line::from("see 文档 x"), 10);
        let link = RowLink {
            columns: 4..8,
            destination: "https://example.com".into(),
        };
        mark(&mut buf, 0, 0, 10, &[link]);
        let wide = &buf[(4, 0)];
        assert_eq!(
            wide.symbol(),
            "\x1b]8;;https://example.com\x07文\x1b]8;;\x07"
        );
        assert_eq!(
            wide.diff_option,
            CellDiffOption::ForcedWidth(NonZeroU16::MIN.saturating_add(1))
        );
        assert!(buf[(6, 0)].symbol().contains("档"));
        assert_eq!(buf[(3, 0)].symbol(), " ");
        assert_eq!(buf[(8, 0)].symbol(), " ");
    }
}
