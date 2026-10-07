//! The event loop: terminal input and agent events in, frames and protocol calls out.

use std::path::PathBuf;
use std::time::Duration;

use crossterm::event::Event;
use crossterm::event::EventStream;
use crossterm::event::KeyEventKind;
use futures::StreamExt;
use tokio::sync::mpsc;
use tokio::sync::mpsc::UnboundedReceiver;
use tokio::time::MissedTickBehavior;
use weave_acp_core::AgentConnection;
use weave_acp_core::AgentEvent;
use weave_acp_core::AgentHandle;
use weave_acp_core::schema::ContentBlock;
use weave_acp_core::schema::Error;
use weave_acp_core::schema::SessionConfigOption;
use weave_acp_core::schema::SessionId;
use weave_acp_core::schema::SessionModeState;
use weave_acp_core::schema::TextContent;

use crate::chat::AppCommand;
use crate::chat::ChatWidget;
use crate::settings::SettingChange;
use crate::tui::Tui;

/// Animation frame interval while a turn runs.
const FRAME_INTERVAL: Duration = Duration::from_millis(80);
/// Agent events applied per frame before input gets a turn.
const EVENTS_PER_FRAME: usize = 256;

/// An initialized ACP session, ready for the interactive client.
pub struct Session {
    pub connection: AgentConnection,
    pub events: UnboundedReceiver<AgentEvent>,
    pub session_id: SessionId,
    pub agent_name: String,
    pub agent_version: Option<String>,
    pub modes: Option<SessionModeState>,
    pub config_options: Vec<SessionConfigOption>,
    pub cwd: PathBuf,
}

/// Results of requests the loop made off the UI thread.
enum AppEvent {
    SettingChanged(
        SettingChange,
        Result<Option<Vec<SessionConfigOption>>, Error>,
    ),
}

/// Run the interactive client until the user quits, then close the connection.
pub async fn run(session: Session) -> anyhow::Result<()> {
    let Session {
        connection,
        mut events,
        session_id,
        agent_name,
        agent_version,
        modes,
        config_options,
        cwd,
    } = session;
    let mut tui = Tui::init()?;
    let mut chat = ChatWidget::new(agent_name, cwd, modes, config_options, tui.size()?.width);
    chat.push_header(agent_version.as_deref());
    let result = run_loop(&mut tui, &mut chat, &connection, &mut events, &session_id).await;
    tui.exit();
    connection.shutdown().await;
    result
}

async fn run_loop(
    tui: &mut Tui,
    chat: &mut ChatWidget,
    connection: &AgentConnection,
    events: &mut UnboundedReceiver<AgentEvent>,
    session_id: &SessionId,
) -> anyhow::Result<()> {
    let mut input = EventStream::new();
    let (app_tx, mut app_events) = mpsc::unbounded_channel();
    let mut frames = tokio::time::interval(FRAME_INTERVAL);
    frames.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        draw(tui, chat)?;
        let commands = tokio::select! {
            event = input.next() => match event {
                Some(event) => handle_terminal_event(chat, event?),
                None => vec![AppCommand::Quit],
            },
            Some(event) = events.recv() => {
                let mut commands = chat.handle_agent_event(event);
                // Apply a burst of streamed updates together so each frame shows several.
                for _ in 0..EVENTS_PER_FRAME {
                    match events.try_recv() {
                        Ok(event) => commands.extend(chat.handle_agent_event(event)),
                        Err(_) => break,
                    }
                }
                commands
            }
            Some(event) = app_events.recv() => {
                match event {
                    AppEvent::SettingChanged(change, result) => chat.setting_changed(change, result),
                }
                Vec::new()
            }
            _ = frames.tick(), if chat.is_animating() => Vec::new(),
        };
        for command in commands {
            match command {
                AppCommand::Prompt(text) => {
                    let prompt = vec![ContentBlock::Text(TextContent::new(text))];
                    if let Err(error) = connection.prompt(session_id.clone(), prompt) {
                        chat.prompt_failed(&error);
                    }
                }
                AppCommand::Cancel => {
                    if let Err(error) = connection.cancel(session_id.clone()) {
                        tracing::warn!(%error, "failed to send session/cancel");
                    }
                }
                AppCommand::ChangeSetting(change) => {
                    spawn_setting_change(
                        connection.handle(),
                        session_id.clone(),
                        change,
                        app_tx.clone(),
                    );
                }
                AppCommand::Quit => return Ok(()),
            }
        }
    }
}

fn spawn_setting_change(
    handle: AgentHandle,
    session_id: SessionId,
    change: SettingChange,
    results: mpsc::UnboundedSender<AppEvent>,
) {
    tokio::spawn(async move {
        let result = match &change {
            SettingChange::ConfigOption(config_id, value) => handle
                .set_config_option(session_id, config_id.clone(), value.clone())
                .await
                .map(Some),
            SettingChange::Mode(mode_id) => handle
                .set_mode(session_id, mode_id.clone())
                .await
                .map(|()| None),
        };
        let _ = results.send(AppEvent::SettingChanged(change, result));
    });
}

fn handle_terminal_event(chat: &mut ChatWidget, event: Event) -> Vec<AppCommand> {
    match event {
        Event::Key(key) if matches!(key.kind, KeyEventKind::Press | KeyEventKind::Repeat) => {
            chat.handle_key(key)
        }
        Event::Paste(text) => {
            chat.handle_paste(&text);
            Vec::new()
        }
        Event::Resize(width, _) => {
            chat.set_width(width);
            Vec::new()
        }
        _ => Vec::new(),
    }
}

fn draw(tui: &mut Tui, chat: &mut ChatWidget) -> std::io::Result<()> {
    let width = tui.size()?.width;
    let history = chat.take_history();
    let height = chat.desired_height(width);
    tui.draw(history, height, |frame| {
        let area = frame.area();
        if let Some(cursor) = chat.render(area, frame.buffer_mut()) {
            frame.set_cursor_position(cursor);
        }
    })
}
