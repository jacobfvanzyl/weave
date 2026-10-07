//! A streaming agent message or thought.
//!
//! Inline mode follows Codex's newline-gated commit: everything up to the last newline is
//! final and can go to scrollback, while the partial line after it keeps re-rendering in the
//! viewport. Fullscreen keeps the whole message live and commits it as one transcript cell
//! when it ends, so it reflows with the screen.

use ratatui::style::Modifier;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::text::Span;

use weave_acp_core::schema::MessageId;

use crate::history_cell;
use crate::history_cell::dim;
use crate::markdown::render_markdown;
use crate::wrapping::DisplayLine;
use crate::wrapping::plain_lines;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StreamKind {
    Agent,
    Thought,
    /// The user's own messages, as an agent replays them when loading a session.
    User,
}

pub struct MessageStream {
    kind: StreamKind,
    /// The agent's id for this message, when it provides one.
    message_id: Option<MessageId>,
    /// Fixed for the message's lifetime so committed and live lines always agree.
    width: usize,
    source: String,
    /// Rendered lines already committed to scrollback.
    committed: usize,
}

impl MessageStream {
    pub fn new(kind: StreamKind, width: usize, message_id: Option<MessageId>) -> Self {
        Self {
            kind,
            message_id,
            width,
            source: String::new(),
            committed: 0,
        }
    }

    pub fn kind(&self) -> StreamKind {
        self.kind
    }

    pub fn message_id(&self) -> Option<&MessageId> {
        self.message_id.as_ref()
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
        plain_lines(render_message(self.kind, source, self.width))
    }

    /// The whole message as it stands, at `width`; fullscreen redraws it live until it ends.
    pub fn source(&self) -> &str {
        &self.source
    }

    pub fn render_all(&self, width: usize) -> Vec<DisplayLine> {
        render_message(self.kind, &self.source, width)
    }

    pub fn into_source(self) -> String {
        self.source
    }
}

/// A message's full source rendered at `width`.
pub fn render_message(kind: StreamKind, source: &str, width: usize) -> Vec<DisplayLine> {
    if kind == StreamKind::User {
        return history_cell::user_message(source, width);
    }
    let body = render_markdown(source, width.saturating_sub(2));
    let (marker, body_style) = match kind {
        StreamKind::Agent => (Style::default(), Style::default()),
        StreamKind::Thought | StreamKind::User => (dim(), dim().add_modifier(Modifier::ITALIC)),
    };
    body.into_iter()
        .enumerate()
        .map(|(index, mut row)| {
            let prefix = match index {
                0 => "• ",
                // Blank lines stay empty rather than ending in indentation.
                _ if row.line.spans.is_empty() => "",
                _ => "  ",
            };
            row.line.style = row.line.style.patch(body_style);
            row.prefixed(&[Span::styled(prefix, marker)])
        })
        .collect()
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
        let mut stream = MessageStream::new(StreamKind::Agent, 40, None);
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
    fn replayed_user_messages_render_as_prompts() {
        let mut stream = MessageStream::new(StreamKind::User, 40, None);
        stream.push("fix the build\nplease");
        assert_eq!(text(&stream.finish()), ["› fix the build", "  please"]);
    }

    #[test]
    fn every_line_is_committed_exactly_once() {
        let source = "Plan:\n\n1. read\n2. edit\n\n```sh\nls\n```\nDone.";
        let mut whole = MessageStream::new(StreamKind::Agent, 30, None);
        whole.push(source);
        let expected = text(&whole.finish());

        let mut streamed = MessageStream::new(StreamKind::Agent, 30, None);
        let mut committed = Vec::new();
        for ch in source.chars() {
            streamed.push(&ch.to_string());
            committed.extend(text(&streamed.take_complete()));
        }
        committed.extend(text(&streamed.finish()));
        assert_eq!(committed, expected);
    }
}
