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
    /// Codex's default, in weave's terms.
    pub const DEFAULT: [Self; 3] = [Self::Model, Self::Directory, Self::Session];

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
    /// The usual footer: the status line (or `? for shortcuts`), and mode and context.
    Contextual {
        composer_empty: bool,
        working: bool,
    },
}

pub struct FooterProps<'a> {
    pub mode: FooterMode,
    pub items: &'a [StatusItem],
    pub values: &'a StatusValues,
    /// Whether Shift+Tab cycles modes.
    pub can_cycle_mode: bool,
}

/// The footer row for `width` columns: left content, then right-aligned mode and context.
pub fn footer_line(props: &FooterProps<'_>, width: usize) -> Line<'static> {
    let left = match props.mode {
        FooterMode::QuitReminder => key_hint("⌃c", " again to quit"),
        FooterMode::Disconnected => vec![Span::styled(
            "agent disconnected · ⌃c to quit",
            Style::default().fg(Color::Red),
        )],
        FooterMode::Overlay => Vec::new(),
        FooterMode::ShortcutsOpen => key_hint("? / esc", " close"),
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
    let contextual = matches!(props.mode, FooterMode::Contextual { .. });
    let mut rights: Vec<Vec<Span<'static>>> = Vec::new();
    if contextual {
        rights.push(right_side(props, true));
        rights.push(right_side(props, false));
        rights.push(context(props.values));
    }
    rights.push(Vec::new());
    let left_width = spans_width(&left);
    for right in rights {
        let right_width = spans_width(&right);
        let needed = INDENT + left_width + right_width + INDENT + usize::from(right_width > 0) * 2;
        if needed <= width || right.is_empty() {
            return assemble(left, right, width);
        }
    }
    assemble(left, Vec::new(), width)
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

/// The mode (with its Shift+Tab hint when `cycle_hint`) and the context left.
fn right_side(props: &FooterProps<'_>, cycle_hint: bool) -> Vec<Span<'static>> {
    let mut spans = Vec::new();
    if props.can_cycle_mode
        && let Some(mode) = &props.values.mode
    {
        spans.push(Span::styled(
            mode.clone(),
            Style::default().fg(Color::Magenta),
        ));
        if cycle_hint {
            spans.push(Span::styled(" (", secondary()));
            spans.push(Span::raw("⇧tab"));
            spans.push(Span::styled(" to cycle)", secondary()));
        }
    }
    let context = context(props.values);
    if !spans.is_empty() && !context.is_empty() {
        spans.push(Span::styled(SEPARATOR, secondary()));
    }
    spans.extend(context);
    spans
}

fn context(values: &StatusValues) -> Vec<Span<'static>> {
    values
        .context_left
        .map(|left| Span::styled(format!("{left}% context left"), secondary()))
        .into_iter()
        .collect()
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
                ("⇧enter", "New line"),
                ("enter", "Send or queue"),
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
        }
    }

    fn render(mode: FooterMode, items: &[StatusItem], width: usize) -> String {
        let values = values();
        let props = FooterProps {
            mode,
            items,
            values: &values,
            can_cycle_mode: true,
        };
        footer_line(&props, width).to_string().trim_end().to_owned()
    }

    const IDLE: FooterMode = FooterMode::Contextual {
        composer_empty: true,
        working: false,
    };

    #[test]
    fn the_status_line_leads_and_mode_and_context_sit_right() {
        // Right-aligned with two columns of margin, so the trimmed line is width - 2 wide.
        let wide = render(IDLE, &StatusItem::DEFAULT, 100);
        assert!(
            wide.starts_with("  Opus 5.5 high · ~/repo · Fix the build  "),
            "{wide}"
        );
        assert!(
            wide.ends_with("  Plan (⇧tab to cycle) · 75% context left"),
            "{wide}"
        );
        assert_eq!(wide.width(), 98);
        // Narrower: the cycle hint goes first, then the mode, then the trailing items.
        let narrower = render(IDLE, &StatusItem::DEFAULT, 72);
        assert!(
            narrower.ends_with("  Plan · 75% context left"),
            "{narrower}"
        );
        assert_eq!(narrower.width(), 70);
        assert_eq!(
            render(IDLE, &StatusItem::DEFAULT, 40),
            "  Opus 5.5 high · ~/repo"
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
