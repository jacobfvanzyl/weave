//! Renders each kind of transcript entry into terminal lines.
//!
//! Cells are rendered once when committed to scrollback, except tool calls, which stay live
//! in the viewport and re-render until they reach a final status.

use std::path::Path;

use ratatui::style::Color;
use ratatui::style::Modifier;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::text::Span;
use weave_acp_core::schema::ContentBlock;
use weave_acp_core::schema::Plan;
use weave_acp_core::schema::PlanEntryStatus;
use weave_acp_core::schema::ToolCall;
use weave_acp_core::schema::ToolCallContent;
use weave_acp_core::schema::ToolCallId;
use weave_acp_core::schema::ToolCallLocation;
use weave_acp_core::schema::ToolCallStatus;
use weave_acp_core::schema::ToolCallUpdateFields;
use weave_acp_core::schema::ToolKind;

use crate::wrapping::wrap_with_prefix;

/// Tool output lines shown before the rest is summarized.
const TOOL_OUTPUT_LINES: usize = 5;

pub fn dim() -> Style {
    Style::default().add_modifier(Modifier::DIM)
}

fn bullet(style: Style) -> Line<'static> {
    Line::from(Span::styled("• ", style))
}

fn indent() -> Line<'static> {
    Line::from("  ")
}

pub fn user_message(text: &str, width: usize) -> Vec<Line<'static>> {
    let prompt = Line::from(Span::styled(
        "› ",
        Style::default()
            .fg(Color::Cyan)
            .add_modifier(Modifier::BOLD),
    ));
    text.split('\n')
        .enumerate()
        .flat_map(|(index, source_line)| {
            let first = if index == 0 { prompt.clone() } else { indent() };
            wrap_with_prefix(
                &Line::from(source_line.to_owned()),
                width,
                &first,
                &indent(),
            )
        })
        .collect()
}

pub fn info(text: &str, width: usize) -> Vec<Line<'static>> {
    let content = Line::from(Span::styled(text.to_owned(), dim()));
    wrap_with_prefix(&content, width, &bullet(dim()), &indent())
}

pub fn error(text: &str, width: usize) -> Vec<Line<'static>> {
    let red = Style::default().fg(Color::Red);
    let content = Line::from(Span::styled(text.to_owned(), red));
    wrap_with_prefix(
        &content,
        width,
        &Line::from(Span::styled("■ ", red)),
        &indent(),
    )
}

pub struct SessionHeader<'a> {
    pub agent: &'a str,
    pub agent_version: Option<&'a str>,
    pub cwd: &'a Path,
    pub mode: Option<&'a str>,
}

pub fn session_header(header: &SessionHeader<'_>, width: usize) -> Vec<Line<'static>> {
    let mut title = vec![
        Span::styled("weave", Style::default().add_modifier(Modifier::BOLD)),
        Span::styled(format!(" {}  ", env!("CARGO_PKG_VERSION")), dim()),
        Span::styled(
            header.agent.to_owned(),
            Style::default()
                .fg(Color::Cyan)
                .add_modifier(Modifier::BOLD),
        ),
    ];
    if let Some(version) = header.agent_version {
        title.push(Span::styled(format!(" {version}"), dim()));
    }
    let mut lines = wrap_with_prefix(&Line::from(title), width, &bullet(dim()), &indent());
    let mut details = format!("directory {}", header.cwd.display());
    if let Some(mode) = header.mode {
        details.push_str(&format!("  ·  mode {mode}"));
    }
    lines.extend(wrap_with_prefix(
        &Line::from(Span::styled(details, dim())),
        width,
        &indent(),
        &indent(),
    ));
    lines
}

pub fn plan(plan: &Plan, width: usize) -> Vec<Line<'static>> {
    let mut lines = vec![Line::from(vec![
        Span::styled("• ", dim()),
        Span::styled("Plan", Style::default().add_modifier(Modifier::BOLD)),
    ])];
    for entry in &plan.entries {
        let (mark, style) = match entry.status {
            PlanEntryStatus::Completed => ("✔ ", dim().add_modifier(Modifier::CROSSED_OUT)),
            PlanEntryStatus::InProgress => ("◐ ", Style::default().fg(Color::Cyan)),
            _ => ("□ ", Style::default()),
        };
        let first = Line::from(vec![
            Span::raw("  "),
            Span::styled(mark, style.remove_modifier(Modifier::CROSSED_OUT)),
        ]);
        let rest = Line::from("    ");
        let content = Line::from(Span::styled(entry.content.clone(), style));
        lines.extend(wrap_with_prefix(&content, width, &first, &rest));
    }
    lines
}

/// A tool call, folded together from its `tool_call` and every later `tool_call_update`.
pub struct ToolCallCell {
    pub id: ToolCallId,
    title: String,
    kind: ToolKind,
    pub status: ToolCallStatus,
    content: Vec<ToolCallContent>,
    locations: Vec<ToolCallLocation>,
}

impl ToolCallCell {
    pub fn new(call: ToolCall) -> Self {
        Self {
            id: call.tool_call_id,
            title: call.title,
            kind: call.kind,
            status: call.status,
            content: call.content,
            locations: call.locations,
        }
    }

    /// A cell for an update whose tool call was never announced.
    pub fn from_update(id: ToolCallId, fields: &ToolCallUpdateFields) -> Self {
        let mut cell = Self {
            id,
            title: String::new(),
            kind: ToolKind::Other,
            status: ToolCallStatus::Pending,
            content: Vec::new(),
            locations: Vec::new(),
        };
        cell.apply(fields);
        cell
    }

    /// Fold in an update. Fields it omits keep their values; collections it sends replace ours.
    pub fn apply(&mut self, fields: &ToolCallUpdateFields) {
        if let Some(title) = &fields.title {
            self.title.clone_from(title);
        }
        if let Some(kind) = fields.kind {
            self.kind = kind;
        }
        if let Some(status) = fields.status {
            self.status = status;
        }
        if let Some(content) = &fields.content {
            self.content.clone_from(content);
        }
        if let Some(locations) = &fields.locations {
            self.locations.clone_from(locations);
        }
    }

    pub fn is_finished(&self) -> bool {
        matches!(
            self.status,
            ToolCallStatus::Completed | ToolCallStatus::Failed
        )
    }

    pub fn title(&self) -> &str {
        if self.title.is_empty() {
            "Tool call"
        } else {
            &self.title
        }
    }

    /// Render with paths shown relative to `cwd` where they fall inside it.
    pub fn lines(&self, width: usize, cwd: &Path) -> Vec<Line<'static>> {
        let (mark, mark_style) = match self.status {
            ToolCallStatus::Completed => ("✓ ", Style::default().fg(Color::Green)),
            ToolCallStatus::Failed => ("✗ ", Style::default().fg(Color::Red)),
            ToolCallStatus::InProgress => ("◐ ", Style::default().fg(Color::Cyan)),
            _ => ("○ ", dim()),
        };
        let heading = Line::from(vec![
            Span::styled(
                self.title().to_owned(),
                Style::default().add_modifier(Modifier::BOLD),
            ),
            Span::styled(format!("  {}", kind_label(self.kind)), dim()),
        ]);
        let mut lines = wrap_with_prefix(
            &heading,
            width,
            &Line::from(Span::styled(mark, mark_style)),
            &indent(),
        );

        // A diff already names its file, so skip locations that would repeat it.
        let diff_paths: Vec<&Path> = self
            .content
            .iter()
            .filter_map(|content| match content {
                ToolCallContent::Diff(diff) => Some(diff.path.as_path()),
                _ => None,
            })
            .collect();
        let mut details: Vec<String> = self
            .locations
            .iter()
            .filter(|location| !diff_paths.contains(&location.path.as_path()))
            .map(|location| match location.line {
                Some(line) => format!("{}:{line}", display_path(&location.path, cwd)),
                None => display_path(&location.path, cwd),
            })
            .collect();
        for content in &self.content {
            match content {
                ToolCallContent::Content(content) => {
                    details.extend(content_lines(&content.content))
                }
                ToolCallContent::Diff(diff) => {
                    let path = display_path(&diff.path, cwd);
                    details.push(diff_summary(
                        &path,
                        diff.old_text.as_deref(),
                        &diff.new_text,
                    ));
                }
                ToolCallContent::Terminal(terminal) => {
                    details.push(format!("terminal {}", terminal.terminal_id))
                }
                _ => details.push("[unsupported tool output]".to_owned()),
            }
        }
        let hidden = details.len().saturating_sub(TOOL_OUTPUT_LINES);
        for (index, detail) in details.into_iter().take(TOOL_OUTPUT_LINES).enumerate() {
            let first = if index == 0 { "  └ " } else { "    " };
            let content = Line::from(Span::styled(detail, dim()));
            lines.extend(wrap_with_prefix(
                &content,
                width,
                &Line::from(Span::styled(first, dim())),
                &Line::from("    "),
            ));
        }
        if hidden > 0 {
            lines.push(Line::from(Span::styled(
                format!("    … +{hidden} lines"),
                dim(),
            )));
        }
        lines
    }
}

fn kind_label(kind: ToolKind) -> &'static str {
    match kind {
        ToolKind::Read => "read",
        ToolKind::Edit => "edit",
        ToolKind::Delete => "delete",
        ToolKind::Move => "move",
        ToolKind::Search => "search",
        ToolKind::Execute => "execute",
        ToolKind::Think => "think",
        ToolKind::Fetch => "fetch",
        ToolKind::SwitchMode => "switch mode",
        _ => "tool",
    }
}

fn content_lines(content: &ContentBlock) -> Vec<String> {
    match content {
        // Agents often fence tool output as markdown; the fences add nothing in a summary.
        ContentBlock::Text(text) => text
            .text
            .lines()
            .filter(|line| !line.trim_start().starts_with("```"))
            .map(str::to_owned)
            .collect(),
        ContentBlock::Image(_) => vec!["[image]".to_owned()],
        ContentBlock::Audio(_) => vec!["[audio]".to_owned()],
        ContentBlock::ResourceLink(link) => vec![link.uri.clone()],
        ContentBlock::Resource(_) => vec!["[embedded resource]".to_owned()],
        _ => vec!["[unsupported content]".to_owned()],
    }
}

/// A path relative to `cwd` when it lies inside it, otherwise as given.
pub fn display_path(path: &Path, cwd: &Path) -> String {
    match path.strip_prefix(cwd) {
        Ok(relative) if !relative.as_os_str().is_empty() => relative.display().to_string(),
        _ => path.display().to_string(),
    }
}

fn diff_summary(path: &str, old_text: Option<&str>, new_text: &str) -> String {
    let count = |text: &str| match text.lines().count() {
        1 => "1 line".to_owned(),
        lines => format!("{lines} lines"),
    };
    match old_text {
        None => format!("{path} (new file, {})", count(new_text)),
        Some(old_text) => format!("{path} ({} → {})", count(old_text), count(new_text)),
    }
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;
    use weave_acp_core::schema::Diff;
    use weave_acp_core::schema::ToolCallUpdateFields;

    use super::*;

    fn text(lines: &[Line<'_>]) -> Vec<String> {
        lines.iter().map(ToString::to_string).collect()
    }

    #[test]
    fn tool_call_folds_updates_and_summarizes_output() {
        let mut cell = ToolCallCell::new(
            ToolCall::new("call-1", "Read config")
                .kind(ToolKind::Read)
                .locations(vec![ToolCallLocation::new("/repo/config.toml").line(3)]),
        );
        cell.apply(
            &ToolCallUpdateFields::new()
                .status(ToolCallStatus::Completed)
                .content(vec![ContentBlock::from("a\nb\nc\nd\ne\nf").into()]),
        );

        assert!(cell.is_finished());
        assert_eq!(
            text(&cell.lines(40, Path::new("/repo"))),
            [
                "✓ Read config  read",
                "  └ config.toml:3",
                "    a",
                "    b",
                "    c",
                "    d",
                "    … +2 lines",
            ]
        );
    }

    #[test]
    fn diffs_replace_their_own_location_and_use_relative_paths() {
        let cell = ToolCallCell::new(
            ToolCall::new("call-2", "Write notes.txt")
                .kind(ToolKind::Edit)
                .status(ToolCallStatus::Completed)
                .locations(vec![ToolCallLocation::new("/repo/notes.txt")])
                .content(vec![ToolCallContent::Diff(Diff::new(
                    "/repo/notes.txt",
                    "hello",
                ))]),
        );
        assert_eq!(
            text(&cell.lines(60, Path::new("/repo"))),
            [
                "✓ Write notes.txt  edit",
                "  └ notes.txt (new file, 1 line)"
            ]
        );
    }

    #[test]
    fn user_messages_keep_their_line_breaks() {
        assert_eq!(
            text(&user_message("first\nsecond", 20)),
            ["› first", "  second"]
        );
    }
}
