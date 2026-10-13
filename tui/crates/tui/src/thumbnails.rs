//! Thumbnails of the images pasted into a draft, in a strip above the composer, where the
//! terminal draws images (`graphics.rs`).

use std::io::Cursor;
use std::path::Path;
use std::sync::Arc;

use image::ImageFormat;
use image::ImageReader;
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use unicode_width::UnicodeWidthStr;

use crate::graphics;
use crate::graphics::Placement;
use crate::style::dim;

/// A thumbnail's longest side in pixels; the terminal scales it into its cells.
const MAX_SIDE: u32 = 512;
/// Rows each thumbnail takes.
const ROWS: u16 = 4;
/// The strip's height: the thumbnails, and their labels under them.
pub const HEIGHT: u16 = ROWS + 1;
/// Columns before the first thumbnail, in line with the composer's text.
const INDENT: u16 = 2;
/// Columns between thumbnails.
const GAP: u16 = 2;

/// A pasted image, shrunk and encoded as PNG for the terminal.
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

    /// Columns this thumbnail takes at `ROWS` rows to keep its shape, in cells
    /// `cell_aspect` times as tall as they are wide.
    fn columns(&self, cell_aspect: f64) -> u16 {
        let columns =
            f64::from(ROWS) * cell_aspect * f64::from(self.width) / f64::from(self.height.max(1));
        // In range by construction; the cast only drops the fraction.
        columns.round().clamp(1.0, f64::from(graphics::MAX_CELLS)) as u16
    }
}

/// One thumbnail in the strip.
struct Shown {
    number: usize,
    thumbnail: Arc<Thumbnail>,
    columns: u16,
}

/// The thumbnails that fit across the strip, left to right, and how many didn't.
pub struct Strip {
    shown: Vec<Shown>,
    hidden: usize,
}

impl Strip {
    /// Lay out pasted images, by number, across `width` columns, in cells `cell_aspect`
    /// times as tall as they are wide. The first shrinks to fit; later ones show whole or not
    /// at all.
    pub fn new(images: Vec<(usize, Arc<Thumbnail>)>, width: u16, cell_aspect: f64) -> Self {
        let total = images.len();
        let mut shown = Vec::new();
        let mut x = INDENT;
        for (number, thumbnail) in images {
            let room = width.saturating_sub(x);
            let mut columns = thumbnail.columns(cell_aspect);
            if shown.is_empty() {
                columns = columns.min(room);
            }
            let slot = columns.max(text_width(&label(number)));
            if columns == 0 || slot > room {
                break;
            }
            shown.push(Shown {
                number,
                thumbnail,
                columns,
            });
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

    /// The images the terminal holds for this strip.
    pub fn placements(&self) -> Vec<Placement> {
        self.shown
            .iter()
            .map(|shown| Placement {
                id: graphics::image_id(shown.number),
                png: shown.thumbnail.png.clone(),
                columns: shown.columns,
                rows: ROWS,
            })
            .collect()
    }

    /// Draw the strip into `area`, [`HEIGHT`] rows tall: each thumbnail with its label under
    /// it, then how many more didn't fit.
    pub fn render(&self, area: Rect, buf: &mut Buffer) {
        if area.height < HEIGHT {
            return;
        }
        let labels = area.y + ROWS;
        let mut x = area.x + INDENT;
        for shown in &self.shown {
            let image = Rect::new(x, area.y, shown.columns, ROWS).intersection(area);
            graphics::draw_placeholders(graphics::image_id(shown.number), image, buf);
            let label = label(shown.number);
            buf.set_stringn(x, labels, &label, usize::from(area.right() - x), dim());
            x += shown.columns.max(text_width(&label)) + GAP;
        }
        if self.hidden > 0 && x < area.right() {
            let more = format!("+{} more", self.hidden);
            buf.set_stringn(x, labels, more, usize::from(area.right() - x), dim());
        }
    }
}

/// What a thumbnail is labelled: the token it has in the draft.
fn label(number: usize) -> String {
    format!("[image {number}]")
}

fn text_width(text: &str) -> u16 {
    u16::try_from(text.width()).unwrap_or(u16::MAX)
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    fn thumbnail(width: u32, height: u32) -> Arc<Thumbnail> {
        Arc::new(Thumbnail {
            png: Arc::from(&b"png"[..]),
            width,
            height,
        })
    }

    /// The strip's rows, with placeholder cells shown as `#`.
    fn rows(strip: &Strip, width: u16) -> Vec<String> {
        let area = Rect::new(0, 0, width, HEIGHT);
        let mut buf = Buffer::empty(area);
        strip.render(area, &mut buf);
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
    fn thumbnails_keep_their_shape_in_cells() {
        // Cells twice as tall as wide: a 16:9 image four rows tall is 14 columns wide.
        assert_eq!(thumbnail(1600, 900).columns(2.0), 14);
        assert_eq!(thumbnail(300, 900).columns(2.0), 3);
        assert_eq!(thumbnail(100_000, 1).columns(2.0), graphics::MAX_CELLS);
    }

    #[test]
    fn the_strip_shows_what_fits_with_labels_under_each() {
        let images = vec![
            (1, thumbnail(1600, 900)),
            (2, thumbnail(300, 900)),
            (3, thumbnail(1600, 900)),
        ];
        let strip = Strip::new(images, 40, 2.0);
        assert_eq!(
            rows(&strip, 40),
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
    fn the_first_thumbnail_shrinks_to_fit() {
        let strip = Strip::new(vec![(1, thumbnail(1600, 900))], 12, 2.0);
        assert_eq!(rows(&strip, 12)[0], "  ##########");
        assert_eq!(strip.placements()[0].columns, 10);
    }
}
