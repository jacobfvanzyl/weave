//! Runs of the agent's work, folded into one row in the fullscreen transcript as the app folds
//! them (WVE-140, after WVE-91's `app/src/chat/transcript-runs.ts`).
//!
//! An uninterrupted run of tool calls, with the agent's thinking between them, folds into one
//! row once it holds two tool calls; anything else ends it. While a turn runs, its latest run is
//! one row however short. A row is closed until clicked, and the detailed view (Ctrl+T) shows
//! every run open. Inline mode doesn't fold: its cells go to scrollback as each call finishes.

use std::ops::AddAssign;
use std::time::Duration;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use ratatui::style::Style;
use ratatui::style::Stylize;
use ratatui::text::Line;
use ratatui::text::Span;
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;
use weave_acp_core::schema::ToolCallStatus;
use weave_acp_core::schema::ToolKind;

use crate::status::activity_bullet;
use crate::style;
use crate::style::dim;
use crate::tool_call::ToolCallCell;
use crate::transcript::TranscriptCell;
use crate::wrapping::DisplayLine;

/// Now, in milliseconds since the Unix epoch, as the Host's journal dates events.
pub fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        })
}

/// When an entry was made and last changed, in milliseconds since the Unix epoch, from the
/// dates of the events that made it; unknown for an entry made of none.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Times {
    pub started: Option<u64>,
    pub updated: Option<u64>,
}

impl Times {
    pub fn at(at: u64) -> Self {
        Self {
            started: Some(at),
            updated: Some(at),
        }
    }

    /// Changed at `at`.
    pub fn touch(&mut self, at: u64) {
        *self = self.join(Self::at(at));
    }

    /// From the earlier start to the later update.
    pub fn join(self, other: Self) -> Self {
        Self {
            started: earliest(self.started, other.started),
            updated: latest(self.updated, other.updated),
        }
    }
}

fn earliest(a: Option<u64>, b: Option<u64>) -> Option<u64> {
    match (a, b) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (a, b) => a.or(b),
    }
}

fn latest(a: Option<u64>, b: Option<u64>) -> Option<u64> {
    a.max(b)
}

/// Tool calls counted by what they did, and how many of them failed.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Tally {
    commands: usize,
    edits: usize,
    reads: usize,
    searches: usize,
    fetches: usize,
    others: usize,
    failed: usize,
}

impl Tally {
    pub fn of(call: &ToolCallCell) -> Self {
        let mut tally = Self {
            failed: usize::from(call.status == ToolCallStatus::Failed),
            ..Self::default()
        };
        let count = match call.kind() {
            ToolKind::Execute => &mut tally.commands,
            ToolKind::Edit | ToolKind::Delete | ToolKind::Move => &mut tally.edits,
            ToolKind::Read => &mut tally.reads,
            ToolKind::Search => &mut tally.searches,
            ToolKind::Fetch => &mut tally.fetches,
            _ => &mut tally.others,
        };
        *count = 1;
        tally
    }

    pub fn calls(&self) -> usize {
        self.commands + self.edits + self.reads + self.searches + self.fetches + self.others
    }

    /// What the calls did, by kind: "9 commands, 2 edits, 1 read", or "4 tool calls" when
    /// no kind is named.
    pub fn summary(&self) -> String {
        let kinds = [
            (self.commands, "command", "commands"),
            (self.edits, "edit", "edits"),
            (self.reads, "read", "reads"),
            (self.searches, "search", "searches"),
            (self.fetches, "fetch", "fetches"),
        ];
        if kinds.iter().all(|(count, _, _)| *count == 0) {
            return counted(self.calls(), "tool call", "tool calls");
        }
        let mut parts: Vec<String> = kinds
            .iter()
            .filter(|(count, _, _)| *count > 0)
            .map(|(count, one, many)| counted(*count, one, many))
            .collect();
        if self.others > 0 {
            parts.push(format!("{} other", self.others));
        }
        parts.join(", ")
    }
}

impl AddAssign for Tally {
    fn add_assign(&mut self, other: Self) {
        self.commands += other.commands;
        self.edits += other.edits;
        self.reads += other.reads;
        self.searches += other.searches;
        self.fetches += other.fetches;
        self.others += other.others;
        self.failed += other.failed;
    }
}

fn counted(count: usize, one: &str, many: &str) -> String {
    format!("{count} {}", if count == 1 { one } else { many })
}

/// How long something took, as people say it: "45s", "2m 17s", "1h 5m".
pub fn duration_text(elapsed: Duration) -> String {
    let seconds = (elapsed.as_millis() + 500) / 1000;
    if seconds < 60 {
        return format!("{seconds}s");
    }
    let minutes = seconds / 60;
    if minutes < 60 {
        return match seconds % 60 {
            0 => format!("{minutes}m"),
            rest => format!("{minutes}m {rest}s"),
        };
    }
    match minutes % 60 {
        0 => format!("{}h", minutes / 60),
        rest => format!("{}h {rest}m", minutes / 60),
    }
}

/// What a transcript entry is to a run of work.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Part {
    /// Tool calls: one, or reads and searches grouped as `Explored`; and the latest one's title.
    Calls { tally: Tally, step: String },
    /// The agent's thinking, which joins a run rather than ending it.
    Thought,
    /// A prompt or message, which ends a run: the next began once it was written.
    Message,
    /// Anything else, which ends a run.
    Other,
}

impl Part {
    /// One tool call; the user's own shell commands aren't the agent's work.
    pub fn call(call: &ToolCallCell) -> Self {
        if call.is_user_shell() {
            return Self::Other;
        }
        Self::Calls {
            tally: Tally::of(call),
            step: call.title().to_owned(),
        }
    }

    /// Tool calls that show as one entry, as reads and searches do.
    pub fn calls<'a>(calls: impl IntoIterator<Item = &'a ToolCallCell>) -> Self {
        let mut tally = Tally::default();
        let mut step = None;
        for call in calls {
            tally += Tally::of(call);
            step = Some(call.title());
        }
        match step {
            Some(step) => Self::Calls {
                tally,
                step: step.to_owned(),
            },
            None => Self::Other,
        }
    }

    pub fn is_work(&self) -> bool {
        matches!(self, Self::Calls { .. } | Self::Thought)
    }
}

/// What a run's entries add up to.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Summary {
    pub tally: Tally,
    /// When the run began and was last at work.
    pub times: Times,
    /// The step it's on: the latest call's title, or "Thinking". None for a run of nothing.
    pub step: Option<String>,
}

impl Summary {
    /// Begun when the prompt or message just before was written, if it was.
    fn after(before: Option<u64>) -> Self {
        Self {
            times: Times {
                started: before,
                updated: None,
            },
            ..Self::default()
        }
    }

    /// Count the entry after the ones so far.
    pub fn add(&mut self, part: &Part, times: Times) {
        match part {
            Part::Calls { tally, step } => {
                self.tally += *tally;
                self.step = Some(step.clone());
            }
            Part::Thought => self.step = Some("Thinking".to_owned()),
            Part::Message | Part::Other => return,
        }
        self.times = self.times.join(times);
    }

    pub fn is_empty(&self) -> bool {
        self.step.is_none()
    }

    /// Whether the run folds once it's over: two tool calls or more.
    pub fn folds(&self) -> bool {
        self.tally.calls() >= 2
    }

    fn took(&self) -> Option<Duration> {
        let (Some(started), Some(updated)) = (self.times.started, self.times.updated) else {
            return None;
        };
        Some(Duration::from_millis(updated.saturating_sub(started)))
    }

    /// The row the run folds into, at `width`. Over: what its calls did and how long it took,
    /// `• Ran 9 commands, 2 edits · 2m 17s`. While it's the running turn's latest (`now`, in
    /// milliseconds since the Unix epoch): `• Working · 12s · Run tests`. Either says how many
    /// calls failed.
    pub fn header(&self, now: Option<u64>, width: usize) -> DisplayLine {
        let separator = || Span::styled(" · ", dim());
        let (bullet, mut spans) = match now {
            Some(now) => {
                let elapsed = self
                    .times
                    .started
                    .map(|started| Duration::from_millis(now.saturating_sub(started)));
                let mut spans = vec![Span::styled("Working", Style::default().bold())];
                if let Some(elapsed) = elapsed {
                    // In whole seconds, as the status line below counts them.
                    let so_far = Duration::from_secs(elapsed.as_secs());
                    spans.push(separator());
                    spans.push(Span::styled(duration_text(so_far), dim()));
                }
                if let Some(step) = &self.step {
                    spans.push(separator());
                    spans.push(Span::raw(step.replace(char::is_control, " ")));
                }
                (activity_bullet(elapsed.unwrap_or_default()), spans)
            }
            None => {
                let mut spans = vec![
                    Span::styled("Ran", Style::default().bold()),
                    Span::raw(" "),
                    Span::raw(self.tally.summary()),
                ];
                if let Some(took) = self.took() {
                    spans.push(separator());
                    spans.push(Span::styled(duration_text(took), dim()));
                }
                ("•".green().bold(), spans)
            }
        };
        if self.tally.failed > 0 {
            spans.push(separator());
            spans.push(format!("{} failed", self.tally.failed).red());
        }
        let content = fit(spans, width.saturating_sub(2));
        let mut row = DisplayLine::whole(Line::from(content)).prefixed(&[bullet, Span::raw(" ")]);
        row.line.style = style::work_row();
        row
    }
}

/// `spans` cut to `width` columns, ending in `…` where they were cut.
fn fit(spans: Vec<Span<'static>>, width: usize) -> Vec<Span<'static>> {
    let total: usize = spans.iter().map(|span| span.content.width()).sum();
    if total <= width {
        return spans;
    }
    let room = width.saturating_sub(1);
    let mut used = 0;
    let mut fitted = Vec::new();
    for span in spans {
        let mut kept = String::new();
        for grapheme in span.content.graphemes(true) {
            if used + grapheme.width() > room {
                break;
            }
            used += grapheme.width();
            kept.push_str(grapheme);
        }
        let cut = kept.len() < span.content.len();
        fitted.push(Span::styled(kept, span.style));
        if cut {
            break;
        }
    }
    fitted.push("…".dim());
    fitted
}

/// A run of work: its entries as they were committed, and whether it shows them.
#[derive(Default)]
pub struct WorkRun {
    entries: Vec<TranscriptCell>,
    /// When the prompt or message just before it was last written, which is when it began.
    before: Option<u64>,
    /// Showing its entries under its row, as a click leaves it.
    pub open: bool,
}

impl WorkRun {
    /// A run after an entry written at `before`, if it was a prompt or message.
    pub fn after(before: Option<u64>) -> Self {
        Self {
            before,
            ..Self::default()
        }
    }

    pub fn push(&mut self, entry: TranscriptCell) {
        self.entries.push(entry);
    }

    pub fn entries(&self) -> &[TranscriptCell] {
        &self.entries
    }

    pub fn entries_mut(&mut self) -> &mut [TranscriptCell] {
        &mut self.entries
    }

    pub fn into_entries(self) -> Vec<TranscriptCell> {
        self.entries
    }

    /// What its entries so far add up to.
    pub fn summary(&self) -> Summary {
        let mut summary = Summary::after(self.before);
        for entry in &self.entries {
            summary.add(entry.part(), entry.times());
        }
        summary
    }

    /// Open or close what row `row` of the run heads, laid out as [`Self::lines`] lays it out:
    /// the run, from its own row, or a call among its entries while they show.
    pub fn toggle_at(&mut self, row: usize, width: usize, detail: bool) -> bool {
        if row == 0 {
            self.open = !self.open;
            return true;
        }
        if !self.open && !detail {
            return false;
        }
        let mut start = 1;
        for entry in &mut self.entries {
            // Each entry after a blank row.
            let first = start + 1;
            let end = first + entry.lines(width, detail).len();
            if row < end {
                return row >= first && entry.toggle_at(row - first, width, detail);
            }
            start = end;
        }
        false
    }

    /// The run once it's over, at `width`: its row, and its entries under it while it's open
    /// and in the detailed view.
    pub fn lines(&self, width: usize, detail: bool) -> Vec<DisplayLine> {
        let mut lines = vec![self.summary().header(None, width)];
        if self.open || detail {
            for entry in &self.entries {
                lines.push(DisplayLine::default());
                lines.extend(entry.lines(width, detail).iter().cloned());
            }
        }
        lines
    }
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;
    use weave_acp_core::schema::ToolCall;

    use super::*;

    fn call(kind: ToolKind, status: ToolCallStatus) -> ToolCallCell {
        ToolCallCell::new(ToolCall::new("t", "Do it").kind(kind).status(status))
    }

    fn tally(kinds: &[ToolKind]) -> Tally {
        let mut tally = Tally::default();
        for kind in kinds {
            tally += Tally::of(&call(*kind, ToolCallStatus::Completed));
        }
        tally
    }

    #[test]
    fn summaries_count_calls_by_kind_as_the_app_does() {
        use ToolKind::*;
        let mut kinds = vec![Execute; 9];
        kinds.extend([Edit, Move, Read]);
        assert_eq!(tally(&kinds).summary(), "9 commands, 2 edits, 1 read");
        assert_eq!(
            tally(&[Search, Fetch, Fetch, Think]).summary(),
            "1 search, 2 fetches, 1 other"
        );
        assert_eq!(
            tally(&[Other, Think, SwitchMode, Other]).summary(),
            "4 tool calls"
        );
        assert_eq!(tally(&[Other]).summary(), "1 tool call");
    }

    #[test]
    fn durations_read_as_people_say_them() {
        let text = |millis| duration_text(Duration::from_millis(millis));
        assert_eq!(text(400), "0s");
        assert_eq!(text(44_600), "45s");
        assert_eq!(text(137_000), "2m 17s");
        assert_eq!(text(120_000), "2m");
        assert_eq!(text(3_900_000), "1h 5m");
        assert_eq!(text(7_200_000), "2h");
    }

    #[test]
    fn a_run_begins_with_the_message_before_it_and_ends_with_its_last_update() {
        let mut summary = Summary::after(Some(1_000));
        summary.add(&Part::Thought, Times::at(3_000));
        let read = Part::call(&call(ToolKind::Read, ToolCallStatus::Completed));
        summary.add(
            &read,
            Times {
                started: Some(4_000),
                updated: Some(138_000),
            },
        );
        summary.add(&Part::Message, Times::at(200_000));
        assert_eq!(summary.took(), Some(Duration::from_millis(137_000)));
        assert_eq!(summary.step.as_deref(), Some("Do it"));
        assert!(!summary.folds());

        // Undated, it leaves the time out.
        let mut undated = Summary::default();
        undated.add(&read, Times::default());
        undated.add(&read, Times::default());
        assert_eq!(undated.header(None, 40).line.to_string(), "• Ran 2 reads");
    }

    #[test]
    fn rows_say_what_ran_or_what_is_running_and_what_failed() {
        let mut summary = Summary::after(Some(0));
        for (kind, status) in [
            (ToolKind::Execute, ToolCallStatus::Completed),
            (ToolKind::Execute, ToolCallStatus::Failed),
            (ToolKind::Edit, ToolCallStatus::Completed),
        ] {
            summary.add(&Part::call(&call(kind, status)), Times::at(137_000));
        }
        assert_eq!(
            summary.header(None, 60).line.to_string(),
            "• Ran 2 commands, 1 edit · 2m 17s · 1 failed"
        );
        // While it works, whole seconds so far, as the status line counts them.
        let working = summary.header(Some(12_900), 60).line.to_string();
        assert_eq!(&working[3..], " Working · 12s · Do it · 1 failed");
        // Cut to the width, never wrapped.
        assert_eq!(
            summary.header(None, 24).line.to_string(),
            "• Ran 2 commands, 1 edi…"
        );
    }
}
