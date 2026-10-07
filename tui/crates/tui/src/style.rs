//! Shared colors and semantic styles, after openai/codex `codex-rs/tui/src/style.rs`
//! (Apache-2.0). Shaded surfaces blend from the terminal's own background (see `palette`);
//! when it is unknown they are left unshaded.

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Color;
use ratatui::style::Modifier;
use ratatui::style::Style;
use ratatui::text::Line;

use crate::palette;
use crate::palette::Palette;
use crate::palette::Rgb;

/// Codex's accent (ChatGPT Blue 200) on dark backgrounds.
const ACCENT_DARK: Rgb = (99, 168, 248);
/// The accent on light backgrounds, where the lighter blue lacks contrast.
const ACCENT_LIGHT: Rgb = (28, 100, 200);

pub fn dim() -> Style {
    Style::default().add_modifier(Modifier::DIM)
}

/// The accent for emphasis: links, inline code, active plan steps, the header mark.
pub fn accent() -> Color {
    accent_for(&palette::current())
}

fn accent_for(palette: &Palette) -> Color {
    let preferred = if palette.is_light() {
        ACCENT_LIGHT
    } else {
        ACCENT_DARK
    };
    palette.color(preferred).unwrap_or(Color::Cyan)
}

/// Secondary text, such as hint wording around key names: the foreground 60% of the way
/// from the background, or dim where the colors are unknown.
pub fn secondary() -> Style {
    secondary_for(&palette::current())
}

fn secondary_for(palette: &Palette) -> Style {
    match (palette.fg, palette.bg) {
        (Some(fg), Some(bg)) => palette
            .color(palette::blend(fg, bg, 0.6))
            .map_or_else(dim, |color| Style::default().fg(color)),
        _ => dim(),
    }
}

/// ChatGPT Blue 200 and 100, Codex's selection fills on dark and light backgrounds.
const SELECTION_DARK: Rgb = (99, 168, 248);
const SELECTION_LIGHT: Rgb = (164, 205, 251);
/// Text on the selection fill.
const SELECTION_TEXT: Rgb = (0, 0, 46);

/// The selected row of a list or prompt, filled across its width as Codex does: blue with
/// bold dark text, or reversed where the background is unknown.
pub fn selection() -> Style {
    selection_for(&palette::current())
}

fn selection_for(palette: &Palette) -> Style {
    let fill = if palette.is_light() {
        SELECTION_LIGHT
    } else {
        SELECTION_DARK
    };
    match (
        palette.bg,
        palette.color(fill),
        palette.color(SELECTION_TEXT),
    ) {
        (Some(_), Some(fill), Some(text)) => Style::default()
            .bg(fill)
            .fg(text)
            .add_modifier(Modifier::BOLD),
        _ => Style::default().add_modifier(Modifier::BOLD | Modifier::REVERSED),
    }
}

/// Draw `line` at `y`, first filling the whole row with its style when that has a
/// background or is reversed, as selected rows and shaded blocks are.
pub fn set_line_filled(buf: &mut Buffer, x: u16, y: u16, line: &Line<'_>, width: u16) {
    let style = line.style;
    if style.bg.is_some() || style.add_modifier.contains(Modifier::REVERSED) {
        buf.set_style(Rect::new(x, y, width, 1), style);
    }
    buf.set_line(x, y, line, width);
}

/// A diff row's kind.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DiffKind {
    Insert,
    Delete,
    Context,
}

/// Codex's diff tints: muted on dark backgrounds, GitHub's pastels on light ones.
const DIFF_INSERT_DARK: Rgb = (33, 58, 43);
const DIFF_DELETE_DARK: Rgb = (74, 34, 29);
const DIFF_INSERT_LIGHT: Rgb = (218, 251, 225);
const DIFF_DELETE_LIGHT: Rgb = (255, 235, 233);

/// The fill behind a whole diff row; none for context, or where only 16 colors show.
pub fn diff_line_background(kind: DiffKind) -> Style {
    diff_background_for(kind, &palette::current())
        .map_or_else(Style::default, |bg| Style::default().bg(bg))
}

fn diff_background_for(kind: DiffKind, palette: &Palette) -> Option<Color> {
    let light = palette.is_light();
    match (kind, palette.level, light) {
        (DiffKind::Context, ..) => None,
        (_, palette::ColorLevel::Ansi256, false) => Some(palette::indexed(match kind {
            DiffKind::Insert => 22,
            _ => 52,
        })),
        (_, palette::ColorLevel::Ansi256, true) => Some(palette::indexed(match kind {
            DiffKind::Insert => 194,
            _ => 224,
        })),
        (DiffKind::Insert, _, false) => palette.color(DIFF_INSERT_DARK),
        (DiffKind::Delete, _, false) => palette.color(DIFF_DELETE_DARK),
        (DiffKind::Insert, _, true) => palette.color(DIFF_INSERT_LIGHT),
        (DiffKind::Delete, _, true) => palette.color(DIFF_DELETE_LIGHT),
    }
}

/// Uncolored diff text: green or red, except on a light tint, where the default reads better.
pub fn diff_text(kind: DiffKind) -> Style {
    let palette = palette::current();
    let tinted_light = palette.is_light() && diff_background_for(kind, &palette).is_some();
    match kind {
        DiffKind::Context => Style::default(),
        _ if tinted_light => Style::default(),
        DiffKind::Insert => Style::default().fg(Color::Green),
        DiffKind::Delete => Style::default().fg(Color::Red),
    }
}

pub fn diff_sign(kind: DiffKind) -> Style {
    match kind {
        DiffKind::Insert => Style::default().fg(Color::Green),
        DiffKind::Delete => Style::default().fg(Color::Red),
        DiffKind::Context => Style::default(),
    }
}

pub fn diff_gutter(_kind: DiffKind) -> Style {
    dim()
}

/// The composer's fill: 12% white over a dark background, 4% black over a light one.
pub fn composer() -> Style {
    composer_for(&palette::current())
}

fn composer_for(palette: &Palette) -> Style {
    shade(palette, 0.12, 0.04)
}

/// Sent prompts in the transcript: a lighter fill than the composer.
pub fn sent_prompt() -> Style {
    sent_prompt_for(&palette::current())
}

fn sent_prompt_for(palette: &Palette) -> Style {
    shade(palette, 0.16, 0.02)
}

fn shade(palette: &Palette, dark_alpha: f32, light_alpha: f32) -> Style {
    let fill = if palette.is_light() {
        palette.over_background((0, 0, 0), light_alpha)
    } else {
        palette.over_background((255, 255, 255), dark_alpha)
    };
    fill.map_or_else(Style::default, |fill| Style::default().bg(fill))
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;
    use crate::palette::ColorLevel;
    use crate::palette::rgb;

    #[test]
    fn surfaces_shade_the_known_background_and_stay_plain_otherwise() {
        let dark = Palette {
            fg: Some((205, 214, 244)),
            bg: Some((30, 30, 46)),
            level: ColorLevel::TrueColor,
        };
        let light = Palette {
            fg: Some((76, 79, 105)),
            bg: Some((239, 241, 245)),
            level: ColorLevel::TrueColor,
        };
        assert_eq!(composer_for(&dark).bg, Some(rgb((57, 57, 71))));
        assert_eq!(composer_for(&light).bg, Some(rgb((229, 231, 235))));
        assert_eq!(sent_prompt_for(&dark).bg, Some(rgb((66, 66, 79))));
        assert_eq!(composer_for(&Palette::UNKNOWN), Style::default());

        assert_eq!(accent_for(&dark), rgb((99, 168, 248)));
        assert_eq!(accent_for(&light), rgb((28, 100, 200)));
        assert_eq!(accent_for(&Palette::UNKNOWN), Color::Cyan);

        assert_eq!(secondary_for(&dark).fg, Some(rgb((135, 140, 164))));
        assert_eq!(secondary_for(&Palette::UNKNOWN), dim());
    }
}
