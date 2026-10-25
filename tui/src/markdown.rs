//! Renders agent markdown into styled, wrapped terminal lines, in Codex's styles
//! (`codex-rs/tui/src/markdown_render.rs`, Apache-2.0): bold and underlined top headings, inline
//! code and links in the theme's colors, light blue list numbers, green quotes, highlighted code
//! blocks without their fences, and tables laid out in columns. GitHub's alerts (`> [!NOTE]` and
//! the rest) are quotes headed by their kind, in its color. As in Codex, Mermaid fences are drawn
//! as diagrams (`mermaid`) and TeX math as Unicode (`math`), in GitHub's ```` ```math ```` fences
//! too, each falling back to its source, and copying either gives back the source.
//!
//! Source line breaks are kept (soft breaks render as breaks), so rendering a prefix of a
//! message yields a prefix of the full rendering. Streaming relies on that to commit finished
//! lines to scrollback before the message is complete.

use pulldown_cmark::BlockQuoteKind;
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

use std::ops::Range;
use std::sync::Arc;
use std::sync::OnceLock;

use pulldown_cmark::Alignment;

use crate::highlight;
use crate::math::MathMarkdown;
use crate::mermaid;
use crate::mermaid::RenderError;
use crate::mermaid::Role;
use crate::style;
use crate::wrapping::DisplayLine;
use crate::wrapping::LineSource;
use crate::wrapping::wrap_sourced;

/// A Mermaid fence whose block passes this many bytes renders as its source, closed or not, so
/// streaming commits it line by line again. It is the diagram renderer's own source limit.
const HELD_SOURCE_LIMIT: usize = 16 * 1024;

/// What agent Markdown is drawn as beyond text, as Codex's `tui.rendering`; `[tui] mermaid` and
/// `math` turn them off, to show the source instead.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rendering {
    pub mermaid: bool,
    pub math: bool,
}

impl Default for Rendering {
    fn default() -> Self {
        Self {
            mermaid: true,
            math: true,
        }
    }
}

static RENDERING: OnceLock<Rendering> = OnceLock::new();

/// Record what to draw, at startup. Only the first call counts.
pub fn set_rendering(rendering: Rendering) {
    let _ = RENDERING.set(rendering);
}

fn rendering() -> Rendering {
    RENDERING.get().copied().unwrap_or_default()
}

pub fn render_markdown(source: &str, width: usize) -> Vec<DisplayLine> {
    render_markdown_with(source, width, rendering())
}

fn render_markdown_with(source: &str, width: usize, rendering: Rendering) -> Vec<DisplayLine> {
    // Math is found first, before CommonMark takes the backslashes of `\(` and `\[`; the parser
    // reads a copy with each formula masked, and its text events carry the rendering.
    let math = MathMarkdown::new(source, options(), Some(width), rendering.math);
    let mut renderer = Renderer::new(width, source, rendering);
    renderer.display_math.clone_from(&math.display_ranges);
    let parser = Parser::new_ext(&math.markdown, options());
    for (event, range) in math.events(parser.into_offset_iter()) {
        renderer.event(event, range);
    }
    renderer.finish()
}

/// Math, sub- and superscript and wikilinks stay off: math is found before parsing, single
/// tildes are strikethrough, and wikilinks are where 0.13.4's exponential parse lived.
fn options() -> Options {
    Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_TABLES
        | Options::ENABLE_GFM
}

/// What a fence holds that is drawn once it closes: a Mermaid diagram or, as on GitHub, a
/// display equation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Drawing {
    Mermaid,
    Math,
}

impl Drawing {
    fn of_fence(info: &str) -> Option<Self> {
        match info.split([',', ' ', '\t']).next() {
            Some("mermaid") => Some(Self::Mermaid),
            Some("math") => Some(Self::Math),
            _ => None,
        }
    }
}

/// Fences whose blocks render differently once they close: Mermaid diagrams and math.
fn renders_when_closed(info: &str) -> bool {
    Drawing::of_fence(info).is_some()
}

/// Where a streaming message's committed prefix may end: after its last complete line,
/// unless something there renders differently once complete. A table still arriving, whose
/// column widths aren't known yet, or a Mermaid fence holds its block back until the next one
/// starts; an unclosed display equation is held from its first line.
pub fn commit_boundary(source: &str) -> Option<usize> {
    let end = source.rfind('\n')? + 1;
    let complete = &source[..end];
    let mut depth = 0usize;
    let mut last_block = 0;
    let mut last_is_code = false;
    let mut held = false;
    for (event, range) in Parser::new_ext(complete, options()).into_offset_iter() {
        if depth == 0 && matches!(event, Event::Start(_) | Event::Rule) {
            last_block = range.start;
            last_is_code = matches!(event, Event::Start(Tag::CodeBlock(_)));
            held = false;
        }
        match &event {
            Event::Start(Tag::Table(_)) => held = true,
            Event::Start(Tag::CodeBlock(CodeBlockKind::Fenced(info)))
                if renders_when_closed(info) && range.len() <= HELD_SOURCE_LIMIT =>
            {
                held = true;
            }
            _ => {}
        }
        match event {
            Event::Start(_) => depth += 1,
            Event::End(_) => depth = depth.saturating_sub(1),
            _ => {}
        }
    }
    // A table's header row reads as a paragraph until its delimiter row arrives.
    held |= !last_is_code
        && complete[last_block..]
            .lines()
            .any(|line| line.trim_start().starts_with('|'));
    // The math renderer says where an unfinished display equation starts; past its own limit
    // it shows the source, and nothing is held.
    let math = MathMarkdown::new(complete, options(), None, false).pending_start;
    let boundary = [held.then_some(last_block), math]
        .into_iter()
        .flatten()
        .min()
        .unwrap_or(end);
    (boundary > 0).then_some(boundary)
}

struct Renderer<'s> {
    width: usize,
    /// The message's source, which event ranges index.
    source: &'s str,
    rendering: Rendering,
    /// Where display equations are in the source, so their rows copy as their TeX.
    display_math: Vec<Range<usize>>,
    /// Rows from this one on draw `source[range]`, once the row being filled is flushed.
    drawing: Option<(usize, Range<usize>)>,
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
    /// Open quotes, outermost first, with the alert kind of those that are alerts.
    quotes: Vec<Option<BlockQuoteKind>>,
    in_code_block: bool,
    fenced_code: bool,
    /// The open code block's language, and its text so far, highlighted when it ends.
    code_lang: String,
    code: String,
    /// The open code block's source range, and where its text so far ends.
    code_range: Range<usize>,
    code_end: usize,
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

impl<'s> Renderer<'s> {
    fn new(width: usize, source: &'s str, rendering: Rendering) -> Self {
        Self {
            width,
            source,
            rendering,
            display_math: Vec::new(),
            drawing: None,
            lines: Vec::new(),
            spans: Vec::new(),
            styles: Vec::new(),
            lists: Vec::new(),
            items: Vec::new(),
            pending_marker: None,
            quotes: Vec::new(),
            in_code_block: false,
            fenced_code: false,
            code_lang: String::new(),
            code: String::new(),
            code_range: 0..0,
            code_end: 0,
            link: None,
            blank_before_next_block: false,
            table: None,
        }
    }

    fn event(&mut self, event: Event<'_>, range: Range<usize>) {
        match event {
            Event::Start(tag) => self.start(tag, range),
            Event::End(tag) => self.end(tag),
            Event::Text(text) if self.in_code_block => {
                self.code_text(&text);
                self.code_end = range.end;
            }
            Event::Text(text) if self.display_math.contains(&range) => {
                self.display(&text, range);
            }
            Event::Text(text) | Event::InlineHtml(text) => self.text(&text),
            // An HTML block's lines arrive one per event, each with its newline.
            Event::Html(text) => {
                self.text(text.trim_end_matches('\n'));
                if text.ends_with('\n') {
                    self.flush();
                }
            }
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
            // Not emitted: `ENABLE_MATH` is off.
            Event::InlineMath(text) | Event::DisplayMath(text) => self.text(&text),
        }
    }

    fn start(&mut self, tag: Tag<'_>, range: Range<usize>) {
        match tag {
            Tag::Paragraph => self.start_block(),
            Tag::Heading { level, .. } => {
                self.start_block();
                let style = heading_style(level);
                let hashes = "#".repeat(heading_depth(level));
                self.spans.push(Span::styled(format!("{hashes} "), style));
                self.styles.push(style);
            }
            Tag::BlockQuote(kind) => {
                self.start_block();
                self.quotes.push(kind);
                match kind {
                    // An alert's text keeps the surrounding style; its label and bar carry
                    // the color.
                    Some(kind) => {
                        self.styles.push(self.style());
                        let style = Style::default()
                            .fg(alert_color(kind))
                            .add_modifier(Modifier::BOLD);
                        self.spans.push(Span::styled(alert_label(kind), style));
                        self.flush();
                    }
                    None => self.push_style(Style::default().fg(Color::Green)),
                }
            }
            Tag::CodeBlock(kind) => {
                self.start_block();
                self.in_code_block = true;
                self.fenced_code = matches!(kind, CodeBlockKind::Fenced(_));
                self.code.clear();
                self.code_lang.clear();
                self.code_end = range.start;
                self.code_range = range;
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
            Tag::Superscript | Tag::Subscript => self.styles.push(self.style()),
            // Not emitted: definition lists are off.
            Tag::DefinitionList | Tag::DefinitionListTitle | Tag::DefinitionListDefinition => {
                self.start_block();
            }
            Tag::HtmlBlock => self.start_block(),
            Tag::MetadataBlock(_) | Tag::TableRow | Tag::TableCell => {}
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
            TagEnd::BlockQuote(_) => {
                if !self.spans.is_empty() {
                    self.flush();
                }
                self.styles.pop();
                self.quotes.pop();
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
            TagEnd::Emphasis
            | TagEnd::Strong
            | TagEnd::Strikethrough
            | TagEnd::Superscript
            | TagEnd::Subscript => {
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
            TagEnd::DefinitionListTitle | TagEnd::DefinitionListDefinition => self.flush(),
            TagEnd::DefinitionList => self.blank_before_next_block = true,
            TagEnd::HtmlBlock => {
                if !self.spans.is_empty() {
                    self.flush();
                }
                self.blank_before_next_block = true;
            }
            TagEnd::MetadataBlock(_) => {}
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
        let drawing = Drawing::of_fence(&self.code_lang).filter(|_| self.fenced_code);
        if drawing == Some(Drawing::Mermaid) && self.rendering.mermaid {
            // Only a closed fence is drawn; one too big to draw shows why at once, so what
            // streaming commits of it stays.
            let too_big = self.code_range.len() > HELD_SOURCE_LIMIT;
            if too_big || self.closed_fence() {
                self.diagram(&code, too_big);
                return;
            }
        }
        if drawing == Some(Drawing::Math)
            && self.rendering.math
            && self.closed_fence()
            && let Some(layout) = self.math_fence(&code)
        {
            let first = self.lines.len();
            for row in layout.lines() {
                self.text(row.trim_end());
                self.flush();
            }
            let fence: Arc<str> = format!("```{}\n{code}```", self.code_lang).into();
            drawn_rows(&mut self.lines[first..], &fence);
            self.in_code_block = false;
            self.blank_before_next_block = true;
            return;
        }
        if !code.is_empty() {
            let lines = if self.fenced_code {
                highlight::code_lines(&code, &self.code_lang)
            } else {
                code.lines()
                    .map(|line| Line::from(format!("    {line}")))
                    .collect()
            };
            self.code_lines(lines);
        }
        self.in_code_block = false;
        self.blank_before_next_block = true;
    }

    /// Whether the code block ended at a closing fence rather than at the end of the message:
    /// past its text, the block's source ends in at least as many of its fence characters as
    /// opened it. From Codex's `markdown_render/mermaid.rs`.
    fn closed_fence(&self) -> bool {
        let Some(block) = self.source.get(self.code_range.clone()) else {
            return false;
        };
        let Some(marker @ (b'`' | b'~')) = block.as_bytes().first().copied() else {
            return false;
        };
        let opening = block.bytes().take_while(|byte| *byte == marker).count();
        let Some(rest) = self.source.get(self.code_end..self.code_range.end) else {
            return false;
        };
        rest.trim_end_matches([' ', '\t', '\r', '\n'])
            .bytes()
            .rev()
            .take_while(|byte| *byte == marker)
            .count()
            >= opening
    }

    /// A Mermaid diagram drawn as text, styled from the syntax theme as Codex styles it, or a
    /// dim reason it can't be and then its highlighted source. A drawn diagram copies as its
    /// fence.
    fn diagram(&mut self, code: &str, too_big: bool) {
        let width = self.width.saturating_sub(self.prefix_width());
        let drawn = if too_big {
            Err(RenderError::Limit)
        } else {
            mermaid::render_spans(code, width)
        };
        let rows = match drawn {
            Ok(rows) => rows,
            Err(error) => {
                let reason = match error {
                    RenderError::Unsupported => {
                        "This Mermaid diagram uses features the terminal renderer doesn't support."
                    }
                    RenderError::TooWide => {
                        "This Mermaid diagram doesn't fit the current terminal width."
                    }
                    RenderError::Limit => {
                        "This Mermaid diagram exceeds the terminal renderer's size limits."
                    }
                };
                self.spans.push(Span::styled(reason, dim()));
                self.flush();
                self.code_lines(highlight::code_lines(code, &self.code_lang));
                self.in_code_block = false;
                self.blank_before_next_block = true;
                return;
            }
        };
        let node = Style::default().fg(highlight::scope_color(&[
            "entity.name.type",
            "support.type",
            "variable",
        ])
        .unwrap_or(Color::Cyan));
        let edge = highlight::scope_color(&["comment"])
            .map_or_else(dim, |color| Style::default().fg(color));
        let first = self.lines.len();
        for row in rows {
            for span in row {
                let style = match span.role {
                    Role::Node => node,
                    Role::Edge => edge,
                    Role::Text => self.style(),
                };
                self.spans.push(Span::styled(span.text, style));
            }
            self.flush();
        }
        let fence: Arc<str> = format!("```{}\n{code}```", self.code_lang).into();
        drawn_rows(&mut self.lines[first..], &fence);
        self.in_code_block = false;
        self.blank_before_next_block = true;
    }

    /// A ```` ```math ```` fence's equation laid out for display, if it is in the math renderer's
    /// subset and its rows fit.
    fn math_fence(&self, code: &str) -> Option<String> {
        if self.code_range.len() > HELD_SOURCE_LIMIT {
            return None;
        }
        let width = self.width.saturating_sub(self.prefix_width());
        crate::math::render(code, true)
            .filter(|layout| layout.lines().all(|row| row.trim_end().width() <= width))
    }

    /// A display equation, one row per row of its layout. Its rows copy as its TeX, once the
    /// last of them, which later text on its line may share, is flushed.
    fn display(&mut self, text: &str, range: Range<usize>) {
        let first = self.lines.len();
        // An unfinished equation runs to the end of the message, its last newline included.
        let mut rows = text.trim_end_matches('\n').split('\n').peekable();
        while let Some(row) = rows.next() {
            self.text(row.trim_end());
            if rows.peek().is_some() {
                self.flush();
            }
        }
        self.drawing = Some((first, range));
    }

    /// Emit highlighted code lines, tabs expanded, one row each.
    fn code_lines(&mut self, lines: Vec<Line<'static>>) {
        for line in lines {
            for span in line.spans {
                let text = span.content.replace('\t', "    ");
                self.spans.push(Span::styled(text, span.style));
            }
            self.flush();
        }
    }

    /// Columns the open quotes and list items take before a row's text.
    fn prefix_width(&self) -> usize {
        let quotes: usize = self
            .quote_prefix()
            .iter()
            .map(|span| span.content.width())
            .sum();
        quotes + self.items.last().copied().unwrap_or(0)
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

    /// A `> ` per open quote, in its alert's color or the quotes' green.
    fn quote_prefix(&self) -> Vec<Span<'static>> {
        self.quotes
            .iter()
            .map(|kind| {
                let color = kind.map_or(Color::Green, alert_color);
                Span::styled("> ", Style::default().fg(color))
            })
            .collect()
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
        if let Some((first, range)) = self.drawing.take() {
            let tex: Arc<str> = self.source.get(range).unwrap_or_default().into();
            let first = first.min(self.lines.len());
            drawn_rows(&mut self.lines[first..], &tex);
        }
    }

    fn finish(mut self) -> Vec<DisplayLine> {
        if !self.spans.is_empty() || self.pending_marker.is_some() {
            self.flush();
        }
        self.lines
    }
}

/// Mark `rows` as drawing `source`, a diagram or a formula: copying any of them gives `source`
/// once, and Find reads them as shown.
fn drawn_rows(rows: &mut [DisplayLine], source: &Arc<str>) {
    for row in rows {
        let prefix_width = row.source.as_ref().map_or(0, |source| source.prefix_width);
        row.source = Some(LineSource {
            text: Arc::clone(source),
            range: 0..0,
            prefix_width,
            drawn: true,
        });
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

/// An alert's heading, as GitHub titles it.
fn alert_label(kind: BlockQuoteKind) -> &'static str {
    match kind {
        BlockQuoteKind::Note => "Note",
        BlockQuoteKind::Tip => "Tip",
        BlockQuoteKind::Important => "Important",
        BlockQuoteKind::Warning => "Warning",
        BlockQuoteKind::Caution => "Caution",
    }
}

/// An alert's color, after GitHub's: blue, green, purple, amber and red, in the terminal's own
/// shades of them but for the amber, which keeps to what reads on its background.
fn alert_color(kind: BlockQuoteKind) -> Color {
    match kind {
        BlockQuoteKind::Note => Color::Blue,
        BlockQuoteKind::Tip => Color::Green,
        BlockQuoteKind::Important => Color::Magenta,
        BlockQuoteKind::Warning => style::warning(),
        BlockQuoteKind::Caution => Color::Red,
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
    fn streaming_holds_back_a_mermaid_fence_until_the_next_block() {
        let intro = "A diagram:\n\n";
        let open = format!("{intro}```mermaid\nflowchart LR\n    A --> B\n");
        assert_eq!(commit_boundary(&open), Some(intro.len()));
        let closed = format!("{open}```\n");
        assert_eq!(commit_boundary(&closed), Some(intro.len()));
        let after = format!("{closed}\nafter\n");
        assert_eq!(commit_boundary(&after), Some(after.len()));
        // In a list, its item's block is what waits.
        let listed = "- first\n- diagram:\n\n  ```mermaid\n  graph TD\n";
        assert_eq!(commit_boundary(listed), None);
    }

    #[test]
    fn streaming_holds_back_a_table_header_before_its_delimiter_row() {
        let intro = "Keys:\n\n";
        let header = format!("{intro}| Keys | What they do |\n");
        assert_eq!(commit_boundary(&header), Some(intro.len()));
    }

    #[test]
    fn html_blocks_keep_their_lines() {
        let source = "<details>\n<summary>More</summary>\n\nHidden.\n";
        assert_eq!(
            render(source, 40),
            ["<details>", "<summary>More</summary>", "", "Hidden."]
        );
    }

    #[test]
    fn streaming_commits_other_code_and_what_looks_like_tables_in_it() {
        let rust = "Code:\n\n```rust\nfn main() {\n";
        assert_eq!(commit_boundary(rust), Some(rust.len()));
        let pipes = "Code:\n\n```\n| not | a table |\n";
        assert_eq!(commit_boundary(pipes), Some(pipes.len()));
    }

    #[test]
    fn streaming_holds_back_an_open_display_equation_from_its_first_line() {
        let intro = "The roots:\n\n";
        for (open, close) in [("$$", "$$"), ("\\[", "\\]")] {
            let partial = format!("{intro}{open}\nx = \\frac{{a}}{{b}}\n");
            assert_eq!(commit_boundary(&partial), Some(intro.len()), "{open}");
            let done = format!("{partial}{close}\n");
            assert_eq!(commit_boundary(&done), Some(done.len()), "{open}");
        }
        let one_line = "$$ E = mc^2 $$\nnext\n";
        assert_eq!(commit_boundary(one_line), Some(one_line.len()));
        // Mid-sentence dollars, and dollars in code, open nothing.
        let prose = "It costs $$5\nand `$$` too\n";
        assert_eq!(commit_boundary(prose), Some(prose.len()));
        let code = "```\n$$\n";
        assert_eq!(commit_boundary(code), Some(code.len()));
    }

    #[test]
    fn streaming_commits_a_held_block_past_the_limit_line_by_line() {
        let body = "x + ".repeat(HELD_SOURCE_LIMIT / 4 + 1);
        let math = format!("Big:\n\n$$\n{body}\n");
        assert_eq!(commit_boundary(&math), Some(math.len()));
        let fence = format!("Big:\n\n```mermaid\n{body}\n");
        assert_eq!(commit_boundary(&fence), Some(fence.len()));
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
    fn alerts_are_quotes_headed_by_their_kind_in_its_color() {
        let source = "> [!WARNING]\n> Quitting ends turns.\n\n> plain";
        let rows = render_markdown(source, 40);
        let text: Vec<String> = rows.iter().map(|row| row.line.to_string()).collect();
        assert_eq!(text, ["> Warning", "> Quitting ends turns.", "", "> plain"]);
        let style = |row: usize, text: &str| span(&rows[row], text).style;
        assert_eq!(style(0, ">").fg, Some(style::warning()));
        assert_eq!(style(1, ">").fg, Some(style::warning()));
        assert_eq!(style(3, ">").fg, Some(Color::Green));
        assert_eq!(style(0, "Warning").fg, Some(style::warning()));
        assert!(style(0, "Warning").add_modifier.contains(Modifier::BOLD));
        // An alert's text keeps the surrounding style; a plain quote's is green.
        assert_eq!(style(1, "Quitting").fg, None);
        assert_eq!(style(3, "plain").fg, Some(Color::Green));
    }

    /// The first span of `row` whose text contains `text`.
    fn span<'a>(row: &'a DisplayLine, text: &str) -> &'a Span<'static> {
        row.line
            .spans
            .iter()
            .find(|span| span.content.contains(text))
            .unwrap_or_else(|| panic!("no {text:?} in {:?}", row.line))
    }

    #[test]
    fn single_tildes_stay_strikethrough_and_carets_stay_text() {
        assert_eq!(render("~gone~ and x^2^", 40), ["gone and x^2^"]);
        let rows = render_markdown("~gone~", 40);
        let style = span(&rows[0], "gone").style;
        assert!(style.add_modifier.contains(Modifier::CROSSED_OUT));
    }

    const FLOWCHART: &str = "```mermaid\nflowchart LR\n    A[Ask] --> B[Answer]\n```\n";

    #[test]
    fn closed_mermaid_fences_are_drawn_and_copy_as_their_fence() {
        let rows = render_markdown(FLOWCHART, 60);
        let text: Vec<String> = rows.iter().map(|row| row.line.to_string()).collect();
        assert_eq!(text[1], "│ Ask │  │ Answer │", "{text:#?}");
        for row in &rows {
            let source = row.source.as_ref().expect("a source");
            assert!(source.drawn);
            assert_eq!(&*source.text, FLOWCHART.trim_end());
        }
    }

    #[test]
    fn find_matches_a_diagram_as_drawn() {
        let rows = render_markdown(FLOWCHART, 60);
        let hits = crate::find::find_in_rows(&rows, 0, &crate::find::fold("answer"));
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].start(), (1, 11));
    }

    #[test]
    fn open_or_disabled_mermaid_fences_show_their_source() {
        let open = FLOWCHART.trim_end().trim_end_matches('`');
        assert_eq!(
            render(open, 60),
            ["flowchart LR", "    A[Ask] --> B[Answer]"]
        );
        let off = Rendering {
            mermaid: false,
            ..Rendering::default()
        };
        let rows: Vec<String> = render_markdown_with(FLOWCHART, 60, off)
            .iter()
            .map(|row| row.line.to_string())
            .collect();
        assert_eq!(rows, ["flowchart LR", "    A[Ask] --> B[Answer]"]);
    }

    #[test]
    fn mermaid_outside_the_subset_or_too_wide_says_why_then_shows_its_source() {
        let pie = "```mermaid\npie\n    \"a\" : 1\n```\n";
        assert_eq!(
            render(pie, 80),
            [
                "This Mermaid diagram uses features the terminal renderer doesn't support.",
                "pie",
                "    \"a\" : 1"
            ]
        );
        let narrow = render(FLOWCHART, 16);
        assert_eq!(narrow[..2], ["This Mermaid", "diagram doesn't"]);
        assert!(narrow.contains(&"flowchart LR".to_owned()), "{narrow:#?}");
    }

    #[test]
    fn mermaid_in_quotes_and_lists_is_drawn_within_their_prefixes() {
        let source = "> ~~~mermaid\n> graph TD\n>     A --> B\n> ~~~\n\n- Diagram:\n\n  ```mermaid\n  graph LR\n      A --> B\n  ```\n";
        let text = render(source, 40);
        assert!(text[0].starts_with("> ┌"), "{text:#?}");
        let listed = text
            .iter()
            .position(|row| row == "- Diagram:")
            .expect("the item");
        assert!(text[listed + 2].starts_with("  ┌"), "{text:#?}");
    }

    #[test]
    fn math_renders_in_every_delimiter_and_disabled_keeps_its_source() {
        let source = "Both $\\alpha^2$ and \\(\\beta_1\\).\n\n$$\nx = \\frac{a}{b}\n$$\n";
        assert_eq!(
            render(source, 40),
            ["Both α² and β₁.", "", "    a", "x = ─", "    b"]
        );
        let off = Rendering {
            math: false,
            ..Rendering::default()
        };
        let rows: Vec<String> = render_markdown_with(source, 40, off)
            .iter()
            .map(|row| row.line.to_string())
            .collect();
        assert_eq!(
            rows,
            [
                "Both $\\alpha^2$ and \\(\\beta_1\\).",
                "",
                "$$",
                "x = \\frac{a}{b}",
                "$$"
            ]
        );
    }

    #[test]
    fn display_math_and_math_fences_copy_as_their_tex() {
        let display = "$$\nx = \\frac{a}{b}\n$$\n";
        for row in render_markdown(display, 40) {
            let source = row.source.expect("a source");
            assert!(source.drawn);
            assert_eq!(&*source.text, display.trim_end());
        }
        let fence = "```math\n\\frac{1}{3}\n```\n";
        let rows = render_markdown(fence, 40);
        let text: Vec<String> = rows.iter().map(|row| row.line.to_string()).collect();
        assert_eq!(text, ["1", "─", "3"]);
        assert_eq!(
            rows[0].source.as_ref().map(|source| &*source.text),
            Some(fence.trim_end())
        );
    }

    #[test]
    fn rendering_a_line_prefix_yields_an_output_prefix() {
        let full =
            "Intro line\n\n- item one\n- item two\n\n```sh\nls\n```\n> [!NOTE]\n> noted\n\nTail\n";
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
