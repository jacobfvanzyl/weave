//! The thread's status panel, which `/thread` opens in place of the composer: the thread's MCP
//! servers as the Host reports them (WVE-160; `SessionState.mcpServers`, kept current by
//! `session/changed`), with a pointer to the agent's own `/mcp` for the servers only the agent
//! knows of, and its worktree's terminals (WVE-167; `terminals/watch`). weave never runs or
//! parses the agent's `/mcp`.
//!
//! The panel manages the terminals; in Rex, panes only show them. Enter shows the selected one in
//! a pane beside the TUI, or focuses its pane, `h` hides it there, `n` starts one and shows it, `r`
//! renames one and `x` ends one once confirmed. Outside Rex, the text floor (ADR 0018): Enter
//! shows a terminal's screen as text in the transcript, and `t` types a line into it.

use std::collections::BTreeSet;
use std::path::Path;

use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Color;
use ratatui::style::Modifier;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::text::Span;
use weave_acp_core::schema::SessionId;
use weave_host_protocol::mcp::McpServerSource;
use weave_host_protocol::mcp::McpServerState;
use weave_host_protocol::mcp::McpServerStatus;
use weave_host_protocol::mcp::McpTransport;
use weave_host_protocol::terminals::ProgramState;
use weave_host_protocol::terminals::Terminal;

use crate::history_cell::dim;
use crate::style;
use crate::wrapping::wrap_with_prefix;

pub const COMMAND: &str = "thread";
pub const COMMAND_DESCRIPTION: &str = "Show this thread's status: its MCP servers and terminals";

/// The agent command that lists the agent's own MCP servers, when it offers one.
pub const AGENT_MCP_COMMAND: &str = "mcp";

/// What the panel shows.
pub struct PanelView<'a> {
    /// The thread's MCP servers, or `None` from a Host that doesn't report them.
    pub mcp_servers: Option<&'a [McpServerStatus]>,
    /// The agent offers `/mcp`.
    pub agent_lists_servers: bool,
    /// The worktree's terminals, oldest first, or `None` from a Host without terminals.
    pub terminals: Option<&'a [Terminal]>,
    /// The terminals shown in Rex panes beside this TUI.
    pub shown: &'a BTreeSet<String>,
    /// The TUI runs in Rex, so terminals show in panes.
    pub in_rex: bool,
    /// The thread on screen, whose terminals come first.
    pub session: Option<&'a SessionId>,
}

impl PanelView<'_> {
    /// The terminals in the order the panel numbers them: the thread's own first, then the
    /// worktree's others, each oldest first.
    pub fn ordered(&self) -> Vec<&Terminal> {
        let Some(terminals) = self.terminals else {
            return Vec::new();
        };
        let own = |terminal: &&Terminal| {
            self.session
                .is_some_and(|session| terminal.opened_from.as_ref() == Some(session))
        };
        let (mut first, rest): (Vec<&Terminal>, Vec<&Terminal>) = terminals.iter().partition(own);
        first.extend(rest);
        first
    }
}

/// What the person asked of the panel.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PanelAction {
    Close,
    /// Show the terminal in a Rex pane, or focus its pane.
    Show(String),
    /// Close its Rex pane; the terminal keeps running.
    Hide(String),
    /// Start a terminal in the thread's directory, and show it.
    New,
    Rename {
        id: String,
        label: String,
    },
    /// End the terminal, for every device.
    End(String),
    /// Its screen as text, in the transcript: outside Rex.
    Read(String),
    /// Text as if typed: outside Rex.
    Write {
        id: String,
        text: String,
    },
}

/// What the panel is doing: browsing, or taking a line for a terminal.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
enum Mode {
    #[default]
    Browse,
    Rename {
        id: String,
        text: String,
    },
    Type {
        id: String,
        text: String,
    },
    ConfirmEnd {
        id: String,
    },
}

#[derive(Default)]
pub struct ThreadPanel {
    selected: usize,
    mode: Mode,
}

impl ThreadPanel {
    pub fn handle_key(&mut self, key: KeyEvent, view: &PanelView<'_>) -> Option<PanelAction> {
        let ordered = view.ordered();
        self.selected = self.selected.min(ordered.len().saturating_sub(1));
        let selected = ordered
            .get(self.selected)
            .map(|terminal| terminal.id.clone());
        match std::mem::take(&mut self.mode) {
            Mode::Rename { id, mut text } => {
                return match line_key(key, &mut text) {
                    Edit::Done => Some(PanelAction::Rename { id, label: text }),
                    Edit::Cancel => None,
                    Edit::Editing => {
                        self.mode = Mode::Rename { id, text };
                        None
                    }
                };
            }
            Mode::Type { id, mut text } => {
                return match line_key(key, &mut text) {
                    Edit::Done => Some(PanelAction::Write {
                        id,
                        text: format!("{text}\r"),
                    }),
                    Edit::Cancel => None,
                    Edit::Editing => {
                        self.mode = Mode::Type { id, text };
                        None
                    }
                };
            }
            Mode::ConfirmEnd { id } => {
                return matches!(key.code, KeyCode::Char('y' | 'x'))
                    .then_some(PanelAction::End(id));
            }
            Mode::Browse => {}
        }
        let open = |id: String| {
            if view.in_rex {
                PanelAction::Show(id)
            } else {
                PanelAction::Read(id)
            }
        };
        match key.code {
            KeyCode::Esc | KeyCode::Char('q') => Some(PanelAction::Close),
            KeyCode::Up | KeyCode::Char('k') => {
                self.selected = self.selected.saturating_sub(1);
                None
            }
            KeyCode::Down | KeyCode::Char('j') => {
                self.selected = (self.selected + 1).min(ordered.len().saturating_sub(1));
                None
            }
            KeyCode::Enter => Some(selected.map_or(PanelAction::Close, open)),
            KeyCode::Char(digit @ '1'..='9') => {
                let index = digit as usize - '1' as usize;
                let terminal = ordered.get(index)?;
                self.selected = index;
                Some(open(terminal.id.clone()))
            }
            KeyCode::Char('n') if view.terminals.is_some() => Some(PanelAction::New),
            KeyCode::Char('h') if view.in_rex => selected
                .filter(|id| view.shown.contains(id))
                .map(PanelAction::Hide),
            KeyCode::Char('r') => {
                let terminal = ordered.get(self.selected)?;
                self.mode = Mode::Rename {
                    id: terminal.id.clone(),
                    text: terminal.label.clone().unwrap_or_default(),
                };
                None
            }
            KeyCode::Char('t') if !view.in_rex => {
                self.mode = Mode::Type {
                    id: selected?,
                    text: String::new(),
                };
                None
            }
            KeyCode::Char('x') => {
                self.mode = Mode::ConfirmEnd { id: selected? };
                None
            }
            _ => None,
        }
    }

    pub fn lines(&self, view: &PanelView<'_>, width: u16) -> Vec<Line<'static>> {
        let width = usize::from(width);
        let mut lines = vec![
            Line::from(Span::styled(
                "  Thread",
                Style::default().add_modifier(Modifier::BOLD),
            )),
            Line::default(),
            Line::from(Span::styled("  MCP servers", dim())),
        ];
        match view.mcp_servers {
            None => lines.extend(wrap_note(
                "This weave Host doesn't report MCP servers; update it to see them.",
                width,
            )),
            Some([]) => lines.extend(wrap_note("weave gave the agent none.", width)),
            Some(servers) => {
                let name_width = servers
                    .iter()
                    .map(|server| server.name.chars().count())
                    .max()
                    .unwrap_or(0);
                for server in servers {
                    lines.extend(server_lines(server, name_width, width));
                }
            }
        }
        lines.push(Line::default());
        let more = if view.agent_lists_servers {
            "The agent may have more of its own, which only it knows of: its /mcp lists them."
        } else {
            "The agent may have more of its own, which only it knows of."
        };
        lines.extend(wrap_note(more, width));
        if view.terminals.is_some() {
            lines.push(Line::default());
            lines.extend(self.terminal_lines(view, width));
        }
        lines.push(Line::default());
        lines.push(Line::from(Span::styled(
            format!("  {}", self.hint(view)),
            dim(),
        )));
        lines
    }

    fn terminal_lines(&self, view: &PanelView<'_>, width: usize) -> Vec<Line<'static>> {
        let mut lines = vec![Line::from(Span::styled("  Terminals", dim()))];
        let ordered = view.ordered();
        if ordered.is_empty() {
            lines.extend(wrap_note("None in this worktree; n starts one.", width));
            return lines;
        }
        let selected = self.selected.min(ordered.len() - 1);
        let name_width = ordered
            .iter()
            .map(|terminal| name(terminal).chars().count())
            .max()
            .unwrap_or(0)
            .min(24);
        for (index, terminal) in ordered.iter().enumerate() {
            let marker = if index == selected { "› " } else { "  " };
            let dot = match terminal.program_status.first().map(|status| status.state) {
                Some(ProgramState::Blocked | ProgramState::Error) => {
                    Style::default().fg(style::warning())
                }
                _ if terminal
                    .command
                    .as_ref()
                    .is_some_and(|command| command.running) =>
                {
                    Style::default().fg(Color::Green)
                }
                _ => dim(),
            };
            let shown = if view.shown.contains(&terminal.id) {
                "shown"
            } else {
                ""
            };
            let line = Line::from(vec![
                Span::raw(format!("{marker}{}. ", index + 1)),
                Span::styled("• ", dot),
                Span::styled(
                    format!("{:<name_width$}", truncate(&name(terminal), name_width)),
                    Style::default().add_modifier(Modifier::BOLD),
                ),
                Span::styled(format!("  {shown:<5}"), Style::default().fg(Color::Green)),
                Span::styled(format!("  {}", detail(terminal)), dim()),
            ]);
            lines.push(if index == selected {
                line.style(style::selection())
            } else {
                line
            });
        }
        match &self.mode {
            Mode::Rename { text, .. } => lines.push(Line::from(vec![
                Span::styled("  Name: ", dim()),
                Span::raw(format!("{text}▏")),
            ])),
            Mode::Type { text, .. } => lines.push(Line::from(vec![
                Span::styled("  Type: ", dim()),
                Span::raw(format!("{text}▏")),
            ])),
            Mode::ConfirmEnd { .. } => lines.push(Line::from(Span::styled(
                "  End this terminal on every device? y ends it, any other key keeps it.",
                Style::default().fg(style::warning()),
            ))),
            Mode::Browse => {}
        }
        lines
    }

    fn hint(&self, view: &PanelView<'_>) -> &'static str {
        match self.mode {
            Mode::Rename { .. } | Mode::Type { .. } => "enter done · esc cancel",
            Mode::ConfirmEnd { .. } => "y end · esc keep",
            Mode::Browse if view.terminals.is_none() => "esc back",
            Mode::Browse if view.in_rex => {
                "enter show · h hide · n new · r rename · x end · esc back"
            }
            Mode::Browse => "enter read · t type · n new · r rename · x end · esc back",
        }
    }

    pub fn render(&self, view: &PanelView<'_>, area: Rect, buf: &mut Buffer) {
        for (line, y) in self
            .lines(view, area.width)
            .iter()
            .zip(area.y..area.bottom())
        {
            style::set_line_filled(buf, area.x, y, line, area.width);
        }
    }
}

/// How a key edits a line the panel takes.
enum Edit {
    Editing,
    Done,
    Cancel,
}

fn line_key(key: KeyEvent, text: &mut String) -> Edit {
    match key.code {
        KeyCode::Enter => Edit::Done,
        KeyCode::Esc => Edit::Cancel,
        KeyCode::Backspace => {
            text.pop();
            Edit::Editing
        }
        KeyCode::Char(c) => {
            text.push(c);
            Edit::Editing
        }
        _ => Edit::Editing,
    }
}

/// What a terminal is called: the person's name for it, its title, or where its shell is.
pub fn name(terminal: &Terminal) -> String {
    terminal
        .label
        .clone()
        .or_else(|| terminal.title.clone().filter(|title| !title.is_empty()))
        .or_else(|| terminal.pwd.as_deref().map(short_path))
        .unwrap_or_else(|| "shell".to_owned())
}

/// What it's doing: a running command, how the last one ended, or its program's status.
fn detail(terminal: &Terminal) -> String {
    let status = terminal
        .program_status
        .first()
        .and_then(|status| status.title.clone().or_else(|| status.msg.clone()));
    let command = terminal.command.as_ref().map(|command| match command {
        command if command.running => command
            .command
            .clone()
            .map_or_else(|| "running".to_owned(), |line| format!("running {line}")),
        command => match command.exit_code {
            Some(0) | None => "idle".to_owned(),
            Some(code) => format!("exited {code}"),
        },
    });
    let place = terminal.pwd.as_deref().map(short_path);
    [status, command, place]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" · ")
}

fn short_path(path: &Path) -> String {
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
    match home
        .as_deref()
        .and_then(|home| path.strip_prefix(home).ok())
    {
        Some(rest) if rest.as_os_str().is_empty() => "~".to_owned(),
        Some(rest) => format!("~/{}", rest.display()),
        None => path.display().to_string(),
    }
}

fn truncate(text: &str, width: usize) -> String {
    if text.chars().count() <= width {
        return text.to_owned();
    }
    let mut short: String = text.chars().take(width.saturating_sub(1)).collect();
    short.push('…');
    short
}

/// One server: a dot for how it is, its name, what it is and how it's reached, and why it's
/// left out, wrapped below.
fn server_lines(server: &McpServerStatus, name_width: usize, width: usize) -> Vec<Line<'static>> {
    let (dot, state) = match server.state {
        McpServerState::Connected => (Style::default().fg(Color::Green), "connected"),
        McpServerState::Declared => (dim(), "waiting for the agent to connect"),
        McpServerState::Passed => (dim(), "passed to the agent"),
        McpServerState::Skipped => (Style::default().fg(style::warning()), "skipped"),
        McpServerState::Unavailable => (Style::default().fg(style::warning()), "unavailable"),
        McpServerState::Other => (dim(), "unknown"),
    };
    let source = match server.source {
        McpServerSource::Host => Some("weave's own"),
        McpServerSource::Config => Some("from the config"),
        McpServerSource::Other => None,
    };
    let transport = server.transport.map(|transport| match transport {
        McpTransport::Acp => "over ACP",
        McpTransport::Stdio => "stdio",
        McpTransport::Http => "http",
        McpTransport::Sse => "sse",
        McpTransport::Other => "another transport",
    });
    let detail: Vec<&str> = [Some(state), source, transport]
        .into_iter()
        .flatten()
        .collect();
    let mut lines = vec![Line::from(vec![
        Span::raw("  "),
        Span::styled("• ", dot),
        Span::styled(
            format!("{:<name_width$}", server.name),
            Style::default().add_modifier(Modifier::BOLD),
        ),
        Span::styled(format!("  {}", detail.join(" · ")), dim()),
    ])];
    if let Some(reason) = &server.reason {
        let indent = Line::from(" ".repeat(4 + name_width + 2));
        lines.extend(wrap_with_prefix(
            &Line::from(Span::styled(reason.clone(), dim())),
            width,
            &indent,
            &indent,
        ));
    }
    lines
}

fn wrap_note(text: &str, width: usize) -> Vec<Line<'static>> {
    let indent = Line::from("  ");
    wrap_with_prefix(
        &Line::from(Span::styled(text.to_owned(), dim())),
        width,
        &indent,
        &indent,
    )
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;
    use weave_host_protocol::terminals::TerminalCommand;
    use weave_host_protocol::terminals::TerminalSize;

    use super::*;

    fn status(
        name: &str,
        source: McpServerSource,
        transport: Option<McpTransport>,
        state: McpServerState,
        reason: Option<&str>,
    ) -> McpServerStatus {
        McpServerStatus {
            name: name.to_owned(),
            source,
            transport,
            state,
            reason: reason.map(str::to_owned),
        }
    }

    pub(crate) fn terminal(id: &str, opened_from: Option<&str>) -> Terminal {
        Terminal {
            id: id.to_owned(),
            scope: "/repo".into(),
            label: None,
            opened_from: opened_from.map(|id| SessionId::from(id.to_owned())),
            title: None,
            pwd: Some("/repo".into()),
            process: None,
            size: TerminalSize { cols: 80, rows: 24 },
            command: None,
            program_status: Vec::new(),
            started_at: 1,
        }
    }

    fn view<'a>(
        terminals: Option<&'a [Terminal]>,
        shown: &'a BTreeSet<String>,
        in_rex: bool,
        session: Option<&'a SessionId>,
    ) -> PanelView<'a> {
        PanelView {
            mcp_servers: Some(&[]),
            agent_lists_servers: false,
            terminals,
            shown,
            in_rex,
            session,
        }
    }

    fn text(panel: &ThreadPanel, view: &PanelView<'_>, width: u16) -> Vec<String> {
        panel
            .lines(view, width)
            .iter()
            .map(|line| line.to_string().trim_end().to_owned())
            .collect()
    }

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, crossterm::event::KeyModifiers::NONE)
    }

    #[test]
    fn servers_line_up_and_reasons_wrap_under_them() {
        let servers = [
            status(
                "weave",
                McpServerSource::Host,
                Some(McpTransport::Acp),
                McpServerState::Connected,
                None,
            ),
            status(
                "docs",
                McpServerSource::Config,
                None,
                McpServerState::Skipped,
                Some("the agent does not support the sse transport"),
            ),
        ];
        let shown = BTreeSet::new();
        let view = PanelView {
            mcp_servers: Some(&servers),
            agent_lists_servers: true,
            ..view(None, &shown, false, None)
        };
        assert_eq!(
            text(&ThreadPanel::default(), &view, 40),
            [
                "  Thread",
                "",
                "  MCP servers",
                "  • weave  connected · weave's own · over ACP",
                "  • docs   skipped · from the config",
                "           the agent does not support",
                "           the sse transport",
                "",
                "  The agent may have more of its own,",
                "  which only it knows of: its /mcp lists",
                "  them.",
                "",
                "  esc back",
            ]
        );
    }

    #[test]
    fn an_older_host_says_it_reports_none() {
        let shown = BTreeSet::new();
        let view = PanelView {
            mcp_servers: None,
            ..view(None, &shown, false, None)
        };
        let lines = text(&ThreadPanel::default(), &view, 100);
        assert_eq!(
            lines[3],
            "  This weave Host doesn't report MCP servers; update it to see them."
        );
    }

    #[test]
    fn the_threads_terminals_come_first_and_keys_act_on_the_selected_one() {
        let mut tests = terminal("t-2", Some("s1"));
        tests.label = Some("tests".to_owned());
        tests.command = Some(TerminalCommand {
            running: true,
            command: Some("cargo test".to_owned()),
            exit_code: None,
        });
        let terminals = [terminal("t-1", Some("s-other")), tests];
        let shown = BTreeSet::from(["t-2".to_owned()]);
        let session = SessionId::from("s1");
        let view = view(Some(&terminals), &shown, true, Some(&session));
        let mut panel = ThreadPanel::default();
        let lines = text(&panel, &view, 90);
        let at = lines
            .iter()
            .position(|line| line == "  Terminals")
            .expect("the terminals");
        assert_eq!(
            lines[at + 1],
            "› 1. • tests  shown  running cargo test · /repo"
        );
        assert_eq!(lines[at + 2], "  2. • /repo         /repo");
        assert_eq!(
            lines.last().map(String::as_str),
            Some("  enter show · h hide · n new · r rename · x end · esc back")
        );

        assert_eq!(
            panel.handle_key(key(KeyCode::Enter), &view),
            Some(PanelAction::Show("t-2".to_owned()))
        );
        assert_eq!(
            panel.handle_key(key(KeyCode::Char('h')), &view),
            Some(PanelAction::Hide("t-2".to_owned()))
        );
        assert_eq!(panel.handle_key(key(KeyCode::Down), &view), None);
        // Not shown, so there's nothing to hide.
        assert_eq!(panel.handle_key(key(KeyCode::Char('h')), &view), None);
        assert_eq!(
            panel.handle_key(key(KeyCode::Char('2')), &view),
            Some(PanelAction::Show("t-1".to_owned()))
        );
        assert_eq!(
            panel.handle_key(key(KeyCode::Char('n')), &view),
            Some(PanelAction::New)
        );

        // Renaming takes a line, and ending asks first.
        assert_eq!(panel.handle_key(key(KeyCode::Char('r')), &view), None);
        for c in "dev".chars() {
            panel.handle_key(key(KeyCode::Char(c)), &view);
        }
        assert!(text(&panel, &view, 90).contains(&"  Name: dev▏".to_owned()));
        assert_eq!(
            panel.handle_key(key(KeyCode::Enter), &view),
            Some(PanelAction::Rename {
                id: "t-1".to_owned(),
                label: "dev".to_owned()
            })
        );
        assert_eq!(panel.handle_key(key(KeyCode::Char('x')), &view), None);
        assert_eq!(panel.handle_key(key(KeyCode::Char('n')), &view), None);
        assert_eq!(panel.handle_key(key(KeyCode::Char('x')), &view), None);
        assert_eq!(
            panel.handle_key(key(KeyCode::Char('y')), &view),
            Some(PanelAction::End("t-1".to_owned()))
        );
        assert_eq!(
            panel.handle_key(key(KeyCode::Esc), &view),
            Some(PanelAction::Close)
        );
    }

    #[test]
    fn outside_rex_terminals_are_read_and_typed_into() {
        let terminals = [terminal("t-1", None)];
        let shown = BTreeSet::new();
        let view = view(Some(&terminals), &shown, false, None);
        let mut panel = ThreadPanel::default();
        assert_eq!(
            panel.handle_key(key(KeyCode::Enter), &view),
            Some(PanelAction::Read("t-1".to_owned()))
        );
        assert_eq!(panel.handle_key(key(KeyCode::Char('h')), &view), None);
        assert_eq!(panel.handle_key(key(KeyCode::Char('t')), &view), None);
        for c in "ls".chars() {
            panel.handle_key(key(KeyCode::Char(c)), &view);
        }
        assert_eq!(
            panel.handle_key(key(KeyCode::Enter), &view),
            Some(PanelAction::Write {
                id: "t-1".to_owned(),
                text: "ls\r".to_owned()
            })
        );
        assert_eq!(
            text(&panel, &view, 90).last().map(String::as_str),
            Some("  enter read · t type · n new · r rename · x end · esc back")
        );
    }

    #[test]
    fn a_worktree_without_terminals_offers_one() {
        let shown = BTreeSet::new();
        let view = view(Some(&[]), &shown, true, None);
        let lines = text(&ThreadPanel::default(), &view, 90);
        assert!(
            lines.contains(&"  None in this worktree; n starts one.".to_owned()),
            "{lines:?}"
        );
        assert_eq!(
            ThreadPanel::default().handle_key(key(KeyCode::Enter), &view),
            Some(PanelAction::Close)
        );
    }
}
