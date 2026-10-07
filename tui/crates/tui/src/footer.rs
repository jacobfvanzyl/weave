//! The footer under the composer, the status line it carries, and the `?` shortcuts panel.
//!
//! After openai/codex `codex-rs/tui/src/bottom_pane/footer.rs`, `status_line_style.rs` and
//! `shortcut_overlay.rs` (Apache-2.0). The footer is pure rendering: [`ChatWidget`] decides the
//! [`FooterMode`] and supplies the values.
//!
//! [`ChatWidget`]: crate::chat::ChatWidget

use ratatui::style::Color;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::text::Span;
use unicode_width::UnicodeWidthStr;

use crate::highlight;
use crate::style::secondary;

/// Columns of indent before the footer and after its right side.
const INDENT: usize = 2;
const SEPARATOR: &str = " · ";
/// Status line values are shortened to this many columns before items are dropped.
const ITEM_WIDTH: usize = 40;

/// What a status line item shows; configured as `[tui] status_line`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StatusItem {
    /// The model and its reasoning level, or the agent's name when it offers no model choice.
    Model,
    Agent,
    Mode,
    Directory,
    /// The session's title.
    Session,
    Context,
}

impl StatusItem {
    /// The model and the session's title. Codex also shows the directory; weave leaves it
    /// to `directory`.
    pub const DEFAULT: [Self; 2] = [Self::Model, Self::Session];

    pub fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "model" => Self::Model,
            "agent" => Self::Agent,
            "mode" => Self::Mode,
            "directory" => Self::Directory,
            "session" => Self::Session,
            "context" => Self::Context,
            _ => return None,
        })
    }

    pub fn names() -> &'static [&'static str] {
        &["model", "agent", "mode", "directory", "session", "context"]
    }

    /// Theme scopes to color the item by, as Codex does.
    fn scopes(self) -> &'static [&'static str] {
        match self {
            Self::Model | Self::Agent => &["entity.name.type", "support.type", "variable"],
            Self::Mode => &["storage.modifier", "keyword.operator"],
            Self::Directory => &["string", "markup.underline.link"],
            Self::Session => &["markup.heading", "entity.name.section"],
            Self::Context => &["constant.numeric", "constant"],
        }
    }
}

/// The values status line items show, when known.
#[derive(Clone, Debug, Default)]
pub struct StatusValues {
    pub agent: String,
    pub model: Option<String>,
    pub reasoning: Option<String>,
    pub mode: Option<String>,
    pub directory: String,
    pub session: Option<String>,
    pub context_left: Option<u64>,
    /// What the session has cost so far, and in which ISO 4217 currency.
    pub cost: Option<(f64, String)>,
}

impl StatusValues {
    fn value(&self, item: StatusItem) -> Option<String> {
        match item {
            StatusItem::Model => Some(match (&self.model, &self.reasoning) {
                // Lowercase like Codex's "gpt-5.5 high".
                (Some(model), Some(reasoning)) => format!("{model} {}", reasoning.to_lowercase()),
                (Some(model), None) => model.clone(),
                (None, _) => self.agent.clone(),
            }),
            StatusItem::Agent => Some(self.agent.clone()),
            StatusItem::Mode => self.mode.clone(),
            StatusItem::Directory => Some(self.directory.clone()),
            StatusItem::Session => self.session.clone(),
            StatusItem::Context => self
                .context_left
                .map(|left| format!("Context {left}% left")),
        }
    }
}

/// Which footer to show.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FooterMode {
    /// Ctrl+C was pressed once while idle.
    QuitReminder,
    Disconnected,
    /// A prompt or picker shows its own keys.
    Overlay,
    ShortcutsOpen,
    /// The composer is in shell mode.
    Shell,
    /// The usual footer: the status line (or `? for shortcuts`), and the context left.
    Contextual {
        composer_empty: bool,
        working: bool,
    },
}

pub struct FooterProps<'a> {
    pub mode: FooterMode,
    pub items: &'a [StatusItem],
    pub values: &'a StatusValues,
}

/// The footer row for `width` columns: left content, then the context left, right-aligned.
pub fn footer_line(props: &FooterProps<'_>, width: usize) -> Line<'static> {
    let left = match props.mode {
        FooterMode::QuitReminder => key_hint("⌃c", " again to quit"),
        FooterMode::Disconnected => vec![Span::styled(
            "agent disconnected · ⌃c to quit",
            Style::default().fg(Color::Red),
        )],
        FooterMode::Overlay => Vec::new(),
        FooterMode::ShortcutsOpen => key_hint("? / esc", " close"),
        FooterMode::Shell => key_hint("enter", " to run · esc to leave shell mode"),
        FooterMode::Contextual {
            composer_empty,
            working,
        } => {
            if working && !composer_empty {
                key_hint("enter", " to queue message")
            } else if !props.items.is_empty() {
                status_line(props.items, props.values, width.saturating_sub(2 * INDENT))
            } else if composer_empty {
                key_hint("?", " for shortcuts")
            } else {
                Vec::new()
            }
        }
    };
    // The context gives way first when space is short.
    let right = if matches!(props.mode, FooterMode::Contextual { .. }) {
        context(props.values)
    } else {
        Vec::new()
    };
    let needed = INDENT + spans_width(&left) + spans_width(&right) + INDENT + 2;
    if right.is_empty() || needed > width {
        return assemble(left, Vec::new(), width);
    }
    assemble(left, right, width)
}

fn assemble(left: Vec<Span<'static>>, right: Vec<Span<'static>>, width: usize) -> Line<'static> {
    let mut spans = vec![Span::raw(" ".repeat(INDENT))];
    let left_width = spans_width(&left);
    spans.extend(left);
    let right_width = spans_width(&right);
    if right_width > 0 {
        let gap = width.saturating_sub(INDENT + left_width + right_width + INDENT);
        spans.push(Span::raw(" ".repeat(gap)));
        spans.extend(right);
    }
    Line::from(spans)
}

/// What the session has cost and the context left, as the agent reports them.
fn context(values: &StatusValues) -> Vec<Span<'static>> {
    let parts: Vec<String> = values
        .cost
        .as_ref()
        .map(|(amount, currency)| format_cost(*amount, currency))
        .into_iter()
        .chain(
            values
                .context_left
                .map(|left| format!("{left}% context left")),
        )
        .collect();
    if parts.is_empty() {
        return Vec::new();
    }
    vec![Span::styled(parts.join(SEPARATOR), secondary())]
}

/// `$1.23`, `€0.40`, or `12.00 CHF` for currencies without a symbol here.
fn format_cost(amount: f64, currency: &str) -> String {
    let symbol = match currency.to_ascii_uppercase().as_str() {
        "USD" => Some("$"),
        "EUR" => Some("€"),
        "GBP" => Some("£"),
        "JPY" => Some("¥"),
        _ => None,
    };
    // Cents, or a tenth of a cent while the cost is still small.
    let decimals = if amount.abs() < 1.0 { 3 } else { 2 };
    match symbol {
        Some(symbol) => format!("{symbol}{amount:.decimals$}"),
        None => format!("{amount:.decimals$} {currency}"),
    }
}

/// The configured items with known values, colored by theme scope and separated by dots,
/// dropping trailing items that don't fit.
fn status_line(items: &[StatusItem], values: &StatusValues, width: usize) -> Vec<Span<'static>> {
    let mut spans: Vec<Span<'static>> = Vec::new();
    for item in items {
        let Some(value) = values.value(*item) else {
            continue;
        };
        let value = truncate(&value, ITEM_WIDTH);
        let separator = if spans.is_empty() {
            0
        } else {
            SEPARATOR.width()
        };
        if spans_width(&spans) + separator + value.width() > width {
            break;
        }
        if separator > 0 {
            spans.push(Span::styled(SEPARATOR, secondary()));
        }
        let style = highlight::scope_color(item.scopes())
            .map_or_else(secondary, |color| Style::default().fg(color));
        spans.push(Span::styled(value, style));
    }
    spans
}

fn key_hint(key: &str, text: &str) -> Vec<Span<'static>> {
    vec![
        Span::raw(key.to_owned()),
        Span::styled(text.to_owned(), secondary()),
    ]
}

fn spans_width(spans: &[Span<'_>]) -> usize {
    spans.iter().map(|span| span.content.width()).sum()
}

pub fn truncate(text: &str, width: usize) -> String {
    if text.width() <= width {
        return text.to_owned();
    }
    let mut kept = String::new();
    for ch in text.chars() {
        if kept.width() + ch.to_string().width() >= width {
            break;
        }
        kept.push(ch);
    }
    format!("{kept}…")
}

/// A titled column of keys and what they do.
type ShortcutColumn = (&'static str, &'static [(&'static str, &'static str)]);

/// The `?` panel: weave's keys in three columns, as Codex lays out its shortcuts.
pub fn shortcut_lines(width: usize) -> Vec<Line<'static>> {
    let columns: [ShortcutColumn; 3] = [
        (
            "Compose",
            &[
                ("/", "Commands"),
                ("@", "Attach a file"),
                ("!", "Shell command"),
                ("⇧enter", "New line"),
                ("enter", "Send or queue"),
                ("⌃g", "External editor"),
            ],
        ),
        (
            "Session",
            &[
                ("⇧tab", "Next mode"),
                ("⌃o", "Settings"),
                ("⌃r", "Sessions"),
                ("esc", "Interrupt"),
                ("⌃c", "Quit"),
            ],
        ),
        (
            "Transcript",
            &[
                ("⌃t", "Full transcript"),
                ("pgup / pgdn", "Scroll"),
                ("⌃home / ⌃end", "Top / latest"),
                ("drag", "Copy text"),
            ],
        ),
    ];
    let key_width = |entries: &[(&str, &str)]| {
        entries
            .iter()
            .map(|(key, _)| key.width())
            .max()
            .unwrap_or_default()
    };
    let column_width = |(title, entries): &ShortcutColumn| {
        let entries_width = entries
            .iter()
            .map(|(_, label)| key_width(entries) + 2 + label.width())
            .max()
            .unwrap_or_default();
        entries_width.max(title.width()) + 4
    };
    // Narrow screens stack the columns.
    let side_by_side = INDENT + columns.iter().map(column_width).sum::<usize>() <= width;
    let groups: Vec<Vec<&ShortcutColumn>> = if side_by_side {
        vec![columns.iter().collect()]
    } else {
        columns.iter().map(|column| vec![column]).collect()
    };
    let mut lines = vec![Line::from(vec![
        Span::raw(" ".repeat(INDENT)),
        Span::styled("Keyboard shortcuts", Style::default().bold()),
    ])];
    for group in groups {
        lines.push(Line::default());
        let rows = group
            .iter()
            .map(|(_, entries)| entries.len())
            .max()
            .unwrap_or_default();
        for row in 0..=rows {
            let mut spans = vec![Span::raw(" ".repeat(INDENT))];
            for column in &group {
                let (title, entries) = **column;
                let width = column_width(column);
                let cell: Vec<Span<'static>> = if row == 0 {
                    vec![Span::styled(title.to_owned(), secondary())]
                } else if let Some((key, label)) = entries.get(row - 1) {
                    vec![
                        Span::raw(format!("{key:<width$}  ", width = key_width(entries))),
                        Span::styled((*label).to_owned(), secondary()),
                    ]
                } else {
                    Vec::new()
                };
                let used = spans_width(&cell);
                spans.extend(cell);
                spans.push(Span::raw(" ".repeat(width.saturating_sub(used))));
            }
            lines.push(Line::from(spans));
        }
    }
    lines.push(Line::default());
    lines
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    fn values() -> StatusValues {
        StatusValues {
            agent: "Claude".into(),
            model: Some("Opus 5.5".into()),
            reasoning: Some("High".into()),
            mode: Some("Plan".into()),
            directory: "~/repo".into(),
            session: Some("Fix the build".into()),
            context_left: Some(75),
            cost: None,
        }
    }

    fn render(mode: FooterMode, items: &[StatusItem], width: usize) -> String {
        let values = values();
        let props = FooterProps {
            mode,
            items,
            values: &values,
        };
        footer_line(&props, width).to_string().trim_end().to_owned()
    }

    const IDLE: FooterMode = FooterMode::Contextual {
        composer_empty: true,
        working: false,
    };

    #[test]
    fn the_status_line_leads_and_context_sits_right() {
        // Right-aligned with two columns of margin, so the trimmed line is width - 2 wide.
        let wide = render(IDLE, &StatusItem::DEFAULT, 100);
        assert!(
            wide.starts_with("  Opus 5.5 high · Fix the build  "),
            "{wide}"
        );
        assert!(wide.ends_with("  75% context left"), "{wide}");
        assert_eq!(wide.width(), 98);
        // Without room, the context goes first.
        assert_eq!(
            render(IDLE, &StatusItem::DEFAULT, 40),
            "  Opus 5.5 high · Fix the build"
        );
        // The mode and directory show when configured.
        let configured = [StatusItem::Model, StatusItem::Mode, StatusItem::Directory];
        assert!(render(IDLE, &configured, 100).starts_with("  Opus 5.5 high · Plan · ~/repo  "));
    }

    #[test]
    fn without_a_status_line_it_offers_shortcuts_and_hints_by_state() {
        assert!(render(IDLE, &[], 80).starts_with("  ? for shortcuts"));
        let drafting = FooterMode::Contextual {
            composer_empty: false,
            working: true,
        };
        assert!(render(drafting, &StatusItem::DEFAULT, 80).starts_with("  enter to queue message"));
        assert_eq!(
            render(FooterMode::QuitReminder, &[], 80),
            "  ⌃c again to quit"
        );
    }

    #[test]
    fn cost_sits_with_the_context() {
        let values = StatusValues {
            cost: Some((1.2345, "USD".into())),
            context_left: Some(80),
            ..StatusValues::default()
        };
        assert_eq!(context(&values)[0].content, "$1.23 · 80% context left");
        assert_eq!(format_cost(0.042, "EUR"), "€0.042");
        assert_eq!(format_cost(12.0, "CHF"), "12.00 CHF");
    }

    #[test]
    fn the_model_falls_back_to_the_agent() {
        let values = StatusValues {
            agent: "Gemini".into(),
            ..StatusValues::default()
        };
        assert_eq!(values.value(StatusItem::Model).as_deref(), Some("Gemini"));
        assert_eq!(StatusItem::parse("directory"), Some(StatusItem::Directory));
        assert_eq!(StatusItem::parse("branch"), None);
    }

    #[test]
    fn shortcuts_stack_on_narrow_screens() {
        let wide = shortcut_lines(100);
        assert!(wide[3].to_string().contains("Commands"));
        assert!(wide[3].to_string().contains("Next mode"));
        let narrow = shortcut_lines(30);
        assert!(narrow.len() > wide.len());
    }
}
