//! Thumbnails of the conversation's images, where the terminal draws images (`graphics.rs`):
//! the draft's pasted images in a strip above the composer, and in the fullscreen transcript,
//! those of each message under its text.
//!
//! Every image the chat shows has a [`Slot`]: its id in the terminal and its thumbnail once
//! made. The draft and the transcript share a sent image's slot, and size its thumbnail by one
//! rule, so the terminal holds it once, in one placement.

use std::io::Cursor;
use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use base64::Engine;
use image::DynamicImage;
use image::ImageFormat;
use image::ImageReader;
use ratatui::layout::Size;
use ratatui::text::Line;
use ratatui::text::Span;
use unicode_width::UnicodeWidthStr;

use crate::graphics;
use crate::graphics::Placement;
use crate::style::dim;
use crate::wrapping::DisplayLine;
use crate::wrapping::LineSource;

/// A thumbnail's longest side in pixels; the terminal scales it into its cells.
const MAX_SIDE: u32 = 512;
/// Rows each thumbnail takes.
const ROWS: u16 = 4;
/// Columns a thumbnail takes at most; a wider image is fitted inside them.
const MAX_COLUMNS: u16 = 48;
/// Columns before the first thumbnail, in line with the text above or below it.
const INDENT: u16 = 2;
/// Columns between thumbnails.
const GAP: u16 = 2;
/// How many times taller than wide a cell is taken to be until the terminal says.
const DEFAULT_CELL_ASPECT: f64 = 2.0;

/// The terminal's cell height over width, as an `f64`'s bits.
static CELL_ASPECT: AtomicU64 = AtomicU64::new(DEFAULT_CELL_ASPECT.to_bits());

/// Record the terminal's cell size in pixels, which thumbnails take their shape from;
/// `None` when it doesn't say.
pub fn set_cell_size(cell: Option<Size>) {
    let aspect = cell
        .filter(|cell| cell.width > 0 && cell.height > 0)
        .map_or(DEFAULT_CELL_ASPECT, |cell| {
            f64::from(cell.height) / f64::from(cell.width)
        });
    CELL_ASPECT.store(aspect.to_bits(), Ordering::Relaxed);
}

/// How many times taller than wide the terminal's cells are.
pub fn cell_aspect() -> f64 {
    f64::from_bits(CELL_ASPECT.load(Ordering::Relaxed))
}

/// An image, shrunk and encoded as PNG for the terminal.
#[derive(Debug, PartialEq, Eq)]
pub struct Thumbnail {
    pub png: Arc<[u8]>,
    pub width: u32,
    pub height: u32,
}

impl Thumbnail {
    /// Decode the image at `path` (PNG, JPEG, GIF or WebP, by its contents) and shrink it.
    pub fn load(path: &Path) -> Result<Self, String> {
        let image = ImageReader::open(path)
            .and_then(ImageReader::with_guessed_format)
            .map_err(|error| error.to_string())?
            .decode()
            .map_err(|error| error.to_string())?;
        Self::shrink(image)
    }

    /// Decode an image a message carries, as base64, and shrink it.
    pub fn from_base64(data: &str) -> Result<Self, String> {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data.trim())
            .map_err(|error| error.to_string())?;
        let image = ImageReader::new(Cursor::new(bytes))
            .with_guessed_format()
            .map_err(|error| error.to_string())?
            .decode()
            .map_err(|error| error.to_string())?;
        Self::shrink(image)
    }

    fn shrink(image: DynamicImage) -> Result<Self, String> {
        let image = if image.width() > MAX_SIDE || image.height() > MAX_SIDE {
            image.thumbnail(MAX_SIDE, MAX_SIDE)
        } else {
            image
        };
        let mut png = Vec::new();
        image
            .write_to(&mut Cursor::new(&mut png), ImageFormat::Png)
            .map_err(|error| error.to_string())?;
        Ok(Self {
            png: png.into(),
            width: image.width(),
            height: image.height(),
        })
    }

    /// Columns this thumbnail takes at `ROWS` rows to keep its shape, in cells `cell_aspect`
    /// times as tall as they are wide.
    fn columns(&self, cell_aspect: f64) -> u16 {
        let columns =
            f64::from(ROWS) * cell_aspect * f64::from(self.width) / f64::from(self.height.max(1));
        // In range by construction; the cast only drops the fraction.
        columns.round().clamp(1.0, f64::from(MAX_COLUMNS)) as u16
    }

    /// The image in the terminal as image `id`, placed in the cells this thumbnail takes.
    fn placement(&self, id: u32, cell_aspect: f64) -> Placement {
        Placement {
            id,
            png: self.png.clone(),
            columns: self.columns(cell_aspect),
            rows: ROWS,
        }
    }
}

/// An image the chat shows: its id in the terminal, and its thumbnail once made. Cells
/// showing it render again when that changes.
#[derive(Debug)]
pub struct Slot {
    id: u32,
    state: Mutex<SlotState>,
    /// Counts changes to `state`, for the caches of cells showing it.
    changes: AtomicU64,
}

#[derive(Debug)]
enum SlotState {
    Making,
    Made(Arc<Thumbnail>),
    /// It couldn't be made, or was let go of.
    Gone,
}

impl Slot {
    pub fn new(id: u32) -> Arc<Self> {
        Arc::new(Self {
            id,
            state: Mutex::new(SlotState::Making),
            changes: AtomicU64::new(0),
        })
    }

    pub fn id(&self) -> u32 {
        self.id
    }

    pub fn thumbnail(&self) -> Option<Arc<Thumbnail>> {
        match &*self.state() {
            SlotState::Made(thumbnail) => Some(Arc::clone(thumbnail)),
            SlotState::Making | SlotState::Gone => None,
        }
    }

    /// How many times the slot has changed, which cells showing it compare.
    pub fn changes(&self) -> u64 {
        self.changes.load(Ordering::Relaxed)
    }

    /// The thumbnail, made, or `None` if it couldn't be. A slot let go of meanwhile stays
    /// empty.
    pub fn finish(&self, thumbnail: Option<Thumbnail>) {
        let mut state = self.state();
        if matches!(*state, SlotState::Making) {
            *state = thumbnail.map_or(SlotState::Gone, |thumbnail| {
                SlotState::Made(Arc::new(thumbnail))
            });
            self.changes.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// Stop showing the image, freeing its thumbnail.
    pub fn release(&self) {
        let mut state = self.state();
        if !matches!(*state, SlotState::Gone) {
            *state = SlotState::Gone;
            self.changes.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// The image in the terminal, once its thumbnail is made.
    pub fn placement(&self) -> Option<Placement> {
        self.thumbnail()
            .map(|thumbnail| thumbnail.placement(self.id, cell_aspect()))
    }

    fn state(&self) -> std::sync::MutexGuard<'_, SlotState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// An image to show in a strip, with the label under it, if any.
pub struct StripImage {
    pub id: u32,
    pub thumbnail: Arc<Thumbnail>,
    pub label: Option<String>,
}

/// One thumbnail in a strip, and the columns it takes.
struct Shown {
    image: StripImage,
    columns: u16,
}

/// Thumbnails side by side: those that fit across the width, left to right, and how many
/// didn't.
pub struct Strip {
    shown: Vec<Shown>,
    hidden: usize,
}

impl Strip {
    /// Lay out `images` across `width` columns, in cells `cell_aspect` times as tall as they
    /// are wide. An image shows whole or not at all, so it keeps the cells it's placed in.
    pub fn new(images: Vec<StripImage>, width: u16, cell_aspect: f64) -> Self {
        let total = images.len();
        let mut shown = Vec::new();
        let mut x = INDENT;
        for image in images {
            let columns = image.thumbnail.columns(cell_aspect);
            let slot = columns.max(image.label.as_deref().map_or(0, text_width));
            if x.saturating_add(slot) > width {
                break;
            }
            shown.push(Shown { image, columns });
            x += slot + GAP;
        }
        Self {
            hidden: total - shown.len(),
            shown,
        }
    }

    /// Whether no thumbnail fits.
    pub fn is_empty(&self) -> bool {
        self.shown.is_empty()
    }

    /// Rows the strip takes: the thumbnails', and one for labels or how many more there are.
    pub fn height(&self) -> u16 {
        ROWS + u16::from(self.has_footer())
    }

    /// The images the terminal holds for this strip.
    pub fn placements(&self) -> Vec<Placement> {
        self.shown
            .iter()
            .map(|shown| {
                shown
                    .image
                    .thumbnail
                    .placement(shown.image.id, cell_aspect())
            })
            .collect()
    }

    /// The strip's rows: the thumbnails, whose rows copy as blank lines, then their labels and
    /// how many more didn't fit.
    pub fn lines(&self) -> Vec<DisplayLine> {
        let indent = || Span::raw(" ".repeat(usize::from(INDENT)));
        let mut lines: Vec<DisplayLine> = (0..ROWS)
            .map(|row| {
                let mut spans = vec![indent()];
                for shown in &self.shown {
                    spans.push(graphics::placeholders(shown.image.id, row, shown.columns));
                    let after = slot_width(shown) - shown.columns + GAP;
                    spans.push(Span::raw(" ".repeat(usize::from(after))));
                }
                // Placeholders are no text to copy.
                DisplayLine {
                    line: Line::from(spans),
                    source: Some(LineSource {
                        text: Arc::from(""),
                        range: 0..0,
                        prefix_width: 0,
                        drawn: false,
                    }),
                }
            })
            .collect();
        if self.has_footer() {
            let mut spans = vec![indent()];
            for shown in &self.shown {
                let label = shown.image.label.as_deref().unwrap_or_default();
                let width = usize::from(slot_width(shown) + GAP);
                spans.push(Span::styled(format!("{label:width$}"), dim()));
            }
            if self.hidden > 0 {
                spans.push(Span::styled(format!("+{} more", self.hidden), dim()));
            }
            lines.push(DisplayLine::plain(Line::from(spans)));
        }
        lines
    }

    fn has_footer(&self) -> bool {
        self.hidden > 0 || self.shown.iter().any(|shown| shown.image.label.is_some())
    }
}

/// The rows showing a message's images in a transcript `width` columns wide: the thumbnails
/// made so far, unlabelled, or none.
pub fn transcript_rows(slots: &[Arc<Slot>], width: usize) -> Vec<DisplayLine> {
    let images: Vec<StripImage> = slots
        .iter()
        .filter_map(|slot| {
            Some(StripImage {
                id: slot.id(),
                thumbnail: slot.thumbnail()?,
                label: None,
            })
        })
        .collect();
    let width = u16::try_from(width).unwrap_or(u16::MAX);
    let strip = Strip::new(images, width, cell_aspect());
    if strip.is_empty() {
        return Vec::new();
    }
    strip.lines()
}

/// Columns a thumbnail's place in the strip takes: its own, or its label's if wider.
fn slot_width(shown: &Shown) -> u16 {
    shown
        .columns
        .max(shown.image.label.as_deref().map_or(0, text_width))
}

fn text_width(text: &str) -> u16 {
    u16::try_from(text.width()).unwrap_or(u16::MAX)
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;
    use ratatui::buffer::Buffer;
    use ratatui::layout::Rect;

    use super::*;

    fn thumbnail(width: u32, height: u32) -> Arc<Thumbnail> {
        Arc::new(Thumbnail {
            png: Arc::from(&b"png"[..]),
            width,
            height,
        })
    }

    fn labelled(number: usize, width: u32, height: u32) -> StripImage {
        StripImage {
            id: graphics::image_id(number),
            thumbnail: thumbnail(width, height),
            label: Some(format!("[image {number}]")),
        }
    }

    /// Rows as drawn, with placeholder cells shown as `#`.
    fn shown(lines: &[DisplayLine], width: u16) -> Vec<String> {
        let area = Rect::new(0, 0, width, u16::try_from(lines.len()).expect("rows"));
        let mut buf = Buffer::empty(area);
        for (y, line) in (0..).zip(lines) {
            buf.set_line(0, y, &line.line, width);
        }
        (0..area.height)
            .map(|y| {
                (0..area.width)
                    .map(|x| {
                        let symbol = buf[(x, y)].symbol();
                        if symbol.starts_with('\u{10EEEE}') {
                            "#"
                        } else {
                            symbol
                        }
                    })
                    .collect::<String>()
                    .trim_end()
                    .to_owned()
            })
            .collect()
    }

    #[test]
    fn loads_and_shrinks_images_whatever_their_format() {
        let dir = tempfile::tempdir().expect("tempdir");
        // A JPEG named as a PNG, as clipboards sometimes leave them.
        let path = dir.path().join("shot.png");
        image::RgbImage::from_pixel(1600, 900, image::Rgb([200, 40, 90]))
            .save_with_format(&path, ImageFormat::Jpeg)
            .expect("jpeg");
        let thumbnail = Thumbnail::load(&path).expect("thumbnail");
        assert_eq!((thumbnail.width, thumbnail.height), (512, 288));
        assert_eq!(
            image::guess_format(&thumbnail.png).expect("format"),
            ImageFormat::Png
        );

        let small = dir.path().join("icon.gif");
        image::RgbaImage::from_pixel(40, 30, image::Rgba([0, 0, 0, 255]))
            .save(&small)
            .expect("gif");
        let thumbnail = Thumbnail::load(&small).expect("thumbnail");
        assert_eq!((thumbnail.width, thumbnail.height), (40, 30));

        std::fs::write(dir.path().join("notes.png"), "not an image").expect("text");
        assert!(Thumbnail::load(&dir.path().join("notes.png")).is_err());
    }

    #[test]
    fn decodes_images_messages_carry() {
        let mut png = Vec::new();
        image::RgbImage::from_pixel(1024, 1024, image::Rgb([10, 20, 30]))
            .write_to(&mut Cursor::new(&mut png), ImageFormat::Png)
            .expect("png");
        let data = base64::engine::general_purpose::STANDARD.encode(&png);
        let thumbnail = Thumbnail::from_base64(&data).expect("thumbnail");
        assert_eq!((thumbnail.width, thumbnail.height), (512, 512));
        assert!(Thumbnail::from_base64("not base64!").is_err());
        assert!(Thumbnail::from_base64("bm90IGFuIGltYWdl").is_err());
    }

    #[test]
    fn thumbnails_keep_their_shape_in_cells() {
        // Cells twice as tall as wide: a 16:9 image four rows tall is 14 columns wide.
        assert_eq!(thumbnail(1600, 900).columns(2.0), 14);
        assert_eq!(thumbnail(300, 900).columns(2.0), 3);
        assert_eq!(thumbnail(100_000, 1).columns(2.0), MAX_COLUMNS);
    }

    #[test]
    fn the_strip_shows_what_fits_with_labels_under_each() {
        let images = vec![
            labelled(1, 1600, 900),
            labelled(2, 300, 900),
            labelled(3, 1600, 900),
        ];
        let strip = Strip::new(images, 40, 2.0);
        assert_eq!(strip.height(), 5);
        assert_eq!(
            shown(&strip.lines(), 40),
            [
                "  ##############  ###",
                "  ##############  ###",
                "  ##############  ###",
                "  ##############  ###",
                "  [image 1]       [image 2]  +1 more",
            ]
        );
        assert_eq!(
            strip
                .placements()
                .iter()
                .map(|placement| (placement.id, placement.columns, placement.rows))
                .collect::<Vec<_>>(),
            [
                (graphics::image_id(1), 14, 4),
                (graphics::image_id(2), 3, 4)
            ]
        );
    }

    #[test]
    fn a_thumbnail_too_wide_for_the_strip_is_left_out() {
        let strip = Strip::new(vec![labelled(1, 1600, 900)], 12, 2.0);
        assert!(strip.is_empty());
        assert_eq!(shown(&strip.lines(), 12)[4], "  +1 more");
    }

    #[test]
    fn slots_change_as_thumbnails_are_made_and_let_go_of() {
        let slot = Slot::new(graphics::image_id(1));
        assert_eq!((slot.thumbnail(), slot.changes()), (None, 0));
        assert!(transcript_rows(&[Arc::clone(&slot)], 40).is_empty());

        slot.finish(Some(Thumbnail {
            png: Arc::from(&b"png"[..]),
            width: 1600,
            height: 900,
        }));
        assert_eq!(slot.changes(), 1);
        let rows = transcript_rows(&[Arc::clone(&slot)], 40);
        // Unlabelled in the transcript, and the rows copy as nothing.
        assert_eq!(shown(&rows, 40), ["  ##############"; 4]);
        assert_eq!(
            rows[0].source.as_ref().map(|source| &*source.text),
            Some("")
        );
        assert!(slot.placement().is_some());

        slot.release();
        assert_eq!((slot.thumbnail(), slot.changes()), (None, 2));
        // A thumbnail made after its slot was let go of isn't kept.
        slot.finish(None);
        assert_eq!(slot.changes(), 2);
    }
}
