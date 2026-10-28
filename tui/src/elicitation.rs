//! `elicitation/create` prompts: a form to fill in, or a URL to consent to opening.
//!
//! The spec requires naming the requesting agent, letting the user review and edit form
//! answers before sending, offering distinct decline and cancel actions, and, for URLs,
//! showing the full URL with its host before consent, never opening it without consent.
//!
//! A choice is a list of its options, which the person can pick and take back. The free text
//! an agent's question carries beside its options (`conventions::companion_of`) is the
//! choice's last row, typed into in place: Claude's Other answers instead of a pick, or joins
//! a multi-select's, and Codex's note goes with the pick. The answer is the fields asked for.

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
use weave_acp_core::schema::EnumOption;
use weave_acp_core::schema::MultiSelectItems;
use weave_acp_core::schema::StringFormat;

use crate::conventions;
use crate::conventions::Companion;
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
            Self::Form(form) => form.lines(usize::from(width)).lines.len(),
            Self::Url(url) => url.lines(usize::from(width)).len(),
        };
        u16::try_from(lines).unwrap_or(u16::MAX)
    }

    pub fn render(&self, area: Rect, buf: &mut Buffer) -> Option<Position> {
        let FormLines {
            lines,
            cursor,
            focus,
        } = match self {
            Self::Form(form) => form.lines(usize::from(area.width)),
            Self::Url(url) => FormLines {
                lines: url.lines(usize::from(area.width)),
                cursor: None,
                focus: 0,
            },
        };
        // A form taller than its room scrolls to keep the focus in view, with a line below it.
        let height = usize::from(area.height);
        let skip = (focus + 2)
            .saturating_sub(height)
            .min(lines.len().saturating_sub(height));
        for (line, y) in lines.iter().skip(skip).zip(area.y..area.bottom()) {
            buf.set_line(area.x, y, line, area.width);
        }
        cursor.and_then(|(row, column)| {
            let y = area.y + u16::try_from(row.checked_sub(skip)?).ok()?;
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
        options: Vec<Choice>,
        picked: Option<Pick>,
        other: Option<Other>,
    },
    Multi {
        options: Vec<Choice>,
        chosen: Vec<bool>,
        other: Option<Other>,
        min_items: Option<u64>,
        max_items: Option<u64>,
    },
    /// A property type this client cannot render.
    Unsupported(String),
}

/// One of a choice's options.
struct Choice {
    value: String,
    title: String,
    description: Option<String>,
}

/// A choice's free-text companion ([`conventions::companion_of`]), drawn as its last row.
struct Other {
    /// The field the agent asked for it as.
    name: String,
    title: String,
    text: String,
    companion: Companion,
}

impl Other {
    /// What was typed, unless it's blank.
    fn typed(&self) -> Option<&str> {
        (!self.text.trim().is_empty()).then_some(self.text.as_str())
    }
}

/// What a single choice has picked.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Pick {
    Option(usize),
    /// Its Other row, whose text answers in place of an option.
    Other,
}

struct Field {
    name: String,
    title: String,
    description: Option<String>,
    required: bool,
    kind: FieldKind,
    error: Option<String>,
    /// The row a choice has focused: an option, or its Other row after them.
    row: usize,
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

/// A form's lines, where the terminal cursor goes (row and column) while text is typed, and
/// the line the focus is on.
struct FormLines {
    lines: Vec<Line<'static>>,
    cursor: Option<(usize, u16)>,
    focus: usize,
}

impl FormView {
    pub fn new(agent: &str, message: &str, schema: &ElicitationSchema) -> Self {
        let required = schema.required.clone().unwrap_or_default();
        // A choice's companion joins it as its last row, rather than being a field of its own.
        let mut companions: BTreeMap<String, Other> = BTreeMap::new();
        let mut fields = Vec::new();
        for (name, property) in &schema.properties {
            let companion = conventions::companion_of(name, property, &schema.properties)
                .filter(|(choice, _)| !required.contains(name) && !companions.contains_key(choice));
            if let (Some((choice, companion)), ElicitationPropertySchema::String(string)) =
                (companion, property)
            {
                companions.insert(
                    choice,
                    Other {
                        name: name.clone(),
                        // Its description is the adapter's, for a client that draws it apart.
                        title: string.title.clone().unwrap_or_else(|| name.clone()),
                        text: string.default.clone().unwrap_or_default(),
                        companion,
                    },
                );
                continue;
            }
            fields.push(field(name, property, required.contains(name)));
        }
        for field in &mut fields {
            if let FieldKind::Choice { other, .. } | FieldKind::Multi { other, .. } =
                &mut field.kind
            {
                *other = companions.remove(&field.name);
            }
        }
        Self {
            agent: agent.to_owned(),
            message: message.to_owned(),
            title: schema.title.clone(),
            fields,
            focus: 0,
        }
    }

    fn handle_key(&mut self, key: KeyEvent) -> Option<ElicitationOutcome> {
        match key.code {
            KeyCode::Esc => return Some(ElicitationOutcome::Cancel),
            KeyCode::Tab => self.focus_by(1),
            KeyCode::BackTab => self.focus_by(-1),
            // Through a choice's rows, and on to the fields beside it past either end.
            KeyCode::Down => {
                if !self.fields.get_mut(self.focus).is_some_and(Field::row_down) {
                    self.focus_by(1);
                }
            }
            KeyCode::Up => {
                if !self.fields.get_mut(self.focus).is_some_and(Field::row_up) {
                    self.focus_by(-1);
                    if let Some(field) = self.fields.get_mut(self.focus) {
                        field.row = field.rows() - 1;
                    }
                }
            }
            KeyCode::Enter => match self.focus.checked_sub(self.fields.len()) {
                Some(0) => return self.submit(),
                Some(1) => return Some(ElicitationOutcome::Decline),
                Some(_) => return Some(ElicitationOutcome::Cancel),
                // Enter in a field picks the option it's on and moves on, so a stray Enter never
                // submits half a form.
                None => {
                    if let Some(field) = self.fields.get_mut(self.focus) {
                        field.enter();
                    }
                    self.focus_by(1);
                }
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

    /// Focus the field or button `step` stops away, wrapping, on its first row.
    fn focus_by(&mut self, step: isize) {
        let stops = self.fields.len() + BUTTONS.len();
        self.focus = (self.focus + stops).saturating_add_signed(step) % stops;
        if let Some(field) = self.fields.get_mut(self.focus) {
            field.row = 0;
        }
    }

    fn paste(&mut self, text: &str) {
        if let Some(field) = self.fields.get_mut(self.focus) {
            field.paste(&text.replace(['\r', '\n'], " "));
        }
    }

    /// Validate everything; on success, the values to send (empty optional fields omitted).
    fn submit(&mut self) -> Option<ElicitationOutcome> {
        let mut content = BTreeMap::new();
        let mut first_invalid = None;
        for (index, field) in self.fields.iter_mut().enumerate() {
            let other = field.other_value();
            match field.value() {
                Ok(Some(value)) => {
                    content.insert(field.name.clone(), value);
                    field.error = None;
                }
                // An Other that answers in place of a pick answers the question.
                Ok(None) if field.required && !field.answered_by_other() => {
                    field.error = Some("required".to_owned());
                }
                Ok(None) => field.error = None,
                Err(error) => field.error = Some(error),
            }
            if let Some((name, value)) = other {
                content.insert(name, value);
            }
            if field.error.is_some() && first_invalid.is_none() {
                first_invalid = Some(index);
            }
        }
        match first_invalid {
            Some(index) => {
                self.focus = index;
                if let Some(field) = self.fields.get_mut(index) {
                    field.row = 0;
                }
                None
            }
            None => Some(ElicitationOutcome::Accept(Some(content))),
        }
    }

    fn lines(&self, width: usize) -> FormLines {
        let mut lines = heading(&self.agent, &self.message, width);
        if let Some(title) = &self.title {
            lines.push(Line::from(Span::styled(format!("  {title}"), dim())));
        }
        // Choices are lists under their titles; other fields line up beside their labels.
        let label_width = self
            .fields
            .iter()
            .filter(|field| !field.is_list())
            .map(|field| field.title.width() + usize::from(field.required) * 2)
            .max()
            .unwrap_or(0)
            .min(24);
        let mut cursor = None;
        let mut focus = 0;
        for (index, field) in self.fields.iter().enumerate() {
            let focused = index == self.focus;
            if focused {
                focus = lines.len();
            }
            if field.is_list() {
                let list = field.list_lines(focused, width, lines.len());
                if focused {
                    focus = list.focus;
                    cursor = list.cursor;
                }
                lines.extend(list.lines);
                continue;
            }
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
        if focused_button.is_some() {
            focus = lines.len();
        }
        lines.push(buttons(&BUTTONS, focused_button));
        lines.push(Line::from(Span::styled(
            "  ↑↓ move · space pick · ⌫ clear · enter on a button · esc cancel",
            dim(),
        )));
        FormLines {
            lines,
            cursor,
            focus,
        }
    }
}

fn options_of(options: &[EnumOption]) -> Vec<Choice> {
    options
        .iter()
        .map(|option| Choice {
            value: option.value.clone(),
            title: option.title.clone(),
            description: option.description.clone(),
        })
        .collect()
}

fn plain_options(values: &[String]) -> Vec<Choice> {
    values
        .iter()
        .map(|value| Choice {
            value: value.clone(),
            title: value.clone(),
            description: None,
        })
        .collect()
}

fn field(name: &str, property: &ElicitationPropertySchema, required: bool) -> Field {
    let (title, description, kind) = match property {
        ElicitationPropertySchema::String(string) => {
            let options = string
                .one_of
                .as_deref()
                .map(options_of)
                .or_else(|| string.enum_values.as_deref().map(plain_options));
            let kind = match options {
                Some(options) => {
                    let picked = string
                        .default
                        .as_ref()
                        .and_then(|default| {
                            options.iter().position(|option| &option.value == default)
                        })
                        .map(Pick::Option);
                    FieldKind::Choice {
                        options,
                        picked,
                        other: None,
                    }
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
            let options = match &multi.items {
                MultiSelectItems::String(items) => plain_options(&items.values),
                MultiSelectItems::Titled(items) => options_of(&items.options),
                _ => Vec::new(),
            };
            let defaults = multi.default.clone().unwrap_or_default();
            let chosen = options
                .iter()
                .map(|option| defaults.contains(&option.value))
                .collect();
            (
                multi.title.clone(),
                multi.description.clone(),
                FieldKind::Multi {
                    options,
                    chosen,
                    other: None,
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
        row: 0,
    }
}

/// Type into `text`; returns whether the key was for it.
fn edit_text(text: &mut String, key: KeyEvent) -> bool {
    let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
    match key.code {
        KeyCode::Char('u') if ctrl => text.clear(),
        KeyCode::Char(ch) if !ctrl => text.push(ch),
        KeyCode::Backspace => {
            text.pop();
        }
        _ => return false,
    }
    true
}

impl Field {
    /// A choice, drawn as a list of its options.
    fn is_list(&self) -> bool {
        matches!(
            self.kind,
            FieldKind::Choice { .. } | FieldKind::Multi { .. }
        )
    }

    fn rows(&self) -> usize {
        match &self.kind {
            FieldKind::Choice { options, other, .. } | FieldKind::Multi { options, other, .. } => {
                (options.len() + usize::from(other.is_some())).max(1)
            }
            _ => 1,
        }
    }

    fn row_down(&mut self) -> bool {
        let down = self.row + 1 < self.rows();
        if down {
            self.row += 1;
        }
        down
    }

    fn row_up(&mut self) -> bool {
        let up = self.row > 0;
        if up {
            self.row -= 1;
        }
        up
    }

    /// The companion on the focused row, if that's where the focus is.
    fn other_row(&mut self) -> Option<&mut Other> {
        match &mut self.kind {
            FieldKind::Choice { options, other, .. } | FieldKind::Multi { options, other, .. }
                if self.row >= options.len() =>
            {
                other.as_mut()
            }
            _ => None,
        }
    }

    /// Enter on a single choice's row picks it: an option, or an Other holding text.
    fn enter(&mut self) {
        if let FieldKind::Choice {
            options,
            picked,
            other,
        } = &mut self.kind
        {
            if self.row < options.len() {
                *picked = Some(Pick::Option(self.row));
            } else if other.as_ref().is_some_and(|other| {
                other.companion == Companion::Replaces && other.typed().is_some()
            }) {
                *picked = Some(Pick::Other);
            }
            self.error = None;
        }
    }

    fn paste(&mut self, text: &str) {
        match &mut self.kind {
            FieldKind::Text { value, .. } | FieldKind::Number { value, .. } => {
                value.push_str(text);
            }
            _ => match self.other_row() {
                Some(other) => other.text.push_str(text),
                None => return,
            },
        }
        self.typed_other();
        self.error = None;
    }

    /// After typing on a single choice's Other row: its text answers in place of an option
    /// while it holds any, as Claude's Other does.
    fn typed_other(&mut self) {
        if let FieldKind::Choice {
            options,
            picked,
            other: Some(other),
        } = &mut self.kind
            && self.row >= options.len()
            && other.companion == Companion::Replaces
        {
            if other.typed().is_some() {
                *picked = Some(Pick::Other);
            } else if *picked == Some(Pick::Other) {
                *picked = None;
            }
        }
    }

    fn edit(&mut self, key: KeyEvent) {
        let clear = matches!(key.code, KeyCode::Backspace | KeyCode::Delete);
        if let Some(other) = self.other_row() {
            if edit_text(&mut other.text, key) {
                self.typed_other();
                self.error = None;
            }
            return;
        }
        // Space or a row's digit picks; picking what's picked again clears it, as Backspace and
        // Delete do, unless an answer is required.
        let target = |count: usize, row: usize| match key.code {
            KeyCode::Char(' ') => Some(row),
            KeyCode::Char(digit @ '1'..='9') => {
                Some(digit as usize - '1' as usize).filter(|index| *index < count)
            }
            _ => None,
        };
        let optional = !self.required;
        match &mut self.kind {
            FieldKind::Text { value, .. } | FieldKind::Number { value, .. } => {
                if !edit_text(value, key) {
                    return;
                }
            }
            FieldKind::Toggle(value) => match key.code {
                KeyCode::Char(' ') | KeyCode::Left | KeyCode::Right => {
                    *value = Some(!value.unwrap_or(false));
                }
                _ if clear && optional => *value = None,
                _ => return,
            },
            FieldKind::Choice {
                options, picked, ..
            } => match target(options.len(), self.row) {
                Some(index) => {
                    self.row = index;
                    *picked = if *picked == Some(Pick::Option(index)) && optional {
                        None
                    } else {
                        Some(Pick::Option(index))
                    };
                }
                None if clear && optional => *picked = None,
                None => return,
            },
            FieldKind::Multi {
                options, chosen, ..
            } => match target(options.len(), self.row) {
                Some(index) => {
                    self.row = index;
                    if let Some(item) = chosen.get_mut(index) {
                        *item = !*item;
                    }
                }
                None if clear => {
                    if let Some(item) = chosen.get_mut(self.row) {
                        *item = false;
                    }
                }
                None => return,
            },
            FieldKind::Unsupported(_) => return,
        }
        self.error = None;
    }

    /// The companion's value to send beside the field's own, when it has one: an Other that
    /// answers in place of the pick only while chosen, a multi-select's Other and a note when
    /// they hold text.
    fn other_value(&self) -> Option<(String, ElicitationContentValue)> {
        let (other, sent) = match &self.kind {
            FieldKind::Choice {
                picked,
                other: Some(other),
                ..
            } => (
                other,
                other.companion == Companion::Note || *picked == Some(Pick::Other),
            ),
            FieldKind::Multi {
                other: Some(other), ..
            } => (other, true),
            _ => return None,
        };
        let text = other.typed().filter(|_| sent)?;
        Some((
            other.name.clone(),
            ElicitationContentValue::String(text.to_owned()),
        ))
    }

    fn answered_by_other(&self) -> bool {
        let replaces = match &self.kind {
            FieldKind::Choice { other, .. } | FieldKind::Multi { other, .. } => other
                .as_ref()
                .is_some_and(|other| other.companion == Companion::Replaces),
            _ => false,
        };
        replaces && self.other_value().is_some()
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
            FieldKind::Choice {
                options, picked, ..
            } => Ok(match picked {
                Some(Pick::Option(index)) => options
                    .get(*index)
                    .map(|option| ElicitationContentValue::String(option.value.clone())),
                Some(Pick::Other) | None => None,
            }),
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
                    .map(|(option, _)| option.value.clone())
                    .collect();
                // A multi-select's Other is one more of its items.
                let count = values.len() as u64 + u64::from(self.answered_by_other());
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

    /// A choice under its title, one numbered row per option with its description dimmed
    /// under it, as a permission request lists its options, and its companion last, which
    /// takes typing. `start` is the line it starts on.
    fn list_lines(&self, focused: bool, width: usize, start: usize) -> FormLines {
        let (options, other) = match &self.kind {
            FieldKind::Choice { options, other, .. } | FieldKind::Multi { options, other, .. } => {
                (options.as_slice(), other.as_ref())
            }
            _ => (&[][..], None),
        };
        let marker = if self.required { " *" } else { "" };
        let title = Line::from(Span::styled(
            format!(
                "{}{}{marker}",
                if focused { "› " } else { "  " },
                self.title
            ),
            focus_style(focused),
        ));
        let indent = Line::from("    ");
        let mut lines = wrap_with_prefix(&title, width, &Line::default(), &indent);
        let mut focus = start;
        let mut cursor = None;
        let dimmed = |text: &str| Line::from(Span::styled(text.to_owned(), dim()));
        if let Some(description) = &self.description {
            lines.extend(wrap_with_prefix(
                &dimmed(description),
                width,
                &indent,
                &indent,
            ));
        }
        if let Some(error) = &self.error {
            lines.push(Line::from(Span::styled(
                format!("    {error}"),
                Style::default().fg(Color::Red),
            )));
        }
        let digits = options.len().max(1).to_string().len();
        let lead = |on: bool| if on { "  › " } else { "    " };
        for (index, option) in options.iter().enumerate() {
            let on = focused && self.row == index;
            let mark = match &self.kind {
                FieldKind::Choice { picked, .. } if *picked == Some(Pick::Option(index)) => "(•)",
                FieldKind::Choice { .. } => "( )",
                FieldKind::Multi { chosen, .. } if chosen.get(index) == Some(&true) => "[x]",
                _ => "[ ]",
            };
            let first = Line::from(format!("{}{:>digits$}. ", lead(on), index + 1));
            let hanging = Line::from(" ".repeat(first.width() + 4));
            let row = Line::from(format!("{mark} {}", option.title));
            if on {
                focus = start + lines.len();
            }
            lines.extend(
                wrap_with_prefix(&row, width, &first, &hanging)
                    .into_iter()
                    .map(|line| {
                        if on {
                            line.style(style::selection())
                        } else {
                            line
                        }
                    }),
            );
            if let Some(description) = &option.description {
                lines.extend(wrap_with_prefix(
                    &dimmed(description),
                    width,
                    &hanging,
                    &hanging,
                ));
            }
        }
        if let Some(other) = other {
            let on = focused && self.row >= options.len();
            let mark = match (&self.kind, other.companion) {
                (_, Companion::Note) => "",
                (FieldKind::Choice { picked, .. }, _) if *picked == Some(Pick::Other) => "(•) ",
                (FieldKind::Choice { .. }, _) => "( ) ",
                _ if other.typed().is_some() => "[x] ",
                _ => "[ ] ",
            };
            let label = format!("{}{:digits$}  {mark}{}: ", lead(on), "", other.title);
            if on {
                focus = start + lines.len();
                cursor = Some((
                    focus,
                    u16::try_from(label.width() + other.text.width()).unwrap_or(0),
                ));
            }
            let row = Line::from(vec![Span::raw(label), Span::raw(other.text.clone())]);
            lines.push(if on {
                row.style(style::selection())
            } else {
                row
            });
        }
        FormLines {
            lines,
            cursor,
            focus,
        }
    }

    fn value_spans(&self, focused: bool) -> Vec<Span<'static>> {
        match &self.kind {
            FieldKind::Text { value, .. } | FieldKind::Number { value, .. } => {
                vec![Span::raw(value.clone())]
            }
            FieldKind::Toggle(value) => vec![Span::styled(
                match value {
                    Some(true) => "[x] yes",
                    Some(false) => "[ ] no",
                    None => "[ ] (unset)",
                },
                selected_style(focused),
            )],
            FieldKind::Unsupported(kind) => vec![Span::styled(
                format!("({kind} fields are not supported)"),
                dim(),
            )],
            FieldKind::Choice { .. } | FieldKind::Multi { .. } => Vec::new(),
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
        view.handle_key(key(KeyCode::Char('1'))); // color: Red
        view.handle_key(key(KeyCode::Char('2'))); // color: Blue
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

    /// What the form sends from its Submit button.
    fn sent(view: &mut FormView) -> BTreeMap<String, ElicitationContentValue> {
        view.focus = view.fields.len();
        match view.handle_key(key(KeyCode::Enter)) {
            Some(ElicitationOutcome::Accept(Some(content))) => content,
            outcome => panic!("expected acceptance, got {outcome:?}"),
        }
    }

    fn text(value: &str) -> ElicitationContentValue {
        ElicitationContentValue::String(value.to_owned())
    }

    fn form(name: &str) -> FormView {
        let form = weave_fake_agent::question_forms()
            .into_iter()
            .find(|form| form.name == name)
            .expect("the fake agent asks it");
        FormView::new("Agent", form.message, &form.schema)
    }

    #[test]
    fn an_optional_pick_or_yes_no_can_be_taken_back_and_a_required_pick_only_changed() {
        let options = || vec![EnumOption::new("a", "A"), EnumOption::new("b", "B")];
        let schema = ElicitationSchema::new()
            .property(
                "color",
                StringPropertySchema::new().one_of(options()),
                false,
            )
            .property("env", StringPropertySchema::new().one_of(options()), true)
            .property(
                "news",
                BooleanPropertySchema::new().default_value(true),
                false,
            );
        let mut view = FormView::new("Agent", "?", &schema);
        // Picking the picked option again clears it, and so does Backspace.
        view.handle_key(key(KeyCode::Char('1')));
        view.handle_key(key(KeyCode::Char('1')));
        assert_eq!(view.fields[0].value(), Ok(None));
        view.handle_key(key(KeyCode::Char(' ')));
        assert_eq!(view.fields[0].value(), Ok(Some(text("a"))));
        view.handle_key(key(KeyCode::Backspace));
        assert_eq!(view.fields[0].value(), Ok(None));
        view.handle_key(key(KeyCode::Tab));
        view.handle_key(key(KeyCode::Char('2')));
        view.handle_key(key(KeyCode::Char('2')));
        view.handle_key(key(KeyCode::Delete));
        assert_eq!(view.fields[1].value(), Ok(Some(text("b"))));
        view.handle_key(key(KeyCode::Tab));
        view.handle_key(key(KeyCode::Backspace));
        assert_eq!(
            sent(&mut view),
            BTreeMap::from([("env".to_owned(), text("b"))])
        );
    }

    #[test]
    fn enter_picks_the_option_it_is_on_and_moves_on() {
        let mut view = form("codex");
        view.handle_key(key(KeyCode::Down));
        view.handle_key(key(KeyCode::Enter));
        assert_eq!(view.focus, 1);
        assert_eq!(
            sent(&mut view),
            BTreeMap::from([("deploy_target".to_owned(), text("Production"))])
        );
    }

    #[test]
    fn claudes_other_answers_in_place_of_a_pick_and_an_option_in_place_of_it() {
        let mut view = form("claude");
        // Each question's Other is its last row, not a field of its own.
        assert_eq!(view.fields.len(), 2);
        view.handle_key(key(KeyCode::Down));
        view.handle_key(key(KeyCode::Down));
        type_text(&mut view, "MySQL 8");
        assert_eq!(
            sent(&mut view),
            BTreeMap::from([("question_0_custom".to_owned(), text("MySQL 8"))])
        );
        view.focus = 0;
        view.fields[0].row = 0;
        view.handle_key(key(KeyCode::Char('1')));
        assert_eq!(
            sent(&mut view),
            BTreeMap::from([("question_0".to_owned(), text("Postgres"))])
        );
        // The text was kept, and choosing Other again sends it.
        view.focus = 0;
        view.fields[0].row = 2;
        view.handle_key(key(KeyCode::Enter));
        assert_eq!(
            sent(&mut view),
            BTreeMap::from([("question_0_custom".to_owned(), text("MySQL 8"))])
        );
        // Erased, it answers nothing.
        view.focus = 0;
        view.fields[0].row = 2;
        view.handle_key(KeyEvent::new(KeyCode::Char('u'), KeyModifiers::CONTROL));
        assert_eq!(sent(&mut view), BTreeMap::new());
    }

    #[test]
    fn claudes_other_joins_a_multi_selects_picks() {
        let mut view = form("claude");
        view.handle_key(key(KeyCode::Tab));
        view.handle_key(key(KeyCode::Char('1')));
        view.handle_key(key(KeyCode::Char('2')));
        view.handle_key(key(KeyCode::Down));
        view.handle_key(key(KeyCode::Down));
        view.paste("Bench\nmarks");
        assert_eq!(
            sent(&mut view),
            BTreeMap::from([
                (
                    "question_1".to_owned(),
                    ElicitationContentValue::StringArray(vec!["Tests".into(), "Lint".into()])
                ),
                ("question_1_custom".to_owned(), text("Bench marks")),
            ])
        );
    }

    #[test]
    fn codexs_note_goes_with_the_pick() {
        let mut view = form("codex");
        assert_eq!(view.fields.len(), 1);
        // The question is required: a note alone doesn't answer it.
        view.fields[0].row = 3;
        type_text(&mut view, "after 5pm");
        view.focus = view.fields.len();
        assert_eq!(view.handle_key(key(KeyCode::Enter)), None);
        assert_eq!(view.fields[0].error.as_deref(), Some("required"));
        view.handle_key(key(KeyCode::Char('3')));
        assert_eq!(
            sent(&mut view),
            BTreeMap::from([
                ("deploy_target".to_owned(), text("None of the above")),
                ("deploy_target_note".to_owned(), text("after 5pm")),
            ])
        );
    }

    #[test]
    fn a_companion_of_no_choice_stays_a_field_of_its_own() {
        let schema = ElicitationSchema::new()
            .property("name", StringPropertySchema::new().title("Name"), false)
            .property(
                "name_custom",
                StringPropertySchema::new().title("Other"),
                false,
            );
        let mut view = FormView::new("Agent", "?", &schema);
        assert_eq!(view.fields.len(), 2);
        view.handle_key(key(KeyCode::Tab));
        type_text(&mut view, "x");
        assert_eq!(
            sent(&mut view),
            BTreeMap::from([("name_custom".to_owned(), text("x"))])
        );
    }

    #[test]
    fn a_tall_form_scrolls_to_keep_the_focus_in_view() {
        let mut view = ElicitationView::Form(form("claude"));
        let area = Rect::new(0, 0, 60, 8);
        let mut buf = Buffer::empty(area);
        // The Checks question's Other row, near the end.
        for _ in 0..6 {
            view.handle_key(key(KeyCode::Down));
        }
        let cursor = view
            .render(area, &mut buf)
            .expect("the Other row takes typing");
        let row: String = (0..area.width)
            .map(|x| buf[(x, cursor.y)].symbol().to_owned())
            .collect();
        assert!(row.contains("[ ] Other:"), "{row:?}");
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
