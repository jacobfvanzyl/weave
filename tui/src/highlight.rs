//! Syntax highlighting, adapted from openai/codex `codex-rs/tui/src/render/highlight.rs`
//! (Apache-2.0): syntect with two-face's grammars and Catppuccin themes (Mocha on dark
//! backgrounds, Latte on light ones), and Codex's limits on what is worth highlighting.
//! Anything unrecognized or too large stays plain text.

use std::sync::OnceLock;

use ratatui::style::Modifier;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::text::Span;
use syntect::easy::HighlightLines;
use syntect::highlighting::FontStyle;
use syntect::highlighting::Theme;
use syntect::parsing::SyntaxReference;
use syntect::parsing::SyntaxSet;
use syntect::util::LinesWithEndings;
use two_face::theme::EmbeddedThemeName;

use crate::palette;
use crate::palette::Palette;

/// Inputs past these sizes stay plain, as in Codex, to bound CPU and memory.
const MAX_BYTES: usize = 512 * 1024;
const MAX_LINES: usize = 10_000;
const MAX_LINE_BYTES: usize = 4 * 1024;

static SYNTAXES: OnceLock<SyntaxSet> = OnceLock::new();
static THEME: OnceLock<Theme> = OnceLock::new();

fn syntaxes() -> &'static SyntaxSet {
    SYNTAXES.get_or_init(two_face::syntax::extra_newlines)
}

/// The theme for the terminal's background, chosen on first use (after the startup probe).
fn theme() -> &'static Theme {
    THEME.get_or_init(|| theme_for(&palette::current()))
}

fn theme_for(palette: &Palette) -> Theme {
    let name = if palette.is_light() {
        EmbeddedThemeName::CatppuccinLatte
    } else {
        EmbeddedThemeName::CatppuccinMocha
    };
    two_face::theme::extra().get(name).clone()
}

/// Load grammars and the theme in the background, so the first code block doesn't wait.
pub fn warm_up() {
    std::thread::spawn(|| {
        syntaxes();
        theme();
    });
}

/// The theme's foreground for the first of `scopes` it styles specifically, as Codex colors
/// status line items by theme scope.
pub fn scope_color(scopes: &[&str]) -> Option<ratatui::style::Color> {
    scope_color_with(scopes, theme(), &palette::current())
}

fn scope_color_with(
    scopes: &[&str],
    theme: &Theme,
    palette: &Palette,
) -> Option<ratatui::style::Color> {
    use syntect::highlighting::Highlighter;
    use syntect::parsing::Scope;

    let highlighter = Highlighter::new(theme);
    let default = theme.settings.foreground?;
    scopes.iter().find_map(|scope| {
        let scope = Scope::new(scope).ok()?;
        let color = highlighter.style_for_stack(&[scope]).foreground;
        (color != default)
            .then(|| palette.color((color.r, color.g, color.b)))
            .flatten()
    })
}

/// `code` as highlighted lines, or plain ones when `lang` is unknown or the code too large.
pub fn code_lines(code: &str, lang: &str) -> Vec<Line<'static>> {
    highlight(code, lang, theme(), &palette::current()).unwrap_or_else(|| {
        let mut lines: Vec<Line<'static>> = code
            .lines()
            .map(|line| Line::from(line.to_owned()))
            .collect();
        if lines.is_empty() {
            lines.push(Line::default());
        }
        lines
    })
}

/// A shell command, highlighted as bash.
pub fn shell_lines(command: &str) -> Vec<Line<'static>> {
    code_lines(command, "bash")
}

fn highlight(
    code: &str,
    lang: &str,
    theme: &Theme,
    palette: &Palette,
) -> Option<Vec<Line<'static>>> {
    if code.is_empty()
        || code.len() > MAX_BYTES
        || code.lines().count() > MAX_LINES
        || code.lines().any(|line| line.len() > MAX_LINE_BYTES)
    {
        return None;
    }
    let syntax = find_syntax(lang)?;
    let mut highlighter = HighlightLines::new(syntax, theme);
    let mut lines = Vec::new();
    for line in LinesWithEndings::from(code) {
        let ranges = highlighter.highlight_line(line, syntaxes()).ok()?;
        let spans: Vec<Span<'static>> = ranges
            .into_iter()
            .filter_map(|(style, text)| {
                let text = text.trim_end_matches(['\n', '\r']);
                (!text.is_empty()).then(|| Span::styled(text.to_owned(), convert(style, palette)))
            })
            .collect();
        lines.push(Line::from(spans));
    }
    Some(lines)
}

/// A syntect style as ratatui's: the foreground as near as the terminal shows it, and bold.
/// Backgrounds stay the terminal's; italics and underlines render poorly, so Codex drops them.
fn convert(style: syntect::highlighting::Style, palette: &Palette) -> Style {
    let color = style.foreground;
    let mut converted = Style::default();
    if let Some(fg) = palette.color((color.r, color.g, color.b)) {
        converted = converted.fg(fg);
    }
    if style.font_style.contains(FontStyle::BOLD) {
        converted = converted.add_modifier(Modifier::BOLD);
    }
    converted
}

/// Find a grammar by fence token, name or extension, with Codex's extra aliases.
fn find_syntax(lang: &str) -> Option<&'static SyntaxReference> {
    let set = syntaxes();
    let lang = lang.split([',', ' ', '\t']).next().unwrap_or_default();
    if lang.is_empty() {
        return None;
    }
    let token = match lang.to_ascii_lowercase().as_str() {
        "csharp" | "c-sharp" => "c#".to_owned(),
        "golang" => "go".to_owned(),
        "python3" => "python".to_owned(),
        "shell" | "sh" | "zsh" | "console" => "bash".to_owned(),
        "cu" | "cuh" | "cppm" | "cxxm" | "ixx" => "cpp".to_owned(),
        other => other.to_owned(),
    };
    set.find_syntax_by_token(&token)
        .or_else(|| set.find_syntax_by_name(&token))
        .or_else(|| {
            set.syntaxes()
                .iter()
                .find(|syntax| syntax.name.eq_ignore_ascii_case(&token))
        })
        .or_else(|| set.find_syntax_by_extension(lang))
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;
    use ratatui::style::Color;

    use super::*;
    use crate::palette::ColorLevel;

    fn truecolor() -> Palette {
        Palette {
            fg: None,
            bg: Some((30, 30, 46)),
            level: ColorLevel::TrueColor,
        }
    }

    #[test]
    fn known_languages_are_colored_and_keep_their_text() {
        let palette = truecolor();
        let theme = theme_for(&palette);
        let lines =
            highlight("fn main() {\n    run();\n}\n", "rust", &theme, &palette).unwrap_or_default();
        let text: Vec<String> = lines.iter().map(ToString::to_string).collect();
        assert_eq!(text, ["fn main() {", "    run();", "}"]);
        let colors: Vec<Option<Color>> = lines[0].spans.iter().map(|span| span.style.fg).collect();
        assert!(colors.iter().all(Option::is_some), "{colors:?}");
        assert!(colors.windows(2).any(|pair| pair[0] != pair[1]));
    }

    #[test]
    fn unknown_languages_and_oversized_input_stay_plain() {
        let palette = truecolor();
        let theme = theme_for(&palette);
        assert!(highlight("x", "no-such-language", &theme, &palette).is_none());
        let long = "x".repeat(MAX_LINE_BYTES + 1);
        assert!(highlight(&long, "rust", &theme, &palette).is_none());
        assert_eq!(code_lines("a\nb", "no-such-language").len(), 2);
    }

    #[test]
    fn scopes_take_the_themes_colors() {
        let palette = truecolor();
        let theme = theme_for(&palette);
        let string = scope_color_with(&["string"], &theme, &palette);
        assert!(string.is_some());
        assert_ne!(string, scope_color_with(&["keyword"], &theme, &palette));
        assert_eq!(scope_color_with(&["no.such.scope"], &theme, &palette), None);
    }

    #[test]
    fn aliases_and_fence_metadata_resolve() {
        assert!(find_syntax("sh").is_some());
        assert!(find_syntax("rust,no_run").is_some());
        assert!(find_syntax("Python").is_some());
        assert!(find_syntax("").is_none());
    }
}
