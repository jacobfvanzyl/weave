//! Context compaction, an ACP Preview feature (`unstable_session_compaction`): the agent
//! reports when it compacts its context, and the summary it kept, as one entity per id that
//! later updates and summary chunks patch in place.
//!
//! Shown as Codex shows its own compaction (`chatwidget/compaction.rs`): "Compacting context"
//! in the status line while it runs, with its own clock, then `Context compacted · 12s` in
//! the transcript. The kept summary is in the full transcript (Ctrl+T).

use std::time::Duration;
use std::time::Instant;

use ratatui::style::Stylize;
use ratatui::text::Line;
use weave_acp_core::MaybeUndefined;
use weave_acp_core::schema::CompactionId;
use weave_acp_core::schema::CompactionStatus;
use weave_acp_core::schema::CompactionUpdate;
use weave_acp_core::schema::ContentBlock;

use crate::history_cell;
use crate::markdown::render_markdown;
use crate::status::format_elapsed;
use crate::tool_call::TRANSCRIPT_HINT;
use crate::wrapping::DisplayLine;

/// The status line's label while a compaction runs, and the detail under it, as Codex's.
pub const RUNNING_LABEL: &str = "Compacting context";
pub const RUNNING_DETAIL: &str = "Making room to continue.";

#[derive(Clone, Debug)]
pub struct Compaction {
    pub id: CompactionId,
    status: CompactionStatus,
    summary: Vec<ContentBlock>,
    error: Option<String>,
    /// When it was seen starting; a replayed compaction arrives finished.
    started: Option<Instant>,
    elapsed: Option<Duration>,
}

impl Compaction {
    /// The entity a first update for its id creates.
    pub fn new(update: CompactionUpdate, now: Instant) -> Self {
        let mut compaction = Self {
            id: update.compaction_id.clone(),
            status: CompactionStatus::InProgress,
            summary: Vec::new(),
            error: None,
            started: None,
            elapsed: None,
        };
        compaction.started = (update.status == CompactionStatus::InProgress).then_some(now);
        compaction.apply(update, now);
        compaction
    }

    /// Patch from a later update: an omitted field stays, `null` clears it, and a value
    /// replaces it (a summary wholesale, including what chunks added).
    pub fn apply(&mut self, update: CompactionUpdate, now: Instant) {
        if let Some(started) = self.started
            && is_terminal(&update.status)
            && !is_terminal(&self.status)
        {
            self.elapsed = Some(now.saturating_duration_since(started));
        }
        self.status = update.status;
        match update.summary {
            MaybeUndefined::Undefined => {}
            MaybeUndefined::Null => self.summary.clear(),
            MaybeUndefined::Value(summary) => self.summary = summary,
        }
        match update.error {
            MaybeUndefined::Undefined => {}
            MaybeUndefined::Null => self.error = None,
            MaybeUndefined::Value(error) => self.error = Some(error),
        }
    }

    /// Append a streamed summary block.
    pub fn append(&mut self, content: ContentBlock) {
        self.summary.push(content);
    }

    /// Running, as far as the agent has said; an unknown status isn't taken to mean either.
    pub fn is_running(&self) -> bool {
        self.status == CompactionStatus::InProgress
    }

    pub fn is_finished(&self) -> bool {
        is_terminal(&self.status)
    }

    pub fn started(&self) -> Option<Instant> {
        self.started
    }

    /// The compaction as the transcript shows it; `detail` adds the kept summary.
    pub fn lines(&self, width: usize, detail: bool) -> Vec<DisplayLine> {
        let elapsed = self
            .elapsed
            .map(|elapsed| format!(" · {}", format_elapsed(elapsed)))
            .unwrap_or_default();
        let mut lines = match &self.status {
            CompactionStatus::Completed => {
                history_cell::info(&format!("Context compacted{elapsed}"), width)
            }
            CompactionStatus::Failed => {
                let reason = self
                    .error
                    .as_deref()
                    .map(|error| format!(": {error}"))
                    .unwrap_or_default();
                return history_cell::error(&format!("Context compaction failed{reason}"), width);
            }
            CompactionStatus::Cancelled => {
                history_cell::info(&format!("Context compaction cancelled{elapsed}"), width)
            }
            // Committed unfinished, when its turn ended first.
            CompactionStatus::InProgress => history_cell::info("Context compaction started", width),
            // An opaque state, shown as given.
            CompactionStatus::Other(status) => {
                history_cell::info(&format!("Context compaction: {status}"), width)
            }
            _ => history_cell::info("Context compaction", width),
        };
        let summary = self.summary_text();
        if summary.trim().is_empty() {
            return lines;
        }
        let body = render_markdown(&summary, width.saturating_sub(2));
        if detail {
            lines.extend(body.into_iter().map(|row| {
                if row.line.spans.is_empty() {
                    row
                } else {
                    row.prefixed(&["  ".into()])
                }
            }));
        } else {
            let count = body.len();
            let noun = if count == 1 { "line" } else { "lines" };
            lines.push(DisplayLine::plain(Line::from(
                format!("  └ Kept a summary: {count} {noun} ({TRANSCRIPT_HINT})").dim(),
            )));
        }
        lines
    }

    fn summary_text(&self) -> String {
        self.summary
            .iter()
            .map(|block| match block {
                ContentBlock::Text(text) => text.text.clone(),
                ContentBlock::Image(_) => "[image]".to_owned(),
                ContentBlock::Audio(_) => "[audio]".to_owned(),
                ContentBlock::ResourceLink(link) => format!("[{}]({})", link.name, link.uri),
                ContentBlock::Resource(_) => "[embedded resource]".to_owned(),
                _ => "[unsupported content]".to_owned(),
            })
            .collect()
    }
}

fn is_terminal(status: &CompactionStatus) -> bool {
    matches!(
        status,
        CompactionStatus::Completed | CompactionStatus::Failed | CompactionStatus::Cancelled
    )
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    fn text(lines: &[DisplayLine]) -> Vec<String> {
        lines.iter().map(|row| row.line.to_string()).collect()
    }

    fn update(status: CompactionStatus) -> CompactionUpdate {
        CompactionUpdate::new("c1", status)
    }

    #[test]
    fn a_live_compaction_reports_how_long_it_took_and_keeps_its_summary() {
        let start = Instant::now();
        let mut compaction = Compaction::new(update(CompactionStatus::InProgress), start);
        assert!(compaction.is_running());
        compaction.append(ContentBlock::from("## Kept\n\n"));
        compaction.append(ContentBlock::from("The user is fixing the parser."));
        compaction.apply(
            update(CompactionStatus::Completed),
            start + Duration::from_secs(12),
        );
        assert!(compaction.is_finished());
        assert_eq!(
            text(&compaction.lines(60, false)),
            [
                "• Context compacted · 12s",
                "  └ Kept a summary: 3 lines (⌃t to view transcript)",
            ]
        );
        assert_eq!(
            text(&compaction.lines(60, true)),
            [
                "• Context compacted · 12s",
                "  ## Kept",
                "",
                "  The user is fixing the parser.",
            ]
        );
    }

    #[test]
    fn updates_patch_the_summary_and_error() {
        let now = Instant::now();
        // A replay arrives finished, with no time to report.
        let mut compaction = Compaction::new(
            update(CompactionStatus::Completed).summary(vec![ContentBlock::from("old")]),
            now,
        );
        assert_eq!(compaction.summary_text(), "old");
        compaction.apply(
            update(CompactionStatus::Completed).summary(vec![ContentBlock::from("new")]),
            now,
        );
        assert_eq!(compaction.summary_text(), "new");
        compaction.apply(update(CompactionStatus::Completed), now);
        assert_eq!(compaction.summary_text(), "new");
        compaction.apply(
            update(CompactionStatus::Completed).summary(MaybeUndefined::Null),
            now,
        );
        assert_eq!(text(&compaction.lines(60, true)), ["• Context compacted"]);

        let failed = Compaction::new(
            update(CompactionStatus::Failed).error("model refused".to_owned()),
            now,
        );
        assert_eq!(
            text(&failed.lines(60, false)),
            ["■ Context compaction failed: model refused"]
        );
    }

    #[test]
    fn unknown_statuses_are_shown_as_given_and_not_taken_as_finished() {
        let compaction = Compaction::new(
            update(CompactionStatus::Other("_paused".to_owned())),
            Instant::now(),
        );
        assert!(!compaction.is_running() && !compaction.is_finished());
        assert_eq!(
            text(&compaction.lines(60, false)),
            ["• Context compaction: _paused"]
        );
    }
}
