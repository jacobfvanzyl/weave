//! A streaming agent message or thought, committed to scrollback one finished line at a time.
//!
//! Follows Codex's newline-gated commit: everything up to the last newline is final and can
//! leave the viewport, while the partial line after it keeps re-rendering in place.

use ratatui::style::Modifier;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::text::Span;

use crate::history_cell::dim;
use crate::markdown::render_markdown;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StreamKind {
    Agent,
    Thought,
}

pub struct MessageStream {
    kind: StreamKind,
    /// Fixed for the message's lifetime so committed and live lines always agree.
    width: usize,
    source: String,
    /// Rendered lines already committed to scrollback.
    committed: usize,
}

impl MessageStream {
    pub fn new(kind: StreamKind, width: usize) -> Self {
        Self {
            kind,
            width,
            source: String::new(),
            committed: 0,
        }
    }

    pub fn kind(&self) -> StreamKind {
        self.kind
    }

    pub fn push(&mut self, text: &str) {
        self.source.push_str(text);
    }

    /// Lines for every complete source line that has not been committed yet.
    pub fn take_complete(&mut self) -> Vec<Line<'static>> {
        match self.source.rfind('\n') {
            Some(end) => {
                let lines = self.render(&self.source[..=end]);
                self.take_from(lines)
            }
            None => Vec::new(),
        }
    }

    /// The remaining uncommitted lines, once the message is over.
    pub fn finish(mut self) -> Vec<Line<'static>> {
        let lines = self.render(&self.source);
        self.take_from(lines)
    }

    /// The uncommitted lines as they look now, for the live viewport.
    pub fn tail(&self) -> Vec<Line<'static>> {
        let mut lines = self.render(&self.source);
        lines.drain(..self.committed.min(lines.len()));
        lines
    }

    pub fn has_committed(&self) -> bool {
        self.committed > 0
    }

    fn take_from(&mut self, mut lines: Vec<Line<'static>>) -> Vec<Line<'static>> {
        let fresh = lines.split_off(self.committed.min(lines.len()));
        self.committed = self.committed.max(lines.len() + fresh.len());
        fresh
    }

    fn render(&self, source: &str) -> Vec<Line<'static>> {
        let body = render_markdown(source, self.width.saturating_sub(2));
        let (marker, body_style) = match self.kind {
            StreamKind::Agent => (Style::default(), Style::default()),
            StreamKind::Thought => (dim(), dim().add_modifier(Modifier::ITALIC)),
        };
        body.into_iter()
            .enumerate()
            .map(|(index, line)| {
                let prefix = match index {
                    0 => "• ",
                    // Blank lines stay empty rather than ending in indentation.
                    _ if line.spans.is_empty() => "",
                    _ => "  ",
                };
                let mut spans = vec![Span::styled(prefix, marker)];
                spans.extend(line.spans);
                Line::from(spans).style(line.style.patch(body_style))
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    fn text(lines: &[Line<'_>]) -> Vec<String> {
        lines.iter().map(ToString::to_string).collect()
    }

    #[test]
    fn commits_only_finished_lines_and_keeps_the_partial_one_live() {
        let mut stream = MessageStream::new(StreamKind::Agent, 40);
        stream.push("Hello, wor");
        assert!(stream.take_complete().is_empty());
        assert_eq!(text(&stream.tail()), ["• Hello, wor"]);

        stream.push("ld!\nSecond li");
        assert_eq!(text(&stream.take_complete()), ["• Hello, world!"]);
        assert_eq!(text(&stream.tail()), ["  Second li"]);

        stream.push("ne");
        assert_eq!(text(&stream.finish()), ["  Second line"]);
    }

    #[test]
    fn every_line_is_committed_exactly_once() {
        let source = "Plan:\n\n1. read\n2. edit\n\n```sh\nls\n```\nDone.";
        let mut whole = MessageStream::new(StreamKind::Agent, 30);
        whole.push(source);
        let expected = text(&whole.finish());

        let mut streamed = MessageStream::new(StreamKind::Agent, 30);
        let mut committed = Vec::new();
        for ch in source.chars() {
            streamed.push(&ch.to_string());
            committed.extend(text(&streamed.take_complete()));
        }
        committed.extend(text(&streamed.finish()));
        assert_eq!(committed, expected);
    }
}
