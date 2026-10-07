//! Renders agent markdown into styled, wrapped terminal lines.
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

use crate::wrapping::DisplayLine;
use crate::wrapping::wrap_sourced;

pub fn render_markdown(source: &str, width: usize) -> Vec<DisplayLine> {
    let options = Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS;
    let mut renderer = Renderer::new(width);
    for (event, range) in Parser::new_ext(source, options).into_offset_iter() {
        if let Event::End(TagEnd::CodeBlock) = event {
            renderer.end_code_block(has_closing_fence(&source[range]));
        } else {
            renderer.event(event);
        }
    }
    renderer.finish()
}

/// Whether a fenced code block's source includes its closing fence. An unterminated block,
/// as while it is still streaming, runs to the end of the document without one.
fn has_closing_fence(block: &str) -> bool {
    let mut lines = block.trim_end_matches('\n').lines();
    let opening = lines.next().map(str::trim_start).unwrap_or_default();
    let fence = if opening.starts_with("~~~") {
        "~~~"
    } else {
        "```"
    };
    lines
        .next_back()
        .is_some_and(|last| last.trim().starts_with(fence))
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
    link: Option<(String, usize)>,
    blank_before_next_block: bool,
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
            link: None,
            blank_before_next_block: false,
        }
    }

    fn event(&mut self, event: Event<'_>) {
        match event {
            Event::Start(tag) => self.start(tag),
            Event::End(tag) => self.end(tag),
            Event::Text(text) if self.in_code_block => self.code_text(&text),
            Event::Text(text) | Event::Html(text) | Event::InlineHtml(text) => self.text(&text),
            Event::Code(code) => {
                let style = self.style().fg(Color::Cyan);
                self.push(&code, style);
            }
            Event::SoftBreak | Event::HardBreak => self.flush(),
            Event::Rule => {
                self.start_block();
                let rule = "─".repeat(self.width.clamp(1, 40));
                self.spans.push(Span::styled(
                    rule,
                    Style::default().add_modifier(Modifier::DIM),
                ));
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
                let mut style = Style::default().add_modifier(Modifier::BOLD);
                if level == HeadingLevel::H1 {
                    style = style.add_modifier(Modifier::UNDERLINED);
                }
                let hashes = "#".repeat(heading_depth(level));
                self.spans.push(Span::styled(format!("{hashes} "), style));
                self.styles.push(style);
            }
            Tag::BlockQuote => {
                self.start_block();
                self.quote_depth += 1;
            }
            Tag::CodeBlock(kind) => {
                self.start_block();
                self.in_code_block = true;
                self.fenced_code = matches!(kind, CodeBlockKind::Fenced(_));
                if let CodeBlockKind::Fenced(language) = kind {
                    self.spans
                        .push(Span::styled(format!("```{language}"), dim()));
                    self.flush();
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
                        .fg(Color::Cyan)
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
            Tag::HtmlBlock
            | Tag::MetadataBlock(_)
            | Tag::Table(_)
            | Tag::TableHead
            | Tag::TableRow
            | Tag::TableCell => {}
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
                self.quote_depth = self.quote_depth.saturating_sub(1);
                self.blank_before_next_block = true;
            }
            TagEnd::CodeBlock => self.end_code_block(true),
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
            TagEnd::HtmlBlock
            | TagEnd::MetadataBlock(_)
            | TagEnd::Table
            | TagEnd::TableHead
            | TagEnd::TableRow
            | TagEnd::TableCell => {}
        }
    }

    fn end_code_block(&mut self, closed: bool) {
        if !self.spans.is_empty() {
            self.flush();
        }
        self.in_code_block = false;
        if self.fenced_code && closed {
            self.spans.push(Span::styled("```", dim()));
            self.flush();
        }
        self.blank_before_next_block = true;
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
        let mut segments = text.split('\n').peekable();
        while let Some(segment) = segments.next() {
            if !segment.is_empty() {
                let indent = if self.fenced_code { "" } else { "    " };
                self.push(&format!("{indent}{segment}"), Style::default());
            }
            if segments.peek().is_some() {
                self.flush();
            }
        }
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
        let (first_indent, rest_indent) = match &marker {
            Some((indent, marker)) => {
                (format!("{}{marker}", " ".repeat(*indent)), " ".repeat(hang))
            }
            None => (" ".repeat(hang), " ".repeat(hang)),
        };
        let mut first = self.quote_prefix();
        first.push(Span::raw(first_indent));
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
    fn code_blocks_keep_indentation_and_fences() {
        let source = "```rust\nfn main() {\n    run();\n}\n```";
        assert_eq!(
            render(source, 40),
            ["```rust", "fn main() {", "    run();", "}", "```"]
        );
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
