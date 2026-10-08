//! Vim editing for the composer, after Codex's composer Vim mode
//! (`codex-rs/tui/src/bottom_pane/textarea/vim.rs` and `vim_commands.rs`, Apache-2.0).
//!
//! It edits the composer's own text and cursor, so switching in and out keeps the draft. It
//! covers the basics: Normal, Insert, Replace and Visual (characters or lines) modes; motions
//! with counts; the `d`, `c` and `y` operators with motions and text objects; `x`, `r`, `J`,
//! `~`, `p`, undo, redo and `.`; and `/` and `?` search within the draft. Codex has no Visual
//! mode; this one follows Vim's. Ctrl+Enter (or Cmd+Enter, where the terminal reports it)
//! sends from any mode, and Esc only ever changes mode.

use std::ops::Range;

use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyModifiers;
use unicode_segmentation::UnicodeSegmentation;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Normal,
    Insert,
    Replace,
    Visual,
    VisualLine,
}

impl Mode {
    /// The mode as Vim's status line names it.
    pub fn label(self) -> &'static str {
        match self {
            Self::Normal => "NORMAL",
            Self::Insert => "INSERT",
            Self::Replace => "REPLACE",
            Self::Visual => "VISUAL",
            Self::VisualLine => "V-LINE",
        }
    }

    fn is_visual(self) -> bool {
        matches!(self, Self::Visual | Self::VisualLine)
    }
}

/// What the composer does after a key.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Handled,
    /// Send the draft.
    Submit,
    /// `k` on the first line or `j` on the last: the previous or next prompt from history.
    HistoryPrevious,
    HistoryNext,
}

/// The terminal cursor for each mode, as Vim draws it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CursorShape {
    Block,
    Bar,
    Underline,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Operator {
    Delete,
    Change,
    Yank,
}

impl Operator {
    fn key(self) -> char {
        match self {
            Self::Delete => 'd',
            Self::Change => 'c',
            Self::Yank => 'y',
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Find {
    Forward,
    Backward,
    TillForward,
    TillBackward,
}

impl Find {
    fn reversed(self) -> Self {
        match self {
            Self::Forward => Self::Backward,
            Self::Backward => Self::Forward,
            Self::TillForward => Self::TillBackward,
            Self::TillBackward => Self::TillForward,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Pending {
    None,
    Operator(Operator),
    /// After `g`, with the operator it belongs to.
    G(Option<Operator>),
    /// After `f`, `F`, `t` or `T`, waiting for the character.
    Find(Find, Option<Operator>),
    /// After `i` or `a` following an operator, or in Visual mode.
    Object {
        inner: bool,
        operator: Option<Operator>,
    },
    /// After `r`, waiting for the replacement.
    Replace,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Motion {
    Left,
    Right,
    Up,
    Down,
    WordForward {
        big: bool,
    },
    WordBackward {
        big: bool,
    },
    WordEnd {
        big: bool,
    },
    WordEndBackward {
        big: bool,
    },
    LineStart,
    FirstNonBlank,
    LineEnd,
    /// A line by index, for `gg` and `G`.
    Line(usize),
    Find(Find, char),
    RepeatFind {
        reverse: bool,
    },
    MatchPair,
    ParagraphForward,
    ParagraphBackward,
    SearchNext {
        reverse: bool,
    },
    NextLine,
    PreviousLine,
}

/// How a motion's target bounds the text an operator takes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Exclusive,
    Inclusive,
    Linewise,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct Register {
    text: String,
    linewise: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Snapshot {
    text: String,
    cursor: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Search {
    pattern: String,
    forward: bool,
}

pub struct Vim {
    mode: Mode,
    /// Where a Visual selection started.
    anchor: usize,
    pending: Pending,
    count: Option<usize>,
    /// The count given before an operator, multiplied into its motion's.
    operator_count: Option<usize>,
    register: Register,
    undo: Vec<Snapshot>,
    redo: Vec<Snapshot>,
    /// The draft before the command in progress, kept for undo once the command changes it.
    before: Option<Snapshot>,
    /// The column `j` and `k` keep to, in characters; `usize::MAX` after `$`.
    want_column: Option<usize>,
    last_find: Option<(Find, char)>,
    last_search: Option<Search>,
    /// A search being typed after `/` or `?`.
    search_input: Option<Search>,
    /// Keys of the change in progress, and of the last one, for `.`.
    recording: Option<Vec<KeyEvent>>,
    last_change: Option<Vec<KeyEvent>>,
    replaying: bool,
    /// What Replace mode overwrote, so Backspace can put it back; `None` where it appended.
    replaced: Vec<Option<String>>,
    /// The keys of the command in progress, as Vim's `showcmd` shows them.
    typed: String,
}

impl Vim {
    pub fn new(mode: Mode) -> Self {
        Self {
            mode,
            anchor: 0,
            pending: Pending::None,
            count: None,
            operator_count: None,
            register: Register::default(),
            undo: Vec::new(),
            redo: Vec::new(),
            before: None,
            want_column: None,
            last_find: None,
            last_search: None,
            search_input: None,
            recording: None,
            last_change: None,
            replaying: false,
            replaced: Vec::new(),
            typed: String::new(),
        }
    }

    pub fn mode(&self) -> Mode {
        self.mode
    }

    pub fn cursor_shape(&self) -> CursorShape {
        match self.mode {
            Mode::Insert => CursorShape::Bar,
            Mode::Replace => CursorShape::Underline,
            _ => CursorShape::Block,
        }
    }

    /// The keys of the command in progress, such as `2d`.
    pub fn pending_keys(&self) -> &str {
        &self.typed
    }

    /// The search being typed, as Vim shows it: `/pattern` or `?pattern`.
    pub fn search_prompt(&self) -> Option<String> {
        self.search_input.as_ref().map(|search| {
            let lead = if search.forward { '/' } else { '?' };
            format!("{lead}{}", search.pattern)
        })
    }

    /// The selected text in Visual mode, as a byte range, and whether it is whole lines.
    pub fn selection(&self, text: &str, cursor: usize) -> Option<(Range<usize>, bool)> {
        let (low, high) = (self.anchor.min(cursor), self.anchor.max(cursor));
        match self.mode {
            Mode::Visual => Some((low..next_grapheme(text, high).max(low), false)),
            Mode::VisualLine => Some((line_start(text, low)..line_end(text, high), true)),
            _ => None,
        }
    }

    /// Note an edit made outside Vim, such as a paste, so it can be undone.
    pub fn before_external_edit(&mut self, text: &str, cursor: usize) {
        if matches!(self.mode, Mode::Normal | Mode::Visual | Mode::VisualLine) {
            self.push_undo(Snapshot {
                text: text.to_owned(),
                cursor,
            });
        }
    }

    pub fn handle_key(&mut self, text: &mut String, cursor: &mut usize, key: KeyEvent) -> Outcome {
        if is_send(key) {
            self.reset_command();
            return Outcome::Submit;
        }
        if self.at_rest() && !self.replaying {
            match self.mode {
                Mode::Normal => {
                    self.before = Some(snapshot(text, *cursor));
                    self.recording = Some(Vec::new());
                }
                Mode::Visual | Mode::VisualLine => {
                    self.before = Some(snapshot(text, *cursor));
                    self.recording = None;
                }
                Mode::Insert | Mode::Replace => {}
            }
        }
        if !self.replaying
            && let Some(recording) = &mut self.recording
        {
            recording.push(key);
        }
        let outcome = match self.mode {
            Mode::Insert => self.insert_key(text, cursor, key),
            Mode::Replace => self.replace_key(text, cursor, key),
            Mode::Normal | Mode::Visual | Mode::VisualLine => self.command_key(text, cursor, key),
        };
        self.finish(text);
        outcome
    }

    fn at_rest(&self) -> bool {
        self.pending == Pending::None
            && self.count.is_none()
            && self.operator_count.is_none()
            && self.search_input.is_none()
    }

    fn reset_command(&mut self) {
        self.pending = Pending::None;
        self.count = None;
        self.operator_count = None;
        self.search_input = None;
        self.typed.clear();
    }

    /// Settle a finished command: keep the draft before it for undo, and its keys for `.`,
    /// once it changed something. An Insert or Replace session settles when it ends.
    fn finish(&mut self, text: &str) {
        if !self.at_rest() || matches!(self.mode, Mode::Insert | Mode::Replace) {
            return;
        }
        self.typed.clear();
        let changed = self
            .before
            .as_ref()
            .is_some_and(|before| before.text != text);
        if let Some(before) = self.before.take()
            && changed
        {
            self.push_undo(before);
        }
        let recording = self.recording.take();
        if changed && self.mode == Mode::Normal && !self.replaying {
            self.last_change = recording;
        }
    }

    fn push_undo(&mut self, before: Snapshot) {
        if self.undo.last() != Some(&before) {
            self.undo.push(before);
        }
        self.redo.clear();
    }

    fn take_count(&mut self) -> usize {
        let count = self.count.take().unwrap_or(1) * self.operator_count.take().unwrap_or(1);
        count.max(1)
    }

    fn command_key(&mut self, text: &mut String, cursor: &mut usize, key: KeyEvent) -> Outcome {
        if self.search_input.is_some() {
            self.search_key(text, cursor, key);
            return Outcome::Handled;
        }
        let ch = command_char(key);
        if let Some(ch) = ch {
            self.typed.push(ch);
        }
        if key.code == KeyCode::Esc {
            if self.at_rest() && self.mode.is_visual() {
                self.mode = Mode::Normal;
                *cursor = clamp_normal(text, *cursor);
            }
            self.reset_command();
            return Outcome::Handled;
        }
        match self.pending {
            Pending::Find(find, operator) => {
                self.pending = Pending::None;
                if let Some(target) = ch {
                    self.last_find = Some((find, target));
                    return self.motion(text, cursor, Motion::Find(find, target), operator);
                }
                self.reset_command();
                return Outcome::Handled;
            }
            Pending::Replace => {
                self.pending = Pending::None;
                if let Some(with) = ch {
                    self.replace_chars(text, cursor, with);
                }
                self.reset_command();
                return Outcome::Handled;
            }
            Pending::Object { inner, operator } => {
                self.pending = Pending::None;
                let range = ch.and_then(|object| text_object(text, *cursor, object, inner));
                match (range, operator) {
                    (Some(range), Some(operator)) => {
                        self.count = None;
                        self.operator_count = None;
                        self.operate(text, cursor, operator, range, false);
                    }
                    (Some(range), None) if !range.is_empty() => {
                        self.anchor = range.start;
                        *cursor = prev_grapheme(text, range.end);
                        self.count = None;
                    }
                    _ => self.reset_command(),
                }
                return Outcome::Handled;
            }
            Pending::G(operator) => {
                self.pending = Pending::None;
                let motion = match ch {
                    Some('g') => {
                        let line = self.count.take().map_or(0, |line| line.saturating_sub(1));
                        Some(Motion::Line(line))
                    }
                    Some('e') => Some(Motion::WordEndBackward { big: false }),
                    Some('E') => Some(Motion::WordEndBackward { big: true }),
                    _ => None,
                };
                return match motion {
                    Some(motion) => self.motion(text, cursor, motion, operator),
                    None => {
                        self.reset_command();
                        Outcome::Handled
                    }
                };
            }
            Pending::None | Pending::Operator(_) => {}
        }
        if let Some(digit) = ch.and_then(|ch| ch.to_digit(10))
            && (digit != 0 || self.count.is_some())
        {
            let count = self.count.unwrap_or(0).saturating_mul(10) + digit as usize;
            self.count = Some(count.min(10_000));
            return Outcome::Handled;
        }
        let operator = match self.pending {
            Pending::Operator(operator) => Some(operator),
            _ => None,
        };
        if let Some(operator) = operator {
            if ch == Some(operator.key()) {
                self.pending = Pending::None;
                let lines = self.take_count();
                self.operate_lines(text, cursor, operator, lines);
                return Outcome::Handled;
            }
            if let Some(scope @ ('i' | 'a')) = ch {
                self.pending = Pending::Object {
                    inner: scope == 'i',
                    operator: Some(operator),
                };
                return Outcome::Handled;
            }
            // `cw` changes to the end of the word, as `ce` does, unless on a blank.
            if operator == Operator::Change
                && matches!(ch, Some('w' | 'W'))
                && char_at(text, *cursor).is_some_and(|ch| !ch.is_whitespace())
            {
                let big = ch == Some('W');
                return self.motion(text, cursor, Motion::WordEnd { big }, Some(operator));
            }
        }
        match ch {
            Some('f') => self.pending = Pending::Find(Find::Forward, operator),
            Some('F') => self.pending = Pending::Find(Find::Backward, operator),
            Some('t') => self.pending = Pending::Find(Find::TillForward, operator),
            Some('T') => self.pending = Pending::Find(Find::TillBackward, operator),
            Some('g') => self.pending = Pending::G(operator),
            Some('/' | '?') if !(self.mode == Mode::Normal && text.is_empty()) => {
                self.search_input = Some(Search {
                    pattern: String::new(),
                    forward: ch == Some('/'),
                });
            }
            _ => {
                if let Some(motion) = self.motion_for(text, key, ch) {
                    return self.motion(text, cursor, motion, operator);
                }
                if operator.is_some() {
                    self.reset_command();
                    return Outcome::Handled;
                }
                if self.mode.is_visual() {
                    self.visual_command(text, cursor, key, ch);
                } else {
                    self.normal_command(text, cursor, key, ch);
                }
                return Outcome::Handled;
            }
        }
        Outcome::Handled
    }

    fn motion_for(&mut self, text: &str, key: KeyEvent, ch: Option<char>) -> Option<Motion> {
        let motion = match (key.code, ch) {
            (_, Some('h')) | (KeyCode::Left | KeyCode::Backspace, _) => Motion::Left,
            (_, Some('l' | ' ')) | (KeyCode::Right, _) => Motion::Right,
            (_, Some('k')) | (KeyCode::Up, _) => Motion::Up,
            (_, Some('j')) | (KeyCode::Down, _) => Motion::Down,
            (_, Some('w')) => Motion::WordForward { big: false },
            (_, Some('W')) => Motion::WordForward { big: true },
            (_, Some('b')) => Motion::WordBackward { big: false },
            (_, Some('B')) => Motion::WordBackward { big: true },
            (_, Some('e')) => Motion::WordEnd { big: false },
            (_, Some('E')) => Motion::WordEnd { big: true },
            (_, Some('0')) | (KeyCode::Home, _) => Motion::LineStart,
            (_, Some('^')) => Motion::FirstNonBlank,
            (_, Some('$')) | (KeyCode::End, _) => Motion::LineEnd,
            (_, Some('G')) => {
                let last = line_count(text) - 1;
                let line = self
                    .count
                    .take()
                    .map_or(last, |line| line.saturating_sub(1));
                Motion::Line(line.min(last))
            }
            (_, Some(';')) => Motion::RepeatFind { reverse: false },
            (_, Some(',')) => Motion::RepeatFind { reverse: true },
            (_, Some('%')) => Motion::MatchPair,
            (_, Some('}')) => Motion::ParagraphForward,
            (_, Some('{')) => Motion::ParagraphBackward,
            (_, Some('n')) => Motion::SearchNext { reverse: false },
            (_, Some('N')) => Motion::SearchNext { reverse: true },
            (_, Some('+')) | (KeyCode::Enter, _) => Motion::NextLine,
            (_, Some('-')) => Motion::PreviousLine,
            _ => return None,
        };
        Some(motion)
    }

    /// Move by `motion`, or apply `operator` over it.
    fn motion(
        &mut self,
        text: &mut String,
        cursor: &mut usize,
        motion: Motion,
        operator: Option<Operator>,
    ) -> Outcome {
        self.pending = Pending::None;
        let count = self.take_count();
        // At the edge of the draft, `k` and `j` step through history, as Codex's do.
        if operator.is_none() && self.mode == Mode::Normal && count == 1 {
            let line = line_of(text, *cursor);
            if motion == Motion::Up && line == 0 {
                return Outcome::HistoryPrevious;
            }
            if motion == Motion::Down && line + 1 == line_count(text) {
                return Outcome::HistoryNext;
            }
        }
        let Some((target, kind)) = self.target(text, *cursor, motion, count) else {
            self.reset_command();
            return Outcome::Handled;
        };
        if !matches!(motion, Motion::Up | Motion::Down) {
            self.want_column = (motion == Motion::LineEnd).then_some(usize::MAX);
        }
        match operator {
            Some(operator) => {
                let (range, linewise) = motion_range(text, *cursor, target, kind);
                if linewise {
                    let first = line_of(text, range.start);
                    let last = line_of(text, range.end);
                    *cursor = line_start(text, range.start);
                    self.operate_line_range(text, cursor, operator, first, last);
                } else {
                    self.operate(text, cursor, operator, range, false);
                }
            }
            None => {
                *cursor = target;
                if self.mode == Mode::Normal {
                    *cursor = clamp_normal(text, *cursor);
                }
            }
        }
        Outcome::Handled
    }

    /// Where `motion` lands from `from`, `count` times, and how it bounds an operator.
    fn target(
        &mut self,
        text: &str,
        from: usize,
        motion: Motion,
        count: usize,
    ) -> Option<(usize, Kind)> {
        let start = line_start(text, from);
        let end = line_end(text, from);
        Some(match motion {
            Motion::Left => {
                let mut position = from;
                for _ in 0..count {
                    if position <= start {
                        break;
                    }
                    position = prev_grapheme(text, position);
                }
                (position, Kind::Exclusive)
            }
            Motion::Right => {
                let mut position = from;
                for _ in 0..count {
                    if position >= end {
                        break;
                    }
                    position = next_grapheme(text, position);
                }
                (position, Kind::Exclusive)
            }
            Motion::Up | Motion::Down => {
                let line = line_of(text, from);
                let target = if motion == Motion::Up {
                    line.checked_sub(count)?
                } else {
                    let target = line + count;
                    if target >= line_count(text) {
                        return None;
                    }
                    target
                };
                let column = *self
                    .want_column
                    .get_or_insert_with(|| column_of(text, from));
                (at_column(text, target, column), Kind::Linewise)
            }
            Motion::WordForward { big } => {
                let mut position = from;
                for _ in 0..count {
                    position = word_forward(text, position, big);
                }
                (position, Kind::Exclusive)
            }
            Motion::WordBackward { big } => {
                let mut position = from;
                for _ in 0..count {
                    position = word_backward(text, position, big);
                }
                (position, Kind::Exclusive)
            }
            Motion::WordEnd { big } => {
                let mut position = from;
                for _ in 0..count {
                    position = word_end(text, position, big);
                }
                (position, Kind::Inclusive)
            }
            Motion::WordEndBackward { big } => {
                let mut position = from;
                for _ in 0..count {
                    position = word_end_backward(text, position, big);
                }
                (position, Kind::Inclusive)
            }
            Motion::LineStart => (start, Kind::Exclusive),
            Motion::FirstNonBlank => (first_non_blank(text, start), Kind::Exclusive),
            Motion::LineEnd => {
                let line = (line_of(text, from) + count - 1).min(line_count(text) - 1);
                let end = line_bounds(text, line).end;
                (
                    prev_grapheme(text, end).max(line_bounds(text, line).start),
                    Kind::Inclusive,
                )
            }
            Motion::Line(line) => {
                let line = line.min(line_count(text) - 1);
                (
                    first_non_blank(text, line_bounds(text, line).start),
                    Kind::Linewise,
                )
            }
            Motion::Find(find, target) => (
                find_in_line(text, from, find, target, count)?,
                find_kind(find),
            ),
            Motion::RepeatFind { reverse } => {
                let (find, target) = self.last_find?;
                let find = if reverse { find.reversed() } else { find };
                // Repeating `t` or `T` skips the match the cursor already stands next to.
                let from = match find {
                    Find::TillForward => next_grapheme(text, from),
                    Find::TillBackward => prev_grapheme(text, from).max(start),
                    _ => from,
                };
                (
                    find_in_line(text, from, find, target, count)?,
                    find_kind(find),
                )
            }
            Motion::MatchPair => (match_pair(text, from)?, Kind::Inclusive),
            Motion::ParagraphForward => {
                let mut position = from;
                for _ in 0..count {
                    position = paragraph_forward(text, position);
                }
                (position, Kind::Exclusive)
            }
            Motion::ParagraphBackward => {
                let mut position = from;
                for _ in 0..count {
                    position = paragraph_backward(text, position);
                }
                (position, Kind::Exclusive)
            }
            Motion::SearchNext { reverse } => {
                let search = self.last_search.clone()?;
                let forward = search.forward != reverse;
                let mut position = from;
                for _ in 0..count {
                    position = search_from(text, position, &search.pattern, forward)?;
                }
                (position, Kind::Exclusive)
            }
            Motion::NextLine | Motion::PreviousLine => {
                let line = line_of(text, from);
                let target = if motion == Motion::NextLine {
                    let target = line + count;
                    if target >= line_count(text) {
                        return None;
                    }
                    target
                } else {
                    line.checked_sub(count)?
                };
                (
                    first_non_blank(text, line_bounds(text, target).start),
                    Kind::Linewise,
                )
            }
        })
    }

    fn normal_command(
        &mut self,
        text: &mut String,
        cursor: &mut usize,
        key: KeyEvent,
        ch: Option<char>,
    ) {
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        if ctrl && key.code == KeyCode::Char('r') {
            let count = self.take_count();
            self.redo(text, cursor, count);
            return;
        }
        if key.code == KeyCode::Delete {
            self.delete_chars(text, cursor, true);
            return;
        }
        let Some(ch) = ch else {
            self.reset_command();
            return;
        };
        let start = line_start(text, *cursor);
        let end = line_end(text, *cursor);
        match ch {
            'i' => self.enter_insert(),
            'a' => {
                if *cursor < end {
                    *cursor = next_grapheme(text, *cursor);
                }
                self.enter_insert();
            }
            'I' => {
                *cursor = first_non_blank(text, start);
                self.enter_insert();
            }
            'A' => {
                *cursor = end;
                self.enter_insert();
            }
            'o' => {
                text.insert(end, '\n');
                *cursor = end + 1;
                self.enter_insert();
            }
            'O' => {
                text.insert(start, '\n');
                *cursor = start;
                self.enter_insert();
            }
            'x' => self.delete_chars(text, cursor, true),
            'X' => self.delete_chars(text, cursor, false),
            's' => {
                let count = self.take_count();
                let mut stop = *cursor;
                for _ in 0..count {
                    if stop < end {
                        stop = next_grapheme(text, stop);
                    }
                }
                self.operate(text, cursor, Operator::Change, *cursor..stop, false);
            }
            'S' => {
                let lines = self.take_count();
                self.operate_lines(text, cursor, Operator::Change, lines);
            }
            'C' | 'D' => {
                let operator = if ch == 'C' {
                    Operator::Change
                } else {
                    Operator::Delete
                };
                let count = self.take_count();
                let last = (line_of(text, *cursor) + count - 1).min(line_count(text) - 1);
                let stop = line_bounds(text, last).end;
                self.operate(text, cursor, operator, *cursor..stop, false);
            }
            'Y' => {
                let lines = self.take_count();
                self.operate_lines(text, cursor, Operator::Yank, lines);
            }
            'd' | 'c' | 'y' => {
                self.operator_count = self.count.take();
                self.pending = Pending::Operator(match ch {
                    'd' => Operator::Delete,
                    'c' => Operator::Change,
                    _ => Operator::Yank,
                });
            }
            'r' => self.pending = Pending::Replace,
            'R' => {
                self.replaced.clear();
                self.count = None;
                self.mode = Mode::Replace;
            }
            'J' => {
                let lines = self.take_count().max(2);
                self.join_lines(text, cursor, lines);
            }
            '~' => {
                let count = self.take_count();
                let mut stop = *cursor;
                for _ in 0..count {
                    if stop < end {
                        stop = next_grapheme(text, stop);
                    }
                }
                let changed = toggle_case(&text[*cursor..stop]);
                text.replace_range(*cursor..stop, &changed);
                *cursor = clamp_normal(text, *cursor + changed.len());
            }
            'p' | 'P' => {
                let count = self.take_count();
                self.paste(text, cursor, ch == 'p', count);
            }
            'u' => {
                let count = self.take_count();
                self.undo(text, cursor, count);
            }
            '.' => {
                let count = self.count.take();
                self.repeat(text, cursor, count);
            }
            'v' => {
                self.count = None;
                self.anchor = *cursor;
                self.mode = Mode::Visual;
            }
            'V' => {
                self.count = None;
                self.anchor = *cursor;
                self.mode = Mode::VisualLine;
            }
            // On an empty draft, `/` starts a slash command, as in Codex.
            '/' => {
                self.enter_insert();
                text.push('/');
                *cursor = text.len();
            }
            _ => self.reset_command(),
        }
    }

    fn visual_command(
        &mut self,
        text: &mut String,
        cursor: &mut usize,
        key: KeyEvent,
        ch: Option<char>,
    ) {
        let Some((range, linewise)) = self.selection(text, *cursor) else {
            return;
        };
        let first = line_of(text, range.start);
        let last = line_of(text, range.end);
        let ch = match (key.code, ch) {
            (KeyCode::Delete, _) => 'x',
            (_, Some(ch)) => ch,
            _ => {
                self.reset_command();
                return;
            }
        };
        self.count = None;
        match ch {
            'o' => std::mem::swap(&mut self.anchor, cursor),
            'v' | 'V' => {
                let mode = if ch == 'v' {
                    Mode::Visual
                } else {
                    Mode::VisualLine
                };
                self.mode = if self.mode == mode {
                    Mode::Normal
                } else {
                    mode
                };
                *cursor = clamp_normal(text, *cursor);
            }
            'i' | 'a' => {
                self.pending = Pending::Object {
                    inner: ch == 'i',
                    operator: None,
                };
            }
            'd' | 'x' | 'c' | 's' | 'y' => {
                let operator = match ch {
                    'c' | 's' => Operator::Change,
                    'y' => Operator::Yank,
                    _ => Operator::Delete,
                };
                self.mode = Mode::Normal;
                *cursor = range.start;
                if linewise {
                    self.operate_line_range(text, cursor, operator, first, last);
                } else {
                    self.operate(text, cursor, operator, range, false);
                }
            }
            'D' | 'X' | 'C' | 'S' | 'R' | 'Y' => {
                let operator = match ch {
                    'C' | 'S' | 'R' => Operator::Change,
                    'Y' => Operator::Yank,
                    _ => Operator::Delete,
                };
                self.mode = Mode::Normal;
                *cursor = line_start(text, range.start);
                self.operate_line_range(text, cursor, operator, first, last);
            }
            '~' | 'u' | 'U' => {
                let selected = &text[range.clone()];
                let changed = match ch {
                    'u' => selected.to_lowercase(),
                    'U' => selected.to_uppercase(),
                    _ => toggle_case(selected),
                };
                text.replace_range(range.clone(), &changed);
                self.mode = Mode::Normal;
                *cursor = clamp_normal(text, range.start);
            }
            'J' => {
                self.mode = Mode::Normal;
                *cursor = range.start;
                self.join_lines(text, cursor, (last - first + 1).max(2));
            }
            // The selection is replaced; `p` keeps what it replaced in the register, as Vim
            // does, and `P` keeps the register as it was.
            'p' | 'P' => {
                let put = self.register.clone();
                self.mode = Mode::Normal;
                *cursor = range.start;
                if linewise {
                    let through_end = last + 1 >= line_count(text);
                    self.operate_line_range(text, cursor, Operator::Delete, first, last);
                    let replaced = std::mem::replace(
                        &mut self.register,
                        Register {
                            text: put.text.clone(),
                            linewise: true,
                        },
                    );
                    if text.is_empty() {
                        text.push_str(&put.text);
                        *cursor = first_non_blank(text, 0);
                    } else {
                        // Lines taken from the end go back after the new last line.
                        self.paste(text, cursor, through_end, 1);
                    }
                    self.register = if ch == 'p' { replaced } else { put };
                } else {
                    self.operate(text, cursor, Operator::Delete, range.clone(), false);
                    let replaced = std::mem::replace(&mut self.register, put.clone());
                    let inserted = if put.linewise {
                        format!("\n{}\n", put.text)
                    } else {
                        put.text.clone()
                    };
                    text.insert_str(range.start, &inserted);
                    *cursor = prev_grapheme(text, range.start + inserted.len()).max(range.start);
                    if ch == 'p' {
                        self.register = replaced;
                    }
                }
            }
            'r' => self.pending = Pending::Replace,
            _ => self.reset_command(),
        }
    }

    fn enter_insert(&mut self) {
        self.count = None;
        self.mode = Mode::Insert;
    }

    /// Leave Insert or Replace for Normal, stepping back onto the last character as Vim does.
    fn leave_insert(&mut self, text: &str, cursor: &mut usize) {
        self.mode = Mode::Normal;
        self.replaced.clear();
        if *cursor > line_start(text, *cursor) {
            *cursor = prev_grapheme(text, *cursor);
        }
        *cursor = clamp_normal(text, *cursor);
    }

    fn insert_key(&mut self, text: &mut String, cursor: &mut usize, key: KeyEvent) -> Outcome {
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        let alt = key.modifiers.contains(KeyModifiers::ALT);
        match key.code {
            KeyCode::Esc => self.leave_insert(text, cursor),
            KeyCode::Char('[') if ctrl => self.leave_insert(text, cursor),
            KeyCode::Enter => insert(text, cursor, "\n"),
            KeyCode::Char('j') if ctrl => insert(text, cursor, "\n"),
            KeyCode::Backspace if ctrl || alt => {
                let start = word_backward(text, *cursor, false);
                remove(text, cursor, start..*cursor);
            }
            KeyCode::Backspace => {
                let start = prev_grapheme(text, *cursor);
                remove(text, cursor, start..*cursor);
            }
            KeyCode::Char('h') if ctrl => {
                let start = prev_grapheme(text, *cursor);
                remove(text, cursor, start..*cursor);
            }
            KeyCode::Char('w') if ctrl => {
                let start = word_backward(text, *cursor, false);
                remove(text, cursor, start..*cursor);
            }
            KeyCode::Char('u') if ctrl => {
                let start = line_start(text, *cursor);
                remove(text, cursor, start..*cursor);
            }
            KeyCode::Delete => {
                let end = next_grapheme(text, *cursor);
                text.replace_range(*cursor..end, "");
            }
            KeyCode::Left if *cursor > line_start(text, *cursor) => {
                *cursor = prev_grapheme(text, *cursor);
            }
            KeyCode::Right if *cursor < line_end(text, *cursor) => {
                *cursor = next_grapheme(text, *cursor);
            }
            KeyCode::Up | KeyCode::Down => {
                let line = line_of(text, *cursor);
                let target = if key.code == KeyCode::Up {
                    line.checked_sub(1)
                } else {
                    Some(line + 1).filter(|line| *line < line_count(text))
                };
                if let Some(target) = target {
                    *cursor = at_column(text, target, column_of(text, *cursor));
                }
            }
            KeyCode::Home => *cursor = line_start(text, *cursor),
            KeyCode::End => *cursor = line_end(text, *cursor),
            KeyCode::Tab => insert(text, cursor, "    "),
            KeyCode::Char(ch) if !ctrl && !alt => {
                let mut buffer = [0; 4];
                insert(text, cursor, ch.encode_utf8(&mut buffer));
            }
            _ => {}
        }
        Outcome::Handled
    }

    fn replace_key(&mut self, text: &mut String, cursor: &mut usize, key: KeyEvent) -> Outcome {
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        let alt = key.modifiers.contains(KeyModifiers::ALT);
        match key.code {
            KeyCode::Esc => self.leave_insert(text, cursor),
            KeyCode::Char('[') if ctrl => self.leave_insert(text, cursor),
            KeyCode::Enter => {
                self.replaced.push(None);
                insert(text, cursor, "\n");
            }
            KeyCode::Backspace
                if *cursor > line_start(text, *cursor) || !self.replaced.is_empty() =>
            {
                let start = prev_grapheme(text, *cursor);
                match self.replaced.pop() {
                    Some(Some(original)) => {
                        text.replace_range(start..*cursor, &original);
                    }
                    Some(None) => text.replace_range(start..*cursor, ""),
                    None => {}
                }
                *cursor = start;
            }
            KeyCode::Char(ch) if !ctrl && !alt => {
                let mut buffer = [0; 4];
                let typed = ch.encode_utf8(&mut buffer);
                let end = line_end(text, *cursor);
                if *cursor < end {
                    let next = next_grapheme(text, *cursor);
                    self.replaced.push(Some(text[*cursor..next].to_owned()));
                    text.replace_range(*cursor..next, typed);
                } else {
                    self.replaced.push(None);
                    text.insert_str(*cursor, typed);
                }
                *cursor += typed.len();
            }
            _ => {}
        }
        Outcome::Handled
    }

    fn search_key(&mut self, text: &mut String, cursor: &mut usize, key: KeyEvent) {
        let Some(search) = &mut self.search_input else {
            return;
        };
        match key.code {
            KeyCode::Esc => self.reset_command(),
            KeyCode::Backspace => {
                let emptied = search.pattern.pop().is_none();
                if emptied {
                    self.reset_command();
                }
            }
            KeyCode::Enter => {
                let mut search = self.search_input.take().unwrap_or(Search {
                    pattern: String::new(),
                    forward: true,
                });
                // An empty search repeats the last pattern in the new direction.
                if search.pattern.is_empty() {
                    match &self.last_search {
                        Some(last) => search.pattern = last.pattern.clone(),
                        None => {
                            self.reset_command();
                            return;
                        }
                    }
                }
                self.last_search = Some(search);
                let operator = match self.pending {
                    Pending::Operator(operator) => Some(operator),
                    _ => None,
                };
                self.motion(
                    text,
                    cursor,
                    Motion::SearchNext { reverse: false },
                    operator,
                );
            }
            KeyCode::Char(ch)
                if !key
                    .modifiers
                    .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) =>
            {
                search.pattern.push(ch);
            }
            _ => {}
        }
    }

    /// Apply `operator` to `range`, which is whole lines when `linewise`.
    fn operate(
        &mut self,
        text: &mut String,
        cursor: &mut usize,
        operator: Operator,
        range: Range<usize>,
        linewise: bool,
    ) {
        self.pending = Pending::None;
        let range = range.start.min(text.len())..range.end.min(text.len());
        self.register = Register {
            text: text[range.clone()].to_owned(),
            linewise,
        };
        match operator {
            Operator::Yank => {
                if range.start < *cursor {
                    *cursor = range.start;
                }
                *cursor = clamp_normal(text, *cursor);
            }
            Operator::Delete => {
                text.replace_range(range.clone(), "");
                *cursor = clamp_normal(text, range.start);
            }
            Operator::Change => {
                text.replace_range(range.clone(), "");
                *cursor = range.start;
                self.enter_insert();
            }
        }
    }

    /// Apply `operator` to `lines` whole lines from the cursor's, as `dd`, `cc` and `yy` do.
    fn operate_lines(
        &mut self,
        text: &mut String,
        cursor: &mut usize,
        operator: Operator,
        lines: usize,
    ) {
        let first = line_of(text, *cursor);
        let last = (first + lines - 1).min(line_count(text) - 1);
        self.operate_line_range(text, cursor, operator, first, last);
    }

    fn operate_line_range(
        &mut self,
        text: &mut String,
        cursor: &mut usize,
        operator: Operator,
        first: usize,
        last: usize,
    ) {
        self.pending = Pending::None;
        let start = line_bounds(text, first).start;
        let end = line_bounds(text, last).end;
        self.register = Register {
            text: text[start..end].to_owned(),
            linewise: true,
        };
        match operator {
            Operator::Yank => {
                if start < *cursor && first < line_of(text, *cursor) {
                    *cursor = at_column(text, first, column_of(text, *cursor));
                }
                *cursor = clamp_normal(text, *cursor);
            }
            Operator::Delete => {
                // Take a line break along: the one after, or before the last line.
                let removed = if end < text.len() {
                    start..end + 1
                } else if start > 0 {
                    start - 1..end
                } else {
                    start..end
                };
                text.replace_range(removed, "");
                let line = first.min(line_count(text) - 1);
                *cursor = first_non_blank(text, line_bounds(text, line).start);
            }
            Operator::Change => {
                let indent = first_non_blank(text, start) - start;
                let indent = text[start..start + indent].to_owned();
                text.replace_range(start..end, &indent);
                *cursor = start + indent.len();
                self.enter_insert();
            }
        }
    }

    fn delete_chars(&mut self, text: &mut String, cursor: &mut usize, forward: bool) {
        let count = self.take_count();
        let start = line_start(text, *cursor);
        let end = line_end(text, *cursor);
        let mut other = *cursor;
        for _ in 0..count {
            if forward && other < end {
                other = next_grapheme(text, other);
            } else if !forward && other > start {
                other = prev_grapheme(text, other);
            }
        }
        if other != *cursor {
            let range = (*cursor).min(other)..(*cursor).max(other);
            self.operate(text, cursor, Operator::Delete, range, false);
        }
    }

    fn replace_chars(&mut self, text: &mut String, cursor: &mut usize, with: char) {
        let count = self.take_count();
        if self.mode.is_visual() {
            if let Some((range, _)) = self.selection(text, *cursor) {
                let replaced: String = text[range.clone()]
                    .graphemes(true)
                    .map(|grapheme| {
                        if grapheme == "\n" {
                            "\n".to_owned()
                        } else {
                            with.to_string()
                        }
                    })
                    .collect();
                text.replace_range(range.clone(), &replaced);
                self.mode = Mode::Normal;
                *cursor = clamp_normal(text, range.start);
            }
            return;
        }
        let end = line_end(text, *cursor);
        let mut stop = *cursor;
        for _ in 0..count {
            if stop >= end {
                return;
            }
            stop = next_grapheme(text, stop);
        }
        let replacement = with.to_string().repeat(count);
        text.replace_range(*cursor..stop, &replacement);
        *cursor = *cursor + replacement.len() - with.len_utf8();
    }

    fn join_lines(&mut self, text: &mut String, cursor: &mut usize, lines: usize) {
        for _ in 1..lines {
            let end = line_end(text, *cursor);
            if end >= text.len() {
                break;
            }
            let next = end + 1;
            let indent = first_non_blank(text, next) - next;
            let rest = &text[next + indent..line_end(text, next)];
            let current = &text[line_start(text, end)..end];
            let space = !current.is_empty()
                && !current.ends_with(char::is_whitespace)
                && !rest.is_empty()
                && !rest.starts_with(')');
            text.replace_range(end..next + indent, if space { " " } else { "" });
            *cursor = end;
        }
        *cursor = clamp_normal(text, *cursor);
    }

    fn paste(&mut self, text: &mut String, cursor: &mut usize, after: bool, count: usize) {
        if self.register.text.is_empty() && !self.register.linewise {
            return;
        }
        if self.register.linewise {
            let lines = vec![self.register.text.as_str(); count].join("\n");
            let at = if after {
                let end = line_end(text, *cursor);
                text.insert_str(end, &format!("\n{lines}"));
                end + 1
            } else {
                let start = line_start(text, *cursor);
                text.insert_str(start, &format!("{lines}\n"));
                start
            };
            *cursor = first_non_blank(text, at);
        } else {
            let put = self.register.text.repeat(count);
            let at = if after && *cursor < line_end(text, *cursor) {
                next_grapheme(text, *cursor)
            } else {
                *cursor
            };
            text.insert_str(at, &put);
            *cursor = prev_grapheme(text, at + put.len()).max(at);
        }
    }

    fn undo(&mut self, text: &mut String, cursor: &mut usize, count: usize) {
        for _ in 0..count {
            let Some(previous) = self.undo.pop() else {
                break;
            };
            self.redo.push(snapshot(text, *cursor));
            *text = previous.text;
            *cursor = clamp_normal(text, previous.cursor);
        }
        // Undo is not a change to undo or repeat.
        self.before = None;
        self.recording = None;
    }

    fn redo(&mut self, text: &mut String, cursor: &mut usize, count: usize) {
        for _ in 0..count {
            let Some(next) = self.redo.pop() else {
                break;
            };
            self.undo.push(snapshot(text, *cursor));
            *text = next.text;
            *cursor = clamp_normal(text, next.cursor);
        }
        self.before = None;
        self.recording = None;
    }

    /// `.`: replay the last change, with `count` in place of its own.
    fn repeat(&mut self, text: &mut String, cursor: &mut usize, count: Option<usize>) {
        self.before = None;
        self.recording = None;
        let Some(keys) = self.last_change.clone() else {
            return;
        };
        let digits = keys
            .iter()
            .take_while(|key| command_char(**key).is_some_and(|ch| ch.is_ascii_digit()))
            .count();
        let mut replay: Vec<KeyEvent> = match count {
            Some(count) => count
                .to_string()
                .chars()
                .map(|digit| KeyEvent::new(KeyCode::Char(digit), KeyModifiers::NONE))
                .collect(),
            None => keys[..digits].to_vec(),
        };
        replay.extend_from_slice(&keys[digits..]);
        self.replaying = true;
        for key in replay {
            self.handle_key(text, cursor, key);
        }
        // An insert the replay left open ends, as the recorded one did.
        if matches!(self.mode, Mode::Insert | Mode::Replace) {
            self.leave_insert(text, cursor);
        }
        self.replaying = false;
    }
}

fn snapshot(text: &str, cursor: usize) -> Snapshot {
    Snapshot {
        text: text.to_owned(),
        cursor,
    }
}

/// Ctrl+Enter, or Cmd+Enter where the terminal reports the Command key.
pub fn is_send(key: KeyEvent) -> bool {
    key.code == KeyCode::Enter
        && key
            .modifiers
            .intersects(KeyModifiers::CONTROL | KeyModifiers::SUPER)
}

/// The character a Normal-mode key types, if it's a plain or shifted character.
fn command_char(key: KeyEvent) -> Option<char> {
    match key.code {
        KeyCode::Char(ch) if key.modifiers.difference(KeyModifiers::SHIFT).is_empty() => Some(ch),
        _ => None,
    }
}

fn insert(text: &mut String, cursor: &mut usize, typed: &str) {
    text.insert_str(*cursor, typed);
    *cursor += typed.len();
}

fn remove(text: &mut String, cursor: &mut usize, range: Range<usize>) {
    *cursor = range.start;
    text.replace_range(range, "");
}

fn find_kind(find: Find) -> Kind {
    match find {
        Find::Forward | Find::TillForward => Kind::Inclusive,
        Find::Backward | Find::TillBackward => Kind::Exclusive,
    }
}

/// The text an operator takes from `from` to `to`, and whether it is whole lines.
fn motion_range(text: &str, from: usize, to: usize, kind: Kind) -> (Range<usize>, bool) {
    let (low, high) = (from.min(to), from.max(to));
    match kind {
        Kind::Linewise => (line_start(text, low)..line_end(text, high), true),
        Kind::Inclusive => (low..next_grapheme(text, high).max(low), false),
        Kind::Exclusive => {
            // An exclusive motion that ends at the start of a later line stops at the end of
            // the line before it (`:help exclusive`), so `dw` on a line's last word keeps
            // the line break.
            if high > low && high == line_start(text, high) && text[low..high].contains('\n') {
                (low..high - 1, false)
            } else {
                (low..high, false)
            }
        }
    }
}

fn next_grapheme(text: &str, position: usize) -> usize {
    text[position..]
        .graphemes(true)
        .next()
        .map_or(position, |grapheme| position + grapheme.len())
}

fn prev_grapheme(text: &str, position: usize) -> usize {
    text[..position]
        .grapheme_indices(true)
        .next_back()
        .map_or(0, |(index, _)| index)
}

fn char_at(text: &str, position: usize) -> Option<char> {
    text[position..].chars().next()
}

fn line_start(text: &str, position: usize) -> usize {
    text[..position].rfind('\n').map_or(0, |index| index + 1)
}

fn line_end(text: &str, position: usize) -> usize {
    text[position..]
        .find('\n')
        .map_or(text.len(), |index| position + index)
}

fn line_of(text: &str, position: usize) -> usize {
    text[..position].matches('\n').count()
}

fn line_count(text: &str) -> usize {
    text.matches('\n').count() + 1
}

/// The byte range of line `line`, without its line break.
fn line_bounds(text: &str, line: usize) -> Range<usize> {
    let start = if line == 0 {
        0
    } else {
        text.match_indices('\n')
            .nth(line - 1)
            .map_or(text.len(), |(index, _)| index + 1)
    };
    start..line_end(text, start)
}

fn first_non_blank(text: &str, start: usize) -> usize {
    let end = line_end(text, start);
    text[start..end]
        .find(|ch: char| !ch.is_whitespace())
        .map_or(start, |offset| start + offset)
}

fn column_of(text: &str, position: usize) -> usize {
    text[line_start(text, position)..position]
        .graphemes(true)
        .count()
}

/// The position at `column` on `line`, or its last character when it is shorter.
fn at_column(text: &str, line: usize, column: usize) -> usize {
    let bounds = line_bounds(text, line);
    text[bounds.clone()]
        .grapheme_indices(true)
        .nth(column)
        .map_or_else(
            || prev_grapheme(text, bounds.end).max(bounds.start),
            |(index, _)| bounds.start + index,
        )
}

/// Where the cursor may sit in Normal mode: on a character, not past the line's end.
fn clamp_normal(text: &str, position: usize) -> usize {
    let position = position.min(text.len());
    let start = line_start(text, position);
    let end = line_end(text, position);
    if position >= end && end > start {
        prev_grapheme(text, end)
    } else {
        position
    }
}

/// Vim's character classes: blanks, keyword characters, and other punctuation. Every
/// non-blank is one class for WORD motions.
fn class(ch: char, big: bool) -> u8 {
    if ch.is_whitespace() {
        0
    } else if big || ch.is_alphanumeric() || ch == '_' {
        2
    } else {
        1
    }
}

fn chars(text: &str) -> Vec<(usize, char)> {
    text.char_indices().collect()
}

fn index_of(chars: &[(usize, char)], position: usize) -> usize {
    chars.partition_point(|(index, _)| *index < position)
}

fn byte_of(text: &str, chars: &[(usize, char)], index: usize) -> usize {
    chars
        .get(index)
        .map_or(text.len(), |(position, _)| *position)
}

/// An empty line counts as a word to `w`, `b` and `e`, as in Vim.
fn is_empty_line(chars: &[(usize, char)], index: usize) -> bool {
    chars.get(index).is_some_and(|(_, ch)| *ch == '\n')
        && (index == 0 || chars[index - 1].1 == '\n')
}

fn word_forward(text: &str, position: usize, big: bool) -> usize {
    let chars = chars(text);
    let mut index = index_of(&chars, position);
    if index >= chars.len() {
        return text.len();
    }
    let start_class = class(chars[index].1, big);
    if start_class != 0 {
        while index < chars.len() && class(chars[index].1, big) == start_class {
            index += 1;
        }
    }
    while index < chars.len() && chars[index].1.is_whitespace() {
        if chars[index].1 == '\n' && index + 1 < chars.len() && chars[index + 1].1 == '\n' {
            return byte_of(text, &chars, index + 1);
        }
        index += 1;
    }
    byte_of(text, &chars, index)
}

fn word_backward(text: &str, position: usize, big: bool) -> usize {
    let chars = chars(text);
    let mut index = index_of(&chars, position);
    if index == 0 {
        return 0;
    }
    index -= 1;
    while index > 0 && chars[index].1.is_whitespace() && !is_empty_line(&chars, index) {
        index -= 1;
    }
    if is_empty_line(&chars, index) {
        return byte_of(text, &chars, index);
    }
    let word_class = class(chars[index].1, big);
    while index > 0 && class(chars[index - 1].1, big) == word_class {
        index -= 1;
    }
    byte_of(text, &chars, index)
}

fn word_end(text: &str, position: usize, big: bool) -> usize {
    let chars = chars(text);
    let mut index = index_of(&chars, position) + 1;
    while index < chars.len() && chars[index].1.is_whitespace() {
        index += 1;
    }
    if index >= chars.len() {
        return prev_grapheme(text, text.len());
    }
    let word_class = class(chars[index].1, big);
    while index + 1 < chars.len() && class(chars[index + 1].1, big) == word_class {
        index += 1;
    }
    byte_of(text, &chars, index)
}

fn word_end_backward(text: &str, position: usize, big: bool) -> usize {
    let chars = chars(text);
    let mut index = index_of(&chars, position);
    if index >= chars.len() || index == 0 {
        return position.min(text.len());
    }
    let start_class = class(chars[index].1, big);
    if start_class != 0 {
        while index > 0 && class(chars[index].1, big) == start_class {
            index -= 1;
        }
    }
    while index > 0 && chars[index].1.is_whitespace() {
        index -= 1;
    }
    byte_of(text, &chars, index)
}

fn find_in_line(text: &str, from: usize, find: Find, target: char, count: usize) -> Option<usize> {
    let start = line_start(text, from);
    let end = line_end(text, from);
    match find {
        Find::Forward | Find::TillForward => {
            let after = next_grapheme(text, from);
            let (offset, _) = text[after..end].match_indices(target).nth(count - 1)?;
            let found = after + offset;
            Some(if find == Find::TillForward {
                prev_grapheme(text, found)
            } else {
                found
            })
        }
        Find::Backward | Find::TillBackward => {
            let (found, _) = text[start..from].rmatch_indices(target).nth(count - 1)?;
            let found = start + found;
            Some(if find == Find::TillBackward {
                next_grapheme(text, found)
            } else {
                found
            })
        }
    }
}

const PAIRS: [(char, char); 4] = [('(', ')'), ('[', ']'), ('{', '}'), ('<', '>')];

/// `%`: the bracket matching the first one at or after the cursor on its line.
fn match_pair(text: &str, from: usize) -> Option<usize> {
    let end = line_end(text, from);
    let (offset, bracket) = text[from..end]
        .char_indices()
        .find(|(_, ch)| PAIRS.iter().any(|(open, close)| ch == open || ch == close))?;
    let at = from + offset;
    let (open, close) = PAIRS
        .iter()
        .find(|(open, close)| bracket == *open || bracket == *close)
        .copied()?;
    if bracket == open {
        find_close(text, at + open.len_utf8(), open, close)
    } else {
        find_open(text, at, open, close)
    }
}

/// The unmatched `close` at or after `from`.
fn find_close(text: &str, from: usize, open: char, close: char) -> Option<usize> {
    let mut depth = 0usize;
    for (offset, ch) in text[from..].char_indices() {
        if ch == open {
            depth += 1;
        } else if ch == close {
            if depth == 0 {
                return Some(from + offset);
            }
            depth -= 1;
        }
    }
    None
}

/// The unmatched `open` before `before`.
fn find_open(text: &str, before: usize, open: char, close: char) -> Option<usize> {
    let mut depth = 0usize;
    for (offset, ch) in text[..before].char_indices().rev() {
        if ch == close {
            depth += 1;
        } else if ch == open {
            if depth == 0 {
                return Some(offset);
            }
            depth -= 1;
        }
    }
    None
}

fn is_blank_line(text: &str, line: usize) -> bool {
    text[line_bounds(text, line)].trim().is_empty()
}

fn paragraph_forward(text: &str, from: usize) -> usize {
    let lines = line_count(text);
    let mut line = line_of(text, from);
    while line + 1 < lines && is_blank_line(text, line) {
        line += 1;
    }
    while line + 1 < lines {
        line += 1;
        if is_blank_line(text, line) {
            return line_bounds(text, line).start;
        }
    }
    text.len()
}

fn paragraph_backward(text: &str, from: usize) -> usize {
    let mut line = line_of(text, from);
    while line > 0 && is_blank_line(text, line) {
        line -= 1;
    }
    while line > 0 {
        line -= 1;
        if is_blank_line(text, line) {
            return line_bounds(text, line).start;
        }
    }
    0
}

/// The next match of `pattern` from `from`, wrapping around the draft. Lowercase patterns
/// match either case, as with Vim's `smartcase`.
fn search_from(text: &str, from: usize, pattern: &str, forward: bool) -> Option<usize> {
    if pattern.is_empty() {
        return None;
    }
    let fold = !pattern.chars().any(char::is_uppercase);
    let haystack = if fold {
        text.to_lowercase()
    } else {
        text.to_owned()
    };
    let needle = if fold {
        pattern.to_lowercase()
    } else {
        pattern.to_owned()
    };
    // Folding can change byte lengths; fall back to an exact search when it does.
    let (haystack, needle) = if haystack.len() == text.len() {
        (haystack, needle)
    } else {
        (text.to_owned(), pattern.to_owned())
    };
    let matches: Vec<usize> = haystack
        .match_indices(&needle)
        .map(|(index, _)| index)
        .collect();
    if forward {
        matches
            .iter()
            .find(|index| **index > from)
            .or_else(|| matches.first())
            .copied()
    } else {
        matches
            .iter()
            .rev()
            .find(|index| **index < from)
            .or_else(|| matches.last())
            .copied()
    }
}

fn toggle_case(text: &str) -> String {
    text.chars()
        .flat_map(|ch| {
            if ch.is_uppercase() {
                ch.to_lowercase().collect::<Vec<_>>()
            } else {
                ch.to_uppercase().collect::<Vec<_>>()
            }
        })
        .collect()
}

/// The range a text object covers around `position`: `w`, `W`, brackets (`(`, `b`, `[`,
/// `{`, `B`, `<`) and quotes.
fn text_object(text: &str, position: usize, object: char, inner: bool) -> Option<Range<usize>> {
    match object {
        'w' | 'W' => word_object(text, position, object == 'W', inner),
        '(' | ')' | 'b' => pair_object(text, position, '(', ')', inner),
        '[' | ']' => pair_object(text, position, '[', ']', inner),
        '{' | '}' | 'B' => pair_object(text, position, '{', '}', inner),
        '<' | '>' => pair_object(text, position, '<', '>', inner),
        '"' | '\'' | '`' => quote_object(text, position, object, inner),
        _ => None,
    }
}

fn word_object(text: &str, position: usize, big: bool, inner: bool) -> Option<Range<usize>> {
    let chars = chars(text);
    let index = index_of(&chars, position);
    let (_, at) = *chars.get(index)?;
    if at == '\n' {
        return None;
    }
    let run_class = class(at, big);
    let same = |ch: char| ch != '\n' && class(ch, big) == run_class;
    let mut start = index;
    while start > 0 && same(chars[start - 1].1) {
        start -= 1;
    }
    let mut end = index + 1;
    while end < chars.len() && same(chars[end].1) {
        end += 1;
    }
    if !inner {
        let blank = |ch: char| ch != '\n' && ch.is_whitespace();
        if run_class == 0 {
            // Blanks, and the word after them.
            if end < chars.len() && chars[end].1 != '\n' {
                let next_class = class(chars[end].1, big);
                while end < chars.len()
                    && chars[end].1 != '\n'
                    && class(chars[end].1, big) == next_class
                {
                    end += 1;
                }
            }
        } else if end < chars.len() && blank(chars[end].1) {
            while end < chars.len() && blank(chars[end].1) {
                end += 1;
            }
        } else {
            while start > 0 && blank(chars[start - 1].1) {
                start -= 1;
            }
        }
    }
    Some(byte_of(text, &chars, start)..byte_of(text, &chars, end))
}

fn pair_object(
    text: &str,
    position: usize,
    open: char,
    close: char,
    inner: bool,
) -> Option<Range<usize>> {
    let (start, end) = match char_at(text, position) {
        Some(ch) if ch == open => (
            position,
            find_close(text, position + open.len_utf8(), open, close)?,
        ),
        Some(ch) if ch == close => (find_open(text, position, open, close)?, position),
        _ => {
            let start = find_open(text, position, open, close)?;
            (
                start,
                find_close(text, start + open.len_utf8(), open, close)?,
            )
        }
    };
    Some(if inner {
        start + open.len_utf8()..end
    } else {
        start..end + close.len_utf8()
    })
}

fn quote_object(text: &str, position: usize, quote: char, inner: bool) -> Option<Range<usize>> {
    let start = line_start(text, position);
    let end = line_end(text, position);
    let line = &text[start..end];
    let mut quotes = Vec::new();
    let mut escaped = false;
    for (offset, ch) in line.char_indices() {
        if ch == quote && !escaped {
            quotes.push(start + offset);
        }
        escaped = ch == '\\' && !escaped;
    }
    let (open, close) = quotes
        .chunks_exact(2)
        .map(|pair| (pair[0], pair[1]))
        // The pair around the cursor, or else the next one on the line, as Vim picks.
        .find(|(_, close)| position <= *close)?;
    if inner {
        return Some(open + quote.len_utf8()..close);
    }
    let mut stop = close + quote.len_utf8();
    let trailing = text[stop..end].len() - text[stop..end].trim_start().len();
    if trailing > 0 {
        stop += trailing;
        return Some(open..stop);
    }
    let leading = text[start..open].len() - text[start..open].trim_end().len();
    Some(open - leading..stop)
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    /// Keys in Vim's notation: characters, and `<esc>`, `<cr>`, `<bs>`, `<del>`, `<c-r>`,
    /// `<c-cr>`, `<up>` and `<down>`.
    fn keys(notation: &str) -> Vec<KeyEvent> {
        let mut keys = Vec::new();
        let mut rest = notation;
        while let Some(ch) = rest.chars().next() {
            if ch == '<'
                && let Some(end) = rest.find('>')
                && end > 1
            {
                let name = &rest[1..end];
                let key = match name {
                    "esc" => KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE),
                    "cr" => KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE),
                    "c-cr" => KeyEvent::new(KeyCode::Enter, KeyModifiers::CONTROL),
                    "d-cr" => KeyEvent::new(KeyCode::Enter, KeyModifiers::SUPER),
                    "bs" => KeyEvent::new(KeyCode::Backspace, KeyModifiers::NONE),
                    "del" => KeyEvent::new(KeyCode::Delete, KeyModifiers::NONE),
                    "c-r" => KeyEvent::new(KeyCode::Char('r'), KeyModifiers::CONTROL),
                    "c-w" => KeyEvent::new(KeyCode::Char('w'), KeyModifiers::CONTROL),
                    "up" => KeyEvent::new(KeyCode::Up, KeyModifiers::NONE),
                    "down" => KeyEvent::new(KeyCode::Down, KeyModifiers::NONE),
                    "lt" => KeyEvent::new(KeyCode::Char('<'), KeyModifiers::NONE),
                    other => panic!("unknown key <{other}>"),
                };
                keys.push(key);
                rest = &rest[end + 1..];
                continue;
            }
            let modifiers = if ch.is_uppercase() {
                KeyModifiers::SHIFT
            } else {
                KeyModifiers::NONE
            };
            keys.push(KeyEvent::new(KeyCode::Char(ch), modifiers));
            rest = &rest[ch.len_utf8()..];
        }
        keys
    }

    /// Run `notation` in Normal mode over `before`, where `|` marks the cursor, and return
    /// the draft with the cursor marked the same way.
    fn run(before: &str, notation: &str) -> String {
        let (text, _, vim) = run_with(before, notation, Mode::Normal);
        let _ = vim;
        text
    }

    fn run_with(before: &str, notation: &str, mode: Mode) -> (String, Vec<Outcome>, Vim) {
        let mut cursor = before.find('|').expect("a cursor marker");
        let mut text = before.replacen('|', "", 1);
        let mut vim = Vim::new(mode);
        let outcomes = keys(notation)
            .into_iter()
            .map(|key| vim.handle_key(&mut text, &mut cursor, key))
            .collect();
        text.insert(cursor, '|');
        (text, outcomes, vim)
    }

    #[test]
    fn motions_move_the_cursor() {
        let cases = [
            ("|one two three", "w", "one |two three"),
            ("|one two three", "2w", "one two |three"),
            ("one two |three", "b", "one |two three"),
            ("|one two", "e", "on|e two"),
            ("|foo.bar baz", "w", "foo|.bar baz"),
            ("|foo.bar baz", "W", "foo.bar |baz"),
            ("one two |three", "ge", "one tw|o three"),
            ("  in|dented", "0", "|  indented"),
            ("  in|dented", "^", "  |indented"),
            ("|abc", "$", "ab|c"),
            ("|abc", "l", "a|bc"),
            ("ab|c", "l", "ab|c"),
            ("a|bc", "h", "|abc"),
            ("|a,b,c", "f,", "a|,b,c"),
            ("|a,b,c", "2f,", "a,b|,c"),
            ("|a,b,c", "t,", "|a,b,c"),
            ("|a,b,c", "f,;", "a,b|,c"),
            ("a,b,|c", "F,", "a,b|,c"),
            ("a,b,|c", "T,", "a,b,|c"),
            ("|(a (b) c)", "%", "(a (b) c|)"),
            ("(a (b) c|)", "%", "|(a (b) c)"),
            ("|one\ntwo\nthree", "G", "one\ntwo\n|three"),
            ("one\ntwo\n|three", "gg", "|one\ntwo\nthree"),
            ("|one\ntwo\nthree", "2G", "one\n|two\nthree"),
            ("|one\ntwo", "j", "one\n|two"),
            ("long |line\nab", "j", "long line\na|b"),
            ("|a\nb\n\nc\nd", "}", "a\nb\n|\nc\nd"),
            ("a\nb\n\nc\n|d", "{", "a\nb\n|\nc\nd"),
            ("|one\n  two", "<cr>", "one\n  |two"),
        ];
        for (before, notation, after) in cases {
            assert_eq!(run(before, notation), after, "{before:?} {notation}");
        }
    }

    #[test]
    fn operators_take_motions_and_text_objects() {
        let cases = [
            ("|one two three", "dw", "|two three"),
            ("|one two three", "d2w", "|three"),
            ("|one two three", "2dw", "|three"),
            ("one |two\nthree", "dw", "one| \nthree"),
            ("|one two", "de", "| two"),
            ("one |two three", "db", "|two three"),
            ("a|bc def", "d$", "|a"),
            ("a|bc def", "D", "|a"),
            ("a|bc\ndef", "d$", "|a\ndef"),
            ("|a,b,c", "dt,", "|,b,c"),
            ("|a,b,c", "df,", "|b,c"),
            ("one t|wo three", "diw", "one | three"),
            ("one t|wo three", "daw", "one |three"),
            ("call(a, |b)", "di(", "call(|)"),
            ("call(a, |b)", "da(", "cal|l"),
            ("say \"hi |there\" now", "di\"", "say \"|\" now"),
            ("say \"hi |there\" now", "da\"", "say |now"),
            ("{ |x }", "ci{y<esc>", "{|y}"),
            ("one\n|two\nthree", "dd", "one\n|three"),
            ("one\ntwo\n|three", "dd", "one\n|two"),
            ("|one\ntwo\nthree", "2dd", "|three"),
            ("|one\ntwo\nthree", "dj", "|three"),
            ("one\n  |two", "cc", "one\n  |"),
            ("|one two", "cwzap<esc>", "za|p two"),
            ("|one two", "c$x<esc>", "|x"),
            ("|one\ntwo", "yyp", "one\n|one\ntwo"),
            ("|one two", "ywP", "one| one two"),
            ("|one two", "yeP", "on|eone two"),
            ("|abc", "xp", "b|ac"),
            ("a|bc", "X", "|bc"),
            ("|abc", "3x", "|"),
            ("|abc", "rz", "|zbc"),
            ("|abc", "2rz", "z|zc"),
            ("|abc", "~~", "AB|c"),
            ("|one\n  two\nthree", "J", "one| two\nthree"),
            ("|a\nb\nc", "3J", "a b| c"),
            ("|one", "sx<esc>", "|xne"),
            ("|one", "Sx<esc>", "|x"),
            ("|one", "Cx<esc>", "|x"),
        ];
        for (before, notation, after) in cases {
            assert_eq!(run(before, notation), after, "{before:?} {notation}");
        }
    }

    #[test]
    fn inserting_and_replacing() {
        let cases = [
            ("|bc", "ia<esc>", "|abc"),
            ("|ac", "ab<esc>", "a|bc"),
            ("  |b", "Ia<esc>", "  |ab"),
            ("|a", "Ab<esc>", "a|b"),
            ("|a", "ob<esc>", "a\n|b"),
            ("|b", "Oa<esc>", "|a\nb"),
            ("|a", "ib<cr>c<esc>", "b\n|ca"),
            ("|abcd", "Rxy<esc>", "x|ycd"),
            ("|ab", "Rxyz<esc>", "xy|z"),
            ("|abcd", "Rxy<bs><esc>", "|xbcd"),
            ("|ab", "Rxyz<bs><bs><esc>", "|xb"),
            ("one tw|o", "a<c-w><esc>", "one| "),
        ];
        for (before, notation, after) in cases {
            assert_eq!(run(before, notation), after, "{before:?} {notation}");
        }
    }

    #[test]
    fn undo_redo_and_repeat() {
        let cases = [
            ("|one two three", "dwu", "|one two three"),
            ("|one two three", "dwdwuu", "|one two three"),
            ("|one two three", "dwu<c-r>", "|two three"),
            ("|a b c d", "dw..", "|d"),
            ("|a b c d", "dw2.", "|d"),
            ("|x\nx\nx", "Ay<esc>j.j.", "xy\nxy\nx|y"),
            ("|one", "ciwtwo<esc>u", "|one"),
            ("|a\nb", "ddp", "b\n|a"),
            ("|a", "iab<esc>u", "|a"),
        ];
        for (before, notation, after) in cases {
            assert_eq!(run(before, notation), after, "{before:?} {notation}");
        }
    }

    #[test]
    fn visual_mode_selects_and_operates() {
        let cases = [
            ("|one two", "vld", "|e two"),
            ("|one two", "ved", "| two"),
            ("one |two", "vbd", "|wo"),
            ("|one\ntwo\nthree", "Vjd", "|three"),
            ("|one two", "veyP", "on|eone two"),
            ("|one two", "viwU", "|ONE two"),
            ("|one two", "vec<esc>", "| two"),
            ("|one\ntwo", "VJ", "one| two"),
            ("|abc", "vlrx", "|xxc"),
            ("|one two", "yiwwviwp", "one on|e"),
            ("|one two", "yiwwviwpu0vep", "tw|o two"),
            ("|one two", "yiwwviwPu0veP", "on|e two"),
            ("|a\nb\nc", "yyjVp", "a\n|a\nc"),
            ("|a\nb\nc", "yyGVp", "a\nb\n|a"),
            ("|a", "yyVp", "|a"),
            ("|one two", "vl<esc>", "o|ne two"),
            ("|one two", "vlohd", "|e two"),
        ];
        for (before, notation, after) in cases {
            assert_eq!(run(before, notation), after, "{before:?} {notation}");
        }
    }

    #[test]
    fn visual_selection_spans_characters_or_lines() {
        let (_, _, vim) = run_with("|one\ntwo", "vl", Mode::Normal);
        assert_eq!(vim.mode(), Mode::Visual);
        assert_eq!(vim.selection("one\ntwo", 1), Some((0..2, false)));
        let (_, _, vim) = run_with("o|ne\ntwo", "Vj", Mode::Normal);
        assert_eq!(vim.mode(), Mode::VisualLine);
        assert_eq!(vim.selection("one\ntwo", 5), Some((0..7, true)));
    }

    #[test]
    fn searching_the_draft() {
        let cases = [
            ("|one two one two", "/two<cr>", "one |two one two"),
            ("|one two one two", "/two<cr>n", "one two one |two"),
            ("|one two one two", "/two<cr>nn", "one |two one two"),
            ("one two one |two", "?one<cr>", "one two |one two"),
            ("|one two one two", "/two<cr>N", "one two one |two"),
            ("|Ab ab", "/ab<cr>", "Ab |ab"),
            ("|xx Ab ab", "/Ab<cr>", "xx |Ab ab"),
            ("|one two three", "d/thr<cr>", "|three"),
            ("|one two", "/zzz<cr>", "|one two"),
            ("|one two", "/tw<esc>x", "|ne two"),
        ];
        for (before, notation, after) in cases {
            assert_eq!(run(before, notation), after, "{before:?} {notation}");
        }
    }

    #[test]
    fn send_keys_and_history_reach_the_composer() {
        let (_, outcomes, _) = run_with("|a", "<c-cr>", Mode::Insert);
        assert_eq!(outcomes, [Outcome::Submit]);
        let (_, outcomes, _) = run_with("|a", "<d-cr>", Mode::Normal);
        assert_eq!(outcomes, [Outcome::Submit]);
        let (_, outcomes, _) = run_with("|a\nb", "kjj", Mode::Normal);
        assert_eq!(
            outcomes,
            [
                Outcome::HistoryPrevious,
                Outcome::Handled,
                Outcome::HistoryNext
            ]
        );
        // In Insert mode, Enter is a new line and Esc goes to Normal.
        let (text, _, vim) = run_with("|", "a<cr>b<esc>", Mode::Insert);
        assert_eq!(text, "a\n|b");
        assert_eq!(vim.mode(), Mode::Normal);
    }

    #[test]
    fn counts_and_pending_keys_show_until_the_command_ends() {
        let (_, _, vim) = run_with("|abc", "2d", Mode::Normal);
        assert_eq!(vim.pending_keys(), "2d");
        let (_, _, vim) = run_with("|abc", "2d<esc>", Mode::Normal);
        assert_eq!(vim.pending_keys(), "");
        let (_, _, vim) = run_with("|abc", "/ab", Mode::Normal);
        assert_eq!(vim.search_prompt().as_deref(), Some("/ab"));
    }

    #[test]
    fn slash_on_an_empty_draft_starts_a_command() {
        let (text, _, vim) = run_with("|", "/", Mode::Normal);
        assert_eq!(text, "/|");
        assert_eq!(vim.mode(), Mode::Insert);
    }
}
