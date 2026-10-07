//! Word wrapping for styled lines, preserving each span's style across breaks.

use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::text::Span;
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

/// Display width of a line in terminal cells.
pub fn line_width(line: &Line<'_>) -> usize {
    line.spans.iter().map(|span| span.content.width()).sum()
}

/// Wrap `line` to `width` cells, breaking at whitespace where possible and inside words
/// only when a word is wider than a whole line. Breaking whitespace is dropped.
pub fn wrap_line(line: &Line<'static>, width: usize) -> Vec<Line<'static>> {
    let width = width.max(1);
    let mut wrapped = Vec::new();
    let mut current: Vec<Span<'static>> = Vec::new();
    let mut current_width = 0;

    for (token, style) in tokens(line) {
        let token_width = token.width();
        let is_space = token.chars().all(char::is_whitespace);
        if current_width + token_width <= width {
            push_text(&mut current, token, style);
            current_width += token_width;
            continue;
        }
        if is_space {
            // Whitespace at a break point is consumed by the break.
            finish(&mut wrapped, &mut current, &mut current_width, line.style);
            continue;
        }
        if token_width <= width {
            finish(&mut wrapped, &mut current, &mut current_width, line.style);
            push_text(&mut current, token, style);
            current_width = token_width;
            continue;
        }
        // The word is wider than a line: hard-break it by grapheme.
        for grapheme in token.graphemes(true) {
            let grapheme_width = grapheme.width();
            if current_width + grapheme_width > width && current_width > 0 {
                finish(&mut wrapped, &mut current, &mut current_width, line.style);
            }
            push_text(&mut current, grapheme, style);
            current_width += grapheme_width;
        }
    }
    if !current.is_empty() || wrapped.is_empty() {
        wrapped.push(Line::from(current).style(line.style));
    }
    wrapped
}

/// Wrap `content` to fit after a prefix: the first output line starts with `first`, the rest
/// with `rest`. Both prefixes should have the same width.
pub fn wrap_with_prefix(
    content: &Line<'static>,
    width: usize,
    first: &Line<'static>,
    rest: &Line<'static>,
) -> Vec<Line<'static>> {
    let prefix_width = line_width(first).max(line_width(rest));
    wrap_line(content, width.saturating_sub(prefix_width))
        .into_iter()
        .enumerate()
        .map(|(index, line)| {
            let prefix = if index == 0 { first } else { rest };
            let mut spans = prefix.spans.clone();
            spans.extend(line.spans);
            Line::from(spans).style(line.style)
        })
        .collect()
}

/// Split a line into alternating word and whitespace runs, each with its span style.
fn tokens<'a>(line: &'a Line<'static>) -> Vec<(&'a str, Style)> {
    let mut out = Vec::new();
    for span in &line.spans {
        let text = span.content.as_ref();
        let mut start = 0;
        let mut in_space = None;
        for (index, ch) in text.char_indices() {
            let space = ch.is_whitespace();
            if in_space.is_some_and(|was| was != space) {
                out.push((&text[start..index], span.style));
                start = index;
            }
            in_space = Some(space);
        }
        if start < text.len() {
            out.push((&text[start..], span.style));
        }
    }
    out
}

fn push_text(spans: &mut Vec<Span<'static>>, text: &str, style: Style) {
    match spans.last_mut() {
        Some(last) if last.style == style => last.content.to_mut().push_str(text),
        _ => spans.push(Span::styled(text.to_owned(), style)),
    }
}

fn finish(
    wrapped: &mut Vec<Line<'static>>,
    current: &mut Vec<Span<'static>>,
    current_width: &mut usize,
    style: Style,
) {
    // Whitespace before a break would only pad the line's end.
    while let Some(last) = current.last_mut() {
        let kept = last.content.trim_end().len();
        if kept > 0 {
            last.content.to_mut().truncate(kept);
            break;
        }
        current.pop();
    }
    wrapped.push(Line::from(std::mem::take(current)).style(style));
    *current_width = 0;
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
    fn empty_line_stays_one_line() {
        assert_eq!(text(&wrap_line(&Line::default(), 10)), [""]);
    }
}
