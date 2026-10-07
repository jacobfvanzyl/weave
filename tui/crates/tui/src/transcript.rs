//! The transcript weave owns in fullscreen mode, after Codex's `transcript_view`.
//!
//! Inline mode renders each cell once into the terminal's scrollback. Fullscreen keeps the
//! cells instead and draws the visible slice every frame, so the composer stays put while the
//! transcript scrolls, a resize reflows the whole conversation, and text can be selected and
//! copied even though the terminal's own scrollback is not involved.

use std::cell::Cell;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

use crossterm::event::MouseButton;
use crossterm::event::MouseEvent;
use crossterm::event::MouseEventKind;
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Modifier;
use ratatui::style::Style;
use ratatui::text::Line;
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;
use weave_acp_core::schema::Plan;

use crate::history_cell;
use crate::streaming::StreamKind;
use crate::streaming::render_compact;
use crate::streaming::render_message;
use crate::tool_call::ExploreGroup;
use crate::tool_call::RenderContext;
use crate::tool_call::ToolCallCell;
use crate::tool_output::TerminalTranscripts;
use crate::wrapping::DisplayLine;
use crate::wrapping::LineSource;

/// Rows one wheel notch scrolls.
const WHEEL_ROWS: isize = 3;

type Render = dyn Fn(usize, bool) -> Vec<DisplayLine> + Send + Sync;

/// A cell's rows at one width.
type CachedLayout = (usize, Arc<Vec<DisplayLine>>);

/// One committed transcript entry, renderable at any width, compactly or in full detail.
pub struct TranscriptCell {
    render: Box<Render>,
    /// The latest layout for each of the compact and detailed views, with its width.
    cache: Mutex<[Option<CachedLayout>; 2]>,
}

impl TranscriptCell {
    /// A cell that looks the same in the compact and detailed views.
    pub fn new(render: impl Fn(usize) -> Vec<DisplayLine> + Send + Sync + 'static) -> Self {
        Self::with_detail(move |width, _| render(width))
    }

    /// A cell with a compact form and a detailed one (`true`), as Ctrl+T shows.
    pub fn with_detail(
        render: impl Fn(usize, bool) -> Vec<DisplayLine> + Send + Sync + 'static,
    ) -> Self {
        Self {
            render: Box::new(render),
            cache: Mutex::new([None, None]),
        }
    }

    /// The cell's lines at `width`, rendered once per width and view.
    pub fn lines(&self, width: usize, detail: bool) -> Arc<Vec<DisplayLine>> {
        let mut cache = self
            .cache
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let slot = &mut cache[usize::from(detail)];
        if let Some((cached_width, lines)) = slot.as_ref()
            && *cached_width == width
        {
            return Arc::clone(lines);
        }
        let lines = Arc::new((self.render)(width, detail));
        *slot = Some((width, Arc::clone(&lines)));
        lines
    }

    pub fn info(text: &str) -> Self {
        let text = text.to_owned();
        Self::new(move |width| history_cell::info(&text, width))
    }

    pub fn error(text: &str) -> Self {
        let text = text.to_owned();
        Self::new(move |width| history_cell::error(&text, width))
    }

    pub fn user(text: &str) -> Self {
        let text = text.to_owned();
        Self::new(move |width| history_cell::user_message(&text, width))
    }

    pub fn plan(plan: Plan) -> Self {
        Self::new(move |width| history_cell::plan(&plan, width))
    }

    /// An agent message or thought; thoughts are cut to a preview in the compact view.
    pub fn message(kind: StreamKind, source: String) -> Self {
        Self::with_detail(move |width, detail| {
            if detail {
                render_message(kind, &source, width)
            } else {
                render_compact(kind, &source, width)
            }
        })
    }

    /// A finished tool call, with the output of the terminals it embeds as it stood.
    pub fn tool_call(cell: ToolCallCell, cwd: PathBuf, terminals: TerminalTranscripts) -> Self {
        Self::with_detail(move |width, detail| {
            let cx = RenderContext {
                cwd: &cwd,
                terminals: &terminals,
                detail,
                now: None,
            };
            cell.lines(width, &cx)
        })
    }

    /// Reads and searches that ran together, as one `Explored` entry.
    pub fn explored(group: ExploreGroup, cwd: PathBuf, terminals: TerminalTranscripts) -> Self {
        Self::with_detail(move |width, detail| {
            let cx = RenderContext {
                cwd: &cwd,
                terminals: &terminals,
                detail,
                now: None,
            };
            group.lines(width, &cx, false)
        })
    }

    /// `Worked for …` after a turn.
    pub fn turn_summary(elapsed: std::time::Duration, finished_at: String) -> Self {
        Self::new(move |width| history_cell::turn_summary(elapsed, &finished_at, width))
    }

    pub fn header(
        agent: String,
        agent_version: Option<String>,
        directory: String,
        settings: Option<String>,
    ) -> Self {
        Self::new(move |width| {
            let header = history_cell::SessionHeader {
                agent: &agent,
                agent_version: agent_version.as_deref(),
                directory: &directory,
                settings: settings.as_deref(),
            };
            history_cell::session_header(&header, width)
        })
    }
}

/// What the reader is looking at.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ViewPosition {
    /// The newest output, following it as it arrives.
    Latest,
    /// A fixed spot: the top row as a cell and a row within its block (separator included),
    /// so the view stays on the same content as output arrives below it.
    Reading { cell: usize, offset: usize },
}

/// Whether the reader has scrolled away from the newest output.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reading {
    Latest,
    Earlier,
    /// Scrolled away, and output arrived since.
    EarlierWithNewOutput,
}

/// A row and column in the transcript, as laid out at the selection's width.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct Point {
    row: usize,
    column: u16,
}

#[derive(Clone, Copy, Debug)]
struct Selection {
    anchor: Point,
    head: Point,
    width: usize,
}

impl Selection {
    fn ordered(&self) -> (Point, Point) {
        (self.anchor.min(self.head), self.anchor.max(self.head))
    }

    /// The selected columns of `row`, end exclusive.
    fn columns(&self, row: usize, width: u16) -> Option<(u16, u16)> {
        let (start, end) = self.ordered();
        if row < start.row || row > end.row {
            return None;
        }
        let from = if row == start.row { start.column } else { 0 };
        let to = if row == end.row {
            end.column.saturating_add(1)
        } else {
            width
        };
        (from < to).then_some((from, to.min(width)))
    }
}

/// Text being copied from a selection, a line at a time.
#[derive(Default)]
struct Copied {
    lines: Vec<String>,
    /// The logical line the last row left off in, and where, when the selection ran to that
    /// row's end so the next row of the same line continues it.
    open: Option<(Arc<str>, usize)>,
}

impl Copied {
    /// Copy the columns `from..to` of a row showing `source`.
    fn push_source(&mut self, source: &LineSource, from: usize, to: usize) {
        let shown = &source.text[source.range.clone()];
        let mut column = source.prefix_width;
        let mut selected: Option<(usize, usize)> = None;
        for (index, grapheme) in shown.grapheme_indices(true) {
            if column >= from && column < to {
                let byte = source.range.start + index;
                let (start, _) = selected.get_or_insert((byte, byte));
                selected = Some((*start, byte + grapheme.len()));
            }
            column += grapheme.width();
        }
        let reaches_end = to >= column;
        let from_start = from <= source.prefix_width;
        let (start, end) = selected.unwrap_or((source.range.end, source.range.end));
        match &self.open {
            Some((text, open_end))
                if Arc::ptr_eq(text, &source.text)
                    && from_start
                    && *open_end <= start
                    && !self.lines.is_empty() =>
            {
                let continued = &source.text[*open_end..end];
                if let Some(line) = self.lines.last_mut() {
                    line.push_str(continued);
                }
            }
            _ => self.lines.push(source.text[start..end].to_owned()),
        }
        self.open = reaches_end.then(|| (Arc::clone(&source.text), end));
    }

    /// Copy the columns `from..to` of a row as it appears on screen.
    fn push_shown(&mut self, line: &Line<'static>, width: u16, from: u16, to: u16) {
        let mut buf = Buffer::empty(Rect::new(0, 0, width, 1));
        buf.set_line(0, 0, line, width);
        let mut text = String::new();
        let mut x = from;
        while x < to {
            let symbol = buf[(x, 0)].symbol();
            text.push_str(symbol);
            x += u16::try_from(symbol.width().max(1)).unwrap_or(1);
        }
        self.lines.push(text);
        self.open = None;
    }

    fn finish(self) -> String {
        self.lines
            .iter()
            .map(|line| line.trim_end())
            .collect::<Vec<_>>()
            .join("\n")
    }
}

/// Where the transcript was last drawn, for mapping the mouse and paging.
#[derive(Clone, Copy, Debug)]
struct Geometry {
    area: Rect,
    width: usize,
    live: usize,
    top: usize,
}

/// Row positions of the transcript at one width.
struct Layout {
    /// Where each cell's block starts; blocks after the first open with a blank separator.
    starts: Vec<usize>,
    /// Where live content (running tool calls, the streaming message) starts.
    live_start: usize,
    total: usize,
}

impl Layout {
    fn anchor(&self, row: usize) -> ViewPosition {
        if row >= self.live_start {
            return ViewPosition::Reading {
                cell: self.starts.len(),
                offset: row - self.live_start,
            };
        }
        let cell = self
            .starts
            .partition_point(|start| *start <= row)
            .saturating_sub(1);
        ViewPosition::Reading {
            cell,
            offset: row - self.starts.get(cell).copied().unwrap_or_default(),
        }
    }

    fn row(&self, cell: usize, offset: usize) -> usize {
        let start = self.starts.get(cell).copied().unwrap_or(self.live_start);
        let end = self
            .starts
            .get(cell + 1)
            .copied()
            .unwrap_or(self.live_start);
        let block = if cell < self.starts.len() {
            end - start
        } else {
            self.total - self.live_start
        };
        start + offset.min(block.saturating_sub(1))
    }
}

pub struct TranscriptView {
    cells: Vec<TranscriptCell>,
    /// Showing every cell in full (Ctrl+T) rather than compactly.
    detailed: bool,
    /// Where the other view was, to return to when switching back.
    other_position: Option<ViewPosition>,
    /// Cells kept when the transcript is cleared for another session: the startup header.
    pinned: usize,
    position: ViewPosition,
    unseen: bool,
    selection: Option<Selection>,
    /// Where a drag began, until the mouse button is released.
    drag_from: Option<Point>,
    geometry: Cell<Option<Geometry>>,
}

impl TranscriptView {
    pub fn new() -> Self {
        Self {
            cells: Vec::new(),
            detailed: false,
            other_position: None,
            pinned: 0,
            position: ViewPosition::Latest,
            unseen: false,
            selection: None,
            drag_from: None,
            geometry: Cell::new(None),
        }
    }

    pub fn push(&mut self, cell: TranscriptCell) {
        self.cells.push(cell);
        self.note_activity();
    }

    /// A view showing every cell in full, as the inline pager does.
    pub fn detailed() -> Self {
        let mut view = Self::new();
        view.detailed = true;
        view
    }

    pub fn is_detailed(&self) -> bool {
        self.detailed
    }

    /// Switch between the compact and detailed views, each keeping its own place, as Codex's
    /// transcript presentation does.
    pub fn set_detailed(&mut self, detailed: bool) {
        if self.detailed == detailed {
            return;
        }
        self.detailed = detailed;
        self.selection = None;
        self.drag_from = None;
        let previous = self.position;
        self.position = self.other_position.take().unwrap_or(ViewPosition::Latest);
        self.other_position = Some(previous);
        if self.position == ViewPosition::Latest {
            self.unseen = false;
        }
    }

    /// Keep the cells so far, such as the header, when the transcript is cleared.
    pub fn pin(&mut self) {
        self.pinned = self.cells.len();
    }

    /// Clear everything after the pinned cells, returning what was removed.
    pub fn take_session(&mut self) -> Vec<TranscriptCell> {
        self.follow();
        self.selection = None;
        self.cells.split_off(self.pinned.min(self.cells.len()))
    }

    /// Put back cells removed by [`Self::take_session`], replacing any added since.
    pub fn restore_session(&mut self, cells: Vec<TranscriptCell>) {
        self.cells.truncate(self.pinned);
        self.cells.extend(cells);
        self.follow();
    }

    /// Output arrived; a reader scrolled away gets told about it.
    pub fn note_activity(&mut self) {
        if self.position != ViewPosition::Latest {
            self.unseen = true;
        }
    }

    pub fn reading(&self) -> Reading {
        match (self.position, self.unseen) {
            (ViewPosition::Latest, _) => Reading::Latest,
            (ViewPosition::Reading { .. }, false) => Reading::Earlier,
            (ViewPosition::Reading { .. }, true) => Reading::EarlierWithNewOutput,
        }
    }

    pub fn follow(&mut self) {
        self.position = ViewPosition::Latest;
        self.unseen = false;
    }

    /// Scroll by whole pages, keeping one row of the previous page in view.
    pub fn scroll_pages(&mut self, pages: isize) {
        let Some(geometry) = self.geometry.get() else {
            return;
        };
        let page = usize::from(geometry.area.height).saturating_sub(1).max(1);
        self.scroll_rows(pages.saturating_mul(isize::try_from(page).unwrap_or(isize::MAX)));
    }

    pub fn scroll_rows(&mut self, rows: isize) {
        let Some(geometry) = self.geometry.get() else {
            return;
        };
        let layout = self.layout(geometry.width, geometry.live);
        let height = usize::from(geometry.area.height);
        let bottom = layout.total.saturating_sub(height);
        let top = self.top(&layout, height).saturating_add_signed(rows);
        if top >= bottom {
            self.follow();
        } else {
            self.position = layout.anchor(top);
        }
    }

    pub fn scroll_to_start(&mut self) {
        let Some(geometry) = self.geometry.get() else {
            return;
        };
        let layout = self.layout(geometry.width, geometry.live);
        if layout.total > usize::from(geometry.area.height) {
            self.position = layout.anchor(0);
        }
    }

    /// The selection is laid out at one width; a resize ends it.
    pub fn resized(&mut self) {
        self.selection = None;
        self.drag_from = None;
    }

    /// Wheel scrolling and drag selection over the transcript. Returns the selected text when
    /// a drag ends, for copying. `live` is the live content drawn below the cells.
    pub fn handle_mouse(&mut self, event: MouseEvent, live: &[DisplayLine]) -> Option<String> {
        let geometry = self.geometry.get()?;
        let area = geometry.area;
        let inside = area.contains((event.column, event.row).into());
        match event.kind {
            // The wheel scrolls the transcript wherever the pointer is.
            MouseEventKind::ScrollUp => self.scroll_rows(-WHEEL_ROWS),
            MouseEventKind::ScrollDown => self.scroll_rows(WHEEL_ROWS),
            MouseEventKind::Down(MouseButton::Left) => {
                self.selection = None;
                self.drag_from = inside.then(|| self.point(geometry, event));
            }
            MouseEventKind::Drag(MouseButton::Left) => {
                let anchor = self.drag_from?;
                // Dragging past an edge scrolls that way.
                if event.row < area.y {
                    self.scroll_rows(-1);
                } else if event.row >= area.bottom() {
                    self.scroll_rows(1);
                }
                let geometry = self.current_geometry(geometry, live.len());
                self.selection = Some(Selection {
                    anchor,
                    head: self.point(geometry, event),
                    width: geometry.width,
                });
            }
            MouseEventKind::Up(MouseButton::Left) => {
                self.drag_from.take()?;
                let selection = self.selection?;
                return Some(self.selected_text(selection, live));
            }
            _ => {}
        }
        None
    }

    /// `geometry` with its top updated for scrolling done since it was drawn.
    fn current_geometry(&self, geometry: Geometry, live: usize) -> Geometry {
        let layout = self.layout(geometry.width, live);
        Geometry {
            top: self.top(&layout, usize::from(geometry.area.height)),
            live,
            ..geometry
        }
    }

    fn point(&self, geometry: Geometry, event: MouseEvent) -> Point {
        let area = geometry.area;
        let y = event
            .row
            .clamp(area.y, area.bottom().saturating_sub(1).max(area.y));
        Point {
            row: geometry.top + usize::from(y - area.y),
            column: event.column.min(area.right().saturating_sub(1)) - area.x,
        }
    }

    /// The selection as text: wrapped rows of one logical line rejoin (with the whitespace
    /// wrapping dropped), and gutters stay out. Rows without a source copy as shown.
    fn selected_text(&self, selection: Selection, live: &[DisplayLine]) -> String {
        let (start, end) = selection.ordered();
        let layout = self.layout(selection.width, live.len());
        let width = u16::try_from(selection.width).unwrap_or(u16::MAX);
        let rows = self.rows(
            &layout,
            selection.width,
            live,
            start.row,
            end.row - start.row + 1,
        );
        let mut copied = Copied::default();
        for (row, display) in (start.row..).zip(&rows) {
            let Some((from, to)) = selection.columns(row, width) else {
                continue;
            };
            match &display.source {
                Some(source) => copied.push_source(source, usize::from(from), usize::from(to)),
                None => copied.push_shown(&display.line, width, from, to),
            }
        }
        copied.finish()
    }

    fn layout(&self, width: usize, live: usize) -> Layout {
        let mut starts = Vec::with_capacity(self.cells.len());
        let mut row = 0;
        for (index, cell) in self.cells.iter().enumerate() {
            starts.push(row);
            row += usize::from(index > 0) + cell.lines(width, self.detailed).len();
        }
        Layout {
            starts,
            live_start: row,
            total: row + live,
        }
    }

    fn top(&self, layout: &Layout, height: usize) -> usize {
        let bottom = layout.total.saturating_sub(height);
        match self.position {
            ViewPosition::Latest => bottom,
            ViewPosition::Reading { cell, offset } => layout.row(cell, offset).min(bottom),
        }
    }

    /// `count` transcript rows starting at `from`.
    fn rows(
        &self,
        layout: &Layout,
        width: usize,
        live: &[DisplayLine],
        from: usize,
        count: usize,
    ) -> Vec<DisplayLine> {
        let end = from.saturating_add(count).min(layout.total);
        let mut rows = Vec::with_capacity(end.saturating_sub(from));
        let mut row = from;
        let mut index = layout
            .starts
            .partition_point(|start| *start <= from)
            .saturating_sub(1);
        while row < end && row < layout.live_start {
            let Some(cell) = self.cells.get(index) else {
                break;
            };
            let start = layout.starts[index];
            let separator = usize::from(index > 0);
            let lines = cell.lines(width, self.detailed);
            while row < end && row < start + separator + lines.len() {
                let offset = row - start;
                rows.push(if offset < separator {
                    DisplayLine::default()
                } else {
                    lines[offset - separator].clone()
                });
                row += 1;
            }
            index += 1;
        }
        while row < end {
            rows.push(
                live.get(row - layout.live_start)
                    .cloned()
                    .unwrap_or_default(),
            );
            row += 1;
        }
        rows
    }

    /// Draw the visible rows into `area`: the newest at the bottom while following, from the
    /// top while the transcript is shorter than the area.
    pub fn render(&self, area: Rect, buf: &mut Buffer, width: usize, live: &[DisplayLine]) {
        let layout = self.layout(width, live.len());
        let height = usize::from(area.height);
        let top = self.top(&layout, height);
        self.geometry.set(Some(Geometry {
            area,
            width,
            live: live.len(),
            top,
        }));
        let rows = self.rows(&layout, width, live, top, height);
        for (y, row) in (area.y..).zip(&rows) {
            // A row with a background, such as a sent prompt's, fills the whole width.
            if let Some(bg) = row.line.style.bg {
                buf.set_style(Rect::new(area.x, y, area.width, 1), Style::default().bg(bg));
            }
            buf.set_line(area.x, y, &row.line, area.width);
        }
        let Some(selection) = self.selection.filter(|selection| selection.width == width) else {
            return;
        };
        let highlight = Style::default().add_modifier(Modifier::REVERSED);
        for (y, row) in (area.y..area.bottom()).zip(top..) {
            if let Some((from, to)) = selection.columns(row, area.width) {
                for x in from..to {
                    buf[(area.x + x, y)].set_style(highlight);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering;

    use crossterm::event::KeyModifiers;
    use pretty_assertions::assert_eq;

    use super::*;

    fn numbered(count: usize) -> TranscriptView {
        let mut view = TranscriptView::new();
        for n in 1..=count {
            view.push(TranscriptCell::new(move |_| {
                vec![DisplayLine::whole(Line::from(format!("line {n}")))]
            }));
        }
        view
    }

    fn draw(view: &TranscriptView, height: u16) -> Vec<String> {
        let area = Rect::new(0, 0, 20, height);
        let mut buf = Buffer::empty(area);
        view.render(area, &mut buf, 20, &[]);
        (0..height)
            .map(|y| {
                (0..20)
                    .map(|x| buf[(x, y)].symbol())
                    .collect::<String>()
                    .trim_end()
                    .to_owned()
            })
            .collect()
    }

    fn mouse(kind: MouseEventKind, column: u16, row: u16) -> MouseEvent {
        MouseEvent {
            kind,
            column,
            row,
            modifiers: KeyModifiers::NONE,
        }
    }

    #[test]
    fn layouts_are_cached_per_width_and_reflow_on_change() {
        let renders = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&renders);
        let cell = TranscriptCell::new(move |width| {
            counter.fetch_add(1, Ordering::SeqCst);
            history_cell::info(
                "a fairly long line that has to wrap at narrow widths",
                width,
            )
        });
        let wide = cell.lines(80, false).len();
        cell.lines(80, false);
        let narrow = cell.lines(20, false).len();
        assert_eq!(renders.load(Ordering::SeqCst), 2);
        assert!(narrow > wide);
    }

    #[test]
    fn follows_the_newest_output_and_starts_at_the_top_when_short() {
        let view = numbered(2);
        assert_eq!(draw(&view, 4), ["line 1", "", "line 2", ""]);

        let view = numbered(4);
        // Seven rows (four cells, three separators); the newest five show.
        assert_eq!(draw(&view, 5), ["line 2", "", "line 3", "", "line 4"]);
    }

    #[test]
    fn reading_holds_its_place_as_output_arrives_until_returning() {
        let mut view = numbered(6);
        assert_eq!(draw(&view, 3), ["line 5", "", "line 6"]);

        // A page is the height less one row of overlap.
        view.scroll_pages(-1);
        assert_eq!(draw(&view, 3), ["line 4", "", "line 5"]);
        assert_eq!(view.reading(), Reading::Earlier);

        view.push(TranscriptCell::info("line 7"));
        assert_eq!(draw(&view, 3), ["line 4", "", "line 5"]);
        assert_eq!(view.reading(), Reading::EarlierWithNewOutput);

        view.scroll_pages(1);
        assert_eq!(draw(&view, 3), ["line 5", "", "line 6"]);
        view.scroll_pages(1);
        assert_eq!(view.reading(), Reading::Latest);
        assert_eq!(draw(&view, 3), ["line 6", "", "• line 7"]);

        view.scroll_to_start();
        assert_eq!(draw(&view, 3), ["line 1", "", "line 2"]);
    }

    #[test]
    fn the_wheel_scrolls_and_a_drag_selects_text_to_copy() {
        let mut view = numbered(8);
        assert_eq!(draw(&view, 5), ["line 6", "", "line 7", "", "line 8"]);
        let wheel = view.handle_mouse(mouse(MouseEventKind::ScrollUp, 0, 0), &[]);
        assert_eq!(wheel, None);
        assert_eq!(draw(&view, 5), ["", "line 5", "", "line 6", ""]);

        let left = MouseButton::Left;
        view.handle_mouse(mouse(MouseEventKind::Down(left), 0, 1), &[]);
        view.handle_mouse(mouse(MouseEventKind::Drag(left), 2, 3), &[]);
        let copied = view.handle_mouse(mouse(MouseEventKind::Up(left), 2, 3), &[]);
        assert_eq!(copied.as_deref(), Some("line 5\n\nlin"));

        // The selection stays highlighted until the next click.
        let area = Rect::new(0, 0, 20, 5);
        let mut buf = Buffer::empty(area);
        view.render(area, &mut buf, 20, &[]);
        assert!(buf[(2, 3)].modifier.contains(Modifier::REVERSED));
        assert!(!buf[(3, 3)].modifier.contains(Modifier::REVERSED));
        view.handle_mouse(mouse(MouseEventKind::Down(left), 0, 0), &[]);
        assert!(view.selection.is_none());
    }

    #[test]
    fn copying_rejoins_wrapped_lines_and_leaves_gutters_out() {
        let mut view = TranscriptView::new();
        view.push(TranscriptCell::message(
            StreamKind::Agent,
            "The quick brown fox jumps over the lazy dog.\n\n- first item\n- second".to_owned(),
        ));
        // At 20 columns: "• The quick brown", "  fox jumps over the", "  lazy dog.", "",
        // "  - first item", "  - second".
        let rows = draw(&view, 6);
        assert_eq!(rows[1], "  fox jumps over the");

        let left = MouseButton::Left;
        view.handle_mouse(mouse(MouseEventKind::Down(left), 0, 0), &[]);
        view.handle_mouse(mouse(MouseEventKind::Drag(left), 19, 5), &[]);
        let copied = view.handle_mouse(mouse(MouseEventKind::Up(left), 19, 5), &[]);
        assert_eq!(
            copied.as_deref(),
            Some("The quick brown fox jumps over the lazy dog.\n\n- first item\n- second")
        );

        // A selection inside a row takes just those characters.
        view.handle_mouse(mouse(MouseEventKind::Down(left), 6, 1), &[]);
        view.handle_mouse(mouse(MouseEventKind::Drag(left), 10, 1), &[]);
        let copied = view.handle_mouse(mouse(MouseEventKind::Up(left), 10, 1), &[]);
        assert_eq!(copied.as_deref(), Some("jumps"));
    }

    #[test]
    fn copying_a_diff_takes_the_code_without_numbers_or_signs() {
        use weave_acp_core::schema::Diff;
        use weave_acp_core::schema::ToolCall;
        use weave_acp_core::schema::ToolCallContent;
        use weave_acp_core::schema::ToolCallStatus;

        let call = ToolCall::new("t1", "Write notes.txt")
            .status(ToolCallStatus::Completed)
            .content(vec![ToolCallContent::Diff(Diff::new(
                "/repo/notes.txt",
                "hello\nworld\n",
            ))]);
        let mut view = TranscriptView::new();
        view.push(TranscriptCell::tool_call(
            ToolCallCell::new(call),
            PathBuf::from("/repo"),
            TerminalTranscripts::new(),
        ));
        assert_eq!(draw(&view, 4)[1], "    1 +hello");

        let left = MouseButton::Left;
        view.handle_mouse(mouse(MouseEventKind::Down(left), 0, 1), &[]);
        view.handle_mouse(mouse(MouseEventKind::Drag(left), 19, 2), &[]);
        let copied = view.handle_mouse(mouse(MouseEventKind::Up(left), 19, 2), &[]);
        assert_eq!(copied.as_deref(), Some("hello\nworld"));
    }
}
