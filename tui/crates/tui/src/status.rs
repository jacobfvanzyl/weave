//! The "Working" indicator shown while a turn runs.
//!
//! The sweep follows openai/codex `codex-rs/tui/src/shimmer.rs` (Apache-2.0), using only the
//! intensity fallback so it stays within the terminal's ANSI palette.

use std::time::Duration;
use std::time::Instant;

use ratatui::style::Modifier;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::text::Span;

use crate::history_cell::dim;

const SWEEP: Duration = Duration::from_secs(2);
const BAND_HALF_WIDTH: f32 = 3.0;

pub fn status_line(label: &str, started: Instant, now: Instant, hint: &str) -> Line<'static> {
    let elapsed = now.saturating_duration_since(started);
    let mut spans = vec![Span::styled("◦ ", dim())];
    spans.extend(shimmer(label, elapsed));
    spans.push(Span::styled(
        format!(" ({} • {hint})", format_elapsed(elapsed)),
        dim(),
    ));
    Line::from(spans)
}

fn shimmer(text: &str, elapsed: Duration) -> Vec<Span<'static>> {
    let chars: Vec<char> = text.chars().collect();
    let padding = 6.0;
    let period = chars.len() as f32 + padding * 2.0;
    let position = (elapsed.as_secs_f32() % SWEEP.as_secs_f32()) / SWEEP.as_secs_f32() * period;
    chars
        .iter()
        .enumerate()
        .map(|(index, ch)| {
            let distance = (index as f32 + padding - position).abs();
            let intensity = if distance <= BAND_HALF_WIDTH {
                0.5 * (1.0 + (std::f32::consts::PI * distance / BAND_HALF_WIDTH).cos())
            } else {
                0.0
            };
            let style = if intensity < 0.2 {
                dim()
            } else if intensity < 0.6 {
                Style::default()
            } else {
                Style::default().add_modifier(Modifier::BOLD)
            };
            Span::styled(ch.to_string(), style)
        })
        .collect()
}

pub fn format_elapsed(elapsed: Duration) -> String {
    let seconds = elapsed.as_secs();
    if seconds < 60 {
        format!("{seconds}s")
    } else {
        format!("{}m {:02}s", seconds / 60, seconds % 60)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn elapsed_switches_to_minutes() {
        assert_eq!(format_elapsed(Duration::from_secs(9)), "9s");
        assert_eq!(format_elapsed(Duration::from_secs(65)), "1m 05s");
    }

    #[test]
    fn status_reads_as_plain_text() {
        let start = Instant::now();
        let line = status_line(
            "Working",
            start,
            start + Duration::from_secs(3),
            "esc to interrupt",
        );
        assert_eq!(line.to_string(), "◦ Working (3s • esc to interrupt)");
    }
}
