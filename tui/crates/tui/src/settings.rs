//! Session settings: the agent's config options (or, from agents without them, its modes),
//! shown in a picker and cycled from the keyboard.
//!
//! The protocol prefers config options; modes are used only when an agent offers no config
//! options. Options of a kind this client doesn't know are skipped, as the spec asks.

use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Modifier;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::text::Span;
use weave_acp_core::schema::SessionConfigId;
use weave_acp_core::schema::SessionConfigKind;
use weave_acp_core::schema::SessionConfigOption;
use weave_acp_core::schema::SessionConfigOptionCategory;
use weave_acp_core::schema::SessionConfigOptionValue;
use weave_acp_core::schema::SessionConfigSelect;
use weave_acp_core::schema::SessionConfigSelectOptions;
use weave_acp_core::schema::SessionConfigValueId;
use weave_acp_core::schema::SessionModeId;
use weave_acp_core::schema::SessionModeState;

use crate::history_cell::dim;
use crate::style;

/// A change the user asked for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SettingChange {
    ConfigOption(SessionConfigId, SessionConfigOptionValue),
    Mode(SessionModeId),
}

/// One selectable value of a select option, with the group it belongs to, if any.
struct Choice<'a> {
    group: Option<&'a str>,
    value: &'a SessionConfigValueId,
    name: &'a str,
}

fn choices(select: &SessionConfigSelect) -> Vec<Choice<'_>> {
    match &select.options {
        SessionConfigSelectOptions::Ungrouped(options) => options
            .iter()
            .map(|option| Choice {
                group: None,
                value: &option.value,
                name: &option.name,
            })
            .collect(),
        SessionConfigSelectOptions::Grouped(groups) => groups
            .iter()
            .flat_map(|group| {
                group.options.iter().map(|option| Choice {
                    group: Some(group.name.as_str()),
                    value: &option.value,
                    name: &option.name,
                })
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// The display name of an option's current value.
pub fn current_value_name(option: &SessionConfigOption) -> Option<String> {
    match &option.kind {
        SessionConfigKind::Select(select) => choices(select)
            .into_iter()
            .find(|choice| *choice.value == select.current_value)
            .map(|choice| choice.name.to_owned())
            .or_else(|| Some(select.current_value.to_string())),
        SessionConfigKind::Boolean(boolean) => {
            Some(if boolean.current_value { "on" } else { "off" }.to_owned())
        }
        _ => None,
    }
}

fn is_supported(option: &SessionConfigOption) -> bool {
    matches!(
        option.kind,
        SessionConfigKind::Select(_) | SessionConfigKind::Boolean(_)
    )
}

/// Whether the picker (Ctrl+O) has anything to show: options this client can set, or modes.
pub fn any(options: &[SessionConfigOption], modes: Option<&SessionModeState>) -> bool {
    options.iter().any(is_supported) || modes.is_some_and(|modes| !modes.available_modes.is_empty())
}

/// The change that moves the session to its next mode, as Shift+Tab does.
pub fn next_mode(
    options: &[SessionConfigOption],
    modes: Option<&SessionModeState>,
) -> Option<SettingChange> {
    if let Some(option) = options
        .iter()
        .find(|option| option.category == Some(SessionConfigOptionCategory::Mode))
        && let SessionConfigKind::Select(select) = &option.kind
    {
        let values = choices(select);
        let current = values
            .iter()
            .position(|choice| *choice.value == select.current_value);
        let next = values.get(current.map_or(0, |index| (index + 1) % values.len()))?;
        return Some(SettingChange::ConfigOption(
            option.id.clone(),
            SessionConfigOptionValue::ValueId {
                value: next.value.clone(),
            },
        ));
    }
    if !options.is_empty() {
        return None;
    }
    let modes = modes?;
    let current = modes
        .available_modes
        .iter()
        .position(|mode| mode.id == modes.current_mode_id);
    let next = modes
        .available_modes
        .get(current.map_or(0, |index| (index + 1) % modes.available_modes.len()))?;
    Some(SettingChange::Mode(next.id.clone()))
}

/// The change that puts the session in the mode `wanted` names, by its id or by its name in
/// any case, as `[agents.<name>] mode` does for new sessions; `None` when the agent offers no
/// such mode.
pub fn mode_change(
    options: &[SessionConfigOption],
    modes: Option<&SessionModeState>,
    wanted: &str,
) -> Option<SettingChange> {
    let named = |id: &str, name: &str| id == wanted || name.eq_ignore_ascii_case(wanted);
    if let Some(option) = options
        .iter()
        .find(|option| option.category == Some(SessionConfigOptionCategory::Mode))
        && let SessionConfigKind::Select(select) = &option.kind
    {
        let choice = choices(select)
            .into_iter()
            .find(|choice| named(&choice.value.0, choice.name))?;
        return Some(SettingChange::ConfigOption(
            option.id.clone(),
            SessionConfigOptionValue::ValueId {
                value: choice.value.clone(),
            },
        ));
    }
    if !options.is_empty() {
        return None;
    }
    let mode = modes?
        .available_modes
        .iter()
        .find(|mode| named(&mode.id.0, &mode.name))?;
    Some(SettingChange::Mode(mode.id.clone()))
}

/// Short labels for the footer: mode and model first, as categories suggest.
pub fn summary(options: &[SessionConfigOption], modes: Option<&SessionModeState>) -> Vec<String> {
    if options.is_empty() {
        let mode = modes.and_then(|modes| {
            modes
                .available_modes
                .iter()
                .find(|mode| mode.id == modes.current_mode_id)
                .map(|mode| mode.name.clone())
        });
        return mode.into_iter().collect();
    }
    [
        SessionConfigOptionCategory::Mode,
        SessionConfigOptionCategory::Model,
    ]
    .iter()
    .filter_map(|category| {
        options
            .iter()
            .find(|option| option.category.as_ref() == Some(category))
    })
    .filter_map(current_value_name)
    .collect()
}

/// The name of the current value in `category`; for modes, from the legacy mode state when
/// the agent has no config options.
pub fn current(
    options: &[SessionConfigOption],
    modes: Option<&SessionModeState>,
    category: &SessionConfigOptionCategory,
) -> Option<String> {
    let option = options
        .iter()
        .find(|option| option.category.as_ref() == Some(category));
    match option {
        Some(option) => current_value_name(option),
        None if *category == SessionConfigOptionCategory::Mode => modes.and_then(|modes| {
            modes
                .available_modes
                .iter()
                .find(|mode| mode.id == modes.current_mode_id)
                .map(|mode| mode.name.clone())
        }),
        None => None,
    }
}

/// Describe what differs between two option lists, for the transcript.
pub fn describe_changes(
    before: &[SessionConfigOption],
    after: &[SessionConfigOption],
) -> Vec<String> {
    after
        .iter()
        .filter_map(|option| {
            let value = current_value_name(option)?;
            let previous = before
                .iter()
                .find(|old| old.id == option.id)
                .and_then(current_value_name);
            (previous.as_deref() != Some(value.as_str()))
                .then(|| format!("{} set to {value}", option.name))
        })
        .collect()
}

enum Page {
    Options { selected: usize },
    Values { option: usize, selected: usize },
}

pub enum PickerOutcome {
    Open,
    Close,
    /// Make the change; the picker stays open, back on its list.
    Apply(SettingChange),
}

pub struct SettingsPicker {
    page: Page,
}

impl SettingsPicker {
    pub fn new() -> Self {
        Self {
            page: Page::Options { selected: 0 },
        }
    }

    pub fn handle_key(
        &mut self,
        key: KeyEvent,
        options: &[SessionConfigOption],
        modes: Option<&SessionModeState>,
    ) -> PickerOutcome {
        let supported: Vec<&SessionConfigOption> = options
            .iter()
            .filter(|option| is_supported(option))
            .collect();
        match &mut self.page {
            Page::Options { selected } => {
                let count = if supported.is_empty() {
                    modes.map_or(0, |modes| modes.available_modes.len())
                } else {
                    supported.len()
                };
                // A change can leave the agent offering fewer options.
                *selected = (*selected).min(count.saturating_sub(1));
                match key.code {
                    KeyCode::Esc => PickerOutcome::Close,
                    KeyCode::Up | KeyCode::Char('k') => {
                        *selected = selected.saturating_sub(1);
                        PickerOutcome::Open
                    }
                    KeyCode::Down | KeyCode::Char('j') => {
                        *selected = (*selected + 1).min(count.saturating_sub(1));
                        PickerOutcome::Open
                    }
                    KeyCode::Enter | KeyCode::Char(' ') => {
                        if supported.is_empty() {
                            return modes
                                .and_then(|modes| modes.available_modes.get(*selected))
                                .map_or(PickerOutcome::Open, |mode| {
                                    PickerOutcome::Apply(SettingChange::Mode(mode.id.clone()))
                                });
                        }
                        let Some(option) = supported.get(*selected) else {
                            return PickerOutcome::Open;
                        };
                        match &option.kind {
                            SessionConfigKind::Boolean(boolean) => {
                                PickerOutcome::Apply(SettingChange::ConfigOption(
                                    option.id.clone(),
                                    SessionConfigOptionValue::boolean(!boolean.current_value),
                                ))
                            }
                            SessionConfigKind::Select(select) => {
                                let current = choices(select)
                                    .iter()
                                    .position(|choice| *choice.value == select.current_value)
                                    .unwrap_or(0);
                                self.page = Page::Values {
                                    option: *selected,
                                    selected: current,
                                };
                                PickerOutcome::Open
                            }
                            _ => PickerOutcome::Open,
                        }
                    }
                    _ => PickerOutcome::Open,
                }
            }
            Page::Values { option, selected } => {
                let Some(config) = supported.get(*option) else {
                    return PickerOutcome::Close;
                };
                let SessionConfigKind::Select(select) = &config.kind else {
                    return PickerOutcome::Close;
                };
                let values = choices(select);
                match key.code {
                    KeyCode::Esc => {
                        self.page = Page::Options { selected: *option };
                        PickerOutcome::Open
                    }
                    KeyCode::Up | KeyCode::Char('k') => {
                        *selected = selected.saturating_sub(1);
                        PickerOutcome::Open
                    }
                    KeyCode::Down | KeyCode::Char('j') => {
                        *selected = (*selected + 1).min(values.len().saturating_sub(1));
                        PickerOutcome::Open
                    }
                    // Back to the list, which stays open for more changes.
                    KeyCode::Enter => {
                        let outcome = values.get(*selected).map_or(PickerOutcome::Open, |choice| {
                            PickerOutcome::Apply(SettingChange::ConfigOption(
                                config.id.clone(),
                                SessionConfigOptionValue::ValueId {
                                    value: choice.value.clone(),
                                },
                            ))
                        });
                        self.page = Page::Options { selected: *option };
                        outcome
                    }
                    _ => PickerOutcome::Open,
                }
            }
        }
    }

    fn lines(
        &self,
        options: &[SessionConfigOption],
        modes: Option<&SessionModeState>,
    ) -> Vec<Line<'static>> {
        let supported: Vec<&SessionConfigOption> = options
            .iter()
            .filter(|option| is_supported(option))
            .collect();
        let row = |selected: bool, label: String, detail: Option<String>| {
            let style = Style::default();
            let mut spans = vec![Span::styled(
                format!("{}{label}", if selected { "› " } else { "  " }),
                style,
            )];
            if let Some(detail) = detail {
                spans.push(Span::styled(format!("  {detail}"), dim()));
            }
            let line = Line::from(spans);
            if selected {
                line.style(style::selection())
            } else {
                line
            }
        };
        let bold = Style::default().add_modifier(Modifier::BOLD);
        match &self.page {
            Page::Options { selected } => {
                let mut lines = vec![Line::from(Span::styled("  Session settings", bold))];
                if supported.is_empty() {
                    if let Some(modes) = modes {
                        for (index, mode) in modes.available_modes.iter().enumerate() {
                            let current =
                                (mode.id == modes.current_mode_id).then(|| "current".to_owned());
                            lines.push(row(index == *selected, mode.name.clone(), current));
                        }
                    }
                } else {
                    for (index, option) in supported.iter().enumerate() {
                        lines.push(row(
                            index == *selected,
                            option.name.clone(),
                            current_value_name(option),
                        ));
                    }
                }
                if lines.len() == 1 {
                    lines.push(Line::from(Span::styled(
                        "  This agent offers no settings.",
                        dim(),
                    )));
                }
                lines.push(Line::from(Span::styled(
                    "  ↑↓ choose · enter change · esc close",
                    dim(),
                )));
                lines
            }
            Page::Values { option, selected } => {
                let Some(config) = supported.get(*option) else {
                    return Vec::new();
                };
                let SessionConfigKind::Select(select) = &config.kind else {
                    return Vec::new();
                };
                let mut lines = vec![Line::from(Span::styled(format!("  {}", config.name), bold))];
                let mut group = None;
                for (index, choice) in choices(select).iter().enumerate() {
                    if choice.group.is_some() && choice.group != group {
                        group = choice.group;
                        lines.push(Line::from(Span::styled(
                            format!("  {}", choice.group.unwrap_or_default()),
                            dim(),
                        )));
                    }
                    let current =
                        (*choice.value == select.current_value).then(|| "current".to_owned());
                    let indent = if choice.group.is_some() { "  " } else { "" };
                    lines.push(row(
                        index == *selected,
                        format!("{indent}{}", choice.name),
                        current,
                    ));
                }
                lines.push(Line::from(Span::styled(
                    "  ↑↓ choose · enter select · esc back",
                    dim(),
                )));
                lines
            }
        }
    }

    pub fn desired_height(
        &self,
        options: &[SessionConfigOption],
        modes: Option<&SessionModeState>,
    ) -> u16 {
        u16::try_from(self.lines(options, modes).len()).unwrap_or(u16::MAX)
    }

    pub fn render(
        &self,
        area: Rect,
        buf: &mut Buffer,
        options: &[SessionConfigOption],
        modes: Option<&SessionModeState>,
    ) {
        for (line, y) in self.lines(options, modes).iter().zip(area.y..area.bottom()) {
            style::set_line_filled(buf, area.x, y, line, area.width);
        }
    }
}

#[cfg(test)]
mod tests {
    use crossterm::event::KeyModifiers;
    use pretty_assertions::assert_eq;
    use weave_acp_core::schema::SessionConfigSelectGroup;
    use weave_acp_core::schema::SessionConfigSelectOption;
    use weave_acp_core::schema::SessionMode;

    use super::*;

    fn options() -> Vec<SessionConfigOption> {
        vec![
            SessionConfigOption::select(
                "mode",
                "Mode",
                "ask",
                vec![
                    SessionConfigSelectOption::new("ask", "Ask"),
                    SessionConfigSelectOption::new("code", "Code"),
                ],
            )
            .category(SessionConfigOptionCategory::Mode),
            SessionConfigOption::select(
                "model",
                "Model",
                "small",
                vec![
                    SessionConfigSelectGroup::new(
                        "fast",
                        "Fast",
                        vec![SessionConfigSelectOption::new("small", "Small")],
                    ),
                    SessionConfigSelectGroup::new(
                        "smart",
                        "Smart",
                        vec![SessionConfigSelectOption::new("large", "Large")],
                    ),
                ],
            )
            .category(SessionConfigOptionCategory::Model),
            SessionConfigOption::boolean("verbose", "Verbose", false),
        ]
    }

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    fn text(lines: &[Line<'_>]) -> Vec<String> {
        lines
            .iter()
            .map(|line| line.to_string().trim_end().to_owned())
            .collect()
    }

    #[test]
    fn shift_tab_prefers_the_mode_config_option_over_modes() {
        let modes = SessionModeState::new(
            "ask",
            vec![
                SessionMode::new("ask", "Ask"),
                SessionMode::new("code", "Code"),
            ],
        );
        assert_eq!(
            next_mode(&options(), Some(&modes)),
            Some(SettingChange::ConfigOption(
                "mode".into(),
                SessionConfigOptionValue::value_id("code")
            ))
        );
        assert_eq!(
            next_mode(&[], Some(&modes)),
            Some(SettingChange::Mode("code".into()))
        );
    }

    #[test]
    fn a_default_mode_is_found_by_id_or_name() {
        let modes = SessionModeState::new(
            "ask",
            vec![
                SessionMode::new("ask", "Ask"),
                SessionMode::new("code", "Code"),
            ],
        );
        let code =
            SettingChange::ConfigOption("mode".into(), SessionConfigOptionValue::value_id("code"));
        assert_eq!(
            mode_change(&options(), Some(&modes), "code"),
            Some(code.clone())
        );
        assert_eq!(mode_change(&options(), Some(&modes), "CODE"), Some(code));
        // Modes stand in only for agents without config options, as for Shift+Tab.
        assert_eq!(
            mode_change(&[], Some(&modes), "Code"),
            Some(SettingChange::Mode("code".into()))
        );
        let others = vec![SessionConfigOption::boolean("verbose", "Verbose", false)];
        assert_eq!(mode_change(&others, Some(&modes), "code"), None);
        assert_eq!(mode_change(&options(), Some(&modes), "yolo"), None);
        assert_eq!(mode_change(&[], None, "code"), None);
    }

    #[test]
    fn picker_walks_into_grouped_values_and_applies_one() {
        let options = options();
        let mut picker = SettingsPicker::new();
        assert_eq!(
            text(&picker.lines(&options, None)),
            [
                "  Session settings",
                "› Mode  Ask",
                "  Model  Small",
                "  Verbose  off",
                "  ↑↓ choose · enter change · esc close"
            ]
        );
        picker.handle_key(key(KeyCode::Down), &options, None);
        picker.handle_key(key(KeyCode::Enter), &options, None);
        assert_eq!(
            text(&picker.lines(&options, None)),
            [
                "  Model",
                "  Fast",
                "›   Small  current",
                "  Smart",
                "    Large",
                "  ↑↓ choose · enter select · esc back"
            ]
        );
        picker.handle_key(key(KeyCode::Down), &options, None);
        assert!(matches!(
            picker.handle_key(key(KeyCode::Enter), &options, None),
            PickerOutcome::Apply(SettingChange::ConfigOption(id, value))
                if id.to_string() == "model" && value == SessionConfigOptionValue::value_id("large")
        ));
        // Back on the list, at the option just changed, for more changes.
        assert_eq!(text(&picker.lines(&options, None))[2], "› Model  Small");
    }

    #[test]
    fn booleans_toggle_directly() {
        let options = options();
        let mut picker = SettingsPicker::new();
        picker.handle_key(key(KeyCode::Down), &options, None);
        picker.handle_key(key(KeyCode::Down), &options, None);
        assert!(matches!(
            picker.handle_key(key(KeyCode::Enter), &options, None),
            PickerOutcome::Apply(SettingChange::ConfigOption(_, value)) if value == SessionConfigOptionValue::boolean(true)
        ));
    }

    #[test]
    fn summaries_and_change_descriptions_use_value_names() {
        let before = options();
        assert_eq!(summary(&before, None), ["Ask", "Small"]);
        let mut after = options();
        after[1] = SessionConfigOption::select(
            "model",
            "Model",
            "large",
            vec![SessionConfigSelectOption::new("large", "Large")],
        );
        assert_eq!(describe_changes(&before, &after), ["Model set to Large"]);
    }
}
