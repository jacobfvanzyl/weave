//! A streaming agent message or thought.
//!
//! Inline mode follows Codex's newline-gated commit: everything up to the last newline is
//! final and can go to scrollback, while the partial line after it keeps re-rendering in the
//! viewport. Fullscreen keeps the whole message live and commits it as one transcript cell
//! when it ends, so it reflows with the screen.

use std::sync::Arc;

use ratatui::style::Modifier;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::text::Span;

use weave_acp_core::schema::MessageId;

use crate::history_cell;
use crate::history_cell::dim;
use crate::markdown::commit_boundary;
use crate::markdown::render_markdown;
use crate::runs::Times;
use crate::style;
use crate::thumbnails;
use crate::thumbnails::Slot;
use crate::tool_call::TRANSCRIPT_HINT;
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
    /// The images the message carries, shown under its text in the fullscreen transcript.
    images: Vec<Arc<Slot>>,
    /// Rendered lines already committed to scrollback.
    committed: usize,
    /// When its first and latest chunks came.
    times: Times,
}

impl MessageStream {
    pub fn new(kind: StreamKind, width: usize, message_id: Option<MessageId>) -> Self {
        Self {
            kind,
            message_id,
            width,
            source: String::new(),
            images: Vec::new(),
            committed: 0,
            times: Times::default(),
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

    pub fn push_image(&mut self, image: Arc<Slot>) {
        self.images.push(image);
    }

    /// A chunk came at `at`, in milliseconds since the Unix epoch.
    pub fn touch(&mut self, at: u64) {
        self.times.touch(at);
    }

    pub fn times(&self) -> Times {
        self.times
    }

    /// Lines for every complete source line that has not been committed yet (holding back a
    /// table still arriving; see [`commit_boundary`]).
    pub fn take_complete(&mut self) -> Vec<DisplayLine> {
        match commit_boundary(&self.source) {
            Some(end) => {
                let lines = self.render(&self.source[..end]);
                self.take_from(lines)
            }
            None => Vec::new(),
        }
    }

    /// The remaining uncommitted lines, once the message is over.
    pub fn finish(mut self) -> Vec<DisplayLine> {
        let lines = self.render(&self.source);
        self.take_from(lines)
    }

    /// The uncommitted lines as they look now, for the live viewport.
    pub fn tail(&self) -> Vec<Line<'static>> {
        let mut lines = plain_lines(self.render(&self.source));
        lines.drain(..self.committed.min(lines.len()));
        lines
    }

    pub fn has_committed(&self) -> bool {
        self.committed > 0
    }

    fn take_from(&mut self, mut lines: Vec<DisplayLine>) -> Vec<DisplayLine> {
        let fresh = lines.split_off(self.committed.min(lines.len()));
        self.committed = self.committed.max(lines.len() + fresh.len());
        fresh
    }

    fn render(&self, source: &str) -> Vec<DisplayLine> {
        render_message(self.kind, source, self.width)
    }

    /// The whole message as it stands, at `width`; fullscreen redraws it live until it ends.
    pub fn source(&self) -> &str {
        &self.source
    }

    pub fn render_all(&self, width: usize) -> Vec<DisplayLine> {
        render_with_images(self.kind, &self.source, &self.images, width)
    }

    /// The message's source and images.
    pub fn into_parts(self) -> (String, Vec<Arc<Slot>>) {
        (self.source, self.images)
    }
}

/// A message's full source rendered at `width`.
pub fn render_message(kind: StreamKind, source: &str, width: usize) -> Vec<DisplayLine> {
    if kind == StreamKind::User {
        return history_cell::user_message(source, width);
    }
    let body = render_markdown(source, width.saturating_sub(2));
    let (marker, body_style) = match kind {
        StreamKind::Agent => (dim(), Style::default()),
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

/// [`render_message`], with thumbnails of `images` under the text: inside a sent prompt's
/// block, or after anything else.
pub fn render_with_images(
    kind: StreamKind,
    source: &str,
    images: &[Arc<Slot>],
    width: usize,
) -> Vec<DisplayLine> {
    let mut lines = render_message(kind, source, width);
    let rows = thumbnails::transcript_rows(images, width);
    if rows.is_empty() {
        return lines;
    }
    if kind == StreamKind::User {
        // Above the blank row that closes the block, in its fill.
        let close = lines.pop();
        let fill = style::sent_prompt();
        lines.extend(rows.into_iter().map(|mut row| {
            row.line.style = fill;
            row
        }));
        lines.extend(close);
    } else {
        lines.extend(rows);
    }
    lines
}

/// Rows of a thought the compact transcript shows. Codex shows short reasoning summaries in
/// full; ACP agents stream whole thoughts, so they are cut to a preview there.
pub const THOUGHT_PREVIEW_ROWS: usize = 3;

/// A message as the compact transcript shows it: thoughts cut to their first rows.
pub fn render_compact(kind: StreamKind, source: &str, width: usize) -> Vec<DisplayLine> {
    let mut lines = render_message(kind, source, width);
    if kind == StreamKind::Thought && lines.len() > THOUGHT_PREVIEW_ROWS {
        let hidden = lines.len() - THOUGHT_PREVIEW_ROWS;
        lines.truncate(THOUGHT_PREVIEW_ROWS);
        let noun = if hidden == 1 { "line" } else { "lines" };
        lines.push(DisplayLine::plain(Line::from(Span::styled(
            format!("  +{hidden} {noun} ({TRANSCRIPT_HINT})"),
            dim(),
        ))));
    }
    lines
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    fn text(lines: &[impl Shown]) -> Vec<String> {
        lines.iter().map(Shown::shown).collect()
    }

    /// A row as text, whether it carries its source or not.
    trait Shown {
        fn shown(&self) -> String;
    }

    impl Shown for Line<'_> {
        fn shown(&self) -> String {
            self.to_string()
        }
    }

    impl Shown for DisplayLine {
        fn shown(&self) -> String {
            self.line.to_string()
        }
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
        // A padded block, as sent prompts are.
        assert_eq!(
            text(&stream.finish()),
            ["", "› fix the build", "  please", ""]
        );
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

    #[test]
    fn every_line_of_rich_markdown_is_committed_exactly_once() {
        for width in [40, 80] {
            let source = weave_fake_agent::MARKDOWN;
            let mut whole = MessageStream::new(StreamKind::Agent, width, None);
            whole.push(source);
            let expected = text(&whole.finish());

            let mut streamed = MessageStream::new(StreamKind::Agent, width, None);
            let mut committed = Vec::new();
            for piece in source.split_inclusive([' ', '\n']) {
                streamed.push(piece);
                committed.extend(text(&streamed.take_complete()));
            }
            committed.extend(text(&streamed.finish()));
            assert_eq!(committed, expected, "at width {width}");
        }
    }
}
