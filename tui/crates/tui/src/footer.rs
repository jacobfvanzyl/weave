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
use crate::transcript::FindStatus;
use crate::vim::Mode;

/// Columns of indent before the footer and after its right side.
const INDENT: usize = 2;
const SEPARATOR: &str = " · ";
/// Status line values are shortened to this many columns before items are dropped.
const ITEM_WIDTH: usize = 40;

/// What a status line item shows; configured as `[tui] status_line`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StatusItem {
    /// The model and its reasoning level, or the agent's name in its place when the agent
    /// offers no model choice and `Agent` isn't shown.
    Model,
    /// The agent's name: the title it reports, such as "Codex".
    Agent,
    Mode,
    Directory,
    /// The session's title.
    Session,
    /// How much of the context window is used, as a percentage.
    Context,
    /// What the session has cost, as the agent reports it, shown at the right.
    Cost,
}

impl StatusItem {
    /// The agent, the model, the context used, the session's title, and its cost. Codex also
    /// shows the directory; weave leaves it to `directory`.
    pub const DEFAULT: [Self; 5] = [
        Self::Agent,
        Self::Model,
        Self::Context,
        Self::Session,
        Self::Cost,
    ];

    pub fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "model" => Self::Model,
            "agent" => Self::Agent,
            "mode" => Self::Mode,
            "directory" => Self::Directory,
            "session" => Self::Session,
            "context" => Self::Context,
            "cost" => Self::Cost,
            _ => return None,
        })
    }

    pub fn names() -> &'static [&'static str] {
        &[
            "model",
            "agent",
            "mode",
            "directory",
            "session",
            "context",
            "cost",
        ]
    }

    /// Theme scopes to color the item by, as Codex does.
    fn scopes(self) -> &'static [&'static str] {
        match self {
            Self::Model | Self::Agent => &["entity.name.type", "support.type", "variable"],
            Self::Mode => &["storage.modifier", "keyword.operator"],
            Self::Directory => &["string", "markup.underline.link"],
            Self::Session => &["markup.heading", "entity.name.section"],
            Self::Context | Self::Cost => &["constant.numeric", "constant"],
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
    /// The percentage of the context window used.
    pub context_used: Option<u64>,
    /// What the session has cost so far, and in which ISO 4217 currency.
    pub cost: Option<(f64, String)>,
    /// Whether the agent has settings to change, so the footer ends with Ctrl+O's hint.
    pub settings: bool,
}

impl StatusValues {
    /// What `item` shows, as parts the status line sets apart: the model and its reasoning
    /// level are two. `items` are all the items shown, so the agent's name isn't repeated.
    fn parts(&self, item: StatusItem, items: &[StatusItem]) -> Vec<String> {
        self.raw_parts(item, items)
            .into_iter()
            // One row: a title with line breaks reads as one line.
            .map(|part| part.split_whitespace().collect::<Vec<_>>().join(" "))
            .filter(|part| !part.is_empty())
            .collect()
    }

    fn raw_parts(&self, item: StatusItem, items: &[StatusItem]) -> Vec<String> {
        let value = match item {
            StatusItem::Model => {
                let model = self
                    .model
                    .clone()
                    .or_else(|| (!items.contains(&StatusItem::Agent)).then(|| self.agent.clone()));
                // The level lowercase, as Codex shows "gpt-5.5 high".
                return model
                    .into_iter()
                    .chain(self.reasoning.as_ref().map(|level| level.to_lowercase()))
                    .collect();
            }
            StatusItem::Agent => Some(self.agent.clone()),
            StatusItem::Mode => self.mode.clone(),
            StatusItem::Directory => Some(self.directory.clone()),
            StatusItem::Session => self.session.clone(),
            StatusItem::Context => self.context_used.map(|used| format!("{used}%")),
            // Shown at the right, with the hints, rather than in the line.
            StatusItem::Cost => None,
        };
        value.into_iter().collect()
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
    /// The usual footer: the status line (or `? for shortcuts`), then the session's cost and
    /// the settings hint.
    Contextual {
        composer_empty: bool,
        working: bool,
    },
}

pub struct FooterProps<'a> {
    pub mode: FooterMode,
    pub items: &'a [StatusItem],
    pub values: &'a StatusValues,
    /// The Vim composer's mode and the keys of a command in progress, while it has the keys.
    pub vim: Option<(Mode, &'a str)>,
}

/// The footer row for `width` columns: left content, then the cost and settings hint,
/// right-aligned.
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
            if let Some((mode, pending)) = props.vim {
                // The Vim composer's mode leads, as Vim's `showmode` and `showcmd` show it.
                let mut spans = vec![Span::styled(mode.label(), mode_style(mode))];
                if !pending.is_empty() {
                    spans.push(Span::styled(format!(" {pending}"), secondary()));
                }
                let used = spans_width(&spans) + SEPARATOR.width();
                let rest = status_line(
                    props.items,
                    props.values,
                    width.saturating_sub(2 * INDENT + used),
                );
                if !rest.is_empty() {
                    spans.push(Span::styled(SEPARATOR, secondary()));
                    spans.extend(rest);
                }
                spans
            } else if working && !composer_empty {
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
    let mut right = if matches!(props.mode, FooterMode::Contextual { .. }) {
        trailing(
            props.values,
            props.items.contains(&StatusItem::Cost),
            props.vim.is_some(),
        )
    } else {
        Vec::new()
    };
    // The trailing slot gives way before the left side, its last part first.
    let fits = |parts: &[Vec<Span<'static>>]| {
        let width_of: usize = parts.iter().map(|part| spans_width(part)).sum();
        let separators = SEPARATOR.width() * parts.len().saturating_sub(1);
        INDENT + spans_width(&left) + width_of + separators + INDENT + 2 <= width
    };
    while !right.is_empty() && !fits(&right) {
        right.pop();
    }
    let mut spans = Vec::new();
    for part in right {
        if !spans.is_empty() {
            spans.push(Span::styled(SEPARATOR, secondary()));
        }
        spans.extend(part);
    }
    assemble(left, spans, width)
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

/// What the session has cost, as the agent reports it.
fn cost(values: &StatusValues) -> Vec<Span<'static>> {
    values
        .cost
        .as_ref()
        .map(|(amount, currency)| Span::styled(format_cost(*amount, currency), secondary()))
        .into_iter()
        .collect()
}

/// The right-aligned parts: the cost, when `cost` is a status line item, the send key in the
/// Vim composer, then the hint for the settings when there are any.
fn trailing(values: &StatusValues, show_cost: bool, vim: bool) -> Vec<Vec<Span<'static>>> {
    let mut parts = Vec::new();
    if show_cost {
        parts.push(cost(values));
    }
    // The Vim composer sends with Ctrl+Enter, as Enter starts a new line there.
    if vim {
        parts.push(key_hint("⌃↵", " send"));
    }
    if values.settings {
        parts.push(key_hint("⌃o", " Settings"));
    }
    parts.retain(|part| !part.is_empty());
    parts
}

/// Each Vim mode's color in the footer, as Vim's status line plugins color them.
fn mode_style(mode: Mode) -> Style {
    let color = match mode {
        Mode::Normal => Color::Blue,
        Mode::Insert => Color::Green,
        Mode::Replace => Color::Red,
        Mode::Visual | Mode::VisualLine => Color::Magenta,
    };
    Style::default()
        .fg(color)
        .add_modifier(ratatui::style::Modifier::BOLD)
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
        let style = highlight::scope_color(item.scopes())
            .map_or_else(secondary, |color| Style::default().fg(color));
        for part in values.parts(*item, items) {
            let part = truncate(&part, ITEM_WIDTH);
            let separator = if spans.is_empty() {
                0
            } else {
                SEPARATOR.width()
            };
            if spans_width(&spans) + separator + part.width() > width {
                return spans;
            }
            if separator > 0 {
                spans.push(Span::styled(SEPARATOR, secondary()));
            }
            spans.push(Span::styled(part, style));
        }
    }
    spans
}

/// Where Find is open, for its keys: the fullscreen transcript, or the inline pager, which
/// takes less's keys.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FindKeys {
    Screen,
    Pager,
}

/// The row Find's query is typed in, and the column its cursor is at.
pub fn find_query_line(query: &str) -> (Line<'static>, usize) {
    const LABEL: &str = "Find: ";
    let line = Line::from(vec![
        Span::styled(LABEL, secondary()),
        Span::raw(query.to_owned()),
    ]);
    (line, LABEL.width() + query.width())
}

/// Find's status and keys: how many matches, and how to move between them.
pub fn find_hints(status: &FindStatus<'_>, keys: FindKeys) -> Vec<Span<'static>> {
    let mut spans = Vec::new();
    let mut hint = |key: &str, text: &str| {
        if !spans.is_empty() {
            spans.push(Span::styled(SEPARATOR, secondary()));
        }
        spans.extend(key_hint(key, text));
    };
    let (older, newer, edit, close) = match keys {
        FindKeys::Screen => ("⌃p", "⌃n", "f3", "esc"),
        FindKeys::Pager => ("n", "N", "/", "esc"),
    };
    match (status.editing, status.place) {
        (true, _) if status.query.is_empty() => hint("", "Type to find"),
        (true, None) => hint("", "No matches"),
        (true, Some((index, count))) => {
            hint("", &format!("{index} of {count}"));
            hint("enter", " accept");
            hint("↑", " older");
            hint("↓", " newer");
        }
        (false, place) => {
            if let Some((index, count)) = place {
                hint("", &format!("{index} of {count}"));
            }
            hint(older, " older");
            hint(newer, " newer");
            hint(edit, " edit");
        }
    }
    match (status.editing, keys) {
        (true, _) => hint(close, " cancel"),
        (false, FindKeys::Screen) => hint(close, " latest"),
        (false, FindKeys::Pager) => hint(close, " close find"),
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

/// The composer's keys; with the Vim composer, a new line moves there.
const COMPOSE: &[(&str, &str)] = &[
    ("/", "Commands"),
    ("$", "Skills"),
    ("@", "Attach a file"),
    ("!", "Shell command"),
    ("⌃v", "Paste image"),
    ("⇧enter", "New line"),
    ("enter", "Send or queue"),
];
const COMPOSE_WITH_VIM: &[(&str, &str)] = &[
    ("/", "Commands"),
    ("$", "Skills"),
    ("@", "Attach a file"),
    ("!", "Shell command"),
    ("⌃v", "Paste image"),
    ("⇧enter", "New line, in Vim"),
    ("enter", "Send or queue"),
    ("⌃g", "Vim composer"),
    ("⌃↵", "Send from Vim"),
];

/// The `?` panel: weave's keys in three columns, as Codex lays out its shortcuts.
pub fn shortcut_lines(width: usize, vim: bool) -> Vec<Line<'static>> {
    let columns: [ShortcutColumn; 3] = [
        ("Compose", if vim { COMPOSE_WITH_VIM } else { COMPOSE }),
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
                ("f3", "Find text"),
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
            context_used: Some(25),
            cost: Some((1.5, "USD".into())),
            settings: true,
        }
    }

    fn render(mode: FooterMode, items: &[StatusItem], width: usize) -> String {
        let values = values();
        let props = FooterProps {
            mode,
            items,
            values: &values,
            vim: None,
        };
        footer_line(&props, width).to_string().trim_end().to_owned()
    }

    const IDLE: FooterMode = FooterMode::Contextual {
        composer_empty: true,
        working: false,
    };

    #[test]
    fn the_status_line_leads_and_the_cost_and_settings_hint_trail() {
        // Right-aligned with two columns of margin, so the trimmed line is width - 2 wide.
        let wide = render(IDLE, &StatusItem::DEFAULT, 100);
        assert!(
            wide.starts_with("  Claude · Opus 5.5 · high · 25% · Fix the build  "),
            "{wide}"
        );
        assert!(wide.ends_with("  $1.50 · ⌃o Settings"), "{wide}");
        assert_eq!(wide.width(), 98);
        // Without room, the trailing slot gives way first, the hint before the cost, then the
        // status line's trailing parts.
        let narrower = render(IDLE, &StatusItem::DEFAULT, 70);
        assert!(
            narrower.starts_with("  Claude · Opus 5.5 · high · 25% · Fix the build  ")
                && narrower.ends_with("  $1.50")
                && narrower.width() == 68,
            "{narrower}"
        );
        assert_eq!(
            render(IDLE, &StatusItem::DEFAULT, 56),
            "  Claude · Opus 5.5 · high · 25% · Fix the build"
        );
        assert_eq!(
            render(IDLE, &StatusItem::DEFAULT, 30),
            "  Claude · Opus 5.5 · high"
        );
        // The mode and directory show when configured.
        let configured = [StatusItem::Model, StatusItem::Mode, StatusItem::Directory];
        assert!(render(IDLE, &configured, 100).starts_with("  Opus 5.5 · high · Plan · ~/repo  "));
        // Without `cost` in the status line, the cost isn't shown even when reported.
        assert!(
            render(IDLE, &configured, 100).ends_with("  ⌃o Settings"),
            "{}",
            render(IDLE, &configured, 100)
        );
        // Without settings to change either, the slot is empty.
        let values = StatusValues {
            settings: false,
            ..values()
        };
        let props = FooterProps {
            mode: IDLE,
            items: &configured,
            values: &values,
            vim: None,
        };
        assert_eq!(
            footer_line(&props, 100).to_string().trim_end(),
            "  Opus 5.5 · high · Plan · ~/repo"
        );
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
    fn costs_show_in_their_currency() {
        let values = StatusValues {
            cost: Some((1.2345, "USD".into())),
            ..StatusValues::default()
        };
        assert_eq!(cost(&values)[0].content, "$1.23");
        assert_eq!(format_cost(0.042, "EUR"), "€0.042");
        assert_eq!(format_cost(12.0, "CHF"), "12.00 CHF");
    }

    #[test]
    fn values_read_as_one_line() {
        let values = StatusValues {
            session: Some("first line\nsecond  line".into()),
            ..StatusValues::default()
        };
        assert_eq!(
            values.parts(StatusItem::Session, &[]),
            ["first line second line"]
        );
    }

    #[test]
    fn the_model_stands_in_for_the_agent_only_when_the_agent_is_hidden() {
        let values = StatusValues {
            agent: "Gemini".into(),
            reasoning: Some("High".into()),
            ..StatusValues::default()
        };
        assert_eq!(
            values.parts(StatusItem::Model, &[StatusItem::Model]),
            ["Gemini", "high"]
        );
        assert_eq!(
            values.parts(StatusItem::Model, &StatusItem::DEFAULT),
            ["high"]
        );
        assert_eq!(StatusItem::parse("directory"), Some(StatusItem::Directory));
        assert_eq!(StatusItem::parse("branch"), None);
    }

    #[test]
    fn shortcuts_stack_on_narrow_screens() {
        let wide = shortcut_lines(100, false);
        assert!(wide[3].to_string().contains("Commands"));
        assert!(wide[3].to_string().contains("Next mode"));
        let narrow = shortcut_lines(30, false);
        let vim = shortcut_lines(100, true);
        assert!(
            vim.iter()
                .any(|line| line.to_string().contains("Vim composer"))
        );
        assert!(narrow.len() > wide.len());
    }
}
