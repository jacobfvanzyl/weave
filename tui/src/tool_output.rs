//! Rendering of tool call output: diffs and the transcripts of embedded terminals.

use std::collections::HashMap;

use ratatui::style::Color;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::text::Span;
use weave_acp_core::schema::TerminalExitStatus;
use weave_acp_core::schema::TerminalId;

use crate::history_cell::dim;

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
    /// What the terminal printed, escapes and all.
    pub fn raw(&self) -> &str {
        &self.raw
    }

    /// How the command ended, once it has.
    pub fn exit_line(&self) -> Option<Line<'static>> {
        self.exit
            .as_ref()
            .map(|status| exit_line(status, terminal_lines(&self.raw).is_empty()))
    }

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

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    #[test]
    fn terminal_text_drops_escapes_and_applies_carriage_returns() {
        let raw = "\x1b[32mok\x1b[0m\nprogress 10%\rprogress 100%\n\x1b]0;title\x07done\n";
        assert_eq!(terminal_lines(raw), ["ok", "progress 100%", "done"]);
    }

    #[test]
    fn transcripts_report_how_the_command_ended() {
        let mut transcript = TerminalTranscript::default();
        transcript.append("1\n2\n");
        assert_eq!(transcript.exit_line(), None);
        transcript.set_exit(TerminalExitStatus::new().exit_code(2));
        assert_eq!(
            transcript
                .exit_line()
                .map(|line| line.to_string())
                .as_deref(),
            Some("exit 2")
        );

        let mut silent = TerminalTranscript::default();
        silent.set_exit(TerminalExitStatus::new().signal("SIGKILL".to_owned()));
        assert_eq!(
            silent.exit_line().map(|line| line.to_string()).as_deref(),
            Some("stopped by SIGKILL (no output)")
        );
    }
}
