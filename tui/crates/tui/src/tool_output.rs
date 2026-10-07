//! Rendering of tool call output: diffs and the transcripts of embedded terminals.

use std::collections::HashMap;

use ratatui::style::Color;
use ratatui::style::Modifier;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::text::Span;
use weave_acp_core::schema::TerminalExitStatus;
use weave_acp_core::schema::TerminalId;

use crate::history_cell::dim;
use crate::wrapping::GutterLine;

/// Output retained per terminal for display; the agent keeps its own full copy.
const TRANSCRIPT_BYTES: usize = 64 * 1024;

pub type TerminalTranscripts = HashMap<TerminalId, TerminalTranscript>;

/// What a terminal printed, kept after the agent releases it so tool calls can still show it.
#[derive(Clone, Default)]
pub struct TerminalTranscript {
    raw: String,
    exit: Option<TerminalExitStatus>,
}

impl TerminalTranscript {
    pub fn append(&mut self, text: &str) {
        self.raw.push_str(text);
        if self.raw.len() > TRANSCRIPT_BYTES {
            let mut cut = self.raw.len() - TRANSCRIPT_BYTES;
            while !self.raw.is_char_boundary(cut) {
                cut += 1;
            }
            self.raw.drain(..cut);
        }
    }

    pub fn set_exit(&mut self, status: TerminalExitStatus) {
        self.exit = Some(status);
    }

    /// The last `max` output lines and, once the command has ended, how it ended.
    pub fn lines(&self, max: usize) -> Vec<Line<'static>> {
        let output = terminal_lines(&self.raw);
        let hidden = output.len().saturating_sub(max);
        let mut lines = Vec::new();
        if hidden > 0 {
            lines.push(Line::from(Span::styled(
                format!("… {hidden} earlier lines"),
                dim(),
            )));
        }
        lines.extend(
            output
                .into_iter()
                .skip(hidden)
                .map(|line| Line::from(Span::styled(line, dim()))),
        );
        match &self.exit {
            None if lines.is_empty() => lines.push(Line::from(Span::styled("running…", dim()))),
            None => {}
            Some(status) => lines.push(exit_line(status, lines.is_empty())),
        }
        lines
    }
}

fn exit_line(status: &TerminalExitStatus, no_output: bool) -> Line<'static> {
    let silent = if no_output { " (no output)" } else { "" };
    match (status.exit_code, &status.signal) {
        (Some(0), _) => Line::from(Span::styled(format!("exit 0{silent}"), dim())),
        (Some(code), _) => Line::from(Span::styled(
            format!("exit {code}{silent}"),
            Style::default().fg(Color::Red),
        )),
        (None, Some(signal)) => Line::from(Span::styled(
            format!("stopped by {signal}{silent}"),
            Style::default().fg(Color::Red),
        )),
        (None, None) => Line::from(Span::styled(format!("ended{silent}"), dim())),
    }
}

/// Split terminal output into display lines: escape sequences removed, carriage returns
/// applied the way a terminal would (later text overwrites the line), trailing blank dropped.
pub fn terminal_lines(raw: &str) -> Vec<String> {
    let text = strip_escape_sequences(raw);
    let mut lines: Vec<String> = text
        .split('\n')
        .map(|line| {
            let visible = line
                .rsplit('\r')
                .find(|part| !part.is_empty())
                .unwrap_or_default();
            visible
                .chars()
                .filter(|ch| *ch == '\t' || !ch.is_control())
                .collect::<String>()
                .replace('\t', "    ")
        })
        .collect();
    if lines.last().is_some_and(String::is_empty) {
        lines.pop();
    }
    lines
}

/// Remove ANSI CSI and OSC sequences and other escapes.
fn strip_escape_sequences(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '\x1b' {
            out.push(ch);
            continue;
        }
        match chars.next() {
            // CSI: parameters and intermediates, then one final byte in @..~.
            Some('[') => {
                for next in chars.by_ref() {
                    if ('@'..='~').contains(&next) {
                        break;
                    }
                }
            }
            // OSC: up to BEL or ST (ESC \).
            Some(']') => {
                while let Some(next) = chars.next() {
                    if next == '\x07' {
                        break;
                    }
                    if next == '\x1b' && chars.peek() == Some(&'\\') {
                        chars.next();
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    out
}

/// A diff as a header line plus numbered, colored rows, the rows capped at `max`. Line
/// numbers and signs are gutter, so copying takes just the text.
pub fn diff_lines(
    path: &str,
    old_text: Option<&str>,
    new_text: &str,
    max: usize,
) -> Vec<GutterLine> {
    let patch = diffy::create_patch(old_text.unwrap_or_default(), new_text);
    let (mut added, mut removed) = (0, 0);
    let mut rows = Vec::new();
    for hunk in patch.hunks() {
        if !rows.is_empty() {
            rows.push(GutterLine::from(Line::from(Span::styled("     ⋮", dim()))));
        }
        let mut old_line = hunk.old_range().start();
        let mut new_line = hunk.new_range().start();
        for line in hunk.lines() {
            let (number, sign, text, style) = match line {
                diffy::Line::Context(text) => {
                    let row = (new_line, ' ', *text, dim());
                    old_line += 1;
                    new_line += 1;
                    row
                }
                diffy::Line::Delete(text) => {
                    removed += 1;
                    let row = (old_line, '-', *text, Style::default().fg(Color::Red));
                    old_line += 1;
                    row
                }
                diffy::Line::Insert(text) => {
                    added += 1;
                    let row = (new_line, '+', *text, Style::default().fg(Color::Green));
                    new_line += 1;
                    row
                }
            };
            let text = text.trim_end_matches(['\n', '\r']).replace('\t', "    ");
            let text: String = text.chars().filter(|ch| !ch.is_control()).collect();
            rows.push(GutterLine {
                gutter: vec![
                    Span::styled(format!("{number:>4} "), dim()),
                    Span::styled(format!("{sign} "), style),
                ],
                content: Line::from(Span::styled(text, style)),
            });
        }
    }

    let counts = match old_text {
        None => format!(" (new file, +{added})"),
        Some(_) => format!(" (+{added} -{removed})"),
    };
    let mut lines = vec![GutterLine::from(Line::from(vec![
        Span::styled(
            path.to_owned(),
            Style::default().add_modifier(Modifier::BOLD),
        ),
        Span::styled(counts, dim()),
    ]))];
    let hidden = rows.len().saturating_sub(max);
    lines.extend(rows.into_iter().take(max));
    if hidden > 0 {
        lines.push(GutterLine::from(Line::from(Span::styled(
            format!("… +{hidden} lines"),
            dim(),
        ))));
    }
    lines
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    fn text(lines: &[Line<'_>]) -> Vec<String> {
        lines.iter().map(ToString::to_string).collect()
    }

    fn gutter_text(lines: &[GutterLine]) -> Vec<String> {
        lines
            .iter()
            .map(|line| {
                let gutter: String = line
                    .gutter
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect();
                format!("{gutter}{}", line.content)
            })
            .collect()
    }

    #[test]
    fn diffs_number_and_mark_changed_lines() {
        let old = "a\nb\nc\n";
        let new = "a\nB\nc\nd\n";
        assert_eq!(
            gutter_text(&diff_lines("f.txt", Some(old), new, 20)),
            [
                "f.txt (+2 -1)",
                "   1   a",
                "   2 - b",
                "   2 + B",
                "   3   c",
                "   4 + d"
            ]
        );
    }

    #[test]
    fn new_files_are_all_additions_and_rows_are_capped() {
        assert_eq!(
            gutter_text(&diff_lines("new.txt", None, "1\n2\n3\n", 2)),
            [
                "new.txt (new file, +3)",
                "   1 + 1",
                "   2 + 2",
                "… +1 lines"
            ]
        );
    }

    #[test]
    fn terminal_text_drops_escapes_and_applies_carriage_returns() {
        let raw = "\x1b[32mok\x1b[0m\nprogress 10%\rprogress 100%\n\x1b]0;title\x07done\n";
        assert_eq!(terminal_lines(raw), ["ok", "progress 100%", "done"]);
    }

    #[test]
    fn transcripts_show_the_tail_and_how_the_command_ended() {
        let mut transcript = TerminalTranscript::default();
        transcript.append("1\n2\n3\n");
        assert_eq!(text(&transcript.lines(2)), ["… 1 earlier lines", "2", "3"]);
        transcript.set_exit(TerminalExitStatus::new().exit_code(2));
        assert_eq!(text(&transcript.lines(5)), ["1", "2", "3", "exit 2"]);

        let mut silent = TerminalTranscript::default();
        assert_eq!(text(&silent.lines(5)), ["running…"]);
        silent.set_exit(TerminalExitStatus::new().signal("SIGKILL".to_owned()));
        assert_eq!(text(&silent.lines(5)), ["stopped by SIGKILL (no output)"]);
    }
}
