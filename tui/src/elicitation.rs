//! `elicitation/create` prompts: a form to fill in, or a URL to consent to opening.
//!
//! The spec requires naming the requesting agent, letting the user review and edit form
//! answers before sending, offering distinct decline and cancel actions, and, for URLs,
//! showing the full URL with its host before consent, never opening it without consent.

use std::collections::BTreeMap;

use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyModifiers;
use ratatui::buffer::Buffer;
use ratatui::layout::Position;
use ratatui::layout::Rect;
use ratatui::style::Color;
use ratatui::style::Modifier;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::text::Span;
use unicode_width::UnicodeWidthStr;
use weave_acp_core::schema::CreateElicitationRequest;
use weave_acp_core::schema::ElicitationContentValue;
use weave_acp_core::schema::ElicitationId;
use weave_acp_core::schema::ElicitationMode;
use weave_acp_core::schema::ElicitationPropertySchema;
use weave_acp_core::schema::ElicitationSchema;
use weave_acp_core::schema::MultiSelectItems;
use weave_acp_core::schema::StringFormat;

use crate::history_cell::dim;
use crate::style;
use crate::wrapping::wrap_with_prefix;

/// What the user decided.
#[derive(Debug, PartialEq)]
pub enum ElicitationOutcome {
    Accept(Option<BTreeMap<String, ElicitationContentValue>>),
    /// Accepting a URL elicitation: open this URL, then report acceptance.
    OpenUrl(String),
    Decline,
    Cancel,
}

pub enum ElicitationView {
    Form(FormView),
    Url(UrlView),
}

impl ElicitationView {
    pub fn new(request: &CreateElicitationRequest, agent: &str) -> Option<Self> {
        match &request.mode {
            ElicitationMode::Form(form) => Some(Self::Form(FormView::new(
                agent,
                &request.message,
                &form.requested_schema,
            ))),
            ElicitationMode::Url(url) => Some(Self::Url(UrlView::new(
                agent,
                &request.message,
                &url.url,
                url.elicitation_id.clone(),
            ))),
            _ => None,
        }
    }

    pub fn handle_key(&mut self, key: KeyEvent) -> Option<ElicitationOutcome> {
        match self {
            Self::Form(form) => form.handle_key(key),
            Self::Url(url) => url.handle_key(key),
        }
    }

    pub fn handle_paste(&mut self, text: &str) {
        if let Self::Form(form) = self {
            form.paste(text);
        }
    }

    pub fn desired_height(&self, width: u16) -> u16 {
        let lines = match self {
            Self::Form(form) => form.lines(usize::from(width)).0.len(),
            Self::Url(url) => url.lines(usize::from(width)).len(),
        };
        u16::try_from(lines).unwrap_or(u16::MAX)
    }

    pub fn render(&self, area: Rect, buf: &mut Buffer) -> Option<Position> {
        let (lines, cursor) = match self {
            Self::Form(form) => form.lines(usize::from(area.width)),
            Self::Url(url) => (url.lines(usize::from(area.width)), None),
        };
        for (line, y) in lines.iter().zip(area.y..area.bottom()) {
            buf.set_line(area.x, y, line, area.width);
        }
        cursor.and_then(|(row, column)| {
            let y = area.y + u16::try_from(row).ok()?;
            (y < area.bottom()).then(|| Position::new(area.x + column, y))
        })
    }
}

fn heading(agent: &str, message: &str, width: usize) -> Vec<Line<'static>> {
    let line = Line::from(vec![
        Span::styled(
            format!("{agent} asks: "),
            Style::default()
                .fg(style::accent())
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            message.to_owned(),
            Style::default().add_modifier(Modifier::BOLD),
        ),
    ]);
    wrap_with_prefix(&line, width, &Line::from("  "), &Line::from("  "))
}

/// A chosen chip or button: filled as Codex fills selections.
fn selected_style(selected: bool) -> Style {
    if selected {
        style::selection()
    } else {
        Style::default()
    }
}

/// The focused field's label.
fn focus_style(focused: bool) -> Style {
    if focused {
        Style::default()
            .fg(style::accent())
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default()
    }
}

fn buttons(labels: &[&str], focused: Option<usize>) -> Line<'static> {
    let mut spans = vec![Span::raw("  ")];
    for (index, label) in labels.iter().enumerate() {
        let selected = focused == Some(index);
        let text = if selected {
            format!("› {label}")
        } else {
            format!("  {label}")
        };
        spans.push(Span::styled(text, selected_style(selected)));
        spans.push(Span::raw("  "));
    }
    Line::from(spans)
}

enum FieldKind {
    Text {
        value: String,
        format: Option<StringFormat>,
        min_length: Option<u32>,
        max_length: Option<u32>,
        pattern: Option<String>,
    },
    Number {
        value: String,
        integer: bool,
        minimum: Option<f64>,
        maximum: Option<f64>,
    },
    Toggle(Option<bool>),
    Choice {
        options: Vec<(String, String)>,
        selected: Option<usize>,
    },
    Multi {
        options: Vec<(String, String)>,
        chosen: Vec<bool>,
        cursor: usize,
        min_items: Option<u64>,
        max_items: Option<u64>,
    },
    /// A property type this client cannot render.
    Unsupported(String),
}

struct Field {
    name: String,
    title: String,
    description: Option<String>,
    required: bool,
    kind: FieldKind,
    error: Option<String>,
}

const BUTTONS: [&str; 3] = ["Submit", "Decline", "Cancel"];

pub struct FormView {
    agent: String,
    message: String,
    title: Option<String>,
    fields: Vec<Field>,
    /// A field index, or `fields.len() + button` for the buttons.
    focus: usize,
}

impl FormView {
    pub fn new(agent: &str, message: &str, schema: &ElicitationSchema) -> Self {
        let required = schema.required.clone().unwrap_or_default();
        let fields = schema
            .properties
            .iter()
            .map(|(name, property)| field(name, property, required.contains(name)))
            .collect();
        Self {
            agent: agent.to_owned(),
            message: message.to_owned(),
            title: schema.title.clone(),
            fields,
            focus: 0,
        }
    }

    fn handle_key(&mut self, key: KeyEvent) -> Option<ElicitationOutcome> {
        let stops = self.fields.len() + BUTTONS.len();
        match key.code {
            KeyCode::Esc => return Some(ElicitationOutcome::Cancel),
            KeyCode::Tab | KeyCode::Down => self.focus = (self.focus + 1) % stops,
            KeyCode::BackTab | KeyCode::Up => self.focus = (self.focus + stops - 1) % stops,
            KeyCode::Enter => match self.focus.checked_sub(self.fields.len()) {
                Some(0) => return self.submit(),
                Some(1) => return Some(ElicitationOutcome::Decline),
                Some(_) => return Some(ElicitationOutcome::Cancel),
                // Enter in a field moves on, so a stray Enter never submits half a form.
                None => self.focus += 1,
            },
            KeyCode::Left | KeyCode::Right if self.focus >= self.fields.len() => {
                let button = self.focus - self.fields.len();
                let button = if key.code == KeyCode::Left {
                    button.saturating_sub(1)
                } else {
                    (button + 1).min(BUTTONS.len() - 1)
                };
                self.focus = self.fields.len() + button;
            }
            _ => {
                if let Some(field) = self.fields.get_mut(self.focus) {
                    field.edit(key);
                }
            }
        }
        None
    }

    fn paste(&mut self, text: &str) {
        if let Some(field) = self.fields.get_mut(self.focus) {
            match &mut field.kind {
                FieldKind::Text { value, .. } | FieldKind::Number { value, .. } => {
                    value.push_str(&text.replace(['\r', '\n'], " "));
                    field.error = None;
                }
                _ => {}
            }
        }
    }

    /// Validate everything; on success, the values to send (empty optional fields omitted).
    fn submit(&mut self) -> Option<ElicitationOutcome> {
        let mut content = BTreeMap::new();
        let mut first_invalid = None;
        for (index, field) in self.fields.iter_mut().enumerate() {
            match field.value() {
                Ok(Some(value)) => {
                    content.insert(field.name.clone(), value);
                    field.error = None;
                }
                Ok(None) if field.required => field.error = Some("required".to_owned()),
                Ok(None) => field.error = None,
                Err(error) => field.error = Some(error),
            }
            if field.error.is_some() && first_invalid.is_none() {
                first_invalid = Some(index);
            }
        }
        match first_invalid {
            Some(index) => {
                self.focus = index;
                None
            }
            None => Some(ElicitationOutcome::Accept(Some(content))),
        }
    }

    /// Lines and, when a text field is focused, the cursor's (row, column).
    fn lines(&self, width: usize) -> (Vec<Line<'static>>, Option<(usize, u16)>) {
        let mut lines = heading(&self.agent, &self.message, width);
        if let Some(title) = &self.title {
            lines.push(Line::from(Span::styled(format!("  {title}"), dim())));
        }
        let label_width = self
            .fields
            .iter()
            .map(|field| field.title.width() + usize::from(field.required) * 2)
            .max()
            .unwrap_or(0)
            .min(24);
        let mut cursor = None;
        for (index, field) in self.fields.iter().enumerate() {
            let focused = index == self.focus;
            let marker = if field.required { " *" } else { "" };
            let label = format!(
                "{}{}{marker}",
                if focused { "› " } else { "  " },
                field.title
            );
            let padded = format!("{label:<width$}  ", width = label_width + 2);
            let mut spans = vec![Span::styled(padded.clone(), focus_style(focused))];
            spans.extend(field.value_spans(focused));
            if focused
                && matches!(
                    field.kind,
                    FieldKind::Text { .. } | FieldKind::Number { .. }
                )
            {
                let typed = spans
                    .iter()
                    .skip(1)
                    .map(|span| span.content.width())
                    .sum::<usize>();
                cursor = Some((
                    lines.len(),
                    u16::try_from(padded.width() + typed).unwrap_or(0),
                ));
            }
            lines.push(Line::from(spans));
            if let Some(error) = &field.error {
                lines.push(Line::from(Span::styled(
                    format!("{:width$}  {error}", "", width = label_width + 2),
                    Style::default().fg(Color::Red),
                )));
            } else if focused && let Some(description) = &field.description {
                lines.push(Line::from(Span::styled(
                    format!("{:width$}  {description}", "", width = label_width + 2),
                    dim(),
                )));
            }
        }
        let focused_button = self.focus.checked_sub(self.fields.len());
        lines.push(buttons(&BUTTONS, focused_button));
        lines.push(Line::from(Span::styled(
            "  tab next · ←→ change · space toggle · enter on a button · esc cancel",
            dim(),
        )));
        (lines, cursor)
    }
}

fn field(name: &str, property: &ElicitationPropertySchema, required: bool) -> Field {
    let (title, description, kind) = match property {
        ElicitationPropertySchema::String(string) => {
            let options: Option<Vec<(String, String)>> = string
                .one_of
                .as_ref()
                .map(|options| {
                    options
                        .iter()
                        .map(|option| (option.value.clone(), option.title.clone()))
                        .collect()
                })
                .or_else(|| {
                    string.enum_values.as_ref().map(|values| {
                        values
                            .iter()
                            .map(|value| (value.clone(), value.clone()))
                            .collect()
                    })
                });
            let kind = match options {
                Some(options) => {
                    let selected = string
                        .default
                        .as_ref()
                        .and_then(|default| options.iter().position(|(value, _)| value == default));
                    FieldKind::Choice { options, selected }
                }
                None => FieldKind::Text {
                    value: string.default.clone().unwrap_or_default(),
                    format: string.format,
                    min_length: string.min_length,
                    max_length: string.max_length,
                    pattern: string.pattern.clone(),
                },
            };
            (string.title.clone(), string.description.clone(), kind)
        }
        ElicitationPropertySchema::Number(number) => (
            number.title.clone(),
            number.description.clone(),
            FieldKind::Number {
                value: number
                    .default
                    .map(|default| default.to_string())
                    .unwrap_or_default(),
                integer: false,
                minimum: number.minimum,
                maximum: number.maximum,
            },
        ),
        ElicitationPropertySchema::Integer(integer) => (
            integer.title.clone(),
            integer.description.clone(),
            FieldKind::Number {
                value: integer
                    .default
                    .map(|default| default.to_string())
                    .unwrap_or_default(),
                integer: true,
                minimum: integer.minimum.map(|minimum| minimum as f64),
                maximum: integer.maximum.map(|maximum| maximum as f64),
            },
        ),
        ElicitationPropertySchema::Boolean(boolean) => (
            boolean.title.clone(),
            boolean.description.clone(),
            FieldKind::Toggle(boolean.default),
        ),
        ElicitationPropertySchema::Array(multi) => {
            let options: Vec<(String, String)> = match &multi.items {
                MultiSelectItems::String(items) => items
                    .values
                    .iter()
                    .map(|value| (value.clone(), value.clone()))
                    .collect(),
                MultiSelectItems::Titled(items) => items
                    .options
                    .iter()
                    .map(|option| (option.value.clone(), option.title.clone()))
                    .collect(),
                _ => Vec::new(),
            };
            let defaults = multi.default.clone().unwrap_or_default();
            let chosen = options
                .iter()
                .map(|(value, _)| defaults.contains(value))
                .collect();
            (
                multi.title.clone(),
                multi.description.clone(),
                FieldKind::Multi {
                    options,
                    chosen,
                    cursor: 0,
                    min_items: multi.min_items,
                    max_items: multi.max_items,
                },
            )
        }
        ElicitationPropertySchema::Other(other) => {
            (None, None, FieldKind::Unsupported(other.type_.clone()))
        }
        _ => (None, None, FieldKind::Unsupported("unknown".to_owned())),
    };
    Field {
        name: name.to_owned(),
        title: title.unwrap_or_else(|| name.to_owned()),
        description,
        required,
        kind,
        error: None,
    }
}

impl Field {
    fn edit(&mut self, key: KeyEvent) {
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        match &mut self.kind {
            FieldKind::Text { value, .. } | FieldKind::Number { value, .. } => match key.code {
                KeyCode::Char('u') if ctrl => value.clear(),
                KeyCode::Char(ch) if !ctrl => value.push(ch),
                KeyCode::Backspace => {
                    value.pop();
                }
                _ => return,
            },
            FieldKind::Toggle(value) => match key.code {
                KeyCode::Char(' ') | KeyCode::Left | KeyCode::Right => {
                    *value = Some(!value.unwrap_or(false))
                }
                _ => return,
            },
            FieldKind::Choice { options, selected } => {
                let count = options.len();
                if count == 0 {
                    return;
                }
                *selected = Some(match (key.code, *selected) {
                    (KeyCode::Right | KeyCode::Char(' '), None) | (KeyCode::Left, None) => 0,
                    (KeyCode::Right | KeyCode::Char(' '), Some(index)) => (index + 1) % count,
                    (KeyCode::Left, Some(index)) => (index + count - 1) % count,
                    _ => return,
                });
            }
            FieldKind::Multi {
                options,
                chosen,
                cursor,
                ..
            } => match key.code {
                KeyCode::Left => *cursor = cursor.saturating_sub(1),
                KeyCode::Right => *cursor = (*cursor + 1).min(options.len().saturating_sub(1)),
                KeyCode::Char(' ') => {
                    if let Some(item) = chosen.get_mut(*cursor) {
                        *item = !*item;
                    }
                }
                _ => return,
            },
            FieldKind::Unsupported(_) => return,
        }
        self.error = None;
    }

    /// The value to send: `None` when left empty.
    fn value(&self) -> Result<Option<ElicitationContentValue>, String> {
        match &self.kind {
            FieldKind::Text {
                value,
                format,
                min_length,
                max_length,
                pattern,
            } => {
                if value.is_empty() {
                    return Ok(None);
                }
                let length = u32::try_from(value.chars().count()).unwrap_or(u32::MAX);
                if min_length.is_some_and(|min| length < min) {
                    return Err(format!(
                        "at least {} characters",
                        min_length.unwrap_or_default()
                    ));
                }
                if max_length.is_some_and(|max| length > max) {
                    return Err(format!(
                        "at most {} characters",
                        max_length.unwrap_or_default()
                    ));
                }
                if let Some(pattern) = pattern {
                    let matches =
                        regex_lite::Regex::new(pattern).map(|regex| regex.is_match(value));
                    if matches == Ok(false) {
                        return Err(format!("must match {pattern}"));
                    }
                }
                if let Some(format) = format {
                    check_format(value, *format)?;
                }
                Ok(Some(ElicitationContentValue::String(value.clone())))
            }
            FieldKind::Number {
                value,
                integer,
                minimum,
                maximum,
            } => {
                if value.trim().is_empty() {
                    return Ok(None);
                }
                let number: f64 = value
                    .trim()
                    .parse()
                    .map_err(|_| "not a number".to_owned())?;
                if *integer && number.fract() != 0.0 {
                    return Err("must be a whole number".to_owned());
                }
                if minimum.is_some_and(|minimum| number < minimum) {
                    return Err(format!("at least {}", minimum.unwrap_or_default()));
                }
                if maximum.is_some_and(|maximum| number > maximum) {
                    return Err(format!("at most {}", maximum.unwrap_or_default()));
                }
                Ok(Some(if *integer {
                    ElicitationContentValue::Integer(number as i64)
                } else {
                    ElicitationContentValue::Number(number)
                }))
            }
            FieldKind::Toggle(value) => Ok(value.map(ElicitationContentValue::Boolean)),
            FieldKind::Choice { options, selected } => Ok(selected
                .and_then(|index| options.get(index))
                .map(|(value, _)| ElicitationContentValue::String(value.clone()))),
            FieldKind::Multi {
                options,
                chosen,
                min_items,
                max_items,
                ..
            } => {
                let values: Vec<String> = options
                    .iter()
                    .zip(chosen)
                    .filter(|(_, chosen)| **chosen)
                    .map(|((value, _), _)| value.clone())
                    .collect();
                let count = values.len() as u64;
                if min_items.is_some_and(|min| count < min) {
                    return Err(format!("choose at least {}", min_items.unwrap_or_default()));
                }
                if max_items.is_some_and(|max| count > max) {
                    return Err(format!("choose at most {}", max_items.unwrap_or_default()));
                }
                Ok((!values.is_empty()).then_some(ElicitationContentValue::StringArray(values)))
            }
            FieldKind::Unsupported(kind) => Err(format!("this client cannot edit {kind} fields")),
        }
    }

    fn value_spans(&self, focused: bool) -> Vec<Span<'static>> {
        match &self.kind {
            FieldKind::Text { value, .. } | FieldKind::Number { value, .. } => {
                vec![Span::raw(value.clone())]
            }
            FieldKind::Toggle(value) => vec![Span::raw(match value {
                Some(true) => "[x] yes",
                Some(false) => "[ ] no",
                None => "[ ] (unset)",
            })],
            FieldKind::Choice { options, selected } => {
                let current = selected
                    .and_then(|index| options.get(index))
                    .map_or("(none)".to_owned(), |(_, title)| title.clone());
                vec![Span::styled(
                    format!("◂ {current} ▸"),
                    selected_style(focused),
                )]
            }
            FieldKind::Multi {
                options,
                chosen,
                cursor,
                ..
            } => options
                .iter()
                .zip(chosen)
                .enumerate()
                .map(|(index, ((_, title), chosen))| {
                    let mark = if *chosen { "[x]" } else { "[ ]" };
                    let style = selected_style(focused && index == *cursor);
                    Span::styled(format!("{mark} {title}  "), style)
                })
                .collect(),
            FieldKind::Unsupported(kind) => vec![Span::styled(
                format!("({kind} fields are not supported)"),
                dim(),
            )],
        }
    }
}

fn check_format(value: &str, format: StringFormat) -> Result<(), String> {
    let valid = match format {
        StringFormat::Email => value
            .split_once('@')
            .is_some_and(|(local, domain)| !local.is_empty() && domain.contains('.')),
        StringFormat::Uri => url::Url::parse(value).is_ok(),
        StringFormat::Date => chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d").is_ok(),
        StringFormat::DateTime => chrono::DateTime::parse_from_rfc3339(value).is_ok(),
        _ => true,
    };
    if valid {
        Ok(())
    } else {
        let expected = match format {
            StringFormat::Email => "an email address",
            StringFormat::Uri => "a URI",
            StringFormat::Date => "a date (YYYY-MM-DD)",
            StringFormat::DateTime => "a date and time (RFC 3339)",
            _ => "a valid value",
        };
        Err(format!("must be {expected}"))
    }
}

const URL_BUTTONS: [&str; 3] = ["Open in browser", "Decline", "Cancel"];

pub struct UrlView {
    agent: String,
    message: String,
    url: String,
    pub elicitation_id: ElicitationId,
    host: Option<String>,
    warnings: Vec<String>,
    focus: usize,
}

impl UrlView {
    pub fn new(agent: &str, message: &str, url: &str, elicitation_id: ElicitationId) -> Self {
        let parsed = url::Url::parse(url).ok();
        let host = parsed
            .as_ref()
            .and_then(|url| url.host_str().map(str::to_owned));
        let mut warnings = Vec::new();
        match &parsed {
            None => warnings.push("This is not a valid URL.".to_owned()),
            Some(parsed) => {
                if parsed.scheme() != "https" {
                    warnings.push(format!("Not encrypted: uses {}.", parsed.scheme()));
                }
                if host
                    .as_deref()
                    .is_some_and(|host| host.split('.').any(|label| label.starts_with("xn--")))
                {
                    warnings
                        .push("The host uses Punycode; it may imitate another site.".to_owned());
                }
                if matches!(parsed.host(), Some(url::Host::Ipv4(_) | url::Host::Ipv6(_))) {
                    warnings.push("The host is a bare IP address.".to_owned());
                }
                if !parsed.username().is_empty() || parsed.password().is_some() {
                    warnings.push("The URL embeds credentials before the host.".to_owned());
                }
            }
        }
        Self {
            agent: agent.to_owned(),
            message: message.to_owned(),
            url: url.to_owned(),
            elicitation_id,
            host,
            warnings,
            // Consent is never the default.
            focus: 2,
        }
    }

    fn handle_key(&mut self, key: KeyEvent) -> Option<ElicitationOutcome> {
        match key.code {
            KeyCode::Esc => Some(ElicitationOutcome::Cancel),
            KeyCode::Left | KeyCode::BackTab => {
                self.focus = self.focus.saturating_sub(1);
                None
            }
            KeyCode::Right | KeyCode::Tab => {
                self.focus = (self.focus + 1).min(URL_BUTTONS.len() - 1);
                None
            }
            KeyCode::Enter => Some(match self.focus {
                0 if self.host.is_some() => ElicitationOutcome::OpenUrl(self.url.clone()),
                0 => return None,
                1 => ElicitationOutcome::Decline,
                _ => ElicitationOutcome::Cancel,
            }),
            _ => None,
        }
    }

    fn lines(&self, width: usize) -> Vec<Line<'static>> {
        let mut lines = heading(&self.agent, &self.message, width);
        lines.push(Line::from(Span::styled(
            "  It wants to open this page in your browser:",
            dim(),
        )));
        // The full URL, never shortened, with its host emphasized.
        let url_line = match &self.host {
            Some(host) => match self.url.find(host.as_str()) {
                Some(start) => Line::from(vec![
                    Span::styled(self.url[..start].to_owned(), dim()),
                    Span::styled(
                        host.clone(),
                        Style::default().add_modifier(Modifier::BOLD | Modifier::UNDERLINED),
                    ),
                    Span::styled(self.url[start + host.len()..].to_owned(), dim()),
                ]),
                None => Line::from(self.url.clone()),
            },
            None => Line::from(self.url.clone()),
        };
        lines.extend(wrap_with_prefix(
            &url_line,
            width,
            &Line::from("    "),
            &Line::from("    "),
        ));
        if let Some(host) = &self.host {
            lines.push(Line::from(vec![
                Span::styled("    host ", dim()),
                Span::styled(host.clone(), Style::default().add_modifier(Modifier::BOLD)),
            ]));
        }
        for warning in &self.warnings {
            lines.push(Line::from(Span::styled(
                format!("    ⚠ {warning}"),
                Style::default().fg(Color::Red),
            )));
        }
        lines.push(buttons(&URL_BUTTONS, Some(self.focus)));
        lines.push(Line::from(Span::styled(
            "  ←→ choose · enter confirm · esc cancel",
            dim(),
        )));
        lines
    }
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;
    use weave_acp_core::schema::BooleanPropertySchema;
    use weave_acp_core::schema::EnumOption;
    use weave_acp_core::schema::IntegerPropertySchema;
    use weave_acp_core::schema::MultiSelectPropertySchema;
    use weave_acp_core::schema::StringPropertySchema;

    use super::*;

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    fn type_text(view: &mut FormView, text: &str) {
        for ch in text.chars() {
            view.handle_key(key(KeyCode::Char(ch)));
        }
    }

    fn schema() -> ElicitationSchema {
        ElicitationSchema::new()
            .property(
                "age",
                IntegerPropertySchema::new().title("Age").minimum(0),
                false,
            )
            .property(
                "color",
                StringPropertySchema::new().title("Color").one_of(vec![
                    EnumOption::new("red", "Red"),
                    EnumOption::new("blue", "Blue"),
                ]),
                false,
            )
            .property(
                "name",
                StringPropertySchema::new().title("Name").min_length(2),
                true,
            )
            .property(
                "news",
                BooleanPropertySchema::new()
                    .title("News")
                    .default_value(true),
                false,
            )
            .property(
                "tags",
                MultiSelectPropertySchema::new(vec!["a".into(), "b".into()])
                    .title("Tags")
                    .max_items(1),
                false,
            )
    }

    #[test]
    fn submitting_validates_and_focuses_the_first_problem() {
        let mut view = FormView::new("Agent", "Who are you?", &schema());
        // Fields are ordered by name: age, color, name, news, tags.
        type_text(&mut view, "-1");
        view.focus = view.fields.len();
        assert_eq!(view.handle_key(key(KeyCode::Enter)), None);
        assert_eq!(view.focus, 0);
        assert_eq!(view.fields[0].error.as_deref(), Some("at least 0"));
        assert_eq!(view.fields[2].error.as_deref(), Some("required"));
    }

    #[test]
    fn a_valid_form_sends_typed_values_and_omits_empty_optional_fields() {
        let mut view = FormView::new("Agent", "Who are you?", &schema());
        type_text(&mut view, "36");
        view.handle_key(key(KeyCode::Tab));
        view.handle_key(key(KeyCode::Right)); // color: Red
        view.handle_key(key(KeyCode::Right)); // color: Blue
        view.handle_key(key(KeyCode::Tab));
        type_text(&mut view, "Ada");
        view.handle_key(key(KeyCode::Tab));
        view.handle_key(key(KeyCode::Char(' '))); // news: default yes → no
        view.handle_key(key(KeyCode::Tab)); // tags left empty
        view.handle_key(key(KeyCode::Tab)); // Submit
        let Some(ElicitationOutcome::Accept(Some(content))) = view.handle_key(key(KeyCode::Enter))
        else {
            panic!("expected acceptance");
        };
        assert_eq!(
            content,
            BTreeMap::from([
                ("age".to_owned(), ElicitationContentValue::Integer(36)),
                (
                    "color".to_owned(),
                    ElicitationContentValue::String("blue".into())
                ),
                (
                    "name".to_owned(),
                    ElicitationContentValue::String("Ada".into())
                ),
                ("news".to_owned(), ElicitationContentValue::Boolean(false)),
            ])
        );
    }

    #[test]
    fn decline_and_cancel_are_distinct() {
        let mut view = FormView::new("Agent", "?", &schema());
        view.focus = view.fields.len() + 1;
        assert_eq!(
            view.handle_key(key(KeyCode::Enter)),
            Some(ElicitationOutcome::Decline)
        );
        assert_eq!(
            view.handle_key(key(KeyCode::Esc)),
            Some(ElicitationOutcome::Cancel)
        );
    }

    #[test]
    fn url_prompts_show_the_host_warn_and_default_to_not_opening() {
        let mut view = UrlView::new(
            "Agent",
            "Connect",
            "http://xn--pple-43d.com/login",
            "e1".into(),
        );
        let text: Vec<String> = view.lines(80).iter().map(ToString::to_string).collect();
        assert!(
            text.contains(&"    http://xn--pple-43d.com/login".to_owned()),
            "{text:?}"
        );
        assert!(text.contains(&"    host xn--pple-43d.com".to_owned()));
        assert!(text.iter().any(|line| line.contains("Punycode")));
        assert!(text.iter().any(|line| line.contains("Not encrypted")));
        assert_eq!(
            view.handle_key(key(KeyCode::Enter)),
            Some(ElicitationOutcome::Cancel)
        );

        view.handle_key(key(KeyCode::Left));
        view.handle_key(key(KeyCode::Left));
        assert_eq!(
            view.handle_key(key(KeyCode::Enter)),
            Some(ElicitationOutcome::OpenUrl(
                "http://xn--pple-43d.com/login".into()
            ))
        );
    }
}
