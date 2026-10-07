//! The "Working" indicator shown while a turn runs: `• Working (12s • esc to interrupt)`.
//!
//! After openai/codex `codex-rs/tui/src/status_indicator_widget.rs`, `summary_shimmer.rs` and
//! `motion.rs` (Apache-2.0). The label rests halfway between the foreground and the
//! background, and a brighter band sweeps it for a second every four, starting 600 ms after
//! the label appears. The bullet pulses. Without known terminal colors the label is plain dim
//! and the bullet blinks.

use std::time::Duration;
use std::time::Instant;

use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::text::Span;
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

use crate::palette;
use crate::palette::ColorLevel;
use crate::palette::Palette;
use crate::style::dim;

const SWEEP_DELAY: Duration = Duration::from_millis(600);
const SWEEP_SECONDS: f64 = 1.0;
const SWEEP_INTERVAL_SECONDS: f64 = 4.0;
/// The bullet's pulse and blink periods.
const PULSE_SECONDS: f64 = 2.0;
const BLINK: Duration = Duration::from_millis(600);

pub struct Status<'a> {
    pub label: &'a str,
    /// When the label last changed, so a new one waits before its sweep.
    pub label_since: Instant,
    /// When the turn started, for the elapsed time.
    pub started: Instant,
    pub hint: &'a str,
}

pub fn status_line(status: &Status<'_>, now: Instant) -> Line<'static> {
    status_line_for(status, now, &palette::current())
}

fn status_line_for(status: &Status<'_>, now: Instant, palette: &Palette) -> Line<'static> {
    let elapsed = now.saturating_duration_since(status.started);
    let mut spans = vec![bullet(elapsed, palette), Span::raw(" ")];
    spans.extend(shimmer(
        status.label,
        now.saturating_duration_since(status.label_since),
        palette,
    ));
    spans.push(Span::styled(
        format!(" ({} • {})", format_elapsed(elapsed), status.hint),
        dim(),
    ));
    Line::from(spans)
}

fn colors(palette: &Palette) -> Option<(palette::Rgb, palette::Rgb)> {
    match (palette.level, palette.fg, palette.bg) {
        (ColorLevel::TrueColor, Some(fg), Some(bg)) => Some((fg, bg)),
        _ => None,
    }
}

/// The bullet of something still running: pulsing, or blinking without known colors.
pub fn activity_bullet(elapsed: Duration) -> Span<'static> {
    bullet(elapsed, &palette::current())
}

fn bullet(elapsed: Duration, palette: &Palette) -> Span<'static> {
    match colors(palette) {
        Some((fg, bg)) => {
            let phase = elapsed.as_secs_f64() % PULSE_SECONDS / PULSE_SECONDS;
            let intensity = 0.5 * (1.0 - (std::f64::consts::TAU * phase).cos());
            let alpha = (0.35 + 0.65 * intensity) as f32;
            Span::styled(
                "•",
                Style::default().fg(palette::rgb(palette::blend(fg, bg, alpha))),
            )
        }
        None if (elapsed.as_millis() / BLINK.as_millis()).is_multiple_of(2) => Span::raw("•"),
        None => Span::styled("◦", dim()),
    }
}

/// The label with Codex's summary shimmer.
fn shimmer(text: &str, since: Duration, palette: &Palette) -> Vec<Span<'static>> {
    let Some((fg, bg)) = colors(palette) else {
        return vec![Span::styled(text.to_owned(), dim())];
    };
    let width = text.width() as f64;
    let half_width = (width * 0.1).max(3.0);
    let sweep = (since.saturating_sub(SWEEP_DELAY).as_secs_f64() % SWEEP_INTERVAL_SECONDS)
        .min(SWEEP_SECONDS);
    let position = sweep / SWEEP_SECONDS * (width + 2.0 * half_width) - half_width;
    let mut column = 0.0;
    text.graphemes(true)
        .map(|grapheme| {
            let glyph = grapheme.width() as f64;
            let center = column + glyph / 2.0;
            column += glyph;
            let distance = ((center - position).abs() / half_width).min(1.0);
            let intensity = 0.5 * (1.0 + (std::f64::consts::PI * distance).cos());
            let alpha = (0.5 + 0.5 * intensity) as f32;
            Span::styled(
                grapheme.to_owned(),
                Style::default().fg(palette::rgb(palette::blend(fg, bg, alpha))),
            )
        })
        .collect()
}

/// `9s`, `1m 05s`, `2h 03m 04s`, as Codex shows elapsed time.
pub fn format_elapsed(elapsed: Duration) -> String {
    let seconds = elapsed.as_secs();
    match seconds {
        0..60 => format!("{seconds}s"),
        60..3600 => format!("{}m {:02}s", seconds / 60, seconds % 60),
        _ => format!(
            "{}h {:02}m {:02}s",
            seconds / 3600,
            seconds % 3600 / 60,
            seconds % 60
        ),
    }
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    #[test]
    fn elapsed_is_compact() {
        assert_eq!(format_elapsed(Duration::from_secs(9)), "9s");
        assert_eq!(format_elapsed(Duration::from_secs(65)), "1m 05s");
        assert_eq!(format_elapsed(Duration::from_secs(7384)), "2h 03m 04s");
    }

    #[test]
    fn status_reads_as_plain_text() {
        let start = Instant::now();
        let status = Status {
            label: "Working",
            label_since: start,
            started: start,
            hint: "esc to interrupt",
        };
        let line = status_line_for(
            &status,
            start + Duration::from_millis(3600), // in the bullet's visible blink phase
            &Palette::UNKNOWN,
        );
        assert_eq!(line.to_string(), "• Working (3s • esc to interrupt)");
    }

    #[test]
    fn the_band_brightens_the_label_as_it_passes() {
        let palette = Palette {
            fg: Some((200, 200, 200)),
            bg: Some((0, 0, 0)),
            level: ColorLevel::TrueColor,
        };
        let brightness = |since: Duration| -> Vec<u8> {
            shimmer("Working", since, &palette)
                .iter()
                .map(|span| match span.style.fg {
                    Some(ratatui::style::Color::Rgb(r, _, _)) => r,
                    _ => 0,
                })
                .collect()
        };
        // At rest the label is half bright; mid-sweep its middle reaches full brightness.
        assert!(brightness(Duration::ZERO).iter().all(|value| *value == 100));
        let mid = brightness(SWEEP_DELAY + Duration::from_millis(500));
        assert_eq!(mid.iter().max(), Some(&200));
        assert!(mid[0] < mid[3]);
    }
}
