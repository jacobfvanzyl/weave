//! The `@` file picker: a fuzzy search over the session directory's files, as Codex and Toad
//! offer, using the same pieces as Codex's file search (ripgrep's `ignore` walker, which
//! honors .gitignore, and nucleo's matcher).

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

use nucleo_matcher::Config;
use nucleo_matcher::Matcher;
use nucleo_matcher::pattern::CaseMatching;
use nucleo_matcher::pattern::Normalization;
use nucleo_matcher::pattern::Pattern;
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Modifier;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::text::Span;

use crate::style;
use crate::style::dim;

/// Matches shown at once.
pub const VISIBLE_ROWS: usize = 8;
/// Files indexed at most, to bound memory and time in huge trees.
const MAX_FILES: usize = 100_000;

enum IndexState {
    Idle,
    Indexing,
    Ready(Vec<String>),
}

/// The session directory's files, indexed in the background on first use.
pub struct FileIndex {
    root: PathBuf,
    state: Arc<Mutex<IndexState>>,
}

impl FileIndex {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            state: Arc::new(Mutex::new(IndexState::Idle)),
        }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, IndexState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Start indexing, unless it has already started.
    pub fn ensure(&self) {
        let mut state = self.state();
        if !matches!(*state, IndexState::Idle) {
            return;
        }
        *state = IndexState::Indexing;
        let root = self.root.clone();
        let shared = Arc::clone(&self.state);
        std::thread::spawn(move || {
            let files = walk(&root);
            *shared
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = IndexState::Ready(files);
        });
    }

    pub fn is_indexing(&self) -> bool {
        matches!(*self.state(), IndexState::Indexing)
    }

    /// The best matches for `query`, best first; `None` while indexing.
    pub fn search(&self, query: &str, limit: usize) -> Option<Vec<String>> {
        let state = self.state();
        let IndexState::Ready(files) = &*state else {
            return None;
        };
        if query.is_empty() {
            return Some(files.iter().take(limit).cloned().collect());
        }
        let mut matcher = Matcher::new(Config::DEFAULT.match_paths());
        let pattern = Pattern::parse(query, CaseMatching::Smart, Normalization::Smart);
        let mut matches = pattern.match_list(files.iter(), &mut matcher);
        // Among equal scores, shorter paths first.
        matches.sort_by(|(a, a_score), (b, b_score)| {
            b_score.cmp(a_score).then_with(|| a.len().cmp(&b.len()))
        });
        Some(
            matches
                .into_iter()
                .take(limit)
                .map(|(path, _)| path.clone())
                .collect(),
        )
    }
}

/// Files under `root`, relative to it, honoring .gitignore and skipping hidden ones; shallow
/// paths first, as the starting list for an empty query.
fn walk(root: &Path) -> Vec<String> {
    let mut files: Vec<String> = ignore::WalkBuilder::new(root)
        .build()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_some_and(|kind| kind.is_file()))
        .filter_map(|entry| {
            let relative = entry.path().strip_prefix(root).ok()?;
            Some(relative.to_string_lossy().replace('\\', "/"))
        })
        .take(MAX_FILES)
        .collect();
    files.sort_by(|a, b| {
        a.matches('/')
            .count()
            .cmp(&b.matches('/').count())
            .then_with(|| a.cmp(b))
    });
    files
}

/// The selection within the matches, and the query it was made for.
#[derive(Default)]
pub struct FilePopup {
    selected: usize,
    query: String,
    /// The mention the user dismissed with Esc, so it stays dismissed while unchanged.
    dismissed: Option<(usize, String)>,
}

impl FilePopup {
    /// Follow the query, starting from the top when it changes.
    pub fn sync(&mut self, query: &str) {
        if self.query != query {
            self.query = query.to_owned();
            self.selected = 0;
        }
    }

    pub fn is_dismissed(&self, start: usize, query: &str) -> bool {
        self.dismissed
            .as_ref()
            .is_some_and(|(at, dismissed)| *at == start && dismissed == query)
    }

    pub fn dismiss(&mut self, start: usize, query: &str) {
        self.dismissed = Some((start, query.to_owned()));
    }

    pub fn move_selection(&mut self, delta: isize, count: usize) {
        if count > 0 {
            self.selected = self.selected.saturating_add_signed(delta).min(count - 1);
        }
    }

    pub fn selected(&self) -> usize {
        self.selected
    }

    /// Rows the popup takes for `matches`; one while indexing or when nothing matches.
    pub fn height(matches: Option<&[String]>) -> u16 {
        let rows = matches.map_or(1, |matches| matches.len().clamp(1, VISIBLE_ROWS));
        u16::try_from(rows).unwrap_or(1)
    }

    pub fn render(&self, matches: Option<&[String]>, area: Rect, buf: &mut Buffer) {
        let lines: Vec<Line<'static>> = match matches {
            None => vec![Line::from(Span::styled("  Searching files…", dim()))],
            Some([]) => vec![Line::from(Span::styled("  No matching files", dim()))],
            Some(matches) => matches
                .iter()
                .enumerate()
                .take(VISIBLE_ROWS)
                .map(|(index, path)| {
                    let selected = index == self.selected;
                    let marker = if selected { "› " } else { "  " };
                    let line = Line::from(vec![
                        Span::raw(marker),
                        Span::styled(path.clone(), Style::default().add_modifier(Modifier::BOLD)),
                    ]);
                    if selected {
                        line.style(style::selection())
                    } else {
                        line
                    }
                })
                .collect(),
        };
        for (line, y) in lines.iter().zip(area.y..area.bottom()) {
            style::set_line_filled(buf, area.x, y, line, area.width);
        }
    }
}

/// How a path goes into the prompt: `@path`, quoted when it has spaces.
pub fn mention_for(path: &str) -> String {
    if path.contains(char::is_whitespace) {
        format!("@\"{path}\" ")
    } else {
        format!("@{path} ")
    }
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    fn index(files: &[&str]) -> (tempfile::TempDir, FileIndex) {
        let dir = tempfile::tempdir().expect("tempdir");
        for file in files {
            let path = dir.path().join(file);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).expect("dirs");
            }
            std::fs::write(&path, "x").expect("file");
        }
        let index = FileIndex::new(dir.path().to_path_buf());
        (dir, index)
    }

    #[test]
    fn indexes_in_the_background_honoring_gitignore() {
        let (dir, index) = index(&["src/main.rs", "src/lib.rs", "target/debug/out", "README.md"]);
        std::fs::write(dir.path().join(".gitignore"), "target/\n").expect("gitignore");
        // The walker honors .gitignore files inside git repositories.
        std::fs::create_dir(dir.path().join(".git")).expect("git dir");
        assert_eq!(index.search("main", 5), None);
        index.ensure();
        let files = loop {
            if let Some(files) = index.search("", 10) {
                break files;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        };
        assert_eq!(files, ["README.md", "src/lib.rs", "src/main.rs"]);
        assert_eq!(
            index.search("mnrs", 5).as_deref(),
            Some(&["src/main.rs".to_owned()][..])
        );
    }

    #[test]
    fn spaces_are_quoted() {
        assert_eq!(mention_for("src/a.rs"), "@src/a.rs ");
        assert_eq!(mention_for("my notes.md"), "@\"my notes.md\" ");
    }
}
