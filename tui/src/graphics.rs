//! Images in the terminal, through the Kitty graphics protocol's Unicode placeholders.
//!
//! An image is sent to the terminal once, under an id, with a virtual placement so many
//! columns and rows in size. Text then shows it: each of its cells is `U+10EEEE` with
//! diacritics naming the cell's row and column, colored with the image's id. Since those
//! cells are text, ratatui draws, diffs and moves them like any other, and overwriting them
//! removes the image (<https://sw.kovidgoyal.net/kitty/graphics-protocol/#unicode-placeholders>).
//!
//! Some terminals answer the protocol's query without drawing placeholders (WezTerm does), so
//! weave asks only terminals known to draw them, outside multiplexers, and shows images where
//! the answer is yes.

use std::collections::BTreeMap;
use std::sync::Arc;

use base64::Engine;
use ratatui::layout::Size;
use ratatui::style::Color;
use ratatui::style::Style;
use ratatui::text::Span;

/// Asks whether the terminal takes images, with a 1×1 RGB image it only checks, and for its
/// cell size in pixels (`CSI 16 t`). Sent with the palette's probe, ahead of its DA1.
pub const QUERY: &[u8] = b"\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\\x1b[16t";

/// The character a placeholder cell shows.
const PLACEHOLDER: char = '\u{10EEEE}';
/// Base64 bytes in each escape sequence an image is sent in, as the protocol suggests.
const CHUNK: usize = 4096;
/// weave's image ids count up from here, clear of the small ids other programs pick. Ids stay
/// within 24 bits, which is what a truecolor foreground carries.
const FIRST_ID: u32 = 0x57_0000;

/// A terminal that draws images, and its cell size in pixels if it said.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Graphics {
    pub cell: Option<Size>,
}

impl Graphics {
    /// Whether to ask the terminal about images at all: only terminals known to draw
    /// placeholders, and not inside tmux or Zellij, which don't pass images through.
    pub fn worth_asking(var: impl Fn(&str) -> Option<String>) -> bool {
        if var("TMUX").is_some() || var("ZELLIJ").is_some() {
            return false;
        }
        let program = var("TERM_PROGRAM").unwrap_or_default().to_ascii_lowercase();
        let term = var("TERM").unwrap_or_default();
        var("KITTY_WINDOW_ID").is_some()
            || matches!(program.as_str(), "ghostty" | "kitty")
            || term.contains("kitty")
            || term.contains("ghostty")
    }

    /// The terminal's answers to [`QUERY`]: graphics, if it said it takes images.
    pub fn from_replies(replies: &[u8]) -> Option<Self> {
        find(replies, b"\x1b_Gi=31;OK").map(|_| Self {
            cell: cell_size(replies),
        })
    }
}

/// The id of the `n`th image weave shows, from 1.
pub fn image_id(n: usize) -> u32 {
    // Numbers wrap long before they could reach past 24 bits.
    FIRST_ID + u32::try_from(n % 0x1_0000).unwrap_or_default()
}

/// An image to keep in the terminal: its id, its PNG, and the cells it's placed in.
#[derive(Clone, Debug)]
pub struct Placement {
    pub id: u32,
    pub png: Arc<[u8]>,
    pub columns: u16,
    pub rows: u16,
}

/// The images weave holds in the terminal, by id, with the cells each is placed in.
#[derive(Debug, Default)]
pub struct Images {
    placed: BTreeMap<u32, (u16, u16)>,
}

impl Images {
    /// What to write so the terminal holds just `wanted`: images it doesn't have are sent and
    /// placed, ones wanted in other cells placed again, and the rest deleted.
    pub fn sync(&mut self, wanted: &[Placement]) -> String {
        let mut sequences = String::new();
        self.placed.retain(|id, _| {
            let keep = wanted.iter().any(|image| image.id == *id);
            if !keep {
                sequences.push_str(&delete(*id));
            }
            keep
        });
        for image in wanted {
            let cells = (image.columns, image.rows);
            match self.placed.insert(image.id, cells) {
                None => {
                    sequences.push_str(&transmit(image.id, &image.png));
                    sequences.push_str(&place(image.id, cells));
                }
                Some(placed) if placed != cells => sequences.push_str(&place(image.id, cells)),
                Some(_) => {}
            }
        }
        sequences
    }

    /// What to write to delete every image weave holds in the terminal.
    pub fn clear(&mut self) -> String {
        std::mem::take(&mut self.placed)
            .into_keys()
            .map(delete)
            .collect()
    }
}

/// Row `row` of image `id`, `columns` cells wide: placeholders, each naming its row and
/// column, in the image's color.
pub fn placeholders(id: u32, row: u16, columns: u16) -> Span<'static> {
    let mut text = String::new();
    if let Some(row_mark) = diacritic(row) {
        for column in 0..columns {
            if let Some(column_mark) = diacritic(column) {
                text.extend([PLACEHOLDER, row_mark, column_mark]);
            }
        }
    }
    Span::styled(text, Style::default().fg(id_color(id)))
}

/// Send `png` as image `id`, quietly, in chunks.
fn transmit(id: u32, png: &[u8]) -> String {
    let payload = base64::engine::general_purpose::STANDARD.encode(png);
    let mut chunks = payload.as_bytes().chunks(CHUNK).peekable();
    let mut sequence = String::new();
    let mut first = true;
    while let Some(chunk) = chunks.next() {
        let more = u8::from(chunks.peek().is_some());
        // Only the first chunk says what the image is.
        let keys = if first {
            format!("a=t,f=100,t=d,i={id},q=2,m={more}")
        } else {
            format!("q=2,m={more}")
        };
        first = false;
        let chunk = String::from_utf8_lossy(chunk);
        sequence.push_str(&format!("\x1b_G{keys};{chunk}\x1b\\"));
    }
    sequence
}

/// Place image `id` virtually in `columns` × `rows` cells, for placeholders to show. Placing
/// it again replaces this placement, as they share a placement id.
fn place(id: u32, (columns, rows): (u16, u16)) -> String {
    format!("\x1b_Ga=p,U=1,i={id},p=1,c={columns},r={rows},C=1,q=2\x1b\\")
}

/// Delete image `id`, its placement and its data.
fn delete(id: u32) -> String {
    format!("\x1b_Ga=d,d=I,i={id},q=2\x1b\\")
}

/// The foreground color that names image `id`, in its low 24 bits.
#[allow(clippy::disallowed_methods)] // An image id rather than a color: its exact value matters.
fn id_color(id: u32) -> Color {
    let [_, red, green, blue] = id.to_be_bytes();
    Color::Rgb(red, green, blue)
}

fn diacritic(index: u16) -> Option<char> {
    DIACRITICS
        .get(usize::from(index))
        .copied()
        .and_then(char::from_u32)
}

/// The cell size in a `CSI 6 ; height ; width t` reply.
fn cell_size(replies: &[u8]) -> Option<Size> {
    let start = find(replies, b"\x1b[6;")? + 4;
    let rest = &replies[start..];
    let end = rest.iter().position(|byte| *byte == b't')?;
    let (height, width) = std::str::from_utf8(&rest[..end]).ok()?.split_once(';')?;
    let size = Size::new(width.parse().ok()?, height.parse().ok()?);
    (size.width > 0 && size.height > 0).then_some(size)
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// The combining marks naming rows and columns 0, 1, 2…: the protocol's
/// `rowcolumn-diacritics.txt`.
const DIACRITICS: [u32; 297] = [
    0x0305, 0x030D, 0x030E, 0x0310, 0x0312, 0x033D, 0x033E, 0x033F, 0x0346, 0x034A, 0x034B, 0x034C,
    0x0350, 0x0351, 0x0352, 0x0357, 0x035B, 0x0363, 0x0364, 0x0365, 0x0366, 0x0367, 0x0368, 0x0369,
    0x036A, 0x036B, 0x036C, 0x036D, 0x036E, 0x036F, 0x0483, 0x0484, 0x0485, 0x0486, 0x0487, 0x0592,
    0x0593, 0x0594, 0x0595, 0x0597, 0x0598, 0x0599, 0x059C, 0x059D, 0x059E, 0x059F, 0x05A0, 0x05A1,
    0x05A8, 0x05A9, 0x05AB, 0x05AC, 0x05AF, 0x05C4, 0x0610, 0x0611, 0x0612, 0x0613, 0x0614, 0x0615,
    0x0616, 0x0617, 0x0657, 0x0658, 0x0659, 0x065A, 0x065B, 0x065D, 0x065E, 0x06D6, 0x06D7, 0x06D8,
    0x06D9, 0x06DA, 0x06DB, 0x06DC, 0x06DF, 0x06E0, 0x06E1, 0x06E2, 0x06E4, 0x06E7, 0x06E8, 0x06EB,
    0x06EC, 0x0730, 0x0732, 0x0733, 0x0735, 0x0736, 0x073A, 0x073D, 0x073F, 0x0740, 0x0741, 0x0743,
    0x0745, 0x0747, 0x0749, 0x074A, 0x07EB, 0x07EC, 0x07ED, 0x07EE, 0x07EF, 0x07F0, 0x07F1, 0x07F3,
    0x0816, 0x0817, 0x0818, 0x0819, 0x081B, 0x081C, 0x081D, 0x081E, 0x081F, 0x0820, 0x0821, 0x0822,
    0x0823, 0x0825, 0x0826, 0x0827, 0x0829, 0x082A, 0x082B, 0x082C, 0x082D, 0x0951, 0x0953, 0x0954,
    0x0F82, 0x0F83, 0x0F86, 0x0F87, 0x135D, 0x135E, 0x135F, 0x17DD, 0x193A, 0x1A17, 0x1A75, 0x1A76,
    0x1A77, 0x1A78, 0x1A79, 0x1A7A, 0x1A7B, 0x1A7C, 0x1B6B, 0x1B6D, 0x1B6E, 0x1B6F, 0x1B70, 0x1B71,
    0x1B72, 0x1B73, 0x1CD0, 0x1CD1, 0x1CD2, 0x1CDA, 0x1CDB, 0x1CE0, 0x1DC0, 0x1DC1, 0x1DC3, 0x1DC4,
    0x1DC5, 0x1DC6, 0x1DC7, 0x1DC8, 0x1DC9, 0x1DCB, 0x1DCC, 0x1DD1, 0x1DD2, 0x1DD3, 0x1DD4, 0x1DD5,
    0x1DD6, 0x1DD7, 0x1DD8, 0x1DD9, 0x1DDA, 0x1DDB, 0x1DDC, 0x1DDD, 0x1DDE, 0x1DDF, 0x1DE0, 0x1DE1,
    0x1DE2, 0x1DE3, 0x1DE4, 0x1DE5, 0x1DE6, 0x1DFE, 0x20D0, 0x20D1, 0x20D4, 0x20D5, 0x20D6, 0x20D7,
    0x20DB, 0x20DC, 0x20E1, 0x20E7, 0x20E9, 0x20F0, 0x2CEF, 0x2CF0, 0x2CF1, 0x2DE0, 0x2DE1, 0x2DE2,
    0x2DE3, 0x2DE4, 0x2DE5, 0x2DE6, 0x2DE7, 0x2DE8, 0x2DE9, 0x2DEA, 0x2DEB, 0x2DEC, 0x2DED, 0x2DEE,
    0x2DEF, 0x2DF0, 0x2DF1, 0x2DF2, 0x2DF3, 0x2DF4, 0x2DF5, 0x2DF6, 0x2DF7, 0x2DF8, 0x2DF9, 0x2DFA,
    0x2DFB, 0x2DFC, 0x2DFD, 0x2DFE, 0x2DFF, 0xA66F, 0xA67C, 0xA67D, 0xA6F0, 0xA6F1, 0xA8E0, 0xA8E1,
    0xA8E2, 0xA8E3, 0xA8E4, 0xA8E5, 0xA8E6, 0xA8E7, 0xA8E8, 0xA8E9, 0xA8EA, 0xA8EB, 0xA8EC, 0xA8ED,
    0xA8EE, 0xA8EF, 0xA8F0, 0xA8F1, 0xAAB0, 0xAAB2, 0xAAB3, 0xAAB7, 0xAAB8, 0xAABE, 0xAABF, 0xAAC1,
    0xFE20, 0xFE21, 0xFE22, 0xFE23, 0xFE24, 0xFE25, 0xFE26, 0x10A0F, 0x10A38, 0x1D185, 0x1D186,
    0x1D187, 0x1D188, 0x1D189, 0x1D1AA, 0x1D1AB, 0x1D1AC, 0x1D1AD, 0x1D242, 0x1D243, 0x1D244,
];

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;
    use ratatui::buffer::Buffer;
    use ratatui::layout::Rect;
    use unicode_width::UnicodeWidthStr;

    use super::*;

    fn env(vars: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let vars: Vec<(String, String)> = vars
            .iter()
            .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
            .collect();
        move |name| {
            vars.iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.clone())
        }
    }

    fn placement(id: u32, columns: u16) -> Placement {
        Placement {
            id,
            png: Arc::from(&b"png"[..]),
            columns,
            rows: 4,
        }
    }

    #[test]
    fn asks_only_terminals_known_to_draw_placeholders() {
        let ghostty = [("TERM_PROGRAM", "ghostty"), ("TERM", "xterm-256color")];
        assert!(Graphics::worth_asking(env(&ghostty)));
        assert!(Graphics::worth_asking(env(&[("TERM", "xterm-kitty")])));
        assert!(Graphics::worth_asking(env(&[("TERM", "xterm-ghostty")])));
        assert!(Graphics::worth_asking(env(&[("KITTY_WINDOW_ID", "1")])));
        // WezTerm answers the query but draws no placeholders.
        assert!(!Graphics::worth_asking(env(&[("TERM_PROGRAM", "WezTerm")])));
        assert!(!Graphics::worth_asking(env(&[("TERM", "xterm-256color")])));
        let tmux = [
            ("TERM_PROGRAM", "ghostty"),
            ("TMUX", "/tmp/tmux-501/default"),
        ];
        assert!(!Graphics::worth_asking(env(&tmux)));
        assert!(!Graphics::worth_asking(env(&[
            ("TERM", "xterm-kitty"),
            ("ZELLIJ", "0")
        ])));
    }

    #[test]
    fn reads_the_answer_and_cell_size() {
        // As cmux answered the probe, colors aside.
        let replies = b"\x1b_Gi=31;OK\x1b\\\x1b[6;42;19t\x1b[4;2478;2014t\x1b[?62;22;52c";
        assert_eq!(
            Graphics::from_replies(replies),
            Some(Graphics {
                cell: Some(Size::new(19, 42))
            })
        );
        assert_eq!(
            Graphics::from_replies(b"\x1b_Gi=31;OK\x1b\\\x1b[?62c"),
            Some(Graphics { cell: None })
        );
        assert_eq!(Graphics::from_replies(b"\x1b[6;42;19t\x1b[?62c"), None);
        assert_eq!(
            Graphics::from_replies(b"\x1b_Gi=31;ENOTSUPPORTED:\x1b\\\x1b[?62c"),
            None
        );
    }

    #[test]
    fn images_are_sent_in_chunks_only_the_first_describes() {
        let png: Vec<u8> = (0..5000_u32).map(|n| (n % 251) as u8).collect();
        let sequence = transmit(7, &png);
        let chunks: Vec<&str> = sequence
            .split("\x1b\\")
            .filter(|chunk| !chunk.is_empty())
            .collect();
        assert_eq!(chunks.len(), 2);
        let (first_keys, first) = chunks[0].split_once(';').expect("first");
        let (last_keys, last) = chunks[1].split_once(';').expect("last");
        assert_eq!(first_keys, "\x1b_Ga=t,f=100,t=d,i=7,q=2,m=1");
        assert_eq!(last_keys, "\x1b_Gq=2,m=0");
        assert_eq!(first.len(), CHUNK);
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(format!("{first}{last}"))
            .expect("base64");
        assert_eq!(decoded, png);
    }

    #[test]
    fn syncing_sends_each_image_once_and_places_it_again_when_resized() {
        let mut images = Images::default();
        let first = images.sync(&[placement(1, 8)]);
        assert!(first.starts_with("\x1b_Ga=t,f=100,t=d,i=1,q=2,m=0;cG5n\x1b\\"));
        assert!(first.ends_with("\x1b_Ga=p,U=1,i=1,p=1,c=8,r=4,C=1,q=2\x1b\\"));
        assert_eq!(images.sync(&[placement(1, 8)]), "");
        assert_eq!(
            images.sync(&[placement(1, 6)]),
            "\x1b_Ga=p,U=1,i=1,p=1,c=6,r=4,C=1,q=2\x1b\\"
        );
        let second = images.sync(&[placement(2, 5)]);
        assert!(second.starts_with("\x1b_Ga=d,d=I,i=1,q=2\x1b\\\x1b_Ga=t,f=100,t=d,i=2,"));
        assert_eq!(images.clear(), "\x1b_Ga=d,d=I,i=2,q=2\x1b\\");
        assert_eq!(images.clear(), "");
    }

    #[test]
    fn placeholders_name_each_cell_in_the_image_color() {
        let id = image_id(1);
        let row = placeholders(id, 1, 3);
        assert_eq!(
            row.content,
            "\u{10EEEE}\u{30D}\u{305}\u{10EEEE}\u{30D}\u{30D}\u{10EEEE}\u{30D}\u{30E}"
        );
        assert_eq!(row.style.fg, Some(id_color(id)));
        assert_eq!(id_color(0x57_0001), id_color(id));
        // Drawn, each placeholder is one cell, so the frame diff keeps the cells after it
        // aligned.
        let area = Rect::new(0, 0, 4, 1);
        let mut buf = Buffer::empty(area);
        buf.set_span(0, 0, &row, 4);
        assert_eq!(buf[(0, 0)].symbol(), "\u{10EEEE}\u{30D}\u{305}");
        assert_eq!(buf[(2, 0)].symbol(), "\u{10EEEE}\u{30D}\u{30E}");
        assert_eq!(buf[(3, 0)].symbol(), " ");
        assert_eq!(buf[(0, 0)].symbol().width(), 1);
    }
}
