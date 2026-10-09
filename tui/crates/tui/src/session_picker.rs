//! Choosing a previous session to reopen, after Codex's resume picker.

use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Color;
use ratatui::style::Modifier;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::text::Span;
use weave_acp_core::daemon_protocol;
use weave_acp_core::daemon_protocol::Activity;
use weave_acp_core::daemon_protocol::ListedSession;
use weave_acp_core::schema::SessionId;
use weave_acp_core::schema::SessionInfo;

use crate::history_cell::dim;
use crate::style;

const VISIBLE_ROWS: usize = 8;

pub enum PickerAction {
    Open(SessionInfo),
    New,
    Close,
    Delete(SessionId),
    /// Fetch the next page, or (with no cursor) reload, for all directories or just this one.
    List {
        all_directories: bool,
        cursor: Option<String>,
    },
}

pub struct SessionPicker {
    sessions: Vec<SessionInfo>,
    next_cursor: Option<String>,
    selected: usize,
    loading: bool,
    error: Option<String>,
    all_directories: bool,
    confirm_delete: bool,
    can_delete: bool,
    /// Opened at startup with no session yet: leaving means starting a new one.
    pub startup: bool,
}

impl SessionPicker {
    pub fn new(can_delete: bool, startup: bool) -> Self {
        Self {
            sessions: Vec::new(),
            next_cursor: None,
            selected: 0,
            loading: true,
            error: None,
            all_directories: false,
            confirm_delete: false,
            can_delete,
            startup,
        }
    }

    /// A page arrived; `append` continues the list instead of replacing it.
    pub fn listed(
        &mut self,
        sessions: Vec<SessionInfo>,
        next_cursor: Option<String>,
        append: bool,
    ) {
        if !append {
            self.sessions.clear();
            self.selected = 0;
        }
        self.sessions.extend(sessions);
        self.next_cursor = next_cursor;
        self.loading = false;
        self.error = None;
    }

    pub fn failed(&mut self, error: String) {
        self.loading = false;
        self.error = Some(error);
    }

    pub fn deleted(&mut self, session_id: &SessionId) {
        self.sessions
            .retain(|session| session.session_id != *session_id);
        self.selected = self.selected.min(self.sessions.len().saturating_sub(1));
    }

    pub fn handle_key(&mut self, key: KeyEvent) -> Option<PickerAction> {
        let confirming = std::mem::take(&mut self.confirm_delete);
        match key.code {
            KeyCode::Esc => Some(if self.startup {
                PickerAction::New
            } else {
                PickerAction::Close
            }),
            KeyCode::Char('n') => Some(PickerAction::New),
            KeyCode::Up | KeyCode::Char('k') => {
                self.selected = self.selected.saturating_sub(1);
                None
            }
            KeyCode::Down | KeyCode::Char('j') => {
                if self.selected + 1 < self.sessions.len() {
                    self.selected += 1;
                }
                // Reaching the end of what's loaded fetches more.
                self.next_page()
            }
            KeyCode::Enter => self
                .sessions
                .get(self.selected)
                .cloned()
                .map(PickerAction::Open),
            KeyCode::Char('a') => {
                self.all_directories = !self.all_directories;
                self.loading = true;
                Some(PickerAction::List {
                    all_directories: self.all_directories,
                    cursor: None,
                })
            }
            KeyCode::Char('d') if self.can_delete => {
                let session = self.sessions.get(self.selected)?;
                if confirming {
                    Some(PickerAction::Delete(session.session_id.clone()))
                } else {
                    self.confirm_delete = true;
                    None
                }
            }
            _ => None,
        }
    }

    fn next_page(&mut self) -> Option<PickerAction> {
        if self.loading || self.selected + 1 < self.sessions.len() {
            return None;
        }
        let cursor = self.next_cursor.clone()?;
        self.loading = true;
        Some(PickerAction::List {
            all_directories: self.all_directories,
            cursor: Some(cursor),
        })
    }

    fn lines(&self, now: chrono::DateTime<chrono::Utc>) -> Vec<Line<'static>> {
        let scope = if self.all_directories {
            "all directories"
        } else {
            "this directory"
        };
        let mut lines = vec![Line::from(vec![
            Span::styled(
                "  Resume a session",
                Style::default().add_modifier(Modifier::BOLD),
            ),
            Span::styled(format!("  ({scope})"), dim()),
        ])];
        if let Some(error) = &self.error {
            lines.push(Line::from(Span::styled(
                format!("  {error}"),
                Style::default().fg(Color::Red),
            )));
        } else if self.sessions.is_empty() {
            let text = if self.loading {
                "  Loading…"
            } else {
                "  No sessions yet."
            };
            lines.push(Line::from(Span::styled(text, dim())));
        }
        let first = self.selected.saturating_sub(VISIBLE_ROWS - 1);
        for (index, session) in self
            .sessions
            .iter()
            .enumerate()
            .skip(first)
            .take(VISIBLE_ROWS)
        {
            let selected = index == self.selected;
            let style = Style::default();
            let title = session
                .title
                .clone()
                .unwrap_or_else(|| format!("Untitled ({})", session.session_id));
            let mut spans = vec![Span::styled(
                format!("{}{title}", if selected { "› " } else { "  " }),
                style,
            )];
            spans.extend(badge(session));
            if let Some(updated) = &session.updated_at {
                spans.push(Span::styled(
                    format!("  · {}", relative_time(updated, now)),
                    dim(),
                ));
            }
            if self.all_directories {
                spans.push(Span::styled(
                    format!("  · {}", session.cwd.display()),
                    dim(),
                ));
            }
            let line = Line::from(spans);
            lines.push(if selected {
                line.style(style::selection())
            } else {
                line
            });
        }
        if self.loading && !self.sessions.is_empty() {
            lines.push(Line::from(Span::styled("  Loading more…", dim())));
        }
        let mut hints = vec!["⏎ open", "n new", "a all dirs"];
        if self.can_delete {
            hints.push(if self.confirm_delete {
                "d again to delete"
            } else {
                "d delete"
            });
        }
        hints.push(if self.startup {
            "esc new session"
        } else {
            "esc close"
        });
        let style = if self.confirm_delete {
            Style::default().fg(Color::Red)
        } else {
            dim()
        };
        lines.push(Line::from(Span::styled(
            format!("  {}", hints.join(" · ")),
            style,
        )));
        lines
    }

    pub fn desired_height(&self) -> u16 {
        u16::try_from(self.lines(chrono::Utc::now()).len()).unwrap_or(u16::MAX)
    }

    pub fn render(&self, area: Rect, buf: &mut Buffer) {
        for (line, y) in self
            .lines(chrono::Utc::now())
            .iter()
            .zip(area.y..area.bottom())
        {
            style::set_line_filled(buf, area.x, y, line, area.width);
        }
    }
}

/// What the weave daemon says a session is doing: open in it (running, waiting on you, or
/// idle, with who's attached), and whether it's headless.
fn badge(session: &SessionInfo) -> Vec<Span<'static>> {
    let Some(listed) = daemon_protocol::read_meta::<ListedSession>(session.meta.as_ref()) else {
        return Vec::new();
    };
    let mut spans = Vec::new();
    if let Some(activity) = listed.activity {
        let (label, color) = match activity {
            Activity::Running => ("● running", Color::Green),
            Activity::Waiting => ("● waiting on you", Color::Magenta),
            Activity::Idle => ("● open", Color::Cyan),
        };
        spans.push(Span::styled(
            format!("  {label}"),
            Style::default().fg(color),
        ));
        if listed.clients > 0 {
            spans.push(Span::styled(
                format!(" · {} attached", listed.clients),
                dim(),
            ));
        }
    }
    if listed.headless {
        let gap = if spans.is_empty() { "  " } else { " · " };
        spans.push(Span::styled(format!("{gap}headless"), dim()));
    }
    spans
}

/// "just now", "5m ago", "3h ago", "2d ago", or the date.
fn relative_time(timestamp: &str, now: chrono::DateTime<chrono::Utc>) -> String {
    let Ok(then) = chrono::DateTime::parse_from_rfc3339(timestamp) else {
        return timestamp.to_owned();
    };
    let elapsed = now.signed_duration_since(then);
    match elapsed.num_seconds() {
        seconds if seconds < 60 => "just now".to_owned(),
        seconds if seconds < 3600 => format!("{}m ago", seconds / 60),
        seconds if seconds < 86_400 => format!("{}h ago", seconds / 3600),
        seconds if seconds < 7 * 86_400 => format!("{}d ago", seconds / 86_400),
        _ => then.format("%Y-%m-%d").to_string(),
    }
}

#[cfg(test)]
mod tests {
    use crossterm::event::KeyModifiers;
    use pretty_assertions::assert_eq;

    use super::*;

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    fn session(id: &str, title: &str, updated: &str) -> SessionInfo {
        SessionInfo::new(id.to_owned(), "/repo")
            .title(title.to_owned())
            .updated_at(updated.to_owned())
    }

    fn now() -> chrono::DateTime<chrono::Utc> {
        chrono::DateTime::parse_from_rfc3339("2026-10-07T12:00:00Z")
            .expect("time")
            .into()
    }

    #[test]
    fn lists_sessions_with_relative_times() {
        let mut picker = SessionPicker::new(true, false);
        picker.listed(
            vec![
                session("s1", "Fix the build", "2026-10-07T11:55:00Z"),
                session("s2", "Plan release", "2026-10-05T12:00:00Z"),
            ],
            None,
            false,
        );
        let text: Vec<String> = picker
            .lines(now())
            .iter()
            .map(ToString::to_string)
            .collect();
        assert_eq!(
            text,
            [
                "  Resume a session  (this directory)",
                "› Fix the build  · 5m ago",
                "  Plan release  · 2d ago",
                "  ⏎ open · n new · a all dirs · d delete · esc close",
            ]
        );
    }

    #[test]
    fn sessions_open_in_the_daemon_wear_a_badge() {
        let marked = |id: &str, title: &str, listed: ListedSession| {
            session(id, title, "2026-10-07T11:55:00Z").meta(daemon_protocol::meta(&listed))
        };
        let mut picker = SessionPicker::new(false, false);
        picker.listed(
            vec![
                marked(
                    "s1",
                    "Fix the build",
                    ListedSession {
                        activity: Some(Activity::Running),
                        clients: 1,
                        headless: false,
                    },
                ),
                marked(
                    "s2",
                    "Nightly triage",
                    ListedSession {
                        activity: Some(Activity::Waiting),
                        clients: 0,
                        headless: true,
                    },
                ),
                marked(
                    "s3",
                    "Old run",
                    ListedSession {
                        headless: true,
                        ..ListedSession::default()
                    },
                ),
                session("s4", "Plain", "2026-10-07T11:55:00Z"),
            ],
            None,
            false,
        );
        let text: Vec<String> = picker
            .lines(now())
            .iter()
            .map(ToString::to_string)
            .collect();
        assert_eq!(
            &text[1..5],
            [
                "› Fix the build  ● running · 1 attached  · 5m ago",
                "  Nightly triage  ● waiting on you · headless  · 5m ago",
                "  Old run  headless  · 5m ago",
                "  Plain  · 5m ago",
            ]
        );
        // The running badge is green.
        let running = &picker.lines(now())[1].spans[1];
        assert_eq!(running.style.fg, Some(Color::Green));
    }

    #[test]
    fn scrolling_past_the_end_fetches_the_next_page() {
        let mut picker = SessionPicker::new(false, false);
        picker.listed(
            vec![session("s1", "One", "2026-10-07T11:00:00Z")],
            Some("cursor-2".into()),
            false,
        );
        assert!(matches!(
            picker.handle_key(key(KeyCode::Down)),
            Some(PickerAction::List { cursor: Some(cursor), .. }) if cursor == "cursor-2"
        ));
        // While that page loads, more scrolling asks for nothing.
        assert!(picker.handle_key(key(KeyCode::Down)).is_none());
    }

    #[test]
    fn deleting_needs_confirmation() {
        let mut picker = SessionPicker::new(true, false);
        picker.listed(
            vec![session("s1", "One", "2026-10-07T11:00:00Z")],
            None,
            false,
        );
        assert!(picker.handle_key(key(KeyCode::Char('d'))).is_none());
        assert!(matches!(
            picker.handle_key(key(KeyCode::Char('d'))),
            Some(PickerAction::Delete(id)) if id.to_string() == "s1"
        ));
        // Any other key disarms it.
        picker.handle_key(key(KeyCode::Char('d')));
        picker.handle_key(key(KeyCode::Up));
        assert!(picker.handle_key(key(KeyCode::Char('d'))).is_none());
    }

    #[test]
    fn leaving_the_startup_picker_starts_a_new_session() {
        let mut picker = SessionPicker::new(false, true);
        assert!(matches!(
            picker.handle_key(key(KeyCode::Esc)),
            Some(PickerAction::New)
        ));
    }
}
