//! The terminal's own colors and color depth, and colors derived from them.
//!
//! Adapted from openai/codex `codex-rs/tui/src/terminal_palette.rs`, `color.rs` and
//! `terminal_probe.rs` (Apache-2.0). At startup weave asks the terminal for its default
//! foreground and background (OSC 10 and 11), so shaded surfaces such as the composer can be
//! blended from the real background. When the terminal doesn't say, they stay unstyled.

use std::sync::OnceLock;
use std::time::Duration;

use ratatui::style::Color;

pub type Rgb = (u8, u8, u8);

/// How many colors the terminal shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ColorLevel {
    TrueColor,
    Ansi256,
    Ansi16,
    /// No color, or no way to tell.
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Palette {
    pub fg: Option<Rgb>,
    pub bg: Option<Rgb>,
    pub level: ColorLevel,
}

static PALETTE: OnceLock<Palette> = OnceLock::new();

/// Record the palette found at startup. Only the first call counts.
pub fn set(palette: Palette) {
    let _ = PALETTE.set(palette);
}

/// The palette found at startup, or [`Palette::UNKNOWN`] before then (and in tests).
pub fn current() -> Palette {
    PALETTE.get().copied().unwrap_or(Palette::UNKNOWN)
}

impl Palette {
    pub const UNKNOWN: Self = Self {
        fg: None,
        bg: None,
        level: ColorLevel::Unknown,
    };

    /// Probe the terminal (which must be in raw mode) and read its color depth from the
    /// environment.
    pub fn detect() -> Self {
        let level = color_level_from_env(|name| std::env::var(name).ok());
        let colors = probe_default_colors(PROBE_TIMEOUT);
        Self {
            fg: colors.map(|(fg, _)| fg),
            bg: colors.map(|(_, bg)| bg),
            level,
        }
    }

    /// Whether the background is known to be light.
    pub fn is_light(&self) -> bool {
        self.bg.is_some_and(is_light)
    }

    /// The closest color the terminal can show to `target`, if it shows enough colors to
    /// tell it apart from the default.
    pub fn color(&self, target: Rgb) -> Option<Color> {
        match self.level {
            ColorLevel::TrueColor => Some(rgb(target)),
            ColorLevel::Ansi256 => Some(indexed(nearest_xterm_index(target))),
            ColorLevel::Ansi16 | ColorLevel::Unknown => None,
        }
    }

    /// `alpha` of `top` over the background, as a color the terminal can show.
    pub fn over_background(&self, top: Rgb, alpha: f32) -> Option<Color> {
        self.color(blend(top, self.bg?, alpha))
    }
}

/// An exact color. Only the palette builds these, matched to what the terminal can show;
/// elsewhere ANSI colors follow the user's theme (see `clippy.toml`).
#[allow(clippy::disallowed_methods)]
pub fn rgb((r, g, b): Rgb) -> Color {
    Color::Rgb(r, g, b)
}

#[allow(clippy::disallowed_methods)]
pub fn indexed(index: u8) -> Color {
    Color::Indexed(index)
}

/// Color depth as the environment describes it, as `supports-color` (which Codex uses) reads it.
fn color_level_from_env(var: impl Fn(&str) -> Option<String>) -> ColorLevel {
    if var("NO_COLOR").is_some_and(|value| !value.is_empty()) {
        return ColorLevel::Unknown;
    }
    let colorterm = var("COLORTERM").unwrap_or_default().to_ascii_lowercase();
    if colorterm == "truecolor" || colorterm == "24bit" {
        return ColorLevel::TrueColor;
    }
    let program = var("TERM_PROGRAM").unwrap_or_default();
    if matches!(
        program.as_str(),
        "iTerm.app" | "WezTerm" | "ghostty" | "vscode" | "Hyper"
    ) {
        return ColorLevel::TrueColor;
    }
    let term = var("TERM").unwrap_or_default();
    if term == "dumb" || term.is_empty() {
        ColorLevel::Unknown
    } else if term.contains("256") || program == "Apple_Terminal" {
        ColorLevel::Ansi256
    } else if term.contains("truecolor") || term.contains("direct") {
        ColorLevel::TrueColor
    } else {
        ColorLevel::Ansi16
    }
}

pub fn is_light(color: Rgb) -> bool {
    let (r, g, b) = color;
    0.299 * f32::from(r) + 0.587 * f32::from(g) + 0.114 * f32::from(b) > 128.0
}

/// `alpha` of `top` over `bottom`.
pub fn blend(top: Rgb, bottom: Rgb, alpha: f32) -> Rgb {
    let mix = |a: u8, b: u8| {
        let value = f32::from(a) * alpha + f32::from(b) * (1.0 - alpha);
        // In range by construction; the cast only drops the fraction.
        value.clamp(0.0, 255.0) as u8
    };
    (
        mix(top.0, bottom.0),
        mix(top.1, bottom.1),
        mix(top.2, bottom.2),
    )
}

/// The xterm palette entry (16..=255; the first 16 are user-themed) nearest to `target`.
fn nearest_xterm_index(target: Rgb) -> u8 {
    (16..=255)
        .map(|index| (index, xterm_color(index)))
        .min_by(|(_, a), (_, b)| {
            perceptual_distance(*a, target).total_cmp(&perceptual_distance(*b, target))
        })
        .map_or(16, |(index, _)| index)
}

/// An xterm-256 color: the 6×6×6 cube from 16, then 24 grays from 232.
fn xterm_color(index: u8) -> Rgb {
    const LEVELS: [u8; 6] = [0, 95, 135, 175, 215, 255];
    if index >= 232 {
        let gray = 8 + 10 * (index - 232);
        return (gray, gray, gray);
    }
    let cube = index.saturating_sub(16);
    (
        LEVELS[usize::from(cube / 36)],
        LEVELS[usize::from(cube / 6 % 6)],
        LEVELS[usize::from(cube % 6)],
    )
}

/// CIE76 distance in Lab space, as Codex measures nearness.
fn perceptual_distance(a: Rgb, b: Rgb) -> f32 {
    let (l1, a1, b1) = lab(a);
    let (l2, a2, b2) = lab(b);
    ((l1 - l2).powi(2) + (a1 - a2).powi(2) + (b1 - b2).powi(2)).sqrt()
}

fn lab((r, g, b): Rgb) -> (f32, f32, f32) {
    let linear = |c: u8| {
        let c = f32::from(c) / 255.0;
        if c <= 0.04045 {
            c / 12.92
        } else {
            ((c + 0.055) / 1.055).powf(2.4)
        }
    };
    let (r, g, b) = (linear(r), linear(g), linear(b));
    let x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
    let y = r * 0.2126 + g * 0.7152 + b * 0.0722;
    let z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
    let f = |t: f32| {
        if t > 0.008856 {
            t.cbrt()
        } else {
            7.787 * t + 16.0 / 116.0
        }
    };
    let (fx, fy, fz) = (f(x), f(y), f(z));
    (116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz))
}

/// How long to wait for the terminal's answers. Terminals answer the trailing DA1 query
/// even when they ignore color queries, which ends the wait early.
const PROBE_TIMEOUT: Duration = Duration::from_millis(500);

/// Ask the terminal for its default foreground and background colors.
#[cfg(unix)]
fn probe_default_colors(timeout: Duration) -> Option<(Rgb, Rgb)> {
    use std::io::Write;
    use std::time::Instant;

    let mut out = std::io::stdout();
    out.write_all(b"\x1b]10;?\x1b\\\x1b]11;?\x1b\\\x1b[c")
        .ok()?;
    out.flush().ok()?;
    let deadline = Instant::now() + timeout;
    let mut buffer = Vec::new();
    while !has_device_attributes(&buffer) && buffer.len() < 4096 {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() || !stdin_readable(remaining) {
            break;
        }
        let mut chunk = [0_u8; 256];
        // SAFETY: reads into a live, correctly sized stack buffer; poll said it won't block.
        let count = unsafe {
            libc::read(
                libc::STDIN_FILENO,
                chunk.as_mut_ptr().cast::<libc::c_void>(),
                chunk.len(),
            )
        };
        let Ok(count) = usize::try_from(count) else {
            break;
        };
        if count == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..count]);
    }
    Some((parse_osc_color(&buffer, 10)?, parse_osc_color(&buffer, 11)?))
}

#[cfg(not(unix))]
fn probe_default_colors(_timeout: Duration) -> Option<(Rgb, Rgb)> {
    None
}

#[cfg(unix)]
fn stdin_readable(timeout: Duration) -> bool {
    let mut fd = libc::pollfd {
        fd: libc::STDIN_FILENO,
        events: libc::POLLIN,
        revents: 0,
    };
    let millis = libc::c_int::try_from(timeout.as_millis()).unwrap_or(libc::c_int::MAX);
    // SAFETY: polls one live pollfd for the duration of the call.
    let ready = unsafe { libc::poll(&mut fd, 1, millis) };
    ready > 0 && fd.revents & libc::POLLIN != 0
}

/// Whether `buffer` holds a primary device attributes reply, `ESC [ ? … c`.
fn has_device_attributes(buffer: &[u8]) -> bool {
    buffer.windows(3).enumerate().any(|(start, window)| {
        window == b"\x1b[?"
            && buffer[start + 3..]
                .iter()
                .find(|byte| !(byte.is_ascii_digit() || **byte == b';'))
                == Some(&b'c')
    })
}

/// The color in an `OSC slot ; rgb:RRRR/GGGG/BBBB` reply.
fn parse_osc_color(buffer: &[u8], slot: u8) -> Option<Rgb> {
    let prefix = format!("\x1b]{slot};");
    let start = buffer
        .windows(prefix.len())
        .position(|window| window == prefix.as_bytes())?
        + prefix.len();
    let rest = &buffer[start..];
    let end = rest
        .iter()
        .position(|byte| *byte == 0x07 || *byte == 0x1b)?;
    let payload = std::str::from_utf8(&rest[..end]).ok()?;
    let (kind, values) = payload.trim().split_once(':')?;
    if !kind.eq_ignore_ascii_case("rgb") && !kind.eq_ignore_ascii_case("rgba") {
        return None;
    }
    let mut parts = values.split('/').map(osc_component);
    Some((parts.next()??, parts.next()??, parts.next()??))
}

/// One 1–4 hex digit component, scaled to 8 bits.
fn osc_component(hex: &str) -> Option<u8> {
    if !(1..=4).contains(&hex.len()) {
        return None;
    }
    let value = u32::from_str_radix(hex, 16).ok()?;
    let max = (1_u32 << (hex.len() * 4)) - 1;
    u8::try_from(value * 255 / max).ok()
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    #[test]
    fn parses_color_replies_in_either_terminator_and_depth() {
        let reply = b"\x1b]10;rgb:cdcd/d6d6/f4f4\x1b\\\x1b]11;rgb:1e/1e/2e\x07\x1b[?62;22c";
        assert_eq!(parse_osc_color(reply, 10), Some((205, 214, 244)));
        assert_eq!(parse_osc_color(reply, 11), Some((30, 30, 46)));
        assert!(has_device_attributes(reply));
        assert!(!has_device_attributes(b"\x1b]11;rgb:1e/1e/2e\x07"));
        assert_eq!(parse_osc_color(b"\x1b]11;hsl:1/2/3\x07", 11), None);
    }

    #[test]
    fn color_depth_follows_the_environment() {
        let level = |vars: &[(&str, &str)]| {
            color_level_from_env(|name| {
                vars.iter()
                    .find(|(key, _)| *key == name)
                    .map(|(_, value)| (*value).to_owned())
            })
        };
        assert_eq!(level(&[("COLORTERM", "truecolor")]), ColorLevel::TrueColor);
        assert_eq!(level(&[("TERM", "xterm-256color")]), ColorLevel::Ansi256);
        assert_eq!(level(&[("TERM", "xterm")]), ColorLevel::Ansi16);
        assert_eq!(
            level(&[("TERM", "xterm-256color"), ("NO_COLOR", "1")]),
            ColorLevel::Unknown
        );
    }

    #[test]
    fn blends_and_maps_to_what_the_terminal_shows() {
        let dark = Palette {
            fg: Some((205, 214, 244)),
            bg: Some((30, 30, 46)),
            level: ColorLevel::TrueColor,
        };
        assert!(!dark.is_light());
        assert_eq!(
            dark.over_background((255, 255, 255), 0.12),
            Some(rgb((57, 57, 71)))
        );
        let ansi256 = Palette {
            level: ColorLevel::Ansi256,
            ..dark
        };
        assert_eq!(ansi256.color((255, 0, 0)), Some(indexed(196)));
        assert_eq!(ansi256.color((128, 128, 128)), Some(indexed(244)));
        assert_eq!(
            Palette::UNKNOWN.over_background((255, 255, 255), 0.12),
            None
        );
    }
}
