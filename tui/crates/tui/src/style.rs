//! Shared colors and semantic styles, after openai/codex `codex-rs/tui/src/style.rs`
//! (Apache-2.0). Shaded surfaces blend from the terminal's own background (see `palette`);
//! when it is unknown they are left unshaded.

use ratatui::style::Color;
use ratatui::style::Modifier;
use ratatui::style::Style;

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
    }
}
