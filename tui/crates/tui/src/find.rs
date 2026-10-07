//! Matching for Find in the transcript (F3), after Codex's transcript search: a literal,
//! case-insensitive search over the transcript's text.
//!
//! Matching runs over logical lines rather than rows, so a match that wrapping split across
//! rows is still found; each match comes back as the row segments it covers.

use std::ops::Range;
use std::sync::Arc;

use unicode_width::UnicodeWidthStr;

use crate::wrapping::DisplayLine;

/// Part of a match on one row: the row and its columns, end exclusive.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Segment {
    pub row: usize,
    pub from: u16,
    pub to: u16,
}

/// One match: where it starts, and the segments it covers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hit {
    pub row: usize,
    pub column: u16,
    pub segments: Vec<Segment>,
}

impl Hit {
    pub fn start(&self) -> (usize, u16) {
        (self.row, self.column)
    }
}

/// `query` as matching compares it.
pub fn fold(query: &str) -> String {
    query.chars().flat_map(char::to_lowercase).collect()
}

/// One row's text: the logical line it shows part of, which bytes, and after what prefix.
struct RowText {
    text: Arc<str>,
    range: Range<usize>,
    prefix_width: usize,
}

impl RowText {
    fn of(line: &DisplayLine) -> Self {
        match &line.source {
            Some(source) => Self {
                text: Arc::clone(&source.text),
                range: source.range.clone(),
                prefix_width: source.prefix_width,
            },
            // A row without a source is its own line, as shown.
            None => {
                let text: String = line
                    .line
                    .spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect();
                let range = 0..text.len();
                Self {
                    text: text.into(),
                    range,
                    prefix_width: 0,
                }
            }
        }
    }

    /// Whether `next` continues the same logical line on the following row.
    fn continued_by(&self, next: &Self) -> bool {
        Arc::ptr_eq(&self.text, &next.text) && next.range.start >= self.range.end
    }

    /// The columns of `bytes` on this row, if any of them are on it.
    fn columns(&self, bytes: &Range<usize>) -> Option<(u16, u16)> {
        let start = bytes.start.max(self.range.start);
        let end = bytes.end.min(self.range.end);
        if start >= end {
            return None;
        }
        let column = |byte: usize| {
            let width = self.prefix_width + self.text[self.range.start..byte].width();
            u16::try_from(width).unwrap_or(u16::MAX)
        };
        Some((column(start), column(end)))
    }
}

/// The matches of `folded` (from [`fold`]) in `rows`, the first of which is row `first_row`,
/// in order.
pub fn find_in_rows(rows: &[DisplayLine], first_row: usize, folded: &str) -> Vec<Hit> {
    let mut hits = Vec::new();
    if folded.is_empty() {
        return hits;
    }
    let texts: Vec<RowText> = rows.iter().map(RowText::of).collect();
    let mut start = 0;
    while start < texts.len() {
        let mut end = start + 1;
        while end < texts.len() && texts[end - 1].continued_by(&texts[end]) {
            end += 1;
        }
        let line = &texts[start..end];
        let bytes = line[0].range.start..line[line.len() - 1].range.end;
        for found in find_all(&line[0].text[bytes.clone()], folded) {
            let found = found.start + bytes.start..found.end + bytes.start;
            let segments: Vec<Segment> = line
                .iter()
                .enumerate()
                .filter_map(|(offset, row)| {
                    let (from, to) = row.columns(&found)?;
                    Some(Segment {
                        row: first_row + start + offset,
                        from,
                        to,
                    })
                })
                .collect();
            // A match of only the whitespace a wrap dropped has nothing to show.
            if let Some(first) = segments.first() {
                hits.push(Hit {
                    row: first.row,
                    column: first.from,
                    segments,
                });
            }
        }
        start = end;
    }
    hits
}

/// The byte ranges of `text` matching `folded`, compared lowercased, without overlaps.
fn find_all(text: &str, folded: &str) -> Vec<Range<usize>> {
    let mut lowered = String::with_capacity(text.len());
    // For each byte range of `lowered`, the character of `text` it came from.
    let mut spans: Vec<(usize, Range<usize>)> = Vec::with_capacity(text.len());
    for (start, character) in text.char_indices() {
        for lowercase in character.to_lowercase() {
            lowered.push(lowercase);
            spans.push((lowered.len(), start..start + character.len_utf8()));
        }
    }
    let mut found = Vec::new();
    let mut from = 0;
    while let Some(at) = lowered[from..].find(folded) {
        let start = from + at;
        let end = start + folded.len();
        let first = spans.partition_point(|(span_end, _)| *span_end <= start);
        let last = spans.partition_point(|(span_end, _)| *span_end < end);
        if let (Some((_, first)), Some((_, last))) = (spans.get(first), spans.get(last)) {
            found.push(first.start..last.end);
        }
        from = end;
    }
    found
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;
    use ratatui::text::Line;

    use super::*;
    use crate::wrapping::LineSource;

    /// Rows showing `text`'s byte ranges `(start, end)`.
    fn wrapped(text: &str, ranges: &[(usize, usize)], prefix_width: usize) -> Vec<DisplayLine> {
        let text: Arc<str> = text.into();
        ranges
            .iter()
            .map(|&(start, end)| {
                let range = start..end;
                let shown = format!("{}{}", " ".repeat(prefix_width), &text[range.clone()]);
                DisplayLine {
                    line: Line::from(shown),
                    source: Some(LineSource {
                        text: Arc::clone(&text),
                        range,
                        prefix_width,
                    }),
                }
            })
            .collect()
    }

    #[test]
    fn matches_ignore_case_and_skip_the_prefix() {
        let rows = wrapped("Needle and needle", &[(0, 17)], 2);
        let hits = find_in_rows(&rows, 10, &fold("NEEDLE"));
        assert_eq!(
            hits,
            vec![
                Hit {
                    row: 10,
                    column: 2,
                    segments: vec![Segment {
                        row: 10,
                        from: 2,
                        to: 8
                    }],
                },
                Hit {
                    row: 10,
                    column: 13,
                    segments: vec![Segment {
                        row: 10,
                        from: 13,
                        to: 19
                    }],
                },
            ]
        );
    }

    #[test]
    fn a_match_split_by_wrapping_covers_both_rows() {
        // "find the needle" wrapped as "find the" / "needle", the space dropped.
        let rows = wrapped("find the needle", &[(0, 8), (9, 15)], 0);
        let hits = find_in_rows(&rows, 0, &fold("the nee"));
        assert_eq!(
            hits,
            vec![Hit {
                row: 0,
                column: 5,
                segments: vec![
                    Segment {
                        row: 0,
                        from: 5,
                        to: 8
                    },
                    Segment {
                        row: 1,
                        from: 0,
                        to: 3
                    },
                ],
            }]
        );
    }

    #[test]
    fn rows_without_a_source_match_as_shown() {
        let rows = vec![
            DisplayLine::plain(Line::from("  └ exit 1")),
            DisplayLine::default(),
        ];
        let hits = find_in_rows(&rows, 4, &fold("Exit"));
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].start(), (4, 4));
    }

    #[test]
    fn wide_characters_count_their_columns() {
        let rows = wrapped("日本 needle", &[(0, 13)], 0);
        let hits = find_in_rows(&rows, 0, "needle");
        assert_eq!(hits[0].start(), (0, 5));
    }
}
