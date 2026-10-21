//! Renders transcript entries other than tool calls (see `tool_call`) and agent messages
//! (see `streaming`), in Codex's styles: `codex-rs/tui/src/history_cell/` (Apache-2.0).

use std::path::Path;
use std::time::Duration;

use ratatui::style::Color;
use ratatui::style::Modifier;
use ratatui::style::Style;
use ratatui::style::Stylize;
use ratatui::text::Line;
use ratatui::text::Span;
use weave_acp_core::schema::Plan;
use weave_acp_core::schema::PlanEntryStatus;

use crate::style;
pub use crate::style::dim;
use crate::wrapping::DisplayLine;
use crate::wrapping::wrap_sourced;

fn bullet(style: Style) -> Line<'static> {
    Line::from(Span::styled("• ", style))
}

fn indent() -> Line<'static> {
    Line::from("  ")
}

/// A sent prompt, as Codex shows it: a block shaded lighter than the background, with a
/// padding row above and below, and a dim `›` before the text.
pub fn user_message(text: &str, width: usize) -> Vec<DisplayLine> {
    let fill = style::sent_prompt();
    let prompt = Line::from("› ".bold().dim());
    let blank = || DisplayLine::plain(Line::default().style(fill));
    let mut lines = vec![blank()];
    for (index, source_line) in text.split('\n').enumerate() {
        let first = if index == 0 { prompt.clone() } else { indent() };
        // A column of margin keeps wrapped text off the block's right edge.
        lines.extend(
            wrap_sourced(
                &Line::from(source_line.to_owned()),
                width.saturating_sub(1),
                &first,
                &indent(),
            )
            .into_iter()
            .map(|mut row| {
                row.line.style = fill;
                row
            }),
        );
    }
    lines.push(blank());
    lines
}

pub fn info(text: &str, width: usize) -> Vec<DisplayLine> {
    let content = Line::from(Span::styled(text.to_owned(), dim()));
    wrap_sourced(&content, width, &bullet(dim()), &indent())
}

pub fn error(text: &str, width: usize) -> Vec<DisplayLine> {
    let red = Style::default().fg(Color::Red);
    let content = Line::from(Span::styled(text.to_owned(), red));
    wrap_sourced(
        &content,
        width,
        &Line::from(Span::styled("■ ", red)),
        &indent(),
    )
}

pub struct SessionHeader<'a> {
    pub agent: &'a str,
    pub agent_version: Option<&'a str>,
    /// The session directory, as shown (home shortened to `~`).
    pub directory: &'a str,
    /// Current settings, such as mode and model.
    pub settings: Option<&'a str>,
}

/// The startup header, after Codex's `>_ OpenAI Codex (vX)` with the directory under it.
pub fn session_header(header: &SessionHeader<'_>, width: usize) -> Vec<DisplayLine> {
    let title = Line::from(vec![
        Span::styled(">_ ", Style::default().fg(style::accent())),
        "weave".bold(),
        Span::styled(format!(" (v{})", env!("CARGO_PKG_VERSION")), dim()),
    ]);
    let mut lines = vec![DisplayLine::default()];
    lines.extend(wrap_sourced(&title, width, &indent(), &indent()));
    lines.extend(wrap_sourced(
        &Line::from(header.directory.to_owned().dim()),
        width,
        &Line::from("     "),
        &Line::from("     "),
    ));
    let mut agent = vec![
        Span::styled("agent: ", dim()),
        Span::raw(header.agent.to_owned()),
    ];
    if let Some(version) = header.agent_version {
        agent.push(Span::styled(format!(" {version}"), dim()));
    }
    if let Some(settings) = header.settings {
        agent.push(Span::styled(format!(" · {settings}"), dim()));
    }
    lines.extend(wrap_sourced(
        &Line::from(agent),
        width,
        &indent(),
        &indent(),
    ));
    lines
}

/// `• Updated Plan`, then its steps under `└`: done (struck through), current (accent),
/// pending (dim), as Codex shows plans.
pub fn plan(plan: &Plan, width: usize) -> Vec<DisplayLine> {
    let mut lines =
        vec![DisplayLine::whole(Line::from("Updated Plan").bold()).prefixed(&["• ".dim()])];
    for (index, entry) in plan.entries.iter().enumerate() {
        let (mark, style) = match entry.status {
            PlanEntryStatus::Completed => ("✔ ", dim().add_modifier(Modifier::CROSSED_OUT)),
            PlanEntryStatus::InProgress => (
                "□ ",
                Style::default()
                    .fg(style::accent())
                    .add_modifier(Modifier::BOLD),
            ),
            _ => ("□ ", dim()),
        };
        let elbow = if index == 0 {
            "  └ ".dim()
        } else {
            Span::raw("    ")
        };
        let first = Line::from(vec![
            elbow,
            Span::styled(mark, style.remove_modifier(Modifier::CROSSED_OUT)),
        ]);
        let rest = Line::from("      ");
        let content = Line::from(Span::styled(entry.content.clone(), style));
        lines.extend(wrap_sourced(&content, width, &first, &rest));
    }
    lines
}

/// `Worked for 1m 5s • 14:05`, dim, after a turn, as Codex marks finished turns.
pub fn turn_summary(elapsed: Duration, finished_at: &str, width: usize) -> Vec<DisplayLine> {
    let label = format!("Worked for {} • {finished_at}", worked_for(elapsed));
    wrap_sourced(&Line::from(label.dim()), width, &indent(), &indent())
}

fn worked_for(elapsed: Duration) -> String {
    let seconds = elapsed.as_secs();
    match seconds {
        0 => "less than a second".to_owned(),
        1..60 => format!("{seconds}s"),
        60..3600 => format!("{}m {}s", seconds / 60, seconds % 60),
        _ => format!("{}h {}m", seconds / 3600, seconds % 3600 / 60),
    }
}

/// A path with the home directory shortened to `~`, as Codex shows directories.
pub fn home_relative(path: &Path) -> String {
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
    match home
        .as_deref()
        .and_then(|home| path.strip_prefix(home).ok())
    {
        Some(rest) if rest.as_os_str().is_empty() => "~".to_owned(),
        Some(rest) => format!("~/{}", rest.display()),
        None => path.display().to_string(),
    }
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;
    use weave_acp_core::schema::PlanEntry;
    use weave_acp_core::schema::PlanEntryPriority;

    use super::*;

    fn text(lines: &[DisplayLine]) -> Vec<String> {
        lines
            .iter()
            .map(|line| line.line.to_string().trim_end().to_owned())
            .collect()
    }

    #[test]
    fn user_messages_are_a_padded_block_that_keeps_line_breaks() {
        assert_eq!(
            text(&user_message("first\nsecond", 20)),
            ["", "› first", "  second", ""]
        );
    }

    #[test]
    fn plans_mark_each_step() {
        let plan = Plan::new(vec![
            PlanEntry::new(
                "Reproduce",
                PlanEntryPriority::High,
                PlanEntryStatus::Completed,
            ),
            PlanEntry::new(
                "Fix it",
                PlanEntryPriority::High,
                PlanEntryStatus::InProgress,
            ),
            PlanEntry::new(
                "Add a test",
                PlanEntryPriority::Low,
                PlanEntryStatus::Pending,
            ),
        ]);
        assert_eq!(
            text(&super::plan(&plan, 40)),
            [
                "• Updated Plan",
                "  └ ✔ Reproduce",
                "    □ Fix it",
                "    □ Add a test"
            ]
        );
    }

    #[test]
    fn turn_summaries_round_durations_like_codex() {
        assert_eq!(worked_for(Duration::from_millis(400)), "less than a second");
        assert_eq!(worked_for(Duration::from_secs(125)), "2m 5s");
        assert_eq!(
            text(&turn_summary(Duration::from_secs(9), "14:05", 40)),
            ["  Worked for 9s • 14:05"]
        );
    }
}
