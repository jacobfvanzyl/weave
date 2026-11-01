//! The thread's status panel (WVE-160), which `/thread` opens in place of the composer: the
//! thread's MCP servers as the Host reports them (`SessionState.mcpServers`, kept current by
//! `session/changed`), with a pointer to the agent's own `/mcp` for the servers only the agent
//! knows of. Nothing here is the agent's: weave never runs or parses its `/mcp`.

use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Color;
use ratatui::style::Modifier;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::text::Span;
use weave_host_protocol::mcp::McpServerSource;
use weave_host_protocol::mcp::McpServerState;
use weave_host_protocol::mcp::McpServerStatus;
use weave_host_protocol::mcp::McpTransport;

use crate::history_cell::dim;
use crate::style;
use crate::wrapping::wrap_with_prefix;

pub const COMMAND: &str = "thread";
pub const COMMAND_DESCRIPTION: &str = "Show this thread's status: its MCP servers";

/// The agent command that lists the agent's own MCP servers, when it offers one.
pub const AGENT_MCP_COMMAND: &str = "mcp";

/// What the panel shows.
pub struct PanelView<'a> {
    /// The thread's MCP servers, or `None` from a Host that doesn't report them.
    pub mcp_servers: Option<&'a [McpServerStatus]>,
    /// The agent offers `/mcp`.
    pub agent_lists_servers: bool,
}

/// The panel. It holds nothing of its own yet: what it shows is the chat's.
#[derive(Default)]
pub struct ThreadPanel;

pub enum PanelAction {
    Close,
}

impl ThreadPanel {
    pub fn handle_key(&mut self, key: KeyEvent) -> Option<PanelAction> {
        match key.code {
            KeyCode::Esc | KeyCode::Enter | KeyCode::Char('q') => Some(PanelAction::Close),
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
        lines.push(Line::default());
        lines.push(Line::from(Span::styled("  esc back", dim())));
        lines
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

    fn text(view: &PanelView<'_>, width: u16) -> Vec<String> {
        ThreadPanel
            .lines(view, width)
            .iter()
            .map(|line| line.to_string().trim_end().to_owned())
            .collect()
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
        let view = PanelView {
            mcp_servers: Some(&servers),
            agent_lists_servers: true,
        };
        assert_eq!(
            text(&view, 40),
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
        let view = PanelView {
            mcp_servers: None,
            agent_lists_servers: false,
        };
        let lines = text(&view, 100);
        assert_eq!(
            lines[3],
            "  This weave Host doesn't report MCP servers; update it to see them."
        );
        assert_eq!(
            lines[5],
            "  The agent may have more of its own, which only it knows of."
        );
    }

    #[test]
    fn esc_closes_it() {
        let key = |code| KeyEvent::new(code, crossterm::event::KeyModifiers::NONE);
        assert!(matches!(
            ThreadPanel.handle_key(key(KeyCode::Esc)),
            Some(PanelAction::Close)
        ));
        assert!(ThreadPanel.handle_key(key(KeyCode::Char('x'))).is_none());
    }
}
