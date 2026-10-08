//! Word wrapping for styled lines, preserving each span's style across breaks.
//!
//! Wrapping also records where each row's text came from ([`DisplayLine`]), so copying a
//! selection gives back the logical text: wrapped rows rejoin without the breaks wrapping
//! added, and prefixes such as bullets, indents and gutters stay out. This follows Codex's
//! `LogicalLineSource`.

use std::ops::Range;
use std::sync::Arc;

use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::text::Span;
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

/// A rendered row and, when it shows text worth copying, where that text came from.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct DisplayLine {
    pub line: Line<'static>,
    pub source: Option<LineSource>,
}

/// The part of a logical line one row shows.
#[derive(Clone, Debug, PartialEq)]
pub struct LineSource {
    /// The whole logical line, as plain text. Rows of one line share it.
    pub text: Arc<str>,
    /// The bytes of `text` on this row.
    pub range: Range<usize>,
    /// Columns before the text starts: bullets, indents and gutters, which copying leaves out.
    pub prefix_width: usize,
}

impl DisplayLine {
    /// A row with nothing to copy beyond what is on screen, such as a blank separator.
    pub fn plain(line: Line<'static>) -> Self {
        Self { line, source: None }
    }

    /// A row that is its own logical line, all of it text.
    pub fn whole(line: Line<'static>) -> Self {
        let text: String = line
            .spans
            .iter()
            .map(|span| span.content.as_ref())
            .collect();
        let range = 0..text.len();
        Self {
            line,
            source: Some(LineSource {
                text: text.into(),
                range,
                prefix_width: 0,
            }),
        }
    }

    /// Put `prefix` in front, as gutter.
    pub fn prefixed(mut self, prefix: &[Span<'static>]) -> Self {
        let width: usize = prefix.iter().map(|span| span.content.width()).sum();
        self.line.spans.splice(0..0, prefix.iter().cloned());
        if let Some(source) = &mut self.source {
            source.prefix_width += width;
        }
        self
    }
}

impl From<Line<'static>> for DisplayLine {
    fn from(line: Line<'static>) -> Self {
        Self::plain(line)
    }
}

/// The rows' lines, without their sources.
pub fn plain_lines(lines: impl IntoIterator<Item = DisplayLine>) -> Vec<Line<'static>> {
    lines.into_iter().map(|line| line.line).collect()
}

/// Display width of a line in terminal cells.
pub fn line_width(line: &Line<'_>) -> usize {
    line.spans.iter().map(|span| span.content.width()).sum()
}

/// Wrap `line` to `width` cells, breaking at whitespace where possible and inside words
/// only when a word is wider than a whole line. Breaking whitespace is dropped.
pub fn wrap_line(line: &Line<'static>, width: usize) -> Vec<Line<'static>> {
    wrap_ranges(line, width)
        .into_iter()
        .map(|(line, _)| line)
        .collect()
}

/// [`wrap_line`], with the byte range of the line's text each row shows.
fn wrap_ranges(line: &Line<'static>, width: usize) -> Vec<(Line<'static>, Range<usize>)> {
    let width = width.max(1);
    let mut rows = Vec::new();
    let mut row = Row::default();

    for (offset, token, style) in tokens(line) {
        let token_width = token.width();
        let is_space = token.chars().all(char::is_whitespace);
        if row.width + token_width <= width {
            row.push(offset, token, style, is_space);
            continue;
        }
        if is_space {
            // Whitespace at a break point is consumed by the break.
            rows.push(row.finish(line.style));
            continue;
        }
        if token_width <= width {
            rows.push(row.finish(line.style));
            row.push(offset, token, style, false);
            continue;
        }
        // The word is wider than a line: hard-break it by grapheme.
        for (index, grapheme) in token.grapheme_indices(true) {
            if row.width + grapheme.width() > width && row.width > 0 {
                rows.push(row.finish(line.style));
            }
            row.push(offset + index, grapheme, style, false);
        }
    }
    if !row.spans.is_empty() || rows.is_empty() {
        let end = row.text_end.unwrap_or(row.start.unwrap_or_default());
        let start = row.start.unwrap_or(end);
        rows.push((Line::from(row.spans).style(line.style), start..end));
    }
    rows
}

/// One row being filled by [`wrap_ranges`].
#[derive(Default)]
struct Row {
    spans: Vec<Span<'static>>,
    width: usize,
    /// Where the row's text starts and where its last non-blank text ends.
    start: Option<usize>,
    text_end: Option<usize>,
}

impl Row {
    fn push(&mut self, offset: usize, text: &str, style: Style, is_space: bool) {
        push_text(&mut self.spans, text, style);
        self.width += text.width();
        self.start.get_or_insert(offset);
        if !is_space {
            self.text_end = Some(offset + text.len());
        }
    }

    fn finish(&mut self, style: Style) -> (Line<'static>, Range<usize>) {
        // Whitespace before a break would only pad the line's end.
        let mut spans = std::mem::take(&mut self.spans);
        while let Some(last) = spans.last_mut() {
            let kept = last.content.trim_end().len();
            if kept > 0 {
                last.content.to_mut().truncate(kept);
                break;
            }
            spans.pop();
        }
        let end = self.text_end.take().or(self.start).unwrap_or_default();
        let start = self.start.take().unwrap_or(end);
        self.width = 0;
        (Line::from(spans).style(style), start..end.max(start))
    }
}

/// Wrap `content` to fit after a prefix: the first output line starts with `first`, the rest
/// with `rest`. Both prefixes should have the same width.
pub fn wrap_with_prefix(
    content: &Line<'static>,
    width: usize,
    first: &Line<'static>,
    rest: &Line<'static>,
) -> Vec<Line<'static>> {
    plain_lines(wrap_sourced(content, width, first, rest))
}

/// [`wrap_with_prefix`], recording each row's part of `content` for copying.
pub fn wrap_sourced(
    content: &Line<'static>,
    width: usize,
    first: &Line<'static>,
    rest: &Line<'static>,
) -> Vec<DisplayLine> {
    let prefix_width = line_width(first).max(line_width(rest));
    let text: Arc<str> = content
        .spans
        .iter()
        .map(|span| span.content.as_ref())
        .collect::<String>()
        .into();
    wrap_ranges(content, width.saturating_sub(prefix_width))
        .into_iter()
        .enumerate()
        .map(|(index, (line, range))| {
            let prefix = if index == 0 { first } else { rest };
            let mut spans = prefix.spans.clone();
            spans.extend(line.spans);
            DisplayLine {
                line: Line::from(spans).style(line.style),
                source: Some(LineSource {
                    text: Arc::clone(&text),
                    range,
                    prefix_width: line_width(prefix),
                }),
            }
        })
        .collect()
}

/// A line with a gutter, such as a diff row's number and sign, that copying leaves out.
#[derive(Clone, Debug, Default)]
pub struct GutterLine {
    pub gutter: Vec<Span<'static>>,
    pub content: Line<'static>,
}

impl From<Line<'static>> for GutterLine {
    fn from(content: Line<'static>) -> Self {
        Self {
            gutter: Vec::new(),
            content,
        }
    }
}

/// Wrap a gutter line after `first` (or `rest`); continuation rows indent under the content.
pub fn wrap_gutter_line(
    line: &GutterLine,
    width: usize,
    first: &Line<'static>,
    rest: &Line<'static>,
) -> Vec<DisplayLine> {
    let gutter_width: usize = line.gutter.iter().map(|span| span.content.width()).sum();
    let mut first = first.clone();
    first.spans.extend(line.gutter.iter().cloned());
    let mut rest = rest.clone();
    rest.spans.push(Span::raw(" ".repeat(gutter_width)));
    wrap_sourced(&line.content, width, &first, &rest)
}

/// Split a line into alternating word and whitespace runs, each with its byte offset in the
/// line's text and its span style.
/// Word wrapping for text being edited: the rows one line of `text` (without line breaks)
/// takes at `width` columns, as byte ranges that cover all of it, so the cursor can sit
/// anywhere. Words move whole to the next row, and a word wider than a row breaks inside.
/// The blanks a break falls on stay at the end of the row before it, past its edge, rather
/// than starting the next one.
pub fn wrap_editable(text: &str, width: usize) -> Vec<Range<usize>> {
    let width = width.max(1);
    let mut rows = Vec::new();
    let mut start = 0;
    let mut column = 0;
    let mut word_start = None;
    let mut word_width = 0;
    let flush_word = |rows: &mut Vec<Range<usize>>,
                      start: &mut usize,
                      column: &mut usize,
                      word: usize,
                      word_end: usize,
                      word_width: usize| {
        if *column + word_width <= width {
            *column += word_width;
            return;
        }
        // Onto a row of its own, if the row so far has anything on it.
        if *column > 0 {
            rows.push(*start..word);
            *start = word;
            *column = 0;
        }
        if word_width <= width {
            *column = word_width;
            return;
        }
        // Wider than a row: break it by grapheme.
        for (offset, grapheme) in text[word..word_end].grapheme_indices(true) {
            let grapheme_width = grapheme.width();
            if *column + grapheme_width > width && *column > 0 {
                rows.push(*start..word + offset);
                *start = word + offset;
                *column = 0;
            }
            *column += grapheme_width;
        }
    };
    for (offset, grapheme) in text.grapheme_indices(true) {
        if grapheme.chars().all(char::is_whitespace) {
            if let Some(word) = word_start.take() {
                flush_word(&mut rows, &mut start, &mut column, word, offset, word_width);
            }
            column += grapheme.width();
        } else {
            if word_start.is_none() {
                word_start = Some(offset);
                word_width = 0;
            }
            word_width += grapheme.width();
        }
    }
    if let Some(word) = word_start {
        flush_word(
            &mut rows,
            &mut start,
            &mut column,
            word,
            text.len(),
            word_width,
        );
    }
    rows.push(start..text.len());
    rows
}

fn tokens<'a>(line: &'a Line<'static>) -> Vec<(usize, &'a str, Style)> {
    let mut out = Vec::new();
    let mut base = 0;
    for span in &line.spans {
        let text = span.content.as_ref();
        let mut start = 0;
        let mut in_space = None;
        for (index, ch) in text.char_indices() {
            let space = ch.is_whitespace();
            if in_space.is_some_and(|was| was != space) {
                out.push((base + start, &text[start..index], span.style));
                start = index;
            }
            in_space = Some(space);
        }
        if start < text.len() {
            out.push((base + start, &text[start..], span.style));
        }
        base += text.len();
    }
    out
}

fn push_text(spans: &mut Vec<Span<'static>>, text: &str, style: Style) {
    match spans.last_mut() {
        Some(last) if last.style == style => last.content.to_mut().push_str(text),
        _ => spans.push(Span::styled(text.to_owned(), style)),
    }
}

#[cfg(test)]
mod editable_tests {
    use pretty_assertions::assert_eq;

    use super::*;

    fn rows(text: &str, width: usize) -> Vec<&str> {
        wrap_editable(text, width)
            .into_iter()
            .map(|range| &text[range])
            .collect()
    }

    #[test]
    fn words_move_whole_and_breaks_keep_their_blanks() {
        assert_eq!(
            rows("for my Dygma sonsei to include", 14),
            ["for my Dygma ", "sonsei to ", "include"]
        );
        // Blanks past the edge hang there instead of starting the next row.
        assert_eq!(rows("abc   def", 4), ["abc   ", "def"]);
        assert_eq!(rows("", 4), [""]);
        assert_eq!(rows("ab", 4), ["ab"]);
    }

    #[test]
    fn a_word_wider_than_a_row_breaks_inside() {
        assert_eq!(rows("abcdefgh", 4), ["abcd", "efgh"]);
        assert_eq!(rows("a abcdefgh", 4), ["a ", "abcd", "efgh"]);
        // Wide characters count their columns.
        assert_eq!(rows("日本語 x", 4), ["日本", "語 x"]);
    }

    #[test]
    fn the_rows_cover_every_byte() {
        let text = "one two  three\tfour five";
        let ranges = wrap_editable(text, 5);
        assert_eq!(ranges.first().map(|range| range.start), Some(0));
        assert_eq!(ranges.last().map(|range| range.end), Some(text.len()));
        for pair in ranges.windows(2) {
            assert_eq!(pair[0].end, pair[1].start);
        }
    }
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;
    use ratatui::style::Stylize;

    use super::*;

    fn text(lines: &[Line<'_>]) -> Vec<String> {
        lines.iter().map(ToString::to_string).collect()
    }

    #[test]
    fn breaks_between_words_and_drops_the_breaking_space() {
        let line = Line::from("the quick brown fox");
        assert_eq!(text(&wrap_line(&line, 10)), ["the quick", "brown fox"]);
    }

    #[test]
    fn hard_breaks_words_wider_than_the_line() {
        let line = Line::from("abcdefghij kl");
        assert_eq!(text(&wrap_line(&line, 4)), ["abcd", "efgh", "ij", "kl"]);
    }

    #[test]
    fn keeps_styles_across_breaks() {
        let line = Line::from(vec!["plain ".into(), "bold words".bold()]);
        let wrapped = wrap_line(&line, 11);
        assert_eq!(text(&wrapped), ["plain bold", "words"]);
        assert_eq!(wrapped[1].spans[0].style, Style::default().bold());
    }

    #[test]
    fn counts_wide_characters_by_display_width() {
        let line = Line::from("日本語 テキスト");
        assert_eq!(text(&wrap_line(&line, 8)), ["日本語", "テキスト"]);
    }

    #[test]
    fn prefixes_first_and_continuation_lines() {
        let wrapped = wrap_with_prefix(
            &Line::from("one two three"),
            9,
            &Line::from("• "),
            &Line::from("  "),
        );
        assert_eq!(text(&wrapped), ["• one two", "  three"]);
    }

    #[test]
    fn rows_record_the_text_they_show() {
        let wrapped = wrap_sourced(
            &Line::from("one two three"),
            9,
            &Line::from("• "),
            &Line::from("  "),
        );
        let shown: Vec<(&str, usize)> = wrapped
            .iter()
            .filter_map(|row| row.source.as_ref())
            .map(|source| (&source.text[source.range.clone()], source.prefix_width))
            .collect();
        assert_eq!(shown, [("one two", 2), ("three", 2)]);
        let source = wrapped[0].source.as_ref().map(|source| &*source.text);
        assert_eq!(source, Some("one two three"));
    }

    #[test]
    fn hard_broken_words_keep_contiguous_ranges() {
        let ranges: Vec<Range<usize>> = wrap_ranges(&Line::from("abcdefghij kl"), 4)
            .into_iter()
            .map(|(_, range)| range)
            .collect();
        assert_eq!(ranges, [0..4, 4..8, 8..10, 11..13]);
    }

    #[test]
    fn empty_line_stays_one_line() {
        assert_eq!(text(&wrap_line(&Line::default(), 10)), [""]);
    }
}
