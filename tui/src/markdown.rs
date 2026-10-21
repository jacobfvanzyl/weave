//! Renders agent markdown into styled, wrapped terminal lines, in Codex's styles
//! (`codex-rs/tui/src/markdown_render.rs`, Apache-2.0): bold and underlined top headings, inline
//! code and links in the theme's colors, light blue list numbers, green quotes, highlighted code
//! blocks without their fences, and tables laid out in columns.
//!
//! Source line breaks are kept (soft breaks render as breaks), so rendering a prefix of a
//! message yields a prefix of the full rendering. Streaming relies on that to commit finished
//! lines to scrollback before the message is complete.

use pulldown_cmark::CodeBlockKind;
use pulldown_cmark::Event;
use pulldown_cmark::HeadingLevel;
use pulldown_cmark::Options;
use pulldown_cmark::Parser;
use pulldown_cmark::Tag;
use pulldown_cmark::TagEnd;
use ratatui::style::Color;
use ratatui::style::Modifier;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::text::Span;
use unicode_width::UnicodeWidthStr;

use std::sync::Arc;

use pulldown_cmark::Alignment;

use crate::highlight;
use crate::style;
use crate::wrapping::DisplayLine;
use crate::wrapping::wrap_sourced;

pub fn render_markdown(source: &str, width: usize) -> Vec<DisplayLine> {
    let options =
        Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS | Options::ENABLE_TABLES;
    let mut renderer = Renderer::new(width);
    for event in Parser::new_ext(source, options) {
        renderer.event(event);
    }
    renderer.finish()
}

/// Where a streaming message's committed prefix may end: after its last complete line,
/// unless that line is in a table still arriving, whose column widths aren't known yet. Then
/// the table's block is held back until it ends.
pub fn commit_boundary(source: &str) -> Option<usize> {
    let end = source.rfind('\n')? + 1;
    let block_start = source[..end]
        .trim_end_matches('\n')
        .rfind("\n\n")
        .map_or(0, |index| index + 2);
    let in_table = source[block_start..end]
        .lines()
        .any(|line| line.trim_start().starts_with('|'));
    if in_table {
        (block_start > 0).then_some(block_start)
    } else {
        Some(end)
    }
}

struct Renderer {
    width: usize,
    lines: Vec<DisplayLine>,
    spans: Vec<Span<'static>>,
    /// Inline styles in effect, innermost last.
    styles: Vec<Style>,
    /// Open lists: the next ordinal for ordered lists.
    lists: Vec<Option<u64>>,
    /// Continuation indent of each open list item.
    items: Vec<usize>,
    /// Indent and marker for the first line of the newest list item.
    pending_marker: Option<(usize, String)>,
    quote_depth: usize,
    in_code_block: bool,
    fenced_code: bool,
    /// The open code block's language, and its text so far, highlighted when it ends.
    code_lang: String,
    code: String,
    link: Option<(String, usize)>,
    blank_before_next_block: bool,
    table: Option<Table>,
}

/// A table being read: its column alignments, finished rows, and the row being read.
struct Table {
    alignments: Vec<Alignment>,
    rows: Vec<Vec<Line<'static>>>,
    row: Vec<Line<'static>>,
}

impl Renderer {
    fn new(width: usize) -> Self {
        Self {
            width,
            lines: Vec::new(),
            spans: Vec::new(),
            styles: Vec::new(),
            lists: Vec::new(),
            items: Vec::new(),
            pending_marker: None,
            quote_depth: 0,
            in_code_block: false,
            fenced_code: false,
            code_lang: String::new(),
            code: String::new(),
            link: None,
            blank_before_next_block: false,
            table: None,
        }
    }

    fn event(&mut self, event: Event<'_>) {
        match event {
            Event::Start(tag) => self.start(tag),
            Event::End(tag) => self.end(tag),
            Event::Text(text) if self.in_code_block => self.code_text(&text),
            Event::Text(text) | Event::Html(text) | Event::InlineHtml(text) => self.text(&text),
            Event::Code(code) => {
                let style = self.style().patch(inline_code_style());
                self.push(&code, style);
            }
            Event::SoftBreak | Event::HardBreak => self.flush(),
            Event::Rule => {
                self.start_block();
                self.spans.push(Span::styled("———", dim()));
                self.flush();
                self.blank_before_next_block = true;
            }
            Event::TaskListMarker(checked) => {
                self.text(if checked { "[x] " } else { "[ ] " });
            }
            Event::FootnoteReference(name) => self.text(&format!("[^{name}]")),
        }
    }

    fn start(&mut self, tag: Tag<'_>) {
        match tag {
            Tag::Paragraph => self.start_block(),
            Tag::Heading { level, .. } => {
                self.start_block();
                let style = heading_style(level);
                let hashes = "#".repeat(heading_depth(level));
                self.spans.push(Span::styled(format!("{hashes} "), style));
                self.styles.push(style);
            }
            Tag::BlockQuote => {
                self.start_block();
                self.quote_depth += 1;
                self.push_style(Style::default().fg(Color::Green));
            }
            Tag::CodeBlock(kind) => {
                self.start_block();
                self.in_code_block = true;
                self.fenced_code = matches!(kind, CodeBlockKind::Fenced(_));
                self.code.clear();
                self.code_lang.clear();
                if let CodeBlockKind::Fenced(language) = kind {
                    self.code_lang = language.to_string();
                }
            }
            Tag::List(start) => {
                if !self.spans.is_empty() {
                    self.flush();
                }
                if self.lists.is_empty() {
                    self.start_block();
                }
                self.lists.push(start);
            }
            Tag::Item => {
                if !self.spans.is_empty() {
                    self.flush();
                }
                // Unordered items use "-" so they never read as the transcript's "•" markers.
                let marker = match self.lists.last_mut() {
                    Some(Some(next)) => {
                        let marker = format!("{next}. ");
                        *next += 1;
                        marker
                    }
                    _ => "- ".to_owned(),
                };
                let parent = self.items.last().copied().unwrap_or(0);
                self.items.push(parent + marker.width());
                self.pending_marker = Some((parent, marker));
            }
            Tag::Emphasis => self.push_style(Style::default().add_modifier(Modifier::ITALIC)),
            Tag::Strong => self.push_style(Style::default().add_modifier(Modifier::BOLD)),
            Tag::Strikethrough => {
                self.push_style(Style::default().add_modifier(Modifier::CROSSED_OUT))
            }
            Tag::Link { dest_url, .. } => {
                self.push_style(
                    Style::default()
                        .fg(style::accent())
                        .add_modifier(Modifier::UNDERLINED),
                );
                self.link = Some((dest_url.into_string(), self.spans.len()));
            }
            Tag::Image { dest_url, .. } => {
                self.text("[image: ");
                self.link = Some((dest_url.into_string(), self.spans.len()));
            }
            Tag::FootnoteDefinition(name) => {
                self.start_block();
                self.text(&format!("[^{name}]: "));
            }
            Tag::Table(alignments) => {
                self.start_block();
                self.table = Some(Table {
                    alignments,
                    rows: Vec::new(),
                    row: Vec::new(),
                });
            }
            Tag::TableHead => self.push_style(Style::default().add_modifier(Modifier::BOLD)),
            Tag::HtmlBlock | Tag::MetadataBlock(_) | Tag::TableRow | Tag::TableCell => {}
        }
    }

    fn end(&mut self, tag: TagEnd) {
        match tag {
            TagEnd::Paragraph | TagEnd::FootnoteDefinition => {
                self.flush();
                self.blank_before_next_block = true;
            }
            TagEnd::Heading(_) => {
                self.styles.pop();
                self.flush();
                self.blank_before_next_block = true;
            }
            TagEnd::BlockQuote => {
                if !self.spans.is_empty() {
                    self.flush();
                }
                self.styles.pop();
                self.quote_depth = self.quote_depth.saturating_sub(1);
                self.blank_before_next_block = true;
            }
            TagEnd::CodeBlock => self.end_code_block(),
            TagEnd::List(_) => {
                self.lists.pop();
                if self.lists.is_empty() {
                    self.blank_before_next_block = true;
                }
            }
            TagEnd::Item => {
                if !self.spans.is_empty() || self.pending_marker.is_some() {
                    self.flush();
                }
                self.items.pop();
            }
            TagEnd::Emphasis | TagEnd::Strong | TagEnd::Strikethrough => {
                self.styles.pop();
            }
            TagEnd::Link => {
                self.styles.pop();
                self.end_link(false);
            }
            TagEnd::Image => self.end_link(true),
            TagEnd::TableCell => {
                let cell = Line::from(std::mem::take(&mut self.spans));
                if let Some(table) = &mut self.table {
                    table.row.push(cell);
                }
            }
            TagEnd::TableHead | TagEnd::TableRow => {
                if tag == TagEnd::TableHead {
                    self.styles.pop();
                }
                if let Some(table) = &mut self.table {
                    let row = std::mem::take(&mut table.row);
                    table.rows.push(row);
                }
            }
            TagEnd::Table => {
                if let Some(table) = self.table.take() {
                    self.end_table(table);
                }
                self.blank_before_next_block = true;
            }
            TagEnd::HtmlBlock | TagEnd::MetadataBlock(_) => {}
        }
    }

    /// Emit the code block, highlighted for its language and without its fences, as Codex
    /// shows code. An unterminated block (while streaming) is highlighted as far as it goes;
    /// complete lines render as they will at the end, since highlighting only carries state
    /// forward.
    fn end_code_block(&mut self) {
        if !self.spans.is_empty() {
            self.flush();
        }
        let code = std::mem::take(&mut self.code);
        if !code.is_empty() {
            let lines = if self.fenced_code {
                highlight::code_lines(&code, &self.code_lang)
            } else {
                code.lines()
                    .map(|line| Line::from(format!("    {line}")))
                    .collect()
            };
            for line in lines {
                for span in line.spans {
                    let text = span.content.replace('\t', "    ");
                    self.spans.push(Span::styled(text, span.style));
                }
                self.flush();
            }
        }
        self.in_code_block = false;
        self.blank_before_next_block = true;
    }

    /// Lay a table out in columns, as Codex does: a header, a heavy rule, and the rows, each
    /// cell padded by a space. A table too wide for the screen lists its rows instead.
    fn end_table(&mut self, table: Table) {
        let columns = table.rows.iter().map(Vec::len).max().unwrap_or_default();
        let widths: Vec<usize> = (0..columns)
            .map(|column| {
                table
                    .rows
                    .iter()
                    .filter_map(|row| row.get(column))
                    .map(Line::width)
                    .max()
                    .unwrap_or_default()
                    + 2
            })
            .collect();
        let quote = self.quote_prefix();
        let quote_width: usize = quote.iter().map(|span| span.content.width()).sum();
        let total = quote_width + widths.iter().sum::<usize>() + 2 * columns.saturating_sub(1);
        if total > self.width {
            for row in table.rows {
                let mut spans = Vec::new();
                for (index, cell) in row.into_iter().enumerate() {
                    if index > 0 {
                        spans.push(Span::styled(" | ", dim()));
                    }
                    spans.extend(cell.spans);
                }
                self.spans = spans;
                self.flush();
            }
            return;
        }
        for (index, row) in table.rows.into_iter().enumerate() {
            let mut spans = quote.clone();
            for (column, width) in widths.iter().enumerate() {
                if column > 0 {
                    spans.push(Span::raw("  "));
                }
                let cell = row.get(column).cloned().unwrap_or_default();
                let free = width - 2 - cell.width();
                let (before, after) = match table.alignments.get(column) {
                    Some(Alignment::Right) => (free, 0),
                    Some(Alignment::Center) => (free / 2, free - free / 2),
                    _ => (0, free),
                };
                spans.push(Span::raw(" ".repeat(before + 1)));
                spans.extend(cell.spans);
                if column + 1 < widths.len() {
                    spans.push(Span::raw(" ".repeat(after + 1)));
                }
            }
            self.lines.push(DisplayLine::whole(Line::from(spans)));
            if index == 0 {
                let mut rule = quote.clone();
                for (column, width) in widths.iter().enumerate() {
                    if column > 0 {
                        rule.push(Span::raw("  "));
                    }
                    rule.push(Span::styled("━".repeat(*width), dim()));
                }
                self.lines.push(DisplayLine::plain(Line::from(rule)));
            }
        }
    }

    fn end_link(&mut self, image: bool) {
        let Some((url, start)) = self.link.take() else {
            return;
        };
        let label: String = self.spans[start.min(self.spans.len())..]
            .iter()
            .map(|span| span.content.as_ref())
            .collect();
        if image {
            self.text("]");
        }
        if label != url && !url.starts_with('#') {
            self.spans.push(Span::styled(format!(" ({url})"), dim()));
        }
    }

    fn start_block(&mut self) {
        if self.blank_before_next_block && !self.lines.is_empty() {
            let quote = self.quote_prefix();
            self.lines.push(DisplayLine::plain(Line::from(quote)));
        }
        self.blank_before_next_block = false;
    }

    fn text(&mut self, text: &str) {
        let style = self.style();
        self.push(text, style);
    }

    fn code_text(&mut self, text: &str) {
        self.code.push_str(text);
    }

    fn push(&mut self, text: &str, style: Style) {
        let text = text.replace('\t', "    ");
        match self.spans.last_mut() {
            Some(last) if last.style == style => last.content.to_mut().push_str(&text),
            _ => self.spans.push(Span::styled(text, style)),
        }
    }

    fn push_style(&mut self, patch: Style) {
        let style = self.style().patch(patch);
        self.styles.push(style);
    }

    fn style(&self) -> Style {
        self.styles.last().copied().unwrap_or_default()
    }

    fn quote_prefix(&self) -> Vec<Span<'static>> {
        if self.quote_depth == 0 {
            Vec::new()
        } else {
            vec![Span::styled(
                "> ".repeat(self.quote_depth),
                Style::default().fg(Color::Green),
            )]
        }
    }

    /// End the current source line, wrapping it under the active quote and list prefixes.
    fn flush(&mut self) {
        let content = Line::from(std::mem::take(&mut self.spans));
        let hang = self.items.last().copied().unwrap_or(0);
        let marker = self.pending_marker.take();
        let mut first = self.quote_prefix();
        match &marker {
            Some((indent, marker)) => {
                first.push(Span::raw(" ".repeat(*indent)));
                // Codex colors list numbers light blue; bullets stay plain.
                let style = if marker.starts_with('-') {
                    Style::default()
                } else {
                    Style::default().fg(Color::LightBlue)
                };
                first.push(Span::styled(marker.clone(), style));
            }
            None => first.push(Span::raw(" ".repeat(hang))),
        }
        let rest_indent = " ".repeat(hang);
        let mut rest = self.quote_prefix();
        rest.push(Span::raw(rest_indent));
        let mut rows = wrap_sourced(&content, self.width, &Line::from(first), &Line::from(rest));
        if let Some((_, marker)) = marker {
            copy_with_marker(&mut rows, &marker);
        }
        self.lines.extend(rows);
    }

    fn finish(mut self) -> Vec<DisplayLine> {
        if !self.spans.is_empty() || self.pending_marker.is_some() {
            self.flush();
        }
        self.lines
    }
}

/// Make a list item's marker part of its copied text, so copied lists keep their bullets and
/// numbers as markdown does.
fn copy_with_marker(rows: &mut [DisplayLine], marker: &str) {
    let Some(text) = rows.first().and_then(|row| row.source.as_ref()) else {
        return;
    };
    let text: Arc<str> = format!("{marker}{}", text.text).into();
    for (index, row) in rows.iter_mut().enumerate() {
        if let Some(source) = &mut row.source {
            source.text = Arc::clone(&text);
            source.range = if index == 0 {
                source.prefix_width = source.prefix_width.saturating_sub(marker.width());
                0..source.range.end + marker.len()
            } else {
                source.range.start + marker.len()..source.range.end + marker.len()
            };
        }
    }
}

/// Codex's heading styles: underlined bold, bold, bold italic, then italic.
fn heading_style(level: HeadingLevel) -> Style {
    let style = Style::default();
    match level {
        HeadingLevel::H1 => style.add_modifier(Modifier::BOLD | Modifier::UNDERLINED),
        HeadingLevel::H2 => style.add_modifier(Modifier::BOLD),
        HeadingLevel::H3 => style.add_modifier(Modifier::BOLD | Modifier::ITALIC),
        _ => style.add_modifier(Modifier::ITALIC),
    }
}

/// Inline code in the theme's color for it, or the accent.
fn inline_code_style() -> Style {
    let color = highlight::scope_color(&[
        "markup.inline.raw.string.markdown",
        "markup.raw.inline.markdown",
    ])
    .unwrap_or_else(style::accent);
    Style::default().fg(color)
}

fn heading_depth(level: HeadingLevel) -> usize {
    match level {
        HeadingLevel::H1 => 1,
        HeadingLevel::H2 => 2,
        HeadingLevel::H3 => 3,
        HeadingLevel::H4 => 4,
        HeadingLevel::H5 => 5,
        HeadingLevel::H6 => 6,
    }
}

fn dim() -> Style {
    Style::default().add_modifier(Modifier::DIM)
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    fn render(source: &str, width: usize) -> Vec<String> {
        render_markdown(source, width)
            .iter()
            .map(|row| row.line.to_string())
            .collect()
    }

    #[test]
    fn paragraphs_keep_source_line_breaks_and_are_separated() {
        assert_eq!(render("one\ntwo\n\nthree", 40), ["one", "two", "", "three"]);
    }

    #[test]
    fn nested_lists_hang_wrapped_lines_under_their_text() {
        let source = "- first item wraps here\n  - nested\n- second";
        assert_eq!(
            render(source, 14),
            ["- first item", "  wraps here", "  - nested", "- second"]
        );
    }

    #[test]
    fn ordered_lists_number_items() {
        assert_eq!(
            render("1. a\n2. b\n\nafter", 20),
            ["1. a", "2. b", "", "after"]
        );
    }

    #[test]
    fn code_blocks_keep_indentation_and_drop_their_fences() {
        let source = "```rust\nfn main() {\n    run();\n}\n```\nafter";
        assert_eq!(
            render(source, 40),
            ["fn main() {", "    run();", "}", "", "after"]
        );
    }

    #[test]
    fn tables_line_up_in_columns_or_list_rows_when_too_wide() {
        let source = "| Name | Size |\n|:--|--:|\n| a.rs | 12 |\n| lib.rs | 3400 |\n";
        assert_eq!(
            render(source, 40),
            [
                " Name      Size",
                "━━━━━━━━  ━━━━━━",
                " a.rs        12",
                " lib.rs    3400"
            ]
        );
        assert_eq!(
            render(source, 10),
            ["Name |", "Size", "a.rs | 12", "lib.rs |", "3400"]
        );
    }

    #[test]
    fn streaming_holds_back_a_table_until_its_block_ends() {
        let intro = "Sizes:\n\n";
        let partial = format!("{intro}| a | b |\n|---|---|\n| 1 | 2 |\n");
        assert_eq!(commit_boundary(&partial), Some(intro.len()));
        let done = format!("{partial}\nafter\n");
        assert_eq!(commit_boundary(&done), Some(done.len()));
        assert_eq!(commit_boundary("no newline yet"), None);
    }

    #[test]
    fn headings_quotes_and_links() {
        let source = "## Title\n\n> quoted\n\nsee [docs](https://x.dev)";
        assert_eq!(
            render(source, 40),
            ["## Title", "", "> quoted", "", "see docs (https://x.dev)"]
        );
    }

    #[test]
    fn rendering_a_line_prefix_yields_an_output_prefix() {
        let full = "Intro line\n\n- item one\n- item two\n\n```sh\nls\n```\nTail\n";
        let complete = render(full, 30);
        let mut end = 0;
        while let Some(offset) = full[end..].find('\n') {
            end += offset + 1;
            let partial = render(&full[..end], 30);
            assert_eq!(
                partial[..],
                complete[..partial.len()],
                "prefix {:?}",
                &full[..end]
            );
        }
    }
}
