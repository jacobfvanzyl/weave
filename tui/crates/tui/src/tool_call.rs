//! Tool calls in the transcript, drawn the way Codex draws its own tool cells.
//!
//! After openai/codex `codex-rs/tui/src/exec_cell/render.rs`, `history_cell/mcp.rs`,
//! `history_cell/patches.rs` and `diff_render.rs` (Apache-2.0). ACP gives each call a kind;
//! each kind maps to one of Codex's shapes:
//!
//! - execute: `• Ran cmd` (green bullet, red on failure), the command highlighted, its
//!   output under `└`, three rows of it and `+N lines` in the compact view;
//! - read and search: grouped into one `• Explored` entry (see [`ExploreGroup`]);
//! - edits with diffs: `• Edited path (+a -b)` with a numbered, tinted, highlighted diff;
//! - fetch: `• Fetched url`, or `• Searched the web for …`;
//! - anything else (MCP tools among them): `• Called title`, with its output.
//!
//! Every call renders compactly by default and in full in the detailed transcript (Ctrl+T).

use std::path::Path;
use std::time::Instant;

use ratatui::style::Style;
use ratatui::style::Stylize;
use ratatui::text::Line;
use ratatui::text::Span;
use weave_acp_core::extension_terminal_id;
use weave_acp_core::schema::ContentBlock;
use weave_acp_core::schema::Diff;
use weave_acp_core::schema::TerminalId;
use weave_acp_core::schema::ToolCall;
use weave_acp_core::schema::ToolCallContent;
use weave_acp_core::schema::ToolCallId;
use weave_acp_core::schema::ToolCallLocation;
use weave_acp_core::schema::ToolCallStatus;
use weave_acp_core::schema::ToolCallUpdateFields;
use weave_acp_core::schema::ToolKind;

use crate::conventions::ToolInput;
use crate::conventions::title_without_verb;
use crate::highlight;
use crate::permission::Subject;
use crate::status::activity_bullet;
use crate::style;
use crate::style::DiffKind;
use crate::tool_output::TerminalTranscripts;
use crate::tool_output::terminal_lines;
use crate::wrapping::DisplayLine;
use crate::wrapping::GutterLine;
use crate::wrapping::line_width;
use crate::wrapping::wrap_gutter_line;
use crate::wrapping::wrap_sourced;

/// Output rows the compact view shows, as Codex's `PREVIEW_LINES`.
const PREVIEW_ROWS: usize = 3;
/// Command rows after the first the compact view shows.
const COMMAND_ROWS: usize = 2;
/// Changed diff rows per file the compact view shows.
const DIFF_PREVIEW_ROWS: usize = 3;

pub const TRANSCRIPT_HINT: &str = "⌃t to view transcript";

/// How to draw a call.
pub struct RenderContext<'a> {
    pub cwd: &'a Path,
    pub terminals: &'a TerminalTranscripts,
    /// Everything, as the detailed transcript shows it.
    pub detail: bool,
    /// The time, for animating calls still running; `None` draws them still.
    pub now: Option<Instant>,
}

/// A tool call, folded together from its `tool_call` and every later `tool_call_update`.
#[derive(Clone)]
pub struct ToolCallCell {
    pub id: ToolCallId,
    title: String,
    /// The tool's programmatic name, when the agent gives it.
    name: Option<String>,
    kind: ToolKind,
    pub status: ToolCallStatus,
    content: Vec<ToolCallContent>,
    locations: Vec<ToolCallLocation>,
    /// What its `rawInput` says, where it follows a known convention.
    input: ToolInput,
    started: Instant,
}

impl ToolCallCell {
    pub fn new(call: ToolCall) -> Self {
        Self {
            id: call.tool_call_id,
            title: call.title,
            name: call.name,
            kind: call.kind,
            status: call.status,
            content: call.content,
            locations: call.locations,
            input: ToolInput::from_raw(call.raw_input.as_ref()),
            started: Instant::now(),
        }
    }

    /// A cell for an update whose tool call was never announced.
    pub fn from_update(id: ToolCallId, fields: &ToolCallUpdateFields) -> Self {
        let mut cell = Self::new(ToolCall::new(id, ""));
        cell.kind = ToolKind::Other;
        cell.status = ToolCallStatus::Pending;
        cell.apply(fields);
        cell
    }

    /// Fold in an update. Fields it omits keep their values; collections it sends replace ours.
    pub fn apply(&mut self, fields: &ToolCallUpdateFields) {
        if let Some(title) = &fields.title {
            self.title.clone_from(title);
        }
        if let Some(name) = &fields.name {
            self.name = Some(name.clone());
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
        if let Some(raw_input) = &fields.raw_input {
            self.input = ToolInput::from_raw(Some(raw_input));
        }
    }

    /// The terminals whose output this call embeds.
    /// The terminals this call embeds, and its own id, under which agents report the output
    /// of commands they show without a terminal (see `weave_acp_core`'s terminal extension).
    pub fn terminal_ids(&self) -> Vec<TerminalId> {
        let mut ids: Vec<TerminalId> = self
            .content
            .iter()
            .filter_map(|content| match content {
                ToolCallContent::Terminal(terminal) => Some(terminal.terminal_id.clone()),
                _ => None,
            })
            .collect();
        ids.push(self.own_terminal());
        ids
    }

    fn own_terminal(&self) -> TerminalId {
        extension_terminal_id(&self.id)
    }

    pub fn is_finished(&self) -> bool {
        matches!(
            self.status,
            ToolCallStatus::Completed | ToolCallStatus::Failed
        )
    }

    fn failed(&self) -> bool {
        self.status == ToolCallStatus::Failed
    }

    pub fn title(&self) -> &str {
        if self.title.is_empty() {
            "Tool call"
        } else {
            &self.title
        }
    }

    /// Reads and searches, which group into one `Explored` entry.
    pub fn is_exploration(&self) -> bool {
        matches!(self.kind, ToolKind::Read | ToolKind::Search) && !self.has_diff()
    }

    fn has_diff(&self) -> bool {
        self.content
            .iter()
            .any(|content| matches!(content, ToolCallContent::Diff(_)))
    }

    pub fn lines(&self, width: usize, cx: &RenderContext<'_>) -> Vec<DisplayLine> {
        if self.has_diff() {
            return self.edit_lines(width, cx);
        }
        match self.kind {
            ToolKind::Execute => self.command_lines(width, cx),
            ToolKind::Read | ToolKind::Search => {
                ExploreGroup::from_calls(vec![self.clone()]).lines(width, cx, false)
            }
            ToolKind::Fetch => {
                self.titled_lines("Fetching", "Fetched", &self.fetch_target(), true, width, cx)
            }
            ToolKind::Edit | ToolKind::Delete | ToolKind::Move => self.titled_lines(
                "Editing",
                "Edited",
                &self.edit_target(cx.cwd),
                true,
                width,
                cx,
            ),
            _ => self.titled_lines("Calling", "Called", self.title(), true, width, cx),
        }
    }

    /// The bullet: green or red once finished, animated while running.
    fn bullet(&self, now: Option<Instant>) -> Span<'static> {
        match (self.status, now) {
            (ToolCallStatus::Completed, _) => "•".green().bold(),
            (ToolCallStatus::Failed, _) => "•".red().bold(),
            (_, Some(now)) => activity_bullet(now.saturating_duration_since(self.started)),
            (_, None) => "•".dim(),
        }
    }

    fn header(&self, running: &str, done: &str, now: Option<Instant>) -> Line<'static> {
        let verb = if self.is_finished() { done } else { running };
        let mut spans = vec![self.bullet(now), Span::raw(" ")];
        if !verb.is_empty() {
            spans.push(Span::styled(verb.to_owned(), Style::default().bold()));
            spans.push(Span::raw(" "));
        }
        Line::from(spans)
    }

    /// `• Ran cmd`, the command highlighted and wrapped under `│`, then its output.
    fn command_lines(&self, width: usize, cx: &RenderContext<'_>) -> Vec<DisplayLine> {
        let Some(command) = self.command() else {
            // Without the command itself, the title says what ran.
            return self.titled_lines("", "", self.title(), false, width, cx);
        };
        let header = self.header("Running", "Ran", cx.now);
        let highlighted = highlight::shell_lines(&command);
        let continuation = Line::from("  │ ".dim());
        let mut rows = Vec::new();
        for (index, line) in highlighted.iter().enumerate() {
            let first = if index == 0 { &header } else { &continuation };
            rows.extend(wrap_sourced(line, width, first, &continuation));
        }
        if !cx.detail && rows.len() > 1 + COMMAND_ROWS {
            rows.truncate(1 + COMMAND_ROWS);
            if let Some(last) = rows.last_mut() {
                last.line.spans.push("…".dim());
            }
        }
        let output = self.output(cx.terminals);
        if output.lines.is_empty() && output.exit.is_none() {
            if self.is_finished() {
                rows.extend(elbow(vec![Line::from("(no output)".dim()).into()], width));
            }
            return rows;
        }
        rows.extend(output_rows(&output, width, cx.detail));
        rows
    }

    /// The command an execute call runs, when its raw input says.
    fn command(&self) -> Option<String> {
        self.input.command.clone()
    }

    fn fetch_target(&self) -> String {
        self.input
            .url
            .clone()
            .unwrap_or_else(|| title_without_verb(self.title(), &["fetch"]))
    }

    fn edit_target(&self, cwd: &Path) -> String {
        match self.locations.first() {
            Some(location) => display_path(&location.path, cwd),
            None => title_without_verb(
                self.title(),
                &["edit", "write", "update", "create", "delete", "move"],
            ),
        }
    }

    /// `• Called title`, then any output: the shape for fetches, MCP tools and the rest.
    fn titled_lines(
        &self,
        running: &str,
        done: &str,
        target: &str,
        error_summary: bool,
        width: usize,
        cx: &RenderContext<'_>,
    ) -> Vec<DisplayLine> {
        let (running, done, target) = match self.web_search_query() {
            Some(query) => ("Searching the web for", "Searched the web for", query),
            None => (running, done, target.to_owned()),
        };
        let header = self.header(running, done, cx.now);
        let mut target = Line::from(target);
        // A called tool's programmatic name, when the title doesn't already say it, as
        // Codex shows `server.tool` for MCP calls.
        if running == "Calling"
            && let Some(name) = &self.name
            && !self.title().to_lowercase().contains(&name.to_lowercase())
        {
            target
                .spans
                .push(Span::styled(format!(" · {name}"), Style::default().dim()));
        }
        let mut rows = wrap_sourced(
            &target,
            width,
            &header,
            &Line::from(" ".repeat(line_width(&header))),
        );
        let output = self.output(cx.terminals);
        if self.failed() && error_summary && !cx.detail {
            let first = output
                .lines
                .first()
                .cloned()
                .unwrap_or_else(|| "failed".to_owned());
            let error = Line::from(vec!["Error: ".red(), Span::raw(first)]);
            rows.extend(elbow(
                wrap_sourced(
                    &error,
                    width.saturating_sub(4),
                    &Line::default(),
                    &Line::default(),
                ),
                width,
            ));
            return rows;
        }
        if !output.lines.is_empty() || output.exit.is_some() {
            rows.extend(output_rows(&output, width, cx.detail));
        }
        rows
    }

    /// A web search's query, for fetch calls that search rather than fetch a URL.
    fn web_search_query(&self) -> Option<String> {
        if self.kind != ToolKind::Fetch {
            return None;
        }
        self.input.query.clone()
    }

    /// Text and terminal output, as plain lines, with how a terminal ended.
    fn output(&self, terminals: &TerminalTranscripts) -> Output {
        let mut output = Output::default();
        for content in &self.content {
            match content {
                ToolCallContent::Content(content) => {
                    output.lines.extend(content_lines(&content.content))
                }
                ToolCallContent::Terminal(terminal) => match terminals.get(&terminal.terminal_id) {
                    Some(transcript) => {
                        output.lines.extend(terminal_lines(transcript.raw()));
                        output.exit = transcript.exit_line();
                    }
                    None if self.is_finished() => {
                        output.lines.push("terminal output unavailable".to_owned());
                    }
                    None => {}
                },
                ToolCallContent::Diff(_) => {}
                _ => output.lines.push("[unsupported tool output]".to_owned()),
            }
        }
        // Output reported under the call's own id, with no terminal content to show it in.
        let embeds_own = self.content.iter().any(|content| {
            matches!(content, ToolCallContent::Terminal(terminal) if terminal.terminal_id == self.own_terminal())
        });
        if !embeds_own && let Some(transcript) = terminals.get(&self.own_terminal()) {
            output.lines.extend(terminal_lines(transcript.raw()));
            output.exit = output.exit.or_else(|| transcript.exit_line());
        }
        output
    }

    /// `• Edited path (+a -b)` and the diff, or `• Edited N files` and one block per file.
    fn edit_lines(&self, width: usize, cx: &RenderContext<'_>) -> Vec<DisplayLine> {
        let files: Vec<FileDiff> = self
            .content
            .iter()
            .filter_map(|content| match content {
                ToolCallContent::Diff(diff) => Some(FileDiff::new(diff, cx.cwd)),
                _ => None,
            })
            .collect();
        let added: usize = files.iter().map(|file| file.added).sum();
        let removed: usize = files.iter().map(|file| file.removed).sum();
        let mut header = vec![self.bullet(cx.now), Span::raw(" ")];
        let mut rows = Vec::new();
        match files.as_slice() {
            [file] => {
                let verb = if !self.is_finished() {
                    "Editing"
                } else if self.failed() {
                    "Failed to edit"
                } else {
                    file.verb()
                };
                header.push(Span::styled(verb.to_owned(), Style::default().bold()));
                header.push(Span::raw(" "));
                header.push(Span::raw(file.path.clone()));
                header.extend(counts(file.added, file.removed));
                rows.push(DisplayLine::whole(Line::from(header)));
                rows.extend(file.rows(width, cx.detail));
            }
            files => {
                let verb = if self.is_finished() {
                    "Edited"
                } else {
                    "Editing"
                };
                header.push(Span::styled(
                    format!("{verb} {} files", files.len()),
                    Style::default().bold(),
                ));
                header.extend(counts(added, removed));
                rows.push(DisplayLine::whole(Line::from(header)));
                for (index, file) in files.iter().enumerate() {
                    if index > 0 {
                        rows.push(DisplayLine::default());
                    }
                    let mut title = vec!["  └ ".dim(), Span::raw(file.path.clone())];
                    title.extend(counts(file.added, file.removed));
                    rows.push(DisplayLine::whole(Line::from(title)));
                    rows.extend(file.rows(width, cx.detail));
                }
            }
        }
        if self.failed() {
            let output = self.output(cx.terminals);
            if let Some(first) = output.lines.first() {
                let error = Line::from(vec!["Error: ".red(), Span::raw(first.clone())]);
                rows.extend(elbow(vec![DisplayLine::whole(error)], width));
            }
        }
        rows
    }
}

/// Detail rows a permission prompt shows of a call's text output, such as a plan to approve.
const PERMISSION_DETAIL_ROWS: usize = 12;

impl ToolCallCell {
    /// What a permission prompt for this call asks, as Codex words its approvals.
    pub fn permission_subject(&self, cwd: &Path) -> Subject {
        if self.has_diff() {
            let detail = self
                .content
                .iter()
                .filter_map(|content| match content {
                    ToolCallContent::Diff(diff) => Some(diff),
                    _ => None,
                })
                .map(|diff| {
                    let file = FileDiff::new(diff, cwd);
                    let mut spans = vec![Span::raw(file.path.clone())];
                    spans.extend(counts(file.added, file.removed));
                    Line::from(spans)
                })
                .collect();
            return Subject {
                question: "Would you like to make the following edits?".to_owned(),
                detail,
            };
        }
        match self.kind {
            ToolKind::Execute => match self.command() {
                Some(command) => {
                    let mut detail = highlight::shell_lines(&command);
                    for (index, line) in detail.iter_mut().enumerate() {
                        let lead = if index == 0 {
                            "$ ".magenta()
                        } else {
                            Span::raw("  ")
                        };
                        line.spans.insert(0, lead);
                    }
                    Subject {
                        question: "Would you like to run the following command?".to_owned(),
                        detail,
                    }
                }
                None => Subject::about(self.title()),
            },
            ToolKind::Fetch => match self.web_search_query() {
                Some(query) => Subject {
                    question: "Would you like to search the web for this?".to_owned(),
                    detail: vec![Line::from(query)],
                },
                None => Subject {
                    question: "Would you like to fetch this?".to_owned(),
                    detail: vec![Line::from(self.fetch_target())],
                },
            },
            ToolKind::Edit | ToolKind::Delete | ToolKind::Move => Subject {
                question: "Would you like to make the following edits?".to_owned(),
                detail: vec![Line::from(self.edit_target(cwd))],
            },
            ToolKind::Read => Subject {
                question: "Would you like to allow this read?".to_owned(),
                detail: vec![Line::from(self.read_names(cwd).join(", "))],
            },
            ToolKind::Search => Subject {
                question: "Would you like to allow this search?".to_owned(),
                detail: vec![Line::from(self.search_target())],
            },
            // Anything else, such as a plan to approve before switching modes: its title,
            // and its text output, which is what is being approved.
            _ => {
                let output = self.content.iter().flat_map(|content| match content {
                    ToolCallContent::Content(content) => content_lines(&content.content),
                    _ => Vec::new(),
                });
                let lines: Vec<String> = output.collect();
                let hidden = lines.len().saturating_sub(PERMISSION_DETAIL_ROWS);
                let mut detail: Vec<Line<'static>> = lines
                    .into_iter()
                    .take(PERMISSION_DETAIL_ROWS)
                    .map(|line| Line::from(line.dim()))
                    .collect();
                if hidden > 0 {
                    detail.push(Line::from(format!("… +{hidden} lines").dim()));
                }
                Subject {
                    detail,
                    ..Subject::about(self.title())
                }
            }
        }
    }
}

/// Output lines and, for a terminal, how it ended.
#[derive(Default)]
struct Output {
    lines: Vec<String>,
    exit: Option<Line<'static>>,
}

/// Output under `└`: three rows and a count of the rest when compact, all of it otherwise.
fn output_rows(output: &Output, width: usize, detail: bool) -> Vec<DisplayLine> {
    let inner = width.saturating_sub(4).max(1);
    let mut rows: Vec<DisplayLine> = Vec::new();
    let mut shown_lines = 0;
    let mut full = false;
    for line in &output.lines {
        let wrapped = wrap_sourced(
            &Line::from(line.clone().dim()),
            inner,
            &Line::default(),
            &Line::default(),
        );
        if !detail && rows.len() + wrapped.len() > PREVIEW_ROWS {
            let room = PREVIEW_ROWS.saturating_sub(rows.len());
            rows.extend(wrapped.into_iter().take(room));
            full = true;
            break;
        }
        rows.extend(wrapped);
        shown_lines += 1;
    }
    let hidden = output.lines.len() - shown_lines;
    if !detail && (hidden > 0 || full) {
        let noun = if hidden == 1 { "line" } else { "lines" };
        rows.push(Line::from(format!("+{hidden} {noun} ({TRANSCRIPT_HINT})").dim()).into());
    } else if let Some(exit) = &output.exit
        && detail
    {
        rows.push(exit.clone().into());
    }
    elbow(rows, width)
}

/// Prefix rows with `  └ ` (the first) and `    ` (the rest), as gutter.
fn elbow(rows: Vec<DisplayLine>, _width: usize) -> Vec<DisplayLine> {
    rows.into_iter()
        .enumerate()
        .map(|(index, row)| {
            let prefix = if index == 0 {
                "  └ ".dim()
            } else {
                Span::raw("    ")
            };
            row.prefixed(&[prefix])
        })
        .collect()
}

fn counts(added: usize, removed: usize) -> Vec<Span<'static>> {
    vec![
        Span::raw(" ("),
        format!("+{added}").green(),
        Span::raw(" "),
        format!("-{removed}").red(),
        Span::raw(")"),
    ]
}

/// One file's change, its rows numbered from the old (removed) and new (other) text.
struct FileDiff {
    path: String,
    kind: FileChange,
    rows: Vec<DiffRow>,
    added: usize,
    removed: usize,
    /// Columns for line numbers.
    number_width: usize,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum FileChange {
    Added,
    Deleted,
    Updated,
}

enum DiffRow {
    Line {
        kind: DiffKind,
        number: usize,
        spans: Vec<Span<'static>>,
    },
    /// Hunks apart.
    Gap,
}

impl FileDiff {
    fn new(diff: &Diff, cwd: &Path) -> Self {
        let old = diff.old_text.as_deref().unwrap_or_default();
        let new = diff.new_text.as_str();
        let kind = match (&diff.old_text, new.is_empty()) {
            (None, _) => FileChange::Added,
            (Some(old), true) if !old.is_empty() => FileChange::Deleted,
            _ => FileChange::Updated,
        };
        let lang = diff
            .path
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or_default();
        let old_lines = highlight::code_lines(old, lang);
        let new_lines = highlight::code_lines(new, lang);
        let text = |lines: &[Line<'static>], number: usize, fallback: &str| -> Vec<Span<'static>> {
            lines
                .get(number.wrapping_sub(1))
                .map(|line| line.spans.clone())
                .unwrap_or_else(|| vec![Span::raw(fallback.to_owned())])
        };
        let patch = diffy::create_patch(old, new);
        let (mut added, mut removed) = (0, 0);
        let mut rows = Vec::new();
        let mut largest = 1;
        for hunk in patch.hunks() {
            if !rows.is_empty() {
                rows.push(DiffRow::Gap);
            }
            let mut old_number = hunk.old_range().start();
            let mut new_number = hunk.new_range().start();
            for line in hunk.lines() {
                let (kind, number, spans) = match line {
                    diffy::Line::Context(source) => {
                        let row = (
                            DiffKind::Context,
                            new_number,
                            text(&new_lines, new_number, source),
                        );
                        old_number += 1;
                        new_number += 1;
                        row
                    }
                    diffy::Line::Delete(source) => {
                        removed += 1;
                        let row = (
                            DiffKind::Delete,
                            old_number,
                            text(&old_lines, old_number, source),
                        );
                        old_number += 1;
                        row
                    }
                    diffy::Line::Insert(source) => {
                        added += 1;
                        let row = (
                            DiffKind::Insert,
                            new_number,
                            text(&new_lines, new_number, source),
                        );
                        new_number += 1;
                        row
                    }
                };
                largest = largest.max(number);
                let spans = spans
                    .into_iter()
                    .map(|span| {
                        let content: String = span
                            .content
                            .replace('\t', "    ")
                            .trim_end_matches(['\n', '\r'])
                            .chars()
                            .filter(|ch| !ch.is_control())
                            .collect();
                        Span::styled(content, span.style)
                    })
                    .collect();
                rows.push(DiffRow::Line {
                    kind,
                    number,
                    spans,
                });
            }
        }
        Self {
            path: display_path(&diff.path, cwd),
            kind,
            rows,
            added,
            removed,
            number_width: largest.to_string().len(),
        }
    }

    fn verb(&self) -> &'static str {
        match self.kind {
            FileChange::Added => "Added",
            FileChange::Deleted => "Deleted",
            FileChange::Updated => "Edited",
        }
    }

    /// Numbered rows indented under the header: changed rows only, three at most, when
    /// compact; every hunk with its context otherwise.
    fn rows(&self, width: usize, detail: bool) -> Vec<DisplayLine> {
        let changed = |row: &&DiffRow| matches!(row, DiffRow::Line { kind, .. } if *kind != DiffKind::Context);
        let shown: Vec<&DiffRow> = if detail {
            self.rows.iter().collect()
        } else {
            self.rows
                .iter()
                .filter(changed)
                .take(DIFF_PREVIEW_ROWS)
                .collect()
        };
        let hidden = if detail {
            0
        } else {
            self.rows.iter().filter(changed).count() - shown.len()
        };
        let mut out = Vec::new();
        for row in shown {
            match row {
                DiffRow::Gap => out.push(Line::from("    ⋮".dim()).into()),
                DiffRow::Line {
                    kind,
                    number,
                    spans,
                } => {
                    out.extend(self.row(*kind, *number, spans, width));
                }
            }
        }
        if hidden > 0 {
            let noun = if hidden == 1 { "line" } else { "lines" };
            out.push(Line::from(format!("    +{hidden} {noun} ({TRANSCRIPT_HINT})").dim()).into());
        }
        out
    }

    /// One numbered row: tinted for insertions and deletions, wrapped under its text.
    fn row(
        &self,
        kind: DiffKind,
        number: usize,
        spans: &[Span<'static>],
        width: usize,
    ) -> Vec<DisplayLine> {
        let text_style = style::diff_text(kind);
        let content = Line::from(
            spans
                .iter()
                .map(|span| {
                    // Syntax colors win; uncolored text takes the change's own color.
                    let style = if span.style.fg.is_some() {
                        span.style
                    } else {
                        text_style.patch(span.style)
                    };
                    Span::styled(span.content.clone(), style)
                })
                .collect::<Vec<_>>(),
        );
        let sign = match kind {
            DiffKind::Insert => "+",
            DiffKind::Delete => "-",
            DiffKind::Context => " ",
        };
        let gutter = GutterLine {
            gutter: vec![
                Span::styled(
                    format!("{number:>width$} ", width = self.number_width),
                    style::diff_gutter(kind),
                ),
                Span::styled(sign, style::diff_sign(kind)),
            ],
            content,
        };
        let background = style::diff_line_background(kind);
        wrap_gutter_line(&gutter, width, &Line::from("    "), &Line::from("    "))
            .into_iter()
            .map(|mut row| {
                row.line.style = row.line.style.patch(background);
                row
            })
            .collect()
    }
}

/// Consecutive reads and searches, shown as one entry as Codex groups its exploring commands:
///
/// ```text
/// • Explored
///   └ Read lib.rs, main.rs
///     Search parse_args in src
/// ```
#[derive(Clone, Default)]
pub struct ExploreGroup {
    calls: Vec<ToolCallCell>,
}

impl ExploreGroup {
    pub fn from_calls(calls: Vec<ToolCallCell>) -> Self {
        Self { calls }
    }

    pub fn push(&mut self, call: ToolCallCell) {
        self.calls.push(call);
    }

    pub fn is_empty(&self) -> bool {
        self.calls.is_empty()
    }

    pub fn calls(&self) -> &[ToolCallCell] {
        &self.calls
    }

    /// The group as one entry; `active` while more exploring may follow (`Exploring`).
    pub fn lines(&self, width: usize, cx: &RenderContext<'_>, active: bool) -> Vec<DisplayLine> {
        let running = active || self.calls.iter().any(|call| !call.is_finished());
        let bullet = match (running, cx.now, self.calls.first()) {
            (true, Some(now), Some(first)) => {
                activity_bullet(now.saturating_duration_since(first.started))
            }
            _ => "•".dim(),
        };
        let verb = if running { "Exploring" } else { "Explored" };
        let mut rows = vec![DisplayLine::whole(Line::from(vec![
            bullet,
            Span::raw(" "),
            Span::styled(verb, Style::default().bold()),
        ]))];
        let mut entries: Vec<DisplayLine> = Vec::new();
        let mut index = 0;
        while let Some(call) = self.calls.get(index) {
            // Successful reads in a row share one line, as Codex coalesces them.
            if call.kind == ToolKind::Read && !call.failed() && !cx.detail {
                let mut names: Vec<String> = Vec::new();
                while let Some(read) = self.calls.get(index)
                    && read.kind == ToolKind::Read
                    && !read.failed()
                {
                    for name in read.read_names(cx.cwd) {
                        if !names.contains(&name) {
                            names.push(name);
                        }
                    }
                    index += 1;
                }
                entries.extend(entry("Read", &names.join(", "), false, width));
                continue;
            }
            let (label, target) = match call.kind {
                ToolKind::Read => ("Read", call.read_names(cx.cwd).join(", ")),
                _ => ("Search", call.search_target()),
            };
            entries.extend(entry(label, &target, call.failed(), width));
            if cx.detail {
                let output = call.output(cx.terminals);
                entries.extend(output.lines.iter().map(|line| {
                    DisplayLine::whole(Line::from(line.clone().dim())).prefixed(&[Span::raw("  ")])
                }));
            }
            index += 1;
        }
        rows.extend(elbow(entries, width));
        rows
    }
}

/// `Read a.rs` / `Search query`: the action in the accent color, wrapped under its target.
fn entry(label: &str, target: &str, failed: bool, width: usize) -> Vec<DisplayLine> {
    let first = Line::from(vec![
        Span::styled(label.to_owned(), Style::default().fg(style::accent())),
        Span::raw(" "),
    ]);
    let rest = Line::from(" ".repeat(line_width(&first)));
    let mut content = Line::from(target.to_owned());
    if failed {
        content.spans.push(" (failed)".red());
    }
    wrap_sourced(&content, width.saturating_sub(4), &first, &rest)
}

impl ToolCallCell {
    /// File names a read covers, or its title without the verb.
    fn read_names(&self, cwd: &Path) -> Vec<String> {
        if self.locations.is_empty() {
            return vec![title_without_verb(self.title(), &["read"])];
        }
        // File names only, as Codex lists what it read.
        self.locations
            .iter()
            .map(|location| display_path(&location.path, cwd))
            .collect()
    }

    fn search_target(&self) -> String {
        let input = &self.input;
        match (input.pattern.as_ref().or(input.query.as_ref()), &input.path) {
            (Some(pattern), Some(path)) => format!("{pattern} in {path}"),
            (Some(pattern), None) => pattern.clone(),
            _ => title_without_verb(self.title(), &["search", "grep", "find", "glob"]),
        }
    }
}

fn content_lines(content: &ContentBlock) -> Vec<String> {
    match content {
        // Agents often fence tool output as markdown; the fences add nothing here.
        ContentBlock::Text(text) => text
            .text
            .lines()
            .filter(|line| !line.trim_start().starts_with("```"))
            .map(|line| {
                line.replace('\t', "    ")
                    .chars()
                    .filter(|ch| !ch.is_control())
                    .collect()
            })
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

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;
    use weave_acp_core::schema::Terminal;
    use weave_acp_core::schema::TerminalExitStatus;

    use super::*;
    use crate::tool_output::TerminalTranscript;

    fn text(lines: &[DisplayLine]) -> Vec<String> {
        lines
            .iter()
            .map(|line| line.line.to_string().trim_end().to_owned())
            .collect()
    }

    fn render(cell: &ToolCallCell, detail: bool, terminals: &TerminalTranscripts) -> Vec<String> {
        let cx = RenderContext {
            cwd: Path::new("/repo"),
            terminals,
            detail,
            now: None,
        };
        text(&cell.lines(50, &cx))
    }

    #[test]
    fn commands_show_three_rows_of_output_and_count_the_rest() {
        let call = ToolCall::new("t1", "`seq 1 10`")
            .kind(ToolKind::Execute)
            .status(ToolCallStatus::Completed)
            .raw_input(serde_json::json!({"command": "seq 1 10"}))
            .content(vec![ToolCallContent::Terminal(Terminal::new("term"))]);
        let mut terminals = TerminalTranscripts::new();
        let mut transcript = TerminalTranscript::default();
        transcript.append("1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n");
        transcript.set_exit(TerminalExitStatus::new().exit_code(0));
        terminals.insert("term".into(), transcript);
        let cell = ToolCallCell::new(call);
        assert_eq!(
            render(&cell, false, &terminals),
            [
                "• Ran seq 1 10",
                "  └ 1",
                "    2",
                "    3",
                "    +7 lines (⌃t to view transcript)"
            ]
        );
        let detail = render(&cell, true, &terminals);
        assert_eq!(detail.len(), 1 + 10 + 1, "{detail:?}");
        assert_eq!(detail.last().map(String::as_str), Some("    exit 0"));
    }

    #[test]
    fn silent_commands_say_so_and_long_commands_wrap_under_a_bar() {
        let call = ToolCall::new("t1", "true")
            .kind(ToolKind::Execute)
            .status(ToolCallStatus::Completed)
            .raw_input(serde_json::json!({"command": "true"}));
        let cell = ToolCallCell::new(call);
        assert_eq!(
            render(&cell, false, &TerminalTranscripts::new()),
            ["• Ran true", "  └ (no output)"]
        );

        let long =
            "cargo test --workspace --all-features -- --nocapture --test-threads 1 --exact name";
        let call = ToolCall::new("t2", long)
            .kind(ToolKind::Execute)
            .status(ToolCallStatus::InProgress)
            .raw_input(serde_json::json!({ "command": long }));
        let rows = render(&ToolCallCell::new(call), false, &TerminalTranscripts::new());
        assert_eq!(
            rows[0],
            "• Running cargo test --workspace --all-features --"
        );
        assert!(rows[1].starts_with("  │ "), "{rows:?}");
    }

    #[test]
    fn edits_show_counts_and_the_changed_rows() {
        let call = ToolCall::new("t1", "Edit lib.rs")
            .kind(ToolKind::Edit)
            .status(ToolCallStatus::Completed)
            .content(vec![ToolCallContent::Diff(
                Diff::new("/repo/src/lib.rs", "fn a() {}\nfn b() {}\nfn c() {}\n")
                    .old_text("fn a() {}\nfn x() {}\nfn c() {}\n".to_owned()),
            )]);
        let cell = ToolCallCell::new(call);
        assert_eq!(
            render(&cell, false, &TerminalTranscripts::new()),
            [
                "• Edited src/lib.rs (+1 -1)",
                "    2 -fn x() {}",
                "    2 +fn b() {}"
            ]
        );
        assert_eq!(
            render(&cell, true, &TerminalTranscripts::new()),
            [
                "• Edited src/lib.rs (+1 -1)",
                "    1  fn a() {}",
                "    2 -fn x() {}",
                "    2 +fn b() {}",
                "    3  fn c() {}"
            ]
        );
    }

    #[test]
    fn several_files_are_listed_under_one_header() {
        let call = ToolCall::new("t1", "Apply patch")
            .kind(ToolKind::Edit)
            .status(ToolCallStatus::Completed)
            .content(vec![
                ToolCallContent::Diff(
                    Diff::new("/repo/a.txt", "one changed\n").old_text("one\n".to_owned()),
                ),
                ToolCallContent::Diff(Diff::new("/repo/b.txt", "new\n")),
            ]);
        assert_eq!(
            render(&ToolCallCell::new(call), false, &TerminalTranscripts::new()),
            [
                "• Edited 2 files (+2 -1)",
                "  └ a.txt (+1 -1)",
                "    1 -one",
                "    1 +one changed",
                "",
                "  └ b.txt (+1 -0)",
                "    1 +new"
            ]
        );
    }

    #[test]
    fn reads_and_searches_group_into_one_explored_entry() {
        let read = |id: &str, path: &str| {
            ToolCallCell::new(
                ToolCall::new(id.to_owned(), "Read")
                    .kind(ToolKind::Read)
                    .status(ToolCallStatus::Completed)
                    .locations(vec![ToolCallLocation::new(path)]),
            )
        };
        let search = ToolCallCell::new(
            ToolCall::new("s", "grep parse_args")
                .kind(ToolKind::Search)
                .status(ToolCallStatus::Completed)
                .raw_input(serde_json::json!({"pattern": "parse_args", "path": "src"})),
        );
        let group = ExploreGroup::from_calls(vec![
            read("r1", "/repo/src/lib.rs"),
            read("r2", "/repo/src/main.rs"),
            search,
            read("r3", "/repo/README.md"),
        ]);
        let terminals = TerminalTranscripts::new();
        let cx = RenderContext {
            cwd: Path::new("/repo"),
            terminals: &terminals,
            detail: false,
            now: None,
        };
        assert_eq!(
            text(&group.lines(60, &cx, false)),
            [
                "• Explored",
                "  └ Read src/lib.rs, src/main.rs",
                "    Search parse_args in src",
                "    Read README.md"
            ]
        );
        assert_eq!(text(&group.lines(60, &cx, true))[0], "• Exploring");
    }

    #[test]
    fn other_tools_are_called_and_failures_show_the_error() {
        let call = ToolCall::new("m1", "github.get_issue")
            .kind(ToolKind::Other)
            .status(ToolCallStatus::Failed)
            .content(vec![ContentBlock::from("network timeout").into()]);
        assert_eq!(
            render(&ToolCallCell::new(call), false, &TerminalTranscripts::new()),
            ["• Called github.get_issue", "  └ Error: network timeout"]
        );
        let search = ToolCall::new("f1", "WebSearch")
            .kind(ToolKind::Fetch)
            .status(ToolCallStatus::Completed)
            .raw_input(serde_json::json!({"query": "ratatui styling"}));
        assert_eq!(
            render(
                &ToolCallCell::new(search),
                false,
                &TerminalTranscripts::new()
            ),
            ["• Searched the web for ratatui styling"]
        );
    }

    #[test]
    fn called_tools_add_their_name_when_the_title_lacks_it() {
        let mut call = ToolCall::new("m1", "Get issue")
            .kind(ToolKind::Other)
            .status(ToolCallStatus::Completed);
        call.name = Some("github.get_issue".to_owned());
        assert_eq!(
            render(&ToolCallCell::new(call), false, &TerminalTranscripts::new()),
            ["• Called Get issue · github.get_issue"]
        );
        let mut named = ToolCall::new("m2", "github.get_issue")
            .kind(ToolKind::Other)
            .status(ToolCallStatus::Completed);
        named.name = Some("github.get_issue".to_owned());
        assert_eq!(
            render(
                &ToolCallCell::new(named),
                false,
                &TerminalTranscripts::new()
            ),
            ["• Called github.get_issue"]
        );
    }
}
